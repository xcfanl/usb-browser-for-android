//! USB mass-storage plugin (Android only; no-op elsewhere).
//!
//! The Kotlin side (`android/`) exposes commands that are only called from the app's Rust code
//! through [`UsbStorage::call`], so no JS-facing commands / ACL permissions are needed.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
pub struct UsbStorage<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
impl<R: Runtime> UsbStorage<R> {
    /// Async call (use from async commands: never blocks the Android main thread).
    pub async fn call<T: serde::de::DeserializeOwned>(
        &self,
        command: &str,
        payload: impl serde::Serialize,
    ) -> Result<T, String> {
        self.0
            .run_mobile_plugin_async(command, payload)
            .await
            .map_err(err_to_string)
    }

    /// Blocking call (only from background threads, e.g. the volume watcher).
    pub fn call_blocking<T: serde::de::DeserializeOwned>(
        &self,
        command: &str,
        payload: impl serde::Serialize,
    ) -> Result<T, String> {
        self.0
            .run_mobile_plugin(command, payload)
            .map_err(err_to_string)
    }
}

#[cfg(target_os = "android")]
fn err_to_string(e: tauri::plugin::mobile::PluginInvokeError) -> String {
    use tauri::plugin::mobile::PluginInvokeError;
    match e {
        PluginInvokeError::InvokeRejected(r) => r.message.unwrap_or_else(|| "USB 操作失败".into()),
        other => other.to_string(),
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("usb-storage")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    _api.register_android_plugin("com.usbfile.usbstorage", "UsbStoragePlugin")?;
                _app.manage(UsbStorage(handle));
            }
            Ok(())
        })
        .build()
}
