use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
#[cfg(target_os = "android")]
use std::time::Duration;
use tauri::AppHandle;

use crate::usb::{self, parse_raw};

#[derive(Debug, Clone, Serialize)]
pub struct Volume {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub writable: bool,
    pub total_bytes: u64,
    pub available_bytes: u64,
    /// File system type when known (e.g. "vfat", "exfat", "FAT32", "NTFS").
    pub fs_type: String,
    /// "system": mounted by Android; "direct": opened by this app via USB (libaums/java-fs).
    pub source: String,
    /// The file system cannot report free space (java-fs FAT12/16).
    pub free_unknown: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified_ms: i64,
    pub ext: String,
}

fn io_err(e: io::Error) -> String {
    match e.kind() {
        io::ErrorKind::PermissionDenied => {
            "没有访问权限（请检查是否已授予“所有文件访问”权限）".into()
        }
        io::ErrorKind::NotFound => "路径不存在".into(),
        _ => format!("IO 错误: {e}"),
    }
}

fn entry_from(dir: &Path, name: &str) -> Option<Entry> {
    let path = dir.join(name);
    let meta = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(_) => return None,
    };
    let ft = meta.file_type();
    let is_symlink = ft.is_symlink();
    let real_meta = if is_symlink {
        fs::metadata(&path).ok()
    } else {
        Some(meta)
    };
    let (is_dir, size) = match &real_meta {
        Some(m) => (m.is_dir(), if m.is_dir() { 0 } else { m.len() }),
        None => (false, 0),
    };
    let modified_ms = real_meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let ext = if is_dir {
        String::new()
    } else {
        Path::new(name)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    };
    Some(Entry {
        name: name.to_string(),
        path: path.to_string_lossy().into_owned(),
        is_dir,
        is_symlink,
        size,
        modified_ms,
        ext,
    })
}

#[tauri::command]
pub async fn list_dir(app: AppHandle, path: String) -> Result<Vec<Entry>, String> {
    if path.is_empty() {
        return Err("空路径".into());
    }
    if let Some(rp) = parse_raw(&path) {
        return usb::list(&app, &rp).await;
    }
    let p = PathBuf::from(&path);
    let rd = fs::read_dir(&p).map_err(io_err)?;
    let mut out = Vec::new();
    for item in rd {
        let item = match item {
            Ok(i) => i,
            Err(_) => continue,
        };
        let name = item.file_name().to_string_lossy().into_owned();
        if name == "." || name == ".." {
            continue;
        }
        if let Some(e) = entry_from(&p, &name) {
            out.push(e);
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn stat_path(app: AppHandle, path: String) -> Result<Entry, String> {
    if let Some(rp) = parse_raw(&path) {
        return usb::stat(&app, &rp).await;
    }
    let p = PathBuf::from(&path);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    entry_from(p.parent().unwrap_or(Path::new("/")), &name)
        .map(|mut e| {
            e.path = path.clone();
            e
        })
        .ok_or_else(|| "无法读取文件信息".into())
}

fn unique_dst(dir: &Path, name: &str) -> PathBuf {
    let mut dst = dir.join(name);
    if !dst.exists() {
        return dst;
    }
    let stem = Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let ext = Path::new(name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for i in 1..1000u32 {
        let cand = dir.join(format!("{stem} ({i}){ext}"));
        if !cand.exists() {
            dst = cand;
            break;
        }
    }
    dst
}

fn copy_recursive(src: &Path, dst: &Path, depth: u32) -> io::Result<()> {
    if depth > 40 {
        return Err(io::Error::other("目录层级过深，可能存在符号链接循环"));
    }
    let meta = fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        return Ok(()); // 跳过符号链接，避免循环
    }
    if meta.is_dir() {
        fs::create_dir_all(dst)?;
        for item in fs::read_dir(src)? {
            let item = item?;
            copy_recursive(&item.path(), &dst.join(item.file_name()), depth + 1)?;
        }
        Ok(())
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst)?;
        Ok(())
    }
}

fn copy_paths_local(sources: &[String], dst_dir: &str) -> Vec<String> {
    let d = PathBuf::from(dst_dir);
    let mut errs = Vec::new();
    for s in sources {
        let sp = PathBuf::from(s);
        let name = sp
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.is_empty() {
            errs.push(format!("{s}: 无效路径"));
            continue;
        }
        let dst = unique_dst(&d, &name);
        if let Err(e) = copy_recursive(&sp, &dst, 0) {
            errs.push(format!("{s}: {e}"));
        }
    }
    errs
}

fn move_paths_local(sources: &[String], dst_dir: &str) -> Vec<String> {
    let d = PathBuf::from(dst_dir);
    let mut errs = Vec::new();
    for s in sources {
        let sp = PathBuf::from(s);
        let name = sp
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.is_empty() {
            errs.push(format!("{s}: 无效路径"));
            continue;
        }
        let dst = unique_dst(&d, &name);
        match fs::rename(&sp, &dst) {
            Ok(()) => {}
            Err(_) => {
                // 跨设备：复制后删除；复制中途失败（如 U 盘拔出）需清理半拷贝残留
                match copy_recursive(&sp, &dst, 0) {
                    Ok(()) => {
                        let del = if sp.is_dir() {
                            fs::remove_dir_all(&sp)
                        } else {
                            fs::remove_file(&sp)
                        };
                        if let Err(e) = del {
                            errs.push(format!("{s}: 已复制到目标位置，但删除源失败: {e}"));
                        }
                    }
                    Err(e) => {
                        if dst.is_dir() {
                            let _ = fs::remove_dir_all(&dst);
                        } else {
                            let _ = fs::remove_file(&dst);
                        }
                        errs.push(format!("{s}: {e}"));
                    }
                }
            }
        }
    }
    errs
}

/// Copy/move where the source and/or destination is a direct-mode USB path.
/// Transfers go through a local scratch copy when both ends are on USB.
async fn transfer_mixed(
    app: &AppHandle,
    sources: &[String],
    dst_dir: &str,
    is_move: bool,
) -> Vec<String> {
    let mut errs = Vec::new();
    let dst_raw = parse_raw(dst_dir);
    for s in sources {
        let src_raw = parse_raw(s);
        let name = match &src_raw {
            Some(rp) => rp.name(),
            None => Path::new(s)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
        };
        if name.is_empty() {
            errs.push(format!("{s}: 无效路径"));
            continue;
        }
        let r: Result<(), String> = async {
            match (&src_raw, &dst_raw) {
                (Some(src), None) => {
                    let dst = unique_dst(Path::new(dst_dir), &name);
                    usb::export(app, src, &dst, None).await?;
                    if is_move {
                        usb::delete(app, src)
                            .await
                            .map_err(|e| format!("已复制，但删除源失败: {e}"))?;
                    }
                    Ok(())
                }
                (None, Some(dir)) => {
                    let dst = usb::unique_child(app, dir, &name).await?;
                    usb::import(app, Path::new(s), &dst).await?;
                    if is_move {
                        let sp = Path::new(s);
                        let del = if sp.is_dir() {
                            fs::remove_dir_all(sp)
                        } else {
                            fs::remove_file(sp)
                        };
                        del.map_err(|e| format!("已复制，但删除源失败: {e}"))?;
                    }
                    Ok(())
                }
                (Some(src), Some(dir)) => {
                    let tmp = usb::temp_dir(app)?;
                    let local = tmp.join(&name);
                    let res = async {
                        usb::export(app, src, &local, None).await?;
                        let dst = usb::unique_child(app, dir, &name).await?;
                        usb::import(app, &local, &dst).await?;
                        if is_move {
                            usb::delete(app, src)
                                .await
                                .map_err(|e| format!("已复制，但删除源失败: {e}"))?;
                        }
                        Ok::<(), String>(())
                    }
                    .await;
                    let _ = fs::remove_dir_all(&tmp);
                    res
                }
                (None, None) => unreachable!(),
            }
        }
        .await;
        if let Err(e) = r {
            errs.push(format!("{s}: {e}"));
        }
    }
    errs
}

fn involves_raw(sources: &[String], dst_dir: &str) -> bool {
    parse_raw(dst_dir).is_some() || sources.iter().any(|s| parse_raw(s).is_some())
}

#[tauri::command]
pub async fn copy_paths(
    app: AppHandle,
    sources: Vec<String>,
    dst_dir: String,
) -> Result<Vec<String>, String> {
    if involves_raw(&sources, &dst_dir) {
        return Ok(transfer_mixed(&app, &sources, &dst_dir, false).await);
    }
    Ok(copy_paths_local(&sources, &dst_dir))
}

#[tauri::command]
pub async fn move_paths(
    app: AppHandle,
    sources: Vec<String>,
    dst_dir: String,
) -> Result<Vec<String>, String> {
    if involves_raw(&sources, &dst_dir) {
        return Ok(transfer_mixed(&app, &sources, &dst_dir, true).await);
    }
    Ok(move_paths_local(&sources, &dst_dir))
}

#[tauri::command]
pub async fn delete_path(app: AppHandle, path: String) -> Result<(), String> {
    if let Some(rp) = parse_raw(&path) {
        if rp.inner == "/" {
            return Err("不能删除根目录".into());
        }
        return usb::delete(&app, &rp).await;
    }
    let p = PathBuf::from(&path);
    if !p.exists() && fs::symlink_metadata(&p).is_err() {
        return Err("路径不存在".into());
    }
    if p.is_dir() {
        fs::remove_dir_all(&p).map_err(io_err)
    } else {
        fs::remove_file(&p).map_err(io_err)
    }
}

#[tauri::command]
pub async fn create_dir(app: AppHandle, path: String) -> Result<(), String> {
    if let Some(rp) = parse_raw(&path) {
        return usb::mkdir(&app, &rp).await;
    }
    fs::create_dir(&path).map_err(io_err)
}

#[tauri::command]
pub async fn rename_path(app: AppHandle, from: String, to: String) -> Result<(), String> {
    match (parse_raw(&from), parse_raw(&to)) {
        (Some(f), Some(t)) => {
            let parent = |p: &str| {
                p.rsplit_once('/')
                    .map(|(a, _)| a.to_string())
                    .unwrap_or_default()
            };
            if f.id != t.id || parent(&f.inner) != parent(&t.inner) {
                return Err("U 盘直接模式下仅支持在同一目录内重命名".into());
            }
            if usb::exists(&app, &t).await && !f.inner.eq_ignore_ascii_case(&t.inner) {
                return Err("目标名称已存在".into());
            }
            return usb::rename(&app, &f, &t.name()).await;
        }
        (None, None) => {}
        _ => return Err("不能在 U 盘直接模式与本机路径之间重命名".into()),
    }
    let t = PathBuf::from(&to);
    if t.exists() {
        return Err("目标名称已存在".into());
    }
    fs::rename(&from, &t).map_err(io_err)
}

#[derive(Debug, Clone, Serialize)]
pub struct TextContent {
    pub text: String,
    pub encoding: String,
    pub size: u64,
    pub truncated: bool,
}

const MAX_TEXT: u64 = 8 * 1024 * 1024;

#[tauri::command]
pub async fn read_text(
    app: AppHandle,
    path: String,
    max_bytes: Option<u64>,
) -> Result<TextContent, String> {
    if let Some(rp) = parse_raw(&path) {
        let st = usb::stat(&app, &rp).await?;
        if st.is_dir {
            return Err("这是一个目录".into());
        }
        let limit = max_bytes.unwrap_or(MAX_TEXT);
        let tmp = usb::temp_dir(&app)?;
        let local = tmp.join("text");
        let res = usb::export(&app, &rp, &local, Some(limit))
            .await
            .and_then(|_| fs::read(&local).map_err(io_err));
        let _ = fs::remove_dir_all(&tmp);
        return Ok(decode_text(res?, st.size, st.size > limit));
    }
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(io_err)?;
    if meta.is_dir() {
        return Err("这是一个目录".into());
    }
    let limit = max_bytes.unwrap_or(MAX_TEXT);
    let truncated = meta.len() > limit;
    let data = {
        use std::io::Read;
        let f = fs::File::open(&p).map_err(io_err)?;
        let mut buf = Vec::with_capacity(limit.min(meta.len()) as usize);
        f.take(limit).read_to_end(&mut buf).map_err(io_err)?;
        buf
    };
    Ok(decode_text(data, meta.len(), truncated))
}

fn decode_text(mut data: Vec<u8>, size: u64, truncated: bool) -> TextContent {
    // 去除 UTF-8 BOM
    let has_bom = data.starts_with(&[0xEF, 0xBB, 0xBF]);
    if has_bom {
        data.drain(..3);
    }
    let (text, encoding) = match std::str::from_utf8(&data) {
        Ok(_) => (
            String::from_utf8_lossy(&data).into_owned(),
            if has_bom { "UTF-8 BOM" } else { "UTF-8" }.to_string(),
        ),
        Err(_) => {
            let mut detector =
                chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
            detector.feed(&data, true);
            let enc = detector.guess(None, chardetng::Utf8Detection::Allow);
            let (cow, _, _) = enc.decode(&data);
            (cow.into_owned(), enc.name().to_string())
        }
    };
    TextContent {
        text,
        encoding,
        size,
        truncated,
    }
}

#[tauri::command]
pub async fn write_text(app: AppHandle, path: String, content: String) -> Result<(), String> {
    if let Some(rp) = parse_raw(&path) {
        let tmp = usb::temp_dir(&app)?;
        let local = tmp.join("text");
        let res = match fs::write(&local, content.as_bytes()) {
            Ok(()) => usb::import(&app, &local, &rp).await,
            Err(e) => Err(io_err(e)),
        };
        let _ = fs::remove_dir_all(&tmp);
        return res;
    }
    fs::write(&path, content.as_bytes()).map_err(io_err)
}

#[tauri::command]
pub async fn search(
    app: AppHandle,
    path: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<Entry>, String> {
    let limit = limit.unwrap_or(200).min(500);
    if let Some(rp) = parse_raw(&path) {
        return usb::search(&app, &rp, &query, limit).await;
    }
    let root = PathBuf::from(&path);
    let q = query.to_lowercase();
    let mut hits = Vec::new();
    let mut queue = std::collections::VecDeque::new();
    queue.push_back((root, 0u32));
    let mut visited = 0usize;
    while let Some((dir, depth)) = queue.pop_front() {
        if visited > 20000 || hits.len() >= limit {
            break;
        }
        if depth > 10 {
            continue;
        }
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for item in rd.flatten() {
            visited += 1;
            if visited > 20000 {
                break;
            }
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let matched = name.to_lowercase().contains(&q);
            let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if matched {
                if let Some(mut e) = entry_from(&dir, &name) {
                    e.path = item.path().to_string_lossy().into_owned();
                    hits.push(e);
                    if hits.len() >= limit {
                        break;
                    }
                }
            }
            if is_dir {
                queue.push_back((item.path(), depth + 1));
            }
        }
    }
    Ok(hits)
}

fn statvfs(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    unsafe {
        let mut st: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut st) == 0 {
            let bs = st.f_frsize as u64;
            return Some((st.f_blocks as u64 * bs, st.f_bavail as u64 * bs));
        }
    }
    None
}

fn probe_volume(path: PathBuf, name: &str, kind: &str) -> Option<Volume> {
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_dir() {
        return None;
    }
    // 可读性探测
    if fs::read_dir(&path).is_err() {
        return None;
    }
    let writable = fs::metadata(&path)
        .ok()
        .map(|m| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                (m.permissions().mode() & 0o200) != 0
            }
            #[cfg(not(unix))]
            {
                !m.permissions().readonly()
            }
        })
        .unwrap_or(false);
    let (total, avail) = statvfs(&path).unwrap_or((0, 0));
    Some(Volume {
        name: name.to_string(),
        path: path.to_string_lossy().into_owned(),
        kind: kind.to_string(),
        writable,
        total_bytes: total,
        available_bytes: avail,
        fs_type: String::new(),
        source: "system".into(),
        free_unknown: false,
    })
}

#[tauri::command]
pub async fn get_volumes(app: AppHandle) -> Vec<Volume> {
    #[cfg(target_os = "android")]
    {
        let status: Option<serde_json::Value> =
            usb::call(&app, "status", serde_json::json!({ "request": false }))
                .await
                .ok();
        android_volumes(status.as_ref())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        desktop_volumes()
    }
}

/// Volumes on Android: internal storage, volumes Android mounted (StorageManager, falling back to
/// scanning /storage), plus drives this app opened in direct mode (`/usbraw/<id>`).
#[cfg(target_os = "android")]
fn android_volumes(status: Option<&serde_json::Value>) -> Vec<Volume> {
    let mut vols = Vec::new();
    if let Some(v) = probe_volume(PathBuf::from("/storage/emulated/0"), "内部存储", "internal")
    {
        vols.push(v);
    }
    let mut removables: Vec<Volume> = Vec::new();
    let empty = Vec::new();
    let sys = status
        .and_then(|s| s.get("volumes"))
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    for v in sys {
        let path = v.get("path").and_then(|x| x.as_str()).unwrap_or("");
        let primary = v.get("primary").and_then(|x| x.as_bool()).unwrap_or(false);
        if path.is_empty() || primary || path.starts_with("/storage/emulated") {
            continue;
        }
        let desc = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
        let name = if desc.is_empty() {
            format!("外接存储 {}", path.rsplit('/').next().unwrap_or(""))
        } else {
            desc.to_string()
        };
        if let Some(mut vol) = probe_volume(PathBuf::from(path), &name, "removable") {
            vol.fs_type = v
                .get("fsType")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            removables.push(vol);
        }
    }
    // Fallback / complement: plain scan of /storage (works when StorageManager is unavailable)
    if let Ok(rd) = fs::read_dir("/storage") {
        for item in rd.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            if name == "emulated" || name == "self" || name.starts_with('.') {
                continue;
            }
            let p = item.path();
            if removables.iter().any(|v| Path::new(&v.path) == p) {
                continue;
            }
            if let Some(v) = probe_volume(p.clone(), &format!("外接存储 {name}"), "removable") {
                removables.push(v);
            }
        }
    }
    removables.sort_by(|a, b| a.path.cmp(&b.path));
    vols.extend(removables);
    let devs = status
        .and_then(|s| s.get("devices"))
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    for d in devs {
        if !d.get("mounted").and_then(|x| x.as_bool()).unwrap_or(false) {
            continue;
        }
        let s = |k: &str| d.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let n = |k: &str| d.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        let label = s("label");
        let product = s("product");
        let title = if !label.is_empty() {
            label
        } else if !product.is_empty() {
            product
        } else {
            "U 盘".into()
        };
        vols.push(Volume {
            name: format!("{title}（直接模式）"),
            path: s("root"),
            kind: "removable".into(),
            writable: !d.get("readOnly").and_then(|x| x.as_bool()).unwrap_or(true),
            total_bytes: n("capacity"),
            available_bytes: n("free"),
            fs_type: s("fsType"),
            source: "direct".into(),
            free_unknown: d.get("free").and_then(|x| x.as_i64()).unwrap_or(0) < 0,
        });
    }
    vols
}

#[cfg(not(target_os = "android"))]
fn desktop_volumes() -> Vec<Volume> {
    let mut vols = Vec::new();
    if let Some(v) = probe_volume(PathBuf::from("/"), "根目录", "system") {
        vols.push(v);
    }
    if let Some(home) = std::env::var_os("HOME") {
        if let Some(v) = probe_volume(PathBuf::from(home), "主目录", "internal") {
            vols.push(v);
        }
    }
    for base in ["/media", "/mnt", "/run/media"] {
        if let Ok(rd) = fs::read_dir(base) {
            for item in rd.flatten() {
                let name = item.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') {
                    continue;
                }
                let p = item.path();
                // /media 下通常是用户名目录，再看一层
                let mut found = false;
                if let Ok(sub) = fs::read_dir(&p) {
                    for s in sub.flatten() {
                        let sn = s.file_name().to_string_lossy().into_owned();
                        if sn.starts_with('.') {
                            continue;
                        }
                        if let Some(v) =
                            probe_volume(s.path(), &format!("{name}/{sn}"), "removable")
                        {
                            vols.push(v);
                            found = true;
                        }
                    }
                }
                if !found {
                    if let Some(v) = probe_volume(p.clone(), &name, "removable") {
                        vols.push(v);
                    }
                }
            }
        }
    }
    vols
}

/// Polls volumes + USB device state and emits `volumes-changed` on any change
/// (plug/unplug, permission granted, direct mode opened/ejected, system mount finished).
#[cfg(target_os = "android")]
pub fn start_volume_watcher(handle: tauri::AppHandle) {
    use tauri::Emitter;
    std::thread::spawn(move || {
        let key = |h: &tauri::AppHandle| -> String {
            let status: Option<serde_json::Value> =
                usb::call_blocking(h, "status", serde_json::json!({ "request": false })).ok();
            let vols: Vec<String> = android_volumes(status.as_ref())
                .into_iter()
                .map(|v| v.path)
                .collect();
            let devs: Vec<String> = status
                .as_ref()
                .and_then(|s| s.get("devices"))
                .and_then(|d| d.as_array())
                .map(|a| {
                    a.iter()
                        .map(|d| {
                            let b = |k: &str| d.get(k).and_then(|x| x.as_bool()).unwrap_or(false);
                            format!(
                                "{}:{}{}{}{}{}",
                                d.get("id").and_then(|x| x.as_i64()).unwrap_or(-1),
                                b("hasPermission") as u8,
                                b("permissionPending") as u8,
                                b("permissionDenied") as u8,
                                b("opened") as u8,
                                b("mounted") as u8
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            format!("{vols:?}|{devs:?}")
        };
        let mut last = key(&handle);
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            let now = key(&handle);
            if now != last {
                last = now;
                let _ = handle.emit("volumes-changed", ());
            }
        }
    });
}

#[cfg(not(target_os = "android"))]
pub fn start_volume_watcher(_handle: tauri::AppHandle) {}
