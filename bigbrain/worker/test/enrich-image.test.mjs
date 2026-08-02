// Thumbnail recovery: the choice logic (pure) and the enrichment pass around it.
// globalThis.fetch is stubbed, so this runs offline and counts requests — "did
// we even ask?" is half of what these tests are checking.
// Run: node test/enrich-image.test.mjs
import {
  pickImage,
  isBlobImage,
  youtubeThumb,
  recoverImage,
  backfillImages,
  enrichRef,
  IMAGE_BLOCKERS,
} from "../src/enrich.js";

let pass = 0, fail = 0;
function ok(label, cond) { cond ? pass++ : (fail++, console.error("✗ " + label)); }
function eq(label, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}

// ---- offline fetch, with a call log so we can assert we stayed off the wire --
let calls = [];
function stubFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    return handler(String(url), opts);
  };
}
const html = (head, body = "") =>
  new Response(`<html><head>${head}</head><body>${body}</body></html>`, {
    headers: { "content-type": "text/html" },
  });

function makeKV() {
  const store = new Map();
  return {
    async get(name, type) {
      const e = store.get(name);
      if (!e) return null;
      return type === "json" ? JSON.parse(e) : e;
    },
    async put(name, value) { store.set(name, value); },
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

// ------------------------------------------------------------------ pickImage
eq("takes the og:image", pickImage({ metaImage: "https://cdn.test/a.jpg" }).image, "https://cdn.test/a.jpg");
eq("and labels where it came from", pickImage({ metaImage: "https://cdn.test/a.jpg" }).reason, "og");
eq(
  "resolves a protocol-relative og:image",
  pickImage({ metaImage: "//cdn.test/a.jpg", host: "mag.test" }).image,
  "https://cdn.test/a.jpg"
);
eq(
  "resolves a root-relative og:image",
  pickImage({ metaImage: "/img/a.jpg", host: "mag.test" }).image,
  "https://mag.test/img/a.jpg"
);
eq("relative with no host is unusable", pickImage({ metaImage: "/img/a.jpg" }).image, null);
eq("refuses a data uri", pickImage({ metaImage: "data:image/png;base64,AAAA", host: "mag.test" }).image, null);
eq("says the tag was unusable", pickImage({ metaImage: "data:image/png;base64,AAAA", host: "mag.test" }).reason, "unusable");
eq("refuses javascript:", pickImage({ metaImage: "javascript:alert(1)", host: "mag.test" }).image, null);

// The whole point of the existing check: never clobber what's already there.
eq(
  "an existing image is never replaced",
  pickImage({ metaImage: "https://cdn.test/new.jpg", existing: "https://cdn.test/old.jpg" }).image,
  null
);
eq(
  "and says it kept the existing one",
  pickImage({ metaImage: "https://cdn.test/new.jpg", existing: "https://cdn.test/old.jpg" }).reason,
  "existing"
);
eq(
  "a blob-backed image outranks any scrape",
  pickImage({ metaImage: "https://cdn.test/new.jpg", existing: "https://w.workers.dev/blob/abc123" }).reason,
  "blob"
);

eq("a known blocker is named as such", pickImage({ host: "instagram.com" }).reason, "blocked");
eq("www. of a blocker still counts", pickImage({ host: "www.tiktok.com" }).reason, "blocked");
eq("a subdomain of a blocker counts", pickImage({ host: "vm.tiktok.com" }).reason, "blocked");
eq("an ordinary miss is just a miss", pickImage({ host: "mag.test" }).reason, "none");
eq("no arguments at all is safe", pickImage().image, null);
ok("instagram and tiktok are on the list", IMAGE_BLOCKERS.includes("instagram.com") && IMAGE_BLOCKERS.includes("tiktok.com"));

// --------------------------------------------------------------- blob / video
ok("spots a blob url", isBlobImage("https://save-ref.workers.dev/blob/abc123"));
ok("a cdn url is not a blob", !isBlobImage("https://cdn.test/blobfish.jpg"));
ok("garbage is not a blob", !isBlobImage(null) && !isBlobImage(""));

ok("youtube still is derived from the id", youtubeThumb("https://youtu.be/dQw4w9WgXcQ").includes("dQw4w9WgXcQ"));
eq("non-youtube gets nothing", youtubeThumb("https://vimeo.com/1"), "");

// --------------------------------------------------------- recovery: the wire
// og:image recovered on a plain url ref, and the text pass still runs.
stubFetch(() =>
  html(
    `<title>Chrome tailoring</title><meta property="og:image" content="https://cdn.test/a.jpg">`,
    `<p>${"A sharp shoulder in polished steel. ".repeat(12)}</p>`
  )
);
const article = { id: "1", kind: "url", category: "article", url: "https://mag.test/a", host: "mag.test", image: "" };
const p1 = await enrichRef({}, article);
eq("og:image is recovered", p1.image, "https://cdn.test/a.jpg");
eq("the attempt is recorded", p1.imageTried, true);
ok("the text pass still ran", (p1.body || "").includes("polished steel"));
eq("recovering an image counts as enrichment", typeof p1.enrichedAt, "string");
eq("the ref itself is not mutated", article.image, "");

// A ref that already has an image is left alone — and never even asked about.
stubFetch(() => html(`<meta property="og:image" content="https://cdn.test/new.jpg">`));
const kept = { id: "2", kind: "url", category: "link", url: "https://mag.test/b", host: "mag.test", image: "https://cdn.test/old.jpg" };
const p2 = await recoverImage(kept);
eq("an existing image is not clobbered", p2.image, undefined);
eq("nothing to patch at all", Object.keys(p2).length, 0);
eq("and we didn't waste a request", calls.length, 0);

// Blob refs: the uploaded bytes are the ref, so nothing may overwrite them.
stubFetch(() => html(`<meta property="og:image" content="https://cdn.test/new.jpg">`));
const blob = {
  id: "3", kind: "blob", category: "image", blobKey: "abc123",
  image: "https://save-ref.workers.dev/blob/abc123", url: "https://mag.test/c",
};
const p3 = await enrichRef({}, blob);
eq("a blob ref keeps its own image", p3.image, undefined);
eq("a blob ref is not marked tried either", p3.imageTried, undefined);
eq("blob image survives untouched", blob.image, "https://save-ref.workers.dev/blob/abc123");

// Instagram-style block: fetch throws, and the ref must come back usable.
stubFetch(() => { throw new Error("login wall"); });
const ig = { id: "4", kind: "url", category: "post", url: "https://www.instagram.com/p/ABC/", host: "instagram.com", image: "" };
const p4 = await enrichRef({}, ig);
eq("no image is invented on failure", p4.image, undefined);
eq("imageTried is set on failure", p4.imageTried, true);
eq("the miss is explained, not swallowed", p4.imageWhy, "blocked");
eq("a failed pass is not stamped enriched", p4.enrichedAt, undefined);
ok("enrichRef still returned a patch object", p4 && typeof p4 === "object");

// A page that simply has no og:image is a different reason from a block.
stubFetch(() => html(`<title>Nothing here</title>`));
const bare = await recoverImage({ url: "https://mag.test/d", host: "mag.test" });
eq("no og:image at all", bare.image, undefined);
eq("and it says so plainly", bare.imageWhy, "none");

// A non-html response (pdf, image, 404 body) must not become a thumbnail.
stubFetch(() => new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } }));
const pdf = await recoverImage({ url: "https://mag.test/e.pdf", host: "mag.test" });
eq("a pdf yields no image", pdf.image, undefined);
eq("but is still marked tried", pdf.imageTried, true);

// imageTried is a stop sign: a later pass must not retry forever.
stubFetch(() => html(`<meta property="og:image" content="https://cdn.test/x.jpg">`));
const tried = { url: "https://www.instagram.com/p/ABC/", host: "instagram.com", image: "", imageTried: true, imageWhy: "blocked" };
const skip = await recoverImage(tried);
eq("a ref already tried is skipped", Object.keys(skip).length, 0);
eq("and costs no request", calls.length, 0);
const forced = await recoverImage(tried, { retry: true });
eq("retry overrides the stop sign", forced.image, "https://cdn.test/x.jpg");
eq("a win clears the stale reason", forced.imageWhy, "");

// YouTube is tier 0 — the still is derivable, so we never hit the network.
stubFetch(() => { throw new Error("should not be called"); });
const yt = await recoverImage({ url: "https://youtu.be/dQw4w9WgXcQ", host: "youtu.be", image: "" });
ok("youtube ref gets a still", (yt.image || "").includes("dQw4w9WgXcQ"));
eq("without a single request", calls.length, 0);

// Refs with nothing to work from.
eq("no url, nothing to do", Object.keys(await recoverImage({ id: "x", text: "a note" })).length, 0);
eq("no ref, nothing to do", Object.keys(await recoverImage(null)).length, 0);

// ------------------------------------------------------------- backfill walk
stubFetch(() => html(`<meta property="og:image" content="https://cdn.test/found.jpg">`));
const kv = makeKV();
await kv.put("ref:1", JSON.stringify({ id: "1", url: "https://mag.test/1", host: "mag.test", image: "" }));
await kv.put("ref:2", JSON.stringify({ id: "2", url: "https://mag.test/2", host: "mag.test", image: "https://cdn.test/have.jpg" }));
await kv.put("ref:3", JSON.stringify({ id: "3", category: "note", text: "no url here" }));
const walk = await backfillImages({ REFS_KV: kv }, { batch: 100 });
eq("backfill ok", walk.ok, true);
eq("scans everything", walk.scanned, 3);
eq("fixes the one that needed it", walk.updated, 1);
eq("leaves the other two alone", walk.skipped, 2);
eq("walk reports completion", walk.done, true);
eq("counts the reasons", walk.why.og, 1);
eq("the image is written back", (await kv.get("ref:1", "json")).image, "https://cdn.test/found.jpg");
eq("an existing image survives the walk", (await kv.get("ref:2", "json")).image, "https://cdn.test/have.jpg");

// Running it twice is cheap and changes nothing — imageTried holds the line.
const again = await backfillImages({ REFS_KV: kv }, { batch: 100 });
eq("a second walk updates nothing", again.updated, 0);
eq("because everything is skipped", again.skipped, 3);

// A dead KV is not an empty archive.
const brokenList = { REFS_KV: { async list() { throw new Error("KV down"); } } };
const dead = await backfillImages(brokenList, {});
eq("a failed list is not ok", dead.ok, false);
ok("and it names the failure", dead.errors[0].includes("KV down"));

// One unreadable ref must not silently shrink the batch.
const flaky = makeKV();
await flaky.put("ref:a", JSON.stringify({ id: "a", url: "https://mag.test/a", host: "mag.test", image: "" }));
await flaky.put("ref:b", JSON.stringify({ id: "b", url: "https://mag.test/b", host: "mag.test", image: "" }));
const flakyEnv = {
  REFS_KV: {
    ...flaky,
    async get(name, type) {
      if (name === "ref:b") throw new Error("read error");
      return flaky.get(name, type);
    },
  },
};
const partial = await backfillImages(flakyEnv, { batch: 100 });
eq("the good ref still lands", partial.updated, 1);
eq("one error per bad ref", partial.errors.length, 1);
ok("the error names the key", partial.errors[0].includes("ref:b"));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
