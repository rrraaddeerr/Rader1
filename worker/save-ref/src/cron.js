/**
 * The nightly job — bounded maintenance while he sleeps.
 *
 * He was badly overbilled once, and the standing rule since is a ~$5 ceiling a
 * night with no heavy background burns unless he says yes in the moment. So the
 * design goal here is NOT "get as much done as the budget allows". It's the
 * opposite: a night that costs about two cents, does a small amount of obvious
 * good, and leaves a written account of itself on the way out. The $5 ceiling is
 * the backstop that catches a bug, not the target to spend up to.
 *
 * That's why every job has its own per-night cap independent of the ledger.
 * Money is not the binding constraint at these volumes — subrequests, CPU and
 * *his patience with a swipe queue* are. A pass that queued 200 questions a
 * night would cost pennies and still be a failure.
 *
 * Four jobs, cheapest first, each stopping the instant the governor says no:
 *
 *   triage  Tier 0  dead links + realms too weak to settle, staged as proposals
 *   embed   Tier 0/2 refs in KV with no vector in the index — detect free, fill paid
 *   enrich  Tier 2  refs with no body yet: page text or transcript, then re-embed
 *   vision  Tier 2  image refs with no caption, strictly inside the 20/night ration
 *
 * What it may and may not do:
 *   - It NEVER adds a ref. There is no code path in this file that can create
 *     one; every job starts from a `ref:` key that already exists.
 *   - Taste judgments (realm, tags, retitles) go to the swipe queue via
 *     stage.js and wait for his thumb. Nothing is applied on his behalf.
 *   - Boring factual repairs — a thumbnail, extracted page text, a caption, a
 *     vector — are written straight onto the ref. Those are facts about the
 *     content, not claims about what it means to him.
 *
 * Resumable and idempotent, in that order of importance:
 *   - Cursors live in KV (`nightly:cursors`) and survive across nights, so the
 *     archive gets walked end to end over a week instead of re-reading the
 *     newest 50 refs forever.
 *   - Paid work checkpoints on the REF, not on a counter: an enriched ref has a
 *     body, an embedded ref has a vector, a captioned ref has a caption. A run
 *     that dies halfway leaves those behind, and the next run's candidate
 *     filter simply doesn't select them again. There is no bookkeeping to get
 *     out of sync, because there is no bookkeeping.
 *   - The vision ration is enforced by the ledger, which charge() writes to KV
 *     per call — so a crash mid-job cannot hand tomorrow a fresh 20.
 *
 * Degrades: with no AI or Vectorize the paid jobs skip themselves with a reason
 * and triage still runs. With no REFS_KV there is nothing to maintain and
 * nowhere to record it, and that's the one hard failure.
 */

import {
  quote,
  charge,
  ledger,
  dayStamp,
  DEFAULT_VISION_RATION,
} from "./budget.js";
import { runProposalPass } from "./propose.js";
import { enrichRef } from "./enrich.js";
import { brainReady, indexRef, embedTextFor } from "./embed.js";

/** Run records: one per UTC day, which is the same day the ledger uses. */
export const RUN_PREFIX = "nightly:";

/** Cursors outlive a single night on purpose — see the header. */
export const CURSOR_KEY = "nightly:cursors";

/** A run record key, and nothing else under the prefix, looks like this. */
const RUN_KEY_RE = /^nightly:\d{4}-\d{2}-\d{2}$/;

/** Cheapest first. The order is the policy; don't reorder without a reason. */
export const JOBS = ["triage", "embed", "enrich", "vision"];

/**
 * Per-night caps. Deliberately small.
 *
 * At Tier 2 the whole list costs about $0.02, so these numbers are not about
 * money — they're about subrequests (each enrich is a page fetch plus an embed,
 * each vision is an image fetch plus a caption plus an embed) and about how
 * many new cards he'll find in the queue at breakfast.
 */
export const NIGHTLY_LIMITS = {
  triage: 60,
  embed: 50,
  enrich: 25,
  vision: DEFAULT_VISION_RATION,
};

/** KV page size while hunting for candidates. */
const PAGE = 100;

/**
 * How many keys a job may read before giving up on finding candidates.
 * Most of the archive is already enriched, so a job can walk a long way
 * without a hit; this stops it walking all 1,578 every night to find nothing.
 */
const MAX_SCAN = 400;

const short = (err) => String(err?.message ?? err).slice(0, 240);

// ------------------------------------------------------------------ the walk

/**
 * Walk `ref:` keys collecting the ones a job can act on.
 *
 * Returns `{refs, error}` rather than a bare array: a KV list that threw and an
 * archive with no candidates left are the same empty list otherwise, and one of
 * those means "nothing to do tonight, well done" while the other means the
 * nightly is broken.
 *
 * When the page we stop on is only half consumed we hand back the cursor we
 * came IN with, not the one KV gave us — resuming mid-page is impossible, so
 * re-reading it is the only way not to skip its tail. That re-read is free, and
 * the refs we already handled no longer match `pick`.
 *
 * @param {object} env
 * @param {object} opts
 * @param {string|null} [opts.cursor] where the last pass stopped
 * @param {number} [opts.want]        how many candidates are enough
 * @param {number} [opts.maxScan]     how many keys we may read looking for them
 * @param {(ref:object) => boolean} [opts.pick]
 * @returns {Promise<{refs:Array<{key:string, ref:object}>, scanned:number,
 *   unreadable:number, cursor:string|null, done:boolean, error:string|null}>}
 */
export async function scanRefs(env, { cursor = null, want = 25, maxScan = MAX_SCAN, pick = () => true } = {}) {
  const refs = [];
  let kvCursor = cursor || undefined;
  let scanned = 0;
  let unreadable = 0;

  while (scanned < maxScan && refs.length < want) {
    const from = kvCursor;
    let page;
    try {
      page = await env.REFS_KV.list({ prefix: "ref:", limit: PAGE, cursor: from });
    } catch (err) {
      // A failed list is not an empty archive. Say so and keep the cursor.
      return {
        refs, scanned, unreadable,
        cursor: from ?? null, done: false,
        error: `list: ${short(err)}`,
      };
    }

    let filled = false;
    for (const k of page.keys) {
      scanned++;
      let ref = null;
      try {
        ref = await env.REFS_KV.get(k.name, "json");
      } catch {
        // One unreadable key must not shrink the batch silently — it's counted,
        // and a run record full of `unreadable` is its own diagnosis.
        unreadable++;
        continue;
      }
      if (!ref?.id) { unreadable++; continue; }
      if (!pick(ref)) continue;
      refs.push({ key: k.name, ref });
      if (refs.length >= want) { filled = true; break; }
    }

    if (filled) return { refs, scanned, unreadable, cursor: from ?? null, done: false, error: null };
    if (page.list_complete) return { refs, scanned, unreadable, cursor: null, done: true, error: null };
    kvCursor = page.cursor;
  }

  return { refs, scanned, unreadable, cursor: kvCursor ?? null, done: false, error: null };
}

// -------------------------------------------------------------- the candidates

/**
 * A ref whose content we've never read.
 *
 * `enrichTried` is the same one-shot marker enrich.js puts on images
 * (`imageTried`): a page that gives us nothing tonight will give us nothing
 * tomorrow either, and paying a Tier 2 unit every night to rediscover that is
 * exactly the slow leak the governor exists to stop. `retry` re-opens them.
 */
export function needsText(ref, { retry = false } = {}) {
  if (!ref?.url) return false;
  if (ref.body || ref.caption) return false;
  // Images belong to the vision job, where the ration is enforced. Audio and
  // notes have nothing enrichRef can read.
  if (ref.category === "image" || ref.category === "audio" || ref.kind === "note") return false;
  return retry ? true : !ref.enrichTried;
}

/** An image ref with no caption, and bytes we can actually reach. */
export function needsCaption(ref, { retry = false } = {}) {
  if (ref?.category !== "image") return false;
  if (ref.caption) return false;
  // No bytes means captionImage() would return "" without ever calling the
  // model — and we'd have spent a unit of the ration on nothing.
  if (!ref.blobKey && !ref.image) return false;
  return retry ? true : !ref.captionTried;
}

/**
 * A ref with something worth paying to embed.
 *
 * Stricter than embedTextFor() on purpose. That function will happily compose
 * "Category: image\nSource: cdn.example.com" for a ref carrying no content at
 * all, and embedding that buys a vector which means nothing, costs a Tier 2
 * unit, and then sits in the index dragging on every search near it. Derived
 * facets are not content; a title, a caption, a note or a tag is.
 */
export function embeddable(ref) {
  if (!ref || typeof ref !== "object") return false;
  const hasText = ["title", "caption", "desc", "text", "body"].some(
    (f) => typeof ref[f] === "string" && ref[f].trim()
  );
  const hasTags = Array.isArray(ref.tags) && ref.tags.length > 0;
  return (hasText || hasTags) && Boolean(embedTextFor(ref));
}

// ------------------------------------------------------------- the run record

const runKey = (day) => RUN_PREFIX + day;

/**
 * One night's record. Returns null when there isn't one — never throws.
 *
 * A read that fails looks the same as no record, which is normally the sort of
 * conflation this project bans. It's safe here for one reason only: the record
 * is a *report*, never the thing that decides what gets redone. Losing it costs
 * us a re-walk of free work, because the refs themselves are the checkpoint and
 * the ledger is the ration. Same call budget.js's ledger() makes.
 */
export async function readRun(env, day) {
  try {
    return await env.REFS_KV.get(runKey(day), "json");
  } catch {
    return null;
  }
}

/**
 * The last few nights, newest first — what the morning brief reads.
 *
 * @returns {Promise<{runs:Array, error:string|null}>}
 */
export async function recentRuns(env, { limit = 7 } = {}) {
  const runs = [];
  try {
    let cursor;
    const names = [];
    do {
      const page = await env.REFS_KV.list({ prefix: RUN_PREFIX, limit: 1000, cursor });
      for (const k of page.keys) if (RUN_KEY_RE.test(k.name)) names.push(k.name);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    // The key is an ISO date, so lexical sort is chronological.
    for (const name of names.sort().reverse().slice(0, Math.max(1, limit))) {
      const run = await env.REFS_KV.get(name, "json");
      if (run) runs.push(run);
    }
    return { runs, error: null };
  } catch (err) {
    // An empty list and a broken KV must not look the same to the brief.
    return { runs, error: `couldn't read run records: ${short(err)}` };
  }
}

/**
 * Cursors that outlive the night.
 *
 * A missing store and an unreadable one both mean "start at the newest refs".
 * That's a re-walk of free KV reads, not a repeat of paid work — the candidate
 * filters drop everything already done — so swallowing here buys resilience
 * without hiding a cost.
 */
async function readCursors(env) {
  try {
    const stored = await env.REFS_KV.get(CURSOR_KEY, "json");
    return stored && typeof stored === "object" ? stored : {};
  } catch {
    return {};
  }
}

/**
 * Persist cursors. Failing to save one costs us a re-walk of free work, so it's
 * reported rather than thrown — losing the night over it would be worse.
 */
async function writeCursors(env, cursors) {
  try {
    await env.REFS_KV.put(CURSOR_KEY, JSON.stringify(cursors));
    return null;
  } catch (err) {
    return `couldn't save cursors: ${short(err)}`;
  }
}

function freshRecord(day, startedAt) {
  const jobs = {};
  for (const job of JOBS) jobs[job] = { status: "pending", scanned: 0, cursor: null, done: false };
  return {
    day,
    startedAt,
    updatedAt: startedAt,
    finishedAt: null,
    status: "running",
    runs: 0,
    plan: null,
    jobs,
    did: [],
    skipped: [],
    cost: { atStart: 0, atEnd: 0, spent: 0, vision: 0 },
    next: "",
    errors: [],
  };
}

/** Write the record. A run we can't record still happened — say so, don't throw. */
async function writeRun(env, record) {
  record.updatedAt = new Date().toISOString();
  try {
    await env.REFS_KV.put(runKey(record.day), JSON.stringify(record));
    return null;
  } catch (err) {
    const msg = `couldn't write the run record: ${short(err)}`;
    // The record is where errors normally go, so this one has to go somewhere
    // else as well — otherwise the only trace of a night with no morning brief
    // is the missing brief itself.
    console.error(`[nightly ${record.day}] ${msg}`);
    if (!record.errors.some((e) => e.error === msg)) record.errors.push({ stage: "record", error: msg });
    return msg;
  }
}

// ------------------------------------------------------------------- planning

/**
 * What fits tonight, asked before anything is touched.
 *
 * `room` is the gate on the whole run: it's a quote for one single Tier 2 unit,
 * the cheapest paid thing this file can do. If that doesn't fit, the night's
 * ceiling is already gone — which means something else burned it — and the
 * right move is to stop and tell him at breakfast, not to keep grinding through
 * free work as though nothing happened.
 */
async function planFor(env, wanted, caps) {
  const jobs = {};
  jobs.triage = await quote(env, { tier: 0, units: caps.triage });
  jobs.embed = await quote(env, { tier: 2, units: caps.embed });
  jobs.enrich = await quote(env, { tier: 2, units: caps.enrich });
  jobs.vision = await quote(env, { tier: 2, units: caps.vision, vision: true });

  const room = await quote(env, { tier: 2, units: 1 });
  const would = wanted.reduce((sum, j) => sum + (jobs[j]?.cost || 0), 0);

  return {
    jobs,
    wanted,
    caps,
    ceiling: room.ceiling,
    spentToday: room.spentToday,
    remaining: room.remaining,
    visionLeft: room.visionLeft,
    // What the whole night would cost if every job ran to its cap.
    wouldCost: Number(would.toFixed(4)),
    room: room.fits,
    reason: room.fits ? "" : `nothing left tonight — $${room.spentToday.toFixed(3)} of $${room.ceiling} already spent`,
  };
}

// ---------------------------------------------------------------- job: triage

/**
 * Tier 0: dead links and realms too weak to settle, staged for his thumb.
 *
 * Tag proposals are left out even though they're free and propose.js has them.
 * A ref only carries one pending question at a time, and a nightly that queues
 * three kinds of question per ref buries the two that matter under the one that
 * doesn't. Tags stay a thing he asks for by hand.
 */
async function jobTriage(env, { cap, cursor, source }) {
  const out = await runProposalPass(env, {
    kinds: ["dead-link", "realm"],
    limit: cap,
    cursor: cursor || undefined,
    source,
  });

  if (!out.ok) {
    return { skipped: true, reason: out.error, errors: out.errors || [], cursor };
  }

  const queued = out.queued || {};
  return {
    scanned: out.scanned,
    cursor: out.cursor,
    done: Boolean(out.done),
    detail: {
      queued: out.totalQueued,
      deadLinks: queued["dead-link"] || 0,
      realms: queued.realm || 0,
      checked: out.checked,
      alreadyPending: out.skipped,
      alreadyAnswered: out.answered,
      unreadable: out.unreadable,
    },
    errors: out.errors || [],
    line:
      `triage: read ${out.scanned} refs, checked ${out.checked} links, ` +
      `staged ${out.totalQueued} proposals (${queued["dead-link"] || 0} dead, ${queued.realm || 0} realm)`,
  };
}

// ----------------------------------------------------------------- job: embed

/**
 * Backfill vectors for refs the index doesn't hold.
 *
 * Detection is free (one getByIds for the whole page); only the fill is paid.
 * The failure mode worth naming: if that lookup throws and we treat it as "none
 * of these are indexed", we re-embed 50 refs a night that were already fine —
 * paying twice for the same fingerprint, quietly, forever. So a failed lookup
 * skips the job outright rather than falling through to the paid path.
 */
async function jobEmbed(env, { cap, cursor }) {
  if (!brainReady(env)) {
    return { skipped: true, reason: "AI/VECTORS not bound — no index to backfill", cursor };
  }

  const scan = await scanRefs(env, { cursor, want: cap, pick: embeddable });
  if (scan.error) {
    return { skipped: true, reason: scan.error, errors: [{ stage: "kv", error: scan.error }], cursor };
  }
  if (!scan.refs.length) {
    return { scanned: scan.scanned, cursor: scan.cursor, done: scan.done, detail: { embedded: 0 }, errors: [], line: "embed: nothing embeddable in this stretch" };
  }

  let have;
  try {
    const res = await env.VECTORS.getByIds(scan.refs.map(({ ref }) => ref.id));
    const listed = Array.isArray(res) ? res : res?.vectors || [];
    have = new Set(listed.filter((v) => v?.id && Array.isArray(v.values) && v.values.length).map((v) => v.id));
  } catch (err) {
    return {
      skipped: true,
      reason: `index lookup failed, so nothing was re-embedded: ${short(err)}`,
      errors: [{ stage: "vectors", error: short(err) }],
      cursor,
    };
  }

  const missing = scan.refs.filter(({ ref }) => !have.has(ref.id));
  const errors = [];
  let embedded = 0;
  let failed = 0;
  let stopped = false;
  let reason = "";

  for (const { ref } of missing) {
    const booked = await charge(env, { tier: 2, units: 1, label: "nightly-embed" });
    if (!booked.ok) { stopped = true; reason = booked.reason; break; }
    if (await indexRef(env, ref)) {
      embedded++;
    } else {
      // We paid for this one and got nothing. indexRef() swallows its own
      // failure and returns false, so it gets said out loud here — otherwise a
      // broken index reads as "there was nothing to backfill".
      failed++;
      errors.push({ stage: "embed", refId: ref.id, error: "indexRef returned false — the embed or the upsert failed" });
    }
  }

  return {
    scanned: scan.scanned,
    cursor: stopped ? cursor : scan.cursor,
    done: stopped ? false : scan.done,
    stopped,
    reason,
    detail: { candidates: scan.refs.length, alreadyIndexed: have.size, embedded, failed, unreadable: scan.unreadable },
    errors,
    line: `embed: ${embedded} vectors backfilled, ${have.size} already indexed${failed ? `, ${failed} failed` : ""}`,
  };
}

// ---------------------------------------------------------------- job: enrich

/**
 * Tier 2: pull the actual content of refs we've never read.
 *
 * One charge per ref covers the enrich and the re-embed that follows it —
 * splitting a $0.0002 unit in two buys ledger noise, not accuracy. What it must
 * not do is charge *after* the work: a run that dies between the call and the
 * ledger write would hand tomorrow a budget that never noticed tonight.
 *
 * The write-back re-reads the ref first. Enrichment takes seconds, and a ref he
 * edited on his phone in the meantime must not be overwritten by the copy we
 * loaded before he touched it.
 */
async function jobEnrich(env, { cap, cursor, retry }) {
  const scan = await scanRefs(env, { cursor, want: cap, pick: (r) => needsText(r, { retry }) });
  if (scan.error) {
    return { skipped: true, reason: scan.error, errors: [{ stage: "kv", error: scan.error }], cursor };
  }

  const errors = [];
  let enriched = 0;
  let repaired = 0;
  let empty = 0;
  let stopped = false;
  let reason = "";

  for (const { key, ref } of scan.refs) {
    const booked = await charge(env, { tier: 2, units: 1, label: "nightly-enrich" });
    if (!booked.ok) { stopped = true; reason = booked.reason; break; }

    let patch;
    try {
      patch = await enrichRef(env, ref);
    } catch (err) {
      errors.push({ stage: "enrich", refId: ref.id, error: short(err) });
      continue;
    }

    const got = Boolean(patch.body || patch.caption);
    // Mark the attempt either way. A page that gave us nothing tonight will
    // give us nothing tomorrow, and re-buying that answer every night is the
    // slow leak this file exists to avoid. `retry` re-opens them deliberately.
    const merged = { ...patch, enrichTried: new Date().toISOString() };

    let current;
    try {
      current = await env.REFS_KV.get(key, "json");
    } catch (err) {
      errors.push({ stage: "kv", refId: ref.id, error: `re-read failed, patch dropped: ${short(err)}` });
      continue;
    }
    if (!current) continue; // deleted while we were working

    const updated = { ...current, ...merged };
    try {
      await env.REFS_KV.put(key, JSON.stringify(updated));
    } catch (err) {
      errors.push({ stage: "kv", refId: ref.id, error: `write failed, enrichment lost: ${short(err)}` });
      continue;
    }

    if (got) {
      enriched++;
      // New body means the old vector no longer describes this ref.
      if (brainReady(env) && !(await indexRef(env, updated))) {
        errors.push({ stage: "embed", refId: ref.id, error: "re-index after enrich failed — the index is stale for this ref" });
      }
    } else if (patch.image) {
      repaired++;
    } else {
      empty++;
    }
  }

  return {
    scanned: scan.scanned,
    cursor: stopped ? cursor : scan.cursor,
    done: stopped ? false : scan.done,
    stopped,
    reason,
    detail: { candidates: scan.refs.length, enriched, thumbnails: repaired, gaveNothing: empty, unreadable: scan.unreadable },
    errors,
    line: `enrich: ${enriched} refs got real text${repaired ? `, ${repaired} got a thumbnail` : ""}${empty ? `, ${empty} had nothing to give` : ""}`,
  };
}

// ---------------------------------------------------------------- job: vision

/**
 * Vision captions, and only ever inside the ration.
 *
 * Capped twice on purpose. `quote()` tells us how much ration is left so we
 * don't even load candidates we can't pay for, and then every single image
 * charges with `vision:true` immediately before the model call. The second cap
 * is the one that counts: the ledger is in KV, so a run that dies mid-job has
 * already spent what it spent, and tomorrow does not get a fresh 20.
 *
 * Only `category === "image"` refs reach here — enrichRef's vision branch keys
 * off the same field, so nothing else can trip a caption by accident.
 */
async function jobVision(env, { cap, cursor, retry }) {
  if (!env?.AI) {
    return { skipped: true, reason: "AI not bound — no vision model", cursor };
  }

  const q = await quote(env, { tier: 2, units: 1, vision: true });
  const room = Math.max(0, Math.min(cap, q.visionLeft));
  if (!room) {
    // No total in the message: the ration is env-overridable and budget.js
    // keeps that number to itself, so quoting a constant here would be a lie
    // the moment VISION_RATION is set.
    return { skipped: true, reason: "vision ration spent — no captions left tonight", cursor };
  }

  const scan = await scanRefs(env, { cursor, want: room, pick: (r) => needsCaption(r, { retry }) });
  if (scan.error) {
    return { skipped: true, reason: scan.error, errors: [{ stage: "kv", error: scan.error }], cursor };
  }

  const errors = [];
  let captioned = 0;
  let empty = 0;
  let spent = 0;
  let stopped = false;
  let reason = "";

  for (const { key, ref } of scan.refs) {
    const booked = await charge(env, { tier: 2, units: 1, vision: true, label: "nightly-vision" });
    if (!booked.ok) { stopped = true; reason = booked.reason; break; }
    spent++;

    let patch;
    try {
      patch = await enrichRef(env, ref);
    } catch (err) {
      errors.push({ stage: "vision", refId: ref.id, error: short(err) });
      continue;
    }

    const merged = { ...patch, captionTried: new Date().toISOString() };

    let current;
    try {
      current = await env.REFS_KV.get(key, "json");
    } catch (err) {
      errors.push({ stage: "kv", refId: ref.id, error: `re-read failed, caption dropped: ${short(err)}` });
      continue;
    }
    if (!current) continue;

    const updated = { ...current, ...merged };
    try {
      await env.REFS_KV.put(key, JSON.stringify(updated));
    } catch (err) {
      errors.push({ stage: "kv", refId: ref.id, error: `write failed, caption lost: ${short(err)}` });
      continue;
    }

    if (patch.caption) {
      captioned++;
      if (brainReady(env) && !(await indexRef(env, updated))) {
        errors.push({ stage: "embed", refId: ref.id, error: "re-index after caption failed — the index is stale for this ref" });
      }
    } else {
      // A spent ration unit with no caption to show for it. Not an error we can
      // fix, but never a silent one — it's the difference between "the archive
      // has no images left" and "the vision model is failing every call".
      empty++;
      errors.push({ stage: "vision", refId: ref.id, error: "ration spent but the model returned no caption" });
    }
  }

  return {
    scanned: scan.scanned,
    cursor: stopped ? cursor : scan.cursor,
    done: stopped ? false : scan.done,
    stopped,
    reason,
    detail: { candidates: scan.refs.length, captioned, rationSpent: spent, rationLeftBefore: q.visionLeft, noCaption: empty, unreadable: scan.unreadable },
    errors,
    line: `vision: ${captioned} captions from ${spent} of ${q.visionLeft} rationed calls`,
  };
}

const RUNNERS = { triage: jobTriage, embed: jobEmbed, enrich: jobEnrich, vision: jobVision };

// -------------------------------------------------------------------- the run

/** Only the jobs we know, in the order the policy says, deduped. */
function pickJobs(jobs) {
  if (!Array.isArray(jobs) || !jobs.length) return [...JOBS];
  const wanted = new Set(jobs.map(String));
  return JOBS.filter((j) => wanted.has(j));
}

/** What the next run should pick up, per job. The morning brief quotes this. */
function nextSteps(record) {
  const lines = [];
  for (const job of JOBS) {
    const s = record.jobs[job];
    if (!s || s.status === "pending") continue;
    if (s.status === "stopped") lines.push(`${job}: resume — stopped by the governor (${s.reason})`);
    else if (s.status === "skipped") lines.push(`${job}: skipped — ${s.reason}`);
    else if (s.status === "error") lines.push(`${job}: retry — it threw (${s.error})`);
    else if (s.done) lines.push(`${job}: reached the end of the archive, starts over next run`);
    else lines.push(`${job}: more to walk, resumes from its cursor`);
  }
  return lines.join(" · ");
}

/**
 * Run the night.
 *
 * @param {object} env    worker env (REFS_KV required; AI/VECTORS optional)
 * @param {object} ctx    the scheduled ExecutionContext. Accepted because a
 *                        scheduled handler has one and a future job may want
 *                        waitUntil — nothing here defers, because a nightly
 *                        that returns before its work lands writes a record
 *                        that isn't true.
 * @param {object} [opts]
 * @param {Date}   [opts.now]     injectable clock, for tests and backfills
 * @param {boolean}[opts.dryRun]  quote and plan, touch nothing, record nothing
 * @param {string[]}[opts.jobs]   run a subset — see JOBS
 * @param {object} [opts.limits]  override the per-night caps
 * @param {boolean}[opts.retry]   re-open refs already marked tried
 * @returns {Promise<object>} the run record, plus `ok`
 */
export async function runNightly(env, ctx, { now = new Date(), dryRun = false, jobs, limits, retry = false } = {}) {
  const day = dayStamp(now);

  if (!env?.REFS_KV) {
    return { ok: false, day, error: "REFS_KV binding missing — nothing to maintain and nowhere to record it." };
  }

  const wanted = pickJobs(jobs);
  const caps = { ...NIGHTLY_LIMITS, ...(limits || {}) };

  // 1. Ask what fits BEFORE doing anything, and say so out loud. `wrangler
  //    tail` at 4am is the only window into this run while it's happening.
  const plan = await planFor(env, wanted, caps);
  console.log(`[nightly ${day}] plan`, JSON.stringify({
    jobs: wanted,
    spentToday: plan.spentToday,
    remaining: plan.remaining,
    visionLeft: plan.visionLeft,
    wouldCost: plan.wouldCost,
    room: plan.room,
  }));

  if (dryRun) {
    return { ok: true, day, dryRun: true, status: "planned", plan, ran: [] };
  }

  // Same-day re-entry resumes the existing record; a new day starts a new one.
  // A record written by an older version of this file is still a valid resume
  // point, so every field it might be missing gets filled in rather than
  // trusted — a nightly that throws on its own history helps nobody.
  const prior = await readRun(env, day);
  const record = prior?.day === day ? prior : freshRecord(day, new Date(now).toISOString());
  const blank = freshRecord(day, new Date(now).toISOString());
  record.jobs = { ...blank.jobs, ...(record.jobs || {}) };
  record.cost = { ...blank.cost, ...(record.cost || {}) };
  record.errors = Array.isArray(record.errors) ? record.errors : [];
  record.did = Array.isArray(record.did) ? record.did : [];
  record.skipped = Array.isArray(record.skipped) ? record.skipped : [];
  record.runs = (record.runs || 0) + 1;
  record.plan = plan;
  record.status = "running";
  record.finishedAt = null;
  // The record belongs to the NIGHT, not to one invocation of it: `did` and
  // `skipped` accumulate across a resumed run, so the cost has to as well or
  // the brief would show four jobs' work beside the last retry's bill.
  if (record.runs === 1) record.cost.atStart = plan.spentToday;

  const cursors = await readCursors(env);

  // The gate. See planFor(): no room for one Tier 2 unit means the night's
  // ceiling is already gone, and the useful thing to do is stop and report.
  if (!plan.room) {
    record.status = "refused";
    record.stoppedBy = plan.reason;
    for (const job of wanted) {
      if (record.jobs[job].status === "pending") {
        record.jobs[job] = { ...record.jobs[job], status: "skipped", reason: plan.reason };
        record.skipped.push(`${job}: ${plan.reason}`);
      }
    }
    record.cost.atEnd = plan.spentToday;
    record.cost.spent = Number((plan.spentToday - record.cost.atStart).toFixed(6));
    record.next = `budget refused before any work ran — ${nextSteps(record)}`;
    record.finishedAt = new Date().toISOString();
    await writeRun(env, record);
    console.log(`[nightly ${day}] refused: ${plan.reason}`);
    return { ok: true, ...record, ran: [] };
  }

  await writeRun(env, record); // checkpoint before the first job touches anything

  const ran = [];
  for (const job of wanted) {
    const state = record.jobs[job];

    // 5. Idempotence at the run level. Within a job it's structural — an
    //    enriched ref has a body and no longer matches the filter — but a job
    //    that already walked the whole archive tonight has nothing to add.
    if (state.status === "done" && state.done) {
      record.skipped.push(`${job}: already finished tonight`);
      continue;
    }

    let out;
    try {
      out = await RUNNERS[job](env, {
        cap: caps[job],
        cursor: cursors[job] ?? null,
        retry,
        source: "nightly",
      });
    } catch (err) {
      // One broken job must not take the night with it — the cheaper jobs have
      // already banked their work and the later ones are independent.
      record.jobs[job] = { ...state, status: "error", error: short(err) };
      record.errors.push({ job, error: short(err) });
      await writeRun(env, record);
      continue;
    }

    for (const e of out.errors || []) record.errors.push({ job, ...(typeof e === "object" ? e : { error: String(e) }) });

    if (out.skipped) {
      record.jobs[job] = { ...state, status: "skipped", reason: out.reason || "" };
      record.skipped.push(`${job}: ${out.reason || "nothing to do"}`);
    } else {
      record.jobs[job] = {
        status: out.stopped ? "stopped" : out.done ? "done" : "partial",
        scanned: out.scanned || 0,
        cursor: out.cursor ?? null,
        done: Boolean(out.done),
        detail: out.detail || {},
        ...(out.stopped ? { reason: out.reason } : {}),
      };
      record.did.push(out.line);
      ran.push(job);
      // A finished walk resets, so tomorrow starts at the newest refs again.
      cursors[job] = out.done ? null : out.cursor ?? null;
    }

    // Checkpoint after every job: a crash from here on cannot undo what this
    // job paid for, and the cursor is already saved.
    const cursorErr = await writeCursors(env, cursors);
    if (cursorErr) record.errors.push({ job, error: cursorErr });
    await writeRun(env, record);

    // 2. Stop the moment the governor refuses. The jobs below this one are all
    //    more expensive, so there is nothing cheaper left to fall back to.
    if (out.stopped) {
      record.status = "stopped";
      record.stoppedBy = out.reason;
      for (const later of wanted.slice(wanted.indexOf(job) + 1)) {
        record.jobs[later] = { ...record.jobs[later], status: "skipped", reason: `stopped earlier: ${out.reason}` };
        record.skipped.push(`${later}: not reached — ${out.reason}`);
      }
      break;
    }
  }

  const end = await ledger(env);
  record.cost.atEnd = end.usd;
  record.cost.spent = Number((end.usd - record.cost.atStart).toFixed(6));
  record.cost.vision = end.vision;
  if (record.status === "running") record.status = "done";
  record.next = nextSteps(record);
  record.finishedAt = new Date().toISOString();
  await writeRun(env, record);

  console.log(
    `[nightly ${day}] ${record.status}: ${record.did.join(" | ") || "nothing"} — ` +
    `spent $${record.cost.spent.toFixed(4)}, ${record.cost.vision} vision calls used tonight`
  );

  return { ok: true, ...record, ran };
}
