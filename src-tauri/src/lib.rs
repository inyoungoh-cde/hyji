mod backup;
mod commands;

use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

use backup::{
    get_backup_config, get_backup_status, mark_db_dirty, set_backup_config,
    spawn_backup_loop, trigger_manual_backup, BackupState,
};

// Queue of PDF paths waiting to be opened by the frontend. Filled from argv
// at launch and by the single-instance handler when a second launch forwards
// its argv. The frontend drains it via take_pending_open_files — a pull model,
// so paths queued before the webview finishes loading are never lost.
pub struct PendingOpenFile(pub Mutex<Vec<String>>);

#[tauri::command]
fn take_pending_open_files(state: State<'_, PendingOpenFile>) -> Vec<String> {
    state
        .0
        .lock()
        .map(|mut g| std::mem::take(&mut *g))
        .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pending_pdf = std::env::args()
        .skip(1)
        .find(|a| a.to_lowercase().ends_with(".pdf"));

    tauri::Builder::default()
        // Must be registered first: a second HYJI launch (e.g. double-clicking
        // a PDF in Explorer) forwards its argv to this instance and exits,
        // so the PDF opens as a tab here instead of a new window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let pdfs: Vec<String> = argv
                .iter()
                .skip(1)
                .filter(|a| a.to_lowercase().ends_with(".pdf"))
                .cloned()
                .collect();
            // Queue first (pull model survives a not-yet-loaded webview),
            // then nudge the frontend to drain the queue.
            if !pdfs.is_empty() {
                if let Ok(mut queue) = app.state::<PendingOpenFile>().0.lock() {
                    queue.extend(pdfs);
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
                let _ = window.emit("open-pdf-external", ());
            }
        }))
        .manage(PendingOpenFile(Mutex::new(
            pending_pdf.into_iter().collect(),
        )))
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
            take_pending_open_files,
            get_backup_config,
            set_backup_config,
            get_backup_status,
            mark_db_dirty,
            trigger_manual_backup,
        ])
        .setup(|app| {
            // Auto-backup state — load config from app data dir
            let cfg = backup::load_config(&app.handle());
            app.manage(BackupState::new(cfg));
            spawn_backup_loop(app.handle().clone());

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
                .text("print-pdf", "Print...\tCtrl+P")
                .separator()
                .text("selection-mode", "Selection Mode\tCtrl+Shift+S")
                .text("export-selected", "Export Selected...")
                .text("export-all", "Export All...")
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
                .text("delete-paper", "Delete Paper")
                .build()?;

            let view_menu = SubmenuBuilder::new(app, "View")
                .text("toggle-sidebar", "Toggle Sidebar\tCtrl+B")
                .text("toggle-tracker", "Toggle Tracker Panel\tCtrl+J")
                .separator()
                .text("focus-mode", "Focus Mode\tCtrl+L")
                .text("pdf-dark-mode", "PDF Dark Mode\tCtrl+D")
                .separator()
                .text("zoom-in", "Zoom In\tCtrl+=")
                .text("zoom-out", "Zoom Out\tCtrl+-")
                .text("fit-width", "Fit Width\tCtrl+0")
                .separator()
                .text("dashboard", "Dashboard\tCtrl+H")
                .text("expand-metadata", "Expand Metadata\tCtrl+M")
                .text("keyword-graph", "Keyword Graph\tCtrl+G")
                .separator()
                .text("text-size-normal", "Text Size: Default")
                .text("text-size-large",  "Text Size: Large")
                .text("text-size-xlarge", "Text Size: X-Large")
                .build()?;

            let tools_menu = SubmenuBuilder::new(app, "Tools")
                .text("extract-meta", "Extract PDF Metadata")
                .text("regen-keywords", "Regenerate Keywords")
                .text("import-annotations", "Import Annotations from PDF...")
                .text("rebuild-search-index", "Rebuild Search Index...")
                .separator()
                .text("db-backup", "Database Backup...")
                .text("db-restore", "Restore from Backup...")
                .separator()
                .text("clear-all-data", "Reset to Blank (Clear All Data)...")
                .separator()
                .text("preferences", "Preferences...")
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
        .build(tauri::generate_context!())
        .expect("error while building HYJI")
        .run(|app, event| {
            // Last-chance backup of a dirty DB when the app is closing
            if let tauri::RunEvent::ExitRequested { .. } = event {
                backup::backup_on_exit(app);
            }
        });
}
