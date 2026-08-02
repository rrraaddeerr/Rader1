// Pure-logic tests for the brain: content extraction, embedding text, and the
// context/JSON handling around the model. No deps, no network, no bindings —
// everything here is a plain function. Run: node test/brain.test.mjs
import {
  htmlToText,
  decodeEntities,
  youtubeId,
  captionTrackUrl,
  parseTranscriptXml,
} from "../src/enrich.js";
import { embedTextFor, brainReady } from "../src/embed.js";
import { buildContext, sourceOf, parseJsonish, callCheap, CHEAP_MODELS } from "../src/ask.js";

let pass = 0, fail = 0;
function ok(label, cond) { cond ? pass++ : (fail++, console.error("✗ " + label)); }
function eq(label, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}

// ---- entities ----
eq("decodes named entities", decodeEntities("Dolce &amp; Gabbana"), "Dolce & Gabbana");
eq("decodes numeric entities", decodeEntities("caf&#233;"), "café");
eq("decodes hex entities", decodeEntities("caf&#xe9;"), "café");
eq("leaves plain text alone", decodeEntities("plain"), "plain");

// ---- html -> text ----
const page = `
<html><head><title>T</title><style>.a{color:red}</style></head>
<body>
  <nav>Home About Contact</nav>
  <script>var tracking=1;</script>
  <h1>Chrome tailoring</h1>
  <p>A sharp shoulder in polished steel &amp; wool.</p>
  <p>Second paragraph.</p>
  <footer>© 2026</footer>
</body></html>`;
const text = htmlToText(page);
ok("keeps heading", text.includes("Chrome tailoring"));
ok("keeps body copy", text.includes("polished steel & wool"));
ok("drops <script> contents", !text.includes("tracking"));
ok("drops <style> contents", !text.includes("color:red"));
ok("drops nav chrome", !text.includes("Home About Contact"));
ok("drops footer chrome", !text.includes("2026"));
ok("paragraphs stay separated", /wool\.\s*\n\s*Second/.test(text));
eq("empty in, empty out", htmlToText(""), "");
eq("non-string in, empty out", htmlToText(null), "");
ok("respects the char limit", htmlToText("<p>" + "x".repeat(500) + "</p>", 100).length <= 101);

// ---- youtube ----
eq("watch url", youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
eq("short url", youtubeId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
eq("shorts url", youtubeId("https://www.youtube.com/shorts/abc123"), "abc123");
eq("embed url", youtubeId("https://youtube.com/embed/abc123?start=1"), "abc123");
eq("not youtube", youtubeId("https://vimeo.com/12345"), null);
eq("not a url", youtubeId("hello"), null);

eq(
  "finds the caption track",
  captionTrackUrl('x"captionTracks":[{"baseUrl":"https://yt.test/a?x=1\\u0026y=2","languageCode":"en"}]y'),
  "https://yt.test/a?x=1&y=2"
);
eq(
  "prefers an english track",
  captionTrackUrl('"captionTracks":[{"baseUrl":"https://yt.test/fr","languageCode":"fr"},{"baseUrl":"https://yt.test/en","languageCode":"en"}]'),
  "https://yt.test/en"
);
eq("no tracks -> null", captionTrackUrl("<html>nothing</html>"), null);
eq("garbage -> null", captionTrackUrl(null), null);

eq(
  "flattens transcript xml",
  parseTranscriptXml('<transcript><text start="0">so the</text><text start="1">jacket is &amp;</text></transcript>'),
  "so the jacket is &"
);
eq("empty transcript", parseTranscriptXml(""), "");

// ---- embedding text ----
const ref = {
  id: "1",
  title: "Chrome tailoring",
  caption: "A steel-grey suit under sodium light",
  desc: "og description",
  tags: ["chrome", "tailoring"],
  category: "image",
  host: "instagram.com",
  body: "long page text",
};
const et = embedTextFor(ref);
ok("title leads the embedding", et.startsWith("Chrome tailoring"));
ok("caption is included", et.includes("steel-grey suit"));
ok("tags are labelled", et.includes("Tags: chrome, tailoring"));
ok("category is labelled", et.includes("Category: image"));
ok("body is included", et.includes("long page text"));
eq("empty ref -> empty", embedTextFor(null), "");
eq("blank ref -> empty", embedTextFor({}), "");

// ---- readiness flags ----
eq("brain off without bindings", brainReady({}), false);
eq("brain off with only AI", brainReady({ AI: {} }), false);
eq("brain on with both", brainReady({ AI: {}, VECTORS: {} }), true);

// ---- context building ----
const refs = [
  { id: "a", title: "One", host: "x.com", url: "https://x.com/1", category: "post", tags: ["a"], desc: "first" },
  { id: "b", title: "Two", category: "note", text: "second" },
];
const ctx = buildContext(refs);
ok("numbers the refs", ctx.includes("[1] One") && ctx.includes("[2] Two"));
ok("includes the url", ctx.includes("https://x.com/1"));
ok("includes the tags", ctx.includes("tags: a"));
ok("includes the content", ctx.includes("first") && ctx.includes("second"));

const tight = buildContext(refs, { budget: 60 });
ok("stops at the budget", tight.length <= 200 && tight.includes("[1]"));
eq("no refs -> empty context", buildContext([]), "");

const src = sourceOf(refs[0], 0);
eq("source is 1-indexed", src.n, 1);
eq("source keeps the url", src.url, "https://x.com/1");
eq("source falls back to host for title", sourceOf({ host: "y.com" }, 1).title, "y.com");

// ---- model output parsing ----
eq("parses bare json", parseJsonish('{"a":1}').a, 1);
eq("parses fenced json", parseJsonish('```json\n{"a":2}\n```').a, 2);
eq("parses json after chatter", parseJsonish('Sure! Here you go:\n{"a":3}\nHope that helps').a, 3);
eq("nested objects survive", parseJsonish('{"a":{"b":[1,2]}}').a.b.length, 2);
eq("no json -> null", parseJsonish("just prose"), null);
eq("broken json -> null", parseJsonish("{not json}"), null);
eq("empty -> null", parseJsonish(""), null);
eq("non-string -> null", parseJsonish(null), null);

// ---- chat model fallback ----
// Workers AI model ids get renamed; one bad id must not look like "no model".
const tried = [];
const flakyAI = {
  async run(model) {
    tried.push(model);
    if (model === CHEAP_MODELS[0]) throw new Error("No such model");
    if (model === CHEAP_MODELS[1]) return { response: "   " }; // empty
    return { response: "an answer" };
  },
};
const fell = await callCheap({ AI: flakyAI }, { system: "s", user: "u" });
eq("falls past a dead model id", fell.text, "an answer");
eq("reports which model answered", fell.model, CHEAP_MODELS[2]);
eq("tried them in order", tried.length, 3);
ok("kept the failure reason", fell.errors[0].includes("No such model"));
ok("treats an empty response as a failure", fell.errors[1].includes("empty response"));

const noAI = await callCheap({}, { system: "s", user: "u" });
eq("no AI binding is explicit", noAI.text, null);
ok("and says so", noAI.errors[0].includes("AI binding missing"));

const allDead = await callCheap(
  { AI: { async run() { throw new Error("gone"); } } },
  { system: "s", user: "u" }
);
eq("all models dead -> null", allDead.text, null);
eq("one error per candidate", allDead.errors.length, CHEAP_MODELS.length);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
