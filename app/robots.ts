import type { MetadataRoute } from "next";

// While the invite gate is up, tell crawlers nothing is indexable — every
// gated URL 307s to a noindex /access page anyway, and the image library
// shouldn't be crawlable pre-launch. Set SITE_PUBLIC=1 at launch to flip
// robots + sitemap open in one env change.
const GATED = process.env.SITE_PUBLIC !== "1";

export default function robots(): MetadataRoute.Robots {
  if (GATED) {
    return {
      rules: { userAgent: "*", disallow: "/" },
    };
  }
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: "/api/",
    },
    sitemap: "https://r-ent.co/sitemap.xml",
  };
}
