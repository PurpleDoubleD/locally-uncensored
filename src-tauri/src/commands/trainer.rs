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

use crate::process_util::foreign_system_command;
use crate::state::AppState;
use std::fs;
use std::io::{BufReader, Read};
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

/// The same tag as a plain archive from GitHub's codeload host. The trainer
/// used to depend on a git binary for one shallow clone, and a machine without
/// git ended the setup with "git clone could not start" and a pointer to go
/// and install git. The archive needs nothing but the network; git stays as
/// the fallback for the day the archive host is unreachable and git is there.
fn musubi_archive_url() -> String {
    format!("https://codeload.github.com/kohya-ss/musubi-tuner/zip/refs/tags/{MUSUBI_TAG}")
}

/// What a fresh setup writes to the drive: PyTorch and its CUDA libraries are
/// 2.5 GB compressed and about 5 GB unpacked, pip keeps the download while it
/// unpacks, and the trainer's own dependencies add a gigabyte. Measured on the
/// box on 06.09.2026: 5.0 GB in the trainer folder plus 2.4 GB in pip's cache.
/// Asked before the first byte, because the old check was pip's "No space left
/// on device" with 2.5 GB already on the way.
const TRAINER_SETUP_NEEDS_GIB: u64 = 10;
/// A torch reinstall on top of an existing one: pip holds both copies while
/// it swaps them (see DISK_NEXT_STEP).
const TRAINER_REINSTALL_NEEDS_GIB: u64 = 7;

/// The card the documented recipe (fp8 base, block swap, gradient
/// checkpointing, 8 bit optimizer) was proven on has 12 GB. Below that the run
/// gets through both cache steps and dies with CUDA out of memory in the first
/// training step, after ten minutes of work. Asked before the first step.
const TRAINER_VRAM_FLOOR_MIB_FP8: u64 = 11 * 1024;

/// Nachbesserung Runde 2: `TRAINER_VRAM_FLOOR_MIB_FP8` assumes fp8 weight
/// storage is on, which `train_precision_for_capability` now guarantees for
/// every measured card (see its doc comment). This floor is only reached
/// for the one case where it is off: an unmeasured card (`cap: None`), the
/// fully conservative fallback. musubi has no zimage-specific number for
/// running WITHOUT `--fp8_base`; the only concrete figure in its docs is
/// `docs/hunyuan_video.md:236`, "without --fp8_base, 24 GB VRAM or more is
/// recommended" -- a different model, not measured for zimage on our own
/// box. Read honestly as an upper estimate rather than invented precision.
const TRAINER_VRAM_FLOOR_MIB_NO_FP8: u64 = 24 * 1024;

/// 3.0.8 D20, the Low VRAM recipe's floor with fp8 weights on. NOT measured
/// on a card yet (the box has 12 GB); derived from the pinned trainer's own
/// numbers, so it is an estimate and the report says so:
/// - the DiT is `z_image_bf16` at 12.3 GB in bf16, about 6.2 GB stored as fp8
///   (`--fp8_base --fp8_scaled`), and the run keeps 2 of its 30 transformer
///   blocks on the card with `--blocks_to_swap 28` (the maximum: zimage_model.py
///   `enable_block_swap` asserts `blocks_to_swap <= num_blocks - 2`,
///   `n_layers=30`; docs/zimage.md "The maximum number of blocks that can be
///   offloaded is 28");
/// - `--gradient_checkpointing_cpu_offload` moves the kept activations to
///   system memory too (parser_common.py, wired for Z-Image in
///   trainer_base.py `enable_gradient_checkpointing(args.gradient_checkpointing_cpu_offload)`);
/// - the text encoder cache step holds `qwen_3_4b` (8.0 GB in bf16) as fp8
///   via `--fp8_llm`, about 4 GB, the largest single resident in the run.
///
/// 7.5 GB lets an 8 GB card in (they report a little under 8192 MiB) and
/// keeps a 6 GB card out, where the text encoder alone would leave no room.
const TRAINER_VRAM_FLOOR_MIB_LOW_VRAM_FP8: u64 = 7 * 1024 + 512;

/// 3.0.8 D20: the two local recipes. `Standard` is the 12 GB recipe the box
/// proved; `LowVram` trades time and fine detail for memory, for cards under
/// the standard floor. Every argument it changes is one musubi-tuner v0.3.4
/// declares (see `TRAINER_VRAM_FLOOR_MIB_LOW_VRAM_FP8` for where).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TrainPreset {
    Standard,
    LowVram,
}

impl TrainPreset {
    /// The frontend sends `"low-vram"` for the Low VRAM recipe; anything else,
    /// a missing value from an older frontend included, is the standard one.
    pub(crate) fn from_arg(arg: Option<&str>) -> Self {
        match arg.map(str::trim) {
            Some("low-vram") => TrainPreset::LowVram,
            _ => TrainPreset::Standard,
        }
    }

    /// The dataset's `resolution` (dataset_config.md, `[general]`).
    pub(crate) fn resolution(self) -> u32 {
        match self {
            TrainPreset::Standard => 768,
            TrainPreset::LowVram => 512,
        }
    }

    /// `--blocks_to_swap`: 28 is Z-Image's maximum (see the floor above).
    pub(crate) fn blocks_to_swap(self) -> &'static str {
        match self {
            TrainPreset::Standard => "16",
            TrainPreset::LowVram => "28",
        }
    }

    /// `--network_dim`, the LoRA rank.
    pub(crate) fn network_dim(self) -> &'static str {
        match self {
            TrainPreset::Standard => "32",
            TrainPreset::LowVram => "16",
        }
    }

    /// `--gradient_checkpointing_cpu_offload` (needs `--gradient_checkpointing`,
    /// which every recipe sets).
    pub(crate) fn offloads_activations(self) -> bool {
        self == TrainPreset::LowVram
    }

    /// `--batch_size` of the text encoder cache step.
    pub(crate) fn text_encoder_batch(self) -> &'static str {
        match self {
            TrainPreset::Standard => "8",
            TrainPreset::LowVram => "1",
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            TrainPreset::Standard => "Normal",
            TrainPreset::LowVram => "Low VRAM",
        }
    }
}

/// 3.0.9 P8: what a run learns. Both kinds run the same recipe on the same
/// bases; the frontend writes the captions (`lib/train-kind.ts`), so the
/// kind only decides the file name, the closing line and whether the set's
/// photos become a character's reference images.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TrainKind {
    Character,
    Style,
}

impl TrainKind {
    /// `"style"` from the frontend; anything else, a missing value from an
    /// older frontend included, is a character.
    pub(crate) fn from_arg(arg: Option<&str>) -> Self {
        match arg.map(str::trim) {
            Some("style") => TrainKind::Style,
            _ => TrainKind::Character,
        }
    }

    /// The trained file's stem. `char_<name>_zimage` is what the Use shelf
    /// reads (`parseLocalCharacterLora`); a style must not land there.
    pub(crate) fn output_name(self, name: &str) -> String {
        match self {
            TrainKind::Character => format!("char_{name}_zimage"),
            TrainKind::Style => format!("style_{name}_zimage"),
        }
    }

    pub(crate) fn finished_line(self, file: &str, at: &Path, trigger: &str) -> String {
        match self {
            TrainKind::Character => format!(
                "Character ready: {file} is saved at {} and already in the LoRA picker on the Image tab. Put '{trigger}' in a prompt with the LoRA active.",
                at.display(),
            ),
            TrainKind::Style => format!(
                "Style ready: {file} is saved at {} and switched on in the LoRA picker on the Image tab. Set its strength there.",
                at.display(),
            ),
        }
    }
}

/// The floor `vram_verdict` checks against, coupled to the precision that
/// will actually run: a card refused for lacking fp8-recipe memory when fp8
/// storage is in fact on (or the reverse) was praezisionsblind, exactly the
/// Runde-2 review's finding. Without fp8 storage the Low VRAM recipe has no
/// evidence of its own either, so it keeps the conservative floor.
fn vram_floor_mib(precision: &TrainPrecision, preset: TrainPreset) -> u64 {
    match (precision.fp8, preset) {
        (false, _) => TRAINER_VRAM_FLOOR_MIB_NO_FP8,
        (true, TrainPreset::Standard) => TRAINER_VRAM_FLOOR_MIB_FP8,
        (true, TrainPreset::LowVram) => TRAINER_VRAM_FLOOR_MIB_LOW_VRAM_FP8,
    }
}

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

/// The file the Character Studio downloads for each base slot, its models
/// subfolder and its size in bytes (HuggingFace x-linked-size of
/// Comfy-Org/z_image, 2026-10-14). The panel used to say "about 19 GB" even
/// when only one file was missing (box run: only z_image_bf16, 11.46 GB, was
/// absent), so the status now names the missing ones with their size.
const BASE_DOWNLOADS: [(&str, &str, u64); 3] = [
    ("z_image_bf16.safetensors", "diffusion_models", 12_309_866_400),
    ("qwen_3_4b.safetensors", "text_encoders", 8_044_982_048),
    ("ae.safetensors", "vae", 335_304_388),
];

/// The base downloads still missing, in the order of `BASE_DOWNLOADS`, given
/// which of the three slots (diffusion model, text encoder, VAE) resolved.
fn missing_bases(present: [bool; 3]) -> Vec<serde_json::Value> {
    BASE_DOWNLOADS
        .iter()
        .zip(present)
        .filter(|(_, found)| !found)
        .map(|((filename, subfolder, bytes), _)| {
            serde_json::json!({ "filename": filename, "subfolder": subfolder, "bytes": bytes })
        })
        .collect()
}

pub(crate) fn sanitize_component(s: &str) -> String {
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

/// Whether a candidate path starts with `~`. `~` is a SHELL expansion, and
/// nothing on the Rust side of the trainer ever resolves it: the value goes
/// straight into `PathBuf::from`. K5 Blocker 1 (Opus review of `4fda5a0a`):
/// the old placeholder suggested `~/LU-Trainer` on Mac and Linux, so typing
/// exactly what the field offered created a literal folder named `~` next to
/// the app's working directory, not a folder in the user's home. Refusing
/// beats silently expanding it ourselves: there is no shell context here to
/// expand `~` FOR (a different user could run the app under a service
/// account with a different home than the one the customer meant).
fn starts_with_tilde(p: &str) -> bool {
    p.starts_with('~')
}

/// The absolute example shown in the trainer's own install-path field and
/// quoted back in its own rejection messages, one per platform family so the
/// example is never impossible on the machine reading it (same reasoning as
/// `comfy_path_placeholder.ts` on the frontend, kept in sync by
/// `trainer-path-placeholder.test.ts`/`k5-trainer-path-honesty.test.tsx`).
fn example_trainer_path() -> &'static str {
    if cfg!(target_os = "windows") {
        "D:\\LU-Trainer"
    } else if cfg!(target_os = "macos") {
        "/Users/you/LU-Trainer"
    } else {
        "/home/you/LU-Trainer"
    }
}

/// Everything a customer-typed trainer folder has to clear before it is
/// written to `config.json` and an install starts against it. K5 Blocker 2
/// (Opus review of `4fda5a0a`): the old code wrote the value first and asked
/// nothing afterward, so a relative path, a path with no write access or a
/// drive with no room was persisted anyway, and stayed persisted even though
/// the install that followed could never use it. `install_comfyui` is the
/// pattern this mirrors, except the check happens before the value is
/// remembered instead of after the whole install finishes -- checking a
/// folder is fast, an install is not, and there is nothing here yet to lose
/// on a failed check.
///
/// Order matters: the drive-space question is asked with the CANDIDATE path
/// (no directory has to exist yet for a mount-point lookup), before anything
/// is created, so a rejection on space leaves no empty folder behind.
fn validate_trainer_root_candidate(p: &str) -> Result<PathBuf, String> {
    validate_trainer_root_candidate_with(p, crate::commands::download::available_space_for)
}

/// The check itself, with the free-room lookup handed in. The tests give it a
/// fixed answer: asked of the real drive, the result depended on how full the
/// machine running the tests happened to be.
fn validate_trainer_root_candidate_with(
    p: &str,
    free_room: impl Fn(&Path) -> Option<u64>,
) -> Result<PathBuf, String> {
    if starts_with_tilde(p) {
        return Err(format!(
            "\"{p}\" starts with ~, and this field never expands it: the path is used exactly as typed, so ~ would become a literal folder named ~, not your home folder. Use a full path instead, for example {}.",
            example_trainer_path()
        ));
    }
    let path = PathBuf::from(p);
    if !path.is_absolute() {
        return Err(format!(
            "\"{p}\" is not an absolute path. Use a full path starting from the drive or root, for example {}.",
            example_trainer_path()
        ));
    }
    if let Some(free) = free_room(&path) {
        if let Some(msg) = disk_room_message(&path, free, TRAINER_SETUP_NEEDS_GIB) {
            return Err(msg);
        }
    }
    fs::create_dir_all(&path).map_err(|e| format!("Could not create \"{p}\": {}", os_error::english(&e)))?;
    let probe = path.join(".lu-write-check");
    fs::write(&probe, b"ok").map_err(|e| format!("\"{p}\" is not writable: {}", os_error::english(&e)))?;
    let _ = fs::remove_file(&probe);
    Ok(path)
}

/// Whether `a` and `b` sit on the same drive resp. filesystem. `None` when
/// this cannot be determined, which the caller must treat as "do not
/// suggest" (review-teil10.md M1): a suggestion is only ever worth showing
/// when the customer's folder is PROVABLY elsewhere.
///
/// Windows: the drive letter or UNC prefix (`Component::Prefix`), compared
/// case-insensitively. Neither path needs to exist for this; a prefix is
/// part of the path text itself.
#[cfg(windows)]
fn same_drive(a: &Path, b: &Path) -> Option<bool> {
    use std::path::Component;
    fn prefix_key(p: &Path) -> Option<String> {
        match p.components().next()? {
            Component::Prefix(prefix) => Some(prefix.as_os_str().to_string_lossy().to_lowercase()),
            _ => None,
        }
    }
    Some(prefix_key(a)? == prefix_key(b)?)
}

/// Unix: the device number (`MetadataExt::dev`) of the nearest existing
/// ancestor of each path, since a freshly suggested folder does not exist
/// yet and cannot be `stat`-ed directly.
#[cfg(unix)]
fn same_drive(a: &Path, b: &Path) -> Option<bool> {
    use std::os::unix::fs::MetadataExt;
    fn nearest_existing_dev(p: &Path) -> Option<u64> {
        let mut cur = Some(p);
        while let Some(c) = cur {
            if let Ok(meta) = fs::metadata(c) {
                return Some(meta.dev());
            }
            cur = c.parent();
        }
        None
    }
    Some(nearest_existing_dev(a)? == nearest_existing_dev(b)?)
}

/// A folder to suggest, not set, in the trainer's own install-path field: K5
/// architecture point 5. A customer who already moved ComfyUI (and with it
/// the model folder `download_model` writes into, see `models_dir_in` in
/// `commands/download.rs`) off the system drive is not left to retype a
/// matching drive letter for the trainer by hand. `None` once `trainer_root`
/// is already customized (nothing left to suggest), when no ComfyUI folder
/// is known yet, or when the ComfyUI folder is not PROVABLY on a different
/// drive resp. filesystem than `default_root` (review-teil10.md M1: without
/// this check, "Your model folder is on another drive" could be shown for a
/// customer whose ComfyUI sits on the very same drive as the app data
/// folder, and the field would move a fresh install's default target for
/// every customer with a known ComfyUI folder, not only the ones with a
/// second drive). Read only as far as the PLACEHOLDER: nothing here writes
/// `config.json` or moves a single byte.
fn suggested_trainer_root(comfy_dir: Option<&Path>, default_root: &Path) -> Option<String> {
    suggested_trainer_root_with(comfy_dir, default_root, same_drive)
}

/// Same as [`suggested_trainer_root`], with the drive comparison injected so
/// the "actually on another drive" branch has a unit test that does not
/// depend on this machine happening to have a second filesystem mounted.
/// The real code path always calls this through [`suggested_trainer_root`],
/// which passes the real, platform-specific [`same_drive`].
fn suggested_trainer_root_with(
    comfy_dir: Option<&Path>,
    default_root: &Path,
    same_drive: impl Fn(&Path, &Path) -> Option<bool>,
) -> Option<String> {
    let comfy = comfy_dir?;
    let parent = comfy.parent()?;
    if same_drive(comfy, default_root)? {
        return None;
    }
    Some(parent.join("LU-Trainer").to_string_lossy().to_string())
}

/// Trainer root: persisted override (config `trainer_root`) else
/// `<app_data>/musubi`. Layout: `<root>/venv`, `<root>/musubi-tuner`,
/// `<root>/models`, `<root>/train/<set_id>/...`.
pub(crate) fn trainer_root(app: &tauri::AppHandle) -> PathBuf {
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

/// pip, Hugging Face and torch each keep a cache of their own, and left at
/// their OS defaults every one of them lands under the user's profile
/// (`%LOCALAPPDATA%` on Windows), regardless of where [`trainer_root`]
/// itself points (K5 Punkt 13, Trainer-Folgeauftrag). This is a pure
/// function of `root` alone: `<root>/cache/pip`,
/// `<root>/cache/huggingface[/xet]`, `<root>/cache/torch`, plus
/// `XDG_CACHE_HOME` at `<root>/cache` itself (the base every XDG-aware tool
/// falls back to for a cache this list has not named directly).
///
/// A version of this existed until `4b01feaf` and was deleted rather than
/// left unwired, per the house rule against dead code (it built the paths
/// but nothing ever called it). Reintroduced here WIRED IN this time, see
/// [`apply_trainer_cache_env`] for the one rule that keeps it from silently
/// orphaning an existing multi-GB cache.
pub(crate) fn trainer_cache_env(root: &Path) -> [(&'static str, PathBuf); 5] {
    let cache = root.join("cache");
    let hf = cache.join("huggingface");
    [
        ("PIP_CACHE_DIR", cache.join("pip")),
        ("HF_HOME", hf.clone()),
        ("HF_XET_CACHE", hf.join("xet")),
        ("TORCH_HOME", cache.join("torch")),
        ("XDG_CACHE_HOME", cache),
    ]
}

/// Whether the user actually moved `trainer_root` away from the built-in
/// default: a persisted, non-empty `trainer_root` config value. Mirrors
/// exactly the check [`trainer_root`] itself makes to decide whether to use
/// the override.
///
/// This is the migration guard for [`apply_trainer_cache_env`]: a customer
/// who never touched the setting must not have pip/HF/torch's caches
/// silently redirected out from under an install that predates this
/// feature. Their existing `~/.cache/huggingface` (or the platform
/// equivalent) already holds every base model and dependency this app
/// asked pip/HF for before this fix landed; redirecting it unconditionally
/// would leave that multi-GB cache empty at the new path and pay for the
/// same downloads a second time the moment the trainer runs again. Only a
/// customer who deliberately set `trainer_root` to move the trainer off a
/// small system drive gets the caches moved with it, because for that
/// customer a cache still filling up the old drive is the bug, not a
/// feature.
fn trainer_root_is_customized() -> bool {
    read_config_value("trainer_root").map(|p| !p.trim().is_empty()).unwrap_or(false)
}

/// Sets pip/HF/torch's caches on `cmd` to the SAME configured root as the
/// trainer folder itself, but ONLY when `customized` is true. Pure over
/// that argument (rather than reading `trainer_root_is_customized()`
/// itself) so the migration rule is a plain unit test instead of one that
/// has to fake a config file on disk; every real call site below passes
/// `trainer_root_is_customized()` for the actual decision.
fn apply_trainer_cache_env(cmd: &mut Command, root: &Path, customized: bool) {
    if !customized {
        return;
    }
    for (name, path) in trainer_cache_env(root) {
        cmd.env(name, path);
    }
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
///
/// GH #183: and the folders configured for ComfyUI itself, because the Model
/// Manager downloads into those now.
///
/// Discord 25.10.2026 (Comfy Desktop, "charcter isnt working"): and every
/// folder the running ComfyUI reports for `sub` (`engine`, its
/// `/internal/folder_paths` answer). `download_model` writes there first and
/// answers "exists" for a file it finds there, so the panel said all three
/// base files were missing while the Z-Image model was already in the picker,
/// and "Download base files" started nothing.
fn resolve_base_file(
    root: &Path,
    comfy_dir: Option<&Path>,
    engine: Option<&crate::commands::comfy_folders::ComfyFolders>,
    names: &[&str],
    sub: &str,
) -> Option<PathBuf> {
    let mut configured: Vec<PathBuf> = comfy_dir
        .map(|c| crate::commands::comfy_user_paths::UserComfyPaths::discover(c).dirs_for(sub))
        .unwrap_or_default();
    if let Some(e) = engine {
        configured.extend(e.dirs_for(sub));
    }
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
        if let Some(hit) = configured.iter().map(|d| d.join(n)).find(|p| p.exists()) {
            return Some(hit);
        }
    }
    None
}

/// Where a LoRA for ComfyUI goes: the folder configured for ComfyUI's
/// `loras` key when there is one (GH #183), else `<ComfyUI>/models/loras`.
pub(crate) fn comfy_loras_dir(comfy_dir: &Path) -> PathBuf {
    crate::commands::comfy_user_paths::UserComfyPaths::discover(comfy_dir)
        .write_dir("loras")
        .unwrap_or_else(|| comfy_dir.join("models").join("loras"))
}

pub(crate) fn active_comfy_dir(state: &AppState) -> Option<PathBuf> {
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
///
/// The same hook carries the second environment fix. GitHub #121 (a user,
/// two GPUs, 2026-08-29) and Discord (2026-09-09): the run died at
/// start with "use_libuv was requested but PyTorch was build without libuv
/// support". torch 2.4+ asks for libuv when torch.distributed sets up its
/// store, and the Windows wheels are built without it. USE_LIBUV=0 is the knob
/// torch reads in `rendezvous.py` for an `env://` store, which is the store
/// musubi's own `InitProcessGroupKwargs` opens on a machine with more than one
/// card. It is set on every platform now, not only on Windows: the value is
/// what every other platform does anyway, and a knob that only exists in the
/// Windows build is a knob no test on this machine can read.
///
/// It is NOT the whole fix. The launcher path (step 3 below) never asked
/// torch's env store anything; see `training_command`.
///
/// The third fix carried here is K3, 2026-09-18, corrected 2026-09-18 after
/// an Opus review that read the real mechanism further than this comment
/// first did. `892a7e21` dropped `accelerate launch` (see `training_command`)
/// so nothing sets `LOCAL_RANK` / `RANK` / `WORLD_SIZE` any more, and
/// `accelerate/state.py`'s `PartialState.__init__` (v1.6.0, read from the
/// real cloned source, not guessed) never calls `init_process_group` without
/// `LOCAL_RANK`, card count or not. The actual trigger is one step earlier,
/// in musubi's own `prepare_accelerator()` (`training/accelerator_setup.py`):
/// it builds `InitProcessGroupKwargs(backend="gloo" if os.name == "nt" ...)`
/// whenever `torch.cuda.device_count() > 1`, and hands it to `Accelerator()`.
/// `Accelerator.__init__` (`accelerate/accelerator.py` Z. 460-461) turns that
/// into `kwargs["backend"] = "gloo"` and passes it on to `PartialState`.
/// `_prepare_backend` (`state.py` Z. 735-804) finds no `LOCAL_RANK` and
/// returns `("gloo", DistributedType.NO)` UNCHANGED: the backend name
/// itself leaks through even though nothing distributed was ever set up.
/// Back in `PartialState.__init__` (Z. 268-292), the branch that should read
/// `if self.backend is None:` is then false, because `self.backend == "gloo"`,
/// not `None`; the `else` arm calls `torch.distributed.get_world_size()` on a
/// process group that was never initialized. That call is, word for word,
/// the melders' traceback.
///
/// `CUDA_VISIBLE_DEVICES` pinned to one card (`pin_trainer_gpu`, resolved by
/// `resolve_trainer_gpu`) keeps `device_count() > 1` from ever being true, so
/// the handler is never built and `self.backend` stays `None`. This closes
/// the door for a user (two visible cards, confirmed). It does NOT explain
/// A user: a single visible card never builds the handler in the first
/// place, `device_count() == 1` cannot reach this branch, and nobody has
/// measured `torch.cuda.device_count()` or `nvidia-smi -L` from his machine.
/// A second, unused NVIDIA card the driver still enumerates would fit
/// (Tesla P100 has no display output, so a Windows box built around one
/// commonly has a second card for the screen), but that is a plausible read
/// of the report, not a measurement; see the question drafted in
/// `lu-301/bau/trainer.md`.
fn trainer_child_env(cmd: &mut Command) {
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");
    cmd.env("USE_LIBUV", "0");
}

/// The Pythons the trainer can be built with. musubi-tuner v0.3.4 declares
/// `requires-python >=3.10,<3.13`, and the cu121 wheel index stops at cp312
/// as well, so anything newer fails at step 3 (cu121) or step 4 (cu128, where
/// torch itself installs fine and musubi then refuses the interpreter).
///
/// Ticket 0004 (2026-09-05, after the same wall in August):
/// LU built the venv from the newest Python on the machine, 3.14.6, because
/// nothing between "which Python does LU use" and "which Python can the
/// trainer use" existed. The setup now chooses its own interpreter from this
/// range, and a venv built from the wrong one is rebuilt, not kept.
const TRAINER_PYTHON_MINORS: std::ops::RangeInclusive<u32> = 10..=12;
pub(crate) const TRAINER_PYTHON_RANGE: &str = "3.10, 3.11 or 3.12";

/// `(3, 11)` from "3.11.7", None for anything that is not a version.
pub(crate) fn python_major_minor(version: &str) -> Option<(u32, u32)> {
    let mut parts = version.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

pub(crate) fn trainer_supports_python(version: &str) -> bool {
    matches!(python_major_minor(version), Some((3, minor)) if TRAINER_PYTHON_MINORS.contains(&minor))
}

/// Which interpreter builds the trainer venv, from `(path, version)` pairs
/// with LU's default first. The default wins when it fits, so a working
/// environment is never rebuilt just because a newer Python appeared; otherwise
/// the newest supported one. None when nothing on the list fits.
pub(crate) fn choose_trainer_python(candidates: &[(String, String)]) -> Option<(String, String)> {
    if let Some(first) = candidates.first() {
        if trainer_supports_python(&first.1) {
            return Some(first.clone());
        }
    }
    candidates
        .iter()
        .filter(|(_, v)| trainer_supports_python(v))
        .max_by_key(|(_, v)| python_major_minor(v))
        .cloned()
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
/// and nothing else, so it only ever asked nvidia-smi. On a user's and
/// a user's AMD boxes that probe is silent, silence was read as "no GPU", and
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

/// The single card the trainer pins itself to, and where that pick came from
/// (for the log line, see `start_character_training`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TrainerGpuChoice {
    pub(crate) index: u32,
    pub(crate) name: String,
    pub(crate) memory_mib: Option<u64>,
    pub(crate) source: &'static str,
    /// The card's `GPU-<uuid>` when `detect_gpus()` could name it (never for
    /// the "CUDA_VISIBLE_DEVICES already set" branch, whose card may not be
    /// in `nvidia` at all). GPU-UUID Nachzug, review 2026-09-18 Runde 2 "UUID
    /// statt Index": `pin_trainer_gpu` prefers this over `index` the same
    /// way `gpu.rs::cuda_visible_devices_value` does for Ollama/ComfyUI.
    pub(crate) uuid: Option<String>,
}

/// Narrow `nvidia` down to the one card every trainer child runs on. Pure on
/// purpose (no `nvidia-smi`, no env read) so the priority order is a unit
/// test, not a Windows box: [`resolve_trainer_gpu`] is the thin wrapper that
/// gathers the real inputs.
///
/// Nachbesserung after the Opus review of `0e826c22`: that commit pinned
/// every trainer child to `CUDA_VISIBLE_DEVICES=0` unconditionally, which
/// (a) is not necessarily the strong card -- CUDA without
/// `CUDA_DEVICE_ORDER=PCI_BUS_ID` sorts fastest-first, and a user's RTX
/// 3090 Ti and RTX 3050 share compute capability 8.6, so the heuristic
/// tie-breaks on something neither promised nor measured -- and (b) silently
/// overrides both LU's own Hardware-tab GPU picker (`gpu.rs::GpuSelection`,
/// already wired into Ollama and ComfyUI via `apply_gpu_env`) and a
/// `CUDA_VISIBLE_DEVICES` the user set outside LU on purpose.
///
/// Order: the Hardware tab's own pick first (narrowed to its highest-memory
/// entry if the user selected more than one card there); failing that, a
/// `CUDA_VISIBLE_DEVICES` already set on this process (same narrowing);
/// failing that, the NVIDIA card with the most memory, never a bare index.
pub(crate) fn choose_trainer_gpu(
    nvidia: &[crate::commands::gpu::DetectedGpu],
    selection: &crate::commands::gpu::GpuSelection,
    existing_cuda_visible_devices: Option<&str>,
) -> Option<TrainerGpuChoice> {
    let best_of = |indices: &[u32]| -> Option<&crate::commands::gpu::DetectedGpu> {
        nvidia.iter().filter(|g| indices.contains(&g.index)).max_by_key(|g| g.memory_mib.unwrap_or(0))
    };
    if selection.vendor == "nvidia" && !selection.indices.is_empty() {
        if let Some(g) = best_of(&selection.indices) {
            return Some(TrainerGpuChoice {
                index: g.index,
                name: g.name.clone(),
                memory_mib: g.memory_mib,
                uuid: g.uuid.clone(),
                source: "the Hardware tab's GPU selection",
            });
        }
    }
    if let Some(existing) = existing_cuda_visible_devices {
        // Tokens may be plain indices OR `GPU-<uuid>` forms -- a user who set
        // this themselves outside LU is just as entitled to the UUID form
        // this module now prefers internally (GPU-UUID Nachzug, review
        // 2026-09-18 Runde 2). Try a uuid match per token first, then a
        // numeric index, so either spelling of the user's own choice is
        // honoured the same way.
        let indices: Vec<u32> = existing
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .filter_map(|tok| {
                nvidia
                    .iter()
                    .find(|g| g.uuid.as_deref() == Some(tok))
                    .map(|g| g.index)
                    .or_else(|| tok.parse::<u32>().ok())
            })
            .collect();
        if !indices.is_empty() {
            if let Some(g) = best_of(&indices) {
                return Some(TrainerGpuChoice {
                    index: g.index,
                    name: g.name.clone(),
                    memory_mib: g.memory_mib,
                    uuid: g.uuid.clone(),
                    source: "the CUDA_VISIBLE_DEVICES already set for this process",
                });
            }
            // detect_gpus could not name it (a stale index, a probe that did
            // not run) -- the user's own choice still wins over a guess.
            return Some(TrainerGpuChoice {
                index: indices[0],
                name: format!("device {}", indices[0]),
                memory_mib: None,
                uuid: None,
                source: "the CUDA_VISIBLE_DEVICES already set for this process",
            });
        }
    }
    nvidia.iter().max_by_key(|g| g.memory_mib.unwrap_or(0)).map(|g| TrainerGpuChoice {
        index: g.index,
        name: g.name.clone(),
        memory_mib: g.memory_mib,
        uuid: g.uuid.clone(),
        source: "the card with the most memory",
    })
}

/// [`choose_trainer_gpu`] with its inputs gathered for real: `detect_gpus()`
/// (the same probe the Hardware tab itself lists cards from) and this
/// process's own `CUDA_VISIBLE_DEVICES`.
pub(crate) fn resolve_trainer_gpu(selection: &crate::commands::gpu::GpuSelection) -> Option<TrainerGpuChoice> {
    let all = crate::commands::gpu::detect_gpus().unwrap_or_default();
    let nvidia: Vec<crate::commands::gpu::DetectedGpu> =
        all.into_iter().filter(|g| g.vendor == "nvidia").collect();
    let existing = std::env::var("CUDA_VISIBLE_DEVICES").ok();
    choose_trainer_gpu(&nvidia, selection, existing.as_deref())
}

/// Set on a Command right before it runs: every trainer child sees exactly
/// this one card, regardless of how many are actually plugged in.
///
/// BLOCKER fix, Runde 2: `choice.index` comes from `nvidia-smi`, which
/// numbers cards in PCI bus order. CUDA itself, without `CUDA_DEVICE_ORDER`,
/// defaults to FASTEST_FIRST, a different ordering whenever visible cards
/// differ in speed. `CUDA_VISIBLE_DEVICES` alone can therefore pin the wrong
/// physical card on a multi-GPU box, the VRAM preflight measures a
/// different card than the one that trains, and the log line names the
/// intended card while a different one runs. This also covers the branch in
/// `choose_trainer_gpu` that reads a user-set `CUDA_VISIBLE_DEVICES`: its
/// index is matched against `detect_gpus()`'s PCI-order list, so the index
/// this function writes back out needs the same ordering to mean what it
/// says.
///
/// GPU-UUID Nachzug (review 2026-09-18 Runde 2, "UUID statt Index"): prefers
/// `choice.uuid` (a `GPU-<uuid>` string `detect_gpus()` could name) over the
/// bare index whenever it is known, the same env var value NVIDIA's own
/// CUDA_VISIBLE_DEVICES documentation and `nvidia-smi -L` both describe, and
/// identical on Windows and Linux. This survives a driver renumbering cards
/// between detection and launch, the PCI-order/FASTEST_FIRST mismatch
/// `CUDA_DEVICE_ORDER` only patches over for the index form. `CUDA_DEVICE_
/// ORDER=PCI_BUS_ID` is still set unconditionally as the fallback net for
/// whenever `choice.uuid` is `None` (an old driver, a MIG-enabled card, or
/// the "stale index, probe did not run" branch of `choose_trainer_gpu`).
fn pin_trainer_gpu(cmd: &mut Command, choice: &TrainerGpuChoice) {
    let selector = choice.uuid.clone().unwrap_or_else(|| choice.index.to_string());
    cmd.env("CUDA_DEVICE_ORDER", "PCI_BUS_ID");
    cmd.env("CUDA_VISIBLE_DEVICES", selector);
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
/// a user's install died after torch and before `pip install -e .`, so
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
const TORCH_PREFLIGHT_PY: &str = "import importlib.util\nimport torch\nprint('TORCH_OK', torch.__version__)\ncuda = torch.cuda.is_available()\nprint('CUDA', '1' if cuda else '0')\nif cuda:\n    cap = torch.cuda.get_device_capability(0)\n    print('CAP', cap[0], cap[1])\n    print('NAME', torch.cuda.get_device_name(0))\n    print('ARCHS', ' '.join(torch.cuda.get_arch_list()))\n    print('VRAM_MIB', torch.cuda.get_device_properties(0).total_memory // (1024 * 1024))\nif importlib.util.find_spec('musubi_tuner') is not None:\n    print('MUSUBI_OK')\n";

/// What the preflight found. Five failure classes that all used to surface as
/// a raw error deep inside the run: torch not importable (half install), a
/// torch build whose kernel list stops below the GPU's compute capability
/// (cu121 on Blackwell, which imports fine and even reports CUDA as
/// available), the mirror of that for a card OLDER than the build's kernel
/// floor (Opus review of K3, 2026-09-18: nothing checked this direction
/// before), a torch that reaches no card at all on a machine that has one
/// (the CUDA wheels an AMD box used to be handed), and the trainer package
/// missing (an install that died after torch). Each one is repairable or at
/// least namable, which is why they are distinguished rather than collapsed
/// into one error string.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Preflight {
    Ok,
    TorchBroken(String),
    KernelsTooOld { cap: u32, max: u32 },
    /// `cap < min`: this build's kernel list does not reach down to the
    /// card's compute capability either -- the two named archs are the
    /// build's floor and the card's own number, not a version range.
    /// Unlike `KernelsTooOld`, no other channel `trainer_torch_plan` already
    /// picks from would fix this, so it does not ask for a torch reinstall.
    CardBelowKernelFloor { cap_major: u32, cap_minor: u32, min: u32, name: Option<String> },
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
    /// install into what is missing. `CardBelowKernelFloor` is deliberately
    /// absent: `trainer_torch_plan` already picks the best channel for this
    /// card's capability, so reinstalling the same wheels a second time would
    /// not change the outcome, only spend another 2.5 GB finding that out.
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
            Preflight::CardBelowKernelFloor { cap_major, cap_minor, min, name } => {
                let card = name.as_deref().unwrap_or("This GPU");
                format!(
                    "{card} has compute capability {cap_major}.{cap_minor}, and this PyTorch build's kernels start at {min}.0: there is no kernel for a card this old in it. This is a hardware floor, not a broken install; character training needs a newer card or Character Studio in Cloud mode."
                )
            }
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
/// (Discord and GH #121, 2026-08-27 and
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
const PERMISSION_NEXT_STEP: &str = "The installer was not allowed to write into the Python folder. Close every open Python, Jupyter or IDE debugger, and if that changes nothing, install Python for your own user instead of for all users, then press Set up trainer in Character Studio.";
const PEP668_NEXT_STEP: &str = "This Python refuses installs outside a virtual environment and the venv module is missing. Install it from your package manager (python3-venv on Debian and Ubuntu, python-virtualenv on Arch, python3-virtualenv on Fedora), then press Set up trainer in Character Studio.";

/// The message a user actually saw (Discord, 2026-09-16), built fresh at
/// the point of failure instead of a static sentence. The review found the
/// gap: `no_trainer_python_message` learned to name path and version, but
/// this is the DIFFERENT message pip's own `NoMatchingWheel` /
/// `UnsupportedPython` failure reaches, through `next_step_for_log`, and it
/// still only said "needs 3.10, 3.11 or 3.12" with nothing about what was
/// actually found. On Windows each interpreter's architecture is added too
/// (`python_version_and_arch`): a 32-bit or ARM64 Python 3.11 answers the
/// plain version check exactly like a real one and is why "rebuild the venv"
/// alone never broke a user's loop -- see `venv_action`.
fn python_version_next_step() -> String {
    let mut seen: Vec<String> = Vec::new();
    let mut found: Vec<String> = Vec::new();
    for p in crate::python::python_interpreters() {
        if !crate::python::is_real_python(&p) || seen.iter().any(|s| s.eq_ignore_ascii_case(&p)) {
            continue;
        }
        seen.push(p.clone());
        #[cfg(target_os = "windows")]
        {
            if let Some((v, arch_ok)) = crate::python::python_version_and_arch(&p) {
                let arch = if arch_ok { "64-bit x86" } else { "not 64-bit x86, no PyTorch wheel exists for it" };
                found.push(format!("Python {v} at {p} ({arch})"));
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            if let Some(v) = crate::python::python_version(&p) {
                found.push(format!("Python {v} at {p}"));
            }
        }
    }
    let have = if found.is_empty() {
        "no Python that starts".to_string()
    } else {
        found.join(", ")
    };
    format!(
        "The Python in the trainer environment is one the trainer cannot use (it needs {TRAINER_PYTHON_RANGE}). This machine has: {have}. Press Set up trainer in Character Studio: the setup looks for a matching Python on this machine on its own, sets up LU's own Python 3.12 when there is none, and rebuilds the environment with it."
    )
}

/// The way out that fits what actually failed, on the platform it failed on.
/// The old code offered exactly one, "check that you are online and that the
/// drive has room", for every failure class there is.
pub(crate) fn next_step_for_log(log: &str, fallback: &str, os: &str) -> String {
    use crate::commands::install::pip::PipFailureKind as K;
    let windows = os == "windows";
    if out_of_disk(log) {
        return DISK_NEXT_STEP.to_string();
    }
    match crate::commands::install::pip::pip_failure_kind(log) {
        K::MissingRuntimeLibrary => {
            if windows { WINDOWS_REDIST_NEXT_STEP } else { UNIX_LIBRARY_NEXT_STEP }.to_string()
        }
        K::NativeLoadFailure => {
            if windows { WINDOWS_NATIVE_NEXT_STEP } else { UNIX_NATIVE_NEXT_STEP }.to_string()
        }
        K::TorchWithoutGpuSupport => WHEEL_NEXT_STEP.to_string(),
        K::NoMatchingWheel | K::UnsupportedPython => python_version_next_step(),
        K::Permission => PERMISSION_NEXT_STEP.to_string(),
        K::ExternallyManaged => PEP668_NEXT_STEP.to_string(),
        K::DiskFull => DISK_NEXT_STEP.to_string(),
        // Network failures and everything we cannot name keep the old text.
        // Naming the network for a failure that is not one is the whole bug.
        _ => fallback.to_string(),
    }
}

/// One shape for every dead end in the trainer environment: what is wrong, what
/// to press, and a short tail that says why. In that order, because the user
/// reads the first sentence and the last one.
///
/// Before this, a repair that never finished put the raw process error into the
/// status line instead, which on a full disk meant fifteen `Moving to ...`
/// lines and no next step at all.
pub(crate) fn env_failure_message(diagnosis: &str, fallback_step: &str, log: &str) -> String {
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
/// tail. `no_trainer_python_message` is the first such case, and it points at
/// python.org rather than at the button every other failure here names.
fn already_explained(err: &str) -> bool {
    err.contains("LU finds it on its own")
        // The room check answers before a byte is downloaded and names the
        // drive; wrapping it would add "check that you are online" on top.
        || err.contains("before anything is downloaded")
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
/// the hole a user's and a user's AMD boxes fell through.
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
    let mut cap_minor: Option<u32> = None;
    let mut arch_max: Option<u32> = None;
    let mut arch_min: Option<u32> = None;
    let mut card_name: Option<String> = None;
    for line in stdout.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("CAP ") {
            let mut parts = rest.split_whitespace();
            cap_major = parts.next().and_then(|v| v.parse().ok());
            cap_minor = parts.next().and_then(|v| v.parse().ok());
        } else if let Some(rest) = l.strip_prefix("NAME ") {
            let name = rest.trim();
            if !name.is_empty() {
                card_name = Some(name.to_string());
            }
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
                        arch_min = Some(arch_min.map_or(n, |p| p.min(n)));
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
    // The mirror check, added after the Opus review of K3 (2026-09-18): a
    // card OLDER than the build's kernel floor. Measured as unlikely to fire
    // for the concrete melder (a Tesla P100 is compute capability 6.0, and
    // both channels `trainer_torch_plan` picks from carry kernels well below
    // that), but it is the genuine lower bound the review asked for, and the
    // one direction `KernelsTooOld` never checked.
    if let (Some(cap), Some(min)) = (cap_major, arch_min) {
        if cap < min {
            return Preflight::CardBelowKernelFloor {
                cap_major: cap,
                cap_minor: cap_minor.unwrap_or(0),
                min,
                name: card_name,
            };
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
/// Whether a child's own lines go into the log the note under the button
/// reads. winget prints in the language of the Windows it runs on, and on
/// the box the note read "Download läuft ..." in an English app while LU
/// fetched Python 3.12 (06.09.2026). Quiet keeps the tail for the failure
/// message and lets the caller narrate in English.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Echo {
    Log,
    Quiet,
}

fn run_streamed(
    cmd: Command,
    label: &str,
    run: &Arc<Mutex<crate::state::InstallState>>,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
    pid_slot: &Arc<Mutex<Option<u32>>>,
) -> Result<(), String> {
    run_child(cmd, label, run, cancel, pid_slot, Echo::Log)
}

fn run_quiet(
    cmd: Command,
    label: &str,
    run: &Arc<Mutex<crate::state::InstallState>>,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
    pid_slot: &Arc<Mutex<Option<u32>>>,
) -> Result<(), String> {
    run_child(cmd, label, run, cancel, pid_slot, Echo::Quiet)
}

/// winget as LU runs it: silent, both agreements accepted so it never waits
/// for a keypress inside our thread, and quiet (see Echo). A per user package
/// takes `--scope user` and needs no elevation; a machine wide one (the Visual
/// C++ runtime) is left without a scope, its installer asks Windows for
/// elevation on its own.
pub(crate) fn winget_install_args(id: &str, user_scope: bool) -> Vec<String> {
    let mut args: Vec<String> = ["install", id, "--silent", "--accept-package-agreements", "--accept-source-agreements"]
        .iter()
        .map(|a| a.to_string())
        .collect();
    if user_scope {
        args.push("--scope".to_string());
        args.push("user".to_string());
    }
    args
}

fn winget_install(
    id: &str,
    user_scope: bool,
    run: &Arc<Mutex<crate::state::InstallState>>,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
    pid_slot: &Arc<Mutex<Option<u32>>>,
) -> Result<(), String> {
    let mut winget = foreign_system_command("winget");
    winget.args(winget_install_args(id, user_scope));
    run_quiet(winget, &format!("winget install {id}"), run, cancel, pid_slot)
}

fn cancel_requested(cancel: &Arc<std::sync::atomic::AtomicBool>) -> bool {
    cancel.load(Ordering::SeqCst)
}

/// Sleeps `secs`, a third of a second at a time, and says whether Cancel came
/// first.
fn wait_or_cancel(cancel: &Arc<std::sync::atomic::AtomicBool>, secs: u64) -> bool {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    while std::time::Instant::now() < until {
        if cancel_requested(cancel) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    false
}

/// A pip run that died on the network, not on the machine. Worth another try
/// after a pause; every other class comes back identical on a retry.
pub(crate) fn is_transient_network(err: &str) -> bool {
    use crate::commands::install::pip::PipFailureKind as K;
    matches!(
        crate::commands::install::pip::pip_failure_kind(err),
        K::Network | K::Timeout | K::RateLimited
    )
}

/// The two pip steps are the ones the network can break halfway, and the old
/// answer to a connection dropped at 2 GB of 2.5 was the dead end sentence.
/// Two retries after a pause the customer can still cancel, then the sentence.
fn pip_with_retry(
    mut build: impl FnMut() -> Command,
    label: &str,
    run: &Arc<Mutex<crate::state::InstallState>>,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
    pid_slot: &Arc<Mutex<Option<u32>>>,
) -> Result<(), String> {
    const RETRIES: u32 = 2;
    let mut attempt = 0;
    loop {
        match run_streamed(build(), label, run, cancel, pid_slot) {
            Err(e) if e != "cancelled" && attempt < RETRIES && is_transient_network(&e) => {
                attempt += 1;
                push_log(run, &format!(
                    "The download broke off during {label}. Waiting 15 seconds and trying again ({attempt} of {RETRIES})..."
                ));
                if wait_or_cancel(cancel, 15) {
                    return Err("cancelled".to_string());
                }
            }
            other => return other,
        }
    }
}

/// Feed a child's output to `on_line` one segment at a time, where a segment
/// ends at a newline OR a carriage return. Progress bars (tqdm) redraw their
/// line with \r and never send \n until the bar is done, so `BufRead::lines`
/// delivers a whole epoch of updates as one line, long after they happened.
pub(crate) fn for_each_progress_line<R: Read>(mut stream: R, mut on_line: impl FnMut(String)) {
    let mut pending: Vec<u8> = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        for &b in &buf[..n] {
            if b == b'\n' || b == b'\r' {
                if !pending.is_empty() {
                    on_line(String::from_utf8_lossy(&pending).into_owned());
                    pending.clear();
                }
            } else {
                pending.push(b);
            }
        }
    }
    if !pending.is_empty() {
        on_line(String::from_utf8_lossy(&pending).into_owned());
    }
}

fn run_child(
    mut cmd: Command,
    label: &str,
    run: &Arc<Mutex<crate::state::InstallState>>,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
    pid_slot: &Arc<Mutex<Option<u32>>>,
    echo: Echo,
) -> Result<(), String> {
    trainer_child_env(&mut cmd);
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
        let cancel = cancel.clone();
        handles.push(std::thread::spawn(move || {
            // Split on carriage returns as well as newlines: tqdm rewrites its
            // progress line in place with \r and only ends it with \n at the
            // end of an epoch, so a reader that waits for \n saw the step
            // counter jump in blocks of one epoch (measured on the box on
            // 06.09.2026: "Training 0/400" for 23 minutes, then 48 at a time).
            for_each_progress_line(stream, |line| {
                // After a cancel the tree is being killed; what the dying
                // Python still prints (a KeyboardInterrupt traceback) is not
                // this run's log. The box showed one under a status of
                // "cancelled" (06.09.2026).
                if cancel.load(Ordering::SeqCst) {
                    return;
                }
                // Der Schwanz dieses Protokolls steht in der Oberflaeche, also
                // gilt hier dieselbe Regel wie beim Installer: was das
                // Betriebssystem geschrieben hat, steht englisch da, was der
                // Trainer selbst schreibt, bleibt unangetastet.
                let line = os_error::english_child_text(&line).into_owned();
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    return;
                }
                if let Ok(mut t) = tail.lock() {
                    t.push(trimmed.to_string());
                    if t.len() > 12 {
                        t.remove(0);
                    }
                }
                if echo == Echo::Quiet {
                    return;
                }
                // Step counter for the UI meter: musubi/tqdm emit
                // "steps: NN%|...| 123/1600 [...]" style lines.
                if let Some((cur, total)) = parse_step_counter(trimmed) {
                    if let Ok(mut s) = run.lock() {
                        s.download_progress = cur;
                        s.download_total = total;
                    }
                }
                push_log(&run, trimmed);
            });
        }));
    }

    let exit = loop {
        if cancel.load(Ordering::SeqCst) {
            // The whole tree, not just this child: the train step keeps two
            // persistent data loader workers and pip spawns its own children,
            // and `Child::kill` never reaches either.
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
    // Only the training bar counts. musubi labels it "steps: NN%|...| cur/total
    // [...]". The weight loader right before it draws a tqdm bar of its own
    // (521 tensors on the box, 06.09.2026) and the epoch line carries a total
    // of its own: the meter read "Training 27/521 ... 521/521" for three
    // minutes against a 400-step run, then fell back to 0/400.
    let line = line.trim_start();
    if !line.get(..5).is_some_and(|p| p.eq_ignore_ascii_case("steps")) {
        return None;
    }
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

/// RAII claim on `state.trainer_install`'s "installing" slot. N2 (Opus review
/// of `3ef38668`): the check ("is one already running?") and the set ("mark
/// one as running") used to share a single lock, but the K5 validation step
/// added between them (`validate_trainer_root_candidate`, real disk IO) was
/// pulled OUT from under that lock, so the check and the set became two
/// separate locks with a window in between. Two concurrent calls could both
/// see `status != "installing"`, both pass, and both go on to start
/// `provision_trainer_env` against the same venv.
///
/// The fix moves the set back next to the check (claim the slot first, while
/// still holding the one lock, before any IO), and this guard is what makes a
/// failed claim reversible: validation runs AFTER the slot is claimed, so a
/// rejection has to hand the slot back rather than leave it stuck on
/// "installing" forever. `defuse()` disarms it once the install has
/// genuinely started (the spawned thread's own `set_status` calls own the
/// status from there); an undefused guard resets to "idle" on drop, which
/// covers every early return in between, including the `?` on validation
/// failure and on a poisoned `gpu_selection` lock.
struct InstallClaim<'a> {
    install: &'a Arc<Mutex<crate::state::InstallState>>,
    active: bool,
}

impl<'a> InstallClaim<'a> {
    /// The check-and-set itself, under ONE lock held only long enough to
    /// read the status and, if free, write it back to "installing". `None`
    /// means another caller already holds the slot. This is the exact
    /// sequence `install_character_trainer` needs before it does anything
    /// else, pulled into its own function (review-teil10.md M2) so the
    /// concurrency test below calls this PRODUCT code from two threads
    /// instead of a hand-copied stand-in that could drift from it.
    fn try_claim(install: &'a Arc<Mutex<crate::state::InstallState>>) -> Option<Self> {
        let mut st = install.lock().unwrap();
        if st.status == "installing" {
            return None;
        }
        st.status = "installing".to_string();
        Some(InstallClaim { install, active: true })
    }

    fn defuse(mut self) {
        self.active = false;
    }
}

impl Drop for InstallClaim<'_> {
    fn drop(&mut self) {
        if self.active {
            if let Ok(mut st) = self.install.lock() {
                st.status = "idle".to_string();
            }
        }
    }
}

#[allow(non_snake_case)]
#[tauri::command]
pub fn install_character_trainer(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    installPath: Option<String>,
) -> Result<serde_json::Value, String> {
    // Check-and-set under ONE lock, held only long enough to claim the slot,
    // never across the validation below (sysinfo disk lookup, create_dir_all,
    // a probe write). See `InstallClaim` for why a failed validation still
    // has to release the slot it just claimed.
    let claim = match InstallClaim::try_claim(&state.trainer_install) {
        Some(claim) => claim,
        None => return Ok(serde_json::json!({"status": "already_installing"})),
    };

    // K5 Blocker 2/3 (Opus review of `4fda5a0a`): validated and persisted
    // BEFORE the install starts, not after, and an empty field is the way
    // back to the default (point 3), not "leave whatever was there before".
    // Nothing at a previous customized location is touched or deleted here;
    // see `trainerRootHint` on the frontend for the sentence that says so.
    let trimmed = installPath.as_deref().map(str::trim).unwrap_or("");
    if trimmed.is_empty() {
        write_config_value("trainer_root", "");
    } else {
        let validated = validate_trainer_root_candidate(trimmed)?;
        write_config_value("trainer_root", &validated.to_string_lossy());
    }

    {
        let mut st = state.trainer_install.lock().unwrap();
        st.logs.clear();
        st.logs.push("Setting up the local character trainer...".to_string());
    }
    info!("character trainer install start");

    let root = trainer_root(&app);
    // An empty or unusable default Python is no longer a reason to stop here:
    // trainer_base_python surveys the machine and, when nothing fits, sets up
    // LU's own Python 3.12 itself. The old guard sent the customer to Settings for the one case
    // the setup can now handle on its own.
    let python_bin = state.python_bin.lock().unwrap().clone();

    let install = state.trainer_install.clone();
    let cancel = state.trainer_cancel.clone();
    let pid_slot = state.trainer_process.clone();
    let env_broken = state.trainer_env_broken.clone();
    // Cloned here, resolved (nvidia-smi and all) inside the thread: the same
    // card the setup's own smoke test measures is the one training pins to
    // later, see `resolve_trainer_gpu`.
    let gpu_selection = state.gpu_selection.lock().map_err(|e| e.to_string())?.clone();
    cancel.store(false, Ordering::SeqCst);
    // The slot stays claimed from here on; the thread's own set_status calls
    // take over reporting the status.
    claim.defuse();

    std::thread::spawn(move || {
        let device = resolve_trainer_gpu(&gpu_selection);
        match provision_trainer_env(&root, &python_bin, false, &install, "installing", &cancel, &pid_slot, device.as_ref()) {
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
/// The question is therefore whether the interpreter RUNS, and since ticket
/// 0004 also WHICH one it is: `python_version` is None for a venv that does
/// not start and the version for one that does, and a venv built from a
/// Python outside the trainer's range is exactly as unusable as a dead one.
/// It ran fine on a user's machine, its pip just refused musubi.
///
/// `arch_ok` is the Opus review's finding on this exact function: a venv
/// built from a 32-bit or ARM64 Python 3.11/3.12 reports a version
/// `trainer_supports_python` accepts, so before this it always read `Keep`
/// -- a user's "3.11-Umgebung loeschen half nicht" (Rebuild only ever fired
/// on the FIRST build; a Keep venv was never re-examined the same way) is
/// exactly the gap this closes. `true` on a platform where architecture is
/// not checked (see `python_version_and_arch`, Windows only) so this stays a
/// no-op everywhere else.
pub(crate) fn venv_action(python_exists: bool, python_version: Option<&str>, arch_ok: bool) -> VenvAction {
    match (python_exists, python_version) {
        (false, _) => VenvAction::Create,
        (true, None) => VenvAction::Rebuild,
        (true, Some(v)) if !trainer_supports_python(v) || !arch_ok => VenvAction::Rebuild,
        (true, Some(_)) => VenvAction::Keep,
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

/// Why we are stopping when no Python on this machine can build the trainer
/// venv and LU has no Python of its own for this system either (an Intel
/// Mac, an ARM machine; everywhere else LU sets up its own 3.12 instead, see
/// `trainer_base_python`). `found` is every version that runs here, so the
/// sentence can say what IS installed instead of asking the customer to
/// guess. Settings > Install Python is deliberately not the pointer: it
/// short-circuits as soon as any Python exists, which on a 3.14 machine is
/// exactly the one that cannot help. The last sentence is the marker
/// `already_explained` looks for.
///
/// K4, 2026-09-18: `found` used to be versions alone, so the message named
/// what version was on the machine but not where LU looked or which install
/// it was reading. a user's rebuild loop (see `python_version_and_arch`)
/// is exactly the case where two Pythons report the same version and only
/// one of them is real; the path is what lets the customer, or us reading a
/// Discord paste, tell which is which.
pub(crate) fn no_trainer_python_message(found: &[(String, String)], os: &str) -> String {
    let have = if found.is_empty() {
        "no Python that starts".to_string()
    } else {
        found
            .iter()
            .map(|(path, version)| format!("Python {version} at {path}"))
            .collect::<Vec<_>>()
            .join(" and ")
    };
    let get = match os {
        "windows" => "Install Python 3.12 from https://www.python.org/downloads/windows/ (any install option, it does not need to be on PATH)",
        "macos" => "Install it with 'brew install python@3.12' or from https://www.python.org/downloads/macos/",
        _ => "Install it with your package manager (python3.12 on Debian, Ubuntu and Fedora, python312 from the AUR on Arch)",
    };
    format!(
        "The trainer needs Python {TRAINER_PYTHON_RANGE} and this machine has {have}. {get}, then press Set up trainer in Character Studio. LU finds it on its own."
    )
}

/// `(3, 12)` as the trainer's rule reads it.
fn trainer_accepts(version: (u32, u32)) -> bool {
    trainer_supports_python(&format!("{}.{}", version.0, version.1))
}

/// The interpreter that builds `<root>/venv`, decided before a clone and 2.5
/// GB of wheels. LU's default first, then every other Python on the machine,
/// each asked for its version. When none fits, LU's own Python 3.12, the
/// same one ComfyUI falls back to, through the same function
/// (`base_python::machine_or_own`): downloaded once into LU's data folder,
/// on every system the pin carries, without administrator rights. Until
/// 3.0.7 this was a winget install of Python.Python.3.12, on Windows only.
fn trainer_base_python(
    python_bin: &str,
    state: &Arc<Mutex<crate::state::InstallState>>,
    status_kind: &str,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
) -> Result<(String, String), String> {
    let versioned = |paths: Vec<String>| -> Vec<(String, String)> {
        let mut seen: Vec<(String, String)> = Vec::new();
        for p in paths {
            if !crate::python::is_real_python(&p) || seen.iter().any(|(s, _)| s.eq_ignore_ascii_case(&p)) {
                continue;
            }
            // K4: a 32-bit or ARM64 Python answers `sys.version_info` exactly
            // like a normal one, builds a venv that looks complete, and only
            // dies once pip resolves torch, which reports as the wrong
            // Python-version message and sends the customer back to the same
            // interpreter. Excluding it here, before the venv is ever built,
            // is what makes the retry pick a different one instead of
            // looping (Discord 2026-09-16).
            #[cfg(target_os = "windows")]
            match crate::python::python_version_and_arch(&p) {
                Some((v, true)) => seen.push((p, v)),
                Some((v, false)) => push_log(
                    state,
                    &format!("Skipping {p} (Python {v}): not a 64-bit x86 build, the trainer's PyTorch wheels do not exist for it."),
                ),
                None => {}
            }
            #[cfg(not(target_os = "windows"))]
            if let Some(v) = crate::python::python_version(&p) {
                seen.push((p, v));
            }
        }
        seen
    };
    let mut paths = vec![python_bin.to_string()];
    paths.extend(crate::python::python_interpreters());
    let found = versioned(paths);
    let machine = choose_trainer_python(&found);
    if machine.is_none() && crate::private_python::version_here().is_some_and(trainer_accepts) {
        set_status(state, status_kind, &format!(
            "Setting up LU's own Python 3.12 for the trainer (this machine has {}, the trainer needs {TRAINER_PYTHON_RANGE}). The Pythons already installed stay as they are...",
            if found.is_empty() {
                "none that starts".to_string()
            } else {
                found.iter().map(|(_, v)| v.as_str()).collect::<Vec<_>>().join(" and ")
            }
        ));
    }
    let progress = crate::private_python::StatusProgress { status: state, cancel };
    let path = crate::commands::install::machine_or_own(
        machine.as_ref().map(|(p, _)| p.clone()),
        trainer_accepts,
        &progress,
        crate::commands::install::FOR_TRAINER,
    )?
    .ok_or_else(|| no_trainer_python_message(&found, std::env::consts::OS))?;
    #[cfg(target_os = "windows")]
    let own_version = |p: &str| crate::python::python_version_and_arch(p).map(|(v, _)| v);
    #[cfg(not(target_os = "windows"))]
    let own_version = crate::python::python_version;
    let version = match machine {
        Some((_, v)) => v,
        None => own_version(&path)
            .ok_or_else(|| format!("LU's own Python at {path} did not start. A security program may be blocking it: allow LU's folder, then press Set up trainer in Character Studio."))?,
    };
    if path != python_bin {
        let default = found
            .first()
            .filter(|(p, _)| p == python_bin)
            .map_or("none".to_string(), |(_, v)| v.clone());
        push_log(state, &format!(
            "Building the trainer environment with Python {version} at {path}: the trainer needs {TRAINER_PYTHON_RANGE}, and LU's default Python here is {default}."
        ));
    }
    Ok((path, version))
}

fn musubi_source_marker(root: &Path) -> PathBuf {
    repo_dir(root).join(".lu-source")
}

/// The trainer source is there and is the pinned tag: either the archive this
/// version unpacks (marker file carrying the tag) or a git checkout from an
/// older LU, which is kept as it is.
pub(crate) fn musubi_source_present(root: &Path) -> bool {
    let repo = repo_dir(root);
    if !repo.join("src").join("musubi_tuner").exists() {
        return false;
    }
    repo.join(".git").exists()
        || fs::read_to_string(musubi_source_marker(root))
            .map(|s| s.trim() == MUSUBI_TAG)
            .unwrap_or(false)
}

/// Step 1 without a git binary: the tag as an archive, unpacked into place.
/// git is the fallback the source falls back to, not a requirement checked
/// up front, so a machine without it only hears about git once the archive
/// has already failed. On Linux that answer names the exact package manager
/// command (review Runde 2, B3: this used to say the opposite, "never
/// install git first", which stopped being true the moment the preflight
/// below was added); on Windows and macOS it stays the plain network
/// sentence it always was.
fn fetch_musubi_source(
    root: &Path,
    state: &Arc<Mutex<crate::state::InstallState>>,
    status_kind: &str,
    tag: &str,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
    pid_slot: &Arc<Mutex<Option<u32>>>,
) -> Result<(), String> {
    set_status(state, status_kind, &format!("{tag} (1/4): getting musubi tuner {MUSUBI_TAG}..."));
    let archive_err = match download_musubi_archive(root, state, cancel) {
        Ok(()) => return Ok(()),
        Err(e) if e == "cancelled" => return Err(e),
        Err(e) => e,
    };
    // One git probe for both platform decisions (review Runde 2,
    // Nachbesserung 2: this used to run `git --version` a second time right
    // after git_download_preflight() already ran it). Linux setup
    // stolpstein (BERICHT-5-APPIMAGE.md): fresh Debian 13 and Fedora 43
    // cloud/desktop images ship no git at all, so name the exact package
    // manager command instead of a bare "could not download" there.
    let has_git = crate::commands::install::git::is_git_present();
    if !has_git {
        #[cfg(target_os = "linux")]
        {
            let hint = crate::commands::install::git::linux_git_missing_message(
                &crate::commands::install::git::read_os_release(),
            );
            return Err(format!("Could not download the trainer source: {archive_err}\n\n{hint}"));
        }
        #[cfg(not(target_os = "linux"))]
        {
            return Err(format!("Could not download the trainer source: {archive_err}"));
        }
    }
    push_log(state, &format!("Could not get the trainer source as an archive ({archive_err}); getting it with git instead."));
    let _ = fs::remove_dir_all(repo_dir(root));
    let mut clone = crate::process_util::foreign_system_command("git");
    clone.args(["clone", "--branch", MUSUBI_TAG, "--depth", "1", MUSUBI_REPO])
        .arg(repo_dir(root));
    run_streamed(clone, "git clone", state, cancel, pid_slot)
}

/// Download the tag archive into the trainer root, unpack it, move the one
/// folder it contains to `<root>/musubi-tuner`, and mark it with the tag.
/// Cancel is honoured between chunks, and a half download never becomes a
/// half source: the move happens last.
fn download_musubi_archive(
    root: &Path,
    state: &Arc<Mutex<crate::state::InstallState>>,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    let url = musubi_archive_url();
    let zip_path = root.join(format!("musubi-tuner-{MUSUBI_TAG}.zip"));
    let unpack_dir = root.join(".musubi-unpack");
    let client = reqwest::blocking::Client::builder()
        .user_agent(crate::app_identity::outgoing_agent!("2.6"))
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(1800))
        .build()
        .map_err(|e| format!("HTTP client: {}", os_error::english(&e)))?;
    let response = client
        .get(&url)
        .send()
        .map_err(|e| os_error::english(&e).to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {} from {url}", response.status()));
    }
    let mut file = fs::File::create(&zip_path)
        .map_err(|e| format!("could not write the archive: {}", os_error::english(&e)))?;
    let mut reader = BufReader::new(response);
    let mut buf = [0u8; 65536];
    let mut got: u64 = 0;
    loop {
        if cancel_requested(cancel) {
            drop(file);
            let _ = fs::remove_file(&zip_path);
            return Err("cancelled".to_string());
        }
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("the download broke off: {}", os_error::english(&e)))?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..n])
            .map_err(|e| format!("could not write the archive: {}", os_error::english(&e)))?;
        got += n as u64;
    }
    drop(file);
    push_log(state, &format!("Downloaded the trainer source ({:.1} MB), unpacking it...", got as f64 / 1e6));
    let _ = fs::remove_dir_all(&unpack_dir);
    let zipped = fs::File::open(&zip_path)
        .map_err(|e| format!("could not read the archive: {}", os_error::english(&e)))?;
    let mut archive = zip::ZipArchive::new(zipped)
        .map_err(|e| format!("the archive could not be read: {e}"))?;
    archive
        .extract(&unpack_dir)
        .map_err(|e| format!("the archive could not be unpacked: {e}"))?;
    let inner = fs::read_dir(&unpack_dir)
        .map_err(|e| format!("could not read the unpacked archive: {}", os_error::english(&e)))?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.is_dir() && p.join("src").join("musubi_tuner").exists())
        .ok_or_else(|| "the archive did not contain the trainer source".to_string())?;
    let repo = repo_dir(root);
    let _ = fs::remove_dir_all(&repo);
    fs::rename(&inner, &repo)
        .map_err(|e| format!("could not move the trainer source into place: {}", os_error::english(&e)))?;
    fs::write(musubi_source_marker(root), MUSUBI_TAG)
        .map_err(|e| format!("could not mark the trainer source: {}", os_error::english(&e)))?;
    let _ = fs::remove_dir_all(&unpack_dir);
    let _ = fs::remove_file(&zip_path);
    Ok(())
}

/// Free room on the drive that holds the trainer folder against what the
/// setup is about to write, before the first byte. None when there is room.
pub(crate) fn disk_room_message(root: &Path, free: u64, needed_gib: u64) -> Option<String> {
    let need = needed_gib.saturating_mul(1024 * 1024 * 1024);
    if free >= need {
        return None;
    }
    Some(format!(
        "The drive holding the trainer folder ({}) has {:.1} GB free and the trainer setup needs about {needed_gib} GB before anything is downloaded (PyTorch alone is 2.5 GB and installs with both copies on disk). Free up room on that drive, then press Set up trainer in Character Studio.",
        root.display(),
        free as f64 / (1024.0 * 1024.0 * 1024.0)
    ))
}

/// A torch that will not load because a Windows runtime library is missing or
/// its native libraries fail to initialise: the class the Visual C++ runtime
/// install fixes (ticket 007, a user, on the ComfyUI side).
pub(crate) fn runtime_library_missing(tail: &str) -> bool {
    use crate::commands::install::pip::PipFailureKind as K;
    matches!(
        crate::commands::install::pip::pip_failure_kind(tail),
        K::MissingRuntimeLibrary | K::NativeLoadFailure
    )
}

/// The card's memory as the probe reports it, against the floor the CHOSEN
/// precision actually needs (Nachbesserung Runde 2: a fixed floor was
/// precision-blind, see `vram_floor_mib`).
pub(crate) fn vram_verdict(vram_mib: Option<u64>, precision: &TrainPrecision, preset: TrainPreset) -> Option<String> {
    let mib = vram_mib?;
    let floor = vram_floor_mib(precision, preset);
    if mib >= floor {
        return None;
    }
    let card = mib as f64 / 1024.0;
    let need = floor as f64 / 1024.0;
    // A card the Low VRAM recipe would take: say so, that is the way out on
    // the same machine (D20).
    if preset == TrainPreset::Standard && mib >= vram_floor_mib(precision, TrainPreset::LowVram) {
        return Some(format!(
            "This card has {card:.0} GB of memory and the Normal training recipe needs {need:.0} GB: it was proven on a 12 GB card with fp8 weights and block swapping. Switch the trainer to Low VRAM in the Train tab and press Create again, or train the same character in Cloud mode.",
        ));
    }
    let recipe = match (precision.fp8, preset) {
        (true, TrainPreset::Standard) => "it was proven on a 12 GB card with fp8 weights and block swapping",
        (true, TrainPreset::LowVram) => "even with the Low VRAM recipe the text encoder and the model's working set need that much",
        (false, _) => "without fp8 weight storage this needs noticeably more headroom",
    };
    Some(format!(
        "This card has {card:.0} GB of memory and the local training recipe needs {need:.0} GB: {recipe}, and below that the first training step runs out of memory after both cache steps. Character Studio in Cloud mode trains the same character without this limit.",
    ))
}

pub(crate) fn parse_vram_mib(stdout: &str) -> Option<u64> {
    stdout
        .lines()
        .find_map(|l| l.trim().strip_prefix("VRAM_MIB "))
        .and_then(|v| v.trim().parse().ok())
}

/// `(major, minor)` from the preflight's own `CAP 8 6` line -- the same
/// number `preflight_verdict` reads, kept as a pair here because the
/// training recipe (`train_precision_for_capability`) needs the minor digit
/// too (8.0 has hardware bf16, 7.9 does not exist, but the boundary is real).
pub(crate) fn parse_capability(stdout: &str) -> Option<(u32, u32)> {
    let rest = stdout.lines().find_map(|l| l.trim().strip_prefix("CAP "))?;
    let mut parts = rest.split_whitespace();
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// The run's own dead ends, named. CUDA out of memory is the one a 12 GB card
/// hits when something else holds part of it (a browser playing video, a
/// game, ComfyUI with a model loaded), and the raw traceback says none of that.
/// Every step of the run ends the same way when its child fails: a cancel
/// stays a cancel, anything else goes through `training_failure_message`, so
/// a card that fills up during the latent or text-encoder cache gets the same
/// named cause and way out as one that fills up in the training step (the
/// cache steps used to hand the raw Python tail to the note).
fn end_failed_run(run: &Arc<Mutex<crate::state::InstallState>>, err: &str, vram_mib: Option<u64>) {
    if err == "cancelled" {
        set_status(run, "cancelled", err);
    } else {
        set_status(run, "error", &training_failure_message(err, vram_mib));
    }
}

pub(crate) fn training_failure_message(err: &str, vram_mib: Option<u64>) -> String {
    let low = err.to_ascii_lowercase();
    if low.contains("out of memory") || low.contains("outofmemoryerror") {
        let card = vram_mib
            .map(|m| format!(" This card has {:.0} GB.", m as f64 / 1024.0))
            .unwrap_or_default();
        return format!(
            "Training ran out of memory on the card.{card} Normal training needs 12 GB free on the card while it runs, Low VRAM about 8 GB: close other apps that use it (a browser playing video, a game, ComfyUI with a model loaded), then press Create again. If the card has less than 12 GB, switch the trainer to Low VRAM in the Train tab, or train the same character in Cloud mode without this limit. Last steps: {}",
            useful_tail(err)
        );
    }
    err.to_string()
}

struct ProbeOutcome {
    verdict: Preflight,
    vram_mib: Option<u64>,
    /// `(major, minor)`, read once here so `start_character_training` builds
    /// its recipe from the exact same probe the VRAM check already used --
    /// not a second call that could in principle answer a different card.
    cap: Option<(u32, u32)>,
}

/// One probe for every place that asks whether the environment loads: the end
/// of a setup, the start of a run, and the check after a repair. `device`, if
/// given, pins this probe to the same single card the run itself trains on
/// (Opus review of K3: the VRAM check has to measure the card that trains,
/// not whatever the driver puts at index 0).
fn probe_trainer_env(root: &Path, vpy: &Path, gpu: Option<&str>, device: Option<&TrainerGpuChoice>, label: &str) -> ProbeOutcome {
    let mut probe = foreign_system_command(vpy);
    probe.args(["-c", TORCH_PREFLIGHT_PY]);
    trainer_child_env(&mut probe);
    apply_trainer_cache_env(&mut probe, root, trainer_root_is_customized());
    if let Some(choice) = device {
        pin_trainer_gpu(&mut probe, choice);
    }
    #[cfg(target_os = "windows")]
    probe.creation_flags(CREATE_NO_WINDOW);
    match probe.output() {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            ProbeOutcome {
                verdict: preflight_verdict(
                    out.status.success(),
                    &stdout,
                    &String::from_utf8_lossy(&out.stderr),
                    gpu,
                ),
                vram_mib: parse_vram_mib(&stdout),
                cap: parse_capability(&stdout),
            }
        }
        Err(e) => ProbeOutcome {
            verdict: Preflight::TorchBroken(format!(
                "could not run the trainer python ({label}): {}",
                os_error::english(&e)
            )),
            vram_mib: None,
            cap: None,
        },
    }
}

/// Nachbesserung Runde 4 (Opus review, Runde 3 of bau/review-trainer.md):
/// bitsandbytes was the wrong reason. The real floor is bfloat16 itself, and
/// it is not optional the way `train_precision_for_capability` used to treat
/// it. Read in the trainer's own source (`src/musubi_tuner/zimage/`, the
/// only local model this trainer runs, see below):
///
/// - `zimage_utils.py:123`: loading the DiT's fp8 weight sets
///   `org_dtype = torch.bfloat16` ("model weight is fp8 in loading, but
///   original dtype is bfloat16") and dequantizes to bf16, never fp16.
/// - `zimage_utils.py:211`: the text encoder cache step wraps its forward
///   pass in `torch.autocast(device_type=..., dtype=torch.bfloat16)`,
///   hardcoded, independent of `--mixed_precision`.
/// - `zimage_train_network.py:146`: the sample-prompt path is hardcoded
///   bf16 too (unused here, since this trainer never samples).
///
/// `--mixed_precision fp16` therefore never reaches the step that actually
/// needs a dtype: the text encoder cache (`--fp8_llm`, set at
/// `trainer_child_env`'s call site below) hits `torch.autocast(...,
/// torch.bfloat16)` regardless, and a card without bf16 either raises out
/// of `is_bf16_supported()` or limps through an emulated path unusable for
/// a real run. fp16 was never a rescue for this model, it was a second,
/// silent way to die a few minutes further into the run. The honest fix is
/// the floor itself: compute capability 8.0, Ampere, the generation bf16
/// tensor cores start at.
///
/// This is currently a Z-Image-specific floor, not a general LU one: this
/// trainer drives exactly one local model (`zimage_train_network.py`, see
/// `training_command`), so one constant is enough today. A second local
/// trainer with its own dtype requirements would need its own floor, not a
/// wider one here.
const TRAINER_MIN_PROVEN_COMPUTE_CAP: (u32, u32) = (8, 0);

/// Refuses a card below `TRAINER_MIN_PROVEN_COMPUTE_CAP` in plain English,
/// before a single byte of torch downloads. Pure so the wording is a unit
/// test; the caller reads `cap` with `nvidia-smi --query-gpu=compute_cap`
/// (`detect_nvidia_compute_cap`), which needs no torch on disk, so this runs
/// even on a machine that has never had the trainer environment set up.
pub(crate) fn capability_floor_refusal(cap: (u32, u32), card_name: &str) -> Option<String> {
    let (major, minor) = cap;
    let (min_major, min_minor) = TRAINER_MIN_PROVEN_COMPUTE_CAP;
    if major > min_major || (major == min_major && minor >= min_minor) {
        return None;
    }
    Some(format!(
        "{card_name} has compute capability {major}.{minor}. Local character training needs at least compute capability {min_major}.{min_minor}: the model code of this trainer requires bfloat16, which this GPU generation does not support. This is a hardware floor, not a broken install; Character Studio in Cloud mode trains the same character with credits instead."
    ))
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
    device: Option<&TrainerGpuChoice>,
) -> Result<(), String> {
    let tag = if repairing { "Repairing the trainer environment" } else { "Setting up the trainer" };

    // Nachbesserung Runde 2, the honest refusal for a card genuinely below
    // the floor: read BEFORE anything downloads, including the 2.5 GB torch
    // install, with nvidia-smi alone so it needs no torch on disk yet. See
    // `capability_floor_refusal` for the floor and its source.
    if let Some(choice) = device {
        if let Some(cap) = crate::commands::install::detect_nvidia_compute_cap() {
            if let Some(msg) = capability_floor_refusal(cap, &choice.name) {
                return Err(msg);
            }
        }
    }

    // Decided first, before a clone, a venv and 2.5 GB of wheels: a machine
    // whose card has no PyTorch build should not have to pay for all of that
    // to find out. The probe is the vendor list, not nvidia-smi alone, which
    // is what left a user indistinguishable from a machine with
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

    // Decided second, for the same reason: the interpreter the venv is built
    // from must be one the wheels and musubi accept, and LU's default Python
    // is whatever is newest on the machine.
    let (python_bin, base_version) = trainer_base_python(python_bin, state, status_kind, cancel)?;
    let python_bin = python_bin.as_str();

    let _ = fs::create_dir_all(root.join("models"));

    // Room before the first byte. A fresh install writes about 10 GB across
    // the trainer folder and pip's cache; a reinstall holds two copies of
    // torch for a moment; a repair that reinstalls nothing needs no room.
    let force_reinstall = cap.is_some_and(|c| c >= 12) || repairing;
    let needed_gib = if !torch_installed(root) {
        TRAINER_SETUP_NEEDS_GIB
    } else if force_reinstall {
        TRAINER_REINSTALL_NEEDS_GIB
    } else {
        1
    };
    if let Some(free) = crate::commands::download::available_space_for(root) {
        if let Some(msg) = disk_room_message(root, free, needed_gib) {
            return Err(msg);
        }
    }

    // 1) the pinned source (releases are the project's own stability advice),
    // as an archive, so no git is needed on the machine.
    if !musubi_source_present(root) {
        fetch_musubi_source(root, state, status_kind, tag, cancel, pid_slot)?;
    } else {
        push_log(state, "musubi tuner already present, keeping the pinned source.");
    }

    // 2) venv. Asked as "does its python run, and which one is it", not "is
    // the file there": see venv_action. A dead venv is exactly the state a
    // repair is called for, and it used to be the one state this step could
    // not fix; a venv from the wrong Python was kept and failed at step 4.
    let vpy_path = venv_python(root);
    let exists = vpy_path.exists();
    // Version AND architecture: see `venv_action`'s doc comment for why a
    // venv that answers "3.11" is not automatically one the trainer can use.
    let (venv_version, venv_arch_ok) = if !exists {
        (None, true)
    } else {
        #[cfg(target_os = "windows")]
        {
            match crate::python::python_version_and_arch(&vpy_path.to_string_lossy()) {
                Some((v, ok)) => (Some(v), ok),
                None => (None, true),
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            (crate::python::python_version(&vpy_path.to_string_lossy()), true)
        }
    };
    let action = venv_action(exists, venv_version.as_deref(), venv_arch_ok);
    if action != VenvAction::Keep {
        // A rebuild deletes what is there, and it only starts here because
        // trainer_base_python has already proven there is something to
        // rebuild WITH.
        if action == VenvAction::Rebuild {
            push_log(state, &match venv_version.as_deref() {
                Some(v) if !venv_arch_ok => format!(
                    "The trainer environment was built with Python {v} at {}, which is not a 64-bit x86 build: no PyTorch wheel exists for it. Rebuilding it with Python {base_version}, your training images and base models are left alone.",
                    vpy_path.display(),
                ),
                Some(v) => format!("The trainer environment was built with Python {v}, which the trainer cannot use (it needs {TRAINER_PYTHON_RANGE}). Rebuilding it with Python {base_version}, your training images and base models are left alone."),
                None => "The trainer environment is there but its Python does not start any more. Rebuilding it from scratch, your training images and base models are left alone.".to_string(),
            });
        }
        set_status(state, status_kind, &format!("{tag} (2/4): creating the training environment (venv)..."));
        let mut venv = foreign_system_command(python_bin);
        venv.args(venv_create_args(action)).arg(root.join("venv"));
        run_streamed(venv, "venv create", state, cancel, pid_slot)?;
    }
    let vpy = venv_python(root).to_string_lossy().to_string();

    // 3) torch, from the channel the plan above picked: Blackwell gets cu128,
    // every other NVIDIA card keeps cu121, an AMD card on Linux gets ROCm.
    set_status(state, status_kind, &format!("{tag} (3/4): installing PyTorch into the trainer venv (~2.5 GB, one time)..."));
    push_log(state, &wheel_note);
    let mut torch_args = vec!["-m", "pip", "install", "--progress-bar", "off", "--no-input"];
    // A finished but WRONG torch satisfies pip and would never be replaced:
    // cu121 on a Blackwell box, or the half install a repair was called for.
    if force_reinstall {
        torch_args.push("--force-reinstall");
    }
    torch_args.extend(["torch", "torchvision", "--index-url", torch_index]);
    let vpy_for_torch = vpy.clone();
    pip_with_retry(
        || {
            let mut torch = foreign_system_command(&vpy_for_torch);
            torch.args(&torch_args);
            apply_trainer_cache_env(&mut torch, root, trainer_root_is_customized());
            torch
        },
        "torch install",
        state,
        cancel,
        pid_slot,
    )?;

    // 4) musubi + deps
    set_status(state, status_kind, &format!("{tag} (4/4): installing the trainer package..."));
    let vpy_for_pkg = vpy.clone();
    pip_with_retry(
        || {
            let mut pkg = foreign_system_command(&vpy_for_pkg);
            pkg.args(["-m", "pip", "install", "--progress-bar", "off", "--no-input", "-e", "."])
                .current_dir(repo_dir(root));
            apply_trainer_cache_env(&mut pkg, root, trainer_root_is_customized());
            pkg
        },
        "musubi install",
        state,
        cancel,
        pid_slot,
    )?;

    // 5) the environment has to LOAD, not just be on disk. A torch whose
    // native libraries will not start passed every step above and was found
    // out by the run, ten minutes later, with a traceback and a link to
    // microsoft.com. On Windows the missing piece is the Visual C++ runtime,
    // and winget installs it; the customer only has to say yes to Windows.
    set_status(state, status_kind, &format!("{tag}: checking that PyTorch loads..."));
    let gpu = training_gpu_label();
    let venv_exe = venv_python(root);
    if let Preflight::TorchBroken(first_tail) = probe_trainer_env(root, &venv_exe, gpu, device, "after setup").verdict {
        let mut tail = first_tail;
        if std::env::consts::OS == "windows" && runtime_library_missing(&tail) {
            set_status(
                state,
                status_kind,
                "Installing the Microsoft Visual C++ runtime that PyTorch loads (Windows will ask for permission)...",
            );
            match winget_install("Microsoft.VCRedist.2015+.x64", false, state, cancel, pid_slot) {
                Ok(()) => push_log(state, "The Visual C++ runtime is installed."),
                Err(e) if e == "cancelled" => return Err(e),
                Err(e) => push_log(state, &format!("LU could not install the Visual C++ runtime: {}", useful_tail(&e))),
            }
            match probe_trainer_env(root, &venv_exe, gpu, device, "after the runtime install").verdict {
                Preflight::TorchBroken(again) => tail = again,
                _ => return Ok(()),
            }
        }
        return Err(format!("PyTorch does not load in the trainer environment.\n{tail}"));
    }
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
    let engine = crate::commands::comfy_folders::cached();
    let dit = resolve_base_file(&root, comfy.as_deref(), engine.as_ref(), DIT_CANDIDATES, "diffusion_models");
    let te = resolve_base_file(&root, comfy.as_deref(), engine.as_ref(), TE_CANDIDATES, "text_encoders");
    let vae = resolve_base_file(&root, comfy.as_deref(), engine.as_ref(), VAE_CANDIDATES, "vae");
    let install = state.trainer_install.lock().unwrap();
    // K5 point 3/5: `customized` lets the frontend say the truth about where
    // this install target actually is instead of assuming the default, and
    // `suggestedRoot` is the sibling-of-ComfyUI suggestion from point 5,
    // computed only while there is nothing customized yet to suggest over.
    let customized = trainer_root_is_customized();
    // `root` is exactly the default app-data trainer folder here: this branch
    // only runs when `customized` is false, and `trainer_root` returns that
    // same default in that case.
    let suggested_root = if customized { None } else { suggested_trainer_root(comfy.as_deref(), &root) };
    Ok(serde_json::json!({
        "envReady": env_ready,
        "basesReady": dit.is_some() && te.is_some() && vae.is_some(),
        "missingBases": missing_bases([dit.is_some(), te.is_some(), vae.is_some()]),
        "dit": dit.map(|p| p.to_string_lossy().to_string()),
        "textEncoder": te.map(|p| p.to_string_lossy().to_string()),
        "vae": vae.map(|p| p.to_string_lossy().to_string()),
        "root": root.to_string_lossy().to_string(),
        "customized": customized,
        "suggestedRoot": suggested_root,
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
    if set.is_empty() {
        return Err("invalid set id".to_string());
    }
    let img_dir = trainer_root(&app).join("train").join(&set).join("img");
    let staged = stage_image_into(&img_dir, &filename, &fileBytes, &caption)?;
    Ok(serde_json::json!({"staged": staged}))
}

/// The caption as it goes into the sidecar: one line, runs of whitespace
/// (line breaks a pasted description brings along) folded to one space, and
/// capped. musubi reads the whole file and only strips its ends
/// (dataset/datasources.py `get_caption`: `f.read().strip()`), so a line
/// break would land inside the prompt the text encoder sees.
pub(crate) fn caption_file_text(caption: &str) -> String {
    const MAX_CHARS: usize = 600;
    let folded = caption.split_whitespace().collect::<Vec<_>>().join(" ");
    folded.chars().take(MAX_CHARS).collect::<String>().trim_end().to_string()
}

/// Write one photo and its caption into the set's image folder, the layout
/// musubi expects with `caption_extension = ".txt"`: `name.png` next to
/// `name.txt` (docs/dataset_config.md, "the captions are stored in text files
/// with the same filename as the image"). Returns the photo's file name.
pub(crate) fn stage_image_into(img_dir: &Path, filename: &str, bytes: &[u8], caption: &str) -> Result<String, String> {
    let name = sanitize_component(filename.trim_end_matches(|c: char| c.is_ascii_alphanumeric()).trim_end_matches('.'));
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "webp"].contains(&ext.as_str()) {
        return Err("unsupported image type (png, jpg, webp)".to_string());
    }
    if bytes.is_empty() || bytes.len() > 40 * 1024 * 1024 {
        return Err("image is empty or larger than 40 MB".to_string());
    }
    fs::create_dir_all(img_dir).map_err(|e| format!("could not create the set dir: {}", os_error::english(&e)))?;
    let base = if name.is_empty() { format!("photo_{}", bytes.len() % 100000) } else { name };
    let stem = free_stem(img_dir, &base, &ext, bytes);
    fs::write(img_dir.join(format!("{stem}.{ext}")), bytes)
        .map_err(|e| format!("could not write the photo: {}", os_error::english(&e)))?;
    // Caption sidecar: trigger word comes first (the frontend builds it,
    // lib/train-captions.ts) because musubi has no trigger mechanism of its
    // own, the token must live in every caption. Since 3.0.8 (D28) a photo's
    // own description of what changes (clothes, hair, place) follows it.
    fs::write(img_dir.join(format!("{stem}.txt")), caption_file_text(caption))
        .map_err(|e| format!("could not write the caption: {}", os_error::english(&e)))?;
    Ok(format!("{stem}.{ext}"))
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

/// The mixed-precision recipe a card's own compute capability can run.
/// Nachbesserung after the Opus review of `0e826c22`/`4a3ba7a0`: `--mixed_precision
/// bf16 --fp8_base --fp8_scaled --optimizer_type adamw8bit` used to be fixed
/// regardless of the card.
///
/// `--fp8_base`/`--fp8_scaled` are weight STORAGE, not a compute path: read
/// in the trainer's own source, `src/musubi_tuner/modules/fp8_optimization_utils.py:365-433`
/// (`fp8_linear_forward_patch`). SM 8.9 is required only for `use_scaled_mm`
/// (`torch._scaled_mm`, lines 409/411), which this recipe never sets; the
/// default path (lines 418-433) dequantizes the stored fp8 weight back to
/// bf16 and calls plain `F.linear`, which runs on any CUDA card. fp8 storage
/// therefore stays on for any measured card, regardless of capability.
///
/// `--optimizer_type adamw8bit` stays on too: bitsandbytes' README states
/// "SM60+ minimum" for its CUDA build, well below the floor bf16 itself
/// needs (see below), so any card that clears bf16 clears this too.
///
/// bf16 is NOT optional the way `--mixed_precision fp16` would suggest, and
/// this recipe never actually offers fp16 any more (Nachbesserung Runde 4,
/// Opus review Runde 3 of bau/review-trainer.md): read in the trainer's own
/// source, `src/musubi_tuner/zimage/zimage_utils.py:123` dequantizes the
/// DiT's fp8 weight straight to `torch.bfloat16` on load, and
/// `zimage_utils.py:211` wraps the text encoder cache step in
/// `torch.autocast(dtype=torch.bfloat16)`, hardcoded, independent of
/// `--mixed_precision`. A card without bf16 hardware therefore dies in the
/// text encoder cache step regardless of what this recipe picks; `fp16` was
/// never a rescue for this model, only a second, later, equally silent way
/// to die. `capability_floor_refusal` (compute capability 8.0, Ampere) is
/// what actually protects a card like this now, called before any card ever
/// reaches this function: `install_character_trainer`/`provision_trainer_env`
/// before the torch download, and `start_character_training` again before
/// every run, download or not. This function can therefore assume any
/// MEASURED capability it sees has already cleared that floor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TrainPrecision {
    pub(crate) mixed_precision: &'static str,
    pub(crate) save_precision: &'static str,
    pub(crate) fp8: bool,
    pub(crate) optimizer_type: &'static str,
}

/// `cap` is `None` only when the preflight could not read one at all (a
/// probe that failed to run, or a non-NVIDIA card `capability_floor_refusal`
/// has no opinion on), which should never reach step 3 on NVIDIA: kept
/// conservative (fp16, no fp8, plain AdamW) rather than assuming the best
/// case on an unmeasured card. Any MEASURED capability has already cleared
/// `capability_floor_refusal`'s bf16 floor by the time it reaches here, see
/// the doc comment on `TrainPrecision`.
pub(crate) fn train_precision_for_capability(cap: Option<(u32, u32)>) -> TrainPrecision {
    if cap.is_none() {
        return TrainPrecision { mixed_precision: "fp16", save_precision: "fp16", fp8: false, optimizer_type: "AdamW" };
    }
    TrainPrecision { mixed_precision: "bf16", save_precision: "bf16", fp8: true, optimizer_type: "adamw8bit" }
}

/// The dataset config every step of the run reads (docs/dataset_config.md):
/// the preset's square resolution, `.txt` captions next to the photos, batch 1.
pub(crate) fn dataset_toml(img_dir: &Path, cache_dir: &Path, repeats: usize, preset: TrainPreset) -> String {
    let res = preset.resolution();
    format!(
        "[general]\nresolution = [{res}, {res}]\ncaption_extension = \".txt\"\nbatch_size = 1\nenable_bucket = true\nbucket_no_upscale = false\n\n[[datasets]]\nimage_directory = '{}'\ncache_directory = '{}'\nnum_repeats = {}\n",
        img_dir.to_string_lossy().replace('\\', "/"),
        cache_dir.to_string_lossy().replace('\\', "/"),
        repeats,
    )
}

/// The files and numbers one run of step 3 is made of.
struct TrainStep<'a> {
    dit: &'a str,
    vae: &'a str,
    text_encoder: &'a str,
    dataset: &'a str,
    steps: &'a str,
    out_dir: &'a str,
    out_name: &'a str,
    precision: TrainPrecision,
    preset: TrainPreset,
}

/// Step 3, the train itself: the venv's own python runs musubi's trainer, the
/// same way steps 1, 2 and 4 do.
///
/// It used to be `accelerate launch <script>`, which is what musubi's README
/// writes, and that is what GitHub #121 (two cards) and the Discord
/// report (2026-09-09) died on:
///
///   RuntimeError: use_libuv was requested but PyTorch was build without
///   libuv support
///
/// `accelerate launch` with no `--num_processes` sets `num_processes =
/// torch.cuda.device_count()` and turns multi-GPU on by itself as soon as that
/// is more than one. A second card therefore silently swapped LU's one-card
/// recipe onto torch's elastic launcher, which opens a rendezvous TCPStore,
/// and the Windows wheels carry no libuv. That store is built from rendezvous
/// parameters and never reads the USE_LIBUV environment variable, so no
/// environment fix reaches it (`torch/distributed/elastic/rendezvous/
/// c10d_rendezvous_backend.py`, read 2026-09-11). `--num_processes 1` is no
/// answer either: a leftover `accelerate config` from any other tool is read
/// first, and a config that says MULTI_GPU turns the same flag into
/// "You need to use at least 2 processes to use `--multi_gpu`".
///
/// For a single process the launcher does nothing else: accelerate's
/// `simple_launcher` sets OMP_NUM_THREADS and runs `python <script> <args>`
/// (`prepare_simple_launcher_cmd_env`). So this is that, minus the launcher,
/// minus its guesses about the machine. `--mixed_precision bf16` was already
/// among the script's own arguments; musubi passes it to `Accelerator`.
fn training_command(vpy: &str, repo: &Path, step: &TrainStep<'_>) -> Command {
    let mut cmd = foreign_system_command(vpy);
    // What `--num_cpu_threads_per_process 1` used to set, nothing more.
    cmd.current_dir(repo).env("OMP_NUM_THREADS", "1").arg("src/musubi_tuner/zimage_train_network.py").args([
        "--dit", step.dit,
        "--vae", step.vae,
        "--text_encoder", step.text_encoder,
        "--dataset_config", step.dataset,
    ]);
    cmd.args(["--sdpa", "--mixed_precision", step.precision.mixed_precision]);
    if step.precision.fp8 {
        cmd.args(["--fp8_base", "--fp8_scaled"]);
    }
    cmd.args([
        "--blocks_to_swap", step.preset.blocks_to_swap(),
        "--timestep_sampling", "shift", "--weighting_scheme", "none", "--discrete_flow_shift", "2.0",
        "--optimizer_type", step.precision.optimizer_type, "--learning_rate", "1e-4", "--gradient_checkpointing",
    ]);
    if step.preset.offloads_activations() {
        cmd.arg("--gradient_checkpointing_cpu_offload");
    }
    cmd.args([
        "--max_data_loader_n_workers", "2", "--persistent_data_loader_workers",
        "--network_module", "networks.lora_zimage", "--network_dim", step.preset.network_dim(),
        "--max_train_steps", step.steps,
        "--save_precision", step.precision.save_precision,
        "--seed", "42",
        "--output_dir", step.out_dir,
        "--output_name", step.out_name,
    ]);
    cmd
}

#[allow(non_snake_case)]
// The arguments are the fields of the IPC call (api/trainer.ts), one each.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn start_character_training(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    setId: String,
    name: String,
    triggerWord: String,
    steps: Option<u32>,
    preset: Option<String>,
    kind: Option<String>,
) -> Result<serde_json::Value, String> {
    let preset = TrainPreset::from_arg(preset.as_deref());
    let kind = TrainKind::from_arg(kind.as_deref());
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
    push_log(&state.trainer_run, &format!("Trainer setting: {}.", preset.label()));

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
    let engine = crate::commands::comfy_folders::cached();
    let (Some(dit), Some(te), Some(vae)) = (
        resolve_base_file(&root, comfy.as_deref(), engine.as_ref(), DIT_CANDIDATES, "diffusion_models"),
        resolve_base_file(&root, comfy.as_deref(), engine.as_ref(), TE_CANDIDATES, "text_encoders"),
        resolve_base_file(&root, comfy.as_deref(), engine.as_ref(), VAE_CANDIDATES, "vae"),
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
        .map(comfy_loras_dir)
        .unwrap_or_else(|| root.join("out"));

    let run = state.trainer_run.clone();
    let cancel = state.trainer_cancel.clone();
    let pid_slot = state.trainer_process.clone();
    let env_broken = state.trainer_env_broken.clone();
    // T-65: the training thread outlives this `State` borrow, so resolve
    // ComfyUI's ACTUAL address here (user-configured host/port from AppState,
    // not a hardcoded localhost:8188) and move the verdict in.
    let comfy_vram_target = crate::commands::process::comfy_vram_target(state.inner());
    // Same reason, same pattern: resolved for real (nvidia-smi and all)
    // inside the thread, from the Hardware tab's own pick, so a repair mid
    // run and the training step after it measure and train the same card.
    let gpu_selection = state.gpu_selection.lock().map_err(|e| e.to_string())?.clone();
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
        let toml = dataset_toml(&img_dir, &cache_dir, repeats, preset);
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
        // (a user D#102 with a stale cu121 torch with an
        // install that stopped before the trainer package). The customer
        // should not need install instructions, so the run fixes its own
        // environment and carries on.
        // Asked once and reused by both probes: the same vendor list the
        // install plans from, so the check and the repair cannot disagree
        // about what is in the machine.
        let gpu_label = training_gpu_label();
        // Resolved once, used everywhere below: the same card the VRAM
        // preflight measures is the one CUDA_VISIBLE_DEVICES pins the whole
        // run to (Opus review of K3: measuring device 0 while training
        // whatever the Hardware tab or the user's own environment chose was
        // the same class of bug as pinning the run to a bare index).
        let device = resolve_trainer_gpu(&gpu_selection);
        match &device {
            Some(d) => push_log(&run, &format!(
                "Training on {} (index {}, {}, {}).",
                d.name,
                d.index,
                d.source,
                d.memory_mib.map_or("memory unknown".to_string(), |m| format!("{:.0} GB", m as f64 / 1024.0)),
            )),
            None => push_log(&run, "Could not identify a single NVIDIA card to pin the run to; letting the driver pick."),
        }

        set_status(&run, "running", "Checking the training environment...");
        let first = probe_trainer_env(&root, &vpy, gpu_label, device.as_ref(), "first check");
        let verdict = first.verdict;
        let mut vram_mib = first.vram_mib;
        let mut cap = first.cap;
        if !verdict.is_ok() {
            push_log(&run, &verdict.message());
            push_log(&run, "Repairing it now, no action needed. Your training images and base models are left alone.");
            let force = verdict.needs_torch_reinstall();
            if let Err(e) = provision_trainer_env(&root, &python_bin, force, &run, "running", &cancel, &pid_slot, device.as_ref()) {
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
            let repaired = probe_trainer_env(&root, &vpy, gpu_label, device.as_ref(), "after repair");
            let after = repaired.verdict;
            vram_mib = repaired.vram_mib;
            cap = repaired.cap;
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
        // Nachbesserung Runde 4: `provision_trainer_env`'s own
        // `capability_floor_refusal` call only fires on a fresh install or a
        // repair. A card that already has a HEALTHY environment (the common
        // case on a second run) skips that whole branch and would otherwise
        // reach `train_precision_for_capability` with a capability the
        // recipe cannot actually honour. This is the same refusal, reusing
        // the capability the preflight already measured instead of a second
        // nvidia-smi call, so every run gets it, downloaded or not.
        if let Some(c) = cap {
            let name = device.as_ref().map_or("This GPU", |d| d.name.as_str());
            if let Some(msg) = capability_floor_refusal(c, name) {
                set_status(&run, "error", &msg);
                return;
            }
        }
        // The recipe, chosen from the same capability the preflight just
        // read: the VRAM floor right below depends on it (Runde 2, a fixed
        // 12 GB floor was precision-blind).
        let precision = train_precision_for_capability(cap);
        push_log(&run, &format!(
            "Training recipe: {} mixed precision, fp8 weights {}, optimizer {}.",
            precision.mixed_precision,
            if precision.fp8 { "on" } else { "off" },
            precision.optimizer_type,
        ));

        // The card's memory, before ten minutes of caching: below the
        // recipe's own floor the run dies in the first training step.
        if let Some(msg) = vram_verdict(vram_mib, &precision, preset) {
            set_status(&run, "error", &msg);
            return;
        }

        // Cancel can arrive while no child is alive: during the environment
        // probe (a plain Command::output, nothing in pid_slot) or between two
        // children. The flag alone does nothing then, and the next child
        // would be spawned only to be killed on its first poll, or, worse,
        // never noticed. Measured on the box on 06.09.2026: a Cancel 14 s
        // after Create left the run training on while the UI had gone idle.
        if cancel_requested(&cancel) {
            set_status(&run, "cancelled", "cancelled");
            return;
        }

        // K5 Punkt 13: read once and reused by every step below, rather than
        // re-reading config.json four times for what has to be the same
        // answer within one run.
        let cache_customized = trainer_root_is_customized();

        // 1) latent cache
        set_status(&run, "running", "Step 1/4: Caching image latents...");
        let mut c1 = foreign_system_command(&vpy_s);
        c1.current_dir(&repo).args([
            "src/musubi_tuner/zimage_cache_latents.py",
            "--dataset_config", &toml_s,
            "--vae", &vae_s,
        ]);
        apply_trainer_cache_env(&mut c1, &root, cache_customized);
        if let Some(d) = &device {
            pin_trainer_gpu(&mut c1, d);
        }
        if let Err(e) = run_streamed(c1, "latent cache", &run, &cancel, &pid_slot) {
            end_failed_run(&run, &e, vram_mib);
            return;
        }

        if cancel_requested(&cancel) {
            set_status(&run, "cancelled", "cancelled");
            return;
        }
        // 2) text-encoder cache (fp8 keeps the 4B Qwen TE inside 12 GB)
        set_status(&run, "running", "Step 2/4: Caching text encoder outputs...");
        let mut c2 = foreign_system_command(&vpy_s);
        c2.current_dir(&repo).args([
            "src/musubi_tuner/zimage_cache_text_encoder_outputs.py",
            "--dataset_config", &toml_s,
            "--text_encoder", &te_s,
            "--batch_size", preset.text_encoder_batch(),
            "--fp8_llm",
        ]);
        apply_trainer_cache_env(&mut c2, &root, cache_customized);
        if let Some(d) = &device {
            pin_trainer_gpu(&mut c2, d);
        }
        if let Err(e) = run_streamed(c2, "text encoder cache", &run, &cancel, &pid_slot) {
            end_failed_run(&run, &e, vram_mib);
            return;
        }

        if cancel_requested(&cancel) {
            set_status(&run, "cancelled", "cancelled");
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
        set_status(&run, "running", &format!("Step 3/4: Training ({steps} steps). This runs for a while, the counter follows every step."));
        let steps_s = steps.to_string();
        let out_name = kind.output_name(&lora_name);
        let out_dir_s = out_dir.to_string_lossy().to_string();
        let mut c3 = training_command(&vpy_s, &repo, &TrainStep {
            dit: &dit_s,
            vae: &vae_s,
            text_encoder: &te_s,
            dataset: &toml_s,
            steps: &steps_s,
            out_dir: &out_dir_s,
            out_name: &out_name,
            precision,
            preset,
        });
        apply_trainer_cache_env(&mut c3, &root, cache_customized);
        if let Some(d) = &device {
            pin_trainer_gpu(&mut c3, d);
        }
        if let Err(e) = run_streamed(c3, "training", &run, &cancel, &pid_slot) {
            end_failed_run(&run, &e, vram_mib);
            return;
        }

        if cancel_requested(&cancel) {
            set_status(&run, "cancelled", "cancelled");
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
        let mut c4 = foreign_system_command(&vpy_s);
        c4.current_dir(&repo).args([
            "src/musubi_tuner/convert_lora.py",
            "--input", &trained.to_string_lossy(),
            "--output", &final_path.to_string_lossy(),
            "--target", "other",
        ]);
        apply_trainer_cache_env(&mut c4, &root, cache_customized);
        if let Some(d) = &device {
            pin_trainer_gpu(&mut c4, d);
        }
        if let Err(e) = run_streamed(c4, "lora convert", &run, &cancel, &pid_slot) {
            end_failed_run(&run, &e, vram_mib);
            return;
        }
        // The set's photos now belong to this file: Edit hands them out as
        // reference images of the character (character_files.rs). A style's
        // pictures are no one's likeness, so they stay out of that.
        if kind == TrainKind::Character {
            crate::commands::character_files::write_training_marker(&set_dir, &final_path);
        }

        set_status(&run, "complete", &kind.finished_line(&format!("{out_name}.safetensors"), &final_path, &trigger));
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
/// with no UI left to stop it. The whole tree matters: the train step keeps
/// two persistent data loader workers of its own under it.
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
    // Kill the live child directly too: pip and the trainer ignore the flag.
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

    /// GH #183: a trained LoRA goes into the configured shared `loras`
    /// folder, and a base model downloaded there is found for the next run.
    #[test]
    fn training_reads_and_writes_the_configured_folders() {
        let root = std::env::temp_dir().join(format!("lu-train-183-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let comfy = root.join("ComfyUI");
        let shared = root.join("shared");
        std::fs::create_dir_all(&comfy).unwrap();
        std::fs::create_dir_all(shared.join("vae")).unwrap();
        std::fs::write(shared.join("vae").join("ae.safetensors"), b"x").unwrap();
        // Without a config: the instance folder, as before.
        assert_eq!(super::comfy_loras_dir(&comfy), comfy.join("models").join("loras"));
        std::fs::write(
            comfy.join("extra_model_paths.yaml"),
            format!("s:\n  base_path: '{}'\n  loras: loras\n  vae: vae\n", shared.display()),
        )
        .unwrap();
        assert_eq!(super::comfy_loras_dir(&comfy), shared.join("loras"));
        let trainer_root = root.join("trainer");
        assert_eq!(
            super::resolve_base_file(&trainer_root, Some(&comfy), None, &["ae.safetensors"], "vae"),
            Some(shared.join("vae").join("ae.safetensors")),
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Discord 25.10.2026 (Comfy Desktop): the base files sat in a folder the
    /// running ComfyUI scans and the downloader writes to, outside
    /// `<ComfyUI>/models` and outside any config LU reads. The panel called all
    /// three missing and the download answered "exists" for each.
    #[test]
    fn base_files_in_a_folder_the_running_comfyui_reports_are_found() {
        let root = std::env::temp_dir().join(format!("lu-train-engine-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let comfy = root.join("ComfyUI-Installs").join("ComfyUI").join("ComfyUI");
        let shared = root.join("shared-models");
        std::fs::create_dir_all(comfy.join("models").join("text_encoders")).unwrap();
        std::fs::create_dir_all(shared.join("text_encoders")).unwrap();
        std::fs::write(shared.join("text_encoders").join("qwen_3_4b.safetensors"), b"x").unwrap();
        let trainer_root = root.join("trainer");
        // What LU knew before: nothing in the instance folder, no config.
        assert_eq!(super::resolve_base_file(&trainer_root, Some(&comfy), None, super::TE_CANDIDATES, "text_encoders"), None);
        let engine = crate::commands::comfy_folders::ComfyFolders::parse(&serde_json::json!({
            "text_encoders": [
                comfy.join("models").join("text_encoders").to_string_lossy(),
                shared.join("text_encoders").to_string_lossy(),
            ],
        }));
        assert_eq!(
            super::resolve_base_file(&trainer_root, Some(&comfy), Some(&engine), super::TE_CANDIDATES, "text_encoders"),
            Some(shared.join("text_encoders").join("qwen_3_4b.safetensors")),
        );
        let _ = std::fs::remove_dir_all(&root);
    }

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
        // The reader closure above the wait loop checks the same flag (it
        // drops what the dying child prints), so anchor on the loop itself.
        let warte = &src[src.find("fn run_child(").expect("run_child")..];
        let warte = &warte[warte.find("let exit = loop {").expect("wait loop")..];
        let zweig = warte
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
        // A user: no NVIDIA card, so the old probe answered None
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
        // The CUDA wheels the old plan put on a user's box: torch imports,
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
        // A ROCm build lists gfx names, not sm names, and a user's RX 9070
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

    /// The Opus review's lower bound (Nachbesserung 1): a card OLDER than
    /// this build's kernel floor. `preflight_names_the_kernel_gap_on_blackwell_with_cu121`
    /// above is the mirror case; this direction never had a test before.
    #[test]
    fn preflight_names_a_card_below_the_kernel_floor() {
        use super::{preflight_verdict, Preflight};
        // A hypothetical build whose kernels start at sm_70, read against a
        // Maxwell-class card (compute capability 5.0). The concrete melder
        // (Tesla P100, 6.0) is NOT this case -- both real channels carry
        // kernels well below 6.0 -- which is exactly why this stays a
        // synthetic, defensive test rather than a reproduction.
        let out = "TORCH_OK 2.7.0+cu128\nCAP 5 0\nNAME Tesla M40\nARCHS sm_70 sm_75 sm_80 sm_86 sm_90\nMUSUBI_OK\n";
        let v = preflight_verdict(true, out, "", Some("NVIDIA"));
        assert_eq!(
            v,
            Preflight::CardBelowKernelFloor { cap_major: 5, cap_minor: 0, min: 7, name: Some("Tesla M40".to_string()) },
        );
        assert!(v.message().contains("Tesla M40"), "{}", v.message());
        assert!(v.message().contains("5.0"), "{}", v.message());
        assert!(v.message().contains("7.0"), "{}", v.message());
        // No channel trainer_torch_plan picks would fix this: reinstalling is
        // pointless, unlike KernelsTooOld where a newer channel might help.
        assert!(!v.needs_torch_reinstall());
    }

    /// Nachbesserung Runde 2: the pre-download refusal, entirely separate
    /// from `CardBelowKernelFloor` above (that one reads torch's OWN kernel
    /// list, after ~2.5 GB already downloaded; this one reads nvidia-smi
    /// alone, before any of it).
    ///
    /// Nachbesserung Runde 4 (Opus review Runde 3): the floor moved from
    /// bitsandbytes' SM60 to compute capability 8.0. bitsandbytes was never
    /// the real constraint; zimage_utils.py hardcodes bfloat16 in the text
    /// encoder cache step regardless of `--mixed_precision`
    /// (`src/musubi_tuner/zimage/zimage_utils.py:211`), so a card without
    /// bf16 hardware dies there no matter what the optimizer floor allows.
    #[test]
    fn capability_floor_refuses_a_card_without_bf16_hardware() {
        use super::capability_floor_refusal;
        // Maxwell, compute capability 5.0: below the floor by a wide margin.
        let msg = capability_floor_refusal((5, 0), "Tesla M40").expect("below the floor");
        assert!(msg.contains("Tesla M40"), "{msg}");
        assert!(msg.contains("5.0"), "{msg}");
        assert!(msg.contains("8.0"), "names the floor: {msg}");
        assert!(msg.contains("bfloat16"), "names the real reason: {msg}");
        assert!(msg.contains("Cloud mode"), "names the way out: {msg}");
    }

    /// Tesla P100, a user's card: compute capability 6.0. Runde 2 left
    /// this card unrefused (bitsandbytes' own SM60 floor); Runde 3's review
    /// found that wrong, since bf16 is hardcoded in the text encoder cache
    /// step regardless of the optimizer. This is the concrete melder case
    /// the fix protects.
    #[test]
    fn capability_floor_now_refuses_pascal_the_concrete_melder_case() {
        use super::capability_floor_refusal;
        let msg = capability_floor_refusal((6, 0), "Tesla P100").expect("Pascal has no bf16 hardware");
        assert!(msg.contains("Tesla P100"), "{msg}");
        assert!(msg.contains("6.0"), "{msg}");
        assert!(msg.contains("bfloat16"), "{msg}");
    }

    #[test]
    fn capability_floor_clears_ampere_the_proof_box_case() {
        use super::capability_floor_refusal;
        // RTX 3060, our own proof box: compute capability 8.6, above the
        // 8.0 floor.
        assert!(capability_floor_refusal((8, 6), "GeForce RTX 3060").is_none());
        // Exactly the floor clears it too.
        assert!(capability_floor_refusal((8, 0), "Some Ampere Card").is_none());
    }

    #[test]
    fn preflight_catches_the_trainer_package_a_healthy_torch_hides() {
        use super::{preflight_verdict, Preflight};
        // A user: the install died between torch and `pip install -e .`.
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
        // Replayed on a user's environment it says ready; the new one
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

        // venv exists, torch does not: the case.
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

    /// `config.json` is one real file on disk, shared by every test in this
    /// module, and `cargo test` runs them concurrently on one process. Any
    /// test that reads or writes the `trainer_root` key through
    /// `read_config_value`/`write_config_value` takes this lock first, or
    /// two such tests can interleave their reads and writes of the same
    /// file.
    fn config_json_test_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The environment of a built command, as pairs a test can read.
    fn env_of(cmd: &std::process::Command) -> Vec<(String, Option<String>)> {
        cmd.get_envs()
            .map(|(k, v)| (
                k.to_string_lossy().into_owned(),
                v.map(|v| v.to_string_lossy().into_owned()),
            ))
            .collect()
    }

    #[test]
    fn every_trainer_child_gets_utf8_stdio() {
        let mut cmd = std::process::Command::new("python");
        super::trainer_child_env(&mut cmd);
        let envs = env_of(&cmd);
        assert!(envs.contains(&("PYTHONIOENCODING".into(), Some("utf-8".into()))));
        assert!(envs.contains(&("PYTHONUTF8".into(), Some("1".into()))));
        // GitHub #121: the knob is set on every platform, so it is one code
        // path, readable by a test on any machine. Elsewhere it is what torch
        // does by default anyway.
        assert!(
            envs.contains(&("USE_LIBUV".into(), Some("0".into()))),
            "the libuv knob is gone from the trainer children",
        );
    }

    /// K3, 2026-09-18, nachgebessert nach dem Opus-Review: `pin_trainer_gpu`,
    /// not `trainer_child_env`, is what keeps `torch.cuda.device_count() > 1`
    /// from being true inside a trainer child: the review's finding that a
    /// hardcoded index "0" is neither guaranteed to be the strong card nor
    /// respects the Hardware tab's own picker or a user-set
    /// `CUDA_VISIBLE_DEVICES`.
    #[test]
    fn pin_trainer_gpu_narrows_the_child_to_the_chosen_card() {
        let mut cmd = std::process::Command::new("python");
        let choice = super::TrainerGpuChoice {
            index: 1,
            name: "RTX 3090 Ti".to_string(),
            memory_mib: Some(24564),
            uuid: None,
            source: "the Hardware tab's GPU selection",
        };
        super::pin_trainer_gpu(&mut cmd, &choice);
        let envs = env_of(&cmd);
        assert!(
            envs.contains(&("CUDA_VISIBLE_DEVICES".into(), Some("1".into()))),
            "the chosen card's index is not what the child sees: {envs:?}",
        );
        assert!(
            envs.contains(&("CUDA_DEVICE_ORDER".into(), Some("PCI_BUS_ID".into()))),
            "BLOCKER B2 (Runde 2): without this, CUDA's own FASTEST_FIRST default \
             can pin a different physical card than the index promises: {envs:?}",
        );
    }

    /// GPU-UUID Nachzug (review 2026-09-18 Runde 2, "UUID statt Index"): when
    /// `detect_gpus()` could name the chosen card's uuid, the child must see
    /// THAT, not the bare index -- the whole point being independence from
    /// detection order, which a plain index re-introduces the moment
    /// anything hotplugs or gets renumbered between detection and launch.
    /// `CUDA_DEVICE_ORDER` stays set regardless, as the fallback net.
    #[test]
    fn pin_trainer_gpu_prefers_the_uuid_over_the_index_when_known() {
        let mut cmd = std::process::Command::new("python");
        let choice = super::TrainerGpuChoice {
            index: 1,
            name: "RTX 3090 Ti".to_string(),
            memory_mib: Some(24564),
            uuid: Some("GPU-3eb045fd-0000-0000-0000-000000000000".to_string()),
            source: "the Hardware tab's GPU selection",
        };
        super::pin_trainer_gpu(&mut cmd, &choice);
        let envs = env_of(&cmd);
        assert!(
            envs.contains(&(
                "CUDA_VISIBLE_DEVICES".into(),
                Some("GPU-3eb045fd-0000-0000-0000-000000000000".into())
            )),
            "the uuid form must win over the bare index: {envs:?}",
        );
        assert!(
            envs.contains(&("CUDA_DEVICE_ORDER".into(), Some("PCI_BUS_ID".into()))),
            "CUDA_DEVICE_ORDER must stay set even when a uuid is used: {envs:?}",
        );
    }

    /// Trainer-3.0.1-Folgeauftrag B1: every foreign program trainer.rs starts
    /// (python, pip, winget, the venv it builds) now goes through
    /// `foreign_system_command`, the same AppImage-cleanup adapter the
    /// engine branch introduced for K11/K14. That adapter strips
    /// `LD_LIBRARY_PATH`/`PYTHONHOME`/etc. the moment the `Command` is
    /// built; `pin_trainer_gpu` and `trainer_child_env` run AFTER that, on
    /// the same `Command`. This locks the order in: the trainer-specific
    /// variables have to survive a real AppImage cleanup, not merely avoid
    /// being on the poisoned list by accident.
    ///
    /// Uses the guarded `APPDIR` env mutation `process_util`'s own tests
    /// use, since `std::env` is process-wide and `cargo test` runs this
    /// file's tests concurrently on one binary.
    #[test]
    fn trainer_env_survives_the_appimage_cleanup_the_adapter_runs_first() {
        let _guard = crate::process_util::appimage_env_test_guard();
        std::env::set_var("APPDIR", "/tmp/.mount_LocallieGkad");
        std::env::set_var(
            "LD_LIBRARY_PATH",
            "/tmp/.mount_LocallieGkad/usr/lib:/tmp/.mount_LocallieGkad/usr/lib/x86_64-linux-gnu",
        );
        let mut cmd = super::foreign_system_command("python3");
        super::trainer_child_env(&mut cmd);
        let choice = super::TrainerGpuChoice {
            index: 1,
            name: "RTX 3090 Ti".to_string(),
            memory_mib: Some(24564),
            uuid: None,
            source: "the Hardware tab's GPU selection",
        };
        super::pin_trainer_gpu(&mut cmd, &choice);
        cmd.env("HF_HOME", "/data/lu/trainer/cache/huggingface");
        let envs = env_of(&cmd);
        assert!(
            envs.contains(&("LD_LIBRARY_PATH".into(), None)),
            "the AppImage-poisoned LD_LIBRARY_PATH must actually be gone: {envs:?}",
        );
        assert!(
            envs.contains(&("CUDA_VISIBLE_DEVICES".into(), Some("1".into()))),
            "the GPU pin must survive the adapter's cleanup: {envs:?}",
        );
        assert!(
            envs.contains(&("CUDA_DEVICE_ORDER".into(), Some("PCI_BUS_ID".into()))),
            "CUDA_DEVICE_ORDER must survive the adapter's cleanup: {envs:?}",
        );
        assert!(
            envs.contains(&("PYTHONUTF8".into(), Some("1".into()))),
            "trainer_child_env's variables must survive the adapter's cleanup: {envs:?}",
        );
        assert!(
            envs.contains(&("HF_HOME".into(), Some("/data/lu/trainer/cache/huggingface".into()))),
            "the trainer's own cache variables must survive the adapter's cleanup: {envs:?}",
        );
        std::env::remove_var("APPDIR");
        std::env::remove_var("LD_LIBRARY_PATH");
    }

    // ── B2 (K5 Punkt 13): pip/HF/torch caches follow trainer_root ──────────

    /// The five cache variables, all under the SAME root, none collapsing
    /// onto each other.
    #[test]
    fn every_cache_follows_the_configured_root() {
        let root = Path::new("/mnt/big-drive/musubi");
        let env = super::trainer_cache_env(root);
        assert_eq!(env.len(), 5);
        for (name, path) in &env {
            assert!(
                path.starts_with(root),
                "{name} ({}) is not under the configured trainer_root {}",
                path.display(),
                root.display(),
            );
        }
        let names: Vec<&str> = env.iter().map(|(n, _)| *n).collect();
        assert_eq!(names, ["PIP_CACHE_DIR", "HF_HOME", "HF_XET_CACHE", "TORCH_HOME", "XDG_CACHE_HOME"]);
        let hf_home = &env[1].1;
        let hf_xet = &env[2].1;
        assert!(hf_xet.starts_with(hf_home), "HF_XET_CACHE must live under HF_HOME: {hf_xet:?} / {hf_home:?}");
    }

    /// Negative control: two DIFFERENT roots must not collapse onto the same
    /// cache directory. A function that ignored its argument and always
    /// returned a fixed path would still pass the "under root" check above
    /// for a single root; this catches that.
    #[test]
    fn two_different_roots_get_two_different_cache_trees() {
        let a = super::trainer_cache_env(Path::new("/data/a"));
        let b = super::trainer_cache_env(Path::new("/data/b"));
        for ((_, pa), (_, pb)) in a.iter().zip(b.iter()) {
            assert_ne!(pa, pb, "{pa:?} should differ from {pb:?}");
        }
    }

    /// Migration case: the user DID set a custom `trainer_root`, so the
    /// caches are meant to follow it there. Behavioural test against
    /// `apply_trainer_cache_env` itself (not the real config file), the same
    /// function every real call site calls with `trainer_root_is_customized()`.
    #[test]
    fn a_customized_root_redirects_every_cache_onto_it() {
        let root = Path::new("/mnt/big-drive/musubi");
        let mut cmd = std::process::Command::new("python");
        super::apply_trainer_cache_env(&mut cmd, root, true);
        let envs = env_of(&cmd);
        for (name, path) in super::trainer_cache_env(root) {
            assert!(
                envs.contains(&(name.to_string(), Some(path.to_string_lossy().into_owned()))),
                "{name} must point under the customized root: {envs:?}",
            );
        }
    }

    /// Negative control, the actual point of B2: on the DEFAULT root
    /// (`customized: false`), nothing is set at all. A customer who never
    /// touched the `trainer_root` setting keeps pip/HF/torch pointed at
    /// wherever they already were; setting these variables unconditionally
    /// would silently orphan a multi-GB cache already sitting at the OS
    /// default location and pay for the same downloads a second time.
    #[test]
    fn the_default_root_leaves_every_cache_variable_unset() {
        let root = Path::new("/mnt/big-drive/musubi");
        let mut cmd = std::process::Command::new("python");
        super::apply_trainer_cache_env(&mut cmd, root, false);
        assert_eq!(cmd.get_envs().count(), 0, "the default root must not touch the child's environment at all");
    }

    /// `trainer_root_is_customized` mirrors exactly the check `trainer_root`
    /// itself makes on the same config key: present and non-empty is
    /// customized, missing or blank ("", an explicitly cleared override,
    /// distinct from a missing key, and `trainer_root` itself treats the
    /// two identically, falling through to its default join in both cases)
    /// is the default. Exercised against the REAL `config.json`
    /// `read_config_value`/`write_config_value` read and write (there is no
    /// dependency injection for it in this file), guarded so a run on a
    /// machine that already has a `trainer_root` override set does not lose
    /// it.
    #[test]
    fn trainer_root_is_customized_matches_trainer_roots_own_override_check() {
        let _guard = config_json_test_guard();
        let backup = super::read_config_value("trainer_root");
        super::write_config_value("trainer_root", "");
        assert!(!super::trainer_root_is_customized(), "an explicitly empty override must read as the default, not as customized");
        super::write_config_value("trainer_root", "/mnt/big-drive/musubi");
        assert!(super::trainer_root_is_customized(), "a real override must read as customized");
        match backup {
            Some(value) => super::write_config_value("trainer_root", &value),
            None => {
                // write_config_value has no delete: put back an empty
                // override, which trainer_root_is_customized reads the same
                // way as "the key was never there" (see the doc comment
                // above), so a machine with no prior override is left
                // exactly as it started.
                super::write_config_value("trainer_root", "");
            }
        }
    }

    // ── K5 Nachbesserung (Opus review of `4fda5a0a`, three blockers) ───────

    #[test]
    fn a_leading_tilde_is_never_accepted() {
        assert!(super::starts_with_tilde("~/LU-Trainer"));
        assert!(super::starts_with_tilde("~"));
        assert!(!super::starts_with_tilde("/home/alex/LU-Trainer"), "an absolute path must not be flagged");
        assert!(!super::starts_with_tilde("D:\\LU-Trainer"), "a drive path must not be flagged");
    }

    /// BLOCKER 1: the field's own example must be an absolute path on every
    /// platform, never the tilde Rust does not resolve.
    #[test]
    fn the_example_path_is_absolute_on_every_platform() {
        assert!(!super::example_trainer_path().starts_with('~'), "the example itself must not be the mistake it warns against");
    }

    /// BLOCKER 1, negative control: a leading tilde is refused before
    /// anything is written or created, so the historic bug (a literal folder
    /// named `~`) cannot happen any more.
    #[test]
    fn validate_trainer_root_candidate_rejects_a_leading_tilde() {
        let err = super::validate_trainer_root_candidate("~/LU-Trainer").expect_err("a tilde must be refused");
        assert!(err.contains('~'), "the message must name the actual problem: {err}");
        assert!(!Path::new("~").exists(), "no literal ~ folder must have been created");
    }

    /// BLOCKER 2, negative control: a relative path is refused, not silently
    /// resolved against the process's current directory.
    #[test]
    fn validate_trainer_root_candidate_rejects_a_relative_path() {
        let err = super::validate_trainer_root_candidate("LU-Trainer").expect_err("a relative path must be refused");
        assert!(err.contains("absolute"), "the message must say why: {err}");
    }

    /// BLOCKER 2, the fix itself: an absolute, creatable, writable path is
    /// accepted, the directory exists afterward, and the write probe this
    /// function used to prove writability is cleaned up again.
    #[test]
    fn validate_trainer_root_candidate_accepts_a_real_absolute_folder() {
        let root = std::env::temp_dir().join(format!("lu-trainer-validate-ok-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        // Room is given, not measured: a build machine with a nearly full
        // drive refused this folder for a reason the test is not about.
        let roomy = |_: &Path| Some(u64::MAX);
        let accepted = super::validate_trainer_root_candidate_with(&root.to_string_lossy(), roomy)
            .expect("a real, writable folder must be accepted");
        assert_eq!(accepted, root);
        assert!(root.is_dir(), "the folder must exist after validation");
        assert!(!root.join(".lu-write-check").exists(), "the write probe must be cleaned up, not left behind");
        fs::remove_dir_all(&root).unwrap();
    }

    /// A drive without room is refused before anything is created, so the
    /// rejection leaves no empty folder behind.
    #[test]
    fn validate_trainer_root_candidate_refuses_a_full_drive_and_creates_nothing() {
        let root = std::env::temp_dir().join(format!("lu-trainer-validate-full-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let full = |_: &Path| Some(1024 * 1024 * 1024);
        let err = super::validate_trainer_root_candidate_with(&root.to_string_lossy(), full)
            .expect_err("a drive with 1 GB free must be refused");
        assert!(err.contains("1.0 GB free"), "the message must name the room that is there: {err}");
        assert!(!root.exists(), "a refusal on room must not leave a folder behind");
    }

    /// BLOCKER 2, negative control on the write-then-check order: pointing
    /// the candidate at a path that already exists as a plain FILE (not a
    /// folder) cannot be created as a directory, so validation must fail
    /// instead of silently writing the probe next to an unrelated file.
    #[test]
    fn validate_trainer_root_candidate_rejects_a_path_that_is_already_a_file() {
        let file = std::env::temp_dir().join(format!("lu-trainer-validate-file-{}", std::process::id()));
        fs::write(&file, b"not a folder").unwrap();
        let err = super::validate_trainer_root_candidate(&file.to_string_lossy());
        assert!(err.is_err(), "a path that is already a file must be refused, not treated as an installable folder");
        fs::remove_file(&file).unwrap();
    }

    /// BLOCKER 3, honesty: the suggestion is a sibling of the ComfyUI folder,
    /// never the ComfyUI folder's own subtree, and it is a plain string for a
    /// placeholder, not a value this function ever persists. Uses the
    /// injected form of the drive check (review-teil10.md M1) because this
    /// test asserts what happens when the drives DO differ, and a real
    /// second filesystem is not something a test runner can rely on having.
    ///
    /// The paths are the ones the platform reading this actually has. The
    /// suggestion is built with `Path::join`, so it carries the separator of
    /// the platform it was built on, and a Unix-shaped literal claimed a
    /// mixed `E:/...\LU-Trainer` was wrong when Windows had written the only
    /// correct answer it could.
    #[test]
    fn suggested_trainer_root_proposes_a_sibling_of_comfyui_when_the_drive_really_differs() {
        let (comfy, default_root, expected) = if cfg!(windows) {
            ("E:\\ComfyUI", "C:\\AppData\\musubi", "E:\\LU-Trainer")
        } else {
            ("/mnt/e/ComfyUI", "/mnt/c/AppData/musubi", "/mnt/e/LU-Trainer")
        };
        let suggestion = super::suggested_trainer_root_with(
            Some(Path::new(comfy)),
            Path::new(default_root),
            |_, _| Some(false),
        )
        .expect("a known ComfyUI folder on a different drive must produce a suggestion");
        assert_eq!(suggestion, expected);
    }

    /// Negative control on the separator itself: whatever the suggestion is,
    /// it must be a path this platform can open, not a mixture. A string built
    /// by hand instead of by `Path::join` is what this catches.
    #[test]
    fn the_suggested_root_uses_only_this_platforms_separator() {
        let (comfy, default_root) = if cfg!(windows) {
            ("E:\\ComfyUI", "C:\\AppData\\musubi")
        } else {
            ("/mnt/e/ComfyUI", "/mnt/c/AppData/musubi")
        };
        let suggestion = super::suggested_trainer_root_with(
            Some(Path::new(comfy)),
            Path::new(default_root),
            |_, _| Some(false),
        )
        .expect("a known ComfyUI folder on a different drive must produce a suggestion");
        let foreign = if cfg!(windows) { '/' } else { '\\' };
        assert!(
            !suggestion.contains(foreign),
            "the suggestion mixes separators and cannot be opened as typed: {suggestion}"
        );
    }

    /// M1, the fix itself: a ComfyUI folder that is on the SAME drive as the
    /// default trainer root must not produce a suggestion, because the
    /// caption built from it ("Your model folder is on another drive")
    /// would be false and a fresh install's default target would move for
    /// every customer with a known ComfyUI folder, not only the ones with a
    /// genuinely separate drive. This is the case review-teil10.md M1 named
    /// directly (ComfyUI and app data both on `C:`).
    #[test]
    fn suggested_trainer_root_is_none_when_the_drive_is_the_same() {
        let comfy = Path::new("/mnt/c/ComfyUI");
        let default_root = Path::new("/mnt/c/AppData/musubi");
        assert_eq!(super::suggested_trainer_root_with(Some(comfy), default_root, |_, _| Some(true)), None);
    }

    /// Negative control for the drive check itself: when it cannot be
    /// determined at all, the function must not guess by falling back to
    /// "assume different" (which would reproduce M1) or "assume same"
    /// (which would silently drop a real suggestion). Either wrong fallback
    /// would still pass the two tests above, since those pin `Some(false)`
    /// resp. `Some(true)` directly; this test is the one that catches a
    /// `.unwrap_or(..)` sneaking into the `?` on `same_drive(..)?`.
    #[test]
    fn suggested_trainer_root_is_none_when_the_drive_cannot_be_determined() {
        let comfy = Path::new("/mnt/e/ComfyUI");
        let default_root = Path::new("/mnt/c/AppData/musubi");
        assert_eq!(super::suggested_trainer_root_with(Some(comfy), default_root, |_, _| None), None);
    }

    /// Negative control: no known ComfyUI folder means no suggestion, not a
    /// guess. Goes through the real, non-injected function: `comfy_dir?`
    /// returns before `same_drive` is ever called, so the real platform
    /// drive check plays no part in this case.
    #[test]
    fn suggested_trainer_root_is_none_without_a_known_comfyui_folder() {
        assert_eq!(super::suggested_trainer_root(None, Path::new("/mnt/c/AppData/musubi")), None);
    }

    /// The real, platform-specific `same_drive` end to end: two paths that
    /// genuinely exist on the SAME filesystem (both under the process' own
    /// temp directory) must suppress the suggestion. This is the
    /// "Gleiches-Laufwerk-Fall" review-teil10.md M1 asked for, proven
    /// against actual `stat`/prefix behaviour rather than an injected
    /// closure.
    #[test]
    #[cfg(unix)]
    fn suggested_trainer_root_real_same_drive_check_suppresses_a_same_drive_suggestion() {
        let base = std::env::temp_dir().join(format!("lu-trainer-same-drive-{}", std::process::id()));
        let comfy = base.join("ComfyUI");
        let default_root = base.join("AppData").join("musubi");
        fs::create_dir_all(&comfy).unwrap();
        // `default_root` itself does not need to exist: the walk climbs to
        // the nearest existing ancestor, here `base`, which is on the same
        // device as `comfy` because both are under the same temp directory.
        assert_eq!(super::suggested_trainer_root(Some(&comfy), &default_root), None);
        fs::remove_dir_all(&base).unwrap();
    }

    /// Windows form of the same real, non-injected check: a drive letter is
    /// part of the path text, so both the same-drive and the
    /// different-drive case are real assertions here, no injected closure
    /// needed and no filesystem access required.
    #[test]
    #[cfg(windows)]
    fn suggested_trainer_root_real_same_drive_check_on_windows() {
        let comfy_same = Path::new(r"C:\ComfyUI");
        let default_root = Path::new(r"C:\Users\kunde\AppData\Roaming\lu\musubi");
        assert_eq!(super::suggested_trainer_root(Some(comfy_same), default_root), None);

        let comfy_other = Path::new(r"E:\ComfyUI");
        assert_eq!(
            super::suggested_trainer_root(Some(comfy_other), default_root),
            Some(r"E:\LU-Trainer".to_string())
        );

        // Case must not matter: lowercase drive letter, same drive as above.
        let comfy_lower = Path::new(r"c:\Games\ComfyUI");
        assert_eq!(super::suggested_trainer_root(Some(comfy_lower), default_root), None);

        // A UNC share is a different prefix from a drive letter, even one
        // pointing at the very same physical machine, because there is no
        // portable way to prove otherwise from the path text alone. The
        // ComfyUI folder needs one path segment PAST the share itself
        // (`\\nas\media\ComfyUI`, not `\\nas\ComfyUI`): a bare
        // `\\server\share` is the whole prefix and root together on
        // Windows, so `Path::parent()` on it alone returns `None` and
        // `suggested_trainer_root` would bail out before it ever reaches
        // the drive comparison (Opus review-teil11.md B1).
        let comfy_unc = Path::new(r"\\nas\media\ComfyUI");
        assert_eq!(
            super::suggested_trainer_root(Some(comfy_unc), default_root),
            Some(r"\\nas\media\LU-Trainer".to_string())
        );
    }

    /// K5 point 3: an empty install path is the way back to the default, not
    /// a no-op that keeps whatever `trainer_root` already held. Exercised
    /// against the real config file like the other `trainer_root_is_customized`
    /// test above, since `install_character_trainer` itself needs a live
    /// `AppHandle` this module's tests do not build.
    #[test]
    fn an_empty_install_path_clears_a_previous_override_the_same_way_install_character_trainer_does() {
        let _guard = config_json_test_guard();
        let backup = super::read_config_value("trainer_root");
        super::write_config_value("trainer_root", "/mnt/big-drive/musubi");
        assert!(super::trainer_root_is_customized());
        // This is the exact branch `install_character_trainer` takes for a
        // None/empty `installPath`: reproduced here because that function
        // needs a real `AppHandle`.
        let trimmed = "";
        if trimmed.is_empty() {
            super::write_config_value("trainer_root", "");
        }
        assert!(!super::trainer_root_is_customized(), "an empty submission must reset to the default, not keep the old override");
        match backup {
            Some(value) => super::write_config_value("trainer_root", &value),
            None => super::write_config_value("trainer_root", ""),
        }
    }

    /// Source check that `install_character_trainer` actually validates
    /// before it persists, in that order -- the one thing a behavioural test
    /// against the real function cannot pin down without a live `AppHandle`
    /// and a background thread.
    #[test]
    fn install_character_trainer_validates_before_it_persists() {
        // N3 (Opus review of `3ef38668`): this used to cut a fixed 1800-byte
        // window out of the function body, which would have broken from the
        // wrong cause (an out-of-bounds slice, or a `write_at` that quietly
        // stops matching) the day the function grows or a comment shifts the
        // cut point. Searching the rest of the file after `body_start`
        // instead of a fixed window avoids that: `write_at`'s needle is
        // unique in the whole file (checked via grep), and `validate_at`'s
        // needle also occurs later on, inside this very test and in a
        // comment further down, but both of those sit well after the real
        // call at the top of `install_character_trainer`, so `find` still
        // lands on the production call first, before either later needle
        // can be reached.
        let src = include_str!("trainer.rs");
        let body_start = src.find("pub fn install_character_trainer(").expect("install_character_trainer");
        let body = &src[body_start..];
        let validate_at = body.find("validate_trainer_root_candidate(trimmed)?").expect("validation call");
        let write_at = body.find("write_config_value(\"trainer_root\", &validated").expect("persist call");
        assert!(validate_at < write_at, "the candidate must be validated before it is written to config.json");
    }

    /// N2 (Opus review of `3ef38668`): the check ("already installing?") and
    /// the set ("claim the slot") used to be two separate locks with the
    /// expensive path validation running unlocked in between, so two
    /// concurrent calls could both see an idle status and both go on to
    /// start `provision_trainer_env`. review-teil10.md M2: a hand-copied
    /// reimplementation of the check-and-set here would keep passing even if
    /// tomorrow's edit pulled the real `InstallClaim::try_claim` apart into
    /// two locks again, so this test calls that function directly, the exact
    /// primitive `install_character_trainer` claims the slot through (the
    /// full command still needs a live `AppHandle` this module's tests do
    /// not build, same reason as the two tests above; `try_claim` is the
    /// entire check-and-set, everything after it is unrelated IO).
    ///
    /// Both threads are held at a `Barrier` until they can both attempt the
    /// claim in the same instant, and the "expensive check" is a real sleep
    /// AFTER the slot is claimed and the lock released, so if `try_claim`
    /// were still split into two separate locks (the bug) a second thread
    /// timed to land inside that sleep would see "idle" and wrongly win too.
    /// Repeated many times because a race is a probability, not a fact: one
    /// lucky interleaving proves nothing.
    ///
    /// Negative control run by hand for this review (a temporary variant,
    /// not part of this commit): replacing the single lock here with two
    /// SEPARATE locks, one for the read and one for the write (the exact N2
    /// shape), reproduced double claims across four separate runs of 200
    /// reps each: 4, 5, 6 and 10 double claims out of 200. The real
    /// `InstallClaim::try_claim` version below stayed at 0 double claims out
    /// of 200 every time it was run.
    #[test]
    fn only_one_of_two_concurrent_installs_claims_the_slot() {
        const REPETITIONS: usize = 200;
        for rep in 0..REPETITIONS {
            let install: Arc<Mutex<crate::state::InstallState>> = Arc::new(Mutex::new(crate::state::InstallState::default()));
            let barrier = std::sync::Barrier::new(2);

            let attempt = |install: &Arc<Mutex<crate::state::InstallState>>| -> &'static str {
                barrier.wait();
                match super::InstallClaim::try_claim(install) {
                    None => "already_installing",
                    Some(claim) => {
                        // Stands in for `validate_trainer_root_candidate`'s
                        // real disk IO: long enough that a still-racy
                        // check-and-set would let a second thread's check
                        // land inside this window and see "idle".
                        std::thread::sleep(std::time::Duration::from_millis(5));
                        claim.defuse();
                        "installing"
                    }
                }
            };

            let (a, b) = std::thread::scope(|scope| {
                let t1 = scope.spawn(|| attempt(&install));
                let t2 = scope.spawn(|| attempt(&install));
                (t1.join().unwrap(), t2.join().unwrap())
            });

            let outcomes = [a, b];
            assert_eq!(
                outcomes.iter().filter(|o| **o == "installing").count(),
                1,
                "rep {rep}: exactly one of the two concurrent attempts must claim the slot: got {outcomes:?}"
            );
            assert_eq!(
                outcomes.iter().filter(|o| **o == "already_installing").count(),
                1,
                "rep {rep}: the loser must see already_installing, not a second successful claim: got {outcomes:?}"
            );
        }
    }

    /// N2, negative control: a claim that is dropped WITHOUT `defuse()` (the
    /// shape of a failed `validate_trainer_root_candidate`) must hand the
    /// slot back, not leave it stuck on "installing" forever. Without this,
    /// N2's own fix would trade a rare double-install race for a guaranteed
    /// permanent lockout on the very first rejected path.
    #[test]
    fn a_claim_dropped_without_defusing_releases_the_slot_for_the_next_attempt() {
        let install: Arc<Mutex<crate::state::InstallState>> = Arc::new(Mutex::new(crate::state::InstallState::default()));
        {
            let mut st = install.lock().unwrap();
            st.status = "installing".to_string();
        }
        let claim = super::InstallClaim { install: &install, active: true };
        assert_eq!(install.lock().unwrap().status, "installing", "the claim starts out holding the slot");
        drop(claim); // simulates `validate_trainer_root_candidate(trimmed)?` returning Err

        assert_eq!(install.lock().unwrap().status, "idle", "an undefused claim must reset the slot, not leave it stuck on installing");

        // And a fresh attempt can now claim it, proving the slot is really free.
        let mut st = install.lock().unwrap();
        assert_ne!(st.status, "installing");
        st.status = "installing".to_string();
    }

    /// The priority order the review asked for: the Hardware tab's own pick
    /// wins, then a `CUDA_VISIBLE_DEVICES` already on the process, then the
    /// card with the most memory -- never a bare index 0.
    #[test]
    fn choose_trainer_gpu_prefers_the_hardware_tab_pick() {
        let cards = vec![
            crate::commands::gpu::DetectedGpu {
                index: 0,
                vendor: "nvidia".into(),
                name: "RTX 3050".into(),
                memory_mib: Some(8192),
                source: "nvidia-smi".into(),
                note: None,
                note_severity: None,
                arch: None,
                uuid: None,
                shared_memory_mib: None,
            },
            crate::commands::gpu::DetectedGpu {
                index: 1,
                vendor: "nvidia".into(),
                name: "RTX 3090 Ti".into(),
                memory_mib: Some(24564),
                source: "nvidia-smi".into(),
                note: None,
                note_severity: None,
                arch: None,
                uuid: None,
                shared_memory_mib: None,
            },
        ];
        let selection = crate::commands::gpu::GpuSelection { vendor: "nvidia".into(), indices: vec![1] };
        let choice = super::choose_trainer_gpu(&cards, &selection, None).expect("a card was chosen");
        assert_eq!(choice.index, 1);
        assert_eq!(choice.source, "the Hardware tab's GPU selection");
    }

    /// Without a Hardware-tab pick, a `CUDA_VISIBLE_DEVICES` the user already
    /// set on the process is respected, narrowed to its strongest entry, not
    /// overwritten with a default.
    #[test]
    fn choose_trainer_gpu_respects_an_existing_cuda_visible_devices() {
        let cards = vec![
            crate::commands::gpu::DetectedGpu {
                index: 0,
                vendor: "nvidia".into(),
                name: "Tesla P100 (display)".into(),
                memory_mib: Some(4096),
                source: "nvidia-smi".into(),
                note: None,
                note_severity: None,
                arch: None,
                uuid: None,
                shared_memory_mib: None,
            },
            crate::commands::gpu::DetectedGpu {
                index: 1,
                vendor: "nvidia".into(),
                name: "Tesla P100".into(),
                memory_mib: Some(16384),
                source: "nvidia-smi".into(),
                note: None,
                note_severity: None,
                arch: None,
                uuid: None,
                shared_memory_mib: None,
            },
        ];
        let selection = crate::commands::gpu::GpuSelection::default();
        let choice = super::choose_trainer_gpu(&cards, &selection, Some("1")).expect("a card was chosen");
        assert_eq!(choice.index, 1);
        assert_eq!(choice.source, "the CUDA_VISIBLE_DEVICES already set for this process");
    }

    /// GPU-UUID Nachzug: a user who set `CUDA_VISIBLE_DEVICES` to a
    /// `GPU-<uuid>` themselves (outside LU) is honoured exactly the same as
    /// one who used a plain index -- the uuid form is not a second, unread
    /// spelling.
    #[test]
    fn choose_trainer_gpu_matches_an_existing_cuda_visible_devices_given_as_a_uuid() {
        let cards = vec![
            crate::commands::gpu::DetectedGpu {
                index: 0,
                vendor: "nvidia".into(),
                name: "Tesla P100 (display)".into(),
                memory_mib: Some(4096),
                source: "nvidia-smi".into(),
                note: None,
                note_severity: None,
                arch: None,
                uuid: Some("GPU-aaaa".into()),
                shared_memory_mib: None,
            },
            crate::commands::gpu::DetectedGpu {
                index: 1,
                vendor: "nvidia".into(),
                name: "Tesla P100".into(),
                memory_mib: Some(16384),
                source: "nvidia-smi".into(),
                note: None,
                note_severity: None,
                arch: None,
                uuid: Some("GPU-bbbb".into()),
                shared_memory_mib: None,
            },
        ];
        let selection = crate::commands::gpu::GpuSelection::default();
        let choice = super::choose_trainer_gpu(&cards, &selection, Some("GPU-bbbb")).expect("a card was chosen");
        assert_eq!(choice.index, 1);
        assert_eq!(choice.uuid.as_deref(), Some("GPU-bbbb"));
        assert_eq!(choice.source, "the CUDA_VISIBLE_DEVICES already set for this process");
    }

    /// The normal (no existing env var, no user override) priority also
    /// carries the uuid through, so `pin_trainer_gpu` can prefer it.
    #[test]
    fn choose_trainer_gpu_carries_the_uuid_through_on_the_hardware_tab_pick() {
        let cards = vec![crate::commands::gpu::DetectedGpu {
            index: 0,
            vendor: "nvidia".into(),
            name: "RTX 3060".into(),
            memory_mib: Some(12288),
            source: "nvidia-smi".into(),
            note: None,
            note_severity: None,
            arch: None,
            uuid: Some("GPU-cccc".into()),
            shared_memory_mib: None,
        }];
        let selection = crate::commands::gpu::GpuSelection { vendor: "nvidia".into(), indices: vec![0] };
        let choice = super::choose_trainer_gpu(&cards, &selection, None).expect("a card was chosen");
        assert_eq!(choice.uuid.as_deref(), Some("GPU-cccc"));
    }

    /// Neither a Hardware-tab pick nor an existing env var: the card with the
    /// most memory wins, not index 0. CUDA without `CUDA_DEVICE_ORDER` sorts
    /// fastest-first, which is not the same promise.
    #[test]
    fn choose_trainer_gpu_falls_back_to_the_most_memory_not_index_zero() {
        let cards = vec![
            crate::commands::gpu::DetectedGpu {
                index: 0,
                vendor: "nvidia".into(),
                name: "RTX 3050".into(),
                memory_mib: Some(8192),
                source: "nvidia-smi".into(),
                note: None,
                note_severity: None,
                arch: None,
                uuid: None,
                shared_memory_mib: None,
            },
            crate::commands::gpu::DetectedGpu {
                index: 1,
                vendor: "nvidia".into(),
                name: "RTX 3090 Ti".into(),
                memory_mib: Some(24564),
                source: "nvidia-smi".into(),
                note: None,
                note_severity: None,
                arch: None,
                uuid: None,
                shared_memory_mib: None,
            },
        ];
        let selection = crate::commands::gpu::GpuSelection::default();
        let choice = super::choose_trainer_gpu(&cards, &selection, None).expect("a card was chosen");
        assert_eq!(choice.index, 1, "index 0 was chosen instead of the card with more memory");
        assert_eq!(choice.source, "the card with the most memory");
    }

    /// Positive control, path 1 of 2: the setup's own smoke test. It runs
    /// `python -c "import torch ..."` outside run_child, so its environment is
    /// its own and has to carry the same knob.
    #[test]
    fn the_setup_smoke_test_carries_the_libuv_knob() {
        let src = include_str!("trainer.rs");
        let probe = &src[src.find("fn probe_trainer_env(").expect("probe")..];
        let probe = &probe[..probe.find("/// The four install steps").expect("end of probe")];
        assert!(
            probe.contains("trainer_child_env(&mut probe)"),
            "the smoke test builds its child without the trainer environment",
        );
        assert!(probe.contains("TORCH_PREFLIGHT_PY"), "the smoke test still imports torch");
        // And the function it calls really sets it (the assertion above only
        // proves the call).
        let mut cmd = std::process::Command::new("python");
        super::trainer_child_env(&mut cmd);
        assert!(env_of(&cmd).contains(&("USE_LIBUV".into(), Some("0".into()))));
    }

    /// Positive control, path 2 of 2: the training run. The command is built
    /// here exactly as the run builds it, then handed the environment
    /// `run_child` gives every child it spawns.
    #[test]
    fn the_training_child_carries_the_libuv_knob() {
        let mut cmd = super::training_command(
            "/tmp/venv/bin/python",
            std::path::Path::new("/tmp/musubi-tuner"),
            &super::TrainStep {
                dit: "/m/dit.safetensors",
                vae: "/m/ae.safetensors",
                text_encoder: "/m/qwen.safetensors",
                dataset: "/t/set.toml",
                steps: "400",
                out_dir: "/t/out",
                out_name: "char_dave_zimage",
                precision: super::train_precision_for_capability(Some((8, 9))),
                preset: super::TrainPreset::Standard,
            },
        );
        super::trainer_child_env(&mut cmd);
        let envs = env_of(&cmd);
        assert!(
            envs.contains(&("USE_LIBUV".into(), Some("0".into()))),
            "the training child lost the libuv knob",
        );
        assert!(
            envs.contains(&("OMP_NUM_THREADS".into(), Some("1".into()))),
            "the one thread the launcher used to set is gone",
        );
    }

    /// The root of GitHub #121: a second card used to turn `accelerate launch`
    /// into torch's elastic launcher, whose rendezvous store never reads
    /// USE_LIBUV. The train step runs the script itself now.
    #[test]
    fn the_training_step_runs_the_script_not_a_distributed_launcher() {
        let cmd = super::training_command(
            "/tmp/venv/bin/python",
            std::path::Path::new("/tmp/musubi-tuner"),
            &super::TrainStep {
                dit: "/m/dit.safetensors",
                vae: "/m/ae.safetensors",
                text_encoder: "/m/qwen.safetensors",
                dataset: "/t/set.toml",
                steps: "400",
                out_dir: "/t/out",
                out_name: "char_dave_zimage",
                precision: super::train_precision_for_capability(Some((8, 9))),
                preset: super::TrainPreset::Standard,
            },
        );
        assert_eq!(
            cmd.get_program().to_string_lossy(),
            "/tmp/venv/bin/python",
            "the train step must run the venv's python, like steps 1, 2 and 4",
        );
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args.first().map(String::as_str), Some("src/musubi_tuner/zimage_train_network.py"));
        assert!(!args.iter().any(|a| a == "launch"), "the launcher is back: {args:?}");
        assert!(
            !args.iter().any(|a| a == "--num_cpu_threads_per_process"),
            "a launcher flag survived into the script's own arguments",
        );
        // The recipe itself is unchanged, and the script still gets the
        // precision the launcher used to be told about as well.
        for flag in ["--fp8_base", "--fp8_scaled", "--blocks_to_swap", "--gradient_checkpointing", "--mixed_precision"] {
            assert!(args.iter().any(|a| a == flag), "{flag} is missing from the recipe");
        }
        assert_eq!(args.iter().filter(|a| *a == "--mixed_precision").count(), 1);
        let src = include_str!("trainer.rs");
        let code = &src[..src.find("#[cfg(test)]").expect("tests start")];
        assert!(
            !code.contains("accelerate.exe") && !code.contains("\"launch\""),
            "the accelerate launcher is back in the production code",
        );
    }

    // ── Nachbesserung 1 (Runde 4 corrected again): bf16 is not optional for
    // this model, so it is no longer part of what this function decides ──
    // Runde 2 had bf16 fall back to fp16 below compute capability 8.0. Runde
    // 3's Opus review found that fp16 was never a real rescue: zimage_utils.py
    // hardcodes bfloat16 in the text encoder cache step regardless of
    // `--mixed_precision` (see the doc comment on TrainPrecision), so a card
    // that cannot do bf16 dies there anyway. `capability_floor_refusal` now
    // refuses such a card before this function is ever called with its
    // capability, which makes the old fp16 branch dead code: deleted.

    #[test]
    fn train_precision_gives_any_measured_card_the_full_bf16_recipe() {
        use super::train_precision_for_capability;
        // Every one of these has already cleared capability_floor_refusal's
        // 8.0 floor in practice; the function no longer branches on the
        // exact number, only on whether one was measured at all.
        for cap in [(8, 0), (8, 6), (8, 9), (9, 0), (12, 0)] {
            let p = train_precision_for_capability(Some(cap));
            assert_eq!(p.mixed_precision, "bf16", "{cap:?}");
            assert_eq!(p.save_precision, "bf16", "{cap:?}");
            assert!(p.fp8, "{cap:?}");
            assert_eq!(p.optimizer_type, "adamw8bit", "{cap:?}");
        }
    }

    #[test]
    fn train_precision_with_no_measured_capability_stays_conservative() {
        use super::train_precision_for_capability;
        let unknown = train_precision_for_capability(None);
        assert_eq!(unknown.mixed_precision, "fp16");
        assert!(!unknown.fp8, "an unmeasured card gets the fully conservative recipe, fp8 included");
        assert_eq!(unknown.optimizer_type, "AdamW");
    }

    /// Positive control: a user's Tesla P100 (compute capability 6.0)
    /// must never reach `training_command` at all any more; it is refused
    /// by `capability_floor_refusal` before the trainer environment is even
    /// installed. See `capability_floor_now_refuses_pascal_the_concrete_melder_case`.
    #[test]
    fn pascal_is_refused_before_training_command_is_ever_built() {
        use super::capability_floor_refusal;
        assert!(
            capability_floor_refusal((6, 0), "Tesla P100").is_some(),
            "a card this function would have to build fp16 for must be refused first",
        );
    }

    #[test]
    fn the_training_command_keeps_fp8_on_an_ampere_card() {
        let cmd = super::training_command(
            "/tmp/venv/bin/python",
            std::path::Path::new("/tmp/musubi-tuner"),
            &super::TrainStep {
                dit: "/m/dit.safetensors",
                vae: "/m/ae.safetensors",
                text_encoder: "/m/qwen.safetensors",
                dataset: "/t/set.toml",
                steps: "400",
                out_dir: "/t/out",
                out_name: "char_dave_zimage",
                precision: super::train_precision_for_capability(Some((8, 6))),
                preset: super::TrainPreset::Standard,
            },
        );
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(args.iter().any(|a| a == "--fp8_base"), "the 3060 proof box needs fp8 to fit in 12 GB: {args:?}");
        assert!(args.iter().any(|a| a == "--fp8_scaled"), "{args:?}");
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
        assert_eq!(parse_step_counter("steps:   9%|▉         | 35/400 [06:34<1:08:38, 11.28s/it]"), Some((35, 400)));
        assert_eq!(parse_step_counter("no counter here"), None);
        // version-ish fragments with tiny totals are ignored
        assert_eq!(parse_step_counter("steps: python 3/4 things"), None);
    }

    #[test]
    fn only_the_training_bar_moves_the_step_counter() {
        // The DiT loader draws its own tqdm bar right before training starts
        // (521 tensors on the box, 06.09.2026); for three minutes the meter
        // counted it up to 521/521 against a 400-step run. Epoch lines carry
        // a total of their own as well.
        assert_eq!(parse_step_counter("41/521 [00:10<02:00, 4.0it/s]"), None);
        assert_eq!(parse_step_counter("Loading: 100%|██████████| 521/521 [02:10<00:00]"), None);
        assert_eq!(parse_step_counter("epoch 1/16"), None);
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
        assert_eq!(venv_action(true, None, true), VenvAction::Rebuild);
        // A rebuild must clear: the old site-packages belongs to an
        // interpreter that no longer exists, and pip would repair on top of it.
        assert_eq!(venv_create_args(VenvAction::Rebuild), ["-m", "venv", "--clear"]);
    }

    #[test]
    fn a_working_venv_is_kept_and_a_missing_one_is_created() {
        use super::{venv_action, venv_create_args, VenvAction};
        assert_eq!(venv_action(true, Some("3.11.7"), true), VenvAction::Keep);
        assert_eq!(venv_action(false, None, true), VenvAction::Create);
        // POSIX: venv/bin/python is a symlink, so a dead base already shows up
        // as absent. That is why this only ever bit Windows.
        assert_eq!(venv_action(false, Some("3.12.1"), true), VenvAction::Create);
        assert_eq!(venv_create_args(VenvAction::Create), ["-m", "venv"]);
        assert_eq!(venv_create_args(VenvAction::Keep), ["-m", "venv"]);
    }

    // ── ticket 0004: the venv from the wrong Python ─────────
    //
    // His machine has Python 3.14.6 and nothing older. LU used it for the
    // venv, torch from cu128 installed fine, and step 4 died on "Package
    // 'musubi-tuner' requires a different Python: 3.14.6 not in
    // '<3.13,>=3.10'", which 2.6.7 reported as "check that you are online".
    // On the next attempt the venv was there and ran, so step 2 kept it, and
    // the same wall came back on every update since August.

    #[test]
    fn a_venv_from_a_python_the_trainer_cannot_use_is_rebuilt_not_kept() {
        use super::{venv_action, VenvAction};
        assert_eq!(venv_action(true, Some("3.14.6"), true), VenvAction::Rebuild, "a user's venv");
        assert_eq!(venv_action(true, Some("3.13.5"), true), VenvAction::Rebuild, "the box's newest Python");
        assert_eq!(venv_action(true, Some("3.9.13"), true), VenvAction::Rebuild, "too old is as wrong as too new");
        for v in ["3.10.6", "3.11.7", "3.12.1"] {
            assert_eq!(venv_action(true, Some(v), true), VenvAction::Keep, "{v}");
        }
    }

    /// K4, nachgebessert nach dem Opus-Review: before this, `arch_ok` did not
    /// exist and a venv built from a 32-bit or ARM64 Python 3.11 -- a version
    /// `trainer_supports_python` accepts -- always read Keep on this Keep
    /// path, so "delete the 3.11 environment" (a user was told this) had
    /// nothing to do here: the NEXT setup run rebuilt with the same bad
    /// interpreter, because nothing on the Keep path ever asked its
    /// architecture.
    #[test]
    fn a_venv_from_the_wrong_architecture_is_rebuilt_even_with_a_good_version() {
        use super::{venv_action, VenvAction};
        assert_eq!(
            venv_action(true, Some("3.11.7"), false),
            VenvAction::Rebuild,
            "a right-looking version must not save a wrong-architecture venv",
        );
        assert_eq!(venv_action(true, Some("3.11.7"), true), VenvAction::Keep);
    }

    #[test]
    fn the_trainer_range_is_the_one_musubi_and_the_cu121_index_agree_on() {
        use super::trainer_supports_python;
        assert!(trainer_supports_python("3.10.0"));
        assert!(trainer_supports_python("3.12.11"));
        assert!(!trainer_supports_python("3.13.0"));
        assert!(!trainer_supports_python("3.14.6"));
        assert!(!trainer_supports_python("3.9.99"));
        assert!(!trainer_supports_python("4.0.0"));
        assert!(!trainer_supports_python("Python 3.11"), "not a version, not a match");
        assert!(!trainer_supports_python(""));
    }

    #[test]
    fn the_setup_keeps_lus_python_when_it_fits_and_otherwise_takes_the_newest_that_does() {
        use super::choose_trainer_python;
        let pair = |p: &str, v: &str| (p.to_string(), v.to_string());
        // LU's default fits: kept, even though a newer supported one exists,
        // so a working venv is never rebuilt because a Python appeared.
        let got = choose_trainer_python(&[pair("C:\\py311", "3.11.7"), pair("C:\\py312", "3.12.1")]);
        assert_eq!(got, Some(pair("C:\\py311", "3.11.7")));
        // A user: the default is 3.14, and there is a 3.10 and a 3.12
        // further down the list. The newest that fits wins.
        let got = choose_trainer_python(&[
            pair("C:\\py314", "3.14.6"),
            pair("C:\\py310", "3.10.6"),
            pair("C:\\py312", "3.12.1"),
            pair("C:\\py313", "3.13.5"),
        ]);
        assert_eq!(got, Some(pair("C:\\py312", "3.12.1")));
        // Only 3.14: nothing fits, and the caller has to say so or install one.
        assert_eq!(choose_trainer_python(&[pair("C:\\py314", "3.14.6")]), None);
        assert_eq!(choose_trainer_python(&[]), None);
    }

    #[test]
    fn when_no_python_fits_the_message_names_what_is_there_and_where_to_get_one() {
        use super::{install_failed_message, no_trainer_python_message, repair_aborted_message, Preflight};
        let found = vec![("C:\\Python314\\python.exe".to_string(), "3.14.6".to_string())];
        let win = no_trainer_python_message(&found, "windows");
        assert!(win.contains("3.10, 3.11 or 3.12"), "{win}");
        assert!(win.contains("has Python 3.14.6"), "{win}");
        // K4: the path is what tells two same-version Pythons apart.
        assert!(win.contains("at C:\\Python314\\python.exe"), "{win}");
        assert!(win.contains("python.org/downloads/windows"), "{win}");
        // Since 3.0.7 LU sets up its own Python instead of running winget;
        // this sentence is only reached where it has none for the system.
        assert!(!win.contains("winget"), "{win}");
        assert!(win.contains("Set up trainer"), "{win}");
        // Settings > Install Python short-circuits as soon as ANY Python exists,
        // which on this machine is the one that cannot help.
        assert!(!win.contains("Settings"), "{win}");
        let linux = no_trainer_python_message(&found, "linux");
        assert!(linux.contains("package manager") && !linux.contains("python.org"), "{linux}");
        let mac = no_trainer_python_message(&found, "macos");
        assert!(mac.contains("brew install python@3.12"), "{mac}");
        let none = no_trainer_python_message(&[], "windows");
        assert!(none.contains("no Python that starts"), "{none}");
        // It carries its own way out, so neither wrapper may bury it.
        assert_eq!(install_failed_message(&win), win);
        assert_eq!(repair_aborted_message(&Preflight::TorchBroken("x".into()), &win), win);
    }

    #[test]
    fn sockenmonsters_pip_line_is_named_as_a_python_version_problem_not_a_network_one() {
        use super::install_failed_message;
        let msg = install_failed_message(
            "musubi install failed (exit Some(1)).\nERROR: Package 'musubi-tuner' requires a different Python: 3.14.6 not in '<3.13,>=3.10'",
        );
        assert!(msg.contains("3.10, 3.11 or 3.12"), "{msg}");
        assert!(msg.contains("Set up trainer"), "{msg}");
        assert!(!msg.contains("Check that you are online"), "still the 2.6.7 sentence: {msg}");
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
        use crate::python::python_version;
        let dir = crate::os_paths::test_dir("trainer-venv-probe");
        let fake = dir.join("python-not-an-interpreter");
        std::fs::write(&fake, b"pyvenv.cfg points at a home that is gone").unwrap();
        assert!(fake.exists(), "the file is there, which is all the old check asked");
        assert_eq!(python_version(&fake.to_string_lossy()), None, "but it does not run, which is the question");
        assert_eq!(python_version(&dir.join("nothing-here").to_string_lossy()), None);
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
            step2.contains("venv_action(exists, venv_version.as_deref(), venv_arch_ok)"),
            "step 2 must decide with venv_action on the venv's version, not with a bare exists()",
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
                "Moving to c:\\users\\alice\\musubi\\venv\\lib\\site-packages\\torch\\lib\\part{i}.dll\n"
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
        use super::{install_failed_message, no_trainer_python_message, repair_aborted_message, Preflight};
        let eigen = no_trainer_python_message(&[("C:\\Python314\\python.exe".to_string(), "3.14.6".to_string())], "windows");
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
    // A user (Discord #general, 2026-08-27), confirmed by a user
    // and by a user in GH #121 on 2026-08-29: "Setting up the trainer
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
    fn missing_bases_names_only_the_absent_files_with_their_size() {
        // Box run: only z_image_bf16 was missing, the panel still said 19 GB.
        let only_dit = super::missing_bases([false, true, true]);
        assert_eq!(only_dit.len(), 1);
        assert_eq!(only_dit[0]["filename"], "z_image_bf16.safetensors");
        assert_eq!(only_dit[0]["subfolder"], "diffusion_models");
        assert_eq!(only_dit[0]["bytes"], 12_309_866_400u64);
        assert!(super::missing_bases([true, true, true]).is_empty());
        let all = super::missing_bases([false, false, false]);
        let names: Vec<&str> = all.iter().map(|v| v["filename"].as_str().unwrap()).collect();
        assert_eq!(names, ["z_image_bf16.safetensors", "qwen_3_4b.safetensors", "ae.safetensors"]);
        // Each download target is one the status itself would resolve.
        assert_eq!(super::BASE_DOWNLOADS[0].0, super::DIT_CANDIDATES[0]);
        assert_eq!(super::BASE_DOWNLOADS[1].0, super::TE_CANDIDATES[0]);
        assert_eq!(super::BASE_DOWNLOADS[2].0, super::VAE_CANDIDATES[0]);
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

// ── the whole journey, ticket 0004 follow-up (06.09.2026) ───────────────────
//
// The owner's line: the app cannot afford to hand anyone instructions; from the
// first error to a finished training, everything has to happen in the app.
// These pin the pieces that replaced a pointer with an action: no git needed,
// room checked before the first byte, a dropped download retried, the Visual
// C++ runtime installed instead of linked, winget kept out of the note, the
// card's memory checked before ten minutes of caching, and the one dead end
// the run still has (out of memory) named with its way out.
#[cfg(test)]
mod journey_tests {
    use super::*;

    fn fresh_state() -> Arc<Mutex<crate::state::InstallState>> {
        Arc::new(Mutex::new(crate::state::InstallState::default()))
    }

    #[test]
    fn winget_runs_silent_with_both_agreements_and_a_scope_only_for_user_packages() {
        let user = winget_install_args("Python.Python.3.12", true);
        assert_eq!(user[..2], ["install", "Python.Python.3.12"]);
        assert!(user.contains(&"--silent".to_string()));
        assert!(user.contains(&"--accept-package-agreements".to_string()));
        assert!(user.contains(&"--accept-source-agreements".to_string()));
        assert_eq!(user[user.len() - 2..], ["--scope", "user"]);
        // The Visual C++ runtime only installs machine wide; a scope would
        // make winget refuse it.
        let machine = winget_install_args("Microsoft.VCRedist.2015+.x64", false);
        assert!(!machine.iter().any(|a| a == "--scope"), "{machine:?}");
        assert!(machine.contains(&"--silent".to_string()));
    }

    #[test]
    fn a_quiet_child_keeps_its_tail_for_the_error_and_writes_nothing_into_the_log() {
        let state = fresh_state();
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let pid = Arc::new(Mutex::new(None));
        let mk = || {
            #[cfg(target_os = "windows")]
            {
                let mut c = Command::new("cmd");
                c.args(["/c", "echo geheim & exit 3"]);
                c
            }
            #[cfg(not(target_os = "windows"))]
            {
                let mut c = Command::new("sh");
                c.args(["-c", "echo geheim; exit 3"]);
                c
            }
        };
        let err = run_quiet(mk(), "probe", &state, &cancel, &pid).unwrap_err();
        assert!(err.contains("geheim"), "the tail must survive for the failure message: {err}");
        assert!(
            !state.lock().unwrap().logs.iter().any(|l| l.contains("geheim")),
            "a quiet child's lines must not reach the note under the button"
        );
        // Negative control: the streamed variant does put them there.
        let err = run_streamed(mk(), "probe", &state, &cancel, &pid).unwrap_err();
        assert!(err.contains("geheim"));
        assert!(state.lock().unwrap().logs.iter().any(|l| l.contains("geheim")));
    }

    #[test]
    fn only_a_network_failure_is_worth_a_retry() {
        assert!(is_transient_network("torch install failed (exit Some(1)).\nConnectionResetError: connection reset by peer"));
        assert!(is_transient_network("ReadTimeoutError: read timed out"));
        assert!(is_transient_network("ERROR: 429 Too Many Requests "));
        assert!(!is_transient_network("ERROR: No matching distribution found for torch"));
        assert!(!is_transient_network("OSError: [Errno 28] No space left on device"));
        assert!(!is_transient_network("cancelled"));
    }

    #[test]
    fn the_room_check_answers_before_the_first_byte_and_carries_its_own_way_out() {
        let root = Path::new("C:\\Users\\d\\musubi");
        let gib = 1024u64 * 1024 * 1024;
        let msg = disk_room_message(root, 5 * gib + gib / 2, 10).expect("5.5 GB is not enough for 10");
        assert!(msg.contains("5.5 GB free"), "{msg}");
        assert!(msg.contains("about 10 GB"), "{msg}");
        assert!(msg.contains("Set up trainer"), "{msg}");
        assert!(msg.contains(&root.display().to_string()), "names the drive: {msg}");
        // It must not be wrapped in "check that you are online".
        assert_eq!(install_failed_message(&msg), msg);
        assert!(disk_room_message(root, 20 * gib, 10).is_none());
        assert!(disk_room_message(root, 7 * gib, 7).is_none(), "exactly enough is enough");
    }

    #[test]
    fn the_source_counts_as_present_for_an_archive_with_the_tag_or_an_older_git_checkout() {
        let dir = crate::os_paths::test_dir("trainer-source");
        assert!(!musubi_source_present(&dir), "nothing there yet");
        let pkg = repo_dir(&dir).join("src").join("musubi_tuner");
        fs::create_dir_all(&pkg).unwrap();
        assert!(!musubi_source_present(&dir), "a bare folder without a tag is not the pinned source");
        fs::write(musubi_source_marker(&dir), "v0.0.1").unwrap();
        assert!(!musubi_source_present(&dir), "a different tag is not this release");
        fs::write(musubi_source_marker(&dir), format!("{MUSUBI_TAG}\n")).unwrap();
        assert!(musubi_source_present(&dir), "the archive of this tag");
        fs::remove_file(musubi_source_marker(&dir)).unwrap();
        fs::create_dir_all(repo_dir(&dir).join(".git")).unwrap();
        assert!(musubi_source_present(&dir), "a git checkout from an older LU is kept");
        fs::remove_dir_all(&pkg).unwrap();
        assert!(!musubi_source_present(&dir), "a checkout without the package is not usable");
    }

    #[test]
    fn the_archive_url_names_the_pinned_tag_on_the_codeload_host() {
        let url = musubi_archive_url();
        assert!(url.starts_with("https://codeload.github.com/kohya-ss/musubi-tuner/zip/refs/tags/"), "{url}");
        assert!(url.ends_with(MUSUBI_TAG), "{url}");
    }

    #[test]
    fn the_probe_reports_the_cards_memory_and_the_floor_is_twelve_gigabytes() {
        assert!(TORCH_PREFLIGHT_PY.contains("VRAM_MIB"), "the probe script has to print it");
        assert_eq!(parse_vram_mib("TORCH_OK 2.5.1\nCUDA 1\nCAP 8 6\nARCHS sm_86\nVRAM_MIB 12288\n"), Some(12288));
        assert_eq!(parse_vram_mib("TORCH_OK 2.5.1\nCUDA 0\n"), None);
        let fp8_on = train_precision_for_capability(Some((8, 6)));
        assert!(vram_verdict(Some(12288), &fp8_on, TrainPreset::Standard).is_none(), "the box's 12 GB card trains");
        assert!(vram_verdict(Some(16 * 1024), &fp8_on, TrainPreset::Standard).is_none());
        assert!(vram_verdict(None, &fp8_on, TrainPreset::Standard).is_none(), "no card reported is the processor case, handled elsewhere");
        let small = vram_verdict(Some(8 * 1024), &fp8_on, TrainPreset::Standard).expect("8 GB is below the floor");
        assert!(small.contains("8 GB"), "{small}");
        assert!(small.contains("12 GB"), "{small}");
        assert!(small.contains("Cloud mode"), "names the way that works: {small}");
    }

    /// Nachbesserung Runde 2: the floor moves with the precision that will
    /// actually run. An unmeasured card (fp8 off, the fully conservative
    /// fallback) needs more headroom than the fp8-on floor the 3060 box
    /// proved -- a card between the two floors must be refused only in the
    /// no-fp8 case, not the fp8 one.
    #[test]
    fn vram_floor_follows_the_chosen_precision_not_a_fixed_number() {
        let fp8_on = train_precision_for_capability(Some((8, 6)));
        let fp8_off = train_precision_for_capability(None);
        assert!(fp8_on.fp8);
        assert!(!fp8_off.fp8);
        let between = 16 * 1024; // 16 GB: above the fp8 floor, below the no-fp8 one.
        assert!(vram_verdict(Some(between), &fp8_on, TrainPreset::Standard).is_none(), "16 GB trains fine with fp8 on");
        let msg = vram_verdict(Some(between), &fp8_off, TrainPreset::Standard).expect("16 GB is below the no-fp8 floor");
        assert!(msg.contains("16 GB"), "{msg}");
        assert!(msg.contains("24 GB"), "names the higher floor: {msg}");
    }

    /// Nachbesserung Runde 4: `provision_trainer_env`'s own
    /// `capability_floor_refusal` call only runs on a fresh install or a
    /// repair. A card with an already-healthy environment (the common case
    /// on every run after the first) skipped that branch entirely and would
    /// have reached `train_precision_for_capability` unrefused -- this
    /// wiring test pins the second call site `start_character_training`
    /// needs so that gap cannot come back silently.
    #[test]
    fn every_run_checks_the_capability_floor_before_choosing_a_precision() {
        let src = include_str!("trainer.rs");
        let body = &src[src.find("pub fn start_character_training").expect("start fn")..];
        let body = &body[..body.find("pub fn character_training_status").expect("end of run")];
        let floor_at = body.find("capability_floor_refusal(").expect("the run checks the floor at all");
        let precision_at = body.find("train_precision_for_capability(cap)").expect("the run picks a precision");
        assert!(floor_at < precision_at, "the floor must be checked before a precision is chosen, not after");
    }

    #[test]
    fn every_step_of_the_run_ends_a_failure_through_the_same_door() {
        // A card that fills up during the latent or text-encoder cache used to
        // hand the raw Python tail to the note; only the training step named
        // the cause. All four children now end through end_failed_run.
        let src = include_str!("trainer.rs");
        let run = &src[src.find("pub fn start_character_training").expect("start fn")..];
        let run = &run[..run.find("pub fn character_training_status").expect("end of run")];
        assert_eq!(run.matches("if let Err(e) = run_streamed(c").count(), 4, "the run drives four children");
        assert_eq!(run.matches("end_failed_run(&run, &e, vram_mib)").count(), 4, "each child failure goes through the helper");
        assert!(!run.contains("{ \"cancelled\" } else { \"error\" }"), "a raw error still reaches the note");
    }

    #[test]
    fn out_of_memory_in_the_run_is_named_with_its_way_out_and_other_errors_pass_through() {
        let oom = "training failed (exit Some(1)).\ntorch.OutOfMemoryError: CUDA out of memory. Tried to allocate 512.00 MiB";
        let msg = training_failure_message(oom, Some(12288));
        assert!(msg.contains("ran out of memory"), "{msg}");
        assert!(msg.contains("This card has 12 GB"), "{msg}");
        assert!(msg.contains("close other apps"), "{msg}");
        assert!(msg.contains("Cloud mode"), "{msg}");
        assert!(msg.contains("Last steps:"), "{msg}");
        let other = "training failed (exit Some(1)).\nKeyError: 'foo'";
        assert_eq!(training_failure_message(other, Some(12288)), other);
    }

    #[test]
    fn the_runtime_library_class_is_the_one_the_visual_cpp_install_fixes() {
        assert!(runtime_library_missing("ImportError: VCOMP140.DLL was not found"));
        assert!(runtime_library_missing("OSError: [WinError 1114] initialization routine failed"));
        assert!(runtime_library_missing("ImportError: DLL load failed while importing _C"));
        assert!(!runtime_library_missing("ModuleNotFoundError: No module named 'torch'"));
        assert!(!runtime_library_missing("AssertionError: Torch not compiled with CUDA enabled"));
    }

    #[test]
    fn a_torch_that_does_not_load_after_setup_names_the_cause_not_the_network() {
        // What provision returns when the probe fails on a missing runtime
        // and the install could not fix it: the wrapper has to pick the
        // Visual C++ sentence on Windows, and never the network one.
        use super::next_step_for_log;
        let err = "PyTorch does not load in the trainer environment.\nImportError: VCOMP140.DLL was not found";
        let step = next_step_for_log(err, "FALLBACK", "windows");
        assert!(step.contains("Visual C++"), "{step}");
        assert!(!install_failed_message(err).contains("Check that you are online"));
    }

    #[test]
    fn the_setup_takes_the_paths_that_act_instead_of_pointing() {
        let src = include_str!("trainer.rs");
        let body = &src[src.find("fn provision_trainer_env(").expect("provision")..];
        let body = &body[..body.find("pub fn character_trainer_status").expect("end of provision")];
        assert!(body.contains("fetch_musubi_source(root, state, status_kind, tag, cancel, pid_slot)?"), "step 1 must go through the archive path");
        assert!(!body.contains("Command::new(\"git\")"), "provision itself must not require git");
        assert!(body.contains("disk_room_message(root, free, needed_gib)"), "room is asked before the first byte");
        assert_eq!(body.matches("pip_with_retry(").count(), 2, "both pip steps retry a dropped download");
        assert!(body.contains("probe_trainer_env(root, &venv_exe, gpu, device, \"after setup\")"), "the setup proves the environment loads");
        assert!(body.contains("winget_install(\"Microsoft.VCRedist.2015+.x64\", false"), "the runtime is installed, not linked");
        let base = &src[src.find("fn trainer_base_python(").expect("base")..];
        let base = &base[..base.find("fn musubi_source_marker").expect("end of base")];
        // 3.0.7: no winget for Python any more, LU's own Python through the
        // function ComfyUI uses too, on every system the pin carries.
        assert!(base.contains("crate::commands::install::machine_or_own("), "Python comes through the shared own-Python path");
        assert!(!base.contains("winget_install(\"Python.Python.3.12\""), "the second, Windows-only way is gone");
        let code = &src[..src.find("#[cfg(test)]").expect("tests start")];
        assert!(!code.contains("run_streamed(winget"), "winget lines never stream into the note");
    }

    /// The interpreter is decided BEFORE the setup spends anything. A machine
    /// with only Python 3.13 or 3.14 has to be told so in one sentence, not
    /// after an archive, a venv and 2.5 GB of wheels (ticket 0004,
    /// A user 2026-09-05, whose setup died in pip's step 4 with
    /// "requires a different Python").
    #[test]
    fn the_python_rule_is_enforced_before_anything_is_downloaded() {
        let src = include_str!("trainer.rs");
        let body = &src[src.find("fn provision_trainer_env(").expect("provision")..];
        let body = &body[..body.find("pub fn character_trainer_status").expect("end of provision")];
        let gate = body.find("trainer_base_python(python_bin").expect("the interpreter is chosen");
        for later in ["fetch_musubi_source(", "foreign_system_command(python_bin)", "pip_with_retry(", "create_dir_all("] {
            let at = body.find(later).unwrap_or_else(|| panic!("{later} is gone from the setup"));
            assert!(gate < at, "{later} runs before the Python rule is enforced");
        }
        assert!(body.contains("trainer_base_python(python_bin, state, status_kind, cancel)?"),
            "a Python the trainer cannot use has to end the setup, not warn");
        // The sentence names the versions, and the range is the one musubi and
        // the wheels agree on.
        assert_eq!(TRAINER_PYTHON_RANGE, "3.10, 3.11 or 3.12");
        let msg = no_trainer_python_message(&[("C:\\Python314\\python.exe".to_string(), "3.14.6".to_string())], "windows");
        assert!(msg.contains("3.10, 3.11 or 3.12"), "{msg}");
        assert!(msg.contains("3.14.6"), "the message names what is on the machine: {msg}");
        assert!(!trainer_supports_python("3.13.0") && !trainer_supports_python("3.14.6"));
    }
}

#[cfg(test)]
mod progress_line_tests {
    use super::*;
    use std::io::Cursor;

    fn collect(bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for_each_progress_line(Cursor::new(bytes.to_vec()), |l| out.push(l));
        out
    }

    #[test]
    fn a_carriage_return_ends_a_line_like_a_newline_does() {
        assert_eq!(collect(b"a\rb\rc\nd"), ["a", "b", "c", "d"]);
        assert_eq!(collect(b"\r\n\r"), Vec::<String>::new(), "empty segments are not lines");
        assert_eq!(collect(b"tail without newline"), ["tail without newline"]);
    }

    #[test]
    fn every_tqdm_redraw_reaches_the_step_counter() {
        let stream = b"steps:   0%|          | 0/400 [00:00<?, ?it/s]\rsteps:   0%|          | 1/400 [00:11<1:16:00, 11.4s/it]\rsteps:   0%|          | 2/400 [00:23<1:16:00, 11.4s/it]\n";
        let steps: Vec<(u64, u64)> = collect(stream).iter().filter_map(|l| parse_step_counter(l)).collect();
        assert_eq!(steps, [(0, 400), (1, 400), (2, 400)], "each \\r update is its own line");
    }

    #[test]
    fn a_cancel_with_no_child_alive_still_ends_the_run_before_the_next_spawn() {
        // The probe runs Command::output (nothing in pid_slot) and between two
        // children nothing is alive either, so Cancel there only sets the flag.
        // Each of the four children is preceded by a check of that flag.
        let src = include_str!("trainer.rs");
        let body = &src[src.find("pub fn start_character_training").expect("start fn")..];
        let body = &body[..body.find("info!(\"character training complete\")").expect("end of the run")];
        let checks = body.matches("if cancel_requested(&cancel) {").count();
        assert_eq!(checks, 4, "one cancel check per child, before its spawn");
        for label in ["\"latent cache\"", "\"text encoder cache\"", "\"training\"", "\"lora convert\""] {
            let spawn = body.find(label).expect(label);
            let check = body[..spawn].rfind("if cancel_requested(&cancel) {").expect("a check before the spawn");
            assert!(body[check..spawn].matches("run_streamed(").count() == 1, "the check right before {label}");
        }
    }

    #[test]
    fn what_the_dying_child_prints_after_a_cancel_is_not_the_log() {
        // The box showed a raw KeyboardInterrupt traceback in the live log
        // under a status of "cancelled" (06.09.2026): the tree was being
        // killed and the reader kept forwarding its last breaths.
        let src = include_str!("trainer.rs");
        let body = &src[src.find("fn run_child(").expect("run_child")..];
        let body = &body[..body.find("let exit = loop").expect("wait loop")];
        let reader = &body[body.find("for_each_progress_line(stream").expect("reader")..];
        let gate = reader.find("if cancel.load(Ordering::SeqCst)").expect("the reader checks the cancel flag");
        let log = reader.find("push_log(&run, trimmed)").expect("the reader logs");
        assert!(gate < log, "the cancel check comes before anything reaches the log");
    }

    #[test]
    fn the_child_reader_no_longer_waits_for_a_newline() {
        let src = include_str!("trainer.rs");
        let body = &src[src.find("fn run_child(").expect("run_child")..];
        let body = &body[..body.find("let exit = loop").expect("wait loop")];
        assert!(body.contains("for_each_progress_line(stream"), "the reader goes through the \\r-aware splitter");
        assert!(!body.contains(".lines()"), "BufRead::lines would hide tqdm updates until the epoch ends");
    }
}

/// Review Runde 2, B1: nothing may delete the Linux git preflight in
/// `fetch_musubi_source` or move it after the `git clone` it is meant to
/// guard, without a test going red. Same technique as
/// process_util.rs's `the_argv_matchers_share_one_refresh`.
#[cfg(test)]
mod git_preflight_call_site_guard {
    #[test]
    fn fetch_musubi_source_checks_git_before_clone() {
        let src = include_str!("trainer.rs");
        let fn_start = src
            .find("fn fetch_musubi_source(")
            .expect("fetch_musubi_source is gone from trainer.rs");
        let body = &src[fn_start..];

        let at_probe = body.find("is_git_present()").expect(
            "fetch_musubi_source no longer probes git before falling back to it: a \
             fresh Debian 13 or Fedora 43 box without git would clone straight into \
             a cryptic spawn error again instead of the distro-specific hint",
        );
        // The probe alone is not the whole guarantee: review Runde 2 merged
        // the old git_download_preflight() call into is_git_present() plus
        // this direct call to the same Linux hint builder, to avoid running
        // `git --version` twice. Anchoring only on is_git_present() would
        // stay green even if someone deleted the `#[cfg(target_os =
        // "linux")]` arm that actually builds the distro-specific message,
        // so the hint builder call has to be found too.
        let at_hint = body.find("linux_git_missing_message(").expect(
            "fetch_musubi_source no longer builds the Linux-specific git hint: a \
             fresh Debian 13 or Fedora 43 box without git would get the bare \
             network sentence again instead of the package manager command",
        );
        let at_clone = body
            .find("\"clone\"")
            .expect("the git clone literal is gone from fetch_musubi_source");

        assert!(
            at_probe < at_clone,
            "is_git_present() (byte {at_probe}) must run before the clone \
             (byte {at_clone}), not after"
        );
        assert!(
            at_hint < at_clone,
            "linux_git_missing_message(...) (byte {at_hint}) must run before the \
             clone (byte {at_clone}), not after"
        );
        assert!(
            at_probe < at_hint,
            "is_git_present() (byte {at_probe}) must be checked before building \
             the Linux hint (byte {at_hint}), not the other way round"
        );
    }
}

// ── 3.0.8 D28/D20: per photo captions and the Low VRAM recipe ───────────────
#[cfg(test)]
mod captions_and_low_vram_tests {
    use super::*;

    fn temp_set(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lu-trainer-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn args_for(preset: TrainPreset) -> Vec<String> {
        let cmd = training_command(
            "/tmp/venv/bin/python",
            Path::new("/tmp/musubi-tuner"),
            &TrainStep {
                dit: "/m/dit.safetensors",
                vae: "/m/ae.safetensors",
                text_encoder: "/m/qwen.safetensors",
                dataset: "/t/set.toml",
                steps: "1200",
                out_dir: "/t/out",
                out_name: "char_dave_zimage",
                precision: train_precision_for_capability(Some((8, 6))),
                preset,
            },
        );
        cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    fn value_of<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).map(String::as_str)
    }

    #[test]
    fn a_photo_and_its_own_caption_land_side_by_side_as_musubi_reads_them() {
        let dir = temp_set("caption");
        let staged = stage_image_into(&dir, "beach day.jpg", b"JPEGDATA", "davechar, a photo of davechar, red jacket, short hair, at the beach")
            .expect("staged");
        assert_eq!(staged, "beach_day.jpg");
        assert_eq!(fs::read(dir.join("beach_day.jpg")).unwrap(), b"JPEGDATA");
        // Same stem, `.txt`: what `caption_extension = ".txt"` makes musubi open.
        assert_eq!(
            fs::read_to_string(dir.join("beach_day.txt")).unwrap(),
            "davechar, a photo of davechar, red jacket, short hair, at the beach",
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_caption_is_one_line_without_stray_whitespace_and_capped() {
        assert_eq!(caption_file_text("  davechar,\n red jacket\r\n\tbeach  "), "davechar, red jacket beach");
        assert_eq!(caption_file_text("davechar, a photo of davechar"), "davechar, a photo of davechar");
        let long = format!("davechar, {}", "word ".repeat(400));
        let capped = caption_file_text(&long);
        assert!(capped.chars().count() <= 600, "{}", capped.len());
        assert!(capped.starts_with("davechar, "), "the trigger word stays in front");
        assert!(!capped.ends_with(' '));
    }

    #[test]
    fn staging_still_refuses_what_it_refused_before() {
        let dir = temp_set("refuse");
        assert!(stage_image_into(&dir, "x.gif", b"GIF", "c").is_err());
        assert!(stage_image_into(&dir, "x.png", b"", "c").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_dataset_config_carries_the_presets_resolution_and_the_txt_captions() {
        let img = Path::new("/t/set/img");
        let cache = Path::new("/t/set/cache");
        let normal = dataset_toml(img, cache, 10, TrainPreset::Standard);
        assert!(normal.contains("resolution = [768, 768]"), "{normal}");
        assert!(normal.contains("caption_extension = \".txt\""), "{normal}");
        assert!(normal.contains("num_repeats = 10"), "{normal}");
        let low = dataset_toml(img, cache, 10, TrainPreset::LowVram);
        assert!(low.contains("resolution = [512, 512]"), "{low}");
        assert!(low.contains("caption_extension = \".txt\""), "{low}");
    }

    #[test]
    fn the_normal_recipe_is_unchanged() {
        let args = args_for(TrainPreset::Standard);
        assert_eq!(value_of(&args, "--blocks_to_swap"), Some("16"));
        assert_eq!(value_of(&args, "--network_dim"), Some("32"));
        assert!(!args.iter().any(|a| a == "--gradient_checkpointing_cpu_offload"), "{args:?}");
        assert!(args.iter().any(|a| a == "--gradient_checkpointing"));
        assert!(args.iter().any(|a| a == "--fp8_base") && args.iter().any(|a| a == "--fp8_scaled"));
    }

    #[test]
    fn the_low_vram_recipe_swaps_the_most_blocks_z_image_allows_and_offloads_activations() {
        let args = args_for(TrainPreset::LowVram);
        // 28 = num_blocks (30) - 2, the assert in zimage_model.py enable_block_swap.
        assert_eq!(value_of(&args, "--blocks_to_swap"), Some("28"));
        assert_eq!(value_of(&args, "--network_dim"), Some("16"));
        assert!(args.iter().any(|a| a == "--gradient_checkpointing_cpu_offload"), "{args:?}");
        // The offload only works on top of gradient checkpointing.
        assert!(args.iter().any(|a| a == "--gradient_checkpointing"));
        assert!(args.iter().any(|a| a == "--fp8_base") && args.iter().any(|a| a == "--fp8_scaled"));
        // Nothing beyond what musubi-tuner v0.3.4 declares for this script.
        let known = [
            "--dit", "--vae", "--text_encoder", "--dataset_config", "--sdpa", "--mixed_precision", "--fp8_base",
            "--fp8_scaled", "--blocks_to_swap", "--timestep_sampling", "--weighting_scheme", "--discrete_flow_shift",
            "--optimizer_type", "--learning_rate", "--gradient_checkpointing", "--gradient_checkpointing_cpu_offload",
            "--max_data_loader_n_workers", "--persistent_data_loader_workers", "--network_module", "--network_dim",
            "--max_train_steps", "--save_precision", "--seed", "--output_dir", "--output_name",
        ];
        for a in args.iter().filter(|a| a.starts_with("--")) {
            assert!(known.contains(&a.as_str()), "{a} is not an argument this recipe has evidence for");
        }
    }

    #[test]
    fn the_preset_arrives_as_text_and_anything_unknown_is_normal() {
        assert_eq!(TrainPreset::from_arg(Some("low-vram")), TrainPreset::LowVram);
        assert_eq!(TrainPreset::from_arg(Some(" low-vram ")), TrainPreset::LowVram);
        assert_eq!(TrainPreset::from_arg(Some("standard")), TrainPreset::Standard);
        assert_eq!(TrainPreset::from_arg(Some("ultra")), TrainPreset::Standard);
        assert_eq!(TrainPreset::from_arg(None), TrainPreset::Standard, "an older frontend sends nothing");
        assert_eq!(TrainPreset::LowVram.text_encoder_batch(), "1");
        assert_eq!(TrainPreset::Standard.text_encoder_batch(), "8");
    }

    #[test]
    fn an_eight_gigabyte_card_is_pointed_at_low_vram_and_then_let_in() {
        let fp8 = train_precision_for_capability(Some((8, 6)));
        // An 8 GB card reports a little under 8192 MiB.
        let eight = 8188;
        let normal = vram_verdict(Some(eight), &fp8, TrainPreset::Standard).expect("Normal refuses 8 GB");
        assert!(normal.contains("Low VRAM"), "{normal}");
        assert!(normal.contains("Cloud mode"), "{normal}");
        assert!(vram_verdict(Some(eight), &fp8, TrainPreset::LowVram).is_none(), "Low VRAM takes an 8 GB card");
        // The 12 GB box trains with both.
        assert!(vram_verdict(Some(12288), &fp8, TrainPreset::LowVram).is_none());
    }

    #[test]
    fn a_six_gigabyte_card_stays_out_even_with_low_vram() {
        let fp8 = train_precision_for_capability(Some((8, 6)));
        let msg = vram_verdict(Some(6 * 1024), &fp8, TrainPreset::LowVram).expect("6 GB is below the Low VRAM floor");
        assert!(msg.contains("6 GB"), "{msg}");
        assert!(msg.contains("Cloud mode"), "{msg}");
        let normal = vram_verdict(Some(6 * 1024), &fp8, TrainPreset::Standard).expect("and below Normal");
        assert!(!normal.contains("Switch the trainer to Low VRAM"), "Low VRAM would not fit either: {normal}");
    }

    #[test]
    fn without_fp8_low_vram_has_no_lower_floor_of_its_own() {
        let no_fp8 = train_precision_for_capability(None);
        assert_eq!(vram_floor_mib(&no_fp8, TrainPreset::LowVram), vram_floor_mib(&no_fp8, TrainPreset::Standard));
        assert_eq!(vram_floor_mib(&train_precision_for_capability(Some((8, 6))), TrainPreset::LowVram), 7680);
    }

    #[test]
    fn the_run_threads_the_preset_into_every_place_that_depends_on_it() {
        let src = include_str!("trainer.rs");
        let run = &src[src.find("pub fn start_character_training").expect("start fn")..];
        let run = &run[..run.find("pub fn character_training_status").expect("end of run")];
        assert!(run.contains("TrainPreset::from_arg(preset.as_deref())"));
        assert!(run.contains("dataset_toml(&img_dir, &cache_dir, repeats, preset)"));
        assert!(run.contains("vram_verdict(vram_mib, &precision, preset)"));
        assert!(run.contains("preset.text_encoder_batch()"));
        assert!(run.contains("            preset,\n        });"), "the training step gets the preset");
    }

    #[test]
    fn a_style_run_writes_a_style_file_and_an_older_frontend_trains_a_character() {
        assert_eq!(TrainKind::from_arg(Some("style")), TrainKind::Style);
        assert_eq!(TrainKind::from_arg(Some(" style ")), TrainKind::Style);
        assert_eq!(TrainKind::from_arg(Some("character")), TrainKind::Character);
        assert_eq!(TrainKind::from_arg(Some("pose")), TrainKind::Character);
        assert_eq!(TrainKind::from_arg(None), TrainKind::Character, "an older frontend sends nothing");
        assert_eq!(TrainKind::Character.output_name("anna"), "char_anna_zimage");
        assert_eq!(TrainKind::Style.output_name("inkwash"), "style_inkwash_zimage");
        // The Use shelf and the Edit references read `char_..._zimage`; a style
        // must not look like one (character_files.rs `trigger_of`).
        assert!(crate::commands::character_files::trigger_of("style_inkwash_zimage.safetensors").is_none());
        let style = TrainKind::Style.finished_line("style_inkwash_zimage.safetensors", Path::new("/l/x"), "inkwash");
        assert!(style.starts_with("Style ready"), "{style}");
        assert!(!style.contains("Character"), "{style}");
    }

    #[test]
    fn the_run_threads_the_kind_into_the_file_name_and_keeps_a_style_out_of_the_references() {
        let src = include_str!("trainer.rs");
        let run = &src[src.find("pub fn start_character_training").expect("start fn")..];
        let run = &run[..run.find("pub fn character_training_status").expect("end of run")];
        assert!(run.contains("TrainKind::from_arg(kind.as_deref())"));
        assert!(run.contains("let out_name = kind.output_name(&lora_name);"));
        assert!(!run.contains("format!(\"char_{lora_name}_zimage\")"));
        let marker = run.find("write_training_marker").expect("the marker call");
        assert!(run[..marker].ends_with("if kind == TrainKind::Character {\n            crate::commands::character_files::"), "only a character's photos become references");
    }
}
