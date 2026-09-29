import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFDict,
  PDFNumber,
  PDFString,
  PDFHexString,
  type PDFObject,
  type PDFPage,
} from "pdf-lib";
import type { AnnotationStyle } from "../types";

/**
 * Import of annotations created in other PDF viewers (Adobe Acrobat, etc.)
 * into HYJI's database, so they become editable/deletable like native ones.
 *
 * Flow: scanExternalAnnotations() lists foreign markup + sticky notes with
 * coordinates converted to HYJI's stored-rect space (display points = pdf.js
 * viewport at scale 1: CropBox-based, /Rotate applied, top-left origin).
 * After the user confirms, the caller inserts them into the DB and
 * removeAnnotationsFromPdf() strips the originals from the file — HYJI takes
 * ownership; "Save annotations to PDF" writes them back as standard annots.
 *
 * 3.2: reads the file with pdf-lib (no pdf.js), so the scan works on the
 * PDFium-only viewer path and on the classic path alike.
 */
export interface ExternalAnnotation {
  /** Index into the page's /Annots array — identifies the entry to strip. */
  annotIndex: number;
  page: number;
  subtype: string;
  style: AnnotationStyle;
  type: "highlight" | "memo";
  color: string;
  contents: string;
  rects: { x: number; y: number; w: number; h: number; pageIndex: number }[];
}

const MARKUP_SUBTYPES = new Set(["Highlight", "Underline", "StrikeOut", "Squiggly"]);

function numbers(obj: PDFObject | undefined, doc: PDFDocument): number[] | null {
  const arr = obj ? doc.context.lookup(obj) : undefined;
  if (!(arr instanceof PDFArray)) return null;
  const out: number[] = [];
  for (const el of arr.asArray()) {
    const n = doc.context.lookup(el);
    if (!(n instanceof PDFNumber)) return null;
    out.push(n.asNumber());
  }
  return out;
}

function text(obj: PDFObject | undefined, doc: PDFDocument): string {
  const v = obj ? doc.context.lookup(obj) : undefined;
  if (v instanceof PDFString || v instanceof PDFHexString) {
    try { return v.decodeText().trim(); } catch { return ""; }
  }
  return "";
}

/** /C entries: [] transparent, [g] gray, [r g b], [c m y k] — all 0..1. */
function colorToHex(c: number[] | null): string {
  if (!c || c.length === 0) return "#ffd166";
  let rgb: [number, number, number];
  if (c.length === 1) rgb = [c[0], c[0], c[0]];
  else if (c.length === 4) {
    const k = c[3];
    rgb = [(1 - c[0]) * (1 - k), (1 - c[1]) * (1 - k), (1 - c[2]) * (1 - k)];
  } else rgb = [c[0], c[1], c[2]];
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, "0");
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}

/**
 * PDF user space → display points. The forward form of
 * pdfAnnotExport.viewportToUserSpace (same box / rotation conventions:
 * pdf.js PageViewport at scale 1, offsets 0, dontFlip false).
 */
function userToViewport(page: PDFPage): (x: number, y: number) => [number, number] {
  const mb = page.getMediaBox();
  const cb = page.getCropBox();
  const x0 = Math.max(cb.x, mb.x);
  const y0 = Math.max(cb.y, mb.y);
  const x1 = Math.min(cb.x + cb.width, mb.x + mb.width);
  const y1 = Math.min(cb.y + cb.height, mb.y + mb.height);
  const box = x1 > x0 && y1 > y0
    ? [x0, y0, x1, y1]
    : [mb.x, mb.y, mb.x + mb.width, mb.y + mb.height];

  let rotation = page.getRotation().angle % 360;
  if (rotation < 0) rotation += 360;
  rotation = Math.round(rotation / 90) * 90 % 360;

  let rA: number, rB: number, rC: number, rD: number;
  switch (rotation) {
    case 90:  rA = 0;  rB = 1; rC = 1;  rD = 0;  break;
    case 180: rA = -1; rB = 0; rC = 0;  rD = 1;  break;
    case 270: rA = 0;  rB = -1; rC = -1; rD = 0; break;
    default:  rA = 1;  rB = 0; rC = 0;  rD = -1; break;
  }
  const cx = (box[2] + box[0]) / 2;
  const cy = (box[3] + box[1]) / 2;
  let offX: number, offY: number;
  if (rA === 0) {
    offX = Math.abs(cy - box[1]);
    offY = Math.abs(cx - box[0]);
  } else {
    offX = Math.abs(cx - box[0]);
    offY = Math.abs(cy - box[1]);
  }
  const e = offX - rA * cx - rC * cy;
  const f = offY - rB * cx - rD * cy;
  return (x, y) => [rA * x + rC * y + e, rB * x + rD * y + f];
}

export async function scanExternalAnnotations(srcBytes: Uint8Array): Promise<ExternalAnnotation[]> {
  const doc = await PDFDocument.load(srcBytes, { updateMetadata: false, ignoreEncryption: true });
  const result: ExternalAnnotation[] = [];
  const pages = doc.getPages();

  for (let p = 1; p <= pages.length; p++) {
    const page = pages[p - 1];
    const annots = page.node.Annots();
    if (!annots) continue;
    const toVp = userToViewport(page);
    const toViewportRect = (ax: number, ay: number, bx: number, by: number) => {
      const c1 = toVp(ax, ay);
      const c2 = toVp(bx, by);
      return {
        x: Math.min(c1[0], c2[0]),
        y: Math.min(c1[1], c2[1]),
        w: Math.abs(c1[0] - c2[0]),
        h: Math.abs(c1[1] - c2[1]),
        pageIndex: p,
      };
    };

    for (let i = 0; i < annots.size(); i++) {
      const a = doc.context.lookup(annots.get(i));
      if (!(a instanceof PDFDict)) continue;
      const subtypeObj = a.get(PDFName.of("Subtype"));
      const subtype = subtypeObj instanceof PDFName ? subtypeObj.decodeText() : "";
      if (text(a.get(PDFName.of("T")), doc) === "HYJI") continue; // our own exported annotations
      const contents = text(a.get(PDFName.of("Contents")), doc);
      const color = colorToHex(numbers(a.get(PDFName.of("C")), doc));
      const quads = numbers(a.get(PDFName.of("QuadPoints")), doc);
      const rect = numbers(a.get(PDFName.of("Rect")), doc);

      if (MARKUP_SUBTYPES.has(subtype) && quads && quads.length >= 8) {
        const rects = [];
        for (let q = 0; q + 7 < quads.length; q += 8) {
          const xs = [quads[q], quads[q + 2], quads[q + 4], quads[q + 6]];
          const ys = [quads[q + 1], quads[q + 3], quads[q + 5], quads[q + 7]];
          rects.push(toViewportRect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)));
        }
        const style: AnnotationStyle =
          subtype === "Underline" || subtype === "Squiggly" ? "underline"
          : subtype === "StrikeOut" ? "strikeout"
          : "fill";
        result.push({
          annotIndex: i,
          page: p,
          subtype,
          style,
          // A markup annotation carrying a comment becomes a HYJI memo so
          // the note text stays visible and editable.
          type: contents ? "memo" : "highlight",
          color,
          contents,
          rects,
        });
      } else if (subtype === "Text" && rect && rect.length === 4) {
        // Sticky note → memo anchored at the note icon's position
        result.push({
          annotIndex: i,
          page: p,
          subtype,
          style: "fill",
          type: "memo",
          color,
          contents,
          rects: [toViewportRect(rect[0], rect[1], rect[2], rect[3])],
        });
      }
    }
  }

  return result;
}

/**
 * Returns a copy of the PDF with the given (imported) annotations removed.
 * Entries are matched by their index in the page's /Annots array as seen by
 * scanExternalAnnotations() on the same bytes, so direct (non-ref)
 * annotation dictionaries are stripped too.
 */
export async function removeAnnotationsFromPdf(
  srcBytes: Uint8Array,
  toRemove: ExternalAnnotation[]
): Promise<Uint8Array> {
  const byPage = new Map<number, number[]>();
  for (const a of toRemove) {
    if (!byPage.has(a.page)) byPage.set(a.page, []);
    byPage.get(a.page)!.push(a.annotIndex);
  }

  const pdfDoc = await PDFDocument.load(srcBytes, { updateMetadata: false, ignoreEncryption: true });
  const pages = pdfDoc.getPages();

  for (const [pageNum, indices] of byPage) {
    const page = pages[pageNum - 1];
    if (!page) continue;
    const annots = page.node.Annots();
    if (!annots) continue;
    for (const i of [...new Set(indices)].sort((x, y) => y - x)) {
      if (i >= 0 && i < annots.size()) annots.remove(i);
    }
  }

  return pdfDoc.save();
}
