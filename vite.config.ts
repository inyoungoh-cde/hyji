import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

// pdf.js needs its CMap tables (CJK encodings), standard fonts, and wasm
// image decoders served alongside the app. Copy them from pdfjs-dist into
// public/pdfjs/ once per installed pdfjs-dist version (public/pdfjs is
// gitignored — it is a build artifact, not source).
function syncPdfjsAssets() {
  const pkg = JSON.parse(
    readFileSync(path.resolve("node_modules/pdfjs-dist/package.json"), "utf8")
  ) as { version: string };
  const destRoot = path.resolve("public/pdfjs");
  const marker = path.join(destRoot, ".version");
  const current = existsSync(marker) ? readFileSync(marker, "utf8") : "";
  if (current === pkg.version) return;
  mkdirSync(destRoot, { recursive: true });
  for (const dir of ["cmaps", "standard_fonts", "wasm"]) {
    cpSync(
      path.resolve("node_modules/pdfjs-dist", dir),
      path.join(destRoot, dir),
      { recursive: true }
    );
  }
  writeFileSync(marker, pkg.version);
}

export default defineConfig(async () => {
  syncPdfjsAssets();
  return {
    plugins: [react()],
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
      watch: { ignored: ["**/src-tauri/**"] },
    },
  };
});
