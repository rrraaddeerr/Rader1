/**
 * Tier 1 — the worker half of the Mac runner.
 *
 * His Mac is idle every night and already paid for. Ollama on it can caption an
 * image or summarise a transcript for nothing, which is the only reason the
 * 1,241 Instagram refs are captionable at all: at Tier 2 the vision ration is 20
 * a night, so the archive would take eleven weeks. This file hands that work out
 * and takes the answers back.
 *
 * LEASES, NOT CLAIMS. A job handed out carries a deadline and a nonce. If the
 * laptop lid closes mid-batch the lease simply lapses and the job returns to the
 * pool — nothing has to notice the crash. The nonce (`leaseId`) is what makes a
 * zombie runner harmless: a submit whose nonce doesn't match the stored one is
 * reported as `stale` and ignored, so a process that wakes up twenty minutes
 * late cannot overwrite the answer another runner already gave.
 *
 * The distinction everything hangs on, and the runner is built around it too:
 *
 *   RELEASED  our fault (Ollama down, shutting down, lease expired). Back in the
 *             pool with NO attempt recorded. Charging a ref a retry slot for our
 *             own problem is how a sleeping Mac marks a perfectly good ref
 *             permanently failed.
 *   REPORTED  the job's fault (image 404, unreadable bytes). A real attempt,
 *             recorded through the ladder's own bookkeeping so the backoff and
 *             the permanent/transient split own it from here.
 *
 * Two hard rules this file inherits:
 *   - `vision:false` on the lease charge. Local captions must NOT eat the 20/night
 *     Workers AI ration — that ration exists to stop *paid* vision, and spending
 *     it on free compute would defeat the entire point of Tier 1.
 *   - Nothing here can create a ref. Every write is a re-read-then-put of a
 *     `ref:` key that already existed.
 */

import { charge } from "./budget.js";
import { RUNGS, isBlocked, recordAttempt, stepState, levelOf } from "./ladder.js";
import { brainReady, indexRef } from "./embed.js";

/** Job kinds the Mac knows how to do. Anything else is refused at the door. */
export const LOCAL_KINDS = ["caption", "summarize"];

/** Which ladder rung each kind reports its attempt against. */
export const KIND_LEVEL = { caption: 3, summarize: 4 };

/** Lease bookkeeping. One key per outstanding job. */
export const LEASE_PREFIX = "local:lease:";
export const CURSOR_KEY = "local:cursor";

/** 15 minutes: long enough for llava on a big image, short enough to recover. */
export const DEFAULT_LEASE_SECONDS = 900;
export const MAX_LEASE_SECONDS = 3600;

/** Jobs per lease. The runner batches; the worker just refuses silly numbers. */
export const MAX_LEASE_BATCH = 50;

/** KV keys one lease may read looking for candidates. Bounded like every walk. */
const MAX_SCAN = 600;
const PAGE = 100;

/**
 * How many candidates we gather to fill a batch of `limit`. The surplus is what
 * lets `available` be a real number when the tail of the archive is in sight
 * rather than always null.
 */
const POOL_FACTOR = 3;

const short = (err) => String(err?.message ?? err).slice(0, 240);
const leaseKey = (jobId) => LEASE_PREFIX + jobId;

/**
 * Job ids are deterministic — `caption:<refId>` — on purpose.
 *
 * A random id per hand-out would let the same ref be leased twice by two
 * runners, and both would caption it. Deterministic means the lease key IS the
 * "someone is already on this" flag, and there is nothing else to keep in sync.
 */
export const jobIdFor = (kind, refId) => `${kind}:${refId}`;

/** Split a job id back apart. Ref ids contain "-", never ":", so this is safe. */
export function parseJobId(jobId) {
  const s = String(jobId || "");
  const i = s.indexOf(":");
  if (i < 1) return { kind: "", refId: "" };
  return { kind: s.slice(0, i), refId: s.slice(i + 1) };
}

// ------------------------------------------------------------- the candidates

const CAPTION_RUNG = RUNGS.find((r) => r.level === KIND_LEVEL.caption);

/**
 * An image the Mac could caption.
 *
 * Asks the LADDER's own rung rather than re-deriving the rule — `applies` (it
 * is an image), `satisfied` (no caption yet), `possible` (there are bytes
 * somewhere to fetch), and `isBlocked`, so a ref whose caption permanently
 * failed is not handed to the Mac every night for the rest of the archive's
 * life.
 *
 * What it deliberately does NOT use is `nextStep()`. That returns the CHEAPEST
 * available rung, and an image the classifier hasn't seen yet reports rung 1 —
 * free, deterministic, and something the Mac cannot do. Gating local captions on
 * it would serialise every image in the archive behind a tier-0 rung the nightly
 * only advances twenty-five refs a night: sixty-three nights before the Mac may
 * caption anything. The rungs are independent; only the LEVEL is ordered.
 */
export function captionable(ref, { now = new Date(), retry = false } = {}) {
  if (!ref || typeof ref !== "object") return false;
  if (!CAPTION_RUNG.applies(ref)) return false;
  if (CAPTION_RUNG.satisfied(ref)) return false;
  if (!CAPTION_RUNG.possible(ref)) return false;
  return !isBlocked(ref, CAPTION_RUNG.level, { now, retry });
}

/**
 * A transcript we pulled but never summarised.
 *
 * Not a rung: rung 4 counts itself satisfied once the transcript is on the ref,
 * because the transcript is the substance and the summary is a bonus. That makes
 * the summary a genuine leftover — including every ref where the governor
 * refused the summariser mid-climb and left a `summaryError` behind. Free
 * compute is exactly the right tier to mop those up with.
 */
export function summarizable(ref) {
  if (!ref || typeof ref !== "object") return false;
  return Boolean(ref.transcript) && !ref.summary;
}

/** The payload the runner needs, or null when we can't build one. */
function payloadFor(kind, ref, origin) {
  if (kind === "caption") {
    // /blob/ is public — the random key is the capability — so the runner needs
    // no token to fetch the bytes. An uploaded blob beats a remote url because
    // it can't 404 or rate-limit us.
    const imageUrl = ref.blobKey && origin ? `${origin}/blob/${ref.blobKey}` : ref.image || "";
    if (!imageUrl) return null;
    return { imageUrl, title: String(ref.title || "").slice(0, 200) };
  }
  if (kind === "summarize") {
    if (!ref.transcript) return null;
    return {
      text: String(ref.transcript).slice(0, 40000),
      title: String(ref.title || "").slice(0, 200),
      source: "transcript",
    };
  }
  return null;
}

// -------------------------------------------------------------------- the walk

/**
 * Bounded, resumable walk of `ref:` keys collecting lease candidates.
 *
 * Returns `{refs, error}` rather than a bare array: an unreachable KV and a
 * drained pool are the same empty list otherwise, and the runner prints "nothing
 * left to do" for one of those and "the worker is broken" for the other.
 *
 * Same half-page rule as cron.js and ladder.js — when we stop mid-page we hand
 * back the cursor we came IN with, because resuming mid-page is impossible and
 * re-reading it is the only way not to skip its tail.
 */
async function walkCandidates(env, { cursor = null, want, maxScan = MAX_SCAN, pick }) {
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
      return { refs, scanned, unreadable, cursor: from ?? null, done: false, error: `list: ${short(err)}` };
    }

    let filled = false;
    for (const k of page.keys) {
      scanned++;
      let ref = null;
      try {
        ref = await env.REFS_KV.get(k.name, "json");
      } catch {
        unreadable++;
        continue;
      }
      if (!ref?.id) { unreadable++; continue; }
      const kind = pick(ref);
      if (!kind) continue;
      refs.push({ ref, kind });
      if (refs.length >= want) { filled = true; break; }
    }

    if (filled) return { refs, scanned, unreadable, cursor: from ?? null, done: false, error: null };
    if (page.list_complete) return { refs, scanned, unreadable, cursor: null, done: true, error: null };
    kvCursor = page.cursor;
  }

  return { refs, scanned, unreadable, cursor: kvCursor ?? null, done: false, error: null };
}

/** Is someone already working this job? An expired lease is not someone. */
async function activeLease(env, jobId, now) {
  try {
    const held = await env.REFS_KV.get(leaseKey(jobId), "json");
    if (!held) return { held: null, error: null };
    const expired = Date.parse(held.expiresAt || "") <= now.getTime();
    return { held: expired ? null : held, error: null };
  } catch (err) {
    // We could not tell whether this job is taken. Handing it out anyway risks
    // two runners captioning the same image; skipping it costs one job. Skip,
    // and say so — a lease pass full of these is a KV problem, not a drained
    // pool, and those must never look the same.
    return { held: null, error: `couldn't read the lease for ${jobId}: ${short(err)}` };
  }
}

// ------------------------------------------------------------------- the lease

/**
 * Hand out work.
 *
 * @param {object} env
 * @param {object} [opts]
 * @param {string}   [opts.runner]  a name, for the record only
 * @param {number}   [opts.limit]   how many jobs. 0 is a legal ping.
 * @param {string[]} [opts.kinds]   subset of LOCAL_KINDS
 * @param {number}   [opts.leaseSeconds]
 * @param {string}   [opts.origin]  this worker's origin, for /blob/ urls
 * @returns {Promise<{ok:boolean, jobs:Array, available:number|null,
 *   scanned:number, done:boolean, errors:Array, error:string|null}>}
 */
export async function leaseJobs(env, {
  runner = "",
  limit = 8,
  kinds,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  origin = "",
  now = new Date(),
  maxScan = MAX_SCAN,
  retry = false,
} = {}) {
  const errors = [];
  const blank = { ok: false, jobs: [], available: null, scanned: 0, done: false, errors, error: null };

  if (!env?.REFS_KV) return { ...blank, error: "REFS_KV not bound — there is no pool to lease from" };

  const want = Math.max(0, Math.min(Number(limit) || 0, MAX_LEASE_BATCH));
  const ttl = Math.max(60, Math.min(Number(leaseSeconds) || DEFAULT_LEASE_SECONDS, MAX_LEASE_SECONDS));
  const wanted = (Array.isArray(kinds) && kinds.length ? kinds : LOCAL_KINDS)
    .map(String)
    .filter((k) => LOCAL_KINDS.includes(k));

  if (!wanted.length) {
    return { ...blank, error: `kinds must be some of: ${LOCAL_KINDS.join(", ")}` };
  }
  // limit:0 is the runner's ping. Answering it without touching KV is the point.
  if (!want) return { ...blank, ok: true, available: null, done: false };

  const pick = (ref) => {
    if (wanted.includes("caption") && captionable(ref, { now, retry })) return "caption";
    if (wanted.includes("summarize") && summarizable(ref)) return "summarize";
    return "";
  };

  // The cursor walks the archive across successive leases. Without it every
  // lease re-reads the same head of the 1,578 and the tail is never reached.
  let cursor = null;
  try {
    const stored = await env.REFS_KV.get(CURSOR_KEY, "json");
    if (stored && typeof stored.cursor === "string") cursor = stored.cursor;
  } catch (err) {
    errors.push({ stage: "kv", error: `couldn't read the lease cursor, starting from the newest refs: ${short(err)}` });
  }

  const walk = await walkCandidates(env, { cursor, want: want * POOL_FACTOR, maxScan, pick });
  if (walk.error) {
    return { ...blank, scanned: walk.scanned, error: walk.error };
  }

  // Drop the ones another runner already holds.
  const free = [];
  for (const cand of walk.refs) {
    const jobId = jobIdFor(cand.kind, cand.ref.id);
    const { held, error } = await activeLease(env, jobId, now);
    if (error) { errors.push({ stage: "lease", error }); continue; }
    if (held) continue;
    free.push({ ...cand, jobId });
  }

  const take = free.slice(0, want);

  // Charge BEFORE writing any lease. Tier 1 costs nothing, so this never
  // refuses on price — it books the work so the ledger and the morning brief
  // can say the Mac did 400 captions tonight. `vision:false` is load-bearing:
  // see the header.
  if (take.length) {
    const booked = await charge(env, { tier: 1, units: take.length, vision: false, label: `local-lease${runner ? `:${runner}` : ""}` });
    if (!booked.ok) {
      return { ...blank, scanned: walk.scanned, done: walk.done, error: `the governor refused the lease: ${booked.reason}` };
    }
  }

  const jobs = [];
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
  for (const { ref, kind, jobId } of take) {
    const payload = payloadFor(kind, ref, origin);
    if (!payload) continue; // nothing to send; the candidate filters shouldn't allow this
    const leaseId = crypto.randomUUID();
    const record = { jobId, leaseId, kind, refId: ref.id, runner, leasedAt: now.toISOString(), expiresAt };
    try {
      // expirationTtl is belt and braces — the submit path checks `expiresAt`
      // itself, because a lease that outlives its key would silently accept a
      // zombie's answer.
      await env.REFS_KV.put(leaseKey(jobId), JSON.stringify(record), { expirationTtl: ttl + 300 });
    } catch (err) {
      errors.push({ stage: "lease", refId: ref.id, error: `couldn't write the lease: ${short(err)}` });
      continue;
    }
    jobs.push({
      jobId,
      leaseId,
      kind,
      refId: ref.id,
      level: KIND_LEVEL[kind],
      leaseExpiresAt: expiresAt,
      attempts: stepState(ref, KIND_LEVEL[kind])?.attempts || 0,
      payload,
    });
  }

  // Advance only when we actually consumed the stretch we walked. Rewinding to
  // the start of a page we half-read would hand the same refs out forever.
  try {
    await env.REFS_KV.put(CURSOR_KEY, JSON.stringify({ cursor: walk.done ? null : walk.cursor, at: now.toISOString() }));
  } catch (err) {
    errors.push({ stage: "kv", error: `couldn't save the lease cursor: ${short(err)}` });
  }

  return {
    ok: true,
    jobs,
    // A number only when we can stand behind it. We stopped walking at
    // `want * POOL_FACTOR`, so unless the walk reached the end of the archive
    // "how many are left" is genuinely unknown — and a made-up progress number
    // is worse than none. The runner prints nothing for null.
    available: walk.done ? Math.max(0, free.length - jobs.length) : null,
    scanned: walk.scanned,
    unreadable: walk.unreadable,
    done: walk.done,
    errors,
    error: null,
  };
}

// ------------------------------------------------------------------ the submit

/**
 * Take answers, failures and hand-backs — in one call, deliberately.
 *
 * A runner that submits its successes and then dies before releasing the rest
 * has stranded them for a whole lease period. One call means the batch is
 * atomic from the runner's side, which is the most we can offer it.
 *
 * @param {object} env
 * @param {object} body  `{runner, results[], release[]}` — see the runner
 * @returns {Promise<{ok:boolean, applied:number, recorded:number, released:number,
 *   stale:Array, errors:Array, error:string|null}>}
 */
export async function submitResults(env, { runner = "", results = [], release = [], now = new Date(), reindex = true } = {}) {
  const out = { ok: false, applied: 0, recorded: 0, released: 0, stale: [], errors: [], error: null };
  if (!env?.REFS_KV) return { ...out, error: "REFS_KV not bound — nothing to write results to" };
  if (!Array.isArray(results) || !Array.isArray(release)) {
    return { ...out, error: "expected results[] and release[]" };
  }

  for (const res of results) {
    const claim = await verify(env, res, now);
    if (!claim.ok) { out.stale.push({ jobId: res?.jobId || "", why: claim.why }); continue; }
    const applied = await applyResult(env, claim.lease, res, { now, reindex, runner });
    out.errors.push(...applied.errors);
    if (applied.changed) out.applied++;
    if (applied.recorded) out.recorded++;
    await drop(env, claim.lease.jobId, out.errors);
  }

  for (const rel of release) {
    const claim = await verify(env, rel, now);
    if (!claim.ok) { out.stale.push({ jobId: rel?.jobId || "", why: claim.why }); continue; }
    // A release records NOTHING on the ref. That is the whole distinction: the
    // job comes back untouched, with its retry budget intact, because the
    // runner's laptop is not the ref's fault.
    await drop(env, claim.lease.jobId, out.errors);
    out.released++;
  }

  out.ok = true;
  return out;
}

/** Is this submission holding the current lease for its job? */
async function verify(env, item, now) {
  const jobId = String(item?.jobId || "");
  const leaseId = String(item?.leaseId || "");
  if (!jobId || !leaseId) return { ok: false, why: "no jobId/leaseId on the submission" };

  let lease;
  try {
    lease = await env.REFS_KV.get(leaseKey(jobId), "json");
  } catch (err) {
    return { ok: false, why: `couldn't read the lease: ${short(err)}` };
  }
  if (!lease) return { ok: false, why: "lease expired" };
  if (lease.leaseId !== leaseId) return { ok: false, why: "another runner holds this job" };
  if (Date.parse(lease.expiresAt || "") <= now.getTime()) return { ok: false, why: "lease expired" };
  return { ok: true, lease };
}

async function drop(env, jobId, errors) {
  try {
    await env.REFS_KV.delete(leaseKey(jobId));
  } catch (err) {
    // Cosmetic: the lease will lapse on its own TTL. Worth saying, never worth
    // failing a submitted caption over.
    errors.push({ stage: "lease", jobId, error: `couldn't clear the lease: ${short(err)}` });
  }
}

/**
 * Write one runner answer onto its ref.
 *
 * Re-read, merge, put — the same shape as ladder.climb(), and for the same
 * reason: the Mac may have held this job for fifteen minutes and a ref he edited
 * on his phone in the meantime must not be clobbered by the copy we handed out.
 * A key that vanished is dropped rather than resurrected, which is also what
 * makes it impossible for a submit to create a ref.
 */
async function applyResult(env, lease, res, { now, reindex, runner }) {
  const errors = [];
  const level = KIND_LEVEL[lease.kind] ?? 0;
  const key = `ref:${lease.refId}`;

  let current;
  try {
    current = await env.REFS_KV.get(key, "json");
  } catch (err) {
    errors.push({ stage: "kv", refId: lease.refId, error: `re-read failed, result dropped: ${short(err)}` });
    return { changed: false, recorded: false, errors };
  }
  if (!current) {
    errors.push({ stage: "kv", refId: lease.refId, error: "ref was deleted while the runner worked on it" });
    return { changed: false, recorded: false, errors };
  }

  const ok = Boolean(res?.ok);
  const patch = {};
  let note = "";

  if (ok) {
    if (lease.kind === "caption") {
      const caption = String(res?.result?.caption || "").trim();
      if (!caption) {
        // "ok with nothing in it" is a runner bug, and it must not be recorded
        // as a success — that would satisfy the rung forever with no caption.
        return finishFailure(env, key, current, level, {
          reason: "runner reported success with an empty caption",
          permanent: false,
          now, errors, res, runner,
        });
      }
      patch.caption = caption.slice(0, 2000);
      patch.enrichKind = "local-vision";
      note = `caption ${patch.caption.length} chars`;
    } else if (lease.kind === "summarize") {
      const summary = String(res?.result?.summary || "").trim();
      if (!summary) {
        return finishFailure(env, key, current, level, {
          reason: "runner reported success with an empty summary",
          permanent: false,
          now, errors, res, runner,
        });
      }
      patch.summary = summary.slice(0, 900);
      // The governor may have left one of these behind when it refused the
      // Tier 2 summariser mid-climb. It is answered now.
      if (current.summaryError) patch.summaryError = "";
      note = `summary ${patch.summary.length} chars`;
    }
    patch.localModel = String(res?.model || "").slice(0, 80);
    patch.localAt = now.toISOString();
  }

  const ladder = recordAttempt(current, level, {
    ok,
    reason: ok ? note : String(res?.error || "the runner did not say why").slice(0, 240),
    // The runner is the only thing that saw the failure, so its verdict on
    // whether it can ever succeed is the one we honour.
    permanent: Boolean(res?.permanent),
    now,
  });

  const merged = { ...current, ...patch, ladder };
  merged.ladder = { ...ladder, level: levelOf(merged) };

  try {
    await env.REFS_KV.put(key, JSON.stringify(merged));
  } catch (err) {
    errors.push({ stage: "kv", refId: lease.refId, error: `write failed, the runner's work is lost: ${short(err)}` });
    return { changed: false, recorded: false, errors };
  }

  // A caption IS in embedTextFor(), so the stored vector no longer describes
  // this ref. A summary is NOT — do not pay to re-embed one. The embed is
  // Tier 2 and gets its own charge; a refusal flags the ref rather than leaving
  // a silently stale vector, which is the hardest kind of wrong to notice.
  if (ok && lease.kind === "caption" && reindex && brainReady(env)) {
    const bill = await charge(env, { tier: 2, units: 1, label: "local-reindex" });
    if (!bill.ok) {
      await flag(env, key, { embedDirty: true });
      errors.push({ stage: "embed", refId: lease.refId, error: `reindex not booked: ${bill.reason}` });
    } else if (await indexRef(env, merged)) {
      if (merged.embedDirty) await flag(env, key, { embedDirty: false });
    } else {
      // indexRef swallows its own failure and returns false. Saying so out loud
      // is the difference between "the index is stale for this ref" and "there
      // was nothing to reindex".
      await flag(env, key, { embedDirty: true });
      errors.push({ stage: "embed", refId: lease.refId, error: "indexRef returned false — the embed or the upsert failed" });
    }
  }

  return { changed: ok, recorded: !ok, errors };
}

/** A "success" we refuse to believe becomes a recorded transient failure. */
async function finishFailure(env, key, current, level, { reason, permanent, now, errors, res, runner }) {
  const ladder = recordAttempt(current, level, { ok: false, reason, permanent, now });
  const merged = { ...current, ladder };
  merged.ladder = { ...ladder, level: levelOf(merged) };
  try {
    await env.REFS_KV.put(key, JSON.stringify(merged));
  } catch (err) {
    errors.push({ stage: "kv", refId: current.id, error: `write failed: ${short(err)}` });
    return { changed: false, recorded: false, errors };
  }
  errors.push({ stage: "runner", refId: current.id, error: `${runner || "runner"}: ${reason}`, jobId: res?.jobId || "" });
  return { changed: false, recorded: true, errors };
}

/** Tiny follow-up write. Re-reads so it can't resurrect a deleted ref either. */
async function flag(env, key, patch) {
  try {
    const cur = await env.REFS_KV.get(key, "json");
    if (!cur) return;
    await env.REFS_KV.put(key, JSON.stringify({ ...cur, ...patch }));
  } catch {
    // The result itself is already banked and the caller already has the error.
  }
}

/**
 * What the pool looks like right now, for /health and the morning brief.
 *
 * Bounded — it reads at most `maxScan` keys — and it says so, because "42
 * captions waiting" and "42 in the first 600 keys we looked at" are different
 * facts and only one of them is a finish line.
 */
export async function localStatus(env, { maxScan = MAX_SCAN, now = new Date() } = {}) {
  if (!env?.REFS_KV) return { ok: false, error: "REFS_KV not bound" };
  const counts = { caption: 0, summarize: 0 };
  const walk = await walkCandidates(env, {
    want: Infinity,
    maxScan,
    pick: (ref) => {
      if (captionable(ref, { now })) return "caption";
      if (summarizable(ref)) return "summarize";
      return "";
    },
  });
  for (const { kind } of walk.refs) counts[kind]++;

  let leased = 0;
  try {
    let cursor;
    do {
      const page = await env.REFS_KV.list({ prefix: LEASE_PREFIX, limit: 1000, cursor });
      leased += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch (err) {
    return { ok: true, waiting: counts, leased: null, scanned: walk.scanned, complete: walk.done, error: `couldn't count leases: ${short(err)}` };
  }

  return {
    ok: true,
    waiting: counts,
    leased,
    scanned: walk.scanned,
    // The one field that stops `waiting` from being read as a total.
    complete: walk.done,
    error: walk.error,
  };
}
