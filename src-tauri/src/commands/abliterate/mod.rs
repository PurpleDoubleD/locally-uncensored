//! Remove refusals from a local model (A14, 3.0.8).
//!
//! A button in the Model Manager takes an installed GGUF, finds the original
//! Hugging Face weights it was made from, runs Heretic 1.4.0 (AGPL-3.0, like
//! LU) on them, checks the result against the original, converts it back to a
//! GGUF and puts it next to the original as a model of its own. The original
//! file is never written to. Grundlage: KONZEPT-ABLITERATION.md and the Mac
//! prototype of 20.10.2026.
//!
//! The steps of a run, each one a process the app can read and stop:
//!
//! 1. setup: LU's own Python (`private_python`), a venv of its own in
//!    `<data_dir>/abliterate/venv` with PyTorch for the chosen device and the
//!    pinned rest (`resources/abliterate/constraints.txt`), and llama.cpp's
//!    converter at the commit the engine is built from.
//! 2. download: the safetensors of the repo at the commit the dialog showed.
//! 3. check before: the ORIGINAL GGUF in a llama-server of its own, through
//!    the same short check as at the end (refusals on 50 JailbreakBench
//!    prompts, false alarms on 50 harmless ones, 200 MMLU questions, each
//!    answer kept as right or wrong so the two runs compare question by
//!    question).
//! 4. search: Heretic's trials, without its menus (`lu_abliterate.py search`).
//!    A stopped run carries on from Heretic's checkpoint next time.
//! 5. merge: the adapter into the original weights, shard by shard.
//! 6. convert and quantize: to the same quant type as the original.
//! 7. check after, then the intermediate files go.
//!
//! What it never does: upload anything (Heretic's upload is not reachable),
//! give a run more rights anywhere else in LU, or keep prompts and answers of
//! the check (only counts). The safety rules of LU do not depend on the model
//! refusing (see `src/lib/render/safety.ts` and the image and video tools).
//!
//! A run for larger models in LU Cloud is not built. `plan` only reports
//! whether a model's license would allow one (`cloudAllowed`, free licenses
//! only), so the dialog can say so where a model is too large.

pub mod plan;

use crate::os_error;
use crate::state::AppState;
use plan::{DeviceKind, DeviceOption, LicenseKind, Quantization};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

/// Bumped when the environment has to be rebuilt.
const ENV_VERSION: &str = "lu-abliterate-1";
const HERETIC_VERSION: &str = "1.4.0";
/// PyTorch for Apple Silicon from PyPI: the version the prototype ran on.
const TORCH_MAC: &str = "torch==2.14.1";

/// llama.cpp's converter, at the commit `scripts/build-llama.sh` builds the
/// engine from (b9949). The archive was fetched from GitHub's codeload host
/// on 25.10.2026 and compared with the prototype's copy; size and digest are
/// fixed here, so nothing read at run time decides what runs.
const LLAMA_COMMIT: &str = "049326a00025d00b08cc188ed716b681e984a3f8";
const LLAMA_ZIP_BYTES: u64 = 36_874_645;
const LLAMA_ZIP_SHA256: &str = "f18fc09e7a53fb277b6d7725d5c13f3bb9927acaaa8b6e42e0066c77928d68fa";

const REQUIREMENTS: &str = include_str!("../../../resources/abliterate/requirements.txt");
const CONSTRAINTS: &str = include_str!("../../../resources/abliterate/constraints.txt");

/// Prompts per refusal part of the check (refused, harmless refused).
/// JailbreakBench has 100 of each; the search never sees them.
const CHECK_N: u32 = 50;
/// MMLU questions in the check. 50 left a loss of three questions inside
/// chance (3.0.8 on the box: 22 → 21 of 50), so a real loss and noise read
/// the same; 200 cost the box about a minute more per check.
const MMLU_N: u32 = 200;
const LOG_LINES: usize = 160;

// ── Paths ─────────────────────────────────────────────────────────────────

fn root() -> PathBuf {
    crate::os_paths::data_dir().join("abliterate")
}

fn venv_dir() -> PathBuf {
    root().join("venv")
}

fn venv_python() -> PathBuf {
    if cfg!(windows) {
        venv_dir().join("Scripts").join("python.exe")
    } else {
        venv_dir().join("bin").join("python")
    }
}

fn convert_dir() -> PathBuf {
    root().join(format!("llama-convert-{}", &LLAMA_COMMIT[..12]))
}

fn runs_dir() -> PathBuf {
    root().join("runs")
}

fn env_marker() -> PathBuf {
    venv_dir().join(".lu-abliterate-ready")
}

/// The script, from the bundle or, in development, from the source tree.
fn script_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let rel = Path::new("resources").join("abliterate").join("lu_abliterate.py");
    let mut candidates = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join(&rel));
    }
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        candidates.push(PathBuf::from(manifest).join(&rel));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join(&rel));
        candidates.push(cwd.join(&rel));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// `lu-llama-quantize`, shipped next to the engine on macOS. Where it is
/// missing the copy is written by the converter itself, as Q8_0.
fn quantize_binary(app: &tauri::AppHandle) -> Option<PathBuf> {
    crate::commands::engine::resolve_sidecar(app, "lu-llama-quantize")
}

// ── Run state ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Best {
    pub trial: u32,
    pub refusals: u32,
    pub kl: f64,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub refusals: u32,
    pub false_alarms: u32,
    pub mmlu: u32,
    pub n: u32,
    /// MMLU questions asked; older records asked `n`.
    #[serde(default)]
    pub mmlu_n: Option<u32>,
    /// One character per MMLU question, `1` right and `0` wrong, in the
    /// same order for both runs, so a loss can be told from chance.
    #[serde(default)]
    pub mmlu_marks: Option<String>,
}

/// What a finished run leaves behind, in `runs/<id>.json`.
#[derive(Debug, Clone, Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: String,
    pub source_path: String,
    pub source_name: String,
    pub output_path: String,
    pub output_name: String,
    pub repo: String,
    pub revision: String,
    pub license: String,
    pub mode: String,
    pub trials: u32,
    pub trial: u32,
    pub kl: f64,
    /// Heretic's own count on its test set, before and after (bf16).
    pub search_refusals_before: Option<u32>,
    pub search_refusals_after: u32,
    pub search_prompts: Option<u32>,
    /// The short check on the GGUF files, original and copy.
    pub before: Option<Check>,
    pub after: Option<Check>,
    pub quant: String,
    pub quant_note: Option<String>,
    pub device: String,
    pub seconds: u64,
    pub finished_at: u64,
    #[serde(default)]
    pub discarded: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    /// idle | running | done | failed | cancelled
    pub status: String,
    pub id: String,
    pub model_name: String,
    pub source_path: String,
    pub repo: String,
    pub phase: String,
    pub phase_label: String,
    pub step: u64,
    pub total: u64,
    pub trials: u32,
    pub best: Option<Best>,
    pub base_refusals: Option<u32>,
    pub prompts: Option<u32>,
    pub started_at: u64,
    pub elapsed_secs: u64,
    pub eta_secs: Option<u64>,
    /// The step counts bytes (a download): `step` of `total` bytes.
    pub bytes: bool,
    /// Bytes per second over the last seconds of a download.
    pub rate_bps: Option<u64>,
    pub logs: VecDeque<String>,
    pub error: Option<String>,
    pub result: Option<RunRecord>,
    /// A stopped run can carry on from its checkpoint.
    pub resumable: bool,
    #[serde(skip)]
    pid: Option<u32>,
    #[serde(skip)]
    started: Option<Instant>,
    #[serde(skip)]
    search_started: Option<(Instant, u32)>,
    #[serde(skip)]
    meter: ByteMeter,
    /// pip is on a file large enough to show (see `pip_line`).
    #[serde(skip)]
    pip_big: bool,
}

/// Speed and time left of a download from its last few seconds.
#[derive(Debug, Clone, Default)]
struct ByteMeter {
    samples: VecDeque<(Instant, u64)>,
}

impl ByteMeter {
    const WINDOW: Duration = Duration::from_secs(10);

    /// Below this a download has not really begun: the hub sends the small
    /// files first, after a pause. Measured from there, the Mac showed
    /// "4 kB/s · about 66 h left" for the weights (28.10.2026).
    const STARTED: u64 = 1_000_000;

    /// Take a reading; `(bytes per second, seconds left)` once there are
    /// a little over one second of readings. A count that goes back (a new
    /// file) starts over.
    fn sample(&mut self, at: Instant, done: u64, total: u64) -> (Option<u64>, Option<u64>) {
        if self.samples.back().is_some_and(|&(_, d)| done < d) || done < Self::STARTED.min(total) {
            self.samples.clear();
        }
        if done < Self::STARTED.min(total) {
            return (None, None);
        }
        self.samples.push_back((at, done));
        while self.samples.len() > 2 && self.samples.front().is_some_and(|&(t, _)| at.duration_since(t) > Self::WINDOW) {
            self.samples.pop_front();
        }
        let &(t0, d0) = self.samples.front().expect("just pushed");
        let secs = at.duration_since(t0).as_secs_f64();
        if secs < 1.2 {
            return (None, None);
        }
        let rate = (done - d0) as f64 / secs;
        if rate < 1.0 {
            return (Some(0), None);
        }
        let left = (total > done).then(|| ((total - done) as f64 / rate).ceil() as u64);
        (Some(rate as u64), left.or(Some(0)).filter(|_| total > 0))
    }
}

/// A download's progress: bytes done of total, with speed and time left.
fn set_bytes(r: &mut RunState, done: u64, total: u64) {
    if !r.bytes {
        r.meter = ByteMeter::default();
    }
    r.bytes = true;
    r.step = done;
    r.total = total;
    let (rate, left) = r.meter.sample(Instant::now(), done, total);
    r.rate_bps = rate;
    r.eta_secs = left;
}

/// Back to a step without a byte count (the bar shows no share).
fn clear_bytes(r: &mut RunState) {
    r.bytes = false;
    r.rate_bps = None;
    r.eta_secs = None;
    r.step = 0;
    r.total = 0;
    r.meter = ByteMeter::default();
}

static RUN: LazyLock<Mutex<RunState>> = LazyLock::new(|| Mutex::new(RunState { status: "idle".into(), ..Default::default() }));
static CANCEL: LazyLock<Arc<AtomicBool>> = LazyLock::new(|| Arc::new(AtomicBool::new(false)));

fn with_run<T>(f: impl FnOnce(&mut RunState) -> T) -> T {
    let mut guard = RUN.lock().unwrap_or_else(|p| p.into_inner());
    f(&mut guard)
}

fn log(line: impl Into<String>) {
    let line = line.into();
    let line = line.trim_end();
    if line.is_empty() {
        return;
    }
    tracing::info!(target: "abliterate", "{line}");
    with_run(|r| {
        r.logs.push_back(line.to_string());
        while r.logs.len() > LOG_LINES {
            r.logs.pop_front();
        }
    });
}

fn set_phase(phase: &str, label: &str) {
    log(format!("· {label}"));
    with_run(|r| {
        r.phase = phase.to_string();
        r.phase_label = label.to_string();
        clear_bytes(r);
        r.pip_big = false;
    });
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn cancelled() -> bool {
    CANCEL.load(Ordering::SeqCst)
}

const CANCELLED: &str = "cancelled";

// ── Hugging Face ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
struct HubInfo {
    sha: String,
    gated: bool,
    private: bool,
    license: Option<String>,
    license_name: Option<String>,
    params: Option<u64>,
    download_bytes: u64,
    safetensors_files: usize,
    model_type: Option<String>,
}

fn hub_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(crate::app_identity::outgoing_agent_for(crate::app_identity::APP_VERSION))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client: {}", os_error::english(&e)))
}

fn hub_info(repo: &str) -> Result<HubInfo, String> {
    let url = format!("https://huggingface.co/api/models/{repo}?blobs=true");
    let mut req = hub_client()?.get(&url);
    if let Some(token) = crate::commands::mlx::hf_token() {
        req = req.bearer_auth(token);
    }
    let resp = req.send().map_err(|e| format!("Hugging Face could not be reached: {}", os_error::english(&e)))?;
    match resp.status().as_u16() {
        200 => {}
        401 | 403 => {
            return Err(format!(
                "{repo} needs a Hugging Face account with access. Accept the model's terms on its page, add your token under Settings, then try again."
            ))
        }
        404 => return Err(format!("LU found no model named {repo} on Hugging Face.")),
        s => return Err(format!("Hugging Face answered {s} for {repo}.")),
    }
    let v: Value = resp.json().map_err(|e| format!("Hugging Face sent something LU could not read: {e}"))?;
    Ok(parse_hub_info(&v))
}

fn parse_hub_info(v: &Value) -> HubInfo {
    let card = v.get("cardData");
    let license = card
        .and_then(|c| c.get("license"))
        .and_then(|l| l.as_str().map(str::to_string).or_else(|| l.as_array().and_then(|a| a.first()).and_then(|x| x.as_str()).map(str::to_string)))
        .or_else(|| {
            v.get("tags")?.as_array()?.iter().filter_map(|t| t.as_str()).find_map(|t| t.strip_prefix("license:").map(str::to_string))
        });
    let siblings = v.get("siblings").and_then(|s| s.as_array()).cloned().unwrap_or_default();
    let weights: Vec<&Value> = siblings
        .iter()
        .filter(|s| s.get("rfilename").and_then(|f| f.as_str()).is_some_and(|f| f.ends_with(".safetensors") && !f.contains('/')))
        .collect();
    HubInfo {
        sha: v.get("sha").and_then(|s| s.as_str()).unwrap_or_default().to_string(),
        gated: v.get("gated").is_some_and(|g| g.as_bool() != Some(false) && !g.is_null()),
        private: v.get("private").and_then(|p| p.as_bool()).unwrap_or(false),
        license,
        license_name: card.and_then(|c| c.get("license_name")).and_then(|l| l.as_str()).map(str::to_string),
        params: v.get("safetensors").and_then(|s| s.get("total")).and_then(|t| t.as_u64()),
        download_bytes: weights.iter().filter_map(|s| s.get("size").and_then(|x| x.as_u64())).sum(),
        safetensors_files: weights.len(),
        model_type: v.get("config").and_then(|c| c.get("model_type")).and_then(|m| m.as_str()).map(str::to_string),
    }
}

// ── Devices ───────────────────────────────────────────────────────────────

fn os_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

fn total_ram() -> Option<u64> {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    Some(sys.total_memory()).filter(|m| *m > 0)
}

fn nvidia_capabilities() -> Vec<(u32, u32)> {
    let out = crate::process_util::foreign_system_command("nvidia-smi")
        .args(["--query-gpu=compute_cap", "--format=csv,noheader"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    let Ok(out) = out else { return Vec::new() };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let (a, b) = l.trim().split_once('.')?;
            Some((a.parse().ok()?, b.parse().ok()?))
        })
        .collect()
}

fn detect_devices() -> Vec<DeviceOption> {
    let os = os_name();
    let mut out = Vec::new();
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        let (supported, note) = plan::device_support(DeviceKind::Apple, os);
        out.push(DeviceOption {
            id: "apple".into(),
            kind: DeviceKind::Apple,
            name: "Apple Silicon (this Mac)".into(),
            memory_bytes: total_ram(),
            capability: None,
            supported,
            note,
        });
        return out;
    }
    let gpus = crate::commands::gpu::detect_gpus().unwrap_or_default();
    let caps = nvidia_capabilities();
    for g in gpus {
        let kind = match g.vendor.as_str() {
            "nvidia" => DeviceKind::Nvidia,
            "amd" => DeviceKind::Amd,
            _ => continue,
        };
        let (supported, note) = plan::device_support(kind, os);
        out.push(DeviceOption {
            id: format!("{}:{}", g.vendor, g.index),
            kind,
            name: g.name.clone(),
            memory_bytes: g.memory_mib.map(|m| m * 1024 * 1024),
            capability: if kind == DeviceKind::Nvidia { caps.get(g.index as usize).copied() } else { None },
            supported,
            note,
        });
    }
    out
}

/// The PyTorch install for a device: `(pip args, a label for the marker)`.
fn torch_install(device: &DeviceOption) -> Result<(Vec<String>, String), String> {
    use crate::commands::torch_wheels as tw;
    match device.kind {
        DeviceKind::Apple => Ok((vec![TORCH_MAC.into()], TORCH_MAC.into())),
        DeviceKind::Nvidia => {
            let channels: &[&str] = match device.capability {
                Some((major, _)) if major >= 12 => tw::CUDA_BLACKWELL_CHANNELS,
                Some(cap) if cap >= tw::CU130_MIN_CAP => tw::CUDA_MODERN_CHANNELS,
                Some(_) => tw::CUDA_LEGACY_CHANNELS,
                None => tw::CUDA_MODERN_CHANNELS,
            };
            let index = tw::first_live_index(channels, tw::index_serves_torch).ok_or("no PyTorch channel")?;
            Ok((vec!["torch".into(), "--index-url".into(), index.into()], format!("torch@{index}")))
        }
        DeviceKind::Amd => {
            let index = tw::first_live_index(tw::ROCM_CHANNELS, tw::index_serves_torch).ok_or("no PyTorch channel")?;
            Ok((vec!["torch".into(), "--index-url".into(), index.into()], format!("torch@{index}")))
        }
    }
}

fn env_wanted(torch_label: &str) -> String {
    let mut h = Sha256::new();
    h.update(REQUIREMENTS.as_bytes());
    h.update(CONSTRAINTS.as_bytes());
    format!("{ENV_VERSION}\n{torch_label}\n{:x}\n", h.finalize())
}

fn env_ready_for(device: &DeviceOption) -> bool {
    let Ok(have) = std::fs::read_to_string(env_marker()) else { return false };
    let label = match device.kind {
        DeviceKind::Apple => TORCH_MAC.to_string(),
        // The channel is only known after a probe; any CUDA or ROCm torch of
        // the same environment version counts as ready for the estimate.
        _ => return have.starts_with(ENV_VERSION) && venv_python().is_file(),
    };
    have == env_wanted(&label) && venv_python().is_file()
}

// ── Plan ──────────────────────────────────────────────────────────────────

fn file_stem(path: &Path) -> String {
    path.file_stem().and_then(|s| s.to_str()).unwrap_or("model").to_string()
}

fn plan_blocking(path: &str, repo_override: Option<String>) -> Result<Value, String> {
    let file = PathBuf::from(path);
    if !file.is_file() || !file.extension().is_some_and(|e| e.eq_ignore_ascii_case("gguf")) {
        return Err("That model file could not be found.".into());
    }
    let facts = crate::commands::gguf::read_general(path);
    let stem = file_stem(&file);
    let name = facts.get("general.name").unwrap_or(&stem).to_string();
    let quant = plan::output_quant(facts.file_type);
    let model = json!({
        "name": name,
        "path": path,
        "size": std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0),
        "quant": quant,
    });
    if plan::made_by_lu(&facts) {
        return Ok(json!({ "model": model, "alreadyDone": true }));
    }
    let guess = match repo_override.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(typed) => Some(plan::SourceGuess {
            repo: plan::valid_repo_id(typed).ok_or("That is not a Hugging Face repo name. It looks like Org/Model.")?,
            from: "typed",
        }),
        None => plan::guess_source(&facts, &stem),
    };
    let Some(guess) = guess else {
        return Ok(json!({ "model": model, "source": null }));
    };
    if plan::is_gguf_repo(&guess.repo) {
        return Err(format!(
            "{} holds GGUF files. The tool needs the original weights (safetensors), usually the repo without -GGUF at the end.",
            guess.repo
        ));
    }
    let hub = hub_info(&guess.repo)?;
    if hub.safetensors_files == 0 {
        return Err(format!("{} has no safetensors weights at the top level, so there is nothing to work on.", guess.repo));
    }
    let Some(params) = hub.params else {
        return Err(format!("Hugging Face does not say how large {} is, so LU cannot plan the run.", guess.repo));
    };
    let license = plan::license_verdict(hub.license.as_deref(), hub.license_name.as_deref(), &guess.repo);
    let free = crate::commands::download::available_space_for(&existing_ancestor(&root()));
    let devices: Vec<Value> = detect_devices()
        .into_iter()
        .map(|d| {
            let e = plan::estimate(&plan::EstimateInput {
                params,
                download_bytes: hub.download_bytes,
                device: &d,
                trials: 200,
                output_quant: quant,
                disk_free: free,
                env_missing: !env_ready_for(&d),
            });
            let e100 = plan::estimate(&plan::EstimateInput {
                params,
                download_bytes: hub.download_bytes,
                device: &d,
                trials: 100,
                output_quant: quant,
                disk_free: free,
                env_missing: !env_ready_for(&d),
            });
            json!({ "device": d, "estimate": e, "estimate100": { "minutesLow": e100.minutes_low, "minutesHigh": e100.minutes_high } })
        })
        .collect();
    Ok(json!({
        "model": model,
        "source": {
            "repo": guess.repo,
            "from": guess.from,
            "revision": hub.sha,
            "gated": hub.gated,
            "private": hub.private,
            "params": params,
            "downloadBytes": hub.download_bytes,
            "modelType": hub.model_type,
            "tokenSaved": crate::commands::mlx::hf_token().is_some(),
        },
        "license": license,
        "devices": devices,
        "quantizeTool": true,
        "heretic": HERETIC_VERSION,
        "cloud": {
            "available": false,
            "allowed": license.cloud_allowed,
            "note": "A run in LU Cloud for larger models is planned, not built yet.",
        },
    }))
}

fn existing_ancestor(p: &Path) -> PathBuf {
    p.ancestors().find(|a| a.exists()).map(Path::to_path_buf).unwrap_or_else(|| p.to_path_buf())
}

#[tauri::command]
pub async fn abliterate_plan(app: tauri::AppHandle, path: String, repo: Option<String>) -> Result<Value, String> {
    let _ = &app;
    tokio::task::spawn_blocking(move || plan_blocking(&path, repo))
        .await
        .map_err(|e| format!("plan task: {e}"))?
        .map(|mut v| {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("quantizeTool".into(), json!(quantize_binary(&app).is_some()));
            }
            v
        })
}

// ── Start ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    pub path: String,
    pub repo: String,
    pub revision: String,
    pub device: String,
    pub trials: u32,
    pub mode: String,
    #[serde(default)]
    pub accept_license: bool,
    #[serde(default)]
    pub adult: bool,
}

struct Job {
    id: String,
    work: PathBuf,
    source: PathBuf,
    source_name: String,
    repo: String,
    revision: String,
    license_label: String,
    device: DeviceOption,
    estimate: plan::Estimate,
    trials: u32,
    mode: String,
    kl_max: f64,
    quant: &'static str,
    script: PathBuf,
    quantize: Option<PathBuf>,
}

fn slug(s: &str) -> String {
    let s: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' { c } else { '-' }).collect();
    s.trim_matches('-').chars().take(60).collect()
}

/// The work folder of a run: the same model, commit and settings land in the
/// same folder, which is how a stopped run picks up its download and its
/// Heretic checkpoint again.
fn work_key(repo: &str, revision: &str, trials: u32, mode: &str, device: &DeviceKind, q: Quantization) -> String {
    let mut h = Sha256::new();
    h.update(format!("{repo}@{revision}|{trials}|{mode}|{device:?}|{q:?}").as_bytes());
    let hex = format!("{:x}", h.finalize());
    format!("{}-{}", slug(repo), &hex[..10])
}

fn start_blocking(app: &tauri::AppHandle, args: StartArgs) -> Result<Value, String> {
    if with_run(|r| r.status == "running") {
        return Err("A refusal removal is already running.".into());
    }
    if !args.adult {
        return Err("This tool is for adults only. Confirm that you are 18 or older.".into());
    }
    let repo = plan::valid_repo_id(&args.repo).ok_or("That is not a Hugging Face repo name.")?;
    if args.revision.len() != 40 || !args.revision.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("The model's commit is missing. Open the dialog again.".into());
    }
    let kl_max = plan::kl_limit(&args.mode).ok_or("Unknown mode.")?;
    if !plan::valid_trials(args.trials) {
        return Err("Unknown number of trials.".into());
    }
    let source = PathBuf::from(&args.path);
    if !source.is_file() {
        return Err("That model file could not be found.".into());
    }
    let facts = crate::commands::gguf::read_general(&args.path);
    if plan::made_by_lu(&facts) {
        return Err("This model already had its refusals removed by LU.".into());
    }
    // Everything the dialog showed is asked again here: the client only
    // names its choice.
    let hub = hub_info(&repo)?;
    if hub.sha != args.revision {
        return Err(format!("{repo} changed on Hugging Face since the dialog opened. Open it again to see the new numbers."));
    }
    let params = hub.params.ok_or("Hugging Face does not say how large the model is.")?;
    let license = plan::license_verdict(hub.license.as_deref(), hub.license_name.as_deref(), &repo);
    if license.kind == LicenseKind::Notice && !args.accept_license {
        return Err("Read the license note and confirm it first.".into());
    }
    let device = detect_devices().into_iter().find(|d| d.id == args.device).ok_or("That device is not available.")?;
    let quant = plan::output_quant(facts.file_type);
    let estimate = plan::estimate(&plan::EstimateInput {
        params,
        download_bytes: hub.download_bytes,
        device: &device,
        trials: args.trials,
        output_quant: quant,
        disk_free: crate::commands::download::available_space_for(&existing_ancestor(&root())),
        env_missing: !env_ready_for(&device),
    });
    if !estimate.fits {
        return Err(estimate.why_not.unwrap_or_else(|| "This run does not fit on this machine.".into()));
    }
    let script = script_path(app).ok_or("The refusal-removal script is missing. Reinstall LU to restore it.")?;
    if crate::private_python::version_here().is_none() {
        return Err("LU has no Python of its own for this system, which the tool needs.".into());
    }

    let key = work_key(&repo, &hub.sha, args.trials, &args.mode, &device.kind, estimate.quantization);
    let work = root().join("work").join(&key);
    std::fs::create_dir_all(&work).map_err(|e| format!("Could not create the work folder: {}", os_error::english(&e)))?;
    let source_name = facts.get("general.name").map(str::to_string).unwrap_or_else(|| file_stem(&source));
    let id = format!("{}-{}", now_ms(), slug(&file_stem(&source)));
    let job = Job {
        id: id.clone(),
        work,
        source,
        source_name: source_name.clone(),
        repo: repo.clone(),
        revision: hub.sha.clone(),
        license_label: license.label.clone(),
        device,
        estimate,
        trials: args.trials,
        mode: args.mode.clone(),
        kl_max,
        quant,
        script,
        quantize: quantize_binary(app),
    };
    CANCEL.store(false, Ordering::SeqCst);
    with_run(|r| {
        *r = RunState {
            status: "running".into(),
            id,
            model_name: source_name,
            source_path: args.path.clone(),
            repo,
            trials: args.trials,
            started_at: now_ms(),
            started: Some(Instant::now()),
            ..Default::default()
        };
    });
    let app = app.clone();
    std::thread::Builder::new()
        .name("abliterate".into())
        .spawn(move || {
            let started = Instant::now();
            let outcome = run_job(&app, &job);
            with_run(|r| {
                r.pid = None;
                r.elapsed_secs = started.elapsed().as_secs();
                r.eta_secs = None;
                match outcome {
                    Ok(record) => {
                        r.status = "done".into();
                        r.phase = "done".into();
                        r.phase_label = "Done".into();
                        r.result = Some(record);
                    }
                    Err(e) if e == CANCELLED || cancelled() => {
                        r.status = "cancelled".into();
                        r.phase_label = "Stopped".into();
                        r.resumable = true;
                    }
                    Err(e) => {
                        r.status = "failed".into();
                        r.error = Some(e);
                        r.resumable = true;
                    }
                }
            });
        })
        .map_err(|e| format!("Could not start the run: {e}"))?;
    Ok(status_value())
}

#[tauri::command]
pub async fn abliterate_start(app: tauri::AppHandle, args: StartArgs) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || start_blocking(&app, args)).await.map_err(|e| format!("start task: {e}"))?
}

fn status_value() -> Value {
    with_run(|r| {
        if r.status == "running" {
            if let Some(s) = r.started {
                r.elapsed_secs = s.elapsed().as_secs();
            }
        }
        serde_json::to_value(&*r).unwrap_or(Value::Null)
    })
}

#[tauri::command]
pub fn abliterate_status() -> Value {
    status_value()
}

#[tauri::command]
pub async fn abliterate_cancel() -> Result<Value, String> {
    tokio::task::spawn_blocking(|| {
        CANCEL.store(true, Ordering::SeqCst);
        if let Some(pid) = with_run(|r| r.pid) {
            crate::commands::shell::kill_tree(pid);
        }
        status_value()
    })
    .await
    .map_err(|e| format!("cancel task: {e}"))
}

/// Back to idle after the result or the error has been read.
#[tauri::command]
pub fn abliterate_dismiss() -> Value {
    with_run(|r| {
        if r.status != "running" {
            *r = RunState { status: "idle".into(), ..Default::default() };
        }
    });
    status_value()
}

/// Every finished run, newest first.
#[tauri::command]
pub fn abliterate_runs() -> Value {
    json!(read_records())
}

fn read_records() -> Vec<RunRecord> {
    let mut out: Vec<RunRecord> = std::fs::read_dir(runs_dir())
        .map(|it| {
            it.flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
                .filter_map(|e| serde_json::from_str(&std::fs::read_to_string(e.path()).ok()?).ok())
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|r| std::cmp::Reverse(r.finished_at));
    out
}

/// "Delete copy" on the result card: the copy goes to the trash, nothing
/// else. Only a file a run of this tool wrote can go this way.
#[tauri::command]
pub async fn abliterate_trash_copy(path: String) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let mut records = read_records();
        let rec = records
            .iter_mut()
            .find(|r| r.output_path == path && !r.discarded)
            .ok_or("Only a copy this tool made can be removed here.")?;
        if Path::new(&path).exists() {
            crate::commands::os_trash::system_trash(Path::new(&path)).map_err(|e| format!("Could not move the copy to the trash: {e}"))?;
        }
        rec.discarded = true;
        write_record(rec)?;
        with_run(|r| {
            if let Some(res) = r.result.as_mut() {
                if res.output_path == path {
                    res.discarded = true;
                }
            }
        });
        Ok(json!({ "trashed": true }))
    })
    .await
    .map_err(|e| format!("trash task: {e}"))?
}

fn write_record(rec: &RunRecord) -> Result<(), String> {
    std::fs::create_dir_all(runs_dir()).map_err(|e| format!("Could not save the result: {}", os_error::english(&e)))?;
    let text = serde_json::to_string_pretty(rec).map_err(|e| e.to_string())?;
    std::fs::write(runs_dir().join(format!("{}.json", rec.id)), text)
        .map_err(|e| format!("Could not save the result: {}", os_error::english(&e)))
}

// ── The run ───────────────────────────────────────────────────────────────

fn run_job(app: &tauri::AppHandle, job: &Job) -> Result<RunRecord, String> {
    let started = Instant::now();
    log(format!(
        "{} from {} @ {}, {} trials, {} (KL up to {}), {} on {}",
        job.source_name,
        job.repo,
        &job.revision[..12],
        job.trials,
        job.mode,
        job.kl_max,
        match job.estimate.quantization {
            Quantization::None => "16 bit",
            Quantization::Bnb4bit => "4 bit",
        },
        job.device.name
    ));

    set_phase("setup", "Preparing the tools");
    let py = ensure_env(job)?;
    ensure_converter()?;
    check_cancel()?;

    // The chat model holds memory the run needs, and both would compete for
    // the same card.
    let state = app.state::<AppState>();
    if crate::commands::engine::stop_engine_on_request(&state) {
        log("The chat model was unloaded to make room. Load it again when the run is done.");
    }

    // 1. the original weights
    let source_dir = job.work.join("source");
    set_phase("download", "Downloading the original weights");
    with_run(|r| set_bytes(r, 0, job.estimate.download_bytes));
    {
        let dir = source_dir.clone();
        let mut cmd = python(&py, job);
        cmd.arg(&job.script)
            .args(["download", "--repo", &job.repo, "--revision", &job.revision, "--dest"])
            .arg(&source_dir);
        let watcher = watch_size(dir);
        // The bytes the hub reports; the folder size alone stays at zero
        // while Xet holds a file in memory.
        let result = run_python(cmd, "download", |ev| {
            if ev.get("event").and_then(|e| e.as_str()) == Some("bytes") {
                let done = ev.get("done").and_then(|v| v.as_u64()).unwrap_or(0);
                with_run(|r| {
                    let (done, total) = (r.step.max(done), r.total);
                    set_bytes(r, done, total)
                });
            }
        });
        watcher.store(false, Ordering::SeqCst);
        result?;
        with_run(|r| {
            let total = r.total;
            set_bytes(r, total, total)
        });
    }
    check_cancel()?;

    // 2. the original, checked
    let before_json = job.work.join("check-before.json");
    // A check from an older LU asked fewer MMLU questions and would not
    // compare with the copy's.
    if !check_is_current(read_json::<Check>(&before_json).as_ref()) {
        set_phase("check_before", "Checking the original");
        check_gguf(app, &py, job, &job.source, &before_json, "original")?;
    }
    let before: Option<Check> = read_json(&before_json);
    check_cancel()?;

    // 3. the search
    set_phase("search", "Finding the refusal direction");
    let mut picked: Option<Picked> = None;
    {
        let mut cmd = python(&py, job);
        cmd.arg(&job.script)
            .args(["search", "--model"])
            .arg(&source_dir)
            .arg("--work")
            .arg(&job.work)
            .args(["--trials", &job.trials.to_string(), "--kl-max", &job.kl_max.to_string()])
            .args(["--quantization", if job.estimate.quantization == Quantization::Bnb4bit { "bnb_4bit" } else { "none" }])
            .args(["--max-batch-size", &job.estimate.max_batch_size.to_string()]);
        let _ = std::fs::remove_dir_all(job.work.join("adapter"));
        run_python(cmd, "search", |ev| on_search_event(ev, job, &mut picked))?;
    }
    let (trial, refusals_after, kl, base_refusals, prompts) =
        picked.ok_or("Heretic finished without picking a result.")?;
    check_cancel()?;

    // 4. merge
    let merged = job.work.join("merged");
    set_phase("merge", "Applying the change to the weights");
    let _ = std::fs::remove_dir_all(&merged);
    let mut cmd = python(&py, job);
    cmd.arg(&job.script).args(["merge", "--base"]).arg(&source_dir).arg("--adapter").arg(job.work.join("adapter")).arg("--out").arg(&merged);
    match run_python(cmd, "merge", |ev| {
        if ev.get("event").and_then(|e| e.as_str()) == Some("merge") {
            let shard = ev.get("shard").and_then(|v| v.as_u64()).unwrap_or(0);
            let shards = ev.get("shards").and_then(|v| v.as_u64()).unwrap_or(0);
            with_run(|r| {
                r.step = shard;
                r.total = shards;
            });
        }
    }) {
        Ok(()) => {}
        Err(e) if e.contains("exit code 3") => {
            // The adapter names a module the checkpoint does not have under
            // that name. Heretic's own merge knows the model class; it costs
            // memory, which is why it is only the fallback.
            log("Merging shard by shard did not fit this model, using Heretic's own merge.");
            let _ = std::fs::remove_dir_all(&merged);
            let mut cmd = python(&py, job);
            cmd.arg(&job.script)
                .args(["search", "--model"])
                .arg(&source_dir)
                .arg("--work")
                .arg(&job.work)
                .args(["--trials", &job.trials.to_string(), "--kl-max", &job.kl_max.to_string(), "--export", "merge"])
                .args(["--quantization", if job.estimate.quantization == Quantization::Bnb4bit { "bnb_4bit" } else { "none" }]);
            run_python(cmd, "merge", |_| {})?;
        }
        Err(e) => return Err(e),
    }
    check_cancel()?;

    // 5. convert and quantize
    let models_dir = crate::commands::engine::builtin_models_dir()?;
    let stem = unique_stem(&models_dir, &plan::output_stem(&file_stem(&job.source), job.quant));
    let output = models_dir.join(format!("{stem}.gguf"));
    let partial = models_dir.join(format!("{stem}.gguf.part"));
    let display = plan::display_name(Some(&job.source_name), &stem);
    let meta = job.work.join("metadata.json");
    std::fs::write(
        &meta,
        serde_json::to_string_pretty(&json!({
            "general.name": display,
            "general.description": format!(
                "{} from {} at {} with Heretic {} (trial {}, KL {:.3}, mode {}, {} trials).",
                plan::DESCRIPTION_MARK, job.repo, job.revision, HERETIC_VERSION, trial, kl, job.mode, job.trials
            ),
            "general.source.repo_url": format!("https://huggingface.co/{}", job.repo),
        }))
        .unwrap_or_default(),
    )
    .map_err(|e| format!("Could not write the model's metadata: {}", os_error::english(&e)))?;

    let (convert_type, quantize_to, quant_note) = match (plan::convert_writes(job.quant), &job.quantize) {
        (Some(t), _) => (t, None, None),
        (None, Some(_)) => ("bf16", Some(job.quant), None),
        (None, None) => (
            "q8_0",
            None,
            Some(format!("Saved as Q8_0: this build of LU has no {} quantizer.", job.quant)),
        ),
    };
    let converted = if quantize_to.is_some() { job.work.join("converted-bf16.gguf") } else { partial.clone() };
    set_phase("convert", "Converting to GGUF");
    let mut cmd = crate::python::python_command(&py);
    cmd.env_remove("PYTHONHOME").env_remove("PYTHONPATH").args(["-s", "-E", "-X", "utf8"]);
    cmd.arg(convert_dir().join("convert_hf_to_gguf.py"))
        .arg(&merged)
        .args(["--outtype", convert_type, "--outfile"])
        .arg(&converted)
        .arg("--metadata")
        .arg(&meta);
    run_python(cmd, "convert", |_| {})?;
    check_cancel()?;
    if let (Some(q), Some(bin)) = (quantize_to, &job.quantize) {
        set_phase("quantize", &format!("Quantizing to {q}"));
        let mut cmd = Command::new(bin);
        cmd.arg(&converted).arg(&partial).arg(q);
        run_python(cmd, "quantize", |_| {})?;
        let _ = std::fs::remove_file(&converted);
    }
    std::fs::rename(&partial, &output).map_err(|e| format!("Could not put the copy in place: {}", os_error::english(&e)))?;
    log(format!("Saved as {}", output.display()));

    // 6. the copy, checked
    let after_json = job.work.join("check-after.json");
    set_phase("check_after", "Checking the copy");
    check_gguf(app, &py, job, &output, &after_json, "copy")?;
    let after: Option<Check> = read_json(&after_json);

    // 7. tidy up: only what this run wrote, the original stays untouched.
    set_phase("finish", "Cleaning up");
    for dir in ["source", "merged", "adapter"] {
        let _ = std::fs::remove_dir_all(job.work.join(dir));
    }
    let _ = std::fs::remove_file(job.work.join("converted-bf16.gguf"));

    let record = RunRecord {
        id: job.id.clone(),
        source_path: job.source.to_string_lossy().into_owned(),
        source_name: job.source_name.clone(),
        output_path: output.to_string_lossy().into_owned(),
        output_name: display,
        repo: job.repo.clone(),
        revision: job.revision.clone(),
        license: job.license_label.clone(),
        mode: job.mode.clone(),
        trials: job.trials,
        trial,
        kl,
        search_refusals_before: base_refusals,
        search_refusals_after: refusals_after,
        search_prompts: prompts,
        before,
        after,
        quant: if quantize_to.is_some() { job.quant.to_string() } else { convert_type.to_ascii_uppercase() },
        quant_note,
        device: job.device.name.clone(),
        seconds: started.elapsed().as_secs(),
        finished_at: now_ms(),
        discarded: false,
    };
    write_record(&record)?;
    Ok(record)
}

/// A saved check of the original counts only when it asked the questions
/// the copy will be asked, with each answer kept.
fn check_is_current(c: Option<&Check>) -> bool {
    c.is_some_and(|c| c.mmlu_n == Some(MMLU_N) && c.mmlu_marks.as_ref().is_some_and(|m| m.len() == MMLU_N as usize))
}

fn check_cancel() -> Result<(), String> {
    if cancelled() { Err(CANCELLED.into()) } else { Ok(()) }
}

fn read_json<T: serde::de::DeserializeOwned>(p: &Path) -> Option<T> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

fn unique_stem(dir: &Path, stem: &str) -> String {
    if !dir.join(format!("{stem}.gguf")).exists() {
        return stem.to_string();
    }
    (2..100).map(|n| format!("{stem}-{n}")).find(|s| !dir.join(format!("{s}.gguf")).exists()).unwrap_or_else(|| format!("{stem}-{}", now_ms()))
}

/// The trial the rule took: (trial, refusals, KL, refusals of the original,
/// test prompts), as Heretic counted them.
type Picked = (u32, u32, f64, Option<u32>, Option<u32>);

fn on_search_event(ev: &Value, job: &Job, picked: &mut Option<Picked>) {
    let u = |k: &str| ev.get(k).and_then(|v| v.as_u64()).map(|v| v as u32);
    match ev.get("event").and_then(|e| e.as_str()) {
        Some("phase") => match ev.get("phase").and_then(|p| p.as_str()) {
            Some("load") => set_phase("search", "Loading the model"),
            Some("batch") => set_phase("search", "Measuring how much fits at once"),
            Some("directions") => set_phase("search", "Finding the refusal direction"),
            Some("resume") => log("Carrying on from where the last run stopped."),
            Some("export") => set_phase("export", "Saving the change"),
            _ => {}
        },
        Some("trial") => {
            let index = u("index").unwrap_or(0);
            let best = ev.get("best").and_then(|b| {
                Some(Best {
                    trial: b.get("trial")?.as_u64()? as u32,
                    refusals: b.get("refusals")?.as_u64()? as u32,
                    kl: b.get("kl")?.as_f64()?,
                })
            });
            with_run(|r| {
                if r.phase != "trials" {
                    r.phase = "trials".into();
                    r.search_started = Some((Instant::now(), index.saturating_sub(1)));
                }
                r.phase_label = format!("Trial {index} of {}", job.trials);
                r.step = index as u64;
                r.total = job.trials as u64;
                r.best = best;
                r.base_refusals = u("base_refusals");
                r.prompts = u("prompts");
                if let Some((t0, first)) = r.search_started {
                    let done = index.saturating_sub(first).max(1) as f64;
                    let per = t0.elapsed().as_secs_f64() / done;
                    let left = job.trials.saturating_sub(index) as f64;
                    // The trials, then conversion and the check of the copy.
                    r.eta_secs = Some((per * left + 120.0) as u64);
                }
            });
        }
        Some("picked") => {
            let rec = (
                u("trial").unwrap_or(0),
                u("refusals").unwrap_or(0),
                ev.get("kl").and_then(|v| v.as_f64()).unwrap_or(0.0),
                u("base_refusals"),
                u("prompts"),
            );
            log(format!("Picked trial {} ({} refusals, KL {:.3}).", rec.0, rec.1, rec.2));
            if ev.get("within_limit").and_then(|v| v.as_bool()) == Some(false) {
                log("No trial stayed under the KL limit of this mode, so the gentlest one was taken.");
            }
            *picked = Some(rec);
        }
        _ => {}
    }
}

/// The venv's Python with the environment every step shares.
fn python(py: &Path, job: &Job) -> Command {
    let mut cmd = crate::python::python_command(py);
    // -I ignores every PYTHON* variable, PYTHONUTF8 and PYTHONIOENCODING
    // included, so UTF-8 goes on the command line (a Windows pipe is cp1252
    // otherwise) and -u stands in for PYTHONUNBUFFERED.
    cmd.env_remove("PYTHONHOME").env_remove("PYTHONPATH").args(["-I", "-X", "utf8", "-u"]);
    cmd.env("PYTHONUNBUFFERED", "1")
        .env("TOKENIZERS_PARALLELISM", "false")
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("HF_HUB_DISABLE_PROGRESS_BARS", "1")

        .env("HF_HOME", root().join("hf"))
        .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        .current_dir(&job.work);
    match crate::commands::mlx::hf_token() {
        Some(token) => cmd.env("HF_TOKEN", token),
        None => cmd.env_remove("HF_TOKEN"),
    };
    if let Some((_, index)) = job.device.id.split_once(':') {
        match job.device.kind {
            DeviceKind::Nvidia => {
                cmd.env("CUDA_VISIBLE_DEVICES", index);
            }
            DeviceKind::Amd => {
                cmd.env("HIP_VISIBLE_DEVICES", index);
            }
            DeviceKind::Apple => {}
        }
    }
    cmd
}

/// Run a step, feed its "@lu" events to `on_event`, keep the rest as log.
fn run_python(mut cmd: Command, label: &str, mut on_event: impl FnMut(&Value)) -> Result<(), String> {
    cmd.stdin(Stdio::null());
    let mut child = crate::process_util::spawn_piped(cmd).map_err(|e| format!("{label} could not start: {}", os_error::english(&e)))?;
    with_run(|r| r.pid = Some(child.id()));
    let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    let stderr = child.stderr.take();
    let tail_err = tail.clone();
    let err_thread = std::thread::spawn(move || {
        if let Some(s) = stderr {
            crate::commands::trainer::for_each_progress_line(s, |line| keep_line(&tail_err, line));
        }
    });
    if let Some(stdout) = child.stdout.take() {
        crate::commands::trainer::for_each_progress_line(stdout, |line| {
            if let Some(rest) = line.strip_prefix("@lu ") {
                if let Ok(ev) = serde_json::from_str::<Value>(rest) {
                    on_event(&ev);
                }
            } else {
                keep_line(&tail, line);
            }
        });
    }
    let status = child.wait().map_err(|e| format!("{label}: {}", os_error::english(&e)))?;
    let _ = err_thread.join();
    with_run(|r| r.pid = None);
    if cancelled() {
        return Err(CANCELLED.into());
    }
    if status.success() {
        return Ok(());
    }
    let last: Vec<String> = tail.lock().map(|t| t.iter().rev().take(8).rev().cloned().collect()).unwrap_or_default();
    let text = last.join("\n");
    let code = status.code().map(|c| format!("exit code {c}")).unwrap_or_else(|| "stopped by a signal".into());
    Err(failure_message(label, &text, &code))
}

fn keep_line(tail: &Arc<Mutex<VecDeque<String>>>, line: String) {
    let line = line.trim_end().to_string();
    if line.is_empty() {
        return;
    }
    // Progress bars redraw themselves many times a second; the log keeps
    // the lines that say something.
    let bar = line.contains('█') || line.contains("it/s]") || line.contains("s/it]") || pip_progress(&line).is_some();
    if !bar {
        log(line.clone());
    }
    with_run(|r| {
        if r.phase == "setup" {
            pip_line(r, &line);
        }
    });
    if let Ok(mut t) = tail.lock() {
        t.push_back(line);
        while t.len() > 40 {
            t.pop_front();
        }
    }
}

/// pip's own words into the setup step. The CUDA build of PyTorch is 2 GB:
/// on the box the step read "Installing PyTorch" for 26 minutes with the bar
/// empty. Now a file of 20 MB or more shows its bytes, speed and time left
/// under the step's name; smaller ones pass in seconds and leave the bar as
/// it is, so it does not flicker.
fn pip_line(r: &mut RunState, line: &str) {
    let base = r.phase_label.split(": ").next().unwrap_or_default().to_string();
    if let Some((file, mb)) = pip_download(line) {
        r.pip_big = mb >= 20.0;
        if r.pip_big {
            clear_bytes(r);
            r.phase_label = format!("{base}: downloading {file}");
        }
    } else if let Some((done, total)) = pip_progress(line) {
        if r.pip_big && total > 0 {
            set_bytes(r, done, total);
        }
    } else if line.starts_with("Installing collected packages") {
        r.pip_big = false;
        clear_bytes(r);
        r.phase_label = format!("{base}: unpacking");
    }
}

/// pip's `--progress-bar raw` line: "Progress 1048576 of 1990600000".
fn pip_progress(line: &str) -> Option<(u64, u64)> {
    let (done, total) = line.trim().strip_prefix("Progress ")?.split_once(" of ")?;
    Some((done.parse().ok()?, total.parse().ok()?))
}

/// `("torch 2.14.1+cu130", 1990.6)` for pip's "Downloading <url or file>
/// (1990.6 MB)". Files without a size, or in kB, are None.
fn pip_download(line: &str) -> Option<(String, f64)> {
    let rest = line.trim_start().strip_prefix("Downloading ")?;
    let (what, inner) = rest.rsplit_once(" (")?;
    let (num, unit) = inner.strip_suffix(')')?.split_once(' ')?;
    let n: f64 = num.parse().ok()?;
    let mb = match unit {
        "MB" => n,
        "GB" => n * 1000.0,
        _ => return None,
    };
    let file = what.rsplit('/').next().unwrap_or(what).replace("%2B", "+").replace("%2b", "+");
    let mut parts = file.split('-');
    let name = match (parts.next(), parts.next()) {
        (Some(n), Some(v)) if file.ends_with(".whl") => format!("{n} {v}"),
        _ => file.clone(),
    };
    Some((name, mb))
}

/// The sentence for a failed step: a known cause in plain words, else the
/// step and the last lines it wrote.
fn failure_message(label: &str, tail: &str, code: &str) -> String {
    let low = tail.to_ascii_lowercase();
    if crate::commands::trainer::out_of_disk(tail) {
        return "The disk ran full. Free some space and start again; the run carries on where it stopped.".into();
    }
    if low.contains("out of memory") || low.contains("outofmemory") || low.contains("mps backend out of memory") {
        return "The model did not fit into memory. Close other programs, or pick Quick or a smaller model.".into();
    }
    if crate::commands::trainer::is_transient_network(tail) || low.contains("connection") && low.contains("error") {
        return "The connection broke off. Start again; what was downloaded is kept.".into();
    }
    if low.contains("gatedrepo") || low.contains("401 client error") {
        return "Hugging Face refused the download. Accept the model's terms on its page and add your token under Settings.".into();
    }
    format!("The {label} step stopped ({code}).\n{tail}")
}

/// Download progress: the size of the folder against what the hub listed.
fn watch_size(dir: PathBuf) -> Arc<AtomicBool> {
    let alive = Arc::new(AtomicBool::new(true));
    let flag = alive.clone();
    std::thread::spawn(move || {
        while flag.load(Ordering::SeqCst) {
            let size = dir_size(&dir);
            with_run(|r| {
                if r.phase == "download" && size > r.step {
                    let total = r.total;
                    set_bytes(r, size, total)
                }
            });
            std::thread::sleep(Duration::from_millis(800));
        }
    });
    alive
}

fn dir_size(p: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(p) else { return 0 };
    rd.flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

/// The short check: a llama-server of its own for `model`, then the script.
fn check_gguf(app: &tauri::AppHandle, py: &Path, job: &Job, model: &Path, out: &Path, label: &str) -> Result<(), String> {
    let port = free_port().ok_or("No free local port for the check.")?;
    let mut server = crate::commands::engine::spawn_private_server(app, &model.to_string_lossy(), port, 4096)?;
    with_run(|r| r.total = (CHECK_N * 2 + MMLU_N) as u64);
    let mut cmd = python(py, job);
    cmd.env("LU_ENGINE_BEARER", crate::commands::engine_key::bearer());
    cmd.arg(&job.script)
        .args(["measure", "--port", &port.to_string(), "--label", label, "--n", &CHECK_N.to_string(), "--mmlu-n", &MMLU_N.to_string(), "--out"])
        .arg(out);
    let result = run_python(cmd, "check", |ev| {
        if ev.get("event").and_then(|e| e.as_str()) == Some("measure") {
            let step = ev.get("step").and_then(|v| v.as_u64()).unwrap_or(0);
            with_run(|r| r.step = step);
        }
    });
    let _ = crate::process_util::kill_tree(&mut server);
    result
}

fn free_port() -> Option<u16> {
    std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?.local_addr().ok().map(|a| a.port())
}

// ── Environment ───────────────────────────────────────────────────────────

struct RunProgress;

impl crate::private_python::Progress for RunProgress {
    fn log(&self, line: String) {
        log(line);
    }
    fn cancel_flag(&self) -> Arc<AtomicBool> {
        CANCEL.clone()
    }
    fn set_download(&self, done: u64, total: u64, _speed: u64) {
        with_run(|r| set_bytes(r, done, total));
    }
}

const WHY: crate::private_python::Why<'static> = crate::private_python::Why {
    log: "the refusal-removal tool runs on LU's own Python",
    sentence: "The refusal-removal tool needs LU's own Python",
};

fn ensure_env(job: &Job) -> Result<PathBuf, String> {
    let (torch_args, torch_label) = torch_install(&job.device)?;
    let wanted = env_wanted(&torch_label);
    let vpy = venv_python();
    if std::fs::read_to_string(env_marker()).ok().as_deref() == Some(wanted.as_str()) && vpy.is_file() {
        return Ok(vpy);
    }
    let base = crate::private_python::ensure_for(&RunProgress, WHY)?;
    check_cancel()?;
    if !vpy.is_file() {
        log("Creating the tool's own Python environment.");
        std::fs::create_dir_all(root()).map_err(|e| format!("Could not create {}: {}", root().display(), os_error::english(&e)))?;
        let mut cmd = crate::commands::voice_loop::install::private_python(&base);
        cmd.args(["-m", "venv"]).arg(venv_dir());
        run_python(cmd, "setup", |_| {})?;
    }
    let pip = |extra: &[String]| {
        let mut cmd = crate::python::python_command(&vpy);
        cmd.env_remove("PYTHONHOME").env_remove("PYTHONPATH");
        // "raw" writes "Progress <done> of <total>" per file even into a
        // pipe (pip 24.1 and later; LU's Python 3.12.15 brings 25.x).
        cmd.args(["-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", "--progress-bar", "raw"]);
        cmd.args(extra);
        cmd
    };
    set_phase("setup", "Installing PyTorch");
    retry_network(|| run_python(pip(&torch_args), "setup", |_| {}))?;
    set_phase("setup", &format!("Installing Heretic {HERETIC_VERSION}"));
    let res = resources_dir(&job.script);
    let args = vec![
        "-r".to_string(),
        res.join("requirements.txt").to_string_lossy().into_owned(),
        "-c".to_string(),
        res.join("constraints.txt").to_string_lossy().into_owned(),
    ];
    retry_network(|| run_python(pip(&args), "setup", |_| {}))?;
    std::fs::write(env_marker(), wanted).map_err(|e| format!("Could not mark the environment: {}", os_error::english(&e)))?;
    Ok(vpy)
}

fn resources_dir(script: &Path) -> PathBuf {
    script.parent().map(Path::to_path_buf).unwrap_or_default()
}

fn retry_network(mut f: impl FnMut() -> Result<(), String>) -> Result<(), String> {
    for attempt in 0..3 {
        match f() {
            Err(e) if e != CANCELLED && attempt < 2 && e.contains("connection broke off") => {
                log("The download broke off, trying again in 15 seconds.");
                for _ in 0..15 {
                    check_cancel()?;
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
            other => return other,
        }
    }
    Ok(())
}

/// llama.cpp's converter at the engine's commit, verified by size and digest.
fn ensure_converter() -> Result<(), String> {
    let dir = convert_dir();
    let marker = dir.join(".lu-complete");
    if marker.is_file() {
        return Ok(());
    }
    set_phase("setup", "Getting the GGUF converter");
    let url = format!("https://codeload.github.com/ggml-org/llama.cpp/zip/{LLAMA_COMMIT}");
    let client = reqwest::blocking::Client::builder()
        .user_agent(crate::app_identity::outgoing_agent_for(crate::app_identity::APP_VERSION))
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(1800))
        .build()
        .map_err(|e| format!("HTTP client: {}", os_error::english(&e)))?;
    let mut resp = client.get(&url).send().map_err(|e| format!("The converter could not be downloaded: {}", os_error::english(&e)))?;
    if !resp.status().is_success() {
        return Err(format!("The converter could not be downloaded (HTTP {}).", resp.status()));
    }
    let mut bytes = Vec::with_capacity(LLAMA_ZIP_BYTES as usize);
    let mut buf = [0u8; 65536];
    loop {
        check_cancel()?;
        let n = resp.read(&mut buf).map_err(|e| format!("The converter download broke off: {}", os_error::english(&e)))?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..n]);
        with_run(|r| set_bytes(r, bytes.len() as u64, LLAMA_ZIP_BYTES));
        if bytes.len() as u64 > LLAMA_ZIP_BYTES {
            return Err("The converter archive is larger than expected; nothing was unpacked.".into());
        }
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if bytes.len() as u64 != LLAMA_ZIP_BYTES || digest != LLAMA_ZIP_SHA256 {
        return Err("The converter archive is not the expected one (size or checksum differ); nothing was unpacked.".into());
    }
    let tmp = root().join(".llama-convert-unpack");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("Could not unpack the converter: {}", os_error::english(&e)))?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("The converter archive could not be read: {e}"))?;
    let prefix = format!("llama.cpp-{LLAMA_COMMIT}/");
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("The converter archive could not be read: {e}"))?;
        let Some(name) = entry.enclosed_name() else { continue };
        let Ok(rel) = name.strip_prefix(&prefix) else { continue };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let wanted = rel_str == "convert_hf_to_gguf.py" || rel_str.starts_with("conversion/") || rel_str.starts_with("gguf-py/");
        if !wanted || entry.is_dir() {
            continue;
        }
        let dest = tmp.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Could not unpack the converter: {}", os_error::english(&e)))?;
        }
        let mut f = std::fs::File::create(&dest).map_err(|e| format!("Could not unpack the converter: {}", os_error::english(&e)))?;
        std::io::copy(&mut entry, &mut f).map_err(|e| format!("Could not unpack the converter: {}", os_error::english(&e)))?;
    }
    if !tmp.join("convert_hf_to_gguf.py").is_file() {
        return Err("The converter archive did not contain the converter.".into());
    }
    std::fs::write(tmp.join(".lu-complete"), LLAMA_COMMIT).map_err(|e| format!("Could not unpack the converter: {}", os_error::english(&e)))?;
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&tmp, &dir).map_err(|e| format!("Could not put the converter in place: {}", os_error::english(&e)))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hub_answers_are_read_the_way_the_hub_writes_them() {
        // Trimmed from api/models/Qwen/Qwen2.5-0.5B-Instruct?blobs=true, 25.10.2026.
        let v = json!({
            "id": "Qwen/Qwen2.5-0.5B-Instruct",
            "sha": "7ae557604adf67be50417f59c2c2f167def9a775",
            "gated": false,
            "private": false,
            "tags": ["transformers", "license:apache-2.0"],
            "cardData": { "license": "apache-2.0" },
            "config": { "model_type": "qwen2" },
            "safetensors": { "parameters": { "BF16": 494032768u64 }, "total": 494032768u64 },
            "siblings": [
                { "rfilename": "config.json", "size": 659 },
                { "rfilename": "model.safetensors", "size": 988097824u64 },
                { "rfilename": "onnx/model.safetensors", "size": 5 }
            ]
        });
        let h = parse_hub_info(&v);
        assert_eq!(h.sha.len(), 40);
        assert!(!h.gated);
        assert_eq!(h.license.as_deref(), Some("apache-2.0"));
        assert_eq!(h.params, Some(494_032_768));
        assert_eq!(h.download_bytes, 988_097_824);
        assert_eq!(h.safetensors_files, 1);
        assert_eq!(h.model_type.as_deref(), Some("qwen2"));
    }

    #[test]
    fn a_gated_repo_and_a_license_only_in_the_tags_are_seen() {
        let v = json!({ "sha": "x", "gated": "manual", "tags": ["license:llama3.1"], "siblings": [] });
        let h = parse_hub_info(&v);
        assert!(h.gated);
        assert_eq!(h.license.as_deref(), Some("llama3.1"));
        let v = json!({ "sha": "x", "gated": false, "cardData": { "license": ["mit"] }, "siblings": [] });
        assert_eq!(parse_hub_info(&v).license.as_deref(), Some("mit"));
    }

    #[test]
    fn the_same_model_and_settings_reuse_one_work_folder() {
        let a = work_key("Qwen/Qwen3-4B", "abc", 200, "balanced", &DeviceKind::Apple, Quantization::None);
        let b = work_key("Qwen/Qwen3-4B", "abc", 200, "balanced", &DeviceKind::Apple, Quantization::None);
        let c = work_key("Qwen/Qwen3-4B", "abc", 100, "balanced", &DeviceKind::Apple, Quantization::None);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!(a.starts_with("Qwen-Qwen3-4B-"));
        assert!(!a.contains('/'));
    }

    #[test]
    fn pip_download_lines_are_read() {
        let line = "Downloading https://download-r2.pytorch.org/whl/cu130/torch-2.14.1%2Bcu130-cp312-cp312-win_amd64.whl (1990.6 MB)";
        assert_eq!(pip_download(line), Some(("torch 2.14.1+cu130".to_string(), 1990.6)));
        assert_eq!(pip_download("  Downloading numpy-2.5.4-cp312-cp312-win_amd64.whl (12.6 MB)").map(|d| d.1), Some(12.6));
        assert_eq!(pip_download("  Downloading mpmath-1.3.0-py3-none-any.whl.metadata (8.6 kB)"), None);
        assert_eq!(pip_download("Downloading x.whl (2.1 GB)").map(|d| d.1), Some(2100.0));
        assert_eq!(pip_download("Collecting torch"), None);
        assert_eq!(pip_progress("Progress 1048576 of 1990600000"), Some((1_048_576, 1_990_600_000)));
        assert_eq!(pip_progress("Progress of the night"), None);
    }

    /// The box, 3.0.8: "Installing PyTorch", an empty bar, 26 minutes.
    #[test]
    fn the_pytorch_download_shows_its_bytes_in_the_setup_step() {
        let mut r = RunState { phase: "setup".into(), phase_label: "Installing PyTorch".into(), ..Default::default() };
        pip_line(&mut r, "Collecting torch");
        pip_line(&mut r, "  Downloading https://download-r2.pytorch.org/whl/cu130/torch-2.14.1%2Bcu130-cp312-cp312-win_amd64.whl (1990.6 MB)");
        assert_eq!(r.phase_label, "Installing PyTorch: downloading torch 2.14.1+cu130");
        pip_line(&mut r, "Progress 0 of 1990600000");
        pip_line(&mut r, "Progress 995300000 of 1990600000");
        assert!(r.bytes);
        assert_eq!((r.step, r.total), (995_300_000, 1_990_600_000));
        // a small file afterwards leaves the bar alone
        pip_line(&mut r, "  Downloading sympy-1.14.0-py3-none-any.whl (6.3 MB)");
        pip_line(&mut r, "Progress 100 of 6300000");
        assert_eq!(r.step, 995_300_000);
        pip_line(&mut r, "Installing collected packages: mpmath, torch");
        assert_eq!(r.phase_label, "Installing PyTorch: unpacking");
        assert!(!r.bytes);
        assert_eq!(r.total, 0);
    }

    #[test]
    fn a_check_of_the_original_from_3_0_8_is_measured_again() {
        let old: Check = serde_json::from_str(r#"{"refusals":39,"falseAlarms":13,"mmlu":22,"n":50}"#).unwrap();
        assert!(!check_is_current(Some(&old)));
        assert!(!check_is_current(None));
        let new = Check { mmlu_n: Some(MMLU_N), mmlu_marks: Some("1".repeat(MMLU_N as usize)), ..old };
        assert!(check_is_current(Some(&new)));
    }

    #[test]
    fn the_byte_meter_gives_speed_and_time_left() {
        let t = Instant::now();
        let mut m = ByteMeter::default();
        assert_eq!(m.sample(t, 1_000_000, 1_000_000_000), (None, None));
        let (rate, left) = m.sample(t + Duration::from_secs(2), 21_000_000, 1_000_000_000);
        assert_eq!(rate, Some(10_000_000));
        assert_eq!(left, Some(98));
        // the window forgets a stall long ago
        m.sample(t + Duration::from_secs(30), 300_000_000, 1_000_000_000);
        let (rate, _) = m.sample(t + Duration::from_secs(32), 320_000_000, 1_000_000_000);
        assert_eq!(rate, Some(10_000_000));
        // a new file starts over
        assert_eq!(m.sample(t + Duration::from_secs(33), 5, 100), (None, None));
        // the pause before the first megabyte does not count
        let mut m = ByteMeter::default();
        m.sample(t, 0, 988_000_000);
        m.sample(t + Duration::from_secs(3), 40_000, 988_000_000);
        assert_eq!(m.sample(t + Duration::from_secs(4), 4_000_000, 988_000_000), (None, None));
        assert_eq!(m.sample(t + Duration::from_secs(6), 12_000_000, 988_000_000).0, Some(4_000_000));
        // finished
        let mut m = ByteMeter::default();
        m.sample(t, 2_000_000, 10_000_000);
        assert_eq!(m.sample(t + Duration::from_secs(2), 10_000_000, 10_000_000), (Some(4_000_000), Some(0)));
    }

    #[test]
    fn failures_read_as_sentences() {
        assert!(failure_message("search", "torch.OutOfMemoryError: CUDA out of memory", "exit code 1").starts_with("The model did not fit"));
        assert!(failure_message("download", "OSError: [Errno 28] No space left on device", "exit code 1").starts_with("The disk ran full"));
        let m = failure_message("convert", "KeyError: 'foo'", "exit code 1");
        assert!(m.contains("convert") && m.contains("KeyError"));
    }

    #[test]
    fn the_pinned_files_are_the_ones_shipped() {
        assert!(REQUIREMENTS.contains("heretic-llm==1.4.0"));
        assert!(CONSTRAINTS.contains("transformers==5.20.2"));
        assert!(!CONSTRAINTS.lines().any(|l| l.starts_with("torch==")), "PyTorch is chosen per device");
        assert_eq!(LLAMA_ZIP_SHA256.len(), 64);
    }

    #[test]
    fn the_env_marker_changes_with_the_torch_build() {
        assert_ne!(env_wanted("torch==2.14.1"), env_wanted("torch@https://download.pytorch.org/whl/cu130"));
        assert!(env_wanted("x").starts_with(ENV_VERSION));
    }
}
