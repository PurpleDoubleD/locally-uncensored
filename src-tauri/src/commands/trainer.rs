use crate::os_error;

// 2.5.8 — local character trainer (Character Studio, local lane).
//
// Trains a character LoRA fully on the user's GPU with kohya's musubi-tuner,
// pinned to tag v0.3.4, inside its OWN venv (never the ComfyUI one — torch
// versions must be free to diverge). Z-Image is the trained architecture:
// Apache-licensed base, the only image family whose 12 GB training path is
// community-proven, and its finished LoRA drops straight into
// ComfyUI/models/loras after the documented Diffusers conversion — the
// existing local LoRA chain picks it up with no extra wiring.
//
// Command surface (mirrors the whisper/tts installer contracts):
//   install_character_trainer(installPath?)  one-time env setup, streamed
//   character_trainer_status()               env + base-model readiness probe
//   stage_training_image(setId, name, bytes) stage one photo of the set
//   start_character_training{..}             cache -> train -> convert -> loras/
//   character_training_status()              run status + logs + step counter
//   cancel_character_training()              cooperative cancel + child kill
//
// Security stance: no user-supplied URLs anywhere — repo + tag are hardcoded,
// base models resolve only from known filenames inside LU-managed dirs, and
// the training-set id / names are sanitized before any path join.

use crate::state::AppState;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};
use tracing::info;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const MUSUBI_REPO: &str = "https://github.com/kohya-ss/musubi-tuner.git";
const MUSUBI_TAG: &str = "v0.3.4";

/// Known Z-Image training-base files, resolved by exact filename from the
/// trainer root's models dir or the active ComfyUI models tree.
/// Deliberately NOT the turbo checkpoint: musubi's own docs call turbo
/// training unstable and point to ostris' De-Turbo for that lane — and the
/// circulating NSFW full finetunes are ComfyUI-saved with a
/// `model.diffusion_model.` key prefix that musubi's strict loader rejects
/// (verified against zimage_model.py, 2026-07-18).
const DIT_CANDIDATES: &[&str] = &["z_image_bf16.safetensors", "z_image_de_turbo_v1_bf16.safetensors"];
const TE_CANDIDATES: &[&str] = &["qwen_3_4b.safetensors"];
const VAE_CANDIDATES: &[&str] = &["ae.safetensors"];

fn sanitize_component(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    cleaned.trim_matches('_').chars().take(48).collect()
}

/// Pick a file stem that doesn't clobber an existing photo in `dir`.
///
/// Sanitising kills the difference between real filenames — "foto (1).png" and
/// "foto [1].png" both become `foto__1_` — and the caption sidecar is keyed on
/// the stem alone. Writing blindly therefore replaced an earlier photo AND its
/// caption while the UI reported both as staged, so a set the user filled with
/// 20 pictures could silently train on 17. Re-staging the SAME bytes keeps the
/// same stem (an idempotent re-upload should not duplicate).
fn free_stem(dir: &Path, base: &str, ext: &str, bytes: &[u8]) -> String {
    let mut stem = base.to_string();
    for n in 2..=999u32 {
        let img = dir.join(format!("{stem}.{ext}"));
        let cap = dir.join(format!("{stem}.txt"));
        let same_photo = fs::read(&img).map(|b| b == bytes).unwrap_or(false);
        if same_photo || (!img.exists() && !cap.exists()) {
            return stem;
        }
        stem = format!("{base}_{n}");
    }
    stem
}

fn config_json_path() -> Option<PathBuf> {
    dirs::config_dir().map(|_| crate::os_paths::app_config_json())
}

fn read_config_value(key: &str) -> Option<String> {
    let path = config_json_path()?;
    let content = fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get(key)?.as_str().map(|s| s.to_string())
}

fn write_config_value(key: &str, value: &str) {
    let Some(path) = config_json_path() else { return };
    let _ = fs::create_dir_all(path.parent().unwrap_or(Path::new(".")));
    let mut json: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    json[key] = serde_json::json!(value);
    let _ = fs::write(&path, serde_json::to_string_pretty(&json).unwrap_or_default());
}

/// Trainer root: persisted override (config `trainer_root`) else
/// `<app_data>/musubi`. Layout: `<root>/venv`, `<root>/musubi-tuner`,
/// `<root>/models`, `<root>/train/<set_id>/...`.
fn trainer_root(app: &tauri::AppHandle) -> PathBuf {
    if let Some(p) = read_config_value("trainer_root") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("musubi")
}

fn venv_python(root: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    { root.join("venv").join("Scripts").join("python.exe") }
    #[cfg(not(target_os = "windows"))]
    { root.join("venv").join("bin").join("python") }
}

fn repo_dir(root: &Path) -> PathBuf {
    root.join("musubi-tuner")
}

fn push_log(state: &Arc<Mutex<crate::state::InstallState>>, msg: &str) {
    if let Ok(mut s) = state.lock() {
        s.logs.push(msg.to_string());
        if s.logs.len() > 400 {
            let cut = s.logs.len() - 400;
            s.logs.drain(0..cut);
        }
    }
}

fn set_status(state: &Arc<Mutex<crate::state::InstallState>>, status: &str, msg: &str) {
    if let Ok(mut s) = state.lock() {
        s.status = status.to_string();
        s.phase = msg.to_string();
        s.logs.push(msg.to_string());
    }
}

/// Resolve a base-model file by exact name: `<root>/models` first, then the
/// active ComfyUI models tree (so files pulled via the Model Manager count).
fn resolve_base_file(root: &Path, comfy_dir: Option<&Path>, names: &[&str], sub: &str) -> Option<PathBuf> {
    for n in names {
        let local = root.join("models").join(n);
        if local.exists() {
            return Some(local);
        }
        if let Some(c) = comfy_dir {
            let in_comfy = c.join("models").join(sub).join(n);
            if in_comfy.exists() {
                return Some(in_comfy);
            }
        }
    }
    None
}

fn active_comfy_dir(state: &AppState) -> Option<PathBuf> {
    let p = state.comfy_path.lock().ok()?.clone();
    p.map(PathBuf::from)
        .or_else(|| crate::commands::process::find_comfyui_path().map(PathBuf::from))
}

/// A piped python child on Windows encodes stdio with the legacy code page
/// (cp1252). The first Unicode character any tool prints then aborts the
/// whole run with "UnicodeEncodeError: 'charmap' codec can't encode" — in
/// practice the moment tqdm draws its block-glyph progress bar, which is
/// exactly when the train step finally has a step total. Force UTF-8 stdio
/// on every trainer child instead.
fn force_python_utf8(cmd: &mut Command) {
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");
}

/// cu121 wheels carry kernels up to sm_90 (Hopper). Blackwell reports
/// compute capability 12.x, so every RTX 50 card needs the cu128 build.
/// An unreadable probe keeps the cu121 default.
///
/// One entry each: the trainer is proven on exactly these two channels and a
/// silent hop to a neighbouring one would be a change nobody measured. The
/// slice shape exists so the ROCm branch, which has three living channels,
/// can share one plan type.
const TRAINER_CU128: &[&str] = &["https://download.pytorch.org/whl/cu128"];
const TRAINER_CU121: &[&str] = &["https://download.pytorch.org/whl/cu121"];

fn torch_index_for_cap(cap_major: Option<u32>) -> &'static [&'static str] {
    match cap_major {
        Some(major) if major >= 12 => TRAINER_CU128,
        _ => TRAINER_CU121,
    }
}

/// PyTorch's ROCm channels, which is what an AMD card needs instead of a CUDA
/// build. The list is shared with the ComfyUI installer and is walked live at
/// install time, newest first, so a channel that gets retired costs a probe
/// instead of a broken install. Re-read on 2026-08-28: there is still no
/// win_amd64 ROCm wheel in any of them, which is the whole reason the Windows
/// branch below refuses instead of downloading something.
use crate::commands::torch_wheels::ROCM_CHANNELS;

/// What the two pip steps should do about torch on THIS machine.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TorchPlan {
    /// Install from the first of these wheel indexes that answers, and say
    /// this while doing it. Never empty; the last entry is the fallback that
    /// gets used even when no probe answers.
    Wheels { candidates: &'static [&'static str], note: String },
    /// No wheel exists that could drive this GPU on this OS. Nothing is
    /// downloaded and the sentence is the whole answer.
    NoWheels(String),
}

/// Pure: which torch belongs on a machine, kept apart from the probes so the
/// decision is testable on any host.
///
/// The old rule was `torch_index_for_cap(detect_nvidia_compute_cap_major())`
/// and nothing else, so it only ever asked nvidia-smi. On numbrain's and
/// lapbo's AMD boxes that probe is silent, silence was read as "no GPU", and
/// the trainer installed the same CUDA wheels a machine with no card at all
/// gets. Those wheels import fine and see no device, so the environment
/// passed every check and the run died in step 1 with a raw CUDA traceback.
///
/// NVIDIA wins on a box that has both: it is the card that can actually
/// finish a run today.
pub(crate) fn trainer_torch_plan(
    has_nvidia: bool,
    nvidia_cap_major: Option<u32>,
    has_amd: bool,
    amd_names: &[&str],
    os: &str,
) -> TorchPlan {
    if has_nvidia || nvidia_cap_major.is_some() || !has_amd {
        let candidates = torch_index_for_cap(nvidia_cap_major);
        return TorchPlan::Wheels {
            candidates,
            note: format!(
                "GPU compute capability: {}, PyTorch wheels: {}",
                nvidia_cap_major.map_or("unknown".to_string(), |c| format!("{c}.x")),
                candidates[0],
            ),
        };
    }
    if os == "linux" {
        // The same brake 3570ce53 put on the ComfyUI path, from the same
        // source: the families measured as carried by no wheel install fine
        // and die at the first kernel, so the ROCm channels are 6.2 GB spent on
        // an environment that cannot finish a step (MEASURED 2026-08-31:
        // torch-2.13.0+rocm7.2-cp312 is 6,227,849,000 bytes on its own, and
        // torchvision and torchaudio come on top; the old note said 3 GB). ComfyUI can fall back to
        // the processor there; the trainer cannot, so its honest answer is the
        // one it already gives on Windows, which is to refuse before anything
        // is downloaded. Only cards we can NAME are held back, exactly as on
        // the ComfyUI side: a card we cannot place keeps the wheels.
        if crate::commands::torch_wheels::amd_fleet_coverage(amd_names, os)
            == crate::commands::torch_wheels::AmdCoverage::NoKernels
        {
            return TorchPlan::NoWheels(amd_uncovered_linux_refusal(amd_names));
        }
        return TorchPlan::Wheels {
            candidates: ROCM_CHANNELS,
            note: concat!(
                "AMD GPU detected, installing the ROCm build of PyTorch. ",
                "Honest limit: the training step runs an 8 bit optimizer that we ",
                "have only ever proven on CUDA, so this environment may still stop there.",
            )
            .to_string(),
        };
    }
    TorchPlan::NoWheels(amd_no_trainer_wheels_note(os))
}

/// The Linux refusal for a card no wheel carries kernels for: the measured fact
/// from `torch_wheels`, then what the TRAINER does about it, then the one
/// workaround, where it exists.
///
/// The consequence differs from ComfyUI's on purpose. ComfyUI keeps the
/// processor build, because a slow render still finishes. A LoRA run on the
/// processor does not, and the optimizer it uses is a CUDA build, so offering
/// it would be the same false promise the ROCm wheels are here.
fn amd_uncovered_linux_refusal(names: &[&str]) -> String {
    let mut note = format!(
        "{} Training on the processor is not a way out either: a LoRA run would take days \
         there, and the 8 bit optimizer the trainer uses has only ever been proven on CUDA. \
         So this machine needs an NVIDIA card, or an AMD card the ROCm wheels carry kernels \
         for, to train. Everything else in LU keeps running on your card, and nothing was \
         downloaded.",
        crate::commands::torch_wheels::AMD_UNCOVERED_GFX_FACT,
    );
    if let Some(hint) =
        crate::commands::torch_wheels::amd_rdna2_override_hint(names, "the trainer")
    {
        note.push(' ');
        note.push_str(&hint);
    }
    note
}

/// The refusal on an operating system pytorch.org publishes no ROCm wheels for.
///
/// The old text (2026-08-19) named the rocm6.2, rocm6.3, rocm6.4 and rocm7.0
/// channels, which have moved on, and it said there was no Windows ROCm PyTorch
/// at all. The first half is stale, the second half is wrong: the round 12
/// research found AMD publishing win_amd64 ROCm wheels from its own indexes,
/// and LU's ComfyUI installer uses one of them since 6d5dc61e. A customer who
/// reads ComfyUI's README finds that channel in a minute, so a refusal that
/// denies it exists loses the whole answer. What is still true is the reason
/// the TRAINER does not go there.
fn amd_no_trainer_wheels_note(os: &str) -> String {
    let head = "Training a character needs a PyTorch build that can drive your AMD card, \
                and pytorch.org publishes those for Linux only (checked 2026-08-30: every \
                wheel in the rocm7.2, rocm7.1 and rocm6.4 channels is a Linux wheel).";
    let tail = "ZLUDA does not close the gap either, it stands in for the CUDA runtime and \
                not for the CUDA PyTorch build. So this machine needs an NVIDIA card or \
                Linux with ROCm to train. Everything else in LU keeps running on your AMD \
                card, and nothing was downloaded.";
    if os == "windows" {
        format!(
            "{head} AMD publishes its own Windows ROCm wheels, and LU installs those for \
             ComfyUI on the RDNA 3, 3.5 and 4 cards AMD publishes them for, but the trainer \
             does not use them: the training step runs an 8 bit optimizer that exists as a \
             CUDA build only, so the environment would install and then stop at exactly \
             that step. {tail}"
        )
    } else {
        format!("{head} {tail}")
    }
}

/// Which vendors this machine actually has, from the same probe the hardware
/// picker uses, so a card that shows up in Settings is a card the trainer
/// knows about. That probe already survives a missing rocm-smi, which is the
/// only reason an AMD card is visible here at all.
fn gpu_vendors_present() -> (bool, bool) {
    crate::commands::torch_wheels::gpu_vendors_present()
}

/// The card a training run would use, as a name for messages. None means the
/// machine really has no GPU, which is the only case where a torch that sees
/// no device is normal rather than wrong.
fn training_gpu_label() -> Option<&'static str> {
    match gpu_vendors_present() {
        (true, _) => Some("NVIDIA"),
        (false, true) => Some("AMD"),
        (false, false) => None,
    }
}

/// Every site-packages of the trainer venv. Windows puts one at
/// `venv/Lib/site-packages`, POSIX one per python version under `venv/lib`.
fn site_packages_dirs(root: &Path) -> Vec<PathBuf> {
    let venv = root.join("venv");
    let mut dirs = vec![venv.join("Lib").join("site-packages")];
    if let Ok(entries) = fs::read_dir(venv.join("lib")) {
        dirs.extend(entries.filter_map(Result::ok).map(|e| e.path().join("site-packages")));
    }
    dirs.into_iter().filter(|d| d.is_dir()).collect()
}

/// venv + repo on disk proved nothing: an aborted torch download passed as
/// "ready" and died in the first training step. The cheapest honest signal
/// is torch's package marker inside the venv's site-packages.
fn torch_installed(root: &Path) -> bool {
    site_packages_dirs(root)
        .iter()
        .any(|d| d.join("torch").join("version.py").exists())
}

/// The trainer package itself, which "venv + repo + torch" never covered:
/// sockenmonster's install died after torch and before `pip install -e .`, so
/// the studio called the environment ready and every run hit
/// `No module named musubi_tuner`. Installed editable, so the marker is a
/// dist-info directory or the `__editable__` .pth pip drops next to it. File
/// names only, no python spawn, because this runs on every status poll.
fn musubi_installed(root: &Path) -> bool {
    site_packages_dirs(root).iter().any(|d| {
        d.join("musubi_tuner").is_dir()
            || fs::read_dir(d).map(|entries| {
                entries.filter_map(Result::ok).any(|e| {
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    name.starts_with("musubi_tuner-") || name.contains("__editable__.musubi_tuner")
                })
            }).unwrap_or(false)
    })
}

/// Runs inside the trainer venv. Keep the printed markers in sync with
/// preflight_verdict below. The trainer package is probed with find_spec
/// rather than a real import: importing it pulls the whole training stack and
/// would turn a cheap check into seconds of work and a second CUDA context.
const TORCH_PREFLIGHT_PY: &str = "import importlib.util\nimport torch\nprint('TORCH_OK', torch.__version__)\ncuda = torch.cuda.is_available()\nprint('CUDA', '1' if cuda else '0')\nif cuda:\n    cap = torch.cuda.get_device_capability(0)\n    print('CAP', cap[0], cap[1])\n    print('ARCHS', ' '.join(torch.cuda.get_arch_list()))\nif importlib.util.find_spec('musubi_tuner') is not None:\n    print('MUSUBI_OK')\n";

/// What the preflight found. Four failure classes that all used to surface as
/// a raw error deep inside the run: torch not importable (half install), a
/// torch build whose kernel list stops below the GPU's compute capability
/// (cu121 on Blackwell, which imports fine and even reports CUDA as
/// available), a torch that reaches no card at all on a machine that has one
/// (the CUDA wheels an AMD box used to be handed), and the trainer package
/// missing (an install that died after torch). Each one is repairable, which
/// is why they are distinguished rather than collapsed into one error string.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Preflight {
    Ok,
    TorchBroken(String),
    KernelsTooOld { cap: u32, max: u32 },
    /// torch imports, runs, and reports no device at all on a machine that
    /// has a card. A CUDA build on an AMD box does exactly this. It used to
    /// pass the check as an ordinary processor only environment and then die
    /// in step 1 with whatever traceback the training script produced.
    GpuUnreachable { vendor: String },
    PackageMissing,
}

impl Preflight {
    pub(crate) fn is_ok(&self) -> bool {
        matches!(self, Preflight::Ok)
    }

    /// A torch that is there but wrong has to be pushed out of the way, which
    /// is the kernel gap and the card it cannot reach; the other two classes
    /// install into what is missing.
    pub(crate) fn needs_torch_reinstall(&self) -> bool {
        matches!(
            self,
            Preflight::TorchBroken(_)
                | Preflight::KernelsTooOld { .. }
                | Preflight::GpuUnreachable { .. }
        )
    }

    /// What the customer can actually DO once the automatic repair has failed
    /// too. `message()` is a diagnosis on purpose, and a diagnosis on its own
    /// left them with a pip log tail and nothing to press: the pre-A2 text
    /// ended with "Run the trainer install again from Character Studio" and
    /// nothing replaced it.
    ///
    /// All three classes end in the same place, pip could not get the right
    /// files into the venv, and the two things that stop it are the network
    /// and the disk. So name both, then the one button that runs the whole
    /// install again. The button is guaranteed to be on screen by then:
    /// `trainer_env_broken` forces envReady false after a failed repair.
    pub(crate) fn next_step(&self) -> &'static str {
        match self {
            Preflight::Ok => "",
            _ => "Check that you are online and that the drive has room (the environment needs about 3 GB), then press Set up trainer in Character Studio to install it again.",
        }
    }

    pub(crate) fn message(&self) -> String {
        match self {
            Preflight::Ok => String::new(),
            Preflight::TorchBroken(tail) => format!(
                "PyTorch is missing or broken in the trainer environment. ({tail})"
            ),
            Preflight::KernelsTooOld { cap, max } => format!(
                "This PyTorch build has no kernels for your GPU (compute capability {cap}.x, the build stops at {max}.x). An RTX 50 card on the old cu121 build does exactly this."
            ),
            Preflight::GpuUnreachable { vendor } => format!(
                "The PyTorch in the trainer environment cannot see your {vendor} card, it reports no usable GPU. That is a wrong build for this machine, not a driver fault."
            ),
            Preflight::PackageMissing => {
                "The trainer package (musubi_tuner) is not installed in the trainer environment.".to_string()
            }
        }
    }
}

/// pip never deletes an installation before it replaces it. It moves the old
/// files aside and only drops them once the new ones are in place, so a torch
/// reinstall wants roughly 7 GB free even though torch itself is 4.27 GB, and
/// the last twelve log lines of a run that ran out are all `Moving to ...` with
/// the sentence that matters buried above them. Measured on the box on
/// 2026-08-15: the repair died with `[Errno 28] No space left on device` on a
/// drive that had 5.8 GB free, while our own next step said 3 GB.
const DISK_NEXT_STEP: &str = "The drive ran out of room. Free up about 7 GB (a PyTorch reinstall needs space for both copies while it swaps them), then press Set up trainer in Character Studio.";

/// The disk-full wording pip and the OS use, on either platform.
pub(crate) fn out_of_disk(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    t.contains("no space left on device")
        || t.contains("errno 28")
        || t.contains("not enough space on the disk")
        || t.contains("enough free space")
}

/// The last three lines that say something, with pip's rollback noise dropped.
pub(crate) fn useful_tail(text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| {
            !l.is_empty()
                && !l.starts_with("Moving to ")
                && !l.starts_with("Removing file or directory")
        })
        .collect();
    if lines.is_empty() {
        return "no detail in the log".to_string();
    }
    lines[lines.len().saturating_sub(3)..].join(" | ")
}

/// The dead ends that are neither the network nor the disk, and that the one
/// generic step sent people to look in the wrong place for. A2 stage one
/// (aikabatzu, aldrich_ironhart, Z0mbieK, Discord and GH #121, 2026-08-27 and
/// 2026-08-29): "Setting up the trainer environment failed. Check that you are
/// online" while online, with the firewall off, confirmed by a second user.
///
/// Windows and the rest get different sentences, because the Visual C++
/// Redistributable does not exist off Windows and sending a Linux user to
/// microsoft.com is the same class of mistake as sending an online user to
/// their router. Both texts compile everywhere and the OS is a parameter, the
/// way `torch_wheels` does it, so a Mac can test the Windows wording.
const WINDOWS_REDIST_NEXT_STEP: &str = "A Microsoft Visual C++ runtime library is missing, and PyTorch cannot load without it. Install the current Visual C++ Redistributable for x64 from https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist, restart Windows, then press Set up trainer in Character Studio.";
const UNIX_LIBRARY_NEXT_STEP: &str = "A system library PyTorch loads is missing on this machine; the log line above names the file. Install it with your package manager, then press Set up trainer in Character Studio.";
const WINDOWS_NATIVE_NEXT_STEP: &str = "PyTorch is on disk but its native libraries will not load. Install the current Visual C++ Redistributable for x64 from https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist, update the graphics driver, restart Windows, then press Set up trainer in Character Studio.";
const UNIX_NATIVE_NEXT_STEP: &str = "PyTorch is on disk but its native libraries will not load. Update the graphics driver and the system libraries, restart the machine, then press Set up trainer in Character Studio.";
/// A wrong wheel, not a broken machine. The setup probes the card again, so it
/// is the same button and a completely different reason.
const WHEEL_NEXT_STEP: &str = "The PyTorch that was installed carries no support for the card in this machine, so it can only run on the processor. Press Set up trainer in Character Studio: the setup probes the card again and picks the matching wheel.";
const PYTHON_VERSION_NEXT_STEP: &str = "No wheel exists for the Python version LU is using here. Install Python 3.10, 3.11 or 3.12 from python.org with 'Add to PATH' checked, then press Set up trainer in Character Studio.";
const PERMISSION_NEXT_STEP: &str = "The installer was not allowed to write into the Python folder. Close every open Python, Jupyter or IDE debugger, and if that changes nothing, install Python for your own user instead of for all users, then press Set up trainer in Character Studio.";
const PEP668_NEXT_STEP: &str = "This Python refuses installs outside a virtual environment and the venv module is missing. Install it from your package manager (python3-venv on Debian and Ubuntu, python-virtualenv on Arch, python3-virtualenv on Fedora), then press Set up trainer in Character Studio.";

/// The way out that fits what actually failed, on the platform it failed on.
/// The old code offered exactly one, "check that you are online and that the
/// drive has room", for every failure class there is.
pub(crate) fn next_step_for_log(log: &str, fallback: &'static str, os: &str) -> &'static str {
    use crate::commands::install::pip::PipFailureKind as K;
    let windows = os == "windows";
    if out_of_disk(log) {
        return DISK_NEXT_STEP;
    }
    match crate::commands::install::pip::pip_failure_kind(log) {
        K::MissingRuntimeLibrary => {
            if windows { WINDOWS_REDIST_NEXT_STEP } else { UNIX_LIBRARY_NEXT_STEP }
        }
        K::NativeLoadFailure => {
            if windows { WINDOWS_NATIVE_NEXT_STEP } else { UNIX_NATIVE_NEXT_STEP }
        }
        K::TorchWithoutGpuSupport => WHEEL_NEXT_STEP,
        K::NoMatchingWheel => PYTHON_VERSION_NEXT_STEP,
        K::Permission => PERMISSION_NEXT_STEP,
        K::ExternallyManaged => PEP668_NEXT_STEP,
        K::DiskFull => DISK_NEXT_STEP,
        // Network failures and everything we cannot name keep the old text.
        // Naming the network for a failure that is not one is the whole bug.
        _ => fallback,
    }
}

/// One shape for every dead end in the trainer environment: what is wrong, what
/// to press, and a short tail that says why. In that order, because the user
/// reads the first sentence and the last one.
///
/// Before this, a repair that never finished put the raw process error into the
/// status line instead, which on a full disk meant fifteen `Moving to ...`
/// lines and no next step at all.
pub(crate) fn env_failure_message(diagnosis: &str, fallback_step: &'static str, log: &str) -> String {
    let step = next_step_for_log(log, fallback_step, std::env::consts::OS);
    let head = diagnosis.trim();
    let head = if head.is_empty() { String::new() } else { format!("{head} ") };
    format!("{head}{step} Last steps: {}", useful_tail(log))
}

/// The whole terminal message after a repair that did not take.
pub(crate) fn repair_failed_message(after: &Preflight, tail: &str) -> String {
    env_failure_message(
        &format!("{} The automatic repair did not fix it.", after.message()),
        after.next_step(),
        tail,
    )
}

/// An error that is already a finished sentence with its own way out. Wrapping
/// it would bury that way out under a generic one and quote it back as a log
/// tail. `no_base_python_message` is the only such case today, and it points at
/// a different button than every other failure here.
fn already_explained(err: &str) -> bool {
    err.contains("Install Python in Settings")
        // The AMD refusal is the second one: it names the OS wall, says that
        // nothing was downloaded, and pointing at Set up trainer would only
        // walk the customer into the same wall again.
        || err.contains("needs an NVIDIA card or Linux with ROCm")
        // Third one, round 13: the Linux card no ROCm wheel carries kernels
        // for. Same shape, same reason to be left alone, and a different
        // sentence, so it needs its own marker.
        || err.contains("no official ROCm wheel carries kernels")
}

/// The repair stopped before it even finished. Same dead end for the customer
/// as one that finished and did not take, so it gets the same shape.
pub(crate) fn repair_aborted_message(before: &Preflight, err: &str) -> String {
    if already_explained(err) {
        return err.to_string();
    }
    env_failure_message(
        &format!("{} The automatic repair stopped before it finished.", before.message()),
        before.next_step(),
        err,
    )
}

/// The Set up button itself failing. No preflight verdict exists on that path,
/// the environment is simply not there yet.
pub(crate) fn install_failed_message(err: &str) -> String {
    if already_explained(err) {
        return err.to_string();
    }
    env_failure_message(
        "Setting up the trainer environment failed.",
        Preflight::PackageMissing.next_step(),
        err,
    )
}

/// `gpu` is the card a run would use ("NVIDIA" / "AMD"), or None when the
/// machine really has none. Without it a torch that sees no device is
/// indistinguishable from a legitimate processor only environment, which is
/// the hole numbrain's and lapbo's AMD boxes fell through.
fn preflight_verdict(exit_ok: bool, stdout: &str, stderr: &str, gpu: Option<&str>) -> Preflight {
    if !exit_ok || !stdout.contains("TORCH_OK") {
        let tail = stderr
            .lines()
            .map(str::trim).rfind(|l| !l.is_empty())
            .unwrap_or("no detail from python")
            .to_string();
        return Preflight::TorchBroken(tail);
    }
    let mut cap_major: Option<u32> = None;
    let mut arch_max: Option<u32> = None;
    for line in stdout.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("CAP ") {
            cap_major = rest.split_whitespace().next().and_then(|v| v.parse().ok());
        } else if let Some(rest) = l.strip_prefix("ARCHS ") {
            for arch in rest.split_whitespace() {
                // CUDA names only. A ROCm build lists gfx1030 and gfx90a, and
                // the old expression stripped every non digit and dropped the
                // last one, which reads gfx1030 as 103 and gfx90a as 9. Those
                // are not compute capabilities, so comparing one against them
                // is meaningless in both directions.
                let Some(num) = arch
                    .strip_prefix("sm_")
                    .or_else(|| arch.strip_prefix("compute_"))
                else {
                    continue;
                };
                let digits: String = num.chars().take_while(char::is_ascii_digit).collect();
                if digits.len() >= 2 {
                    if let Ok(n) = digits[..digits.len() - 1].parse::<u32>() {
                        arch_max = Some(arch_max.map_or(n, |p| p.max(n)));
                    }
                }
            }
        }
    }
    // Asked before the kernel question, because a torch that reaches no card
    // at all cannot have a kernel gap: there is no CAP line to compare with.
    let sees_a_device = cap_major.is_some() || stdout.contains("CUDA 1");
    if let (Some(vendor), false) = (gpu, sees_a_device) {
        return Preflight::GpuUnreachable { vendor: vendor.to_string() };
    }
    if let (Some(cap), Some(max)) = (cap_major, arch_max) {
        if cap > max {
            return Preflight::KernelsTooOld { cap, max };
        }
    }
    if !stdout.contains("MUSUBI_OK") {
        return Preflight::PackageMissing;
    }
    Preflight::Ok
}

/// Run one child to completion, streaming stdout+stderr lines into the run
/// state. Registers the child pid so cancel can kill it. Returns Err on
/// non-zero exit (with the last stderr lines) or on cancel.
fn run_streamed(
    mut cmd: Command,
    label: &str,
    run: &Arc<Mutex<crate::state::InstallState>>,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
    pid_slot: &Arc<Mutex<Option<u32>>>,
) -> Result<(), String> {
    force_python_utf8(&mut cmd);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{label} could not start: {}", os_error::english(&e)))?;
    // The trainer is the longest lived and most VRAM hungry child the app
    // spawns. `shutdown_subprocesses` kills it on a clean quit; the job object
    // covers the quits that never reach that code.
    crate::commands::process::tie_child_to_app_lifetime(child.id());
    if let Ok(mut slot) = pid_slot.lock() {
        *slot = Some(child.id());
    }

    let tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();
    for stream in [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let run = run.clone();
        let tail = tail.clone();
        handles.push(std::thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines().map_while(Result::ok) {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                // Step counter for the UI meter: musubi/tqdm emit
                // "steps: NN%|...| 123/1600 [...]" style lines.
                if let Some((cur, total)) = parse_step_counter(trimmed) {
                    if let Ok(mut s) = run.lock() {
                        s.download_progress = cur;
                        s.download_total = total;
                    }
                }
                if let Ok(mut t) = tail.lock() {
                    t.push(trimmed.to_string());
                    if t.len() > 12 {
                        t.remove(0);
                    }
                }
                push_log(&run, trimmed);
            }
        }));
    }

    let exit = loop {
        if cancel.load(Ordering::SeqCst) {
            // The whole tree, not just this child: accelerate spawns the
            // trainer underneath and `Child::kill` never reaches it.
            kill_trainer_tree(child.id());
            let _ = child.wait();
            // The reader threads are deliberately NOT joined here. They sit in
            // read() on a pipe that every surviving grandchild still holds
            // open, so the join blocked forever and the cancel never returned:
            // the run stayed on "running" with the card busy and no way left
            // to stop it. They end by themselves once the pipe closes.
            return Err("cancelled".to_string());
        }
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(300)),
            Err(e) => {
                return Err(format!("{label} wait failed: {}", os_error::english(&e)))
            }
        }
    };
    for h in handles {
        let _ = h.join();
    }
    if let Ok(mut slot) = pid_slot.lock() {
        *slot = None;
    }
    if exit.success() {
        Ok(())
    } else {
        let last = tail
            .lock()
            .map(|t| t.join("\n"))
            .unwrap_or_default();
        Err(format!("{label} failed (exit {:?}).\n{last}", exit.code()))
    }
}

/// Pull "123/1600" out of a tqdm-ish progress line.
pub fn parse_step_counter(line: &str) -> Option<(u64, u64)> {
    // Cheap scan without regex: find "N/M" where both sides are digits and M
    // looks like a step total (>= 10, filters version strings like 2/3).
    let bytes = line.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b != b'/' {
            continue;
        }
        let left_start = line[..i]
            .rfind(|c: char| !c.is_ascii_digit())
            .map(|p| p + 1)
            .unwrap_or(0);
        let right_end = line[i + 1..]
            .find(|c: char| !c.is_ascii_digit())
            .map(|p| i + 1 + p)
            .unwrap_or(line.len());
        if left_start >= i || right_end <= i + 1 {
            continue;
        }
        if let (Ok(cur), Ok(total)) = (line[left_start..i].parse::<u64>(), line[i + 1..right_end].parse::<u64>()) {
            if total >= 10 && cur <= total {
                return Some((cur, total));
            }
        }
    }
    None
}

// ── one-time environment install ─────────────────────────────────────────────

#[allow(non_snake_case)]
#[tauri::command]
pub fn install_character_trainer(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    installPath: Option<String>,
) -> Result<serde_json::Value, String> {
    {
        let mut st = state.trainer_install.lock().unwrap();
        if st.status == "installing" {
            return Ok(serde_json::json!({"status": "already_installing"}));
        }
        st.status = "installing".to_string();
        st.logs.clear();
        st.logs.push("Setting up the local character trainer...".to_string());
    }
    info!("character trainer install start");

    if let Some(p) = installPath.as_deref() {
        if !p.trim().is_empty() {
            write_config_value("trainer_root", p.trim());
        }
    }
    let root = trainer_root(&app);
    let python_bin = state.python_bin.lock().unwrap().clone();
    if python_bin.is_empty() || !crate::python::is_real_python(&python_bin) {
        set_status(
            &state.trainer_install,
            "error",
            "No usable Python found. Install Python first (Settings), then retry.",
        );
        return Err("no_python".to_string());
    }

    let install = state.trainer_install.clone();
    let cancel = state.trainer_cancel.clone();
    let pid_slot = state.trainer_process.clone();
    let env_broken = state.trainer_env_broken.clone();
    cancel.store(false, Ordering::SeqCst);

    std::thread::spawn(move || {
        match provision_trainer_env(&root, &python_bin, false, &install, "installing", &cancel, &pid_slot) {
            Ok(()) => {
                env_broken.store(false, Ordering::SeqCst);
                set_status(&install, "complete", "Trainer environment ready.")
            }
            Err(e) if e == "cancelled" => set_status(&install, "cancelled", &e),
            Err(e) => {
                // Same reason as on the repair path: the raw process error is
                // pip's rollback log, and the sentence that matters is above
                // it. And the environment is provably not ready, so say so.
                env_broken.store(true, Ordering::SeqCst);
                set_status(&install, "error", &install_failed_message(&e));
            }
        }
    });

    Ok(serde_json::json!({"status": "installing"}))
}

/// What has to happen to `<root>/venv` before the two pip steps can use it.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum VenvAction {
    Keep,
    Create,
    Rebuild,
}

/// Presence is not health, and the old check only asked about presence.
///
/// On Windows `venv\Scripts\python.exe` is a real copied binary. Upgrade
/// Python 3.11 to 3.13 and uninstall the old one and that file is still there,
/// still passes `exists()`, and dies on every start with a fatal
/// init_fs_encoding error because pyvenv.cfg points at a home that is gone.
/// The repair path then skipped step 2 (the venv was "there"), drove steps 3
/// and 4 with the dead interpreter, and reported "torch install failed", which
/// names neither the cause nor a way out. Worse, `start_character_training`
/// refuses to even reach the repair unless that same file exists, so on the
/// repair path the old guard could never once be true. On POSIX the identical
/// venv healed itself by accident: `venv/bin/python` is a symlink, and
/// `exists()` follows it, so a dead base made the check false.
///
/// The question is therefore whether the interpreter RUNS.
pub(crate) fn venv_action(python_exists: bool, python_starts: bool) -> VenvAction {
    match (python_exists, python_starts) {
        (false, _) => VenvAction::Create,
        (true, false) => VenvAction::Rebuild,
        (true, true) => VenvAction::Keep,
    }
}

/// `python -m venv` arguments for the action. A rebuild has to CLEAR: keeping
/// the directory would keep a site-packages built for the interpreter that
/// just died, and pip would then repair on top of metadata for a Python
/// version that is no longer installed.
pub(crate) fn venv_create_args(action: VenvAction) -> &'static [&'static str] {
    match action {
        VenvAction::Rebuild => &["-m", "venv", "--clear"],
        _ => &["-m", "venv"],
    }
}

/// Why we are stopping when there is no system Python to build with. A rebuild
/// deletes the old venv, so it must never start without one: leaving the
/// customer with no environment at all is worse than the broken one they had.
pub(crate) fn no_base_python_message(action: VenvAction) -> String {
    let why = if action == VenvAction::Rebuild {
        "The trainer environment is still there but its Python does not start any more (the Python it was built from was moved, upgraded or removed), and rebuilding it needs a working Python on this machine."
    } else {
        "Setting up the trainer needs a working Python on this machine."
    };
    format!("{why} Install Python in Settings, then start this again.")
}

/// Cheapest honest check that an interpreter is usable: start it and let it
/// exit immediately. A venv python whose base is gone never reaches the code,
/// it aborts during interpreter init, so a non-zero exit is the answer.
fn python_starts(exe: &Path) -> bool {
    let mut cmd = Command::new(exe);
    cmd.args(["-c", "pass"]);
    force_python_utf8(&mut cmd);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

/// The four install steps, idempotent by design: an existing checkout and a
/// WORKING venv are kept, the two pip steps always run. One function because
/// the training run repairs its own environment with it (A2), and a repair
/// that drifted from the install would be a second, untested installer.
///
/// It only ever writes into `<root>/venv` and `<root>/musubi-tuner`. The
/// customer's datasets (`<root>/train`) and the multi-GB base models
/// (`<root>/models`) are never touched, which is why repair can run
/// unattended in the middle of a training start.
///
/// `status_kind` is the status the caller's state machine uses ("installing"
/// for the Set up button, "running" for a repair inside a training run) so
/// neither surface sees a status it cannot render.
#[allow(clippy::too_many_arguments)]
fn provision_trainer_env(
    root: &Path,
    python_bin: &str,
    repairing: bool,
    state: &Arc<Mutex<crate::state::InstallState>>,
    status_kind: &str,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
    pid_slot: &Arc<Mutex<Option<u32>>>,
) -> Result<(), String> {
    let tag = if repairing { "Repairing the trainer environment" } else { "Setting up the trainer" };

    // Decided first, before a clone, a venv and 2.5 GB of wheels: a machine
    // whose card has no PyTorch build should not have to pay for all of that
    // to find out. The probe is the vendor list, not nvidia-smi alone, which
    // is what left numbrain and lapbo indistinguishable from a machine with
    // no GPU at all.
    // The card NAMES come along now, because the wheel question is no longer
    // "AMD yes or no": on Linux the answer depends on the family, and the name
    // is the only thing any probe here reports (round 12, torch_wheels.rs).
    let (has_nvidia, has_amd, amd_names) = crate::commands::torch_wheels::gpu_vendor_facts();
    let amd_names: Vec<&str> = amd_names.iter().map(String::as_str).collect();
    let cap = crate::commands::install::detect_nvidia_compute_cap_major();
    let (candidates, wheel_note) =
        match trainer_torch_plan(has_nvidia, cap, has_amd, &amd_names, std::env::consts::OS) {
            TorchPlan::Wheels { candidates, note } => (candidates, note),
            TorchPlan::NoWheels(why) => return Err(why),
        };
    // The channel is picked here and not inside the plan: the plan stays a
    // pure function the tests can drive, and only the real install pays for a
    // network probe.
    let torch_index = crate::commands::torch_wheels::first_live_index(
        candidates,
        crate::commands::torch_wheels::index_serves_torch,
    )
    .unwrap_or(candidates[0]);
    let wheel_note = format!("{wheel_note} (wheel index: {torch_index})");

    let _ = fs::create_dir_all(root.join("models"));

    // 1) pinned clone (releases are the project's own stability advice)
    if !repo_dir(root).join(".git").exists() {
        set_status(state, status_kind, &format!("{tag} (1/4): getting musubi tuner {MUSUBI_TAG}..."));
        let mut clone = Command::new("git");
        clone.args(["clone", "--branch", MUSUBI_TAG, "--depth", "1", MUSUBI_REPO])
            .arg(repo_dir(root));
        run_streamed(clone, "git clone", state, cancel, pid_slot)?;
    } else {
        push_log(state, "musubi tuner already present, keeping the pinned checkout.");
    }

    // 2) venv. Asked as "does its python run", not "is the file there": see
    // venv_action. A dead venv is exactly the state a repair is called for,
    // and it used to be the one state this step could not fix.
    let vpy_path = venv_python(root);
    let exists = vpy_path.exists();
    let action = venv_action(exists, exists && python_starts(&vpy_path));
    if action != VenvAction::Keep {
        // A rebuild deletes what is there, so it may only start once we know
        // there is something to rebuild WITH. is_real_python filters the
        // Windows Store stub; starting it is what proves the interpreter the
        // user still has is the one this venv lost.
        let base = Path::new(python_bin);
        if !crate::python::is_real_python(python_bin) || !python_starts(base) {
            return Err(no_base_python_message(action));
        }
        if action == VenvAction::Rebuild {
            push_log(state, "The trainer environment is there but its Python does not start any more. Rebuilding it from scratch, your training images and base models are left alone.");
        }
        set_status(state, status_kind, &format!("{tag} (2/4): creating the training environment (venv)..."));
        let mut venv = Command::new(python_bin);
        venv.args(venv_create_args(action)).arg(root.join("venv"));
        run_streamed(venv, "venv create", state, cancel, pid_slot)?;
    }
    let vpy = venv_python(root).to_string_lossy().to_string();

    // 3) torch, from the channel the plan above picked: Blackwell gets cu128,
    // every other NVIDIA card keeps cu121, an AMD card on Linux gets ROCm.
    set_status(state, status_kind, &format!("{tag} (3/4): installing PyTorch into the trainer venv (~2.5 GB, one time)..."));
    push_log(state, &wheel_note);
    let mut torch = Command::new(&vpy);
    let mut torch_args = vec!["-m", "pip", "install", "--progress-bar", "off", "--no-input"];
    // A finished but WRONG torch satisfies pip and would never be replaced:
    // cu121 on a Blackwell box, or the half install a repair was called for.
    if cap.is_some_and(|c| c >= 12) || repairing {
        torch_args.push("--force-reinstall");
    }
    torch_args.extend(["torch", "torchvision", "--index-url", torch_index]);
    torch.args(&torch_args);
    run_streamed(torch, "torch install", state, cancel, pid_slot)?;

    // 4) musubi + deps
    set_status(state, status_kind, &format!("{tag} (4/4): installing the trainer package..."));
    let mut pkg = Command::new(&vpy);
    pkg.args(["-m", "pip", "install", "--progress-bar", "off", "--no-input", "-e", "."])
        .current_dir(repo_dir(root));
    run_streamed(pkg, "musubi install", state, cancel, pid_slot)?;
    Ok(())
}

#[tauri::command]
pub fn character_trainer_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let root = trainer_root(&app);
    let comfy = active_comfy_dir(state.inner());
    // File presence only, plus the one thing files cannot tell us. A torch
    // that is on disk but will not import passes every check above, so before
    // trainer_env_broken existed the Set up button stayed hidden in exactly
    // the state that needs it, and the run's error pointed at a button the
    // user could not see.
    let env_ready = venv_python(&root).exists()
        && repo_dir(&root).join("src").exists()
        && torch_installed(&root)
        && musubi_installed(&root)
        && !state.trainer_env_broken.load(Ordering::SeqCst);
    let dit = resolve_base_file(&root, comfy.as_deref(), DIT_CANDIDATES, "diffusion_models");
    let te = resolve_base_file(&root, comfy.as_deref(), TE_CANDIDATES, "text_encoders");
    let vae = resolve_base_file(&root, comfy.as_deref(), VAE_CANDIDATES, "vae");
    let install = state.trainer_install.lock().unwrap();
    Ok(serde_json::json!({
        "envReady": env_ready,
        "basesReady": dit.is_some() && te.is_some() && vae.is_some(),
        "dit": dit.map(|p| p.to_string_lossy().to_string()),
        "textEncoder": te.map(|p| p.to_string_lossy().to_string()),
        "vae": vae.map(|p| p.to_string_lossy().to_string()),
        "root": root.to_string_lossy().to_string(),
        "install": { "status": install.status, "logs": install.logs },
    }))
}

// ── training-set staging ─────────────────────────────────────────────────────

#[allow(non_snake_case)]
#[tauri::command]
pub fn stage_training_image(
    app: tauri::AppHandle,
    setId: String,
    filename: String,
    fileBytes: Vec<u8>,
    caption: String,
) -> Result<serde_json::Value, String> {
    let set = sanitize_component(&setId);
    let name = sanitize_component(filename.trim_end_matches(|c: char| c.is_ascii_alphanumeric()).trim_end_matches('.'));
    if set.is_empty() {
        return Err("invalid set id".to_string());
    }
    let ext = Path::new(&filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "webp"].contains(&ext.as_str()) {
        return Err("unsupported image type (png, jpg, webp)".to_string());
    }
    if fileBytes.is_empty() || fileBytes.len() > 40 * 1024 * 1024 {
        return Err("image is empty or larger than 40 MB".to_string());
    }
    let img_dir = trainer_root(&app).join("train").join(&set).join("img");
    fs::create_dir_all(&img_dir).map_err(|e| format!("could not create the set dir: {}", os_error::english(&e)))?;
    let base = if name.is_empty() { format!("photo_{}", fileBytes.len() % 100000) } else { name };
    let stem = free_stem(&img_dir, &base, &ext, &fileBytes);
    fs::write(img_dir.join(format!("{stem}.{ext}")), &fileBytes)
        .map_err(|e| format!("could not write the photo: {}", os_error::english(&e)))?;
    // Caption sidecar: trigger word comes first — musubi has no trigger
    // mechanism of its own, the token must live in every caption.
    fs::write(img_dir.join(format!("{stem}.txt")), caption.trim())
        .map_err(|e| format!("could not write the caption: {}", os_error::english(&e)))?;
    Ok(serde_json::json!({"staged": format!("{stem}.{ext}")}))
}

#[allow(non_snake_case)]
#[tauri::command]
pub fn clear_training_set(app: tauri::AppHandle, setId: String) -> Result<(), String> {
    let set = sanitize_component(&setId);
    if set.is_empty() {
        return Err("invalid set id".to_string());
    }
    let dir = trainer_root(&app).join("train").join(&set);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("could not clear the set: {}", os_error::english(&e)))?;
    }
    Ok(())
}

// ── the training run ─────────────────────────────────────────────────────────

#[allow(non_snake_case)]
#[tauri::command]
pub fn start_character_training(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    setId: String,
    name: String,
    triggerWord: String,
    steps: Option<u32>,
) -> Result<serde_json::Value, String> {
    {
        let mut run = state.trainer_run.lock().unwrap();
        if run.status == "running" {
            return Ok(serde_json::json!({"status": "already_running"}));
        }
        run.status = "running".to_string();
        run.logs.clear();
        run.download_progress = 0;
        run.download_total = 0;
        run.logs.push("Preparing the training run...".to_string());
    }
    info!("character training start");

    let set = sanitize_component(&setId);
    let lora_name = sanitize_component(&name);
    let trigger = sanitize_component(&triggerWord);
    if set.is_empty() || lora_name.is_empty() || trigger.is_empty() {
        set_status(&state.trainer_run, "error", "Set, name and trigger word are required.");
        return Err("invalid arguments".to_string());
    }
    let steps = steps.unwrap_or(1200).clamp(100, 4000);

    let root = trainer_root(&app);
    let comfy = active_comfy_dir(state.inner());
    let vpy = venv_python(&root);
    if !vpy.exists() {
        set_status(&state.trainer_run, "error", "Trainer environment is missing. Run the trainer install first.");
        return Err("trainer_not_installed".to_string());
    }
    // Held for the run's own repair path below: rebuilding the venv needs the
    // system python, not the venv one that may be the broken part.
    let python_bin = state.python_bin.lock().unwrap().clone();
    let (Some(dit), Some(te), Some(vae)) = (
        resolve_base_file(&root, comfy.as_deref(), DIT_CANDIDATES, "diffusion_models"),
        resolve_base_file(&root, comfy.as_deref(), TE_CANDIDATES, "text_encoders"),
        resolve_base_file(&root, comfy.as_deref(), VAE_CANDIDATES, "vae"),
    ) else {
        set_status(
            &state.trainer_run,
            "error",
            "The Z-Image training base files are missing (z_image_bf16 / qwen_3_4b / ae). Get them from the Model Manager, then train again.",
        );
        return Err("bases_missing".to_string());
    };
    let img_dir = root.join("train").join(&set).join("img");
    let photo_count = fs::read_dir(&img_dir)
        .map(|it| it.filter_map(Result::ok).filter(|e| {
            e.path().extension().and_then(|x| x.to_str())
                .map(|x| ["png", "jpg", "jpeg", "webp"].contains(&x.to_ascii_lowercase().as_str()))
                .unwrap_or(false)
        }).count())
        .unwrap_or(0);
    if photo_count < 4 {
        set_status(&state.trainer_run, "error", "Need at least 4 staged photos to train.");
        return Err("not_enough_photos".to_string());
    }

    // Copy the finished LoRA next to the other local LoRAs so the existing
    // chain picks it up. Fall back to the trainer root when ComfyUI is absent.
    let loras_dir = comfy
        .as_deref()
        .map(|c| c.join("models").join("loras"))
        .unwrap_or_else(|| root.join("out"));

    let run = state.trainer_run.clone();
    let cancel = state.trainer_cancel.clone();
    let pid_slot = state.trainer_process.clone();
    let env_broken = state.trainer_env_broken.clone();
    // T-65: the training thread outlives this `State` borrow, so resolve
    // ComfyUI's ACTUAL address here (user-configured host/port from AppState,
    // not a hardcoded localhost:8188) and move the verdict in.
    let comfy_vram_target = crate::commands::process::comfy_vram_target(state.inner());
    cancel.store(false, Ordering::SeqCst);

    std::thread::spawn(move || {
        let set_dir = root.join("train").join(&set);
        let cache_dir = set_dir.join("cache");
        let out_dir = set_dir.join("out");
        let _ = fs::create_dir_all(&cache_dir);
        let _ = fs::create_dir_all(&out_dir);

        // Repeats sized so photos x repeats x epochs lands near the step goal
        // with batch 1 (steps/epoch = photos x repeats).
        let repeats = (steps as usize / photo_count / 8).clamp(2, 40);
        let toml = format!(
            "[general]\nresolution = [768, 768]\ncaption_extension = \".txt\"\nbatch_size = 1\nenable_bucket = true\nbucket_no_upscale = false\n\n[[datasets]]\nimage_directory = '{}'\ncache_directory = '{}'\nnum_repeats = {}\n",
            img_dir.to_string_lossy().replace('\\', "/"),
            cache_dir.to_string_lossy().replace('\\', "/"),
            repeats,
        );
        let toml_path = set_dir.join("dataset.toml");
        if let Err(e) = fs::write(&toml_path, toml) {
            set_status(
                &run,
                "error",
                &format!("could not write dataset config: {}", os_error::english(&e)),
            );
            return;
        }

        let vpy_s = vpy.to_string_lossy().to_string();
        let repo = repo_dir(&root);
        let toml_s = toml_path.to_string_lossy().to_string();
        let dit_s = dit.to_string_lossy().to_string();
        let te_s = te.to_string_lossy().to_string();
        let vae_s = vae.to_string_lossy().to_string();

        // 0) preflight, and then repair rather than refuse. All three failure
        // classes used to pass every disk check and die mid-run as a raw error
        // the UI could not explain, and the only cure we offered was a Set up
        // button that did not render once the environment counted as ready
        // (bob80817 D#102 with a stale cu121 torch, sockenmonster with an
        // install that stopped before the trainer package). The customer
        // should not need install instructions, so the run fixes its own
        // environment and carries on.
        // Asked once and reused by both probes: the same vendor list the
        // install plans from, so the check and the repair cannot disagree
        // about what is in the machine.
        let gpu_label = training_gpu_label();
        let probe_env = |label: &str| -> Preflight {
            let mut probe = Command::new(&vpy_s);
            probe.args(["-c", TORCH_PREFLIGHT_PY]);
            force_python_utf8(&mut probe);
            #[cfg(target_os = "windows")]
            probe.creation_flags(CREATE_NO_WINDOW);
            match probe.output() {
                Ok(out) => preflight_verdict(
                    out.status.success(),
                    &String::from_utf8_lossy(&out.stdout),
                    &String::from_utf8_lossy(&out.stderr),
                    gpu_label,
                ),
                Err(e) => Preflight::TorchBroken(format!(
                    "could not run the trainer python ({label}): {}",
                    os_error::english(&e)
                )),
            }
        };

        set_status(&run, "running", "Checking the training environment...");
        let verdict = probe_env("first check");
        if !verdict.is_ok() {
            push_log(&run, &verdict.message());
            push_log(&run, "Repairing it now, no action needed. Your training images and base models are left alone.");
            let force = verdict.needs_torch_reinstall();
            if let Err(e) = provision_trainer_env(&root, &python_bin, force, &run, "running", &cancel, &pid_slot) {
                if e == "cancelled" {
                    set_status(&run, "cancelled", &e);
                    return;
                }
                // A repair that never finished leaves the environment exactly
                // as broken as one that finished and did not take, so it has
                // to say so out loud. It did not: the raw process error went
                // into the status line and envReady stayed true, because that
                // only folds in `trainer_env_broken` and nothing set it here.
                // The Set up button the message points at was therefore not on
                // screen. Measured on the box on 2026-08-15 with a full drive.
                env_broken.store(true, Ordering::SeqCst);
                set_status(&run, "error", &repair_aborted_message(&verdict, &e));
                return;
            }
            // Only a SECOND failure is a dead end. Report what is still wrong
            // plus the tail of the repair log, so the message names the cause
            // instead of the symptom.
            let after = probe_env("after repair");
            if !after.is_ok() {
                let tail = run.lock().ok()
                    .map(|st| st.logs.iter().rev().take(8).rev().cloned().collect::<Vec<_>>().join(" | "))
                    .unwrap_or_default();
                // The disk still LOOKS installed, so say out loud that it is
                // not, otherwise the Set up button this message points at
                // stays hidden and the customer is back where they started.
                env_broken.store(true, Ordering::SeqCst);
                set_status(&run, "error", &repair_failed_message(&after, &tail));
                return;
            }
            env_broken.store(false, Ordering::SeqCst);
            push_log(&run, "Trainer environment repaired, starting the run.");
        } else {
            env_broken.store(false, Ordering::SeqCst);
        }

        // 1) latent cache
        set_status(&run, "running", "Step 1/4: Caching image latents...");
        let mut c1 = Command::new(&vpy_s);
        c1.current_dir(&repo).args([
            "src/musubi_tuner/zimage_cache_latents.py",
            "--dataset_config", &toml_s,
            "--vae", &vae_s,
        ]);
        if let Err(e) = run_streamed(c1, "latent cache", &run, &cancel, &pid_slot) {
            set_status(&run, if e == "cancelled" { "cancelled" } else { "error" }, &e);
            return;
        }

        // 2) text-encoder cache (fp8 keeps the 4B Qwen TE inside 12 GB)
        set_status(&run, "running", "Step 2/4: Caching text encoder outputs...");
        let mut c2 = Command::new(&vpy_s);
        c2.current_dir(&repo).args([
            "src/musubi_tuner/zimage_cache_text_encoder_outputs.py",
            "--dataset_config", &toml_s,
            "--text_encoder", &te_s,
            "--batch_size", "8",
            "--fp8_llm",
        ]);
        if let Err(e) = run_streamed(c2, "text encoder cache", &run, &cancel, &pid_slot) {
            set_status(&run, if e == "cancelled" { "cancelled" } else { "error" }, &e);
            return;
        }

        // 3) the train itself — documented 12 GB combo: fp8 base + block swap
        // + gradient checkpointing + 8-bit optimizer. ComfyUI's model cache
        // would eat the same VRAM the trainer needs — ask it to let go first.
        match &comfy_vram_target {
            Ok(base) => {
                let outcome = crate::commands::process::free_comfyui_memory_at(base);
                if outcome.released() {
                    push_log(&run, "Freed ComfyUI's cached models to make room for training.");
                } else if let Some((target, why)) = outcome.not_responsible() {
                    // Used to be a silent `false`. On a 12 GB card the user is
                    // about to hit CUDA OOM, and "LU could not ask" is the one
                    // sentence that explains it.
                    push_log(
                        &run,
                        &format!("Did not free ComfyUI's VRAM ({target}): {why}"),
                    );
                }
            }
            Err((target, why)) => {
                push_log(&run, &format!("Did not free ComfyUI's VRAM ({target}): {why}"));
            }
        }
        set_status(&run, "running", &format!("Step 3/4: Training ({steps} steps). This runs for a while, live log below..."));
        let accelerate = {
            #[cfg(target_os = "windows")]
            { root.join("venv").join("Scripts").join("accelerate.exe") }
            #[cfg(not(target_os = "windows"))]
            { root.join("venv").join("bin").join("accelerate") }
        };
        let steps_s = steps.to_string();
        let out_name = format!("char_{lora_name}_zimage");
        let mut c3 = Command::new(accelerate);
        c3.current_dir(&repo).args([
            "launch", "--num_cpu_threads_per_process", "1", "--mixed_precision", "bf16",
            "src/musubi_tuner/zimage_train_network.py",
            "--dit", &dit_s,
            "--vae", &vae_s,
            "--text_encoder", &te_s,
            "--dataset_config", &toml_s,
            "--sdpa", "--mixed_precision", "bf16",
            "--fp8_base", "--fp8_scaled",
            "--blocks_to_swap", "16",
            "--timestep_sampling", "shift", "--weighting_scheme", "none", "--discrete_flow_shift", "2.0",
            "--optimizer_type", "adamw8bit", "--learning_rate", "1e-4", "--gradient_checkpointing",
            "--max_data_loader_n_workers", "2", "--persistent_data_loader_workers",
            "--network_module", "networks.lora_zimage", "--network_dim", "32",
            "--max_train_steps", &steps_s,
            "--save_precision", "bf16",
            "--seed", "42",
            "--output_dir", &out_dir.to_string_lossy(),
            "--output_name", &out_name,
        ]);
        if let Err(e) = run_streamed(c3, "training", &run, &cancel, &pid_slot) {
            set_status(&run, if e == "cancelled" { "cancelled" } else { "error" }, &e);
            return;
        }

        // 4) convert to the Diffusers key layout ComfyUI loads, straight into
        // the loras dir (musubi's documented `--target other` conversion).
        set_status(&run, "running", "Step 4/4: Converting the LoRA for ComfyUI...");
        let trained = out_dir.join(format!("{out_name}.safetensors"));
        if !trained.exists() {
            set_status(&run, "error", "Training finished but the LoRA file was not written.");
            return;
        }
        let _ = fs::create_dir_all(&loras_dir);
        let final_path = loras_dir.join(format!("{out_name}.safetensors"));
        let mut c4 = Command::new(&vpy_s);
        c4.current_dir(&repo).args([
            "src/musubi_tuner/convert_lora.py",
            "--input", &trained.to_string_lossy(),
            "--output", &final_path.to_string_lossy(),
            "--target", "other",
        ]);
        if let Err(e) = run_streamed(c4, "lora convert", &run, &cancel, &pid_slot) {
            set_status(&run, if e == "cancelled" { "cancelled" } else { "error" }, &e);
            return;
        }

        set_status(
            &run,
            "complete",
            &format!(
                "Character ready: {out_name}.safetensors is in your loras. Put '{trigger}' in a prompt on the Image tab with the LoRA active.",
            ),
        );
        info!("character training complete");
    });

    Ok(serde_json::json!({"status": "running"}))
}

#[tauri::command]
pub fn character_training_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let run = state.trainer_run.lock().unwrap();
    Ok(serde_json::json!({
        "status": run.status,
        "phase": run.phase,
        "logs": run.logs.iter().rev().take(30).rev().collect::<Vec<_>>(),
        "step": run.download_progress,
        "totalSteps": run.download_total,
    }))
}

// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread.
// The State borrow cannot cross into the blocking pool, so the handle is
// re-resolved there from the AppHandle (same pattern as engine.rs/whisper.rs).
#[tauri::command]
pub async fn cancel_character_training(app: tauri::AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        cancel_character_training_blocking(&state)
    })
    .await
    .map_err(|e| format!("cancel_character_training task: {e}"))?
}

/// Kill a live trainer child and its tree.
///
/// Shared with `AppState::shutdown_subprocesses`: the trainer PID lives in
/// AppState like every other long-running child, but shutdown never killed it,
/// so quitting mid-training left an orphaned Python process holding the GPU
/// with no UI left to stop it. The whole tree matters: the trainer runs
/// accelerate, which spawns the actual worker underneath.
pub(crate) fn kill_trainer_tree(pid: u32) {
    // This used to be `taskkill /T /F` on Windows and a bare `kill -9`
    // elsewhere, and both left the worker alive. Measured on the box
    // 2026-08-15: a cancelled run killed `accelerate` and the python directly
    // under it, while the two processes BELOW those kept the card at 100
    // percent for as long as anyone watched. `/T` resolves the tree in one
    // shot and loses whatever hangs under a process it has just killed.
    //
    // The shell tool already solved this: collect the tree with sysinfo and
    // kill the leaves first. One mechanism for both is also one place to fix
    // the next time a child learns to spawn children.
    crate::commands::shell::kill_tree(pid);
}

fn cancel_character_training_blocking(state: &AppState) -> Result<(), String> {
    state.trainer_cancel.store(true, Ordering::SeqCst);
    // Kill the live child directly too — pip/accelerate ignore the flag.
    if let Ok(mut slot) = state.trainer_process.lock() {
        if let Some(pid) = slot.take() {
            kill_trainer_tree(pid);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // Card names exactly as the probes spell them, round 12. The wheel matrix
    // behind them was read out of the published wheels on 2026-08-30 and lives
    // in torch_wheels.rs; these are only the strings.
    const RX_7900: &str = "AMD Radeon RX 7900 XTX";
    const RX_6700: &str = "AMD Radeon RX 6700 XT";
    const RX_5700: &str = "AMD Radeon RX 5700 XT";
    const AMD_APU: &str = "AMD Radeon(TM) Graphics";

    /// Cancelling a training run has to reach the process that actually holds
    /// the card, not just the launcher.
    ///
    /// The 2.6.5 build failed exactly here: `Cancel` killed `accelerate` and
    /// the python under it, while the two below kept computing. This test
    /// builds the same shape, a parent with a grandchild, and fails if
    /// anything survives. With the old body (`kill -9` on the parent alone,
    /// `taskkill /T` on Windows) it is red.
    #[cfg(unix)]
    #[test]
    fn cancelling_a_run_takes_the_grandchildren_with_it() {
        use std::process::{Command, Stdio};
        let mut child = Command::new("bash")
            .arg("-c")
            .arg("sleep 40 & sleep 40")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn bash");
        let pid = child.id();
        std::thread::sleep(std::time::Duration::from_millis(400));

        let mut sys = sysinfo::System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let unten = crate::commands::shell::descendants(pid, &sys);
        assert!(!unten.is_empty(), "bash spawned nothing, the test setup is wrong");

        super::kill_trainer_tree(pid);
        let _ = child.wait();

        let frist = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let mut jetzt = sysinfo::System::new();
            jetzt.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            let am_leben: Vec<u32> = unten
                .iter()
                .copied()
                .filter(|p| jetzt.process(sysinfo::Pid::from_u32(*p)).is_some())
                .collect();
            if am_leben.is_empty() {
                break;
            }
            assert!(
                std::time::Instant::now() < frist,
                "these survived the cancel: {am_leben:?}",
            );
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }

    /// The other half of the same bug: the cancel branch must not wait on the
    /// reader threads. They block in read() on a pipe a surviving grandchild
    /// still holds, so joining there left the run on "running" for good.
    #[test]
    fn the_cancel_branch_does_not_join_the_reader_threads() {
        let src = include_str!("trainer.rs");
        let zweig = src
            .split("if cancel.load(Ordering::SeqCst) {")
            .nth(1)
            .expect("cancel branch")
            .split("return Err(\"cancelled\".to_string());")
            .next()
            .expect("end of the cancel branch");
        assert!(
            !zweig.contains("h.join()"),
            "the cancel branch waits on the reader threads again",
        );
        assert!(
            zweig.contains("kill_trainer_tree(child.id())"),
            "the cancel branch no longer kills the whole tree",
        );
    }

    #[test]
    fn blackwell_routes_to_cu128_and_older_cards_keep_cu121() {
        use super::torch_index_for_cap;
        assert_eq!(torch_index_for_cap(Some(12))[0], "https://download.pytorch.org/whl/cu128");
        assert_eq!(torch_index_for_cap(Some(13))[0], "https://download.pytorch.org/whl/cu128");
        assert_eq!(torch_index_for_cap(Some(9))[0], "https://download.pytorch.org/whl/cu121");
        assert_eq!(torch_index_for_cap(Some(8))[0], "https://download.pytorch.org/whl/cu121");
        assert_eq!(torch_index_for_cap(None)[0], "https://download.pytorch.org/whl/cu121");
    }

    #[test]
    fn an_amd_box_gets_the_rocm_wheels_on_linux_and_an_honest_no_on_windows() {
        use super::{trainer_torch_plan, TorchPlan};
        // numbrain and lapbo: no NVIDIA card, so the old probe answered None
        // and the plan was the same cu121 a machine with no GPU at all gets.
        match trainer_torch_plan(false, None, true, &[RX_7900], "linux") {
            TorchPlan::Wheels { candidates, note } => {
                assert!(
                    candidates.iter().all(|c| c.contains("/rocm")),
                    "an AMD card may only be offered ROCm channels: {candidates:?}",
                );
                assert_eq!(candidates, crate::commands::torch_wheels::ROCM_CHANNELS);
                assert!(note.contains("AMD"), "the log line names the card: {note}");
                // Never sold as proven: the 8 bit optimizer is CUDA only here.
                assert!(note.contains("Honest limit"), "note hides the limit: {note}");
            }
            other => panic!("an AMD card on Linux wants the ROCm wheels, got {other:?}"),
        }
        // Windows and macOS have no ROCm wheel to install at all, so the only
        // honest move is to say so before anything is downloaded.
        for os in ["windows", "macos"] {
            match trainer_torch_plan(false, None, true, &[RX_7900], os) {
                TorchPlan::NoWheels(why) => {
                    assert!(why.contains("Linux only"), "{os}: {why}");
                    assert!(why.contains("ZLUDA"), "{os} answer ignores ZLUDA: {why}");
                    assert!(why.contains("nothing was downloaded"), "{os}: {why}");
                    // It carries its own way out, so the generic wrapper with
                    // the "check your disk" step has to leave it alone.
                    assert!(super::already_explained(&why), "{os} answer gets rewrapped");
                }
                other => panic!("{os} has no ROCm wheel, got {other:?}"),
            }
        }
    }

    // ── Runde 13: the Linux brake reaches the trainer too ─────────────────
    //
    // 3570ce53 held the uncovered AMD families back on the ComfyUI path. The
    // trainer walked the same road with the same map and no brake: RDNA 1 and
    // the RX 6400 to 6750 would have pulled the ROCm wheels, imported torch,
    // enumerated the device, and died at the first kernel. ComfyUI can fall
    // back to the processor there; a LoRA run cannot, so the trainer refuses,
    // which is the answer it already gives on Windows.

    #[test]
    fn a_linux_card_with_no_kernels_is_refused_before_anything_is_downloaded() {
        use super::{trainer_torch_plan, TorchPlan};
        for name in [RX_6700, RX_5700, "AMD Radeon RX 6600 XT", "AMD Radeon RX 6500 XT"] {
            match trainer_torch_plan(false, None, true, &[name], "linux") {
                TorchPlan::NoWheels(why) => {
                    // the measured fact, from torch_wheels and not restated here
                    assert!(why.contains("no official ROCm wheel carries kernels"), "{name}: {why}");
                    assert!(why.contains("invalid device function"), "{name}: {why}");
                    // and the trainer's own consequence, which is not ComfyUI's
                    assert!(why.contains("nothing was downloaded"), "{name}: {why}");
                    assert!(!why.contains("installing the processor build"), "{name}: {why}");
                    // it carries its own way out, so the disk-and-network
                    // wrapper has to leave it alone
                    assert!(super::already_explained(&why), "{name} answer gets rewrapped");
                }
                other => panic!("{name} would die at the first kernel, got {other:?}"),
            }
        }
    }

    #[test]
    fn the_rdna2_workaround_is_named_to_the_trainer_only_where_it_can_work() {
        use super::{trainer_torch_plan, TorchPlan};
        let why = |name: &str| match trainer_torch_plan(false, None, true, &[name], "linux") {
            TorchPlan::NoWheels(w) => w,
            other => panic!("{name}: {other:?}"),
        };
        // gfx1030 kernels ARE in the wheels, so an RDNA 2 card can be pointed
        // at them, and the sentence names the trainer rather than ComfyUI.
        assert!(why(RX_6700).contains("HSA_OVERRIDE_GFX_VERSION=10.3.0"));
        assert!(why(RX_6700).contains("before starting the trainer"));
        assert!(why(RX_6700).contains("LU does not do that for you"));
        // RDNA 1 has no neighbour and must not be sent chasing one.
        assert!(!why(RX_5700).contains("HSA_OVERRIDE"));
    }

    #[test]
    fn negative_control_the_brake_only_catches_the_measured_families() {
        use super::{trainer_torch_plan, TorchPlan};
        // Cards the wheels do carry, and a card whose name says nothing, keep
        // the ROCm channels they had before this commit.
        for name in [RX_7900, "AMD Radeon RX 9070 XT", "AMD Radeon RX 6800 XT", AMD_APU] {
            match trainer_torch_plan(false, None, true, &[name], "linux") {
                TorchPlan::Wheels { candidates, .. } => {
                    assert_eq!(candidates, crate::commands::torch_wheels::ROCM_CHANNELS, "{name}")
                }
                other => panic!("{name} must keep the ROCm wheels, got {other:?}"),
            }
        }
        // A box with an uncovered card AND a covered one trains on the covered
        // one, so the brake must not take the wheels away from it.
        assert!(matches!(
            trainer_torch_plan(false, None, true, &[RX_6700, RX_7900], "linux"),
            TorchPlan::Wheels { .. },
        ));
        // and it is an AMD brake on Linux: an NVIDIA box is untouched
        assert!(matches!(
            trainer_torch_plan(true, Some(8), true, &[RX_6700], "linux"),
            TorchPlan::Wheels { candidates, .. } if candidates[0].contains("/cu"),
        ));
    }

    #[test]
    fn the_windows_refusal_tells_the_truth_of_the_round_12_research() {
        use super::{trainer_torch_plan, TorchPlan};
        let TorchPlan::NoWheels(why) = trainer_torch_plan(false, None, true, &[RX_7900], "windows")
        else {
            panic!("windows still has no trainer wheels for an AMD card");
        };
        // The channel names of 2026-08-19 are gone, and the ones that are named
        // are the ones torch_wheels actually walks.
        assert!(!why.contains("rocm6.2"), "{why}");
        assert!(!why.contains("rocm7.0"), "{why}");
        assert!(why.contains("rocm7.2"), "{why}");
        // The claim that no Windows ROCm PyTorch exists is gone with them, and
        // the reason the trainer still says no is named instead.
        assert!(why.contains("AMD publishes its own Windows ROCm wheels"), "{why}");
        assert!(why.contains("8 bit optimizer"), "{why}");
        // The AMD sentence belongs to Windows and nowhere else.
        let TorchPlan::NoWheels(mac) = trainer_torch_plan(false, None, true, &[RX_7900], "macos")
        else {
            panic!("macos still has no trainer wheels for an AMD card");
        };
        assert!(!mac.contains("Windows ROCm wheels"), "{mac}");
        assert!(mac.contains("Linux only"), "{mac}");
    }

    #[test]
    fn negative_control_every_nvidia_case_plans_exactly_as_before() {
        use super::{torch_index_for_cap, trainer_torch_plan, TorchPlan};
        // The AMD branch is new, the NVIDIA ones must not have moved. Every
        // case has to leave the plan with the index torch_index_for_cap picks
        // on its own, including the machine with no GPU at all.
        for (has_nvidia, cap, has_amd) in [
            (true, Some(12u32), false),
            (true, Some(8), false),
            (true, None, false),
            (false, None, false),
            // A box with both cards trains on the NVIDIA one.
            (true, Some(8), true),
        ] {
            match trainer_torch_plan(has_nvidia, cap, has_amd, &[RX_6700], "windows") {
                TorchPlan::Wheels { candidates, .. } => assert_eq!(
                    candidates,
                    torch_index_for_cap(cap),
                    "nvidia={has_nvidia} cap={cap:?} amd={has_amd} moved channel",
                ),
                other => panic!("nvidia={has_nvidia} cap={cap:?} must install, got {other:?}"),
            }
        }
    }

    #[test]
    fn preflight_names_a_torch_that_cannot_reach_the_amd_card() {
        use super::{preflight_verdict, Preflight};
        // The CUDA wheels the old plan put on numbrain's box: torch imports,
        // reports no device, and every check passed. The run then walked into
        // step 1 and died there with the training script's own traceback.
        let out = "TORCH_OK 2.3.1+cu121\nCUDA 0\nMUSUBI_OK\n";
        let v = preflight_verdict(true, out, "", Some("AMD"));
        assert_eq!(v, Preflight::GpuUnreachable { vendor: "AMD".into() });
        assert!(v.message().contains("AMD"));
        assert!(v.message().contains("no usable GPU"));
        // A wrong build is exactly what pip has to be forced past.
        assert!(v.needs_torch_reinstall());
        // Negative control: the identical output on a machine that really has
        // no card is a healthy processor only environment and stays Ok.
        assert!(preflight_verdict(true, out, "", None).is_ok());
    }

    #[test]
    fn a_rocm_arch_list_is_not_read_as_cuda_kernel_numbers() {
        use super::{preflight_verdict, Preflight};
        // A ROCm build lists gfx names, not sm names, and numbrain's RX 9070
        // XT is gfx1201. This is the environment the Linux branch of the plan
        // now creates, so the check has to survive it.
        let rocm = "TORCH_OK 2.9.1+rocm6.4\nCUDA 1\nCAP 12 0\nARCHS gfx1030 gfx1100 gfx1201\nMUSUBI_OK\n";
        assert!(preflight_verdict(true, rocm, "", Some("AMD")).is_ok());
        // What the old expression made of that list: it stripped every non
        // digit and dropped the last one, so gfx1201 came out as 120.
        let old_arch_max = ["gfx1030", "gfx1100", "gfx1201"]
            .iter()
            .filter_map(|a| {
                let d: String = a.chars().filter(char::is_ascii_digit).collect();
                d[..d.len() - 1].parse::<u32>().ok()
            })
            .max();
        assert_eq!(old_arch_max, Some(120), "gfx1201 was read as 120");
        // 120 is not a compute capability, and that is why nobody noticed: it
        // sits so far above every real one that `cap > max` could not fire in
        // either direction. The guard was inert on ROCm rather than wrong out
        // loud, so a genuine ROCm kernel gap goes past it unnamed. Skipping
        // the gfx names is honest about that instead of pretending to check.
        assert!(12 <= old_arch_max.unwrap(), "the comparison could never fire");
        // Positive control: a real CUDA arch list is still read exactly as it
        // was, so the gfx guard did not blunt the check it sits in.
        assert_eq!(
            preflight_verdict(
                true,
                "TORCH_OK 2.3.1+cu121\nCUDA 1\nCAP 12 0\nARCHS sm_90\nMUSUBI_OK\n",
                "",
                Some("NVIDIA"),
            ),
            Preflight::KernelsTooOld { cap: 12, max: 9 },
        );
    }

    #[test]
    fn preflight_fails_loud_when_torch_does_not_import() {
        use super::{preflight_verdict, Preflight};
        let v = preflight_verdict(
            false,
            "",
            "Traceback (most recent call last):\nModuleNotFoundError: No module named 'torch'",
            Some("NVIDIA"),
        );
        assert_eq!(
            v,
            Preflight::TorchBroken("ModuleNotFoundError: No module named 'torch'".into())
        );
        assert!(v.message().contains("No module named 'torch'"));
        assert!(v.needs_torch_reinstall());
    }

    #[test]
    fn preflight_names_the_kernel_gap_on_blackwell_with_cu121() {
        use super::{preflight_verdict, Preflight};
        let out = "TORCH_OK 2.3.1+cu121\nCAP 12 0\nARCHS sm_50 sm_60 sm_70 sm_75 sm_80 sm_86 sm_90\nMUSUBI_OK\n";
        let v = preflight_verdict(true, out, "", Some("NVIDIA"));
        assert_eq!(v, Preflight::KernelsTooOld { cap: 12, max: 9 });
        assert!(v.message().contains("compute capability 12.x"));
        assert!(v.message().contains("no kernels"));
        // The wrong build is already installed, so pip has to be forced.
        assert!(v.needs_torch_reinstall());
    }

    #[test]
    fn preflight_catches_the_trainer_package_a_healthy_torch_hides() {
        use super::{preflight_verdict, Preflight};
        // sockenmonster: the install died between torch and `pip install -e .`.
        // torch imports, CUDA is fine, and the run still cannot start.
        let out = "TORCH_OK 2.7.0+cu128\nCAP 8 6\nARCHS sm_80 sm_86 sm_90\n";
        let v = preflight_verdict(true, out, "", Some("NVIDIA"));
        assert_eq!(v, Preflight::PackageMissing);
        assert!(v.message().contains("musubi_tuner"));
        // Nothing is wrong with torch here, so it must not be reinstalled.
        assert!(!v.needs_torch_reinstall());
    }

    #[test]
    fn preflight_passes_on_a_matching_build_and_on_cpu_only() {
        use super::preflight_verdict;
        let ok = "TORCH_OK 2.7.0+cu128\nCAP 12 0\nARCHS sm_80 sm_90 sm_100 sm_120 compute_120\nMUSUBI_OK\n";
        assert!(preflight_verdict(true, ok, "", Some("NVIDIA")).is_ok());
        // No card in the machine, so a torch that sees no device is exactly
        // what a healthy processor only environment looks like.
        assert!(preflight_verdict(true, "TORCH_OK 2.3.1\nMUSUBI_OK\n", "", None).is_ok());
    }

    #[test]
    fn negative_control_the_old_verdict_called_the_package_gap_healthy() {
        use super::{preflight_verdict, Preflight};
        // The old rule was "torch imports and the kernels fit, therefore ready".
        // Replayed on sockenmonster's environment it says ready; the new one
        // does not. This is the whole of the bug in two lines.
        let out = "TORCH_OK 2.7.0+cu128\nCAP 8 6\nARCHS sm_80 sm_86 sm_90\n";
        let old_rule_says_ready = out.contains("TORCH_OK");
        assert!(old_rule_says_ready);
        assert_ne!(preflight_verdict(true, out, "", Some("NVIDIA")), Preflight::Ok);
    }

    #[test]
    fn the_probe_script_prints_every_marker_the_verdict_reads() {
        use super::TORCH_PREFLIGHT_PY;
        // A marker renamed on one side only would silently turn every run into
        // a repair loop, so the two are pinned against each other here.
        for marker in ["TORCH_OK", "CUDA", "CAP", "ARCHS", "MUSUBI_OK"] {
            assert!(TORCH_PREFLIGHT_PY.contains(marker), "probe never prints {marker}");
        }
        // find_spec, not import: importing pulls the whole training stack.
        assert!(TORCH_PREFLIGHT_PY.contains("find_spec('musubi_tuner')"));
    }

    #[test]
    fn env_is_not_ready_until_the_trainer_package_is_there_too() {
        use super::{musubi_installed, torch_installed};
        use std::fs;
        let root = std::env::temp_dir().join(format!("lu-trainer-musubi-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let sp = root.join("venv").join("Lib").join("site-packages");
        fs::create_dir_all(&sp).unwrap();

        // torch landed, the trainer package did not: counted as ready before.
        let torch = sp.join("torch");
        fs::create_dir_all(&torch).unwrap();
        fs::write(torch.join("version.py"), "__version__ = '2.7.0'").unwrap();
        assert!(torch_installed(&root));
        assert!(!musubi_installed(&root));

        // `pip install -e .` leaves a dist-info plus an __editable__ .pth,
        // never a package directory, so the marker has to accept those.
        fs::create_dir_all(sp.join("musubi_tuner-0.1.0.dist-info")).unwrap();
        assert!(musubi_installed(&root));

        let root2 = std::env::temp_dir().join(format!("lu-trainer-musubi-pth-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root2);
        let sp2 = root2.join("venv").join("lib").join("python3.11").join("site-packages");
        fs::create_dir_all(&sp2).unwrap();
        assert!(!musubi_installed(&root2));
        fs::write(sp2.join("__editable__.musubi_tuner-0.1.0.pth"), "/src").unwrap();
        assert!(musubi_installed(&root2));

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&root2);
    }

    #[test]
    fn a_half_install_is_not_ready_until_torch_lands() {
        use super::torch_installed;
        use std::fs;
        let root = std::env::temp_dir().join(format!("lu-trainer-torch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        // venv exists, torch does not: the Sockenmonster case.
        fs::create_dir_all(root.join("venv").join("lib").join("python3.11").join("site-packages")).unwrap();
        assert!(!torch_installed(&root));

        // unix layout
        let unix_torch = root
            .join("venv").join("lib").join("python3.11").join("site-packages").join("torch");
        fs::create_dir_all(&unix_torch).unwrap();
        fs::write(unix_torch.join("version.py"), "__version__ = '2.7.0'").unwrap();
        assert!(torch_installed(&root));

        // windows layout on its own
        let root2 = std::env::temp_dir().join(format!("lu-trainer-torch-win-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root2);
        let win_torch = root2.join("venv").join("Lib").join("site-packages").join("torch");
        fs::create_dir_all(&win_torch).unwrap();
        fs::write(win_torch.join("version.py"), "__version__ = '2.7.0'").unwrap();
        assert!(torch_installed(&root2));

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&root2);
    }

    #[test]
    fn every_trainer_child_gets_utf8_stdio() {
        use super::force_python_utf8;
        let mut cmd = std::process::Command::new("python");
        force_python_utf8(&mut cmd);
        let envs: Vec<(String, Option<String>)> = cmd
            .get_envs()
            .map(|(k, v)| (
                k.to_string_lossy().into_owned(),
                v.map(|v| v.to_string_lossy().into_owned()),
            ))
            .collect();
        assert!(envs.contains(&("PYTHONIOENCODING".into(), Some("utf-8".into()))));
        assert!(envs.contains(&("PYTHONUTF8".into(), Some("1".into()))));
    }

    #[test]
    fn a_second_photo_never_overwrites_the_first() {
        use super::free_stem;
        use std::fs;
        let dir = std::env::temp_dir().join(format!("lu-trainer-stem-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // "foto (1).png" and "foto [1].png" both sanitise to the same stem.
        let first = free_stem(&dir, "foto__1_", "png", b"AAAA");
        assert_eq!(first, "foto__1_");
        fs::write(dir.join(format!("{first}.png")), b"AAAA").unwrap();
        fs::write(dir.join(format!("{first}.txt")), "caption one").unwrap();

        let second = free_stem(&dir, "foto__1_", "png", b"BBBB");
        assert_ne!(second, first, "a different photo must not reuse the stem");

        // The caption sidecar collides too, even with a different extension.
        let third = free_stem(&dir, "foto__1_", "jpg", b"CCCC");
        assert_ne!(third, first);

        // Re-staging the SAME bytes keeps the stem — no duplicate on re-upload.
        let again = free_stem(&dir, "foto__1_", "png", b"AAAA");
        assert_eq!(again, first);

        let _ = fs::remove_dir_all(&dir);
    }

    use super::*;

    #[test]
    fn step_counter_parses_tqdm_lines() {
        assert_eq!(parse_step_counter("steps:  8%|▊| 123/1600 [02:10<26:04]"), Some((123, 1600)));
        assert_eq!(parse_step_counter("epoch 1/16"), Some((1, 16)));
        assert_eq!(parse_step_counter("no counter here"), None);
        // version-ish fragments with tiny totals are ignored
        assert_eq!(parse_step_counter("python 3/4 things"), None);
    }

    #[test]
    fn sanitize_component_strips_path_syntax() {
        assert_eq!(sanitize_component("../../evil"), "evil");
        assert_eq!(sanitize_component("my char!"), "my_char");
        assert_eq!(sanitize_component("lumi"), "lumi");
    }
}

#[cfg(test)]
mod shutdown_tests {
    /// Quitting during a training run used to leave the trainer alive: the PID
    /// is in AppState like every other long-running child, but
    /// shutdown_subprocesses skipped it. This asserts the wiring exists — the
    /// kill itself is an OS call, so what is checkable here is that shutdown
    /// reaches for the trainer slot at all, and that the slot is emptied so a
    /// second pass cannot re-kill a recycled PID.
    #[test]
    fn shutdown_takes_the_trainer_pid_and_clears_the_slot() {
        let slot: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(Some(4242));

        // What state.rs does, in the same order.
        let taken = { slot.lock().unwrap().take() };

        assert_eq!(taken, Some(4242), "shutdown must pick the trainer pid up");
        assert!(
            slot.lock().unwrap().is_none(),
            "the slot must be empty afterwards so a later pass cannot kill a recycled pid",
        );
    }

    // ── a venv that is present but dead (review 2026-08-14) ─────────────────
    //
    // Windows user upgrades Python 3.11 to 3.13 and uninstalls the old one.
    // `venv\Scripts\python.exe` is a real copied binary, so it is still there
    // and still passes exists(), but it aborts during interpreter init because
    // pyvenv.cfg names a home that is gone. The old step 2 asked only about
    // presence, so the repair kept the dead venv and drove the two pip steps
    // with it, and the run died as "torch install failed (exit 103)". It could
    // never recover: start_character_training refuses to reach the repair
    // unless that same file exists, so on the repair path the old guard was
    // false every single time, and the Set up button stays hidden because the
    // status probe counts files too.

    #[test]
    fn a_venv_whose_python_no_longer_starts_gets_rebuilt() {
        use super::{venv_action, venv_create_args, VenvAction};
        assert_eq!(venv_action(true, false), VenvAction::Rebuild);
        // A rebuild must clear: the old site-packages belongs to an
        // interpreter that no longer exists, and pip would repair on top of it.
        assert_eq!(venv_create_args(VenvAction::Rebuild), ["-m", "venv", "--clear"]);
    }

    #[test]
    fn a_working_venv_is_kept_and_a_missing_one_is_created() {
        use super::{venv_action, venv_create_args, VenvAction};
        assert_eq!(venv_action(true, true), VenvAction::Keep);
        assert_eq!(venv_action(false, false), VenvAction::Create);
        // POSIX: venv/bin/python is a symlink, so a dead base already shows up
        // as absent. That is why this only ever bit Windows.
        assert_eq!(venv_action(false, true), VenvAction::Create);
        assert_eq!(venv_create_args(VenvAction::Create), ["-m", "venv"]);
        assert_eq!(venv_create_args(VenvAction::Keep), ["-m", "venv"]);
    }

    /// The probe directory is per-process now (`test_dir` puts the pid and the
    /// thread id in the name and sweeps up on `Drop`). It used to be the FIXED
    /// `<temp>/lu-trainer-venv-probe/python-not-an-interpreter`, deleted at the
    /// end of the test — so a concurrent copy of this binary removed the file
    /// between this copy's `write` and its `exists`. Measured on 01.09.2026
    /// under six concurrent copies of the suite, ten rounds: 1 of 60 runs, and
    /// the message it failed with — "the file is there, which is all the old
    /// check asked" — pointed at the production code rather than at the
    /// fixture.
    #[test]
    fn presence_alone_never_counts_as_a_working_interpreter() {
        use super::python_starts;
        let dir = crate::os_paths::test_dir("trainer-venv-probe");
        let fake = dir.join("python-not-an-interpreter");
        std::fs::write(&fake, b"pyvenv.cfg points at a home that is gone").unwrap();
        assert!(fake.exists(), "the file is there, which is all the old check asked");
        assert!(!python_starts(&fake), "but it does not run, which is the question");
        assert!(!python_starts(&dir.join("nothing-here")));
    }

    #[test]
    fn a_rebuild_without_a_base_python_explains_itself_instead_of_wiping_the_venv() {
        use super::{no_base_python_message, VenvAction};
        let rebuild = no_base_python_message(VenvAction::Rebuild);
        assert!(rebuild.contains("does not start any more"));
        assert!(rebuild.contains("Install Python in Settings"));
        // The fresh-install case must not claim there is an environment.
        let create = no_base_python_message(VenvAction::Create);
        assert!(!create.contains("still there"));
        assert!(create.contains("Install Python in Settings"));
    }

    #[test]
    fn step_two_asks_whether_the_venv_runs_not_whether_it_exists() {
        // Same guard as the state.rs one below: the whole fix is which
        // question step 2 asks, and a revert to exists() would pass every
        // other test in this file.
        let src = include_str!("trainer.rs");
        let step2 = &src[src.find("    // 2) venv").expect("step 2 marker")..];
        let step2 = &step2[..step2.find("// 3) torch").expect("step 3 marker")];
        assert!(
            step2.contains("venv_action(exists, exists && python_starts(&vpy_path))"),
            "step 2 must decide with venv_action, not with a bare exists()",
        );
        assert!(
            !step2.contains("if !venv_python(root).exists()"),
            "the presence-only guard is back",
        );
        assert!(
            step2.contains("venv_create_args(action)"),
            "a rebuild has to pass --clear, which only venv_create_args does",
        );
    }

    // ── a dead end has to name the way out (review 2026-08-14) ──────────────
    //
    // The repair fails a second time on an offline machine or a full disk.
    // Preflight::message() was rewritten as a pure diagnosis, and the
    // instruction the pre-A2 text carried ("Run the trainer install again from
    // Character Studio") was not replaced anywhere, so the customer was left
    // with a verdict and a pip log tail. Worse, the readiness probe is a
    // file-presence check: a torch that is on disk but will not import still
    // counts as ready, so the Set up button was not even on screen.

    #[test]
    fn the_terminal_message_says_what_to_do_next() {
        use super::{repair_failed_message, Preflight};
        let msg = repair_failed_message(
            &Preflight::TorchBroken("No module named 'torch'".into()),
            "pip install torch | connection reset",
        );
        assert!(msg.contains("PyTorch is missing or broken"), "keeps the diagnosis");
        assert!(msg.contains("The automatic repair did not fix it."), "says it already tried");
        assert!(msg.contains("Set up trainer"), "names the button, verbatim as the UI labels it");
        assert!(msg.contains("online") && msg.contains("room"), "names the two usual blockers");
        assert!(msg.ends_with("Last steps: pip install torch | connection reset"), "log tail last");
    }

    /// The repair that never finished used to hand the customer the raw process
    /// error. Measured on the box on 2026-08-15: twelve `Moving to ...` lines
    /// from pip's rollback, and the one sentence that said why somewhere above
    /// them, off the top of the status line.
    #[test]
    fn a_repair_that_stopped_early_names_the_cause_instead_of_quoting_pip() {
        use super::{repair_aborted_message, Preflight};
        let mut roh = String::from("torch install failed (exit Some(1)).\n");
        roh.push_str("ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device\n");
        for i in 0..12 {
            roh.push_str(&format!(
                "Moving to c:\\users\\ddrob\\musubi\\venv\\lib\\site-packages\\torch\\lib\\part{i}.dll\n"
            ));
        }
        let msg = repair_aborted_message(&Preflight::TorchBroken("No module named 'torch'".into()), &roh);

        assert!(!msg.contains("Moving to"), "pip rollback noise is still in the message: {msg}");
        assert!(msg.contains("The automatic repair stopped before it finished."), "{msg}");
        assert!(msg.contains("Set up trainer"), "names no button: {msg}");
        assert!(
            msg.contains("ran out of room") && msg.contains("7 GB"),
            "the disk case is not named with a real number: {msg}",
        );
        assert!(
            !msg.contains("about 3 GB"),
            "still promises the environment fits in 3 GB, which a torch reinstall does not: {msg}",
        );
    }

    /// Same disk case on the other two paths into the same dead end.
    #[test]
    fn a_full_drive_is_named_on_every_path_into_the_dead_end() {
        use super::{install_failed_message, repair_failed_message, Preflight};
        let voll = "ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device";
        for msg in [
            install_failed_message(voll),
            repair_failed_message(&Preflight::PackageMissing, voll),
        ] {
            assert!(msg.contains("ran out of room"), "{msg}");
            assert!(msg.contains("Set up trainer"), "{msg}");
        }
        // And a failure that is not about the disk keeps the usual two.
        let netz = install_failed_message("ERROR: connection reset by peer");
        assert!(netz.contains("online") && netz.contains("room"), "{netz}");
        assert!(!netz.contains("ran out of room"), "{netz}");
    }

    /// One error already carries its own way out, and it points at a different
    /// button. Wrapping it would bury that and quote it back as a log tail.
    #[test]
    fn an_error_that_already_names_its_button_is_left_alone() {
        use super::{install_failed_message, no_base_python_message, repair_aborted_message, Preflight, VenvAction};
        let eigen = no_base_python_message(VenvAction::Rebuild);
        assert_eq!(install_failed_message(&eigen), eigen);
        assert_eq!(
            repair_aborted_message(&Preflight::TorchBroken("x".into()), &eigen),
            eigen,
        );
    }

    /// Befund B: after a repair that stopped early the environment is broken,
    /// but `envReady` folds in `trainer_env_broken` only, and nothing set it on
    /// this branch. So the app called the environment healthy and the button
    /// the message points at was not on screen.
    #[test]
    fn a_repair_that_stopped_early_also_reports_the_environment_as_not_ready() {
        let src = include_str!("trainer.rs");
        let zweig = src
            .split("if let Err(e) = provision_trainer_env(")
            .nth(1)
            .expect("the repair call")
            .split("let after = probe_env(")
            .next()
            .expect("end of the repair branch");
        assert!(
            zweig.contains("env_broken.store(true, Ordering::SeqCst)"),
            "a repair that stopped early leaves envReady true",
        );
        assert!(
            zweig.contains("repair_aborted_message"),
            "the raw process error goes into the status line again",
        );
        // The Set up button path has the same two halves.
        let knopf = src
            .split("match provision_trainer_env(&root, &python_bin, false,")
            .nth(1)
            .expect("the install call")
            .split("Ok(serde_json::json!")
            .next()
            .expect("end of the install thread");
        assert!(knopf.contains("env_broken.store(true, Ordering::SeqCst)"), "{knopf}");
        assert!(knopf.contains("install_failed_message"), "{knopf}");
    }

    // ── A2 stage one: the setup step told everyone to check the network ────
    //
    // aikabatzu (Discord #general, 2026-08-27), confirmed by aldrich_ironhart
    // and by Z0mbieK in GH #121 on 2026-08-29: "Setting up the trainer
    // environment failed. Check that you are online" while online, with the
    // firewall off. Every failure class ended in that one sentence, because
    // there was only one sentence.

    #[test]
    fn a_missing_visual_cpp_runtime_does_not_send_the_customer_to_the_router() {
        use super::install_failed_message;
        let log = "torch install failed (exit Some(1)).\nImportError: VCOMP140.DLL was not found";
        let msg = install_failed_message(log);
        assert!(msg.contains("Set up trainer"), "no button: {msg}");
        assert!(!msg.contains("Check that you are online"), "still blames the network: {msg}");
        if cfg!(target_os = "windows") {
            assert!(msg.contains("Visual C++"), "the real cause is unnamed: {msg}");
            assert!(msg.contains("latest-supported-vc-redist"), "no way to get it: {msg}");
        } else {
            assert!(msg.contains("package manager"), "{msg}");
        }
    }

    #[test]
    fn the_visual_cpp_advice_is_only_given_where_it_exists() {
        // Negative control for the platform split: sending a Linux user to
        // microsoft.com is the same class of mistake as sending an online user
        // to their router. Both texts compile everywhere, so a Mac tests both.
        use super::next_step_for_log;
        let dll = "ImportError: VCOMP140.DLL was not found";
        let win = next_step_for_log(dll, "FALLBACK", "windows");
        let linux = next_step_for_log(dll, "FALLBACK", "linux");
        assert!(win.contains("Visual C++") && win.contains("vc-redist"), "{win}");
        assert!(!linux.contains("Visual C++"), "Linux is sent to microsoft.com: {linux}");
        assert!(!linux.contains("microsoft.com"), "{linux}");
        assert!(linux.contains("package manager"), "{linux}");
        assert!(linux.contains("Set up trainer"), "{linux}");

        let native = "OSError: [WinError 1114] initialization routine failed";
        let win_native = next_step_for_log(native, "FALLBACK", "windows");
        let linux_native = next_step_for_log(native, "FALLBACK", "linux");
        assert!(win_native.contains("Visual C++"), "{win_native}");
        assert!(!linux_native.contains("Visual C++"), "{linux_native}");
        assert!(linux_native.to_lowercase().contains("driver"), "{linux_native}");
    }

    #[test]
    fn a_wrong_wheel_is_not_dressed_up_as_a_broken_machine() {
        // "Torch not compiled with CUDA enabled" used to get the native
        // library text, which sends the customer to install a redistributable
        // and update a driver for a problem that is neither.
        use super::next_step_for_log;
        for os in ["windows", "linux"] {
            let step = next_step_for_log("AssertionError: Torch not compiled with CUDA enabled", "FALLBACK", os);
            assert!(step.contains("probes the card again"), "{os}: {step}");
            assert!(!step.contains("Visual C++"), "{os}: {step}");
            assert!(step.contains("Set up trainer"), "{os}: {step}");
        }
    }

    #[test]
    fn the_refused_write_is_worded_for_every_platform() {
        // Negative control for wording: the sentence has to be true on a Mac
        // and on Linux too, where nothing called Windows refuses anything.
        use super::next_step_for_log;
        let step = next_step_for_log("ERROR: [WinError 5] Access is denied", "FALLBACK", "linux");
        assert!(!step.contains("Windows refused"), "names the wrong system: {step}");
        assert!(step.contains("Set up trainer"), "{step}");
        // And the Windows wordings for a refused write have to reach this arm
        // at all, which they did not before: neither contains "permission".
        for log in ["ERROR: [WinError 5] Access is denied", "ERROR: Access is denied"] {
            assert_ne!(next_step_for_log(log, "FALLBACK", "windows"), "FALLBACK", "{log}");
        }
    }

    #[test]
    fn an_unsupported_python_is_named_as_such() {
        use super::install_failed_message;
        let msg = install_failed_message(
            "torch install failed (exit Some(1)).\nERROR: Could not find a version that satisfies the requirement torch",
        );
        assert!(msg.contains("3.10, 3.11 or 3.12"), "{msg}");
        assert!(!msg.contains("Check that you are online"), "{msg}");
    }

    #[test]
    fn a_real_network_failure_still_gets_the_network_sentence() {
        // Negative control. The point is not to stop saying "check that you
        // are online", it is to stop saying it when it is not true.
        use super::install_failed_message;
        for log in [
            "torch install failed (exit Some(1)).\nConnectionResetError: connection reset by peer",
            "torch install failed (exit Some(1)).\nReadTimeoutError: read timed out",
            "torch install failed (exit Some(1)).\nsomething nobody has a rule for",
        ] {
            let msg = install_failed_message(log);
            assert!(msg.contains("online") && msg.contains("room"), "lost the usual two: {msg}");
        }
    }

    #[test]
    fn the_full_drive_still_wins_over_every_other_verdict() {
        // Negative control for the ordering: a disk-full rollback names a DLL
        // under torch\lib on every line it prints, and the disk sentence is
        // the one with the measured number in it.
        use super::next_step_for_log;
        let mut log = String::from("OSError: [Errno 28] No space left on device\n");
        log.push_str("Moving to c:\\users\\x\\musubi\\venv\\lib\\site-packages\\torch\\lib\\vcomp140.dll\n");
        for os in ["windows", "linux"] {
            let step = next_step_for_log(&log, "FALLBACK", os);
            assert!(step.contains("7 GB"), "{os}: {step}");
        }
    }

    #[test]
    fn every_replacement_step_still_names_the_button() {
        use super::next_step_for_log;
        for log in [
            "VCOMP140.DLL was not found",
            "[WinError 1114] initialization routine failed",
            "ERROR: Could not find a version that satisfies the requirement torch",
            "PermissionError: [Errno 13] Permission denied",
            "error: externally-managed-environment",
            "AssertionError: Torch not compiled with CUDA enabled",
        ] {
            for os in ["windows", "linux", "macos"] {
                let step = next_step_for_log(log, "FALLBACK", os);
                assert_ne!(step, "FALLBACK", "no verdict for {log:?} on {os}");
                assert!(step.contains("Set up trainer"), "{log:?} on {os} has no way out: {step}");
            }
        }
    }

    #[test]
    fn every_failure_class_carries_a_next_step_and_a_healthy_one_does_not() {
        use super::Preflight;
        for v in [
            Preflight::TorchBroken("x".into()),
            Preflight::KernelsTooOld { cap: 12, max: 9 },
            Preflight::PackageMissing,
        ] {
            assert!(v.next_step().contains("Set up trainer"), "{v:?} has no way out");
        }
        assert_eq!(Preflight::Ok.next_step(), "");
    }

    #[test]
    fn a_failed_repair_makes_the_environment_report_as_not_ready() {
        // The button the message points at only renders on envReady false, and
        // the file checks alone cannot see a broken interpreter or a torch
        // that imports nothing. Source-pinned for the same reason as the
        // state.rs guard below: the whole fix is this one `&&`.
        let src = include_str!("trainer.rs");
        let status = &src[src.find("pub fn character_trainer_status").expect("status fn")..];
        let status = &status[..status.find("\"basesReady\"").expect("json body")];
        assert!(
            status.contains("&& !state.trainer_env_broken.load(Ordering::SeqCst)"),
            "envReady no longer folds in the failed repair",
        );
        // And it must be cleared again, or one bad run hides the trainer for
        // the rest of the session.
        assert!(src.contains("env_broken.store(false, Ordering::SeqCst)"));
        assert!(src.contains("env_broken.store(true, Ordering::SeqCst)"));
    }

    #[test]
    fn state_shutdown_actually_references_the_trainer() {
        // Cheap guard against the wiring being dropped in a future refactor:
        // the fix is one call in state.rs and nothing else would notice.
        let state_rs = include_str!("../state.rs");
        assert!(
            state_rs.contains("trainer_process") && state_rs.contains("kill_trainer_tree"),
            "shutdown_subprocesses no longer kills the trainer",
        );
    }
}
