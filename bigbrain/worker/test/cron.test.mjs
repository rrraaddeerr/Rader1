// Tests for the nightly job: the budget gates, the vision ration, the run
// record and the promise that it can never add a ref. Map-backed KV, fake
// Workers AI, fake Vectorize and a fake fetch — no network, no models, no spend.
// Run: node test/cron.test.mjs
import {
  runNightly,
  readRun,
  recentRuns,
  scanRefs,
  needsText,
  needsCaption,
  embeddable,
  RUN_PREFIX,
  CURSOR_KEY,
  JOBS,
} from "../src/cron.js";
import { dayStamp, DEFAULT_VISION_RATION } from "../src/budget.js";
import { EMBED_MODEL } from "../src/embed.js";
import { VISION_MODEL } from "../src/enrich.js";

let pass = 0, fail = 0;
function ok(label, cond) { cond ? pass++ : (fail++, console.error("✗ " + label)); }
function eq(label, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}

// The run record is keyed off the injected clock; the ledger is keyed off the
// real UTC day, because charge() reads its own clock. Both are used below.
const NOW = new Date("2026-07-29T11:10:00Z");
const RUN_KEY = `${RUN_PREFIX}2026-07-29`;
const LEDGER_KEY = `budget:${dayStamp()}`;

// ---- KV --------------------------------------------------------------------
// Records every put so the "never adds a ref" test can prove it structurally
// rather than by reading the source.
function makeKV() {
  const store = new Map();
  const puts = [];
  return {
    puts,
    async get(name, type) {
      const e = store.get(name);
      if (!e) return null;
      return type === "json" ? JSON.parse(e) : e;
    },
    async put(name, value) { puts.push(name); store.set(name, value); },
    async delete(name) { store.delete(name); },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
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
    _seed: (name, value) => store.set(name, JSON.stringify(value)),
    _raw: (name) => store.get(name),
    _keys: (prefix = "") => [...store.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
}

// ---- Workers AI ------------------------------------------------------------
const DIMS = 16;
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

function makeAI({ visionFails = false } = {}) {
  const calls = [];
  return {
    calls,
    embeds: () => calls.filter((c) => c.model === EMBED_MODEL).length,
    visions: () => calls.filter((c) => c.model === VISION_MODEL).length,
    async run(model, input) {
      calls.push({ model, input });
      if (model === EMBED_MODEL) {
        const list = Array.isArray(input.text) ? input.text : [input.text];
        return { data: list.map(fakeEmbed) };
      }
      if (model === VISION_MODEL) {
        if (visionFails) return { description: "" };
        return { description: "chrome tubular harness on a white cyc, latex trim, late-90s" };
      }
      return {};
    },
  };
}

// ---- Vectorize -------------------------------------------------------------
function makeVectors(seedIds = []) {
  const store = new Map(seedIds.map((id) => [id, new Array(DIMS).fill(0.1)]));
  const upserted = [];
  return {
    upserted,
    async upsert(list) {
      for (const v of list) { store.set(v.id, v.values); upserted.push(v.id); }
      return { count: list.length };
    },
    async getByIds(ids) {
      return ids.filter((id) => store.has(id)).map((id) => ({ id, values: store.get(id) }));
    },
    async query() { return { matches: [] }; },
    async deleteByIds(ids) { for (const id of ids) store.delete(id); },
    _has: (id) => store.has(id),
  };
}

// ---- fetch -----------------------------------------------------------------
// One page of real-looking HTML (long enough to clear enrichRef's 200-char
// floor), an image endpoint that hands back bytes, and one url that is gone.
const PAGE_HTML =
  "<html><head><title>Chrome harness rig</title>" +
  '<meta property="og:image" content="https://cdn.example.com/og.jpg">' +
  "</head><body><p>" +
  "A tubular chrome harness built for a window display, welded from 12mm bar and " +
  "polished to a mirror finish. The rig carries three latex panels on swivel arms " +
  "so the whole thing reads as a body without ever showing one. Built in a week " +
  "for a Vancouver retail install, then rented out four times since." +
  "</p></body></html>";

const DEAD_URL = "https://example.com/gone";

function makeFetch() {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || "GET").toUpperCase();
    calls.push({ url: u, method });

    if (u === DEAD_URL) return new Response("", { status: 404 });
    if (/\.(jpg|png)$/.test(u)) {
      return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    return new Response(PAGE_HTML, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
  fn.calls = calls;
  fn.writes = () => calls.filter((c) => c.method !== "GET" && c.method !== "HEAD");
  return fn;
}

// ---- fixtures --------------------------------------------------------------
// Ids are zero-padded so KV's lexical list order is stable and predictable.
const REFS = [
  { id: "0001", kind: "url", category: "link", url: "https://example.com/one", host: "example.com", title: "Welded steel window rig", tags: [] },
  { id: "0002", kind: "url", category: "link", url: "https://example.com/two", host: "example.com", title: "Latex panel fabrication notes", tags: [] },
  { id: "0003", kind: "url", category: "link", url: DEAD_URL, host: "example.com", title: "A page that is gone", tags: [] },
  // Bare Instagram row: classify() can't settle it, so it becomes a realm proposal.
  { id: "0004", kind: "url", category: "link", url: "https://www.instagram.com/p/ABC123/", host: "instagram.com", title: "Instagram", tags: [] },
  // Already has a body — the enrich job must leave it alone.
  { id: "0005", kind: "url", category: "link", url: "https://example.com/five", host: "example.com", title: "Already read", body: "x".repeat(400), enrichedAt: "2026-07-01T00:00:00.000Z", tags: [] },
  // Image refs with reachable bytes and no caption — the vision job's candidates.
  { id: "0006", kind: "url", category: "image", url: "https://cdn.example.com/a.jpg", image: "https://cdn.example.com/a.jpg", host: "cdn.example.com", title: "Chrome study a", tags: [] },
  { id: "0007", kind: "url", category: "image", url: "https://cdn.example.com/b.jpg", image: "https://cdn.example.com/b.jpg", host: "cdn.example.com", title: "Chrome study b", tags: [] },
  { id: "0008", kind: "url", category: "image", url: "https://cdn.example.com/c.jpg", image: "https://cdn.example.com/c.jpg", host: "cdn.example.com", title: "Chrome study c", tags: [] },
  { id: "0009", kind: "url", category: "image", url: "https://cdn.example.com/d.jpg", image: "https://cdn.example.com/d.jpg", host: "cdn.example.com", title: "Chrome study d", tags: [] },
  { id: "0010", kind: "url", category: "image", url: "https://cdn.example.com/e.jpg", image: "https://cdn.example.com/e.jpg", host: "cdn.example.com", title: "Chrome study e", tags: [] },
  // A note: nothing to fetch, nothing to caption, but it does embed.
  { id: "0011", kind: "note", category: "note", text: "Gary Card does the thing where the set eats the model", title: "", tags: [] },
];

function makeEnv({ indexed = [], ai = makeAI(), env = {} } = {}) {
  const kv = makeKV();
  for (const ref of REFS) kv._seed(`ref:${ref.id}`, ref);
  return {
    REFS_KV: kv,
    AI: ai,
    VECTORS: makeVectors(indexed),
    AUTH_TOKEN: "t",
    ...env,
  };
}

const ctx = { waitUntil() {} };

// ---------------------------------------------------------------------------
const run = async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetch();

  // ------------------------------------------------- pure candidate filters
  eq("a link with no body needs text", needsText(REFS[0]), true);
  eq("a ref with a body does not", needsText(REFS[4]), false);
  eq("an image is not the text job's problem", needsText(REFS[5]), false);
  eq("a note has nothing to fetch", needsText(REFS[10]), false);
  eq("a tried ref is left alone", needsText({ ...REFS[0], enrichTried: "2026-07-01" }), false);
  eq("...unless you ask for a retry", needsText({ ...REFS[0], enrichTried: "2026-07-01" }, { retry: true }), true);

  eq("an uncaptioned image with bytes is a vision candidate", needsCaption(REFS[5]), true);
  eq("a captioned one is not", needsCaption({ ...REFS[5], caption: "already" }), false);
  eq("an image with no bytes anywhere is not", needsCaption({ ...REFS[5], image: "", blobKey: "" }), false);
  eq("a link is never a vision candidate", needsCaption(REFS[0]), false);
  eq("a ref with text is embeddable", embeddable(REFS[0]), true);
  eq("a note with only its own words is too", embeddable(REFS[10]), true);
  // Derived facets are not content: embedTextFor() would still produce
  // "Category: image / Source: cdn…", and paying to embed that is the waste.
  eq("a bare image with no words is not", embeddable({ id: "x", category: "image", host: "cdn.example.com" }), false);

  // ------------------------------------------------------------- the walk
  {
    const env = makeEnv();
    const first = await scanRefs(env, { want: 4, pick: () => true });
    eq("a bounded walk stops at want", first.refs.length, 4);
    eq("and it is not done", first.done, false);
    const all = await scanRefs(env, { want: 100, pick: () => true });
    eq("a wide walk reads the whole archive", all.refs.length, REFS.length);
    eq("and knows it", all.done, true);

    // A KV that throws must never look like an archive with nothing in it.
    const broken = { REFS_KV: { async list() { throw new Error("kv down"); } } };
    const bad = await scanRefs(broken, { want: 5 });
    eq("a failed list returns no refs", bad.refs.length, 0);
    ok("but says why, loudly", /kv down/.test(bad.error || ""));
  }

  // ------------------------------------------------ 1. refuses when spent
  {
    const env = makeEnv();
    env.REFS_KV._seed(LEDGER_KEY, { day: dayStamp(), usd: 5, calls: {}, vision: 0 });
    const before = env.AI.calls.length;

    const out = await runNightly(env, ctx, { now: NOW });
    eq("a spent night refuses to start", out.status, "refused");
    eq("and runs nothing", out.ran.length, 0);
    eq("and spends nothing", env.AI.calls.length - before, 0);
    ok("and says why", /ceiling|spent/i.test(out.stoppedBy || ""));
    eq("every job is marked skipped", JOBS.every((j) => out.jobs[j].status === "skipped"), true);

    const rec = await readRun(env, "2026-07-29");
    ok("a refusal is still recorded", Boolean(rec));
    eq("the record agrees", rec.status, "refused");
    ok("and it says what it would have done", rec.next.length > 0);
    eq("nothing was staged", env.REFS_KV._keys("stage:").length, 0);
  }

  // ------------------------------------- the plan is asked for before work
  {
    const env = makeEnv();
    const out = await runNightly(env, ctx, { now: NOW, dryRun: true });
    eq("a dry run plans only", out.status, "planned");
    ok("the plan quotes every job", JOBS.every((j) => typeof out.plan.jobs[j].cost === "number"));
    ok("the plan knows the ceiling", out.plan.ceiling > 0);
    ok("the plan knows the vision ration", out.plan.visionLeft === DEFAULT_VISION_RATION);
    ok("the whole night is cheap by design", out.plan.wouldCost < 0.05);
    eq("a dry run touches the AI not at all", env.AI.calls.length, 0);
    eq("and writes no record", await readRun(env, "2026-07-29"), null);
  }

  // -------------------------------------------- 2. stops mid-run on ceiling
  {
    // Room for exactly two Tier-2 units ($0.0002 each): the third is refused.
    const env = makeEnv({ env: { NIGHTLY_CEILING_USD: "0.0005" } });
    const out = await runNightly(env, ctx, { now: NOW, jobs: ["embed", "enrich", "vision"] });

    eq("the run reports being stopped", out.status, "stopped");
    ok("and names the governor's reason", /ceiling/i.test(out.stoppedBy || ""));
    eq("the embed job stopped rather than finished", out.jobs.embed.status, "stopped");
    eq("it embedded exactly what it could afford", out.jobs.embed.detail.embedded, 2);
    eq("the ledger agrees", (await env.REFS_KV.get(LEDGER_KEY, "json")).usd, 0.0004);
    eq("the jobs below it never ran", out.jobs.enrich.status, "skipped");
    eq("nor did vision", out.jobs.vision.status, "skipped");
    eq("no vision call happened", env.AI.visions(), 0);
    ok("the record says where to pick up", /resume|stopped/i.test(out.next));
  }

  // ------------------------------------------- 3. never exceeds the ration
  {
    const ration = 3;
    const env = makeEnv({ env: { VISION_RATION: String(ration) } });
    const out = await runNightly(env, ctx, { now: NOW, jobs: ["vision"] });

    eq("vision stops at the ration", env.AI.visions(), ration);
    eq("the ledger booked exactly that", (await env.REFS_KV.get(LEDGER_KEY, "json")).vision, ration);
    eq("and captioned that many", out.jobs.vision.detail.captioned, ration);
    ok("there were more candidates than ration", out.jobs.vision.detail.candidates <= ration);

    // A second run the same night gets nothing more — the ledger is the guard,
    // so a crash between runs cannot hand it a fresh ration.
    const again = await runNightly(env, ctx, { now: NOW, jobs: ["vision"] });
    eq("a second run adds no vision calls", env.AI.visions(), ration);
    eq("and is refused by the ration, not by luck", again.jobs.vision.status, "skipped");
    ok("saying so", /ration/i.test(again.jobs.vision.reason || ""));

    // Two images stay uncaptioned, and that is visible rather than implied.
    const left = [];
    for (const id of ["0006", "0007", "0008", "0009", "0010"]) {
      const r = await env.REFS_KV.get(`ref:${id}`, "json");
      if (!r.caption) left.push(id);
    }
    eq("the rest wait for tomorrow", left.length, REFS.filter((r) => r.category === "image").length - ration);
  }

  // -------------------------------- a rationed call that returns nothing
  {
    const env = makeEnv({ ai: makeAI({ visionFails: true }), env: { VISION_RATION: "2" } });
    const out = await runNightly(env, ctx, { now: NOW, jobs: ["vision"] });
    eq("the ration was still spent", out.jobs.vision.detail.rationSpent, 2);
    eq("but nothing was captioned", out.jobs.vision.detail.captioned, 0);
    ok("and the run record says so instead of looking idle", out.errors.some((e) => /no caption/i.test(e.error || "")));
  }

  // ------------------------------------------------- 4. writes a run record
  {
    const env = makeEnv();
    const out = await runNightly(env, ctx, { now: NOW });

    eq("the night finished", out.status, "done");
    const rec = await readRun(env, "2026-07-29");
    ok("under the dated key", Boolean(env.REFS_KV._raw(RUN_KEY)));
    eq("the record knows its day", rec.day, "2026-07-29");
    ok("it lists what it did", rec.did.length > 0);
    ok("it lists what it skipped or why not", Array.isArray(rec.skipped));
    ok("it records the cost", typeof rec.cost.spent === "number" && rec.cost.spent > 0);
    ok("it records the vision spend", typeof rec.cost.vision === "number");
    ok("it says what it would do next", rec.next.length > 0);
    ok("it keeps the plan it was given", rec.plan.ceiling > 0);
    ok("it timestamps both ends", Boolean(rec.startedAt && rec.finishedAt));
    ok("every job has an outcome", JOBS.every((j) => rec.jobs[j].status !== "pending"));

    // The triage job stages questions; it never answers them.
    const staged = env.REFS_KV._keys("stage:");
    ok("proposals were staged", staged.length > 0);
    const items = [];
    for (const k of staged) items.push(await env.REFS_KV.get(k, "json"));
    ok("all of them are pending", items.every((i) => i.status === "pending"));
    ok("a dead link was caught", items.some((i) => i.kind === "dead-link"));
    ok("and a realm was proposed, not applied", items.some((i) => i.kind === "realm"));
    const dead = await env.REFS_KV.get("ref:0003", "json");
    eq("the dead ref keeps its own title", dead.title, "A page that is gone");
    const bare = await env.REFS_KV.get("ref:0004", "json");
    eq("and the unclassified ref was not given a realm", bare.realm, undefined);

    // Factual repairs, on the other hand, land straight on the ref.
    const enriched = await env.REFS_KV.get("ref:0001", "json");
    ok("page text was written to the ref", (enriched.body || "").includes("tubular chrome harness"));
    ok("and a thumbnail came with it", enriched.image === "https://cdn.example.com/og.jpg");
    ok("and it was re-embedded", env.VECTORS._has("0001"));

    // Cursors outlive the night so the archive gets walked end to end.
    const cursors = await env.REFS_KV.get(CURSOR_KEY, "json");
    ok("cursors are persisted", cursors && typeof cursors === "object");

    const { runs, error } = await recentRuns(env, { limit: 5 });
    eq("the brief can read it back", runs.length, 1);
    eq("with no error", error, null);
    eq("and the cursor key is not mistaken for a run", runs[0].day, "2026-07-29");
  }

  // -------------------------------------- 5. a second run redoes no paid work
  {
    const env = makeEnv();
    const first = await runNightly(env, ctx, { now: NOW });
    const embedsAfterFirst = env.AI.embeds();
    const visionsAfterFirst = env.AI.visions();
    const upsertsAfterFirst = env.VECTORS.upserted.length;
    const spentAfterFirst = (await env.REFS_KV.get(LEDGER_KEY, "json")).usd;
    ok("the first run actually did paid work", embedsAfterFirst > 0);

    const second = await runNightly(env, ctx, { now: NOW });
    eq("the second run is a no-op for the AI", env.AI.embeds(), embedsAfterFirst);
    eq("no extra vision calls", env.AI.visions(), visionsAfterFirst);
    eq("no extra upserts", env.VECTORS.upserted.length, upsertsAfterFirst);
    eq("and no extra spend", (await env.REFS_KV.get(LEDGER_KEY, "json")).usd, spentAfterFirst);
    eq("it is still recorded as a second run", second.runs, 2);
    eq("against the same record", first.day, second.day);
    eq("and the night's cost is the night's, not the retry's", second.cost.spent, first.cost.spent);
    ok("the finished jobs say they were already done", second.skipped.some((s) => /already finished tonight/.test(s)));

    // Nothing was re-enriched because the refs themselves are the checkpoint.
    const one = await env.REFS_KV.get("ref:0001", "json");
    ok("the enriched ref is marked tried", Boolean(one.enrichTried));
    eq("a ref that already had a body was never touched",
      (await env.REFS_KV.get("ref:0005", "json")).enrichTried, undefined);
  }

  // ---------------------------------------------- 6. it can never add a ref
  {
    const env = makeEnv();
    const before = new Set(env.REFS_KV._keys("ref:"));
    const fetchCalls = globalThis.fetch.calls.length;

    await runNightly(env, ctx, { now: NOW });

    const after = new Set(env.REFS_KV._keys("ref:"));
    eq("the archive is exactly as big as it was", after.size, before.size);
    ok("and holds exactly the same refs", [...after].every((k) => before.has(k)));

    // Every ref: key it wrote was one that already existed. Anything else would
    // be a new reference, which is the one thing this file may never create.
    const written = env.REFS_KV.puts.filter((k) => k.startsWith("ref:"));
    ok("every ref write landed on an existing ref", written.every((k) => before.has(k)));
    ok("and nothing outside the known prefixes was written",
      env.REFS_KV.puts.every((k) => /^(ref:|stage:|budget:|nightly:)/.test(k)));

    // It indexes only refs it read out of KV.
    ok("only known refs reached the index", env.VECTORS.upserted.every((id) => before.has(`ref:${id}`)));

    // And it never POSTs anywhere — /save is the only way in, and it is not
    // reachable from here.
    const writes = globalThis.fetch.calls.slice(fetchCalls).filter((c) => c.method !== "GET" && c.method !== "HEAD");
    eq("no write request left the worker", writes.length, 0);
  }

  // ------------------------------------------------------- graceful degrade
  {
    const env = makeEnv();
    delete env.AI;
    delete env.VECTORS;
    const out = await runNightly(env, ctx, { now: NOW });
    eq("with no brain it still completes", out.status, "done");
    eq("embed skips itself", out.jobs.embed.status, "skipped");
    ok("saying why", /not bound/i.test(out.jobs.embed.reason || ""));
    eq("vision skips itself", out.jobs.vision.status, "skipped");
    ok("but the free triage still ran", out.jobs.triage.status !== "skipped");
    ok("and a record was still written", Boolean(await readRun(env, "2026-07-29")));
  }

  // ----------------------------------------------------- no KV is the one wall
  {
    const out = await runNightly({}, ctx, { now: NOW });
    eq("with no KV it refuses honestly", out.ok, false);
    ok("and says what is missing", /REFS_KV/.test(out.error));
  }

  globalThis.fetch = realFetch;
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
