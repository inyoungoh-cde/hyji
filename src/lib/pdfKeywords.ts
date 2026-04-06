import * as pdfjsLib from "pdfjs-dist";
import { readFile } from "@tauri-apps/plugin-fs";
import { parseKeywordString } from "./keywordExtract";

try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.mjs",
    import.meta.url
  ).toString();
} catch { /* ignore */ }

export async function extractKeywordsFromPdf(pdfPath: string): Promise<string[]> {
  if (!pdfPath) return [];
  try {
    const bytes = await readFile(pdfPath);
    const doc = await pdfjsLib.getDocument({ data: bytes, cMapPacked: false }).promise;

    // 1. PDF metadata Keywords field
    const meta = await doc.getMetadata();
    const metaKw = (meta.info as Record<string, string>)?.Keywords ?? "";
    if (metaKw.trim()) {
      const parsed = parseKeywordString(metaKw);
      if (parsed.length > 0) return parsed;
    }

    // 2. First-page text — look for "Keywords:" section
    const page = await doc.getPage(1);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ");

    // Capture up to 350 chars after "Keywords:", stop at known section headers
    const kwMatch = text.match(
      /[Kk]ey\s*[Ww]ords?\s*[:\-—]\s*(.{5,350}?)(?=\s*(?:Nomenclature|Introduction|Abstract|CCS|ACM|Index Terms?|©|\d\s*\.|Received|Accepted|Corresponding)|\.\s+[A-Z]|$)/
    );
    if (kwMatch) {
      const parsed = parseKeywordString(kwMatch[1]);
      if (parsed.length > 0) return parsed;
    }

    return [];
  } catch {
    return [];
  }
}
