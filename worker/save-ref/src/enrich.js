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
 * Everything here is best-effort. Any failure returns empty and the ref keeps
 * whatever it already had — enrichment must never lose you a save.
 *
 * The parsing functions are pure (no I/O) so they unit-test in plain node.
 */

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

/**
 * Deepen one ref. Returns a patch to merge into it — never mutates.
 *
 * @param {object} env    worker env (needs AI for image captions)
 * @param {object} ref    the stored ref
 * @param {ArrayBuffer} [bytes]  image bytes, when we still have them in memory
 * @returns {Promise<{body?:string, caption?:string, enrichedAt?:string, enrichKind?:string}>}
 */
export async function enrichRef(env, ref, bytes) {
  if (!ref) return {};
  const patch = {};

  try {
    if (ref.category === "image" && (bytes || ref.blobKey || ref.image)) {
      const data = bytes || (await fetchImageBytes(env, ref));
      const caption = await captionImage(env, data);
      if (caption) {
        patch.caption = caption;
        patch.enrichKind = "vision";
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

  if (Object.keys(patch).length) patch.enrichedAt = new Date().toISOString();
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
