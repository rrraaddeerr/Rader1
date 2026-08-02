/**
 * The phone map — the archive as a place you can walk into, level by level.
 *
 * The existing taste map draws 1,698 nodes and 6,962 connections at once. On a
 * 6-inch screen that isn't a map, it's static — "not very conducive to work on
 * on a fucking iPhone because it's so small." The fix is not a faster renderer.
 * A force graph that lays out in 8ms is still unreadable at that density. The
 * fix is a different SHAPE of data: a hierarchy, so the phone can be handed one
 * level at a time.
 *
 *   regions   a handful of big places — realm crossed with dominant taste axis
 *   clusters  neighbourhoods inside a region — vector nearest-neighbour groups
 *   refs      the things themselves
 *
 * The phone downloads nine region cards, then a dozen cluster cards, then ONE
 * PAGE of a cluster's refs — 60, with a cursor for the next. It never downloads
 * 1,578 of anything, at any depth, and never renders more than it can read.
 *
 * Two properties this file exists to hold:
 *
 * 1. COMPUTING THE TREE IS A NIGHTLY JOB; READING IT IS ONE KV GET. Grouping
 *    and clustering the whole archive costs a full KV scan plus ~100 vector
 *    queries. Doing that per pageview is unacceptable, so `buildMapTree()`
 *    writes the tree into KV as three key shapes and `mapTree()` reads exactly
 *    one small key per level. Every stored level is self-contained — it carries
 *    its own breadcrumb — so drilling in is never more than that one read.
 *
 * 2. AN EMPTY LEVEL AND A BROKEN LEVEL LOOK DIFFERENT. Every failure path here
 *    returns `{ok:false, error}` next to the empty nodes array, and the
 *    clustering pass collects per-seed errors rather than reading a rejected
 *    vector query as "this ref has no neighbours". A silent empty result has
 *    cost this project hours three separate times.
 *
 * Degrades all the way down: with no Vectorize binding the tree still builds,
 * grouping by tag/kind instead of by neighbourhood, and every cluster says
 * which of the two it was — see `via`.
 */

import { REALMS, TASTE_AXES, classify, axisFor, normalizeHandle } from "./realm.js";
import { METADATA_TOPK_MAX } from "./embed.js";
import { charge } from "./budget.js";

/** Bump when the stored shape changes; old keys then read as "not built". */
export const MAP_VERSION = 1;

const KEY_ROOT = `map:v${MAP_VERSION}:`;
export const INDEX_KEY = `${KEY_ROOT}index`;
export const regionKey = (id) => `${KEY_ROOT}r:${id}`;
export const clusterKey = (id) => `${KEY_ROOT}c:${id}`;

/**
 * How many region cards the opening screen may show. Nine is two-and-a-bit
 * thumb-sized rows on an iPhone — the whole archive visible without scrolling
 * far, which is the entire point of opening on regions.
 */
export const MAX_REGIONS = 9;

/** A region smaller than this isn't a place, it's a cluster. Folded into its realm. */
export const MIN_REGION = 24;

/** Cluster size aimed for: about a screen and a half of thumbnails. */
export const TARGET_CLUSTER = 18;

/** Below this a cluster is noise on the clusters screen; it goes to the tail bucket. */
export const MIN_CLUSTER = 3;

/** Cap the clusters screen too — same 6-inch constraint, one level down. */
export const MAX_CLUSTERS_PER_REGION = 24;

/**
 * Refs handed to the phone in one response.
 *
 * A cluster is capped on the clusters SCREEN, not in the data: when the rules
 * have to carry a region the tail bucket legitimately holds hundreds of refs
 * (measured: 1,146). Sending those down as one array is the original complaint
 * in a new place — a thousand tiles on a 6-inch screen — so the read path pages
 * them and hands back a `nextCursor`. 60 is what the page draws at once: three
 * 104px columns, about five screenfuls.
 */
export const REFS_PAGE = 60;

/** Ceiling on an explicit `limit`. Nobody gets to ask for the whole cluster. */
export const REFS_PAGE_MAX = 120;

/** Bounded scan. A tree built from part of the archive must SAY it was partial. */
export const MAX_SCAN = 5000;

/** Vector queries one build may spend. ~1,578 refs at 20 per query needs ~80. */
export const MAX_VECTOR_QUERIES = 120;

/**
 * Neighbours fetched per seed.
 *
 * Pinned to the metadata ceiling even though this query asks for no metadata:
 * Vectorize REJECTS topK above 20 when metadata is requested — it refuses, it
 * does not truncate — and the failure presents as an empty result set rather
 * than an error. Staying under the ceiling unconditionally costs one extra seed
 * per cluster and removes the whole class of "the map is silently empty".
 */
export const NEIGHBOUR_TOPK = METADATA_TOPK_MAX;

const AXIS_BY_ID = new Map(TASTE_AXES.map((a) => [a.id, a]));

const msg = (err) => (err && err.message ? err.message : String(err));

/** URL- and KV-safe id fragment. "CULTURE+NEWS" -> "culture-news". */
export function slug(s) {
  const out = String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || "x";
}

/**
 * A card-sized axis name. The full labels carry their own footnotes ("set
 * design (north star: Gary Card)") which are right in realm.js and far too long
 * under a thumbnail.
 */
export function shortAxisLabel(axisId) {
  const axis = AXIS_BY_ID.get(axisId);
  if (!axis) return "";
  let label = axis.label;
  for (const cut of [" (", " & ", " as "]) {
    const at = label.indexOf(cut);
    if (at > 0) label = label.slice(0, at);
  }
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** The handle behind a ref, from whatever the import or the IG join left. */
function handleOf(ref) {
  return normalizeHandle(ref?.handle || ref?.author || ref?.url || "");
}

/**
 * Which realm and axis a ref sits in — free, Tier 0, no model.
 *
 * Stored fields win when they exist (they came from his thumb, via the queue).
 * Otherwise realm.js re-derives them, which is the same classifier the rest of
 * the system uses, so the map can't disagree with search about where a ref is.
 */
export function regionOf(ref = {}) {
  const realm = REALMS.includes(ref.realm)
    ? ref.realm
    : classify({
        name: ref.title || "",
        notes: ref.note || ref.desc || "",
        url: ref.url || "",
        type: ref.type || "",
        handle: handleOf(ref),
      }).realm;

  let axis = AXIS_BY_ID.has(ref.axis) ? ref.axis : null;
  if (!axis) {
    const hit = axisFor({
      handle: handleOf(ref),
      text: `${ref.title || ""} ${ref.note || ""} ${ref.desc || ""} ${(ref.tags || []).join(" ")}`,
    });
    axis = hit ? hit.axis : null;
  }
  return { realm, axis };
}

/** The subset of a ref the phone actually renders. Everything else stays in KV. */
export function cardFor(ref = {}) {
  return {
    id: ref.id || "",
    title: String(ref.title || ref.text || ref.host || ref.url || "Untitled").slice(0, 120),
    image: ref.image || "",
    host: ref.host || "",
    url: ref.url || "",
    category: ref.category || "link",
  };
}

/** First card carrying a picture. Cards arrive newest-first, so this is "latest". */
export function representativeImage(cards = []) {
  const hit = cards.find((c) => c && c.image);
  return hit ? hit.image : "";
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "into", "your", "you",
  "have", "was", "are", "instagram", "post", "reel", "photo", "video",
  "http", "https", "www", "com", "new", "how", "why", "what", "its", "his",
  "her", "their", "about", "over", "out", "one", "two", "all", "not",
]);

/**
 * Name a cluster from what's in it.
 *
 * Order is by how much the label actually tells him: a tag he chose beats a
 * host, a host beats a word that happens to recur. Everything is a share test,
 * not a plurality — "3 of 18 are tagged Fashion" is not a cluster about
 * fashion, and a label that overclaims is worse than a generic one because he
 * taps it expecting something.
 */
export function labelForCluster(cards = []) {
  if (!cards.length) return "Empty";
  const n = cards.length;

  const tally = (values) => {
    const counts = new Map();
    for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
    let best = "";
    let bestN = 0;
    // Ties break alphabetically so a rebuild on unchanged data renames nothing.
    for (const [v, c] of [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
      if (c > bestN) { best = v; bestN = c; }
    }
    return { best, bestN };
  };

  const tags = tally(cards.flatMap((c) => (Array.isArray(c.tags) ? c.tags : [])));
  if (tags.best && tags.bestN / n >= 0.3) return tags.best;

  const hosts = tally(cards.map((c) => String(c.host || "").replace(/^www\./, "")));
  if (hosts.best && hosts.bestN / n >= 0.5) return hosts.best;

  const words = tally(
    cards.flatMap((c) =>
      String(c.title || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
    )
  );
  if (words.best && words.bestN >= 3 && words.bestN / n >= 0.25) {
    return words.best.charAt(0).toUpperCase() + words.best.slice(1);
  }

  const kinds = tally(cards.map((c) => c.category));
  if (kinds.best && kinds.bestN / n >= 0.6) return `${kinds.best}s`;
  return "Assorted";
}

/**
 * Fold cards into regions: realm crossed with dominant taste axis.
 *
 * Two collapses keep this to a handful of tappable places. An axis group too
 * small to be a place folds into its realm's catch-all; if there are still too
 * many regions the smallest fold the same way. Nothing is ever dropped — the
 * counts across regions always sum to the number of cards in.
 *
 * Pure: no I/O, unit-tested.
 */
export function groupRegions(cards = [], { maxRegions = MAX_REGIONS, minRegion = MIN_REGION } = {}) {
  const buckets = new Map();

  const bucketFor = (realm, axis) => {
    const id = `${slug(realm)}--${axis ? slug(axis) : "all"}`;
    if (!buckets.has(id)) {
      buckets.set(id, {
        id,
        realm,
        axis: axis || null,
        label: axis ? shortAxisLabel(axis) : realm,
        sublabel: axis ? realm : "everything else",
        cards: [],
      });
    }
    return buckets.get(id);
  };

  for (const card of cards) {
    const { realm, axis } = card.region || regionOf(card);
    bucketFor(realm, axis).cards.push(card);
  }

  // Collapse 1: an axis group too small to be a place is part of its realm.
  for (const [id, b] of [...buckets]) {
    if (!b.axis || b.cards.length >= minRegion) continue;
    bucketFor(b.realm, null).cards.push(...b.cards);
    buckets.delete(id);
  }

  // Collapse 2: only the biggest places get a card; the rest join their realm.
  let ordered = [...buckets.values()].sort((a, b) => b.cards.length - a.cards.length);
  while (ordered.length > maxRegions) {
    const smallest = ordered[ordered.length - 1];
    if (!smallest.axis) break; // a realm catch-all has nowhere left to fold into
    buckets.delete(smallest.id);
    bucketFor(smallest.realm, null).cards.push(...smallest.cards);
    ordered = [...buckets.values()].sort((a, b) => b.cards.length - a.cards.length);
  }

  return ordered.map((b) => ({
    ...b,
    cards: b.cards,
    count: b.cards.length,
    image: representativeImage(b.cards),
  }));
}

/** How a card is grouped when there's no vector index to group it by meaning. */
export function fallbackKeyFor(card = {}) {
  const tag = Array.isArray(card.tags) && card.tags.length ? card.tags[0] : "";
  return tag || card.category || String(card.host || "").replace(/^www\./, "") || "other";
}

/**
 * Leader clustering over a region: take an unassigned ref, pull its
 * neighbourhood, and let the unassigned members of that neighbourhood become a
 * cluster with it. One vector query per cluster, bounded.
 *
 * `getNeighbours` is injected — `(id) => Promise<{ids, error}>` — so the shape
 * of the tree can be tested against fake vectors with no bindings at all.
 * A seed whose query ERRORED is recorded and left unassigned; it must not look
 * like a ref that simply had no neighbours, because the two want opposite
 * responses (retry vs. move on).
 *
 * Whatever the vector pass doesn't reach falls through to rule-based buckets,
 * so every member lands somewhere: the cluster counts always sum to
 * `members.length`.
 *
 * @returns {Promise<{clusters:Array, queries:number, errors:Array, byVector:number, byRule:number}>}
 */
export async function clusterRegion(members = [], getNeighbours = null, opts = {}) {
  const {
    target = TARGET_CLUSTER,
    maxClusters = MAX_CLUSTERS_PER_REGION,
    minCluster = MIN_CLUSTER,
    budget = MAX_VECTOR_QUERIES,
  } = opts;

  const byId = new Map(members.map((m) => [m.id, m]));
  const assigned = new Set();
  const clusters = [];
  const errors = [];
  let queries = 0;

  if (typeof getNeighbours === "function") {
    for (const seed of members) {
      if (clusters.length >= maxClusters) break;
      if (queries >= budget) break;
      if (assigned.has(seed.id)) continue;
      // Fewer refs left than a cluster needs — the tail belongs to the rules.
      if (members.length - assigned.size < minCluster) break;

      queries++;
      const { ids, error } = await getNeighbours(seed.id);
      if (error) { errors.push({ id: seed.id, error }); continue; }

      const memberIds = [seed.id];
      for (const id of ids || []) {
        if (memberIds.length >= target) break;
        if (id === seed.id || assigned.has(id) || !byId.has(id)) continue;
        memberIds.push(id);
      }
      // A seed with no company isn't a neighbourhood. Leave it for the rules.
      if (memberIds.length < minCluster) continue;

      for (const id of memberIds) assigned.add(id);
      clusters.push({ via: "vector", cards: memberIds.map((id) => byId.get(id)) });
    }
  }

  const byVector = assigned.size;

  // ---- the remainder, grouped by rule ----
  const leftovers = members.filter((m) => !assigned.has(m.id));
  if (leftovers.length) {
    const buckets = new Map();
    for (const card of leftovers) {
      const key = fallbackKeyFor(card);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(card);
    }

    const tail = [];
    const kept = [];
    for (const [key, cards] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
      if (cards.length < minCluster) tail.push(...cards);
      else kept.push({ key, cards });
    }
    if (tail.length) kept.push({ key: "assorted", cards: tail });

    // Slots left on the clusters screen. When the rules have to carry the whole
    // region (no vector index) the buckets get BIGGER rather than the refs
    // getting dropped — a map quietly missing a third of the archive is a lie,
    // and a long cluster is only a longer scroll.
    const slots = Math.max(1, maxClusters - clusters.length);
    const chunk = Math.max(target, Math.ceil(leftovers.length / slots));
    const groups = kept.map((k) => k.cards);

    outer:
    for (let b = 0; b < groups.length; b++) {
      const cards = groups[b];
      for (let i = 0; i < cards.length; i += chunk) {
        // On the last slot everything still unplaced goes in together, so the
        // clusters screen stays a screen and nothing falls off the end.
        if (clusters.length >= maxClusters - 1) {
          const rest = groups.slice(b + 1).reduce((all, g) => all.concat(g), cards.slice(i));
          clusters.push({ via: "rule", cards: rest });
          break outer;
        }
        clusters.push({ via: "rule", cards: cards.slice(i, i + chunk) });
      }
    }
  }

  return {
    clusters,
    queries,
    errors,
    byVector,
    byRule: members.length - byVector,
  };
}

/**
 * Neighbour lookup backed by Vectorize. Returns ids only — the map already
 * knows every ref's metadata from the KV scan, so asking the index for it
 * again would only spend the topK ceiling on nothing.
 */
export function vectorNeighbours(env) {
  if (!env?.VECTORS) return null;
  return async (id) => {
    try {
      const got = await env.VECTORS.getByIds([id]);
      const vector = (Array.isArray(got) ? got[0] : got?.[0])?.values;
      if (!vector) return { ids: [], error: null, missing: true };
      const res = await env.VECTORS.query(vector, {
        topK: NEIGHBOUR_TOPK,
        returnMetadata: false,
      });
      return { ids: (res?.matches || []).map((m) => m.id), error: null };
    } catch (err) {
      return { ids: [], error: msg(err) };
    }
  };
}

/**
 * Read every ref out of KV as a map card.
 * Bounded, and says so when the bound bit — see rule 2 in the header.
 */
async function scanCards(env, { maxScan }) {
  const cards = [];
  const errors = [];
  let cursor;
  let scanned = 0;
  let unreadable = 0;
  let truncated = false;

  do {
    let page;
    try {
      page = await env.REFS_KV.list({ prefix: "ref:", limit: 1000, cursor });
    } catch (err) {
      return { cards, scanned, unreadable, truncated, errors, fatal: `couldn't list refs: ${msg(err)}` };
    }
    for (const k of page.keys) {
      if (scanned >= maxScan) { truncated = true; break; }
      scanned++;
      let ref = null;
      try {
        ref = await env.REFS_KV.get(k.name, "json");
      } catch (err) {
        errors.push({ key: k.name, error: msg(err) });
        continue;
      }
      if (!ref?.id) { unreadable++; continue; }
      const card = cardFor(ref);
      card.tags = Array.isArray(ref.tags) ? ref.tags.slice(0, 6) : [];
      card.region = regionOf(ref);
      cards.push(card);
    }
    cursor = page.list_complete || truncated ? undefined : page.cursor;
  } while (cursor);

  return { cards, scanned, unreadable, truncated, errors, fatal: null };
}

/**
 * Compute the whole tree and write it into KV.
 *
 * Meant for the nightly and for an explicit rebuild — never for a pageview.
 * Cluster ids are deterministic (`<region>-c3`), so a rebuild overwrites the
 * same keys instead of littering; anything the previous build wrote that this
 * one didn't is deleted, and the count is reported as `pruned`.
 *
 * @returns {Promise<object>} the index plus a build report
 */
export async function buildMapTree(env, opts = {}) {
  const {
    maxScan = MAX_SCAN,
    maxQueries = MAX_VECTOR_QUERIES,
    useVectors = true,
    now = new Date(),
  } = opts;

  if (!env?.REFS_KV) {
    return { ok: false, error: "no KV binding — nothing to build the map from", errors: [] };
  }

  const errors = [];
  // Free, deterministic, Tier 0 — but the ledger is the only place that knows
  // what tonight has already done, so the pass still books itself. A ledger we
  // can't write must not stop free work; note it and carry on (see learn.js).
  const booked = await charge(env, { tier: 0, units: 1, label: "map-build" });
  if (!booked.ok) errors.push({ stage: "budget", error: booked.reason });

  const scan = await scanCards(env, { maxScan });
  errors.push(...scan.errors);
  if (scan.fatal) return { ok: false, error: scan.fatal, errors };

  const neighbours = useVectors ? vectorNeighbours(env) : null;
  const regions = groupRegions(scan.cards);
  // Stamped onto every level, not just the index, so a page that drilled
  // straight to a cluster can still tell him how old what he's looking at is.
  const builtAt = new Date(now).toISOString();

  let queriesLeft = neighbours ? maxQueries : 0;
  let byVector = 0;
  let byRule = 0;
  const written = [];
  const regionNodes = [];

  for (const region of regions) {
    // Query budget goes where the refs are: a region holding two thirds of the
    // archive gets two thirds of the queries, so the biggest place isn't the
    // one that degrades to rule-clustering.
    const share = scan.cards.length
      ? Math.ceil((region.count / scan.cards.length) * maxQueries)
      : 0;
    const budget = Math.max(0, Math.min(share, queriesLeft));

    const res = await clusterRegion(region.cards, neighbours, { budget });
    queriesLeft -= res.queries;
    byVector += res.byVector;
    byRule += res.byRule;
    for (const e of res.errors) errors.push({ region: region.id, ...e });

    const clusterNodes = [];
    let n = 0;
    for (const c of res.clusters) {
      const id = `${region.id}-c${++n}`;
      const label = labelForCluster(c.cards);
      const node = {
        id,
        label,
        via: c.via,
        count: c.cards.length,
        image: representativeImage(c.cards),
      };
      clusterNodes.push(node);

      const key = clusterKey(id);
      const body = {
        v: MAP_VERSION,
        builtAt,
        id,
        label,
        via: c.via,
        count: c.cards.length,
        regionId: region.id,
        regionLabel: region.label,
        // Cards go out without the derived region — the client already knows
        // where it is, and 1,578 copies of it is dead weight on a phone plan.
        refs: c.cards.map(({ region: _r, tags: _t, ...card }) => card),
      };
      try {
        await env.REFS_KV.put(key, JSON.stringify(body));
        written.push(key);
      } catch (err) {
        errors.push({ stage: "write", key, error: msg(err) });
      }
    }

    const regionNode = {
      id: region.id,
      label: region.label,
      sublabel: region.sublabel,
      realm: region.realm,
      axis: region.axis,
      count: region.count,
      image: region.image,
      clusterCount: clusterNodes.length,
    };
    regionNodes.push(regionNode);

    const rKey = regionKey(region.id);
    try {
      await env.REFS_KV.put(
        rKey,
        JSON.stringify({ v: MAP_VERSION, builtAt, ...regionNode, clusters: clusterNodes })
      );
      written.push(rKey);
    } catch (err) {
      errors.push({ stage: "write", key: rKey, error: msg(err) });
    }
  }

  const index = {
    v: MAP_VERSION,
    builtAt,
    refs: scan.cards.length,
    scanned: scan.scanned,
    unreadable: scan.unreadable,
    truncated: scan.truncated,
    clustering: {
      vectors: Boolean(neighbours),
      byVector,
      byRule,
      queriesUsed: neighbours ? maxQueries - queriesLeft : 0,
    },
    regions: regionNodes,
    keys: written,
  };

  // Anything last build wrote that this one didn't is now unreachable.
  let pruned = 0;
  try {
    const prev = await env.REFS_KV.get(INDEX_KEY, "json");
    const keep = new Set(written);
    for (const key of prev?.keys || []) {
      if (keep.has(key)) continue;
      await env.REFS_KV.delete(key);
      pruned++;
    }
  } catch (err) {
    errors.push({ stage: "prune", error: msg(err) });
  }

  try {
    await env.REFS_KV.put(INDEX_KEY, JSON.stringify(index));
  } catch (err) {
    // Without the index the levels below are unreachable, so this one is fatal.
    return { ok: false, error: `couldn't save the map index: ${msg(err)}`, errors, index };
  }

  // `keys` goes to KV so the next build can prune; the caller only wants the
  // count of them.
  return { ok: true, error: null, ...index, keys: written.length, pruned, errors };
}

/** Breadcrumb entries are `{level, id, label}` — the page renders them verbatim. */
const crumb = (level, id, label) => ({ level, id, label });

/** "regions" | "clusters" | "refs", from whatever the caller passed. */
function levelFor({ depth, region, cluster }) {
  const named = String(depth ?? "").toLowerCase();
  if (named === "regions" || named === "0") return "regions";
  if (named === "clusters" || named === "1") return "clusters";
  if (named === "refs" || named === "2") return "refs";
  if (cluster) return "refs";
  if (region) return "clusters";
  return "regions";
}

/**
 * One level of the tree — and only that level.
 *
 * This is the read path the phone hits on every tap, so it is one KV get and
 * nothing else: no scan, no clustering, no vector query. If the tree hasn't
 * been built the answer is an explicit `needsBuild`, not an empty map.
 *
 * The refs level is paged: `nodes` is never longer than `REFS_PAGE`, `total` is
 * still the whole cluster, and `nextCursor` is the offset to ask for next (null
 * when there is no next). Everything above refs is capped at build time.
 *
 * @param {object} env
 * @param {{depth?:string|number, region?:string, cluster?:string, cursor?:string|number, limit?:string|number}} opts
 * @returns {Promise<{ok:boolean, level:string, nodes:Array, path:Array, error:string|null}>}
 */
export async function mapTree(env, { depth = "", region = "", cluster = "", cursor = "", limit = 0 } = {}) {
  const level = levelFor({ depth, region, cluster });
  const blank = { ok: false, level, nodes: [], path: [], total: 0, builtAt: null, error: null };

  if (!env?.REFS_KV) return { ...blank, error: "no KV binding" };

  const read = async (key) => {
    try {
      return { value: await env.REFS_KV.get(key, "json"), error: null };
    } catch (err) {
      return { value: null, error: `couldn't read ${key}: ${msg(err)}` };
    }
  };

  if (level === "refs") {
    if (!cluster) return { ...blank, error: "cluster id required" };
    const { value, error } = await read(clusterKey(cluster));
    if (error) return { ...blank, error };
    if (!value) return { ...blank, error: "that cluster isn't in the current map", needsBuild: true };
    const refs = value.refs || [];
    // One page, from wherever the phone left off. A bad cursor reads as 0
    // rather than as an empty cluster — the two look identical on screen.
    const size = Math.max(1, Math.min(Number.parseInt(limit, 10) || REFS_PAGE, REFS_PAGE_MAX));
    const from = Math.max(0, Math.min(Number.parseInt(cursor, 10) || 0, refs.length));
    const page = refs.slice(from, from + size);
    const next = from + page.length;
    return {
      ok: true,
      level,
      nodes: page,
      total: value.count ?? refs.length,
      offset: from,
      // A cursor, not a page number: the caller echoes it back and never has to
      // know how big a page is.
      nextCursor: next < refs.length ? String(next) : null,
      path: [
        crumb("regions", "", "Map"),
        crumb("clusters", value.regionId, value.regionLabel),
        crumb("refs", value.id, value.label),
      ],
      via: value.via || "",
      builtAt: value.builtAt || null,
      error: null,
    };
  }

  if (level === "clusters") {
    if (!region) return { ...blank, error: "region id required" };
    const { value, error } = await read(regionKey(region));
    if (error) return { ...blank, error };
    if (!value) return { ...blank, error: "that region isn't in the current map", needsBuild: true };
    return {
      ok: true,
      level,
      nodes: value.clusters || [],
      total: value.count ?? 0,
      path: [crumb("regions", "", "Map"), crumb("clusters", value.id, value.label)],
      region: {
        id: value.id,
        label: value.label,
        sublabel: value.sublabel,
        realm: value.realm,
        axis: value.axis,
        count: value.count,
      },
      builtAt: value.builtAt || null,
      error: null,
    };
  }

  const { value, error } = await read(INDEX_KEY);
  if (error) return { ...blank, error };
  if (!value) {
    return {
      ...blank,
      error: "the map hasn't been built yet",
      needsBuild: true,
    };
  }
  return {
    ok: true,
    level: "regions",
    nodes: value.regions || [],
    total: value.refs || 0,
    path: [crumb("regions", "", "Map")],
    builtAt: value.builtAt || null,
    truncated: Boolean(value.truncated),
    clustering: value.clustering || null,
    error: null,
  };
}

/**
 * Is there a usable map, and how old is it? For /health and the morning brief —
 * cheap enough to call on every page load, one KV read.
 */
export async function mapStatus(env) {
  if (!env?.REFS_KV) return { ok: false, built: false, error: "no KV binding" };
  try {
    const index = await env.REFS_KV.get(INDEX_KEY, "json");
    if (!index) return { ok: true, built: false, error: null };
    return {
      ok: true,
      built: true,
      builtAt: index.builtAt || null,
      refs: index.refs || 0,
      regions: (index.regions || []).length,
      clustering: index.clustering || null,
      truncated: Boolean(index.truncated),
      error: null,
    };
  } catch (err) {
    return { ok: false, built: false, error: msg(err) };
  }
}
