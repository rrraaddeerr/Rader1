// Tests for the phone map — the hierarchy that replaces the 1,698-node graph.
// Map-backed KV, fake vectors, no network, no bindings. The tree-shaping half
// is pure; the build/read half runs against the fakes.
// Run: node test/map.test.mjs
import vm from "node:vm";
import {
  slug,
  shortAxisLabel,
  regionOf,
  cardFor,
  representativeImage,
  samplesFor,
  labelForCluster,
  groupRegions,
  fallbackKeyFor,
  clusterRegion,
  buildMapTree,
  mapTree,
  mapStatus,
  INDEX_KEY,
  regionKey,
  clusterKey,
  NEIGHBOUR_TOPK,
  MAX_REGIONS,
  MIN_CLUSTER,
} from "../src/mapdata.js";
import { METADATA_TOPK_MAX } from "../src/embed.js";
import { MAP_HTML } from "../src/pages/map.js";

let pass = 0, fail = 0;
function ok(label, cond) { cond ? pass++ : (fail++, console.error("✗ " + label)); }
function eq(label, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}

function makeKV() {
  const store = new Map();
  const kv = {
    reads: 0,
    failList: false,
    async get(name, type) {
      kv.reads++;
      const e = store.get(name);
      if (!e) return null;
      return type === "json" ? JSON.parse(e) : e;
    },
    async put(name, value) { store.set(name, value); },
    async delete(name) { store.delete(name); },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      if (kv.failList) throw new Error("KV list is down");
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? names.indexOf(cursor) + 1 : 0;
      const slice = names.slice(start, start + limit);
      const complete = start + limit >= names.length;
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: complete,
        cursor: complete ? undefined : slice[slice.length - 1],
      };
    },
    _store: store,
  };
  return kv;
}

/** A ref as KV holds it. Ids sort reverse-chronologically, so seq drives order. */
function ref(seq, extra = {}) {
  const id = String(1_000_000 - seq).padStart(7, "0") + "-aaaa";
  return {
    id,
    title: extra.title || `Ref ${seq}`,
    url: `https://ref.test/${seq}`,
    host: extra.host || "ref.test",
    category: extra.category || "image",
    image: extra.image === undefined ? `https://img.test/${seq}.jpg` : extra.image,
    ...extra,
  };
}

/**
 * A stand-in for Vectorize that enforces the one rule that keeps biting:
 * topK above 20 with metadata is REFUSED, not truncated.
 */
function makeVectors(ids, neighboursOf) {
  const order = [...ids];
  const calls = [];
  return {
    calls,
    async getByIds(list) {
      return list.map((id) => ({ id, values: [order.indexOf(id)] }));
    },
    async query(vector, { topK = 10, returnMetadata = false } = {}) {
      calls.push({ topK, returnMetadata });
      if (returnMetadata === "all" && topK > 20) throw new Error("topK too large for metadata");
      const id = order[vector[0]];
      return { matches: (neighboursOf(id) || []).slice(0, topK).map((x) => ({ id: x, score: 0.9 })) };
    },
  };
}

// --------------------------------------------------------------- pure shaping
eq("slugs a realm", slug("CULTURE+NEWS"), "culture-news");
eq("slug never empty", slug("!!!"), "x");
eq("trims an axis label to card size", shortAxisLabel("set-design"), "Set design");
eq("cuts at an ampersand", shortAxisLabel("post-internet-fashion"), "Post-internet fashion");
eq("unknown axis has no label", shortAxisLabel("nope"), "");

eq("a stored realm wins", regionOf({ realm: "KNOWLEDGE", title: "set design" }).realm, "KNOWLEDGE");
eq("a stored axis wins", regionOf({ realm: "INSPO", axis: "set-design" }).axis, "set-design");
eq("an axis is re-derived from the title", regionOf({ realm: "INSPO", title: "Gary Card window" }).axis, "set-design");
eq("no axis is null, not guessed", regionOf({ realm: "INSPO", title: "zzz qqq" }).axis, null);
eq("a junk realm falls back to the classifier", typeof regionOf({ realm: "NONSENSE" }).realm, "string");

const card = cardFor({ id: "a", title: "T", image: "i", host: "h.com", url: "u", category: "video", body: "huge" });
eq("card keeps only what the phone renders", Object.keys(card).sort().join(","), "caption,category,host,id,image,title,url");
{
  const cards = [
    { image: "a.jpg" }, { image: "" , caption: "no picture" }, { image: "b.jpg", caption: "a curtain rig" },
    { image: "a.jpg", caption: "" }, { image: "c.jpg" }, { image: "d.jpg", caption: "mirror" },
  ];
  const s = samplesFor(cards, 3);
  eq("samples put captioned pictures first", s.map((x) => x.image).join(","), "b.jpg,d.jpg,a.jpg");
  ok("never a sample without an image", samplesFor(cards, 9).every((x) => x.image));
  eq("and never the same picture twice", samplesFor(cards, 9).length, 4);
  eq("empty in, empty out", samplesFor([], 4).length, 0);
}
eq("card falls back to the host for a title", cardFor({ host: "h.com" }).title, "h.com");
eq("blank ref still makes a card", cardFor({}).title, "Untitled");

eq("representative image is the first one present", representativeImage([{ image: "" }, { image: "b" }, { image: "c" }]), "b");
eq("no images -> empty, not undefined", representativeImage([{ image: "" }]), "");
eq("no cards -> empty", representativeImage([]), "");

// --------------------------------------------------------------- cluster labels
eq(
  "a shared tag names the cluster",
  labelForCluster([{ tags: ["Fashion"] }, { tags: ["Fashion"] }, { tags: ["Set"] }]),
  "Fashion"
);
eq(
  "a minority tag does not name it",
  labelForCluster(Array.from({ length: 10 }, (_, i) => ({ tags: i === 0 ? ["Fashion"] : [], host: "a.com", category: "image" }))),
  "a.com"
);
eq(
  "a dominant host names it",
  labelForCluster([{ host: "www.dazed.com" }, { host: "dazed.com" }, { host: "other.com" }]),
  "dazed.com"
);
eq(
  "a recurring title word names it",
  labelForCluster([
    { title: "chrome tailoring one", host: "a.com" },
    { title: "chrome study", host: "b.com" },
    { title: "chrome rig", host: "c.com" },
    { title: "unrelated", host: "d.com" },
  ]),
  "Chrome"
);
eq(
  "kind is the last resort",
  labelForCluster([
    { title: "aa", host: "a.com", category: "video" },
    { title: "bb", host: "b.com", category: "video" },
    { title: "cc", host: "c.com", category: "video" },
  ]),
  "videos"
);
eq("nothing in common -> Assorted", labelForCluster([
  { title: "aa", host: "a.com", category: "video" },
  { title: "bb", host: "b.com", category: "image" },
  { title: "cc", host: "c.com", category: "note" },
]), "Assorted");
eq("empty cluster says so", labelForCluster([]), "Empty");

// --------------------------------------------------------------- regions
const many = [];
for (let i = 0; i < 40; i++) many.push({ ...cardFor(ref(i)), region: { realm: "INSPO", axis: "set-design" } });
for (let i = 0; i < 30; i++) many.push({ ...cardFor(ref(100 + i)), region: { realm: "INSPO", axis: null } });
for (let i = 0; i < 5; i++) many.push({ ...cardFor(ref(200 + i)), region: { realm: "INSPO", axis: "internet-humor" } });
for (let i = 0; i < 12; i++) many.push({ ...cardFor(ref(300 + i)), region: { realm: "KNOWLEDGE", axis: null } });

const regions = groupRegions(many);
eq("regions stay a handful", regions.length <= MAX_REGIONS, true);
eq("biggest region first", regions[0].id, "inspo--set-design");
eq(
  "nothing is lost in the folding",
  regions.reduce((n, r) => n + r.count, 0),
  many.length
);
const inspoAll = regions.find((r) => r.id === "inspo--all");
eq("a too-small axis folds into its realm", inspoAll.count, 35);
eq("a folded region says it is the remainder", inspoAll.sublabel, "everything else");
eq("an axis region is labelled by its axis", regions[0].label, "Set design");
ok("a region carries a representative image", Boolean(regions[0].image));

// Under a hard cap the axis regions fold away first. The realm catch-alls are
// the floor — there are only four realms, so that floor is always a handful.
const squeezed = groupRegions(many, { maxRegions: 2, minRegion: 1 });
ok("the cap folds axis regions away", !squeezed.some((r) => r.axis === "internet-humor"));
ok("down to the realm floor", squeezed.every((r) => !r.axis) || squeezed.length <= 3);
eq("and still loses nothing", squeezed.reduce((n, r) => n + r.count, 0), many.length);

eq("fallback key prefers a tag", fallbackKeyFor({ tags: ["Set"], category: "image" }), "Set");
eq("then the kind", fallbackKeyFor({ category: "image", host: "a.com" }), "image");
eq("then the host", fallbackKeyFor({ host: "www.a.com" }), "a.com");
eq("then something", fallbackKeyFor({}), "other");

// --------------------------------------------------------------- clustering
const members = Array.from({ length: 24 }, (_, i) => cardFor(ref(i)));
const ids = members.map((m) => m.id);
// Three tidy neighbourhoods of eight.
const groupOf = (id) => ids.slice(Math.floor(ids.indexOf(id) / 8) * 8, Math.floor(ids.indexOf(id) / 8) * 8 + 8);
const neighbours = async (id) => ({ ids: groupOf(id), error: null });

const clustered = await clusterRegion(members, neighbours, { target: 8 });
eq("one query per neighbourhood", clustered.queries, 3);
eq("three clusters", clustered.clusters.length, 3);
eq("everything is placed", clustered.clusters.reduce((n, c) => n + c.cards.length, 0), 24);
eq("all of it came from the vectors", clustered.byVector, 24);
eq("and it says so", clustered.clusters[0].via, "vector");
ok("no ref lands in two clusters", new Set(clustered.clusters.flatMap((c) => c.cards.map((x) => x.id))).size === 24);

const budgeted = await clusterRegion(members, neighbours, { target: 8, budget: 1 });
eq("the query budget is respected", budgeted.queries, 1);
eq("what the budget didn't reach still lands", budgeted.clusters.reduce((n, c) => n + c.cards.length, 0), 24);
ok("and is marked as rule-grouped", budgeted.clusters.some((c) => c.via === "rule"));
eq("the split is reported honestly", budgeted.byVector + budgeted.byRule, 24);

// A rejected query is NOT an empty neighbourhood. This is the failure mode that
// has cost this project hours three times, so it is asserted, not assumed.
const broken = await clusterRegion(members, async () => ({ ids: [], error: "topK too large for metadata" }), { target: 8 });
ok("a rejected query is surfaced", broken.errors.length > 0);
eq("with its reason intact", broken.errors[0].error, "topK too large for metadata");
eq("no cluster claims to be a neighbourhood", broken.byVector, 0);
eq("but the refs still all land", broken.clusters.reduce((n, c) => n + c.cards.length, 0), 24);

const noVectors = await clusterRegion(members, null, { target: 8 });
eq("no vector index -> no queries", noVectors.queries, 0);
eq("still every ref placed", noVectors.clusters.reduce((n, c) => n + c.cards.length, 0), 24);
ok("all of it rule-grouped", noVectors.clusters.every((c) => c.via === "rule"));

// The rules must not blow past the clusters screen when they carry a whole
// region. 600 refs of one kind is the no-Vectorize worst case.
const flood = Array.from({ length: 600 }, (_, i) => cardFor(ref(i, { host: `h${i % 40}.com` })));
const capped = await clusterRegion(flood, null, { target: 8, maxClusters: 10 });
ok("the clusters screen stays a screen", capped.clusters.length <= 10);
eq("and not one ref is dropped", capped.clusters.reduce((n, c) => n + c.cards.length, 0), 600);

const tiny = await clusterRegion(members.slice(0, MIN_CLUSTER - 1), neighbours, { target: 8 });
eq("a region smaller than a cluster is still shown", tiny.clusters.reduce((n, c) => n + c.cards.length, 0), MIN_CLUSTER - 1);

// --------------------------------------------------------------- the topK ceiling
eq("neighbour topK never exceeds the metadata ceiling", NEIGHBOUR_TOPK <= METADATA_TOPK_MAX, true);

// --------------------------------------------------------------- build + read
function seedArchive(kv, n = 62) {
  const refs = [];
  for (let i = 0; i < 30; i++) refs.push(ref(i, { realm: "INSPO", axis: "set-design", title: `Gary Card ${i}` }));
  for (let i = 0; i < 22; i++) refs.push(ref(100 + i, { realm: "INSPO", title: `Untagged thing ${i}` }));
  for (let i = 0; i < 10; i++) refs.push(ref(200 + i, { realm: "KNOWLEDGE", title: `Paper ${i}`, category: "article" }));
  for (const r of refs.slice(0, n)) kv._store.set(`ref:${r.id}`, JSON.stringify(r));
  return refs.slice(0, n);
}

const kv = makeKV();
const seeded = seedArchive(kv);
const allIds = seeded.map((r) => r.id);
const vectors = makeVectors(allIds, (id) => {
  const i = allIds.indexOf(id);
  const start = Math.floor(i / 10) * 10;
  return allIds.slice(start, start + 10);
});
const env = { REFS_KV: kv, VECTORS: vectors };

const built = await buildMapTree(env, { now: new Date("2026-08-02T04:00:00Z") });
eq("the build succeeds", built.ok, true);
eq("it saw every ref", built.refs, seeded.length);
eq("nothing unreadable", built.unreadable, 0);
eq("nothing truncated", built.truncated, false);
ok("it used the vector index", built.clustering.vectors && built.clustering.byVector > 0);
ok("no build errors", built.errors.length === 0);
ok("never asked Vectorize for more than it allows", vectors.calls.every((c) => c.topK <= METADATA_TOPK_MAX));
ok("and asked for no metadata it doesn't need", vectors.calls.every((c) => !c.returnMetadata));
eq(
  "the regions account for every ref",
  built.regions.reduce((n, r) => n + r.count, 0),
  seeded.length
);
ok("an index key was written", kv._store.has(INDEX_KEY));

// --- reading one level at a time ---
kv.reads = 0;
const top = await mapTree(env, {});
eq("the top level is regions", top.level, "regions");
eq("one KV read per level", kv.reads, 1);
eq("regions read ok", top.ok, true);
eq("regions are a handful", top.nodes.length <= MAX_REGIONS, true);
eq("the total is the archive", top.total, seeded.length);
eq("the breadcrumb starts at the map", top.path[0].label, "Map");
ok("every region card has a count", top.nodes.every((n) => typeof n.count === "number"));
ok("the phone is never handed a ref at this level", !JSON.stringify(top.nodes).includes("https://ref.test/"));

const bigRegion = top.nodes[0];
kv.reads = 0;
const mid = await mapTree(env, { region: bigRegion.id });
eq("a region resolves into clusters", mid.level, "clusters");
eq("still one KV read", kv.reads, 1);
eq("the cluster count matches the region card", mid.nodes.length, bigRegion.clusterCount);
eq("the clusters cover the region", mid.nodes.reduce((n, c) => n + c.count, 0), bigRegion.count);
eq("the breadcrumb has two steps", mid.path.length, 2);
eq("and names the region", mid.path[1].label, bigRegion.label);

kv.reads = 0;
const leaf = await mapTree(env, { cluster: mid.nodes[0].id });
eq("a cluster resolves into refs", leaf.level, "refs");
eq("still one KV read", kv.reads, 1);
eq("the refs are the cluster", leaf.nodes.length, mid.nodes[0].count);
eq("the breadcrumb has three steps", leaf.path.length, 3);
eq("and knows its region", leaf.path[1].id, bigRegion.id);
ok("a ref carries what a tile needs", leaf.nodes.every((n) => n.id && n.title));

eq("depth can force the top level", (await mapTree(env, { depth: "regions", region: bigRegion.id })).level, "regions");
eq("numeric depth works too", (await mapTree(env, { depth: 1, region: bigRegion.id })).level, "clusters");

// --- the honest failures ---
const missing = await mapTree(env, { cluster: "nope--all-c99" });
eq("a cluster that isn't there fails loudly", missing.ok, false);
ok("with a reason", Boolean(missing.error));
eq("and no phantom refs", missing.nodes.length, 0);

const emptyEnv = { REFS_KV: makeKV() };
const unbuilt = await mapTree(emptyEnv, {});
eq("an unbuilt map is not an empty map", unbuilt.ok, false);
eq("it asks to be built", unbuilt.needsBuild, true);
ok("and says so in words", /hasn't been built/.test(unbuilt.error));

eq("no KV binding is explicit", (await mapTree({}, {})).error, "no KV binding");

const brokenKv = makeKV();
brokenKv.failList = true;
const brokenBuild = await buildMapTree({ REFS_KV: brokenKv }, {});
eq("a build that can't read refs fails", brokenBuild.ok, false);
ok("and keeps the reason", brokenBuild.error.includes("KV list is down"));

// --- degrading with no vector index ---
const kv2 = makeKV();
seedArchive(kv2);
const flat = await buildMapTree({ REFS_KV: kv2 }, {});
eq("it still builds with no Vectorize", flat.ok, true);
eq("and admits nothing was clustered by meaning", flat.clustering.byVector, 0);
eq("and says the index was absent", flat.clustering.vectors, false);
eq("every ref still landed", flat.regions.reduce((n, r) => n + r.count, 0), flat.refs);
const flatTop = await mapTree({ REFS_KV: kv2 }, {});
eq("and the phone can read it", flatTop.ok, true);

// --- rebuilding prunes what it no longer references ---
const before = [...kv._store.keys()].filter((k) => k.startsWith("map:") && k !== INDEX_KEY).length;
ok("the first build wrote region and cluster keys", before > 0);
for (const k of [...kv._store.keys()]) if (k.startsWith("ref:")) kv._store.delete(k);
const rebuilt = await buildMapTree(env, {});
eq("an empty archive rebuilds cleanly", rebuilt.ok, true);
eq("with no regions", rebuilt.regions.length, 0);
ok("and the old level keys are gone", [...kv._store.keys()].every((k) => !k.startsWith("map:v1:c:")));
ok("pruning is reported", rebuilt.pruned >= before);

// --- status ---
const st = await mapStatus(env);
eq("status reads the index", st.ok, true);
eq("status knows it is built", st.built, true);
eq("status on an unbuilt map", (await mapStatus(emptyEnv)).built, false);
eq("status with no KV", (await mapStatus({})).ok, false);

// --------------------------------------------------------------- the page
const scripts = MAP_HTML.match(/<script>([\s\S]*?)<\/script>/);
ok("the page has an inline script", Boolean(scripts));
try {
  new vm.Script(scripts[1], { filename: "map-inline.js" });
  pass++;
} catch (err) {
  fail++;
  console.error("✗ the inline script parses\n   " + err.message);
}

ok("the page reads the token from the same place as the others", MAP_HTML.includes('"bigbrain_token"'));
ok("it remembers where he was", MAP_HTML.includes("bigbrain_map_path"));
ok("it honours the back gesture", MAP_HTML.includes("popstate"));
ok("touch targets are declared once and reused", /--tap:\s*44px/.test(MAP_HTML));
ok("it uses the shared dark palette", MAP_HTML.includes("--bg:#0f1115") && MAP_HTML.includes("--blue:#3b82f6"));
ok("no force graph", !/d3|canvas|forceSimulation/i.test(MAP_HTML));
ok("no external assets", !/(src|href)="https?:\/\//.test(MAP_HTML));
ok("it opens on regions", MAP_HTML.includes('class="grid regions"'));
ok("it draws a skeleton so nothing reflows", MAP_HTML.includes("skeleton("));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
