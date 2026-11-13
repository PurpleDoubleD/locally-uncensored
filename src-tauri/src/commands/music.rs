//! The local music engine of the Mac: ACE-Step 1.5.
//!
//! On Windows and Linux a track is a ComfyUI graph on the all-in-one ACE-Step
//! checkpoint. A Mac has no ComfyUI, so here the engine runs the way the
//! other Mac engines run: a venv of its own at one pinned commit, the weights
//! of the official repository at one pinned revision, and one Python process
//! per track that the app starts, reads and can end.
//!
//! Why a process per track and not the engine's REST server: the server has
//! no way to cancel a task (`docs/en/API.md` names none), so a Stop would have
//! to end the whole server anyway, and a server that stays up keeps every
//! model in memory beside the image and video engines. A process that ends
//! gives all of it back.
//!
//! Every statement about the engine below was read from its source at the
//! pinned commit (`pyproject.toml`, `uv.lock`, `acestep/inference.py`,
//! `acestep/audio_utils.py`, `acestep/llm_inference.py`,
//! `acestep/model_downloader.py`,
//! `acestep/core/generation/handler/init_service_orchestrator.py`,
//! `acestep/core/generation/handler/progress.py`), 14.10.2026. Nothing was
//! installed and no track was made with it yet: the real run is
//! `real_run_mac::music_run`.
//!
//! Where it was read:
//!   - the code, MIT: <https://github.com/ACE-Step/ACE-Step-1.5> at `COMMIT`
//!     (`requires-python = ">=3.11,<3.13"`, the darwin arm64 pins of
//!     `uv.lock`, the macOS start scripts with `ACESTEP_LM_BACKEND=mlx`)
//!   - the REST server and its two calls, with no way to cancel a task:
//!     `docs/en/API.md` at the same commit
//!   - the weights, MIT: <https://huggingface.co/ACE-Step/Ace-Step1.5> at
//!     `REVISION`, the four folders by the hub's file listing
//!   - why the runner writes the WAV itself: `torchaudio.save` of
//!     <https://github.com/pytorch/audio/blob/v2.10.0/src/torchaudio/__init__.py>
//!     and the FFmpeg note of <https://github.com/pytorch/torchcodec>
//!   - the memory floor: the tier table of `docs/en/GPU_COMPATIBILITY.md`,
//!     which puts the 1.7B language model at 12 GB and more

use crate::commands::{bad_request, internal, not_found, CmdResult};
use crate::install_state::InstallSlot;
use crate::os_error;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::Mutex;
use std::time::{Duration, Instant};

// ── The pins ──────────────────────────────────────────────────────────

/// The head of `main` on 29.08.2026. The last release, v0.1.8 of May, is far
/// behind it and has no Mac fixes of the summer, so the pin is a commit.
pub(crate) const COMMIT: &str = "ca1e85fe9430179831e6bc6be790c332190a3866";
/// What `pyproject.toml` calls the package at that commit.
pub(crate) const VERSION: &str = "1.5.0";
/// The archive of the commit and not a `git+` address: pip would need `git`
/// for that, and a Mac without the Xcode tools has none. The repository is
/// 14 MB.
const SOURCE: &str = "https://github.com/ACE-Step/ACE-Step-1.5/archive";
/// Its name on PyPI is taken by an unrelated release of the first ACE-Step
/// (0.1.0 of May 2025), so it is never installed by name alone.
const PACKAGE: &str = "ace-step";

/// Every package the engine pulls in on an Apple Silicon Mac, at the version
/// its author's `uv.lock` resolves at the pinned commit: the closure of
/// `ace-step` for `sys_platform == 'darwin'` and `platform_machine ==
/// 'arm64'` on Python 3.12, read from the lock file, 124 packages, all from
/// PyPI. Left open, pip takes what was released this morning, untested. The
/// wheels for this Mac come to about 0.33 GB.
const PINNED: [&str; 124] = [
    "absl-py==2.4.0", "accelerate==1.12.0", "aiofiles==24.1.0", "aiohappyeyeballs==2.6.1", "aiohttp==3.13.3",
    "aiosignal==1.4.0", "annotated-doc==0.0.4", "annotated-types==0.7.0", "anyio==4.12.1", "attrs==25.4.0",
    "brotli==1.2.0", "certifi==2026.1.4", "cffi==2.0.0", "charset-normalizer==3.4.4", "click==8.3.1",
    "contourpy==1.3.3", "cycler==0.12.1", "diffusers==0.37.1", "diskcache==5.6.3", "einops==0.8.2",
    "einx==0.3.0", "fastapi==0.128.0", "ffmpy==1.0.0", "filelock==3.20.3", "fonttools==4.61.1",
    "frozendict==2.4.7", "frozenlist==1.8.0", "fsspec==2026.1.0", "gradio==6.2.0", "gradio-client==2.0.2",
    "groovy==0.1.2", "grpcio==1.78.0", "h11==0.16.0", "hf-xet==1.2.0", "httpcore==1.0.9", "httptools==0.7.1",
    "httpx==0.28.1", "huggingface-hub==0.36.0", "idna==3.11", "importlib-metadata==8.7.1", "jinja2==3.1.6",
    "kiwisolver==1.4.9", "lightning==2.6.1", "lightning-utilities==0.15.2", "llvmlite==0.46.0", "loguru==0.7.3",
    "lycoris-lora==3.4.0", "markdown==3.10.1", "markdown-it-py==4.0.0", "markupsafe==3.0.3",
    "matplotlib==3.10.8", "mdurl==0.1.2", "mlx==0.30.6", "mlx-lm==0.29.1", "mlx-metal==0.30.6",
    "modelscope==1.34.0", "mpmath==1.3.0", "multidict==6.7.1", "networkx==3.6.1", "numba==0.63.1",
    "numpy==2.3.5", "orjson==3.11.5", "packaging==26.0", "pandas==2.3.3", "peft==0.18.1", "pillow==12.1.0",
    "propcache==0.4.1", "protobuf==6.33.5", "psutil==7.2.1", "pycparser==3.0", "pydantic==2.12.5",
    "pydantic-core==2.41.5", "pydub==0.25.1", "pygments==2.19.2", "pyparsing==3.3.2",
    "python-dateutil==2.9.0.post0", "python-dotenv==1.2.1", "python-multipart==0.0.22",
    "pytorch-lightning==2.6.1", "pytorch-wavelets==1.3.0", "pytz==2025.2", "pywavelets==1.9.0", "pyyaml==6.0.3",
    "regex==2026.1.15", "requests==2.32.5", "rich==14.3.1", "safehttpx==0.1.7", "safetensors==0.7.0",
    "scipy==1.17.0", "semantic-version==2.10.0", "sentencepiece==0.2.1", "setuptools==71.1.0",
    "shellingham==1.5.4", "six==1.17.0", "soundfile==0.13.1", "starlette==0.50.0", "sympy==1.14.0",
    "tensorboard==2.20.0", "tensorboard-data-server==0.7.2", "tokenizers==0.22.2", "toml==0.10.2",
    "tomlkit==0.13.3", "torch==2.10.0", "torchao==0.16.0", "torchaudio==2.10.0", "torchcodec==0.10.0",
    "torchmetrics==1.8.2", "torchvision==0.25.0", "tqdm==4.67.1", "transformers==4.57.6", "typer==0.21.1",
    "typer-slim==0.21.2", "typing-extensions==4.15.0", "typing-inspection==0.4.2", "tzdata==2025.3",
    "urllib3==2.6.3", "uvicorn==0.40.0", "uvloop==0.22.1", "vector-quantize-pytorch==1.27.20",
    "watchfiles==1.1.1", "websockets==16.0", "werkzeug==3.1.5", "yarl==1.22.0", "zipp==3.23.0",
];

/// The build backend of the engine's `pyproject.toml` (hatchling) and what
/// it needs, at the versions PyPI had on the day of the pinned commit. pip
/// would otherwise fetch whatever hatchling is newest into a throwaway build
/// environment, the one part of the install no pin reached. They go in
/// first, and the engine is then built with them (`--no-build-isolation`).
/// `packaging` and `tomlkit` stand here at the versions of `PINNED`, or the
/// first call would take the newest of both.
const BUILD_PINNED: [&str; 6] = [
    "hatchling==1.32.0", "packaging==26.0", "pathspec==1.1.1", "pluggy==1.6.0", "tomlkit==0.13.3", "trove-classifiers==2026.6.1.19",
];

/// What the install proves it can import: the module of `generate_music`,
/// which pulls torch, MLX and the audio writer in, and the writer of the
/// track itself.
const MODULE: &str = "acestep.inference, soundfile";

/// What the venv takes on disk, with room for the wheels pip unpacks. Not
/// measured yet: the wheels are 0.33 GB, torch and MLX unpack to several
/// times that.
const ENGINE_INSTALL_BYTES: u64 = 3_000_000_000;

/// The official repository of the weights, at the revision the catalogue
/// was checked against (Hugging Face API, 14.10.2026). Its own sha, so a
/// repository that is replaced is still the one whose size is stated here.
pub(crate) const REPO: &str = "ACE-Step/Ace-Step1.5";
pub(crate) const REVISION: &str = "19671f406d603126926c1b7e2adc169acbcade22";

/// The four folders of the repository a track reads, each with its slash:
/// the turbo DiT, the VAE, the text encoder and the 5 Hz language model that
/// writes the song's structure. The card, the licence and the root config
/// stay on the hub.
const PARTS: [&str; 4] = ["acestep-v15-turbo/", "vae/", "Qwen3-Embedding-0.6B/", "acestep-5Hz-lm-1.7B/"];

/// Bytes of the four folders at `REVISION`, 25 files.
pub(crate) const WEIGHTS_BYTES: u64 = 10_092_093_389;

/// The DiT and the language model a run loads, by their folder names.
const DIT: &str = "acestep-v15-turbo";
const LM: &str = "acestep-5Hz-lm-1.7B";

/// The one model this engine offers, as the Model Manager and Create name it.
pub(crate) const MODEL_ID: &str = "acestep-v15-turbo";
pub(crate) const MODEL_NAME: &str = "ACE-Step 1.5 Turbo";

/// Below this a run is refused. The engine's own table puts the 1.7B
/// language model at 12 to 16 GB of graphics memory, and on a Mac that
/// memory is shared with everything else. Measured on an M5 Pro with 48 GB
/// (15.10.2026), a 30 second track took about 28 GB with the decoder in
/// pieces of 256: free memory went from 83 to 25 percent. 48 GB is the
/// smallest Mac that has run it; below, the run would push macOS into swap.
pub(crate) const MIN_RAM_GB: u32 = 48;

/// The turbo DiT is distilled to eight steps, which is the engine's default.
const STEPS: u32 = 8;

/// The shortest and the longest track. The engine takes 10 to 600 seconds;
/// Create offers up to four minutes.
const MIN_SECONDS: u32 = 10;
const MAX_SECONDS: u32 = 240;

/// The engine's own limits for the two texts.
const MAX_CAPTION_CHARS: usize = 512;
const MAX_LYRICS_CHARS: usize = 4000;

/// A run that is still going after this long is not going to end.
const GENERATE_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// A run that has said nothing for this long has hung. The engine is known
/// to stop on a Metal kernel between 80 and 97 percent and never return
/// (upstream issue 1214), and only ending the process frees its memory.
const STALL_AFTER: Duration = Duration::from_secs(10 * 60);

// ── Where it lives ────────────────────────────────────────────────────

/// Everything of the engine in one folder under the app's data folder: the
/// venv, the weights, and the folder a run works in. Not under the cache,
/// which the system and cleaning tools empty (`media_store`).
fn root() -> PathBuf {
    crate::os_paths::data_dir().join("acestep")
}

fn venv_dir(root: &Path) -> PathBuf {
    root.join("venv")
}

fn venv_python(venv: &Path) -> PathBuf {
    venv.join("bin").join("python")
}

/// What the engine calls its checkpoints folder (`ACESTEP_CHECKPOINTS_DIR`).
fn checkpoints_dir(root: &Path) -> PathBuf {
    root.join("checkpoints")
}

/// The project root of a run (`ACESTEP_PROJECT_ROOT`) and its working
/// folder. The engine keeps its timing estimates there, and the job files
/// and the engine's own output of a run lie there until the track is moved
/// to where the app keeps it.
fn work_dir(root: &Path) -> PathBuf {
    root.join("work")
}

/// `HF_HOME` of the download, so the hub's chunk cache is in a folder of
/// this app. It is scratch, and it goes once the weights are whole.
fn hf_home(root: &Path) -> PathBuf {
    root.join(".hf-cache")
}

/// Where the tracks are kept, beside the videos and the images of the Mac,
/// and served by `read_media_file` like them.
pub(crate) fn outputs_root() -> PathBuf {
    crate::os_paths::config_root().join("music")
}

/// Where the pid of a running track is noted, for the start after a session
/// that ended hard.
fn run_pid_file(root: &Path) -> PathBuf {
    root.join("run.pid")
}

fn ensure_apple_silicon() -> Result<(), String> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Ok(())
    } else {
        Err(bad_request("Local music on a Mac needs Apple Silicon. Use the ComfyUI lane on this system."))
    }
}

// ── The engine ────────────────────────────────────────────────────────

/// The first pip call: the build backend and the packages it needs, as
/// wheels and nothing else.
fn pip_build_args() -> Vec<String> {
    ["-m", "pip", "install", "--upgrade", "--only-binary", ":all:"]
        .iter()
        .map(|a| a.to_string())
        .chain(BUILD_PINNED.iter().map(|p| p.to_string()))
        .collect()
}

/// The arguments after `pip install --upgrade --no-build-isolation`: every
/// pin, then the engine from the archive of its commit, all in one call.
fn pip_specs() -> Vec<String> {
    PINNED
        .iter()
        .map(|p| p.to_string())
        .chain(std::iter::once(format!("{PACKAGE} @ {SOURCE}/{COMMIT}.zip")))
        .collect()
}

/// The second pip call, which builds the engine with the backend of the
/// first one and installs it with every package it stands on.
fn pip_engine_args() -> Vec<String> {
    ["-m", "pip", "install", "--upgrade", "--no-build-isolation"]
        .iter()
        .map(|a| a.to_string())
        .chain(pip_specs())
        .collect()
}

/// Written when the install ran to its end. It records what was installed,
/// so a venv from an older pin does not pass for the current engine.
fn stamp_file(venv: &Path) -> PathBuf {
    venv.join(".lu-acestep-engine")
}

fn stamp() -> String {
    BUILD_PINNED.iter().map(|p| p.to_string()).chain(pip_specs()).collect::<Vec<_>>().join("\n")
}

fn engine_ready_at(venv: &Path) -> bool {
    venv_python(venv).exists() && std::fs::read_to_string(stamp_file(venv)).is_ok_and(|s| s == stamp())
}

/// Whether the engine is installed, at the pinned commit. Read from disk
/// alone: the Model Manager asks this every time it is drawn.
pub(crate) fn engine_ready() -> bool {
    engine_ready_at(&venv_dir(&root()))
}

fn python_has_module(python: &str, module: &str) -> bool {
    crate::python::python_command(python)
        .args(["-c", &format!("import {module}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// `<base> -m venv <dir>`, replacing whatever a stopped attempt left there.
fn create_venv(slot: &InstallSlot, base: &str, venv: &Path) -> Result<(), String> {
    if let Some(parent) = venv.parent() {
        std::fs::create_dir_all(parent).map_err(|e| os_error::english(&e))?;
    }
    slot.log(format!("creating the music engine environment at {}", venv.display()));
    let mut cmd = crate::python::python_command(base);
    cmd.args(["-m", "venv", "--clear"]).arg(venv.as_os_str());
    crate::commands::video::run_streamed(slot, &mut cmd)
        .map_err(|e| format!("Could not create the Python environment for the music engine. {e}"))?;
    if !venv_python(venv).exists() {
        return Err("Python reported a new environment, but there is no interpreter in it.".to_string());
    }
    Ok(())
}

/// The engine's interpreter, with the engine installed first when it is not.
///
/// The venv is built from the Python the app fetches for itself (3.12, see
/// `private_python`) and never from one found on the Mac: the engine takes
/// 3.11 and 3.12 only (`requires-python = ">=3.11,<3.13"`), and a Mac whose
/// Homebrew moved on to 3.13 would get an install that pip refuses at the
/// end. `base` is for the tests.
fn ensure_engine_at(slot: &InstallSlot, base: Option<String>, venv: &Path) -> Result<String, String> {
    let python = venv_python(venv).to_string_lossy().to_string();
    if engine_ready_at(venv) {
        return Ok(python);
    }
    // A venv whose pip answers is one a stopped install left behind, and pip
    // continues in it. Anything less is built again from the start.
    if !(venv_python(venv).exists() && python_has_module(&python, "pip")) {
        let base = match base {
            Some(base) => base,
            None => crate::private_python::ensure(slot)?.to_string_lossy().to_string(),
        };
        slot.log(format!("Python: {base}"));
        create_venv(slot, &base, venv)?;
    }
    let _ = std::fs::remove_file(stamp_file(venv));
    slot.log(format!("installing the music engine, ACE-Step {VERSION} at {} (one-time)", &COMMIT[..7]));
    let mut build = crate::python::python_command(&python);
    build.args(pip_build_args());
    crate::commands::video::run_streamed(slot, &mut build).map_err(|e| format!("Could not install the music engine. {e}"))?;
    let mut pip = crate::python::python_command(&python);
    pip.args(pip_engine_args());
    crate::commands::video::run_streamed(slot, &mut pip).map_err(|e| format!("Could not install the music engine. {e}"))?;
    if !python_has_module(&python, MODULE) {
        return Err(format!("pip install finished but `import {MODULE}` still fails"));
    }
    std::fs::write(stamp_file(venv), stamp()).map_err(|e| os_error::english(&e))?;
    Ok(python)
}

// ── The weights ───────────────────────────────────────────────────────

/// Written into the checkpoints folder when every file is on disk at the
/// size the hub lists. A folder that merely has something in it proves
/// nothing.
const MANIFEST: &str = ".lu-music-pack.json";

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct ManifestFile {
    path: String,
    size: u64,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Manifest {
    revision: String,
    files: Vec<ManifestFile>,
}

fn read_manifest(dir: &Path) -> Option<Manifest> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(MANIFEST)).ok()?).ok()
}

/// The files of `manifest` that are not in `dir` as the hub listed them.
///
/// A Python file counts when it is there at all: before a run the engine
/// copies its own `.py` files over the downloaded ones (`_sync_model_code_files`
/// in `model_downloader.py`), and a model that was whole must not read as
/// broken after its first track.
fn missing_files(dir: &Path, manifest: &Manifest) -> Vec<String> {
    manifest
        .files
        .iter()
        .filter(|f| {
            let size = std::fs::metadata(dir.join(&f.path)).map(|m| m.len()).ok();
            if f.path.ends_with(".py") {
                size.is_none()
            } else {
                size != Some(f.size)
            }
        })
        .map(|f| f.path.clone())
        .collect()
}

/// The weights are complete with their manifest, at the pinned revision,
/// and every file it names. A handful of `stat` calls.
fn weights_complete(dir: &Path) -> bool {
    read_manifest(dir).is_some_and(|m| m.revision == REVISION && !m.files.is_empty() && missing_files(dir, &m).is_empty())
}

fn installed_at(root: &Path) -> bool {
    engine_ready_at(&venv_dir(root)) && weights_complete(&checkpoints_dir(root))
}

/// Engine and weights, both. This is what the tile, the Create tab and a
/// run ask.
pub(crate) fn installed() -> bool {
    installed_at(&root())
}

fn wanted(path: &str) -> bool {
    PARTS.iter().any(|part| path.starts_with(part))
}

/// The files of the repository a run reads, or why this is not the model.
/// Each part has to bring weights: the hub lists a repository whose upload
/// is under way just the same.
fn plan(listing: &[crate::commands::mlx_snapshot::RepoFile]) -> Result<Manifest, String> {
    let files: Vec<ManifestFile> = listing
        .iter()
        .filter(|f| wanted(&f.path))
        .map(|f| ManifestFile { path: f.path.clone(), size: f.size })
        .collect();
    for part in PARTS {
        if !files.iter().any(|f| f.path.starts_with(part) && f.path.ends_with(".safetensors")) {
            return Err(format!("The repository has no weights under {part} and cannot be run. Try again later."));
        }
    }
    Ok(Manifest { revision: REVISION.to_string(), files })
}

/// What an install still has to write: the weights as far as they are not
/// there, and the engine when it is missing.
fn bytes_to_fetch(root: &Path) -> u64 {
    let dir = checkpoints_dir(root);
    let weights = if weights_complete(&dir) {
        0
    } else {
        // What a stopped attempt fetched is not needed a second time.
        WEIGHTS_BYTES.saturating_sub(crate::install_state::dir_size(&dir))
    };
    weights + if engine_ready_at(&venv_dir(root)) { 0 } else { ENGINE_INSTALL_BYTES }
}

fn install_weights(slot: &InstallSlot, python: &str, root: &Path) -> Result<(), String> {
    let dir = checkpoints_dir(root);
    if weights_complete(&dir) {
        slot.log("the weights of ACE-Step 1.5 are on disk already");
        return Ok(());
    }
    // The hub says what the repository holds, at the pinned revision. That
    // list is the download, and afterwards it is what the folder is held
    // against. Nothing but this list is asked before the download starts.
    slot.log(format!("asking the hub what {REPO} holds"));
    let listing = crate::commands::mlx::fetch_repo_listing(REPO, REVISION).map_err(|e| {
        if crate::commands::mlx::is_hub_denied(&e) {
            e
        } else {
            format!("Could not read the file list of {REPO}: {e}.")
        }
    })?;
    let manifest = plan(&listing)?;
    let total: u64 = manifest.files.iter().map(|f| f.size).sum();
    slot.log(format!("downloading {REPO} ({})", crate::commands::mlx_snapshot::human_bytes(total)));
    std::fs::create_dir_all(&dir).map_err(|e| os_error::english(&e))?;
    let _ = std::fs::remove_file(dir.join(MANIFEST));
    crate::install_state::watch_dir_size(slot.clone(), dir.clone(), vec![hf_home(root).join("xet")], total);
    let files: Vec<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    hub_snapshot(slot, python, root, &dir, &files)?;
    let missing = missing_files(&dir, &manifest);
    if !missing.is_empty() {
        let shown: Vec<&str> = missing.iter().take(3).map(String::as_str).collect();
        return Err(format!("The download finished, but the model is missing {}. Start it again.", shown.join(", ")));
    }
    let record = serde_json::to_string(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(MANIFEST), record).map_err(|e| os_error::english(&e))?;
    // The chunk cache is download scratch that no run reads.
    let _ = std::fs::remove_dir_all(hf_home(root));
    Ok(())
}

/// Pull the named files of the repository into `target` at the pinned
/// revision, through `huggingface_hub` in the engine's venv. Everything that
/// varies goes in as an argument and not into the script's source.
fn hub_snapshot(slot: &InstallSlot, python: &str, root: &Path, target: &Path, files: &[&str]) -> Result<(), String> {
    const SCRIPT: &str = "import sys\nfrom huggingface_hub import snapshot_download\nsnapshot_download(repo_id=sys.argv[1], revision=sys.argv[2], local_dir=sys.argv[3], allow_patterns=sys.argv[4:])";
    let mut cmd = crate::python::python_command(python);
    cmd.args(["-c", SCRIPT, REPO, REVISION]).arg(target.as_os_str()).args(files);
    cmd.env("HF_HOME", hf_home(root)).env("HF_XET_CACHE", hf_home(root).join("xet"));
    crate::commands::mlx::apply_hf_token(&mut cmd);
    let freed = crate::commands::mlx::drop_stale_partials(target);
    if freed > 0 {
        slot.log(format!("removed {} that a stopped download left half written", crate::commands::mlx_snapshot::human_bytes(freed)));
    }
    crate::commands::mlx::run_hub_step(slot, &mut cmd, &[target, &hf_home(root)])?;
    crate::commands::mlx::drop_stale_partials(target);
    Ok(())
}

// ── Commands: status, install, remove ─────────────────────────────────

const DESCRIPTION: &str = "Songs with vocals or instrumentals from a style prompt and your lyrics, up to four minutes. Runs on Apple Silicon through MLX. The download is the official ACE-Step 1.5 release with its song-writing language model.";

/// The one catalogue entry, in the fields the Mac tiles read.
fn model_json(installed: bool) -> Value {
    json!({
        "id": MODEL_ID,
        "name": MODEL_NAME,
        "repo": REPO,
        "sizeGB": ((WEIGHTS_BYTES as f64) / 1e8).round() / 10.0,
        "minRamGB": MIN_RAM_GB,
        "unfiltered": false,
        "description": DESCRIPTION,
        "installed": installed,
    })
}

pub fn music_status(_state: &AppState, _args: &Value) -> CmdResult {
    let apple_silicon = ensure_apple_silicon().is_ok();
    let engine = engine_ready();
    let installed = installed();
    Ok(json!({
        "available": apple_silicon,
        "appleSilicon": apple_silicon,
        "engineInstalled": engine,
        "engineVersion": engine.then_some(VERSION),
        "engineCommit": COMMIT,
        "installed": installed,
        "running": busy(),
        "outputsRoot": outputs_root(),
        "model": model_json(installed),
    }))
}

pub fn music_install(state: &AppState, _args: &Value) -> CmdResult {
    ensure_apple_silicon()?;
    let root = root();
    let slot = state.install_music();
    if slot.is_running() {
        return Ok(json!({ "ok": true, "status": "installing" }));
    }
    if installed_at(&root) {
        if slot.try_start() {
            slot.complete(format!("{MODEL_ID} already installed"));
        }
        return Ok(json!({ "ok": true, "status": "complete", "id": MODEL_ID }));
    }
    // Before a byte is fetched: a download that dies hours in with a full
    // disk leaves the Mac unusable and nothing to resume from.
    let note = if engine_ready_at(&venv_dir(&root)) { "" } else { "incl. the one-time music engine" };
    crate::commands::system::ensure_free_space(&crate::os_paths::data_dir(), MODEL_NAME, bytes_to_fetch(&root), note)
        .map_err(bad_request)?;
    // Out of Time Machine before the gigabytes arrive.
    std::fs::create_dir_all(&root).map_err(|e| internal(os_error::english(&e)))?;
    crate::media_store::keep_out_of_backups(&root);
    // Check and claim in one step: of two clicks, one starts the install.
    if !slot.try_start() {
        return Ok(json!({ "ok": true, "status": "installing" }));
    }
    crate::install_state::spawn_install(slot, move |slot| {
        let python = ensure_engine_at(slot, None, &venv_dir(&root))?;
        install_weights(slot, &python, &root)?;
        if !installed_at(&root) {
            return Err("The download finished, but the model is not complete on disk. Start it again.".to_string());
        }
        Ok(format!("{MODEL_ID} installed"))
    });
    Ok(json!({ "ok": true, "status": "installing", "id": MODEL_ID }))
}

pub fn music_install_status(state: &AppState, _args: &Value) -> CmdResult {
    Ok(serde_json::to_value(state.install_music().snapshot()).unwrap_or(Value::Null))
}

/// Stop the install that is running. What it fetched stays, and the next
/// Get picks up from there.
pub fn music_cancel_install(state: &AppState, _args: &Value) -> CmdResult {
    Ok(json!({ "ok": true, "cancelled": state.install_music().cancel() }))
}

/// Remove the weights. The engine stays, as the video engines stay when
/// their last model goes: it is small beside the weights, and Get brings
/// the weights back without setting it up again.
pub fn music_delete(state: &AppState, _args: &Value) -> CmdResult {
    if busy() {
        return Err(bad_request("A track is being made. Wait for it to finish before removing the model."));
    }
    if state.install_music().is_running() {
        return Err(bad_request("The music model is still installing. Wait for it to finish, or stop it first."));
    }
    delete_at(&root())?;
    Ok(json!({ "ok": true, "id": MODEL_ID }))
}

fn delete_at(root: &Path) -> Result<(), String> {
    let dir = checkpoints_dir(root);
    if !dir.is_dir() {
        return Err(not_found(format!("{MODEL_ID} is not installed")));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| internal(format!("delete {MODEL_ID}: {}", os_error::english(&e))))?;
    let _ = std::fs::remove_dir_all(hf_home(root));
    Ok(())
}

// ── A run ─────────────────────────────────────────────────────────────

#[derive(Deserialize, Debug, Default)]
struct GenerateArgs {
    /// The style: genre, mood, instruments.
    prompt: String,
    #[serde(default)]
    lyrics: Option<String>,
    #[serde(default)]
    seconds: Option<f64>,
    #[serde(default)]
    seed: Option<i64>,
    /// The name the caller gives the run, for a Cancel of this run alone.
    #[serde(default)]
    run: Option<String>,
}

/// The length the engine is asked for, in whole seconds within what this
/// lane offers. Nothing asked: two minutes, as the Windows lane.
fn seconds_for(asked: Option<f64>) -> u32 {
    let s = asked.filter(|s| s.is_finite()).unwrap_or(120.0).round();
    (s.max(0.0) as u32).clamp(MIN_SECONDS, MAX_SECONDS)
}

/// The lyrics as the engine takes them. Empty is an instrumental. Lines
/// without a single section tag are one verse: the model sings what stands
/// under `[Verse]`, `[Chorus]` and the like, and the Create tab promises
/// that plain lines are wrapped for the user.
fn lyrics_for(raw: Option<&str>) -> String {
    let text = raw.unwrap_or("").trim();
    if text.is_empty() {
        return String::new();
    }
    let tagged = text.lines().any(|l| {
        let l = l.trim();
        l.starts_with('[') && l.ends_with(']')
    });
    let lyrics = if tagged { text.to_string() } else { format!("[Verse]\n{text}") };
    lyrics.chars().take(MAX_LYRICS_CHARS).collect()
}

/// The seed of a run as the engine takes it: zero or above. Create sends
/// the one it threw; without one the run throws its own here, so the
/// number can be kept with the track.
fn seed_for(asked: Option<i64>) -> u32 {
    match asked {
        Some(s) if s >= 0 => (s % (u32::MAX as i64 + 1)) as u32,
        _ => {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(7);
            nanos ^ std::process::id().rotate_left(16)
        }
    }
}

/// What the runner script reads, one file per run.
fn job_json(root: &Path, caption: &str, lyrics: &str, seconds: u32, seed: u32, job_dir: &Path, output: &Path) -> Value {
    json!({
        "caption": caption.chars().take(MAX_CAPTION_CHARS).collect::<String>(),
        "lyrics": lyrics,
        "seconds": seconds,
        "seed": seed,
        "steps": STEPS,
        "dit": DIT,
        "lm": LM,
        "checkpoints": checkpoints_dir(root),
        "project_root": work_dir(root),
        "work": job_dir,
        "output": output,
    })
}

/// The program a run is. It loads the DiT and the language model, makes one
/// track of the length asked, writes it as WAV and moves it to where the app
/// keeps it. What it does is said on stdout in lines that begin with
/// `LU-MUSIC `, each a JSON object, besides what the engine prints itself.
///
/// The track is written here and not by the engine. Its own writer
/// (`AudioSaver` in `acestep/audio_utils.py`) hands WAV and FLAC to
/// `torchaudio.save`, and the torchaudio 2.10 of the lock file ignores the
/// backend it is given and encodes through TorchCodec, which needs FFmpeg
/// libraries a Mac does not have (`src/torchaudio/__init__.py` at v2.10.0,
/// TorchCodec README). The engine would then log the failure, return the
/// track with an empty path and the run would end without a file. So the
/// engine gets no folder to save into (`save_dir=None`), and the runner
/// writes the tensor it returns with `soundfile`, whose wheel brings
/// libsndfile along: 16-bit PCM WAV, which every player plays.
///
/// The caption is taken as written (`use_cot_caption=False`). The language
/// model still fills in tempo, key and the vocal language and writes the
/// audio codes, which is what it is there for.
const RUNNER: &str = r#"
import json, os, shutil, sys, traceback

def say(**fields):
    print("LU-MUSIC " + json.dumps(fields), flush=True)

job = json.load(open(sys.argv[sys.argv.index("--lu-acestep-job") + 1], encoding="utf-8"))
say(phase="load")
try:
    from acestep.handler import AceStepHandler
    from acestep.llm_inference import LLMHandler
    from acestep.inference import GenerationParams, GenerationConfig, generate_music

    dit = AceStepHandler()
    status, ok = dit.initialize_service(project_root=job["project_root"], config_path=job["dit"], device="auto", use_mlx_dit=True)
    if not ok:
        say(phase="error", error=str(status)[-600:])
        sys.exit(3)
    say(phase="load_lm")
    llm = LLMHandler()
    status, lm_ok = llm.initialize(checkpoint_dir=job["checkpoints"], lm_model_path=job["lm"], backend="mlx", device="auto")
    if not lm_ok:
        say(phase="note", note="the song-writing model did not load, the track is made without it: " + str(status)[-300:])

    class Progress:
        def __call__(self, value=None, desc=None, *args, **kwargs):
            try:
                fraction = float(value) if value is not None else None
            except (TypeError, ValueError):
                fraction = None
            say(phase="progress", fraction=fraction, desc=str(desc or "")[:160])
        def tqdm(self, iterable, *args, **kwargs):
            return iterable

    lyrics = job["lyrics"]
    params = GenerationParams(
        caption=job["caption"],
        lyrics=lyrics or "[Instrumental]",
        instrumental=not lyrics,
        duration=float(job["seconds"]),
        inference_steps=int(job["steps"]),
        seed=int(job["seed"]),
        thinking=bool(lm_ok),
        use_cot_caption=False,
    )
    config = GenerationConfig(batch_size=1, use_random_seed=False, seeds=[int(job["seed"])])
    say(phase="generate")
    result = generate_music(dit, llm, params, config, save_dir=None, progress=Progress())
    audio = result.audios[0] if result.success and result.audios else {}
    tensor = audio.get("tensor")
    if tensor is None:
        say(phase="error", error=str(result.error or result.status_message or "no audio came back")[-600:])
        sys.exit(4)
    import numpy, soundfile
    samples = numpy.ascontiguousarray(tensor.detach().float().cpu().numpy().T)
    part = os.path.join(job["work"], "track.wav")
    soundfile.write(part, samples, int(audio.get("sample_rate") or 48000), subtype="PCM_16", format="WAV")
    os.makedirs(os.path.dirname(job["output"]), exist_ok=True)
    shutil.move(part, job["output"])
    say(phase="done", output=job["output"])
except SystemExit:
    raise
except BaseException as e:
    traceback.print_exc()
    say(phase="error", error=(type(e).__name__ + ": " + str(e))[-600:])
    sys.exit(5)
"#;

/// The flag that names the job file. It is also how a run is recognised
/// after a crash of the app.
const JOB_FLAG: &str = "--lu-acestep-job";

/// The piece the audio decoder works in, see `run_command`.
const VAE_CHUNK: &str = "256";

/// The command line and the environment of a run.
fn run_command(root: &Path, job_file: &Path) -> Command {
    let mut cmd = crate::python::python_command(venv_python(&venv_dir(root)));
    // `-u`: through a pipe Python holds its lines back in blocks, and the
    // progress would arrive at the end.
    cmd.arg("-u").arg("-c").arg(RUNNER).arg(JOB_FLAG).arg(job_file.as_os_str());
    cmd.current_dir(work_dir(root))
        .env("ACESTEP_CHECKPOINTS_DIR", checkpoints_dir(root))
        .env("ACESTEP_PROJECT_ROOT", work_dir(root))
        .env("ACESTEP_LM_BACKEND", "mlx")
        // The audio decoder works through the track in pieces of this many
        // latent frames. The engine picks the piece by the Mac's memory and
        // takes 1024 from 37 GB, so a 30 second track (750 frames) was
        // decoded in one go and left 1.4 GB of a 48 GB Mac free. At 256 the
        // same track left 9.6 GB free and decoded faster (4.8 s against 7 s),
        // measured on an M5 Pro on 15.10.2026. 256 is what the engine itself
        // takes on a 16 GB Mac.
        .env("ACESTEP_MLX_VAE_CHUNK", VAE_CHUNK)
        // Should a file be missing, the engine is to say so, and not start a
        // download of ten gigabytes from the hub or from ModelScope in the
        // middle of a track.
        .env("ACESTEP_DOWNLOAD_SOURCE", "huggingface")
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("HF_HOME", hf_home(root))
        .env("TOKENIZERS_PARALLELISM", "false")
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null());
    cmd
}

/// The sentence a run is refused with on a Mac with less memory than the
/// model needs, or `None` when it fits or nothing could be measured. Counted
/// in GiB and rounded, so a Mac sold as 16 GB is 16.
fn memory_refusal(total_bytes: u64) -> Option<String> {
    if total_bytes == 0 {
        return None;
    }
    let have = (total_bytes as f64 / 1_073_741_824.0).round() as u32;
    (have < MIN_RAM_GB).then(|| {
        format!(
            "{MODEL_NAME} needs a Mac with {MIN_RAM_GB} GB of memory, and this one has {have} GB. It was not started, because loading it would freeze this Mac."
        )
    })
}

/// What a poll is told about the run: the last one, or the one under way.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
struct View {
    job: Option<String>,
    /// idle, running, complete, error or cancelled.
    status: &'static str,
    phase: String,
    detail: String,
    percent: u32,
    step: u32,
    steps: u32,
    error: Option<String>,
    output: Option<String>,
    logs: Vec<String>,
}

/// The one track this engine makes at a time: two would each load their
/// models into the one memory everything shares.
struct Runs {
    pid: Mutex<Option<u32>>,
    /// The run from the moment it is accepted, before its process exists.
    /// Inside is the name the caller gave it, if it gave one.
    held: Mutex<Option<Option<String>>>,
    /// Set when the app ended the run itself. Set for a run without a
    /// process yet as well: it then does not start one.
    stopped: AtomicBool,
    view: Mutex<View>,
    /// When the engine last said anything, for the watch on a hung run.
    heard: Mutex<Option<Instant>>,
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
                detail: String::new(),
                percent: 0,
                step: 0,
                steps: 0,
                error: None,
                output: None,
                logs: Vec::new(),
            }),
            heard: Mutex::new(None),
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

    /// Take the one place for a run. `None`: another run has it. The place
    /// is given back when the claim is dropped.
    fn claim(&self, run: Option<String>, job: &str) -> Option<Claim<'_>> {
        let mut held = self.held();
        if held.is_some() {
            return None;
        }
        self.stopped.store(false, SeqCst);
        *held = Some(run);
        *self.view() = View {
            job: Some(job.to_string()),
            status: "running",
            phase: "Freeing memory".to_string(),
            ..View::default()
        };
        self.heard_now();
        Some(Claim(self))
    }

    fn busy(&self) -> bool {
        // One lock at a time: `stop` takes them in the other order.
        let held = self.held().is_some();
        held || self.pid().is_some()
    }

    /// End the run. `false`: there was none.
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

    /// End the run that carries this name, and no other: a Cancel that is
    /// still being repeated for a run that is over must not end the next.
    fn stop_run(&self, run: Option<&str>) -> bool {
        if let Some(name) = run {
            if self.held().as_ref().and_then(|r| r.as_deref()) != Some(name) {
                return false;
            }
        }
        self.stop()
    }

    /// Read one line of the run.
    fn note(&self, line: &str) {
        self.heard_now();
        let mut view = self.view();
        if let Some(said) = line.strip_prefix("LU-MUSIC ").and_then(|j| serde_json::from_str::<Value>(j).ok()) {
            match said["phase"].as_str().unwrap_or("") {
                "load" => {
                    view.phase = "Loading the music model".to_string();
                    view.percent = view.percent.max(2);
                }
                "load_lm" => {
                    view.phase = "Loading the song writer".to_string();
                    view.percent = view.percent.max(8);
                }
                "generate" => {
                    view.phase = "Making the track".to_string();
                    view.percent = view.percent.max(12);
                }
                "progress" => {
                    if let Some(f) = said["fraction"].as_f64().filter(|f| f.is_finite()) {
                        view.percent = view.percent.max((12.0 + f.clamp(0.0, 1.0) * 86.0).round() as u32);
                    }
                    if let Some(desc) = said["desc"].as_str().filter(|d| !d.is_empty()) {
                        view.detail = desc.to_string();
                    }
                }
                "note" => view.detail = said["note"].as_str().unwrap_or("").to_string(),
                "error" => view.error = said["error"].as_str().map(str::to_string),
                "done" => view.percent = 100,
                _ => {}
            }
            return;
        }
        if line.contains("diffusion") {
            if let Some((done, total)) = bar_progress(line) {
                view.step = done.min(total);
                view.steps = total;
            }
        }
        view.logs.push(line.to_string());
        let over = view.logs.len().saturating_sub(40);
        view.logs.drain(..over);
    }

    /// The run is over: say how.
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

/// The place of a run, held from the moment it is accepted.
struct Claim<'a>(&'a Runs);

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        *self.0.held() = None;
    }
}

/// `done/total` of a progress bar as tqdm writes it:
/// `MLX DiT diffusion:  50%|#####     | 4/8 [00:31<00:31,  7.8s/it]`.
fn bar_progress(line: &str) -> Option<(u32, u32)> {
    let counts = line.rsplit_once('|')?.1.trim_start();
    let (done, rest) = counts.split_once('/')?;
    let total = rest.split(|c: char| !c.is_ascii_digit()).next()?;
    Some((done.trim().parse().ok()?, total.parse().ok().filter(|t| *t > 0)?))
}

static RUNS: Runs = Runs::new();

/// Whether a track is being made right now.
pub(crate) fn busy() -> bool {
    RUNS.busy()
}

/// End the track that is being made. The quit path calls this: the child
/// holds many gigabytes and would outlive the app.
pub(crate) fn stop() -> bool {
    RUNS.stop()
}

const STOPPED: &str = "The track was not finished because the app stopped the engine.";

/// Start the process of a run, unless a Cancel came first. The pid is noted
/// in `pid_file` while it lives.
fn start(runs: &Runs, mut cmd: Command, pid_file: Option<&Path>) -> Result<std::process::Child, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut slot = runs.pid();
    if slot.is_some() {
        return Err("A track is already being made on this Mac. Wait for it to finish.".to_string());
    }
    if runs.stopped.swap(false, SeqCst) {
        return Err(STOPPED.to_string());
    }
    let child = cmd.spawn().map_err(|e| format!("Could not start the music engine: {}", os_error::english(&e)))?;
    if let Some(note) = pid_file {
        if let Some(dir) = note.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(note, child.id().to_string());
    }
    *slot = Some(child.id());
    runs.heard_now();
    Ok(child)
}

/// Wait for the process of a run, read what it says, end it when it runs too
/// long or hangs, and say how it ended.
fn finish(runs: &Runs, mut child: std::process::Child, out: &Path, pid_file: Option<&Path>, limit: Duration, stall: Duration) -> Result<(), String> {
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let started = Instant::now();
    let status = std::thread::scope(|scope| {
        scope.spawn(|| read_lines(stdout, |line| runs.note(line)));
        scope.spawn(|| read_lines(stderr, |line| runs.note(line)));
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
        if let Some(note) = pid_file {
            let _ = std::fs::remove_file(note);
        }
        status
    });
    let stopped = runs.stopped.swap(false, SeqCst);
    let said = runs.view().error.clone();
    let status = status.map_err(|e| format!("wait failed: {}", os_error::english(&e)))?;
    let verdict = outcome(status.as_ref(), out.is_file(), said.as_deref(), stopped);
    if verdict.is_err() {
        let _ = std::fs::remove_file(out);
    }
    verdict
}

const HUNG: &str = "The music engine said nothing for ten minutes and was ended. Start the track again.";

/// How a run ended, as `Ok` or the sentence for the user. `status` is
/// `None` when the app ended the process because it ran too long or hung.
fn outcome(status: Option<&std::process::ExitStatus>, wrote_track: bool, said: Option<&str>, stopped: bool) -> Result<(), String> {
    if stopped {
        return Err(STOPPED.to_string());
    }
    let Some(status) = status else {
        return Err(match said {
            Some(HUNG) => HUNG.to_string(),
            _ => "The music engine did not finish within an hour and was stopped.".to_string(),
        });
    };
    if status.success() && wrote_track {
        return Ok(());
    }
    if let Some(why) = said.filter(|w| !w.is_empty()) {
        return Err(format!("The music engine stopped: {why}"));
    }
    if status.success() {
        return Err("The music engine finished without writing a track.".to_string());
    }
    if let Some(code) = status.code() {
        return Err(format!("The music engine stopped with exit code {code}. Its last lines are in the log."));
    }
    // No exit code is a signal, and nothing in this app sent one. On a Mac
    // that is the system taking the process away when memory runs out.
    Err("The music engine was ended by macOS. This usually means the model did not fit into memory. Close other apps and try again, or make a shorter track.".to_string())
}

/// Hand every line of a stream to `seen`. tqdm ends each drawing of its bar
/// with a carriage return, so a line ends at either.
pub(crate) fn read_lines<R: std::io::Read>(stream: Option<R>, seen: impl Fn(&str)) {
    let Some(mut stream) = stream else {
        return;
    };
    let mut pending: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let keep = |raw: &[u8]| {
        let line = String::from_utf8_lossy(raw).trim().to_string();
        if !line.is_empty() {
            seen(&line);
        }
    };
    while let Ok(read) = stream.read(&mut chunk) {
        if read == 0 {
            break;
        }
        for byte in &chunk[..read] {
            if *byte == b'\n' || *byte == b'\r' {
                keep(&pending);
                pending.clear();
            } else if pending.len() < 8192 {
                pending.push(*byte);
            }
        }
    }
    keep(&pending);
}

pub async fn music_generate(state: &AppState, args: &Value) -> CmdResult {
    ensure_apple_silicon()?;
    let req: GenerateArgs = serde_json::from_value(args.clone()).map_err(|e| bad_request(e.to_string()))?;
    let caption = req.prompt.trim().to_string();
    if caption.is_empty() {
        return Err(bad_request("Describe the track first. Genre, mood, tempo."));
    }
    let root = root();
    if !installed_at(&root) {
        return Err(bad_request(format!("{MODEL_NAME} is not installed. Install it in the Model Manager first.")));
    }
    // Before anything is loaded: a model larger than the memory does not
    // fail, it swaps until the Mac stops answering.
    if let Some(refusal) = memory_refusal(crate::commands::system::total_memory_bytes()) {
        return Err(bad_request(refusal));
    }
    // One model in the memory at a time. A picture or a video that is being
    // made holds its model until it is through, and is not ended for a song.
    if let Some(why) = crate::commands::mlx::train::refusal() {
        return Err(bad_request(why));
    }
    if crate::commands::mlx::image_engine_busy() {
        return Err(bad_request("An image is being generated on this Mac. Wait for it to finish, then make the track."));
    }
    if let Some(why) = crate::commands::mesh3d::refusal() {
        return Err(bad_request(why));
    }
    if state.video_process().lock().map(|p| p.is_some()).unwrap_or(true) {
        return Err(bad_request("A video is being generated on this Mac. Wait for it to finish, then make the track."));
    }
    let job = uuid::Uuid::new_v4().simple().to_string();
    let claim = RUNS
        .claim(req.run.clone(), &job)
        .ok_or_else(|| bad_request("A track is already being made on this Mac. Wait for it to finish."))?;
    // What the image engine holds goes first, as before a video. A sidecar
    // that does not answer is not a reason to refuse the track.
    let _ = crate::commands::mlx::mlx_unload(state, &Value::Null).await;

    let out_dir = outputs_root();
    let job_dir = work_dir(&root).join("jobs").join(&job);
    for dir in [&out_dir, &job_dir] {
        if let Err(e) = std::fs::create_dir_all(dir) {
            let why = format!("mkdir {}: {}", dir.display(), os_error::english(&e));
            RUNS.conclude(&Err(why.clone()));
            return Err(internal(why));
        }
    }
    let output = out_dir.join(format!("music-{job}.wav"));
    let seconds = seconds_for(req.seconds);
    let seed = seed_for(req.seed);
    let lyrics = lyrics_for(req.lyrics.as_deref());
    let job_file = job_dir.join("job.json");
    let written = std::fs::write(&job_file, job_json(&root, &caption, &lyrics, seconds, seed, &job_dir, &output).to_string());
    if let Err(e) = written {
        let why = format!("write {}: {}", job_file.display(), os_error::english(&e));
        RUNS.conclude(&Err(why.clone()));
        return Err(internal(why));
    }
    tracing::info!("[music] ACE-Step {VERSION}: {seconds} s, seed {seed}, {} characters of lyrics", lyrics.chars().count());
    let pid_file = run_pid_file(&root);
    let child = match start(&RUNS, run_command(&root, &job_file), Some(&pid_file)) {
        Ok(child) => child,
        Err(why) => {
            RUNS.conclude(&Err(why.clone()));
            let _ = std::fs::remove_dir_all(&job_dir);
            return Err(internal(why));
        }
    };
    let pid = child.id();
    let out = output.clone();
    std::thread::spawn(move || {
        let verdict = finish(&RUNS, child, &out, Some(&pid_file), GENERATE_TIMEOUT, STALL_AFTER);
        if let Err(why) = &verdict {
            tracing::error!("[music] {why}");
        }
        RUNS.conclude(&verdict);
        let _ = std::fs::remove_dir_all(&job_dir);
        drop(claim);
    });
    Ok(json!({
        "ok": true,
        "jobId": job,
        "pid": pid,
        "output": output,
        "seconds": seconds,
        "seed": seed,
        "steps": STEPS,
    }))
}

pub fn music_progress(_state: &AppState, _args: &Value) -> CmdResult {
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

pub fn music_cancel(_state: &AppState, args: &Value) -> CmdResult {
    let a: CancelArgs = serde_json::from_value(args.clone()).unwrap_or_default();
    Ok(json!({ "ok": true, "stopped": RUNS.stop_run(a.run.as_deref()) }))
}

// ── A run that outlived the app ───────────────────────────────────────
//
// After a crash or a Force Quit nothing ends a running track: macOS has no
// parent death signal, and the child goes on with ten gigabytes in memory.
// The next start ends it, by the same rule as the image engine's runs: the
// pid that was noted, still a run of this app's own work folder, and with
// launchd as its parent.

#[cfg(any(target_os = "macos", test))]
struct Leftover {
    parent: Option<u32>,
    cmd: Vec<String>,
}

#[cfg(any(target_os = "macos", test))]
fn is_orphaned_run(row: &Leftover, work: &Path) -> bool {
    row.parent == Some(1) && row.cmd.windows(2).any(|w| w[0] == JOB_FLAG && Path::new(&w[1]).starts_with(work))
}

/// End the track the last session left running, if there is one, and return
/// its pid. Called once at app start, off the main thread.
#[cfg(target_os = "macos")]
pub(crate) fn reap_orphaned_run() -> Option<u32> {
    let root = root();
    let pid_file = run_pid_file(&root);
    let pid: u32 = std::fs::read_to_string(&pid_file).ok()?.trim().parse().ok()?;
    let table = crate::process_util::process_table_with_cmdlines();
    let Some(process) = table.process(sysinfo::Pid::from_u32(pid)) else {
        let _ = std::fs::remove_file(&pid_file);
        return None;
    };
    let row = Leftover { parent: process.parent().map(|p| p.as_u32()), cmd: crate::process_util::cmdline_of(process) };
    if !is_orphaned_run(&row, &work_dir(&root)) {
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

    fn production_source() -> &'static str {
        let src = include_str!("music.rs");
        &src[..src.find("#[cfg(test)]\nmod tests").unwrap()]
    }

    fn put(path: PathBuf, bytes: u64) {
        crate::test_support::sized_file(&path, bytes);
    }

    fn args_of(cmd: &Command) -> Vec<String> {
        cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect()
    }

    fn env_of(cmd: &Command, key: &str) -> Option<String> {
        cmd.get_envs().find(|(k, _)| *k == key).and_then(|(_, v)| v).map(|v| v.to_string_lossy().to_string())
    }

    /// A path under `/data/acestep` the way this system joins it, so the
    /// tests read the same on Windows, where `join` puts a backslash.
    fn under_root(parts: &[&str]) -> String {
        parts.iter().fold(PathBuf::from("/data/acestep"), |p, part| p.join(part)).to_string_lossy().to_string()
    }

    #[test]
    fn the_engine_is_one_pinned_commit_and_every_package_has_its_version() {
        assert_eq!(COMMIT.len(), 40, "a full commit id, not a branch or a short hash");
        assert!(COMMIT.chars().all(|c| c.is_ascii_hexdigit()));
        let specs = pip_specs();
        assert_eq!(specs.len(), PINNED.len() + 1);
        assert_eq!(
            specs.last().unwrap(),
            "ace-step @ https://github.com/ACE-Step/ACE-Step-1.5/archive/ca1e85fe9430179831e6bc6be790c332190a3866.zip"
        );
        assert!(specs.iter().all(|s| !s.contains("git+")), "pip needs git for that, and a fresh Mac has none");
        for spec in &PINNED {
            let (name, version) = spec.split_once("==").unwrap_or_else(|| panic!("{spec} is not pinned"));
            assert!(!name.is_empty() && !version.is_empty() && !version.contains(['<', '>', '*', ' ']), "{spec}");
        }
        // One entry per package.
        let mut names: Vec<&str> = PINNED.iter().map(|s| s.split("==").next().unwrap()).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), PINNED.len());
        // What the engine stands on, at the versions of its lock file.
        for pin in ["torch==2.10.0", "torchaudio==2.10.0", "mlx==0.30.6", "mlx-lm==0.29.1", "transformers==4.57.6", "diffusers==0.37.1", "soundfile==0.13.1", "huggingface-hub==0.36.0"] {
            assert!(PINNED.contains(&pin), "{pin}");
        }
        // Never by its name on PyPI alone, which is the first ACE-Step.
        assert!(!specs.iter().any(|s| s == "ace-step" || s.starts_with("ace-step==")));
        // The packages that are not for this Mac stay out.
        for other in ["nano-vllm", "triton", "flash-attn", "xxhash"] {
            assert!(!PINNED.iter().any(|p| p.starts_with(&format!("{other}=="))), "{other}");
        }
        let src = production_source();
        assert_eq!(src.matches("github.com/ACE-Step/ACE-Step-1.5/archive").count(), 1);
        assert!(!src.contains("@main") && !src.contains("@master"));
    }

    #[test]
    fn the_build_backend_is_pinned_too_and_the_engine_is_built_with_it() {
        let build = pip_build_args();
        assert_eq!(&build[..6], ["-m", "pip", "install", "--upgrade", "--only-binary", ":all:"]);
        assert_eq!(&build[6..], BUILD_PINNED.map(String::from));
        for spec in &BUILD_PINNED {
            assert!(spec.split_once("==").is_some_and(|(n, v)| !n.is_empty() && !v.is_empty()), "{spec}");
        }
        // hatchling's own needs that the engine pins as well stand at the same
        // version in both lists.
        for shared in ["packaging==26.0", "tomlkit==0.13.3"] {
            assert!(BUILD_PINNED.contains(&shared) && PINNED.contains(&shared), "{shared}");
        }
        let engine = pip_engine_args();
        assert_eq!(&engine[..5], ["-m", "pip", "install", "--upgrade", "--no-build-isolation"]);
        assert_eq!(&engine[5..], pip_specs().as_slice());
        // A venv set up before the build pins came in is not this engine.
        assert!(BUILD_PINNED.iter().all(|p| stamp().lines().any(|l| l == *p)));
        assert!(stamp().ends_with(pip_specs().last().unwrap()));
        assert_eq!(MODULE, "acestep.inference, soundfile");
    }

    #[test]
    fn the_weights_are_one_revision_of_the_official_repository() {
        assert_eq!(REVISION.len(), 40);
        assert!(REVISION.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(REPO, "ACE-Step/Ace-Step1.5");
        assert_eq!(PARTS, ["acestep-v15-turbo/", "vae/", "Qwen3-Embedding-0.6B/", "acestep-5Hz-lm-1.7B/"]);
        assert!(PARTS.iter().any(|p| p.trim_end_matches('/') == DIT) && PARTS.iter().any(|p| p.trim_end_matches('/') == LM));
        // 10.09 GB, as the hub lists the four folders.
        assert_eq!(WEIGHTS_BYTES, 4_791_777_953 + 337_431_813 + 1_207_471_006 + 3_755_412_617);
        assert_eq!(model_json(false)["sizeGB"], 10.1);
    }

    #[test]
    fn everything_lives_in_one_folder_of_the_app() {
        let root = root();
        assert!(root.starts_with(crate::os_paths::data_dir()));
        for dir in [venv_dir(&root), checkpoints_dir(&root), work_dir(&root), hf_home(&root), run_pid_file(&root)] {
            assert!(dir.starts_with(&root), "{}", dir.display());
        }
        assert_ne!(venv_dir(&root), crate::os_paths::data_dir().join("mlx").join("venv"), "never the image engine's venv");
        assert!(outputs_root().starts_with(crate::os_paths::config_root()));
        assert_eq!(outputs_root().parent(), crate::commands::video::outputs_root().parent(), "beside the videos");
    }

    #[test]
    fn a_venv_without_the_stamp_of_this_pin_is_not_the_engine() {
        let tmp = tempfile::tempdir().unwrap();
        let venv = tmp.path().join("venv");
        assert!(!engine_ready_at(&venv));
        put(venv_python(&venv), 1);
        assert!(!engine_ready_at(&venv), "an install that was stopped has no stamp");
        std::fs::write(stamp_file(&venv), "ace-step @ https://example.invalid/0000.zip").unwrap();
        assert!(!engine_ready_at(&venv), "the stamp of another pin");
        std::fs::write(stamp_file(&venv), stamp()).unwrap();
        assert!(engine_ready_at(&venv));
    }

    fn listing() -> Vec<crate::commands::mlx_snapshot::RepoFile> {
        let file = |path: &str, size: u64| crate::commands::mlx_snapshot::RepoFile { path: path.to_string(), size, sha256: None };
        vec![
            file(".gitattributes", 1740),
            file("README.md", 5496),
            file("config.json", 1968),
            file("acestep-v15-turbo/config.json", 19),
            file("acestep-v15-turbo/model.safetensors", 48),
            file("acestep-v15-turbo/modeling_acestep_v15_turbo.py", 9),
            file("vae/config.json", 4),
            file("vae/diffusion_pytorch_model.safetensors", 33),
            file("Qwen3-Embedding-0.6B/model.safetensors", 12),
            file("Qwen3-Embedding-0.6B/tokenizer.json", 11),
            file("acestep-5Hz-lm-1.7B/model.safetensors", 37),
        ]
    }

    #[test]
    fn the_download_is_the_four_folders_and_each_brings_weights() {
        let manifest = plan(&listing()).unwrap();
        assert_eq!(manifest.revision, REVISION);
        let paths: Vec<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths.len(), 8);
        assert!(!paths.iter().any(|p| ["README.md", ".gitattributes", "config.json"].contains(p)), "{paths:?}");
        // An upload under way: a folder without its weights is not the model.
        let partial: Vec<_> = listing().into_iter().filter(|f| f.path != "vae/diffusion_pytorch_model.safetensors").collect();
        assert!(plan(&partial).unwrap_err().contains("vae/"));
    }

    #[test]
    fn whole_weights_stay_whole_after_the_engine_rewrites_its_python_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let manifest = plan(&listing()).unwrap();
        assert!(!weights_complete(dir), "an empty folder");
        for f in &manifest.files {
            put(dir.join(&f.path), f.size);
        }
        assert!(!weights_complete(dir), "no manifest, no model: a stopped download looks the same");
        std::fs::write(dir.join(MANIFEST), serde_json::to_string(&manifest).unwrap()).unwrap();
        assert!(weights_complete(dir));
        // The engine copies its own model code over the downloaded file
        // before the first run.
        std::fs::write(dir.join("acestep-v15-turbo/modeling_acestep_v15_turbo.py"), "a longer file than the one on the hub").unwrap();
        assert!(weights_complete(dir), "a model that was whole reads broken after its first track");
        // A weight file of the wrong size is not the model.
        put(dir.join("vae/diffusion_pytorch_model.safetensors"), 32);
        assert!(!weights_complete(dir));
        assert_eq!(missing_files(dir, &manifest), ["vae/diffusion_pytorch_model.safetensors"]);
        put(dir.join("vae/diffusion_pytorch_model.safetensors"), 33);
        // The manifest of another revision is not this model.
        let mut old = plan(&listing()).unwrap();
        old.revision = "0".repeat(40);
        std::fs::write(dir.join(MANIFEST), serde_json::to_string(&old).unwrap()).unwrap();
        assert!(!weights_complete(dir));
    }

    #[test]
    fn installed_is_the_engine_and_the_weights_and_remove_takes_the_weights() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert!(!installed_at(root));
        assert_eq!(bytes_to_fetch(root), WEIGHTS_BYTES + ENGINE_INSTALL_BYTES);
        let manifest = plan(&listing()).unwrap();
        let dir = checkpoints_dir(root);
        for f in &manifest.files {
            put(dir.join(&f.path), f.size);
        }
        std::fs::write(dir.join(MANIFEST), serde_json::to_string(&manifest).unwrap()).unwrap();
        assert!(!installed_at(root), "weights without the engine");
        assert_eq!(bytes_to_fetch(root), ENGINE_INSTALL_BYTES);
        put(venv_python(&venv_dir(root)), 1);
        std::fs::write(stamp_file(&venv_dir(root)), stamp()).unwrap();
        assert!(installed_at(root));
        assert_eq!(bytes_to_fetch(root), 0);

        std::fs::create_dir_all(hf_home(root).join("xet")).unwrap();
        delete_at(root).unwrap();
        assert!(!dir.exists() && !hf_home(root).exists());
        assert!(engine_ready_at(&venv_dir(root)), "the engine stays");
        assert!(!installed_at(root));
        assert!(delete_at(root).unwrap_err().contains("not installed"));
    }

    #[test]
    fn the_length_the_lyrics_and_the_seed_are_what_the_engine_takes() {
        assert_eq!(seconds_for(None), 120);
        assert_eq!(seconds_for(Some(60.0)), 60);
        assert_eq!(seconds_for(Some(5.0)), MIN_SECONDS, "the engine makes nothing under ten seconds");
        assert_eq!(seconds_for(Some(600.0)), MAX_SECONDS);
        assert_eq!(seconds_for(Some(f64::NAN)), 120);
        assert_eq!(seconds_for(Some(-3.0)), MIN_SECONDS);

        assert_eq!(lyrics_for(None), "");
        assert_eq!(lyrics_for(Some("  \n ")), "", "an instrumental");
        assert_eq!(lyrics_for(Some("la la la\nhere we go")), "[Verse]\nla la la\nhere we go");
        let tagged = "[Verse]\nla la\n[Chorus]\noh";
        assert_eq!(lyrics_for(Some(tagged)), tagged, "a song with its own sections is left as written");
        assert_eq!(lyrics_for(Some(&"a".repeat(9000))).chars().count(), MAX_LYRICS_CHARS);

        assert_eq!(seed_for(Some(42)), 42);
        assert_eq!(seed_for(Some(u32::MAX as i64 + 5)), 4);
        // -1 is "throw one": the run gets a number of its own, and the job
        // carries a number the engine takes (it is a u32 by its type).
        let thrown: u32 = seed_for(Some(-1));
        assert!(job_json(Path::new("/r"), "c", "", 60, thrown, Path::new("/j"), Path::new("/o.wav"))["seed"].is_u64());
    }

    #[test]
    fn the_job_carries_what_the_runner_reads() {
        let root = Path::new("/data/acestep");
        let job = job_json(root, &"x".repeat(900), "[Verse]\nhey", 90, 7, Path::new("/data/acestep/work/jobs/j1"), Path::new("/c/music/music-j1.wav"));
        assert_eq!(job["caption"].as_str().unwrap().chars().count(), MAX_CAPTION_CHARS);
        assert_eq!(job["lyrics"], "[Verse]\nhey");
        assert_eq!(job["seconds"], 90);
        assert_eq!(job["seed"], 7);
        assert_eq!(job["steps"], 8);
        assert_eq!(job["dit"], "acestep-v15-turbo");
        assert_eq!(job["lm"], "acestep-5Hz-lm-1.7B");
        assert_eq!(job["checkpoints"], under_root(&["checkpoints"]));
        assert_eq!(job["project_root"], under_root(&["work"]));
        assert_eq!(job["output"], "/c/music/music-j1.wav");
        assert_eq!(job["work"], "/data/acestep/work/jobs/j1", "the track is written in the job folder first");
        // Every key the runner reads is in the job.
        for key in ["caption", "lyrics", "seconds", "seed", "steps", "dit", "lm", "checkpoints", "project_root", "work", "output"] {
            assert!(RUNNER.contains(&format!("job[\"{key}\"]")), "the runner does not read {key}");
            assert!(!job[key].is_null(), "{key}");
        }
    }

    #[test]
    fn the_runner_uses_the_python_api_of_the_pinned_commit() {
        for call in [
            "from acestep.handler import AceStepHandler",
            "from acestep.llm_inference import LLMHandler",
            "from acestep.inference import GenerationParams, GenerationConfig, generate_music",
            "dit.initialize_service(project_root=",
            "use_mlx_dit=True",
            "llm.initialize(checkpoint_dir=",
            "backend=\"mlx\"",
            "save_dir=None",
            "soundfile.write(part, samples,",
            "subtype=\"PCM_16\"",
            "batch_size=1",
            "use_random_seed=False",
            "generate_music(dit, llm, params, config, save_dir=",
            "use_cot_caption=False",
        ] {
            assert!(RUNNER.contains(call), "{call}");
        }
        assert!(!RUNNER.contains("mp3"), "MP3 needs an ffmpeg program a Mac does not have");
        // The engine's own writer goes through TorchCodec and FFmpeg.
        assert!(!RUNNER.contains("audio_format") && !RUNNER.contains("torchaudio"));
    }

    #[test]
    fn the_command_line_runs_offline_in_the_engine_folder() {
        let root = Path::new("/data/acestep");
        let cmd = run_command(root, Path::new("/data/acestep/work/jobs/j1/job.json"));
        assert_eq!(cmd.get_program(), under_root(&["venv", "bin", "python"]).as_str());
        let args = args_of(&cmd);
        assert_eq!(args[0], "-u");
        assert_eq!(args[1], "-c");
        assert_eq!(args[2], RUNNER);
        assert_eq!(&args[3..], [JOB_FLAG, "/data/acestep/work/jobs/j1/job.json"]);
        assert!(!args.contains(&"-I".to_string()), "isolated mode drops the environment the engine reads");
        assert_eq!(cmd.get_current_dir(), Some(Path::new(&under_root(&["work"]))));
        assert_eq!(env_of(&cmd, "ACESTEP_CHECKPOINTS_DIR"), Some(under_root(&["checkpoints"])));
        assert_eq!(env_of(&cmd, "ACESTEP_PROJECT_ROOT"), Some(under_root(&["work"])));
        assert_eq!(env_of(&cmd, "ACESTEP_LM_BACKEND").as_deref(), Some("mlx"));
        assert_eq!(env_of(&cmd, "ACESTEP_MLX_VAE_CHUNK").as_deref(), Some("256"), "the decoder never takes a whole track at once");
        assert_eq!(env_of(&cmd, "HF_HUB_OFFLINE").as_deref(), Some("1"));
        assert_eq!(env_of(&cmd, "ACESTEP_DOWNLOAD_SOURCE").as_deref(), Some("huggingface"), "never a fall back to ModelScope");
    }

    #[test]
    fn a_mac_with_too_little_memory_is_told_before_anything_loads() {
        const GIB: u64 = 1_073_741_824;
        assert!(memory_refusal(8 * GIB).unwrap().contains("needs a Mac with 48 GB"));
        // A 30 second track took about 28 GB on a 48 GB Mac (MIN_RAM_GB).
        assert!(memory_refusal(32 * GIB).unwrap().contains("this one has 32 GB"));
        assert_eq!(memory_refusal(48 * GIB), None);
        assert_eq!(memory_refusal(51_539_607_552), None, "a Mac sold as 48 GB");
        assert_eq!(memory_refusal(0), None, "nothing measured");
    }

    #[test]
    fn the_lines_of_a_run_move_its_progress() {
        let runs = Runs::new();
        let _claim = runs.claim(None, "j1").unwrap();
        assert_eq!(runs.view().status, "running");
        runs.note("LU-MUSIC {\"phase\": \"load\"}");
        assert_eq!(runs.view().phase, "Loading the music model");
        runs.note("LU-MUSIC {\"phase\": \"generate\"}");
        runs.note("LU-MUSIC {\"phase\": \"progress\", \"fraction\": 0.5, \"desc\": \"Phase 2: Generating audio codes\"}");
        let view = runs.view().clone();
        assert_eq!(view.percent, 55);
        assert_eq!(view.detail, "Phase 2: Generating audio codes");
        runs.note("MLX DiT diffusion:  50%|#####     | 4/8 [00:31<00:31,  7.8s/it]");
        assert_eq!({ let v = runs.view(); (v.step, v.steps) }, (4, 8));
        // A bar of another stage is not the step count.
        runs.note("LLM Constrained Decoding:  10%|#  | 100/1000 [00:01<00:09]");
        assert_eq!({ let v = runs.view(); (v.step, v.steps) }, (4, 8));
        // A fraction that goes back does not move the bar backwards.
        runs.note("LU-MUSIC {\"phase\": \"progress\", \"fraction\": 0.1}");
        assert_eq!(runs.view().percent, 55);
        runs.note("LU-MUSIC {\"phase\": \"error\", \"error\": \"no audio came back\"}");
        assert_eq!(runs.view().error.as_deref(), Some("no audio came back"));
        for i in 0..60 {
            runs.note(&format!("line {i}"));
        }
        assert_eq!(runs.view().logs.len(), 40);
        assert_eq!(runs.view().logs.last().unwrap(), "line 59");
        runs.conclude(&Ok(()));
        assert_eq!({ let v = runs.view(); (v.status, v.percent) }, ("complete", 100));
    }

    #[test]
    fn one_run_at_a_time_and_a_cancel_names_its_run() {
        let runs = Runs::new();
        let claim = runs.claim(Some("a".into()), "j1").unwrap();
        assert!(runs.busy());
        assert!(runs.claim(None, "j2").is_none(), "a second run beside the first");
        assert!(!runs.stop_run(Some("b")), "a Cancel for another run");
        assert!(runs.stop_run(Some("a")));
        // Stopped before its process existed: it starts none.
        let err = start(&runs, Command::new("true"), None).unwrap_err();
        assert_eq!(err, STOPPED);
        drop(claim);
        assert!(!runs.busy());
        assert!(!runs.stop(), "nothing to stop");
    }

    #[cfg(unix)]
    fn shell(script: &str) -> Command {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(script);
        cmd
    }

    #[cfg(unix)]
    #[test]
    fn a_run_that_writes_its_track_is_complete() {
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("t.wav");
        let pid_file = tmp.path().join("run.pid");
        let runs = Runs::new();
        let _claim = runs.claim(None, "j1").unwrap();
        let script = format!(
            "echo 'LU-MUSIC {{\"phase\": \"load\"}}'; printf 'MLX DiT diffusion: 100%%|##| 8/8 [00:01<00:00]\\r'; echo; echo RIFF > '{}'; echo 'LU-MUSIC {{\"phase\": \"done\"}}'",
            out.display()
        );
        let child = start(&runs, shell(&script), Some(&pid_file)).unwrap();
        assert!(pid_file.is_file(), "the pid is noted while the run lives");
        let verdict = finish(&runs, child, &out, Some(&pid_file), Duration::from_secs(30), Duration::from_secs(30));
        assert_eq!(verdict, Ok(()));
        assert!(!pid_file.exists());
        assert_eq!({ let v = runs.view(); (v.step, v.steps) }, (8, 8));
        assert_eq!(runs.view().percent, 100);
        assert!(runs.pid().is_none(), "the pid is cleared when the process is gone");
    }

    #[cfg(unix)]
    #[test]
    fn a_run_that_fails_says_why_and_leaves_no_track() {
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("t.wav");
        let runs = Runs::new();
        let _claim = runs.claim(None, "j1").unwrap();
        let script = format!("echo half > '{}'; echo 'LU-MUSIC {{\"phase\": \"error\", \"error\": \"Error initializing model\"}}'; exit 3", out.display());
        let child = start(&runs, shell(&script), None).unwrap();
        let verdict = finish(&runs, child, &out, None, Duration::from_secs(30), Duration::from_secs(30));
        assert_eq!(verdict.unwrap_err(), "The music engine stopped: Error initializing model");
        assert!(!out.exists(), "half a track is no track");
    }

    #[cfg(unix)]
    #[test]
    fn cancel_ends_the_process_and_a_hung_run_is_ended_by_the_watch() {
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("t.wav");
        let runs = Runs::new();
        let claim = runs.claim(None, "j1").unwrap();
        let child = start(&runs, shell("sleep 30"), None).unwrap();
        let started = Instant::now();
        std::thread::scope(|s| {
            s.spawn(|| {
                std::thread::sleep(Duration::from_millis(300));
                assert!(runs.stop());
            });
            let verdict = finish(&runs, child, &out, None, Duration::from_secs(60), Duration::from_secs(60));
            assert_eq!(verdict.unwrap_err(), STOPPED);
        });
        assert!(started.elapsed() < Duration::from_secs(10), "the process outlived the Cancel");
        runs.conclude(&Err(STOPPED.to_string()));
        assert_eq!(runs.view().status, "cancelled");
        drop(claim);

        // Silent for longer than the watch allows.
        let _claim = runs.claim(None, "j2").unwrap();
        let child = start(&runs, shell("sleep 30"), None).unwrap();
        let started = Instant::now();
        let verdict = finish(&runs, child, &out, None, Duration::from_secs(60), Duration::from_millis(400));
        assert_eq!(verdict.unwrap_err(), HUNG);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn how_a_run_ended_in_words() {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            let ok = std::process::ExitStatus::from_raw(0);
            let code3 = std::process::ExitStatus::from_raw(3 << 8);
            let killed = std::process::ExitStatus::from_raw(9);
            assert_eq!(outcome(Some(&ok), true, None, false), Ok(()));
            assert_eq!(outcome(Some(&ok), false, None, false).unwrap_err(), "The music engine finished without writing a track.");
            assert_eq!(outcome(Some(&ok), true, None, true).unwrap_err(), STOPPED);
            assert!(outcome(Some(&code3), false, None, false).unwrap_err().contains("exit code 3"));
            assert!(outcome(Some(&killed), false, None, false).unwrap_err().contains("ended by macOS"));
        }
        assert_eq!(outcome(None, false, Some(HUNG), false).unwrap_err(), HUNG);
        assert!(outcome(None, false, None, false).unwrap_err().contains("within an hour"));
    }

    #[test]
    fn a_run_of_ours_whose_app_is_gone_is_told_from_any_other_process() {
        let work = Path::new("/data/acestep/work");
        let row = |parent: Option<u32>, cmd: &[&str]| Leftover { parent, cmd: cmd.iter().map(|s| s.to_string()).collect() };
        let ours = ["/data/acestep/venv/bin/python", "-u", "-c", "...", JOB_FLAG, "/data/acestep/work/jobs/j1/job.json"];
        assert!(is_orphaned_run(&row(Some(1), &ours), work));
        assert!(!is_orphaned_run(&row(Some(4242), &ours), work), "the run of an app that is running");
        assert!(!is_orphaned_run(&row(Some(1), &["python", JOB_FLAG, "/elsewhere/job.json"]), work));
        assert!(!is_orphaned_run(&row(Some(1), &["python", "-m", "http.server"]), work));
    }

    #[test]
    fn a_run_waits_for_the_other_engines_and_frees_the_image_engine_first() {
        let src = production_source();
        let generate = &src[src.find("pub async fn music_generate(").unwrap()..src.find("pub fn music_progress(").unwrap()];
        let installed = generate.find("if !installed_at(&root)").unwrap();
        let memory = generate.find("memory_refusal(").unwrap();
        let image = generate.find("crate::commands::mlx::image_engine_busy()").expect("a track beside an image");
        let video = generate.find("state.video_process()").expect("a track beside a video");
        let claimed = generate.find("RUNS\n        .claim(").unwrap();
        let unload = generate.find("crate::commands::mlx::mlx_unload(").expect("the image engine keeps its model beside the track");
        let started = generate.find("start(&RUNS, run_command(").unwrap();
        assert!(installed < memory && memory < image && image < video && video < claimed && claimed < unload && unload < started);
    }
}
