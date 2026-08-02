// Integration test for the brain endpoints, in plain Node.
// Mocks KV, Workers AI and Vectorize with in-memory stand-ins so the whole
// save -> embed -> index -> search -> ask path runs offline.
// Run: node test/brain-routes.test.mjs
import worker from "../src/index.js";

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
      if (type === "json") return JSON.parse(e.value);
      if (type === "arrayBuffer") return e.value;
      return e.value;
    },
    async getWithMetadata(name) {
      const e = store.get(name);
      return e ? { value: e.value, metadata: e.metadata ?? null } : { value: null, metadata: null };
    },
    async put(name, value, opts = {}) { store.set(name, { value, metadata: opts.metadata ?? null }); },
    async delete(name) { store.delete(name); },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? names.indexOf(cursor) + 1 : 0;
      const slice = names.slice(start, start + limit);
      const complete = start + limit >= names.length;
      return { keys: slice.map((name) => ({ name })), list_complete: complete, cursor: complete ? undefined : slice[slice.length - 1] };
    },
  };
}

// ---- Workers AI ----
// A deterministic bag-of-words embedding: words hash into buckets, so texts
// that share vocabulary really do land near each other under cosine distance.
const DIMS = 32;
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
let aiCalls = { embed: 0, vision: 0, chat: 0 };
const AI = {
  async run(model, input) {
    if (model.includes("bge")) {
      aiCalls.embed++;
      return { data: input.text.map(fakeEmbed) };
    }
    if (model.includes("llava")) {
      aiCalls.vision++;
      return { description: "a stainless steel cart under cold light" };
    }
    aiCalls.chat++;
    const q = input.messages?.[1]?.content || "";
    if (q.includes("Draft a client Set")) {
      // Includes one hallucinated id on purpose — the worker must drop it.
      return {
        response:
          '```json\n{"title":"Cold Steel","note":"Hospital-adjacent, hard light.",' +
          '"sections":[{"name":"Cases & Carts","items":[{"id":"vpc-1","why":"the gauges"},{"id":"vpc-999","why":"invented"}]}],' +
          '"gaps":["nothing soft"]}\n```',
      };
    }
    return { response: "Answering from the archive [1]. " + (q.includes("CONTEXT") ? "context received" : "no context") };
  },
};

// ---- Vectorize ----
function makeIndex() {
  const vecs = new Map(); // id -> {values, metadata}
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  return {
    async upsert(list) { for (const v of list) vecs.set(v.id, { values: v.values, metadata: v.metadata || {} }); },
    async deleteByIds(ids) { for (const id of ids) vecs.delete(id); },
    async getByIds(ids) { return ids.map((id) => (vecs.has(id) ? { id, ...vecs.get(id) } : null)).filter(Boolean); },
    async query(vector, { topK = 10 } = {}) {
      const matches = [...vecs.entries()]
        .map(([id, v]) => ({ id, score: dot(vector, v.values), metadata: v.metadata }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return { matches };
    },
    _size: () => vecs.size,
  };
}

const VECTORS = makeIndex();
const INV_VECTORS = makeIndex();
const env = { AUTH_TOKEN: "dev", REFS_KV: makeKV(), AI, VECTORS, INV_VECTORS };
const TOK = { "X-Auth-Token": "dev" };
const JSONH = { ...TOK, "Content-Type": "application/json" };
const call = (path, opts = {}) =>
  worker.fetch(new Request("http://localhost" + path, opts), env, { waitUntil: (p) => tasks.push(p) });

// Collect deferred work so we can await it deterministically.
const tasks = [];
const settle = async () => { while (tasks.length) await tasks.shift().catch(() => {}); };

// Offline page fetch for OG + enrichment.
globalThis.fetch = async (url) =>
  new Response(
    `<html><head><title>Steel cart</title>` +
      `<meta property="og:description" content="A rolling stainless cart"></head>` +
      `<body><p>${"A stainless steel rolling cart under cold hospital light. ".repeat(12)}</p></body></html>`,
    { headers: { "content-type": "text/html" } }
  );

const run = async () => {
  // health reports what's wired
  let r = await call("/health");
  let d = await r.json();
  eq("health says brain on", d.brain, true);
  eq("health says inventory on", d.inventory, true);
  eq("health says deep off (no key)", d.deep, false);

  // save indexes immediately
  r = await call("/save", { method: "POST", headers: JSONH, body: JSON.stringify({ url: "https://example.com/cart", note: "the cold steel look" }) });
  d = await r.json();
  eq("save 201", r.status, 201);
  eq("note is stored", d.ref.note, "the cold steel look");
  const cartId = d.ref.id;
  ok("indexed on save", VECTORS._size() === 1);

  // background enrichment fills in page text and re-indexes
  await settle();
  r = await call("/api/ref/" + cartId, { headers: TOK });
  d = await r.json();
  ok("page body was extracted", (d.ref.body || "").includes("stainless steel rolling cart"));
  eq("enrichment is stamped", d.ref.enrichKind, "page");

  // a second, unrelated ref
  r = await call("/save", { method: "POST", headers: JSONH, body: JSON.stringify({ text: "banjo lesson notes, bluegrass tuning" }) });
  d = await r.json();
  const banjoId = d.ref.id;
  await settle();
  eq("two refs indexed", VECTORS._size(), 2);

  // semantic search ranks the right one first
  r = await call("/api/search", { method: "POST", headers: JSONH, body: JSON.stringify({ q: "stainless steel cart" }) });
  d = await r.json();
  eq("search ok", d.ok, true);
  ok("search found something", d.refs.length > 0);
  eq("best match is the cart", d.refs[0].id, cartId);

  // search needs a query
  r = await call("/api/search", { method: "POST", headers: JSONH, body: JSON.stringify({}) });
  eq("empty search -> 400", r.status, 400);

  // ask returns an answer plus its sources
  r = await call("/api/ask", { method: "POST", headers: JSONH, body: JSON.stringify({ q: "what steel pieces have I saved?" }) });
  d = await r.json();
  eq("ask ok", d.ok, true);
  ok("answer came back", typeof d.answer === "string" && d.answer.length > 0);
  ok("sources attached", Array.isArray(d.sources) && d.sources.length > 0);
  eq("sources are 1-indexed", d.sources[0].n, 1);
  ok("the model was given context", d.answer.includes("context received"));

  // plain-text mode for Siri / Shortcuts
  r = await call("/api/ask?format=text&q=" + encodeURIComponent("steel"), { headers: TOK });
  eq("text mode content-type", r.headers.get("content-type"), "text/plain; charset=utf-8");
  const spoken = await r.text();
  ok("text mode returns bare prose", spoken.length > 0 && !spoken.startsWith("{"));

  // similar-to
  r = await call("/api/similar/" + cartId, { headers: TOK });
  d = await r.json();
  eq("similar ok", d.ok, true);
  ok("excludes the ref itself", !d.refs.some((x) => x.id === cartId));

  r = await call("/api/similar/nope", { headers: TOK });
  eq("similar to a missing ref -> 404", r.status, 404);

  // save?similar=1 echoes neighbours back to the drop page
  r = await call("/save?similar=1", { method: "POST", headers: JSONH, body: JSON.stringify({ text: "another cold steel cart reference" }) });
  d = await r.json();
  ok("similar echoed on save", Array.isArray(d.similar) && d.similar.length > 0);
  eq("echoed neighbour is the cart", d.similar[0].id, cartId);
  await settle();

  // delete removes it from the index too
  const before = VECTORS._size();
  r = await call("/api/ref/" + banjoId, { method: "DELETE", headers: TOK });
  await settle();
  eq("delete unindexes", VECTORS._size(), before - 1);

  // reindex walks everything
  r = await call("/api/reindex?batch=100", { method: "POST", headers: TOK });
  d = await r.json();
  eq("reindex ok", d.ok, true);
  eq("reindex is done in one batch", d.done, true);
  ok("reindex indexed the refs", d.indexed >= 2);

  // inventory
  r = await call("/api/inventory/index", {
    method: "POST",
    headers: JSONH,
    body: JSON.stringify({
      items: [
        { id: "vpc-1", title: "Bedside Table", description: "Stainless top with gauges, aged", category: "Cases & Carts" },
        { id: "vpc-2", title: "Velvet Sofa", description: "Deep green velvet, tufted", category: "Seating" },
      ],
    }),
  });
  d = await r.json();
  eq("inventory indexed", d.indexed, 2);

  r = await call("/api/match", { method: "POST", headers: JSONH, body: JSON.stringify({ q: "stainless steel gauges" }) });
  d = await r.json();
  eq("match ok", d.ok, true);
  eq("match found the right item", d.items[0].id, "vpc-1");
  eq("match reports how it read the input", d.via, "text");

  // match by an existing ref
  r = await call("/api/match", { method: "POST", headers: JSONH, body: JSON.stringify({ refId: cartId }) });
  d = await r.json();
  eq("match by ref id works", d.via, "ref");

  // match by raw image bytes goes through the vision model
  const visionBefore = aiCalls.vision;
  r = await call("/api/match", { method: "POST", headers: { ...TOK, "Content-Type": "image/png" }, body: new Uint8Array([1, 2, 3]) });
  d = await r.json();
  eq("match by image works", d.via, "vision");
  ok("vision model was called", aiCalls.vision === visionBefore + 1);

  // set drafting from a brief
  r = await call("/api/set-draft", {
    method: "POST",
    headers: JSONH,
    body: JSON.stringify({ brief: "cold hospital corridor, stainless, gauges" }),
  });
  d = await r.json();
  eq("set-draft ok", d.ok, true);
  eq("draft title", d.draft.title, "Cold Steel");
  eq("draft has one section", d.draft.sections.length, 1);
  eq("hallucinated ids are dropped", d.draft.sections[0].items.length, 1);
  eq("kept the real item", d.draft.sections[0].items[0].id, "vpc-1");
  ok("picks carry a reason", d.draft.sections[0].items[0].why.length > 0);
  eq("gaps come through", d.draft.gaps[0], "nothing soft");
  ok("candidates returned for override", d.candidates.length > 0);

  r = await call("/api/set-draft", { method: "POST", headers: JSONH, body: JSON.stringify({ brief: "" }) });
  eq("empty brief -> 400", r.status, 400);

  // profile
  r = await call("/api/profile", { headers: TOK });
  d = await r.json();
  eq("profile ok", d.ok, true);
  ok("profile reports its sample size", d.basedOn > 0);

  // auth still guards everything new
  for (const [path, opts] of [
    ["/api/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }],
    ["/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }],
    ["/api/similar/x", {}],
    ["/api/profile", {}],
    ["/api/reindex", { method: "POST" }],
    ["/api/match", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }],
    ["/api/set-draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }],
    ["/api/inventory/index", { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]" }],
  ]) {
    const res = await call(path, opts);
    eq(`${path} without token -> 401`, res.status, 401);
  }

  // with no AI/Vectorize bindings the brain says so instead of exploding
  const bare = { AUTH_TOKEN: "dev", REFS_KV: makeKV() };
  const bareCall = (path, opts = {}) => worker.fetch(new Request("http://localhost" + path, opts), bare, {});
  let res = await bareCall("/api/search", { method: "POST", headers: JSONH, body: JSON.stringify({ q: "x" }) });
  eq("search without bindings -> 503", res.status, 503);
  res = await bareCall("/health");
  eq("health reports brain off", (await res.json()).brain, false);
  res = await bareCall("/save", { method: "POST", headers: JSONH, body: JSON.stringify({ text: "still works" }) });
  eq("saving still works without the brain", res.status, 201);

  // the iPhone guide renders
  res = await call("/shortcuts");
  eq("shortcuts page 200", res.status, 200);
  ok("shortcuts page mentions Back Tap", (await res.text()).includes("Back Tap"));

  await settle();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
