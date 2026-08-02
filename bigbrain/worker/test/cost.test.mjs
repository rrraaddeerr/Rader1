// The cost governor, from the outside in.
//
// budget.js is only a governor for the code that asks it. These tests are about
// the code that DIDN'T: every path that reaches a model has to leave a mark on
// the ledger, or the $5 ceiling and the 20/night vision ration are decoration.
// He was billed badly once; a route that can spend without being counted is the
// bug, whether or not it happens to be called today.
//
// No network, no bindings — a Map-backed KV and an AI stub that counts calls.
// Run: node test/cost.test.mjs
import { enrichRef } from "../src/enrich.js";
import { generate, callClaude } from "../src/ask.js";
import { ledger, DEFAULT_VISION_RATION, DEFAULT_CEILING_USD, TIERS } from "../src/budget.js";

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
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: complete,
        cursor: complete ? undefined : slice[slice.length - 1],
      };
    },
  };
}

/** Counts every model call so a test can assert on calls, not just on dollars. */
function makeAI() {
  const seen = [];
  return {
    seen,
    async run(model, input) {
      seen.push(model);
      if (String(model).includes("embed")) return { data: [[0.1, 0.2, 0.3]] };
      return { description: "a chrome curtain rig against a black cyc", response: "ok" };
    },
  };
}

// Blob bytes live in KV, so captioning never touches the wire.
const imageRef = (i) => ({
  id: `img-${i}`,
  kind: "blob",
  category: "image",
  blobKey: `blob-${i}`,
  title: `screenshot ${i}`,
});

// ------------------------------------------------- vision outside the ration
//
// /api/reindex?deep=1 and the /save deepen pass both call enrichRef directly.
// enrichRef's first branch is a vision call. Nothing between the request and
// the model asks the governor anything, so the 20/night ration — the ONE number
// standing between this archive and 1,241 paid vision calls — is not in the
// path at all.

{
  const kv = makeKV();
  const ai = makeAI();
  const env = { REFS_KV: kv, AI: ai };
  for (let i = 0; i < 40; i++) await kv.put(`blob:blob-${i}`, "bytes");

  let captioned = 0;
  for (let i = 0; i < 40; i++) {
    const patch = await enrichRef(env, imageRef(i));
    if (patch.caption) captioned++;
  }

  const led = await ledger(env);
  ok(
    `40 enrichRef captions stay inside the ${DEFAULT_VISION_RATION}/night ration (captioned ${captioned})`,
    captioned <= DEFAULT_VISION_RATION
  );
  eq("and every vision call it did make is on the ledger", led.vision, captioned);
  // The 41st ask, with the ration long gone: a ref with no caption and no
  // reason is indistinguishable from one the model had nothing to say about.
  const refused = await enrichRef(env, imageRef(5));
  ok("a refused caption says why instead of returning a bare empty patch", typeof refused.captionSkipped === "string");
  ok("and the reason names the ration", /vision ration/.test(refused.captionSkipped || ""));
}

// A caller that has already paid must not be charged twice — cron.js's vision
// job charges with vision:true and then calls enrichRef, and a second charge
// there would silently halve the ration to ten.
{
  const kv = makeKV();
  const env = { REFS_KV: kv, AI: makeAI() };
  await kv.put("blob:blob-1", "bytes");
  const patch = await enrichRef(env, imageRef(1), undefined, { billed: true });
  const led = await ledger(env);
  ok("a billed caption still runs", Boolean(patch.caption));
  eq("and does not charge the ration a second time", led.vision, 0);
}

// No AI binding means no model call, so there is nothing to charge for. A
// governor that books a spend that never happened is as wrong as one that
// misses a spend that did.
{
  const kv = makeKV();
  const env = { REFS_KV: kv };
  await kv.put("blob:blob-2", "bytes");
  await enrichRef(env, imageRef(2));
  const led = await ledger(env);
  eq("an unbound AI is charged nothing", led.vision, 0);
  eq("and costs nothing", led.usd, 0);
}

// ------------------------------------------------------ the frontier tier
//
// TIERS[3] exists, is priced at $0.02 a call, and the only caller that ever
// books it is the morning brief. /api/ask?deep=1 and /api/profile go straight
// to api.anthropic.com. One HTTP request, one metered-nowhere Claude call —
// and the ledger reads $0.00 all night.

const anthropicCalls = () => globalThis.__anthropic || 0;
function stubAnthropic() {
  globalThis.__anthropic = 0;
  globalThis.fetch = async () => {
    globalThis.__anthropic++;
    return new Response(JSON.stringify({ content: [{ type: "text", text: "the through-line is the rig" }] }), {
      headers: { "content-type": "application/json" },
    });
  };
}

{
  stubAnthropic();
  const kv = makeKV();
  const env = { REFS_KV: kv, AI: makeAI(), ANTHROPIC_API_KEY: "sk-test" };

  const tries = 400;
  for (let i = 0; i < tries; i++) {
    await generate(env, { system: "s", user: `q${i}`, deep: true });
  }

  const led = await ledger(env);
  const affordable = Math.floor(DEFAULT_CEILING_USD / TIERS[3].usdPerUnit);
  ok(
    `${tries} deep calls cannot outrun the $${DEFAULT_CEILING_USD} ceiling (made ${anthropicCalls()})`,
    anthropicCalls() <= affordable
  );
  ok("and the frontier spend is visible on the ledger", led.usd > 0);
  eq("charged at the frontier tier", led.calls?.["3"] ?? 0, anthropicCalls());
}

// Refusal degrades to the cheap tier rather than failing the answer, and says
// so — a silent fallback is how "the deep tier is broken" goes unnoticed.
{
  stubAnthropic();
  const kv = makeKV();
  const env = { REFS_KV: kv, AI: makeAI(), ANTHROPIC_API_KEY: "sk-test" };
  await kv.put("budget:" + new Date().toISOString().slice(0, 10), JSON.stringify({ usd: DEFAULT_CEILING_USD, calls: {}, vision: 0 }));

  const out = await generate(env, { system: "s", user: "q", deep: true });
  eq("no Claude call once the ceiling is gone", anthropicCalls(), 0);
  ok("but an answer still comes back from the cheap tier", Boolean(out.text));
  ok(
    "and the reason is in errors, not swallowed",
    (out.errors || []).some((e) => /ceiling|budget|governor/i.test(String(e)))
  );
}

// The brief books tier 3 itself before calling generate(). It must be able to
// say so, or one paragraph a morning costs two units.
{
  stubAnthropic();
  const kv = makeKV();
  const env = { REFS_KV: kv, AI: makeAI(), ANTHROPIC_API_KEY: "sk-test" };
  await callClaude(env, { system: "s", user: "q", billed: true });
  const led = await ledger(env);
  eq("an already-booked Claude call is not charged twice", led.usd, 0);
  eq("and it still ran", anthropicCalls(), 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
