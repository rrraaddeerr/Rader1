/**
 * Embeddings + the vector index — this is what makes Big Brain "learn".
 *
 * Nothing here trains a model. Each ref is turned into an embedding (a numeric
 * fingerprint of its meaning) and stored in Vectorize alongside its id. Asking
 * a question embeds the question the same way and pulls the nearest refs back.
 * A ref is searchable the moment it lands, and forgotten the moment it's
 * deleted — no retraining, ever.
 *
 * Two indexes:
 *   VECTORS      — your refs (what you saved)
 *   INV_VECTORS  — rent.co inventory (what you own)
 * Same embedding model, so a question, a saved ref and an archive item all
 * live in the same space and can be compared to each other.
 *
 * Every call degrades gracefully: with no AI/Vectorize bindings the worker
 * still saves, lists and serves exactly as before.
 */

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

/** Vectorize caps metadata; keep it to what the UI needs before hydrating KV. */
const META_TITLE_MAX = 180;

/** Vectorize rejects topK above this when returnMetadata is "all". */
const METADATA_TOPK_MAX = 20;

/**
 * Compose the text that represents a ref in the index.
 *
 * Order matters a little: the most identifying signal goes first, since
 * embedding models weight the head of the input more heavily when truncating.
 * Pure function — unit-tested.
 */
export function embedTextFor(ref) {
  if (!ref || typeof ref !== "object") return "";
  const parts = [
    ref.title,
    ref.caption,                        // vision caption for images
    ref.desc,
    ref.text,                           // typed notes — your own voice
    Array.isArray(ref.tags) && ref.tags.length ? `Tags: ${ref.tags.join(", ")}` : "",
    ref.realm ? `Realm: ${ref.realm}` : "",
    ref.axis ? `Taste axis: ${ref.axis}` : "",
    ref.category ? `Category: ${ref.category}` : "",
    ref.host ? `Source: ${ref.host}` : "",
    ref.body,                           // page text / transcript
  ];
  return parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .join("\n")
    .slice(0, 8000);
}

/** Same idea for an inventory item from data/inventory.json. */
export function embedTextForItem(item) {
  if (!item || typeof item !== "object") return "";
  const parts = [
    item.title || item.name,
    item.category,
    item.subcategory || item.subcat,
    item.description || item.desc,
    Array.isArray(item.tags) && item.tags.length ? `Tags: ${item.tags.join(", ")}` : "",
    item.material,
    item.era,
    item.condition,
  ];
  return parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
}

/** True when this worker has everything it needs to do semantic work. */
export const brainReady = (env) => Boolean(env?.AI && env?.VECTORS);

/**
 * Embed one or more strings. Returns an array of vectors (arrays of floats),
 * or null if AI isn't bound / the call fails.
 */
export async function embed(env, texts) {
  if (!env?.AI) return null;
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || "").slice(0, 8000)).filter(Boolean);
  if (!list.length) return null;
  try {
    const res = await env.AI.run(EMBED_MODEL, { text: list });
    const vectors = res?.data;
    return Array.isArray(vectors) && vectors.length ? vectors : null;
  } catch {
    return null;
  }
}

/** Embed a single string, returning one vector or null. */
export async function embedOne(env, text) {
  const vecs = await embed(env, text);
  return vecs ? vecs[0] : null;
}

/**
 * Put a ref into the index (insert or update — Vectorize upserts by id).
 * Returns true if it landed.
 */
export async function indexRef(env, ref) {
  if (!brainReady(env) || !ref?.id) return false;
  const text = embedTextFor(ref);
  if (!text) return false;
  const vector = await embedOne(env, text);
  if (!vector) return false;
  try {
    await env.VECTORS.upsert([
      {
        id: ref.id,
        values: vector,
        metadata: {
          category: ref.category || "link",
          realm: ref.realm || "",
          title: String(ref.title || ref.host || "").slice(0, META_TITLE_MAX),
          host: ref.host || "",
          createdAt: ref.createdAt || "",
          enriched: Boolean(ref.enrichedAt),
        },
      },
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Remove a ref from the index (called on delete). */
export async function unindexRef(env, id) {
  if (!brainReady(env) || !id) return false;
  try {
    await env.VECTORS.deleteByIds([id]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Nearest refs to a query string.
 * @returns {Promise<Array<{id:string, score:number, metadata:object}>>}
 */
export async function searchRefs(env, query, { topK = 12, category = "", realm = "" } = {}) {
  const vector = await embedOne(env, query);
  if (!vector) return [];
  return searchRefsByVector(env, vector, { topK, category, realm });
}

/** Nearest refs to an existing vector (used by /api/similar). */
export async function searchRefsByVector(
  env,
  vector,
  { topK = 12, category = "", realm = "", exclude = "" } = {}
) {
  if (!brainReady(env) || !vector) return [];
  try {
    // Over-fetch so post-filtering still returns a full page. Filtering in JS
    // rather than via Vectorize metadata indexes keeps setup to one command.
    //
    // The ceiling is not negotiable: Vectorize REJECTS topK above 20 when full
    // metadata is requested, so over-fetching past it returns nothing at all
    // rather than more rows — which reads as "no results" for every filtered
    // search.
    const narrowing = category || realm;
    const want = narrowing ? topK * 4 : topK + (exclude ? 1 : 0);
    const res = await env.VECTORS.query(vector, {
      topK: Math.min(want, METADATA_TOPK_MAX),
      returnMetadata: "all",
    });
    let matches = res?.matches || [];
    if (exclude) matches = matches.filter((m) => m.id !== exclude);
    if (category) matches = matches.filter((m) => m.metadata?.category === category);
    if (realm) matches = matches.filter((m) => m.metadata?.realm === realm);
    return matches.slice(0, topK).map((m) => ({
      id: m.id,
      score: typeof m.score === "number" ? m.score : 0,
      metadata: m.metadata || {},
    }));
  } catch {
    return [];
  }
}

/** Look up the stored vector for a ref id, if the index has one. */
export async function getRefVector(env, id) {
  if (!brainReady(env) || !id) return null;
  try {
    const res = await env.VECTORS.getByIds([id]);
    const hit = Array.isArray(res) ? res[0] : res?.[0];
    return hit?.values || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- inventory

/** True when the rent.co inventory index is wired up. */
export const inventoryReady = (env) => Boolean(env?.AI && env?.INV_VECTORS);

/**
 * Index a batch of inventory items. Called by scripts/index-inventory.mjs.
 * @returns {Promise<number>} how many landed
 */
export async function indexInventory(env, items) {
  if (!inventoryReady(env) || !Array.isArray(items) || !items.length) return 0;
  const usable = items
    .map((item) => ({ item, text: embedTextForItem(item) }))
    .filter(({ item, text }) => text && (item.id || item.slug || item.barcode));
  if (!usable.length) return 0;

  const vectors = await embed(env, usable.map((u) => u.text));
  if (!vectors || vectors.length !== usable.length) return 0;

  try {
    await env.INV_VECTORS.upsert(
      usable.map(({ item }, i) => ({
        id: String(item.id || item.slug || item.barcode),
        values: vectors[i],
        metadata: {
          title: String(item.title || item.name || "").slice(0, META_TITLE_MAX),
          category: item.category || "",
          slug: item.slug || "",
          image: String(item.image || item.photo || item.images?.[0] || "").slice(0, 400),
        },
      }))
    );
    return usable.length;
  } catch {
    return 0;
  }
}

/**
 * Nearest inventory items to a query string — "do I have anything like this?"
 *
 * Returns `{items, error}` rather than a bare array: an empty result and a
 * rejected query look identical otherwise, which makes a real failure
 * impossible to tell from "nothing matched".
 *
 * @returns {Promise<{items:Array, error:string|null}>}
 */
export async function matchInventory(env, query, { topK = 12 } = {}) {
  if (!inventoryReady(env)) return { items: [], error: "INV_VECTORS binding missing" };
  const vector = await embedOne(env, query);
  if (!vector) return { items: [], error: "embedding failed — no vector for the query" };

  // Vectorize caps topK at 20 when full metadata is requested; asking for more
  // is rejected outright rather than truncated.
  const capped = Math.min(topK, METADATA_TOPK_MAX);
  try {
    const res = await env.INV_VECTORS.query(vector, { topK: capped, returnMetadata: "all" });
    const matches = res?.matches || [];
    return {
      items: matches.map((m) => ({
        id: m.id,
        score: typeof m.score === "number" ? m.score : 0,
        ...(m.metadata || {}),
      })),
      error: null,
    };
  } catch (err) {
    return { items: [], error: `query rejected: ${String(err?.message ?? err).slice(0, 240)}` };
  }
}
