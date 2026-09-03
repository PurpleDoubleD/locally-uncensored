//! MLX-video pipeline.
//!
//! Driven via subprocess against the [`mlx-video`](https://github.com/Blaizzy/mlx-video)
//! Python package. Apple Silicon only — the Bridge guards every entry point
//! with an arch check so Windows/Linux clients hitting these commands by
//! accident get a clear 400 instead of a hung subprocess.
//!
//! Models are downloaded into `<os_paths::cache_dir()>/mlx-video/<id>/` (the
//! `--model-dir` argument passed to `mlx_video.<family>.generate`), Linux also
//! `~/.cache/<APP_DIR>/mlx-video/<id>/`.
//! Generated videos land in `<os_paths::config_root()>/videos/<job_id>.mp4`.
//! `<APP_DIR>` kommt aus `app_identity` und trägt auf diesem Branch einen
//! eigenen Suffix.

use crate::os_error;
use crate::commands::{bad_request, internal, CmdResult};
use crate::state::AppState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Command, Stdio};

// ── Hardware guard ────────────────────────────────────────────────────

fn ensure_apple_silicon() -> Result<(), String> {
    if std::env::consts::OS == "macos" && std::env::consts::ARCH == "aarch64" {
        Ok(())
    } else {
        Err(bad_request(
            "MLX video is Apple Silicon only — use the ComfyUI backend on this OS",
        ))
    }
}

// ── Model catalog ─────────────────────────────────────────────────────
//
// Curated list of models that `mlx-video` can drive today. The frontend
// renders one card per entry; the user clicks Install and the Bridge pulls
// the HF repo into `models_root()/<id>/`.

#[derive(serde::Serialize, Clone)]
struct CatalogEntry {
    id: &'static str,
    name: &'static str,
    family: &'static str, // mlx_video.models.<family>.generate
    repo: &'static str,
    /// ltx_2 `--pipeline {distilled,dev,dev-two-stage,...}` — unused by wan_2.
    pipeline: &'static str,
    size_gb: f32,
    min_ram_gb: u32,
    /// Default `-n`/`--num-frames` (wan_2 requires 4n+1).
    default_frames: u32,
    default_width: u32,
    default_height: u32,
    /// wan_2 repos ship PyTorch checkpoints — install runs the one-time
    /// `mlx_video.models.wan_2.convert` step (needs ~2× the size on disk
    /// while converting; the source checkpoint is removed afterwards).
    needs_convert: bool,
    unfiltered: bool,
    description: &'static str,
}

// Only repos that ACTUALLY exist on HuggingFace (every one verified HTTP 200,
// ungated, sizes from the API) and that `mlx-video` can drive today:
//   - ltx_2  → prince-canuma/LTX-2* — the package author's PRE-CONVERTED
//     modular repos. This replaces the mlx-community bf16 single-file repos,
//     whose flat layout crashed generation (BUG-022) — resolved by repo swap.
//   - wan_2  → the original Wan-AI checkpoints + the package's convert step
//     (`--model-dir <converted>`); Wan has no built-in content filter.
const CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        id: "wan21-t2v-1.3b",
        name: "Wan 2.1 T2V 1.3B",
        family: "wan_2",
        repo: "Wan-AI/Wan2.1-T2V-1.3B",
        pipeline: "",
        size_gb: 18.0,
        min_ram_gb: 16,
        default_frames: 81,
        default_width: 832,
        default_height: 480,
        needs_convert: true,
        unfiltered: true,
        description: "The smallest real video model on Apple Silicon — 480p text-to-video, unfiltered, runs on 16 GB Macs. One-time convert to MLX after download.",
    },
    CatalogEntry {
        id: "wan22-ti2v-5b",
        name: "Wan 2.2 TI2V 5B",
        family: "wan_2",
        repo: "Wan-AI/Wan2.2-TI2V-5B",
        pipeline: "",
        size_gb: 35.0,
        min_ram_gb: 32,
        default_frames: 81,
        default_width: 1280,
        default_height: 704,
        needs_convert: true,
        unfiltered: true,
        description: "720p text- AND image-to-video in one 5B model — the sweet spot on 32 GB Macs. Unfiltered.",
    },
    CatalogEntry {
        id: "ltx-2.3-dev",
        name: "LTX-2.3 Dev",
        family: "ltx_2",
        repo: "prince-canuma/LTX-2.3-dev",
        pipeline: "dev",
        size_gb: 58.0,
        min_ram_gb: 48,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        needs_convert: false,
        unfiltered: false,
        description: "Latest LTX generation with CFG — text/image-to-video with audio, pre-converted MLX weights.",
    },
    CatalogEntry {
        id: "wan21-t2v-14b",
        name: "Wan 2.1 T2V 14B",
        family: "wan_2",
        repo: "Wan-AI/Wan2.1-T2V-14B",
        pipeline: "",
        size_gb: 70.0,
        min_ram_gb: 48,
        default_frames: 81,
        default_width: 1280,
        default_height: 704,
        needs_convert: true,
        unfiltered: true,
        description: "720p Wan at full 14B quality — the classic uncensored heavyweight. One-time convert after download.",
    },
    CatalogEntry {
        id: "ltx-2.3-distilled",
        name: "LTX-2.3 Distilled",
        family: "ltx_2",
        repo: "prince-canuma/LTX-2.3-distilled",
        pipeline: "distilled",
        size_gb: 96.0,
        min_ram_gb: 64,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        needs_convert: false,
        unfiltered: false,
        description: "LTX-2.3 distilled incl. 2× upscaler stages — fast high-res video with audio on 64 GB Macs.",
    },
    CatalogEntry {
        id: "ltx-2-distilled",
        name: "LTX-2 Distilled",
        family: "ltx_2",
        repo: "prince-canuma/LTX-2-distilled",
        pipeline: "distilled",
        size_gb: 109.0,
        min_ram_gb: 64,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        needs_convert: false,
        unfiltered: false,
        description: "The 19B LTX-2 distilled — text/image-to-video with audio, pre-converted modular MLX weights.",
    },
    CatalogEntry {
        id: "wan22-t2v-a14b",
        name: "Wan 2.2 T2V A14B",
        family: "wan_2",
        repo: "Wan-AI/Wan2.2-T2V-A14B",
        pipeline: "",
        size_gb: 127.0,
        min_ram_gb: 64,
        default_frames: 81,
        default_width: 1280,
        default_height: 704,
        needs_convert: true,
        unfiltered: true,
        description: "Wan 2.2's dual-model MoE flagship — the strongest open video model that runs on a Mac. Unfiltered, 64 GB+ only.",
    },
];

fn catalog_lookup(id: &str) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|c| c.id == id)
}

// ── Filesystem layout ─────────────────────────────────────────────────

pub(crate) fn models_root() -> PathBuf {
    crate::os_paths::cache_dir().join("mlx-video")
}

pub(crate) fn outputs_root() -> PathBuf {
    crate::os_paths::config_root().join("videos")
}

fn model_dir(id: &str) -> PathBuf {
    models_root().join(id)
}

/// Directory the generate CLI actually points at: the converted MLX weights
/// for wan_2 (`<id>/mlx`), the pre-converted download itself for ltx_2.
fn weights_dir(entry: &CatalogEntry) -> PathBuf {
    if entry.needs_convert {
        model_dir(entry.id).join("mlx")
    } else {
        model_dir(entry.id)
    }
}

fn dir_non_empty(dir: &PathBuf) -> bool {
    dir.is_dir() && std::fs::read_dir(dir).map(|mut it| it.next().is_some()).unwrap_or(false)
}

fn model_is_installed(entry: &CatalogEntry) -> bool {
    dir_non_empty(&weights_dir(entry))
}

// ── mlx-video CLI detection ───────────────────────────────────────────

fn python_for(state: &AppState) -> Option<String> {
    // Prefer the MLX venv interpreter created by install_mlx_diffusion: it
    // already has huggingface_hub + torch (so snapshot_download and the wan
    // convert work without re-installing them), and it is the shared
    // Apple-Silicon ML interpreter, so mlx-video installs there too. The
    // onboarding python_bin comes second — it's a bare interpreter that
    // ensure_python_module has to bootstrap first (BUG-018).
    let venv = crate::os_paths::data_dir()
        .join("mlx")
        .join("venv")
        .join("bin")
        .join("python");
    venv.exists()
        .then(|| venv.to_string_lossy().to_string())
        .or_else(|| state.python_bin())
        .or_else(|| crate::os_paths::find_python().map(|p| p.to_string_lossy().to_string()))
}

fn mlx_video_installed(python: &str) -> bool {
    Command::new(python)
        .args(["-c", "import mlx_video"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn python_has_module(python: &str, module: &str) -> bool {
    Command::new(python)
        .args(["-c", &format!("import {module}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Idempotent module bootstrap: the bridge's python is whatever the machine
/// has (system python, uv-managed, or our MLX venv) — `huggingface_hub`,
/// `torch` (wan convert reads .pth) and `mlx_video` itself are NOT givens.
/// Without this, installs died with a bare "command exited 1"
/// (ModuleNotFoundError swallowed in the worker thread).
pub(crate) fn ensure_python_module(
    slot: &crate::install_state::InstallSlot,
    python: &str,
    module: &str,
    pip_spec: &str,
) -> Result<(), String> {
    if python_has_module(python, module) {
        return Ok(());
    }
    slot.log(format!("installing {pip_spec} (one-time)"));
    let mut cmd = Command::new(python);
    cmd.args(["-m", "pip", "install", "--upgrade", pip_spec]);
    run_streamed(slot, &mut cmd)
        .map_err(|e| format!("pip install {pip_spec}: {e}"))?;
    if !python_has_module(python, module) {
        return Err(format!(
            "installed {pip_spec} but `import {module}` still fails"
        ));
    }
    Ok(())
}

fn mlx_video_version(python: &str) -> Option<String> {
    let out = Command::new(python)
        .args([
            "-c",
            "import importlib.metadata as m; print(m.version('mlx-video'))",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

// ── Commands ──────────────────────────────────────────────────────────

pub fn video_status(state: &AppState, _args: &Value) -> CmdResult {
    let apple_silicon =
        std::env::consts::OS == "macos" && std::env::consts::ARCH == "aarch64";
    let python = python_for(state);
    let mlx_ok = python.as_deref().map(mlx_video_installed).unwrap_or(false);
    let version = if mlx_ok {
        python.as_deref().and_then(mlx_video_version)
    } else {
        None
    };
    let installed_ids: Vec<&str> = CATALOG
        .iter()
        .filter(|c| model_is_installed(c))
        .map(|c| c.id)
        .collect();
    let running = state.video_process().lock().unwrap().is_some();
    Ok(json!({
        "available": apple_silicon,
        "appleSilicon": apple_silicon,
        "mlxInstalled": mlx_ok,
        "mlxVersion": version,
        "pythonBin": python,
        "modelsRoot": models_root(),
        "outputsRoot": outputs_root(),
        "installedModels": installed_ids,
        "running": running,
    }))
}

/// Remove an installed MLX-video model's weights. The id must be a catalog
/// entry, so the delete is confined to `<models_root>/<known-id>/`.
pub fn video_delete_model(state: &AppState, args: &Value) -> CmdResult {
    let id = args
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| crate::commands::bad_request("missing id".to_string()))?;
    let entry = catalog_lookup(id)
        .ok_or_else(|| crate::commands::bad_request(format!("unknown video model id: {id}")))?;
    if state.video_process().lock().unwrap().is_some() {
        return Err(crate::commands::bad_request(
            "a video job is running — cancel it before deleting the model".to_string(),
        ));
    }
    // The installer's snapshot_download is writing into this very directory —
    // model_is_installed() flips true at the first file, so the UI can offer
    // Delete mid-install without this guard.
    if state.install_video_model().is_running() {
        return Err(crate::commands::bad_request(
            "this model is still installing — wait for it to finish first".to_string(),
        ));
    }
    let dir = model_dir(entry.id);
    if !dir.is_dir() {
        return Err(crate::commands::not_found(format!("{id} is not installed")));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| internal(format!("delete {id}: {}", os_error::english(&e))))?;
    Ok(json!({ "ok": true, "id": id }))
}

pub fn video_list_models(_state: &AppState, _args: &Value) -> CmdResult {
    let mut out: Vec<Value> = Vec::with_capacity(CATALOG.len());
    for c in CATALOG {
        out.push(json!({
            "id": c.id,
            "name": c.name,
            "family": c.family,
            "repo": c.repo,
            // f32→JSON goes through f64 and turns 2.6 into 2.5999999046325684
            // — round to the tenth the catalog means.
            "sizeGB": (c.size_gb as f64 * 10.0).round() / 10.0,
            "minRamGB": c.min_ram_gb,
            "defaultFrames": c.default_frames,
            "needsConvert": c.needs_convert,
            "unfiltered": c.unfiltered,
            "description": c.description,
            "installed": model_is_installed(c),
        }));
    }
    Ok(Value::Array(out))
}

pub fn video_install_mlx(state: &AppState, _args: &Value) -> CmdResult {
    ensure_apple_silicon()?;
    let slot = state.install_mlx_video();
    if slot.is_running() {
        return Ok(json!({ "ok": true, "status": "installing" }));
    }
    let python = python_for(state)
        .ok_or_else(|| bad_request("Python not available — run install_python first"))?;
    if mlx_video_installed(&python) {
        slot.complete("mlx-video already installed");
        return Ok(json!({ "ok": true, "status": "complete" }));
    }
    slot.start();
    let slot2 = slot.clone();
    std::thread::spawn(move || {
        let mut cmd = Command::new(&python);
        cmd.args([
            "-m",
            "pip",
            "install",
            "--upgrade",
            "git+https://github.com/Blaizzy/mlx-video.git",
        ]);
        if let Err(e) = run_streamed(&slot2, &mut cmd) {
            slot2.fail(e);
        } else if !mlx_video_installed(&python) {
            slot2.fail("pip install finished but `import mlx_video` still fails");
        } else {
            slot2.complete("mlx-video installed");
        }
    });
    Ok(json!({ "ok": true, "status": "installing" }))
}

pub fn video_install_mlx_status(state: &AppState, _args: &Value) -> CmdResult {
    Ok(serde_json::to_value(state.install_mlx_video().snapshot()).unwrap())
}

#[derive(Deserialize)]
struct InstallModelArgs {
    id: String,
}

pub fn video_install_model(state: &AppState, args: &Value) -> CmdResult {
    ensure_apple_silicon()?;
    let a: InstallModelArgs =
        serde_json::from_value(args.clone()).map_err(|e| bad_request(e.to_string()))?;
    let entry = catalog_lookup(&a.id)
        .ok_or_else(|| bad_request(format!("unknown video model id: {}", a.id)))?;
    let slot = state.install_video_model();
    if slot.is_running() {
        return Ok(json!({ "ok": true, "status": "installing" }));
    }
    if model_is_installed(entry) {
        slot.complete(format!("{} already installed", entry.id));
        return Ok(json!({ "ok": true, "status": "complete", "id": entry.id }));
    }
    let python = python_for(state)
        .ok_or_else(|| bad_request("Python not available — run install_python first"))?;

    // Authoritative disk preflight — wan repos briefly need download + MLX
    // copy side by side during the convert step.
    let factor: f64 = if entry.needs_convert { 2.0 } else { 1.0 };
    let need = (entry.size_gb as f64 * factor * 1e9) as u64 + 2_000_000_000;
    if let Some((free, _, _)) = crate::commands::system::volume_space_for(&models_root()) {
        if free < need {
            return Err(bad_request(format!(
                "not enough disk space: {} needs ~{:.0} GB{} but only {:.0} GB are free",
                entry.name,
                need as f64 / 1e9,
                if entry.needs_convert { " (incl. one-time convert)" } else { "" },
                free as f64 / 1e9,
            )));
        }
    }

    let target = model_dir(entry.id);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| internal(os_error::english(&e)))?;
    }
    slot.start();
    crate::install_state::watch_dir_size(
        slot.clone(),
        model_dir(entry.id),
        (entry.size_gb as f64 * 1e9) as u64,
    );
    let slot2 = slot.clone();
    let entry2 = entry.clone();
    std::thread::spawn(move || {
        if let Err(e) = install_model_steps(&slot2, &python, &entry2) {
            slot2.fail(e);
        } else if !model_is_installed(&entry2) {
            slot2.fail("download finished but model directory is empty");
        } else {
            slot2.complete(format!("{} installed", entry2.id));
        }
    });
    Ok(json!({ "ok": true, "status": "installing", "id": entry.id }))
}

fn install_model_steps(
    slot: &crate::install_state::InstallSlot,
    python: &str,
    entry: &CatalogEntry,
) -> Result<(), String> {
    ensure_python_module(slot, python, "huggingface_hub", "huggingface_hub")?;
    // Generation needs the mlx-video package for BOTH families — installing
    // it here (not just for the wan convert) means a model installed from
    // the Discover tab generates on the first click instead of erroring
    // with "mlx-video not installed".
    ensure_python_module(
        slot,
        python,
        "mlx_video",
        "git+https://github.com/Blaizzy/mlx-video.git",
    )?;

    // wan_2: download the PyTorch checkpoint to <id>/src, convert to
    // <id>/mlx, then drop the source to give the disk back.
    let download_to = if entry.needs_convert {
        model_dir(entry.id).join("src")
    } else {
        model_dir(entry.id)
    };

    // `huggingface_hub.snapshot_download` is the supported way to pull
    // an HF repo with resume + progress. We invoke it inline so the
    // bridge doesn't need to ship the huggingface-cli binary.
    slot.log(format!("downloading {} ({} GB)", entry.repo, entry.size_gb));
    let script = format!(
        "from huggingface_hub import snapshot_download; snapshot_download(repo_id={r:?}, local_dir={t:?})",
        r = entry.repo,
        t = download_to.to_string_lossy(),
    );
    let mut cmd = Command::new(python);
    cmd.args(["-c", &script]);
    crate::commands::mlx::apply_hf_token(&mut cmd);
    run_streamed(slot, &mut cmd)?;

    if !entry.needs_convert {
        return Ok(());
    }

    // Convert additionally needs torch to read the .pth text encoder/VAE.
    ensure_python_module(slot, python, "torch", "torch")?;

    let out_dir = weights_dir(entry);
    slot.log(format!("converting {} to MLX (one-time)", entry.name));
    let mut convert = Command::new(python);
    convert
        .arg("-m")
        .arg("mlx_video.models.wan_2.convert")
        .arg("--checkpoint-dir")
        .arg(download_to.as_os_str())
        .arg("--output-dir")
        .arg(out_dir.as_os_str());
    run_streamed(slot, &mut convert).map_err(|e| format!("convert: {e}"))?;
    if !dir_non_empty(&out_dir) {
        return Err("convert finished but produced no MLX weights".to_string());
    }

    slot.log("removing the source checkpoint (converted copy is kept)");
    let _ = std::fs::remove_dir_all(&download_to);
    Ok(())
}

pub fn video_install_model_status(state: &AppState, _args: &Value) -> CmdResult {
    Ok(serde_json::to_value(state.install_video_model().snapshot()).unwrap())
}

#[derive(Deserialize)]
struct GenerateArgs {
    id: String,
    prompt: String,
    #[serde(default)]
    seconds: Option<f32>,
    #[serde(default)]
    fps: Option<u32>,
    #[serde(default)]
    init_image: Option<String>,
    #[serde(default)]
    seed: Option<i64>,
}

pub fn video_generate(state: &AppState, args: &Value) -> CmdResult {
    ensure_apple_silicon()?;
    let a: GenerateArgs =
        serde_json::from_value(args.clone()).map_err(|e| bad_request(e.to_string()))?;
    let entry = catalog_lookup(&a.id)
        .ok_or_else(|| bad_request(format!("unknown video model id: {}", a.id)))?;
    if !model_is_installed(entry) {
        return Err(bad_request(format!(
            "model {} not installed — run video_install_model first",
            entry.id
        )));
    }
    let python = python_for(state)
        .ok_or_else(|| bad_request("Python not available — run install_python first"))?;
    if !mlx_video_installed(&python) {
        return Err(bad_request("mlx-video not installed — run video_install_mlx first"));
    }
    {
        let video_process = state.video_process();
        let g = video_process.lock().unwrap();
        if g.is_some() {
            return Err(bad_request(
                "a video generation is already running — cancel it first",
            ));
        }
    }

    // Validate init_image BEFORE spawning: chat models sometimes hallucinate
    // a filename. A crisp, self-describing error lets the agent loop retry
    // without the image instead of surfacing an opaque subprocess exit(1).
    if let Some(img) = a.init_image.as_deref() {
        if !std::path::Path::new(img).is_file() {
            return Err(bad_request(format!(
                "init_image not found: {img} — pass the absolute path of a real image file, or omit init_image for text-to-video"
            )));
        }
    }

    let out_dir = outputs_root();
    std::fs::create_dir_all(&out_dir).map_err(|e| internal(os_error::english(&e)))?;
    let job_id = uuid::Uuid::new_v4().simple().to_string();
    let out_path = out_dir.join(format!("{}.mp4", job_id));

    let mdir = weights_dir(entry);

    // Frame count: caller can override via `seconds * fps`; otherwise use
    // the catalog default. mlx-video's frame flags count frames, not seconds.
    let fps = a.fps.unwrap_or(24).max(1);
    let frames = a
        .seconds
        .map(|s| (s * fps as f32).max(1.0) as u32)
        .unwrap_or(entry.default_frames);
    let frames = clamp_frames(entry.family, frames);

    // The two families take different CLIs (both verified against
    // Blaizzy/mlx-video):
    //   ltx_2 → --model-repo <dir> --pipeline <p> -o <out> -n <frames>
    //   wan_2 → --model-dir <dir> --num-frames (4n+1) --output-path <out>
    let mut cmd = Command::new(&python);
    cmd.arg("-m")
        .arg(format!("mlx_video.models.{}.generate", entry.family))
        .arg("--prompt")
        .arg(&a.prompt);
    if entry.family == "wan_2" {
        cmd.arg("--model-dir")
            .arg(mdir.as_os_str())
            .arg("--width")
            .arg(entry.default_width.to_string())
            .arg("--height")
            .arg(entry.default_height.to_string())
            .arg("--num-frames")
            .arg(frames.to_string())
            .arg("--output-path")
            .arg(out_path.as_os_str());
    } else {
        cmd.arg("--model-repo")
            .arg(mdir.as_os_str())
            .arg("--pipeline")
            .arg(entry.pipeline)
            .arg("-o")
            .arg(out_path.as_os_str())
            .arg("-n")
            .arg(frames.to_string());
    }
    if let Some(seed) = a.seed {
        cmd.arg("--seed").arg(seed.to_string());
    }
    if let Some(img) = a.init_image.as_deref() {
        cmd.arg("--image").arg(img);
    }

    // Reset the live progress slot — every new job starts clean.
    let progress = state.video_progress();
    progress.start();
    progress.log(format!("job {} → {}", job_id, out_path.display()));
    progress.log(format!(
        "python -m mlx_video.models.{}.generate --prompt … {} … ({} frames)",
        entry.family,
        mdir.display(),
        frames
    ));

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| internal(format!("spawn mlx_video: {}", os_error::english(&e))))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let pid = child.id();
    *state.video_process().lock().unwrap() = Some(child);

    // Stdout / stderr pumps → progress slot.
    let p_out = progress.clone();
    let p_err = progress.clone();
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        if let Some(s) = stdout {
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                p_out.log(line);
            }
        }
    });
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        if let Some(s) = stderr {
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                p_err.log(line);
            }
        }
    });

    // Reaper thread — polls try_wait, flips slot to complete/error, clears
    // the handle. It must NOT take the Child out of the mutex up front:
    // that made `video_progress.running` false the moment generation
    // started and left `video_cancel` with nothing to kill (the job ran on
    // uncancellable).
    //
    // AppState isn't Clone, so instead of cloning the whole state we clone
    // just the two Arc-backed handles the thread needs: the video-process
    // mutex itself (`video_process()` returns a cloned `Arc<Mutex<...>>`,
    // pointing at the same child the caller just stored) and the progress
    // InstallSlot.
    let video_process = state.video_process();
    let video_progress_slot = state.video_progress();
    let out_path2 = out_path.clone();
    let job_id_for_thread = job_id.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let mut guard = video_process.lock().unwrap();
        let Some(child) = guard.as_mut() else {
            // video_cancel took and killed it — the slot is already failed.
            return;
        };
        let status = match child.try_wait() {
            Ok(None) => continue,
            Ok(Some(s)) => Ok(s),
            Err(e) => Err(e),
        };
        *guard = None;
        drop(guard);
        match status {
            Ok(s) if s.success() && out_path2.exists() => {
                video_progress_slot.complete(format!("job {} complete → {}", job_id_for_thread, out_path2.display()));
            }
            Ok(s) => video_progress_slot.fail(format!("mlx_video exited {:?}", s.code())),
            Err(e) => video_progress_slot.fail(format!("wait failed: {e}")),
        }
        return;
    });

    Ok(json!({
        "ok": true,
        "jobId": job_id,
        "pid": pid,
        "output": out_path,
    }))
}

pub fn video_progress(state: &AppState, _args: &Value) -> CmdResult {
    let running = state.video_process().lock().unwrap().is_some();
    let snap = state.video_progress().snapshot();
    Ok(json!({
        "running": running,
        "status": snap.status,
        "logs": snap.logs,
        "error": snap.error,
    }))
}

pub fn video_cancel(state: &AppState, _args: &Value) -> CmdResult {
    let video_process = state.video_process();
    let mut g = video_process.lock().unwrap();
    if let Some(mut child) = g.take() {
        let _ = crate::process_util::kill_tree(&mut child);
        state.video_progress().fail("cancelled");
        return Ok(json!({ "ok": true }));
    }
    Ok(json!({ "ok": true, "was_running": false }))
}

// ── helpers ───────────────────────────────────────────────────────────

/// wan_2's temporal VAE requires `num_frames % 4 == 1`; ltx_2 takes any.
fn clamp_frames(family: &str, frames: u32) -> u32 {
    if family != "wan_2" {
        return frames.max(1);
    }
    let f = frames.max(5);
    f - ((f - 1) % 4)
}

pub(crate) fn run_streamed(slot: &crate::install_state::InstallSlot, cmd: &mut Command) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::process_util::no_window());
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn: {}", os_error::english(&e)))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let so = slot.clone();
    let se = slot.clone();
    let t1 = std::thread::spawn(move || {
        if let Some(s) = stdout {
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                so.log(line);
            }
        }
    });
    let t2 = std::thread::spawn(move || {
        if let Some(s) = stderr {
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                se.log(line);
            }
        }
    });
    let status = child
        .wait()
        .map_err(|e| format!("wait: {}", crate::os_error::english(&e)))?;
    let _ = t1.join();
    let _ = t2.join();
    if !status.success() {
        return Err(format!("command exited {:?}", status.code()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ids_unique_and_covers_hardware_range() {
        let mut ids: Vec<&str> = CATALOG.iter().map(|c| c.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), CATALOG.len(), "duplicate catalog id");
        assert_eq!(CATALOG.len(), 7);
        assert!(CATALOG.iter().filter(|c| c.unfiltered).count() >= 3);
        assert!(CATALOG.iter().any(|c| c.min_ram_gb <= 16));
        assert!(CATALOG.iter().any(|c| c.min_ram_gb >= 64));
    }

    #[test]
    fn catalog_families_match_cli_expectations() {
        for c in CATALOG {
            match c.family {
                "ltx_2" => {
                    assert!(!c.pipeline.is_empty(), "{} needs a --pipeline", c.id);
                    assert!(!c.needs_convert, "{}: ltx repos are pre-converted", c.id);
                }
                "wan_2" => {
                    assert!(c.needs_convert, "{}: wan checkpoints need convert", c.id);
                    assert_eq!(c.default_frames % 4, 1, "{}: wan frames must be 4n+1", c.id);
                }
                other => panic!("{}: unknown family {other}", c.id),
            }
            assert!(c.repo.contains('/'));
            assert!(c.size_gb > 0.0 && c.default_width > 0 && c.default_height > 0);
        }
    }

    #[test]
    fn clamp_frames_enforces_wan_4n_plus_1() {
        assert_eq!(clamp_frames("wan_2", 81), 81);
        assert_eq!(clamp_frames("wan_2", 80), 77);
        assert_eq!(clamp_frames("wan_2", 1), 5);
        assert_eq!(clamp_frames("ltx_2", 80), 80);
        assert_eq!(clamp_frames("ltx_2", 0), 1);
    }

    #[test]
    fn weights_dir_points_at_converted_output_for_wan() {
        let wan = CATALOG.iter().find(|c| c.family == "wan_2").unwrap();
        let ltx = CATALOG.iter().find(|c| c.family == "ltx_2").unwrap();
        assert!(weights_dir(wan).ends_with(format!("{}/mlx", wan.id)));
        assert!(weights_dir(ltx).ends_with(ltx.id));
    }
}
