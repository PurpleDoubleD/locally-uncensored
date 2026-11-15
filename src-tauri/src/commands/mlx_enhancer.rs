//! The Qwen-Image 2.1 prompt enhancer on a Mac (GH #148).
//!
//! Windows runs the two official enhancers as text encoder files in ComfyUI
//! (`src/api/qwen-enhancer.ts`). The Mac has no ComfyUI. It runs the MLX
//! editions of the same two models through `mlx_vlm`, which the video engine's
//! venv carries at 0.6.3 (`video::MLX_VIDEO_PINNED`) and which knows their
//! architecture (`mlx_vlm/models/qwen3_5`).
//!
//! Read off the sources on 14.10.2026, metadata only:
//!   - `Qwen/Qwen-Image-2.1-PE-T2I` and `-PE-I2I`: the official enhancers,
//!     `Qwen3_5ForConditionalGeneration`, 9B, Qwen Research License.
//!   - `prithivMLmods/Qwen-Image-2.1-PE-T2I-MLX` and `-PE-I2I-MLX`: both
//!     converted to MLX, with a `4bit` folder each (affine, group size 64,
//!     `model_type` `qwen3_5`, card `base_model` the official repository).
//!     The commits and the byte counts below are what the hub listed for
//!     `/api/models/<repo>/revision/main` and `/tree/<sha>/4bit` that day.
//!   - Of the editions without refusals there is no MLX conversion that can
//!     be loaded: `groxaxo/Qwen-Image-2.1-PE-I2I-Heretic-MLX-*` holds nothing
//!     but `.gitattributes`, and there is none at all for text to image. The
//!     Mac offers the official edition alone.
//!
//! How a run is built was read from `mlx_vlm` 0.6.3 in that venv
//! (`generate/dispatch.py`, `generate/ar.py`, `prompt_utils.py`, `utils.py`)
//! and from the `chat_template.jinja` of the 4-bit folder. No model was loaded
//! for it yet; `the_enhancer_rewrites_a_prompt_on_this_mac` below is the run.
//!
//! One model in memory at a time: a run takes the one place image generations
//! take (`mflux::run_in_place`), so an image cannot start beside it, the
//! sidecar's model is unloaded before it starts, and its process ends with it.

use super::mflux::{self, Manifest, ManifestFile};
use super::{fetch_repo_listing, ensure_image_engine_supported, memory_verdict, total_memory_bytes};
use crate::commands::CmdResult;
use crate::install_state::InstallSlot;
use crate::os_error;
use crate::state::AppState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// What a rewrite is for: a new picture, or an edit of the pictures it reads.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Mode {
    T2i,
    I2i,
}

impl Mode {
    const fn name(self) -> &'static str {
        match self {
            Mode::T2i => "t2i",
            Mode::I2i => "i2i",
        }
    }
}

/// One enhancer of the catalogue.
#[derive(Debug)]
pub(super) struct Enhancer {
    /// The catalogue id. It carries `qwen-image-2.1-pe-t2i` or `-i2i`, the
    /// name `lib/render/qwen-enhancer.ts` knows an enhancer by.
    pub id: &'static str,
    pub name: &'static str,
    pub repo: &'static str,
    /// The commit the files are fetched at.
    pub revision: &'static str,
    /// The folder of the repository that is fetched and loaded. The rest of
    /// the repository (full precision, 8-bit) stays on the hub.
    pub folder: &'static str,
    /// What that folder holds at `revision`, as the hub lists it.
    pub bytes: u64,
    pub mode: Mode,
    /// Memory the Mac needs. The 4-bit model takes about 6 GB and runs
    /// before Qwen-Image 2.1, which asks for 16.
    pub min_ram_gb: u32,
    pub description: &'static str,
}

pub(super) const ENHANCERS: &[Enhancer] = &[
    Enhancer {
        id: "qwen-image-2.1-pe-t2i-4bit",
        name: "Qwen-Image 2.1 Prompt Enhancer 4-bit",
        repo: "prithivMLmods/Qwen-Image-2.1-PE-T2I-MLX",
        revision: "2d26ac502b16396fdd4b0cc21cc667831a7f6454",
        folder: "4bit",
        bytes: 5_970_346_649,
        mode: Mode::T2i,
        min_ram_gb: 16,
        description: "The official Qwen prompt enhancer for Qwen-Image 2.1, quantized to 4-bit for MLX. With Improve my prompt on, it rewrites your prompt into the long description the model was trained on, on this Mac, before the picture starts. Research license, non-commercial use only.",
    },
    Enhancer {
        id: "qwen-image-2.1-pe-i2i-4bit",
        name: "Qwen-Image 2.1 Edit Prompt Enhancer 4-bit",
        repo: "prithivMLmods/Qwen-Image-2.1-PE-I2I-MLX",
        revision: "75172ef3e7b681eae8f82b9ca20f81885557018d",
        folder: "4bit",
        bytes: 5_970_346_537,
        mode: Mode::I2i,
        min_ram_gb: 16,
        description: "The official Qwen edit prompt enhancer for Qwen-Image 2.1, quantized to 4-bit for MLX. With Improve my prompt on in Edit, it looks at the images and rewrites your instruction before the edit starts. Research license, non-commercial use only.",
    },
];

pub(super) fn lookup(id: &str) -> Option<&'static Enhancer> {
    ENHANCERS.iter().find(|e| e.id == id)
}

/// The family `mlx_image_models` lists an enhancer under. The interface keeps
/// it out of every image picker and gives it no engine setup of its own.
pub(super) const FAMILY: &str = "enhancer";

// ── Where it lives ────────────────────────────────────────────────────

/// Beside the packs of the second image engine, in a folder of its own.
fn enhancer_dir(root: &Path, e: &Enhancer) -> PathBuf {
    root.join(e.id)
}

/// The folder `mlx_vlm` loads.
fn model_dir(root: &Path, e: &Enhancer) -> PathBuf {
    enhancer_dir(root, e).join(e.folder)
}

fn installed_at(root: &Path, e: &Enhancer) -> bool {
    let dir = enhancer_dir(root, e);
    mflux::claim(&dir, e.id).is_file() && mflux::pack_complete(&dir)
}

/// Whether the venv of `python` can run the enhancer: `mlx_vlm` is in it, by
/// the record pip left, and it knows the architecture, by its `qwen3_5`
/// folder (an `mlx_vlm` from before that would fail at the load). Read off the
/// disk and not by importing it, which loads MLX and takes seconds.
fn has_vlm(python: &str) -> bool {
    let Some(venv) = Path::new(python).parent().and_then(Path::parent) else {
        return false;
    };
    let knows_qwen3_5 = std::fs::read_dir(venv.join("lib"))
        .map(|sites| sites.flatten().any(|site| site.path().join("site-packages/mlx_vlm/models/qwen3_5").is_dir()))
        .unwrap_or(false);
    knows_qwen3_5 && crate::commands::video::dist_version(venv, "mlx_vlm").is_some()
}

/// The interpreter a run starts: the video engine's, which is the sidecar's
/// venv on a Mac that has it (`video::engine_python`), or else the sidecar's
/// venv itself. The first of them that can run the enhancer.
fn engine_python() -> Option<String> {
    let sidecar = super::venv_python().to_string_lossy().to_string();
    pick_python([crate::commands::video::engine_python(), Some(sidecar)], has_vlm)
}

fn pick_python(candidates: [Option<String>; 2], fits: impl Fn(&str) -> bool) -> Option<String> {
    candidates.into_iter().flatten().find(|p| fits(p))
}

/// Installed, and with the engine that runs it. What a tile and a run ask.
pub(super) fn usable(e: &Enhancer) -> bool {
    installed_at(&mflux::models_root(), e) && engine_python().is_some()
}

/// The rows `mlx_image_models` adds for the enhancers, in its own shape.
pub(super) fn rows() -> Vec<Value> {
    ENHANCERS
        .iter()
        .map(|e| {
            json!({
                "id": e.id,
                "name": e.name,
                "repo": e.repo,
                "sizeGB": (e.bytes as f64 / 1e8).round() / 10.0,
                "minRamGB": e.min_ram_gb,
                "steps": 0,
                "guidance": 0.0,
                "defaultSize": 0,
                "unfiltered": false,
                "description": e.description,
                "retired": false,
                "installed": usable(e),
                "family": FAMILY,
                "enhancer": e.mode.name(),
                "editImages": 0,
                "userSampling": Value::Null,
                "loras": false,
            })
        })
        .collect()
}

// ── Install ───────────────────────────────────────────────────────────

/// What the video engine's venv takes when it has to be set up for this: pip
/// and its wheels, measured on the owner's Mac with room to spare.
const ENGINE_INSTALL_BYTES: u64 = 2_500_000_000;

/// The files of the repository a run reads: the one folder, and in it the
/// weights and the config the loader cannot start without.
fn plan(e: &Enhancer, listing: &[crate::commands::mlx_snapshot::RepoFile]) -> Result<Manifest, String> {
    let prefix = format!("{}/", e.folder);
    let files: Vec<ManifestFile> = listing
        .iter()
        .filter(|f| f.path.starts_with(&prefix))
        .map(|f| ManifestFile { path: f.path.clone(), size: f.size })
        .collect();
    let has = |name: &str| files.iter().any(|f| f.path == format!("{prefix}{name}"));
    if !files.iter().any(|f| f.path.ends_with(".safetensors")) || !has("config.json") || !has("tokenizer.json") {
        return Err(format!("The repository has no complete model under {prefix} and cannot be run. Try again later."));
    }
    Ok(Manifest { revision: e.revision.to_string(), files })
}

pub(super) fn install(state: &AppState, e: &'static Enhancer) -> CmdResult {
    ensure_image_engine_supported()?;
    let root = mflux::models_root();
    let slot = state.install_mlx_image_model();
    if usable(e) {
        if slot.try_start() {
            slot.complete(format!("{} already installed", e.id));
        }
        return Ok(json!({ "ok": true, "status": "complete", "id": e.id }));
    }
    // The engine is the video engine's venv. Set up from two places at once,
    // two pips would write into one venv.
    let needs_engine = engine_python().is_none();
    if needs_engine && state.install_mlx_video().is_running() {
        return Err(crate::commands::bad_request(
            "The video engine is being set up. The prompt enhancer runs on it: wait for it to finish first.",
        ));
    }
    let dir = enhancer_dir(&root, e);
    let weights = if mflux::pack_complete(&dir) { 0 } else { e.bytes.saturating_sub(crate::install_state::dir_size(&dir)) };
    let need = weights + if needs_engine { ENGINE_INSTALL_BYTES } else { 0 };
    let note = if needs_engine { "incl. the one-time MLX engine that runs it" } else { "" };
    crate::commands::system::ensure_free_space(&root, e.name, need, note).map_err(crate::commands::bad_request)?;
    std::fs::create_dir_all(&root).map_err(|err| crate::commands::internal(os_error::english(&err)))?;
    crate::media_store::keep_out_of_backups(&root);
    // Check and claim in one step: of two clicks, one starts the install.
    if !slot.try_start() {
        return Ok(json!({ "ok": true, "status": "installing" }));
    }
    let preferred_base = state.python_bin();
    crate::install_state::spawn_install(slot, move |slot| {
        let python = match engine_python() {
            Some(python) => python,
            None => {
                slot.log("setting up the MLX engine the prompt enhancer runs on (one-time)");
                crate::commands::video::install_engine_steps(slot, preferred_base)?;
                engine_python().ok_or("The engine was set up, but mlx_vlm is not in it. Start the install again.")?
            }
        };
        install_steps(slot, &python, &root, e)?;
        if !usable(e) {
            return Err("The download finished, but the model is not complete on disk. Start it again.".to_string());
        }
        Ok(format!("{} installed", e.id))
    });
    Ok(json!({ "ok": true, "status": "installing", "id": e.id }))
}

fn install_steps(slot: &InstallSlot, python: &str, root: &Path, e: &Enhancer) -> Result<(), String> {
    let dir = enhancer_dir(root, e);
    if mflux::pack_complete(&dir) {
        slot.log(format!("the files of {} are on disk already", e.id));
    } else {
        slot.log(format!("asking the hub what {} holds", e.repo));
        let listing = fetch_repo_listing(e.repo, e.revision)
            .map_err(|err| if super::is_hub_denied(&err) { err } else { format!("Could not read the file list of {}: {err}.", e.repo) })?;
        let manifest = plan(e, &listing)?;
        let total: u64 = manifest.files.iter().map(|f| f.size).sum();
        slot.log(format!("downloading {}/{} ({})", e.repo, e.folder, crate::commands::mlx_snapshot::human_bytes(total)));
        std::fs::create_dir_all(&dir).map_err(|err| os_error::english(&err))?;
        let _ = std::fs::remove_file(dir.join(mflux::MANIFEST));
        crate::install_state::watch_dir_size(slot.clone(), dir.clone(), vec![mflux::hf_home(root).join("xet")], total);
        let files: Vec<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
        mflux::hub_snapshot(slot, python, root, e.repo, e.revision, &dir, &files)?;
        let missing = mflux::missing_files(&dir, &manifest);
        if !missing.is_empty() {
            let shown: Vec<&str> = missing.iter().take(3).map(String::as_str).collect();
            return Err(format!("The download finished, but the model is missing {}. Start it again.", shown.join(", ")));
        }
        let record = serde_json::to_string(&manifest).map_err(|err| err.to_string())?;
        std::fs::write(dir.join(mflux::MANIFEST), record).map_err(|err| os_error::english(&err))?;
    }
    std::fs::write(mflux::claim(&dir, e.id), b"").map_err(|err| os_error::english(&err))
}

// ── Remove ────────────────────────────────────────────────────────────

pub(super) fn delete(e: &Enhancer) -> CmdResult {
    if mflux::busy() {
        return Err(crate::commands::bad_request("A run is under way. Wait for it to finish before deleting the model."));
    }
    let root = mflux::models_root();
    delete_at(&root, e).map_err(|err| match err {
        None => crate::commands::not_found(format!("{} is not installed", e.id)),
        Some(err) => crate::commands::internal(format!("delete {}: {err}", e.id)),
    })?;
    Ok(json!({ "ok": true, "id": e.id }))
}

/// The folder goes, with whatever a stopped download left in it, and the
/// hub's chunk cache. `Err(None)`: there was nothing to remove.
fn delete_at(root: &Path, e: &Enhancer) -> Result<(), Option<String>> {
    let dir = enhancer_dir(root, e);
    if !dir.is_dir() {
        return Err(None);
    }
    std::fs::remove_dir_all(&dir).map_err(|err| Some(os_error::english(&err)))?;
    let _ = std::fs::remove_dir_all(mflux::hf_home(root).join("xet"));
    Ok(())
}

// ── Run ───────────────────────────────────────────────────────────────

/// The first line of the script. The sweep at app start knows a run of ours
/// that outlived its app by it (`mflux::is_orphaned_run`).
/// Read only by the Mac sweep and the tests, so elsewhere it stands unused.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(super) const SCRIPT_MARK: &str = "# lu prompt enhancer";

/// The script a run starts with `-c`. The request comes on its standard input
/// as JSON and the answer goes into the file after `--out`, so no prompt and
/// no path has to survive being quoted, and an answer of many kilobytes is
/// not cut down to the last lines of a stream.
///
/// What it does, as read from mlx_vlm 0.6.3: `load` takes the folder;
/// `apply_chat_template` with a system and a user message puts the image
/// tokens into the user message (`qwen3_5` is LIST_WITH_IMAGE_FIRST) and
/// passes `enable_thinking` to the model's template, which then opens the
/// reasoning with `<think>`; `generate` takes PIL images, the sampling below
/// and `presence_context_size`, which mlx_lm counts in generated tokens.
/// The images are scaled down to `max_pixels` before they are handed over:
/// the processor of this model takes up to 16.7 megapixels, which would make
/// a photo from a phone thousands of tokens long.
const SCRIPT: &str = r#"# lu prompt enhancer
import json, sys
request = json.load(sys.stdin)
model_dir = sys.argv[sys.argv.index("--model") + 1]
out = sys.argv[sys.argv.index("--out") + 1]
import mlx.core as mx
from mlx_vlm import load, generate, apply_chat_template
from mlx_vlm.utils import load_image
mx.random.seed(request["seed"])
model, processor = load(model_dir)
images = []
for path in request["images"]:
    image = load_image(path)
    scale = (request["max_pixels"] / float(image.width * image.height)) ** 0.5
    if scale < 1:
        image = image.resize((max(1, int(image.width * scale)), max(1, int(image.height * scale))))
    images.append(image)
messages = [{"role": "system", "content": request["system"]}, {"role": "user", "content": request["prompt"]}]
prompt = apply_chat_template(processor, model.config, messages, num_images=len(images), enable_thinking=True)
s = request["sampling"]
result = generate(
    model, processor, prompt, image=images or None, verbose=False,
    max_tokens=request["max_tokens"], enable_thinking=True,
    temperature=s["temperature"], top_p=s["top_p"], top_k=s["top_k"], min_p=s["min_p"],
    repetition_penalty=s["repetition_penalty"], presence_penalty=s["presence_penalty"],
    presence_context_size=request["max_tokens"],
)
with open(out, "w", encoding="utf-8") as f:
    json.dump({"text": result.text, "tokens": result.generation_tokens, "finish": result.finish_reason}, f)
"#;

/// Room for the reasoning and the rewritten prompt, the value Windows uses
/// (`QWEN_ENHANCER_MAX_LENGTH`).
const MAX_TOKENS: u32 = 4096;

/// How long a rewrite may take, loading the model included, as on Windows.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// The most images an edit hands the enhancer: what Qwen-Image 2.1 takes in
/// one edit on this Mac.
const MAX_IMAGES: usize = 10;

/// The largest image the enhancer is shown, in pixels.
const MAX_PIXELS: u32 = 1024 * 1024;

/// Sampling as Windows sets it, after Qwen's release: temperature 1.0,
/// top_p 0.95, top_k 20, min_p 0, repetition penalty 1.0, and a presence
/// penalty of 1.5 for a new picture, 0 for an edit.
fn sampling(mode: Mode) -> Value {
    json!({
        "temperature": 1.0,
        "top_p": 0.95,
        "top_k": 20,
        "min_p": 0.0,
        "repetition_penalty": 1.0,
        "presence_penalty": if mode == Mode::T2i { 1.5 } else { 0.0 },
    })
}

/// The two official system prompts, from the one file the Windows graph
/// takes them from. Each is a JSON string literal on one line there.
const PROMPTS_TS: &str = include_str!("../../../src/api/qwen-enhancer-prompts.ts");

fn read_prompt(source: &str, name: &str) -> Option<String> {
    let start = format!("export const {name} = ");
    let line = source.lines().find_map(|l| l.strip_prefix(start.as_str()))?;
    serde_json::from_str(line.trim_end().trim_end_matches(';')).ok()
}

fn system_prompt(mode: Mode) -> Result<&'static str, String> {
    static PROMPTS: std::sync::OnceLock<(Option<String>, Option<String>)> = std::sync::OnceLock::new();
    let (t2i, i2i) = PROMPTS.get_or_init(|| {
        (read_prompt(PROMPTS_TS, "QWEN_PE_T2I_SYSTEM_PROMPT"), read_prompt(PROMPTS_TS, "QWEN_PE_I2I_SYSTEM_PROMPT"))
    });
    let text = if mode == Mode::T2i { t2i } else { i2i };
    text.as_deref().ok_or_else(|| "The system prompt of the prompt enhancer is missing from this build.".to_string())
}

#[derive(Deserialize)]
struct EnhanceArgs {
    model: String,
    prompt: String,
    #[serde(default)]
    images: Vec<String>,
    #[serde(default)]
    seed: u64,
    #[serde(default)]
    run: Option<String>,
}

/// The images a run may read, or the sentence for the user. A rewrite for a
/// new picture reads none, an edit at least its source. Each path has to be
/// a file Create staged, checked as an edit's images are.
fn run_images(mode: Mode, asked: &[String], staged: &Path) -> Result<Vec<PathBuf>, String> {
    match mode {
        Mode::T2i if !asked.is_empty() => Err("The prompt enhancer for a new picture reads no images.".to_string()),
        Mode::T2i => Ok(Vec::new()),
        Mode::I2i if asked.is_empty() => Err("The edit prompt enhancer needs the image to edit. Add it again.".to_string()),
        Mode::I2i if asked.len() > MAX_IMAGES => Err(format!("The edit prompt enhancer reads at most {MAX_IMAGES} images.")),
        Mode::I2i => mflux::staged_files(asked, staged),
    }
}

/// What goes to the script on its standard input.
fn request_body(mode: Mode, system: &str, prompt: &str, images: &[PathBuf], seed: u64) -> Value {
    json!({
        "system": system,
        "prompt": prompt,
        "images": images.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
        "seed": seed,
        "max_tokens": MAX_TOKENS,
        "max_pixels": MAX_PIXELS,
        "sampling": sampling(mode),
    })
}

/// The command line after the interpreter.
fn command_args(model: &Path, out: &Path) -> Vec<std::ffi::OsString> {
    vec!["-c".into(), SCRIPT.into(), "--model".into(), model.into(), "--out".into(), out.into()]
}

const STOPPED: &str = "The prompt was not rewritten because the app stopped the enhancer.";

/// How a run ended: the answer, or the sentence for the user.
fn outcome(ended: &mflux::Ended, answer: Option<String>) -> Result<String, String> {
    if ended.stopped {
        return Err(STOPPED.to_string());
    }
    let Some(status) = ended.status else {
        return Err("The prompt enhancer did not finish within 15 minutes and was stopped.".to_string());
    };
    let last = || mflux::last_word(&ended.warned).or(mflux::last_word(&ended.said));
    if status.success() {
        return answer.ok_or_else(|| match last() {
            Some(line) => format!("The prompt enhancer finished without an answer: {}", super::truncate(line, 300)),
            None => "The prompt enhancer finished without an answer.".to_string(),
        });
    }
    if let Some(code) = status.code() {
        return Err(match last() {
            Some(line) => format!("The prompt enhancer stopped: {}", super::truncate(line, 300)),
            None => format!("The prompt enhancer stopped with exit code {code} and no message."),
        });
    }
    Err("The prompt enhancer was ended by the system. This usually means it did not fit into memory. Close other apps and try again.".to_string())
}

/// The text of the answer file, `None` when there is none to read.
fn read_answer(out: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(out).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    value.get("text")?.as_str().map(str::to_string)
}

/// `mlx_enhance_prompt`: rewrite a prompt with an installed enhancer. Answers
/// `{ text }`, the model's whole answer with its reasoning: what becomes a
/// prompt of it is decided where Windows decides it (`cleanEnhanced`).
pub(super) async fn enhance(state: &AppState, args: &Value) -> CmdResult {
    let req: EnhanceArgs = serde_json::from_value(args.clone()).map_err(|e| crate::commands::bad_request(e.to_string()))?;
    ensure_image_engine_supported()?;
    let e = lookup(&req.model).ok_or_else(|| crate::commands::bad_request(format!("unknown prompt enhancer: {}", req.model)))?;
    if req.prompt.trim().is_empty() {
        return Err(crate::commands::bad_request("There is no prompt to rewrite."));
    }
    // Everything that can be refused is refused before anything is unloaded.
    let images = run_images(e.mode, &req.images, &mflux::staged_images_dir()).map_err(crate::commands::bad_request)?;
    let system = system_prompt(e.mode).map_err(crate::commands::internal)?;
    if let Some(too_big) = memory_verdict(e.name, e.min_ram_gb, total_memory_bytes()) {
        return Err(crate::commands::bad_request(too_big));
    }
    if let Some(why) = super::train::refusal() {
        return Err(crate::commands::bad_request(why));
    }
    if let Some(why) = crate::commands::mesh3d::refusal() {
        return Err(crate::commands::bad_request(why));
    }
    if !usable(e) {
        return Err(crate::commands::bad_request(format!("{} is not installed. Install it in the Model Manager first.", e.name)));
    }
    let python = engine_python().ok_or_else(|| crate::commands::bad_request("The engine of the prompt enhancer is not set up. Install the enhancer again."))?;
    if super::sidecar_at_an_image() {
        return Err(crate::commands::bad_request("The previous image is still finishing. Try again in a moment."));
    }
    // The place of the run from here on: no image starts beside it, Remove
    // waits for it, and Cancel in Create ends it by its name.
    let _claim = mflux::claim_run(req.run.clone())
        .ok_or_else(|| crate::commands::bad_request("An image is already being generated on this Mac. Wait for it to finish."))?;
    // What the sidecar holds goes first, as before an image of the second
    // engine. One that does not answer is no reason to refuse the rewrite.
    let _ = super::mlx_unload(state, &Value::Null).await;

    let root = mflux::models_root();
    let scratch = mflux::scratch(&root);
    std::fs::create_dir_all(&scratch).map_err(|err| crate::commands::internal(os_error::english(&err)))?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let out = scratch.join(format!("enhancer-{stamp}-{}.json", std::process::id()));
    let body = request_body(e.mode, system, &req.prompt, &images, req.seed);
    let mut cmd = crate::python::python_command(&python);
    cmd.args(command_args(&model_dir(&root, e), &out))
        // The model is a folder on disk. Should it be incomplete, the loader
        // is to say so, and not fetch anything in the middle of a run.
        .env("HF_HUB_OFFLINE", "1")
        .env("HF_HOME", mflux::hf_home(&root))
        .env("PYTHONUNBUFFERED", "1");
    tracing::info!("[enhancer] {} ({}, {} image(s))", e.id, e.mode.name(), images.len());
    let input = serde_json::to_vec(&body).map_err(|err| crate::commands::internal(err.to_string()))?;
    let ended = tokio::task::spawn_blocking(move || mflux::run_in_place(cmd, TIMEOUT, Some(input), "prompt enhancer"))
        .await
        .map_err(|err| crate::commands::internal(format!("The prompt enhancer did not report back ({err}).")))?
        .map_err(crate::commands::internal)?;
    let answer = read_answer(&out);
    let _ = std::fs::remove_file(&out);
    let text = outcome(&ended, answer).map_err(|why| {
        tracing::error!("[enhancer] {why}");
        crate::commands::internal(why)
    })?;
    Ok(json!({ "text": text, "model": e.id }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mlx_snapshot::RepoFile;

    fn file(path: &str, size: u64) -> RepoFile {
        RepoFile { path: path.to_string(), size, sha256: None }
    }

    /// The listing of the 4-bit folder as the hub gave it on 14.10.2026,
    /// with a file of the 8-bit folder and one at the root beside it.
    fn listing(weights: u64) -> Vec<RepoFile> {
        vec![
            file("README.md", 1),
            file("model-00001-of-00004.safetensors", 9),
            file("8bit/model-00001-of-00002.safetensors", 9),
            file("4bit/README.md", 84),
            file("4bit/chat_template.jinja", 7756),
            file("4bit/config.json", 3854),
            file("4bit/generation_config.json", 204),
            file("4bit/model-00001-of-00002.safetensors", weights),
            file("4bit/model-00002-of-00002.safetensors", 600_449_850),
            file("4bit/model.safetensors.index.json", 123_592),
            file("4bit/processor_config.json", 991),
            file("4bit/tokenizer.json", 19_989_343),
            file("4bit/tokenizer_config.json", 1195),
        ]
    }

    #[test]
    fn the_catalogue_names_two_official_enhancers_pinned_to_a_commit() {
        assert_eq!(ENHANCERS.len(), 2);
        let modes: Vec<Mode> = ENHANCERS.iter().map(|e| e.mode).collect();
        assert_eq!(modes, [Mode::T2i, Mode::I2i]);
        for e in ENHANCERS {
            assert!(super::super::is_repo_id(e.repo), "{}", e.id);
            assert_eq!(e.revision.len(), 40, "{}: a full commit id, not a branch", e.id);
            assert!(e.revision.chars().all(|c| c.is_ascii_hexdigit()), "{}", e.id);
            assert_eq!(e.folder, "4bit");
            // The name the interface knows an enhancer by (qwen-enhancer.ts).
            assert!(e.id.starts_with(&format!("qwen-image-2.1-pe-{}", e.mode.name())), "{}", e.id);
            assert!(!e.id.contains("heretic") && !e.id.contains("abliterat"), "only the official edition has an MLX build");
            assert!(e.description.contains("Research license, non-commercial use only."), "{}", e.id);
            assert!(!e.description.contains('\u{2014}') && !e.description.contains('\u{2013}'), "{}", e.id);
            // An enhancer is no image model: the image catalogue never runs it.
            assert!(super::super::IMAGE_CATALOG.iter().all(|c| c.id != e.id), "{}", e.id);
            assert_eq!(lookup(e.id).map(|f| f.id), Some(e.id));
        }
        // What the hub listed for the 4-bit folders, to the byte.
        let listed: u64 = listing(5_349_769_780).iter().filter(|f| f.path.starts_with("4bit/")).map(|f| f.size).sum();
        assert_eq!(listed, ENHANCERS[0].bytes);
        assert_eq!(lookup("qwen-image-2.1-4bit").map(|e| e.id), None);
    }

    #[test]
    fn the_rows_say_enhancer_and_keep_out_of_the_image_lists() {
        let rows = rows();
        assert_eq!(rows.len(), 2);
        for (row, e) in rows.iter().zip(ENHANCERS) {
            assert_eq!(row["family"], FAMILY);
            assert_eq!(row["enhancer"], e.mode.name());
            assert_eq!(row["editImages"], 0, "Edit would offer it as an image model");
            assert_eq!(row["loras"], false);
            assert_eq!(row["unfiltered"], false);
            assert_eq!(row["sizeGB"], 6.0);
        }
    }

    #[test]
    fn the_install_fetches_the_four_bit_folder_and_nothing_else() {
        let e = &ENHANCERS[0];
        let manifest = plan(e, &listing(5_349_769_780)).unwrap();
        assert_eq!(manifest.revision, e.revision);
        assert!(manifest.files.iter().all(|f| f.path.starts_with("4bit/")));
        assert_eq!(manifest.files.len(), 10);
        assert_eq!(manifest.files.iter().map(|f| f.size).sum::<u64>(), e.bytes);
        // A folder whose upload is still under way is no model.
        let half: Vec<RepoFile> = listing(1).into_iter().filter(|f| !f.path.ends_with("tokenizer.json")).collect();
        assert!(plan(e, &half).unwrap_err().contains("no complete model under 4bit/"));
        let none: Vec<RepoFile> = listing(1).into_iter().filter(|f| !f.path.starts_with("4bit/")).collect();
        assert!(plan(e, &none).is_err());
    }

    #[test]
    fn installed_means_claimed_and_whole_and_remove_takes_the_folder() {
        let root = tempfile::tempdir().unwrap();
        let e = &ENHANCERS[1];
        assert!(!installed_at(root.path(), e));
        assert_eq!(delete_at(root.path(), e), Err(None));
        let dir = enhancer_dir(root.path(), e);
        let files = vec![
            ManifestFile { path: "4bit/config.json".into(), size: 3 },
            ManifestFile { path: "4bit/model-00001-of-00002.safetensors".into(), size: 7 },
        ];
        for f in &files {
            crate::test_support::sized_file(&dir.join(&f.path), f.size);
        }
        let manifest = Manifest { revision: e.revision.to_string(), files };
        std::fs::write(dir.join(mflux::MANIFEST), serde_json::to_string(&manifest).unwrap()).unwrap();
        assert!(!installed_at(root.path(), e), "whole, but nobody asked for it");
        std::fs::write(mflux::claim(&dir, e.id), b"").unwrap();
        assert!(installed_at(root.path(), e));
        assert_eq!(model_dir(root.path(), e), dir.join("4bit"));
        // A file cut short is not a model.
        crate::test_support::sized_file(&dir.join("4bit/config.json"), 1);
        assert!(!installed_at(root.path(), e));
        assert_eq!(delete_at(root.path(), e), Ok(()));
        assert!(!dir.exists());
    }

    #[test]
    fn the_engine_is_a_venv_with_mlx_vlm_in_it() {
        let venv = tempfile::tempdir().unwrap();
        let python = venv.path().join("bin").join("python");
        let python = python.to_string_lossy().to_string();
        assert!(!has_vlm(&python));
        let site = venv.path().join("lib/python3.11/site-packages");
        let record = site.join("mlx_vlm-0.6.3.dist-info");
        std::fs::create_dir_all(&record).unwrap();
        std::fs::write(record.join("METADATA"), "Metadata-Version: 2.1\nName: mlx-vlm\nVersion: 0.6.3\n\nText").unwrap();
        assert!(!has_vlm(&python), "an mlx_vlm that does not know qwen3_5 cannot load the enhancer");
        std::fs::create_dir_all(site.join("mlx_vlm/models/qwen3_5")).unwrap();
        assert!(has_vlm(&python));
        assert!(!has_vlm("python"), "a bare name is no venv");

        // The video engine's venv first, the sidecar's after it, the first
        // that fits.
        let fits = |p: &str| p.starts_with("/ok");
        assert_eq!(pick_python([Some("/ok/a".into()), Some("/ok/b".into())], fits).as_deref(), Some("/ok/a"));
        assert_eq!(pick_python([Some("/no/a".into()), Some("/ok/b".into())], fits).as_deref(), Some("/ok/b"));
        assert_eq!(pick_python([None, Some("/ok/b".into())], fits).as_deref(), Some("/ok/b"));
        assert_eq!(pick_python([Some("/no/a".into()), None], fits), None);
    }

    #[test]
    fn a_rewrite_runs_on_the_official_system_prompts_and_samplings() {
        // The same texts the Windows graph takes (qwen-enhancer-workflow.test.ts
        // pins them by length in UTF-16 units and by SHA-256).
        use sha2::Digest;
        let sha = |text: &str| format!("{:x}", sha2::Sha256::digest(text.as_bytes()));
        let t2i = system_prompt(Mode::T2i).unwrap();
        let i2i = system_prompt(Mode::I2i).unwrap();
        assert_eq!(t2i.encode_utf16().count(), 10308);
        assert_eq!(sha(t2i), "0b8b261455e2a8c48757bdad7c3cb71173c67ab7b5ab7042a2635fd76a6fb2bf");
        assert_eq!(i2i.encode_utf16().count(), 10494);
        assert_eq!(sha(i2i), "eaff356cd2bdbcfd1aaf20502b5ccd8cbad16fa6e9afe41e3166eeee299c8e59");
        assert_eq!(read_prompt("export const X = \"a\\nb\"", "X").as_deref(), Some("a\nb"));
        assert_eq!(read_prompt("export const X = 'a'", "X"), None);

        let t2i_sampling = sampling(Mode::T2i);
        assert_eq!(t2i_sampling["temperature"], 1.0);
        assert_eq!(t2i_sampling["top_p"], 0.95);
        assert_eq!(t2i_sampling["top_k"], 20);
        assert_eq!(t2i_sampling["min_p"], 0.0);
        assert_eq!(t2i_sampling["repetition_penalty"], 1.0);
        assert_eq!(t2i_sampling["presence_penalty"], 1.5);
        assert_eq!(sampling(Mode::I2i)["presence_penalty"], 0.0);

        let images = vec![PathBuf::from("/s/a.png"), PathBuf::from("/s/b.png")];
        let body = request_body(Mode::I2i, i2i, "make it night", &images, 42);
        assert_eq!(body["system"], i2i);
        assert_eq!(body["prompt"], "make it night");
        assert_eq!(body["images"], json!(["/s/a.png", "/s/b.png"]));
        assert_eq!(body["seed"], 42);
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["sampling"], sampling(Mode::I2i));
    }

    #[test]
    fn the_command_line_carries_paths_and_no_prompt() {
        let args = command_args(Path::new("/m/qwen-image-2.1-pe-t2i-4bit/4bit"), Path::new("/c/out.json"));
        let args: Vec<String> = args.iter().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(args[0], "-c");
        assert!(args[1].starts_with(SCRIPT_MARK), "the sweep at app start knows a run by its first line");
        assert_eq!(&args[2..], ["--model", "/m/qwen-image-2.1-pe-t2i-4bit/4bit", "--out", "/c/out.json"]);
        // Reasoning on, the official values handed through, nothing fetched.
        for needle in ["enable_thinking=True", "presence_context_size=", "top_k=s[\"top_k\"]", "json.load(sys.stdin)", "load(model_dir)"] {
            assert!(SCRIPT.contains(needle), "{needle}");
        }
        assert!(!SCRIPT.contains('\u{2014}') && !SCRIPT.contains(" -- "));
    }

    #[test]
    fn an_edit_reads_staged_images_and_a_new_picture_reads_none() {
        let root = tempfile::tempdir().unwrap();
        let staged = root.path().join("start-images");
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("a.png"), b"x").unwrap();
        std::fs::write(root.path().join("elsewhere.png"), b"x").unwrap();
        let path = |p: PathBuf| p.to_string_lossy().to_string();
        let a = path(staged.join("a.png"));

        assert_eq!(run_images(Mode::T2i, &[], &staged), Ok(Vec::new()));
        assert!(run_images(Mode::T2i, std::slice::from_ref(&a), &staged).is_err(), "a new picture has no image to read");
        assert!(run_images(Mode::I2i, &[], &staged).unwrap_err().contains("needs the image"));
        let read = run_images(Mode::I2i, std::slice::from_ref(&a), &staged).unwrap();
        assert_eq!(read, vec![staged.join("a.png").canonicalize().unwrap()]);
        let gone = "The image to edit is no longer on disk. Add it again.";
        for outside in [path(root.path().join("elsewhere.png")), path(staged.join("..").join("elsewhere.png")), path(staged.join("missing.png")), path(staged.clone())] {
            assert_eq!(run_images(Mode::I2i, std::slice::from_ref(&outside), &staged).unwrap_err(), gone, "{outside}");
        }
        let eleven = vec![a; MAX_IMAGES + 1];
        assert!(run_images(Mode::I2i, &eleven, &staged).unwrap_err().contains("at most 10"));
    }

    #[cfg(unix)]
    #[test]
    fn a_run_says_how_it_ended() {
        let status = |script: &str| {
            crate::process_util::foreign_system_command(crate::test_support::posix_shell()).arg("-c").arg(script).status().unwrap()
        };
        let ended = |script: &str, stopped: bool, warned: &[&str]| mflux::Ended {
            status: Some(status(script)),
            said: Vec::new(),
            warned: warned.iter().map(|s| s.to_string()).collect(),
            stopped,
        };
        assert_eq!(outcome(&ended("exit 0", false, &[]), Some("A cat.".into())), Ok("A cat.".to_string()));
        assert_eq!(outcome(&ended("exit 0", false, &[]), None).unwrap_err(), "The prompt enhancer finished without an answer.");
        assert_eq!(
            outcome(&ended("exit 1", false, &["ValueError: Missing parameters"]), None).unwrap_err(),
            "The prompt enhancer stopped: ValueError: Missing parameters"
        );
        assert_eq!(outcome(&ended("exit 0", true, &[]), Some("late".into())).unwrap_err(), STOPPED);
        assert!(outcome(&ended("kill -9 $$", false, &[]), None).unwrap_err().contains("did not fit into memory"));
        let timed_out = mflux::Ended { status: None, said: Vec::new(), warned: Vec::new(), stopped: false };
        assert!(outcome(&timed_out, None).unwrap_err().contains("15 minutes"));
    }

    #[test]
    fn the_answer_is_read_from_its_file() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("a.json");
        assert_eq!(read_answer(&out), None);
        std::fs::write(&out, r#"{"text": "Reasoning.\n</think>\n\nA cat.", "tokens": 9}"#).unwrap();
        assert_eq!(read_answer(&out).as_deref(), Some("Reasoning.\n</think>\n\nA cat."));
        std::fs::write(&out, "{").unwrap();
        assert_eq!(read_answer(&out), None);
    }

    /// One model in memory: everything that can be refused is refused, and
    /// the place of an image is taken, before the sidecar lets go of its
    /// model; the run takes that place, and offline.
    #[test]
    fn a_rewrite_is_refused_or_claimed_before_anything_is_unloaded() {
        let src = include_str!("mlx_enhancer.rs");
        let body = &src[src.find("pub(super) async fn enhance(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let at = |needle: &str| body.find(needle).unwrap_or_else(|| panic!("{needle}"));
        let unload = at("super::mlx_unload(");
        for before in ["run_images(", "system_prompt(", "memory_verdict(", "if !usable(e)", "sidecar_at_an_image()", "mflux::claim_run(req.run.clone())"] {
            assert!(at(before) < unload, "{before} comes after the unload");
        }
        assert!(unload < at("mflux::run_in_place("));
        assert!(body.contains(".env(\"HF_HUB_OFFLINE\", \"1\")"));
    }

    #[test]
    fn no_message_carries_a_dash() {
        let src = include_str!("mlx_enhancer.rs");
        let production = &src[..src.find("#[cfg(test)]").unwrap()];
        assert!(!production.contains('\u{2014}') && !production.contains('\u{2013}'));
    }

    /// The real run: the installed enhancer rewrites a prompt, through the
    /// script, the request and the reading of the answer a run in Create
    /// takes. Ignored unless asked for:
    ///
    /// `LU_ENHANCER_MODEL_DIR=<folder with the 4bit files> LU_ENHANCER_PYTHON=<python of a venv with mlx_vlm>
    ///  cargo test the_enhancer_rewrites_a_prompt_on_this_mac -- --ignored --nocapture`
    ///
    /// `LU_ENHANCER_MODE=i2i` with `LU_ENHANCER_IMAGE=<png>` runs an edit.
    /// It loads about 6 GB into memory and runs for minutes. It notes no pid
    /// and takes no place of the app's (`mflux::run_alone`).
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "loads the 9B enhancer, run by hand"]
    fn the_enhancer_rewrites_a_prompt_on_this_mac() {
        let model = std::env::var("LU_ENHANCER_MODEL_DIR").expect("LU_ENHANCER_MODEL_DIR names the 4bit folder");
        let python = std::env::var("LU_ENHANCER_PYTHON").expect("LU_ENHANCER_PYTHON names the venv's python");
        let mode = if std::env::var("LU_ENHANCER_MODE").as_deref() == Ok("i2i") { Mode::I2i } else { Mode::T2i };
        let images: Vec<PathBuf> = std::env::var("LU_ENHANCER_IMAGE").ok().into_iter().map(PathBuf::from).collect();
        assert!(has_vlm(&python), "no mlx_vlm that knows qwen3_5 in the venv of {python}");
        assert_eq!(mode == Mode::I2i, !images.is_empty(), "an edit reads LU_ENHANCER_IMAGE, a new picture reads none");
        let prompt = if mode == Mode::T2i { "a red fox in the snow at dawn" } else { "make it night, with the street lamps on" };
        let out = tempfile::tempdir().unwrap();
        let answer = out.path().join("answer.json");
        let mut cmd = crate::python::python_command(&python);
        cmd.args(command_args(Path::new(&model), &answer)).env("HF_HUB_OFFLINE", "1").env("PYTHONUNBUFFERED", "1");
        let body = request_body(mode, system_prompt(mode).unwrap(), prompt, &images, 7);
        let started = std::time::Instant::now();
        let ended = mflux::run_alone(cmd, TIMEOUT, Some(serde_json::to_vec(&body).unwrap()), "prompt enhancer").unwrap();
        let text = outcome(&ended, read_answer(&answer)).unwrap();
        println!("--- {} s, answer:\n{text}", started.elapsed().as_secs());
        assert!(text.contains("</think>"), "the reasoning is closed, as the interface expects");
        let after = text.rsplit("</think>").next().unwrap().trim();
        assert!(after.split_whitespace().count() > 40, "the rewrite is a long description: {after}");
    }
}
