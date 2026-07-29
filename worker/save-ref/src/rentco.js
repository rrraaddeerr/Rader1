/**
 * The bridge to rent.co and future-outfit.
 *
 * Big Brain knows two things the other projects don't: what you've been
 * *looking at* (refs) and, once inventory is indexed, how that relates to what
 * you actually *own*. Three jobs live here:
 *
 *   matchArchive() — "do I have anything like this?" Drop an image or a
 *                    sentence, get ranked rent.co inventory back.
 *   draftSet()     — a director sends a brief; draft a client Set from the
 *                    archive, grouped into sections, with a reason per pick.
 *   Vibe profile   — lives in ask.js (vibeProfile) since it's pure synthesis;
 *                    future-outfit reads it from GET /api/profile.
 *
 * All of it degrades: without the inventory index the endpoints return an
 * explanatory error instead of failing, so the worker is safe to deploy before
 * you've run scripts/index-inventory.mjs.
 */

import { matchInventory, inventoryReady, searchRefs } from "./embed.js";
import { captionImage } from "./enrich.js";
import { buildContext, generate, hydrate, sourceOf, SYSTEM_PROMPT, parseJsonish } from "./ask.js";

/**
 * Resolve whatever the caller gave us into one query string.
 * Accepts a text query, a saved ref id, or raw image bytes (vision-captioned).
 */
export async function resolveQuery(env, { q, refId, bytes }) {
  if (bytes) {
    const caption = await captionImage(env, bytes);
    if (caption) return { query: caption, via: "vision" };
  }
  if (refId) {
    const ref = await env.REFS_KV.get(`ref:${refId}`, "json").catch(() => null);
    if (ref) {
      const query = [ref.title, ref.caption, ref.desc, ref.text, (ref.tags || []).join(" ")]
        .filter(Boolean)
        .join("\n")
        .slice(0, 2000);
      if (query) return { query, via: "ref" };
    }
  }
  const text = String(q || "").trim();
  return text ? { query: text, via: "text" } : { query: "", via: "none" };
}

/**
 * "Do I have anything like this?" — rank rent.co inventory against a
 * reference, an image, or a description.
 */
export async function matchArchive(env, input, { topK = 12 } = {}) {
  if (!inventoryReady(env)) {
    return {
      ok: false,
      error:
        "Inventory isn't indexed yet. Create the index and run `node scripts/index-inventory.mjs` " +
        "from the repo root — see worker/save-ref/README.md.",
    };
  }
  const { query, via } = await resolveQuery(env, input);
  if (!query) return { ok: false, error: "Give me an image, a ref id, or a description." };

  const { items, error } = await matchInventory(env, query, { topK });
  return {
    ok: true,
    via,
    query: query.slice(0, 400),
    items,
    // Only when something went wrong; an honest empty result stays silent.
    ...(error && !items.length ? { debug: error } : {}),
  };
}

const SET_INSTRUCTION = [
  "Draft a client Set from the ARCHIVE ITEMS above that answers the BRIEF.",
  "Only use items that appear in ARCHIVE ITEMS — never invent an item or an id.",
  "Return JSON only, no prose around it:",
  "{",
  '  "title": "short set name in his register",',
  '  "note": "1-2 sentences to the client on the direction",',
  '  "sections": [',
  '    { "name": "Seating", "items": [ { "id": "...", "why": "one line on why this pick" } ] }',
  "  ],",
  '  "gaps": ["what the brief asks for that the archive cannot cover"]',
  "}",
  "Group by rent.co category. Lead with the strongest picks. Be honest in gaps — a short",
  "accurate set beats a padded one.",
].join("\n");

/**
 * Draft a Set from a brief. Pulls candidate inventory semantically, and any
 * saved refs that speak to the same brief, then asks the model to assemble.
 *
 * Returns the JSON shape /sets/new can consume, plus the candidates so the
 * operator can override.
 */
export async function draftSet(env, brief, { deep = true, candidates = 40, refTopK = 6 } = {}) {
  const text = String(brief || "").trim();
  if (!text) return { ok: false, error: "Paste the brief." };
  if (!inventoryReady(env)) {
    return { ok: false, error: "Inventory isn't indexed yet — run scripts/index-inventory.mjs first." };
  }

  const { items } = await matchInventory(env, text, { topK: candidates });
  if (!items.length) return { ok: false, error: "No inventory matched that brief." };

  // Refs give the model your taste on top of the raw catalogue match.
  const refMatches = await searchRefs(env, text, { topK: refTopK });
  const refs = refMatches.length ? await hydrate(env, refMatches) : [];

  const itemLines = items
    .map((it) => `- id: ${it.id} | ${it.title || "Untitled"} | ${it.category || "uncategorized"}`)
    .join("\n");

  const user = [
    `BRIEF:\n${text}`,
    "",
    `ARCHIVE ITEMS (${items.length} candidates, ranked by fit):\n${itemLines}`,
    refs.length ? `\nYOUR SAVED REFERENCES on this direction:\n${buildContext(refs, { budget: 5000 })}` : "",
    "",
    SET_INSTRUCTION,
  ].join("\n");

  const { text: out, model } = await generate(env, {
    system: SYSTEM_PROMPT,
    user,
    deep,
    maxTokens: 2000,
  });

  const draft = parseJsonish(out);
  if (!draft) {
    return { ok: false, error: "The model didn't return a usable draft.", raw: out, model };
  }

  // Never let a hallucinated id through to the operator UI.
  const known = new Map(items.map((it) => [String(it.id), it]));
  const sections = (Array.isArray(draft.sections) ? draft.sections : [])
    .map((s) => ({
      name: String(s?.name || "Items"),
      items: (Array.isArray(s?.items) ? s.items : [])
        .map((pick) => {
          const item = known.get(String(pick?.id));
          return item ? { id: item.id, title: item.title, slug: item.slug, image: item.image, why: String(pick?.why || "") } : null;
        })
        .filter(Boolean),
    }))
    .filter((s) => s.items.length);

  return {
    ok: true,
    draft: {
      title: String(draft.title || "Untitled set"),
      note: String(draft.note || ""),
      sections,
      gaps: Array.isArray(draft.gaps) ? draft.gaps.map(String) : [],
    },
    candidates: items,
    refs: refs.map(sourceOf),
    model,
  };
}
