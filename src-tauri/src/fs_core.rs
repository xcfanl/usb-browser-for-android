use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
#[cfg(target_os = "android")]
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct Volume {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub writable: bool,
    pub total_bytes: u64,
    pub available_bytes: u64,
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
        io::ErrorKind::PermissionDenied => "没有访问权限（请检查是否已授予“所有文件访问”权限）".into(),
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
    let real_meta = if is_symlink { fs::metadata(&path).ok() } else { Some(meta) };
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
pub fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    if path.is_empty() {
        return Err("空路径".into());
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
pub fn stat_path(path: String) -> Result<Entry, String> {
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

#[tauri::command]
pub fn copy_paths(sources: Vec<String>, dst_dir: String) -> Result<Vec<String>, String> {
    let d = PathBuf::from(&dst_dir);
    let mut errs = Vec::new();
    for s in &sources {
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
    Ok(errs)
}

#[tauri::command]
pub fn move_paths(sources: Vec<String>, dst_dir: String) -> Result<Vec<String>, String> {
    let d = PathBuf::from(&dst_dir);
    let mut errs = Vec::new();
    for s in &sources {
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
                // 跨设备：复制后删除
                match copy_recursive(&sp, &dst, 0).and_then(|_| fs::symlink_metadata(&sp).map(|m| m).and_then(|_| {
                    if sp.is_dir() {
                        fs::remove_dir_all(&sp)
                    } else {
                        fs::remove_file(&sp)
                    }
                })) {
                    Ok(()) => {}
                    Err(e) => errs.push(format!("{s}: {e}")),
                }
            }
        }
    }
    Ok(errs)
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
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
pub fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir(&path).map_err(io_err)
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
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
pub fn read_text(path: String, max_bytes: Option<u64>) -> Result<TextContent, String> {
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(io_err)?;
    if meta.is_dir() {
        return Err("这是一个目录".into());
    }
    let limit = max_bytes.unwrap_or(MAX_TEXT);
    let truncated = meta.len() > limit;
    let mut data = {
        use std::io::Read;
        let f = fs::File::open(&p).map_err(io_err)?;
        let mut buf = Vec::with_capacity(limit.min(meta.len()) as usize);
        f.take(limit)
            .read_to_end(&mut buf)
            .map_err(io_err)?;
        buf
    };
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
            let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
            detector.feed(&data, true);
            let enc = detector.guess(None, chardetng::Utf8Detection::Allow);
            let (cow, _, _) = enc.decode(&data);
            (cow.into_owned(), enc.name().to_string())
        }
    };
    Ok(TextContent { text, encoding, size: meta.len(), truncated })
}

#[tauri::command]
pub fn write_text(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content.as_bytes()).map_err(io_err)
}

#[tauri::command]
pub fn search(path: String, query: String, limit: Option<usize>) -> Result<Vec<Entry>, String> {
    let root = PathBuf::from(&path);
    let q = query.to_lowercase();
    let limit = limit.unwrap_or(200).min(500);
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
    })
}

#[tauri::command]
pub fn get_volumes() -> Vec<Volume> {
    let mut vols = Vec::new();
    #[cfg(target_os = "android")]
    {
        if let Some(v) = probe_volume(PathBuf::from("/storage/emulated/0"), "内部存储", "internal") {
            vols.push(v);
        }
        if let Ok(rd) = fs::read_dir("/storage") {
            let mut removables = Vec::new();
            for item in rd.flatten() {
                let name = item.file_name().to_string_lossy().into_owned();
                if name == "emulated" || name == "self" || name.starts_with('.') {
                    continue;
                }
                let p = item.path();
                if let Some(v) = probe_volume(p.clone(), &format!("外接存储 {name}"), "removable") {
                    removables.push(v);
                }
            }
            removables.sort_by(|a, b| a.path.cmp(&b.path));
            vols.extend(removables);
        }
    }
    #[cfg(not(target_os = "android"))]
    {
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
    }
    vols
}

#[cfg(target_os = "android")]
pub fn start_volume_watcher(handle: tauri::AppHandle) {
    use tauri::Emitter;
    std::thread::spawn(move || {
        fn keys() -> Vec<String> {
            get_volumes().into_iter().map(|v| v.path).collect()
        }
        let mut last = keys();
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            let now = keys();
            if now != last {
                last = now;
                let _ = handle.emit("volumes-changed", ());
            }
        }
    });
}

#[cfg(not(target_os = "android"))]
pub fn start_volume_watcher(_handle: tauri::AppHandle) {}
