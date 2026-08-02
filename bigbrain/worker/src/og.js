/**
 * Lightweight Open Graph / metadata fetch for URL refs.
 *
 * Runs inside the Worker: fetches the target page with a hard timeout and a
 * small read cap, then scrapes <title>, og:title, og:description, og:image.
 * Best-effort — any failure just returns empty fields so /save never blocks.
 */

const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 512 * 1024; // only need the <head>

function decode(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .trim();
}

function metaContent(html, attr, value) {
  // matches <meta property="og:image" content="...">  (either attr order)
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${value}["'][^>]*content=["']([^"']*)["']` +
      `|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${value}["']`,
    "i"
  );
  const m = html.match(re);
  return m ? decode(m[1] ?? m[2] ?? "") : "";
}

/**
 * @param {string} url absolute http(s) url
 * @returns {Promise<{title:string, description:string, image:string}>}
 */
export async function fetchMeta(url) {
  const empty = { title: "", description: "", image: "" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; BigBrainBot/1.0; +https://bigbrain.ref)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    const ct = res.headers.get("content-type") || "";
    if (!res.ok || !ct.includes("text/html")) return empty;

    // read at most MAX_BYTES
    const reader = res.body?.getReader();
    if (!reader) return empty;
    let received = 0;
    const chunks = [];
    while (received < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
    }
    try { await reader.cancel(); } catch {}
    const html = new TextDecoder("utf-8").decode(concat(chunks));

    const ogTitle = metaContent(html, "property", "og:title");
    const titleTag = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").trim();
    return {
      title: decode(ogTitle || titleTag) || "",
      description:
        metaContent(html, "property", "og:description") ||
        metaContent(html, "name", "description") ||
        "",
      image: metaContent(html, "property", "og:image") || "",
    };
  } catch {
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

function concat(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
