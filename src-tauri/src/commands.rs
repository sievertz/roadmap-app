use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, FilePath};

const RECENT_FILES_FILENAME: &str = "recent.json";
const MAX_RECENT_FILES: usize = 10;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct RecentFiles {
    pub files: Vec<String>,
}

// In-memory map of file path → window label, used to avoid opening duplicate
// windows for the same file. Updated by the frontend whenever a window
// loads or saves a file.
pub struct FileWindowMap(pub Mutex<HashMap<String, String>>);

#[tauri::command]
pub fn register_window_file(state: State<FileWindowMap>, label: String, path: String) {
    let mut map = state.0.lock().unwrap();
    // A given window can only "own" one file path at a time, so remove any
    // previous entries that point at this label before inserting the new one.
    map.retain(|_, l| l != &label);
    map.insert(path, label);
}

#[tauri::command]
pub fn unregister_window(state: State<FileWindowMap>, label: String) {
    let mut map = state.0.lock().unwrap();
    map.retain(|_, l| l != &label);
}

#[tauri::command]
pub fn find_window_for_file(app: AppHandle, state: State<FileWindowMap>, path: String) -> Option<String> {
    let label = {
        let map = state.0.lock().unwrap();
        map.get(&path).cloned()
    };
    // Verify the window still exists; if not, clean up the stale entry and
    // pretend the file isn't open anywhere.
    if let Some(ref l) = label {
        if app.get_webview_window(l).is_none() {
            state.0.lock().unwrap().retain(|_, v| v != l);
            return None;
        }
    }
    label
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

// Helper to open a .roadmap file in a new window (from CLI args or open-with).
// Does NOT check for existing windows - that's the responsibility of the
// frontend command wrapper below.
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

// Tauri command wrapper: if a window already has this file open, focus it
// instead of creating a duplicate window. If the map has a stale entry
// (window has been closed since registration), clean it up and open fresh.
#[tauri::command]
pub fn open_file_in_window(app: AppHandle, state: State<FileWindowMap>, path: String) -> Result<(), String> {
    let existing_label = {
        let map = state.0.lock().unwrap();
        map.get(&path).cloned()
    };
    if let Some(label) = existing_label {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.unminimize();
            let _ = win.set_focus();
            return Ok(());
        }
        // Stale entry - window was closed but map wasn't cleaned. Remove it.
        state.0.lock().unwrap().retain(|_, l| l != &label);
    }
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

// Image picker dialog - returns selected image file path or None
#[tauri::command]
pub async fn pick_image_dialog(app: AppHandle) -> Result<Option<String>, String> {
    let file_path = app
        .dialog()
        .file()
        .add_filter("Image", &["png", "jpg", "jpeg", "svg", "gif", "webp"])
        .blocking_pick_file();
    Ok(file_path.and_then(|fp| match fp {
        FilePath::Path(p) => Some(p.to_string_lossy().to_string()),
        _ => None,
    }))
}

// Read an image file as a data URL (base64-encoded) for use as logo etc.
#[tauri::command]
pub fn read_image_as_data_url(path: String, max_bytes: u64) -> Result<String, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > max_bytes {
        return Err(format!(
            "File is {} KB, max {} KB",
            meta.len() / 1024,
            max_bytes / 1024
        ));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let mime = mime_from_path(&path);
    Ok(format!("data:{};base64,{}", mime, base64_encode(&bytes)))
}

fn mime_from_path(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") { "image/png" }
    else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") { "image/jpeg" }
    else if lower.ends_with(".svg") { "image/svg+xml" }
    else if lower.ends_with(".gif") { "image/gif" }
    else if lower.ends_with(".webp") { "image/webp" }
    else { "application/octet-stream" }
}

// Lightweight base64 encoder (no external crate needed)
fn base64_encode(bytes: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[((triple >> 18) & 63) as usize] as char);
        out.push(CHARS[((triple >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { CHARS[((triple >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[(triple & 63) as usize] as char } else { '=' });
    }
    out
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
    // Filter out paths that no longer exist on disk so deleted files don't
    // clutter the Recents list. Rewrite the file if anything was filtered.
    let existing: Vec<String> = recent.files.iter().filter(|p| Path::new(p).exists()).cloned().collect();
    if existing.len() != recent.files.len() {
        let cleaned = RecentFiles { files: existing.clone() };
        if let Ok(json) = serde_json::to_string_pretty(&cleaned) {
            let _ = fs::write(&path, json);
        }
    }
    Ok(existing)
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

