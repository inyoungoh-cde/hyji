//! PDFium render backend (3.0).
//!
//! pdf.js keeps the text layer / selection / search; PDFium (Chrome's engine,
//! with proper font hinting) rasterizes the page bitmaps. The DLL is loaded
//! lazily on the first command; when it is missing the app keeps working and
//! `pdfium_status` tells the frontend to stay on pdf.js.
//!
//! PDFium is single-threaded: the crate's `thread_safe` feature serializes
//! every FFI call behind a global mutex, so documents can live in a process-
//! wide cache and be rendered from any blocking-pool thread. Every command is
//! `async` and does its work in `spawn_blocking` so the event loop never waits
//! on a render.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, LazyLock, Mutex, OnceLock};
use std::time::SystemTime;

use pdfium_render::prelude::*;
use serde::Serialize;
use tauri::{AppHandle, Manager};

const MAX_RENDER_BYTES: usize = 96 * 1024 * 1024;
/// Image boxes narrower or shorter than this (in points) are noise: rules,
/// bullets, 1-px spacer images.
const MIN_REGION_PT: f32 = 4.0;
const MAX_FORM_DEPTH: u32 = 16;
/// Horizontal over-render for x-offset region tiles, in display points
/// (covers one glyph of a 48 pt display face — see `render_region_rgba`).
const REGION_PAD_PT: f64 = 48.0;

// ── Library binding ──

struct Engine {
    pdfium: Pdfium,
    library: PathBuf,
    version: Option<String>,
}

static ENGINE: OnceLock<Result<Engine, String>> = OnceLock::new();

/// Where to look for `pdfium.dll`, first hit wins.
fn candidate_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(d) = app.path().resource_dir() {
        dirs.push(d);
    }
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        dirs.push(exe_dir.join("pdfium"));
        dirs.insert(dirs.len() - 1, exe_dir);
    }
    if let Some(d) = std::env::var_os("HYJI_PDFIUM_DIR") {
        dirs.push(PathBuf::from(d));
    }
    dirs
}

/// bblanchon/pdfium-binaries ships a `VERSION` file (`MAJOR=…\nMINOR=…\n
/// BUILD=…\nPATCH=…`); the fetch script keeps it next to the DLL as
/// `pdfium.version`. PDFium itself has no version query.
fn read_version(dll: &Path) -> Option<String> {
    let dir = dll.parent()?;
    let text = ["pdfium.version", "VERSION.pdfium", "VERSION"]
        .iter()
        .find_map(|n| std::fs::read_to_string(dir.join(n)).ok())?;
    let field = |key: &str| {
        text.lines()
            .find_map(|l| l.trim().strip_prefix(key)?.strip_prefix('='))
            .map(|v| v.trim().to_string())
    };
    let (major, minor, build, patch) = (
        field("MAJOR")?,
        field("MINOR")?,
        field("BUILD")?,
        field("PATCH")?,
    );
    Some(format!("{major}.{minor}.{build}.{patch}"))
}

fn bind(app: &AppHandle) -> Result<Engine, String> {
    let mut tried = Vec::new();
    for dir in candidate_dirs(app) {
        let dll = Pdfium::pdfium_platform_library_name_at_path(&dir);
        if !dll.is_file() {
            tried.push(format!("{} (not found)", dll.display()));
            continue;
        }
        match Pdfium::bind_to_library(&dll) {
            Ok(bindings) => {
                let version = read_version(&dll);
                return Ok(Engine {
                    pdfium: Pdfium::new(bindings),
                    library: dll,
                    version,
                });
            }
            Err(e) => tried.push(format!("{} ({e:?})", dll.display())),
        }
    }
    Err(format!("pdfium.dll could not be loaded; tried: {}", tried.join("; ")))
}

fn engine(app: &AppHandle) -> Result<&'static Engine, String> {
    ENGINE
        .get_or_init(|| bind(app))
        .as_ref()
        .map_err(|e| format!("PDFium unavailable: {e}"))
}

// ── Document cache ──

type DocKey = (PathBuf, Option<SystemTime>, u64);

/// Loaded pages kept per document (most recently used last). Text, links,
/// image regions and the render of one page arrive as separate commands;
/// without this every one of them would re-parse the page content stream.
const PAGE_CACHE: usize = 8;

/// A parsed page plus the lazily extracted character list (3.2 text layer).
/// Declared before `page` so the pure-data text drops first — irrelevant
/// today, but keeps the door open for caching an `FPDF_TEXTPAGE` here.
pub struct CachedPage {
    index: u32,
    text: OnceLock<Result<TextPage, String>>,
    page: PdfPage<'static>,
}

impl CachedPage {
    pub fn page(&self) -> &PdfPage<'static> {
        &self.page
    }

    pub fn text(&self) -> Result<&TextPage, String> {
        self.text
            .get_or_init(|| extract_text(&self.page))
            .as_ref()
            .map_err(Clone::clone)
    }
}

pub struct Doc {
    // Dropped before `doc`: PDFium pages must be closed before their document.
    pages: Mutex<Vec<Arc<CachedPage>>>,
    /// Link-target layouts by page index (`page_layout`).
    layouts: Mutex<HashMap<u32, Arc<PageLayout>>>,
    doc: PdfDocument<'static>,
    key: DocKey,
}

impl Doc {
    /// Opens `path` outside the process cache (used by `pdfium_open` and by
    /// standalone tooling that binds the DLL itself).
    pub fn open(pdfium: &'static Pdfium, path: &str) -> Result<Doc, String> {
        let key = doc_key(path)?;
        let doc = pdfium.load_pdf_from_file(path, None).map_err(|e| match e {
            PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError) => {
                "PDF is password-protected".to_string()
            }
            other => format!("{path}: {}", perr(other)),
        })?;
        Ok(Doc { pages: Mutex::new(Vec::new()), layouts: Mutex::new(HashMap::new()), doc, key })
    }

    pub fn document(&self) -> &PdfDocument<'static> {
        &self.doc
    }

    pub fn page(&self, index: u32) -> Result<Arc<CachedPage>, String> {
        let mut pages = self.pages.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(pos) = pages.iter().position(|p| p.index == index) {
            let hit = pages.remove(pos);
            pages.push(Arc::clone(&hit));
            return Ok(hit);
        }
        let page = load_page(self, index)?;
        let entry = Arc::new(CachedPage { index, text: OnceLock::new(), page });
        if pages.len() >= PAGE_CACHE {
            pages.remove(0);
        }
        pages.push(Arc::clone(&entry));
        Ok(entry)
    }
}

struct Entry {
    doc: Arc<Doc>,
    refs: u32,
    /// false = opened with `exclusive`; never handed out to other openers.
    shared: bool,
}

struct Cache {
    by_id: HashMap<u32, Entry>,
    next_id: u32,
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| {
    Mutex::new(Cache { by_id: HashMap::new(), next_id: 1 })
});

fn cache() -> std::sync::MutexGuard<'static, Cache> {
    CACHE.lock().unwrap_or_else(|p| p.into_inner())
}

fn doc_key(path: &str) -> Result<DocKey, String> {
    let canonical = std::fs::canonicalize(path).map_err(|e| format!("{path}: {e}"))?;
    let meta = std::fs::metadata(&canonical).map_err(|e| format!("{path}: {e}"))?;
    Ok((canonical, meta.modified().ok(), meta.len()))
}

fn lookup(id: u32) -> Result<Arc<Doc>, String> {
    cache()
        .by_id
        .get(&id)
        .map(|e| Arc::clone(&e.doc))
        .ok_or_else(|| format!("PDFium document {id} is not open"))
}

fn perr(e: PdfiumError) -> String {
    format!("{e:?}")
}

fn load_page(doc: &Doc, page: u32) -> Result<PdfPage<'static>, String> {
    let index = i32::try_from(page).map_err(|_| format!("page {page} out of range"))?;
    doc.doc.pages().get(index).map_err(perr)
}

// ── Geometry ──

/// A rectangle in display points, top-left origin — the coordinate system of
/// the `pages[i].width/height` reported by `pdfium_open`.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct Region {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// Page → display mapping, mirroring PDFium's `CPDF_Page::SetViewBox` +
/// display matrix: the visible box is CropBox ∩ MediaBox (MediaBox when the
/// CropBox is absent/empty, Letter when both are), y is flipped, then /Rotate
/// turns the box clockwise.
#[derive(Debug, Clone, Copy)]
pub struct PageFrame {
    left: f32,
    bottom: f32,
    /// Unrotated box size.
    w0: f32,
    h0: f32,
    /// /Rotate in quarter turns (0..=3).
    quarter_turns: u32,
}

impl PageFrame {
    pub fn from_page(page: &PdfPage) -> Self {
        fn norm(r: PdfRect) -> (f32, f32, f32, f32) {
            let (l, r_, b, t) = (r.left().value, r.right().value, r.bottom().value, r.top().value);
            (l.min(r_), b.min(t), l.max(r_), b.max(t))
        }
        let media = page
            .boundaries()
            .media()
            .ok()
            .map(|b| norm(b.bounds))
            .filter(|(l, b, r, t)| r > l && t > b)
            .unwrap_or((0.0, 0.0, 612.0, 792.0));
        let crop = page
            .boundaries()
            .crop()
            .ok()
            .map(|b| norm(b.bounds))
            .filter(|(l, b, r, t)| r > l && t > b)
            .map(|(l, b, r, t)| (l.max(media.0), b.max(media.1), r.min(media.2), t.min(media.3)))
            .filter(|(l, b, r, t)| r > l && t > b)
            .unwrap_or(media);
        let quarter_turns = match page.rotation().unwrap_or(PdfPageRenderRotation::None) {
            PdfPageRenderRotation::None => 0,
            PdfPageRenderRotation::Degrees90 => 1,
            PdfPageRenderRotation::Degrees180 => 2,
            PdfPageRenderRotation::Degrees270 => 3,
        };
        PageFrame {
            left: crop.0,
            bottom: crop.1,
            w0: crop.2 - crop.0,
            h0: crop.3 - crop.1,
            quarter_turns,
        }
    }

    /// Display size (rotation applied) — must equal `PdfPage::width/height`.
    pub fn display_size(&self) -> (f32, f32) {
        if self.quarter_turns % 2 == 1 {
            (self.h0, self.w0)
        } else {
            (self.w0, self.h0)
        }
    }

    /// Page-space point → display point (top-left origin, rotation applied).
    pub fn to_display(&self, x: f32, y: f32) -> (f32, f32) {
        let u = x - self.left;
        let v = (self.bottom + self.h0) - y;
        match self.quarter_turns {
            1 => (self.h0 - v, u),
            2 => (self.w0 - u, self.h0 - v),
            3 => (v, self.w0 - u),
            _ => (u, v),
        }
    }

    pub fn quad_to_region(&self, q: &PdfQuadPoints) -> Region {
        let pts = [
            self.to_display(q.x1().value, q.y1().value),
            self.to_display(q.x2().value, q.y2().value),
            self.to_display(q.x3().value, q.y3().value),
            self.to_display(q.x4().value, q.y4().value),
        ];
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for (x, y) in pts {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
        Region { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }
}

fn visit_object(obj: &PdfPageObject, ctm: PdfMatrix, depth: u32, out: &mut Vec<PdfQuadPoints>) {
    match obj {
        PdfPageObject::Image(img) => {
            if let Ok(q) = img.bounds() {
                out.push(q.transform(ctm));
            }
        }
        PdfPageObject::XObjectForm(form) if depth < MAX_FORM_DEPTH => {
            // Children are in the form's own space; the form object's matrix
            // (its CTM at the `Do`) maps them into the parent's space. Row-
            // vector convention: apply the inner matrix first.
            let inner = form.matrix().unwrap_or(PdfMatrix::IDENTITY).multiply(ctm);
            for i in 0..form.len() {
                if let Ok(child) = form.get(i) {
                    visit_object(&child, inner, depth + 1, out);
                }
            }
        }
        _ => {}
    }
}

/// Bounding boxes of every image object on the page, in display points.
pub fn image_regions(page: &PdfPage) -> Vec<Region> {
    let frame = PageFrame::from_page(page);
    let mut quads = Vec::new();
    for obj in page.objects().iter() {
        visit_object(&obj, PdfMatrix::IDENTITY, 0, &mut quads);
    }
    quads
        .iter()
        .map(|q| frame.quad_to_region(q))
        .filter(|r| r.w >= MIN_REGION_PT && r.h >= MIN_REGION_PT)
        .collect()
}

// ── Rendering ──

/// Renders `page` to exactly `width`×`height` opaque RGBA pixels on white.
pub fn render_rgba(
    page: &PdfPage,
    width: u32,
    height: u32,
    annotations: bool,
) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 {
        return Err("render size must be positive".into());
    }
    let bytes = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4))
        .filter(|&n| n <= MAX_RENDER_BYTES)
        .ok_or_else(|| "render too large".to_string())?;
    let (w, h) = (width as i32, height as i32);

    // Opaque white so the alpha channel is 255 everywhere even where PDFium
    // draws nothing; reverse byte order makes PDFium write RGBA into it.
    let mut buf = vec![0xFFu8; bytes];
    {
        let mut bitmap =
            PdfBitmap::from_bytes(w, h, PdfBitmapFormat::BGRA, &mut buf).map_err(perr)?;
        let config = PdfRenderConfig::new()
            .set_target_size(w, h)
            .clear_before_rendering(false)
            .render_form_data(false)
            .render_annotations(annotations)
            .set_text_smoothing(true)
            .use_lcd_text_rendering(false)
            .set_reverse_byte_order(true);
        page.render_into_bitmap_with_config(&mut bitmap, &config)
            .map_err(perr)?;
    }
    Ok(buf)
}

/// Full-page pixel size at `scale` device pixels per display point. Computed
/// in f64 like the frontend's `Math.ceil(width * scale)` so a region render
/// and the full render it must match agree on the target size.
pub fn scaled_size(page: &PdfPage, scale: f32) -> Result<(u32, u32), String> {
    if !(scale.is_finite() && scale > 0.0) {
        return Err("scale must be positive".into());
    }
    let w = (page.width().value as f64 * scale as f64).ceil();
    let h = (page.height().value as f64 * scale as f64).ceil();
    if !(w >= 1.0 && h >= 1.0 && w <= u32::MAX as f64 && h <= u32::MAX as f64) {
        return Err("render size out of range".into());
    }
    Ok((w as u32, h as u32))
}

/// Renders the sub-rectangle `[x, x+width) × [y, y+height)` of the page as
/// it would appear in a full render at `scale` (`ceil(w·scale) × ceil(h·scale)`
/// pixels), pixel-identical to cropping that full render.
///
/// The full render goes through the matrix path with `[sx 0 0 sy 0 0]` where
/// `sx = target_w / page_w` (the crate's `set_target_size` arithmetic). The
/// region uses the very same matrix with an integer device-pixel translation
/// `(-x, -y)` and a clip to the strip, so the rasterizer sees identical
/// sub-pixel positions. `set_origin` on the `FPDF_RenderPageBitmap` path is
/// NOT equivalent (it re-derives the scale from the offset bitmap size).
pub fn render_region_rgba(
    page: &PdfPage,
    scale: f32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    annotations: bool,
) -> Result<Vec<u8>, String> {
    let (full_w, full_h) = scaled_size(page, scale)?;
    if width == 0 || height == 0 {
        return Err("render size must be positive".into());
    }
    if x.checked_add(width).is_none_or(|r| r > full_w)
        || y.checked_add(height).is_none_or(|b| b > full_h)
    {
        return Err(format!(
            "region {x},{y} {width}×{height} exceeds page {full_w}×{full_h}"
        ));
    }
    // Horizontal margin: PDFium rasterizes each glyph as an LCD-resolution
    // bitmap that is normalized to grayscale with its neighbours, and a clip
    // edge running through a glyph changes those pixels (measured: a band of
    // ~7 pt — one glyph — next to the left edge, up to 135/255 off). Vertical
    // edges are clean, so full-width strips need no margin. Render x-tiles
    // wider by a glyph and crop.
    let pad = (REGION_PAD_PT * scale as f64).ceil() as u32;
    let x0 = if x == 0 { 0 } else { x.saturating_sub(pad) };
    let x1 = if x + width == full_w { full_w } else { (x + width).saturating_add(pad).min(full_w) };
    let rw = x1 - x0;
    let bytes = (rw as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4))
        .filter(|&n| n <= MAX_RENDER_BYTES)
        .ok_or_else(|| "render too large".to_string())?;
    let sx = full_w as f32 / page.width().value;
    let sy = full_h as f32 / page.height().value;
    let matrix = PdfMatrix::new(sx, 0.0, 0.0, sy, -(x0 as f32), -(y as f32));
    let (w, h) = (rw as i32, height as i32);

    let mut buf = vec![0xFFu8; bytes];
    {
        let mut bitmap =
            PdfBitmap::from_bytes(w, h, PdfBitmapFormat::BGRA, &mut buf).map_err(perr)?;
        let config = PdfRenderConfig::new()
            .reset_matrix(matrix)
            .map_err(perr)?
            .clip(0, 0, w, h)
            .clear_before_rendering(false)
            .render_form_data(false)
            .render_annotations(annotations)
            .set_text_smoothing(true)
            .use_lcd_text_rendering(false)
            .set_reverse_byte_order(true);
        page.render_into_bitmap_with_config(&mut bitmap, &config)
            .map_err(perr)?;
    }
    if rw == width {
        return Ok(buf);
    }
    let row = (width * 4) as usize;
    let stride = (rw * 4) as usize;
    let skip = ((x - x0) * 4) as usize;
    let mut out = Vec::with_capacity(row * height as usize);
    for r in 0..height as usize {
        out.extend_from_slice(&buf[r * stride + skip..r * stride + skip + row]);
    }
    Ok(out)
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct PngResult {
    pub width: u32,
    pub height: u32,
}

/// Full-page render at `scale`, written as PNG so print-sized bitmaps never
/// cross the IPC bridge or sit in JS memory.
pub fn render_png_to_file(
    page: &PdfPage,
    scale: f32,
    annotations: bool,
    out_path: &Path,
) -> Result<PngResult, String> {
    let (width, height) = scaled_size(page, scale)?;
    let rgba = render_rgba(page, width, height, annotations)?;
    // Print bitmaps are transient: fastest deflate, no filtering.
    let file = std::fs::File::create(out_path)
        .map_err(|e| format!("{}: {e}", out_path.display()))?;
    let encoder = image::codecs::png::PngEncoder::new_with_quality(
        std::io::BufWriter::new(file),
        image::codecs::png::CompressionType::Fast,
        image::codecs::png::FilterType::NoFilter,
    );
    image::ImageEncoder::write_image(encoder, &rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("{}: {e}", out_path.display()))?;
    Ok(PngResult { width, height })
}

// ── Text layer ──

/// One PDFium text character in display points (top-left origin).
///
/// `rot` is the glyph's rotation in display space, clockwise degrees as CSS
/// `rotate()` counts them: 0 = upright, 90 = reads top-to-bottom, 270 = reads
/// bottom-to-top (an arXiv margin stamp), -1 = not a multiple of 90°.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextChar {
    pub c: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub font_size: f32,
    pub rot: i32,
}

/// The character list of one page in PDFium's `FPDFText` order. PDFium's
/// generated "\r\n" separators are not emitted as chars; they become entries
/// in `line_breaks` (indices of chars that END a line).
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextPage {
    pub chars: Vec<TextChar>,
    pub line_breaks: Vec<u32>,
}

/// Page-space axis-aligned rect → display-space region (rotation applied).
fn rect_to_region(frame: &PageFrame, r: &PdfRect) -> Region {
    let (l, rr, b, t) = (r.left().value, r.right().value, r.bottom().value, r.top().value);
    let pts = [
        frame.to_display(l, b),
        frame.to_display(rr, b),
        frame.to_display(l, t),
        frame.to_display(rr, t),
    ];
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for (x, y) in pts {
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    Region { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/// Page-space CCW glyph angle (radians) → display rotation (see `TextChar::rot`).
/// The y flip turns CCW into CW; /Rotate adds `quarter_turns × 90°` CW.
fn display_rotation(page_radians: f32, quarter_turns: u32) -> i32 {
    let ccw = page_radians.to_degrees().rem_euclid(360.0);
    let cw = (360.0 - ccw + quarter_turns as f32 * 90.0).rem_euclid(360.0);
    let snapped = (cw / 90.0).round() * 90.0;
    if (cw - snapped).abs() <= 2.0 {
        (snapped as i32).rem_euclid(360)
    } else {
        -1
    }
}

/// (advance, cross) projection of a display point for text running at `rot`:
/// advance grows along the reading direction, cross is the baseline's
/// perpendicular coordinate.
fn along(rot: i32, x: f32, y: f32) -> (f32, f32) {
    match rot {
        90 => (y, x),
        180 => (-x, y),
        270 => (-y, x),
        _ => (x, y),
    }
}

struct RawChar {
    c: String,
    boxed: Region,
    origin: (f32, f32),
    font_size: f32,
    rot: i32,
    generated_break: bool,
}

fn raw_chars(page: &PdfPage, frame: &PageFrame) -> Result<Vec<RawChar>, String> {
    let text = page.text().map_err(perr)?;
    let chars = text.chars();
    let mut out: Vec<RawChar> = Vec::with_capacity(chars.len());
    let mut pending_high: Option<(u16, usize)> = None; // UTF-16 lead surrogate + its slot

    for ch in chars.iter() {
        let code = ch.unicode_value();
        if code == 0x0A || code == 0x0D {
            // PDFium's "\r\n" / "\n" between text segments.
            if let Some(last) = out.last_mut() {
                last.generated_break = true;
            }
            continue;
        }

        let boxed = ch
            .loose_bounds()
            .or_else(|_| ch.tight_bounds())
            .map(|r| rect_to_region(frame, &r))
            .unwrap_or(Region { x: 0.0, y: 0.0, w: 0.0, h: 0.0 });
        let origin = ch
            .origin()
            .map(|(x, y)| frame.to_display(x.value, y.value))
            .unwrap_or((boxed.x, boxed.y + boxed.h));
        let font_size = {
            let s = ch.scaled_font_size().value.abs();
            if s.is_finite() && s > 0.0 {
                s
            } else {
                boxed.h
            }
        };
        let rot = ch
            .matrix()
            .map(|m| display_rotation(m.b().atan2(m.a()), frame.quarter_turns))
            .unwrap_or(0);

        // Windows PDFium hands non-BMP characters over as UTF-16 surrogate
        // halves; merge them into one entry with the union box.
        if (0xD800..0xDC00).contains(&code) {
            let slot = out.len();
            out.push(RawChar {
                c: "\u{FFFD}".into(),
                boxed,
                origin,
                font_size,
                rot,
                generated_break: false,
            });
            pending_high = Some((code as u16, slot));
            continue;
        }
        if let Some((hi, slot)) = pending_high.take() {
            if (0xDC00..0xE000).contains(&code) {
                if let Some(s) = String::from_utf16(&[hi, code as u16]).ok() {
                    let prev = &mut out[slot];
                    prev.c = s;
                    let x0 = prev.boxed.x.min(boxed.x);
                    let y0 = prev.boxed.y.min(boxed.y);
                    let x1 = (prev.boxed.x + prev.boxed.w).max(boxed.x + boxed.w);
                    let y1 = (prev.boxed.y + prev.boxed.h).max(boxed.y + boxed.h);
                    prev.boxed = Region { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
                }
                continue;
            }
        }
        let c = char::from_u32(code).unwrap_or('\u{FFFD}').to_string();
        out.push(RawChar { c, boxed, origin, font_size, rot, generated_break: false });
    }
    Ok(out)
}

/// Extracts the page's character list. Boxes are PDFium's *loose* char boxes
/// (font ascent/descent × size, i.e. a uniform band per line, like pdf.js's
/// text-layer spans) with the tight glyph box as fallback — see the module
/// report for the measurement behind that choice.
pub fn extract_text(page: &PdfPage) -> Result<TextPage, String> {
    let frame = PageFrame::from_page(page);
    let raw = raw_chars(page, &frame)?;
    let n = raw.len();
    let mut chars: Vec<TextChar> = Vec::with_capacity(n);
    let mut line_breaks: Vec<u32> = Vec::new();

    for (i, rc) in raw.iter().enumerate() {
        chars.push(TextChar {
            c: rc.c.clone(),
            x: rc.boxed.x,
            y: rc.boxed.y,
            w: rc.boxed.w,
            h: rc.boxed.h,
            font_size: rc.font_size,
            rot: rc.rot,
        });
        if i + 1 == n {
            break;
        }
        let next = &raw[i + 1];
        let breaks = rc.generated_break || rc.rot != next.rot || {
            let (a0, c0) = along(rc.rot, rc.origin.0, rc.origin.1);
            let (a1, c1) = along(rc.rot, next.origin.0, next.origin.1);
            let h = if rc.boxed.h > 0.0 { rc.boxed.h } else { rc.font_size };
            (c1 - c0).abs() > 0.5 * h || a1 < a0 - 0.5 * rc.font_size
        };
        if breaks {
            line_breaks.push(i as u32);
        }
    }

    synthesize_whitespace_boxes(&mut chars, &line_breaks);
    Ok(TextPage { chars, line_breaks })
}

/// Whitespace PDFium reports with an empty box (generated spaces, some
/// embedded-font spaces) gets a box after the previous char, same height,
/// spanning the gap to the next char on the line.
fn synthesize_whitespace_boxes(chars: &mut [TextChar], line_breaks: &[u32]) {
    let ends_line = |i: usize| line_breaks.binary_search(&(i as u32)).is_ok();
    for i in 0..chars.len() {
        let bad = !(chars[i].w > 0.0 && chars[i].h > 0.0)
            || !chars[i].w.is_finite()
            || !chars[i].h.is_finite();
        if !bad || !chars[i].c.chars().all(char::is_whitespace) {
            continue;
        }
        let prev = if i > 0 && !ends_line(i - 1) { Some(chars[i - 1].clone()) } else { None };
        let next = if !ends_line(i) { chars.get(i + 1).cloned() } else { None };
        let fallback_w = chars[i].font_size.max(1.0) * 0.25;
        let c = &mut chars[i];
        match (prev, next) {
            (Some(p), next) => {
                c.rot = p.rot;
                c.font_size = if c.font_size > 0.0 { c.font_size } else { p.font_size };
                match p.rot {
                    90 | 270 => {
                        c.x = p.x;
                        c.w = p.w;
                        let (start, gap) = if p.rot == 90 {
                            let s = p.y + p.h;
                            (s, next.as_ref().map(|n| n.y - s))
                        } else {
                            // Advances upward: box sits above the previous one.
                            let g = next.as_ref().map(|n| p.y - (n.y + n.h));
                            (p.y - g.filter(|g| *g > 0.0).unwrap_or(fallback_w), g)
                        };
                        c.h = gap.filter(|g| *g > 0.0 && *g < 3.0 * c.font_size).unwrap_or(fallback_w);
                        c.y = if p.rot == 90 { start } else { p.y - c.h };
                    }
                    _ => {
                        let start = if p.rot == 180 { p.x } else { p.x + p.w };
                        c.y = p.y;
                        c.h = p.h;
                        let gap = next.as_ref().map(|n| {
                            if p.rot == 180 { p.x - (n.x + n.w) } else { n.x - start }
                        });
                        c.w = gap.filter(|g| *g > 0.0 && *g < 3.0 * c.font_size).unwrap_or(fallback_w);
                        c.x = if p.rot == 180 { start - c.w } else { start };
                    }
                }
            }
            (None, Some(n)) => {
                c.rot = n.rot;
                c.y = n.y;
                c.h = n.h;
                c.w = fallback_w;
                c.x = n.x - c.w;
            }
            (None, None) => {}
        }
    }
}

/// Plain text of the page: chars concatenated, `\n` after each line end.
pub fn plain_text(text: &TextPage) -> String {
    let mut out = String::with_capacity(text.chars.len() + text.line_breaks.len());
    let mut breaks = text.line_breaks.iter().peekable();
    for (i, ch) in text.chars.iter().enumerate() {
        out.push_str(&ch.c);
        if breaks.peek().is_some_and(|&&b| b as usize == i) {
            breaks.next();
            out.push('\n');
        }
    }
    out
}

// ── Search ──

/// Char index range `[start, end)` into `TextPage::chars`.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct SearchMatch {
    pub start: u32,
    pub end: u32,
}

/// Finds `query` in the page's char sequence. Case-insensitive unless
/// `match_case` (Unicode lowercase on both sides); a whitespace run in the
/// query matches any whitespace run in the text, including a bare line break.
/// Matches are non-overlapping, in reading order.
pub fn search_text(text: &TextPage, query: &str, match_case: bool) -> Vec<SearchMatch> {
    let fold = |s: &str| -> String { if match_case { s.to_string() } else { s.to_lowercase() } };
    let tokens: Vec<Vec<char>> = fold(query)
        .split_whitespace()
        .map(|t| t.chars().collect())
        .collect();
    if tokens.is_empty() {
        return Vec::new();
    }

    // Lowercasing can expand one char into several; keep the owner index.
    let mut hay: Vec<(char, usize)> = Vec::with_capacity(text.chars.len());
    for (i, ch) in text.chars.iter().enumerate() {
        for c in fold(&ch.c).chars() {
            hay.push((c, i));
        }
    }
    let ends_line = |owner: usize| text.line_breaks.binary_search(&(owner as u32)).is_ok();

    let try_match = |start: usize| -> Option<usize> {
        let mut i = start;
        for (ti, tok) in tokens.iter().enumerate() {
            if ti > 0 {
                let before = i;
                while i < hay.len() && hay[i].0.is_whitespace() {
                    i += 1;
                }
                let bare_line_break = before > 0
                    && ends_line(hay[before - 1].1)
                    && hay.get(before).is_none_or(|h| h.1 != hay[before - 1].1);
                if i == before && !bare_line_break {
                    return None;
                }
            }
            for &c in tok {
                if i < hay.len() && hay[i].0 == c {
                    i += 1;
                } else {
                    return None;
                }
            }
        }
        Some(hay[i - 1].1 + 1)
    };

    let first = tokens[0][0];
    let mut out = Vec::new();
    let mut s = 0;
    while s < hay.len() {
        if hay[s].0 == first {
            if let Some(end) = try_match(s) {
                out.push(SearchMatch { start: hay[s].1 as u32, end: end as u32 });
                while s < hay.len() && hay[s].1 < end {
                    s += 1;
                }
                continue;
            }
        }
        s += 1;
    }
    out
}

// ── Links ──

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    /// "uri" | "page" | "none"
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dest_page: Option<u32>,
    /// Destination's vertical position in DISPLAY points of the target page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dest_y: Option<f32>,
    /// Destination's horizontal position in DISPLAY points, when the view
    /// carries one (/XYZ left, /FitR left).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dest_x: Option<f32>,
}

/// Page-space (x?, y) of a destination when its view carries a vertical
/// position (/XYZ, /FitH, /FitBH, top of /FitR).
fn destination_point(view: &PdfDestinationViewSettings) -> Option<(Option<f32>, f32)> {
    use PdfDestinationViewSettings as V;
    match view {
        V::SpecificCoordinatesAndZoom(x, Some(y), _) => Some((x.map(|p| p.value), y.value)),
        V::FitPageHorizontallyToWindow(Some(y)) | V::FitBoundsHorizontallyToWindow(Some(y)) => {
            Some((None, y.value))
        }
        V::FitPageToRectangle(r) => Some((Some(r.left().value), r.top().value)),
        _ => None,
    }
}

/// Target-page frames looked up while resolving one page's links. Target
/// pages are loaded outside the page cache (a TOC can point at dozens of
/// pages; on a 700-page volume each load is ~45 ms and would evict the
/// pages the viewer is actually showing).
type FrameMemo = HashMap<u32, Option<PageFrame>>;

fn target_frame(doc: &Doc, memo: &mut FrameMemo, index: u32) -> Option<PageFrame> {
    *memo.entry(index).or_insert_with(|| {
        if let Some(hit) = doc.pages.lock().unwrap_or_else(|p| p.into_inner()).iter().find(|p| p.index == index) {
            return Some(PageFrame::from_page(hit.page()));
        }
        load_page(doc, index).ok().map(|p| PageFrame::from_page(&p))
    })
}

/// (page, display y, display x) of a destination.
fn resolve_destination(
    doc: &Doc,
    memo: &mut FrameMemo,
    dest: &PdfDestination,
) -> (Option<u32>, Option<f32>, Option<f32>) {
    let Ok(index) = dest.page_index() else { return (None, None, None) };
    let index = index as u32;
    // view_settings() reads x/y via FPDFDest_GetLocationInPage (hasX/hasY).
    let point = dest.view_settings().ok().and_then(|v| destination_point(&v));
    let display = point.and_then(|(x, y)| {
        let frame = target_frame(doc, memo, index)?;
        let (dx, dy) = frame.to_display(x.unwrap_or(frame.left), y);
        Some((dy, x.map(|_| dx)))
    });
    (Some(index), display.map(|d| d.0), display.and_then(|d| d.1))
}

/// Link annotations of the page (FPDFLink_Enumerate), boxes in display points.
pub fn page_links(doc: &Doc, index: u32) -> Result<Vec<Link>, String> {
    let cached = doc.page(index)?;
    let page = cached.page();
    let frame = PageFrame::from_page(page);
    let mut memo = FrameMemo::new();
    let mut out = Vec::new();
    for link in page.links().iter() {
        let Ok(rect) = link.rect() else { continue };
        let r = rect_to_region(&frame, &rect);
        let mut entry = Link {
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
            kind: "none",
            uri: None,
            dest_page: None,
            dest_y: None,
            dest_x: None,
        };
        if let Some(action) = link.action() {
            if let Some(uri) = action.as_uri_action() {
                if let Ok(u) = uri.uri() {
                    entry.kind = "uri";
                    entry.uri = Some(u);
                }
            } else if let Some(local) = action.as_local_destination_action() {
                if let Ok(dest) = local.destination() {
                    let (p, y, x) = resolve_destination(doc, &mut memo, &dest);
                    if p.is_some() {
                        entry.kind = "page";
                        entry.dest_page = p;
                        entry.dest_y = y;
                        entry.dest_x = x;
                    }
                }
            }
        }
        if entry.kind == "none" {
            if let Some(dest) = link.destination() {
                let (p, y, x) = resolve_destination(doc, &mut memo, &dest);
                if p.is_some() {
                    entry.kind = "page";
                    entry.dest_page = p;
                    entry.dest_y = y;
                    entry.dest_x = x;
                }
            }
        }
        out.push(entry);
    }
    Ok(out)
}

// ── Link targets (citation hover cards) ──
//
// `link_entry` turns an internal link's destination into the text it points
// at: the bibliography entry for an in-text citation, else the caption or
// first line of a figure / table / section / footnote target. Works on
// visual lines rebuilt from the TextPage and grouped into columns, so it does
// not depend on the content-stream order PDFium reports.

const ENTRY_MAX_CHARS: usize = 600;
const OTHER_MAX_CHARS: usize = 200;
/// Per-document memo of page layouts (lines + columns); small pure data.
const LAYOUT_MEMO: usize = 64;
/// How far back `under_references_heading` looks for the heading.
const HEADING_LOOKBACK_PAGES: u32 = 10;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkEntry {
    pub text: String,
    /// "reference" | "other"
    pub kind: &'static str,
    /// Union box of the entry's lines on the destination page (display pt).
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// One visual text line in display points.
#[derive(Debug, Clone)]
struct TLine {
    top: f32,
    bottom: f32,
    left: f32,
    right: f32,
    font_size: f32,
    text: String,
}

impl TLine {
    fn height(&self) -> f32 {
        self.bottom - self.top
    }
}

fn median(mut v: Vec<f32>) -> Option<f32> {
    v.retain(|x| x.is_finite());
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    Some(v[v.len() / 2])
}

/// Hyphen-like chars that may end a line inside a word. PDFium reports a
/// line-end hyphen it recognised as U+0002; U+00AD is a PDF soft hyphen.
fn is_hyphen(c: char) -> bool {
    matches!(c, '-' | '\u{AD}' | '\u{2}' | '\u{2010}')
}

struct LineAcc {
    top: f32,
    bottom: f32,
    left: f32,
    right: f32,
    sizes: Vec<f32>,
    text: String,
}

impl LineAcc {
    fn finish(self, out: &mut Vec<TLine>) {
        let text = self.text.trim().to_string();
        if self.sizes.is_empty() || text.is_empty() {
            return;
        }
        out.push(TLine {
            top: self.top,
            bottom: self.bottom,
            left: self.left,
            right: self.right,
            font_size: median(self.sizes).unwrap_or(self.bottom - self.top),
            text,
        });
    }
}

/// Visual lines of a page: PDFium line segments, invisible chars dropped
/// (`w==h==0` = /ActualText replacement, centre outside the page = under the
/// CropBox), non-upright text dropped, and segments split at gaps wider than
/// two ems (a column gutter PDFium did not break at).
fn page_lines(text: &TextPage, width: f32, height: f32) -> Vec<TLine> {
    let mut out: Vec<TLine> = Vec::new();
    let n = text.chars.len();
    let mut start = 0usize;
    let mut breaks = text.line_breaks.iter();
    while start < n {
        let end = breaks
            .next()
            .map(|&b| (b as usize + 1).clamp(start + 1, n))
            .unwrap_or(n);
        let mut cur: Option<LineAcc> = None;
        for ch in &text.chars[start..end] {
            let Some(c0) = ch.c.chars().next() else { continue };
            if ch.c.chars().all(char::is_whitespace) {
                if let Some(acc) = cur.as_mut() {
                    if !acc.text.ends_with(' ') {
                        acc.text.push(' ');
                    }
                }
                continue;
            }
            if matches!(c0, '\u{AD}' | '\u{2}') {
                // Soft hyphens may carry no box, and PDFium sometimes puts
                // one after its own line break; keep it on the line it ends.
                match cur.as_mut() {
                    Some(acc) => acc.text.push(c0),
                    None => {
                        if let Some(last) = out.last_mut() {
                            last.text.push(c0);
                        }
                    }
                }
                continue;
            }
            let (cx, cy) = (ch.x + ch.w / 2.0, ch.y + ch.h / 2.0);
            let visible = (ch.w > 0.0 || ch.h > 0.0)
                && ch.w.is_finite()
                && ch.h.is_finite()
                && (0.0..=width).contains(&cx)
                && (0.0..=height).contains(&cy);
            if !visible || ch.rot != 0 {
                continue;
            }
            if let Some(acc) = &cur {
                let em = ch.font_size.max(1.0);
                let gap = ch.x - acc.right;
                if gap > (2.0 * em).max(8.0) || ch.x + ch.w < acc.left - 2.0 * em {
                    if let Some(done) = cur.take() {
                        done.finish(&mut out);
                    }
                }
            }
            let acc = cur.get_or_insert_with(|| LineAcc {
                top: f32::MAX,
                bottom: f32::MIN,
                left: f32::MAX,
                right: f32::MIN,
                sizes: Vec::new(),
                text: String::new(),
            });
            acc.top = acc.top.min(ch.y);
            acc.bottom = acc.bottom.max(ch.y + ch.h);
            acc.left = acc.left.min(ch.x);
            acc.right = acc.right.max(ch.x + ch.w);
            acc.sizes.push(ch.font_size);
            acc.text.push_str(&ch.c);
        }
        if let Some(acc) = cur {
            acc.finish(&mut out);
        }
        start = end;
    }
    out
}

#[derive(Debug, Clone)]
struct Column {
    /// Robust extent (quartiles of the narrow lines' lefts / rights), so a stray
    /// sub-figure label or a full-width caption does not widen the column.
    x0: f32,
    x1: f32,
    /// Top to bottom; lines sharing a row are merged.
    lines: Vec<TLine>,
    /// Median baseline-to-baseline pitch.
    pitch: f32,
    font: f32,
    /// `lines[body.0..body.1]` excludes running heads and page footers.
    body: (usize, usize),
}

impl Column {
    fn new(mut lines: Vec<TLine>, page_height: f32, narrow_max: f32) -> Column {
        lines.sort_by(|a, b| a.top.total_cmp(&b.top).then(a.left.total_cmp(&b.left)));
        let mut merged: Vec<TLine> = Vec::with_capacity(lines.len());
        for ln in lines {
            if let Some(last) = merged.last_mut() {
                let overlap = last.bottom.min(ln.bottom) - last.top.max(ln.top);
                if overlap >= 0.5 * last.height().min(ln.height()) {
                    last.text = if ln.left >= last.left {
                        format!("{} {}", last.text, ln.text)
                    } else {
                        format!("{} {}", ln.text, last.text)
                    };
                    last.top = last.top.min(ln.top);
                    last.bottom = last.bottom.max(ln.bottom);
                    last.left = last.left.min(ln.left);
                    last.right = last.right.max(ln.right);
                    continue;
                }
            }
            merged.push(ln);
        }
        let lines = merged;
        let font = median(lines.iter().map(|l| l.font_size).collect()).unwrap_or(10.0);
        let pitch = median(
            lines
                .windows(2)
                .map(|w| w[1].bottom - w[0].bottom)
                .filter(|d| *d > 0.5 * font && *d < 3.0 * font)
                .collect(),
        )
        .unwrap_or(1.2 * font);
        let narrow: Vec<&TLine> = lines.iter().filter(|l| l.right - l.left <= narrow_max).collect();
        let pool: Vec<&TLine> =
            if narrow.len() >= 3 && narrow.len() * 2 >= lines.len() { narrow } else { lines.iter().collect() };
        let mut lefts: Vec<f32> = pool.iter().map(|l| l.left).collect();
        let mut rights: Vec<f32> = pool.iter().map(|l| l.right).collect();
        lefts.sort_by(|a, b| a.total_cmp(b));
        rights.sort_by(|a, b| a.total_cmp(b));
        let x0 = lefts.get(lefts.len() / 4).copied().unwrap_or(0.0);
        let x1 = rights.get(rights.len().saturating_sub(1 + rights.len() / 4)).copied().unwrap_or(x0);
        let gap = |i: usize| lines[i + 1].bottom - lines[i].bottom;
        let (mut s, mut e) = (0usize, lines.len());
        while s + 1 < e && s < 3 && lines[s].bottom < 0.1 * page_height && gap(s) > 1.6 * pitch {
            s += 1;
        }
        while e > s + 1
            && lines.len() - e < 3
            && lines[e - 1].top > 0.9 * page_height
            && gap(e - 2) > 1.6 * pitch
        {
            e -= 1;
        }
        Column { x0, x1, lines, pitch, font, body: (s, e) }
    }
}

/// Lines of one page grouped into columns, left to right.
#[derive(Debug, Clone)]
pub struct PageLayout {
    cols: Vec<Column>,
    /// Median font size over the page.
    font: f32,
    text_left: f32,
    text_right: f32,
}

/// x positions of column gutters: runs ≥ 8 pt that (almost) no narrow line
/// covers.
/// Wide lines (> 60 % of the text width: titles, full-width captions,
/// running heads) are ignored; a page that is mostly wide lines is single-
/// column. A split leaving fewer than three narrow lines on a side is undone.
fn column_cuts(lines: &[TLine], left: f32, right: f32) -> Vec<f32> {
    let span = right - left;
    if span < 50.0 || lines.len() < 6 {
        return Vec::new();
    }
    let narrow: Vec<&TLine> = lines.iter().filter(|l| l.right - l.left <= 0.6 * span).collect();
    if narrow.len() * 2 < lines.len() {
        return Vec::new();
    }
    let nb = span.ceil() as usize + 1;
    let mut bins = vec![0u32; nb];
    for l in &narrow {
        let a = (l.left - left).floor().max(0.0) as usize;
        let b = ((l.right - left).ceil().max(0.0) as usize).min(nb);
        for bin in bins.iter_mut().take(b).skip(a) {
            *bin += 1;
        }
    }
    let (Some(first), Some(last)) =
        (bins.iter().position(|&c| c > 0), bins.iter().rposition(|&c| c > 0))
    else {
        return Vec::new();
    };
    // A few stray items may cross a gutter (sub-figure labels, a centred
    // page number): up to 5 % of the narrow lines are tolerated.
    let stray = (narrow.len() / 20) as u32;
    let mut cuts = Vec::new();
    let mut run: Option<usize> = None;
    for (x, &count) in bins.iter().enumerate().take(last + 1).skip(first) {
        if count <= stray {
            run.get_or_insert(x);
        } else if let Some(s) = run.take() {
            if x - s >= 8 {
                cuts.push(left + (s + x) as f32 / 2.0);
            }
        }
    }
    while !cuts.is_empty() {
        let mut counts = vec![0usize; cuts.len() + 1];
        for l in &narrow {
            let c = (l.left + l.right) / 2.0;
            counts[cuts.iter().filter(|&&k| c >= k).count()] += 1;
        }
        match counts.iter().position(|&n| n < 3) {
            Some(i) => {
                let k = i.saturating_sub(1).min(cuts.len() - 1);
                cuts.remove(k);
            }
            None => break,
        }
    }
    cuts
}

impl PageLayout {
    fn build(text: &TextPage, width: f32, height: f32) -> PageLayout {
        let lines = page_lines(text, width, height);
        let font = median(lines.iter().map(|l| l.font_size).collect()).unwrap_or(10.0);
        let text_left = lines.iter().map(|l| l.left).fold(f32::MAX, f32::min);
        let text_right = lines.iter().map(|l| l.right).fold(f32::MIN, f32::max);
        let (text_left, text_right) =
            if text_left < text_right { (text_left, text_right) } else { (0.0, width) };
        let cuts = column_cuts(&lines, text_left, text_right);
        let span = text_right - text_left;
        let mut groups: Vec<Vec<TLine>> = vec![Vec::new(); cuts.len() + 1];
        for ln in lines {
            let x = if ln.right - ln.left <= 0.6 * span { (ln.left + ln.right) / 2.0 } else { ln.left };
            groups[cuts.iter().filter(|&&c| x >= c).count()].push(ln);
        }
        let cols = groups
            .into_iter()
            .filter(|g| !g.is_empty())
            .map(|g| Column::new(g, height, 0.6 * span))
            .collect();
        PageLayout { cols, font, text_left, text_right }
    }

    /// Column a destination x points into; None when x lies outside the
    /// text area (a meaningless x such as 0). Bibliography dests usually sit
    /// at or up to ~25 pt LEFT of their column (the list's hanging margin),
    /// which can be inside the previous column's right edge: x well inside a
    /// column picks it, else a column starting 0–40 pt right of x, else the
    /// nearest one.
    fn column_at(&self, x: f32) -> Option<usize> {
        if self.cols.is_empty() || x < self.text_left - 40.0 || x > self.text_right + 20.0 {
            return None;
        }
        if let Some(i) = self.cols.iter().position(|c| x >= c.x0 - 6.0 && x <= c.x1 - 20.0) {
            return Some(i);
        }
        if let Some(i) = (0..self.cols.len())
            .filter(|&i| self.cols[i].x0 >= x - 6.0 && self.cols[i].x0 <= x + 40.0)
            .min_by(|&a, &b| self.cols[a].x0.total_cmp(&self.cols[b].x0))
        {
            return Some(i);
        }
        let dist = |c: &Column| if x < c.x0 { c.x0 - x } else if x > c.x1 { x - c.x1 } else { 0.0 };
        (0..self.cols.len()).min_by(|&a, &b| dist(&self.cols[a]).total_cmp(&dist(&self.cols[b])))
    }

    /// Every line in reading order (columns left to right, top to bottom).
    fn reading_order(&self) -> impl Iterator<Item = (usize, usize, &TLine)> {
        self.cols
            .iter()
            .enumerate()
            .flat_map(|(ci, c)| c.lines.iter().enumerate().map(move |(li, l)| (ci, li, l)))
    }
}

// Entry-start markers.

/// Inner text of a leading "[...]" label.
fn bracket_label(text: &str) -> Option<&str> {
    let rest = text.trim_start().strip_prefix('[')?;
    let inner = rest[..rest.find(']')?].trim();
    (!inner.is_empty() && inner.chars().count() <= 24 && !inner.contains('[')).then_some(inner)
}

/// Leading "12." / "12. " list number (≤ 3 digits).
fn dotted_number(text: &str) -> Option<&str> {
    let t = text.trim_start();
    let n = t.bytes().take_while(u8::is_ascii_digit).count();
    if n == 0 || n > 3 {
        return None;
    }
    let mut rest = t[n..].strip_prefix('.')?.chars();
    match rest.next() {
        None => Some(&t[..n]),
        Some(c) if c.is_whitespace() || c.is_uppercase() => Some(&t[..n]),
        _ => None,
    }
}

fn starts_with_number(text: &str, n: &str) -> bool {
    bracket_label(text) == Some(n) || (n.len() <= 3 && dotted_number(text) == Some(n))
}

/// First digit run of a link label ("[47]" → "47", "Fig. 3" → "3").
/// A dotted section number ("4.1") is not a list number: None.
fn label_number(label: &str) -> Option<&str> {
    let s = label.find(|c: char| c.is_ascii_digit())?;
    let n = label[s..].bytes().take_while(u8::is_ascii_digit).count();
    let rest = label[s + n..].as_bytes();
    let section = rest.first() == Some(&b'.') && rest.get(1).is_some_and(u8::is_ascii_digit);
    (n <= 6 && !section).then(|| &label[s..s + n])
}

fn is_references_heading(text: &str) -> bool {
    let t = text.trim();
    // Drop a leading section number ("7", "7.", "VII.").
    let t = match t.split_once(char::is_whitespace) {
        Some((head, rest)) => {
            let h = head.trim_end_matches('.');
            if !h.is_empty() && h.chars().all(|c| c.is_ascii_digit() || "IVXLC".contains(c)) {
                rest
            } else {
                t
            }
        }
        None => t,
    };
    let squashed: String = t.chars().filter(|c| !c.is_whitespace()).collect();
    let squashed = squashed.trim_end_matches([':', '.']).to_lowercase();
    matches!(
        squashed.as_str(),
        "references"
            | "reference"
            | "bibliography"
            | "referencesandnotes"
            | "literaturecited"
            | "workscited"
            | "citedreferences"
            | "literature"
    )
}

/// A major heading that ends a bibliography (Appendix, Supplementary, "A
/// Proofs" in a heading-sized font).
fn is_section_break(ln: &TLine, page_font: f32) -> bool {
    let t = ln.text.trim();
    if t.chars().count() > 90 {
        return false;
    }
    let lower = t.to_lowercase();
    let lower = lower.trim_start_matches(|c: char| !c.is_alphabetic());
    if lower.starts_with("appendix") || lower.starts_with("supplementary") || lower.starts_with("supplemental") {
        return true;
    }
    ln.font_size >= 1.15 * page_font && !is_references_heading(t) && {
        let mut words = t.split_whitespace();
        let first = words.next().unwrap_or("");
        let numbered = first.trim_end_matches('.').split('.').all(|p| {
            !p.is_empty()
                && (p.chars().all(|c| c.is_ascii_digit())
                    || (p.len() == 1 && p.chars().all(|c| c.is_ascii_uppercase())))
        });
        numbered && words.next().is_some_and(|w| w.chars().next().is_some_and(char::is_uppercase))
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Marker {
    /// "[12]" (numeric) or "[Kaz06]" labels.
    Bracket { numeric: bool },
    /// "12. Author" lists.
    Dotted,
    /// No label: entry starts come from indentation / spacing.
    Plain,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Indent {
    /// Left edge of an entry's first line.
    start: f32,
    /// Left edge of its continuation lines.
    cont: f32,
}

impl Indent {
    fn hanging(&self) -> bool {
        self.start < self.cont
    }
}

#[derive(Debug, Clone, Copy)]
struct EntryCtx {
    marker: Marker,
    indent: Option<Indent>,
    /// Left edge shared by the column's continuation lines. A non-start line
    /// elsewhere (figure labels, a caption, a centred page number) is not
    /// part of any entry.
    cont: Option<f32>,
}

impl EntryCtx {
    fn learn(col: &Column, around: usize, marker: Marker, hanging: Option<bool>) -> EntryCtx {
        let indent = if marker == Marker::Plain { learn_indent(col, around, hanging) } else { None };
        let mut ctx = EntryCtx { marker, indent, cont: indent.map(|i| i.cont) };
        if ctx.cont.is_none() && (marker != Marker::Plain || indent.is_some()) {
            let mut lefts: Vec<f32> = window(col, around)
                .into_iter()
                .filter(|&i| {
                    let prev = i.checked_sub(1).map(|p| &col.lines[p]);
                    !is_entry_start(&col.lines[i], prev, col, &ctx)
                })
                .map(|i| col.lines[i].left)
                .collect();
            lefts.sort_by(|a, b| a.total_cmp(b));
            let mut best: Option<(usize, f32)> = None;
            let mut i = 0;
            while i < lefts.len() {
                let j = lefts[i..].iter().take_while(|&&x| x - lefts[i] <= 1.2).count();
                if j >= 3 && best.is_none_or(|b| j > b.0) {
                    best = Some((j, lefts[i..i + j].iter().sum::<f32>() / j as f32));
                }
                i += j;
            }
            ctx.cont = best.map(|b| b.1);
        }
        ctx
    }

    fn off_grid(&self, ln: &TLine) -> bool {
        self.cont.is_some_and(|c| (ln.left - c).abs() > 2.5)
    }
}

/// Learns the two left edges of a hanging-indent (or first-line-indent)
/// list from the lines around `around`: the two most common lefts (±1.2 pt),
/// 2.5–40 pt apart, covering ≥ 70 % of the window. Which one starts an
/// entry: the one whose preceding line is more often short (an entry's last
/// line ends early; a justified continuation's predecessor is full width);
/// `hanging` overrides that when already known from another column.
/// Body-line indices around `around` (15 above, 30 below) set in the same
/// font size (±4 %): a bibliography's geometry, not the body text above it.
fn window(col: &Column, around: usize) -> Vec<usize> {
    let (bs, be) = col.body;
    let lo = around.saturating_sub(15).max(bs);
    let hi = (around + 30).min(be);
    let fs = col.lines.get(around).map(|l| l.font_size).unwrap_or(col.font);
    let tol = (0.04 * fs).max(0.3);
    (lo..hi).filter(|&i| (col.lines[i].font_size - fs).abs() <= tol).collect()
}

fn learn_indent(col: &Column, around: usize, hanging: Option<bool>) -> Option<Indent> {
    let idx = window(col, around);
    if idx.len() < 4 {
        return None;
    }
    let win: Vec<&TLine> = idx.iter().map(|&i| &col.lines[i]).collect();
    let mut lefts: Vec<f32> = win.iter().map(|l| l.left).collect();
    lefts.sort_by(|a, b| a.total_cmp(b));
    // (sum, count, last)
    let mut clusters: Vec<(f32, usize, f32)> = Vec::new();
    for x in lefts {
        match clusters.last_mut() {
            Some(c) if x - c.2 <= 1.2 => {
                c.0 += x;
                c.1 += 1;
                c.2 = x;
            }
            _ => clusters.push((x, 1, x)),
        }
    }
    clusters.sort_by(|a, b| b.1.cmp(&a.1));
    if clusters.len() < 2
        || clusters[1].1 < 2
        || (clusters[0].1 + clusters[1].1) * 10 < win.len() * 7
    {
        return None;
    }
    let m0 = clusters[0].0 / clusters[0].1 as f32;
    let m1 = clusters[1].0 / clusters[1].1 as f32;
    let (a, b) = (m0.min(m1), m0.max(m1));
    if !(2.5..=40.0).contains(&(b - a)) {
        return None;
    }
    let hanging = hanging.unwrap_or_else(|| {
        let right = win.iter().map(|l| l.right).fold(f32::MIN, f32::max);
        let short_frac = |x: f32| {
            let (mut n, mut short) = (0usize, 0usize);
            for &i in idx.iter().filter(|&&i| i > 0) {
                if (col.lines[i].left - x).abs() <= 1.2 {
                    n += 1;
                    if col.lines[i - 1].right < right - 6.0 {
                        short += 1;
                    }
                }
            }
            if n == 0 { 0.0 } else { short as f32 / n as f32 }
        };
        short_frac(b) <= short_frac(a) + 0.25
    });
    Some(if hanging { Indent { start: a, cont: b } } else { Indent { start: b, cont: a } })
}

fn is_heading(ln: &TLine, col: &Column) -> bool {
    is_references_heading(&ln.text)
        || (ln.font_size >= 1.15 * col.font && ln.text.chars().count() < 80)
}

fn is_entry_start(ln: &TLine, prev: Option<&TLine>, col: &Column, ctx: &EntryCtx) -> bool {
    match ctx.marker {
        Marker::Bracket { numeric } => bracket_label(&ln.text).is_some_and(|inner| {
            if numeric {
                inner.chars().all(|c| c.is_ascii_digit())
            } else {
                !inner.contains(char::is_whitespace)
                    && inner.chars().count() <= 12
                    && !inner.eq_ignore_ascii_case("online")
            }
        }),
        Marker::Dotted => dotted_number(&ln.text).is_some(),
        Marker::Plain => match ctx.indent {
            Some(ind) => (ln.left - ind.start).abs() <= 1.5 && (ln.left - ind.cont).abs() > 1.5,
            None => prev.is_some_and(|p| {
                // No structure to learn from: extra leading, or the previous
                // line ends a sentence well short of the column edge.
                let pitch = ln.bottom - p.bottom;
                pitch > col.pitch + (0.15 * col.pitch).max(1.5)
                    || (p.text.trim_end().ends_with('.') && p.right < col.x1 - 0.08 * (col.x1 - col.x0))
            }),
        },
    }
}

/// Joins lines: a line ending in a hyphen before a lowercase word is
/// dehyphenated ("segmen-" + "tation"); before anything else the hyphen is
/// kept without a space ("Boundary-" + "Aware"). En-dash ends join tight.
fn join_lines<'a>(lines: impl IntoIterator<Item = &'a str>) -> String {
    let mut out = String::new();
    for t in lines {
        let t = t.trim();
        if t.is_empty() {
            continue;
        }
        match out.chars().last() {
            None => {}
            Some(c) if is_hyphen(c) => {
                out.pop();
                if !t.chars().next().is_some_and(char::is_lowercase) {
                    out.push('-');
                }
            }
            Some('\u{2013}') => {}
            Some(_) => out.push(' '),
        }
        out.push_str(t);
    }
    out.replace('\u{AD}', "").replace('\u{2}', "-")
}

fn cap_text(mut s: String, max: usize) -> String {
    if let Some((i, _)) = s.char_indices().nth(max) {
        s.truncate(i);
        s = s.trim_end().to_string();
        s.push('\u{2026}');
    }
    s
}

fn union_box<'a>(lines: impl IntoIterator<Item = &'a TLine>) -> Option<Region> {
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for l in lines {
        x0 = x0.min(l.left);
        y0 = y0.min(l.top);
        x1 = x1.max(l.right);
        y1 = y1.max(l.bottom);
    }
    (x1 >= x0).then(|| Region { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
}

/// Line the destination points at: with a number label, a line starting
/// "[N]" / "N." near `dest_y` (dests usually sit a little above the line);
/// else the nearest line in the destination's column, preferring lines that
/// start an entry (so a raised dest never picks the previous entry's tail).
fn find_anchor(
    lay: &PageLayout,
    dest_x: Option<f32>,
    dest_y: f32,
    num: Option<&str>,
) -> Option<(usize, usize)> {
    let hint = dest_x.and_then(|x| lay.column_at(x));
    if let Some(n) = num {
        let mut best: Option<(f32, usize, usize)> = None;
        for (ci, li, ln) in lay.reading_order() {
            let d = ln.top - dest_y;
            if !starts_with_number(&ln.text, n) || !(-20.0..=40.0).contains(&d) {
                continue;
            }
            let score = d.abs() + if hint.is_some_and(|h| h != ci) { 25.0 } else { 0.0 };
            if best.is_none_or(|b| score < b.0) {
                best = Some((score, ci, li));
            }
        }
        if let Some((_, ci, li)) = best {
            return Some((ci, li));
        }
    }
    let cols: Vec<usize> = match hint {
        Some(h) => vec![h],
        None => (0..lay.cols.len()).collect(),
    };
    // (score, ci, li) of the best line overall and of the best entry start.
    let mut any: Option<(f32, usize, usize)> = None;
    let mut start: Option<(f32, usize, usize)> = None;
    for &ci in &cols {
        let col = &lay.cols[ci];
        let (bs, be) = col.body;
        let near = (bs..be)
            .min_by(|&a, &b| {
                (col.lines[a].top - dest_y).abs().total_cmp(&(col.lines[b].top - dest_y).abs())
            })
            .unwrap_or(bs);
        let bracketed = (bs..be).filter(|&i| bracket_label(&col.lines[i].text).is_some()).count();
        let marker = if bracketed * 3 >= (be - bs).max(1) {
            Marker::Bracket { numeric: false }
        } else {
            Marker::Plain
        };
        let ctx = EntryCtx { marker, indent: learn_indent(col, near, None), cont: None };
        let structured = ctx.marker != Marker::Plain || ctx.indent.is_some();
        for li in bs..be {
            let ln = &col.lines[li];
            let delta = ln.top - dest_y;
            let contains = ln.top <= dest_y && dest_y <= ln.bottom;
            if !((-12.0..=16.0).contains(&delta) || contains) {
                continue;
            }
            let score = if delta >= 0.0 { delta } else { -delta * 1.3 };
            if any.is_none_or(|b| score < b.0) {
                any = Some((score, ci, li));
            }
            let prev = li.checked_sub(1).map(|p| &col.lines[p]);
            let starts = is_heading(ln, col) || (structured && is_entry_start(ln, prev, col, &ctx));
            if starts && start.is_none_or(|b| score < b.0) {
                start = Some((score, ci, li));
            }
        }
    }
    match (start, any) {
        (Some(s), Some(a)) if s.0 <= a.0 + 10.0 => return Some((s.1, s.2)),
        (_, Some(a)) => return Some((a.1, a.2)),
        _ => {}
    }
    // Nothing near: first line below the destination.
    cols.iter()
        .filter_map(|&ci| {
            let col = &lay.cols[ci];
            (col.body.0..col.body.1)
                .find(|&li| col.lines[li].top >= dest_y && col.lines[li].top <= dest_y + 60.0)
                .map(|li| (col.lines[li].top - dest_y, ci, li))
        })
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, ci, li)| (ci, li))
}

type LayoutFn<'a> = dyn FnMut(u32) -> Option<Arc<PageLayout>> + 'a;

/// Whether the anchor sits under a References/Bibliography heading: scans
/// backwards in reading order (this page, then up to 10 earlier pages); a
/// section break (Appendix, …) met first means no.
fn under_references_heading(get: &mut LayoutFn, page: u32, ci: usize, li: usize) -> bool {
    for p in (page.saturating_sub(HEADING_LOOKBACK_PAGES)..=page).rev() {
        let Some(lay) = get(p) else { continue };
        let lines: Vec<&TLine> = lay
            .reading_order()
            .take_while(|&(c, l, _)| p != page || (c, l) < (ci, li))
            .map(|(_, _, l)| l)
            .collect();
        for ln in lines.iter().rev() {
            if is_references_heading(&ln.text) {
                return true;
            }
            if is_section_break(ln, lay.font) {
                return false;
            }
        }
    }
    false
}

/// Leading "Figure 3" / "Fig. 3" / "Table 3" / "Algorithm 3" number, and
/// whether ':' / '.' / '|' follows it (a caption, not running text).
fn caption_number(text: &str) -> Option<(&str, bool)> {
    let t = text.trim_start();
    let lower = t.to_ascii_lowercase();
    let prefix = ["figure", "fig.", "fig", "table", "tab.", "algorithm", "alg."]
        .iter()
        .find(|p| lower.starts_with(*p))?;
    let rest = t.get(prefix.len()..)?.trim_start();
    let rest = rest.strip_prefix('S').unwrap_or(rest);
    let n = rest.bytes().take_while(u8::is_ascii_digit).count();
    if n == 0 {
        return None;
    }
    let after = rest[n..].chars().next();
    if after.is_some_and(|c| c.is_alphanumeric()) {
        return None;
    }
    Some((&rest[..n], after.is_some_and(|c| matches!(c, ':' | '.' | '|'))))
}

/// End (byte index, exclusive) of the first sentence at or after `from`.
fn sentence_end(text: &str, from: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    for (i, c) in text.char_indices() {
        if i < from || c != '.' {
            continue;
        }
        if bytes.get(i + 1).is_some_and(|b| !b.is_ascii_whitespace()) {
            continue;
        }
        let word = text[..i].rsplit(char::is_whitespace).next().unwrap_or("").to_lowercase();
        if word.chars().count() <= 1
            || ["al", "e.g", "i.e", "vs", "fig", "eq", "etc", "cf", "sec", "resp"].contains(&word.as_str())
        {
            continue;
        }
        return Some(i + 1);
    }
    None
}

/// "Figure N" caption for a figure/table target: a strong caption (number
/// followed by ':' '.' '|') anywhere on the page, nearest at or below the
/// destination (hypcap dests sit at the float's top, the caption can be a
/// page below); a weak one only within 30 pt above … 450 pt below and when
/// the label itself names a figure/table. Returns the caption's first
/// sentence and the lines it uses.
fn caption_entry(lay: &PageLayout, n: &str, label: &str, dest_y: f32) -> Option<(String, Vec<TLine>)> {
    let figure_label = {
        let l = label.to_lowercase();
        l.contains("fig") || l.contains("tab") || l.contains("alg")
    };
    let (_, c, l) = lay
        .reading_order()
        .filter_map(|(c, l, ln)| {
            let (cn, strong) = caption_number(&ln.text)?;
            let d = ln.top - dest_y;
            if cn != n || !(strong || (figure_label && (-30.0..=450.0).contains(&d))) {
                return None;
            }
            // Below (or just above) the dest first, then by distance.
            let rank = if d >= -30.0 { d.abs() } else { 10_000.0 - d };
            Some((rank, c, l))
        })
        .min_by(|a, b| a.0.total_cmp(&b.0))?;
    let col = &lay.cols[c];
    let mut used: Vec<TLine> = vec![col.lines[l].clone()];
    for i in (l + 1)..col.body.1.min(l + 8) {
        let (p, ln) = (&col.lines[i - 1], &col.lines[i]);
        if ln.bottom - p.bottom > 1.6 * col.pitch || is_heading(ln, col) || caption_number(&ln.text).is_some() {
            break;
        }
        used.push(ln.clone());
    }
    let joined = join_lines(used.iter().map(|l| l.text.as_str()));
    let skip = joined.find(n).map(|i| (i + n.len() + 1).min(joined.len())).unwrap_or(0);
    let text = match sentence_end(&joined, skip) {
        Some(end) => joined[..end].to_string(),
        None => joined,
    };
    // Box only the lines the sentence uses.
    let mut acc = 0usize;
    let keep = used
        .iter()
        .take_while(|l| {
            let fits = acc < text.len();
            acc += l.text.len() + 1;
            fits
        })
        .count()
        .max(1);
    used.truncate(keep);
    Some((cap_text(text, OTHER_MAX_CHARS), used))
}

/// Equation target: the line ending in "(N)" just below the destination.
fn equation_line(lay: &PageLayout, n: &str, dest_y: f32) -> Option<TLine> {
    let tag = format!("({n})");
    lay.reading_order()
        .filter(|(_, _, ln)| {
            let d = ln.top - dest_y;
            (-20.0..=80.0).contains(&d) && ln.text.split_whitespace().collect::<String>().ends_with(&tag)
        })
        .min_by(|a, b| (a.2.top - dest_y).abs().total_cmp(&(b.2.top - dest_y).abs()))
        .map(|(_, _, ln)| ln.clone())
}

/// Figure/table/equation/section/footnote targets: a caption's first
/// sentence, an equation line, else the anchor line.
fn other_entry(
    lay: &PageLayout,
    anchor: Option<&TLine>,
    num: Option<&str>,
    label: &str,
    dest_y: f32,
) -> Option<(String, Vec<TLine>)> {
    let anchor_numbered = anchor.is_some_and(|a| {
        num.is_some_and(|n| a.text.trim_start().starts_with(n)) || is_references_heading(&a.text)
    });
    if let Some(n) = num.filter(|_| !anchor_numbered) {
        if let Some(hit) = caption_entry(lay, n, label, dest_y) {
            return Some(hit);
        }
        if let Some(eq) = equation_line(lay, n, dest_y) {
            return Some((cap_text(eq.text.clone(), OTHER_MAX_CHARS), vec![eq]));
        }
    }
    let a = anchor?;
    Some((cap_text(a.text.clone(), OTHER_MAX_CHARS), vec![a.clone()]))
}

/// Core of `link_entry` over a page-layout accessor (tests feed synthetic
/// layouts).
fn entry_from_layouts(
    get: &mut LayoutFn,
    page_count: u32,
    dest_page: u32,
    dest_x: Option<f32>,
    dest_y: f32,
    label: &str,
) -> Option<LinkEntry> {
    let lay = get(dest_page)?;
    let num = label_number(label);
    let other = |anchor: Option<&TLine>| {
        let (text, used) = other_entry(&lay, anchor, num, label, dest_y)?;
        let b = union_box(&used)?;
        Some(LinkEntry { text, kind: "other", x: b.x, y: b.y, w: b.w, h: b.h })
    };
    let Some((ci, li)) = find_anchor(&lay, dest_x, dest_y, num) else {
        // Nothing near the dest (a figure image at a hypcap anchor).
        return other(None);
    };
    let col = &lay.cols[ci];
    let anchor = &col.lines[li];

    let marker = match (bracket_label(&anchor.text), dotted_number(&anchor.text)) {
        (Some(inner), _) => Marker::Bracket { numeric: inner.chars().all(|c| c.is_ascii_digit()) },
        (None, Some(d)) if num == Some(d) => Marker::Dotted,
        _ => Marker::Plain,
    };
    // A heading itself (a link to "References" or "Appendix A") is a
    // section target, not an entry under it.
    let is_reference = marker == Marker::Bracket { numeric: true }
        || (!is_heading(anchor, col)
            && !is_section_break(anchor, lay.font)
            && under_references_heading(get, dest_page, ci, li));

    if !is_reference {
        return other(Some(anchor));
    }

    let mut ctx = EntryCtx::learn(col, li, marker, None);
    let mut parts: Vec<(u32, TLine)> = vec![(dest_page, anchor.clone())];
    let mut chars = anchor.text.chars().count();

    // Walk down the anchor's column; an entry cut off by the column bottom
    // continues at the top of the next column / the next page's first column.
    let mut page = dest_page;
    let mut cur = Arc::clone(&lay);
    let (mut c, mut from, mut continuing) = (ci, li + 1, false);
    for _ in 0..3 {
        let column = &cur.cols[c];
        let mut prev: Option<&TLine> = if continuing { None } else { Some(&column.lines[li]) };
        let mut ended = false;
        let mut skipped = 0;
        for ln in column.lines.iter().take(column.body.1).skip(from) {
            if let Some(p) = prev {
                if ln.bottom - p.bottom > 1.6 * column.pitch {
                    ended = true;
                    break;
                }
            }
            if is_heading(ln, column) || is_entry_start(ln, prev, column, &ctx) {
                ended = true;
                break;
            }
            if ctx.off_grid(ln) {
                // Material above the flow at the top of the next column
                // (a figure's labels / caption) is skipped; anywhere else an
                // off-grid line ends the entry.
                if prev.is_none() && skipped < 12 {
                    skipped += 1;
                    continue;
                }
                ended = true;
                break;
            }
            parts.push((page, ln.clone()));
            chars += ln.text.chars().count() + 1;
            if chars >= ENTRY_MAX_CHARS {
                ended = true;
                break;
            }
            prev = Some(ln);
        }
        if ended {
            break;
        }
        let src_indent = ctx.indent;
        let src_cont = ctx.cont;
        let src_x0 = column.x0;
        if c + 1 < cur.cols.len() {
            c += 1;
        } else if page + 1 < page_count {
            let Some(next) = get(page + 1) else { break };
            if next.cols.is_empty() {
                break;
            }
            page += 1;
            cur = next;
            c = 0;
        } else {
            break;
        }
        let next_col = &cur.cols[c];
        from = next_col.body.0;
        continuing = true;
        let hanging = src_indent.map(|i| i.hanging());
        ctx = EntryCtx::learn(next_col, from, ctx.marker, hanging);
        let shift = next_col.x0 - src_x0;
        if ctx.marker == Marker::Plain && ctx.indent.is_none() {
            ctx.indent = src_indent.map(|i| Indent { start: i.start + shift, cont: i.cont + shift });
        }
        if ctx.cont.is_none() {
            ctx.cont = ctx.indent.map(|i| i.cont).or(src_cont.map(|c| c + shift));
        }
    }

    let text = cap_text(join_lines(parts.iter().map(|(_, l)| l.text.as_str())), ENTRY_MAX_CHARS);
    let b = union_box(parts.iter().filter(|(p, _)| *p == dest_page).map(|(_, l)| l))?;
    Some(LinkEntry { text, kind: "reference", x: b.x, y: b.y, w: b.w, h: b.h })
}

fn page_layout(doc: &Doc, index: u32) -> Result<Arc<PageLayout>, String> {
    if let Some(hit) = doc.layouts.lock().unwrap_or_else(|p| p.into_inner()).get(&index) {
        return Ok(Arc::clone(hit));
    }
    // Reuse a cached page's text; otherwise load the page outside the page
    // cache (like link targets) so the viewer's pages are not evicted.
    let cached = doc
        .pages
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .find(|p| p.index == index)
        .cloned();
    let layout = match cached {
        Some(p) => {
            let (w, h) = PageFrame::from_page(p.page()).display_size();
            PageLayout::build(p.text()?, w, h)
        }
        None => {
            let page = load_page(doc, index)?;
            let (w, h) = PageFrame::from_page(&page).display_size();
            PageLayout::build(&extract_text(&page)?, w, h)
        }
    };
    let layout = Arc::new(layout);
    let mut memo = doc.layouts.lock().unwrap_or_else(|p| p.into_inner());
    if memo.len() >= LAYOUT_MEMO {
        memo.clear();
    }
    memo.insert(index, Arc::clone(&layout));
    Ok(layout)
}

/// The text an internal link points at (see the section comment). `label`
/// is the link's own text on the source page; its digits select "[N]".
pub fn link_entry(
    doc: &Doc,
    dest_page: u32,
    dest_x: Option<f32>,
    dest_y: f32,
    label: &str,
) -> Result<Option<LinkEntry>, String> {
    let count = doc.doc.pages().len().max(0) as u32;
    if dest_page >= count || !dest_y.is_finite() {
        return Ok(None);
    }
    let mut get = |p: u32| -> Option<Arc<PageLayout>> {
        if p >= count { None } else { page_layout(doc, p).ok() }
    };
    Ok(entry_from_layouts(&mut get, count, dest_page, dest_x.filter(|x| x.is_finite()), dest_y, label))
}

/// Visible text under a display-space box (a link's label): chars whose
/// centre lies inside it, whitespace-normalized.
pub fn text_in_box(text: &TextPage, r: &Region) -> String {
    let mut out = String::new();
    for (i, ch) in text.chars.iter().enumerate() {
        let (cx, cy) = (ch.x + ch.w / 2.0, ch.y + ch.h / 2.0);
        if (ch.w > 0.0 || ch.h > 0.0)
            && cx >= r.x - 1.0
            && cx <= r.x + r.w + 1.0
            && cy >= r.y - 1.0
            && cy <= r.y + r.h + 1.0
        {
            out.push_str(&ch.c);
            if text.line_breaks.binary_search(&(i as u32)).is_ok() {
                out.push(' ');
            }
        }
    }
    out.replace(['\u{2}', '\u{AD}'], "").split_whitespace().collect::<Vec<_>>().join(" ")
}

// ── Metadata ──

/// Info-dictionary strings (`FPDF_GetMetaText`). No XMP: pdfium-render 0.9.4
/// exposes only `PdfDocumentMetadataTagType` Info keys and PDFium's public API
/// has no accessor for the catalog `/Metadata` stream.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keywords: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub producer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mod_date: Option<String>,
}

pub fn metadata(doc: &Doc) -> Metadata {
    use PdfDocumentMetadataTagType as T;
    let meta = doc.doc.metadata();
    let get = |t: T| {
        meta.get(t)
            .map(|tag| tag.value().trim().to_string())
            .filter(|s| !s.is_empty())
    };
    Metadata {
        title: get(T::Title),
        author: get(T::Author),
        subject: get(T::Subject),
        keywords: get(T::Keywords),
        creator: get(T::Creator),
        producer: get(T::Producer),
        creation_date: get(T::CreationDate),
        mod_date: get(T::ModificationDate),
    }
}

// ── Commands ──

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfiumStatus {
    pub available: bool,
    pub version: Option<String>,
    pub error: Option<String>,
    pub library: Option<String>,
}

#[derive(Serialize)]
pub struct PageSize {
    pub width: f32,
    pub height: f32,
}

#[derive(Serialize)]
pub struct OpenResult {
    pub id: u32,
    pub pages: Vec<PageSize>,
}

// ── Worker thread ──
//
// Every PDFium call — binding, open, page load, render, close — runs on ONE
// dedicated thread. The crate's `thread_safe` feature only serializes
// individual FFI calls; interleaving a document's lifecycle across the
// blocking pool's threads is exactly the kind of use PDFium is not designed
// for, and a debug build died with STATUS_HEAP_CORRUPTION under that model.
// Documents are therefore created, used and dropped on this thread only.

type Job = Box<dyn FnOnce() + Send + 'static>;

static WORKER: OnceLock<Mutex<Option<mpsc::Sender<Job>>>> = OnceLock::new();

fn worker_sender() -> Option<mpsc::Sender<Job>> {
    let slot = WORKER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("hyji-pdfium".into())
            .spawn(move || {
                for job in rx {
                    job();
                }
            })
            .expect("spawn PDFium worker thread");
        Mutex::new(Some(tx))
    });
    slot.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let tx = worker_sender().ok_or_else(|| "PDFium is shutting down".to_string())?;
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    tx.send(Box::new(move || {
        let _ = reply_tx.send(f());
    }))
    .map_err(|_| "PDFium worker is not running".to_string())?;
    reply_rx
        .await
        .map_err(|_| "PDFium task was dropped".to_string())?
}

/// App exit: close every cached document on the worker thread and stop
/// accepting jobs, so PDFium's own teardown (DLL detach) never runs over
/// live documents. Blocks briefly; called from `RunEvent::ExitRequested`.
pub fn shutdown() {
    let Some(slot) = WORKER.get() else { return };
    let tx = slot.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(tx) = tx {
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let _ = tx.send(Box::new(move || {
            cache().by_id.clear();
            let _ = done_tx.send(());
        }));
        drop(tx);
        let _ = done_rx.recv_timeout(std::time::Duration::from_secs(5));
    }
}

#[tauri::command]
pub async fn pdfium_status(app: AppHandle) -> PdfiumStatus {
    blocking(move || {
        Ok(match ENGINE.get_or_init(|| bind(&app)) {
            Ok(e) => PdfiumStatus {
                available: true,
                version: e.version.clone(),
                error: None,
                library: Some(e.library.to_string_lossy().into_owned()),
            },
            Err(msg) => PdfiumStatus {
                available: false,
                version: None,
                error: Some(msg.clone()),
                library: None,
            },
        })
    })
    .await
    .unwrap_or_else(|e| PdfiumStatus {
        available: false,
        version: None,
        error: Some(e),
        library: None,
    })
}

#[tauri::command]
pub async fn pdfium_open(
    app: AppHandle,
    path: String,
    exclusive: Option<bool>,
) -> Result<OpenResult, String> {
    // `exclusive`: a private handle that is never shared with (or reused by)
    // the viewer. PDFium keeps every object it parses alive until the
    // document is closed, so a whole-document scan (search indexing) on the
    // viewer's shared handle would pin hundreds of MB for a 260 MB volume
    // for as long as the tab stays open. Background scans open exclusively
    // and close when done; the viewer's handle only ever parses viewed pages.
    let exclusive = exclusive.unwrap_or(false);
    blocking(move || {
        let engine = engine(&app)?;
        let key = doc_key(&path)?;

        let (id, doc) = {
            let mut c = cache();
            let existing = if exclusive {
                None
            } else {
                c.by_id
                    .iter_mut()
                    .find(|(_, e)| e.shared && e.doc.key == key)
                    .map(|(id, e)| {
                        e.refs += 1;
                        (*id, Arc::clone(&e.doc))
                    })
            };
            match existing {
                Some(hit) => hit,
                None => {
                    let doc = Arc::new(Doc::open(&engine.pdfium, &path)?);
                    let id = c.next_id;
                    c.next_id += 1;
                    c.by_id.insert(id, Entry { doc: Arc::clone(&doc), refs: 1, shared: !exclusive });
                    (id, doc)
                }
            }
        };

        // FPDF_GetPageSizeByIndexF: display size (CropBox + /Rotate applied)
        // without loading — and content-parsing — every page.
        let pages = doc
            .doc
            .pages()
            .page_sizes()
            .map_err(perr)?
            .into_iter()
            .map(|r| PageSize { width: r.width().value, height: r.height().value })
            .collect();
        Ok(OpenResult { id, pages })
    })
    .await
}

#[tauri::command]
pub async fn pdfium_close(id: u32) -> Result<(), String> {
    blocking(move || {
        let mut c = cache();
        if let Some(e) = c.by_id.get_mut(&id) {
            e.refs = e.refs.saturating_sub(1);
            if e.refs == 0 {
                c.by_id.remove(&id);
            }
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn pdfium_close_path(path: String) -> Result<(), String> {
    blocking(move || {
        // A file that no longer exists cannot be canonicalized; compare by
        // canonical path only, ignoring mtime/len, so a rewritten file is
        // dropped too.
        let canonical = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
        cache().by_id.retain(|_, e| e.doc.key.0 != canonical);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn pdfium_render(
    app: AppHandle,
    id: u32,
    page: u32,
    width: u32,
    height: u32,
    annotations: bool,
) -> Result<tauri::ipc::Response, String> {
    blocking(move || {
        engine(&app)?;
        let doc = lookup(id)?;
        let p = doc.page(page)?;
        render_rgba(p.page(), width, height, annotations)
    })
    .await
    .map(tauri::ipc::Response::new)
}

#[tauri::command]
pub async fn pdfium_render_region(
    app: AppHandle,
    id: u32,
    page: u32,
    scale: f32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    annotations: bool,
) -> Result<tauri::ipc::Response, String> {
    blocking(move || {
        engine(&app)?;
        let doc = lookup(id)?;
        let p = doc.page(page)?;
        render_region_rgba(p.page(), scale, x, y, width, height, annotations)
    })
    .await
    .map(tauri::ipc::Response::new)
}

#[tauri::command]
pub async fn pdfium_render_png_to_file(
    app: AppHandle,
    id: u32,
    page: u32,
    scale: f32,
    annotations: bool,
    out_path: String,
) -> Result<PngResult, String> {
    blocking(move || {
        engine(&app)?;
        let doc = lookup(id)?;
        let p = doc.page(page)?;
        render_png_to_file(p.page(), scale, annotations, Path::new(&out_path))
    })
    .await
}

#[tauri::command]
pub async fn pdfium_text(app: AppHandle, id: u32, page: u32) -> Result<TextPage, String> {
    blocking(move || {
        engine(&app)?;
        let doc = lookup(id)?;
        doc.page(page)?.text().cloned()
    })
    .await
}

#[tauri::command]
pub async fn pdfium_page_text(app: AppHandle, id: u32, page: u32) -> Result<String, String> {
    blocking(move || {
        engine(&app)?;
        let doc = lookup(id)?;
        Ok(plain_text(doc.page(page)?.text()?))
    })
    .await
}

#[tauri::command]
pub async fn pdfium_search(
    app: AppHandle,
    id: u32,
    page: u32,
    query: String,
    match_case: bool,
) -> Result<Vec<SearchMatch>, String> {
    blocking(move || {
        engine(&app)?;
        let doc = lookup(id)?;
        Ok(search_text(doc.page(page)?.text()?, &query, match_case))
    })
    .await
}

#[tauri::command]
pub async fn pdfium_links(app: AppHandle, id: u32, page: u32) -> Result<Vec<Link>, String> {
    blocking(move || {
        engine(&app)?;
        let doc = lookup(id)?;
        page_links(&doc, page)
    })
    .await
}

/// Citation hover card: the bibliography entry (or caption / first line)
/// a page link points at. Arguments are the link's `destPage` / `destX` /
/// `destY` and its label text on the source page.
#[tauri::command]
pub async fn pdfium_link_entry(
    app: AppHandle,
    id: u32,
    dest_page: u32,
    dest_x: Option<f32>,
    dest_y: f32,
    label: String,
) -> Result<Option<LinkEntry>, String> {
    blocking(move || {
        engine(&app)?;
        let doc = lookup(id)?;
        link_entry(&doc, dest_page, dest_x, dest_y, &label)
    })
    .await
}

#[tauri::command]
pub async fn pdfium_metadata(app: AppHandle, id: u32) -> Result<Metadata, String> {
    blocking(move || {
        engine(&app)?;
        let doc = lookup(id)?;
        Ok(metadata(&doc))
    })
    .await
}

#[tauri::command]
pub async fn pdfium_image_regions(
    app: AppHandle,
    id: u32,
    page: u32,
) -> Result<Vec<Region>, String> {
    blocking(move || {
        engine(&app)?;
        let doc = lookup(id)?;
        let p = doc.page(page)?;
        Ok(image_regions(p.page()))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(quarter_turns: u32) -> PageFrame {
        // CropBox [50 60 560 700] → 510 × 640 unrotated.
        PageFrame { left: 50.0, bottom: 60.0, w0: 510.0, h0: 640.0, quarter_turns }
    }

    #[test]
    fn version_file_next_to_dll_is_parsed() {
        let dll = Path::new(env!("CARGO_MANIFEST_DIR")).join("pdfium/pdfium.dll");
        if !dll.is_file() {
            return; // DLL not fetched in this checkout
        }
        assert_eq!(read_version(&dll).as_deref(), Some("156.0.8066.0"));
    }

    fn tp(chars: &[(&str, f32, f32, f32, f32, i32)], breaks: &[u32]) -> TextPage {
        TextPage {
            chars: chars
                .iter()
                .map(|&(c, x, y, w, h, rot)| TextChar {
                    c: c.into(),
                    x,
                    y,
                    w,
                    h,
                    font_size: h,
                    rot,
                })
                .collect(),
            line_breaks: breaks.to_vec(),
        }
    }

    fn page_of(lines: &[&str]) -> TextPage {
        let mut chars: Vec<TextChar> = Vec::new();
        let mut breaks = Vec::new();
        for (li, l) in lines.iter().enumerate() {
            for (i, c) in l.chars().enumerate() {
                chars.push(TextChar {
                    c: c.to_string(),
                    x: i as f32 * 5.0,
                    y: li as f32 * 12.0,
                    w: 5.0,
                    h: 10.0,
                    font_size: 10.0,
                    rot: 0,
                });
            }
            breaks.push(chars.len() as u32 - 1);
        }
        breaks.pop();
        TextPage { chars, line_breaks: breaks }
    }

    fn slice(t: &TextPage, m: SearchMatch) -> String {
        t.chars[m.start as usize..m.end as usize].iter().map(|c| c.c.as_str()).collect()
    }

    #[test]
    fn search_is_case_insensitive_unless_asked() {
        let t = page_of(&["Gaussian gaussian GAUSSIAN"]);
        assert_eq!(search_text(&t, "gaussian", false).len(), 3);
        assert_eq!(search_text(&t, "Gaussian", true).len(), 1);
        assert_eq!(search_text(&t, "Gaussian", true)[0], SearchMatch { start: 0, end: 8 });
    }

    #[test]
    fn search_whitespace_run_matches_any_run_or_line_break() {
        let t = page_of(&["point   cloud", "boundary-aware", "3D scenes"]);
        let m = search_text(&t, "point cloud", false);
        assert_eq!(m.len(), 1);
        assert_eq!(slice(&t, m[0]), "point   cloud");
        let m = search_text(&t, "aware  3D", false);
        assert_eq!(m.len(), 1);
        assert_eq!(slice(&t, m[0]), "aware3D");
        assert!(search_text(&t, "pointcloud", false).is_empty());
        assert!(search_text(&t, "   ", false).is_empty());
        assert!(search_text(&t, "", false).is_empty());
    }

    #[test]
    fn search_handles_unicode_case_folding_and_cjk() {
        let t = page_of(&["\u{130}stanbul \u{c778}\u{acf5}\u{c9c0}\u{b2a5} \u{ae30}\u{bc18}"]);
        // U+0130 lowercases to two chars; plain "istanbul" must not match.
        assert_eq!(search_text(&t, "istanbul", false).len(), 0);
        assert_eq!(search_text(&t, "\u{130}stanbul", false).len(), 1);
        let m = search_text(&t, "\u{c778}\u{acf5}\u{c9c0}\u{b2a5}", false);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0], SearchMatch { start: 9, end: 13 });
    }

    #[test]
    fn search_matches_are_non_overlapping_in_order() {
        let t = page_of(&["aaaa"]);
        let m = search_text(&t, "aa", false);
        assert_eq!(m, vec![SearchMatch { start: 0, end: 2 }, SearchMatch { start: 2, end: 4 }]);
    }

    #[test]
    fn plain_text_breaks_lines() {
        let t = page_of(&["ab", "cd"]);
        assert_eq!(plain_text(&t), "ab\ncd");
    }

    #[test]
    fn whitespace_boxes_are_synthesized_from_neighbours() {
        let mut chars = tp(
            &[("a", 10.0, 20.0, 5.0, 10.0, 0), (" ", 0.0, 0.0, 0.0, 0.0, 0), ("b", 19.0, 20.0, 5.0, 10.0, 0)],
            &[],
        )
        .chars;
        synthesize_whitespace_boxes(&mut chars, &[]);
        let sp = &chars[1];
        assert_eq!((sp.x, sp.y, sp.w, sp.h), (15.0, 20.0, 4.0, 10.0));
        // Line-ending space with nothing after it on the line: quarter-em wide.
        let mut chars = tp(
            &[("a", 10.0, 20.0, 5.0, 10.0, 0), (" ", 0.0, 0.0, 0.0, 0.0, 0), ("b", 0.0, 40.0, 5.0, 10.0, 0)],
            &[],
        )
        .chars;
        chars[1].font_size = 8.0;
        synthesize_whitespace_boxes(&mut chars, &[1]);
        assert_eq!((chars[1].x, chars[1].w), (15.0, 2.0));
    }

    #[test]
    fn rotation_maps_page_ccw_to_display_cw_plus_page_rotate() {
        use std::f32::consts::FRAC_PI_2;
        assert_eq!(display_rotation(0.0, 0), 0);
        assert_eq!(display_rotation(FRAC_PI_2, 0), 270); // bottom-to-top stamp
        assert_eq!(display_rotation(FRAC_PI_2, 1), 0); // ...on a /Rotate 90 page
        assert_eq!(display_rotation(0.0, 1), 90);
        assert_eq!(display_rotation(0.0, 3), 270);
        assert_eq!(display_rotation(std::f32::consts::PI, 2), 0);
        assert_eq!(display_rotation(0.3, 0), -1);
    }

    #[test]
    fn display_size_swaps_on_odd_rotations() {
        assert_eq!(frame(0).display_size(), (510.0, 640.0));
        assert_eq!(frame(1).display_size(), (640.0, 510.0));
        assert_eq!(frame(2).display_size(), (510.0, 640.0));
        assert_eq!(frame(3).display_size(), (640.0, 510.0));
    }

    #[test]
    fn crop_corners_land_on_display_corners() {
        // Page-space corners of the crop box: TL (50,700) TR (560,700) BL (50,60).
        let (tl, tr, bl) = ((50.0, 700.0), (560.0, 700.0), (50.0, 60.0));
        let f = frame(0);
        assert_eq!(f.to_display(tl.0, tl.1), (0.0, 0.0));
        assert_eq!(f.to_display(tr.0, tr.1), (510.0, 0.0));
        assert_eq!(f.to_display(bl.0, bl.1), (0.0, 640.0));
        // /Rotate 90 (clockwise): the old top-left becomes the top-right.
        let f = frame(1);
        assert_eq!(f.to_display(tl.0, tl.1), (640.0, 0.0));
        assert_eq!(f.to_display(bl.0, bl.1), (0.0, 0.0));
        assert_eq!(f.to_display(tr.0, tr.1), (640.0, 510.0));
        // /Rotate 180: top-left becomes bottom-right.
        let f = frame(2);
        assert_eq!(f.to_display(tl.0, tl.1), (510.0, 640.0));
        assert_eq!(f.to_display(bl.0, bl.1), (510.0, 0.0));
        // /Rotate 270: top-left becomes bottom-left, top-right becomes top-left.
        let f = frame(3);
        assert_eq!(f.to_display(tl.0, tl.1), (0.0, 510.0));
        assert_eq!(f.to_display(tr.0, tr.1), (0.0, 0.0));
    }

    /// Lines `(x, y_top, text, font)` as a TextPage with 5-pt-wide chars.
    fn layout_of(lines: &[(f32, f32, &str, f32)]) -> Arc<PageLayout> {
        let mut chars = Vec::new();
        let mut breaks = Vec::new();
        for &(x, y, text, font) in lines {
            for (i, c) in text.chars().enumerate() {
                chars.push(TextChar {
                    c: c.to_string(),
                    x: x + i as f32 * 5.0,
                    y,
                    w: 5.0,
                    h: 10.0,
                    font_size: font,
                    rot: 0,
                });
            }
            breaks.push(chars.len() as u32 - 1);
        }
        breaks.pop();
        Arc::new(PageLayout::build(&TextPage { chars, line_breaks: breaks }, 612.0, 792.0))
    }

    fn entry(pages: &[Arc<PageLayout>], page: u32, x: Option<f32>, y: f32, label: &str) -> Option<LinkEntry> {
        let mut get = |p: u32| pages.get(p as usize).cloned();
        entry_from_layouts(&mut get, pages.len() as u32, page, x, y, label)
    }

    #[test]
    fn numbered_entry_is_dehyphenated_and_continues_into_next_column() {
        let page = layout_of(&[
            (50.0, 100.0, "References", 14.0),
            (50.0, 120.0, "[1] A. Author. Title one. In CVPR,", 10.0),
            (62.0, 132.0, "2020.", 10.0),
            (50.0, 144.0, "[2] B. Author. Segmen-", 10.0),
            (62.0, 156.0, "tation of things. In ICCV,", 10.0),
            (62.0, 168.0, "2021.", 10.0),
            (50.0, 180.0, "[3] C. Author. A long entry that", 10.0),
            (62.0, 192.0, "runs off the column", 10.0),
            (332.0, 120.0, "bottom into the next. In ECCV, 2022.", 10.0),
            (320.0, 132.0, "[4] D. Author. Four. In NeurIPS, 2023.", 10.0),
            (332.0, 144.0, "Extra line.", 10.0),
            (320.0, 156.0, "[5] E. Author. Five.", 10.0),
            (332.0, 168.0, "More.", 10.0),
        ]);
        assert_eq!(page.cols.len(), 2);
        let pages = [page];
        let e = entry(&pages, 0, Some(50.0), 140.0, "[2]").unwrap();
        assert_eq!(e.kind, "reference");
        assert_eq!(e.text, "[2] B. Author. Segmentation of things. In ICCV, 2021.");
        let e = entry(&pages, 0, None, 176.0, "3,").unwrap();
        assert_eq!(e.text, "[3] C. Author. A long entry that runs off the column bottom into the next. In ECCV, 2022.");
        // Box = union over both columns' lines.
        assert_eq!((e.x, e.y), (50.0, 120.0));
    }

    #[test]
    fn author_year_entry_uses_dest_x_column_and_hanging_indent() {
        let pages = [layout_of(&[
            (50.0, 80.0, "References", 14.0),
            (50.0, 100.0, "ALPHA, A. 2001. First paper tit", 10.0),
            (60.0, 112.0, "goes on. In Proc.", 10.0),
            (50.0, 124.0, "BETA, B. 2002. Second paper tit", 10.0),
            (60.0, 136.0, "more words.", 10.0),
            (50.0, 148.0, "GAMMA, C. 2003. Third paper tit", 10.0),
            (60.0, 160.0, "tail text.", 10.0),
            (320.0, 100.0, "DELTA, D. 2004. Fourth paper ti", 10.0),
            (330.0, 112.0, "continues.", 10.0),
            (320.0, 124.0, "EPS, E. 2005. Fifth paper title", 10.0),
            (330.0, 136.0, "fifth tail.", 10.0),
            (320.0, 148.0, "ZETA, F. 2006. Sixth paper titl", 10.0),
            (330.0, 160.0, "sixth tail.", 10.0),
        ])];
        // Dest sits 15 pt left of the right column (hanging list margin),
        // level with BETA in the left column.
        let e = entry(&pages, 0, Some(305.0), 120.0, "Eps 2005").unwrap();
        assert_eq!(e.kind, "reference");
        assert_eq!(e.text, "EPS, E. 2005. Fifth paper title fifth tail.");
        let e = entry(&pages, 0, Some(35.0), 120.0, "Beta 2002").unwrap();
        assert_eq!(e.text, "BETA, B. 2002. Second paper tit more words.");
    }

    #[test]
    fn figure_target_returns_caption_sentence() {
        let body = "Body text body text body text body text body text body text body text body text x";
        let pages = [layout_of(&[
            (50.0, 100.0, body, 10.0),
            (50.0, 112.0, body, 10.0),
            (50.0, 124.0, body, 10.0),
            (50.0, 400.0, "Figure 3: Overview of the pipeline. Given an input image we", 10.0),
            (50.0, 412.0, "predict things.", 10.0),
        ])];
        let e = entry(&pages, 0, Some(50.0), 96.0, "3").unwrap();
        assert_eq!(e.kind, "other");
        assert_eq!(e.text, "Figure 3: Overview of the pipeline.");
        assert_eq!(e.y, 400.0);
        // A dest x of 0 is ignored rather than picking a column.
        assert!(pages[0].column_at(0.0).is_none());
    }

    #[test]
    fn line_joins_dehyphenate_only_real_word_breaks() {
        assert_eq!(join_lines(["segmen-", "tation"]), "segmentation");
        assert_eq!(join_lines(["Boundary-", "Aware"]), "Boundary-Aware");
        assert_eq!(join_lines(["Pro\u{AD}", "ceedings"]), "Proceedings");
        assert_eq!(join_lines(["mini\u{2}", "mization"]), "minimization");
        assert_eq!(join_lines(["pp. 1\u{2013}", "10"]), "pp. 1\u{2013}10");
        assert_eq!(join_lines(["Pro", "ceedings"]), "Pro ceedings");
        assert_eq!(label_number("[47]"), Some("47"));
        assert_eq!(label_number("4.1"), None);
        assert!(is_references_heading("7. R EFERENCES"));
        assert!(is_references_heading("References"));
        assert!(!is_references_heading("References to prior work are"));
    }
}
