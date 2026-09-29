// PDFium backend (3.0 rasterization, 3.2 text/links/search/metadata) —
// frontend wrapper around the Rust commands in src-tauri/src/pdfium.rs.
// Since 3.2 the "pdfium" engine never opens the document in pdf.js: text
// layer geometry, selection rects, links, search, print and text extraction
// all come from these commands. If the DLL is missing or fails to bind,
// `pdfiumStatus()` reports unavailable and every consumer takes the classic
// pdf.js path instead.
//
// Coordinates: all boxes are DISPLAY points, top-left origin, CropBox and
// /Rotate applied — the pdf.js viewport at scale 1, i.e. the space the
// stored annotation rects already use. Page indices are 0-based.
import { invoke } from "@tauri-apps/api/core";

export interface PdfiumStatus {
  available: boolean;
  version: string | null;
  error: string | null;
  library: string | null;
}

export interface PdfiumPageSize {
  width: number;   // display points (CropBox + /Rotate applied) — same space as pdf.js viewport at scale 1
  height: number;
}

export interface PdfiumDoc {
  id: number;
  pages: PdfiumPageSize[];
}

export interface PdfiumRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfiumTextChar {
  c: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  /** CSS rotate() degrees: 0 upright, 90 reads top-to-bottom, 270 bottom-to-top, -1 other. */
  rot: number;
}

export interface PdfiumTextPage {
  chars: PdfiumTextChar[];
  /** Indices of chars that END a line (ascending). */
  lineBreaks: number[];
}

export interface PdfiumLink {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "uri" | "page" | "none";
  uri?: string;
  /** 0-based target page. */
  destPage?: number;
  /** Display-y on the target page (unclamped — clamp to [0, pageHeight]). */
  destY?: number;
}

/** Char index range [start, end) into PdfiumTextPage.chars. */
export interface PdfiumSearchMatch {
  start: number;
  end: number;
}

export interface PdfiumMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modDate?: string;
}

export interface PdfiumPngResult {
  width: number;
  height: number;
}

let statusPromise: Promise<PdfiumStatus> | null = null;

/** Cached after the first call; pass `force` to re-probe (Preferences). */
export function pdfiumStatus(force = false): Promise<PdfiumStatus> {
  if (!statusPromise || force) {
    statusPromise = invoke<PdfiumStatus>("pdfium_status").catch((e) => ({
      available: false,
      version: null,
      error: String(e),
      library: null,
    }));
  }
  return statusPromise;
}

/** `exclusive`: a private handle for whole-document scans (never shared with
 *  the viewer) — PDFium pins everything it parses until the document closes,
 *  so a scan on the viewer's handle would keep a large file's objects in
 *  memory for as long as the tab is open. */
export function pdfiumOpen(path: string, exclusive = false): Promise<PdfiumDoc> {
  return invoke<PdfiumDoc>("pdfium_open", { path, exclusive });
}

export function pdfiumClose(id: number): Promise<void> {
  return invoke<void>("pdfium_close", { id }).catch(() => undefined);
}

/** Drop any cached document for a file — call before rewriting it in place. */
export function pdfiumClosePath(path: string): Promise<void> {
  return invoke<void>("pdfium_close_path", { path }).catch(() => undefined);
}

/** Opaque RGBA pixels, exactly width*height*4 bytes (page index is 0-based). */
export async function pdfiumRender(
  id: number,
  page: number,
  width: number,
  height: number,
  annotations = true
): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const res = await invoke<ArrayBuffer | number[]>("pdfium_render", {
    id,
    page,
    width,
    height,
    annotations,
  });
  const bytes: Uint8ClampedArray<ArrayBuffer> =
    res instanceof ArrayBuffer ? new Uint8ClampedArray(res) : new Uint8ClampedArray(Uint8Array.from(res).buffer as ArrayBuffer);
  if (bytes.length !== width * height * 4) {
    throw new Error(`pdfium_render returned ${bytes.length} bytes, expected ${width * height * 4}`);
  }
  return bytes;
}

function toRgba(res: ArrayBuffer | number[], expected: number, cmd: string): Uint8ClampedArray<ArrayBuffer> {
  const bytes: Uint8ClampedArray<ArrayBuffer> =
    res instanceof ArrayBuffer ? new Uint8ClampedArray(res) : new Uint8ClampedArray(Uint8Array.from(res).buffer as ArrayBuffer);
  if (bytes.length !== expected) {
    throw new Error(`${cmd} returned ${bytes.length} bytes, expected ${expected}`);
  }
  return bytes;
}

/**
 * Sub-rectangle `[x, x+width) × [y, y+height)` (device px) of the page as it
 * would appear in a full render at `scale` px/pt whose size is
 * ceil(pageW·scale) × ceil(pageH·scale). Pixel-identical to cropping that
 * full render, so a page can be rasterized in strips.
 */
export async function pdfiumRenderRegion(
  id: number,
  page: number,
  scale: number,
  x: number,
  y: number,
  width: number,
  height: number,
  annotations = true
): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const res = await invoke<ArrayBuffer | number[]>("pdfium_render_region", {
    id, page, scale, x, y, width, height, annotations,
  });
  return toRgba(res, width * height * 4, "pdfium_render_region");
}

/** Full-page render written as PNG (print) — never crosses the IPC bridge. */
export function pdfiumRenderPngToFile(
  id: number,
  page: number,
  scale: number,
  annotations: boolean,
  outPath: string
): Promise<PdfiumPngResult> {
  return invoke<PdfiumPngResult>("pdfium_render_png_to_file", { id, page, scale, annotations, outPath });
}

export function pdfiumText(id: number, page: number): Promise<PdfiumTextPage> {
  return invoke<PdfiumTextPage>("pdfium_text", { id, page });
}

/** Plain text of the page: chars concatenated, "
" after each line. */
export function pdfiumPageText(id: number, page: number): Promise<string> {
  return invoke<string>("pdfium_page_text", { id, page });
}

/** Non-overlapping matches in reading order; whitespace in the query matches any whitespace run. */
export function pdfiumSearch(id: number, page: number, query: string, matchCase = false): Promise<PdfiumSearchMatch[]> {
  return invoke<PdfiumSearchMatch[]>("pdfium_search", { id, page, query, matchCase });
}

export function pdfiumLinks(id: number, page: number): Promise<PdfiumLink[]> {
  return invoke<PdfiumLink[]>("pdfium_links", { id, page }).catch(() => []);
}

/** Info-dictionary strings only — PDFium exposes no XMP. */
export function pdfiumMetadata(id: number): Promise<PdfiumMetadata> {
  return invoke<PdfiumMetadata>("pdfium_metadata", { id }).catch(() => ({}));
}

/** Bitmap-image bounds in display points, top-left origin (0-based page). */
export function pdfiumImageRegions(id: number, page: number): Promise<PdfiumRegion[]> {
  return invoke<PdfiumRegion[]>("pdfium_image_regions", { id, page }).catch(() => []);
}
