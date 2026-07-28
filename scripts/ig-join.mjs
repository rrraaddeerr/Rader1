#!/usr/bin/env node
/**
 * Tier 0 — give the nameless Instagram refs an identity, for free.
 *
 * 1,216 of the 1,570 rows in 🧠 Big Brain are titled literally "Instagram",
 * with no notes and no tags. Nothing can search that. But the Instagram data
 * export knows which account every saved post came from, and TASTE_SOURCES.md
 * knows what each account means. Joining the two recovers a real title, a
 * realm and a taste axis for every matched ref — no scraping, no vision, no
 * API calls, no cost. Deterministic code on an idle machine.
 *
 * It writes PROPOSALS ONLY. Nothing here touches Notion and nothing is
 * applied: curation is yours. Output goes to the swipe queue for approval.
 *
 * Usage:
 *
 *   node scripts/ig-join.mjs \
 *     --ig ~/Downloads/instagram-raderturner-2026-04-22-HHJhrRl9.zip \
 *     --refs ~/Downloads/big-brain.csv \
 *     --out ~/Dropbox/_PROSPECTOR/proposals-realm.json
 *
 * --ig accepts the .zip or an already-unzipped folder.
 * --refs is the Notion CSV export of 🧠 Big Brain (Notion: ••• → Export → CSV).
 * Add --push to send the proposals straight into the worker's swipe queue
 * (needs BIGBRAIN_URL and BIGBRAIN_TOKEN).
 */

import { readFile, readdir, stat, mkdtemp, rm } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { classify, titleFor, summarize, instagramShortcode, normalizeHandle } from "../worker/save-ref/src/realm.js";

const run = promisify(execFile);

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const IG = flag("ig", "");
const REFS = flag("refs", "");
const OUT = flag("out", "proposals-realm.json");
const MIN_CONFIDENCE = Number(flag("min", 0)) || 0;

if (!IG || !REFS) {
  console.error(
    "Need both inputs.\n\n" +
      "  node scripts/ig-join.mjs --ig <instagram-export.zip|dir> --refs <big-brain.csv>\n\n" +
      "The Instagram export is the .zip in ~/Downloads.\n" +
      "The refs file is Notion's CSV export of the 🧠 Big Brain database.\n"
  );
  process.exit(1);
}

// ------------------------------------------------------------------ helpers

/** Minimal RFC-4180 CSV parser — quoted fields, embedded commas and newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows.shift().map((h) => h.trim());
  return rows
    .filter((r) => r.some((v) => v !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

/** Walk a directory tree looking for a file by name. */
async function findFile(dir, name) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const found = await findFile(p, name);
      if (found) return found;
    } else if (e.name === name) return p;
  }
  return null;
}

/**
 * Instagram's export nests the handle differently per file and per export
 * vintage. Tolerate `title`, `string_list_data[].value`, and the href form.
 */
function handleFromEntry(entry) {
  if (!entry || typeof entry !== "object") return "";
  const direct = normalizeHandle(entry.title);
  if (direct) return direct;
  const list = entry.string_list_data;
  if (Array.isArray(list) && list.length) {
    return normalizeHandle(list[0].value) || normalizeHandle(list[0].href);
  }
  return "";
}

/** Any post URL hiding in an export entry. */
function urlFromEntry(entry) {
  const map = entry?.string_map_data;
  if (map && typeof map === "object") {
    for (const v of Object.values(map)) {
      if (v?.href && String(v.href).includes("instagram.com")) return v.href;
    }
  }
  const list = entry?.string_list_data;
  if (Array.isArray(list)) {
    for (const v of list) if (v?.href && String(v.href).includes("/p/")) return v.href;
  }
  return "";
}

// -------------------------------------------------------------------- load

let igRoot = resolve(IG.replace(/^~/, process.env.HOME || "~"));
let tempDir = null;

const info = await stat(igRoot).catch(() => null);
if (!info) { console.error(`Not found: ${igRoot}`); process.exit(1); }

if (info.isFile()) {
  tempDir = await mkdtemp(join(tmpdir(), "ig-export-"));
  console.log(`Unzipping ${basename(igRoot)} …`);
  try {
    await run("unzip", ["-qq", "-o", igRoot, "-d", tempDir]);
  } catch (err) {
    console.error(`Couldn't unzip: ${err.message}`);
    process.exit(1);
  }
  igRoot = tempDir;
}

const savedPath = await findFile(igRoot, "saved_posts.json");
if (!savedPath) {
  console.error("No saved_posts.json in the export. Expected under your_instagram_activity/saved/.");
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  process.exit(1);
}

const savedRaw = JSON.parse(await readFile(savedPath, "utf8"));
const savedList =
  savedRaw.saved_saved_media || savedRaw.saved_media || (Array.isArray(savedRaw) ? savedRaw : []);

// shortcode -> handle. This is the whole trick.
const byShortcode = new Map();
for (const entry of savedList) {
  const url = urlFromEntry(entry);
  const code = instagramShortcode(url);
  const handle = handleFromEntry(entry);
  if (code && handle) byShortcode.set(code, handle);
}
console.log(`${savedList.length} saved posts in the export → ${byShortcode.size} shortcodes mapped to a handle`);

// Following list: an account he follows is a weak signal the ref is on-taste.
const followingPath = await findFile(igRoot, "following.json");
const following = new Set();
if (followingPath) {
  try {
    const raw = JSON.parse(await readFile(followingPath, "utf8"));
    const list = raw.relationships_following || (Array.isArray(raw) ? raw : []);
    for (const e of list) {
      const h = handleFromEntry(e);
      if (h) following.add(h);
    }
  } catch {}
}
console.log(`${following.size} accounts followed`);

// --------------------------------------------------------------- join refs

const refsPath = resolve(REFS.replace(/^~/, process.env.HOME || "~"));
const refsRaw = await readFile(refsPath, "utf8").catch((err) => {
  console.error(`Couldn't read ${refsPath}: ${err.message}`);
  process.exit(1);
});

const rows = refsPath.endsWith(".json")
  ? JSON.parse(refsRaw)
  : parseCsv(refsRaw);

console.log(`${rows.length} refs from ${basename(refsPath)}`);

if (!rows.length) {
  console.error("\nThat file has no rows. If it came from Notion, re-export with every property shown.");
  process.exit(1);
}

// Notion's CSV only contains the properties VISIBLE in the view you exported
// from. Losing `Type` costs the free realm lookup, so say so loudly rather
// than silently producing weaker proposals.
const columns = new Set(Object.keys(rows[0]));
const wanted = ["Name", "URL", "Type", "Source App", "Notes"];
const missing = wanted.filter((c) => !columns.has(c));
if (missing.length) {
  console.warn(`\n⚠ Missing column(s): ${missing.join(", ")}`);
  console.warn(`  Found: ${[...columns].join(", ")}`);
  if (missing.includes("URL")) {
    console.error("  Without URL nothing can be matched. Re-export with the URL property visible.");
    process.exit(1);
  }
  if (missing.includes("Type")) {
    console.warn("  Without Type the free realm lookup is skipped; handles still recover titles.");
  }
  console.warn("");
}

const proposals = [];
const stats = { matched: 0, unmatched: 0, notInstagram: 0, alreadyTitled: 0, followedOnly: 0 };

for (const row of rows) {
  const url = row.URL || row.url || row["userDefined:URL"] || "";
  const name = row.Name || row.name || "";
  const ref = {
    name,
    url,
    type: row.Type || "",
    sourceApp: row["Source App"] || "",
    notes: row.Notes || "",
  };

  const code = instagramShortcode(url);
  if (!code) {
    stats.notInstagram++;
    // Non-Instagram refs still get a realm from Type — also free.
    const result = classify(ref);
    if (result.confidence >= MIN_CONFIDENCE) {
      proposals.push({ url, currentTitle: name, proposedTitle: titleFor(ref), handle: "", ...result });
    }
    continue;
  }

  const handle = byShortcode.get(code) || "";
  if (handle) stats.matched++;
  else stats.unmatched++;
  if (handle && following.has(handle)) stats.followedOnly++;

  const result = classify({ ...ref, handle });
  const proposedTitle = titleFor(ref, handle);
  if (name && name.toLowerCase() !== "instagram") stats.alreadyTitled++;

  if (result.confidence >= MIN_CONFIDENCE) {
    proposals.push({
      url,
      shortcode: code,
      handle,
      currentTitle: name,
      proposedTitle,
      followed: handle ? following.has(handle) : false,
      ...result,
    });
  }
}

// ------------------------------------------------------------------ report

const summary = summarize(proposals);
console.log("");
console.log(`Instagram refs matched to an account : ${stats.matched}`);
console.log(`Instagram refs with no match         : ${stats.unmatched}`);
console.log(`Non-Instagram refs (realm from Type) : ${stats.notInstagram}`);
console.log("");
console.log("Proposed realms:");
for (const [realm, n] of Object.entries(summary.byRealm).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${realm.padEnd(14)} ${n}`);
}
if (Object.keys(summary.byAxis).length) {
  console.log("\nProposed taste axes:");
  for (const [axis, n] of Object.entries(summary.byAxis).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${axis.padEnd(26)} ${n}`);
  }
}
console.log(`\n${summary.needsHelp} refs are low-confidence and want your eyes (or a paid tier).`);

const outPath = resolve(OUT.replace(/^~/, process.env.HOME || "~"));
await writeFile(
  outPath,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), source: basename(refsPath), stats, summary, proposals },
    null,
    2
  )
);
console.log(`\n→ ${proposals.length} proposals written to ${outPath}`);
console.log("Nothing was written to Notion. These are proposals for you to swipe.");

if (tempDir) await rm(tempDir, { recursive: true, force: true });

// ------------------------------------------------------------------- push

if (has("push")) {
  const base = (process.env.BIGBRAIN_URL || "").replace(/\/+$/, "");
  const token = process.env.BIGBRAIN_TOKEN || "";
  if (!base || !token) {
    console.error("\n--push needs BIGBRAIN_URL and BIGBRAIN_TOKEN in the environment.");
    process.exit(1);
  }
  const BATCH = 200;
  let sent = 0;
  for (let i = 0; i < proposals.length; i += BATCH) {
    const batch = proposals.slice(i, i + BATCH);
    const res = await fetch(`${base}/api/queue/propose`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token },
      body: JSON.stringify({ kind: "realm", source: "ig-join", proposals: batch }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      console.error(`  batch failed: ${data.error || res.status}`);
    } else sent += data.queued || 0;
  }
  console.log(`\n${sent} proposals queued. Open ${base}/queue on your phone to swipe them.`);
}
