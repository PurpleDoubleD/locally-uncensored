//! Character training on the Mac: a Z-Image Turbo LoRA from the photos of
//! the Train tab, made by `mflux-train` of the second image engine.
//!
//! On Windows and Linux the character trainer is musubi-tuner on CUDA
//! (`commands::trainer`). A Mac has no CUDA. The image engine it already has,
//! mflux 0.22.0, carries a trainer of its own, and a character trained with
//! it is a file the Mac's Create reads like any other LoRA: it lands in the
//! Mac's LoRA folder (`mlx_loras`) under the name the Windows trainer gives
//! its characters, `char_<trigger>_zimage.safetensors`, so the Use shelf and
//! the character chip find it.
//!
//! Read from the engine at 0.22.0 (`models/common/training/runner.py`,
//! `trainer.py`, `state/training_spec.py`,
//! `models/z_image/training_adapter/z_image_training_adapter.py`,
//! `models/z_image/README.md`), 15.10.2026:
//!   - The trainer runs on Z-Image Turbo and then always loads Ostris'
//!     training adapter, which undoes the distillation while the LoRA learns
//!     and is switched off again for the result. The runner names it as a
//!     hub file; this module fetches it once at one revision into the packs
//!     folder and hands the runner the local file.
//!   - It trains on the packs Create already runs (`model_path`), quantized
//!     ones included: the LoRA wraps `nn.QuantizedLinear` like `nn.Linear`.
//!     So a Mac that makes Z-Image pictures needs no 19 GB base download.
//!   - The result is saved with `diffusion_model.<layer>.lora_A/B` keys,
//!     which the Z-Image mapping of the same engine reads for a picture.
//!   - Steps are `epochs x photos`; a step is one photo at one noise level.
//!   - `gradient_checkpointing` keeps "weights plus two blocks" in memory
//!     instead of "weights plus every block", about 30 % slower.
//!
//! One run at a time, as a process of its own that the app starts, reads and
//! can end, like a track of the music lane (`commands::music`): it holds a
//! whole model and is refused beside an image, a track or a video.

use super::mflux::{self, Pack};
use crate::commands::{bad_request, internal, CmdResult};
use crate::os_error;
use crate::state::AppState;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::Mutex;
use std::time::{Duration, Instant};

// ── The pins ──────────────────────────────────────────────────────────

/// The training adapter the engine loads for Z-Image Turbo
/// (`TrainingRunner.ZIMAGE_TURBO_TRAINING_ADAPTER`), Apache 2.0. The commit
/// and the size are what the hub listed on 15.10.2026; the file's sha256 is
/// `20a541d3...2265f6`, as its LFS pointer says.
pub(crate) const ADAPTER_REPO: &str = "ostris/zimage_turbo_training_adapter";
pub(crate) const ADAPTER_REVISION: &str = "654cd1bf8b3589d9442cb1c5e35221879e1af4f3";
pub(crate) const ADAPTER_FILE: &str = "zimage_turbo_training_adapter_v2.safetensors";
pub(crate) const ADAPTER_BYTES: u64 = 340_194_488;

/// The packs a character is trained on, in the order they are taken. The
/// 4-bit pack first: its run was measured (see `MIN_RAM_GB`), and a LoRA of
/// it works on the 8-bit pack as well, as both are the same model.
const BASES: [&Pack; 2] = [&mflux::ZIMAGE_TURBO_4BIT, &mflux::ZIMAGE_TURBO_8BIT];

/// The smallest Mac a run is started on. Measured on a 48 GB M5 Pro with
/// the 4-bit pack, ten photos at 768 pixels and the memory savers below
/// (15.10.2026): free memory went from 72 % to 57 % at the peak, about 7 GB
/// for the run, at 6.9 s a step. The pack alone asks 16 GB of a Mac to make
/// a picture; a training holds more of it longer, so 24.
pub(crate) const MIN_RAM_GB: u32 = 24;

/// The longest side of a photo as it is trained, like the Windows recipe.
const RESOLUTION: u32 = 768;
/// The most the engine's pool of freed buffers may hold, in GB.
const CACHE_LIMIT_GB: f64 = 2.0;
/// The rank of every layer of the LoRA, and its learning rate.
const RANK: u32 = 16;
const LEARNING_RATE: f64 = 1e-4;
/// The layers of every one of the 30 blocks that learn: attention and the
/// feed forward part, as in the engine's example.
const LAYERS: [&str; 7] = [
    "attention.to_q",
    "attention.to_k",
    "attention.to_v",
    "attention.to_out.0",
    "feed_forward.w1",
    "feed_forward.w2",
    "feed_forward.w3",
];
const BLOCKS: u32 = 30;

/// What Create offers (`TRAIN_PRESETS`), and what a run is held inside of,
/// as on Windows (`start_character_training`).
const DEFAULT_STEPS: u32 = 1200;
const MIN_STEPS: u32 = 100;
const MAX_STEPS: u32 = 4000;
pub(crate) const MIN_PHOTOS: usize = 4;
const MAX_PHOTOS: usize = 100;
const MAX_PHOTO_BYTES: usize = 40 * 1024 * 1024;

/// A run is ended after this long whatever it says, and after this long of
/// silence. A step prints a line, the loading of the model takes a minute.
const RUN_TIMEOUT: Duration = Duration::from_secs(12 * 60 * 60);
const STALL_AFTER: Duration = Duration::from_secs(10 * 60);

// ── Where it lives ────────────────────────────────────────────────────

fn venv_python() -> PathBuf {
    mflux::venv_dir().join("bin").join("python")
}

/// Beside the files of the other LoRAs the engine runs with (`lora_dir`).
fn adapter_dir(root: &Path) -> PathBuf {
    root.join("_loras").join(ADAPTER_REPO.replace('/', "--"))
}

fn adapter_ready(root: &Path) -> bool {
    std::fs::metadata(adapter_dir(root).join(ADAPTER_FILE)).is_ok_and(|m| m.len() == ADAPTER_BYTES)
}

/// The photos of a set, until the next set of the same name replaces them.
fn sets_root(root: &Path) -> PathBuf {
    mflux::scratch(root).join("train-sets")
}

/// The folder of one run: its config, its job and the engine's checkpoints.
/// It goes when the run is over.
fn runs_root(root: &Path) -> PathBuf {
    mflux::scratch(root).join("train-runs")
}

fn run_pid_file(root: &Path) -> PathBuf {
    runs_root(root).join("run.pid")
}

/// The pack a run trains on: the first of `BASES` that is on disk whole.
fn base_pack(root: &Path) -> Option<&'static Pack> {
    BASES.into_iter().find(|p| mflux::pack_complete(&root.join(p.dir)))
}

/// The file a run writes: a character's, as the Windows trainer names it
/// (`parseLocalCharacterLora` in `src/api/trainer.ts`), or since 3.0.9 (P8)
/// a style's (`TrainKind::output_name`).
fn trained_file(kind: crate::commands::trainer::TrainKind, name: &str) -> String {
    format!("{}.safetensors", kind.output_name(name))
}

fn memory_refusal(total_bytes: u64) -> Option<String> {
    if total_bytes == 0 {
        return None;
    }
    let have = (total_bytes as f64 / 1_073_741_824.0).round() as u32;
    (have < MIN_RAM_GB).then(|| {
        format!(
            "Training a character needs a Mac with {MIN_RAM_GB} GB of memory, and this one has {have} GB. It was not started, because the run would fill the memory until the Mac stops answering."
        )
    })
}

/// Why something that loads a model cannot start now, or None. Images,
/// tracks and videos ask this before they load theirs.
pub(crate) fn refusal() -> Option<&'static str> {
    busy().then_some("A character is being trained on this Mac. Wait for it to finish or stop it, then try again.")
}

// ── Status ────────────────────────────────────────────────────────────

pub fn train_status(_state: &AppState, _args: &Value) -> CmdResult {
    let root = mflux::models_root();
    let base = base_pack(&root);
    Ok(json!({
        "engineReady": mflux::engine_ready(),
        "base": base.map(|p| p.dir),
        "adapterReady": adapter_ready(&root),
        "adapterBytes": ADAPTER_BYTES,
        "minRamGB": MIN_RAM_GB,
        "memoryRefusal": memory_refusal(crate::commands::system::total_memory_bytes()),
        "running": busy(),
    }))
}

// ── The photos ────────────────────────────────────────────────────────

/// What a photo is, read from its first bytes.
fn photo_ext(bytes: &[u8]) -> Option<&'static str> {
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

fn set_dir(root: &Path, set: &str) -> Result<PathBuf, String> {
    let set = crate::commands::trainer::sanitize_component(set);
    if set.is_empty() {
        return Err("A training set needs a name.".to_string());
    }
    Ok(sets_root(root).join(set))
}

/// Write one photo and its caption into a set. The name is the hash of the
/// photo, so the same photo twice is one photo, and two photos whose names
/// differ only in characters a file name cannot hold stay two.
fn stage_in(dir: &Path, bytes: &[u8], caption: &str) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    if bytes.is_empty() {
        return Err("The photo is empty.".to_string());
    }
    if bytes.len() > MAX_PHOTO_BYTES {
        return Err("The photo is larger than 40 MB.".to_string());
    }
    let ext = photo_ext(bytes).ok_or("The photo is not a PNG, JPG or WebP file.")?;
    if count_photos(dir) >= MAX_PHOTOS {
        return Err(format!("A character trains on at most {MAX_PHOTOS} photos."));
    }
    let stem: String = Sha256::digest(bytes).iter().take(12).map(|b| format!("{b:02x}")).collect();
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create the folder for the photos: {}", os_error::english(&e)))?;
    std::fs::write(dir.join(format!("{stem}.{ext}")), bytes).map_err(|e| format!("Could not write the photo: {}", os_error::english(&e)))?;
    // The engine pairs every photo with the text file of the same name, and
    // a photo without one is not trained on.
    std::fs::write(dir.join(format!("{stem}.txt")), caption.trim()).map_err(|e| format!("Could not write the caption: {}", os_error::english(&e)))?;
    Ok(format!("{stem}.{ext}"))
}

fn count_photos(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|it| {
            it.flatten()
                .filter(|e| {
                    let p = e.path();
                    let photo = p.extension().and_then(|x| x.to_str()).is_some_and(|x| ["png", "jpg", "webp"].contains(&x));
                    photo && p.with_extension("txt").is_file()
                })
                .count()
        })
        .unwrap_or(0)
}

#[derive(Deserialize)]
struct StageArgs {
    set: String,
    /// The photo as base64, without a `data:` prefix.
    data: String,
    caption: String,
}

pub fn train_stage(_state: &AppState, args: &Value) -> CmdResult {
    let a: StageArgs = serde_json::from_value(args.clone()).map_err(|e| bad_request(e.to_string()))?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(a.data.as_bytes()).map_err(|_| bad_request("The photo could not be read."))?;
    let dir = set_dir(&mflux::models_root(), &a.set).map_err(bad_request)?;
    let staged = stage_in(&dir, &bytes, &a.caption).map_err(bad_request)?;
    Ok(json!({ "staged": staged }))
}

#[derive(Deserialize)]
struct SetArgs {
    set: String,
}

pub fn train_clear(_state: &AppState, args: &Value) -> CmdResult {
    let a: SetArgs = serde_json::from_value(args.clone()).map_err(|e| bad_request(e.to_string()))?;
    let dir = set_dir(&mflux::models_root(), &a.set).map_err(bad_request)?;
    // The set a run is reading from is not emptied under it.
    if busy() {
        return Err(bad_request("A character is being trained on this Mac. Wait for it to finish or stop it."));
    }
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| internal(format!("Could not clear the photos: {}", os_error::english(&e))))?;
    }
    Ok(json!({ "ok": true }))
}

// ── The run ───────────────────────────────────────────────────────────

/// The epochs that make at least `steps` steps over `photos` photos.
fn epochs_for(steps: u32, photos: usize) -> u32 {
    let photos = photos.max(1) as u32;
    steps.div_ceil(photos).max(1)
}

/// The training config the engine reads (`TrainingSpec.from_conf`).
fn config_json(model_path: &Path, data: &Path, out: &Path, epochs: u32) -> Value {
    let targets: Vec<Value> = LAYERS
        .iter()
        .map(|layer| json!({ "module_path": format!("layers.{{block}}.{layer}"), "blocks": { "start": 0, "end": BLOCKS }, "rank": RANK }))
        .collect();
    json!({
        "model": "z-image-turbo",
        "model_path": model_path,
        "data": data,
        "seed": 42,
        // The schedule of the Turbo model: nine steps without guidance. A
        // training step draws one of its noise levels, the middle ones most
        // often, which is where a face or a figure is decided.
        "steps": 9,
        "guidance": 0.0,
        "quantize": null,
        "max_resolution": RESOLUTION,
        // The three memory savers of the engine. Without the last two a run
        // at 768 pixels went from 68 % free memory to 34 % within its first
        // step on a 48 GB Mac and was ended (15.10.2026); MLX keeps every
        // freed buffer for reuse unless it is told not to. `low_ram` keeps
        // the encoded photos on disk (in the set's folder) and clears that
        // pool after every step.
        "gradient_checkpointing": true,
        "low_ram": true,
        "cache_limit_gb": CACHE_LIMIT_GB,
        "training_loop": { "num_epochs": epochs, "batch_size": 1, "timestep_low": 0, "timestep_high": 9, "timestep_type": "sigmoid" },
        "optimizer": { "name": "AdamW", "learning_rate": LEARNING_RATE },
        // One checkpoint, the one the engine writes at the end anyway.
        "checkpoint": { "save_frequency": 1_000_000, "output_path": out },
        "lora_layers": { "targets": targets },
    })
}

/// The job the runner reads.
fn job_json(root: &Path, config: &Path, work: &Path, output: &Path, photos: usize) -> Value {
    json!({
        "adapter_dir": adapter_dir(root),
        "adapter_file": ADAPTER_FILE,
        "adapter_repo": ADAPTER_REPO,
        "adapter_revision": ADAPTER_REVISION,
        "images": photos,
        "config": config,
        "work": work,
        "output": output,
    })
}

/// The runner: fetch the adapter when it is not there, hand the engine its
/// local path, train, and write the LoRA where the app wants it. Its lines
/// that start with `LU-TRAIN ` are for the app; the rest is the engine's.
const RUNNER: &str = r#"
import json, shutil, sys
from pathlib import Path

def say(**kw):
    print("LU-TRAIN " + json.dumps(kw), flush=True)

job = json.loads(Path(sys.argv[sys.argv.index("--lu-train-job") + 1]).read_text())
adapter = Path(job["adapter_dir"]) / job["adapter_file"]
try:
    if not adapter.is_file():
        say(phase="adapter")
        from huggingface_hub import hf_hub_download
        hf_hub_download(repo_id=job["adapter_repo"], filename=job["adapter_file"], revision=job["adapter_revision"], local_dir=job["adapter_dir"])
    say(phase="load")
    from mflux.models.common.training.runner import TrainingRunner
    from mflux.models.z_image.training_adapter.z_image_training_adapter import ZImageTrainingAdapter
    TrainingRunner.ZIMAGE_TURBO_TRAINING_ADAPTER = str(adapter)
    total = int(job["images"])
    encode = ZImageTrainingAdapter.encode_data
    def encode_said(self, *, data_id, **kw):
        say(phase="encode", done=data_id, total=total)
        return encode(self, data_id=data_id, **kw)
    ZImageTrainingAdapter.encode_data = encode_said
    trained, spec = TrainingRunner.train(config_path=job["config"], resume_path=None)
    say(phase="save")
    part = Path(job["work"]) / "lora.safetensors"
    trained.save_lora_adapter(path=part, training_spec=spec)
    shutil.move(str(part), job["output"])
    say(phase="done")
except Exception as e:
    say(phase="error", error=f"{type(e).__name__}: {e}")
    raise
"#;

const JOB_FLAG: &str = "--lu-train-job";

fn run_command(root: &Path, work: &Path, job_file: &Path) -> Command {
    let mut cmd = crate::python::python_command(venv_python());
    // `-u`: through a pipe Python holds its lines back in blocks.
    cmd.arg("-u").arg("-c").arg(RUNNER).arg(JOB_FLAG).arg(job_file.as_os_str());
    cmd.current_dir(work)
        .env("HF_HOME", mflux::hf_home(root))
        .env("HF_XET_CACHE", mflux::hf_home(root).join("xet"))
        .env("TOKENIZERS_PARALLELISM", "false")
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null());
    cmd
}

/// What a poll is told about the run: the last one, or the one under way.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
struct View {
    job: Option<String>,
    /// idle, running, complete, error or cancelled.
    status: &'static str,
    phase: String,
    percent: u32,
    step: u32,
    steps: u32,
    trigger: Option<String>,
    error: Option<String>,
    output: Option<String>,
    logs: Vec<String>,
}

struct Runs {
    pid: Mutex<Option<u32>>,
    held: Mutex<Option<Option<String>>>,
    stopped: AtomicBool,
    view: Mutex<View>,
    heard: Mutex<Option<Instant>>,
    /// Whether the steps of the engine's bar are the training's: the
    /// download of the adapter draws a bar of the same kind before.
    training: AtomicBool,
}

impl Runs {
    const fn new() -> Self {
        Self {
            pid: Mutex::new(None),
            held: Mutex::new(None),
            stopped: AtomicBool::new(false),
            view: Mutex::new(View {
                job: None,
                status: "idle",
                phase: String::new(),
                percent: 0,
                step: 0,
                steps: 0,
                trigger: None,
                error: None,
                output: None,
                logs: Vec::new(),
            }),
            heard: Mutex::new(None),
            training: AtomicBool::new(false),
        }
    }

    fn pid(&self) -> std::sync::MutexGuard<'_, Option<u32>> {
        self.pid.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn held(&self) -> std::sync::MutexGuard<'_, Option<Option<String>>> {
        self.held.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn view(&self) -> std::sync::MutexGuard<'_, View> {
        self.view.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn heard_now(&self) {
        *self.heard.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    }

    fn silent_for(&self) -> Duration {
        self.heard.lock().unwrap_or_else(|e| e.into_inner()).map(|t| t.elapsed()).unwrap_or_default()
    }

    fn claim(&self, run: Option<String>, job: &str, trigger: &str) -> Option<Claim<'_>> {
        let mut held = self.held();
        if held.is_some() {
            return None;
        }
        self.stopped.store(false, SeqCst);
        self.training.store(false, SeqCst);
        *held = Some(run);
        *self.view() = View {
            job: Some(job.to_string()),
            status: "running",
            phase: "Freeing memory".to_string(),
            trigger: Some(trigger.to_string()),
            ..View::default()
        };
        self.heard_now();
        Some(Claim(self))
    }

    fn busy(&self) -> bool {
        let held = self.held().is_some();
        held || self.pid().is_some()
    }

    fn stop(&self) -> bool {
        let pid = {
            let pid = self.pid();
            if pid.is_none() && self.held().is_none() {
                return false;
            }
            self.stopped.store(true, SeqCst);
            *pid
        };
        if let Some(pid) = pid {
            crate::process_util::kill_pid_tree(pid);
        }
        true
    }

    fn stop_run(&self, run: Option<&str>) -> bool {
        if let Some(name) = run {
            if self.held().as_ref().and_then(|r| r.as_deref()) != Some(name) {
                return false;
            }
        }
        self.stop()
    }

    fn note(&self, line: &str) {
        self.heard_now();
        let mut view = self.view();
        if let Some(said) = line.strip_prefix("LU-TRAIN ").and_then(|j| serde_json::from_str::<Value>(j).ok()) {
            match said["phase"].as_str().unwrap_or("") {
                "adapter" => {
                    view.phase = "Downloading the training adapter (340 MB, one time)".to_string();
                    view.percent = view.percent.max(1);
                }
                "load" => {
                    view.phase = "Loading Z-Image Turbo".to_string();
                    view.percent = view.percent.max(4);
                }
                "encode" => {
                    let (done, total) = (said["done"].as_u64().unwrap_or(0), said["total"].as_u64().unwrap_or(0));
                    view.phase = format!("Reading the photos ({}/{total})", (done + 1).min(total.max(1)));
                    if let Some(share) = (done * 5).checked_div(total) {
                        view.percent = view.percent.max(5 + share as u32);
                    }
                    self.training.store(true, SeqCst);
                }
                "save" => {
                    view.phase = "Saving the character".to_string();
                    view.percent = view.percent.max(99);
                }
                "error" => view.error = said["error"].as_str().map(str::to_string),
                "done" => view.percent = 100,
                _ => {}
            }
            return;
        }
        if self.training.load(SeqCst) {
            if let Some((done, total)) = bar_progress(line) {
                view.phase = "Training".to_string();
                view.step = done.min(total);
                view.steps = total;
                view.percent = view.percent.max(10 + view.step * 88 / total);
                return;
            }
        }
        view.logs.push(line.to_string());
        let over = view.logs.len().saturating_sub(40);
        view.logs.drain(..over);
    }

    fn conclude(&self, verdict: &Result<(), String>) {
        let mut view = self.view();
        match verdict {
            Ok(()) => {
                view.status = "complete";
                view.percent = 100;
                view.error = None;
            }
            Err(why) if why == STOPPED => {
                view.status = "cancelled";
                view.error = Some("cancelled".to_string());
            }
            Err(why) => {
                view.status = "error";
                view.error = Some(why.clone());
            }
        }
    }
}

struct Claim<'a>(&'a Runs);

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        *self.0.held() = None;
    }
}

/// `done/total` of a tqdm bar: ` 25%|##5       | 15/60 [01:02<03:06,  4.1s/it]`.
fn bar_progress(line: &str) -> Option<(u32, u32)> {
    let counts = line.rsplit_once('|')?.1.trim_start();
    let (done, rest) = counts.split_once('/')?;
    let total = rest.split(|c: char| !c.is_ascii_digit()).next()?;
    Some((done.trim().parse().ok()?, total.parse().ok().filter(|t| *t > 0)?))
}

static RUNS: Runs = Runs::new();

/// Whether a character is being trained right now.
pub(crate) fn busy() -> bool {
    RUNS.busy()
}

/// End the run. The quit path calls this: the child holds a whole model.
pub(crate) fn stop() -> bool {
    RUNS.stop()
}

const STOPPED: &str = "The training was stopped.";
const HUNG: &str = "The trainer said nothing for ten minutes and was ended. Start the training again.";

fn start(runs: &Runs, mut cmd: Command, pid_file: &Path) -> Result<std::process::Child, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut slot = runs.pid();
    if slot.is_some() {
        return Err("A training is already running on this Mac. Wait for it to finish.".to_string());
    }
    if runs.stopped.swap(false, SeqCst) {
        return Err(STOPPED.to_string());
    }
    let child = cmd.spawn().map_err(|e| format!("Could not start the trainer: {}", os_error::english(&e)))?;
    if let Some(dir) = pid_file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(pid_file, child.id().to_string());
    *slot = Some(child.id());
    runs.heard_now();
    Ok(child)
}

fn finish(runs: &Runs, mut child: std::process::Child, out: &Path, pid_file: &Path, limit: Duration, stall: Duration) -> Result<(), String> {
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let started = Instant::now();
    let status = std::thread::scope(|scope| {
        scope.spawn(|| crate::commands::music::read_lines(stdout, |line| runs.note(line)));
        scope.spawn(|| crate::commands::music::read_lines(stderr, |line| runs.note(line)));
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(Some(status)),
                Ok(None) => {}
                Err(e) => break Err(e),
            }
            if started.elapsed() > limit {
                let _ = crate::process_util::kill_tree(&mut child);
                let _ = child.wait();
                break Ok(None);
            }
            if runs.silent_for() > stall {
                let _ = crate::process_util::kill_tree(&mut child);
                let _ = child.wait();
                runs.view().error = Some(HUNG.to_string());
                break Ok(None);
            }
            std::thread::sleep(Duration::from_millis(200));
        };
        *runs.pid() = None;
        let _ = std::fs::remove_file(pid_file);
        status
    });
    let stopped = runs.stopped.swap(false, SeqCst);
    let said = runs.view().error.clone();
    let status = status.map_err(|e| format!("wait failed: {}", os_error::english(&e)))?;
    outcome(status.as_ref(), out.is_file(), said.as_deref(), stopped)
}

/// How a run ended, as `Ok` or the sentence for the user. `status` is `None`
/// when the app ended the process because it ran too long or hung.
fn outcome(status: Option<&std::process::ExitStatus>, wrote_lora: bool, said: Option<&str>, stopped: bool) -> Result<(), String> {
    if stopped {
        return Err(STOPPED.to_string());
    }
    let Some(status) = status else {
        return Err(match said {
            Some(HUNG) => HUNG.to_string(),
            _ => "The training did not finish within twelve hours and was stopped.".to_string(),
        });
    };
    if status.success() && wrote_lora {
        return Ok(());
    }
    if let Some(why) = said.filter(|w| !w.is_empty()) {
        return Err(format!("The trainer stopped: {why}"));
    }
    if status.success() {
        return Err("The trainer finished without writing the character.".to_string());
    }
    if let Some(code) = status.code() {
        return Err(format!("The trainer stopped with exit code {code}. Its last lines are in the log."));
    }
    Err("The trainer was ended by macOS. This usually means the run did not fit into memory. Close other apps and try again.".to_string())
}

#[derive(Deserialize)]
struct StartArgs {
    set: String,
    trigger: String,
    #[serde(default)]
    steps: Option<u32>,
    #[serde(default)]
    run: Option<String>,
    /// "style" for a style / concept LoRA; missing is a character.
    #[serde(default)]
    kind: Option<String>,
}

pub async fn train_start(state: &AppState, args: &Value) -> CmdResult {
    super::ensure_image_engine_supported()?;
    let a: StartArgs = serde_json::from_value(args.clone()).map_err(|e| bad_request(e.to_string()))?;
    let trigger = crate::commands::trainer::sanitize_component(&a.trigger);
    if trigger.is_empty() {
        return Err(bad_request("Pick a trigger word first, e.g. davechar. It becomes the token that summons your character."));
    }
    let root = mflux::models_root();
    if !mflux::engine_ready() {
        return Err(bad_request("The MLX image engine is not set up. Install Z-Image Turbo in the Model Manager first."));
    }
    let Some(base) = base_pack(&root) else {
        return Err(bad_request("Training on a Mac needs Z-Image Turbo. Install it in the Model Manager first."));
    };
    if let Some(refusal) = memory_refusal(crate::commands::system::total_memory_bytes()) {
        return Err(bad_request(refusal));
    }
    let data = set_dir(&root, &a.set).map_err(bad_request)?;
    let photos = count_photos(&data);
    if photos < MIN_PHOTOS {
        return Err(bad_request(format!("Add at least {MIN_PHOTOS} photos first.")));
    }
    // One model in the memory at a time. What is being made holds its model
    // until it is through, and is not ended for a training.
    if super::image_engine_busy() {
        return Err(bad_request("An image is being generated on this Mac. Wait for it to finish, then train."));
    }
    if crate::commands::music::busy() {
        return Err(bad_request("A track is being made on this Mac. Wait for it to finish, then train."));
    }
    if state.video_process().lock().map(|p| p.is_some()).unwrap_or(true) {
        return Err(bad_request("A video is being generated on this Mac. Wait for it to finish, then train."));
    }
    let job = uuid::Uuid::new_v4().simple().to_string();
    let claim = RUNS
        .claim(a.run.clone(), &job, &trigger)
        .ok_or_else(|| bad_request("A training is already running on this Mac. Wait for it to finish."))?;
    // What the sidecar holds goes first, as before an image of the engine.
    let _ = super::mlx_unload(state, &Value::Null).await;

    let steps = a.steps.unwrap_or(DEFAULT_STEPS).clamp(MIN_STEPS, MAX_STEPS);
    let epochs = epochs_for(steps, photos);
    let work = runs_root(&root).join(&job);
    let loras = crate::commands::mlx_loras::loras_root();
    let kind = crate::commands::trainer::TrainKind::from_arg(a.kind.as_deref());
    let output = loras.join(trained_file(kind, &trigger));
    let config = work.join("config.json");
    let job_file = work.join("job.json");
    let written = std::fs::create_dir_all(&work)
        .and_then(|_| std::fs::create_dir_all(&loras))
        .and_then(|_| std::fs::write(&config, config_json(&root.join(base.dir), &data, &work.join("checkpoints"), epochs).to_string()))
        .and_then(|_| std::fs::write(&job_file, job_json(&root, &config, &work, &output, photos).to_string()));
    if let Err(e) = written {
        let why = format!("Could not prepare the training: {}", os_error::english(&e));
        RUNS.conclude(&Err(why.clone()));
        let _ = std::fs::remove_dir_all(&work);
        return Err(internal(why));
    }
    tracing::info!("[train] {} on {}: {photos} photos, {epochs} epochs", trigger, base.dir);
    let pid_file = run_pid_file(&root);
    let child = match start(&RUNS, run_command(&root, &work, &job_file), &pid_file) {
        Ok(child) => child,
        Err(why) => {
            RUNS.conclude(&Err(why.clone()));
            let _ = std::fs::remove_dir_all(&work);
            return Err(internal(why));
        }
    };
    let pid = child.id();
    let out = output.clone();
    std::thread::spawn(move || {
        let verdict = finish(&RUNS, child, &out, &pid_file, RUN_TIMEOUT, STALL_AFTER);
        match &verdict {
            Ok(()) => RUNS.view().output = Some(out.to_string_lossy().to_string()),
            Err(why) => tracing::error!("[train] {why}"),
        }
        RUNS.conclude(&verdict);
        let _ = std::fs::remove_dir_all(&work);
        drop(claim);
    });
    Ok(json!({
        "ok": true,
        "jobId": job,
        "pid": pid,
        "base": base.dir,
        "photos": photos,
        "epochs": epochs,
        "steps": epochs * photos as u32,
        "output": output,
    }))
}

pub fn train_progress(_state: &AppState, _args: &Value) -> CmdResult {
    let view = RUNS.view().clone();
    let mut answer = serde_json::to_value(&view).unwrap_or(Value::Null);
    answer["running"] = json!(busy());
    Ok(answer)
}

#[derive(Deserialize, Default)]
struct CancelArgs {
    #[serde(default)]
    run: Option<String>,
}

pub fn train_cancel(_state: &AppState, args: &Value) -> CmdResult {
    let a: CancelArgs = serde_json::from_value(args.clone()).unwrap_or_default();
    Ok(json!({ "ok": true, "stopped": RUNS.stop_run(a.run.as_deref()) }))
}

// ── A run that outlived the app ───────────────────────────────────────
//
// After a crash or a Force Quit nothing ends a running training: macOS has
// no parent death signal. The next start ends it, by the rule of the other
// engines: the pid that was noted, still a run of this app's run folder, and
// with launchd as its parent.

#[cfg(any(target_os = "macos", test))]
struct Leftover {
    parent: Option<u32>,
    cmd: Vec<String>,
}

#[cfg(any(target_os = "macos", test))]
fn is_orphaned_run(row: &Leftover, runs: &Path) -> bool {
    row.parent == Some(1) && row.cmd.windows(2).any(|w| w[0] == JOB_FLAG && Path::new(&w[1]).starts_with(runs))
}

/// End the training the last session left running, if there is one, and
/// return its pid. Called once at app start, off the main thread.
#[cfg(target_os = "macos")]
pub(crate) fn reap_orphaned_run() -> Option<u32> {
    let root = mflux::models_root();
    let pid_file = run_pid_file(&root);
    let pid: u32 = std::fs::read_to_string(&pid_file).ok()?.trim().parse().ok()?;
    let table = crate::process_util::process_table_with_cmdlines();
    let Some(process) = table.process(sysinfo::Pid::from_u32(pid)) else {
        let _ = std::fs::remove_file(&pid_file);
        return None;
    };
    let row = Leftover { parent: process.parent().map(|p| p.as_u32()), cmd: crate::process_util::cmdline_of(process) };
    if !is_orphaned_run(&row, &runs_root(&root)) {
        if row.parent == Some(1) {
            let _ = std::fs::remove_file(&pid_file);
        }
        return None;
    }
    crate::process_util::kill_pid_tree(pid);
    let _ = std::fs::remove_file(&pid_file);
    Some(pid)
}

/// For `real_run_mac`: whatever the last run said, for the record.
#[cfg(all(test, target_os = "macos"))]
pub(crate) fn real_run_view() -> Value {
    serde_json::to_value(RUNS.view().clone()).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest of a picture";

    fn production() -> &'static str {
        let src = include_str!("mlx_train.rs");
        &src[..src.find("#[cfg(test)]\nmod tests").unwrap()]
    }

    #[test]
    fn the_photo_limits_are_the_ones_create_says() {
        // `MIN_TRAIN_IMAGES` and `maxTrainImages('local')` of
        // src/lib/train-image-cap.ts: the board says "Drop 4 to 100 photos".
        let cap = include_str!("../../../src/lib/train-image-cap.ts");
        assert!(cap.contains(&format!("export const MIN_TRAIN_IMAGES = {MIN_PHOTOS}")));
        assert!(cap.contains(&format!("backend === 'cloud' ? 30 : {MAX_PHOTOS}")));
    }

    #[test]
    fn a_character_is_the_file_the_use_shelf_reads() {
        // `parseLocalCharacterLora` in src/api/trainer.ts.
        assert_eq!(trained_file(crate::commands::trainer::TrainKind::Character, "luxfox"), "char_luxfox_zimage.safetensors");
    }

    #[test]
    fn a_style_is_a_file_of_its_own_beside_the_characters() {
        use crate::commands::trainer::TrainKind;
        // `parseLocalStyleLora` in src/api/trainer.ts; the shelf skips it.
        assert_eq!(trained_file(TrainKind::Style, "inkwash"), "style_inkwash_zimage.safetensors");
        let start = &production()[production().find("pub async fn train_start").unwrap()..];
        assert!(start.contains("TrainKind::from_arg(a.kind.as_deref())"));
        assert!(start.contains("loras.join(trained_file(kind, &trigger))"));
    }

    #[test]
    fn the_steps_of_create_are_whole_epochs_over_the_photos() {
        assert_eq!(epochs_for(1200, 10), 120);
        assert_eq!(epochs_for(400, 30), 14, "14 x 30 = 420, the first count at or past 400");
        assert_eq!(epochs_for(100, 100), 1);
        assert_eq!(epochs_for(100, 0), 100, "no photos is refused before; the count still never divides by zero");
    }

    #[test]
    fn the_config_trains_the_turbo_pack_it_is_given_with_the_memory_savers_on() {
        let c = config_json(Path::new("/m/z-image-turbo-4bit"), Path::new("/s/train-sets/luxfox"), Path::new("/r/j/checkpoints"), 40);
        assert_eq!(c["model"], "z-image-turbo");
        assert_eq!(c["model_path"], "/m/z-image-turbo-4bit");
        assert_eq!(c["data"], "/s/train-sets/luxfox");
        assert_eq!(c["quantize"], Value::Null, "the pack is quantized already");
        assert_eq!(c["max_resolution"], RESOLUTION);
        assert_eq!(c["gradient_checkpointing"], true);
        assert_eq!(c["low_ram"], true);
        assert_eq!(c["cache_limit_gb"], CACHE_LIMIT_GB);
        assert_eq!(c["training_loop"]["num_epochs"], 40);
        assert_eq!(c["training_loop"]["timestep_high"], c["steps"]);
        assert!(c.get("monitoring").is_none(), "no preview pictures: each would load and run the model again");
        let targets = c["lora_layers"]["targets"].as_array().unwrap();
        assert_eq!(targets.len(), LAYERS.len());
        assert_eq!(targets[0]["module_path"], "layers.{block}.attention.to_q");
        assert!(targets.iter().all(|t| t["blocks"]["end"] == BLOCKS && t["rank"] == RANK));
    }

    #[test]
    fn the_job_hands_the_runner_the_pinned_adapter_and_where_the_character_goes() {
        let j = job_json(Path::new("/m"), Path::new("/r/j/config.json"), Path::new("/r/j"), Path::new("/l/char_a_zimage.safetensors"), 7);
        // Compared as paths: on Windows `join` puts a backslash.
        assert_eq!(Path::new(j["adapter_dir"].as_str().unwrap()), Path::new("/m/_loras/ostris--zimage_turbo_training_adapter"));
        assert_eq!(j["adapter_file"], ADAPTER_FILE);
        assert_eq!(j["adapter_revision"], ADAPTER_REVISION);
        assert_eq!(j["images"], 7);
        assert_eq!(j["output"], "/l/char_a_zimage.safetensors");
        // The runner reads every key the job has.
        for key in ["adapter_dir", "adapter_file", "adapter_repo", "adapter_revision", "images", "config", "work", "output"] {
            assert!(RUNNER.contains(&format!("job[\"{key}\"]")), "{key}");
        }
    }

    #[test]
    fn a_photo_is_staged_once_with_its_caption_and_garbage_is_turned_away() {
        let dir = tempfile::tempdir().unwrap();
        let set = dir.path().join("luxfox");
        let name = stage_in(&set, PNG, " luxfox, a photo of luxfox ").unwrap();
        assert!(name.ends_with(".png"));
        assert_eq!(std::fs::read(set.join(&name)).unwrap(), PNG);
        assert_eq!(std::fs::read_to_string(set.join(&name).with_extension("txt")).unwrap(), "luxfox, a photo of luxfox");
        assert_eq!(stage_in(&set, PNG, "x").unwrap(), name, "the same photo is the same file");
        assert_eq!(count_photos(&set), 1);
        stage_in(&set, &[0xFF, 0xD8, 0xFF, 0xE0, 1], "x").unwrap();
        assert_eq!(count_photos(&set), 2);
        assert!(stage_in(&set, b"", "x").unwrap_err().contains("empty"));
        assert!(stage_in(&set, b"#!/bin/sh", "x").unwrap_err().contains("PNG, JPG or WebP"));
        assert!(stage_in(&set, &vec![0u8; MAX_PHOTO_BYTES + 1], "x").unwrap_err().contains("40 MB"));
        // A photo without its caption is not one the engine trains on.
        std::fs::remove_file(set.join(&name).with_extension("txt")).unwrap();
        assert_eq!(count_photos(&set), 1);
    }

    #[test]
    fn a_set_name_cannot_leave_the_sets_folder() {
        let root = Path::new("/m");
        assert_eq!(set_dir(root, "../../evil").unwrap(), sets_root(root).join("evil"));
        assert!(set_dir(root, "///").is_err());
    }

    #[test]
    fn a_mac_below_the_floor_is_refused_and_one_that_cannot_be_read_is_not() {
        assert!(memory_refusal(16 * GIB).unwrap().contains(&format!("{MIN_RAM_GB} GB")));
        assert_eq!(memory_refusal(MIN_RAM_GB as u64 * GIB), None);
        assert_eq!(memory_refusal(48 * GIB), None);
        assert_eq!(memory_refusal(0), None);
    }

    #[test]
    fn the_progress_follows_the_phases_and_only_the_training_bar_counts_as_steps() {
        let runs = Runs::new();
        let _claim = runs.claim(Some("r".into()), "job", "luxfox").unwrap();
        runs.note("LU-TRAIN {\"phase\": \"adapter\"}");
        assert!(runs.view().phase.contains("340 MB"));
        // The bar of the adapter download is not the training.
        runs.note(" 50%|#####     | 170/340 [00:10<00:10, 17MB/s]");
        assert_eq!(runs.view().steps, 0);
        runs.note("LU-TRAIN {\"phase\": \"load\"}");
        runs.note("LU-TRAIN {\"phase\": \"encode\", \"done\": 3, \"total\": 10}");
        assert_eq!(runs.view().phase, "Reading the photos (4/10)");
        runs.note("  5%|▌         | 1/20 [00:09<03:02,  9.59s/it]");
        let v = runs.view().clone();
        assert_eq!((v.phase.as_str(), v.step, v.steps), ("Training", 1, 20));
        runs.note(" 45%|████▌     | 9/20 [00:58<01:07,  6.12s/it]");
        assert_eq!(runs.view().step, 9);
        assert!(runs.view().percent >= 10 && runs.view().percent < 99);
        runs.note("LU-TRAIN {\"phase\": \"error\", \"error\": \"ValueError: no\"}");
        assert_eq!(runs.view().error.as_deref(), Some("ValueError: no"));
        assert_eq!(runs.view().trigger.as_deref(), Some("luxfox"));
    }

    #[test]
    fn one_run_at_a_time_and_a_cancel_reaches_only_its_own() {
        let runs = Runs::new();
        let claim = runs.claim(Some("a".into()), "j1", "x").unwrap();
        assert!(runs.busy());
        assert!(runs.claim(None, "j2", "y").is_none());
        assert!(!runs.stop_run(Some("b")));
        assert!(runs.stop_run(Some("a")));
        drop(claim);
        assert!(!runs.busy());
        assert!(!runs.stop(), "nothing to stop");
    }

    #[cfg(unix)]
    #[test]
    fn how_a_run_ended_is_said_in_a_sentence() {
        use std::os::unix::process::ExitStatusExt;
        let ok = std::process::ExitStatus::from_raw(0);
        let failed = std::process::ExitStatus::from_raw(1 << 8);
        let killed = std::process::ExitStatus::from_raw(9);
        assert_eq!(outcome(Some(&ok), true, None, false), Ok(()));
        assert_eq!(outcome(Some(&ok), true, None, true).unwrap_err(), STOPPED);
        assert!(outcome(Some(&ok), false, None, false).unwrap_err().contains("without writing"));
        assert!(outcome(Some(&failed), false, Some("ValueError: x"), false).unwrap_err().contains("ValueError: x"));
        assert!(outcome(Some(&failed), false, None, false).unwrap_err().contains("exit code 1"));
        assert!(outcome(Some(&killed), false, None, false).unwrap_err().contains("ended by macOS"));
        assert_eq!(outcome(None, false, Some(HUNG), false).unwrap_err(), HUNG);
        assert!(outcome(None, false, None, false).unwrap_err().contains("twelve hours"));
    }

    #[test]
    fn a_progress_bar_is_read_as_done_of_total() {
        assert_eq!(bar_progress("  5%|▌         | 1/20 [00:09<03:02,  9.59s/it]"), Some((1, 20)));
        assert_eq!(bar_progress("  0%|          | 0/20 [00:00<?, ?it/s]"), Some((0, 20)));
        assert_eq!(bar_progress("Loading weights"), None);
    }

    #[test]
    fn only_a_leftover_run_of_this_folder_under_launchd_is_ended() {
        let runs = Path::new("/c/mflux/train-runs");
        let cmd = |job: &str| vec!["python".to_string(), "-u".into(), "-c".into(), "...".into(), JOB_FLAG.into(), job.into()];
        assert!(is_orphaned_run(&Leftover { parent: Some(1), cmd: cmd("/c/mflux/train-runs/j/job.json") }, runs));
        assert!(!is_orphaned_run(&Leftover { parent: Some(400), cmd: cmd("/c/mflux/train-runs/j/job.json") }, runs));
        assert!(!is_orphaned_run(&Leftover { parent: Some(1), cmd: cmd("/elsewhere/job.json") }, runs));
    }

    #[test]
    fn the_run_is_one_process_of_the_engine_with_its_caches_in_the_app() {
        let cmd = run_command(Path::new("/c/mflux"), Path::new("/c/mflux/train-runs/j"), Path::new("/c/mflux/train-runs/j/job.json"));
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(args[0], "-u");
        assert_eq!(&args[args.len() - 2..], [JOB_FLAG, "/c/mflux/train-runs/j/job.json"]);
        assert!(Path::new(cmd.get_program()).ends_with("venv-mflux/bin/python"));
        let hf = cmd.get_envs().find(|(k, _)| *k == "HF_HOME").and_then(|(_, v)| v).unwrap();
        assert!(!hf.to_string_lossy().contains(".cache/huggingface"));
    }

    #[test]
    fn nothing_that_loads_a_model_starts_beside_a_training() {
        let src = |file: &str, from: &str| -> String {
            let text = match file {
                "mlx" => include_str!("mlx.rs"),
                "music" => include_str!("music.rs"),
                "video" => include_str!("video.rs"),
                _ => include_str!("mlx_enhancer.rs"),
            };
            let at = text.find(from).unwrap_or_else(|| panic!("{from} in {file}"));
            text[at..at + 4000.min(text.len() - at)].to_string()
        };
        assert!(src("mlx", "pub async fn mlx_generate(").contains("train::refusal()"));
        assert!(src("mlx", "pub async fn mlx_upscale(").contains("train::refusal()"));
        assert!(src("enhancer", "pub(super) async fn enhance(").contains("train::refusal()"));
        assert!(src("music", "pub async fn music_generate(").contains("train::refusal()"));
        assert!(src("video", "pub fn video_generate(").contains("train::refusal()"));
        // And the training starts beside none of them.
        let start = &production()[production().find("pub async fn train_start").unwrap()..];
        let claim = start.find("RUNS\n        .claim(").unwrap();
        for before in ["image_engine_busy()", "music::busy()", "video_process()", "memory_refusal("] {
            assert!(start.find(before).unwrap() < claim, "{before}");
        }
        assert!(claim < start.find("mlx_unload(").unwrap());
    }

    #[test]
    fn quitting_and_starting_the_app_end_a_training() {
        assert!(include_str!("../state.rs").contains("crate::commands::mlx::train::stop();"));
        assert!(include_str!("../lib.rs").contains("commands::mlx::train::reap_orphaned_run()"));
    }
}
