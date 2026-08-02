/**
 * Embeddings + the vector index — this is what makes Big Brain "learn".
 *
 * Nothing here trains a model. Each ref is turned into an embedding (a numeric
 * fingerprint of its meaning) and stored in Vectorize alongside its id. Asking
 * a question embeds the question the same way and pulls the nearest refs back.
 * A ref is searchable the moment it lands, and forgotten the moment it's
 * deleted — no retraining, ever.
 *
 * One index: VECTORS — your refs. A question and a saved ref go through the
 * same embedding model, so they live in the same space and can be compared to
 * each other.
 *
 * Every call degrades gracefully: with no AI/Vectorize bindings the worker
 * still saves, lists and serves exactly as before.
 */

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

/** Vectorize caps metadata; keep it to what the UI needs before hydrating KV. */
const META_TITLE_MAX = 180;

/** Vectorize rejects topK above this when returnMetadata is "all". */
export const METADATA_TOPK_MAX = 20;

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
 * Carry a failure out on the array itself.
 *
 * The array shape is what every caller already reads, and changing it would
 * touch the router. But a rejected Vectorize query and an honest no-match are
 * the same empty array otherwise — the conflation that cost this project hours
 * three separate times — so the reason rides along as a non-enumerable `error`.
 * Non-enumerable so JSON.stringify, spread and every array method behave
 * exactly as they did; `matches.error` is the only thing that changes.
 */
function withError(matches, error) {
  Object.defineProperty(matches, "error", { value: error || null, enumerable: false });
  return matches;
}

/**
 * Nearest refs to a query string.
 *
 * Read `.error` before believing an empty result. "The archive has nothing on
 * that" and "we never got to ask" must not read the same to a caller.
 *
 * @returns {Promise<Array<{id:string, score:number, metadata:object}> & {error:string|null}>}
 */
export async function searchRefs(env, query, { topK = 12, category = "", realm = "" } = {}) {
  if (!brainReady(env)) return withError([], "AI/VECTORS not bound — nothing was searched");
  const vector = await embedOne(env, query);
  // embed() reports null for an unbound binding and for a call that threw, and
  // neither of those is "no match" — the question never reached the index.
  if (!vector) return withError([], "couldn't embed the question — the embedding call returned nothing");
  return searchRefsByVector(env, vector, { topK, category, realm });
}

/**
 * Nearest refs to an existing vector (used by /api/similar).
 *
 * @returns {Promise<Array<{id:string, score:number, metadata:object}> & {error:string|null}>}
 */
export async function searchRefsByVector(
  env,
  vector,
  { topK = 12, category = "", realm = "", exclude = "" } = {}
) {
  if (!brainReady(env)) return withError([], "AI/VECTORS not bound — nothing was searched");
  if (!vector) return withError([], "no vector to search with");
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
    return withError(
      matches.slice(0, topK).map((m) => ({
        id: m.id,
        score: typeof m.score === "number" ? m.score : 0,
        metadata: m.metadata || {},
      })),
      null
    );
  } catch (err) {
    // NEVER `catch { return [] }` here. A rejected query — the topK ceiling
    // above is the one that keeps biting — renders as "nothing matched" if the
    // reason is dropped, and the archive then reports a clean bill of health
    // while retrieval is dead. See §6.2 of HANDOFF.md.
    return withError([], `vector query failed: ${String(err?.message ?? err).slice(0, 240)}`);
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
