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
use std::path::PathBuf;
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
    let token = HF_TOKEN.read().ok().and_then(|t| t.clone());
    if let Some(t) = token {
        cmd.env("HF_TOKEN", t);
    }
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
        let out = Command::new(&python)
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
    let out = Command::new(venv_pip())
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
    let mut prefetch_cmd = Command::new(venv_python());
    prefetch_cmd
        .args(["-c", prefetch])
        .env("HF_HOME", mlx_root().join("cache"));
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
    let out = Command::new(python).arg("--version").output().ok()?;
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
        name: "NSFW-gen v2",
        repo: "UnfilteredAI/NSFW-gen-v2",
        size_gb: 5.3,
        min_ram_gb: 16,
        steps: 30,
        guidance: 7.0,
        cfg_param: "guidance_scale",
        dtype: "float16",
        fp16_variant: true,
        disable_safety_checker: false,
        default_size: 1024,
        unfiltered: true,
        description: "Explicitly unfiltered SDXL by UnfilteredAI — no content restrictions, adult themes included.",
        allow: allow![
            "tokenizer/*", "tokenizer_2/*",
            "text_encoder/*fp16*", "text_encoder_2/*fp16*",
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

fn image_model_is_installed(entry: &ImageCatalogEntry) -> bool {
    let snaps = image_model_cache_dir(entry.repo).join("snapshots");
    let Ok(read) = std::fs::read_dir(&snaps) else {
        return false;
    };
    read.flatten().any(|e| snapshot_is_complete(&e.path()))
}

/// A snapshot counts as installed only when the pipeline it manifests can
/// actually load. `snapshot_download` writes the small JSONs first, so
/// checking for `model_index.json` alone declared a download aborted after
/// two seconds "Installed" (live find, 2026-07-31: configs plus the VAE on
/// disk, unet and text_encoder missing, the row offered Remove and a render
/// would have died on local_files_only). The manifest itself says which
/// component directories exist; every model component among them must carry
/// at least one non-empty weights file. Scheduler/tokenizer entries are
/// config-only and skipped.
fn snapshot_is_complete(snap: &std::path::Path) -> bool {
    let index = snap.join("model_index.json");
    let Ok(raw) = std::fs::read_to_string(&index) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    let Some(map) = json.as_object() else {
        return false;
    };
    map.iter()
        .filter(|(k, _)| !k.starts_with('_'))
        // Only real component references count: a ["lib", "Class"] pair.
        // Manifests also carry scalars (requires_safety_checker: true) and
        // [null, null] stubs for absent components (feature_extractor,
        // safety_checker); demanding weights for those declared every
        // complete install missing.
        .filter_map(|(k, v)| v.get(1).and_then(|c| c.as_str()).map(|class| (k, class)))
        .filter(|(_, class)| {
            !(class.contains("Scheduler")
                || class.contains("Tokenizer")
                || class.contains("Processor")
                || class.contains("FeatureExtractor"))
        })
        .all(|(component, _)| {
            let dir = snap.join(component);
            let Ok(read) = std::fs::read_dir(&dir) else {
                return false;
            };
            read.flatten().any(|f| {
                let p = f.path();
                let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
                (ext == "safetensors" || ext == "bin")
                    && f.metadata().map(|m| m.len() > 0).unwrap_or(false)
            })
        })
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
    slot.log(format!("pulling {} ({} GB)", entry.repo, entry.size_gb));
    crate::install_state::watch_dir_size(
        slot.clone(),
        image_model_cache_dir(entry.repo),
        (entry.size_gb as f64 * 1e9) as u64,
    );
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
        let patterns = entry2
            .allow
            .iter()
            .map(|p| format!("{p:?}"))
            .collect::<Vec<_>>()
            .join(",");
        let script = format!(
            "from huggingface_hub import snapshot_download; snapshot_download(repo_id={r:?}, allow_patterns=[{p}])",
            r = entry2.repo,
            p = patterns,
        );
        let mut cmd = Command::new(&python);
        cmd.args(["-c", &script])
            .env("HF_HOME", mlx_root().join("cache"));
        apply_hf_token(&mut cmd);
        if let Err(e) = crate::commands::video::run_streamed(&slot2, &mut cmd) {
            slot2.fail(e);
        } else if !image_model_is_installed(&entry2) {
            slot2.fail("download finished but the model snapshot is incomplete");
        } else {
            slot2.complete(format!("{} installed", entry2.id));
        }
    });
    Ok(json!({ "ok": true, "status": "installing", "id": entry.id }))
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
        "variant": if entry.fp16_variant { Some("fp16") } else { None::<&str> },
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
    let mut server_cmd = Command::new(venv_python());
    server_cmd
        .arg(&server)
        .env("LU_MLX_PORT", MLX_PORT.to_string())
        .env("HF_HOME", mlx_root().join("cache"))
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
    /// model_index.json and every config on disk, but no unet weights. That
    /// snapshot must NOT read as installed, or the row offers Remove and a
    /// local_files_only render dies. Weights present flips it to installed.
    #[test]
    fn aborted_snapshot_is_not_installed_until_weights_exist() {
        let snap = std::env::temp_dir().join(format!("lu-snap-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&snap);
        for d in ["unet", "vae", "text_encoder", "scheduler", "tokenizer"] {
            std::fs::create_dir_all(snap.join(d)).unwrap();
        }
        // The stubs real manifests carry (live dump 2026-07-31): [null, null]
        // components, scalar flags, plain null. None of them may be demanded
        // as directories, or every complete install reads as missing.
        std::fs::write(
            snap.join("model_index.json"),
            r#"{
              "_class_name": "StableDiffusionPipeline",
              "feature_extractor": [null, null],
              "safety_checker": [null, null],
              "requires_safety_checker": true,
              "image_encoder": null,
              "scheduler": ["diffusers", "EulerDiscreteScheduler"],
              "text_encoder": ["transformers", "CLIPTextModel"],
              "tokenizer": ["transformers", "CLIPTokenizer"],
              "unet": ["diffusers", "UNet2DConditionModel"],
              "vae": ["diffusers", "AutoencoderKL"]
            }"#,
        )
        .unwrap();
        // Configs alone (the aborted-download shape): not installed.
        std::fs::write(snap.join("unet/config.json"), "{}").unwrap();
        std::fs::write(snap.join("vae/config.json"), "{}").unwrap();
        assert!(!snapshot_is_complete(&snap), "configs without weights must not count");

        // Weights for two of three model components: still not installed.
        std::fs::write(snap.join("vae/diffusion_pytorch_model.fp16.safetensors"), b"w").unwrap();
        std::fs::write(snap.join("text_encoder/model.fp16.safetensors"), b"w").unwrap();
        assert!(!snapshot_is_complete(&snap), "a missing unet must not count");

        // Zero-byte weights are a torn write, not an install.
        std::fs::write(snap.join("unet/diffusion_pytorch_model.fp16.safetensors"), b"").unwrap();
        assert!(!snapshot_is_complete(&snap), "an empty weights file must not count");

        std::fs::write(snap.join("unet/diffusion_pytorch_model.fp16.safetensors"), b"w").unwrap();
        assert!(snapshot_is_complete(&snap), "all model components carrying weights count");

        // Scheduler and tokenizer are config-only and must not be required
        // to carry weights (they never do).
        let _ = std::fs::remove_dir_all(&snap);
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
