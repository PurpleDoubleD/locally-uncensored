//! The second video engine: `dgrauet/ltx-2-mlx`.
//!
//! It runs LTX packs that are quantized already (4-bit and 8-bit, and bf16
//! with its blocks streamed from disk), which is what brings LTX to Macs with
//! 16 to 48 GB. `mlx-video`, the first engine, loads LTX at full size only.
//!
//! This is a child module of `commands::video`: it uses that file's venv,
//! download and process helpers and adds what is its own. The engine lives in
//! a venv of its own. Its `mlx-arsenal` pulls MLX up to 0.32, and on 0.32 the
//! first engine renders LTX-2.3 black (mlx-video #55), so the two cannot share
//! one environment.
//!
//! Every statement about the command line below was read from the engine's
//! source at the pinned commit (`ltx_pipelines_mlx/cli.py`, `distilled.py`,
//! `utils/blocks.py`, `ltx_core_mlx/utils/ffmpeg.py`), 08.10.2026.

use super::{base_python_or_own, create_venv, own_venv_dir, python_has_module, run_streamed, venv_python, venv_python_fits, VIDEO_ENGINES_PYTHON};
use crate::install_state::InstallSlot;
use std::path::{Path, PathBuf};
use std::process::Command;

/// `CatalogEntry::family` of every model this engine runs.
pub(super) const FAMILY: &str = "ltx_2q";

/// Release v0.16.2. The project ships several releases a week and calls itself
/// alpha, so nothing here follows a branch.
pub(super) const COMMIT: &str = "ade739e1adf19c29468ec081879a92426edc055d";
pub(super) const VERSION: &str = "0.16.2";
/// The archive of the commit, not a `git+` address: pip would need `git` for
/// that, and a Mac without the Xcode tools has none.
const SOURCE: &str = "https://github.com/dgrauet/ltx-2-mlx/archive";

/// The repository's root has no build system. What installs are these two
/// packages, each from its own subdirectory, and both in ONE pip call: the
/// second depends on the first by name, and that name is not on PyPI.
const PACKAGES: [&str; 2] = ["ltx-core-mlx", "ltx-pipelines-mlx"];

/// The versions from the `uv.lock` of the pinned commit, which is what the
/// author runs. Left open, `mlx-arsenal` resolves to a release that asks for a
/// newer MLX than the engine was tested on.
/// `imageio-ffmpeg` brings the ffmpeg binary: the engine writes its mp4
/// through one and looks for it on the PATH only.
///
/// The first four are the ones the engine names. The rest is everything they
/// pull in, at the versions of the venv the real run generated with on the M5
/// Pro (09.10.2026): left open, `numpy` and `huggingface-hub` arrived at
/// whatever was newest on the day of the install, a different set on every
/// customer's Mac and none of them tested.
const PINNED: [&str; 37] = [
    "mlx==0.32.2", "mlx-lm==0.31.1", "mlx-arsenal==0.2.4", "imageio-ffmpeg==0.6.0",
    "annotated-doc==0.0.5", "anyio==4.15.1", "certifi==2026.7.22", "click==8.5.0",
    "filelock==4.0.12", "fsspec==2026.9.0", "h11==0.16.0", "hf-xet==1.7.0", "httpcore==1.0.9",
    "httpx==0.28.1", "huggingface-hub==1.33.0", "idna==3.20", "jinja2==3.1.6",
    "markdown-it-py==4.2.0", "markupsafe==3.0.4", "mdurl==0.1.2", "mlx-metal==0.32.2",
    "numpy==2.5.3", "packaging==26.3", "pillow==12.3.0", "protobuf==7.36.2", "pygments==2.21.0",
    "pyyaml==6.0.3", "regex==2026.9.29", "rich==15.0.0", "safetensors==0.8.0",
    "sentencepiece==0.2.2", "shellingham==1.5.4", "tokenizers==0.23.2", "tqdm==4.70.1",
    "transformers==5.19.0", "typer==0.27.3", "typing-extensions==4.16.0",
];

/// The module the engine imports as. Never `mlx_video`.
pub(super) const MODULE: &str = "ltx_pipelines_mlx";

/// What follows `python -m`: the module, its subcommand, and the one mode
/// every pack in the catalogue can run. `generate` has no default mode, and
/// the other modes need a dev transformer that the distilled packs leave out.
pub(super) const CLI: [&str; 3] = [MODULE, "generate", "--distilled"];

/// LTX was trained at 24 frames a second, and the engine refuses to start
/// without `--frame-rate`.
pub(super) const FRAME_RATE: u32 = 24;

// ── Talking Character (a2v) ───────────────────────────────────────────
//
// Read from the engine's source at the pinned commit (`cli.py` `_cmd_a2v`,
// `a2vid_two_stage.py`, `ti2vid_two_stages.py`), 15.10.2026:
//   - `a2v` takes the generation flags of `generate` (`--model`, `--gemma`,
//     `-W`, `-H`, `--frames`, `--frame-rate`, `--low-ram`, `--seed`), plus
//     `--audio` and `--image`. The speech is encoded by the pack's audio VAE
//     and held frozen in both stages; the clip's sound is the input audio
//     itself, cut to the length of the video.
//   - Stage one runs the DEV transformer with guidance at half size (30 steps
//     by default), stage two the distilled weights at full size. A pack that
//     carries `transformer-dev.safetensors` runs it; the distilled packs of the
//     catalogue leave that file out, so it is a download of its own.
//   - With `--low-ram` stage two swaps to the pre-fused
//     `transformer-distilled*.safetensors` the pack already has, and the
//     distilled LoRA (7.6 GB) is never read. Without the flag the LoRA is fused
//     in memory, which needs that file and the memory for both at once.
//   - The audio has to cover the frames: a shorter one ends the run with an
//     error after the model has loaded.

/// What follows `python -m` for a Talking Character run.
pub(super) const A2V_CLI: [&str; 2] = [MODULE, "a2v"];

/// The files an `a2v` run reads on top of what `--distilled` reads.
pub(super) const TALKING_FILES: &[&str] = &["transformer-dev.safetensors"];

/// The longest clip a voice is turned into: ten seconds at 24 frames, on the
/// `8k + 1` grid. A longer voice is cut there.
pub(super) const TALKING_MAX_FRAMES: u32 = 241;

/// The length of the speech the clip is not allowed to outrun: the engine's
/// audio frames are counted with rounding, and a clip that ends exactly at the
/// last sample can ask for one frame more than there is.
const AUDIO_MARGIN_S: f64 = 0.1;

/// The frames a voice of `audio_seconds` becomes, floored to the grid so the
/// audio always covers them, and capped at `TALKING_MAX_FRAMES`. `asked` is a
/// shorter length the caller wants, in seconds. `None` when the voice is too
/// short for the shortest clip.
pub(super) fn talking_frames(audio_seconds: f64, asked: Option<f64>) -> Option<u32> {
    let seconds = asked.filter(|s| *s > 0.0).map_or(audio_seconds, |s| s.min(audio_seconds)) - AUDIO_MARGIN_S;
    let frames = (seconds * FRAME_RATE as f64).floor();
    if !frames.is_finite() || frames < 9.0 {
        return None;
    }
    let f = (frames as u32).min(TALKING_MAX_FRAMES);
    Some(f - ((f - 1) % 8))
}

/// `Duration: 00:01:02.50` out of what ffmpeg says about a file.
pub(super) fn parse_duration(ffmpeg_says: &str) -> Option<f64> {
    let rest = &ffmpeg_says[ffmpeg_says.find("Duration:")? + "Duration:".len()..];
    let stamp = rest.trim_start().split(',').next()?.trim();
    let mut parts = stamp.split(':');
    let (h, m, s) = (parts.next()?.parse::<f64>().ok()?, parts.next()?.parse::<f64>().ok()?, parts.next()?.parse::<f64>().ok()?);
    let total = h * 3600.0 + m * 60.0 + s;
    (total.is_finite() && total > 0.0).then_some(total)
}

/// The length of an audio file in seconds, read with the ffmpeg the engine
/// writes its videos with. `None` when it cannot be read.
pub(super) fn audio_seconds(audio: &Path) -> Option<f64> {
    let out = crate::process_util::hidden_command(ffmpeg_dir(&venv_dir()).join("ffmpeg"))
        .arg("-hide_banner")
        .arg("-i")
        .arg(audio.as_os_str())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .output()
        .ok()?;
    // Without an output file ffmpeg ends with an error, after the header.
    parse_duration(&String::from_utf8_lossy(&out.stderr))
}

/// The peak of the VAE decode at the end of a talking run, in GB. The engine
/// gives the decode half of the memory unless told otherwise
/// (`LTX2_VAE_DECODE_BUDGET_GB`, `ltx_core_mlx/model/video_vae/video_vae.py`),
/// and that half was the peak of the whole run: 20 GB of a 48 GB Mac for a
/// clip of four seconds (real run, 15.10.2026). Below it the decode works in
/// smaller tiles, a little slower, with the same pixels.
pub(super) const TALKING_DECODE_BUDGET_GB: &str = "8";

/// What a talking run adds after the flags of `model_args`: the speech, and
/// the cap on the decode.
pub(super) fn talking_args(cmd: &mut Command, audio: &Path) {
    cmd.arg("--audio").arg(audio.as_os_str());
    cmd.env("LTX2_VAE_DECODE_BUDGET_GB", TALKING_DECODE_BUDGET_GB);
}

/// Whether the files of `TALKING_FILES` are in `dir`. The hub moves a file
/// into place when it is whole, so one that is there is complete.
pub(super) fn talking_files_present(dir: &Path) -> bool {
    TALKING_FILES.iter().all(|f| dir.join(f).is_file())
}

/// The files `--distilled` reads from an LTX-2.3 pack, with the transformer
/// first. The dev transformer and the distilled LoRAs (26 to 56 GB) are not
/// read and not fetched. A missing `spatial_upscaler_x2_v1_1` is a hard error
/// in the engine since its issue #40: without it stage two upscales through
/// an untrained module and the video comes out as a mosaic.
macro_rules! ltx23_pack {
    ($transformer:literal) => {
        &[
            $transformer,
            "connector.safetensors",
            "spatial_upscaler_x2_v1_1.safetensors",
            "spatial_upscaler_x2_v1_1_config.json",
            "vae_decoder.safetensors",
            "vae_encoder.safetensors",
            "audio_vae.safetensors",
            "vocoder.safetensors",
            "config.json",
            "embedded_config.json",
            "quantize_config.json",
            "split_model.json",
        ]
    };
}

/// A pack whose distilled transformer carries the 1.1 suffix. Where a
/// repository has both, the engine takes the versioned one.
pub(super) const PACK_23_V11: &[&str] = ltx23_pack!("transformer-distilled-1.1.safetensors");
pub(super) const PACK_23: &[&str] = ltx23_pack!("transformer-distilled.safetensors");

/// An LTX-2.5 pack brings its Gemma 4 text encoder and tokenizer along, has a
/// conv VAE under its own names, the 1.0 upscaler and a duration head.
pub(super) const PACK_25: &[&str] = &[
    "transformer-distilled.safetensors",
    "connector.safetensors",
    "text_encoder.safetensors",
    "text_encoder_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "chat_template.jinja",
    "duration_head.safetensors",
    "spatial_upscaler_x2_v1_0.safetensors",
    "spatial_upscaler_x2_v1_0_config.json",
    "vae_decoder_conv.safetensors",
    "vae_encoder_conv.safetensors",
    "audio_vae.safetensors",
    "vocoder.safetensors",
    "embedded_config.json",
    "quantize_config.json",
    "split_model.json",
];

// ── Where it lives ────────────────────────────────────────────────────

/// Beside the first engine's own venv, under the same app data folder.
pub(super) fn venv_dir() -> PathBuf {
    own_venv_dir().with_file_name("venv-ltx2")
}

/// The folder that goes to the front of the PATH for a generation. It holds
/// one link, `ffmpeg`, and nothing else, so it shadows no other program.
fn ffmpeg_dir(venv: &Path) -> PathBuf {
    venv.join("lu-bin")
}

/// Written when the install ran to its end. It records what was installed, so
/// a venv from an older pin does not pass for the current engine.
fn stamp_file(venv: &Path) -> PathBuf {
    venv.join(".lu-ltx2-engine")
}

/// The arguments after `pip install --upgrade`.
fn pip_specs() -> Vec<String> {
    PINNED
        .iter()
        .map(|p| p.to_string())
        .chain(PACKAGES.iter().map(|p| format!("{p} @ {SOURCE}/{COMMIT}.zip#subdirectory=packages/{p}")))
        .collect()
}

fn stamp() -> String {
    pip_specs().join("\n")
}

fn ready_at(venv: &Path) -> bool {
    venv_python(venv).exists()
        && ffmpeg_dir(venv).join("ffmpeg").exists()
        && std::fs::read_to_string(stamp_file(venv)).is_ok_and(|s| s == stamp())
}

/// Whether the engine is installed, at the pinned commit. Read from disk
/// alone: the catalogue asks this for every tile, every time it is drawn.
pub(super) fn engine_ready() -> bool {
    ready_at(&venv_dir())
}

/// The interpreter a generation runs in, once the engine is there.
pub(super) fn python() -> Option<String> {
    engine_ready().then(|| venv_python(&venv_dir()).to_string_lossy().to_string())
}

/// For the tests of `commands::video`: the engine reads as installed, or not.
#[cfg(test)]
pub(super) fn set_ready_for_test(ready: bool) {
    let venv = venv_dir();
    assert!(venv.starts_with(crate::os_paths::test_storage::root()), "the test would write into the real app data");
    let _ = std::fs::remove_dir_all(&venv);
    if ready {
        std::fs::create_dir_all(ffmpeg_dir(&venv)).unwrap();
        std::fs::create_dir_all(venv.join("bin")).unwrap();
        std::fs::write(venv_python(&venv), b"").unwrap();
        std::fs::write(ffmpeg_dir(&venv).join("ffmpeg"), b"").unwrap();
        std::fs::write(stamp_file(&venv), stamp()).unwrap();
    }
}

// ── Install ───────────────────────────────────────────────────────────

/// The engine's interpreter, with the engine installed first when it is not.
/// Called from a model install, so the engine arrives with the first model of
/// this family and never before.
pub(super) fn ensure_engine(slot: &InstallSlot, preferred_base: Option<String>) -> Result<String, String> {
    ensure_engine_at(slot, preferred_base, &venv_dir())
}

fn ensure_engine_at(slot: &InstallSlot, preferred_base: Option<String>, venv: &Path) -> Result<String, String> {
    let python = venv_python(venv).to_string_lossy().to_string();
    if ready_at(venv) {
        return Ok(python);
    }
    // A venv whose pip answers is one a stopped install left behind, and pip
    // continues in it. Anything less is built again from the start.
    // One built from a Python the pins have no wheels for is built again too
    // (GH #188).
    if !(venv_python(venv).exists() && python_has_module(&python, "pip") && venv_python_fits(&python, VIDEO_ENGINES_PYTHON)) {
        // A Python found on this Mac, otherwise the one the app fetches for itself.
        let base = base_python_or_own(slot, preferred_base, VIDEO_ENGINES_PYTHON)?;
        slot.log(format!("Python: {base}"));
        create_venv(slot, &base, venv)?;
    }
    let _ = std::fs::remove_file(stamp_file(venv));
    slot.log(format!("installing the LTX engine for quantized models, ltx-2-mlx {VERSION} (one-time)"));
    let mut pip = crate::python::python_command(&python);
    pip.args(["-m", "pip", "install", "--upgrade"]).args(pip_specs());
    run_streamed(slot, &mut pip).map_err(|e| format!("Could not install the LTX engine for quantized models. {e}"))?;
    if !python_has_module(&python, MODULE) {
        return Err(format!("pip install finished but `import {MODULE}` still fails"));
    }
    link_ffmpeg(&python, venv)?;
    std::fs::write(stamp_file(venv), stamp()).map_err(|e| crate::os_error::english(&e))?;
    Ok(python)
}

/// Put `ffmpeg` where the engine finds it. It asks `shutil.which("ffmpeg")`
/// and nothing else, and a Mac has no ffmpeg unless its owner installed one.
/// `ffprobe` is read by modes this app does not use.
fn link_ffmpeg(python: &str, venv: &Path) -> Result<(), String> {
    let out = crate::python::python_command(python)
        .args(["-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|e| crate::os_error::english(&e))?;
    let exe = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    if !out.status.success() || !exe.is_file() {
        return Err("The LTX engine is installed, but the ffmpeg it writes videos with was not found in it.".to_string());
    }
    let dir = ffmpeg_dir(venv);
    std::fs::create_dir_all(&dir).map_err(|e| crate::os_error::english(&e))?;
    let link = dir.join("ffmpeg");
    let _ = std::fs::remove_file(&link);
    #[cfg(unix)]
    std::os::unix::fs::symlink(&exe, &link).map_err(|e| crate::os_error::english(&e))?;
    #[cfg(not(unix))]
    std::fs::copy(&exe, &link).map(|_| ()).map_err(|e| crate::os_error::english(&e))?;
    Ok(())
}

/// The weight files of `files` that are not in `dir`. The hub skips a name
/// its repository does not have without a word, and the engine then finds out
/// minutes into a generation.
pub(super) fn verify_pack(dir: &Path, files: &[&str]) -> Result<(), String> {
    let missing: Vec<&str> = files
        .iter()
        .copied()
        .filter(|f| f.ends_with(".safetensors") && !dir.join(f).is_file())
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("The download finished, but the model is missing {}. Start it again.", missing.join(", ")))
    }
}

// ── Generate ──────────────────────────────────────────────────────────

/// The engine floors a frame count to `8k + 1` and says so in a warning. The
/// count is put on that grid here, so the length in the log is the length of
/// the video. Nine frames is the shortest clip with any motion in it.
pub(super) fn clamp_frames(frames: u32) -> u32 {
    let f = frames.max(9);
    f - ((f - 1) % 8)
}

/// The transformer file the engine will load from `dir`, by its own rule:
/// `transformer.safetensors`, else the last of the versioned distilled files,
/// else the unversioned one.
fn picked_transformer(dir: &Path) -> Option<PathBuf> {
    let plain = dir.join("transformer.safetensors");
    if plain.is_file() {
        return Some(plain);
    }
    let mut versioned: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("transformer-distilled-") && n.ends_with(".safetensors"))
        })
        .collect();
    versioned.sort();
    versioned.pop().or_else(|| Some(dir.join("transformer-distilled.safetensors")).filter(|p| p.is_file()))
}

/// Bytes of the transformer in `dir`, 0 when there is none to measure.
pub(super) fn transformer_bytes(dir: &Path) -> u64 {
    picked_transformer(dir).and_then(|p| p.metadata().ok()).map(|m| m.len()).unwrap_or(0)
}

/// A transformer is kept in memory whole when the Mac has this many times its
/// size. That gives the engine's own table: 8-bit (20.6 GB) from 32 GB, bf16
/// (38 GB) from 64 GB. A 16 GB Mac streams 4-bit (11.3 GB) too: the author
/// allows it whole there, and the one report from such a Mac streamed.
const RESIDENT_FACTOR: f64 = 1.6;

/// Whether to pass `--low-ram`, which streams the transformer's blocks from
/// disk: about a quarter of the memory for about five percent more time per
/// step. Below the threshold it is what makes the model fit at all. With
/// nothing measured it is on, which costs a little time and cannot freeze the
/// Mac.
pub(super) fn wants_low_ram(total_memory_bytes: u64, transformer_bytes: u64) -> bool {
    total_memory_bytes == 0 || transformer_bytes == 0 || (total_memory_bytes as f64) < transformer_bytes as f64 * RESIDENT_FACTOR
}

/// What comes after `--prompt <text>` on the command line, and the PATH with
/// ffmpeg on it. Seed and start image follow in `video_generate`, under the
/// same flags as the first engine (`--image` takes one or more values, so it
/// has to stay the last flag).
///
/// `gemma` is the text encoder folder of an LTX-2.3 pack, read through
/// `mlx_lm.load`. An LTX-2.5 pack carries its own and takes none.
pub(super) fn model_args(cmd: &mut Command, model: &Path, gemma: Option<&Path>, size: (u32, u32), frames: u32, out: &Path, low_ram: bool) {
    model_args_at(cmd, &venv_dir(), model, gemma, size, frames, out, low_ram)
}

#[allow(clippy::too_many_arguments)]
fn model_args_at(cmd: &mut Command, venv: &Path, model: &Path, gemma: Option<&Path>, size: (u32, u32), frames: u32, out: &Path, low_ram: bool) {
    cmd.arg("--model").arg(model.as_os_str());
    if let Some(gemma) = gemma {
        cmd.arg("--gemma").arg(gemma.as_os_str());
    }
    cmd.arg("--output")
        .arg(out.as_os_str())
        .arg("-W")
        .arg(size.0.to_string())
        .arg("-H")
        .arg(size.1.to_string())
        .arg("--frames")
        .arg(frames.to_string())
        .arg("--frame-rate")
        .arg(FRAME_RATE.to_string());
    if low_ram {
        cmd.arg("--low-ram");
    }
    let mut path = vec![ffmpeg_dir(venv)];
    path.extend(std::env::var_os("PATH").iter().flat_map(std::env::split_paths));
    if let Ok(joined) = std::env::join_paths(path) {
        cmd.env("PATH", joined);
    }
    // Model and encoder are folders on disk. Should one be incomplete, the
    // engine is to say so, and not start an eight gigabyte download of its
    // default in the middle of a generation.
    cmd.env("HF_HUB_OFFLINE", "1");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args_of(cmd: &Command) -> Vec<String> {
        cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect()
    }

    fn put(path: PathBuf, bytes: u64) {
        crate::test_support::sized_file(&path, bytes);
    }

    #[test]
    fn the_engine_is_installed_from_one_pinned_commit_in_two_packages() {
        assert_eq!(COMMIT.len(), 40, "a full commit id, not a branch or a short hash");
        assert!(COMMIT.chars().all(|c| c.is_ascii_hexdigit()));
        let specs = pip_specs();
        assert!(specs.iter().all(|s| !s.contains("git+")), "pip needs git for that, and a fresh Mac has none");
        let from_git: Vec<&String> = specs.iter().filter(|s| s.contains("github.com")).collect();
        assert_eq!(
            from_git,
            [
                "ltx-core-mlx @ https://github.com/dgrauet/ltx-2-mlx/archive/ade739e1adf19c29468ec081879a92426edc055d.zip#subdirectory=packages/ltx-core-mlx",
                "ltx-pipelines-mlx @ https://github.com/dgrauet/ltx-2-mlx/archive/ade739e1adf19c29468ec081879a92426edc055d.zip#subdirectory=packages/ltx-pipelines-mlx",
            ]
        );
        // Everything else is an exact version. An open `mlx-arsenal` is what
        // moves MLX to a release the engine was not tested on.
        for spec in specs.iter().filter(|s| !s.contains("github.com")) {
            assert!(spec.contains("=="), "{spec} is not pinned");
        }
        for name in ["mlx==", "mlx-lm==", "mlx-arsenal==", "imageio-ffmpeg=="] {
            assert!(specs.iter().any(|s| s.starts_with(name)), "{name} is not in the install");
        }
        // One spelling of the source. A second one would be the unpinned one.
        let src = include_str!("video_ltx2mlx.rs");
        let production = &src[..src.find("#[cfg(test)]").unwrap()];
        assert_eq!(production.matches("github.com/dgrauet/ltx-2-mlx").count(), 1);
        assert!(!production.contains("@main") && !production.contains("@master"));
    }

    #[test]
    fn it_has_a_venv_of_its_own_beside_the_first_engine() {
        let venv = venv_dir();
        assert!(venv.starts_with(crate::os_paths::data_dir()));
        assert_eq!(venv.parent(), own_venv_dir().parent(), "beside the video engine's venv");
        assert_ne!(venv, own_venv_dir());
        assert_ne!(venv, super::super::shared_venv_dir(), "MLX 0.32 in the shared venv turns the first engine's LTX black");
        // The install never reaches for another environment.
        let src = include_str!("video_ltx2mlx.rs");
        let production = &src[..src.find("#[cfg(test)]").unwrap()];
        assert!(!production.contains("shared_venv_dir") && !production.contains("engine_python"));
        assert!(!production.contains("\"mlx_video\""), "this engine never calls the first one");
    }

    #[test]
    fn frames_land_on_the_eight_k_plus_one_grid() {
        for (asked, given) in [(49, 49), (48, 41), (50, 49), (97, 97), (120, 113), (121, 121), (0, 9), (1, 9), (9, 9), (16, 9), (17, 17)] {
            assert_eq!(clamp_frames(asked), given, "{asked}");
            assert_eq!(clamp_frames(asked) % 8, 1);
        }
    }

    #[test]
    fn a_voice_becomes_frames_the_audio_covers() {
        // 4.31 s of speech: 4.21 s of it at 24 frames is 101, floored to 97.
        assert_eq!(talking_frames(4.31, None), Some(97));
        for secs in [0.6, 1.0, 2.0, 3.3, 4.31, 7.77, 9.9, 10.2] {
            let f = talking_frames(secs, None).unwrap();
            assert_eq!(f % 8, 1, "{secs}");
            assert!(f as f64 / FRAME_RATE as f64 <= secs - AUDIO_MARGIN_S, "{secs} s gives {f} frames, more than the voice covers");
        }
        // The grid point right at the end of the voice is not taken.
        assert_eq!(talking_frames(97.0 / 24.0, None), Some(89));
        // A long voice is cut at ten seconds.
        assert_eq!(talking_frames(60.0, None), Some(TALKING_MAX_FRAMES));
        assert_eq!(TALKING_MAX_FRAMES % 8, 1);
        // A shorter length asked for wins, a longer one does not.
        assert_eq!(talking_frames(8.0, Some(2.1)), Some(41));
        assert_eq!(talking_frames(2.0, Some(8.0)), talking_frames(2.0, None));
        assert_eq!(talking_frames(2.0, Some(0.0)), talking_frames(2.0, None));
        // Too short for the shortest clip, or nothing measured.
        assert_eq!(talking_frames(0.3, None), None);
        assert_eq!(talking_frames(f64::NAN, None), None);
    }

    #[test]
    fn the_length_of_a_voice_is_read_from_what_ffmpeg_says() {
        let says = "Input #0, wav, from 'speech.wav':\n  Duration: 00:00:04.31, bitrate: 768 kb/s\n  Stream #0:0: Audio: pcm_s16le";
        assert_eq!(parse_duration(says), Some(4.31));
        assert_eq!(parse_duration("  Duration: 01:02:03.50, start: 0.000000"), Some(3723.5));
        assert_eq!(parse_duration("  Duration: N/A, bitrate: N/A"), None);
        assert_eq!(parse_duration("  Duration: 00:00:00.00, bitrate: 0"), None);
        assert_eq!(parse_duration("speech.txt: Invalid data found when processing input"), None);
    }

    #[test]
    fn a_talking_run_is_the_engines_a2v_and_reads_the_dev_transformer() {
        assert_eq!(A2V_CLI, ["ltx_pipelines_mlx", "a2v"]);
        assert_eq!(TALKING_FILES, ["transformer-dev.safetensors"]);
        // Not in any pack the distilled mode downloads: it is a download of its own.
        for pack in [PACK_23, PACK_23_V11, PACK_25] {
            assert!(!TALKING_FILES.iter().any(|f| pack.contains(f)));
        }
        let mut cmd = Command::new("python");
        talking_args(&mut cmd, Path::new("/v/voices/a.wav"));
        assert_eq!(args_of(&cmd), ["--audio", "/v/voices/a.wav"]);
        assert!(cmd.get_envs().any(|(k, v)| k == "LTX2_VAE_DECODE_BUDGET_GB" && v == Some(std::ffi::OsStr::new(TALKING_DECODE_BUDGET_GB))));
        let root = tempfile::tempdir().unwrap();
        assert!(!talking_files_present(root.path()));
        put(root.path().join("transformer-dev.safetensors"), 1);
        assert!(talking_files_present(root.path()));
    }

    #[test]
    fn low_ram_follows_the_memory_and_the_size_of_the_transformer() {
        const GIB: u64 = 1_073_741_824;
        const GB: f64 = 1e9;
        let q4 = (11.3 * GB) as u64;
        let q8 = (20.6 * GB) as u64;
        let bf16 = (38.0 * GB) as u64;
        // The engine's own table: 4-bit whole on 24 GB, 8-bit from 32 GB,
        // bf16 from 64 GB. Below that the blocks are streamed.
        assert!(wants_low_ram(16 * GIB, q4));
        assert!(!wants_low_ram(24 * GIB, q4));
        assert!(wants_low_ram(16 * GIB, q8) && wants_low_ram(24 * GIB, q8));
        assert!(!wants_low_ram(32 * GIB, q8) && !wants_low_ram(48 * GIB, q8));
        assert!(wants_low_ram(32 * GIB, bf16) && wants_low_ram(48 * GIB, bf16));
        assert!(!wants_low_ram(64 * GIB, bf16));
        // Nothing measured: stream, which is slower and never freezes the Mac.
        assert!(wants_low_ram(0, q4) && wants_low_ram(128 * GIB, 0));
    }

    #[test]
    fn the_transformer_that_is_measured_is_the_one_the_engine_loads() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        assert_eq!(transformer_bytes(dir), 0, "an empty folder");
        put(dir.join("transformer-distilled.safetensors"), 11);
        put(dir.join("transformer-dev.safetensors"), 99);
        assert_eq!(transformer_bytes(dir), 11, "the dev transformer is not what --distilled loads");
        put(dir.join("transformer-distilled-1.1.safetensors"), 20);
        assert_eq!(transformer_bytes(dir), 20, "a versioned file wins over the plain name");
        put(dir.join("transformer.safetensors"), 5);
        assert_eq!(transformer_bytes(dir), 5);
    }

    #[test]
    fn the_command_line_is_the_one_the_engine_reads() {
        assert_eq!(CLI, ["ltx_pipelines_mlx", "generate", "--distilled"]);
        let venv = Path::new("/data/mlx-video/venv-ltx2");
        let mut cmd = Command::new("python");
        model_args_at(&mut cmd, venv, Path::new("/m/ltx-2.3-q8"), Some(Path::new("/m/_encoders/gemma")), (768, 512), 49, Path::new("/v/a.mp4"), true);
        assert_eq!(
            args_of(&cmd),
            ["--model", "/m/ltx-2.3-q8", "--gemma", "/m/_encoders/gemma", "--output", "/v/a.mp4", "-W", "768", "-H", "512", "--frames", "49", "--frame-rate", "24", "--low-ram"]
        );
        // ffmpeg is found through the PATH, and only there.
        let path = cmd.get_envs().find(|(k, _)| *k == "PATH").and_then(|(_, v)| v).expect("no PATH for the engine");
        assert_eq!(std::env::split_paths(path).next().unwrap(), venv.join("lu-bin"));
        assert!(cmd.get_envs().any(|(k, v)| k == "HF_HUB_OFFLINE" && v == Some(std::ffi::OsStr::new("1"))));

        // An LTX-2.5 pack brings its encoder, and a Mac with room keeps the
        // transformer in memory.
        let mut cmd = Command::new("python");
        model_args_at(&mut cmd, venv, Path::new("/m/ltx-2.5-q8"), None, (768, 512), 97, Path::new("/v/b.mp4"), false);
        let args = args_of(&cmd);
        assert!(!args.contains(&"--gemma".to_string()) && !args.contains(&"--low-ram".to_string()), "{args:?}");
        // The frame rate is not optional in the engine.
        assert!(args.windows(2).any(|w| w == ["--frame-rate", "24"]), "{args:?}");
    }

    #[test]
    fn a_pack_with_a_weight_file_missing_is_not_a_model() {
        let root = tempfile::tempdir().unwrap();
        for f in PACK_23_V11.iter().filter(|f| f.ends_with(".safetensors")) {
            put(root.path().join(f), 1);
        }
        // The json files are not asked for: a bf16 pack has no quantize_config.
        assert_eq!(verify_pack(root.path(), PACK_23_V11), Ok(()));
        std::fs::remove_file(root.path().join("spatial_upscaler_x2_v1_1.safetensors")).unwrap();
        let err = verify_pack(root.path(), PACK_23_V11).unwrap_err();
        assert_eq!(err, "The download finished, but the model is missing spatial_upscaler_x2_v1_1.safetensors. Start it again.");
    }

    #[test]
    fn every_pack_names_what_the_distilled_mode_loads() {
        for pack in [PACK_23, PACK_23_V11, PACK_25] {
            assert!(pack[0].starts_with("transformer-distilled") && pack[0].ends_with(".safetensors"));
            assert!(!pack.iter().any(|f| f.contains("dev") || f.contains("lora")), "fifty gigabytes nobody reads");
            for f in ["connector.safetensors", "audio_vae.safetensors", "vocoder.safetensors", "embedded_config.json"] {
                assert!(pack.contains(&f), "{f}");
            }
        }
        for pack in [PACK_23, PACK_23_V11] {
            // Issue #40 of the engine: without it the video is a mosaic.
            assert!(pack.contains(&"spatial_upscaler_x2_v1_1.safetensors"));
            assert!(pack.contains(&"vae_decoder.safetensors") && pack.contains(&"vae_encoder.safetensors"));
            assert!(!pack.iter().any(|f| f.starts_with("text_encoder")), "LTX-2.3 reads Gemma from --gemma");
        }
        assert!(PACK_25.contains(&"spatial_upscaler_x2_v1_0.safetensors"));
        assert!(PACK_25.contains(&"vae_decoder_conv.safetensors") && PACK_25.contains(&"vae_encoder_conv.safetensors"));
        for f in ["text_encoder.safetensors", "text_encoder_config.json", "tokenizer.json", "tokenizer_config.json"] {
            assert!(PACK_25.contains(&f), "{f}: the engine takes a pack for LTX-2.5 by these");
        }
    }

    #[test]
    fn a_venv_without_the_stamp_of_this_pin_is_not_the_engine() {
        let root = tempfile::tempdir().unwrap();
        let venv = root.path().join("venv-ltx2");
        assert!(!ready_at(&venv));
        put(venv_python(&venv), 1);
        put(ffmpeg_dir(&venv).join("ffmpeg"), 1);
        assert!(!ready_at(&venv), "an install that was stopped has no stamp");
        std::fs::write(stamp_file(&venv), "ltx-core-mlx @ git+https://example.invalid@0000").unwrap();
        assert!(!ready_at(&venv), "the stamp of another pin");
        std::fs::write(stamp_file(&venv), stamp()).unwrap();
        assert!(ready_at(&venv));
        std::fs::remove_file(ffmpeg_dir(&venv).join("ffmpeg")).unwrap();
        assert!(!ready_at(&venv), "without ffmpeg every video fails at the last step");
    }

    /// The whole install against a stand-in interpreter: a shell script that
    /// builds a "venv" whose `python` answers the four questions the install
    /// asks and writes down what pip was called with.
    #[cfg(unix)]
    #[test]
    fn the_install_builds_the_venv_runs_one_pip_call_and_links_ffmpeg() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let ffmpeg = root.path().join("site-packages").join("ffmpeg-macos-aarch64-v7.1");
        put(ffmpeg.clone(), 3);
        let pip_log = root.path().join("pip-args.txt");
        let venv_py = format!(
            "#!/bin/sh\ncase \"$1 $2\" in\n  '-c import pip') exit 0 ;;\n  '-c import {MODULE}') [ -f '{log}' ] ; exit $? ;;\n  '-c import imageio_ffmpeg'*) echo '{ffmpeg}' ;;\n  '-m pip') shift 2 ; printf '%s\\n' \"$@\" > '{log}' ;;\n  *) exit 4 ;;\nesac\n",
            log = pip_log.display(),
            ffmpeg = ffmpeg.display(),
        );
        let base = root.path().join("python3.12");
        std::fs::write(
            &base,
            format!(
                "#!/bin/sh\nif [ \"$1\" = -c ]; then echo '3 12'; exit 0; fi\n[ \"$1\" = -m ] && [ \"$2\" = venv ] || exit 3\nmkdir -p \"$4/bin\"\ncat > \"$4/bin/python\" <<'LU_EOF'\n{venv_py}LU_EOF\nchmod +x \"$4/bin/python\"\n"
            ),
        )
        .unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o755)).unwrap();

        let slot = InstallSlot::default();
        let venv = root.path().join("mlx-video").join("venv-ltx2");
        let python = ensure_engine_at(&slot, Some(base.to_string_lossy().to_string()), &venv).unwrap();
        assert_eq!(PathBuf::from(&python), venv_python(&venv));

        let mut expected = vec!["install".to_string(), "--upgrade".to_string()];
        expected.extend(pip_specs());
        let called: Vec<String> = std::fs::read_to_string(&pip_log).unwrap().lines().map(String::from).collect();
        assert_eq!(called, expected, "one pip call with both packages and every pin");
        assert_eq!(std::fs::read_link(ffmpeg_dir(&venv).join("ffmpeg")).unwrap(), ffmpeg);
        assert!(ready_at(&venv));

        // A second model of the family finds the engine and installs nothing.
        std::fs::remove_file(&pip_log).unwrap();
        ensure_engine_at(&slot, None, &venv).unwrap();
        assert!(!pip_log.exists(), "pip ran again for an engine that is there");
    }
}
