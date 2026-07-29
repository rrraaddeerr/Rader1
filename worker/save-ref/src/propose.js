/**
 * The proposal generators — what actually fills the swipe queue.
 *
 * stage.js has been sitting there working perfectly with nothing to hold:
 * /queue is empty because nothing ever calls propose(). This is the other
 * half. It reads refs and writes questions.
 *
 * The rule this file exists to respect: agents never decide what a ref means.
 * Everything here returns a PROPOSAL. Nothing mutates a ref, nothing touches
 * Notion, and nothing here can apply a change even by accident — the only
 * write is stage.js's propose(), which can only create pending items.
 *
 * Three generators, cheapest first, all Tier 0:
 *   tagProposals()      pure string matching against the fixed Notion tag
 *                       vocabulary and the TASTE_AXES anchors. No I/O, no model.
 *   deadLinkProposals() one HEAD per url. A factual repair, but staged anyway —
 *                       he wants to see what changed before it changes.
 *   lowConfidenceRealm() the refs classify() couldn't settle, handed to him.
 *
 * On being conservative: a wrong tag costs him a swipe, and a queue of wrong
 * tags costs him the habit. Every threshold in here is set so that "no
 * proposal" is the default answer and evidence has to earn its way past it.
 */

import { TASTE_AXES, CURATORS, normalizeHandle, classify, titleFor } from "./realm.js";
import { propose, isMeaningful, list as listStaged } from "./stage.js";
import { charge } from "./budget.js";

/**
 * The Notion tag vocabulary, exactly as it exists in his database. A proposal
 * may never invent a tag — he'd have to create it by hand, and a tag he didn't
 * choose is a taste judgment made for him.
 */
export const NOTION_TAGS = [
  "Lighting", "Kinetic", "Projection", "Material", "Fabrication", "Set",
  "Furniture", "Sculpture", "Signage", "Fashion", "Architecture", "Nature",
  "Tech", "Food", "Performance", "Off-topic",
];

/**
 * Proposal kinds, in the order they get queued. A ref only holds one pending
 * question at a time (stage.js dedupes by target), so the most certain
 * question goes first and the rest come round on a later pass.
 */
export const KINDS = ["dead-link", "tag", "realm"];

/** Marker that makes a dead-link proposal visible in the title — see below. */
export const DEAD_TITLE_PREFIX = "[dead link] ";

/** Only these mean *gone*. Everything else is "not proven dead". */
export const DEAD_STATUSES = new Set([404, 410]);

// --- confidence bands -------------------------------------------------------
// A single ordinary word is the weakest thing we'll act on; a compound term
// ("set design", "projection mapping") is specific enough to trust more; a
// `weak` term is a word that only means something in company.
const TERM_SCORE = 0.6;
const COMPOUND_SCORE = 0.7;
const WEAK_SCORE = 0.45;
const ANCHOR_SCORE = 0.6;
const CURATOR_SCORE = 0.9;
const CORROBORATION_BONUS = 0.1; // per extra distinct term hitting the same tag
const MAX_TAG_CONFIDENCE = 0.9;
const MIN_TAG_CONFIDENCE = 0.6;

/** More than three tags on one card and it stops being a one-second decision. */
const MAX_TAGS = 3;

const DEFAULT_BATCH = 50;
const MAX_BATCH = 200;
/** Link checks are subrequests, and a Worker only gets so many per request. */
export const MAX_LINK_CHECKS = 25;
const LINK_TIMEOUT_MS = 5000;
const LINK_CONCURRENCY = 4;
const UA = "Mozilla/5.0 (compatible; BigBrainBot/1.0; +https://bigbrain.ref)";

/**
 * Keyword table for the tag vocabulary.
 *
 * `terms` are words that mean the tag on their own; `weak` are words that show
 * up in the right places but also everywhere else ("light", "digital",
 * "installation"), so they only count when something else agrees with them.
 * Matching is word-boundary, not substring: "set" inside "sunset" and "rap"
 * inside "wrapped" are exactly the false positives that make a queue useless.
 */
const TAG_TERMS = {
  Lighting: {
    terms: ["lighting", "neon", "lightbox", "spotlight", "strobe", "chandelier", "backlit",
      "gobo", "luminaire", "lamp", "fluorescent tube", "led strip", "lighting design",
      "light installation"],
    weak: ["light", "glow", "lit"],
  },
  Kinetic: {
    terms: ["kinetic", "animatronic", "motorized", "motorised", "automaton", "pendulum",
      "robotic arm", "moving parts", "kinetic sculpture"],
    weak: ["motion", "rotating", "mechanism"],
  },
  Projection: {
    terms: ["projection", "projector", "projected", "hologram", "holographic",
      "projection mapping", "video mapping"],
    weak: ["screen", "mapped"],
  },
  Material: {
    terms: ["materiality", "textile", "fabric", "resin", "latex", "silicone", "plaster",
      "terrazzo", "velvet", "chrome", "patina", "marble", "ceramic", "rubber", "mesh",
      "foam", "material study"],
    weak: ["material", "texture", "surface", "finish"],
  },
  Fabrication: {
    terms: ["fabrication", "fabricator", "cnc", "3d print", "3d printed", "3d printing",
      "laser cut", "laser cutting", "welded", "welding", "vacuum form", "thermoform",
      "mould making", "mold making", "machined", "workshop build"],
    weak: ["prototype", "built", "cast", "print", "rig"],
  },
  Set: {
    terms: ["set design", "set designer", "set build", "scenography", "stage set", "backdrop",
      "soundstage", "sound stage", "window display", "production design", "diorama"],
    weak: ["stage", "installation", "display"],
  },
  Furniture: {
    terms: ["furniture", "chair", "sofa", "armchair", "stool", "daybed", "shelving", "cabinet",
      "bench", "seating", "coffee table", "side table", "dining table"],
    weak: ["table", "interior", "seat"],
  },
  Sculpture: {
    terms: ["sculpture", "sculptural", "sculptor", "maquette", "plinth", "carved",
      "bas relief", "cast bronze"],
    weak: ["installation", "form", "figure"],
  },
  Signage: {
    terms: ["signage", "wayfinding", "sign painting", "signwriting", "marquee", "billboard",
      "vinyl lettering", "hand painted sign", "shop sign", "lettering", "letterform"],
    weak: ["sign", "typography"],
  },
  Fashion: {
    terms: ["fashion", "runway", "couture", "garment", "menswear", "womenswear", "lookbook",
      "ready to wear", "atelier", "tailoring", "sneaker", "footwear", "denim", "silhouette",
      "stylist", "styling"],
    weak: ["outfit", "wear", "look"],
  },
  Architecture: {
    terms: ["architecture", "architectural", "architect", "brutalist", "brutalism", "facade",
      "pavilion", "atrium", "colonnade", "floor plan", "interior architecture"],
    weak: ["building", "concrete", "structure"],
  },
  Nature: {
    terms: ["botanical", "foliage", "moss", "floral", "flower", "flowers", "mycelium",
      "mushroom", "taxidermy", "wildflower", "landscape", "garden", "greenery", "coral reef"],
    weak: ["nature", "organic", "plant", "forest"],
  },
  Tech: {
    terms: ["artificial intelligence", "machine learning", "llm", "neural network", "robotics",
      "arduino", "raspberry pi", "virtual reality", "augmented reality", "game engine",
      "unreal engine", "touchdesigner", "houdini", "cgi", "3d render", "generative", "sensor",
      "software"],
    weak: ["tech", "digital", "render", "code", "3d"],
  },
  Food: {
    terms: ["culinary", "recipe", "edible", "banquet", "patisserie", "pastry", "cuisine",
      "chef", "food styling"],
    // "restaurant" is weak on purpose: in this archive a restaurant is usually
    // an interior, not a meal.
    weak: ["food", "dish", "kitchen", "restaurant"],
  },
  Performance: {
    terms: ["performance", "choreography", "choreographer", "theatre", "theater", "concert",
      "dj set", "rave", "club night", "ballet", "opera", "live show", "dance piece"],
    weak: ["dance", "show", "live", "stage", "tour"],
  },
  // Calling something worthless is the most annoying tag to get wrong, so it
  // only ever comes from the two words that mean it outright.
  "Off-topic": {
    terms: ["meme", "memes", "shitpost"],
    weak: [],
  },
};

/**
 * Lowercase, strip punctuation, pad with spaces. Padding is what gives us
 * word-boundary matching with a plain includes(): " neon " never matches
 * "neongrid", and it works for multi-word terms too.
 */
function normalize(s) {
  return ` ${String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/** Precompiled needles, so a 1,578-ref pass isn't rebuilding strings per ref. */
const TAG_MATCHERS = Object.entries(TAG_TERMS).map(([tag, spec]) => ({
  tag,
  needles: [
    ...spec.terms.map((term) => ({
      term,
      needle: normalize(term),
      score: term.includes(" ") ? COMPOUND_SCORE : TERM_SCORE,
    })),
    ...spec.weak.map((term) => ({ term, needle: normalize(term), score: WEAK_SCORE })),
  ].filter((n) => n.needle.trim()),
}));

const AXIS_ANCHORS = TASTE_AXES.map((axis) => ({
  id: axis.id,
  tags: axis.tags,
  anchors: axis.anchors.map((a) => ({ term: a, needle: normalize(a) })).filter((a) => a.needle.trim()),
}));

/**
 * The text worth matching against.
 *
 * Deliberately NOT ref.body: that's the whole scraped page, and a fashion
 * article that mentions a restaurant once would come back tagged Food. Title,
 * caption and his own note are the fields that are *about* the ref.
 */
export function refText(ref = {}) {
  return [ref.title, ref.caption, ref.desc, ref.note, ref.text, ref.name, ref.Name, ref.notes, ref.Notes]
    .filter((s) => typeof s === "string" && s.trim())
    .join(" \n ");
}

/**
 * Tags the ref already carries, lowercased — never propose one of these back
 * at him. It's also what makes a pass idempotent: once he's approved a tag and
 * it lands on the ref, we stop asking.
 */
function existingTags(ref) {
  return new Set((Array.isArray(ref.tags) ? ref.tags : []).map((x) => String(x).trim().toLowerCase()));
}

/** Everything a proposal needs to point back at one ref. */
function targetOf(ref) {
  return {
    refId: ref.id || "",
    url: ref.url || ref["userDefined:URL"] || "",
    currentTitle: ref.title || ref.name || ref.Name || "",
    handle: normalizeHandle(ref.handle || ref.url || ""),
  };
}

/**
 * Tier 0 tag suggestions for one ref. Pure — no env, no I/O, no model.
 *
 * Returns an array (0 or 1 proposals) so all three generators plug into the
 * same pipeline. Empty is the common and correct answer: most refs say nothing
 * that maps cleanly onto the vocabulary, and silence costs him nothing.
 *
 * @param {object} ref  a stored ref
 * @returns {Array<object>} proposals ready for stage.propose()
 */
export function tagProposals(ref) {
  if (!ref || typeof ref !== "object") return [];
  const hay = normalize(refText(ref));
  if (hay.trim().length < 3) return [];

  const t = targetOf(ref);
  const have = existingTags(ref);

  /** tag -> {score, hits:string[]} */
  const found = new Map();
  const add = (tag, term, score) => {
    if (have.has(tag.toLowerCase())) return;
    const cur = found.get(tag);
    if (!cur) {
      found.set(tag, { score, hits: [term] });
      return;
    }
    if (!cur.hits.includes(term)) cur.hits.push(term);
    if (score > cur.score) cur.score = score;
  };

  for (const m of TAG_MATCHERS) {
    for (const n of m.needles) if (hay.includes(n.needle)) add(m.tag, n.term, n.score);
  }

  // The taste axes carry his own vocabulary of anchors, already mapped onto
  // Notion tags. Two adjustments before they're allowed near a tag:
  //
  // axisFor() in realm.js matches anchors as substrings, which is fine for a
  // coarse realm but wrong here — "rap" inside "wrapped" would tag a fabric
  // shot Performance — so they're matched on a word boundary like everything
  // else. And a one-word anchor ("3d", "render", "tour") is scored weak for
  // the same reason a one-word keyword is: on its own it means too many
  // things, and it carries two tags with it. A multi-word anchor ("gary card",
  // "set design") is specific enough to stand up by itself.
  const curated = t.handle ? CURATORS[t.handle] : null;
  for (const axis of AXIS_ANCHORS) {
    const viaCurator = curated?.axis === axis.id;
    const anchor = viaCurator ? null : axis.anchors.find((a) => hay.includes(a.needle));
    if (!viaCurator && !anchor) continue;
    const term = viaCurator ? `@${t.handle}` : anchor.term;
    const score = viaCurator ? CURATOR_SCORE : anchor.term.includes(" ") ? ANCHOR_SCORE : WEAK_SCORE;
    for (const tag of axis.tags) add(tag, term, score);
  }

  const scored = [...found.entries()]
    .map(([tag, { score, hits }]) => ({
      tag,
      hits,
      confidence: Math.min(MAX_TAG_CONFIDENCE, score + CORROBORATION_BONUS * (hits.length - 1)),
    }))
    .filter((c) => c.confidence >= MIN_TAG_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence || a.tag.localeCompare(b.tag))
    .slice(0, MAX_TAGS);

  if (!scored.length) return [];

  return [{
    ...t,
    tags: scored.map((c) => c.tag),
    // Approving is all-or-nothing, so the card's confidence is the weakest tag
    // on it — that's the one he's actually being asked to judge.
    confidence: Number(Math.min(...scored.map((c) => c.confidence)).toFixed(2)),
    why: "matched " + scored.map((c) => `${c.hits.map((h) => `"${h}"`).join(", ")} → ${c.tag}`).join(" · "),
    tier: 0,
  }];
}

/**
 * Refs classify() couldn't settle, handed back to him.
 *
 * This proposes the classifier's best guess so the card has something to say
 * yes to, but the point is the swipe UI's realm buttons: he overrides it in
 * one tap. Pure — classify() is Tier 0.
 *
 * @returns {Array<object>} 0 or 1 proposals
 */
export function lowConfidenceRealm(ref) {
  if (!ref || typeof ref !== "object") return [];
  const t = targetOf(ref);
  const input = classifyInput(ref, t);
  const c = classify(input);
  if (!c.needsHelp) return [];

  // titleFor() only replaces a title that's literally "Instagram" or empty, so
  // this rides along only for the nameless rows. "Untitled" is not a repair.
  const better = titleFor(input, t.handle);
  const proposedTitle = better && better !== "Untitled" && better !== t.currentTitle ? better : "";
  const have = existingTags(ref);

  return [{
    ...t,
    proposedTitle,
    realm: c.realm,
    axis: c.axis,
    tags: c.tags.filter((tag) => !have.has(tag.toLowerCase())),
    confidence: c.confidence,
    why: `${c.why} · too weak to settle on its own — your call`,
    tier: 0,
  }];
}

/**
 * Map a stored ref onto the shape classify() reads.
 *
 * Notion-imported rows and worker-native refs use different field names, and
 * classify() only knows the Notion ones. The vision caption is left out on
 * purpose: it's long, and one stray anchor word in it would flip a ref out of
 * "needs help" and quietly hide it from this queue.
 */
function classifyInput(ref, t = targetOf(ref)) {
  return {
    type: ref.type || ref.Type || "",
    sourceApp: ref.sourceApp || ref["Source App"] || "",
    name: t.currentTitle,
    notes: [ref.note || ref.notes || ref.Notes || "", ref.desc || ""].filter(Boolean).join(" · "),
    url: t.url,
    handle: t.handle,
  };
}

/**
 * Flag refs whose url is gone.
 *
 * A 404 is not a taste judgment, but it still goes through the queue: he wants
 * to see what changed before it changes. The flag rides on the title because
 * that's the only channel stage.js can carry — isMeaningful() recognises a
 * retitle, a realm or a tag, and inventing a "Dead" tag would mean inventing a
 * tag he'd have to create in Notion.
 *
 * Only 404 and 410 count. A timeout, a 403 from a bot-blocker, a 500 — none of
 * those prove anything, and flagging on them would put a lie in his archive.
 * Those come back in `errors`; an empty `items` with a full `errors` is a very
 * different result from an empty `items` with none, and the caller gets both.
 *
 * @returns {Promise<{items:Array, checked:number, errors:Array<{url:string,error:string}>}>}
 */
export async function deadLinkProposals(env, refs = [], { limit = MAX_LINK_CHECKS, timeoutMs } = {}) {
  const items = [];
  const errors = [];
  // A slow host shouldn't hold the pass; tunable like the budget ceiling is.
  const ms = Number(timeoutMs ?? env?.LINK_TIMEOUT_MS ?? LINK_TIMEOUT_MS) || LINK_TIMEOUT_MS;
  const queue = (Array.isArray(refs) ? refs : []).filter(checkable).slice(0, Math.max(0, limit));

  for (let i = 0; i < queue.length; i += LINK_CONCURRENCY) {
    const slice = queue.slice(i, i + LINK_CONCURRENCY);
    const results = await Promise.all(slice.map((ref) => headStatus(targetOf(ref).url, ms)));
    results.forEach(({ status, error }, n) => {
      const ref = slice[n];
      const t = targetOf(ref);
      if (error) {
        errors.push({ url: t.url, error });
        return;
      }
      if (!DEAD_STATUSES.has(status)) return;
      items.push({
        ...t,
        proposedTitle: DEAD_TITLE_PREFIX + (t.currentTitle || ref.host || t.url),
        confidence: 0.95, // an HTTP status is not an opinion
        why: `HTTP ${status} — the page is gone`,
        tier: 0,
      });
    });
  }

  return { items, checked: queue.length, errors };
}

/** Worth a request? Needs a real http(s) url it isn't already flagged for. */
function checkable(ref) {
  if (!ref || typeof ref !== "object") return false;
  const url = ref.url || ref["userDefined:URL"] || "";
  if (!/^https?:\/\//i.test(url)) return false;
  return !String(ref.title || "").startsWith(DEAD_TITLE_PREFIX);
}

/**
 * HEAD one url. Never throws; a failure comes back as `error`, never as a
 * status we could mistake for "gone".
 */
async function headStatus(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res = await fetch(url, {
      method: "HEAD",
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": UA },
    });
    // Plenty of servers refuse HEAD outright. That's not an answer about the
    // page, so ask again properly rather than recording a false "alive".
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: "GET",
        signal: ctrl.signal,
        redirect: "follow",
        headers: { "User-Agent": UA, Accept: "text/html" },
      });
      try { await res.body?.cancel(); } catch { /* body we never wanted */ }
    }
    return { status: res.status, error: null };
  } catch (err) {
    return { status: 0, error: String(err?.message ?? err).slice(0, 240) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk a page of refs, run the generators, queue what survives.
 *
 * Bounded and resumable on purpose: one call reads one KV page (newest first,
 * same as handleList) and hands back the cursor, so 1,578 refs are worked in
 * batches instead of one request that dies on CPU or subrequests. Pass the
 * cursor back to continue.
 *
 * @param {object} env
 * @param {object} opts
 * @param {number} [opts.limit]   refs to read this pass
 * @param {string[]} [opts.kinds] which generators to run — see KINDS
 * @param {string} [opts.cursor]  from a previous pass
 * @param {boolean} [opts.dryRun] build the proposals and hand them back
 *                                without queueing any of them
 * @returns {Promise<object>} counts, the next cursor, and every error we hit
 */
export async function runProposalPass(env, { limit, kinds, cursor, source = "propose", linkLimit, dryRun = false } = {}) {
  const errors = [];
  const wanted = new Set(
    (Array.isArray(kinds) && kinds.length ? kinds : KINDS).map(String).filter((k) => KINDS.includes(k))
  );
  if (!wanted.size) {
    return { ok: false, error: `kinds must be some of: ${KINDS.join(", ")}`, cursor: cursor ?? null };
  }

  const n = parseInt(limit, 10);
  const batch = Math.min(Number.isFinite(n) && n > 0 ? n : DEFAULT_BATCH, MAX_BATCH);

  // Tier 0 is free and the governor never blocks it, but the ledger is the one
  // place that knows what tonight has done, so the pass still books its work.
  // A ledger we can't write must not stop deterministic work — say so, run on.
  const booked = await charge(env, { tier: 0, units: batch, label: "propose-pass" });
  if (!booked.ok) errors.push({ stage: "budget", error: booked.reason });

  let page;
  try {
    page = await env.REFS_KV.list({ prefix: "ref:", limit: batch, cursor });
  } catch (err) {
    return {
      ok: false,
      error: `couldn't list refs: ${String(err?.message ?? err).slice(0, 240)}`,
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
      errors.push({ key: k.name, error: String(err?.message ?? err).slice(0, 240) });
      continue;
    }
    // A listed key that reads back empty is a deleted or half-written ref. It's
    // not an error, but it is the difference between "50 scanned, nothing to
    // ask" and "50 scanned, 50 unreadable" — so it gets counted, not dropped.
    if (!ref) { unreadable++; continue; }
    refs.push(ref);
  }

  const byKind = { "dead-link": [], tag: [], realm: [] };
  let checked = 0;

  if (wanted.has("tag")) {
    for (const ref of refs) byKind.tag.push(...tagProposals(ref));
  }
  if (wanted.has("realm")) {
    for (const ref of refs) byKind.realm.push(...lowConfidenceRealm(ref));
  }
  if (wanted.has("dead-link")) {
    const lim = Number.isFinite(parseInt(linkLimit, 10)) ? parseInt(linkLimit, 10) : Math.min(batch, MAX_LINK_CHECKS);
    const out = await deadLinkProposals(env, refs, { limit: lim });
    byKind["dead-link"] = out.items;
    checked = out.checked;
    for (const e of out.errors) errors.push({ stage: "dead-link", ...e });
  }

  // A proposal that changes nothing is noise on a card he has to swipe. It
  // should never happen; if it does, that's a generator bug and the count is
  // how we'd find out.
  let dropped = 0;
  for (const kind of KINDS) {
    const kept = byKind[kind].filter((p) => {
      if (isMeaningful(p)) return true;
      dropped++;
      return false;
    });
    byKind[kind] = kept;
  }

  const queued = { "dead-link": 0, tag: 0, realm: 0 };
  const preview = { "dead-link": [], tag: [], realm: [] };
  let skipped = 0;
  let answered = 0;
  const total = KINDS.reduce((sum, k) => sum + byKind[k].length, 0);

  if (total) {
    const seen = await answeredQuestions(env);
    if (seen.error) errors.push({ stage: "queue", error: seen.error });
    if (seen.truncated) errors.push({ stage: "queue", error: "queue too large to scan fully — some questions may repeat" });

    for (const kind of KINDS) {
      const fresh = byKind[kind].filter((p) => {
        const target = String(p.url || p.refId || "");
        if (!seen.set.has(`${kind} ${target}`)) return true;
        answered++;
        return false;
      });
      if (!fresh.length) continue;
      // Preview stops here: he can read the whole pass before a single pending
      // item exists.
      if (dryRun) { preview[kind] = fresh; continue; }
      const out = await propose(env, { kind, source, proposals: fresh });
      queued[kind] += out.queued;
      skipped += out.skipped;
    }
  }

  return {
    ok: true,
    dryRun,
    scanned: refs.length,
    unreadable,
    checked,
    queued,
    totalQueued: queued["dead-link"] + queued.tag + queued.realm,
    ...(dryRun ? { proposals: preview } : {}),
    // Already pending for that ref (stage.js's own dedupe).
    skipped,
    // Already decided by him once — asking again is how a queue loses trust.
    answered,
    dropped,
    cursor: page.list_complete ? null : page.cursor,
    done: Boolean(page.list_complete),
    errors,
  };
}

/**
 * Questions he has already answered.
 *
 * propose() dedupes against *pending* items, which stops one pass from
 * stacking duplicates on the next. It doesn't stop us re-asking something he
 * rejected last week — and re-asking a settled question is exactly how a swipe
 * queue stops being worth opening. Keyed by kind as well as target, so a
 * rejected tag proposal doesn't also silence a dead link on the same ref.
 *
 * @returns {Promise<{set:Set<string>, truncated:boolean, error:string|null}>}
 */
async function answeredQuestions(env, { max = 3000 } = {}) {
  const set = new Set();
  try {
    // status:"" means "every status" — we want the decided ones.
    const { items, cursor } = await listStaged(env, { status: "", limit: max });
    for (const item of items) {
      if (!item?.target || item.status === "pending") continue;
      set.add(`${item.kind} ${item.target}`);
    }
    return { set, truncated: Boolean(cursor), error: null };
  } catch (err) {
    // Not fatal — worst case he sees a question twice — but never silent.
    return { set, truncated: false, error: `couldn't read the queue: ${String(err?.message ?? err).slice(0, 240)}` };
  }
}
