#!/usr/bin/env python
"""Loop the corpus: render a page sample with pdf.js (A) and, when
--pdfium-cli is given, with PDFium (B), then run compare.py on each pair.

Page sample per PDF: first 3 pages + 2 evenly spaced interior pages + last
page (deduplicated, clipped to the page count). Width 1070 px (the viewer's
fit-width at the default layout).

usage: run-all.py [--corpus corpus.json] [--out <dir>] [--width 1070]
                  [--pdfium-cli <exe>] [--pdfium-args "<template>"] [--only <substring>]
                  [--pages 0,1|all]

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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", default=os.path.join(HERE, "corpus.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "out"))
    ap.add_argument("--width", type=int, default=1070)
    ap.add_argument("--pdfium-cli", default=None)
    ap.add_argument("--pdfium-args", default="--pdf {pdf} --pages {pages} --width {width} --out {out}")
    ap.add_argument("--only", default=None, help="only PDFs whose title/path contains this substring")
    ap.add_argument("--pages", default=None, help="override the sample, e.g. 0,1 or all")
    args = ap.parse_args()

    with open(args.corpus, encoding="utf-8") as f:
        corpus = json.load(f)
    if args.only:
        corpus = [c for c in corpus if args.only.lower() in (c["title"] + c["pdf"]).lower()]
    os.makedirs(args.out, exist_ok=True)
    renderer = os.path.join(HERE, "render-pdfjs.mjs")
    report = []
    total_fail = 0
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
    with open(os.path.join(args.out, "report.md"), "w", encoding="utf-8") as f:
        f.write(md)
    print(md)
    sys.exit(1 if total_fail else 0)


if __name__ == "__main__":
    main()
