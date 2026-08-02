// Pure-logic tests for categorize.js — run with `node test/categorize.test.mjs`.
// No deps, no network: just asserts the bucketing rules hold.
import { categorize, parseUrl, ALL_CATEGORIES } from "../src/categorize.js";

let pass = 0, fail = 0;
function eq(label, got, want) {
  if (got === want) { pass++; }
  else { fail++; console.error(`✗ ${label}\n   got:  ${got}\n   want: ${want}`); }
}

// URL parsing
eq("bare host gets scheme", parseUrl("example.com/x")?.protocol, "https:");
eq("rejects non-url", parseUrl("just a note"), null);
eq("rejects javascript:", parseUrl("javascript:alert(1)"), null);

// host-based categories
eq("youtube -> video", categorize({ url: "https://youtube.com/watch?v=1" }).category, "video");
eq("youtu.be -> video", categorize({ url: "https://youtu.be/abc" }).category, "video");
eq("x.com -> post", categorize({ url: "https://x.com/u/status/1" }).category, "post");
eq("twitter -> post", categorize({ url: "https://twitter.com/u" }).category, "post");
eq("instagram -> post", categorize({ url: "https://www.instagram.com/p/abc" }).category, "post");
eq("github -> code", categorize({ url: "https://github.com/a/b" }).category, "code");
eq("pinterest -> image", categorize({ url: "https://pinterest.com/pin/1" }).category, "image");
eq("ssense -> shop", categorize({ url: "https://www.ssense.com/x" }).category, "shop");
eq("substack -> article", categorize({ url: "https://foo.substack.com/p/x" }).category, "article");
eq("unknown host -> link", categorize({ url: "https://some-random-blog.io/post" }).category, "link");

// extension-based categories win on path
eq("image url -> image", categorize({ url: "https://cdn.x.com/a.JPG" }).category, "image");
eq("pdf url -> document", categorize({ url: "https://x.com/a.pdf" }).category, "document");
eq("mp4 url -> video", categorize({ url: "https://x.com/a.mp4" }).category, "video");

// host normalization + tags
const gh = categorize({ url: "https://www.github.com/a" });
eq("host strips www", gh.host, "github.com");
eq("tags include host", gh.tags.includes("github.com"), true);

// uploads
eq("blob defaults to image", categorize({ isBlob: true }).category, "image");
eq("png filename -> image", categorize({ isBlob: true, filename: "shot.png" }).category, "image");
eq("mov filename -> video", categorize({ isBlob: true, filename: "clip.mov" }).category, "video");
eq("content-type pdf -> document", categorize({ isBlob: true, contentType: "application/pdf" }).category, "document");
eq("blob kind", categorize({ isBlob: true }).kind, "blob");

// notes
eq("plain text -> note", categorize({ text: "remember this idea" }).category, "note");
eq("note kind", categorize({ text: "x" }).kind, "note");

// sanity
eq("categories list present", ALL_CATEGORIES.includes("image"), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
