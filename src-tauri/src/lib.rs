mod android_helpers;
mod fs_core;
mod usb;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_usb_storage::init())
        .invoke_handler(tauri::generate_handler![
            android_helpers::check_all_files_access,
            android_helpers::request_all_files_access,
            android_helpers::open_with_system,
            fs_core::get_volumes,
            fs_core::list_dir,
            fs_core::stat_path,
            fs_core::read_text,
            fs_core::write_text,
            fs_core::create_dir,
            fs_core::rename_path,
            fs_core::delete_path,
            fs_core::copy_paths,
            fs_core::move_paths,
            fs_core::search,
            usb::usb_status,
            usb::usb_request_permission,
            usb::usb_open,
            usb::usb_eject,
            usb::usb_format,
            usb::usb_materialize,
            usb::open_storage_settings,
        ])
        .setup(|app| {
            fs_core::start_volume_watcher(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
