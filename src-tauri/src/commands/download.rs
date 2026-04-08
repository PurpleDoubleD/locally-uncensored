use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use futures_util::StreamExt;
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::state::{AppState, DownloadProgress};

fn models_dir(comfy_path: &Option<String>, subfolder: &str) -> Result<PathBuf, String> {
    let base = comfy_path.as_ref().ok_or("ComfyUI path not set. Please set it in settings or install ComfyUI first.")?;
    // Subfolders starting with "custom_nodes/" are relative to ComfyUI root, not models/
    let dir = if subfolder.starts_with("custom_nodes/") || subfolder.starts_with("custom_nodes\\") {
        PathBuf::from(base).join(subfolder)
    } else {
        PathBuf::from(base).join("models").join(subfolder)
    };
    fs::create_dir_all(&dir).map_err(|e| format!("Create models dir: {}", e))?;
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
    let dest_file = dest_dir.join(&filename);

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

    // Create cancellation token
    let token = CancellationToken::new();
    {
        let mut tokens = state.download_tokens.lock().unwrap();
        tokens.insert(id.clone(), token.clone());
    }

    // Initialize progress
    {
        let mut downloads = state.downloads.lock().unwrap();
        downloads.insert(id.clone(), DownloadProgress {
            progress: resume_offset,
            total: 0,
            speed: 0.0,
            filename: filename.clone(),
            status: "connecting".to_string(),
            error: None,
        });
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

async fn do_download(
    url: &str,
    dest: &PathBuf,
    downloads: &Arc<Mutex<HashMap<String, DownloadProgress>>>,
    id: &str,
    token: CancellationToken,
    resume_offset: u64,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/1.5")
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(7200))
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = client.get(url);

    // Resume support: request only remaining bytes
    if resume_offset > 0 {
        request = request.header("Range", format!("bytes={}-", resume_offset));
        println!("[Download] Resuming from byte {}", resume_offset);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() && status.as_u16() != 206 {
        return Err(format!("HTTP {}", status));
    }

    // For resumed downloads, total = content_length + offset
    let content_length = response.content_length().unwrap_or(0);
    let total = if resume_offset > 0 && status.as_u16() == 206 {
        content_length + resume_offset
    } else {
        content_length
    };

    // Update total size
    if let Ok(mut dl) = downloads.lock() {
        if let Some(p) = dl.get_mut(id) {
            p.total = total;
            p.status = "downloading".to_string();
        }
    }

    let tmp_path = dest.with_extension("download");

    // Open file for writing (append if resuming)
    let mut file = if resume_offset > 0 && status.as_u16() == 206 {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&tmp_path)
            .await
            .map_err(|e| format!("Open file for resume: {}", e))?
    } else {
        tokio::fs::File::create(&tmp_path)
            .await
            .map_err(|e| format!("Create file: {}", e))?
    };

    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = resume_offset;
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
                        file.write_all(&bytes).await.map_err(|e| format!("Write: {}", e))?;
                        downloaded += bytes.len() as u64;

                        // Update progress every 500ms
                        if last_update.elapsed().as_millis() > 500 {
                            last_update = Instant::now();
                            let elapsed = start.elapsed().as_secs_f64();
                            let speed = if elapsed > 0.0 {
                                (downloaded - resume_offset) as f64 / elapsed
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

    file.flush().await.map_err(|e| format!("Flush: {}", e))?;
    drop(file);

    tokio::fs::rename(&tmp_path, dest)
        .await
        .map_err(|e| format!("Rename: {}", e))?;

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

    // If paused (no active token), clean up directly
    let was_paused = if let Ok(dl) = state.downloads.lock() {
        dl.get(&id).map(|p| p.status == "paused").unwrap_or(false)
    } else {
        false
    };

    if was_paused {
        // Remove from progress
        if let Ok(mut dl) = state.downloads.lock() {
            dl.remove(&id);
        }
        // Delete temp file — need comfy_path to find it
        // The temp file cleanup is best-effort
        if let Ok(comfy_path) = state.comfy_path.lock() {
            if let Some(ref path) = *comfy_path {
                // Try common subfolders
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

    // Create new cancellation token
    let token = CancellationToken::new();
    {
        let mut tokens = state.download_tokens.lock().unwrap();
        tokens.insert(id.clone(), token.clone());
    }

    // Update status
    {
        let mut downloads = state.downloads.lock().unwrap();
        if let Some(p) = downloads.get_mut(&id) {
            p.status = "connecting".to_string();
        } else {
            downloads.insert(id.clone(), DownloadProgress {
                progress: resume_offset,
                total: 0,
                speed: 0.0,
                filename: id.clone(),
                status: "connecting".to_string(),
                error: None,
            });
        }
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

    let candidates: Vec<PathBuf> = match provider_lower.as_str() {
        "lm studio" | "lmstudio" => vec![
            home.join(".cache").join("lm-studio").join("models"),
        ],
        "jan" => vec![
            dirs::data_dir().unwrap_or_else(|| home.clone()).join("Jan").join("data").join("models"),
            home.join("jan").join("models"),
        ],
        "gpt4all" => vec![
            dirs::data_local_dir().unwrap_or_else(|| home.clone()).join("nomic.ai").join("GPT4All"),
        ],
        "localai" => vec![
            home.join(".localai").join("models"),
        ],
        _ => vec![], // vLLM, llama.cpp, etc. — no standard path
    };

    for path in &candidates {
        if path.exists() {
            return Ok(serde_json::json!(path.to_string_lossy()));
        }
    }

    // Fallback: create LU models directory
    let fallback = home.join("locally-uncensored").join("models");
    fs::create_dir_all(&fallback).map_err(|e| format!("Create fallback dir: {}", e))?;
    Ok(serde_json::json!(fallback.to_string_lossy()))
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
    fs::create_dir_all(&dir).map_err(|e| format!("Create dest dir: {}", e))?;
    let dest_file = dir.join(&filename);

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

    let token = CancellationToken::new();
    {
        let mut tokens = state.download_tokens.lock().unwrap();
        tokens.insert(id.clone(), token.clone());
    }
    {
        let mut downloads = state.downloads.lock().unwrap();
        downloads.insert(id.clone(), DownloadProgress {
            progress: resume_offset,
            total: 0,
            speed: 0.0,
            filename: filename.clone(),
            status: "connecting".to_string(),
            error: None,
        });
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
