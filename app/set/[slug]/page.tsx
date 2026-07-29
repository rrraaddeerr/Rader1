import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { listSets, setsConfigured, type SetDoc } from "@/lib/sets";
import { getAllItems } from "@/lib/inventory";
import { getVPCItems } from "@/lib/vpc-catalog";
import { PresentationView } from "./PresentationView";

export const dynamic = "force-dynamic";

async function findBySlug(slug: string): Promise<SetDoc | null> {
  const sets = await listSets();
  return sets.find((s) => s.slug === slug) ?? null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  if (!setsConfigured()) return { title: "Sets not configured" };
  try {
    const set = await findBySlug(slug);
    if (!set || set.unpublished) return { title: "Set not found" };
    return {
      title: `${set.name}${set.client ? ` — ${set.client}` : ""}`,
      robots: { index: false, follow: false },
    };
  } catch {
    return { title: "Set" };
  }
}

export default async function PresentationPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!setsConfigured()) {
    return (
      <div className="present">
        <div className="wrap">
          <p style={{ marginTop: 60 }}>Sets not configured.</p>
        </div>
      </div>
    );
  }
  const set = await findBySlug(slug);
  if (!set || set.unpublished) notFound();

  // Resolve item details once on the server so the client receives a small
  // ready-to-render payload.
  const archive = getAllItems();
  const vpc = getVPCItems();
  const lookup = new Map<string, {
    title: string;
    subcategory: string;
    priceWeek: number | null;
    thumb: string | null;
    dimensions?: string;
    description?: string;
  }>();
  for (const i of archive) {
    const bc = i.id.replace(/^vpc-/, "");
    lookup.set(bc, {
      title: i.title,
      subcategory: i.category,
      priceWeek: i.price_week,
      thumb: i.images[0] ?? null,
      dimensions: i.dimensions,
      description: i.description,
    });
  }
  for (const i of vpc) {
    if (lookup.has(i.barcode)) continue;
    lookup.set(i.barcode, {
      title: i.name,
      subcategory: i.subcategory,
      priceWeek: i.priceWeek,
      thumb: i.thumb ?? i.photo ?? null,
      dimensions: i.size,
      description: i.description,
    });
  }
  const resolved = set.groups.map((g) => ({
    ...g,
    items: g.items.map((it) => {
      const entry = lookup.get(it.barcode);
      return {
        ...it,
        catalog: entry ?? null,
      };
    }),
  }));

  return (
    <PresentationView set={set} resolvedGroups={resolved} />
  );
}
