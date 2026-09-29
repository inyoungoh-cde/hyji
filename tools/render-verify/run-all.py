#!/usr/bin/env python
"""Loop the corpus: render a page sample with pdf.js (A) and, when
--pdfium-cli is given, with PDFium (B), then run compare.py on each pair.

Page sample per PDF: first 3 pages + 2 evenly spaced interior pages + last
page (deduplicated, clipped to the page count). Width 1070 px (the viewer's
fit-width at the default layout).

usage: run-all.py [--corpus corpus.json] [--out <dir>] [--width 1070]
                  [--pdfium-cli <exe>] [--pdfium-args "<template>"] [--only <substring>]
                  [--pages 0,1|all] [--text] [--text-exe <pdfium-spike.exe>]

--text adds the TEXT-GEOMETRY stage on the same page sample: text-pdfjs.mjs
(A) and text-pdfium.py (B, the spike's `text` subcommand; --text-exe /
PDFIUM_SPIKE override its path) dump per-page text boxes, text-compare.py
scores them (coverage both ways, baseline/advance offsets, flagged runs) and
draws overlays for pages that need a look. Independent of --pdfium-cli.

PDFium CLI contract (default template): the executable is invoked as
  <exe> --pdf <file> --pages 0,1,5 --width 1070 --out <dir>
and must write <dir>/page-NNNN.png (0-based, 4 digits) -- the same names
render-pdfjs.mjs produces. If the CLI's flags differ, pass --pdfium-args with
the placeholders {pdf} {pages} {width} {out}, e.g.
  --pdfium-args "render {pdf} -p {pages} -w {width} -o {out}"
A .py path (e.g. pdfium-cli.py, the adapter for the pdfium spike) is run with
the current Python interpreter. Without --pdfium-cli only side A is rendered
and compare is skipped.
"""
import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
from compare import compare_dirs  # noqa: E402
from importlib import import_module  # noqa: E402

text_compare = import_module("text-compare")
text_pdfium = import_module("text-pdfium")


def page_sample(n):
    if not n:
        return [0]
    s = set(range(min(3, n)))
    if n > 4:
        s.add(n // 3)
        s.add((2 * n) // 3)
    s.add(n - 1)
    return sorted(i for i in s if 0 <= i < n)


def slug(title, pid):
    clean = lambda t, n: "".join(ch if ch.isalnum() else "-" for ch in t)[:n].strip("-")
    return "%s_%s" % (clean(pid, 24), clean(title or "untitled", 40))


def run(cmd, cwd=None):
    t = time.time()
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode, r.stdout + r.stderr, time.time() - t


def build_pdfium_cmd(exe, template, pdf, pages, width, out):
    # Substitute after splitting so paths with spaces stay single arguments.
    subs = {"{pdf}": pdf, "{pages}": pages, "{width}": str(width), "{out}": out}
    argv = [sys.executable, exe] if exe.lower().endswith(".py") else [exe]
    for tok in template.split():
        argv.append(subs.get(tok, tok))
    return argv


def text_stage(pdf, pages, name, args, renderer_dir, out_root):
    """A: text-pdfjs.mjs, B: spike `text`, then text-compare with overlays."""
    dir_a = os.path.join(out_root, name, "pdfjs-text")
    dir_b = os.path.join(out_root, name, "pdfium-text")
    rc_a, log_a, s_a = run(["node", os.path.join(renderer_dir, "text-pdfjs.mjs"), "--pdf", pdf,
                            "--pages", pages, "--out", dir_a], cwd=REPO)
    print(log_a.strip())
    page_list = [int(p) for p in pages.split(",")] if pages != "all" else list(range(text_pdfium.page_count(pdf)))
    t = time.time()
    try:
        _, failed_b = text_pdfium.dump_pages(pdf, page_list, dir_b, args.text_exe)
    except FileNotFoundError as e:
        print(str(e))
        return {"pdfjs_rc": rc_a, "error": str(e)}
    s_b = time.time() - t
    summary, md = text_compare.compare_dirs(dir_a, dir_b, os.path.join(out_root, name), label=None, pdf=pdf,
                                            exe=args.text_exe, flag_pt=args.text_flag_pt)
    print(md)
    rows = summary["rows"]
    dxs = [v for r in rows for v in r.get("dxs", [])]
    dys = [v for r in rows for v in r.get("dys", [])]
    a_chars = sum(r.get("a_chars", 0) for r in rows)
    b_chars = sum(r.get("b_chars", 0) for r in rows)
    ident_n = sum(r.get("a_chars", 0) for r in rows if "identity_mismatch_share" in r)
    pct = lambda num, den: (100.0 * num / den) if den else 0.0
    import numpy as np
    return {
        "pdfjs_rc": rc_a, "pdfjs_s": round(s_a, 1), "pdfium_failed": failed_b, "pdfium_s": round(s_b, 1),
        "pages": len(rows), "not_ok": summary["not_ok"],
        "a_chars": a_chars, "b_chars": b_chars,
        "b_outside": sum(r.get("b_outside_page", 0) for r in rows),
        "a_unc_pct": pct(sum(r.get("a_uncovered", 0) for r in rows), a_chars),
        "b_unc_pct": pct(sum(r.get("b_uncovered", 0) for r in rows), b_chars),
        "ident_pct": pct(sum(r.get("identity_mismatch_share", 0) * r.get("a_chars", 0) for r in rows), ident_n),
        "runs": sum(r.get("matched_runs", 0) for r in rows),
        "unmatched_runs": sum(r.get("unmatched_runs", 0) for r in rows),
        "edge_runs": sum(r.get("edge_runs", 0) for r in rows),
        "dx_mean": float(np.mean(dxs)) if dxs else float("nan"),
        "dx_p95": float(np.percentile(dxs, 95)) if dxs else float("nan"),
        "dy_mean": float(np.mean(dys)) if dys else float("nan"),
        "dy_p95": float(np.percentile(dys, 95)) if dys else float("nan"),
        "flagged": sum(r.get("flagged", 0) for r in rows),
        "overlays": [r["overlay_png"] for r in rows if r.get("overlay_png")],
        "rows": [{k: v for k, v in r.items() if k in ("page", "ok", "a_uncovered_share", "b_uncovered_share",
                                                        "dx_mean", "dx_p95", "dy_mean", "dy_p95", "flagged",
                                                        "unmatched_runs", "overlay_png", "error")} for r in rows],
    }


def text_report_md(report, total_check, flag_pt):
    f = lambda v: "nan" if v != v else "%.2f" % v
    lines = ["", "## Text geometry (pdf.js runs vs PDFium chars, display pt)", "",
             "| paper | pages | A chars | B chars (outside) | A unc | B unc | ident | runs (unm/edge) | dx mean/p95 | dy mean/p95 | flagged >%.0fpt | CHECK pages |" % flag_pt,
             "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for e in report:
        t = e.get("text")
        if not t:
            continue
        if "error" in t:
            lines.append("| %s | %s | ERROR %s |||||||||| " % ((e["title"] or "")[:50], e["pages"], t["error"]))
            continue
        lines.append("| %s | %s | %d | %d (%d) | %.1f%% | %.1f%% | %.1f%% | %d (%d/%d) | %s / %s | %s / %s | %d | %d |" % (
            (e["title"] or "")[:50], e["pages"], t["a_chars"], t["b_chars"], t["b_outside"], t["a_unc_pct"],
            t["b_unc_pct"], t["ident_pct"], t["runs"], t["unmatched_runs"], t["edge_runs"], f(t["dx_mean"]),
            f(t["dx_p95"]), f(t["dy_mean"]), f(t["dy_p95"]), t["flagged"], t["not_ok"]))
    lines.append("")
    lines.append("**text CHECK pages: %d** (overlays under <paper>/text-overlays/: left red = pdf.js runs, "
                 "right blue = PDFium loose boxes; thick magenta = flagged run, thick red = run without PDFium "
                 "chars, orange = CropBox-edge run, cyan fill = PDFium char no pdf.js run covers)" % total_check)
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", default=os.path.join(HERE, "corpus.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "out"))
    ap.add_argument("--width", type=int, default=1070)
    ap.add_argument("--pdfium-cli", default=None)
    ap.add_argument("--pdfium-args", default="--pdf {pdf} --pages {pages} --width {width} --out {out}")
    ap.add_argument("--only", default=None, help="only PDFs whose title/path contains this substring")
    ap.add_argument("--pages", default=None, help="override the sample, e.g. 0,1 or all")
    ap.add_argument("--text", action="store_true", help="also run the text-geometry parity stage")
    ap.add_argument("--text-exe", default=os.environ.get("PDFIUM_SPIKE", text_pdfium.DEFAULT_EXE),
                    help="pdfium spike exe with the `text` subcommand (for --text)")
    ap.add_argument("--text-flag-pt", type=float, default=2.0)
    args = ap.parse_args()
    args.out = os.path.abspath(args.out)  # node runs with cwd=REPO, the spike with ours

    with open(args.corpus, encoding="utf-8") as f:
        corpus = json.load(f)
    if args.only:
        corpus = [c for c in corpus if args.only.lower() in (c["title"] + c["pdf"]).lower()]
    os.makedirs(args.out, exist_ok=True)
    renderer = os.path.join(HERE, "render-pdfjs.mjs")
    report = []
    total_fail = 0
    total_text_check = 0
    for c in corpus:
        if not os.path.exists(c["pdf"]):
            print("skip (missing): %s" % c["pdf"])
            continue
        name = slug(c["title"], c["id"])
        pages = args.pages or ",".join(str(i) for i in page_sample(c.get("pages") or 0))
        dir_a = os.path.join(args.out, name, "pdfjs")
        dir_b = os.path.join(args.out, name, "pdfium")
        print("== %s  pages=%s" % (name, pages))
        rc, log, secs = run(["node", renderer, "--pdf", c["pdf"], "--pages", pages,
                             "--width", str(args.width), "--out", dir_a], cwd=REPO)
        entry = {"id": c["id"], "title": c["title"], "pdf": c["pdf"], "pages": pages,
                 "pdfjs_rc": rc, "pdfjs_s": round(secs, 1)}
        print(log.strip())
        if args.pdfium_cli:
            os.makedirs(dir_b, exist_ok=True)
            cmd = build_pdfium_cmd(args.pdfium_cli, args.pdfium_args, c["pdf"], pages, args.width, dir_b)
            rc_b, log_b, secs_b = run(cmd)
            entry.update(pdfium_rc=rc_b, pdfium_s=round(secs_b, 1))
            print(log_b.strip())
            summary, md = compare_dirs(dir_a, dir_b, os.path.join(args.out, name), label=None)
            entry.update(compared=summary["pages"], failed=summary["failed"],
                         rows=[{k: v for k, v in r.items()
                                if k in ("page", "status", "ssim", "a_uncovered", "b_uncovered", "reasons", "diff_png")}
                               for r in summary["rows"]])
            total_fail += summary["failed"]
            print(md)
        if args.text:
            entry["text"] = text_stage(c["pdf"], pages, name, args, renderer_dir=HERE, out_root=args.out)
            total_text_check += entry["text"].get("not_ok", 0)
        report.append(entry)

    with open(os.path.join(args.out, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    lines = ["| paper | pages | pdf.js | pdfium | compared | FAIL |", "|---|---|---|---|---|---|"]
    for e in report:
        lines.append("| %s | %s | rc=%s %.1fs | %s | %s | %s |" % (
            (e["title"] or "")[:50], e["pages"], e["pdfjs_rc"], e["pdfjs_s"],
            ("rc=%s %.1fs" % (e["pdfium_rc"], e["pdfium_s"])) if "pdfium_rc" in e else "-",
            e.get("compared", "-"), e.get("failed", "-")))
    md = "\n".join(lines) + "\n"
    if args.pdfium_cli:
        md += "\n**total FAIL pages: %d** (side-by-side PNGs under <paper>/diffs/)\n" % total_fail
    else:
        md += "\n(pdfium side skipped: pass --pdfium-cli to compare)\n"
    if args.text:
        md += text_report_md(report, total_text_check, args.text_flag_pt)
    with open(os.path.join(args.out, "report.md"), "w", encoding="utf-8") as f:
        f.write(md)
    print(md)
    sys.exit(1 if total_fail else 0)


if __name__ == "__main__":
    main()
