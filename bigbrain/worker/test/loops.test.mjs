// Do the three loops actually LEARN, or only look like it?
//
// The other test files check each loop in isolation and on a single night.
// This one runs them across SUCCESSIVE nights, because every claim the project
// makes is a claim about night N+1:
//
//   loop 1  a rung that failed permanently is never paid for again
//   loop 2  a generator he keeps rejecting stops asking — including from the
//           ladder, which is the other thing that fills his queue
//   loop 3  a finding it acted on last night is GONE tonight
//
// A loop that does the same thing every night is a cron job with a nicer name,
// so each block below is written as a convergence check: run it N times and
// assert the numbers move in one direction.
//
// Map-backed KV, no network, no models. Run: node test/loops.test.mjs
import {
  climb,
  nextStep,
  levelOf,
  selectCohort,
} from "../src/ladder.js";
import {
  stalenessOf,
  actionFor,
  jobsFor,
  rankJobs,
  fitBudget,
} from "../src/selfgaps.js";
import {
  shouldSuppress,
  summarize,
  probeRoll as learnProbeRoll,
  SUPPRESS_MIN_SAMPLE,
} from "../src/learn.js";
import { probeRoll as cronProbeRoll } from "../src/cron.js";
import { list as queueList } from "../src/stage.js";
import { ledger, dayStamp } from "../src/budget.js";

let pass = 0, fail = 0;
function ok(label, cond) { cond ? pass++ : (fail++, console.error("✗ " + label)); }
function eq(label, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}

// ---- KV --------------------------------------------------------------------
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
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: complete,
        cursor: complete ? undefined : slice[slice.length - 1],
      };
    },
    _seed: (name, value) => store.set(name, JSON.stringify(value)),
  };
}

// The page every re-read gets. Long enough to clear rung 2's 200-char floor.
const PAGE_HTML =
  "<html><head><title>Chrome harness rig</title></head><body><p>" +
  "A tubular chrome harness welded from 12mm bar and polished to a mirror finish. " +
  "The rig carries three latex panels on swivel arms so the whole thing reads as a " +
  "body without ever showing one. Built in a week for a retail install in Vancouver " +
  "and rented out four times since, which is more than most of the rigs on this shelf." +
  "</p></body></html>";

/** Counts what the world was actually asked for, so "it re-fetched" is provable. */
function makeFetch({ imageStatus = 200 } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: (init.method || "GET").toUpperCase() });
    if (/\.(jpg|png)$/.test(u)) {
      if (imageStatus !== 200) return new Response("", { status: imageStatus });
      return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } });
    }
    return new Response(PAGE_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };
  fn.calls = calls;
  return fn;
}

const NOW = new Date("2026-08-02T00:00:00Z");
const LONG_AGO = "2024-01-01T00:00:00.000Z";
const day = (n) => new Date(NOW.getTime() + n * 86_400_000);

const run = async () => {
  const realFetch = globalThis.fetch;

  // =========================================================================
  // LOOP 1 — does a permanent failure stay paid for once?
  // =========================================================================
  //
  // The ladder's whole cost argument is that a host which 403s a bot today
  // 403s it tomorrow, so rung 3 closes and the vision ration is never spent
  // rediscovering it. That argument is only worth anything if NOTHING ELSE in
  // the nightly can re-open the rung.
  {
    globalThis.fetch = makeFetch({ imageStatus: 403 });
    const kv = makeKV();
    const blocked = {
      id: "ig1", kind: "url", category: "image",
      url: "https://www.instagram.com/p/ABC/", host: "instagram.com",
      image: "https://cdn.instagram.com/abc.jpg", imageTried: true,
      title: "Instagram", createdAt: LONG_AGO, linkCheckedAt: LONG_AGO,
      classified: { realm: "INSPO" },
      ladder: { steps: { 3: { attempts: 1, ok: false, permanent: true, reason: "blocked (403)" } } },
    };
    kv._seed("ref:ig1", blocked);
    const env = { REFS_KV: kv, AI: { async run() { return { description: "" }; } } };

    eq("a permanently blocked rung is not offered", nextStep(blocked, { now: NOW })?.level ?? null, 5);

    // Loop 3 calls this ref stale and asks for a recheck. A recheck is a
    // re-read of the SOURCE PAGE — it is not permission to re-open every other
    // rung on the ref, and rung 3 is the one that costs the vision ration.
    const step = nextStep(blocked, { now: NOW, redo: 2 });
    eq("a recheck targets rung 2, not the blocked paid rung", step?.level ?? null, 2);

    let visionSpent = 0;
    for (let night = 0; night < 4; night++) {
      const cur = await kv.get("ref:ig1", "json");
      await climb(env, cur, { now: day(night), redo: 2 });
      visionSpent = (await ledger(env)).vision;
    }
    eq("four nights of rechecks spend no vision on a known-dead rung", visionSpent, 0);
  }

  // =========================================================================
  // LOOP 3 — does tonight's plan differ from last night's?
  // =========================================================================
  //
  // The stale detector reports a ref whose page we last read over 180 days
  // ago, and hands the nightly a `recheck`. If the recheck does not refresh
  // the stamp the detector reads, the SAME finding is produced every single
  // lap of the archive, for ever, and loop 3 is a fixed script.
  {
    globalThis.fetch = makeFetch();
    const kv = makeKV();
    const old = {
      id: "old1", kind: "url", category: "link",
      url: "https://example.com/one", host: "example.com",
      title: "An article we read a year ago",
      body: "x".repeat(900), enrichTried: LONG_AGO, image: "https://cdn.example.com/a.jpg",
      imageTried: true, createdAt: LONG_AGO, classified: { realm: "KNOWLEDGE" },
      ladder: { steps: { 5: { attempts: 1, ok: true } } },
    };
    kv._seed("ref:old1", old);
    const env = { REFS_KV: kv };

    const before = stalenessOf(old, { now: NOW });
    ok("a year-old read is stale", before.stale && !before.never);
    eq("...and loop 3 wants a recheck", actionFor({ kind: "stale", detail: { signal: "aged out" } }), "recheck");

    // Night one: run the job loop 3 asked for.
    const res = await climb(env, await kv.get("ref:old1", "json"), { now: NOW, redo: 2 });
    ok("the recheck actually attempts the surface rung", res.step?.level === 2);

    // Night two: the same detector, on the ref as it now stands.
    const after = stalenessOf(await kv.get("ref:old1", "json"), { now: NOW });
    eq("after a recheck the ref is no longer stale", after.stale, false);
  }

  // A ref jobVision fetched the bytes for LAST NIGHT is not a ref whose source
  // we last touched in 2024. `captionTried` is already trusted as proof we
  // tried; it has to count as proof of WHEN, or the ref is permanently stale
  // and loop 3 re-queues it every lap of the archive.
  {
    const captioned = {
      id: "img1", category: "image", url: "https://www.instagram.com/p/Q/",
      image: "https://cdn.instagram.com/q.jpg", title: "Instagram",
      createdAt: LONG_AGO, captionTried: "2026-08-01T11:10:00.000Z",
    };
    const s = stalenessOf(captioned, { now: NOW });
    eq("a ref whose bytes we fetched last night is not stale", s.stale, false);
    ok("...and its age is measured in days, not years", (s.ageDays ?? 999) < 2);
  }

  // =========================================================================
  // LOOP 2 — does suppression cover everything that asks him a question?
  // =========================================================================
  //
  // "He should have to swipe LESS each week." Loop 2 decides a generator has
  // earned silence. That decision is worth nothing if the ladder, which runs
  // on 25 refs every night, keeps queueing the same kind of card anyway.
  {
    const rejectedFlat = summarize({
      v: 1,
      totals: { approved: 0, rejected: 40 },
      kind: { realm: { approved: 0, rejected: 20 }, tag: { approved: 0, rejected: 20 } },
      source: {}, axis: {}, realm: {}, moves: {},
    });

    const verdict = shouldSuppress(rejectedFlat, "realm", { roll: 0.9 });
    ok("20 straight rejections suppresses the realm generator", verdict.suppress);
    const suppressed = new Set(["realm", "tag"]);

    globalThis.fetch = makeFetch();
    const kv = makeKV();
    // A bare Instagram row: classify() cannot settle it, so rung 1 wants to ask.
    const bare = {
      id: "z1", kind: "url", category: "link",
      url: "https://www.instagram.com/p/ZZZ/", host: "instagram.com",
      title: "Instagram", createdAt: LONG_AGO, tags: [],
    };
    kv._seed("ref:z1", bare);
    const env = { REFS_KV: kv };

    const res = await climb(env, bare, { now: NOW, suppressed });
    const q = await queueList(env, { status: "pending", limit: 50 });
    eq("a suppressed kind puts nothing in the queue", q.items.length, 0);
    ok("...and the ladder says why rather than pretending it climbed",
      res.step === null || res.step.level !== 1);

    // And it must not be a permanent loss: lift the suppression and the ref is
    // still there to be asked about. A suppressed rung records NO attempt, so
    // nothing has been spent and nothing has been closed.
    const stillThere = await kv.get("ref:z1", "json");
    eq("suppression records no attempt against the rung", stillThere.ladder?.steps?.["1"] ?? null, null);
    const res2 = await climb(env, stillThere, { now: NOW });
    eq("...so lifting it asks the question after all", res2.step?.level ?? null, 1);
    const q2 = await queueList(env, { status: "pending", limit: 50 });
    eq("...and the card arrives", q2.items.length, 1);
  }

  // Suppressing a kind must silence the QUESTION, not the ref.
  //
  // This started out asserting the opposite — that a ref whose realm card is
  // suppressed drops out of the cohort entirely — and the code was right to
  // disagree. A bare Instagram row at level 0 still has a free rung waiting: the
  // thumbnail and page text, which ask him nothing. Skipping the ref to avoid a
  // question he has stopped answering would cost him a night of unpaid work he
  // never objected to, on every ref of that shape, forever.
  //
  // So the contract is narrower than it first looked: a suppressed rung is
  // stepped over, and the ref is still picked if anything else is available.
  // The genuine "only step is suppressed" case is exercised below, where it does
  // drop out.
  {
    globalThis.fetch = makeFetch();
    const kv = makeKV();
    for (let i = 0; i < 4; i++) {
      kv._seed(`ref:s${i}`, {
        id: `s${i}`, kind: "url", category: "link",
        url: `https://www.instagram.com/p/S${i}/`, host: "instagram.com",
        title: "Instagram", createdAt: LONG_AGO, tags: [],
      });
    }
    const env = { REFS_KV: kv };
    const suppressed = new Set(["realm"]);

    const cohort = await selectCohort(env, { limit: 10, now: NOW, suppressed });
    eq("a suppressed ask does not cost the ref its free work", cohort.items.length, 4);
    eq("...without reporting a broken walk", cohort.error, null);

    // And what it was picked FOR is the free rung, not the muted one.
    for (const entry of cohort.items) {
      const ref = entry.ref ?? entry;
      const step = nextStep(ref, { now: NOW, suppressed });
      ok("...and the step chosen asks him nothing", Boolean(step) && !step.proposes);
    }
  }

  // Rung 5 is different: nothing comes out of it but the question, and triage
  // never runs tags — so marking it done while suppressed would retire that
  // ref's only route to the queue for good. It has to WAIT instead.
  {
    globalThis.fetch = makeFetch();
    const kv = makeKV();
    const taggable = {
      id: "t1", kind: "url", category: "link",
      url: "https://example.com/rig", host: "example.com",
      title: "Kinetic lighting rig for a projection set",
      body: "y".repeat(900), enrichTried: "2026-08-01T00:00:00.000Z",
      image: "https://cdn.example.com/r.jpg", imageTried: true,
      createdAt: LONG_AGO, classified: { realm: "INSPO" }, tags: [],
    };
    kv._seed("ref:t1", taggable);
    const env = { REFS_KV: kv };
    const suppressed = new Set(["tag"]);

    eq("the tag rung is this ref's only remaining step", nextStep(taggable, { now: NOW })?.level ?? null, 5);
    eq("...and suppression takes it off the table", nextStep(taggable, { now: NOW, suppressed })?.level ?? null, null);

    const res = await climb(env, taggable, { now: NOW, suppressed });
    ok("a suppressed ask-only rung is not attempted", res.step === null);
    const stored = await kv.get("ref:t1", "json");
    eq("...so no attempt is recorded against it", stored.ladder?.steps?.["5"] ?? null, null);

    // The probe night comes round and the question is still there to ask.
    const res2 = await climb(env, taggable, { now: NOW });
    eq("lifting suppression asks it after all", res2.step?.level ?? null, 5);

    // And the cohort must not spend its 25 slots discovering it isn't allowed
    // to ask — that is how a suppressed generator quietly stalls loop 1.
    const cohort = await selectCohort(env, { limit: 10, now: NOW, suppressed });
    eq("the cohort skips refs whose only step is suppressed", cohort.items.length, 0);
    eq("...without reporting a broken walk", cohort.error, null);
  }

  // Tiny samples are not evidence, and suppression is recoverable. Both are
  // already covered in learn.test.mjs; what is NOT covered is that the nightly
  // and the explain endpoint agree about which nights the probe runs. A
  // suppressed generator that the record says probed on Tuesday, and the
  // /api/learn/score card says was silent on Tuesday, is a debugging trap.
  {
    const flat = summarize({
      v: 1, totals: { approved: 0, rejected: 20 },
      kind: { realm: { approved: 0, rejected: 20 } },
      source: {}, axis: {}, realm: {}, moves: {},
    });
    eq(`${SUPPRESS_MIN_SAMPLE - 1} decisions is still not enough`,
      shouldSuppress(
        summarize({ v: 1, totals: {}, kind: { realm: { approved: 0, rejected: SUPPRESS_MIN_SAMPLE - 1 } }, source: {}, axis: {}, realm: {}, moves: {} }),
        "realm", { roll: 0.9 }
      ).suppress, false);

    let disagreements = 0;
    let probeNights = 0;
    for (let d = 1; d <= 28; d++) {
      const stamp = `2026-08-${String(d).padStart(2, "0")}`;
      for (const kind of ["dead-link", "realm", "tag"]) {
        const fromCron = shouldSuppress(flat, kind, { roll: cronProbeRoll(stamp, kind) });
        const fromLearn = shouldSuppress(flat, kind, { day: stamp });
        if (fromCron.probe !== fromLearn.probe) disagreements++;
      }
      if (shouldSuppress(flat, "realm", { day: stamp }).probe) probeNights++;
    }
    eq("the nightly and the explain endpoint roll the same probe", disagreements, 0);
    ok("a suppressed generator still gets its door open some nights", probeNights > 0);
    ok("...but not most of them", probeNights < 14);
  }

  // =========================================================================
  // LOOP 3 — the plan has to be executable to be a plan
  // =========================================================================
  //
  // Free jobs outrank paid ones by design (impact-per-dollar with a 1e-6
  // floor). `stage` is free and nothing in the nightly can execute it, so a
  // night with a normal crop of duplicates and contradictions fills all twelve
  // job slots with work that will be reported as unhandled — and the paid
  // enrichment loop 3 actually exists to direct gets deferred.
  {
    const gaps = [];
    for (let i = 0; i < 8; i++) {
      gaps.push({ id: `url:${i}`, kind: "duplicate", refIds: [`d${i}a`, `d${i}b`], count: 2, impact: 1, perRef: 0.5, detail: { signal: "same url" }, line: "same url twice" });
    }
    for (let i = 0; i < 6; i++) {
      gaps.push({ id: `realm:${i}`, kind: "contradiction", refIds: [`c${i}`], count: 1, impact: 2, perRef: 2, detail: {}, line: "filed elsewhere" });
    }
    gaps.push({ id: "region", kind: "thin", refIds: Array.from({ length: 20 }, (_, i) => `t${i}`), count: 20, impact: 54, perRef: 2.7, detail: { captionable: 18, readable: 2 }, line: "a thin region" });
    gaps.push({ id: "r", kind: "unanswerable", refIds: Array.from({ length: 10 }, (_, i) => `u${i}`), count: 10, impact: 36, perRef: 3.6, detail: { contentGap: true }, line: "a weak question" });

    const fitted = fitBudget(rankJobs(jobsFor(gaps)), { budget: 5, visionLeft: 20 });
    const executable = fitted.jobs.filter((j) => j.action !== "stage").length;
    ok(`the night's plan is mostly work the night can do (${executable}/${fitted.jobs.length})`,
      executable >= fitted.jobs.length / 2);
    ok("the paid enrichment is not deferred behind cards nobody can queue",
      !fitted.deferred.some((j) => j.action === "caption" || j.action === "enrich"));
    ok("and the findings nobody can act on are still reported, with a reason",
      fitted.deferred.length === 14 && fitted.deferred.every((j) => j.deferredWhy.length > 0));

    // A caller that knows exactly what tonight can execute may narrow it
    // further, and gets the same answer here — `stage` was never runnable.
    const can = new Set(["enrich", "caption", "recheck", "reindex"]);
    const narrowed = fitBudget(rankJobs(jobsFor(gaps)), { budget: 5, visionLeft: 20, can });
    eq("a stated capability set says the same thing", narrowed.jobs.length, fitted.jobs.length);
  }

  globalThis.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
};

run().catch((err) => { console.error(err); process.exit(1); });
