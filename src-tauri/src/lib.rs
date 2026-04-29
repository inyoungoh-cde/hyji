mod commands;

use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

pub struct PendingOpenFile(pub Mutex<Option<String>>);

#[tauri::command]
fn take_pending_open_file(state: State<'_, PendingOpenFile>) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pending_pdf = std::env::args()
        .skip(1)
        .find(|a| a.to_lowercase().ends_with(".pdf"));

    tauri::Builder::default()
        .manage(PendingOpenFile(Mutex::new(pending_pdf)))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::create_project,
            commands::list_projects,
            commands::rename_project,
            commands::delete_project,
            commands::create_paper,
            commands::list_papers,
            commands::get_paper,
            commands::update_paper,
            commands::delete_paper,
            take_pending_open_file,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_title("HYJI — Highlight Your Journey of Insights")?;

            // Set window icon (pre-converted 64x64 RGBA)
            let icon = tauri::image::Image::new_owned(
                include_bytes!("../icons/icon.rgba").to_vec(), 64, 64,
            );
            window.set_icon(icon)?;

            // Create menu
            use tauri::menu::{MenuBuilder, SubmenuBuilder};

            let file_menu = SubmenuBuilder::new(app, "File")
                .text("new-project", "New Project\tCtrl+Shift+N")
                .text("import-pdf", "Import PDF...\tCtrl+O")
                .text("smart-paste", "Smart Paste\tCtrl+N")
                .separator()
                .text("export-selection-mode", "Export Selection Mode")
                .text("export-all-bib", "Export All (.bib)")
                .text("export-all-word", "Export All (Word References)")
                .text("export-all-csv", "Export All (CSV)")
                .separator()
                .quit()
                .build()?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .text("find-pdf", "Find in PDF\tCtrl+F")
                .text("find-paper", "Find Paper\tCtrl+Shift+F")
                .separator()
                .text("select-mode", "Select Mode")
                .text("delete-paper", "Delete Paper")
                .build()?;

            let view_menu = SubmenuBuilder::new(app, "View")
                .text("toggle-sidebar", "Toggle Sidebar\tCtrl+B")
                .text("toggle-tracker", "Toggle Tracker Panel\tCtrl+J")
                .separator()
                .text("zoom-in", "Zoom In\tCtrl+=")
                .text("zoom-out", "Zoom Out\tCtrl+-")
                .text("fit-width", "Fit Width\tCtrl+0")
                .separator()
                .text("dashboard", "Dashboard\tCtrl+H")
                .text("keyword-graph", "Keyword Graph\tCtrl+G")
                .separator()
                .text("text-size-normal", "Text Size: Default")
                .text("text-size-large",  "Text Size: Large")
                .text("text-size-xlarge", "Text Size: X-Large")
                .build()?;

            let tools_menu = SubmenuBuilder::new(app, "Tools")
                .text("extract-meta", "Extract PDF Metadata")
                .text("regen-keywords", "Regenerate Keywords")
                .separator()
                .text("db-backup", "Database Backup...")
                .text("db-restore", "Restore from Backup...")
                .build()?;

            let help_menu = SubmenuBuilder::new(app, "Help")
                .text("shortcuts", "Keyboard Shortcuts\tCtrl+/")
                .text("about", "About HYJI")
                .text("github", "GitHub Repository")
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&view_menu)
                .item(&tools_menu)
                .item(&help_menu)
                .build()?;

            app.set_menu(menu)?;

            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.clone();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("menu-event", id);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running HYJI");
}
