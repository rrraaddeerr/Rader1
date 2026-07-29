/**
 * Category vocabularies for rent.co.
 *
 * `practicalCategories` are the functional event-rental categories — every
 * inventory item is filed under exactly one of these as its `category`.
 *
 * `culturalTags` are the search/vibe vocabulary — items carry any number of
 * these as `tags`, which power the era / use / vibe filters in the archive.
 */

export const practicalCategories = [
  "Seating",
  "Tables",
  "Lighting",
  "Practical Lighting",
  "Practical Seating",
  "Cases & Carts",
  "Pipe & Drape",
  "Water Stations",
  "Signage",
  "Hospitality",
  "Greenery",
  "Staging",
  "Logistics",
  "Storage",
] as const;

export const culturalTags = [
  "80s",
  "90s",
  "2000s",
  "Neon",
  "Server Room",
  "Airport",
  "Hotel",
  "Office",
  "Backstage",
  "Nightlife",
  "Festival",
  "Touring",
  "Green Room",
  "Retail",
  "Institutional",
  "Unique Seating",
  "Unique Lighting",
  "Cool Cars",
  "Cool Locations",
] as const;

export const eras = [
  "1970s",
  "1980s",
  "1990s",
  "2000s",
  "2010s",
  "Contemporary",
] as const;

// Public-facing labels. Supplier names stay internal — the public archive
// speaks as one curated collection, not a directory of where things live.
export const sourceOwnerLabels: Record<string, string> = {
  RaderENT: "RaderENT",
  VPC: "Partner archive",
  VPE: "Partner archive",
  partner_vendor: "Partner vendor",
  sourced_to_order: "Sourced to order",
};

export type PracticalCategory = (typeof practicalCategories)[number];
export type CulturalTag = (typeof culturalTags)[number];
