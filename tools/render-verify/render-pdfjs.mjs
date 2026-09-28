// Render pages of a PDF with pdfjs-dist (legacy build) in Node to PNG files.
// Reference side ("A") of the PDFium integrity harness. Dev tooling only —
// not part of the app build.
//
//   node tools/render-verify/render-pdfjs.mjs --pdf <file> --pages 0,1,5 --width 1070 --out <dir>
//   --pages all           render every page
//   --annotations off     skip annotation appearance streams (default: on, like the viewer)
//
// Output: <dir>/page-0000.png (0-based page index, zero-padded to 4 digits).
// Prints one line per page with render time in ms; exit code 1 on any failure.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const require = createRequire(path.join(repoRoot, "package.json"));

function parseArgs(argv) {
  const out = { pages: "0", width: "1070", annotations: "on" };
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
  console.error("usage: render-pdfjs.mjs --pdf <file> --pages 0,1,5|all --width 1070 --out <dir> [--annotations on|off]");
  process.exit(2);
}

const pdfjsPath = path.join(repoRoot, "node_modules/pdfjs-dist/legacy/build/pdf.mjs");
const pdfjs = await import(pathToFileURL(pdfjsPath).href);

// Bundled assets: prefer public/pdfjs (what the app ships, synced by
// vite.config.ts), fall back to the package copies. Trailing slash + forward
// slashes are required by pdf.js's URL joining even on Windows.
function assetDir(name) {
  const pub = path.join(repoRoot, "public", "pdfjs", name);
  const pkg = path.join(repoRoot, "node_modules", "pdfjs-dist", name);
  const dir = existsSync(pub) ? pub : pkg;
  return dir.split(path.sep).join("/") + "/";
}
const assetOptions = {
  cMapUrl: assetDir("cmaps"),
  cMapPacked: true,
  standardFontDataUrl: assetDir("standard_fonts"),
  wasmUrl: assetDir("wasm"),
};

// Canvas: pdfjs-dist 5.x uses @napi-rs/canvas in Node (optional dependency).
let napiCanvas = null;
try {
  napiCanvas = require("@napi-rs/canvas");
} catch {
  /* fall back to doc.canvasFactory below */
}

const width = Math.max(1, Math.round(Number(args.width)));
const outDir = path.resolve(args.out);
mkdirSync(outDir, { recursive: true });

const data = new Uint8Array(readFileSync(args.pdf));
const t0 = performance.now();
const doc = await pdfjs.getDocument({
  data,
  ...assetOptions,
  useWorkerFetch: false,
  isEvalSupported: false,
  useSystemFonts: false, // deterministic: never depend on the host's font set
}).promise;
const loadMs = performance.now() - t0;
console.log(`load ${path.basename(args.pdf)}: ${doc.numPages} pages, ${loadMs.toFixed(0)} ms`);

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

const annotationMode =
  args.annotations === "off" ? pdfjs.AnnotationMode.DISABLE : pdfjs.AnnotationMode.ENABLE;

function makeCanvas(w, h) {
  if (napiCanvas) {
    const canvas = napiCanvas.createCanvas(w, h);
    return { canvas, context: canvas.getContext("2d") };
  }
  const f = doc.canvasFactory;
  const { canvas, context } = f.create(w, h);
  return { canvas, context };
}

let failed = 0;
const results = [];
for (const idx of pageIdx) {
  const t = performance.now();
  try {
    const page = await doc.getPage(idx + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    const viewport = page.getViewport({ scale });
    const w = Math.round(viewport.width);
    const h = Math.round(viewport.height);
    const { canvas, context } = makeCanvas(w, h);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, w, h);
    await page.render({ canvasContext: context, canvas, viewport, annotationMode }).promise;
    const png = canvas.toBuffer ? canvas.toBuffer("image/png") : Buffer.from(await canvas.encode("png"));
    const file = path.join(outDir, `page-${String(idx).padStart(4, "0")}.png`);
    writeFileSync(file, png);
    page.cleanup();
    const ms = performance.now() - t;
    results.push({ page: idx, width: w, height: h, rotate: page.rotate, ms: Math.round(ms) });
    console.log(`page ${idx}: ${w}x${h} rotate=${page.rotate} ${ms.toFixed(0)} ms -> ${path.basename(file)}`);
  } catch (e) {
    failed++;
    results.push({ page: idx, error: String(e?.message ?? e) });
    console.error(`page ${idx}: FAILED ${e?.message ?? e}`);
  }
}

writeFileSync(
  path.join(outDir, "render-pdfjs.json"),
  JSON.stringify({ pdf: path.resolve(args.pdf), numPages: doc.numPages, width, loadMs: Math.round(loadMs), pages: results }, null, 2)
);
await doc.destroy();
process.exit(failed ? 1 : 0);
