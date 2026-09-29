import type { PDFDocumentProxy } from "pdfjs-dist";
import { openPdfDocument } from "./pdfSource";
import { getBgPdfWorker } from "./pdfBgWorker";
import { pdfiumAvailable, withPdfiumDoc } from "./pdfText";
import { pdfiumMetadata, pdfiumText } from "./pdfium";

export interface PdfMetaResult {
  title: string;
}

// Title heuristic shared by both engines: the largest-font text in the top
// 40 % of the first page (lines within 75 % of the max font size, joined
// top to bottom).
function pickTitle(lines: Array<{ text: string; fontSize: number; y: number }>): string {
  if (lines.length === 0) return "";
  const maxFont = Math.max(...lines.map((l) => l.fontSize));
  const threshold = maxFont * 0.75;
  return lines
    .filter((l) => l.fontSize >= threshold)
    .sort((a, b) => a.y - b.y)
    .map((l) => l.text.trim())
    .filter((l) => l.length > 1)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function extractPdfMeta(pdfPath: string): Promise<PdfMetaResult> {
  try {
    if (await pdfiumAvailable()) return await extractPdfMetaPdfium(pdfPath);
    return await extractPdfMetaPdfjs(pdfPath);
  } catch {
    return { title: "" };
  }
}

async function extractPdfMetaPdfium(pdfPath: string): Promise<PdfMetaResult> {
  return withPdfiumDoc(pdfPath, async (doc) => {
    // 1. Info-dict Title
    const metaTitle = (await pdfiumMetadata(doc.id)).title?.trim() ?? "";
    if (metaTitle.length > 4 && !looksLikeFilename(metaTitle)) {
      return { title: metaTitle };
    }
    if (doc.pages.length === 0) return { title: "" };

    // 2. First page: PDFium lines (display points, y grows downwards)
    const topZone = doc.pages[0].height * 0.4;
    const { chars, lineBreaks } = await pdfiumText(doc.id, 0);
    const lines: Array<{ text: string; fontSize: number; y: number }> = [];
    let start = 0;
    const flush = (end: number) => {
      let text = "";
      let fontSize = 0;
      let y = Infinity;
      for (let i = start; i < end; i++) {
        const ch = chars[i];
        text += ch.c;
        if (ch.c.trim()) {
          fontSize = Math.max(fontSize, ch.fontSize);
          y = Math.min(y, ch.y);
        }
      }
      if (text.trim() && fontSize > 0 && y < topZone) lines.push({ text, fontSize, y });
      start = end;
    };
    for (const b of lineBreaks) flush(b + 1);
    flush(chars.length);
    return { title: pickTitle(lines) };
  });
}

async function extractPdfMetaPdfjs(pdfPath: string): Promise<PdfMetaResult> {
  let doc: PDFDocumentProxy | null = null;
  try {
    doc = await openPdfDocument(pdfPath, { worker: getBgPdfWorker() });

    // 1. PDF metadata Title field
    const meta = await doc.getMetadata();
    const metaTitle = String((meta.info as Record<string, unknown>)?.Title ?? "").trim();
    if (metaTitle.length > 4 && !looksLikeFilename(metaTitle)) {
      return { title: metaTitle };
    }

    // 2. First page — find largest font text in top 40% of page
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const pageHeight = viewport.height;
    const topZone = pageHeight * 0.4;
    const textContent = await page.getTextContent();

    const items: Array<{ str: string; fontSize: number; y: number }> = [];
    for (const item of textContent.items) {
      if (!("str" in item) || !("transform" in item)) continue;
      const s = (item as { str: string }).str.trim();
      if (!s) continue;
      const t = (item as { transform: number[] }).transform;
      const fontSize = Math.abs(t[3]);
      const y = t[5];
      if (y > pageHeight - topZone) {
        items.push({ str: s, fontSize, y });
      }
    }
    if (items.length === 0) return { title: "" };

    // Group items into lines by similar pdf-space y (within 3pt), top first.
    const sorted = [...items].sort((a, b) => b.y - a.y);
    const lines: Array<{ text: string; fontSize: number; y: number }> = [];
    for (const item of sorted) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(item.y - last.y) < 3) {
        last.text += item.str;
        last.fontSize = Math.max(last.fontSize, item.fontSize);
      } else {
        lines.push({ text: item.str, fontSize: item.fontSize, y: item.y });
      }
    }
    // pickTitle sorts by ascending y (top-down); pdf y grows upwards → negate.
    return { title: pickTitle(lines.map((l) => ({ ...l, y: -l.y }))) };
  } finally {
    await doc?.destroy().catch(() => undefined);
  }
}

function looksLikeFilename(s: string): boolean {
  return /\.(pdf|docx?|tex)$/i.test(s) || /^[\w\-]{1,20}$/.test(s);
}
