/**
 * rent.co — sets storage Worker
 *
 * Lives at `rentco-sets.<your-subdomain>.workers.dev`.
 *
 * Endpoints:
 *   GET    /set/<id>          — fetch a set (public; responses included only for operator)
 *   PUT    /set/<id>          — upsert a set (operator, requires Bearer OPERATOR_TOKEN)
 *   DELETE /set/<id>          — delete a set (operator)
 *   GET    /sets              — list all sets (operator)
 *   POST   /response/<id>     — submit/update a client response (public, visitor self-declared)
 *
 * Storage layout (keys in the bound KV namespace):
 *   set:<id>            → the set object as JSON
 *   resp:<id>:<visitor> → one visitor's response (per-visitor key, no shared-array races)
 *   responses:<id>      → legacy array from the v1 layout; still read+merged, never written
 */

const ALLOWED_ORIGINS = new Set([
  "https://r-ent.co",
  "https://www.r-ent.co",
  "http://localhost:3000",
]);

function corsHeaders(request) {
  const origin = request?.headers?.get?.("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://r-ent.co",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const MAX_RESPONDERS_PER_SET = 50;
const MAX_DECISION_KEYS = 500;
const DECISION_VALUES = new Set(["approve", "maybe", "pass"]);

function makeJson(request) {
  const headers = corsHeaders(request);
  return (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
}

function isOperator(request, env) {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/, "");
  return Boolean(env.OPERATOR_TOKEN) && token === env.OPERATOR_TOKEN;
}

async function listSets(env) {
  const list = await env.SETS_KV.list({ prefix: "set:" });
  const sets = [];
  for (const key of list.keys) {
    const data = await env.SETS_KV.get(key.name, "json");
    if (data) sets.push(data);
  }
  return sets.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}

// Merge per-visitor keys with the legacy array (per-visitor wins on conflict).
async function readResponses(env, id) {
  const byVisitor = new Map();
  const legacy = (await env.SETS_KV.get(`responses:${id}`, "json")) ?? [];
  for (const r of legacy) if (r?.visitor) byVisitor.set(r.visitor, r);
  const list = await env.SETS_KV.list({ prefix: `resp:${id}:` });
  for (const key of list.keys) {
    const r = await env.SETS_KV.get(key.name, "json");
    if (r?.visitor) byVisitor.set(r.visitor, r);
  }
  return [...byVisitor.values()].sort((a, b) =>
    (a.updated_at ?? "") < (b.updated_at ?? "") ? -1 : 1
  );
}

function sanitizeDecisions(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== "string" || k.length > 120) continue;
    if (typeof v !== "string" || !DECISION_VALUES.has(v)) continue;
    out[k] = v;
    if (++n >= MAX_DECISION_KEYS) break;
  }
  return out;
}

// Webhook text: strip markdown-ish characters from untrusted fields.
function plain(s) {
  return String(s ?? "").replace(/[*_`>@#|~]/g, "").slice(0, 280);
}

export default {
  async fetch(request, env, ctx) {
    const json = makeJson(request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    try {
      // GET /sets (operator) — list all sets
      if (path === "/sets" && request.method === "GET") {
        if (!isOperator(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
        const sets = await listSets(env);
        return json({ sets });
      }

      // GET /set/<id> — public gets the set only; operator also gets responses
      if (path.startsWith("/set/") && request.method === "GET") {
        const id = path.slice(5);
        if (!id) return json({ ok: false, error: "Missing id" }, 400);
        const data = await env.SETS_KV.get(`set:${id}`, "json");
        if (!data) return json({ ok: false, error: "Set not found" }, 404);
        const operator = isOperator(request, env);
        if (data.unpublished && !operator) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }
        const responses = operator ? await readResponses(env, id) : [];
        return json({ set: data, responses });
      }

      // PUT /set/<id> (operator) — upsert
      if (path.startsWith("/set/") && request.method === "PUT") {
        if (!isOperator(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
        const id = path.slice(5);
        if (!id) return json({ ok: false, error: "Missing id" }, 400);
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") {
          return json({ ok: false, error: "Invalid body" }, 400);
        }
        const stored = { ...body, id, updated_at: new Date().toISOString() };
        await env.SETS_KV.put(`set:${id}`, JSON.stringify(stored));
        return json({ ok: true, set: stored });
      }

      // DELETE /set/<id> (operator)
      if (path.startsWith("/set/") && request.method === "DELETE") {
        if (!isOperator(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
        const id = path.slice(5);
        if (!id) return json({ ok: false, error: "Missing id" }, 400);
        await env.SETS_KV.delete(`set:${id}`);
        await env.SETS_KV.delete(`responses:${id}`);
        const list = await env.SETS_KV.list({ prefix: `resp:${id}:` });
        for (const key of list.keys) await env.SETS_KV.delete(key.name);
        return json({ ok: true });
      }

      // POST /response/<id> (public) — submit/update a response
      if (path.startsWith("/response/") && request.method === "POST") {
        const id = path.slice(10);
        if (!id) return json({ ok: false, error: "Missing id" }, 400);
        const set = await env.SETS_KV.get(`set:${id}`, "json");
        if (!set) return json({ ok: false, error: "Set not found" }, 404);
        if (set.locked) {
          return json({ ok: false, error: "This set is closed for responses." }, 403);
        }
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") {
          return json({ ok: false, error: "Invalid body" }, 400);
        }
        const claimed =
          typeof body.visitor === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(body.visitor)
            ? body.visitor
            : "";
        const visitor = claimed || crypto.randomUUID();

        const existing = await env.SETS_KV.get(`resp:${id}:${visitor}`, "json");
        let isFirstFromThisVisitor = !existing;
        if (isFirstFromThisVisitor) {
          // Legacy layout may still hold this visitor.
          const legacy = (await env.SETS_KV.get(`responses:${id}`, "json")) ?? [];
          if (legacy.some((r) => r?.visitor === visitor)) isFirstFromThisVisitor = false;
          // Cap distinct responders per set (storage-amplification guard).
          if (isFirstFromThisVisitor) {
            const list = await env.SETS_KV.list({ prefix: `resp:${id}:`, limit: MAX_RESPONDERS_PER_SET + 1 });
            if (list.keys.length + legacy.length >= MAX_RESPONDERS_PER_SET) {
              return json({ ok: false, error: "This set is not accepting more responders." }, 429);
            }
          }
        }

        const entry = {
          visitor,
          name:
            typeof body.name === "string" && body.name.trim()
              ? body.name.trim().slice(0, 80)
              : "Anonymous",
          decisions: sanitizeDecisions(body.decisions),
          note: typeof body.note === "string" ? body.note.slice(0, 2000) : "",
          done: body.done === true ? true : existing?.done === true ? true : undefined,
          done_at:
            body.done === true
              ? new Date().toISOString()
              : existing?.done_at ?? undefined,
          updated_at: new Date().toISOString(),
        };
        await env.SETS_KV.put(`resp:${id}:${visitor}`, JSON.stringify(entry));

        // Webhook: only on a visitor's first save and on explicit "done" —
        // never on every keystroke autosave.
        const shouldNotify = env.NOTIFY_WEBHOOK && (isFirstFromThisVisitor || body.done === true);
        if (shouldNotify) {
          try {
            const approve = Object.values(entry.decisions).filter((v) => v === "approve").length;
            const maybe = Object.values(entry.decisions).filter((v) => v === "maybe").length;
            const pass = Object.values(entry.decisions).filter((v) => v === "pass").length;
            const summary =
              `${body.done === true ? "✅ DONE " : "🆕 "}` +
              `${plain(entry.name)} on ${plain(set.name)}` +
              (set.client ? ` (for ${plain(set.client)})` : "") +
              ` — ${approve}✓ ${maybe}◐ ${pass}✗` +
              (entry.note ? `\n${plain(entry.note)}` : "");
            const payload = { text: summary, content: summary };
            ctx?.waitUntil?.(
              fetch(env.NOTIFY_WEBHOOK, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              }).catch(() => {})
            ) ?? fetch(env.NOTIFY_WEBHOOK, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            }).catch(() => {});
          } catch {
            // notification failures must never break the response API
          }
        }

        return json({ ok: true, visitor });
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err?.message ?? err) }, 500);
    }
  },
};
