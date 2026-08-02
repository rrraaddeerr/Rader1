/**
 * The morning brief — one page for when he wakes up.
 *
 * His words: "what landed overnight, what the brain noticed, what's waiting on
 * you. React instead of initiating." So this file only ever *reports*. It reads
 * refs, the staging queue and the ledger, and it writes exactly one key: the
 * cached brief itself. It cannot add a ref, edit a ref, or stage a taste
 * judgment — a brief is an observation about the warehouse, not a claim about
 * what anything in it means.
 *
 * Tier ladder, bottom-up as always:
 *   0  the walk, the windowing, the counts and the realm split — plain code
 *   2  the synthesis paragraph on Workers AI
 *   3  the same paragraph on Claude, only behind an explicit `deep` flag
 * The prose is the garnish. The numbers are the brief, and they are always
 * there — a refused charge, a dead model and a missing binding all degrade to
 * "the figures with no paragraph on top", never to a blank page.
 *
 * Two things it refuses to fake, because both have burned this project before:
 *   - A count it couldn't get comes back `null`, never 0. "The queue scan
 *     failed" and "the queue is empty" are opposite facts and must not render
 *     as the same zero.
 *   - A window it couldn't finish reading sets `complete:false`. "3 landed" and
 *     "3 landed before we hit the read cap" are different sentences.
 *
 * Cost of reopening the page: nothing. The built brief is cached in KV under
 * `brief:<UTC day>` and served from there until it goes stale or he asks for a
 * refresh.
 */

import { stats as queueStats } from "./stage.js";
import { charge, ledger, quote, dayStamp } from "./budget.js";
import { generate, SYSTEM_PROMPT } from "./ask.js";

export const BRIEF_PREFIX = "brief:";

/**
 * How long a built brief stays good.
 *
 * The key is stamped with the UTC day, but his morning isn't UTC midnight — in
 * Vancouver the day rolls over at 5pm local, mid-afternoon. So the age check is
 * what actually governs freshness: open it at 7am and again at 11am and you get
 * the same page for free; open it after a mining job has run and it rebuilds.
 */
export const BRIEF_TTL_MS = 6 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The two windows the brief reports on. "Overnight" is the 24h one. */
export const WINDOW_DAYS = 7;

/**
 * Hard ceiling on refs read per build. Every ref is one KV get, and a Worker
 * only gets so many subrequests per request — the queue scan in stage.js wants
 * a large share of the same budget.
 */
export const MAX_READ = 400;

/** Read at least this many refs even when the window closes early, so the
 *  realm split is describing the archive rather than one quiet night. */
export const SHAPE_SAMPLE = 200;

/**
 * Ref ids are reverse-timestamped, so a plain key list walks newest-first and
 * we can stop reading once we're past the window. `PATIENCE` is the slack in
 * that assumption: imported rows kept their original ids and don't all obey the
 * scheme, so the walk wants a run of consecutive out-of-window refs before it
 * believes the window is closed.
 */
const PATIENCE = 40;

/** Key-only pages are cheap, but an unbounded loop is still an unbounded loop. */
const MAX_KEY_PAGES = 30;

/** Enough new refs to recognise the night on sight, few enough to thumb past. */
const LANDED_MAX = 30;

/** Refs with no realm on them. Named, not guessed — see groupByRealm(). */
export const UNASSIGNED = "unassigned";

/** The ref id scheme: 14-digit reverse timestamp, dash, 8 hex. */
const ID_TS_MAX = 10_000_000_000_000;
const ID_SHAPE = /^(\d{14})-[0-9a-f]{8}$/;

// ------------------------------------------------------------------- pure

/** Where a day's brief lives in KV. */
export const briefKey = (day) => `${BRIEF_PREFIX}${day}`;

/**
 * When was this ref saved, in ms?
 *
 * `createdAt` first, then the id — ids are reverse-timestamped, so a ref that
 * lost its field can still be dated exactly. Returns null rather than guessing:
 * an undated ref is not "saved at the epoch", and treating it as one would put
 * the whole Notion import in the overnight column.
 *
 * Pure — unit-tested.
 */
export function refCreatedAt(ref) {
  if (!ref || typeof ref !== "object") return null;
  const stamped = Date.parse(ref.createdAt || "");
  if (Number.isFinite(stamped)) return stamped;
  const m = ID_SHAPE.exec(String(ref.id || ""));
  if (!m) return null;
  const ms = ID_TS_MAX - Number(m[1]);
  // A rev outside the scheme's range means the id isn't one of ours.
  return ms > 0 && ms <= ID_TS_MAX ? ms : null;
}

/**
 * Count refs per realm.
 *
 * Refs without a realm go to `unassigned` rather than through classify(). The
 * classifier is free and it's right most of the time, but realm is a taste
 * judgment and a brief is the wrong place to make one — putting a guess in the
 * archive's own shape report would mean he can't tell what he decided from what
 * a machine decided. "unassigned: 1,412" is also the more useful number: it's
 * how much of the archive the realm backfill hasn't reached.
 *
 * Pure — unit-tested.
 */
export function groupByRealm(refs = []) {
  const out = {};
  for (const ref of refs) {
    const realm = typeof ref?.realm === "string" && ref.realm.trim() ? ref.realm.trim() : UNASSIGNED;
    out[realm] = (out[realm] || 0) + 1;
  }
  return out;
}

/** Trim a ref down to what the brief's strip needs to render it. */
function landedCard(ref, at) {
  return {
    id: ref.id,
    title: ref.title || ref.host || ref.url || "Untitled",
    url: ref.url || "",
    image: ref.image || "",
    category: ref.category || "link",
    realm: typeof ref.realm === "string" ? ref.realm : "",
    createdAt: ref.createdAt || (at ? new Date(at).toISOString() : ""),
  };
}

const fmtCounts = (obj) =>
  Object.entries(obj || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ${n}`)
    .join(", ") || "none";

/**
 * The register the brief is written in.
 *
 * SYSTEM_PROMPT carries his voice, which is the whole reason to reuse it — but
 * it also tells the model to cite [1]/[2] from a CONTEXT list, and there is no
 * context list here. So the brief-specific rules follow it and override that.
 */
export const BRIEF_SYSTEM = [
  SYSTEM_PROMPT,
  "",
  "Right now you are writing the MORNING BRIEF — the one page he reads when he wakes up.",
  "It is a status report on the archive, not an answer to a question, so:",
  "- No citation numbers, no source list. There is no CONTEXT to cite.",
  "- Every figure you use must come from the numbers below, verbatim. Never invent a count, a title or a trend.",
  "- If the numbers don't support a read on what's happening, say what landed and stop. Silence beats a made-up pattern.",
  "- React, don't initiate. Report what happened and what is waiting on him. Do not assign him work he didn't ask for.",
  "- Three sentences maximum. He is reading this on a phone before coffee.",
].join("\n");

const BRIEF_INSTRUCTION = [
  "Write the opening paragraph of the brief above. Three sentences, maximum.",
  "One: what landed. Two: what the shape of it suggests — only if these figures support a read.",
  "Three: what is sitting waiting on his thumb.",
  "No greeting, no sign-off, no headings, no bullets. Plain prose.",
].join("\n");

/**
 * Render a built brief as the plain-text digest the model reads.
 *
 * Pure and exported so the prompt can be tested without a model: what goes in
 * front of Claude is the same thing the page shows, and a drift between the two
 * would be a paragraph describing a night that didn't happen.
 */
export function buildDigest(brief) {
  const l = brief?.landed || {};
  const w = brief?.waiting || {};
  const s = brief?.shape || {};
  const c = brief?.cost || {};
  const day = l.day || {};
  const week = l.week || {};

  const lines = [
    `MORNING BRIEF — ${brief?.day || "today"}`,
    "",
    `Landed in the last 24h: ${day.count ?? 0}${l.complete === false ? " (at least — the read cap cut the scan short)" : ""}`,
    `  by realm: ${fmtCounts(day.byRealm)}`,
    ...(day.refs || []).slice(0, 12).map((r) => `  - ${r.title}${r.category ? ` (${r.category})` : ""}`),
    `Landed in the last 7d: ${week.count ?? 0}`,
    `  by realm: ${fmtCounts(week.byRealm)}`,
    l.lastSaveAt
      ? `Last save: ${l.lastSaveAt}${l.quietHours != null ? ` — ${l.quietHours}h ago` : ""}`
      : "Last save: unknown (nothing read carried a date)",
    "",
    w.pending == null
      ? "Waiting on him: unknown — the queue scan failed, so treat the queue as unread."
      : `Waiting on him: ${w.pending} pending swipes, ${w.approved} approved and not yet pushed anywhere.`,
    "",
    `Archive: ${s.total ?? "?"}${s.exact === false ? "+" : ""} refs saved, ` +
      (s.embedded == null ? "embedded count unavailable" : `${s.embedded} of them embedded`) +
      (s.unindexed != null ? ` (${s.unindexed} not in the index)` : ""),
    `  realm split across the newest ${s.basedOn ?? 0} refs read: ${fmtCounts(s.byRealm)}`,
    "",
    `Spend today: $${Number(c.usd || 0).toFixed(3)} of the $${c.ceiling ?? "?"} ceiling` +
      (c.visionLeft != null ? `, ${c.visionLeft} vision calls left` : ""),
    "",
    BRIEF_INSTRUCTION,
  ];
  return lines.filter((x) => x !== null && x !== undefined).join("\n");
}

// ------------------------------------------------------------------ the pass

/**
 * Build the morning brief.
 *
 * @param {object} env
 * @param {object} [opts]
 * @param {boolean} [opts.deep]     write the synthesis with Claude (tier 3)
 * @param {boolean} [opts.refresh]  ignore the cached brief and rebuild
 * @param {number}  [opts.now]      ms, for tests
 * @param {number}  [opts.windowDays]
 * @returns {Promise<object>} `{ok, day, landed, waiting, cost, shape, synthesis, errors}`
 *                            — never throws
 */
export async function buildBrief(env, { deep = false, refresh = false, now = Date.now(), windowDays = WINDOW_DAYS } = {}) {
  if (!env?.REFS_KV) {
    return { ok: false, error: "REFS_KV binding missing — there is nothing to brief on." };
  }

  const day = dayStamp(new Date(now));
  const key = briefKey(day);
  const errors = [];

  if (!refresh) {
    const hit = await readCache(env, key, now);
    if (hit.error) errors.push({ stage: "cache", error: hit.error });
    if (hit.brief) return hit.brief;
  }

  // --- the walk: counts for everything, values only for the head -----------
  const walk = await walkArchive(env, {
    now,
    windowMs: windowDays * DAY_MS,
    maxRead: MAX_READ,
    sampleMin: SHAPE_SAMPLE,
  });
  errors.push(...walk.errors);

  // --- what landed ---------------------------------------------------------
  const dayCut = now - DAY_MS;
  const inDay = walk.recent.filter((r) => r.at >= dayCut);
  const newest = walk.recent.length ? Math.max(...walk.recent.map((r) => r.at)) : null;

  const landed = {
    since: {
      day: new Date(dayCut).toISOString(),
      week: new Date(now - windowDays * DAY_MS).toISOString(),
    },
    windowDays,
    day: {
      count: inDay.length,
      byRealm: groupByRealm(inDay.map((r) => r.ref)),
      refs: inDay.slice(0, LANDED_MAX).map((r) => landedCard(r.ref, r.at)),
    },
    week: {
      count: walk.recent.length,
      byRealm: groupByRealm(walk.recent.map((r) => r.ref)),
      refs: walk.recent.slice(0, LANDED_MAX).map((r) => landedCard(r.ref, r.at)),
    },
    lastSaveAt: newest ? new Date(newest).toISOString() : null,
    quietHours: newest ? Number(((now - newest) / 3600000).toFixed(1)) : null,
    // False means the walk stopped before it had seen everything it needed —
    // the read cap cut it off mid-window, or a key page failed. The counts
    // above are then a floor, not a total, and the page has to say so.
    complete: walk.stopReason === "exhausted" || walk.stopReason === "window-closed",
    stopReason: walk.stopReason,
    // Refs with no createdAt and no id we could date. They can't be "what
    // landed overnight" either way, but a big number here explains a small one
    // above, which is the difference between a quiet night and a broken import.
    undated: walk.undated,
  };

  // --- what is waiting -----------------------------------------------------
  // stage.stats() walks the whole queue with a get per item, which is the
  // expensive half of this request. A failure comes back as nulls, never zeros:
  // "the scan died" must not render as "queue clear".
  let waiting;
  try {
    waiting = { ...(await queueStats(env)), error: null };
  } catch (err) {
    waiting = { pending: null, approved: null, rejected: null, skipped: null, applied: null, error: short(err) };
    errors.push({ stage: "queue", error: waiting.error });
  }

  // --- what it cost --------------------------------------------------------
  const today = await ledger(env);
  const room = await quote(env, { tier: 3, units: 1 });
  const cost = {
    day: today.day,
    usd: today.usd,
    calls: today.calls,
    vision: today.vision,
    ceiling: room.ceiling,
    remaining: room.remaining,
    visionLeft: room.visionLeft,
    lastLabel: today.lastLabel || "",
  };

  // --- the archive's shape -------------------------------------------------
  const index = await indexSize(env);
  if (index.error) errors.push({ stage: "vectors", error: index.error });
  const shape = {
    total: walk.total,
    // False when the key walk was truncated — `total` is then a floor.
    exact: walk.exact,
    embedded: index.count,
    unindexed: index.count != null && walk.exact ? Math.max(0, walk.total - index.count) : null,
    byRealm: groupByRealm(walk.sample),
    // The realm split describes these refs, not all of them. Saying which is
    // the difference between a fact and a flattering guess.
    basedOn: walk.sample.length,
    read: walk.read,
    unreadable: walk.unreadable,
  };

  const brief = {
    ok: true,
    day,
    builtAt: new Date(now).toISOString(),
    cached: false,
    landed,
    waiting,
    cost,
    shape,
    synthesis: null,
    errors,
  };

  // --- the paragraph on top ------------------------------------------------
  brief.synthesis = await synthesise(env, brief, { deep });
  brief.errors = [...errors, ...brief.synthesis.errors];

  // Writing the brief is itself a charge, so the ledger is re-read afterwards.
  // The digest the model saw is the pre-call ledger — it has to be — but the
  // number he reads on the page has to include the page. Three deep refreshes
  // showing "$0.00 spent" while the real ledger climbs is exactly the kind of
  // quiet drift the governor exists to prevent.
  const settled = await ledger(env);
  brief.cost.usd = settled.usd;
  brief.cost.calls = settled.calls;
  brief.cost.vision = settled.vision;
  brief.cost.remaining = Number(Math.max(0, cost.ceiling - settled.usd).toFixed(4));
  brief.cost.lastLabel = settled.lastLabel || cost.lastLabel;

  // Cache last, so a page reopened five minutes later costs nothing. A cache we
  // can't write is not fatal — he still gets the brief, it just costs again.
  try {
    await env.REFS_KV.put(key, JSON.stringify({ ...brief, cached: false }));
  } catch (err) {
    brief.errors.push({ stage: "cache", error: `couldn't cache the brief: ${short(err)}` });
  }

  return brief;
}

/**
 * Read today's cached brief, if it's still fresh.
 * @returns {Promise<{brief:object|null, error:string|null}>}
 */
async function readCache(env, key, now) {
  try {
    const cached = await env.REFS_KV.get(key, "json");
    if (!cached?.builtAt) return { brief: null, error: null };
    const ageMs = now - Date.parse(cached.builtAt);
    // A negative age is a clock that moved; rebuild rather than trust it.
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > BRIEF_TTL_MS) return { brief: null, error: null };
    return { brief: { ...cached, cached: true, ageMs }, error: null };
  } catch (err) {
    return { brief: null, error: `couldn't read the cached brief: ${short(err)}` };
  }
}

/**
 * Walk the ref keys once: count all of them, read only the head.
 *
 * Key listing is cheap (one subrequest per page, no values), so `total` is
 * exact. Values cost a get each, so we read newest-first and stop at whichever
 * comes first: the window closing, the shape sample filling, or the read cap.
 * Which one stopped us comes back in `stopReason`, because a count that was cut
 * short has to be labelled as one.
 *
 * @returns {Promise<{total:number, exact:boolean, read:number, unreadable:number,
 *                    undated:number, recent:Array<{ref:object, at:number}>,
 *                    sample:Array<object>, stopReason:string, errors:Array}>}
 */
async function walkArchive(env, { now, windowMs, maxRead, sampleMin }) {
  const errors = [];
  const recent = [];
  const sample = [];
  let total = 0;
  let exact = true;
  let read = 0;
  let unreadable = 0;
  let undated = 0;
  let stale = 0;
  let stopReason = "exhausted";
  let reading = true;
  let cursor;
  let pages = 0;

  do {
    let page;
    try {
      page = await env.REFS_KV.list({ prefix: "ref:", limit: 1000, cursor });
    } catch (err) {
      // Not fatal — whatever we already read is still true — but a truncated
      // count must never be presented as the size of the archive.
      errors.push({ stage: "kv-list", error: short(err) });
      exact = false;
      if (reading) stopReason = "list-failed";
      break;
    }
    total += page.keys.length;

    for (const k of page.keys) {
      if (!reading) break;
      if (read >= maxRead) { reading = false; stopReason = "read-cap"; break; }
      // Past the window and the shape sample is full — nothing left to learn
      // from reading further, and every further get is a subrequest.
      if (stale >= PATIENCE && sample.length >= sampleMin) { reading = false; stopReason = "window-closed"; break; }

      let ref = null;
      try {
        ref = await env.REFS_KV.get(k.name, "json");
      } catch (err) {
        errors.push({ stage: "kv-get", key: k.name, error: short(err) });
        continue;
      }
      read++;
      // A listed key that reads back empty is a deleted or half-written ref.
      // Not an error, but "400 read, 0 new" and "400 read, 400 unreadable" are
      // different mornings, so it gets counted rather than dropped.
      if (!ref?.id) { unreadable++; continue; }
      sample.push(ref);

      const at = refCreatedAt(ref);
      if (at == null) {
        // Undated refs can't close the window — they carry no evidence about
        // where we are in time, and letting a block of them count as "old"
        // would hide genuinely new refs sitting behind them.
        undated++;
        continue;
      }
      if (now - at <= windowMs) { recent.push({ ref, at }); stale = 0; }
      else stale++;
    }

    cursor = page.list_complete ? undefined : page.cursor;
    if (++pages >= MAX_KEY_PAGES && cursor) { exact = false; break; }
  } while (cursor);

  // Newest-first only holds for ids we minted; sort so a Notion row with a
  // foreign id still lands in the right place in the strip.
  recent.sort((a, b) => b.at - a.at);

  return { total, exact, read, unreadable, undated, recent, sample, stopReason, errors };
}

/**
 * How many vectors the index actually holds.
 *
 * `describe()` is one subrequest and an exact answer, which beats inferring
 * "embedded" from a flag on each ref. Unavailable comes back as `null` with a
 * reason — a zero here would read as "the whole index is gone".
 */
async function indexSize(env) {
  if (!env?.VECTORS) return { count: null, error: "VECTORS binding missing — embedded count unknown" };
  if (typeof env.VECTORS.describe !== "function") {
    return { count: null, error: "this Vectorize binding has no describe() — embedded count unknown" };
  }
  try {
    const d = await env.VECTORS.describe();
    const n = Number(d?.vectorCount ?? d?.vectorsCount ?? d?.count);
    return Number.isFinite(n) ? { count: n, error: null } : { count: null, error: "describe() returned no vectorCount" };
  } catch (err) {
    return { count: null, error: `describe() failed: ${short(err)}` };
  }
}

/**
 * The paragraph on top, in his register.
 *
 * Gated three ways on purpose: there has to be something to say, there has to
 * be a model, and the governor has to agree. A refusal returns `text:null` with
 * the reason attached and the numbers stand on their own — which is the right
 * shape for this page anyway, since the figures are the brief and the prose is
 * the garnish.
 *
 * @returns {Promise<{text:string|null, model:string, tier:number, cost:number,
 *                    reason:string, errors:Array}>}
 */
async function synthesise(env, brief, { deep = false } = {}) {
  // Asking for deep without the key would book tier 3 and spend tier 2, so the
  // tier follows what's actually reachable rather than what was requested.
  const canDeep = Boolean(deep && env?.ANTHROPIC_API_KEY);
  const tier = canDeep ? 3 : 2;
  const base = { text: null, model: "none", tier, cost: 0, reason: "", errors: [] };

  if (!env?.AI && !env?.ANTHROPIC_API_KEY) {
    return { ...base, reason: "no AI or ANTHROPIC_API_KEY bound — the figures are the brief" };
  }
  // Nothing landed and nothing is waiting. Paying a model to say so is the
  // definition of a burn he didn't ask for. A `null` pending is *not* zero —
  // an unread queue is a reason to write the paragraph, not to skip it.
  if (!brief.landed.week.count && brief.waiting.pending === 0) {
    return { ...base, reason: "nothing landed this week and nothing is waiting — not worth a model call" };
  }

  const booked = await charge(env, { tier, units: 1, label: "morning-brief" });
  if (!booked.ok) {
    return { ...base, reason: booked.reason, errors: [{ stage: "budget", error: booked.reason }] };
  }

  const errors = [];
  if (deep && !canDeep) {
    errors.push({ stage: "deep", error: "no ANTHROPIC_API_KEY — wrote the synthesis with the cheap tier" });
  }

  const out = await generate(env, {
    system: BRIEF_SYSTEM,
    user: buildDigest(brief),
    deep: canDeep,
    maxTokens: 400,
  });
  errors.push(...out.errors.map((e) => ({ stage: "model", error: e })));

  if (!out.text) {
    return {
      ...base,
      model: out.model,
      cost: booked.cost,
      reason: "no model would write it — the figures below are the brief",
      errors,
    };
  }
  return {
    text: out.text.slice(0, 1200),
    model: out.model,
    tier,
    cost: booked.cost,
    reason: "",
    errors,
  };
}

const short = (err) => String(err?.message ?? err).slice(0, 240);
