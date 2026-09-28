// PDFium render backend (3.0) — frontend wrapper around the Rust commands in
// src-tauri/src/pdfium.rs. PDFium (Chrome/Edge's engine) rasterizes pages
// with hinted glyphs; pdf.js keeps doing everything else (text layer for
// selection, links, search, metadata). If the DLL is missing or fails to
// bind, `pdfiumStatus()` reports unavailable and the viewer falls back to
// pdf.js rendering automatically.
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

export function pdfiumOpen(path: string): Promise<PdfiumDoc> {
  return invoke<PdfiumDoc>("pdfium_open", { path });
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

/** Bitmap-image bounds in display points, top-left origin (0-based page). */
export function pdfiumImageRegions(id: number, page: number): Promise<PdfiumRegion[]> {
  return invoke<PdfiumRegion[]>("pdfium_image_regions", { id, page }).catch(() => []);
}
