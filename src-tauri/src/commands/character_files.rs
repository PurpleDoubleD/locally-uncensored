//! Trained characters as files on this machine.
//!
//! Two jobs live here:
//!
//! 1. A character trained in LU Cloud on the Z-Image base is brought onto the
//!    local shelf (`import_cloud_character`). The local shelf recognizes a
//!    character by the trainer's own file name, `char_<trigger>_zimage
//!    .safetensors` in the LoRA folder of this host (ComfyUI's `models/loras`,
//!    the Mac's own folder), so the file is saved under exactly that name. An existing file of that name is never overwritten
//!    and never renamed around: the trigger word IS the name part, and a
//!    suffix would make the shelf show a trigger word the weights do not
//!    know. The header of the file is read before it goes in, and its key
//!    layout is compared with what the local trainer writes.
//!
//! 2. The photos a local character was trained on are handed out again as
//!    small reference images (`character_photos`). The training set stays in
//!    `<trainer root>/train/<trigger>/img` after a run. A marker next to it,
//!    written when the run finished, names the LoRA file it produced, so the
//!    photos of an older or a failed run are never handed out for another
//!    file of the same name.

// The download through cloud_file is desktop-only (it saves through a file
// dialog crate a phone does not have); so are the two functions using it.
#[cfg(desktop)]
use crate::commands::cloud_file::{fetch_to_file, token_may_go_to, Outcome, PROGRESS_EVENT};
#[cfg(desktop)]
use crate::commands::proxy::validate_public_url;
#[cfg(desktop)]
use crate::os_error;
use crate::state::AppState;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
#[cfg(desktop)]
use tauri::Emitter;

/// The marker file in a training set folder.
const MARKER: &str = "character.json";

/// The most reference photos one call hands out (`MAX_CHARACTER_PHOTOS` in
/// src/lib/edit-references.ts). Qwen-Image 2.1 reads up to nine besides the
/// source, but three photos of one face are enough to hold it, and each more
/// image makes every image of the edit smaller.
const MAX_PHOTOS: usize = 3;

/// The long edge of a handed out photo. The edit models scale their
/// references down to about a megapixel anyway.
const PHOTO_EDGE: u32 = 1024;

/// A photo the image crate of this build cannot open (WebP) is handed out as
/// it is, up to this size.
const RAW_PHOTO_CAP: u64 = 8 * 1024 * 1024;

const PHOTO_EXTS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];

/// The trigger word out of a local character's file name. The same pattern
/// as `parseLocalCharacterLora` in src/api/trainer.ts, on the base name.
pub(crate) fn trigger_of(file: &str) -> Option<String> {
    let base = file.trim().rsplit(['/', '\\']).next()?;
    let lower = base.to_ascii_lowercase();
    if !lower.starts_with("char_") || !lower.ends_with("_zimage.safetensors") {
        return None;
    }
    let inner = &base["char_".len()..base.len() - "_zimage.safetensors".len()];
    (!inner.is_empty()).then(|| inner.to_string())
}

/// The file name a cloud character gets on the local shelf. The trigger word
/// is cleaned the way the local trainer cleans it, so a cloud and a local
/// character of the same trigger word land on the same name. Falls back to
/// the character's name when the trigger word has nothing left.
pub(crate) fn local_character_file(trigger: &str, name: &str) -> Option<String> {
    let clean = crate::commands::trainer::sanitize_component(trigger);
    let clean = if clean.is_empty() { crate::commands::trainer::sanitize_component(name) } else { clean };
    (!clean.is_empty()).then(|| format!("char_{clean}_zimage.safetensors"))
}

// ── the key layout ──────────────────────────────────────────────────────────

/// How the tensor names of a LoRA compare with the local trainer's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum KeyFormat {
    /// The layout the local trainer writes: musubi's `convert_lora.py
    /// --target other`, `diffusion_model.<module>.lora_A/lora_B.weight`.
    Same,
    /// Another layout ComfyUI's LoRA loader also maps (Kohya `lora_unet_`,
    /// diffusers `transformer.`, PEFT `base_model.model.`, or
    /// `diffusion_model.` with `lora_down/lora_up`).
    Known,
    /// Neither. ComfyUI may skip the weights without an error.
    Unknown,
}

/// What the key layout of a LoRA is, from its tensor names.
pub(crate) fn key_format<'a>(names: impl IntoIterator<Item = &'a str>) -> KeyFormat {
    let (mut total, mut same, mut known, mut layers) = (0usize, 0usize, 0usize, false);
    for name in names {
        let parts: Vec<&str> = name.split('.').collect();
        let peft = parts.iter().any(|p| *p == "lora_A" || *p == "lora_B");
        let kohya = parts.iter().any(|p| *p == "lora_down" || *p == "lora_up");
        if !peft && !kohya {
            // alpha, dora scales and other side tensors say nothing on their own.
            continue;
        }
        total += 1;
        // Z-Image is a stack of `layers.N`. Flux and Qwen LoRAs name
        // `double_blocks` or `transformer_blocks` instead.
        if name.contains("layers.") || name.contains("layers_") {
            layers = true;
        }
        if name.starts_with("diffusion_model.") && peft {
            same += 1;
        } else if name.starts_with("diffusion_model.")
            || name.starts_with("lora_unet_")
            || name.starts_with("transformer.")
            || name.starts_with("base_model.model.")
        {
            known += 1;
        }
    }
    if total == 0 || !layers {
        KeyFormat::Unknown
    } else if same == total {
        KeyFormat::Same
    } else if same + known == total {
        KeyFormat::Known
    } else {
        KeyFormat::Unknown
    }
}

/// The tensor names of a safetensors file, or None when its header cannot be
/// read (not a safetensors file, or cut short).
pub(crate) fn tensor_names(path: &Path) -> Option<Vec<String>> {
    let (_, buf) = crate::commands::mlx_loras::header_json(path)?;
    let header: std::collections::HashMap<String, serde::de::IgnoredAny> = serde_json::from_slice(&buf).ok()?;
    Some(header.into_keys().filter(|k| k != "__metadata__").collect())
}

// ── the marker of a training set ────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct Marker {
    /// The base name of the LoRA this set produced. Empty when the photos
    /// belong to no LoRA any more.
    lora: String,
    bytes: u64,
    modified: u64,
}

fn stamp(path: &Path) -> Option<(u64, u64)> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some((meta.len(), modified))
}

/// Called by the trainer when a run has written its LoRA: the set's photos
/// now belong to that file, by name, size and time.
pub(crate) fn write_training_marker(set_dir: &Path, lora: &Path) {
    let Some((bytes, modified)) = stamp(lora) else { return };
    let marker = Marker {
        lora: lora.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        bytes,
        modified,
    };
    if let Ok(text) = serde_json::to_string(&marker) {
        let _ = fs::write(set_dir.join(MARKER), text);
    }
}

/// A file that came from elsewhere took the name: the set's photos belong to
/// no LoRA from here on. Only a set folder that is already there is marked.
fn disown_training_set(set_dir: &Path) {
    if set_dir.is_dir() {
        let marker = Marker { lora: String::new(), bytes: 0, modified: 0 };
        if let Ok(text) = serde_json::to_string(&marker) {
            let _ = fs::write(set_dir.join(MARKER), text);
        }
    }
}

/// Do the photos in `set_dir` belong to the LoRA at `lora` (None when the
/// file is not found in the main loras folder)?
///
/// With a marker: its name must match, and where the LoRA file is found, its
/// size and time too. Without one (a set trained before the marker existed):
/// only when the trainer's own raw output of that name is still in the set,
/// which proves the run finished on this machine.
fn photos_belong(set_dir: &Path, base: &str, lora: Option<&Path>) -> bool {
    if let Ok(text) = fs::read_to_string(set_dir.join(MARKER)) {
        let Ok(marker) = serde_json::from_str::<Marker>(&text) else { return false };
        if !marker.lora.eq_ignore_ascii_case(base) {
            return false;
        }
        return match lora.and_then(stamp) {
            Some((bytes, modified)) => bytes == marker.bytes && modified == marker.modified,
            None => true,
        };
    }
    set_dir.join("out").join(base).is_file()
}

/// The photo files of a set, the best first: the largest pixel count, read
/// from the file header only, then the name. A file whose size cannot be read
/// goes last.
fn ranked_photos(img_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(img_dir) else { return Vec::new() };
    let mut photos: Vec<(u64, PathBuf)> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|x| x.to_str())
                    .is_some_and(|x| PHOTO_EXTS.contains(&x.to_ascii_lowercase().as_str()))
        })
        .map(|p| {
            let area = image::image_dimensions(&p).map(|(w, h)| w as u64 * h as u64).unwrap_or(0);
            (area, p)
        })
        .collect();
    photos.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    photos.into_iter().map(|(_, p)| p).collect()
}

#[derive(Serialize)]
struct Photo {
    name: String,
    mime: String,
    base64: String,
}

/// One photo, scaled down to `PHOTO_EDGE` as a JPEG. A photo this build
/// cannot decode goes out as it is when it is small enough.
fn small_copy(path: &Path) -> Option<Photo> {
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "photo".into());
    let engine = base64::engine::general_purpose::STANDARD;
    match image::open(path) {
        Ok(img) => {
            let img = if img.width().max(img.height()) > PHOTO_EDGE {
                img.resize(PHOTO_EDGE, PHOTO_EDGE, image::imageops::FilterType::Triangle)
            } else {
                img
            };
            let mut out = std::io::Cursor::new(Vec::new());
            let rgb = image::DynamicImage::ImageRgb8(img.to_rgb8());
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90);
            rgb.write_with_encoder(encoder).ok()?;
            Some(Photo { name: format!("{stem}.jpg"), mime: "image/jpeg".into(), base64: engine.encode(out.into_inner()) })
        }
        Err(_) => {
            if fs::metadata(path).ok()?.len() > RAW_PHOTO_CAP {
                return None;
            }
            let ext = path.extension()?.to_str()?.to_ascii_lowercase();
            let mime = match ext.as_str() {
                "webp" => "image/webp",
                "png" => "image/png",
                _ => "image/jpeg",
            };
            let bytes = fs::read(path).ok()?;
            Some(Photo { name: path.file_name()?.to_string_lossy().to_string(), mime: mime.into(), base64: engine.encode(bytes) })
        }
    }
}

/// The photos of a local character, for a train root and a loras folder.
/// `count_only` leaves the bytes out.
fn photos_for(train_root: &Path, loras_dir: Option<&Path>, file: &str, max: usize, count_only: bool) -> serde_json::Value {
    let none = serde_json::json!({ "count": 0, "photos": [] });
    let Some(trigger) = trigger_of(file) else { return none };
    let set = crate::commands::trainer::sanitize_component(&trigger);
    if set.is_empty() {
        return none;
    }
    let base = file.trim().rsplit(['/', '\\']).next().unwrap_or_default().to_string();
    let set_dir = train_root.join(&set);
    let lora = loras_dir.map(|d| d.join(&base)).filter(|p| p.is_file());
    if !photos_belong(&set_dir, &base, lora.as_deref()) {
        return none;
    }
    let ranked = ranked_photos(&set_dir.join("img"));
    let take = max.clamp(1, MAX_PHOTOS);
    if count_only {
        return serde_json::json!({ "count": ranked.len().min(take), "photos": [] });
    }
    let photos: Vec<Photo> = ranked.iter().filter_map(|p| small_copy(p)).take(take).collect();
    serde_json::json!({ "count": photos.len(), "photos": photos })
}

/// The training photos of the local character `file` (a name as the loras
/// list shows it), the best `max` of them as small copies. Answers
/// `{count, photos: [{name, mime, base64}]}`, with no photos when the set is
/// gone or belongs to another file.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn character_photos(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    file: String,
    max: Option<u32>,
    countOnly: Option<bool>,
) -> Result<serde_json::Value, String> {
    let train_root = crate::commands::trainer::trainer_root(&app).join("train");
    // GH #183: the configured LoRA folder, or the instance one for a
    // character trained before that folder was honoured.
    let base = file.trim().rsplit(['/', '\\']).next().unwrap_or_default().to_string();
    let loras_dir = crate::commands::trainer::active_comfy_dir(state.inner()).map(|c| {
        let configured = crate::commands::trainer::comfy_loras_dir(&c);
        let instance = c.join("models").join("loras");
        if !configured.join(&base).is_file() && instance.join(&base).is_file() { instance } else { configured }
    });
    let max = max.unwrap_or(MAX_PHOTOS as u32) as usize;
    let count_only = countOnly.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || photos_for(&train_root, loras_dir.as_deref(), &file, max, count_only))
        .await
        .map_err(|e| format!("The photos could not be read: {e}"))
}

// ── the import ──────────────────────────────────────────────────────────────

/// Downloads to the staging file, reads the header, then puts the file in
/// place. Answers the outcome and the key layout. A file whose header cannot
/// be read is our own broken download and is removed again.
#[cfg(desktop)]
async fn import_into(
    url: &str,
    token: &str,
    dest: &Path,
    storage_ok: fn(&str) -> Result<(), String>,
    cancel: &tokio_util::sync::CancellationToken,
    on_progress: impl FnMut(u64, u64),
) -> Result<(Outcome, Option<KeyFormat>), String> {
    let mut staging_name = dest.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    staging_name.push(".download");
    let staging = dest.with_file_name(staging_name);
    let outcome = fetch_to_file(url, token, &staging, storage_ok, cancel, on_progress).await?;
    let Outcome::Saved { .. } = outcome else { return Ok((outcome, None)) };
    let Some(names) = tensor_names(&staging) else {
        let _ = fs::remove_file(&staging);
        return Err("The downloaded file is not a LoRA LU can read. Nothing was added.".to_string());
    };
    let format = key_format(names.iter().map(String::as_str));
    // A file of that name may have come in meanwhile: it stays.
    if dest.exists() {
        let _ = fs::remove_file(&staging);
        return Err(format!("{} is already in the LoRA folder. Nothing was replaced.", dest.display()));
    }
    if let Err(e) = fs::rename(&staging, dest) {
        let _ = fs::remove_file(&staging);
        return Err(format!("The file could not be saved: {}", os_error::english(&e)));
    }
    Ok((outcome, Some(format)))
}

/// Where this host's image engine reads LoRAs: the Mac's own folder (it has
/// no ComfyUI, `mlx_loras.rs`), ComfyUI's `models/loras` everywhere else.
fn local_loras_dir(state: &AppState) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        return Some(crate::commands::mlx_loras::loras_root());
    }
    crate::commands::trainer::active_comfy_dir(state).map(|c| crate::commands::trainer::comfy_loras_dir(&c))
}

/// Saves a cloud character as a local one: `char_<trigger>_zimage
/// .safetensors` in the LoRA folder of this host (`local_loras_dir`). The
/// window only asks for Z-Image characters, the only family the local shelf
/// runs.
///
/// Answers `{status: "saved", file, path, bytes, keyFormat}`,
/// `{status: "exists", file}` when a character of that name is there already,
/// `{status: "refused", code}`, `{status: "stopped"}` after
/// `cancel_cloud_file`, or `{status: "no_comfy"}` when there is no LoRA
/// folder to put it in (no ComfyUI found).
#[cfg(desktop)]
#[tauri::command]
#[allow(non_snake_case, clippy::too_many_arguments)]
pub async fn import_cloud_character(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    url: String,
    authToken: String,
    triggerWord: String,
    name: String,
) -> Result<serde_json::Value, String> {
    token_may_go_to(&url)?;
    let Some(file) = local_character_file(&triggerWord, &name) else {
        return Err("This character has no trigger word LU can use as a file name.".to_string());
    };
    let Some(loras) = local_loras_dir(state.inner()) else {
        return Ok(serde_json::json!({ "status": "no_comfy" }));
    };
    let dest = loras.join(&file);
    if dest.exists() {
        return Ok(serde_json::json!({ "status": "exists", "file": file }));
    }
    fs::create_dir_all(&loras).map_err(|e| format!("The LoRA folder could not be made: {}", os_error::english(&e)))?;
    let (cancel, _registered) = state.cloud_file_tokens.register(id.clone());
    let _ = app.emit(PROGRESS_EVENT, serde_json::json!({ "id": id, "received": 0, "total": 0 }));
    let (outcome, format) = import_into(&url, &authToken, &dest, validate_public_url, &cancel, |received, total| {
        let _ = app.emit(PROGRESS_EVENT, serde_json::json!({ "id": id, "received": received, "total": total }));
    })
    .await?;
    Ok(match outcome {
        Outcome::Saved { bytes } => {
            // Training photos of an earlier local character of this name are
            // not this character's.
            if let Some(trigger) = trigger_of(&file) {
                let train = crate::commands::trainer::trainer_root(&app).join("train");
                disown_training_set(&train.join(crate::commands::trainer::sanitize_component(&trigger)));
            }
            serde_json::json!({
                "status": "saved",
                "file": file,
                "path": dest.to_string_lossy(),
                "bytes": bytes,
                "keyFormat": format.unwrap_or(KeyFormat::Unknown),
            })
        }
        Outcome::Refused { status } => serde_json::json!({ "status": "refused", "code": status }),
        Outcome::Cancelled => serde_json::json!({ "status": "stopped" }),
    })
}

// ── a LoRA file the user brings ─────────────────────────────────────────────
//
// 3.1.0, "New character": a `.safetensors` dropped on the page becomes a
// character of this machine. The window cannot hand over a path (the WebView
// gives a dropped file as bytes), so the file comes in pieces and is put
// together next to its place. It only gets its name, `char_<name>_zimage
// .safetensors`, once its header reads as a LoRA.

/// The most one piece carries, decoded.
const MAX_PIECE_BYTES: usize = 16 * 1024 * 1024;
/// The largest LoRA file taken at all.
const MAX_LORA_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// What a piece left behind.
#[derive(Debug, PartialEq)]
pub(crate) enum Piece {
    /// Written; `received` bytes are there now.
    More { received: u64 },
    /// The last piece: the file stands under its name.
    Saved { file: String, path: PathBuf, bytes: u64, format: KeyFormat },
    /// A character of that name is there already. Nothing was replaced.
    Exists { file: String },
}

fn staging_of(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".upload");
    dest.with_file_name(name)
}

/// Adds one piece of a brought LoRA file. `offset` is where the piece
/// starts: 0 starts over, anything else must be exactly what is there.
pub(crate) fn take_piece(loras: &Path, name: &str, offset: u64, bytes: &[u8], last: bool) -> Result<Piece, String> {
    use std::io::Write;
    let Some(file) = local_character_file(name, name) else {
        return Err("Give the character a name with letters or digits.".to_string());
    };
    if bytes.len() > MAX_PIECE_BYTES {
        return Err("This piece of the file is too large.".to_string());
    }
    let dest = loras.join(&file);
    let staging = staging_of(&dest);
    if dest.exists() {
        let _ = fs::remove_file(&staging);
        return Ok(Piece::Exists { file });
    }
    fs::create_dir_all(loras).map_err(|e| format!("The LoRA folder could not be made: {}", crate::os_error::english(&e)))?;
    let have = if offset == 0 { 0 } else { fs::metadata(&staging).map(|m| m.len()).unwrap_or(0) };
    if have != offset {
        let _ = fs::remove_file(&staging);
        return Err("The file arrived out of order. Nothing was added, drop it again.".to_string());
    }
    if offset.saturating_add(bytes.len() as u64) > MAX_LORA_BYTES {
        let _ = fs::remove_file(&staging);
        return Err("This file is larger than a LoRA gets (4 GB). Nothing was added.".to_string());
    }
    let mut out = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(offset != 0)
        .truncate(offset == 0)
        .open(&staging)
        .map_err(|e| format!("The file could not be written: {}", crate::os_error::english(&e)))?;
    if let Err(e) = out.write_all(bytes).and_then(|()| out.flush()) {
        drop(out);
        let _ = fs::remove_file(&staging);
        return Err(format!("The file could not be written: {}", crate::os_error::english(&e)));
    }
    drop(out);
    let received = offset + bytes.len() as u64;
    if !last {
        return Ok(Piece::More { received });
    }
    let Some(names) = tensor_names(&staging) else {
        let _ = fs::remove_file(&staging);
        return Err("This file is not a LoRA LU can read. Nothing was added.".to_string());
    };
    let format = key_format(names.iter().map(String::as_str));
    if dest.exists() {
        let _ = fs::remove_file(&staging);
        return Ok(Piece::Exists { file });
    }
    if let Err(e) = fs::rename(&staging, &dest) {
        let _ = fs::remove_file(&staging);
        return Err(format!("The file could not be saved: {}", crate::os_error::english(&e)));
    }
    Ok(Piece::Saved { file, path: dest, bytes: received, format })
}

/// `character_lora_folder`: where a character file lives on this machine,
/// `{status: "ok", path}`, or `{status: "no_comfy"}` when there is no LoRA
/// folder (no ComfyUI found). Desktop only, like the page that asks: a
/// phone has no LoRA folder.
#[cfg(desktop)]
#[tauri::command]
pub fn character_lora_folder(state: tauri::State<'_, AppState>) -> serde_json::Value {
    match local_loras_dir(state.inner()) {
        Some(dir) => serde_json::json!({ "status": "ok", "path": dir.to_string_lossy() }),
        None => serde_json::json!({ "status": "no_comfy" }),
    }
}

/// `character_lora_folder_open`: that folder in the file manager. It is made
/// first, so a machine without a LoRA yet opens an empty folder.
#[cfg(desktop)]
#[tauri::command]
pub fn character_lora_folder_open(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let Some(dir) = local_loras_dir(state.inner()) else {
        return Ok(serde_json::json!({ "status": "no_comfy" }));
    };
    fs::create_dir_all(&dir).map_err(|e| format!("The LoRA folder could not be made: {}", os_error::english(&e)))?;
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = crate::process_util::hidden_command("open");
        c.arg(&dir);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = crate::process_util::hidden_command("explorer");
        c.arg(&dir);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = crate::process_util::foreign_system_command("xdg-open");
        c.arg(&dir);
        c
    };
    crate::process_util::suppress_window(&mut cmd);
    // explorer.exe answers 1 even when it worked, so only a failed spawn counts.
    cmd.spawn().map_err(|e| format!("Could not open the folder: {}", os_error::english(&e)))?;
    Ok(serde_json::json!({ "status": "ok", "path": dir.to_string_lossy() }))
}

/// `character_lora_import`: one piece of a LoRA file the user dropped on
/// "New character" (`take_piece`). Answers `{status: "more", received}`,
/// `{status: "saved", file, path, bytes, keyFormat}`, `{status: "exists",
/// file}` or `{status: "no_comfy"}`.
#[cfg(desktop)]
#[tauri::command]
#[allow(non_snake_case)]
pub async fn character_lora_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
    offset: u64,
    dataB64: String,
    last: bool,
) -> Result<serde_json::Value, String> {
    let Some(loras) = local_loras_dir(state.inner()) else {
        return Ok(serde_json::json!({ "status": "no_comfy" }));
    };
    let train = crate::commands::trainer::trainer_root(&app).join("train");
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(dataB64.as_bytes())
            .map_err(|_| "The file did not arrive whole. Nothing was added, drop it again.".to_string())?;
        Ok(match take_piece(&loras, &name, offset, &bytes, last)? {
            Piece::More { received } => serde_json::json!({ "status": "more", "received": received }),
            Piece::Exists { file } => serde_json::json!({ "status": "exists", "file": file }),
            Piece::Saved { file, path, bytes, format } => {
                // Training photos of an earlier character of this name are
                // not this file's.
                if let Some(trigger) = trigger_of(&file) {
                    disown_training_set(&train.join(crate::commands::trainer::sanitize_component(&trigger)));
                }
                serde_json::json!({ "status": "saved", "file": file, "path": path.to_string_lossy(), "bytes": bytes, "keyFormat": format })
            }
        })
    })
    .await
    .map_err(|e| format!("The file could not be saved: {e}"))?
}

/// `character_lora_import_cancel`: the pieces of an import that was given up.
#[cfg(desktop)]
#[tauri::command]
pub fn character_lora_import_cancel(state: tauri::State<'_, AppState>, name: String) {
    let (Some(loras), Some(file)) = (local_loras_dir(state.inner()), local_character_file(&name, &name)) else { return };
    let _ = fs::remove_file(staging_of(&loras.join(file)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::os_paths::test_dir;

    #[test]
    fn the_trigger_comes_out_of_the_file_name_like_the_shelf_reads_it() {
        assert_eq!(trigger_of("char_anna_zimage.safetensors").as_deref(), Some("anna"));
        assert_eq!(trigger_of("chars/char_anna_b_zimage.safetensors").as_deref(), Some("anna_b"));
        assert_eq!(trigger_of("sub\\char_x_zimage.safetensors").as_deref(), Some("x"));
        assert_eq!(trigger_of("anna.safetensors"), None);
        assert_eq!(trigger_of("char__zimage.safetensors"), None);
    }

    #[test]
    fn a_cloud_trigger_is_cleaned_like_the_trainer_cleans_it() {
        assert_eq!(local_character_file("davechar", "Dave").as_deref(), Some("char_davechar_zimage.safetensors"));
        assert_eq!(local_character_file("Dave Char!", "x").as_deref(), Some("char_Dave_Char_zimage.safetensors"));
        assert_eq!(local_character_file("../../evil", "x").as_deref(), Some("char_evil_zimage.safetensors"));
        // Nothing left of the trigger word: the name stands in.
        assert_eq!(local_character_file("***", "Mia").as_deref(), Some("char_Mia_zimage.safetensors"));
        assert_eq!(local_character_file("***", "€€"), None);
        let made = local_character_file("Dave Char!", "x").unwrap();
        assert_eq!(trigger_of(&made).as_deref(), Some("Dave_Char"));
    }

    #[test]
    fn the_layout_of_the_local_trainer_is_recognized() {
        let local = [
            "diffusion_model.layers.0.attention.to_q.lora_A.weight",
            "diffusion_model.layers.0.attention.to_q.lora_B.weight",
        ];
        assert_eq!(key_format(local), KeyFormat::Same);
        let kohya = [
            "lora_unet_layers_0_attention_to_q.lora_down.weight",
            "lora_unet_layers_0_attention_to_q.lora_up.weight",
            "lora_unet_layers_0_attention_to_q.alpha",
        ];
        assert_eq!(key_format(kohya), KeyFormat::Known);
        let diffusers = ["transformer.layers.0.attention.to_q.lora_A.weight", "transformer.layers.0.attention.to_q.lora_B.weight"];
        assert_eq!(key_format(diffusers), KeyFormat::Known);
    }

    #[test]
    fn a_layout_for_another_model_or_none_at_all_is_unknown() {
        let flux = ["transformer.single_transformer_blocks.0.attn.to_q.lora_A.weight"];
        assert_eq!(key_format(flux), KeyFormat::Unknown);
        let lokr = ["diffusion_model.layers.0.attention.to_q.lokr_w1"];
        assert_eq!(key_format(lokr), KeyFormat::Unknown);
        let strange = ["model.layers.0.q.lora_A.weight"];
        assert_eq!(key_format(strange), KeyFormat::Unknown);
        assert_eq!(key_format([]), KeyFormat::Unknown);
    }

    fn safetensors(path: &Path, names: &[&str]) {
        let mut header = serde_json::Map::new();
        for (i, n) in names.iter().enumerate() {
            header.insert(
                (*n).to_string(),
                serde_json::json!({ "dtype": "F16", "shape": [1], "data_offsets": [i * 2, i * 2 + 2] }),
            );
        }
        header.insert("__metadata__".into(), serde_json::json!({ "ss_note": "test" }));
        let json = serde_json::to_vec(&header).unwrap();
        let mut bytes = (json.len() as u64).to_le_bytes().to_vec();
        bytes.extend_from_slice(&json);
        bytes.extend(vec![0u8; names.len() * 2]);
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn the_names_are_read_from_a_real_header() {
        let dir = test_dir("character-header");
        let path = dir.join("char_a_zimage.safetensors");
        safetensors(&path, &["diffusion_model.layers.1.attention.to_k.lora_A.weight"]);
        let names = tensor_names(&path).unwrap();
        assert_eq!(names, vec!["diffusion_model.layers.1.attention.to_k.lora_A.weight".to_string()]);
        fs::write(dir.join("not.safetensors"), b"<html>expired</html>").unwrap();
        assert!(tensor_names(&dir.join("not.safetensors")).is_none());
    }

    fn lora_bytes(names: &[&str]) -> Vec<u8> {
        let dir = test_dir("character-lora-bytes");
        let path = dir.join("x.safetensors");
        safetensors(&path, names);
        fs::read(path).unwrap()
    }

    #[test]
    fn a_brought_lora_comes_in_pieces_and_gets_its_name_at_the_end() {
        let dir = test_dir("character-lora-pieces");
        let loras = dir.join("loras");
        let bytes = lora_bytes(&["diffusion_model.layers.0.attention.to_q.lora_A.weight"]);
        let (a, b) = bytes.split_at(bytes.len() / 2);
        assert_eq!(take_piece(&loras, "Mira", 0, a, false).unwrap(), Piece::More { received: a.len() as u64 });
        assert!(!loras.join("char_Mira_zimage.safetensors").exists(), "no name before the header was read");
        let done = take_piece(&loras, "Mira", a.len() as u64, b, true).unwrap();
        let dest = loras.join("char_Mira_zimage.safetensors");
        assert_eq!(done, Piece::Saved { file: "char_Mira_zimage.safetensors".into(), path: dest.clone(), bytes: bytes.len() as u64, format: KeyFormat::Same });
        assert_eq!(fs::read(&dest).unwrap(), bytes);
        assert!(!staging_of(&dest).exists());
    }

    #[test]
    fn a_piece_out_of_order_or_a_file_that_is_no_lora_adds_nothing() {
        let dir = test_dir("character-lora-refused");
        let loras = dir.join("loras");
        let dest = loras.join("char_a_zimage.safetensors");
        assert!(take_piece(&loras, "a", 0, b"abc", false).is_ok());
        assert!(take_piece(&loras, "a", 99, b"def", false).unwrap_err().contains("out of order"));
        assert!(!staging_of(&dest).exists());
        let err = take_piece(&loras, "a", 0, b"<html>not a lora</html>", true).unwrap_err();
        assert!(err.contains("not a LoRA"), "{err}");
        assert!(!dest.exists() && !staging_of(&dest).exists());
        assert!(take_piece(&loras, "€€", 0, b"x", true).unwrap_err().contains("name"));
    }

    #[test]
    fn a_character_of_that_name_is_never_replaced() {
        let dir = test_dir("character-lora-exists");
        let loras = dir.join("loras");
        fs::create_dir_all(&loras).unwrap();
        fs::write(loras.join("char_a_zimage.safetensors"), b"mine").unwrap();
        let bytes = lora_bytes(&["diffusion_model.layers.0.attention.to_q.lora_A.weight"]);
        assert_eq!(take_piece(&loras, "a", 0, &bytes, true).unwrap(), Piece::Exists { file: "char_a_zimage.safetensors".into() });
        assert_eq!(fs::read(loras.join("char_a_zimage.safetensors")).unwrap(), b"mine");
    }

    #[test]
    fn a_lora_for_another_model_is_taken_and_named_as_unknown() {
        let dir = test_dir("character-lora-other");
        let loras = dir.join("loras");
        let bytes = lora_bytes(&["transformer.single_transformer_blocks.0.attn.to_q.lora_A.weight"]);
        let Piece::Saved { format, .. } = take_piece(&loras, "b", 0, &bytes, true).unwrap() else { panic!("not saved") };
        assert_eq!(format, KeyFormat::Unknown);
    }

    fn photo(path: &Path, w: u32, h: u32) {
        image::RgbImage::from_pixel(w, h, image::Rgb([200, 100, 50])).save(path).unwrap();
    }

    /// A finished local run: photos, raw output, the converted LoRA, the marker.
    fn trained(root: &Path, trigger: &str) -> (PathBuf, PathBuf) {
        let set = root.join("train").join(trigger);
        let img = set.join("img");
        fs::create_dir_all(&img).unwrap();
        fs::create_dir_all(set.join("out")).unwrap();
        photo(&img.join("small.png"), 64, 64);
        photo(&img.join("large.png"), 2048, 1536);
        photo(&img.join("mid.jpg"), 800, 600);
        photo(&img.join("tiny.png"), 16, 16);
        fs::write(img.join("small.txt"), "caption").unwrap();
        let loras = root.join("loras");
        fs::create_dir_all(&loras).unwrap();
        let lora = loras.join(format!("char_{trigger}_zimage.safetensors"));
        safetensors(&lora, &["diffusion_model.layers.0.attention.to_q.lora_A.weight"]);
        (set, lora)
    }

    #[test]
    fn a_marked_set_hands_out_its_best_photos_small() {
        let dir = test_dir("character-photos");
        let (set, lora) = trained(&dir, "anna");
        write_training_marker(&set, &lora);
        let answer = photos_for(&dir.join("train"), Some(&dir.join("loras")), "char_anna_zimage.safetensors", 3, false);
        assert_eq!(answer["count"], 3);
        let photos = answer["photos"].as_array().unwrap();
        let names: Vec<&str> = photos.iter().map(|p| p["name"].as_str().unwrap()).collect();
        // The largest pixel count first.
        assert_eq!(names, vec!["large.jpg", "mid.jpg", "small.jpg"]);
        let first = base64::engine::general_purpose::STANDARD.decode(photos[0]["base64"].as_str().unwrap()).unwrap();
        let img = image::load_from_memory(&first).unwrap();
        assert_eq!((img.width(), img.height()), (1024, 768));
        // Fewer asked for, fewer handed out; counting reads no bytes.
        let two = photos_for(&dir.join("train"), Some(&dir.join("loras")), "char_anna_zimage.safetensors", 2, true);
        assert_eq!(two["count"], 2);
        assert!(two["photos"].as_array().unwrap().is_empty());
    }

    #[test]
    fn photos_of_another_file_of_the_same_name_are_not_handed_out() {
        let dir = test_dir("character-photos-other");
        let (set, lora) = trained(&dir, "anna");
        write_training_marker(&set, &lora);
        // The file is replaced by one of another size: no longer this set's.
        safetensors(&lora, &["diffusion_model.layers.0.a.lora_A.weight", "diffusion_model.layers.0.a.lora_B.weight"]);
        let answer = photos_for(&dir.join("train"), Some(&dir.join("loras")), "char_anna_zimage.safetensors", 3, false);
        assert_eq!(answer["count"], 0);
    }

    #[test]
    fn an_imported_character_disowns_an_old_set_of_its_name() {
        let dir = test_dir("character-photos-import");
        let (set, _) = trained(&dir, "anna");
        // Trained before the marker existed: the raw output proves the run.
        fs::write(set.join("out").join("char_anna_zimage.safetensors"), b"raw").unwrap();
        let train = dir.join("train");
        let loras = dir.join("loras");
        assert_eq!(photos_for(&train, Some(&loras), "char_anna_zimage.safetensors", 3, true)["count"], 3);
        disown_training_set(&set);
        assert_eq!(photos_for(&train, Some(&loras), "char_anna_zimage.safetensors", 3, true)["count"], 0);
    }

    #[test]
    fn a_set_without_marker_or_finished_run_hands_out_nothing() {
        let dir = test_dir("character-photos-unfinished");
        trained(&dir, "anna");
        let answer = photos_for(&dir.join("train"), Some(&dir.join("loras")), "char_anna_zimage.safetensors", 3, true);
        assert_eq!(answer["count"], 0);
        assert_eq!(photos_for(&dir.join("train"), None, "anna.safetensors", 3, true)["count"], 0);
        assert_eq!(photos_for(&dir.join("train"), None, "char_ghost_zimage.safetensors", 3, true)["count"], 0);
    }

    #[test]
    fn disowning_makes_no_folder() {
        let dir = test_dir("character-disown");
        disown_training_set(&dir.join("train").join("nobody"));
        assert!(!dir.join("train").join("nobody").exists());
    }

    // ── the import against a local server ──

    async fn serve_file(body: Vec<u8>) -> String {
        use axum::routing::get;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let router = axum::Router::new().route("/api/loras/one/file", get(move || {
            let body = body.clone();
            async move { body }
        }));
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        format!("http://127.0.0.1:{port}/api/loras/one/file")
    }

    fn any_storage(_: &str) -> Result<(), String> {
        Ok(())
    }

    #[tokio::test]
    async fn an_import_lands_under_the_shelf_name_with_its_key_layout() {
        let dir = test_dir("character-import");
        let src = dir.join("src.safetensors");
        safetensors(&src, &["diffusion_model.layers.0.attention.to_q.lora_A.weight", "diffusion_model.layers.0.attention.to_q.lora_B.weight"]);
        let url = serve_file(fs::read(&src).unwrap()).await;
        let dest = dir.join("char_anna_zimage.safetensors");
        let (outcome, format) = import_into(&url, "t", &dest, any_storage, &Default::default(), |_, _| {}).await.unwrap();
        assert!(matches!(outcome, Outcome::Saved { .. }));
        assert_eq!(format, Some(KeyFormat::Same));
        assert_eq!(fs::read(&dest).unwrap(), fs::read(&src).unwrap());
        assert!(!dir.join("char_anna_zimage.safetensors.download").exists());
    }

    #[tokio::test]
    async fn a_body_that_is_no_lora_is_not_added() {
        let dir = test_dir("character-import-bad");
        let url = serve_file(b"<html>expired</html>".to_vec()).await;
        let dest = dir.join("char_anna_zimage.safetensors");
        let err = import_into(&url, "t", &dest, any_storage, &Default::default(), |_, _| {}).await.unwrap_err();
        assert!(err.contains("not a LoRA"), "{err}");
        assert!(!dest.exists());
        assert!(!dir.join("char_anna_zimage.safetensors.download").exists());
    }

    #[tokio::test]
    async fn a_file_that_came_in_meanwhile_is_not_replaced() {
        let dir = test_dir("character-import-race");
        let src = dir.join("src.safetensors");
        safetensors(&src, &["lora_unet_layers_0_a.lora_down.weight"]);
        let url = serve_file(fs::read(&src).unwrap()).await;
        let dest = dir.join("char_anna_zimage.safetensors");
        fs::write(&dest, b"mine").unwrap();
        let err = import_into(&url, "t", &dest, any_storage, &Default::default(), |_, _| {}).await.unwrap_err();
        assert!(err.contains("Nothing was replaced"), "{err}");
        assert_eq!(fs::read(&dest).unwrap(), b"mine");
    }
}
