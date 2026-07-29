#!/usr/bin/env node
/**
 * Load the Notion archive into Big Brain's brain.
 *
 * The 1,570 refs live in Notion; the worker's KV starts empty. Until they're
 * in, /api/ask has nothing to answer from. This imports them from the same
 * Notion CSV export the IG join uses — so it needs no Notion API token, no
 * integration to create, and no database to share.
 *
 * Reads nothing from the internet and writes nothing to Notion. It only pushes
 * INTO your own worker.
 *
 * Ids are derived from Date Added + a hash of the URL, which does two things:
 * re-running updates rows instead of duplicating them, and the ids still sort
 * newest-first the way the worker's KV listing expects.
 *
 * Usage:
 *
 *   export BIGBRAIN_URL=https://save-ref-v2.raderturner-e87.workers.dev
 *   read -rs BIGBRAIN_TOKEN && export BIGBRAIN_TOKEN
 *   node scripts/notion-import.mjs --refs ~/Downloads/Big\ Brain.csv
 *
 * Options:
 *   --handles <proposals.json>  output of ig-join.mjs, to attach @handles/axes
 *   --batch <n>                 rows per request (default 100)
 *   --limit <n>                 stop after n rows (smoke test)
 *   --no-index                  import only, skip building embeddings
 *   --dry                       parse and report, send nothing
 */

import { readFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { parseCsv } from "./lib/csv.mjs";
import { classify, titleFor, normalizeHandle, instagramShortcode } from "../worker/save-ref/src/realm.js";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : d;
};
const has = (n) => args.includes(`--${n}`);

const REFS = flag("refs", "");
const HANDLES = flag("handles", "");
const BATCH = Math.max(1, Number(flag("batch", 100)) || 100);
const LIMIT = Number(flag("limit", 0)) || 0;
const DRY = has("dry");

const BASE = (process.env.BIGBRAIN_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.BIGBRAIN_TOKEN || "";
const home = (p) => resolve(p.replace(/^~/, process.env.HOME || "~"));

if (!REFS) {
  console.error("\n  node scripts/notion-import.mjs --refs <big-brain.csv>\n");
  process.exit(1);
}
if (!DRY && (!BASE || !TOKEN)) {
  // Say which one, and how to check — an empty $TOKEN is easy to miss because
  // /health needs no auth, so a working health check proves nothing about it.
  console.error("");
  console.error(BASE ? `  BIGBRAIN_URL  ok  (${BASE})` : "  BIGBRAIN_URL   is EMPTY");
  console.error(TOKEN ? `  BIGBRAIN_TOKEN ok  (${TOKEN.length} chars)` : "  BIGBRAIN_TOKEN is EMPTY");
  console.error("\nCheck them without printing the token:\n");
  console.error('  echo "URL=[$URL]"');
  console.error('  echo "TOKEN is ${#TOKEN} chars"');
  console.error("\nSet them one line at a time (pasting a block can make `read` eat the next line):\n");
  console.error("  export URL=https://save-ref-v2.raderturner-e87.workers.dev");
  console.error("  read -rs TOKEN && export TOKEN\n");
  process.exit(1);
}

// Same reverse-timestamp id scheme the worker uses, so imported refs sort
// newest-first alongside anything dropped directly.
const TS_MAX = 10_000_000_000_000;
function hash8(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
function stableId(url, dateAdded) {
  const t = Date.parse(dateAdded || "") || Date.now();
  return `${String(TS_MAX - t).padStart(14, "0")}-${hash8(url || String(t))}`;
}

/** Notion multi-select CSV cells are comma-separated. */
const splitTags = (v) =>
  String(v || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Coarse kind/category, mirroring the worker's own bucketing. */
function categoryFor(url, sourceApp) {
  const h = hostOf(url);
  if (/instagram\.com$/.test(h)) return "post";
  if (/tiktok\.com$|youtube\.com$|youtu\.be$/.test(h)) return "video";
  if (/substack\.com$|medium\.com$/.test(h)) return "article";
  if (/patreon\.com$/.test(h)) return "post";
  if (/github\.com$/.test(h)) return "code";
  if (sourceApp === "Photos") return "image";
  return url ? "link" : "note";
}

// ------------------------------------------------------------------- load

/**
 * Notion nests its export: the download is a zip containing an
 * ExportBlock-*.zip which contains the CSVs. Take the .zip directly rather
 * than making anyone dig two levels down for a file with a 32-char id in
 * its name.
 */
async function csvPathFrom(input) {
  if (!input.toLowerCase().endsWith(".zip")) return input;

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const run = promisify(execFile);

  const dir = await mkdtemp(join(tmpdir(), "notion-export-"));
  console.log(`Unpacking ${basename(input)} …`);
  await run("unzip", ["-qq", "-o", input, "-d", dir]);

  // Unpack any nested archives (ExportBlock-*.zip), one level is enough.
  for (const entry of await readdir(dir)) {
    if (entry.toLowerCase().endsWith(".zip")) {
      await run("unzip", ["-qq", "-o", join(dir, entry), "-d", join(dir, "inner")]).catch(() => {});
    }
  }

  const found = [];
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.toLowerCase().endsWith(".csv")) found.push(p);
    }
  };
  await walk(dir);

  if (!found.length) {
    console.error("No CSV inside that zip. Re-export from Notion with format CSV.");
    process.exit(1);
  }
  // "_all.csv" is every row; the other is just the current view.
  const pick = found.find((f) => f.endsWith("_all.csv")) || found[0];
  console.log(`  found ${basename(pick)}`);
  return pick;
}

const csvPath = await csvPathFrom(home(REFS));
const rows = parseCsv(await readFile(csvPath, "utf8").catch((e) => {
  console.error(`Couldn't read ${csvPath}: ${e.message}`);
  process.exit(1);
}));
console.log(`${rows.length} rows from ${basename(csvPath)}`);

// Optional: pull recovered @handles in from the IG join so imported refs carry
// author attribution and a taste axis from the start.
const handleByUrl = new Map();
if (HANDLES) {
  try {
    const data = JSON.parse(await readFile(home(HANDLES), "utf8"));
    for (const p of data.proposals || []) {
      if (p.handle) handleByUrl.set(p.url, { handle: p.handle, axis: p.axis, tags: p.tags });
    }
    console.log(`${handleByUrl.size} @handles from ${basename(HANDLES)}`);
  } catch (e) {
    console.warn(`Couldn't read handles file: ${e.message}`);
  }
}

let usable = rows.filter((r) => (r.URL || r.Name || "").trim());
if (LIMIT) usable = usable.slice(0, LIMIT);

const refs = usable.map((row) => {
  const url = (row.URL || "").trim();
  const name = (row.Name || "").trim();
  const notes = (row.Notes || "").trim();
  const dateAdded = row["Date Added"] || "";
  const extra = handleByUrl.get(url) || {};
  const handle = normalizeHandle(extra.handle || "");

  const verdict = classify({
    name,
    notes,
    url,
    type: row.Type || "",
    sourceApp: row["Source App"] || "",
    handle,
  });

  const notionTags = splitTags(row.Tags);
  const tags = [...new Set([...notionTags, ...(extra.tags || [])].map((t) => t.trim()).filter(Boolean))];

  return {
    id: stableId(url, dateAdded),
    kind: url ? "url" : "note",
    category: categoryFor(url, row["Source App"]),
    realm: verdict.realm,
    axis: verdict.axis || extra.axis || null,
    title: titleFor({ name, url }, handle),
    url: url || undefined,
    host: hostOf(url) || null,
    desc: notes.slice(0, 600),
    text: url ? undefined : name,
    note: row.Look ? String(row.Look).slice(0, 1000) : "",
    tags,
    handle: handle || undefined,
    createdAt: dateAdded ? new Date(dateAdded).toISOString() : new Date().toISOString(),
    source: "notion",
    notionType: row.Type || "",
    sourceApp: row["Source App"] || "",
  };
});

const byRealm = {};
for (const r of refs) byRealm[r.realm] = (byRealm[r.realm] || 0) + 1;
console.log(`\n${refs.length} refs ready:`);
for (const [k, v] of Object.entries(byRealm).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(14)} ${v}`);
}
console.log(`  ${String(refs.filter((r) => r.handle).length).padStart(4)} with an @handle`);

if (DRY) {
  console.log("\n--dry: nothing sent. First ref would be:\n", refs[0]);
  process.exit(0);
}

// ----------------------------------------------------------------- import

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Auth-Token": TOKEN },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let imported = 0;
let failed = 0;
console.log("");
for (let i = 0; i < refs.length; i += BATCH) {
  const batch = refs.slice(i, i + BATCH);
  const n = Math.floor(i / BATCH) + 1;
  const total = Math.ceil(refs.length / BATCH);
  try {
    const data = await post("/api/import", { refs: batch });
    imported += data.imported || 0;
    console.log(`  batch ${n}/${total} → ${data.imported} imported`);
  } catch (e) {
    failed += batch.length;
    console.error(`  batch ${n}/${total} failed: ${e.message}`);
  }
}
console.log(`\n${imported} imported${failed ? `, ${failed} failed` : ""}.`);

// ---------------------------------------------------------------- reindex

if (has("no-index") || !imported) {
  if (imported) console.log("\nSkipped indexing (--no-index). Run POST /api/reindex when ready.");
  process.exit(failed && !imported ? 1 : 0);
}

console.log("\nBuilding embeddings — this is what makes search work.\n");
let cursor = null;
let indexed = 0;
let rounds = 0;
while (rounds++ < 200) {
  const qs = new URLSearchParams({ batch: "100" });
  if (cursor) qs.set("cursor", cursor);
  try {
    const data = await post(`/api/reindex?${qs}`, {});
    indexed += data.indexed || 0;
    cursor = data.cursor;
    process.stdout.write(`\r  ${indexed} embedded…`);
    if (data.done || !cursor) break;
  } catch (e) {
    console.error(`\n  reindex stopped: ${e.message}`);
    break;
  }
}
console.log(`\n\n${indexed} refs embedded. Try it:\n`);
console.log(`  curl -s -X POST "$BIGBRAIN_URL/api/ask" -H "X-Auth-Token: $BIGBRAIN_TOKEN" \\`);
console.log(`    -H "Content-Type: application/json" -d '{"q":"what am I into lately?"}'`);
console.log("");
