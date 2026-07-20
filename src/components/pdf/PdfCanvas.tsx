import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { readFile } from "@tauri-apps/plugin-fs";
import { HighlightLayer } from "./HighlightLayer";
import { PDFJS_ASSET_OPTIONS } from "../../lib/pdfjsAssets";
import { useUiStore } from "../../stores/ui";
import type { Annotation } from "../../types";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).toString();

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

interface PdfCanvasProps {
  filePath: string;
  scale: number;
  onDocLoaded: (doc: PDFDocumentProxy) => void;
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
  getPrintImages: () => Promise<string[]>;
  renderAllPages: () => Promise<void>;
  /** Smooth-scroll the PDF viewer to a specific scrollTop value. */
  scrollToY: (y: number) => void;
}

// Per-file scroll memory so switching viewer tabs returns to the position
// the user was reading. Session-scoped by design (not persisted).
const scrollMemory = new Map<string, number>();

// ── Dark-mode image regions ──────────────────────────────────────────────────
// The page canvas is CSS-inverted in dark mode, which would render photos and
// figures as negatives. Walk the page's operator list tracking the transform
// stack; every painted bitmap occupies the unit square under the current ctm.
// The resulting rects get counter-inverting backdrop-filter overlays.
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

function computeImageRegions(
  opList: { fnArray: number[]; argsArray: unknown[] },
  viewport: { convertToViewportPoint: (x: number, y: number) => number[] }
): Array<{ x: number; y: number; w: number; h: number }> {
  const OPS = pdfjsLib.OPS as Record<string, number>;
  const stack: Mat[] = [];
  let ctm: Mat = MAT_IDENTITY;
  const regions: Array<{ x: number; y: number; w: number; h: number }> = [];

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
  // Which file the currently laid-out pages belong to. Scroll events are only
  // recorded for that file — during a tab switch the collapsing old layout
  // fires a clamped scroll-to-0 that must not overwrite the new file's memory.
  const loadedFileRef = useRef<string | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<PageEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const renderedPages = useRef<Map<number, number>>(new Map()); // pageNum -> rendered scale
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());       // outer page wrapper (for observer, scroll, text queries)
  const renderRefs = useRef<Map<number, HTMLDivElement>>(new Map());     // inner div (for imperative canvas/textLayer rendering)
  const selectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load document
  useEffect(() => {
    let cancelled = false;
    loadedFileRef.current = null;
    renderedPages.current.clear();
    setPages([]);
    setDoc(null);
    setError(null);

    (async () => {
      try {
        // Read file via Tauri FS plugin
        const bytes = await readFile(filePath);
        if (cancelled) return;

        const pdfDoc = await pdfjsLib.getDocument({
          data: bytes,
          ...PDFJS_ASSET_OPTIONS,
        }).promise;
        if (cancelled) return;

        setDoc(pdfDoc);
        onDocLoaded(pdfDoc);

        const pageEntries: PageEntry[] = [];
        for (let i = 1; i <= pdfDoc.numPages; i++) {
          const page = await pdfDoc.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          pageEntries.push({
            pageNum: i,
            width: vp.width,
            height: vp.height,
          });
        }
        if (!cancelled) {
          setPages(pageEntries);
          if (pageEntries[0]) onPageWidth?.(pageEntries[0].width);
        }
      } catch (err) {
        console.error("Failed to load PDF:", err);
        if (!cancelled) setError(String(err));
      }
    })();

    return () => { cancelled = true; };
  }, [filePath, onDocLoaded]);

  // Render a single page
  const renderPage = useCallback(
    async (pageNum: number) => {
      if (!doc) return;
      // Skip if already rendered at this scale
      if (renderedPages.current.get(pageNum) === scale) return;
      renderedPages.current.set(pageNum, scale);

      const container = renderRefs.current.get(pageNum);
      if (!container) return;

      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale });

      // Cleanup previous document-level listeners before clearing
      if ((container as any).__cleanupTextLayer) {
        (container as any).__cleanupTextLayer();
      }
      // Clear previous
      container.innerHTML = "";

      // Canvas
      const canvas = document.createElement("canvas");
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.style.display = "block";
      container.appendChild(canvas);

      const ctx = canvas.getContext("2d")!;
      ctx.scale(dpr, dpr);
      await page.render({ canvasContext: ctx, viewport } as any).promise;

      // Dark-mode: counter-invert overlays over bitmap images so photos and
      // figures keep natural colors (CSS shows them only in .hyji-pdf-dark).
      try {
        const opList = await page.getOperatorList();
        for (const r of computeImageRegions(opList, viewport)) {
          const div = document.createElement("div");
          div.className = "hyji-img-region";
          div.style.cssText = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;pointer-events:none;`;
          container.appendChild(div);
        }
      } catch { /* best-effort — worst case images stay inverted */ }

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

      // Inverted strategy: mark ALL spans as pdfjs-space by default,
      // then un-mark only confirmed word spans (non-whitespace + scaleX <= 1.5).
      // More robust than trying to detect only bad spans — space span
      // properties vary considerably across PDFs.
      let _marked = 0, _kept = 0;
      textLayerDiv.querySelectorAll("span").forEach((span) => {
        const text = span.textContent ?? "";
        const m = span.style.transform.match(/scaleX\(([^)]+)\)/);
        const scaleX = m ? parseFloat(m[1]) : 1;
        if (text.trim().length > 0 && scaleX <= 1.5) {
          _kept++; // leave normal selection highlight
        } else {
          (span as HTMLElement).classList.add("pdfjs-space");
          _marked++;
        }
      });
      // eslint-disable-next-line no-console
      console.log("[hyji] page" + pageNum + ": " + _kept + " word, " + _marked + " space spans");
      // Create endOfContent div — required for drag-to-select across spans.
      const endOfContent = document.createElement("div");
      endOfContent.className = "endOfContent";
      textLayerDiv.appendChild(endOfContent);

      // Toggle .selecting class on the textLayer during drag
      const onMouseDown = () => {
        textLayerDiv.classList.add("selecting");
      };
      const onMouseUp = () => {
        textLayerDiv.classList.remove("selecting");
      };
      textLayerDiv.addEventListener("mousedown", onMouseDown);
      document.addEventListener("mouseup", onMouseUp);

      // Annotation layer — renders clickable links (URLs + internal refs)
      const annotationLayerDiv = document.createElement("div");
      annotationLayerDiv.className = "annotationLayer";
      container.appendChild(annotationLayerDiv);
      pdfjsLib.setLayerDimensions(annotationLayerDiv, viewport);

      // Simple link service for internal/external PDF links
      const scrollContainer = containerRef.current;
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
          if (!doc || !scrollContainer) return;
          try {
            const resolvedDest = typeof dest === "string" ? await doc.getDestination(dest) : dest;
            if (!resolvedDest) return;
            const ref = resolvedDest[0];
            const pageIndex = typeof ref === "number" ? ref : (await doc.getPageIndex(ref));
            const targetPage = pageIndex + 1;
            const pageEl = pageRefs.current.get(targetPage);
            if (!pageEl) return;

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

            // Scroll to exact position
            const containerRect = scrollContainer.getBoundingClientRect();
            const pageRect = pageEl.getBoundingClientRect();
            if (yPdf != null) {
              // Record pre-navigation position for the "Back" button
              const fromScrollTop = scrollContainer.scrollTop;
              onInternalNavigate?.(fromScrollTop);

              // PDF y is from bottom; convert to top-down
              const pageEntry = pages.find((p) => p.pageNum === targetPage);
              const pageHeightPt = pageEntry?.height ?? 842;
              const yFromTop = (pageHeightPt - yPdf) * scale;
              const targetY = scrollContainer.scrollTop + (pageRect.top - containerRect.top) + yFromTop - 80;
              scrollContainer.scrollTo({ top: Math.max(0, targetY), behavior: "smooth" });

              // Flash indicator — 3.5s so it's easy to spot
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
            } else {
              const fromScrollTop = scrollContainer.scrollTop;
              onInternalNavigate?.(fromScrollTop);
              pageEl.scrollIntoView({ behavior: "smooth" });
            }
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

      // Resolve internal link tooltips — show target reference text on hover
      (async () => {
        if (!doc) return;
        // Cache: pageNum -> sorted text items
        // TODO: reference tooltip preview (deferred)
      })();

      (container as any).__cleanupTextLayer = () => {
        document.removeEventListener("mouseup", onMouseUp);
      };
    },
    [doc, scale]
  );

  // Expose methods for print
  useImperativeHandle(ref, () => ({
    // Render all pages and return high-res canvas images (PNG data URLs)
    getPrintImages: async (): Promise<string[]> => {
      if (!doc) return [];
      const PRINT_SCALE = 3; // ~216 DPI, good balance between quality and speed
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
        for (const ann of annotations) {
          if (ann.type !== "highlight" && ann.type !== "memo") continue;
          let rects: { x: number; y: number; w: number; h: number; pageIndex?: number }[] = [];
          try { rects = JSON.parse(ann.rects_json || "[]"); } catch { continue; }
          // Filter rects for this page: use pageIndex if present, otherwise fall back to ann.page
          const pageRects = rects.filter((r) =>
            r.pageIndex ? r.pageIndex === p.pageNum : ann.page === p.pageNum
          );
          if (pageRects.length === 0) continue;
          const hex = ann.color;
          const cr = parseInt(hex.slice(1, 3), 16);
          const cg = parseInt(hex.slice(3, 5), 16);
          const cb = parseInt(hex.slice(5, 7), 16);
          const lineStyle = ann.style === "underline" || ann.style === "strikeout" ? ann.style : null;
          // Match viewer opacity: highlight 0.38, memo 0.18, lines 0.9
          ctx.globalAlpha = lineStyle ? 0.9 : ann.type === "memo" ? 0.18 : 0.38;
          ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
          for (const r of pageRects) {
            if (lineStyle) {
              const h = r.h * PRINT_SCALE;
              const t = Math.max(1.5, h * 0.07);
              const y = lineStyle === "underline"
                ? r.y * PRINT_SCALE + h - t
                : r.y * PRINT_SCALE + h / 2 - t / 2;
              ctx.fillRect(r.x * PRINT_SCALE, y, r.w * PRINT_SCALE, t);
            } else {
              ctx.fillRect(r.x * PRINT_SCALE, r.y * PRINT_SCALE, r.w * PRINT_SCALE, r.h * PRINT_SCALE);
            }
          }
        }
        ctx.globalAlpha = 1;
        imgs.push(canvas.toDataURL("image/png"));
      }
      return imgs;
    },
    renderAllPages: async () => {
      for (const p of pages) {
        await renderPage(p.pageNum);
      }
    },
    scrollToY: (y: number) => {
      containerRef.current?.scrollTo({ top: y, behavior: "smooth" });
    },
  }), [pages, doc, renderPage, annotations]);

  // Re-render when scale changes
  useEffect(() => {
    renderedPages.current.clear();
    pages.forEach((p) => renderPage(p.pageNum));
  }, [scale, pages, renderPage]);

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
            renderPage(pageNum);
          }
          if (entry.isIntersecting && entry.intersectionRatio > 0.3) {
            onPageChange(pageNum);
          }
        }
      },
      { root, threshold: [0, 0.3] }
    );

    pageRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [pages, renderPage, onPageChange]);

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

  // Search highlighting with match count + active match navigation
  useEffect(() => {
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
  }, [searchQuery, searchIndex, onSearchResults]);


  // Shared logic: read current selection and fire onContextMenu.
  // Used by both mouseup (auto-show) and right-click handlers.
  const fireContextMenuFromSelection = useCallback((clientX: number, clientY: number) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const selectedText = selection.toString().trim();
    if (!selectedText) return;

    // Determine which page the selection falls on by checking which page element
    // contains the selection's focus node.
    let page = 1;
    let pageEl: HTMLDivElement | null = null;
    const focusNode = selection.focusNode;
    for (const [num, el] of pageRefs.current) {
      if (el.contains(focusNode)) { page = num; pageEl = el; break; }
    }
    if (!pageEl) return;

    const range = selection.getRangeAt(0);
    const clientRects = Array.from(range.getClientRects());
    const pageRect = pageEl.getBoundingClientRect();

    // Merge rects per line so stored highlights have no gaps at spaces
    const mergedViewport = mergeToLineRects(clientRects);
    const rects: PdfRect[] = mergedViewport.map((r) => ({
      x: (r.left - pageRect.left) / scale,
      y: (r.top - pageRect.top) / scale,
      w: r.width / scale,
      h: r.height / scale,
      pageIndex: page,
    }));


    // Position the menu just below the last selection rect
    const lastVP = mergedViewport[mergedViewport.length - 1];
    const menuX = lastVP ? lastVP.left + lastVP.width : clientX;
    const menuY = lastVP ? lastVP.top + lastVP.height + 4 : clientY;

    onContextMenu({ x: menuX, y: menuY, selectedText, page, rects });
  }, [scale, onContextMenu]);

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
        <div className="flex flex-col items-center gap-3 py-4 hyji-pdf-pages">
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

// ── Utility: merge DOMRects that share the same visual line ──────────────────
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
