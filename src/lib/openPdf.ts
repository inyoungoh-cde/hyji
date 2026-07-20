import { extractPdfMeta } from "./pdfMeta";
import { usePapersStore } from "../stores/papers";
import { useUiStore } from "../stores/ui";

function normalizePath(p: string): string {
  return p.replace(/\//g, "\\").toLowerCase();
}

/**
 * Open a PDF file path as a viewer tab. If a paper already references this
 * file, its tab is (re)activated instead of creating a duplicate entry;
 * otherwise the PDF is imported as an unassigned linked paper.
 * Used by file association (double-click in Explorer) and by the
 * single-instance handler when a second HYJI launch forwards its argv.
 */
const inFlight = new Set<string>();

export async function importOrOpenPdf(path: string): Promise<void> {
  const key = normalizePath(path);
  // Guard against double-fire (e.g. two rapid single-instance forwards for
  // the same file) creating duplicate paper entries.
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    await doImportOrOpen(path);
  } finally {
    inFlight.delete(key);
  }
}

async function doImportOrOpen(path: string): Promise<void> {
  const papersStore = usePapersStore.getState();
  if (papersStore.papers.length === 0) {
    await papersStore.fetchPapers().catch(() => undefined);
  }

  const target = normalizePath(path);
  const existing = usePapersStore
    .getState()
    .papers.find((p) => p.pdf_path && normalizePath(p.pdf_path) === target);
  if (existing) {
    useUiStore.getState().setActivePaper(existing.id);
    return;
  }

  const meta = await extractPdfMeta(path).catch(() => ({ title: "" }));
  const filename = path.split(/[/\\]/).pop() ?? "Untitled";
  const title = meta.title || filename.replace(/\.pdf$/i, "");
  const paper = await papersStore.createPaper(title, null, path, "link");
  useUiStore.getState().setActivePaper(paper.id);
}
