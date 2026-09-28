#!/usr/bin/env python
"""Pick a diverse test corpus from the user's real HYJI library.

Copies the live SQLite DB to a temp file first (the running app holds the
WAL/lock), opens the copy read-only, resolves each paper's pdf_path, and
classifies every PDF that exists on disk:

  cjk        CIDFont / Adobe-Korea1 / Adobe-Japan1 / Adobe-GB1 / Adobe-CNS1 / UniKS / UniJIS markers
  rotate     any page with a non-zero /Rotate
  cropbox    any page whose CropBox differs from its MediaBox
  annots     existing /Annots of subtype Highlight / Underline / StrikeOut / Squiggly / Text
  scanned    a page with an /Image XObject and very little text
  smallest / largest by file size, plus random fillers up to --n (default 12)

Always includes the G2P paper when present. Writes corpus.json:
  [{"id","title","pdf","pages","size","features",{...},"reasons":[...]}]

usage: corpus.py [--db <hyji.db>] [--out corpus.json] [--n 12] [--seed 1]
Page features are read with pypdf when installed; otherwise a byte scan
(which cannot detect CropBox != MediaBox reliably and reports it as null).
"""
import argparse
import json
import os
import random
import re
import shutil
import sqlite3
import sys
import tempfile

DEFAULT_DB = os.path.join(os.environ.get("APPDATA", ""), "com.hyji.app", "hyji.db")
ALWAYS = [
    r"C:\Users\KIST_VIG\Downloads\papers\2606\G2P Gaussian-to-Point Attribute Alignment for Boundary-Aware 3D Semantic Segmentation.pdf",
]
CJK_MARKERS = [b"/CIDFontType0", b"/CIDFontType2", b"Adobe-Korea1", b"Adobe-Japan1", b"Adobe-GB1", b"Adobe-CNS1",
               b"UniKS-", b"UniJIS-", b"UniGB-", b"UniCNS-", b"/KSCms-", b"/90ms-RKSJ"]
MARKUP_ANNOTS = (b"/Highlight", b"/Underline", b"/StrikeOut", b"/Squiggly", b"/Text")
MAX_PAGES_INSPECTED = 60  # enough to characterise; huge proceedings volumes are slow with pypdf

try:
    from pypdf import PdfReader
except Exception:
    PdfReader = None


def read_papers(db_path):
    tmp = os.path.join(tempfile.gettempdir(), "hyji_corpus_copy.db")
    shutil.copyfile(db_path, tmp)
    wal = db_path + "-wal"
    if os.path.exists(wal):  # carry uncheckpointed pages along so the copy is current
        shutil.copyfile(wal, tmp + "-wal")
    con = sqlite3.connect("file:%s?mode=ro" % tmp.replace("\\", "/"), uri=True)
    folders = {r[0]: r[1] for r in con.execute("SELECT id, COALESCE(folder_path,'') FROM projects")}
    rows = []
    for pid, title, pdf_path, project_id in con.execute("SELECT id, title, pdf_path, project_id FROM papers"):
        if not pdf_path:
            continue
        p = pdf_path
        if not os.path.isabs(p):
            base = folders.get(project_id, "")
            cand = [os.path.join(base, p), os.path.join(base, "pdfs", p)] if base else []
            p = next((c for c in cand if os.path.exists(c)), p)
        rows.append({"id": pid, "title": title, "pdf": p})
    con.close()
    for f in (tmp, tmp + "-wal"):
        try:
            os.remove(f)
        except OSError:
            pass
    return rows


def classify_bytes(data):
    feat = {"cjk": any(m in data for m in CJK_MARKERS),
            "annots": b"/Annots" in data
                      and any(re.search(rb"/Subtype\s*" + re.escape(m) + rb"\b", data) for m in MARKUP_ANNOTS),
            "rotate": bool(re.search(rb"/Rotate\s*(90|180|270|-90)\b", data)),
            "cropbox": None, "scanned": None, "pages": None}
    m = re.findall(rb"/Type\s*/Pages\b[^>]*?/Count\s+(\d+)", data)
    if m:
        feat["pages"] = max(int(x) for x in m)
    return feat


def classify_pypdf(path, feat):
    r = PdfReader(path, strict=False)
    feat["pages"] = len(r.pages)
    rotate = cropbox = annots = scanned = False
    for i, page in enumerate(r.pages):
        if i >= MAX_PAGES_INSPECTED:
            break
        try:
            if int(page.get("/Rotate", 0) or 0) % 360 != 0:
                rotate = True
            mb, cb = page.mediabox, page.cropbox
            if any(abs(float(a) - float(b)) > 0.5 for a, b in zip(mb, cb)):
                cropbox = True
            for a in (page.get("/Annots") or []):
                st = str(a.get_object().get("/Subtype", ""))
                if st in ("/Highlight", "/Underline", "/StrikeOut", "/Squiggly", "/Text"):
                    annots = True
            res = page.get("/Resources") or {}
            xo = res.get("/XObject") if hasattr(res, "get") else None
            has_img = False
            if xo:
                for k in xo.keys():
                    try:
                        if xo[k].get_object().get("/Subtype") == "/Image":
                            has_img = True
                            break
                    except Exception:
                        pass
            if has_img:
                try:
                    txt = page.extract_text() or ""
                except Exception:
                    txt = ""
                if len(txt.strip()) < 40:
                    scanned = True
        except Exception:
            continue
    feat.update(rotate=feat["rotate"] or rotate, cropbox=cropbox, annots=feat["annots"] or annots, scanned=scanned)
    return feat


def classify(path):
    with open(path, "rb") as f:
        data = f.read()
    feat = classify_bytes(data)
    feat["size"] = len(data)
    if PdfReader is not None:
        try:
            feat = classify_pypdf(path, feat)
        except Exception as e:
            feat["error"] = str(e)
    return feat


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "corpus.json"))
    ap.add_argument("--n", type=int, default=12)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    papers = read_papers(args.db) if os.path.exists(args.db) else []
    if not papers:
        print("warning: no papers read from %s" % args.db, file=sys.stderr)
    seen = set()
    cands = []
    for p in papers + [{"id": "always", "title": os.path.splitext(os.path.basename(a))[0], "pdf": a} for a in ALWAYS]:
        key = os.path.normcase(os.path.abspath(p["pdf"]))
        if key in seen or not os.path.exists(p["pdf"]):
            continue
        seen.add(key)
        cands.append(p)
    print("scanning %d PDFs on disk..." % len(cands), file=sys.stderr)
    for p in cands:
        p.update(classify(p["pdf"]))

    chosen = {}

    def pick(p, reason):
        key = os.path.normcase(p["pdf"])
        chosen.setdefault(key, dict(p, reasons=[]))["reasons"].append(reason)

    for p in cands:
        if any(os.path.normcase(p["pdf"]) == os.path.normcase(a) for a in ALWAYS):
            pick(p, "always-include (G2P)")
    by_size = sorted(cands, key=lambda p: p["size"])
    if by_size:
        pick(by_size[0], "smallest file")
        pick(by_size[-1], "largest file")
    for flag, reason in (("cjk", "CJK / CID font markers"), ("rotate", "page with /Rotate"),
                         ("cropbox", "CropBox != MediaBox"), ("annots", "existing markup /Annots"),
                         ("scanned", "image XObject with little text (scanned-like)")):
        hits = [p for p in cands if p.get(flag)]
        if hits:
            # prefer a hit not yet chosen so the corpus stays diverse
            fresh = [p for p in hits if os.path.normcase(p["pdf"]) not in chosen]
            pick((fresh or hits)[0], reason)
        else:
            print("note: no PDF in the library matched '%s'" % reason, file=sys.stderr)
    rng = random.Random(args.seed)
    rest = [p for p in cands if os.path.normcase(p["pdf"]) not in chosen]
    rng.shuffle(rest)
    for p in rest[: max(0, args.n - len(chosen))]:
        pick(p, "random filler")

    out = []
    for c in chosen.values():
        out.append({"id": c["id"], "title": c["title"], "pdf": c["pdf"], "pages": c.get("pages"),
                    "size": c["size"],
                    "features": {k: c.get(k) for k in ("cjk", "rotate", "cropbox", "annots", "scanned")},
                    "reasons": c["reasons"]})
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print("| # | title | pages | size | reasons |")
    print("|---|---|---|---|---|")
    for i, c in enumerate(out):
        print("| %d | %s | %s | %.1f MB | %s |" % (i + 1, (c["title"] or "")[:60], c["pages"], c["size"] / 1048576,
                                                  "; ".join(c["reasons"])))
    print("\nwrote %s (%d PDFs)" % (args.out, len(out)))


if __name__ == "__main__":
    main()
