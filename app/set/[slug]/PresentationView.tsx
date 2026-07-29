"use client";

import { useEffect, useMemo, useState } from "react";
import type { SetDoc, SetGroup, SetItem } from "@/lib/sets";
import { TapeLabel } from "@/components/TapeLabel";
import { BrandStamp } from "@/components/BrandStamp";

type CatalogEntry = {
  title: string;
  subcategory: string;
  priceWeek: number | null;
  thumb: string | null;
  dimensions?: string;
  description?: string;
};

type ResolvedItem = SetItem & { catalog: CatalogEntry | null };
type ResolvedGroup = Omit<SetGroup, "items"> & { items: ResolvedItem[] };

type Decision = "approve" | "maybe" | "pass";

const LOCAL_PREFIX = "rentco_visit_";

function loadLocal(setId: string): {
  visitor: string;
  name: string;
  decisions: Record<string, Decision>;
  note: string;
} {
  if (typeof window === "undefined") {
    return { visitor: "", name: "", decisions: {}, note: "" };
  }
  try {
    const raw = localStorage.getItem(LOCAL_PREFIX + setId);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { visitor: "", name: "", decisions: {}, note: "" };
}

function saveLocal(setId: string, state: object) {
  try {
    localStorage.setItem(LOCAL_PREFIX + setId, JSON.stringify(state));
  } catch {}
}

export function PresentationView({
  set,
  resolvedGroups,
}: {
  set: SetDoc;
  resolvedGroups: ResolvedGroup[];
}) {
  const [local, setLocal] = useState(() => loadLocal(set.id));
  const [hydrated, setHydrated] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [savedTick, setSavedTick] = useState(0);
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [syncError, setSyncError] = useState(false);
  const [lightbox, setLightbox] = useState<{
    src: string;
    title: string;
    index: number;
    group: string;
  } | null>(null);

  // Flat list of all visible items (for lightbox navigation across groups)
  const allItems = useMemo(() => {
    const out: { src: string; title: string; group: string }[] = [];
    for (const g of resolvedGroups) {
      for (const it of g.items) {
        const src = it.catalog?.thumb;
        if (!src) continue;
        out.push({ src, title: it.title || it.catalog?.title || "", group: g.label });
      }
    }
    return out;
  }, [resolvedGroups]);

  const openLightbox = (src: string, title: string, groupLabel: string) => {
    const index = allItems.findIndex((x) => x.src === src);
    setLightbox({ src, title, index: Math.max(0, index), group: groupLabel });
  };

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
      else if (e.key === "ArrowRight") {
        setLightbox((prev) => {
          if (!prev) return prev;
          const next = (prev.index + 1) % allItems.length;
          const nx = allItems[next];
          return { src: nx.src, title: nx.title, index: next, group: nx.group };
        });
      } else if (e.key === "ArrowLeft") {
        setLightbox((prev) => {
          if (!prev) return prev;
          const next = (prev.index - 1 + allItems.length) % allItems.length;
          const nx = allItems[next];
          return { src: nx.src, title: nx.title, index: next, group: nx.group };
        });
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [lightbox, allItems]);

  useEffect(() => {
    setLocal(loadLocal(set.id));
    setHydrated(true);
  }, [set.id]);

  useEffect(() => {
    if (hydrated) saveLocal(set.id, local);
  }, [local, hydrated, set.id]);

  // Server sync of the visitor's responses (same-origin proxy -> worker).
  const syncNow = async (opts?: { done?: boolean }): Promise<boolean> => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/respond/${encodeURIComponent(set.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          visitor: local.visitor || undefined,
          name: local.name,
          decisions: local.decisions,
          note: local.note,
          done: opts?.done,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (json.ok && json.visitor && !local.visitor) {
        setLocal((prev) => ({ ...prev, visitor: json.visitor }));
      }
      if (res.ok && json.ok !== false) {
        setSavedTick((t) => t + 1);
        setSyncError(false);
        return true;
      }
      setSyncError(true);
      return false;
    } catch {
      setSyncError(true);
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  // Debounced auto-save while voting.
  useEffect(() => {
    if (!hydrated) return;
    if (!local.name.trim()) return; // wait for them to enter a name
    const t = setTimeout(() => {
      void syncNow();
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local.decisions, local.note, local.name, hydrated]);

  const decide = (key: string, d: Decision) => {
    setLocal((prev) => {
      const next = { ...prev, decisions: { ...prev.decisions } };
      if (next.decisions[key] === d) delete next.decisions[key];
      else next.decisions[key] = d;
      return next;
    });
  };

  const totals = useMemo(() => {
    let approve = 0, maybe = 0, pass = 0;
    for (const v of Object.values(local.decisions)) {
      if (v === "approve") approve++;
      else if (v === "maybe") maybe++;
      else if (v === "pass") pass++;
    }
    return { approve, maybe, pass };
  }, [local.decisions]);

  return (
    <div className="present">
      <header className="present__head dp-bg">
        <div className="present__head-inner wrap">
          <div className="present__slate">
            <span className="present__slate-tag">RENT.CO // OPERATOR PROPOSAL</span>
            <span className="present__slate-sep" aria-hidden="true">│</span>
            <span className="present__slate-tag">CHANNEL {set.id.slice(0, 4).toUpperCase()}</span>
            <span className="present__slate-sep" aria-hidden="true">│</span>
            <span className="present__slate-tag">{set.locked ? "CLOSED" : "OPEN"}</span>
          </div>
          <h1 className="present__title">{set.name}</h1>
          {set.client ? (
            <div className="present__client">
              <span className="present__client-prefix">FOR ↘</span>
              {set.client}
            </div>
          ) : null}
          {set.intro ? <p className="present__intro">{set.intro}</p> : null}
        </div>
      </header>

      <div className="wrap">
        <section className="present__visitor">
          <label>
            <span className="present__visitor-k">Your name</span>
            <input
              type="text"
              value={local.name}
              onChange={(e) =>
                setLocal((prev) => ({ ...prev, name: e.target.value }))
              }
              placeholder="So I know whose responses these are"
              className="present__visitor-input"
            />
          </label>
          <div className="present__visitor-tally">
            <b style={{ color: "var(--tape)" }}>{totals.approve}</b> approve ·{" "}
            <b style={{ color: "var(--muted)" }}>{totals.maybe}</b> maybe ·{" "}
            <b>{totals.pass}</b> pass
            {savedTick > 0 && local.name.trim() ? (
              <span className="present__visitor-saved">saved {submitting ? "…" : "✓"}</span>
            ) : null}
          </div>
        </section>

        {resolvedGroups.length > 1 ? (
          <nav className="present__nav" aria-label="Jump to section">
            {resolvedGroups.map((g) => {
              const decided = g.items.filter(
                (it) => local.decisions[`${g.id}:${it.barcode}`]
              ).length;
              return (
                <a key={g.id} href={`#${g.id}`}>
                  {g.label}
                  <span className="present__nav-count">
                    {decided}/{g.items.length}
                  </span>
                </a>
              );
            })}
          </nav>
        ) : null}

        {resolvedGroups.map((g, gi) => (
          <section className="present__group" key={g.id} id={g.id}>
            {gi > 0 ? (
              <div className="present__group-break" aria-hidden="true">
                <span className="present__group-break-roll">
                  ROLL {String(gi + 1).padStart(2, "0")}
                </span>
              </div>
            ) : null}
            <header className="present__group-head">
              <span className="present__group-num">{String(gi + 1).padStart(2, "0")}</span>
              <h2 className="present__group-h2">
                <TapeLabel className="present__group-tape" rotate={gi % 2 === 0 ? -2 : 1.5}>
                  {g.label}
                </TapeLabel>
              </h2>
              {g.pick === "one" ? (
                <span className="present__pick-tag">PICK ONE</span>
              ) : g.pick === "all" ? (
                <span className="present__pick-tag">CONFIRMED</span>
              ) : (
                <span className="present__pick-tag">OPEN</span>
              )}
            </header>
            {g.note ? <p className="present__group-note">{g.note}</p> : null}
            <div className="present__items">
              {g.items.map((it) => {
                const key = `${g.id}:${it.barcode}`;
                const d = local.decisions[key];
                const c = it.catalog;
                return (
                  <article
                    key={it.barcode}
                    className={`present-item ${d ? `present-item--${d}` : ""}`}
                  >
                    <button
                      type="button"
                      className="present-item__media"
                      onClick={() =>
                        c?.thumb &&
                        openLightbox(
                          c.thumb,
                          it.title || c?.title || "",
                          g.label
                        )
                      }
                      disabled={!c?.thumb}
                      aria-label={`View photo of ${it.title || c?.title || "item"}`}
                    >
                      {c?.thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.thumb} alt={it.title || c?.title || ""} />
                      ) : (
                        <div className="present-item__noimg">no image</div>
                      )}
                      {it.operatorPick ? (
                        <span className="present-item__pick">★ operator pick</span>
                      ) : null}
                      <span className="present-item__zoom" aria-hidden="true">⤢</span>
                    </button>
                    <div className="present-item__body">
                      <h3 className="present-item__title">
                        {it.title || c?.title || "Untitled"}
                      </h3>
                      {c?.dimensions ? (
                        <div className="present-item__meta">{c.dimensions}</div>
                      ) : null}
                      {c?.priceWeek != null ? (
                        <div className="present-item__price">${c.priceWeek}/wk</div>
                      ) : null}
                      {it.note ? (
                        <p className="present-item__note">
                          <span className="present-item__note-from">— Rader</span>
                          {it.note}
                        </p>
                      ) : null}
                    </div>
                    <div className="present-item__actions">
                      <button
                        type="button"
                        className={`present-item__btn present-item__btn--approve ${d === "approve" ? "is-on" : ""}`}
                        onClick={() => decide(key, "approve")}
                        disabled={set.locked}
                      >
                        ✓ Approve
                      </button>
                      <button
                        type="button"
                        className={`present-item__btn present-item__btn--maybe ${d === "maybe" ? "is-on" : ""}`}
                        onClick={() => decide(key, "maybe")}
                        disabled={set.locked}
                      >
                        ◐ Maybe
                      </button>
                      <button
                        type="button"
                        className={`present-item__btn present-item__btn--pass ${d === "pass" ? "is-on" : ""}`}
                        onClick={() => decide(key, "pass")}
                        disabled={set.locked}
                      >
                        ✗ Pass
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ))}

        <button
          type="button"
          className="present__print"
          onClick={() => typeof window !== "undefined" && window.print()}
          aria-label="Print or save as PDF"
        >
          Print / PDF
        </button>

        <aside className="present__signed">
          <BrandStamp size={86} className="present__signed-stamp" />
          <div className="present__signed-meta">
            <div className="present__signed-label">PROPOSAL BY</div>
            <div className="present__signed-name">RADERENT</div>
            <div className="present__signed-sub">VANCOUVER HQ · ACCESS ANYWHERE</div>
          </div>
        </aside>

        <section className="present__final">
          <label>
            <span className="present__visitor-k">Anything else?</span>
            <textarea
              value={local.note}
              onChange={(e) =>
                setLocal((prev) => ({ ...prev, note: e.target.value }))
              }
              placeholder="Notes, sizes, sub-requests — anything I should know."
              className="present__visitor-input"
              rows={4}
              disabled={set.locked}
            />
          </label>
          {set.locked ? (
            <p className="muted" style={{ marginTop: 12 }}>
              This proposal is closed for new responses.
            </p>
          ) : sent ? (
            <div className="present__thanks" role="status" aria-live="polite">
              <h2>Thanks, {local.name || "friend"}.</h2>
              <p>
                Your responses are with Rader. He&apos;ll confirm and follow up.
                You can come back to this link anytime to revise — your name is
                remembered.
              </p>
              <div className="present__thanks-tally">
                <b style={{ color: "var(--tape)" }}>{totals.approve}</b> approve ·{" "}
                <b style={{ color: "var(--muted)" }}>{totals.maybe}</b> maybe ·{" "}
                <b>{totals.pass}</b> pass
              </div>
              <button
                type="button"
                className="curate__btn"
                onClick={() => setSent(false)}
                style={{ marginTop: 16 }}
              >
                Revise responses
              </button>
            </div>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 12 }}>
                Auto-saves as you go. When you&apos;re done, hit{" "}
                <b style={{ color: "var(--accent)" }}>Send to Rader</b> and he&apos;ll
                see it&apos;s ready to act on.
              </p>
              {syncError ? (
                <p role="alert" style={{ marginTop: 12, color: "var(--accent)" }}>
                  Couldn&apos;t save your responses just now — check your
                  connection and try again. Nothing is lost on this device.
                </p>
              ) : null}
              <button
                type="button"
                className="curate__btn curate__btn--accent present__send"
                onClick={async () => {
                  if (!local.name.trim()) {
                    if (typeof window !== "undefined") {
                      window.alert("Please add your name first so Rader knows whose responses these are.");
                    }
                    return;
                  }
                  setSending(true);
                  const ok = await syncNow({ done: true });
                  setSending(false);
                  if (ok) {
                    setSent(true);
                    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
                  }
                }}
                disabled={!local.name.trim() || sending}
              >
                {sending ? "Sending…" : "✓ Send to Rader"}
              </button>
            </>
          )}
        </section>
      </div>

      {lightbox ? (
        <div
          className="present__lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`Photo of ${lightbox.title}`}
          onClick={(e) => {
            if (e.target === e.currentTarget) setLightbox(null);
          }}
        >
          <button
            type="button"
            className="present__lightbox-close"
            onClick={() => setLightbox(null)}
            aria-label="Close"
          >
            Close ✕
          </button>

          {allItems.length > 1 ? (
            <button
              type="button"
              className="present__lightbox-nav present__lightbox-nav--prev"
              onClick={() => {
                const next = (lightbox.index - 1 + allItems.length) % allItems.length;
                const nx = allItems[next];
                setLightbox({ src: nx.src, title: nx.title, index: next, group: nx.group });
              }}
              aria-label="Previous image"
            >
              ‹
            </button>
          ) : null}

          <figure className="present__lightbox-figure" onClick={() => setLightbox(null)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={lightbox.src} alt={lightbox.title} />
            <figcaption>
              <div className="present__lightbox-title">{lightbox.title}</div>
              <div className="present__lightbox-meta">
                {lightbox.group} · {lightbox.index + 1} / {allItems.length}
              </div>
            </figcaption>
          </figure>

          {allItems.length > 1 ? (
            <button
              type="button"
              className="present__lightbox-nav present__lightbox-nav--next"
              onClick={() => {
                const next = (lightbox.index + 1) % allItems.length;
                const nx = allItems[next];
                setLightbox({ src: nx.src, title: nx.title, index: next, group: nx.group });
              }}
              aria-label="Next image"
            >
              ›
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
