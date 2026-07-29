import type { Metadata } from "next";
import Link from "next/link";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getAllItems } from "@/lib/inventory";
import { getVPCItems } from "@/lib/vpc-catalog";
import { OpsClient } from "./OpsClient";
import { TruckIcon, WalkieIcon } from "@/components/Icons";
import { listSets, setsConfigured } from "@/lib/sets";

export const metadata: Metadata = {
  title: "Operator",
  robots: { index: false, follow: false },
};

type RecentInquiry = {
  kind: "rental" | "consult" | "sourcing";
  submitted_at: string;
  who: string;
  email: string;
  details: string;
  itemCount: number;
};

async function loadRecentInquiries(): Promise<RecentInquiry[]> {
  const dir = path.join(process.cwd(), "data", "submissions");
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const recent: RecentInquiry[] = [];
  for (const fname of names) {
    if (!fname.endsWith(".ndjson")) continue;
    const kind = fname.replace(/\.ndjson$/, "") as RecentInquiry["kind"];
    let text = "";
    try {
      text = await fs.readFile(path.join(dir, fname), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        const obj = JSON.parse(line);
        const f = obj.fields ?? {};
        recent.push({
          kind,
          submitted_at: obj.submitted_at ?? "",
          who: f.name || f.company || f.email || "Anonymous",
          email: f.email ?? "",
          details: f.message ?? f.brief ?? f.details ?? "",
          itemCount: Array.isArray(obj.selected_items) ? obj.selected_items.length : 0,
        });
      } catch {}
    }
  }
  recent.sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1));
  return recent.slice(0, 30);
}

export default async function OpsPage() {
  const inventory = getAllItems();
  const vpc = getVPCItems();
  const recent = await loadRecentInquiries();

  const photoLinked = inventory.filter((i) => i.images.length > 0).length;
  const thumbsCovered = vpc.filter((i) => i.thumb).length;
  const featured = inventory.filter((i) => i.featured).length;

  // Sets stats (best-effort; sets storage might not be configured yet)
  let setsTotal = 0;
  let setsLive = 0;
  let setsDraft = 0;
  let setsClosed = 0;
  let setsItemsInPlay = 0;
  let setsLatest: { name: string; client?: string; updated_at: string } | null = null;
  if (setsConfigured()) {
    try {
      const allSets = await listSets();
      setsTotal = allSets.length;
      for (const s of allSets) {
        if (s.locked) setsClosed++;
        else if (s.unpublished) setsDraft++;
        else {
          setsLive++;
          for (const g of s.groups ?? []) setsItemsInPlay += g.items?.length ?? 0;
        }
      }
      if (allSets[0]) {
        setsLatest = { name: allSets[0].name, client: allSets[0].client, updated_at: allSets[0].updated_at };
      }
    } catch {
      // Worker might be unreachable — render zeros, ops still loads
    }
  }

  const inquiryDestinations = {
    notion: !!(process.env.NOTION_TOKEN && process.env.NOTION_DATABASE_ID),
    webhook: !!process.env.INQUIRY_WEBHOOK_URL,
    local: true,
  };

  const notionDbId = process.env.NOTION_DATABASE_ID?.replace(/-/g, "") ?? null;
  const notionUrl = notionDbId
    ? `https://www.notion.so/${notionDbId}`
    : null;

  return (
    <div className="ops">
      <div className="wrap">
        <div className="comms">
          <span className="comms__channel">CH 00 — OPERATOR</span>
          <span className="comms__sep">/</span>
          <span>RaderENT control room</span>
          <span className="comms__sep">/</span>
          <span className="comms__signal" aria-hidden="true"><i/><i/><i/><i/></span>
          <span className="comms__over">COPY · STANDING BY</span>
        </div>
        <header className="ops__head sets-head">
          <div className="sets-head__bg" aria-hidden="true">
            <TruckIcon size={200} color="rgba(255,90,31,0.07)" />
          </div>
          <div>
            <div className="ops__kicker">OPERATOR</div>
            <h1 className="ops__title sharpie">
              <WalkieIcon size={36} color="var(--accent)" />
              <span>Control panel</span>
            </h1>
          </div>
          <div className="ops__head-links">
            <Link href="/sets" className="curate__btn curate__btn--accent">/sets</Link>
            <Link href="/curate" className="curate__btn">/curate</Link>
            <Link href="/curate/sort" className="curate__btn">/curate/sort</Link>
            <Link href="/curate/preview" className="curate__btn">/curate/preview</Link>
          </div>
        </header>

        <div className="ops__grid">
          <section className="ops__card">
            <div className="ops__card-title">ARCHIVE</div>
            <div className="ops__stat-big">{inventory.length}</div>
            <div className="ops__stat-meta">items live on /archive</div>
            <div className="ops__rows">
              <Row k="With photo" v={`${photoLinked} / ${inventory.length}`} />
              <Row k="Featured" v={featured} />
            </div>
          </section>

          <section className="ops__card">
            <div className="ops__card-title">VPC CATALOG</div>
            <div className="ops__stat-big">{vpc.length}</div>
            <div className="ops__stat-meta">items in source CSV</div>
            <div className="ops__rows">
              <Row k="Thumbs available" v={`${thumbsCovered} / ${vpc.length}`} />
              <Row k="Re-export needed" v="yes (10-cap)" hot />
            </div>
          </section>

          <section className="ops__card">
            <div className="ops__card-title">SETS</div>
            <div className="ops__stat-big">{setsTotal}</div>
            <div className="ops__stat-meta">proposals on file</div>
            <div className="ops__rows">
              <Row k="Live" v={setsLive} hot={setsLive > 0} />
              <Row k="Draft" v={setsDraft} />
              <Row k="Closed" v={setsClosed} />
              <Row k="Items in play" v={setsItemsInPlay} />
            </div>
            {setsLatest ? (
              <div className="ops__hint" style={{ marginTop: 14 }}>
                Latest: <b style={{ color: "var(--text)" }}>{setsLatest.name}</b>
                {setsLatest.client ? ` · ${setsLatest.client}` : ""}
              </div>
            ) : null}
          </section>

          <section className="ops__card">
            <div className="ops__card-title">CURATE PROGRESS</div>
            <OpsClient />
          </section>

          <section className="ops__card">
            <div className="ops__card-title">INQUIRY ROUTING</div>
            <div className="ops__rows">
              <Row
                k="Notion DB"
                v={inquiryDestinations.notion ? "✓ wired" : "not set"}
                hot={!inquiryDestinations.notion}
              />
              <Row
                k="Generic webhook"
                v={inquiryDestinations.webhook ? "✓ wired" : "not set"}
              />
              <Row k="Local NDJSON" v={recent.length > 0 ? `${recent.length} on disk` : "—"} />
            </div>
            <div className="ops__hint">
              {inquiryDestinations.notion
                ? "Inquiries are duplicated to local file + Notion."
                : "Set NOTION_TOKEN and NOTION_DATABASE_ID on Vercel to forward to Notion."}
            </div>
            {notionUrl ? (
              <a
                href={notionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="curate__btn"
                style={{ marginTop: 10, alignSelf: "flex-start" }}
              >
                Open Notion DB ↗
              </a>
            ) : null}
          </section>
        </div>

        <section className="ops__inbox">
          <header className="ops__inbox-head">
            <h2>Recent inquiries</h2>
            <span className="muted mono">
              local NDJSON · serverless writes don&apos;t persist
            </span>
          </header>
          {recent.length === 0 ? (
            <div className="ops__inbox-empty">
              Nothing on this server&apos;s disk.
              {inquiryDestinations.notion ? (
                <> Check Notion for the live feed.</>
              ) : null}
            </div>
          ) : (
            <ul className="ops__inbox-list">
              {recent.map((r, i) => (
                <li className="ops__inbox-row" key={i}>
                  <span className={`ops__kind ops__kind--${r.kind}`}>{r.kind}</span>
                  <span className="ops__inbox-who">{r.who}</span>
                  <span className="ops__inbox-email">{r.email}</span>
                  <span className="ops__inbox-meta">
                    {r.itemCount > 0 ? `${r.itemCount} item${r.itemCount === 1 ? "" : "s"}` : ""}
                  </span>
                  <span className="ops__inbox-time">
                    {r.submitted_at ? new Date(r.submitted_at).toLocaleString() : ""}
                  </span>
                  {r.details ? (
                    <p className="ops__inbox-details">{r.details.slice(0, 240)}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Row({ k, v, hot }: { k: string; v: string | number; hot?: boolean }) {
  return (
    <div className="ops__row">
      <span className="ops__row-k">{k}</span>
      <span className={`ops__row-v ${hot ? "hot" : ""}`}>{v}</span>
    </div>
  );
}
