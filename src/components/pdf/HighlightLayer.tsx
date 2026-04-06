import { useState } from "react";
import type { Annotation } from "../../types";

interface HighlightLayerProps {
  annotations: Annotation[];
  scale: number;
  pageNum: number;
  onMemoOpen: (annotationId: string, screenX: number, screenY: number) => void;
  onAnnotationDelete: (annotationId: string) => void;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  pageIndex?: number;
}

function parseRects(json: string): Rect[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

export function HighlightLayer({ annotations, scale, pageNum, onMemoOpen, onAnnotationDelete }: HighlightLayerProps) {
  const [flashingId, setFlashingId] = useState<string | null>(null);
  const pageAnns = annotations.filter((a) => {
    if (a.page === pageNum) return true;
    // Include annotations whose rects contain this page (cross-page selections)
    const rects = parseRects(a.rects_json);
    return rects.some((r) => r.pageIndex === pageNum);
  });
  if (pageAnns.length === 0) return null;

  const handleMemoOpen = (ann: Annotation, screenX: number, screenY: number) => {
    setFlashingId(ann.id);
    setTimeout(() => setFlashingId(null), 900);
    onMemoOpen(ann.id, screenX, screenY);
  };

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 5 }}>
      {pageAnns.map((ann) => {
        const isMemo = ann.type === "memo";
        const isFlashing = flashingId === ann.id;

        return isMemo ? (
          <MemoAnnotation
            key={ann.id}
            annotation={ann}
            scale={scale}
            pageNum={pageNum}
            isFlashing={isFlashing}
            onOpen={(sx, sy) => handleMemoOpen(ann, sx, sy)}
            onDelete={() => onAnnotationDelete(ann.id)}
          />
        ) : (
          <HighlightAnnotation
            key={ann.id}
            annotation={ann}
            scale={scale}
            pageNum={pageNum}
            isFlashing={isFlashing}
            onDelete={() => onAnnotationDelete(ann.id)}
          />
        );
      })}
    </div>
  );
}

function HighlightAnnotation({
  annotation,
  scale,
  pageNum,
  isFlashing,
  onDelete,
}: {
  annotation: Annotation;
  scale: number;
  pageNum: number;
  isFlashing: boolean;
  onDelete: () => void;
}) {
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const rects = parseRects(annotation.rects_json)
    .filter((r) => !r.pageIndex || r.pageIndex === pageNum);
  const { r, g, b } = hexToRgb(annotation.color);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxPos({ x: e.clientX, y: e.clientY });
  };

  return (
    <>
      {/* SVG group: opacity applied to the whole group so overlapping rects don't stack */}
      <svg
        className="absolute inset-0 pointer-events-none"
        style={{ width: "100%", height: "100%", overflow: "visible" }}
      >
        <g
          opacity={0.38}
          className="pointer-events-auto cursor-context-menu"
          onContextMenu={handleContextMenu}
        >
          {rects.map((rect, i) => (
            <rect
              key={i}
              x={rect.x * scale}
              y={rect.y * scale}
              width={rect.w * scale}
              height={rect.h * scale}
              fill={`rgb(${r}, ${g}, ${b})`}
              rx="1"
              style={isFlashing ? { animation: "hyji-flash 0.9s ease-out" } : undefined}
            />
          ))}
        </g>
      </svg>

      {ctxPos && (
        <DeleteContextMenu
          x={ctxPos.x}
          y={ctxPos.y}
          label="Delete highlight"
          onDelete={() => { setCtxPos(null); onDelete(); }}
          onClose={() => setCtxPos(null)}
        />
      )}
    </>
  );
}

function MemoAnnotation({
  annotation,
  scale,
  pageNum,
  isFlashing,
  onOpen,
  onDelete,
}: {
  annotation: Annotation;
  scale: number;
  pageNum: number;
  isFlashing: boolean;
  onOpen: (screenX: number, screenY: number) => void;
  onDelete: () => void;
}) {
  const rects = parseRects(annotation.rects_json)
    .filter((r) => !r.pageIndex || r.pageIndex === pageNum);
  const { r, g, b } = hexToRgb(annotation.color);

  return (
    <>
      <svg
        className="absolute inset-0 pointer-events-none"
        style={{ width: "100%", height: "100%", overflow: "visible" }}
      >
        <g opacity={0.18} style={{ mixBlendMode: "multiply" }}>
          {rects.map((rect, i) => (
            <rect
              key={i}
              x={rect.x * scale}
              y={rect.y * scale}
              width={rect.w * scale}
              height={rect.h * scale}
              fill={`rgb(${r}, ${g}, ${b})`}
              rx="1"
              stroke={`rgb(${r}, ${g}, ${b})`}
              strokeWidth="1.5"
              strokeDasharray="4 2"
              fillOpacity={0.6}
              strokeOpacity={1}
              style={isFlashing ? { animation: "hyji-flash 0.9s ease-out" } : undefined}
            />
          ))}
        </g>
      </svg>

      <MemoMarker
        annotation={annotation}
        top={rects.length > 0 ? rects[0].y * scale : 8}
        isFlashing={isFlashing}
        onOpen={onOpen}
        onDelete={onDelete}
      />
    </>
  );
}

function DeleteContextMenu({
  x,
  y,
  label,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  label: string;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <>
      {/* Transparent full-screen backdrop to catch outside clicks */}
      <div
        className="fixed inset-0"
        style={{ zIndex: 299, pointerEvents: "auto" }}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div
        className="fixed bg-bg-secondary border border-border rounded-[6px] shadow-xl py-1"
        style={{ left: x, top: y, zIndex: 300, minWidth: 130, pointerEvents: "auto" }}
      >
        <button
          className="w-full text-left px-3 py-1.5 text-small text-[var(--status-revisit)] hover:bg-bg-tertiary transition-colors"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >
          {label}
        </button>
        <button
          className="w-full text-left px-3 py-1.5 text-small text-text-secondary hover:bg-bg-tertiary transition-colors"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
        >
          Cancel
        </button>
      </div>
    </>
  );
}

function MemoMarker({
  annotation,
  top,
  isFlashing,
  onOpen,
  onDelete,
}: {
  annotation: Annotation;
  top: number;
  isFlashing: boolean;
  onOpen: (screenX: number, screenY: number) => void;
  onDelete: () => void;
}) {
  const [showCtx, setShowCtx] = useState(false);
  const hasMemo = !!annotation.memo_text;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowCtx(false);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onOpen(rect.right + 6, rect.top);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowCtx(true);
  };

  return (
    <div
      className="absolute pointer-events-auto"
      style={{ right: 4, top, zIndex: 3 }}
    >
      <button
        className={`cursor-pointer transition-transform hover:scale-115 ${isFlashing ? "scale-125" : ""}`}
        title={hasMemo ? annotation.memo_text : "Click to add memo"}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        <span
          className="text-[1.154rem] transition-opacity"
          style={{ opacity: hasMemo ? 0.85 : 0.4 }}
        >
          📝
        </span>
      </button>

      {showCtx && (
        <div
          className="absolute right-0 top-6 bg-bg-secondary border border-border rounded-[6px] shadow-xl py-1 z-[10]"
          style={{ minWidth: 120 }}
          onMouseLeave={() => setShowCtx(false)}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-small text-[var(--status-revisit)] hover:bg-bg-tertiary transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              setShowCtx(false);
              onDelete();
            }}
          >
            Delete memo
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-small text-text-secondary hover:bg-bg-tertiary transition-colors"
            onClick={() => setShowCtx(false)}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
