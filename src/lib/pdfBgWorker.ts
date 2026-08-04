import * as pdfjsLib from "pdfjs-dist";

// Dedicated pdf.js worker for background tasks (FTS indexing, keyword
// extraction, metadata scans). Without it, those tasks share the viewer's
// global worker and every page the user tries to open queues behind them —
// with a 60+ paper library a first-run index can stall the viewer for
// minutes. One worker hosts many documents concurrently, so a single
// long-lived instance is enough.
let worker: pdfjsLib.PDFWorker | null = null;

export function getBgPdfWorker(): pdfjsLib.PDFWorker {
  if (!worker || worker.destroyed) {
    worker = pdfjsLib.PDFWorker.create({ name: "hyji-background" });
  }
  return worker;
}
