/**
 * Big Brain — save-ref Worker (optimized rebuild)
 *
 * A drop-anything reference inbox. Drop a link, image, or note and it gets
 * auto-categorized and stored; browse/search them later in a gallery.
 *
 * Endpoints
 *   GET    /                  -> redirect to /drop
 *   GET    /drop              -> the drop SPA (public page; actions need the token)
 *   GET    /browse            -> the gallery SPA
 *   GET    /health            -> { ok:true }
 *   GET    /sw.js             -> notification service worker
 *   GET    /manifest.json     -> PWA manifest (lets iPhone add-to-home-screen)
 *   GET    /icon.svg          -> app icon
 *   POST   /save              -> save a ref              (auth: X-Auth-Token)
 *   GET    /api/list          -> list/search/filter      (auth)
 *   GET    /api/ref/:id       -> one ref                 (auth)
 *   PATCH  /api/ref/:id       -> edit category/tags/title/text/desc (auth)
 *   DELETE /api/ref/:id       -> move a ref to the trash (auth)
 *   POST   /api/ref/:id/restore -> bring it back         (auth)
 *   GET    /api/trash         -> list the trash          (auth)
 *   DELETE /api/trash/:id     -> delete forever (+blob)  (auth)
 *   GET    /api/export        -> NDJSON of all refs      (auth)
 *   POST   /api/import        -> bulk insert refs        (auth)
 *   GET    /api/reminders/config -> which channels are available (auth)
 *   GET    /api/reminders     -> upcoming reminders      (auth)
 *   POST   /api/reminders     -> schedule one            (auth)
 *   DELETE /api/reminders/:id -> cancel one              (auth)
 *   POST   /api/reminders/ics -> downloadable .ics for Apple Reminders/Calendar (auth)
 *   POST   /api/push/subscribe -> register a device for notifications (auth)
 *   GET    /api/push/pending?k= -> the SW pulls its due notifications (subKey is the capability)
 *   GET    /blob/:key         -> raw bytes for an upload (public; key is unguessable)
 *
 * Storage (bound KV namespace REFS_KV)
 *   ref:<id>       -> ref object JSON. id = reverse-timestamp + rand, so a plain
 *                     key-prefix list comes back newest-first with cursor paging.
 *   trash:<id>     -> soft-deleted ref (+deletedAt). Purged after TRASH_TTL_DAYS.
 *   blob:<key>     -> uploaded bytes (KV). Set REFS_R2 to offload large blobs.
 *   rem:<due14>-<r>-> scheduled reminder; prefix list is soonest-first, the
 *                     minute cron fires the due ones (push / Twilio).
 *   push:vapid     -> auto-generated VAPID keypair for web push.
 *   push:sub:<key> -> a device's push subscription (key doubles as capability).
 *   push:q:<key>   -> pending notification payloads for that device's SW.
 *
 * Auth: every write/read API requires header `X-Auth-Token: <AUTH_TOKEN>`.
 * Blobs are served unauthenticated at /blob/<key> so <img> tags work; the
 * random key is the capability (same model as rentco-sets slugs).
 */

import { categorize, ALL_CATEGORIES, parseUrl } from "./categorize.js";
import { fetchMeta } from "./og.js";
import { DROP_HTML } from "./pages/drop.js";
import { BROWSE_HTML } from "./pages/browse.js";
import { SW_JS } from "./pages/sw.js";
import {
  reminderId,
  dueFromReminderId,
  parseDue,
  buildIcs,
  reminderMessage,
  REMINDER_CHANNELS,
} from "./reminders.js";
import { getVapid, sendPush } from "./push.js";
import { smsConfig, sendTwilio } from "./sms.js";
import { ICON_SVG, ICON_PNG_180 } from "./icon.js";

const TRASH_TTL_DAYS = 30;
const NOTE_MAX = 20000;

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

const MANIFEST = JSON.stringify({
  name: "Big Brain",
  short_name: "Big Brain",
  start_url: "/drop",
  display: "standalone",
  background_color: "#0f1115",
  theme_color: "#0f1115",
  icons: [
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png", purpose: "any" },
  ],
});

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      // ---- pages & PWA plumbing ----
      if (path === "/") return Response.redirect(`${url.origin}/drop`, 302);
      if (path === "/drop" && request.method === "GET") return html(DROP_HTML);
      if (path === "/browse" && request.method === "GET") return html(BROWSE_HTML);
      if (path === "/health") return json({ ok: true, categories: ALL_CATEGORIES });
      if (path === "/sw.js" && request.method === "GET")
        return new Response(SW_JS, {
          headers: { "Content-Type": "application/javascript; charset=utf-8", ...CORS },
        });
      if (path === "/manifest.json" && request.method === "GET")
        return new Response(MANIFEST, {
          headers: { "Content-Type": "application/manifest+json", ...CORS },
        });
      if (path === "/icon.svg" && request.method === "GET")
        return new Response(ICON_SVG, {
          headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400", ...CORS },
        });
      if (path === "/apple-touch-icon.png" && request.method === "GET")
        return new Response(Uint8Array.from(atob(ICON_PNG_180), (c) => c.charCodeAt(0)), {
          headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400", ...CORS },
        });

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

      // ---- the SW pulls its pending notifications (subKey is the capability) ----
      if (path === "/api/push/pending" && request.method === "GET") {
        const subKey = url.searchParams.get("k") || "";
        if (!subKey || !(await env.REFS_KV.get(`push:sub:${subKey}`)))
          return json({ ok: false, error: "Unknown subscription" }, 404);
        const q = (await env.REFS_KV.get(`push:q:${subKey}`, "json")) || [];
        await env.REFS_KV.delete(`push:q:${subKey}`);
        return json({ ok: true, notifications: q });
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
        return await handleList(env, url, "ref:");
      }

      // ---- trash ----
      if (path === "/api/trash" && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        await purgeExpiredTrash(env, 200);
        return await handleList(env, url, "trash:");
      }
      if (path.startsWith("/api/trash/") && request.method === "DELETE") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const id = decodeURIComponent(path.slice("/api/trash/".length));
        const ref = await env.REFS_KV.get(`trash:${id}`, "json");
        if (ref?.blobKey) await deleteBlob(env, ref.blobKey);
        await env.REFS_KV.delete(`trash:${id}`);
        return json({ ok: true });
      }

      // ---- reminders ----
      if (path === "/api/reminders/config" && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const vapid = await getVapid(env);
        const tw = smsConfig(env);
        return json({ ok: true, push: { vapidKey: vapid.pub }, sms: tw.sms, whatsapp: tw.whatsapp });
      }
      if (path === "/api/reminders/ics" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const body = await request.json().catch(() => null);
        if (!body || parseDue(body.due) == null) return json({ ok: false, error: "Missing due time" }, 400);
        const ics = buildIcs({
          id: crypto.randomUUID().slice(0, 8),
          title: String(body.title || "Reminder").slice(0, 200),
          due: parseDue(body.due),
          url: String(body.url || "").slice(0, 600),
          note: String(body.note || "").slice(0, 600),
        });
        return new Response(ics, {
          headers: {
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": 'attachment; filename="bigbrain-reminder.ics"',
            ...CORS,
          },
        });
      }
      if (path === "/api/reminders" && request.method === "GET") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const page = await env.REFS_KV.list({ prefix: "rem:", limit: 200 });
        const reminders = [];
        for (const k of page.keys) {
          const rem = await env.REFS_KV.get(k.name, "json");
          if (rem) reminders.push(rem);
        }
        return json({ ok: true, reminders });
      }
      if (path === "/api/reminders" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") return json({ ok: false, error: "Invalid body" }, 400);
        const dueMs = parseDue(body.due);
        if (dueMs == null) return json({ ok: false, error: "Missing or invalid due time" }, 400);
        const channels = (Array.isArray(body.channels) ? body.channels : [])
          .map((c) => String(c).toLowerCase())
          .filter((c) => REMINDER_CHANNELS.includes(c));
        if (!channels.length)
          return json({ ok: false, error: `Pick at least one channel: ${REMINDER_CHANNELS.join(", ")}` }, 400);
        const id = reminderId(dueMs);
        const rem = {
          id,
          title: String(body.title || "Reminder").slice(0, 200),
          note: String(body.note || "").slice(0, 600),
          url: String(body.url || "").slice(0, 600),
          refId: String(body.refId || "").slice(0, 80),
          dueMs,
          channels,
          attempts: 0,
          createdAt: new Date().toISOString(),
        };
        await env.REFS_KV.put(`rem:${id}`, JSON.stringify(rem));
        return json({ ok: true, reminder: rem }, 201);
      }
      if (path.startsWith("/api/reminders/") && request.method === "DELETE") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const id = decodeURIComponent(path.slice("/api/reminders/".length));
        await env.REFS_KV.delete(`rem:${id}`);
        return json({ ok: true });
      }

      // ---- push subscription registration ----
      if (path === "/api/push/subscribe" && request.method === "POST") {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const body = await request.json().catch(() => null);
        const subKey = String(body?.subKey || "").replace(/[^a-zA-Z0-9]/g, "");
        const sub = body?.subscription;
        if (!subKey || subKey.length < 16 || !sub?.endpoint)
          return json({ ok: false, error: "Need subKey + subscription" }, 400);
        await env.REFS_KV.put(
          `push:sub:${subKey}`,
          JSON.stringify({ subscription: sub, createdAt: new Date().toISOString() })
        );
        return json({ ok: true });
      }

      // ---- /api/ref/:id (+ /restore) ----
      if (path.startsWith("/api/ref/")) {
        const fail = requireToken(request, env);
        if (fail) return fail;
        const rest = path.slice("/api/ref/".length);
        const restoring = rest.endsWith("/restore");
        const id = decodeURIComponent(restoring ? rest.slice(0, -"/restore".length) : rest);
        if (!id) return json({ ok: false, error: "Missing id" }, 400);

        if (restoring && request.method === "POST") {
          const ref = await env.REFS_KV.get(`trash:${id}`, "json");
          if (!ref) return json({ ok: false, error: "Not in trash" }, 404);
          delete ref.deletedAt;
          await env.REFS_KV.put(`ref:${id}`, JSON.stringify(ref));
          await env.REFS_KV.delete(`trash:${id}`);
          return json({ ok: true, ref });
        }
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
          if (body.text !== undefined) ref.text = String(body.text).slice(0, NOTE_MAX);
          if (body.desc !== undefined) ref.desc = String(body.desc).slice(0, 600);
          await env.REFS_KV.put(`ref:${id}`, JSON.stringify(ref));
          return json({ ok: true, ref });
        }
        if (request.method === "DELETE") {
          // Soft delete: move to the trash, keep the blob for restore.
          const ref = await env.REFS_KV.get(`ref:${id}`, "json");
          if (!ref) return json({ ok: false, error: "Not found" }, 404);
          ref.deletedAt = new Date().toISOString();
          await env.REFS_KV.put(`trash:${id}`, JSON.stringify(ref));
          await env.REFS_KV.delete(`ref:${id}`);
          return json({ ok: true, trashed: true });
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

      return json({ ok: false, error: "Not found", path }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err?.message ?? err) }, 500);
    }
  },

  // Minute cron (see wrangler.toml [triggers]): fire due reminders, tidy trash.
  async scheduled(event, env, ctx) {
    const work = (async () => {
      await fireDueReminders(env);
      await purgeExpiredTrash(env, 300);
    })();
    ctx.waitUntil(work);
    await work;
  },
};

async function handleSave(request, env, ctx, url) {
  const contentType = request.headers.get("content-type") || "";
  let ref;

  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ ok: false, error: "Invalid body" }, 400);
    const cls = categorize({ url: body.url, text: body.text });

    ref = baseRef(cls);
    if (cls.kind === "url") {
      ref.url = parseUrl(body.url).toString();
      ref.title = (body.title || "").slice(0, 300);
      // enrich with OG metadata (best-effort, doesn't block the response long)
      const meta = await fetchMeta(ref.url);
      ref.title = ref.title || meta.title || ref.host;
      ref.desc = (body.note || meta.description || "").slice(0, 600);
      ref.image = meta.image || "";
    } else if (cls.kind === "note") {
      ref.text = body.text.slice(0, NOTE_MAX);
      ref.title = (body.title || ref.text.split("\n")[0] || "Note").slice(0, 200);
    } else {
      return json({ ok: false, error: "Nothing to save" }, 400);
    }
  } else {
    // raw bytes (file upload / pasted image)
    const bytes = await request.arrayBuffer();
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
  }

  await env.REFS_KV.put(`ref:${ref.id}`, JSON.stringify(ref));
  return json({ ok: true, ref }, 201);
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

async function handleList(env, url, prefix) {
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
    const page = await env.REFS_KV.list({ prefix, limit: 100, cursor: kvCursor });
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
    (ref.tags && ref.tags.join(" ").toLowerCase().includes(q))
  );
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

// ---- trash upkeep ----

async function purgeExpiredTrash(env, maxScan = 200) {
  const cutoff = Date.now() - TRASH_TTL_DAYS * 24 * 3600 * 1000;
  let cursor;
  let scanned = 0;
  do {
    const page = await env.REFS_KV.list({ prefix: "trash:", limit: 100, cursor });
    for (const k of page.keys) {
      if (++scanned > maxScan) return;
      const ref = await env.REFS_KV.get(k.name, "json");
      if (!ref) { await env.REFS_KV.delete(k.name); continue; }
      const deleted = Date.parse(ref.deletedAt || "") || 0;
      if (deleted && deleted < cutoff) {
        if (ref.blobKey) await deleteBlob(env, ref.blobKey);
        await env.REFS_KV.delete(k.name);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

// ---- reminder firing (cron) ----

async function fireDueReminders(env) {
  const now = Date.now();
  // Keys are prefixed with the zero-padded due time, so the list is
  // soonest-first and we can stop at the first not-yet-due reminder.
  const page = await env.REFS_KV.list({ prefix: "rem:", limit: 100 });
  for (const k of page.keys) {
    const due = dueFromReminderId(k.name);
    if (due == null) { await env.REFS_KV.delete(k.name); continue; }
    if (due > now) break;
    const rem = await env.REFS_KV.get(k.name, "json");
    if (!rem) { await env.REFS_KV.delete(k.name); continue; }

    const msg = reminderMessage(rem);
    const results = [];
    for (const ch of rem.channels || []) {
      if (ch === "push") results.push(await firePushChannel(env, rem));
      else if (ch === "sms" || ch === "whatsapp") results.push(await sendTwilio(env, ch, msg));
    }

    if (results.every(Boolean) || (rem.attempts || 0) >= 4) {
      await env.REFS_KV.delete(k.name);
    } else {
      rem.attempts = (rem.attempts || 0) + 1;
      await env.REFS_KV.put(k.name, JSON.stringify(rem));
    }
  }
}

/**
 * Queue the notification for every registered device, then wake each device's
 * service worker with a payload-less push. True if at least one device got it.
 */
async function firePushChannel(env, rem) {
  const subs = await env.REFS_KV.list({ prefix: "push:sub:", limit: 50 });
  let delivered = 0;
  for (const k of subs.keys) {
    const subKey = k.name.slice("push:sub:".length);
    const rec = await env.REFS_KV.get(k.name, "json");
    if (!rec?.subscription) { await env.REFS_KV.delete(k.name); continue; }
    const q = (await env.REFS_KV.get(`push:q:${subKey}`, "json")) || [];
    q.push({
      id: rem.id,
      title: `🧠 ${rem.title || "Reminder"}`,
      body: [rem.note, rem.url].filter(Boolean).join("\n") || "Tap to open Big Brain.",
      url: rem.url || (rem.refId ? `/browse#${rem.refId}` : "/browse"),
    });
    await env.REFS_KV.put(`push:q:${subKey}`, JSON.stringify(q.slice(-20)));
    const res = await sendPush(env, rec.subscription);
    if (res === "gone") {
      await env.REFS_KV.delete(k.name);
      await env.REFS_KV.delete(`push:q:${subKey}`);
    } else if (res === "ok") {
      delivered++;
    }
  }
  return delivered > 0;
}
