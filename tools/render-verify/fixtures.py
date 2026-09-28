#!/usr/bin/env python
"""Generate synthetic test PDFs for the categories the real library lacks
(rotation, CropBox, UserUnit, markup annotations, scanned page, mixed page
sizes), derived from the G2P paper with pypdf. Writes them to
tools/render-verify/fixtures/ (gitignored) and appends them to corpus.json
(entries with id "fixture:<name>"; existing fixture entries are replaced).

Fixtures:
  g2p-rotate90.pdf        /Rotate 90 on every page
  g2p-rotate270.pdf       /Rotate 270 on every page
  g2p-cropbox.pdf         CropBox inset 40 pt on each side, MediaBox unchanged
  g2p-cropbox-offset.pdf  MediaBox [0 0 612 792], CropBox [50 60 500 700]
  g2p-userunit.pdf        /UserUnit 2 on page 1
  g2p-annots.pdf          /Highlight, /Underline, /StrikeOut, /Text with appearance
                          streams built exactly like src/lib/pdfAnnotExport.ts
                          (QuadPoints + /AP /N form XObject, Multiply ExtGState for
                          the fill); the /Text note gets a simple drawn icon AP
  g2p-scan.pdf            page 1 rasterised at 150 dpi by render-pdfjs.mjs and
                          wrapped as an image-only page (Pillow PDF writer)
  g2p-mixed-size.pdf      3 pages: A4 portrait, Letter portrait, Letter landscape
                          (pages 1-3 of G2P scaled with pypdf)

usage: fixtures.py [--source <pdf>] [--out fixtures/] [--corpus corpus.json]
"""
import argparse
import io
import json
import os
import subprocess
import sys
import tempfile

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject,
                           NumberObject, TextStringObject)

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SOURCE = r"C:\Users\KIST_VIG\Downloads\papers\2606\G2P Gaussian-to-Point Attribute Alignment for Boundary-Aware 3D Semantic Segmentation.pdf"


def copy_all(src):
    r = PdfReader(src)
    w = PdfWriter()
    for p in r.pages:
        w.add_page(p)
    return r, w


def save(w, path):
    with open(path, "wb") as f:
        w.write(f)
    return len(PdfReader(path).pages)


def fx_rotate(src, out, deg):
    _, w = copy_all(src)
    for p in w.pages:
        p[NameObject("/Rotate")] = NumberObject(deg)
    return save(w, out)


def fx_cropbox(src, out, box=None, inset=None):
    _, w = copy_all(src)
    for p in w.pages:
        mb = p.mediabox
        if inset is not None:
            cb = [float(mb.left) + inset, float(mb.bottom) + inset, float(mb.right) - inset, float(mb.top) - inset]
        else:
            cb = box
        p[NameObject("/CropBox")] = ArrayObject([FloatObject(v) for v in cb])
    return save(w, out)


def fx_userunit(src, out):
    _, w = copy_all(src)
    w.pages[0][NameObject("/UserUnit")] = FloatObject(2)
    return save(w, out)


def _form_xobject(w, ops, bbox, resources):
    s = DecodedStreamObject()
    s.set_data(ops.encode("latin1"))
    s[NameObject("/Type")] = NameObject("/XObject")
    s[NameObject("/Subtype")] = NameObject("/Form")
    s[NameObject("/FormType")] = NumberObject(1)
    s[NameObject("/BBox")] = ArrayObject([FloatObject(v) for v in bbox])
    s[NameObject("/Resources")] = resources
    return w._add_object(s)


def _markup(w, subtype, quads_rects, rgb, contents=None):
    """Mirror of pdfAnnotExport.ts: one annotation per (subtype, rect list).
    quads_rects: list of (x1, yBot, x2, yTop) in PDF user space."""
    cr, cg, cb = rgb
    quads, fill_ops, stroke_ops = [], ["/G0 gs", "%.4f %.4f %.4f rg" % rgb], ["%.4f %.4f %.4f RG" % rgb]
    minx = miny = float("inf")
    maxx = maxy = float("-inf")
    for x1, yb, x2, yt in quads_rects:
        quads += [x1, yt, x2, yt, x1, yb, x2, yb]  # UL, UR, LL, LR
        if subtype == "Highlight":
            fill_ops.append("%.2f %.2f %.2f %.2f re" % (x1, yb, x2 - x1, yt - yb))
        else:
            h = yt - yb
            lw = max(0.7, h * 0.07)
            y = yb + lw / 2 if subtype == "Underline" else (yb + yt) / 2
            stroke_ops += ["%.2f w" % lw, "%.2f %.2f m" % (x1, y), "%.2f %.2f l" % (x2, y), "S"]
        minx, maxx, miny, maxy = min(minx, x1), max(maxx, x2), min(miny, yb), max(maxy, yt)
    fill_ops.append("f")
    rect = [minx, miny, maxx, maxy]
    if subtype == "Highlight":
        gs = DictionaryObject({NameObject("/Type"): NameObject("/ExtGState"), NameObject("/BM"): NameObject("/Multiply"),
                               NameObject("/CA"): NumberObject(1), NameObject("/ca"): NumberObject(1)})
        res = DictionaryObject({NameObject("/ExtGState"): DictionaryObject({NameObject("/G0"): gs})})
        ops = "\n".join(fill_ops)
    else:
        res = DictionaryObject()
        ops = "\n".join(stroke_ops)
    ap = _form_xobject(w, ops, rect, res)
    a = DictionaryObject({
        NameObject("/Type"): NameObject("/Annot"),
        NameObject("/Subtype"): NameObject("/" + subtype),
        NameObject("/Rect"): ArrayObject([FloatObject(v) for v in rect]),
        NameObject("/QuadPoints"): ArrayObject([FloatObject(v) for v in quads]),
        NameObject("/C"): ArrayObject([FloatObject(v) for v in rgb]),
        NameObject("/CA"): NumberObject(1),
        NameObject("/F"): NumberObject(4),
        NameObject("/Border"): ArrayObject([NumberObject(0)] * 3),
        NameObject("/AP"): DictionaryObject({NameObject("/N"): ap}),
        NameObject("/T"): TextStringObject("render-verify"),
    })
    if contents:
        a[NameObject("/Contents")] = TextStringObject(contents)
    return w._add_object(a)


def _text_note(w, x, y, contents):
    """/Text (sticky note) with a drawn 20x20 icon AP so both renderers have
    the same appearance to draw (without AP, pdf.js and PDFium synthesize
    their own icons)."""
    rect = [x, y, x + 20, y + 20]
    ops = "\n".join(["1 0.85 0.2 rg 0.4 0.3 0 RG 1 w",
                     "%.2f %.2f 20 20 re B" % (x, y),
                     "%.2f %.2f m %.2f %.2f l S" % (x + 4, y + 14, x + 16, y + 14),
                     "%.2f %.2f m %.2f %.2f l S" % (x + 4, y + 10, x + 16, y + 10),
                     "%.2f %.2f m %.2f %.2f l S" % (x + 4, y + 6, x + 12, y + 6)])
    ap = _form_xobject(w, ops, rect, DictionaryObject())
    a = DictionaryObject({
        NameObject("/Type"): NameObject("/Annot"),
        NameObject("/Subtype"): NameObject("/Text"),
        NameObject("/Rect"): ArrayObject([FloatObject(v) for v in rect]),
        NameObject("/Contents"): TextStringObject(contents),
        NameObject("/Name"): NameObject("/Comment"),
        NameObject("/F"): NumberObject(4),
        NameObject("/C"): ArrayObject([FloatObject(1), FloatObject(0.85), FloatObject(0.2)]),
        NameObject("/AP"): DictionaryObject({NameObject("/N"): ap}),
        NameObject("/T"): TextStringObject("render-verify"),
    })
    return w._add_object(a)


def fx_annots(src, out):
    _, w = copy_all(src)
    p = w.pages[0]
    mb = p.mediabox
    W, H = float(mb.width), float(mb.height)
    # Rows in the left column (abstract) and right column (caption) of a
    # 2-column paper page, expressed as fractions of the page so they land on
    # text for any Letter/A4 source.
    def row(x0, x1, y_from_top, h=11):
        return (x0 * W, H - (y_from_top + h), x1 * W, H - y_from_top)
    annots = [
        _markup(w, "Highlight", [row(0.095, 0.48, 0.40 * H), row(0.095, 0.48, 0.40 * H + 12)], (1.0, 0.82, 0.4)),
        _markup(w, "Highlight", [row(0.52, 0.90, 0.53 * H)], (0.35, 0.65, 1.0)),
        _markup(w, "Underline", [row(0.095, 0.48, 0.47 * H)], (0.02, 0.84, 0.63)),
        _markup(w, "StrikeOut", [row(0.52, 0.90, 0.58 * H)], (1.0, 0.42, 0.62), contents="strikeout with a memo"),
        _text_note(w, 0.03 * W, H - 0.40 * H - 20, "sticky note comment"),
    ]
    p[NameObject("/Annots")] = ArrayObject(annots)
    return save(w, out)


def fx_scan(src, out):
    from PIL import Image
    tmp = tempfile.mkdtemp(prefix="rv-scan-")
    r = PdfReader(src)
    W = float(r.pages[0].mediabox.width)
    px = int(round(W / 72 * 150))
    subprocess.run(["node", os.path.join(HERE, "render-pdfjs.mjs"), "--pdf", src, "--pages", "0",
                    "--width", str(px), "--out", tmp], cwd=REPO, check=True, capture_output=True)
    im = Image.open(os.path.join(tmp, "page-0000.png")).convert("RGB")
    im.save(out, "PDF", resolution=150.0)
    return len(PdfReader(out).pages)


def fx_mixed(src, out):
    r = PdfReader(src)
    w = PdfWriter()
    sizes = [(595.276, 841.89), (612, 792), (792, 612)]  # A4, Letter, Letter landscape
    for i, (pw, ph) in enumerate(sizes):
        p = r.pages[i]
        p.scale_to(pw, ph)
        w.add_page(p)
    return save(w, out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default=SOURCE)
    ap.add_argument("--out", default=os.path.join(HERE, "fixtures"))
    ap.add_argument("--corpus", default=os.path.join(HERE, "corpus.json"))
    args = ap.parse_args()
    if not os.path.exists(args.source):
        sys.exit("source PDF not found: %s" % args.source)
    os.makedirs(args.out, exist_ok=True)

    builders = [
        ("g2p-rotate90.pdf", "fixture: /Rotate 90 on every page", lambda o: fx_rotate(args.source, o, 90),
         {"rotate": True}),
        ("g2p-rotate270.pdf", "fixture: /Rotate 270 on every page", lambda o: fx_rotate(args.source, o, 270),
         {"rotate": True}),
        ("g2p-cropbox.pdf", "fixture: CropBox inset 40 pt, MediaBox unchanged", lambda o: fx_cropbox(args.source, o, inset=40),
         {"cropbox": True}),
        ("g2p-cropbox-offset.pdf", "fixture: CropBox [50 60 500 700] with non-zero origin",
         lambda o: fx_cropbox(args.source, o, box=[50, 60, 500, 700]), {"cropbox": True}),
        ("g2p-userunit.pdf", "fixture: /UserUnit 2 on page 1", lambda o: fx_userunit(args.source, o), {}),
        ("g2p-annots.pdf", "fixture: Highlight/Underline/StrikeOut/Text annots with AP streams (pdfAnnotExport.ts layout)",
         lambda o: fx_annots(args.source, o), {"annots": True}),
        ("g2p-scan.pdf", "fixture: image-only page (page 1 rasterised at 150 dpi)", lambda o: fx_scan(args.source, o),
         {"scanned": True}),
        ("g2p-mixed-size.pdf", "fixture: A4 / Letter / Letter-landscape pages", lambda o: fx_mixed(args.source, o), {}),
    ]
    entries = []
    for name, reason, build, feats in builders:
        path = os.path.join(args.out, name)
        try:
            pages = build(path)
        except Exception as e:  # keep going; report at the end
            print("FAILED %s: %s" % (name, e), file=sys.stderr)
            continue
        size = os.path.getsize(path)
        features = {"cjk": False, "rotate": False, "cropbox": False, "annots": False, "scanned": False}
        features.update(feats)
        entries.append({"id": "fixture:" + os.path.splitext(name)[0], "title": name, "pdf": path, "pages": pages,
                        "size": size, "features": features, "reasons": [reason]})
        print("%-24s %2d pages  %6.1f KB  %s" % (name, pages, size / 1024, reason))

    corpus = []
    if os.path.exists(args.corpus):
        with open(args.corpus, encoding="utf-8") as f:
            corpus = [c for c in json.load(f) if not str(c.get("id", "")).startswith("fixture:")]
    corpus += entries
    with open(args.corpus, "w", encoding="utf-8") as f:
        json.dump(corpus, f, indent=2, ensure_ascii=False)
    print("corpus.json: %d entries (%d fixtures)" % (len(corpus), len(entries)))


if __name__ == "__main__":
    main()
