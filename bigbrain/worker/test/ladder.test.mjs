// Tests for the enrichment ladder: level inference, the permanent/transient
// split, and cohort selection. Pure logic plus a Map-backed KV — no network,
// no models, no bindings.
// Run: node test/ladder.test.mjs
import {
  levelOf,
  nextStep,
  climb,
  selectCohort,
  ladderStats,
  classifyFailure,
  recordAttempt,
  stepState,
  isBlocked,
  RUNGS,
  MAX_LEVEL,
  MAX_TRANSIENT_ATTEMPTS,
  PERMANENT,
  TRANSIENT,
} from "../src/ladder.js";
import { list as listStaged, stats as queueStats } from "../src/stage.js";
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
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: complete,
        cursor: complete ? undefined : slice[slice.length - 1],
      };
    },
  };
}

const NOW = new Date("2026-08-02T03:00:00Z");
const day = (n) => new Date(NOW.getTime() + n * 86_400_000);

/** A ref the way the Notion import left it: title, url, nothing else. */
const raw = (over = {}) => ({
  id: "r-raw",
  url: "https://example.com/piece",
  title: "A curtain rig that does the effect for real",
  category: "article",
  kind: "url",
  type: "Design Reference",
  ...over,
});

// ------------------------------------------------------------ level inference

eq("nothing is level 0", levelOf(null), 0);
eq("a raw import is level 0", levelOf(raw()), 0);

// Rung 1's artifact is the classification record, not a realm on the ref.
const classified = raw({ classified: { realm: "INSPO", confidence: 0.75 } });
eq("a classified ref is level 1", levelOf(classified), 1);
// A realm he set by hand answers the same question, so it counts too.
eq("his own realm counts as classified", levelOf(raw({ realm: "SELF" })), 1);

// Rung 2 is satisfied by the facts it produces, not by a stored level — this is
// what gets the 1,578 existing refs right with no migration.
const enriched = raw({
  id: "r-enriched",
  classified: { realm: "INSPO", confidence: 0.75 },
  image: "https://cdn.example.com/thumb.jpg",
  body: "x".repeat(1200),
});
eq("an enriched ref infers level 2 with no ladder state", levelOf(enriched), 2);
ok("and it carries no ladder object at all", enriched.ladder === undefined);

// Rungs 3 and 4 do not apply to an article. They must not inflate its level —
// an enriched article is "surface done", not "watched".
ok("an article is never credited for the rungs it cannot have", levelOf(enriched) < 3);
const articleTagged = { ...enriched, id: "r-tagged", ladder: { steps: { 5: { ok: true, attempts: 1 } } } };
eq("but staging its tags does top it out", levelOf(articleTagged), MAX_LEVEL);

// A captioned image.
const image = (over = {}) => ({
  id: "r-img",
  url: "https://cdn.example.com/shot.jpg",
  category: "image",
  kind: "url",
  title: "rhinestone on mirror",
  classified: { realm: "INSPO", confidence: 0.9 },
  image: "https://cdn.example.com/shot.jpg",
  imageTried: true,
  ...over,
});
eq("an image with a thumb but no caption is level 2", levelOf(image()), 2);
eq("a captioned image is level 3", levelOf(image({ caption: "a mirrored panel, rhinestones" })), 3);
// Rung 4 doesn't apply to an image, so caption + staged tags tops it out.
eq(
  "a captioned, tagged image is topped out",
  levelOf(image({ caption: "c", ladder: { steps: { 5: { ok: true, attempts: 1 } } } })),
  MAX_LEVEL
);

// A blob-backed screenshot has no url, so rung 2 does not apply to it at all.
const blob = {
  id: "r-blob",
  category: "image",
  kind: "blob",
  title: "screenshot",
  blobKey: "abc",
  classified: { realm: "INSPO", confidence: 0.5 },
};
// No url means rung 2 is meaningless for it — stepped over, never credited.
eq("a url-less blob is not credited with a surface pass", levelOf(blob), 1);
eq("and its next step is the vision rung", nextStep(blob, { now: NOW }).level, 3);

// A video.
const video = (over = {}) => ({
  id: "r-vid",
  url: "https://www.youtube.com/watch?v=abc123",
  category: "video",
  kind: "url",
  title: "Gary Card studio tour",
  classified: { realm: "INSPO", confidence: 0.8 },
  image: "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
  imageTried: true,
  enrichTried: "2026-07-01T00:00:00Z",
  ...over,
});
eq("a video with a thumb but no transcript is level 2", levelOf(video()), 2);
eq("a transcribed video is level 4", levelOf(video({ transcript: "hello there" })), 4);
eq(
  "an old transcript stored as body still counts",
  levelOf(video({ body: "hello there", enrichKind: "transcript" })),
  4
);

// Monotonicity: a captioned image that was never classified is still level 0.
eq("depth without rung 1 is not a level", levelOf(image({ caption: "c", classified: undefined })), 0);

// ------------------------------------------------------------------ next step

eq("a raw ref's next step is the free one", nextStep(raw(), { now: NOW }).level, 1);
eq("and it is tier 0", nextStep(raw(), { now: NOW }).tier, 0);
eq("a classified article next wants its surface", nextStep(classified, { now: NOW }).level, 2);
eq("a level-2 image next wants vision", nextStep(image(), { now: NOW }).level, 3);
ok("and vision is flagged as such", nextStep(image(), { now: NOW }).vision === true);
eq("a level-2 video next wants watching", nextStep(video(), { now: NOW }).level, 4);

eq("a topped-out ref has no next step", nextStep(articleTagged, { now: NOW }), null);
eq("null in, null out", nextStep(null, { now: NOW }), null);

// The impossibility the brief names: no bytes anywhere, so rung 3 is unreachable.
const bytesless = image({ image: "", blobKey: "", imageTried: true, imageWhy: "blocked" });
eq("an image with no bytes is still honestly level 2", levelOf(bytesless), 2);
ok("and it is never offered the vision rung", nextStep(bytesless, { now: NOW }).level !== 3);
eq("it is offered the free tag rung instead", nextStep(bytesless, { now: NOW }).level, 5);
// With nothing to tag either, there is genuinely nothing left to do.
const emptyBytesless = { ...bytesless, title: "", name: "", caption: "" };
eq("no bytes and no text means topped out", nextStep(emptyBytesless, { now: NOW }), null);

// A video that isn't on YouTube cannot be watched with the tools we have.
const vimeo = video({ url: "https://vimeo.com/12345", image: "https://i.vimeocdn.com/x.jpg" });
ok("a non-YouTube video is never offered rung 4", nextStep(vimeo, { now: NOW }).level !== 4);

// maxTier keeps a free-tier-only night off the paid rungs.
eq("tier 0 night skips vision", nextStep(image(), { now: NOW, maxTier: 0 }).level, 5);

// ----------------------------------------------- permanent vs transient failure

eq("a 404 is permanent", classifyFailure({ status: 404 }).kind, PERMANENT);
eq("a 403 is permanent", classifyFailure({ status: 403 }).kind, PERMANENT);
eq("a 429 is transient", classifyFailure({ status: 429 }).kind, TRANSIENT);
eq("a 503 is transient", classifyFailure({ status: 503 }).kind, TRANSIENT);
eq("a timeout is transient", classifyFailure(new Error("The operation timed out")).kind, TRANSIENT);
eq("an unbound binding is transient", classifyFailure({ message: "AI not bound" }).kind, TRANSIENT);
eq("no caption track is permanent", classifyFailure({ message: "no-captions: no track" }).kind, PERMANENT);
// The default that matters: we never permanently give up on what we can't read.
eq("an unrecognised failure is transient", classifyFailure({ message: "weird" }).kind, TRANSIENT);
ok("and the reason survives", classifyFailure({ message: "weird" }).reason.includes("weird"));

// A permanent failure closes the rung: never asked again.
const permBlocked = {
  ...image(),
  ladder: recordAttempt(image(), 3, { ok: false, reason: "blocked (403)", permanent: true, now: NOW }),
};
ok("a permanent failure blocks its rung", isBlocked(permBlocked, 3, { now: NOW }));
ok("and it is still blocked a year later", isBlocked(permBlocked, 3, { now: day(365) }));
ok("so the vision rung is never offered again", nextStep(permBlocked, { now: day(365) })?.level !== 3);
eq("but the free rung below it still is", nextStep(permBlocked, { now: day(365) }).level, 5);
eq("retry re-opens it deliberately", nextStep(permBlocked, { now: NOW, retry: true }).level, 3);

// A transient failure backs off, then comes back.
const transient = {
  ...image(),
  ladder: recordAttempt(image(), 3, { ok: false, reason: "busy (429)", permanent: false, now: NOW }),
};
ok("a transient failure is not permanent", !stepState(transient, 3).permanent);
ok("it is blocked during the backoff", isBlocked(transient, 3, { now: new Date(NOW.getTime() + 3600_000) }));
ok("and retried once the backoff elapses", !isBlocked(transient, 3, { now: day(2) }));
eq("so the rung comes back round", nextStep(transient, { now: day(2) }).level, 3);

// ...but not forever. Repeated transients convert to permanent.
let repeated = image();
for (let i = 0; i < MAX_TRANSIENT_ATTEMPTS; i++) {
  repeated = { ...repeated, ladder: recordAttempt(repeated, 3, { ok: false, reason: "busy (429)", now: day(i * 4) }) };
}
eq("attempts are counted", stepState(repeated, 3).attempts, MAX_TRANSIENT_ATTEMPTS);
ok("a rung that keeps failing converts to permanent", stepState(repeated, 3).permanent);
ok("and says why", stepState(repeated, 3).reason.includes("treating as permanent"));
ok("so it stops being retried", nextStep(repeated, { now: day(400) })?.level !== 3);

// A success wipes the failure bookkeeping — a stale `permanent` must not
// survive a rung that has since worked.
const healed = { ...permBlocked, ladder: recordAttempt(permBlocked, 3, { ok: true, now: day(1) }) };
ok("success clears the permanent mark", !stepState(healed, 3).permanent);
ok("and unblocks the rung", !isBlocked(healed, 3, { now: day(1) }));

// ------------------------------------------------------------------ the climb

function envWith(refs, extra = {}) {
  const kv = makeKV();
  for (const r of refs) kv.store.set(`ref:${r.id}`, JSON.stringify(r));
  return { REFS_KV: kv, ...extra };
}

// Rung 1 is free, deterministic, and stages rather than applies.
{
  const r = raw({ id: "c1", type: "Design Reference" });
  const env = envWith([r]);
  const out = await climb(env, r, { now: NOW });
  eq("a free climb succeeds", out.ok, true);
  eq("it advances exactly one level", out.to, 1);
  eq("from where it started", out.from, 0);
  const stored = await env.REFS_KV.get("ref:c1", "json");
  ok("the classification record is persisted", Boolean(stored.classified?.realm));
  eq("the level is persisted too", stored.ladder.level, 1);
  // Hard rule: the ladder never decides what a ref means.
  eq("realm is NEVER written onto the ref", stored.realm, undefined);
  eq("tags are NEVER written onto the ref", stored.tags, undefined);
  eq("tier 0 work costs nothing", (await ledger(env)).usd, 0);
}

// A climb can never bring a ref into existence.
{
  const r = raw({ id: "ghost" });
  const env = envWith([]); // the key does not exist
  const out = await climb(env, r, { now: NOW });
  const refKeys = [...env.REFS_KV.store.keys()].filter((k) => k.startsWith("ref:"));
  eq("climbing a deleted ref creates no ref", refKeys.length, 0);
  eq("and says so instead of failing silently", out.ok, false);
  ok("with a reason", out.reason.includes("deleted"));
}

// Only one advance per call — breadth is the point.
{
  const r = raw({ id: "c2" });
  const env = envWith([r]);
  const first = await climb(env, r, { now: NOW });
  eq("first climb lands on rung 1", first.to, 1);
  const after = await env.REFS_KV.get("ref:c2", "json");
  eq("and rung 2 is only the NEXT step, not this one", nextStep(after, { now: NOW }).level, 2);
}

// Level-5 tags land in the queue, never on the ref.
{
  const r = {
    id: "c3",
    url: "https://example.com/set",
    title: "Gary Card set design for a window display",
    category: "article",
    kind: "url",
    type: "Design Reference",
    classified: { realm: "INSPO", confidence: 0.9 },
    image: "https://cdn.example.com/t.jpg",
    imageTried: true,
    body: "y".repeat(900),
  };
  const env = envWith([r]);
  eq("it is sitting at level 2 with its surface done", levelOf(r), 2);
  // Rungs 3 and 4 don't apply to an article, so the next step is rung 5.
  eq("its next step is the tag rung", nextStep(r, { now: NOW }).level, 5);

  const out = await climb(env, r, { now: NOW });
  eq("the tag climb succeeds", out.ok, true);
  ok("and it staged something", out.staged > 0);

  const stored = await env.REFS_KV.get("ref:c3", "json");
  eq("tags did NOT land on the ref", stored.tags, undefined);
  eq("the ref is topped out all the same", stored.ladder.level, MAX_LEVEL);

  const feed = await listStaged(env, { limit: 10 });
  eq("the proposal is in the swipe queue", feed.items.length, 1);
  eq("as a tag proposal", feed.items[0].kind, "tag");
  eq("attributed to the ladder", feed.items[0].source, "ladder");
  eq("and pending his thumb", feed.items[0].status, "pending");
  ok("carrying real tags", feed.items[0].proposal.tags.length > 0);

  // Asking again would be noise: the rung records that it asked.
  eq("the tag rung is not re-asked", nextStep(stored, { now: day(30) }), null);
}

// A rung that says nothing still counts as asked.
{
  const r = {
    id: "c4", url: "https://example.com/x", title: "zzz qqq", category: "article", kind: "url",
    classified: { realm: "INSPO", confidence: 0.9 },
    image: "https://cdn/t.jpg", imageTried: true, body: "z".repeat(900),
  };
  const env = envWith([r]);
  const out = await climb(env, r, { now: NOW });
  eq("silence is still a completed rung", out.ok, true);
  eq("nothing was staged", out.staged, 0);
  const stored = await env.REFS_KV.get("ref:c4", "json");
  eq("and we do not ask again tomorrow", nextStep(stored, { now: day(1) }), null);
}

// The budget refusing us is OUR constraint, not the ref's fault.
{
  const r = image({ id: "c5" });
  // A ceiling below one tier-2 unit. Not literally 0: budget.js reads its
  // ceiling with `Number(x) || DEFAULT`, so a zero ceiling silently becomes $5.
  const env = envWith([r], { NIGHTLY_CEILING_USD: 0.0001 });
  const out = await climb(env, r, { now: NOW });
  eq("an unaffordable climb does not run", out.ok, false);
  ok("and says why", out.reason.includes("ceiling"));
  const stored = await env.REFS_KV.get("ref:c5", "json");
  eq("no attempt is recorded against the ref", stepState(stored, 3), null);
  eq("so tomorrow finds it exactly where it was", nextStep(stored, { now: day(1) }).level, 3);
}

// A tier ceiling below the step's cost is the same: not an attempt.
{
  const r = image({ id: "c6" });
  const env = envWith([r]);
  const out = await climb(env, r, { tier: 0, now: NOW });
  eq("a tier-0 night refuses the vision rung", out.ok, false);
  ok("and names the tier it needed", out.reason.includes("tier 2"));
  eq("nothing was charged", (await ledger(env)).usd, 0);
}

// A run that throws is classified and recorded, not swallowed.
{
  const r = image({ id: "c7" });
  const env = envWith([r], { AI: { async run() { throw new Error("connection timed out"); } } });
  const out = await climb(env, r, { now: NOW });
  eq("a thrown rung fails loudly", out.ok, false);
  eq("a timeout is not permanent", out.permanent, false);
  const stored = await env.REFS_KV.get("ref:c7", "json");
  eq("the attempt is on the ref", stepState(stored, 3).attempts, 1);
  ok("with a backoff", Boolean(stepState(stored, 3).nextAt));
  ok("blocked tonight", isBlocked(stored, 3, { now: NOW }));
  ok("open again after the backoff", !isBlocked(stored, 3, { now: day(2) }));
}

// ---------------------------------------------------------------- the cohort

// Breadth before depth: eight refs at assorted depths, one cohort.
{
  const refs = [
    // Four with free rung-1 work outstanding.
    raw({ id: "a1" }), raw({ id: "a2" }), raw({ id: "a3" }), raw({ id: "a4" }),
    // Two sitting at level 1, wanting the tier-0 surface pass.
    raw({ id: "b1", classified: { realm: "INSPO", confidence: 0.8 } }),
    raw({ id: "b2", classified: { realm: "INSPO", confidence: 0.8 } }),
    // Two at level 2 wanting paid depth.
    image({ id: "d1" }), video({ id: "d2" }),
  ];
  const env = envWith(refs);

  const cohort = await selectCohort(env, { limit: 6, now: NOW });
  eq("the cohort has no error", cohort.error, null);
  eq("and it is bounded by the limit", cohort.items.length, 6);
  const stepLevels = cohort.items.map((i) => i.step.level);
  eq("breadth first: the whole cohort is the shallowest work", JSON.stringify(stepLevels), JSON.stringify([1, 1, 1, 1, 2, 2]));
  ok("nothing paid got in ahead of free work", cohort.items.every((i) => i.step.tier === 0));
  eq("the plan spent nothing", cohort.plan.planned, 0);

  // The histogram comes back free with the walk.
  ok("the level histogram is reported", cohort.levels[0] === 4 && cohort.levels[1] === 2 && cohort.levels[2] === 2);

  // Once the shallow work is gone, the deep work is what's left.
  const deepOnly = envWith([image({ id: "d1" }), video({ id: "d2" })]);
  const deep = await selectCohort(deepOnly, { limit: 6, now: NOW });
  eq("with nothing shallow left, depth is selected", deep.items.length, 2);
  ok("and it is priced", deep.plan.planned > 0);
}

// The cohort respects the budget it is given.
{
  const refs = [image({ id: "p1" }), image({ id: "p2" }), image({ id: "p3" }), image({ id: "p4" })];
  const env = envWith(refs);
  const one = await selectCohort(env, { limit: 10, budget: 0.00025, now: NOW });
  eq("only what the budget covers is selected", one.items.length, 1);
  ok("and the rest are accounted for", one.plan.skippedForBudget === 3);
  ok("the plan never exceeds the allowance", one.plan.planned <= one.plan.allowed);

  const none = await selectCohort(env, { limit: 10, budget: 0, now: NOW });
  eq("a zero budget selects nothing", none.items.length, 0);
  eq("without pretending it is an error", none.error, null);
}

// Vision is rationed by count as well as cost.
{
  const refs = Array.from({ length: 30 }, (_, i) => image({ id: `v${String(i).padStart(2, "0")}` }));
  const env = envWith(refs);
  const cohort = await selectCohort(env, { limit: 30, now: NOW });
  ok("the vision ration caps the cohort", cohort.plan.visionPlanned <= cohort.plan.visionLeft);
  ok("well under the whole set", cohort.items.length < refs.length);
}

// A broken KV must never read as a finished archive.
{
  const env = { REFS_KV: { async list() { throw new Error("KV exploded"); } } };
  const cohort = await selectCohort(env, { limit: 5, now: NOW });
  eq("a failed list returns no items", cohort.items.length, 0);
  ok("but it says the list failed", cohort.error && cohort.error.includes("KV exploded"));
  ok("and does not claim to be done", cohort.done === false);
}

// Degrade gracefully with no bindings at all.
{
  const cohort = await selectCohort({}, { limit: 5, now: NOW });
  eq("no KV means no cohort", cohort.items.length, 0);
  ok("and an honest reason", cohort.error.includes("REFS_KV"));
}

// Resumable: a stretch of archive with nothing to do hands back a cursor rather
// than re-reading its own front page every night.
{
  const done = Array.from({ length: 100 }, (_, i) => ({
    ...articleTagged,
    id: `t${String(i).padStart(3, "0")}`,
  }));
  const todo = Array.from({ length: 50 }, (_, i) => raw({ id: `u${String(i).padStart(3, "0")}` }));
  const env = envWith([...done, ...todo]);

  const first = await selectCohort(env, { limit: 5, maxScan: 100, now: NOW });
  eq("a stretch with no work selects nothing", first.items.length, 0);
  eq("without claiming the archive is finished", first.done, false);
  ok("and it hands back where to resume", Boolean(first.cursor));
  ok("no error, because nothing was wrong", first.error === null);

  const second = await selectCohort(env, { limit: 5, maxScan: 100, cursor: first.cursor, now: NOW });
  eq("resuming finds the work further in", second.items.length, 5);
  ok("all of it from the untouched tail", second.items.every((i) => i.id.startsWith("u")));
}

// Progress, not the same five refs every night: a climbed cohort steps aside
// for the shallower work still outstanding behind it.
{
  const refs = Array.from({ length: 12 }, (_, i) => raw({ id: `w${String(i).padStart(2, "0")}` }));
  const env = envWith(refs);
  const first = await selectCohort(env, { limit: 4, now: NOW });
  eq("first cohort is four", first.items.length, 4);
  for (const item of first.items) await climb(env, item.ref, { now: NOW });

  const second = await selectCohort(env, { limit: 4, now: NOW });
  const overlap = first.items.filter((i) => second.items.some((j) => j.id === i.id));
  eq("the next cohort is entirely new refs", overlap.length, 0);
  ok("still doing the shallowest work first", second.items.every((i) => i.step.level === 1));
}

// ------------------------------------------------------------------ the stats
{
  const env = envWith([raw({ id: "s1" }), { ...classified, id: "s2" }, { ...enriched, id: "s3" }, { ...articleTagged, id: "s4" }]);
  const s = await ladderStats(env, { now: NOW });
  eq("stats have no error", s.error, null);
  eq("every ref is counted somewhere", Object.values(s.levels).reduce((a, b) => a + b, 0), 4);
  eq("one of each level", JSON.stringify(s.levels), JSON.stringify({ 0: 1, 1: 1, 2: 1, 5: 1 }));
  ok("and so is what comes next", Object.keys(s.next).length > 0);
  eq("the topped-out one is named as such", s.toppedOut, 1);
}

// --------------------------------------------------------------- shape checks
ok("every rung declares its tier", RUNGS.every((r) => typeof r.tier === "number"));
ok("rungs are in ascending order", RUNGS.every((r, i) => r.level === i + 1));
ok("only rung 3 spends the vision ration", RUNGS.filter((r) => r.vision).map((r) => r.level).join() === "3");
ok("no rung above tier 2 — the ladder never reaches for Claude", RUNGS.every((r) => r.tier <= 2));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
