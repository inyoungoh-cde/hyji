// Shared pdf.js resource options. Without cMapUrl, any PDF whose fonts
// reference a CMap (CJK papers, Adobe-Korea1/Japan1/GB1/CNS1 fonts) fails
// font translation and renders pages with no visible text. The assets are
// copied into public/pdfjs/ by vite.config.ts (syncPdfjsAssets).
export const PDFJS_ASSET_OPTIONS = {
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  wasmUrl: "/pdfjs/wasm/",
} as const;
