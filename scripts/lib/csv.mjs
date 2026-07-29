/**
 * Minimal RFC-4180 CSV parser — quoted fields, embedded commas and newlines,
 * doubled quotes. Enough for Notion's exports, which is all it's for.
 *
 * Shared by ig-join.mjs and notion-import.mjs, both of which read the same
 * Notion CSV export.
 *
 * @param {string} text
 * @returns {Array<Record<string,string>>} rows keyed by header name
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }  // escaped quote
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

  // Notion sometimes prefixes the export with a UTF-8 BOM.
  const header = rows.shift().map((h, i) => (i === 0 ? h.replace(/^﻿/, "") : h).trim());
  return rows
    .filter((r) => r.some((v) => v !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}
