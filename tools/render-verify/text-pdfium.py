#!/usr/bin/env python
"""Adapter: dump PDFium text geometry per page -> <out>/text-NNNN.json

  text-pdfium.py --pdf <file> --pages 0,1,5|all --out <dir> [--exe <pdfium-spike.exe>]

Calls  <exe> text <pdf> <page> <out>/text-NNNN.json  per page (the `text`
subcommand added to the pdfium spike). Each JSON holds every character of
FPDFText with, in DISPLAY points (top-left origin, CropBox + /Rotate applied,
i.e. the same frame as text-pdfjs.mjs):
  x,y,w,h      tight glyph box (FPDFText_GetCharBox)
  lx,ly,lw,lh  loose box (FPDFText_GetLooseCharBox: font ascent/descent, advance)
  ox,oy        glyph origin (baseline point)
  fs           scaled font size,  gen  true for pdfium-synthesised chars
The same --exe / PDFIUM_SPIKE override as pdfium-cli.py applies.
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from importlib import import_module  # noqa: E402

_cli = import_module("pdfium-cli")
DEFAULT_EXE = _cli.DEFAULT_EXE
page_count = _cli.page_count


def dump_pages(pdf, pages, out, exe=None):
    """Run the spike's text subcommand for each page. Returns (results, failed)."""
    exe = exe or os.environ.get("PDFIUM_SPIKE", DEFAULT_EXE)
    if not os.path.exists(exe):
        raise FileNotFoundError("pdfium spike not found: %s" % exe)
    os.makedirs(out, exist_ok=True)
    results, failed = [], 0
    for idx in pages:
        out_json = os.path.join(out, "text-%04d.json" % idx)
        r = subprocess.run([exe, "text", pdf, str(idx), out_json],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        ok = r.returncode == 0 and os.path.exists(out_json)
        entry = {"page": idx, "rc": r.returncode, "stdout": r.stdout.strip()}
        if not ok:
            failed += 1
            entry["error"] = (r.stderr or r.stdout).strip()[-500:]
            print("page %d: FAILED rc=%s %s" % (idx, r.returncode, entry["error"]), file=sys.stderr)
        else:
            print(r.stdout.strip())
        results.append(entry)
    with open(os.path.join(out, "text-pdfium.json"), "w", encoding="utf-8") as f:
        json.dump({"pdf": os.path.abspath(pdf), "exe": exe, "pages": results}, f, indent=2)
    return results, failed


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--pages", default="0")
    ap.add_argument("--out", required=True)
    ap.add_argument("--exe", default=None)
    args = ap.parse_args()
    if args.pages == "all":
        pages = list(range(page_count(args.pdf)))
    else:
        pages = [int(p) for p in args.pages.split(",") if p.strip()]
    _, failed = dump_pages(args.pdf, pages, args.out, args.exe)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
