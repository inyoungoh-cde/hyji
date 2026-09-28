// Downloads the PDFium binary (bblanchon/pdfium-binaries) into src-tauri/pdfium/
// so Tauri can bundle it as a resource. Skips when pdfium.dll already exists.
// Node 18+, no dependencies: fetch + zlib + a minimal ustar reader.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const RELEASE = "chromium/8066";
const ASSET = "pdfium-win-x64.tgz";
const URL = `https://github.com/bblanchon/pdfium-binaries/releases/download/${RELEASE}/${ASSET}`;

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "pdfium");
const wanted = {
  "bin/pdfium.dll": "pdfium.dll",
  "LICENSE": "LICENSE.pdfium",
  "VERSION": "VERSION.pdfium",
};

const dll = join(outDir, "pdfium.dll");
if (existsSync(dll)) {
  console.log(`pdfium: ${dll} already present, skipping download`);
  process.exit(0);
}

console.log(`pdfium: downloading ${URL}`);
const res = await fetch(URL, { redirect: "follow" });
if (!res.ok) {
  console.error(`pdfium: download failed: HTTP ${res.status}`);
  process.exit(1);
}
const tar = gunzipSync(Buffer.from(await res.arrayBuffer()));

// ustar: 512-byte headers, name at 0 (100 bytes), size at 124 (12 bytes, octal),
// type flag at 156, optional "ustar" prefix at 345 (155 bytes).
const found = new Map();
for (let off = 0; off + 512 <= tar.length; ) {
  const header = tar.subarray(off, off + 512);
  if (header.every((b) => b === 0)) break;
  const str = (start, len) => header.subarray(start, start + len).toString("utf8").replace(/\0.*$/s, "");
  const size = parseInt(str(124, 12).trim() || "0", 8);
  const prefix = str(345, 155);
  let name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
  name = name.replace(/^\.\//, "");
  const type = str(156, 1);
  const dataStart = off + 512;
  if ((type === "0" || type === "") && wanted[name]) {
    found.set(name, Buffer.from(tar.subarray(dataStart, dataStart + size)));
  }
  off = dataStart + Math.ceil(size / 512) * 512;
}

if (!found.has("bin/pdfium.dll")) {
  console.error("pdfium: bin/pdfium.dll not found in archive");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
for (const [name, target] of Object.entries(wanted)) {
  const data = found.get(name);
  if (!data) {
    console.warn(`pdfium: ${name} missing from archive (skipped)`);
    continue;
  }
  writeFileSync(join(outDir, target), data);
  console.log(`pdfium: wrote ${join(outDir, target)} (${data.length} bytes)`);
}
