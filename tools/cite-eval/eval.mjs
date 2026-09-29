// Accuracy harness for src/lib/citeParse.ts.
//
//   node tools/cite-eval/eval.mjs [--entries DIR]... [--gold FILE] [--report FILE] [--sample N]
//
// * Bundles citeParse.ts (+ venueMap.ts / venues.json) with the repo's esbuild
//   into a temp .mjs and imports it — no ts-node/tsx needed.
// * Reads every *.jsonl under each --entries dir (default: tools/cite-eval/entries,
//   written by the Rust extractor; tools/cite-eval/pdfjs-refs.mjs writes the
//   same shape from pdf.js). Lines look like {"paper"?, "entry": {"text", "kind"}}.
//   Only kind === "reference" is parsed.
// * Prints per-paper parse counts (confidence >= 0.5) and venue-known rate.
// * Scores the hand-labelled gold set (gold.jsonl: {text, author, title, venue, year};
//   venue may be a string or an array of accepted short forms, "" = entry has no venue).
// * Writes report.md: per-paper table, gold accuracy, sample parse table.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

const args = process.argv.slice(2);
const opt = (name, def) => {
  const vals = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name) vals.push(args[i + 1]);
  return vals.length ? vals : def;
};
const entryDirs = opt("--entries", [path.join(here, "entries")]);
const goldFile = opt("--gold", [path.join(here, "gold.jsonl")])[0];
const reportFile = opt("--report", [path.join(here, "report.md")])[0];
const samplePer = parseInt(opt("--sample", ["4"])[0], 10);
const verbose = args.includes("--verbose");

// ── build ──────────────────────────────────────────────────────────────────
const esbuild = await import(pathToFileURL(path.join(root, "node_modules/esbuild/lib/main.js")).href);
const outFile = path.join(os.tmpdir(), `hyji-citeparse-${process.pid}.mjs`);
await (esbuild.build ?? esbuild.default.build)({
  entryPoints: [path.join(root, "src/lib/citeParse.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
  logLevel: "error",
});
const { parseCitation } = await import(pathToFileURL(outFile).href);
fs.rmSync(outFile, { force: true });

// ── helpers ────────────────────────────────────────────────────────────────
const readJsonl = (f) =>
  fs
    .readFileSync(f, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        console.warn(`${path.basename(f)}:${i + 1}: bad JSON`);
        return null;
      }
    })
    .filter(Boolean);
const fold = (s) =>
  String(s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "")
    .toLowerCase();
const alnum = (s) => fold(s).replace(/[^a-z0-9]+/g, "");
const md = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "–");

// ── corpus ─────────────────────────────────────────────────────────────────
const papers = [];
for (const dir of entryDirs) {
  if (!fs.existsSync(dir)) {
    console.log(`(no entries dir ${path.relative(root, dir)})`);
    continue;
  }
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
    const rows = readJsonl(path.join(dir, f)).filter((r) => (r.entry?.kind ?? r.kind) === "reference");
    // extractor rows are per in-text citation, so the same entry repeats — score unique entries
    const texts = [
      ...new Set(rows.map((r) => r.entry?.text ?? r.text).filter((t) => typeof t === "string" && t.trim())),
    ];
    papers.push({ slug: f.replace(/\.jsonl$/, ""), dir, texts });
  }
}

const perPaper = [];
let totN = 0;
let totOk = 0;
let totKnown = 0;
let totVenue = 0;
const samples = [];
for (const p of papers) {
  let ok = 0;
  let known = 0;
  let withVenue = 0;
  const parsed = p.texts.map((t) => ({ t, r: parseCitation(t) }));
  for (const { r } of parsed) {
    if (r.confidence >= 0.5) ok++;
    if (r.venueRaw) withVenue++;
    if (r.venueKnown) known++;
  }
  totN += parsed.length;
  totOk += ok;
  totKnown += known;
  totVenue += withVenue;
  perPaper.push({ slug: p.slug, n: parsed.length, ok, known, withVenue });
  const step = Math.max(1, Math.floor(parsed.length / Math.max(1, samplePer)));
  for (let i = 0; i < parsed.length && samples.filter((s) => s.slug === p.slug).length < samplePer; i += step) {
    samples.push({ slug: p.slug, ...parsed[i] });
  }
}

console.log("paper".padEnd(62), "refs", " ok>=.5", " venueKnown");
for (const r of perPaper) {
  console.log(r.slug.slice(0, 61).padEnd(62), String(r.n).padStart(4), pct(r.ok, r.n).padStart(7), pct(r.known, r.n).padStart(11));
}
console.log(`TOTAL ${papers.length} papers, ${totN} refs: conf>=0.5 ${pct(totOk, totN)}, venue found ${pct(totVenue, totN)}, venue known ${pct(totKnown, totN)}`);

// ── gold ───────────────────────────────────────────────────────────────────
// Groups: "fixtures" (hand-written per style), "tuning" (reviewed real entries the
// parser was iterated on), "heldout" (reviewed afterwards, never tuned against).
const gold = fs.existsSync(goldFile) ? readJsonl(goldFile) : [];
const groupOf = (g) => g.review ?? "fixtures";
const FIELDS = ["author", "year", "title", "venue", "known", "all"];
function score(rows) {
  const acc = Object.fromEntries(FIELDS.map((k) => [k, [0, 0]]));
  const fails = [];
  for (const g of rows) {
    const r = parseCitation(g.text);
    const res = {};
    res.author = fold(r.firstAuthorSurname) === fold(g.author);
    res.title = alnum(r.title) === alnum(g.title);
    res.year = r.year === String(g.year ?? "");
    const hasVenue = g.venue !== "" && g.venue != null;
    const want = Array.isArray(g.venue) ? g.venue : [g.venue ?? ""];
    res.venue = hasVenue ? want.some((w) => fold(w) === fold(r.venueShort)) : true;
    for (const k of ["author", "title", "year"]) {
      acc[k][1]++;
      if (res[k]) acc[k][0]++;
    }
    if (hasVenue) {
      acc.venue[1]++;
      if (res.venue) acc.venue[0]++;
      if (g.known !== undefined) {
        acc.known[1]++;
        if (r.venueKnown === g.known) acc.known[0]++;
      }
    }
    acc.all[1]++;
    if (res.author && res.title && res.year && res.venue) acc.all[0]++;
    else fails.push({ g, r, res });
  }
  return { acc, fails };
}
const groups = ["fixtures", "tuning", "heldout"].filter((k) => gold.some((g) => groupOf(g) === k));
const scored = Object.fromEntries([["all", score(gold)], ...groups.map((k) => [k, score(gold.filter((g) => groupOf(g) === k))])]);
const knownRate = (rows) => {
  const v = rows.filter((g) => g.venue !== "" && g.venue != null);
  return [v.filter((g) => g.known === true).length, v.length];
};
if (gold.length) {
  console.log(`
GOLD (${gold.length} entries, ${path.relative(root, goldFile)})`);
  console.log(`  ${"group".padEnd(9)} ${"n".padStart(4)}  ${FIELDS.map((k) => k.padStart(13)).join("")}`);
  for (const [name, { acc }] of Object.entries(scored)) {
    const n = name === "all" ? gold.length : gold.filter((g) => groupOf(g) === name).length;
    console.log(`  ${name.padEnd(9)} ${String(n).padStart(4)}  ${FIELDS.map((k) => `${acc[k][0]}/${acc[k][1]} ${pct(acc[k][0], acc[k][1])}`.padStart(13)).join("")}`);
  }
  const [kn, kd] = knownRate(gold);
  console.log(`  venue-known rate (gold, entries with a venue): ${kn}/${kd} ${pct(kn, kd)}`);
  for (const f of scored.all.fails.slice(0, verbose ? 999 : 25)) {
    const bad = Object.entries(f.res).filter(([, v]) => !v).map(([k]) => k);
    console.log(`  ✗ [${bad.join(",")}] ${f.g.text.slice(0, 110)}`);
    for (const k of bad) {
      const got = { author: f.r.firstAuthorSurname, title: f.r.title, year: f.r.year, venue: `${f.r.venueShort} ← "${f.r.venueRaw}"` }[k];
      console.log(`      ${k}: got ${JSON.stringify(got)} want ${JSON.stringify(f.g[k])}`);
    }
  }
}

// ── report ─────────────────────────────────────────────────────────────────
const L = [];
L.push("# citeParse evaluation", "");
L.push(`Generated by \`node tools/cite-eval/eval.mjs\` on ${new Date().toISOString().slice(0, 10)}.`, "");
L.push(`Entry sources: ${entryDirs.map((d) => `\`${path.relative(root, d) || d}\``).join(", ")}`, "");
L.push("## Corpus", "");
L.push(`${papers.length} papers, ${totN} reference entries — confidence ≥ 0.5: **${pct(totOk, totN)}**, venue found: ${pct(totVenue, totN)}, venue matched to venues.json: **${pct(totKnown, totN)}**.`, "");
L.push("| paper | refs | conf ≥ 0.5 | venue known |", "|---|---:|---:|---:|");
for (const r of perPaper) L.push(`| ${md(r.slug)} | ${r.n} | ${r.ok} (${pct(r.ok, r.n)}) | ${pct(r.known, r.n)} |`);
L.push("");
if (gold.length) {
  L.push(`## Gold set (${gold.length} hand-labelled entries, \`${path.relative(root, goldFile)}\`)`, "");
  L.push("Groups: **fixtures** = hand-written entries per citation style; **tuning** = reviewed real entries the parser was iterated on; **heldout** = a fresh sample reviewed only after tuning (its review prompted two small fixes: displaced-accent cleanup and one-word last authors).", "");
  L.push(`| group | n | ${FIELDS.join(" | ")} |`, `|---|---:|${FIELDS.map(() => "---:").join("|")}|`);
  for (const [name, { acc }] of Object.entries(scored)) {
    const n = name === "all" ? gold.length : gold.filter((g) => groupOf(g) === name).length;
    L.push(`| ${name} | ${n} | ${FIELDS.map((k) => `${acc[k][0]}/${acc[k][1]} (${pct(acc[k][0], acc[k][1])})`).join(" | ")} |`);
  }
  const [kn, kd] = knownRate(gold);
  L.push("", `"venue" counts only entries that have a venue; "known" = the venueKnown flag agrees with the label. Venue-known rate over gold entries with a venue: **${kn}/${kd} (${pct(kn, kd)})**.`, "");
  const fails = scored.all.fails;
  if (fails.length) {
    L.push("### Gold misses", "");
    L.push("| field | entry | got | want |", "|---|---|---|---|");
    for (const f of fails) {
      for (const [k, v] of Object.entries(f.res)) {
        if (v) continue;
        const got = { author: f.r.firstAuthorSurname, title: f.r.title, year: f.r.year, venue: f.r.venueShort }[k];
        L.push(`| ${k} | ${md(f.g.text.slice(0, 90))}… | ${md(got)} | ${md(Array.isArray(f.g[k]) ? f.g[k].join(" / ") : f.g[k])} |`);
      }
    }
    L.push("");
  }
}
L.push("## Sample parses", "");
L.push("| paper | label | first author | short | title | venue short | known | year | conf |", "|---|---|---|---|---|---|---|---|---:|");
for (const s of samples) {
  const r = s.r;
  L.push(`| ${md(s.slug.slice(0, 28))} | ${md(r.label ?? "")} | ${md(r.firstAuthorSurname)} | ${md(r.authorShort)} | ${md(r.title.slice(0, 80))} | ${md(r.venueShort)} | ${r.venueKnown ? "✓" : ""} | ${md(r.year)} | ${r.confidence.toFixed(2)} |`);
}
L.push("");
fs.writeFileSync(reportFile, L.join("\n"));
console.log(`\nreport → ${path.relative(root, reportFile)}`);
