#!/usr/bin/env node
/**
 * Load the rent.co archive into Big Brain's item index.
 *
 * Once this has run, Big Brain can answer "do I have anything like this?" —
 * drop a runway shot or a client's Pinterest image and it ranks what you
 * actually own against it — and it can draft a client Set from a brief.
 *
 * Usage (from the repo root):
 *
 *   BIGBRAIN_URL=https://save-ref-v2.<you>.workers.dev \
 *   BIGBRAIN_TOKEN=<your token> \
 *   node scripts/index-inventory.mjs
 *
 * Options:
 *   --file <path>   inventory JSON to read (default data/inventory.json)
 *   --batch <n>     items per request (default 50)
 *   --limit <n>     stop after n items (handy for a smoke test)
 *   --dry           parse and report, send nothing
 *
 * Re-running is safe: the vector index upserts by item id, so this refreshes
 * rather than duplicates. Run it again whenever data/inventory.json changes.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const FILE = resolve(process.cwd(), flag("file", "data/inventory.json"));
const BATCH = Math.max(1, Number(flag("batch", 50)) || 50);
const LIMIT = Number(flag("limit", 0)) || 0;
const DRY = has("dry");

const URL_BASE = (process.env.BIGBRAIN_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.BIGBRAIN_TOKEN || "";

if (!DRY && (!URL_BASE || !TOKEN)) {
  console.error(
    "Set BIGBRAIN_URL and BIGBRAIN_TOKEN.\n\n" +
      "  BIGBRAIN_URL=https://save-ref-v2.<you>.workers.dev \\\n" +
      "  BIGBRAIN_TOKEN=<token> node scripts/index-inventory.mjs\n"
  );
  process.exit(1);
}

/** Keep the payload to what the embedder actually reads. */
function slim(item) {
  return {
    id: item.id,
    slug: item.slug,
    title: item.title,
    category: item.category,
    description: item.description,
    tags: item.tags,
    era: item.era,
    condition: item.condition,
    images: Array.isArray(item.images) ? item.images.slice(0, 1) : undefined,
  };
}

const raw = await readFile(FILE, "utf8").catch((err) => {
  console.error(`Couldn't read ${FILE}: ${err.message}`);
  process.exit(1);
});

let items = JSON.parse(raw);
if (!Array.isArray(items)) items = items.items || [];
items = items.filter((it) => it && (it.id || it.slug)).map(slim);
if (LIMIT) items = items.slice(0, LIMIT);

console.log(`${items.length} items from ${FILE}`);
if (DRY) {
  console.log("--dry: nothing sent. First item would be:\n", items[0]);
  process.exit(0);
}

let indexed = 0;
let failed = 0;

for (let i = 0; i < items.length; i += BATCH) {
  const batch = items.slice(i, i + BATCH);
  const n = Math.floor(i / BATCH) + 1;
  const total = Math.ceil(items.length / BATCH);
  try {
    const res = await fetch(`${URL_BASE}/api/inventory/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": TOKEN },
      body: JSON.stringify({ items: batch }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      failed += batch.length;
      console.error(`  batch ${n}/${total} failed: ${data.error || res.status}`);
    } else {
      indexed += data.indexed || 0;
      console.log(`  batch ${n}/${total} → ${data.indexed}/${batch.length} indexed`);
    }
  } catch (err) {
    failed += batch.length;
    console.error(`  batch ${n}/${total} errored: ${err.message}`);
  }
}

console.log(`\nDone. ${indexed} indexed${failed ? `, ${failed} failed` : ""}.`);
if (indexed) {
  console.log(
    `\nTry it:\n  curl -s -X POST ${URL_BASE}/api/match \\\n` +
      `    -H "X-Auth-Token: $BIGBRAIN_TOKEN" -H "Content-Type: application/json" \\\n` +
      `    -d '{"q":"scuffed steel rolling cart, hospital, cold light"}' | head -40`
  );
}
process.exit(failed && !indexed ? 1 : 0);
