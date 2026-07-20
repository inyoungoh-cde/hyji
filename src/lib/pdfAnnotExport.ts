import { PDFDocument, PDFName, PDFArray, PDFHexString, type PDFPage } from "pdf-lib";
import type { Annotation } from "../types";

interface StoredRect {
  x: number;
  y: number;
  w: number;
  h: number;
  pageIndex?: number;
}

// Written as the annotation author (/T). Also lets HYJI recognize its own
// annotations if the exported file is opened again.
const AUTHOR = "HYJI";

function hexToRgb01(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

function pdfDateNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Stored rects live in pdf.js viewport space at scale 1 — CropBox-based and
 * with the page /Rotate already applied. Build the inverse of pdf.js's
 * PageViewport transform so exported annotations land correctly on rotated
 * and cropped pages, not just origin-(0,0) unrotated ones.
 */
function viewportToUserSpace(page: PDFPage): (vx: number, vy: number) => [number, number] {
  const mb = page.getMediaBox();
  const cb = page.getCropBox();
  // pdf.js uses `page.view` = CropBox intersected with MediaBox
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

  // Mirror of pdf.js PageViewport (scale=1, offsets=0, dontFlip=false)
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
  const det = rA * rD - rB * rC;

  return (vx, vy) => {
    const dx = vx - e;
    const dy = vy - f;
    return [(rD * dx - rC * dy) / det, (-rB * dx + rA * dy) / det];
  };
}

/**
 * Writes HYJI highlights/memos into a PDF as standard /Highlight text-markup
 * annotations (QuadPoints + appearance stream with Multiply blend), so Adobe
 * Acrobat, SumatraPDF, browsers, etc. display and list them as real
 * annotations. Memo text is stored in /Contents and appears as the
 * annotation's comment/popup in other viewers.
 */
export async function exportAnnotationsToPdf(
  srcBytes: Uint8Array,
  annotations: Annotation[]
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(srcBytes, { updateMetadata: false });
  const pages = pdfDoc.getPages();
  const context = pdfDoc.context;
  const now = pdfDateNow();

  for (const ann of annotations) {
    if (ann.type !== "highlight" && ann.type !== "memo") continue;
    let rects: StoredRect[] = [];
    try { rects = JSON.parse(ann.rects_json || "[]"); } catch { continue; }
    if (rects.length === 0) continue;

    // Group rects by page (cross-page selections become one annot per page)
    const byPage = new Map<number, StoredRect[]>();
    for (const r of rects) {
      const pageNum = r.pageIndex ?? ann.page;
      if (!byPage.has(pageNum)) byPage.set(pageNum, []);
      byPage.get(pageNum)!.push(r);
    }

    const [cr, cg, cb] = hexToRgb01(ann.color.slice(0, 7));

    for (const [pageNum, pageRects] of byPage) {
      const page = pages[pageNum - 1];
      if (!page) continue;
      const toUser = viewportToUserSpace(page);

      const quads: number[] = [];
      const ops: string[] = ["/G0 gs", `${cr.toFixed(4)} ${cg.toFixed(4)} ${cb.toFixed(4)} rg`];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

      for (const r of pageRects) {
        // Map both viewport corners; rotation is axis-aligned, so the mapped
        // corners still span an axis-aligned rect in PDF user space.
        const [ax, ay] = toUser(r.x, r.y);
        const [bx, by] = toUser(r.x + r.w, r.y + r.h);
        const x1 = Math.min(ax, bx);
        const x2 = Math.max(ax, bx);
        const yBot = Math.min(ay, by);
        const yTop = Math.max(ay, by);
        // QuadPoints order: upper-left, upper-right, lower-left, lower-right
        quads.push(x1, yTop, x2, yTop, x1, yBot, x2, yBot);
        ops.push(`${x1.toFixed(2)} ${yBot.toFixed(2)} ${(x2 - x1).toFixed(2)} ${(yTop - yBot).toFixed(2)} re`);
        minX = Math.min(minX, x1); maxX = Math.max(maxX, x2);
        minY = Math.min(minY, yBot); maxY = Math.max(maxY, yTop);
      }
      ops.push("f");
      const rect = [minX, minY, maxX, maxY];

      // Appearance stream: fill the quads with Multiply blend so the text
      // underneath stays readable (marker-pen look) in viewers that honor /AP.
      const gs = context.obj({ Type: "ExtGState", BM: "Multiply", CA: 1, ca: 1 });
      const apStream = context.stream(ops.join("\n"), {
        Type: "XObject",
        Subtype: "Form",
        FormType: 1,
        BBox: rect,
        Resources: { ExtGState: { G0: gs } },
      });
      const apRef = context.register(apStream);

      const contents = ann.type === "memo" ? (ann.memo_text || "") : "";
      const annotDict = context.obj({
        Type: "Annot",
        Subtype: "Highlight",
        Rect: rect,
        QuadPoints: quads,
        C: [cr, cg, cb],
        CA: 1,
        F: 4,
        Border: [0, 0, 0],
        AP: { N: apRef },
      });
      annotDict.set(PDFName.of("T"), PDFHexString.fromText(AUTHOR));
      annotDict.set(PDFName.of("M"), PDFHexString.fromText(now));
      annotDict.set(PDFName.of("CreationDate"), PDFHexString.fromText(now));
      if (contents) {
        annotDict.set(PDFName.of("Contents"), PDFHexString.fromText(contents));
      }
      const annotRef = context.register(annotDict);

      let annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
      if (!annots) {
        annots = context.obj([]) as PDFArray;
        page.node.set(PDFName.of("Annots"), annots);
      }
      annots.push(annotRef);
    }
  }

  return pdfDoc.save();
}
