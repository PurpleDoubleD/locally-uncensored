//! MLX-Stable-Diffusion image provider for macOS (Apple Silicon
//! recommended image stack).
//!
//! Layout under `<os_paths::data_dir()>/mlx/` (macOS: `~/Library/Application
//! Support/<APP_DIR>/mlx/`; der Verzeichnisname kommt aus `app_identity`):
//!   venv/             — dedicated Python venv we own
//!   server.py         — FastAPI sidecar (embedded via include_str!)
//!   requirements.txt  — pip dependencies (embedded via include_str!)
//!   cache/            — HF_HOME for model weights
//!
//! Install flow (`install_mlx_diffusion`):
//!   1. Locate Python ≥ 3.11. Fail with a brew hint if missing.
//!   2. Create the venv if absent.
//!   3. Drop server.py + requirements.txt into mlx root.
//!   4. pip install -r requirements.txt.
//!   5. Pre-pull stabilityai/sd-turbo so the first generate isn't a
//!      surprise 1.4 GB download.
//!
//! Run flow (`mlx_start`): spawn `venv/bin/python server.py` with
//! LU_MLX_PORT and HF_HOME env vars. server.py owns the actual model
//! lifecycle and stays up until the user picks "Quit" from the tray.
//!
//! Generate (`mlx_generate`): proxy a JSON request to 127.0.0.1:47712,
//! return the base64 PNG to the web UI.

use crate::os_error;
use crate::commands::CmdResult;
use crate::state::AppState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

pub const MLX_PORT: u16 = 47712;

/// The second image engine, mflux: quantized packs in native MLX.
#[path = "image_mflux.rs"]
mod mflux;

/// The Qwen-Image 2.1 prompt enhancer, which runs in the place of an image.
#[path = "mlx_enhancer.rs"]
mod enhancer;

/// Character training on the second engine (`mflux-train`).
#[path = "mlx_train.rs"]
pub(crate) mod train;

fn mlx_root() -> PathBuf {
    crate::os_paths::data_dir().join("mlx")
}

fn venv_python() -> PathBuf {
    mlx_root().join("venv/bin/python")
}

/// The HuggingFace token the user stored in Settings, held in memory for the
/// lifetime of the process. `None` until the frontend pushes one.
static HF_TOKEN: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

/// Every HuggingFace download this app makes goes out through here, so the
/// hub credentials are attached the same way in all of them.
///
/// Anonymous hub traffic is rate-limited hard: it does not fail outright, it
/// *crawls*, which reads as a broken app rather than a throttle (a pull
/// measured at 2.6 KB/s was misdiagnosed as a dead network line). Gated repos are out
/// of reach entirely without a token. HF_HOME stays with the caller: the image
/// lane shares one cache, the video lane downloads into per-model directories.
pub(crate) fn apply_hf_token(cmd: &mut Command) {
    if let Some(t) = hf_token() {
        cmd.env("HF_TOKEN", t);
    }
}

/// The stored token, for the one other place that talks to the hub directly:
/// the GGUF downloader in `download.rs`, which sends it as a Bearer header to
/// huggingface.co and nowhere else.
pub(crate) fn hf_token() -> Option<String> {
    HF_TOKEN.read().ok().and_then(|t| t.clone())
}

/// Store the token from Settings. An empty string clears it, because that is
/// how the user removes the token again; it must not be stored as `Some("")`.
pub fn set_hf_token(_state: &AppState, args: &Value) -> CmdResult {
    let token = args
        .get("token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let present = !token.is_empty();
    *HF_TOKEN
        .write()
        .map_err(|_| crate::commands::internal("hf token lock poisoned"))? =
        present.then_some(token);
    Ok(json!({ "ok": true, "present": present }))
}

/// Whether a token is set. Never returns the token itself: the frontend
/// already has it, and nothing else has any business reading it back.
pub fn hf_token_present(_state: &AppState, _args: &Value) -> CmdResult {
    let present = HF_TOKEN.read().ok().and_then(|t| t.clone()).is_some();
    Ok(json!({ "present": present }))
}

fn sidecar_running() -> bool {
    std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{MLX_PORT}").parse().unwrap(),
        std::time::Duration::from_millis(200),
    )
    .is_ok()
}

// ── What this Mac can run ─────────────────────────────────────────────

/// Why this machine cannot run the image engine, or None when it can.
///
/// PyTorch has shipped no Intel macOS wheels since 2.3, so on an Intel Mac the
/// setup built a venv and then died in pip with "No matching distribution
/// found for torch", leaving exactly the half install that read as finished
/// (Fehlerkontrolle Mac, 08.10.2026, Fund 7). The video lane has said so up
/// front for a long time; this is the same answer for images.
fn image_engine_unsupported(os: &str, arch: &str) -> Option<&'static str> {
    if os != "macos" {
        Some("The MLX image engine runs on macOS only.")
    } else if arch != "aarch64" {
        Some("Local image generation needs Apple Silicon. On this Mac, image generation is available in LU Cloud.")
    } else {
        None
    }
}

fn ensure_image_engine_supported() -> Result<(), String> {
    match image_engine_unsupported(std::env::consts::OS, std::env::consts::ARCH) {
        Some(why) => Err(crate::commands::bad_request(why)),
        None => Ok(()),
    }
}

/// The memory this Mac has, in bytes. Zero when it could not be read.
fn total_memory_bytes() -> u64 {
    static TOTAL: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *TOTAL.get_or_init(|| {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        sys.total_memory()
    })
}

/// Refuse a model that needs more memory than the machine has.
///
/// A hard stop and not a warning to click through. The pipeline loads into
/// unified memory in one piece: a 32 GB model on a 16 GB MacBook does not run
/// slowly, it pushes macOS into swap until the whole machine stops answering
/// for minutes, and then the kernel ends the Python process anyway. The user
/// gets nothing out of confirming that, and the only way back is to wait it
/// out or to force the Mac off. `min_ram_gb` is already the floor the catalogue
/// states, not a recommendation, and the tile says the same number.
///
/// Memory that could not be measured (zero) never blocks.
fn memory_verdict(name: &str, min_ram_gb: u32, total_bytes: u64) -> Option<String> {
    if total_bytes == 0 {
        return None;
    }
    // A 16 GB Mac reports 17179869184 bytes; rounding keeps a machine that
    // reports a little under its nominal size on the right side.
    let have = (total_bytes as f64 / 1_073_741_824.0).round() as u32;
    (have < min_ram_gb).then(|| {
        format!(
            "{name} needs a Mac with {min_ram_gb} GB of memory and this Mac has {have} GB. \
             Loading it would fill the memory until the system freezes, so it was not started. \
             Pick a model that fits {have} GB."
        )
    })
}

/// The memory one Enhance run of SeedVR2 3B takes, in GB, for a result of
/// `megapixels`. Measured on an M5 Pro with the engine's low-ram mode
/// (14.10.2026): 11.3 GB for 2048 x 2048, 22.1 GB for 4096 x 4096. The weights
/// and the VAE are the fixed part, the tiles of the result the rest.
fn upscale_peak_gb(megapixels: f64) -> f64 {
    7.75 + 0.854 * megapixels
}

/// Why this Mac cannot enhance to `width` x `height`, or None when it can.
///
/// The model alone fits a 16 GB Mac, the result may not: at 4x a 1024 picture
/// needs about 22 GB, and on a smaller Mac that pushes macOS into swap until
/// the machine stops answering. The share is what macOS lets the graphics
/// side of unified memory use, with some room for the rest of the system.
fn upscale_memory_verdict(width: u32, height: u32, factor: u32, total_bytes: u64) -> Option<String> {
    if total_bytes == 0 {
        return None;
    }
    let have = total_bytes as f64 / 1_073_741_824.0;
    let need = upscale_peak_gb(width as f64 * height as f64 / 1_000_000.0);
    (need > have * 0.7).then(|| {
        let instead = if factor > 2 { "Pick 2x, or enhance a smaller picture." } else { "Enhance a smaller picture." };
        format!(
            "Enhancing to {width}x{height} needs about {} GB of memory and this Mac has {} GB. \
             It was not started, so the system does not freeze. {instead}",
            need.ceil() as u32,
            have.round() as u32
        )
    })
}

/// The memory an edit with `images` pictures takes, in GB. Measured with
/// Qwen-Image 2.1 4-bit at a 1024 canvas on an M5 Pro (15.10.2026): 10.5 GB
/// with the source alone, 17.2 GB with four pictures; ten pushed a 48 GB Mac
/// below a third free before the first step. Every picture is read by the
/// text encoder at the canvas, so it costs by the canvas's area, and a
/// larger pack costs its extra weights.
fn edit_peak_gb(images: usize, side: u32, pack_gb: f64) -> f64 {
    const BASE_4BIT_GB: f64 = 8.25;
    const PACK_4BIT_GB: f64 = 10.6;
    const PER_IMAGE_GB: f64 = 2.23;
    let area = (side as f64 / 1024.0).powi(2);
    BASE_4BIT_GB + (pack_gb - PACK_4BIT_GB).max(0.0) + PER_IMAGE_GB * images as f64 * area
}

/// Why this Mac cannot edit with `images` pictures, with the number it can
/// take, or None when it can. A smaller share than Enhance takes: the run
/// with ten pictures left a 48 GB Mac a third free before its first step,
/// and the steps that follow add to that.
fn edit_memory_verdict(images: usize, side: u32, pack_gb: f64, total_bytes: u64) -> Option<String> {
    if total_bytes == 0 || images < 2 {
        return None;
    }
    let have = total_bytes as f64 / 1_073_741_824.0;
    let budget = have * 0.6;
    let need = edit_peak_gb(images, side, pack_gb);
    if need <= budget {
        return None;
    }
    let fits = (1..images).rev().find(|&n| edit_peak_gb(n, side, pack_gb) <= budget).unwrap_or(1);
    let way_out = if fits > 1 {
        format!("Use at most {fits} pictures, the one you edit included.")
    } else {
        "Edit the picture without references.".to_string()
    };
    Some(format!(
        "An edit with {images} pictures needs about {} GB of memory and this Mac has {} GB. \
         It was not started, so the system does not freeze. {way_out}",
        need.ceil() as u32,
        have.round() as u32
    ))
}

// ── Is the engine really there ────────────────────────────────────────

/// What stands where the engine should be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EngineState {
    /// No venv at all: never set up.
    Missing,
    /// A venv that cannot run the engine: pip never finished, a package is
    /// gone, or the interpreter under it was removed.
    Broken,
    Ready,
}

/// The packages the sidecar cannot start or render without.
const ENGINE_PACKAGES: [&str; 4] = ["torch", "diffusers", "fastapi", "uvicorn"];

/// "Installed" used to mean `venv/bin/python` exists. That file appears
/// seconds into the setup, long before pip has pulled 3 GB, so a setup that
/// lost its network, ran out of disk or was quit halfway read as finished for
/// good: the setup button was gone, every model download went through, and
/// every render ended in "mlx unreachable" (Fehlerkontrolle Mac, 08.10.2026,
/// Fund 2).
///
/// Ready now takes three things: the interpreter, the record that pip ran to
/// the end (`requirements.txt`, written only after success), and the packages
/// themselves in site-packages. The third catches the half installs older
/// versions left behind, which do carry the record. All three are file
/// checks, because `mlx_status` is polled and must not start a Python.
fn engine_state(root: &Path) -> EngineState {
    let venv = root.join("venv");
    if std::fs::symlink_metadata(&venv).is_err() {
        return EngineState::Missing;
    }
    let ready = venv.join("bin/python").exists()
        && root.join("requirements.txt").is_file()
        && site_packages_hold(&venv, &ENGINE_PACKAGES);
    if ready {
        EngineState::Ready
    } else {
        EngineState::Broken
    }
}

fn site_packages_hold(venv: &Path, packages: &[&str]) -> bool {
    std::fs::read_dir(venv.join("lib"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("python"))
        .map(|e| e.path().join("site-packages"))
        .any(|site| packages.iter().all(|p| site.join(p).is_dir()))
}

/// Take the record away, so the engine reads as not set up and the setup
/// button comes back. Called when the sidecar proved a package is missing.
fn mark_engine_broken(root: &Path) {
    let _ = std::fs::remove_file(root.join("requirements.txt"));
}

fn engine_not_ready_message(state: EngineState) -> &'static str {
    match state {
        EngineState::Broken => "The image engine is incomplete. Set it up again in the Model Manager.",
        _ => "The image engine is not set up yet. Set it up in the Model Manager first.",
    }
}

pub async fn mlx_status(_state: &AppState, _args: &Value) -> CmdResult {
    let engine = engine_state(&mlx_root());
    let unsupported = image_engine_unsupported(std::env::consts::OS, std::env::consts::ARCH);
    let running = sidecar_running();
    // A sidecar that died says why, once, instead of leaving the caller to
    // wait out its timeout on a port nobody listens on.
    let start_error = if running { None } else { sidecar_failure() };
    // When the sidecar is up, surface what it's holding so the UI can show a
    // "free memory" control while a model is resident.
    let (model_loaded, model_repo, idle_seconds) = if running {
        probe_health().await
    } else {
        (false, Value::Null, Value::Null)
    };
    Ok(json!({
        "installed": engine == EngineState::Ready,
        "broken": engine == EngineState::Broken,
        "appleSilicon": unsupported.is_none(),
        "unsupported": unsupported,
        "running": running,
        "startError": start_error,
        "port": MLX_PORT,
        "venv": venv_python().to_string_lossy(),
        "modelLoaded": model_loaded,
        "modelRepo": model_repo,
        "idleSeconds": idle_seconds,
        // The second engine. It arrives with the first model that needs it.
        "mfluxInstalled": mflux::engine_ready(),
        "mfluxVersion": mflux::VERSION,
    }))
}

/// GET /health on the sidecar → (model_loaded, model_repo, idle_seconds).
/// Best-effort: any failure reads as "nothing loaded" so mlx_status never hangs.
async fn probe_health() -> (bool, Value, Value) {
    let none = (false, Value::Null, Value::Null);
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(500))
        .build()
    else {
        return none;
    };
    match client.get(format!("http://127.0.0.1:{MLX_PORT}/health")).send().await {
        Ok(resp) => match resp.json::<Value>().await {
            Ok(v) => (
                v.get("model_loaded").and_then(|b| b.as_bool()).unwrap_or(false),
                v.get("model_repo").cloned().unwrap_or(Value::Null),
                v.get("idle_seconds").cloned().unwrap_or(Value::Null),
            ),
            Err(_) => none,
        },
        Err(_) => none,
    }
}

/// Free the resident image model but keep the sidecar running (fast reload on
/// the next generate). The web calls this to reclaim unified memory on demand;
/// the sidecar also auto-unloads after an idle timeout on its own.
pub async fn mlx_unload(_state: &AppState, _args: &Value) -> CmdResult {
    if !sidecar_running() {
        return Ok(json!({ "ok": true, "was_loaded": false, "running": false }));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| crate::commands::internal(e.to_string()))?;
    match client.post(format!("http://127.0.0.1:{MLX_PORT}/unload")).send().await {
        Ok(resp) => {
            let v: Value = resp.json().await.unwrap_or_else(|_| json!({ "ok": true }));
            Ok(json!({
                "ok": true,
                "was_loaded": v.get("was_loaded").and_then(|b| b.as_bool()).unwrap_or(false),
                "running": true,
            }))
        }
        Err(e) => Err(crate::commands::internal(format!("mlx unload: {e}"))),
    }
}

/// What the engine setup writes: the venv with torch and diffusers, and the
/// starter model. The Model Manager quotes the same 5.5 GB.
const ENGINE_INSTALL_BYTES: u64 = 5_500_000_000;

/// What a model download still has to write. A stopped download keeps its
/// files, so only the rest has to fit.
fn image_download_bytes_left(entry: &ImageCatalogEntry) -> u64 {
    let total = (entry.size_gb as f64 * 1e9) as u64;
    total.saturating_sub(crate::install_state::dir_size(&image_model_cache_dir(entry.repo)))
}

pub fn install_mlx_diffusion(state: &AppState, _args: &Value) -> CmdResult {
    // Before anything is created: an Intel Mac gets the reason, not a venv.
    ensure_image_engine_supported()?;
    // Both installs run pip in the same venv.
    if state.install_mlx_image_model().is_running() {
        return Err(crate::commands::bad_request(
            "A model download is running. Wait for it to finish or stop it, then set up the engine.",
        ));
    }
    // Refused before the venv exists: pip on a full disk dies halfway and
    // leaves the half engine behind.
    if engine_state(&mlx_root()) != EngineState::Ready {
        crate::commands::system::ensure_free_space(&mlx_root(), "The image engine", ENGINE_INSTALL_BYTES, "")
            .map_err(crate::commands::bad_request)?;
    }
    let slot = state.install_mlx_diffusion();
    if !slot.try_start() {
        return Ok(json!({"ok": true, "status": "installing"}));
    }
    slot.log("preparing the image engine");
    crate::install_state::spawn_install(slot, |slot| {
        install_mlx_steps(slot, &mlx_root()).map(|()| "MLX-Stable-Diffusion ready".to_string())
    });
    Ok(json!({"ok": true, "status": "installing"}))
}

pub fn install_mlx_diffusion_status(state: &AppState, _args: &Value) -> CmdResult {
    Ok(serde_json::to_value(state.install_mlx_diffusion().snapshot()).unwrap())
}

/// Whether the venv's interpreter starts AND is a version the pins have
/// wheels for. A venv is a set of links onto the Python it was built from;
/// after `brew upgrade` or an uninstall the links point at nothing and no pip
/// run can repair that. A venv a Python 3.15 left behind starts, and pip
/// fails in it on every retry (GH #188).
fn interpreter_fits(python: &Path) -> bool {
    crate::commands::video::venv_python_fits(&python.to_string_lossy(), crate::commands::video::TORCH_ENGINES_PYTHON)
}

/// A venv whose interpreter does not start, or is a Python the pins have no
/// wheels for, is thrown away and built again.
/// One that starts is kept: pip continues from what is there, which is what
/// makes a second click on "Set up" a repair and not a 3 GB restart.
fn clear_dead_venv(
    slot: &crate::install_state::InstallSlot,
    venv_dir: &Path,
    runs: impl Fn(&Path) -> bool,
) -> Result<(), String> {
    if std::fs::symlink_metadata(venv_dir).is_err() || runs(&venv_dir.join("bin/python")) {
        return Ok(());
    }
    slot.log("the existing environment does not start or runs a Python this engine cannot use, building it again");
    std::fs::remove_dir_all(venv_dir)
        .map_err(|e| format!("remove the broken environment: {}", os_error::english(&e)))
}

/// Install the requirements of this build and record them, in that order.
///
/// The record is `requirements.txt` next to the venv. It used to be written
/// BEFORE pip ran, so a pip that failed left a file saying the venv was built
/// from these requirements, and nothing ever tried again. Now the list goes to
/// `requirements.next.txt`, pip installs from that, and only a pip that ran to
/// the end turns it into the record. The old record is taken away first: while
/// pip is rewriting packages the venv is not what any record says it is.
fn install_engine_packages(
    root: &Path,
    pip_install: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let record = root.join("requirements.txt");
    let staged = root.join("requirements.next.txt");
    let _ = std::fs::remove_file(&record);
    std::fs::write(&staged, REQUIREMENTS_TXT)
        .map_err(|e| format!("write requirements: {}", os_error::english(&e)))?;
    pip_install(&staged)?;
    std::fs::rename(&staged, &record).map_err(|e| format!("write requirements: {}", os_error::english(&e)))
}

fn pip_install_requirements(
    slot: &crate::install_state::InstallSlot,
    venv_python: &Path,
    requirements: &Path,
) -> Result<(), String> {
    let mut pip = crate::python::python_command(venv_python);
    pip.args(["-m", "pip", "install", "--upgrade", "-r"]).arg(requirements);
    crate::commands::video::run_streamed(slot, &mut pip)
}

fn install_mlx_steps(slot: &crate::install_state::InstallSlot, root: &Path) -> Result<(), String> {
    // A Python found on this Mac comes first. Without one the app fetches its
    // own into the data folder: no terminal, no Homebrew, no admin rights.
    let python = match locate_engine_python() {
        Some(python) => python,
        None => {
            let range = crate::commands::video::TORCH_ENGINES_PYTHON.label();
            let log = format!("no Python {range} on this computer");
            let sentence = format!("This computer has no Python {range}");
            crate::private_python::ensure_for(slot, crate::private_python::Why { log: &log, sentence: &sentence })?
        }
    };
    slot.log(format!("Python: {}", python.display()));

    let venv_dir = root.join("venv");
    let venv_py = venv_dir.join("bin/python");
    clear_dead_venv(slot, &venv_dir, interpreter_fits)?;
    if !venv_dir.exists() {
        slot.log(format!("creating venv at {}", venv_dir.display()));
        std::fs::create_dir_all(root).map_err(|e| os_error::english(&e))?;
        let mut venv = crate::python::python_command(&python);
        venv.args(["-m", "venv"]).arg(&venv_dir);
        crate::commands::video::run_streamed(slot, &mut venv)
            .map_err(|e| format!("Creating the Python environment failed. {e}"))?;
    }

    // Every step from here on runs through `run_streamed`: its lines reach the
    // log while it works, its process is registered on the slot so a cancel
    // and the quit path can end it, and a cancel between two steps stops the
    // next one from starting.
    slot.log("installing the engine packages (torch and diffusers, about 3 GB)");
    install_engine_packages(root, |staged| pip_install_requirements(slot, &venv_py, staged))
        .map_err(|e| format!("Installing the engine packages failed. {e}"))?;
    std::fs::write(root.join("server.py"), SERVER_PY)
        .map_err(|e| format!("write server.py: {}", os_error::english(&e)))?;
    slot.log("engine packages installed");

    // Same pattern set as the catalog entry, so the fp32 duplicates (10+ GB)
    // stay on HuggingFace and image_model_is_installed() flips true.
    let starter = &IMAGE_CATALOG[0];
    slot.log(format!(
        "pre-pulling {} (~{} GB)",
        starter.repo, starter.size_gb
    ));
    let patterns = starter
        .allow
        .iter()
        .map(|p| format!("{p:?}"))
        .collect::<Vec<_>>()
        .join(",");
    let prefetch = format!(
        "from huggingface_hub import snapshot_download; snapshot_download({r:?}, allow_patterns=[{p}])",
        r = starter.repo,
        p = patterns,
    );
    let mut prefetch_cmd = crate::python::python_command(&venv_py);
    prefetch_cmd
        .args(["-c", prefetch.as_str()])
        .env("HF_HOME", root.join("cache"))
        .env("HF_XET_CACHE", root.join("cache").join("xet"));
    apply_hf_token(&mut prefetch_cmd);
    run_hub_step(slot, &mut prefetch_cmd, &[&root.join("cache")])
        .map_err(|e| format!("The engine is set up, but the starter model did not download. {e}"))?;
    slot.log("model pre-pull complete");

    Ok(())
}

/// Whether the packages in the venv were installed from the requirements this
/// build ships. The engine setup writes that file next to the venv, so the
/// copy on disk is the record of what the venv was built from.
fn engine_requirements_current(on_disk: Option<&str>) -> bool {
    on_disk.map(str::trim) == Some(REQUIREMENTS_TXT.trim())
}

/// An engine set up by an older version keeps its old packages: the setup
/// only ever ran once. A newer catalogue can name a model whose pipeline that
/// older diffusers does not have (FLUX.2 klein and Chroma arrived after the
/// first Mac build), and the load then fails long after a download
/// of many gigabytes. So before a model is pulled, the venv is brought to the
/// requirements of this build. With nothing to change, this is one file
/// comparison.
fn bring_engine_up_to_date(slot: &crate::install_state::InstallSlot) -> Result<(), String> {
    // A model install and an engine start can both find the record stale;
    // one pip at a time in the venv, and the second then finds it current.
    static ONE_UPDATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one = ONE_UPDATE.lock().unwrap_or_else(|e| e.into_inner());
    let root = mlx_root();
    let on_disk = std::fs::read_to_string(root.join("requirements.txt")).ok();
    if engine_requirements_current(on_disk.as_deref()) {
        return Ok(());
    }
    slot.log("updating the image engine to the packages this version needs");
    // Only a finished update becomes the record. A failed or cancelled one
    // leaves none, and the next install tries again.
    install_engine_packages(&root, |staged| pip_install_requirements(slot, &venv_python(), staged))
        .map_err(|e| format!("engine update: {e}"))?;
    // The sidecar that is running still has the old packages loaded.
    stop_sidecar();
    // The sweep exists on the Mac alone (see its gate in `process_util`), and
    // so does the sidecar it ends. Without this gate Windows did not compile.
    #[cfg(target_os = "macos")]
    crate::process_util::kill_listeners_on_port(MLX_PORT);
    slot.log("image engine updated");
    Ok(())
}

/// The interpreters worth asking, best first: 3.12 and 3.11 (every wheel the
/// engine needs exists for them), then 3.13 and 3.14, then whatever `python3`
/// is (Homebrew's is 3.15 by now, which `pick_engine_python` passes over), each
/// from PATH and from the directories a Finder-started app does not have on
/// its PATH, then every pyenv and uv install on the machine, and last the
/// Python LU downloaded for itself when the machine had none.
fn engine_python_candidates() -> Vec<PathBuf> {
    crate::private_python::with_fallback(system_python_candidates(), crate::private_python::installed())
}

fn system_python_candidates() -> Vec<PathBuf> {
    #[cfg_attr(target_os = "windows", allow(unused_mut))]
    let mut out: Vec<PathBuf> = Vec::new();
    #[cfg(not(target_os = "windows"))]
    {
        let named = ["python3.12", "python3.11", "python3.13", "python3.14", "python3"]
            .iter()
            .flat_map(|name| crate::python::python_paths_for(name));
        let rest = crate::python::python_interpreters().into_iter().map(PathBuf::from);
        for path in named.chain(rest) {
            if !out.contains(&path) {
                out.push(path);
            }
        }
    }
    out
}

/// The first candidate that answers with a version the engine's pins have
/// wheels for: 3.11 to 3.14, not the 3.15 Homebrew installs (GH #188).
fn pick_engine_python(
    candidates: &[PathBuf],
    version_of: impl Fn(&Path) -> Option<String>,
) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|p| {
            version_of(p)
                .and_then(|v| major_minor(&v))
                .is_some_and(|v| crate::commands::video::TORCH_ENGINES_PYTHON.fits(v))
        })
        .cloned()
}

fn locate_engine_python() -> Option<PathBuf> {
    pick_engine_python(&engine_python_candidates(), python_version)
}

fn python_version(python: &Path) -> Option<String> {
    let out = crate::python::python_command(python).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let v = if v.is_empty() {
        String::from_utf8_lossy(&out.stderr).trim().to_string()
    } else {
        v
    };
    Some(v.trim_start_matches("Python ").to_string())
}

/// `(3, 12)` from "3.12.7", None from anything that is not a version.
fn major_minor(version: &str) -> Option<(u32, u32)> {
    let mut parts = version.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next()?.parse::<u32>().ok()?;
    Some((major, minor))
}

/// The first `max` bytes of `s`, cut back to a character boundary.
///
/// `&s[..max]` panics when byte `max` falls inside a character, and pip frames
/// every error in box-drawing characters of three bytes each.
fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

// ── Hugging Face says no ──────────────────────────────────────────────

const HF_TOKEN_NEEDED: &str = "This model needs a Hugging Face token. Add a free token under Hugging Face token in Settings, AI Backends, accept the model's terms on its Hugging Face page, then start the download again.";
const HF_TOKEN_NO_ACCESS: &str = "Your Hugging Face token has no access to this model. Open the model's page on huggingface.co, accept its terms with the account the token belongs to, then start the download again.";

/// The sentence for a hub answer of 401 or 403, None for every other status.
///
/// These two used to be logged and stepped around: the install fell back to
/// its built-in file patterns, the download then failed on the same refusal,
/// and the user read "The installer stopped with exit code 1" with the word
/// "gated" only in the log (Fehlerkontrolle Mac, 08.10.2026, Fund 9).
fn hub_denied_message(status: u16, has_token: bool) -> Option<&'static str> {
    match status {
        401 | 403 if has_token => Some(HF_TOKEN_NO_ACCESS),
        401 | 403 => Some(HF_TOKEN_NEEDED),
        _ => None,
    }
}

pub(crate) fn is_hub_denied(message: &str) -> bool {
    message == HF_TOKEN_NEEDED || message == HF_TOKEN_NO_ACCESS
}

/// The same refusal as it looks in the output of `huggingface_hub`.
fn hub_denied_in_log(lines: &[String], has_token: bool) -> Option<&'static str> {
    const MARKS: [&str; 7] = [
        "GatedRepoError",
        "401 Client Error",
        "403 Client Error",
        "Cannot access gated repo",
        "Access to model",
        "is restricted",
        "Invalid user token",
    ];
    let from = lines.len().saturating_sub(80);
    lines[from..]
        .iter()
        .any(|line| MARKS.iter().any(|m| line.contains(m)))
        .then(|| hub_denied_message(401, has_token))
        .flatten()
}

/// A download that has not moved a byte for this long is not going to move
/// again by itself.
const STALL_AFTER: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// How often a download is started in all when it keeps stalling.
const STALL_ATTEMPTS: u32 = 3;

/// A step that pulls from the hub into `lands_in`. When it fails on a
/// refusal, the reason is the token sentence and not the exit code.
///
/// It is also watched for standing still. The download of LTX-2.3 4-bit
/// stopped at 12.38 of 20.5 GB and stood at 0.0 MB/s for more than forty
/// minutes, with the slot on "installing" and nothing in the app that would
/// ever have noticed (real run on the M5 Pro, 09.10.2026): the hub client has
/// no timeout for a connection that stays open and sends nothing. When the
/// step has stood still for `STALL_AFTER` the process is ended and started
/// again. What is complete on disk stays, and the hub client skips it.
///
/// Standing still is two things at once: the folders the step writes into
/// have not changed, AND the process has received nothing from the network.
/// The folders alone are not enough. The same download, started again, took
/// in 2.4 GB over ten minutes without a byte reaching the disk: the Xet
/// transport of the hub client holds what it fetches in memory and writes it
/// in large pieces. A watcher that went by the disk would have ended a
/// download that was working. Where the network cannot be read
/// (`install_state::received_bytes` answers `None`), nothing is ever called stalled.
///
/// `lands_in` is every folder the step writes: the target and the hub's chunk
/// cache. Empty: the step is not watched.
pub(crate) fn run_hub_step(
    slot: &crate::install_state::InstallSlot,
    cmd: &mut Command,
    lands_in: &[&Path],
) -> Result<(), String> {
    if lands_in.is_empty() {
        return run_hub_step_watched(slot, cmd, None);
    }
    let started = std::time::Instant::now();
    let watch = StallWatch {
        stall_after: STALL_AFTER,
        look_every: std::time::Duration::from_secs(10),
        on_disk: &|| lands_in.iter().map(|dir| crate::install_state::dir_size(dir)).sum::<u64>(),
        received: &crate::install_state::received_bytes,
        now: &|| started.elapsed(),
        nap: &std::thread::sleep,
    };
    run_hub_step_watched(slot, cmd, Some(&watch))
}

/// What the watcher of a download step goes by: how long nothing may move,
/// how often it looks, and the four things it reads from the system. They are
/// handed in so that a test can stand in for the disk, the network and the
/// clock. `run_hub_step` hands in the real ones.
struct StallWatch<'a> {
    stall_after: std::time::Duration,
    look_every: std::time::Duration,
    /// Bytes in the folders the step writes into.
    on_disk: &'a (dyn Fn() -> u64 + Sync),
    /// Bytes a process has received from the network, `None` where that
    /// cannot be read.
    received: &'a (dyn Fn(u32) -> Option<u64> + Sync),
    /// Time since a fixed moment.
    now: &'a (dyn Fn() -> std::time::Duration + Sync),
    /// Wait this long.
    nap: &'a (dyn Fn(std::time::Duration) + Sync),
}

/// Remove what stopped downloads left in `target`. Since release 1.18 the hub
/// client names a partial file `<hash>.<random>.incomplete` and never opens
/// one again: a second Get fetches that file from its first byte and leaves
/// the old piece where it is. Real run, 09.10.2026: 3.2 GB of such pieces lay
/// in the folder of LTX-2.3 4-bit, counted by the progress bar as downloaded
/// (it stood at 12.38 GB with 9.16 GB of whole files) and never removed.
///
/// The pieces of a file that lies in a subfolder of the repository lie in
/// the same subfolder here (`download/transformer/...`). The first version
/// looked at the top level only, which was all of LTX-2.3 and none of a
/// Qwen-Image pack: 14 pieces and 0.76 GB stayed in the finished 8-bit pack
/// (real run, 09.10.2026). Returns the bytes that were freed.
pub(crate) fn drop_stale_partials(target: &Path) -> u64 {
    fn sweep(dir: &Path) -> u64 {
        let mut freed = 0;
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                freed += sweep(&entry.path());
            } else if entry.file_name().to_string_lossy().ends_with(".incomplete") && std::fs::remove_file(entry.path()).is_ok() {
                freed += meta.len();
            }
        }
        freed
    }
    sweep(&target.join(".cache").join("huggingface").join("download"))
}

fn run_hub_step_watched(
    slot: &crate::install_state::InstallSlot,
    cmd: &mut Command,
    watch: Option<&StallWatch>,
) -> Result<(), String> {
    use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
    let minutes = watch.map(|w| (w.stall_after.as_secs() / 60).max(1)).unwrap_or(0);
    for attempt in 1..=STALL_ATTEMPTS {
        let (over, stalled) = (AtomicBool::new(false), AtomicBool::new(false));
        let outcome = std::thread::scope(|scope| {
            if let Some(w) = watch {
                let (over, stalled) = (&over, &stalled);
                scope.spawn(move || {
                    // What is on disk, and what came in over the network.
                    // `None` for the second: it cannot be read, and then
                    // nothing here is ever called stalled.
                    let measure = || ((w.on_disk)(), slot.child().map(w.received));
                    let (mut size, mut moved) = (measure(), (w.now)());
                    let mut looked = (w.now)();
                    while !over.load(SeqCst) {
                        // Short naps, so the end of the step is not held up
                        // by a watcher that is asleep.
                        (w.nap)(w.look_every.min(std::time::Duration::from_millis(100)));
                        if (w.now)().saturating_sub(looked) < w.look_every {
                            continue;
                        }
                        looked = (w.now)();
                        let now = measure();
                        // No child yet, or a network that cannot be read:
                        // the clock starts again and nothing is concluded.
                        let readable = matches!(now.1, Some(Some(_)));
                        if now != size || !readable {
                            (size, moved) = (now, (w.now)());
                        } else if (w.now)().saturating_sub(moved) >= w.stall_after && !slot.cancel_requested() {
                            stalled.store(true, SeqCst);
                            slot.log(format!("No data has arrived for {minutes} minutes. Stopping this attempt."));
                            slot.end_child();
                            return;
                        }
                    }
                });
            }
            slot.set_fetching(true);
            let outcome = crate::commands::video::run_streamed(slot, cmd);
            slot.set_fetching(false);
            over.store(true, SeqCst);
            outcome
        });
        let Err(why) = outcome else {
            return Ok(());
        };
        if slot.cancel_requested() {
            return Err(why);
        }
        if stalled.load(SeqCst) {
            if attempt < STALL_ATTEMPTS {
                slot.log(format!("The download stalled. Starting it again (attempt {} of {STALL_ATTEMPTS}), what is on disk is kept.", attempt + 1));
                continue;
            }
            return Err(format!(
                "The download stalled {STALL_ATTEMPTS} times: no data arrived for {minutes} minutes each time. Check the connection and start it again. What was downloaded is kept."
            ));
        }
        return Err(match hub_denied_in_log(&slot.snapshot().logs, hf_token().is_some()) {
            Some(denied) => denied.to_string(),
            None => why,
        });
    }
    unreachable!("the last attempt returns")
}

// ── Image model catalog ───────────────────────────────────────────────
//
// Every entry is a diffusers-layout HuggingFace repo verified to exist,
// ungated, and loadable via `AutoPipelineForText2Image.from_pretrained`
// (fp16-variant repos additionally verified to carry per-subfolder fp16
// weights — a root-level `*_fp16.safetensors` alone does NOT load). The
// sidecar downloads into `HF_HOME = <mlx_root>/cache`, so install and
// runtime share one cache and "installed" == snapshot dir present.

#[derive(serde::Serialize, Clone)]
pub struct ImageCatalogEntry {
    pub id: &'static str,
    pub name: &'static str,
    pub repo: &'static str,
    /// Approximate size of the files the install actually pulls (see
    /// `allow` — not the full repo, which often carries fp32 + onnx dupes).
    pub size_gb: f32,
    pub min_ram_gb: u32,
    pub steps: u32,
    pub guidance: f32,
    /// Pipeline kwarg carrying the guidance value ("guidance_scale" for
    /// SD/SDXL/Z-Image, "true_cfg_scale" for Qwen-Image).
    pub cfg_param: &'static str,
    pub dtype: &'static str, // "float16" | "bfloat16"
    /// Load with `variant="fp16"` (repo ships .fp16.safetensors subfiles).
    pub fp16_variant: bool,
    /// SD1.5 repos bundle a safety_checker component; we skip it at load.
    pub disable_safety_checker: bool,
    pub default_size: u32,
    pub unfiltered: bool,
    pub description: &'static str,
    /// No longer offered. A retired entry is listed only where it is already
    /// installed, so the files a user pulled under an older version can still
    /// be used and removed instead of sitting on the disk with no row.
    pub retired: bool,
    /// `snapshot_download` allow_patterns — hf_hub fnmatch, `*` crosses `/`.
    #[serde(skip)]
    allow: &'static [&'static str],
    /// Set for an entry that runs on the mflux engine and not in the
    /// sidecar: its pack, and the command of the engine that runs it. The
    /// sidecar's fields above (`cfg_param`, `dtype`, `allow`) are then unused.
    #[serde(skip)]
    mflux: Option<&'static mflux::Pack>,
}

macro_rules! allow {
    ($($p:expr),*) => { &["*.json", "*.txt", $($p),*] };
}

pub const IMAGE_CATALOG: &[ImageCatalogEntry] = &[
    ImageCatalogEntry {
        id: "sd-turbo",
        name: "SD Turbo",
        repo: "stabilityai/sd-turbo",
        size_gb: 2.6,
        min_ram_gb: 8,
        steps: 4,
        guidance: 0.0,
        cfg_param: "guidance_scale",
        dtype: "float16",
        fp16_variant: true,
        disable_safety_checker: false,
        default_size: 512,
        unfiltered: false,
        retired: false,
        description: "Quick 512px drafts in 1 to 4 steps. The starter model, runs on every Apple Silicon Mac.",
        mflux: None,
        allow: allow!["tokenizer/*", "text_encoder/*fp16*", "unet/*fp16*", "vae/*fp16*"],
    },
    ImageCatalogEntry {
        id: "realistic-vision-v51",
        name: "Realistic Vision V5.1",
        repo: "SG161222/Realistic_Vision_V5.1_noVAE",
        size_gb: 4.3,
        min_ram_gb: 8,
        steps: 28,
        guidance: 5.0,
        cfg_param: "guidance_scale",
        dtype: "float16",
        fp16_variant: false,
        disable_safety_checker: true,
        default_size: 512,
        unfiltered: true,
        retired: false,
        description: "Photoreal people and portraits at 512px. Runs on 8 GB Macs.",
        mflux: None,
        allow: allow![
            "tokenizer/*",
            "text_encoder/model.safetensors",
            "unet/diffusion_pytorch_model.safetensors",
            "vae/diffusion_pytorch_model.safetensors"
        ],
    },
    ImageCatalogEntry {
        id: "dreamshaper-xl-turbo",
        name: "DreamShaper XL v2 Turbo",
        repo: "Lykon/dreamshaper-xl-v2-turbo",
        size_gb: 6.9,
        min_ram_gb: 16,
        steps: 8,
        guidance: 2.0,
        cfg_param: "guidance_scale",
        dtype: "float16",
        fp16_variant: true,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: false,
        retired: false,
        description: "SDXL all-rounder for art, fantasy and photo. 1024px in about 8 steps.",
        mflux: None,
        allow: allow![
            "tokenizer/*", "tokenizer_2/*",
            "text_encoder/*fp16*", "text_encoder_2/*fp16*",
            "unet/*fp16*", "vae/*fp16*"
        ],
    },
    ImageCatalogEntry {
        id: "juggernaut-xl-v9",
        name: "Juggernaut XL v9",
        repo: "RunDiffusion/Juggernaut-XL-v9",
        size_gb: 6.9,
        min_ram_gb: 16,
        steps: 30,
        guidance: 6.0,
        cfg_param: "guidance_scale",
        dtype: "float16",
        fp16_variant: true,
        disable_safety_checker: false,
        default_size: 1024,
        // Unfiltered since 08.10.2026: its author tags it NSFW on Civitai and
        // the line carries NSFW training sets. See EINSTUFUNG-KATALOG.md.
        unfiltered: true,
        retired: false,
        description: "The most used photoreal SDXL model. Strong on people and cinematic light, with no content filter: it renders nudity.",
        mflux: None,
        allow: allow![
            "tokenizer/*", "tokenizer_2/*",
            "text_encoder/*fp16*", "text_encoder_2/*fp16*",
            "unet/*fp16*", "vae/*fp16*"
        ],
    },
    ImageCatalogEntry {
        id: "animagine-xl-4.0",
        name: "Animagine XL 4.0",
        repo: "cagliostrolab/animagine-xl-4.0",
        size_gb: 6.9,
        min_ram_gb: 16,
        steps: 28,
        guidance: 5.0,
        cfg_param: "guidance_scale",
        dtype: "float16",
        // The component weights are fp16 under the plain file names, there
        // is no `.fp16.` variant in the repo.
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        // Unfiltered since 08.10.2026: its card documents the rating tags
        // `nsfw` and `explicit`. See EINSTUFUNG-KATALOG.md.
        unfiltered: true,
        retired: false,
        description: "Anime SDXL retrained on 8.4M images, strong on known characters. Tag prompts, with rating tags that reach explicit.",
        // Exact names, not `*.safetensors`: the repo root also carries two
        // 6.9 GB single-file checkpoints that the pipeline does not load.
        mflux: None,
        allow: allow![
            "tokenizer/*", "tokenizer_2/*",
            "text_encoder/model.safetensors", "text_encoder_2/model.safetensors",
            "unet/diffusion_pytorch_model.safetensors", "vae/diffusion_pytorch_model.safetensors"
        ],
    },
    ImageCatalogEntry {
        id: "realvisxl-v5",
        name: "RealVisXL V5.0",
        repo: "SG161222/RealVisXL_V5.0",
        size_gb: 6.9,
        min_ram_gb: 16,
        steps: 25,
        guidance: 5.0,
        cfg_param: "guidance_scale",
        dtype: "float16",
        fp16_variant: true,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: true,
        retired: false,
        description: "Photoreal SDXL from the RealVis series, a reference for realism.",
        mflux: None,
        allow: allow![
            "tokenizer/*", "tokenizer_2/*",
            "text_encoder/*fp16*", "text_encoder_2/*fp16*",
            "unet/*fp16*", "vae/*fp16*"
        ],
    },
    ImageCatalogEntry {
        id: "lustify-v7",
        name: "Lustify v7",
        repo: "John6666/lustify-sdxl-nsfw-checkpoint-ggwp-v7-sdxl",
        size_gb: 6.9,
        min_ram_gb: 16,
        steps: 30,
        guidance: 5.0,
        cfg_param: "guidance_scale",
        dtype: "float16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: true,
        retired: false,
        description: "Photoreal SDXL trained for adult content.",
        mflux: None,
        allow: allow![
            "tokenizer/*", "tokenizer_2/*",
            "text_encoder/model.safetensors", "text_encoder_2/model.safetensors",
            "unet/diffusion_pytorch_model.safetensors", "vae/diffusion_pytorch_model.safetensors"
        ],
    },
    ImageCatalogEntry {
        id: "cyberrealistic-pony-v13",
        name: "CyberRealistic Pony v13",
        repo: "John6666/cyberrealistic-pony-v130-sdxl",
        size_gb: 6.9,
        min_ram_gb: 16,
        steps: 30,
        guidance: 5.0,
        cfg_param: "guidance_scale",
        dtype: "float16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: true,
        retired: false,
        description: "Photoreal look on the Pony base, which follows tag prompts closely.",
        mflux: None,
        allow: allow![
            "tokenizer/*", "tokenizer_2/*",
            "text_encoder/model.safetensors", "text_encoder_2/model.safetensors",
            "unet/diffusion_pytorch_model.safetensors", "vae/diffusion_pytorch_model.safetensors"
        ],
    },
    ImageCatalogEntry {
        id: "noobai-xl-1.1",
        name: "NoobAI XL 1.1",
        repo: "Laxhar/noobai-XL-1.1",
        size_gb: 6.9,
        min_ram_gb: 16,
        steps: 28,
        guidance: 5.5,
        cfg_param: "guidance_scale",
        dtype: "float16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: true,
        retired: false,
        description: "Anime and illustration base with wide character and style knowledge.",
        mflux: None,
        allow: allow![
            "tokenizer/*", "tokenizer_2/*",
            "text_encoder/model.safetensors", "text_encoder_2/model.safetensors",
            "unet/diffusion_pytorch_model.safetensors", "vae/diffusion_pytorch_model.safetensors"
        ],
    },
    ImageCatalogEntry {
        id: "wai-illustrious-v15",
        name: "WAI Illustrious v15",
        repo: "John6666/wai-nsfw-illustrious-sdxl-v150-sdxl",
        size_gb: 6.9,
        min_ram_gb: 16,
        steps: 28,
        guidance: 6.0,
        cfg_param: "guidance_scale",
        dtype: "float16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: true,
        retired: false,
        description: "The popular Illustrious anime line, clean lines and strong colours.",
        mflux: None,
        allow: allow![
            "tokenizer/*", "tokenizer_2/*",
            "text_encoder/model.safetensors", "text_encoder_2/model.safetensors",
            "unet/diffusion_pytorch_model.safetensors", "vae/diffusion_pytorch_model.safetensors"
        ],
    },
    ImageCatalogEntry {
        id: "one-obsession-v17",
        name: "One Obsession 17 Red",
        repo: "John6666/one-obsession-17-red-sdxl",
        size_gb: 6.9,
        min_ram_gb: 16,
        steps: 28,
        guidance: 5.0,
        cfg_param: "guidance_scale",
        dtype: "float16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: true,
        retired: false,
        description: "Between anime and 2.5D, with strong light and shadow. Short tag prompts are enough.",
        mflux: None,
        allow: allow![
            "tokenizer/*", "tokenizer_2/*",
            "text_encoder/model.safetensors", "text_encoder_2/model.safetensors",
            "unet/diffusion_pytorch_model.safetensors", "vae/diffusion_pytorch_model.safetensors"
        ],
    },
    ImageCatalogEntry {
        id: "flux2-klein-4b",
        name: "FLUX.2 klein 4B",
        repo: "black-forest-labs/FLUX.2-klein-4B",
        size_gb: 16.0,
        min_ram_gb: 24,
        steps: 4,
        guidance: 1.0,
        cfg_param: "guidance_scale",
        dtype: "bfloat16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: false,
        retired: false,
        description: "The small FLUX.2 from Black Forest Labs. Four steps, strong prompt following and text in images.",
        mflux: None,
        allow: allow![
            "tokenizer/*",
            "transformer/*.safetensors",
            "text_encoder/*.safetensors",
            "vae/*.safetensors"
        ],
    },
    ImageCatalogEntry {
        id: "z-image",
        name: "Z-Image",
        repo: "Tongyi-MAI/Z-Image",
        size_gb: 20.5,
        min_ram_gb: 32,
        steps: 50,
        guidance: 4.0,
        cfg_param: "guidance_scale",
        dtype: "bfloat16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: false,
        retired: false,
        description: "The full Z-Image from Alibaba, undistilled. Slower than Turbo, more variety and finer control.",
        mflux: None,
        allow: allow![
            "tokenizer/*",
            "transformer/*.safetensors",
            "text_encoder/*.safetensors",
            "vae/*.safetensors"
        ],
    },
    ImageCatalogEntry {
        id: "z-image-turbo",
        name: "Z-Image Turbo",
        repo: "Tongyi-MAI/Z-Image-Turbo",
        size_gb: 32.8,
        min_ram_gb: 32,
        steps: 9,
        guidance: 0.0,
        cfg_param: "guidance_scale",
        dtype: "bfloat16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: false,
        retired: false,
        description: "Photoreal images and readable text at 1024px in 9 steps. Among the best open models today.",
        mflux: None,
        allow: allow![
            "tokenizer/*",
            "transformer/*.safetensors",
            "text_encoder/*.safetensors",
            "vae/*.safetensors"
        ],
    },
    ImageCatalogEntry {
        id: "chroma1-hd",
        name: "Chroma1-HD",
        repo: "lodestones/Chroma1-HD",
        size_gb: 27.5,
        min_ram_gb: 48,
        steps: 40,
        guidance: 3.0,
        cfg_param: "guidance_scale",
        dtype: "bfloat16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: true,
        retired: false,
        description: "Large open model built on FLUX and trained without content limits. The strongest pick on this side.",
        mflux: None,
        allow: allow![
            "tokenizer/*",
            "transformer/*.safetensors",
            "text_encoder/*.safetensors",
            "vae/*.safetensors"
        ],
    },
    ImageCatalogEntry {
        id: "qwen-image-2512",
        name: "Qwen-Image 2512",
        repo: "Qwen/Qwen-Image-2512",
        size_gb: 57.7,
        min_ram_gb: 64,
        steps: 40,
        guidance: 4.0,
        cfg_param: "true_cfg_scale",
        dtype: "bfloat16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: false,
        retired: false,
        description: "20B model for complex scenes and long text inside images. For Macs with 64 GB and more.",
        mflux: None,
        allow: allow![
            "tokenizer/*",
            "transformer/*.safetensors",
            "text_encoder/*.safetensors",
            "vae/*.safetensors"
        ],
    },
    // The entries of the second engine, mflux (see `image_mflux.rs`): packs
    // that are quantized already and run in native MLX. Sizes are the sum of
    // the files the install fetches at the pinned commit, read from the hub
    // on 08.10.2026. None of them has produced an image in LU yet, and each
    // tile says so. The memory floors of the packs whose cards state none
    // (Z-Image, FLUX.2, Qwen-Image 2512) are estimates from the pack size.
    ImageCatalogEntry {
        id: "flux2-klein-4b-4bit",
        name: "FLUX.2 klein 4B 4-bit",
        repo: "mflux-community/flux2-klein-4b-mflux-q4",
        size_gb: 4.6,
        min_ram_gb: 16,
        steps: 4,
        guidance: 1.0,
        cfg_param: "guidance_scale",
        dtype: "bfloat16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: false,
        retired: false,
        description: "The small FLUX.2, quantized to 4-bit for the MLX image engine. Four steps and a small download. Experimental: not yet tested in LU.",
        mflux: Some(&mflux::FLUX2_KLEIN_4B_4BIT),
        allow: allow![],
    },
    ImageCatalogEntry {
        id: "z-image-turbo-4bit",
        name: "Z-Image Turbo 4-bit",
        repo: "mflux-community/z-image-turbo-mflux-q4",
        size_gb: 5.9,
        min_ram_gb: 16,
        steps: 9,
        guidance: 0.0,
        cfg_param: "guidance_scale",
        dtype: "bfloat16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: false,
        retired: false,
        description: "Z-Image Turbo, quantized to 4-bit for the MLX image engine. Nine steps, for Macs from 16 GB.",
        mflux: Some(&mflux::ZIMAGE_TURBO_4BIT),
        allow: allow![],
    },
    ImageCatalogEntry {
        id: "qwen-image-2.1-4bit",
        name: "Qwen-Image 2.1 4-bit",
        repo: "OsaurusAI/Qwen-Image-2.1-mflux-4bit",
        size_gb: 10.6,
        min_ram_gb: 16,
        // The count Windows starts this model at (the official ComfyUI
        // template), so Create opens on the same number on both.
        steps: 25,
        guidance: 1.0,
        cfg_param: "guidance_scale",
        dtype: "bfloat16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: false,
        retired: false,
        description: "Qwen-Image 2.1, quantized to 4-bit for the MLX image engine. Generates from a prompt and edits images from a prompt. Strong at text inside images, for Macs from 16 GB. Research license, non-commercial use only.",
        mflux: Some(&mflux::QWEN21_4BIT),
        allow: allow![],
    },
    ImageCatalogEntry {
        id: "z-image-turbo-8bit",
        name: "Z-Image Turbo 8-bit",
        repo: "mflux-community/z-image-turbo-mflux-q8",
        size_gb: 11.0,
        min_ram_gb: 24,
        steps: 9,
        guidance: 0.0,
        cfg_param: "guidance_scale",
        dtype: "bfloat16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: false,
        retired: false,
        description: "Z-Image Turbo, quantized to 8-bit for the MLX image engine. Closer to the full model than the 4-bit pack. Experimental: not yet tested in LU.",
        mflux: Some(&mflux::ZIMAGE_TURBO_8BIT),
        allow: allow![],
    },
    ImageCatalogEntry {
        id: "qwen-image-2.1-8bit",
        name: "Qwen-Image 2.1 8-bit",
        repo: "OsaurusAI/Qwen-Image-2.1-mflux-8bit",
        size_gb: 18.5,
        // Measured on a real run (M5 Pro, 10.10.2026): 10.3 GB at the peak for
        // an image of 1024. It stood at 32 before anybody had run it. 24 and
        // not 16: an edit was not measured on this pack, and nobody has run
        // it on a smaller Mac.
        min_ram_gb: 24,
        // The count Windows starts this model at (the official ComfyUI
        // template), so Create opens on the same number on both.
        steps: 25,
        guidance: 1.0,
        cfg_param: "guidance_scale",
        dtype: "bfloat16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: false,
        retired: false,
        description: "Qwen-Image 2.1, quantized to 8-bit for the MLX image engine. Generates from a prompt and edits images from a prompt. Strong at text inside images. Research license, non-commercial use only.",
        mflux: Some(&mflux::QWEN21_8BIT),
        allow: allow![],
    },
    ImageCatalogEntry {
        id: "qwen-image-2.1-turbo",
        name: "Qwen-Image 2.1 Turbo 8-bit",
        repo: "OsaurusAI/Qwen-Image-2.1-mflux-8bit",
        size_gb: 19.9,
        // Measured on a real run (M5 Pro, 10.10.2026): 14.9 GB at the peak,
        // image and edit. It stood at 32 before anybody had run it.
        min_ram_gb: 24,
        steps: 6,
        guidance: 1.0,
        cfg_param: "guidance_scale",
        dtype: "bfloat16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: false,
        retired: false,
        description: "Qwen-Image 2.1 8-bit with the Viggle Turbo LoRA: six steps in place of 25. Generates and edits. Shares its download with the 8-bit model. Research license, non-commercial use only.",
        mflux: Some(&mflux::QWEN21_TURBO),
        allow: allow![],
    },
    ImageCatalogEntry {
        id: "qwen-image-2512-8bit",
        name: "Qwen-Image 2512 8-bit",
        repo: "mflux-community/qwen-image-2512-mflux-q8",
        size_gb: 36.1,
        min_ram_gb: 48,
        steps: 20,
        guidance: 3.5,
        cfg_param: "guidance_scale",
        dtype: "bfloat16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: false,
        retired: false,
        description: "Qwen-Image 2512, the 20B model, quantized to 8-bit for the MLX image engine. For Macs from 48 GB. Experimental: not yet tested in LU.",
        mflux: Some(&mflux::QWEN_2512_8BIT),
        allow: allow![],
    },
    // Enhance Image on a Mac (`mflux::upscale`): no picture from a prompt, so
    // Generate refuses it and Create lists it for Enhance alone. The size is
    // the two files the install fetches, 7.28 GB (hub, 14.10.2026). The
    // memory floor is an estimate: the weights are 7.3 GB at fp16 and the
    // engine states no requirement. The 7B model is left out: the engine
    // names no reason to prefer it, and it is 17 GB.
    ImageCatalogEntry {
        id: "seedvr2-3b",
        name: "SeedVR2 3B",
        repo: "numz/SeedVR2_comfyUI",
        size_gb: 7.3,
        min_ram_gb: 16,
        steps: 1,
        guidance: 1.0,
        cfg_param: "guidance_scale",
        dtype: "float16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: false,
        retired: false,
        description: "Enhance Image on a Mac: makes a picture two or four times larger and sharper in one step, without a prompt.",
        mflux: Some(&mflux::SEEDVR2_3B),
        allow: allow![],
    },
    // Retired with 3.0.6. Listed only where already installed (see `retired`).
    ImageCatalogEntry {
        id: "nsfw-gen-v2",
        name: "UnfilteredAI Gen v2",
        repo: "UnfilteredAI/NSFW-gen-v2",
        size_gb: 8.6,
        min_ram_gb: 16,
        steps: 30,
        guidance: 7.0,
        cfg_param: "guidance_scale",
        dtype: "float16",
        fp16_variant: true,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: true,
        retired: true,
        description: "Unfiltered SDXL from 2024. No longer in the catalogue, Lustify v7 replaces it.",
        mflux: None,
        allow: allow![
            "tokenizer/*", "tokenizer_2/*",
            "text_encoder/model.safetensors", "text_encoder_2/model.safetensors",
            "unet/*fp16*", "vae/*fp16*"
        ],
    },
    ImageCatalogEntry {
        id: "qwen-image",
        name: "Qwen-Image",
        repo: "Qwen/Qwen-Image",
        size_gb: 57.7,
        min_ram_gb: 64,
        steps: 40,
        guidance: 4.0,
        cfg_param: "true_cfg_scale",
        dtype: "bfloat16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: false,
        retired: true,
        description: "The first Qwen-Image. No longer in the catalogue, Qwen-Image 2512 replaces it.",
        mflux: None,
        allow: allow![
            "tokenizer/*",
            "transformer/*.safetensors",
            "text_encoder/*.safetensors",
            "vae/*.safetensors"
        ],
    },
];

fn image_catalog_lookup(id: &str) -> Option<&'static ImageCatalogEntry> {
    IMAGE_CATALOG.iter().find(|c| c.id == id)
}

/// HF hub cache dir for a repo inside our HF_HOME
/// (`cache/hub/models--org--name`).
fn image_model_cache_dir(repo: &str) -> PathBuf {
    mlx_root()
        .join("cache")
        .join("hub")
        .join(format!("models--{}", repo.replace('/', "--")))
}

/// The Xet chunk cache inside our HF_HOME (`cache/xet`).
///
/// huggingface_hub 1.x downloads over Xet by default, and Xet does not fill
/// `<repo>/blobs/<sha>.incomplete` the way the plain HTTP path does: the bytes
/// land here first, in a folder that sits NEXT TO the repo folder rather than
/// inside it. The progress watcher therefore has to look at both, or it reads
/// near zero for minutes while the line is busy (bauer-m, Mac, 11.09.2026, N1:
/// "1.7 MB / 8.0 GB 0%" after four and a half minutes, with 2.1 MB sitting
/// right here). Shared by every repo, so only its growth counts.
///
/// Pinned through `HF_XET_CACHE` on every command that downloads, so this path
/// is what the library really uses and not what it happens to default to.
fn hf_xet_cache_dir() -> PathBuf {
    mlx_root().join("cache").join("xet")
}

/// The snapshot directories of one repo, the revision `refs/main` points at
/// first. A cache can hold more than one revision; the one the hub currently
/// serves is the one an install has just written.
fn snapshot_dirs(repo: &str) -> Vec<PathBuf> {
    let root = image_model_cache_dir(repo);
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(root.join("snapshots"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    if let Ok(rev) = std::fs::read_to_string(root.join("refs/main")) {
        let head = root.join("snapshots").join(rev.trim());
        if let Some(at) = dirs.iter().position(|d| *d == head) {
            dirs.swap(0, at);
        }
    }
    dirs
}

/// Make `refs/main` of a repo folder name this snapshot.
///
/// The install downloads a pinned commit, and huggingface_hub writes a ref only
/// for a branch or tag name, never for a commit hash. The load then asks for
/// the repo by name, which means `main`, and with `local_files_only` a cache
/// without `refs/main` answers "does not appear to have a file named
/// model_index.json" although every file is on disk (Mac, 11.10.2026: first
/// picture after a fresh install of SD Turbo failed exactly so). The ref is
/// what turns the name into the folder, so the app writes it itself.
///
/// Returns whether the file was written. A ref that already names the snapshot
/// is left alone.
fn name_main_revision(repo_root: &std::path::Path, snap: &std::path::Path) -> std::io::Result<bool> {
    let Some(rev) = snap.file_name().and_then(|name| name.to_str()) else {
        return Ok(false);
    };
    let refs = repo_root.join("refs");
    let main = refs.join("main");
    if std::fs::read_to_string(&main).is_ok_and(|have| have.trim() == rev) {
        return Ok(false);
    }
    std::fs::create_dir_all(&refs)?;
    std::fs::write(&main, rev)?;
    Ok(true)
}

/// The snapshot a load of this entry should open: the first complete one.
fn complete_snapshot(entry: &ImageCatalogEntry) -> Option<PathBuf> {
    snapshot_dirs(entry.repo).into_iter().find(|snap| {
        crate::commands::mlx_snapshot::audit_snapshot(snap, None, prefer_variant(entry)).is_complete()
    })
}

/// Point the repo name at the complete snapshot before a load that may not
/// ask the hub. Also heals a model installed by a build that left no ref.
fn name_installed_snapshot(entry: &ImageCatalogEntry) {
    if entry.mflux.is_some() {
        return;
    }
    if let Some(snap) = complete_snapshot(entry) {
        let _ = name_main_revision(&image_model_cache_dir(entry.repo), &snap);
    }
}

/// Does the load ask diffusers for `variant="fp16"`?
///
/// It has to be the same decision `plan_download` made, and that one is not
/// all-or-nothing: `pick_weight_set` takes the fp16 family for every component
/// that has one and the plain family for the rest, so a finished install of
/// `UnfilteredAI/NSFW-gen-v2` holds fp16 weights in `unet/` and `vae/` and
/// full-precision weights in both text encoders. diffusers resolves the
/// variant per component, not per pipeline: `_identify_model_variants`
/// (diffusers 0.38.0, `pipelines/pipeline_loading_utils.py`) collects only the
/// subfolders that carry a matching file, and every other component is loaded
/// with `variant=None`. Asking for fp16 on that mixed folder therefore works,
/// while `variant=None` makes the loader look for the plain file in `unet/`
/// and `vae/`, which is exactly the file the plan deliberately did not fetch,
/// and `local_files_only` turns the miss into an abort instead of a download.
/// The one snapshot that must not ask for fp16 is the one without a single
/// fp16 file, because diffusers raises "no such modeling files are available"
/// before it looks at any component.
fn fp16_variant_usable(entry: &ImageCatalogEntry) -> bool {
    if !entry.fp16_variant {
        return false;
    }
    match snapshot_dirs(entry.repo).into_iter().next() {
        Some(snap) => fp16_present_in_any_component(&snap),
        // Nothing on disk to judge by: the catalog flag stands.
        None => true,
    }
}

fn fp16_present_in_any_component(snap: &std::path::Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(snap.join("model_index.json")) else {
        return true;
    };
    let Ok(manifest) = crate::commands::mlx_snapshot::parse_model_index(&raw) else {
        return true;
    };
    manifest.weights.iter().any(|component| {
        std::fs::read_dir(snap.join(component))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|f| f.file_name().to_str().map(str::to_string))
            .any(|name| {
                // The same splitter the plan uses, so a sharded
                // `model.fp16-00001-of-00002.safetensors` counts too.
                crate::commands::mlx_snapshot::weights_family(&name)
                    .is_some_and(|(_, variant)| variant.as_deref() == Some("fp16"))
            })
    })
}

/// What the download plan asks the hub for.
fn prefer_variant(entry: &ImageCatalogEntry) -> Option<&'static str> {
    entry.fp16_variant.then_some("fp16")
}

/// What the load asks the sidecar for. The same answer as `prefer_variant`
/// wherever the planned files actually landed.
fn load_variant(entry: &ImageCatalogEntry) -> Option<&'static str> {
    fp16_variant_usable(entry).then_some("fp16")
}

/// Audit every snapshot of the repo and keep the best answer. Offline on
/// purpose: the Models page draws this row for each catalog entry and must not
/// wait on the hub to do it.
fn image_model_report(entry: &ImageCatalogEntry) -> crate::commands::mlx_snapshot::SnapshotReport {
    let mut best: Option<crate::commands::mlx_snapshot::SnapshotReport> = None;
    for snap in snapshot_dirs(entry.repo) {
        let report = crate::commands::mlx_snapshot::audit_snapshot(&snap, None, prefer_variant(entry));
        if report.is_complete() {
            return report;
        }
        if best.as_ref().is_none_or(|b| report.defects.len() < b.defects.len()) {
            best = Some(report);
        }
    }
    best.unwrap_or(crate::commands::mlx_snapshot::SnapshotReport {
        blocker: Some("no readable model snapshot was found".into()),
        defects: Vec::new(),
    })
}

fn image_model_is_installed(entry: &ImageCatalogEntry) -> bool {
    if let Some(pack) = entry.mflux {
        return mflux::usable(entry.id, pack);
    }
    image_model_report(entry).is_complete()
}

fn install_failed_message(report: &crate::commands::mlx_snapshot::SnapshotReport) -> String {
    format!(
        "Model installation did not finish: {}. Retry the download to repair the missing files.",
        crate::commands::mlx_snapshot::describe(report)
    )
}

/// The verdict on an install, as `Ok` for the completed slot and `Err` for the
/// failed one. It is a function of its own because the two have to stay apart:
/// a failure message handed to `complete()` paints the row green and offers
/// Remove for a model that cannot load.
fn install_outcome(
    id: &str,
    report: &crate::commands::mlx_snapshot::SnapshotReport,
    fetched: &[String],
) -> Result<String, String> {
    if !report.is_complete() {
        return Err(install_failed_message(report));
    }
    Ok(if fetched.is_empty() {
        format!("{id} installed")
    } else {
        format!("{id} installed, re-fetched {}", fetched.join(", "))
    })
}

/// A repo id is a catalog constant, never user input, but it is about to be
/// pasted into a URL and a Python literal, so it is held to the shape the hub
/// itself allows.
fn is_repo_id(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let (Some(org), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    [org, name].iter().all(|part| {
        !part.is_empty()
            && part.len() <= 96
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    })
}

/// One GET against the hub, with the Settings token when there is one.
fn hub_get(url: &str) -> Result<String, String> {
    crate::commands::note_hub_request();
    crate::commands::proxy::validate_public_url(url)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.get(url);
    if let Some(token) = hf_token() {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .map_err(|e| os_error::english_child_text(&e.to_string()).into_owned())?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        return Err(match hub_denied_message(status, hf_token().is_some()) {
            Some(denied) => denied.to_string(),
            None => format!("the hub answered HTTP {status}"),
        });
    }
    response.text().map_err(|e| e.to_string())
}

/// The commit the hub serves as `main` right now.
///
/// Everything an install does is pinned to it: the file listing, the download
/// and the audit afterwards all have to be talking about the same revision, or
/// a repo updated mid-install leaves a snapshot stitched from two versions.
fn fetch_repo_revision(repo: &str) -> Result<String, String> {
    if !is_repo_id(repo) {
        return Err("not a repository id".into());
    }
    let raw = hub_get(&format!("https://huggingface.co/api/models/{repo}"))?;
    let value: Value = serde_json::from_str(&raw).map_err(|_| "the hub returned an unreadable answer")?;
    let sha = value
        .get("sha")
        .and_then(|s| s.as_str())
        .ok_or("the hub named no commit for this repository")?;
    if sha.len() < 7 || sha.len() > 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("the hub named a commit we cannot use".into());
    }
    Ok(sha.to_string())
}

/// What the repo holds, straight from the hub: every file with its size and,
/// for the LFS-backed weights, its sha256.
pub(crate) fn fetch_repo_listing(
    repo: &str,
    revision: &str,
) -> Result<Vec<crate::commands::mlx_snapshot::RepoFile>, String> {
    if !is_repo_id(repo) {
        return Err("not a repository id".into());
    }
    let raw = hub_get(&format!(
        "https://huggingface.co/api/models/{repo}/tree/{revision}?recursive=true"
    ))?;
    crate::commands::mlx_snapshot::parse_repo_listing(&raw)
}

/// The pipeline manifest, read before the download so the file set can be
/// derived from it rather than guessed.
fn fetch_model_index(
    repo: &str,
    revision: &str,
) -> Result<crate::commands::mlx_snapshot::Manifest, String> {
    if !is_repo_id(repo) {
        return Err("not a repository id".into());
    }
    let raw = hub_get(&format!(
        "https://huggingface.co/{repo}/resolve/{revision}/model_index.json"
    ))?;
    crate::commands::mlx_snapshot::parse_model_index(&raw)
}

/// Fetch one file again and prove it is the file the hub lists.
///
/// The transfer goes through `huggingface_hub` like every other file of this
/// lane, so the blob and its symlink land where the loader expects them. What
/// is new is what happens afterwards: the size has to match and, when the hub
/// states an LFS digest, the sha256 of the bytes on disk has to match it. A
/// file that fails either is removed again instead of being left behind
/// looking installed.
fn refetch_file(
    slot: &crate::install_state::InstallSlot,
    python: &str,
    repo: &str,
    revision: &str,
    snap: &Path,
    repair: &crate::commands::mlx_snapshot::Repair,
) -> Result<(), String> {
    let cache = mlx_root().join("cache");
    if repair.delete_first {
        crate::commands::mlx_snapshot::drop_broken_file(snap, &cache, &repair.path)?;
        slot.log(format!("discarded the broken copy of {}", repair.path));
    }
    if let Some(sha) = &repair.sha256 {
        let dropped = crate::commands::mlx_snapshot::drop_orphaned_partials(snap, sha);
        if dropped > 0 {
            slot.log(format!(
                "cleared {dropped} unfinished transfer(s) of {} that cannot be resumed",
                repair.path
            ));
        }
    }
    slot.log(format!(
        "re-fetching {} ({})",
        repair.path,
        crate::commands::mlx_snapshot::human_bytes(repair.expected_size)
    ));
    let script = format!(
        "from huggingface_hub import hf_hub_download; hf_hub_download(repo_id={r:?}, filename={f:?}, revision={v:?})",
        r = repo,
        f = repair.path,
        v = revision,
    );
    let mut cmd = crate::python::python_command(python);
    cmd.args(["-c", &script]).env("HF_HOME", &cache).env("HF_XET_CACHE", hf_xet_cache_dir());
    apply_hf_token(&mut cmd);
    run_hub_step(slot, &mut cmd, &[&cache]).map_err(|e| format!("re-fetching {}: {e}", repair.path))?;

    let full = snap.join(&repair.path);
    let size = std::fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
    if size != repair.expected_size {
        return Err(format!(
            "{} came back as {} instead of the {} the hub lists for it",
            repair.path,
            crate::commands::mlx_snapshot::human_bytes(size),
            crate::commands::mlx_snapshot::human_bytes(repair.expected_size)
        ));
    }
    if let Some(expected) = &repair.sha256 {
        let actual = crate::commands::mlx_snapshot::sha256_of(&full)
            .map_err(|e| format!("checksumming {}: {e}", repair.path))?;
        if &actual != expected {
            let _ = crate::commands::mlx_snapshot::drop_broken_file(snap, &cache, &repair.path);
            return Err(format!(
                "{} does not match the sha256 the hub lists for it and was discarded",
                repair.path
            ));
        }
        slot.log(format!("{} verified against sha256 {}", repair.path, expected));
    }
    Ok(())
}

pub fn mlx_image_models(_state: &AppState, _args: &Value) -> CmdResult {
    let out: Vec<Value> = IMAGE_CATALOG
        .iter()
        .map(|c| (c, image_model_is_installed(c)))
        .filter(|(c, installed)| !c.retired || *installed)
        .map(|(c, installed)| {
            json!({
                "id": c.id,
                "name": c.name,
                "repo": c.repo,
                // f32→JSON goes through f64 and turns 2.6 into
                // 2.5999999046325684, so round to the tenth the catalog means.
                "sizeGB": (c.size_gb as f64 * 10.0).round() / 10.0,
                "minRamGB": c.min_ram_gb,
                "steps": c.steps,
                "guidance": c.guidance,
                "defaultSize": c.default_size,
                "unfiltered": c.unfiltered,
                "description": c.description,
                "retired": c.retired,
                "installed": installed,
                // Which engine runs it. An "mflux" model brings its engine
                // along, so the interface does not ask for the sidecar's.
                "family": if c.mflux.is_some() { "mflux" } else { "diffusers" },
                // How many images an edit with it takes in all. 0: it makes
                // images from text alone, and Edit does not offer it.
                "editImages": c.mflux.map_or(0, |pack| pack.edit_images()),
                // Whether the steps and the guidance set in Create reach a
                // run. Said for the packs of the second engine alone.
                "userSampling": c.mflux.map(|pack| pack.user_sampling()),
                // Whether a run takes the LoRA stack of Create. The second
                // engine does, the sidecar does not.
                "loras": c.mflux.is_some_and(|pack| pack.takes_loras()),
                // Whether it enhances pictures instead of making them. Such a
                // model is for Enhance Image alone (`mlx_upscale`).
                "upscaler": c.mflux.is_some_and(|pack| pack.upscales()),
            })
        })
        // The prompt enhancers are installed in the same lane and listed in
        // the same list, with a family of their own that keeps them out of
        // every image picker.
        .chain(enhancer::rows())
        .collect();
    Ok(Value::Array(out))
}

pub fn mlx_image_install_model(state: &AppState, args: &Value) -> CmdResult {
    ensure_image_engine_supported()?;
    let id = args
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| crate::commands::bad_request("missing id"))?;
    if let Some(e) = enhancer::lookup(id) {
        return enhancer::install(state, e);
    }
    let entry = image_catalog_lookup(id)
        .ok_or_else(|| crate::commands::bad_request(format!("unknown image model id: {id}")))?;
    // A pack of the second engine brings that engine along and does not need
    // the sidecar's. Its disk check and its claim on the slot are in there.
    if let Some(pack) = entry.mflux {
        return mflux::install(state, entry, pack);
    }
    // The venv binary appears seconds into the engine install, long before
    // pip has filled it. A model install started in that window dies with
    // a cryptic ModuleNotFoundError.
    if state.install_mlx_diffusion().is_running() {
        return Err(crate::commands::bad_request(
            "The image engine is still being set up. Wait for it to finish first.",
        ));
    }
    let engine = engine_state(&mlx_root());
    if engine != EngineState::Ready {
        return Err(crate::commands::bad_request(engine_not_ready_message(engine)));
    }
    if entry.retired {
        return Err(crate::commands::bad_request(format!(
            "{} is no longer in the catalogue",
            entry.name
        )));
    }
    if !image_model_is_installed(entry) {
        crate::commands::system::ensure_free_space(&mlx_root(), entry.name, image_download_bytes_left(entry), "")
            .map_err(crate::commands::bad_request)?;
    }
    // Claimed in one step: a double click on Get used to read "idle" twice
    // and start two downloads into the same cache.
    let slot = state.install_mlx_image_model();
    if !slot.try_start() {
        return Ok(json!({ "ok": true, "status": "installing" }));
    }
    if image_model_is_installed(entry) {
        slot.complete(format!("{} already installed", entry.id));
        return Ok(json!({ "ok": true, "status": "complete", "id": entry.id }));
    }
    let entry2 = entry.clone();
    crate::install_state::spawn_install(slot, move |slot| install_image_model(slot, &entry2));
    Ok(json!({ "ok": true, "status": "installing", "id": entry.id }))
}

fn install_image_model(
    slot: &crate::install_state::InstallSlot,
    entry: &ImageCatalogEntry,
) -> Result<String, String> {
    let python = venv_python().to_string_lossy().to_string();
    bring_engine_up_to_date(slot)?;
    crate::commands::video::ensure_python_module(slot, &python, "huggingface_hub", &["huggingface_hub"])?;
    // Ask the repo what it has before pulling anything. The hand-written
    // allow patterns stay as the offline fallback and nothing more: a
    // pattern that matches no file in this particular repo is how a
    // download finishes at the promised size with a component left empty.
    //
    // A refusal is not a reason to fall back. The hub has just said that
    // this account may not read the repository, and the download would be
    // told the same thing after its own start-up, in a traceback.
    //
    // These are the first requests of the install, and they run here, on the
    // install thread: the click that started it has had its answer already.
    slot.log(format!("asking the hub what {} holds", entry.repo));
    let revision = match fetch_repo_revision(entry.repo) {
        Ok(rev) => Some(rev),
        Err(e) if is_hub_denied(&e) => return Err(e),
        Err(e) => {
            slot.log(format!("could not read the current commit of {} ({e})", entry.repo));
            None
        }
    };
    let listing = revision.as_deref().and_then(|rev| match fetch_repo_listing(entry.repo, rev) {
        Ok(files) => Some(files),
        Err(e) => {
            slot.log(format!(
                "could not read the file list of {} ({e}), falling back to the built-in download patterns",
                entry.repo
            ));
            None
        }
    });
    let prefer = prefer_variant(entry);
    let plan = listing.as_ref().zip(revision.as_deref()).and_then(|(files, rev)| {
        fetch_model_index(entry.repo, rev)
            .map_err(|e| slot.log(format!("could not read model_index.json ({e})")))
            .ok()
            .map(|manifest| crate::commands::mlx_snapshot::plan_download(files, &manifest, prefer))
    });
    let patterns: Vec<String> = match &plan {
        Some(plan) => {
            for component in &plan.without_weights {
                slot.log(format!("{} carries no weights file in this repository", component));
            }
            plan.files.iter().map(|f| f.path.clone()).collect()
        }
        None => entry.allow.iter().map(|p| p.to_string()).collect(),
    };
    let total = plan
        .as_ref()
        .map(|p| p.bytes)
        .unwrap_or((entry.size_gb as f64 * 1e9) as u64);
    slot.log(format!(
        "pulling {} ({})",
        entry.repo,
        crate::commands::mlx_snapshot::human_bytes(total)
    ));
    crate::install_state::watch_dir_size(
        slot.clone(),
        image_model_cache_dir(entry.repo),
        vec![hf_xet_cache_dir()],
        total,
    );

    // A pinned revision also makes the snapshot directory predictable:
    // it is `snapshots/<commit>`, not whatever `refs/main` happens to say
    // afterwards.
    let pin = match &revision {
        Some(rev) => format!(", revision={rev:?}"),
        None => String::new(),
    };
    let script = format!(
        "from huggingface_hub import snapshot_download; snapshot_download(repo_id={r:?}, allow_patterns=[{p}]{pin})",
        r = entry.repo,
        p = patterns.iter().map(|p| format!("{p:?}")).collect::<Vec<_>>().join(","),
    );
    let mut cmd = crate::python::python_command(&python);
    cmd.args(["-c", &script])
        .env("HF_HOME", mlx_root().join("cache"))
        .env("HF_XET_CACHE", hf_xet_cache_dir());
    apply_hf_token(&mut cmd);
    run_hub_step(slot, &mut cmd, &[&mlx_root().join("cache")])?;
    finish_image_install(slot, &python, entry, revision.as_deref(), listing.as_deref())
}

/// After the pull: check what landed, repair what did not, and say so.
///
/// A defect the hub can name is fetched again on the spot, one file at a time,
/// and nothing that verifies is touched. Anything left after that is reported
/// by name, because the sentence the reporter of GitHub 127 saw named nothing
/// at all and left him with a 5 GB download and no way to tell what was wrong.
fn finish_image_install(
    slot: &crate::install_state::InstallSlot,
    python: &str,
    entry: &ImageCatalogEntry,
    revision: Option<&str>,
    listing: Option<&[crate::commands::mlx_snapshot::RepoFile]>,
) -> Result<String, String> {
    use crate::commands::mlx_snapshot as snapshot;
    let prefer = prefer_variant(entry);
    let pinned = revision
        .map(|rev| image_model_cache_dir(entry.repo).join("snapshots").join(rev))
        .filter(|dir| dir.is_dir());
    let Some(snap) = pinned.or_else(|| snapshot_dirs(entry.repo).into_iter().next()) else {
        return Err(install_failed_message(&snapshot::SnapshotReport {
            blocker: Some("no readable model snapshot was found".into()),
            defects: Vec::new(),
        }));
    };
    let report = snapshot::audit_snapshot(&snap, listing, prefer);
    if report.is_complete() {
        name_installed_main(slot, entry, &snap);
        return install_outcome(entry.id, &report, &[]);
    }
    let (repairs, stuck) = snapshot::repair_plan(&report.defects);
    if repairs.is_empty() {
        return install_outcome(entry.id, &report, &[]);
    }
    slot.log(format!(
        "{} file(s) of the snapshot are missing or damaged, fetching them again",
        repairs.len()
    ));
    let mut fetched: Vec<String> = Vec::new();
    for repair in &repairs {
        if let Err(e) = refetch_file(slot, python, entry.repo, revision.unwrap_or("main"), &snap, repair) {
            slot.log(e);
        } else {
            fetched.push(repair.path.clone());
        }
    }
    for defect in &stuck {
        slot.log(format!("{} cannot be fetched again on its own", defect.path));
    }
    let repaired = snapshot::audit_snapshot(&snap, listing, prefer);
    if repaired.is_complete() {
        name_installed_main(slot, entry, &snap);
    }
    install_outcome(entry.id, &repaired, &fetched)
}

/// After an install: the repo name has to open the snapshot just verified.
fn name_installed_main(slot: &crate::install_state::InstallSlot, entry: &ImageCatalogEntry, snap: &std::path::Path) {
    if let Err(e) = name_main_revision(&image_model_cache_dir(entry.repo), snap) {
        slot.log(format!("could not record the installed revision: {e}"));
    }
}

pub fn mlx_image_install_status(state: &AppState, _args: &Value) -> CmdResult {
    Ok(serde_json::to_value(state.install_mlx_image_model().snapshot()).unwrap())
}

/// Stop what the image lane is installing: the model download, or the engine
/// setup under it. What a download fetched so far stays in the hub cache, and
/// a stopped engine setup continues from the packages pip already has.
///
/// The engine setup had no way to be stopped at all: pip ran behind
/// `.output()`, so there was no process to end and ten minutes of silence
/// (Fehlerkontrolle Mac, 08.10.2026, Fund 4). Both slots answer to the one
/// cancel the image lane already has.
pub fn mlx_image_cancel_install(state: &AppState, _args: &Value) -> CmdResult {
    let cancelled = cancel_image_installs(&state.install_mlx_image_model(), &state.install_mlx_diffusion());
    Ok(json!({ "ok": true, "cancelled": cancelled }))
}

fn cancel_image_installs(
    model: &crate::install_state::InstallSlot,
    engine: &crate::install_state::InstallSlot,
) -> bool {
    let model = model.cancel();
    let engine = engine.cancel();
    model || engine
}

/// Remove a model's files, and with them the Xet chunk cache.
///
/// huggingface_hub 1.x downloads through `cache/xet`, a sibling of the repo
/// folder that holds up to 10 GB of chunks. Removing the repo folder left
/// those behind with no row in the app to remove them from. The chunks are a
/// transfer cache and nothing loads from them: every installed model keeps its
/// complete files under `cache/hub`. Returns the cache bytes that were freed.
fn remove_image_model_files(model_dir: &Path, xet_cache: &Path) -> std::io::Result<u64> {
    std::fs::remove_dir_all(model_dir)?;
    let freed = crate::install_state::dir_size(xet_cache);
    if xet_cache.is_dir() {
        let _ = std::fs::remove_dir_all(xet_cache);
    }
    Ok(freed)
}

pub fn mlx_image_delete_model(state: &AppState, args: &Value) -> CmdResult {
    let id = args
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| crate::commands::bad_request("missing id"))?;
    // An image model, or else a prompt enhancer of the same lane.
    let (entry, enhancer) = match (image_catalog_lookup(id), enhancer::lookup(id)) {
        (None, None) => return Err(crate::commands::bad_request(format!("unknown image model id: {id}"))),
        found => found,
    };
    // The engine setup pulls the starter model through the same cache.
    if state.install_mlx_image_model().is_running() || state.install_mlx_diffusion().is_running() {
        return Err(crate::commands::bad_request(
            "An install is running. Wait for it to finish first.",
        ));
    }
    let Some(entry) = entry else {
        // Not an image model, so the enhancer it was found as.
        return enhancer.map_or_else(|| Err(crate::commands::bad_request(format!("unknown image model id: {id}"))), enhancer::delete);
    };
    if let Some(pack) = entry.mflux {
        return mflux::delete(entry, pack);
    }
    let dir = image_model_cache_dir(entry.repo);
    if !dir.is_dir() {
        return Err(crate::commands::not_found(format!("{id} is not installed")));
    }
    let freed = remove_image_model_files(&dir, &hf_xet_cache_dir())
        .map_err(|e| crate::commands::internal(format!("delete {id}: {}", os_error::english(&e))))?;
    Ok(json!({ "ok": true, "id": id, "freedCacheBytes": freed }))
}

#[derive(Deserialize)]
struct GenerateArgs {
    prompt: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    steps: Option<u32>,
    #[serde(default)]
    seed: Option<u64>,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    negative_prompt: Option<String>,
    #[serde(default)]
    guidance: Option<f32>,
    /// The images of an edit as paths, the one that is edited first.
    #[serde(default)]
    images: Vec<String>,
    /// The side an edit scales its images to. See `mflux::Request`.
    #[serde(default)]
    resolution: Option<u32>,
    /// The mask of an edit as a path, painted over the first image. See
    /// `mflux::Request`.
    #[serde(default)]
    mask: Option<String>,
    /// How far an edit starts from noise, in (0, 1]. See `mflux::Request`.
    #[serde(default)]
    strength: Option<f32>,
    /// The name the caller gives this run. Cancel carries the same one, and
    /// then ends this run and no other.
    #[serde(default)]
    run: Option<String>,
    /// The LoRA stack: files of the LoRA folder by name, each with its
    /// strength, in the order they were picked. See `mlx_loras`.
    #[serde(default)]
    loras: Vec<LoraArg>,
    /// How long an image of the sidecar may go without any progress before
    /// it is ended, in seconds (Settings, Image timeout). Absent: 20 minutes.
    #[serde(default)]
    stall_timeout_secs: Option<u64>,
}

#[derive(serde::Deserialize)]
struct LoraArg {
    name: String,
    #[serde(default = "full_strength")]
    strength: f32,
}

fn full_strength() -> f32 {
    1.0
}

/// One image the sidecar is at.
struct SidecarRun {
    key: u64,
    run: Option<String>,
    cancelled: bool,
}

/// The images the sidecar is at right now. One request per image. Cancel
/// marks it here and asks the sidecar to stop between two steps; where it
/// cannot (the model is still loading), the request runs to its end with the
/// model in memory, `/unload` waits behind it, and what comes back is dropped.
static SIDECAR_RUNS: std::sync::Mutex<Vec<SidecarRun>> = std::sync::Mutex::new(Vec::new());
static SIDECAR_KEYS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn sidecar_runs() -> std::sync::MutexGuard<'static, Vec<SidecarRun>> {
    SIDECAR_RUNS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Held from before the request to the sidecar goes out until `mlx_generate`
/// is left, on whichever way.
struct SidecarImage(u64);

impl SidecarImage {
    fn begin(run: Option<String>) -> Self {
        let key = SIDECAR_KEYS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        sidecar_runs().push(SidecarRun { key, run, cancelled: false });
        Self(key)
    }

    /// Cancel was pressed for this image while it was under way.
    fn cancelled(&self) -> bool {
        sidecar_runs().iter().any(|r| r.key == self.0 && r.cancelled)
    }
}

impl Drop for SidecarImage {
    fn drop(&mut self) {
        sidecar_runs().retain(|r| r.key != self.0);
    }
}

fn sidecar_at_an_image() -> bool {
    !sidecar_runs().is_empty()
}

/// Mark the images Cancel means: the one with this name, or every one when
/// it names none. `false`: the sidecar is at no such image.
fn cancel_sidecar_images(run: Option<&str>) -> bool {
    let mut any = false;
    for image in sidecar_runs().iter_mut().filter(|r| run.is_none() || r.run.as_deref() == run) {
        image.cancelled = true;
        any = true;
    }
    any
}

/// What `mlx_generate` answers for an image that was cancelled. Create does
/// not show it: it has let go of the run already.
const IMAGE_CANCELLED: &str = "The image was cancelled.";

// ── How long an image of the sidecar may take (C71) ──────────────────
//
// The request used to carry one fixed limit of 900 s, the model load
// included. Chroma1-HD at 40 steps and 1024 with real CFG takes longer than
// that on an M1 Max, and the cut-off request came back as "mlx unreachable".
// The sidecar now says how far it is (`GET /progress`), and a run is ended
// only when nothing has moved for the limit set in Settings (Image timeout,
// the same setting ComfyUI renders use). A model that loads gets at least
// the old 15 minutes for that alone, whatever the setting.

/// The limit when the request names none: Settings' default Image timeout.
const SIDECAR_STALL_DEFAULT: std::time::Duration = std::time::Duration::from_secs(20 * 60);
/// What a model load always gets, as much as the whole request had before.
const SIDECAR_LOAD_FLOOR: std::time::Duration = std::time::Duration::from_secs(15 * 60);
/// The range Settings allows: 1 to 480 minutes.
const SIDECAR_STALL_MIN_SECS: u64 = 60;
const SIDECAR_STALL_MAX_SECS: u64 = 480 * 60;
/// How often the watch asks the sidecar.
const SIDECAR_WATCH_EVERY: std::time::Duration = std::time::Duration::from_secs(5);

/// The limit a request asks for, held to the range Settings allows.
fn sidecar_stall_limit(asked: Option<u64>) -> std::time::Duration {
    asked.map_or(SIDECAR_STALL_DEFAULT, |s| {
        std::time::Duration::from_secs(s.clamp(SIDECAR_STALL_MIN_SECS, SIDECAR_STALL_MAX_SECS))
    })
}

/// What the sidecar says about the image under way (`GET /progress`).
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
struct SidecarProgress {
    phase: String,
    #[serde(default)]
    step: u32,
    #[serde(default)]
    steps: u32,
    #[serde(default)]
    step_hook: bool,
    #[serde(default)]
    quiet_seconds: f64,
}

/// Ask the sidecar how far its image is. `None`: no answer, or a sidecar
/// from before 3.1.0 that has no `/progress`.
fn sidecar_progress() -> Option<SidecarProgress> {
    parse_sidecar_progress(&sidecar_ask(MLX_PORT, "GET", "/progress")?)
}

fn parse_sidecar_progress(answer: &str) -> Option<SidecarProgress> {
    let (head, body) = answer.split_once("\r\n\r\n")?;
    if head.lines().next()?.split_whitespace().nth(1)? != "200" {
        return None;
    }
    serde_json::from_str(body).ok()
}

/// "1 minute", "20 minutes", "90 seconds".
fn human_span(d: std::time::Duration) -> String {
    let s = d.as_secs();
    if s >= 60 && s % 60 == 0 {
        let m = s / 60;
        format!("{m} {}", if m == 1 { "minute" } else { "minutes" })
    } else {
        format!("{s} seconds")
    }
}

/// Whether the image of the sidecar has gone quiet for longer than it may,
/// and the sentence that says so. `elapsed` is the time since the request
/// went out, used only when the sidecar does not say how far it is.
fn sidecar_stall_verdict(
    model: &str,
    progress: Option<&SidecarProgress>,
    elapsed: std::time::Duration,
    limit: std::time::Duration,
) -> Option<String> {
    let load_limit = limit.max(SIDECAR_LOAD_FLOOR);
    const WAY_OUT: &str = "Raise Image timeout in Settings, or try fewer steps or a smaller size.";
    let Some(p) = progress else {
        // Nothing to go by: the whole request gets what a load gets.
        return (elapsed >= load_limit).then(|| {
            format!("{model} timed out after {} without saying how far it was. {WAY_OUT}", human_span(load_limit))
        });
    };
    let quiet = std::time::Duration::from_secs_f64(p.quiet_seconds.max(0.0));
    match p.phase.as_str() {
        "waiting" | "loading" if quiet >= load_limit => Some(format!(
            "{model} timed out while loading: nothing moved for {}. {WAY_OUT}",
            human_span(load_limit)
        )),
        "steps" if quiet >= limit && p.step_hook && p.steps > 0 => Some(format!(
            "{model} timed out at step {} of {}: no new step for {}. {WAY_OUT}",
            p.step,
            p.steps,
            human_span(limit)
        )),
        "steps" | "saving" if quiet >= limit => {
            Some(format!("{model} timed out: no progress for {}. {WAY_OUT}", human_span(limit)))
        }
        _ => None,
    }
}

/// A request to the sidecar that must not wait: Cancel is one click and the
/// answer is nothing the caller needs. `None`: nobody answered in time.
fn sidecar_ask(port: u16, method: &str, path: &str) -> Option<String> {
    use std::io::{Read, Write};
    let addr = format!("127.0.0.1:{port}").parse::<std::net::SocketAddr>().ok()?;
    let mut stream = std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)).ok()?;
    let wait = Some(std::time::Duration::from_secs(2));
    let _ = stream.set_read_timeout(wait);
    let _ = stream.set_write_timeout(wait);
    stream
        .write_all(format!("{method} {path} HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\n\r\n").as_bytes())
        .ok()?;
    let mut answer = Vec::new();
    let _ = stream.take(16 * 1024).read_to_end(&mut answer);
    Some(String::from_utf8_lossy(&answer).into_owned())
}

/// What a finished image of the sidecar becomes: the answer for Create with
/// the file beside it, or nothing at all when it was cancelled on the way.
fn keep_sidecar_image(cancelled: bool, mut payload: Value, guidance: f32, dir: &Path) -> CmdResult {
    // Cancelled while the model loaded or in the last step: the image is
    // there all the same. It is not written to disk and not handed on, or it
    // would lie under `images/` with no entry in the gallery.
    if cancelled {
        return Err(crate::commands::internal(IMAGE_CANCELLED));
    }
    // Also put the PNG on disk and hand back its path.
    //
    // The base64 alone is not enough to build a gallery: createStore's
    // partialize strips `dataUrl` (megabytes of base64 would blow the
    // localStorage quota), so after a restart a Mac-generated image had
    // nothing left to display and the gallery fell through to a ComfyUI
    // /view URL that can never resolve here. A file under the app's own
    // media root can be re-read through read_media_file, exactly like the
    // MLX video lane already does with its mp4.
    //
    // Best effort on purpose: a full disk must not fail a render the user
    // is looking at. They lose durability, not the image.
    let written = payload.get("image_base64").and_then(|v| v.as_str()).map(|b64| write_generated_png(dir, b64));
    if let Some(obj) = payload.as_object_mut() {
        match written {
            Some(Ok(path)) => {
                obj.insert("output".into(), json!(path.to_string_lossy()));
            }
            Some(Err(e)) => println!("[MLX] could not persist the render ({e}), the gallery entry stays session-only"),
            None => {}
        }
        // What the run took, for the entry in the gallery: the sidecar runs
        // at the catalogue's guidance whatever Create's slider says.
        obj.insert("guidance".into(), json!(guidance));
    }
    Ok(payload)
}

pub async fn mlx_generate(_state: &AppState, args: &Value) -> CmdResult {
    let req: GenerateArgs = serde_json::from_value(args.clone())
        .map_err(|e| crate::commands::bad_request(e.to_string()))?;

    // Resolve the catalog entry — the sidecar is model-agnostic and gets the
    // full load config per request; unknown/absent id falls back to sd-turbo.
    let entry = req
        .model
        .as_deref()
        .and_then(image_catalog_lookup)
        .unwrap_or(&IMAGE_CATALOG[0]);

    ensure_image_engine_supported()?;
    if entry.mflux.is_some_and(|pack| pack.upscales()) {
        // Run as a model of its own it would be handed a prompt it has no
        // flag for. It enhances the picture on the Stage (`mlx_upscale`).
        return Err(crate::commands::bad_request(format!(
            "{} enhances pictures and makes none from a prompt. Open Enhance Image to use it.",
            entry.name
        )));
    }
    // One model in the memory at a time: a track of the music lane holds its
    // own until it is through.
    if crate::commands::music::busy() {
        return Err(crate::commands::bad_request("A track is being made on this Mac. Wait for it to finish, then make the image."));
    }
    if let Some(why) = train::refusal() {
        return Err(crate::commands::bad_request(why));
    }
    if let Some(too_big) = memory_verdict(entry.name, entry.min_ram_gb, total_memory_bytes()) {
        return Err(crate::commands::bad_request(too_big));
    }
    if let Some(pack) = entry.mflux {
        // Before anything is unloaded: an edit this model cannot do, or
        // whose image is gone, is refused and never run without the image.
        let images = mflux::request_images(entry, pack, &req.images).map_err(crate::commands::bad_request)?;
        // Every picture of an edit costs memory of its own (`edit_peak_gb`).
        let side = req.resolution.unwrap_or(1024);
        if let Some(too_big) = edit_memory_verdict(images.len(), side, f64::from(entry.size_gb), total_memory_bytes()) {
            return Err(crate::commands::bad_request(too_big));
        }
        let mask = mflux::request_mask(&images, req.mask.as_deref()).map_err(crate::commands::bad_request)?;
        let strength = mflux::request_strength(&images, req.strength);
        // The same for the LoRA stack: a file that is gone, is not in the
        // folder or is in a format this model cannot read is said now, and
        // not after minutes of loading.
        let asked: Vec<(String, f32)> = req.loras.iter().map(|l| (l.name.clone(), l.strength)).collect();
        let loras = mflux::request_loras(entry, pack, &asked).map_err(crate::commands::bad_request)?;
        // An image in the sidecar holds its model until it is through, and
        // the unload below would wait behind it and then be given up on. The
        // second engine would load its pack next to it, into the one memory.
        if sidecar_at_an_image() {
            return Err(crate::commands::bad_request(
                "The previous image is still finishing. Try again in a moment.",
            ));
        }
        // The run has its place from here on, before its process exists:
        // the unload below can take seconds, and in them a Remove of the
        // pack or an image in the sidecar would have read "nothing runs".
        let _claim = mflux::claim_run(req.run.clone()).ok_or_else(|| {
            crate::commands::bad_request("An image is already being generated on this Mac. Wait for it to finish.")
        })?;
        // Both engines load into the one memory the Mac has. What the
        // sidecar holds goes first, and a sidecar that does not answer is
        // not a reason to refuse the image.
        let _ = mlx_unload(_state, &Value::Null).await;
        let request = mflux::Request {
            prompt: req.prompt,
            negative_prompt: req.negative_prompt,
            steps: req.steps,
            guidance: req.guidance,
            seed: req.seed,
            width: req.width,
            height: req.height,
            images,
            resolution: req.resolution,
            mask,
            strength,
            loras,
        };
        return mflux::generate(entry, pack, request).await;
    }
    if !req.images.is_empty() {
        // The sidecar makes images from text. Run without the image, the
        // prompt alone made an unrelated picture and passed it off as the edit.
        return Err(crate::commands::bad_request(format!(
            "{} cannot edit an image. Pick Qwen-Image 2.1 for Edit.",
            entry.name
        )));
    }
    if !req.loras.is_empty() {
        // The sidecar has no place for a LoRA. Run without it, the image
        // would pass for one made with the style that was picked.
        return Err(crate::commands::bad_request(format!(
            "{} takes no LoRA. Turn the LoRA stack off, or pick one of the quantized MLX models.",
            entry.name
        )));
    }
    if mflux::busy() {
        return Err(crate::commands::bad_request(
            "An image is already being generated on this Mac. Wait for it to finish.",
        ));
    }
    // A model that was removed while its tile was still picked. Sent on, the
    // sidecar would fetch all of it again from the hub without a word, in
    // the middle of what looks like a generation.
    if !image_model_is_installed(entry) {
        return Err(crate::commands::bad_request(format!(
            "{} is not installed. Install it in the Model Manager first.",
            entry.name
        )));
    }
    // A sidecar that died on its way up has already said why. Asking the
    // dead port would only add a wait and replace the reason with "refused".
    if !sidecar_running() {
        if let Some(why) = sidecar_failure() {
            return Err(crate::commands::internal(why));
        }
    }

    name_installed_snapshot(entry);
    let at_image = SidecarImage::begin(req.run.clone());
    let client = reqwest::Client::builder()
        // No limit on the whole request: a big pipeline (Chroma1-HD, Qwen-Image)
        // takes minutes to page in and many more to run. The watch below ends
        // a run that stops moving (C71).
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| crate::commands::internal(e.to_string()))?;

    let body = json!({
        "prompt": req.prompt,
        "negative_prompt": req.negative_prompt,
        "steps": req.steps.unwrap_or(entry.steps),
        "seed": req.seed,
        "width": req.width.unwrap_or(entry.default_size),
        "height": req.height.unwrap_or(entry.default_size),
        "model_repo": entry.repo,
        "dtype": entry.dtype,
        "variant": load_variant(entry),
        "guidance": entry.guidance,
        "cfg_param": entry.cfg_param,
        "disable_safety_checker": entry.disable_safety_checker,
        // We already own every file of this model — say so, and the load stops
        // going to the hub. That is what makes an offline render possible.
        "local_files_only": image_model_is_installed(entry),
    });
    let limit = sidecar_stall_limit(req.stall_timeout_secs);
    let started = std::time::Instant::now();
    let model = entry.name;
    let watch = async move {
        loop {
            tokio::time::sleep(SIDECAR_WATCH_EVERY).await;
            let progress = tokio::task::spawn_blocking(sidecar_progress).await.ok().flatten();
            if let Some(why) = sidecar_stall_verdict(model, progress.as_ref(), started.elapsed(), limit) {
                break why;
            }
        }
    };
    let sent = client.post(format!("http://127.0.0.1:{MLX_PORT}/generate")).json(&body).send();
    let res = tokio::select! {
        res = sent => res.map_err(|e| {
            crate::commands::internal(sidecar_failure().unwrap_or_else(|| {
                if e.is_timeout() {
                    format!("{model} timed out: {}", os_error::english(&e))
                } else {
                    format!("mlx unreachable: {}", os_error::english(&e))
                }
            }))
        })?,
        why = watch => {
            // The request is let go here; the sidecar stops at the end of the
            // step it is in and frees its lock for the next image.
            let _ = tokio::task::spawn_blocking(|| sidecar_ask(MLX_PORT, "POST", "/cancel")).await;
            tracing::warn!(target: "mlx", "{why}");
            return Err(crate::commands::internal(why));
        }
    };
    if !res.status().is_success() {
        // The sidecar ended the image between two steps because it was asked to.
        if at_image.cancelled() {
            return Err(crate::commands::internal(IMAGE_CANCELLED));
        }
        let s = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(crate::commands::internal(format!("HTTP {s}: {text}")));
    }
    let payload: Value = res
        .json()
        .await
        .map_err(|e| crate::commands::internal(e.to_string()))?;
    keep_sidecar_image(at_image.cancelled(), payload, entry.guidance, &images_root())
}

/// "Improve my prompt" with Qwen-Image 2.1 on a Mac: rewrite a prompt with an
/// installed prompt enhancer (`enhancer::enhance`). It takes the place of an
/// image, so Cancel in Create ends it through `mlx_generate_cancel` by the
/// name of its run, and the quit path ends it with an image's.
pub async fn mlx_enhance_prompt(state: &AppState, args: &Value) -> CmdResult {
    enhancer::enhance(state, args).await
}

/// Where generated stills live. Sibling of the video lane's outputs root and
/// covered by the same read_media_file allow-list.
pub(crate) fn images_root() -> PathBuf {
    crate::os_paths::config_root().join("images")
}

fn write_generated_png(dir: &Path, b64: &str) -> Result<PathBuf, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("decode: {e}"))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {}", dir.display(), os_error::english(&e)))?;
    // Millisecond stamp + the process id: two renders inside the same
    // millisecond (batching, a retry) must not overwrite each other.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("mlx-{stamp}-{}.png", std::process::id()));
    std::fs::write(&path, bytes).map_err(|e| format!("write {}: {}", path.display(), os_error::english(&e)))?;
    Ok(path)
}

// ── The sidecar process ───────────────────────────────────────────────
//
// `mlx_start` used to spawn the server and drop the handle. Nobody could tell
// when it died: the caller waited 30 s for the port, tried to render, waited
// another 30 s and showed "mlx unreachable: Connection refused", while the
// reason sat in `server.log`. The dropped child was never waited on either,
// so a dead one stayed in the process table as a zombie (Fehlerkontrolle Mac,
// 08.10.2026, Fund 8). The handle is kept now, and asking after it is how a
// death is noticed within one status poll.

struct Sidecar {
    child: std::process::Child,
    log: PathBuf,
    /// Where this run's output begins in the log, which is appended to.
    log_from: u64,
    /// The engine this server was started from.
    engine_root: PathBuf,
}

struct SidecarSlot {
    live: Option<Sidecar>,
    /// Why the last server ended, until the next start.
    failure: Option<String>,
}

impl SidecarSlot {
    const fn new() -> Self {
        Self { live: None, failure: None }
    }

    fn hold(&mut self, child: std::process::Child, log: PathBuf, log_from: u64, engine_root: PathBuf) {
        self.stop();
        self.live = Some(Sidecar { child, log, log_from, engine_root });
    }

    /// Look after the child. One that has ended is reaped here, its reason is
    /// read from the log, and an engine that proved to miss a package loses
    /// its record so the setup button comes back.
    fn failure(&mut self) -> Option<String> {
        if let Some(side) = self.live.as_mut() {
            if let Ok(Some(status)) = side.child.try_wait() {
                let said = read_log_from(&side.log, side.log_from);
                let verdict = sidecar_failure_reason(&said, status.code());
                if verdict.engine_damaged {
                    mark_engine_broken(&side.engine_root);
                }
                self.failure = Some(verdict.message);
                self.live = None;
            }
        }
        self.failure.clone()
    }

    fn is_alive(&mut self) -> bool {
        self.failure();
        self.live.is_some()
    }

    /// End the server we started and forget how the last one ended.
    fn stop(&mut self) {
        if let Some(mut side) = self.live.take() {
            let _ = side.child.kill();
            let _ = side.child.wait();
        }
        self.failure = None;
    }
}

static SIDECAR: std::sync::Mutex<SidecarSlot> = std::sync::Mutex::new(SidecarSlot::new());

fn sidecar() -> std::sync::MutexGuard<'static, SidecarSlot> {
    SIDECAR.lock().unwrap_or_else(|e| e.into_inner())
}

/// Why the sidecar is not running, when it ended by itself.
fn sidecar_failure() -> Option<String> {
    sidecar().failure()
}

/// End the sidecar this process started. The quit path calls this before it
/// sweeps the port, so the child is waited on and not left to init.
pub(crate) fn stop_sidecar() {
    sidecar().stop();
}

/// Whether an image is being made right now, by either engine. The music
/// lane asks this before it loads its model into the same memory.
pub(crate) fn image_engine_busy() -> bool {
    mflux::busy() || sidecar_at_an_image()
}

/// End an image generation of the second engine. It runs as a process of its
/// own that holds the whole model, and nothing else would end it at quit.
pub(crate) fn stop_mflux() {
    mflux::stop();
}

/// At app start on a Mac: end the image generation a session that ended hard
/// left running. See `mflux::reap_orphaned_run`.
#[cfg(target_os = "macos")]
pub(crate) fn reap_orphaned_mflux() {
    if let Some(pid) = mflux::reap_orphaned_run() {
        tracing::warn!(target: "mflux", pid, "ended an image generation orphaned by a previous run");
    }
}

/// For `commands::real_run_mac`: see `mflux::install_engine_alone`.
#[cfg(all(test, target_os = "macos"))]
pub(crate) fn real_run_install_mflux_engine(state: &AppState) -> bool {
    mflux::install_engine_alone(state)
}

/// How far the image is that the second engine is making: `running`, `step`
/// and `steps`. An image of the sidecar reports its steps where its pipeline
/// counts them (`GET /progress`); one that does not leaves `running` false.
pub fn mlx_generate_progress(_state: &AppState, _args: &Value) -> CmdResult {
    let engine = mflux::progress();
    if engine.get("running").and_then(Value::as_bool) == Some(true) || !sidecar_at_an_image() {
        return Ok(engine);
    }
    // An image of the sidecar: its steps, where its pipeline counts them (C71).
    Ok(match sidecar_progress() {
        Some(p) if p.phase == "steps" && p.step_hook && p.steps > 0 => {
            json!({ "running": true, "step": p.step, "steps": p.steps })
        }
        _ => engine,
    })
}

/// Cancel in Create: end the image that is being made. `run` is the name
/// its `mlx_generate` carried, and only that run is ended: Create repeats the
/// call until its request is back, and by then the next image may be running.
///
/// The second engine's process is ended and `mlx_generate` answers with the
/// sentence for a stopped run. The sidecar is asked to stop between two
/// steps (`/cancel`), and whatever its request still brings back is dropped.
/// `stopped` is false when there was no such image.
pub fn mlx_generate_cancel(_state: &AppState, args: &Value) -> CmdResult {
    let run = args.get("run").and_then(|v| v.as_str());
    let engine = mflux::stop_run(run);
    let sidecar = cancel_sidecar_images(run);
    if sidecar {
        let _ = sidecar_ask(MLX_PORT, "POST", "/cancel");
    }
    Ok(json!({ "ok": true, "stopped": engine || sidecar }))
}

#[derive(serde::Deserialize)]
struct UpscaleArgs {
    /// The staged picture, as a path in the folder Create stages images in.
    image: String,
    /// The factor, 2 or 4. Absent: 2.
    #[serde(default)]
    scale: Option<u32>,
    #[serde(default)]
    seed: Option<u64>,
    /// The catalogue id of the upscaler. Absent: the first one installed.
    #[serde(default)]
    model: Option<String>,
    /// The name of the run, as for `mlx_generate`: Cancel ends this one.
    #[serde(default)]
    run: Option<String>,
}

/// The upscaler a run takes: the one asked for, else the first installed.
fn upscaler_for(asked: Option<&str>) -> Result<(&'static ImageCatalogEntry, &'static mflux::Pack), String> {
    let upscalers = IMAGE_CATALOG.iter().filter_map(|c| c.mflux.filter(|p| p.upscales()).map(|p| (c, p)));
    match asked {
        Some(id) => upscalers
            .into_iter()
            .find(|(c, _)| c.id == id)
            .ok_or_else(|| format!("{id} does not enhance images. Install SeedVR2 3B in the Model Manager.")),
        None => {
            let all: Vec<_> = upscalers.collect();
            all.iter()
                .find(|(c, _)| image_model_is_installed(c))
                .or(all.first())
                .copied()
                .ok_or_else(|| "No model that enhances images is in the catalogue.".to_string())
        }
    }
}

/// Enhance Image on a Mac: `args.image` is the path of a staged picture,
/// `args.scale` the factor (2 or 4). SeedVR2 on the second engine makes it
/// larger. Answers like `mlx_generate`: `image_base64`, `width`, `height`,
/// `steps`, `output`. Progress and Cancel are those of `mlx_generate`
/// (`mlx_generate_progress`, `mlx_generate_cancel` with the same `run`).
pub async fn mlx_upscale(_state: &AppState, args: &Value) -> CmdResult {
    let req: UpscaleArgs = serde_json::from_value(args.clone()).map_err(|e| crate::commands::bad_request(e.to_string()))?;
    let (entry, pack) = upscaler_for(req.model.as_deref()).map_err(crate::commands::bad_request)?;
    ensure_image_engine_supported()?;
    if let Some(why) = train::refusal() {
        return Err(crate::commands::bad_request(why));
    }
    if let Some(too_big) = memory_verdict(entry.name, entry.min_ram_gb, total_memory_bytes()) {
        return Err(crate::commands::bad_request(too_big));
    }
    // Before anything is unloaded: a model that is not there, a picture that
    // is gone or a factor the run does not take is said now.
    if !image_model_is_installed(entry) {
        return Err(crate::commands::bad_request(format!(
            "{} is not installed. Install it in the Model Manager first.",
            entry.name
        )));
    }
    let input = mflux::request_upscale_input(&req.image).map_err(crate::commands::bad_request)?;
    let factor = req.scale.unwrap_or(mflux::UPSCALE_FACTORS[0]);
    if !mflux::UPSCALE_FACTORS.contains(&factor) {
        return Err(crate::commands::bad_request(format!("Enhance enlarges by 2x or 4x, not {factor}x.")));
    }
    // The size of the result decides the memory, so it is worked out here,
    // before the sidecar's model is unloaded for nothing.
    if let Ok((width, height)) = image::image_dimensions(&input) {
        if let Ok((_, out_width, out_height)) = mflux::upscale_target(width, height, factor) {
            if let Some(too_big) = upscale_memory_verdict(out_width, out_height, factor, total_memory_bytes()) {
                return Err(crate::commands::bad_request(too_big));
            }
        }
    }
    // As for an image of the second engine: not beside an image in the
    // sidecar, the place taken before the unload, and the sidecar's model
    // out of memory before SeedVR2 is loaded into it.
    if sidecar_at_an_image() {
        return Err(crate::commands::bad_request("The previous image is still finishing. Try again in a moment."));
    }
    let _claim = mflux::claim_run(req.run.clone())
        .ok_or_else(|| crate::commands::bad_request("An image is already being generated on this Mac. Wait for it to finish."))?;
    let _ = mlx_unload(_state, &Value::Null).await;
    mflux::upscale(entry, pack, input, factor, req.seed).await
}

fn read_log_from(log: &Path, from: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(log) else {
        return String::new();
    };
    if file.seek(SeekFrom::Start(from)).is_err() {
        return String::new();
    }
    let mut bytes = Vec::new();
    let _ = file.take(256 * 1024).read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

struct SidecarVerdict {
    message: String,
    /// The venv lacks a package: only a new setup helps.
    engine_damaged: bool,
}

/// One sentence for a server that ended, from what it wrote before it did.
fn sidecar_failure_reason(said: &str, code: Option<i32>) -> SidecarVerdict {
    let lines: Vec<&str> = said.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    // The server's own last word, when it got to say one (server.py, `_fatal`).
    let fatal = lines.iter().rev().find_map(|l| l.strip_prefix("LU_MLX_FATAL: "));
    let missing = lines.iter().rev().find(|l| {
        l.starts_with("ModuleNotFoundError") || l.starts_with("ImportError") || l.contains("missing package")
    });
    if let Some(line) = missing {
        return SidecarVerdict {
            message: format!(
                "The image engine is incomplete ({}). Set it up again in the Model Manager.",
                truncate(line.trim_start_matches("LU_MLX_FATAL: "), 200)
            ),
            engine_damaged: true,
        };
    }
    let lower = said.to_lowercase();
    if lower.contains("address already in use") || lower.contains("already in use") {
        return SidecarVerdict {
            message: format!(
                "The image engine could not start because port {MLX_PORT} is used by another program. Quit that program, then try again."
            ),
            engine_damaged: false,
        };
    }
    let last = fatal.or(lines.last().copied());
    let message = match (code, last) {
        // No exit code means a signal. Nothing in this app sends one to a
        // server it still holds, so it was the system, and on a Mac that is
        // memory pressure far more often than anything else.
        (None, _) => "The image engine was ended by the system. This usually means the model did not fit into memory. Pick a smaller model or close other apps.".to_string(),
        (Some(_), Some(line)) => format!("The image engine stopped: {}", truncate(line, 300)),
        (Some(code), None) => format!("The image engine stopped with exit code {code} and no message."),
    };
    SidecarVerdict { message, engine_damaged: false }
}

/// Who answers on the sidecar's port.
#[derive(Debug, PartialEq, Eq)]
enum PortOwner {
    Free,
    /// A sidecar of ours, left behind by a session that ended hard.
    Ours,
    Foreign,
}

/// After a crash or a `kill -9` the sidecar outlives the app, because only the
/// regular quit path sweeps its port. The next start then spawned a second
/// server that died on the occupied port. So the port is asked first: our own
/// server answers `/health` with a field nothing else has.
fn port_owner(port: u16) -> PortOwner {
    use std::io::{Read, Write};
    let wait = std::time::Duration::from_millis(700);
    let Ok(addr) = format!("127.0.0.1:{port}").parse::<std::net::SocketAddr>() else {
        return PortOwner::Free;
    };
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(200)) else {
        return PortOwner::Free;
    };
    let _ = stream.set_read_timeout(Some(wait));
    let _ = stream.set_write_timeout(Some(wait));
    let _ = stream.write_all(b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n");
    let mut answer = Vec::new();
    let _ = stream.take(4096).read_to_end(&mut answer);
    if String::from_utf8_lossy(&answer).contains("idle_unload_seconds") {
        PortOwner::Ours
    } else {
        PortOwner::Foreign
    }
}

pub fn mlx_start(_state: &AppState, _args: &Value) -> CmdResult {
    ensure_image_engine_supported()?;
    let root = mlx_root();
    let engine = engine_state(&root);
    if engine != EngineState::Ready {
        return Err(crate::commands::bad_request(engine_not_ready_message(engine)));
    }
    let log_path = root.join("server.log");
    let started = json!({"ok": true, "port": MLX_PORT, "log": log_path.to_string_lossy()});
    // An engine set up by an older LU keeps its old packages until a model
    // is installed (`bring_engine_up_to_date`). A model that is already on
    // the Mac never goes through that, so Chroma1-HD, installed under 3.0.10,
    // kept failing for want of protobuf after the update that pins it. The
    // start is where every render passes, off the main thread (media_cmds),
    // and the frontend waits for it: bring the packages up to date here.
    // With nothing to change this is one file comparison. Before the
    // sidecar's lock is taken: the update stops the sidecar, which takes the
    // same lock. And only while no sidecar is up, which may be at an image.
    let record = std::fs::read_to_string(root.join("requirements.txt")).ok();
    if !engine_requirements_current(record.as_deref()) && !sidecar().is_alive() {
        let slot = _state.install_mlx_diffusion();
        if slot.try_start() {
            match bring_engine_up_to_date(&slot) {
                Ok(()) => slot.complete("image engine updated"),
                Err(e) => {
                    slot.fail(e.clone());
                    return Err(crate::commands::internal(format!(
                        "The image engine could not be updated to this version's packages. {e}"
                    )));
                }
            }
        }
    }
    let mut side = sidecar();
    // Still coming up, or up: a second click must not start a second server.
    if side.is_alive() {
        return Ok(started);
    }
    match port_owner(MLX_PORT) {
        PortOwner::Free => {}
        PortOwner::Ours => return Ok(started),
        PortOwner::Foreign => {
            return Err(crate::commands::internal(format!(
                "The image engine cannot start because port {MLX_PORT} is used by another program. Quit that program, then try again."
            )));
        }
    }
    let server = root.join("server.py");
    // Refresh the deployed sidecar from the embedded copy. Otherwise an app
    // update keeps spawning whatever the engine setup wrote months ago.
    std::fs::write(&server, SERVER_PY)
        .map_err(|e| crate::commands::internal(format!("write server.py: {}", os_error::english(&e))))?;
    let stdout = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| crate::commands::internal(format!("log open: {e}")))?;
    let log_from = stdout.metadata().map(|m| m.len()).unwrap_or(0);
    let stderr = stdout
        .try_clone()
        .map_err(|e| crate::commands::internal(e.to_string()))?;

    // The sidecar re-validates every file of a model against the hub when it
    // loads one, so it needs the token as much as the installer does.
    let mut server_cmd = crate::python::python_command(venv_python());
    server_cmd
        .arg(&server)
        .env("LU_MLX_PORT", MLX_PORT.to_string())
        .env("HF_HOME", root.join("cache"))
        .env("HF_XET_CACHE", hf_xet_cache_dir())
        .stdout(stdout)
        .stderr(stderr);
    apply_hf_token(&mut server_cmd);
    let child = server_cmd
        .spawn()
        .map_err(|e| crate::commands::internal(format!("spawn mlx server: {}", os_error::english(&e))))?;
    side.hold(child, log_path, log_from, root);

    Ok(started)
}

// ── REMOVED on 01.09.2026: `mlx_stop` (KF-19) ─────────────────────────────
//
// It was two lines — `kill_listeners_on_port(MLX_PORT)` and an `{"ok":true}` —
// under a doc comment calling itself "the Stop button counterpart to
// `mlx_start`". Counted before removing: no Rust caller, no
// `#[tauri::command]` wrapper in `media_cmds.rs`, no line in `lib.rs`'s
// handler list, and no occurrence of the STRING "mlx_stop" anywhere under
// `src/`, `dev-server/`, `e2e/` or `mobile-client/` — which is how a Tauri
// command is actually invoked. Every other mlx entry point is wired all four
// ways. The Stop button it described could not exist.
//
// Deleted rather than wired, because the need it names is already served twice
// over and neither of those is this function:
//
//   * Reclaiming memory while the app runs is `mlx_unload` (bridged, and
//     called from `src/api/mlx-image.ts`). It frees the resident model and
//     leaves the sidecar up, which is the point of a sidecar — `mlx_status`
//     returns `modelLoaded`/`idleSeconds` so the UI can offer exactly that.
//   * Ending the PROCESS is the quit-time `kill_listeners_on_port(MLX_PORT)`
//     in `state.rs::shutdown`. Same call, one line, on the path that actually
//     runs.
//
// Wiring it would have meant a bridge in `media_cmds.rs`, a line in `lib.rs`
// and a caller in `src/` — a third door onto a job the other two already do,
// and the frontend is not this agent's to change.

const REQUIREMENTS_TXT: &str = include_str!("../../resources/mlx/requirements.txt");
const SERVER_PY: &str = include_str!("../../resources/mlx/server.py");

#[cfg(test)]
mod tests {
    use super::*;

    /// The token is a process-wide secret, so the tests that drive it take
    /// this lock instead of running side by side. The note above the round
    /// trip used to say the tests were one function for that reason, but a
    /// second one had been added underneath, and on 2026-08-16 it wrote its
    /// token into the exact instant the first one was asserting the store was
    /// empty. Poisoning is ignored: a panic in one test must fail that test,
    /// not every later one.
    static TOKEN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn hf_token_round_trip_and_clear() {
        let _guard = TOKEN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let state = AppState::new();

        // Absent by default: a fresh install has no token and must not send one.
        *HF_TOKEN.write().unwrap() = None;
        let mut cmd = Command::new("true");
        apply_hf_token(&mut cmd);
        assert!(
            !cmd.get_envs().any(|(k, _)| k == "HF_TOKEN"),
            "no token stored → no HF_TOKEN on the download process"
        );

        set_hf_token(&state, &json!({ "token": "  hf_secret  " })).unwrap();
        assert_eq!(
            hf_token_present(&state, &json!({})).unwrap()["present"],
            json!(true)
        );
        let mut cmd = Command::new("true");
        apply_hf_token(&mut cmd);
        let sent = cmd
            .get_envs()
            .find(|(k, _)| *k == "HF_TOKEN")
            .and_then(|(_, v)| v)
            .map(|v| v.to_string_lossy().into_owned());
        // Trimmed: a token pasted with a trailing newline must still work.
        assert_eq!(sent.as_deref(), Some("hf_secret"));

        // Clearing is how the user removes the token — an empty string must
        // not be stored as a token that then goes out as an empty header.
        set_hf_token(&state, &json!({ "token": "   " })).unwrap();
        assert_eq!(
            hf_token_present(&state, &json!({})).unwrap()["present"],
            json!(false)
        );
        let mut cmd = Command::new("true");
        apply_hf_token(&mut cmd);
        assert!(!cmd.get_envs().any(|(k, _)| k == "HF_TOKEN"));
    }

    /// `hf_token_present` answers yes/no; leaking the value back to any caller
    /// would put a live credential into logs and remote responses.
    #[test]
    fn hf_token_status_never_returns_the_token() {
        let _guard = TOKEN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let state = AppState::new();
        set_hf_token(&state, &json!({ "token": "hf_do_not_leak" })).unwrap();
        let body = hf_token_present(&state, &json!({})).unwrap();
        assert!(!body.to_string().contains("hf_do_not_leak"));
        *HF_TOKEN.write().unwrap() = None;
    }

    /// The live find from 2026-07-31: a download killed two seconds in has
    use crate::commands::mlx_snapshot::{audit_snapshot, describe, SnapshotReport};

    /// model_index.json and every config on disk, but no unet weights. That
    /// snapshot must NOT read as installed, or the row offers Remove and a
    /// local_files_only render dies. Weights present flips it to installed.
    #[test]
    fn aborted_snapshot_is_not_installed_until_weights_exist() {
        let temp = tempfile::tempdir().unwrap();
        let snap = temp.path();
        for d in ["unet", "vae", "text_encoder", "scheduler", "tokenizer"] {
            std::fs::create_dir_all(snap.join(d)).unwrap();
        }
        // The stubs real manifests carry: [null, null] components and scalar
        // flags. Neither may be demanded as a directory, or every complete
        // install reads as missing. All seven catalog repos read from the hub
        // on 2026-09-11: four spell the empty image_encoder [null, null],
        // three leave the key out, none of them writes a plain null.
        std::fs::write(
            snap.join("model_index.json"),
            r#"{
              "_class_name": "StableDiffusionPipeline",
              "feature_extractor": [null, null],
              "safety_checker": [null, null],
              "requires_safety_checker": true,
              "image_encoder": [null, null],
              "scheduler": ["diffusers", "EulerDiscreteScheduler"],
              "text_encoder": ["transformers", "CLIPTextModel"],
              "tokenizer": ["transformers", "CLIPTokenizer"],
              "unet": ["diffusers", "UNet2DConditionModel"],
              "vae": ["diffusers", "AutoencoderKL"]
            }"#,
        )
        .unwrap();
        std::fs::write(snap.join("tokenizer/vocab.json"), "{}").unwrap();
        // Configs alone (the aborted-download shape): not installed.
        std::fs::write(snap.join("unet/config.json"), "{}").unwrap();
        std::fs::write(snap.join("vae/config.json"), "{}").unwrap();
        assert!(!audit_snapshot(snap, None, None).is_complete(), "configs without weights must not count");

        // Weights for two of three model components: still not installed.
        std::fs::write(snap.join("vae/diffusion_pytorch_model.fp16.safetensors"), b"w").unwrap();
        std::fs::write(snap.join("text_encoder/model.fp16.safetensors"), b"w").unwrap();
        assert!(!audit_snapshot(snap, None, None).is_complete(), "a missing unet must not count");

        // Zero-byte weights are a torn write, not an install.
        std::fs::write(snap.join("unet/diffusion_pytorch_model.fp16.safetensors"), b"").unwrap();
        assert!(!audit_snapshot(snap, None, None).is_complete(), "an empty weights file must not count");

        std::fs::write(snap.join("unet/diffusion_pytorch_model.fp16.safetensors"), b"w").unwrap();
        assert!(audit_snapshot(snap, None, None).is_complete(), "all model components carrying weights count");
        std::fs::write(snap.join("text_encoder/model.safetensors"), b"w").unwrap();
        std::fs::remove_file(snap.join("text_encoder/model.fp16.safetensors")).unwrap();
        assert!(audit_snapshot(snap, None, None).is_complete(), "plain weights are weights");
    }

    /// A pinned download leaves `snapshots/<commit>` and no `refs/main`. The
    /// load opens the repo by name, so the ref has to be there afterwards.
    #[test]
    fn a_pinned_install_ends_with_a_main_ref_naming_its_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("models--org--name");
        let snap = root.join("snapshots").join("b261bac6");
        std::fs::create_dir_all(&snap).unwrap();
        assert!(!root.join("refs/main").exists());

        assert!(name_main_revision(&root, &snap).unwrap());
        assert_eq!(std::fs::read_to_string(root.join("refs/main")).unwrap(), "b261bac6");
        // Already right: nothing is rewritten.
        assert!(!name_main_revision(&root, &snap).unwrap());
    }

    #[test]
    fn a_main_ref_that_names_another_snapshot_is_moved_to_the_verified_one() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("models--org--name");
        let snap = root.join("snapshots").join("new");
        std::fs::create_dir_all(&snap).unwrap();
        std::fs::create_dir_all(root.join("refs")).unwrap();
        std::fs::write(root.join("refs/main"), "gone\n").unwrap();

        assert!(name_main_revision(&root, &snap).unwrap());
        assert_eq!(std::fs::read_to_string(root.join("refs/main")).unwrap(), "new");
    }

    /// Both doors: the install that just verified a snapshot, and the render
    /// that may not ask the hub (which also heals an older install).
    #[test]
    fn install_and_render_both_name_the_snapshot_before_a_local_only_load() {
        let src = include_str!("mlx.rs");
        let body = &src[..src.find("#[cfg(test)]\nmod tests").unwrap()];
        let finish = &body[body.find("fn finish_image_install(").unwrap()..];
        let finish = &finish[..finish.find("\npub fn ").unwrap()];
        assert_eq!(finish.matches("name_installed_main(slot, entry, &snap);").count(), 2);
        let named = body.find("    name_installed_snapshot(entry);\n").expect("the render names it");
        let sent = body.find("\"local_files_only\": image_model_is_installed(entry)").unwrap();
        assert!(named < sent, "the ref is written before the load is sent");
    }

    /// An SDXL snapshot with the components `UnfilteredAI/NSFW-gen-v2` has.
    /// Only the names matter here, so every listed file gets one byte.
    fn sdxl_snapshot(files: &[&str]) -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let snap = temp.path();
        std::fs::write(
            snap.join("model_index.json"),
            r#"{
              "_class_name": "StableDiffusionXLPipeline",
              "scheduler": ["diffusers", "EulerDiscreteScheduler"],
              "text_encoder": ["transformers", "CLIPTextModel"],
              "text_encoder_2": ["transformers", "CLIPTextModelWithProjection"],
              "tokenizer": ["transformers", "CLIPTokenizer"],
              "tokenizer_2": ["transformers", "CLIPTokenizer"],
              "unet": ["diffusers", "UNet2DConditionModel"],
              "vae": ["diffusers", "AutoencoderKL"]
            }"#,
        )
        .unwrap();
        for file in files {
            let path = snap.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"w").unwrap();
        }
        temp
    }

    /// Bauer M, 2026-09-11, on a full install of `UnfilteredAI/NSFW-gen-v2`:
    /// the plan fetches `unet/diffusion_pytorch_model.fp16.safetensors` and
    /// leaves the text encoders at full precision, because that repo has no
    /// fp16 encoder. The load then asked for `variant=null`, which sent
    /// diffusers looking for the one file the plan had deliberately skipped.
    /// Measured in the app's own venv (diffusers 0.38.0) on a rebuilt
    /// miniature of that folder: `variant="fp16"` loads it, `variant=None`
    /// dies with "Error no file named diffusion_pytorch_model.safetensors
    /// found in directory .../vae".
    #[test]
    fn a_mixed_snapshot_loads_with_the_fp16_variant() {
        let snap = sdxl_snapshot(&[
            "unet/diffusion_pytorch_model.fp16.safetensors",
            "vae/diffusion_pytorch_model.fp16.safetensors",
            "text_encoder/model.safetensors",
            "text_encoder_2/model.safetensors",
        ]);
        assert!(
            fp16_present_in_any_component(snap.path()),
            "fp16 unet and vae beside full-precision text encoders is what the plan fetched"
        );
    }

    /// The plan wanted fp16 for the unet and that file is not on disk. The vae
    /// still carries one, and diffusers picks the variant per component, so
    /// the load keeps asking for fp16 and the unet comes from its plain file.
    #[test]
    fn a_snapshot_that_lost_one_planned_fp16_file_still_uses_the_others() {
        let snap = sdxl_snapshot(&[
            "unet/diffusion_pytorch_model.safetensors",
            "vae/diffusion_pytorch_model.fp16.safetensors",
            "text_encoder/model.safetensors",
            "text_encoder_2/model.safetensors",
        ]);
        assert!(fp16_present_in_any_component(snap.path()), "one landed fp16 file is enough");
    }

    /// Not one fp16 file anywhere. Asking for the variant now raises "You are
    /// trying to load the model files of the `variant=fp16`, but no such
    /// modeling files are available." before any component is looked at, so
    /// this is the one snapshot that has to load without a variant.
    #[test]
    fn a_snapshot_without_any_fp16_file_loads_without_the_variant() {
        let snap = sdxl_snapshot(&[
            "unet/diffusion_pytorch_model.safetensors",
            "vae/diffusion_pytorch_model.safetensors",
            "text_encoder/model.safetensors",
            "text_encoder_2/model.safetensors",
        ]);
        assert!(
            !fp16_present_in_any_component(snap.path()),
            "a snapshot without a single fp16 file has to load without the variant"
        );
    }

    /// Sharded weights spell the variant with a dash after it, and Qwen-Image
    /// sized repos are the reason that matters.
    #[test]
    fn a_sharded_fp16_family_counts_as_the_variant() {
        let temp = tempfile::tempdir().unwrap();
        let snap = temp.path();
        std::fs::write(
            snap.join("model_index.json"),
            r#"{
              "_class_name": "StableDiffusionPipeline",
              "scheduler": ["diffusers", "EulerDiscreteScheduler"],
              "unet": ["diffusers", "UNet2DConditionModel"]
            }"#,
        )
        .unwrap();
        std::fs::create_dir_all(snap.join("unet")).unwrap();
        std::fs::write(snap.join("unet/diffusion_pytorch_model.fp16-00001-of-00002.safetensors"), b"w")
            .unwrap();
        assert!(fp16_present_in_any_component(snap), "a shard carries the variant too");
    }

    /// A repo the catalog never marked as fp16 is not asked about the disk.
    #[test]
    fn a_repo_without_the_catalog_flag_never_asks_for_a_variant() {
        let plain = image_catalog_lookup("z-image-turbo").expect("catalog entry");
        assert!(!plain.fp16_variant);
        assert_eq!(load_variant(plain), None);
        assert_eq!(prefer_variant(plain), None);
    }

    /// GitHub 127, suyashnatural, 2026-09-09: the sentence he was shown named
    /// no file. The installer text now does, and still carries no private path.
    #[test]
    fn the_install_failure_names_the_file_and_no_private_path() {
        let temp = tempfile::tempdir().unwrap();
        let snap = temp.path();
        assert_eq!(
            install_failed_message(&SnapshotReport {
                blocker: Some("no readable model snapshot was found".into()),
                defects: Vec::new(),
            }),
            "Model installation did not finish: no readable model snapshot was found. Retry the download to repair the missing files."
        );
        std::fs::write(
            snap.join("model_index.json"),
            r#"{"text_encoder": ["transformers", "CLIPTextModel"]}"#,
        )
        .unwrap();
        let message = install_failed_message(&audit_snapshot(snap, None, None));
        assert!(message.contains("text_encoder/ is missing"), "{message}");
        assert!(!message.contains(snap.to_str().unwrap()), "no private paths in UI text");
    }

    #[test]
    fn a_manifest_component_that_climbs_out_is_refused_without_being_echoed() {
        let temp = tempfile::tempdir().unwrap();
        for component in ["../outside", "..\\outside", "/outside", "a/b", "a\\b", "line\nbreak", "a:stream", ".. "] {
            let manifest = json!({component: ["diffusers", "UNet2DConditionModel"]});
            std::fs::write(temp.path().join("model_index.json"), manifest.to_string()).unwrap();
            let report = audit_snapshot(temp.path(), None, None);
            assert_eq!(report.blocker.as_deref(), Some("model_index.json contains an invalid component path"));
            assert!(!report.is_complete());
            assert!(!describe(&report).contains("outside"));
        }
    }

    /// An install that did not finish must reach `fail`, not `complete` with a
    /// failure sentence in it: the row would go green and offer Remove for a
    /// model that cannot load.
    #[test]
    fn an_unfinished_install_is_an_error_and_a_repaired_one_says_what_it_fetched() {
        let complete = SnapshotReport::default();
        assert_eq!(install_outcome("nsfw-gen-v2", &complete, &[]).unwrap(), "nsfw-gen-v2 installed");
        assert_eq!(
            install_outcome("nsfw-gen-v2", &complete, &["text_encoder/model.safetensors".into()]).unwrap(),
            "nsfw-gen-v2 installed, re-fetched text_encoder/model.safetensors"
        );
        let broken = SnapshotReport {
            blocker: Some("model_index.json is missing or unreadable".into()),
            defects: Vec::new(),
        };
        let failure = install_outcome("nsfw-gen-v2", &broken, &[]).unwrap_err();
        assert!(failure.starts_with("Model installation did not finish:"), "{failure}");
        assert!(!failure.contains("installed"), "{failure}");
    }

    #[test]
    fn every_catalog_repo_is_a_repository_id() {
        for entry in IMAGE_CATALOG {
            assert!(is_repo_id(entry.repo), "{} has an unusable repo id", entry.id);
        }
        for bad in ["", "no-slash", "a/b/c", "../etc/passwd", "org/na me", "org/"] {
            assert!(!is_repo_id(bad), "{bad} must not pass as a repo id");
        }
    }

    /// Fehlerkontrolle 3, 08.10.2026. The sidecar refuses an image while the
    /// second engine is at one, and the other way round nothing did. An image
    /// in the sidecar cannot be taken back: after Cancel in Create it goes on
    /// for minutes with its model in memory. A Qwen-Image 2.1 run started in
    /// that time asked the sidecar to unload, waited ten seconds behind the
    /// lock the running image holds, and then loaded its own 18 GB next to it.
    #[test]
    fn the_second_engine_does_not_start_beside_an_image_in_the_sidecar() {
        let src = production_source();
        let generate = &src[src.find("pub async fn mlx_generate(").unwrap()..];
        let generate = &generate[..generate.find("\npub(crate) fn images_root()").unwrap()];
        let second = generate.find("if let Some(pack) = entry.mflux {").unwrap();
        let hands_over = generate.find("mflux::generate(entry, pack, request)").unwrap();
        let asks = generate.find("sidecar_at_an_image()").expect("the second engine starts whatever the sidecar is doing");
        let unloads = generate.find("mlx_unload(").unwrap();
        assert!(second < asks && asks < unloads && unloads < hands_over, "asked too late: the unload waits behind the running image");
        // And the sidecar's image is counted from before the request goes out
        // until the function is left, on every way out.
        let counted = generate.find("let at_image = SidecarImage::begin(req.run.clone());").expect("an image in the sidecar is not counted");
        let request = generate.find(".post(format!(\"http://127.0.0.1:{MLX_PORT}/generate\"))").unwrap();
        assert!(hands_over < counted && counted < request);
    }

    /// C71: Chroma1-HD at 40 steps ran past a fixed 900 s and came back as
    /// "mlx unreachable". A run is ended only when nothing moves.
    #[test]
    fn a_sidecar_image_is_ended_when_it_stops_moving_not_after_a_fixed_time() {
        use std::time::Duration;
        let p = |phase: &str, step: u32, quiet: f64| SidecarProgress {
            phase: phase.into(),
            step,
            steps: 40,
            step_hook: true,
            quiet_seconds: quiet,
        };
        let limit = sidecar_stall_limit(None);
        assert_eq!(limit, Duration::from_secs(1200), "Settings' default of 20 minutes");
        // Two hours in, a step every 3 minutes: it runs on.
        let long = Duration::from_secs(7200);
        assert_eq!(sidecar_stall_verdict("Chroma1-HD", Some(&p("steps", 30, 180.0)), long, limit), None);
        // A load of 14 minutes is a load, even under a limit of 1 minute.
        let short = sidecar_stall_limit(Some(60));
        assert_eq!(sidecar_stall_verdict("Chroma1-HD", Some(&p("loading", 0, 840.0)), long, short), None);
        let stuck = sidecar_stall_verdict("Chroma1-HD", Some(&p("loading", 0, 900.0)), long, short).expect("a load that never ends");
        assert!(stuck.starts_with("Chroma1-HD timed out while loading: nothing moved for 15 minutes."), "{stuck}");
        // A step that never ends says where it stopped, as a timeout.
        let why = sidecar_stall_verdict("Chroma1-HD", Some(&p("steps", 12, 1200.0)), long, limit).expect("stalled");
        assert_eq!(
            why,
            "Chroma1-HD timed out at step 12 of 40: no new step for 20 minutes. Raise Image timeout in Settings, or try fewer steps or a smaller size."
        );
        assert!(!why.contains("unreachable"), "Create retries an unreachable sidecar and would wait the whole limit again");
        // A pipeline that counts no steps: quiet time is all there is.
        let blind = SidecarProgress { step_hook: false, ..p("steps", 0, 1300.0) };
        assert!(sidecar_stall_verdict("SD Turbo", Some(&blind), long, limit).unwrap().starts_with("SD Turbo timed out: no progress for 20 minutes."));
        // A sidecar that does not say how far it is gets what a load gets, in all.
        assert_eq!(sidecar_stall_verdict("X", None, Duration::from_secs(1199), limit), None);
        assert!(sidecar_stall_verdict("X", None, Duration::from_secs(1200), limit).is_some());
        // Idle: the request has not arrived yet or the image is through.
        assert_eq!(sidecar_stall_verdict("X", Some(&p("idle", 0, 99_999.0)), long, limit), None);
    }

    #[test]
    fn the_stall_limit_stays_in_the_range_settings_allows() {
        use std::time::Duration;
        assert_eq!(sidecar_stall_limit(Some(0)), Duration::from_secs(60));
        assert_eq!(sidecar_stall_limit(Some(45 * 60)), Duration::from_secs(45 * 60));
        assert_eq!(sidecar_stall_limit(Some(u64::MAX)), Duration::from_secs(480 * 60));
        assert_eq!(human_span(Duration::from_secs(60)), "1 minute");
        assert_eq!(human_span(Duration::from_secs(90)), "90 seconds");
    }

    #[test]
    fn the_progress_answer_of_the_sidecar_is_read() {
        let ok = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"phase\":\"steps\",\"step\":3,\"steps\":40,\"step_hook\":true,\"quiet_seconds\":1.5}";
        let p = parse_sidecar_progress(ok).expect("read");
        assert_eq!((p.phase.as_str(), p.step, p.steps, p.step_hook), ("steps", 3, 40, true));
        // A sidecar from before 3.1.0 has no such route.
        assert_eq!(parse_sidecar_progress("HTTP/1.1 404 Not Found\r\n\r\n{\"detail\":\"Not Found\"}"), None);
        assert_eq!(parse_sidecar_progress("garbage"), None);
    }

    /// The watch replaces the fixed limit on the whole request.
    #[test]
    fn the_sidecar_request_has_no_fixed_limit_and_is_watched() {
        let src = production_source();
        let generate = &src[src.find("pub async fn mlx_generate(").unwrap()..];
        let generate = &generate[..generate.find("\npub(crate) fn images_root()").unwrap()];
        assert!(!generate.contains(".timeout("), "a fixed limit on the whole request is back");
        assert!(generate.contains("sidecar_stall_verdict("));
        assert!(generate.contains("tokio::select!"));
    }

    /// The tests that put an image into the sidecar's list take turns.
    fn sidecar_images_in_tests() -> std::sync::MutexGuard<'static, ()> {
        static TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());
        TURN.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Fehlerkontrolle Mac 3, Fund 8. Cancel on an image in the sidecar ended
    /// nothing, and the PNG of the abandoned run lay under `images/` with no
    /// entry in the gallery.
    #[test]
    fn cancel_marks_the_image_in_the_sidecar_and_its_result_is_dropped() {
        let _alone = sidecar_images_in_tests();
        assert!(!cancel_sidecar_images(None), "there is no image to cancel");
        let old = SidecarImage::begin(Some("old".into()));
        assert!(!cancel_sidecar_images(Some("another")), "a Cancel for another run was taken");
        assert!(!old.cancelled());
        assert!(cancel_sidecar_images(Some("old")));
        assert!(old.cancelled());
        // Fund 12: the Cancel of the run before does not reach the next one.
        drop(old);
        let next = SidecarImage::begin(Some("next".into()));
        assert!(!cancel_sidecar_images(Some("old")));
        assert!(!next.cancelled());
        // Without a name it means whatever runs.
        assert!(cancel_sidecar_images(None) && next.cancelled());
        drop(next);

        let dir = tempfile::tempdir().unwrap();
        let png = json!({ "image_base64": "iVBORw0KGgo=", "width": 512, "height": 512, "steps": 4 });
        let err = keep_sidecar_image(true, png.clone(), 0.0, dir.path()).unwrap_err();
        assert!(err.contains("The image was cancelled."), "{err}");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0, "the cancelled image was written to disk");
        // One that was not cancelled is kept, with the guidance it ran at.
        let kept = keep_sidecar_image(false, png, 0.0, dir.path()).unwrap();
        assert!(Path::new(kept["output"].as_str().unwrap()).is_file());
        assert_eq!(kept["guidance"], json!(0.0), "Fund 9: the gallery is told the slider's value");
        assert_eq!(kept["steps"], json!(4));
    }

    /// The command reaches both engines, by the name of the run, and the
    /// sidecar is asked over its own endpoint.
    #[test]
    fn cancel_asks_the_sidecar_to_stop_between_two_steps() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let heard = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 512];
            let n = stream.read(&mut buf).unwrap();
            let _ = stream.write_all(b"HTTP/1.0 200 OK\r\nContent-Length: 28\r\n\r\n{\"ok\":true,\"cancelled\":true}");
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });
        let answer = sidecar_ask(port, "POST", "/cancel").expect("the sidecar answered");
        assert!(answer.ends_with("{\"ok\":true,\"cancelled\":true}"), "{answer}");
        assert!(heard.join().unwrap().starts_with("POST /cancel HTTP/1.0\r\n"));
        // Nobody on the port: no wait worth the name, and no error.
        let free = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let started = std::time::Instant::now();
        assert!(sidecar_ask(free, "POST", "/cancel").is_none());
        assert!(started.elapsed() < std::time::Duration::from_secs(1));

        let src = production_source();
        let cancel = &src[src.find("pub fn mlx_generate_cancel(").unwrap()..];
        let cancel = &cancel[..cancel.find("\n}\n").unwrap()];
        assert!(cancel.contains("mflux::stop_run(run)") && cancel.contains("cancel_sidecar_images(run)"));
        assert!(cancel.contains("sidecar_ask(MLX_PORT, \"POST\", \"/cancel\")"));
        // The sidecar has the endpoint and looks at the mark after each step.
        assert!(SERVER_PY.contains("@app.post(\"/cancel\")"));
        assert!(SERVER_PY.contains("gen_kwargs[\"callback_on_step_end\"] = _on_step_end"));
        assert!(SERVER_PY.contains("return _stop_if_cancelled(pipe, step, timestep, callback_kwargs)"));
        assert!(SERVER_PY.contains("@app.get(\"/progress\")"));
        let generate = &src[src.find("pub async fn mlx_generate(").unwrap()..];
        let generate = &generate[..generate.find("\npub(crate) fn images_root()").unwrap()];
        assert!(generate.contains("keep_sidecar_image(at_image.cancelled(), payload, entry.guidance, &images_root())"));
    }

    /// Fund 6: the second engine's run has its place before the sidecar is
    /// asked to unload. Fund 14: a model that was removed is not sent on.
    #[test]
    fn a_run_is_claimed_before_the_unload_and_a_removed_model_is_refused() {
        let src = production_source();
        let generate = &src[src.find("pub async fn mlx_generate(").unwrap()..];
        let generate = &generate[..generate.find("\npub(crate) fn images_root()").unwrap()];
        let claimed = generate.find("let _claim = mflux::claim_run(req.run.clone())").expect("the run is not claimed");
        assert!(generate.find("sidecar_at_an_image()").unwrap() < claimed && claimed < generate.find("mlx_unload(").unwrap());
        let refused = generate.find("if !image_model_is_installed(entry) {").expect("a removed model is sent to the sidecar");
        assert!(refused < generate.find("SidecarImage::begin(").unwrap());
    }

    #[test]
    fn an_image_in_the_sidecar_is_counted_until_its_request_is_left() {
        // Other tests of this file do not send to the sidecar, so the count
        // is this test's own.
        assert!(!sidecar_at_an_image());
        let _alone = sidecar_images_in_tests();
        let first = SidecarImage::begin(None);
        let second = SidecarImage::begin(None);
        assert!(sidecar_at_an_image());
        drop(first);
        assert!(sidecar_at_an_image(), "the second image is still running");
        drop(second);
        assert!(!sidecar_at_an_image());
        // Left through an error: the `?` drops it like any other way out.
        let failed = || -> Result<(), String> {
            let _at_image = SidecarImage::begin(None);
            Err("mlx unreachable".to_string())
        };
        assert!(failed().is_err());
        assert!(!sidecar_at_an_image());
    }

    #[test]
    fn both_image_installs_check_the_disk_before_they_claim_the_slot() {
        let src = include_str!("mlx.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        for entry in ["pub fn install_mlx_diffusion(", "pub fn mlx_image_install_model("] {
            let f = &body[body.find(entry).unwrap()..];
            let check = f.find("ensure_free_space(").expect("no disk check");
            let claim = f.find(".try_start()").unwrap();
            assert!(check < claim, "{entry} claims the slot before the disk is checked");
        }
    }

    #[test]
    fn a_stopped_download_only_needs_room_for_the_rest() {
        let entry = image_catalog_lookup("sd-turbo").unwrap();
        // Whatever is on disk, the rest never exceeds the catalogue size.
        assert!(image_download_bytes_left(entry) <= (entry.size_gb as f64 * 1e9) as u64);
    }

    #[test]
    fn mlx_root_lives_under_data_dir() {
        let r = mlx_root();
        let d = crate::os_paths::data_dir();
        assert!(r.starts_with(&d), "mlx root should live inside data dir");
        assert!(r.ends_with("mlx"));
    }

    #[test]
    fn venv_python_path_is_unix_style() {
        let p = venv_python();
        let s = p.to_string_lossy();
        assert!(s.ends_with("venv/bin/python"));
    }

    #[test]
    fn major_minor_reads_the_first_two_numbers() {
        assert_eq!(major_minor("3.12.1"), Some((3, 12)));
        assert_eq!(major_minor("3.15.0a1"), Some((3, 15)));
        assert_eq!(major_minor("3.11"), Some((3, 11)));
    }

    #[test]
    fn major_minor_rejects_garbage() {
        assert_eq!(major_minor("abc"), None);
        assert_eq!(major_minor(""), None);
        assert_eq!(major_minor("3"), None);
    }

    #[test]
    fn truncate_appends_ellipsis_when_over_limit() {
        assert_eq!(truncate("abc", 10), "abc");
        assert_eq!(truncate("abcdefghijkl", 5), "abcde…");
    }

    // ── Fehlerkontrolle Mac, 08.10.2026 ────────────────────────────────

    /// Everything above the test module, so a guard does not find the string
    /// it looks for in its own assertion.
    fn production_source() -> &'static str {
        let src = include_str!("mlx.rs");
        &src[..src.find("#[cfg(test)]\nmod tests").expect("the test module")]
    }

    /// Fund 1. The choice goes by what the interpreter answers, and a 3.12
    /// that only exists in Homebrew's directory wins over the system 3.9.
    #[test]
    fn the_engine_python_is_the_first_candidate_that_is_new_enough() {
        let versions: std::collections::HashMap<&str, &str> = [
            ("/usr/bin/python3", "3.9.6"),
            // GH #188: Homebrew's python3, no wheel of torch 2.12.1 for it.
            ("/opt/homebrew/bin/python3", "3.15.0"),
            ("/opt/homebrew/bin/python3.12", "3.12.7"),
            ("/Users/u/.pyenv/shims/python3.11", "3.11.9"),
        ]
        .into_iter()
        .collect();
        let version_of = |p: &Path| versions.get(p.to_str().unwrap()).map(|v| v.to_string());
        let all: Vec<PathBuf> = [
            "/usr/bin/python3",
            "/opt/homebrew/bin/python3",
            "/opt/homebrew/bin/python3.13",
            "/opt/homebrew/bin/python3.12",
            "/Users/u/.pyenv/shims/python3.11",
        ]
        .iter()
        .map(PathBuf::from)
        .collect();
        assert_eq!(
            pick_engine_python(&all, version_of),
            Some(PathBuf::from("/opt/homebrew/bin/python3.12")),
            "3.9 is too old, 3.15 too new and the 3.13 does not start, so the 3.12 is the one"
        );
        // Only the Command Line Tools 3.9: nothing usable, and the hint follows.
        assert_eq!(pick_engine_python(&all[..1], version_of), None);
        // The stub and Homebrew's 3.15: nothing usable, LU fetches its own.
        assert_eq!(pick_engine_python(&all[..2], version_of), None);
        assert_eq!(pick_engine_python(&[], version_of), None);
    }

    /// Fund 1, the other half: the candidates come from the fixed directories
    /// as well, not from PATH alone.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn the_engine_python_search_goes_through_the_fixed_directories() {
        let body = production_source();
        let search = &body[body.find("fn system_python_candidates").unwrap()..];
        let search = &search[..search.find("\n}\n").unwrap()];
        assert!(search.contains("python_paths_for"), "PATH alone misses Homebrew in a Finder-started app");
        assert!(!search.contains("which::which"));
    }

    fn fake_engine(root: &Path, packages: &[&str], record: bool) {
        let venv = root.join("venv");
        std::fs::create_dir_all(venv.join("bin")).unwrap();
        std::fs::write(venv.join("bin/python"), "stub").unwrap();
        let site = venv.join("lib/python3.12/site-packages");
        std::fs::create_dir_all(&site).unwrap();
        for package in packages {
            std::fs::create_dir_all(site.join(package)).unwrap();
        }
        if record {
            std::fs::write(root.join("requirements.txt"), REQUIREMENTS_TXT).unwrap();
        }
    }

    /// Fund 2. What an aborted setup of an older version leaves: the venv and
    /// the requirements file, and no packages. That read as installed.
    #[test]
    fn a_half_installed_engine_is_broken_and_not_installed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        assert_eq!(engine_state(root), EngineState::Missing);

        fake_engine(root, &[], true);
        assert_eq!(engine_state(root), EngineState::Broken, "a venv and a record without packages");

        fake_engine(root, &["torch", "diffusers"], true);
        assert_eq!(engine_state(root), EngineState::Broken, "pip stopped before the server packages");

        fake_engine(root, &ENGINE_PACKAGES, true);
        assert_eq!(engine_state(root), EngineState::Ready);

        // Packages without the record: pip was still running or was stopped.
        std::fs::remove_file(root.join("requirements.txt")).unwrap();
        assert_eq!(engine_state(root), EngineState::Broken);

        // The interpreter under the venv is gone (brew upgrade, uninstall).
        fake_engine(root, &ENGINE_PACKAGES, true);
        std::fs::remove_file(root.join("venv/bin/python")).unwrap();
        assert_eq!(engine_state(root), EngineState::Broken);
        assert!(engine_not_ready_message(EngineState::Broken).contains("Set it up again"));
    }

    /// Fund 2. The record of what the venv was built from exists only after
    /// pip ran to the end, and a pip that fails takes an older record with it.
    #[test]
    fn the_requirements_record_is_written_only_after_pip_succeeded() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fake_engine(root, &ENGINE_PACKAGES, true);

        let seen = std::cell::Cell::new(false);
        let failed = install_engine_packages(root, |staged| {
            // While pip works there is no record, and pip reads the staged list.
            seen.set(!root.join("requirements.txt").exists() && staged.is_file());
            Err("No matching distribution found for torch".into())
        });
        assert_eq!(failed.unwrap_err(), "No matching distribution found for torch");
        assert!(seen.get());
        assert!(!root.join("requirements.txt").exists(), "a failed pip must leave no record");
        assert_eq!(engine_state(root), EngineState::Broken, "so the setup is offered again");

        install_engine_packages(root, |_| Ok(())).unwrap();
        let record = std::fs::read_to_string(root.join("requirements.txt")).unwrap();
        assert!(engine_requirements_current(Some(&record)));
        assert!(!root.join("requirements.next.txt").exists());
        assert_eq!(engine_state(root), EngineState::Ready);
    }

    /// Fund 2. A venv whose interpreter no longer starts is rebuilt from the
    /// setup button; one that starts is kept so pip can continue in it.
    #[test]
    fn a_venv_that_does_not_start_is_removed_and_one_that_starts_is_kept() {
        let temp = tempfile::tempdir().unwrap();
        let slot = crate::install_state::InstallSlot::default();
        let venv = temp.path().join("venv");
        clear_dead_venv(&slot, &venv, |_| false).unwrap();
        assert!(!venv.exists(), "nothing there, nothing to do");

        fake_engine(temp.path(), &["torch"], false);
        clear_dead_venv(&slot, &venv, |_| true).unwrap();
        assert!(venv.join("lib/python3.12/site-packages/torch").is_dir(), "a working venv keeps its packages");

        clear_dead_venv(&slot, &venv, |python| {
            assert!(python.ends_with("venv/bin/python"));
            false
        })
        .unwrap();
        assert!(!venv.exists(), "a dead venv is cleared so the setup can build a new one");
        assert!(slot.snapshot().logs.iter().any(|l| l.contains("building it again")));
    }

    /// Fund 3. pip frames its errors with box-drawing characters of three
    /// bytes, and byte 800 fell into one.
    #[test]
    fn truncate_cuts_on_a_character_boundary() {
        let stderr = format!("{}\u{2570}\u{2500}> See above for output.", "x".repeat(799));
        assert!(!stderr.is_char_boundary(800));
        let cut = truncate(&stderr, 800);
        assert_eq!(cut, format!("{}…", "x".repeat(799)));
        assert_eq!(truncate("\u{2570}\u{2500}>", 1), "…");
        assert_eq!(truncate("\u{2570}\u{2500}>", 3), "\u{2570}…");
    }

    /// Fund 3 and 11: no install thread without the panic guard, and no slot
    /// claimed in two steps.
    #[test]
    fn every_install_claims_its_slot_atomically_and_runs_guarded() {
        let body = production_source();
        assert!(!body.contains(".start();"), "is_running() then start() lets a double click through");
        assert!(!body.contains("std::thread::spawn"), "an install thread outside spawn_install can die silently");
        assert_eq!(body.matches("spawn_install(").count(), 2, "the engine setup and the model download");
        // Three claims: the two installs, and the engine update at the start
        // (`mlx_start`, 3.1.0). That one runs in the start's own blocking
        // thread and ends the slot itself; a release build aborts on a panic.
        assert_eq!(body.matches(".try_start()").count(), 3);
        // Fund 4 and 13: nothing waits on a child behind `.output()` any more
        // except the two version probes, and no path is unwrapped into a str.
        assert!(!body.contains("to_str().unwrap()"));
        let steps = &body[body.find("fn install_mlx_steps").unwrap()..];
        let steps = &steps[..steps.find("\n}\n").unwrap()];
        assert!(!steps.contains(".output()"), "a step behind .output() has no log, no cancel and survives the app");
    }

    /// Fund 4. A step of the engine setup is a registered child: the cancel
    /// the image lane already has ends it, and the slot goes back to idle.
    #[cfg(unix)]
    #[test]
    fn the_image_cancel_stops_a_running_engine_setup() {
        let model = crate::install_state::InstallSlot::default();
        let engine = crate::install_state::InstallSlot::default();
        assert!(!cancel_image_installs(&model, &engine), "nothing runs");
        assert!(engine.try_start());
        let worker = {
            let engine = engine.clone();
            crate::install_state::spawn_install(engine, |slot| {
                let mut step = Command::new("/bin/sh");
                step.args(["-c", "echo collecting torch; sleep 60"]);
                crate::commands::video::run_streamed(slot, &mut step).map(|()| "done".to_string())
            })
        };
        let begun = std::time::Instant::now();
        while !engine.snapshot().logs.iter().any(|l| l == "collecting torch") {
            assert!(begun.elapsed() < std::time::Duration::from_secs(20), "the step never logged");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(cancel_image_installs(&model, &engine));
        worker.join().unwrap();
        assert!(begun.elapsed() < std::time::Duration::from_secs(40), "the child was not ended");
        let end = engine.snapshot();
        assert_eq!((end.status.as_str(), end.error), ("idle", None), "a cancel is not an error");
    }

    /// Fund 4. Quitting ends an install that is running.
    #[cfg(unix)]
    #[test]
    fn quitting_ends_the_process_an_install_waits_on() {
        let state = AppState::new();
        assert_eq!(state.cancel_mlx_installs(), 0);
        let mut pip = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let slot = state.install_mlx_diffusion();
        assert!(slot.try_start());
        slot.set_child(Some(pip.id()));
        assert_eq!(state.cancel_mlx_installs(), 1);
        let status = pip.wait().unwrap();
        assert!(!status.success(), "the child ran on after the app let go of it");
        let quit = include_str!("../state.rs");
        let quit = &quit[quit.find("pub fn shutdown_subprocesses").unwrap()..];
        let quit = &quit[..quit.find("impl Drop for AppState").unwrap()];
        assert!(quit.contains("self.cancel_mlx_installs()"));
        assert!(quit.contains("stop_sidecar()"));
    }

    /// Fund 7. An Intel Mac hears why before a venv is created.
    #[test]
    fn an_intel_mac_is_told_that_the_image_engine_needs_apple_silicon() {
        assert_eq!(image_engine_unsupported("macos", "aarch64"), None);
        let intel = image_engine_unsupported("macos", "x86_64").expect("no torch wheels for Intel macOS");
        assert!(intel.contains("Apple Silicon"), "{intel}");
        assert!(image_engine_unsupported("windows", "x86_64").is_some());
        assert!(image_engine_unsupported("linux", "aarch64").is_some());
        // And the check stands in front of everything that creates or starts something.
        let body = production_source();
        for entry in ["pub fn install_mlx_diffusion(", "pub fn mlx_image_install_model(", "pub fn mlx_start("] {
            let from = &body[body.find(entry).unwrap()..];
            let first = from.lines().nth(1).unwrap_or("");
            let second = from.lines().nth(2).unwrap_or("");
            assert!(
                first.contains("ensure_image_engine_supported()?") || second.contains("ensure_image_engine_supported()?"),
                "{entry} does not check the machine first"
            );
        }
    }

    #[cfg(unix)]
    fn sidecar_that_says(root: &Path, script: &str) -> SidecarSlot {
        let log = root.join("server.log");
        // An earlier run left its own last words in the same file.
        std::fs::write(&log, "ERROR: [Errno 48] address already in use\n").unwrap();
        let out = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
        let from = out.metadata().unwrap().len();
        let child = Command::new("/bin/sh")
            .args(["-c", script])
            .stdout(out.try_clone().unwrap())
            .stderr(out)
            .spawn()
            .unwrap();
        let mut slot = SidecarSlot::new();
        slot.hold(child, log, from, root.to_path_buf());
        slot
    }

    #[cfg(unix)]
    fn wait_for_failure(slot: &mut SidecarSlot) -> String {
        let begun = std::time::Instant::now();
        loop {
            if let Some(why) = slot.failure() {
                return why;
            }
            assert!(begun.elapsed() < std::time::Duration::from_secs(20), "the death was never noticed");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    /// Fund 8 and 2. A server that dies on a missing package is noticed on the
    /// next look, says which package, and the engine stops reading as set up.
    #[cfg(unix)]
    #[test]
    fn a_sidecar_that_dies_on_a_missing_package_says_so_and_offers_the_setup_again() {
        let temp = tempfile::tempdir().unwrap();
        fake_engine(temp.path(), &ENGINE_PACKAGES, true);
        let mut slot = sidecar_that_says(temp.path(), "echo 'LU_MLX_FATAL: missing package: uvicorn' >&2; exit 4");
        let why = wait_for_failure(&mut slot);
        assert_eq!(
            why,
            "The image engine is incomplete (missing package: uvicorn). Set it up again in the Model Manager."
        );
        assert!(!slot.is_alive());
        assert_eq!(slot.failure().as_deref(), Some(why.as_str()), "the reason stays until the next start");
        assert_eq!(engine_state(temp.path()), EngineState::Broken, "the setup button has to come back");

        // The next start forgets the old reason.
        let child = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let pid = child.id();
        slot.hold(child, temp.path().join("server.log"), 0, temp.path().to_path_buf());
        assert!(slot.is_alive());
        assert_eq!(slot.failure(), None);
        // And stopping it leaves no process behind, not even a zombie.
        slot.stop();
        // Asked through the process table and not through the `libc` crate:
        // that crate is a dependency on macOS only, and this test is built on
        // every Unix. With it the test binary did not compile on Linux.
        assert!(!crate::test_support::pid_is_taken(pid), "the child was not ended and reaped");
        assert!(!slot.is_alive());
    }

    /// Fund 8. Only this run's output counts, and each ending has its sentence.
    #[cfg(unix)]
    #[test]
    fn a_dead_sidecar_is_explained_from_its_own_output() {
        let temp = tempfile::tempdir().unwrap();
        fake_engine(temp.path(), &ENGINE_PACKAGES, true);
        let mut slot = sidecar_that_says(temp.path(), "echo 'RuntimeError: MPS backend out of memory' >&2; exit 1");
        assert_eq!(
            wait_for_failure(&mut slot),
            "The image engine stopped: RuntimeError: MPS backend out of memory",
            "the stale line of the earlier run must not be read as this one's"
        );
        assert_eq!(engine_state(temp.path()), EngineState::Ready, "that is not a damaged engine");

        let port = sidecar_failure_reason("LU_MLX_FATAL: port 47712 is already in use\n", Some(3));
        assert!(port.message.contains("port 47712 is used by another program"), "{}", port.message);
        assert!(!port.engine_damaged);
        let uvicorn = sidecar_failure_reason(
            "ERROR:    [Errno 48] error while attempting to bind on address ('127.0.0.1', 47712): address already in use\n",
            Some(1),
        );
        assert_eq!(uvicorn.message, port.message);

        let traceback = sidecar_failure_reason(
            "Traceback (most recent call last):\n  File \"server.py\", line 23\nModuleNotFoundError: No module named 'fastapi'\n",
            Some(1),
        );
        assert!(traceback.engine_damaged);
        assert!(traceback.message.contains("No module named 'fastapi'"), "{}", traceback.message);

        let killed = sidecar_failure_reason("", None);
        assert!(killed.message.contains("did not fit into memory"), "{}", killed.message);
        assert_eq!(
            sidecar_failure_reason("", Some(1)).message,
            "The image engine stopped with exit code 1 and no message."
        );
    }

    /// Fund 8. After a hard end the old server still holds the port. It is
    /// recognised by its health answer and used, and a stranger is not.
    #[test]
    fn the_port_is_asked_who_holds_it_before_a_second_server_is_started() {
        use std::io::{Read, Write};
        fn answer_once(body: &'static str) -> u16 {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                if let Ok((mut stream, _)) = listener.accept() {
                    let mut request = [0u8; 512];
                    let _ = stream.read(&mut request);
                    let _ = stream.write_all(format!("HTTP/1.0 200 OK\r\n\r\n{body}").as_bytes());
                }
            });
            port
        }
        let ours = answer_once(r#"{"ok":true,"model_loaded":false,"idle_unload_seconds":600}"#);
        assert_eq!(port_owner(ours), PortOwner::Ours);
        let stranger = answer_once("<html>hello</html>");
        assert_eq!(port_owner(stranger), PortOwner::Foreign);
        // A port nobody listens on. Other tests bind ephemeral ports at the
        // same moment and can be handed the one just released, so this asks a
        // few of them and needs one to still be free.
        let saw_free = (0..8).any(|_| {
            let released = {
                let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
                listener.local_addr().unwrap().port()
            };
            port_owner(released) == PortOwner::Free
        });
        assert!(saw_free, "a closed port must read as free");
    }

    /// Fund 8 and 13: the server announces the two endings it can foresee.
    #[test]
    fn the_server_says_why_it_cannot_start() {
        assert!(SERVER_PY.contains("LU_MLX_FATAL: "));
        assert!(SERVER_PY.contains("except ImportError as exc:"));
        assert!(SERVER_PY.contains("missing package: "));
        assert!(SERVER_PY.contains("is already in use"));
        let main = &SERVER_PY[SERVER_PY.find("if __name__ == \"__main__\":").unwrap()..];
        assert!(main.contains("except Exception as exc:"), "uvicorn.run ended in a bare traceback");
    }

    /// Fund 9. A refusal from the hub is its own sentence, and which one
    /// depends on whether a token was sent.
    #[test]
    fn a_gated_repository_asks_for_a_token_instead_of_naming_an_exit_code() {
        assert_eq!(hub_denied_message(401, false), Some(HF_TOKEN_NEEDED));
        assert_eq!(hub_denied_message(403, false), Some(HF_TOKEN_NEEDED));
        assert_eq!(hub_denied_message(403, true), Some(HF_TOKEN_NO_ACCESS));
        for other in [200, 404, 429, 500, 503] {
            assert_eq!(hub_denied_message(other, false), None, "HTTP {other} is not a refusal");
        }
        assert!(HF_TOKEN_NEEDED.starts_with("This model needs a Hugging Face token."));
        assert!(HF_TOKEN_NEEDED.contains("Settings, AI Backends"), "it names where the token goes");
        assert!(is_hub_denied(HF_TOKEN_NEEDED) && is_hub_denied(HF_TOKEN_NO_ACCESS));
        assert!(!is_hub_denied("the hub answered HTTP 429"));

        let traceback: Vec<String> = [
            "Traceback (most recent call last):",
            "huggingface_hub.errors.GatedRepoError: 401 Client Error.",
            "Cannot access gated repo for url https://huggingface.co/api/models/black-forest-labs/FLUX.2-klein-4B.",
            "Access to model black-forest-labs/FLUX.2-klein-4B is restricted.",
        ]
        .iter()
        .map(|l| l.to_string())
        .collect();
        assert_eq!(hub_denied_in_log(&traceback, false), Some(HF_TOKEN_NEEDED));
        assert_eq!(hub_denied_in_log(&traceback, true), Some(HF_TOKEN_NO_ACCESS));
        let disk: Vec<String> = vec!["OSError: [Errno 28] No space left on device".into()];
        assert_eq!(hub_denied_in_log(&disk, false), None);
        assert_eq!(hub_denied_in_log(&[], false), None);
    }

    /// Fund 9, end to end without the hub: the download step fails on a
    /// refusal and the slot carries the token sentence, not "exit code 1".
    #[cfg(unix)]
    #[test]
    fn a_download_that_is_refused_fails_with_the_token_sentence() {
        let _guard = TOKEN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        *HF_TOKEN.write().unwrap() = None;
        let slot = crate::install_state::InstallSlot::default();
        assert!(slot.try_start());
        let mut refused = Command::new("/bin/sh");
        refused.args(["-c", "echo 'huggingface_hub.errors.GatedRepoError: 401 Client Error.' >&2; exit 1"]);
        assert_eq!(run_hub_step(&slot, &mut refused, &[]).unwrap_err(), HF_TOKEN_NEEDED);
        let mut full = Command::new("/bin/sh");
        let fresh = crate::install_state::InstallSlot::default();
        assert!(fresh.try_start());
        full.args(["-c", "echo 'OSError: No space left on device' >&2; exit 1"]);
        assert_eq!(run_hub_step(&fresh, &mut full, &[]).unwrap_err(), "The installer stopped with exit code 1.");
    }

    /// Real run, 09.10.2026: a download stood at 0.0 MB/s for forty minutes
    /// and nothing noticed. A step whose folders stand still is ended and
    /// started again, and after the last attempt it says what happened.
    #[test]
    fn what_a_stopped_download_left_half_written_is_removed_and_whole_files_stay() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("ltx-2.3-q4");
        let partials = target.join(".cache").join("huggingface").join("download");
        std::fs::create_dir_all(&partials).unwrap();
        std::fs::write(target.join("connector.safetensors"), vec![0u8; 4096]).unwrap();
        std::fs::write(partials.join("Tr4e=.a78f.f8eb9827.incomplete"), vec![0u8; 3000]).unwrap();
        std::fs::write(partials.join("UOAc=.f404.5549f38a.incomplete"), vec![0u8; 200]).unwrap();
        std::fs::write(partials.join("config.json.metadata"), b"etag").unwrap();
        // A file in a subfolder of the repository has its piece in the same subfolder.
        std::fs::create_dir_all(partials.join("transformer")).unwrap();
        std::fs::write(partials.join("transformer").join("13lW=.05da.9977.incomplete"), vec![0u8; 70]).unwrap();
        std::fs::write(partials.join("transformer").join("0.safetensors.metadata"), b"etag").unwrap();
        assert_eq!(drop_stale_partials(&target), 3270);
        assert!(partials.join("transformer").join("0.safetensors.metadata").is_file());
        assert_eq!(std::fs::read_dir(partials.join("transformer")).unwrap().count(), 1);
        std::fs::remove_dir_all(partials.join("transformer")).unwrap();
        assert!(target.join("connector.safetensors").is_file());
        assert!(partials.join("config.json.metadata").is_file(), "the record of a whole file is what makes the client skip it");
        assert_eq!(std::fs::read_dir(&partials).unwrap().count(), 1);
        // Nothing there, or no folder at all: nothing happens.
        assert_eq!(drop_stale_partials(&target), 0);
        assert_eq!(drop_stale_partials(&dir.path().join("never")), 0);
    }

    /// The watcher of a download step, with the disk, the network and the
    /// clock of the test's own making. The children are real processes, and
    /// nothing here depends on how fast they or this machine are: a child
    /// that is to end waits for a file, and the test writes that file when
    /// the watcher has looked often enough. The counters of the system are
    /// not read: in a full test run other tests receive from the network in
    /// this very process, and a loaded machine stretches every real wait.
    #[cfg(unix)]
    #[test]
    fn a_download_that_stands_still_is_started_again_and_then_given_up_in_words() {
        use std::sync::atomic::{AtomicU64, Ordering::SeqCst};
        use std::sync::Mutex;
        use std::time::Duration;

        /// What one step saw: every pid the watcher asked the network about,
        /// in order and once each.
        struct Seen {
            outcome: Result<(), String>,
            pids: Vec<u32>,
            logs: String,
            slot: crate::install_state::InstallSlot,
        }

        /// Run `script` as a step. `disk(looks)` and `network(looks, nth)`
        /// are what the watcher reads at its `looks`-th look at the `nth`
        /// child; `at_look(looks, nth, slot)` is the test's turn to act.
        fn step(
            script: &str,
            disk: &(dyn Fn(u64) -> u64 + Sync),
            network: &(dyn Fn(u64, usize) -> Option<u64> + Sync),
            at_look: &(dyn Fn(u64, usize, &crate::install_state::InstallSlot) + Sync),
        ) -> Seen {
            let slot = crate::install_state::InstallSlot::default();
            assert!(slot.try_start());
            let (clock, looks, pids) = (AtomicU64::new(0), AtomicU64::new(0), Mutex::new(Vec::<u32>::new()));
            let watch = StallWatch {
                // Ten looks without a change are a stall.
                stall_after: Duration::from_secs(600),
                look_every: Duration::from_secs(60),
                on_disk: &|| disk(looks.load(SeqCst)),
                received: &|pid| {
                    let nth = {
                        let mut pids = pids.lock().unwrap();
                        if !pids.contains(&pid) {
                            pids.push(pid);
                        }
                        pids.len()
                    };
                    let look = looks.fetch_add(1, SeqCst) + 1;
                    at_look(look, nth, &slot);
                    network(look, nth)
                },
                now: &|| Duration::from_millis(clock.load(SeqCst)),
                // The clock of the test moves by the whole nap at once. The
                // millisecond is there so the watcher does not spin while a
                // child starts, and nothing is decided by it.
                nap: &|d| {
                    clock.fetch_add(d.as_millis() as u64 * 600, SeqCst);
                    std::thread::sleep(Duration::from_millis(1));
                },
            };
            let mut cmd = Command::new("/bin/sh");
            cmd.arg("-c").arg(script);
            let outcome = run_hub_step_watched(&slot, &mut cmd, Some(&watch));
            let logs = slot.snapshot().logs.join("\n");
            let pids = pids.lock().unwrap().clone();
            Seen { outcome, pids, logs, slot }
        }

        let dir = tempfile::tempdir().unwrap();
        let go = dir.path().join("go");
        // Ends by itself once the test says so, and not before.
        let waits = format!("while [ ! -f '{}' ]; do sleep 0.05; done", go.display());
        let release = |_: u64, _: usize, _: &crate::install_state::InstallSlot| std::fs::write(&go, b"").unwrap();
        let nothing = |_: u64, _: usize, _: &crate::install_state::InstallSlot| {};

        // Every attempt hangs: three starts, then the sentence.
        let began = std::time::Instant::now();
        let seen = step("sleep 600", &|_| 0, &|_, _| Some(0), &nothing);
        let why = seen.outcome.unwrap_err();
        assert!(why.contains("stalled 3 times"), "{why}");
        assert!(why.contains("no data arrived for 10 minutes each time"), "{why}");
        assert!(why.contains("What was downloaded is kept"), "{why}");
        assert_eq!(seen.pids.len(), 3, "three attempts are three processes: {:?}", seen.pids);
        assert!(began.elapsed() < Duration::from_secs(120), "the hanging child was waited for");
        assert!(seen.logs.contains("No data has arrived for 10 minutes"), "{}", seen.logs);
        assert!(seen.logs.contains("Starting it again (attempt 2 of 3)"), "{}", seen.logs);
        assert!(seen.logs.contains("Starting it again (attempt 3 of 3)"), "{}", seen.logs);
        assert!(!seen.slot.cancel_requested(), "a stall is not a Stop");

        // The second attempt gets through: the step succeeds.
        let seen = step(&waits, &|_| 0, &|look, nth| Some(if nth == 1 { 0 } else { look }), &|look, nth, slot| {
            if nth == 2 {
                release(look, nth, slot);
            }
        });
        seen.outcome.unwrap();
        assert_eq!(seen.pids.len(), 2, "{:?}", seen.pids);
        assert!(seen.logs.contains("Starting it again (attempt 2 of 3)"), "{}", seen.logs);
        std::fs::remove_file(&go).unwrap();

        // A download that writes is left alone, however long it takes: here
        // five times as long as a stall.
        let after_fifty = |look: u64, nth: usize, slot: &crate::install_state::InstallSlot| {
            if look >= 50 {
                release(look, nth, slot);
            }
        };
        let seen = step(&waits, &|looks| looks * 4096, &|_, _| Some(0), &after_fifty);
        seen.outcome.unwrap();
        assert_eq!(seen.pids.len(), 1);
        assert!(!seen.logs.contains("No data"), "a moving download was called stalled: {}", seen.logs);
        std::fs::remove_file(&go).unwrap();

        // A process that is receiving is left alone although nothing reaches
        // the disk: the hub client holds gigabytes in memory before it writes.
        let seen = step(&waits, &|_| 0, &|look, _| Some(look * 4096), &after_fifty);
        seen.outcome.unwrap();
        assert_eq!(seen.pids.len(), 1);
        assert!(!seen.logs.contains("No data"), "a download that was receiving was called stalled: {}", seen.logs);
        std::fs::remove_file(&go).unwrap();

        // Where the network cannot be read, nothing is ever called stalled.
        let seen = step(&waits, &|_| 0, &|_, _| None, &after_fifty);
        seen.outcome.unwrap();
        assert_eq!(seen.pids.len(), 1);
        assert!(!seen.logs.contains("No data"), "a download was called stalled on a system that cannot say: {}", seen.logs);
        std::fs::remove_file(&go).unwrap();

        // A Stop during the wait is a Stop, and is not answered with a new start.
        let seen = step("sleep 600", &|_| 0, &|_, _| Some(0), &|look, _, slot| {
            if look == 3 {
                slot.cancel();
            }
        });
        assert!(seen.outcome.is_err());
        assert_eq!(seen.pids.len(), 1, "a stopped download was started again: {:?}", seen.pids);
        assert!(!seen.logs.contains("Starting it again"), "{}", seen.logs);

        // A step that names no folder is not watched, and runs all the same.
        let slot = crate::install_state::InstallSlot::default();
        assert!(slot.try_start());
        run_hub_step(&slot, Command::new("/bin/sh").args(["-c", "exit 0"]), &[]).unwrap();

        // The app hands in the real disk, network and clock.
        let production = production_source();
        let real = &production[production.find("pub(crate) fn run_hub_step(").unwrap()..production.find("struct StallWatch").unwrap()];
        for part in ["crate::install_state::dir_size(dir)", "received: &crate::install_state::received_bytes", "started.elapsed()", "nap: &std::thread::sleep", "stall_after: STALL_AFTER"] {
            assert!(real.contains(part), "run_hub_step no longer reads {part}");
        }

        // Every download of both lanes names its folders.
        for (file, source) in [("mlx.rs", include_str!("mlx.rs")), ("image_mflux.rs", include_str!("image_mflux.rs")), ("video.rs", include_str!("video.rs"))] {
            let production = &source[..source.find("\nmod tests {").unwrap_or(source.len())];
            let calls: Vec<&str> = production.match_indices("run_hub_step(slot, ").map(|(at, _)| production[at..].lines().next().unwrap()).collect();
            assert!(!calls.is_empty(), "{file}: no download was found, the test looked at nothing");
            for call in calls {
                assert!(call.contains(", &[") && !call.contains(", &[])"), "{file} has a download that is not watched: {call}");
            }
        }
    }

    /// An edit with many pictures on a small Mac. The two measured runs (one
    /// and four pictures at 1024) bound the estimate.
    #[test]
    fn an_edit_with_more_pictures_than_the_memory_takes_is_refused() {
        const GIB: u64 = 1_073_741_824;
        assert!((edit_peak_gb(1, 1024, 10.6) - 10.48).abs() < 0.3, "one picture was measured at 10.5 GB");
        assert!((edit_peak_gb(4, 1024, 10.6) - 17.18).abs() < 0.3, "four pictures were measured at 17.2 GB");
        // 48 GB: nine pictures at 1024 run, ten (about 31 GB) are refused.
        assert_eq!(edit_memory_verdict(9, 1024, 10.6, 48 * GIB), None);
        assert_eq!(
            edit_memory_verdict(10, 1024, 10.6, 48 * GIB).expect("31 GB are past the share of 48"),
            "An edit with 10 pictures needs about 31 GB of memory and this Mac has 48 GB. It was not started, so the system does not freeze. Use at most 9 pictures, the one you edit included."
        );
        // 24 GB: two run, three are refused with the number that runs.
        assert_eq!(edit_memory_verdict(2, 1024, 10.6, 24 * GIB), None);
        assert!(edit_memory_verdict(3, 1024, 10.6, 24 * GIB).expect("three do not fit into 24").ends_with("Use at most 2 pictures, the one you edit included."));
        // A smaller canvas takes more pictures.
        assert_eq!(edit_memory_verdict(10, 768, 10.6, 48 * GIB), None);
        // 16 GB: only the picture alone.
        assert!(edit_memory_verdict(2, 1024, 10.6, 16 * GIB).expect("two do not fit into 16").ends_with("Edit the picture without references."));
        // The 8-bit pack carries its larger weights.
        assert!(edit_memory_verdict(9, 1024, 18.5, 48 * GIB).is_some());
        // A picture alone is never refused here (the model's own floor does that).
        assert_eq!(edit_memory_verdict(1, 1024, 10.6, 8 * GIB), None);
        assert_eq!(edit_memory_verdict(10, 1024, 10.6, 0), None, "memory that could not be read never blocks");
        // Checked before the sidecar's model is unloaded.
        let body = production_source();
        let command = &body[body.find("pub async fn mlx_generate").expect("mlx_generate")..];
        let check = command.find("edit_memory_verdict(").expect("mlx_generate checks the memory of an edit");
        assert!(check < command.find("mlx_unload(").expect("mlx_generate unloads"), "checked before the unload");
    }

    /// Enhance on a small Mac: the model fits, the result may not. The two
    /// measured runs (2048 and 4096 on a side) bound the estimate.
    #[test]
    fn an_enhance_larger_than_the_macs_memory_is_refused() {
        const GIB: u64 = 1_073_741_824;
        assert!((upscale_peak_gb(4.194304) - 11.33).abs() < 0.3, "2048 x 2048 was measured at 11.3 GB");
        assert!((upscale_peak_gb(16.777216) - 22.08).abs() < 0.3, "4096 x 4096 was measured at 22.1 GB");
        // 48 GB: 4x of a 1024 picture runs.
        assert_eq!(upscale_memory_verdict(4096, 4096, 4, 48 * GIB), None);
        // 24 GB: 2x runs, 4x is refused with the way out.
        assert_eq!(upscale_memory_verdict(2048, 2048, 2, 24 * GIB), None);
        assert_eq!(
            upscale_memory_verdict(4096, 4096, 4, 24 * GIB).expect("22 GB do not fit into 24"),
            "Enhancing to 4096x4096 needs about 23 GB of memory and this Mac has 24 GB. It was not started, so the system does not freeze. Pick 2x, or enhance a smaller picture."
        );
        // 16 GB: 2x of a 1024 picture is refused, of a 768 one it runs.
        assert!(upscale_memory_verdict(2048, 2048, 2, 16 * GIB).expect("11.3 GB do not fit into 16").ends_with("Enhance a smaller picture."));
        assert_eq!(upscale_memory_verdict(1536, 1536, 2, 16 * GIB), None);
        assert_eq!(upscale_memory_verdict(4096, 4096, 4, 0), None, "memory that could not be read never blocks");
        // And the check runs before the sidecar's model is unloaded.
        let body = production_source();
        let command = &body[body.find("pub async fn mlx_upscale").expect("mlx_upscale")..];
        let check = command.find("upscale_memory_verdict(").expect("mlx_upscale checks the memory of the result");
        assert!(check < command.find("mlx_unload(").expect("mlx_upscale unloads"), "checked before the unload");
    }

    /// Fund 12. A model that needs more memory than the Mac has is refused
    /// before the sidecar loads it.
    #[test]
    fn a_model_larger_than_the_macs_memory_is_refused() {
        const GIB: u64 = 1_073_741_824;
        let refused = memory_verdict("Z-Image Turbo", 32, 16 * GIB).expect("32 GB do not fit into 16");
        assert_eq!(
            refused,
            "Z-Image Turbo needs a Mac with 32 GB of memory and this Mac has 16 GB. Loading it would fill the memory until the system freezes, so it was not started. Pick a model that fits 16 GB."
        );
        assert_eq!(memory_verdict("SD Turbo", 8, 8 * GIB), None, "exactly enough is enough");
        assert_eq!(memory_verdict("SDXL", 16, 16 * GIB - 64 * 1024 * 1024), None, "a little under nominal still counts");
        assert_eq!(memory_verdict("SDXL", 16, 64 * GIB), None);
        assert!(memory_verdict("SDXL", 16, 8 * GIB).is_some());
        assert_eq!(memory_verdict("SDXL", 16, 0), None, "memory that could not be read never blocks");
        // And the check runs before the request goes out.
        let body = production_source();
        let generate = &body[body.find("pub async fn mlx_generate").unwrap()..];
        let check = generate.find("memory_verdict(").expect("mlx_generate checks the memory");
        assert!(check < generate.find(".post(").unwrap(), "the model must be refused before it is loaded");
        assert!(total_memory_bytes() > 0, "the machine's memory is readable here");
    }

    /// Fund 13. Remove takes the Xet chunk cache along, which no row showed.
    #[test]
    fn removing_a_model_frees_the_xet_chunk_cache_too() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let model = cache.join("hub/models--stabilityai--sd-turbo");
        let other = cache.join("hub/models--Lykon--dreamshaper-xl-v2-turbo");
        let xet = cache.join("xet");
        for dir in [&model, &other, &xet.join("chunks")] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(model.join("weights.bin"), vec![0u8; 10]).unwrap();
        std::fs::write(other.join("weights.bin"), vec![0u8; 10]).unwrap();
        std::fs::write(xet.join("chunks/a"), vec![0u8; 4096]).unwrap();
        assert_eq!(remove_image_model_files(&model, &xet).unwrap(), 4096);
        assert!(!model.exists());
        assert!(!xet.exists(), "the chunk cache stayed behind");
        assert!(other.join("weights.bin").is_file(), "another model's files are not touched");
        // No cache there at all is not an error.
        assert_eq!(remove_image_model_files(&other, &xet).unwrap(), 0);
        assert!(remove_image_model_files(&other, &xet).is_err(), "a model that is not there still errors");
    }

    #[test]
    fn an_engine_from_an_older_build_is_not_current() {
        assert!(engine_requirements_current(Some(REQUIREMENTS_TXT)));
        // Line endings and a trailing newline are not a different engine.
        assert!(engine_requirements_current(Some(&format!("{}\n\n", REQUIREMENTS_TXT.trim()))));
        // No record at all: set up before the file existed, or by hand.
        assert!(!engine_requirements_current(None));
        assert!(!engine_requirements_current(Some("torch>=2.4.0\ndiffusers>=0.36.0\n")));
    }

    #[test]
    fn the_engine_floor_carries_every_pipeline_the_catalogue_names() {
        // FLUX.2 klein and Chroma load through classes that the
        // 0.36 floor of the first Mac build did not have. Checked against the
        // 0.38.0 that the owner's Mac runs (08.10.2026).
        assert!(
            REQUIREMENTS_TXT.lines().any(|l| l.trim() == "diffusers==0.38.0"),
            "the diffusers pin moved; check the catalogue's pipeline classes against it"
        );
        // Every package is an exact version: an open bound installs whatever
        // was released this morning on a customer's Mac, untested.
        for line in REQUIREMENTS_TXT.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
            assert!(line.contains("==") && !line.contains(">="), "{line} is not pinned");
        }
    }

    #[test]
    fn image_catalog_ids_are_unique_and_complete() {
        let mut ids: Vec<&str> = IMAGE_CATALOG.iter().map(|c| c.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), IMAGE_CATALOG.len(), "duplicate catalog id");
        // The owner's floor for every category on the Mac (08.10.2026): at
        // least eight mainstream and eight unfiltered models on offer.
        // The upscaler makes no picture of its own and counts for none of
        // the floors: it is the one model of Enhance Image.
        let upscalers: Vec<&str> =
            IMAGE_CATALOG.iter().filter(|c| c.mflux.is_some_and(|p| p.upscales())).map(|c| c.id).collect();
        assert_eq!(upscalers, ["seedvr2-3b"]);
        let offered: Vec<_> =
            IMAGE_CATALOG.iter().filter(|c| !c.retired && !c.mflux.is_some_and(|p| p.upscales())).collect();
        let unfiltered = offered.iter().filter(|c| c.unfiltered).count();
        assert!(offered.len() - unfiltered >= 8, "fewer than eight mainstream image models");
        assert!(unfiltered >= 8, "fewer than eight unfiltered image models");
        // The split after the review of 08.10.2026 (EINSTUFUNG-KATALOG.md).
        assert_eq!((offered.len() - unfiltered, unfiltered), (13, 10));
        // Small-to-large hardware coverage, on both sides of the switch.
        for side in [false, true] {
            let rams: Vec<u32> = offered.iter().filter(|c| c.unfiltered == side).map(|c| c.min_ram_gb).collect();
            assert!(rams.iter().any(|g| *g <= 8), "no 8 GB model (unfiltered: {side})");
            assert!(rams.iter().any(|g| *g <= 16), "no 16 GB model (unfiltered: {side})");
            assert!(rams.iter().any(|g| *g >= 48), "no model for a large Mac (unfiltered: {side})");
        }
        // The engine setup pulls the first entry along, so that one stays the
        // small starter.
        assert_eq!(IMAGE_CATALOG[0].id, "sd-turbo");
        assert!(!IMAGE_CATALOG[0].retired);
    }

    #[test]
    fn image_catalog_entries_are_wellformed() {
        for c in IMAGE_CATALOG {
            assert!(c.repo.contains('/'), "{} repo must be org/name", c.id);
            assert!(!c.allow.is_empty(), "{} needs allow patterns", c.id);
            assert!(c.allow.contains(&"*.json"), "{} must pull configs", c.id);
            assert!(c.steps > 0 && c.size_gb > 0.0);
            assert!(
                c.cfg_param == "guidance_scale" || c.cfg_param == "true_cfg_scale",
                "{} unknown cfg_param",
                c.id
            );
            assert!(c.dtype == "float16" || c.dtype == "bfloat16");
            // fp16-variant repos must restrict weights to fp16 subfiles so we
            // don't pull the fp32 duplicates.
            if c.fp16_variant {
                assert!(c.allow.iter().any(|p| p.contains("fp16")), "{}", c.id);
            }
        }
    }

    #[test]
    fn image_cache_dir_follows_hub_layout() {
        let d = image_model_cache_dir("stabilityai/sd-turbo");
        assert!(d.ends_with("cache/hub/models--stabilityai--sd-turbo"));
    }

    /// Discord (M1 Max, 3.0.10): Chroma1-HD ships its T5 tokenizer as
    /// spiece.model only, transformers 5 converts it with protobuf, and
    /// without protobuf the load ends in "`tiktoken` is required". Measured in
    /// a fresh venv from this file on 10.11.2026: fails without, loads with
    /// protobuf 7.35.1 alone. An engine set up from the 3.0.10 file must read
    /// as out of date, so the next start pulls it in.
    #[test]
    fn the_engine_pins_protobuf_for_sentencepiece_only_tokenizers() {
        assert!(REQUIREMENTS_TXT.lines().any(|l| l.trim() == "protobuf==7.35.1"));
        let as_of_3_0_10: String = REQUIREMENTS_TXT
            .lines()
            .filter(|l| !l.trim_start().starts_with("protobuf=="))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!engine_requirements_current(Some(&as_of_3_0_10)));
        // The same version the video engine runs on, not a second one.
        let video = include_str!("video.rs");
        assert!(video.contains("\"protobuf==7.35.1\""));
    }

    /// A model that is already installed never goes through the install path,
    /// so the start brings the engine up to date. Before it takes the
    /// sidecar's lock: the update stops the sidecar through the same lock, and
    /// std's Mutex does not let one thread take it twice.
    #[test]
    fn the_start_updates_a_stale_engine_before_it_takes_the_sidecar_lock() {
        let src = include_str!("mlx.rs");
        let start = &src[src.find("pub fn mlx_start(").unwrap()..];
        let start = &start[..start.find("\n}\n").unwrap()];
        let update = start.find("bring_engine_up_to_date(&slot)").expect("mlx_start updates the engine");
        let lock = start.find("let mut side = sidecar();").expect("mlx_start takes the sidecar");
        assert!(update < lock, "the update has to run before the sidecar lock is held");
        let check = start.find("engine_requirements_current(").unwrap();
        assert!(check < update, "a current engine costs one file comparison, no pip");
    }

    #[test]
    fn embedded_assets_are_non_empty() {
        // include_str! at compile time guarantees these are populated;
        // the assertion turns a typo'd path into a build-time failure
        // instead of an empty-write at install time.
        assert!(REQUIREMENTS_TXT.contains("torch"));
        assert!(SERVER_PY.contains("FastAPI"));
    }
}
