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
 *
 * The brain (needs the AI + VECTORS bindings; everything above works without them)
 *   POST   /api/search      -> semantic search over your refs
 *   POST   /api/ask         -> answer a question from your refs, with sources
 *   GET    /api/similar/:id -> refs nearest to this one
 *   GET    /api/profile     -> your taste fingerprint (future-outfit reads this)
 *   POST   /api/match       -> "do I have anything like this?" vs rent.co inventory
 *   POST   /api/set-draft   -> draft a client Set from a brief
 *   POST   /api/reindex     -> (re)build embeddings for everything already saved
 *   POST   /api/inventory/index -> load rent.co inventory into the item index
 *
 * Storage (bound KV namespace REFS_KV)
 *   ref:<id>     -> ref object JSON. id = reverse-timestamp + rand, so a plain
 *                   key-prefix list comes back newest-first with cursor paging.
 *   blob:<key>   -> uploaded bytes (KV). Set REFS_R2 to offload large blobs.
 *   profile:v1   -> cached vibe profile
 *
 * Auth: every write/read API requires header `X-Auth-Token: <AUTH_TOKEN>`.
 * Blobs are served unauthenticated at /blob/<key> so <img> tags work; the
 * random key is the capability (same model as rentco-sets slugs).
 */

import { categorize, ALL_CATEGORIES, parseUrl } from "./categorize.js";
import { fetchMeta } from "./og.js";
import { enrichRef } from "./enrich.js";
import {
  brainReady,
  indexRef,
  unindexRef,
  searchRefs,
  searchRefsByVector,
  getRefVector,
  indexInventory,
  inventoryReady,
} from "./embed.js";
import { askBrain, hydrate, sourceOf, vibeProfile } from "./ask.js";
import { matchArchive, draftSet } from "./rentco.js";
import { classify, titleFor, summarize, REALMS } from "./realm.js";
import * as queue from "./stage.js";
import { quote, ledger } from "./budget.js";
import { DROP_HTML } from "./pages/drop.js";
import { BROWSE_HTML } from "./pages/browse.js";
import { SHORTCUTS_HTML } from "./pages/shortcuts.js";
import { QUEUE_HTML } from "./pages/queue.js";

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
      if (path === "/health") {
        return json({
          ok: true,
          categories: ALL_CATEGORIES,
          brain: brainReady(env),
          inventory: inventoryReady(env),
          deep: Boolean(env.ANTHROPIC_API_KEY),
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

      // POST /api/match — "do I have anything like this?" (JSON or raw image)
      if (path === "/api/match" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const ct = request.headers.get("content-type") || "";
        const topK = clamp(url.searchParams.get("limit"), 12, 60);
        let out;
        if (ct.includes("application/json")) {
          const body = (await request.json().catch(() => null)) || {};
          out = await matchArchive(env, { q: body.q, refId: body.refId }, { topK });
        } else {
          const bytes = await request.arrayBuffer();
          out = await matchArchive(env, { bytes }, { topK });
        }
        return json(out, out.ok ? 200 : 400);
      }

      // POST /api/set-draft {brief} — draft a client Set from the archive
      if (path === "/api/set-draft" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const body = (await request.json().catch(() => null)) || {};
        const out = await draftSet(env, body.brief, { deep: truthy(body.deep ?? true) });
        return json(out, out.ok ? 200 : 400);
      }

      // POST /api/reindex — backfill embeddings for everything already saved
      if (path === "/api/reindex" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        if (!brainReady(env)) return json(BRAIN_OFF, 503);
        return await handleReindex(env, url);
      }

      // POST /api/inventory/index — load rent.co items into the item index
      if (path === "/api/inventory/index" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        if (!inventoryReady(env)) {
          return json({ ok: false, error: "INV_VECTORS binding missing — see README." }, 503);
        }
        const body = await request.json().catch(() => null);
        const items = Array.isArray(body) ? body : body?.items;
        if (!Array.isArray(items)) return json({ ok: false, error: "Expected an array of items" }, 400);
        const n = await indexInventory(env, items);
        return json({ ok: true, indexed: n, received: items.length });
      }

      return json({ ok: false, error: "Not found", path }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err?.message ?? err) }, 500);
    }
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
