// Tests for the morning brief: the pure windowing/grouping helpers, then the
// whole buildBrief() pass against a Map-backed KV, a fake Vectorize and a fake
// AI. Finally the page's inline script is pulled out and compiled, because a
// syntax error in a template-literal page is invisible until the phone loads it.
// No deps, no network, no bindings. Run: node test/brief.test.mjs
import vm from "node:vm";
import {
  buildBrief,
  buildDigest,
  refCreatedAt,
  groupByRealm,
  briefKey,
  BRIEF_TTL_MS,
  UNASSIGNED,
} from "../src/brief.js";
import { BRIEF_HTML } from "../src/pages/brief.js";
import * as queue from "../src/stage.js";
import { ledger } from "../src/budget.js";

let pass = 0, fail = 0;
function ok(label, cond) { cond ? pass++ : (fail++, console.error("✗ " + label)); }
function eq(label, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}

function makeKV() {
  const store = new Map();
  return {
    store,
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
  };
}

// Ref ids are reverse-timestamped, so a plain key list comes back newest-first.
const TS_MAX = 10_000_000_000_000;
let seq = 0;
function idAt(ms) {
  const rand = String(seq++).padStart(8, "0").replace(/\D/g, "0");
  return `${String(TS_MAX - ms).padStart(14, "0")}-${rand}`;
}

const NOW = Date.parse("2026-07-29T14:00:00Z");
const HOUR = 3600000;
const DAY = 24 * HOUR;

/** Seed a KV with refs at given ages (hours back from NOW). */
async function seedRefs(kv, specs) {
  for (const s of specs) {
    const at = NOW - s.hoursAgo * HOUR;
    const ref = {
      id: idAt(at),
      title: s.title,
      category: s.category || "link",
      url: s.url || `https://example.test/${encodeURIComponent(s.title)}`,
      ...(s.realm ? { realm: s.realm } : {}),
      ...(s.undated ? {} : { createdAt: new Date(at).toISOString() }),
    };
    await kv.put(`ref:${ref.id}`, JSON.stringify(ref));
  }
}

// ------------------------------------------------------------ pure: dating
eq("createdAt wins", refCreatedAt({ createdAt: "2026-07-29T00:00:00Z" }), Date.parse("2026-07-29T00:00:00Z"));
eq(
  "falls back to the reverse-timestamped id",
  refCreatedAt({ id: `${String(TS_MAX - Date.parse("2026-07-01T00:00:00Z")).padStart(14, "0")}-a1b2c3d4` }),
  Date.parse("2026-07-01T00:00:00Z")
);
// A Notion row that kept its own id can't be dated from it — and guessing here
// would file the whole 1,578-row import under "landed overnight".
eq("a foreign id is not a date", refCreatedAt({ id: "notion-1234" }), null);
eq("no date and no id -> null", refCreatedAt({ title: "x" }), null);
eq("garbage in -> null", refCreatedAt(null), null);
eq("unparseable createdAt falls through to the id", refCreatedAt({ createdAt: "soon", id: "nope" }), null);

// ----------------------------------------------------------- pure: grouping
const grouped = groupByRealm([
  { realm: "INSPO" }, { realm: "INSPO" }, { realm: "KNOWLEDGE" }, {}, { realm: "  " },
]);
eq("counts a realm", grouped.INSPO, 2);
eq("counts another", grouped.KNOWLEDGE, 1);
// Realm is a taste judgment. A ref without one is reported as unassigned, never
// run through classify() — a guess in the shape report is indistinguishable
// from something he decided.
eq("no realm is named, not guessed", grouped[UNASSIGNED], 2);
eq("empty in, empty out", Object.keys(groupByRealm([])).length, 0);

// ------------------------------------------------------------------ the pass
const kv = makeKV();
await seedRefs(kv, [
  { title: "Chrome harness rig", realm: "INSPO", hoursAgo: 2, category: "image" },
  { title: "Sodium vapour, Gastown", realm: "INSPO", hoursAgo: 9, category: "image" },
  { title: "Model eval costs", realm: "KNOWLEDGE", hoursAgo: 20 },
  { title: "Last week's runway", realm: "CULTURE+NEWS", hoursAgo: 70 },
  { title: "Older still", hoursAgo: 100 },
  { title: "Ancient", realm: "INSPO", hoursAgo: 40 * 24 },
  { title: "Also ancient", hoursAgo: 60 * 24 },
]);

await queue.propose({ REFS_KV: kv }, {
  kind: "tag",
  proposals: [
    { url: "https://insta/1", currentTitle: "Instagram", proposedTitle: "@welcome.jpeg · 1", realm: "INSPO" },
    { url: "https://insta/2", currentTitle: "Instagram", proposedTitle: "@noeloquence · 2", realm: "INSPO" },
  ],
});

let aiPrompts = [];
const AI = {
  async run(model, input) {
    aiPrompts.push(input.messages.map((m) => m.content).join("\n---\n"));
    return { response: "Three refs landed overnight, all of them image work." };
  },
};
const VECTORS = { async describe() { return { dimensions: 768, vectorCount: 5 }; } };

const env = { REFS_KV: kv, AI, VECTORS };
const brief = await buildBrief(env, { now: NOW });

eq("the brief builds", brief.ok, true);
eq("stamped with the UTC day", brief.day, "2026-07-29");
eq("a fresh build is not cached", brief.cached, false);

// ---- what landed ----
eq("counts the last 24h", brief.landed.day.count, 3);
eq("counts the last 7d", brief.landed.week.count, 5);
eq("the 24h window is grouped by realm", brief.landed.day.byRealm.INSPO, 2);
ok("and carries titles", brief.landed.day.refs.some((r) => r.title === "Chrome harness rig"));
ok("newest first", brief.landed.week.refs[0].title === "Chrome harness rig");
eq("the walk finished", brief.landed.complete, true);
ok("last save is dated", brief.landed.lastSaveAt === new Date(NOW - 2 * HOUR).toISOString());
eq("and turned into hours", brief.landed.quietHours, 2);

// ---- what is waiting ----
eq("queue counts come through", brief.waiting.pending, 2);
eq("nothing approved yet", brief.waiting.approved, 0);
eq("no queue error", brief.waiting.error, null);

// ---- the archive's shape ----
eq("total is every key", brief.shape.total, 7);
eq("and it is exact", brief.shape.exact, true);
eq("embedded comes from describe()", brief.shape.embedded, 5);
eq("so does the unindexed remainder", brief.shape.unindexed, 2);
eq("the split says what it is based on", brief.shape.basedOn, 7);
eq("unassigned refs are counted", brief.shape.byRealm[UNASSIGNED], 2);

// ---- what it cost ----
ok("the ceiling is reported", brief.cost.ceiling > 0);
ok("the synthesis was charged", brief.cost.usd > 0);
eq("the ledger agrees", (await ledger(env)).usd, brief.cost.usd);

// ---- the synthesis ----
ok("the model wrote it", brief.synthesis.text.startsWith("Three refs"));
eq("cheap tier without an API key", brief.synthesis.tier, 2);
ok("the prompt carries the real numbers", aiPrompts[0].includes("Landed in the last 24h: 3"));
ok("and the queue count", aiPrompts[0].includes("2 pending swipes"));
ok("and his register", aiPrompts[0].includes("archive / warehouse / operating-system"));
// SYSTEM_PROMPT tells the model to cite [1]/[2]; there's no source list here.
ok("citations are turned off for the brief", aiPrompts[0].includes("No citation numbers"));

// ---- caching ----
ok("the brief was cached", kv.store.has(briefKey("2026-07-29")));
const reopened = await buildBrief(env, { now: NOW + 60000 });
eq("reopening serves the cache", reopened.cached, true);
ok("and it has an age", reopened.ageMs >= 60000);
eq("reopening costs nothing", (await ledger(env)).usd, brief.cost.usd);
eq("no second model call", aiPrompts.length, 1);

const forced = await buildBrief(env, { now: NOW + 60000, refresh: true });
eq("refresh rebuilds", forced.cached, false);
eq("and calls the model again", aiPrompts.length, 2);

// His morning isn't UTC midnight, so age is what governs freshness, not the day
// stamp on the key.
const stale = await buildBrief(env, { now: NOW + BRIEF_TTL_MS + 120000 });
eq("a stale cache is rebuilt", stale.cached, false);
eq("same day, same key", stale.day, "2026-07-29");
const callsSoFar = aiPrompts.length;

// ------------------------------------------------- degrading without a model
const bare = { REFS_KV: makeKV() };
await seedRefs(bare.REFS_KV, [{ title: "One thing", hoursAgo: 3 }]);
const noAI = await buildBrief(bare, { now: NOW });
eq("no AI still builds", noAI.ok, true);
eq("the numbers are still there", noAI.landed.day.count, 1);
eq("but the paragraph is honestly absent", noAI.synthesis.text, null);
ok("and it says why", noAI.synthesis.reason.includes("no AI"));
// No Vectorize binding: unknown is null, never 0 — a zero here reads as a lost index.
eq("embedded is unknown, not zero", noAI.shape.embedded, null);
ok("and the reason is surfaced", noAI.errors.some((e) => e.stage === "vectors"));

// -------------------------------------------------- a refused charge degrades
const brokeKV = makeKV();
await seedRefs(brokeKV, [{ title: "Something new", hoursAgo: 1 }]);
// Park the ledger at the ceiling so the governor has to say no.
await brokeKV.put("budget:2026-07-29", JSON.stringify({ day: "2026-07-29", usd: 5, calls: {}, vision: 0 }));
const refused = await buildBrief({ REFS_KV: brokeKV, AI }, { now: NOW, deep: true });
eq("a refused charge still builds the brief", refused.ok, true);
eq("no paragraph was written", refused.synthesis.text, null);
ok("the refusal reason is carried", refused.synthesis.reason.includes("ceiling"));
ok("and logged as a budget error", refused.errors.some((e) => e.stage === "budget"));
eq("the model was never called", aiPrompts.length, callsSoFar);

// ------------------------------------------- a broken queue is null, not zero
// The rule this whole file is built around: a scan that failed and a queue that
// is empty must never render as the same number.
const flakyKV = makeKV();
await seedRefs(flakyKV, [{ title: "New ref", hoursAgo: 1 }]);
const flaky = {
  REFS_KV: {
    ...flakyKV,
    async list(opts = {}) {
      if (String(opts.prefix || "").startsWith("stage:")) throw new Error("KV list blew up");
      return flakyKV.list(opts);
    },
    get: (...a) => flakyKV.get(...a),
    put: (...a) => flakyKV.put(...a),
  },
};
const broken = await buildBrief(flaky, { now: NOW });
eq("a failed queue scan is null", broken.waiting.pending, null);
ok("never zero", broken.waiting.pending !== 0);
ok("and it says what happened", broken.waiting.error.includes("blew up"));
ok("the failure reaches the errors list", broken.errors.some((e) => e.stage === "queue"));
eq("the rest of the brief still builds", broken.landed.day.count, 1);

// ---------------------------------------------------- undated refs are counted
const undatedKV = makeKV();
// Foreign ids with no createdAt — a Notion import that didn't carry dates.
for (let i = 0; i < 3; i++) {
  await undatedKV.put(`ref:notion-${i}`, JSON.stringify({ id: `notion-${i}`, title: `Row ${i}` }));
}
await seedRefs(undatedKV, [{ title: "A real one", hoursAgo: 2 }]);
const mixed = await buildBrief({ REFS_KV: undatedKV }, { now: NOW });
eq("undated refs are counted, not guessed at", mixed.landed.undated, 3);
eq("and they never land in the overnight column", mixed.landed.day.count, 1);
eq("but they do count toward the total", mixed.shape.total, 4);

// ------------------------------------------------------------ missing binding
const nothing = await buildBrief({}, { now: NOW });
eq("no KV is a clear refusal", nothing.ok, false);
ok("with a reason", nothing.error.includes("REFS_KV"));

// ------------------------------------------------------------------- digest
const digest = buildDigest(brief);
ok("digest names the day", digest.includes("2026-07-29"));
ok("digest carries the realm split", digest.includes("INSPO"));
ok("digest carries the spend", digest.includes("Spend today"));
ok("digest asks for three sentences", digest.includes("Three sentences"));
// Never let a truncated scan read as a complete count.
const floored = buildDigest({ ...brief, landed: { ...brief.landed, complete: false } });
ok("a truncated scan is labelled in the digest", floored.includes("read cap"));
const unknownQueue = buildDigest({ ...brief, waiting: { pending: null } });
ok("an unknown queue is labelled in the digest", unknownQueue.includes("queue scan failed"));
ok("digest survives an empty brief", typeof buildDigest({}) === "string");

// -------------------------------------------------------------------- the page
// A page is a template literal, so a syntax error in its script is invisible
// until a phone loads it at 7am. Compile it here instead.
const scripts = [...BRIEF_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
eq("the page has exactly one inline script", scripts.length, 1);
const src = scripts[0][1];
let compiled = null;
try { compiled = new vm.Script(src, { filename: "brief-page.js" }); }
catch (err) { console.error("✗ inline script does not parse\n   " + err.message); }
ok("the inline script parses", Boolean(compiled));

ok("token comes from localStorage under the shared key", src.includes('localStorage.getItem(KEY)') && src.includes('"bigbrain_token"'));
ok("it calls the brief route", src.includes('"/api/brief"'));
ok("it sends the auth header", src.includes("X-Auth-Token"));
ok("it can force a refresh", src.includes('p.set("refresh","1")'));
ok("what needs a decision links to the queue", src.includes('href="/queue"'));
ok("it has a wordless fallback for a refused synthesis", src.includes("function headline"));

// Self-contained: no CDN, no fonts, no chart library.
ok("no external assets", !/(src|href)\s*=\s*["']https?:/i.test(BRIEF_HTML));
ok("shares the palette with /browse", BRIEF_HTML.includes("--bg:#0f1115") && BRIEF_HTML.includes("--blue:#3b82f6"));
ok("phone-first viewport", BRIEF_HTML.includes('name="viewport"'));
ok("the realm split is CSS, not a chart library", BRIEF_HTML.includes('class="bar"'));

// Parsing isn't enough — a typo in a render path only shows up when it runs.
// Give the script a stub DOM, feed it a real brief, and read what it painted.
async function renderPage(payload) {
  const els = new Map();
  const node = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, innerHTML: "", textContent: "", onclick: null,
        classList: {
          set: new Set(),
          add(c) { this.set.add(c); },
          remove(c) { this.set.delete(c); },
          contains(c) { return this.set.has(c); },
        },
      });
    }
    return els.get(id);
  };
  const calls = [];
  const sandbox = {
    console,
    URLSearchParams,
    localStorage: { getItem: () => "tok", removeItem() {} },
    location: { href: "/brief" },
    document: {
      querySelector: (sel) => node(sel.replace(/^#/, "")),
      getElementById: (id) => node(id),
    },
    async fetch(url, opts) {
      calls.push({ url, headers: opts?.headers || {} });
      return { status: 200, async json() { return payload; } };
    },
  };
  vm.createContext(sandbox);
  compiled.runInContext(sandbox);
  // Let the load() promise chain drain — vm contexts share this microtask queue.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  return { els, calls, node };
}

const painted = await renderPage(brief);
eq("the page fetched the brief once", painted.calls.length, 1);
eq("with the token attached", painted.calls[0].headers["X-Auth-Token"], "tok");
ok("the synthesis lands at the top", painted.node("synth").innerHTML.includes("Three refs landed overnight"));
ok("counts are painted as tiles", painted.node("tiles").innerHTML.includes("<b>3<"));
ok("the strip shows what landed", painted.node("strip").innerHTML.includes("Chrome harness rig"));
ok("the decision links to the queue", painted.node("decide").innerHTML.includes('href="/queue"'));
ok("and shows how many are waiting", painted.node("decide").innerHTML.includes(">2<"));
ok("the realm bar has segments", painted.node("shape").innerHTML.includes("width:"));
ok("the shape says what it is based on", painted.node("shape").innerHTML.includes("newest 7 refs read"));
ok("the footer offers a refresh", painted.node("foot").innerHTML.includes('id="refresh"'));

// A model that was refused must not blank the page — the numbers are the brief.
const wordless = await renderPage(refused);
ok("no synthesis still reads like a brief", wordless.node("synth").innerHTML.includes("landed in the last 24 hours"));
ok("and says the paragraph is missing", wordless.node("synth").innerHTML.includes("ceiling"));

// A null queue count must never paint as zero.
const unknown = await renderPage(broken);
ok("an unknown queue count says so", unknown.node("decide").innerHTML.includes("queue scan failed"));
ok("and never claims the queue is clear", !unknown.node("decide").innerHTML.includes("Queue clear"));
ok("the tile shows a dash, not a nought", unknown.node("tiles").innerHTML.includes("—"));

// The error state has to be reachable too.
const dead = await renderPage({ ok: false, error: "REFS_KV binding missing" });
ok("a failed build shows the reason", dead.node("synth").innerHTML.includes("REFS_KV binding missing"));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
