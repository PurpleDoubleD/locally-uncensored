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

fn mlx_root() -> PathBuf {
    crate::os_paths::data_dir().join("mlx")
}

fn venv_python() -> PathBuf {
    mlx_root().join("venv/bin/python")
}

fn venv_pip() -> PathBuf {
    mlx_root().join("venv/bin/pip")
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

pub async fn mlx_status(_state: &AppState, _args: &Value) -> CmdResult {
    let installed = venv_python().exists();
    let running = sidecar_running();
    // When the sidecar is up, surface what it's holding so the UI can show a
    // "free memory" control while a model is resident.
    let (model_loaded, model_repo, idle_seconds) = if running {
        probe_health().await
    } else {
        (false, Value::Null, Value::Null)
    };
    Ok(json!({
        "installed": installed,
        "running": running,
        "port": MLX_PORT,
        "venv": venv_python().to_string_lossy(),
        "modelLoaded": model_loaded,
        "modelRepo": model_repo,
        "idleSeconds": idle_seconds,
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

pub fn install_mlx_diffusion(state: &AppState, _args: &Value) -> CmdResult {
    if std::env::consts::OS != "macos" {
        return Err(crate::commands::bad_request(
            "MLX-Stable-Diffusion is macOS-only in v1",
        ));
    }
    let slot = state.install_mlx_diffusion();
    if slot.is_running() {
        return Ok(json!({"ok": true, "status": "installing"}));
    }
    slot.start();
    slot.log("preparing MLX-Stable-Diffusion install");

    // AppState isn't Clone (it owns non-cloneable subprocess handles) — move
    // just the InstallSlot into the thread instead of the whole state. Slot
    // is already an Arc-backed handle from `state.install_mlx_diffusion()`
    // above, so cloning it again is cheap and shares the same progress state.
    let slot_thread = slot.clone();
    std::thread::spawn(move || {
        match install_mlx_steps(&slot_thread) {
            Ok(()) => slot_thread.complete("MLX-Stable-Diffusion ready".to_string()),
            Err(e) => slot_thread.fail(e),
        }
    });

    Ok(json!({"ok": true, "status": "installing"}))
}

pub fn install_mlx_diffusion_status(state: &AppState, _args: &Value) -> CmdResult {
    Ok(serde_json::to_value(state.install_mlx_diffusion().snapshot()).unwrap())
}

fn install_mlx_steps(slot: &crate::install_state::InstallSlot) -> Result<(), String> {
    let python = locate_python_311().ok_or_else(|| {
        "Python ≥ 3.11 not found. Install via `brew install python@3.12` and retry."
            .to_string()
    })?;
    slot.log(format!("Python: {}", python.display()));

    let venv_dir = mlx_root().join("venv");
    if !venv_dir.exists() {
        slot.log(format!("creating venv at {}", venv_dir.display()));
        std::fs::create_dir_all(mlx_root()).map_err(|e| os_error::english(&e))?;
        let out = crate::python::python_command(&python)
            .args(["-m", "venv", venv_dir.to_str().unwrap()])
            .output()
            .map_err(|e| format!("venv create failed to spawn: {}", os_error::english(&e)))?;
        if !out.status.success() {
            return Err(format!(
                "venv create failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }

    let req_path = mlx_root().join("requirements.txt");
    let server_path = mlx_root().join("server.py");
    std::fs::write(&req_path, REQUIREMENTS_TXT)
        .map_err(|e| format!("write requirements.txt: {e}"))?;
    std::fs::write(&server_path, SERVER_PY).map_err(|e| format!("write server.py: {}", os_error::english(&e)))?;

    slot.log("running pip install (this pulls torch + diffusers, ~3 GB)");
    let out = crate::python::python_command(venv_pip())
        .args(["install", "--upgrade", "-r", req_path.to_str().unwrap()])
        .output()
        .map_err(|e| format!("pip install spawn: {}", os_error::english(&e)))?;
    if !out.status.success() {
        return Err(format!(
            "pip install failed: {}",
            truncate(&String::from_utf8_lossy(&out.stderr), 800)
        ));
    }
    slot.log("pip install complete");

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
    let prefetch = prefetch.as_str();
    let mut prefetch_cmd = crate::python::python_command(venv_python());
    prefetch_cmd
        .args(["-c", prefetch])
        .env("HF_HOME", mlx_root().join("cache"))
        .env("HF_XET_CACHE", hf_xet_cache_dir());
    apply_hf_token(&mut prefetch_cmd);
    let out = prefetch_cmd
        .output()
        .map_err(|e| format!("model prefetch spawn: {}", os_error::english(&e)))?;
    if !out.status.success() {
        return Err(format!(
            "model prefetch failed: {}",
            truncate(&String::from_utf8_lossy(&out.stderr), 800)
        ));
    }
    slot.log("model pre-pull complete");

    Ok(())
}

fn locate_python_311() -> Option<PathBuf> {
    for candidate in ["python3.12", "python3.11", "python3"] {
        let Ok(p) = which::which(candidate) else {
            continue;
        };
        if let Some(version) = python_version(&p) {
            if version_at_least(&version, 3, 11) {
                return Some(p);
            }
        }
    }
    None
}

fn python_version(python: &PathBuf) -> Option<String> {
    let out = crate::python::python_command(python).arg("--version").output().ok()?;
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let v = if v.is_empty() {
        String::from_utf8_lossy(&out.stderr).trim().to_string()
    } else {
        v
    };
    Some(v.trim_start_matches("Python ").to_string())
}

fn version_at_least(version: &str, major: u32, minor: u32) -> bool {
    let parts: Vec<&str> = version.split('.').take(2).collect();
    if parts.len() < 2 {
        return false;
    }
    let (Ok(maj), Ok(min)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) else {
        return false;
    };
    maj > major || (maj == major && min >= minor)
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
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
    /// `snapshot_download` allow_patterns — hf_hub fnmatch, `*` crosses `/`.
    #[serde(skip)]
    allow: &'static [&'static str],
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
        description: "Instant 512px drafts in 1–4 steps. Runs on every Apple Silicon Mac — the starter pick.",
        allow: allow!["tokenizer/*", "text_encoder/*fp16*", "unet/*fp16*", "vae/*fp16*"],
    },
    ImageCatalogEntry {
        id: "realistic-vision-v51",
        name: "Realistic Vision V5.1",
        repo: "SG161222/Realistic_Vision_V5.1_noVAE",
        size_gb: 4.4,
        min_ram_gb: 8,
        steps: 28,
        guidance: 5.0,
        cfg_param: "guidance_scale",
        dtype: "float16",
        fp16_variant: false,
        disable_safety_checker: true,
        default_size: 512,
        unfiltered: true,
        description: "The classic photoreal SD1.5 — people, skin, portraits. Unfiltered, runs on 8 GB Macs.",
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
        description: "SDXL turbo allrounder — art, fantasy, photo, 1024px in ~8 steps. Best quality/speed on 16 GB.",
        allow: allow![
            "tokenizer/*", "tokenizer_2/*",
            "text_encoder/*fp16*", "text_encoder_2/*fp16*",
            "unet/*fp16*", "vae/*fp16*"
        ],
    },
    ImageCatalogEntry {
        id: "realvisxl-v5",
        name: "RealVisXL V5.0",
        repo: "SG161222/RealVisXL_V5.0",
        size_gb: 7.0,
        min_ram_gb: 16,
        steps: 25,
        guidance: 5.0,
        cfg_param: "guidance_scale",
        dtype: "float16",
        fp16_variant: true,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: true,
        description: "Top photoreal SDXL — the RealVis series is the realism benchmark. Unfiltered.",
        allow: allow![
            "tokenizer/*", "tokenizer_2/*",
            "text_encoder/*fp16*", "text_encoder_2/*fp16*",
            "unet/*fp16*", "vae/*fp16*"
        ],
    },
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
        description: "Unfiltered SDXL by UnfilteredAI, no content restrictions.",
        // This repo has fp16 weights for the unet and the VAE and none for
        // either text encoder, so the fp16 patterns copied from the RealVisXL
        // entry above matched no encoder file at all: GitHub 127. The install
        // now resolves its file set from the hub listing and only falls back
        // to these patterns when the listing cannot be read, but the patterns
        // still have to name files this repository actually contains.
        allow: allow![
            "tokenizer/*", "tokenizer_2/*",
            "text_encoder/model.safetensors", "text_encoder_2/model.safetensors",
            "unet/*fp16*", "vae/*fp16*"
        ],
    },
    ImageCatalogEntry {
        id: "z-image-turbo",
        name: "Z-Image Turbo",
        repo: "Tongyi-MAI/Z-Image-Turbo",
        size_gb: 25.0,
        min_ram_gb: 32,
        steps: 9,
        guidance: 0.0,
        cfg_param: "guidance_scale",
        dtype: "bfloat16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: false,
        description: "Alibaba's 6B flagship turbo — photoreal + text rendering at 1024px in 9 steps. Needs 32 GB.",
        allow: allow![
            "tokenizer/*",
            "transformer/*.safetensors",
            "text_encoder/*.safetensors",
            "vae/*.safetensors"
        ],
    },
    ImageCatalogEntry {
        id: "qwen-image",
        name: "Qwen-Image",
        repo: "Qwen/Qwen-Image",
        size_gb: 55.0,
        min_ram_gb: 64,
        steps: 40,
        guidance: 4.0,
        cfg_param: "true_cfg_scale",
        dtype: "bfloat16",
        fp16_variant: false,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: false,
        description: "20B MMDiT — the strongest open image model for complex prompts and in-image text. 64 GB Macs.",
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
        return Err(format!("the hub answered HTTP {}", response.status().as_u16()));
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
fn fetch_repo_listing(
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
    crate::commands::video::run_streamed(slot, &mut cmd)
        .map_err(|e| format!("re-fetching {}: {e}", repair.path))?;

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
        .map(|c| {
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
                "installed": image_model_is_installed(c),
            })
        })
        .collect();
    Ok(Value::Array(out))
}

pub fn mlx_image_install_model(state: &AppState, args: &Value) -> CmdResult {
    if std::env::consts::OS != "macos" {
        return Err(crate::commands::bad_request(
            "MLX image models are macOS-only",
        ));
    }
    let id = args
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| crate::commands::bad_request("missing id"))?;
    let entry = image_catalog_lookup(id)
        .ok_or_else(|| crate::commands::bad_request(format!("unknown image model id: {id}")))?;
    if !venv_python().exists() {
        return Err(crate::commands::bad_request(
            "MLX image engine not installed — run install_mlx_diffusion first",
        ));
    }
    // The venv binary appears seconds into the engine install, long before
    // pip has filled it — a model install started in that window dies with
    // a cryptic ModuleNotFoundError.
    if state.install_mlx_diffusion().is_running() {
        return Err(crate::commands::bad_request(
            "the MLX image engine is still installing — wait for it to finish first",
        ));
    }
    let slot = state.install_mlx_image_model();
    if slot.is_running() {
        return Ok(json!({ "ok": true, "status": "installing" }));
    }
    if image_model_is_installed(entry) {
        slot.complete(format!("{} already installed", entry.id));
        return Ok(json!({ "ok": true, "status": "complete", "id": entry.id }));
    }
    slot.start();
    let slot2 = slot.clone();
    let entry2 = entry.clone();
    std::thread::spawn(move || {
        let python = venv_python().to_string_lossy().to_string();
        if let Err(e) = crate::commands::video::ensure_python_module(
            &slot2,
            &python,
            "huggingface_hub",
            "huggingface_hub",
        ) {
            slot2.fail(e);
            return;
        }
        // Ask the repo what it has before pulling anything. The hand-written
        // allow patterns stay as the offline fallback and nothing more: a
        // pattern that matches no file in this particular repo is how a
        // download finishes at the promised size with a component left empty.
        let revision = fetch_repo_revision(entry2.repo)
            .map_err(|e| slot2.log(format!("could not read the current commit of {} ({e})", entry2.repo)))
            .ok();
        let listing = revision.as_deref().and_then(|rev| match fetch_repo_listing(entry2.repo, rev) {
            Ok(files) => Some(files),
            Err(e) => {
                slot2.log(format!(
                    "could not read the file list of {} ({e}) - falling back to the built-in download patterns",
                    entry2.repo
                ));
                None
            }
        });
        let prefer = prefer_variant(&entry2);
        let plan = listing.as_ref().zip(revision.as_deref()).and_then(|(files, rev)| {
            fetch_model_index(entry2.repo, rev)
                .map_err(|e| slot2.log(format!("could not read model_index.json ({e})")))
                .ok()
                .map(|manifest| crate::commands::mlx_snapshot::plan_download(files, &manifest, prefer))
        });
        let patterns: Vec<String> = match &plan {
            Some(plan) => {
                for component in &plan.without_weights {
                    slot2.log(format!("{} carries no weights file in this repository", component));
                }
                plan.files.iter().map(|f| f.path.clone()).collect()
            }
            None => entry2.allow.iter().map(|p| p.to_string()).collect(),
        };
        let total = plan
            .as_ref()
            .map(|p| p.bytes)
            .unwrap_or((entry2.size_gb as f64 * 1e9) as u64);
        slot2.log(format!(
            "pulling {} ({})",
            entry2.repo,
            crate::commands::mlx_snapshot::human_bytes(total)
        ));
        crate::install_state::watch_dir_size(
            slot2.clone(),
            image_model_cache_dir(entry2.repo),
            Some(hf_xet_cache_dir()),
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
            r = entry2.repo,
            p = patterns.iter().map(|p| format!("{p:?}")).collect::<Vec<_>>().join(","),
        );
        let mut cmd = crate::python::python_command(&python);
        cmd.args(["-c", &script])
            .env("HF_HOME", mlx_root().join("cache"))
        .env("HF_XET_CACHE", hf_xet_cache_dir());
        apply_hf_token(&mut cmd);
        if let Err(e) = crate::commands::video::run_streamed(&slot2, &mut cmd) {
            slot2.fail(e);
            return;
        }
        match finish_image_install(&slot2, &python, &entry2, revision.as_deref(), listing.as_deref()) {
            Ok(done) => slot2.complete(done),
            Err(why) => slot2.fail(why),
        }
    });
    Ok(json!({ "ok": true, "status": "installing", "id": entry.id }))
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
    install_outcome(entry.id, &snapshot::audit_snapshot(&snap, listing, prefer), &fetched)
}

pub fn mlx_image_install_status(state: &AppState, _args: &Value) -> CmdResult {
    Ok(serde_json::to_value(state.install_mlx_image_model().snapshot()).unwrap())
}

pub fn mlx_image_delete_model(state: &AppState, args: &Value) -> CmdResult {
    let id = args
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| crate::commands::bad_request("missing id"))?;
    let entry = image_catalog_lookup(id)
        .ok_or_else(|| crate::commands::bad_request(format!("unknown image model id: {id}")))?;
    if state.install_mlx_image_model().is_running() {
        return Err(crate::commands::bad_request(
            "a model install is running — wait for it to finish first",
        ));
    }
    let dir = image_model_cache_dir(entry.repo);
    if !dir.is_dir() {
        return Err(crate::commands::not_found(format!("{id} is not installed")));
    }
    std::fs::remove_dir_all(&dir)
        .map_err(|e| crate::commands::internal(format!("delete {id}: {}", os_error::english(&e))))?;
    Ok(json!({ "ok": true, "id": id }))
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

    let client = reqwest::Client::builder()
        // Big pipelines (Z-Image, Qwen-Image) take minutes to page in from
        // disk on first use — the old 120 s timeout aborted mid-load.
        .timeout(std::time::Duration::from_secs(900))
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
    let res = client
        .post(format!("http://127.0.0.1:{MLX_PORT}/generate"))
        .json(&body)
        .send()
        .await
        .map_err(|e| crate::commands::internal(format!("mlx unreachable: {}", os_error::english(&e))))?;
    if !res.status().is_success() {
        let s = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(crate::commands::internal(format!("HTTP {s}: {text}")));
    }
    let mut payload: Value = res
        .json()
        .await
        .map_err(|e| crate::commands::internal(e.to_string()))?;

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
    if let Some(b64) = payload.get("image_base64").and_then(|v| v.as_str()) {
        match write_generated_png(b64) {
            Ok(path) => {
                if let Some(obj) = payload.as_object_mut() {
                    obj.insert("output".into(), json!(path.to_string_lossy()));
                }
            }
            Err(e) => println!("[MLX] could not persist the render ({e}) — gallery entry stays session-only"),
        }
    }
    Ok(payload)
}

/// Where generated stills live. Sibling of the video lane's outputs root and
/// covered by the same read_media_file allow-list.
pub(crate) fn images_root() -> PathBuf {
    crate::os_paths::config_root().join("images")
}

fn write_generated_png(b64: &str) -> Result<PathBuf, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("decode: {e}"))?;
    let dir = images_root();
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), os_error::english(&e)))?;
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

pub fn mlx_start(_state: &AppState, _args: &Value) -> CmdResult {
    if !venv_python().exists() {
        return Err(crate::commands::bad_request(
            "MLX not installed yet — run install_mlx_diffusion first",
        ));
    }
    let server = mlx_root().join("server.py");
    // Refresh the deployed sidecar from the embedded copy — otherwise a
    // bridge update keeps spawning whatever install_mlx_diffusion wrote
    // months ago.
    std::fs::write(&server, SERVER_PY)
        .map_err(|e| crate::commands::internal(format!("write server.py: {}", os_error::english(&e))))?;
    let log_path = mlx_root().join("server.log");
    let stdout = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| crate::commands::internal(format!("log open: {e}")))?;
    let stderr = stdout
        .try_clone()
        .map_err(|e| crate::commands::internal(e.to_string()))?;

    // The sidecar re-validates every file of a model against the hub when it
    // loads one, so it needs the token as much as the installer does.
    let mut server_cmd = crate::python::python_command(venv_python());
    server_cmd
        .arg(&server)
        .env("LU_MLX_PORT", MLX_PORT.to_string())
        .env("HF_HOME", mlx_root().join("cache"))
        .env("HF_XET_CACHE", hf_xet_cache_dir())
        .stdout(stdout)
        .stderr(stderr);
    apply_hf_token(&mut server_cmd);
    server_cmd
        .spawn()
        .map_err(|e| crate::commands::internal(format!("spawn mlx server: {}", os_error::english(&e))))?;

    Ok(json!({"ok": true, "port": MLX_PORT, "log": log_path.to_string_lossy()}))
}

// ── REMOVED on 01.09.2026: `mlx_stop` (KF-19) ─────────────────────────────
//
// It was two lines — `kill_listeners_on_port(MLX_PORT)` and an `{"ok":true}` —
// under a doc comment calling itself "the Stop button counterpart to
// `mlx_start`". Counted before removing: no Rust caller, no
// `#[tauri::command]` wrapper in `media_cmds.rs`, no line in `main.rs`'s
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
// Wiring it would have meant a bridge in `media_cmds.rs`, a line in `main.rs`
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
    fn version_at_least_accepts_higher_minor() {
        assert!(version_at_least("3.12.1", 3, 11));
        assert!(version_at_least("3.11.0", 3, 11));
    }

    #[test]
    fn version_at_least_rejects_lower_minor() {
        assert!(!version_at_least("3.10.5", 3, 11));
        assert!(!version_at_least("2.7.0", 3, 11));
    }

    #[test]
    fn version_at_least_rejects_garbage() {
        assert!(!version_at_least("abc", 3, 11));
        assert!(!version_at_least("", 3, 11));
        assert!(!version_at_least("3", 3, 11));
    }

    #[test]
    fn truncate_appends_ellipsis_when_over_limit() {
        assert_eq!(truncate("abc", 10), "abc");
        assert_eq!(truncate("abcdefghijkl", 5), "abcde…");
    }

    #[test]
    fn image_catalog_ids_are_unique_and_complete() {
        let mut ids: Vec<&str> = IMAGE_CATALOG.iter().map(|c| c.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), IMAGE_CATALOG.len(), "duplicate catalog id");
        assert_eq!(IMAGE_CATALOG.len(), 7);
        assert_eq!(
            IMAGE_CATALOG.iter().filter(|c| c.unfiltered).count(),
            3,
            "exactly three unfiltered picks"
        );
        // Small-to-large hardware coverage.
        assert!(IMAGE_CATALOG.iter().any(|c| c.min_ram_gb <= 8));
        assert!(IMAGE_CATALOG.iter().any(|c| c.min_ram_gb >= 64));
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

    #[test]
    fn embedded_assets_are_non_empty() {
        // include_str! at compile time guarantees these are populated;
        // the assertion turns a typo'd path into a build-time failure
        // instead of an empty-write at install time.
        assert!(REQUIREMENTS_TXT.contains("torch"));
        assert!(SERVER_PY.contains("FastAPI"));
    }
}
