import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getAllItems,
  getItemBySlug,
  getRelatedItems,
  formatPrice,
} from "@/lib/inventory";
import { sourceOwnerLabels } from "@/lib/categories";
import { ItemPlaceholder } from "@/components/ItemPlaceholder";
import { ItemCard } from "@/components/ItemCard";
import { ItemGallery } from "@/components/ItemGallery";
import { AddToRequestButton } from "@/components/AddToRequestButton";
import { ShareButton } from "@/components/ShareButton";
import { TapeLabel } from "@/components/TapeLabel";
import { JsonLd } from "@/components/JsonLd";

type Params = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return getAllItems().map((item) => ({ slug: item.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const item = getItemBySlug(slug);
  if (!item) return { title: "Object not found" };
  return {
    title: item.title,
    description: `${item.description} — ${item.category}. Rental inquiry via rent.co.`,
  };
}

export default async function ItemPage({ params }: Params) {
  const { slug } = await params;
  const item = getItemBySlug(slug);
  if (!item) notFound();

  const related = getRelatedItems(item, 4);

  const productLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: item.title,
    description: item.description,
    category: item.category,
    sku: item.id,
    ...(item.images.length > 0
      ? { image: item.images.map((i) => `https://r-ent.co${i}`) }
      : {}),
    ...(item.price_week != null
      ? {
          offers: {
            "@type": "Offer",
            priceCurrency: "CAD",
            price: item.price_week,
            availability: "https://schema.org/LimitedAvailability",
            businessFunction: "http://purl.org/goodrelations/v1#LeaseOut",
            url: `https://r-ent.co/archive/${item.slug}`,
          },
        }
      : {}),
  };

  return (
    <div className="item">
      <JsonLd data={productLd} />
      <div className="wrap">
        <div className="item__slate">
          <span>OBJECT ID</span>
          <span className="item__slate-sep" aria-hidden="true">│</span>
          <span className="item__slate-id">{item.id.toUpperCase()}</span>
          <span className="item__slate-sep" aria-hidden="true">│</span>
          <span>VANCOUVER</span>
        </div>
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <Link href="/archive">Archive</Link>
          {" / "}
          <Link href={`/archive?category=${encodeURIComponent(item.category)}`}>
            {item.category}
          </Link>
          {" / "}
          <span>{item.id.toUpperCase()}</span>
        </nav>

        <div className="item__top">
          <div className="item__media">
            {item.images.length > 0 ? (
              <ItemGallery images={item.images} title={item.title} />
            ) : (
              <ItemPlaceholder item={item} />
            )}
          </div>

          <div>
            <TapeLabel className="item__cat" rotate={-2}>
              {item.category}
            </TapeLabel>
            <h1 className="item__title">{item.title}</h1>
            <p className="item__desc">{item.description}</p>

            <div className="price-box">
              <div className="price-box__item">
                <span className="price-box__k">Week rate</span>
                <span className="price-box__v">{formatPrice(item.price_week)}</span>
              </div>
              {item.price_day != null ? (
                <div className="price-box__item">
                  <span className="price-box__k">Day rate</span>
                  <span className="price-box__v">{formatPrice(item.price_day)}</span>
                </div>
              ) : null}
              {item.replacement_value != null ? (
                <div className="price-box__item">
                  <span className="price-box__k">Replacement value</span>
                  <span className="price-box__v">
                    {formatPrice(item.replacement_value)}
                  </span>
                </div>
              ) : null}
            </div>

            <p className="item__avail">
              Availability is not guaranteed live. {item.availability_note}
            </p>

            <div className="item__actions">
              <AddToRequestButton itemId={item.id} variant="full" />
              <ShareButton label="Share this object" />
            </div>

            <table className="spec">
              <tbody>
                <tr>
                  <th>Item ID</th>
                  <td>{item.id.toUpperCase()}</td>
                </tr>
                <tr>
                  <th>Dimensions</th>
                  <td>{item.dimensions}</td>
                </tr>
                {/* Era hidden until the data carries real values — today every
                    item reads "Contemporary", which contradicts vintage pieces. */}
                <tr>
                  <th>Source / owner</th>
                  <td>{sourceOwnerLabels[item.source_owner] ?? item.source_owner}</td>
                </tr>
                <tr>
                  <th>Location</th>
                  <td>Vancouver warehouse</td>
                </tr>
                <tr>
                  <th>Condition</th>
                  <td>{item.condition}</td>
                </tr>
              </tbody>
            </table>

            <div className="tag-row">
              {item.tags.map((t) => (
                <TapeLabel key={t}>{t}</TapeLabel>
              ))}
            </div>
          </div>
        </div>

        {related.length > 0 && (
          <section className="section" style={{ borderBottom: "none", paddingBottom: 0 }}>
            <div className="section-head">
              <div>
                <TapeLabel className="section-head__tape">Related</TapeLabel>
                <h2 className="section-head__title">Pairs well with</h2>
              </div>
            </div>
            <div className="grid">
              {related.map((r) => (
                <ItemCard key={r.id} item={r} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
