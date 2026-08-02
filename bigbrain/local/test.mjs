// Tests for the Tier 1 local runner. Plain Node, no deps, no network, no Ollama.
// Run: node test.mjs
//
// What's worth testing here is not the happy path — it's the four ways this
// thing meets the real world at 3am: the laptop closes, the wifi drops, Ollama
// isn't running, and one image in a batch of eight is a dead Instagram CDN
// link. Each of those has a specific promise attached, and each promise is
// asserted below by counting jobs in and jobs out.
import { createRunner, JOB_KINDS } from "./runner.mjs";
import { probe, createOllama, hasModel, fixFor, UNAVAILABLE, TIMEOUT } from "./ollama.mjs";

let pass = 0, fail = 0;
function ok(label, cond) { cond ? pass++ : (fail++, console.error("✗ " + label)); }
function eq(label, got, want) { ok(label + ` (got ${JSON.stringify(got)})`, got === want); }

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});
const bytesRes = (buf, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  arrayBuffer: async () => buf,
});

// ---- a stubbed worker: holds a pool, leases from it, records what comes back ----
function makeWorker({ jobs = [], honorLease = true } = {}) {
  const pool = [...jobs];
  const w = {
    leases: new Map(),          // jobId -> leaseId currently valid
    submissions: [],            // every submit body, in order
    applied: [], recorded: [], released: [], stale: [],
    leaseCalls: 0,
    pool,
  };

  w.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};

    if (String(url).endsWith("/api/local/lease")) {
      w.leaseCalls++;
      const take = pool.splice(0, body.limit ?? 8).map((j, i) => {
        const leaseId = `lease-${j.jobId}-${w.leaseCalls}-${i}`;
        w.leases.set(j.jobId, leaseId);
        return {
          leaseId,
          leaseExpiresAt: j.leaseExpiresAt || new Date(Date.now() + (body.leaseSeconds || 900) * 1000).toISOString(),
          ...j,
        };
      });
      return jsonRes({ ok: true, jobs: take, available: pool.length, error: null });
    }

    if (String(url).endsWith("/api/local/submit")) {
      w.submissions.push(body);
      for (const r of body.results || []) {
        // A lease the worker no longer honors is reported, never applied — this
        // is what protects a ref from a result computed against a stale lease.
        if (honorLease && w.leases.get(r.jobId) !== r.leaseId) { w.stale.push({ jobId: r.jobId, why: "lease expired" }); continue; }
        w.leases.delete(r.jobId);
        (r.ok ? w.applied : w.recorded).push(r);
      }
      for (const r of body.release || []) {
        if (honorLease && w.leases.get(r.jobId) !== r.leaseId) { w.stale.push({ jobId: r.jobId, why: "lease expired" }); continue; }
        w.leases.delete(r.jobId);
        w.released.push(r);
        pool.push({ jobId: r.jobId, kind: "caption", refId: r.jobId, payload: { imageUrl: "http://img/x.jpg" } });
      }
      return jsonRes({
        ok: true,
        applied: w.applied.length, recorded: w.recorded.length, released: w.released.length,
        stale: w.stale, errors: [], error: null,
      });
    }

    // anything else is an image fetch
    return bytesRes(Buffer.from("fake-jpeg-bytes"));
  };
  return w;
}

/** An Ollama stand-in with the same result shape as the real client. */
function makeOllama(plan = {}) {
  const {
    caption = () => ({ text: "a rig of black curtains on a steel frame", model: "llava:latest" }),
    summarize = () => ({ text: "He builds the effect in camera.", model: "llama3.1:latest" }),
    probeResult = { ok: true, running: true, host: "http://127.0.0.1:11434", installed: ["llava:latest", "llama3.1:latest"], missing: [], fixes: [], error: "" },
  } = plan;
  const calls = { caption: 0, summarize: 0, probe: 0 };
  return {
    calls,
    probe: async () => (calls.probe++, probeResult),
    caption: async (...a) => {
      calls.caption++;
      return { text: "", error: "", kind: "", fix: null, model: "llava:latest", ms: 1, ...caption(calls.caption, ...a) };
    },
    summarize: async (...a) => {
      calls.summarize++;
      return { text: "", error: "", kind: "", fix: null, model: "llama3.1:latest", ms: 1, ...summarize(calls.summarize, ...a) };
    },
  };
}

const quiet = () => {};
const base = (w, ollama, extra = {}) => createRunner({
  url: "https://worker.test", token: "tok", fetchImpl: w.fetch, ollama,
  log: quiet, sleep: async () => {}, ...extra,
});

const captionJob = (n) => ({ jobId: `j${n}`, kind: "caption", refId: `ref${n}`, level: 3, payload: { imageUrl: `http://img/${n}.jpg`, title: "curtain rig" } });
const summarizeJob = (n) => ({ jobId: `j${n}`, kind: "summarize", refId: `ref${n}`, level: 4, payload: { text: "a long transcript ".repeat(40), title: "how it was built" } });

// --------------------------------------------------------- 1. lease/submit round trip
{
  const w = makeWorker({ jobs: [captionJob(1), summarizeJob(2)] });
  const o = makeOllama();
  const r = base(w, o);
  const out = await r.runBatch();

  eq("round trip: leased both", out.leased, 2);
  eq("round trip: both succeeded", out.ok, 2);
  eq("round trip: none failed", out.failed, 0);
  eq("round trip: none released", out.released, 0);
  eq("round trip: one submit call", w.submissions.length, 1);
  eq("round trip: worker applied both", w.applied.length, 2);

  const cap = w.applied.find((x) => x.kind === "caption");
  const sum = w.applied.find((x) => x.kind === "summarize");
  eq("round trip: caption text came back", cap.result.caption, "a rig of black curtains on a steel frame");
  eq("round trip: summary text came back", sum.result.summary, "He builds the effect in camera.");
  ok("round trip: results carry the leaseId they were issued", cap.leaseId === w.leases.get("j1") || cap.leaseId.startsWith("lease-j1"));
  eq("round trip: nothing left in flight", r.inFlight.size, 0);
  eq("round trip: model is reported", cap.model, "llava:latest");
}

// ------------------------------------------- 2a. a dropped batch is released, not failed
{
  // Ollama quits after the first job. The remaining four must go back to the
  // pool untouched — marking them failed would spend four refs' retry budget on
  // a laptop that went to sleep.
  const w = makeWorker({ jobs: [1, 2, 3, 4, 5].map(captionJob) });
  const o = makeOllama({
    caption: (n) => (n === 1
      ? { text: "fine", model: "llava:latest" }
      : { error: "connection refused", kind: UNAVAILABLE, fix: { fix: "ollama serve" } }),
  });
  const r = base(w, o);
  const out = await r.runBatch();

  eq("dropped: one succeeded", out.ok, 1);
  eq("dropped: nothing was marked failed", out.failed, 0);
  eq("dropped: four released", out.released, 4);
  eq("dropped: every leased job accounted for", out.ok + out.failed + out.released, 5);
  eq("dropped: nothing stranded in flight", r.inFlight.size, 0);

  const sub = w.submissions[0];
  eq("dropped: successes still submitted", sub.results.length, 1);
  eq("dropped: releases submitted in the same call", sub.release.length, 4);
  ok("dropped: releases say why", sub.release.every((x) => typeof x.reason === "string" && x.reason.length > 0));
  eq("dropped: worker recorded no failed attempts", w.recorded.length, 0);
  eq("dropped: jobs are back in the pool", w.pool.length, 4);
  ok("dropped: the model was not called after it went away", o.calls.caption <= 4);
}

// ------------------------------- 2b. closed mid-batch: in-flight leases are handed back
{
  const w = makeWorker({ jobs: [] });
  const r = base(w, makeOllama());
  // Exactly the state the process is in when the laptop closes: jobs leased,
  // work half-done, no chance to finish.
  r.inFlight.set("j7", { jobId: "j7", leaseId: "lease-j7", kind: "caption" });
  r.inFlight.set("j8", { jobId: "j8", leaseId: "lease-j8", kind: "caption" });
  w.leases.set("j7", "lease-j7");
  w.leases.set("j8", "lease-j8");

  const out = await r.stop("closed the laptop");
  eq("shutdown: released both", out.released, 2);
  eq("shutdown: no error", out.error, "");
  eq("shutdown: in flight cleared", r.inFlight.size, 0);
  eq("shutdown: worker saw the release", w.released.length, 2);
  eq("shutdown: submitted no results", w.submissions[0].results.length, 0);
  eq("shutdown: runner is stopping", r.stopping, true);

  const after = await r.runBatch();
  eq("shutdown: a stopped runner does not lease more work", w.leaseCalls, 0);
  eq("shutdown: runBatch reports it stopped", after.leased, 0);
}

// --------------------------------------- 3. unreachable Ollama prints the fix, not a trace
{
  const refused = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); };
  const p = await probe({ models: ["llava", "llama3.1"], fetchImpl: refused });

  eq("ollama down: not ok", p.ok, false);
  eq("ollama down: not running", p.running, false);
  eq("ollama down: exactly one fix", p.fixes.length, 1);
  eq("ollama down: the fix is the command", p.fixes[0].fix, "ollama serve");
  eq("ollama down: install fallback offered", p.fixes[0].alt, "brew install ollama");

  // The whole promise of this module: what he reads is a command, not a trace.
  const lines = [];
  const r = base(makeWorker(), makeOllama(), { log: (s) => lines.push(String(s)) });
  r.reportProbe(p);
  const printed = lines.join("\n");
  ok("ollama down: prints the command", printed.includes("ollama serve"));
  ok("ollama down: prints no stack frames", !/\n\s+at\s/.test(printed));
  ok("ollama down: prints no raw Error class", !printed.includes("TypeError"));

  // Running, but the model was never pulled — the other half of the promise.
  const noModel = async () => jsonRes({ models: [{ name: "llama3.1:latest" }] });
  const p2 = await probe({ models: ["llava", "llama3.1"], fetchImpl: noModel });
  eq("model missing: running", p2.running, true);
  eq("model missing: not ok", p2.ok, false);
  eq("model missing: names the model", p2.missing.join(","), "llava");
  eq("model missing: the fix is the pull", p2.fixes[0].fix, "ollama pull llava");

  const p3 = await probe({ models: ["llava"], fetchImpl: async () => jsonRes({ models: [{ name: "llava:latest" }] }) });
  eq("model tags: llava:latest satisfies llava", p3.ok, true);
  eq("hasModel: untagged request matches any tag", hasModel(["llava:latest"], "llava"), true);
  eq("hasModel: tagged request must match exactly", hasModel(["llava:latest"], "llava:13b"), false);
  eq("fixFor: unknown kind offers nothing", fixFor("who-knows").fix, "");

  // A 404 mid-run is the model, and it is the runner's problem, not the ref's.
  const client = createOllama({ fetchImpl: async () => jsonRes({ error: "model 'llava' not found, try pulling it first" }, 404) });
  const cap = await client.caption("Zm9v");
  eq("generate 404: classified unavailable", cap.kind, UNAVAILABLE);
  eq("generate 404: carries the pull command", cap.fix.fix, "ollama pull llava");
  eq("generate 404: no text", cap.text, "");

  // An empty answer from a live server IS the job's failure, and must not be
  // confused with the server being gone.
  const empty = createOllama({ fetchImpl: async () => jsonRes({ response: "   " }) });
  const cap2 = await empty.caption("Zm9v");
  ok("generate empty: reported as failed, not unavailable", cap2.kind !== UNAVAILABLE && cap2.error.length > 0);
}

// -------------------------------------- 4. partial failure still submits the successes
{
  // Job 2's image is a dead Instagram CDN link. That is a fact about the ref,
  // so it is reported as a failure — and jobs 1 and 3 still land.
  const w = makeWorker({ jobs: [captionJob(1), captionJob(2), summarizeJob(3)] });
  const realFetch = w.fetch;
  w.fetch = async (url, init) => {
    if (String(url) === "http://img/2.jpg") return bytesRes(Buffer.alloc(0), 404);
    return realFetch(url, init);
  };
  const r = base(w, makeOllama());
  const out = await r.runBatch();

  eq("partial: two succeeded", out.ok, 2);
  eq("partial: one failed", out.failed, 1);
  eq("partial: none released", out.released, 0);
  eq("partial: all three accounted for", out.ok + out.failed + out.released, 3);
  eq("partial: worker applied the successes", w.applied.length, 2);
  eq("partial: worker recorded the failure", w.recorded.length, 1);
  eq("partial: the failure says what happened", w.recorded[0].error, "image fetch 404");
  eq("partial: a 404 image is permanent", w.recorded[0].permanent, true);
  ok("partial: the failure carries no result payload", w.recorded[0].result === undefined);

  // A 503 is the opposite call: the host is having a bad minute, try later.
  const w2 = makeWorker({ jobs: [captionJob(1)] });
  const rf2 = w2.fetch;
  w2.fetch = async (url, init) => (String(url) === "http://img/1.jpg" ? bytesRes(Buffer.alloc(0), 503) : rf2(url, init));
  await base(w2, makeOllama()).runBatch();
  eq("partial: a 503 image is transient", w2.recorded[0].permanent, false);

  // A model timeout is attributable to the job, so it is reported, not released.
  const w3 = makeWorker({ jobs: [captionJob(1)] });
  const out3 = await base(w3, makeOllama({ caption: () => ({ error: "timed out after 180000ms", kind: TIMEOUT }) })).runBatch();
  eq("partial: a model timeout is reported", out3.failed, 1);
  eq("partial: a model timeout is not released", out3.released, 0);
  eq("partial: a timeout is not permanent", w3.recorded[0].permanent, false);
}

// ----------------------------------- 5. an unreachable worker is never an empty queue
{
  // The rule this codebase learned the hard way: a failed call and an honest
  // "nothing to do" must not look the same.
  const dead = { fetch: async () => { throw new Error("ENOTFOUND worker.test"); } };
  const r = base(dead, makeOllama());
  const out = await r.runBatch();
  ok("offline: reports an error", out.error.includes("ENOTFOUND"));
  eq("offline: does NOT report an idle queue", out.idle, false);
  eq("offline: leased nothing", out.leased, 0);

  const idle = makeWorker({ jobs: [] });
  const out2 = await base(idle, makeOllama()).runBatch();
  eq("idle: reports idle", out2.idle, true);
  eq("idle: reports no error", out2.error, "");

  // Missing config is caught before any request goes out.
  const noToken = createRunner({ url: "https://worker.test", token: "", fetchImpl: dead.fetch, ollama: makeOllama(), log: quiet, sleep: async () => {} });
  const out3 = await noToken.lease();
  ok("config: a missing token is named, not thrown", out3.error.includes("BIGBRAIN_TOKEN"));
}

// ------------------------------------------------- 6. expired leases and lost submissions
{
  // The Mac slept through the lease. Doing the work would waste GPU time on a
  // result the worker is right to refuse, so hand it straight back.
  const stale = { ...captionJob(1), leaseExpiresAt: new Date(Date.now() - 60_000).toISOString() };
  const w = makeWorker({ jobs: [stale] });
  const o = makeOllama();
  const out = await base(w, o).runBatch();
  eq("expired: released without working it", out.released, 1);
  eq("expired: the model was never called", o.calls.caption, 0);
  eq("expired: nothing submitted as a result", w.submissions[0].results.length, 0);

  // Wifi dies between doing the work and reporting it. The results are lost;
  // the jobs are not, and the message has to say exactly that.
  let calls = 0;
  const flaky = async (url, init) => {
    if (String(url).endsWith("/api/local/submit")) throw new Error("network is unreachable");
    if (String(url).endsWith("/api/local/lease")) {
      calls++;
      return jsonRes({ ok: true, jobs: [{ ...captionJob(1), leaseId: "L1", leaseExpiresAt: new Date(Date.now() + 9e5).toISOString() }], available: 0 });
    }
    return bytesRes(Buffer.from("bytes"));
  };
  const r2 = createRunner({ url: "https://worker.test", token: "t", fetchImpl: flaky, ollama: makeOllama(), log: quiet, sleep: async () => {}, submitAttempts: 2 });
  const out2 = await r2.runBatch();
  ok("lost submit: reports the loss", out2.error.includes("network is unreachable"));
  ok("lost submit: says the work is recoverable", /re-lease/.test(out2.error));
  eq("lost submit: does not strand the job locally", r2.inFlight.size, 0);
}

// ------------------------------------------------------- 7. an unknown job kind is refused
{
  // A newer worker handing out a kind this runner predates must not have that
  // work marked broken. Release it and let a newer runner take it.
  const w = makeWorker({ jobs: [{ jobId: "jx", kind: "transcribe-audio", refId: "refx", payload: {} }] });
  const out = await base(w, makeOllama()).runBatch();
  eq("unknown kind: released", out.released, 1);
  eq("unknown kind: not failed", out.failed, 0);
  ok("unknown kind: the reason names it", w.submissions[0].release[0].reason.includes("transcribe-audio"));
  eq("unknown kind: the runner declares what it knows", JOB_KINDS.join(","), "caption,summarize");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
