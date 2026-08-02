#!/usr/bin/env node
/**
 * The Tier 1 runner — his Mac, doing the bulk model work the budget can't buy.
 *
 * The worker knows which refs need captioning and which transcripts need
 * summarising; it just can't afford to do a thousand of them. This process asks
 * for a batch, does it locally with Ollama, and hands the answers back. That's
 * the whole shape.
 *
 * THE WORKER IS THE SOURCE OF TRUTH, ALWAYS. This process holds no state of its
 * own beyond the batch currently in its hands — no queue file, no cursor, no
 * "already done" list. Delete it mid-run and nothing is lost but the seconds of
 * GPU time already spent. That is what makes it safe to close the laptop, and
 * it is the reason there is no local database here even though one would be a
 * natural thing to write.
 *
 * WHICH MEANS LEASES, NOT CLAIMS. A leased job is one the worker has handed out
 * with a deadline. If this process dies, sleeps, or loses wifi, the deadline
 * passes and the job goes back in the pool by itself. Nothing has to notice the
 * crash. A "claim" with no deadline would mean every hard shutdown permanently
 * strands whatever was in flight, and the archive would silently develop holes.
 *
 * THE ONE DISTINCTION EVERYTHING HANGS ON — released vs reported:
 *
 *   RELEASED  we could not attempt it. Ollama quit, the batch was aborted, we
 *             are shutting down. The job is untouched and goes straight back to
 *             the pool with no attempt recorded. Charging a ref a retry for our
 *             laptop being closed would burn its four attempts in four nights
 *             and mark a perfectly good ref permanently failed.
 *
 *   REPORTED  we did attempt it and it did not work. The image 404s, the model
 *             returned nothing. That is a fact about the ref, so it is
 *             submitted as a failure and the worker's backoff owns it from
 *             there.
 *
 * Every leased job ends up in exactly one of those two buckets before the batch
 * closes. Not one is dropped on the floor, and the tests assert the arithmetic.
 *
 * Usage:  npm start        (see README.md)
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOllama, UNAVAILABLE, TIMEOUT } from "./ollama.mjs";

/** The kinds the worker may hand out. Anything else is refused and released. */
export const JOB_KINDS = ["caption", "summarize"];

const DEFAULT_BATCH = 8;
const DEFAULT_LEASE_SECONDS = 900;
const DEFAULT_IDLE_SECONDS = 60;

/** Worker round trips are small JSON; anything slower than this is a problem. */
const API_TIMEOUT_MS = 30_000;
const IMAGE_TIMEOUT_MS = 20_000;

/** Bigger than this and llava will spend minutes on one image. Not worth it. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * Consecutive environment failures before we stop trying and go back to
 * probing. Without this, Ollama quitting halfway through a batch means every
 * remaining job round-trips to a dead socket, and worse, an overnight run wakes
 * to a closed laptop and hammers a dead port until morning.
 */
const TROUBLE_LIMIT = 3;

/** The work is already done and paid for in GPU time — don't lose it cheaply. */
const SUBMIT_ATTEMPTS = 3;

/** Worker unreachable: back off, but keep checking. Wifi comes back. */
const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

/** HTTP statuses that mean "this image will never load", not "try later". */
const DEAD_IMAGE_STATUSES = new Set([400, 401, 403, 404, 405, 410, 451]);

const short = (err) => String(err?.message ?? err).slice(0, 240);
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** Read config from the environment, with the defaults that suit an overnight run. */
export function configFromEnv(env = process.env) {
  return {
    url: String(env.BIGBRAIN_URL || "").replace(/\/+$/, ""),
    token: env.BIGBRAIN_TOKEN || "",
    batch: Number(env.BIGBRAIN_BATCH) || DEFAULT_BATCH,
    leaseSeconds: Number(env.BIGBRAIN_LEASE_SECONDS) || DEFAULT_LEASE_SECONDS,
    idleSeconds: Number(env.BIGBRAIN_IDLE_SECONDS) || DEFAULT_IDLE_SECONDS,
    runnerName: env.BIGBRAIN_RUNNER || "mac",
    ollamaHost: env.OLLAMA_HOST || undefined,
    visionModel: env.BIGBRAIN_VISION_MODEL || undefined,
    textModel: env.BIGBRAIN_TEXT_MODEL || undefined,
    once: env.BIGBRAIN_ONCE === "1",
  };
}

/**
 * Build a runner. Everything that touches the outside world is injectable,
 * because the failure paths — Ollama gone, worker unreachable, a batch dropped
 * mid-flight — are the only parts genuinely worth testing, and none of them can
 * be provoked reliably against real services.
 */
export function createRunner(opts = {}) {
  const {
    url = "",
    token = "",
    batch = DEFAULT_BATCH,
    leaseSeconds = DEFAULT_LEASE_SECONDS,
    idleSeconds = DEFAULT_IDLE_SECONDS,
    runnerName = "mac",
    kinds = JOB_KINDS,
    fetchImpl = globalThis.fetch,
    ollama = createOllama({}),
    log = console.log,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    maxImageBytes = MAX_IMAGE_BYTES,
    submitAttempts = SUBMIT_ATTEMPTS,
    troubleLimit = TROUBLE_LIMIT,
  } = opts;

  /** The only mutable state that exists. Empty between batches, by design. */
  const inFlight = new Map();

  let stopping = false;
  let needsProbe = true;
  let troubles = 0;
  const totals = { ok: 0, failed: 0, released: 0, stale: 0, batches: 0 };

  // --------------------------------------------------------------- worker calls

  /**
   * One authenticated POST. Returns `{data, error, status}` — never throws, and
   * never returns an empty success for a failed call. An unreachable worker and
   * an empty pool must not look the same; that mistake is how this codebase has
   * lied to itself before.
   */
  async function api(path, body) {
    if (!url) return { data: null, status: 0, error: "BIGBRAIN_URL is not set" };
    if (!token) return { data: null, status: 0, error: "BIGBRAIN_TOKEN is not set" };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${url}${path}`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", "X-Auth-Token": token },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        return { data: null, status: res.status, error: `worker sent non-JSON: ${text.slice(0, 160)}` };
      }
      if (!res.ok) {
        const hint = res.status === 401 || res.status === 403 ? " — check BIGBRAIN_TOKEN" : "";
        return { data, status: res.status, error: `${data?.error || `HTTP ${res.status}`}${hint}` };
      }
      return { data, status: res.status, error: data?.error || "" };
    } catch (err) {
      const aborted = err?.name === "AbortError";
      return { data: null, status: 0, error: aborted ? `worker timed out after ${API_TIMEOUT_MS}ms` : short(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ask for work. `available` is what's left after this lease, for progress. */
  async function lease({ limit = batch } = {}) {
    const { data, error } = await api("/api/local/lease", {
      runner: runnerName,
      limit,
      kinds,
      leaseSeconds,
    });
    if (error) return { jobs: [], available: null, error };
    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    return { jobs, available: Number.isFinite(data?.available) ? data.available : null, error: "" };
  }

  /**
   * Hand back everything: answers, attributable failures, and untouched jobs,
   * in one call. One call rather than three because a runner that submits
   * successes and then dies before releasing the rest has stranded them for a
   * whole lease period. Atomic from our side is the least we can do.
   */
  async function submit(results, releases) {
    if (!results.length && !releases.length) {
      return { applied: 0, recorded: 0, released: 0, stale: [], error: "" };
    }

    let lastError = "";
    for (let attempt = 1; attempt <= Math.max(1, submitAttempts); attempt++) {
      const { data, error } = await api("/api/local/submit", { runner: runnerName, results, release: releases });
      if (!error) {
        return {
          applied: Number(data?.applied) || 0,
          recorded: Number(data?.recorded) || 0,
          released: Number(data?.released) || 0,
          stale: Array.isArray(data?.stale) ? data.stale : [],
          errors: Array.isArray(data?.errors) ? data.errors : [],
          error: "",
        };
      }
      lastError = error;
      if (attempt < submitAttempts) {
        log(`  submit failed (${error}) — retrying ${attempt}/${submitAttempts - 1}`);
        await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
      }
    }
    // Honest about the consequence: the work is lost, but the JOBS are not —
    // the leases lapse and the worker hands them out again. Saying only "submit
    // failed" would leave him wondering whether the archive is now inconsistent.
    return {
      applied: 0,
      recorded: 0,
      released: 0,
      stale: [],
      error: `${lastError} — ${results.length} finished result(s) lost; the worker will re-lease them when the lease expires`,
    };
  }

  // ------------------------------------------------------------------- the work

  /** Pull the bytes and base64 them. Ollama wants base64, not a URL. */
  async function fetchImage(imageUrl) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
    try {
      const res = await fetchImpl(imageUrl, { signal: ctrl.signal, redirect: "follow" });
      if (!res.ok) {
        return { base64: "", error: `image fetch ${res.status}`, permanent: DEAD_IMAGE_STATUSES.has(res.status) };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return { base64: "", error: "image fetch returned 0 bytes", permanent: true };
      if (buf.length > maxImageBytes) {
        // Permanent on purpose: the file will be exactly this big tomorrow.
        return { base64: "", error: `image is ${(buf.length / 1e6).toFixed(1)}MB, over the ${(maxImageBytes / 1e6).toFixed(0)}MB cap`, permanent: true };
      }
      return { base64: buf.toString("base64"), error: "", permanent: false };
    } catch (err) {
      const aborted = err?.name === "AbortError";
      return { base64: "", error: aborted ? `image fetch timed out after ${IMAGE_TIMEOUT_MS}ms` : short(err), permanent: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Do one job.
   *
   * @returns {Promise<{outcome:"done"|"failed"|"release", result?:object, release?:object, kind?:string}>}
   *   `release` is the runner's fault, `failed` is the job's. See the header.
   */
  async function runJob(job) {
    const started = now();
    const stamp = { jobId: job.jobId, leaseId: job.leaseId };
    const release = (reason) => ({ outcome: "release", release: { ...stamp, reason } });
    const fail = (error, permanent = false, kind = "") => ({
      outcome: "failed",
      kind,
      result: { ...stamp, ok: false, error: String(error).slice(0, 300), permanent, ms: now() - started },
    });

    if (!JOB_KINDS.includes(job.kind)) {
      // A kind we don't understand is not ours to fail. A newer worker handing
      // out a third kind must not have that work marked broken by an old runner.
      return release(`this runner does not know the job kind "${job.kind}"`);
    }

    if (job.kind === "caption") {
      const imageUrl = job.payload?.imageUrl || "";
      if (!imageUrl) return fail("job carried no imageUrl", true);

      const img = await fetchImage(imageUrl);
      if (!img.base64) return fail(img.error, img.permanent);

      const out = await ollama.caption(img.base64, { title: job.payload?.title || "" });
      if (out.kind === UNAVAILABLE) return release(out.error);
      if (out.error) return fail(out.error, false, out.kind);
      return {
        outcome: "done",
        result: { ...stamp, ok: true, kind: "caption", result: { caption: out.text }, model: out.model, ms: now() - started },
      };
    }

    // summarize
    const text = job.payload?.text || "";
    if (!text.trim()) return fail("job carried no text to summarise", true);

    const out = await ollama.summarize(text, { title: job.payload?.title || "" });
    if (out.kind === UNAVAILABLE) return release(out.error);
    if (out.error) return fail(out.error, false, out.kind);
    return {
      outcome: "done",
      result: { ...stamp, ok: true, kind: "summarize", result: { summary: out.text }, model: out.model, ms: now() - started },
    };
  }

  /**
   * Lease a batch, work it, hand everything back.
   *
   * The loop checks `stopping` and the lease deadline before each job, so a
   * Ctrl-C or a laptop that slept through the lease costs at most one job's
   * worth of wasted work rather than the rest of the batch.
   */
  async function runBatch() {
    const summary = { leased: 0, ok: 0, failed: 0, released: 0, stale: 0, available: null, idle: false, error: "" };

    // Asking for work we've already decided not to do would lease a batch and
    // immediately release it — a pointless round trip that also briefly hides
    // those refs from any other runner.
    if (stopping) return { ...summary, error: "runner is stopping" };

    const got = await lease();
    if (got.error) return { ...summary, error: got.error };

    summary.available = got.available;
    if (!got.jobs.length) return { ...summary, idle: true };

    summary.leased = got.jobs.length;
    for (const job of got.jobs) inFlight.set(job.jobId, job);
    log(`lease: ${got.jobs.length} job(s)${got.available === null ? "" : ` · ${got.available} still queued`}`);

    const results = [];
    const releases = [];

    for (const job of got.jobs) {
      const label = `  ${job.kind.padEnd(9)} ${String(job.refId || job.jobId).slice(0, 24).padEnd(24)}`;

      if (stopping) {
        releases.push({ jobId: job.jobId, leaseId: job.leaseId, reason: "runner shutting down" });
        summary.released++;
        inFlight.delete(job.jobId);
        continue;
      }

      // Expired before we reached it. Doing it anyway would burn GPU time on a
      // result the worker is right to refuse, so hand it straight back.
      const expires = Date.parse(job.leaseExpiresAt || "");
      if (Number.isFinite(expires) && expires <= now()) {
        log(`${label} released  lease expired before we got to it`);
        releases.push({ jobId: job.jobId, leaseId: job.leaseId, reason: "lease expired before the runner reached it" });
        summary.released++;
        inFlight.delete(job.jobId);
        continue;
      }

      const out = await runJob(job);
      inFlight.delete(job.jobId);

      if (out.outcome === "done") {
        troubles = 0;
        results.push(out.result);
        summary.ok++;
        const size = out.result.result?.caption?.length ?? out.result.result?.summary?.length ?? 0;
        log(`${label} ok        ${secs(out.result.ms).padStart(6)}  ${size} chars`);
        continue;
      }

      if (out.outcome === "failed") {
        results.push(out.result);
        summary.failed++;
        if (out.kind === TIMEOUT) troubles++;
        else troubles = 0;
        log(`${label} FAILED    ${secs(out.result.ms).padStart(6)}  ${out.result.error}${out.result.permanent ? " (permanent)" : ""}`);
      } else {
        releases.push(out.release);
        summary.released++;
        troubles++;
        log(`${label} released  ${out.release.reason}`);
      }

      // Ollama went away or the Mac has gone to sleep. Every remaining job
      // would fail the same way, so stop, give them all back untouched, and
      // re-probe — which is what prints the command that fixes it.
      if (troubles >= troubleLimit) {
        log(`  stopping this batch: ${troubles} failures in a row that look like the environment, not the refs`);
        needsProbe = true;
        for (const rest of got.jobs) {
          if (!inFlight.has(rest.jobId)) continue;
          releases.push({ jobId: rest.jobId, leaseId: rest.leaseId, reason: "batch aborted: local model unavailable" });
          summary.released++;
          inFlight.delete(rest.jobId);
        }
        break;
      }
    }

    const sent = await submit(results, releases);
    if (sent.error) return { ...summary, error: sent.error };

    summary.stale = sent.stale.length;
    if (sent.stale.length) {
      // Not swallowed: he needs to know his Mac slept through a batch, because
      // the fix is "leave it plugged in", not anything in this code.
      log(`  ${sent.stale.length} result(s) arrived after their lease expired — the worker will hand those refs out again`);
    }
    for (const e of sent.errors || []) log(`  worker: ${e.jobId || ""} ${e.error || e}`);

    totals.ok += summary.ok;
    totals.failed += summary.failed;
    totals.released += summary.released;
    totals.stale += summary.stale;
    totals.batches++;

    log(
      `batch: ${summary.ok} done · ${summary.failed} failed · ${summary.released} released` +
        `${summary.available === null ? "" : ` · ${summary.available} left`}` +
        ` · worker applied ${sent.applied}`
    );
    return summary;
  }

  /** Print the fix and nothing else. He should never see a stack trace. */
  function reportProbe(p) {
    if (p.ok) {
      log(`ollama: ready at ${p.host} (${p.installed.join(", ") || "no models listed"})`);
      return;
    }
    log("");
    log(`ollama: not ready — ${p.error || "unknown"}`);
    for (const f of p.fixes) {
      log("");
      log(`  ${f.why}. Run this:`);
      log("");
      log(`    ${f.fix}`);
      if (f.alt) log(`    (if that says "command not found", run: ${f.alt})`);
    }
    log("");
  }

  /**
   * The loop. Runs until stopped, or once with `once`.
   *
   * Backoff escalates only for an unreachable worker — a lost wifi connection
   * at 2am must not turn into a request every five seconds until morning, and
   * must also not give up, because it will come back.
   */
  async function runForever({ once = false, maxBatches = Infinity } = {}) {
    let backoff = 0;
    let batches = 0;

    while (!stopping && batches < maxBatches) {
      if (needsProbe) {
        const p = await ollama.probe();
        reportProbe(p);
        if (!p.ok) {
          if (once) return { ...totals, error: p.error || "ollama not ready" };
          await sleep(BACKOFF_MS[Math.min(backoff++, BACKOFF_MS.length - 1)]);
          continue;
        }
        needsProbe = false;
        backoff = 0;
      }

      const out = await runBatch();
      batches++;

      if (out.error) {
        log(`worker: ${out.error}`);
        if (once) return { ...totals, error: out.error };
        const wait = BACKOFF_MS[Math.min(backoff++, BACKOFF_MS.length - 1)];
        log(`  retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }

      backoff = 0;
      if (once) break;

      if (out.idle) {
        log(`nothing queued — checking again in ${idleSeconds}s`);
        await sleep(idleSeconds * 1000);
      }
    }

    return { ...totals, error: "" };
  }

  /**
   * Stop cleanly. Anything still leased is released rather than abandoned so
   * the refs are workable again immediately instead of after the lease lapses.
   */
  async function stop(reason = "stopped") {
    stopping = true;
    if (!inFlight.size) return { released: 0, error: "" };
    const releases = [...inFlight.values()].map((j) => ({ jobId: j.jobId, leaseId: j.leaseId, reason }));
    inFlight.clear();
    const sent = await submit([], releases);
    return { released: releases.length, error: sent.error };
  }

  return {
    lease,
    submit,
    runJob,
    runBatch,
    runForever,
    stop,
    reportProbe,
    get inFlight() {
      return inFlight;
    },
    get stopping() {
      return stopping;
    },
    totals,
  };
}

// ------------------------------------------------------------------------ main

async function main() {
  const cfg = configFromEnv();
  if (!cfg.url || !cfg.token) {
    console.log("");
    console.log("Big Brain local runner — two settings are missing.");
    console.log("");
    console.log("  export BIGBRAIN_URL=https://save-ref-v2.raderturner-e87.workers.dev");
    console.log("");
    console.log("  read -rs BIGBRAIN_TOKEN && export BIGBRAIN_TOKEN");
    console.log("");
    process.exit(1);
  }

  const ollama = createOllama({
    host: cfg.ollamaHost,
    visionModel: cfg.visionModel,
    textModel: cfg.textModel,
  });
  const runner = createRunner({ ...cfg, ollama });

  console.log(`Big Brain local runner → ${cfg.url}`);
  console.log(`batch ${cfg.batch} · lease ${cfg.leaseSeconds}s · idle check ${cfg.idleSeconds}s`);

  // Two Ctrl-Cs: the first gives the leases back so the refs are immediately
  // workable again, the second is for when he means it right now.
  let quitting = false;
  const bye = async (sig) => {
    if (quitting) process.exit(130);
    quitting = true;
    console.log(`\n${sig} — finishing up, handing back anything still leased`);
    const out = await runner.stop("runner stopped by hand");
    if (out.error) console.log(`  could not release cleanly: ${out.error} (the leases lapse on their own)`);
    else if (out.released) console.log(`  released ${out.released}`);
    process.exit(0);
  };
  process.on("SIGINT", () => bye("SIGINT"));
  process.on("SIGTERM", () => bye("SIGTERM"));

  const t = await runner.runForever({ once: cfg.once });
  console.log(`\ndone: ${t.ok} enriched · ${t.failed} failed · ${t.released} released · ${t.batches} batches`);
  // Explicit, because keep-alive sockets hold the event loop open for a few
  // seconds after the last request. A finished run that sits there looking
  // hung is exactly the kind of thing he'd be right to distrust.
  process.exit(t.error ? 1 : 0);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((err) => {
    // Last resort only. Everything above returns errors rather than throwing,
    // so reaching here is a bug in this file, not something he can fix.
    console.error(`\nunexpected: ${short(err)}`);
    process.exit(1);
  });
}
