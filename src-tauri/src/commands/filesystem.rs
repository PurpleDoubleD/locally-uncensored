use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::Engine;
use glob::glob as glob_match;
use regex::Regex;
use walkdir::WalkDir;

/// Strip duplicate drive-letter prefixes, e.g.
/// `D:/a/D:/a/file.txt` → `D:/a/file.txt`. See commands/agent.rs for
/// the full rationale — same bug surface for fs_list / fs_search.
fn normalize_duplicate_drive_prefix(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.len() < 3 { return path.to_string(); }
    let mut last_drive_idx: Option<usize> = None;
    let mut i = 1;
    while i + 1 < bytes.len() {
        if bytes[i] == b':'
            && bytes[i - 1].is_ascii_alphabetic()
            && (bytes[i + 1] == b'/' || bytes[i + 1] == b'\\')
        {
            last_drive_idx = Some(i - 1);
        }
        i += 1;
    }
    match last_drive_idx {
        Some(idx) if idx > 0 => path[idx..].to_string(),
        _ => path.to_string(),
    }
}

/// Resolve path — supports absolute and relative (relative to the
/// per-chat workspace `~/agent-workspace/<chat_id>/`). Mirrors the
/// pattern in agent.rs. `chat_id` is sanitised to the charset
/// `[A-Za-z0-9_\-\.]` (anything else → `_`) and capped at 64 chars to
/// prevent path traversal. Missing chat_id falls back to `default`.
fn resolve_path(path: &str, chat_id: Option<&str>) -> PathBuf {
    let cleaned = normalize_duplicate_drive_prefix(path);
    let p = Path::new(&cleaned);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        let id = chat_id.unwrap_or("default");
        let safe: String = id
            .chars()
            .take(64)
            .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' { c } else { '_' })
            .collect();
        let slug = if safe.is_empty() { "default".to_string() } else { safe };
        dirs::home_dir()
            .unwrap_or_default()
            .join("agent-workspace")
            .join(slug)
            .join(&cleaned)
    }
}

fn file_meta(path: &Path) -> serde_json::Value {
    let meta = fs::metadata(path);
    let (size, modified, is_dir) = match meta {
        Ok(m) => (
            m.len(),
            m.modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            m.is_dir(),
        ),
        Err(_) => (0, 0, false),
    };
    serde_json::json!({
        "name": path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        "path": path.to_string_lossy(),
        "size": size,
        "isDir": is_dir,
        "modified": modified,
    })
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn fs_read(path: String, chatId: Option<String>) -> Result<serde_json::Value, String> {
    let full = resolve_path(&path, chatId.as_deref());
    if !full.exists() {
        return Err(format!("File not found: {}", full.display()));
    }

    // Try text first, fall back to base64 for binary
    match fs::read_to_string(&full) {
        Ok(content) => Ok(serde_json::json!({ "content": content, "encoding": "utf8" })),
        Err(_) => {
            let bytes = fs::read(&full).map_err(|e| format!("Read error: {}", e))?;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            Ok(serde_json::json!({ "content": b64, "encoding": "base64" }))
        }
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn fs_write(path: String, content: String, chatId: Option<String>) -> Result<serde_json::Value, String> {
    let full = resolve_path(&path, chatId.as_deref());
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Create dir: {}", e))?;
    }
    fs::write(&full, &content).map_err(|e| format!("Write error: {}", e))?;
    Ok(serde_json::json!({ "status": "saved", "path": full.to_string_lossy() }))
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn fs_list(
    path: String,
    recursive: Option<bool>,
    pattern: Option<String>,
    chatId: Option<String>,
) -> Result<serde_json::Value, String> {
    let dir = resolve_path(&path, chatId.as_deref());
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", dir.display()));
    }

    let mut entries: Vec<serde_json::Value> = Vec::new();
    let max_entries = 500;

    if let Some(ref pat) = pattern {
        // Glob pattern relative to dir
        let glob_pattern = dir.join(pat).to_string_lossy().to_string();
        if let Ok(paths) = glob_match(&glob_pattern) {
            for entry in paths.flatten() {
                if entries.len() >= max_entries {
                    break;
                }
                entries.push(file_meta(&entry));
            }
        }
    } else if recursive.unwrap_or(false) {
        for entry in WalkDir::new(&dir).max_depth(5).into_iter().filter_map(|e| e.ok()) {
            if entries.len() >= max_entries {
                break;
            }
            entries.push(file_meta(entry.path()));
        }
    } else {
        let read_dir = fs::read_dir(&dir).map_err(|e| format!("Read dir: {}", e))?;
        for entry in read_dir.flatten() {
            if entries.len() >= max_entries {
                break;
            }
            entries.push(file_meta(&entry.path()));
        }
    }

    Ok(serde_json::json!({ "entries": entries, "count": entries.len() }))
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn fs_search(
    path: String,
    pattern: String,
    max_results: Option<u32>,
    chatId: Option<String>,
) -> Result<serde_json::Value, String> {
    let dir = resolve_path(&path, chatId.as_deref());
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", dir.display()));
    }

    let re = Regex::new(&pattern).map_err(|e| format!("Invalid regex: {}", e))?;
    let max = max_results.unwrap_or(50) as usize;
    let mut results: Vec<serde_json::Value> = Vec::new();

    for entry in WalkDir::new(&dir).max_depth(8).into_iter().filter_map(|e| e.ok()) {
        if results.len() >= max {
            break;
        }
        let p = entry.path();
        if !p.is_file() {
            continue;
        }

        // Skip binary / large files
        let meta = fs::metadata(p);
        if let Ok(m) = &meta {
            if m.len() > 1_000_000 {
                continue;
            }
        }

        if let Ok(content) = fs::read_to_string(p) {
            let mut matches: Vec<serde_json::Value> = Vec::new();
            for (line_num, line) in content.lines().enumerate() {
                if re.is_match(line) {
                    matches.push(serde_json::json!({
                        "line": line_num + 1,
                        "text": if line.len() > 200 { &line[..200] } else { line },
                    }));
                    if matches.len() >= 10 {
                        break;
                    }
                }
            }
            if !matches.is_empty() {
                results.push(serde_json::json!({
                    "file": p.to_string_lossy(),
                    "matches": matches,
                }));
            }
        }
    }

    Ok(serde_json::json!({ "results": results, "count": results.len() }))
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn fs_info(path: String, chatId: Option<String>) -> Result<serde_json::Value, String> {
    let full = resolve_path(&path, chatId.as_deref());
    if !full.exists() {
        return Err(format!("Path not found: {}", full.display()));
    }
    let meta = fs::metadata(&full).map_err(|e| format!("Metadata error: {}", e))?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let created = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(serde_json::json!({
        "path": full.to_string_lossy(),
        "size": meta.len(),
        "isDir": meta.is_dir(),
        "isFile": meta.is_file(),
        "modified": modified,
        "created": created,
        "readonly": meta.permissions().readonly(),
    }))
}

/// Show a native "Save As…" dialog and write the given text content to the
/// chosen path. Used by Export Chat (markdown / JSON). Returns the chosen
/// path, or null when the user cancelled.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn save_text_file_dialog(
    content: String,
    defaultName: Option<String>,
    extension: Option<String>,
    ext_label: Option<String>,
) -> Result<Option<String>, String> {
    let default_name = defaultName.unwrap_or_else(|| "export.txt".to_string());
    let ext = extension.unwrap_or_else(|| "txt".to_string());
    let label = ext_label.unwrap_or_else(|| format!("{} file", ext.to_uppercase()));

    // rfd::AsyncFileDialog runs the native Windows/macOS/Linux save dialog
    // without any extra Tauri plugin.
    let file = rfd::AsyncFileDialog::new()
        .set_file_name(&default_name)
        .add_filter(&label, &[ext.as_str()])
        .save_file()
        .await;

    match file {
        Some(handle) => {
            let path = handle.path().to_path_buf();
            std::fs::write(&path, content).map_err(|e| format!("Write failed: {}", e))?;
            Ok(Some(path.to_string_lossy().into_owned()))
        }
        None => Ok(None),
    }
}

/// Binary counterpart to `save_text_file_dialog`. Used by the Download
/// buttons in the Create view's Gallery / OutputDisplay / MediaViewer.
///
/// Why a dedicated Rust command instead of the JS `<a download>` trick?
/// In Tauri's Webview2 the blob-URL anchor-click pattern is unreliable
/// — most of the time the webview simply navigates to the blob URL
/// instead of saving it, so the user saw "nothing happens". Going
/// through a native Save As dialog guarantees the bytes hit the disk.
///
/// `bytes` is expected as a raw number[] over the Tauri IPC (the JS
/// side passes `Array.from(new Uint8Array(blob))`). Returns the chosen
/// path, or null when the user cancelled.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn save_binary_file_dialog(
    bytes: Vec<u8>,
    defaultName: Option<String>,
    extension: Option<String>,
    ext_label: Option<String>,
) -> Result<Option<String>, String> {
    let default_name = defaultName.unwrap_or_else(|| "download.bin".to_string());
    let ext = extension.unwrap_or_else(|| {
        // Infer from defaultName if caller didn't tell us — cheap split.
        default_name.rsplit_once('.').map(|(_, e)| e.to_string()).unwrap_or_else(|| "bin".to_string())
    });
    let label = ext_label.unwrap_or_else(|| format!("{} file", ext.to_uppercase()));

    let file = rfd::AsyncFileDialog::new()
        .set_file_name(&default_name)
        .add_filter(&label, &[ext.as_str()])
        .save_file()
        .await;

    match file {
        Some(handle) => {
            let path = handle.path().to_path_buf();
            std::fs::write(&path, &bytes).map_err(|e| format!("Write failed: {}", e))?;
            Ok(Some(path.to_string_lossy().into_owned()))
        }
        None => Ok(None),
    }
}
