use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use chrono::Local;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupConfig {
    pub backup_enabled: bool,
    pub backup_folder: String,
    pub backup_interval_minutes: u64,
    pub backup_only_on_change: bool,
    pub backup_keep_count: u32,
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            backup_enabled: false,
            backup_folder: String::new(),
            backup_interval_minutes: 10,
            backup_only_on_change: true,
            backup_keep_count: 10,
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct BackupStatus {
    pub last_backup: Option<String>,
    pub last_backup_size: Option<u64>,
}

pub struct BackupState {
    pub config: Mutex<BackupConfig>,
    pub status: Mutex<BackupStatus>,
    pub dirty: AtomicBool,
}

impl BackupState {
    pub fn new(config: BackupConfig) -> Self {
        Self {
            config: Mutex::new(config),
            status: Mutex::new(BackupStatus::default()),
            dirty: AtomicBool::new(false),
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Create app data dir: {e}"))?;
    Ok(dir.join("hyji_config.json"))
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Resolve app data dir: {e}"))?;
    Ok(dir.join("hyji.db"))
}

pub fn load_config(app: &AppHandle) -> BackupConfig {
    match config_path(app).and_then(|p| {
        if p.exists() {
            fs::read_to_string(&p).map_err(|e| e.to_string())
        } else {
            Err("config missing".into())
        }
    }) {
        Ok(text) => serde_json::from_str::<BackupConfig>(&text).unwrap_or_default(),
        Err(_) => BackupConfig::default(),
    }
}

pub fn save_config(app: &AppHandle, cfg: &BackupConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(())
}

fn rotate_backups(folder: &Path, keep: u32) {
    let entries = match fs::read_dir(folder) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut backups: Vec<(PathBuf, std::time::SystemTime)> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("hyji_backup_")
        })
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .ends_with(".db")
        })
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            let t = m.modified().ok()?;
            Some((e.path(), t))
        })
        .collect();
    backups.sort_by(|a, b| b.1.cmp(&a.1)); // newest first
    for (path, _) in backups.into_iter().skip(keep as usize) {
        let _ = fs::remove_file(path);
    }
}

pub fn perform_backup(app: &AppHandle) -> Result<(String, u64), String> {
    let cfg: BackupConfig = app
        .state::<BackupState>()
        .config
        .lock()
        .map_err(|e| format!("config lock: {e}"))?
        .clone();

    if cfg.backup_folder.trim().is_empty() {
        return Err("Backup folder is not set.".into());
    }

    let folder = PathBuf::from(&cfg.backup_folder);
    fs::create_dir_all(&folder).map_err(|e| format!("Create backup folder: {e}"))?;

    let src = db_path(app)?;
    if !src.exists() {
        return Err("Database file not found.".into());
    }

    let stamp = Local::now().format("%Y-%m-%d_%H%M%S").to_string();
    let dest = folder.join(format!("hyji_backup_{stamp}.db"));
    fs::copy(&src, &dest).map_err(|e| format!("Copy db: {e}"))?;
    let size = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);

    rotate_backups(&folder, cfg.backup_keep_count.max(1));

    let iso = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    {
        let state = app.state::<BackupState>();
        if let Ok(mut s) = state.status.lock() {
            s.last_backup = Some(iso.clone());
            s.last_backup_size = Some(size);
        }
        state.dirty.store(false, Ordering::Relaxed);
    }

    Ok((iso, size))
}

pub fn spawn_backup_loop(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_run = std::time::Instant::now()
            .checked_sub(Duration::from_secs(60 * 60 * 24))
            .unwrap_or_else(std::time::Instant::now);
        loop {
            std::thread::sleep(Duration::from_secs(60));

            let cfg: BackupConfig = match app.state::<BackupState>().config.lock() {
                Ok(g) => g.clone(),
                Err(_) => continue,
            };

            if !cfg.backup_enabled || cfg.backup_folder.trim().is_empty() {
                continue;
            }

            let interval = Duration::from_secs(cfg.backup_interval_minutes.max(1) * 60);
            if last_run.elapsed() < interval {
                continue;
            }

            let dirty = app.state::<BackupState>().dirty.load(Ordering::Relaxed);
            if cfg.backup_only_on_change && !dirty {
                continue;
            }

            match perform_backup(&app) {
                Ok(_) => {
                    last_run = std::time::Instant::now();
                }
                Err(e) => eprintln!("[hyji backup] {e}"),
            }
        }
    });
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_backup_config(state: State<'_, BackupState>) -> BackupConfig {
    state.config.lock().map(|g| g.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn set_backup_config(
    app: AppHandle,
    state: State<'_, BackupState>,
    config: BackupConfig,
) -> Result<(), String> {
    if let Ok(mut g) = state.config.lock() {
        *g = config.clone();
    }
    save_config(&app, &config)
}

#[tauri::command]
pub fn get_backup_status(state: State<'_, BackupState>) -> BackupStatus {
    state.status.lock().map(|g| g.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn mark_db_dirty(state: State<'_, BackupState>) {
    state.dirty.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub fn trigger_manual_backup(app: AppHandle) -> Result<BackupStatus, String> {
    let (when, size) = perform_backup(&app)?;
    Ok(BackupStatus {
        last_backup: Some(when),
        last_backup_size: Some(size),
    })
}
