"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { VPCItem } from "@/lib/vpc-catalog";

type Decision = "keep" | "cut" | "star";
type Verdict = "skip" | "review" | "takeAll";
type SubcategoryStat = { subcategory: string; count: number; withPhoto: number };

const DECISIONS_KEY = "rentco_curate_v1";
const RENAMES_KEY = "rentco_curate_renames_v1";
const SORT_KEY = "rentco_curate_sort_v1";

function loadJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key: string, val: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

export function CurateBrowser({
  items,
  subcategories,
}: {
  items: VPCItem[];
  subcategories: SubcategoryStat[];
}) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [hydrated, setHydrated] = useState(false);
  const [selectedSubs, setSelectedSubs] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [photoOnly, setPhotoOnly] = useState(false);
  const [showDecided, setShowDecided] = useState(true);
  const [showCut, setShowCut] = useState(false);
  const [subSearch, setSubSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(true);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingFor, setRenamingFor] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [focusedBarcode, setFocusedBarcode] = useState<string | null>(null);

  useEffect(() => {
    setDecisions(loadJSON<Record<string, Decision>>(DECISIONS_KEY, {}));
    setRenames(loadJSON<Record<string, string>>(RENAMES_KEY, {}));
    setVerdicts(loadJSON<Record<string, Verdict>>(SORT_KEY, {}));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) saveJSON(DECISIONS_KEY, decisions);
  }, [decisions, hydrated]);

  useEffect(() => {
    if (hydrated) saveJSON(RENAMES_KEY, renames);
  }, [renames, hydrated]);

  useEffect(() => {
    if (hydrated) saveJSON(SORT_KEY, verdicts);
  }, [verdicts, hydrated]);

  // Barcodes grouped by their VPC subcategory — for bulk operations.
  const barcodesBySubcategory = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const it of items) {
      const key = it.subcategory || "(uncategorized)";
      const arr = map.get(key) ?? [];
      arr.push(it.barcode);
      map.set(key, arr);
    }
    return map;
  }, [items]);

  const setDecision = (barcode: string, d: Decision | null) => {
    setDecisions((prev) => {
      const next = { ...prev };
      if (d === null) delete next[barcode];
      else next[barcode] = d;
      return next;
    });
  };

  const cutWholeSubcategory = (sub: string) => {
    const barcodes = barcodesBySubcategory.get(sub) ?? [];
    setDecisions((prev) => {
      const next = { ...prev };
      for (const b of barcodes) next[b] = "cut";
      return next;
    });
    setMenuFor(null);
  };

  const restoreWholeSubcategory = (sub: string) => {
    const barcodes = barcodesBySubcategory.get(sub) ?? [];
    setDecisions((prev) => {
      const next = { ...prev };
      for (const b of barcodes) delete next[b];
      return next;
    });
    setMenuFor(null);
  };

  const startRename = (sub: string) => {
    setRenamingFor(sub);
    setRenameDraft(renames[sub] ?? "");
    setMenuFor(null);
  };

  const commitRename = (sub: string) => {
    const draft = renameDraft.trim();
    setRenames((prev) => {
      const next = { ...prev };
      if (!draft || draft === sub) delete next[sub];
      else next[sub] = draft;
      return next;
    });
    setRenamingFor(null);
    setRenameDraft("");
  };

  const cancelRename = () => {
    setRenamingFor(null);
    setRenameDraft("");
  };

  const counts = useMemo(() => {
    let keep = 0, cut = 0, star = 0;
    for (const it of items) {
      if (verdicts[it.subcategory] === "skip") continue;
      const dec = decisions[it.barcode] ??
        (verdicts[it.subcategory] === "takeAll" ? ("keep" as Decision) : undefined);
      if (dec === "keep") keep++;
      else if (dec === "cut") cut++;
      else if (dec === "star") star++;
    }
    return { keep, cut, star, total: items.length };
  }, [decisions, verdicts, items]);

  const sortStats = useMemo(() => {
    let skipSubs = 0, reviewSubs = 0, takeAllSubs = 0, takeAllItems = 0;
    for (const s of subcategories) {
      const v = verdicts[s.subcategory];
      if (v === "skip") skipSubs++;
      else if (v === "review") reviewSubs++;
      else if (v === "takeAll") {
        takeAllSubs++;
        takeAllItems += s.count;
      }
    }
    return { skipSubs, reviewSubs, takeAllSubs, takeAllItems };
  }, [subcategories, verdicts]);

  // Per-subcategory decision rollups so chips can show progress.
  const subStateBySub = useMemo(() => {
    const out = new Map<
      string,
      { decided: number; cut: number; keep: number; star: number; total: number }
    >();
    for (const stat of subcategories) {
      const bs = barcodesBySubcategory.get(stat.subcategory) ?? [];
      let cut = 0, keep = 0, star = 0;
      for (const b of bs) {
        const d = decisions[b];
        if (d === "cut") cut++;
        else if (d === "keep") keep++;
        else if (d === "star") star++;
      }
      out.set(stat.subcategory, {
        decided: cut + keep + star,
        cut,
        keep,
        star,
        total: bs.length,
      });
    }
    return out;
  }, [subcategories, barcodesBySubcategory, decisions]);

  const effective = (it: VPCItem): Decision | undefined => {
    const explicit = decisions[it.barcode];
    if (explicit) return explicit;
    return verdicts[it.subcategory] === "takeAll" ? "keep" : undefined;
  };

  const filteredSubs = useMemo(() => {
    const q = subSearch.trim().toLowerCase();
    return subcategories.filter((s) => {
      // Sort-skipped categories are hidden entirely from the picker.
      if (verdicts[s.subcategory] === "skip") return false;
      if (!q) return true;
      const label = (renames[s.subcategory] ?? s.subcategory).toLowerCase();
      return label.includes(q) || s.subcategory.toLowerCase().includes(q);
    });
  }, [subSearch, subcategories, renames, verdicts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (verdicts[it.subcategory] === "skip") return false;
      if (selectedSubs.size > 0 && !selectedSubs.has(it.subcategory)) return false;
      if (photoOnly && !it.photo && !it.thumb) return false;
      const dec = effective(it);
      if (!showDecided && dec) return false;
      if (!showCut && dec === "cut") return false;
      if (q) {
        const blob = `${it.name} ${it.description} ${it.subcategory} ${it.barcode}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, selectedSubs, photoOnly, showDecided, showCut, search, decisions, verdicts]);

  // Keyboard shortcuts for the visible grid — 1/2/3 decide on the focused
  // card, arrow keys move focus. When nothing is focused, the first decision
  // key auto-focuses the first item.
  useEffect(() => {
    if (filtered.length === 0) {
      if (focusedBarcode !== null) setFocusedBarcode(null);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.target instanceof HTMLSelectElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const idx = focusedBarcode
        ? filtered.findIndex((it) => it.barcode === focusedBarcode)
        : -1;

      const focusAt = (i: number) => {
        const it = filtered[Math.max(0, Math.min(i, filtered.length - 1))];
        if (!it) return;
        setFocusedBarcode(it.barcode);
        if (typeof document !== "undefined") {
          const el = document.querySelector(`[data-barcode="${it.barcode}"]`);
          el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      };

      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        focusAt(idx < 0 ? 0 : idx + 1);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        focusAt(idx < 0 ? 0 : idx - 1);
      } else if (e.key === "Escape") {
        setFocusedBarcode(null);
      } else if (e.key === "1" || e.key === "c" || e.key === "x") {
        e.preventDefault();
        const target = idx >= 0 ? filtered[idx] : filtered[0];
        if (target) {
          const cur = effective(target);
          setDecision(target.barcode, cur === "cut" ? null : "cut");
          focusAt((idx < 0 ? 0 : idx) + 1);
        }
      } else if (e.key === "2" || e.key === "s") {
        e.preventDefault();
        const target = idx >= 0 ? filtered[idx] : filtered[0];
        if (target) {
          const cur = effective(target);
          setDecision(target.barcode, cur === "star" ? null : "star");
          focusAt((idx < 0 ? 0 : idx) + 1);
        }
      } else if (e.key === "3" || e.key === "Enter") {
        e.preventDefault();
        const target = idx >= 0 ? filtered[idx] : filtered[0];
        if (target) {
          const cur = effective(target);
          setDecision(target.barcode, cur === "keep" ? null : "keep");
          focusAt((idx < 0 ? 0 : idx) + 1);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, focusedBarcode, decisions, verdicts]);

  const importPicks = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      const mode =
        typeof window !== "undefined" &&
        window.confirm(
          "Import picks?\n\nOK = merge with current decisions (existing wins)\nCancel = replace everything"
        );
      if (!mode) {
        // Replace
        const nextDec: Record<string, Decision> = {};
        for (const b of parsed.keep ?? []) {
          if (typeof b === "string") nextDec[b] = "keep";
        }
        for (const b of parsed.star ?? []) {
          if (typeof b === "string") nextDec[b] = "star";
        }
        for (const b of parsed.cut ?? []) {
          if (typeof b === "string") nextDec[b] = "cut";
        }
        setDecisions(nextDec);
        setRenames(parsed.renames && typeof parsed.renames === "object" ? parsed.renames : {});
        setVerdicts(
          parsed.subcategoryVerdicts && typeof parsed.subcategoryVerdicts === "object"
            ? parsed.subcategoryVerdicts
            : {}
        );
      } else {
        // Merge — current decisions stay, imported only fills gaps
        setDecisions((prev) => {
          const next = { ...prev };
          for (const b of parsed.keep ?? []) {
            if (typeof b === "string" && !next[b]) next[b] = "keep";
          }
          for (const b of parsed.star ?? []) {
            if (typeof b === "string" && !next[b]) next[b] = "star";
          }
          for (const b of parsed.cut ?? []) {
            if (typeof b === "string" && !next[b]) next[b] = "cut";
          }
          return next;
        });
        if (parsed.renames && typeof parsed.renames === "object") {
          setRenames((prev) => ({ ...parsed.renames, ...prev }));
        }
        if (parsed.subcategoryVerdicts && typeof parsed.subcategoryVerdicts === "object") {
          setVerdicts((prev) => ({ ...parsed.subcategoryVerdicts, ...prev }));
        }
      }
    } catch (err) {
      if (typeof window !== "undefined") {
        window.alert(
          `Couldn't read that file. Expected a rentco-curate-*.json from Export.\n\n${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  };

  const toggleSub = (sub: string) => {
    setSelectedSubs((prev) => {
      const next = new Set(prev);
      if (next.has(sub)) next.delete(sub);
      else next.add(sub);
      return next;
    });
  };

  const exportPicks = () => {
    // Build the effective keep/cut/star lists, combining explicit per-item
    // decisions with "take all" subcategories (every item auto-kept).
    const keep: string[] = [];
    const star: string[] = [];
    const cut: string[] = [];
    for (const it of items) {
      if (verdicts[it.subcategory] === "skip") continue;
      const explicit = decisions[it.barcode];
      const eff = explicit ??
        (verdicts[it.subcategory] === "takeAll" ? "keep" : undefined);
      if (eff === "star") {
        star.push(it.barcode);
        keep.push(it.barcode);
      } else if (eff === "keep") {
        keep.push(it.barcode);
      } else if (eff === "cut") {
        cut.push(it.barcode);
      }
    }
    const out = {
      generated: new Date().toISOString(),
      counts,
      renames,
      subcategoryVerdicts: verdicts,
      keep,
      star,
      cut,
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `rentco-curate-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  };

  if (!hydrated) {
    return (
      <div className="curate__loading">
        <span className="mono">Loading curate…</span>
      </div>
    );
  }

  return (
    <div className="curate__shell">
      <div className="comms">
        <span className="comms__channel">CH 07 — CURATE</span>
        <span className="comms__sep">/</span>
        <span>RaderENT inventory ops</span>
        <span className="comms__sep">/</span>
        <span className="comms__signal" aria-hidden="true"><i/><i/><i/><i/></span>
        <span className="comms__over">{counts.keep + counts.star} ON DECK · {counts.cut} CUT</span>
      </div>
      <header className="curate__bar">
        <div className="curate__bar-meta">
          <span className="curate__title">CURATE</span>
          <span className="curate__counts">
            <b>{counts.keep + counts.star}</b> keep
            {counts.star ? <> · <b className="hot">{counts.star}</b> ★</> : null}
            {" · "}<b>{counts.cut}</b> cut
            {" · "}<span className="muted">{counts.total} total</span>
          </span>
        </div>
        <div className="curate__bar-actions">
          <Link href="/curate/sort" className="curate__btn">
            Sort subcategories →
          </Link>
          <Link href="/curate/preview" className="curate__btn">
            Preview →
          </Link>
          <button
            type="button"
            className="curate__btn"
            onClick={() => setPickerOpen((v) => !v)}
            aria-expanded={pickerOpen}
          >
            {pickerOpen ? "Hide" : "Show"} subcategories
            {selectedSubs.size > 0 ? ` (${selectedSubs.size})` : ""}
          </button>
          <label className="curate__btn curate__btn--ghost-file">
            Import
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                if (f) importPicks(f);
                e.currentTarget.value = "";
              }}
              hidden
            />
          </label>
          <button type="button" className="curate__btn curate__btn--accent" onClick={exportPicks}>
            Export picks
          </button>
        </div>
      </header>

      {(sortStats.skipSubs > 0 || sortStats.takeAllSubs > 0) ? (
        <div className="curate__sortbanner">
          <span>
            Sort active:{" "}
            {sortStats.skipSubs ? (
              <><b>{sortStats.skipSubs}</b> subs hidden</>
            ) : null}
            {sortStats.skipSubs && sortStats.takeAllSubs ? " · " : ""}
            {sortStats.takeAllSubs ? (
              <>
                <b className="hot">{sortStats.takeAllSubs}</b> taking all (
                <b>{sortStats.takeAllItems}</b> auto-kept)
              </>
            ) : null}
          </span>
          <Link href="/curate/sort" className="curate__sortbanner-link">
            Adjust →
          </Link>
        </div>
      ) : null}

      {pickerOpen ? (
        <aside className="curate__picker" aria-label="Subcategory picker">
          <div className="curate__picker-head">
            <input
              type="search"
              placeholder="Filter subcategories…"
              value={subSearch}
              onChange={(e) => setSubSearch(e.target.value)}
              className="curate__sub-search"
              aria-label="Filter subcategories"
            />
            <div className="curate__picker-actions">
              <button
                type="button"
                className="curate__chip"
                onClick={() => setSelectedSubs(new Set())}
                disabled={selectedSubs.size === 0}
              >
                Clear ({selectedSubs.size})
              </button>
              <button
                type="button"
                className="curate__chip"
                onClick={() =>
                  setSelectedSubs(new Set(filteredSubs.map((s) => s.subcategory)))
                }
              >
                Select visible ({filteredSubs.length})
              </button>
            </div>
          </div>
          <div className="curate__sub-grid" role="listbox" aria-multiselectable="true">
            {filteredSubs.map((s) => {
              const on = selectedSubs.has(s.subcategory);
              const state = subStateBySub.get(s.subcategory);
              const allCut = state && state.total > 0 && state.cut === state.total;
              const renamedTo = renames[s.subcategory];
              const isRenaming = renamingFor === s.subcategory;
              const menuOpen = menuFor === s.subcategory;
              const label = renamedTo ?? s.subcategory;

              return (
                <div
                  key={s.subcategory}
                  className={`curate__subwrap ${allCut ? "is-allcut" : ""}`}
                >
                  {isRenaming ? (
                    <div className="curate__sub-rename">
                      <input
                        type="text"
                        value={renameDraft}
                        autoFocus
                        onChange={(e) => setRenameDraft(e.target.value)}
                        placeholder={s.subcategory}
                        className="curate__sub-rename-input"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(s.subcategory);
                          else if (e.key === "Escape") cancelRename();
                        }}
                      />
                      <button
                        type="button"
                        className="curate__sub-rename-btn"
                        onClick={() => commitRename(s.subcategory)}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="curate__sub-rename-btn curate__sub-rename-btn--ghost"
                        onClick={cancelRename}
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        role="option"
                        aria-selected={on}
                        className={`curate__sub ${on ? "is-on" : ""}`}
                        onClick={() => toggleSub(s.subcategory)}
                        title={
                          renamedTo
                            ? `Renamed from "${s.subcategory}" · ${s.count} items · ${s.withPhoto} with photo`
                            : `${s.count} items · ${s.withPhoto} with photo`
                        }
                      >
                        <span className="curate__sub-name">
                          {label}
                          {renamedTo ? (
                            <span className="curate__sub-was">was: {s.subcategory}</span>
                          ) : null}
                        </span>
                        <span className="curate__sub-counts">
                          {state && state.decided > 0 ? (
                            <span className="curate__sub-progress">
                              {state.decided}/{state.total}
                            </span>
                          ) : (
                            <span>{s.count}</span>
                          )}
                          {s.withPhoto > 0 ? (
                            <span className="curate__sub-photos"> · {s.withPhoto}📷</span>
                          ) : null}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="curate__sub-menu-btn"
                        aria-label={`Actions for ${label}`}
                        aria-expanded={menuOpen}
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuFor(menuOpen ? null : s.subcategory);
                        }}
                      >
                        ⋯
                      </button>
                      {menuOpen ? (
                        <div className="curate__sub-menu" role="menu">
                          <button
                            type="button"
                            className="curate__sub-menu-item"
                            onClick={() => startRename(s.subcategory)}
                            role="menuitem"
                          >
                            ✎ Rename…
                          </button>
                          <button
                            type="button"
                            className="curate__sub-menu-item curate__sub-menu-item--danger"
                            onClick={() => cutWholeSubcategory(s.subcategory)}
                            role="menuitem"
                          >
                            ✗ Cut all {s.count}
                          </button>
                          {state && state.decided > 0 ? (
                            <button
                              type="button"
                              className="curate__sub-menu-item"
                              onClick={() => restoreWholeSubcategory(s.subcategory)}
                              role="menuitem"
                            >
                              ↺ Reset decisions ({state.decided})
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </aside>
      ) : null}

      <div className="curate__toolbar">
        <input
          type="search"
          placeholder="Search name, description, barcode…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="curate__search"
          aria-label="Search items"
        />
        <label className="curate__toggle">
          <input
            type="checkbox"
            checked={photoOnly}
            onChange={(e) => setPhotoOnly(e.target.checked)}
          />
          <span>Photo only</span>
        </label>
        <label className="curate__toggle">
          <input
            type="checkbox"
            checked={showDecided}
            onChange={(e) => setShowDecided(e.target.checked)}
          />
          <span>Show already-decided</span>
        </label>
        <label className="curate__toggle">
          <input
            type="checkbox"
            checked={showCut}
            onChange={(e) => setShowCut(e.target.checked)}
          />
          <span>Show cut</span>
        </label>
        <div className="curate__filtered-count">
          {filtered.length} {filtered.length === 1 ? "item" : "items"} shown
        </div>
      </div>

      {filtered.length > 0 ? (
        <div className="curate__hotkeys" aria-hidden="true">
          <kbd>1</kbd> cut · <kbd>2</kbd> ★ star · <kbd>3</kbd> keep
          {" · "}
          <kbd>↑</kbd><kbd>↓</kbd> nav · <kbd>esc</kbd> unfocus
        </div>
      ) : null}

      <div className="curate__grid">
        {selectedSubs.size === 0 && !search ? (
          <div className="curate__empty">
            <h3>Pick a subcategory to start.</h3>
            <p>
              Tap subcategories in the picker above to scope what you&apos;re reviewing.
              You can also search across everything from the toolbar. Use the ⋯ menu
              on a subcategory to bulk-cut or rename it.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="curate__empty">
            <h3>Nothing matches.</h3>
            <p>Loosen the filters or pick another subcategory.</p>
          </div>
        ) : (
          filtered.map((it) => (
            <ItemCard
              key={it.barcode}
              item={it}
              decision={effective(it)}
              fromTakeAll={
                !decisions[it.barcode] && verdicts[it.subcategory] === "takeAll"
              }
              focused={focusedBarcode === it.barcode}
              onFocus={() => setFocusedBarcode(it.barcode)}
              onSet={setDecision}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ItemCard({
  item,
  decision,
  fromTakeAll,
  focused,
  onFocus,
  onSet,
}: {
  item: VPCItem;
  decision?: Decision;
  fromTakeAll?: boolean;
  focused?: boolean;
  onFocus?: () => void;
  onSet: (b: string, d: Decision | null) => void;
}) {
  const set = (d: Decision) => onSet(item.barcode, decision === d ? null : d);
  return (
    <article
      data-barcode={item.barcode}
      onClick={onFocus}
      className={`ccard ccard--${decision ?? "undecided"} ${fromTakeAll ? "ccard--takeall" : ""} ${focused ? "ccard--focused" : ""}`}
    >
      <div className="ccard__media">
        {item.thumb || item.photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.thumb ?? item.photo!}
            alt={item.name}
            loading="lazy"
          />
        ) : (
          <div className="ccard__noimg">
            <span className="ccard__noimg-label">{item.subcategory || "—"}</span>
            <span className="ccard__noimg-meta">no photo</span>
          </div>
        )}
        {decision ? (
          <span className={`ccard__badge ccard__badge--${decision}`}>
            {fromTakeAll && decision === "keep"
              ? "★ TAKE-ALL"
              : decision === "keep"
              ? "KEPT"
              : decision === "star"
              ? "★ STAR"
              : "CUT"}
          </span>
        ) : null}
      </div>
      <div className="ccard__body">
        <div className="ccard__sub">{item.subcategory}</div>
        <div className="ccard__name">{item.name || "(no name)"}</div>
        {item.description ? (
          <div className="ccard__desc">{item.description}</div>
        ) : null}
        <div className="ccard__meta">
          <span className="ccard__price">
            {item.priceWeek != null ? `$${item.priceWeek}/wk` : "On inquiry"}
          </span>
          <span className="ccard__barcode" title={item.barcode}>{item.barcode}</span>
        </div>
        {item.size ? <div className="ccard__size">{item.size}</div> : null}
      </div>
      <div className="ccard__actions">
        <button
          type="button"
          className={`ccard__btn ccard__btn--cut ${decision === "cut" ? "is-on" : ""}`}
          onClick={() => set("cut")}
          aria-pressed={decision === "cut"}
        >
          ✗ Cut
        </button>
        <button
          type="button"
          className={`ccard__btn ccard__btn--star ${decision === "star" ? "is-on" : ""}`}
          onClick={() => set("star")}
          aria-pressed={decision === "star"}
        >
          ★ Star
        </button>
        <button
          type="button"
          className={`ccard__btn ccard__btn--keep ${decision === "keep" ? "is-on" : ""}`}
          onClick={() => set("keep")}
          aria-pressed={decision === "keep"}
        >
          ✓ Keep
        </button>
      </div>
    </article>
  );
}
