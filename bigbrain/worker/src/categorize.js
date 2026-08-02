/**
 * Auto-categorization — pure functions, no I/O, so they unit-test with plain node.
 *
 * A "ref" (reference) is whatever you drop into Big Brain: a link, an image,
 * or a plain note. categorize() decides its `kind` (storage shape) and a
 * human `category` (the bucket shown in the gallery), plus useful tags.
 */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|tiff?|heic)(\?.*)?$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v)(\?.*)?$/i;
const AUDIO_EXT = /\.(mp3|wav|flac|ogg|m4a)(\?.*)?$/i;
const DOC_EXT = /\.(pdf|docx?|pptx?|xlsx?|epub)(\?.*)?$/i;

// host substring -> category. First match wins.
const HOST_RULES = [
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, "video"],
  [/(^|\.)vimeo\.com$/, "video"],
  [/(^|\.)tiktok\.com$/, "video"],
  [/(^|\.)twitch\.tv$/, "video"],
  [/(^|\.)twitter\.com$|(^|\.)x\.com$/, "post"],
  [/(^|\.)instagram\.com$/, "post"],
  [/(^|\.)threads\.net$/, "post"],
  [/(^|\.)reddit\.com$/, "post"],
  [/(^|\.)bsky\.app$/, "post"],
  [/(^|\.)mastodon\./, "post"],
  [/(^|\.)pinterest\.|(^|\.)pin\.it$/, "image"],
  [/(^|\.)behance\.net$|(^|\.)dribbble\.com$/, "image"],
  [/(^|\.)are\.na$/, "image"],
  [/(^|\.)github\.com$|(^|\.)gitlab\.com$/, "code"],
  [/(^|\.)codepen\.io$|(^|\.)codesandbox\.io$|(^|\.)stackblitz\.com$/, "code"],
  [/(^|\.)npmjs\.com$/, "code"],
  [/(^|\.)spotify\.com$|(^|\.)soundcloud\.com$|(^|\.)bandcamp\.com$/, "audio"],
  [/(^|\.)amazon\.|(^|\.)etsy\.com$|(^|\.)ebay\.|(^|\.)shopify\.com$/, "shop"],
  [/(^|\.)ssense\.com$|(^|\.)farfetch\.com$|(^|\.)grailed\.com$|(^|\.)depop\.com$/, "shop"],
  [/(^|\.)wikipedia\.org$/, "article"],
  [/(^|\.)medium\.com$|(^|\.)substack\.com$/, "article"],
  [/(^|\.)nytimes\.com$|(^|\.)theguardian\.com$|(^|\.)bbc\./, "article"],
];

const ALL_CATEGORIES = [
  "image", "video", "audio", "post", "article",
  "code", "shop", "document", "note", "link",
];

/** Try to parse a URL; return the URL object or null. */
export function parseUrl(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    // accept bare "example.com/x" by adding a scheme
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    return u;
  } catch {
    return null;
  }
}

/** Normalize a content-type string to a coarse category, or null. */
function categoryFromContentType(ct) {
  if (typeof ct !== "string") return null;
  const t = ct.toLowerCase();
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (t.startsWith("application/pdf")) return "document";
  return null;
}

/**
 * Decide kind + category + tags for a drop.
 * @param {object} input
 * @param {string} [input.url]          - a link being saved
 * @param {string} [input.text]         - free text / note
 * @param {string} [input.filename]     - uploaded file name
 * @param {string} [input.contentType]  - uploaded/declared MIME type
 * @param {boolean}[input.isBlob]       - true if raw bytes were uploaded
 * @returns {{kind:string, category:string, host:(string|null), tags:string[]}}
 */
export function categorize(input = {}) {
  const tags = new Set();
  const ctCat = categoryFromContentType(input.contentType);

  // 1) An uploaded blob (file) is the strongest signal.
  if (input.isBlob || input.filename) {
    let category = ctCat;
    const name = input.filename || "";
    if (!category) {
      if (IMAGE_EXT.test(name)) category = "image";
      else if (VIDEO_EXT.test(name)) category = "video";
      else if (AUDIO_EXT.test(name)) category = "audio";
      else if (DOC_EXT.test(name)) category = "document";
    }
    category = category || "image"; // pasted screenshots are the common case
    tags.add("upload");
    return { kind: "blob", category, host: null, tags: [...tags] };
  }

  // 2) A URL.
  const u = parseUrl(input.url);
  if (u) {
    const host = u.hostname.replace(/^www\./, "");
    tags.add(host);
    let category = ctCat;
    if (!category) {
      const path = u.pathname;
      if (IMAGE_EXT.test(path)) category = "image";
      else if (VIDEO_EXT.test(path)) category = "video";
      else if (AUDIO_EXT.test(path)) category = "audio";
      else if (DOC_EXT.test(path)) category = "document";
    }
    if (!category) {
      for (const [re, cat] of HOST_RULES) {
        if (re.test(u.hostname)) { category = cat; break; }
      }
    }
    category = category || "link";
    tags.add(category);
    return { kind: "url", category, host, tags: [...tags] };
  }

  // 3) Plain text becomes a note.
  if (typeof input.text === "string" && input.text.trim()) {
    tags.add("note");
    return { kind: "note", category: "note", host: null, tags: [...tags] };
  }

  return { kind: "unknown", category: "link", host: null, tags: [] };
}

export { ALL_CATEGORIES };
