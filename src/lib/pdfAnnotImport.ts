import { PDFDocument, PDFName, PDFArray, PDFRef } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { AnnotationStyle } from "../types";

/**
 * Import of annotations created in other PDF viewers (Adobe Acrobat, etc.)
 * into HYJI's database, so they become editable/deletable like native ones.
 *
 * Flow: scanExternalAnnotations() lists foreign markup + sticky notes with
 * coordinates converted to HYJI's stored-rect space (pdf.js viewport at
 * scale 1). After the user confirms, the caller inserts them into the DB and
 * removeAnnotationsFromPdf() strips the originals from the file — HYJI takes
 * ownership; "Save annotations to PDF" writes them back as standard annots.
 */
export interface ExternalAnnotation {
  /** pdf.js annotation id, e.g. "123R" — identifies the object to strip. */
  pdfjsId: string;
  page: number;
  subtype: string;
  style: AnnotationStyle;
  type: "highlight" | "memo";
  color: string;
  contents: string;
  rects: { x: number; y: number; w: number; h: number; pageIndex: number }[];
}

const MARKUP_SUBTYPES = new Set(["Highlight", "Underline", "StrikeOut", "Squiggly"]);

function colorToHex(c: ArrayLike<number> | null | undefined): string {
  if (!c || c.length < 3) return "#ffd166";
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

export async function scanExternalAnnotations(
  doc: PDFDocumentProxy
): Promise<ExternalAnnotation[]> {
  const result: ExternalAnnotation[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const anns = await page.getAnnotations();

    const toViewportRect = (x1: number, y1: number, x2: number, y2: number) => {
      const c1 = vp.convertToViewportPoint(x1, y1);
      const c2 = vp.convertToViewportPoint(x2, y2);
      return {
        x: Math.min(c1[0], c2[0]),
        y: Math.min(c1[1], c2[1]),
        w: Math.abs(c1[0] - c2[0]),
        h: Math.abs(c1[1] - c2[1]),
        pageIndex: p,
      };
    };

    for (const a of anns) {
      const subtype = String(a.subtype ?? "");
      const author = String(a.titleObj?.str ?? "").trim();
      if (author === "HYJI") continue; // our own exported annotations
      const contents = String(a.contentsObj?.str ?? "").trim();

      if (MARKUP_SUBTYPES.has(subtype) && a.quadPoints && a.quadPoints.length >= 8) {
        const q: number[] = Array.from(a.quadPoints as ArrayLike<number>);
        const rects = [];
        for (let i = 0; i + 7 < q.length; i += 8) {
          const xs = [q[i], q[i + 2], q[i + 4], q[i + 6]];
          const ys = [q[i + 1], q[i + 3], q[i + 5], q[i + 7]];
          rects.push(toViewportRect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)));
        }
        const style: AnnotationStyle =
          subtype === "Underline" || subtype === "Squiggly" ? "underline"
          : subtype === "StrikeOut" ? "strikeout"
          : "fill";
        result.push({
          pdfjsId: String(a.id ?? ""),
          page: p,
          subtype,
          style,
          // A markup annotation carrying a comment becomes a HYJI memo so
          // the note text stays visible and editable.
          type: contents ? "memo" : "highlight",
          color: colorToHex(a.color),
          contents,
          rects,
        });
      } else if (subtype === "Text" && Array.isArray(a.rect) && a.rect.length === 4) {
        // Sticky note → memo anchored at the note icon's position
        result.push({
          pdfjsId: String(a.id ?? ""),
          page: p,
          subtype,
          style: "fill",
          type: "memo",
          color: colorToHex(a.color),
          contents,
          rects: [toViewportRect(a.rect[0], a.rect[1], a.rect[2], a.rect[3])],
        });
      }
    }
  }

  return result;
}

/**
 * Returns a copy of the PDF with the given (imported) annotations removed.
 * Annotations are matched by object reference; the rare direct (non-ref)
 * annotation entries are left untouched.
 */
export async function removeAnnotationsFromPdf(
  srcBytes: Uint8Array,
  toRemove: ExternalAnnotation[]
): Promise<Uint8Array> {
  const refsByPage = new Map<number, Set<string>>();
  for (const a of toRemove) {
    const m = /^(\d+)R(\d*)$/.exec(a.pdfjsId);
    if (!m) continue;
    const key = `${m[1]}:${m[2] || "0"}`; // objectNumber:generation
    if (!refsByPage.has(a.page)) refsByPage.set(a.page, new Set());
    refsByPage.get(a.page)!.add(key);
  }

  const pdfDoc = await PDFDocument.load(srcBytes, { updateMetadata: false });
  const pages = pdfDoc.getPages();

  for (const [pageNum, keys] of refsByPage) {
    const page = pages[pageNum - 1];
    if (!page) continue;
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const el = annots.get(i);
      if (el instanceof PDFRef && keys.has(`${el.objectNumber}:${el.generationNumber}`)) {
        annots.remove(i);
      }
    }
  }

  return pdfDoc.save();
}
