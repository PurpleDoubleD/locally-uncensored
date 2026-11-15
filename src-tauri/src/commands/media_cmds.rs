//! Tauri command wrappers for the in-process MLX media engine (image + video).
//!
//! Thin pass-through to `commands::mlx` / `commands::video`, which were
//! ported verbatim from the bridge daemon (an axum HTTP daemon) and take a
//! single `args: serde_json::Value` blob per call instead of individually
//! named parameters. That matches the existing `shell_task_*` convention in
//! this codebase (see `bg_tasks.rs`'s "Tauri-callable wrappers" section) —
//! every wrapper below takes exactly one `args: Value` parameter, and the
//! frontend MUST invoke with the payload nested as `{ args: {...} }` (see
//! `src/api/agents/bg-tasks.ts` for the precedent and its "missing required
//! key args" warning). `src/api/mlx-image.ts` / `src/api/mlx-video.ts` do
//! this via a small `invokeMedia` helper.
//!
//! No separate lu-bridge daemon: the app spawns its own MLX Python sidecar
//! (server.py on 127.0.0.1:47712) directly from `commands::mlx`, exactly
//! like the existing ComfyUI/whisper sidecars.

use crate::os_error;
use crate::state::AppState;
use base64::Engine;
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

/// Run a media command on the blocking pool and not on the main thread.
///
/// A plain `#[tauri::command] fn` runs on the thread that draws the window,
/// one after the other. `video_status` once spent five seconds there importing
/// MLX, and for those five seconds no install started, no Stop was heard and
/// no progress poll came back: every other command of this file stood in line
/// behind it (owner's finding on the M5 Pro, 08.10.2026). None of them is slow
/// any more, and none of them can do that to the others again.
///
/// `spawn_blocking` and not `#[tauri::command(async)]`: the commands walk
/// folders, spawn processes and take std mutexes, which belongs on the
/// blocking pool and not on an async worker.
///
/// `video_generate` stays where it was. It checks that no generation runs and
/// only later records the one it started, and the main thread is what keeps
/// two clicks from getting between those two steps.
async fn off_main(
    app: AppHandle,
    args: Value,
    command: fn(&AppState, &Value) -> Result<Value, String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || command(app.state::<AppState>().inner(), &args))
        .await
        .map_err(|e| format!("The command did not run to its end: {e}"))?
}

/// The commands of a lane that change what is on disk, one after the other:
/// set up the engine, download a model, remove a model.
///
/// On the main thread they could not meet, and each was written for that.
/// Remove asks whether an install runs and then deletes the model's folder
/// and the hub's chunk cache, which takes seconds for many gigabytes. Get
/// asks whether the engine is being set up and then claims its own slot.
/// Side by side, a Get that comes while a Remove still deletes writes into
/// the cache that is being emptied under it, and an engine setup and a model
/// download started in the same moment each read the other's slot as free
/// and run pip in one venv (Fehlerkontrolle 3, 08.10.2026).
///
/// The lane is held while the command runs, not while the install does: an
/// install answers at once and goes on in a thread of its own. A Stop and a
/// status poll do not take it, so both are heard while a Remove deletes.
static IMAGE_LANE: std::sync::Mutex<()> = std::sync::Mutex::new(());
static VIDEO_LANE: std::sync::Mutex<()> = std::sync::Mutex::new(());
static MUSIC_LANE: std::sync::Mutex<()> = std::sync::Mutex::new(());
static MESH3D_LANE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Run `work` when no other command holds `lane`.
fn in_turn<T>(lane: &std::sync::Mutex<()>, work: impl FnOnce() -> T) -> T {
    // A command that panicked has left nothing in the lock to protect.
    let _turn = lane.lock().unwrap_or_else(|e| e.into_inner());
    work()
}

/// Run `work` in `lane` when the lane is free right now, and say `busy`
/// when it is not. For a command on the main thread, which must not wait
/// there for a Remove that deletes for seconds.
fn in_turn_or<T>(lane: &std::sync::Mutex<()>, busy: &str, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _turn = match lane.try_lock() {
        Ok(turn) => turn,
        // A command that panicked has left nothing in the lock to protect.
        Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => return Err(busy.to_string()),
    };
    work()
}

/// `off_main`, in the turn of its lane.
async fn off_main_in_turn(
    app: AppHandle,
    args: Value,
    lane: &'static std::sync::Mutex<()>,
    command: fn(&AppState, &Value) -> Result<Value, String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || in_turn(lane, || command(app.state::<AppState>().inner(), &args)))
        .await
        .map_err(|e| format!("The command did not run to its end: {e}"))?
}

// ── MLX image (MLX-Stable-Diffusion) ────────────────────────────────────

#[tauri::command]
pub async fn mlx_status(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::mlx_status(state.inner(), &args).await
}

#[tauri::command]
pub async fn mlx_start(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mlx::mlx_start).await
}

#[tauri::command]
pub async fn mlx_unload(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::mlx_unload(state.inner(), &args).await
}

#[tauri::command]
pub async fn mlx_generate(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::mlx_generate(state.inner(), &args).await
}

/// Rewrite a prompt with the Qwen-Image 2.1 prompt enhancer. Long like an
/// image, and like `mlx_generate` it waits on an async worker.
#[tauri::command]
pub async fn mlx_enhance_prompt(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::mlx_enhance_prompt(state.inner(), &args).await
}

// Enhance Image on a Mac: SeedVR2 on the second engine
// (`commands::mlx::mlx_upscale`). Async like `mlx_generate`: it waits for
// the engine's process and never holds the main thread.
#[tauri::command]
pub async fn mlx_upscale(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::mlx_upscale(state.inner(), &args).await
}

#[tauri::command]
pub async fn mlx_generate_progress(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mlx::mlx_generate_progress).await
}

#[tauri::command]
pub async fn mlx_generate_cancel(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mlx::mlx_generate_cancel).await
}

// The LoRA folder of the Mac's image engine (`commands::mlx_loras`).

#[tauri::command]
pub async fn mlx_loras(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mlx_loras::mlx_loras).await
}

#[tauri::command]
pub async fn mlx_loras_open_folder(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mlx_loras::mlx_loras_open_folder).await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn mlx_lora_delete(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mlx_loras::mlx_lora_delete).await
}

// Delete in the gallery: one render of the Mac's engines goes to the Trash
// (`commands::mlx_outputs`).

#[cfg(desktop)]
#[tauri::command]
pub async fn mlx_output_trash(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mlx_outputs::mlx_output_trash).await
}

// Remove Background on a Mac, through Vision (`commands::mlx_cutout`).

#[tauri::command]
pub async fn mlx_cutout(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mlx_cutout::mlx_cutout).await
}

#[tauri::command]
pub async fn mlx_image_models(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mlx::mlx_image_models).await
}

#[tauri::command]
pub fn set_hf_token(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::set_hf_token(state.inner(), &args)
}

#[tauri::command]
pub fn hf_token_present(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::hf_token_present(state.inner(), &args)
}

#[tauri::command]
pub async fn mlx_image_install_model(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main_in_turn(app, args, &IMAGE_LANE, crate::commands::mlx::mlx_image_install_model).await
}

#[tauri::command]
pub async fn mlx_image_install_status(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mlx::mlx_image_install_status).await
}

#[tauri::command]
pub async fn mlx_image_cancel_install(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mlx::mlx_image_cancel_install).await
}

#[tauri::command]
pub async fn mlx_image_delete_model(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main_in_turn(app, args, &IMAGE_LANE, crate::commands::mlx::mlx_image_delete_model).await
}

#[tauri::command]
pub async fn install_mlx_diffusion(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main_in_turn(app, args, &IMAGE_LANE, crate::commands::mlx::install_mlx_diffusion).await
}

#[tauri::command]
pub async fn install_mlx_diffusion_status(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mlx::install_mlx_diffusion_status).await
}

// ── MLX video ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn video_status(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::video::video_status).await
}

#[tauri::command]
pub async fn video_list_models(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::video::video_list_models).await
}

#[tauri::command]
pub async fn video_install_mlx(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main_in_turn(app, args, &VIDEO_LANE, crate::commands::video::video_install_mlx).await
}

#[tauri::command]
pub async fn video_install_mlx_status(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::video::video_install_mlx_status).await
}

#[tauri::command]
pub async fn video_install_model(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main_in_turn(app, args, &VIDEO_LANE, crate::commands::video::video_install_model).await
}

#[tauri::command]
pub async fn video_install_model_status(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::video::video_install_model_status).await
}

#[tauri::command]
pub async fn video_cancel_model_install(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::video::video_cancel_model_install).await
}

#[tauri::command]
pub async fn video_delete_model(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main_in_turn(app, args, &VIDEO_LANE, crate::commands::video::video_delete_model).await
}

/// In the turn of the video lane, without waiting for it: Generate looks
/// whether a video runs and records its own only after the process is up,
/// and Remove looks at that record before it deletes. Each could pass the
/// other's look (Fehlerkontrolle Mac 3, Fund 7). A Remove that is deleting
/// holds the lane, and a Generate in that time is told so.
#[tauri::command]
pub fn video_generate(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    in_turn_or(&VIDEO_LANE, VIDEO_LANE_BUSY, || crate::commands::video::video_generate(state.inner(), &args))
}

const VIDEO_LANE_BUSY: &str = "A video model is being installed or removed right now. Try again in a moment.";

#[tauri::command]
pub async fn video_progress(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::video::video_progress).await
}

#[tauri::command]
pub async fn video_cancel(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::video::video_cancel).await
}

// ── Music on the Mac (ACE-Step 1.5) ──────────────────────────────────────

#[tauri::command]
pub async fn mlx_music_status(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::music::music_status).await
}

#[tauri::command]
pub async fn mlx_music_install(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main_in_turn(app, args, &MUSIC_LANE, crate::commands::music::music_install).await
}

#[tauri::command]
pub async fn mlx_music_install_status(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::music::music_install_status).await
}

#[tauri::command]
pub async fn mlx_music_cancel_install(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::music::music_cancel_install).await
}

#[tauri::command]
pub async fn mlx_music_delete(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main_in_turn(app, args, &MUSIC_LANE, crate::commands::music::music_delete).await
}

/// Async like `mlx_generate`: it waits for the image engine to let go of its
/// model before the track starts. Its claim on the one run is taken before
/// that wait, so two clicks cannot both get through.
#[tauri::command]
pub async fn mlx_music_generate(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::music::music_generate(state.inner(), &args).await
}

#[tauri::command]
pub async fn mlx_music_progress(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::music::music_progress).await
}

#[tauri::command]
pub async fn mlx_music_cancel(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::music::music_cancel).await
}

// ── 3D on the Mac (TripoSR) ──────────────────────────────────────────────

#[tauri::command]
pub async fn mlx_mesh3d_status(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mesh3d::mesh3d_status).await
}

#[tauri::command]
pub async fn mlx_mesh3d_install(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main_in_turn(app, args, &MESH3D_LANE, crate::commands::mesh3d::mesh3d_install).await
}

#[tauri::command]
pub async fn mlx_mesh3d_install_status(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mesh3d::mesh3d_install_status).await
}

#[tauri::command]
pub async fn mlx_mesh3d_cancel_install(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mesh3d::mesh3d_cancel_install).await
}

#[tauri::command]
pub async fn mlx_mesh3d_delete(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main_in_turn(app, args, &MESH3D_LANE, crate::commands::mesh3d::mesh3d_delete).await
}

/// Async like `mlx_music_generate`: it waits for the image engine to let go
/// of its model before the run starts, with its claim taken before that.
#[tauri::command]
pub async fn mlx_mesh3d_generate(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mesh3d::mesh3d_generate(state.inner(), &args).await
}

#[tauri::command]
pub async fn mlx_mesh3d_progress(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mesh3d::mesh3d_progress).await
}

#[tauri::command]
pub async fn mlx_mesh3d_cancel(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mesh3d::mesh3d_cancel).await
}

// ── Character training on the Mac (mflux-train) ─────────────────────────

#[tauri::command]
pub async fn mlx_train_status(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mlx::train::train_status).await
}

#[tauri::command]
pub async fn mlx_train_stage(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mlx::train::train_stage).await
}

#[tauri::command]
pub async fn mlx_train_clear(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mlx::train::train_clear).await
}

/// Async like `mlx_music_generate`: it waits for the image engine to let go
/// of its model before the run starts, with its claim taken before that.
#[tauri::command]
pub async fn mlx_train_start(state: State<'_, AppState>, args: Value) -> Result<Value, String> {
    crate::commands::mlx::train::train_start(state.inner(), &args).await
}

#[tauri::command]
pub async fn mlx_train_progress(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mlx::train::train_progress).await
}

#[tauri::command]
pub async fn mlx_train_cancel(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, crate::commands::mlx::train::train_cancel).await
}

// ── Media playback (video → blob URL) ───────────────────────────────────
//
// MLX video never touches the sidecar HTTP surface the image path uses
// (`mlx_generate` proxies to :47712 and returns base64 straight from the
// response body) — `video_generate` runs `mlx_video.*.generate` as a bare
// subprocess and writes an mp4 to disk (`commands::video::outputs_root()`).
// With the lu-bridge daemon gone there is nothing serving that file at
// :47711/videos/<file> anymore, and the CSP's `media-src` has no `file:`
// grant (only `'self' blob: http://localhost:* http://127.0.0.1:*`), so a
// `<video src="file:///...">` would just be blocked. Read the bytes here
// and let the frontend build a `blob:` URL instead — that's an origin the
// CSP already allows.

/// Roots `read_media_file` is allowed to serve bytes from. Only MLX video
/// output today (MLX images are never written to disk — see above); add
/// more roots here if a future in-process media backend gains one.
fn allowed_media_roots() -> Vec<PathBuf> {
    vec![
        crate::commands::video::outputs_root(),
        // Stills from the MLX image lane. They land on disk so the gallery
        // survives a restart — the in-memory data URL does not (createStore's
        // partialize strips it), and without a file there was nothing left to
        // re-read.
        crate::commands::mlx::images_root(),
        // Tracks of the music lane (commands/music.rs).
        crate::commands::music::outputs_root(),
        // Models of the 3D lane (commands/mesh3d.rs), read by the viewer.
        crate::commands::mesh3d::outputs_root(),
    ]
}

/// Read a file from one of the app's own media output directories and
/// return its bytes as base64, so the frontend can turn it into a
/// `Blob`/`URL.createObjectURL` blob: URL for `<video>` playback and
/// Download.
///
/// Path-traversal guard: canonicalizes both `path` and every allowed root
/// (resolving `..` and symlinks) and rejects anything whose canonical form
/// doesn't fall under an allowed root — this is NOT a general-purpose file
/// read, it only ever serves the app's own generated media.
#[tauri::command]
pub fn read_media_file(path: String) -> Result<String, String> {
    let candidate = PathBuf::from(&path);
    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("read_media_file: {}: {e}", candidate.display()))?;

    let allowed = allowed_media_roots().into_iter().any(|root| {
        root.canonicalize()
            .map(|r| canonical.starts_with(&r))
            .unwrap_or(false)
    });
    if !allowed {
        return Err(format!(
            "read_media_file: path escapes the allowed media directories: {}",
            canonical.display()
        ));
    }

    let bytes = std::fs::read(&canonical)
        .map_err(|e| format!("read_media_file: {}: {}", canonical.display(), os_error::english(&e)))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

// ── start images for local video ────────────────────────────────────────
//
// `video_generate` hands the engine a start image as a path on disk, and the
// WebView has no path to give: an image dropped into Create, picked in the
// file dialog or taken from the gallery is bytes in memory. ComfyUI hosts
// stage such an image through `/upload/image`. The Mac has no ComfyUI, so the
// bytes are written here, next to the videos they start.

/// The largest start image this takes. The engines scale it down to the size
/// of the video before anything else, so more would only be a longer wait.
const START_IMAGE_MAX_BYTES: usize = 40 * 1024 * 1024;

/// What the image is, read from its first bytes. The name a file arrives
/// under says nothing reliable, and the engines open it with Pillow, which
/// goes by content as well.
fn start_image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// Write a start image into `dir` and return where it is. The name is the
/// hash of the content, so the same picture is one file however often it is
/// picked, and a file that is already there is left alone.
fn stage_start_image_in(dir: &std::path::Path, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.is_empty() {
        return Err("The start image is empty.".to_string());
    }
    if bytes.len() > START_IMAGE_MAX_BYTES {
        return Err("The start image is larger than 40 MB.".to_string());
    }
    let ext = start_image_ext(bytes).ok_or("The start image is not a PNG, JPG or WebP file.")?;
    stage_by_content(dir, bytes, ext, "start image")
}

/// Write `bytes` into `dir` under the hash of their content, once.
fn stage_by_content(dir: &std::path::Path, bytes: &[u8], ext: &str, what: &str) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    let hash: String = Sha256::digest(bytes).iter().take(16).map(|b| format!("{b:02x}")).collect();
    let path = dir.join(format!("{hash}.{ext}"));
    if path.is_file() {
        return Ok(path);
    }
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Could not create the folder for the {what}: {}", os_error::english(&e)))?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)
        .map_err(|e| format!("Could not write the {what}: {}", os_error::english(&e)))?;
    std::io::Write::write_all(&mut tmp, bytes)
        .map_err(|e| format!("Could not write the {what}: {}", os_error::english(&e)))?;
    tmp.persist(&path)
        .map_err(|e| format!("Could not write the {what}: {}", os_error::english(&e.error)))?;
    Ok(path)
}

// ── motion videos for Motion Control on the Mac ─────────────────────────
//
// The same way as a start image: the clip whose motion a run follows is
// bytes in the WebView, and `video_generate` reads a file.

/// The largest motion video this takes. A run uses five seconds of it at
/// most, so more would only be a longer wait.
const MOTION_VIDEO_MAX_BYTES: usize = 200 * 1024 * 1024;

/// What the clip is, read from its first bytes: MP4 and MOV carry `ftyp`
/// after their first box size, WebM starts with the EBML magic.
fn motion_video_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        Some(if &bytes[8..10] == b"qt" { "mov" } else { "mp4" })
    } else if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        Some("webm")
    } else {
        None
    }
}

pub(crate) fn stage_motion_video_in(dir: &std::path::Path, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.is_empty() {
        return Err("The motion video is empty.".to_string());
    }
    if bytes.len() > MOTION_VIDEO_MAX_BYTES {
        return Err("The motion video is larger than 200 MB. Trim it to a few seconds.".to_string());
    }
    let ext = motion_video_ext(bytes).ok_or("The motion video is not an MP4, MOV or WebM file.")?;
    stage_by_content(dir, bytes, ext, "motion video")
}

/// Stage the motion video of a Motion Control run and answer with its path.
/// `args.data` is the clip as base64, without a `data:` prefix.
#[tauri::command]
pub async fn video_stage_motion_video(app: AppHandle, args: Value) -> Result<Value, String> {
    off_main(app, args, |_state, args| {
        let data = args.get("data").and_then(Value::as_str).ok_or("video_stage_motion_video: data is missing")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| "The motion video could not be read.".to_string())?;
        let dir = crate::commands::video::outputs_root().join("motion-videos");
        let path = stage_motion_video_in(&dir, &bytes)?;
        Ok(serde_json::json!({ "path": path.to_string_lossy() }))
    })
    .await
}

/// Stage a start image for `video_generate` and answer with its path.
/// `args.data` is the image as base64, without a `data:` prefix.
#[tauri::command]
pub fn video_stage_start_image(args: Value) -> Result<Value, String> {
    let data = args.get("data").and_then(Value::as_str).ok_or("video_stage_start_image: data is missing")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "The start image could not be read.".to_string())?;
    let dir = crate::commands::video::outputs_root().join("start-images");
    let path = stage_start_image_in(&dir, &bytes)?;
    Ok(serde_json::json!({ "path": path.to_string_lossy() }))
}

// ── The voice of a Talking Character ─────────────────────────────────
//
// The speech `video_generate` turns into a talking clip (`audio`) is a file
// for the engine as well, and a voice picked in the WebView is bytes in
// memory just as a start image is. It is written beside the videos the same
// way, under the hash of its content.

/// The largest voice this takes: about four minutes of WAV, far more than the
/// ten seconds a clip uses.
const VOICE_MAX_BYTES: usize = 50 * 1024 * 1024;

/// What the audio is, read from its first bytes. The engine opens it with
/// ffmpeg, which goes by content too.
fn voice_ext(bytes: &[u8]) -> Option<&'static str> {
    let tag = |at: usize, what: &[u8]| bytes.len() >= at + what.len() && &bytes[at..at + what.len()] == what;
    if tag(0, b"RIFF") && tag(8, b"WAVE") {
        Some("wav")
    } else if tag(0, b"FORM") && (tag(8, b"AIFF") || tag(8, b"AIFC")) {
        Some("aiff")
    } else if tag(0, b"ID3") || (bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0) {
        Some("mp3")
    } else if tag(4, b"ftyp") {
        Some("m4a")
    } else if tag(0, b"fLaC") {
        Some("flac")
    } else if tag(0, b"OggS") {
        Some("ogg")
    } else {
        None
    }
}

/// Write a voice into `dir` and return where it is, as `stage_start_image_in`
/// does for a picture.
fn stage_voice_in(dir: &std::path::Path, bytes: &[u8]) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    if bytes.is_empty() {
        return Err("The voice file is empty.".to_string());
    }
    if bytes.len() > VOICE_MAX_BYTES {
        return Err("The voice file is larger than 50 MB. Use a shorter clip of speech.".to_string());
    }
    let ext = voice_ext(bytes).ok_or("The voice is not a WAV, MP3, M4A, AIFF, FLAC or OGG file.")?;
    let hash: String = Sha256::digest(bytes).iter().take(16).map(|b| format!("{b:02x}")).collect();
    let path = dir.join(format!("{hash}.{ext}"));
    if path.is_file() {
        return Ok(path);
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create the folder for voices: {}", os_error::english(&e)))?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| format!("Could not write the voice: {}", os_error::english(&e)))?;
    std::io::Write::write_all(&mut tmp, bytes).map_err(|e| format!("Could not write the voice: {}", os_error::english(&e)))?;
    tmp.persist(&path).map_err(|e| format!("Could not write the voice: {}", os_error::english(&e.error)))?;
    Ok(path)
}

/// Stage the voice of a Talking Character run and answer with its path.
/// `args.data` is the audio as base64, without a `data:` prefix.
#[tauri::command]
pub fn video_stage_voice(args: Value) -> Result<Value, String> {
    let data = args.get("data").and_then(Value::as_str).ok_or("video_stage_voice: data is missing")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "The voice could not be read.".to_string())?;
    let dir = crate::commands::video::outputs_root().join("voices");
    let path = stage_voice_in(&dir, &bytes)?;
    Ok(serde_json::json!({ "path": path.to_string_lossy() }))
}

#[cfg(test)]
mod voice_tests {
    use super::*;

    #[test]
    fn a_voice_lands_on_disk_once_under_the_name_of_its_content() {
        let dir = tempfile::tempdir().unwrap();
        let wav = b"RIFF\x24\0\0\0WAVEfmt rest of the speech";
        let first = stage_voice_in(dir.path(), wav).unwrap();
        assert_eq!(first.extension().unwrap(), "wav");
        assert_eq!(std::fs::read(&first).unwrap(), wav);
        assert_eq!(stage_voice_in(dir.path(), wav).unwrap(), first);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn the_kind_of_a_voice_is_read_from_its_first_bytes() {
        assert_eq!(voice_ext(b"RIFF\0\0\0\0WAVEfmt "), Some("wav"));
        assert_eq!(voice_ext(b"FORM\0\0\0\0AIFFCOMM"), Some("aiff"));
        assert_eq!(voice_ext(b"FORM\0\0\0\0AIFCFVER"), Some("aiff"));
        assert_eq!(voice_ext(b"ID3\x04\0\0"), Some("mp3"));
        assert_eq!(voice_ext(&[0xFF, 0xFB, 0x90, 0x00]), Some("mp3"));
        assert_eq!(voice_ext(b"\0\0\0\x20ftypM4A "), Some("m4a"));
        assert_eq!(voice_ext(b"fLaC\0\0\0\x22"), Some("flac"));
        assert_eq!(voice_ext(b"OggS\0\x02"), Some("ogg"));
        // A RIFF that is no wave, a picture, a script.
        assert_eq!(voice_ext(b"RIFF\0\0\0\0WEBPVP8 "), None);
        assert_eq!(voice_ext(b"\x89PNG\r\n\x1a\n"), None);
        assert_eq!(voice_ext(b"#!/bin/sh\n"), None);
    }

    #[test]
    fn what_is_not_a_voice_is_turned_away_before_anything_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("voices");
        assert!(stage_voice_in(&target, b"").unwrap_err().contains("empty"));
        assert!(stage_voice_in(&target, b"#!/bin/sh\nrm -rf ~").unwrap_err().contains("WAV, MP3"));
        assert!(stage_voice_in(&target, &vec![0u8; VOICE_MAX_BYTES + 1]).unwrap_err().contains("50 MB"));
        assert!(!target.exists());
    }
}

#[cfg(test)]
mod start_image_tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest of a picture";

    #[test]
    fn a_start_image_lands_on_disk_once_under_the_name_of_its_content() {
        let dir = tempfile::tempdir().unwrap();
        let first = stage_start_image_in(dir.path(), PNG).unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), PNG);
        assert_eq!(first.extension().unwrap(), "png");
        // The same picture again is the same file, and nothing else is left
        // in the folder: no second copy, no temp file.
        let second = stage_start_image_in(dir.path(), PNG).unwrap();
        assert_eq!(first, second);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        // Another picture is another file.
        let jpg = stage_start_image_in(dir.path(), &[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]).unwrap();
        assert_eq!(jpg.extension().unwrap(), "jpg");
        assert_ne!(first, jpg);
    }

    #[test]
    fn a_motion_video_is_staged_by_its_content_and_anything_else_is_turned_away() {
        let dir = tempfile::tempdir().unwrap();
        let mp4 = b"\0\0\0\x18ftypisom\0\0\0\0rest of a clip";
        let first = stage_motion_video_in(dir.path(), mp4).unwrap();
        assert_eq!(first.extension().unwrap(), "mp4");
        assert_eq!(stage_motion_video_in(dir.path(), mp4).unwrap(), first);
        assert_eq!(motion_video_ext(b"\0\0\0\x14ftypqt  \0\0"), Some("mov"));
        assert_eq!(motion_video_ext(&[0x1A, 0x45, 0xDF, 0xA3, 1, 2]), Some("webm"));
        let target = dir.path().join("motion-videos");
        assert!(stage_motion_video_in(&target, b"").unwrap_err().contains("empty"));
        assert!(stage_motion_video_in(&target, PNG).unwrap_err().contains("MP4, MOV or WebM"));
        assert!(stage_motion_video_in(&target, &vec![0u8; MOTION_VIDEO_MAX_BYTES + 1]).unwrap_err().contains("200 MB"));
        assert!(!target.exists());
    }

    #[test]
    fn what_is_not_an_image_is_turned_away_before_anything_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("start-images");
        assert!(stage_start_image_in(&target, b"").unwrap_err().contains("empty"));
        assert!(stage_start_image_in(&target, b"#!/bin/sh\nrm -rf ~").unwrap_err().contains("PNG, JPG or WebP"));
        assert!(stage_start_image_in(&target, &vec![0u8; START_IMAGE_MAX_BYTES + 1]).unwrap_err().contains("40 MB"));
        assert!(!target.exists());
        assert_eq!(start_image_ext(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
    }
}

#[cfg(test)]
mod off_main_tests {
    /// The wrappers that may run on the main thread, each with its reason.
    const ON_MAIN: &[(&str, &str)] = &[
        ("set_hf_token", "writes one string into memory"),
        ("hf_token_present", "reads one flag out of memory"),
        ("video_generate", "its check and its claim must not be interleaved"),
        ("read_media_file", "playback, with a path for an argument and not this file's one shape"),
        ("video_stage_start_image", "is handed the bytes and writes one file"),
        ("video_stage_voice", "is handed the bytes and writes one file"),
    ];

    #[test]
    fn no_media_command_waits_on_the_thread_that_draws_the_window() {
        let source = include_str!("media_cmds.rs");
        let production = &source[..source.find("#[cfg(test)]").unwrap()];
        let mut seen = 0;
        for part in production.split("#[tauri::command]\n").skip(1) {
            let head = part.lines().next().unwrap();
            let name = head.split("fn ").nth(1).unwrap().split('(').next().unwrap();
            seen += 1;
            if head.starts_with("pub async fn ") {
                continue;
            }
            assert!(
                ON_MAIN.iter().any(|(allowed, _)| *allowed == name),
                "{name} is a plain command and so runs on the main thread, where it holds up every other one. Hand it to off_main, or name the reason here."
            );
        }
        assert!(seen >= 25, "the wrappers were not found, the test looked at nothing");
        // The status and list commands in particular, by name.
        for polled in ["video_status", "video_list_models", "mlx_image_models", "mlx_image_install_status",
            "install_mlx_diffusion_status", "video_install_mlx_status", "video_install_model_status", "video_progress",
            "mlx_generate_progress", "mlx_image_cancel_install", "video_cancel_model_install",
            "mlx_loras", "mlx_loras_open_folder", "mlx_lora_delete", "mlx_output_trash", "mlx_cutout"] {
            assert!(
                production.contains(&format!("pub async fn {polled}(app: AppHandle, args: Value) -> Result<Value, String> {{\n    off_main(app, args, ")),
                "{polled} no longer goes through off_main"
            );
        }
    }

    #[test]
    fn two_commands_of_one_lane_never_run_at_the_same_time() {
        use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
        static LANE: std::sync::Mutex<()> = std::sync::Mutex::new(());
        static OTHER: std::sync::Mutex<()> = std::sync::Mutex::new(());
        static INSIDE: AtomicUsize = AtomicUsize::new(0);
        static MOST: AtomicUsize = AtomicUsize::new(0);
        let workers: Vec<_> = (0..8)
            .map(|_| {
                std::thread::spawn(|| {
                    super::in_turn(&LANE, || {
                        MOST.fetch_max(INSIDE.fetch_add(1, SeqCst) + 1, SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(15));
                        INSIDE.fetch_sub(1, SeqCst);
                    })
                })
            })
            .collect();
        for w in workers {
            w.join().unwrap();
        }
        assert_eq!(MOST.load(SeqCst), 1);
        // The other lane is not held up: a video Remove does not wait for an
        // image download to start.
        super::in_turn(&LANE, || {
            let free = std::thread::spawn(|| super::in_turn(&OTHER, || 7)).join().unwrap();
            assert_eq!(free, 7);
        });
        // A command that panicked does not close the lane for good.
        let _ = std::thread::spawn(|| super::in_turn(&LANE, || panic!("a command died"))).join();
        assert_eq!(super::in_turn(&LANE, || 1), 1);
    }

    /// Fehlerkontrolle Mac 3, Fund 7. Generate ran beside a Remove: the one
    /// on the main thread, the other on the pool.
    #[test]
    fn a_video_is_not_started_while_a_remove_holds_the_lane() {
        static LANE: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let ran = std::sync::atomic::AtomicBool::new(false);
        let start = || {
            super::in_turn_or(&LANE, "busy", || {
                ran.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(1)
            })
        };
        let refused = super::in_turn(&LANE, || std::thread::scope(|s| s.spawn(start).join().unwrap()));
        assert_eq!(refused, Err("busy".to_string()));
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst), "the video started beside the Remove");
        assert_eq!(start(), Ok(1), "a free lane lets it through");
        // And while it starts, a Remove waits for it.
        let order = std::sync::Mutex::new(Vec::new());
        std::thread::scope(|s| {
            let _ = super::in_turn_or(&LANE, "busy", || {
                let remove = s.spawn(|| super::in_turn(&LANE, || order.lock().unwrap().push("remove")));
                std::thread::sleep(std::time::Duration::from_millis(40));
                order.lock().unwrap().push("generate");
                Ok(remove)
            });
        });
        assert_eq!(*order.lock().unwrap(), ["generate", "remove"]);
        let source = include_str!("media_cmds.rs");
        let production = &source[..source.find("#[cfg(test)]").unwrap()];
        assert!(production.contains("in_turn_or(&VIDEO_LANE, VIDEO_LANE_BUSY, || crate::commands::video::video_generate(state.inner(), &args))"));
    }

    /// Fehlerkontrolle 3, 08.10.2026. On the main thread these six ran one
    /// after the other, and each of them was written for that: Remove asks
    /// "is an install running?" and then deletes the folder and the hub's
    /// chunk cache, Get asks "is the engine being set up?" and then claims
    /// its own slot. Side by side, a Get that arrives while a Remove is still
    /// deleting downloads into the cache that is being emptied under it, and
    /// an engine setup and a model download that start in the same moment
    /// each read the other's slot as free and run pip in one venv.
    #[test]
    fn the_commands_that_change_a_lane_on_disk_take_their_turn() {
        let source = include_str!("media_cmds.rs");
        let production = &source[..source.find("#[cfg(test)]").unwrap()];
        for (lane, commands) in [
            ("IMAGE_LANE", ["install_mlx_diffusion", "mlx_image_install_model", "mlx_image_delete_model"]),
            ("VIDEO_LANE", ["video_install_mlx", "video_install_model", "video_delete_model"]),
        ] {
            for name in commands {
                assert!(
                    production.contains(&format!(
                        "pub async fn {name}(app: AppHandle, args: Value) -> Result<Value, String> {{\n    off_main_in_turn(app, args, &{lane}, "
                    )),
                    "{name} runs beside the other commands that write the same folders"
                );
            }
        }
        // A Stop and a status poll wait for nobody: a Remove of many
        // gigabytes holds the lane for as long as it deletes.
        for name in ["mlx_image_cancel_install", "video_cancel_model_install", "mlx_image_install_status", "video_install_model_status", "mlx_generate_cancel", "video_cancel"] {
            assert!(
                production.contains(&format!("pub async fn {name}(app: AppHandle, args: Value) -> Result<Value, String> {{\n    off_main(app, args, ")),
                "{name} waits behind an install or a Remove"
            );
        }
    }

}
