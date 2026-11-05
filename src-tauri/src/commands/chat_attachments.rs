//! Chat image attachments, stored as files beside the native store backup.
//!
//! A chat image used to live inline in the chat history as base64, and the
//! history is serialised as one string on every save, every backup and every
//! restore. A few dozen phone photos made that string hundreds of megabytes
//! and took the renderer down with "Out of Memory". The WebView now stores a
//! reference (`lu-attachment:v1:<sha256>`) and the bytes live here.
//!
//! Everything that has to touch a whole history with its images happens on
//! this side, in native memory and off the main thread:
//!   * restore: an old backup is migrated before the WebView sees it,
//!   * export: references are replaced by the image bytes while streaming to
//!     the chosen file, so the WebView never builds the full export string,
//!   * import: an export with inline images is moved into files before the
//!     WebView parses it.
//!
//! Files are content addressed and immutable. No caller-supplied paths: the id
//! is 64 lowercase hex characters or the call is refused.

use crate::os_error;
// Only the desktop dialog commands below use these two.
#[cfg_attr(mobile, allow(unused_imports))]
use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
#[cfg_attr(mobile, allow(unused_imports))]
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub(crate) const PREFIX: &str = "lu-attachment:v1:";
pub(crate) const CHAT_KEY: &str = "chat-conversations";

pub(crate) fn attachment_dir() -> Result<PathBuf, String> {
    Ok(crate::commands::system::persistent_dir()?.join("chat-attachments"))
}

fn is_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn attachment_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !is_id(id) {
        return Err("Invalid attachment id".into());
    }
    Ok(dir.join(id))
}

pub(crate) fn content_id(data: &str) -> String {
    format!("{:x}", Sha256::digest(data.as_bytes()))
}

/// Write one attachment. Idempotent: an intact file with this id is left
/// alone, a damaged one is replaced, and the rename is atomic either way.
pub(crate) fn write_attachment(dir: &Path, id: &str, data: &str) -> Result<(), String> {
    let path = attachment_path(dir, id)?;
    if content_id(data) != id {
        return Err("Attachment checksum mismatch".into());
    }
    if read_attachment(dir, id).is_ok() {
        return Ok(());
    }
    std::fs::create_dir_all(dir).map_err(|e| os_error::english(&e))?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| os_error::english(&e))?;
    tmp.write_all(data.as_bytes()).map_err(|e| os_error::english(&e))?;
    tmp.as_file().sync_all().map_err(|e| os_error::english(&e))?;
    tmp.persist(&path).map_err(|e| os_error::english(&e.error))?;
    Ok(())
}

pub(crate) fn read_attachment(dir: &Path, id: &str) -> Result<String, String> {
    let path = attachment_path(dir, id)?;
    let data = std::fs::read_to_string(&path)
        .map_err(|_| "Chat attachment is missing. Please attach the original image again.".to_string())?;
    if content_id(&data) != id {
        return Err("Chat attachment is damaged. Please attach the original image again.".into());
    }
    Ok(data)
}

#[tauri::command]
pub async fn write_chat_attachment(id: String, data: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_attachment(&attachment_dir()?, &id, &data))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_chat_attachment(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_attachment(&attachment_dir()?, &id))
        .await
        .map_err(|e| e.to_string())?
}

// ── Moving inline images into files ─────────────────────────────────────

/// Replace every inline image in a list of conversations by a reference.
/// An image whose file cannot be written keeps its inline data: slower, never
/// lost. Returns how many images moved.
pub(crate) fn externalize_conversations(conversations: &mut Value, dir: &Path) -> usize {
    let mut moved = 0;
    let Some(list) = conversations.as_array_mut() else { return 0 };
    for conversation in list {
        let Some(messages) = conversation.get_mut("messages").and_then(Value::as_array_mut) else { continue };
        for message in messages {
            let Some(images) = message.get_mut("images").and_then(Value::as_array_mut) else { continue };
            for image in images {
                let Some(data) = image.get("data").and_then(Value::as_str) else { continue };
                if data.is_empty() || data.starts_with(PREFIX) {
                    continue;
                }
                let id = content_id(data);
                match write_attachment(dir, &id, data) {
                    Ok(()) => {
                        image["data"] = Value::String(format!("{PREFIX}{id}"));
                        moved += 1;
                    }
                    Err(e) => tracing::warn!("chat image stays inline, its file could not be written: {e}"),
                }
            }
        }
    }
    moved
}

/// The store backup with its chat images moved into files, or None when there
/// was nothing to move (or nothing this function understands, in which case the
/// caller hands the backup over unchanged, exactly as before).
pub(crate) fn externalize_store_backup(raw: &str, dir: &Path) -> Option<String> {
    // Cheap exit for every backup written since the attachment store: no
    // inline image, no parse.
    if !raw.contains("\\\"images\\\"") {
        return None;
    }
    let Ok(Value::Object(mut outer)) = serde_json::from_str::<Value>(raw) else { return None };
    let mut inner: Value = serde_json::from_str(outer.get(CHAT_KEY)?.as_str()?).ok()?;
    let moved = externalize_conversations(inner.pointer_mut("/state/conversations")?, dir);
    if moved == 0 {
        return None;
    }
    tracing::info!("moved {moved} chat images out of the store backup");
    outer.insert(CHAT_KEY.into(), Value::String(inner.to_string()));
    Some(Value::Object(outer).to_string())
}

/// An import file with its inline images moved into files. Accepts the three
/// shapes the WebView accepts (bundle, bare array, single conversation) and
/// hands the file back in the same shape.
pub(crate) fn externalize_import(raw: &str, dir: &Path) -> Result<String, String> {
    let mut data: Value = serde_json::from_str(raw).map_err(|_| "That file is not valid JSON.".to_string())?;
    // A store backup (store_backup*.json from the app data folder, perhaps
    // copied back from a rescue folder, 3.0.10): its chats are a JSON string
    // under chat-conversations. They are handed on as a plain list, the shape
    // the import already reads, and the rest of the backup stays out of it.
    if let Some(chat) = data.get(CHAT_KEY).and_then(Value::as_str) {
        let inner: Value = serde_json::from_str(chat).map_err(|_| "The chats in that backup could not be read.".to_string())?;
        data = inner.pointer("/state/conversations").filter(|v| v.is_array()).cloned().unwrap_or(Value::Array(Vec::new()));
    }
    if data.is_array() {
        externalize_conversations(&mut data, dir);
    } else if let Some(list) = data.get_mut("conversations").filter(|v| v.is_array()) {
        externalize_conversations(list, dir);
    } else if data.get("messages").map(Value::is_array).unwrap_or(false) {
        let mut wrapped = Value::Array(vec![data]);
        externalize_conversations(&mut wrapped, dir);
        data = wrapped.as_array_mut().and_then(|a| a.pop()).unwrap_or(Value::Null);
    }
    Ok(data.to_string())
}

// ── Export ───────────────────────────────────────────────────────────────

/// Write an export, replacing every `"data": "lu-attachment:v1:<id>"` by the
/// image itself. The WebView sends the small form (references), this streams
/// the large one to disk, so no full export string ever exists in memory.
/// A reference whose file is missing stays as it is and is counted.
pub(crate) fn write_export<W: Write>(content: &str, out: &mut W, dir: &Path) -> std::io::Result<usize> {
    let mut missing = 0;
    let mut at = 0;
    while let Some(found) = content[at..].find(PREFIX) {
        let start = at + found;
        let id_end = start + PREFIX.len() + 64;
        let id = content.get(start + PREFIX.len()..id_end).unwrap_or("");
        let is_image_data = is_id(id)
            && content[..start].ends_with('"')
            && content[id_end..].starts_with('"')
            && content[..start - 1].trim_end().strip_suffix(':').map(|k| k.trim_end().ends_with("\"data\"")).unwrap_or(false);
        out.write_all(&content.as_bytes()[at..start])?;
        if is_image_data {
            match read_attachment(dir, id) {
                Ok(data) => out.write_all(data.as_bytes())?,
                Err(_) => {
                    missing += 1;
                    out.write_all(&content.as_bytes()[start..id_end])?;
                }
            }
            at = id_end;
        } else {
            out.write_all(PREFIX.as_bytes())?;
            at = start + PREFIX.len();
        }
    }
    out.write_all(&content.as_bytes()[at..])?;
    Ok(missing)
}

#[derive(serde::Serialize)]
pub struct ExportOutcome {
    path: String,
    missing: usize,
}

/// Save As for a chat export (one chat or all), with the images put back in.
#[cfg(desktop)]
#[tauri::command]
#[allow(non_snake_case)]
pub async fn export_chats_dialog(content: String, defaultName: String) -> Result<Option<ExportOutcome>, String> {
    let Some(handle) = rfd::AsyncFileDialog::new()
        .set_file_name(&defaultName)
        .add_filter("JSON", &["json"])
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let path = handle.path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = attachment_dir()?;
        let written = std::fs::File::create(&path).and_then(|file| {
            let mut out = BufWriter::new(file);
            let missing = write_export(&content, &mut out, &dir)?;
            out.flush()?;
            out.get_ref().sync_all()?;
            Ok(missing)
        });
        match written {
            Ok(missing) => Ok(Some(ExportOutcome { path: path.to_string_lossy().into_owned(), missing })),
            Err(e) => {
                // A half written export must not look like a finished one.
                let _ = std::fs::remove_file(&path);
                Err(format!("Write failed: {}", os_error::english(&e)))
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The phone version. The export is streamed into a temp file of the app, the
/// same way the desktop streams it to the chosen path, and the system's own
/// picker saves it from there (`mobile_native::save_with_picker`). `path` is
/// then a content address on Android and a file address on iOS.
#[cfg(mobile)]
#[tauri::command]
#[allow(non_snake_case)]
pub async fn export_chats_dialog(
    app: tauri::AppHandle,
    content: String,
    defaultName: String,
) -> Result<Option<ExportOutcome>, String> {
    let name = crate::commands::mobile_native::file_name_for(Some(defaultName), Some("json"), "lu-chats.json");
    let saved = crate::commands::mobile_native::save_with_picker(&app, &name, Some("application/json"), move |file| {
        let dir = attachment_dir()?;
        std::fs::File::create(file)
            .and_then(|f| {
                let mut out = BufWriter::new(f);
                let missing = write_export(&content, &mut out, &dir)?;
                out.flush()?;
                Ok(missing)
            })
            .map_err(|e| format!("Write failed: {}", os_error::english(&e)))
    })
    .await?;
    Ok(saved.map(|(path, missing)| ExportOutcome { path, missing }))
}

/// Open dialog for a chat import. Returns the file with its inline images
/// already moved into attachments, or None when the user cancelled.
#[cfg(desktop)]
#[tauri::command]
pub async fn import_chats_dialog() -> Result<Option<String>, String> {
    let Some(handle) = rfd::AsyncFileDialog::new().add_filter("JSON", &["json"]).pick_file().await else {
        return Ok(None);
    };
    let path = handle.path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let raw = std::fs::read_to_string(&path).map_err(|_| "Could not read that file.".to_string())?;
        externalize_import(&raw, &attachment_dir()?).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(mobile)]
#[tauri::command]
pub async fn import_chats_dialog() -> Result<Option<String>, String> {
    Err(crate::commands::filesystem::NO_FILE_DIALOG.to_string())
}

/// Save one chat image as a real image file. The WebView's own download path
/// (an anchor on a blob URL) is unreliable in WebView2, see
/// `save_binary_file_dialog`.
#[cfg(desktop)]
#[tauri::command]
#[allow(non_snake_case)]
pub async fn save_chat_attachment_dialog(id: String, defaultName: String, mimeType: String) -> Result<Option<String>, String> {
    let data = tauri::async_runtime::spawn_blocking(move || read_attachment(&attachment_dir()?, &id))
        .await
        .map_err(|e| e.to_string())??;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| "Chat attachment is damaged. Please attach the original image again.".to_string())?;
    let ext = match mimeType.as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/avif" => "avif",
        _ => "png",
    };
    let Some(handle) = rfd::AsyncFileDialog::new()
        .set_file_name(&defaultName)
        .add_filter("Image", &[ext])
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let path = handle.path().to_path_buf();
    std::fs::write(&path, &bytes).map_err(|e| format!("Write failed: {}", os_error::english(&e)))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// The phone version: the image goes through the system's picker like every
/// other saved file. Putting it into the photo library instead is
/// `saveToPhotos` of src/lib/lu-native.ts.
#[cfg(mobile)]
#[tauri::command]
#[allow(non_snake_case)]
pub async fn save_chat_attachment_dialog(
    app: tauri::AppHandle,
    id: String,
    defaultName: String,
    mimeType: String,
) -> Result<Option<String>, String> {
    let (ext, mime) = match mimeType.as_str() {
        "image/jpeg" | "image/jpg" => ("jpg", "image/jpeg"),
        "image/webp" => ("webp", "image/webp"),
        "image/gif" => ("gif", "image/gif"),
        "image/bmp" => ("bmp", "image/bmp"),
        "image/avif" => ("avif", "image/avif"),
        _ => ("png", "image/png"),
    };
    let name = crate::commands::mobile_native::file_name_for(Some(defaultName), Some(ext), "image.png");
    let saved = crate::commands::mobile_native::save_with_picker(&app, &name, Some(mime), move |file| {
        let data = read_attachment(&attachment_dir()?, &id)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.as_bytes())
            .map_err(|_| "Chat attachment is damaged. Please attach the original image again.".to_string())?;
        std::fs::write(file, &bytes).map_err(|e| format!("Write failed: {}", os_error::english(&e)))
    })
    .await?;
    Ok(saved.map(|(place, ())| place))
}

// ── Deleting what nothing points at any more ────────────────────────────

/// A file younger than this is never deleted: it may belong to a message the
/// WebView has saved but no backup has caught yet.
const GC_MIN_AGE: Duration = Duration::from_secs(60 * 60);
const GC_INTERVAL: Duration = Duration::from_secs(10 * 60);
static GC_LAST: Mutex<Option<Instant>> = Mutex::new(None);

/// Every attachment id mentioned anywhere in these files. A file that exists
/// but cannot be read is an error: then the set is incomplete and nothing may
/// be deleted.
fn referenced_ids(files: &[PathBuf]) -> Result<HashSet<String>, String> {
    let mut ids = HashSet::new();
    for path in files {
        let meta = match std::fs::metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(os_error::english(&e)),
        };
        // The set aside store_backup.prev.json never changes and may be a
        // large pre-attachment file; scan each file version once.
        let stamp = (meta.modified().map_err(|e| os_error::english(&e))?, meta.len());
        let cached = SCAN_CACHE.lock().ok().and_then(|c| c.get(path).filter(|(s, _)| *s == stamp).map(|(_, ids)| ids.clone()));
        let found = match cached {
            Some(found) => found,
            None => {
                let found = scan_file(path)?;
                if let Ok(mut cache) = SCAN_CACHE.lock() {
                    cache.insert(path.clone(), (stamp, found.clone()));
                }
                found
            }
        };
        ids.extend(found);
    }
    Ok(ids)
}

type ScanStamp = (std::time::SystemTime, u64);
type ScanCache = std::collections::HashMap<PathBuf, (ScanStamp, HashSet<String>)>;
static SCAN_CACHE: std::sync::LazyLock<Mutex<ScanCache>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

fn scan_file(path: &Path) -> Result<HashSet<String>, String> {
    let mut ids = HashSet::new();
    let keep = PREFIX.len() + 64;
    {
        let mut file = std::fs::File::open(path).map_err(|e| os_error::english(&e))?;
        let mut window: Vec<u8> = Vec::new();
        let mut chunk = vec![0u8; 1 << 20];
        loop {
            let n = file.read(&mut chunk).map_err(|e| os_error::english(&e))?;
            if n == 0 {
                break;
            }
            window.extend_from_slice(&chunk[..n]);
            let mut i = 0;
            while let Some(pos) = find(&window[i..], PREFIX.as_bytes()) {
                let start = i + pos + PREFIX.len();
                if start + 64 > window.len() {
                    break;
                }
                if let Ok(id) = std::str::from_utf8(&window[start..start + 64]) {
                    if is_id(id) {
                        ids.insert(id.to_string());
                    }
                }
                i = start;
            }
            // Keep a tail long enough to hold a reference cut by the chunk edge.
            let tail = window.len().saturating_sub(keep);
            window.drain(..tail);
        }
    }
    Ok(ids)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Delete attachment files that no store and no backup refers to.
///
/// Only runs against a live backup that carries the chat store, so the set of
/// references is never judged from a snapshot that is missing the chats.
pub(crate) fn collect_garbage(store_dir: &Path, dir: &Path, min_age: Duration) -> Result<usize, String> {
    let live = store_dir.join("store_backup.json");
    let head = std::fs::read(&live).map_err(|e| os_error::english(&e))?;
    if find(&head, format!("\"{CHAT_KEY}\"").as_bytes()).is_none() {
        return Ok(0);
    }
    drop(head);
    let refs = referenced_ids(&crate::commands::system::backup_candidates(store_dir))?;
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(os_error::english(&e)),
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let old_enough = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|age| age >= min_age)
            .unwrap_or(false);
        if !old_enough {
            continue;
        }
        // Content files nothing refers to, and temp files a crash left behind.
        let orphan = (is_id(&name) && !refs.contains(&name)) || name.starts_with(".tmp");
        if orphan && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Schedule a collection after a complete backup landed, at most once per
/// interval, on its own thread.
pub(crate) fn collect_garbage_soon(store_dir: PathBuf) {
    {
        let Ok(mut last) = GC_LAST.lock() else { return };
        if last.map(|t| t.elapsed() < GC_INTERVAL).unwrap_or(false) {
            return;
        }
        *last = Some(Instant::now());
    }
    std::thread::spawn(move || {
        let dir = store_dir.join("chat-attachments");
        match collect_garbage(&store_dir, &dir, GC_MIN_AGE) {
            Ok(0) => {}
            Ok(n) => tracing::info!("removed {n} chat images that no chat refers to any more"),
            Err(e) => tracing::warn!("chat image cleanup skipped: {e}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(data: &str) -> String {
        format!("{PREFIX}{}", content_id(data))
    }

    fn age(path: &Path) {
        let old = std::time::SystemTime::now() - Duration::from_secs(2 * 60 * 60);
        std::fs::File::options().write(true).open(path).unwrap().set_modified(old).unwrap();
    }

    #[test]
    fn original_survives_roundtrip_and_duplicate_write() {
        let dir = tempfile::tempdir().unwrap();
        let data = "YWJj";
        let id = content_id(data);
        write_attachment(dir.path(), &id, data).unwrap();
        write_attachment(dir.path(), &id, data).unwrap();
        assert_eq!(read_attachment(dir.path(), &id).unwrap(), data);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn bad_checksum_and_traversal_never_create_an_attachment() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write_attachment(dir.path(), &"a".repeat(64), "YWJj").is_err());
        assert!(write_attachment(dir.path(), "../store_backup.json", "YWJj").is_err());
        assert!(read_attachment(dir.path(), "../store_backup.json").is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_damaged_file_is_reported_and_repaired_by_the_next_write() {
        let dir = tempfile::tempdir().unwrap();
        let id = content_id("YWJj");
        assert!(read_attachment(dir.path(), &id).is_err());
        std::fs::write(dir.path().join(&id), "damaged").unwrap();
        assert!(read_attachment(dir.path(), &id).is_err());
        write_attachment(dir.path(), &id, "YWJj").unwrap();
        assert_eq!(read_attachment(dir.path(), &id).unwrap(), "YWJj");
    }

    fn legacy_backup(images: &[&str]) -> String {
        let imgs: Vec<Value> = images
            .iter()
            .map(|d| serde_json::json!({ "data": d, "mimeType": "image/png", "name": "a.png" }))
            .collect();
        let chat = serde_json::json!({
            "state": { "conversations": [ { "id": "c1", "title": "t", "messages": [
                { "id": "m1", "role": "user", "content": "look", "images": imgs },
                { "id": "m2", "role": "assistant", "content": "ok" }
            ] } ] },
            "version": 0
        });
        serde_json::json!({ "__ts": "x", CHAT_KEY: chat.to_string(), "settings": "{\"a\":1}" }).to_string()
    }

    #[test]
    fn restore_moves_inline_images_out_and_keeps_everything_else() {
        let dir = tempfile::tempdir().unwrap();
        let raw = legacy_backup(&["QUJD", "REVG"]);
        let out = externalize_store_backup(&raw, dir.path()).expect("migrated");
        assert!(!out.contains("QUJD") && !out.contains("REVG"));
        assert!(out.contains(&reference("QUJD")) && out.contains(&reference("REVG")));
        assert_eq!(read_attachment(dir.path(), &content_id("QUJD")).unwrap(), "QUJD");
        let outer: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(outer["settings"], "{\"a\":1}");
        assert_eq!(outer["__ts"], "x");
        let inner: Value = serde_json::from_str(outer[CHAT_KEY].as_str().unwrap()).unwrap();
        assert_eq!(inner["state"]["conversations"][0]["messages"][1]["content"], "ok");
        assert_eq!(inner["version"], 0);
        // Idempotent: a migrated backup has nothing left to move.
        assert!(externalize_store_backup(&out, dir.path()).is_none());
    }

    #[test]
    fn restore_keeps_an_image_inline_when_its_file_cannot_be_written() {
        let dir = tempfile::tempdir().unwrap();
        let blocked = dir.path().join("not-a-dir");
        std::fs::write(&blocked, "file in the way").unwrap();
        let raw = legacy_backup(&["QUJD"]);
        assert!(externalize_store_backup(&raw, &blocked).is_none());
    }

    #[test]
    fn restore_leaves_unknown_backups_alone() {
        let dir = tempfile::tempdir().unwrap();
        assert!(externalize_store_backup("not json \\\"images\\\"", dir.path()).is_none());
        assert!(externalize_store_backup(r#"{"settings":"{}"}"#, dir.path()).is_none());
    }

    /// A store_backup*.json picked in "Import chats" comes out as the plain
    /// list of its chats (3.0.10, Restore chats from backup).
    #[test]
    fn a_store_backup_imports_as_its_chat_list() {
        let dir = tempfile::tempdir().unwrap();
        let chat = serde_json::json!({ "state": { "conversations": [{ "id": "a", "title": "a", "messages": [] }] } });
        let raw = serde_json::json!({ "__ts": "x", CHAT_KEY: chat.to_string(), "chat-settings": "{}" }).to_string();
        let out: Value = serde_json::from_str(&externalize_import(&raw, dir.path()).unwrap()).unwrap();
        assert_eq!(out, serde_json::json!([{ "id": "a", "title": "a", "messages": [] }]));
        let garbled = serde_json::json!({ CHAT_KEY: "not json" }).to_string();
        assert!(externalize_import(&garbled, dir.path()).is_err());
    }

    #[test]
    fn import_accepts_all_three_shapes() {
        let dir = tempfile::tempdir().unwrap();
        let conv = serde_json::json!({ "id": "c", "title": "t", "messages": [ { "role": "user", "content": "x", "images": [ { "data": "QUJD", "mimeType": "image/png", "name": "a" } ] } ] });
        for shape in [
            serde_json::json!({ "app": "locally-uncensored", "conversations": [conv.clone()] }),
            serde_json::json!([conv.clone()]),
            conv.clone(),
        ] {
            let out = externalize_import(&shape.to_string(), dir.path()).unwrap();
            assert!(!out.contains("\"QUJD\""), "{out}");
            assert!(out.contains(&reference("QUJD")));
            let back: Value = serde_json::from_str(&out).unwrap();
            assert_eq!(back.is_array(), shape.is_array());
        }
        assert_eq!(externalize_import("nope", dir.path()).unwrap_err(), "That file is not valid JSON.");
    }

    #[test]
    fn export_puts_the_images_back_and_counts_missing_ones() {
        let dir = tempfile::tempdir().unwrap();
        write_attachment(dir.path(), &content_id("QUJD"), "QUJD").unwrap();
        let gone = reference("gone");
        let content = serde_json::to_string_pretty(&serde_json::json!({ "conversations": [ { "messages": [ {
            "content": format!("text mentioning {}", reference("QUJD")),
            "images": [ { "data": reference("QUJD") }, { "data": gone } ]
        } ] } ] }))
        .unwrap();
        let mut out = Vec::new();
        let missing = write_export(&content, &mut out, dir.path()).unwrap();
        let out = String::from_utf8(out).unwrap();
        assert_eq!(missing, 1);
        let back: Value = serde_json::from_str(&out).unwrap();
        let message = &back["conversations"][0]["messages"][0];
        assert_eq!(message["images"][0]["data"], "QUJD");
        assert_eq!(message["images"][1]["data"], gone.as_str());
        // A reference inside ordinary text is text, not an image.
        assert!(message["content"].as_str().unwrap().contains(&reference("QUJD")));
    }

    #[test]
    fn cleanup_removes_only_old_files_nothing_refers_to() {
        let store = tempfile::tempdir().unwrap();
        let dir = store.path().join("chat-attachments");
        for d in ["QUJD", "REVG", "R0hJ", "SktM"] {
            write_attachment(&dir, &content_id(d), d).unwrap();
        }
        for d in ["QUJD", "REVG", "R0hJ"] {
            age(&dir.join(content_id(d)));
        }
        // QUJD in the live backup, REVG only in an older generation, R0hJ in
        // nothing and old, SktM in nothing but young.
        let live = serde_json::json!({ CHAT_KEY: format!("{{\"images\":[{{\"data\":\"{}\"}}]}}", reference("QUJD")) });
        std::fs::write(store.path().join("store_backup.json"), live.to_string()).unwrap();
        std::fs::write(store.path().join("store_backup.2.json"), reference("REVG")).unwrap();
        assert_eq!(collect_garbage(store.path(), &dir, GC_MIN_AGE).unwrap(), 1);
        assert!(read_attachment(&dir, &content_id("QUJD")).is_ok());
        assert!(read_attachment(&dir, &content_id("REVG")).is_ok());
        assert!(read_attachment(&dir, &content_id("R0hJ")).is_err());
        assert!(read_attachment(&dir, &content_id("SktM")).is_ok());
    }

    #[test]
    fn cleanup_never_runs_against_a_backup_without_the_chats() {
        let store = tempfile::tempdir().unwrap();
        let dir = store.path().join("chat-attachments");
        write_attachment(&dir, &content_id("QUJD"), "QUJD").unwrap();
        age(&dir.join(content_id("QUJD")));
        assert!(collect_garbage(store.path(), &dir, GC_MIN_AGE).is_err(), "no live backup at all");
        std::fs::write(store.path().join("store_backup.json"), r#"{"settings":"{}"}"#).unwrap();
        assert_eq!(collect_garbage(store.path(), &dir, GC_MIN_AGE).unwrap(), 0);
        assert!(read_attachment(&dir, &content_id("QUJD")).is_ok());
    }

    #[test]
    fn references_cut_by_the_read_chunk_edge_are_still_found() {
        let store = tempfile::tempdir().unwrap();
        let r = reference("QUJD");
        for pad in [(1 << 20) - 10, (1 << 20) - PREFIX.len() - 3, (1 << 20) + 1] {
            let path = store.path().join(format!("f{pad}"));
            std::fs::write(&path, format!("{}{r}\"", "x".repeat(pad))).unwrap();
            let ids = referenced_ids(&[path]).unwrap();
            assert!(ids.contains(&content_id("QUJD")), "pad {pad}");
        }
    }
}
