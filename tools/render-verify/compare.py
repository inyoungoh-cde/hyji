#!/usr/bin/env python
"""Compare two directories of page PNGs (A = pdf.js reference, B = PDFium).

Per page (same file name in both dirs):
  size match, grayscale SSIM, mean absolute difference, and an ink-coverage
  check: ink = gray < 200; each side's ink mask is dilated by 2 px and we
  report the share of A's ink pixels that fall outside B's dilated ink
  ("a_uncovered": content pdf.js drew that PDFium did not) and vice-versa.
  Coverage is independent of antialiasing / stroke-weight differences, so it
  isolates MISSING content (failed font, dropped figure, lost annotation).

FAIL when a_uncovered > 0.5 % or b_uncovered > 0.5 % or SSIM < 0.85, or when
sizes differ by more than 1 px (a 1 px rounding difference is cropped to the
common size and only noted) / a file is missing. Because a single dropped text line is only
~0.2 % of a page's ink, a second LOCAL criterion also fails the page: the
largest connected blob of uncovered ink (after 2 px dilation) exceeding
--max-blob px (default 300 ~ one word at 1070 px width). An uncovered pixel
only counts when the two sides differ by more than --min-delta (48) gray
levels, so photo/depth-map midtones straddling the ink threshold are ignored. Every FAIL gets a side-by-side PNG
(A | B | diff heatmap) in <out>/diffs/.

usage: compare.py --a <dirA> --b <dirB> --out <dir> [--label name]
                  [--ink 200] [--dilate 2] [--max-uncovered 0.005] [--min-ssim 0.85] [--max-blob 300]
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

try:
    from skimage.metrics import structural_similarity as _ssim_skimage
except Exception:  # scikit-image not installed -> built-in gaussian-window SSIM
    _ssim_skimage = None
try:
    from scipy.ndimage import label as _cc_label
except Exception:
    _cc_label = None


def load_gray(path):
    im = Image.open(path).convert("L")
    return np.asarray(im, dtype=np.uint8)


def ssim_simple(a, b):
    """Global SSIM with an 11x11 separable Gaussian window (sigma 1.5), as in
    Wang et al. Used only when scikit-image is unavailable."""
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    r = 5
    x = np.arange(-r, r + 1, dtype=np.float64)
    g = np.exp(-(x ** 2) / (2 * 1.5 ** 2))
    g /= g.sum()

    def blur(img):
        p = np.pad(img, r, mode="reflect")
        p = np.apply_along_axis(lambda m: np.convolve(m, g, mode="valid"), 1, p)
        p = np.apply_along_axis(lambda m: np.convolve(m, g, mode="valid"), 0, p)
        return p

    c1 = (0.01 * 255) ** 2
    c2 = (0.03 * 255) ** 2
    mu_a, mu_b = blur(a), blur(b)
    saa = blur(a * a) - mu_a ** 2
    sbb = blur(b * b) - mu_b ** 2
    sab = blur(a * b) - mu_a * mu_b
    s = ((2 * mu_a * mu_b + c1) * (2 * sab + c2)) / ((mu_a ** 2 + mu_b ** 2 + c1) * (saa + sbb + c2))
    return float(s.mean())


def ssim(a, b):
    if _ssim_skimage is not None:
        return float(_ssim_skimage(a, b, data_range=255))
    return ssim_simple(a, b)


def dilate(mask, r):
    """Binary dilation with a (2r+1)^2 square structuring element, numpy only."""
    if r <= 0:
        return mask
    p = np.pad(mask, r, mode="constant", constant_values=False)
    out = np.zeros_like(mask)
    h, w = mask.shape
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out |= p[r + dy : r + dy + h, r + dx : r + dx + w]
    return out


def coverage(a, b, ink_thr, r, min_delta=48):
    ia = a < ink_thr
    ib = b < ink_thr
    da = dilate(ia, r)
    db = dilate(ib, r)
    na = int(ia.sum())
    nb = int(ib.sum())
    # Require a clear tone gap at the pixel: midtones in photos/depth maps
    # that sit near the ink threshold (A=190, B=205) are resampling noise,
    # not content. Truly missing ink is white on the other side (gap >= 55).
    clear = np.abs(a.astype(np.int16) - b.astype(np.int16)) > min_delta
    a_unc = ia & ~db & clear  # A ink with no B ink nearby -> missing in B
    b_unc = ib & ~da & clear  # B ink with no A ink nearby -> extra in B
    return {
        "a_ink": na,
        "b_ink": nb,
        "a_uncovered": (float(a_unc.sum()) / na) if na else 0.0,
        "b_uncovered": (float(b_unc.sum()) / nb) if nb else 0.0,
        "_a_unc_mask": a_unc,
        "_b_unc_mask": b_unc,
    }


def largest_blob(mask, r):
    """Area (px) of the largest 8-connected component of `mask` after dilating
    by r px (so a broken glyph outline counts as one blob). 0 without scipy."""
    if _cc_label is None or not mask.any():
        return 0
    lab, n = _cc_label(dilate(mask, r), structure=np.ones((3, 3), dtype=bool))
    if n == 0:
        return 0
    return int(np.bincount(lab.ravel())[1:].max())


def side_by_side(a, b, a_unc, b_unc, path):
    """A | B | heatmap. Heatmap: gray = |A-B| scaled, red = A-only ink
    (missing in B), blue = B-only ink (extra in B)."""
    h, w = a.shape
    diff = np.abs(a.astype(np.int16) - b.astype(np.int16)).astype(np.uint8)
    heat = np.stack([255 - diff] * 3, axis=-1).astype(np.uint8)
    heat[a_unc] = (220, 30, 30)
    heat[b_unc] = (30, 80, 220)
    gap = np.full((h, 8, 3), (255, 200, 0), dtype=np.uint8)
    panel = np.concatenate(
        [np.stack([a] * 3, -1), gap, np.stack([b] * 3, -1), gap, heat], axis=1
    )
    Image.fromarray(panel).save(path)


def compare_dirs(dir_a, dir_b, out_dir, label=None, ink_thr=200, dil=2, max_unc=0.005, min_ssim=0.85, max_blob=300,
                 min_delta=48):
    os.makedirs(out_dir, exist_ok=True)
    diffs_dir = os.path.join(out_dir, "diffs")
    names = sorted(f for f in os.listdir(dir_a) if f.lower().endswith(".png"))
    rows = []
    for name in names:
        pa = os.path.join(dir_a, name)
        pb = os.path.join(dir_b, name)
        row = {"page": name, "status": "PASS", "reasons": []}
        if not os.path.exists(pb):
            row.update(status="FAIL", reasons=["missing in B"])
            rows.append(row)
            continue
        a = load_gray(pa)
        b = load_gray(pb)
        row["size_a"] = [int(a.shape[1]), int(a.shape[0])]
        row["size_b"] = [int(b.shape[1]), int(b.shape[0])]
        row["size_match"] = a.shape == b.shape
        if a.shape != b.shape:
            dh = abs(a.shape[0] - b.shape[0])
            dw = abs(a.shape[1] - b.shape[1])
            if dh <= 1 and dw <= 1:
                # rounding difference between the two rasterizers; not a geometry error
                row["size_note"] = "size differs by <=1 px (%dx%d vs %dx%d), cropped to common" % (
                    a.shape[1], a.shape[0], b.shape[1], b.shape[0])
            else:
                row["reasons"].append("size mismatch %dx%d vs %dx%d" % (a.shape[1], a.shape[0], b.shape[1], b.shape[0]))
            # compare on the common crop so the remaining metrics still exist
            h = min(a.shape[0], b.shape[0])
            w = min(a.shape[1], b.shape[1])
            a = a[:h, :w]
            b = b[:h, :w]
        row["ssim"] = round(ssim(a, b), 4)
        row["mad"] = round(float(np.abs(a.astype(np.int16) - b.astype(np.int16)).mean()), 3)
        cov = coverage(a, b, ink_thr, dil, min_delta)
        row["a_ink"] = cov["a_ink"]
        row["b_ink"] = cov["b_ink"]
        row["a_uncovered"] = round(cov["a_uncovered"], 5)
        row["b_uncovered"] = round(cov["b_uncovered"], 5)
        row["a_blob"] = largest_blob(cov["_a_unc_mask"], dil)
        row["b_blob"] = largest_blob(cov["_b_unc_mask"], dil)
        if row["ssim"] < min_ssim:
            row["reasons"].append("ssim %.3f < %.2f" % (row["ssim"], min_ssim))
        if cov["a_uncovered"] > max_unc:
            row["reasons"].append("A ink uncovered by B %.2f%% (content MISSING in B)" % (100 * cov["a_uncovered"]))
        if cov["b_uncovered"] > max_unc:
            row["reasons"].append("B ink uncovered by A %.2f%% (content EXTRA in B)" % (100 * cov["b_uncovered"]))
        if row["a_blob"] > max_blob:
            row["reasons"].append("largest MISSING blob %d px > %d" % (row["a_blob"], max_blob))
        if row["b_blob"] > max_blob:
            row["reasons"].append("largest EXTRA blob %d px > %d" % (row["b_blob"], max_blob))
        if row["reasons"]:
            row["status"] = "FAIL"
            os.makedirs(diffs_dir, exist_ok=True)
            stem = (label + "__" if label else "") + os.path.splitext(name)[0] + ".png"
            row["diff_png"] = os.path.join(diffs_dir, stem)
            side_by_side(a, b, cov["_a_unc_mask"], cov["_b_unc_mask"], row["diff_png"])
        rows.append(row)

    n_fail = sum(1 for r in rows if r["status"] == "FAIL")
    summary = {
        "label": label,
        "a": os.path.abspath(dir_a),
        "b": os.path.abspath(dir_b),
        "params": {"ink_threshold": ink_thr, "dilate_px": dil, "max_uncovered": max_unc, "min_ssim": min_ssim, "max_blob_px": max_blob, "min_delta": min_delta,
                   "ssim_impl": "scikit-image" if _ssim_skimage else "builtin"},
        "pages": len(rows),
        "failed": n_fail,
        "rows": rows,
    }
    md = ["| page | size | SSIM | MAD | A ink missing in B | B ink extra | max blob (miss/extra) | status | reasons |",
          "|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        if "ssim" in r:
            size = "%dx%d" % tuple(r["size_a"]) + ("" if r["size_match"] else " / %dx%d" % tuple(r["size_b"]))
            md.append("| %s | %s | %.3f | %.2f | %.3f%% | %.3f%% | %d / %d | %s | %s |" % (
                r["page"], size, r["ssim"], r["mad"], 100 * r["a_uncovered"], 100 * r["b_uncovered"],
                r["a_blob"], r["b_blob"], r["status"], "; ".join(r["reasons"])))
        else:
            md.append("| %s | - | - | - | - | - | - | %s | %s |" % (r["page"], r["status"], "; ".join(r["reasons"])))
    md_text = "\n".join(md) + "\n\n**%d / %d pages FAIL**\n" % (n_fail, len(rows))
    stem = ("compare-" + label) if label else "compare"
    with open(os.path.join(out_dir, stem + ".json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    with open(os.path.join(out_dir, stem + ".md"), "w", encoding="utf-8") as f:
        f.write(md_text)
    return summary, md_text


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--a", required=True, help="reference PNG dir (pdf.js)")
    ap.add_argument("--b", required=True, help="candidate PNG dir (PDFium)")
    ap.add_argument("--out", required=True, help="output dir for summary + diffs/")
    ap.add_argument("--label", default=None, help="prefix for output file names")
    ap.add_argument("--ink", type=int, default=200, help="ink threshold on 0-255 gray (default 200)")
    ap.add_argument("--dilate", type=int, default=2, help="dilation radius in px (default 2)")
    ap.add_argument("--max-uncovered", type=float, default=0.005, help="fail above this share (default 0.005 = 0.5%%)")
    ap.add_argument("--min-ssim", type=float, default=0.85)
    ap.add_argument("--max-blob", type=int, default=300, help="fail when the largest uncovered blob exceeds this many px")
    ap.add_argument("--min-delta", type=int, default=48, help="uncovered ink must differ from the other side by more than this gray level")
    args = ap.parse_args()
    summary, md = compare_dirs(args.a, args.b, args.out, args.label, args.ink, args.dilate, args.max_uncovered,
                               args.min_ssim, args.max_blob, args.min_delta)
    print(md)
    sys.exit(1 if summary["failed"] else 0)


if __name__ == "__main__":
    main()
