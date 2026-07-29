#!/usr/bin/env node
/**
 * Big Brain export -> factory production queue.
 *
 * Usage:
 *   node tiktok/factory/scripts/ingest-refs.mjs <export.(ndjson|json)> [outDir]
 *
 * Accepts the save-ref worker's /api/export NDJSON (one ref per line) or a
 * JSON array of refs. Ref shape (from worker/save-ref/src/index.js):
 *   { id, kind, category, host, tags[], url, text, title, desc, image, createdAt }
 *
 * Writes <outDir>/queue.json and <outDir>/queue.md, sorted into the buckets
 * defined in ../CONCEPT.md. No deps, plain node.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FACTORY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Big Brain category -> factory bucket. Host rules refine "link".
const BUCKET_BY_CATEGORY = {
  shop: "stuff-target",
  article: "claim-source",
  link: "claim-source",
  post: "pulse",
  video: "format-ref",
  image: "visual-ref",
  audio: "format-ref",
  document: "claim-source",
  note: "idea",
};

// Hosts that mean "this is an object", regardless of category.
const STUFF_HOSTS =
  /(grailed|depop|ssense|farfetch|ebay|etsy|amazon|bestbuy|walmart|aliexpress|vinted|poshmark|stockx|goat)\./i;

// Keywords in title/desc/text that suggest evidence for a claim.
const CLAIM_WORDS =
  /(regulat|law|mandat|ban(ned|s)?\b|deadline|rollout|launch|study|report|market|billion|million|forecast|2027|2028|2029|2030)/i;

function bucketFor(ref) {
  const hay = [ref.title, ref.desc, ref.text].filter(Boolean).join(" ");
  if (ref.host && STUFF_HOSTS.test(ref.host)) return "stuff-target";
  const base = BUCKET_BY_CATEGORY[ref.category] || "pulse";
  // A "pulse" post that reads like evidence is a claim-source candidate.
  if (base === "pulse" && CLAIM_WORDS.test(hay)) return "claim-source";
  return base;
}

function nextAction(bucket) {
  switch (bucket) {
    case "stuff-target": return "script a Stuff video around this object";
    case "claim-source": return "extract the claim + check-date for the ledger";
    case "pulse":        return "curator call: target or source?";
    case "format-ref":   return "note hook/pacing pattern worth stealing";
    case "visual-ref":   return "fold into AI-gen shot prompt style";
    case "idea":         return "jumps the queue — script next";
    default:             return "review";
  }
}

function parseExport(raw) {
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith("[")) return JSON.parse(text);
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try { return JSON.parse(l); }
      catch { console.error(`skipping malformed line ${i + 1}`); return null; }
    })
    .filter(Boolean);
}

const [, , inputPath, outDirArg] = process.argv;
if (!inputPath) {
  console.error("usage: ingest-refs.mjs <export.(ndjson|json)> [outDir]");
  process.exit(1);
}
const outDir = outDirArg ? resolve(outDirArg) : FACTORY_DIR;
mkdirSync(outDir, { recursive: true });

const refs = parseExport(readFileSync(inputPath, "utf8"));
const queue = refs.map((r) => {
  const bucket = bucketFor(r);
  return {
    id: r.id ?? null,
    bucket,
    title: r.title || r.text?.split("\n")[0]?.slice(0, 120) || r.url || "(untitled)",
    url: r.url || null,
    host: r.host || null,
    category: r.category || null,
    tags: r.tags || [],
    savedAt: r.createdAt || null,
    note: r.desc || r.text || "",
    nextAction: nextAction(bucket),
  };
});

const ORDER = ["idea", "stuff-target", "claim-source", "pulse", "format-ref", "visual-ref"];
queue.sort(
  (a, b) =>
    ORDER.indexOf(a.bucket) - ORDER.indexOf(b.bucket) ||
    String(b.savedAt || "").localeCompare(String(a.savedAt || ""))
);

writeFileSync(join(outDir, "queue.json"), JSON.stringify(queue, null, 2));

const counts = {};
for (const q of queue) counts[q.bucket] = (counts[q.bucket] || 0) + 1;

let md = `# Production queue — generated from Big Brain export\n\n`;
md += `${queue.length} refs · ` +
  ORDER.filter((b) => counts[b]).map((b) => `${b}: ${counts[b]}`).join(" · ") + `\n`;
for (const bucket of ORDER) {
  const items = queue.filter((q) => q.bucket === bucket);
  if (!items.length) continue;
  md += `\n## ${bucket} (${items.length})\n\n`;
  for (const q of items) {
    const link = q.url ? ` — <${q.url}>` : "";
    const note = q.note ? `\n  - ${q.note.slice(0, 160).replace(/\n/g, " ")}` : "";
    md += `- **${q.title}**${link}\n  - → ${q.nextAction}${note}\n`;
  }
}
writeFileSync(join(outDir, "queue.md"), md);

console.log(`${queue.length} refs sorted -> ${join(outDir, "queue.md")}`);
console.log(Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", "));
