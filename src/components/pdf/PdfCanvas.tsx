import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { HighlightLayer } from "./HighlightLayer";
import { openPdfDocument } from "../../lib/pdfSource";
import {
  pdfiumStatus,
  pdfiumOpen,
  pdfiumClose,
  pdfiumRender,
  pdfiumRenderRegion,
  pdfiumRenderPngToFile,
  pdfiumImageRegions,
  pdfiumText,
  pdfiumLinks,
  pdfiumSearch,
  pdfiumLinkEntry,
  type PdfiumDoc,
  type PdfiumTextPage,
  type PdfiumLink,
  type PdfiumSearchMatch,
} from "../../lib/pdfium";
import { useUiStore } from "../../stores/ui";
import type { Annotation } from "../../types";
import { parseCitation } from "../../lib/citeParse";
import { CitePreview, type CitePreviewData } from "./CitePreview";

export interface PdfRect {
  x: number;
  y: number;
  w: number;
  h: number;
  pageIndex?: number;  // which page this rect belongs to (1-indexed), for cross-page selections
}

export interface PdfContextInfo {
  x: number;
  y: number;
  selectedText: string;
  page: number;
  rects: PdfRect[];
}

/** What the viewer tells its parent once a document is open (engine-agnostic). */
export interface PdfDocInfo {
  numPages: number;
  engine: "pdfium" | "pdfjs";
}

/** One HTML fragment per page for the print iframe, plus temp-file cleanup. */
export interface PrintPages {
  pages: string[];
  cleanup: () => Promise<void>;
}

interface PdfCanvasProps {
  filePath: string;
  scale: number;
  onDocLoaded: (info: PdfDocInfo) => void;
  onPageChange: (page: number) => void;
  onPageWidth?: (w: number) => void;
  searchQuery: string;
  searchIndex: number;
  onSearchResults: (count: number) => void;
  goToPage: number | null;
  scrollToAnnotation: { page: number; selectedText: string; noteField?: string; rects_json?: string } | null;
  onContextMenu: (info: PdfContextInfo) => void;
  annotations: Annotation[];
  onMemoOpen: (annotationId: string, screenX: number, screenY: number) => void;
  onAnnotationDelete: (annotationId: string) => void;
  /** Called when the user clicks an internal PDF link (e.g. [3] reference).
   *  Passes the scroll position BEFORE navigation so the caller can offer a "Back" button. */
  onInternalNavigate?: (fromScrollTop: number) => void;
}

interface PageEntry {
  pageNum: number;
  width: number;
  height: number;
}

export interface PdfCanvasHandle {
  getPrintPages: () => Promise<PrintPages>;
  renderAllPages: () => Promise<void>;
  /** Smooth-scroll the PDF viewer to a specific scrollTop value. */
  scrollToY: (y: number) => void;
}

// Per-file scroll memory so switching viewer tabs returns to the position
// the user was reading. Session-scoped by design (not persisted).
const scrollMemory = new Map<string, number>();

// Largest RGBA payload requested from PDFium in one IPC call. Bigger pages
// (zoom 4 on a 125 % monitor is ~30 MB for a letter page) are rendered in
// horizontal strips through pdfium_render_region, which is pixel-identical
// to the full render — so the Rust-side 96 MB cap is never reached.
const MAX_RENDER_BYTES = 16 * 1024 * 1024;

// ── Dark-mode image regions (pdf.js engine) ─────────────────────────────────
// The page canvas is CSS-inverted in dark mode, which would render photos and
// figures as negatives. Walk the page's operator list tracking the transform
// stack; every painted bitmap occupies the unit square under the current ctm.
// The resulting rects get counter-inverting backdrop-filter overlays.
// (The PDFium engine gets the same rects from pdfium_image_regions.)
type Mat = [number, number, number, number, number, number];
const MAT_IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function matMul(m1: Mat, m2: Mat): Mat {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

interface CssRect { x: number; y: number; w: number; h: number }

function computeImageRegions(
  opList: { fnArray: number[]; argsArray: unknown[] },
  viewport: { convertToViewportPoint: (x: number, y: number) => number[] }
): CssRect[] {
  const OPS = pdfjsLib.OPS as Record<string, number>;
  const stack: Mat[] = [];
  let ctm: Mat = MAT_IDENTITY;
  const regions: CssRect[] = [];

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i] as unknown[] | null;
    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? MAT_IDENTITY;
    } else if (fn === OPS.transform) {
      ctm = matMul(ctm, args as unknown as Mat);
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args?.[0] as Mat | null;
      if (m) ctm = matMul(ctm, m);
    } else if (fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? MAT_IDENTITY;
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([ux, uy]) => {
        const x = ctm[0] * ux + ctm[2] * uy + ctm[4];
        const y = ctm[1] * ux + ctm[3] * uy + ctm[5];
        return viewport.convertToViewportPoint(x, y);
      });
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const w = Math.max(...xs) - x;
      const h = Math.max(...ys) - y;
      // Skip tiny bitmaps (bullets, icons) — inverting those is harmless
      if (w >= 14 && h >= 14) regions.push({ x, y, w, h });
    }
  }
  return regions;
}

// ── Shared post-render pass (both engines) ──────────────────────────────────
// Stem darkening: pdf.js draws glyphs with plain grayscale antialiasing and
// no hinting, so on low-DPI displays (devicePixelRatio 1, e.g. an FHD monitor
// at 100% scale) text reads thin and washed-out next to Acrobat, which
// darkens stems. Multiplying the page with itself squares the midtones —
// antialiased glyph edges get pulled darker while white paper stays white.
// Photos/figures are clipped out to keep their tones. Strength is a
// per-engine preference (0 = off); high-DPI displays don't need it.
//
// Dark mode: counter-invert overlays over bitmap images so photos and
// figures keep natural colors (CSS shows them only in .hyji-pdf-dark).
function applyPostRender(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  container: HTMLDivElement,
  imageRegions: CssRect[],
  darkening: number,
  dpr: number
): void {
  if (dpr < 1.5 && darkening > 0) {
    ctx.save();
    if (imageRegions.length > 0) {
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      for (const r of imageRegions) {
        ctx.rect(r.x * dpr, r.y * dpr, r.w * dpr, r.h * dpr);
      }
      ctx.clip("evenodd");
    }
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = darkening;
    ctx.drawImage(canvas, 0, 0);
    ctx.restore();
  }
  for (const r of imageRegions) {
    const div = document.createElement("div");
    div.className = "hyji-img-region";
    div.style.cssText = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;pointer-events:none;`;
    container.appendChild(div);
  }
}

// Pixel-exact display: the CSS box must map 1:1 onto the backing store
// (backing / dpr, not the fractional viewport size) and sampling must be
// nearest-neighbour. Otherwise the compositor bilinear-resamples the bitmap
// by a fraction of a pixel — invisible with pdf.js's soft antialiasing, but
// it turned PDFium's hinted 1-px stems into gray smears (3.1).
function makePageCanvas(backingW: number, backingH: number, dpr: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = backingW;
  canvas.height = backingH;
  canvas.style.width = `${backingW / dpr}px`;
  canvas.style.height = `${backingH / dpr}px`;
  canvas.style.imageRendering = "pixelated";
  canvas.style.display = "block";
  return canvas;
}

// ── PDFium text layer ───────────────────────────────────────────────────────
// Mirrors what pdf.js's TextLayer produces (absolutely positioned transparent
// spans that native selection can run over) from PDFium's char list:
//   • chars are grouped into lines by `lineBreaks`;
//   • each line is split into runs at whitespace — every whitespace char gets
//     its own span with class `pdfjs-space` (the existing selection CSS keys
//     on that class to suppress the full-line ::selection flash);
//   • a run span covers the union of its chars' loose boxes, font-size = the
//     box's cross-axis height (so ::selection paints the same uniform band
//     PDFium reports), and scaleX = box length / measured text width in the
//     same font the CSS renders — exactly pdf.js's `--scale-x` trick;
//   • rotated runs (rot 90/270/180) rotate about their top-left corner, so
//     the span origin is the box corner that lands at top-left after rotation.
// Every run span carries data-start (index of its first char) so a DOM
// selection can be mapped back to char indices (see charIndexFromBoundary).
const TEXT_LAYER_FONT = "sans-serif";
let measureCtx: CanvasRenderingContext2D | null = null;
let measureFont = "";

function measureWidth(text: string, fontPx: number): number {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return 0;
  const font = `${fontPx}px ${TEXT_LAYER_FONT}`;
  if (measureFont !== font) {
    measureCtx.font = font;
    measureFont = font;
  }
  return measureCtx.measureText(text).width;
}

/** A page's PDFium text with a char → line-index table and visibility flags. */
interface PageText {
  tp: PdfiumTextPage;
  lineOf: Int32Array;
  /** 1 = the char has a real box inside the display page and gets a span. */
  visible: Uint8Array;
}

// Two classes of chars stay in the index space but are never shown:
//   • boxes entirely outside [0,pageW]×[0,pageH] — text under the CropBox,
//     which pdf.js drops as well;
//   • w == 0 && h == 0 — /ActualText replacement text (LaTeX equations):
//     PDFium emits the ActualText string as zero-width chars at the formula
//     origin and NO glyph chars for the visible formula. A span for them
//     would be a zero-size hit target with bogus selection rects. Known
//     limitation: such formulas cannot be selected or searched on the
//     PDFium engine (the pdf.js engine still can).
function makePageText(tp: PdfiumTextPage, pageW: number, pageH: number): PageText {
  const n = tp.chars.length;
  const lineOf = new Int32Array(n);
  const visible = new Uint8Array(n);
  let line = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    lineOf[i] = line;
    if (b < tp.lineBreaks.length && tp.lineBreaks[b] === i) {
      line++;
      b++;
    }
    const c = tp.chars[i];
    const real = c.w > 0 && c.h > 0 && Number.isFinite(c.x) && Number.isFinite(c.y);
    const onPage = real && c.x < pageW && c.x + c.w > 0 && c.y < pageH && c.y + c.h > 0;
    visible[i] = onPage ? 1 : 0;
  }
  return { tp, lineOf, visible };
}

/** Union of the visible chars' boxes in display points. */
function unionBox(pt: PageText, from: number, to: number): CssRect | null {
  const { chars } = pt.tp;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = from; k < to; k++) {
    if (!pt.visible[k]) continue;
    const c = chars[k];
    x0 = Math.min(x0, c.x);
    y0 = Math.min(y0, c.y);
    x1 = Math.max(x1, c.x + c.w);
    y1 = Math.max(y1, c.y + c.h);
  }
  if (x0 === Infinity) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * One rect per line for the char range [s, e) — display points. Leading /
 * trailing whitespace of each line segment is dropped so a highlight ends at
 * the last glyph, not at a synthesized space box.
 */
function charRangeRects(pt: PageText, s: number, e: number, pageNum: number): PdfRect[] {
  const { chars } = pt.tp;
  const out: PdfRect[] = [];
  let i = Math.max(0, s);
  const end = Math.min(e, chars.length);
  while (i < end) {
    const line = pt.lineOf[i];
    let j = i;
    while (j < end && pt.lineOf[j] === line) j++;
    let a = i, b = j;
    while (a < b && (!pt.visible[a] || !chars[a].c.trim())) a++;
    while (b > a && (!pt.visible[b - 1] || !chars[b - 1].c.trim())) b--;
    if (a < b) {
      const box = unionBox(pt, a, b);
      if (box) out.push({ ...box, pageIndex: pageNum });
    }
    i = j;
  }
  return out;
}

function makeRunSpan(
  pt: PageText,
  from: number,
  to: number,
  scale: number,
  pageNum: number
): HTMLSpanElement | null {
  const { chars } = pt.tp;
  const box = unionBox(pt, from, to);
  if (!box || box.w <= 0 || box.h <= 0) return null;
  let text = "";
  for (let k = from; k < to; k++) text += chars[k].c;
  const rot = chars[from].rot;
  const vertical = rot === 90 || rot === 270;
  const alongPx = (vertical ? box.h : box.w) * scale;
  const crossPx = (vertical ? box.w : box.h) * scale;

  const span = document.createElement("span");
  span.textContent = text;
  span.dataset.start = String(from);
  span.dataset.page = String(pageNum);
  const st = span.style;
  st.fontFamily = TEXT_LAYER_FONT;
  st.fontSize = `${crossPx}px`;
  const measured = measureWidth(text, crossPx);
  const scaleX = measured > 0 ? alongPx / measured : 1;

  let left = box.x * scale;
  let top = box.y * scale;
  let rotate = "";
  switch (rot) {
    case 90:  left = (box.x + box.w) * scale; rotate = "rotate(90deg) "; break;
    case 180: left = (box.x + box.w) * scale; top = (box.y + box.h) * scale; rotate = "rotate(180deg) "; break;
    case 270: top = (box.y + box.h) * scale; rotate = "rotate(270deg) "; break;
    default: break;
  }
  st.left = `${left}px`;
  st.top = `${top}px`;
  st.transform = `${rotate}scaleX(${scaleX})`;
  return span;
}

function buildPdfiumTextLayer(pt: PageText, scale: number, pageNum: number): HTMLDivElement {
  const layer = document.createElement("div");
  layer.className = "textLayer";
  layer.dataset.page = String(pageNum);
  layer.style.setProperty("--total-scale-factor", `${scale}`);
  const { chars } = pt.tp;
  const frag = document.createDocumentFragment();
  let i = 0;
  while (i < chars.length) {
    if (!pt.visible[i]) { i++; continue; }
    const line = pt.lineOf[i];
    const first = chars[i];
    const isSpace = !first.c.trim();
    let j = i + 1;
    if (!isSpace) {
      // A run is a contiguous stretch of visible, non-space chars on one
      // line with one rotation — hidden chars end it so data-start + text
      // offset still maps 1:1 onto char indices.
      while (j < chars.length && pt.visible[j] && pt.lineOf[j] === line && chars[j].rot === first.rot && chars[j].c.trim()) j++;
    }
    const span = makeRunSpan(pt, i, j, scale, pageNum);
    if (span) {
      if (isSpace) span.classList.add("pdfjs-space");
      frag.appendChild(span);
    }
    i = j;
  }
  layer.appendChild(frag);
  // endOfContent — required for drag-to-select across spans (see CSS).
  const endOfContent = document.createElement("div");
  endOfContent.className = "endOfContent";
  layer.appendChild(endOfContent);
  return layer;
}

/**
 * DOM selection boundary → char index into the page's PDFium chars.
 * Text-node offsets count UTF-16 units; chars may be surrogate pairs, so the
 * offset is walked char by char. Returns null for nodes outside a text layer.
 */
function charIndexFromBoundary(node: Node, offset: number, pt: PageText): number | null {
  const { chars } = pt.tp;
  const advance = (start: number, units: number) => {
    let k = start;
    let used = 0;
    while (k < chars.length && used < units) {
      used += chars[k].c.length;
      k++;
    }
    return k;
  };
  if (node.nodeType === Node.TEXT_NODE) {
    const ds = node.parentElement?.dataset.start;
    if (ds == null) return null;
    return advance(Number(ds), offset);
  }
  if (!(node instanceof HTMLElement)) return null;
  if (node.dataset.start != null) {
    const start = Number(node.dataset.start);
    return offset === 0 ? start : advance(start, (node.textContent ?? "").length);
  }
  if (node.classList.contains("textLayer")) {
    const child = node.children[offset] as HTMLElement | undefined;
    if (child?.dataset.start != null) return Number(child.dataset.start);
    return chars.length;
  }
  return null;
}

export const PdfCanvas = forwardRef<PdfCanvasHandle, PdfCanvasProps>(function PdfCanvas({
  filePath,
  scale,
  onDocLoaded,
  onPageChange,
  onPageWidth,
  searchQuery,
  searchIndex,
  onSearchResults,
  goToPage,
  scrollToAnnotation,
  onContextMenu,
  annotations,
  onMemoOpen,
  onAnnotationDelete,
  onInternalNavigate,
}: PdfCanvasProps, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pdfDarkMode = useUiStore((s) => s.pdfDarkMode);
  const pdfjsDarkening = useUiStore((s) => s.pdfTextDarkening);
  const pdfiumDarkening = useUiStore((s) => s.pdfiumTextDarkening);
  const renderEngine = useUiStore((s) => s.pdfRenderEngine);
  // Per-page render generation: a newer renderPage() call for the same page
  // invalidates an older in-flight one (they'd otherwise both append layers
  // to the container after their awaits).
  const renderSeq = useRef<Map<number, number>>(new Map());
  // Which file the currently laid-out pages belong to. Scroll events are only
  // recorded for that file — during a tab switch the collapsing old layout
  // fires a clamped scroll-to-0 that must not overwrite the new file's memory.
  const loadedFileRef = useRef<string | null>(null);
  // Exactly one of these is non-null once a document is open: the engine
  // preference decides, and PDFium falls back to pdf.js when the DLL is
  // unavailable or the file fails to open there. On the PDFium path pdf.js
  // never opens the document at all (3.2).
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdfiumDoc, setPdfiumDoc] = useState<PdfiumDoc | null>(null);
  const [pages, setPages] = useState<PageEntry[]>([]);
  const pagesRef = useRef<PageEntry[]>([]);
  pagesRef.current = pages;
  const [error, setError] = useState<string | null>(null);
  const renderedPages = useRef<Map<number, string>>(new Map()); // pageNum -> render key
  const visiblePagesRef = useRef<Set<number>>(new Set());       // pages currently intersecting the viewport
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());       // outer page wrapper (for observer, scroll, text queries)
  const renderRefs = useRef<Map<number, HTMLDivElement>>(new Map());     // inner div (for imperative canvas/textLayer rendering)
  const selectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // PDFium per-page caches (pageNum-keyed). Text and links are fetched once
  // per document and reused across zoom/DPI re-renders; `textReady` mirrors
  // resolved text pages for synchronous access from selection handling.
  const textCache = useRef<Map<number, Promise<PageText>>>(new Map());
  const textReady = useRef<Map<number, PageText>>(new Map());
  const linksCache = useRef<Map<number, Promise<PdfiumLink[]>>>(new Map());
  // Citation hover card (3.4). Entries are resolved once per link and cached
  // for the document; the card itself is React state rendered at the root.
  const citeFields = useUiStore((s) => s.citeFields);
  const citeFieldsRef = useRef(citeFields);
  citeFieldsRef.current = citeFields;
  const citeCache = useRef<Map<string, Promise<CitePreviewData | null>>>(new Map());
  const citeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const citeToken = useRef(0);
  const [citeCard, setCiteCard] = useState<{
    data: CitePreviewData;
    anchor: { left: number; top: number; right: number; bottom: number };
  } | null>(null);
  const searchCache = useRef<Map<number, { query: string; matches: PdfiumSearchMatch[] }>>(new Map());
  const searchGen = useRef(0);
  // Props read from inside render callbacks go through refs: a changed
  // identity (the parent passes an inline onInternalNavigate; searchQuery
  // changes per keystroke) must not recreate renderPage — that would clear
  // the render cache and redraw every visible page.
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const onInternalNavigateRef = useRef(onInternalNavigate);
  onInternalNavigateRef.current = onInternalNavigate;

  // devicePixelRatio changes when the window moves between monitors with
  // different DPI (or the user changes display scaling). The canvas bitmap
  // was rasterized at the old ratio, so it must be re-rendered — otherwise
  // it is resampled to the new ratio and every page turns blurry.
  //
  // A single matchMedia listener is NOT enough: during a cross-monitor move
  // WebView2 can fire the media-query change while window.devicePixelRatio
  // still reads the old value, and once that one event is consumed no further
  // signal arrives — the stale canvas then sticks until some unrelated
  // re-render. So listen to every signal that accompanies a DPI change
  // (media query, viewport resize, native WM_DPICHANGED via Tauri) and after
  // each one re-read the ratio a few times with delays until it settles.
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    let disposed = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const sync = () => {
      [0, 150, 600].forEach((ms) => {
        timers.push(setTimeout(() => {
          if (disposed) return;
          const now = window.devicePixelRatio || 1;
          setDpr((prev) => (prev === now ? prev : now));
        }, ms));
      });
    };

    let mq: MediaQueryList | null = null;
    const onMq = () => { sync(); arm(); };
    const arm = () => {
      mq?.removeEventListener("change", onMq);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener("change", onMq);
    };
    arm();

    window.addEventListener("resize", sync);
    document.addEventListener("visibilitychange", sync);

    let unlisten: (() => void) | null = null;
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().onScaleChanged(sync))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => { /* non-Tauri contexts: remaining signals still cover */ });

    return () => {
      disposed = true;
      timers.forEach(clearTimeout);
      mq?.removeEventListener("change", onMq);
      window.removeEventListener("resize", sync);
      document.removeEventListener("visibilitychange", sync);
      unlisten?.();
    };
  }, []);

  // Load document. Engine "pdfium" (default): open in PDFium only — page
  // sizes come from pdfium_open. Engine "pdfjs", DLL unavailable, or PDFium
  // refusing the file: the classic pdf.js path (whole-file read for normal
  // papers, ranged loading for large files — see lib/pdfSource.ts).
  useEffect(() => {
    let cancelled = false;
    // Documents owned by THIS effect run. The pdf.js one must be destroyed on
    // cleanup (tab switch/close) — otherwise every open leaks the whole
    // parsed document (fonts, page trees, the file buffer) in the pdf.js
    // worker, and after enough opens the worker heap fills up and loads hang
    // forever. The PDFium one is closed so the Rust-side cache entry and file
    // handle are released with the tab.
    let ownedDoc: PDFDocumentProxy | null = null;
    let ownedPdfium: PdfiumDoc | null = null;
    loadedFileRef.current = null;
    renderedPages.current.clear();
    visiblePagesRef.current.clear();
    textCache.current.clear();
    textReady.current.clear();
    linksCache.current.clear();
    searchCache.current.clear();
    citeCache.current.clear();
    setCiteCard(null);
    setPages([]);
    setDoc(null);
    setPdfiumDoc(null);
    setError(null);

    (async () => {
      try {
        if (renderEngine === "pdfium" && (await pdfiumStatus()).available) {
          try {
            const d = await pdfiumOpen(filePath);
            if (cancelled) {
              pdfiumClose(d.id);
              return;
            }
            ownedPdfium = d;
            const pageEntries: PageEntry[] = d.pages.map((p, i) => ({
              pageNum: i + 1, width: p.width, height: p.height,
            }));
            setPdfiumDoc(d);
            onDocLoaded({ numPages: pageEntries.length, engine: "pdfium" });
            setPages(pageEntries);
            if (pageEntries[0]) onPageWidth?.(pageEntries[0].width);
            return;
          } catch (err) {
            console.warn("PDFium open failed, falling back to pdf.js:", err);
            if (cancelled) return;
          }
        }

        const pdfDoc = await openPdfDocument(filePath);
        if (cancelled) {
          pdfDoc.destroy().catch(() => undefined);
          return;
        }
        ownedDoc = pdfDoc;

        setDoc(pdfDoc);
        onDocLoaded({ numPages: pdfDoc.numPages, engine: "pdfjs" });

        // Page dimensions in parallel — sequential awaits add a worker
        // round-trip per page, noticeable on long documents.
        const pageEntries: PageEntry[] = await Promise.all(
          Array.from({ length: pdfDoc.numPages }, (_, i) =>
            pdfDoc.getPage(i + 1).then((page) => {
              const vp = page.getViewport({ scale: 1 });
              return { pageNum: i + 1, width: vp.width, height: vp.height };
            })
          )
        );
        if (!cancelled) {
          setPages(pageEntries);
          if (pageEntries[0]) onPageWidth?.(pageEntries[0].width);
        }
      } catch (err) {
        console.error("Failed to load PDF:", err);
        if (!cancelled) setError(String(err));
      }
    })();

    return () => {
      cancelled = true;
      ownedDoc?.destroy().catch(() => undefined);
      if (ownedPdfium) pdfiumClose(ownedPdfium.id);
    };
  }, [filePath, renderEngine, onDocLoaded]);

  // ── PDFium per-page data ──
  const getPageText = useCallback((pageNum: number): Promise<PageText> => {
    const cached = textCache.current.get(pageNum);
    if (cached) return cached;
    if (!pdfiumDoc) return Promise.reject(new Error("no PDFium document"));
    const entry = pagesRef.current[pageNum - 1];
    const p = pdfiumText(pdfiumDoc.id, pageNum - 1).then((tp) => {
      const pt = makePageText(tp, entry?.width ?? Infinity, entry?.height ?? Infinity);
      textReady.current.set(pageNum, pt);
      return pt;
    });
    p.catch(() => textCache.current.delete(pageNum));
    textCache.current.set(pageNum, p);
    return p;
  }, [pdfiumDoc]);

  const getLinks = useCallback((pageNum: number): Promise<PdfiumLink[]> => {
    const cached = linksCache.current.get(pageNum);
    if (cached) return cached;
    if (!pdfiumDoc) return Promise.resolve([]);
    const p = pdfiumLinks(pdfiumDoc.id, pageNum - 1);
    linksCache.current.set(pageNum, p);
    return p;
  }, [pdfiumDoc]);

  // Internal link navigation (both engines): scroll so `destY` display points
  // down the target page sit 80 px below the viewport top, flash a band there
  // (3.5 s so it's easy to spot), and let the parent offer "Back to reading".
  const navigateInternal = useCallback((targetPage: number, destY: number | null | undefined) => {
    const scrollContainer = containerRef.current;
    const pageEl = pageRefs.current.get(targetPage);
    if (!scrollContainer || !pageEl) return;
    onInternalNavigateRef.current?.(scrollContainer.scrollTop);
    if (destY == null || !Number.isFinite(destY)) {
      pageEl.scrollIntoView({ behavior: "smooth" });
      return;
    }
    const entry = pagesRef.current[targetPage - 1];
    const yPt = Math.max(0, Math.min(entry?.height ?? destY, destY));
    const yFromTop = yPt * scale;
    const containerRect = scrollContainer.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();
    const targetY = scrollContainer.scrollTop + (pageRect.top - containerRect.top) + yFromTop - 80;
    scrollContainer.scrollTo({ top: Math.max(0, targetY), behavior: "smooth" });

    const flash = document.createElement("div");
    flash.style.cssText = `
      position: absolute; left: 0; top: ${yFromTop}px;
      width: 100%; height: 28px;
      background: rgba(88, 166, 255, 0.45);
      pointer-events: none; z-index: 10;
      border-radius: 3px;
      animation: hyji-flash 3.5s ease-out forwards;
    `;
    pageEl.appendChild(flash);
    setTimeout(() => flash.remove(), 3500);
  }, [scale]);

  // Resolve what a page link points at: the label under the link on its own
  // page (e.g. "47") helps the Rust side pick the right bibliography line.
  const resolveCite = useCallback((l: PdfiumLink, pageNum: number, index: number): Promise<CitePreviewData | null> => {
    const key = `${pageNum}:${index}`;
    const hit = citeCache.current.get(key);
    if (hit) return hit;
    const doc = pdfiumDoc;
    if (!doc || l.destPage == null || l.destY == null) return Promise.resolve(null);
    const p = (async (): Promise<CitePreviewData | null> => {
      let label = "";
      try {
        const pt = await getPageText(pageNum);
        for (let i = 0; i < pt.tp.chars.length; i++) {
          const c = pt.tp.chars[i];
          if (!pt.visible[i]) continue;
          const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
          if (cx >= l.x && cx <= l.x + l.w && cy >= l.y && cy <= l.y + l.h) label += c.c;
        }
      } catch { /* label is only a hint */ }
      const entry = await pdfiumLinkEntry(doc.id, l.destPage!, l.destX, l.destY!, label.trim());
      if (!entry || !entry.text.trim()) return null;
      if (entry.kind === "reference") return { kind: "reference", parsed: parseCitation(entry.text), raw: entry.text };
      return { kind: "other", raw: entry.text };
    })();
    p.catch(() => citeCache.current.delete(key));
    citeCache.current.set(key, p);
    return p;
  }, [pdfiumDoc, getPageText]);

  const hideCite = useCallback(() => {
    citeToken.current++;
    if (citeTimer.current) { clearTimeout(citeTimer.current); citeTimer.current = null; }
    setCiteCard(null);
  }, []);

  const buildLinkLayer = useCallback((links: PdfiumLink[], pageNum: number): HTMLDivElement => {
    const layer = document.createElement("div");
    layer.className = "annotationLayer";
    layer.dataset.page = String(pageNum);
    links.forEach((l, index) => {
      if (l.kind === "none") return;
      const section = document.createElement("section");
      section.className = "linkAnnotation";
      section.style.cssText = `left:${l.x * scale}px;top:${l.y * scale}px;width:${l.w * scale}px;height:${l.h * scale}px;`;
      const a = document.createElement("a");
      if (l.kind === "uri") {
        a.href = l.uri ?? "#";
        a.title = l.uri ?? "";
        a.rel = "noopener noreferrer nofollow";
      } else {
        a.href = `#page=${(l.destPage ?? 0) + 1}`;
      }
      if (l.kind === "page") {
        // Hover preview: wait a moment so sweeping the pointer across a line
        // of citations does not flicker cards; drop stale resolutions.
        a.addEventListener("mouseenter", () => {
          const f = citeFieldsRef.current;
          if (!f.authors && !f.title && !f.venue && !f.year) return;
          const token = ++citeToken.current;
          if (citeTimer.current) clearTimeout(citeTimer.current);
          citeTimer.current = setTimeout(async () => {
            const data = await resolveCite(l, pageNum, index);
            if (token !== citeToken.current || !data || !a.isConnected) return;
            const r = a.getBoundingClientRect();
            setCiteCard({ data, anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
          }, 280);
        });
        a.addEventListener("mouseleave", hideCite);
      }
      a.addEventListener("click", (e) => {
        e.preventDefault();
        hideCite();
        if (l.kind === "uri") {
          const uri = l.uri ?? "";
          // External links open in the system browser, never inside the WebView.
          if (/^(https?|mailto):/i.test(uri)) {
            import("@tauri-apps/plugin-shell").then(({ open }) => open(uri)).catch(() => undefined);
          }
        } else if (l.destPage != null) {
          navigateInternal(l.destPage + 1, l.destY);
        }
      });
      section.appendChild(a);
      layer.appendChild(section);
    });
    return layer;
  }, [scale, navigateInternal, resolveCite, hideCite]);

  // ── In-document search (PDFium engine) ──
  // Matches come from pdfium_search per rendered page (cached per page +
  // query); each match becomes one highlight div per line (union of its char
  // boxes) in a `.searchLayer` over the page. Count/index run over rendered
  // pages in page order, like the pdf.js span scan did. Re-run after every
  // page render (the container is cleared) — layers are rebuilt from the
  // cache without another IPC call.
  const runPdfiumSearch = useCallback(async (scrollActive: boolean) => {
    const pdfium = pdfiumDoc;
    const root = containerRef.current;
    if (!pdfium || !root) return;
    const gen = ++searchGen.current;
    const query = searchQuery;
    if (!query) {
      root.querySelectorAll(".searchLayer").forEach((el) => el.remove());
      onSearchResults(0);
      return;
    }
    const renderedNums = [...renderedPages.current.keys()]
      .filter((n) => renderRefs.current.get(n)?.querySelector(".textLayer"))
      .sort((a, b) => a - b);

    const hits: Array<{ page: number; rects: PdfRect[] }> = [];
    for (const n of renderedNums) {
      let cached = searchCache.current.get(n);
      if (!cached || cached.query !== query) {
        const matches = await pdfiumSearch(pdfium.id, n - 1, query, false).catch(() => [] as PdfiumSearchMatch[]);
        if (gen !== searchGen.current) return;
        cached = { query, matches };
        searchCache.current.set(n, cached);
      }
      if (cached.matches.length === 0) continue;
      let pt: PageText;
      try {
        pt = await getPageText(n);
      } catch {
        continue;
      }
      if (gen !== searchGen.current) return;
      for (const m of cached.matches) {
        const rects = charRangeRects(pt, m.start, m.end, n);
        // Matches made only of hidden chars (off-page / ActualText) don't count.
        if (rects.length > 0) hits.push({ page: n, rects });
      }
    }
    onSearchResults(hits.length);

    const layers = new Map<number, HTMLDivElement>();
    for (const n of renderedNums) {
      const c = renderRefs.current.get(n);
      if (!c) continue;
      c.querySelectorAll(".searchLayer").forEach((el) => el.remove());
      const layer = document.createElement("div");
      layer.className = "searchLayer";
      layer.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:2;overflow:hidden;";
      c.appendChild(layer);
      layers.set(n, layer);
    }
    hits.forEach((h, i) => {
      const layer = layers.get(h.page);
      if (!layer) return;
      const active = i === searchIndex;
      h.rects.forEach((r, k) => {
        const div = document.createElement("div");
        div.style.cssText = `position:absolute;left:${r.x * scale}px;top:${r.y * scale}px;width:${r.w * scale}px;height:${r.h * scale}px;border-radius:2px;`
          + (active
            ? "background:rgba(255,107,53,0.5);outline:2px solid #ff6b35;z-index:10;"
            : "background:rgba(255,209,102,0.4);");
        layer.appendChild(div);
        if (active && scrollActive && k === 0) div.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  }, [pdfiumDoc, searchQuery, searchIndex, scale, onSearchResults, getPageText]);
  // Called from inside renderPage via a ref so the render callbacks don't
  // change identity (and re-render every page) on each search keystroke.
  const runSearchRef = useRef(runPdfiumSearch);
  runSearchRef.current = runPdfiumSearch;

  // ── Page rendering: PDFium engine ──
  // Raster: pdfium_render for the whole page when its RGBA fits
  // MAX_RENDER_BYTES, else horizontal strips via pdfium_render_region at the
  // same scale (pixel-identical). Canvas backing = ceil(pageW·scale·dpr) —
  // the same formula as Rust's scaled_size, computed on the f32-rounded
  // scale so both sides agree on the pixel size. Then the PDFium text layer,
  // link anchors and (if a search is active) the search layer.
  const renderPagePdfium = useCallback(
    async (pageNum: number, container: HTMLDivElement, stale: () => boolean) => {
      if (!pdfiumDoc) return;
      const entry = pagesRef.current[pageNum - 1];
      if (!entry) return;
      const dpr = window.devicePixelRatio || 1;
      const pixelScale = Math.fround(scale * dpr);
      const W = Math.ceil(entry.width * pixelScale);
      const H = Math.ceil(entry.height * pixelScale);

      container.innerHTML = "";
      const canvas = makePageCanvas(W, H, dpr);
      container.appendChild(canvas);
      const ctx = canvas.getContext("2d")!;

      if (W * H * 4 <= MAX_RENDER_BYTES) {
        const rgba = await pdfiumRender(pdfiumDoc.id, pageNum - 1, W, H, true);
        if (stale()) return;
        ctx.putImageData(new ImageData(rgba, W, H), 0, 0);
      } else {
        const stripH = Math.max(1, Math.floor(MAX_RENDER_BYTES / (W * 4)));
        for (let y = 0; y < H; y += stripH) {
          const h = Math.min(stripH, H - y);
          const rgba = await pdfiumRenderRegion(pdfiumDoc.id, pageNum - 1, pixelScale, 0, y, W, h, true);
          if (stale()) return;
          ctx.putImageData(new ImageData(rgba, W, h), 0, y);
        }
      }

      // Bitmap-figure regions (CSS px) — exempt photos from stem darkening
      // and counter-invert them in dark mode. Only fetched when a consumer
      // is active; toggling dark mode re-renders (part of the render key).
      let imageRegions: CssRect[] = [];
      if (pdfDarkMode || (dpr < 1.5 && pdfiumDarkening > 0)) {
        imageRegions = (await pdfiumImageRegions(pdfiumDoc.id, pageNum - 1)).map((r) => ({
          x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale,
        }));
        if (stale()) return;
      }
      applyPostRender(canvas, ctx, container, imageRegions, pdfiumDarkening, dpr);

      // Text layer from PDFium chars (selection geometry comes from the same
      // char boxes — see fireContextMenuFromSelection).
      const pt = await getPageText(pageNum);
      if (stale()) return;
      const textLayerDiv = buildPdfiumTextLayer(pt, scale, pageNum);
      // Toggle .selecting on the textLayer during drag. The matching "remove
      // on mouseup" lives in ONE component-level listener (useEffect below).
      textLayerDiv.addEventListener("mousedown", () => {
        textLayerDiv.classList.add("selecting");
      });
      container.appendChild(textLayerDiv);

      // Links (URLs + internal destinations) from pdfium_links.
      const links = await getLinks(pageNum);
      if (stale()) return;
      container.appendChild(buildLinkLayer(links, pageNum));

      if (searchQueryRef.current) void runSearchRef.current(false);
    },
    [pdfiumDoc, scale, pdfDarkMode, pdfiumDarkening, getPageText, getLinks, buildLinkLayer]
  );

  // ── Page rendering: classic pdf.js engine (pre-3.2 viewer, unchanged) ──
  const renderPagePdfjs = useCallback(
    async (pageNum: number, container: HTMLDivElement, stale: () => boolean) => {
      if (!doc) return;
      const page = await doc.getPage(pageNum);
      if (stale()) return;
      const viewport = page.getViewport({ scale });

      // Clear previous
      container.innerHTML = "";

      // Canvas
      const dpr = window.devicePixelRatio || 1;
      const renderViewport = page.getViewport({ scale: scale * dpr });
      const canvas = makePageCanvas(Math.floor(renderViewport.width), Math.floor(renderViewport.height), dpr);
      container.appendChild(canvas);

      const ctx = canvas.getContext("2d")!;
      await page.render({ canvasContext: ctx, viewport: renderViewport } as any).promise;
      if (stale()) return;

      // Bitmap-figure regions (viewport/CSS space): getOperatorList() forces
      // a second full decode of the page (images included), so only pay for
      // it when a consumer is actually active.
      let imageRegions: CssRect[] = [];
      if (pdfDarkMode || (dpr < 1.5 && pdfjsDarkening > 0)) {
        try {
          const opList = await page.getOperatorList();
          imageRegions = computeImageRegions(opList, viewport);
        } catch { /* best-effort */ }
        if (stale()) return;
      }
      applyPostRender(canvas, ctx, container, imageRegions, pdfjsDarkening, dpr);

      // Text layer — use pdfjs TextLayer class for accurate span sizing and positioning
      const textLayerDiv = document.createElement("div");
      textLayerDiv.className = "textLayer";
      container.appendChild(textLayerDiv);

      // setLayerDimensions uses --total-scale-factor but does NOT set it.
      // In the official viewer, PDFPageView sets it. We must set it manually.
      textLayerDiv.style.setProperty("--total-scale-factor", `${scale}`);
      // --scale-round-x/y needed if CSS round() is supported
      textLayerDiv.style.setProperty("--scale-round-x", "1px");
      textLayerDiv.style.setProperty("--scale-round-y", "1px");
      pdfjsLib.setLayerDimensions(textLayerDiv, viewport);

      const textLayer = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent(),
        container: textLayerDiv,
        viewport,
      });
      await textLayer.render();

      // Selection-bleed mitigation, v3 (verified via scripted drag test):
      // suppress ::selection ONLY on whitespace-only spans — their large
      // scaleX transforms are what paint the full-line flash. Text-bearing
      // spans always keep the visible selection highlight; the previous
      // scaleX<=1.5 heuristic over-marked them and made normal drag
      // selection invisible.
      textLayerDiv.querySelectorAll("span").forEach((span) => {
        if (!(span.textContent ?? "").trim()) {
          (span as HTMLElement).classList.add("pdfjs-space");
        }
      });
      // Create endOfContent div — required for drag-to-select across spans.
      const endOfContent = document.createElement("div");
      endOfContent.className = "endOfContent";
      textLayerDiv.appendChild(endOfContent);

      // Toggle .selecting class on the textLayer during drag. The matching
      // "remove on mouseup" lives in ONE component-level listener (below in a
      // useEffect) — a per-page document listener here leaked the whole text
      // layer of every page ever rendered after the tab closed.
      textLayerDiv.addEventListener("mousedown", () => {
        textLayerDiv.classList.add("selecting");
      });

      // Annotation layer — renders clickable links (URLs + internal refs)
      const annotationLayerDiv = document.createElement("div");
      annotationLayerDiv.className = "annotationLayer";
      container.appendChild(annotationLayerDiv);
      pdfjsLib.setLayerDimensions(annotationLayerDiv, viewport);

      // Simple link service for internal/external PDF links
      const linkService = {
        externalLinkEnabled: true,
        externalLinkRel: "noopener noreferrer nofollow",
        externalLinkTarget: 2, // BLANK
        getDestinationHash: (dest: any) => (typeof dest === "string" ? `#${dest}` : `#page=${dest?.[0] ?? ""}`),
        getAnchorUrl: (hash: string) => hash,
        addLinkAttributes: (link: HTMLAnchorElement, url: string, newWindow?: boolean) => {
          link.href = url;
          link.rel = "noopener noreferrer nofollow";
          if (newWindow) link.target = "_blank";
        },
        goToDestination: async (dest: any) => {
          if (!doc) return;
          try {
            const resolvedDest = typeof dest === "string" ? await doc.getDestination(dest) : dest;
            if (!resolvedDest) return;
            const ref = resolvedDest[0];
            const pageIndex = typeof ref === "number" ? ref : (await doc.getPageIndex(ref));
            const targetPage = pageIndex + 1;

            // Extract y coordinate from destination: [ref, /XYZ, x, y, zoom] or [ref, /FitH, y]
            const destType = resolvedDest[1]?.name;
            let yPdf: number | null = null;
            if (destType === "XYZ" && resolvedDest[3] != null) {
              yPdf = resolvedDest[3];
            } else if (destType === "FitH" && resolvedDest[2] != null) {
              yPdf = resolvedDest[2];
            } else if (destType === "FitBH" && resolvedDest[2] != null) {
              yPdf = resolvedDest[2];
            }
            // PDF y is from bottom; convert to top-down display points
            const pageHeightPt = pagesRef.current[targetPage - 1]?.height ?? 842;
            navigateInternal(targetPage, yPdf != null ? pageHeightPt - yPdf : null);
          } catch { /* ignore invalid destinations */ }
        },
        goToPage: (pageNum: number) => {
          const el = pageRefs.current.get(pageNum);
          if (el) el.scrollIntoView({ behavior: "smooth" });
        },
        navigateTo: (dest: any) => linkService.goToDestination(dest),
      };

      const annotationData = await page.getAnnotations();
      const annotLayerViewport = viewport.clone({ dontFlip: true });
      const annotationLayer = new pdfjsLib.AnnotationLayer({
        div: annotationLayerDiv,
        accessibilityManager: null,
        annotationCanvasMap: null,
        annotationEditorUIManager: null,
        page,
        viewport: annotLayerViewport,
        structTreeLayer: null,
        commentManager: null,
        linkService: linkService as any,
        annotationStorage: null,
      });
      await annotationLayer.render({
        div: annotationLayerDiv,
        viewport: annotLayerViewport,
        annotations: annotationData,
        page,
        linkService: linkService as any,
        imageResourcesPath: "",
        renderForms: false,
      } as any);

      // External links: open in system browser instead of WebView
      annotationLayerDiv.querySelectorAll("a[href]").forEach((a) => {
        const el = a as HTMLAnchorElement;
        const href = el.getAttribute("href") || "";
        if (href.startsWith("http")) {
          el.addEventListener("click", (e) => {
            e.preventDefault();
            import("@tauri-apps/plugin-shell").then(({ open }) => open(href));
          });
        }
      });
    },
    [doc, scale, pdfDarkMode, pdfjsDarkening, navigateInternal]
  );

  // Render a single page (engine dispatch + cache / stale bookkeeping)
  const renderPage = useCallback(
    async (pageNum: number) => {
      const engine = pdfiumDoc ? "pdfium" : doc ? "pdfjs" : null;
      if (!engine) return;
      // Skip if already rendered with these exact parameters — a dpr change
      // alone (monitor move), a darkening-preference change or a dark-mode
      // toggle must invalidate the cached bitmap.
      const darkening = engine === "pdfium" ? pdfiumDarkening : pdfjsDarkening;
      const renderKey = `${engine}@${scale}@${window.devicePixelRatio || 1}@${darkening}@${pdfDarkMode ? "d" : "l"}`;
      if (renderedPages.current.get(pageNum) === renderKey) return;

      const container = renderRefs.current.get(pageNum);
      if (!container) return;
      renderedPages.current.set(pageNum, renderKey);
      const seq = (renderSeq.current.get(pageNum) ?? 0) + 1;
      renderSeq.current.set(pageNum, seq);
      const stale = () => renderSeq.current.get(pageNum) !== seq;

      try {
        if (engine === "pdfium") await renderPagePdfium(pageNum, container, stale);
        else await renderPagePdfjs(pageNum, container, stale);
      } catch (err) {
        if (stale()) return;
        // Render failed (e.g. the document was destroyed mid-flight during a
        // tab switch) — forget the render key so a later pass can retry.
        renderedPages.current.delete(pageNum);
        console.warn(`Render failed for page ${pageNum}:`, err);
      }
    },
    [doc, pdfiumDoc, scale, pdfjsDarkening, pdfiumDarkening, pdfDarkMode, renderPagePdfium, renderPagePdfjs]
  );

  // Single component-level "drag ended" listener for all text layers —
  // pairs with the per-layer mousedown registered inside renderPage.
  useEffect(() => {
    const onMouseUp = () => {
      containerRef.current
        ?.querySelectorAll(".textLayer.selecting")
        .forEach((el) => el.classList.remove("selecting"));
    };
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, []);

  // Expose methods for print
  useImperativeHandle(ref, () => ({
    // One HTML fragment per page for the print iframe, at ~216 DPI (3 px/pt).
    //
    // PDFium: pages are written as PNG files under the app temp dir by Rust
    // (print-sized bitmaps never cross the IPC bridge) and referenced via the
    // asset protocol; highlights/underlines/strikeouts/memos are CSS overlays
    // positioned in % of the page so they survive print scaling. Opacities
    // match the viewer: highlight 0.38, memo 0.18, lines 0.9 with thickness
    // max(1.5 px, 7 % of the rect height) at 3×.
    //
    // pdf.js: rendered to a canvas with the same overlays burned in (pre-3.2).
    getPrintPages: async (): Promise<PrintPages> => {
      const PRINT_SCALE = 3;
      const noop = async () => undefined;
      const pageAnnotationRects = (pageNum: number) => {
        const out: Array<{ r: PdfRect; hex: string; alpha: number; line: "underline" | "strikeout" | null }> = [];
        for (const ann of annotations) {
          if (ann.type !== "highlight" && ann.type !== "memo") continue;
          let rects: PdfRect[] = [];
          try { rects = JSON.parse(ann.rects_json || "[]"); } catch { continue; }
          // Filter rects for this page: use pageIndex if present, otherwise fall back to ann.page
          const pageRects = rects.filter((r) => (r.pageIndex ? r.pageIndex === pageNum : ann.page === pageNum));
          if (pageRects.length === 0) continue;
          const line = ann.style === "underline" || ann.style === "strikeout" ? ann.style : null;
          const alpha = line ? 0.9 : ann.type === "memo" ? 0.18 : 0.38;
          for (const r of pageRects) out.push({ r, hex: ann.color.slice(0, 7), alpha, line });
        }
        return out;
      };

      if (pdfiumDoc) {
        const { tempDir, join } = await import("@tauri-apps/api/path");
        const { mkdir, remove } = await import("@tauri-apps/plugin-fs");
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        const dir = await join(await tempDir(), `hyji-print-${Date.now()}`);
        await mkdir(dir, { recursive: true });
        const cleanup = () => remove(dir, { recursive: true }).catch(() => undefined);
        try {
          const html: string[] = [];
          for (const p of pages) {
            const out = await join(dir, `page-${p.pageNum}.png`);
            await pdfiumRenderPngToFile(pdfiumDoc.id, p.pageNum - 1, PRINT_SCALE, true, out);
            const pct = (v: number, total: number) => `${((v / total) * 100).toFixed(4)}%`;
            let overlays = "";
            for (const { r, hex, alpha, line } of pageAnnotationRects(p.pageNum)) {
              let x = r.x, y = r.y, w = r.w, h = r.h;
              if (line) {
                // thickness in bitmap px at 3× → points
                const tPt = Math.max(1.5, r.h * PRINT_SCALE * 0.07) / PRINT_SCALE;
                y = line === "underline" ? r.y + r.h - tPt : r.y + r.h / 2 - tPt / 2;
                h = tPt;
              }
              overlays += `<div class="hl" style="position:absolute;left:${pct(x, p.width)};top:${pct(y, p.height)};width:${pct(w, p.width)};height:${pct(h, p.height)};background:${hex};opacity:${alpha}"></div>`;
            }
            html.push(`<div class="page" style="position:relative"><img src="${convertFileSrc(out)}">${overlays}</div>`);
          }
          return { pages: html, cleanup };
        } catch (err) {
          await cleanup();
          throw err;
        }
      }

      if (!doc) return { pages: [], cleanup: noop };
      const imgs: string[] = [];
      for (const p of pages) {
        const page = await doc.getPage(p.pageNum);
        const viewport = page.getViewport({ scale: PRINT_SCALE });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d")!;
        await page.render({ canvasContext: ctx, viewport } as any).promise;

        // Burn highlights from annotations — match viewer's HighlightLayer exactly
        for (const { r, hex, alpha, line } of pageAnnotationRects(p.pageNum)) {
          const cr = parseInt(hex.slice(1, 3), 16);
          const cg = parseInt(hex.slice(3, 5), 16);
          const cb = parseInt(hex.slice(5, 7), 16);
          ctx.globalAlpha = alpha;
          ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
          if (line) {
            const h = r.h * PRINT_SCALE;
            const t = Math.max(1.5, h * 0.07);
            const y = line === "underline"
              ? r.y * PRINT_SCALE + h - t
              : r.y * PRINT_SCALE + h / 2 - t / 2;
            ctx.fillRect(r.x * PRINT_SCALE, y, r.w * PRINT_SCALE, t);
          } else {
            ctx.fillRect(r.x * PRINT_SCALE, r.y * PRINT_SCALE, r.w * PRINT_SCALE, r.h * PRINT_SCALE);
          }
        }
        ctx.globalAlpha = 1;
        imgs.push(`<div class="page" style="position:relative"><img src="${canvas.toDataURL("image/png")}"></div>`);
      }
      return { pages: imgs, cleanup: noop };
    },
    renderAllPages: async () => {
      for (const p of pages) {
        await renderPage(p.pageNum);
      }
    },
    scrollToY: (y: number) => {
      containerRef.current?.scrollTo({ top: y, behavior: "smooth" });
    },
  }), [pages, doc, pdfiumDoc, renderPage, annotations]);

  // Re-render when scale / devicePixelRatio / rendering prefs change — the
  // text layer and highlight overlay are rebuilt inside renderPage (container
  // is cleared), so they always match the fresh canvas size.
  //
  // Only the pages near the viewport are rendered here. Rendering the WHOLE
  // document (the previous behavior) allocated a full-resolution canvas, text
  // layer and annotation layer for every page up front — on long or
  // image-heavy PDFs that meant seconds of load time and hundreds of MB of
  // canvas memory per open document. Off-screen pages are picked up lazily by
  // the IntersectionObserver as the user scrolls.
  useEffect(() => {
    renderedPages.current.clear();
    const visible = visiblePagesRef.current;
    for (const p of pages) {
      if (visible.has(p.pageNum) || visible.has(p.pageNum - 1) || visible.has(p.pageNum + 1)) {
        renderPage(p.pageNum);
      }
    }
  }, [scale, dpr, pdfjsDarkening, pdfiumDarkening, renderEngine, pages, renderPage]);

  // Restore the last reading position when this document (re)loads,
  // e.g. after switching back to its tab. Only after this runs do scroll
  // events start recording into this file's memory (loadedFileRef).
  useEffect(() => {
    if (pages.length === 0 || !containerRef.current) return;
    const saved = scrollMemory.get(filePath);
    if (saved != null) containerRef.current.scrollTop = saved;
    loadedFileRef.current = filePath;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

  // Intersection observer for lazy rendering + page tracking
  useEffect(() => {
    const root = containerRef.current;
    if (!root || pages.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNum = parseInt(
            (entry.target as HTMLElement).dataset.page!,
            10
          );
          if (entry.isIntersecting) {
            visiblePagesRef.current.add(pageNum);
            renderPage(pageNum);
            // Pre-render one page ahead/behind so scrolling never waits.
            renderPage(pageNum + 1);
            renderPage(pageNum - 1);
          } else {
            visiblePagesRef.current.delete(pageNum);
          }
          if (entry.isIntersecting && entry.intersectionRatio > 0.3) {
            onPageChange(pageNum);
          }
        }

        // Long documents: drop rendered pages far outside the viewport so
        // canvas memory stays bounded while reading (each rendered page holds
        // a multi-MB bitmap). Short documents are left alone.
        const visible = visiblePagesRef.current;
        if (pages.length > 40 && visible.size > 0) {
          const nums = [...visible];
          const lo = Math.min(...nums) - 12;
          const hi = Math.max(...nums) + 12;
          for (const pn of [...renderedPages.current.keys()]) {
            if (pn >= lo && pn <= hi) continue;
            const el = renderRefs.current.get(pn);
            if (el) {
              el.querySelectorAll("canvas").forEach((cv) => {
                cv.width = 0;
                cv.height = 0;
              });
              el.innerHTML = "";
            }
            renderedPages.current.delete(pn);
          }
        }
      },
      { root, threshold: [0, 0.3] }
    );

    pageRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [pages, renderPage, onPageChange]);

  // On unmount, explicitly release canvas bitmaps — detached canvases can
  // keep their GPU memory alive until a much later GC pass.
  useEffect(() => {
    const renders = renderRefs.current;
    return () => {
      renders.forEach((el) => {
        el.querySelectorAll("canvas").forEach((cv) => {
          cv.width = 0;
          cv.height = 0;
        });
      });
    };
  }, []);

  // Go to page
  useEffect(() => {
    if (goToPage && pageRefs.current.has(goToPage)) {
      pageRefs.current.get(goToPage)!.scrollIntoView({ behavior: "smooth" });
    }
  }, [goToPage]);

  // Scroll to annotation and flash using stored rects (no DOM mutation)
  useEffect(() => {
    if (!scrollToAnnotation) return;
    const { page, noteField, rects_json } = scrollToAnnotation;

    const flashColor = noteField === "questions"
      ? "rgba(114, 9, 183, 0.55)"
      : "rgba(255, 107, 53, 0.6)";

    const pageEl = pageRefs.current.get(Number(page));
    const container = containerRef.current;
    if (!pageEl || !container) return;

    // Scroll page into view
    const containerRect = container.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();
    const targetScrollTop =
      container.scrollTop +
      (pageRect.top - containerRect.top) -
      (containerRect.height - pageRect.height) / 2;
    container.scrollTo({ top: Math.max(0, targetScrollTop), behavior: "smooth" });

    // Create temporary flash overlay divs from stored rects
    let rects: { x: number; y: number; w: number; h: number; pageIndex?: number }[] = [];
    try {
      rects = JSON.parse(rects_json || "[]");
    } catch { /* ignore */ }
    rects = rects.filter((r) => !r.pageIndex || r.pageIndex === Number(page));

    if (rects.length === 0) {
      // No rects: fall back to page outline
      const fallbackColor = noteField === "questions" ? "#a78bfa" : "#ff6b35";
      pageEl.style.outline = `3px solid ${fallbackColor}`;
      pageEl.style.outlineOffset = "4px";
      const t = setTimeout(() => {
        pageEl.style.outline = "";
        pageEl.style.outlineOffset = "";
      }, 1800);
      return () => clearTimeout(t);
    }

    // Render flash overlays as absolute divs inside the page element
    const overlays = rects.map((r) => {
      const div = document.createElement("div");
      div.style.cssText = `
        position: absolute;
        left: ${r.x * scale}px;
        top: ${r.y * scale}px;
        width: ${r.w * scale}px;
        height: ${r.h * scale}px;
        background: ${flashColor};
        border-radius: 2px;
        pointer-events: none;
        z-index: 10;
        animation: hyji-flash 1.8s ease-out forwards;
      `;
      pageEl.appendChild(div);
      return div;
    });

    const t = setTimeout(() => {
      overlays.forEach((div) => div.remove());
    }, 1800);
    return () => {
      clearTimeout(t);
      overlays.forEach((div) => div.remove());
    };
  }, [scrollToAnnotation, scale]);

  // Search highlighting with match count + active match navigation.
  // PDFium engine: pdfium_search + .searchLayer (runPdfiumSearch).
  // pdf.js engine: substring scan over the text-layer spans, highlight on
  // the span itself (pre-3.2 behavior).
  useEffect(() => {
    if (pdfiumDoc) {
      void runPdfiumSearch(true);
      return;
    }
    if (!containerRef.current) return;
    const spans = containerRef.current.querySelectorAll(".textLayer span");
    const query = searchQuery.toLowerCase();
    const matches: HTMLElement[] = [];

    spans.forEach((span) => {
      const el = span as HTMLElement;
      if (query && el.textContent?.toLowerCase().includes(query)) {
        matches.push(el);
      } else {
        // Reset to fully transparent
        el.style.backgroundColor = "transparent";
        el.style.color = "transparent";
        el.style.borderRadius = "";
        el.style.outline = "";
        el.style.zIndex = "";
      }
    });

    onSearchResults(matches.length);

    matches.forEach((el, i) => {
      const isActive = i === searchIndex;
      el.style.borderRadius = "2px";
      // Keep text transparent — only show background highlight over the canvas text
      el.style.color = "transparent";
      if (isActive) {
        el.style.backgroundColor = "rgba(255, 107, 53, 0.5)";
        el.style.outline = "2px solid #ff6b35";
        el.style.zIndex = "10";
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        el.style.backgroundColor = "rgba(255, 209, 102, 0.4)";
        el.style.outline = "";
        el.style.zIndex = "";
      }
    });
    // runPdfiumSearch already carries searchQuery/searchIndex; listing it
    // alone would re-run on scale changes too, which renderPage covers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfiumDoc, searchQuery, searchIndex, onSearchResults]);


  // Shared logic: read current selection and fire onContextMenu.
  // Used by both mouseup (auto-show) and right-click handlers.
  //
  // PDFium engine: the Range's boundaries are mapped to char indices through
  // the run spans' data-start, and the rects come from PDFium's char boxes
  // (one merged rect per line, already in display points). pdf.js engine (or
  // a boundary outside any text layer): merge the Range's client rects per
  // line and divide by `scale`.
  const fireContextMenuFromSelection = useCallback((clientX: number, clientY: number) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const selectedText = selection.toString().trim();
    if (!selectedText) return;

    // Determine which page the selection falls on by checking which page element
    // contains the selection's focus node.
    const pageOf = (n: Node | null): number | null => {
      if (!n) return null;
      for (const [num, el] of pageRefs.current) {
        if (el.contains(n)) return num;
      }
      return null;
    };
    const page = pageOf(selection.focusNode);
    const pageEl = page != null ? pageRefs.current.get(page) : undefined;
    if (page == null || !pageEl) return;

    const range = selection.getRangeAt(0);
    const pageRect = pageEl.getBoundingClientRect();

    let rects: PdfRect[] = [];
    let menuX = clientX;
    let menuY = clientY;

    const pt = pdfiumDoc ? textReady.current.get(page) : undefined;
    if (pt) {
      const total = pt.tp.chars.length;
      const ps = pageOf(range.startContainer);
      const pe = pageOf(range.endContainer);
      // Cross-page selections: only the focus page's part is captured (as
      // before); a boundary on an earlier/later page clamps to this page's
      // start/end.
      const s = ps === page
        ? charIndexFromBoundary(range.startContainer, range.startOffset, pt)
        : ps != null && ps < page ? 0 : null;
      const e = pe === page
        ? charIndexFromBoundary(range.endContainer, range.endOffset, pt)
        : pe != null && pe > page ? total : null;
      if (s != null && e != null && s < e) {
        rects = charRangeRects(pt, s, e, page);
        const last = rects[rects.length - 1];
        if (last) {
          menuX = pageRect.left + (last.x + last.w) * scale;
          menuY = pageRect.top + (last.y + last.h) * scale + 4;
        }
      }
    }

    if (rects.length === 0) {
      // Merge rects per line so stored highlights have no gaps at spaces
      const mergedViewport = mergeToLineRects(Array.from(range.getClientRects()));
      rects = mergedViewport.map((r) => ({
        x: (r.left - pageRect.left) / scale,
        y: (r.top - pageRect.top) / scale,
        w: r.width / scale,
        h: r.height / scale,
        pageIndex: page,
      }));
      // Position the menu just below the last selection rect
      const lastVP = mergedViewport[mergedViewport.length - 1];
      menuX = lastVP ? lastVP.left + lastVP.width : clientX;
      menuY = lastVP ? lastVP.top + lastVP.height + 4 : clientY;
    }

    onContextMenu({ x: menuX, y: menuY, selectedText, page, rects });
  }, [scale, onContextMenu, pdfiumDoc]);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-sm">
          <div className="text-[2.462rem] mb-3 opacity-30">⚠</div>
          <div className="text-body text-text-secondary mb-2">Failed to load PDF</div>
          <div className="text-small text-text-tertiary font-mono break-all">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`flex-1 overflow-y-auto bg-[#525659] hyji-pdf-scroll ${pdfDarkMode ? "hyji-pdf-dark" : ""}`}
      onScroll={(e) => {
        if (citeCard) hideCite();
        if (loadedFileRef.current === filePath) {
          scrollMemory.set(filePath, e.currentTarget.scrollTop);
        }
      }}
      onMouseUp={(e) => {
        // Show context menu automatically after drag-select.
        // A tiny delay lets the browser finalize the selection before we read it.
        if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
        const { clientX, clientY } = e;
        selectionTimerRef.current = setTimeout(() => {
          fireContextMenuFromSelection(clientX, clientY);
        }, 80);
      }}
    >
        {citeCard && <CitePreview data={citeCard.data} fields={citeFields} anchor={citeCard.anchor} inverted={pdfDarkMode} />}
        <div className="flex flex-col items-center gap-3 py-4 hyji-pdf-pages">
          {pages.length === 0 && (
            <div className="flex items-center justify-center py-24">
              <div className="text-body text-white/50 animate-pulse select-none">
                Loading PDF…
              </div>
            </div>
          )}
          {pages.map((p) => (
            <div
              key={p.pageNum}
              ref={(el) => {
                if (el) pageRefs.current.set(p.pageNum, el);
              }}
              data-page={p.pageNum}
              className="relative bg-white shadow-lg overflow-hidden"
              style={{
                width: p.width * scale,
                height: p.height * scale,
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                // Cancel any pending mouseup-triggered menu; right-click takes priority.
                if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
                fireContextMenuFromSelection(e.clientX, e.clientY);
              }}
            >
              {/* Imperative canvas + text layer rendered here */}
              <div
                ref={(el) => {
                  if (el) renderRefs.current.set(p.pageNum, el);
                }}
                className="absolute inset-0"
              />
              {/* React highlight overlay — zIndex 5, above text layer */}
              <HighlightLayer
                annotations={annotations}
                scale={scale}
                pageNum={p.pageNum}
                onMemoOpen={onMemoOpen}
                onAnnotationDelete={onAnnotationDelete}
              />
            </div>
          ))}
        </div>
    </div>
  );
});

// ── Utility (pdf.js engine): merge DOMRects that share the same visual line ──
// Groups rects by approximate top value and merges each group into one wide
// rect spanning left→right. This fills the gaps that appear at spaces, which
// getClientRects() does not include (spaces produce no rect in pdf.js text layer).
function mergeToLineRects(
  rects: DOMRect[]
): Array<{ left: number; top: number; width: number; height: number }> {
  const valid = rects.filter((r) => r.width > 1 && r.height > 1);
  if (valid.length === 0) return [];

  // Sort top → bottom, left → right
  const sorted = [...valid].sort((a, b) => a.top - b.top || a.left - b.left);

  const LINE_TOLERANCE = 4; // px — rects within this y-delta are on the same line
  const lines: DOMRect[][] = [];

  for (const r of sorted) {
    const last = lines[lines.length - 1];
    if (!last || Math.abs(r.top - last[0].top) > LINE_TOLERANCE) {
      lines.push([r]);
    } else {
      last.push(r);
    }
  }

  return lines.map((line) => {
    const left   = Math.min(...line.map((r) => r.left));
    const top    = Math.min(...line.map((r) => r.top));
    const right  = Math.max(...line.map((r) => r.right));
    const bottom = Math.max(...line.map((r) => r.bottom));
    return { left, top, width: right - left, height: bottom - top };
  });
}
