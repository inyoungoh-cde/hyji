# render-verify — offline integrity harness for the PDFium backend (3.0)

Dev tooling only. Nothing here is part of the app build; `src/` and
`src-tauri/` are untouched. Purpose: prove that the PDFium rasterizer shows
**everything** the pdf.js rasterizer showed on the user's real library —
fonts (incl. CJK/CID), figures, rotated / cropped pages, existing annotation
appearances — before pdf.js rendering is swapped out.

## Requirements

- Node with the repo's `node_modules` installed. `pdfjs-dist` 5.x brings
  `@napi-rs/canvas` as its Node canvas, so no extra install is needed.
- Python 3 with `numpy` and `Pillow`. `scikit-image` (SSIM) and `pypdf`
  (corpus page features) are used when present; both have built-in fallbacks.
- The bundled pdf.js assets in `public/pdfjs/` (`cmaps/`, `standard_fonts/`,
  `wasm/`), created by `vite.config.ts` on any dev/build run. The renderer
  falls back to the `node_modules/pdfjs-dist/` copies if that folder is missing.

## Workflow

```
tools/render-verify/
  corpus.py         pick ~12 diverse PDFs from the live HYJI library -> corpus.json
  fixtures.py       synthesize rotate / CropBox / UserUnit / annots / scan / mixed-size PDFs -> fixtures/
  render-pdfjs.mjs  side A: pdf.js (legacy build, Node) -> page-NNNN.png
  <pdfium cli>      side B: same pages, same width, same file names
  compare.py        A vs B: size, SSIM, MAD, ink coverage; diffs/ for FAILs
  run-all.py        loops the corpus, runs A, B and compare per paper
```

1. **Corpus** (copies the DB before reading so the running app's WAL/lock
   is not disturbed):

   ```
   python tools/render-verify/corpus.py
   ```

   Picks smallest, largest, CJK/CID-font, /Rotate, CropBox != MediaBox,
   existing markup /Annots, scanned-like (image XObject + little text),
   plus random fillers up to `--n 12`, and always the G2P paper. Writes
   `corpus.json` with page count, detected features and the reason(s) each
   file was chosen.

   The real library has no rotated, cropped, annotated or scanned PDFs, so
   generate those from the G2P paper (appended to `corpus.json` as
   `fixture:*` entries; re-runnable, replaces earlier fixture entries):

   ```
   python tools/render-verify/fixtures.py
   ```

   | fixture | what it exercises |
   |---|---|
   | g2p-rotate90 / g2p-rotate270 | `/Rotate` on every page (output must be landscape) |
   | g2p-cropbox | CropBox inset 40 pt, MediaBox unchanged |
   | g2p-cropbox-offset | CropBox `[50 60 500 700]` with non-zero origin |
   | g2p-userunit | `/UserUnit 2` on page 1 (pdf.js ignores it at a fixed pixel width; check PDFium agrees) |
   | g2p-annots | Highlight / Underline / StrikeOut / Text with `/AP` streams built like `src/lib/pdfAnnotExport.ts` (QuadPoints, Multiply ExtGState) |
   | g2p-scan | image-only page (page 1 rasterised at 150 dpi) |
   | g2p-mixed-size | A4, Letter, Letter-landscape pages in one file |

2. **Render side A (pdf.js)**:

   ```
   node tools/render-verify/render-pdfjs.mjs --pdf <file> --pages 0,1,5 --width 1070 --out outA
   node tools/render-verify/render-pdfjs.mjs --pdf <file> --pages all --width 1070 --out outA
   ```

   `--width` is the output pixel width (1070 = the viewer's fit-width at
   the default layout); height follows the page aspect after /Rotate.
   Annotation appearance streams are drawn (`AnnotationMode.ENABLE`, same
   as the viewer); `--annotations off` disables them. `useSystemFonts` is
   off so output does not depend on the host's fonts. Per-page render time
   is printed and recorded in `<out>/render-pdfjs.json`.

3. **Render side B (PDFium)**. `pdfium-cli.py` adapts the one-page-per-call
   pdfium spike (`--exe` or `PDFIUM_SPIKE` to override its path; `--annot`
   always on) to the contract `run-all.py` assumes:

   ```
   <pdfium-cli> --pdf <file> --pages 0,1,5 --width 1070 --out outB
   ```

   producing `outB/page-NNNN.png` (0-based index, 4 digits, RGB or gray,
   white background) — identical names to side A. A different flag layout
   can be adapted with `--pdfium-args "<template with {pdf} {pages} {width} {out}>"`
   (each placeholder must be its own whitespace-separated token).

4. **Compare**:

   ```
   python tools/render-verify/compare.py --a outA --b outB --out results [--label name]
   ```

   Per page: size match, grayscale SSIM, mean absolute difference, and the
   **ink-coverage** check: ink = gray < 200; both masks are dilated by 2 px;
   the share of A's ink lying outside B's dilated ink ("missing in B") and
   vice-versa ("extra in B") is reported. Dilation absorbs antialiasing /
   hinting / stroke-weight differences, so this isolates *missing content*
   (a font that failed to load, a dropped figure, an annotation appearance
   that was not drawn). A page **FAILs** when either uncovered share
   > 0.5 % or SSIM < 0.85 (or sizes differ / file missing). Since one
   dropped text line is only ~0.2 % of a page's ink, a local criterion is
   applied too: the largest connected blob of uncovered ink > 300 px
   (`--max-blob`, roughly one word at 1070 px) also FAILs the page.
   Every FAIL gets `results/diffs/<page>.png` = A | B | heatmap (gray =
   |A−B|, **red** = ink only in A i.e. missing in PDFium, **blue** = ink
   only in B). Output: `compare[-label].md` (table) and `.json`.
   An uncovered pixel only counts when |A−B| > `--min-delta` (48) gray
   levels; without this, mid-gray mesh/depth-map figures straddling the ink
   threshold register as "extra" ink under PDFium's slightly darker image
   resampling (observed on 5 pages in the first full run, all false alarms).
   Thresholds: `--max-uncovered 0.005 --min-ssim 0.85 --max-blob 300 --min-delta 48 --ink 200 --dilate 2`.

5. **Everything at once**:

   ```
   python tools/render-verify/run-all.py                      # A only, compare skipped
   python tools/render-verify/run-all.py --pdfium-cli path\to\pdfium-render.exe
   python tools/render-verify/run-all.py --only G2P --pages 0,1
   python tools/render-verify/run-all.py --only fixtures                # synthetic fixtures only
   ```

   Page sample per paper: first 3 + 2 evenly spaced interior + last page.
   Results land in `tools/render-verify/out/<paperId_title>/{pdfjs,pdfium,diffs}`
   with `report.md` / `report.json` at the top. Exit code 1 if any page FAILs.

## Interpreting results

- `A ink missing in B` is the number that matters for the swap: anything
  above 0.5 % means PDFium did not draw something pdf.js drew — look at the
  red regions in `diffs/`.
- `B ink extra` > 0.5 % usually means PDFium drew something pdf.js skipped
  (e.g. an annotation without an appearance stream, hidden form fields);
  decide per case whether that is a regression or a fix.
- SSIM is a sanity metric; stem darkening / hinting differences alone
  typically keep it above 0.9 at 1070 px. A low SSIM with ~0 % uncovered
  ink points at global tone (gamma, gray text) rather than missing content.
- Size mismatch means the two sides disagree on page geometry (Rotate /
  CropBox handling) — metrics are then computed on the common crop and the
  page FAILs regardless.

## Limitations

- `corpus.py` inspects at most the first 60 pages per PDF for page-level
  features (large proceedings volumes are slow with pypdf); the byte scan
  covers the whole file for CJK / Rotate / Annots markers.
- The scanned-page heuristic (image XObject + < 40 chars of extractable
  text) can be fooled by vector pages carrying only a small logo image.
- The blob criterion needs scipy (installed with scikit-image); without it
  the blob size is reported as 0 and only the global thresholds apply.
- Without scikit-image, SSIM uses a built-in Gaussian-window implementation
  (pure numpy, slower, comparable numbers).
- Everything runs offline; no PDF or metadata leaves the machine.
