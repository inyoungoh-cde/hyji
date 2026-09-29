import { pdfiumStatus, pdfiumOpen, pdfiumClose, type PdfiumDoc } from "./pdfium";
import { useUiStore } from "../stores/ui";

/**
 * Text-consumer entry points for the PDFium engine (3.2). Every scan that
 * used to open a pdf.js document (search indexing, keyword / metadata /
 * identifier extraction) asks `pdfiumAvailable()` first and, when true, runs
 * against a PDFium document instead — pdf.js is never loaded on that path.
 * False (engine preference "pdfjs", or the DLL missing) means "use the
 * classic pdf.js implementation", which every caller keeps as its fallback.
 */
export async function pdfiumAvailable(): Promise<boolean> {
  if (useUiStore.getState().pdfRenderEngine !== "pdfium") return false;
  return (await pdfiumStatus()).available;
}

/**
 * Open a PDF in PDFium for the duration of `fn`, always closing afterwards.
 * Opened EXCLUSIVELY (own handle, not the viewer's shared one) so that the
 * objects a whole-document scan parses are released here instead of staying
 * pinned to the viewer's document while its tab is open (measured: 260 MB
 * volume, shared handle → main process 90 → 463 MB after indexing).
 */
export async function withPdfiumDoc<T>(path: string, fn: (doc: PdfiumDoc) => Promise<T>): Promise<T> {
  const doc = await pdfiumOpen(path, true);
  try {
    return await fn(doc);
  } finally {
    await pdfiumClose(doc.id);
  }
}
