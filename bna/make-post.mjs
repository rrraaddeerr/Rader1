#!/usr/bin/env node
/**
 * b4/after — post bundle generator.
 *
 * Reads queue.csv, renders each pending row into a ready-to-post bundle:
 *   out/<id>/slide-1.png   (BEFORE — hook card)
 *   out/<id>/slide-2.png   (AFTER — payoff + intention line)
 *   out/<id>/caption.txt   (caption + hashtags + AIGC note when generated)
 *
 * Usage:
 *   node make-post.mjs             # render all rows missing an output
 *   node make-post.mjs <id...>     # render specific rows
 *
 * Images: put source images at assets/<id>/before.(png|jpg) and
 * assets/<id>/after.(png|jpg). Rows whose images are missing render with a
 * labeled placeholder so the layout can be previewed before art exists.
 *
 * Renders at 1080x1350 (4:5) — native for IG feed, accepted by TikTok
 * photo mode.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, "out");
const ASSETS = join(ROOT, "assets");
const W = 1080, H = 1350;
const HANDLE = process.env.BNA_HANDLE || "@b4.aftr";

// ---------- tiny CSV parser (quoted fields, commas inside quotes) ----------
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

function findImage(id, side) {
  const dir = join(ASSETS, id);
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir).find((f) => f.toLowerCase().startsWith(side));
  return hit ? join(dir, hit) : null;
}

function imageCss(path, fallbackHue) {
  if (path) {
    const b64 = readFileSync(path).toString("base64");
    const ext = path.toLowerCase().endsWith(".png") ? "png" : "jpeg";
    return `background-image:url(data:image/${ext};base64,${b64});background-size:cover;background-position:center;`;
  }
  return `background:linear-gradient(160deg,hsl(${fallbackHue},18%,22%),hsl(${(fallbackHue + 40) % 360},22%,12%));`;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function slideHtml({ imgCss, tag, headline, sub, stampLine, swipeCue }) {
  return `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:${W}px;height:${H}px;font-family:'Archivo',Helvetica,Arial,sans-serif;
    color:#fff;position:relative;overflow:hidden;${imgCss}}
  .shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.55) 0%,rgba(0,0,0,0) 30%,rgba(0,0,0,0) 55%,rgba(0,0,0,.75) 100%)}
  .tag{position:absolute;top:56px;left:56px;font-weight:800;font-size:44px;letter-spacing:.12em;
    padding:14px 28px;border:4px solid #fff;border-radius:8px;background:rgba(0,0,0,.35)}
  .bottom{position:absolute;left:56px;right:56px;bottom:92px;display:flex;flex-direction:column;gap:28px}
  .head{font-weight:800;font-size:76px;line-height:1.06;text-shadow:0 4px 24px rgba(0,0,0,.8)}
  .sub{font-size:38px;line-height:1.3;opacity:.92;text-shadow:0 2px 12px rgba(0,0,0,.9)}
  .stamp{position:absolute;bottom:34px;left:56px;font-size:30px;font-weight:700;letter-spacing:.08em;opacity:.85}
  .cue{position:absolute;top:50%;right:44px;transform:translateY(-50%);font-size:110px;opacity:.9;
    text-shadow:0 2px 18px rgba(0,0,0,.8);animation:none}
  </style><body>
  <div class="shade"></div>
  <div class="tag">${esc(tag)}</div>
  <div class="bottom">
  ${headline ? `<div class="head">${esc(headline)}</div>` : ""}
  ${sub ? `<div class="sub">${esc(sub)}</div>` : ""}
  </div>
  ${swipeCue ? `<div class="cue">›</div>` : ""}
  <div class="stamp">${esc(stampLine)}</div>
  </body>`;
}

// ---------- main ----------
const queue = parseCsv(readFileSync(join(ROOT, "queue.csv"), "utf8"));
const wanted = process.argv.slice(2);
const todo = queue.filter(
  (r) => (wanted.length ? wanted.includes(r.id) : !existsSync(join(OUT, r.id, "slide-2.png")))
);
if (!todo.length) { console.log("nothing to render"); process.exit(0); }

const browser = await chromium.launch({
  executablePath: process.env.BNA_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });

for (const r of todo) {
  const dir = join(OUT, r.id);
  mkdirSync(dir, { recursive: true });
  const hue = ([...r.id].reduce((a, c) => a + c.charCodeAt(0), 0) * 37) % 360;
  const isGen = (r.source_type || "").toLowerCase() === "ai";

  const slides = [
    slideHtml({
      imgCss: imageCss(findImage(r.id, "before"), hue),
      tag: "BEFORE",
      headline: r.hook,
      sub: "",
      stampLine: `${HANDLE} · swipe`,
      swipeCue: true,
    }),
    slideHtml({
      imgCss: imageCss(findImage(r.id, "after"), (hue + 140) % 360),
      tag: "AFTER",
      headline: r.payoff || "",
      sub: r.intent || "",
      stampLine: `${HANDLE}${isGen ? " · AI-generated" : ""}`,
      swipeCue: false,
    }),
  ];

  for (let i = 0; i < slides.length; i++) {
    await page.setContent(slides[i], { waitUntil: "load" });
    await page.screenshot({ path: join(dir, `slide-${i + 1}.png`) });
  }

  const caption = [
    r.caption || r.hook,
    "",
    r.intent ? `${r.intent}` : "",
    "",
    (r.hashtags || "#beforeandafter #b4after").trim(),
    isGen ? "\n[Post with the AI-generated content label ON]" : "",
  ].filter(Boolean).join("\n");
  writeFileSync(join(dir, "caption.txt"), caption + "\n");
  console.log(`rendered ${r.id} (${r.series})${findImage(r.id, "before") ? "" : " [placeholder art]"}`);
}

await browser.close();
console.log(`done — bundles in bna/out/`);
