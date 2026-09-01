use crate::os_error;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::state::{AppState, DownloadProgress};

/// Reduce a download filename to a safe basename — no path separators, no
/// drive letter, no `..` — so a crafted `filename` (e.g. "..\\..\\Start
/// Menu\\Programs\\Startup\\x.bat") can't escape the target directory and drop
/// an autostart payload. Falls back to "download" if nothing usable remains.
fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
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
    use super::{checked_model_path, safe_subfolder, sanitize_filename};
    use std::path::PathBuf;

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

    /// The size probe reads names that come straight from a ComfyUI answer.
    /// A hostile ComfyUI must never be able to point it at a path outside the
    /// models folder, because exists() plus metadata().len() would hand it an
    /// existence and size oracle for the whole machine.
    #[test]
    fn check_path_never_escapes_dest_dir() {
        let dest = PathBuf::from("/comfy/models/embeddings");

        // Honest names keep working, nested ComfyUI enum names included.
        assert_eq!(
            checked_model_path(&dest, "pony.safetensors").unwrap(),
            dest.join("pony.safetensors")
        );
        assert_eq!(
            checked_model_path(&dest, "sdxl/pony.safetensors").unwrap(),
            dest.join("sdxl").join("pony.safetensors")
        );

        // Hostile names are either refused outright or land inside dest_dir,
        // never anywhere else.
        let hostile = [
            "/etc/passwd",
            "/Users/victim/.ssh/id_ed25519",
            "C:\\Windows\\win.ini",
            "..\\..\\..\\Windows\\win.ini",
            "../../../../etc/shadow",
            "..",
        ];
        for name in hostile {
            if let Some(p) = checked_model_path(&dest, name) {
                assert!(
                    p.starts_with(&dest),
                    "escaped dest_dir: {} resolved to {}",
                    name,
                    p.display()
                );
            }
        }
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
    expectedSha256: Option<String>,
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

    let expected_sha256 = match expectedSha256.as_deref() {
        Some(s) => Some(normalize_sha256(s)?),
        None => None,
    };

    if dest_file.exists() {
        let actual = dest_file.metadata().map(|m| m.len()).unwrap_or(0);
        // Ask the SERVER how big the file is. The catalog's `expectedBytes` is a
        // rounded GB estimate and may not decide this — see `judge_existing`.
        match judge_existing(actual, exact_remote_size(&url).await) {
            Existing::Complete => {
                return Ok(serde_json::json!({"status": "exists", "path": dest_file.to_string_lossy()}));
            }
            Existing::Mismatch { actual, exact } => {
                println!(
                    "[Download] {} exists with {} bytes but the host states {} — fetching it again",
                    filename, actual, exact
                );
                // Fall through to a fresh transfer.
            }
            Existing::Unverified { actual } => {
                // Offline, or a host that states no length. Nothing can be
                // checked, so nothing is claimed: the file stays, and the reason
                // it was not verified is on the record instead of nowhere.
                println!(
                    "[Download] {} exists with {} bytes and the host states no size — accepted UNVERIFIED",
                    filename, actual
                );
                return Ok(serde_json::json!({"status": "exists", "path": dest_file.to_string_lossy()}));
            }
        }
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
        match do_download(&url, &dest_file, &downloads_arc, &id_clone, token, resume_offset,
                        CatalogClaims { expected_bytes, expected_sha256 }).await {
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

/// The full size of the file being fetched, and whether that number is only the
/// catalog's estimate rather than something the server stated.
///
/// A server that sends no `Content-Length` used to switch BOTH guards off
/// without a word: `unwrap_or(0)` produced `total == 0`, and 0 is exactly the
/// value the space check and the truncation check read as "nothing to compare
/// against". A 40 GB transfer then ran until the drive hit zero and a body that
/// stopped halfway was renamed into place, with nobody ever having been told
/// that either safeguard had turned itself off.
///
/// The catalog carries a size for these files, so the space guard gets that
/// estimate to plan with — a rough number is a far better plan than no number.
/// The flag is what keeps the two uses apart: an estimate may refuse a transfer
/// that clearly cannot fit, it may NEVER declare one finished.
fn total_size(declared: Option<u64>, resume_offset: u64, resumed: bool, estimate: Option<u64>) -> (u64, bool) {
    match declared {
        Some(n) if n > 0 => (if resumed { n + resume_offset } else { n }, false),
        _ => (estimate.unwrap_or(0), true),
    }
}

/// What a file that is already sitting at the destination is worth.
#[derive(Debug, PartialEq, Eq)]
pub enum Existing {
    /// Byte for byte the size the server states. Nothing left to fetch.
    Complete,
    /// The server states a different size than the file has. Fetch it again.
    Mismatch { actual: u64, exact: u64 },
    /// Nobody could name an exact size, so nothing here is verified.
    Unverified { actual: u64 },
}

/// Decide what to do with a file already at the destination.
///
/// The old rule was `actual >= expected as f64 * 0.9`, measured against a
/// catalog size that is a rounded GB estimate. A download aborted at 91 % was
/// therefore "complete" and never fetched again: several gigabytes of model
/// weights accepted on a file length with 10 % of slack, and the failure only
/// surfaced much later when a backend tried to load the truncated file.
///
/// There is no safe threshold here. Either a number is exact — then it has to
/// match to the byte — or it is not, and then it may not decide anything. The
/// exact number comes from the server (`exact_remote_size`), never from the
/// catalog.
pub fn judge_existing(actual: u64, exact: Option<u64>) -> Existing {
    match exact {
        Some(e) if e > 0 => {
            if actual == e {
                Existing::Complete
            } else {
                Existing::Mismatch { actual, exact: e }
            }
        }
        _ => Existing::Unverified { actual },
    }
}

/// Total size out of a `Content-Range: bytes 0-0/12345` header. A `*` for the
/// whole means the server knows the range but not the length, which is no
/// number to judge with.
fn total_from_content_range(v: &str) -> Option<u64> {
    v.rsplit('/').next()?.trim().parse::<u64>().ok()
}

/// A 64 character hex SHA256, lowercased.
///
/// Anything else is refused rather than quietly ignored: a mistyped digest that
/// silently disables the check is worse than no digest at all, because it looks
/// like the file was verified.
fn normalize_sha256(v: &str) -> Result<String, String> {
    let t = v.trim();
    if t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(t.to_ascii_lowercase())
    } else {
        Err(format!(
            "Expected sha256 must be 64 hex characters, got {} character(s)",
            t.chars().count()
        ))
    }
}

/// Turn a refused HTTP status into something the user can act on, and say in
/// the same breath whether pressing Retry could ever help.
///
/// The catalog hard-codes 106 HuggingFace addresses. The moment a repo is
/// renamed, made private, or gated behind a licence click, every one of them
/// answers 404 or 401/403 for good — and all the user got was the bare string
/// "HTTP 404" next to a Retry button that could not possibly work, which is a
/// loop with no exit.
///
/// The status code stays inside the text on purpose: it is the contract the
/// frontend reads to decide whether to offer Retry at all — see
/// `isPermanentDownloadError` in src/api/discover.ts. Changing the "(HTTP nnn)"
/// shape here breaks that decision there.
pub fn http_error_message(status: u16, filename: &str) -> String {
    match status {
        404 | 410 => format!(
            "{filename} is not at this address any more (HTTP {status}). The repository was renamed, moved or taken down, so trying again cannot help. Look for a newer version of this model in the Model Manager, or update Locally Uncensored — the address is part of the app's catalog."
        ),
        401 | 403 => format!(
            "{filename} cannot be downloaded without a HuggingFace login (HTTP {status}). This repository is gated or private: open its page in a browser, accept the licence with your HuggingFace account, and put the file into the model folder by hand. Trying again here cannot help."
        ),
        429 => format!(
            "The host is rate limiting this download (HTTP {status}). Wait a few minutes, then start {filename} again."
        ),
        500..=599 => format!(
            "The host could not serve {filename} right now (HTTP {status}). That is a problem on their side — start it again in a few minutes."
        ),
        _ => format!("HTTP {status} while downloading {filename}."),
    }
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

/// One reqwest client, built the same way for every request this module makes.
///
/// The SSRF guard is not optional and not a per-call decision: model downloads
/// come from public catalogs, and a crafted catalog or model URL must not be
/// able to reach an internal service or 169.254.169.254 — on the first hop or
/// on any redirect.
fn download_client(connect_secs: u64, read_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("LocallyUncensored/1.5")
        .redirect(crate::commands::proxy::ssrf_safe_redirect_policy(10))
        .connect_timeout(std::time::Duration::from_secs(connect_secs))
        .read_timeout(std::time::Duration::from_secs(read_secs))
        .build()
        .map_err(|e| os_error::english(&e))
}

/// The exact byte count the SERVER states for `url`, or None when it will not
/// state one (offline, HEAD refused, chunked transfer, a probe that errors).
///
/// This is the only trustworthy size in the whole download path. The catalog's
/// `sizeGB` is a rounded human number — "9.2" for a file of 9 874 331 648 bytes
/// — so it can size a progress bar or refuse a full drive, but it can never
/// certify that a file on disk is the whole file.
/// Short timeouts, because this runs INSIDE the install click. A machine with
/// no network must cost the user a moment, not half a minute — the answer for
/// an unreachable host is "cannot tell", and arriving at it slowly helps
/// nobody.
async fn exact_remote_size(url: &str) -> Option<u64> {
    crate::commands::proxy::validate_public_url(url).ok()?;
    let client = download_client(8, 15).ok()?;

    // A transport error means offline or a black-holed host. Retrying the same
    // unreachable address with a second request only doubles the wait.
    let head = client.head(url).send().await.ok()?;
    if head.status().is_success() {
        if let Some(n) = head.content_length() {
            if n > 0 {
                return Some(n);
            }
        }
    }

    // The host answered, just not usefully: some CDNs reply 405 to HEAD, or drop
    // the length from it. A one byte ranged GET costs one more round trip and
    // carries the whole size in Content-Range.
    let r = client.get(url).header("Range", "bytes=0-0").send().await.ok()?;
    let v = r.headers().get(reqwest::header::CONTENT_RANGE)?.to_str().ok()?;
    total_from_content_range(v)
}

/// SHA256 of the first `len` bytes of `path`.
///
/// Only needed when a transfer RESUMES with a digest to check: the bytes
/// already on disk never passed through the hasher, so without replaying them
/// the final digest would be the hash of the tail alone and every resumed
/// download would look corrupt. Reading a large partial back costs seconds;
/// throwing the partial away costs hours.
async fn digest_of_prefix(path: &Path, len: u64) -> Result<Sha256, String> {
    use tokio::io::AsyncReadExt;
    let mut f = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Open partial file for hashing: {}", os_error::english(&e)))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut done: u64 = 0;
    while done < len {
        let want = std::cmp::min(buf.len() as u64, len - done) as usize;
        let n = f
            .read(&mut buf[..want])
            .await
            .map_err(|e| format!("Read partial file for hashing: {}", os_error::english(&e)))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        done += n as u64;
    }
    Ok(hasher)
}

/// What the catalog entry claims about the file, as opposed to what the server
/// says on the wire. The two travel together everywhere and are the only
/// arguments `do_download` takes that are not about the transfer itself, so
/// they ride as one — which also puts the argument count back under
/// `clippy::too_many_arguments`'s threshold without an `allow`.
struct CatalogClaims {
    /// Catalog estimate. Plans the space guard when the server states no length;
    /// never decides that a transfer is finished.
    expected_bytes: Option<u64>,
    /// Digest from the catalog entry, already normalised. `None` means the
    /// content of this file cannot be verified at all.
    expected_sha256: Option<String>,
}

async fn do_download(
    url: &str,
    dest: &PathBuf,
    downloads: &Arc<Mutex<HashMap<String, DownloadProgress>>>,
    id: &str,
    token: CancellationToken,
    resume_offset: u64,
    claims: CatalogClaims,
) -> Result<(), String> {
    let CatalogClaims { expected_bytes, expected_sha256 } = claims;
    // SSRF guard: model downloads come from public catalogs (HuggingFace,
    // civitai, ollama). Block private/loopback/metadata hosts and re-validate
    // every redirect hop so a crafted catalog/model URL can't pull from an
    // internal service or 169.254.169.254.
    crate::commands::proxy::validate_public_url(url)?;

    // A deadline on the whole request punishes people for having a slow line
    // rather than a broken one: the 2 hour cap this replaces killed any
    // download that legitimately took longer, and the catalog offers single
    // files of 40 GB and sets of 155 GB. bob80817-dev, Discord 2026-07-29,
    // after giving up: "all of your downloads have a habit of timing out".
    // What we actually want to catch is a stalled transfer, so the limits are
    // per-connect and per-read. A dead socket now fails in two minutes and
    // resumes from the partial on the next attempt; a slow one is left to
    // finish.
    let client = download_client(30, 120)?;

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
        let name = dest
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "this file".to_string());
        return Err(http_error_message(status.as_u16(), &name));
    }

    let already_on_disk = resumed_bytes(resume_offset, status.as_u16());
    let resumed = already_on_disk > 0;

    // For resumed downloads, total = content_length + offset. When the server
    // states no length at all the catalog estimate steps in for the space
    // guard, and `estimated` records that it must not be trusted with anything
    // else — see `total_size`.
    let (total, estimated) = total_size(response.content_length(), resume_offset, resumed, expected_bytes);
    if estimated {
        println!(
            "[Download] {} — the host states no Content-Length. Truncation cannot be detected by size; the space check falls back to the catalog estimate ({} bytes).",
            id, total
        );
    }

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

    // The digest is only computed when there is something to compare it
    // against. Hashing 155 GB to write the result into a log line nobody reads
    // costs the user real minutes of CPU, so an entry without a `sha256` says
    // so once, loudly, and skips the work.
    let mut hasher = match (&expected_sha256, resumed) {
        (None, _) => {
            println!(
                "[Download] {} — no sha256 in the catalog entry, content will NOT be verified (size only)",
                id
            );
            None
        }
        (Some(_), false) => Some(Sha256::new()),
        // Resuming: the bytes already on disk never passed through the hasher,
        // so replay them or the final digest is the hash of the tail alone.
        (Some(_), true) => Some(digest_of_prefix(&tmp_path, already_on_disk).await?),
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
                        if let Some(h) = hasher.as_mut() { h.update(&bytes); }
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
    //
    // `estimated` means the number in `total` is the catalog's guess, not the
    // server's statement. A guess may not fail a transfer that is in fact
    // complete, so the size check is skipped and the digest — if there is one —
    // is what stands between the user and a truncated model.
    if !estimated && ended_early(total, downloaded) {
        return Err(format!(
            "Download ended early: {} of {} bytes received. Start it again to resume.",
            downloaded, total
        ));
    }
    if estimated {
        println!(
            "[Download] {} finished at {} bytes with no size stated by the host — completeness unchecked",
            id, downloaded
        );
    }

    // Content check, when the catalog gave us something to check against. A
    // wrong file is worse than a missing one: it installs, it is listed, and it
    // blows up hours later inside a backend. So the partial goes and the error
    // names the cause instead of leaving a plausible looking model behind.
    if let (Some(expected), Some(h)) = (expected_sha256.as_deref(), hasher) {
        let actual = format!("{:x}", h.finalize());
        if actual != expected {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(format!(
                "{} does not match the checksum the catalog lists for it (expected sha256 {}, got {}). The file was discarded — the download was corrupted in transit or the host is serving different content. Start it again.",
                dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "The file".to_string()),
                expected,
                actual,
            ));
        }
        println!("[Download] {} verified against sha256 {}", id, expected);
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

/// The user aborting a transfer. Stops it AND removes the partial file.
///
/// This is one of two ways an entry leaves the progress map, and the two must
/// never be confused. Cancel is a decision: the user does not want this file,
/// so the bytes on disk go with it. `clear_download_entry` is bookkeeping: the
/// row is removed, the partial stays, and the next attempt resumes from it.
///
/// Retrying a failed download used to come through HERE, which is how a short
/// network outage on a 40 GB bundle turned into a full re-download: the error
/// text promised "start it again to resume", the user pressed the button the UI
/// offered, and the button deleted the 36 GB it was about to resume from. On a
/// bad line that never converges.
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
            remove_partial(&dest);
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

/// Take a SETTLED entry out of the progress map and leave the disk alone.
///
/// The counterpart to `cancel_download`. The frontend has to clear the Rust
/// entry before a retry, or `download_model` short-circuits on the file that is
/// already there, never touches the map, and the next poll resurrects the error
/// row the user just retried (the_mr_pickles). Doing that through cancel meant
/// paying for the bookkeeping with the partial file — several gigabytes for a
/// map key.
///
/// Refuses to touch a transfer that is still live: "connecting", "downloading"
/// and "pausing" own their entry, and dropping it under them would leave a
/// running tokio task writing into a file nothing knows about.
#[tauri::command]
pub fn clear_download_entry(id: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut dl = state
        .downloads
        .lock()
        .map_err(|_| "Download state is poisoned".to_string())?;
    match dl.get(&id) {
        Some(p) if !clearable(&p.status) => Ok(serde_json::json!({"status": "still_active"})),
        Some(_) => {
            dl.remove(&id);
            Ok(serde_json::json!({"status": "cleared"}))
        }
        None => Ok(serde_json::json!({"status": "not_found"})),
    }
}

/// May this entry be dropped from the map without stopping anything?
///
/// A live transfer owns its entry: the tokio task writes progress into it and
/// the cancel token is looked up by the same id, so removing it under a running
/// download would leave a writer nothing can reach.
pub fn clearable(status: &str) -> bool {
    !matches!(status, "connecting" | "downloading" | "pausing")
}

/// Remove the partial belonging to `dest`. Reports whether a file went.
///
/// Deliberately its own function with exactly ONE caller, `cancel_download`.
/// Deleting a partial is a user decision, never a side effect of tidying up
/// state — see the note on `cancel_download`.
fn remove_partial(dest: &str) -> bool {
    if dest.is_empty() {
        return false;
    }
    std::fs::remove_file(PathBuf::from(dest).with_extension("download")).is_ok()
}

/// Bytes that transfers already in flight still have to write.
///
/// The per-download space check answers "does the rest of THIS file fit", which
/// is the wrong question when a bundle starts four files at once: each of the
/// four passed against the same free bytes, all four started, and the drive
/// filled anyway. Whatever is still owed counts as taken.
pub fn reserved_bytes(downloads: &HashMap<String, DownloadProgress>) -> u64 {
    downloads
        .values()
        .filter(|p| matches!(p.status.as_str(), "connecting" | "downloading" | "pausing"))
        .map(|p| p.total.saturating_sub(p.progress))
        .sum()
}

/// Does `requiredBytes` still fit next to everything already in flight?
///
/// Asked ONCE for a whole bundle before the first transfer starts, which is the
/// only place the question can be answered honestly — see `reserved_bytes`.
/// Returns the numbers as well as the verdict so the caller can put real
/// gigabytes in front of the user instead of "not enough space".
#[allow(non_snake_case)]
#[tauri::command]
pub fn check_download_space(
    subfolder: Option<String>,
    destDir: Option<String>,
    requiredBytes: u64,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let dir = match (subfolder, destDir) {
        (_, Some(d)) if !d.is_empty() => PathBuf::from(d),
        (Some(sub), _) => {
            let comfy_path = state.comfy_path.lock().unwrap().clone();
            models_dir(&comfy_path, &sub)?
        }
        _ => return Err("check_download_space needs a subfolder or a destDir".to_string()),
    };

    let reserved = state
        .downloads
        .lock()
        .map(|dl| reserved_bytes(&dl))
        .unwrap_or(0);
    let available = available_space_for(&dir);
    let shortfall = space_shortfall(requiredBytes.saturating_add(reserved), 0, available);

    Ok(match shortfall {
        None => serde_json::json!({
            "fits": true,
            "requiredBytes": requiredBytes,
            "reservedBytes": reserved,
            "availableBytes": available,
        }),
        Some((needed, free)) => serde_json::json!({
            "fits": false,
            "requiredBytes": requiredBytes,
            "reservedBytes": reserved,
            "availableBytes": available,
            "message": format!(
                "Not enough free space. This needs {} and the drive has {} free.{} Free up some space and start it again.",
                gib(needed),
                gib(free),
                if reserved > 0 {
                    format!(" {} of that is already promised to downloads that are still running.", gib(reserved))
                } else {
                    String::new()
                },
            ),
        }),
    })
}

/// A `.download` temp file with nobody watching it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanDownload {
    /// Basename without the `.download` suffix.
    ///
    /// NOT the download id. `Path::with_extension` REPLACES the extension, so
    /// the partial for `wan_2.1_vae.safetensors` is `wan_2.1_vae.download` and
    /// the original suffix is simply gone. The real filename is recovered on the
    /// frontend by matching this stem against the download meta it persisted and
    /// against the catalog — see `orphanFilename` in src/api/discover.ts.
    pub stem: String,
    /// Absolute path OF THE PARTIAL.
    pub path: String,
    /// Directory it sits in — the `destDir` a resume needs for a GGUF that does
    /// not live under the ComfyUI tree.
    pub dir: String,
    pub bytes: u64,
}

/// Basename minus its extension. The one place the `.download` naming rule is
/// read, so the orphan scan and the id matching cannot drift apart.
fn file_stem_of(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem.to_string(),
        _ => name.to_string(),
    }
}

/// Every root a `.download` file may legitimately live under.
///
/// Also the jail for `delete_orphan_download`: a path handed back to us is only
/// deleted when it still sits under one of these, so a crafted argument cannot
/// turn the sweeper into a "delete any file" command.
fn orphan_roots(state: &State<'_, AppState>, extra: &[String]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(p) = state.comfy_path.lock() {
        if let Some(ref path) = *p {
            roots.push(PathBuf::from(path).join("models"));
            roots.push(PathBuf::from(path).join("custom_nodes"));
        }
    }
    if let Ok(p) = crate::commands::engine::builtin_models_dir() {
        roots.push(p);
    }
    // Provider model dirs (LM Studio, Ollama, a custom path) are only known to
    // the frontend, which persists the destDir of every download it started.
    for d in extra {
        if d.is_empty() {
            continue;
        }
        let p = PathBuf::from(d);
        if p.is_absolute() {
            roots.push(p);
        }
    }
    roots
}

/// Partial downloads left behind by a previous run of the app.
///
/// Both sides of the download kept their state purely in RAM, so closing the
/// app during a multi-gigabyte transfer left the `.download` file on disk with
/// no row, no button and no way to finish or remove it — the bytes were simply
/// unreachable. This is the missing half: the disk still knows what was in
/// flight, so ask it.
///
/// Entries the running app is already working on are left out: those are not
/// orphans, they have a row.
#[allow(non_snake_case)]
#[tauri::command]
pub async fn find_orphan_downloads(
    extraDirs: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Vec<OrphanDownload>, String> {
    let extra = extraDirs.unwrap_or_default();
    let roots = orphan_roots(&state, &extra);
    // The map is keyed by full filename, the partial keeps only the stem, so the
    // comparison happens on stems.
    let live: Vec<String> = state
        .downloads
        .lock()
        .map(|dl| dl.keys().map(|k| file_stem_of(k)).collect())
        .unwrap_or_default();

    // Off the main thread: this runs at startup and a ComfyUI install with a
    // few dozen node packs is tens of thousands of directory entries. Freezing
    // the window to look for leftovers would be its own bug.
    tokio::task::spawn_blocking(move || scan_for_partials(roots, live))
        .await
        .map_err(|e| format!("Orphan scan failed: {}", e))
}

/// Directories that never hold a model and always hold thousands of files.
/// Skipping them is what keeps the startup scan off the user's clock.
const SCAN_SKIP: &[&str] = &[".git", "__pycache__", "node_modules", ".venv", "venv", ".cache"];

fn scan_for_partials(roots: Vec<PathBuf>, live: Vec<String>) -> Vec<OrphanDownload> {
    let mut out: Vec<OrphanDownload> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        // Depth 4 covers models/<subfolder>/<nested enum dir>/<file> and the
        // AnimateDiff pack's models dir under custom_nodes, without descending
        // into a whole ComfyUI checkout.
        let walk = walkdir::WalkDir::new(&root).max_depth(4).into_iter().filter_entry(|e| {
            !e.file_type().is_dir()
                || e.depth() == 0
                || !e.file_name().to_str().is_some_and(|n| SCAN_SKIP.contains(&n))
        });
        for entry in walk.filter_map(|e| e.ok()) {
            let p = entry.path();
            if !entry.file_type().is_file() || p.extension().and_then(|e| e.to_str()) != Some("download") {
                continue;
            }
            if !seen.insert(p.to_path_buf()) {
                continue;
            }
            let stem = match p.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            if live.contains(&stem) {
                continue;
            }
            out.push(OrphanDownload {
                stem,
                path: p.to_string_lossy().to_string(),
                dir: p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default(),
                bytes: entry.metadata().map(|m| m.len()).unwrap_or(0),
            });
        }
    }
    // Biggest first: that is the one whose loss would hurt most.
    out.sort_by_key(|o| std::cmp::Reverse(o.bytes));
    out
}

/// Delete one orphaned partial, on the user's explicit say-so.
///
/// Jailed to `orphan_roots` and to the `.download` suffix, because the argument
/// travels through the frontend and back: without both checks this would be a
/// command that deletes any path the webview asks for.
#[allow(non_snake_case)]
#[tauri::command]
pub fn delete_orphan_download(
    path: String,
    extraDirs: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let p = PathBuf::from(&path);
    if p.extension().and_then(|e| e.to_str()) != Some("download") {
        return Err("Only .download partials can be removed here".to_string());
    }
    let extra = extraDirs.unwrap_or_default();
    if !orphan_roots(&state, &extra).iter().any(|r| p.starts_with(r)) {
        return Err("That path is not inside a model folder this app downloads into".to_string());
    }
    let bytes = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
    fs::remove_file(&p).map_err(|e| format!("Delete failed: {}", os_error::english(&e)))?;
    println!("[Download] Removed orphaned partial {} ({} bytes)", p.display(), bytes);
    Ok(serde_json::json!({"status": "deleted", "bytes": bytes}))
}

#[allow(non_snake_case)]
#[tauri::command]
pub async fn resume_download(
    id: String,
    url: String,
    subfolder: String,
    expectedBytes: Option<u64>,
    expectedSha256: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let expected_bytes = expectedBytes;
    let expected_sha256 = match expectedSha256.as_deref() {
        Some(s) => Some(normalize_sha256(s)?),
        None => None,
    };
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
        match do_download(&url, &dest_file, &downloads_arc, &id_clone, token, resume_offset,
                        CatalogClaims { expected_bytes, expected_sha256 }).await {
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
    expectedSha256: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let dest_dir = destDir;
    let expected_bytes = expectedBytes;
    let expected_sha256 = match expectedSha256.as_deref() {
        Some(s) => Some(normalize_sha256(s)?),
        None => None,
    };
    let dir = PathBuf::from(&dest_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("Create dest dir: {}", os_error::english(&e)))?;
    let dest_file = dir.join(sanitize_filename(&filename));

    if dest_file.exists() {
        // Same rule as download_model: only a size the SERVER states may call a
        // file complete. The catalog estimate with 10 % of slack used to accept
        // a transfer that died at 91 %.
        let actual = dest_file.metadata().map(|m| m.len()).unwrap_or(0);
        match judge_existing(actual, exact_remote_size(&url).await) {
            Existing::Complete => {
                return Ok(serde_json::json!({"status": "exists", "path": dest_file.to_string_lossy()}));
            }
            Existing::Mismatch { actual, exact } => {
                println!(
                    "[Download] {} exists with {} bytes but the host states {} — fetching it again",
                    filename, actual, exact
                );
            }
            Existing::Unverified { actual } => {
                println!(
                    "[Download] {} exists with {} bytes and the host states no size — accepted UNVERIFIED",
                    filename, actual
                );
                return Ok(serde_json::json!({"status": "exists", "path": dest_file.to_string_lossy()}));
            }
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
        match do_download(&url, &dest_file, &downloads_arc, &id_clone, token, resume_offset,
                        CatalogClaims { expected_bytes, expected_sha256 }).await {
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
                } else if let Ok(mut dl) = downloads_arc.lock() {
                    if let Some(p) = dl.get_mut(&id_clone) {
                        p.status = "error".to_string();
                        p.error = Some(e.clone());
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

/// Resolve one `check_model_sizes` entry to a path that is guaranteed to sit
/// inside `dest_dir`.
///
/// The filename can arrive straight out of a ComfyUI answer (`/embeddings`,
/// `/object_info`), so it gets the same jail the delete path uses: a nested
/// enum name like "sdxl/pony.safetensors" keeps its relative dir, but an
/// absolute path, a drive letter or any `..` segment is refused. Without this,
/// `Path::join` silently drops `dest_dir` for an absolute name and turns the
/// size probe into an existence and size oracle for arbitrary paths on the
/// customer's machine. Returns None when the name has to be refused; the
/// caller then answers "not found" instead of touching the disk.
fn checked_model_path(dest_dir: &Path, filename: &str) -> Option<PathBuf> {
    let (sub, base) = split_model_ref(filename);
    if !sub.is_empty() && safe_subfolder(&sub).is_err() {
        return None;
    }
    let base = sanitize_filename(&base);
    if sub.is_empty() {
        Some(dest_dir.join(&base))
    } else {
        Some(dest_dir.join(&sub).join(&base))
    }
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

        let dest_file = match checked_model_path(&dest_dir, &file.filename) {
            Some(p) => p,
            None => {
                results.push(CheckFileResult {
                    filename: file.filename.clone(),
                    exists: false,
                    actual_bytes: 0,
                    complete: false,
                });
                continue;
            }
        };
        if dest_file.exists() {
            let actual = dest_file.metadata().map(|m| m.len()).unwrap_or(0);
            // Use 50% threshold for install checks — sizeGB values are rough estimates
            // (e.g. sizeGB: 0.9 for an 800 MB file), so no tighter bound is possible
            // from a catalog number alone. This answers "is there a plausible file
            // here" for the card, NOT "is this the whole file".
            //
            // The exact question is settled where it can be: download_model asks the
            // host for the byte count and compares to the byte (`judge_existing`), and
            // do_download verifies the digest when the entry carries one. The 90 %
            // rule that used to live there is gone — a threshold may size a card, it
            // may never certify a model.
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

    /// Der Kern von Zeitbombe 3: `actual >= expected * 0.9` hat einen bei 91 %
    /// abgebrochenen Download als fertig durchgewinkt.
    #[test]
    fn an_existing_file_counts_only_at_the_exact_byte() {
        let exact = 6_000_000_000u64;
        assert_eq!(judge_existing(exact, Some(exact)), Existing::Complete);

        // 91 % — unter der alten Regel "fertig", hier genau das, was es ist.
        let at_91 = 5_460_000_000u64;
        assert_eq!(
            judge_existing(at_91, Some(exact)),
            Existing::Mismatch { actual: at_91, exact }
        );
        // Ein einziges fehlendes Byte reicht.
        assert_eq!(
            judge_existing(exact - 1, Some(exact)),
            Existing::Mismatch { actual: exact - 1, exact }
        );
        // Zu gross ist genauso falsch wie zu klein.
        assert_eq!(
            judge_existing(exact + 1, Some(exact)),
            Existing::Mismatch { actual: exact + 1, exact }
        );
        // Ohne exakte Zahl wird nichts behauptet — weder fertig noch kaputt.
        assert_eq!(judge_existing(at_91, None), Existing::Unverified { actual: at_91 });
        assert_eq!(judge_existing(at_91, Some(0)), Existing::Unverified { actual: at_91 });
    }

    #[test]
    fn a_missing_content_length_does_not_silently_disable_the_space_guard() {
        let estimate = Some(16_000_000_000u64);
        // Server nennt eine Laenge: die gilt, und sie ist keine Schaetzung.
        assert_eq!(total_size(Some(16_331_849_976), 0, false, estimate), (16_331_849_976, false));
        // Fortsetzung: der Rest plus das, was schon liegt.
        assert_eq!(total_size(Some(4_000_000_000), 12_000_000_000, true, estimate), (16_000_000_000, false));
        // Keine Laenge: der Katalogwert plant den Platz, markiert als Schaetzung.
        assert_eq!(total_size(None, 0, false, estimate), (16_000_000_000, true));
        assert_eq!(total_size(Some(0), 0, false, estimate), (16_000_000_000, true));
        // Weder Laenge noch Katalogwert: 0, und beide Guards wissen das.
        assert_eq!(total_size(None, 0, false, None), (0, true));

        // Die Schaetzung darf einen Abbruch niemals als Abbruch melden — sie
        // wuerde jeden Download bei abweichender Rundung fehlschlagen lassen.
        let (total, estimated) = total_size(None, 0, false, estimate);
        assert!(estimated);
        assert!(ended_early(total, 15_900_000_000), "die Zahl allein wuerde greifen");
        // do_download prueft deshalb `!estimated && ended_early(..)`.
    }

    #[test]
    fn the_whole_size_comes_out_of_content_range() {
        assert_eq!(total_from_content_range("bytes 0-0/12345"), Some(12345));
        assert_eq!(total_from_content_range("bytes 0-0/*"), None);
        assert_eq!(total_from_content_range("nonsense"), None);
    }

    #[test]
    fn only_a_real_digest_is_accepted() {
        // sha256 der leeren Datei, 64 Hexzeichen.
        let full = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert_eq!(full.len(), 64);
        assert_eq!(normalize_sha256(full).unwrap(), full);
        // Grossschreibung ist erlaubt, das Ergebnis ist normalisiert.
        assert_eq!(normalize_sha256(&full.to_uppercase()).unwrap(), full);
        assert_eq!(normalize_sha256(&format!("  {}  ", full)).unwrap(), full);
        // Ein Tippfehler schaltet die Pruefung nicht still ab, er faellt auf.
        assert!(normalize_sha256(&full[..63]).is_err(), "63 Zeichen sind kein sha256");
        assert!(normalize_sha256(&format!("{}ab", full)).is_err());
        assert!(normalize_sha256(&format!("sha256:{}", full)).is_err());
        assert!(normalize_sha256(&full.replace('e', "z")).is_err(), "kein Hex");
        assert!(normalize_sha256("").is_err());
    }

    /// `with_extension` ERSETZT die Endung: die Teildatei zu
    /// `wan_2.1_vae.safetensors` heisst `wan_2.1_vae.download`. Wer aus dem
    /// Fundstueck den Download-Namen zurueckrechnen will, muss das wissen.
    #[test]
    fn a_partial_keeps_only_the_stem_of_its_target() {
        let dest = PathBuf::from("/models/vae/wan_2.1_vae.safetensors");
        let part = dest.with_extension("download");
        assert_eq!(part.file_name().unwrap(), "wan_2.1_vae.download");
        assert_eq!(part.file_stem().unwrap(), "wan_2.1_vae");
        assert_eq!(file_stem_of("wan_2.1_vae.safetensors"), "wan_2.1_vae");
        assert_eq!(file_stem_of("wan_2.1_vae.download"), "wan_2.1_vae");
        // Ein Name ohne Endung bleibt, wie er ist.
        assert_eq!(file_stem_of("model"), "model");
    }

    /// Der Digest muss ueber Fortsetzungen hinweg derselbe sein, sonst waere
    /// jeder wiederaufgenommene Download "korrupt".
    #[tokio::test]
    async fn a_resumed_transfer_hashes_the_bytes_that_already_lie_there() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("m.safetensors.download");
        let head = b"the first half of a model file";
        let tail = b" and the second half";
        std::fs::write(&part, head).unwrap();

        let mut resumed = digest_of_prefix(&part, head.len() as u64).await.unwrap();
        resumed.update(tail);

        let mut in_one_go = Sha256::new();
        in_one_go.update(head);
        in_one_go.update(tail);

        assert_eq!(
            format!("{:x}", resumed.finalize()),
            format!("{:x}", in_one_go.finalize()),
        );
    }

    /// 106 fest verdrahtete HuggingFace-Adressen: wird ein Repo umbenannt oder
    /// gated, ist "HTTP 404" plus Retry-Button eine Sackgasse.
    #[test]
    fn a_dead_address_says_what_happened_and_carries_its_status() {
        let gone = http_error_message(404, "wan_2.1_vae.safetensors");
        assert!(gone.contains("(HTTP 404)"), "Frontend liest genau diese Form");
        assert!(gone.contains("wan_2.1_vae.safetensors"));
        assert!(gone.to_lowercase().contains("cannot help"), "Retry darf nicht angeboten werden");

        let gated = http_error_message(403, "flux1-dev.safetensors");
        assert!(gated.contains("(HTTP 403)"));
        assert!(gated.to_lowercase().contains("login"));
        assert!(gated.to_lowercase().contains("cannot help"));

        // Voruebergehendes darf weiterhin zum Wiederholen einladen.
        let busy = http_error_message(429, "m.gguf");
        assert!(busy.contains("(HTTP 429)"));
        assert!(!busy.to_lowercase().contains("cannot help"));
        let server = http_error_message(503, "m.gguf");
        assert!(server.contains("(HTTP 503)"));
        assert!(!server.to_lowercase().contains("cannot help"));
    }

    /// Der Bundle-Fall: vier Dateien starten gleichzeitig und pruefen jede fuer
    /// sich gegen dieselben freien Bytes.
    #[test]
    fn what_is_still_owed_counts_as_taken() {
        let mut map: HashMap<String, DownloadProgress> = HashMap::new();
        let mut add = |id: &str, status: &str, progress: u64, total: u64| {
            map.insert(
                id.to_string(),
                DownloadProgress {
                    progress,
                    total,
                    speed: 0.0,
                    filename: id.into(),
                    status: status.into(),
                    error: None,
                    dest: format!("/models/{id}"),
                },
            );
        };
        add("a.safetensors", "downloading", 1_000_000_000, 6_000_000_000);
        add("b.safetensors", "connecting", 0, 4_000_000_000);
        // Erledigtes und Fehlgeschlagenes schuldet nichts mehr.
        add("c.safetensors", "complete", 2_000_000_000, 2_000_000_000);
        add("d.safetensors", "error", 500_000_000, 3_000_000_000);

        assert_eq!(reserved_bytes(&map), 5_000_000_000 + 4_000_000_000);

        // Und daraus folgt die Absage, die die Einzelpruefung nie gegeben haette:
        // 12 GB frei, 9 GB schon versprochen, 8 GB neu angefragt.
        assert!(space_shortfall(8_000_000_000 + reserved_bytes(&map), 0, Some(12_000_000_000)).is_some());
        // Ohne Anrechnung des Laufenden waere derselbe Start durchgegangen.
        assert!(space_shortfall(8_000_000_000, 0, Some(12_000_000_000)).is_none());
    }

    /// Nach einem Neustart weiss nur noch die Platte, was unterwegs war.
    #[test]
    fn the_disk_still_knows_what_was_in_flight() {
        let root = tempfile::tempdir().unwrap();
        let vae = root.path().join("models").join("vae");
        std::fs::create_dir_all(&vae).unwrap();
        std::fs::write(vae.join("wan_2.1_vae.download"), vec![0u8; 4096]).unwrap();
        // Fertige Dateien und Rauschen gehen niemanden etwas an.
        std::fs::write(vae.join("done.safetensors"), b"x").unwrap();
        let noise = root.path().join("models").join("__pycache__");
        std::fs::create_dir_all(&noise).unwrap();
        std::fs::write(noise.join("cached.download"), b"x").unwrap();
        // Ein laufender Transfer ist kein Waisenkind.
        let unet = root.path().join("models").join("diffusion_models");
        std::fs::create_dir_all(&unet).unwrap();
        std::fs::write(unet.join("running.download"), vec![0u8; 8192]).unwrap();

        let found = scan_for_partials(
            vec![root.path().join("models")],
            vec![file_stem_of("running.gguf")],
        );

        assert_eq!(found.len(), 1, "gefunden: {:?}", found.iter().map(|o| &o.path).collect::<Vec<_>>());
        assert_eq!(found[0].stem, "wan_2.1_vae");
        assert_eq!(found[0].bytes, 4096);
        assert!(found[0].dir.ends_with("vae"), "der destDir muss mitkommen");
    }

    /// Wiederholen und Abbrechen sind zwei Wege, und nur einer raeumt auf.
    #[test]
    fn only_the_cancel_path_touches_the_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.safetensors");
        // Wie in do_download: with_extension ersetzt die Endung.
        let part = dest.with_extension("download");
        std::fs::write(&part, b"36 GB, sozusagen").unwrap();

        // Ein fehlgeschlagener oder pausierter Eintrag darf aus der Map — das
        // ist alles, was der Retry braucht, und es fasst die Datei nicht an.
        assert!(clearable("error"));
        assert!(clearable("paused"));
        assert!(clearable("complete"));
        assert!(part.exists(), "Buchhaltung loescht keine Nutzdaten");

        // Ein laufender Transfer besitzt seinen Eintrag.
        assert!(!clearable("downloading"));
        assert!(!clearable("connecting"));
        assert!(!clearable("pausing"));

        // Nur der Abbruch raeumt, und dann wirklich.
        assert!(remove_partial(&dest.to_string_lossy()));
        assert!(!part.exists());
        assert!(!remove_partial(""), "ohne Ziel gibt es nichts zu loeschen");
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
