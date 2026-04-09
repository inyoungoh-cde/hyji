import { useEffect, useRef, useState } from "react";

export interface PdfContextMenuState {
  x: number;
  y: number;
  selectedText: string;
  page: number;
  rects: { x: number; y: number; w: number; h: number; pageIndex?: number }[];
}

const HIGHLIGHT_COLORS = [
  { label: "Yellow", hex: "#ffd166" },
  { label: "Green", hex: "#06d6a0" },
  { label: "Blue", hex: "#58a6ff" },
  { label: "Pink", hex: "#ff6b9d" },
] as const;

interface ContextMenuProps {
  state: PdfContextMenuState;
  onClose: () => void;
  onHighlight: (color: string) => void;
  onAddMemo: () => void;
  onSendTo: (field: "differentiation" | "questions") => void;
  onCopy: () => void;
}

export function ContextMenu({ state, onClose, onHighlight, onAddMemo, onSendTo, onCopy }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });

  // Clamp position so the menu stays within the viewport
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.min(state.x, window.innerWidth - width - 8),
      y: Math.min(state.y, window.innerHeight - height - 8),
    });
  }, [state.x, state.y]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        window.getSelection()?.removeAllRanges();
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-[200] bg-bg-secondary border border-border rounded-[8px] py-1 shadow-xl min-w-[220px]"
      style={{ left: pos.x, top: pos.y }}
    >
      <div className="px-3 py-1 text-caption text-text-tertiary truncate max-w-[250px]">
        "{state.selectedText.slice(0, 60)}{state.selectedText.length > 60 ? "\u2026" : ""}"
      </div>
      <div className="border-t border-border my-1" />

      {/* Highlight color picker */}
      <div className="px-3 py-1.5 flex items-center gap-2">
        <span className="text-small text-text-secondary mr-1">Highlight</span>
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c.hex}
            title={c.label}
            className="w-5 h-5 rounded-full border border-border hover:scale-125 transition-transform"
            style={{ backgroundColor: c.hex }}
            onClick={() => onHighlight(c.hex)}
          />
        ))}
      </div>

      <div className="border-t border-border my-1" />
      <button
        className="w-full text-left px-3 py-1.5 text-body hover:bg-bg-tertiary text-text-primary transition-colors flex items-center gap-2"
        onClick={onAddMemo}
      >
        <span className="text-small opacity-60">📝</span> Add memo
      </button>
      <div className="border-t border-border my-1" />
      <button
        className="w-full text-left px-3 py-1.5 text-body hover:bg-bg-tertiary text-[#ff6b35] transition-colors flex items-center gap-2"
        onClick={() => onSendTo("differentiation")}
      >
        <span className="text-small">✦</span> Send to Differentiation
      </button>
      <button
        className="w-full text-left px-3 py-1.5 text-body hover:bg-bg-tertiary text-[#a78bfa] transition-colors flex items-center gap-2"
        onClick={() => onSendTo("questions")}
      >
        <span className="text-small">?</span> Send to Questions
      </button>
      <div className="border-t border-border my-1" />
      <button
        className="w-full text-left px-3 py-1.5 text-body hover:bg-bg-tertiary text-text-primary transition-colors"
        onClick={onCopy}
      >
        Copy text
      </button>
    </div>
  );
}
