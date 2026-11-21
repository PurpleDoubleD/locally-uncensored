//! The first frame of a clip as a small JPEG, for the gallery a paired phone
//! sees (remote_create.rs, `gallery/{id}/thumb`).
//!
//! LU brings no ffmpeg of its own. It looks for one in this order:
//!
//! 1. an `ffmpeg` on the PATH (the PATH of a terminal, finder_path.rs),
//! 2. the ffmpeg that `imageio-ffmpeg` brings into the Mac's engine venvs
//!    (`mlx/venv`, `mlx-video/venv`, `mlx-video/venv-ltx2`),
//! 3. the same one in ComfyUI's Python (the portable `python_embeded`, a
//!    `venv` or `.venv` next to ComfyUI); the Video Helper Suite needs it, so
//!    a ComfyUI that makes MP4 usually has it.
//!
//! Without an ffmpeg a Mac asks Quick Look (`qlmanage`, which reads the clip
//! through AVFoundation). Without either there is no preview, and the phone
//! shows its video icon.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A frame takes at most this long.
const FRAME_TIMEOUT: Duration = Duration::from_secs(15);
/// Largest JPEG read back.
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

/// The ffmpeg binaries inside `site-packages/imageio_ffmpeg/binaries` of a
/// venv or Python root, whatever the Python version.
fn imageio_ffmpeg_in(root: &Path) -> Vec<PathBuf> {
    let mut packages = vec![root.join("Lib").join("site-packages")];
    if let Ok(entries) = std::fs::read_dir(root.join("lib")) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with("python") {
                packages.push(e.path().join("site-packages"));
            }
        }
    }
    let mut out = Vec::new();
    for p in packages {
        let Ok(entries) = std::fs::read_dir(p.join("imageio_ffmpeg").join("binaries")) else { continue };
        let mut found: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|f| f.file_name().is_some_and(|n| n.to_string_lossy().starts_with("ffmpeg")) && f.is_file())
            .collect();
        found.sort();
        out.extend(found);
    }
    out
}

/// Every place an ffmpeg may be, in the order they are tried.
pub(crate) fn ffmpeg_candidates(path_env: Option<&std::ffi::OsStr>, data_dir: &Path, comfy_base: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(path) = path_env {
        for dir in std::env::split_paths(path) {
            let f = dir.join(exe("ffmpeg"));
            if f.is_file() {
                out.push(f);
            }
        }
    }
    for venv in [data_dir.join("mlx").join("venv"), data_dir.join("mlx-video").join("venv"), data_dir.join("mlx-video").join("venv-ltx2")] {
        out.extend(imageio_ffmpeg_in(&venv));
    }
    if let Some(base) = comfy_base {
        let mut roots = vec![base.join("venv"), base.join(".venv")];
        if let Some(parent) = base.parent() {
            roots.push(parent.join("python_embeded"));
        }
        roots.push(base.join("python_embeded"));
        for r in roots {
            out.extend(imageio_ffmpeg_in(&r));
        }
    }
    out
}

/// Runs `cmd` and gives its stdout, or nothing after the timeout.
fn run_with_timeout(mut cmd: Command) -> Option<Vec<u8>> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::process_util::no_window());
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stdout).take(MAX_FRAME_BYTES as u64 + 1).read_to_end(&mut buf);
        buf
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = reader.join().ok()?;
                return (status.success() && !out.is_empty() && out.len() <= MAX_FRAME_BYTES).then_some(out);
            }
            Ok(None) if started.elapsed() < FRAME_TIMEOUT => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// The demuxer for a clip, fixed by its file ending: ffmpeg does not guess
/// from the content (a crafted file cannot pick a playlist or image demuxer).
pub(crate) fn input_format(video: &Path) -> Option<&'static str> {
    match video.extension()?.to_string_lossy().to_ascii_lowercase().as_str() {
        "mp4" | "m4v" | "mov" => Some("mov"),
        "webm" | "mkv" => Some("matroska"),
        _ => None,
    }
}

/// The ffmpeg arguments for one frame, at most `side` a side, as JPEG on
/// stdout. Only local files are read (`-protocol_whitelist file`, `file:`),
/// with the demuxer of the ending. `None` for an ending ffmpeg may not read.
pub(crate) fn ffmpeg_args(video: &Path, side: u32) -> Option<Vec<std::ffi::OsString>> {
    let format = input_format(video)?;
    let scale = format!("scale={side}:{side}:force_original_aspect_ratio=decrease");
    let mut input = std::ffi::OsString::from("file:");
    input.push(video.as_os_str());
    Some(["-v", "error", "-nostdin", "-protocol_whitelist", "file", "-f", format, "-i"]
        .iter()
        .map(std::ffi::OsString::from)
        .chain([input])
        .chain(["-frames:v", "1", "-vf", &scale, "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "5", "-"].iter().map(std::ffi::OsString::from))
        .collect())
}

fn with_ffmpeg(ffmpeg: &Path, video: &Path, side: u32) -> Option<Vec<u8>> {
    let args = ffmpeg_args(video, side)?;
    let mut cmd = crate::process_util::foreign_system_command(ffmpeg);
    cmd.args(args);
    let jpeg = run_with_timeout(cmd)?;
    jpeg.starts_with(&[0xFF, 0xD8]).then_some(jpeg)
}

/// Quick Look's thumbnail of the clip (AVFoundation underneath), made a JPEG.
#[cfg(target_os = "macos")]
fn with_quick_look(video: &Path, side: u32) -> Option<Vec<u8>> {
    let dir = tempfile::tempdir().ok()?;
    let mut cmd = crate::process_util::hidden_command("/usr/bin/qlmanage");
    cmd.arg("-t").arg("-s").arg(side.to_string()).arg("-o").arg(dir.path()).arg(video);
    // It writes the picture into `dir`; what it prints does not matter.
    let _ = run_with_timeout(cmd);
    let name = format!("{}.png", video.file_name()?.to_string_lossy());
    let png = std::fs::read(dir.path().join(name)).ok()?;
    let img = image::load_from_memory(&png).ok()?.thumbnail(side, side).to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80).encode_image(&img).ok()?;
    Some(out)
}

/// The first frame of `video` as a JPEG of at most `side` a side, or `None`
/// when this computer has no way to read it.
pub(crate) fn first_frame_jpeg(video: &Path, side: u32, comfy_base: Option<&Path>) -> Option<Vec<u8>> {
    let path_env = std::env::var_os("PATH");
    for ffmpeg in ffmpeg_candidates(path_env.as_deref(), &crate::os_paths::data_dir(), comfy_base) {
        if let Some(jpeg) = with_ffmpeg(&ffmpeg, video, side) {
            return Some(jpeg);
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(jpeg) = with_quick_look(video, side) {
        return Some(jpeg);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"x").unwrap();
    }

    #[test]
    fn ffmpeg_is_looked_for_on_the_path_then_in_the_engine_venvs_then_beside_comfyui() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("bin");
        touch(&bin.join(exe("ffmpeg")));
        let data = root.path().join("data");
        let mac = data.join("mlx-video/venv/lib/python3.12/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1");
        touch(&mac);
        let comfy = root.path().join("ComfyUI_windows_portable").join("ComfyUI");
        let win = root.path().join("ComfyUI_windows_portable/python_embeded/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe");
        touch(&win);
        // Not a binary of imageio_ffmpeg: never taken.
        touch(&data.join("mlx/venv/lib/python3.12/site-packages/imageio_ffmpeg/binaries/README.md"));
        let path = std::env::join_paths([root.path().join("nothing"), bin.clone()]).unwrap();
        let found = ffmpeg_candidates(Some(&path), &data, Some(&comfy));
        assert_eq!(found, vec![bin.join(exe("ffmpeg")), mac, win]);
        assert!(ffmpeg_candidates(None, &data.join("none"), None).is_empty());
    }

    #[test]
    fn one_frame_scaled_comes_back_as_jpeg_on_stdout() {
        let args: Vec<String> = ffmpeg_args(Path::new("/v/clip.mp4"), 320).unwrap().iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(&args[..9], ["-v", "error", "-nostdin", "-protocol_whitelist", "file", "-f", "mov", "-i", "file:/v/clip.mp4"]);
        assert!(args.windows(2).any(|w| w == ["-frames:v", "1"]));
        assert!(args.contains(&"scale=320:320:force_original_aspect_ratio=decrease".to_string()));
        assert_eq!(args.last().unwrap(), "-");
    }

    #[test]
    fn the_demuxer_follows_the_ending_and_other_endings_are_not_read() {
        assert_eq!(input_format(Path::new("a.MP4")), Some("mov"));
        assert_eq!(input_format(Path::new("a.webm")), Some("matroska"));
        for bad in ["a.m3u8", "a.txt", "a", "a.concat", "a.png"] {
            assert!(ffmpeg_args(Path::new(bad), 320).is_none(), "{bad}");
        }
        // A name that looks like an option or a protocol stays a local file.
        let args = ffmpeg_args(Path::new("-y http:x.webm"), 320).unwrap();
        assert!(args.iter().any(|a| a == "file:-y http:x.webm"));
    }

    #[test]
    fn nothing_that_can_read_the_clip_means_no_frame() {
        assert!(with_ffmpeg(Path::new("/nonexistent/ffmpeg"), Path::new("/nonexistent/clip.mp4"), 320).is_none());
    }
}
