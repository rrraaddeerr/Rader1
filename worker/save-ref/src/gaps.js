/**
 * Sourcing gaps — what he keeps saving that he can't rent out.
 *
 * rentco.js answers "do I own anything like this ref?". This file asks the
 * inverse, which is the one with money in it: which refs have NOTHING near
 * them in the 590-item inventory, and — the part worth acting on — which of
 * those pile up into the same shape. One orphan ref is a whim. Fourteen refs
 * that all look like each other and match nothing owned is a purchase order.
 *
 * So the unit of output is a CLUSTER, not a row. "You've saved 14 things like
 * this and own none of it" is a sourcing decision; 200 unranked misses is
 * homework.
 *
 * Nothing here writes to a ref, adds a ref, or stages a taste judgment. It is
 * read-only over KV and both vector indexes; the only write it can make is the
 * budget ledger, and only when it actually spends. A gap report is an
 * observation about the warehouse, not a claim about what a ref means.
 *
 * Tier ladder, bottom-up as always:
 *   0  the walk, the clustering, the ranking and the labels — all plain code
 *   2  embeddings, and only for refs whose vector isn't already in VECTORS
 *   3  the prose summary, only behind an explicit `deep` flag, only after
 *      charge() says yes
 *
 * Degrades: no INV_VECTORS is a clear error object, never a throw. A ref whose
 * inventory query is REJECTED is dropped from the report and recorded in
 * `errors` — it is never counted as a gap, because "the query failed" and "we
 * own nothing like it" are opposite facts that look identical once you let an
 * empty array stand for both.
 */

import { embed, embedTextFor, METADATA_TOPK_MAX } from "./embed.js";
import { generate, parseJsonish, SYSTEM_PROMPT } from "./ask.js";
import { charge } from "./budget.js";

/**
 * Cosine below which we call it a gap.
 *
 * This is a knob, not a truth: bge similarities bunch up, and where "loosely
 * related" ends and "own nothing like it" begins is his call, not the code's.
 * Every report echoes the threshold it used so he can move it and re-read.
 */
export const DEFAULT_THRESHOLD = 0.55;

/** How similar two gap refs must be to land in the same cluster. */
export const DEFAULT_SIM = 0.62;

/**
 * One inventory query per ref, and a Worker only gets so many subrequests per
 * request — so a pass is bounded and resumable by cursor, like the reindex and
 * proposal passes.
 */
export const DEFAULT_SAMPLE = 60;
export const MAX_SAMPLE = 150;

/** We only need the near-miss, not a page of them. Hard-capped either way. */
export const DEFAULT_TOPK = 3;

/** Enough refs to recognise the cluster on sight, few enough to read. */
const REPRESENTATIVES = 5;

/** Vectorize takes a list of ids per getByIds call; keep batches modest. */
const VECTOR_FETCH_CHUNK = 100;

/** Workers AI takes an array of texts, but a giant one is a giant retry. */
const EMBED_CHUNK = 25;

/** Inventory queries run a few at a time — sequential is slow, all-at-once trips limits. */
const QUERY_CONCURRENCY = 6;

/** Deep summary covers the top of the list only; the tail isn't worth $0.02. */
const DEEP_CLUSTER_MAX = 8;

/** Words that describe every ref describe none of them. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "are", "was", "were",
  "has", "have", "had", "its", "his", "her", "their", "you", "your", "our",
  "not", "but", "all", "any", "can", "how", "what", "when", "where", "who",
  "why", "new", "one", "two", "get", "got", "out", "into", "over", "under",
  "about", "more", "most", "some", "than", "then", "them", "they", "she",
  "com", "www", "http", "https", "html", "jpg", "jpeg", "png", "instagram",
  "photo", "photos", "image", "images", "untitled", "note", "notes", "link",
  "video", "post", "posts", "reel", "page", "site", "via", "see", "look",
]);

// ------------------------------------------------------------------- pure

/**
 * Cosine similarity. bge vectors come back normalized, so in practice this is
 * a dot product — but normalizing anyway costs nothing and keeps the cluster
 * threshold meaningful if the embedding model is ever swapped.
 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

/**
 * The words a set of refs has in common, strongest first.
 *
 * Deliberately NOT ref.body: a scraped page shares "cookie policy" with every
 * other scraped page, and a label built from that names nothing. Title, tags,
 * caption and his own note are the fields that are *about* the ref.
 *
 * This is a description, not a judgment — it reports which words repeat, it
 * doesn't decide what the cluster means. That distinction is why this can ship
 * without going through the staging queue.
 */
export function labelTerms(refs = [], { max = 3 } = {}) {
  const counts = new Map();
  for (const ref of refs) {
    const text = [
      ref?.title,
      ref?.caption,
      ref?.note,
      ref?.desc,
      Array.isArray(ref?.tags) ? ref.tags.join(" ") : "",
      ref?.category,
    ]
      .filter((s) => typeof s === "string" && s.trim())
      .join(" ")
      .toLowerCase();
    // Count a word once per ref: a title that repeats "chrome" four times
    // shouldn't outvote four separate refs that each say it once.
    const seen = new Set();
    for (const w of text.match(/[a-z][a-z0-9]{2,}/g) || []) {
      if (STOPWORDS.has(w) || seen.has(w)) continue;
      seen.add(w);
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n > 1 || refs.length === 1) // a word only one ref uses isn't shared
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([w]) => w);
}

/** Trim a ref down to what a gap report needs to show. */
function refCard(ref, score) {
  return {
    id: ref.id,
    title: ref.title || ref.host || ref.url || "Untitled",
    url: ref.url || "",
    image: ref.image || "",
    category: ref.category || "link",
    // How close the best owned thing was. The whole point of the row.
    score: Number(score.toFixed(4)),
  };
}

/**
 * Group gap refs by shared vector neighbourhood, then rank.
 *
 * HONEST ABOUT THE METHOD: this is single-pass greedy leader clustering. The
 * loneliest unassigned ref becomes a seed, every unassigned ref within `sim`
 * of it joins, repeat. No k to pick, no iteration, no second model call, and
 * it's deterministic for a given input order — which matters, because he'll
 * re-run this and expect the same answer.
 *
 * What it costs: the result depends on seed order, and a chain of refs that
 * drift gradually from one look into another gets cut wherever the seed
 * happened to land rather than merged or split on a real boundary. Proper
 * agglomerative or HDBSCAN clustering would find those boundaries, at O(n²)
 * distance bookkeeping plus a linkage pass and a parameter he'd have to tune.
 * Seeding from the loneliest ref buys back most of the difference here,
 * because the refs furthest from inventory are exactly the ones a sourcing
 * cluster should be built around.
 *
 * Clustering on vectors rather than tags is not a preference either: only 3 of
 * the Notion tags describe an object at all, so tag-clustering would put a
 * chrome harness and a velvet gown in the same "Fashion" bucket and tell him
 * nothing about what to buy.
 *
 * @param {Array<{ref:object, vector:number[], score:number, nearest:object|null}>} gaps
 * @returns {Array<object>} clusters, ranked
 */
export function clusterGaps(gaps = [], { sim = DEFAULT_SIM, minSize = 1 } = {}) {
  // Loneliest first: the ref with the weakest owned match seeds its cluster,
  // so the representative is the purest example of the thing he can't rent.
  const pool = [...gaps].filter((g) => g?.ref && Array.isArray(g.vector)).sort((a, b) => a.score - b.score);
  const taken = new Array(pool.length).fill(false);
  const clusters = [];

  for (let i = 0; i < pool.length; i++) {
    if (taken[i]) continue;
    taken[i] = true;
    const members = [pool[i]];
    for (let j = i + 1; j < pool.length; j++) {
      if (taken[j]) continue;
      if (cosine(pool[i].vector, pool[j].vector) >= sim) {
        taken[j] = true;
        members.push(pool[j]);
      }
    }
    clusters.push(buildCluster(pool[i], members));
  }

  return clusters.filter((c) => c.size >= minSize).sort((a, b) => b.rank - a.rank || b.size - a.size);
}

/** Shape one cluster: what it is, how big, how far from anything owned. */
function buildCluster(seed, members) {
  const scores = members.map((m) => m.score);
  const meanScore = scores.reduce((s, x) => s + x, 0) / members.length;
  const distance = Math.max(0, 1 - meanScore);

  // The closest thing he owns to ANY member — the near miss. If this is a real
  // near miss he may not need to buy at all; if it's junk, he does.
  const nearest = members.reduce(
    (best, m) => (m.nearest && (!best || m.nearest.score > best.score) ? m.nearest : best),
    null
  );

  const refs = members.map((m) => m.ref);
  const terms = labelTerms(refs);
  const size = members.length;

  return {
    id: seed.ref.id,
    size,
    terms,
    label: composeLabel({ terms, size, nearest, seed }),
    // Size times distance-from-anything-owned. Fourteen refs at arm's length
    // beat one ref in deep space: the first is a pattern, the second is taste.
    rank: Number((size * distance).toFixed(4)),
    distance: Number(distance.toFixed(4)),
    meanScore: Number(meanScore.toFixed(4)),
    bestScore: Number(Math.max(...scores).toFixed(4)),
    worstScore: Number(Math.min(...scores).toFixed(4)),
    nearest,
    refs: members.slice(0, REPRESENTATIVES).map((m) => refCard(m.ref, m.score)),
    refIds: members.map((m) => m.ref.id),
  };
}

/** The one-liner he reads in the report. Deterministic, Tier 0, auditable. */
function composeLabel({ terms, size, nearest, seed }) {
  const what = terms.length
    ? terms.join(", ")
    : String(seed.ref.title || seed.ref.host || "unlabelled").slice(0, 60).toLowerCase();
  const owned = nearest
    ? `closest owned "${nearest.title || nearest.id}" at ${nearest.score.toFixed(2)}`
    : "nothing owned comes close";
  return `${what} — ${size} saved, ${owned}`;
}

// ------------------------------------------------------------------ the pass

/**
 * Walk a bounded sample of refs and report what he's drawn to but can't rent.
 *
 * @param {object} env
 * @param {object} [opts]
 * @param {number} [opts.sample]    refs to read this pass (capped at MAX_SAMPLE)
 * @param {number} [opts.threshold] cosine below which a ref counts as a gap
 * @param {number} [opts.topK]      inventory matches to pull per ref (capped at 20)
 * @param {number} [opts.sim]       cluster tightness
 * @param {number} [opts.minSize]   drop clusters smaller than this
 * @param {string} [opts.cursor]    resume a previous pass
 * @param {boolean} [opts.deep]     also write prose summaries (tier 3, charged)
 * @returns {Promise<object>} `{ok, clusters, ...counts, errors}` — never throws
 */
export async function findGaps(env, {
  sample = DEFAULT_SAMPLE,
  threshold = DEFAULT_THRESHOLD,
  topK = DEFAULT_TOPK,
  sim = DEFAULT_SIM,
  minSize = 1,
  cursor,
  deep = false,
  deepMax = DEEP_CLUSTER_MAX,
} = {}) {
  if (!env?.REFS_KV) return { ok: false, error: "REFS_KV binding missing — nothing to read." };
  if (!env?.INV_VECTORS) {
    return {
      ok: false,
      error:
        "INV_VECTORS binding missing — there's no inventory index to compare against. " +
        "Create it and run `node scripts/index-inventory.mjs`, see worker/save-ref/README.md.",
    };
  }
  if (!env?.AI) {
    return {
      ok: false,
      error: "AI binding missing — refs can't be embedded, so nothing can be compared to inventory.",
    };
  }

  const errors = [];
  const limit = clampInt(sample, DEFAULT_SAMPLE, 1, MAX_SAMPLE);
  // The ceiling is not negotiable: Vectorize REJECTS topK above 20 when full
  // metadata is requested, and a rejected query returns nothing at all — which
  // would read as "he owns nothing like any of this" and send him shopping.
  const want = clampInt(topK, DEFAULT_TOPK, 1, METADATA_TOPK_MAX);
  const cut = Number.isFinite(Number(threshold)) ? Number(threshold) : DEFAULT_THRESHOLD;

  // --- read the refs -------------------------------------------------------
  let page;
  try {
    page = await env.REFS_KV.list({ prefix: "ref:", limit, cursor });
  } catch (err) {
    return {
      ok: false,
      error: `couldn't list refs: ${short(err)}`,
      cursor: cursor ?? null,
      errors,
    };
  }

  const refs = [];
  let unreadable = 0;
  for (const k of page.keys) {
    let ref = null;
    try {
      ref = await env.REFS_KV.get(k.name, "json");
    } catch (err) {
      errors.push({ stage: "kv", key: k.name, error: short(err) });
      continue;
    }
    // A listed key that reads back empty is a deleted or half-written ref —
    // not an error, but the difference between "60 scanned, no gaps" and
    // "60 scanned, 60 unreadable" is the whole story, so it gets counted.
    if (!ref?.id) { unreadable++; continue; }
    refs.push(ref);
  }

  // --- vectors: reuse what the index already has ---------------------------
  const { vectors, reused, embedded, blank, budget } = await vectorsFor(env, refs, errors);

  // --- one inventory query per ref -----------------------------------------
  const usable = refs.filter((r) => vectors.has(r.id));
  const gaps = [];
  let compared = 0;
  let covered = 0;

  for (let i = 0; i < usable.length; i += QUERY_CONCURRENCY) {
    const slice = usable.slice(i, i + QUERY_CONCURRENCY);
    const results = await Promise.all(
      slice.map((ref) => nearestOwned(env, vectors.get(ref.id), want, ref.id))
    );
    results.forEach((res, n) => {
      const ref = slice[n];
      if (res.error) {
        // Never let a failed query masquerade as an empty warehouse.
        errors.push({ stage: "inventory", refId: ref.id, error: res.error });
        return;
      }
      compared++;
      const best = res.items[0] || null;
      const score = best ? best.score : 0;
      if (score >= cut) { covered++; return; }
      gaps.push({ ref, vector: vectors.get(ref.id), score, nearest: best });
    });
  }

  const clusters = clusterGaps(gaps, { sim, minSize });

  const out = {
    ok: true,
    scanned: refs.length,
    unreadable,
    // Refs we actually got an inventory answer for. If this is well below
    // `scanned`, read `errors` before believing the clusters.
    compared,
    covered,
    gaps: gaps.length,
    reused,
    embedded,
    // Refs with nothing to embed — a bare image with no title, caption or note.
    // They aren't gaps and they aren't errors; they're refs that haven't been
    // enriched yet, and lumping them in with `covered` would flatter the report.
    blank,
    clusters,
    clusterCount: clusters.length,
    threshold: cut,
    sim,
    topK: want,
    cursor: page.list_complete ? null : page.cursor,
    done: Boolean(page.list_complete),
    ...(budget ? { budget } : {}),
    errors,
  };

  if (!deep) return out;

  const summary = await summariseGaps(env, clusters, { deep: true, max: deepMax });
  return {
    ...out,
    clusters: summary.clusters,
    summarised: summary.summarised,
    model: summary.model || "none",
    ...(summary.reason ? { deepSkipped: summary.reason } : {}),
    errors: [...errors, ...summary.errors],
  };
}

/**
 * Vectors for a batch of refs: pull what VECTORS already holds, embed the rest.
 *
 * Reuse is the whole optimisation — 1,575 refs are already embedded, and
 * re-embedding them to ask a question about inventory would be paying twice
 * for the same fingerprint.
 *
 * @returns {Promise<{vectors:Map<string,number[]>, reused:number, embedded:number, blank:number, budget:string|null}>}
 */
async function vectorsFor(env, refs, errors) {
  const vectors = new Map();

  if (env.VECTORS) {
    const ids = refs.map((r) => r.id);
    for (let i = 0; i < ids.length; i += VECTOR_FETCH_CHUNK) {
      const chunk = ids.slice(i, i + VECTOR_FETCH_CHUNK);
      try {
        const res = await env.VECTORS.getByIds(chunk);
        const list = Array.isArray(res) ? res : res?.vectors || [];
        for (const v of list) {
          if (v?.id && Array.isArray(v.values) && v.values.length) vectors.set(v.id, v.values);
        }
      } catch (err) {
        // Not fatal — we can still embed these — but a silent miss here would
        // look like a huge surprise bill instead of a broken index.
        errors.push({ stage: "vectors", error: short(err) });
      }
    }
  } else {
    errors.push({ stage: "vectors", error: "VECTORS binding missing — every ref had to be re-embedded" });
  }

  const reused = vectors.size;
  const candidates = refs.filter((r) => !vectors.has(r.id)).map((ref) => ({ ref, text: embedTextFor(ref) }));
  const misses = candidates.filter((m) => m.text);
  const blank = candidates.length - misses.length;

  if (!misses.length) return { vectors, reused, embedded: 0, blank, budget: null };

  // Tier 2 spend, so it goes past the governor first. A refusal is not fatal:
  // the refs already in the index still get compared, and the report says how
  // many it had to leave out rather than quietly reporting a smaller archive.
  const booked = await charge(env, { tier: 2, units: misses.length, label: "gaps-embed" });
  if (!booked.ok) {
    errors.push({ stage: "budget", error: booked.reason });
    return {
      vectors,
      reused,
      embedded: 0,
      blank,
      budget: `${booked.reason} — ${misses.length} unindexed refs were skipped`,
    };
  }

  let embedded = 0;
  for (let i = 0; i < misses.length; i += EMBED_CHUNK) {
    const chunk = misses.slice(i, i + EMBED_CHUNK);
    const vecs = await embed(env, chunk.map((m) => m.text));
    if (!vecs || vecs.length !== chunk.length) {
      // embed() swallows its own failure and returns null, so say it out loud
      // here — otherwise this reads as "those refs matched inventory fine".
      errors.push({ stage: "embed", error: `no embeddings for ${chunk.length} refs (AI refused or returned a short batch)` });
      continue;
    }
    chunk.forEach((m, n) => {
      vectors.set(m.ref.id, vecs[n]);
      embedded++;
    });
  }

  return { vectors, reused, embedded, blank, budget: null };
}

/**
 * Nearest owned items to one vector.
 *
 * Returns `{items, error}`: an index with nothing near this ref and a query
 * Vectorize rejected are the same empty array otherwise, and treating the
 * second as the first is how a report tells him to buy something he owns.
 */
async function nearestOwned(env, vector, topK, refId) {
  try {
    const res = await env.INV_VECTORS.query(vector, { topK, returnMetadata: "all" });
    const matches = res?.matches || [];
    return {
      items: matches.map((m) => ({
        id: m.id,
        score: typeof m.score === "number" ? m.score : 0,
        ...(m.metadata || {}),
      })),
      error: null,
    };
  } catch (err) {
    return { items: [], error: `inventory query rejected for ${refId}: ${short(err)}` };
  }
}

// -------------------------------------------------------------- deep tier

const GAPS_INSTRUCTION = [
  "Each CLUSTER above is a group of references he has saved that his rental inventory cannot cover.",
  "`nearest owned` is the closest thing he actually owns, with its similarity score — low means it isn't a substitute.",
  "For each cluster, write one line of sourcing direction. Return JSON only, no prose around it:",
  "{",
  '  "clusters": [',
  '    { "i": 0, "label": "5-8 words naming the look", "source": "one line: what to buy, build or borrow to cover it" }',
  "  ]",
  "}",
  "Be concrete about objects, materials, era and finish — something he could put into a search or a fabricator brief.",
  "If a cluster is too vague to source against, say that in `source` rather than inventing a shopping list.",
].join("\n");

/**
 * Put words to the top clusters with the frontier tier.
 *
 * Gated twice on purpose: the caller has to ask for `deep`, and the governor
 * has to agree. A refusal returns the deterministic clusters untouched with
 * the reason attached — the raw report is the product, this is the garnish.
 *
 * The model's output NEVER overwrites `label`, `terms` or `rank`. Those are
 * Tier 0 and auditable; the prose lands beside them in `summary` and
 * `sourcing` so he can see which part a machine made up.
 *
 * @returns {Promise<{clusters:Array, summarised:boolean, model:string, reason:string, errors:Array}>}
 */
export async function summariseGaps(env, clusters = [], { deep = false, max = DEEP_CLUSTER_MAX } = {}) {
  const base = { clusters, summarised: false, model: "none", reason: "", errors: [] };
  if (!deep) return { ...base, reason: "deep flag not set — raw clusters only" };

  const top = clusters.slice(0, Math.max(1, max));
  if (!top.length) return { ...base, reason: "no clusters to summarise" };

  // One frontier call covers every cluster in the batch, so units is 1.
  const booked = await charge(env, { tier: 3, units: 1, label: "gaps-summary" });
  if (!booked.ok) {
    return {
      ...base,
      reason: booked.reason,
      errors: [{ stage: "budget", error: booked.reason }],
    };
  }

  const blocks = top.map((c, i) => {
    const titles = c.refs.map((r) => `      - ${r.title}`).join("\n");
    const owned = c.nearest
      ? `${c.nearest.title || c.nearest.id} (${c.nearest.category || "uncategorized"}) at ${c.nearest.score.toFixed(2)}`
      : "nothing at all";
    return [
      `CLUSTER ${i}: ${c.size} saved references, none covered by inventory`,
      `    shared words: ${c.terms.join(", ") || "(none repeat)"}`,
      `    nearest owned: ${owned}`,
      `    examples:\n${titles}`,
    ].join("\n");
  });

  const user = [
    `CLUSTERS — ${top.length} sourcing gaps from the archive, ranked by size × distance from anything owned:`,
    "",
    blocks.join("\n\n"),
    "",
    GAPS_INSTRUCTION,
  ].join("\n");

  const { text, model, errors } = await generate(env, {
    system: SYSTEM_PROMPT,
    user,
    deep: true,
    maxTokens: 1200,
  });

  const parsed = parseJsonish(text);
  const rows = Array.isArray(parsed?.clusters) ? parsed.clusters : null;
  if (!rows) {
    return {
      clusters,
      summarised: false,
      model,
      reason: "the model didn't return usable JSON — clusters are unchanged",
      errors: [...errors, { stage: "deep", error: "unparseable summary", raw: String(text || "").slice(0, 400) }],
    };
  }

  // A row pointing at a cluster the model was never shown is an invented one —
  // same rule as the set drafter: never let a made-up index reach the UI.
  const byIndex = new Map(
    rows.filter((r) => Number.isInteger(Number(r?.i)) && Number(r.i) >= 0 && Number(r.i) < top.length)
      .map((r) => [Number(r.i), r])
  );
  const merged = clusters.map((c, i) => {
    const row = byIndex.get(i);
    if (!row) return c;
    return {
      ...c,
      summary: String(row.label || "").slice(0, 200),
      sourcing: String(row.source || "").slice(0, 400),
    };
  });

  return { clusters: merged, summarised: true, model, reason: "", errors };
}

// ------------------------------------------------------------------ helpers

/** Parse a numeric option with a default, a floor and a hard ceiling. */
function clampInt(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < min) return dflt;
  return Math.min(n, max);
}

const short = (err) => String(err?.message ?? err).slice(0, 240);
