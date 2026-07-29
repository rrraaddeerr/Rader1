#!/usr/bin/env node
/**
 * Generates data/photo-manifest.json — the barcodes that have a full-size
 * photo and/or a thumbnail under public/inventory/.
 *
 * Why: on serverless hosts the public/ directory is served from the CDN and
 * is NOT on the function filesystem, so runtime existsSync() lies. The
 * manifest is computed here (at import/commit time, where the files do
 * exist) and read by lib/vpc-catalog.ts instead.
 *
 * Run after adding photos:  node scripts/build-photo-manifest.mjs
 */
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const jpgs = (dir) => {
  try {
    return readdirSync(join(root, dir))
      .filter((f) => f.toLowerCase().endsWith(".jpg"))
      .map((f) => f.replace(/\.jpg$/i, ""));
  } catch {
    return [];
  }
};

const photos = jpgs("public/inventory").sort();
const thumbs = jpgs("public/inventory/thumbs").sort();

const out = { generated_at: new Date().toISOString(), photos, thumbs };
writeFileSync(join(root, "data/photo-manifest.json"), JSON.stringify(out));
console.log(`photo-manifest: ${photos.length} photos, ${thumbs.length} thumbs`);
