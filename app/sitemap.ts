import type { MetadataRoute } from "next";
import { getAllItems } from "@/lib/inventory";

const BASE = "https://r-ent.co";
const GATED = process.env.SITE_PUBLIC !== "1";

export default function sitemap(): MetadataRoute.Sitemap {
  // While gated, advertise nothing — the URLs all redirect to a noindex gate.
  if (GATED) return [];

  const staticRoutes = ["", "/archive", "/consult", "/source", "/about", "/request"].map(
    (path) => ({
      url: `${BASE}${path}`,
      lastModified: new Date(),
      changeFrequency: "weekly" as const,
      priority: path === "" ? 1 : 0.7,
    })
  );

  const itemRoutes = getAllItems().map((item) => ({
    url: `${BASE}/archive/${item.slug}`,
    lastModified: new Date(),
    changeFrequency: "monthly" as const,
    priority: 0.6,
  }));

  return [...staticRoutes, ...itemRoutes];
}
