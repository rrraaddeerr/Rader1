// Tests for the worker half of Tier 1 — the lease/submit pair his Mac talks to.
// The runner's own tests live in ../../local/test.mjs; these are the other side
// of the wire. Map-backed KV, fake Workers AI, fake Vectorize. No deps, no
// network, no Ollama. Run: node test/local.test.mjs
import {
  leaseJobs,
  submitResults,
  localStatus,
  captionable,
  summarizable,
  jobIdFor,
  parseJobId,
  LEASE_PREFIX,
  CURSOR_KEY,
  LOCAL_KINDS,
  KIND_LEVEL,
} from "../src/local.js";
import { ledger, dayStamp } from "../src/budget.js";
import { EMBED_MODEL } from "../src/embed.js";
import { levelOf, stepState } from "../src/ladder.js";

let pass = 0, fail = 0;
function ok(label, cond) { cond ? pass++ : (fail++, console.error("✗ " + label)); }
function eq(label, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}

const NOW = new Date("2026-08-02T04:00:00Z");
const LEDGER_KEY = `budget:${dayStamp()}`;
const ORIGIN = "https://save-ref-v2.example.workers.dev";

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
    _get: (name) => (store.has(name) ? JSON.parse(store.get(name)) : null),
    _keys: (prefix = "") => [...store.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
}

const DIMS = 8;
function makeAI() {
  const calls = [];
  return {
    calls,
    embeds: () => calls.filter((c) => c.model === EMBED_MODEL).length,
    async run(model, input) {
      calls.push({ model, input });
      if (model === EMBED_MODEL) {
        const list = Array.isArray(input.text) ? input.text : [input.text];
        return { data: list.map(() => new Array(DIMS).fill(0.3)) };
      }
      return {};
    },
  };
}

function makeVectors() {
  const upserted = [];
  return {
    upserted,
    async upsert(list) { for (const v of list) upserted.push(v.id); return { count: list.length }; },
    async getByIds() { return []; },
    async query() { return { matches: [] }; },
    async deleteByIds() {},
  };
}

// An uncaptioned image with reachable bytes, a video whose transcript we pulled
// but never summarised, and a plain link that is neither.
const REFS = [
  { id: "0001", kind: "url", category: "image", url: "https://cdn.example.com/a.jpg", image: "https://cdn.example.com/a.jpg", host: "cdn.example.com", title: "Chrome study a", tags: [] },
  { id: "0002", kind: "url", category: "image", blobKey: "abc123", host: "cdn.example.com", title: "Pasted screenshot", tags: [] },
  { id: "0003", kind: "url", category: "video", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", host: "youtube.com", title: "Rig walkthrough", transcript: "x".repeat(900), tags: [] },
  { id: "0004", kind: "url", category: "link", url: "https://example.com/read", host: "example.com", title: "An article", body: "y".repeat(400), enrichTried: "2026-07-01", tags: [] },
];

function makeEnv({ refs = REFS, brain = true } = {}) {
  const kv = makeKV();
  for (const r of refs) kv._seed(`ref:${r.id}`, r);
  const env = { REFS_KV: kv, AUTH_TOKEN: "t" };
  if (brain) { env.AI = makeAI(); env.VECTORS = makeVectors(); }
  return env;
}

const run = async () => {
  // ------------------------------------------------------- pure candidates
  eq("an uncaptioned image with bytes is captionable", captionable(REFS[0]), true);
  eq("a captioned one is not", captionable({ ...REFS[0], caption: "already" }), false);
  eq("an image with no bytes anywhere is not", captionable({ ...REFS[0], image: "", blobKey: "" }), false);
  eq("an article is never a caption job", captionable(REFS[3]), false);
  // The ladder owns "give up": a rung marked permanently blocked must not be
  // handed to the Mac every night for the rest of the archive's life.
  eq("a permanently blocked rung is not offered",
    captionable({ ...REFS[0], ladder: { steps: { 3: { ok: false, permanent: true, attempts: 1, reason: "gone (404)" } } } }), false);

  eq("a transcript with no summary is summarizable", summarizable(REFS[2]), true);
  eq("one that has a summary is not", summarizable({ ...REFS[2], summary: "done" }), false);
  // The governor refused the Tier 2 summariser mid-climb and left this behind.
  // Free compute is exactly the right tier to mop it up with.
  eq("a refused summary is still a leftover", summarizable({ ...REFS[2], summaryError: "budget" }), true);
  eq("no transcript, no job", summarizable(REFS[3]), false);

  eq("job ids are deterministic", jobIdFor("caption", "0001"), "caption:0001");
  eq("and they round-trip", parseJobId("caption:0001").refId, "0001");
  eq("even through a ref id full of dashes", parseJobId("caption:00099-ab-cd").refId, "00099-ab-cd");

  // ------------------------------------------------------------- the lease
  {
    const env = makeEnv();
    const out = await leaseJobs(env, { runner: "mac", limit: 8, origin: ORIGIN, now: NOW });

    eq("the lease succeeds", out.ok, true);
    eq("and hands out every candidate", out.jobs.length, 3);
    ok("with no error", out.error === null);

    const cap = out.jobs.find((j) => j.kind === "caption" && j.refId === "0001");
    ok("a caption job is offered", Boolean(cap));
    eq("at the right rung", cap.level, KIND_LEVEL.caption);
    eq("with the image url", cap.payload.imageUrl, "https://cdn.example.com/a.jpg");
    ok("and its title, so the model has context", cap.payload.title === "Chrome study a");
    ok("it carries a deadline", Date.parse(cap.leaseExpiresAt) > NOW.getTime());
    ok("and a nonce", typeof cap.leaseId === "string" && cap.leaseId.length > 8);

    // An uploaded blob beats a remote url: it can't 404 or rate-limit us, and
    // /blob/ is public so the runner needs no token for the bytes.
    const blob = out.jobs.find((j) => j.refId === "0002");
    eq("a pasted image is served from our own blob", blob.payload.imageUrl, `${ORIGIN}/blob/abc123`);

    const sum = out.jobs.find((j) => j.kind === "summarize");
    eq("a summarize job carries the transcript", sum.payload.text.length, 900);
    eq("and says where it came from", sum.payload.source, "transcript");

    // THE rule for this file: local captions must not eat the paid vision
    // ration. Spending it on free compute would defeat the whole of Tier 1.
    const led = await ledger(env, dayStamp());
    eq("the lease costs nothing", led.usd, 0);
    eq("and burns none of the vision ration", led.vision, 0);
    ok("but it is booked as tier 1 work", (led.calls["1"] || 0) === 3);

    // A leased job is not offered again.
    const again = await leaseJobs(env, { runner: "other", limit: 8, origin: ORIGIN, now: NOW });
    eq("a second runner gets nothing", again.jobs.length, 0);
    eq("and it is not an error", again.ok, true);

    // ...until the lease lapses. Nothing has to observe the crash.
    const later = new Date(NOW.getTime() + 3600_000);
    const relet = await leaseJobs(env, { runner: "other", limit: 8, origin: ORIGIN, now: later });
    eq("an expired lease returns to the pool", relet.jobs.length, 3);
  }

  // --------------------------------------------------------------- the ping
  {
    const env = makeEnv();
    const out = await leaseJobs(env, { runner: "mac", limit: 0, now: NOW });
    eq("limit 0 is a legal ping", out.ok, true);
    eq("and hands out nothing", out.jobs.length, 0);
    eq("and reads no KV at all", env.REFS_KV.puts.length, 0);
  }

  // ------------------------------------------------------------ kind filter
  {
    const env = makeEnv();
    const out = await leaseJobs(env, { limit: 8, kinds: ["summarize"], origin: ORIGIN, now: NOW });
    eq("asking for one kind gets one kind", out.jobs.length, 1);
    eq("and it is that kind", out.jobs[0].kind, "summarize");

    const bad = await leaseJobs(env, { limit: 4, kinds: ["translate"] });
    eq("an unknown kind is refused", bad.ok, false);
    ok("with the list of real ones", bad.error.includes(LOCAL_KINDS[0]));
  }

  // ------------------------------------------------------- a caption lands
  {
    const env = makeEnv();
    const lease = await leaseJobs(env, { runner: "mac", limit: 8, origin: ORIGIN, now: NOW });
    const job = lease.jobs.find((j) => j.kind === "caption" && j.refId === "0001");

    const out = await submitResults(env, {
      runner: "mac",
      results: [{ jobId: job.jobId, leaseId: job.leaseId, ok: true, kind: "caption", result: { caption: "a chrome tube rig on a white cyc" }, model: "llava:latest", ms: 4210 }],
      release: [],
      now: NOW,
    });

    eq("the submit succeeds", out.ok, true);
    eq("one result applied", out.applied, 1);
    eq("nothing was stale", out.stale.length, 0);

    const ref = env.REFS_KV._get("ref:0001");
    eq("the caption is on the ref", ref.caption, "a chrome tube rig on a white cyc");
    eq("and the model that wrote it is recorded", ref.localModel, "llava:latest");
    eq("the rung is satisfied and never offered again", captionable(ref), false);
    // The LEVEL does not jump, and shouldn't: rungs 1 and 2 apply to this ref
    // and haven't happened, so calling it level 3 would tell the histogram the
    // archive is deeper than it is. Rungs are independent; levels are ordered.
    eq("but the level still reports what the ref actually carries", levelOf(ref), 0);
    eq("the attempt was recorded as a success", stepState(ref, 3).ok, true);

    // A caption IS in embedTextFor(), so the stored vector is now wrong.
    ok("the ref was re-embedded", env.VECTORS.upserted.includes("0001"));
    const led = await ledger(env, dayStamp());
    ok("the re-embed was charged at tier 2", (led.calls["2"] || 0) === 1);
    eq("and still no vision ration was touched", led.vision, 0);

    // The lease is gone, so the job is not handed out again.
    eq("the lease was cleared", env.REFS_KV._keys(LEASE_PREFIX).includes(`${LEASE_PREFIX}${job.jobId}`), false);
  }

  // ------------------------------------------------------ a summary lands
  {
    const env = makeEnv();
    const lease = await leaseJobs(env, { limit: 8, kinds: ["summarize"], origin: ORIGIN, now: NOW });
    const job = lease.jobs[0];
    const before = env.AI.embeds();

    const out = await submitResults(env, {
      results: [{ jobId: job.jobId, leaseId: job.leaseId, ok: true, kind: "summarize", result: { summary: "He welds the rig, then shoots through it." }, model: "llama3.1", ms: 900 }],
      now: NOW,
    });

    eq("the summary applied", out.applied, 1);
    const ref = env.REFS_KV._get("ref:0003");
    ok("and landed on the ref", ref.summary.startsWith("He welds"));
    // `summary` is NOT in embedTextFor(). Paying to re-embed one would be a
    // charge with nothing behind it.
    eq("a summary does not trigger a re-embed", env.AI.embeds(), before);
    eq("nor an upsert", env.VECTORS.upserted.length, 0);
  }

  // ------------------------------------------------- a reported failure
  {
    const env = makeEnv();
    const lease = await leaseJobs(env, { limit: 8, origin: ORIGIN, now: NOW });
    const job = lease.jobs.find((j) => j.refId === "0001");

    const out = await submitResults(env, {
      results: [{ jobId: job.jobId, leaseId: job.leaseId, ok: false, error: "image fetch 404", permanent: true, ms: 300 }],
      now: NOW,
    });

    eq("nothing was applied", out.applied, 0);
    eq("but the attempt was recorded", out.recorded, 1);

    const ref = env.REFS_KV._get("ref:0001");
    eq("no caption was invented", ref.caption, undefined);
    const st = stepState(ref, 3);
    eq("the failure is on the ladder", st.ok, false);
    // The runner is the only thing that saw the failure, so its verdict on
    // whether this can ever work is the one we honour.
    eq("and its permanence is honoured", st.permanent, true);
    eq("so it is never offered again", captionable(ref), false);
  }

  // ------------------------------------ a success with nothing in it is not one
  {
    const env = makeEnv();
    const lease = await leaseJobs(env, { limit: 8, origin: ORIGIN, now: NOW });
    const job = lease.jobs.find((j) => j.refId === "0001");
    const out = await submitResults(env, {
      results: [{ jobId: job.jobId, leaseId: job.leaseId, ok: true, kind: "caption", result: { caption: "   " } }],
      now: NOW,
    });
    eq("an empty caption is not applied", out.applied, 0);
    eq("it is recorded as a failure", out.recorded, 1);
    const ref = env.REFS_KV._get("ref:0001");
    eq("the rung stays unsatisfied", Boolean(ref.caption), false);
    eq("and the failure is transient — a bug is not a foreclosure", stepState(ref, 3).permanent, false);
    ok("and it is said out loud", out.errors.some((e) => /empty caption/.test(e.error)));
  }

  // ------------------------------------------------------------ the release
  {
    const env = makeEnv();
    const lease = await leaseJobs(env, { limit: 8, origin: ORIGIN, now: NOW });
    const job = lease.jobs.find((j) => j.refId === "0001");

    const out = await submitResults(env, {
      release: [{ jobId: job.jobId, leaseId: job.leaseId, reason: "runner shutting down" }],
      now: NOW,
    });

    eq("the release is counted", out.released, 1);
    const ref = env.REFS_KV._get("ref:0001");
    // The distinction the whole file hangs on: our laptop closing is not the
    // ref's fault, so it costs the ref no retry slot.
    eq("no attempt was recorded against the ref", ref.ladder, undefined);
    eq("and the job is back in the pool", (await leaseJobs(env, { limit: 8, origin: ORIGIN, now: NOW })).jobs.some((j) => j.refId === "0001"), true);
  }

  // ------------------------------------------------------------ zombie runner
  {
    const env = makeEnv();
    const first = await leaseJobs(env, { runner: "mac", limit: 8, origin: ORIGIN, now: NOW });
    const job = first.jobs.find((j) => j.refId === "0001");

    // The lease lapses, another runner takes the job, and then the first one
    // wakes up and submits. Its answer must not overwrite the live one.
    const later = new Date(NOW.getTime() + 3600_000);
    await leaseJobs(env, { runner: "mac2", limit: 8, origin: ORIGIN, now: later });

    const out = await submitResults(env, {
      runner: "mac",
      results: [{ jobId: job.jobId, leaseId: job.leaseId, ok: true, kind: "caption", result: { caption: "twenty minutes too late" } }],
      now: later,
    });

    eq("the zombie's answer is refused", out.applied, 0);
    eq("and reported as stale", out.stale.length, 1);
    ok("saying who holds it now", /another runner/.test(out.stale[0].why));
    eq("the ref is untouched", env.REFS_KV._get("ref:0001").caption, undefined);
  }

  // ---------------------------------------------- it can never add a ref
  {
    const env = makeEnv();
    const before = new Set(env.REFS_KV._keys("ref:"));
    const lease = await leaseJobs(env, { limit: 8, origin: ORIGIN, now: NOW });

    // An answer for a ref that no longer exists must not resurrect it.
    const job = lease.jobs.find((j) => j.refId === "0001");
    await env.REFS_KV.delete("ref:0001");
    const out = await submitResults(env, {
      results: [{ jobId: job.jobId, leaseId: job.leaseId, ok: true, kind: "caption", result: { caption: "for a ref that is gone" } }],
      now: NOW,
    });

    eq("a deleted ref is not recreated", env.REFS_KV._keys("ref:").length, before.size - 1);
    eq("and nothing was applied", out.applied, 0);
    ok("with a reason", out.errors.some((e) => /deleted/.test(e.error)));
    ok("every ref write landed on a ref that already existed",
      env.REFS_KV.puts.filter((k) => k.startsWith("ref:")).every((k) => before.has(k)));
    ok("and nothing outside the known prefixes was written",
      env.REFS_KV.puts.every((k) => /^(ref:|budget:|local:)/.test(k)));
  }

  // -------------------------------------------------------- degrading
  {
    const out = await leaseJobs({}, { limit: 4 });
    eq("no KV is a clear refusal", out.ok, false);
    ok("and it says what is missing", /REFS_KV/.test(out.error));
    eq("not an empty pool", out.jobs.length, 0);

    const sub = await submitResults({}, { results: [] });
    eq("submit refuses too", sub.ok, false);
    ok("with a reason", /REFS_KV/.test(sub.error));
  }

  // A KV that throws must never look like a drained pool: the runner would
  // print "nothing left to do" and go to sleep on a broken worker.
  {
    const broken = { REFS_KV: { async list() { throw new Error("kv down"); }, async get() { return null; }, async put() {} } };
    const out = await leaseJobs(broken, { limit: 4, now: NOW });
    eq("a failed list hands out nothing", out.jobs.length, 0);
    ok("but says why, loudly", /kv down/.test(out.error || ""));
    ok("and never claims the pool is empty", out.available !== 0);
  }

  // ------------------------------------------------------ without a brain
  {
    const env = makeEnv({ brain: false });
    const lease = await leaseJobs(env, { limit: 8, origin: ORIGIN, now: NOW });
    const job = lease.jobs.find((j) => j.refId === "0001");
    const out = await submitResults(env, {
      results: [{ jobId: job.jobId, leaseId: job.leaseId, ok: true, kind: "caption", result: { caption: "still worth keeping" } }],
      now: NOW,
    });
    eq("the caption is still written", env.REFS_KV._get("ref:0001").caption, "still worth keeping");
    eq("and counted", out.applied, 1);
    eq("with no index to update and no error about it", out.errors.length, 0);
  }

  // ------------------------------------------------------------- the status
  {
    const env = makeEnv();
    const out = await localStatus(env, { now: NOW });
    eq("two images are waiting", out.waiting.caption, 2);
    eq("and one transcript", out.waiting.summarize, 1);
    eq("nothing is leased yet", out.leased, 0);
    // The field that stops `waiting` being read as a finish line.
    eq("and the walk says whether it saw everything", out.complete, true);

    await leaseJobs(env, { limit: 1, origin: ORIGIN, now: NOW });
    const after = await localStatus(env, { now: NOW });
    eq("a leased job shows as leased", after.leased, 1);
  }

  // ---------------------------------------------------------- the cursor
  {
    const env = makeEnv();
    await leaseJobs(env, { limit: 8, origin: ORIGIN, now: NOW });
    const stored = env.REFS_KV._get(CURSOR_KEY);
    ok("the walk records where it got to", stored && "cursor" in stored);
    // A completed lap resets, so the next one starts at the newest refs again.
    eq("a finished lap starts over", stored.cursor, null);
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
