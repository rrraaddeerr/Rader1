import { Suspense } from "react";
import type { Metadata } from "next";
import { getAllItems, getFacets } from "@/lib/inventory";
import { TapeLabel } from "@/components/TapeLabel";
import { ArchiveBrowser } from "./ArchiveBrowser";

export const metadata: Metadata = {
  title: "Archive",
  description:
    "Search and explore rent.co's curated, manually verified inventory — browse by category, tag, and vibe. Manual inquiry only, no checkout.",
};

export default function ArchivePage() {
  const items = getAllItems();
  const facets = getFacets();

  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <div className="page-head__slate">
            <span>CH 02 — ARCHIVE</span>
            <span className="page-head__slate-sep" aria-hidden="true">│</span>
            <span>LIVE</span>
            <span className="page-head__slate-sep" aria-hidden="true">│</span>
            <span>{items.length} OBJECTS</span>
          </div>
          <TapeLabel className="page-head__tape" rotate={-2}>
            The Archive
          </TapeLabel>
          <h1>
            {items.length} objects.<br />
            <span className="hot marker-underline">Search by function or by world.</span>
          </h1>
          <p className="page-head__lead">
            A curated, manually verified subset of the inventory. Availability is
            not live — every request is confirmed by hand. Nothing here is a
            checkout.
          </p>
        </div>
      </section>

      <Suspense fallback={null}>
        <ArchiveBrowser items={items} facets={facets} />
      </Suspense>
    </>
  );
}
