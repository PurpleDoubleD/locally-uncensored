//! Colour settle for a long video made of several sections (3.0.9).
//!
//! A long clip is rendered as sections that each continue from the last
//! frames of the one before. Every section comes out more saturated and
//! sharper than the one it continues, and over a few sections that adds up.
//! `video_color_settle` takes the finished, already concatenated clip and
//! matches every frame from the newest seam on to the clip's first section,
//! the anchor (the rule is in video_settle.py, which runs on ComfyUI's own
//! Python with numpy and PyAV, both in ComfyUI's requirements).
//!
//! The frontend only knows ComfyUI's own file names (filename, subfolder,
//! type), the same triple the gallery shows. The file is resolved here inside
//! the output or input folder of the ComfyUI LU manages, by the same rules as
//! the gallery delete (gallery_files.rs) plus a canonical check against
//! symlinks pointing out of the folder. The result lands beside the source as
//! `<stem>_settled.mp4` (`_settled_2`, `_3`, ... when taken), so the original
//! stays untouched.
//!
//! Without a local ComfyUI that LU manages (a remote host, a Mac, none found)
//! the answer starts with [`NOT_AVAILABLE`], which the frontend skips quietly.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::state::AppState;

/// The script, embedded so it cannot be missing or swapped on disk between
/// releases. Written to a private temp folder for each run.
const SCRIPT: &str = include_str!("video_settle.py");

/// Every refusal that means "this machine cannot do it" starts with this, so
/// the frontend can skip the step without showing an error.
pub const NOT_AVAILABLE: &str = "not available";

/// Default frames on each side that a frame's statistics are smoothed over.
pub(crate) const DEFAULT_WINDOW: u32 = 8;
/// Upper bound, the same as the script's own.
pub(crate) const MAX_WINDOW: u32 = 60;
/// A 30 second 832x480 clip takes well under a minute; ten minutes covers a
/// slow disk and a long clip and still ends a hung decoder.
const RUN_TIMEOUT: Duration = Duration::from_secs(600);
/// Video containers a section render can come out as.
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "webm", "mov", "mkv"];

/// One corrected section as the script measured it. Means and deviations are
/// per plane of the video's YUV (`space`), on the 0..255 scale; `ref*` is the
/// anchor, `cur*` the section as it came out.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettleSeam {
    /// First frame of the section this seam starts.
    pub frame: u32,
    pub ref_mean: [f64; 3],
    pub cur_mean: [f64; 3],
    pub ref_std: [f64; 3],
    pub cur_std: [f64; 3],
    /// The mean contrast factor applied per plane, already clamped.
    pub gain: [f64; 3],
    pub ref_frames: u32,
    pub cur_frames: u32,
    #[serde(default)]
    pub space: Option<String>,
    /// Sharpness (mean absolute Laplacian of Y) of the anchor and the section.
    #[serde(default)]
    pub ref_sharp: Option<f64>,
    #[serde(default)]
    pub cur_sharp: Option<f64>,
    /// How far frames were blended towards a blurred copy, mean and most.
    #[serde(default)]
    pub soften: Option<f64>,
    #[serde(default)]
    pub soften_max: Option<f64>,
}

/// What the script prints as its last line.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScriptReport {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    frames: u32,
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
    #[serde(default)]
    fps: f64,
    #[serde(default)]
    seams: Vec<SettleSeam>,
    #[serde(default)]
    ignored_boundaries: Vec<i64>,
    #[serde(default)]
    audio: bool,
    #[serde(default)]
    note: Option<String>,
}

/// What the command returns.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettleReport {
    /// The new file's name, in the same folder and subfolder as the source.
    pub filename: String,
    pub subfolder: String,
    /// "output" or "input", as passed in.
    pub folder_type: String,
    pub frames: u32,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub window: u32,
    pub seams: Vec<SettleSeam>,
    /// Boundaries that fell outside the clip and were skipped.
    pub ignored_boundaries: Vec<i64>,
    /// The source's audio track was copied over unchanged.
    pub audio: bool,
    pub note: Option<String>,
}

/// The ComfyUI folder a file triple names: `output` or `input`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ComfyFolder {
    Output,
    Input,
}

impl ComfyFolder {
    pub(crate) fn parse(s: &str) -> Result<Self, String> {
        match s {
            "output" => Ok(Self::Output),
            "input" => Ok(Self::Input),
            other => Err(format!("Unknown ComfyUI folder type {other:?}, expected \"output\" or \"input\".")),
        }
    }
}

/// The video a (filename, subfolder) pair names inside `base`, proven to be
/// an existing file that stays inside `base` after every symlink is resolved.
pub(crate) fn resolve_source(base: &Path, filename: &str, subfolder: &str) -> Result<PathBuf, String> {
    use crate::commands::download::{safe_subfolder, sanitize_filename};
    if filename.is_empty() || sanitize_filename(filename) != filename || filename.starts_with('.') {
        return Err("That file name is not a plain file name.".to_string());
    }
    if !subfolder.is_empty() {
        safe_subfolder(subfolder)?;
    }
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !VIDEO_EXTENSIONS.contains(&ext.as_str()) {
        return Err("Only a video file (mp4, webm, mov, mkv) can be settled.".to_string());
    }
    let dir = if subfolder.is_empty() { base.to_path_buf() } else { base.join(subfolder.replace('\\', "/")) };
    let candidate = dir.join(filename);
    let real_base = base
        .canonicalize()
        .map_err(|_| format!("The ComfyUI folder {} does not exist.", base.display()))?;
    let real = candidate
        .canonicalize()
        .map_err(|_| format!("The video {filename} is not in the ComfyUI folder."))?;
    if !real.starts_with(&real_base) {
        return Err("That file lies outside the ComfyUI folder.".to_string());
    }
    if !real.is_file() {
        return Err(format!("The video {filename} is not a file."));
    }
    Ok(real)
}

/// `<stem>_settled.mp4` in `dir`, or the first `<stem>_settled_<n>.mp4` that
/// is free. Never a name that exists.
pub(crate) fn settled_name(dir: &Path, source_name: &str) -> String {
    let stem = Path::new(source_name).file_stem().and_then(|s| s.to_str()).unwrap_or("video");
    let first = format!("{stem}_settled.mp4");
    if !dir.join(&first).exists() {
        return first;
    }
    (2u32..)
        .map(|n| format!("{stem}_settled_{n}.mp4"))
        .find(|name| !dir.join(name).exists())
        .expect("an unbounded counter always finds a free name")
}

/// Sorted, without duplicates and without frame 0 (the first section has
/// nothing before it to match).
pub(crate) fn normalize_boundaries(mut boundaries: Vec<u32>) -> Vec<u32> {
    boundaries.retain(|b| *b > 0);
    boundaries.sort_unstable();
    boundaries.dedup();
    boundaries
}

/// The window the script runs with: the default when none is given, an
/// error outside 1..=MAX_WINDOW.
pub(crate) fn effective_window(window: Option<u32>) -> Result<u32, String> {
    match window.unwrap_or(DEFAULT_WINDOW) {
        w @ 1..=MAX_WINDOW => Ok(w),
        w => Err(format!("window {w} is outside 1..={MAX_WINDOW}")),
    }
}

/// The interpreter's argument list: isolated mode, the script, then every
/// path as its own argument. No shell ever sees these.
pub(crate) fn script_args(script: &Path, input: &Path, output: &Path, boundaries: &[u32], window: u32, anchor_end: Option<u32>) -> Vec<OsString> {
    let list = boundaries.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let mut args: Vec<OsString> = vec![
        "-I".into(),
        script.as_os_str().to_owned(),
        "--input".into(),
        input.as_os_str().to_owned(),
        "--output".into(),
        output.as_os_str().to_owned(),
        "--boundaries".into(),
        list.into(),
        "--window".into(),
        window.to_string().into(),
    ];
    if let Some(end) = anchor_end.filter(|e| *e > 0) {
        args.push("--anchor-end".into());
        args.push(end.to_string().into());
    }
    args
}

/// The report out of the script's stdout: the last line that is JSON. Lines
/// before it (a library warning) are ignored.
fn parse_script_output(stdout: &str) -> Result<ScriptReport, String> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .filter(|l| l.starts_with('{'))
        .find_map(|l| serde_json::from_str::<ScriptReport>(l).ok())
        .ok_or_else(|| "The colour settle printed no report.".to_string())
}

/// The ComfyUI folder this machine manages, or the NOT_AVAILABLE refusal.
fn managed_comfy_dir(state: &AppState) -> Result<PathBuf, String> {
    if !crate::commands::process::comfy_supported_here() {
        return Err(format!("{NOT_AVAILABLE}: no local ComfyUI on this platform"));
    }
    let host = state.comfy_host.lock().map(|h| h.clone()).unwrap_or_default();
    if !crate::commands::process::is_local_host(&host) {
        return Err(format!("{NOT_AVAILABLE}: ComfyUI runs on another machine ({host})"));
    }
    let path = {
        let mut slot = state.comfy_path.lock().map_err(|e| e.to_string())?;
        if slot.is_none() {
            *slot = crate::commands::process::find_comfyui_path();
        }
        slot.clone()
    };
    let dir = path.map(PathBuf::from).filter(|p| p.is_dir());
    dir.ok_or_else(|| format!("{NOT_AVAILABLE}: no local ComfyUI found"))
}

/// Run `python args...` with a deadline, collecting stdout and stderr.
fn run_with_timeout(python: &str, args: &[OsString], timeout: Duration) -> Result<(bool, String, String), String> {
    let mut cmd = crate::python::python_command(python);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start ComfyUI's Python ({python}): {}", crate::os_error::english(&e)))?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_string(&mut text);
            }
            text
        })
    };
    let out = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if started.elapsed() >= timeout => {
                crate::commands::shell::kill_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("The colour settle took longer than {} minutes and was stopped.", timeout.as_secs() / 60));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(e) => return Err(format!("Waiting for the colour settle failed: {}", crate::os_error::english(&e))),
        }
    };
    Ok((status.success(), out.join().unwrap_or_default(), err.join().unwrap_or_default()))
}

fn settle_blocking(
    state: &AppState,
    filename: &str,
    subfolder: &str,
    folder_type: &str,
    boundaries: Vec<u32>,
    window: Option<u32>,
    anchor_end: Option<u32>,
) -> Result<SettleReport, String> {
    let folder = ComfyFolder::parse(folder_type)?;
    let window = effective_window(window)?;
    let boundaries = normalize_boundaries(boundaries);
    let comfy_dir = managed_comfy_dir(state)?;
    let paths = crate::commands::comfy_user_paths::UserComfyPaths::discover(&comfy_dir);
    let base = match folder {
        ComfyFolder::Output => paths.output_dir_or(&comfy_dir),
        ComfyFolder::Input => paths.input_dir_or(&comfy_dir),
    };
    let input = resolve_source(&base, filename, subfolder)?;
    let python = crate::commands::process::comfy_tool_python(state, &comfy_dir)
        .map_err(|e| format!("{NOT_AVAILABLE}: {e}"))?;

    let out_dir = input.parent().ok_or("The video has no folder.")?.to_path_buf();
    // Written under a hidden name first and renamed at the end, so a failed or
    // stopped run never leaves a half file under the name the gallery shows.
    let partial = out_dir.join(format!(".lu-settle-{}-{}.mp4", std::process::id(), uuid::Uuid::new_v4().simple()));
    let (_script_dir, script) = crate::private_tmp::write_private_temp("lu-settle-", "video_settle.py", SCRIPT.as_bytes())?;
    let args = script_args(&script, &input, &partial, &boundaries, window, anchor_end);

    let run = run_with_timeout(&python, &args, RUN_TIMEOUT);
    let finish = || {
        let _ = std::fs::remove_file(&partial);
    };
    let (success, stdout, stderr) = run.inspect_err(|_| finish())?;
    let report = match parse_script_output(&stdout) {
        Ok(r) => r,
        Err(e) => {
            finish();
            let tail: String = stderr.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            return Err(if tail.is_empty() { e } else { format!("{e}\n{tail}") });
        }
    };
    if !success || !report.ok {
        finish();
        return Err(report.error.unwrap_or_else(|| "The colour settle failed.".to_string()));
    }
    let name = settled_name(&out_dir, filename);
    if let Err(e) = std::fs::rename(&partial, out_dir.join(&name)) {
        finish();
        return Err(format!("Could not save {name}: {}", crate::os_error::english(&e)));
    }
    tracing::info!(target: "video", frames = report.frames, seams = report.seams.len(), "video colour settle done");
    Ok(SettleReport {
        filename: name,
        subfolder: subfolder.to_string(),
        folder_type: folder_type.to_string(),
        frames: report.frames,
        width: report.width,
        height: report.height,
        fps: report.fps,
        window,
        seams: report.seams,
        ignored_boundaries: report.ignored_boundaries,
        audio: report.audio,
        note: report.note,
    })
}

/// Settle the colour across the seams of a long video in ComfyUI's output
/// (or input) folder. `boundaries` are the frame indices where a new section
/// starts; frames from the first of them on are matched to the anchor, frames
/// `0..anchor_end` (default: all before the first boundary). `window` is the
/// frames per side the statistics are smoothed over (default 8).
// ASYNC + spawn_blocking, like start_comfyui: the run takes seconds to
// minutes and must not sit on the main thread.
#[tauri::command]
pub async fn video_color_settle(
    app: tauri::AppHandle,
    filename: String,
    subfolder: String,
    folder_type: String,
    boundaries: Vec<u32>,
    window: Option<u32>,
    anchor_end: Option<u32>,
) -> Result<SettleReport, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        settle_blocking(&state, &filename, &subfolder, &folder_type, boundaries, window, anchor_end)
    })
    .await
    .map_err(|e| format!("video_color_settle task: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder_with(files: &[&str]) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        for f in files {
            let p = tmp.path().join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"x").unwrap();
        }
        tmp
    }

    #[test]
    fn a_gallery_triple_resolves_inside_the_folder() {
        let tmp = folder_with(&["long_00001.mp4", "video/long_00002.mp4"]);
        let base = tmp.path();
        let real = base.canonicalize().unwrap();
        assert_eq!(resolve_source(base, "long_00001.mp4", "").unwrap(), real.join("long_00001.mp4"));
        assert_eq!(resolve_source(base, "long_00002.mp4", "video").unwrap(), real.join("video").join("long_00002.mp4"));
    }

    #[test]
    fn nothing_leaves_the_folder() {
        let tmp = folder_with(&["out/a.mp4", "secret.mp4"]);
        let base = tmp.path().join("out");
        for (name, sub) in [
            ("../secret.mp4", ""),
            ("secret.mp4", ".."),
            ("secret.mp4", "x/../.."),
            ("a.mp4", "/etc"),
            ("a.mp4", "C:/Windows"),
            ("/etc/passwd", ""),
            ("..\\secret.mp4", ""),
        ] {
            assert!(resolve_source(&base, name, sub).is_err(), "{name:?} in {sub:?} was accepted");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_folder_is_refused() {
        let tmp = folder_with(&["out/keep.mp4", "elsewhere/clip.mp4"]);
        let base = tmp.path().join("out");
        std::os::unix::fs::symlink(tmp.path().join("elsewhere"), base.join("link")).unwrap();
        std::os::unix::fs::symlink(tmp.path().join("elsewhere/clip.mp4"), base.join("clip.mp4")).unwrap();
        assert!(resolve_source(&base, "clip.mp4", "link").is_err());
        assert!(resolve_source(&base, "clip.mp4", "").is_err());
    }

    #[test]
    fn only_existing_videos_are_taken() {
        let tmp = folder_with(&["a.png", "dir.mp4/inner.mp4"]);
        assert!(resolve_source(tmp.path(), "a.png", "").is_err(), "an image was accepted");
        assert!(resolve_source(tmp.path(), "missing.mp4", "").is_err(), "a missing file was accepted");
        assert!(resolve_source(tmp.path(), "dir.mp4", "").is_err(), "a folder was accepted");
        assert!(resolve_source(tmp.path(), "", "").is_err());
        assert!(resolve_source(tmp.path(), ".hidden.mp4", "").is_err());
    }

    #[test]
    fn the_new_name_never_overwrites() {
        let tmp = folder_with(&["clip.mp4"]);
        assert_eq!(settled_name(tmp.path(), "clip.mp4"), "clip_settled.mp4");
        std::fs::write(tmp.path().join("clip_settled.mp4"), b"x").unwrap();
        assert_eq!(settled_name(tmp.path(), "clip.mp4"), "clip_settled_2.mp4");
        std::fs::write(tmp.path().join("clip_settled_2.mp4"), b"x").unwrap();
        assert_eq!(settled_name(tmp.path(), "clip.mp4"), "clip_settled_3.mp4");
        // Always .mp4, whatever the source container was.
        assert_eq!(settled_name(tmp.path(), "take.webm"), "take_settled.mp4");
    }

    #[test]
    fn folder_type_window_and_boundaries() {
        assert_eq!(ComfyFolder::parse("output").unwrap(), ComfyFolder::Output);
        assert_eq!(ComfyFolder::parse("input").unwrap(), ComfyFolder::Input);
        assert!(ComfyFolder::parse("temp").is_err());
        assert!(ComfyFolder::parse("../output").is_err());
        assert_eq!(effective_window(None).unwrap(), 8);
        assert_eq!(effective_window(Some(12)).unwrap(), 12);
        assert!(effective_window(Some(0)).is_err());
        assert!(effective_window(Some(MAX_WINDOW + 1)).is_err());
        assert_eq!(normalize_boundaries(vec![157, 0, 81, 157]), vec![81, 157]);
    }

    #[test]
    fn every_path_is_its_own_argument_and_python_runs_isolated() {
        let args = script_args(
            Path::new("/tmp/lu-settle-x/video_settle.py"),
            Path::new("/c/out/my clip; rm -rf ~.mp4"),
            Path::new("/c/out/.lu-settle-1.mp4"),
            &[81, 157],
            5,
            None,
        );
        let text: Vec<String> = args.iter().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(
            text,
            [
                "-I",
                "/tmp/lu-settle-x/video_settle.py",
                "--input",
                "/c/out/my clip; rm -rf ~.mp4",
                "--output",
                "/c/out/.lu-settle-1.mp4",
                "--boundaries",
                "81,157",
                "--window",
                "5",
            ]
        );
    }

    #[test]
    fn the_anchor_goes_to_the_script_only_when_given() {
        let args = |anchor| {
            script_args(Path::new("/s.py"), Path::new("/i.mp4"), Path::new("/o.mp4"), &[157], 8, anchor)
                .iter()
                .map(|a| a.to_string_lossy().to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(args(Some(81))[9..], ["8", "--anchor-end", "81"]);
        assert_eq!(args(None).len(), 10);
        assert_eq!(args(Some(0)).len(), 10);
    }

    #[test]
    fn a_report_with_the_anchor_numbers_reads() {
        let out = "{\"ok\": true, \"frames\": 233, \"seams\": [{\"frame\": 157, \"space\": \"yuv\", \"refMean\": [1,2,3], \
                   \"curMean\": [1,2,3], \"refStd\": [1,1,1], \"curStd\": [1,1,1], \"gain\": [1,0.8,0.8], \"refFrames\": 81, \
                   \"curFrames\": 76, \"refSharp\": 6.9, \"curSharp\": 10.0, \"soften\": 0.4, \"softenMax\": 0.5}]}";
        let r = parse_script_output(out).unwrap();
        assert_eq!(r.seams[0].space.as_deref(), Some("yuv"));
        assert_eq!(r.seams[0].soften_max, Some(0.5));
        assert_eq!(r.seams[0].ref_frames, 81);
    }

    #[test]
    fn the_report_is_the_last_json_line() {
        let out = "some warning\n{\"ok\": true, \"frames\": 240, \"width\": 832, \"height\": 480, \"fps\": 16.0, \"window\": 5, \
                   \"seams\": [{\"refMean\": [1,2,3], \"curMean\": [1,2,3], \"refStd\": [1,1,1], \"curStd\": [1,1,1], \
                   \"gain\": [1,1,1], \"refFrames\": 5, \"curFrames\": 5, \"frame\": 80}], \"ignoredBoundaries\": [9999], \
                   \"audio\": true, \"note\": null}\n";
        let r = parse_script_output(out).unwrap();
        assert!(r.ok);
        assert_eq!(r.frames, 240);
        assert_eq!(r.seams[0].frame, 80);
        assert_eq!(r.ignored_boundaries, vec![9999]);
        let err = parse_script_output("{\"ok\": false, \"error\": \"Cannot open the video\"}").unwrap();
        assert_eq!(err.error.as_deref(), Some("Cannot open the video"));
        assert!(parse_script_output("Traceback ...").is_err());
    }

    #[test]
    fn the_script_imports_nothing_but_numpy_av_and_the_standard_library() {
        let allowed = ["argparse", "json", "sys", "collections", "fractions", "av", "numpy"];
        for line in SCRIPT.lines().map(str::trim) {
            let module = if let Some(rest) = line.strip_prefix("import ") {
                rest.split([' ', ',', '.']).next()
            } else if let Some(rest) = line.strip_prefix("from ") {
                rest.split([' ', '.']).next()
            } else {
                None
            };
            if let Some(m) = module {
                assert!(allowed.contains(&m), "video_settle.py imports {m}");
            }
        }
    }

    /// P5: PyAV's yuv420p -> rgb24 -> yuv420p round trip lost about 1.2
    /// levels of brightness per pass, and a long clip passes through here
    /// once per section. The script works on the YUV planes only.
    #[test]
    fn the_script_never_takes_a_detour_through_rgb() {
        assert!(!SCRIPT.contains("rgb24"), "video_settle.py converts to RGB");
        assert!(SCRIPT.contains("format=\"yuv420p\""));
    }

    #[test]
    fn the_command_is_registered_for_the_desktop_only() {
        const LIB: &str = include_str!("../lib.rs");
        let at = LIB.find("commands::video_settle::video_color_settle").expect("video_color_settle is not in generate_handler!");
        let before = LIB[..at].trim_end();
        assert!(before.ends_with("#[cfg(desktop)]"), "video_color_settle runs a Python process and must not reach a phone");
    }
}
