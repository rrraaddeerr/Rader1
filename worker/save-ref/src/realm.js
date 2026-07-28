/**
 * Realms, taste axes, and the Tier-0 classifier.
 *
 * Big Brain is not all aesthetics. A top-level *realm* facet is what makes
 * search filter cleanly — "when I search in Big Brain, it filters better".
 *
 * The point of this file is that almost all of that classification is FREE.
 * `Type` is populated on every row in Notion, so realm falls out of a lookup
 * table with no model call at all. Author handle (recovered from the Instagram
 * export — see scripts/ig-join.mjs) maps to a taste axis the same way. Only
 * the genuine residue ever needs a paid tier.
 *
 * Everything here is pure and offline: no I/O, no model, no network.
 * Ground truth is TASTE_SOURCES.md, distilled from 11,922 saved posts.
 */

/** The four realms. First-class facet, not a tag. */
export const REALMS = ["INSPO", "KNOWLEDGE", "CULTURE+NEWS", "SELF"];

/**
 * The eight axes his archive actually runs on. Rank anything against these.
 * `tags` map each axis onto the Notion tag vocabulary that already exists,
 * so a proposal never invents a tag he'd have to create.
 */
export const TASTE_AXES = [
  {
    id: "post-internet-fashion",
    label: "post-internet fashion & object design",
    realm: "INSPO",
    anchors: ["vetements", "telfar", "craig green", "nicole mclaughlin"],
    tags: ["Fashion", "Material"],
  },
  {
    id: "rap-live-culture",
    label: "rap/hip-hop as live culture",
    realm: "CULTURE+NEWS",
    anchors: ["nba", "hip hop", "rap", "concert", "tour"],
    tags: ["Performance"],
  },
  {
    id: "weird-beautiful-objects",
    label: "weird-beautiful objects & interiors",
    realm: "INSPO",
    anchors: ["decorhardcore", "uglydesign", "misha kahn"],
    tags: ["Furniture", "Sculpture", "Material"],
  },
  {
    id: "digital-3d-image",
    label: "digital/3D post-internet image culture",
    realm: "INSPO",
    anchors: ["sam rolfes", "kim laughton", "software2050", "3d", "render"],
    tags: ["Tech", "Projection"],
  },
  {
    id: "fashion-image-making",
    label: "fashion image-making & beauty",
    realm: "INSPO",
    anchors: ["nick knight", "showstudio", "isamaya", "michel gaubert"],
    tags: ["Fashion", "Lighting"],
  },
  {
    id: "set-design",
    label: "set design (north star: Gary Card)",
    realm: "INSPO",
    anchors: ["gary card", "set design", "scenography", "window display"],
    tags: ["Set", "Sculpture"],
  },
  {
    id: "club-experimental-music",
    label: "club/experimental music",
    realm: "CULTURE+NEWS",
    anchors: ["ghe20g0th1k", "gabber", "regularfantasy", "rave", "club night"],
    tags: ["Performance", "Lighting"],
  },
  {
    // Explicitly not SELF: the taste seed calls this a cultural pulse sensor,
    // not noise and not personal. SELF is never inferred — it only ever comes
    // from his own hand, because nothing here can tell what's personal to him.
    id: "internet-humor",
    label: "internet-brain humor (pulse sensor, not noise)",
    realm: "CULTURE+NEWS",
    anchors: ["meme", "shitpost"],
    tags: ["Off-topic"],
  },
];

const AXIS_BY_ID = new Map(TASTE_AXES.map((a) => [a.id, a]));

/**
 * His human algorithm — the accounts he saves from most, with the axis each
 * one sits on. Save counts are from the IG export and are why these are
 * trusted: they're behaviour, not opinion.
 */
export const CURATORS = {
  "welcome.jpeg": { axis: "weird-beautiful-objects", saves: 195 },
  noeloquence: { axis: "post-internet-fashion", saves: 173 },
  trashcanpaul: { axis: "internet-humor", saves: 142 },
  software2050: { axis: "digital-3d-image", saves: 111 },
  fantasyafantasya: { axis: "fashion-image-making", saves: 102 },
  nathanielknows: { axis: "post-internet-fashion", saves: 97 },
};

/** Publications he trusts. Editorial, so INSPO unless clearly news. */
export const TASTE_PUBLICATIONS = [
  "032c", "i-d", "i_d", "dazed", "businessoffashion", "bof", "hypebeast",
  "showstudio", "somethingcurated", "blast", "fuuckingyoung", "feltzine",
  "tzvetnik", "ofluxo",
];

/**
 * Substack/Patreon sources that are tech/AI education rather than culture.
 * Grounded in what's actually in the database (Faster Please, Nate's).
 */
export const KNOWLEDGE_SOURCES = [
  "faster, please", "fasterplease", "nate's substack", "natesnewsletter",
  "import ai", "one useful thing", "latent space", "simon willison",
];

/** Notion `Type` -> realm. Type is populated on every row, so this is free. */
export const REALM_BY_TYPE = {
  "Design Reference": "INSPO",
  AI: "KNOWLEDGE",
  News: "CULTURE+NEWS",
};

const lower = (s) => String(s || "").toLowerCase();

/** Pull the Instagram shortcode out of a post URL. */
export function instagramShortcode(url) {
  const m = String(url || "").match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/** Normalize an @handle from a handle, URL, or raw string. */
export function normalizeHandle(input) {
  if (!input) return "";
  let s = String(input).trim().toLowerCase();
  const m = s.match(/instagram\.com\/([A-Za-z0-9_.]+)/i);
  if (m && !/^(p|reel|tv|explore|stories)$/i.test(m[1])) return m[1].toLowerCase();
  s = s.replace(/^@/, "");
  return /^[a-z0-9_.]+$/.test(s) ? s : "";
}

/**
 * Which axis does this ref sit on? Handle first (behavioural, reliable), then
 * text anchors. Returns null when nothing matches — the honest answer, and
 * what routes a ref to a paid tier later.
 */
export function axisFor({ handle = "", text = "" } = {}) {
  const h = normalizeHandle(handle);
  if (h && CURATORS[h]) return { axis: CURATORS[h].axis, why: `curator @${h}`, confidence: 0.9 };

  const hay = lower(`${h} ${text}`);
  for (const axis of TASTE_AXES) {
    const hit = axis.anchors.find((a) => hay.includes(a));
    if (hit) return { axis: axis.id, why: `matched "${hit}"`, confidence: 0.6 };
  }
  return null;
}

/**
 * Classify one ref into a realm, with tag suggestions and a reason.
 *
 * Confidence is deliberately conservative: anything below ~0.7 should be
 * treated as a proposal to look at, not an answer. `why` exists so a swipe
 * decision can be made in one second without opening the ref.
 *
 * @returns {{realm:string, axis:string|null, tags:string[], confidence:number, why:string, tier:number}}
 */
export function classify(ref = {}) {
  const type = ref.type || ref.Type || "";
  const sourceApp = ref.sourceApp || ref["Source App"] || "";
  const notes = ref.notes || ref.Notes || "";
  const name = ref.name || ref.Name || ref.title || "";
  const url = ref.url || ref["userDefined:URL"] || "";
  const handle = normalizeHandle(ref.handle || "");
  const text = `${name} ${notes}`;
  const hay = lower(text);

  const reasons = [];
  let realm = REALM_BY_TYPE[type] || null;
  if (realm) reasons.push(`Type=${type}`);

  // A newsletter about model evals is KNOWLEDGE even though it arrived as News.
  if (KNOWLEDGE_SOURCES.some((s) => hay.includes(s))) {
    realm = "KNOWLEDGE";
    reasons.push("known knowledge source");
  }

  // Taste publications are reference material, not headlines.
  const pub = TASTE_PUBLICATIONS.find((p) => hay.includes(p) || lower(url).includes(p));
  if (pub && realm === "CULTURE+NEWS") {
    realm = "INSPO";
    reasons.push(`taste publication ${pub}`);
  }

  const axisHit = axisFor({ handle, text });
  const axis = axisHit ? AXIS_BY_ID.get(axisHit.axis) : null;
  if (axisHit) reasons.push(axisHit.why);

  // A curator handle is stronger evidence than the coarse Type bucket.
  if (axis && axisHit.confidence >= 0.9) {
    realm = axis.realm;
    reasons.push(`axis realm ${axis.realm}`);
  }

  if (!realm) {
    realm = "INSPO";
    reasons.push("defaulted");
  }

  // Confidence: Type alone is solid; a known curator is better; nothing is weak.
  let confidence = 0.5;
  if (type) confidence = 0.75;
  if (axisHit) confidence = Math.max(confidence, axisHit.confidence);
  if (!type && !axisHit) confidence = 0.3;

  // A bare "Instagram" title with no notes tells us nothing on its own.
  const bare = lower(name) === "instagram" && !notes;
  if (bare && !handle) confidence = Math.min(confidence, 0.35);

  return {
    realm,
    axis: axis ? axis.id : null,
    tags: axis ? [...axis.tags] : [],
    confidence: Number(confidence.toFixed(2)),
    why: reasons.join(" · "),
    // Which cost tier resolved this. 0 = free deterministic code.
    tier: 0,
    needsHelp: confidence < 0.6,
  };
}

/**
 * Build a display title for a ref that Notion only knows as "Instagram".
 * Uses whatever identity we recovered; falls back to the shortcode so at
 * minimum the rows stop being 1,216 identical strings.
 */
export function titleFor(ref = {}, handle = "") {
  const name = String(ref.name || ref.Name || "").trim();
  if (name && lower(name) !== "instagram") return name;
  const h = normalizeHandle(handle);
  const code = instagramShortcode(ref.url || ref["userDefined:URL"] || "");
  if (h && code) return `@${h} · ${code}`;
  if (h) return `@${h}`;
  return code ? `Instagram · ${code}` : name || "Untitled";
}

/** Summary of a batch of classifications — what the morning brief reports. */
export function summarize(results) {
  const byRealm = {};
  const byAxis = {};
  let needsHelp = 0;
  for (const r of results) {
    byRealm[r.realm] = (byRealm[r.realm] || 0) + 1;
    if (r.axis) byAxis[r.axis] = (byAxis[r.axis] || 0) + 1;
    if (r.needsHelp) needsHelp++;
  }
  return { total: results.length, byRealm, byAxis, needsHelp };
}
