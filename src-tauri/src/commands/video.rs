//! MLX-video pipeline.
//!
//! Driven via subprocess against the [`mlx-video`](https://github.com/Blaizzy/mlx-video)
//! Python package. Apple Silicon only: the Bridge guards every entry point
//! with an arch check so Windows/Linux clients hitting these commands by
//! accident get a clear 400 instead of a hung subprocess.
//!
//! Models are downloaded into `<os_paths::data_dir()>/mlx-video/models/<id>/`
//! (the `--model-dir` argument passed to `mlx_video.<family>.generate`). Until
//! 3.0.6 that was a folder under the cache, which a Mac empties: see
//! `media_store`, which also names where Windows and Linux keep them.
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

/// The second engine, `dgrauet/ltx-2-mlx`, for LTX packs that are quantized
/// already. A child module, so it shares this file's venv and download helpers.
#[path = "video_ltx2mlx.rs"]
mod ltx2mlx;
#[path = "video_motion.rs"]
mod motion;

// ── Hardware guard ────────────────────────────────────────────────────

fn ensure_apple_silicon() -> Result<(), String> {
    if std::env::consts::OS == "macos" && std::env::consts::ARCH == "aarch64" {
        Ok(())
    } else {
        Err(bad_request(
            "MLX video is Apple Silicon only. Use the ComfyUI backend on this OS.",
        ))
    }
}

// ── Model catalog ─────────────────────────────────────────────────────
//
// Curated list of models that `mlx-video` can drive today. The frontend
// renders one card per entry; the user clicks Install and the Bridge pulls
// the HF repo into `models_root()/<id>/`.

/// The engine, pinned to the commit the catalogue was checked against.
///
/// The package has no releases and no tags, and its `main` renamed the Wan
/// module twice in one month (`wan`, `wan2`, `wan_2`). An install that follows
/// `main` breaks the day that happens again, on a machine nobody is watching.
/// This is the commit the owner's Mac has run since the first Mac build
/// (read from the venv's `direct_url.json`, 08.10.2026). Never install it by
/// its PyPI name: `mlx-video` there is an unrelated package.
///
/// It is the archive of that commit and not a `git+` address: pip would need
/// `git` for that, and a Mac without the Xcode tools has none.
/// MLX itself, pinned beside the engine. mlx-video names no versions, so pip
/// would take the newest MLX, and on MLX 0.32 its LTX-2.3 renders all black
/// (upstream issue 55). These are the versions the owner's Mac runs it on.
///
/// After those three comes everything the engine pulls in, at the versions of
/// the venv it runs in on that Mac (read from it on 09.10.2026). Left open,
/// each of them arrived at whatever was newest on the day of the install.
const MLX_VIDEO_PINNED: [&str; 81] = [
    "mlx==0.31.2", "mlx-lm==0.31.3", "mlx-vlm==0.6.3", "annotated-doc==0.0.4",
    "annotated-types==0.7.0", "anyio==4.14.1", "audioread==3.1.0", "certifi==2026.6.17",
    "cffi==2.0.0", "charset-normalizer==3.4.7", "click==8.4.2", "datasets==5.0.0",
    "decorator==5.3.1", "dill==0.4.1", "fastapi==0.139.0", "filelock==3.29.4", "fsspec==2026.4.0",
    "ftfy==6.3.1", "h11==0.16.0", "hf-xet==1.5.1", "httpcore==1.0.9", "httpx==0.28.1",
    "huggingface-hub==1.21.0", "idna==3.18", "imageio==2.37.3", "imageio-ffmpeg==0.6.0",
    "jinja2==3.1.6", "joblib==1.5.3", "lazy-loader==0.5", "librosa==0.11.0", "llguidance==1.7.6",
    "llvmlite==0.48.0", "markdown-it-py==4.2.0", "markupsafe==3.0.3", "mdurl==0.1.2",
    "miniaudio==1.71", "mlx-audio==0.4.4", "mlx-metal==0.31.2", "msgpack==1.2.1",
    "multiprocess==0.70.19", "narwhals==2.23.0", "numba==0.66.0", "numpy==2.4.6",
    "opencv-python==5.0.0.93", "packaging==26.2", "pandas==3.0.3", "pillow==12.3.0",
    "platformdirs==4.10.0", "pooch==1.9.0", "protobuf==7.35.1", "pyarrow==24.0.0", "pycparser==3.0",
    "pydantic==2.13.4", "pydantic-core==2.46.4", "pygments==2.20.0", "python-dateutil==2.9.0.post0",
    "pyyaml==6.0.3", "regex==2026.6.28", "requests==2.34.2", "rich==15.0.0", "safetensors==0.8.0",
    "scikit-learn==1.9.0", "scipy==1.18.0", "sentencepiece==0.2.1", "shellingham==1.5.4",
    "six==1.17.0", "sounddevice==0.5.5", "soundfile==0.14.0", "soxr==1.1.0", "starlette==1.3.1",
    "threadpoolctl==3.6.0", "tokenizers==0.22.2", "tqdm==4.68.3", "transformers==5.12.1",
    "typer==0.25.1", "typing-extensions==4.16.0", "typing-inspection==0.4.2", "urllib3==2.7.0",
    "uvicorn==0.49.0", "wcwidth==0.8.2", "xxhash==3.8.0",
];

const MLX_VIDEO_PIP_SPEC: &str =
    "mlx-video @ https://github.com/Blaizzy/mlx-video/archive/87db56a51758fefb748a359b90a5283bb8ba4837.zip";

/// Everything one `pip install` of the first video engine names.
fn mlx_video_pip_specs() -> Vec<&'static str> {
    MLX_VIDEO_PINNED.iter().copied().chain([MLX_VIDEO_PIP_SPEC]).collect()
}

/// The text encoder the LTX-2.3 repositories do not carry. In MLX format with
/// a `text_config`, which is what the loader reads; not gated.
const LTX23_TEXT_ENCODER: &str = "mlx-community/gemma-3-12b-it-qat-4bit";
/// The same Gemma with its refusal direction removed, for the Unfiltered side.
/// Text only (no vision tower), 4-bit, with the `text_config` and the
/// `language_model.` key prefix the loader strips (config and both shard
/// headers read on 08.10.2026).
const LTX23_ABLITERATED_TEXT_ENCODER: &str =
    "FractalSurfer/gemma-3-12b-it-norm-preserved-biprojected-abliterated-mlx-4Bit";

/// Download size of a shared text encoder, for the disk check and the log.
fn text_encoder_gb(repo: &str) -> f32 {
    if repo == LTX23_ABLITERATED_TEXT_ENCODER {
        6.7
    } else {
        8.1
    }
}

/// What a Wan 2.1 fine-tune takes from its base repository: the T5, the VAE
/// and the `config.json` the convert reads the model size from. The
/// transformer comes from the fine-tune itself. Patterns without a slash match
/// top-level files only, so the tokenizer's `tokenizer_config.json` stays out.
const WAN21_BASE_FILES: &[&str] = &["config.json", "models_t5_umt5-xxl-enc-bf16.pth", "Wan2.1_VAE.pth"];

#[derive(serde::Serialize, Clone)]
struct CatalogEntry {
    id: &'static str,
    name: &'static str,
    /// `wan_2` and `ltx_2` run as `mlx_video.models.<family>.generate`.
    /// `ltx_2q` (`ltx2mlx::FAMILY`) runs on the second engine.
    family: &'static str,
    repo: &'static str,
    /// The files to take from `repo`, as hub patterns. Empty takes all of it.
    /// For an ltx_2 entry that converts, the first one is the checkpoint.
    repo_files: &'static [&'static str],
    /// A wan_2 fine-tune ships its transformer and nothing else. This is the
    /// repository that gives the rest (`WAN21_BASE_FILES`), or "".
    base_repo: &'static str,
    /// ltx_2 `--pipeline {distilled,dev,dev-two-stage,...}`. Unused by wan_2.
    pipeline: &'static str,
    size_gb: f32,
    min_ram_gb: u32,
    /// Seconds a run took per second of clip, where a real run was timed
    /// (an M5 Pro with 48 GB, the entry's default size). 0 where nobody has
    /// timed one. Create says the time before a long run starts.
    measured_run_s_per_clip_s: f32,
    /// Default `-n`/`--num-frames` (wan_2 requires 4n+1).
    default_frames: u32,
    default_width: u32,
    default_height: u32,
    /// The download is a PyTorch checkpoint and install runs the engine's
    /// one-time convert (`wan_2.convert` or `ltx_2.convert`). It needs about
    /// twice the size on disk while converting; the source is removed after.
    needs_convert: bool,
    /// 4 or 8 makes the wan_2 convert quantize the transformer
    /// (`--quantize --bits N`); 0 keeps it at bf16.
    quant_bits: u32,
    /// A text encoder that lives in a repository of its own, or "" when the
    /// model's repository carries one. It is downloaded next to the models
    /// and shared by every entry that names it.
    text_encoder_repo: &'static str,
    /// The id of the entry whose weights this one runs on, or "". Such an
    /// entry differs in its text encoder only, and fetching sixty gigabytes a
    /// second time for that would be absurd.
    shares_weights_with: &'static str,
    /// The model cannot run from text alone (Wan I2V has 36 input channels,
    /// twenty of them the encoded start image).
    requires_image: bool,
    /// The model can start from an image, which is not the same as the engine
    /// taking `--image`: mlx-video accepts the flag for every checkpoint.
    /// Read from its source at the pinned commit, 08.10.2026:
    ///   wan_2  only `model_type` ti2v (mask blend) and i2v (channel concat)
    ///          are trained on a start image. A t2v checkpoint, Wan 2.1 or
    ///          Wan 2.2 T2V, falls into the ti2v branch it was never trained
    ///          for.
    ///   ltx_2  the image goes through `vae/encoder`, built from a block list
    ///          that `convert.py` hardcodes for LTX-2. The LTX-2.3 encoder is
    ///          smaller (four blocks at stage five, 1024 channels at stage
    ///          eight), so every LTX-2.3 on this engine fails on a tensor
    ///          shape (mlx-video #49). The published LTX-2.3 conversions
    ///          carry the same block list, so they fail the same way.
    /// See `takes_start_image` for the second engine.
    accepts_image: bool,
    unfiltered: bool,
    /// The entry the one-click setup of Create takes on a Mac it fits on. One
    /// entry carries it, and a test holds that it is one that has run here.
    starter: bool,
    /// Gigabytes of `ltx2mlx::TALKING_FILES` the entry's repository carries
    /// for a Talking Character run (`a2v`), fetched on their own after the
    /// model; 0 for an entry that does not talk. Set where a real run talked.
    talking_gb: f32,
    description: &'static str,
}

/// The fields most entries leave alone.
const ENTRY: CatalogEntry = CatalogEntry {
    id: "",
    name: "",
    family: "",
    repo: "",
    repo_files: &[],
    base_repo: "",
    pipeline: "",
    size_gb: 0.0,
    min_ram_gb: 0,
    measured_run_s_per_clip_s: 0.0,
    default_frames: 81,
    default_width: 1280,
    default_height: 704,
    needs_convert: false,
    quant_bits: 0,
    text_encoder_repo: "",
    shares_weights_with: "",
    requires_image: false,
    accepts_image: false,
    unfiltered: false,
    starter: false,
    talking_gb: 0.0,
    description: "",
};

/// Whether Create may hand this model a start image. The quantized LTX packs
/// run on the second engine, whose `generate --distilled` takes `--image` for
/// every pack and encodes it with the encoder the pack ships
/// (`ltx_pipelines_mlx/cli.py` and `distilled.py` at the pinned commit).
fn takes_start_image(c: &CatalogEntry) -> bool {
    c.accepts_image || c.requires_image || c.family == ltx2mlx::FAMILY
}

/// What the T5 text encoder of a Wan run holds in memory, rounded up to a
/// size a Mac is sold with. Measured on Wan 2.1 T2V 1.3B (M5 Pro 48 GB,
/// 09.10.2026): the encoder stood at 25.6 GB in MLX while it read the prompt,
/// and the whole run peaked at 24.5 GB. Every Wan of this engine reads its
/// prompt through that encoder.
const WAN_T5_MEMORY_GB: u32 = 32;

/// The memory a model is recommended for, which is what a tile and the
/// "Fits my Mac" filter go by. `min_ram_gb` stays the line below which a run
/// is refused (`memory_refusal`), and the two differ for the small Wan
/// entries: nobody has measured whether a Mac with 16 or 24 GB gets through
/// the seconds of the text encoder on swap, so a run there is neither
/// recommended nor forbidden.
fn recommended_ram_gb(c: &CatalogEntry) -> u32 {
    if c.family == "wan_2" {
        c.min_ram_gb.max(WAN_T5_MEMORY_GB)
    } else {
        c.min_ram_gb
    }
}

// Only repos that ACTUALLY exist on HuggingFace (every one verified HTTP 200,
// ungated, sizes from the API) and that `mlx-video` can drive today:
//   - ltx_2  → prince-canuma/LTX-2*, the package author's PRE-CONVERTED
//     modular repos. This replaces the mlx-community bf16 single-file repos,
//     whose flat layout crashed generation (BUG-022), resolved by repo swap.
//     A single-file checkpoint (Lightricks, or a fine-tune with the same 5,947
//     tensors) goes through `ltx_2.convert`, which writes that same layout.
//   - wan_2  → the original Wan-AI checkpoints + the package's convert step
//     (`--model-dir <converted>`), or a repository that holds the convert's
//     output already.
//   - ltx_2q → packs for the second engine (`ltx2mlx`): quantized already,
//     no convert, and only the files its distilled mode reads. Each list was
//     held against the repository's file list from the hub API (08.10.2026).
//
// Mainstream is every official model. Unfiltered is what was trained or
// altered for adult content: NSFW fine-tunes and abliterated text encoders
// (owner's decision, 08.10.2026). An official Wan has no content filter, and
// is still an official model.
//
// "Experimental: not yet tested in LU." marks an entry that is backed by the
// engine's source, the hub API and the safetensors headers, and has never
// been run here.
const CATALOG: &[CatalogEntry] = &[
    // First on the Mainstream side, and the starter of Create: the one video
    // model that has run here and is fast (M5 Pro 48 GB, 09.10.2026: two
    // seconds of 768 x 512 with sound in 64 s, at a peak of 14.0 GB). A tile
    // grid shows the catalogue in this order.
    CatalogEntry {
        id: "ltx-2.3-q4",
        name: "LTX-2.3 Distilled 4-bit",
        family: ltx2mlx::FAMILY,
        repo: "dgrauet/ltx-2.3-mlx-q4",
        repo_files: ltx2mlx::PACK_23_V11,
        pipeline: "distilled",
        size_gb: 20.5,
        min_ram_gb: 16,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        text_encoder_repo: LTX23_TEXT_ENCODER,
        starter: true,
        // 64 seconds for a clip of two (10.10.2026). One run.
        measured_run_s_per_clip_s: 32.0,
        // The dev transformer of the same repository, 4-bit like the rest.
        talking_gb: 11.3,
        description: "LTX-2.3 in 4-bit, ready to run with no convert step. Video with sound from text or from an image, for Macs from 16 GB.",
        ..ENTRY
    },
    CatalogEntry {
        id: "wan21-t2v-1.3b",
        name: "Wan 2.1 T2V 1.3B",
        family: "wan_2",
        repo: "Wan-AI/Wan2.1-T2V-1.3B",
        size_gb: 18.0,
        min_ram_gb: 16,
        default_width: 832,
        default_height: 480,
        needs_convert: true,
        // 28.5 minutes for 81 frames (09.10.2026) and fifty steps of about
        // 45 seconds for 105 frames (10.10.2026): both come to this.
        measured_run_s_per_clip_s: 345.0,
        description: "Slow on a Mac: about half an hour for five seconds on an M5 Pro, and without sound. 480p text to video, with a one-time convert step after the download.",
        ..ENTRY
    },
    CatalogEntry {
        id: "wan22-ti2v-5b-q8",
        name: "Wan 2.2 TI2V 5B 8-bit",
        family: "wan_2",
        repo: "Anes1032/Wan2.2-TI2V-5B-mlx-q8",
        size_gb: 19.6,
        min_ram_gb: 32,
        accepts_image: true,
        description: "The 5B model in 8-bit, ready to run with no convert step and at half the download. 720p from text or from an image. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "ltx-2.5-q4",
        name: "LTX-2.5 Distilled 4-bit",
        family: ltx2mlx::FAMILY,
        repo: "dgrauet/ltx-2.5-mlx-q4",
        repo_files: ltx2mlx::PACK_25,
        pipeline: "distilled",
        size_gb: 28.8,
        min_ram_gb: 24,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        description: "The newest LTX generation in 4-bit, with its text encoder in the download. Its repository asks for a free Hugging Face token. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "ltx-2.3-q8",
        name: "LTX-2.3 Distilled 8-bit",
        family: ltx2mlx::FAMILY,
        repo: "dgrauet/ltx-2.3-mlx-q8",
        repo_files: ltx2mlx::PACK_23_V11,
        pipeline: "distilled",
        size_gb: 29.8,
        min_ram_gb: 24,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        text_encoder_repo: LTX23_TEXT_ENCODER,
        description: "LTX-2.3 in 8-bit, ready to run with no convert step. Closer to full quality than 4-bit, for Macs from 24 GB. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "wan22-ti2v-5b",
        name: "Wan 2.2 TI2V 5B",
        family: "wan_2",
        repo: "Wan-AI/Wan2.2-TI2V-5B",
        size_gb: 35.0,
        min_ram_gb: 32,
        needs_convert: true,
        accepts_image: true,
        description: "720p from text or from an image in one 5B model. The balanced pick for 32 GB Macs.",
        ..ENTRY
    },
    CatalogEntry {
        id: "ltx-2.5-q8",
        name: "LTX-2.5 Distilled 8-bit",
        family: ltx2mlx::FAMILY,
        repo: "dgrauet/ltx-2.5-mlx-q8",
        repo_files: ltx2mlx::PACK_25,
        pipeline: "distilled",
        size_gb: 43.5,
        min_ram_gb: 32,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        description: "The newest LTX generation in 8-bit, with its text encoder in the download. Its repository asks for a free Hugging Face token. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "ltx-2.3-bf16",
        name: "LTX-2.3 Distilled Full Precision",
        family: ltx2mlx::FAMILY,
        repo: "dgrauet/ltx-2.3-mlx",
        repo_files: ltx2mlx::PACK_23_V11,
        pipeline: "distilled",
        size_gb: 47.1,
        min_ram_gb: 48,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        text_encoder_repo: LTX23_TEXT_ENCODER,
        description: "LTX-2.3 with nothing rounded away, ready to run with no convert step. Below 64 GB it is read from disk block by block, which is slower. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "ltx-2.3-distilled-1.1",
        name: "LTX-2.3 Distilled 1.1",
        family: "ltx_2",
        repo: "Lightricks/LTX-2.3",
        repo_files: &["ltx-2.3-22b-distilled-1.1.safetensors", "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"],
        pipeline: "distilled",
        size_gb: 47.1,
        min_ram_gb: 64,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        needs_convert: true,
        text_encoder_repo: LTX23_TEXT_ENCODER,
        description: "The newest fast LTX-2.3 weights from the official release, converted once after the download. Half the download of LTX-2.3 Distilled. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "ltx-2.3-dev",
        name: "LTX-2.3 Dev",
        family: "ltx_2",
        repo: "prince-canuma/LTX-2.3-dev",
        pipeline: "dev",
        size_gb: 58.0,
        min_ram_gb: 64,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        text_encoder_repo: LTX23_TEXT_ENCODER,
        description: "The current LTX generation at full quality. Text to video with sound.",
        ..ENTRY
    },
    CatalogEntry {
        id: "wan21-t2v-14b-q4",
        name: "Wan 2.1 T2V 14B 4-bit",
        family: "wan_2",
        repo: "Wan-AI/Wan2.1-T2V-14B",
        size_gb: 70.0,
        min_ram_gb: 48,
        needs_convert: true,
        quant_bits: 4,
        description: "The 14B Wan, reduced to 4-bit during the one-time convert. Lighter to run and half the size on disk, with some loss in detail. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "wan21-t2v-14b",
        name: "Wan 2.1 T2V 14B",
        family: "wan_2",
        repo: "Wan-AI/Wan2.1-T2V-14B",
        size_gb: 70.0,
        min_ram_gb: 48,
        needs_convert: true,
        description: "720p Wan at the full 14B size, with a one-time convert step after the download.",
        ..ENTRY
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
        text_encoder_repo: LTX23_TEXT_ENCODER,
        description: "The fast LTX-2.3 with its upscaler stages. High resolution video with sound on 64 GB Macs.",
        ..ENTRY
    },
    CatalogEntry {
        id: "ltx-2-dev",
        name: "LTX-2 Dev",
        family: "ltx_2",
        repo: "prince-canuma/LTX-2-dev",
        pipeline: "dev",
        size_gb: 101.0,
        min_ram_gb: 64,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        accepts_image: true,
        description: "The 19B LTX-2 at full quality, slower than its distilled form. Video with sound, from text or from an image. Experimental: not yet tested in LU.",
        ..ENTRY
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
        accepts_image: true,
        description: "The 19B LTX-2 in its fast form. Video with sound, from text or from an image.",
        ..ENTRY
    },
    CatalogEntry {
        id: "wan22-t2v-a14b",
        name: "Wan 2.2 T2V A14B",
        family: "wan_2",
        repo: "Wan-AI/Wan2.2-T2V-A14B",
        size_gb: 127.0,
        min_ram_gb: 96,
        needs_convert: true,
        description: "The Wan 2.2 flagship with two expert models. The strongest video model a Mac can run, for 96 GB and more.",
        ..ENTRY
    },
    CatalogEntry {
        id: "wan22-i2v-a14b",
        name: "Wan 2.2 I2V A14B",
        family: "wan_2",
        repo: "Wan-AI/Wan2.2-I2V-A14B",
        size_gb: 127.0,
        min_ram_gb: 96,
        needs_convert: true,
        requires_image: true,
        description: "The Wan 2.2 flagship for image to video, with two expert models. It needs a start image and 96 GB or more. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    // ── Unfiltered ────────────────────────────────────────────────────
    CatalogEntry {
        id: "nsfw-wan21-1.3b",
        name: "NSFW Wan 1.3B",
        family: "wan_2",
        repo: "NSFW-API/NSFW_Wan_1.3b",
        repo_files: &["wan_1.3B_e20.safetensors"],
        base_repo: "Wan-AI/Wan2.1-T2V-1.3B",
        size_gb: 14.7,
        min_ram_gb: 16,
        default_width: 832,
        default_height: 480,
        needs_convert: true,
        unfiltered: true,
        description: "Wan 2.1 1.3B fine-tuned for adult content. 480p text to video, the smallest model on this side. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "sulphur-2-distill-q4",
        name: "Sulphur 2 Distilled 4-bit",
        family: ltx2mlx::FAMILY,
        repo: "MLXBits/sulphur-2-distill-mlx-q4",
        repo_files: ltx2mlx::PACK_23,
        pipeline: "distilled",
        size_gb: 19.9,
        min_ram_gb: 32,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        text_encoder_repo: LTX23_TEXT_ENCODER,
        unfiltered: true,
        description: "Sulphur 2, an adult fine-tune of LTX-2.3, in 4-bit. Its makers name 32 GB as the least it was run on. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "ltx-2.3-q4-abliterated",
        name: "LTX-2.3 Distilled 4-bit Abliterated",
        family: ltx2mlx::FAMILY,
        repo: "dgrauet/ltx-2.3-mlx-q4",
        repo_files: ltx2mlx::PACK_23_V11,
        pipeline: "distilled",
        size_gb: 20.5,
        min_ram_gb: 16,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        text_encoder_repo: LTX23_ABLITERATED_TEXT_ENCODER,
        shares_weights_with: "ltx-2.3-q4",
        unfiltered: true,
        description: "LTX-2.3 in 4-bit read through an abliterated Gemma text encoder. It runs on the weights of LTX-2.3 Distilled 4-bit, so with that one installed only the encoder is fetched. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "10eros-v1.3-dmd-q4",
        name: "LTX-2.3 10Eros v1.3 DMD 4-bit",
        family: ltx2mlx::FAMILY,
        repo: "MLXBits/ltx-2.3-10eros-v1.3-dmd-mlx-q4",
        repo_files: ltx2mlx::PACK_23,
        pipeline: "distilled",
        size_gb: 21.6,
        min_ram_gb: 16,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        text_encoder_repo: LTX23_TEXT_ENCODER,
        unfiltered: true,
        description: "The 10Eros adult fine-tune of LTX-2.3 in 4-bit, ready to run with no convert step. Video with sound from text or from an image, for Macs from 16 GB. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "10eros-v1.3-dmd-q8",
        name: "LTX-2.3 10Eros v1.3 DMD 8-bit",
        family: ltx2mlx::FAMILY,
        repo: "MLXBits/ltx-2.3-10eros-v1.3-dmd-mlx-q8",
        repo_files: ltx2mlx::PACK_23_V11,
        pipeline: "distilled",
        size_gb: 29.7,
        min_ram_gb: 24,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        text_encoder_repo: LTX23_TEXT_ENCODER,
        unfiltered: true,
        description: "10Eros v1.3 in 8-bit, ready to run with no convert step. Closer to full quality than 4-bit, for Macs from 24 GB. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "10eros-v1.5-dmd-hybrid-q8",
        name: "LTX-2.3 10Eros v1.5 DMD Hybrid 8-bit",
        family: ltx2mlx::FAMILY,
        repo: "MLXBits/ltx-2.3-10eros-v1.5-dmd-hybrid-mlx-q8",
        repo_files: ltx2mlx::PACK_23_V11,
        pipeline: "distilled",
        size_gb: 29.7,
        min_ram_gb: 24,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        text_encoder_repo: LTX23_TEXT_ENCODER,
        unfiltered: true,
        description: "The newest 10Eros in 8-bit, ready to run with no convert step. Video with sound from text or from an image, for Macs from 24 GB. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "ltx-2.3-q8-abliterated",
        name: "LTX-2.3 Distilled 8-bit Abliterated",
        family: ltx2mlx::FAMILY,
        repo: "dgrauet/ltx-2.3-mlx-q8",
        repo_files: ltx2mlx::PACK_23_V11,
        pipeline: "distilled",
        size_gb: 29.8,
        min_ram_gb: 24,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        text_encoder_repo: LTX23_ABLITERATED_TEXT_ENCODER,
        shares_weights_with: "ltx-2.3-q8",
        unfiltered: true,
        description: "LTX-2.3 in 8-bit read through an abliterated Gemma text encoder. It runs on the weights of LTX-2.3 Distilled 8-bit, so with that one installed only the encoder is fetched. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "nsfw-wan21-14b-q4",
        name: "NSFW Wan 14B 4-bit",
        family: "wan_2",
        repo: "NSFW-API/NSFW_Wan_14b",
        repo_files: &["nsfw_wan_14b_e15.safetensors"],
        base_repo: "Wan-AI/Wan2.1-T2V-14B",
        size_gb: 40.5,
        min_ram_gb: 48,
        needs_convert: true,
        quant_bits: 4,
        unfiltered: true,
        description: "The adult fine-tune of Wan 2.1 14B, reduced to 4-bit during the one-time convert. Lighter to run, with some loss in detail. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "nsfw-wan21-14b",
        name: "NSFW Wan 14B",
        family: "wan_2",
        repo: "NSFW-API/NSFW_Wan_14b",
        repo_files: &["nsfw_wan_14b_e15.safetensors"],
        base_repo: "Wan-AI/Wan2.1-T2V-14B",
        size_gb: 40.5,
        min_ram_gb: 48,
        needs_convert: true,
        unfiltered: true,
        description: "Wan 2.1 14B fine-tuned for adult content. 720p text to video, with a one-time convert step after the download. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "ltx23-10eros",
        name: "LTX-2.3 10Eros v1.5",
        family: "ltx_2",
        repo: "TenStrip/LTX2.3-10Eros",
        repo_files: &["10Eros_v1.5_bf16.safetensors"],
        pipeline: "dev",
        size_gb: 46.1,
        min_ram_gb: 64,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        needs_convert: true,
        text_encoder_repo: LTX23_TEXT_ENCODER,
        unfiltered: true,
        description: "The most downloaded adult fine-tune of LTX-2.3. Text to video with sound, converted once after the download. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "ltx23-10eros-abliterated",
        name: "LTX-2.3 10Eros v1.5 Abliterated",
        family: "ltx_2",
        repo: "TenStrip/LTX2.3-10Eros",
        repo_files: &["10Eros_v1.5_bf16.safetensors"],
        pipeline: "dev",
        size_gb: 46.1,
        min_ram_gb: 64,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        needs_convert: true,
        text_encoder_repo: LTX23_ABLITERATED_TEXT_ENCODER,
        shares_weights_with: "ltx23-10eros",
        unfiltered: true,
        description: "10Eros read through an abliterated Gemma text encoder. It runs on the weights of LTX-2.3 10Eros v1.5, so with that one installed only the encoder is fetched. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "ltx23-pinkcherry",
        name: "PinkCherry LTX-2.3 v1.8",
        family: "ltx_2",
        repo: "SexGod1979/PinkCherry_NSFW_LTX23",
        repo_files: &["v1.8/PinkCherry_FineTune_bf16_v1_8_LTX23.safetensors"],
        pipeline: "dev",
        size_gb: 46.1,
        min_ram_gb: 64,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        needs_convert: true,
        text_encoder_repo: LTX23_TEXT_ENCODER,
        unfiltered: true,
        description: "An adult fine-tune of LTX-2.3 Dev. Text to video with sound, converted once after the download. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "ltx-2.3-dev-abliterated",
        name: "LTX-2.3 Dev Abliterated",
        family: "ltx_2",
        repo: "prince-canuma/LTX-2.3-dev",
        pipeline: "dev",
        size_gb: 58.0,
        min_ram_gb: 64,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        text_encoder_repo: LTX23_ABLITERATED_TEXT_ENCODER,
        shares_weights_with: "ltx-2.3-dev",
        unfiltered: true,
        description: "LTX-2.3 Dev read through an abliterated Gemma text encoder. It runs on the weights of LTX-2.3 Dev, so with that one installed only the encoder is fetched. Experimental: not yet tested in LU.",
        ..ENTRY
    },
    CatalogEntry {
        id: "ltx-2.3-distilled-abliterated",
        name: "LTX-2.3 Distilled Abliterated",
        family: "ltx_2",
        repo: "prince-canuma/LTX-2.3-distilled",
        pipeline: "distilled",
        size_gb: 96.0,
        min_ram_gb: 64,
        default_frames: 49,
        default_width: 768,
        default_height: 512,
        text_encoder_repo: LTX23_ABLITERATED_TEXT_ENCODER,
        shares_weights_with: "ltx-2.3-distilled",
        unfiltered: true,
        description: "The fast LTX-2.3 read through an abliterated Gemma text encoder. It runs on the weights of LTX-2.3 Distilled, so with that one installed only the encoder is fetched. Experimental: not yet tested in LU.",
        ..ENTRY
    },
];

fn catalog_lookup(id: &str) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|c| c.id == id)
}

/// The frames a second the engine writes a model's video at. Read from the
/// engines' sources, 09.10.2026:
///   wan_2   `config.sample_fps`, which the convert takes from the checkpoint:
///           16 for Wan 2.1 and the Wan 2.2 14B pair, 24 for Wan 2.2 TI2V 5B
///           (`wan_2/config.py`, and `generate.py` corrects a stale config to
///           24 when it sees the 48 channels of that model).
///   ltx_2   `--fps`, default 24, and this app passes none.
///   ltx_2q  `--frame-rate`, which this app always passes as 24.
/// The interface turns a length in seconds into frames with this number, and
/// `video_generate` does the same, whatever `fps` a caller sends along.
fn frame_rate(c: &CatalogEntry) -> u32 {
    if c.family == "wan_2" && !c.repo.contains("TI2V-5B") {
        16
    } else {
        ltx2mlx::FRAME_RATE
    }
}

/// Whether a negative prompt reaches the model. Wan samples with guidance and
/// takes one (`--negative-prompt`, otherwise its config's own). The first
/// engine's LTX takes one in the dev pipelines, which run guidance, and
/// ignores it in the distilled one. The second engine runs distilled alone and
/// ends with an error on the flag.
fn takes_negative_prompt(c: &CatalogEntry) -> bool {
    match c.family {
        "wan_2" => true,
        "ltx_2" => c.pipeline != "distilled",
        _ => false,
    }
}

// ── Size and steps of a run ───────────────────────────────────────────
//
// Read from the engines at their pinned commits, 14.10.2026:
//   ltx_2q  `generate --distilled` takes `-W` and `-H` and floors both to a
//           multiple of 64 (`snap_output_dimensions(two_stage=True)` in
//           `ltx_core_mlx/components/patchifiers.py`, called from
//           `ltx_pipelines_mlx/distilled.py`): stage one runs at half size on
//           the VAE's grid of 32. `--steps` is read by the one stage pipeline
//           alone; the distilled one runs its own table of eight plus three
//           steps, and `--stage1-steps` could only cut that table short.
//   wan_2   `--width` and `--height` are floored to patch size times VAE
//           stride (`wan_2/generate.py`): 2 x 8 = 16, and 2 x 16 = 32 for
//           TI2V 5B, whose VAE strides by 16 (`wan_2/config.py`). TI2V 5B
//           and I2V A14B cap the area at 1280 x 704. `--steps` goes to the
//           sampler as it is; without it the config's `sample_steps` runs:
//           50 on Wan 2.1, 40 on Wan 2.2.
//   ltx_2   the first engine's LTX (`mlx_video.models.ltx_2.generate`) takes
//           `--width` and `--height` and asserts both on 64 for its two
//           stage pipelines (distilled, dev-two-stage) and on 32 for `dev`.
//           Without them it ran at its own 512 x 512, so a landscape entry
//           came out square. No steps: this app hands it none.

/// The shortest side Create offers. On every grid above.
const MIN_SIDE: u32 = 256;
/// The longest side Create offers: the long side of Wan's 720p.
const MAX_SIDE: u32 = 1280;
/// The most steps a run takes, as the slider of the other lanes.
const MAX_STEPS: u32 = 60;

/// The grid both sides of a run sit on, or `None` for a model that runs at
/// its entry's size whatever is asked.
fn size_grid(c: &CatalogEntry) -> Option<u32> {
    match c.family {
        f if f == ltx2mlx::FAMILY => Some(64),
        "ltx_2" if c.pipeline == "dev" => Some(32),
        "ltx_2" => Some(64),
        "wan_2" if c.repo.contains("TI2V-5B") => Some(32),
        "wan_2" => Some(16),
        _ => None,
    }
}

/// The most pixels a run may have: the entry's own size. The memory a model
/// is recommended for and the time a run was measured at belong to that size,
/// so nothing larger is offered, only other shapes and smaller ones. For TI2V
/// 5B and I2V A14B it is the engine's own cap as well.
fn max_pixels(c: &CatalogEntry) -> u32 {
    c.default_width * c.default_height
}

/// The steps a run of this model takes when nobody asks for others, or
/// `None` for a model whose steps cannot be set (see above).
fn default_steps(c: &CatalogEntry) -> Option<u32> {
    match c.family {
        "wan_2" if c.id.contains("wan21") => Some(50),
        "wan_2" => Some(40),
        _ => None,
    }
}

/// The size a run goes out at: the entry's own where none is asked or the
/// model takes none, else the asked size, which has to be what Create offers.
/// A size the engine would quietly floor or shrink is refused here in words.
fn run_size(c: &CatalogEntry, width: Option<u32>, height: Option<u32>) -> Result<(u32, u32), String> {
    let own = (c.default_width, c.default_height);
    let Some(grid) = size_grid(c) else { return Ok(own) };
    let (w, h) = match (width, height) {
        (None, None) => return Ok(own),
        (Some(w), Some(h)) => (w, h),
        _ => return Err("Pass both width and height, or neither for the model's own size.".to_string()),
    };
    if w % grid != 0 || h % grid != 0 {
        return Err(format!("{} takes sizes in steps of {grid} px, and {w} x {h} is not one.", c.name));
    }
    if !(MIN_SIDE..=MAX_SIDE).contains(&w) || !(MIN_SIDE..=MAX_SIDE).contains(&h) {
        return Err(format!("A side of a video on a Mac is {MIN_SIDE} to {MAX_SIDE} px, and {w} x {h} is outside that."));
    }
    if w * h > max_pixels(c) {
        return Err(format!(
            "{w} x {h} is larger than {} x {}, the size {} runs at. Pick a smaller size.",
            c.default_width, c.default_height, c.name
        ));
    }
    Ok((w, h))
}

/// The steps a run goes out with, `None` for the engine's own. A model that
/// takes none is refused only when a number was asked for.
fn run_steps(c: &CatalogEntry, steps: Option<u32>) -> Result<Option<u32>, String> {
    match (steps, default_steps(c)) {
        (None, _) => Ok(None),
        (Some(_), None) => Err(format!("{} runs its own steps on a Mac, and takes no step count.", c.name)),
        (Some(s), Some(_)) if (1..=MAX_STEPS).contains(&s) => Ok(Some(s)),
        (Some(s), Some(_)) => Err(format!("{} takes 1 to {MAX_STEPS} steps, not {s}.", c.name)),
    }
}

// ── Filesystem layout ─────────────────────────────────────────────────

pub(crate) fn models_root() -> PathBuf {
    crate::media_store::active_root(crate::media_store::Store::Video)
}

pub(crate) fn outputs_root() -> PathBuf {
    crate::os_paths::config_root().join("videos")
}

fn model_dir(id: &str) -> PathBuf {
    models_root().join(id)
}

/// K5: `huggingface_hub`'s Xet chunk cache ignores `local_dir`: it only
/// follows `HF_HOME` (and, since `hf_xet` split out of the main package,
/// `HF_XET_CACHE`). Without either set, it falls back to
/// `~/.cache/huggingface[/xet]`, on the SYSTEM drive, regardless of which
/// drive `models_root()` was pointed at. `commands::mlx.rs` already gets
/// this right (`.env("HF_HOME", mlx_root().join("cache"))` at every
/// `snapshot_download`/`hf_hub_download` call); this is the same fix for the
/// one call site in this file that was missing it.
///
/// It is download scratch that no model reads again, so on a Mac it stays in
/// the app's cache folder while the models live under its data folder.
fn hf_home_dir() -> PathBuf {
    crate::media_store::scratch_root(crate::media_store::Store::Video).join(".hf-cache")
}

/// The entry whose folder holds the weights: the entry itself, or the one it
/// names in `shares_weights_with`.
fn weights_owner(entry: &CatalogEntry) -> &CatalogEntry {
    if entry.shares_weights_with.is_empty() {
        return entry;
    }
    catalog_lookup(entry.shares_weights_with).unwrap_or(entry)
}

/// Directory the generate CLI actually points at: the converted MLX weights
/// (`<id>/mlx`) for an entry that converts, the download itself otherwise.
fn weights_dir(entry: &CatalogEntry) -> PathBuf {
    let owner = weights_owner(entry);
    if owner.needs_convert {
        model_dir(owner.id).join("mlx")
    } else {
        model_dir(owner.id)
    }
}

fn dir_non_empty(dir: &PathBuf) -> bool {
    dir.is_dir() && std::fs::read_dir(dir).map(|mut it| it.next().is_some()).unwrap_or(false)
}

/// Where a shared text encoder is kept: beside the models, under its own
/// repository name, so two entries that name the same one download it once.
fn text_encoder_dir(repo: &str) -> PathBuf {
    models_root().join("_encoders").join(repo.replace('/', "--"))
}

/// A text encoder counts as there once its config and at least one weights
/// file are on disk. An aborted pull leaves the folder and neither of those.
fn text_encoder_present(dir: &std::path::Path) -> bool {
    dir.join("config.json").is_file()
        && std::fs::read_dir(dir)
            .map(|it| it.flatten().any(|e| e.path().extension().is_some_and(|x| x == "safetensors")))
            .unwrap_or(false)
}

/// Lies in a model's folder from the moment its weights start to arrive until
/// they are complete. A download or a convert that was stopped leaves it
/// behind, and that is how a half model is told from a whole one: a folder
/// that merely has something in it proved nothing.
const INSTALLING_MARKER: &str = ".lu-installing";
/// Written when a convert ran to its end, before the source is removed.
const CONVERTED_MARKER: &str = ".lu-converted";

fn installing_marker(owner: &CatalogEntry) -> PathBuf {
    model_dir(owner.id).join(INSTALLING_MARKER)
}

fn converted_marker(owner: &CatalogEntry) -> PathBuf {
    model_dir(owner.id).join(CONVERTED_MARKER)
}

/// Where a converting entry keeps its download until the convert is through.
fn convert_source_dir(owner: &CatalogEntry) -> PathBuf {
    model_dir(owner.id).join("src")
}

/// Whether the weights in `owner`'s folder are complete.
///
/// A convert is complete with its marker. One from before the marker existed
/// has `<id>/mlx` and no `<id>/src`: the source was removed as the last step,
/// so one that is still there means the convert never got to the end. A plain
/// download is complete when nothing says it is still under way.
fn weights_ready(owner: &CatalogEntry) -> bool {
    if !dir_non_empty(&weights_dir(owner)) {
        return false;
    }
    if owner.needs_convert && converted_marker(owner).exists() {
        return true;
    }
    if installing_marker(owner).exists() {
        return false;
    }
    !(owner.needs_convert && convert_source_dir(owner).exists())
}

fn model_is_installed(entry: &CatalogEntry) -> bool {
    // The LTX-2.3 repositories ship no text encoder. Until 3.0.6 nothing
    // fetched one, so the model read "installed" and every generation ended
    // in the loader with a missing `text_config`. An entry that names an
    // encoder is installed only with it, which also makes Get on a model from
    // that time fetch the one missing piece instead of everything again.
    weights_ready(weights_owner(entry))
        && (entry.text_encoder_repo.is_empty() || text_encoder_present(&text_encoder_dir(entry.text_encoder_repo)))
        && (entry.shares_weights_with.is_empty() || encoder_claim(entry).is_file())
}

/// Installed, and with the engine its family runs on. This is what a tile
/// and Generate ask. The second engine arrives with the first model of its
/// family, so a model whose engine is gone (or is from an older pin) reads
/// "not installed", and Get brings the engine back without fetching the
/// weights again. Remove keeps asking `model_is_installed`: it is about files.
fn model_is_usable(entry: &CatalogEntry) -> bool {
    model_is_installed(entry) && (entry.family != ltx2mlx::FAMILY || ltx2mlx::engine_ready())
}

/// Whether the entry can run a Talking Character (`ltx2mlx::A2V_CLI`) at all.
fn talks(entry: &CatalogEntry) -> bool {
    entry.talking_gb > 0.0 && entry.family == ltx2mlx::FAMILY
}

/// Whether a Talking Character run of `entry` can start: the model is usable
/// and the files its `a2v` reads on top are on disk.
fn talking_ready(entry: &CatalogEntry) -> bool {
    talks(entry) && model_is_usable(entry) && ltx2mlx::talking_files_present(&weights_dir(entry))
}

/// A Talking Character run streams the dev transformer, then the distilled
/// one, beside Gemma and the VAE. A clip of four seconds at 768 x 512 peaked
/// at a footprint of 17.0 GB on a Mac with 48 GB, streamed and with the
/// decode capped (`ltx2mlx::TALKING_DECODE_BUDGET_GB`; real run, 15.10.2026).
/// A Mac with 16 GB would swap through that, so the run starts from 24 GB.
const TALKING_MIN_RAM_GB: u32 = 24;

/// The sentence a Talking Character run is refused with on a Mac with less
/// memory than that, or `None`.
fn talking_needs_more_memory(entry: &CatalogEntry, total_bytes: u64) -> Option<String> {
    if total_bytes == 0 {
        return None;
    }
    let have_gb = (total_bytes as f64 / 1_073_741_824.0).round() as u32;
    let need = TALKING_MIN_RAM_GB.max(entry.min_ram_gb);
    (have_gb < need).then(|| {
        format!(
            "Talking Character on {} needs a Mac with {need} GB of memory, and this one has {have_gb} GB. It was not started, because loading it would freeze this Mac.",
            entry.name
        )
    })
}

/// The record that an entry on shared weights was installed.
///
/// Such an entry is a sibling's weights plus an encoder, and both can be on
/// disk for other reasons: with LTX-2.3 Dev, LTX-2.3 Distilled and one
/// abliterated variant installed, the other abliterated variant had every
/// file it needs and read as installed without anyone having asked for it.
/// Each then kept the encoder for the other, and neither could be removed.
/// It lies in the encoder's folder, so it cannot outlive the encoder.
fn encoder_claim(entry: &CatalogEntry) -> PathBuf {
    text_encoder_dir(entry.text_encoder_repo).join(format!(".lu-used-by-{}", entry.id))
}

/// Whether `entry` is a reason to keep its text encoder.
fn uses_its_encoder(entry: &CatalogEntry) -> bool {
    if entry.shares_weights_with.is_empty() {
        dir_non_empty(&weights_dir(entry))
    } else {
        encoder_claim(entry).is_file()
    }
}

/// Bytes under `dir`, 0 when it is not there. The same walk as
/// `install_state::dir_size`, which is private to its module.
fn dir_bytes(dir: &std::path::Path) -> u64 {
    let Ok(read) = std::fs::read_dir(dir) else {
        return 0;
    };
    read.flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_bytes(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

// ── mlx-video CLI detection ───────────────────────────────────────────

/// The venv the image engine builds (`commands::mlx`). With it there, the
/// video engine installs into it, as it always has.
fn shared_venv_dir() -> PathBuf {
    crate::os_paths::data_dir().join("mlx").join("venv")
}

/// The venv the video engine builds for itself when there is no other.
fn own_venv_dir() -> PathBuf {
    crate::os_paths::data_dir().join("mlx-video").join("venv")
}

fn venv_python(venv: &std::path::Path) -> PathBuf {
    venv.join("bin").join("python")
}

/// The interpreter the video engine runs in: always one inside a venv.
///
/// Until 3.0.6 a Mac without the image engine fell through to the system
/// Python, and `pip install` there ends in "externally-managed-environment"
/// with Homebrew (PEP 668) or lands in `~/Library/Python/3.9` with the one
/// Apple ships. A venv of its own comes first once it exists, so that setting
/// up the image engine later does not move the video engine to a venv that
/// has no `mlx_video` in it.
fn pick_engine_python(own_venv: &std::path::Path, shared_venv: &std::path::Path) -> Option<PathBuf> {
    [own_venv, shared_venv].into_iter().map(venv_python).find(|p| p.exists())
}

pub(crate) fn engine_python() -> Option<String> {
    pick_engine_python(&own_venv_dir(), &shared_venv_dir()).map(|p| p.to_string_lossy().to_string())
}

/// The order in which interpreters are asked for their version. `/usr/bin`
/// goes last: without the Command Line Tools its `python3` is a stub that
/// opens an install dialog when it is started.
fn order_base_candidates(mut candidates: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|c| !c.is_empty() && seen.insert(c.clone()));
    candidates.sort_by_key(|c| c.starts_with("/usr/bin/"));
    candidates
}

pub(crate) fn python_version(python: &str) -> Option<(u32, u32)> {
    let out = crate::python::python_command(python)
        .args(["-c", "import sys; print(sys.version_info[0], sys.version_info[1])"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.split_whitespace().map(|p| p.parse::<u32>().ok());
    Some((parts.next()??, parts.next()??))
}

/// The Python versions an engine's pinned packages have wheels for on an
/// Apple Silicon Mac (GH #188).
///
/// The pins are exact, so pip cannot reach for a newer release that knows a
/// newer Python. Homebrew's 3.15 took the MLX image engine down with "No
/// matching distribution found for torch==2.13.0". Read on PyPI on
/// 26.10.2026, the macOS arm64 wheels of every pin: torch 2.12.1 and 2.13.0
/// cp310 to cp314, mlx 0.31.2, 0.32.0 and 0.32.2 up to cp314, none of them
/// cp315. numpy 2.5.3 (LTX-2 MLX) and scipy 1.18.0 (mlx-video) ask for 3.12
/// or newer, numpy 2.4.x has no cp310 wheel. A bound moves only together with
/// the pins, and `the_python_ranges_were_read_for_these_pins` says when.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PythonRange {
    pub min: (u32, u32),
    pub max: (u32, u32),
}

impl PythonRange {
    pub(crate) fn fits(self, version: (u32, u32)) -> bool {
        self.min <= version && version <= self.max
    }

    /// "3.11 to 3.14", for the log and the sentence the customer reads.
    pub(crate) fn label(self) -> String {
        format!("{}.{} to {}.{}", self.min.0, self.min.1, self.max.0, self.max.1)
    }
}

/// The diffusers sidecar (`resources/mlx/requirements.txt`) and mflux.
pub(crate) const TORCH_ENGINES_PYTHON: PythonRange = PythonRange { min: (3, 11), max: (3, 14) };
/// mlx-video and LTX-2 MLX.
pub(crate) const VIDEO_ENGINES_PYTHON: PythonRange = PythonRange { min: (3, 12), max: (3, 14) };

/// Whether a venv's interpreter is one the range allows. A venv a 3.15 left
/// behind answers pip, and pip would fail inside it on every retry, so it is
/// built again instead.
pub(crate) fn venv_python_fits(python: &str, range: PythonRange) -> bool {
    python_version(python).is_some_and(|v| range.fits(v))
}

/// The interpreter picked, and every one passed over with its version.
type BasePick = (Option<String>, Vec<(String, (u32, u32))>);

/// The first candidate whose version the range allows, and every one that
/// answered with a version outside it, for the log.
fn pick_base_python(
    candidates: impl IntoIterator<Item = String>,
    version_of: impl Fn(&str) -> Option<(u32, u32)>,
    range: PythonRange,
) -> BasePick {
    let mut passed_over = Vec::new();
    for candidate in candidates {
        match version_of(&candidate) {
            Some(v) if range.fits(v) => return (Some(candidate), passed_over),
            Some(v) => passed_over.push((candidate, v)),
            None => {}
        }
    }
    (None, passed_over)
}

/// An interpreter a venv can be built from, inside the engine's range.
fn locate_base_python(preferred: Option<String>, range: PythonRange) -> BasePick {
    let on_path = crate::os_paths::find_python().map(|p| p.to_string_lossy().to_string());
    let candidates = preferred.into_iter().chain(on_path).chain(crate::python::python_interpreters()).collect();
    // What is found on the machine comes first. The Python LU downloaded for
    // itself, when the machine had none, is asked last.
    let all = order_base_candidates(candidates)
        .into_iter()
        .chain(crate::private_python::installed().map(|p| p.to_string_lossy().to_string()));
    pick_base_python(all, python_version, range)
}

/// The interpreter a venv is built from: one found on this Mac, otherwise the
/// one LU fetches into its own data folder. The download is a step of the
/// setup that asked, with its log lines, its progress and its cancel.
pub(super) fn base_python_or_own(
    slot: &crate::install_state::InstallSlot,
    preferred: Option<String>,
    range: PythonRange,
) -> Result<String, String> {
    let (found, passed_over) = locate_base_python(preferred, range);
    for (python, (major, minor)) in &passed_over {
        slot.log(format!(
            "passing over Python {major}.{minor} at {python}: this engine's packages are built for Python {} only",
            range.label()
        ));
    }
    match found {
        Some(found) => Ok(found),
        None => {
            let log = format!("no Python {} on this computer", range.label());
            let sentence = format!("This computer has no Python {}", range.label());
            crate::private_python::ensure_for(slot, crate::private_python::Why { log: &log, sentence: &sentence })
                .map(|p| p.to_string_lossy().to_string())
        }
    }
}

/// `<base> -m venv <dir>`, replacing whatever a stopped attempt left there.
fn create_venv(slot: &crate::install_state::InstallSlot, base: &str, venv: &std::path::Path) -> Result<(), String> {
    if let Some(parent) = venv.parent() {
        std::fs::create_dir_all(parent).map_err(|e| os_error::english(&e))?;
    }
    slot.log(format!("creating the video engine environment at {}", venv.display()));
    let mut cmd = crate::python::python_command(base);
    cmd.args(["-m", "venv", "--clear"]).arg(venv.as_os_str());
    run_streamed(slot, &mut cmd).map_err(|e| format!("Could not create the Python environment for the video engine. {e}"))?;
    if !venv_python(venv).exists() {
        return Err("Python reported a new environment, but there is no interpreter in it.".to_string());
    }
    Ok(())
}

/// The venv interpreter to install into, built first when there is none.
///
/// A venv whose `pip` does not answer is one whose creation was stopped
/// halfway. The shared one belongs to the image engine and is left alone; the
/// video engine then builds its own.
fn ensure_engine_python(
    slot: &crate::install_state::InstallSlot,
    preferred_base: Option<String>,
) -> Result<String, String> {
    let own = own_venv_dir();
    let usable = |venv: &std::path::Path| {
        let python = venv_python(venv);
        let text = python.to_string_lossy().to_string();
        (python.exists() && python_has_module(&text, "pip") && venv_python_fits(&text, VIDEO_ENGINES_PYTHON)).then_some(text)
    };
    if let Some(python) = usable(&own) {
        return Ok(python);
    }
    if !venv_python(&own).exists() {
        if let Some(python) = usable(&shared_venv_dir()) {
            return Ok(python);
        }
    }
    let base = base_python_or_own(slot, preferred_base, VIDEO_ENGINES_PYTHON)?;
    slot.log(format!("Python: {base}"));
    create_venv(slot, &base, &own)?;
    Ok(venv_python(&own).to_string_lossy().to_string())
}

/// Whether the engine is there, read from the record pip left in the venv and
/// not asked of an interpreter. `import mlx_video` pulls MLX and its models in
/// and took five seconds on the owner's M5 Pro, every time the Model Manager
/// opened and before every generation. Asking the package metadata through
/// Python still cost a tenth of a second per look, on the thread that draws
/// the window. The record is a file, and reading it starts nothing.
/// The install itself still proves the import once (`mlx_video_imports`).
fn mlx_video_installed(python: &str) -> bool {
    mlx_video_version(python).is_some()
}

fn mlx_video_imports(python: &str) -> bool {
    crate::python::python_command(python)
        .args(["-c", "import mlx_video"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn python_has_module(python: &str, module: &str) -> bool {
    crate::python::python_command(python)
        .args(["-c", &format!("import {module}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Idempotent module bootstrap: `huggingface_hub`, `torch` (the wan convert
/// reads .pth) and `mlx_video` itself are not givens in a venv, least of all
/// in one this file has just built. Without this, installs died with a bare
/// "command exited 1" (ModuleNotFoundError swallowed in the worker thread).
pub(crate) fn ensure_python_module(
    slot: &crate::install_state::InstallSlot,
    python: &str,
    module: &str,
    pip_specs: &[&str],
) -> Result<(), String> {
    if python_has_module(python, module) {
        return Ok(());
    }
    let pip_spec = pip_specs.join(" ");
    slot.log(format!("installing {pip_spec} (one-time)"));
    let mut cmd = crate::python::python_command(python);
    cmd.args(["-m", "pip", "install", "--upgrade"]).args(pip_specs);
    run_streamed(slot, &mut cmd)
        .map_err(|e| format!("pip install {pip_spec}: {e}"))?;
    if !python_has_module(python, module) {
        return Err(format!(
            "installed {pip_spec} but `import {module}` still fails"
        ));
    }
    Ok(())
}

/// The version of `mlx-video` in the venv `python` belongs to.
///
/// pip writes `<name>-<version>.dist-info/METADATA` into site-packages as the
/// last step of an install and removes it first on an uninstall, which is
/// exactly what `importlib.metadata` reads. A venv interpreter is
/// `<venv>/bin/python`, so the venv is two levels up.
fn mlx_video_version(python: &str) -> Option<String> {
    let venv = std::path::Path::new(python).parent()?.parent()?;
    dist_version(venv, "mlx_video")
}

/// `Version:` out of the dist-info record of `package` (its normalized name,
/// with underscores) in any `lib/python*/site-packages` of `venv`.
pub(crate) fn dist_version(venv: &std::path::Path, package: &str) -> Option<String> {
    let sites = std::fs::read_dir(venv.join("lib")).ok()?;
    sites
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("python"))
        .filter_map(|e| std::fs::read_dir(e.path().join("site-packages")).ok())
        .flat_map(|dir| dir.flatten())
        .filter(|e| {
            // `<name>-<version>.dist-info`. The name has no dash of its own
            // in there: pip writes it with underscores.
            let file = e.file_name().to_string_lossy().to_lowercase();
            file.strip_suffix(".dist-info")
                .and_then(|stem| stem.split_once('-'))
                .is_some_and(|(name, _)| name.replace('.', "_") == package)
        })
        .find_map(|e| {
            let text = std::fs::read_to_string(e.path().join("METADATA")).ok()?;
            // The headers end at the first empty line; the description after
            // it is free text and may hold a "Version:" of its own.
            text.lines()
                .take_while(|l| !l.is_empty())
                .find_map(|l| l.strip_prefix("Version:"))
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
}

// ── Commands ──────────────────────────────────────────────────────────

pub fn video_status(state: &AppState, _args: &Value) -> CmdResult {
    let apple_silicon =
        std::env::consts::OS == "macos" && std::env::consts::ARCH == "aarch64";
    let python = engine_python();
    // One cheap question answers both: no version, no engine.
    let version = python.as_deref().and_then(mlx_video_version);
    let mlx_ok = version.is_some();
    let installed_ids: Vec<&str> = CATALOG
        .iter()
        .filter(|c| model_is_usable(c))
        .map(|c| c.id)
        .collect();
    let ltx2_ok = ltx2mlx::engine_ready();
    let running = state.video_process().lock().unwrap().is_some();
    Ok(json!({
        "available": apple_silicon,
        "appleSilicon": apple_silicon,
        "mlxInstalled": mlx_ok,
        "mlxVersion": version,
        // The second engine. It has no setup button: it installs with the
        // first model that needs it.
        "ltx2MlxInstalled": ltx2_ok,
        "ltx2MlxVersion": ltx2_ok.then_some(ltx2mlx::VERSION),
        "pythonBin": python,
        "modelsRoot": models_root(),
        "outputsRoot": outputs_root(),
        "installedModels": installed_ids,
        // The LoRA of Motion Control (`motion`), which runs on the LTX-2.3 packs.
        "motionInstalled": motion::installed(),
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
    if id == motion::ID {
        return delete_motion(state);
    }
    let entry = catalog_lookup(id)
        .ok_or_else(|| crate::commands::bad_request(format!("unknown video model id: {id}")))?;
    if state.video_process().lock().unwrap().is_some() {
        return Err(crate::commands::bad_request(
            "A video is being generated. Cancel it before deleting the model.".to_string(),
        ));
    }
    // The installer is writing into this very directory, and a tile that is
    // not "installed" yet can still be asked to remove what is there.
    if state.install_video_model().is_running() {
        return Err(crate::commands::bad_request(
            "A video model is still installing. Wait for it to finish, or stop it first.".to_string(),
        ));
    }
    if talking_part(args.get("part").and_then(|v| v.as_str())).map_err(crate::commands::bad_request)? {
        return delete_talking_files(entry);
    }
    delete_model_files(entry)
}

/// What Remove does on disk, once nothing is running that reads or writes there.
fn delete_model_files(entry: &CatalogEntry) -> CmdResult {
    let id = entry.id;
    let owner = weights_owner(entry);
    let dir = model_dir(owner.id);
    let shares = owner.id != entry.id;
    let was_installed = model_is_installed(entry);
    // A shared text encoder goes with the last model that needs it. Eight
    // gigabytes that no row accounts for would never be found again.
    let orphaned_encoder = !entry.text_encoder_repo.is_empty()
        && text_encoder_dir(entry.text_encoder_repo).is_dir()
        && !CATALOG
            .iter()
            .any(|c| c.id != entry.id && c.text_encoder_repo == entry.text_encoder_repo && uses_its_encoder(c));
    // The folder belongs to the entry that owns it, whatever state it is in.
    // An entry on shared weights has its claim and nothing else; the
    // sibling's folder is not its own.
    let own = if shares { encoder_claim(entry).is_file() } else { dir.is_dir() };
    if !own && !orphaned_encoder {
        return Err(crate::commands::not_found(format!("{id} is not installed")));
    }
    // The encoder side goes first: with the weights kept for a sibling, it is
    // all that makes this entry read as installed.
    if shares {
        let _ = std::fs::remove_file(encoder_claim(entry));
    }
    if orphaned_encoder {
        let _ = std::fs::remove_dir_all(text_encoder_dir(entry.text_encoder_repo));
    }
    // The weights stay while another installed entry runs on them. An entry
    // on shared weights that was not installed itself leaves them alone: they
    // are its sibling's, finished or not.
    let still_used = CATALOG
        .iter()
        .any(|c| c.id != entry.id && weights_owner(c).id == owner.id && model_is_installed(c));
    if dir.is_dir() && !still_used && (!shares || was_installed) {
        std::fs::remove_dir_all(&dir).map_err(|e| internal(format!("delete {id}: {}", os_error::english(&e))))?;
    }
    // Weights kept for one sibling and the encoder kept for another: every
    // file this entry needs is still in use, and saying "deleted" would be a
    // lie the tile contradicts a second later.
    if model_is_installed(entry) {
        return Err(bad_request(format!(
            "{} runs on files that other installed models use, so there is nothing to remove. Delete those models to free the space.",
            entry.name
        )));
    }
    // The hub's chunk cache is download scratch that no model reads again,
    // up to ten gigabytes of it. No install is running (the command checks),
    // so nothing is writing there, and no row in the app would account for it.
    let _ = std::fs::remove_dir_all(hf_home_dir().join("xet"));
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
            // so round to the tenth the catalog means.
            "sizeGB": (c.size_gb as f64 * 10.0).round() / 10.0,
            "minRamGB": c.min_ram_gb,
            // What the tile and the memory filter go by. See `recommended_ram_gb`.
            "recommendedRamGB": recommended_ram_gb(c),
            // Timed on one Mac, see the field. 0 = not timed.
            "measuredRunSecondsPerClipSecond": c.measured_run_s_per_clip_s,
            // The text encoder a Get of this entry still has to fetch on top
            // of `sizeGB`: 0 when the repository carries it or it is here.
            "textEncoderGB": (encoder_to_fetch_gb(c) * 10.0).round() / 10.0,
            "starter": c.starter,
            "defaultFrames": c.default_frames,
            "needsConvert": c.needs_convert,
            "unfiltered": c.unfiltered,
            "requiresImage": c.requires_image,
            "acceptsImage": takes_start_image(c),
            // The frame rate the engine writes this model at. See `frame_rate`.
            "fps": frame_rate(c),
            // The size a run has unless Create asks for another.
            "defaultWidth": c.default_width,
            "defaultHeight": c.default_height,
            // The grid of a size Create may ask for, and the most pixels it
            // may have (`run_size`). No grid: the entry's size is the run's.
            "sizeGrid": size_grid(c),
            "maxPixels": max_pixels(c),
            "minSide": MIN_SIDE,
            "maxSide": MAX_SIDE,
            // The steps a run takes by default where Create may set them
            // (Wan), else none: a distilled LTX runs its own table.
            "steps": default_steps(c),
            "maxSteps": MAX_STEPS,
            // Whether the negative prompt reaches the model. False: the
            // field is not shown, as nothing would read it.
            "negativePrompt": takes_negative_prompt(c),
            // Guidance set in Create reaches no local video engine, and steps
            // only where `steps` says so: a distilled LTX runs its fixed
            // eight plus three steps without guidance, whatever a slider says.
            "userSampling": false,
            // Whether a run takes the LoRA stack (`takes_loras`). Create
            // shows the stack for these models and for no other video model.
            "loras": takes_loras(c),
            // Whether Create offers the shot list (`takes_shot_list`).
            "multishot": takes_shot_list(c),
            // Whether a run can follow a motion video (`motion::takes_motion`).
            // What it needs on top is the LoRA, `motionInstalled` of the status.
            "motion": motion::takes_motion(c),
            // Talking Character (`a2v`): whether the model can run it, what
            // its own download weighs, and whether that is on disk.
            "talking": talks(c),
            "talkingGB": c.talking_gb,
            "talkingReady": talking_ready(c),
            "description": c.description,
            "installed": model_is_usable(c),
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
    if engine_python().as_deref().is_some_and(mlx_video_installed) {
        if slot.try_start() {
            slot.complete("mlx-video already installed");
        }
        return Ok(json!({ "ok": true, "status": "complete" }));
    }
    // Check and claim in one step: of two clicks, one starts the install.
    if !slot.try_start() {
        return Ok(json!({ "ok": true, "status": "installing" }));
    }
    let preferred_base = state.python_bin();
    let slot2 = slot.clone();
    std::thread::spawn(move || match install_engine_steps(&slot2, preferred_base) {
        Ok(()) => slot2.complete("mlx-video installed"),
        Err(e) => slot2.fail(e),
    });
    Ok(json!({ "ok": true, "status": "installing" }))
}

pub(crate) fn install_engine_steps(slot: &crate::install_state::InstallSlot, preferred_base: Option<String>) -> Result<(), String> {
    let python = ensure_engine_python(slot, preferred_base)?;
    let mut cmd = crate::python::python_command(&python);
    cmd.args(["-m", "pip", "install", "--upgrade"]).args(mlx_video_pip_specs());
    run_streamed(slot, &mut cmd)?;
    if !mlx_video_imports(&python) {
        return Err("pip install finished but `import mlx_video` still fails".to_string());
    }
    Ok(())
}

pub fn video_install_mlx_status(state: &AppState, _args: &Value) -> CmdResult {
    Ok(serde_json::to_value(state.install_mlx_video().snapshot()).unwrap())
}

#[derive(Deserialize)]
struct InstallModelArgs {
    id: String,
    /// `"talking"`: the files of a Talking Character run, for a model that is
    /// installed. Absent: the model itself.
    #[serde(default)]
    part: Option<String>,
}

/// The one part of a model that installs and goes on its own.
const TALKING_PART: &str = "talking";

fn talking_part(part: Option<&str>) -> Result<bool, String> {
    match part {
        None => Ok(false),
        Some(TALKING_PART) => Ok(true),
        Some(other) => Err(format!("unknown part of a video model: {other}")),
    }
}

pub fn video_install_model(state: &AppState, args: &Value) -> CmdResult {
    ensure_apple_silicon()?;
    let a: InstallModelArgs =
        serde_json::from_value(args.clone()).map_err(|e| bad_request(e.to_string()))?;
    if a.id == motion::ID {
        return install_motion(state);
    }
    let entry = catalog_lookup(&a.id)
        .ok_or_else(|| bad_request(format!("unknown video model id: {}", a.id)))?;
    let slot = state.install_video_model();
    if slot.is_running() {
        return Ok(json!({ "ok": true, "status": "installing" }));
    }
    if talking_part(a.part.as_deref()).map_err(bad_request)? {
        return install_talking(state, entry);
    }
    if model_is_usable(entry) {
        if slot.try_start() {
            slot.complete(format!("{} already installed", entry.id));
        }
        return Ok(json!({ "ok": true, "status": "complete", "id": entry.id }));
    }

    // Before a byte is fetched: a download that dies hours in with a full
    // disk leaves the Mac unusable and nothing to resume from.
    let plan = disk_plan(entry);
    crate::commands::system::ensure_free_space(&models_root(), entry.name, plan.need_bytes(), plan.note())
        .map_err(bad_request)?;

    let target = model_dir(weights_owner(entry).id);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| internal(os_error::english(&e)))?;
    }
    // Out of Time Machine before the gigabytes arrive.
    crate::media_store::keep_out_of_backups(&models_root());
    // Check and claim in one step: of two clicks, one starts the install.
    if !slot.try_start() {
        return Ok(json!({ "ok": true, "status": "installing" }));
    }
    // Kein geteilter Zwischenspeicher: dieser Weg laedt mit `local_dir`, und
    // huggingface_hub legt den Zwischenstand dann unter `<local_dir>/.cache`
    // ab, also INNERHALB des Ordners, der hier gemessen wird. Der Xet-Cache
    // liegt seit K5 in einem Ordner dieser App (`hf_home_dir()`), nicht mehr
    // im Standardordner des Nutzers auf dem Systemlaufwerk.
    //
    // The text encoder is part of this install and lands beside the models,
    // not in the folder of this one. Left out, the bar of LTX-2.3 4-bit read
    // "20.5 of 20.5 GB" for the 26 minutes in which its 8.1 GB came in (real
    // run on the M5 Pro, 09.10.2026).
    let (encoder_dir, total) = bar_of(entry);
    crate::install_state::watch_dir_size(slot.clone(), target, encoder_dir.into_iter().collect(), total);
    let slot2 = slot.clone();
    let entry2 = entry.clone();
    let preferred_base = state.python_bin();
    std::thread::spawn(move || {
        let python = if entry2.family == ltx2mlx::FAMILY {
            ltx2mlx::ensure_engine(&slot2, preferred_base)
        } else {
            ensure_engine_python(&slot2, preferred_base)
        };
        let done = python.and_then(|python| install_model_steps(&slot2, &python, &entry2));
        if let Err(e) = done {
            slot2.fail(e);
        } else if !model_is_usable(&entry2) {
            slot2.fail("The download finished, but the model is not complete on disk. Start it again.");
        } else {
            slot2.complete(format!("{} installed", entry2.id));
        }
    });
    Ok(json!({ "ok": true, "status": "installing", "id": entry.id }))
}

/// The Talking Character part of an installed model: the files its `a2v`
/// reads on top (`ltx2mlx::TALKING_FILES`), from the model's own repository
/// into its folder, on the slot of a model install, so the same bar, Stop and
/// status serve it.
fn install_talking(state: &AppState, entry: &'static CatalogEntry) -> CmdResult {
    let slot = state.install_video_model();
    if !talks(entry) {
        return Err(bad_request(format!("{} cannot run Talking Character.", entry.name)));
    }
    if !model_is_usable(entry) {
        return Err(bad_request(format!("Get {} first. Talking Character runs on it.", entry.name)));
    }
    if talking_ready(entry) {
        if slot.try_start() {
            slot.complete(format!("{} talking part already installed", entry.id));
        }
        return Ok(json!({ "ok": true, "status": "complete", "id": entry.id }));
    }
    let target = weights_dir(entry);
    let need = (entry.talking_gb as f64 * 1e9) as u64 + DiskPlan::HEADROOM;
    crate::commands::system::ensure_free_space(&models_root(), entry.name, need, "").map_err(bad_request)?;
    if !slot.try_start() {
        return Ok(json!({ "ok": true, "status": "installing" }));
    }
    // The bar counts the folder, which holds the model already.
    let total = dir_bytes(&target) + (entry.talking_gb as f64 * 1e9) as u64;
    crate::install_state::watch_dir_size(slot.clone(), target.clone(), Vec::new(), total);
    let preferred_base = state.python_bin();
    crate::install_state::spawn_install(slot, move |slot| {
        let python = ltx2mlx::ensure_engine(slot, preferred_base)?;
        ensure_python_module(slot, &python, "huggingface_hub", &["huggingface_hub"])?;
        let owner = weights_owner(entry);
        slot.log(format!("downloading the Talking Character part of {} ({} GB)", entry.name, entry.talking_gb));
        hub_download(slot, &python, owner.repo, ltx2mlx::TALKING_FILES, &target)?;
        ltx2mlx::verify_pack(&target, ltx2mlx::TALKING_FILES)?;
        if !talking_ready(entry) {
            return Err("The download finished, but the Talking Character part is not complete on disk. Start it again.".to_string());
        }
        Ok(format!("{} talking part installed", entry.id))
    });
    Ok(json!({ "ok": true, "status": "installing", "id": entry.id }))
}

/// Remove the Talking Character part of a model and keep the model.
fn delete_talking_files(entry: &CatalogEntry) -> CmdResult {
    if !talks(entry) {
        return Err(bad_request(format!("{} has no Talking Character part.", entry.name)));
    }
    let dir = weights_dir(entry);
    let present: Vec<PathBuf> = ltx2mlx::TALKING_FILES.iter().map(|f| dir.join(f)).filter(|p| p.is_file()).collect();
    if present.is_empty() {
        return Err(crate::commands::not_found(format!("the Talking Character part of {} is not installed", entry.id)));
    }
    for file in present {
        std::fs::remove_file(&file).map_err(|e| internal(format!("delete {}: {}", file.display(), os_error::english(&e))))?;
    }
    Ok(json!({ "ok": true, "id": entry.id, "part": TALKING_PART }))
}

/// What an install still has to find room for, read from the disk.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
struct DiskPlan {
    /// Bytes of the weights download that are not on disk yet.
    download: u64,
    /// Bytes the convert writes next to its source before the source goes.
    convert: u64,
    /// Bytes of a text encoder nobody has fetched yet.
    encoder: u64,
    /// Bytes of a half-written convert that the install removes first.
    reclaim: u64,
}

impl DiskPlan {
    /// Room for the engine's own packages and for the system to keep working.
    const HEADROOM: u64 = 2_000_000_000;

    fn need_bytes(&self) -> u64 {
        (self.download + self.convert + self.encoder + Self::HEADROOM).saturating_sub(self.reclaim)
    }

    fn note(&self) -> &'static str {
        if self.convert > 0 {
            "incl. the one-time convert, which holds the download and its converted copy side by side"
        } else {
            ""
        }
    }
}

fn disk_plan(entry: &CatalogEntry) -> DiskPlan {
    let owner = weights_owner(entry);
    let encoder = (encoder_to_fetch_gb(entry) * 1e9) as u64;
    // An entry that runs on a sibling's weights fetches none when they are there.
    if weights_ready(owner) {
        return DiskPlan { encoder, ..DiskPlan::default() };
    }
    let size = (owner.size_gb as f64 * 1e9) as u64;
    // What a stopped attempt already fetched is not needed a second time, or a
    // download that was stopped near its end could never be picked up again.
    let fetched = dir_bytes(&download_dir(owner)).min(size);
    DiskPlan {
        download: size - fetched,
        convert: if owner.needs_convert { size } else { 0 },
        encoder,
        reclaim: if owner.needs_convert { dir_bytes(&weights_dir(owner)) } else { 0 },
    }
}

/// Where the hub download of `owner` lands.
fn download_dir(owner: &CatalogEntry) -> PathBuf {
    if owner.needs_convert {
        convert_source_dir(owner)
    } else {
        model_dir(owner.id)
    }
}

/// What the bar of an install of `entry` counts: the folder of a text encoder
/// that is still to come (its growth counts, like that of the model's own
/// folder), and the bytes of both together.
fn bar_of(entry: &CatalogEntry) -> (Option<PathBuf>, u64) {
    let encoder = encoder_to_fetch_gb(entry);
    let dir = (encoder > 0.0).then(|| text_encoder_dir(entry.text_encoder_repo));
    (dir, ((entry.size_gb as f64 + encoder) * 1e9) as u64)
}

/// Gigabytes of text encoder this install still has to fetch: none when the
/// entry needs none, or when another entry already brought it.
fn encoder_to_fetch_gb(entry: &CatalogEntry) -> f64 {
    if entry.text_encoder_repo.is_empty() || text_encoder_present(&text_encoder_dir(entry.text_encoder_repo)) {
        0.0
    } else {
        text_encoder_gb(entry.text_encoder_repo) as f64
    }
}

/// The weights are about to arrive in `owner`'s folder: mark it, and clear
/// what a stopped convert wrote. A half `mlx/` is not something the convert
/// continues from, it starts over, and until then the folder would count
/// against the disk for nothing.
fn begin_weights_install(slot: &crate::install_state::InstallSlot, owner: &CatalogEntry) -> Result<(), String> {
    let dir = model_dir(owner.id);
    std::fs::create_dir_all(&dir).map_err(|e| os_error::english(&e))?;
    std::fs::write(installing_marker(owner), b"").map_err(|e| os_error::english(&e))?;
    if owner.needs_convert {
        let _ = std::fs::remove_file(converted_marker(owner));
        let out_dir = weights_dir(owner);
        if out_dir.exists() {
            slot.log("removing the output of a convert that did not finish");
            std::fs::remove_dir_all(&out_dir).map_err(|e| os_error::english(&e))?;
        }
    }
    Ok(())
}

/// The weights are complete. The convert's marker goes down first, so that
/// from here on nothing can make a finished convert look like a half one.
fn finish_weights_install(slot: &crate::install_state::InstallSlot, owner: &CatalogEntry) -> Result<(), String> {
    if owner.needs_convert {
        std::fs::write(converted_marker(owner), b"").map_err(|e| os_error::english(&e))?;
    }
    let _ = std::fs::remove_file(installing_marker(owner));
    if owner.needs_convert {
        slot.log("removing the source checkpoint (converted copy is kept)");
        let _ = std::fs::remove_dir_all(convert_source_dir(owner));
    }
    Ok(())
}

fn install_model_steps(
    slot: &crate::install_state::InstallSlot,
    python: &str,
    entry: &CatalogEntry,
) -> Result<(), String> {
    ensure_python_module(slot, python, "huggingface_hub", &["huggingface_hub"])?;
    // Generation needs the mlx-video package for BOTH of its families.
    // Installing it here (not just for the wan convert) means a model
    // installed from the Discover tab generates on the first click instead of
    // erroring with "mlx-video not installed". The second engine is in a venv
    // of its own, complete by the time this runs, and never sees mlx-video.
    if entry.family != ltx2mlx::FAMILY {
        ensure_python_module(
            slot,
            python,
            "mlx_video",
            &mlx_video_pip_specs(),
        )?;
    }

    // A converting entry downloads its checkpoint to <id>/src, converts to
    // <id>/mlx, then drops the source to give the disk back. An entry that
    // runs on a sibling's weights works in that sibling's folder.
    let owner = weights_owner(entry);
    let download_to = download_dir(owner);

    // With the convert through, what is missing is a text encoder, and the
    // checkpoint is not fetched a second time for that. A plain download is
    // asked for again instead: the hub skips every file that is complete.
    let ready = weights_ready(owner);
    if ready && owner.needs_convert {
        slot.log(format!("the converted weights of {} are on disk already", owner.name));
        // A source that outlived its convert is only in the way.
        let _ = std::fs::remove_dir_all(&download_to);
    } else {
        if !ready {
            begin_weights_install(slot, owner)?;
        }
        if !owner.base_repo.is_empty() {
            slot.log(format!("downloading the text encoder and VAE from {}", owner.base_repo));
            hub_download(slot, python, owner.base_repo, WAN21_BASE_FILES, &download_to)?;
        }
        slot.log(format!("downloading {} ({} GB)", owner.repo, owner.size_gb));
        hub_download(slot, python, owner.repo, owner.repo_files, &download_to)?;
        if owner.family == ltx2mlx::FAMILY {
            ltx2mlx::verify_pack(&download_to, owner.repo_files)?;
        }
        if owner.needs_convert {
            convert_weights(slot, python, owner, &download_to)?;
        }
        if !ready {
            finish_weights_install(slot, owner)?;
        }
    }

    if !entry.text_encoder_repo.is_empty() {
        let encoder_dir = text_encoder_dir(entry.text_encoder_repo);
        if !text_encoder_present(&encoder_dir) {
            slot.log(format!(
                "downloading the text encoder {} ({} GB)",
                entry.text_encoder_repo,
                text_encoder_gb(entry.text_encoder_repo)
            ));
            hub_download(slot, python, entry.text_encoder_repo, &[], &encoder_dir)
                .map_err(|e| format!("text encoder: {e}"))?;
            if !text_encoder_present(&encoder_dir) {
                return Err("the text encoder download finished but its files are not there".to_string());
            }
        }
    }
    if !entry.shares_weights_with.is_empty() {
        std::fs::write(encoder_claim(entry), b"").map_err(|e| os_error::english(&e))?;
    }
    Ok(())
}

/// The engine's one-time convert of `owner`'s download into `<id>/mlx`.
fn convert_weights(
    slot: &crate::install_state::InstallSlot,
    python: &str,
    owner: &CatalogEntry,
    download_to: &std::path::Path,
) -> Result<(), String> {
    let out_dir = weights_dir(owner);
    slot.log(format!("converting {} to MLX (one-time)", owner.name));
    let mut convert = crate::python::python_command(python);
    if owner.family == "ltx_2" {
        // One file with every component in it. The convert splits it into the
        // folders the loader reads, and copies an upscaler that lies next to
        // it. `dev` and `distilled` differ in the VAE decoder config.
        let checkpoint = owner
            .repo_files
            .first()
            .ok_or_else(|| format!("{} names no checkpoint file to convert", owner.id))?;
        convert
            .arg("-m")
            .arg("mlx_video.models.ltx_2.convert")
            .arg("--source")
            .arg(download_to.join(checkpoint).as_os_str())
            .arg("--output")
            .arg(out_dir.as_os_str())
            .arg("--variant")
            .arg(ltx_convert_variant(owner.pipeline));
    } else {
        // The wan convert additionally needs torch to read the .pth text
        // encoder and VAE.
        ensure_python_module(slot, python, "torch", &["torch"])?;
        convert
            .arg("-m")
            .arg("mlx_video.models.wan_2.convert")
            .arg("--checkpoint-dir")
            .arg(download_to.as_os_str())
            .arg("--output-dir")
            .arg(out_dir.as_os_str());
        if owner.quant_bits != 0 {
            convert.arg("--quantize").arg("--bits").arg(owner.quant_bits.to_string());
        }
    }
    let converted = run_streamed(slot, &mut convert)
        .map_err(|e| format!("convert: {e}"))
        .and_then(|()| {
            if dir_non_empty(&out_dir) {
                Ok(())
            } else {
                Err("convert finished but produced no MLX weights".to_string())
            }
        });
    if converted.is_err() {
        // Stopped or failed: what it wrote so far is no model. The download
        // stays, so the next attempt goes straight to the convert.
        let _ = std::fs::remove_dir_all(&out_dir);
    }
    converted
}

/// `ltx_2.convert --variant`: the distilled pipeline reads distilled weights,
/// every other pipeline the dev ones.
fn ltx_convert_variant(pipeline: &str) -> &'static str {
    if pipeline == "distilled" {
        "distilled"
    } else {
        "dev"
    }
}

/// Pull a repository, or the named files of one, into `target`.
///
/// `huggingface_hub.snapshot_download` is the supported way to pull an HF
/// repo with resume and progress. It is invoked inline so the app does not
/// need to ship the huggingface-cli binary. `files` are hub patterns; a plain
/// file name is the pattern that matches that file, at its path in the repo.
fn hub_download(
    slot: &crate::install_state::InstallSlot,
    python: &str,
    repo: &str,
    files: &[&str],
    target: &std::path::Path,
) -> Result<(), String> {
    let script = format!(
        "from huggingface_hub import snapshot_download; snapshot_download(repo_id={r:?}, local_dir={t:?}, allow_patterns={p})",
        r = repo,
        t = target.to_string_lossy(),
        p = python_patterns(files),
    );
    let mut cmd = crate::python::python_command(python);
    cmd.args(["-c", &script])
        .env("HF_HOME", hf_home_dir())
        .env("HF_XET_CACHE", hf_home_dir().join("xet"));
    crate::commands::mlx::apply_hf_token(&mut cmd);
    // A gated repository (LTX-2.5) answers 401 or 403. That becomes the
    // sentence about the Hugging Face token, as for the image models.
    let freed = crate::commands::mlx::drop_stale_partials(target);
    if freed > 0 {
        slot.log(format!("removed {} that a stopped download left half written", crate::commands::mlx_snapshot::human_bytes(freed)));
    }
    crate::commands::mlx::run_hub_step(slot, &mut cmd, &[target, &hf_home_dir()])?;
    // What the attempts of this very step left (a stalled one that was
    // started again) is of no use once the files are whole.
    crate::commands::mlx::drop_stale_partials(target);
    Ok(())
}

/// `allow_patterns` as Python source: `None` for the whole repository, a list
/// of string literals otherwise.
fn python_patterns(files: &[&str]) -> String {
    if files.is_empty() {
        "None".to_string()
    } else {
        format!("{files:?}")
    }
}

/// For `commands::real_run_mac`: the second engine alone, on the slot a model
/// install brings it on. The app has no command for this, the engine arrives
/// with the first model of its family. `false`: the slot is taken.
#[cfg(all(test, target_os = "macos"))]
pub(crate) fn real_run_install_ltx2_engine(state: &AppState) -> bool {
    let slot = state.install_video_model();
    if !slot.try_start() {
        return false;
    }
    let preferred_base = state.python_bin();
    crate::install_state::spawn_install(slot, move |slot| {
        ltx2mlx::ensure_engine(slot, preferred_base)?;
        Ok(format!("ltx-2-mlx {} installed", ltx2mlx::VERSION))
    });
    true
}

pub fn video_install_model_status(state: &AppState, _args: &Value) -> CmdResult {
    Ok(serde_json::to_value(state.install_video_model().snapshot()).unwrap())
}

/// Stop the model download that is running. What it fetched so far stays in
/// the hub cache and the next install resumes from it.
pub fn video_cancel_model_install(state: &AppState, _args: &Value) -> CmdResult {
    // One Stop for the lane: the model download, and the engine setup that
    // runs before the first one.
    let model = state.install_video_model().cancel();
    let engine = state.install_mlx_video().cancel();
    Ok(json!({ "ok": true, "cancelled": model || engine }))
}

/// The download of the Motion Control LoRA, on the slot of a model install,
/// so the same status, progress and Stop serve it. It runs on the packs of
/// the second engine and takes that engine's Python to fetch with: the tab
/// that offers it is only there while such a pack is installed.
fn install_motion(state: &AppState) -> CmdResult {
    ensure_apple_silicon()?;
    let slot = state.install_video_model();
    if slot.is_running() {
        return Ok(json!({ "ok": true, "status": "installing" }));
    }
    if motion::installed() {
        if slot.try_start() {
            slot.complete(format!("{} already installed", motion::ID));
        }
        return Ok(json!({ "ok": true, "status": "complete", "id": motion::ID }));
    }
    let python = ltx2mlx::python()
        .ok_or_else(|| bad_request("Motion Control runs on an LTX-2.3 model. Install one in the Model Manager first."))?;
    crate::commands::system::ensure_free_space(&models_root(), motion::NAME, motion::SIZE_BYTES, "").map_err(bad_request)?;
    let target = motion::dir();
    std::fs::create_dir_all(&target).map_err(|e| internal(os_error::english(&e)))?;
    crate::media_store::keep_out_of_backups(&models_root());
    if !slot.try_start() {
        return Ok(json!({ "ok": true, "status": "installing" }));
    }
    crate::install_state::watch_dir_size(slot.clone(), target.clone(), Vec::new(), motion::SIZE_BYTES);
    crate::install_state::spawn_install(slot, move |slot| {
        slot.log(format!("downloading {} ({} MB)", motion::REPO, motion::SIZE_BYTES / 1_000_000));
        hub_download(slot, &python, motion::REPO, &[motion::FILE], &target)?;
        if !motion::installed() {
            return Err("The download finished, but Motion Control is not complete on disk. Start it again.".to_string());
        }
        Ok(format!("{} installed", motion::ID))
    });
    Ok(json!({ "ok": true, "status": "installing", "id": motion::ID }))
}

/// Remove the Motion Control LoRA. Its folder is the one place it lives.
fn delete_motion(state: &AppState) -> CmdResult {
    if state.video_process().lock().unwrap().is_some() {
        return Err(bad_request("A video is being generated. Cancel it before removing Motion Control."));
    }
    if state.install_video_model().is_running() {
        return Err(bad_request("A video model is still installing. Wait for it to finish, or stop it first."));
    }
    let dir = motion::dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| internal(format!("delete {}: {}", motion::ID, os_error::english(&e))))?;
    }
    Ok(json!({ "ok": true, "id": motion::ID }))
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
    /// Reaches the models that take one (`takes_negative_prompt`).
    #[serde(default)]
    negative_prompt: Option<String>,
    /// The LoRA stack: files of the LoRA folder by name, each with its
    /// strength, in the order they were picked. See `lora_stack`.
    #[serde(default)]
    loras: Vec<LoraArg>,
    /// Another size than the entry's, on the model's grid (`run_size`).
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    /// Another step count than the engine's own, where one is taken
    /// (`run_steps`).
    #[serde(default)]
    steps: Option<u32>,
    /// Motion Control: the motion video the clip follows, a file on disk
    /// (`video_stage_motion_video`). See `motion`.
    #[serde(default)]
    motion_video: Option<String>,
    /// Talking Character: the speech, as a file. The run is the engine's
    /// `a2v`, and the clip is as long as the speech (`ltx2mlx::talking_frames`).
    #[serde(default)]
    audio: Option<String>,
}

#[derive(Deserialize)]
struct LoraArg {
    name: String,
    #[serde(default = "full_strength")]
    strength: f32,
}

fn full_strength() -> f32 {
    1.0
}

pub fn video_generate(state: &AppState, args: &Value) -> CmdResult {
    ensure_apple_silicon()?;
    // One model in the memory at a time: a track of the music lane holds its
    // own until it is through.
    if crate::commands::music::busy() {
        return Err(bad_request("A track is being made on this Mac. Wait for it to finish, then start the video."));
    }
    if let Some(why) = crate::commands::mlx::train::refusal() {
        return Err(bad_request(why));
    }
    if let Some(why) = crate::commands::mesh3d::refusal() {
        return Err(bad_request(why));
    }
    let a: GenerateArgs =
        serde_json::from_value(args.clone()).map_err(|e| bad_request(e.to_string()))?;
    let entry = catalog_lookup(&a.id)
        .ok_or_else(|| bad_request(format!("unknown video model id: {}", a.id)))?;
    if !model_is_usable(entry) {
        return Err(bad_request(format!(
            "model {} is not installed. Run video_install_model first.",
            entry.id
        )));
    }
    // Before anything is loaded: a model larger than the memory does not
    // fail, it swaps until the Mac stops answering.
    if let Some(refusal) = memory_refusal(entry, machine_memory_bytes()) {
        return Err(bad_request(refusal));
    }
    let quant = entry.family == ltx2mlx::FAMILY;
    let talking = a.audio.is_some();
    if talking {
        if !talks(entry) {
            return Err(bad_request(format!("{} cannot run Talking Character. Pick LTX-2.3 Distilled 4-bit.", entry.name)));
        }
        if !talking_ready(entry) {
            return Err(bad_request(format!(
                "Talking Character on {} needs its own download ({} GB). Get it on the Talking Character tab.",
                entry.name, entry.talking_gb
            )));
        }
        if let Some(refusal) = talking_needs_more_memory(entry, machine_memory_bytes()) {
            return Err(bad_request(refusal));
        }
    }
    let python = if quant {
        ltx2mlx::python()
    } else {
        engine_python().filter(|p| mlx_video_installed(p))
    }
    .ok_or_else(|| bad_request("The video engine is not installed. Run video_install_mlx first."))?;
    {
        let video_process = state.video_process();
        let g = video_process.lock().unwrap();
        if g.is_some() {
            return Err(bad_request(
                "A video generation is already running. Cancel it first.",
            ));
        }
    }

    // Validate init_image BEFORE spawning: chat models sometimes hallucinate
    // a filename. A crisp, self-describing error lets the agent loop retry
    // without the image instead of surfacing an opaque subprocess exit(1).
    // Wan I2V takes the start image as input channels. Without one the engine
    // loads sixty gigabytes and then fails on a tensor shape.
    if entry.requires_image && a.init_image.is_none() {
        return Err(bad_request(format!(
            "{} turns a start image into video and cannot run from text alone. Pass init_image, or pick a text to video model.",
            entry.name
        )));
    }
    // An image for a model that takes none is turned away in words. The first
    // engine accepts `--image` for every checkpoint, loads the model, and then
    // fails on a tensor shape or renders something the model was never
    // trained for.
    if let Some(refusal) = image_refusal(entry, a.init_image.is_some()) {
        return Err(bad_request(refusal));
    }
    if let Some(img) = a.init_image.as_deref() {
        if !std::path::Path::new(img).is_file() {
            return Err(bad_request(format!(
                "init_image not found: {img}. Pass the absolute path of a real image file, or omit init_image for text-to-video."
            )));
        }
    }
    // The same for the LoRA stack: a file that is gone, is not in the folder
    // or is in a naming this engine cannot read is said now, and not after
    // minutes of loading.
    let asked_loras: Vec<(String, f32)> = a.loras.iter().map(|l| (l.name.clone(), l.strength)).collect();
    let loras = lora_stack(entry, &asked_loras, &crate::commands::mlx_loras::loras_root()).map_err(bad_request)?;
    // The engine's `a2v` takes no LoRA stack.
    if talking && !loras.is_empty() {
        return Err(bad_request("Talking Character runs without LoRAs. Remove them from the stack."));
    }
    // The speech: there, readable, and long enough for the shortest clip. Its
    // length is the clip's, read here and not taken from the caller.
    let talking_frames = match a.audio.as_deref() {
        None => None,
        Some(audio) => {
            if !std::path::Path::new(audio).is_file() {
                return Err(bad_request(format!("audio not found: {audio}. Pass the absolute path of a real audio file.")));
            }
            let seconds = ltx2mlx::audio_seconds(std::path::Path::new(audio))
                .ok_or_else(|| bad_request("The length of the voice could not be read. Use a WAV, MP3, M4A or AIFF file."))?;
            let frames = ltx2mlx::talking_frames(seconds, a.seconds.map(f64::from))
                .ok_or_else(|| bad_request("The voice is too short. Use at least half a second of speech."))?;
            Some((frames, seconds))
        }
    };
    // A motion run needs a pack that can follow one, the LoRA and the video.
    let motion_video = a.motion_video.as_deref().map(PathBuf::from);
    if let Some(refusal) = motion_video.as_deref().and_then(|v| motion::refusal(entry, motion::installed(), v)) {
        return Err(bad_request(refusal));
    }
    // A voice and a motion video are two runs of the engine, not one.
    if talking && motion_video.is_some() {
        return Err(bad_request("Talking Character and Motion Control are separate runs. Send a voice or a motion video, not both."));
    }
    // And a size or a step count the engine would floor, shrink or not read.
    let (width, height) = run_size(entry, a.width, a.height).map_err(bad_request)?;
    let steps = run_steps(entry, a.steps).map_err(bad_request)?;

    let out_dir = outputs_root();
    std::fs::create_dir_all(&out_dir).map_err(|e| internal(os_error::english(&e)))?;
    let job_id = uuid::Uuid::new_v4().simple().to_string();
    let out_path = out_dir.join(format!("{}.mp4", job_id));

    let mdir = weights_dir(entry);

    // Frame count: caller can override via `seconds * fps`; otherwise use
    // the catalog default. mlx-video's frame flags count frames, not seconds.
    // The second engine runs LTX at the rate it was trained at.
    // The rate the engine writes at, and not the one a caller sends: the
    // length in seconds is only right when both count with the same number.
    let _ = a.fps;
    let fps = frame_rate(entry);
    let frames = a
        .seconds
        .map(|s| (s * fps as f32).max(1.0) as u32)
        .unwrap_or(entry.default_frames);
    let frames = talking_frames.map_or_else(|| clamp_frames(entry.family, frames), |(f, _)| f);

    // The families take different CLIs (the first two verified against
    // Blaizzy/mlx-video, the third against dgrauet/ltx-2-mlx):
    //   ltx_2  → --model-repo <dir> --pipeline <p> -o <out> -n <frames>
    //   wan_2  → --model-dir <dir> --num-frames (4n+1) --output-path <out>
    //   ltx_2q → generate --distilled --model <dir> [--gemma <dir>] --output <out>
    //            -W -H --frames (8k+1) --frame-rate 24 [--low-ram]
    //   a2v    → a2v, the same flags, always --low-ram, then --audio <file>
    //   motion → -c motion::BOOT <video> <control> <filter> <frames> ic-lora,
    //            the ltx_2q flags, then the LoRA and the control (`motion`)
    let control = motion_video.as_ref().map(|_| motion::control_path(&out_dir, &job_id));
    let module: Vec<String> = if talking {
        ltx2mlx::A2V_CLI.iter().map(|s| s.to_string()).collect()
    } else if control.is_some() {
        motion::CLI.iter().map(|s| s.to_string()).collect()
    } else if quant {
        ltx2mlx::CLI.iter().map(|s| s.to_string()).collect()
    } else {
        vec![format!("mlx_video.models.{}.generate", entry.family)]
    };
    let mut cmd = crate::python::python_command(&python);
    if let (Some(video), Some(control)) = (motion_video.as_deref(), control.as_deref()) {
        if let Some(parent) = control.parent() {
            std::fs::create_dir_all(parent).map_err(|e| internal(os_error::english(&e)))?;
        }
        cmd.arg("-c").arg(motion::BOOT);
        motion::boot_args(&mut cmd, video, control, (width, height), frames);
    } else if entry.family == "wan_2" {
        cmd.arg("-c").arg(CAPPED_CACHE_BOOT);
        cmd.args(&module);
    } else {
        cmd.arg("-m");
        cmd.args(&module);
    }
    cmd.arg("--prompt").arg(&a.prompt);
    if quant {
        let encoder = (!entry.text_encoder_repo.is_empty()).then(|| text_encoder_dir(entry.text_encoder_repo));
        // A talking run streams always: stage two then swaps to the
        // distilled transformer on disk instead of fusing the distilled LoRA,
        // a file the packs leave out (`ltx2mlx`, Talking Character).
        // A motion run streams the transformer whatever the memory: it holds
        // the control and the LoRA on top, and resident it took the free
        // memory of a 48 GB Mac from 78 to 34 percent (`motion::motion_args`).
        let low_ram = talking
            || control.is_some()
            || ltx2mlx::wants_low_ram(
                crate::commands::system::total_memory_bytes(),
                ltx2mlx::transformer_bytes(&mdir),
            );
        ltx2mlx::model_args(
            &mut cmd,
            &mdir,
            encoder.as_deref(),
            (width, height),
            frames,
            &out_path,
            low_ram,
        );
        if let Some(audio) = a.audio.as_deref() {
            ltx2mlx::talking_args(&mut cmd, std::path::Path::new(audio));
        }
    } else if entry.family == "wan_2" {
        cmd.arg("--model-dir")
            .arg(mdir.as_os_str())
            .arg("--width")
            .arg(width.to_string())
            .arg("--height")
            .arg(height.to_string())
            .arg("--num-frames")
            .arg(frames.to_string())
            .arg("--output-path")
            .arg(out_path.as_os_str())
            .arg("--tiling")
            .arg(WAN_TILING);
        if let Some(steps) = steps {
            cmd.arg("--steps").arg(steps.to_string());
        }
    } else {
        cmd.arg("--model-repo")
            .arg(mdir.as_os_str())
            .arg("--pipeline")
            .arg(entry.pipeline);
        if !entry.text_encoder_repo.is_empty() {
            cmd.arg("--text-encoder-repo")
                .arg(text_encoder_dir(entry.text_encoder_repo).as_os_str());
        }
        cmd.arg("-o")
            .arg(out_path.as_os_str())
            .arg("-n")
            .arg(frames.to_string())
            .arg("--width")
            .arg(width.to_string())
            .arg("--height")
            .arg(height.to_string());
    }
    if let Some(seed) = a.seed {
        cmd.arg("--seed").arg(seed.to_string());
    }
    // In one argument: as two, a text that begins with a dash is read as a flag.
    if let Some(negative) = a.negative_prompt.as_deref().map(str::trim).filter(|n| !n.is_empty() && takes_negative_prompt(entry)) {
        cmd.arg(format!("--negative-prompt={negative}"));
    }
    if let Some(control) = control.as_deref() {
        motion::motion_args(&mut cmd, &motion::lora_path(), control);
    }
    lora_args(&mut cmd, &loras);
    if let Some(img) = a.init_image.as_deref() {
        cmd.arg("--image").arg(img);
    }

    // Reset the live progress slot: every new job starts clean.
    let progress = state.video_progress();
    progress.start();
    progress.log(format!("job {} → {}", job_id, out_path.display()));
    progress.log(format!(
        "python -m {} --prompt … {} … ({} frames)",
        module.join(" "),
        mdir.display(),
        frames
    ));
    if size_grid(entry).is_some() {
        progress.log(format!("size {width} x {height}"));
    }
    if let Some(steps) = steps {
        progress.log(format!("{steps} steps"));
    }
    if let Some((frames, seconds)) = talking_frames {
        progress.log(format!("voice {seconds:.2} s, clip {:.2} s", frames as f64 / fps as f64));
    }
    for ((name, _), (_, strength)) in asked_loras.iter().zip(&loras) {
        progress.log(format!("LoRA {} at {}", crate::commands::mlx_loras::stem(name), strength));
    }

    // Unbuffered: through a pipe Python holds its lines back in blocks, the
    // card stood at "Loading T5 encoder" for the first 18 seconds and the
    // lines of the decode were lost with the process when it was aborted.
    cmd.env("PYTHONUNBUFFERED", "1");
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
    // Dieselbe Fortschrittskarte wie beim Installer, also dieselbe Regel:
    // was das Betriebssystem geschrieben hat, steht dort englisch. Was der
    // Encoder selbst schreibt, bleibt Zeichen fuer Zeichen stehen.
    let pumps = [
        std::thread::spawn(move || {
            if let Some(s) = stdout {
                pump_lines(s, BAR_EVERY, |line| p_out.log(os_error::english_child_text(line).into_owned()));
            }
        }),
        std::thread::spawn(move || {
            if let Some(s) = stderr {
                pump_lines(s, BAR_EVERY, |line| p_err.log(os_error::english_child_text(line).into_owned()));
            }
        }),
    ];

    // Reaper thread: polls try_wait, flips slot to complete/error, clears
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
    // The control of a motion run is of no use once the run has ended.
    let control_for_thread = control.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let mut guard = video_process.lock().unwrap();
        let Some(child) = guard.as_mut() else {
            // video_cancel took and killed it, the slot is already failed.
            return;
        };
        let status = match child.try_wait() {
            Ok(None) => continue,
            Ok(Some(s)) => Ok(s),
            Err(e) => Err(e),
        };
        *guard = None;
        drop(guard);
        // The last lines of the engine say why it ended. They are read by
        // other threads, so those get a moment to hand them over.
        let waited = std::time::Instant::now();
        while pumps.iter().any(|p| !p.is_finished()) && waited.elapsed() < std::time::Duration::from_secs(2) {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        if let Some(control) = control_for_thread.as_deref() {
            let _ = std::fs::remove_file(control);
        }
        let out_of_memory = ran_out_of_memory(&video_progress_slot.snapshot().logs);
        match status.map(|s| job_outcome(&s, out_path2.exists(), out_of_memory)) {
            Ok(Ok(())) => {
                video_progress_slot.complete(format!("job {} complete → {}", job_id_for_thread, out_path2.display()));
            }
            Ok(Err(reason)) => video_progress_slot.fail(reason),
            Err(e) => video_progress_slot.fail(format!("wait failed: {}", os_error::english(&e))),
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

// The memory of this machine. A test sets it per thread, so the runs that
// check it do not depend on the machine the tests run on (CI runners have
// 7 GB). Outside tests the cell stays 0 and is never read.
thread_local! {
    static TEST_MEMORY_BYTES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn machine_memory_bytes() -> u64 {
    if cfg!(test) {
        let set = TEST_MEMORY_BYTES.with(|m| m.get());
        if set > 0 {
            return set;
        }
    }
    crate::commands::system::total_memory_bytes()
}

/// The sentence a generation is refused with on a Mac that has less memory
/// than the model needs, or `None` when it fits (or nothing could be measured).
///
/// The tile already says "Needs a Mac with N GB" and lets the download
/// through, which is the user's call. Running it is not: the weights go into
/// the one memory pool everything shares, macOS swaps, and the machine stops
/// answering for minutes. Counted in GiB and rounded, as the tile does, so a
/// Mac sold as 16 GB (17,179,869,184 bytes) is 16.
fn memory_refusal(entry: &CatalogEntry, total_bytes: u64) -> Option<String> {
    if total_bytes == 0 {
        return None;
    }
    let have_gb = (total_bytes as f64 / 1_073_741_824.0).round() as u32;
    (have_gb < entry.min_ram_gb).then(|| {
        format!(
            "{} needs a Mac with {} GB of memory, and this one has {} GB. It was not started, because loading it would freeze this Mac. Pick a smaller model.",
            entry.name, entry.min_ram_gb, have_gb
        )
    })
}

/// The sentence a start image is refused with for a model that cannot use
/// one, or `None` when there is no image or the model takes it.
fn image_refusal(entry: &CatalogEntry, has_image: bool) -> Option<String> {
    (has_image && !takes_start_image(entry)).then(|| {
        format!(
            "{} makes video from text and cannot start from an image. Omit init_image, or pick a model that takes a start image.",
            entry.name
        )
    })
}

// ── LoRA stack ────────────────────────────────────────────────────────

/// Whether a run of this model takes the user's LoRA stack, the files of the
/// Mac's LoRA folder (`mlx_loras`). Read from the engines at their pinned
/// commits, 14.10.2026:
///   ltx_2q  `generate` takes `--lora PATH STRENGTH`, repeatable, in every
///           mode, `--distilled` among them (`ltx_pipelines_mlx/cli.py`).
///   wan_2   `mlx_video.models.wan_2.generate` takes the same flag for every
///           checkpoint, a quantized one too (`wan_2/generate.py`, `utils.py`).
///   ltx_2   the first engine names one file alone (`--lora-path`), and no
///           run of this app has tried it. It takes none here.
fn takes_loras(c: &CatalogEntry) -> bool {
    c.family == ltx2mlx::FAMILY || c.family == "wan_2"
}

/// Whether Create offers the shot list for this model: the LTX-2.5 packs of
/// the second engine. LTX-2.5 cuts between shots when the prompt writes each
/// cut out in prose (the same rule as on Windows, `lib/ltx-multishot.ts`),
/// and the pack reads the prompt through its own Gemma like any other run, so
/// the shot list reaches it as the `--prompt` text. The engine's Prompt Relay
/// (`--segment`) is not used: see the commit that brought this.
fn takes_shot_list(c: &CatalogEntry) -> bool {
    c.family == ltx2mlx::FAMILY && c.repo_files == ltx2mlx::PACK_25
}

/// Whether the second engine finds anything to fuse in a file with these
/// tensor names: a `lora_A` matrix of a transformer block, with or without
/// ComfyUI's `diffusion_model.` in front. That is the one naming its key map
/// reads (`ltx_core_mlx/loader/sd_ops.py`, `LTXV_LORA_COMFY_RENAMING_MAP`);
/// with any other, nothing is fused and the video comes out as if there were
/// no LoRA, minutes later and without a word.
fn ltx_reads_lora(names: &[String]) -> bool {
    names.iter().any(|n| {
        let n = n.strip_prefix("diffusion_model.").unwrap_or(n);
        n.starts_with("transformer_blocks.") && n.split('.').any(|p| p == "lora_A")
    })
}

/// The LoRA stack of a run as the engine may read it, or the sentence for the
/// user. A name is a path below `folder` and nothing else (`mlx_loras::resolve`).
///
/// What an engine would only find out after minutes of loading is said here,
/// from the header of the file. The second engine (ltx_2q) reads the naming
/// of `ltx_reads_lora` and no alpha (`fuse_loras.py` multiplies the matrices
/// by the strength alone), so its strength goes out times `alpha / rank`, as
/// for Qwen-Image 2.1 on the image engine: the same file at the same number
/// then does what it does in ComfyUI. The first engine (wan_2) reads both
/// namings and the alpha of every layer itself (`mlx_video/lora/loader.py`)
/// and is handed the strength as it was asked for.
fn lora_stack(entry: &CatalogEntry, asked: &[(String, f32)], folder: &std::path::Path) -> Result<Vec<(PathBuf, f32)>, String> {
    use crate::commands::mlx_loras::{read_alpha, read_header, resolve, scaled, stem, strength, tensor_names, Alpha, Keys};
    if asked.is_empty() {
        return Ok(Vec::new());
    }
    if !takes_loras(entry) {
        return Err(format!(
            "{} takes no LoRA on a Mac. Turn the LoRA stack off, or pick a Wan or a quantized LTX model.",
            entry.name
        ));
    }
    let ltx = entry.family == ltx2mlx::FAMILY;
    asked
        .iter()
        .map(|(name, asked_strength)| {
            let file = resolve(folder, name)?;
            let header = read_header(&file);
            if header.keys == Keys::Unreadable {
                return Err(format!(
                    "{} is not a LoRA file the video engine can read. It may be an incomplete download.",
                    stem(name)
                ));
            }
            if header.dora {
                return Err(format!("{} is a DoRA. The video engines of the Mac read plain LoRAs only.", stem(name)));
            }
            if ltx && !ltx_reads_lora(&tensor_names(&file).unwrap_or_default()) {
                return Err(format!(
                    "{} is not a LoRA for LTX, or not in a format {} reads on a Mac. It takes LoRAs of the LTX transformer with lora_A and lora_B keys, the format of the LTX trainer and of ComfyUI. Turn this LoRA off or pick another one.",
                    stem(name),
                    entry.name
                ));
            }
            if !ltx && header.keys == Keys::Other {
                return Err(format!(
                    "{} is not a plain LoRA. {} reads LoRAs with lora_A and lora_B or lora_down and lora_up keys. Turn this LoRA off or pick another one.",
                    stem(name),
                    entry.name
                ));
            }
            let asked = strength(*asked_strength);
            let alpha = if ltx { read_alpha(&file) } else { Alpha::None };
            Ok((file, scaled(asked, alpha)))
        })
        .collect()
}

/// `--lora PATH STRENGTH` for every file of the stack, in the order it was
/// picked. Both engines read the flag the same way (argparse, `nargs=2`,
/// `action="append"`).
fn lora_args(cmd: &mut Command, loras: &[(PathBuf, f32)]) {
    for (file, strength) in loras {
        cmd.arg("--lora").arg(file.as_os_str()).arg(strength.to_string());
    }
}

/// How a generation ended, as `Ok` or the sentence for the progress card.
///
/// An exit 0 without a file used to be reported with the exit status in
/// Rust's debug print, `Some(0)`: a success in an error's colour.
fn job_outcome(status: &std::process::ExitStatus, output_exists: bool, out_of_memory: bool) -> Result<(), String> {
    if status.success() {
        return if output_exists {
            Ok(())
        } else {
            Err("The video engine finished without writing a video. Its last lines are in the log above.".to_string())
        };
    }
    if out_of_memory {
        return Err(OUT_OF_MEMORY.to_string());
    }
    if let Some(code) = status.code() {
        return Err(format!("The video engine stopped with exit code {code}. Its last lines are in the log above."));
    }
    let signal = {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            status.signal()
        }
        #[cfg(not(unix))]
        {
            None::<i32>
        }
    };
    Err(match signal {
        // SIGKILL that nobody here sent: Cancel takes the job away before this runs.
        Some(9) => "The video engine was ended by macOS (signal 9). That is what happens when memory runs out. Try a smaller model or a shorter video.".to_string(),
        Some(sig) => format!("The video engine was stopped before it finished (signal {sig})."),
        None => "The video engine ended before it finished, without an exit code.".to_string(),
    })
}

/// What a job that ran out of memory is told. MLX does not wait for macOS to
/// end it: Metal refuses the allocation, MLX throws, and the process aborts
/// with signal 6. "Stopped before it finished (signal 6)" was all the first
/// real Wan run said after 27 minutes (M5 Pro 48 GB, 09.10.2026).
const OUT_OF_MEMORY: &str = "The video engine ran out of memory. Close other apps and try again, or try a shorter video or a smaller model.";

/// Whether the engine's own lines say that memory ran out.
fn ran_out_of_memory(logs: &[String]) -> bool {
    logs.iter().rev().take(40).any(|line| line.contains("Insufficient Memory") || line.contains("OutOfMemory"))
}

/// How the Wan decode is cut into tiles. Left to the engine (`auto`: 512 px
/// and 64 frames a tile), the decode of the default clip of Wan 2.1 1.3B (832
/// x 480, 81 frames) held 66 GB and rising when Metal gave up, on a Mac with
/// 48 GB, after 26 minutes of denoising that were lost with it. At 256 px and
/// 32 frames it holds under 10 GB (direct runs of the CLI on the M5 Pro,
/// 09.10.2026). The engine has no step between the two.
const WAN_TILING: &str = "aggressive";

/// Starts a module of the first video engine with a cap on the buffer cache
/// of MLX, which the engine never sets. Without the cap the decode in small
/// tiles keeps every freed buffer of every tile shape: 39 GB at the peak and
/// 296 s for the decode, against 26 GB (the text encoder) and 142 s with it.
/// The arguments are the module and then its own, as after `-m`.
const CAPPED_CACHE_BOOT: &str = "import runpy, sys\nimport mlx.core as mx\nmx.set_cache_limit(1 << 30)\nsys.argv = sys.argv[1:]\nrunpy.run_module(sys.argv[0], run_name='__main__', alter_sys=True)\n";

/// wan_2's temporal VAE requires `num_frames % 4 == 1`; ltx_2 takes any, and
/// the second engine wants `8k + 1`.
fn clamp_frames(family: &str, frames: u32) -> u32 {
    if family == ltx2mlx::FAMILY {
        return ltx2mlx::clamp_frames(frames);
    }
    if family != "wan_2" {
        return frames.max(1);
    }
    let f = frames.max(5);
    f - ((f - 1) % 4)
}

/// How often a progress bar reaches the log while it is being redrawn.
const BAR_EVERY: std::time::Duration = std::time::Duration::from_secs(5);

/// Hand a child's output to `line`, one line at a time, as it arrives.
///
/// A line ends at a line feed, and a progress bar ends each drawing of itself
/// with a carriage return. Read up to the line feed alone, the whole bar of a
/// download arrived as ONE line when the download was over: the Qwen-Image
/// 2.1 pack loaded for 29 minutes without a single line in the log (real run
/// on the M5 Pro, 08.10.2026), and pip was silent for five minutes the same
/// way. A bar is redrawn ten times a second, so of its drawings one in
/// `bar_every` is passed on, and always the last one before a line feed.
fn pump_lines<R: std::io::Read>(mut stream: R, bar_every: std::time::Duration, mut line: impl FnMut(&str)) {
    let mut pending: Vec<u8> = Vec::new();
    // The latest drawing of a bar that was not passed on yet.
    let mut drawing: Option<String> = None;
    // The first drawing waits its turn like every other: a bar that is
    // over within the interval leaves only where it ended.
    let mut last_drawing = std::time::Instant::now();
    let mut chunk = [0u8; 8192];
    loop {
        let read = match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        for byte in &chunk[..read] {
            match *byte {
                b'\n' => {
                    // `\r\n` is one line ending: the text before it is held
                    // as a drawing and passed on here, whole and at once.
                    match (pending.is_empty(), drawing.take()) {
                        (true, Some(held)) => line(&held),
                        _ => line(&String::from_utf8_lossy(&pending)),
                    }
                    pending.clear();
                }
                b'\r' => {
                    let text = String::from_utf8_lossy(&pending).trim_end().to_string();
                    pending.clear();
                    if text.is_empty() {
                        continue;
                    }
                    if last_drawing.elapsed() >= bar_every {
                        last_drawing = std::time::Instant::now();
                        line(&text);
                        drawing = None;
                    } else {
                        drawing = Some(text);
                    }
                }
                // A bar without an end must not grow without one.
                other if pending.len() < 16 * 1024 => pending.push(other),
                _ => {}
            }
        }
    }
    if let Some(held) = drawing {
        line(&held);
    }
    if !pending.is_empty() {
        line(&String::from_utf8_lossy(&pending));
    }
}

pub(crate) fn run_streamed(slot: &crate::install_state::InstallSlot, cmd: &mut Command) -> Result<(), String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::process_util::no_window());
    }
    // A cancel between two steps has no child to stop. It stops the next
    // step from starting instead.
    if slot.cancel_requested() {
        return Err("cancelled".into());
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn: {}", os_error::english(&e)))?;
    slot.set_child(Some(child.id()));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let so = slot.clone();
    let se = slot.clone();
    let t1 = std::thread::spawn(move || {
        if let Some(s) = stdout {
            pump_lines(s, BAR_EVERY, |line| so.log(os_error::english_child_text(line).into_owned()));
        }
    });
    let t2 = std::thread::spawn(move || {
        if let Some(s) = stderr {
            pump_lines(s, BAR_EVERY, |line| se.log(os_error::english_child_text(line).into_owned()));
        }
    });
    let status = child.wait();
    slot.set_child(None);
    let status = status.map_err(|e| format!("wait: {}", crate::os_error::english(&e)))?;
    let _ = t1.join();
    let _ = t2.join();
    if !status.success() {
        return Err(exit_reason(&status));
    }
    Ok(())
}

/// Why a child did not run to the end, in a sentence a user can act on.
///
/// The old line was `format!("command exited {:?}", status.code())`, and after
/// a cancelled MLX download the panel read "command exited None" (bauer-m on
/// the Mac, 11.09.2026, N4). `None` is not an error code, it is the ABSENCE of
/// one: a process that ends on a signal never gets an exit code. Somebody
/// whose download died after hours was handed the least informative line the
/// app can produce.
///
/// The second half of that finding, that a cancelled download starts from zero
/// again, is not ours to fix here: huggingface_hub has named its partial file
/// `blobs/<sha256>.<8 random hex>.incomplete` since 1.18, deliberately, so
/// that two writers cannot poison one shared partial, and no later run can
/// pick it up (see mlx_snapshot.rs, `Partial`). What this message can do is
/// stop it from being a surprise.
fn exit_reason(status: &std::process::ExitStatus) -> String {
    if let Some(code) = status.code() {
        return format!("The installer stopped with exit code {code}.");
    }
    let signal = {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            status.signal()
        }
        #[cfg(not(unix))]
        {
            None::<i32>
        }
    };
    let how = match signal {
        Some(sig) => format!("The installer was stopped before it finished (signal {sig})."),
        None => "The installer ended before it finished, without an exit code.".to_string(),
    };
    format!("{how} Start it again: a partial download cannot be resumed, so it begins from the start.")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This file without its tests. A guard that searches the whole file
    /// finds the string it looks for in its own assertion.
    fn production_source() -> &'static str {
        let src = include_str!("video.rs");
        &src[..src.find("#[cfg(test)]").expect("the test module")]
    }

    /// The tests below write into `models_root()`, which under test is a
    /// scratch folder of this process, never the user's cache. They share it,
    /// so they take turns, and each starts from an empty one.
    fn empty_models_root() -> std::sync::MutexGuard<'static, ()> {
        static TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let guard = TURN.lock().unwrap_or_else(|e| e.into_inner());
        assert!(
            models_root().starts_with(crate::os_paths::test_storage::root()),
            "the test would write into the real cache"
        );
        let _ = std::fs::remove_dir_all(models_root());
        guard
    }

    /// A file of `bytes` apparent size that takes no room on disk.
    fn put(path: PathBuf, bytes: u64) {
        crate::test_support::sized_file(&path, bytes);
    }

    fn put_encoder(repo: &str) {
        put(text_encoder_dir(repo).join("config.json"), 2);
        put(text_encoder_dir(repo).join("model.safetensors"), 10);
    }

    fn entry(id: &str) -> &'static CatalogEntry {
        catalog_lookup(id).unwrap_or_else(|| panic!("{id} left the catalogue"))
    }

    /// Fund 10: `<id>/mlx` not empty was "installed", so a convert that was
    /// stopped halfway showed as a model and Generate loaded half a model.
    #[test]
    fn a_stopped_convert_is_not_an_installed_model() {
        let _turn = empty_models_root();
        let slot = crate::install_state::InstallSlot::default();
        let wan = entry("wan21-t2v-1.3b");
        let dir = model_dir(wan.id);

        // The convert was stopped: the source is there and so is half an output.
        put(dir.join("src").join("diffusion_pytorch_model.safetensors"), 100);
        put(dir.join("mlx").join("model.safetensors"), 40);
        assert!(!model_is_installed(wan), "half a convert reads as installed");

        // The next install clears the half output and keeps the download.
        begin_weights_install(&slot, wan).unwrap();
        assert!(!dir.join("mlx").exists(), "the half output is still there");
        assert!(dir.join("src").join("diffusion_pytorch_model.safetensors").is_file());
        assert!(!model_is_installed(wan));

        // The convert writes again and is stopped again, this time under the marker.
        put(dir.join("mlx").join("model.safetensors"), 40);
        assert!(!model_is_installed(wan));

        // It runs to the end.
        put(dir.join("mlx").join("model.safetensors"), 100);
        finish_weights_install(&slot, wan).unwrap();
        assert!(model_is_installed(wan));
        assert!(!dir.join("src").exists(), "the source gives its room back");
        assert!(converted_marker(wan).is_file() && !installing_marker(wan).exists());

        // A source that could not be removed does not undo a finished convert.
        put(dir.join("src").join("leftover.pth"), 5);
        assert!(model_is_installed(wan));
    }

    /// Fund 10, the other half: what was installed before the markers existed
    /// (`mlx/` there, `src/` gone, nothing else) stays installed.
    #[test]
    fn a_model_converted_before_the_markers_existed_is_still_installed() {
        let _turn = empty_models_root();
        let wan = entry("wan21-t2v-1.3b");
        put(model_dir(wan.id).join("mlx").join("model.safetensors"), 100);
        assert!(model_is_installed(wan));
        assert_eq!(disk_plan(wan), DiskPlan::default(), "nothing left to fetch");

        // The same for a plain download from then.
        let q8 = entry("wan22-ti2v-5b-q8");
        put(model_dir(q8.id).join("model.safetensors"), 100);
        assert!(model_is_installed(q8));
    }

    /// A plain download that was stopped has files in its folder as well.
    #[test]
    fn a_stopped_download_is_not_an_installed_model() {
        let _turn = empty_models_root();
        let slot = crate::install_state::InstallSlot::default();
        let q8 = entry("wan22-ti2v-5b-q8");
        assert!(!q8.needs_convert);
        begin_weights_install(&slot, q8).unwrap();
        put(model_dir(q8.id).join(".cache").join("huggingface").join("download").join("a.incomplete"), 10);
        put(model_dir(q8.id).join("config.json"), 2);
        assert!(!model_is_installed(q8), "a folder with something in it is not a model");
        finish_weights_install(&slot, q8).unwrap();
        assert!(model_is_installed(q8));
        assert!(!converted_marker(q8).exists(), "nothing was converted");
    }

    /// Fund 5: what the disk check asks for. A convert holds the download and
    /// its output side by side; a stopped attempt's bytes are not asked for twice.
    #[test]
    fn the_disk_plan_counts_the_convert_and_what_is_on_disk_already() {
        let _turn = empty_models_root();
        const GB: u64 = 1_000_000_000;
        let wan = entry("wan21-t2v-1.3b"); // 18 GB, converts
        let fresh = disk_plan(wan);
        assert_eq!((fresh.download, fresh.convert, fresh.encoder, fresh.reclaim), (18 * GB, 18 * GB, 0, 0));
        assert_eq!(fresh.need_bytes(), 38 * GB, "download, converted copy, headroom");
        assert!(fresh.note().contains("convert"));

        // Ten gigabytes arrived before it was stopped.
        put(convert_source_dir(wan).join("a.pth"), 10 * GB);
        assert_eq!(disk_plan(wan).need_bytes(), 28 * GB);
        // A half output from a stopped convert is removed first, so its room counts.
        put(convert_source_dir(wan).join("b.pth"), 8 * GB);
        put(weights_dir(wan).join("half.safetensors"), 5 * GB);
        let resumed = disk_plan(wan);
        assert_eq!((resumed.download, resumed.convert, resumed.reclaim), (0, 18 * GB, 5 * GB));
        assert_eq!(resumed.need_bytes(), 15 * GB);

        // A plain download needs its size once, plus the encoder nobody fetched.
        let dev = entry("ltx-2.3-dev"); // 58 GB, encoder 8.1 GB
        let plan = disk_plan(dev);
        assert_eq!((plan.download, plan.convert), (58 * GB, 0));
        assert_eq!(plan.note(), "");
        assert!(plan.encoder > 8 * GB && plan.encoder < 9 * GB, "{}", plan.encoder);

        // On a sibling's finished weights only the encoder is left.
        put(model_dir(dev.id).join("transformer").join("model.safetensors"), 100);
        let abliterated = entry("ltx-2.3-dev-abliterated");
        let plan = disk_plan(abliterated);
        assert_eq!((plan.download, plan.convert), (0, 0));
        assert!(plan.encoder > 6 * GB && plan.encoder < 7 * GB, "{}", plan.encoder);
        put_encoder(LTX23_ABLITERATED_TEXT_ENCODER);
        assert_eq!(disk_plan(abliterated).need_bytes(), DiskPlan::HEADROOM);

        // And the install asks before it starts anything.
        let src = production_source();
        let command = &src[src.find("pub fn video_install_model(").unwrap()..src.find("struct DiskPlan").unwrap()];
        let check = command.find("ensure_free_space(").expect("the install no longer checks the disk");
        assert!(check < command.find("if !slot.try_start()").unwrap(), "the disk is checked after the install began");
    }

    /// The delete path on shared weights, against a real folder tree: with a
    /// sibling installed the weights stay, with both gone everything is gone,
    /// and no text encoder is left behind for nobody.
    #[test]
    fn deleting_on_shared_weights_keeps_them_for_the_sibling_and_then_clears_everything() {
        let _turn = empty_models_root();
        // Not through the command: an `AppState` that is dropped ends whatever
        // listens on the image sidecar's port, on this very machine.
        let delete = |id: &str| delete_model_files(entry(id));
        let dev = entry("ltx-2.3-dev");
        let abliterated = entry("ltx-2.3-dev-abliterated");
        assert_eq!(weights_owner(abliterated).id, dev.id);
        let install_both = || {
            put(model_dir(dev.id).join("transformer").join("model.safetensors"), 100);
            put_encoder(dev.text_encoder_repo);
            put_encoder(abliterated.text_encoder_repo);
            assert!(model_is_installed(dev) && !model_is_installed(abliterated), "installed without having been asked for");
            put(encoder_claim(abliterated), 0);
            assert!(model_is_installed(abliterated));
        };

        // The one that owns the folder goes first.
        install_both();
        put(hf_home_dir().join("xet").join("chunk"), 50);
        delete(dev.id).unwrap();
        assert!(model_dir(dev.id).join("transformer").join("model.safetensors").is_file(), "the sibling lost its weights");
        assert!(!text_encoder_dir(dev.text_encoder_repo).exists(), "an encoder nobody uses stayed");
        assert!(!model_is_installed(dev) && model_is_installed(abliterated));
        assert!(!hf_home_dir().join("xet").exists(), "the chunk cache stayed");
        delete(abliterated.id).unwrap();
        assert!(!model_dir(dev.id).exists(), "the weights outlived both models");
        assert!(!text_encoder_dir(abliterated.text_encoder_repo).exists(), "an orphaned encoder");
        assert!(!models_root().join("_encoders").read_dir().is_ok_and(|mut d| d.next().is_some()));

        // The other order: the one that only brought an encoder goes first.
        install_both();
        delete(abliterated.id).unwrap();
        assert!(!text_encoder_dir(abliterated.text_encoder_repo).exists());
        assert!(model_is_installed(dev) && !model_is_installed(abliterated));
        // With the weights still there for the sibling, its own trace is gone,
        // and a second delete has nothing to do.
        assert!(delete(abliterated.id).is_err());
        assert!(model_is_installed(dev), "a second delete took the sibling's weights");
        delete(dev.id).unwrap();
        assert!(!model_dir(dev.id).exists() && !text_encoder_dir(dev.text_encoder_repo).exists());

        // An encoder that a third installed model reads stays for it.
        install_both();
        let distilled = entry("ltx-2.3-distilled");
        assert_eq!(distilled.text_encoder_repo, dev.text_encoder_repo);
        put(model_dir(distilled.id).join("transformer").join("model.safetensors"), 100);
        // The third model's own abliterated variant now has every file it
        // needs on disk. Nobody installed it, so it is not installed, and it
        // does not hold the encoder: before, the two variants kept it for
        // each other and neither could ever be removed.
        let other = entry("ltx-2.3-distilled-abliterated");
        assert_eq!(other.text_encoder_repo, abliterated.text_encoder_repo);
        assert!(!model_is_installed(other));
        assert!(delete(other.id).is_err(), "nothing of it is there to remove");
        // Its weights are the sibling's and its encoder the third model's:
        // nothing of it can go, and it says so instead of claiming a delete.
        let refusal = delete(dev.id).unwrap_err();
        assert!(refusal.contains("runs on files that other installed models use"), "{refusal}");
        assert!(model_is_installed(dev) && model_is_installed(distilled) && model_is_installed(abliterated));
        // With the sibling gone the weights go, and the encoder stays for the third.
        delete(abliterated.id).unwrap();
        assert!(!text_encoder_dir(abliterated.text_encoder_repo).exists(), "the abliterated encoder outlived its one user");
        delete(dev.id).unwrap();
        assert!(!model_dir(dev.id).exists());
        assert!(model_is_installed(distilled), "the encoder went with the wrong model");

        // An entry on shared weights that is not installed has no claim on
        // its sibling's folder, finished or half.
        // Two variants that were both installed each keep the encoder for the other.
        put(encoder_claim(other), 0);
        put_encoder(other.text_encoder_repo);
        put(encoder_claim(abliterated), 0);
        put(model_dir(dev.id).join("transformer").join("model.safetensors"), 100);
        put_encoder(dev.text_encoder_repo);
        assert!(model_is_installed(other) && model_is_installed(abliterated));
        delete(abliterated.id).unwrap();
        assert!(model_is_installed(other), "one variant's Remove took the other's encoder");
        assert!(!model_is_installed(abliterated));

        let _ = std::fs::remove_dir_all(models_root());
        put(model_dir(dev.id).join("transformer").join("model.safetensors"), 100);
        assert!(delete(abliterated.id).is_err());
        assert!(model_dir(dev.id).is_dir(), "weights without their encoder were taken by a sibling's Remove");
        // The folder's own entry removes it in any state.
        delete(dev.id).unwrap();
        assert!(!model_dir(dev.id).exists());
        assert!(delete(dev.id).is_err(), "nothing there, so nothing to remove");

        // And the command refuses while an install is writing.
        let src = production_source();
        let command = &src[src.find("pub fn video_delete_model(").unwrap()..src.find("fn delete_model_files(").unwrap()];
        assert!(command.find("install_video_model().is_running()").unwrap() < command.find("delete_model_files(entry)").unwrap());
    }

    /// Fund 6: without the image engine's venv the video engine fell through
    /// to the system Python, where pip refuses (PEP 668) or installs for 3.9.
    #[test]
    fn the_engine_runs_in_a_venv_and_never_in_the_system_python() {
        let root = tempfile::tempdir().unwrap();
        let (own, shared) = (root.path().join("mlx-video").join("venv"), root.path().join("mlx").join("venv"));
        assert_eq!(pick_engine_python(&own, &shared), None, "no venv, so no interpreter to install into");
        put(venv_python(&shared), 1);
        assert_eq!(pick_engine_python(&own, &shared), Some(venv_python(&shared)), "the image engine's venv is shared");
        // Its own venv wins once it exists, whatever the image side does later.
        put(venv_python(&own), 1);
        assert_eq!(pick_engine_python(&own, &shared), Some(venv_python(&own)));

        assert!(own_venv_dir().starts_with(crate::os_paths::data_dir()));
        assert_ne!(own_venv_dir(), shared_venv_dir());
        assert!(shared_venv_dir().ends_with("mlx/venv"), "where commands::mlx builds its venv");

        // No path from here to an interpreter outside a venv. `python_bin`
        // and `python_interpreters` may only name what a venv is built FROM.
        let src = production_source();
        let picker = &src[src.find("fn pick_engine_python").unwrap()..src.find("fn order_base_candidates").unwrap()];
        for system in ["find_python", "python_bin", "python_interpreters"] {
            assert!(!picker.contains(system), "{system}: the system Python is back as an install target");
        }
        // What is found on the machine goes into `-m venv`, and nowhere else.
        assert_eq!(src.matches("state.python_bin()").count(), src.matches("let preferred_base = state.python_bin();").count());
        assert_eq!(src.matches("find_python").count(), 1);
        assert_eq!(src.matches("python_interpreters").count(), 1);
        for (command, end) in [("pub fn video_install_mlx(", "pub fn video_install_mlx_status"), ("fn install_engine_steps(", "pub fn video_install_mlx_status")] {
            let body = &src[src.find(command).unwrap()..src.find(end).unwrap()];
            assert!(body.contains("ensure_engine_python(") || body.contains("install_engine_steps("), "{command}");
        }
    }

    /// GH #188: Homebrew's `python3` is 3.15 by now, and none of the pins has
    /// a wheel for it. It is passed over, said in the log, and a 3.14 next to
    /// it is taken.
    #[test]
    fn gh188_a_python_the_pins_have_no_wheels_for_is_passed_over() {
        let version_of = |p: &str| match p {
            "/opt/homebrew/bin/python3" => Some((3, 15)),
            "/opt/homebrew/bin/python3.14" => Some((3, 14)),
            "/Users/u/.pyenv/shims/python3.11" => Some((3, 11)),
            "/usr/bin/python3" => Some((3, 9)),
            _ => None,
        };
        let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let (picked, passed_over) = pick_base_python(
            names(&["/opt/homebrew/bin/python3", "/opt/homebrew/bin/python3.14", "/usr/bin/python3"]),
            version_of,
            TORCH_ENGINES_PYTHON,
        );
        assert_eq!(picked.as_deref(), Some("/opt/homebrew/bin/python3.14"));
        assert_eq!(passed_over, vec![("/opt/homebrew/bin/python3".to_string(), (3, 15))]);

        // Only the 3.15 and the stub: nothing here, LU fetches its own.
        let (picked, passed_over) = pick_base_python(names(&["/opt/homebrew/bin/python3", "/usr/bin/python3"]), version_of, TORCH_ENGINES_PYTHON);
        assert_eq!(picked, None);
        assert_eq!(passed_over.len(), 2);

        // 3.11 carries the image engines, not the video ones (numpy 2.5.3,
        // scipy 1.18.0 ask for 3.12).
        let pyenv = names(&["/Users/u/.pyenv/shims/python3.11"]);
        assert!(pick_base_python(pyenv.clone(), version_of, TORCH_ENGINES_PYTHON).0.is_some());
        assert!(pick_base_python(pyenv, version_of, VIDEO_ENGINES_PYTHON).0.is_none());

        // The Python LU fetches for itself fits every engine.
        if let Some(own) = crate::private_python::version_here() {
            assert!(TORCH_ENGINES_PYTHON.fits(own) && VIDEO_ENGINES_PYTHON.fits(own), "{own:?}");
        }
        assert_eq!(TORCH_ENGINES_PYTHON.label(), "3.11 to 3.14");
    }

    /// GH #188: a venv the 3.15 left behind answers pip, and pip failed in it
    /// on every retry. It is built again from a Python that fits.
    #[cfg(unix)]
    #[test]
    fn gh188_a_venv_built_from_python_315_is_not_continued_in() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let stub = |name: &str, answer: &str| {
            let path = root.path().join(name);
            std::fs::write(&path, format!("#!/bin/sh\necho '{answer}'\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path.to_string_lossy().to_string()
        };
        assert!(!venv_python_fits(&stub("py315", "3 15"), TORCH_ENGINES_PYTHON));
        assert!(venv_python_fits(&stub("py314", "3 14"), TORCH_ENGINES_PYTHON));
        assert!(!venv_python_fits(&stub("py311", "3 11"), VIDEO_ENGINES_PYTHON));
        assert!(!venv_python_fits(&root.path().join("missing").to_string_lossy(), TORCH_ENGINES_PYTHON));

        // Every engine asks it before continuing in a venv, and hands its
        // range to the base it builds a new one from.
        let mflux = include_str!("image_mflux.rs");
        assert!(mflux.contains("venv_python_fits(&python, TORCH_ENGINES_PYTHON)"));
        assert!(mflux.contains("base_python_or_own(slot, preferred_base, TORCH_ENGINES_PYTHON)"));
        let ltx = include_str!("video_ltx2mlx.rs");
        assert!(ltx.contains("venv_python_fits(&python, VIDEO_ENGINES_PYTHON)"));
        assert!(ltx.contains("base_python_or_own(slot, preferred_base, VIDEO_ENGINES_PYTHON)"));
        let src = production_source();
        assert!(src.contains("venv_python_fits(&text, VIDEO_ENGINES_PYTHON)"));
        assert!(src.contains("base_python_or_own(slot, preferred_base, VIDEO_ENGINES_PYTHON)"));
        assert!(include_str!("mlx.rs").contains("clear_dead_venv(slot, &venv_dir, interpreter_fits)"));
    }

    /// The bounds above were read on PyPI for exactly these pins. Moving one
    /// of them means reading the wheels again.
    #[test]
    fn the_python_ranges_were_read_for_these_pins() {
        let mflux = include_str!("image_mflux.rs");
        assert!(mflux.contains("\"torch==2.13.0\"") && mflux.contains("\"mlx==0.32.0\"") && mflux.contains("\"numpy==2.4.1\""));
        let sidecar = include_str!("../../resources/mlx/requirements.txt");
        assert!(sidecar.contains("torch==2.12.1") && sidecar.contains("numpy==2.4.6"));
        let ltx = include_str!("video_ltx2mlx.rs");
        assert!(ltx.contains("\"mlx==0.32.2\"") && ltx.contains("\"numpy==2.5.3\""));
        let src = production_source();
        assert!(src.contains("\"mlx==0.31.2\"") && src.contains("\"scipy==1.18.0\""));
        assert_eq!((TORCH_ENGINES_PYTHON.min, TORCH_ENGINES_PYTHON.max), ((3, 11), (3, 14)));
        assert_eq!((VIDEO_ENGINES_PYTHON.min, VIDEO_ENGINES_PYTHON.max), ((3, 12), (3, 14)));
    }

    #[test]
    fn the_stub_in_usr_bin_is_asked_last() {
        let order = order_base_candidates(
            ["/usr/bin/python3", "", "/opt/homebrew/bin/python3.12", "/usr/bin/python3", "/Users/x/.pyenv/versions/3.12.4/bin/python3"]
                .map(String::from)
                .to_vec(),
        );
        assert_eq!(order, ["/opt/homebrew/bin/python3.12", "/Users/x/.pyenv/versions/3.12.4/bin/python3", "/usr/bin/python3"]);
    }

    /// The venv is built with `<base> -m venv --clear <dir>`. The base here is
    /// a shell script that does what `venv` does to the folder it is given.
    #[cfg(unix)]
    #[test]
    fn a_venv_is_created_from_the_base_interpreter() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("python3.12");
        std::fs::write(
            &base,
            "#!/bin/sh\n[ \"$1\" = -m ] && [ \"$2\" = venv ] && [ \"$3\" = --clear ] || exit 3\nmkdir -p \"$4/bin\" && : > \"$4/bin/python\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o755)).unwrap();
        let slot = crate::install_state::InstallSlot::default();
        let venv = root.path().join("with space").join("venv");
        create_venv(&slot, &base.to_string_lossy(), &venv).unwrap();
        assert!(venv_python(&venv).is_file());

        // A base that fails says what was being attempted.
        std::fs::write(&base, "#!/bin/sh\nexit 1\n").unwrap();
        let err = create_venv(&slot, &base.to_string_lossy(), &root.path().join("other")).unwrap_err();
        assert!(err.starts_with("Could not create the Python environment for the video engine."), "{err}");
        assert!(err.contains("exit code 1"), "{err}");
    }

    /// Fund 11: `is_running()` and then `start()` let two clicks both through.
    #[test]
    fn every_install_claims_its_slot_in_one_step() {
        let src = production_source();
        assert!(!src.contains("slot.start()"), "an install starts without claiming its slot");
        for (command, end) in [("pub fn video_install_mlx(", "fn install_engine_steps("), ("pub fn video_install_model(", "struct DiskPlan")] {
            let body = &src[src.find(command).unwrap()..src.find(end).unwrap()];
            let claim = body.find("if !slot.try_start() {").unwrap_or_else(|| panic!("{command} does not claim the slot"));
            assert!(claim < body.find("std::thread::spawn").unwrap(), "{command} spawns before it holds the slot");
        }
    }

    /// Fund 12: nothing stopped a 64 GB model from loading on a 16 GB Mac.
    #[test]
    fn a_model_larger_than_the_memory_is_refused_before_it_loads() {
        const GIB: u64 = 1_073_741_824;
        let dev = entry("ltx-2.3-dev"); // 64 GB
        let msg = memory_refusal(dev, 16 * GIB).expect("16 GB is not 64");
        assert_eq!(
            msg,
            "LTX-2.3 Dev needs a Mac with 64 GB of memory, and this one has 16 GB. It was not started, because loading it would freeze this Mac. Pick a smaller model."
        );
        assert_eq!(memory_refusal(dev, 64 * GIB), None);
        assert_eq!(memory_refusal(dev, 128 * GIB), None);
        // A Mac sold as 16 GB runs the 16 GB model.
        let small = entry("wan21-t2v-1.3b");
        assert_eq!(memory_refusal(small, 17_179_869_184), None);
        assert!(memory_refusal(small, 8 * GIB).is_some());
        // Nothing measured is no reason to refuse.
        assert_eq!(memory_refusal(dev, 0), None);

        // Generate asks before it spawns, and the install does not ask at all:
        // the tile says it, and downloading is the user's call.
        let src = production_source();
        let generate = &src[src.find("pub fn video_generate(").unwrap()..src.find("pub fn video_progress(").unwrap()];
        assert!(generate.find("memory_refusal(").expect("generate no longer checks memory") < generate.find(".spawn()").unwrap());
        assert_eq!(src.matches("memory_refusal(").count(), 2, "the definition and the one call in generate");
    }

    /// A LoRA in the naming of the LTX trainer and of ComfyUI, one block at
    /// rank 4, with an alpha of `alpha` where given.
    fn write_ltx_lora(path: &std::path::Path, alpha: Option<f32>) {
        use crate::commands::mlx_loras::tests::write_tensors;
        let zeros = vec![0u8; 4 * 4 * 4];
        let mut tensors: Vec<(&str, &str, &[u64], Vec<u8>)> = vec![
            ("diffusion_model.transformer_blocks.0.attn1.to_q.lora_A.weight", "F32", &[4, 4], zeros.clone()),
            ("diffusion_model.transformer_blocks.0.attn1.to_q.lora_B.weight", "F32", &[4, 4], zeros),
        ];
        if let Some(a) = alpha {
            tensors.push(("diffusion_model.transformer_blocks.0.attn1.to_q.alpha", "F32", &[], a.to_le_bytes().to_vec()));
        }
        write_tensors(path, &tensors);
    }

    #[test]
    fn the_lora_stack_reaches_the_two_engines_that_read_it_and_no_other() {
        use crate::commands::mlx_loras::tests::{write_lora, KOHYA, PEFT};
        let dir = crate::os_paths::test_dir("video-loras");
        let folder: &std::path::Path = &dir;
        write_ltx_lora(&folder.join("ltx/dance.safetensors"), None);
        write_ltx_lora(&folder.join("ltx/half.safetensors"), Some(2.0));
        write_lora(&folder.join("diffusers.safetensors"), PEFT);
        write_lora(&folder.join("kohya.safetensors"), KOHYA);
        write_lora(&folder.join("lokr.safetensors"), &["lycoris_blocks_0.lokr_w1"]);
        write_lora(&folder.join("dora.safetensors"), &["diffusion_model.transformer_blocks.0.x.lora_A.weight", "diffusion_model.transformer_blocks.0.x.lora_magnitude_vector"]);
        std::fs::write(folder.join("broken.safetensors"), b"not a header").unwrap();
        let ask = |names: &[(&str, f32)]| names.iter().map(|(n, s)| (n.to_string(), *s)).collect::<Vec<_>>();

        // Nothing asked: nothing to check, for every model.
        for c in CATALOG {
            assert_eq!(lora_stack(c, &[], folder), Ok(Vec::new()), "{}", c.id);
        }
        // The list says it per model: the two engines that take `--lora`.
        for c in CATALOG {
            assert_eq!(takes_loras(c), c.family == ltx2mlx::FAMILY || c.family == "wan_2", "{}", c.id);
        }

        // The second engine: its own naming, at the strength times alpha / rank.
        let ltx = entry("ltx-2.3-q4");
        let stack = lora_stack(ltx, &ask(&[("ltx/dance.safetensors", 0.8), ("ltx/half.safetensors", 1.0)]), folder).unwrap();
        assert_eq!(stack.len(), 2);
        assert!(stack[0].0.ends_with("ltx/dance.safetensors") && stack[0].1 == 0.8, "{stack:?}");
        assert!(stack[1].0.ends_with("ltx/half.safetensors") && stack[1].1 == 0.5, "alpha 2 at rank 4: {stack:?}");
        // A file whose keys the engine's map never reaches is refused before
        // the model loads: the diffusers prefix, Kohya, anything else.
        for name in ["diffusers.safetensors", "kohya.safetensors", "lokr.safetensors"] {
            let err = lora_stack(ltx, &ask(&[(name, 1.0)]), folder).unwrap_err();
            assert!(err.contains("is not a LoRA for LTX") && err.contains(ltx.name), "{name}: {err}");
        }

        // The first engine's Wan reads both namings and its alpha itself.
        let wan = entry("wan21-t2v-1.3b");
        let stack = lora_stack(wan, &ask(&[("kohya.safetensors", 0.7), ("diffusers.safetensors", 1.0), ("ltx/half.safetensors", 1.0)]), folder).unwrap();
        assert_eq!(stack.iter().map(|(_, s)| *s).collect::<Vec<_>>(), [0.7, 1.0, 1.0], "no alpha scaling for Wan");
        let err = lora_stack(wan, &ask(&[("lokr.safetensors", 1.0)]), folder).unwrap_err();
        assert!(err.starts_with("lokr is not a plain LoRA."), "{err}");

        // For both: a DoRA, a broken file, a name outside the folder.
        for c in [ltx, wan] {
            assert!(lora_stack(c, &ask(&[("dora.safetensors", 1.0)]), folder).unwrap_err().contains("is a DoRA"));
            assert!(lora_stack(c, &ask(&[("broken.safetensors", 1.0)]), folder).unwrap_err().contains("incomplete download"));
            assert!(lora_stack(c, &ask(&[("../outside.safetensors", 1.0)]), folder).unwrap_err().contains("LoRA folder"));
            assert!(lora_stack(c, &ask(&[("gone.safetensors", 1.0)]), folder).unwrap_err().contains("no longer in the LoRA folder"));
        }
        // The first engine's LTX takes none, in words.
        let first = entry("ltx-2.3-distilled");
        let err = lora_stack(first, &ask(&[("ltx/dance.safetensors", 1.0)]), folder).unwrap_err();
        assert!(err.starts_with("LTX-2.3 Distilled takes no LoRA on a Mac."), "{err}");
    }

    #[test]
    fn the_shot_list_is_offered_for_the_ltx_2_5_packs_and_no_other_model() {
        let state = std::mem::ManuallyDrop::new(AppState::new());
        let list = video_list_models(&state, &json!({})).unwrap();
        let offered: Vec<&str> = list.as_array().unwrap().iter().filter(|m| m["multishot"] == true).map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(offered, ["ltx-2.5-q4", "ltx-2.5-q8"]);
        // The shots travel in the prompt, as one argument: no flag of their own.
        let src = production_source();
        let generate = &src[src.find("pub fn video_generate(").unwrap()..src.find("pub fn video_progress(").unwrap()];
        assert!(!generate.contains("--segment"));
    }

    #[test]
    fn size_and_steps_are_offered_on_the_grid_the_engine_keeps_and_nowhere_else() {
        for c in CATALOG {
            match c.family {
                // The second engine floors to 64, so a size off that grid
                // would come out smaller than Create said.
                f if f == ltx2mlx::FAMILY => {
                    assert_eq!(size_grid(c), Some(64), "{}", c.id);
                    assert_eq!(default_steps(c), None, "{}: --distilled reads no --steps", c.id);
                }
                // The first engine asserts its grid and stops on any other
                // size; without a size it ran square at 512 x 512.
                "ltx_2" => {
                    assert_eq!(size_grid(c), Some(if c.pipeline == "dev" { 32 } else { 64 }), "{}", c.id);
                    assert_eq!(default_steps(c), None, "{}", c.id);
                }
                "wan_2" => {
                    let ti2v = c.repo.contains("TI2V-5B");
                    assert_eq!(size_grid(c), Some(if ti2v { 32 } else { 16 }), "{}", c.id);
                    // Every Wan says which generation it is, which is what
                    // its config's default steps go by.
                    assert!(c.id.contains("wan21") || c.id.contains("wan22"), "{}", c.id);
                    assert_eq!(default_steps(c), Some(if c.id.contains("wan21") { 50 } else { 40 }), "{}", c.id);
                    // The engine's cap of 1280 x 704 for TI2V 5B and I2V A14B
                    // is never above what is offered.
                    if ti2v || c.requires_image {
                        assert!(max_pixels(c) <= 1280 * 704, "{}", c.id);
                    }
                }
                _ => {
                    assert_eq!(size_grid(c), None, "{}", c.id);
                    assert_eq!(default_steps(c), None, "{}", c.id);
                }
            }
            // The entry's own size is always a size a run may have, and the
            // smallest and the flipped shape of every grid fit the bounds.
            assert_eq!(run_size(c, None, None), Ok((c.default_width, c.default_height)), "{}", c.id);
            if let Some(grid) = size_grid(c) {
                assert_eq!((c.default_width % grid, c.default_height % grid), (0, 0), "{}", c.id);
                assert_eq!((MIN_SIDE % grid, MAX_SIDE % grid), (0, 0), "{}", c.id);
                assert_eq!(run_size(c, Some(c.default_height), Some(c.default_width)), Ok((c.default_height, c.default_width)), "{}", c.id);
                // The longest and the shortest side together still fit.
                assert!(MIN_SIDE * MAX_SIDE <= max_pixels(c), "{}", c.id);
            }
        }

        let ltx = entry("ltx-2.3-q4");
        assert_eq!(run_size(ltx, Some(512), Some(768)), Ok((512, 768)));
        assert_eq!(run_size(ltx, Some(640), Some(384)), Ok((640, 384)));
        assert!(run_size(ltx, Some(800), Some(480)).unwrap_err().contains("steps of 64 px"));
        assert!(run_size(ltx, Some(1024), Some(576)).unwrap_err().contains("larger than 768 x 512"));
        assert!(run_size(ltx, Some(192), Some(512)).unwrap_err().contains("256 to 1280 px"));
        assert!(run_size(ltx, Some(512), None).unwrap_err().contains("both width and height"));
        assert!(run_steps(ltx, Some(20)).unwrap_err().contains("takes no step count"));
        assert_eq!(run_steps(ltx, None), Ok(None));

        // The first engine's LTX: landscape by default, on 64 for the
        // distilled pipeline and on 32 for dev, and the size reaches it.
        let big = entry("ltx-2.3-distilled-1.1");
        assert_eq!(run_size(big, None, None), Ok((768, 512)));
        assert_eq!(run_size(big, Some(512), Some(768)), Ok((512, 768)));
        assert!(run_size(big, Some(736), Some(480)).unwrap_err().contains("steps of 64 px"));
        let dev = entry("ltx-2.3-dev");
        assert_eq!(run_size(dev, Some(736), Some(480)), Ok((736, 480)));
        let src = production_source();
        let first_engine = &src[src.find(".arg(\"--model-repo\")").unwrap()..src.find("if let Some(seed) = a.seed").unwrap()];
        assert!(first_engine.contains(".arg(\"--width\")\n            .arg(width.to_string())\n            .arg(\"--height\")\n            .arg(height.to_string())"));

        let wan = entry("wan21-t2v-1.3b");
        assert_eq!(run_size(wan, Some(480), Some(832)), Ok((480, 832)));
        assert_eq!(run_size(wan, Some(624), Some(624)), Ok((624, 624)));
        assert!(run_size(wan, Some(632), Some(624)).unwrap_err().contains("steps of 16 px"));
        assert_eq!(run_steps(wan, Some(8)), Ok(Some(8)));
        assert!(run_steps(wan, Some(0)).is_err() && run_steps(wan, Some(MAX_STEPS + 1)).is_err());

        let ti2v = entry("wan22-ti2v-5b-q8");
        assert_eq!(run_size(ti2v, Some(704), Some(1280)), Ok((704, 1280)));
        assert!(run_size(ti2v, Some(720), Some(1280)).unwrap_err().contains("steps of 32 px"));

        // The first engine's LTX takes a square too, on its grid.
        let first = entry("ltx-2.3-distilled");
        assert_eq!(run_size(first, Some(512), Some(512)), Ok((512, 512)));
    }

    #[test]
    fn the_size_reaches_both_engines_and_is_checked_before_the_process_exists() {
        let src = production_source();
        let generate = &src[src.find("pub fn video_generate(").unwrap()..src.find("pub fn video_progress(").unwrap()];
        let spawn = generate.find(".spawn()").unwrap();
        assert!(generate.find("run_size(entry, a.width, a.height)").unwrap() < spawn);
        assert!(generate.find("run_steps(entry, a.steps)").unwrap() < spawn);
        assert!(generate.contains("(width, height),\n            frames,"), "the second engine takes the run's size");
        assert!(generate.contains(".arg(\"--width\")\n            .arg(width.to_string())"));
        assert!(generate.contains(".arg(\"--height\")\n            .arg(height.to_string())"));
        assert!(!generate.contains("entry.default_width.to_string()"), "no branch passes the entry's size past run_size");
    }

    #[test]
    fn every_lora_goes_out_as_one_flag_with_its_strength_before_the_image() {
        let mut cmd = Command::new("python");
        lora_args(&mut cmd, &[(PathBuf::from("/l/a.safetensors"), 0.8), (PathBuf::from("/l/b c.safetensors"), -0.5)]);
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(args, ["--lora", "/l/a.safetensors", "0.8", "--lora", "/l/b c.safetensors", "-0.5"]);
        // `--image` takes one or more values on the second engine, so it
        // stays the last flag, after the stack.
        let src = production_source();
        let generate = &src[src.find("pub fn video_generate(").unwrap()..src.find("pub fn video_progress(").unwrap()];
        assert!(generate.find("lora_args(&mut cmd, &loras)").unwrap() < generate.find("cmd.arg(\"--image\")").unwrap());
        // The stack is checked before the process exists.
        assert!(generate.find("lora_stack(entry").unwrap() < generate.find(".spawn()").unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn a_job_that_ends_without_a_video_says_so() {
        use std::os::unix::process::ExitStatusExt;
        let exit = |code: i32| std::process::ExitStatus::from_raw(code << 8);
        assert_eq!(job_outcome(&exit(0), true, false), Ok(()));
        let msg = job_outcome(&exit(0), false, false).unwrap_err();
        assert!(msg.starts_with("The video engine finished without writing a video."), "{msg}");
        let msg = job_outcome(&exit(1), true, false).unwrap_err();
        assert!(msg.starts_with("The video engine stopped with exit code 1."), "{msg}");
        let killed = job_outcome(&std::process::ExitStatus::from_raw(9), false, false).unwrap_err();
        assert!(killed.contains("memory runs out"), "{killed}");
        for msg in [msg, killed] {
            assert!(!msg.contains("Some(") && !msg.contains("None"), "{msg}");
        }
        assert!(!production_source().contains("mlx_video exited"));
    }

    /// App texts carry no dashes. Comments from before this rule are not swept.
    #[test]
    fn no_message_carries_a_dash() {
        for line in production_source().lines() {
            let code = line.split("//").next().unwrap_or("");
            assert!(!code.contains('\u{2014}') && !code.contains('\u{2013}'), "{line}");
        }
    }

    #[test]
    fn hf_home_dir_is_a_folder_of_this_app_not_the_user_cache() {
        // K5: the Xet chunk cache must be a folder this app names, not the
        // OS-default `~/.cache/huggingface`. On Windows and Linux that is
        // under `models_root()`, as it always was. On a Mac the models moved
        // out of the cache folder and this scratch stayed in it.
        let scratch = crate::media_store::scratch_root(crate::media_store::Store::Video);
        assert!(scratch.starts_with(crate::os_paths::test_storage::root()));
        assert_eq!(hf_home_dir(), scratch.join(".hf-cache"));
        if cfg!(target_os = "macos") {
            assert!(!hf_home_dir().starts_with(models_root()), "download scratch among the models: {:?}", hf_home_dir());
            assert!(models_root().starts_with(crate::os_paths::data_dir()), "{:?}", models_root());
        } else {
            assert!(hf_home_dir().starts_with(models_root()), "{:?}", hf_home_dir());
        }
    }

    #[test]
    fn the_snapshot_download_call_sets_hf_home_and_xet_cache() {
        // K5 (Discord, 13.09.: "everytime I try to force the
        // app to go to my E drive it always takes up space on my C
        // drive"). huggingface_hub's Xet chunk cache ignores `local_dir`
        // and only follows HF_HOME/HF_XET_CACHE, without them it fills the
        // SYSTEM drive's default cache regardless of where models_root()
        // points. `commands::mlx.rs` already sets both on every
        // snapshot_download/hf_hub_download call; this proves this file's
        // one call site does too.
        let src = include_str!("video.rs");
        let start = src.find("fn install_model_steps(").expect("install_model_steps is gone");
        let end = src[start..]
            .find("\npub fn video_install_model_status")
            .map(|i| start + i)
            .unwrap_or(src.len());
        let body = &src[start..end];
        assert!(
            body.contains("from huggingface_hub import snapshot_download"),
            "the download call itself moved"
        );
        assert!(
            body.contains(".env(\"HF_HOME\", hf_home_dir())"),
            "HF_HOME is no longer set on the snapshot_download command"
        );
        assert!(
            body.contains(".env(\"HF_XET_CACHE\", hf_home_dir().join(\"xet\"))"),
            "HF_XET_CACHE is no longer set on the snapshot_download command"
        );
    }

    /// "command exited None" war die Meldung nach einem abgebrochenen
    /// MLX-Download (bauer-m N4). Siehe den Kopf von `exit_reason`.
    // Der Rohstatus mit einem Signal darin gibt es nur unter Unix; auf Windows
    // hat jeder beendete Prozess einen Code, dort kann "None" nicht entstehen.
    #[cfg(unix)]
    #[test]
    fn a_killed_installer_says_what_happened_and_what_to_do() {
        use std::os::unix::process::ExitStatusExt;
        let killed = std::process::ExitStatus::from_raw(9); // SIGKILL, kein Exit-Code
        assert_eq!(killed.code(), None, "die Ausgangslage des Befunds");
        let msg = exit_reason(&killed);
        assert!(!msg.contains("None"), "die alte Zeile ist zurueck: {msg}");
        assert!(msg.contains("signal 9"), "{msg}");
        assert!(msg.contains("Start it again"), "die Meldung nennt den naechsten Schritt nicht: {msg}");
        assert!(msg.contains("begins from the start"), "{msg}");

        // Gegenprobe: ein gewoehnlicher Fehlschlag nennt weiter seinen Code
        // und erzaehlt nichts vom Fortsetzen.
        let failed = std::process::ExitStatus::from_raw(1 << 8); // exit(1)
        assert_eq!(failed.code(), Some(1));
        let msg = exit_reason(&failed);
        assert!(msg.contains("exit code 1"), "{msg}");
        assert!(!msg.contains("Start it again"), "{msg}");

        // Und der Satz erreicht die Oberflaeche wirklich: `run_streamed` ist
        // der einzige Ort, der den Status eines Installationskindes in einen
        // Fehler verwandelt, und er muss diesen hier nehmen.
        let src = include_str!("video.rs");
        // Nur der Rumpf von run_streamed, sonst faende sich der Aufruf in
        // diesem Test selbst wieder und der Waechter bewiese nichts.
        let body = &src[src.find("pub(crate) fn run_streamed").expect("run_streamed")
            ..src.find("/// Why a child did not run to the end").expect("exit_reason")];
        assert!(body.contains("Err(exit_reason(&status))"), "run_streamed meldet wieder selbst");
        assert!(!body.contains("command exited"), "die alte Zeile steht wieder im Quelltext");
    }

    #[test]
    fn the_list_says_what_a_run_takes_and_what_it_does_not() {
        let state = std::mem::ManuallyDrop::new(AppState::new());
        let list = video_list_models(&state, &json!({})).unwrap();
        for model in list.as_array().unwrap() {
            // Persona walk, 09.10.2026: Create showed 25 steps, guidance 5.0
            // and 16 fps for LTX-2.3 Distilled, none of which the run took.
            assert_eq!(model["userSampling"], false, "{}", model["id"]);
            let id = model["id"].as_str().unwrap();
            let entry = catalog_lookup(id).unwrap();
            // The rate the engines write at: 16 for Wan 2.1 and the 14B pair
            // of Wan 2.2, 24 for Wan 2.2 TI2V 5B and for every LTX.
            let rate = if id.starts_with("wan22-ti2v-5b") || entry.family != "wan_2" { 24 } else { 16 };
            assert_eq!(model["fps"], rate, "{id}");
            assert_eq!(model["defaultWidth"], entry.default_width, "{id}");
            assert_eq!(model["defaultHeight"], entry.default_height, "{id}");
            // A negative prompt: Wan and the dev pipelines of the first
            // engine's LTX. No distilled model, and none on the second engine.
            let negative = entry.family == "wan_2" || (entry.family == "ltx_2" && entry.pipeline == "dev");
            assert_eq!(model["negativePrompt"], negative, "{id}");
            assert!(!(entry.family == ltx2mlx::FAMILY && negative), "{id}: the second engine ends with an error on the flag");
        }
        assert_eq!(frame_rate(catalog_lookup("wan21-t2v-1.3b").unwrap()), 16);
        assert_eq!(frame_rate(catalog_lookup("wan22-t2v-a14b").unwrap()), 16);
        assert_eq!(frame_rate(catalog_lookup("wan22-ti2v-5b-q8").unwrap()), 24);
        assert_eq!(frame_rate(catalog_lookup("ltx-2.3-q4").unwrap()), 24);
        // And the command line agrees: no flag for guidance anywhere, and
        // steps on Wan alone, the one family whose entry says `steps`.
        let src = include_str!("video.rs");
        let generate = &src[src.find("pub fn video_generate").unwrap()..src.find("pub fn video_progress").unwrap()];
        for flag in ["--cfg", "--guidance", "--stage1-steps"] {
            assert!(!generate.contains(flag), "video_generate passes {flag}, and the list says the user's sampling reaches no run");
        }
        assert_eq!(generate.matches("\"--steps\"").count(), 1);
        let wan = &generate[generate.find("} else if entry.family == \"wan_2\" {").unwrap()..generate.find("cmd.arg(\"--model-repo\")").unwrap()];
        assert!(wan.contains("cmd.arg(\"--steps\")"), "steps go out on the Wan branch and nowhere else");
        // The negative prompt goes to the models that take one, in one
        // argument, and the length is counted at the engine's rate.
        assert!(generate.contains("format!(\"--negative-prompt={negative}\")"));
        assert!(generate.contains("takes_negative_prompt(entry)"));
        assert!(generate.contains("let fps = frame_rate(entry);"));
    }

    #[test]
    fn a_progress_bar_reaches_the_log_while_it_is_drawn_and_not_as_one_line_at_the_end() {
        fn lines_of(bytes: &[u8], every: std::time::Duration) -> Vec<String> {
            let mut out = Vec::new();
            pump_lines(bytes, every, |l| out.push(l.to_string()));
            out
        }
        let none = std::time::Duration::ZERO;
        let never = std::time::Duration::from_secs(3600);
        // What `snapshot_download` writes: a line, then a bar that returns the
        // carriage after every drawing, then a line again.
        let hub = b"asking\n\rFetching:   0%|   | 0/18\rFetching:  50%|#  | 9/18\rFetching: 100%|###| 18/18\ndone\n";
        assert_eq!(
            lines_of(hub, none),
            ["asking", "Fetching:   0%|   | 0/18", "Fetching:  50%|#  | 9/18", "Fetching: 100%|###| 18/18", "done"],
            "every drawing is a line of its own"
        );
        // Held back to one in an hour, the bar still shows where it ended.
        assert_eq!(lines_of(hub, never), ["asking", "Fetching: 100%|###| 18/18", "done"]);
        // A bar that is cut off (the child was stopped) leaves its last drawing.
        assert_eq!(lines_of(b"\r 10%|#\r 20%|##\r", never), [" 20%|##"]);
        // Windows line endings are one ending, and nothing of them is held back.
        assert_eq!(lines_of(b"one\r\ntwo\r\n", never), ["one", "two"]);
        // Plain lines as before, the empty one and the one without an ending included.
        assert_eq!(lines_of(b"a\n\nb", never), ["a", "", "b"]);
        // The production readers all go through it.
        let src = include_str!("video.rs");
        let production = &src[..src.find("#[cfg(test)]\nmod tests").unwrap()];
        assert!(!production.contains(".lines().map_while(Result::ok)"), "a child's output is read line feed by line feed again");
        assert_eq!(production.matches("pump_lines(s, BAR_EVERY").count(), 4);
    }

    #[test]
    fn catalog_ids_unique_and_covers_hardware_range() {
        let mut ids: Vec<&str> = CATALOG.iter().map(|c| c.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), CATALOG.len(), "duplicate catalog id");
        assert_eq!(CATALOG.len(), 31);
        // Eight on each side of the switch, and each side from small to large.
        for unfiltered in [false, true] {
            let side: Vec<&CatalogEntry> = CATALOG.iter().filter(|c| c.unfiltered == unfiltered).collect();
            assert!(side.len() >= 8, "unfiltered={unfiltered}: {}", side.len());
            assert!(side.iter().any(|c| c.min_ram_gb <= 16), "unfiltered={unfiltered}");
            assert!(side.iter().any(|c| c.min_ram_gb >= 64), "unfiltered={unfiltered}");
            // Eight with weights of their own. An entry that gives a
            // sibling's weights another text encoder is a variant, not a model.
            let own = side.iter().filter(|c| c.shares_weights_with.is_empty()).count();
            assert!(own >= 8, "unfiltered={unfiltered}: {own} with weights of their own");
            // And something for every memory size a Mac is sold with.
            for ram in [16, 24, 32, 48] {
                assert!(side.iter().any(|c| c.min_ram_gb == ram), "unfiltered={unfiltered}: nothing that starts at {ram} GB");
            }
        }
        assert_eq!(CATALOG.iter().filter(|c| !c.unfiltered).count(), 17);
        assert_eq!(CATALOG.iter().filter(|c| c.unfiltered).count(), 14);
        assert_eq!(CATALOG.iter().filter(|c| c.unfiltered && c.shares_weights_with.is_empty()).count(), 9);
    }

    #[test]
    fn official_models_are_mainstream_and_only_altered_ones_are_unfiltered() {
        // Owner's decision, 08.10.2026: an official Wan is a mainstream model.
        for c in CATALOG {
            let official = ["Wan-AI/", "Lightricks/", "prince-canuma/", "Anes1032/", "dgrauet/"].iter().any(|o| c.repo.starts_with(o));
            let abliterated = c.text_encoder_repo == LTX23_ABLITERATED_TEXT_ENCODER;
            assert_eq!(c.unfiltered, !official || abliterated, "{}", c.id);
        }
    }

    /// Real run on an M5 Pro with 48 GB, 09.10.2026. LTX-2.3 Distilled 4-bit
    /// made two seconds of 768 x 512 with sound in 64 s at a peak of 14.0 GB.
    /// Wan 2.1 T2V 1.3B, until then the starter of Create and promised for
    /// 16 GB, took 1713 s for five seconds of 832 x 480 without sound, at a
    /// peak of 24.5 GB.
    #[test]
    fn the_starter_is_the_fast_model_that_ran_and_wan_says_what_was_measured() {
        let starters: Vec<&CatalogEntry> = CATALOG.iter().filter(|c| c.starter).collect();
        assert_eq!(starters.len(), 1, "the setup of Create takes one model");
        let starter = starters[0];
        assert_eq!(starter.id, "ltx-2.3-q4");
        assert!(!starter.unfiltered && !starter.requires_image, "Create sets up from the text to video tab");
        assert!(!starter.description.contains("Experimental"), "the starter is a model that has run here");
        // The tile grid keeps the order of the catalogue: the starter leads
        // the Mainstream side.
        assert_eq!(CATALOG.iter().find(|c| !c.unfiltered).unwrap().id, starter.id);

        let wan = entry("wan21-t2v-1.3b");
        assert!(
            wan.description.starts_with("Slow on a Mac: about half an hour for five seconds on an M5 Pro, and without sound."),
            "{}",
            wan.description
        );

        // Recommended memory and the line a run is refused below are two
        // numbers. Every Wan is recommended from 32 GB on, and nothing else
        // changes.
        for c in CATALOG {
            let recommended = recommended_ram_gb(c);
            assert!(recommended >= c.min_ram_gb, "{}", c.id);
            if c.family == "wan_2" {
                assert_eq!(recommended, c.min_ram_gb.max(32), "{}", c.id);
            } else {
                assert_eq!(recommended, c.min_ram_gb, "{}", c.id);
            }
        }
        // The two it changes: the small Wan and its fine-tune, which reads
        // its prompt through the same T5 file (`WAN21_BASE_FILES`).
        let changed: Vec<&str> = CATALOG.iter().filter(|c| recommended_ram_gb(c) != c.min_ram_gb).map(|c| c.id).collect();
        assert_eq!(changed, ["wan21-t2v-1.3b", "nsfw-wan21-1.3b"]);
        assert_eq!(entry("nsfw-wan21-1.3b").base_repo, wan.repo);
        // Not measured on a small Mac, so not forbidden there either.
        const GIB: u64 = 1_073_741_824;
        for id in changed {
            assert_eq!(memory_refusal(entry(id), 16 * GIB), None, "{id}");
            assert_eq!(memory_refusal(entry(id), 24 * GIB), None, "{id}");
        }

        // The list says all of it, and what a Get fetches beside the model.
        let _turn = empty_models_root();
        let state = std::mem::ManuallyDrop::new(AppState::new());
        let list = video_list_models(&state, &json!({})).unwrap();
        let row = |id: &str| list.as_array().unwrap().iter().find(|m| m["id"] == id).unwrap().clone();
        assert_eq!(row("ltx-2.3-q4")["starter"], true);
        assert_eq!(row("ltx-2.3-q4")["sizeGB"], 20.5);
        assert_eq!(row("ltx-2.3-q4")["textEncoderGB"], 8.1);
        assert_eq!(row("ltx-2.3-q4")["recommendedRamGB"], 16);
        assert_eq!(row("wan21-t2v-1.3b")["starter"], false);
        assert_eq!(row("wan21-t2v-1.3b")["textEncoderGB"], 0.0);
        assert_eq!(row("wan21-t2v-1.3b")["minRamGB"], 16);
        assert_eq!(row("wan21-t2v-1.3b")["recommendedRamGB"], 32);
        // Only the two entries a real run was timed for carry a time.
        assert_eq!(row("wan21-t2v-1.3b")["measuredRunSecondsPerClipSecond"], 345.0);
        assert_eq!(row("ltx-2.3-q4")["measuredRunSecondsPerClipSecond"], 32.0);
        let timed = CATALOG.iter().filter(|c| c.measured_run_s_per_clip_s > 0.0).count();
        assert_eq!(timed, 2, "a time in the catalogue is a measured one");
        // An encoder that is here is not fetched again.
        put_encoder(LTX23_TEXT_ENCODER);
        let list = video_list_models(&state, &json!({})).unwrap();
        let q4 = list.as_array().unwrap().iter().find(|m| m["id"] == "ltx-2.3-q4").unwrap();
        assert_eq!(q4["textEncoderGB"], 0.0);
    }

    #[test]
    fn an_entry_that_never_ran_says_so() {
        // The seven of the first Mac catalogue keep their text. Everything
        // added on 08.10.2026 is backed by source and headers alone, until it
        // has run: LTX-2.3 Distilled 4-bit made its first clips from text and
        // from an image on 09.10.2026 (M5 Pro 48 GB, 64 s and 52 s). Wan 2.1
        // T2V 1.3B ran the same day and says what that took.
        let first = [
            "wan21-t2v-1.3b", "wan22-ti2v-5b", "ltx-2.3-dev", "wan21-t2v-14b",
            "ltx-2.3-distilled", "ltx-2-distilled", "wan22-t2v-a14b",
        ];
        let ran_since = ["ltx-2.3-q4"];
        for c in CATALOG {
            let marked = c.description.ends_with("Experimental: not yet tested in LU.");
            assert_eq!(marked, !first.contains(&c.id) && !ran_since.contains(&c.id), "{}", c.id);
            assert!(!c.description.contains('\u{2014}') && !c.description.contains('\u{2013}'), "{}", c.id);
        }
    }

    #[test]
    fn a_fine_tune_names_the_one_file_it_ships_and_where_the_rest_comes_from() {
        for c in CATALOG.iter().filter(|c| !c.base_repo.is_empty()) {
            // The wan convert globs `*.safetensors` in the checkpoint folder,
            // so exactly one transformer may land there, and at its top level.
            assert_eq!(c.family, "wan_2", "{}", c.id);
            assert!(c.needs_convert, "{}", c.id);
            assert_eq!(c.repo_files.len(), 1, "{}", c.id);
            assert!(c.repo_files[0].ends_with(".safetensors") && !c.repo_files[0].contains('/'), "{}", c.id);
            assert!(c.base_repo.starts_with("Wan-AI/Wan2.1-T2V-"), "{}", c.id);
        }
        // The base files carry no transformer of their own.
        assert!(WAN21_BASE_FILES.iter().all(|f| !f.ends_with(".safetensors")));
        assert!(WAN21_BASE_FILES.contains(&"config.json"));
        for id in ["nsfw-wan21-1.3b", "nsfw-wan21-14b", "nsfw-wan21-14b-q4"] {
            assert!(!catalog_lookup(id).unwrap().base_repo.is_empty(), "{id}");
        }
    }

    #[test]
    fn an_ltx_checkpoint_that_converts_names_its_file_first() {
        for c in CATALOG.iter().filter(|c| c.family == "ltx_2" && c.needs_convert) {
            let first = c.repo_files.first().unwrap_or_else(|| panic!("{}: no checkpoint", c.id));
            assert!(first.ends_with(".safetensors") && !first.contains("upscaler"), "{}", c.id);
            // LTX-2.3 carries no text encoder, converted or not.
            assert!(!c.text_encoder_repo.is_empty(), "{}", c.id);
            // The two stage pipeline loads `*spatial-upscaler-x2*` from the
            // model folder, and the convert copies it from beside the source.
            if c.pipeline == "distilled" {
                assert!(c.repo_files.iter().any(|f| f.contains("spatial-upscaler-x2") && !f.contains('/')), "{}", c.id);
            }
        }
        assert_eq!(ltx_convert_variant("distilled"), "distilled");
        assert_eq!(ltx_convert_variant("dev"), "dev");
        assert_eq!(ltx_convert_variant("dev-two-stage"), "dev");
        let src = production_source();
        assert!(src.contains(".arg(\"mlx_video.models.ltx_2.convert\")"));
        assert!(src.contains(".arg(\"--output\")"), "ltx convert takes --output, not --output-dir");
    }

    #[test]
    fn an_entry_on_shared_weights_points_at_its_sibling_and_brings_only_an_encoder() {
        let sharers: Vec<&CatalogEntry> = CATALOG.iter().filter(|c| !c.shares_weights_with.is_empty()).collect();
        assert_eq!(sharers.len(), 5);
        for c in sharers {
            let owner = catalog_lookup(c.shares_weights_with).unwrap_or_else(|| panic!("{}: unknown sibling", c.id));
            assert!(owner.shares_weights_with.is_empty(), "{}: no chains", c.id);
            assert_eq!(weights_dir(c), weights_dir(owner), "{}", c.id);
            assert_eq!(
                (c.family, c.repo, c.repo_files, c.pipeline, c.needs_convert, c.size_gb),
                (owner.family, owner.repo, owner.repo_files, owner.pipeline, owner.needs_convert, owner.size_gb),
                "{}", c.id
            );
            assert_ne!(c.text_encoder_repo, owner.text_encoder_repo, "{}: nothing would differ", c.id);
            assert_eq!(c.text_encoder_repo, LTX23_ABLITERATED_TEXT_ENCODER, "{}", c.id);
        }
    }

    #[test]
    fn allow_patterns_are_python_source() {
        assert_eq!(python_patterns(&[]), "None");
        assert_eq!(python_patterns(&["a.safetensors", "v1.8/b.safetensors"]), r#"["a.safetensors", "v1.8/b.safetensors"]"#);
        // No file name in the catalogue needs escaping that Rust and Python
        // would spell differently.
        for f in CATALOG.iter().flat_map(|c| c.repo_files.iter()).chain(WAN21_BASE_FILES.iter()) {
            assert!(f.chars().all(|ch| ch.is_ascii_alphanumeric() || "._-/".contains(ch)), "{f}");
        }
    }

    #[test]
    fn only_wan_quantizes_and_only_at_four_or_eight_bits() {
        for c in CATALOG.iter().filter(|c| c.quant_bits != 0) {
            assert!(c.family == "wan_2" && c.needs_convert, "{}", c.id);
            assert!(c.quant_bits == 4 || c.quant_bits == 8, "{}", c.id);
            assert!(c.shares_weights_with.is_empty(), "{}", c.id);
        }
        assert_eq!(catalog_lookup("wan21-t2v-14b-q4").unwrap().quant_bits, 4);
    }

    #[test]
    fn the_image_to_video_model_is_the_one_that_requires_an_image() {
        let need: Vec<&str> = CATALOG.iter().filter(|c| c.requires_image).map(|c| c.id).collect();
        assert_eq!(need, ["wan22-i2v-a14b"]);
        let src = production_source();
        assert!(src.contains("entry.requires_image && a.init_image.is_none()"), "generate no longer refuses up front");
        assert!(src.contains("\"requiresImage\": c.requires_image"), "the list no longer tells the frontend");
    }

    /// The chat tool can hand any model an image. One that takes none says so
    /// before anything loads.
    #[test]
    fn an_image_for_a_text_only_model_is_refused_before_it_loads() {
        for id in ["wan21-t2v-1.3b", "wan21-t2v-14b", "wan22-t2v-a14b", "ltx-2.3-dev", "ltx-2.3-distilled", "ltx-2.3-distilled-1.1", "ltx23-10eros"] {
            let msg = image_refusal(entry(id), true).unwrap_or_else(|| panic!("{id} took an image"));
            assert!(msg.ends_with("makes video from text and cannot start from an image. Omit init_image, or pick a model that takes a start image."), "{msg}");
            assert!(msg.starts_with(entry(id).name), "{msg}");
            assert_eq!(image_refusal(entry(id), false), None, "{id}: text alone is fine");
            // And its description promises no image.
            assert!(!entry(id).description.contains("from an image"), "{id}");
        }
        for id in ["wan22-ti2v-5b", "ltx-2-dev", "wan22-i2v-a14b", "ltx-2.3-q8", "ltx-2.5-q4", "10eros-v1.3-dmd-q4"] {
            assert_eq!(image_refusal(entry(id), true), None, "{id}");
        }
        // No description says more than the catalogue's own flag.
        for c in CATALOG.iter().filter(|c| c.description.contains("from an image")) {
            assert!(takes_start_image(c), "{}", c.id);
        }
        let src = production_source();
        let generate = &src[src.find("pub fn video_generate(").unwrap()..src.find("pub fn video_progress(").unwrap()];
        assert!(generate.find("image_refusal(entry, a.init_image.is_some())").expect("generate passes any image on") < generate.find(".spawn()").unwrap());
    }

    #[test]
    fn the_catalogue_names_the_models_that_start_from_an_image() {
        // The first engine, entry by entry. Wan 2.1, Wan 2.2 T2V and every
        // LTX-2.3 on mlx-video stay out (see `CatalogEntry::accepts_image`).
        let first_engine: Vec<&str> = CATALOG
            .iter()
            .filter(|c| c.family != ltx2mlx::FAMILY && takes_start_image(c))
            .map(|c| c.id)
            .collect();
        assert_eq!(first_engine, ["wan22-ti2v-5b-q8", "wan22-ti2v-5b", "ltx-2-dev", "ltx-2-distilled", "wan22-i2v-a14b"]);
        // The second engine takes one for every pack it runs.
        let second_engine: Vec<&CatalogEntry> = CATALOG.iter().filter(|c| c.family == ltx2mlx::FAMILY).collect();
        assert!(!second_engine.is_empty());
        assert!(second_engine.into_iter().all(takes_start_image));
        // A model that needs an image is one that takes it.
        assert!(CATALOG.iter().filter(|c| c.requires_image).all(takes_start_image));
        assert!(production_source().contains("\"acceptsImage\": takes_start_image(c)"), "the list no longer tells the frontend");
    }

    #[test]
    fn the_status_never_imports_the_engine() {
        // Five seconds per look at the Model Manager, measured.
        let production = production_source();
        let status = &production[production.find("pub fn video_status(").unwrap()..];
        let status = &status[..status.find("\n}\n").unwrap()];
        assert!(!status.contains("mlx_video_imports"), "the status imports mlx_video again");
        assert_eq!(production.matches("mlx_video_imports(").count(), 2, "one definition, one use: after the install");
    }

    #[test]
    fn the_engine_version_is_read_from_the_record_pip_left() {
        let temp = tempfile::tempdir().unwrap();
        let venv = temp.path();
        let python = venv.join("bin/python").to_string_lossy().to_string();
        // No venv, an empty venv, a venv with other packages: no engine.
        assert_eq!(mlx_video_version(&python), None);
        let site = venv.join("lib/python3.12/site-packages");
        std::fs::create_dir_all(site.join("mlx_video")).unwrap();
        std::fs::create_dir_all(site.join("mlx-0.31.2.dist-info")).unwrap();
        std::fs::write(site.join("mlx-0.31.2.dist-info/METADATA"), "Name: mlx\nVersion: 0.31.2\n").unwrap();
        std::fs::create_dir_all(site.join("mlx_video_extras-3.0.dist-info")).unwrap();
        std::fs::write(site.join("mlx_video_extras-3.0.dist-info/METADATA"), "Name: mlx-video-extras\nVersion: 3.0\n").unwrap();
        // The package folder alone is what a pip run that was stopped leaves:
        // the record is written last.
        assert!(!mlx_video_installed(&python), "a folder without its record is not an installed engine");
        let record = site.join("mlx_video-0.0.1.dist-info");
        std::fs::create_dir_all(&record).unwrap();
        // A record without a readable version is no answer either.
        std::fs::write(record.join("METADATA"), "Name: mlx-video\n\nVersion: from the description\n").unwrap();
        assert_eq!(mlx_video_version(&python), None);
        std::fs::write(record.join("METADATA"), "Metadata-Version: 2.4\nName: mlx-video\nVersion: 0.0.1\nSummary: x\n\ntext\n").unwrap();
        assert_eq!(mlx_video_version(&python).as_deref(), Some("0.0.1"));
        assert!(mlx_video_installed(&python));
        // Uninstalled: pip takes the record away, and the engine is gone.
        std::fs::remove_dir_all(&record).unwrap();
        assert!(!mlx_video_installed(&python));
    }

    #[test]
    fn mlx_is_pinned_beside_the_engine_in_both_install_paths() {
        let specs = mlx_video_pip_specs();
        for name in ["mlx==", "mlx-lm==", "mlx-vlm=="] {
            assert!(specs.iter().any(|s| s.starts_with(name)), "{name} is not in the install");
        }
        assert_eq!(specs.last(), Some(&MLX_VIDEO_PIP_SPEC));
        let production = production_source();
        assert_eq!(production.matches("mlx_video_pip_specs()").count(), 3, "one definition, two installs");
        assert_eq!(production.matches("MLX_VIDEO_PIP_SPEC").count(), 2, "an install line that skips the MLX pins");
    }

    #[test]
    fn the_engine_is_installed_from_one_pinned_commit() {
        assert!(MLX_VIDEO_PIP_SPEC.starts_with("mlx-video @ https://github.com/Blaizzy/mlx-video/archive/"));
        assert!(!MLX_VIDEO_PIP_SPEC.contains("git+"), "pip needs git for that, and a fresh Mac has none");
        let sha = MLX_VIDEO_PIP_SPEC.rsplit('/').next().unwrap().trim_end_matches(".zip");
        assert_eq!(sha.len(), 40, "a full commit id, not a branch or a short hash");
        assert!(sha.chars().all(|c| c.is_ascii_hexdigit()));
        // Both install paths use the constant; a second spelling would be the
        // unpinned one coming back.
        let src = include_str!("video.rs");
        let unpinned = ["mlx-video", ".git\""].concat();
        assert!(!src.contains(unpinned.as_str()), "an install line without the commit");
    }

    #[test]
    fn ltx_23_names_the_text_encoder_its_repository_does_not_carry() {
        for id in ["ltx-2.3-dev", "ltx-2.3-distilled", "ltx-2.3-distilled-1.1", "ltx23-10eros", "ltx23-pinkcherry"] {
            assert_eq!(catalog_lookup(id).unwrap().text_encoder_repo, LTX23_TEXT_ENCODER, "{id}");
        }
        // LTX-2 brings its own under text_encoder/, and Wan converts its T5.
        for c in CATALOG {
            // On the second engine, every pack but LTX-2.5 is an LTX-2.3 pack
            // under some name. LTX-2.5 carries its Gemma 4 in the pack.
            let ltx23 = c.id.starts_with("ltx-2.3")
                || c.id.starts_with("ltx23-")
                || (c.family == ltx2mlx::FAMILY && !c.id.starts_with("ltx-2.5"));
            assert_eq!(!c.text_encoder_repo.is_empty(), ltx23, "{}", c.id);
        }
        assert!(text_encoder_gb(LTX23_TEXT_ENCODER) > text_encoder_gb(LTX23_ABLITERATED_TEXT_ENCODER));
        // The generate line hands the encoder over, or the fix is half of one.
        let src = include_str!("video.rs");
        assert!(src.contains(".arg(\"--text-encoder-repo\")"));
    }

    /// The first real run of the first video engine (Wan 2.1 1.3B, M5 Pro
    /// 48 GB, 09.10.2026): 26 minutes of denoising, then Metal refused the
    /// decode and the card said "stopped before it finished (signal 6)".
    #[cfg(unix)]
    #[test]
    fn a_wan_run_decodes_in_small_tiles_under_a_capped_cache_and_says_when_memory_ran_out() {
        use std::os::unix::process::ExitStatusExt;
        let src = production_source();
        let generate = &src[src.find("pub fn video_generate(").unwrap()..src.find("pub fn video_progress(").unwrap()];
        let wan = &generate[generate.find("} else if entry.family == \"wan_2\" {").unwrap()..generate.find("cmd.arg(\"--model-repo\")").unwrap()];
        assert!(wan.contains(".arg(\"--tiling\")") && wan.contains(".arg(WAN_TILING)"));
        assert_eq!(WAN_TILING, "aggressive");
        assert!(generate.contains("if entry.family == \"wan_2\" {\n        cmd.arg(\"-c\").arg(CAPPED_CACHE_BOOT);"));
        // The start code caps the cache before the engine is loaded, and hands
        // the engine the arguments it would have had after `-m`.
        let cap = CAPPED_CACHE_BOOT.find("mx.set_cache_limit(1 << 30)").unwrap();
        assert!(cap < CAPPED_CACHE_BOOT.find("runpy.run_module(sys.argv[0], run_name='__main__', alter_sys=True)").unwrap());
        assert!(CAPPED_CACHE_BOOT.contains("sys.argv = sys.argv[1:]"));
        assert!(generate.contains("cmd.env(\"PYTHONUNBUFFERED\", \"1\")"));

        // What MLX wrote before it aborted decides the sentence, not the signal.
        let abort = std::process::ExitStatus::from_raw(6);
        let logs = |last: &str| vec!["Diffusion: 100%".to_string(), last.to_string(), "warnings.warn(...)".to_string()];
        let metal = "libc++abi: terminating due to uncaught exception of type std::runtime_error: [METAL] Command buffer execution failed: Insufficient Memory (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)";
        assert!(ran_out_of_memory(&logs(metal)));
        assert!(!ran_out_of_memory(&logs("Traceback (most recent call last):")));
        assert_eq!(job_outcome(&abort, false, true).unwrap_err(), OUT_OF_MEMORY);
        assert!(OUT_OF_MEMORY.contains("ran out of memory"));
        assert!(job_outcome(&abort, false, false).unwrap_err().contains("signal 6"));
        // A run that wrote its video is not failed by a line in its log.
        assert_eq!(job_outcome(&std::process::ExitStatus::from_raw(0), true, true), Ok(()));
        assert!(generate.contains("job_outcome(&s, out_path2.exists(), out_of_memory)"));
    }

    #[test]
    fn the_bar_of_an_install_counts_the_text_encoder_that_is_still_to_come() {
        let _turn = empty_models_root();
        let q4 = entry("ltx-2.3-q4");
        let pack = (q4.size_gb as f64 * 1e9) as u64;
        let (dir, total) = bar_of(q4);
        assert_eq!(dir, Some(text_encoder_dir(LTX23_TEXT_ENCODER)));
        assert_eq!(total, pack + (text_encoder_gb(LTX23_TEXT_ENCODER) as f64 * 1e9) as u64);
        // Another entry brought it: the pack alone.
        put_encoder(LTX23_TEXT_ENCODER);
        assert_eq!(bar_of(q4), (None, pack));
        // A model without one.
        let wan = entry("wan21-t2v-1.3b");
        assert_eq!(bar_of(wan), (None, (wan.size_gb as f64 * 1e9) as u64));
        let src = production_source();
        assert!(src.contains("watch_dir_size(slot.clone(), target, encoder_dir.into_iter().collect(), total)"));
    }

    #[test]
    fn a_text_encoder_folder_without_weights_is_not_an_encoder() {
        let dir = std::env::temp_dir().join(format!("lu-encoder-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!text_encoder_present(&dir), "an empty folder");
        std::fs::write(dir.join("config.json"), "{}").unwrap();
        assert!(!text_encoder_present(&dir), "a config and no weights: an aborted pull");
        std::fs::write(dir.join("model-00001-of-00002.safetensors"), "x").unwrap();
        assert!(text_encoder_present(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn catalog_families_match_cli_expectations() {
        for c in CATALOG {
            match c.family {
                "ltx_2" => {
                    assert!(!c.pipeline.is_empty(), "{} needs a --pipeline", c.id);
                    // A whole repository is the modular layout already; a
                    // named file is a checkpoint that has to become one.
                    assert_eq!(c.needs_convert, !c.repo_files.is_empty(), "{}", c.id);
                    assert_eq!(c.default_frames % 8, 1, "{}: ltx frames must be 8n+1", c.id);
                }
                "wan_2" => {
                    // Wan-AI ships PyTorch checkpoints. The one repository
                    // that holds the convert's output says so in its name.
                    assert_eq!(c.needs_convert, !c.repo.contains("-mlx-"), "{}", c.id);
                    assert_eq!(c.default_frames % 4, 1, "{}: wan frames must be 4n+1", c.id);
                    assert!(c.pipeline.is_empty(), "{}", c.id);
                }
                ltx2mlx::FAMILY => {
                    // Quantized already: nothing to convert and nothing for
                    // the wan convert to quantize. Distilled is the one mode
                    // every pack has the transformer for.
                    assert!(!c.needs_convert && c.quant_bits == 0 && c.base_repo.is_empty(), "{}", c.id);
                    assert_eq!(c.pipeline, "distilled", "{}", c.id);
                    assert_eq!(c.default_frames % 8, 1, "{}: frames must be 8k+1", c.id);
                    // Stage one runs at half size, so both sides are multiples of 64.
                    assert_eq!((c.default_width % 64, c.default_height % 64), (0, 0), "{}", c.id);
                    let packs = [ltx2mlx::PACK_23, ltx2mlx::PACK_23_V11, ltx2mlx::PACK_25];
                    assert!(packs.contains(&c.repo_files), "{}: not one of the packs", c.id);
                    // An LTX-2.5 pack brings its encoder, and it is the gated one.
                    let ltx25 = c.repo_files == ltx2mlx::PACK_25;
                    assert_eq!(ltx25, c.id.starts_with("ltx-2.5"), "{}", c.id);
                    assert_eq!(ltx25, c.text_encoder_repo.is_empty(), "{}", c.id);
                    assert_eq!(ltx25, c.description.contains("Hugging Face token"), "{}", c.id);
                    assert!(c.min_ram_gb <= 48, "{}: this engine is here for the Macs under 64 GB", c.id);
                }
                other => panic!("{}: unknown family {other}", c.id),
            }
            assert!(c.repo.contains('/'));
            assert!(c.size_gb > 0.0 && c.default_width > 0 && c.default_height > 0);
        }
    }

    /// A pack for the second engine is a model once that engine is there, and
    /// the engine comes with the model: no step of the first engine is in the way.
    #[test]
    fn a_quantized_pack_is_installed_with_its_engine_and_not_before() {
        let _turn = empty_models_root();
        let q8 = entry("ltx-2.3-q8");
        for f in q8.repo_files {
            put(model_dir(q8.id).join(f), 1);
        }
        put_encoder(q8.text_encoder_repo);
        assert_eq!(weights_dir(q8), model_dir(q8.id), "the download is the model, nothing converts");

        ltx2mlx::set_ready_for_test(false);
        assert!(model_is_installed(q8), "the files are whole");
        assert!(!model_is_usable(q8), "and without the engine nothing can run them");
        ltx2mlx::set_ready_for_test(true);
        assert!(model_is_usable(q8));
        ltx2mlx::set_ready_for_test(false);

        // The first engine's models do not ask about the second.
        let wan = entry("wan22-ti2v-5b-q8");
        put(model_dir(wan.id).join("model.safetensors"), 1);
        assert!(model_is_usable(wan));

        // The abliterated variant runs on the same folder and fetches an encoder.
        let abliterated = entry("ltx-2.3-q8-abliterated");
        assert_eq!(weights_dir(abliterated), weights_dir(q8));
        let plan = disk_plan(abliterated);
        assert_eq!((plan.download, plan.convert, plan.note()), (0, 0, ""));
        assert!(plan.encoder > 6_000_000_000, "{}", plan.encoder);
        // It shares its Gemma with the first engine's LTX-2.3, so a Mac that
        // has one of those fetches no second encoder.
        assert_eq!(q8.text_encoder_repo, entry("ltx-2.3-dev").text_encoder_repo);

        let src = production_source();
        let between = |from: &str, to: &str| &src[src.find(from).unwrap_or_else(|| panic!("{from}"))..src.find(to).unwrap_or_else(|| panic!("{to}"))];
        // Install: the engine of the family, then the pack, and the files are counted.
        let install = between("pub fn video_install_model(", "struct DiskPlan");
        assert!(install.contains("ltx2mlx::ensure_engine(&slot2, preferred_base)"));
        assert!(install.contains("if model_is_usable(entry) {") && install.contains("!model_is_usable(&entry2)"));
        let steps = between("fn install_model_steps(", "fn convert_weights(");
        assert!(steps.find("if entry.family != ltx2mlx::FAMILY {").unwrap() < steps.find("\"mlx_video\"").unwrap(), "mlx-video goes into the second engine's venv");
        assert!(steps.contains("ltx2mlx::verify_pack(&download_to, owner.repo_files)?"));
        // A gated repository answers with the token sentence.
        assert!(between("fn hub_download(", "fn python_patterns(").contains("crate::commands::mlx::run_hub_step(slot, &mut cmd, &[target, &hf_home_dir()])"));
        // Generate: its own interpreter, its own flags, and memory decides on streaming.
        let generate = between("pub fn video_generate(", "pub fn video_progress(");
        assert!(generate.contains("ltx2mlx::python()") && generate.contains("ltx2mlx::model_args("));
        assert!(generate.contains("ltx2mlx::wants_low_ram(") && generate.contains("ltx2mlx::transformer_bytes(&mdir)"));
        assert!(generate.contains("let fps = frame_rate(entry);") && frame_rate(catalog_lookup("ltx-2.3-q4").unwrap()) == ltx2mlx::FRAME_RATE);
        assert!(generate.find("model_is_usable(entry)").unwrap() < generate.find(".spawn()").unwrap());
        // The surface learns about the second engine, and a tile reads installed with it only.
        assert!(between("pub fn video_status(", "pub fn video_delete_model(").contains("\"ltx2MlxInstalled\": ltx2_ok"));
        assert!(between("pub fn video_list_models(", "pub fn video_install_mlx(").contains("\"installed\": model_is_usable(c)"));
        // Remove is about files and stays so.
        assert!(!between("fn delete_model_files(", "pub fn video_list_models(").contains("model_is_usable"));
    }

    /// Talking Character (3.0.8): LTX-2.3 4-bit runs the engine's `a2v` once
    /// its dev transformer is on disk, a download of its own.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn talking_character_runs_on_the_4_bit_pack_with_its_own_download() {
        let _turn = empty_models_root();
        // The checks below are about the parts, not the memory: a 64 GB Mac.
        TEST_MEMORY_BYTES.with(|m| m.set(64 * 1_073_741_824));
        let q4 = entry("ltx-2.3-q4");
        // Only the entry a real run talked on, and only on the second engine.
        let talking: Vec<&str> = CATALOG.iter().filter(|c| talks(c)).map(|c| c.id).collect();
        assert_eq!(talking, ["ltx-2.3-q4"]);
        assert!(CATALOG.iter().all(|c| c.talking_gb == 0.0 || c.family == ltx2mlx::FAMILY));

        let state = std::mem::ManuallyDrop::new(AppState::new());
        let row = |id: &str| {
            let list = video_list_models(&state, &json!({})).unwrap();
            list.as_array().unwrap().iter().find(|m| m["id"] == id).cloned().unwrap()
        };
        assert_eq!(row("ltx-2.3-q4")["talking"], true);
        assert_eq!(row("ltx-2.3-q4")["talkingGB"].as_f64().map(|g| (g * 10.0).round()), Some(113.0));
        assert_eq!(row("ltx-2.3-q4")["talkingReady"], false);
        assert_eq!(row("ltx-2.3-q8")["talking"], false);

        // Not before the model: the download is the model's part.
        ltx2mlx::set_ready_for_test(true);
        let part = json!({ "id": "ltx-2.3-q4", "part": "talking" });
        let err = video_install_model(&state, &part).unwrap_err();
        assert!(err.contains("Get LTX-2.3 Distilled 4-bit first"), "{err}");
        let err = video_install_model(&state, &json!({ "id": "ltx-2.3-q8", "part": "talking" })).unwrap_err();
        assert!(err.contains("cannot run Talking Character"), "{err}");
        let err = video_install_model(&state, &json!({ "id": "ltx-2.3-q4", "part": "voice" })).unwrap_err();
        assert!(err.contains("unknown part"), "{err}");

        for f in q4.repo_files {
            put(model_dir(q4.id).join(f), 1);
        }
        put_encoder(q4.text_encoder_repo);
        assert!(model_is_usable(q4) && !talking_ready(q4));

        // A run with a voice is refused in words before anything loads.
        let voice = tempfile::NamedTempFile::new().unwrap();
        let run = |id: &str, audio: &str| video_generate(&state, &json!({ "id": id, "prompt": "p", "audio": audio }));
        let err = run("ltx-2.3-q4", &voice.path().to_string_lossy()).unwrap_err();
        assert!(err.contains("needs its own download (11.3 GB)"), "{err}");

        put(model_dir(q4.id).join("transformer-dev.safetensors"), 1);
        assert!(talking_ready(q4));
        assert_eq!(row("ltx-2.3-q4")["talkingReady"], true);
        // With the part there, a second Get finishes at once.
        assert_eq!(video_install_model(&state, &part).unwrap()["status"], "complete");
        let err = run("ltx-2.3-q4", "/no/such/voice.wav").unwrap_err();
        assert!(err.starts_with("audio not found"), "{err}");
        let err = video_generate(&state, &json!({ "id": "ltx-2.3-q4", "prompt": "p", "audio": voice.path(), "loras": [{ "name": "a.safetensors" }] })).unwrap_err();
        assert!(err.contains("LoRA"), "{err}");
        for f in entry("ltx-2.3-q8").repo_files {
            put(model_dir("ltx-2.3-q8").join(f), 1);
        }
        let err = run("ltx-2.3-q8", &voice.path().to_string_lossy()).unwrap_err();
        assert!(err.contains("cannot run Talking Character"), "{err}");

        // Remove takes the part and keeps the model.
        let gone = video_delete_model(&state, &part).unwrap();
        assert_eq!(gone["part"], "talking");
        assert!(model_is_usable(q4) && !talking_ready(q4));
        assert!(video_delete_model(&state, &part).is_err(), "nothing left to remove");
        ltx2mlx::set_ready_for_test(false);

        // The command line: a2v instead of generate --distilled, streamed,
        // the voice after the flags of the pack, the start image last.
        let src = production_source();
        let generate = &src[src.find("pub fn video_generate(").unwrap()..src.find("pub fn video_progress(").unwrap()];
        assert!(generate.contains("ltx2mlx::A2V_CLI.iter()"));
        assert!(generate.contains("let low_ram = talking\n            || control.is_some()\n            || ltx2mlx::wants_low_ram("));
        let voice_at = generate.find("ltx2mlx::talking_args(&mut cmd").unwrap();
        assert!(generate.find("ltx2mlx::model_args(").unwrap() < voice_at);
        assert!(voice_at < generate.find("cmd.arg(\"--image\")").unwrap(), "--image takes one or more values and stays last");
        // The length is the voice's, read by Rust, and the memory check comes
        // before the process.
        assert!(generate.contains("ltx2mlx::audio_seconds(") && generate.contains("ltx2mlx::talking_frames(seconds"));
        assert!(generate.find("talking_needs_more_memory(").unwrap() < generate.find(".spawn()").unwrap());
    }

    #[test]
    fn a_talking_run_is_refused_on_a_mac_with_too_little_memory() {
        const GIB: u64 = 1_073_741_824;
        let q4 = entry("ltx-2.3-q4");
        assert!(talking_needs_more_memory(q4, 16 * GIB).unwrap().contains(&format!("needs a Mac with {TALKING_MIN_RAM_GB} GB")));
        assert!(talking_needs_more_memory(q4, TALKING_MIN_RAM_GB as u64 * GIB).is_none());
        assert!(talking_needs_more_memory(q4, 48 * GIB).is_none());
        assert!(talking_needs_more_memory(q4, 0).is_none(), "nothing measured: the run is not refused");
    }

    #[test]
    fn clamp_frames_enforces_wan_4n_plus_1() {
        assert_eq!(clamp_frames("wan_2", 81), 81);
        assert_eq!(clamp_frames("wan_2", 80), 77);
        assert_eq!(clamp_frames("wan_2", 1), 5);
        assert_eq!(clamp_frames("ltx_2", 80), 80);
        assert_eq!(clamp_frames("ltx_2", 0), 1);
        assert_eq!(clamp_frames(ltx2mlx::FAMILY, 80), 73);
        assert_eq!(clamp_frames(ltx2mlx::FAMILY, 49), 49);
    }

    #[test]
    fn weights_dir_points_at_converted_output_for_wan() {
        let wan = catalog_lookup("wan21-t2v-1.3b").unwrap();
        let ltx = catalog_lookup("ltx-2.3-dev").unwrap();
        assert!(weights_dir(wan).ends_with(format!("{}/mlx", wan.id)));
        assert!(weights_dir(ltx).ends_with(ltx.id));
        // Pre-converted Wan runs from the download, a converted LTX from /mlx.
        let q8 = catalog_lookup("wan22-ti2v-5b-q8").unwrap();
        assert!(weights_dir(q8).ends_with(q8.id));
        let eros = catalog_lookup("ltx23-10eros").unwrap();
        assert!(weights_dir(eros).ends_with(format!("{}/mlx", eros.id)));
    }
}
