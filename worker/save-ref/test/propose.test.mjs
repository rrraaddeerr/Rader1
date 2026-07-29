// Tests for the proposal generators — the things that fill the swipe queue.
// Map-backed KV and a stubbed fetch, so no network, no bindings, no models.
// Run: node test/propose.test.mjs
import {
  tagProposals,
  deadLinkProposals,
  lowConfidenceRealm,
  runProposalPass,
  refText,
  NOTION_TAGS,
  KINDS,
  DEAD_TITLE_PREFIX,
} from "../src/propose.js";
import * as queue from "../src/stage.js";
import { isMeaningful } from "../src/stage.js";

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

async function seed(env, refs) {
  for (const r of refs) await env.REFS_KV.put(`ref:${r.id}`, JSON.stringify(r));
}

// Stubbed link checks. Unknown urls are alive — the interesting cases are named.
const STATUS = {
  "https://alive.test/a": 200,
  "https://gone.test/404": 404,
  "https://gone.test/410": 410,
  "https://blocked.test/x": 403, // a bot-blocker is not a dead page
  "https://nohead.test/x": { HEAD: 405, GET: 404 },
};
let calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method });
  if (url === "https://boom.test/x") throw new Error("network unreachable");
  const s = STATUS[url] ?? 200;
  const status = typeof s === "object" ? s[opts.method] ?? 200 : s;
  return { status, body: null };
};

// ------------------------------------------------------------------- tags
const tagged = tagProposals({
  id: "r1",
  url: "https://insta/1",
  title: "Gary Card set design for the SS26 runway show — neon lightbox backdrop",
});
eq("a rich caption gets one proposal", tagged.length, 1);
ok("the strongest tag is there", tagged[0].tags.includes("Set"));
ok("and the second signal too", tagged[0].tags.includes("Lighting"));
ok("never more than three tags on a card", tagged[0].tags.length <= 3);
ok("every tag is in the Notion vocabulary", tagged[0].tags.every((t) => NOTION_TAGS.includes(t)));
ok("the reason names the matched term", /"set design"|"gary card"/.test(tagged[0].why));
ok("confidence is attached", tagged[0].confidence >= 0.6 && tagged[0].confidence <= 0.9);
eq("tagging is tier 0", tagged[0].tier, 0);
ok("a tag proposal is a real change", isMeaningful(tagged[0]));
ok("it points back at the ref", tagged[0].refId === "r1" && tagged[0].url === "https://insta/1");

// The common case, and the right answer: say nothing.
eq("a bare Instagram row suggests nothing", tagProposals({ id: "r2", title: "Instagram", url: "https://www.instagram.com/p/XYZ/" }).length, 0);
eq("an empty ref suggests nothing", tagProposals({ id: "r3" }).length, 0);
eq("no ref at all is not a crash", tagProposals(null).length, 0);

// Word-boundary matching: these are the false positives that kill a queue.
eq("'sunset' is not Set", tagProposals({ id: "r4", title: "A sunset, wrapped in a cheap plastic bag" }).length, 0);
eq("'wrapped' is not Performance", tagProposals({ id: "r5", title: "wrapped and rewrapped" }).length, 0);

// Weak words only count in company.
eq("a weak word alone proposes nothing", tagProposals({ id: "r6", title: "a digital render of a room" }).length, 0);
const strong = tagProposals({ id: "r7", title: "a 3d render of a room" });
eq("but the compound term does", strong.length, 1);
ok("and it lands on Tech", strong[0].tags.includes("Tech"));

// Once he's approved and applied a tag, we stop asking about it.
eq(
  "a tag he already has is not proposed again",
  tagProposals({ id: "r8", title: "neon lightbox", tags: ["lighting"] }).length,
  0
);

// A curator handle carries his own vocabulary onto the card.
const curated = tagProposals({ id: "r9", title: "Instagram", handle: "software2050" });
eq("a curator handle is enough on its own", curated.length, 1);
ok("with the curator named in the reason", curated[0].why.includes("@software2050"));

ok("refText skips the scraped page body", !refText({ title: "T", body: "restaurant menu" }).includes("restaurant"));

// -------------------------------------------------------------- dead links
calls = [];
const linkRefs = [
  { id: "d1", url: "https://alive.test/a", title: "Still there" },
  { id: "d2", url: "https://gone.test/404", title: "Deleted post" },
  { id: "d3", url: "https://gone.test/410", title: "Gone for good" },
  { id: "d4", url: "https://blocked.test/x", title: "Blocks bots" },
  { id: "d5", url: "https://boom.test/x", title: "Times out" },
  { id: "d6", url: "https://nohead.test/x", title: "Refuses HEAD" },
  { id: "d7", title: "A note with no url" },
  { id: "d8", url: "https://gone.test/404", title: DEAD_TITLE_PREFIX + "Already flagged" },
];
const dead = await deadLinkProposals({}, linkRefs);
const deadUrls = dead.items.map((i) => i.url).sort();
eq("only the gone ones are flagged", dead.items.length, 3);
ok("404 is flagged", deadUrls.includes("https://gone.test/404"));
ok("410 is flagged", deadUrls.includes("https://gone.test/410"));
ok("a 405-on-HEAD is asked again with GET", deadUrls.includes("https://nohead.test/x"));
ok("a live link is left alone", !deadUrls.includes("https://alive.test/a"));
ok("a bot-blocker is not called dead", !deadUrls.includes("https://blocked.test/x"));
// The whole point of rule 4: a failure is never an empty result.
ok("a network failure is not a dead link", !deadUrls.includes("https://boom.test/x"));
eq("and it comes back as an error", dead.errors.length, 1);
ok("named by url", dead.errors[0].url === "https://boom.test/x");
ok("with the reason", dead.errors[0].error.includes("unreachable"));
eq("urls-only, already-flagged excluded", dead.checked, 6);
ok("nothing was fetched for the note", !calls.some((c) => c.url === undefined));

const flag = dead.items.find((i) => i.url === "https://gone.test/404");
ok("the flag rides on the title", flag.proposedTitle.startsWith(DEAD_TITLE_PREFIX));
ok("the old title survives on the card", flag.currentTitle === "Deleted post");
ok("the reason quotes the status", flag.why.includes("404"));
ok("a dead-link proposal is a real change", isMeaningful(flag));
eq("dead-link checking is tier 0", flag.tier, 0);

const none = await deadLinkProposals({}, []);
eq("no refs, no proposals", none.items.length, 0);
eq("and no invented errors", none.errors.length, 0);

// ------------------------------------------------------------------ realm
const help = lowConfidenceRealm({ id: "r10", title: "Instagram", url: "https://www.instagram.com/p/XYZ/" });
eq("an unsettleable ref is surfaced", help.length, 1);
ok("with a realm to say yes to", help[0].realm.length > 0);
ok("and a reason", help[0].why.includes("your call"));
ok("it proposes a better title for a nameless row", help[0].proposedTitle.includes("XYZ"));
eq(
  "a confident ref is not surfaced",
  lowConfidenceRealm({ id: "r11", type: "AI", title: "Stop guessing whether a cheaper model can do the job" }).length,
  0
);
eq("no ref at all is not a crash", lowConfidenceRealm(null).length, 0);

// ------------------------------------------------------------------- pass
const env = { REFS_KV: makeKV() };
await seed(env, [
  { id: "p1", title: "Gary Card set design, neon lightbox backdrop", url: "https://alive.test/a" },
  { id: "p2", title: "Deleted post", url: "https://gone.test/404" },
  { id: "p3", title: "Instagram", url: "https://www.instagram.com/p/XYZ/" },
  { id: "p4", title: "a 3d render of a room", url: "https://alive.test/a?4" },
  { id: "p5", title: "wrapped and rewrapped", url: "https://alive.test/a?5" },
]);

const run1 = await runProposalPass(env, { limit: 2 });
eq("the walk is bounded", run1.scanned, 2);
ok("and resumable", typeof run1.cursor === "string" && run1.cursor.length > 0);
eq("not done yet", run1.done, false);
eq("no generator produced a no-op", run1.dropped, 0);
eq("nothing was swallowed", run1.errors.length, 0);
ok("it queued something", run1.totalQueued > 0);

const run2 = await runProposalPass(env, { limit: 10, cursor: run1.cursor });
eq("the cursor picks up where it left off", run2.scanned, 3);
eq("and finishes", run2.done, true);
eq("the next cursor is null at the end", run2.cursor, null);

const feed = await queue.list(env, { limit: 50 });
const kindsSeen = new Set(feed.items.map((i) => i.kind));
ok("proposals actually land in the queue", feed.items.length > 0);
ok("tags landed", kindsSeen.has("tag"));
ok("dead links landed", kindsSeen.has("dead-link"));
ok("every kind is a known kind", [...kindsSeen].every((k) => KINDS.includes(k)));
ok("everything lands pending", feed.items.every((i) => i.status === "pending"));
ok("nothing was applied", feed.items.every((i) => !i.applied));
ok("the dead link is the question asked about p2", feed.items.some((i) => i.kind === "dead-link" && i.target === "https://gone.test/404"));

// Re-running a nightly job must not stack duplicates.
const before = feed.items.length;
const again1 = await runProposalPass(env, { limit: 2 });
const again2 = await runProposalPass(env, { limit: 10, cursor: again1.cursor });
eq("re-running queues nothing new (page 1)", again1.totalQueued, 0);
eq("re-running queues nothing new (page 2)", again2.totalQueued, 0);
ok("and stage.js says why", again1.skipped + again2.skipped > 0);
eq("the queue is the same size", (await queue.list(env, { limit: 50 })).items.length, before);

// A question he has answered is not asked again.
const decided = feed.items.find((i) => i.kind === "dead-link");
await queue.decide(env, decided.id, { action: "reject" });
const after = await runProposalPass(env, { limit: 10, kinds: ["dead-link"] });
eq("a rejected question is not re-asked", after.totalQueued, 0);
ok("and the pass says so", after.answered >= 1);

// Only the kinds you asked for run.
const tagOnly = await runProposalPass({ REFS_KV: makeKV() }, { limit: 5, kinds: ["tag"] });
eq("an empty archive scans nothing", tagOnly.scanned, 0);
eq("no links were checked", tagOnly.checked, 0);
eq("an unknown kind is refused", (await runProposalPass(env, { kinds: ["nonsense"] })).ok, false);

// Preview: see the whole pass before anything is queued.
const dryEnv = { REFS_KV: makeKV() };
await seed(dryEnv, [{ id: "q1", title: "Gary Card set design, neon lightbox backdrop" }]);
const dry = await runProposalPass(dryEnv, { limit: 10, kinds: ["tag"], dryRun: true });
eq("a dry run queues nothing", dry.totalQueued, 0);
ok("but hands back what it would ask", dry.proposals.tag.length > 0);
eq("and the queue is still empty", (await queue.list(dryEnv, { limit: 10 })).items.length, 0);

// A KV that throws must not look like an empty archive.
const brokenPass = await runProposalPass({ REFS_KV: { async list() { throw new Error("KV down"); }, async get() { return null; }, async put() {} } }, {});
eq("a broken KV is not an empty result", brokenPass.ok, false);
ok("and it says what broke", brokenPass.error.includes("KV down"));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
