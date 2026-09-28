import { openPdfDocument } from "./pdfSource";
import { getBgPdfWorker } from "./pdfBgWorker";
import { parseKeywordString } from "./keywordExtract";

// Common multi-syllable suffixes that, when found mid-keyword, betray a concatenation.
// e.g. "turefinetuning" ends with "finetuning" with "ture" before it → garbled.
const CONCAT_SUFFIXES = [
  "understanding", "estimation", "recognition", "finetuning", "fine-tuning",
  "detection", "segmentation", "reconstruction", "representation", "generation",
  "localization", "completion", "prediction", "classification", "registration",
];

// Returns true when a keyword batch looks like garbled PDF text extraction:
//   – a token is > 18 chars with no spaces (almost certainly two words merged), or
//   – a token has no spaces but ends with a known multi-syllable word that has
//     additional chars in front (e.g. "ture" + "finetuning").
function looksGarbled(keywords: string[]): boolean {
  for (const kw of keywords) {
    if (kw.includes(" ")) continue; // multi-word phrases are fine
    const lower = kw.toLowerCase();
    if (lower.length > 18) return true;
    for (const suffix of CONCAT_SUFFIXES) {
      if (lower.endsWith(suffix) && lower.length > suffix.length) return true;
    }
  }
  return false;
}

export async function extractKeywordsFromPdf(pdfPath: string): Promise<string[]> {
  if (!pdfPath) return [];
  try {
    // 1b. XMP metadata in the raw bytes. Some publishers (Oxford Academic,
    //     Springer) store keywords only in XMP, leaving the info-dict
    //     /Keywords empty — and occasionally the XMP packet is not reachable
    //     from the catalog, so pdf.js's parsed metadata misses it. Only
    //     whole-file loads expose the bytes; for large (ranged) files the
    //     parsed metadata below is the source — decoding a 260 MB volume into
    //     a JS string on the main thread was a multi-second freeze.
    let xmpKeywords: string[] = [];
    const doc = await openPdfDocument(pdfPath, {
      worker: getBgPdfWorker(),
      inspectBytes: (bytes) => {
        try {
          const rawText = new TextDecoder("latin1", { fatal: false }).decode(bytes);
          const xmpMatch = rawText.match(/<pdf:Keywords[^>]*>([^<]{3,1000})<\/pdf:Keywords>/i);
          if (xmpMatch?.[1]?.trim()) xmpKeywords = parseKeywordString(xmpMatch[1].trim());
        } catch { /* ignore */ }
      },
    });
    try {
      if (xmpKeywords.length > 0) return xmpKeywords;

      // 1a. PDF info-dict Keywords field (most common format), then the
      //     XMP packet pdf.js already parsed from the catalog.
      const meta = await doc.getMetadata();
      const metaKw = (meta.info as Record<string, string>)?.Keywords ?? "";
      if (metaKw.trim()) {
        const parsed = parseKeywordString(metaKw);
        if (parsed.length > 0) return parsed;
      }
      const xmp = meta.metadata?.get("pdf:keywords") ?? meta.metadata?.get("pdf:Keywords");
      const xmpStr = Array.isArray(xmp) ? xmp.join(", ") : typeof xmp === "string" ? xmp : "";
      if (xmpStr.trim()) {
        const parsed = parseKeywordString(xmpStr);
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
        // Sanity check: reject batches that look like garbled concatenations.
        // pdfjs sometimes drops word-spacing for certain PDFs, producing tokens like
        // "spondenceunderstanding" or "turefinetuning" — clearly word fragments.
        if (parsed.length > 0 && !looksGarbled(parsed)) return parsed;
      }

      return [];
    } finally {
      await doc.destroy().catch(() => undefined);
    }
  } catch {
    return [];
  }
}
