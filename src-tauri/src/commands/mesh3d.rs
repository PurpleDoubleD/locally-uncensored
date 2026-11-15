//! The local 3D engine of the Mac: TripoSR, one picture in, one GLB out.
//!
//! A Mac has no ComfyUI, so this runs the way the music engine runs
//! (`music.rs`): a venv of its own with every package pinned, the source of
//! the engine at one commit, the weights of the official repository at one
//! revision, and one Python process per model that the app starts, reads and
//! can end. A process that ends gives all its memory back.
//!
//! The process runs LU's own runner (`resources/mesh3d/run_triposr.py`) and
//! not TripoSR's `run.py`. Three things of `run.py` cannot run on a
//! customer's Mac, read at the pinned commit (13.11.2026):
//!   - `torchmcubes` is a `git+https` requirement that is compiled on install
//!     (`requirements.txt`) and imported by `tsr/models/isosurface.py`. The
//!     runner puts a stand-in on scikit-image's marching cubes in its place.
//!   - `rembg` is imported by `tsr/utils.py` and downloads a model of its own.
//!     The object is cut out before the run with Vision (`mlx_cutout.rs`),
//!     and the runner puts a stand-in in place of rembg that refuses to work.
//!   - the texture bake needs `moderngl` and `xatlas`. The runner writes
//!     colours per vertex instead.
//!
//! The DINO encoder reads `config.json` of `facebook/dino-vitb16` from the hub
//! when it is built (`tsr/models/tokenizers/image.py`, `hf_hub_download`
//! without a revision). The install fetches that one file at a fixed revision
//! and the runner hands it over from disk; a run is offline.
//!
//! Content filter: none. `grep -riE "safety|nsfw|censor|filter|explicit|porn|
//! nude|watermark|blocklist|moderat"` over every `.py` file of the source at
//! `SOURCE_COMMIT` finds nothing, and the only network calls are the two
//! `hf_hub_download` above, neither of which a run makes.
//!
//! Every download goes through `voice_loop::fetch::fetch_verified`: resumable,
//! with the size and the sha256 compiled in here, and a file is kept under its
//! real name only when both match.
//!
//! Where it was read:
//!   - the code, MIT: <https://github.com/VAST-AI-Research/TripoSR> at
//!     `SOURCE_COMMIT` (head of `main`, 04.06.2026, a README change on top of
//!     the last code change of 14.05.2024)
//!   - the weights, MIT, not gated: <https://huggingface.co/stabilityai/TripoSR>
//!     at `REVISION` (`model.ckpt`, `config.yaml`, sizes and the LFS sha256
//!     from the hub's tree listing)
//!   - the encoder config, Apache 2.0: <https://huggingface.co/facebook/dino-vitb16>
//!     at `DINO_REVISION`

use crate::commands::mesh3d_sf3d;
use crate::commands::voice_loop::manifest::RemoteFile;
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

/// The head of `main` on 13.11.2026. The repository has no releases.
pub(crate) const SOURCE_COMMIT: &str = "107cefdc244c39106fa830359024f6a2f1c78871";
/// The archive of the commit. Only `tsr/` and the licence are kept from it.
const SOURCE: &str = "https://github.com/VAST-AI-Research/TripoSR/archive";
const SOURCE_BYTES: u64 = 31_282_920;
const SOURCE_SHA256: &str = "a7b3871a1b4377bef96cbfb99bdc952bdd4f5df9f65fea4208d978a343fd1162";

/// The official repository of the weights, at its own sha.
pub(crate) const REPO: &str = "stabilityai/TripoSR";
pub(crate) const REVISION: &str = "5b521936b01fbe1890f6f9baed0254ab6351c04a";
const CKPT_BYTES: u64 = 1_677_246_742;
const CKPT_SHA256: &str = "429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee";
const CONFIG_BYTES: u64 = 987;
const CONFIG_SHA256: &str = "74ca708ce086bf68e97709ea6b3d91f14717921c04691e84043f0eb8fcc68e62";

/// The one file of the image encoder's repository the model reads.
const DINO_REPO: &str = "facebook/dino-vitb16";
const DINO_REVISION: &str = "f205d5d8e640a89a2b8ef0369670dfc37cc07fc2";
const DINO_CONFIG_BYTES: u64 = 454;
const DINO_CONFIG_SHA256: &str = "b87c0270b97db085fd82cf114a761fd0f62ae7914fbd407c752a2260646b689c";

/// Bytes of the three files of the model.
pub(crate) const WEIGHTS_BYTES: u64 = CKPT_BYTES + CONFIG_BYTES + DINO_CONFIG_BYTES;

/// Every package the runner pulls in, with all they need, resolved by pip
/// for Python 3.12 on Apple Silicon as wheels only (13.11.2026), 34 packages
/// from PyPI. torch, numpy, transformers and what they share stand at the
/// versions of the music engine (`music.rs`), so the wheels are fetched once.
/// `omegaconf` 2.4.0 has no `antlr4` any more, whose 4.9 release is a source
/// archive; `tifffile`, `imageio` and `lazy-loader` stand a few releases
/// back from the newest, which were days old.
const PINNED: [&str; 34] = [
    "certifi==2026.1.4", "charset-normalizer==3.4.4", "einops==0.8.2", "filelock==3.20.3", "fsspec==2026.1.0",
    "hf-xet==1.2.0", "huggingface-hub==0.36.0", "idna==3.11", "imageio==2.37.4", "jinja2==3.1.6",
    "lazy-loader==0.5", "markupsafe==3.0.3", "mpmath==1.3.0", "networkx==3.6.1", "numpy==2.3.5",
    "omegaconf==2.4.0", "packaging==26.0", "pillow==12.1.0", "pyyaml==6.0.3", "regex==2026.1.15",
    "requests==2.32.5", "safetensors==0.7.0", "scikit-image==0.26.0", "scipy==1.17.0", "setuptools==71.1.0",
    "sympy==1.14.0", "tifffile==2026.9.20", "tokenizers==0.22.2", "torch==2.10.0", "tqdm==4.67.1",
    "transformers==4.57.6", "trimesh==5.1.1", "typing-extensions==4.15.0", "urllib3==2.6.3",
];

/// TripoSR's pins, for the test of the other engine's shared versions.
#[cfg(test)]
pub(crate) const PINNED_FOR_TESTS: &[&str] = &PINNED;

/// What the install proves it can import before the self test.
const MODULE: &str = "torch, transformers, omegaconf, trimesh, skimage.measure, einops, PIL";

/// What the venv takes on disk, with room for the wheels pip unpacks.
const ENGINE_INSTALL_BYTES: u64 = 1_500_000_000;

/// The one model this engine offers, as the Model Manager and Create name it.
pub(crate) const MODEL_ID: &str = "triposr";
pub(crate) const MODEL_NAME: &str = "TripoSR";

/// Below this a run is refused. The README names about 6 GB of graphics
/// memory, and on a Mac that memory is shared with macOS and the app.
pub(crate) const MIN_RAM_GB: u32 = 16;

/// The grid the surface is taken from, per side. 256 is TripoSR's default.
const DEFAULT_RESOLUTION: u32 = 256;
const MIN_RESOLUTION: u32 = 64;
const MAX_RESOLUTION: u32 = 384;
/// The density the surface is drawn at (`extract_mesh`'s default).
const THRESHOLD: f64 = 25.0;
/// Points per call of the decoder (`run.py`'s default `--chunk-size`).
const CHUNK: u32 = 8192;
/// How much of the picture the object fills (`run.py`'s default).
const FOREGROUND_RATIO: f64 = 0.85;

/// A run that is still going after this long is not going to end.
const GENERATE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// A run that has said nothing for this long has hung.
const STALL_AFTER: Duration = Duration::from_secs(5 * 60);

/// LU's runner, compiled in and written next to the engine before a run.
const RUNNER: &str = include_str!("../../resources/mesh3d/run_triposr.py");

// ── Where it lives ────────────────────────────────────────────────────

/// Everything of the engine in one folder under the app's data folder.
fn root() -> PathBuf {
    crate::os_paths::data_dir().join("mesh3d")
}

pub(crate) fn venv_dir(root: &Path) -> PathBuf {
    root.join("venv")
}

pub(crate) fn venv_python(venv: &Path) -> PathBuf {
    venv.join("bin").join("python")
}

/// The `tsr` package of the pinned commit and its licence.
fn source_dir(root: &Path) -> PathBuf {
    root.join("source").join(SOURCE_COMMIT)
}

/// `model.ckpt`, `config.yaml` and the encoder's `dino-vitb16/config.json`.
pub(crate) fn weights_dir(root: &Path) -> PathBuf {
    root.join("weights")
}

/// Where the downloads that are not the weights wait to be unpacked.
pub(crate) fn downloads_dir(root: &Path) -> PathBuf {
    root.join("downloads")
}

pub(crate) fn work_dir(root: &Path) -> PathBuf {
    root.join("work")
}

fn runner_file(root: &Path) -> PathBuf {
    root.join("runner").join("run_triposr.py")
}

fn run_pid_file(root: &Path) -> PathBuf {
    root.join("run.pid")
}

/// Where the models are kept, beside the images, the videos and the tracks.
pub(crate) fn outputs_root() -> PathBuf {
    crate::os_paths::config_root().join("3d")
}

fn ensure_apple_silicon() -> Result<(), String> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Ok(())
    } else {
        Err(bad_request("Local 3D on a Mac needs Apple Silicon. Use the ComfyUI lane on this system."))
    }
}

// ── The engine ────────────────────────────────────────────────────────

#[cfg(test)]
fn pip_args() -> Vec<String> {
    ["-m", "pip", "install", "--upgrade", "--only-binary", ":all:", "--disable-pip-version-check"]
        .iter()
        .map(|a| a.to_string())
        .chain(PINNED.iter().map(|p| p.to_string()))
        .collect()
}

fn stamp_file(venv: &Path) -> PathBuf {
    venv.join(".lu-mesh3d-engine")
}

fn stamp() -> String {
    PINNED.join("\n")
}

fn engine_ready_at(venv: &Path) -> bool {
    venv_python(venv).exists() && std::fs::read_to_string(stamp_file(venv)).is_ok_and(|s| s == stamp())
}

pub(crate) fn python_has_module(python: &str, module: &str) -> bool {
    crate::python::python_command(python)
        .args(["-I", "-c", &format!("import {module}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub(crate) fn create_venv(slot: &InstallSlot, base: &str, venv: &Path) -> Result<(), String> {
    if let Some(parent) = venv.parent() {
        std::fs::create_dir_all(parent).map_err(|e| os_error::english(&e))?;
    }
    slot.log(format!("creating the 3D engine environment at {}", venv.display()));
    let mut cmd = crate::python::python_command(base);
    cmd.args(["-m", "venv", "--clear"]).arg(venv.as_os_str());
    crate::commands::video::run_streamed(slot, &mut cmd)
        .map_err(|e| format!("Could not create the Python environment for the 3D engine. {e}"))?;
    if !venv_python(venv).exists() {
        return Err("Python reported a new environment, but there is no interpreter in it.".to_string());
    }
    Ok(())
}

/// The engine's interpreter, with the packages installed first when they are
/// not. Built from LU's own Python (`private_python`), never one found on the
/// Mac. `base` is for the tests.
fn ensure_engine_at(slot: &InstallSlot, base: Option<String>, venv: &Path) -> Result<String, String> {
    let engine = Engine { pinned: &PINNED, wheels: &[], module: MODULE, stamp: stamp(), stamp_file: stamp_file(venv) };
    ensure_engine_with(slot, base, venv, &engine)
}

/// What a 3D engine's venv holds: the packages from PyPI, wheels LU ships
/// itself (paths on disk, written and checked by the caller), the import
/// that proves it, and the stamp that says it is this pin.
pub(crate) struct Engine<'a> {
    pub pinned: &'a [&'a str],
    pub wheels: &'a [PathBuf],
    pub module: &'a str,
    pub stamp: String,
    pub stamp_file: PathBuf,
}

impl Engine<'_> {
    pub(crate) fn ready(&self, venv: &Path) -> bool {
        venv_python(venv).exists() && std::fs::read_to_string(&self.stamp_file).is_ok_and(|s| s == self.stamp)
    }

    pub(crate) fn pip_args(&self) -> Vec<String> {
        ["-m", "pip", "install", "--upgrade", "--only-binary", ":all:", "--disable-pip-version-check"]
            .iter()
            .map(|a| a.to_string())
            .chain(self.pinned.iter().map(|p| p.to_string()))
            .chain(self.wheels.iter().map(|w| w.to_string_lossy().to_string()))
            .collect()
    }
}

/// The venv of `engine`, built when it is not there or not this pin.
pub(crate) fn ensure_engine_with(slot: &InstallSlot, base: Option<String>, venv: &Path, engine: &Engine<'_>) -> Result<String, String> {
    let python = venv_python(venv).to_string_lossy().to_string();
    if engine.ready(venv) {
        return Ok(python);
    }
    if !(venv_python(venv).exists() && python_has_module(&python, "pip")) {
        let base = match base {
            Some(base) => base,
            None => crate::private_python::ensure(slot)?.to_string_lossy().to_string(),
        };
        slot.log(format!("Python: {base}"));
        create_venv(slot, &base, venv)?;
    }
    let _ = std::fs::remove_file(&engine.stamp_file);
    slot.log(format!("installing the 3D engine packages, {} pinned (one-time)", engine.pinned.len() + engine.wheels.len()));
    let mut pip = crate::python::python_command(&python);
    pip.args(engine.pip_args());
    crate::commands::video::run_streamed(slot, &mut pip).map_err(|e| format!("Could not install the 3D engine. {e}"))?;
    if !python_has_module(&python, engine.module) {
        return Err(format!("pip install finished but `import {}` still fails", engine.module));
    }
    std::fs::write(&engine.stamp_file, &engine.stamp).map_err(|e| os_error::english(&e))?;
    Ok(python)
}

// ── The source ────────────────────────────────────────────────────────

fn source_remote() -> RemoteFile {
    RemoteFile { url: format!("{SOURCE}/{SOURCE_COMMIT}.zip"), size: SOURCE_BYTES, sha256: SOURCE_SHA256.to_string() }
}

const SOURCE_MARKER: &str = ".lu-triposr-source";

fn source_ready_at(root: &Path) -> bool {
    let dir = source_dir(root);
    dir.join("tsr").join("system.py").is_file()
        && std::fs::read_to_string(dir.join(SOURCE_MARKER)).is_ok_and(|s| s.trim() == SOURCE_SHA256)
}

/// The part of an archive entry that is kept: what lies under `tsr/` as a
/// Python file, and the licence. `None` for everything else (the examples,
/// the figures, `run.py`, the Gradio app) and for any name that would leave
/// the folder.
fn kept_entry(name: &str) -> Option<PathBuf> {
    let top = format!("TripoSR-{SOURCE_COMMIT}/");
    let rest = name.strip_prefix(&top)?;
    let path = Path::new(rest);
    if path.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return None;
    }
    if rest == "LICENSE" || (rest.starts_with("tsr/") && rest.ends_with(".py")) {
        Some(path.to_path_buf())
    } else {
        None
    }
}

/// Unpack the verified archive into its folder, through a folder beside it
/// that gets the real name only once every file is written.
fn unpack_source(archive: &Path, root: &Path) -> Result<(), String> {
    let target = source_dir(root);
    let staging = target.with_extension("unpack");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| os_error::english(&e))?;
    let file = std::fs::File::open(archive).map_err(|e| os_error::english(&e))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("The TripoSR archive could not be read ({e})."))?;
    let mut kept = 0usize;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("The TripoSR archive could not be read ({e})."))?;
        if !entry.is_file() {
            continue;
        }
        let name = entry.name().map(|n| n.to_string()).unwrap_or_default();
        let Some(rel) = kept_entry(&name) else { continue };
        let out = staging.join(&rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| os_error::english(&e))?;
        }
        let mut dest = std::fs::File::create(&out).map_err(|e| os_error::english(&e))?;
        std::io::copy(&mut entry, &mut dest).map_err(|e| os_error::english(&e))?;
        kept += 1;
    }
    if !staging.join("tsr").join("system.py").is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("The TripoSR archive has no tsr/system.py. Start the download again.".to_string());
    }
    std::fs::write(staging.join(SOURCE_MARKER), SOURCE_SHA256).map_err(|e| os_error::english(&e))?;
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&staging, &target).map_err(|e| os_error::english(&e))?;
    tracing::info!("[mesh3d] TripoSR source unpacked, {kept} files");
    Ok(())
}

// ── The weights ───────────────────────────────────────────────────────

/// One file of the model: where it comes from and where it goes.
struct WeightFile {
    remote: RemoteFile,
    /// Below `weights_dir`.
    path: &'static str,
}

fn weight_files() -> [WeightFile; 3] {
    let hub = |repo: &str, revision: &str, file: &str| format!("https://huggingface.co/{repo}/resolve/{revision}/{file}");
    [
        WeightFile {
            remote: RemoteFile { url: hub(REPO, REVISION, "model.ckpt"), size: CKPT_BYTES, sha256: CKPT_SHA256.to_string() },
            path: "model.ckpt",
        },
        WeightFile {
            remote: RemoteFile { url: hub(REPO, REVISION, "config.yaml"), size: CONFIG_BYTES, sha256: CONFIG_SHA256.to_string() },
            path: "config.yaml",
        },
        WeightFile {
            remote: RemoteFile {
                url: hub(DINO_REPO, DINO_REVISION, "config.json"),
                size: DINO_CONFIG_BYTES,
                sha256: DINO_CONFIG_SHA256.to_string(),
            },
            path: "dino-vitb16/config.json",
        },
    ]
}

/// Written when every file was downloaded and checked. The sizes are held
/// against it on every look; the digests were checked when the files came.
const MANIFEST: &str = ".lu-mesh3d-weights.json";

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Manifest {
    revision: String,
    dino_revision: String,
}

fn this_manifest() -> Manifest {
    Manifest { revision: REVISION.to_string(), dino_revision: DINO_REVISION.to_string() }
}

fn weights_complete(dir: &Path) -> bool {
    let manifest = std::fs::read_to_string(dir.join(MANIFEST)).ok().and_then(|s| serde_json::from_str::<Manifest>(&s).ok());
    manifest.is_some_and(|m| m == this_manifest())
        && weight_files()
            .iter()
            .all(|f| std::fs::metadata(dir.join(f.path)).map(|m| m.is_file() && m.len() == f.remote.size).unwrap_or(false))
}

/// Engine, source and weights. This is what the tile, the Create tab and a
/// run ask.
fn installed_at(root: &Path) -> bool {
    engine_ready_at(&venv_dir(root)) && source_ready_at(root) && weights_complete(&weights_dir(root))
}

/// What an install still has to write.
fn bytes_to_fetch(root: &Path) -> u64 {
    let weights = if weights_complete(&weights_dir(root)) {
        0
    } else {
        WEIGHTS_BYTES.saturating_sub(crate::install_state::dir_size(&weights_dir(root)))
    };
    let source = if source_ready_at(root) { 0 } else { SOURCE_BYTES };
    weights + source + if engine_ready_at(&venv_dir(root)) { 0 } else { ENGINE_INSTALL_BYTES }
}

/// Fetch every `(remote, destination)` that is not there yet, one after the
/// other, with one bar over all of them.
fn fetch_files(slot: &InstallSlot, files: &[(RemoteFile, PathBuf)], what: &str) -> Result<(), String> {
    fetch_files_as(slot, files, what, None)
}

/// `fetch_files` with a Hugging Face token for a gated repository. A refusal
/// of the hub is said in the words the image lane uses for it.
pub(crate) fn fetch_files_as(slot: &InstallSlot, files: &[(RemoteFile, PathBuf)], what: &str, hub_token: Option<&str>) -> Result<(), String> {
    use crate::commands::voice_loop::fetch;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("The download could not be started: {}.", os_error::io_english(&e)))?;
    let client = fetch::http_client()?;
    let total: u64 = files.iter().map(|(r, _)| r.size).sum();
    let cancel = slot.cancel_flag();
    let started = Instant::now();
    let mut before = 0u64;
    let mut base: Option<u64> = None;
    for (remote, dest) in files {
        let meter = slot.clone();
        let offset = before;
        let base_ref = &mut base;
        let mut on_progress = move |done: u64| {
            let all = offset + done;
            let first = *base_ref.get_or_insert(all);
            let seconds = started.elapsed().as_secs_f64().max(0.001);
            meter.set_download(all, total, (all.saturating_sub(first) as f64 / seconds) as u64);
        };
        let fetched = runtime.block_on(fetch::fetch_verified_as(&client, remote, dest, hub_token, &cancel, &mut on_progress));
        if let Err(e) = fetched {
            slot.set_download(0, 0, 0);
            if let fetch::FetchError::Http(status) = e {
                if let Some(why) = crate::commands::mlx::hub_denied_message(status, hub_token.is_some()) {
                    return Err(why.to_string());
                }
            }
            return Err(e.user_message(what));
        }
        before += remote.size;
    }
    slot.set_download(0, 0, 0);
    Ok(())
}

fn install_source(slot: &InstallSlot, root: &Path) -> Result<(), String> {
    if source_ready_at(root) {
        return Ok(());
    }
    slot.log(format!("downloading the TripoSR source at {}", &SOURCE_COMMIT[..7]));
    let archive = downloads_dir(root).join(format!("TripoSR-{SOURCE_COMMIT}.zip"));
    fetch_files(slot, &[(source_remote(), archive.clone())], "the TripoSR source")?;
    unpack_source(&archive, root)?;
    let _ = std::fs::remove_file(&archive);
    Ok(())
}

fn install_weights(slot: &InstallSlot, root: &Path) -> Result<(), String> {
    let dir = weights_dir(root);
    if weights_complete(&dir) {
        slot.log("the weights of TripoSR are on disk already");
        return Ok(());
    }
    slot.log(format!("downloading {REPO} ({})", crate::commands::mlx_snapshot::human_bytes(WEIGHTS_BYTES)));
    std::fs::create_dir_all(&dir).map_err(|e| os_error::english(&e))?;
    let _ = std::fs::remove_file(dir.join(MANIFEST));
    let files: Vec<(RemoteFile, PathBuf)> = weight_files().into_iter().map(|f| (f.remote, dir.join(f.path))).collect();
    fetch_files(slot, &files, "the TripoSR model")?;
    // Two strings: this cannot fail to serialise.
    let record = serde_json::to_string(&this_manifest()).unwrap_or_default();
    std::fs::write(dir.join(MANIFEST), record).map_err(|e| os_error::english(&e))?;
    Ok(())
}

/// The runner on the disk, as compiled into this build.
fn write_runner(root: &Path) -> Result<PathBuf, String> {
    write_runner_at(&runner_file(root), RUNNER)
}

/// A runner `text` at `file`, written only when it differs.
pub(crate) fn write_runner_at(file: &Path, text: &str) -> Result<PathBuf, String> {
    if std::fs::read_to_string(file).is_ok_and(|s| s == text) {
        return Ok(file.to_path_buf());
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| os_error::english(&e))?;
    }
    std::fs::write(file, text).map_err(|e| os_error::english(&e))?;
    Ok(file.to_path_buf())
}

/// The runner's own test: a sphere through the surface, colour and GLB code,
/// and TripoSR imported with the stand-ins. Proves the venv and the source.
fn self_test(slot: &InstallSlot, python: &str, root: &Path) -> Result<(), String> {
    let runner = write_runner(root)?;
    let out = work_dir(root).join("selftest.glb");
    std::fs::create_dir_all(work_dir(root)).map_err(|e| os_error::english(&e))?;
    let mut cmd = crate::python::python_command(python);
    cmd.arg("-I").arg(&runner).arg("--lu-mesh3d-selftest").arg(&out).arg("--source").arg(source_dir(root));
    cmd.current_dir(work_dir(root)).env("HF_HUB_OFFLINE", "1");
    crate::commands::video::run_streamed(slot, &mut cmd).map_err(|e| format!("The 3D engine did not pass its self test. {e}"))?;
    let _ = std::fs::remove_file(&out);
    Ok(())
}

// ── Commands: status, install, remove ─────────────────────────────────

const DESCRIPTION: &str = "Turns one picture of an object into a 3D model with colours, on this Mac. The download is the official TripoSR release.";

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

pub fn mesh3d_status(_state: &AppState, _args: &Value) -> CmdResult {
    let apple_silicon = ensure_apple_silicon().is_ok();
    let root = root();
    let engine = engine_ready_at(&venv_dir(&root));
    let installed = installed_at(&root);
    let sf3d = mesh3d_sf3d::model_json(mesh3d_sf3d::installed_at(&mesh3d_sf3d::root()), crate::commands::mlx::hf_token().is_some());
    Ok(json!({
        "models": [model_json(installed), sf3d],
        "installing": installing_model(),
        "available": apple_silicon,
        "appleSilicon": apple_silicon,
        "engineInstalled": engine,
        "engineCommit": SOURCE_COMMIT,
        "installed": installed,
        "running": busy(),
        "outputsRoot": outputs_root(),
        "model": model_json(installed),
    }))
}

/// Which model of the 3D lane an install or a run is for. TripoSR when
/// the caller names none, as every caller before the second model did.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Which {
    TripoSr,
    Sf3d,
}

#[derive(Deserialize, Default)]
struct ModelArg {
    #[serde(default)]
    model: Option<String>,
    /// What the Model Manager and the real run send.
    #[serde(default)]
    id: Option<String>,
}

fn which(args: &Value) -> Result<Which, String> {
    let a: ModelArg = serde_json::from_value(args.clone()).unwrap_or_default();
    match a.model.as_deref().or(a.id.as_deref()) {
        None | Some(MODEL_ID) => Ok(Which::TripoSr),
        Some(mesh3d_sf3d::MODEL_ID) => Ok(Which::Sf3d),
        Some(other) => Err(bad_request(format!("There is no 3D model called {other} on this Mac."))),
    }
}

/// The model the install slot works or worked on, for the poll.
static INSTALLING: Mutex<Option<&'static str>> = Mutex::new(None);

fn installing_model() -> Option<&'static str> {
    *INSTALLING.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn mesh3d_install(state: &AppState, args: &Value) -> CmdResult {
    ensure_apple_silicon()?;
    let model = which(args)?;
    let slot = state.install_mesh3d();
    if slot.is_running() {
        return Ok(json!({ "ok": true, "status": "installing", "id": installing_model() }));
    }
    if model == Which::Sf3d {
        return install_sf3d(slot);
    }
    *INSTALLING.lock().unwrap_or_else(|e| e.into_inner()) = Some(MODEL_ID);
    let root = root();
    if installed_at(&root) {
        if slot.try_start() {
            slot.complete(format!("{MODEL_ID} already installed"));
        }
        return Ok(json!({ "ok": true, "status": "complete", "id": MODEL_ID }));
    }
    let note = if engine_ready_at(&venv_dir(&root)) { "" } else { "incl. the one-time 3D engine" };
    crate::commands::system::ensure_free_space(&crate::os_paths::data_dir(), MODEL_NAME, bytes_to_fetch(&root), note)
        .map_err(bad_request)?;
    std::fs::create_dir_all(&root).map_err(|e| internal(os_error::english(&e)))?;
    crate::media_store::keep_out_of_backups(&root);
    if !slot.try_start() {
        return Ok(json!({ "ok": true, "status": "installing" }));
    }
    crate::install_state::spawn_install(slot, move |slot| {
        let python = ensure_engine_at(slot, None, &venv_dir(&root))?;
        install_source(slot, &root)?;
        self_test(slot, &python, &root)?;
        install_weights(slot, &root)?;
        if !installed_at(&root) {
            return Err("The download finished, but the model is not complete on disk. Start it again.".to_string());
        }
        Ok(format!("{MODEL_ID} installed"))
    });
    Ok(json!({ "ok": true, "status": "installing", "id": MODEL_ID }))
}

/// Stable Fast 3D on the same slot: its weights are gated, so nothing is
/// fetched before the user's Hugging Face token is there.
fn install_sf3d(slot: crate::install_state::InstallSlot) -> CmdResult {
    let root = mesh3d_sf3d::root();
    *INSTALLING.lock().unwrap_or_else(|e| e.into_inner()) = Some(mesh3d_sf3d::MODEL_ID);
    if mesh3d_sf3d::installed_at(&root) {
        if slot.try_start() {
            slot.complete(format!("{} already installed", mesh3d_sf3d::MODEL_ID));
        }
        return Ok(json!({ "ok": true, "status": "complete", "id": mesh3d_sf3d::MODEL_ID }));
    }
    let Some(token) = crate::commands::mlx::hf_token() else {
        return Err(bad_request(crate::commands::mlx::hub_denied_message(401, false).unwrap_or_default()));
    };
    let (need, note) = mesh3d_sf3d::install_need(&root);
    crate::commands::system::ensure_free_space(&crate::os_paths::data_dir(), mesh3d_sf3d::MODEL_NAME, need, note).map_err(bad_request)?;
    std::fs::create_dir_all(&root).map_err(|e| internal(os_error::english(&e)))?;
    crate::media_store::keep_out_of_backups(&root);
    if !slot.try_start() {
        return Ok(json!({ "ok": true, "status": "installing", "id": installing_model() }));
    }
    crate::install_state::spawn_install(slot, move |slot| mesh3d_sf3d::install(slot, &root, &token));
    Ok(json!({ "ok": true, "status": "installing", "id": mesh3d_sf3d::MODEL_ID }))
}

pub fn mesh3d_install_status(state: &AppState, _args: &Value) -> CmdResult {
    let mut answer = serde_json::to_value(state.install_mesh3d().snapshot()).unwrap_or(Value::Null);
    if answer.is_object() {
        answer["model"] = json!(installing_model());
    }
    Ok(answer)
}

pub fn mesh3d_cancel_install(state: &AppState, _args: &Value) -> CmdResult {
    Ok(json!({ "ok": true, "cancelled": state.install_mesh3d().cancel() }))
}

/// Remove the weights. The engine and the source stay, as with music.
pub fn mesh3d_delete(state: &AppState, args: &Value) -> CmdResult {
    let model = which(args)?;
    if busy() {
        return Err(bad_request("A 3D model is being made. Wait for it to finish before removing the model."));
    }
    if state.install_mesh3d().is_running() {
        return Err(bad_request("The 3D model is still installing. Wait for it to finish, or stop it first."));
    }
    if model == Which::Sf3d {
        mesh3d_sf3d::delete_at(&mesh3d_sf3d::root())?;
        return Ok(json!({ "ok": true, "id": mesh3d_sf3d::MODEL_ID }));
    }
    delete_at(&root())?;
    Ok(json!({ "ok": true, "id": MODEL_ID }))
}

fn delete_at(root: &Path) -> Result<(), String> {
    let dir = weights_dir(root);
    if !dir.is_dir() {
        return Err(not_found(format!("{MODEL_ID} is not installed")));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| internal(format!("delete {MODEL_ID}: {}", os_error::english(&e))))?;
    let _ = std::fs::remove_dir_all(downloads_dir(root));
    Ok(())
}

// ── A run ─────────────────────────────────────────────────────────────

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct GenerateArgs {
    /// The name the caller gives the run: the name of the file, and what a
    /// Cancel names.
    run: String,
    /// A picture staged by Create (`video_stage_start_image`).
    image_path: String,
    #[serde(default)]
    resolution: Option<u32>,
    /// Cut the object out with Vision first. On unless asked otherwise; a
    /// picture that is transparent already is never cut again.
    #[serde(default)]
    cutout: Option<bool>,
    /// `triposr` (the default) or `sf3d`.
    #[serde(default)]
    model: Option<String>,
    /// The texture side of Stable Fast 3D: 512, 1024 or 2048.
    #[serde(default)]
    texture: Option<u32>,
}

/// The grid side a run uses, within what this lane offers, on steps of 32.
fn resolution_for(asked: Option<u32>) -> u32 {
    let r = asked.unwrap_or(DEFAULT_RESOLUTION).clamp(MIN_RESOLUTION, MAX_RESOLUTION);
    (r + 16) / 32 * 32
}

/// The run's name as a file name: letters, digits, `-` and `_`, at most 80.
/// Anything else is not a name this app gave.
fn run_file_stem(run: &str) -> Option<&str> {
    let ok = !run.is_empty() && run.len() <= 80 && run.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then_some(run)
}

/// The file a run writes, never one that is there already.
fn output_for(dir: &Path, run: &str, job: &str) -> PathBuf {
    let first = dir.join(format!("{run}.glb"));
    if first.exists() {
        dir.join(format!("{run}-{}.glb", &job[..8]))
    } else {
        first
    }
}

/// Whether a picture has transparent pixels: the cutout of an earlier step.
fn has_transparency(path: &Path) -> bool {
    let Ok(reader) = image::ImageReader::open(path).and_then(|r| r.with_guessed_format()) else {
        return false;
    };
    let Ok(picture) = reader.decode() else { return false };
    picture.color().has_alpha() && picture.to_rgba8().pixels().any(|p| p[3] < 255)
}

/// What the runner reads, one file per run.
fn job_json(root: &Path, image: &Path, resolution: u32, job_dir: &Path, output: &Path) -> Value {
    let weights = weights_dir(root);
    json!({
        "image": image,
        "source": source_dir(root),
        "weights": weights.join("model.ckpt"),
        "config": weights.join("config.yaml"),
        "dino_config": weights.join("dino-vitb16").join("config.json"),
        "resolution": resolution,
        "threshold": THRESHOLD,
        "chunk": CHUNK,
        "foreground_ratio": FOREGROUND_RATIO,
        "device": "auto",
        "work": job_dir,
        "output": output,
    })
}

/// The flag that names the job file. It is also how a run is recognised
/// after a crash of the app.
const JOB_FLAG: &str = "--lu-mesh3d-job";

/// The command line and the environment of a run.
fn run_command(root: &Path, runner: &Path, job_file: &Path) -> Command {
    let mut cmd = crate::python::python_command(venv_python(&venv_dir(root)));
    // `-I`: nothing from the working folder or the environment's PYTHON*
    // variables is imported; the runner adds the pinned source itself.
    // `-u`: through a pipe Python holds its lines back in blocks.
    cmd.arg("-I").arg("-u").arg(runner).arg(JOB_FLAG).arg(job_file.as_os_str());
    cmd.current_dir(work_dir(root))
        // What MPS cannot run goes to the CPU instead of ending the run.
        .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("HF_HOME", root.join(".hf-cache"))
        .env("TOKENIZERS_PARALLELISM", "false")
        .stdin(Stdio::null());
    cmd
}

#[cfg(test)]
fn memory_refusal(total_bytes: u64) -> Option<String> {
    memory_refusal_for(total_bytes, MODEL_NAME, MIN_RAM_GB)
}

fn memory_refusal_for(total_bytes: u64, name: &str, min_gb: u32) -> Option<String> {
    if total_bytes == 0 {
        return None;
    }
    let have = (total_bytes as f64 / 1_073_741_824.0).round() as u32;
    (have < min_gb).then(|| {
        format!("{name} needs a Mac with {min_gb} GB of memory, and this one has {have} GB. It was not started, because loading it would freeze this Mac.")
    })
}

/// What a poll is told about the run: the last one, or the one under way.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct View {
    job: Option<String>,
    run: Option<String>,
    /// idle, running, complete, error or cancelled.
    status: &'static str,
    /// load, cutout, shape, paint or save: the interface words it.
    phase: String,
    detail: String,
    percent: u32,
    error: Option<String>,
    /// `no_object` when no object was found in the picture.
    error_code: Option<String>,
    output: Option<String>,
    triangles: Option<u64>,
    vertices: Option<u64>,
    /// mps or cpu, as the runner reports it.
    device: Option<String>,
    logs: Vec<String>,
}

struct Runs {
    pid: Mutex<Option<u32>>,
    held: Mutex<Option<String>>,
    stopped: AtomicBool,
    view: Mutex<View>,
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
                run: None,
                status: "idle",
                phase: String::new(),
                detail: String::new(),
                percent: 0,
                error: None,
                error_code: None,
                output: None,
                triangles: None,
                vertices: None,
                device: None,
                logs: Vec::new(),
            }),
            heard: Mutex::new(None),
        }
    }

    fn pid(&self) -> std::sync::MutexGuard<'_, Option<u32>> {
        self.pid.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn held(&self) -> std::sync::MutexGuard<'_, Option<String>> {
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

    fn claim(&self, run: &str, job: &str) -> Option<Claim<'_>> {
        let mut held = self.held();
        if held.is_some() {
            return None;
        }
        self.stopped.store(false, SeqCst);
        *held = Some(run.to_string());
        *self.view() = View {
            job: Some(job.to_string()),
            run: Some(run.to_string()),
            status: "running",
            phase: "load".to_string(),
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

    /// End the run that carries this name, and no other.
    fn stop_run(&self, run: Option<&str>) -> bool {
        if let Some(name) = run {
            if self.held().as_deref() != Some(name) {
                return false;
            }
        }
        self.stop()
    }

    fn set_phase(&self, phase: &str, percent: u32) {
        self.heard_now();
        let mut view = self.view();
        view.phase = phase.to_string();
        view.percent = view.percent.max(percent);
    }

    /// Read one line of the run.
    fn note(&self, line: &str) {
        self.heard_now();
        let mut view = self.view();
        if let Some(said) = line.strip_prefix("LU-MESH3D ").and_then(|j| serde_json::from_str::<Value>(j).ok()) {
            let mut at = |phase: &str, percent: u32| {
                view.phase = phase.to_string();
                view.percent = view.percent.max(percent);
            };
            match said["phase"].as_str().unwrap_or("") {
                "load" => at("load", 8),
                "shape" => {
                    let f = said["fraction"].as_f64().filter(|f| f.is_finite()).unwrap_or(0.0).clamp(0.0, 1.0);
                    at("shape", (15.0 + f * 65.0).round() as u32);
                }
                "paint" => at("paint", 82),
                "save" => at("save", 92),
                "note" => {
                    if let Some(device) = said["device"].as_str() {
                        view.device = Some(device.to_string());
                    }
                    view.detail = said["note"].as_str().unwrap_or("").to_string();
                }
                "error" => {
                    view.error = said["error"].as_str().map(str::to_string);
                    view.error_code = said["code"].as_str().map(str::to_string);
                }
                "done" => {
                    view.percent = 100;
                    view.triangles = said["triangles"].as_u64();
                    view.vertices = said["vertices"].as_u64();
                    if let Some(device) = said["device"].as_str() {
                        view.device = Some(device.to_string());
                    }
                }
                _ => {}
            }
            return;
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
                if why == NO_OBJECT {
                    view.error_code = Some("no_object".to_string());
                }
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

static RUNS: Runs = Runs::new();

/// Whether a 3D model is being made right now.
pub(crate) fn busy() -> bool {
    RUNS.busy()
}

/// The sentence another engine of the Mac refuses its run with while a 3D
/// model is being made.
pub(crate) fn refusal() -> Option<&'static str> {
    busy().then_some("A 3D model is being made on this Mac. Wait for it to finish, then try again.")
}

/// End the run that is under way. The quit path calls this.
pub(crate) fn stop() -> bool {
    RUNS.stop()
}

const STOPPED: &str = "The 3D model was not finished because the app stopped the engine.";
const HUNG: &str = "The 3D engine said nothing for five minutes and was ended. Start it again.";
/// The words of Create for a picture without a clear object (plan 1.8).
const NO_OBJECT: &str = "LU could not find a clear object in this picture. Try one with a plain background.";

fn start(runs: &Runs, mut cmd: Command, pid_file: Option<&Path>) -> Result<std::process::Child, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut slot = runs.pid();
    if slot.is_some() {
        return Err("A 3D model is already being made on this Mac. Wait for it to finish.".to_string());
    }
    if runs.stopped.swap(false, SeqCst) {
        return Err(STOPPED.to_string());
    }
    let child = cmd.spawn().map_err(|e| format!("Could not start the 3D engine: {}", os_error::english(&e)))?;
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

fn finish(runs: &Runs, mut child: std::process::Child, out: &Path, pid_file: Option<&Path>, limit: Duration, stall: Duration) -> Result<(), String> {
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
        if let Some(note) = pid_file {
            let _ = std::fs::remove_file(note);
        }
        status
    });
    let stopped = runs.stopped.swap(false, SeqCst);
    let (said, code) = {
        let view = runs.view();
        (view.error.clone(), view.error_code.clone())
    };
    let status = status.map_err(|e| format!("wait failed: {}", os_error::english(&e)))?;
    let verdict = outcome(status.as_ref(), out.is_file(), said.as_deref(), code.as_deref(), stopped);
    if verdict.is_err() {
        let _ = std::fs::remove_file(out);
    }
    verdict
}

fn outcome(status: Option<&std::process::ExitStatus>, wrote: bool, said: Option<&str>, code: Option<&str>, stopped: bool) -> Result<(), String> {
    if stopped {
        return Err(STOPPED.to_string());
    }
    let Some(status) = status else {
        return Err(match said {
            Some(HUNG) => HUNG.to_string(),
            _ => "The 3D engine did not finish within half an hour and was stopped.".to_string(),
        });
    };
    if status.success() && wrote {
        return Ok(());
    }
    if code == Some("no_object") {
        return Err(NO_OBJECT.to_string());
    }
    if let Some(why) = said.filter(|w| !w.is_empty()) {
        return Err(format!("The 3D engine stopped: {why}"));
    }
    if status.success() {
        return Err("The 3D engine finished without writing a model.".to_string());
    }
    if let Some(code) = status.code() {
        return Err(format!("The 3D engine stopped with exit code {code}. Its last lines are in the log."));
    }
    Err("The 3D engine was ended by macOS. This usually means the model did not fit into memory. Close other apps and try again, or pick a lower detail.".to_string())
}

/// Cut the object out of `input` into `job_dir` with Vision, as Remove
/// Background does on a Mac. A picture that is transparent already is
/// taken as it is.
fn cut_out_for_run(input: &Path, job_dir: &Path) -> Result<PathBuf, String> {
    if has_transparency(input) {
        return Ok(input.to_path_buf());
    }
    #[cfg(target_os = "macos")]
    {
        match crate::commands::mlx_cutout::cut_out(input, job_dir) {
            Ok((path, _, _)) => Ok(path),
            Err(why) if why == crate::commands::mlx_cutout::NO_SUBJECT => Err(NO_OBJECT.to_string()),
            Err(why) => Err(why),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = job_dir;
        Err("The cutout before a 3D run needs a Mac.".to_string())
    }
}

pub async fn mesh3d_generate(state: &AppState, args: &Value) -> CmdResult {
    ensure_apple_silicon()?;
    let req: GenerateArgs = serde_json::from_value(args.clone()).map_err(|e| bad_request(e.to_string()))?;
    let run = run_file_stem(req.run.trim()).ok_or_else(|| bad_request("The run needs a name of letters, digits and dashes."))?.to_string();
    let input = crate::commands::mlx_cutout::staged_input(&req.image_path, &crate::commands::mlx_cutout::staged_images_dir())
        .map_err(|e| bad_request(if e == crate::commands::mlx_cutout::NO_IMAGE { "Add a picture of one object first.".to_string() } else { e }))?;
    let model = match req.model.as_deref() {
        None | Some(MODEL_ID) => Which::TripoSr,
        Some(mesh3d_sf3d::MODEL_ID) => Which::Sf3d,
        Some(other) => return Err(bad_request(format!("There is no 3D model called {other} on this Mac."))),
    };
    let (root, name, min_gb) = match model {
        Which::TripoSr => (root(), MODEL_NAME, MIN_RAM_GB),
        Which::Sf3d => (mesh3d_sf3d::root(), mesh3d_sf3d::MODEL_NAME, mesh3d_sf3d::MIN_RAM_GB),
    };
    let installed = match model {
        Which::TripoSr => installed_at(&root),
        Which::Sf3d => mesh3d_sf3d::installed_at(&root),
    };
    if !installed {
        return Err(bad_request(format!("{name} is not installed. Set it up in the 3D tab first.")));
    }
    if let Some(refusal) = memory_refusal_for(crate::commands::system::total_memory_bytes(), name, min_gb) {
        return Err(bad_request(refusal));
    }
    // One model in the memory at a time.
    if let Some(why) = crate::commands::mlx::train::refusal() {
        return Err(bad_request(why));
    }
    if crate::commands::mlx::image_engine_busy() {
        return Err(bad_request("An image is being generated on this Mac. Wait for it to finish, then make the 3D model."));
    }
    if state.video_process().lock().map(|p| p.is_some()).unwrap_or(true) {
        return Err(bad_request("A video is being generated on this Mac. Wait for it to finish, then make the 3D model."));
    }
    if crate::commands::music::busy() {
        return Err(bad_request("A track is being made on this Mac. Wait for it to finish, then make the 3D model."));
    }
    let job = uuid::Uuid::new_v4().simple().to_string();
    let claim = RUNS
        .claim(&run, &job)
        .ok_or_else(|| bad_request("A 3D model is already being made on this Mac. Wait for it to finish."))?;
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
    let written = match model {
        Which::TripoSr => write_runner(&root),
        Which::Sf3d => write_runner_at(&mesh3d_sf3d::runner_file(&root), mesh3d_sf3d::RUNNER),
    };
    let runner = match written {
        Ok(path) => path,
        Err(why) => {
            RUNS.conclude(&Err(why.clone()));
            return Err(internal(why));
        }
    };
    let output = output_for(&out_dir, &run, &job);
    let resolution = resolution_for(req.resolution);
    let texture = mesh3d_sf3d::texture_for(req.texture);
    let cutout = req.cutout.unwrap_or(true);
    RUNS.view().output = Some(output.to_string_lossy().to_string());
    match model {
        Which::TripoSr => tracing::info!("[mesh3d] TripoSR at {}: grid {resolution}, cutout {cutout}", &SOURCE_COMMIT[..7]),
        Which::Sf3d => tracing::info!("[mesh3d] Stable Fast 3D at {}: texture {texture}, cutout {cutout}", &mesh3d_sf3d::SOURCE_COMMIT[..7]),
    }
    // One pid file for the lane, in TripoSR's folder, whatever the model:
    // there is one run at a time, and the reaper reads this one.
    let pid_file = run_pid_file(&self::root());
    let out = output.clone();
    std::thread::spawn(move || {
        let verdict = (|| {
            let picture = if cutout {
                RUNS.set_phase("cutout", 2);
                cut_out_for_run(&input, &job_dir)?
            } else {
                input.clone()
            };
            RUNS.set_phase("load", 5);
            let job_file = job_dir.join("job.json");
            let job = match model {
                Which::TripoSr => job_json(&root, &picture, resolution, &job_dir, &out),
                Which::Sf3d => mesh3d_sf3d::job_json(&root, &picture, texture, &job_dir, &out),
            };
            std::fs::write(&job_file, job.to_string())
                .map_err(|e| format!("write {}: {}", job_file.display(), os_error::english(&e)))?;
            let child = start(&RUNS, run_command(&root, &runner, &job_file), Some(&pid_file))?;
            finish(&RUNS, child, &out, Some(&pid_file), GENERATE_TIMEOUT, STALL_AFTER)
        })();
        // A Cancel during the cutout, before there was a process.
        let verdict = match verdict {
            Err(_) if RUNS.stopped.swap(false, SeqCst) => Err(STOPPED.to_string()),
            other => other,
        };
        if let Err(why) = &verdict {
            tracing::error!("[mesh3d] {why}");
            let _ = std::fs::remove_file(&out);
        }
        RUNS.conclude(&verdict);
        let _ = std::fs::remove_dir_all(&job_dir);
        drop(claim);
    });
    Ok(json!({
        "ok": true,
        "jobId": job,
        "run": run,
        "output": output,
        "model": match model { Which::TripoSr => MODEL_ID, Which::Sf3d => mesh3d_sf3d::MODEL_ID },
        "resolution": resolution,
        "texture": texture,
        "cutout": cutout,
    }))
}

pub fn mesh3d_progress(_state: &AppState, _args: &Value) -> CmdResult {
    let view = RUNS.view().clone();
    let mut answer = serde_json::to_value(&view).unwrap_or(Value::Null);
    answer["running"] = json!(busy());
    answer["pid"] = json!(*RUNS.pid());
    if let Some(bytes) = view.output.as_deref().filter(|_| view.status == "complete").and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len()) {
        answer["bytes"] = json!(bytes);
    }
    Ok(answer)
}

#[derive(Deserialize, Default)]
struct CancelArgs {
    #[serde(default)]
    run: Option<String>,
}

pub fn mesh3d_cancel(_state: &AppState, args: &Value) -> CmdResult {
    let a: CancelArgs = serde_json::from_value(args.clone()).unwrap_or_default();
    Ok(json!({ "ok": true, "stopped": RUNS.stop_run(a.run.as_deref()) }))
}

// ── A run that outlived the app ───────────────────────────────────────

#[cfg(any(target_os = "macos", test))]
struct Leftover {
    parent: Option<u32>,
    cmd: Vec<String>,
}

#[cfg(any(target_os = "macos", test))]
fn is_orphaned_run(row: &Leftover, work: &Path) -> bool {
    row.parent == Some(1) && row.cmd.windows(2).any(|w| w[0] == JOB_FLAG && Path::new(&w[1]).starts_with(work))
}

/// End the run the last session left behind, if there is one, and return its
/// pid. Called once at app start, off the main thread.
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
    let ours = is_orphaned_run(&row, &work_dir(&root)) || is_orphaned_run(&row, &work_dir(&mesh3d_sf3d::root()));
    if !ours {
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

/// For `real_run_mac`: the venv of the engine, to measure it.
#[cfg(all(test, target_os = "macos"))]
pub(crate) fn real_run_root() -> PathBuf {
    root()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn production_source() -> &'static str {
        let src = include_str!("mesh3d.rs");
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

    fn hex40(s: &str) -> bool {
        s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit())
    }

    fn hex64(s: &str) -> bool {
        s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
    }

    #[test]
    fn the_source_and_the_weights_are_pinned_by_commit_revision_size_and_digest() {
        assert!(hex40(SOURCE_COMMIT) && hex40(REVISION) && hex40(DINO_REVISION));
        for sha in [SOURCE_SHA256, CKPT_SHA256, CONFIG_SHA256, DINO_CONFIG_SHA256] {
            assert!(hex64(sha), "{sha}");
        }
        assert_eq!(source_remote().url, format!("https://github.com/VAST-AI-Research/TripoSR/archive/{SOURCE_COMMIT}.zip"));
        assert_eq!(CKPT_BYTES, 1_677_246_742, "the size the plan read from the hub");
        let files = weight_files();
        assert_eq!(files.map(|f| f.path), ["model.ckpt", "config.yaml", "dino-vitb16/config.json"]);
        for f in &weight_files() {
            assert!(f.remote.url.starts_with("https://huggingface.co/"), "{}", f.remote.url);
            assert!(f.remote.url.contains(REVISION) || f.remote.url.contains(DINO_REVISION), "{}", f.remote.url);
            assert!(!f.remote.url.contains("/main/"), "{}", f.remote.url);
        }
        assert_eq!(model_json(false)["sizeGB"], 1.7);
        let src = production_source();
        let code: String = src.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
        assert!(!code.contains("@main") && !code.contains("git+"));
    }

    #[test]
    fn every_package_has_its_version_and_torch_is_the_music_engines() {
        for spec in &PINNED {
            let (name, version) = spec.split_once("==").unwrap_or_else(|| panic!("{spec} is not pinned"));
            assert!(!name.is_empty() && !version.is_empty() && !version.contains(['<', '>', '*', ' ']), "{spec}");
        }
        let mut names: Vec<&str> = PINNED.iter().map(|s| s.split("==").next().unwrap()).collect();
        let sorted = names.clone();
        names.sort();
        assert_eq!(names, sorted, "kept in order, so a diff shows what moved");
        names.dedup();
        assert_eq!(names.len(), PINNED.len());
        // The same wheels as the music engine where both stand on them.
        let music = include_str!("music.rs");
        for shared in ["torch==", "numpy==", "transformers==", "huggingface-hub==", "safetensors==", "tokenizers==", "einops==", "pillow=="] {
            let ours = PINNED.iter().find(|p| p.starts_with(shared)).unwrap_or_else(|| panic!("{shared}"));
            assert!(music.contains(&format!("\"{ours}\"")), "{ours} differs from the music engine");
        }
        // What a Mac cannot install, and what the runner replaces.
        for never in ["torchmcubes", "rembg", "xatlas", "moderngl", "gradio", "onnxruntime", "antlr4-python3-runtime"] {
            assert!(!PINNED.iter().any(|p| p.starts_with(&format!("{never}=="))), "{never}");
        }
        let pip = pip_args();
        assert_eq!(&pip[..7], ["-m", "pip", "install", "--upgrade", "--only-binary", ":all:", "--disable-pip-version-check"]);
        assert_eq!(&pip[7..], PINNED.map(String::from));
    }

    #[test]
    fn everything_lives_in_one_folder_of_the_app_and_models_beside_the_videos() {
        let root = root();
        assert!(root.starts_with(crate::os_paths::data_dir()));
        for dir in [venv_dir(&root), source_dir(&root), weights_dir(&root), downloads_dir(&root), work_dir(&root), runner_file(&root), run_pid_file(&root)] {
            assert!(dir.starts_with(&root), "{}", dir.display());
        }
        assert_ne!(venv_dir(&root), crate::os_paths::data_dir().join("acestep").join("venv"), "never the music engine's venv");
        assert_eq!(outputs_root().parent(), crate::commands::video::outputs_root().parent());
        assert_eq!(outputs_root().file_name().unwrap(), "3d");
    }

    #[test]
    fn a_venv_without_the_stamp_of_this_pin_is_not_the_engine() {
        let tmp = tempfile::tempdir().unwrap();
        let venv = tmp.path().join("venv");
        assert!(!engine_ready_at(&venv));
        put(venv_python(&venv), 1);
        assert!(!engine_ready_at(&venv));
        std::fs::write(stamp_file(&venv), "torch==2.9.0").unwrap();
        assert!(!engine_ready_at(&venv), "the stamp of another pin");
        std::fs::write(stamp_file(&venv), stamp()).unwrap();
        assert!(engine_ready_at(&venv));
    }

    #[test]
    fn only_the_tsr_package_and_the_licence_are_taken_from_the_archive() {
        let top = format!("TripoSR-{SOURCE_COMMIT}/");
        assert_eq!(kept_entry(&format!("{top}tsr/system.py")), Some(PathBuf::from("tsr/system.py")));
        assert_eq!(kept_entry(&format!("{top}tsr/models/tokenizers/image.py")), Some(PathBuf::from("tsr/models/tokenizers/image.py")));
        assert_eq!(kept_entry(&format!("{top}LICENSE")), Some(PathBuf::from("LICENSE")));
        for other in ["run.py", "gradio_app.py", "requirements.txt", "examples/chair.png", "tsr/../../evil.py", "tsr/x.so"] {
            assert_eq!(kept_entry(&format!("{top}{other}")), None, "{other}");
        }
        assert_eq!(kept_entry("TripoSR-main/tsr/system.py"), None, "the archive of another commit");
        assert_eq!(kept_entry("/etc/passwd"), None);
    }

    #[test]
    fn an_archive_is_unpacked_whole_or_not_at_all() {
        use std::io::Write;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let zip_path = root.join("a.zip");
        let write = |names: &[&str]| {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
            for name in names {
                zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
                zip.write_all(b"# py").unwrap();
            }
            zip.finish().unwrap();
        };
        let top = format!("TripoSR-{SOURCE_COMMIT}");
        write(&[&format!("{top}/run.py")]);
        assert!(unpack_source(&zip_path, root).unwrap_err().contains("tsr/system.py"));
        assert!(!source_ready_at(root));
        write(&[&format!("{top}/tsr/system.py"), &format!("{top}/tsr/utils.py"), &format!("{top}/examples/a.png"), &format!("{top}/LICENSE")]);
        unpack_source(&zip_path, root).unwrap();
        assert!(source_ready_at(root));
        assert!(source_dir(root).join("tsr/utils.py").is_file());
        assert!(!source_dir(root).join("examples").exists());
    }

    #[test]
    fn installed_is_engine_source_and_weights_and_remove_takes_the_weights() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert!(!installed_at(root));
        assert_eq!(bytes_to_fetch(root), WEIGHTS_BYTES + SOURCE_BYTES + ENGINE_INSTALL_BYTES);
        let dir = weights_dir(root);
        for f in weight_files() {
            put(dir.join(f.path), f.remote.size);
        }
        assert!(!weights_complete(&dir), "no manifest, no model: a stopped download looks the same");
        std::fs::write(dir.join(MANIFEST), serde_json::to_string(&this_manifest()).unwrap()).unwrap();
        assert!(weights_complete(&dir));
        put(dir.join("config.yaml"), 986);
        assert!(!weights_complete(&dir), "a file of the wrong size");
        put(dir.join("config.yaml"), CONFIG_BYTES);
        let old = Manifest { revision: "0".repeat(40), dino_revision: DINO_REVISION.to_string() };
        std::fs::write(dir.join(MANIFEST), serde_json::to_string(&old).unwrap()).unwrap();
        assert!(!weights_complete(&dir), "another revision");
        std::fs::write(dir.join(MANIFEST), serde_json::to_string(&this_manifest()).unwrap()).unwrap();

        put(venv_python(&venv_dir(root)), 1);
        std::fs::write(stamp_file(&venv_dir(root)), stamp()).unwrap();
        assert!(!installed_at(root), "no source");
        put(source_dir(root).join("tsr").join("system.py"), 3);
        std::fs::write(source_dir(root).join(SOURCE_MARKER), SOURCE_SHA256).unwrap();
        assert!(installed_at(root));
        assert_eq!(bytes_to_fetch(root), 0);

        delete_at(root).unwrap();
        assert!(!dir.exists());
        assert!(engine_ready_at(&venv_dir(root)) && source_ready_at(root), "engine and source stay");
        assert!(!installed_at(root));
        assert!(delete_at(root).unwrap_err().contains("not installed"));
    }

    #[test]
    fn the_grid_the_name_and_the_file_of_a_run() {
        assert_eq!(resolution_for(None), 256);
        assert_eq!(resolution_for(Some(128)), 128);
        assert_eq!(resolution_for(Some(10)), 64);
        assert_eq!(resolution_for(Some(5000)), 384);
        assert_eq!(resolution_for(Some(200)), 192);
        assert_eq!(run_file_stem("mesh3d-1731500000-1"), Some("mesh3d-1731500000-1"));
        for bad in ["", "../x", "a/b", "a b", "a.glb", &"x".repeat(81)] {
            assert_eq!(run_file_stem(bad), None, "{bad}");
        }
        let tmp = tempfile::tempdir().unwrap();
        let job = "0123456789abcdef";
        assert_eq!(output_for(tmp.path(), "r1", job), tmp.path().join("r1.glb"));
        std::fs::write(tmp.path().join("r1.glb"), b"x").unwrap();
        assert_eq!(output_for(tmp.path(), "r1", job), tmp.path().join("r1-01234567.glb"), "never over a model that is there");
    }

    #[test]
    fn a_picture_with_transparent_pixels_is_not_cut_again() {
        let tmp = tempfile::tempdir().unwrap();
        let cut = tmp.path().join("cut.png");
        let mut rgba = image::RgbaImage::from_pixel(4, 4, image::Rgba([1, 2, 3, 255]));
        rgba.put_pixel(0, 0, image::Rgba([0, 0, 0, 0]));
        rgba.save(&cut).unwrap();
        assert!(has_transparency(&cut));
        assert_eq!(cut_out_for_run(&cut, tmp.path()).unwrap(), cut);
        let opaque = tmp.path().join("photo.png");
        image::RgbaImage::from_pixel(4, 4, image::Rgba([1, 2, 3, 255])).save(&opaque).unwrap();
        assert!(!has_transparency(&opaque));
        assert!(!has_transparency(&tmp.path().join("missing.png")));
    }

    #[test]
    fn the_job_carries_what_the_runner_reads() {
        let root = Path::new("/data/mesh3d");
        let job = job_json(root, Path::new("/s/start-images/a.png"), 256, Path::new("/data/mesh3d/work/jobs/j1"), Path::new("/c/3d/r1.glb"));
        for key in ["image", "source", "weights", "config", "dino_config", "resolution", "threshold", "chunk", "foreground_ratio", "work", "output"] {
            assert!(RUNNER.contains(&format!("job[\"{key}\"]")), "the runner does not read {key}");
            assert!(!job[key].is_null(), "{key}");
        }
        assert_eq!(job["threshold"], 25.0);
        assert_eq!(job["chunk"], 8192);
        assert!(job["source"].as_str().unwrap().ends_with(SOURCE_COMMIT));
        assert!(job["dino_config"].as_str().unwrap().ends_with("config.json"));
    }

    #[test]
    fn the_runner_replaces_what_a_mac_cannot_install_and_stays_offline() {
        for needed in [
            "sys.modules[\"torchmcubes\"]",
            "sys.modules[\"rembg\"]",
            "from skimage import measure",
            "tokenizer.hf_hub_download = local_config",
            "weights_only=True",
            "file_type=\"glb\"",
            "torch.backends.mps.is_available()",
            "PREFIX = \"LU-MESH3D \"",
            "JOB_FLAG = \"--lu-mesh3d-job\"",
        ] {
            assert!(RUNNER.contains(needed), "{needed}");
        }
        for never in ["rembg.new_session()", "import xatlas", "import moderngl", "bake_texture", "snapshot_download", "requests.get", "urllib"] {
            assert!(!RUNNER.contains(never), "{never}");
        }
        assert!(RUNNER.contains(&format!("DINO_REPO = \"{DINO_REPO}\"")));
    }

    #[test]
    fn the_command_line_runs_isolated_offline_and_with_the_mps_fallback() {
        let root = Path::new("/data/mesh3d");
        let cmd = run_command(root, Path::new("/data/mesh3d/runner/run_triposr.py"), Path::new("/data/mesh3d/work/jobs/j1/job.json"));
        assert_eq!(cmd.get_program(), venv_python(&venv_dir(root)).as_os_str());
        let args = args_of(&cmd);
        assert_eq!(args, ["-I", "-u", "/data/mesh3d/runner/run_triposr.py", JOB_FLAG, "/data/mesh3d/work/jobs/j1/job.json"]);
        assert_eq!(cmd.get_current_dir(), Some(work_dir(root).as_path()));
        assert_eq!(env_of(&cmd, "PYTORCH_ENABLE_MPS_FALLBACK").as_deref(), Some("1"));
        assert_eq!(env_of(&cmd, "HF_HUB_OFFLINE").as_deref(), Some("1"));
        assert_eq!(env_of(&cmd, "TRANSFORMERS_OFFLINE").as_deref(), Some("1"));
    }

    #[test]
    fn a_command_names_its_model_or_means_triposr() {
        assert_eq!(which(&json!({})), Ok(Which::TripoSr));
        assert_eq!(which(&Value::Null), Ok(Which::TripoSr));
        assert_eq!(which(&json!({ "model": "triposr" })), Ok(Which::TripoSr));
        assert_eq!(which(&json!({ "model": "sf3d" })), Ok(Which::Sf3d));
        assert_eq!(which(&json!({ "id": "sf3d" })), Ok(Which::Sf3d));
        assert!(which(&json!({ "model": "spar3d" })).unwrap_err().contains("no 3D model called spar3d"));
        // One pid file for the lane, and a leftover run of either model is found.
        let src = production_source();
        assert!(src.contains("let pid_file = run_pid_file(&self::root());"));
        assert!(src.contains("is_orphaned_run(&row, &work_dir(&mesh3d_sf3d::root()))"));
    }

    #[test]
    fn stable_fast_3d_is_not_set_up_without_a_token() {
        let src = production_source();
        let body = &src[src.find("fn install_sf3d(").unwrap()..src.find("pub fn mesh3d_install_status(").unwrap()];
        let token = body.find("hf_token()").unwrap();
        let space = body.find("ensure_free_space(").unwrap();
        let spawn = body.find("spawn_install(").unwrap();
        assert!(token < space && space < spawn, "nothing is fetched before the token is there");
    }

    #[test]
    fn a_mac_with_too_little_memory_is_told_before_anything_loads() {
        const GIB: u64 = 1_073_741_824;
        assert!(memory_refusal(8 * GIB).unwrap().contains("needs a Mac with 16 GB"));
        assert_eq!(memory_refusal(16 * GIB), None);
        assert_eq!(memory_refusal(0), None);
    }

    #[test]
    fn the_lines_of_a_run_move_its_progress() {
        let runs = Runs::new();
        let _claim = runs.claim("r1", "j1").unwrap();
        assert_eq!(runs.view().status, "running");
        assert_eq!(runs.view().run.as_deref(), Some("r1"));
        runs.set_phase("cutout", 2);
        assert_eq!(runs.view().phase, "cutout");
        runs.note("LU-MESH3D {\"phase\": \"load\"}");
        assert_eq!({ let v = runs.view(); (v.phase.clone(), v.percent) }, ("load".to_string(), 8));
        runs.note("LU-MESH3D {\"phase\": \"note\", \"note\": \"device mps\", \"device\": \"mps\"}");
        assert_eq!(runs.view().device.as_deref(), Some("mps"));
        runs.note("LU-MESH3D {\"phase\": \"shape\", \"fraction\": 0.5}");
        assert_eq!(runs.view().percent, 48);
        runs.note("LU-MESH3D {\"phase\": \"shape\", \"fraction\": 0.1}");
        assert_eq!(runs.view().percent, 48, "never backwards");
        runs.note("LU-MESH3D {\"phase\": \"paint\"}");
        runs.note("LU-MESH3D {\"phase\": \"save\"}");
        assert_eq!({ let v = runs.view(); (v.phase.clone(), v.percent) }, ("save".to_string(), 92));
        runs.note("LU-MESH3D {\"phase\": \"done\", \"triangles\": 123, \"vertices\": 64, \"device\": \"mps\"}");
        assert_eq!({ let v = runs.view(); (v.triangles, v.vertices, v.percent) }, (Some(123), Some(64), 100));
        for i in 0..60 {
            runs.note(&format!("line {i}"));
        }
        assert_eq!(runs.view().logs.len(), 40);
        runs.conclude(&Ok(()));
        assert_eq!(runs.view().status, "complete");
    }

    #[test]
    fn one_run_at_a_time_and_a_cancel_names_its_run() {
        let runs = Runs::new();
        let claim = runs.claim("a", "j1").unwrap();
        assert!(runs.busy());
        assert!(runs.claim("b", "j2").is_none());
        assert!(!runs.stop_run(Some("b")), "a Cancel for another run");
        assert!(runs.stop_run(Some("a")));
        assert_eq!(start(&runs, Command::new("true"), None).unwrap_err(), STOPPED, "stopped during the cutout: no process");
        drop(claim);
        assert!(!runs.busy());
        assert!(!runs.stop());
    }

    #[cfg(unix)]
    fn shell(script: &str) -> Command {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(script);
        cmd
    }

    #[cfg(unix)]
    #[test]
    fn a_run_that_writes_its_model_is_complete() {
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("m.glb");
        let pid_file = tmp.path().join("run.pid");
        let runs = Runs::new();
        let _claim = runs.claim("r", "j1").unwrap();
        let script = format!(
            "echo 'LU-MESH3D {{\"phase\": \"load\"}}'; echo glTF > '{}'; echo 'LU-MESH3D {{\"phase\": \"done\", \"triangles\": 9}}'",
            out.display()
        );
        let child = start(&runs, shell(&script), Some(&pid_file)).unwrap();
        assert!(pid_file.is_file());
        assert_eq!(finish(&runs, child, &out, Some(&pid_file), Duration::from_secs(30), Duration::from_secs(30)), Ok(()));
        assert!(!pid_file.exists());
        assert_eq!(runs.view().triangles, Some(9));
        assert!(runs.pid().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_picture_without_an_object_is_said_in_the_words_of_create() {
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("m.glb");
        let runs = Runs::new();
        let _claim = runs.claim("r", "j1").unwrap();
        let script = format!("echo half > '{}'; echo 'LU-MESH3D {{\"phase\": \"error\", \"error\": \"no object\", \"code\": \"no_object\"}}'; exit 6", out.display());
        let child = start(&runs, shell(&script), None).unwrap();
        let verdict = finish(&runs, child, &out, None, Duration::from_secs(30), Duration::from_secs(30));
        assert_eq!(verdict.clone().unwrap_err(), NO_OBJECT);
        assert!(!out.exists(), "half a model is no model");
        runs.conclude(&verdict);
        assert_eq!(runs.view().error_code.as_deref(), Some("no_object"));
    }

    #[cfg(unix)]
    #[test]
    fn cancel_ends_the_process_and_a_hung_run_is_ended_by_the_watch() {
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("m.glb");
        let runs = Runs::new();
        let claim = runs.claim("r", "j1").unwrap();
        let child = start(&runs, shell("sleep 30"), None).unwrap();
        let started = Instant::now();
        std::thread::scope(|s| {
            s.spawn(|| {
                std::thread::sleep(Duration::from_millis(300));
                assert!(runs.stop_run(Some("r")));
            });
            assert_eq!(finish(&runs, child, &out, None, Duration::from_secs(60), Duration::from_secs(60)).unwrap_err(), STOPPED);
        });
        assert!(started.elapsed() < Duration::from_secs(10));
        runs.conclude(&Err(STOPPED.to_string()));
        assert_eq!(runs.view().status, "cancelled");
        drop(claim);

        let _claim = runs.claim("r2", "j2").unwrap();
        let child = start(&runs, shell("sleep 30"), None).unwrap();
        let started = Instant::now();
        assert_eq!(finish(&runs, child, &out, None, Duration::from_secs(60), Duration::from_millis(400)).unwrap_err(), HUNG);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn how_a_run_ended_in_words() {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            let ok = std::process::ExitStatus::from_raw(0);
            let code5 = std::process::ExitStatus::from_raw(5 << 8);
            let killed = std::process::ExitStatus::from_raw(9);
            assert_eq!(outcome(Some(&ok), true, None, None, false), Ok(()));
            assert!(outcome(Some(&ok), false, None, None, false).unwrap_err().contains("without writing a model"));
            assert_eq!(outcome(Some(&ok), true, None, None, true).unwrap_err(), STOPPED);
            assert!(outcome(Some(&code5), false, None, None, false).unwrap_err().contains("exit code 5"));
            assert!(outcome(Some(&code5), false, Some("boom"), None, false).unwrap_err().contains("boom"));
            assert!(outcome(Some(&killed), false, None, None, false).unwrap_err().contains("ended by macOS"));
        }
        assert_eq!(outcome(None, false, Some(HUNG), None, false).unwrap_err(), HUNG);
    }

    #[test]
    fn a_run_of_ours_whose_app_is_gone_is_told_from_any_other_process() {
        let work = Path::new("/data/mesh3d/work");
        let row = |parent: Option<u32>, cmd: &[&str]| Leftover { parent, cmd: cmd.iter().map(|s| s.to_string()).collect() };
        let ours = ["/data/mesh3d/venv/bin/python", "-I", "-u", "/data/mesh3d/runner/run_triposr.py", JOB_FLAG, "/data/mesh3d/work/jobs/j1/job.json"];
        assert!(is_orphaned_run(&row(Some(1), &ours), work));
        assert!(!is_orphaned_run(&row(Some(4242), &ours), work));
        assert!(!is_orphaned_run(&row(Some(1), &["python", JOB_FLAG, "/elsewhere/job.json"]), work));
        assert!(!is_orphaned_run(&row(Some(1), &["python", "--lu-acestep-job", "/data/mesh3d/work/j.json"]), work));
    }

    #[test]
    fn a_run_takes_only_a_staged_picture_and_waits_for_the_other_engines() {
        let src = production_source();
        let generate = &src[src.find("pub async fn mesh3d_generate(").unwrap()..src.find("pub fn mesh3d_progress(").unwrap()];
        let staged = generate.find("mlx_cutout::staged_input(").expect("a picture from anywhere on the disk");
        let installed = generate.find("if !installed {").unwrap();
        let memory = generate.find("memory_refusal_for(").unwrap();
        let train = generate.find("train::refusal()").unwrap();
        let image = generate.find("image_engine_busy()").unwrap();
        let video = generate.find("state.video_process()").unwrap();
        let music = generate.find("music::busy()").unwrap();
        let claimed = generate.find("RUNS\n        .claim(").unwrap();
        let unload = generate.find("mlx_unload(").unwrap();
        let started = generate.find("start(&RUNS, run_command(").unwrap();
        assert!(staged < installed && installed < memory && memory < train && train < image && image < video && video < music && music < claimed && claimed < unload && unload < started);
        // The other engines wait for a 3D run in turn.
        for (file, src) in [
            ("mlx.rs", include_str!("mlx.rs")),
            ("video.rs", include_str!("video.rs")),
            ("music.rs", include_str!("music.rs")),
            ("mlx_train.rs", include_str!("mlx_train.rs")),
        ] {
            assert!(src.contains("crate::commands::mesh3d::refusal()"), "{file} starts beside a 3D run");
        }
    }
}
