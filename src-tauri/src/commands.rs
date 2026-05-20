use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, FilePath};

const RECENT_FILES_FILENAME: &str = "recent.json";
const MAX_RECENT_FILES: usize = 10;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct RecentFiles {
    pub files: Vec<String>,
}

// Tauri command: opens a new empty window
#[tauri::command]
pub fn new_window(app: AppHandle) -> Result<(), String> {
    let label = format!("window-{}", uuid_like());
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Roadmap - Untitled")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 500.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// Helper to open a .roadmap file in a new window (from CLI args or open-with)
pub fn open_file_in_new_window(app: AppHandle, path: String) -> Result<(), String> {
    let label = format!("window-{}", uuid_like());
    let url = format!("index.html?file={}", urlencoding(&path));
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Roadmap")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 500.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// Tauri command version of the above - callable from frontend
#[tauri::command]
pub fn open_file_in_window(app: AppHandle, path: String) -> Result<(), String> {
    open_file_in_new_window(app, path)
}

// Open file dialog. Resolves to selected path or None if cancelled.
#[tauri::command]
pub async fn open_dialog(app: AppHandle) -> Result<Option<String>, String> {
    let file_path = app
        .dialog()
        .file()
        .add_filter("Roadmap", &["roadmap", "json"])
        .blocking_pick_file();
    Ok(file_path.and_then(|fp| match fp {
        FilePath::Path(p) => Some(p.to_string_lossy().to_string()),
        _ => None,
    }))
}

// Save As dialog. Returns destination path or None if cancelled.
#[tauri::command]
pub async fn save_dialog(app: AppHandle, default_name: Option<String>) -> Result<Option<String>, String> {
    let name = default_name.unwrap_or_else(|| "Untitled.roadmap".to_string());
    let file_path = app
        .dialog()
        .file()
        .add_filter("Roadmap", &["roadmap"])
        .set_file_name(&name)
        .blocking_save_file();
    Ok(file_path.and_then(|fp| match fp {
        FilePath::Path(p) => Some(p.to_string_lossy().to_string()),
        _ => None,
    }))
}

// Export-as-HTML dialog
#[tauri::command]
pub async fn export_html_dialog(app: AppHandle, default_name: Option<String>) -> Result<Option<String>, String> {
    let name = default_name.unwrap_or_else(|| "roadmap.html".to_string());
    let file_path = app
        .dialog()
        .file()
        .add_filter("HTML", &["html"])
        .set_file_name(&name)
        .blocking_save_file();
    Ok(file_path.and_then(|fp| match fp {
        FilePath::Path(p) => Some(p.to_string_lossy().to_string()),
        _ => None,
    }))
}

// Export-as-SVG dialog
#[tauri::command]
pub async fn export_svg_dialog(app: AppHandle, default_name: Option<String>) -> Result<Option<String>, String> {
    let name = default_name.unwrap_or_else(|| "roadmap.svg".to_string());
    let file_path = app
        .dialog()
        .file()
        .add_filter("SVG Image", &["svg"])
        .set_file_name(&name)
        .blocking_save_file();
    Ok(file_path.and_then(|fp| match fp {
        FilePath::Path(p) => Some(p.to_string_lossy().to_string()),
        _ => None,
    }))
}

// Read a .roadmap file's contents
#[tauri::command]
pub fn read_roadmap_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

// Write to a .roadmap file
#[tauri::command]
pub fn write_roadmap_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).ok();
    }
    fs::write(&path, contents).map_err(|e| format!("Failed to write {}: {}", path, e))
}

// Write an HTML file (for export)
#[tauri::command]
pub fn write_html_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).ok();
    }
    fs::write(&path, contents).map_err(|e| format!("Failed to write {}: {}", path, e))
}

// Write an SVG file (for export). SVG is text, so this mirrors write_html_file.
#[tauri::command]
pub fn write_svg_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).ok();
    }
    fs::write(&path, contents).map_err(|e| format!("Failed to write {}: {}", path, e))
}

// Recent files management - stored in app data dir
fn recent_files_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join(RECENT_FILES_FILENAME))
}

#[tauri::command]
pub fn get_recent_files(app: AppHandle) -> Result<Vec<String>, String> {
    let path = recent_files_path(&app).ok_or("No app data dir")?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let contents = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let recent: RecentFiles = serde_json::from_str(&contents).unwrap_or_default();
    Ok(recent.files)
}

#[tauri::command]
pub fn add_recent_file(app: AppHandle, path: String) -> Result<(), String> {
    let recent_path = recent_files_path(&app).ok_or("No app data dir")?;
    if let Some(parent) = recent_path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let mut recent: RecentFiles = if recent_path.exists() {
        fs::read_to_string(&recent_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        RecentFiles::default()
    };
    recent.files.retain(|p| p != &path);
    recent.files.insert(0, path);
    recent.files.truncate(MAX_RECENT_FILES);
    let json = serde_json::to_string_pretty(&recent).map_err(|e| e.to_string())?;
    fs::write(&recent_path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_recent_files(app: AppHandle) -> Result<(), String> {
    let path = recent_files_path(&app).ok_or("No app data dir")?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Update the active window's title
#[tauri::command]
pub fn set_window_title(window: tauri::Window, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|e| e.to_string())
}

// Open a URL in the system's default browser
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("URL must start with http:// or https://".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

// Cheap pseudo-unique id (we don't need crypto-grade uniqueness here, just window labels)
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}

// Minimal URL encoder - just escapes the few characters that matter in file paths
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' | '/' => out.push(c),
            _ => {
                let mut buf = [0u8; 4];
                let bytes = c.encode_utf8(&mut buf).as_bytes();
                for b in bytes {
                    out.push_str(&format!("%{:02X}", b));
                }
            }
        }
    }
    out
}

