import Link from "next/link";
import type { InventoryItem } from "@/lib/types";
import { priceTeaser } from "@/lib/inventory";
import { ItemPlaceholder } from "./ItemPlaceholder";
import { AddToRequestButton } from "./AddToRequestButton";

export function ItemCard({ item }: { item: InventoryItem }) {
  return (
    <article className="card">
      <Link href={`/archive/${item.slug}`} className="card__link">
        <div className="card__media">
          {item.images.length > 0 ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.images[0].replace(/^\/inventory\//, "/inventory/thumbs/")} alt={item.title} loading="lazy" width={240} height={160} />
          ) : (
            <ItemPlaceholder item={item} />
          )}
        </div>
        <div className="card__body">
          <div className="card__cat">{item.category}</div>
          <h3 className="card__title">{item.title}</h3>
          <div className="card__meta">
            <span className="card__price">{priceTeaser(item)}</span>
            {item.tags[0] && <span className="card__era">{item.tags[0]}</span>}
          </div>
        </div>
      </Link>
      <AddToRequestButton itemId={item.id} variant="compact" />
    </article>
  );
}
