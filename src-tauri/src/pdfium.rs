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

struct Doc {
    doc: PdfDocument<'static>,
    key: DocKey,
}

struct Entry {
    doc: Arc<Doc>,
    refs: u32,
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

fn load_page(doc: &Doc, page: u32) -> Result<PdfPage<'_>, String> {
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
pub async fn pdfium_open(app: AppHandle, path: String) -> Result<OpenResult, String> {
    blocking(move || {
        let engine = engine(&app)?;
        let key = doc_key(&path)?;

        let (id, doc) = {
            let mut c = cache();
            let existing = c
                .by_id
                .iter_mut()
                .find(|(_, e)| e.doc.key == key)
                .map(|(id, e)| {
                    e.refs += 1;
                    (*id, Arc::clone(&e.doc))
                });
            match existing {
                Some(hit) => hit,
                None => {
                    let doc = engine
                        .pdfium
                        .load_pdf_from_file(&path, None)
                        .map_err(|e| match e {
                            PdfiumError::PdfiumLibraryInternalError(
                                PdfiumInternalError::PasswordError,
                            ) => "PDF is password-protected".to_string(),
                            other => format!("{path}: {}", perr(other)),
                        })?;
                    let doc = Arc::new(Doc { doc, key });
                    let id = c.next_id;
                    c.next_id += 1;
                    c.by_id.insert(id, Entry { doc: Arc::clone(&doc), refs: 1 });
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
        let p = load_page(&doc, page)?;
        render_rgba(&p, width, height, annotations)
    })
    .await
    .map(tauri::ipc::Response::new)
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
        let p = load_page(&doc, page)?;
        Ok(image_regions(&p))
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
