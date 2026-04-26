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
            backend::list_workspace_tree,
            backend::create_workspace_markdown_file,
            backend::delete_workspace_markdown_file,
            backend::move_workspace_markdown_file,
            backend::search_workspace,
            backend::watch_paths,
            backend::classify_drop_paths,
            backend::list_system_fonts,
            backend::startup_file_paths
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
