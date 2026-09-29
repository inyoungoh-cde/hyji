// Fallback reference extractor (pdf.js, Node) so the parser can be evaluated
// before/independently of the Rust extractor. Writes the same JSONL shape:
//   {"paper": "...", "index": n, "entry": {"text": "...", "kind": "reference"}}
// Usage: node tools/cite-eval/pdfjs-refs.mjs <outDir> <pdf> [<pdf> ...]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const pdfjs = await import(pathToFileURL(path.join(root, "node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href);

const [outDir, ...pdfs] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });

function linesOfPage(items, pageWidth) {
  const its = items
    .filter((i) => i.str !== undefined)
    .map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: Math.abs(i.transform[3]) || i.height }))
    .filter((i) => i.s.length > 0);
  its.sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x));
  const lines = [];
  for (const it of its) {
    const last = lines.find((l) => Math.abs(l.y - it.y) <= 2 && it.x >= l.xEnd - 1 && it.x - l.xEnd < 12);
    if (last) {
      const gap = it.x - last.xEnd;
      last.s += (gap > 0.8 && !last.s.endsWith(" ") && !it.s.startsWith(" ") ? " " : "") + it.s;
      last.xEnd = it.x + it.w;
      last.h = Math.max(last.h, it.h);
    } else if (it.s.trim()) {
      lines.push({ s: it.s, x: it.x, xEnd: it.x + it.w, y: it.y, h: it.h });
    }
  }
  const mid = pageWidth / 2;
  for (const l of lines) l.col = l.x < mid - 10 ? 0 : 1;
  lines.sort((a, b) => (a.col !== b.col ? a.col - b.col : b.y - a.y));
  return lines.filter((l) => l.s.trim());
}

function splitEntries(lines) {
  const texts = lines.map((l) => l.s.trim());
  const bracket = texts.filter((t) => /^\[\d{1,3}\]/.test(t)).length;
  const dotnum = texts.filter((t) => /^\d{1,3}\.\s+\S/.test(t)).length;
  const starts = [];
  if (bracket >= 5) lines.forEach((l, i) => { if (/^\[\d{1,3}\]/.test(texts[i])) starts.push(i); });
  else if (dotnum >= 5) lines.forEach((l, i) => { if (/^\d{1,3}\.\s+\S/.test(texts[i])) starts.push(i); });
  else {
    // hanging indent: per column, the min x starts an entry
    const pageKey = (l) => `${l.page}:${l.col}`;
    const mins = new Map();
    for (const l of lines) mins.set(pageKey(l), Math.min(mins.get(pageKey(l)) ?? Infinity, l.x));
    lines.forEach((l, i) => { if (Math.abs(l.x - mins.get(pageKey(l))) < 2) starts.push(i); });
  }
  const out = [];
  for (let k = 0; k < starts.length; k++) {
    const seg = lines.slice(starts[k], starts[k + 1] ?? lines.length);
    let s = "";
    for (const l of seg) {
      const t = l.s.trim();
      if (!s) s = t;
      else if (/[A-Za-z]-$/.test(s) && /^[a-z]/.test(t)) s = s.slice(0, -1) + t;
      else s += " " + t;
    }
    if (s.length > 15 && s.length < 1200) out.push(s.replace(/\s+/g, " "));
  }
  return out;
}

for (const pdf of pdfs) {
  const slug = path.basename(pdf, ".pdf").replace(/[^A-Za-z0-9]+/g, "-").slice(0, 60);
  try {
    const data = new Uint8Array(fs.readFileSync(pdf));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
    const all = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      for (const l of linesOfPage(tc.items, vp.width)) all.push({ ...l, page: p });
      page.cleanup();
    }
    await doc.destroy();
    let start = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      if (/^(\d+\.?\s*)?(references|bibliography|reference|literature cited)\s*$/i.test(all[i].s.trim())) { start = i; break; }
    }
    if (start < 0) { console.log(`${slug}: no references heading`); continue; }
    let end = all.length;
    for (let i = start + 1; i < all.length; i++) {
      const t = all[i].s.trim();
      if (/^(appendix|supplementary|a\s+appendix|checklist|neurips paper checklist)\b/i.test(t) && t.length < 60) { end = i; break; }
    }
    const refLines = all.slice(start + 1, end).filter((l) => !/^\d{1,4}$/.test(l.s.trim()));
    const entries = splitEntries(refLines);
    const out = entries.map((text, index) => JSON.stringify({ paper: slug, index, entry: { text, kind: "reference" } }));
    fs.writeFileSync(path.join(outDir, `${slug}.jsonl`), out.join("\n") + "\n");
    console.log(`${slug}: ${entries.length}`);
  } catch (e) {
    console.log(`${slug}: ERROR ${e.message}`);
  }
}
