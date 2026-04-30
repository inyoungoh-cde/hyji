/**
 * gen-icons.cjs — Generate all HYJI icon assets from src-tauri/icons/icon.png
 *
 * Required outputs (Tauri v2 Windows + Rust window icon):
 *   32x32.png          tauri.conf.json icon array
 *   128x128.png        tauri.conf.json icon array
 *   128x128@2x.png     tauri.conf.json icon array (256×256 pixels)
 *   icon.ico           tauri.conf.json icon array (multi-size: 16/32/48/256)
 *   icon.rgba          Rust set_icon() — raw 64×64 RGBA bytes
 *
 * Run:  node scripts/gen-icons.cjs
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const sharp = require("sharp");

const SRC = path.join(__dirname, "..", "src-tauri", "icons", "icon.png");
const OUT = path.join(__dirname, "..", "src-tauri", "icons");

if (!fs.existsSync(SRC)) {
  console.error(`ERROR: Source icon not found at ${SRC}`);
  console.error("Place your new icon.png at src-tauri/icons/icon.png first.");
  process.exit(1);
}

// ── PNG sizes ────────────────────────────────────────────────────────────────
const PNG_TARGETS = [
  { file: "32x32.png",       px: 32  },
  { file: "128x128.png",     px: 128 },
  { file: "128x128@2x.png",  px: 256 }, // 2× = 256 px
];

// ── ICO layers (all embedded as PNG inside the ICO container) ────────────────
const ICO_SIZES = [16, 32, 48, 64, 256];

// ── icon.rgba size (matches include_bytes! + Image::new_owned in lib.rs) ────
const RGBA_PX = 64;

// ── Resize helper ─────────────────────────────────────────────────────────────
function resize(px) {
  return sharp(SRC).resize(px, px, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });
}

// ── Build multi-resolution ICO from an array of PNG buffers ──────────────────
function buildIco(images /* [{ px, buf }] */) {
  const n = images.length;
  const DIR_ENTRY_SIZE = 16;
  const headerSize = 6 + n * DIR_ENTRY_SIZE;
  let dataOffset = headerSize;

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: ICO
  header.writeUInt16LE(n, 4);

  const entries = [];
  const payloads = [];

  for (const { px, buf } of images) {
    const e = Buffer.alloc(DIR_ENTRY_SIZE);
    e[0] = px >= 256 ? 0 : px; // 0 means 256 in ICO spec
    e[1] = px >= 256 ? 0 : px;
    e[2] = 0;  // colour count (0 = no palette)
    e[3] = 0;  // reserved
    e.writeUInt16LE(1,  4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(buf.length, 8);  // image data size
    e.writeUInt32LE(dataOffset, 12); // offset to image data
    dataOffset += buf.length;
    entries.push(e);
    payloads.push(buf);
  }

  return Buffer.concat([header, ...entries, ...payloads]);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Source: ${SRC}\n`);

  // 1. PNG files
  for (const { file, px } of PNG_TARGETS) {
    const dest = path.join(OUT, file);
    await resize(px).png().toFile(dest);
    console.log(`  ✓  ${file}  (${px}×${px})`);
  }

  // 2. icon.rgba — raw RGBA bytes, no file header
  const rawBuf = await resize(RGBA_PX)
    .ensureAlpha()
    .raw()
    .toBuffer();
  fs.writeFileSync(path.join(OUT, "icon.rgba"), rawBuf);
  console.log(`  ✓  icon.rgba  (${RGBA_PX}×${RGBA_PX} raw RGBA, ${rawBuf.length} bytes)`);

  // 3. icon.ico (multi-resolution)
  const icoImages = [];
  for (const px of ICO_SIZES) {
    const buf = await resize(px).png().toBuffer();
    icoImages.push({ px, buf });
    console.log(`  ·  ico layer ${px}×${px}  (${buf.length} bytes)`);
  }
  const ico = buildIco(icoImages);
  fs.writeFileSync(path.join(OUT, "icon.ico"), ico);
  console.log(`  ✓  icon.ico  (layers: ${ICO_SIZES.join(", ")})`);

  console.log("\nAll icons generated. Run  npm run tauri dev  to test.");
}

main().catch((err) => {
  console.error("gen-icons failed:", err.message ?? err);
  process.exit(1);
});
