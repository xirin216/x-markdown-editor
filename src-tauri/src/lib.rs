mod backend;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(backend::WatchState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            backend::open_file,
            backend::save_file,
            backend::open_workspace,
            backend::search_workspace,
            backend::watch_paths,
            backend::classify_drop_paths
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
