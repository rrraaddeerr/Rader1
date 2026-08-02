// Tests for the Archivist layer: realm classification, the staging queue and
// the cost governor. Pure logic plus a Map-backed KV — no network, no models.
// Run: node test/archivist.test.mjs
import {
  classify,
  titleFor,
  axisFor,
  normalizeHandle,
  instagramShortcode,
  summarize,
  REALMS,
} from "../src/realm.js";
import * as queue from "../src/stage.js";
import { charge, quote, ledger, estimate, dayStamp, DEFAULT_CEILING_USD } from "../src/budget.js";

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
  };
}

// ---------------------------------------------------------------- handles
eq("handle from @form", normalizeHandle("@welcome.jpeg"), "welcome.jpeg");
eq("handle from profile url", normalizeHandle("https://www.instagram.com/software2050"), "software2050");
eq("post url is not a handle", normalizeHandle("https://www.instagram.com/p/DbJsAVTkQGk/"), "");
eq("rejects spaces", normalizeHandle("not a handle"), "");
eq("empty in, empty out", normalizeHandle(""), "");

eq("shortcode from /p/", instagramShortcode("https://www.instagram.com/p/DbJsAVTkQGk/"), "DbJsAVTkQGk");
eq("shortcode with query", instagramShortcode("https://www.instagram.com/p/DbJiPYLlQrT/?img_index=13"), "DbJiPYLlQrT");
eq("shortcode from /reel/", instagramShortcode("https://www.instagram.com/reel/ABC-123_x/"), "ABC-123_x");
eq("non-instagram url", instagramShortcode("https://vimeo.com/12345"), null);

// ------------------------------------------------------------------ axes
eq("curator maps to its axis", axisFor({ handle: "welcome.jpeg" }).axis, "weird-beautiful-objects");
ok("curator is high confidence", axisFor({ handle: "software2050" }).confidence >= 0.9);
eq("text anchor finds set design", axisFor({ text: "Gary Card window display" }).axis, "set-design");
eq("no signal is honest", axisFor({ handle: "", text: "" }), null);

// -------------------------------------------------------------- classify
// Type is populated on every row in Notion, so realm is free for all 1,570.
eq("Design Reference -> INSPO", classify({ type: "Design Reference" }).realm, "INSPO");
eq("AI -> KNOWLEDGE", classify({ type: "AI" }).realm, "KNOWLEDGE");
eq("News -> CULTURE+NEWS", classify({ type: "News" }).realm, "CULTURE+NEWS");
ok("all realms are known", REALMS.includes(classify({ type: "News" }).realm));
eq("everything is tier 0", classify({ type: "News" }).tier, 0);

const newsletter = classify({
  type: "News",
  name: "Stop guessing whether a cheaper model can do the job",
  notes: "Substack · Nate's Substack · 2026-07-27",
});
eq("an AI newsletter is KNOWLEDGE, not news", newsletter.realm, "KNOWLEDGE");
ok("and it says why", newsletter.why.includes("knowledge source"));

const pub = classify({ type: "News", name: "032c on the new Balenciaga", notes: "" });
eq("a taste publication is reference", pub.realm, "INSPO");

const curated = classify({
  type: "Design Reference",
  handle: "trashcanpaul",
  name: "Instagram",
  url: "https://www.instagram.com/p/ABC/",
});
eq("curator overrides the coarse Type", curated.realm, "CULTURE+NEWS");
eq("curator sets the axis", curated.axis, "internet-humor");
ok("curator tags come from the existing vocabulary", curated.tags.includes("Off-topic"));
// SELF is never guessed — nothing can infer what's personal to him.
ok("SELF is never inferred", ![
  classify({ type: "Design Reference", handle: "trashcanpaul" }),
  classify({ type: "News" }),
  classify({ type: "AI" }),
  classify({ type: "Design Reference", handle: "welcome.jpeg" }),
].some((r) => r.realm === "SELF"));

// The 83 nameless rows: no title, no notes, no handle = low confidence.
const bare = classify({ type: "Design Reference", name: "Instagram", url: "https://www.instagram.com/p/XYZ/" });
ok("a bare Instagram row is low confidence", bare.confidence <= 0.35);
ok("and it is flagged for help", bare.needsHelp);
// The same row WITH a recovered handle is confident.
const recovered = classify({ type: "Design Reference", name: "Instagram", handle: "noeloquence" });
ok("recovering the handle rescues it", recovered.confidence >= 0.9 && !recovered.needsHelp);

// -------------------------------------------------------------- retitling
eq(
  "bare row gets handle + shortcode",
  titleFor({ name: "Instagram", url: "https://www.instagram.com/p/DbJsAVTkQGk/" }, "welcome.jpeg"),
  "@welcome.jpeg · DbJsAVTkQGk"
);
eq(
  "no handle still beats 'Instagram'",
  titleFor({ name: "Instagram", url: "https://www.instagram.com/p/DbJsAVTkQGk/" }, ""),
  "Instagram · DbJsAVTkQGk"
);
eq("a real title is left alone", titleFor({ name: "War in Iran (Part 1 of 6)" }, "x"), "War in Iran (Part 1 of 6)");

const sum = summarize([classify({ type: "News" }), classify({ type: "AI" }), bare]);
eq("summary counts everything", sum.total, 3);
eq("summary counts the ones needing help", sum.needsHelp, 1);

// ------------------------------------------------------------------ queue
const env = { REFS_KV: makeKV() };

const p1 = await queue.propose(env, {
  source: "ig-join",
  proposals: [
    { url: "https://insta/1", currentTitle: "Instagram", proposedTitle: "@welcome.jpeg · 1", realm: "INSPO", tags: ["Furniture"], confidence: 0.9, why: "curator" },
    { url: "https://insta/2", currentTitle: "Instagram", proposedTitle: "@noeloquence · 2", realm: "INSPO", tags: [], confidence: 0.9, why: "curator" },
    { url: "", currentTitle: "no target", proposedTitle: "x", realm: "INSPO" },
    { url: "https://insta/3", currentTitle: "same", proposedTitle: "same" },
  ],
});
eq("queues the real proposals", p1.queued, 2);
eq("skips targetless and no-op proposals", p1.skipped, 2);

const again = await queue.propose(env, {
  proposals: [{ url: "https://insta/1", currentTitle: "Instagram", proposedTitle: "dupe", realm: "INSPO" }],
});
eq("re-running a mining job does not duplicate", again.queued, 0);

const feed = await queue.list(env, { limit: 10 });
eq("feed returns pending items", feed.items.length, 2);
eq("items start pending", feed.items[0].status, "pending");
ok("proposal payload survives", feed.items[0].proposal.realm === "INSPO");

const first = feed.items[0];
const yes = await queue.decide(env, first.id, { action: "approve", edits: { realm: "KNOWLEDGE" } });
eq("approve works", yes.ok, true);
eq("approving applies your edit", yes.item.proposal.realm, "KNOWLEDGE");
eq("approved is not applied", yes.item.applied, false);

const counts = await queue.stats(env);
eq("one approved", counts.approved, 1);
eq("one still pending", counts.pending, 1);

const reopened = await queue.decide(env, first.id, { action: "reopen" });
eq("undo puts it back", reopened.item.status, "pending");
await queue.decide(env, first.id, { action: "approve" });

eq("bad action is refused", (await queue.decide(env, first.id, { action: "delete" })).ok, false);
eq("unknown id is refused", (await queue.decide(env, "nope", { action: "approve" })).ok, false);

const ready = await queue.approved(env);
eq("approved export has one item", ready.length, 1);
ok("export carries the target url", ready[0].url === "https://insta/1");
await queue.markApplied(env, [ready[0].queueId]);
eq("applied items drop out of the export", (await queue.approved(env)).length, 0);

// ----------------------------------------------------------------- budget
const benv = { REFS_KV: makeKV() };
eq("tier 0 is free", estimate(0, 10_000), 0);
ok("tier 3 is not free", estimate(3, 10) > 0);
eq("day stamp is a date", dayStamp(new Date("2026-07-28T09:00:00Z")), "2026-07-28");

const q0 = await quote(benv, { tier: 3, units: 10 });
eq("nothing spent yet", q0.spentToday, 0);
eq("ceiling is the comfort ceiling", q0.ceiling, DEFAULT_CEILING_USD);
ok("a small job fits", q0.fits);

const c1 = await charge(benv, { tier: 3, units: 10, label: "digest" });
eq("charge succeeds", c1.ok, true);
ok("ledger moved", c1.usd > 0);

// The whole point: a runaway batch is refused, not invoiced.
const huge = await charge(benv, { tier: 3, units: 100_000 });
eq("a runaway job is refused", huge.ok, false);
ok("and it says why", huge.reason.includes("ceiling"));
eq("refusal does not spend", (await ledger(benv)).usd, c1.usd);

// Vision is rationed by count as well as cost.
const v1 = await charge(benv, { tier: 3, units: 20, vision: true });
eq("vision within ration is allowed", v1.ok, true);
const v2 = await charge(benv, { tier: 2, units: 1, vision: true });
eq("vision past the ration is refused", v2.ok, false);
ok("vision refusal names the ration", v2.reason.includes("vision ration"));

// Free tiers are never blocked — deterministic work should always run.
const bulk = await charge(benv, { tier: 0, units: 1_000_000 });
eq("tier 0 always runs", bulk.ok, true);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
