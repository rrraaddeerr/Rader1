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
import { charge } from "./budget.js";

/**
 * Workers AI model ids move around — a model that existed when this was
 * written can be renamed or retired, and the failure looks identical to "no
 * model bound". So try a list rather than betting on one string, and report
 * what each one said when none of them work.
 */
export const CHEAP_MODELS = [
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3-8b-instruct",
  "@cf/meta/llama-2-7b-chat-int8",
  "@cf/mistral/mistral-7b-instruct-v0.1",
];
export const CHEAP_MODEL = CHEAP_MODELS[0];
export const DEEP_MODEL = "claude-sonnet-5";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** How much retrieved material to put in front of the model. */
const CONTEXT_CHAR_BUDGET = 14_000;
const PER_REF_CHAR_MAX = 1400;

export const SYSTEM_PROMPT = [
  // Names his trade, not his companies. The domain matters — it is why the
  // model reaches for rigs and materials rather than generic design talk — but
  // Big Brain is its own project and other ventures do not belong in its voice.
  "You are Big Brain — the archive intelligence for Rader Turner, a production designer",
  "and set decorator in Vancouver working across props, wardrobe, set and staging.",
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

/**
 * Call Claude. Returns the text, or null if unset/refused/failed — the caller
 * falls back to the cheap tier either way.
 *
 * THIS IS THE ONLY TIER 3 CALL IN THE WORKER and until now nothing outside the
 * morning brief booked it. `/api/ask?deep=1` and `/api/profile` both land here,
 * both are GET-able from a Shortcut, and both cost real money per request — so
 * a loop, a stuck refresh or a Shortcut that fired more often than he thought
 * spent without limit while `/api/budget` reported $0.00 all night. The ceiling
 * cannot govern a tier that never asks it.
 *
 * So the charge is made here rather than at each route, for the same reason
 * enrichRef meters its own vision branch: the call site is the only place every
 * caller has in common. A refusal is not an error — it returns null and
 * `generate()` answers from the cheap tier, which is the documented degrade
 * path and a far better outcome than a surprise bill.
 *
 * `billed` is the opt-out for a caller that already booked its unit —
 * brief.js's synthesise() charges tier 3 itself before it gets here.
 *
 * @returns {Promise<string|null>}
 */
export async function callClaude(env, { system, user, maxTokens = 1200, billed = false, onRefusal } = {}) {
  if (!env?.ANTHROPIC_API_KEY) return null;
  if (!billed) {
    const booked = await charge(env, { tier: 3, units: 1, label: "claude" });
    if (!booked.ok) {
      // Said out loud, not swallowed: "the deep tier is out of budget tonight"
      // and "the deep tier is broken" read identically from the answer alone.
      if (typeof onRefusal === "function") onRefusal(booked.reason);
      return null;
    }
  }
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

/**
 * Call a Workers AI chat model, trying each candidate until one answers.
 *
 * Errors are collected rather than swallowed: a wrong model id and an unbound
 * AI produce the same empty answer otherwise, which is impossible to debug
 * from the outside.
 *
 * @returns {Promise<{text:string|null, model:string, errors:string[]}>}
 */
export async function callCheap(env, { system, user, maxTokens = 900 }) {
  if (!env?.AI) return { text: null, model: "none", errors: ["AI binding missing"] };

  // An explicit override goes first, then the known-good list.
  const candidates = [...new Set([env.CHEAP_MODEL, ...CHEAP_MODELS].filter(Boolean))];
  const errors = [];

  for (const model of candidates) {
    try {
      const res = await env.AI.run(model, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
      });
      const text = typeof res === "string" ? res : res?.response ?? "";
      const trimmed = String(text).trim();
      if (trimmed) return { text: trimmed, model, errors };
      errors.push(`${model}: empty response`);
    } catch (err) {
      errors.push(`${model}: ${String(err?.message ?? err).slice(0, 160)}`);
    }
  }
  return { text: null, model: "none", errors };
}

/**
 * Generate with the requested tier, falling back deep -> cheap -> nothing.
 * @returns {Promise<{text:string|null, model:string, errors:string[]}>}
 */
export async function generate(env, { system, user, deep = false, maxTokens, billed = false }) {
  const errors = [];
  if (deep) {
    // Three different reasons the deep tier can come back empty, and they are
    // not interchangeable: no key, no budget, or a call that failed. Collapsing
    // them into "claude call failed" is how a night of cheap-tier answers gets
    // read as a broken API key.
    let refusal = "";
    const text = await callClaude(env, { system, user, maxTokens, billed, onRefusal: (r) => { refusal = r; } });
    if (text) return { text, model: env.ANTHROPIC_MODEL || DEEP_MODEL, errors };
    errors.push(
      !env.ANTHROPIC_API_KEY
        ? "no ANTHROPIC_API_KEY, fell back to cheap"
        : refusal
          ? `the governor refused the deep tier (${refusal}), fell back to cheap`
          : "claude call failed"
    );
  }
  const out = await callCheap(env, { system, user, maxTokens });
  return { ...out, errors: [...errors, ...out.errors] };
}

/**
 * Ask Big Brain a question about the archive.
 * @returns {Promise<{ok:boolean, answer:string, sources:Array, model:string}>}
 */
export async function askBrain(env, question, { deep = false, topK = 10, category = "" } = {}) {
  const q = String(question || "").trim();
  if (!q) return { ok: false, error: "Ask me something." };

  const matches = await searchRefs(env, q, { topK, category });
  // Retrieval that never ran must not be answered with "nothing matches that".
  // Telling him to save more refs when the index rejected the query is the
  // single most expensive lie this codebase has told itself.
  if (matches.error) {
    return {
      ok: false,
      error: `Retrieval failed, so this is not an empty archive: ${matches.error}`,
      sources: [],
      model: "none",
    };
  }
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

  const { text, model, errors } = await generate(env, { system: SYSTEM_PROMPT, user, deep });
  return {
    ok: true,
    answer:
      text ||
      "Retrieval worked — the sources below are real matches — but no chat model would answer. " +
        "See `debug` for what each model said.",
    sources: refs.map(sourceOf),
    model,
    // Only present when something went wrong; silence on the happy path.
    ...(text ? {} : { debug: errors }),
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
 * The archive's taste fingerprint, read back off its own newest refs.
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
