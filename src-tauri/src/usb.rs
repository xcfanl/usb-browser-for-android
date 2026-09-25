//! USB mass storage: bridge to the `usb-storage` plugin (Android) and virtual `/usbraw/<id>/...`
//! paths for drives opened in direct mode (read through libaums/java-fs instead of the OS mount).

use crate::fs_core::Entry;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

pub const RAW_PREFIX: &str = "/usbraw/";

#[derive(Debug, Clone)]
pub struct RawPath {
    pub id: i64,
    /// Absolute path inside the drive ("/" = root).
    pub inner: String,
}

impl RawPath {
    pub fn full(&self) -> String {
        join_raw(self.id, &self.inner)
    }
    pub fn child(&self, name: &str) -> RawPath {
        let inner = if self.inner == "/" {
            format!("/{name}")
        } else {
            format!("{}/{name}", self.inner.trim_end_matches('/'))
        };
        RawPath { id: self.id, inner }
    }
    pub fn name(&self) -> String {
        self.inner.rsplit('/').next().unwrap_or("").to_string()
    }
}

pub fn parse_raw(path: &str) -> Option<RawPath> {
    let rest = path.strip_prefix(RAW_PREFIX)?;
    let (id, inner) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let id = id.parse().ok()?;
    let inner = inner.trim_end_matches('/');
    Some(RawPath {
        id,
        inner: if inner.is_empty() {
            "/".into()
        } else {
            inner.to_string()
        },
    })
}

pub fn join_raw(id: i64, inner: &str) -> String {
    if inner == "/" || inner.is_empty() {
        format!("/usbraw/{id}")
    } else {
        format!("/usbraw/{id}{inner}")
    }
}

// ---- plugin calls -------------------------------------------------------------------------

#[cfg(target_os = "android")]
pub async fn call<T: DeserializeOwned>(
    app: &AppHandle,
    cmd: &str,
    payload: Value,
) -> Result<T, String> {
    let st = app
        .try_state::<tauri_plugin_usb_storage::UsbStorage<tauri::Wry>>()
        .ok_or("USB 模块尚未就绪")?;
    st.call(cmd, payload).await
}

#[cfg(not(target_os = "android"))]
pub async fn call<T: DeserializeOwned>(
    _app: &AppHandle,
    _cmd: &str,
    _payload: Value,
) -> Result<T, String> {
    Err("USB 直接模式仅支持 Android".into())
}

/// Blocking variant for background threads (never the Android main thread).
#[cfg(target_os = "android")]
pub fn call_blocking<T: DeserializeOwned>(
    app: &AppHandle,
    cmd: &str,
    payload: Value,
) -> Result<T, String> {
    let st = app
        .try_state::<tauri_plugin_usb_storage::UsbStorage<tauri::Wry>>()
        .ok_or("USB 模块尚未就绪")?;
    st.call_blocking(cmd, payload)
}

#[derive(Deserialize)]
struct RawEntry {
    name: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
    size: u64,
    mtime: i64,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Deserialize)]
struct Entries {
    entries: Vec<RawEntry>,
}

fn to_entry(rp: &RawPath, e: RawEntry) -> Entry {
    let ext = if e.is_dir {
        String::new()
    } else {
        Path::new(&e.name)
            .extension()
            .map(|x| x.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    };
    Entry {
        path: rp.full(),
        name: e.name,
        is_dir: e.is_dir,
        is_symlink: false,
        size: e.size,
        modified_ms: e.mtime,
        ext,
    }
}

fn args(rp: &RawPath) -> Value {
    json!({ "id": rp.id, "path": rp.inner })
}

pub async fn list(app: &AppHandle, rp: &RawPath) -> Result<Vec<Entry>, String> {
    let r: Entries = call(app, "list", args(rp)).await?;
    Ok(r.entries
        .into_iter()
        .map(|e| {
            let child = rp.child(&e.name);
            to_entry(&child, e)
        })
        .collect())
}

pub async fn stat(app: &AppHandle, rp: &RawPath) -> Result<Entry, String> {
    let e: RawEntry = call(app, "stat", args(rp)).await?;
    let mut entry = to_entry(rp, e);
    if entry.name.is_empty() {
        entry.name = format!("U盘 {}", rp.id);
    }
    Ok(entry)
}

pub async fn search(
    app: &AppHandle,
    rp: &RawPath,
    query: &str,
    limit: usize,
) -> Result<Vec<Entry>, String> {
    let r: Entries = call(
        app,
        "search",
        json!({ "id": rp.id, "path": rp.inner, "query": query, "limit": limit }),
    )
    .await?;
    Ok(r.entries
        .into_iter()
        .map(|mut e| {
            let p = RawPath {
                id: rp.id,
                inner: e.path.take().unwrap_or_else(|| "/".into()),
            };
            to_entry(&p, e)
        })
        .collect())
}

/// Copies a drive path (file or directory) to a local destination.
pub async fn export(
    app: &AppHandle,
    rp: &RawPath,
    dest: &Path,
    max: Option<u64>,
) -> Result<(), String> {
    let _: Value = call(
        app,
        "exportPath",
        json!({ "id": rp.id, "path": rp.inner, "dest": dest.to_string_lossy(), "max": max.unwrap_or(0) }),
    )
    .await?;
    Ok(())
}

/// Copies a local file/directory to `rp` on the drive (FAT32 only; overwrites files).
pub async fn import(app: &AppHandle, src: &Path, rp: &RawPath) -> Result<(), String> {
    let _: Value = call(
        app,
        "importPath",
        json!({ "id": rp.id, "path": rp.inner, "src": src.to_string_lossy() }),
    )
    .await?;
    Ok(())
}

pub async fn mkdir(app: &AppHandle, rp: &RawPath) -> Result<(), String> {
    let _: Value = call(app, "mkdir", args(rp)).await?;
    Ok(())
}

pub async fn delete(app: &AppHandle, rp: &RawPath) -> Result<(), String> {
    let _: Value = call(app, "delete", args(rp)).await?;
    Ok(())
}

pub async fn rename(app: &AppHandle, rp: &RawPath, new_name: &str) -> Result<(), String> {
    let _: Value = call(
        app,
        "rename",
        json!({ "id": rp.id, "path": rp.inner, "newName": new_name }),
    )
    .await?;
    Ok(())
}

pub async fn exists(app: &AppHandle, rp: &RawPath) -> bool {
    stat(app, rp).await.is_ok()
}

/// Picks "name", "name (1).ext", ... that does not exist yet in `dir` on the drive.
pub async fn unique_child(app: &AppHandle, dir: &RawPath, name: &str) -> Result<RawPath, String> {
    let names: Vec<String> = list(app, dir)
        .await?
        .into_iter()
        .map(|e| e.name.to_lowercase())
        .collect();
    if !names.contains(&name.to_lowercase()) {
        return Ok(dir.child(name));
    }
    let p = Path::new(name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.into());
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for i in 1..1000 {
        let cand = format!("{stem} ({i}){ext}");
        if !names.contains(&cand.to_lowercase()) {
            return Ok(dir.child(&cand));
        }
    }
    Err("无法生成不重复的文件名".into())
}

pub fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    {
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
        Ok(dir.join("usbraw"))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(std::env::temp_dir().join("usbraw"))
    }
}

/// Scratch dir for transfers (emptied by the caller).
pub fn temp_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let d = cache_root(app)?.join(".tmp").join(format!("{n}"));
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

/// Copies a drive file into the app cache (reused while size/mtime match) and returns its local
/// path, so viewers (asset protocol) and "open with" (FileProvider) can use it.
pub async fn materialize(app: &AppHandle, rp: &RawPath) -> Result<PathBuf, String> {
    let st = stat(app, rp).await?;
    if st.is_dir {
        return Err("这是一个目录".into());
    }
    let local = cache_root(app)?
        .join(rp.id.to_string())
        .join(rp.inner.trim_start_matches('/'));
    if let Ok(m) = std::fs::metadata(&local) {
        let mtime = m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if m.len() == st.size && (st.modified_ms == 0 || (mtime - st.modified_ms).abs() < 2000) {
            return Ok(local);
        }
    }
    export(app, rp, &local, None).await?;
    Ok(local)
}

// ---- commands -----------------------------------------------------------------------------

/// Storage volumes (StorageManager), attached USB mass-storage devices and their state.
/// `request = true` (refresh / scan) shows the USB permission dialog for devices without access.
#[tauri::command]
pub async fn usb_status(app: AppHandle, request: Option<bool>) -> Result<Value, String> {
    call(
        &app,
        "status",
        json!({ "request": request.unwrap_or(false) }),
    )
    .await
}

#[tauri::command]
pub async fn usb_request_permission(app: AppHandle, id: Option<i64>) -> Result<Value, String> {
    call(&app, "requestPermission", json!({ "id": id.unwrap_or(-1) })).await
}

/// Opens a drive in direct mode (claims the USB interface; if Android had mounted it, the
/// system mount goes away while the app holds the drive).
#[tauri::command]
pub async fn usb_open(app: AppHandle, id: i64) -> Result<Value, String> {
    call(&app, "open", json!({ "id": id })).await
}

/// Flushes and closes the file system and releases the USB interface: safe to unplug.
#[tauri::command]
pub async fn usb_eject(app: AppHandle, id: i64) -> Result<(), String> {
    let _: Value = call(&app, "eject", json!({ "id": id })).await?;
    if let Ok(root) = cache_root(&app) {
        let _ = std::fs::remove_dir_all(root.join(id.to_string()));
    }
    Ok(())
}

/// Erases the whole drive and creates a single FAT32 partition (direct mode only).
#[tauri::command]
pub async fn usb_format(
    app: AppHandle,
    id: i64,
    fs_type: String,
    label: String,
) -> Result<Value, String> {
    let r = call(
        &app,
        "format",
        json!({ "id": id, "fsType": fs_type, "label": label }),
    )
    .await?;
    if let Ok(root) = cache_root(&app) {
        let _ = std::fs::remove_dir_all(root.join(id.to_string()));
    }
    Ok(r)
}

/// Local (cached) copy of a direct-mode file; other paths are returned unchanged.
#[tauri::command]
pub async fn usb_materialize(app: AppHandle, path: String) -> Result<String, String> {
    match parse_raw(&path) {
        Some(rp) => Ok(materialize(&app, &rp).await?.to_string_lossy().into_owned()),
        None => Ok(path),
    }
}

/// System storage settings (eject / format of volumes mounted by Android itself).
#[tauri::command]
pub async fn open_storage_settings(app: AppHandle) -> Result<(), String> {
    let _: Value = call(&app, "openStorageSettings", json!({})).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_paths() {
        let p = parse_raw("/usbraw/1002").unwrap();
        assert_eq!((p.id, p.inner.as_str()), (1002, "/"));
        let p = parse_raw("/usbraw/7/DCIM/a.jpg").unwrap();
        assert_eq!((p.id, p.inner.as_str()), (7, "/DCIM/a.jpg"));
        assert_eq!(p.full(), "/usbraw/7/DCIM/a.jpg");
        assert_eq!(p.name(), "a.jpg");
        assert!(parse_raw("/storage/emulated/0").is_none());
        assert!(parse_raw("/usbraw/x/y").is_none());
        let r = parse_raw("/usbraw/3/").unwrap();
        assert_eq!(r.child("b").full(), "/usbraw/3/b");
        assert_eq!(join_raw(3, "/"), "/usbraw/3");
    }
}
