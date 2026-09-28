import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFWorker } from "pdfjs-dist";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { PDFJS_ASSET_OPTIONS } from "./pdfjsAssets";

try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.mjs",
    import.meta.url
  ).toString();
} catch { /* ignore */ }

// Files up to this size are read in one go: a single IPC round trip and
// pdf.js receives the whole buffer (transferred, not copied).
//
// Larger files — proceedings volumes, scanned books — are served to pdf.js in
// ranges on demand instead. Reading a 260 MB volume whole meant a 260 MB IPC
// response, a 260 MB JS buffer, and a worker copy on every tab open (and the
// same again for the keyword scan and the search index), which is where
// "opening this paper takes forever" came from — pdf.js itself parses such a
// file in well under a second.
export const PDF_RANGE_THRESHOLD = 20 * 1024 * 1024;
const RANGE_CHUNK = 512 * 1024;
const INITIAL_CHUNK = 1024 * 1024;

export async function pdfFileSize(path: string): Promise<number> {
  return invoke<number>("file_size", { path });
}

async function readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
  const res = await invoke<ArrayBuffer | number[]>("read_file_range", { path, offset, length });
  return res instanceof ArrayBuffer ? new Uint8Array(res) : Uint8Array.from(res);
}

class TauriRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  #path: string;
  #aborted = false;

  constructor(path: string, length: number, initialData: Uint8Array) {
    // progressiveDone: nothing streams in on its own — every byte beyond the
    // initial chunk is pulled through requestDataRange.
    super(length, initialData, true);
    this.#path = path;
  }

  override requestDataRange(begin: number, end: number): void {
    readRange(this.#path, begin, end - begin)
      .then((chunk) => {
        if (!this.#aborted) this.onDataRange(begin, chunk);
      })
      .catch((e) => console.warn(`[hyji pdf] range ${begin}-${end} failed:`, e));
  }

  override abort(): void {
    this.#aborted = true;
  }
}

export interface OpenPdfOptions {
  /** Background worker for scans (indexing, keyword/metadata extraction). */
  worker?: PDFWorker;
  /** Whole-file mode only: look at the raw bytes before pdf.js takes the
   *  buffer (it is transferred to the worker and detached afterwards). */
  inspectBytes?: (bytes: Uint8Array) => void;
}

/** Open a PDF from disk, choosing whole-file or ranged loading by size. */
export async function openPdfDocument(
  path: string,
  opts: OpenPdfOptions = {}
): Promise<PDFDocumentProxy> {
  const common = {
    ...PDFJS_ASSET_OPTIONS,
    ...(opts.worker ? { worker: opts.worker } : {}),
  };

  let size = 0;
  try {
    size = await pdfFileSize(path);
  } catch { /* fall back to a whole read; it reports the real error */ }

  if (size > PDF_RANGE_THRESHOLD) {
    const initial = await readRange(path, 0, Math.min(INITIAL_CHUNK, size));
    const range = new TauriRangeTransport(path, size, initial);
    return pdfjsLib.getDocument({
      range,
      length: size,
      rangeChunkSize: RANGE_CHUNK,
      // Fetch only what the viewer asks for — auto-fetch would still pull the
      // whole file in the background.
      disableAutoFetch: true,
      disableStream: true,
      ...common,
    }).promise;
  }

  const bytes = await readFile(path);
  opts.inspectBytes?.(bytes);
  return pdfjsLib.getDocument({ data: bytes, ...common }).promise;
}
