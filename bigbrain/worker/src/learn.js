/**
 * Loop 2 — learning his judgment from the swipe queue.
 *
 * Every decision in stage.js is training signal that was being thrown away.
 * Approve, reject, skip and especially EDIT (he changed the realm before saying
 * yes) each say something about what he would have said yes to. This file is
 * the memory: it records the outcome of a swipe, aggregates it, and hands the
 * generators a reason to ask fewer, better questions next week.
 *
 * The stated goal is that he swipes LESS each week, not more. That only works
 * if the system is willing to stop asking — so a generator he keeps rejecting
 * gets suppressed, and a source whose proposals he keeps taking gets more rope.
 *
 * Three things this file is deliberately paranoid about:
 *
 * 1. SMALL SAMPLES ARE NOT EVIDENCE. Two approvals is not a 100% acceptance
 *    rate, it is two swipes. Every rate here carries its sample count, and
 *    every rate that *drives a decision* goes through a Wilson interval first,
 *    shrunk toward a coin flip. If the interval straddles 0.5 the answer is
 *    "we don't know yet" and nothing moves. Under-confident on purpose.
 *
 * 2. SUPPRESSION MUST BE RECOVERABLE. A permanently silenced generator can
 *    never produce the evidence that would prove it improved — it just dies
 *    quietly with its old reputation. See shouldSuppress().
 *
 * 3. NOTHING HERE APPLIES ANYTHING. Learning changes the *confidence* on a
 *    proposal and whether it gets queued at all. A proposal is still a
 *    proposal, still waiting for his thumb. Rules 1 and 2 are untouched.
 *
 * Storage: one compact outcome per queue item (`learn:out:<queueId>`) plus an
 * incrementally-maintained rollup (`learn:rollup`) so acceptance() is a single
 * read instead of a scan. Keying an outcome by queue id — not by timestamp — is
 * what makes re-deciding an item replace its outcome instead of double-counting
 * it, and what makes an undo (`reopen`) a clean retraction.
 */

import { charge, dayStamp } from "./budget.js";

const OUT_PREFIX = "learn:out:";
const ROLLUP_KEY = "learn:rollup";
const ROLLUP_VERSION = 1;

/** The dimensions we aggregate over. Order is the order they're reported in. */
export const DIMENSIONS = ["kind", "source", "axis", "realm"];

/** Below this many decided swipes, a rate is a rumour — reported, never trusted. */
export const MIN_SAMPLE = 8;

/** Suppression is a bigger claim than a confidence nudge, so it costs more evidence. */
export const SUPPRESS_MIN_SAMPLE = 12;

/**
 * Suppress only when even the *optimistic* end of the interval is this bad.
 * Using the upper bound rather than the observed rate is the whole point: it
 * takes a sustained run of rejections, not a bad night, to silence a generator.
 */
export const SUPPRESS_MAX_RATE = 0.25;

/** Roughly one suppressed pass in ten still runs. See shouldSuppress(). */
export const PROBE_RATE = 0.1;

/** A learned realm mapping needs this many approvals on the same source+realm. */
export const MOVE_MIN_SAMPLE = 5;

/** How far learning may move a proposal's confidence, in total. */
export const MAX_DELTA = 0.3;

/**
 * How much each dimension is allowed to contribute. Kind leads because it's
 * the coarsest and best-sampled signal; axis and realm are the same ref seen
 * from two angles, so neither gets to dominate on its own.
 */
export const DIM_WEIGHT = { kind: 0.5, source: 0.3, axis: 0.2, realm: 0.2 };

/** 95% interval. Not tuned — it's the conventional one, and it's honest. */
const Z = 1.96;

const CONF_FLOOR = 0.05;
const CONF_CEIL = 0.95;

/** A rebuild walks every outcome; bounded so it can't eat a request. */
const REBUILD_MAX = 5000;

const msg = (err) => String(err?.message ?? err).slice(0, 240);
const clampCount = (n) => Math.max(0, Math.round(n));
const round = (n, dp = 3) => Number(n.toFixed(dp));

// --------------------------------------------------------------- statistics

/**
 * Wilson score interval for a binomial proportion. Pure arithmetic, no deps.
 *
 * This is the one piece of maths in the file and it earns its place: it is the
 * difference between "he accepted 2 of 2, so 100%" and "he accepted 2 of 2, so
 * somewhere between 34% and 100%". The second one is true.
 *
 * @returns {{p:number, lower:number, upper:number}} lower/upper are 0..1
 */
export function wilson(approved, n, z = Z) {
  if (!(n > 0)) return { p: 0, lower: 0, upper: 1 };
  const p = approved / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    p,
    lower: Math.max(0, (centre - spread) / d),
    upper: Math.min(1, (centre + spread) / d),
  };
}

/**
 * The rate we're willing to act on: the interval shrunk toward a coin flip.
 *
 * Above 0.5 we use the lower bound, below 0.5 the upper bound — so both a
 * bonus and a penalty are the most cautious reading of the same data. If the
 * interval straddles 0.5 this returns exactly 0.5, which means "no adjustment",
 * which is the correct answer for a handful of swipes.
 */
export function conservativeRate(approved, n) {
  if (!(n > 0)) return 0.5;
  const { p, lower, upper } = wilson(approved, n);
  return p >= 0.5 ? Math.max(0.5, lower) : Math.min(0.5, upper);
}

// ------------------------------------------------------------- the counters

function emptyBucket() {
  return { approved: 0, rejected: 0, skipped: 0, edited: 0 };
}

function emptyRollup() {
  return {
    v: ROLLUP_VERSION,
    updatedAt: "",
    totals: emptyBucket(),
    kind: {},
    source: {},
    axis: {},
    realm: {},
    // source -> proposed realm -> { kept, to: { chosen realm: n } }
    moves: {},
  };
}

/** Defensive: a hand-built or half-written rollup must not throw on read. */
function normalizeRollup(raw = {}) {
  const out = emptyRollup();
  out.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : "";
  out.totals = { ...emptyBucket(), ...(raw.totals || {}) };
  for (const dim of DIMENSIONS) {
    for (const [key, bucket] of Object.entries(raw[dim] || {})) {
      out[dim][key] = { ...emptyBucket(), ...(bucket || {}) };
    }
  }
  for (const [source, froms] of Object.entries(raw.moves || {})) {
    out.moves[source] = {};
    for (const [from, rec] of Object.entries(froms || {})) {
      out.moves[source][from] = { kept: rec?.kept || 0, to: { ...(rec?.to || {}) } };
    }
  }
  return out;
}

function bump(bucket, field, sign) {
  bucket[field] = clampCount((bucket[field] || 0) + sign);
}

/**
 * Fold one outcome into the counters. `sign` is +1 to record, -1 to retract.
 *
 * Counters are clamped at zero: retracting an outcome we never counted (a
 * rollup rebuilt after the outcome log was trimmed, say) must not push a count
 * negative, because a negative count makes every rate downstream a lie.
 */
function applyOutcome(roll, o, sign) {
  const field = o.action;
  if (!["approved", "rejected", "skipped"].includes(field)) return;

  bump(roll.totals, field, sign);
  if (o.edited) bump(roll.totals, "edited", sign);

  for (const dim of DIMENSIONS) {
    const key = o[dim];
    if (!key) continue;
    roll[dim][key] ||= emptyBucket();
    bump(roll[dim][key], field, sign);
    if (o.edited) bump(roll[dim][key], "edited", sign);
  }

  // Realm moves only mean anything on an approval: a rejection tells us the
  // proposal was wrong, not what the right answer would have been.
  if (field === "approved" && o.realm) {
    const source = o.source || "unknown";
    roll.moves[source] ||= {};
    roll.moves[source][o.realm] ||= { kept: 0, to: {} };
    const rec = roll.moves[source][o.realm];
    if (o.to) rec.to[o.to] = clampCount((rec.to[o.to] || 0) + sign);
    else rec.kept = clampCount(rec.kept + sign);
  }
}

// ----------------------------------------------------------------- outcomes

const ACTIONS = {
  approve: "approved",
  approved: "approved",
  reject: "rejected",
  rejected: "rejected",
  skip: "skipped",
  skipped: "skipped",
  reopen: "reopen",
};

/** Set comparison, order-insensitive — tag order is not a taste judgment. */
function sameTags(a, b) {
  const A = [...new Set((Array.isArray(a) ? a : []).map((t) => String(t).toLowerCase()))].sort();
  const B = [...new Set((Array.isArray(b) ? b : []).map((t) => String(t).toLowerCase()))].sort();
  return A.length === B.length && A.every((t, i) => t === B[i]);
}

/**
 * The compact record. Deliberately not the item: no title, no url, no why, no
 * tags. Those are already in the queue entry, and a second copy of 1,578 refs'
 * worth of text is a KV bill for data we'd never read.
 */
function outcomeFrom(item, action, edits) {
  const p = item.proposal || {};
  const from = String(p.realm || "");
  const chosen =
    action === "approved" && edits && typeof edits.realm === "string" && edits.realm
      ? edits.realm
      : "";
  const retitled =
    edits && typeof edits.proposedTitle === "string" && edits.proposedTitle !== (p.proposedTitle || "");
  // The swipe UI sends the card's tags back whether or not he touched them, so
  // "there was a tags array" is not an edit. Only a different set is.
  const retagged = Array.isArray(edits?.tags) && sameTags(edits.tags, p.tags) === false;
  const edited =
    action === "approved" && Boolean((chosen && chosen !== from) || retagged || retitled);

  return {
    id: item.id,
    ts: Date.now(),
    kind: item.kind || "",
    source: item.source || "",
    axis: p.axis || "",
    // The realm as PROPOSED — that's the thing being judged. What he changed it
    // to lives in `to`.
    realm: from,
    action,
    edited,
    to: chosen && chosen !== from ? chosen : "",
    confidence: typeof p.confidence === "number" ? p.confidence : null,
  };
}

/**
 * Record one decision.
 *
 * CALL THIS BEFORE decide() APPLIES ITS EDITS. decide() writes `edits.realm`
 * straight onto `item.proposal.realm`, so once it has run the original realm is
 * gone and the strongest signal in the system — that he changed INSPO to
 * KNOWLEDGE — is unrecoverable. Called early, `item.proposal.realm` is still
 * what we asked him and `edits.realm` is still what he answered.
 *
 * Never throws: a swipe must not fail because the learner did. It returns
 * `{ok, error}` instead, and the caller is expected to pass that through so a
 * broken learner is visible rather than a silent no-op.
 *
 * @param {object} env
 * @param {object} item   the queue item, pre-mutation
 * @param {{action:string, edits?:object}} decision
 * @returns {Promise<{ok:boolean, recorded:boolean, action:string, error:string|null}>}
 */
export async function recordOutcome(env, item, { action, edits } = {}) {
  const nil = { ok: false, recorded: false, action: "", error: null };
  if (!env?.REFS_KV) return { ...nil, error: "no KV binding — decisions are not being learned from" };
  if (!item || typeof item !== "object" || !item.id) return { ...nil, error: "not a queue item" };

  const act = ACTIONS[String(action || item.status || "")];
  if (!act) return { ...nil, error: `unknown action "${action}"` };

  const key = OUT_PREFIX + item.id;

  // What we already counted for this item, if anything. Re-deciding a card
  // (skip today, approve tomorrow) must replace its outcome, not add to it.
  let prior = null;
  try {
    prior = await env.REFS_KV.get(key, "json");
  } catch (err) {
    return { ...nil, action: act, error: `couldn't read the prior outcome: ${msg(err)}` };
  }

  const read = await readRollup(env);
  // A rollup we can't read must not be overwritten with a fresh one — that
  // would silently delete every swipe he has ever made. Refuse, loudly.
  if (read.error) return { ...nil, action: act, error: read.error };
  const roll = read.rollup;

  const next = act === "reopen" ? null : outcomeFrom(item, act, edits);

  if (prior?.action) applyOutcome(roll, prior, -1);
  if (next) applyOutcome(roll, next, +1);
  roll.updatedAt = new Date().toISOString();

  try {
    if (next) await env.REFS_KV.put(key, JSON.stringify(next));
    else await env.REFS_KV.delete(key);
    await env.REFS_KV.put(ROLLUP_KEY, JSON.stringify(roll));
  } catch (err) {
    return { ...nil, action: act, error: `couldn't write the outcome: ${msg(err)}` };
  }

  return {
    ok: true,
    // A reopen retracts rather than records — worth distinguishing in a log.
    recorded: Boolean(next),
    retracted: Boolean(prior?.action),
    action: act,
    error: null,
  };
}

// ------------------------------------------------------------- aggregation

/**
 * One dimension's numbers, with the sample count welded on.
 *
 * `rate` is null — not 0 — when nothing has been decided. Those are completely
 * different facts and collapsing them is how a dashboard starts lying.
 *
 * Skips are counted but kept OUT of the rate's denominator. A skip is "not
 * now", not "no"; folding it into rejections would make a queue he swipes
 * lazily look like a queue full of bad proposals.
 */
function cell(bucket = {}) {
  const approved = bucket.approved || 0;
  const rejected = bucket.rejected || 0;
  const skipped = bucket.skipped || 0;
  const edited = bucket.edited || 0;
  const n = approved + rejected;
  const { lower, upper } = wilson(approved, n);
  return {
    approved,
    rejected,
    skipped,
    edited,
    n,
    decisions: n + skipped,
    rate: n ? round(approved / n) : null,
    lower: round(lower),
    upper: round(upper),
    conservative: round(conservativeRate(approved, n)),
    editRate: approved ? round(edited / approved) : null,
    // The flag every consumer should be reading before it believes `rate`.
    confident: n >= MIN_SAMPLE,
  };
}

function mapCells(dim) {
  const out = {};
  for (const [key, bucket] of Object.entries(dim || {})) out[key] = cell(bucket);
  return out;
}

/**
 * Turn raw counters into reportable stats. PURE — this is the half that unit
 * tests can drive with a hand-built counter object and no KV at all.
 *
 * @param {object} counters  a rollup (partial is fine)
 * @returns {object} stats, the shape scoreProposalWith() and shouldSuppress() read
 */
export function summarize(counters = {}) {
  const roll = normalizeRollup(counters);
  const moves = [];

  for (const [source, froms] of Object.entries(roll.moves)) {
    for (const [from, rec] of Object.entries(froms)) {
      const kept = rec.kept || 0;
      const changed = Object.values(rec.to).reduce((a, b) => a + b, 0);
      const total = kept + changed;
      for (const [to, n] of Object.entries(rec.to)) {
        const { lower, upper } = wilson(n, total);
        moves.push({
          source,
          from,
          to,
          moves: n,
          kept,
          n: total,
          rate: total ? round(n / total) : null,
          lower: round(lower),
          upper: round(upper),
          // Two swipes agreeing is a coincidence. This is the flag that says
          // "you may act on this", and it wants both a sample and an interval
          // that excludes a coin flip.
          confident: total >= MOVE_MIN_SAMPLE && lower >= 0.5,
        });
      }
    }
  }
  moves.sort((a, b) => b.moves - a.moves || b.n - a.n);

  const totals = cell(roll.totals);
  return {
    ok: true,
    error: null,
    updatedAt: roll.updatedAt,
    totals,
    decisions: totals.decisions,
    byKind: mapCells(roll.kind),
    bySource: mapCells(roll.source),
    byAxis: mapCells(roll.axis),
    byRealm: mapCells(roll.realm),
    moves,
    // Reported so a caller can say "learned from 40 swipes" instead of
    // implying the machine has an opinion.
    enough: totals.n >= MIN_SAMPLE,
  };
}

async function readRollup(env) {
  try {
    const stored = await env.REFS_KV.get(ROLLUP_KEY, "json");
    if (!stored) return { rollup: emptyRollup(), error: null, missing: true, stale: false };
    if (stored.v !== ROLLUP_VERSION) {
      // A shape we don't understand is not data we can add to. Rebuild from the
      // outcome log rather than guessing at it.
      return { rollup: emptyRollup(), error: null, missing: true, stale: true };
    }
    return { rollup: normalizeRollup(stored), error: null, missing: false, stale: false };
  } catch (err) {
    return { rollup: emptyRollup(), error: `couldn't read the rollup: ${msg(err)}`, missing: true, stale: false };
  }
}

/**
 * Walk every stored outcome and rebuild the counters from scratch.
 *
 * The rollup is a cache of the outcome log, and this is the thing that proves
 * it. Bounded and it says when it truncated — a rollup built from the first
 * 5,000 of 6,000 outcomes is wrong, and wrong-and-silent is the failure mode
 * this codebase keeps paying for.
 */
async function rebuildRollup(env) {
  const roll = emptyRollup();
  const errors = [];
  let cursor;
  let scanned = 0;
  let unreadable = 0;
  let truncated = false;

  // Tier 0 and free, but the ledger is the only place that knows what tonight
  // has done, so a full pass still books itself. A ledger we can't write must
  // not stop deterministic work — note it and carry on.
  const booked = await charge(env, { tier: 0, units: 1, label: "learn-rebuild" });
  if (!booked.ok) errors.push({ stage: "budget", error: booked.reason });

  do {
    let page;
    try {
      page = await env.REFS_KV.list({ prefix: OUT_PREFIX, limit: 1000, cursor });
    } catch (err) {
      return { rollup: roll, scanned, unreadable, truncated, errors, fatal: `couldn't list outcomes: ${msg(err)}` };
    }
    for (const k of page.keys) {
      if (scanned >= REBUILD_MAX) { truncated = true; break; }
      scanned++;
      let o = null;
      try {
        o = await env.REFS_KV.get(k.name, "json");
      } catch (err) {
        errors.push({ key: k.name, error: msg(err) });
        continue;
      }
      if (!o?.action) { unreadable++; continue; }
      applyOutcome(roll, o, +1);
    }
    cursor = page.list_complete || truncated ? undefined : page.cursor;
  } while (cursor);

  roll.updatedAt = new Date().toISOString();
  try {
    await env.REFS_KV.put(ROLLUP_KEY, JSON.stringify(roll));
  } catch (err) {
    errors.push({ stage: "write", error: `couldn't save the rebuilt rollup: ${msg(err)}` });
  }
  return { rollup: roll, scanned, unreadable, truncated, errors, fatal: null };
}

/**
 * The aggregate signal: acceptance per generator kind, per proposal source, per
 * taste axis, per realm — every rate carrying its sample count.
 *
 * Normally one KV read. Pass `{rebuild:true}` (or arrive with no rollup) and it
 * replays the outcome log instead.
 *
 * Failure is never an empty result: a stats object that couldn't be read comes
 * back with `ok:false` and an `error`, so a caller can tell "he has approved
 * nothing" apart from "KV is down".
 *
 * @returns {Promise<object>} stats + {ok, error, source, debug}
 */
export async function acceptance(env, { rebuild = false } = {}) {
  const blank = summarize(emptyRollup());
  if (!env?.REFS_KV) {
    return { ...blank, ok: false, error: "no KV binding", source: "none" };
  }

  const read = await readRollup(env);
  if (read.error) return { ...blank, ok: false, error: read.error, source: "error" };

  if (!rebuild && !read.missing) {
    return { ...summarize(read.rollup), ok: true, error: null, source: "rollup" };
  }

  const rb = await rebuildRollup(env);
  if (rb.fatal) return { ...blank, ok: false, error: rb.fatal, source: "error", debug: rb.errors };

  return {
    ...summarize(rb.rollup),
    ok: true,
    error: rb.truncated ? `only the first ${REBUILD_MAX} outcomes were read — these rates are partial` : null,
    source: read.stale ? "rebuilt (old rollup shape)" : "rebuilt",
    debug: { scanned: rb.scanned, unreadable: rb.unreadable, truncated: rb.truncated, errors: rb.errors },
  };
}

// -------------------------------------------------------------- the edits

/**
 * What he actually does with a proposal from this source that says `from`.
 *
 * His edits are the strongest signal in the system. A rejection says "wrong";
 * an edit says "wrong, and here is right" — and if he changes INSPO to
 * KNOWLEDGE on newsletter proposals four times running, that is a mapping the
 * generator should have known.
 *
 * Returns the dominant move or null. `confident` is the only field a caller
 * should branch on; the rest is there so the card can say why.
 */
export function learnedRealm(stats, source, from) {
  if (!stats?.moves?.length || !from) return null;
  const candidates = stats.moves.filter((m) => m.from === from && (!source || m.source === source));
  if (!candidates.length) return null;
  return candidates.reduce((best, m) => (m.moves > best.moves ? m : best), candidates[0]);
}

// -------------------------------------------------------------- suppression

/**
 * Should this generator stop queueing?
 *
 * Two gates, both conservative:
 *   - a real sample (SUPPRESS_MIN_SAMPLE decided swipes, skips excluded)
 *   - even the optimistic end of the interval below SUPPRESS_MAX_RATE
 *
 * And then a door left open. Roughly one pass in ten runs anyway, as a probe.
 *
 * That probe is the important part. A generator that is silenced permanently
 * can never produce another decision, so its acceptance rate is frozen at
 * whatever it was on the day it died — it cannot prove it improved, even after
 * the code behind it is fixed, because nothing it makes ever reaches him again.
 * The probe costs him about one swipe in ten of what he was already ignoring,
 * and it is the only mechanism by which suppression is reversible.
 *
 * PURE, and deliberately deterministic. The roll defaults to a hash of the day
 * plus the kind rather than Math.random(): a suppressed generator still probes
 * on roughly one night in ten, but WHICH nights are fixed. That matters for
 * three reasons — the nightly log becomes explicable after the fact ("why did
 * tag run last Tuesday?"), a run that dies and resumes makes the same decisions
 * it would have made, and the whole pipeline is testable end to end instead of
 * flaking. Randomness here bought nothing and cost reproducibility.
 *
 * `roll` stays injectable so a test can pin either side of the threshold.
 *
 * @param {object} stats  from acceptance() or summarize()
 * @param {string} kind   generator kind, e.g. "tag"
 * @returns {{suppress:boolean, probe:boolean, reason:string, n:number, rate:number|null, upper:number}}
 */
export function probeRoll(kind, day) {
  // FNV-1a over kind+day, mapped to [0,1). Stable across processes and restarts.
  let h = 0x811c9dc5;
  const s = `${kind}|${day}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x100000000;
}

export function shouldSuppress(stats, kind, { roll, probeRate = PROBE_RATE, day = dayStamp() } = {}) {
  if (roll === undefined) roll = probeRoll(kind, day);
  const out = { kind, suppress: false, probe: false, reason: "", n: 0, rate: null, upper: 1 };

  if (!stats || stats.ok === false) {
    out.reason = stats?.error ? `no signal to judge on: ${stats.error}` : "no signal to judge on";
    return out;
  }

  const c = stats.byKind?.[kind];
  if (!c || c.n < SUPPRESS_MIN_SAMPLE) {
    out.n = c?.n || 0;
    out.rate = c?.rate ?? null;
    out.upper = c?.upper ?? 1;
    out.reason = `only ${out.n} decided — needs ${SUPPRESS_MIN_SAMPLE} before that means anything`;
    return out;
  }

  out.n = c.n;
  out.rate = c.rate;
  out.upper = c.upper;

  if (c.upper >= SUPPRESS_MAX_RATE) {
    out.reason = `${c.approved}/${c.n} accepted — poor, but the evidence still allows ${Math.round(c.upper * 100)}%`;
    return out;
  }

  if (roll < probeRate) {
    out.probe = true;
    out.reason = `suppressed (${c.approved}/${c.n} accepted) — running anyway, to see if it has improved`;
    return out;
  }

  out.suppress = true;
  out.reason = `${c.approved}/${c.n} accepted, at best ${Math.round(c.upper * 100)}% — not asking again for now`;
  return out;
}

// ----------------------------------------------------------------- scoring

function contribution(cellData, weight) {
  if (!cellData || !cellData.n) return 0;
  return (cellData.conservative - 0.5) * weight;
}

/**
 * Adjust a proposal's confidence by what he has actually accepted before.
 *
 * PURE given stats — no env, no I/O — which is the half worth unit-testing.
 * Reads `kind` and `source` off the proposal, so the caller should stamp those
 * on before scoring (propose.js knows them; the proposal object doesn't yet).
 *
 * The adjustment is the sum of each dimension's conservative rate minus a coin
 * flip, weighted. When nothing is known every term is zero and the proposal
 * comes back exactly as it went in — the correct behaviour on night one.
 *
 * Note what this does NOT do: it never rewrites the realm. A learned mapping
 * comes back on `learn.suggestedRealm` for the generator to *propose*. Deciding
 * what a ref means is still his.
 *
 * @param {object} proposal  a stage.js-shaped proposal (+ kind, source)
 * @param {object} stats     from acceptance() or summarize()
 * @returns {object} a copy of the proposal with adjusted confidence and a
 *                   `learn` field explaining every part of the move
 */
export function scoreProposalWith(proposal = {}, stats = null) {
  const base = typeof proposal?.confidence === "number" ? proposal.confidence : 0.5;
  const learn = {
    base,
    delta: 0,
    evidence: [],
    reasons: [],
    suggestedRealm: null,
    applied: false,
  };

  if (!stats || stats.ok === false) {
    learn.reasons.push(stats?.error ? `not learned from: ${stats.error}` : "nothing learned yet");
    return { ...proposal, confidence: base, learn };
  }

  const lookup = {
    kind: stats.byKind?.[proposal.kind],
    source: stats.bySource?.[proposal.source],
    axis: stats.byAxis?.[proposal.axis],
    realm: stats.byRealm?.[proposal.realm],
  };

  let delta = 0;
  for (const dim of DIMENSIONS) {
    const c = lookup[dim];
    const key = proposal[dim];
    if (!key || !c || !c.n) continue;
    const d = contribution(c, DIM_WEIGHT[dim]);
    learn.evidence.push({
      dim,
      key,
      n: c.n,
      rate: c.rate,
      conservative: c.conservative,
      confident: c.confident,
      delta: round(d),
    });
    if (!d) {
      // Explicit, because "we have 6 swipes and they don't settle it" is a
      // finding, not an absence.
      learn.reasons.push(`${dim} ${key}: ${c.approved}/${c.n} — too close to call`);
      continue;
    }
    delta += d;
    learn.reasons.push(
      `${dim} ${key}: ${c.approved}/${c.n} accepted → ${d > 0 ? "+" : ""}${round(d, 2)}`
    );
  }

  const clamped = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, delta));
  if (clamped !== delta) learn.reasons.push(`capped at ${MAX_DELTA}`);
  learn.delta = round(clamped);
  learn.applied = clamped !== 0;

  const suggestion = learnedRealm(stats, proposal.source, proposal.realm);
  if (suggestion) {
    learn.suggestedRealm = suggestion;
    learn.reasons.push(
      suggestion.confident
        ? `you moved ${suggestion.from} → ${suggestion.to} on ${suggestion.moves}/${suggestion.n} of these`
        : `you have moved ${suggestion.from} → ${suggestion.to} ${suggestion.moves}× — not enough to lean on yet`
    );
  }

  const confidence = round(Math.max(CONF_FLOOR, Math.min(CONF_CEIL, base + clamped)));
  return { ...proposal, confidence, learn };
}

/**
 * The env-reading half: fetch stats if the caller hasn't already.
 *
 * Pass `stats` when scoring a batch — one aggregate read for a whole pass, not
 * one per proposal.
 */
export async function scoreProposal(env, proposal, stats = null) {
  const s = stats || (await acceptance(env));
  return scoreProposalWith(proposal, s);
}
