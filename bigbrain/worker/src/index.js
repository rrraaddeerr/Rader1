/**
 * Big Brain — save-ref Worker (optimized rebuild)
 *
 * A drop-anything reference inbox. Drop a link, image, or note and it gets
 * auto-categorized and stored; browse/search them later in a gallery.
 *
 * Endpoints
 *   GET    /            -> redirect to /drop
 *   GET    /drop        -> the drop SPA (public page; actions need the token)
 *   GET    /browse      -> the gallery SPA
 *   GET    /health      -> { ok:true }
 *   POST   /save        -> save a ref            (auth: X-Auth-Token)
 *   GET    /api/list    -> list/search/filter    (auth)
 *   GET    /api/ref/:id -> one ref               (auth)
 *   DELETE /api/ref/:id -> delete a ref + blob   (auth)
 *   GET    /api/export  -> NDJSON of all refs     (auth)
 *   POST   /api/import  -> bulk insert refs        (auth)
 *   GET    /blob/:key   -> raw bytes for an upload (public; key is unguessable)
 *   GET    /shortcuts   -> iOS Shortcuts setup guide
 *   GET    /brief       -> the morning brief page
 *   GET    /map         -> the phone map: regions -> clusters -> refs
 *
 * Free maintenance (Tier 0 — no model, no index write; works with no bindings)
 *   POST   /api/thumbs           -> backfill missing og:image thumbnails
 *   POST   /api/propose          -> fill the swipe queue with proposals
 *   GET    /api/propose/preview  -> the same pass, queueing nothing
 *
 * The brain (needs the AI + VECTORS bindings; everything above works without them)
 *   POST   /api/search      -> semantic search over your refs
 *   POST   /api/ask         -> answer a question from your refs, with sources
 *   GET    /api/similar/:id -> refs nearest to this one
 *   GET    /api/profile     -> your taste fingerprint
 *   POST   /api/reindex     -> (re)build embeddings for everything already saved
 *
 * The nightly (src/cron.js, also on a [triggers] cron in wrangler.toml)
 *   GET    /api/brief        -> what landed, what's waiting, what it cost
 *   POST   /api/nightly/run  -> run the maintenance pass now
 *   GET    /api/nightly      -> the last few nights
 *   GET    /api/nightly/:day -> one night's record (YYYY-MM-DD)
 *
 * The three learning loops — each has its own file; these are the read surfaces
 *   GET    /api/ladder/stats     -> loop 1: level histogram, blocks, what's next
 *   GET    /api/ladder/next/:id  -> loop 1: why is this one ref stuck?
 *   POST   /api/ladder/run       -> loop 1: advance a cohort by one rung each
 *   GET    /api/learn            -> loop 2: acceptance rates, ?rebuild=1 replays
 *   POST   /api/learn/score      -> loop 2: what learning would do to a proposal
 *   GET    /api/selfgaps         -> loop 3: the audit, free unless ?probe=1
 *   GET·POST /api/selfgaps/plan  -> loop 3: tonight's work list (POST pays)
 *   GET    /api/map              -> the map, one level at a time (one KV read)
 *   POST   /api/map/rebuild      -> recompute the whole tree
 *
 * Tier 1 — his Mac, over Ollama (bigbrain/local/runner.mjs)
 *   POST   /api/local/lease   -> hand out captioning/summarising work
 *   POST   /api/local/submit  -> take the answers, failures and hand-backs back
 *   GET    /api/local         -> what's left in the pool, and what's leased
 *
 * Storage (bound KV namespace REFS_KV)
 *   ref:<id>     -> ref object JSON. id = reverse-timestamp + rand, so a plain
 *                   key-prefix list comes back newest-first with cursor paging.
 *   blob:<key>   -> uploaded bytes (KV). Set REFS_R2 to offload large blobs.
 *   profile:v1   -> cached vibe profile
 *
 * Auth: every write/read API requires header `X-Auth-Token: <AUTH_TOKEN>`.
 * Blobs are served unauthenticated at /blob/<key> so <img> tags work; the
 * random key is the capability.
 */

import { categorize, ALL_CATEGORIES, parseUrl } from "./categorize.js";
import { fetchMeta } from "./og.js";
import { enrichRef, backfillImages, recoverImage } from "./enrich.js";
import {
  brainReady,
  indexRef,
  unindexRef,
  searchRefs,
  searchRefsByVector,
  getRefVector,
} from "./embed.js";
import { askBrain, hydrate, sourceOf, vibeProfile } from "./ask.js";
import { classify, titleFor, summarize, REALMS } from "./realm.js";
import * as queue from "./stage.js";
import { quote, ledger } from "./budget.js";
import { runProposalPass } from "./propose.js";
import { buildBrief } from "./brief.js";
import { runNightly, readRun, recentRuns } from "./cron.js";
import { ladderStats, nextStep, levelOf, selectCohort, climb, LEVEL_NAMES } from "./ladder.js";
import { acceptance, scoreProposal } from "./learn.js";
import { findGaps, planTonight } from "./selfgaps.js";
import { mapTree, buildMapTree, mapStatus } from "./mapdata.js";
import { leaseJobs, submitResults, localStatus } from "./local.js";
import { DROP_HTML } from "./pages/drop.js";
import { BROWSE_HTML } from "./pages/browse.js";
import { SHORTCUTS_HTML } from "./pages/shortcuts.js";
import { QUEUE_HTML } from "./pages/queue.js";
import { BRIEF_HTML } from "./pages/brief.js";
import { MAP_HTML } from "./pages/map.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token",
  "Access-Control-Max-Age": "86400",
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });

const html = (markup) =>
  new Response(markup, {
    headers: { "Content-Type": "text/html; charset=utf-8", ...CORS },
  });

const BRAIN_OFF = {
  ok: false,
  error:
    "The brain isn't wired up. Add the [ai] and [[vectorize]] bindings in wrangler.toml, " +
    "create the index, redeploy, then POST /api/reindex. See README.",
};

/**
 * Run work after the response goes out. Falls back to fire-and-forget when
 * there's no execution context (tests, direct invocation).
 */
function defer(ctx, promise) {
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(promise);
  else Promise.resolve(promise).catch(() => {});
}

/** Parse a numeric input with a default and a hard ceiling. */
function clamp(v, dflt, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(n, max);
}

/** Accept 1/true/yes/on from query strings as well as real booleans. */
function truthy(v) {
  if (typeof v === "boolean") return v;
  if (v == null) return false;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function requireToken(request, env) {
  const token = request.headers.get("X-Auth-Token") || "";
  if (!env.AUTH_TOKEN) return json({ ok: false, error: "Worker missing AUTH_TOKEN secret" }, 500);
  if (token !== env.AUTH_TOKEN) return json({ ok: false, error: "Unauthorized" }, 401);
  return null;
}

// id whose lexical order is reverse-chronological (newest sorts first)
const TS_MAX = 10_000_000_000_000; // ~ year 2286 in ms
function newId() {
  const rev = (TS_MAX - Date.now()).toString().padStart(14, "0");
  const rand = crypto.randomUUID().slice(0, 8);
  return `${rev}-${rand}`;
}
const createdAtFromId = (id) => {
  const rev = parseInt(id.split("-")[0], 10);
  return Number.isFinite(rev) ? new Date(TS_MAX - rev).toISOString() : null;
};

// Accept tags as an array or a comma/space-separated string; dedupe + cap.
function normalizeTags(input) {
  let arr = [];
  if (Array.isArray(input)) arr = input;
  else if (typeof input === "string") arr = input.split(/[,\n]/);
  return [...new Set(arr.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 30);
}

async function putBlob(env, bytes, contentType) {
  const key = crypto.randomUUID().replace(/-/g, "");
  if (env.REFS_R2) {
    await env.REFS_R2.put(`blob:${key}`, bytes, {
      httpMetadata: { contentType: contentType || "application/octet-stream" },
    });
    return { key, store: "r2" };
  }
  await env.REFS_KV.put(`blob:${key}`, bytes, {
    metadata: { contentType: contentType || "application/octet-stream" },
  });
  return { key, store: "kv" };
}

async function getBlob(env, key) {
  if (env.REFS_R2) {
    const obj = await env.REFS_R2.get(`blob:${key}`);
    if (!obj) return null;
    return { body: obj.body, contentType: obj.httpMetadata?.contentType };
  }
  const { value, metadata } = await env.REFS_KV.getWithMetadata(`blob:${key}`, "arrayBuffer");
  if (!value) return null;
  return { body: value, contentType: metadata?.contentType };
}

async function deleteBlob(env, key) {
  if (!key) return;
  if (env.REFS_R2) await env.REFS_R2.delete(`blob:${key}`).catch(() => {});
  else await env.REFS_KV.delete(`blob:${key}`).catch(() => {});
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      // ---- pages ----
      if (path === "/") return Response.redirect(`${url.origin}/drop`, 302);
      if (path === "/drop" && request.method === "GET") return html(DROP_HTML);
      if (path === "/browse" && request.method === "GET") return html(BROWSE_HTML);
      if (path === "/shortcuts" && request.method === "GET") return html(SHORTCUTS_HTML);
      if (path === "/queue" && request.method === "GET") return html(QUEUE_HTML);
      if (path === "/brief" && request.method === "GET") return html(BRIEF_HTML);
      if (path === "/map" && request.method === "GET") return html(MAP_HTML);
      if (path === "/health") {
        // No token on this route, so it says whether a subsystem is WIRED and
        // never how much is in it. `built` is a yes/no about the map; the ref
        // count that mapStatus also carries stays behind /api/map.
        const map = await mapStatus(env);
        return json({
          ok: true,
          categories: ALL_CATEGORIES,
          brain: brainReady(env),
          deep: Boolean(env.ANTHROPIC_API_KEY),
          map: { built: Boolean(map.built), builtAt: map.builtAt || null, error: map.error || null },
        });
      }

      // ---- public blob read (key is the capability) ----
      if (path.startsWith("/blob/") && request.method === "GET") {
        const key = path.slice(6);
        const blob = await getBlob(env, key);
        if (!blob) return json({ ok: false, error: "Not found" }, 404);
        return new Response(blob.body, {
          headers: {
            "Content-Type": blob.contentType || "application/octet-stream",
            "Cache-Control": "public, max-age=31536000, immutable",
            ...CORS,
          },
        });
      }

      // ---- POST /save ----
      if (path === "/save" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        return await handleSave(request, env, ctx, url);
      }

      // ---- GET /api/list ----
      if (path === "/api/list" && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        return await handleList(env, url);
      }

      // ---- POST /api/ref/:id/thumb ----
      // Repair one ref's thumbnail. Matched before /api/ref/:id below, which
      // would otherwise read the id as "<id>/thumb" — same ordering rule as
      // /api/queue/stats ahead of /api/queue/:id. Always retries: asking for
      // this one ref by name is the retry, and the bulk route's retry=1 would
      // re-fetch all 1,575 to fix it.
      if (path.startsWith("/api/ref/") && path.endsWith("/thumb") && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const id = decodeURIComponent(path.slice("/api/ref/".length, -"/thumb".length));
        if (!id) return json({ ok: false, error: "Missing id" }, 400);
        const ref = await env.REFS_KV.get(`ref:${id}`, "json");
        if (!ref) return json({ ok: false, error: "Not found" }, 404);
        const patch = await recoverImage(ref, { retry: true });
        // No patch means there was nothing to look for — no url, or its own
        // uploaded bytes already outrank anything we could scrape.
        if (!Object.keys(patch).length) {
          return json({ ok: true, ref, changed: false, why: ref.blobKey ? "blob" : "no url" });
        }
        const updated = { ...ref, ...patch };
        await env.REFS_KV.put(`ref:${id}`, JSON.stringify(updated));
        // No re-index on purpose: `image` is in neither embedTextFor() nor the
        // vector metadata, so the embedding is unchanged.
        return json({ ok: true, ref: updated, changed: Boolean(patch.image), why: updated.imageWhy || "og" });
      }

      // ---- /api/ref/:id ----
      if (path.startsWith("/api/ref/")) {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const id = decodeURIComponent(path.slice("/api/ref/".length));
        if (!id) return json({ ok: false, error: "Missing id" }, 400);
        if (request.method === "GET") {
          const ref = await env.REFS_KV.get(`ref:${id}`, "json");
          return ref ? json({ ok: true, ref }) : json({ ok: false, error: "Not found" }, 404);
        }
        if (request.method === "PATCH") {
          const ref = await env.REFS_KV.get(`ref:${id}`, "json");
          if (!ref) return json({ ok: false, error: "Not found" }, 404);
          const body = await request.json().catch(() => null);
          if (!body || typeof body !== "object") return json({ ok: false, error: "Invalid body" }, 400);
          if (body.category !== undefined) {
            const c = String(body.category).trim().toLowerCase();
            if (!ALL_CATEGORIES.includes(c)) {
              return json({ ok: false, error: `Unknown category. Use one of: ${ALL_CATEGORIES.join(", ")}` }, 400);
            }
            ref.category = c;
          }
          if (body.tags !== undefined) ref.tags = normalizeTags(body.tags);
          if (body.title !== undefined) ref.title = String(body.title).slice(0, 300);
          if (body.note !== undefined) ref.note = String(body.note).slice(0, 1000);
          await env.REFS_KV.put(`ref:${id}`, JSON.stringify(ref));
          // Re-tagging changes what the ref means — re-embed it.
          defer(ctx, indexRef(env, ref));
          return json({ ok: true, ref });
        }
        if (request.method === "DELETE") {
          const ref = await env.REFS_KV.get(`ref:${id}`, "json");
          if (ref?.blobKey) await deleteBlob(env, ref.blobKey);
          await env.REFS_KV.delete(`ref:${id}`);
          // Deleted means forgotten — drop it from the index too.
          defer(ctx, unindexRef(env, id));
          return json({ ok: true });
        }
      }

      // ---- GET /api/export (NDJSON) ----
      if (path === "/api/export" && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const refs = await listAll(env);
        const body = refs.map((r) => JSON.stringify(r)).join("\n");
        return new Response(body, {
          headers: {
            "Content-Type": "application/x-ndjson",
            "Content-Disposition": 'attachment; filename="bigbrain-export.ndjson"',
            ...CORS,
          },
        });
      }

      // ---- POST /api/import ----
      if (path === "/api/import" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const body = await request.json().catch(() => null);
        const items = Array.isArray(body) ? body : body?.refs;
        if (!Array.isArray(items)) return json({ ok: false, error: "Expected an array of refs" }, 400);
        let n = 0;
        for (const r of items) {
          if (!r || typeof r !== "object") continue;
          const id = typeof r.id === "string" && r.id ? r.id : newId();
          const ref = { ...r, id };
          await env.REFS_KV.put(`ref:${id}`, JSON.stringify(ref));
          n++;
        }
        return json({ ok: true, imported: n });
      }

      // ---- the swipe queue ----------------------------------------------
      // Agents propose; you decide. Nothing here applies a change on its own.

      // POST /api/queue/propose — mining jobs drop their proposals here
      if (path === "/api/queue/propose" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const body = (await request.json().catch(() => null)) || {};
        const proposals = Array.isArray(body) ? body : body.proposals;
        if (!Array.isArray(proposals)) return json({ ok: false, error: "Expected proposals[]" }, 400);
        const out = await queue.propose(env, {
          kind: body.kind || "realm",
          source: body.source || "agent",
          proposals,
        });
        return json({ ok: true, ...out });
      }

      // GET /api/queue/stats — counts for the header and the morning brief
      if (path === "/api/queue/stats" && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        return json({ ok: true, counts: await queue.stats(env) });
      }

      // GET /api/queue/export — approved and not yet pushed anywhere
      if (path === "/api/queue/export" && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const items = await queue.approved(env, { limit: clamp(url.searchParams.get("limit"), 500, 1000) });
        return json({ ok: true, items, count: items.length });
      }

      // POST /api/queue/applied — mark exported items as pushed
      if (path === "/api/queue/applied" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const body = (await request.json().catch(() => null)) || {};
        const ids = Array.isArray(body) ? body : body.ids;
        if (!Array.isArray(ids)) return json({ ok: false, error: "Expected ids[]" }, 400);
        return json({ ok: true, marked: await queue.markApplied(env, ids) });
      }

      // GET /api/queue — the swipe feed
      if (path === "/api/queue" && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const out = await queue.list(env, {
          status: url.searchParams.get("status") || "pending",
          kind: url.searchParams.get("kind") || "",
          limit: clamp(url.searchParams.get("limit"), 40, 100),
          cursor: url.searchParams.get("cursor") || undefined,
        });
        return json({ ok: true, ...out });
      }

      // POST /api/queue/:id — approve / reject / skip / reopen
      if (path.startsWith("/api/queue/") && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const id = decodeURIComponent(path.slice("/api/queue/".length));
        const body = (await request.json().catch(() => null)) || {};
        const out = await queue.decide(env, id, { action: body.action, edits: body.edits });
        return json(out, out.ok ? 200 : 400);
      }

      // POST /api/propose — fill the swipe queue. Proposes only; nothing applies.
      // Tier 0 throughout, so no BRAIN_OFF gate: dead links, keyword tags and
      // weak realms are all deterministic and want no AI or Vectorize binding.
      if (path === "/api/propose" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const body = (await request.json().catch(() => null)) || {};
        const out = await runProposalPass(env, {
          limit: clamp(body.limit ?? url.searchParams.get("limit"), 50, 200),
          kinds: Array.isArray(body.kinds)
            ? body.kinds
            : (url.searchParams.get("kinds") || "").split(",").filter(Boolean),
          cursor: body.cursor || url.searchParams.get("cursor") || undefined,
          linkLimit: body.linkLimit,
          dryRun: truthy(body.dryRun ?? url.searchParams.get("dry")),
        });
        return json(out, out.ok ? 200 : 400);
      }

      // GET /api/propose/preview — the same pass, queueing nothing. A GET so it
      // opens in a browser or an iOS Shortcut, which is the point: read the
      // whole pass before a single card exists in the queue.
      if (path === "/api/propose/preview" && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const out = await runProposalPass(env, {
          limit: clamp(url.searchParams.get("limit"), 25, 200),
          kinds: (url.searchParams.get("kinds") || "").split(",").filter(Boolean),
          cursor: url.searchParams.get("cursor") || undefined,
          dryRun: true,
        });
        return json(out, out.ok ? 200 : 400);
      }

      // POST /api/classify — Tier 0 realm classification, free, no model call
      if (path === "/api/classify" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const body = (await request.json().catch(() => null)) || {};
        const refs = Array.isArray(body) ? body : body.refs;
        if (!Array.isArray(refs)) return json({ ok: false, error: "Expected refs[]" }, 400);
        const results = refs.map((r) => ({
          url: r.url || r["userDefined:URL"] || "",
          currentTitle: r.name || r.Name || "",
          proposedTitle: titleFor(r, r.handle || ""),
          handle: r.handle || "",
          ...classify(r),
        }));
        return json({ ok: true, realms: REALMS, summary: summarize(results), results });
      }

      // GET /api/budget — what tonight has cost so far, and what still fits
      if (path === "/api/budget" && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        // tier 0 is a legitimate value, so it can't go through clamp()'s
        // "0 means unset" rule.
        const t = parseInt(url.searchParams.get("tier") ?? "3", 10);
        const tier = Number.isFinite(t) && t >= 0 && t <= 3 ? t : 3;
        return json({
          ok: true,
          ledger: await ledger(env),
          quote: await quote(env, {
            tier,
            units: clamp(url.searchParams.get("units"), 1, 100000),
            vision: truthy(url.searchParams.get("vision")),
          }),
        });
      }

      // GET /api/brief — what landed, what's waiting, what it cost. Cached for
      // six hours; ?refresh=1 rebuilds, ?deep=1 writes the synthesis with Claude.
      // ok is false only when REFS_KV is unbound — there's nothing to brief on.
      if (path === "/api/brief" && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const out = await buildBrief(env, {
          deep: truthy(url.searchParams.get("deep")),
          refresh: truthy(url.searchParams.get("refresh")),
        });
        return json(out, out.ok ? 200 : 503);
      }

      // ---- the nightly ---------------------------------------------------
      // Same jobs the cron runs at 11:10 UTC, on demand. See src/cron.js.

      // POST /api/nightly/run {dryRun, jobs, limits, retry} — run it now
      if (path === "/api/nightly/run" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const body = (await request.json().catch(() => null)) || {};
        const out = await runNightly(env, ctx, {
          dryRun: truthy(body.dryRun ?? url.searchParams.get("dry")),
          jobs: Array.isArray(body.jobs) ? body.jobs : undefined,
          limits: body.limits && typeof body.limits === "object" ? body.limits : undefined,
          retry: truthy(body.retry ?? url.searchParams.get("retry")),
        });
        return json(out, out.ok ? 200 : 503);
      }

      // GET /api/nightly — the last few nights, newest first. `error` is
      // non-null only when KV failed, and no runs plus an error is not an
      // idle week — surface both rather than letting [] tell the story.
      if (path === "/api/nightly" && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const { runs, error } = await recentRuns(env, {
          limit: clamp(url.searchParams.get("limit"), 7, 60),
        });
        return json({ ok: true, runs, count: runs.length, error });
      }

      // GET /api/nightly/:day — one night's record. After the two exact paths
      // above, the same way /api/queue/stats is matched before /api/queue/:id.
      if (path.startsWith("/api/nightly/") && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const day = decodeURIComponent(path.slice("/api/nightly/".length));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          return json({ ok: false, error: "Expected a day as YYYY-MM-DD" }, 400);
        }
        const run = await readRun(env, day);
        return run ? json({ ok: true, run }) : json({ ok: false, error: "No run recorded" }, 404);
      }

      // ---- loop 1: the enrichment ladder ---------------------------------
      // A ref is never finished; it climbs. See src/ladder.js.

      // GET /api/ladder/stats — the level histogram. Free, and the one number
      // that says whether the nightly is working: a histogram that hasn't moved
      // in a week is a broken cron, not a finished archive.
      if (path === "/api/ladder/stats" && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const out = await ladderStats(env, {
          cursor: url.searchParams.get("cursor") || undefined,
          maxScan: clamp(url.searchParams.get("maxScan"), 1000, 5000),
        });
        return json({ ok: !out.error, names: LEVEL_NAMES, ...out }, out.error ? 500 : 200);
      }

      // POST /api/ladder/run — advance a cohort by one rung each. Breadth
      // before depth: the cohort is sorted by the level of the STEP, so the
      // whole archive reaches level 2 before anything reaches level 4.
      if (path === "/api/ladder/run" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const body = (await request.json().catch(() => null)) || {};
        // tier 0 is a legitimate value, so it can't go through clamp()'s
        // "0 means unset" rule — same as /api/budget.
        const t = parseInt(body.tier ?? url.searchParams.get("tier") ?? "2", 10);
        const tier = Number.isFinite(t) && t >= 0 && t <= 3 ? t : 2;
        const cohort = await selectCohort(env, {
          limit: clamp(body.limit ?? url.searchParams.get("limit"), 25, 200),
          cursor: body.cursor || url.searchParams.get("cursor") || undefined,
          budget: body.budget,
          retry: truthy(body.retry ?? url.searchParams.get("retry")),
          tier,
        });
        // A KV list that threw and an archive with nothing left to climb are
        // the same empty array otherwise — one is "goodnight", one is broken.
        if (cohort.error) return json({ ok: false, error: cohort.error, ...cohort }, 500);
        const results = [];
        for (const { ref } of cohort.items) results.push(await climb(env, ref, { tier }));
        return json({
          ok: true,
          climbed: results.filter((r) => r.ok && r.to > r.from).length,
          attempted: results.length,
          cursor: cohort.cursor,
          done: cohort.done,
          plan: cohort.plan,
          levels: cohort.levels,
          results,
        });
      }

      // GET /api/ladder/next/:id — "why is this one ref stuck?". After the two
      // exact paths above, the same way /api/queue/stats precedes /api/queue/:id.
      if (path.startsWith("/api/ladder/next/") && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const id = decodeURIComponent(path.slice("/api/ladder/next/".length));
        if (!id) return json({ ok: false, error: "Missing id" }, 400);
        const ref = await env.REFS_KV.get(`ref:${id}`, "json");
        if (!ref) return json({ ok: false, error: "Not found" }, 404);
        const retry = truthy(url.searchParams.get("retry"));
        const step = nextStep(ref, { retry });
        return json({
          ok: true,
          id,
          level: levelOf(ref),
          name: LEVEL_NAMES[levelOf(ref)],
          step,
          // Null means topped out, which is a different fact from "blocked" —
          // the ladder record says which rungs closed and why.
          ladder: ref.ladder || null,
        });
      }

      // ---- loop 2: what he actually accepts -------------------------------
      // Every swipe is signal. See src/learn.js.

      // GET /api/learn — acceptance per generator, source, axis and realm. One
      // KV read; ?rebuild=1 replays the outcome log instead.
      if (path === "/api/learn" && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const out = await acceptance(env, { rebuild: truthy(url.searchParams.get("rebuild")) });
        return json(out, out.ok ? 200 : 503);
      }

      // POST /api/learn/score — what learning would do to one proposal, and
      // why. A preview: it queues nothing and decides nothing.
      if (path === "/api/learn/score" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const body = (await request.json().catch(() => null)) || {};
        const proposal = body.proposal || body;
        if (!proposal || typeof proposal !== "object") {
          return json({ ok: false, error: "Expected a proposal object" }, 400);
        }
        return json({ ok: true, scored: await scoreProposal(env, proposal) });
      }

      // ---- loop 3: the archive audits itself ------------------------------
      // Self-directed, not a fixed script. See src/selfgaps.js.

      // GET·POST /api/selfgaps/plan — tonight's work list. The GET is free and
      // safe to refresh from a phone; the POST is the one that pays for probes.
      if (path === "/api/selfgaps/plan" && (request.method === "GET" || request.method === "POST")) {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const body =
          request.method === "POST" ? (await request.json().catch(() => null)) || {} : {};
        const out = await planTonight(env, {
          cursor: body.cursor || url.searchParams.get("cursor") || undefined,
          limit: clamp(body.limit ?? url.searchParams.get("limit"), 400, 2000),
          budget: body.budget,
          // A GET must never spend. The probes are the only paid part of the
          // audit, so that is the whole difference between the two verbs.
          probe: request.method === "POST" && truthy(body.probe ?? "1"),
        });
        // 200 even when degraded: with no Vectorize the stale and duplicate
        // detectors still produce real jobs, and a 503 would throw them away.
        return json({ ok: !out.error, ...out }, out.error ? 500 : 200);
      }

      // GET /api/selfgaps — the audit on its own. Free unless ?probe=1.
      if (path === "/api/selfgaps" && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const out = await findGaps(env, {
          cursor: url.searchParams.get("cursor") || undefined,
          limit: clamp(url.searchParams.get("limit"), 400, 2000),
          probe: truthy(url.searchParams.get("probe")),
        });
        return json({ ok: !out.error, ...out }, out.error ? 500 : 200);
      }

      // ---- the phone map --------------------------------------------------

      // POST /api/map/rebuild — full scan plus vector queries. Not a pageview
      // route; the page's ↻ button and the nightly are the callers. Awaited,
      // not deferred: the response IS the build report and the page renders it.
      if (path === "/api/map/rebuild" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const out = await buildMapTree(env);
        return json(out, out.ok ? 200 : 500);
      }

      // GET /api/map — one level of the tree. This is what the phone hits on
      // every tap: one KV get, no scan, no clustering, no vector query.
      if (path === "/api/map" && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const out = await mapTree(env, {
          depth: url.searchParams.get("depth") || "",
          region: url.searchParams.get("region") || "",
          cluster: url.searchParams.get("cluster") || "",
        });
        // needsBuild is not a server error — it's an unbuilt map, and the page
        // renders it as a "Build it now" card.
        return json(out, out.ok || out.needsBuild ? 200 : 500);
      }

      // ---- tier 1: his Mac, over Ollama -----------------------------------
      // Free compute on idle hardware. Leases, not claims — see src/local.js.

      // POST /api/local/lease — hand out work. `limit: 0` is a ping.
      if (path === "/api/local/lease" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const body = (await request.json().catch(() => null)) || {};
        const out = await leaseJobs(env, {
          runner: String(body.runner || "").slice(0, 60),
          // limit 0 is legal and means "are you there?", so it can't go through
          // clamp(), which reads 0 as unset.
          limit: Number.isFinite(Number(body.limit)) ? Math.max(0, Number(body.limit)) : 8,
          kinds: Array.isArray(body.kinds) ? body.kinds : undefined,
          leaseSeconds: body.leaseSeconds,
          // /blob/<key> is public, so the runner needs no token for the bytes.
          origin: url.origin,
          retry: truthy(body.retry),
        });
        return json(out, out.ok ? 200 : 503);
      }

      // POST /api/local/submit — answers, failures and hand-backs in one call.
      // One call rather than three: a runner that submits its successes and
      // then dies has stranded the rest for a whole lease period otherwise.
      if (path === "/api/local/submit" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const body = (await request.json().catch(() => null)) || {};
        const out = await submitResults(env, {
          runner: String(body.runner || "").slice(0, 60),
          results: Array.isArray(body.results) ? body.results : [],
          release: Array.isArray(body.release) ? body.release : [],
        });
        return json(out, out.ok ? 200 : 400);
      }

      // GET /api/local — what's still waiting for the Mac. Bounded, and it says
      // so: `complete:false` means "at least this many", not "this many".
      if (path === "/api/local" && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const out = await localStatus(env, {
          maxScan: clamp(url.searchParams.get("maxScan"), 600, 5000),
        });
        return json(out, out.ok ? 200 : 503);
      }

      // ---- the brain ----------------------------------------------------

      // POST /api/search {q, limit, cat} — semantic search
      if (path === "/api/search" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        if (!brainReady(env)) return json(BRAIN_OFF, 503);
        const body = (await request.json().catch(() => null)) || {};
        const q = String(body.q || "").trim();
        if (!q) return json({ ok: false, error: "Missing q" }, 400);
        const limit = clamp(body.limit, 20, 100);
        const matches = await searchRefs(env, q, {
          topK: limit,
          category: body.cat || "",
          realm: body.realm || "",
        });
        const refs = await hydrate(env, matches);
        return json({ ok: true, refs, count: refs.length });
      }

      // POST /api/ask {q, deep} — retrieval + answer. Also GET for Shortcuts.
      if (path === "/api/ask" && (request.method === "POST" || request.method === "GET")) {
        const fail = requireToken(request, env);
        if (fail) return fail;
        if (!brainReady(env)) return json(BRAIN_OFF, 503);
        const body =
          request.method === "POST" ? (await request.json().catch(() => null)) || {} : {};
        const q = String(body.q || url.searchParams.get("q") || "").trim();
        const deep = truthy(body.deep ?? url.searchParams.get("deep"));
        const out = await askBrain(env, q, {
          deep,
          topK: clamp(body.limit ?? url.searchParams.get("limit"), 10, 40),
          category: body.cat || url.searchParams.get("cat") || "",
        });
        // Shortcuts' "Speak Text" wants a bare string, not JSON.
        const wantsText =
          url.searchParams.get("format") === "text" ||
          (request.headers.get("accept") || "").includes("text/plain");
        if (wantsText) {
          return new Response(out.answer || out.error || "", {
            headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS },
          });
        }
        return json(out, out.ok ? 200 : 400);
      }

      // GET /api/similar/:id — nearest refs to one you already saved
      if (path.startsWith("/api/similar/") && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        if (!brainReady(env)) return json(BRAIN_OFF, 503);
        const id = decodeURIComponent(path.slice("/api/similar/".length));
        if (!id) return json({ ok: false, error: "Missing id" }, 400);
        const limit = clamp(url.searchParams.get("limit"), 6, 50);
        let vector = await getRefVector(env, id);
        if (!vector) {
          // Not indexed yet (or index still catching up) — index it now.
          const ref = await env.REFS_KV.get(`ref:${id}`, "json");
          if (!ref) return json({ ok: false, error: "Not found" }, 404);
          await indexRef(env, ref);
          vector = await getRefVector(env, id);
          if (!vector) return json({ ok: true, refs: [] });
        }
        const matches = await searchRefsByVector(env, vector, { topK: limit, exclude: id });
        const refs = await hydrate(env, matches);
        return json({ ok: true, refs, count: refs.length });
      }

      // GET /api/profile — the taste fingerprint future-outfit consumes
      if (path === "/api/profile" && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        if (!brainReady(env)) return json(BRAIN_OFF, 503);
        const out = await vibeProfile(env, {
          refresh: truthy(url.searchParams.get("refresh")),
          deep: !truthy(url.searchParams.get("cheap")),
        });
        return json(out, out.ok === false ? 400 : 200);
      }

      // POST /api/thumbs — put a thumbnail on every ref missing one.
      // Deliberately not /api/reindex?deep=1: an image is in neither the
      // embedding text nor the vector metadata, so this touches no model and no
      // index. Tier 0, free, and ungated for the same reason — it needs no AI.
      if (path === "/api/thumbs" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const out = await backfillImages(env, {
          cursor: url.searchParams.get("cursor") || undefined,
          batch: clamp(url.searchParams.get("batch"), 25, 100),
          retry: truthy(url.searchParams.get("retry")),
        });
        return json(out, out.ok ? 200 : 500);
      }

      // POST /api/reindex — backfill embeddings for everything already saved
      if (path === "/api/reindex" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        if (!brainReady(env)) return json(BRAIN_OFF, 503);
        return await handleReindex(env, url);
      }

      return json({ ok: false, error: "Not found", path }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err?.message ?? err) }, 500);
    }
  },

  /**
   * The nightly maintenance pass — see the [triggers] block in wrangler.toml.
   *
   * waitUntil keeps the invocation alive for the whole run: a scheduled handler
   * that returns early has its work cancelled mid-flight, which for this job
   * would mean a half-written run record and refs marked tried that never were.
   * runNightly() never throws, and reports its own errors into that record.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNightly(env, ctx, { now: new Date(event.scheduledTime) }));
  },
};

async function handleSave(request, env, ctx, url) {
  const contentType = request.headers.get("content-type") || "";
  let ref;
  let bytes; // kept for the vision pass when this is a file drop

  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ ok: false, error: "Invalid body" }, 400);
    const cls = categorize({ url: body.url, text: body.text });

    ref = baseRef(cls);
    // Your own words about why you saved it — the single most useful signal
    // the archive gets, because it's the only part that isn't scraped.
    ref.note = String(body.note || "").slice(0, 1000);
    if (cls.kind === "url") {
      ref.url = parseUrl(body.url).toString();
      ref.title = (body.title || "").slice(0, 300);
      // enrich with OG metadata (best-effort, doesn't block the response long)
      const meta = await fetchMeta(ref.url);
      ref.title = ref.title || meta.title || ref.host;
      ref.desc = (ref.note || meta.description || "").slice(0, 600);
      ref.image = meta.image || "";
    } else if (cls.kind === "note") {
      ref.text = body.text.slice(0, 5000);
      ref.title = (body.title || ref.text.split("\n")[0] || "Note").slice(0, 200);
    } else {
      return json({ ok: false, error: "Nothing to save" }, 400);
    }
  } else {
    // raw bytes (file upload / pasted image)
    bytes = await request.arrayBuffer();
    if (!bytes || bytes.byteLength === 0) return json({ ok: false, error: "Empty upload" }, 400);
    const filename = request.headers.get("x-filename") || "";
    const cls = categorize({ isBlob: true, filename, contentType });
    const { key } = await putBlob(env, bytes, contentType);
    ref = baseRef(cls);
    ref.blobKey = key;
    ref.image = `${url.origin}/blob/${key}`;
    ref.title = (filename || `${cls.category} ${new Date().toLocaleDateString()}`).slice(0, 200);
    ref.bytes = bytes.byteLength;
    ref.mime = contentType;
    // Shortcuts and the drop page can attach a one-liner to a file drop.
    const note = request.headers.get("x-note") || "";
    ref.note = note ? decodeURIComponent(note).slice(0, 1000) : "";
    ref.desc = ref.note;
  }

  await env.REFS_KV.put(`ref:${ref.id}`, JSON.stringify(ref));

  // Index straight away with what we have so the ref is findable immediately,
  // then go deeper in the background and re-index with the richer text.
  await indexRef(env, ref).catch(() => {});
  defer(ctx, deepen(env, ref, bytes));

  const payload = { ok: true, ref };
  // The drop page asks for this to show "you've saved things like this before".
  if (truthy(url.searchParams.get("similar")) && brainReady(env)) {
    try {
      const vector = await getRefVector(env, ref.id);
      const matches = vector
        ? await searchRefsByVector(env, vector, { topK: 4, exclude: ref.id })
        : [];
      payload.similar = (await hydrate(env, matches)).map(sourceOf);
    } catch {
      payload.similar = [];
    }
  }
  return json(payload, 201);
}

/**
 * Background pass: pull the real content (page text, transcript, vision
 * caption), store it on the ref, and re-embed. Runs after the response, so a
 * save still feels instant.
 */
async function deepen(env, ref, bytes) {
  try {
    const patch = await enrichRef(env, ref, bytes);
    if (!Object.keys(patch).length) return;
    const current = await env.REFS_KV.get(`ref:${ref.id}`, "json");
    if (!current) return; // deleted while we were working
    const updated = { ...current, ...patch };
    await env.REFS_KV.put(`ref:${ref.id}`, JSON.stringify(updated));
    await indexRef(env, updated);
  } catch {
    // enrichment is a bonus; the ref is already saved and indexed
  }
}

function baseRef(cls) {
  const id = newId();
  return {
    id,
    kind: cls.kind,
    category: cls.category,
    host: cls.host || null,
    tags: cls.tags || [],
    title: "",
    desc: "",
    image: "",
    createdAt: createdAtFromId(id),
  };
}

async function handleList(env, url) {
  const q = (url.searchParams.get("q") || "").toLowerCase().trim();
  const cat = (url.searchParams.get("cat") || "").trim();
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "60", 10) || 60, 200);
  const cursor = url.searchParams.get("cursor") || undefined;

  // When filtering/searching we may need to scan more than one KV page.
  const out = [];
  let kvCursor = cursor;
  let complete = false;
  let scanned = 0;
  while (out.length < limit && scanned < 1000) {
    const page = await env.REFS_KV.list({ prefix: "ref:", limit: 100, cursor: kvCursor });
    for (const k of page.keys) {
      const ref = await env.REFS_KV.get(k.name, "json");
      scanned++;
      if (!ref) continue;
      if (cat && ref.category !== cat) continue;
      if (q && !matches(ref, q)) continue;
      out.push(ref);
      if (out.length >= limit) break;
    }
    if (page.list_complete) { complete = true; kvCursor = undefined; break; }
    kvCursor = page.cursor;
    if (!q && !cat) break; // unfiltered: one page is enough, return its cursor
  }
  return json({ ok: true, refs: out, cursor: complete ? null : kvCursor, categories: ALL_CATEGORIES });
}

function matches(ref, q) {
  return (
    (ref.title && ref.title.toLowerCase().includes(q)) ||
    (ref.desc && ref.desc.toLowerCase().includes(q)) ||
    (ref.url && ref.url.toLowerCase().includes(q)) ||
    (ref.host && ref.host.toLowerCase().includes(q)) ||
    (ref.text && ref.text.toLowerCase().includes(q)) ||
    (ref.note && ref.note.toLowerCase().includes(q)) ||
    (ref.caption && ref.caption.toLowerCase().includes(q)) ||
    (ref.body && ref.body.toLowerCase().includes(q)) ||
    (ref.tags && ref.tags.join(" ").toLowerCase().includes(q))
  );
}

/**
 * Backfill the index for refs saved before the brain existed.
 *
 * One call does a bounded batch and hands back a cursor, so a big archive is
 * walked in several requests instead of blowing the Worker's CPU budget.
 * `?deep=1` also runs the enrichment pass (slower, far better embeddings).
 */
async function handleReindex(env, url) {
  const deep = truthy(url.searchParams.get("deep"));
  const batch = clamp(url.searchParams.get("batch"), deep ? 10 : 50, 100);
  const cursor = url.searchParams.get("cursor") || undefined;
  const skipDone = truthy(url.searchParams.get("skipEnriched"));

  const page = await env.REFS_KV.list({ prefix: "ref:", limit: batch, cursor });
  let indexed = 0;
  let enriched = 0;

  for (const k of page.keys) {
    const ref = await env.REFS_KV.get(k.name, "json");
    if (!ref) continue;
    let current = ref;
    if (deep && !(skipDone && ref.enrichedAt)) {
      const patch = await enrichRef(env, ref);
      if (Object.keys(patch).length) {
        current = { ...ref, ...patch };
        await env.REFS_KV.put(k.name, JSON.stringify(current));
        enriched++;
      }
    }
    if (await indexRef(env, current)) indexed++;
  }

  return json({
    ok: true,
    indexed,
    enriched,
    scanned: page.keys.length,
    cursor: page.list_complete ? null : page.cursor,
    done: Boolean(page.list_complete),
  });
}

async function listAll(env) {
  const refs = [];
  let cursor;
  do {
    const page = await env.REFS_KV.list({ prefix: "ref:", limit: 1000, cursor });
    for (const k of page.keys) {
      const ref = await env.REFS_KV.get(k.name, "json");
      if (ref) refs.push(ref);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return refs;
}
