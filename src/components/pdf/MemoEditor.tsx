import { useState, useRef, useEffect, useCallback } from "react";
import type { Annotation } from "../../types";

interface MemoEditorProps {
  annotation: Annotation;
  initialX: number;
  initialY: number;
  onSave: (text: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

const WIDTH = 248;

export function MemoEditor({ annotation, initialX, initialY, onSave, onDelete, onClose }: MemoEditorProps) {
  const [text, setText] = useState(annotation.memo_text || "");
  const [pos, setPos] = useState({ x: initialX, y: initialY });
  const ref = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragging = useRef(false);
  const dragOrigin = useRef({ mouseX: 0, mouseY: 0, posX: 0, posY: 0 });

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // ESC anywhere closes the memo (global listener — one memo open at a time)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleSave();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const handleSave = useCallback(() => {
    onSave(text);
    onClose();
  }, [text, onSave, onClose]);

  // Drag
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    dragOrigin.current = { mouseX: e.clientX, mouseY: e.clientY, posX: pos.x, posY: pos.y };

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      setPos({
        x: dragOrigin.current.posX + (ev.clientX - dragOrigin.current.mouseX),
        y: dragOrigin.current.posY + (ev.clientY - dragOrigin.current.mouseY),
      });
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [pos]);

  return (
    <div
      ref={ref}
      className="fixed z-[200] bg-bg-secondary border border-border rounded-[8px] shadow-xl"
      style={{ left: pos.x, top: pos.y, width: WIDTH, userSelect: "none" }}
    >
      {/* Drag handle + close */}
      <div
        className="flex items-center justify-between px-3 py-1.5 cursor-grab active:cursor-grabbing border-b border-border"
        onMouseDown={onDragStart}
      >
        <span className="text-[10px] text-text-tertiary uppercase tracking-wider font-bold select-none">
          📝 Memo
        </span>
        <button
          className="text-[13px] text-text-tertiary hover:text-text-primary leading-none px-0.5 transition-colors"
          title="Close (Esc)"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleSave}
        >
          ✕
        </button>
      </div>

      <div className="p-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-full h-20 bg-bg-tertiary border border-border rounded px-2 py-1 text-body text-text-primary outline-none resize-none focus:border-accent/30 selectable"
          placeholder="Write a memo..."
          style={{ userSelect: "text" }}
        />
        <div className="text-[9px] text-text-tertiary mt-1 mb-2 truncate opacity-60">
          "{annotation.selected_text.slice(0, 45)}{annotation.selected_text.length > 45 ? "\u2026" : ""}"
        </div>
        <div className="flex items-center justify-between">
          <button
            className="text-[11px] text-[var(--status-revisit)] hover:opacity-100 opacity-60 transition-opacity"
            onClick={onDelete}
          >
            Delete
          </button>
          <button
            className="px-3 py-1 rounded text-[11px] bg-accent text-bg-primary font-medium hover:bg-accent/90 transition-colors"
            onClick={handleSave}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
