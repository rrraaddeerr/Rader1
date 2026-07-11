/**
 * Future Outfit — cloud save Worker (kid-safe accounts)
 *
 * No emails, no passwords, no personal data. An "account" is just an
 * unguessable friendly code (e.g. "brave-otter-42") that acts as both the
 * read and write key for that profile's saved state. Lose the code = lose
 * access (by design — nothing sensitive is stored, just style prefs).
 *
 * Endpoints
 *   GET  /health        -> { ok }
 *   POST /profile       -> { ok, code }            create a new profile
 *   GET  /state/:code   -> { ok, updatedAt, data } read saved state
 *   PUT  /state/:code   -> { ok, updatedAt }       save state (must exist)
 *
 * Storage (bound KV namespace FO_KV)
 *   prof:<code> -> { createdAt, updatedAt, data }   (data = the app's state)
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

const MAX_BYTES = 256 * 1024; // generous cap on a profile's saved state

// kid-friendly, unambiguous words (no lookalikes / nothing iffy)
const WORDS = [
  "brave","calm","cosmic","clever","bright","bold","comet","coral","dapper","drip",
  "echo","ember","fizzy","fresh","glow","gold","happy","hyper","jazzy","keen",
  "lucky","lunar","mellow","mint","neon","nova","orbit","pixel","plush","prism",
  "quartz","rad","rapid","river","royal","sage","solar","sonic","spark","sunny",
  "swift","tidal","turbo","vivid","wavy","wild","zen","zippy","otter","fox",
  "lynx","puma","raven","robin","koala","panda","tiger","wolf","whale","gecko",
];

function pick(arr) { return arr[Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * arr.length)]; }
function newCode() {
  const n = (crypto.getRandomValues(new Uint32Array(1))[0] % 90) + 10; // 10..99
  return `${pick(WORDS)}-${pick(WORDS)}-${n}`;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/health") return json({ ok: true });
      if (!env.FO_KV) return json({ ok: false, error: "Worker missing FO_KV binding" }, 500);

      // POST /profile — mint a fresh, unused code
      if (path === "/profile" && request.method === "POST") {
        let code;
        for (let i = 0; i < 6; i++) {
          code = newCode();
          if (!(await env.FO_KV.get(`prof:${code}`))) break;
        }
        const now = new Date().toISOString();
        await env.FO_KV.put(`prof:${code}`, JSON.stringify({ createdAt: now, updatedAt: now, data: {} }));
        return json({ ok: true, code, updatedAt: now });
      }

      // /state/:code
      if (path.startsWith("/state/")) {
        const code = decodeURIComponent(path.slice("/state/".length)).trim().toLowerCase();
        if (!/^[a-z]+-[a-z]+-\d{2}$/.test(code)) return json({ ok: false, error: "Bad code" }, 400);

        if (request.method === "GET") {
          const rec = await env.FO_KV.get(`prof:${code}`, "json");
          if (!rec) return json({ ok: false, error: "Not found" }, 404);
          return json({ ok: true, updatedAt: rec.updatedAt, data: rec.data || {} });
        }

        if (request.method === "PUT") {
          const existing = await env.FO_KV.get(`prof:${code}`, "json");
          if (!existing) return json({ ok: false, error: "Unknown code — create a profile first" }, 404);
          const body = await request.json().catch(() => null);
          if (!body || typeof body !== "object" || typeof body.data !== "object")
            return json({ ok: false, error: "Invalid body" }, 400);
          const blob = JSON.stringify(body.data);
          if (blob.length > MAX_BYTES) return json({ ok: false, error: "Too big" }, 413);
          const now = new Date().toISOString();
          await env.FO_KV.put(`prof:${code}`, JSON.stringify({
            createdAt: existing.createdAt || now,
            updatedAt: now,
            data: body.data,
          }));
          return json({ ok: true, updatedAt: now });
        }
      }

      // ---- friends / messaging ----
      const isCode = (c) => /^[a-z]+-[a-z]+-\d{2}$/.test(c);

      // POST /msg/:code — deliver a style ask/reply into a pal's inbox
      if (path.startsWith("/msg/") && request.method === "POST") {
        const to = decodeURIComponent(path.slice("/msg/".length)).trim().toLowerCase();
        if (!isCode(to)) return json({ ok: false, error: "Bad code" }, 400);
        if (!(await env.FO_KV.get(`prof:${to}`))) return json({ ok: false, error: "No pal with that code" }, 404);
        const body = await request.json().catch(() => null);
        if (!body || !isCode(String(body.from || "").toLowerCase()))
          return json({ ok: false, error: "Invalid sender" }, 400);
        const kind = body.kind === "reply" ? "reply" : "ask";
        const msg = {
          id: crypto.randomUUID().slice(0, 12),
          from: String(body.from).toLowerCase(),
          fromName: String(body.fromName || "A pal").slice(0, 40),
          kind,
          text: String(body.text || "").slice(0, 500),
          lookName: String(body.lookName || "").slice(0, 120),
          ts: new Date().toISOString(),
        };
        const inbox = (await env.FO_KV.get(`inbox:${to}`, "json")) || [];
        inbox.unshift(msg);
        await env.FO_KV.put(`inbox:${to}`, JSON.stringify(inbox.slice(0, 100)));
        return json({ ok: true, id: msg.id });
      }

      // ---- family group board (GROUP-ONLY — no private / 1:1 messaging) ----
      // A "family code" (same friendly-code format) is a shared GROUP key that
      // everyone in the family posts to and reads. There is deliberately NO way to
      // message an individual person: the only surface is the whole-family thread,
      // keyed by the group code — never by a kid's personal code. So no child can be
      // DM'd or singled out. The group code (shared only within the approved family)
      // is the gate.
      if (path.startsWith("/board/")) {
        const gc = decodeURIComponent(path.slice("/board/".length)).trim().toLowerCase();
        if (!isCode(gc)) return json({ ok: false, error: "Bad code" }, 400);
        if (request.method === "GET") {
          const thread = (await env.FO_KV.get(`board:${gc}`, "json")) || [];
          return json({ ok: true, messages: thread });
        }
        if (request.method === "POST") {
          const body = await request.json().catch(() => null);
          const text = String(body?.text || "").trim().slice(0, 500);
          if (!text) return json({ ok: false, error: "Empty message" }, 400);
          const msg = {
            id: crypto.randomUUID().slice(0, 12),
            fromName: String(body?.fromName || "Someone").slice(0, 40),
            grown: !!body?.grown,
            text,
            ts: new Date().toISOString(),
          };
          const thread = (await env.FO_KV.get(`board:${gc}`, "json")) || [];
          thread.push(msg);
          await env.FO_KV.put(`board:${gc}`, JSON.stringify(thread.slice(-200)));
          return json({ ok: true, id: msg.id, message: msg });
        }
      }

      // /inbox/:code — GET to read, POST {remove:[ids]} to ack/delete
      if (path.startsWith("/inbox/")) {
        const code = decodeURIComponent(path.slice("/inbox/".length)).trim().toLowerCase();
        if (!isCode(code)) return json({ ok: false, error: "Bad code" }, 400);
        if (request.method === "GET") {
          const inbox = (await env.FO_KV.get(`inbox:${code}`, "json")) || [];
          return json({ ok: true, messages: inbox });
        }
        if (request.method === "POST") {
          const body = await request.json().catch(() => null);
          const remove = new Set(Array.isArray(body?.remove) ? body.remove : []);
          const inbox = (await env.FO_KV.get(`inbox:${code}`, "json")) || [];
          const kept = inbox.filter((m) => !remove.has(m.id));
          await env.FO_KV.put(`inbox:${code}`, JSON.stringify(kept));
          return json({ ok: true, messages: kept });
        }
      }

      return json({ ok: false, error: "Not found", path }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err?.message ?? err) }, 500);
    }
  },
};
