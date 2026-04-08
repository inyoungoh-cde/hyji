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

    // 1b. XMP metadata — search raw bytes BEFORE passing to pdfjs.
    //     pdfjs transfers (detaches) the ArrayBuffer when loading, so we must
    //     search the bytes first. Some publishers (Oxford Academic, Springer)
    //     store keywords only in XMP, leaving the PDF info-dict /Keywords empty.
    try {
      // Keep a copy of the buffer for pdfjs (slice transfers ownership safely)
      const rawText = new TextDecoder("latin1", { fatal: false }).decode(bytes);
      const xmpMatch = rawText.match(/<pdf:Keywords[^>]*>([^<]{3,1000})<\/pdf:Keywords>/i);
      if (xmpMatch?.[1]?.trim()) {
        const parsed = parseKeywordString(xmpMatch[1].trim());
        if (parsed.length > 0) return parsed;
      }
    } catch { /* ignore */ }

    // Pass a copy to pdfjs so the original bytes stay intact if needed later
    const doc = await pdfjsLib.getDocument({ data: bytes.slice(), cMapPacked: false }).promise;

    // 1a. PDF info-dict Keywords field (most common format)
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
