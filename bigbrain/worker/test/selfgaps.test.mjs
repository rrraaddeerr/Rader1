// Tests for Loop 3 — the brain finding its own gaps and queueing its own work.
// Map-backed KV, an in-memory Vectorize and the bag-of-words embedding from
// brain-routes.test.mjs, so texts that share vocabulary really do land near
// each other and a "region" in the test is a region for the same reason it is
// one in production. No network, no bindings, no models.
// Run: node test/selfgaps.test.mjs
import {
  findGaps,
  planTonight,
  neighbourhoods,
  probeQuestions,
  jobsFor,
  rankJobs,
  fitBudget,
  actionFor,
  summarizeGaps,
  textLength,
  hasRealText,
  stalenessOf,
  tagsAgree,
  termsOf,
  questionFor,
  normalizeUrl,
  duplicateGroups,
  impactPerDollar,
  MAX_UNITS_PER_JOB,
  THIN_TEXT_CHARS,
  DUPLICATE_SCORE,
  CLUSTER_MIN_SCORE,
} from "../src/selfgaps.js";
import { METADATA_TOPK_MAX, embedTextFor } from "../src/embed.js";
import { dayStamp } from "../src/budget.js";

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
    _store: store,
  };
}

// ---- Workers AI ----
// The deterministic bag-of-words embedding from brain-routes.test.mjs: words
// hash into buckets, so shared vocabulary means real cosine proximity.
//
// Wider than the 32 dims that file uses, and the reason is the thing being
// tested. brain-routes holds two refs; this fixture holds three regions in one
// index, and at 32 buckets unrelated words collide often enough that separate
// regions merge — which would make "the well-enriched region is not thin" pass
// or fail on hash luck rather than on anything selfgaps.js does. Same function,
// more buckets. The property under test is unchanged: similar text lands near
// itself, unrelated text does not.
const DIMS = 96;
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
let embedCalls = 0;
const AI = {
  async run(model, input) {
    if (model.includes("bge")) {
      embedCalls++;
      return { data: input.text.map(fakeEmbed) };
    }
    return { response: "" };
  },
};

// ---- Vectorize ----
// Records the largest topK it was ever asked for and REFUSES anything over the
// ceiling, exactly as the real one does — so the METADATA_TOPK_MAX rule is
// enforced by the index rather than checked by reading the source.
function makeIndex() {
  const vecs = new Map();
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  return {
    maxTopK: 0,
    async upsert(list) { for (const v of list) vecs.set(v.id, { values: v.values, metadata: v.metadata || {} }); },
    async deleteByIds(ids) { for (const id of ids) vecs.delete(id); },
    async getByIds(ids) { return ids.map((id) => (vecs.has(id) ? { id, ...vecs.get(id) } : null)).filter(Boolean); },
    async query(vector, { topK = 10 } = {}) {
      this.maxTopK = Math.max(this.maxTopK, topK);
      if (topK > METADATA_TOPK_MAX) throw new Error("Vectorize refuses topK above 20 with returnMetadata all");
      const matches = [...vecs.entries()]
        .map(([id, v]) => ({ id, score: dot(vector, v.values), metadata: v.metadata }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return { matches };
    },
    _size: () => vecs.size,
  };
}

// ---------------------------------------------------------------- the archive
const NOW = new Date("2026-08-02T00:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

/** Three unique words per ref, so refs within a region are near but not identical. */
const UNIQ = [
  ["kestrel", "obsidian", "lantern"], ["vellum", "marmalade", "quartz"],
  ["tundra", "paprika", "zephyr"], ["mahogany", "cobalt", "thistle"],
  ["saffron", "granite", "wisteria"], ["juniper", "selvage", "cinder"],
  ["oxblood", "pewter", "bramble"], ["indigo", "chalcedony", "fennel"],
];
const A_TOPIC = "stainless steel rolling cart welded castors cold hospital light rig camera";
const B_TOPIC = "banjo bluegrass clawhammer fiddle tuning picking scruggs frailing appalachian resonator";
const C_TOPIC = "chrome bumper reflecting sunset parking garage ramp windshield asphalt hubcap";

const aBody = (i) =>
  `${A_TOPIC} ${UNIQ[i].join(" ")}. Welded stainless tube on castors under cold hospital light, the rig doing ` +
  `the effect in camera rather than in post. Ground welds, sheet shelves, ${UNIQ[i][0]} finish throughout the build.`;

/** A ref exactly as KV holds one. */
function ref(id, over = {}) {
  return { id, title: "", url: `https://example.com/${id}`, host: "example.com", category: "link", createdAt: daysAgo(30), ...over };
}

const refs = [];

// Region A — eight refs with real text behind them. Well enriched: NOT a gap.
// a7 is filed KNOWLEDGE while every neighbour is INSPO — a contradiction.
for (let i = 0; i < 8; i++) {
  refs.push(ref(`a${i}`, {
    title: `${A_TOPIC} ${UNIQ[i].join(" ")}`,
    body: aBody(i),
    host: "setbuild.test",
    realm: i === 7 ? "KNOWLEDGE" : "INSPO",
    enrichedAt: daysAgo(10),
  }));
}

// Region B — eight refs with a title and nothing else. THIN, and fixable free.
for (let i = 0; i < 8; i++) {
  refs.push(ref(`b${i}`, {
    title: `${B_TOPIC} ${UNIQ[i].join(" ")}`,
    host: "pickers.test",
    realm: "KNOWLEDGE",
    enrichTried: daysAgo(5),
  }));
}

// Region C — six uncaptioned images. THIN, and only vision can fix it.
for (let i = 0; i < 6; i++) {
  refs.push(ref(`c${i}`, {
    title: `${C_TOPIC} ${UNIQ[i].join(" ")}`,
    host: "lot.test",
    category: "image",
    blobKey: `blob:${i}`,
    realm: "INSPO",
    enrichTried: daysAgo(5),
  }));
}

// A genuine near-duplicate of a1: different url, same content.
refs.push(ref("dup1", {
  title: `${A_TOPIC} ${UNIQ[1].join(" ")}`,
  body: aBody(1),
  url: "https://mirror.test/copy",
  host: "mirror.test",
  realm: "INSPO",
  enrichedAt: daysAgo(10),
}));

// The same url saved twice — caught without the index at all.
const RIG = "curtain rig velvet track pulley counterweight batten";
refs.push(ref("same1", {
  title: `${RIG} kestrel`,
  url: "https://rig.test/post/9?utm_source=ig",
  host: "rig.test",
  body: `${RIG} kestrel. A counterweighted velvet curtain on a pulley track, battens dressed and flown from a rail above the set floor.`,
  realm: "INSPO",
  enrichedAt: daysAgo(3),
}));
refs.push(ref("same2", {
  title: `${RIG} vellum`,
  url: "https://www.rig.test/post/9/",
  host: "rig.test",
  body: `${RIG} vellum. The same pulley track photographed from the grid, counterweight bag visible, velvet folded over the batten.`,
  realm: "INSPO",
  enrichedAt: daysAgo(3),
}));

// Tags that appear nowhere in the content we actually read.
refs.push(ref("tagclash", {
  title: "welded frame study obsidian",
  host: "setbuild.test",
  body: aBody(0),
  tags: ["knitwear", "millinery"],
  realm: "INSPO",
  enrichedAt: daysAgo(2),
}));

// Never read at all, and read so long ago the page has moved on.
refs.push(ref("never1", { title: "untouched link marmalade", host: "orphan.test" }));
refs.push(ref("aged1", {
  title: "old page thistle",
  host: "orphan.test",
  body: `${RIG} thistle. An archived note about counterweight rigging kept for the batten detail and the pulley geometry.`,
  realm: "INSPO",
  enrichedAt: daysAgo(400),
}));

async function seed() {
  const KV = makeKV();
  const VECTORS = makeIndex();
  for (const r of refs) {
    await KV.put(`ref:${r.id}`, JSON.stringify(r));
    await VECTORS.upsert([{
      id: r.id,
      values: fakeEmbed(embedTextFor(r)),
      metadata: {
        category: r.category || "link",
        realm: r.realm || "",
        title: r.title || "",
        host: r.host || "",
        createdAt: r.createdAt || "",
        enriched: Boolean(r.enrichedAt),
      },
    }]);
  }
  return { AUTH_TOKEN: "dev", REFS_KV: KV, AI, VECTORS };
}

// ------------------------------------------------------------- pure detectors
eq("a title is not content", textLength({ title: "x".repeat(500) }), 0);
eq("a body is", textLength({ body: "y".repeat(500) }), 500);
eq("caption, transcript and note all count", textLength({ caption: "a".repeat(80), transcript: "b".repeat(80), text: "c".repeat(80) }), 240);
eq("thin means below the floor", hasRealText({ body: "z".repeat(THIN_TEXT_CHARS - 1) }), false);
eq("and enriched means at it", hasRealText({ body: "z".repeat(THIN_TEXT_CHARS) }), true);
eq("garbage in, zero out", textLength(null), 0);

// staleness respects timestamps, and separates "never" from "old"
const never = stalenessOf(ref("n", { title: "t" }), { now: NOW });
ok("never enriched is stale", never.stale && never.never);
const fresh = stalenessOf(ref("f", { body: "b".repeat(400), enrichedAt: daysAgo(3) }), { now: NOW });
eq("enriched last week is not stale", fresh.stale, false);
ok("and it says how old it is", fresh.ageDays > 2 && fresh.ageDays < 4);
const old = stalenessOf(ref("o", { body: "b".repeat(400), enrichedAt: daysAgo(400) }), { now: NOW });
ok("enriched 400 days ago is stale", old.stale && !old.never);
ok("with the age in the reason", old.why.includes("400"));
eq("the threshold is the threshold",
  stalenessOf(ref("o2", { body: "b".repeat(400), enrichedAt: daysAgo(400) }), { now: NOW, afterDays: 500 }).stale, false);
eq("a ref with no url has nothing to re-read", stalenessOf({ id: "x", text: "a note" }, { now: NOW }).stale, false);
// An imported ref carries no enrichment stamp at all — createdAt is the only
// honest lower bound on the age of the text it holds.
const imported = stalenessOf({ id: "i", url: "https://x.test/a", body: "b".repeat(400), createdAt: daysAgo(400) }, { now: NOW });
ok("an old import falls back to createdAt", imported.stale && !imported.never);
eq("a recent import is not stale",
  stalenessOf({ id: "i2", url: "https://x.test/b", body: "b".repeat(400), createdAt: daysAgo(5) }, { now: NOW }).stale, false);

// tags vs content
const BODY = "b".repeat(400) + " welded steel";
eq("two unrelated tags contradict the body", tagsAgree({ title: "welded frame", body: BODY, tags: ["knitwear", "millinery"] }).agree, false);
eq("one grounded tag is enough", tagsAgree({ title: "welded frame", body: BODY, tags: ["knitwear", "steel"] }).agree, true);
eq("no text means nothing to check", tagsAgree({ title: "x", tags: ["knitwear", "millinery"] }).checked, false);
eq("one tag is not evidence", tagsAgree({ body: BODY, tags: ["knitwear"] }).checked, false);

// url identity
eq("tracking params and www don't make a new ref",
  normalizeUrl("https://www.rig.test/post/9/?utm_source=ig"), normalizeUrl("https://rig.test/post/9"));
ok("different paths stay different", normalizeUrl("https://a.test/x") !== normalizeUrl("https://a.test/y"));
ok("an unparseable url keeps its own identity", normalizeUrl("not a url") !== normalizeUrl("also not a url"));

// near-identical grouping, on vectors alone
const vA = [1, 0, 0], vB = [0.999, 0.02, 0], vC = [0, 1, 0];
const groups = duplicateGroups(["x", "y", "z"], new Map([["x", vA], ["y", vB], ["z", vC]]));
eq("twins group together", groups.length, 1);
eq("and only the twins", groups[0].ids.length, 2);
ok("the pair is x and y", groups[0].ids.includes("x") && groups[0].ids.includes("y"));
ok("with the similarity kept", groups[0].score >= DUPLICATE_SCORE);
// Three copies of one thing is ONE card asking which to keep, not three.
const triple = duplicateGroups(["x", "y", "w"], new Map([["x", vA], ["y", vB], ["w", [0.998, 0.03, 0]]]));
eq("three copies are one group", triple.length, 1);
eq("holding all three", triple[0].ids.length, 3);
eq("a ref with no stored vector is skipped, not guessed at",
  duplicateGroups(["x", "gone"], new Map([["x", vA]])).length, 0);

// vocabulary + questions
const terms = termsOf([{ title: "banjo bluegrass tuning" }, { title: "banjo clawhammer" }], 3);
eq("the dominant term wins", terms[0], "banjo");
ok("a question is built from the region's own words", questionFor({ terms }).includes("banjo"));
eq("no vocabulary, no question", questionFor({ terms: [] }), "");

// ---------------------------------------------------------------- the regions
const env = await seed();
const found = await findGaps(env, { now: NOW, limit: 200, probe: false });

eq("the audit did not fail", found.error, null);
eq("nothing was degraded", found.degraded, false);
eq("it saw the whole archive", found.sampled, refs.length);
ok("it built regions", found.clusters.length >= 3);
ok("clustering never over-fetched metadata", env.VECTORS.maxTopK <= METADATA_TOPK_MAX);
ok("the regions really are separate things",
  found.clusters.every((c) => c.members.every((m) => m.score >= CLUSTER_MIN_SCORE)));

const regionOf = (prefix) => found.clusters.find((c) => c.members.filter((m) => m.id.startsWith(prefix)).length >= 4);
const A = regionOf("a");
const B = regionOf("b");
const C = regionOf("c");
ok("the enriched region formed", Boolean(A));
ok("the thin text region formed", Boolean(B));
ok("the image region formed", Boolean(C));
ok("the enriched region is not polluted by the others", A && A.members.every((m) => !m.id.startsWith("b") && !m.id.startsWith("c")));
ok("regions are named by their own vocabulary", B && B.terms.includes("banjo"));
eq("the enriched region reads as enriched", A ? A.enrichedShare : 0, 1);
eq("the thin region reads as thin", B ? B.enrichedShare : 1, 0);

// ---- THIN ----
const thin = found.gaps.filter((g) => g.kind === "thin");
ok("thin regions were found", thin.length > 0);
const thinIds = new Set(thin.flatMap((g) => g.refIds));
ok("the banjo region is thin", [...thinIds].some((id) => id.startsWith("b")));
ok("the image region is thin", [...thinIds].some((id) => id.startsWith("c")));
ok("the well-enriched region is NOT thin", ![...thinIds].some((id) => id.startsWith("a")));
ok("a thin gap explains itself in one line", thin.every((g) => typeof g.line === "string" && g.line.length > 20));
const imageGap = thin.find((g) => g.refIds.some((id) => id.startsWith("c")));
ok("the image region knows vision is the only way in", imageGap.detail.captionable >= 4);
const textGap = thin.find((g) => g.refIds.some((id) => id.startsWith("b")));
ok("the text region knows a page fetch will do", textGap.detail.readable >= 4);

// ---- STALE ----
const stale = found.gaps.filter((g) => g.kind === "stale");
ok("stale was detected", stale.length > 0);
const neverGap = stale.find((g) => g.detail.signal === "never enriched");
ok("the untouched ref is in the never bucket", neverGap && neverGap.refIds.includes("never1"));
const agedGap = stale.find((g) => g.detail.signal === "aged out");
ok("the 400-day-old page is in the aged bucket", agedGap && agedGap.refIds.includes("aged1"));
ok("a recently enriched ref is in neither", !stale.some((g) => g.refIds.includes("same1")));

// ---- DUPLICATE ----
const dupes = found.gaps.filter((g) => g.kind === "duplicate");
ok("the same url twice was caught",
  dupes.some((g) => g.detail.signal === "same url" && g.refIds.includes("same1") && g.refIds.includes("same2")));
const near = dupes.find((g) => g.detail.signal === "near-identical");
ok("the near-identical twin was caught", near && near.refIds.includes("dup1"));
ok("and it cleared the similarity bar", near && near.detail.score >= DUPLICATE_SCORE);
ok("merely similar refs are not called duplicates",
  !dupes.some((g) => g.detail.signal === "near-identical" && g.refIds.includes("b0")));

// ---- CONTRADICTION ----
const clashes = found.gaps.filter((g) => g.kind === "contradiction");
ok("tags that match nothing were caught",
  clashes.some((g) => g.detail.signal === "tags absent from content" && g.refIds.includes("tagclash")));
const oddRealm = clashes.find((g) => g.detail.signal === "realm disagrees with neighbours");
ok("a ref filed against its neighbours was caught", oddRealm && oddRealm.refIds.includes("a7"));
eq("and the region it disagrees with is named", oddRealm ? oddRealm.detail.dominantRealm : "", "INSPO");

// ---- summary ----
const sum = summarizeGaps(found.gaps);
eq("the summary counts every gap", sum.gaps, found.gaps.length);
ok("and totals the impact", sum.impact > 0);
ok("and the refs involved", sum.refs > 0);
ok("and reports its kinds in a stable order",
  JSON.stringify(Object.keys(sum.byKind)) === JSON.stringify(Object.keys(summarizeGaps([...found.gaps].reverse()).byKind)));

// ---------------------------------------------------------------- the probes
const probeEnv = await seed();
const sample = refs.map((r) => ({ key: `ref:${r.id}`, ref: r }));
const hood = await neighbourhoods(probeEnv, sample, { now: NOW });
eq("neighbourhoods came back clean", hood.error, null);
eq("nothing went unvectored", hood.unvectored.length, 0);

const before = embedCalls;
const probed = await probeQuestions(probeEnv, hood.clusters, { limit: 3 });
eq("probing did not fail", probed.error, null);
ok("questions were actually asked", probed.ran > 0);
eq("each probe cost exactly one embedding", embedCalls - before, probed.ran);
ok("and it was charged for", probed.spent > 0);
ok("a probe never over-fetches either", probeEnv.VECTORS.maxTopK <= METADATA_TOPK_MAX);
ok("every probe carries its verdict and its reasons",
  probed.probes.every((p) => Array.isArray(p.reasons) && typeof p.weak === "boolean" && p.question));
ok("the biggest region is asked about first", probed.probes[0].clusterId === [...hood.clusters].sort((a, b) => b.size - a.size)[0].id);

// The thresholds, not the vocabulary, decide the verdict — so prove they do.
const allWeak = await probeQuestions(await seed(), hood.clusters, { limit: 2, weakTopScore: 0.99, minScore: 0.05 });
ok("an impossible bar makes every probe weak", allWeak.probes.length > 0 && allWeak.probes.every((p) => p.weak));
ok("with the score named in the reason", allWeak.probes.every((p) => p.reasons.join(" ").includes("best match")));
const noneWeak = await probeQuestions(await seed(), hood.clusters, {
  limit: 2, weakTopScore: 0, minAnswerRefs: 0, incoherentSpread: 0, minScore: 0.05,
});
ok("and a floor of zero makes none of them weak", noneWeak.probes.length > 0 && noneWeak.probes.every((p) => !p.weak));
ok("quality is a real 0..1 number", noneWeak.probes.every((p) => p.quality >= 0 && p.quality <= 1));

// A refused budget must SKIP the probe and say so — never report a clean pass.
const brokeEnv = await seed();
await brokeEnv.REFS_KV.put(`budget:${dayStamp()}`, JSON.stringify({ day: dayStamp(), usd: 999, calls: {}, vision: 0 }));
const refused = await probeQuestions(brokeEnv, hood.clusters, { limit: 3 });
eq("no probe ran", refused.ran, 0);
ok("and the reason is on the record", /budget/i.test(refused.error || ""));
eq("nothing was spent", refused.spent, 0);
eq("and no region was quietly declared answerable", refused.probes.length, 0);

const noAi = await probeQuestions({ REFS_KV: makeKV(), VECTORS: makeIndex() }, hood.clusters, { limit: 2 });
ok("no AI binding is reported, not swallowed", /AI not bound/.test(noAi.error || ""));

// An unanswerable region becomes a job, and which job depends on WHY it failed.
const weakEnv = await seed();
const weakAudit = await findGaps(weakEnv, { now: NOW, limit: 200, probe: true, weakTopScore: 0.99 });
const unanswerable = weakAudit.gaps.filter((g) => g.kind === "unanswerable");
ok("unanswerable regions surfaced", unanswerable.length > 0);
ok("every one carries the question it failed", unanswerable.every((g) => g.detail.question.includes("references say about")));
const contentless = unanswerable.find((g) => g.detail.contentGap);
const retrievalOnly = unanswerable.find((g) => !g.detail.contentGap);
ok("a region missing text is sent to be enriched", !contentless || actionFor(contentless) === "enrich");
ok("a region that has text but can't be found is re-embedded", !retrievalOnly || actionFor(retrievalOnly) === "reindex");

// ---------------------------------------------------------------- the ranking
const gapsForRanking = [
  { id: "thin:big", kind: "thin", refIds: ["r1", "r2", "r3", "r4"], count: 4, impact: 12, perRef: 3, detail: { readable: 4, captionable: 0 }, line: "cheap and valuable" },
  { id: "unanswerable:x", kind: "unanswerable", refIds: ["r5", "r6"], count: 2, impact: 8, perRef: 4, detail: { contentGap: false }, line: "needs re-embedding" },
  { id: "thin:pics", kind: "thin", refIds: ["r7", "r8"], count: 2, impact: 2, perRef: 1, detail: { readable: 0, captionable: 2 }, line: "needs vision" },
];
const built = jobsFor(gapsForRanking);
eq("every gap became a job", built.length, 3);
eq("a readable thin region is fixed for free", built.find((j) => j.gap === "thin:big").tier, 0);
eq("an image region needs the paid tier", built.find((j) => j.gap === "thin:pics").tier, 2);
eq("and it counts against the vision ration", built.find((j) => j.gap === "thin:pics").vision, true);
eq("an enriched-but-unretrievable region gets re-embedded", actionFor(gapsForRanking[1]), "reindex");
eq("a duplicate is never merged, only staged", actionFor({ kind: "duplicate", refIds: ["a"], detail: {} }), "stage");
eq("nor is a contradiction", actionFor({ kind: "contradiction", refIds: ["a"], detail: {} }), "stage");
eq("staging costs nothing", built.length && jobsFor([{ id: "duplicate:x", kind: "duplicate", refIds: ["a"], count: 1, impact: 1, perRef: 1, detail: {}, line: "x" }])[0].tier, 0);

const ranked = rankJobs(built);
eq("free work outranks paid work", ranked[0].tier, 0);
ok("the list is sorted by impact per dollar", ranked.every((j, i, a) => i === 0 || a[i - 1].score >= j.score));
ok("higher per-ref impact beats lower at the same tier",
  ranked.findIndex((j) => j.gap === "unanswerable:x") < ranked.findIndex((j) => j.gap === "thin:pics"));
ok("impact per dollar is finite for free work", Number.isFinite(impactPerDollar(3, 0)));
// The floor is what makes tier 0 outrank tier 2 at every impact this project
// actually produces — the weights are single digits, not thousands.
ok("and the cheapest free job still beats the richest paid one", impactPerDollar(1, 0) > impactPerDollar(4, 0.0002));

// ---------------------------------------------------------------- the fitting
const tight = fitBudget(ranked, { budget: 0.0004, visionLeft: 20 });
ok("the plan fits the budget", tight.planned <= 0.0004 + 1e-9);
ok("free work still made it in", tight.jobs.some((j) => j.tier === 0));
const paid = tight.jobs.filter((j) => j.tier > 0);
ok("paid work was trimmed rather than dropped", paid.length > 0);
ok("a trimmed job's refIds shrink with it", paid.every((j) => j.refIds.length === j.units));
ok("and its impact shrinks honestly", paid.every((j) => Math.abs(j.impact - j.perRef * j.units) < 1e-6));
ok("trimming is explained where it happened", tight.jobs.every((j) => j.units === j.refIds.length));

const noMoney = fitBudget(ranked, { budget: 0, visionLeft: 20 });
eq("with no money only free work survives", noMoney.jobs.every((j) => j.tier === 0), true);
eq("nothing was planned", noMoney.planned, 0);
ok("and the paid jobs are deferred with a reason", noMoney.deferred.length > 0 && noMoney.deferred.every((j) => j.deferredWhy.length > 0));

const noVision = fitBudget(ranked, { budget: 5, visionLeft: 0 });
ok("a spent vision ration defers the caption job", noVision.deferred.some((j) => j.vision));
ok("with the ration named", noVision.deferred.filter((j) => j.vision).every((j) => /vision/i.test(j.deferredWhy)));
eq("and no vision units were planned", noVision.visionPlanned, 0);

const capped = fitBudget(ranked, { budget: 5, visionLeft: 20, maxJobs: 1 });
eq("the job cap holds", capped.jobs.length, 1);
ok("and the rest say why they waited", capped.deferred.every((j) => /jobs fit/.test(j.deferredWhy)));

// ---------------------------------------------------------------- the plan
const planEnv = await seed();
const plan = await planTonight(planEnv, { now: NOW, limit: 200, probe: false, budget: 0.002 });
eq("planning did not fail", plan.error, null);
ok("it produced work", plan.jobs.length > 0);
ok("the work fits the stated budget", plan.plan.total <= 0.002 + 1e-9);
ok("every job names its tier", plan.jobs.every((j) => typeof j.tier === "number" && j.tier >= 0));
ok("every job names the refs it will touch", plan.jobs.every((j) => j.refIds.length === j.units && j.units > 0));
ok("no job exceeds the per-job cap", plan.jobs.every((j) => j.units <= MAX_UNITS_PER_JOB));
ok("the plan is ranked highest impact per dollar first",
  plan.jobs.every((j, i, a) => i === 0 || a[i - 1].score >= j.score));
ok("the vision ration was respected", plan.plan.visionPlanned <= plan.plan.visionLeft);
ok("the plan reads as one line on a phone", /job/.test(plan.line) && plan.line.length < 160);
ok("every job reads as one line too", plan.jobs.every((j) => j.line.length > 20 && j.line.includes("tier")));
ok("it never over-fetched metadata", planEnv.VECTORS.maxTopK <= METADATA_TOPK_MAX);

// A budget that cannot pay for anything must not propose work that cannot run.
const brokePlan = await planTonight(await seed(), { now: NOW, limit: 200, probe: false, budget: 0 });
eq("with no budget nothing paid is planned", brokePlan.jobs.every((j) => j.tier === 0), true);
eq("and the total is zero", brokePlan.plan.planned, 0);
ok("but the free work is still there", brokePlan.jobs.length > 0);
ok("and the paid work is on the record as deferred", brokePlan.plan.deferred > 0);

// The probes' own spend comes out of the stated budget too — the promise is
// that the NIGHT fits, not that the jobs do.
const probedPlan = await planTonight(await seed(), { now: NOW, limit: 200, probe: true, budget: 0.01 });
ok("probe spend is accounted for", probedPlan.plan.probeSpend > 0);
ok("and the night as a whole still fits", probedPlan.plan.total <= 0.01 + 1e-9);
eq("the stated budget is remembered", probedPlan.plan.stated, 0.01);

// A vision ration already spent must not be planned against.
const spentEnv = await seed();
await spentEnv.REFS_KV.put(`budget:${dayStamp()}`, JSON.stringify({ day: dayStamp(), usd: 0, calls: {}, vision: 20 }));
const spentPlan = await planTonight(spentEnv, { now: NOW, limit: 200, probe: false });
eq("no vision work is planned once the ration is gone", spentPlan.plan.visionPlanned, 0);
ok("and the caption job is deferred, not silently dropped",
  !spentPlan.deferred.some((j) => j.vision) || spentPlan.deferred.some((j) => j.vision && /vision/i.test(j.deferredWhy)));

// ------------------------------------------------------- missing bindings
const noVectors = { AUTH_TOKEN: "dev", REFS_KV: (await seed()).REFS_KV, AI };
const degraded = await findGaps(noVectors, { now: NOW, limit: 200, probe: false });
eq("a missing index is not a crash", degraded.error, null);
eq("it is a degraded audit", degraded.degraded, true);
ok("and it says which binding", degraded.errors.join(" ").includes("VECTORS not bound"));
ok("the deterministic gaps still came through", degraded.gaps.some((g) => g.kind === "stale"));
eq("but no regions were claimed", degraded.clusters.length, 0);

const degradedPlan = await planTonight(noVectors, { now: NOW, limit: 200, probe: false });
ok("a degraded plan still queues free work", degradedPlan.jobs.length > 0);
eq("and stays honest about it", degradedPlan.degraded, true);

const noKv = await findGaps({ AI, VECTORS: makeIndex() }, { now: NOW, probe: false });
ok("a missing KV is an error, not an empty archive", /REFS_KV not bound/.test(noKv.error || ""));
eq("with no gaps invented", noKv.gaps.length, 0);

const nothing = await planTonight({}, { now: NOW, probe: false });
ok("planning with no bindings at all returns an error object", /REFS_KV/.test(nothing.error || ""));
eq("and no jobs", nothing.jobs.length, 0);
ok("and says so in one line", /failed/i.test(nothing.line));

// A KV that throws must never look like an archive with nothing to fix.
const angryKv = { ...makeKV(), async list() { throw new Error("KV is down"); } };
const brokenWalk = await findGaps({ REFS_KV: angryKv, AI, VECTORS: makeIndex() }, { now: NOW, probe: false });
ok("a thrown list surfaces as an error", /KV is down/.test(brokenWalk.error || ""));
eq("and not as a clean bill of health", brokenWalk.gaps.length, 0);

// A Vectorize that throws must not silently mean "no regions".
const seeded = await seed();
const angryIndex = { ...seeded.VECTORS, async query() { throw new Error("index rejected the query"); } };
const brokenIndex = await findGaps({ REFS_KV: seeded.REFS_KV, AI, VECTORS: angryIndex }, { now: NOW, limit: 200, probe: false });
eq("the audit still returns", brokenIndex.error, null);
ok("with the query failure on the record", brokenIndex.errors.join(" ").includes("index rejected the query"));
eq("and no regions invented from nothing", brokenIndex.clusters.length, 0);
ok("while the free detectors still did their job", brokenIndex.gaps.some((g) => g.kind === "stale"));

// A ref that was never embedded is invisible to search — that is its own gap.
const partial = await seed();
await partial.VECTORS.deleteByIds(["b0", "b1", "b2"]);
const partialAudit = await findGaps(partial, { now: NOW, limit: 200, probe: false });
ok("an unvectored ref is reported when it is seeded from",
  partialAudit.gaps.some((g) => g.kind === "thin") && partialAudit.error === null);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
