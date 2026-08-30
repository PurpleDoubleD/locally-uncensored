use crate::os_error;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use futures_util::StreamExt;
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::state::{AppState, DownloadProgress};

/// Reduce a download filename to a safe basename — no path separators, no
/// drive letter, no `..` — so a crafted `filename` (e.g. "..\\..\\Start
/// Menu\\Programs\\Startup\\x.bat") can't escape the target directory and drop
/// an autostart payload. Falls back to "download" if nothing usable remains.
fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit(|c| c == '/' || c == '\\').next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !matches!(c, '/' | '\\' | ':' | '\0')).collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "download".to_string()
    } else {
        cleaned.to_string()
    }
}

/// Reject a subfolder that tries to escape the base (absolute path, drive
/// letter, or any `..` segment). Returns the subfolder unchanged when safe.
fn safe_subfolder(subfolder: &str) -> Result<(), String> {
    let norm = subfolder.replace('\\', "/");
    let p = std::path::Path::new(&norm);
    // `starts_with('/')` also catches Windows drive-relative roots like `/x`,
    // which `is_absolute()` does NOT treat as absolute.
    if p.is_absolute() || norm.starts_with('/') || norm.contains(':') {
        return Err("Invalid subfolder: absolute paths are not allowed".into());
    }
    if norm.split('/').any(|seg| seg == "..") {
        return Err("Invalid subfolder: path traversal is not allowed".into());
    }
    Ok(())
}

#[cfg(test)]
mod download_security_tests {
    use super::{sanitize_filename, safe_subfolder};

    #[test]
    fn sanitize_strips_traversal_and_separators() {
        assert_eq!(sanitize_filename("model.safetensors"), "model.safetensors");
        assert_eq!(sanitize_filename("..\\..\\Startup\\x.bat"), "x.bat");
        assert_eq!(sanitize_filename("a/b/c/evil.exe"), "evil.exe");
        assert_eq!(sanitize_filename("C:evil.dll"), "Cevil.dll"); // colon stripped
        assert_eq!(sanitize_filename(".."), "download");
        assert_eq!(sanitize_filename(""), "download");
    }

    #[test]
    fn safe_subfolder_rejects_escapes() {
        assert!(safe_subfolder("checkpoints").is_ok());
        assert!(safe_subfolder("custom_nodes/foo").is_ok());
        assert!(safe_subfolder("../../etc").is_err());
        assert!(safe_subfolder("a/../../b").is_err());
        assert!(safe_subfolder("/abs/path").is_err());
        assert!(safe_subfolder("C:/x").is_err());
    }

    #[test]
    fn split_model_ref_handles_nested_and_plain_names() {
        assert_eq!(super::split_model_ref("model.safetensors"), (String::new(), "model.safetensors".into()));
        assert_eq!(super::split_model_ref("wan/model.gguf"), ("wan".into(), "model.gguf".into()));
        assert_eq!(super::split_model_ref("a\\b\\m.pt"), ("a/b".into(), "m.pt".into()));
        // Traversal segments survive the split and then die in safe_subfolder.
        let (dir, _) = super::split_model_ref("../../evil.bin");
        assert!(safe_subfolder(&dir).is_err());
    }
}

/// Split a ComfyUI enum name ("wan/x.safetensors" or plain "x.safetensors")
/// into its relative dir + basename so both halves can go through the same
/// jail checks the downloader uses.
fn split_model_ref(name: &str) -> (String, String) {
    let norm = name.replace('\\', "/");
    match norm.rsplit_once('/') {
        Some((dir, base)) => (dir.to_string(), base.to_string()),
        None => (String::new(), norm),
    }
}

/// The model subdirs LU downloads into / ComfyUI enumerates from. Delete
/// searches exactly these — never custom_nodes, never arbitrary paths.
/// embeddings and style_models joined on 2026-08-30, with the five folders the
/// R5 re-measure found missing from the inventory. A file the Installed list
/// names has to be deletable from that same list, or the list is a wall.
const MODEL_SUBDIRS: &[&str] = &[
    "checkpoints", "diffusion_models", "unet", "vae", "loras",
    "text_encoders", "clip", "clip_vision", "audio_encoders",
    "controlnet", "upscale_models", "embeddings", "style_models",
];

/// Delete one installed model file from the ComfyUI models tree (the Model
/// Hub's trash action — cpl.sardinas7489, Discord 2026-07-19: a 27 GB video
/// model his PC couldn't run had no in-app way back out). The name is the
/// ComfyUI enum entry; we jail-check it and look for the single file match
/// across the known model subdirs.
#[tauri::command]
pub fn delete_comfy_model(filename: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let comfy_path = state
        .comfy_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("ComfyUI path not set. Please set it in settings or install ComfyUI first.")?;
    let (sub, base) = split_model_ref(&filename);
    if !sub.is_empty() {
        safe_subfolder(&sub)?;
    }
    let base = sanitize_filename(&base);
    let models_root = PathBuf::from(&comfy_path).join("models");
    let mut hits: Vec<PathBuf> = Vec::new();
    for d in MODEL_SUBDIRS {
        let cand = if sub.is_empty() {
            models_root.join(d).join(&base)
        } else {
            models_root.join(d).join(&sub).join(&base)
        };
        if cand.is_file() {
            hits.push(cand);
        }
    }
    match hits.len() {
        0 => Err(format!("{} was not found in the ComfyUI models folders", filename)),
        1 => {
            let f = &hits[0];
            let bytes = fs::metadata(f).map(|m| m.len()).unwrap_or(0);
            fs::remove_file(f).map_err(|e| format!("Delete failed: {}", os_error::english(&e)))?;
            // Sweep a stale resume-partial next to it (the timeout/abort case
            // leaves both the file and its .download twin behind).
            let _ = fs::remove_file(f.with_extension("download"));
            println!("[Models] Deleted {} ({} bytes)", f.display(), bytes);
            Ok(serde_json::json!({"status": "deleted", "bytes": bytes}))
        }
        _ => Err(format!(
            "{} exists in more than one models folder — remove it from the ComfyUI folder itself so the right copy goes",
            filename
        )),
    }
}

fn models_dir(comfy_path: &Option<String>, subfolder: &str) -> Result<PathBuf, String> {
    let base = comfy_path.as_ref().ok_or("ComfyUI path not set. Please set it in settings or install ComfyUI first.")?;
    safe_subfolder(subfolder)?;
    // Subfolders starting with "custom_nodes/" are relative to ComfyUI root, not models/
    let dir = if subfolder.starts_with("custom_nodes/") || subfolder.starts_with("custom_nodes\\") {
        PathBuf::from(base).join(subfolder)
    } else {
        PathBuf::from(base).join("models").join(subfolder)
    };
    fs::create_dir_all(&dir).map_err(|e| format!("Create models dir: {}", os_error::english(&e)))?;
    Ok(dir)
}

#[allow(non_snake_case)]
#[tauri::command]
pub async fn download_model(
    url: String,
    subfolder: String,
    filename: String,
    expectedBytes: Option<u64>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let expected_bytes = expectedBytes;
    let comfy_path = {
        let mut p = state.comfy_path.lock().unwrap();
        if p.is_none() {
            if let Some(found) = crate::commands::process::find_comfyui_path() {
                println!("[Download] Auto-discovered ComfyUI at: {}", found);
                *p = Some(found);
            }
        }
        p.clone()
    };

    let dest_dir = models_dir(&comfy_path, &subfolder)?;
    let dest_file = dest_dir.join(sanitize_filename(&filename));

    if dest_file.exists() {
        // If expected_bytes is provided, verify the file is at least 90% of expected size
        // to catch partially downloaded files
        let file_complete = match expected_bytes {
            Some(expected) if expected > 0 => {
                let actual = dest_file.metadata().map(|m| m.len()).unwrap_or(0);
                let threshold = (expected as f64 * 0.9) as u64;
                let is_complete = actual >= threshold;
                if !is_complete {
                    println!("[Download] File {} exists but is incomplete: {} bytes vs {} expected ({}%)",
                        filename, actual, expected, (actual as f64 / expected as f64 * 100.0) as u32);
                }
                is_complete
            }
            _ => true, // No expected size — trust existence (backward compat)
        };

        if file_complete {
            return Ok(serde_json::json!({"status": "exists", "path": dest_file.to_string_lossy()}));
        }
        // File is incomplete — fall through to re-download (resume from partial)
    }

    // Use filename as ID (matches frontend lookup)
    let id = filename.clone();

    // Check for existing partial download (resume support)
    let tmp_path = dest_file.with_extension("download");
    let resume_offset = if tmp_path.exists() {
        tmp_path.metadata().map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    // Claim the id before anything else touches shared state, so a second
    // start for the same file cannot take over the first one's token.
    match claim_download(&mut state.downloads.lock().unwrap(), &id, &filename, &dest_file, resume_offset) {
        Claim::Ok => {}
        Claim::AlreadyRunning => {
            return Ok(serde_json::json!({"status": "already_running", "id": id}));
        }
        Claim::NameConflict(other) => {
            return Ok(serde_json::json!({
                "status": "error",
                "error": format!("Another download is already writing a file called {filename} (to {other}). Wait for it to finish, then start this one again."),
            }));
        }
    }

    // Create cancellation token
    let token = CancellationToken::new();
    {
        let mut tokens = state.download_tokens.lock().unwrap();
        tokens.insert(id.clone(), token.clone());
    }

    let downloads_arc = Arc::clone(&state.downloads);
    let tokens_arc = Arc::clone(&state.download_tokens);
    let id_clone = id.clone();
    let filename_clone = filename.clone();

    tokio::spawn(async move {
        match do_download(&url, &dest_file, &downloads_arc, &id_clone, token, resume_offset).await {
            Ok(_) => {
                if let Ok(mut dl) = downloads_arc.lock() {
                    if let Some(p) = dl.get_mut(&id_clone) {
                        p.status = "complete".to_string();
                    }
                }
                println!("[Download] Complete: {}", filename_clone);
            }
            Err(e) => {
                if e == "paused" {
                    println!("[Download] Paused: {}", filename_clone);
                    // Status already set to "paused" in do_download
                } else if e == "cancelled" {
                    // Clean up temp file
                    let tmp = dest_file.with_extension("download");
                    let _ = std::fs::remove_file(&tmp);
                    if let Ok(mut dl) = downloads_arc.lock() {
                        dl.remove(&id_clone);
                    }
                    println!("[Download] Cancelled: {}", filename_clone);
                } else {
                    if let Ok(mut dl) = downloads_arc.lock() {
                        if let Some(p) = dl.get_mut(&id_clone) {
                            p.status = "error".to_string();
                            p.error = Some(e.clone());
                        }
                    }
                    println!("[Download] Failed: {} - {}", filename_clone, e);
                }
            }
        }
        // Clean up token
        if let Ok(mut tokens) = tokens_arc.lock() {
            tokens.remove(&id_clone);
        }
    });

    Ok(serde_json::json!({"status": "started", "id": id}))
}

/// Outcome of trying to start a transfer under the id `filename`.
#[derive(Debug, PartialEq, Eq)]
pub enum Claim {
    /// Nobody else is on this id — the caller owns it.
    Ok,
    /// The very same file is already in flight. Harmless: the caller can just
    /// follow the existing progress entry.
    AlreadyRunning,
    /// A DIFFERENT file with the same name is in flight. Starting anyway would
    /// point two transfers at one `.download` temp file.
    NameConflict(String),
}

/// Decide whether `id` may start, and register its progress entry, in ONE
/// critical section.
///
/// Two starts for the same id used to overwrite each other: the second
/// clobbered the first's cancel token, so the first became impossible to pause
/// or cancel, and both tokio tasks then wrote the same `.download` file — one
/// truncating it via `File::create` while the other kept appending at its own
/// offset. The result still reached `total` bytes and was reported
/// "complete", so the user got a silently corrupt model.
pub fn claim_download(
    downloads: &mut HashMap<String, DownloadProgress>,
    id: &str,
    filename: &str,
    dest: &Path,
    resume_offset: u64,
) -> Claim {
    let dest_str = dest.to_string_lossy().to_string();
    if let Some(p) = downloads.get(id) {
        if matches!(p.status.as_str(), "connecting" | "downloading" | "pausing") {
            // An older entry predating `dest` carries an empty string; treat it
            // as the same file rather than inventing a conflict.
            return if p.dest.is_empty() || p.dest == dest_str {
                Claim::AlreadyRunning
            } else {
                Claim::NameConflict(p.dest.clone())
            };
        }
    }
    downloads.insert(
        id.to_string(),
        DownloadProgress {
            progress: resume_offset,
            total: 0,
            speed: 0.0,
            filename: filename.to_string(),
            status: "connecting".to_string(),
            error: None,
            dest: dest_str,
        },
    );
    Claim::Ok
}

/// Bytes already on disk that count toward this download. Only a 206 means the
/// server honoured the Range request; a 200 carries the whole body, the partial
/// file is truncated and restarted, and nothing may be counted.
fn resumed_bytes(resume_offset: u64, status: u16) -> u64 {
    if resume_offset > 0 && status == 206 { resume_offset } else { 0 }
}

/// True when the body stopped before Content-Length was reached. `total == 0`
/// means the server declared no length — there is nothing to check against.
fn ended_early(total: u64, downloaded: u64) -> bool {
    total > 0 && downloaded < total
}

/// Headroom left free on the drive, on top of the bytes the download needs.
/// Windows starts failing in ways that have nothing to do with us once the
/// system drive runs dry, so the last gigabyte is never ours to take.
const SPACE_RESERVE: u64 = 1024 * 1024 * 1024;

/// Bytes still needed versus bytes still free, when the drive cannot hold the
/// rest of this download. `None` means it fits, or that there is nothing to
/// compare against: a server that declares no length gives no number to plan
/// with, and a drive we cannot measure must not block the download.
///
/// Without this the transfer simply ran until the drive hit zero. On
/// 2026-08-15 a 16.3 GB video model did exactly that on the test machine:
/// curl died with a write error at 0 bytes free, the half file stayed behind,
/// and the drive was too full for anything else to run. A model set is the one
/// download big enough to fill a disk, so the check belongs here, where every
/// download passes through, not in the caller that happens to know the sizes.
fn space_shortfall(total: u64, already_on_disk: u64, available: Option<u64>) -> Option<(u64, u64)> {
    let available = available?;
    if total == 0 {
        return None;
    }
    let needed = total.saturating_sub(already_on_disk).saturating_add(SPACE_RESERVE);
    if available >= needed { None } else { Some((needed, available)) }
}

/// Free bytes on the drive that holds `dest`. The longest matching mount point
/// wins, so a model folder on a mounted volume is measured against that volume
/// and not against the root it hangs under.
fn available_space_for(dest: &Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .iter()
        .filter(|d| dest.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space())
}

/// Gibibyte, weil Windows und der Finder den freien Platz so anzeigen und der
/// Nutzer die Zahl aus der Meldung genau damit vergleicht. Der Katalog zaehlt
/// aus demselben Grund in derselben Einheit.
fn gib(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
}

async fn do_download(
    url: &str,
    dest: &PathBuf,
    downloads: &Arc<Mutex<HashMap<String, DownloadProgress>>>,
    id: &str,
    token: CancellationToken,
    resume_offset: u64,
) -> Result<(), String> {
    // SSRF guard: model downloads come from public catalogs (HuggingFace,
    // civitai, ollama). Block private/loopback/metadata hosts and re-validate
    // every redirect hop so a crafted catalog/model URL can't pull from an
    // internal service or 169.254.169.254.
    crate::commands::proxy::validate_public_url(url)?;

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/1.5")
        .redirect(crate::commands::proxy::ssrf_safe_redirect_policy(10))
        // A deadline on the whole request punishes people for having a slow
        // line rather than a broken one: the 2 hour cap this replaces killed
        // any download that legitimately took longer, and the catalog offers
        // single files of 40 GB and sets of 155 GB. bob80817-dev, Discord
        // 2026-07-29, after giving up: "all of your downloads have a habit of
        // timing out". What we actually want to catch is a stalled transfer,
        // so the limits are per-connect and per-read. A dead socket now fails
        // in two minutes and resumes from the partial on the next attempt;
        // a slow one is left to finish.
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| os_error::english(&e))?;

    let mut request = client.get(url);

    // Resume support: request only remaining bytes
    if resume_offset > 0 {
        request = request.header("Range", format!("bytes={}-", resume_offset));
        println!("[Download] Resuming from byte {}", resume_offset);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", os_error::english(&e)))?;

    let status = response.status();
    if !status.is_success() && status.as_u16() != 206 {
        return Err(format!("HTTP {}", status));
    }

    let already_on_disk = resumed_bytes(resume_offset, status.as_u16());
    let resumed = already_on_disk > 0;

    // For resumed downloads, total = content_length + offset
    let content_length = response.content_length().unwrap_or(0);
    let total = if resumed {
        content_length + resume_offset
    } else {
        content_length
    };

    // Stop before the first byte if the drive cannot hold the rest. Saying it
    // now costs nothing; finding out at the end costs the whole transfer and
    // leaves the machine with a full disk.
    if let Some((needed, free)) = space_shortfall(total, already_on_disk, available_space_for(dest)) {
        return Err(format!(
            "Not enough free space for {}. It still needs {} and the drive has {} free. Free up some space and start it again, the part already downloaded is kept.",
            dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "this download".to_string()),
            gib(needed),
            gib(free),
        ));
    }

    // Update total size
    if let Ok(mut dl) = downloads.lock() {
        if let Some(p) = dl.get_mut(id) {
            p.total = total;
            p.status = "downloading".to_string();
        }
    }

    let tmp_path = dest.with_extension("download");

    // Open file for writing (append if resuming)
    let mut file = if resumed {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&tmp_path)
            .await
            .map_err(|e| format!("Open file for resume: {}", os_error::english(&e)))?
    } else {
        tokio::fs::File::create(&tmp_path)
            .await
            .map_err(|e| format!("Create file: {}", os_error::english(&e)))?
    };

    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = already_on_disk;
    let start = Instant::now();
    let mut last_update = Instant::now();

    use tokio::io::AsyncWriteExt;

    loop {
        tokio::select! {
            _ = token.cancelled() => {
                file.flush().await.ok();
                drop(file);

                // Check if this is a pause or cancel
                let is_paused = if let Ok(dl) = downloads.lock() {
                    dl.get(id).map(|p| p.status == "pausing").unwrap_or(false)
                } else {
                    false
                };

                if is_paused {
                    if let Ok(mut dl) = downloads.lock() {
                        if let Some(p) = dl.get_mut(id) {
                            p.status = "paused".to_string();
                            p.progress = downloaded;
                        }
                    }
                    return Err("paused".to_string());
                } else {
                    return Err("cancelled".to_string());
                }
            }
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        file.write_all(&bytes).await.map_err(|e| format!("Write: {}", os_error::english(&e)))?;
                        downloaded += bytes.len() as u64;

                        // Update progress every 500ms
                        if last_update.elapsed().as_millis() > 500 {
                            last_update = Instant::now();
                            let elapsed = start.elapsed().as_secs_f64();
                            let speed = if elapsed > 0.0 {
                                (downloaded - already_on_disk) as f64 / elapsed
                            } else {
                                0.0
                            };

                            if let Ok(mut dl) = downloads.lock() {
                                if let Some(p) = dl.get_mut(id) {
                                    p.progress = downloaded;
                                    p.speed = speed;
                                }
                            }
                        }
                    }
                    Some(Err(e)) => {
                        return Err(format!("Stream error: {}", e));
                    }
                    None => {
                        // Stream complete
                        break;
                    }
                }
            }
        }
    }

    file.flush().await.map_err(|e| format!("Flush: {}", os_error::english(&e)))?;
    drop(file);

    // A body can end early without ever erroring — a CDN cutting the connection,
    // a laptop going to sleep, an antivirus dropping the stream. Renaming a short
    // file into place is the worst outcome: the Models page tolerates rough
    // catalog sizes (50%), so the truncated model would read as "Installed" and
    // only blow up much later, when the backend tries to load it. Keep the
    // .download part instead — the next attempt resumes from there.
    if ended_early(total, downloaded) {
        return Err(format!(
            "Download ended early: {} of {} bytes received. Start it again to resume.",
            downloaded, total
        ));
    }

    tokio::fs::rename(&tmp_path, dest)
        .await
        .map_err(|e| format!("Rename: {}", os_error::english(&e)))?;

    // Final progress update
    if let Ok(mut dl) = downloads.lock() {
        if let Some(p) = dl.get_mut(id) {
            p.progress = downloaded;
            p.total = downloaded;
            p.status = "complete".to_string();
        }
    }

    Ok(())
}

#[tauri::command]
pub fn pause_download(id: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // Set status to "pausing" so the download loop knows it's a pause, not cancel
    if let Ok(mut dl) = state.downloads.lock() {
        if let Some(p) = dl.get_mut(&id) {
            if p.status != "downloading" && p.status != "connecting" {
                return Ok(serde_json::json!({"status": "not_active"}));
            }
            p.status = "pausing".to_string();
        }
    }

    // Cancel the token (the download loop checks for "pausing" status to distinguish pause from cancel)
    if let Ok(tokens) = state.download_tokens.lock() {
        if let Some(token) = tokens.get(&id) {
            token.cancel();
        }
    }

    Ok(serde_json::json!({"status": "pausing"}))
}

#[tauri::command]
pub fn cancel_download(id: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // Cancel the token
    if let Ok(tokens) = state.download_tokens.lock() {
        if let Some(token) = tokens.get(&id) {
            token.cancel();
        }
    }

    // If paused or errored (no active token), clean up directly. Errored
    // entries otherwise live in the map forever and resurrect the bundle
    // card's error state on every Models-tab remount after the user hit
    // Clear (the_mr_pickles) — refresh() re-reads this map on mount.
    // Take the recorded destination out with the entry: guessing five
    // subfolders missed every other one (controlnet, upscale_models, clip_vision)
    // and every download_model_to_path target outside the ComfyUI tree, so those
    // partial files were left behind for good.
    let dest = if let Ok(mut dl) = state.downloads.lock() {
        match dl.get(&id) {
            Some(p) if p.status == "paused" || p.status == "error" => {
                let d = p.dest.clone();
                dl.remove(&id);
                Some(d)
            }
            _ => None,
        }
    } else {
        None
    };

    if let Some(dest) = dest {
        if !dest.is_empty() {
            let _ = std::fs::remove_file(PathBuf::from(&dest).with_extension("download"));
        } else if let Ok(comfy_path) = state.comfy_path.lock() {
            // Entry from before `dest` existed — fall back to the old guess.
            if let Some(ref path) = *comfy_path {
                for subfolder in &["diffusion_models", "checkpoints", "vae", "text_encoders", "loras"] {
                    let tmp = PathBuf::from(path).join("models").join(subfolder).join(&id).with_extension("download");
                    let _ = std::fs::remove_file(&tmp);
                }
            }
        }
    }

    Ok(serde_json::json!({"status": "cancelled"}))
}

#[tauri::command]
pub async fn resume_download(
    id: String,
    url: String,
    subfolder: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let comfy_path = {
        let p = state.comfy_path.lock().unwrap();
        p.clone()
    };

    let dest_dir = models_dir(&comfy_path, &subfolder)?;
    let dest_file = dest_dir.join(&id);
    let tmp_path = dest_file.with_extension("download");

    let resume_offset = if tmp_path.exists() {
        tmp_path.metadata().map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    // Same claim as a fresh start: resuming a transfer that is already running
    // would put a second writer on the temp file.
    {
        let mut downloads = state.downloads.lock().unwrap();
        match claim_download(&mut downloads, &id, &id.clone(), &dest_file, resume_offset) {
            Claim::Ok => {}
            Claim::AlreadyRunning => {
                return Ok(serde_json::json!({"status": "already_running", "id": id}));
            }
            Claim::NameConflict(other) => {
                return Ok(serde_json::json!({
                    "status": "error",
                    "error": format!("Another download is already writing a file called {id} (to {other})."),
                }));
            }
        }
    }

    // Create new cancellation token
    let token = CancellationToken::new();
    {
        let mut tokens = state.download_tokens.lock().unwrap();
        tokens.insert(id.clone(), token.clone());
    }

    let downloads_arc = Arc::clone(&state.downloads);
    let tokens_arc = Arc::clone(&state.download_tokens);
    let id_clone = id.clone();

    tokio::spawn(async move {
        match do_download(&url, &dest_file, &downloads_arc, &id_clone, token, resume_offset).await {
            Ok(_) => {
                if let Ok(mut dl) = downloads_arc.lock() {
                    if let Some(p) = dl.get_mut(&id_clone) {
                        p.status = "complete".to_string();
                    }
                }
                println!("[Download] Complete: {}", id_clone);
            }
            Err(e) => {
                if e == "paused" {
                    println!("[Download] Paused: {}", id_clone);
                } else if e == "cancelled" {
                    let tmp = dest_file.with_extension("download");
                    let _ = std::fs::remove_file(&tmp);
                    if let Ok(mut dl) = downloads_arc.lock() {
                        dl.remove(&id_clone);
                    }
                    println!("[Download] Cancelled: {}", id_clone);
                } else {
                    if let Ok(mut dl) = downloads_arc.lock() {
                        if let Some(p) = dl.get_mut(&id_clone) {
                            p.status = "error".to_string();
                            p.error = Some(e.clone());
                        }
                    }
                    println!("[Download] Failed: {} - {}", id_clone, e);
                }
            }
        }
        if let Ok(mut tokens) = tokens_arc.lock() {
            tokens.remove(&id_clone);
        }
    });

    Ok(serde_json::json!({"status": "resuming", "offset": resume_offset}))
}

#[tauri::command]
pub fn download_progress(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let downloads = state.downloads.lock().unwrap();
    let map: HashMap<String, DownloadProgress> = downloads.clone();
    Ok(serde_json::to_value(map).unwrap_or_default())
}

// ─── HuggingFace GGUF Downloads (to provider model dirs) ───

#[tauri::command]
pub fn detect_model_path(provider: String) -> Result<serde_json::Value, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let provider_lower = provider.to_lowercase();

    // Providers with managed model directories. Checked in order, first
    // existing path wins. Falls through to LU fallback dir if none match —
    // that dir is then indexed by LU's own scanner (future work) or the
    // user can point their backend at it manually.
    //
    // Covers the 15 providers in src/api/providers/types.ts — only the ones
    // with a conventional managed dir (most CLI-run backends take a path
    // arg, so there's no one-true-path for them).
    let candidates: Vec<PathBuf> = match provider_lower.as_str() {
        // Built-in engine (P1): app-owned models dir. Handled before the
        // detection loop below because it must be auto-created on a fresh box —
        // returned directly here so onboarding can download into it immediately.
        // Accept the display name too ("Built-in Engine") — the Discover tab
        // passes `providers.openai.name`, not the internal id, so without these
        // aliases a built-in-active install couldn't add a second chat model.
        "builtin" | "built-in engine" | "built in engine" => {
            return crate::commands::engine::builtin_models_dir()
                .map(|p| serde_json::json!(p.to_string_lossy()));
        }
        // Ollama manages its own blob store — treat as a pointer so LU can
        // later auto-create a Modelfile pointing at the downloaded GGUF.
        "ollama" => vec![
            home.join(".ollama").join("models"),
        ],
        // LM Studio 0.3.x+ uses ~/.lmstudio/models (Windows/Mac/Linux).
        // Legacy 0.2.x used ~/.cache/lm-studio/models.
        "lm studio" | "lmstudio" => vec![
            home.join(".lmstudio").join("models"),
            home.join(".cache").join("lm-studio").join("models"),
        ],
        // Jan: modern installers on Windows write to %APPDATA%\Jan\data\models,
        // Mac/Linux fall back to ~/jan/models.
        "jan" => vec![
            dirs::data_dir().unwrap_or_else(|| home.clone()).join("Jan").join("data").join("models"),
            home.join(".jan").join("models"),
            home.join("jan").join("models"),
        ],
        // GPT4All: Windows ships %LOCALAPPDATA%\nomic.ai\GPT4All. Mac/Linux
        // use ~/.cache/gpt4all. We check both.
        "gpt4all" => vec![
            dirs::data_local_dir().unwrap_or_else(|| home.clone()).join("nomic.ai").join("GPT4All"),
            home.join(".cache").join("gpt4all"),
        ],
        // LocalAI: single conventional path.
        "localai" => vec![
            home.join(".localai").join("models"),
        ],
        // text-generation-webui (aka oobabooga): installs into its own folder,
        // no one-true-path. Check common locations.
        "oobabooga" | "text-generation-webui" | "tgw" => vec![
            home.join("text-generation-webui").join("models"),
            home.join("oobabooga").join("models"),
        ],
        // KoboldCpp: single-binary, model dir next to the binary or ~ default.
        "koboldcpp" | "kobold" => vec![
            home.join(".koboldcpp").join("models"),
            home.join("koboldcpp").join("models"),
        ],
        // llama.cpp: no managed dir — users typically keep GGUFs anywhere.
        // We default to ~/models (common convention when running server.sh).
        "llama.cpp" | "llamacpp" | "llama-cpp" => vec![
            home.join("models"),
            home.join("llama.cpp").join("models"),
        ],
        // vLLM, SGLang, TabbyAPI, Aphrodite, TGI: all CLI-run, no conventional
        // dir. Fall through to LU's fallback.
        //
        // Cloud providers (OpenRouter, Groq, Together, DeepSeek, Mistral,
        // OpenAI, Anthropic, Custom) don't use a local model dir at all.
        _ => vec![],
    };

    for path in &candidates {
        if path.exists() {
            return Ok(serde_json::json!(path.to_string_lossy()));
        }
    }

    // No managed dir exists yet for this provider. For the two providers LU
    // actively writes downloads into (Ollama, LM Studio), pre-create the
    // conventional path so the first download just works on a fresh box —
    // this is the Plug & Play path. Frontend gating ensures we only ever
    // direct-write into the LM Studio dir; Ollama's path is here purely so
    // legacy callers don't get an Err — see download_model_to_path callers.
    //
    // The previous `~/locally-uncensored/models` fallback was unreachable
    // by any backend and produced the "downloaded but invisible" bug
    // (Discord drdeath9669, kmmorr23, GH disc #35). We remove it: if a
    // user picked a backend with no conventional dir, return an explicit
    // error so the UI can show a real message instead of silently writing
    // into a junk folder.
    match provider_lower.as_str() {
        "ollama" => {
            let p = home.join(".ollama").join("models");
            fs::create_dir_all(&p).map_err(|e| format!("Create Ollama models dir: {}", os_error::english(&e)))?;
            Ok(serde_json::json!(p.to_string_lossy()))
        }
        "lm studio" | "lmstudio" => {
            let p = home.join(".lmstudio").join("models");
            fs::create_dir_all(&p).map_err(|e| format!("Create LM Studio models dir: {}", os_error::english(&e)))?;
            Ok(serde_json::json!(p.to_string_lossy()))
        }
        _ => Err(format!(
            "No conventional model directory for provider '{}'. Configure a custom path in Settings → Models, or pick a backend (Ollama / LM Studio) with a known model location.",
            provider
        )),
    }
}

#[allow(non_snake_case)]
#[tauri::command]
pub async fn download_model_to_path(
    url: String,
    destDir: String,
    filename: String,
    expectedBytes: Option<u64>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let dest_dir = destDir;
    let expected_bytes = expectedBytes;
    let dir = PathBuf::from(&dest_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("Create dest dir: {}", os_error::english(&e)))?;
    let dest_file = dir.join(sanitize_filename(&filename));

    if dest_file.exists() {
        let file_complete = match expected_bytes {
            Some(expected) if expected > 0 => {
                let actual = dest_file.metadata().map(|m| m.len()).unwrap_or(0);
                let threshold = (expected as f64 * 0.9) as u64;
                actual >= threshold
            }
            _ => true,
        };
        if file_complete {
            return Ok(serde_json::json!({"status": "exists", "path": dest_file.to_string_lossy()}));
        }
    }

    let id = filename.clone();
    let tmp_path = dest_file.with_extension("download");
    let resume_offset = if tmp_path.exists() {
        tmp_path.metadata().map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    match claim_download(&mut state.downloads.lock().unwrap(), &id, &filename, &dest_file, resume_offset) {
        Claim::Ok => {}
        Claim::AlreadyRunning => {
            return Ok(serde_json::json!({"status": "already_running", "id": id}));
        }
        Claim::NameConflict(other) => {
            return Ok(serde_json::json!({
                "status": "error",
                "error": format!("Another download is already writing a file called {filename} (to {other}). Wait for it to finish, then start this one again."),
            }));
        }
    }

    let token = CancellationToken::new();
    {
        let mut tokens = state.download_tokens.lock().unwrap();
        tokens.insert(id.clone(), token.clone());
    }

    let downloads_arc = Arc::clone(&state.downloads);
    let tokens_arc = Arc::clone(&state.download_tokens);
    let id_clone = id.clone();
    let filename_clone = filename.clone();

    tokio::spawn(async move {
        match do_download(&url, &dest_file, &downloads_arc, &id_clone, token, resume_offset).await {
            Ok(_) => {
                if let Ok(mut dl) = downloads_arc.lock() {
                    if let Some(p) = dl.get_mut(&id_clone) {
                        p.status = "complete".to_string();
                    }
                }
                println!("[Download] Complete: {} -> {}", filename_clone, dest_dir);
            }
            Err(e) => {
                if e == "paused" {
                    println!("[Download] Paused: {}", filename_clone);
                } else if e == "cancelled" {
                    let tmp = dest_file.with_extension("download");
                    let _ = std::fs::remove_file(&tmp);
                    if let Ok(mut dl) = downloads_arc.lock() {
                        dl.remove(&id_clone);
                    }
                } else {
                    if let Ok(mut dl) = downloads_arc.lock() {
                        if let Some(p) = dl.get_mut(&id_clone) {
                            p.status = "error".to_string();
                            p.error = Some(e.clone());
                        }
                    }
                }
            }
        }
        if let Ok(mut tokens) = tokens_arc.lock() {
            tokens.remove(&id_clone);
        }
    });

    Ok(serde_json::json!({"status": "started", "id": id}))
}

// ─── File Size Validation ───

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckFileRequest {
    pub subfolder: String,
    pub filename: String,
    pub expected_bytes: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckFileResult {
    pub filename: String,
    pub exists: bool,
    pub actual_bytes: u64,
    pub complete: bool,
}

#[tauri::command]
pub async fn check_model_sizes(
    files: Vec<CheckFileRequest>,
    state: State<'_, AppState>,
) -> Result<Vec<CheckFileResult>, String> {
    let comfy_path = {
        let mut p = state.comfy_path.lock().unwrap();
        if p.is_none() {
            if let Some(found) = crate::commands::process::find_comfyui_path() {
                *p = Some(found);
            }
        }
        p.clone()
    };

    let mut results = Vec::with_capacity(files.len());

    for file in &files {
        let dest_dir = match models_dir(&comfy_path, &file.subfolder) {
            Ok(d) => d,
            Err(_) => {
                results.push(CheckFileResult {
                    filename: file.filename.clone(),
                    exists: false,
                    actual_bytes: 0,
                    complete: false,
                });
                continue;
            }
        };

        let dest_file = dest_dir.join(&file.filename);
        if dest_file.exists() {
            let actual = dest_file.metadata().map(|m| m.len()).unwrap_or(0);
            // Use 50% threshold for install checks — sizeGB values are rough estimates
            // (e.g. sizeGB: 0.9 for an 800 MB file). The 90% check in download_model
            // handles partial downloads; this check just validates the file isn't empty/tiny.
            let threshold = if file.expected_bytes > 0 {
                (file.expected_bytes as f64 * 0.5) as u64
            } else {
                0
            };
            let complete = file.expected_bytes == 0 || actual >= threshold;
            results.push(CheckFileResult {
                filename: file.filename.clone(),
                exists: true,
                actual_bytes: actual,
                complete,
            });
        } else {
            results.push(CheckFileResult {
                filename: file.filename.clone(),
                exists: false,
                actual_bytes: 0,
                complete: false,
            });
        }
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_drive_is_named_before_the_first_byte() {
        // Der echte Fall vom 15.08.: 16,3 GB Videomodell, 15,2 GB frei.
        let modell = 16_331_849_976;
        let (needed, free) = space_shortfall(modell, 0, Some(15_200_000_000)).expect("muss knapp sein");
        assert_eq!(free, 15_200_000_000);
        assert!(needed > free);
        // Genug Platz plus Reserve: der Download laeuft.
        assert!(space_shortfall(modell, 0, Some(modell + SPACE_RESERVE)).is_none());
        // Exakt die Reserve zu wenig: das ist der Fall, der Windows lahmlegt.
        assert!(space_shortfall(modell, 0, Some(modell)).is_some());
    }

    #[test]
    fn what_already_lies_on_disk_does_not_have_to_fit_twice() {
        // Fortsetzung: 12 GB von 16,3 GB liegen schon, es fehlen 4,3 GB.
        let total = 16_000_000_000;
        assert!(space_shortfall(total, 12_000_000_000, Some(5_500_000_000)).is_none());
        // Ohne Anrechnung des Vorhandenen waere derselbe Lauf abgelehnt worden.
        assert!(space_shortfall(total, 0, Some(5_500_000_000)).is_some());
    }

    #[test]
    fn without_a_number_nothing_is_blocked() {
        // Server nennt keine Laenge: es gibt nichts zu rechnen, also kein Nein.
        assert!(space_shortfall(0, 0, Some(1)).is_none());
        // Laufwerk nicht messbar: ein unbekannter Wert darf niemanden aussperren.
        assert!(space_shortfall(16_000_000_000, 0, None).is_none());
    }

    #[test]
    fn a_short_body_is_never_renamed_into_place() {
        assert!(ended_early(6_000_000_000, 3_500_000_000));
        assert!(!ended_early(6_000_000_000, 6_000_000_000));
        // Server declared no length: nothing to compare against, trust the stream.
        assert!(!ended_early(0, 17));
    }

    #[test]
    fn only_a_206_lets_the_partial_file_count() {
        assert_eq!(resumed_bytes(4096, 206), 4096);
        // Range ignored — the whole body arrives and the part file is restarted.
        assert_eq!(resumed_bytes(4096, 200), 0);
        assert_eq!(resumed_bytes(0, 206), 0);
    }
}

/// One transfer per destination file.
///
/// The map is keyed by bare filename. A second start under the same key used
/// to overwrite the first entry AND the first cancel token, so the first
/// download could no longer be paused or cancelled and both tokio tasks wrote
/// the same `.download` file — one truncating it, the other appending at its
/// own offset. The file still reached `total` bytes and was reported
/// "complete": a silently corrupt model, several GB of it.
#[cfg(test)]
mod claim_tests {
    use super::*;

    fn running(dest: &str) -> DownloadProgress {
        DownloadProgress {
            progress: 1024,
            total: 4096,
            speed: 10.0,
            filename: "model.safetensors".into(),
            status: "downloading".into(),
            error: None,
            dest: dest.into(),
        }
    }

    fn claim(map: &mut HashMap<String, DownloadProgress>, dest: &str) -> Claim {
        claim_download(map, "model.safetensors", "model.safetensors", Path::new(dest), 0)
    }

    #[test]
    fn an_untouched_id_is_claimed_and_records_its_destination() {
        let mut map = HashMap::new();
        assert_eq!(claim(&mut map, "/models/vae/model.safetensors"), Claim::Ok);
        let p = &map["model.safetensors"];
        assert_eq!(p.status, "connecting");
        assert_eq!(p.dest, "/models/vae/model.safetensors");
    }

    #[test]
    fn a_second_start_of_the_same_file_is_refused_and_leaves_the_first_alone() {
        let mut map = HashMap::new();
        map.insert("model.safetensors".to_string(), running("/models/vae/model.safetensors"));

        assert_eq!(claim(&mut map, "/models/vae/model.safetensors"), Claim::AlreadyRunning);
        // The caller returns before it can insert a token, so the running
        // transfer keeps the one that can still cancel it.
        let p = &map["model.safetensors"];
        assert_eq!(p.status, "downloading");
        assert_eq!(p.progress, 1024);
    }

    #[test]
    fn two_different_models_sharing_a_file_name_collide_visibly() {
        // "model.safetensors", "ae.safetensors", "diffusion_pytorch_model.safetensors"
        // are all over HuggingFace, so this is the normal case, not a corner.
        let mut map = HashMap::new();
        map.insert("model.safetensors".to_string(), running("/models/vae/model.safetensors"));

        assert_eq!(
            claim(&mut map, "/models/checkpoints/model.safetensors"),
            Claim::NameConflict("/models/vae/model.safetensors".to_string()),
        );
    }

    #[test]
    fn a_transfer_on_its_way_out_still_counts_as_running() {
        let mut map = HashMap::new();
        let mut p = running("/models/vae/model.safetensors");
        p.status = "pausing".into();
        map.insert("model.safetensors".to_string(), p);

        assert_eq!(claim(&mut map, "/models/vae/model.safetensors"), Claim::AlreadyRunning);
    }

    #[test]
    fn a_finished_paused_or_failed_entry_may_be_restarted() {
        for status in ["complete", "paused", "error"] {
            let mut map = HashMap::new();
            let mut p = running("/models/vae/model.safetensors");
            p.status = status.into();
            map.insert("model.safetensors".to_string(), p);

            assert_eq!(claim(&mut map, "/models/vae/model.safetensors"), Claim::Ok, "{status}");
            assert_eq!(map["model.safetensors"].status, "connecting");
        }
    }

    #[test]
    fn an_entry_from_before_this_field_is_not_mistaken_for_a_collision() {
        let mut map = HashMap::new();
        map.insert("model.safetensors".to_string(), running(""));

        assert_eq!(claim(&mut map, "/models/vae/model.safetensors"), Claim::AlreadyRunning);
    }
}
