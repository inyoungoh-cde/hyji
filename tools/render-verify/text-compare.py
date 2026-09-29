#!/usr/bin/env python
"""Text-geometry parity: pdf.js text runs (A, text-pdfjs.mjs) vs PDFium
characters (B, text-pdfium.py), both in display points.

usage: text-compare.py --a <dirA> --b <dirB> --out <dir> [--label name]
                       [--pdf <file> --exe <pdfium-spike.exe>]   (overlays for flagged pages)
                       [--flag-pt 2.0] [--cov-tol 3.0] [--overlay-scale 1.5] [--overlay all]

Per page:
  coverage A->B   share of pdf.js characters (non-space) with NO PDFium
                  character origin within --cov-tol pt (or 0.8 x font size,
                  whichever is larger) of the character's estimated position.
                  pdf.js has no per-char boxes: the run advance is split
                  equally, so the tolerance scales with the font size.
  coverage B->A   share of PDFium characters (non-generated, non-space) whose
                  tight-box center lies in no pdf.js run box (expanded 1 pt).
                  Together these catch text one engine cannot extract at all
                  (Type3, broken CMaps, CJK without ToUnicode ...).
  size            display size A vs B. Differing by one uniform factor
                  (/UserUnit: pdf.js's viewport applies it, PDFium's page size
                  does not) is reported as "(A scaled xK)" and A is compared in
                  B's frame; any other mismatch is a Rotate/CropBox bug.
  B outside       PDFium characters whose center lies outside the display box.
                  FPDFText keeps glyphs beyond the CropBox, pdf.js's
                  getTextContent drops them (never visible) -- reported, not
                  counted as uncovered.
  identity        per matched run, 1 - SequenceMatcher ratio between the run's
                  string and the matched PDFium chars read along the baseline
                  (NFKC-normalised, spaces removed), char-weighted --
                  informative (encoding / ligature differences), not geometry.
  offset          per pdf.js run, PDFium chars whose origin lies within the
                  run's advance (and tight-box center within its height) are
                  collected; a char inside several runs (overlapping advances,
                  accents, sub/superscripts) goes to a run whose text contains
                  it, then to the nearest baseline. In the
                  run's own frame (u = baseline direction, v = perpendicular):
                    dx = max(|min_u(loose boxes) - 0|, |max_u(loose boxes) - advance|)
                         -> where the run starts/ends along the baseline
                    dy = mean over matched chars of |v(origin)|
                         -> baseline offset (the pdf.js span top is the baseline
                            minus ascent*fontsize; PDFium loose boxes are the
                            same idea, so dy compares the anchor both use).
                  Mean / p95 of dx and dy over runs; a run with dx or dy >
                  --flag-pt (2 pt) is FLAGGED. Runs matching no PDFium char are
                  "unmatched" (counted in coverage, not in offsets); runs crossing the
                  display box are "edge" runs (pdf.js cuts them at the CropBox,
                  FPDFText does not) and are skipped too (orange in overlays).
Overlay (flagged pages, or all with --overlay all; needs --pdf and the spike
--exe): PDFium render at --overlay-scale px/pt, LEFT = pdf.js run boxes (red;
flagged runs thick magenta; runs matching no PDFium char thick red; edge runs
orange; uncovered pdf.js chars: red dot at the estimated char center),
RIGHT = PDFium loose boxes (blue; uncovered PDFium chars: cyan fill).
Output: <out>/text-compare[-label].md / .json, <out>/text-overlays/text-NNNN.png
"""
import argparse
import glob
import json
import math
import os
import subprocess
import sys
import unicodedata
from difflib import SequenceMatcher

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def _norm(ch):
    return unicodedata.normalize("NFKC", ch)


def _is_space(ch):
    return ch != "" and ch.strip() == ""


def _merge_surrogates(chars):
    """PDFium reports an astral character as two UTF-16 halves with the same
    box; join them into one character."""
    out = []
    i = 0
    while i < len(chars):
        c = chars[i]
        u = ord(c["c"]) if len(c["c"]) == 1 else -1
        if 0xD800 <= u <= 0xDBFF and i + 1 < len(chars) and len(chars[i + 1]["c"]) == 1 \
                and 0xDC00 <= ord(chars[i + 1]["c"]) <= 0xDFFF:
            lo = ord(chars[i + 1]["c"])
            c = dict(c, c=chr(0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00)))
            i += 1
        elif 0xD800 <= u <= 0xDFFF:
            c = dict(c, c="")  # lone half: geometry only
        out.append(c)
        i += 1
    return out


def load_pages(d, prefix="text-"):
    out = {}
    for f in sorted(glob.glob(os.path.join(d, prefix + "[0-9][0-9][0-9][0-9].json"))):
        with open(f, encoding="utf-8") as fh:
            out[int(os.path.basename(f)[len(prefix):len(prefix) + 4])] = json.load(fh)
    return out


def _scale_a(a, k):
    """Scale every pdf.js coordinate by k (UserUnit: pdf.js's viewport applies
    /UserUnit, FPDF_GetPageWidthF does not). Returns a scaled copy."""
    import copy
    a = copy.deepcopy(a)
    a["width"] *= k
    a["height"] *= k
    for r in a["runs"]:
        for key in ("x", "y", "w", "h", "bx", "by", "adv", "fh"):
            r[key] *= k
        r["poly"] = [[x * k, y * k] for x, y in r["poly"]]
        for c in r["chars"]:
            for key in ("x", "y", "w", "h", "cx", "cy"):
                c[key] *= k
    return a


def compare_page(a, b, flag_pt=2.0, cov_tol=3.0):
    # Sizes differing by one uniform factor = a page-unit convention (UserUnit),
    # not a placement error: compare in B's frame and report the factor.
    unit_scale = None
    if a["width"] and a["height"]:
        kx, ky = b["width"] / a["width"], b["height"] / a["height"]
        if abs(kx - ky) < 1e-3 and abs(kx - 1) > 1e-3:
            unit_scale = kx
            a = _scale_a(a, kx)
    # whitespace-only pdf.js items have no glyph to compare against
    runs = [r for r in a["runs"] if not _is_space(r["str"])]
    W, H = b["width"], b["height"]
    ball = [c for c in _merge_surrogates(b["chars"]) if not c["gen"] and not _is_space(c["c"]) and c["w"] > 0 and c["h"] > 0]
    # FPDFText keeps glyphs outside the CropBox; pdf.js's getTextContent drops
    # them (they are never visible). Count them separately, compare the rest.
    bchars = [c for c in ball if -0.5 <= c["x"] + c["w"] / 2 <= W + 0.5 and -0.5 <= c["y"] + c["h"] / 2 <= H + 0.5]
    res = {"page": a["page"], "runs": len(runs), "a_chars": 0, "b_chars": len(bchars),
           "b_outside_page": len(ball) - len(bchars),
           "size_a": [a["width"], a["height"]], "size_b": [b["width"], b["height"]],
           "size_match": abs(a["width"] - b["width"]) < 0.51 and abs(a["height"] - b["height"]) < 0.51,
           "unit_scale": unit_scale}

    # ---- A -> B coverage on estimated char positions
    a_pts, a_tol, a_txt = [], [], []
    for r in runs:
        for c in r["chars"]:
            if _is_space(c["c"]):
                continue
            a_pts.append((c["cx"], c["cy"]))
            a_tol.append(max(cov_tol, 0.8 * r["fh"]))
            a_txt.append(_norm(c["c"]))
    res["a_chars"] = len(a_pts)
    b_ctr = np.array([[c["x"] + c["w"] / 2, c["y"] + c["h"] / 2] for c in bchars], dtype=float).reshape(-1, 2)
    b_txt = [_norm(c["c"]) for c in bchars]
    a_unc = np.ones(len(a_pts), dtype=bool)
    a_ident_bad = 0
    a_unc_pts = []
    if len(a_pts) and len(bchars):
        A = np.array(a_pts, dtype=float)
        try:
            from scipy.spatial import cKDTree
            tree = cKDTree(b_ctr)
            dist, idx = tree.query(A, k=1)
        except Exception:
            d2 = ((A[:, None, :] - b_ctr[None, :, :]) ** 2).sum(-1)
            idx = d2.argmin(1)
            dist = np.sqrt(d2[np.arange(len(A)), idx])
        tol = np.array(a_tol)
        a_unc = dist > tol
    a_unc_pts = [a_pts[i] for i in np.nonzero(a_unc)[0]]
    res["a_uncovered"] = int(a_unc.sum())
    res["a_uncovered_share"] = float(a_unc.sum() / len(a_pts)) if len(a_pts) else 0.0

    # ---- per-run matching in the run frame + B -> A coverage
    b_covered = np.zeros(len(bchars), dtype=bool)
    dxs, dys, flagged, unmatched, edge = [], [], [], 0, 0
    ident_bad, ident_n = 0.0, 0  # char-weighted (1 - SequenceMatcher ratio) over matched runs
    frames = []
    if len(bchars):
        b_org = np.array([[c["ox"], c["oy"]] for c in bchars], dtype=float)
        b_loose = np.array([[c["lx"], c["ly"], c["lw"], c["lh"]] for c in bchars], dtype=float)
        # Each PDFium char belongs to at most ONE run. Membership: the glyph
        # ORIGIN lies within the run's advance along the baseline and the
        # tight-box center within its vertical extent. Ties (overlapping runs:
        # dot leaders whose advances overlap, an accent over its base letter,
        # sub/superscripts) go to a run whose text contains the char, then to
        # the one whose baseline is nearest. Without this, a run swallows its
        # neighbours' glyphs and the union box looks shifted.
        owner = np.full(len(bchars), -1, dtype=int)
        owner_key = np.full((len(bchars), 3), np.inf)
        for ri, r in enumerate(runs):
            ang = math.radians(r["angle"])
            u = np.array([math.cos(ang), math.sin(ang)])
            v = np.array([-math.sin(ang), math.cos(ang)])
            o = np.array([r["bx"], r["by"]])
            adv, fh, asc = r["adv"], r["fh"], r["ascent"]
            rel = b_ctr - o
            pu = rel @ u
            pv = rel @ v  # +v = below the baseline (display y grows downward)
            ou = (b_org - o) @ u
            ov = (b_org - o) @ v
            inside = (ou >= -0.75) & (ou <= adv - 0.25) & (pv >= -asc * fh - 1.0) & (pv <= (1 - asc) * fh + 1.0)
            cand = np.nonzero(inside)[0]
            if len(cand):
                rtxt = set(_norm(ch) for ch in r["str"])
                key = np.stack([np.array([0.0 if b_txt[i] in rtxt else 1.0 for i in cand]),
                                np.abs(ov[cand]), np.abs(ou[cand])], 1)
                cur = owner_key[cand]
                better = (key[:, 0] < cur[:, 0]) | ((key[:, 0] == cur[:, 0]) & (
                    (key[:, 1] < cur[:, 1] - 1e-6) | ((np.abs(key[:, 1] - cur[:, 1]) <= 1e-6) & (key[:, 2] < cur[:, 2]))))
                owner[cand[better]] = ri
                owner_key[cand[better]] = key[better]
            frames.append((u, v, o, pu, pv))
    for ri, r in enumerate(runs):
        r["flag"] = False
        if not len(bchars):
            unmatched += 1
            continue
        u, v, o, pu, pv = frames[ri]
        adv, fh, asc = r["adv"], r["fh"], r["ascent"]
        sel = np.nonzero(owner == ri)[0]
        b_covered[sel] = True
        # a run crossing the display box is cut by pdf.js at the CropBox edge
        # (glyph-wise) while FPDFText keeps the rest: covered, but not comparable
        if r["x"] < -0.5 or r["y"] < -0.5 or r["x"] + r["w"] > W + 0.5 or r["y"] + r["h"] > H + 0.5:
            r["edge"] = True
            edge += 1
            continue
        if not len(sel):
            unmatched += 1
            r["unmatched"] = True
            continue
        # text identity: run string vs. the matched chars read along the baseline
        order = sel[np.argsort(pu[sel])]
        sa = "".join(_norm(ch) for ch in r["str"] if not _is_space(ch))
        sb = "".join(b_txt[i] for i in order)
        ratio = SequenceMatcher(None, sa, sb, autojunk=False).ratio() if sa else 1.0
        ident_bad += (1.0 - ratio) * len(sa)
        ident_n += len(sa)
        r["ident"] = round(ratio, 3)
        # loose-box corners projected on u
        L = b_loose[sel]
        corners = np.stack([L[:, :2], L[:, :2] + L[:, 2:3] * [1, 0], L[:, :2] + L[:, 2:4], L[:, :2] + L[:, 3:4] * [0, 1]], 1)
        cu = (corners - o) @ u
        dx = max(abs(cu.min()), abs(cu.max() - adv))
        dy = float(np.abs((b_org[sel] - o) @ v).mean())
        dxs.append(dx)
        dys.append(dy)
        r["dx"], r["dy"], r["nb"] = round(dx, 2), round(dy, 2), int(len(sel))
        if dx > flag_pt or dy > flag_pt:
            r["flag"] = True
            flagged.append({"str": r["str"][:60], "x": r["x"], "y": r["y"], "dx": r["dx"], "dy": r["dy"],
                            "ident": r["ident"], "font": r["fontFamily"]})
    res["b_uncovered"] = int((~b_covered).sum())
    res["b_uncovered_share"] = float((~b_covered).sum() / len(bchars)) if len(bchars) else 0.0
    res["unmatched_runs"] = unmatched
    res["edge_runs"] = edge
    res["matched_runs"] = len(dxs)
    res["identity_mismatch_share"] = float(ident_bad / ident_n) if ident_n else 0.0
    res["dxs"], res["dys"] = [round(v, 3) for v in dxs], [round(v, 3) for v in dys]
    if dxs:
        res["dx_mean"], res["dx_p95"] = float(np.mean(dxs)), float(np.percentile(dxs, 95))
        res["dy_mean"], res["dy_p95"] = float(np.mean(dys)), float(np.percentile(dys, 95))
    else:
        res["dx_mean"] = res["dx_p95"] = res["dy_mean"] = res["dy_p95"] = float("nan")
    res["flagged"] = len(flagged)
    res["flagged_runs"] = flagged[:40]
    res["_a_unc_pts"] = a_unc_pts
    if unit_scale:
        res["_run_marks"] = {i: {k: r[k] for k in ("flag", "edge", "unmatched") if k in r} for i, r in enumerate(a["runs"])}
    res["_b_unc"] = [bchars[i] for i in np.nonzero(~b_covered)[0]]
    res["ok"] = (res["size_match"] or bool(unit_scale)) and res["a_uncovered_share"] <= 0.02 and res["b_uncovered_share"] <= 0.02 and not flagged
    return res


def render_pdfium(exe, pdf, page, width, png):
    r = subprocess.run([exe, pdf, str(page), str(width), png], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return r.returncode == 0 and os.path.exists(png)


def overlay(png, a, b, res, out_png, scale):
    from PIL import Image, ImageDraw
    im = Image.open(png).convert("RGB")
    if res.get("unit_scale"):
        a = _scale_a(a, res["unit_scale"])
    s = im.width / b["width"]
    left = im.copy()
    right = im.copy()
    dl, dr = ImageDraw.Draw(left), ImageDraw.Draw(right)
    for r in a["runs"]:
        poly = [(x * s, y * s) for x, y in r["poly"]]
        if r.get("edge"):
            dl.polygon(poly, outline=(255, 160, 0))
        elif r.get("unmatched"):
            dl.line(poly + [poly[0]], fill=(255, 0, 0), width=3)
        elif r.get("flag"):
            dl.line(poly + [poly[0]], fill=(255, 0, 200), width=3)
            dr.line(poly + [poly[0]], fill=(255, 0, 200), width=2)
        else:
            dl.polygon(poly, outline=(255, 0, 0))
    for x, y in res["_a_unc_pts"]:
        dl.ellipse([x * s - 2, y * s - 2, x * s + 2, y * s + 2], fill=(255, 0, 0))
    for c in _merge_surrogates(b["chars"]):
        if c["gen"] or _is_space(c["c"]) or c["lw"] <= 0:
            continue
        dr.rectangle([c["lx"] * s, c["ly"] * s, (c["lx"] + c["lw"]) * s, (c["ly"] + c["lh"]) * s], outline=(0, 0, 255))
    for c in res["_b_unc"]:
        dr.rectangle([c["x"] * s, c["y"] * s, (c["x"] + c["w"]) * s, (c["y"] + c["h"]) * s], fill=(0, 200, 255))
    gap = 8
    out = Image.new("RGB", (left.width * 2 + gap, left.height), (128, 128, 128))
    out.paste(left, (0, 0))
    out.paste(right, (left.width + gap, 0))
    out.save(out_png)


def fmt(v):
    return "nan" if v != v else "%.2f" % v


def compare_dirs(dir_a, dir_b, out_dir, label=None, pdf=None, exe=None, flag_pt=2.0, cov_tol=3.0,
                 overlay_scale=1.5, overlay_mode="flagged"):
    os.makedirs(out_dir, exist_ok=True)
    A = load_pages(dir_a)
    B = load_pages(dir_b)
    rows = []
    for p in sorted(set(A) | set(B)):
        if p not in A or p not in B:
            rows.append({"page": p, "ok": False, "error": "missing in %s" % ("A" if p not in A else "B")})
            continue
        res = compare_page(A[p], B[p], flag_pt=flag_pt, cov_tol=cov_tol)
        if res.get("unit_scale"):
            # compare_page worked on a scaled copy; carry the per-run marks back
            marks = res.pop("_run_marks", {})
            for i, r in enumerate(A[p]["runs"]):
                r.update(marks.get(i, {}))
        want_overlay = overlay_mode == "all" or (not res["ok"])
        if want_overlay and pdf and exe and os.path.exists(exe):
            ov_dir = os.path.join(out_dir, "text-overlays")
            os.makedirs(ov_dir, exist_ok=True)
            base = os.path.join(ov_dir, "render-%04d.png" % p)
            width = int(round(overlay_scale * B[p]["width"]))
            if render_pdfium(exe, pdf, p, width, base):
                out_png = os.path.join(ov_dir, "text-%04d.png" % p)
                overlay(base, A[p], B[p], res, out_png, overlay_scale)
                res["overlay_png"] = out_png
                os.remove(base)
        res.pop("_a_unc_pts", None)
        res.pop("_b_unc", None)
        rows.append(res)
    n_bad = sum(1 for r in rows if not r.get("ok"))
    summary = {"label": label, "a": dir_a, "b": dir_b, "pages": len(rows), "not_ok": n_bad, "rows": rows,
               "params": {"flag_pt": flag_pt, "cov_tol": cov_tol}}
    lines = ["| page | size | A chars | A unc | B chars | B unc | B outside | ident | runs (unm) | dx mean/p95 | dy mean/p95 | flagged | status |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        if "error" in r:
            lines.append("| %d | - | | | | | | | | | | | FAIL %s |" % (r["page"], r["error"]))
            continue
        lines.append("| %d | %s | %d | %.1f%% | %d | %.1f%% | %d | %.1f%% | %d (%d) | %s / %s | %s / %s | %d | %s |" % (
            r["page"], ("ok" if r["size_match"] else "%sx%s vs %sx%s" % (*r["size_a"], *r["size_b"]))
            + (" (A scaled x%.3g)" % r["unit_scale"] if r.get("unit_scale") else ""),
            r["a_chars"], 100 * r["a_uncovered_share"], r["b_chars"], 100 * r["b_uncovered_share"],
            r["b_outside_page"], 100 * r["identity_mismatch_share"], r["runs"], r["unmatched_runs"],
            fmt(r["dx_mean"]), fmt(r["dx_p95"]), fmt(r["dy_mean"]), fmt(r["dy_p95"]), r["flagged"],
            "ok" if r["ok"] else "CHECK" + (" (overlay)" if r.get("overlay_png") else "")))
    md = "\n".join(lines) + "\n"
    for r in rows:
        if r.get("flagged_runs"):
            md += "\npage %d flagged runs (first %d):\n" % (r["page"], len(r["flagged_runs"]))
            for f in r["flagged_runs"][:12]:
                md += "- dx=%.2f dy=%.2f ident=%.2f at (%.0f,%.0f) %s: %r\n" % (f["dx"], f["dy"], f["ident"], f["x"], f["y"], f["font"], f["str"])
    suffix = ("-" + label) if label else ""
    with open(os.path.join(out_dir, "text-compare%s.md" % suffix), "w", encoding="utf-8") as f:
        f.write(md)
    slim = dict(summary, rows=[{k: v for k, v in r.items() if k not in ("dxs", "dys")} for r in rows])
    with open(os.path.join(out_dir, "text-compare%s.json" % suffix), "w", encoding="utf-8") as f:
        json.dump(slim, f, indent=1, ensure_ascii=False)
    return summary, md


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--a", required=True)
    ap.add_argument("--b", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--label", default=None)
    ap.add_argument("--pdf", default=None, help="source PDF (for overlays)")
    ap.add_argument("--exe", default=None, help="pdfium spike exe (default: pdfium-cli.py's)")
    ap.add_argument("--flag-pt", type=float, default=2.0)
    ap.add_argument("--cov-tol", type=float, default=3.0)
    ap.add_argument("--overlay-scale", type=float, default=1.5)
    ap.add_argument("--overlay", default="flagged", choices=["flagged", "all", "none"])
    args = ap.parse_args()
    exe = args.exe
    if exe is None:
        sys.path.insert(0, HERE)
        from importlib import import_module
        exe = os.environ.get("PDFIUM_SPIKE", import_module("pdfium-cli").DEFAULT_EXE)
    summary, md = compare_dirs(args.a, args.b, args.out, label=args.label, pdf=args.pdf,
                               exe=None if args.overlay == "none" else exe, flag_pt=args.flag_pt,
                               cov_tol=args.cov_tol, overlay_scale=args.overlay_scale, overlay_mode=args.overlay)
    print(md)
    sys.exit(1 if summary["not_ok"] else 0)


if __name__ == "__main__":
    main()
