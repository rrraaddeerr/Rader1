/**
 * Loop 3 — the brain finds its own gaps and queues its own work.
 *
 * Loops 1 and 2 are both told what to do. The ladder climbs a fixed set of
 * rungs; the swipe queue learns from decisions he has already made. Neither of
 * them can notice that a whole corner of the archive is unreadable, or that a
 * question he is likely to ask would be answered from titles alone. That
 * noticing is what makes this a learning system rather than a cron job, and it
 * is the only thing in here.
 *
 * Four kinds of self-gap, cheapest evidence first:
 *
 *   thin           a region with many refs and almost no enriched text, so any
 *                  question landing there gets answered from titles alone
 *   unanswerable   a question built from the archive's OWN dominant themes that
 *                  retrieves weakly or incoherently when we actually run it
 *   stale          never enriched, or enriched so long ago the page has moved on
 *   duplicate      near-identical refs — the same thing saved twice
 *   contradiction  a ref whose neighbours say it is one thing and whose tags or
 *                  realm say another
 *
 * Then the part that matters: `planTonight()` turns findings into a WORK LIST,
 * ranked by impact per dollar, tagged with the cost tier each job needs, and
 * trimmed until it fits tonight's budget. A plan the governor would refuse is
 * not a plan, so the fitting happens here rather than at execution time.
 *
 * THREE PROPERTIES THIS FILE EXISTS TO HOLD:
 *
 * 1. REGIONS ARE VECTOR NEIGHBOURHOODS, NOT TAG BUCKETS. Tags are the thing
 *    most likely to be missing or wrong in the archive we're auditing — using
 *    them to define regions would make the audit blind in exactly the places it
 *    is supposed to look. So clusters are built from stored vectors: refs are
 *    grouped by what they ARE, and the tags become evidence to check against
 *    the grouping rather than the basis for it.
 *
 * 2. EVERY EMPTY RESULT CARRIES ITS REASON. There is no `catch { return [] }`
 *    anywhere below. An archive with no gaps and a Vectorize query that was
 *    rejected are the same empty array otherwise, and one of those means "well
 *    done, goodnight" while the other means the audit is broken and has been
 *    reporting a clean bill of health for a week. Every function returns an
 *    `error` field alongside its items, and every partial failure lands in
 *    `errors[]` on the way past.
 *
 * 3. FINDING GAPS IS NEARLY FREE. Clustering reads vectors that already exist
 *    (no embedding call), staleness and contradictions are pure functions over
 *    refs we walked anyway. Only the unanswerable probe spends anything — one
 *    tier-2 embedding per question — and it charges before it calls. With no
 *    budget for it, the probe is SKIPPED AND SAID SO, never quietly passed.
 *
 * Nothing here writes to a ref, and nothing here adds one. The work list is a
 * proposal about what to do next; the nightly runner executes it, the ladder
 * applies facts, and anything about what a ref MEANS still lands in his queue.
 */

import { METADATA_TOPK_MAX, EMBED_MODEL } from "./embed.js";
import { charge, quote, estimate } from "./budget.js";

// ------------------------------------------------------------------ thresholds

/** The gap kinds, in the order a brief should read them. */
export const GAP_KINDS = ["thin", "unanswerable", "stale", "duplicate", "contradiction"];

/**
 * What each kind is worth fixing, per ref affected.
 *
 * These are ratios, not currency. An unanswerable region and a duplicate pair
 * are not the same size of problem: the first degrades every answer that lands
 * near it, the second costs him one swipe and a mild irritation. Ranking is
 * only as honest as this table, so it is small, explicit and in one place.
 */
export const GAP_WEIGHT = {
  unanswerable: 4,
  thin: 3,
  contradiction: 2,
  stale: 1.5,
  duplicate: 1,
};

/** Below this a ref has a title and not much else — it cannot answer anything. */
export const THIN_TEXT_CHARS = 200;

/** A region where fewer than this share of refs carry real text is thin. */
export const THIN_ENRICHED_SHARE = 0.35;

/** Fewer refs than this is not a region, it's a coincidence. */
export const MIN_CLUSTER_SIZE = 4;

/**
 * Cosine below this is not a neighbour.
 *
 * Needed because a query against a small index returns `topK` matches whether
 * or not they mean anything — with 1,575 vectors and topK 20 the tail of every
 * result is noise. bge-base puts unrelated text well under 0.5 and genuinely
 * related text over 0.6, so this separates them without tuning per region.
 */
export const CLUSTER_MIN_SCORE = 0.5;

/** Half a year. Long enough that a page has probably changed under us. */
export const STALE_AFTER_DAYS = 180;

/** This close to another ref and it is the same thing saved twice. */
export const DUPLICATE_SCORE = 0.97;

/** A region needs this much agreement before a disagreeing ref is notable. */
export const CONTRADICTION_DOMINANCE = 0.75;

/** …and the disagreement has to be a minority, or it isn't a contradiction. */
export const MAX_OFFENDER_SHARE = 0.25;

/** A probe whose best match is below this retrieved nothing useful. */
export const WEAK_TOP_SCORE = 0.55;

/**
 * Scores this flat mean the query didn't discriminate — everything came back
 * equally near, which is the same as nothing coming back at all. A high top
 * score with no spread beneath it is the signature of a region so uniform that
 * retrieval can't pick the right ref out of it.
 */
export const INCOHERENT_SPREAD = 0.04;

/** Fewer text-carrying refs than this and the answer is composed of titles. */
export const MIN_ANSWER_REFS = 3;

/** Bounds. Loop 3 runs inside a cron with a CPU budget like everything else. */
export const MAX_CLUSTERS = 12;
export const MAX_PROBES = 6;
export const MAX_GAPS_PER_KIND = 10;
export const MAX_UNITS_PER_JOB = 25;
export const MAX_JOBS = 12;

const SAMPLE = 150;
const MAX_SCAN = 400;
const PAGE = 100;
const MAX_HYDRATE = 200;
const DAY_MS = 86_400_000;

/**
 * Free work still has to sort against paid work, and impact/0 is not a number.
 *
 * The floor is deliberately tiny rather than 1: it makes every tier-0 job
 * outrank every tier-2 job on impact-per-dollar, which is not a rounding
 * artefact but the project's standing policy — climb the ladder from the
 * bottom, and never buy what deterministic code can do for nothing.
 */
export const FREE_COST_FLOOR = 1e-6;

const short = (err) => String(err?.message ?? err).slice(0, 240);
const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** "1 ref" / "8 refs". He reads these lines on a phone; "1 refs" reads as a bug. */
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** REALM names start with vowels half the time; "a INSPO region" reads as a bug too. */
const article = (w) => (/^[aeiou]/i.test(String(w || "")) ? "an" : "a");

/** Titles in the archive run long — a card headline has to fit a phone. */
const headline = (s, n = 56) => {
  const t = String(s || "").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Vectorize REJECTS topK above METADATA_TOPK_MAX when returnMetadata is "all".
 * It refuses the query outright — it does not truncate — so an over-fetch here
 * would return NOTHING and this whole file would report a spotless archive.
 * Every query in this module goes through this function.
 */
const safeTopK = (n) => Math.max(1, Math.min(Math.floor(Number(n) || 0) || METADATA_TOPK_MAX, METADATA_TOPK_MAX));

// ------------------------------------------------------------- pure detectors

/**
 * How much readable content a ref actually holds.
 *
 * Deliberately not counting the title: the title is what a thin ref has, and
 * measuring depth with it would make every ref in the archive look enriched.
 *
 * @param {object} ref
 * @returns {number} characters
 */
export function textLength(ref) {
  if (!ref || typeof ref !== "object") return 0;
  let n = 0;
  for (const f of ["caption", "body", "text", "desc", "transcript", "summary"]) {
    if (typeof ref[f] === "string") n += ref[f].trim().length;
  }
  return n;
}

/** Enough content that a model could answer from this ref rather than its name. */
export const hasRealText = (ref, min = THIN_TEXT_CHARS) => textLength(ref) >= min;

/**
 * Has this ref's content gone stale, and how do we know?
 *
 * Two separate facts wear the same word. "Never enriched" is a hole; "enriched
 * in February" is a page that has probably moved on. They want different jobs,
 * so the caller gets told which one it's looking at.
 *
 * The fallback to `createdAt` matters for the 1,578 refs already in KV: an
 * imported ref carries no enrichment stamp at all, and its save date is the
 * only honest lower bound on the age of whatever text it holds. Without it
 * every legacy ref would either look brand new or look like it was never
 * touched, and both readings are wrong.
 *
 * Pure. `now` is injectable so this is testable without waiting six months.
 *
 * @param {object} ref
 * @param {object} [opts]
 * @param {Date}   [opts.now]
 * @param {number} [opts.afterDays]
 * @returns {{stale:boolean, never:boolean, ageDays:number|null, why:string}}
 */
export function stalenessOf(ref, { now = new Date(), afterDays = STALE_AFTER_DAYS } = {}) {
  const no = (why) => ({ stale: false, never: false, ageDays: null, why });
  if (!ref || typeof ref !== "object") return no("not a ref");

  // A pasted note or a typed thought has no source that could change under us.
  // Calling it stale would queue a re-read of a page that does not exist.
  if (!ref.url) return no("no url to re-read");

  const tried = Boolean(ref.enrichedAt || ref.enrichTried || ref.captionTried || ref.imageTried);
  if (!tried && !hasRealText(ref)) {
    return { stale: true, never: true, ageDays: null, why: "never enriched" };
  }

  // Only stamps that mean "we read the source" count. `createdAt` is the
  // FALLBACK, never part of the max: a ref saved yesterday whose page was last
  // read a year ago is stale, and folding the save date in would report it as
  // fresh — which is exactly the ref this check exists to find.
  //
  // `captionTried` is in the list because the line above already trusts it as
  // proof we tried, and the two halves have to agree. Fetching an image's bytes
  // to caption it IS reading the source; leaving the stamp out meant a ref the
  // vision job touched last night reported as "last read 944 days ago" from its
  // import date, was queued for a recheck, was rechecked, and came back stale
  // again on the next lap — the same finding for ever, which is a loop 3 that
  // has learned nothing. `imageTried` is deliberately absent: enrich.js writes
  // it as a boolean, so it can say THAT but never WHEN, and Date.parse drops it.
  const read = [ref.enrichedAt, ref.enrichTried, ref.linkCheckedAt, ref.captionTried]
    .map((s) => Date.parse(s || ""))
    .filter((t) => Number.isFinite(t));
  const at = read.length ? Math.max(...read) : Date.parse(ref.createdAt || "");
  if (!Number.isFinite(at)) return no("no timestamp to judge by");

  const ageDays = (now.getTime() - at) / DAY_MS;
  if (ageDays < afterDays) return { stale: false, never: false, ageDays, why: "recent enough" };
  return { stale: true, never: false, ageDays, why: `last read ${Math.round(ageDays)} days ago` };
}

const STOPWORDS = new Set(
  ("the a an and or of for to in on at with from by is are was be this that it its as into your you my our " +
    "their his her about over under new how what why when who not no more most very just also i we they")
    .split(" ")
);

/**
 * The words a set of refs is actually about.
 *
 * Titles and tags only — bodies would drown the signal in boilerplate nav text
 * and cookie banners, which is what page scraping mostly returns.
 *
 * Pure. Ties break alphabetically so the same region always names itself the
 * same way, which is what makes a probe question comparable night to night.
 *
 * @returns {string[]}
 */
export function termsOf(refs = [], limit = 6) {
  const counts = new Map();
  for (const ref of refs) {
    const bag = [ref?.title, Array.isArray(ref?.tags) ? ref.tags.join(" ") : ""].join(" ");
    for (const w of String(bag).toLowerCase().match(/[a-z][a-z-]{2,}/g) || []) {
      if (STOPWORDS.has(w)) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(1, limit))
    .map(([w]) => w);
}

/**
 * Turn a region into a question the archive should be able to answer about
 * itself. Built from its own dominant terms, so a failure to answer it is a
 * failure on home ground — not us inventing a topic he never saved.
 *
 * @returns {string} "" when the region has no vocabulary to ask about
 */
export function questionFor(cluster) {
  const terms = (cluster?.terms || []).slice(0, 4);
  if (!terms.length) return "";
  const subject =
    terms.length > 1 ? `${terms.slice(0, -1).join(", ")} and ${terms[terms.length - 1]}` : terms[0];
  return `What do my references say about ${subject}?`;
}

/**
 * Do this ref's tags have anything to do with its content?
 *
 * The cheap, honest version of "captions disagree with their tags": if a ref
 * carries several tags and NOT ONE of them appears anywhere in the text we
 * fetched for it, either the tags are wrong or the text is about something
 * else. Both are worth a card in his queue and neither is safe to fix on our
 * own — which is exactly why this reports rather than repairs.
 *
 * Only runs when there is enough text to be evidence. A ref with no body can't
 * contradict its tags; it's just thin, and thin is a different gap.
 *
 * @returns {{checked:boolean, agree:boolean, missing:string[], why:string}}
 */
export function tagsAgree(ref, { min = THIN_TEXT_CHARS } = {}) {
  const tags = Array.isArray(ref?.tags) ? ref.tags.filter((t) => typeof t === "string" && t.trim()) : [];
  if (tags.length < 2) return { checked: false, agree: true, missing: [], why: "fewer than two tags" };
  if (!hasRealText(ref, min)) return { checked: false, agree: true, missing: [], why: "no text to check against" };

  const hay = ["title", "caption", "body", "text", "desc", "transcript"]
    .map((f) => (typeof ref[f] === "string" ? ref[f] : ""))
    .join(" ")
    .toLowerCase();

  const missing = [];
  for (const tag of tags) {
    const words = tag.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
    const probe = words.length ? words : [tag.toLowerCase()];
    if (!probe.some((w) => hay.includes(w))) missing.push(tag);
  }
  return {
    checked: true,
    agree: missing.length < tags.length,
    missing,
    why: missing.length < tags.length ? "at least one tag is grounded" : "no tag appears in the content",
  };
}

/**
 * Normalise a url enough to spot the same thing saved twice.
 *
 * Conservative on purpose: protocol, www, trailing slash, fragment and the
 * tracking params a share sheet bolts on. Nothing that could change WHICH page
 * the url points at — a false duplicate would put a "merge these" card in his
 * queue for two genuinely different refs, and that erodes trust in the queue
 * faster than missing a duplicate does.
 */
export function normalizeUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|igshid|si$|ref$|source$)/i.test(k)) u.searchParams.delete(k);
    }
    const host = u.host.replace(/^www\./i, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}${u.searchParams.toString() ? `?${u.searchParams}` : ""}`;
  } catch {
    // Not a parseable url — compare it as text rather than pretending it has no
    // identity at all. Returning "" here would collapse every malformed url in
    // the archive into one giant false duplicate group.
    return raw.toLowerCase().replace(/\/+$/, "");
  }
}

// ------------------------------------------------------------------ index I/O
//
// These do not reuse embed.js's searchRefsByVector / getRefVector, and the
// reason is the whole of property 2 above: those return `[]` and `null` on
// failure because their callers are user-facing routes that must degrade
// quietly. An audit that degrades quietly reports a clean archive. So the same
// two calls are made here with their failures kept.

/** The stored vector for a ref. `{values:null, error:null}` means "not indexed". */
async function vectorFor(env, id) {
  if (!env?.VECTORS) return { values: null, error: "VECTORS not bound" };
  try {
    const res = await env.VECTORS.getByIds([id]);
    const hit = Array.isArray(res) ? res[0] : res?.[0];
    const values = hit?.values || null;
    return { values, error: null };
  } catch (err) {
    return { values: null, error: `getByIds ${id}: ${short(err)}` };
  }
}

/**
 * Stored vectors for a set of ids, in ONE call.
 *
 * This is what makes duplicate detection independent of which ref happened to
 * seed the region. A query only scores everything against the seed, so a pair
 * of twins sitting two steps away from it looks like two ordinary neighbours;
 * with the members' own vectors in hand the whole region can be compared
 * pairwise in JS for nothing. Twenty members is a hundred and ninety pairs —
 * cheaper than a single subrequest.
 */
async function vectorsFor(env, ids = []) {
  if (!env?.VECTORS) return { values: new Map(), error: "VECTORS not bound" };
  if (!ids.length) return { values: new Map(), error: null };
  try {
    const res = await env.VECTORS.getByIds(ids);
    const values = new Map();
    for (const hit of Array.isArray(res) ? res : []) {
      if (hit?.id && Array.isArray(hit.values)) values.set(hit.id, hit.values);
    }
    return { values, error: null };
  } catch (err) {
    return { values: new Map(), error: `getByIds: ${short(err)}` };
  }
}

/** Cosine similarity. Norms are computed rather than assumed — an unnormalised
 *  vector would otherwise inflate every score and manufacture duplicates. */
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

/**
 * Groups of refs inside a region that are the same thing saved twice.
 *
 * Union-find rather than pairs, because three copies of one screenshot should
 * be one card in his queue asking which to keep, not three separate cards each
 * naming two of them.
 *
 * Pure.
 */
export function duplicateGroups(ids = [], vectors = new Map(), { dupScore = DUPLICATE_SCORE } = {}) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const best = new Map();

  for (let i = 0; i < ids.length; i++) {
    const va = vectors.get(ids[i]);
    if (!va) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const vb = vectors.get(ids[j]);
      if (!vb) continue;
      const score = cosine(va, vb);
      if (score < dupScore) continue;
      const [ra, rb] = [find(ids[i]), find(ids[j])];
      if (ra !== rb) parent.set(rb, ra);
      const root = find(ids[i]);
      best.set(root, Math.max(best.get(root) || 0, score));
    }
  }

  const groups = new Map();
  for (const id of ids) {
    const root = find(id);
    if (!best.has(root)) continue; // never matched anything
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }
  return [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([root, members]) => ({ ids: members, score: Number((best.get(root) || 0).toFixed(4)) }));
}

/** Nearest neighbours to a vector, with the failure kept. */
async function queryNear(env, values, { topK = METADATA_TOPK_MAX, exclude = "" } = {}) {
  if (!env?.VECTORS) return { matches: [], error: "VECTORS not bound" };
  if (!Array.isArray(values) || !values.length) return { matches: [], error: "no vector to query with" };
  try {
    const res = await env.VECTORS.query(values, { topK: safeTopK(topK), returnMetadata: "all" });
    let matches = res?.matches || [];
    if (exclude) matches = matches.filter((m) => m.id !== exclude);
    return {
      matches: matches.map((m) => ({
        id: m.id,
        score: typeof m.score === "number" ? m.score : 0,
        metadata: m.metadata || {},
      })),
      error: null,
    };
  } catch (err) {
    return { matches: [], error: `query: ${short(err)}` };
  }
}

/**
 * Embed one probe question. The ONLY spend in this file.
 *
 * Charges before it calls, per the standing rule — a run that died between the
 * call and the ledger write would hand tomorrow a budget that never noticed
 * tonight. A refusal comes back as an error string, not an exception, so the
 * probe is reported as skipped rather than as passed.
 */
async function embedQuestion(env, question, { spend = true } = {}) {
  if (!env?.AI) return { values: null, spent: 0, error: "AI not bound — probe skipped" };
  let spent = 0;
  if (spend) {
    const paid = await charge(env, { tier: 2, units: 1, label: "selfgaps:probe" });
    if (!paid.ok) return { values: null, spent: 0, error: `budget refused the probe: ${paid.reason}` };
    spent = paid.cost || 0;
  }
  try {
    const res = await env.AI.run(EMBED_MODEL, { text: [question] });
    const values = res?.data?.[0];
    if (!Array.isArray(values) || !values.length) {
      return { values: null, spent, error: "embedding model returned nothing" };
    }
    return { values, spent, error: null };
  } catch (err) {
    return { values: null, spent, error: `embed: ${short(err)}` };
  }
}

/**
 * Bounded, resumable walk of `ref:` keys.
 *
 * cron.js exports scanRefs() doing much the same thing and this deliberately
 * does not import it: the nightly runner is where Loop 3 gets wired in, and a
 * selfgaps that imports cron while cron imports selfgaps is an import cycle
 * waiting to bite. ladder.js made the same call for the same reason.
 *
 * When we stop on a half-consumed page we hand back the cursor we came IN with.
 * Resuming mid-page is impossible, so re-reading it is the only way not to skip
 * its tail, and the re-read is free.
 */
async function walkSample(env, { cursor = null, limit = SAMPLE, maxScan = MAX_SCAN } = {}) {
  const refs = [];
  let kvCursor = cursor || undefined;
  let scanned = 0;
  let unreadable = 0;

  if (!env?.REFS_KV) {
    return { refs, scanned, unreadable, cursor: cursor ?? null, done: false, error: "REFS_KV not bound" };
  }

  while (scanned < maxScan && refs.length < limit) {
    const from = kvCursor;
    let page;
    try {
      page = await env.REFS_KV.list({ prefix: "ref:", limit: PAGE, cursor: from });
    } catch (err) {
      // A failed list is not an empty archive. Say which one this was.
      return { refs, scanned, unreadable, cursor: from ?? null, done: false, error: `list: ${short(err)}` };
    }

    let filled = false;
    for (const k of page.keys) {
      scanned++;
      let ref = null;
      try {
        ref = await env.REFS_KV.get(k.name, "json");
      } catch {
        // One unreadable key must not silently shrink the sample — it's counted,
        // and a result full of `unreadable` is its own diagnosis.
        unreadable++;
        continue;
      }
      if (!ref?.id) { unreadable++; continue; }
      refs.push({ key: k.name, ref });
      if (refs.length >= limit) { filled = true; break; }
    }

    if (filled) return { refs, scanned, unreadable, cursor: from ?? null, done: false, error: null };
    if (page.list_complete) return { refs, scanned, unreadable, cursor: null, done: true, error: null };
    kvCursor = page.cursor;
  }

  return { refs, scanned, unreadable, cursor: kvCursor ?? null, done: false, error: null };
}

// --------------------------------------------------------------- the regions

/**
 * Group the sample into vector neighbourhoods — regions of the archive by what
 * things ARE, not by what they were tagged.
 *
 * Seeds are spread across the sample rather than taken off the front: KV keys
 * sort by id, so the first N refs are one corner of the archive and clustering
 * from them would audit that corner twelve times and nothing else. A ref
 * already claimed by an earlier cluster is never seeded from, so the regions
 * partition rather than overlap.
 *
 * A seed with no stored vector is itself a finding — it means the ref was never
 * embedded and is invisible to every search — so it's counted, not skipped
 * silently.
 *
 * @returns {Promise<{clusters:Array, unvectored:string[], hydrated:number,
 *   errors:string[], error:string|null}>}
 */
export async function neighbourhoods(env, sample = [], {
  max = MAX_CLUSTERS,
  minScore = CLUSTER_MIN_SCORE,
  dupScore = DUPLICATE_SCORE,
  now = new Date(),
} = {}) {
  const errors = [];
  if (!env?.VECTORS) {
    return { clusters: [], unvectored: [], hydrated: 0, errors, error: "VECTORS not bound — cannot cluster by neighbourhood" };
  }
  if (!sample.length) return { clusters: [], unvectored: [], hydrated: 0, errors, error: null };

  const byId = new Map(sample.map(({ ref }) => [ref.id, ref]));
  const claimed = new Set();
  const clusters = [];
  const unvectored = [];
  let hydrated = 0;

  const step = Math.max(1, Math.floor(sample.length / Math.max(1, max)));
  for (let i = 0; i < sample.length && clusters.length < max; i += step) {
    const seed = sample[i].ref;
    if (claimed.has(seed.id)) continue;

    const { values, error: vErr } = await vectorFor(env, seed.id);
    if (vErr) { errors.push(vErr); continue; }
    if (!values) { unvectored.push(seed.id); claimed.add(seed.id); continue; }

    const { matches, error: qErr } = await queryNear(env, values, { topK: METADATA_TOPK_MAX });
    if (qErr) { errors.push(qErr); continue; }

    const near = matches.filter((m) => m.score >= minScore);
    const members = [];
    for (const m of near) {
      let ref = byId.get(m.id);
      if (!ref && hydrated < MAX_HYDRATE) {
        // A neighbour outside the sample window still belongs to the region.
        // Bounded, because subrequests are the real budget on a Worker.
        try {
          ref = await env.REFS_KV.get(`ref:${m.id}`, "json");
          hydrated++;
        } catch (err) {
          errors.push(`hydrate ${m.id}: ${short(err)}`);
        }
      }
      members.push(memberOf(m, ref, { now }));
      claimed.add(m.id);
    }
    if (members.length < 2) continue;

    // One extra getByIds buys the whole pairwise picture of the region, which
    // is the only way to see twins that neither of them happens to be the seed.
    const { values: memberVectors, error: mErr } = await vectorsFor(env, members.map((m) => m.id));
    if (mErr) errors.push(mErr);

    clusters.push(buildCluster(seed, members, {
      now,
      duplicates: duplicateGroups(members.map((m) => m.id), memberVectors, { dupScore }),
    }));
  }

  return { clusters, unvectored, hydrated, errors, error: null };
}

/**
 * One cluster member. `hydrated:false` means we're reading the vector's own
 * metadata instead of the ref — which knows `enriched` (a stamp) but not how
 * many characters we actually hold, so `chars` stays null rather than 0. A zero
 * we invented would read as "definitely thin" and quietly bias the audit.
 */
function memberOf(match, ref, { now }) {
  const meta = match.metadata || {};
  const chars = ref ? textLength(ref) : null;
  return {
    id: match.id,
    score: match.score,
    title: (ref?.title || meta.title || "").slice(0, 120),
    realm: ref?.realm || ref?.classified?.realm || meta.realm || "",
    category: ref?.category || meta.category || "link",
    host: ref?.host || meta.host || "",
    url: ref?.url || "",
    tags: Array.isArray(ref?.tags) ? ref.tags : [],
    chars,
    hasText: ref ? hasRealText(ref) : Boolean(meta.enriched),
    hydrated: Boolean(ref),
    stale: ref ? stalenessOf(ref, { now }) : null,
    captionable: Boolean(ref && ref.category === "image" && !ref.caption && (ref.blobKey || ref.image)),
    readable: Boolean(ref && ref.url && !ref.body && ref.category !== "image"),
  };
}

function buildCluster(seed, members, { now, duplicates = [] }) {
  const scores = members.map((m) => m.score);
  const top = Math.max(...scores);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const withText = members.filter((m) => m.hasText).length;

  const realms = {};
  for (const m of members) if (m.realm) realms[m.realm] = (realms[m.realm] || 0) + 1;
  const [dominantRealm = "", dominantCount = 0] =
    Object.entries(realms).sort((a, b) => b[1] - a[1])[0] || [];

  const refs = members.map((m) => ({ title: m.title, tags: m.tags }));

  return {
    id: seed.id,
    seed: { id: seed.id, title: (seed.title || seed.host || seed.url || "").slice(0, 120) },
    size: members.length,
    members,
    duplicates,
    terms: termsOf(refs, 6),
    enrichedShare: withText / members.length,
    withText,
    dominantRealm,
    realmShare: members.length ? dominantCount / members.length : 0,
    imageShare: members.filter((m) => m.category === "image").length / members.length,
    staleCount: members.filter((m) => m.stale?.stale).length,
    topScore: Number(top.toFixed(4)),
    meanScore: Number(mean.toFixed(4)),
    spread: Number((top - mean).toFixed(4)),
    now: now.toISOString(),
  };
}

// ----------------------------------------------------------------- the probes

/**
 * Ask the archive its own questions and see whether retrieval holds up.
 *
 * This is the one check that cannot be done from stored state: thin coverage is
 * visible in the refs, but "a question about this lands badly" is a property of
 * the index, and the only way to know is to run the query. So each probe costs
 * one tier-2 embedding, charged first, capped at MAX_PROBES.
 *
 * When the budget refuses or AI isn't bound, probes are SKIPPED and the reason
 * is returned. Reporting no unanswerable regions because we never asked is the
 * exact failure this codebase has been bitten by three times.
 *
 * @returns {Promise<{probes:Array, spent:number, ran:number, error:string|null}>}
 */
export async function probeQuestions(env, clusters = [], {
  limit = MAX_PROBES,
  spend = true,
  weakTopScore = WEAK_TOP_SCORE,
  minAnswerRefs = MIN_ANSWER_REFS,
  incoherentSpread = INCOHERENT_SPREAD,
  minScore = CLUSTER_MIN_SCORE,
} = {}) {
  const probes = [];
  let spent = 0;
  let ran = 0;

  // Ask about the biggest regions first — a question landing badly in a region
  // of forty refs is a worse fact than the same failure in a region of five.
  const ordered = [...clusters].sort((a, b) => b.size - a.size).slice(0, Math.max(0, limit));
  if (!ordered.length) return { probes, spent, ran, error: null };

  let error = null;
  for (const cluster of ordered) {
    const question = questionFor(cluster);
    if (!question) continue;

    const { values, spent: cost, error: embedErr } = await embedQuestion(env, question, { spend });
    spent += cost || 0;
    if (embedErr) {
      // First refusal ends the loop: the next probe would be refused for the
      // same reason and each retry is another charge attempt.
      error = embedErr;
      break;
    }

    const { matches, error: qErr } = await queryNear(env, values, { topK: METADATA_TOPK_MAX });
    if (qErr) { error = qErr; break; }
    ran++;

    const near = matches.filter((m) => m.score >= minScore);
    const scores = near.map((m) => m.score);
    const top = scores.length ? Math.max(...scores) : 0;
    const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const withText = near.filter((m) => m.metadata?.enriched).length;

    const reasons = [];
    if (!near.length) reasons.push("nothing retrieved above the noise floor");
    else {
      if (top < weakTopScore) reasons.push(`best match only ${top.toFixed(2)}`);
      if (withText < minAnswerRefs) reasons.push(`only ${withText} of ${near.length} matches carry text`);
      if (near.length > 2 && top - mean < incoherentSpread) {
        reasons.push("scores are flat — retrieval didn't discriminate");
      }
    }

    // 0 = the answer would be invented, 1 = retrieval did its job.
    const strength = clamp01((top - weakTopScore) / Math.max(0.01, 1 - weakTopScore));
    const grounding = clamp01(withText / Math.max(1, minAnswerRefs));
    const quality = Number((strength * grounding).toFixed(4));

    probes.push({
      clusterId: cluster.id,
      question,
      retrieved: near.length,
      withText,
      top: Number(top.toFixed(4)),
      spread: Number((top - mean).toFixed(4)),
      quality,
      weak: reasons.length > 0,
      reasons,
    });
  }

  return { probes, spent: Number(spent.toFixed(6)), ran, error };
}

// ------------------------------------------------------------------ the gaps

function gap(kind, { id, refIds = [], count, impact, detail = {}, line }) {
  const n = count ?? refIds.length;
  return {
    id: `${kind}:${id}`,
    kind,
    refIds: refIds.slice(0, MAX_UNITS_PER_JOB),
    count: n,
    impact: Number(impact.toFixed(3)),
    // Per ref, so trimming a job to fit the budget scales its impact honestly
    // instead of crediting a two-ref job with a forty-ref finding.
    perRef: Number((impact / Math.max(1, n)).toFixed(4)),
    detail,
    // One sentence, already written. He reads this on a phone at breakfast; a
    // surface that has to compute its own prose from six numeric fields is how
    // you end up with a page that only renders on a laptop.
    line,
  };
}

/**
 * Audit the archive against itself.
 *
 * Order is cheapest-evidence-first and every stage is optional: with no VECTORS
 * the deterministic detectors still run and the result says clustering was
 * skipped, because a partial audit he can read beats a 503 he can't.
 *
 * @param {object} env
 * @param {object} [opts]
 * @param {string} [opts.cursor]  resume the walk where the last pass stopped
 * @param {number} [opts.limit]   how many refs to sample
 * @param {boolean}[opts.probe]   run (and pay for) the unanswerable probes
 * @param {number} [opts.probeBudget] USD the probes may spend
 * @returns {Promise<{gaps:Array, clusters:Array, summary:object, probes:object,
 *   sampled:number, scanned:number, unreadable:number, cursor:string|null,
 *   done:boolean, degraded:boolean, errors:string[], error:string|null}>}
 */
export async function findGaps(env, {
  cursor,
  limit = SAMPLE,
  maxScan = MAX_SCAN,
  now = new Date(),
  probe = true,
  probeLimit = MAX_PROBES,
  thinShare = THIN_ENRICHED_SHARE,
  minClusterSize = MIN_CLUSTER_SIZE,
  staleAfterDays = STALE_AFTER_DAYS,
  dupScore = DUPLICATE_SCORE,
  minScore = CLUSTER_MIN_SCORE,
  weakTopScore = WEAK_TOP_SCORE,
} = {}) {
  const errors = [];
  const walk = await walkSample(env, { cursor, limit, maxScan });
  if (walk.error) {
    return {
      gaps: [], clusters: [], summary: summarizeGaps([]),
      probes: { probes: [], ran: 0, spent: 0, error: null, skipped: "the archive walk failed" },
      sampled: 0, scanned: walk.scanned, unreadable: walk.unreadable,
      cursor: walk.cursor, done: false, degraded: true, errors,
      error: walk.error,
    };
  }

  const sample = walk.refs;
  const gaps = [];

  // ---- tier 0: what the refs say about themselves, no index needed ----
  gaps.push(...staleGaps(sample, { now, afterDays: staleAfterDays }));
  gaps.push(...sameUrlGaps(sample));
  gaps.push(...tagContradictionGaps(sample));

  // ---- the index: regions by what things ARE ----
  const hood = await neighbourhoods(env, sample, { minScore, dupScore, now });
  errors.push(...hood.errors);
  const degraded = Boolean(hood.error);
  if (hood.error) errors.push(hood.error);

  gaps.push(...thinGaps(hood.clusters, { thinShare, minClusterSize }));
  gaps.push(...nearDuplicateGaps(hood.clusters));
  gaps.push(...realmContradictionGaps(hood.clusters, { minClusterSize }));
  if (hood.unvectored.length) gaps.push(unvectoredGap(hood.unvectored));

  // ---- the one paid check ----
  // `skipped` and `error` are different facts: one means we chose not to ask,
  // the other means we asked and it broke. Collapsing them is how "no
  // unanswerable regions" comes to mean "we never checked".
  let probes = { probes: [], ran: 0, spent: 0, error: null, skipped: probe ? "" : "probes not requested" };
  if (probe && hood.clusters.length) {
    probes = await probeQuestions(env, hood.clusters, { limit: probeLimit, weakTopScore, minScore });
    if (probes.error) errors.push(probes.error);
    gaps.push(...unanswerableGaps(probes.probes, hood.clusters));
  }

  return {
    gaps,
    clusters: hood.clusters,
    summary: summarizeGaps(gaps),
    probes,
    sampled: sample.length,
    scanned: walk.scanned,
    unreadable: walk.unreadable,
    cursor: walk.cursor,
    done: walk.done,
    degraded,
    errors,
    error: null,
  };
}

/** Regions with plenty of refs and almost no text behind them. */
function thinGaps(clusters, { thinShare, minClusterSize }) {
  return clusters
    .filter((c) => c.size >= minClusterSize && c.enrichedShare < thinShare)
    .sort((a, b) => a.enrichedShare - b.enrichedShare || b.size - a.size)
    .slice(0, MAX_GAPS_PER_KIND)
    .map((c) => {
      const blind = c.members.filter((m) => !m.hasText);
      const topic = c.terms.slice(0, 3).join(", ") || c.seed.title || "an unnamed region";
      return gap("thin", {
        id: c.id,
        refIds: blind.map((m) => m.id),
        count: blind.length,
        impact: GAP_WEIGHT.thin * blind.length * (1 - c.enrichedShare),
        detail: {
          clusterId: c.id,
          size: c.size,
          enrichedShare: Number(c.enrichedShare.toFixed(3)),
          imageShare: Number(c.imageShare.toFixed(3)),
          terms: c.terms,
          captionable: blind.filter((m) => m.captionable).length,
          readable: blind.filter((m) => m.readable).length,
        },
        line: `${blind.length} of ${c.size} refs about ${topic} have nothing but a title — anything asked here gets answered from names alone.`,
      });
    });
}

/** Refs we have never read, or read so long ago the page has moved on. */
function staleGaps(sample, { now, afterDays }) {
  const never = [];
  const old = [];
  for (const { ref } of sample) {
    const s = stalenessOf(ref, { now, afterDays });
    if (!s.stale) continue;
    (s.never ? never : old).push({ id: ref.id, ageDays: s.ageDays });
  }

  const out = [];
  if (never.length) {
    out.push(gap("stale", {
      id: "never",
      refIds: never.map((r) => r.id),
      count: never.length,
      impact: GAP_WEIGHT.stale * never.length,
      detail: { signal: "never enriched" },
      line: `${plural(never.length, "ref")} ${never.length === 1 ? "has" : "have"} never been read at all — the archive knows only ${never.length === 1 ? "its title" : "their titles"}.`,
    }));
  }
  if (old.length) {
    const oldest = Math.round(Math.max(...old.map((r) => r.ageDays || 0)));
    out.push(gap("stale", {
      id: "aged",
      refIds: old.sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0)).map((r) => r.id),
      count: old.length,
      impact: GAP_WEIGHT.stale * old.length,
      detail: { signal: "aged out", afterDays, oldestDays: oldest },
      line: `${plural(old.length, "ref")} ${old.length === 1 ? "was" : "were"} last read over ${afterDays} days ago (oldest ${oldest}) — ${old.length === 1 ? "that page has" : "those pages have"} probably changed.`,
    }));
  }
  return out;
}

/** The same url saved twice. Cheap, certain, and no vectors required. */
function sameUrlGaps(sample) {
  const byUrl = new Map();
  for (const { ref } of sample) {
    const key = normalizeUrl(ref.url);
    if (!key) continue;
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(ref.id);
  }
  return [...byUrl.entries()]
    .filter(([, ids]) => ids.length > 1)
    .slice(0, MAX_GAPS_PER_KIND)
    .map(([key, ids]) =>
      gap("duplicate", {
        id: `url:${key}`.slice(0, 80),
        refIds: ids,
        impact: GAP_WEIGHT.duplicate * (ids.length - 1),
        detail: { signal: "same url", url: key },
        line: `${plural(ids.length, "ref")} point at the same url (${headline(key)}) — one of them is the keeper.`,
      })
    );
}

/**
 * Different urls, near-identical meaning. Only the index can see these, and
 * only the pairwise comparison inside a region can see the ones that aren't
 * touching its seed.
 */
function nearDuplicateGaps(clusters) {
  const out = [];
  const seen = new Set();
  for (const c of clusters) {
    const byId = new Map(c.members.map((m) => [m.id, m]));
    for (const group of c.duplicates || []) {
      // The same group can surface in two overlapping regions; ask once.
      const fingerprint = [...group.ids].sort().join("|");
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      const title = byId.get(group.ids[0])?.title || group.ids[0];
      out.push(gap("duplicate", {
        id: `near:${group.ids[0]}`,
        refIds: group.ids,
        impact: GAP_WEIGHT.duplicate * (group.ids.length - 1),
        detail: { signal: "near-identical", clusterId: c.id, score: group.score },
        line: `"${headline(title)}" has ${plural(group.ids.length - 1, "near-identical twin")} in the archive.`,
      }));
      if (out.length >= MAX_GAPS_PER_KIND) return out;
    }
  }
  return out;
}

/** Refs whose neighbours disagree with their realm. */
function realmContradictionGaps(clusters, { minClusterSize }) {
  const out = [];
  for (const c of clusters) {
    if (c.size < minClusterSize) continue;
    if (!c.dominantRealm || c.realmShare < CONTRADICTION_DOMINANCE) continue;
    const odd = c.members.filter((m) => m.realm && m.realm !== c.dominantRealm);
    if (!odd.length || odd.length / c.size > MAX_OFFENDER_SHARE) continue;
    out.push(gap("contradiction", {
      id: `realm:${c.id}`,
      refIds: odd.map((m) => m.id),
      impact: GAP_WEIGHT.contradiction * odd.length,
      detail: {
        signal: "realm disagrees with neighbours",
        clusterId: c.id,
        dominantRealm: c.dominantRealm,
        realmShare: Number(c.realmShare.toFixed(3)),
        found: odd.map((m) => m.realm),
      },
      line: `${odd.length} ref${odd.length > 1 ? "s sit" : " sits"} in ${article(c.dominantRealm)} ${c.dominantRealm} region but ${odd.length > 1 ? "are" : "is"} filed elsewhere.`,
    }));
    if (out.length >= MAX_GAPS_PER_KIND) break;
  }
  return out;
}

/** Refs whose tags appear nowhere in the content we fetched for them. */
function tagContradictionGaps(sample) {
  const offenders = [];
  for (const { ref } of sample) {
    const verdict = tagsAgree(ref);
    if (verdict.checked && !verdict.agree) offenders.push({ id: ref.id, missing: verdict.missing });
  }
  if (!offenders.length) return [];
  return [
    gap("contradiction", {
      id: "tags",
      refIds: offenders.map((o) => o.id),
      count: offenders.length,
      impact: GAP_WEIGHT.contradiction * offenders.length,
      detail: { signal: "tags absent from content", sample: offenders.slice(0, 5) },
      line: `${plural(offenders.length, "ref")} carr${offenders.length === 1 ? "ies" : "y"} tags that appear nowhere in what we actually read from ${offenders.length === 1 ? "it" : "them"}.`,
    }),
  ];
}

/** A ref with no vector is invisible to every search. That is the worst kind of thin. */
function unvectoredGap(ids) {
  return gap("thin", {
    id: "unvectored",
    refIds: ids,
    impact: GAP_WEIGHT.thin * ids.length,
    detail: { signal: "not in the index" },
    line: `${plural(ids.length, "ref")} ${ids.length === 1 ? "has" : "have"} no vector at all — semantic search cannot see ${ids.length === 1 ? "it" : "them"}.`,
  });
}

/** Questions the archive should be able to answer about itself, and doesn't. */
function unanswerableGaps(probes, clusters) {
  const byId = new Map(clusters.map((c) => [c.id, c]));
  return probes
    .filter((p) => p.weak)
    .slice(0, MAX_GAPS_PER_KIND)
    .map((p) => {
      const c = byId.get(p.clusterId);
      const blind = (c?.members || []).filter((m) => !m.hasText);
      // The refs to fix are the ones with no text; if the region is already
      // fully enriched then retrieval, not content, is what failed — and the
      // whole region is the thing to re-embed.
      const targets = blind.length ? blind : c?.members || [];
      const size = c?.size || targets.length || 1;
      return gap("unanswerable", {
        id: p.clusterId,
        refIds: targets.map((m) => m.id),
        count: targets.length,
        impact: GAP_WEIGHT.unanswerable * size * (1 - p.quality),
        detail: {
          question: p.question,
          quality: p.quality,
          retrieved: p.retrieved,
          withText: p.withText,
          top: p.top,
          reasons: p.reasons,
          contentGap: blind.length > 0,
        },
        line: `"${p.question}" comes back weak — ${p.reasons.join("; ")}.`,
      });
    });
}

/** Counts and totals, for the brief and the header of a phone page. */
export function summarizeGaps(gaps = []) {
  // Counted in GAP_KINDS order so the brief renders the same shape every night
  // — a summary whose keys reshuffle is one he has to re-read to compare.
  const byKind = {};
  for (const kind of GAP_KINDS) if (gaps.some((g) => g.kind === kind)) byKind[kind] = 0;
  let impact = 0;
  const refs = new Set();
  for (const g of gaps) {
    byKind[g.kind] = (byKind[g.kind] || 0) + 1;
    impact += g.impact;
    for (const id of g.refIds) refs.add(id);
  }
  return { gaps: gaps.length, byKind, refs: refs.size, impact: Number(impact.toFixed(2)) };
}

// ----------------------------------------------------------------- the work list

/**
 * What to actually DO about each kind of gap, and what tier it costs.
 *
 * Note what is NOT here: nothing merges a duplicate, nothing rewrites a realm,
 * nothing deletes anything. Those are taste calls, so the job is `stage` — put
 * a card in his queue — which is tier 0 and decides nothing. Only the jobs that
 * fetch facts (text, captions, embeddings) touch a ref, and those go through
 * the ladder, which already knows how to apply them.
 *
 * `runnable` is which of them a night can carry out on its own. Only `stage`
 * cannot, and that is not a gap to close: staging IS asking him, and the audit
 * has no business writing the answer. It is marked here rather than left
 * implicit because fitBudget has to know — a job nothing can run must not take
 * one of the twelve slots ahead of work that would actually happen.
 */
export const ACTIONS = {
  enrich: { tier: 0, vision: false, runnable: true, what: "fetch page text and a thumbnail (ladder rung 2)" },
  caption: { tier: 2, vision: true, runnable: true, what: "vision caption the image (ladder rung 3)" },
  reindex: { tier: 2, vision: false, runnable: true, what: "re-embed so retrieval sees the current content" },
  recheck: { tier: 0, vision: false, runnable: true, what: "re-probe the link and re-read the page" },
  stage: { tier: 0, vision: false, runnable: false, what: "queue a card for his thumb — decides nothing" },
};

/** Which action a gap wants. Pure, so the mapping is inspectable and testable. */
export function actionFor(g) {
  if (!g || typeof g !== "object") return null;
  switch (g.kind) {
    case "thin":
      // An image with no caption cannot be fixed by fetching its page, and a
      // page with no body cannot be fixed by paying for vision. Whichever the
      // region is mostly made of decides, because a job that is half refusals
      // burns the ration on nothing.
      if (g.detail?.signal === "not in the index") return "reindex";
      return (g.detail?.captionable || 0) > (g.detail?.readable || 0) ? "caption" : "enrich";
    case "unanswerable":
      // Content missing -> go get it. Content present but retrieval weak -> the
      // stored vectors no longer describe what the ref holds.
      return g.detail?.contentGap ? "enrich" : "reindex";
    case "stale":
      return g.detail?.signal === "never enriched" ? "enrich" : "recheck";
    case "duplicate":
    case "contradiction":
      return "stage";
    default:
      return null;
  }
}

/**
 * Turn findings into executable jobs.
 *
 * One job per gap, capped at MAX_UNITS_PER_JOB refs. The cap is not about money
 * — at tier 2 twenty-five refs is half a cent — it's about subrequests and
 * about breadth: five regions each moved a little is worth more to him than one
 * region finished while the rest of the archive stands still.
 *
 * @returns {Array} jobs, unranked
 */
export function jobsFor(gaps = [], { maxUnits = MAX_UNITS_PER_JOB } = {}) {
  const jobs = [];
  for (const g of gaps) {
    const action = actionFor(g);
    const spec = ACTIONS[action];
    if (!spec) continue;
    const refIds = g.refIds.slice(0, maxUnits);
    if (!refIds.length) continue;

    const unitCost = estimate(spec.tier, 1);
    const impact = Number((g.perRef * refIds.length).toFixed(3));
    jobs.push({
      id: `${action}:${g.id}`,
      gap: g.id,
      kind: g.kind,
      action,
      what: spec.what,
      tier: spec.tier,
      vision: spec.vision,
      refIds,
      units: refIds.length,
      unitCost,
      cost: Number((unitCost * refIds.length).toFixed(6)),
      perRef: g.perRef,
      impact,
      score: impactPerDollar(g.perRef, unitCost),
      question: g.detail?.question || "",
      why: g.line,
      line: `${action} ${refIds.length} ref${refIds.length > 1 ? "s" : ""} · tier ${spec.tier}${spec.vision ? " · vision" : ""} · ${g.line}`,
    });
  }
  return jobs;
}

/**
 * Impact per dollar, with free work floored rather than divided by zero.
 *
 * Per REF, not per job — which makes the score invariant under trimming, so
 * cutting a job from twenty refs to three to fit the budget cannot reshuffle
 * the ranking underneath it. That invariance is the reason the fitter can trim
 * greedily and still be right.
 */
export function impactPerDollar(perRef, unitCost) {
  return Number((perRef / Math.max(unitCost, FREE_COST_FLOOR)).toFixed(3));
}

/** Highest impact per dollar first; ties go to the bigger total, then by id. */
export function rankJobs(jobs = []) {
  return [...jobs].sort(
    (a, b) => b.score - a.score || b.impact - a.impact || String(a.id).localeCompare(String(b.id))
  );
}

/**
 * Trim the ranked list until it fits.
 *
 * Trims units before dropping a job: three refs of the best work available is
 * better than none of it, and a partial job leaves a cursor-shaped hole the
 * next night walks straight into. A job trimmed to zero is DEFERRED WITH A
 * REASON rather than dropped — "why didn't it do the vision work" has an answer
 * sitting in the run record instead of requiring an investigation.
 *
 * A PLAN HAS TO BE EXECUTABLE TO BE A PLAN. Free work outranks paid work by
 * design (see impactPerDollar), `stage` is free, and nothing anywhere executes
 * a `stage` job — it is a card he has to swipe, which is the whole point of it.
 * So a night with a normal crop of duplicates and contradictions used to fill
 * every one of the twelve slots with work that would come back reported as
 * unhandled, and defer the paid enrichment this loop exists to direct. Actions
 * marked `runnable: false` in ACTIONS therefore never take a slot; they are
 * deferred WITH A REASON, and the finding itself is still in `gaps`, so the
 * duplicate he needs to see is not hidden — it is just not called a job.
 *
 * `can` narrows that further for a caller that knows what tonight can do.
 *
 * Pure.
 *
 * @returns {{jobs:Array, deferred:Array, planned:number, visionPlanned:number}}
 */
export function fitBudget(ranked = [], { budget = 0, visionLeft = 0, maxJobs = MAX_JOBS, can = null } = {}) {
  const taken = [];
  const deferred = [];
  let planned = 0;
  let visionPlanned = 0;
  const stated = can && typeof can.has === "function" ? can : null;
  const runnable = (action) => (stated ? stated.has(action) : ACTIONS[action]?.runnable !== false);

  for (const job of ranked) {
    if (!runnable(job.action)) {
      deferred.push({
        ...job,
        deferredWhy: stated
          ? `nothing running tonight can carry out a "${job.action}" job`
          : `a "${job.action}" job is not the night's to run — the finding is reported, the call is his`,
      });
      continue;
    }
    if (taken.length >= maxJobs) {
      deferred.push({ ...job, deferredWhy: `only ${maxJobs} jobs fit in one night` });
      continue;
    }

    let units = job.units;
    let why = "";

    if (job.vision) {
      const room = Math.max(0, visionLeft - visionPlanned);
      if (units > room) { units = room; why = `vision ration: ${room} left tonight`; }
    }
    if (job.unitCost > 0) {
      // +1e-9 so floating point can't shave a unit off a job that exactly fits.
      const affordable = Math.floor((budget - planned) / job.unitCost + 1e-9);
      if (units > affordable) {
        units = Math.max(0, affordable);
        why = why || `budget: $${(budget - planned).toFixed(4)} left at $${job.unitCost}/ref`;
      }
    }

    if (units < 1) {
      deferred.push({ ...job, units: 0, cost: 0, deferredWhy: why || "no room left tonight" });
      continue;
    }

    const cost = Number((job.unitCost * units).toFixed(6));
    planned = Number((planned + cost).toFixed(6));
    if (job.vision) visionPlanned += units;
    taken.push({
      ...job,
      refIds: job.refIds.slice(0, units),
      units,
      cost,
      impact: Number((job.perRef * units).toFixed(3)),
      trimmed: units < job.units ? why : "",
    });
  }

  return { jobs: taken, deferred, planned, visionPlanned };
}

/**
 * The whole of Loop 3: audit, rank, fit, hand back a work list.
 *
 * The order — find gaps, THEN quote — is deliberate. The probes charge as they
 * run, so quoting first would plan the night's work against a ceiling that
 * hadn't noticed its own audit. When the caller states a `budget`, the probe
 * spend comes out of it too: the promise is that the whole night fits, not that
 * the jobs do.
 *
 * Never throws. Missing bindings come back as `error` with whatever partial
 * work list could still be built — with no VECTORS the stale and duplicate
 * detectors still produce real jobs, and a nightly that does those is better
 * than a nightly that does nothing because clustering was unavailable.
 *
 * @param {object} env
 * @param {object} [opts]
 * @param {number} [opts.budget] USD the whole pass may spend. Defaults to
 *                               whatever tonight's ceiling has left.
 * @returns {Promise<{jobs:Array, deferred:Array, gaps:Array, summary:object,
 *   plan:object, cursor:string|null, done:boolean, degraded:boolean,
 *   errors:string[], error:string|null}>}
 */
export async function planTonight(env, {
  budget,
  cursor,
  limit = SAMPLE,
  maxScan = MAX_SCAN,
  now = new Date(),
  probe = true,
  maxJobs = MAX_JOBS,
  can = null,
  ...thresholds
} = {}) {
  const found = await findGaps(env, { cursor, limit, maxScan, now, probe, ...thresholds });

  const q = await quote(env, { tier: 0, units: 0 });
  const probeSpend = found.probes?.spent || 0;
  const stated = Number.isFinite(Number(budget)) ? Math.max(0, Number(budget)) : null;
  // A stated budget covers the audit as well as the work; the default is
  // whatever the ledger says is left, which already has the probes taken out.
  const allowed = stated === null ? q.remaining : Math.max(0, stated - probeSpend);

  const ranked = rankJobs(jobsFor(found.gaps));
  const fitted = fitBudget(ranked, { budget: allowed, visionLeft: q.visionLeft, maxJobs, can });

  return {
    jobs: fitted.jobs,
    deferred: fitted.deferred,
    gaps: found.gaps,
    summary: found.summary,
    probes: found.probes,
    plan: {
      budget: Number(allowed.toFixed(6)),
      stated,
      probeSpend: Number(probeSpend.toFixed(6)),
      planned: fitted.planned,
      total: Number((fitted.planned + probeSpend).toFixed(6)),
      remaining: Number(Math.max(0, allowed - fitted.planned).toFixed(6)),
      visionLeft: q.visionLeft,
      visionPlanned: fitted.visionPlanned,
      ceiling: q.ceiling,
      spentToday: q.spentToday,
      considered: ranked.length,
      deferred: fitted.deferred.length,
    },
    sampled: found.sampled,
    scanned: found.scanned,
    unreadable: found.unreadable,
    cursor: found.cursor,
    done: found.done,
    degraded: found.degraded,
    errors: found.errors,
    error: found.error,
    // The whole plan as one readable line, for the brief and for his phone.
    line: found.error
      ? `Audit failed: ${found.error}`
      : `${fitted.jobs.length} job${fitted.jobs.length === 1 ? "" : "s"} tonight over ${found.summary.gaps} gap${found.summary.gaps === 1 ? "" : "s"}, $${(fitted.planned + probeSpend).toFixed(4)} of $${allowed.toFixed(2)}.`,
  };
}
