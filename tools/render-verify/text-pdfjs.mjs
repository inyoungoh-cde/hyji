#!/usr/bin/env node
// Dump pdf.js text geometry per page -> <out>/text-NNNN.json
//
//   node tools/render-verify/text-pdfjs.mjs --pdf <file> --pages 0,1,5|all --out <dir>
//
// One record per pdf.js text item ("run") from page.getTextContent(), in the
// same frame the viewer's TextLayer uses at viewport scale 1: display points,
// top-left origin, CropBox and /Rotate applied. The run box is built exactly
// like pdf.js's TextLayer#appendText builds the <span>:
//   tx      = Util.transform(viewport.transform, item.transform)
//   angle   = atan2(tx[1], tx[0])            (+90deg for vertical fonts)
//   fh      = hypot(tx[2], tx[3])            (font size in display px = span height)
//   ascent  = style.ascent | 1+style.descent | 0.8   (the TextLayer's fallback
//             chain; in the browser it measures fontBoundingBoxAscent of the
//             loaded @font-face instead, so vertical extents here can differ
//             from the live viewer by a fraction of the font size)
//   left    = tx[4] (+ ascent*fh*sin a),  top = tx[5] - ascent*fh (*cos a)
//   width   = item.width (the span is scaled to exactly this advance), height = fh
// The span is rotated by `angle` about its top-left corner; `poly` holds the
// four display-space corners in that order, `x,y,w,h` the axis-aligned box.
//
// pdf.js gives NO per-character boxes. `chars` are an ESTIMATE: the run's
// advance is divided EQUALLY among its characters along the baseline (a
// proportional font makes "iii" and "WWW" the same width here). They are only
// used for coverage matching with a tolerance; offsets are measured per run.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function parseArgs(argv) {
  const out = { pages: "0" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.pdf || !args.out) {
  console.error("usage: text-pdfjs.mjs --pdf <file> --pages 0,1,5|all --out <dir>");
  process.exit(2);
}

const pdfjsPath = path.join(repoRoot, "node_modules/pdfjs-dist/legacy/build/pdf.mjs");
const pdfjs = await import(pathToFileURL(pdfjsPath).href);

function assetDir(name) {
  const pub = path.join(repoRoot, "public", "pdfjs", name);
  const pkg = path.join(repoRoot, "node_modules", "pdfjs-dist", name);
  const dir = existsSync(pub) ? pub : pkg;
  return dir.split(path.sep).join("/") + "/";
}

const outDir = path.resolve(args.out);
mkdirSync(outDir, { recursive: true });

const data = new Uint8Array(readFileSync(args.pdf));
const doc = await pdfjs.getDocument({
  data,
  cMapUrl: assetDir("cmaps"),
  cMapPacked: true,
  standardFontDataUrl: assetDir("standard_fonts"),
  wasmUrl: assetDir("wasm"),
  useWorkerFetch: false,
  isEvalSupported: false,
  useSystemFonts: false,
}).promise;

let pageIdx;
if (args.pages === "all") {
  pageIdx = Array.from({ length: doc.numPages }, (_, i) => i);
} else {
  pageIdx = args.pages
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n < doc.numPages);
}

function ascentRatio(style) {
  // TextLayer.#getAscent without a DOM: the fallback chain it uses when the
  // canvas cannot report fontBoundingBoxAscent.
  if (style?.ascent) return style.ascent;
  if (style?.descent) return 1 + style.descent;
  return 0.8;
}

let failed = 0;
const summary = [];
for (const idx of pageIdx) {
  try {
    const page = await doc.getPage(idx + 1);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent({ includeMarkedContent: false });
    const runs = [];
    for (const item of content.items) {
      if (!("str" in item)) continue; // marked-content markers
      if (item.str === "") continue;
      const style = content.styles[item.fontName];
      const tx = pdfjs.Util.transform(viewport.transform, item.transform);
      let angle = Math.atan2(tx[1], tx[0]);
      const vertical = !!style?.vertical;
      if (vertical) angle += Math.PI / 2;
      const fh = Math.hypot(tx[2], tx[3]);
      const asc = ascentRatio(style);
      const fontAscent = fh * asc;
      let left, top;
      if (angle === 0) {
        left = tx[4];
        top = tx[5] - fontAscent;
      } else {
        left = tx[4] + fontAscent * Math.sin(angle);
        top = tx[5] - fontAscent * Math.cos(angle);
      }
      const width = vertical ? item.height : item.width;
      const height = fh;
      // span corners: rotate (width x height) about (left, top) by angle
      const c = Math.cos(angle), s = Math.sin(angle);
      const corner = (dx, dy) => [left + dx * c - dy * s, top + dx * s + dy * c];
      const poly = [corner(0, 0), corner(width, 0), corner(width, height), corner(0, height)];
      const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
      const x = Math.min(...xs), y = Math.min(...ys);
      // per-char estimate: equal split of the advance along the baseline
      const chars = Array.from(item.str);
      const n = chars.length;
      const cw = n ? width / n : 0;
      const estChars = chars.map((ch, i) => {
        const p0 = corner(i * cw, 0), p1 = corner((i + 1) * cw, 0), p2 = corner((i + 1) * cw, height), p3 = corner(i * cw, height);
        const cx = [p0, p1, p2, p3].map((p) => p[0]), cy = [p0, p1, p2, p3].map((p) => p[1]);
        return {
          c: ch,
          x: +Math.min(...cx).toFixed(3),
          y: +Math.min(...cy).toFixed(3),
          w: +(Math.max(...cx) - Math.min(...cx)).toFixed(3),
          h: +(Math.max(...cy) - Math.min(...cy)).toFixed(3),
          // center along the baseline (the point coverage matching uses)
          cx: +((p0[0] + p2[0]) / 2).toFixed(3),
          cy: +((p0[1] + p2[1]) / 2).toFixed(3),
        };
      });
      runs.push({
        str: item.str,
        x: +x.toFixed(3),
        y: +y.toFixed(3),
        w: +(Math.max(...xs) - x).toFixed(3),
        h: +(Math.max(...ys) - y).toFixed(3),
        // baseline start + span frame (what the CSS span really is)
        bx: +tx[4].toFixed(3),
        by: +tx[5].toFixed(3),
        angle: +((angle * 180) / Math.PI).toFixed(3),
        adv: +width.toFixed(3),
        fh: +fh.toFixed(3),
        ascent: +asc.toFixed(4),
        vertical,
        font: item.fontName,
        fontFamily: style?.fontFamily ?? "",
        poly: poly.map((p) => [+p[0].toFixed(3), +p[1].toFixed(3)]),
        chars: estChars,
      });
    }
    const rec = {
      page: idx,
      width: +viewport.width.toFixed(3),
      height: +viewport.height.toFixed(3),
      rotate: page.rotate,
      // /UserUnit: PageViewport scales the transform by it (positions, font
      // height) but TextLayer sizes spans with viewport.scale, which excludes
      // it -- so item.width above is NOT multiplied. Recorded for the report.
      userUnit: page.userUnit ?? 1,
      charEstimate: "equal split of item.width over item.str characters",
      runs,
    };
    const file = path.join(outDir, `text-${String(idx).padStart(4, "0")}.json`);
    writeFileSync(file, JSON.stringify(rec));
    const nChars = runs.reduce((a, r) => a + r.chars.length, 0);
    summary.push({ page: idx, runs: runs.length, chars: nChars });
    console.log(`page ${idx}: ${runs.length} runs, ${nChars} chars, ${rec.width}x${rec.height} pt rotate=${page.rotate} -> ${path.basename(file)}`);
    page.cleanup();
  } catch (e) {
    failed++;
    summary.push({ page: idx, error: String(e?.message ?? e) });
    console.error(`page ${idx}: FAILED ${e?.message ?? e}`);
  }
}
writeFileSync(path.join(outDir, "text-pdfjs.json"), JSON.stringify({ pdf: path.resolve(args.pdf), numPages: doc.numPages, pages: summary }, null, 2));
await doc.destroy();
process.exit(failed ? 1 : 0);
