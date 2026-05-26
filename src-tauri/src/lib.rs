mod commands;
mod menu;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Bring main window to front if user tries to launch a second instance
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            // If a file path was passed, open it in a new window
            for arg in args.iter().skip(1) {
                if arg.ends_with(".roadmap") {
                    let _ = commands::open_file_in_new_window(app.clone(), arg.clone());
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::new_window,
            commands::open_file_in_window,
            commands::open_dialog,
            commands::save_dialog,
            commands::export_html_dialog,
            commands::export_svg_dialog,
            commands::export_png_dialog,
            commands::read_roadmap_file,
            commands::write_roadmap_file,
            commands::write_html_file,
            commands::write_svg_file,
            commands::write_png_file,
            commands::get_recent_files,
            commands::add_recent_file,
            commands::clear_recent_files,
            commands::set_window_title,
            commands::open_external,
            commands::pick_image_dialog,
            commands::read_image_as_data_url,
            commands::register_window_file,
            commands::unregister_window,
            commands::find_window_for_file,
            menu::refresh_menu,
        ])
        .manage(commands::FileWindowMap(Mutex::new(HashMap::new())))
        .setup(|app| {
            // Initial menu uses defaults. JS calls refresh_menu after loading
            // its localStorage state so check marks reflect the saved toggles.
            menu::create_menu(app.handle(), false, false)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::handle_menu_event(app, event);
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
