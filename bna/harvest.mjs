#!/usr/bin/env node
/**
 * b4/after — before & after content harvester.
 *
 * Scrapes free JSON APIs for before/after candidates and builds a local
 * curation gallery. Runs on plain Node (>=18, uses global fetch) — no API
 * keys, no AI tokens, no dependencies.
 *
 * Usage:
 *   node harvest.mjs               # pull from all sources, rebuild gallery
 *   node harvest.mjs reddit        # single source (reddit|wikimedia|loc)
 *   node harvest.mjs --rebuild     # just regenerate curate.html
 *   node harvest.mjs --demo       # inject offline demo candidates (testing)
 *
 * Output:
 *   harvest/candidates.jsonl   — one candidate per line (append-only, deduped)
 *   harvest/curate.html        — open in a browser, keep/skip, export CSV
 *
 * Sources are polite: one request per sub/query, built-in delay, custom UA.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIR = join(ROOT, "harvest");
const JSONL = join(DIR, "candidates.jsonl");
const UA = "bna-harvester/0.1 (personal curation tool; low volume)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- config: tune these, nothing else needs touching ----------
const REDDIT_SUBS = [
  // sub -> series guess for the export
  ["powerwashingporn", "restore"],
  ["Detailing", "restore"],
  ["Restoration", "restore"],
  ["ThriftStoreHauls", "glowup-things"],
  ["OldPhotosInRealLife", "timegap"],
  ["RetroFuturism", "hypothetical"],
];
const REDDIT_LISTING = "top.json?t=week&limit=40";
const WM_QUERIES = [
  "then and now photograph",
  "before after restoration",
  "shipwreck aerial",
];
const LOC_QUERIES = ["street view then now", "panorama city 1900"];
const MIN_REDDIT_SCORE = 200;

// ---------------- store ----------------------------------------------------
function loadCandidates() {
  if (!existsSync(JSONL)) return [];
  return readFileSync(JSONL, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function saveNew(items, seen) {
  const fresh = items.filter((i) => i && !seen.has(i.id));
  for (const i of fresh) appendFileSync(JSONL, JSON.stringify(i) + "\n");
  fresh.forEach((i) => seen.add(i.id));
  return fresh.length;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// ---------------- sources ---------------------------------------------------
async function harvestReddit() {
  const out = [];
  for (const [sub, series] of REDDIT_SUBS) {
    try {
      const j = await getJson(`https://www.reddit.com/r/${sub}/${REDDIT_LISTING}`);
      for (const c of j.data?.children || []) {
        const d = c.data;
        if (d.score < MIN_REDDIT_SCORE || d.over_18 || d.stickied) continue;
        let before = null, after = null, thumb = null;
        if (d.is_gallery && d.media_metadata && d.gallery_data) {
          const ids = d.gallery_data.items.map((it) => it.media_id);
          const urlOf = (id) => {
            const m = d.media_metadata[id];
            const u = m?.s?.u || m?.p?.at(-1)?.u;
            return u ? u.replaceAll("&amp;", "&") : null;
          };
          before = urlOf(ids[0]);
          after = urlOf(ids[1] ?? ids[0]);
        } else {
          thumb = d.preview?.images?.[0]?.source?.url?.replaceAll("&amp;", "&")
            || (/\.(jpe?g|png|webp)$/i.test(d.url_overridden_by_dest || "") ? d.url_overridden_by_dest : null);
        }
        if (!before && !thumb) continue;
        out.push({
          id: `rd_${d.id}`, source: "reddit", series, title: d.title,
          before, after, thumb,
          credit: `u/${d.author} on r/${sub}`, license: "unknown — ask author / use as lead only",
          url: `https://www.reddit.com${d.permalink}`, score: d.score,
        });
      }
      console.log(`  r/${sub}: ok`);
    } catch (e) { console.log(`  r/${sub}: skip (${e.message})`); }
    await sleep(1100);
  }
  return out;
}

async function harvestWikimedia() {
  const out = [];
  for (const q of WM_QUERIES) {
    try {
      const api = "https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*"
        + "&generator=search&gsrnamespace=6&gsrlimit=25&gsrsearch=" + encodeURIComponent(q)
        + "&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=800";
      const j = await getJson(api);
      for (const p of Object.values(j.query?.pages || {})) {
        const ii = p.imageinfo?.[0];
        if (!ii) continue;
        const meta = ii.extmetadata || {};
        out.push({
          id: `wm_${p.pageid}`, source: "wikimedia", series: "timegap",
          title: p.title.replace(/^File:/, ""), thumb: ii.thumburl || ii.url,
          before: null, after: null,
          credit: (meta.Artist?.value || "unknown").replace(/<[^>]+>/g, "").trim(),
          license: meta.LicenseShortName?.value || "see file page",
          url: ii.descriptionshorturl || ii.descriptionurl, score: 0,
        });
      }
      console.log(`  commons "${q}": ok`);
    } catch (e) { console.log(`  commons "${q}": skip (${e.message})`); }
    await sleep(600);
  }
  return out;
}

async function harvestLoc() {
  const out = [];
  for (const q of LOC_QUERIES) {
    try {
      const j = await getJson(`https://www.loc.gov/photos/?q=${encodeURIComponent(q)}&fo=json&c=25`);
      for (const r of j.results || []) {
        const img = Array.isArray(r.image_url) ? r.image_url.at(-1) : r.image_url;
        if (!img) continue;
        out.push({
          id: `loc_${(r.id || "").split("/").filter(Boolean).at(-1)}`, source: "loc",
          series: "timegap", title: r.title, thumb: img, before: null, after: null,
          credit: "Library of Congress", license: r.rights || "check item page (most pre-1930 = public domain)",
          url: r.url?.startsWith("http") ? r.url : `https://www.loc.gov${r.url || ""}`, score: 0,
        });
      }
      console.log(`  loc "${q}": ok`);
    } catch (e) { console.log(`  loc "${q}": skip (${e.message})`); }
    await sleep(600);
  }
  return out;
}

function demoCandidates() {
  const svg = (label, hue) => "data:image/svg+xml," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="hsl(${hue},30%,25%)"/><text x="200" y="160" font-size="36" fill="#fff" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`);
  return [
    { id: "demo_1", source: "reddit", series: "restore", title: "Power washed 30 years of grime off this patio",
      before: svg("BEFORE", 20), after: svg("AFTER", 140), thumb: null,
      credit: "u/demo on r/powerwashingporn", license: "unknown — ask author / use as lead only",
      url: "https://example.com/1", score: 4200 },
    { id: "demo_2", source: "wikimedia", series: "timegap", title: "Main Street 1910 vs 2020 composite.jpg",
      before: null, after: null, thumb: svg("1910 / 2020", 210),
      credit: "Jane Photographer", license: "CC BY-SA 4.0", url: "https://example.com/2", score: 0 },
    { id: "demo_3", source: "loc", series: "timegap", title: "Panorama of San Francisco after the 1906 fire",
      before: null, after: null, thumb: svg("LOC 1906", 280),
      credit: "Library of Congress", license: "Public domain", url: "https://example.com/3", score: 0 },
  ];
}

// ---------------- curation gallery -----------------------------------------
function buildGallery(candidates) {
  const html = `<!doctype html><meta charset="utf-8"><title>b4/after — curate (${candidates.length})</title><style>
  :root{color-scheme:dark}
  body{margin:0;background:#101014;color:#eee;font-family:system-ui,sans-serif}
  header{position:sticky;top:0;background:#101014ee;padding:14px 20px;display:flex;gap:12px;align-items:center;border-bottom:1px solid #2a2a33;z-index:2;flex-wrap:wrap}
  h1{font-size:18px;margin:0 12px 0 0}
  button,select{background:#22222b;color:#eee;border:1px solid #3a3a45;border-radius:8px;padding:8px 14px;font-size:14px;cursor:pointer}
  button.primary{background:#3556d4;border-color:#3556d4}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;padding:20px}
  .card{background:#191920;border:1px solid #2a2a33;border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
  .card.keep{outline:3px solid #38b26b}.card.skip{opacity:.28}
  .imgs{display:flex;gap:2px;background:#000;min-height:180px}
  .imgs img{width:100%;min-width:0;object-fit:cover;max-height:260px;flex:1}
  .pad{padding:12px 14px;display:flex;flex-direction:column;gap:8px;flex:1}
  .t{font-size:15px;line-height:1.3;font-weight:600}
  .meta{font-size:12px;color:#9a9aa8;line-height:1.5}
  .meta a{color:#7f9cff}
  .row{display:flex;gap:8px;margin-top:auto}
  .row button{flex:1}
  .badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:99px;background:#2a2a3a;margin-right:6px}
  #count{color:#38b26b;font-weight:700}
  </style><body>
  <header><h1>b4/after curation</h1>
    <select id="filter"><option value="">all sources</option><option>reddit</option><option>wikimedia</option><option>loc</option></select>
    <select id="sfilter"><option value="">all series</option><option>timegap</option><option>restore</option><option>hypothetical</option><option>glowup-things</option><option>marine</option></select>
    <span><span id="count">0</span> kept</span>
    <button class="primary" onclick="exportCsv()">Export keeps → CSV</button>
    <button onclick="if(confirm('Clear all keep/skip marks?')){localStorage.removeItem(KEY);render()}">Reset</button>
  </header>
  <div class="grid" id="grid"></div>
  <script>
  const DATA = ${JSON.stringify(candidates)};
  const KEY = "bna-curation";
  const state = () => JSON.parse(localStorage.getItem(KEY) || "{}");
  const setState = (s) => localStorage.setItem(KEY, JSON.stringify(s));
  function mark(id, v){ const s = state(); s[id] = (s[id] === v ? undefined : v); setState(s); render(); }
  function csvEsc(x){ x = String(x ?? ""); return '"' + x.replaceAll('"','""') + '"'; }
  function exportCsv(){
    const s = state();
    const keeps = DATA.filter(d => s[d.id] === "keep");
    if(!keeps.length) return alert("Nothing marked keep yet.");
    const header = "id,series,source_type,hook,payoff,intent,caption,hashtags,credit,source_url";
    const rows = keeps.map(d => [d.id, d.series, "scraped", d.title.slice(0,80), "", "TODO one true line", "", "#beforeandafter", d.credit + " (" + d.license + ")", d.url].map(csvEsc).join(","));
    const blob = new Blob([header + "\\n" + rows.join("\\n") + "\\n"], {type:"text/csv"});
    const a = Object.assign(document.createElement("a"), {href: URL.createObjectURL(blob), download: "keeps.csv"});
    a.click();
  }
  function render(){
    const s = state(), f = document.getElementById("filter").value, sf = document.getElementById("sfilter").value;
    document.getElementById("count").textContent = DATA.filter(d => s[d.id] === "keep").length;
    document.getElementById("grid").innerHTML = DATA
      .filter(d => (!f || d.source === f) && (!sf || d.series === sf))
      .map(d => {
        const imgs = d.before ? '<img loading="lazy" src="'+d.before+'"><img loading="lazy" src="'+(d.after||d.before)+'">'
                              : '<img loading="lazy" src="'+(d.thumb||"")+'">';
        return '<div class="card '+(s[d.id]||"")+'">'
          + '<div class="imgs">'+imgs+'</div><div class="pad">'
          + '<div><span class="badge">'+d.source+'</span><span class="badge">'+d.series+'</span>'+(d.score?'<span class="badge">▲'+d.score+'</span>':'')+'</div>'
          + '<div class="t">'+d.title.replace(/</g,"&lt;")+'</div>'
          + '<div class="meta">'+d.credit.replace(/</g,"&lt;")+' · '+d.license.replace(/</g,"&lt;")+'<br><a href="'+d.url+'" target="_blank">source ↗</a></div>'
          + '<div class="row"><button onclick="mark(\\''+d.id+'\\',\\'keep\\')">✓ keep</button><button onclick="mark(\\''+d.id+'\\',\\'skip\\')">✗ skip</button></div>'
          + '</div></div>';
      }).join("");
  }
  document.getElementById("filter").onchange = render;
  document.getElementById("sfilter").onchange = render;
  render();
  </script></body>`;
  writeFileSync(join(DIR, "curate.html"), html);
}

// ---------------- main ------------------------------------------------------
mkdirSync(DIR, { recursive: true });
const arg = process.argv[2];
let existing = loadCandidates();
// a real harvest evicts leftover --demo placeholders
if (arg !== "--demo" && existing.some((c) => c.id.startsWith("demo_"))) {
  existing = existing.filter((c) => !c.id.startsWith("demo_"));
  writeFileSync(JSONL, existing.map((c) => JSON.stringify(c)).join("\n") + (existing.length ? "\n" : ""));
}
const seen = new Set(existing.map((c) => c.id));
let added = 0;

if (arg === "--demo") {
  added = saveNew(demoCandidates(), seen);
} else if (arg !== "--rebuild") {
  const sources = { reddit: harvestReddit, wikimedia: harvestWikimedia, loc: harvestLoc };
  const run = arg ? { [arg]: sources[arg] } : sources;
  for (const [name, fn] of Object.entries(run)) {
    if (!fn) { console.error(`unknown source: ${name}`); process.exit(1); }
    console.log(`harvesting ${name}…`);
    added += saveNew(await fn(), seen);
  }
}

const all = loadCandidates();
buildGallery(all);
console.log(`${added} new candidates (${all.length} total) → harvest/curate.html`);
