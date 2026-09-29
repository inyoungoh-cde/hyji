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
  run-all.py        loops the corpus, runs A, B and compare per paper (--text adds the text-geometry stage)
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

## Text-geometry parity (`--text`)

The viewer's text layer (selection / highlight boxes, search hits) moves from
pdf.js to PDFium too, so the harness also checks where the two engines say
text *is*. Same page sample, same display frame (points, top-left origin,
CropBox and /Rotate applied):

```
tools/render-verify/
  text-pdfjs.mjs    A: page.getTextContent() runs -> text-NNNN.json (run box built like TextLayer's <span>)
  text-pdfium.py    B: `pdfium-spike text <pdf> <page> <out.json>` -> per-char tight + loose boxes, origin
  text-compare.py   A vs B: coverage both ways, baseline/advance offsets, flagged runs, overlays
```

```
node   tools/render-verify/text-pdfjs.mjs  --pdf <file> --pages 0,1 --out outA-text
python tools/render-verify/text-pdfium.py  --pdf <file> --pages 0,1 --out outB-text
python tools/render-verify/text-compare.py --a outA-text --b outB-text --out results --pdf <file> [--overlay all]
python tools/render-verify/run-all.py --text [--only fixtures] [--text-exe <pdfium-spike.exe>]
```

- **A (pdf.js)**: one record per text item ("run"). The box is exactly the
  TextLayer span: `tx = Util.transform(viewport.transform, item.transform)`,
  left/top from `tx[4]`, `tx[5] - ascent*fontHeight`, width = `item.width`,
  height = `hypot(tx[2], tx[3])`, rotated by `atan2(tx[1], tx[0])`. The
  ascent ratio is the TextLayer's fallback chain (`style.ascent`,
  `1+style.descent`, 0.8); in the browser it measures the loaded @font-face
  instead, so vertical extents can differ from the live viewer by a fraction
  of the font size. pdf.js has **no per-character boxes** — `chars` are an
  estimate (advance split equally over the characters), used only for
  coverage matching with a tolerance.
- **B (PDFium)**: every FPDFText character with tight box
  (`FPDFText_GetCharBox`), loose box (`FPDFText_GetLooseCharBox`) and origin,
  converted page space → display: `x' = x - crop.left`, `y' = crop.top - y`,
  then 90°: `(H0-y', x')`, 180°: `(W0-x', H0-y')`, 270°: `(y', W0-x')`.
  Verified by painting the boxes over the spike's own render of the
  rotate90 / rotate270 / cropbox-offset fixtures. `gen` marks characters
  pdfium synthesises (spaces / line breaks); they are ignored.
- **Metrics per page** (`text-compare.md`): `A unc` = pdf.js chars with no
  PDFium char within max(3 pt, 0.8 × font size) of the estimated position;
  `B unc` = PDFium chars whose center lies in no pdf.js run box; together
  these catch text one engine cannot extract (Type3, broken CMaps, CJK).
  `B outside` = PDFium chars beyond the CropBox — FPDFText keeps them, pdf.js
  drops them (never visible), reported but not counted. `ident` = per-run
  text difference (1 − SequenceMatcher ratio, NFKC), informative only.
  Offsets are measured **per run in the run's own frame**: `dx` = how far
  the union of PDFium loose boxes starts/ends from the pdf.js advance
  (max of the two edge errors), `dy` = mean baseline offset of the matched
  PDFium origins. Mean and p95 over runs; a run with `dx` or `dy` > 2 pt
  (`--flag-pt`) is **flagged**. Runs that cross the CropBox edge are
  "edge" runs (pdf.js truncates glyph-wise, FPDFText does not) and are
  skipped; runs matching no PDFium char are "unmatched".
- **Overlays** (`<paper>/text-overlays/text-NNNN.png`, PDFium render at
  1.5 px/pt, for pages with flags/coverage gaps or all with
  `--overlay all`): left = pdf.js run boxes (red; thick magenta = flagged,
  thick red = unmatched, orange = edge; red dot = uncovered pdf.js char),
  right = PDFium loose boxes (blue; cyan fill = PDFium char no run covers).
- `run-all.py --text` runs all three per paper (independent of
  `--pdfium-cli`; the spike path comes from `--text-exe` / `PDFIUM_SPIKE`)
  and appends a "Text geometry" table to `report.md` / `report.json`.

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
- Text parity on `/UserUnit` pages: pdf.js's `PageViewport` scales the
  transform by the UserUnit but `TextLayer` sizes spans with
  `viewport.scale`, which excludes it, so pdf.js's own spans are UserUnit×
  too narrow against its canvas; PDFium ignores UserUnit consistently.
  `text-compare.py` rescales A into B's frame ("A scaled xK") and the
  remaining width flags on such pages are that pdf.js inconsistency.
- Text parity: pdf.js per-character positions are estimated (equal split of
  the run advance), so `A unc` has a font-size-relative tolerance and cannot
  see sub-glyph shifts; per-run `dx`/`dy` are exact. Vertical (`ascent`)
  extents on side A follow the TextLayer fallback chain, not the browser's
  measured font ascent.
- Everything runs offline; no PDF or metadata leaves the machine.
