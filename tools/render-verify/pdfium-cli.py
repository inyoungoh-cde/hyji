#!/usr/bin/env python
"""Adapter: run-all.py's PDFium contract -> the one-page-per-call pdfium spike.

  pdfium-cli.py --pdf <file> --pages 0,1,5|all --width 1070 --out <dir> [--exe <pdfium-spike.exe>]

Calls  <exe> <pdf> <page> <width> <out>/page-NNNN.png --annot --time  per page
(--annot always on: annotation appearance streams are rendered, matching
pdf.js AnnotationMode.ENABLE on side A). Writes <out>/render-pdfium.json with
the spike's stdout per page. Exit 1 if any page failed.

Use with run-all.py:
  python run-all.py --pdfium-cli python --pdfium-args "tools/render-verify/pdfium-cli.py --pdf {pdf} --pages {pages} --width {width} --out {out}"
or simply  --pdfium-cli <path to this file>  (run-all detects .py and runs it with the current interpreter).
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

DEFAULT_EXE = (r"C:\Users\KIST_VIG\AppData\Local\Temp\claude\C--Users-KIST-VIG-Downloads-DEANOH-main-hyji"
               r"\042f5ff7-9bc3-449b-a993-a3416c9c7051\scratchpad\pdfium-spike\target\release\pdfium-spike.exe")


def page_count(pdf):
    try:
        from pypdf import PdfReader
        return len(PdfReader(pdf, strict=False).pages)
    except Exception:
        with open(pdf, "rb") as f:
            data = f.read()
        m = re.findall(rb"/Type\s*/Pages\b[^>]*?/Count\s+(\d+)", data)
        return max(int(x) for x in m) if m else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--pages", default="0")
    ap.add_argument("--width", type=int, default=1070)
    ap.add_argument("--out", required=True)
    ap.add_argument("--exe", default=os.environ.get("PDFIUM_SPIKE", DEFAULT_EXE))
    args = ap.parse_args()
    if not os.path.exists(args.exe):
        sys.exit("pdfium spike not found: %s" % args.exe)
    os.makedirs(args.out, exist_ok=True)

    if args.pages == "all":
        pages = list(range(page_count(args.pdf)))
    else:
        pages = [int(p) for p in args.pages.split(",") if p.strip()]

    results = []
    failed = 0
    for idx in pages:
        out_png = os.path.join(args.out, "page-%04d.png" % idx)
        t = time.time()
        r = subprocess.run([args.exe, args.pdf, str(idx), str(args.width), out_png, "--annot", "--time"],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        ms = (time.time() - t) * 1000
        info = r.stdout.strip()
        m = re.search(r"bitmap=(\d+)x(\d+)", info)
        ok = r.returncode == 0 and os.path.exists(out_png)
        entry = {"page": idx, "ms": round(ms), "rc": r.returncode, "stdout": info}
        if m:
            entry.update(width=int(m.group(1)), height=int(m.group(2)))
        if not ok:
            failed += 1
            entry["error"] = (r.stderr or r.stdout).strip()[-500:]
            print("page %d: FAILED rc=%s %s" % (idx, r.returncode, entry["error"]), file=sys.stderr)
        else:
            print("page %d: %s %.0f ms -> %s" % (idx, "%sx%s" % (m.group(1), m.group(2)) if m else "?", ms,
                                                 os.path.basename(out_png)))
        results.append(entry)

    with open(os.path.join(args.out, "render-pdfium.json"), "w", encoding="utf-8") as f:
        json.dump({"pdf": os.path.abspath(args.pdf), "exe": args.exe, "width": args.width, "pages": results}, f, indent=2)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
