use std::fs;
use std::path::PathBuf;

use serde::Deserialize;
use tauri::menu::{MenuBuilder, MenuEvent, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

#[derive(Deserialize, Default)]
struct RecentFiles {
    files: Vec<String>,
}

fn recent_files_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("recent.json"))
}

fn load_recent_files<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let path = match recent_files_path(app) {
        Some(p) => p,
        None => return vec![],
    };
    if !path.exists() {
        return vec![];
    }
    let files: Vec<String> = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<RecentFiles>(&s).ok())
        .map(|r| r.files)
        .unwrap_or_default();
    // Hide files that have been deleted from disk
    files.into_iter().filter(|p| std::path::Path::new(p).exists()).collect()
}

pub fn create_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let app_menu = SubmenuBuilder::new(app, "Roadmap")
        .item(
            &MenuItemBuilder::new("About Roadmap")
                .id("app:about")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    // Build dynamic Open Recent submenu from disk-stored list
    let recents = load_recent_files(app);
    let mut recent_builder = SubmenuBuilder::new(app, "Open Recent");
    if recents.is_empty() {
        recent_builder = recent_builder.item(
            &MenuItemBuilder::new("(empty)")
                .id("file:recent_empty")
                .enabled(false)
                .build(app)?,
        );
    } else {
        for (i, path) in recents.iter().enumerate() {
            let label = path
                .rsplit('/')
                .next()
                .unwrap_or(path.as_str())
                .trim_end_matches(".roadmap");
            recent_builder = recent_builder.item(
                &MenuItemBuilder::new(label)
                    .id(format!("file:recent:{}", i))
                    .build(app)?,
            );
        }
        recent_builder = recent_builder
            .separator()
            .item(
                &MenuItemBuilder::new("Clear Recent")
                    .id("file:clear_recent")
                    .build(app)?,
            );
    }
    let recent_submenu = recent_builder.build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::new("New Roadmap")
                .id("file:new")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::new("Open…")
                .id("file:open")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(&recent_submenu)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, Some("Close Window"))?)
        .item(
            &MenuItemBuilder::new("Save")
                .id("file:save")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::new("Save As…")
                .id("file:save_as")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?,
        )
        .separator();

    let export_submenu = SubmenuBuilder::new(app, "Export as")
        .item(
            &MenuItemBuilder::new("HTML…")
                .id("file:export_html")
                .accelerator("CmdOrCtrl+Shift+E")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::new("SVG (full)…")
                .id("file:export_svg")
                .accelerator("CmdOrCtrl+Shift+P")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::new("SVG (visible area)…")
                .id("file:export_svg_visible")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::new("PNG (full)…")
                .id("file:export_png")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::new("PNG (visible area)…")
                .id("file:export_png_visible")
                .build(app)?,
        )
        .item(&PredefinedMenuItem::separator(app)?)
        .item(
            &MenuItemBuilder::new("Strategy SVG…")
                .id("file:export_strategy_svg")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::new("Strategy PNG…")
                .id("file:export_strategy_png")
                .build(app)?,
        )
        .build()?;

    let file_menu = file_menu
        .item(&export_submenu)
        .separator()
        .item(
            &MenuItemBuilder::new("Print…")
                .id("file:print")
                .accelerator("CmdOrCtrl+P")
                .build(app)?,
        )
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(
            &MenuItemBuilder::new("Undo")
                .id("edit:undo")
                .accelerator("CmdOrCtrl+Z")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::new("Redo")
                .id("edit:redo")
                .accelerator("CmdOrCtrl+Shift+Z")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    let appearance_menu = SubmenuBuilder::new(app, "Appearance")
        .item(&MenuItemBuilder::new("Use System Setting").id("view:theme_auto").build(app)?)
        .item(&MenuItemBuilder::new("Light").id("view:theme_light").build(app)?)
        .item(&MenuItemBuilder::new("Dark").id("view:theme_dark").build(app)?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&appearance_menu)
        .separator()
        .item(
            &MenuItemBuilder::new("Roadmap")
                .id("view:tab_roadmap")
                .accelerator("CmdOrCtrl+1")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::new("Strategy")
                .id("view:tab_strategy")
                .accelerator("CmdOrCtrl+2")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new("Fit Rows to Window Height")
                .id("view:fit_to_height")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .build()?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(
            &MenuItemBuilder::new("Keyboard Shortcuts")
                .id("help:shortcuts")
                .accelerator("CmdOrCtrl+/")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new("Check for Updates…")
                .id("help:check_updates")
                .build(app)?,
        )
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}

// Tauri command - rebuilds the menu (called after add_recent_file to refresh Open Recent)
#[tauri::command]
pub fn refresh_menu<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    create_menu(&app).map_err(|e| e.to_string())
}

pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref().to_string();
    match id.as_str() {
        "file:new" => emit_to_focused(app, "menu:new", ()),
        "file:open" => emit_to_focused(app, "menu:open", ()),
        "file:save" => emit_to_focused(app, "menu:save", ()),
        "file:save_as" => emit_to_focused(app, "menu:save_as", ()),
        "file:export_html" => emit_to_focused(app, "menu:export_html", ()),
        "file:export_svg" => emit_to_focused(app, "menu:export_svg", ()),
        "file:export_svg_visible" => emit_to_focused(app, "menu:export_svg_visible", ()),
        "file:export_png" => emit_to_focused(app, "menu:export_png", ()),
        "file:export_png_visible" => emit_to_focused(app, "menu:export_png_visible", ()),
        "file:export_strategy_svg" => emit_to_focused(app, "menu:export_strategy_svg", ()),
        "file:export_strategy_png" => emit_to_focused(app, "menu:export_strategy_png", ()),
        "file:print" => emit_to_focused(app, "menu:print", ()),
        "view:fit_to_height" => emit_to_focused(app, "menu:fit_to_height", ()),
        "view:tab_roadmap" => emit_to_focused(app, "menu:tab", "roadmap"),
        "view:tab_strategy" => emit_to_focused(app, "menu:tab", "strategy"),
        "view:theme_auto" => app.emit("menu:theme", "auto").unwrap_or(()),
        "view:theme_light" => app.emit("menu:theme", "light").unwrap_or(()),
        "view:theme_dark" => app.emit("menu:theme", "dark").unwrap_or(()),
        "file:clear_recent" => {
            let _ = clear_recent_files_internal(app);
            let _ = create_menu(app);
        }
        "app:about" => emit_to_focused(app, "menu:about", ()),
        "help:check_updates" => emit_to_focused(app, "menu:check_updates", ()),
        "help:shortcuts" => emit_to_focused(app, "menu:shortcuts", ()),
        "edit:undo" => emit_to_focused(app, "menu:undo", ()),
        "edit:redo" => emit_to_focused(app, "menu:redo", ()),
        other if other.starts_with("file:recent:") => {
            if let Some(idx_str) = other.strip_prefix("file:recent:") {
                if let Ok(idx) = idx_str.parse::<usize>() {
                    let recents = load_recent_files(app);
                    if let Some(path) = recents.get(idx).cloned() {
                        emit_to_focused(app, "menu:open_recent", path);
                    }
                }
            }
        }
        _ => {}
    }
}

fn clear_recent_files_internal<R: Runtime>(app: &AppHandle<R>) -> std::io::Result<()> {
    if let Some(path) = recent_files_path(app) {
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

fn emit_to_focused<R: Runtime, T: serde::Serialize + Clone>(app: &AppHandle<R>, event: &str, payload: T) {
    if let Some(window) = app.webview_windows().values().find(|w| w.is_focused().unwrap_or(false)) {
        let _ = window.emit(event, payload);
        return;
    }
    let _ = app.emit(event, payload);
}
