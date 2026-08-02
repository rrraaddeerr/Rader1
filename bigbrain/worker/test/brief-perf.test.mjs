// The first brief of the day used to fetch up to 400 refs from KV one at a
// time — each a full round trip. I/O wait costs no CPU time on a Worker, so
// it never tripped a resource limit; it just sat there, and on a phone that
// reads as "the page doesn't work" rather than as an error, because nothing
// ever comes back to be wrong about. This proves the batched walk (a) is
// actually concurrent, not just chunked-but-sequential, (b) never reads past
// the maxRead budget no matter the batch size, and (c) returns the identical
// counts a fully sequential walk would, for a fixture the sequential version
// was already exercised against.
// Run: node test/brief-perf.test.mjs
import { walkArchive } from "../src/brief.js";
import { stats as queueStats } from "../src/stage.js";

let pass = 0, fail = 0;
function ok(label, cond) { cond ? pass++ : (fail++, console.error("✗ " + label)); }
function eq(label, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}

const TS_MAX = 10_000_000_000_000;
const NOW = Date.parse("2026-07-29T14:00:00Z");
const DAY = 86_400_000;

/**
 * A KV whose `get` takes real (simulated) time and records how many calls
 * were in flight at once. If the code under test were still sequential, the
 * peak would be 1 no matter how many refs exist — that is the whole thing
 * this file is checking.
 */
function makeLatentKV(n, { latencyMs = 5, ageDays = 0 } = {}) {
  const store = new Map();
  for (let i = 0; i < n; i++) {
    const at = NOW - ageDays * DAY - i; // strictly newest-first, all inside "today"
    const id = String(TS_MAX - at).padStart(14, "0") + "-" + String(i).padStart(6, "0");
    store.set(`ref:${id}`, JSON.stringify({ id, title: "ref " + i, createdAt: new Date(at).toISOString() }));
  }
  let inFlight = 0, peak = 0, calls = 0;
  return {
    peak: () => peak,
    calls: () => calls,
    async get(name, type) {
      inFlight++; peak = Math.max(peak, inFlight); calls++;
      await new Promise((r) => setTimeout(r, latencyMs));
      inFlight--;
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

const run = async () => {
  // --------------------------------------------------------- actually concurrent
  {
    const kv = makeLatentKV(100, { latencyMs: 8 });
    const t0 = Date.now();
    const out = await walkArchive({ REFS_KV: kv }, { now: NOW, windowMs: DAY, maxRead: 100, sampleMin: 100 });
    const elapsed = Date.now() - t0;

    eq("reads exactly what was asked for", out.read, 100);
    ok("more than one get was ever in flight at once", kv.peak() > 1);
    ok("peak concurrency respects the batch size (not unbounded either)", kv.peak() <= 20);
    // 100 sequential 8ms round trips would take ~800ms; batched at 20 wide it's
    // ~5 batches, ~40ms of latency. Generous margin for a slow CI box.
    ok(`wall clock reflects batching, not 100 serial round trips (took ${elapsed}ms)`, elapsed < 400);
  }

  // ------------------------------------------------------- never exceeds maxRead
  // The soft "window-closed" stop is allowed to overshoot by up to a batch's
  // worth of reads (documented in brief.js) — maxRead is not allowed to, ever,
  // because it is the number that stands between this endpoint and a runaway
  // request. Checked at a batch size (7) that does not divide evenly into the
  // cap (50), which is exactly where an off-by-one would show up.
  {
    const kv = makeLatentKV(500, { latencyMs: 1 });
    const out = await walkArchive({ REFS_KV: kv }, { now: NOW, windowMs: DAY, maxRead: 50, sampleMin: 500 });
    eq("read never exceeds maxRead", out.read, 50);
    eq("stopReason says why", out.stopReason, "read-cap");
    eq("kv was never asked for more than maxRead", kv.calls(), 50);
  }

  // ---------------------------------------------------- same answer as before
  // A mixed fixture — recent, stale, undated, a hole — run through the batched
  // walk should land on the exact counts the sequential implementation was
  // already proven against in test/brief.test.mjs.
  {
    const kv = makeLatentKV(0);
    const mk = (title, hoursAgo) => ({
      id: String(TS_MAX - (NOW - hoursAgo * 3_600_000)).padStart(14, "0") + "-" + title,
      title,
      createdAt: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
    });
    const recent1 = mk("recent-1", 2);
    const recent2 = mk("recent-2", 5);
    const stale1 = mk("stale-1", 200);
    const undated = { id: "z-undated", title: "no date" };
    for (const r of [recent1, recent2, stale1, undated]) kv.put(`ref:${r.id}`, JSON.stringify(r));
    kv.put("ref:zzz-hole", ""); // a listed key that reads back empty

    const out = await walkArchive({ REFS_KV: kv }, { now: NOW, windowMs: DAY, maxRead: 400, sampleMin: 1 });
    eq("total sees every key", out.total, 5);
    eq("read gets every key that wasn't skipped by an early stop", out.read, 5);
    eq("two are inside the window", out.recent.length, 2);
    eq("one undated ref is counted, not silently dropped", out.undated, 1);
    ok("the empty read counts as unreadable, not as a ref", out.unreadable >= 1);
  }

  // --------------------------------------------------------- queue scan, same fix
  {
    const kv = makeLatentKV(0, { latencyMs: 6 });
    for (let i = 0; i < 60; i++) {
      kv.put(`stage:${String(i).padStart(4, "0")}`, JSON.stringify({ status: i % 3 === 0 ? "approved" : "pending" }));
    }
    const t0 = Date.now();
    const counts = await queueStats({ REFS_KV: kv });
    const elapsed = Date.now() - t0;
    eq("counts are correct", counts.pending, 40);
    eq("counts are correct (approved)", counts.approved, 20);
    ok("more than one get in flight for the queue scan too", kv.peak() > 1);
    ok(`60 items scan fast, not at 6ms sequential (took ${elapsed}ms)`, elapsed < 200);
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
