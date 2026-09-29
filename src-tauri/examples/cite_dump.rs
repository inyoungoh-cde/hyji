//! Dev tooling (not shipped): dumps what the citation hover card would show
//! for every internal page link of a PDF, as JSON lines on stdout —
//! `{page, label, destPage, destX, destY, entry}` where `entry` is the
//! `pdfium_link_entry` result. Used by tools/cite-eval to review extraction
//! accuracy across a corpus.
//!
//!   cargo build --example cite_dump
//!   target/debug/examples/cite_dump <file.pdf> > entries.jsonl
//!
//! Binds target/debug/pdfium.dll (or $HYJI_PDFIUM_DIR).

use std::path::PathBuf;

use hyji_lib::pdfium::{link_entry, page_links, text_in_box, Doc, Region};
use pdfium_render::prelude::Pdfium;
use serde_json::json;

fn main() -> Result<(), String> {
    let path = std::env::args().nth(1).ok_or("usage: cite_dump <file.pdf>")?;
    let dir = std::env::var_os("HYJI_PDFIUM_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug"));
    let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&dir))
        .map_err(|e| format!("{}: {e:?}", dir.display()))?;
    let pdfium: &'static Pdfium = Box::leak(Box::new(Pdfium::new(bindings)));
    let doc = Doc::open(pdfium, &path)?;
    let pages = doc.document().pages().len().max(0) as u32;
    for page in 0..pages {
        let links = page_links(&doc, page)?;
        if links.iter().all(|l| l.kind != "page") {
            continue;
        }
        let text = doc.page(page)?.text()?.clone();
        for l in links.iter().filter(|l| l.kind == "page") {
            let Some(dest_page) = l.dest_page else { continue };
            let label = text_in_box(&text, &Region { x: l.x, y: l.y, w: l.w, h: l.h });
            let entry = link_entry(&doc, dest_page, l.dest_x, l.dest_y.unwrap_or(0.0), &label)?;
            println!(
                "{}",
                json!({
                    "page": page,
                    "label": label,
                    "destPage": dest_page,
                    "destX": l.dest_x,
                    "destY": l.dest_y,
                    "entry": entry,
                })
            );
        }
    }
    Ok(())
}
