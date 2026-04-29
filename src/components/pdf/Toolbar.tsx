import { useState, useEffect, useRef } from "react";

interface ToolbarProps {
  currentPage: number;
  totalPages: number;
  scale: number;
  onScaleChange: (scale: number) => void;
  onFitWidth: () => void;
  onGoToPage: (page: number) => void;
  searchQuery: string;
  searchIndex: number;
  searchTotal: number;
  onSearchChange: (query: string) => void;
  onSearchNext: () => void;
  onSearchPrev: () => void;
  showSearch: boolean;
  onToggleSearch: () => void;
  status?: string;
  importance?: string;
  focusMode?: boolean;
  onToggleFocus?: () => void;
  onPrint?: () => void;
  onSave?: () => void;
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

const statusColors: Record<string, string> = {
  Surveyed: "bg-[#ffd16636] text-[#ffd166] border-[#ffd16644]",
  "Fully Reviewed": "bg-[#06d6a036] text-[#06d6a0] border-[#06d6a044]",
  "Revisit Needed": "bg-[#ff6b6b36] text-[#ff6b6b] border-[#ff6b6b44]",
};
const importanceColors: Record<string, string> = {
  Noted: "bg-[#6c757d36] text-[#6c757d] border-[#6c757d44]",
  "Potentially Relevant": "bg-[#f77f0036] text-[#f77f00] border-[#f77f0044]",
  "Must-Cite": "bg-[#d6282836] text-[#d62828] border-[#d6282844]",
};
const importanceShort: Record<string, string> = {
  Noted: "Noted",
  "Potentially Relevant": "Relevant",
  "Must-Cite": "Must-Cite",
};

export function Toolbar({
  currentPage,
  totalPages,
  scale,
  onScaleChange,
  onFitWidth,
  onGoToPage,
  searchQuery,
  searchIndex,
  searchTotal,
  onSearchChange,
  onSearchNext,
  onSearchPrev,
  showSearch,
  onToggleSearch,
  status,
  importance,
  focusMode,
  onToggleFocus,
  onPrint,
  onSave,
}: ToolbarProps) {
  const [pageInput, setPageInput] = useState("");
  const [searchInput, setSearchInput] = useState(searchQuery);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showSearch && searchRef.current) {
      searchRef.current.focus();
    }
  }, [showSearch]);

  const zoomIn = () => {
    const next = ZOOM_STEPS.find((s) => s > scale);
    if (next) onScaleChange(next);
  };

  const zoomOut = () => {
    const prev = [...ZOOM_STEPS].reverse().find((s) => s < scale);
    if (prev) onScaleChange(prev);
  };

  const handlePageSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const num = parseInt(pageInput, 10);
    if (num >= 1 && num <= totalPages) {
      onGoToPage(num);
    }
    setPageInput("");
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      if (e.shiftKey) onSearchPrev();
      else onSearchNext();
    }
    if (e.key === "Escape") {
      setSearchInput("");
      onSearchChange("");
      onToggleSearch();
    }
  };

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border bg-bg-secondary flex-wrap">
      {/* Page nav */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => onGoToPage(Math.max(1, currentPage - 1))}
          disabled={currentPage <= 1}
          className="px-1.5 py-0.5 rounded text-body text-text-secondary hover:bg-bg-tertiary disabled:opacity-30 transition-colors"
        >
          ‹
        </button>
        <form onSubmit={handlePageSubmit} className="flex items-center">
          <input
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            placeholder={String(currentPage)}
            className="w-[36px] text-center bg-bg-tertiary text-body text-text-primary rounded px-1 py-0.5 outline-none border border-transparent focus:border-accent/40"
          />
        </form>
        <span className="text-small text-text-tertiary">/ {totalPages}</span>
        <button
          onClick={() => onGoToPage(Math.min(totalPages, currentPage + 1))}
          disabled={currentPage >= totalPages}
          className="px-1.5 py-0.5 rounded text-body text-text-secondary hover:bg-bg-tertiary disabled:opacity-30 transition-colors"
        >
          ›
        </button>
      </div>

      <div className="w-px h-4 bg-border mx-1" />

      {/* Zoom */}
      <div className="flex items-center gap-1">
        <button onClick={zoomOut} className="px-1.5 py-0.5 rounded text-body text-text-secondary hover:bg-bg-tertiary transition-colors">−</button>
        <span className="text-small text-text-secondary w-[40px] text-center">
          {Math.round(scale * 100)}%
        </span>
        <button onClick={zoomIn} className="px-1.5 py-0.5 rounded text-body text-text-secondary hover:bg-bg-tertiary transition-colors">+</button>
        <button
          onClick={() => onScaleChange(1)}
          className="px-2 py-0.5 rounded text-caption text-text-tertiary hover:bg-bg-tertiary transition-colors"
          title="Original size (100%)"
        >
          1:1
        </button>
        <button
          onClick={onFitWidth}
          className="px-2 py-0.5 rounded text-caption text-text-tertiary hover:bg-bg-tertiary transition-colors"
          title="Fit to panel width (Ctrl+0)"
        >
          Fit
        </button>
      </div>

      <div className="w-px h-4 bg-border mx-1" />

      {/* Status + Importance badges (read-only) */}
      {status && (
        <span className={`px-1.5 py-0.5 rounded text-caption font-bold border ${statusColors[status] ?? ""}`}>
          {status === "Fully Reviewed" ? "Reviewed" : status === "Revisit Needed" ? "Revisit" : status}
        </span>
      )}
      {importance && (
        <span className={`px-1.5 py-0.5 rounded text-caption font-bold border ${importanceColors[importance] ?? ""}`}>
          {importanceShort[importance] ?? importance}
        </span>
      )}

      {focusMode && (
        <button
          onClick={onToggleFocus}
          className="px-2 py-0.5 rounded-full text-caption font-medium border border-accent/40 bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
          title="Exit Focus Mode (Ctrl+L or Esc)"
        >
          Focus
        </button>
      )}

      <div className="flex-1" />

      {/* Search */}
      {showSearch ? (
        <div className="flex items-center gap-1">
          <input
            ref={searchRef}
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              onSearchChange(e.target.value);
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder="Find in PDF..."
            className="w-[160px] bg-bg-tertiary text-body text-text-primary rounded px-2 py-0.5 outline-none border border-accent/40 transition-colors selectable"
          />
          {searchQuery && (
            <span className="text-small text-text-secondary min-w-[40px] text-center">
              {searchTotal > 0 ? `${searchIndex + 1}/${searchTotal}` : "0/0"}
            </span>
          )}
          <button onClick={onSearchPrev} disabled={searchTotal === 0} className="px-1.5 py-0.5 rounded text-body text-text-secondary hover:bg-bg-tertiary disabled:opacity-30 transition-colors" title="Previous (Shift+Enter)">▲</button>
          <button onClick={onSearchNext} disabled={searchTotal === 0} className="px-1.5 py-0.5 rounded text-body text-text-secondary hover:bg-bg-tertiary disabled:opacity-30 transition-colors" title="Next (Enter)">▼</button>
          <button
            onClick={() => { setSearchInput(""); onSearchChange(""); onToggleSearch(); }}
            className="px-1.5 py-0.5 rounded text-body text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            title="Close"
          >
            ×
          </button>
        </div>
      ) : (
        <button onClick={onToggleSearch} className="px-2 py-0.5 rounded text-body text-text-secondary hover:bg-bg-tertiary transition-colors" title="Search (Ctrl+F)">
          Search
        </button>
      )}

      {/* Print + Save */}
      {onPrint && (
        <button
          onClick={onPrint}
          className="px-1.5 py-0.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary transition-colors flex items-center"
          title="Print (Ctrl+P)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M5 1a2 2 0 0 0-2 2v2H2a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1v1a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-1h1a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1V3a2 2 0 0 0-2-2H5zM4 3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2H4V3zm1 5a2 2 0 0 0-2 2v1H2a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v-1a2 2 0 0 0-2-2H5zm7 2v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1z"/>
          </svg>
        </button>
      )}
      {onSave && (
        <button
          onClick={onSave}
          className="px-1.5 py-0.5 rounded text-body text-text-tertiary hover:text-accent hover:bg-bg-tertiary transition-colors"
          title="Save highlights to PDF"
        >
          💾
        </button>
      )}
    </div>
  );
}
