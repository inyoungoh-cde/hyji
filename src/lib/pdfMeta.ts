import * as pdfjsLib from "pdfjs-dist";
import { readFile } from "@tauri-apps/plugin-fs";

try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.mjs",
    import.meta.url
  ).toString();
} catch { /* ignore */ }

export interface PdfMetaResult {
  title: string;
}

export async function extractPdfMeta(pdfPath: string): Promise<PdfMetaResult> {
  try {
    const bytes = await readFile(pdfPath);
    const doc = await pdfjsLib.getDocument({ data: bytes, cMapPacked: false }).promise;

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

    // Collect items with str + transform fields
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

    const maxFont = Math.max(...items.map((i) => i.fontSize));
    const threshold = maxFont * 0.75;

    // Sort top-to-bottom (pdf y=0 is bottom, so higher y = higher on page)
    const titleItems = items
      .filter((i) => i.fontSize >= threshold)
      .sort((a, b) => b.y - a.y);

    // Group lines by similar y (within 2pt)
    const lines: string[] = [];
    let currentLine: string[] = [];
    let lastY: number | null = null;
    for (const item of titleItems) {
      if (lastY === null || Math.abs(item.y - lastY) < 3) {
        currentLine.push(item.str);
      } else {
        if (currentLine.length) lines.push(currentLine.join("").trim());
        currentLine = [item.str];
      }
      lastY = item.y;
    }
    if (currentLine.length) lines.push(currentLine.join("").trim());

    const title = lines
      .filter((l) => l.length > 1)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    return { title };
  } catch {
    return { title: "" };
  }
}

function looksLikeFilename(s: string): boolean {
  return /\.(pdf|docx?|tex)$/i.test(s) || /^[\w\-]{1,20}$/.test(s);
}
