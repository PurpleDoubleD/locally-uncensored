//! The second local 3D model of the Mac: Stable Fast 3D (SF3D), one picture
//! in, one GLB with a baked texture out.
//!
//! It runs on the machinery of `mesh3d.rs` (one run at a time, one Python
//! process per model, Cancel ends it, offline during the run). What is its
//! own lives here: a venv of its own, the source at one commit, the gated
//! weights at one revision, and the two C++ extensions of SF3D as wheels LU
//! built itself.
//!
//! The two extensions (`texture_baker`, `uv_unwrapper`, both in the SF3D
//! repository) are compiled by `pip install ./texture_baker/` upstream, which
//! a customer's Mac cannot do: it has no compiler. LU builds them once
//! (`scripts/build-sf3d-wheels.sh`, against torch 2.10.0 and Python 3.12 of
//! the pins below), keeps the two wheels in `resources/mesh3d/wheels/` and
//! compiles them into this binary. The install writes them next to the venv,
//! checks their sha256 and hands them to pip as files. Nothing is compiled
//! and nothing of them comes from the net. They link only torch's own
//! libraries (`@rpath`, found through `@loader_path/../torch/lib`) and the
//! system's, not Homebrew's OpenMP; `uv_unwrapper` runs single-threaded as
//! the upstream Mac build does.
//!
//! What the runner (`resources/mesh3d/run_sf3d.py`) puts in place of what
//! does not run on a customer's Mac, read at the pinned commit (13.11.2026):
//!   - `rembg` (downloads a model of its own): LU cuts the object out with
//!     Vision before the run, as for TripoSR.
//!   - `gpytoolbox` and `pynanoinstantmeshes`: only for the remesh option,
//!     which LU does not offer.
//!   - the DINOv2 and CLIP encoders would download their weights when the
//!     model is built. `model.safetensors` is loaded strictly
//!     (`safetensors.torch.load_model`), so it holds every weight of both;
//!     they are built empty, DINOv2 from its `config.json` fetched here at a
//!     fixed revision.
//!
//! Content filter: none. `grep -riE "safety|nsfw|censor|filter|explicit|porn|
//! nude|watermark|blocklist|moderat"` over every `.py` file of `sf3d/` at
//! `SOURCE_COMMIT` finds nothing. The only network calls are the hub
//! downloads above, none of which a run makes. The licence's Acceptable Use
//! Policy forbids sexual content: that is a rule of the licence, not a filter
//! in the code, and the model is not marked unfiltered.
//!
//! The licence: Stability AI Community License (the `LICENSE.md` of the
//! source archive, the same text on the weights). Free for research,
//! non-commercial use and for people or companies under a yearly revenue of
//! one million (US currency), with registration at Stability AI for
//! commercial use. Whoever passes the code on keeps the licence and a notice
//! file with it, which the install writes beside the venv (`NOTICE`). The
//! weights are gated: the user accepts the licence on the model's page and
//! downloads with their own Hugging Face token (Settings). LU never holds the
//! weights.
//!
//! The digests of the gated files: the hub shows the sha256 of a gated file
//! only to a signed-in account. What it shows to everyone is the git object
//! id of each file at the revision. For `config.yaml` that is the sha1 of the
//! file itself as a git blob; for `model.safetensors` it is the sha1 of its
//! LFS pointer, and the pointer names the file's sha256. Both ids are pinned
//! here. The install reads the sha256 with the user's token, rebuilds the
//! pointer, and goes on only when its id is the pinned one; the download is
//! then held against that sha256 like every other file of the app.
//!
//! Where it was read:
//!   - the code: <https://github.com/Stability-AI/stable-fast-3d> at
//!     `SOURCE_COMMIT` (head of `main` since 22.01.2025)
//!   - the weights, gated: <https://huggingface.co/stabilityai/stable-fast-3d>
//!     at `REVISION` (tree listing: sizes and object ids)
//!   - the DINOv2 config, Apache 2.0, not gated:
//!     <https://huggingface.co/facebook/dinov2-large> at `DINO_REVISION`

use crate::commands::mesh3d::{self, Engine};
use crate::commands::voice_loop::manifest::RemoteFile;
use crate::commands::{internal, not_found};
use crate::install_state::InstallSlot;
use crate::os_error;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

// ── The pins ──────────────────────────────────────────────────────────

pub(crate) const MODEL_ID: &str = "sf3d";
pub(crate) const MODEL_NAME: &str = "Stable Fast 3D";

/// The head of `main` on 13.11.2026, last changed 22.01.2025.
pub(crate) const SOURCE_COMMIT: &str = "ff21fc491b4dc5314bf6734c7c0dabd86b5f5bb2";
const SOURCE: &str = "https://github.com/Stability-AI/stable-fast-3d/archive";
const SOURCE_BYTES: u64 = 25_450_752;
const SOURCE_SHA256: &str = "3674ecf09167764be5471a803cf716b390feccbedc389d8c37aa710b754e2808";

pub(crate) const REPO: &str = "stabilityai/stable-fast-3d";
pub(crate) const REVISION: &str = "f0c9a8ffd62cb1bbc8a7a53c9f87a0be1b6be778";
const CONFIG_BYTES: u64 = 2405;
/// The git blob id of `config.yaml` at `REVISION`.
const CONFIG_BLOB: &str = "4a44aec5e6af76975afcaedae7e888b96412c832";
const WEIGHTS_FILE_BYTES: u64 = 4_024_289_892;
/// The git blob id of the LFS pointer of `model.safetensors` at `REVISION`.
const WEIGHTS_POINTER_BLOB: &str = "d4d83a9c711ace2e5adccf27c7c5e386725acfe2";

const DINO_REPO: &str = "facebook/dinov2-large";
const DINO_REVISION: &str = "47b73eefe95e8d44ec3623f8890bd894b6ea2d6c";
const DINO_CONFIG_BYTES: u64 = 549;
const DINO_CONFIG_SHA256: &str = "12df51c069a2dc1305e34ba71ef58bc2407ea553b75f4722a1715c1bce3bbed0";

pub(crate) const WEIGHTS_BYTES: u64 = WEIGHTS_FILE_BYTES + CONFIG_BYTES + DINO_CONFIG_BYTES;

/// Every package the runner pulls in, resolved by pip for Python 3.12 on
/// Apple Silicon as wheels only (13.11.2026), 39 from PyPI. What TripoSR's
/// venv has stands at its versions, so pip's cache serves both. New against
/// it: torchvision (the build of torch 2.10.0), open-clip-torch 2.24.0 (the
/// version SF3D names) with ftfy, protobuf, sentencepiece, timm and wcwidth,
/// and jaxtyping with wadler-lindig. Releases younger than a month stand one
/// or two back (sentencepiece, timm, wcwidth, wadler-lindig, protobuf).
/// scipy is there for trimesh's normals in the GLB export.
pub(crate) const PINNED: [&str; 39] = [
    "certifi==2026.1.4", "charset-normalizer==3.4.4", "einops==0.8.2", "filelock==3.20.3", "fsspec==2026.1.0",
    "ftfy==6.3.1", "hf-xet==1.2.0", "huggingface-hub==0.36.0", "idna==3.11", "jaxtyping==0.3.11",
    "jinja2==3.1.6", "markupsafe==3.0.3", "mpmath==1.3.0", "networkx==3.6.1", "numpy==2.3.5",
    "omegaconf==2.4.0", "open-clip-torch==2.24.0", "packaging==26.0", "pillow==12.1.0", "protobuf==7.36.1",
    "pyyaml==6.0.3", "regex==2026.1.15", "requests==2.32.5", "safetensors==0.7.0", "scipy==1.17.0",
    "sentencepiece==0.2.2", "setuptools==71.1.0", "sympy==1.14.0", "timm==1.0.29", "tokenizers==0.22.2",
    "torch==2.10.0", "torchvision==0.25.0", "tqdm==4.67.1", "transformers==4.57.6", "trimesh==5.1.1",
    "typing-extensions==4.15.0", "urllib3==2.6.3", "wadler-lindig==0.1.7", "wcwidth==0.8.5",
];

const MODULE: &str = "torch, torchvision, transformers, open_clip, jaxtyping, omegaconf, trimesh, texture_baker, uv_unwrapper";

/// One wheel LU built: its file name, its bytes and their sha256.
pub(crate) struct Wheel {
    pub name: &'static str,
    pub bytes: &'static [u8],
    pub sha256: &'static str,
}

/// The two extensions, built by `scripts/build-sf3d-wheels.sh` on 13.11.2026.
#[cfg(target_os = "macos")]
pub(crate) const WHEELS: [Wheel; 2] = [
    Wheel {
        name: "texture_baker-0.0.1-cp312-cp312-macosx_14_0_arm64.whl",
        bytes: include_bytes!("../../resources/mesh3d/wheels/texture_baker-0.0.1-cp312-cp312-macosx_14_0_arm64.whl"),
        sha256: "b415a0b88f478755179d4a3e1637415af10e078fb5baf8457ec6abe0cdfc0529",
    },
    Wheel {
        name: "uv_unwrapper-0.0.1-cp312-cp312-macosx_14_0_arm64.whl",
        bytes: include_bytes!("../../resources/mesh3d/wheels/uv_unwrapper-0.0.1-cp312-cp312-macosx_14_0_arm64.whl"),
        sha256: "8fd84a82fa22d8d72cd87196d123ec60afe25d8e83b6f349ec5befe796fdbf75",
    },
];

/// Only a Mac carries the wheels; elsewhere the install is refused before.
#[cfg(not(target_os = "macos"))]
pub(crate) const WHEELS: [Wheel; 0] = [];

/// The venv and the wheels on disk, with room for what pip unpacks.
const ENGINE_INSTALL_BYTES: u64 = 2_000_000_000;

/// Below this a run is refused. The README names about 6 GB of graphics
/// memory and says MPS takes more than that; not measured yet on a Mac.
pub(crate) const MIN_RAM_GB: u32 = 16;

/// The texture side per step of Detail (`TEXTURES` of the runner).
const DEFAULT_TEXTURE: u32 = 1024;
const TEXTURES: [u32; 3] = [512, 1024, 2048];

/// What the licence asks to be kept with the code that is passed on.
pub(crate) const NOTICE: &str = "This Stability AI Model is licensed under the Stability AI Community License, Copyright © Stability AI Ltd. All Rights Reserved.\n";

pub(crate) const RUNNER: &str = include_str!("../../resources/mesh3d/run_sf3d.py");

// ── Where it lives ────────────────────────────────────────────────────

/// A folder of its own beside TripoSR's, with the same layout inside
/// (`venv`, `weights`, `work`, `downloads`), so `mesh3d.rs` runs it the same way.
pub(crate) fn root() -> PathBuf {
    crate::os_paths::data_dir().join("mesh3d-sf3d")
}

fn source_dir(root: &Path) -> PathBuf {
    root.join("source").join(SOURCE_COMMIT)
}

fn wheels_dir(root: &Path) -> PathBuf {
    root.join("wheels")
}

pub(crate) fn runner_file(root: &Path) -> PathBuf {
    root.join("runner").join("run_sf3d.py")
}

// ── The engine ────────────────────────────────────────────────────────

fn stamp() -> String {
    let wheels: Vec<&str> = WHEELS.iter().map(|w| w.sha256).collect();
    format!("{}\n{}", PINNED.join("\n"), wheels.join("\n"))
}

fn engine(root: &Path, wheels: &[PathBuf]) -> EngineSpec {
    EngineSpec { stamp: stamp(), stamp_file: mesh3d::venv_dir(root).join(".lu-mesh3d-sf3d-engine"), wheels: wheels.to_vec() }
}

/// The parts of `Engine` that are owned, so it can be built on the fly.
struct EngineSpec {
    stamp: String,
    stamp_file: PathBuf,
    wheels: Vec<PathBuf>,
}

impl EngineSpec {
    fn as_engine(&self) -> Engine<'_> {
        Engine { pinned: &PINNED, wheels: &self.wheels, module: MODULE, stamp: self.stamp.clone(), stamp_file: self.stamp_file.clone() }
    }
}

fn engine_ready_at(root: &Path) -> bool {
    engine(root, &[]).as_engine().ready(&mesh3d::venv_dir(root))
}

/// Write the wheels of this build next to the venv and check them.
fn write_wheels(root: &Path) -> Result<Vec<PathBuf>, String> {
    let dir = wheels_dir(root);
    std::fs::create_dir_all(&dir).map_err(|e| os_error::english(&e))?;
    let mut paths = Vec::new();
    for wheel in &WHEELS {
        let path = dir.join(wheel.name);
        std::fs::write(&path, wheel.bytes).map_err(|e| os_error::english(&e))?;
        let actual = crate::commands::install::sha256_file(&path)?;
        if !crate::commands::install::digest_matches(wheel.sha256, &actual) {
            let _ = std::fs::remove_file(&path);
            return Err(format!("The 3D engine part {} is damaged in this copy of LU. Install LU again.", wheel.name));
        }
        paths.push(path);
    }
    Ok(paths)
}

fn ensure_engine(slot: &InstallSlot, root: &Path) -> Result<String, String> {
    let venv = mesh3d::venv_dir(root);
    if engine_ready_at(root) {
        return Ok(mesh3d::venv_python(&venv).to_string_lossy().to_string());
    }
    let wheels = write_wheels(root)?;
    let spec = engine(root, &wheels);
    mesh3d::ensure_engine_with(slot, None, &venv, &spec.as_engine())
}

// ── The source ────────────────────────────────────────────────────────

fn source_remote() -> RemoteFile {
    RemoteFile { url: format!("{SOURCE}/{SOURCE_COMMIT}.zip"), size: SOURCE_BYTES, sha256: SOURCE_SHA256.to_string() }
}

const SOURCE_MARKER: &str = ".lu-sf3d-source";

fn source_ready_at(root: &Path) -> bool {
    let dir = source_dir(root);
    dir.join("sf3d").join("system.py").is_file()
        && dir.join("load").join("tets").join("160_tets.npz").is_file()
        && std::fs::read_to_string(dir.join(SOURCE_MARKER)).is_ok_and(|s| s.trim() == SOURCE_SHA256)
}

/// What is kept of the archive: the Python files of `sf3d/`, the grids of
/// `load/tets/`, and the licence. Not the extensions' sources (LU ships
/// them built), not the demo, the Gradio app, the ComfyUI node or `run.py`.
fn kept_entry(name: &str) -> Option<PathBuf> {
    let top = format!("stable-fast-3d-{SOURCE_COMMIT}/");
    let rest = name.strip_prefix(&top)?;
    let path = Path::new(rest);
    if path.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return None;
    }
    let keep = rest == "LICENSE.md"
        || (rest.starts_with("sf3d/") && rest.ends_with(".py"))
        || (rest.starts_with("load/tets/") && rest.ends_with(".npz"));
    keep.then(|| path.to_path_buf())
}

fn unpack_source(archive: &Path, root: &Path) -> Result<(), String> {
    let target = source_dir(root);
    let staging = target.with_extension("unpack");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| os_error::english(&e))?;
    let file = std::fs::File::open(archive).map_err(|e| os_error::english(&e))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("The Stable Fast 3D archive could not be read ({e})."))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("The Stable Fast 3D archive could not be read ({e})."))?;
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
    }
    if !staging.join("sf3d").join("system.py").is_file() || !staging.join("LICENSE.md").is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("The Stable Fast 3D archive is not complete. Start the download again.".to_string());
    }
    std::fs::write(staging.join("NOTICE"), NOTICE).map_err(|e| os_error::english(&e))?;
    std::fs::write(staging.join(SOURCE_MARKER), SOURCE_SHA256).map_err(|e| os_error::english(&e))?;
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&staging, &target).map_err(|e| os_error::english(&e))?;
    Ok(())
}

fn install_source(slot: &InstallSlot, root: &Path) -> Result<(), String> {
    if source_ready_at(root) {
        return Ok(());
    }
    slot.log(format!("downloading the Stable Fast 3D source at {}", &SOURCE_COMMIT[..7]));
    let archive = mesh3d::downloads_dir(root).join(format!("stable-fast-3d-{SOURCE_COMMIT}.zip"));
    mesh3d::fetch_files_as(slot, &[(source_remote(), archive.clone())], "the Stable Fast 3D source", None)?;
    unpack_source(&archive, root)?;
    let _ = std::fs::remove_file(&archive);
    Ok(())
}

// ── The weights ───────────────────────────────────────────────────────

/// The id git gives `content` as a blob: sha1 of `blob <len>\0<content>`.
pub(crate) fn git_blob_id(content: &[u8]) -> String {
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", content.len()).as_bytes());
    hasher.update(content);
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The LFS pointer git keeps for a file of `size` bytes with `sha256`.
fn lfs_pointer(sha256: &str, size: u64) -> String {
    format!("version https://git-lfs.github.com/spec/v1\noid sha256:{sha256}\nsize {size}\n")
}

/// Whether `sha256` is the digest the pinned pointer names.
pub(crate) fn weights_digest_is_pinned(sha256: &str) -> bool {
    sha256.len() == 64
        && sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        && git_blob_id(lfs_pointer(sha256, WEIGHTS_FILE_BYTES).as_bytes()) == WEIGHTS_POINTER_BLOB
}

/// `config.yaml` is this revision's when its size and blob id match.
pub(crate) fn config_is_pinned(content: &[u8]) -> bool {
    content.len() as u64 == CONFIG_BYTES && git_blob_id(content) == CONFIG_BLOB
}

#[derive(Deserialize)]
struct TreeEntry {
    path: String,
    size: u64,
    #[serde(default)]
    lfs: Option<TreeLfs>,
}

#[derive(Deserialize)]
struct TreeLfs {
    oid: String,
}

/// The sha256 of `model.safetensors` out of the hub's tree listing at the
/// pinned revision, accepted only when it is the one the pointer names.
pub(crate) fn weights_digest_from_tree(listing: &str) -> Result<String, String> {
    let entries: Vec<TreeEntry> =
        serde_json::from_str(listing).map_err(|_| "Hugging Face sent an answer this version of LU cannot read. Try again later.".to_string())?;
    let entry = entries
        .iter()
        .find(|e| e.path == "model.safetensors" && e.size == WEIGHTS_FILE_BYTES)
        .ok_or("The Stable Fast 3D files on Hugging Face are not the ones this version of LU knows.")?;
    let oid = entry.lfs.as_ref().map(|l| l.oid.as_str()).unwrap_or("");
    if weights_digest_is_pinned(oid) {
        return Ok(oid.to_string());
    }
    // The hub hides the digest of a gated file from an account that has not
    // accepted the licence.
    if oid.contains('*') || oid.is_empty() {
        return Err(crate::commands::mlx::hub_denied_message(403, true).unwrap_or_default().to_string());
    }
    Err("The Stable Fast 3D weights on Hugging Face do not match the ones this version of LU knows. Nothing was downloaded.".to_string())
}

/// GET a small hub file with the user's token, into memory.
fn hub_get(url: &str, token: &str) -> Result<Vec<u8>, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("The download could not be started: {}.", os_error::io_english(&e)))?;
    let client = crate::commands::voice_loop::fetch::http_client()?;
    runtime.block_on(async {
        let answer = client
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| "Hugging Face could not be reached. Check your internet connection and start the setup again.".to_string())?;
        let status = answer.status().as_u16();
        if let Some(why) = crate::commands::mlx::hub_denied_message(status, true) {
            return Err(why.to_string());
        }
        if !answer.status().is_success() {
            return Err(format!("Hugging Face refused the download of Stable Fast 3D (HTTP {status}). Try again later."));
        }
        answer.bytes().await.map(|b| b.to_vec()).map_err(|_| "The download from Hugging Face was interrupted. Start the setup again.".to_string())
    })
}

fn hub(repo: &str, revision: &str, file: &str) -> String {
    format!("https://huggingface.co/{repo}/resolve/{revision}/{file}")
}

const MANIFEST: &str = ".lu-mesh3d-sf3d-weights.json";

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Manifest {
    revision: String,
    dino_revision: String,
}

fn this_manifest() -> Manifest {
    Manifest { revision: REVISION.to_string(), dino_revision: DINO_REVISION.to_string() }
}

const WEIGHT_PATHS: [(&str, u64); 3] =
    [("model.safetensors", WEIGHTS_FILE_BYTES), ("config.yaml", CONFIG_BYTES), ("dinov2-large/config.json", DINO_CONFIG_BYTES)];

fn weights_complete(dir: &Path) -> bool {
    let manifest = std::fs::read_to_string(dir.join(MANIFEST)).ok().and_then(|s| serde_json::from_str::<Manifest>(&s).ok());
    manifest.is_some_and(|m| m == this_manifest())
        && WEIGHT_PATHS.iter().all(|(path, size)| std::fs::metadata(dir.join(path)).map(|m| m.is_file() && m.len() == *size).unwrap_or(false))
}

pub(crate) fn installed_at(root: &Path) -> bool {
    engine_ready_at(root) && source_ready_at(root) && weights_complete(&mesh3d::weights_dir(root))
}

fn bytes_to_fetch(root: &Path) -> u64 {
    let dir = mesh3d::weights_dir(root);
    let weights = if weights_complete(&dir) { 0 } else { WEIGHTS_BYTES.saturating_sub(crate::install_state::dir_size(&dir)) };
    let source = if source_ready_at(root) { 0 } else { SOURCE_BYTES };
    weights + source + if engine_ready_at(root) { 0 } else { ENGINE_INSTALL_BYTES }
}

fn install_weights(slot: &InstallSlot, root: &Path, token: &str) -> Result<(), String> {
    let dir = mesh3d::weights_dir(root);
    if weights_complete(&dir) {
        slot.log("the weights of Stable Fast 3D are on disk already");
        return Ok(());
    }
    std::fs::create_dir_all(&dir).map_err(|e| os_error::english(&e))?;
    let _ = std::fs::remove_file(dir.join(MANIFEST));

    slot.log(format!("checking {REPO} at {}", &REVISION[..7]));
    let listing = hub_get(&format!("https://huggingface.co/api/models/{REPO}/tree/{REVISION}"), token)?;
    let sha256 = weights_digest_from_tree(&String::from_utf8_lossy(&listing))?;
    let config = hub_get(&hub(REPO, REVISION, "config.yaml"), token)?;
    if !config_is_pinned(&config) {
        return Err("The Stable Fast 3D settings on Hugging Face do not match the ones this version of LU knows. Nothing was downloaded.".to_string());
    }
    std::fs::write(dir.join("config.yaml"), &config).map_err(|e| os_error::english(&e))?;

    slot.log(format!("downloading {REPO} ({})", crate::commands::mlx_snapshot::human_bytes(WEIGHTS_BYTES)));
    let files = [
        (RemoteFile { url: hub(REPO, REVISION, "model.safetensors"), size: WEIGHTS_FILE_BYTES, sha256 }, dir.join("model.safetensors")),
        (
            RemoteFile { url: hub(DINO_REPO, DINO_REVISION, "config.json"), size: DINO_CONFIG_BYTES, sha256: DINO_CONFIG_SHA256.to_string() },
            dir.join("dinov2-large").join("config.json"),
        ),
    ];
    mesh3d::fetch_files_as(slot, &files, "the Stable Fast 3D model", Some(token))?;
    let record = serde_json::to_string(&this_manifest()).unwrap_or_default();
    std::fs::write(dir.join(MANIFEST), record).map_err(|e| os_error::english(&e))?;
    Ok(())
}

fn self_test(slot: &InstallSlot, python: &str, root: &Path) -> Result<(), String> {
    let runner = mesh3d::write_runner_at(&runner_file(root), RUNNER)?;
    let work = mesh3d::work_dir(root);
    std::fs::create_dir_all(&work).map_err(|e| os_error::english(&e))?;
    let out = work.join("selftest.glb");
    let mut cmd = crate::python::python_command(python);
    cmd.arg("-I").arg(&runner).arg("--lu-mesh3d-selftest").arg(&out).arg("--source").arg(source_dir(root));
    cmd.current_dir(&work).env("HF_HUB_OFFLINE", "1").env("PYTORCH_ENABLE_MPS_FALLBACK", "1");
    crate::commands::video::run_streamed(slot, &mut cmd).map_err(|e| format!("The 3D engine did not pass its self test. {e}"))?;
    let _ = std::fs::remove_file(&out);
    Ok(())
}

/// The whole install on the slot: the token first (nothing is fetched
/// without it), then engine, source, self test and weights.
pub(crate) fn install(slot: &InstallSlot, root: &Path, token: &str) -> Result<String, String> {
    let python = ensure_engine(slot, root)?;
    install_source(slot, root)?;
    self_test(slot, &python, root)?;
    install_weights(slot, root, token)?;
    if !installed_at(root) {
        return Err("The download finished, but the model is not complete on disk. Start it again.".to_string());
    }
    Ok(format!("{MODEL_ID} installed"))
}

/// What the install still has to write, and the note for the free-space check.
pub(crate) fn install_need(root: &Path) -> (u64, &'static str) {
    (bytes_to_fetch(root), if engine_ready_at(root) { "" } else { "incl. its own 3D engine" })
}

pub(crate) fn delete_at(root: &Path) -> Result<(), String> {
    let dir = mesh3d::weights_dir(root);
    if !dir.is_dir() {
        return Err(not_found(format!("{MODEL_ID} is not installed")));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| internal(format!("delete {MODEL_ID}: {}", os_error::english(&e))))?;
    let _ = std::fs::remove_dir_all(mesh3d::downloads_dir(root));
    Ok(())
}

// ── The card and the run ──────────────────────────────────────────────

const DESCRIPTION: &str = "Turns one picture of an object into a 3D model with a painted texture, on this Mac. The download is the official Stable Fast 3D release.";

/// The short, human words of the licence, shown before the setup.
pub(crate) const LICENSE_TEXT: &str = "Stable Fast 3D comes under the Stability AI Community License. It is free for personal use, research, and for people and companies that earn less than one million dollars a year; businesses register with Stability AI first. Sexual content is not allowed under its use policy. To download it, accept the licence on the model's Hugging Face page and add your Hugging Face token in Settings. Powered by Stability AI.";

pub(crate) const LICENSE_URL: &str = "https://huggingface.co/stabilityai/stable-fast-3d";

pub(crate) fn model_json(installed: bool, has_token: bool) -> Value {
    json!({
        "id": MODEL_ID,
        "name": MODEL_NAME,
        "repo": REPO,
        "sizeGB": ((WEIGHTS_BYTES as f64) / 1e8).round() / 10.0,
        "minRamGB": MIN_RAM_GB,
        "unfiltered": false,
        "description": DESCRIPTION,
        "installed": installed,
        "gated": true,
        "hasToken": has_token,
        "license": "Stability AI Community License",
        "licenseText": LICENSE_TEXT,
        "licenseUrl": LICENSE_URL,
        "engineCommit": SOURCE_COMMIT,
    })
}

/// The texture side a run uses: one of the three the runner knows.
pub(crate) fn texture_for(asked: Option<u32>) -> u32 {
    asked.filter(|t| TEXTURES.contains(t)).unwrap_or(DEFAULT_TEXTURE)
}

/// What the runner reads, one file per run.
pub(crate) fn job_json(root: &Path, image: &Path, texture: u32, job_dir: &Path, output: &Path) -> Value {
    let weights = mesh3d::weights_dir(root);
    json!({
        "image": image,
        "source": source_dir(root),
        "weights_dir": weights,
        "dino_config": weights.join("dinov2-large").join("config.json"),
        "texture": texture,
        "foreground_ratio": 0.85,
        "device": "auto",
        "work": job_dir,
        "output": output,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_source_and_the_weights_are_pinned() {
        let hex = |s: &str, n: usize| s.len() == n && s.chars().all(|c| c.is_ascii_hexdigit());
        assert!(hex(SOURCE_COMMIT, 40) && hex(REVISION, 40) && hex(DINO_REVISION, 40) && hex(CONFIG_BLOB, 40) && hex(WEIGHTS_POINTER_BLOB, 40));
        assert!(hex(SOURCE_SHA256, 64) && hex(DINO_CONFIG_SHA256, 64));
        assert_eq!(source_remote().url, format!("https://github.com/Stability-AI/stable-fast-3d/archive/{SOURCE_COMMIT}.zip"));
        assert_eq!(model_json(false, false)["sizeGB"], 4.0);
        assert_eq!(model_json(false, false)["unfiltered"], false);
        for url in [hub(REPO, REVISION, "model.safetensors"), hub(DINO_REPO, DINO_REVISION, "config.json")] {
            assert!(url.starts_with("https://huggingface.co/") && !url.contains("/main/"), "{url}");
        }
    }

    #[test]
    fn every_package_is_pinned_and_shared_ones_match_triposr() {
        let mut names: Vec<&str> = PINNED.iter().map(|s| s.split("==").next().unwrap()).collect();
        for spec in &PINNED {
            let (name, version) = spec.split_once("==").unwrap_or_else(|| panic!("{spec} is not pinned"));
            assert!(!name.is_empty() && !version.contains(['<', '>', '*', ' ']), "{spec}");
        }
        let sorted = names.clone();
        names.sort();
        assert_eq!(names, sorted, "kept in order");
        names.dedup();
        assert_eq!(names.len(), PINNED.len());
        for shared in mesh3d::PINNED_FOR_TESTS {
            let name = shared.split("==").next().unwrap();
            if let Some(ours) = PINNED.iter().find(|p| p.split("==").next() == Some(name)) {
                assert_eq!(ours, shared, "the same wheel as TripoSR");
            }
        }
        for never in ["rembg", "gpytoolbox", "pynanoinstantmeshes", "onnxruntime", "gradio", "texture-baker", "uv-unwrapper"] {
            assert!(!PINNED.iter().any(|p| p.starts_with(&format!("{never}=="))), "{never}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_wheels_in_the_binary_are_the_ones_pinned() {
        use sha2::{Digest, Sha256};
        for wheel in &WHEELS {
            let digest: String = Sha256::digest(wheel.bytes).iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(digest, wheel.sha256, "{}", wheel.name);
            assert!(wheel.name.ends_with("-cp312-cp312-macosx_14_0_arm64.whl"), "{}", wheel.name);
            assert_eq!(&wheel.bytes[..2], b"PK", "a wheel is a zip");
        }
        let tmp = tempfile::tempdir().unwrap();
        let written = write_wheels(tmp.path()).unwrap();
        assert_eq!(written.len(), 2);
        assert!(engine(tmp.path(), &written).as_engine().pip_args().iter().any(|a| a.ends_with("texture_baker-0.0.1-cp312-cp312-macosx_14_0_arm64.whl")));
    }

    #[test]
    fn a_git_blob_id_is_the_one_git_computes() {
        // `printf 'hello\n' | git hash-object --stdin`
        assert_eq!(git_blob_id(b"hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
        assert_eq!(git_blob_id(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
        // The pointer of TripoSR's `model.ckpt`, whose digest the hub shows to
        // everyone: its rebuilt pointer has the object id of the tree listing.
        let pointer = lfs_pointer("429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee", 1_677_246_742);
        assert_eq!(git_blob_id(pointer.as_bytes()), "f78322668f0723c948059fe36edd9d1d815b7071");
    }

    #[test]
    fn only_the_digest_the_pointer_names_is_taken() {
        assert!(!weights_digest_is_pinned(&"0".repeat(64)));
        assert!(!weights_digest_is_pinned("*".repeat(64).as_str()));
        assert!(!weights_digest_is_pinned("abc"));
        let masked = format!("[{{\"type\":\"file\",\"path\":\"model.safetensors\",\"size\":{WEIGHTS_FILE_BYTES},\"lfs\":{{\"oid\":\"{}\"}}}}]", "*".repeat(64));
        assert!(weights_digest_from_tree(&masked).unwrap_err().contains("accept its terms"), "a gated answer reads as a licence not yet accepted");
        let wrong = format!("[{{\"type\":\"file\",\"path\":\"model.safetensors\",\"size\":{WEIGHTS_FILE_BYTES},\"lfs\":{{\"oid\":\"{}\"}}}}]", "a".repeat(64));
        assert!(weights_digest_from_tree(&wrong).unwrap_err().contains("do not match"));
        let other_size = "[{\"type\":\"file\",\"path\":\"model.safetensors\",\"size\":5,\"lfs\":{\"oid\":\"x\"}}]";
        assert!(weights_digest_from_tree(other_size).unwrap_err().contains("not the ones"));
        assert!(weights_digest_from_tree("<html>").is_err());
        assert!(!config_is_pinned(b"cond_image_size: 512\n"));
    }

    #[test]
    fn only_the_package_the_tets_and_the_licence_are_taken_from_the_archive() {
        let top = format!("stable-fast-3d-{SOURCE_COMMIT}/");
        for (name, kept) in [
            ("sf3d/system.py", true),
            ("sf3d/models/tokenizers/dinov2.py", true),
            ("load/tets/160_tets.npz", true),
            ("LICENSE.md", true),
            ("run.py", false),
            ("gradio_app.py", false),
            ("texture_baker/setup.py", false),
            ("uv_unwrapper/uv_unwrapper/csrc/bvh.cpp", false),
            ("comfyui/nodes.py", false),
            ("sf3d/../../x.py", false),
            ("demo_files/x.png", false),
        ] {
            assert_eq!(kept_entry(&format!("{top}{name}")).is_some(), kept, "{name}");
        }
        assert_eq!(kept_entry("stable-fast-3d-main/sf3d/system.py"), None);
    }

    #[test]
    fn an_archive_is_unpacked_with_the_notice_or_not_at_all() {
        use std::io::Write;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let zip_path = root.join("a.zip");
        let write = |names: &[&str]| {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
            for name in names {
                zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
                zip.write_all(b"x").unwrap();
            }
            zip.finish().unwrap();
        };
        let top = format!("stable-fast-3d-{SOURCE_COMMIT}");
        write(&[&format!("{top}/sf3d/system.py")]);
        assert!(unpack_source(&zip_path, root).is_err(), "no licence, no source");
        write(&[&format!("{top}/sf3d/system.py"), &format!("{top}/LICENSE.md"), &format!("{top}/load/tets/160_tets.npz"), &format!("{top}/run.py")]);
        unpack_source(&zip_path, root).unwrap();
        assert!(source_ready_at(root));
        assert_eq!(std::fs::read_to_string(source_dir(root).join("NOTICE")).unwrap(), NOTICE);
        assert!(!source_dir(root).join("run.py").exists());
    }

    #[test]
    fn installed_is_engine_source_and_weights_and_remove_takes_the_weights() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert!(!installed_at(root));
        assert_eq!(bytes_to_fetch(root), WEIGHTS_BYTES + SOURCE_BYTES + ENGINE_INSTALL_BYTES);
        let dir = mesh3d::weights_dir(root);
        for (path, size) in WEIGHT_PATHS {
            crate::test_support::sized_file(&dir.join(path), size);
        }
        assert!(!weights_complete(&dir), "no manifest, no model");
        std::fs::write(dir.join(MANIFEST), serde_json::to_string(&this_manifest()).unwrap()).unwrap();
        assert!(weights_complete(&dir));
        let venv = mesh3d::venv_dir(root);
        crate::test_support::sized_file(&mesh3d::venv_python(&venv), 1);
        std::fs::write(venv.join(".lu-mesh3d-sf3d-engine"), stamp()).unwrap();
        assert!(!installed_at(root), "no source");
        for f in ["sf3d/system.py", "load/tets/160_tets.npz"] {
            crate::test_support::sized_file(&source_dir(root).join(f), 3);
        }
        std::fs::write(source_dir(root).join(SOURCE_MARKER), SOURCE_SHA256).unwrap();
        assert!(installed_at(root));
        assert_eq!(bytes_to_fetch(root), 0);
        delete_at(root).unwrap();
        assert!(!installed_at(root) && engine_ready_at(root) && source_ready_at(root));
    }

    #[test]
    fn the_job_carries_what_the_runner_reads() {
        let job = job_json(Path::new("/d/mesh3d-sf3d"), Path::new("/s/a.png"), 1024, Path::new("/d/w/j"), Path::new("/c/3d/r.glb"));
        for key in ["image", "source", "weights_dir", "dino_config", "texture", "foreground_ratio", "work", "output"] {
            assert!(RUNNER.contains(&format!("job[\"{key}\"]")), "the runner does not read {key}");
            assert!(!job[key].is_null(), "{key}");
        }
        assert_eq!(texture_for(None), 1024);
        assert_eq!(texture_for(Some(2048)), 2048);
        assert_eq!(texture_for(Some(4096)), 1024, "only what the runner offers");
    }

    #[test]
    fn the_runner_replaces_what_a_mac_cannot_install_and_stays_offline() {
        for needed in [
            "sys.modules[name] = refusing_module",
            "\"rembg\"",
            "\"gpytoolbox\"",
            "\"pynanoinstantmeshes\"",
            "kwargs[\"pretrained\"] = None",
            "Dinov2Config.from_json_file",
            "unwrap_on_the_cpu()",
            "remesh=\"none\"",
            "PREFIX = \"LU-MESH3D \"",
            "JOB_FLAG = \"--lu-mesh3d-job\"",
        ] {
            assert!(RUNNER.contains(needed), "{needed}");
        }
        for never in ["rembg.new_session()", "hf_hub_download(", "snapshot_download", "requests.get", "urllib", "torch.load("] {
            assert!(!RUNNER.contains(never), "{never}");
        }
        assert!(RUNNER.contains(&format!("DINO_REPO = \"{DINO_REPO}\"")));
    }

    #[test]
    fn the_licence_is_said_before_the_setup_in_plain_words() {
        let card = model_json(false, false);
        assert_eq!(card["gated"], true);
        let text = card["licenseText"].as_str().unwrap();
        for needed in ["Stability AI Community License", "one million dollars", "Hugging Face token", "Powered by Stability AI"] {
            assert!(text.contains(needed), "{needed}");
        }
        assert!(!text.contains('$'), "no money signs in the tree");
        assert!(NOTICE.starts_with("This Stability AI Model is licensed under the Stability AI Community License"));
    }
}
