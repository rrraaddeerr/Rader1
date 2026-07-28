/**
 * The staging queue — where agent proposals wait for your thumb.
 *
 * Hard rule from the operator: curation is his craft. Agents never add
 * references and never apply a taste judgment on their own. Boring factual
 * repairs (a dead link, a missing title) are safe; anything that decides what
 * a ref *means* — realm, taste tags — is a PROPOSAL that sits here until it's
 * approved.
 *
 * So this module is deliberately dumb and safe:
 *   propose()  writes pending items and nothing else
 *   decide()   records your call; approving does NOT write to Notion
 *   approved() hands you the applied-ready set when you want to push it
 *
 * Nothing in here can mutate a ref or reach Notion. That's the point.
 */

const PREFIX = "stage:";
const TS_MAX = 10_000_000_000_000;

/** Queue ids sort oldest-first: you work a backlog front-to-back. */
function queueId(seq = Date.now()) {
  return `${String(seq).padStart(14, "0")}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Proposals that change nothing meaningful are noise — drop them early. */
export function isMeaningful(p) {
  if (!p || typeof p !== "object") return false;
  const retitle = p.proposedTitle && p.proposedTitle !== p.currentTitle;
  const hasRealm = Boolean(p.realm);
  const hasTags = Array.isArray(p.tags) && p.tags.length > 0;
  return Boolean(retitle || hasRealm || hasTags);
}

/**
 * Queue a batch of proposals. Deduplicates against anything already pending
 * for the same target, so re-running a mining job doesn't stack duplicates.
 *
 * @returns {Promise<{queued:number, skipped:number}>}
 */
export async function propose(env, { kind = "realm", source = "agent", proposals = [] } = {}) {
  if (!Array.isArray(proposals) || !proposals.length) return { queued: 0, skipped: 0 };

  const pendingKeys = await pendingTargets(env);
  let queued = 0;
  let skipped = 0;

  for (const p of proposals) {
    const target = String(p?.url || p?.refId || "").trim();
    if (!target || !isMeaningful(p)) { skipped++; continue; }
    if (pendingKeys.has(target)) { skipped++; continue; }

    const id = queueId(Date.now() + queued);
    const item = {
      id,
      kind,
      source,
      target,
      status: "pending",
      createdAt: new Date().toISOString(),
      proposal: {
        currentTitle: p.currentTitle || "",
        proposedTitle: p.proposedTitle || "",
        realm: p.realm || "",
        axis: p.axis || null,
        tags: Array.isArray(p.tags) ? p.tags : [],
        confidence: typeof p.confidence === "number" ? p.confidence : null,
        why: p.why || "",
        tier: typeof p.tier === "number" ? p.tier : 0,
        handle: p.handle || "",
        url: p.url || "",
      },
    };
    await env.REFS_KV.put(PREFIX + id, JSON.stringify(item));
    pendingKeys.add(target);
    queued++;
  }
  return { queued, skipped };
}

/** Targets already sitting in the queue, so we never double-ask. */
async function pendingTargets(env) {
  const set = new Set();
  let cursor;
  let scanned = 0;
  do {
    const page = await env.REFS_KV.list({ prefix: PREFIX, limit: 1000, cursor });
    for (const k of page.keys) {
      if (scanned++ > 5000) break; // bounded: a huge queue is its own problem
      const item = await env.REFS_KV.get(k.name, "json");
      if (item?.status === "pending" && item.target) set.add(item.target);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && scanned <= 5000);
  return set;
}

/**
 * Next page of the queue. Defaults to pending only — that's the swipe feed.
 * Sorted by confidence ascending is deliberately NOT the default: working
 * highest-confidence first means the first hundred swipes are nearly all
 * "yes", which is how you get through a backlog of 1,200.
 */
export async function list(env, { status = "pending", limit = 40, cursor, kind = "" } = {}) {
  const out = [];
  let kvCursor = cursor;
  let scanned = 0;
  let complete = false;

  while (out.length < limit && scanned < 3000) {
    const page = await env.REFS_KV.list({ prefix: PREFIX, limit: 100, cursor: kvCursor });
    for (const k of page.keys) {
      scanned++;
      const item = await env.REFS_KV.get(k.name, "json");
      if (!item) continue;
      if (status && item.status !== status) continue;
      if (kind && item.kind !== kind) continue;
      out.push(item);
      if (out.length >= limit) break;
    }
    if (page.list_complete) { complete = true; kvCursor = undefined; break; }
    kvCursor = page.cursor;
  }
  return { items: out, cursor: complete ? null : kvCursor };
}

/**
 * Record a decision. `edits` lets you fix a proposal as you approve it —
 * the swipe UI uses it when you change the realm before saying yes.
 *
 * Approving marks it ready. It does not write to Notion; pushing approved
 * changes anywhere is always a separate, explicit act.
 */
export async function decide(env, id, { action, edits = {} } = {}) {
  if (!["approve", "reject", "skip", "reopen"].includes(action)) {
    return { ok: false, error: "action must be approve, reject, skip or reopen" };
  }
  const key = PREFIX + id;
  const item = await env.REFS_KV.get(key, "json");
  if (!item) return { ok: false, error: "Not found" };

  // Undo: put it back in the feed exactly as it was.
  if (action === "reopen") {
    item.status = "pending";
    delete item.decidedAt;
    item.applied = false;
    await env.REFS_KV.put(key, JSON.stringify(item));
    return { ok: true, item };
  }

  if (action === "approve" && edits && typeof edits === "object") {
    if (typeof edits.realm === "string" && edits.realm) item.proposal.realm = edits.realm;
    if (Array.isArray(edits.tags)) item.proposal.tags = edits.tags;
    if (typeof edits.proposedTitle === "string") item.proposal.proposedTitle = edits.proposedTitle;
    item.edited = true;
  }

  item.status = action === "approve" ? "approved" : action === "reject" ? "rejected" : "skipped";
  item.decidedAt = new Date().toISOString();
  item.applied = false;
  await env.REFS_KV.put(key, JSON.stringify(item));
  return { ok: true, item };
}

/** Queue counts, for the morning brief and the UI header. */
export async function stats(env) {
  const counts = { pending: 0, approved: 0, rejected: 0, skipped: 0, applied: 0 };
  let cursor;
  let scanned = 0;
  do {
    const page = await env.REFS_KV.list({ prefix: PREFIX, limit: 1000, cursor });
    for (const k of page.keys) {
      if (scanned++ > 10000) break;
      const item = await env.REFS_KV.get(k.name, "json");
      if (!item) continue;
      if (counts[item.status] !== undefined) counts[item.status]++;
      if (item.applied) counts.applied++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && scanned <= 10000);
  return counts;
}

/**
 * Everything you've approved and not yet pushed, shaped for applying to
 * Notion: target URL plus the fields to set. Export it, eyeball it, apply it.
 */
export async function approved(env, { limit = 500 } = {}) {
  const { items } = await list(env, { status: "approved", limit });
  return items
    .filter((i) => !i.applied)
    .map((i) => ({
      url: i.proposal.url || i.target,
      title: i.proposal.proposedTitle || undefined,
      realm: i.proposal.realm || undefined,
      tags: i.proposal.tags?.length ? i.proposal.tags : undefined,
      axis: i.proposal.axis || undefined,
      queueId: i.id,
    }));
}

/** Mark approved items as pushed, once you've actually applied them. */
export async function markApplied(env, ids = []) {
  let n = 0;
  for (const id of ids) {
    const key = PREFIX + id;
    const item = await env.REFS_KV.get(key, "json");
    if (!item) continue;
    item.applied = true;
    item.appliedAt = new Date().toISOString();
    await env.REFS_KV.put(key, JSON.stringify(item));
    n++;
  }
  return n;
}
