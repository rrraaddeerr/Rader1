"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SetDoc, SetGroup, SetItem, SetResponse, SetStage } from "@/lib/sets";
import { SET_STAGES, SET_STAGE_LABELS, deriveStage } from "@/lib/sets";
import { DirectorChairIcon } from "@/components/Icons";

type CatalogItem = {
  barcode: string;
  title: string;
  subcategory: string;
  priceWeek: number | null;
  thumb: string | null;
};

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string };

function newGroupId() {
  return "g_" + Math.random().toString(36).slice(2, 10);
}

export function SetEditor({
  initialSet,
  initialResponses,
  catalog,
}: {
  initialSet: SetDoc;
  initialResponses: SetResponse[];
  catalog: CatalogItem[];
}) {
  const [doc, setDoc] = useState<SetDoc>(initialSet);
  const [responses, setResponses] = useState<SetResponse[]>(initialResponses);
  const [lastPolled, setLastPolled] = useState<number>(Date.now());
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [pickerSelected, setPickerSelected] = useState<Set<string>>(new Set());
  const [pickerCategory, setPickerCategory] = useState<string>("");

  // Poll for new responses every 12s — so if a client is voting live,
  // the operator sees responses arrive without manually refreshing.
  useEffect(() => {
    if (doc.unpublished) return;
    const fetchResponses = async () => {
      try {
        const res = await fetch(`/api/sets/${encodeURIComponent(doc.id)}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const json = await res.json();
        if (Array.isArray(json.responses)) {
          setResponses(json.responses);
          setLastPolled(Date.now());
        }
      } catch {
        // ignore network blips; next tick will retry
      }
    };
    const interval = setInterval(fetchResponses, 12_000);
    return () => clearInterval(interval);
  }, [doc.id, doc.unpublished]);

  // Auto-save 800 ms after the last change. `save.kind` is a dependency so
  // that when an in-flight save finishes, the effect re-runs and reschedules
  // any edit made during the flight (previously such trailing edits were
  // silently dropped while the status bar showed "saved").
  const lastSavedRef = useRef(JSON.stringify(initialSet));
  useEffect(() => {
    if (save.kind === "saving") return;
    const handle = setTimeout(async () => {
      const snapshot = JSON.stringify(doc);
      if (snapshot === lastSavedRef.current) return;
      setSave({ kind: "saving" });
      try {
        const res = await fetch(`/api/sets/${encodeURIComponent(doc.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: snapshot,
        });
        const json = await res.json();
        if (!res.ok || !json.ok) {
          setSave({ kind: "error", message: json.error ?? `HTTP ${res.status}` });
          return;
        }
        lastSavedRef.current = snapshot;
        setSave({ kind: "saved", at: Date.now() });
      } catch (err) {
        setSave({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }, 800);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, save.kind]);

  const updateDoc = (mutate: (d: SetDoc) => void) => {
    setDoc((prev) => {
      const next = structuredClone(prev);
      mutate(next);
      return next;
    });
  };

  // Auto-advance to 'reviewing' as soon as a response lands and we're still 'sent'.
  useEffect(() => {
    const current = deriveStage(doc);
    if (current === "sent" && responses.length > 0) {
      updateDoc((d) => {
        d.stage = "reviewing";
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [responses.length]);

  const setStage = (stage: SetStage) => {
    updateDoc((d) => {
      d.stage = stage;
      // Keep the legacy flags in sync so existing UI keeps working.
      if (stage === "draft") {
        d.unpublished = true;
        d.locked = false;
      } else if (stage === "returned") {
        d.unpublished = false;
        d.locked = true;
      } else {
        d.unpublished = false;
        if (stage === "approved" || stage === "production" || stage === "delivered") {
          d.locked = true;
        } else {
          d.locked = false;
        }
      }
    });
  };

  const addGroup = () =>
    updateDoc((d) => {
      d.groups.push({
        id: newGroupId(),
        label: "New section",
        pick: "any",
        items: [],
      });
    });

  const updateGroup = (gid: string, mutate: (g: SetGroup) => void) =>
    updateDoc((d) => {
      const g = d.groups.find((x) => x.id === gid);
      if (g) mutate(g);
    });

  const removeGroup = (gid: string) =>
    updateDoc((d) => {
      d.groups = d.groups.filter((g) => g.id !== gid);
    });

  const moveGroup = (gid: string, dir: -1 | 1) =>
    updateDoc((d) => {
      const i = d.groups.findIndex((g) => g.id === gid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.groups.length) return;
      [d.groups[i], d.groups[j]] = [d.groups[j], d.groups[i]];
    });

  const addItem = (gid: string, item: CatalogItem) =>
    updateGroup(gid, (g) => {
      if (g.items.find((i) => i.barcode === item.barcode)) return;
      g.items.push({ barcode: item.barcode });
    });

  const removeItem = (gid: string, barcode: string) =>
    updateGroup(gid, (g) => {
      g.items = g.items.filter((i) => i.barcode !== barcode);
    });

  const updateItem = (
    gid: string,
    barcode: string,
    mutate: (i: SetItem) => void
  ) =>
    updateGroup(gid, (g) => {
      const i = g.items.find((x) => x.barcode === barcode);
      if (i) mutate(i);
    });

  const moveItem = (gid: string, barcode: string, dir: -1 | 1) =>
    updateGroup(gid, (g) => {
      const i = g.items.findIndex((x) => x.barcode === barcode);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= g.items.length) return;
      [g.items[i], g.items[j]] = [g.items[j], g.items[i]];
    });

  const catalogCategories = useMemo(() => {
    const set = new Set<string>();
    for (const c of catalog) if (c.subcategory) set.add(c.subcategory);
    return [...set].sort();
  }, [catalog]);

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = catalog.filter((c) => {
      if (pickerCategory && c.subcategory !== pickerCategory) return false;
      if (!q) return true;
      const blob = `${c.title} ${c.subcategory} ${c.barcode}`.toLowerCase();
      return blob.includes(q);
    });
    return filtered.slice(0, 200);
  }, [search, catalog, pickerCategory]);

  const togglePickerSelection = (barcode: string) => {
    setPickerSelected((prev) => {
      const next = new Set(prev);
      if (next.has(barcode)) next.delete(barcode);
      else next.add(barcode);
      return next;
    });
  };

  const commitPickerSelection = () => {
    if (!pickerFor || pickerSelected.size === 0) return;
    const byBarcode = new Map<string, CatalogItem>();
    for (const c of catalog) byBarcode.set(c.barcode, c);
    updateGroup(pickerFor, (g) => {
      for (const bc of pickerSelected) {
        if (g.items.find((i) => i.barcode === bc)) continue;
        const c = byBarcode.get(bc);
        if (c) g.items.push({ barcode: bc });
      }
    });
    setPickerSelected(new Set());
    setPickerFor(null);
    setSearch("");
    setPickerCategory("");
  };

  const closePicker = () => {
    setPickerFor(null);
    setPickerSelected(new Set());
    setSearch("");
    setPickerCategory("");
  };

  const byBarcode = useMemo(() => {
    const m = new Map<string, CatalogItem>();
    for (const c of catalog) m.set(c.barcode, c);
    return m;
  }, [catalog]);

  const presentationUrl =
    typeof window !== "undefined" ? `${window.location.origin}/set/${doc.slug}` : "";

  const [linkCopied, setLinkCopied] = useState(false);
  const copyLink = async () => {
    if (!presentationUrl) return;
    try {
      await navigator.clipboard.writeText(presentationUrl);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      window.prompt("Copy this URL:", presentationUrl);
    }
  };

  const duplicateSet = async () => {
    if (typeof window !== "undefined" && !window.confirm("Create a copy of this set?")) return;
    try {
      const res = await fetch(`/api/sets/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: doc.id }),
      });
      const json = await res.json();
      if (json.ok && json.id) {
        window.location.href = `/sets/${json.id}`;
      } else {
        window.alert(`Couldn't duplicate: ${json.error ?? res.status}`);
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  };

  // Tally responses per item
  const tallies = useMemo(() => {
    const map = new Map<string, { approve: number; maybe: number; pass: number }>();
    for (const r of responses) {
      for (const [key, v] of Object.entries(r.decisions)) {
        const cur = map.get(key) ?? { approve: 0, maybe: 0, pass: 0 };
        if (v === "approve") cur.approve++;
        else if (v === "maybe") cur.maybe++;
        else if (v === "pass") cur.pass++;
        map.set(key, cur);
      }
    }
    return map;
  }, [responses]);

  return (
    <div className="set-edit">
      <div className="wrap">
        <div className="comms">
          <span className="comms__channel">
            CH {doc.id.slice(0, 4).toUpperCase()} — {SET_STAGE_LABELS[deriveStage(doc)].short}
          </span>
          <span className="comms__sep">/</span>
          <span>{doc.client || "no client yet"}</span>
          <span className="comms__sep">/</span>
          <span className="comms__signal" aria-hidden="true"><i/><i/><i/><i/></span>
          <span className="comms__over">
            {responses.length > 0
              ? `${responses.length} ${responses.length === 1 ? "VOTER" : "VOTERS"} ON CHANNEL`
              : "AWAITING RESPONSES"}
          </span>
        </div>

        <div className="stage-bar" role="group" aria-label="Production stage">
          <span className="stage-bar__label">STAGE</span>
          <ol className="stage-bar__steps">
            {SET_STAGES.map((s, i) => {
              const cur = deriveStage(doc);
              const curIdx = SET_STAGES.indexOf(cur);
              const isDone = i < curIdx;
              const isCur = s === cur;
              return (
                <li key={s} className={`stage-bar__step ${isCur ? "is-current" : ""} ${isDone ? "is-done" : ""}`}>
                  <button
                    type="button"
                    onClick={() => setStage(s)}
                    title={SET_STAGE_LABELS[s].long}
                    className="stage-bar__btn"
                  >
                    <span className="stage-bar__num">{String(i + 1).padStart(2, "0")}</span>
                    <span className="stage-bar__name">{SET_STAGE_LABELS[s].short}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
        <header className="set-edit__bar">
          <div className="set-edit__bar-meta">
            <Link href="/sets" className="curate__btn">← Sets</Link>
            <span className={`set-edit__save set-edit__save--${save.kind}`}>
              {save.kind === "saving"
                ? "◐ TRANSMITTING…"
                : save.kind === "saved"
                ? "● TRANSMISSION CLEAR"
                : save.kind === "error"
                ? `✗ FAILED: ${save.message}`
                : ""}
            </span>
          </div>
          <div className="set-edit__bar-actions">
            <button
              type="button"
              onClick={duplicateSet}
              className="curate__btn"
              title="Create a copy of this set as a starting point"
            >
              Duplicate
            </button>
            <button
              type="button"
              onClick={copyLink}
              className={`curate__btn ${linkCopied ? "curate__btn--accent" : ""}`}
              disabled={doc.unpublished}
              title={doc.unpublished ? "Publish first" : "Copy public URL"}
            >
              {linkCopied ? "Copied ✓" : "Copy share link"}
            </button>
            <Link
              href={`/set/${doc.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="curate__btn"
            >
              Preview ↗
            </Link>
          </div>
        </header>

        <section className="set-edit__head">
          <input
            type="text"
            value={doc.name}
            placeholder="Set name"
            onChange={(e) =>
              updateDoc((d) => {
                d.name = e.target.value;
              })
            }
            className="set-edit__title"
          />
          <div className="set-edit__head-row">
            <input
              type="text"
              value={doc.client ?? ""}
              placeholder="Client / director"
              onChange={(e) =>
                updateDoc((d) => {
                  d.client = e.target.value;
                })
              }
              className="set-edit__client"
            />
          </div>
          <textarea
            value={doc.intro ?? ""}
            placeholder="Intro shown to the client at the top of the page."
            onChange={(e) =>
              updateDoc((d) => {
                d.intro = e.target.value;
              })
            }
            className="set-edit__intro"
            rows={3}
          />

          {presentationUrl ? (
            <div className={`set-edit__share ${doc.unpublished ? "is-unpublished" : ""}`}>
              <div className="set-edit__share-label">
                {doc.unpublished ? "DRAFT — UNPUBLISHED" : "PUBLIC URL"}
              </div>
              <div className="set-edit__share-row">
                <code className="set-edit__share-url">{presentationUrl}</code>
                <button
                  type="button"
                  onClick={copyLink}
                  disabled={doc.unpublished}
                  className={`curate__btn ${linkCopied ? "curate__btn--accent" : ""}`}
                >
                  {linkCopied ? "Copied ✓" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (doc.unpublished || !presentationUrl) return;
                    const text = `${doc.intro?.trim() ?? ""}\n\n${presentationUrl}`.trim();
                    if (
                      typeof navigator !== "undefined" &&
                      "share" in navigator
                    ) {
                      try {
                        await navigator.share({
                          title: doc.name,
                          text,
                          url: presentationUrl,
                        });
                        return;
                      } catch {}
                    }
                    const subject = encodeURIComponent(
                      `${doc.name}${doc.client ? ` — for ${doc.client}` : ""}`
                    );
                    const body = encodeURIComponent(text);
                    window.location.href = `mailto:?subject=${subject}&body=${body}`;
                  }}
                  disabled={doc.unpublished}
                  className="curate__btn"
                  title="Open native share / email composer"
                >
                  Send
                </button>
              </div>
              {doc.unpublished ? (
                <div className="set-edit__share-hint">
                  Click <b>Publish</b> in the top bar to make this URL live for clients.
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        {doc.groups.length === 0 ? (
          <div className="set-edit__empty">
            <h3>No groups yet.</h3>
            <p>Add a group (e.g. "Seating", "Lighting") then add items to it.</p>
          </div>
        ) : null}

        {doc.groups.map((g, gi) => (
          <section key={g.id} className="set-edit__group">
            <header className="set-edit__group-head">
              <span className="set-edit__group-num">GRP {String(gi + 1).padStart(2, "0")}</span>
              <input
                type="text"
                value={g.label}
                onChange={(e) =>
                  updateGroup(g.id, (gr) => {
                    gr.label = e.target.value;
                  })
                }
                className="set-edit__group-label"
              />
              <span className="set-edit__group-count">
                {g.items.length} {g.items.length === 1 ? "item" : "items"}
              </span>
              <select
                value={g.pick ?? "any"}
                onChange={(e) =>
                  updateGroup(g.id, (gr) => {
                    gr.pick = e.target.value as SetGroup["pick"];
                  })
                }
                className="set-edit__group-pick"
              >
                <option value="any">Open — any combination</option>
                <option value="one">Pick one — alternatives</option>
                <option value="all">All confirmed — no choice</option>
              </select>
              <button
                type="button"
                onClick={() => moveGroup(g.id, -1)}
                disabled={gi === 0}
                className="curate__btn"
                aria-label="Move group up"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => moveGroup(g.id, 1)}
                disabled={gi >= doc.groups.length - 1}
                className="curate__btn"
                aria-label="Move group down"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => removeGroup(g.id)}
                className="curate__btn"
                aria-label="Delete group"
              >
                ✗
              </button>
            </header>

            <textarea
              value={g.note ?? ""}
              placeholder="Note for this group (optional) — context, materials, why this set."
              onChange={(e) =>
                updateGroup(g.id, (gr) => {
                  gr.note = e.target.value;
                })
              }
              className="set-edit__group-note"
              rows={2}
            />

            <div className="set-edit__items">
              {g.items.map((it, ii) => {
                const cat = byBarcode.get(it.barcode);
                const tally = tallies.get(`${g.id}:${it.barcode}`);
                return (
                  <div className="set-edit__item" key={it.barcode}>
                    <div className="set-edit__item-thumb">
                      {cat?.thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={cat.thumb} alt="" />
                      ) : (
                        <span className="muted mono">no img</span>
                      )}
                    </div>
                    <div className="set-edit__item-body">
                      <input
                        type="text"
                        value={it.title ?? cat?.title ?? ""}
                        placeholder={cat?.title ?? "Item title"}
                        onChange={(e) =>
                          updateItem(g.id, it.barcode, (i) => {
                            i.title = e.target.value || undefined;
                          })
                        }
                        className="set-edit__item-title"
                      />
                      <div className="set-edit__item-meta">
                        {cat?.priceWeek != null ? `$${cat.priceWeek}/wk · ` : ""}
                        {it.barcode}
                      </div>
                      <textarea
                        value={it.note ?? ""}
                        placeholder="Operator note — 'my pick', 'pairs with X', etc."
                        onChange={(e) =>
                          updateItem(g.id, it.barcode, (i) => {
                            i.note = e.target.value;
                          })
                        }
                        className="set-edit__item-note"
                        rows={2}
                      />
                    </div>
                    <div className="set-edit__item-actions">
                      <label className="set-edit__pick-toggle">
                        <input
                          type="checkbox"
                          checked={!!it.operatorPick}
                          onChange={(e) =>
                            updateItem(g.id, it.barcode, (i) => {
                              i.operatorPick = e.target.checked;
                            })
                          }
                        />
                        <span>★ pick</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => moveItem(g.id, it.barcode, -1)}
                        disabled={ii === 0}
                        className="curate__btn"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => moveItem(g.id, it.barcode, 1)}
                        disabled={ii >= g.items.length - 1}
                        className="curate__btn"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => removeItem(g.id, it.barcode)}
                        className="curate__btn"
                      >
                        ✗
                      </button>
                      {tally ? (
                        <div className="set-edit__tally">
                          <span style={{ color: "var(--tape)" }}>{tally.approve}✓</span>
                          {" "}<span style={{ color: "var(--muted)" }}>{tally.maybe}◐</span>
                          {" "}<span>{tally.pass}✗</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              <button
                type="button"
                className="set-edit__add-item"
                onClick={() => setPickerFor(g.id)}
              >
                <DirectorChairIcon size={18} />
                <span>+ Add items</span>
              </button>
            </div>
          </section>
        ))}

        <button
          type="button"
          className="curate__btn curate__btn--accent set-edit__add-group"
          onClick={addGroup}
        >
          + Add group
        </button>

        <section className="set-edit__responses">
          <header className="set-edit__responses-head">
            <h2>Responses ({responses.length})</h2>
            {!doc.unpublished ? (
              <span className="set-edit__responses-live">
                live · refreshed {Math.round((Date.now() - lastPolled) / 1000)}s ago
              </span>
            ) : null}
          </header>
          {responses.length === 0 ? (
            <div className="set-edit__responses-empty">
              {doc.unpublished
                ? "Publish the set to start collecting responses."
                : "No responses yet. Share the link and they'll appear here as people vote."}
            </div>
          ) : (
            responses.map((r) => {
              let approve = 0, maybe = 0, pass = 0;
              for (const v of Object.values(r.decisions ?? {})) {
                if (v === "approve") approve++;
                else if (v === "maybe") maybe++;
                else if (v === "pass") pass++;
              }
              return (
                <div className="set-edit__response" key={r.visitor}>
                  <div className="set-edit__response-head">
                    <b>{r.name}</b>
                    <span className="set-edit__response-tally">
                      <span style={{ color: "var(--tape)" }}>{approve} ✓</span>
                      {" "}<span style={{ color: "var(--muted)" }}>{maybe} ◐</span>
                      {" "}<span>{pass} ✗</span>
                    </span>
                    <span className="muted">
                      {new Date(r.updated_at).toLocaleString()}
                    </span>
                  </div>
                  {r.note ? <p className="set-edit__response-note">{r.note}</p> : null}
                </div>
              );
            })
          )}
        </section>
      </div>

      {pickerFor ? (
        <div className="set-picker" onClick={closePicker}>
          <div className="set-picker__panel" onClick={(e) => e.stopPropagation()}>
            <header className="set-picker__head">
              <input
                type="search"
                autoFocus
                placeholder="Search title, category, barcode…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="set-picker__search"
              />
              <select
                value={pickerCategory}
                onChange={(e) => setPickerCategory(e.target.value)}
                className="set-picker__cat"
                aria-label="Filter by category"
              >
                <option value="">All categories</option>
                {catalogCategories.map((c) => (
                  <option value={c} key={c}>{c}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={closePicker}
                className="curate__btn"
              >
                Close
              </button>
            </header>
            <div className="set-picker__hint">
              Tap tiles to select. Hit{" "}
              <b>Add selected</b> when done — adds them all to the group.
            </div>
            <div className="set-picker__grid">
              {filteredCatalog.map((c) => {
                const on = pickerSelected.has(c.barcode);
                return (
                <button
                  key={c.barcode}
                  type="button"
                  className={`set-picker__tile ${on ? "is-on" : ""}`}
                  onClick={() => togglePickerSelection(c.barcode)}
                  aria-pressed={on}
                >
                  <div className="set-picker__tile-img">
                    {c.thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.thumb} alt="" />
                    ) : null}
                    {on ? <span className="set-picker__tile-check">✓</span> : null}
                  </div>
                  <div className="set-picker__tile-name">{c.title}</div>
                  <div className="set-picker__tile-meta">
                    {c.subcategory}
                    {c.priceWeek != null ? ` · $${c.priceWeek}/wk` : ""}
                  </div>
                </button>
                );
              })}
              {filteredCatalog.length === 0 ? (
                <div className="muted">No matches.</div>
              ) : null}
            </div>
            <footer className="set-picker__foot">
              <span className="set-picker__count">
                {pickerSelected.size > 0
                  ? `${pickerSelected.size} selected`
                  : "Tap tiles to select"}
              </span>
              <button
                type="button"
                onClick={() => setPickerSelected(new Set())}
                disabled={pickerSelected.size === 0}
                className="curate__btn"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={commitPickerSelection}
                disabled={pickerSelected.size === 0}
                className="curate__btn curate__btn--accent"
              >
                Add selected ({pickerSelected.size})
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}
