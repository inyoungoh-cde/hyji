// Debug helper: print parses for one entries file or ad-hoc strings.
//   node tools/cite-eval/inspect.mjs <file.jsonl> [--low] [--from N] [--n N]
//   node tools/cite-eval/inspect.mjs --text "[1] A. Author, “Title,” in CVPR, 2020."
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const esbuild = await import(pathToFileURL(path.join(root, "node_modules/esbuild/lib/main.js")).href);
const outFile = path.join(os.tmpdir(), `hyji-citeparse-inspect-${process.pid}.mjs`);
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

const args = process.argv.slice(2);
const get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
let texts = [];
if (args.includes("--text")) texts = [get("--text")];
else {
  texts = fs
    .readFileSync(args[0], "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((r) => (r.entry?.kind ?? r.kind) === "reference")
    .map((r) => r.entry?.text ?? r.text);
  texts = [...new Set(texts)];
}
const from = parseInt(get("--from", "0"), 10);
const n = parseInt(get("--n", "40"), 10);
let shown = 0;
for (const t of texts.slice(from)) {
  const r = parseCitation(t);
  if (args.includes("--low") && r.confidence >= 0.5) continue;
  if (args.includes("--unknown") && (r.venueKnown || !r.venueRaw)) continue;
  console.log(`\n${t}`);
  console.log(
    `  → ${r.label ?? "-"} | ${r.authorShort} [${r.authors.length}] | ${r.title} | ${r.venueShort}${r.venueKnown ? "✓" : ""} ← "${r.venueRaw}" | ${r.year} | ${r.confidence}`,
  );
  if (++shown >= n) break;
}
