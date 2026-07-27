/**
 * The answering layer — retrieval-augmented generation over your own refs.
 *
 * Flow: embed the question -> pull the nearest refs out of Vectorize -> hydrate
 * the full refs from KV -> hand them to a model as context -> answer, with the
 * sources attached so every claim is clickable.
 *
 * Two tiers, by design:
 *   cheap (default) — Workers AI, runs inside the worker, no extra bill.
 *   deep  (?deep=1) — Claude, for synthesis and taste work where voice matters.
 * Deep silently falls back to cheap if ANTHROPIC_API_KEY isn't set, so nothing
 * breaks before you add the secret.
 */

import { searchRefs } from "./embed.js";

export const CHEAP_MODEL = "@cf/meta/llama-3.1-8b-instruct";
export const DEEP_MODEL = "claude-sonnet-5";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** How much retrieved material to put in front of the model. */
const CONTEXT_CHAR_BUDGET = 14_000;
const PER_REF_CHAR_MAX = 1400;

export const SYSTEM_PROMPT = [
  "You are Big Brain — the archive intelligence for Rader Turner, who runs rent.co / RaderENT",
  "(props, wardrobe and set rental) and FUTURE OUTFIT by TTHHAANNKKSS.",
  "You answer strictly from the saved references provided as CONTEXT: links, screenshots,",
  "articles and notes he has dropped into his archive.",
  "",
  "Rules:",
  "- Ground every claim in the context. Cite refs inline as [1], [2] matching their numbers.",
  "- If the context doesn't cover it, say so plainly and say what he'd need to save. Never invent a reference.",
  "- Match his register: archive / warehouse / operating-system. Functional but hot.",
  "  Avoid luxury-showroom, generic prop-house, startup-SaaS and wedding-rental language.",
  "- Be concrete and specific about garments, materials, silhouettes, colour and era. No hedging filler.",
  "- Short by default. Expand only when asked to synthesize or write direction.",
].join("\n");

/**
 * Render retrieved refs as numbered context blocks.
 * Pure function — unit-tested.
 */
export function buildContext(refs, { budget = CONTEXT_CHAR_BUDGET, perRef = PER_REF_CHAR_MAX } = {}) {
  const blocks = [];
  let used = 0;
  for (let i = 0; i < refs.length; i++) {
    const r = refs[i] || {};
    const bodyish = [r.caption, r.text, r.desc, r.body].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const lines = [
      `[${i + 1}] ${r.title || r.host || r.url || "Untitled"}`,
      `    kind: ${r.category || "link"}${r.host ? ` · ${r.host}` : ""}${r.createdAt ? ` · saved ${String(r.createdAt).slice(0, 10)}` : ""}`,
      r.url ? `    url: ${r.url}` : "",
      Array.isArray(r.tags) && r.tags.length ? `    tags: ${r.tags.join(", ")}` : "",
      bodyish ? `    ${bodyish.slice(0, perRef)}${bodyish.length > perRef ? "…" : ""}` : "",
    ].filter(Boolean);
    const block = lines.join("\n");
    // Always keep the top match, even if it alone blows the budget — returning
    // no context at all would make the model answer from nothing.
    if (blocks.length && used + block.length > budget) break;
    blocks.push(blocks.length === 0 ? block.slice(0, Math.max(budget, 200)) : block);
    used += block.length;
  }
  return blocks.join("\n\n");
}

/** Trim a ref down to what the UI needs to render a source chip. */
export function sourceOf(ref, i) {
  return {
    n: i + 1,
    id: ref.id,
    title: ref.title || ref.host || ref.url || "Untitled",
    url: ref.url || "",
    image: ref.image || "",
    category: ref.category || "link",
  };
}

/** Pull full refs out of KV for a list of vector matches, preserving rank. */
export async function hydrate(env, matches) {
  const refs = await Promise.all(
    matches.map(async (m) => {
      try {
        const ref = await env.REFS_KV.get(`ref:${m.id}`, "json");
        return ref ? { ...ref, score: m.score } : null;
      } catch {
        return null;
      }
    })
  );
  return refs.filter(Boolean);
}

/** Call Claude. Returns the text, or null if unset/failed (caller falls back). */
export async function callClaude(env, { system, user, maxTokens = 1200 }) {
  if (!env?.ANTHROPIC_API_KEY) return null;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || DEEP_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data?.content || [])
      .filter((c) => c?.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Call the cheap Workers AI model. Returns text or null. */
export async function callCheap(env, { system, user, maxTokens = 900 }) {
  if (!env?.AI) return null;
  try {
    const res = await env.AI.run(env.CHEAP_MODEL || CHEAP_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
    });
    const text = typeof res === "string" ? res : res?.response ?? "";
    return String(text).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Generate with the requested tier, falling back cheap -> nothing.
 * @returns {Promise<{text:string|null, model:string}>}
 */
export async function generate(env, { system, user, deep = false, maxTokens }) {
  if (deep) {
    const text = await callClaude(env, { system, user, maxTokens });
    if (text) return { text, model: env.ANTHROPIC_MODEL || DEEP_MODEL };
  }
  const text = await callCheap(env, { system, user, maxTokens });
  return { text, model: text ? env.CHEAP_MODEL || CHEAP_MODEL : "none" };
}

/**
 * Ask Big Brain a question about the archive.
 * @returns {Promise<{ok:boolean, answer:string, sources:Array, model:string}>}
 */
export async function askBrain(env, question, { deep = false, topK = 10, category = "" } = {}) {
  const q = String(question || "").trim();
  if (!q) return { ok: false, error: "Ask me something." };

  const matches = await searchRefs(env, q, { topK, category });
  if (!matches.length) {
    return {
      ok: true,
      answer:
        "Nothing in the archive matches that yet — either it isn't saved, or the index hasn't been built. " +
        "Drop a few refs, or run POST /api/reindex if you've just turned the brain on.",
      sources: [],
      model: "none",
    };
  }

  const refs = await hydrate(env, matches);
  const context = buildContext(refs);
  const user = `CONTEXT — ${refs.length} references from the archive:\n\n${context}\n\nQUESTION: ${q}`;

  const { text, model } = await generate(env, { system: SYSTEM_PROMPT, user, deep });
  return {
    ok: true,
    answer: text || "The retrieval worked but no model is bound — add the Workers AI binding to get answers.",
    sources: refs.map(sourceOf),
    model,
  };
}

// ------------------------------------------------------------ vibe profile

const PROFILE_KEY = "profile:v1";
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

const PROFILE_INSTRUCTION = [
  "Read the references above and write this archive's taste profile as JSON only — no prose around it.",
  "Shape:",
  "{",
  '  "summary": "2-3 sentences naming the through-line",',
  '  "palette": ["colour words"],',
  '  "materials": ["fabrics, finishes, surfaces"],',
  '  "silhouettes": ["shapes and cuts"],',
  '  "eras": ["periods referenced"],',
  '  "moods": ["the feeling, in his register"],',
  '  "keywords": ["12-20 search terms that would find more of this"],',
  '  "avoid": ["what this taste is explicitly not"]',
  "}",
  "Be specific and concrete. Ground everything in the references — no generic fashion filler.",
].join("\n");

/**
 * The taste fingerprint future-outfit consumes for look matching.
 * Cached in KV for a day; pass refresh to rebuild.
 */
export async function vibeProfile(env, { deep = true, refresh = false, sample = 60 } = {}) {
  if (!refresh) {
    const cached = await env.REFS_KV.get(PROFILE_KEY, "json").catch(() => null);
    if (cached?.generatedAt && Date.now() - Date.parse(cached.generatedAt) < PROFILE_TTL_MS) {
      return { ...cached, cached: true };
    }
  }

  // Newest-first key order means a plain list gives us the current mood.
  const page = await env.REFS_KV.list({ prefix: "ref:", limit: Math.min(sample, 200) });
  const refs = (
    await Promise.all(page.keys.map((k) => env.REFS_KV.get(k.name, "json").catch(() => null)))
  ).filter(Boolean);

  if (!refs.length) return { ok: false, error: "Nothing saved yet." };

  const user = `CONTEXT — ${refs.length} recent references:\n\n${buildContext(refs)}\n\n${PROFILE_INSTRUCTION}`;
  const { text, model } = await generate(env, {
    system: SYSTEM_PROMPT,
    user,
    deep,
    maxTokens: 1400,
  });

  const profile = parseJsonish(text) || { summary: text || "", raw: true };
  const out = {
    ok: true,
    profile,
    basedOn: refs.length,
    model,
    generatedAt: new Date().toISOString(),
  };
  await env.REFS_KV.put(PROFILE_KEY, JSON.stringify(out)).catch(() => {});
  return out;
}

/**
 * Pull a JSON object out of a model response that may be fenced or chatty.
 * Pure — unit-tested.
 */
export function parseJsonish(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
