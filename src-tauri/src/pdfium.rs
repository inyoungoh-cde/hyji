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
        Ok(Doc { pages: Mutex::new(Vec::new()), doc, key })
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

fn resolve_destination(
    doc: &Doc,
    memo: &mut FrameMemo,
    dest: &PdfDestination,
) -> (Option<u32>, Option<f32>) {
    let Ok(index) = dest.page_index() else { return (None, None) };
    let index = index as u32;
    let point = dest.view_settings().ok().and_then(|v| destination_point(&v));
    let dest_y = point.and_then(|(x, y)| {
        let frame = target_frame(doc, memo, index)?;
        let x = x.unwrap_or(frame.left);
        Some(frame.to_display(x, y).1)
    });
    (Some(index), dest_y)
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
        };
        if let Some(action) = link.action() {
            if let Some(uri) = action.as_uri_action() {
                if let Ok(u) = uri.uri() {
                    entry.kind = "uri";
                    entry.uri = Some(u);
                }
            } else if let Some(local) = action.as_local_destination_action() {
                if let Ok(dest) = local.destination() {
                    let (p, y) = resolve_destination(doc, &mut memo, &dest);
                    if p.is_some() {
                        entry.kind = "page";
                        entry.dest_page = p;
                        entry.dest_y = y;
                    }
                }
            }
        }
        if entry.kind == "none" {
            if let Some(dest) = link.destination() {
                let (p, y) = resolve_destination(doc, &mut memo, &dest);
                if p.is_some() {
                    entry.kind = "page";
                    entry.dest_page = p;
                    entry.dest_y = y;
                }
            }
        }
        out.push(entry);
    }
    Ok(out)
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
}
