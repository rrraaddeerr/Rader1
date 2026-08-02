// Integration test for the Worker's fetch handler, run in plain Node.
// Mocks KV (Map-backed) and global fetch (for OG scraping) so it needs no
// wrangler/network. Run: node test/worker.test.mjs
import worker from "../src/index.js";

let pass = 0, fail = 0;
function ok(label, cond) { cond ? pass++ : (fail++, console.error("✗ " + label)); }
function eq(label, got, want) { ok(label + ` (got ${JSON.stringify(got)})`, got === want); }

// ---- Map-backed KV that mimics the bits of the KV API we use ----
function makeKV() {
  const store = new Map(); // name -> { value, metadata }
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
      const last = slice[slice.length - 1];
      const complete = start + limit >= names.length;
      return { keys: slice.map((name) => ({ name })), list_complete: complete, cursor: complete ? undefined : last };
    },
    _store: store,
  };
}

const env = { AUTH_TOKEN: "dev", REFS_KV: makeKV() };
const TOK = { "X-Auth-Token": "dev" };
const req = (path, opts = {}) => new Request("http://localhost" + path, opts);
const call = (path, opts) => worker.fetch(req(path, opts), env, {});

// stub global fetch so OG scraping is deterministic + offline
globalThis.fetch = async () =>
  new Response(
    `<html><head><title>Repo</title>` +
      `<meta property="og:title" content="Cool Repo">` +
      `<meta property="og:description" content="A description">` +
      `<meta property="og:image" content="https://img.test/x.png"></head><body></body></html>`,
    { headers: { "content-type": "text/html" } }
  );

const run = async () => {
  // health
  let r = await call("/health");
  eq("health 200", r.status, 200);

  // auth required
  r = await call("/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  eq("save without token -> 401", r.status, 401);

  // save a URL (github -> code) with OG enrichment
  r = await call("/save", {
    method: "POST",
    headers: { ...TOK, "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://github.com/a/b" }),
  });
  let d = await r.json();
  eq("save url -> 201", r.status, 201);
  eq("url category code", d.ref.category, "code");
  eq("og title pulled", d.ref.title, "Cool Repo");
  eq("og image pulled", d.ref.image, "https://img.test/x.png");
  const urlId = d.ref.id;

  // save a note
  r = await call("/save", {
    method: "POST",
    headers: { ...TOK, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "ship the thing" }),
  });
  d = await r.json();
  eq("note category", d.ref.category, "note");

  // save a raw image blob
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  r = await call("/save", {
    method: "POST",
    headers: { ...TOK, "Content-Type": "image/png", "X-Filename": "shot.png" },
    body: bytes,
  });
  d = await r.json();
  eq("blob category image", d.ref.category, "image");
  ok("blob has image url", typeof d.ref.image === "string" && d.ref.image.includes("/blob/"));
  const blobKey = d.ref.blobKey;
  const imgId = d.ref.id;

  // fetch the blob back (public)
  r = await call("/blob/" + blobKey);
  eq("blob fetch 200", r.status, 200);
  const back = new Uint8Array(await r.arrayBuffer());
  eq("blob bytes roundtrip", back.length, 5);

  // list all
  r = await call("/api/list", { headers: TOK });
  d = await r.json();
  eq("list returns 3", d.refs.length, 3);
  // newest first: the image was saved last
  eq("newest first ordering", d.refs[0].id, imgId);

  // filter by category
  r = await call("/api/list?cat=code", { headers: TOK });
  d = await r.json();
  eq("filter code -> 1", d.refs.length, 1);

  // search
  r = await call("/api/list?q=cool", { headers: TOK });
  d = await r.json();
  eq("search 'cool' -> 1", d.refs.length, 1);

  // get one
  r = await call("/api/ref/" + urlId, { headers: TOK });
  eq("get ref 200", r.status, 200);

  // PATCH: edit category + tags
  r = await call("/api/ref/" + urlId, {
    method: "PATCH",
    headers: { ...TOK, "Content-Type": "application/json" },
    body: JSON.stringify({ category: "article", tags: "Inspo, Reference, inspo" }),
  });
  d = await r.json();
  eq("patch 200", r.status, 200);
  eq("patch changed category", d.ref.category, "article");
  eq("patch normalized+deduped tags", d.ref.tags.join(","), "inspo,reference");
  // reject unknown category
  r = await call("/api/ref/" + urlId, {
    method: "PATCH",
    headers: { ...TOK, "Content-Type": "application/json" },
    body: JSON.stringify({ category: "bogus" }),
  });
  eq("patch rejects bad category", r.status, 400);
  // edit reflected in search
  r = await call("/api/list?q=reference", { headers: TOK });
  d = await r.json();
  eq("search finds new tag", d.refs.length, 1);

  // delete
  r = await call("/api/ref/" + imgId, { method: "DELETE", headers: TOK });
  eq("delete 200", r.status, 200);
  ok("blob gone after delete", !env.REFS_KV._store.has("blob:" + blobKey));
  r = await call("/api/list", { headers: TOK });
  d = await r.json();
  eq("list returns 2 after delete", d.refs.length, 2);

  // export NDJSON
  r = await call("/api/export", { headers: TOK });
  const text = await r.text();
  eq("export 2 lines", text.trim().split("\n").length, 2);

  // import
  r = await call("/api/import", {
    method: "POST",
    headers: { ...TOK, "Content-Type": "application/json" },
    body: JSON.stringify([{ title: "imported", category: "link", kind: "url", url: "https://x.io" }]),
  });
  d = await r.json();
  eq("import 1", d.imported, 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
