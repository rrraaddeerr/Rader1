/**
 * Deep enrichment — turn a ref into text a model can actually learn from.
 *
 * The OG scrape in og.js gets you a title and a sentence. That's too thin to
 * search or reason over: a screenshot has no text at all, and an article's
 * og:description is marketing copy, not the argument. So before a ref is
 * embedded we go one level deeper, per kind:
 *
 *   image  -> vision caption (what is literally in the picture)
 *   article/post/shop/code -> readable body text of the page
 *   video  -> caption track (YouTube) if there is one, else title + channel
 *   note   -> already text, nothing to do
 *
 * A url ref also gets a thumbnail back. The Notion import carried no image
 * column, so most of the archive renders as a grey placeholder on /browse;
 * og:image is the cheapest possible fix. It runs alongside the text pass rather
 * than instead of it — a video wants a transcript *and* a still, and a page
 * whose body we couldn't read may still advertise a perfectly good picture.
 *
 * Everything here is best-effort. Any failure returns empty and the ref keeps
 * whatever it already had — enrichment must never lose you a save.
 *
 * The parsing functions are pure (no I/O) so they unit-test in plain node.
 */

import { fetchMeta } from "./og.js";
import { charge } from "./budget.js";

const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 1_500_000;

/** Hard cap on extracted body text. Embedding models truncate anyway, and KV
 *  values (and Vectorize metadata) should stay small. */
export const MAX_BODY_CHARS = 6000;

/** Workers AI models. Swap these in one place if you want different tradeoffs. */
export const VISION_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";

const VISION_PROMPT =
  "Describe this image for a fashion and production reference archive. " +
  "Name the garments, materials, silhouettes, colours, era, setting and overall mood. " +
  "Be concrete and specific. No preamble.";

const ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
  "&apos;": "'", "&#39;": "'", "&nbsp;": " ",
};

/** Decode the handful of HTML entities that actually show up in body text. */
export function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, d) => {
      const n = Number(d);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const n = parseInt(h, 16);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    });
}

/**
 * Strip HTML down to readable text.
 *
 * Not a real readability implementation — it drops the chrome (script, style,
 * nav, header, footer, aside) and keeps the rest, which is plenty for an
 * embedding. Block-level tags become newlines so paragraphs survive.
 */
export function htmlToText(html, limit = MAX_BODY_CHARS) {
  if (typeof html !== "string" || !html) return "";
  let s = html;

  // Drop whole subtrees that are never body content.
  s = s.replace(
    /<(script|style|noscript|svg|iframe|template|head|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " "
  );
  s = s.replace(/<!--[\s\S]*?-->/g, " ");

  // Preserve structure: block ends become newlines.
  s = s.replace(/<\/(p|div|section|article|li|h[1-6]|br|tr|blockquote)\s*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");

  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);

  // Collapse whitespace but keep paragraph breaks.
  s = s.replace(/[ \t\f\v ]+/g, " ");
  s = s.replace(/\s*\n\s*/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();

  return s.length > limit ? s.slice(0, limit).trimEnd() + "…" : s;
}

/** Extract a YouTube video id from any of its URL shapes. */
export function youtubeId(rawUrl) {
  if (typeof rawUrl !== "string") return null;
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "");
  if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
  if (!/(^|\.)youtube\.com$/.test(host)) return null;
  if (u.pathname === "/watch") return u.searchParams.get("v");
  const m = u.pathname.match(/^\/(?:embed|shorts|v|live)\/([^/?#]+)/);
  return m ? m[1] : null;
}

/**
 * Find the caption-track URL embedded in a YouTube watch page.
 * YouTube ships the track list as JSON inside the HTML; no API key needed.
 */
export function captionTrackUrl(watchHtml) {
  if (typeof watchHtml !== "string") return null;
  const block = watchHtml.match(/"captionTracks":\s*(\[[^\]]*\])/);
  if (!block) return null;
  let tracks;
  try {
    tracks = JSON.parse(block[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/"));
  } catch {
    return null;
  }
  if (!Array.isArray(tracks) || !tracks.length) return null;
  // Prefer a real English track over an auto-translated one, else take the first.
  const en = tracks.find((t) => typeof t?.languageCode === "string" && t.languageCode.startsWith("en"));
  const pick = en || tracks[0];
  return typeof pick?.baseUrl === "string" ? pick.baseUrl : null;
}

/** Turn YouTube's timedtext XML into flat prose. */
export function parseTranscriptXml(xml, limit = MAX_BODY_CHARS) {
  if (typeof xml !== "string" || !xml) return "";
  const lines = [...xml.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) =>
    decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
  );
  const out = lines.filter(Boolean).join(" ");
  return out.length > limit ? out.slice(0, limit).trimEnd() + "…" : out;
}

/** fetch() with a timeout and a byte cap, returning text. Never throws. */
async function fetchTextCapped(url, { accept = "text/html", maxBytes = MAX_HTML_BYTES } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; BigBrainBot/1.0; +https://bigbrain.ref)",
        Accept: accept,
      },
    });
    if (!res.ok || !res.body) return "";
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
    }
    try { await reader.cancel(); } catch {}
    let len = 0;
    for (const c of chunks) len += c.length;
    const buf = new Uint8Array(len);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    return new TextDecoder("utf-8").decode(buf);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** Readable body text for a page. "" on any failure. */
export async function fetchPageText(url) {
  const html = await fetchTextCapped(url);
  return htmlToText(html);
}

/** Caption track text for a video URL, if we can get one. "" otherwise. */
export async function fetchTranscript(url) {
  if (!youtubeId(url)) return "";
  const watch = await fetchTextCapped(url);
  const track = captionTrackUrl(watch);
  if (!track) return "";
  const xml = await fetchTextCapped(track, { accept: "text/xml" });
  return parseTranscriptXml(xml);
}

/**
 * Vision-caption an image with Workers AI.
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {Promise<string>} caption, or "" if AI isn't bound / the call fails
 */
export async function captionImage(env, bytes) {
  if (!env?.AI || !bytes) return "";
  try {
    const arr = [...new Uint8Array(bytes)];
    const res = await env.AI.run(VISION_MODEL, {
      image: arr,
      prompt: VISION_PROMPT,
      max_tokens: 320,
    });
    const text = typeof res === "string" ? res : res?.description ?? res?.response ?? "";
    return String(text).trim().slice(0, MAX_BODY_CHARS);
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------ thumbnails

/**
 * Hosts that hand a bot a login wall instead of a page. We still ask — a public
 * post sometimes leaks its preview — but a miss on one of these is expected
 * behaviour, not a bug worth chasing.
 */
export const IMAGE_BLOCKERS = [
  "instagram.com",
  "tiktok.com",
  "facebook.com",
  "threads.net",
  "x.com",
  "twitter.com",
];

function blocksBots(host) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  return IMAGE_BLOCKERS.some((b) => h === b || h.endsWith("." + b));
}

/**
 * A blob-backed image is the ref's own uploaded bytes, served straight back by
 * this Worker. It *is* the ref — nothing scraped off a page may replace it.
 */
export function isBlobImage(image) {
  return typeof image === "string" && /^https?:\/\/[^/]+\/blob\/[^/?#]+/.test(image);
}

/**
 * The one thumbnail we can know without asking anyone: YouTube's still is a
 * pure function of the video id, so a video ref costs zero requests.
 */
export function youtubeThumb(url) {
  const id = youtubeId(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : "";
}

/**
 * og:image in the wild is protocol-relative ("//cdn/x.jpg") about as often as
 * it is absolute, so resolve against the ref's own host. http(s) only: a data:
 * URI would be megabytes of base64 sat in KV, and a relative path we can't
 * resolve renders as a broken image, which looks worse than no image at all.
 */
function absoluteImageUrl(candidate, host) {
  const raw = String(candidate || "").trim();
  if (!raw) return "";
  try {
    const bare = String(host || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const u = new URL(raw, bare ? `https://${bare}/` : undefined);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString().slice(0, 1000);
  } catch {
    return "";
  }
}

/**
 * Decide what a ref's image should become. Pure — the whole policy lives here
 * so it tests without a network.
 *
 * `image` is null whenever the ref should be left exactly as it is, and
 * `reason` is always populated: "Instagram blocked us", "the page has no
 * og:image" and "we never looked, it already had one" are three different
 * answers, and a blank thumbnail on /browse should be explainable.
 *
 * @param {object}  opts
 * @param {string} [opts.metaImage] og:image we just scraped (may be relative)
 * @param {string} [opts.existing]  the image the ref already carries
 * @param {string} [opts.host]      the ref's host — resolves relative urls, and
 *                                  explains an expected miss
 * @returns {{image: string|null, reason: string}}
 */
export function pickImage({ metaImage = "", existing = "", host = "" } = {}) {
  if (isBlobImage(existing)) return { image: null, reason: "blob" };
  if (existing) return { image: null, reason: "existing" };

  const abs = absoluteImageUrl(metaImage, host);
  if (abs) return { image: abs, reason: "og" };

  // A tag we found but can't use is a different story from no tag at all.
  if (String(metaImage || "").trim()) return { image: null, reason: "unusable" };
  return { image: null, reason: blocksBots(host) ? "blocked" : "none" };
}

/**
 * Recover a thumbnail for a url ref.
 *
 * Tier 0 from top to bottom: deterministic where we can be, one page fetch
 * where we can't, and no model call ever — so there is nothing here for the
 * cost governor to meter.
 *
 * @param {object} ref
 * @param {object} [opts]
 * @param {boolean} [opts.retry] look again at a ref we have already tried
 * @returns {Promise<{image?:string, imageTried?:boolean, imageWhy?:string}>}
 */
export async function recoverImage(ref, { retry = false } = {}) {
  if (!ref?.url) return {};
  // Its own bytes outrank anything scraped, and a ref that already shows
  // something needs no request at all. pickImage enforces this again below;
  // this branch exists purely to keep us off the network.
  if (ref.blobKey || ref.image) return {};
  // One shot per ref. Instagram will block us again tomorrow, and 1,575 refs
  // is a lot of pointless fetching to repeat every pass.
  if (ref.imageTried && !retry) return {};

  const host = ref.host || hostOf(ref.url);

  let metaImage = youtubeThumb(ref.url); // free — no request at all
  let failure = "";
  if (!metaImage) {
    try {
      metaImage = (await fetchMeta(ref.url))?.image || "";
    } catch (err) {
      // A thrown fetch must never read as "this page has no image" — that
      // conflation is what makes a broken scraper look like a boring miss.
      failure = `fetch: ${String(err?.message ?? err).slice(0, 80)}`;
    }
  }

  const { image, reason } = pickImage({ metaImage, existing: ref.image, host });
  const patch = { imageTried: true };
  if (image) {
    patch.image = image;
    patch.imageWhy = ""; // clear a stale reason left by an earlier miss
  } else {
    patch.imageWhy = failure || reason;
  }
  return patch;
}

/** Host of a url, "" if it isn't one. */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Walk the archive and put a thumbnail on everything missing one.
 *
 * Deliberately separate from /api/reindex: an image is not part of a ref's
 * embedding text and not in its vector metadata, so this touches no model and
 * no index. It is free, and it shouldn't have to ride along with a deep pass
 * that isn't. Bounded like the reindex walk — one batch per call, cursor back —
 * so a big archive is walked in several requests instead of blowing the CPU
 * budget.
 *
 * @param {object} env
 * @param {object} [opts]
 * @param {string} [opts.cursor] KV cursor from the previous call
 * @param {number} [opts.batch]  refs per call, 1-100
 * @param {boolean} [opts.retry] re-examine refs already marked imageTried
 * @returns {Promise<{ok:boolean, scanned:number, updated:number, missed:number,
 *   skipped:number, why:object, cursor:string|null, done:boolean, errors:string[]}>}
 */
export async function backfillImages(env, { cursor, batch = 25, retry = false } = {}) {
  const limit = Math.min(Math.max(1, Number(batch) || 25), 100);
  const errors = [];
  const why = {}; // reason -> count, so a still-blank /browse is explainable
  let scanned = 0, updated = 0, missed = 0, skipped = 0;

  let page;
  try {
    page = await env.REFS_KV.list({ prefix: "ref:", limit, cursor });
  } catch (err) {
    // A failed list is not an empty archive. Say so, loudly.
    return {
      ok: false, scanned, updated, missed, skipped, why,
      cursor: cursor ?? null, done: false,
      errors: [`list: ${String(err?.message ?? err).slice(0, 200)}`],
    };
  }

  for (const k of page.keys) {
    try {
      const ref = await env.REFS_KV.get(k.name, "json");
      if (!ref) continue;
      scanned++;
      const patch = await recoverImage(ref, { retry });
      if (!Object.keys(patch).length) { skipped++; continue; }

      const label = patch.image ? "og" : patch.imageWhy || "none";
      why[label] = (why[label] || 0) + 1;
      await env.REFS_KV.put(k.name, JSON.stringify({ ...ref, ...patch }));
      if (patch.image) updated++;
      else missed++;
    } catch (err) {
      // One bad ref must not silently shrink the batch.
      errors.push(`${k.name}: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }

  return {
    ok: true, scanned, updated, missed, skipped, why,
    cursor: page.list_complete ? null : page.cursor,
    done: Boolean(page.list_complete),
    errors,
  };
}

// -------------------------------------------------------------------- the pass

/**
 * Deepen one ref. Returns a patch to merge into it — never mutates.
 *
 * ONE PAID CALL LIVES IN HERE and it is the expensive one. The vision branch
 * below is a Workers AI call, and this function is reached from four places —
 * the nightly's vision job, the nightly's enrich job, `/save`'s background
 * deepen, and `/api/reindex?deep=1`. Only the first of those books anything, so
 * for as long as the caption was unmetered the 20/night ration was not in the
 * path at all: one `POST /api/reindex?deep=1&batch=100` was a hundred vision
 * calls the governor never saw, and sixteen of those requests would have
 * captioned the whole archive. That is the shape of the bill he got once.
 *
 * So the charge is made HERE, next to the call, where every caller inherits it
 * whether or not it remembered to ask. `billed` is the opt-out for a caller
 * that has already booked its own unit — cron.js's vision job charges with
 * `vision:true` before it gets here, and a second charge would silently halve
 * the ration to ten. Opt-OUT rather than opt-in on purpose: a caller added
 * later is metered by default, and forgetting costs an argument rather than a
 * night's ration.
 *
 * A refused caption is reported on the patch (`captionSkipped`) rather than
 * returned as a bare empty result — a ref with no caption and no reason is
 * indistinguishable from a ref the model had nothing to say about.
 *
 * @param {object} env    worker env (needs AI for image captions)
 * @param {object} ref    the stored ref
 * @param {ArrayBuffer} [bytes]  image bytes, when we still have them in memory
 * @param {object} [opts]
 * @param {boolean} [opts.billed] the caller already charged for the vision call
 * @returns {Promise<{body?:string, caption?:string, image?:string,
 *   imageTried?:boolean, imageWhy?:string, captionSkipped?:string,
 *   enrichedAt?:string, enrichKind?:string}>}
 */
export async function enrichRef(env, ref, bytes, { billed = false } = {}) {
  if (!ref) return {};
  const patch = {};

  try {
    if (ref.category === "image" && (bytes || ref.blobKey || ref.image)) {
      const data = bytes || (await fetchImageBytes(env, ref));
      // Book it only once we know a model call would actually happen. No AI and
      // no bytes both mean captionImage returns "" without reaching the model,
      // and a governor that records a spend that never occurred is as wrong as
      // one that misses a spend that did.
      const wouldCall = Boolean(data && env?.AI);
      const booked = wouldCall && !billed
        ? await charge(env, { tier: 2, units: 1, vision: true, label: "enrich-vision" })
        : { ok: true };

      if (!booked.ok) {
        patch.captionSkipped = booked.reason || "the governor refused the vision call";
      } else {
        const caption = await captionImage(env, data);
        if (caption) {
          patch.caption = caption;
          patch.enrichKind = "vision";
        }
      }
    } else if (ref.category === "video" && ref.url) {
      const transcript = await fetchTranscript(ref.url);
      if (transcript) {
        patch.body = transcript;
        patch.enrichKind = "transcript";
      }
    } else if (ref.url && ref.category !== "audio") {
      const body = await fetchPageText(ref.url);
      // Ignore bodies that are basically just the title we already have.
      if (body && body.length > 200) {
        patch.body = body;
        patch.enrichKind = "page";
      }
    }
  } catch {
    // best-effort: fall through with whatever we got
  }

  // Orthogonal to the text above, and deliberately outside its try: whether we
  // got a transcript has no bearing on whether the page has an og:image.
  if (ref.url) {
    try {
      Object.assign(patch, await recoverImage(ref));
    } catch (err) {
      // Not silently — a ref with no image and no reason can't be diagnosed
      // later, and marking it tried without saying why is worse than useless.
      patch.imageTried = true;
      patch.imageWhy = `error: ${String(err?.message ?? err).slice(0, 80)}`;
    }
  }

  // enrichedAt means "we got something", not "we had a go": /api/reindex's
  // skipEnriched flag keys off it, so a ref we only marked image-tried must
  // stay eligible for a future text pass.
  if (patch.body || patch.caption || patch.image) patch.enrichedAt = new Date().toISOString();
  return patch;
}

/** Pull an image ref's bytes back out of storage (for re-enriching old refs). */
async function fetchImageBytes(env, ref) {
  try {
    if (ref.blobKey) {
      if (env.REFS_R2) {
        const obj = await env.REFS_R2.get(`blob:${ref.blobKey}`);
        return obj ? await obj.arrayBuffer() : null;
      }
      return await env.REFS_KV.get(`blob:${ref.blobKey}`, "arrayBuffer");
    }
    if (ref.image) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(ref.image, { signal: ctrl.signal, redirect: "follow" });
        return res.ok ? await res.arrayBuffer() : null;
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    return null;
  }
  return null;
}
