// Tests for the sourcing-gap finder: what he keeps saving that he can't rent.
// Mocks KV, Workers AI, both Vectorize indexes and the Anthropic call, so the
// whole walk -> embed -> query -> cluster -> rank -> summarise path runs offline.
// Run: node test/gaps.test.mjs
import {
  findGaps,
  summariseGaps,
  clusterGaps,
  cosine,
  labelTerms,
  DEFAULT_SIM,
} from "../src/gaps.js";
import { embedTextFor, embedTextForItem, METADATA_TOPK_MAX } from "../src/embed.js";

let pass = 0, fail = 0;
function ok(label, cond) { cond ? pass++ : (fail++, console.error("✗ " + label)); }
function eq(label, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}

// ---- KV ----
function makeKV() {
  const store = new Map();
  return {
    async get(name, type) {
      const e = store.get(name);
      if (!e) return null;
      return type === "json" ? JSON.parse(e) : e;
    },
    async put(name, value) { store.set(name, value); },
    async delete(name) { store.delete(name); },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? names.indexOf(cursor) + 1 : 0;
      const slice = names.slice(start, start + limit);
      const complete = start + limit >= names.length;
      return { keys: slice.map((name) => ({ name })), list_complete: complete, cursor: complete ? undefined : slice[slice.length - 1] };
    },
    _keys: () => [...store.keys()],
  };
}

// ---- Workers AI ----
// Same deterministic bag-of-words embedding as brain-routes.test.mjs: words
// hash into buckets, so texts sharing vocabulary really do land near each other
// under cosine. 64 buckets rather than 32 — this test asserts that two
// unrelated clusters stay apart, and a hash collision at 32 dims could make
// "chrome harness" and "latex balloon" look related for the wrong reason.
const DIMS = 64;
function fakeEmbed(text) {
  const v = new Array(DIMS).fill(0);
  for (const w of String(text).toLowerCase().match(/[a-z]{2,}/g) || []) {
    let h = 0;
    for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
    v[h % DIMS] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

let aiCalls = { embed: 0, chat: 0 };
const AI = {
  async run(model, input) {
    if (model.includes("bge")) {
      aiCalls.embed++;
      return { data: input.text.map(fakeEmbed) };
    }
    aiCalls.chat++;
    return { response: "cheap model answering" };
  },
};

// ---- Vectorize ----
function makeIndex() {
  const vecs = new Map();
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  return {
    maxTopK: 0,
    queries: 0,
    async upsert(list) { for (const v of list) vecs.set(v.id, { values: v.values, metadata: v.metadata || {} }); },
    async getByIds(ids) { return ids.map((id) => (vecs.has(id) ? { id, ...vecs.get(id) } : null)).filter(Boolean); },
    async query(vector, { topK = 10 } = {}) {
      this.queries++;
      if (topK > this.maxTopK) this.maxTopK = topK;
      const matches = [...vecs.entries()]
        .map(([id, v]) => ({ id, score: dot(vector, v.values), metadata: v.metadata }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return { matches };
    },
    _size: () => vecs.size,
  };
}

// ---- the archive under test ----
// One ref the warehouse covers, one 4-ref cluster it can't, one 2-ref cluster
// it can't, and one lone orphan.
const INVENTORY = [
  { id: "inv-sofa", title: "Velvet Sofa", description: "deep green tufted velvet", category: "Seating" },
  { id: "inv-cart", title: "Steel Trolley", description: "stainless rolling hospital", category: "Carts" },
  { id: "inv-lamp", title: "Brass Floor Lamp", description: "warm brass shade", category: "Lighting" },
];

const REFS = [
  { id: "r-sofa", title: "deep green tufted velvet sofa", category: "link" },
  { id: "r-chrome-1", title: "chrome mesh harness buckle rig", category: "link" },
  { id: "r-chrome-2", title: "chrome mesh harness strap rig", category: "link" },
  { id: "r-chrome-3", title: "chrome mesh harness body rig", category: "link" },
  { id: "r-chrome-4", title: "chrome mesh harness welded rig", category: "link" },
  { id: "r-latex-1", title: "inflatable latex balloon suit", category: "link" },
  { id: "r-latex-2", title: "inflatable latex balloon dress", category: "link" },
  { id: "r-bird", title: "taxidermy pigeon diorama dome", category: "link" },
];

const CHROME = REFS.filter((r) => r.id.startsWith("r-chrome")).map((r) => r.id);

/** A fresh world: KV loaded with the refs, INV_VECTORS loaded with inventory. */
async function makeEnv({ primeVectors = true, ceiling } = {}) {
  const REFS_KV = makeKV();
  for (const ref of REFS) await REFS_KV.put(`ref:${ref.id}`, JSON.stringify(ref));

  const VECTORS = makeIndex();
  if (primeVectors) {
    await VECTORS.upsert(REFS.map((r) => ({ id: r.id, values: fakeEmbed(embedTextFor(r)), metadata: { title: r.title } })));
  }

  const INV_VECTORS = makeIndex();
  await INV_VECTORS.upsert(
    INVENTORY.map((it) => ({
      id: it.id,
      values: fakeEmbed(embedTextForItem(it)),
      metadata: { title: it.title, category: it.category, slug: it.id, image: "" },
    }))
  );

  const env = { REFS_KV, AI, VECTORS, INV_VECTORS };
  if (ceiling !== undefined) env.NIGHTLY_CEILING_USD = ceiling;
  return env;
}

// ---- Anthropic stand-in, so the deep tier exercises the real callClaude path ----
let deepReply = '{"clusters":[{"i":0,"label":"chrome mesh body rigs","source":"buy three chrome mesh harnesses from a rigging supplier"}]}';
let deepCalls = 0;
globalThis.fetch = async (url) => {
  if (String(url).includes("api.anthropic.com")) {
    deepCalls++;
    return new Response(JSON.stringify({ content: [{ type: "text", text: deepReply }] }), {
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("", { status: 404 });
};

const run = async () => {
  // ------------------------------------------------------------ pure pieces
  const a = fakeEmbed("chrome mesh harness");
  eq("cosine with itself is 1", Number(cosine(a, a).toFixed(6)), 1);
  eq("cosine of disjoint vocab is 0", cosine([1, 0, 0], [0, 1, 0]), 0);
  eq("cosine of a mismatched pair is 0, not NaN", cosine([1, 0], [1, 0, 0]), 0);
  eq("cosine of nothing is 0", cosine(null, [1]), 0);

  const terms = labelTerms([
    { title: "chrome mesh harness", tags: ["Material"] },
    { title: "chrome mesh rig", tags: ["Material"] },
    { title: "chrome buckle", tags: [] },
  ]);
  ok("label picks the shared word", terms.includes("chrome"));
  ok("label drops a word only one ref uses", !terms.includes("buckle"));

  // clusterGaps is pure: same vectors in, same grouping out
  const pureClusters = clusterGaps([
    { ref: { id: "a", title: "chrome mesh harness" }, vector: fakeEmbed("chrome mesh harness"), score: 0.1, nearest: null },
    { ref: { id: "b", title: "chrome mesh harness rig" }, vector: fakeEmbed("chrome mesh harness rig"), score: 0.1, nearest: null },
    { ref: { id: "c", title: "taxidermy pigeon dome" }, vector: fakeEmbed("taxidermy pigeon dome"), score: 0.2, nearest: null },
  ]);
  eq("pure clustering finds two groups", pureClusters.length, 2);
  eq("the pair clusters together", pureClusters[0].size, 2);
  eq("minSize drops the singleton", clusterGaps([
    { ref: { id: "a", title: "chrome mesh" }, vector: fakeEmbed("chrome mesh"), score: 0.1, nearest: null },
  ], { minSize: 2 }).length, 0);

  // ------------------------------------------------------------- the pass
  let env = await makeEnv();
  let out = await findGaps(env, { sample: 50 });

  eq("pass ok", out.ok, true);
  eq("walked every ref", out.scanned, REFS.length);
  eq("got an inventory answer for every ref", out.compared, REFS.length);
  eq("no errors on the happy path", out.errors.length, 0);

  const gapIds = out.clusters.flatMap((c) => c.refIds);
  ok("a ref the warehouse covers is NOT a gap", !gapIds.includes("r-sofa"));
  eq("exactly one ref was covered", out.covered, 1);
  ok("a ref with nothing near it IS a gap", gapIds.includes("r-chrome-1"));
  ok("the latex refs are gaps too", gapIds.includes("r-latex-1") && gapIds.includes("r-latex-2"));
  eq("every uncovered ref is accounted for", out.gaps, REFS.length - 1);

  // clustering groups similar refs
  eq("three distinct clusters", out.clusterCount, 3);
  const chrome = out.clusters.find((c) => c.refIds.includes("r-chrome-1"));
  eq("all four chrome refs land in one cluster", chrome.size, 4);
  ok("and nothing else got swept in", chrome.refIds.every((id) => CHROME.includes(id)));
  const latex = out.clusters.find((c) => c.refIds.includes("r-latex-1"));
  eq("the latex pair is its own cluster", latex.size, 2);

  // ranking: biggest × furthest first
  eq("the biggest cluster ranks first", out.clusters[0].size, 4);
  ok("rank is size × distance", out.clusters[0].rank >= out.clusters[1].rank);
  ok("ranks descend", out.clusters.every((c, i, arr) => i === 0 || arr[i - 1].rank >= c.rank));

  // what each cluster hands him
  ok("cluster carries representative refs", chrome.refs.length > 0 && chrome.refs[0].title.length > 0);
  ok("cluster names itself from shared words", chrome.terms.includes("chrome"));
  ok("cluster has a one-line label", /chrome/.test(chrome.label) && /4 saved/.test(chrome.label));
  ok("cluster reports the near miss", chrome.nearest && typeof chrome.nearest.title === "string");
  ok("the near miss really is a miss", chrome.nearest.score < out.threshold);
  ok("report echoes the threshold it used", out.threshold > 0);

  // reuse: everything was already in VECTORS, so nothing was re-embedded
  eq("reused the vectors already indexed", out.reused, REFS.length);
  eq("nothing was embedded twice", out.embedded, 0);

  // ------------------------------------------------- embedding when needed
  env = await makeEnv({ primeVectors: false });
  aiCalls.embed = 0;
  out = await findGaps(env, { sample: 50 });
  eq("unindexed refs still get compared", out.compared, REFS.length);
  eq("they were embedded on the fly", out.embedded, REFS.length);
  eq("nothing to reuse", out.reused, 0);
  ok("the embedding model was called", aiCalls.embed > 0);
  ok("the tier-2 spend was booked", env.REFS_KV._keys().some((k) => k.startsWith("budget:")));

  // ------------------------------------------------------------ the topK cap
  env = await makeEnv();
  out = await findGaps(env, { sample: 50, topK: 99 });
  eq("topK is clamped in the report", out.topK, METADATA_TOPK_MAX);
  ok("and never reaches Vectorize above the cap", env.INV_VECTORS.maxTopK <= METADATA_TOPK_MAX);
  eq("the cap really is 20", METADATA_TOPK_MAX, 20);
  ok("results survive the clamp", out.clusterCount > 0);

  // ------------------------------------------------------- missing bindings
  const kvOnly = { REFS_KV: (await makeEnv()).REFS_KV, AI };
  let res = await findGaps(kvOnly, { sample: 5 }).catch((e) => ({ threw: String(e) }));
  ok("no INV_VECTORS -> error object, not a throw", res.ok === false && !res.threw);
  ok("and the error names the binding", /INV_VECTORS/.test(res.error));

  res = await findGaps({}, { sample: 5 }).catch((e) => ({ threw: String(e) }));
  ok("no KV -> error object", res.ok === false && !res.threw && /REFS_KV/.test(res.error));

  res = await findGaps({ REFS_KV: kvOnly.REFS_KV, INV_VECTORS: makeIndex() }, {}).catch((e) => ({ threw: String(e) }));
  ok("no AI -> error object", res.ok === false && !res.threw && /AI binding/.test(res.error));

  // VECTORS missing is survivable — embed everything and say so
  env = await makeEnv();
  delete env.VECTORS;
  out = await findGaps(env, { sample: 50 });
  eq("works with no ref index at all", out.ok, true);
  eq("everything had to be embedded", out.embedded, REFS.length);
  ok("and it said so rather than pretending", out.errors.some((e) => /VECTORS binding missing/.test(e.error)));

  // ------------------------------------- a rejected query is never an answer
  // The rule this whole file is written around: "the query failed" and "we own
  // nothing like it" must never come back as the same empty result.
  env = await makeEnv();
  env.INV_VECTORS = { async query() { throw new Error("topK too large"); }, async getByIds() { return []; } };
  out = await findGaps(env, { sample: 50 });
  eq("a rejected index still returns ok", out.ok, true);
  eq("but reports zero comparisons", out.compared, 0);
  eq("and invents no gaps", out.gaps, 0);
  eq("every failure is surfaced", out.errors.length, REFS.length);
  ok("with the reason attached", /topK too large/.test(out.errors[0].error));

  // ------------------------------------------------------------- deep tier
  env = await makeEnv();
  const before = deepCalls;
  out = await findGaps(env, { sample: 50 });
  eq("no deep flag, no frontier call", deepCalls, before);
  ok("deep flag absent is reported as raw clusters", out.summarised === undefined);

  env = await makeEnv();
  env.ANTHROPIC_API_KEY = "sk-test";
  out = await findGaps(env, { sample: 50, deep: true });
  eq("deep summarised the clusters", out.summarised, true);
  eq("the frontier tier was called once", deepCalls, before + 1);
  eq("the summary lands on the top cluster", out.clusters[0].summary, "chrome mesh body rigs");
  ok("with a sourcing line", out.clusters[0].sourcing.includes("rigging supplier"));
  ok("the deterministic label is NOT overwritten", /chrome/.test(out.clusters[0].label) && /4 saved/.test(out.clusters[0].label));
  ok("the frontier spend was booked", env.REFS_KV._keys().some((k) => k.startsWith("budget:")));

  // the governor refuses -> raw clusters, with the reason.
  // A tenth of a cent won't cover a frontier call; the vectors are already
  // indexed, so the tier-2 embed spend never comes into it.
  env = await makeEnv({ ceiling: 0.001 });
  env.ANTHROPIC_API_KEY = "sk-test";
  const refused = deepCalls;
  out = await findGaps(env, { sample: 50, deep: true });
  eq("budget refusal still returns clusters", out.ok, true);
  ok("and they're intact", out.clusters.length === 3 && out.clusters[0].size === 4);
  eq("nothing was spent", deepCalls, refused);
  eq("not summarised", out.summarised, false);
  ok("the refusal is explained", /ceiling/.test(out.deepSkipped || ""));

  // an unparseable answer is not a silent success
  env = await makeEnv();
  env.ANTHROPIC_API_KEY = "sk-test";
  deepReply = "sure, here are some thoughts about harnesses";
  out = await findGaps(env, { sample: 50, deep: true });
  eq("garbage from the model -> not summarised", out.summarised, false);
  ok("clusters come back untouched", out.clusters[0].size === 4 && out.clusters[0].summary === undefined);
  ok("and the failure is in errors", out.errors.some((e) => e.stage === "deep"));
  deepReply = '{"clusters":[{"i":0,"label":"chrome mesh body rigs","source":"buy three chrome mesh harnesses from a rigging supplier"}]}';

  // summariseGaps standalone, for a route that only wants the prose
  env = await makeEnv();
  env.ANTHROPIC_API_KEY = "sk-test";
  const raw = await findGaps(env, { sample: 50 });
  const only = await summariseGaps(env, raw.clusters, { deep: false });
  eq("no deep flag -> no work", only.summarised, false);
  ok("and it says why", /deep flag/.test(only.reason));
  const summed = await summariseGaps(env, raw.clusters, { deep: true });
  eq("standalone summarise works", summed.summarised, true);
  ok("empty input is handled", (await summariseGaps(env, [], { deep: true })).summarised === false);

  // ------------------------------------------------------------- paging
  env = await makeEnv();
  const p1 = await findGaps(env, { sample: 3 });
  eq("a bounded pass reads only its page", p1.scanned, 3);
  eq("and hands back a cursor", p1.done, false);
  ok("cursor is usable", typeof p1.cursor === "string");
  const p2 = await findGaps(env, { sample: 100, cursor: p1.cursor });
  eq("the second pass finishes the archive", p2.scanned, REFS.length - 3);
  eq("and knows it's done", p2.done, true);

  // ------------------------------------------------------------- knobs
  env = await makeEnv();
  const loose = await findGaps(env, { sample: 50, threshold: 0.01 });
  eq("a low threshold means nothing is a gap", loose.gaps, 0);
  const strict = await findGaps(env, { sample: 50, threshold: 0.99 });
  eq("a high threshold means everything is", strict.gaps, REFS.length);
  const wide = await findGaps(env, { sample: 50, sim: 0.01 });
  eq("a loose sim collapses everything into one cluster", wide.clusterCount, 1);
  eq("DEFAULT_SIM is what the default pass used", (await findGaps(env, { sample: 50 })).sim, DEFAULT_SIM);
  const big = await findGaps(env, { sample: 50, minSize: 2 });
  ok("minSize drops the orphan", big.clusters.every((c) => c.size >= 2));

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
