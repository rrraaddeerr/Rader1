// Tests for Loop 2 — learning his judgment from the swipe queue.
// Map-backed KV, no network, no bindings, no models. The scoring and
// suppression maths are pure, so most of this needs no KV at all.
// Run: node test/learn.test.mjs
import {
  recordOutcome,
  acceptance,
  summarize,
  scoreProposal,
  scoreProposalWith,
  shouldSuppress,
  learnedRealm,
  wilson,
  conservativeRate,
  MIN_SAMPLE,
  SUPPRESS_MIN_SAMPLE,
  MOVE_MIN_SAMPLE,
  MAX_DELTA,
} from "../src/learn.js";

let pass = 0, fail = 0;
function ok(label, cond) { cond ? pass++ : (fail++, console.error("✗ " + label)); }
function eq(label, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}

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
      return { keys: slice.map((name) => ({ name })), list_complete: complete, cursor: complete ? undefined : slice[slice.length - 1] };
    },
    _store: store,
  };
}

/** A queue item as stage.js holds it, BEFORE decide() applies any edit. */
function card(id, { kind = "tag", source = "propose", realm = "INSPO", axis = "", confidence = 0.7 } = {}) {
  return {
    id,
    kind,
    source,
    target: `https://ref.test/${id}`,
    status: "pending",
    proposal: { currentTitle: "", proposedTitle: "", realm, axis, tags: [], confidence, why: "", tier: 0, handle: "", url: `https://ref.test/${id}` },
  };
}

/** Counters straight from a literal — the pure half needs no KV. */
function kindCounters(approved, rejected, kind = "tag") {
  return { v: 1, kind: { [kind]: { approved, rejected, skipped: 0, edited: 0 } } };
}

// ------------------------------------------------------------- the maths
const two = wilson(2, 2);
ok("two out of two is not 100%", two.lower < 0.4);
ok("and the interval says so", two.upper > 0.99);
eq("a coin flip is the answer for two swipes", conservativeRate(2, 2), 0.5);
eq("no data means no opinion", conservativeRate(0, 0), 0.5);
ok("eighteen of twenty is real evidence", conservativeRate(18, 20) > 0.6);
ok("two of twenty is real evidence the other way", conservativeRate(2, 20) < 0.4);

// -------------------------------------------------- recording + aggregating
const env = { REFS_KV: makeKV() };

const r1 = await recordOutcome(env, card("q1", { kind: "tag" }), { action: "approve" });
ok("a decision is recorded", r1.ok && r1.recorded);
eq("and normalised", r1.action, "approved");
await recordOutcome(env, card("q2", { kind: "tag" }), { action: "approve" });
await recordOutcome(env, card("q3", { kind: "tag" }), { action: "reject" });
await recordOutcome(env, card("q4", { kind: "dead-link", source: "propose" }), { action: "approve" });
await recordOutcome(env, card("q5", { kind: "tag" }), { action: "skip" });

const stats1 = await acceptance(env);
ok("aggregating reads back", stats1.ok);
eq("one read, no rebuild", stats1.source, "rollup");
eq("tag decisions counted", stats1.byKind.tag.n, 3);
eq("tag approvals counted", stats1.byKind.tag.approved, 2);
eq("tag rejections counted", stats1.byKind.tag.rejected, 1);
eq("a skip is counted", stats1.byKind.tag.skipped, 1);
ok("but a skip stays out of the rate", stats1.byKind.tag.rate === Number((2 / 3).toFixed(3)));
eq("the other generator is separate", stats1.byKind["dead-link"].approved, 1);
eq("source is aggregated too", stats1.bySource.propose.decisions, 5);
ok("every rate carries its sample", Object.values(stats1.byKind).every((c) => typeof c.n === "number"));
ok("and knows four swipes is not evidence", Object.values(stats1.byKind).every((c) => c.confident === false));
eq("a generator nobody has judged has no rate", summarize({}).byKind.tag, undefined);
eq("an empty aggregate is honest about zero", summarize({}).totals.rate, null);
ok("zero is not the same as no data", summarize({ v: 1, kind: { tag: { approved: 0, rejected: 4 } } }).byKind.tag.rate === 0);

// Re-deciding a card replaces its outcome — it must not count twice.
await recordOutcome(env, card("q5", { kind: "tag" }), { action: "approve" });
const stats2 = await acceptance(env);
eq("a changed mind replaces, never stacks", stats2.byKind.tag.skipped, 0);
eq("and lands in the new bucket", stats2.byKind.tag.approved, 3);
eq("the total is still five cards", stats2.bySource.propose.decisions, 5);

// Undo has to unwind the signal too, or reopening teaches a lie.
await recordOutcome(env, { ...card("q5", { kind: "tag" }), status: "approved" }, { action: "reopen" });
const stats3 = await acceptance(env);
eq("reopening retracts the outcome", stats3.byKind.tag.approved, 2);
eq("and nothing is left behind", stats3.bySource.propose.decisions, 4);

// The rollup is a cache of the outcome log, and a rebuild must agree with it.
const rebuilt = await acceptance(env, { rebuild: true });
eq("a rebuild replays the log", rebuilt.byKind.tag.approved, stats3.byKind.tag.approved);
eq("and says where the numbers came from", rebuilt.source, "rebuilt");
eq("with nothing swallowed", rebuilt.debug.errors.length, 0);

// ---------------------------------------------------------- rule 4: honesty
const brokenRead = await acceptance({ REFS_KV: { async get() { throw new Error("KV down"); } } });
eq("a broken KV is not an empty result", brokenRead.ok, false);
ok("and it says what broke", brokenRead.error.includes("KV down"));
const brokenWrite = await recordOutcome(
  { REFS_KV: { async get() { return null; }, async put() { throw new Error("KV full"); } } },
  card("q9"),
  { action: "approve" }
);
eq("a decision we couldn't store is not a success", brokenWrite.ok, false);
ok("and it says so", brokenWrite.error.includes("KV full"));
const noKv = await recordOutcome({}, card("q9"), { action: "approve" });
eq("no binding is reported, not ignored", noKv.ok, false);
// A rollup we can't read must never be overwritten with a fresh one.
const clobber = await recordOutcome(
  { REFS_KV: { async get(name) { if (name.startsWith("learn:out:")) return null; throw new Error("read failed"); }, async put() { throw new Error("should not have written"); } } },
  card("q10"),
  { action: "approve" }
);
eq("an unreadable rollup is refused, not replaced", clobber.ok, false);
ok("with the reason", clobber.error.includes("read failed"));

// ------------------------------------------------------------- suppression
// A generator he has barely seen is never silenced, however badly it is doing.
const tiny = summarize(kindCounters(0, 3));
const tinyCall = shouldSuppress(tiny, "tag", { roll: 0.99 });
eq("three rejections silence nothing", tinyCall.suppress, false);
ok("and it says the sample is the reason", tinyCall.reason.includes(String(SUPPRESS_MIN_SAMPLE)));
eq("an unknown generator is not suppressed either", shouldSuppress(tiny, "never-run", { roll: 0.99 }).suppress, false);
ok("nor is one at the threshold but not past it", shouldSuppress(summarize(kindCounters(0, SUPPRESS_MIN_SAMPLE - 1)), "tag", { roll: 0.99 }).suppress === false);

// Sustained rejection does stop it.
const bad = summarize(kindCounters(0, 15));
const badCall = shouldSuppress(bad, "tag", { roll: 0.99 });
eq("fifteen rejections in a row is enough", badCall.suppress, true);
eq("the sample rides along", badCall.n, 15);
ok("and the reason is readable on a phone", badCall.reason.length < 90 && badCall.reason.includes("0/15"));

// Suppression is a door, not a wall.
const probe = shouldSuppress(bad, "tag", { roll: 0.01 });
eq("but one pass in ten runs anyway", probe.suppress, false);
eq("and is flagged as a probe", probe.probe, true);
ok("with the reason it was let through", probe.reason.includes("improved"));
eq("a zero probe rate closes the door completely", shouldSuppress(bad, "tag", { roll: 0.001, probeRate: 0 }).suppress, true);

// …and once the probes start landing, it earns its way back.
const recovering = summarize(kindCounters(3, 15));
eq("three approvals reopen the question", shouldSuppress(recovering, "tag", { roll: 0.99 }).suppress, false);
ok("and the interval is why", recovering.byKind.tag.upper >= 0.25);
eq("a generator he mostly likes is never suppressed", shouldSuppress(summarize(kindCounters(18, 2)), "tag", { roll: 0.99 }).suppress, false);
eq("no stats at all suppresses nothing", shouldSuppress(null, "tag", { roll: 0.99 }).suppress, false);
ok("and says why", shouldSuppress({ ok: false, error: "KV down" }, "tag", { roll: 0.99 }).reason.includes("KV down"));

// ---------------------------------------------------------------- the edits
// His edits are the strongest signal: not "wrong" but "wrong, and here is right".
const editEnv = { REFS_KV: makeKV() };
for (let i = 0; i < 6; i++) {
  await recordOutcome(editEnv, card(`e${i}`, { source: "newsletter", realm: "INSPO" }), {
    action: "approve",
    edits: { realm: "KNOWLEDGE" },
  });
}
const editStats = await acceptance(editEnv);
const learned = learnedRealm(editStats, "newsletter", "INSPO");
ok("the mapping is learned", Boolean(learned));
eq("from the realm we proposed", learned.from, "INSPO");
eq("to the realm he chose", learned.to, "KNOWLEDGE");
eq("counted", learned.moves, 6);
eq("six in a row is enough to lean on", learned.confident, true);
eq("and the edit shows up as an edit", editStats.bySource.newsletter.edited, 6);
eq("an approval is still an approval", editStats.bySource.newsletter.approved, 6);

// Approving unchanged is evidence the other way, and it dilutes the mapping.
const mixedEnv = { REFS_KV: makeKV() };
for (let i = 0; i < 3; i++) {
  await recordOutcome(mixedEnv, card(`m${i}`, { source: "newsletter", realm: "INSPO" }), { action: "approve", edits: { realm: "KNOWLEDGE" } });
}
for (let i = 0; i < 3; i++) {
  await recordOutcome(mixedEnv, card(`k${i}`, { source: "newsletter", realm: "INSPO" }), { action: "approve" });
}
const mixed = learnedRealm(await acceptance(mixedEnv), "newsletter", "INSPO");
eq("a mapping he only half-agrees with is reported", mixed.moves, 3);
eq("but not trusted", mixed.confident, false);
eq("the kept ones are counted too", mixed.kept, 3);
eq("a source with no edits has no mapping", learnedRealm(await acceptance(env), "propose", "INSPO"), null);

// The swipe UI echoes the card's tags back whether or not he touched them.
const echoEnv = { REFS_KV: makeKV() };
const withTags = card("t1");
withTags.proposal.tags = ["Set", "Lighting"];
await recordOutcome(echoEnv, withTags, { action: "approve", edits: { tags: ["Lighting", "Set"] } });
const changed = card("t2");
changed.proposal.tags = ["Set"];
await recordOutcome(echoEnv, changed, { action: "approve", edits: { tags: ["Set", "Material"] } });
const echoed = await acceptance(echoEnv);
eq("echoing the same tags back is not an edit", echoed.byKind.tag.edited, 1);
eq("but changing them is", echoed.byKind.tag.approved, 2);
eq("no stats, no mapping", learnedRealm(null, "newsletter", "INSPO"), null);
eq("a rejection teaches no mapping", learnedRealm(summarize(kindCounters(0, 9)), "propose", "INSPO"), null);

// ---------------------------------------------------------------- scoring
const proposal = { kind: "tag", source: "propose", realm: "INSPO", axis: "set-design", confidence: 0.6 };

const cold = scoreProposalWith(proposal, summarize({}));
eq("night one changes nothing", cold.confidence, 0.6);
eq("and says so", cold.learn.applied, false);
eq("a broken stats object changes nothing either", scoreProposalWith(proposal, { ok: false, error: "KV down" }).confidence, 0.6);
ok("but names the failure", scoreProposalWith(proposal, { ok: false, error: "KV down" }).learn.reasons[0].includes("KV down"));

const twoSwipes = scoreProposalWith(proposal, summarize(kindCounters(2, 0)));
eq("two approvals is not a mandate", twoSwipes.confidence, 0.6);
ok("though the evidence is still shown", twoSwipes.learn.evidence[0].n === 2);
ok("and named as unsettled", twoSwipes.learn.reasons.some((r) => r.includes("too close to call")));

const liked = scoreProposalWith(proposal, summarize(kindCounters(18, 2)));
const disliked = scoreProposalWith(proposal, summarize(kindCounters(2, 18)));
ok("a generator he takes gets more rope", liked.confidence > 0.6);
ok("a generator he rejects gets less", disliked.confidence < 0.6);
ok("the move is explained", liked.learn.reasons.some((r) => r.includes("18/20")));
eq("scoring never mutates the proposal", proposal.confidence, 0.6);
ok("nothing exceeds the cap", Math.abs(liked.learn.delta) <= MAX_DELTA);
ok("and confidence stays in range", liked.confidence <= 0.95 && disliked.confidence >= 0.05);

// Monotonic in the acceptance rate: more yeses can never mean less confidence.
let prev = -1;
let monotone = true;
for (let approved = 0; approved <= 20; approved++) {
  const c = scoreProposalWith(proposal, summarize(kindCounters(approved, 20 - approved))).confidence;
  if (c < prev) monotone = false;
  prev = c;
}
ok("scoring is monotonic in the acceptance rate", monotone);
ok("and the ends are genuinely apart", liked.confidence - disliked.confidence > 0.15);

// Evidence stacks across dimensions, but the cap holds.
const everywhere = summarize({
  v: 1,
  kind: { tag: { approved: 30, rejected: 2 } },
  source: { propose: { approved: 30, rejected: 2 } },
  axis: { "set-design": { approved: 30, rejected: 2 } },
  realm: { INSPO: { approved: 30, rejected: 2 } },
});
const stacked = scoreProposalWith(proposal, everywhere);
eq("four agreeing dimensions all get counted", stacked.learn.evidence.length, 4);
ok("but the total move is capped", stacked.learn.delta <= MAX_DELTA);
ok("and the cap is disclosed", stacked.learn.reasons.some((r) => r.includes("capped")) || stacked.learn.delta < MAX_DELTA);

// A learned mapping rides along as a suggestion — it never rewrites the realm.
const suggesting = scoreProposalWith(
  { kind: "realm", source: "newsletter", realm: "INSPO", confidence: 0.5 },
  editStats
);
eq("the realm we proposed is untouched", suggesting.realm, "INSPO");
eq("the learned answer is offered, not applied", suggesting.learn.suggestedRealm.to, "KNOWLEDGE");
ok("and it says how often", suggesting.learn.reasons.some((r) => r.includes("6/6")));

// The env half is the pure half plus one read.
const viaEnv = await scoreProposal(env, { kind: "tag", source: "propose", confidence: 0.6 });
eq("scoring through env agrees with scoring through stats",
  viaEnv.confidence,
  scoreProposalWith({ kind: "tag", source: "propose", confidence: 0.6 }, await acceptance(env)).confidence);

ok("MIN_SAMPLE is a real threshold", MIN_SAMPLE > 1 && MOVE_MIN_SAMPLE > 1);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
