import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type VPCItem = {
  barcode: string;
  category: string;
  subcategory: string;
  name: string;
  description: string;
  size: string;
  priceWeek: number | null;
  priceRaw: string;
  photo: string | null;
  thumb: string | null;
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // skip
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim()));
}

function parsePriceWeek(raw: string): number | null {
  if (!raw) return null;
  const m = raw.match(/\$?\s*([\d.]+)/);
  return m ? Math.round(parseFloat(m[1])) : null;
}

let CACHE: VPCItem[] | null = null;

// Which barcodes actually have images. Prefer the committed manifest
// (public/ is not on the serverless function filesystem, so existsSync
// returns false for everything in production); fall back to existsSync in
// dev if the manifest is missing. Regenerate with
// `node scripts/build-photo-manifest.mjs` after adding photos.
function photoSets(): { photos: Set<string> | null; thumbs: Set<string> | null } {
  try {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "data/photo-manifest.json"), "utf8")
    ) as { photos?: string[]; thumbs?: string[] };
    return {
      photos: new Set(manifest.photos ?? []),
      thumbs: new Set(manifest.thumbs ?? []),
    };
  } catch {
    return { photos: null, thumbs: null };
  }
}

export function getVPCItems(): VPCItem[] {
  if (CACHE) return CACHE;
  const file = join(process.cwd(), "data/vpc_catalog.csv");
  const text = readFileSync(file, "utf8");
  const rows = parseCsv(text);
  const header = rows[0];
  const idx = (n: string) => header.findIndex((h) => h.trim() === n);
  const ix = {
    barcode: idx("barcode"),
    category: idx("category"),
    subcategory: idx("subcategory"),
    name: idx("name"),
    description: idx("description"),
    size: idx("size"),
    price: idx("price"),
  };
  const inventoryDir = join(process.cwd(), "public/inventory");
  const thumbsDir = join(inventoryDir, "thumbs");
  const { photos, thumbs } = photoSets();
  const items: VPCItem[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const barcode = (r[ix.barcode] || "").trim();
    if (!barcode) continue;
    const photoRel = `/inventory/${barcode}.jpg`;
    const photoAbs = join(inventoryDir, `${barcode}.jpg`);
    const thumbRel = `/inventory/thumbs/${barcode}.jpg`;
    const thumbAbs = join(thumbsDir, `${barcode}.jpg`);
    const hasPhoto = photos ? photos.has(barcode) : existsSync(photoAbs);
    const hasThumb = thumbs ? thumbs.has(barcode) : existsSync(thumbAbs);
    items.push({
      barcode,
      category: (r[ix.category] || "").trim(),
      subcategory: (r[ix.subcategory] || "").trim(),
      name: (r[ix.name] || "").trim(),
      description: (r[ix.description] || "").trim(),
      size: (r[ix.size] || "").trim(),
      priceRaw: (r[ix.price] || "").trim(),
      priceWeek: parsePriceWeek(r[ix.price] || ""),
      photo: hasPhoto ? photoRel : null,
      thumb: hasThumb ? thumbRel : null,
    });
  }
  CACHE = items;
  return items;
}

export function getSubcategoryStats(): {
  subcategory: string;
  count: number;
  withPhoto: number;
}[] {
  const items = getVPCItems();
  const map = new Map<string, { count: number; withPhoto: number }>();
  for (const it of items) {
    const key = it.subcategory || "(uncategorized)";
    const cur = map.get(key) || { count: 0, withPhoto: 0 };
    cur.count++;
    if (it.photo || it.thumb) cur.withPhoto++;
    map.set(key, cur);
  }
  return [...map.entries()]
    .map(([subcategory, v]) => ({ subcategory, ...v }))
    .sort((a, b) => a.subcategory.localeCompare(b.subcategory));
}
