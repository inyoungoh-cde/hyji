import { useEffect, useMemo, useRef, useState } from "react";
import { usePapersStore } from "../../stores/papers";
import { useUiStore } from "../../stores/ui";
import { searchLibrary, type SearchHit } from "../../lib/ftsSearch";
import type { Paper } from "../../types";

interface GlobalSearchProps {
  open: boolean;
  onClose: () => void;
}

interface FtsGroup {
  paper: Paper;
  hits: SearchHit[];
}

/** Spotlight-style search across paper metadata and full PDF text. */
export function GlobalSearch({ open, onClose }: GlobalSearchProps) {
  const papers = usePapersStore((s) => s.papers);
  const [query, setQuery] = useState("");
  const [ftsGroups, setFtsGroups] = useState<FtsGroup[]>([]);
  const [searching, setSearching] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setFtsGroups([]);
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Metadata matches — instant, from the in-memory papers list
  const metaMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return papers
      .filter((p) =>
        [p.title, p.authors, p.venue, p.summary]
          .some((f) => (f ?? "").toLowerCase().includes(q))
      )
      .slice(0, 6);
  }, [papers, query]);

  // Full-text matches — debounced DB query, grouped per paper
  useEffect(() => {
    const q = query.trim();
    if (!open || !q) {
      setFtsGroups([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const hits = await searchLibrary(q);
        const byPaper = new Map<string, SearchHit[]>();
        for (const h of hits) {
          if (!byPaper.has(h.paper_id)) byPaper.set(h.paper_id, []);
          const arr = byPaper.get(h.paper_id)!;
          if (arr.length < 3) arr.push(h); // top pages per paper
        }
        const groups: FtsGroup[] = [];
        for (const [pid, phits] of byPaper) {
          const paper = usePapersStore.getState().papers.find((p) => p.id === pid);
          if (paper) groups.push({ paper, hits: phits });
        }
        setFtsGroups(groups.slice(0, 12));
      } catch (e) {
        console.warn("[hyji fts] search failed:", e);
        setFtsGroups([]);
      } finally {
        setSearching(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [query, open]);

  // Flat list of actionable rows for keyboard navigation
  const rows = useMemo(() => {
    const r: Array<{ kind: "paper"; paper: Paper } | { kind: "hit"; paper: Paper; hit: SearchHit }> = [];
    for (const p of metaMatches) r.push({ kind: "paper", paper: p });
    for (const g of ftsGroups) for (const h of g.hits) r.push({ kind: "hit", paper: g.paper, hit: h });
    return r;
  }, [metaMatches, ftsGroups]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  const activate = (row: (typeof rows)[number]) => {
    if (row.kind === "paper") {
      useUiStore.getState().setActivePaper(row.paper.id);
    } else {
      // Carry the query into the in-PDF search so the match is highlighted
      useUiStore.getState().requestGoTo(row.paper.id, row.hit.page, query.trim());
    }
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, rows.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    if (e.key === "Enter" && rows[cursor]) { e.preventDefault(); activate(rows[cursor]); }
  };

  // Keep the cursored row visible
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-row="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  let rowIndex = -1;

  return (
    <div
      className="fixed inset-0 z-[400] flex items-start justify-center pt-[12vh]"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onMouseDown={onClose}
    >
      <div
        className="w-[640px] max-w-[90vw] bg-bg-secondary border border-border rounded-[12px] shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <span className="text-body text-text-tertiary">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search papers and PDF contents…"
            className="flex-1 bg-transparent text-[1.077rem] text-text-primary outline-none placeholder:text-text-tertiary selectable"
          />
          {searching && <span className="text-caption text-text-tertiary">searching…</span>}
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto">
          {query.trim() && rows.length === 0 && !searching && (
            <div className="px-4 py-6 text-center text-body text-text-tertiary">
              No matches in titles, notes, or PDF text.
            </div>
          )}

          {metaMatches.length > 0 && (
            <div className="px-4 pt-2 pb-1 text-caption font-bold uppercase tracking-wider text-text-tertiary">
              Papers
            </div>
          )}
          {metaMatches.map((p) => {
            rowIndex++;
            const i = rowIndex;
            return (
              <button
                key={`m-${p.id}`}
                data-row={i}
                onClick={() => activate({ kind: "paper", paper: p })}
                onMouseEnter={() => setCursor(i)}
                className={`w-full text-left px-4 py-2 transition-colors ${i === cursor ? "bg-bg-tertiary" : ""}`}
              >
                <div className="text-body text-text-primary truncate">📄 {p.title}</div>
                <div className="text-caption text-text-tertiary truncate">
                  {[p.first_author || p.authors.split(",")[0], p.year, p.venue].filter(Boolean).join(" · ")}
                </div>
              </button>
            );
          })}

          {ftsGroups.length > 0 && (
            <div className="px-4 pt-3 pb-1 text-caption font-bold uppercase tracking-wider text-text-tertiary">
              In PDF text
            </div>
          )}
          {ftsGroups.map((g) =>
            g.hits.map((h, hi) => {
              rowIndex++;
              const i = rowIndex;
              return (
                <button
                  key={`f-${g.paper.id}-${h.page}-${hi}`}
                  data-row={i}
                  onClick={() => activate({ kind: "hit", paper: g.paper, hit: h })}
                  onMouseEnter={() => setCursor(i)}
                  className={`w-full text-left px-4 py-2 transition-colors ${i === cursor ? "bg-bg-tertiary" : ""}`}
                >
                  <div className="text-body text-text-primary truncate">
                    {hi === 0 ? `📄 ${g.paper.title}` : ""}
                    <span className="text-text-tertiary text-small float-right shrink-0 ml-2">p.{h.page}</span>
                  </div>
                  <div className="text-small text-text-secondary line-clamp-2">
                    <Snippet text={h.snippet} />
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="px-4 py-1.5 border-t border-border text-caption text-text-tertiary flex gap-3">
          <span>↑↓ navigate</span>
          <span>Enter open</span>
          <span>Esc close</span>
          <span className="ml-auto">Ctrl+F searches inside the open PDF</span>
        </div>
      </div>
    </div>
  );
}

/** Renders ⟪match⟫ markers from FTS snippets as highlighted spans. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(⟪[^⟫]*⟫)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("⟪") && part.endsWith("⟫") ? (
          <mark key={i} className="bg-accent/30 text-text-primary rounded-[2px] px-px">
            {part.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}
