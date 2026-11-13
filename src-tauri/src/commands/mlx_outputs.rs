//! Delete in the gallery reaches the file on a Mac too.
//!
//! On Windows and Linux a local render is a file in ComfyUI's output folder,
//! and `gallery_files.rs` moves it to the Recycle Bin. The Mac has no ComfyUI:
//! its engines write stills to `images` and clips to `videos` in the app's
//! data folder, and a Delete in the gallery took the entry away and left the
//! file there. The folder grew and nothing in Create said where it is
//! (persona walk, 09.10.2026, Fund 13, the Discord report of 25.09.2026 for
//! the Mac).
//!
//! The file goes to the Trash, not into oblivion: a misclick in the gallery
//! must stay recoverable. Exactly one file per call, and only a media file
//! that lies directly in one of the output folders. The path comes from
//! the interface, so it is taken apart here (`resolve`) and nowhere else.

use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use crate::commands::CmdResult;
use crate::state::AppState;

/// What the Mac's engines write: PNG stills (`mlx.rs`, `image_mflux.rs`),
/// MP4 clips (`video.rs`), WAV tracks (`music.rs`) and GLB models
/// (`mesh3d.rs`). The other endings are what a later engine may write.
/// Nothing else in these folders is a render.
const MEDIA_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "mp4", "mov", "webm", "wav", "glb"];

const NOT_OURS: &str = "That gallery entry does not name a file in LU's output folders.";

/// The folders a gallery entry of the Mac may name a file in.
pub(crate) fn output_roots() -> Vec<PathBuf> {
    vec![
        crate::commands::mlx::images_root(),
        crate::commands::video::outputs_root(),
        crate::commands::music::outputs_root(),
        crate::commands::mesh3d::outputs_root(),
    ]
}

/// The file behind a path the interface sent.
///
/// `Ok(None)`: the path is one of ours and the file is gone already.
/// `Err`: the path is not a render in one of `roots`, in the user's words.
///
/// A path is taken only when it is absolute, made of plain parts (no `..`, no
/// `.`), ends in a media ending, and its folder IS one of the roots after
/// every link is followed: a file in a subfolder (the staged start images) is
/// not a render. The file itself must be a plain file and no link, so a link
/// that someone put into the folder never sends its target to the Trash.
pub(crate) fn resolve(roots: &[PathBuf], path: &str) -> Result<Option<PathBuf>, String> {
    if path.is_empty() || path.contains('\0') {
        return Err(NOT_OURS.to_string());
    }
    let asked = Path::new(path);
    // `components()` drops a `.` in the middle of a path, so the parts are
    // read from the text as well.
    if !asked.is_absolute()
        || path.split(['/', '\\']).any(|part| part == "." || part == "..")
        || asked.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(NOT_OURS.to_string());
    }
    let (Some(name), Some(parent)) = (asked.file_name(), asked.parent()) else {
        return Err(NOT_OURS.to_string());
    };
    let known_ending = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| MEDIA_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
    if !known_ending {
        return Err(NOT_OURS.to_string());
    }
    // A folder that is not there cannot be one of ours: the engines make
    // theirs before they write.
    let Ok(real_parent) = parent.canonicalize() else {
        return Err(NOT_OURS.to_string());
    };
    let Some(real_root) = roots.iter().filter_map(|r| r.canonicalize().ok()).find(|r| *r == real_parent) else {
        return Err(NOT_OURS.to_string());
    };
    let file = real_root.join(name);
    let meta = match std::fs::symlink_metadata(&file) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(NOT_OURS.to_string()),
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(NOT_OURS.to_string());
    }
    Ok(Some(file))
}

/// Resolve `path` and hand the file to `bin`. The answer is what the
/// interface reads: whether a file went, or whether there was none.
fn trash_in(roots: &[PathBuf], path: &str, bin: impl FnOnce(&Path) -> Result<(), String>) -> CmdResult {
    match resolve(roots, path).map_err(crate::commands::bad_request)? {
        None => Ok(json!({ "trashed": false, "missing": true })),
        Some(file) => {
            bin(&file).map_err(|e| crate::commands::internal(format!("Could not move the file to the Trash: {e}")))?;
            Ok(json!({ "trashed": true, "missing": false }))
        }
    }
}

pub(crate) use crate::commands::os_trash::system_trash;

/// `mlx_output_trash`: move one render of the Mac's engines to the Trash.
/// `args.path` is the path the engine answered a run with.
pub fn mlx_output_trash(_state: &AppState, args: &Value) -> CmdResult {
    let path = args.get("path").and_then(Value::as_str).ok_or_else(|| crate::commands::bad_request("missing path"))?;
    trash_in(&output_roots(), path, system_trash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Two output folders with a render each, a staged start image below one
    /// of them, and a file next to them.
    fn layout(tag: &str) -> (crate::os_paths::TestDir, Vec<PathBuf>) {
        let dir = crate::os_paths::test_dir(tag);
        let images = dir.join("images");
        let videos = dir.join("videos");
        std::fs::create_dir_all(videos.join("start-images")).unwrap();
        std::fs::create_dir_all(&images).unwrap();
        std::fs::write(images.join("mlx-1-2.png"), b"png").unwrap();
        std::fs::write(videos.join("abc.mp4"), b"mp4").unwrap();
        std::fs::write(videos.join("start-images").join("staged.png"), b"png").unwrap();
        std::fs::write(images.join("notes.txt"), b"x").unwrap();
        std::fs::write(dir.join("outside.png"), b"png").unwrap();
        (dir, vec![images, videos])
    }

    fn s(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn the_folders_are_the_ones_the_engines_write_to_and_playback_reads_from() {
        assert_eq!(
            output_roots(),
            vec![
                crate::commands::mlx::images_root(),
                crate::commands::video::outputs_root(),
                crate::commands::music::outputs_root(),
                crate::commands::mesh3d::outputs_root(),
            ]
        );
        // The same three folders `read_media_file` serves: what the gallery
        // can show is what it can delete.
        let media = include_str!("media_cmds.rs");
        let allowed = &media[media.find("fn allowed_media_roots()").unwrap()..];
        let allowed = &allowed[..allowed.find("\n}\n").unwrap()];
        assert!(allowed.contains("crate::commands::video::outputs_root()"));
        assert!(allowed.contains("crate::commands::mlx::images_root()"));
        assert!(allowed.contains("crate::commands::music::outputs_root()"));
        assert!(allowed.contains("crate::commands::mesh3d::outputs_root()"));
        assert_eq!(allowed.matches("crate::commands::").count(), 4, "read_media_file serves a folder that Delete does not know");
    }

    #[test]
    fn a_track_of_the_music_engine_resolves_like_a_clip() {
        let tmp = tempfile::tempdir().unwrap();
        let music = tmp.path().join("music");
        std::fs::create_dir_all(&music).unwrap();
        std::fs::write(music.join("music-j1.wav"), b"RIFF").unwrap();
        std::fs::write(music.join("job.json"), b"{}").unwrap();
        let roots = vec![music.clone()];
        assert_eq!(resolve(&roots, &s(&music.join("music-j1.wav"))).unwrap(), Some(music.canonicalize().unwrap().join("music-j1.wav")));
        assert!(resolve(&roots, &s(&music.join("job.json"))).is_err(), "not a render");
    }

    #[test]
    fn a_model_of_the_3d_engine_resolves_like_a_clip() {
        let tmp = tempfile::tempdir().unwrap();
        let models = tmp.path().join("3d");
        std::fs::create_dir_all(&models).unwrap();
        std::fs::write(models.join("mesh3d-run1.glb"), b"glTF").unwrap();
        std::fs::write(models.join("input.png"), b"png").unwrap();
        std::fs::write(models.join("mesh.obj"), b"v").unwrap();
        let roots = vec![models.clone()];
        assert_eq!(resolve(&roots, &s(&models.join("mesh3d-run1.glb"))).unwrap(), Some(models.canonicalize().unwrap().join("mesh3d-run1.glb")));
        assert!(resolve(&roots, &s(&models.join("mesh.obj"))).is_err(), "not a render of this app");
    }

    #[test]
    fn a_render_in_an_output_folder_resolves_and_nothing_else_does() {
        let (dir, roots) = layout("mlx-outputs-resolve");
        let images = roots[0].canonicalize().unwrap();
        let videos = roots[1].canonicalize().unwrap();
        assert_eq!(resolve(&roots, &s(&roots[0].join("mlx-1-2.png"))).unwrap(), Some(images.join("mlx-1-2.png")));
        assert_eq!(resolve(&roots, &s(&roots[1].join("abc.mp4"))).unwrap(), Some(videos.join("abc.mp4")));
        // Ours by its place, and gone already.
        assert_eq!(resolve(&roots, &s(&roots[0].join("mlx-9-9.png"))).unwrap(), None);

        std::fs::create_dir_all(roots[0].join("folder.png")).unwrap();
        for bad in [
            String::new(),
            "mlx-1-2.png".to_string(),
            "images/mlx-1-2.png".to_string(),
            s(&dir.join("outside.png")),
            s(&roots[0].join("..").join("outside.png")),
            s(&roots[0].join("..").join("images").join("mlx-1-2.png")),
            s(&roots[0].join(".").join("mlx-1-2.png")),
            s(&roots[1].join("start-images").join("staged.png")),
            s(&roots[1].join("start-images").join("..").join("abc.mp4")),
            s(&roots[0].join("notes.txt")),
            s(&roots[0].join("noext")),
            s(&roots[0].join("folder.png")),
            s(&roots[0]),
            s(&roots[1]),
            format!("{}\0.png", s(&roots[0].join("mlx-1-2.png"))),
            "/etc/passwd".to_string(),
            "/".to_string(),
            s(&dir.join("absent-folder").join("x.png")),
        ] {
            assert_eq!(resolve(&roots, &bad).unwrap_err(), NOT_OURS, "{bad:?} was let through");
        }
        // With no folder to compare with, nothing is ours.
        assert_eq!(resolve(&[], &s(&roots[0].join("mlx-1-2.png"))).unwrap_err(), NOT_OURS);
        assert_eq!(resolve(&[dir.join("absent")], &s(&roots[0].join("mlx-1-2.png"))).unwrap_err(), NOT_OURS);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_never_sends_its_target_to_the_trash() {
        use std::os::unix::fs::symlink;
        let (dir, roots) = layout("mlx-outputs-links");
        // A link inside the folder that points out of it.
        symlink(dir.join("outside.png"), roots[0].join("link.png")).unwrap();
        assert_eq!(resolve(&roots, &s(&roots[0].join("link.png"))).unwrap_err(), NOT_OURS);
        // A link inside the folder to a render of the folder: still a link.
        symlink(roots[0].join("mlx-1-2.png"), roots[0].join("twin.png")).unwrap();
        assert_eq!(resolve(&roots, &s(&roots[0].join("twin.png"))).unwrap_err(), NOT_OURS);
        // A dangling link is a link too, not a missing file.
        symlink(dir.join("nowhere.png"), roots[0].join("dangling.png")).unwrap();
        assert_eq!(resolve(&roots, &s(&roots[0].join("dangling.png"))).unwrap_err(), NOT_OURS);
        // A folder elsewhere, reached through a link: its files are not ours.
        let elsewhere = dir.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("x.png"), b"png").unwrap();
        symlink(&elsewhere, roots[0].join("sub")).unwrap();
        assert_eq!(resolve(&roots, &s(&roots[0].join("sub").join("x.png"))).unwrap_err(), NOT_OURS);
        // The output folder itself reached through a link is the same folder.
        symlink(&roots[0], dir.join("alias")).unwrap();
        assert_eq!(
            resolve(&roots, &s(&dir.join("alias").join("mlx-1-2.png"))).unwrap(),
            Some(roots[0].canonicalize().unwrap().join("mlx-1-2.png"))
        );
    }

    #[test]
    fn one_file_goes_to_the_bin_and_the_answer_says_what_happened() {
        let (dir, roots) = layout("mlx-outputs-trash");
        let binned: RefCell<Vec<PathBuf>> = RefCell::new(Vec::new());
        let bin = |file: &Path| {
            binned.borrow_mut().push(file.to_path_buf());
            Ok(())
        };
        let still = roots[0].join("mlx-1-2.png");
        assert_eq!(trash_in(&roots, &s(&still), bin).unwrap(), json!({ "trashed": true, "missing": false }));
        assert_eq!(*binned.borrow(), vec![roots[0].canonicalize().unwrap().join("mlx-1-2.png")]);

        // Gone already: no call, and no error either.
        let none = |_: &Path| -> Result<(), String> { panic!("nothing to move") };
        assert_eq!(trash_in(&roots, &s(&roots[0].join("mlx-0-0.png")), none).unwrap(), json!({ "trashed": false, "missing": true }));
        // Not ours: no call.
        let none = |_: &Path| -> Result<(), String> { panic!("not ours") };
        assert_eq!(trash_in(&roots, &s(&dir.join("outside.png")), none).unwrap_err(), NOT_OURS);
        // The system said no.
        let refuses = |_: &Path| Err("permission denied".to_string());
        assert_eq!(
            trash_in(&roots, &s(&roots[1].join("abc.mp4")), refuses).unwrap_err(),
            "Could not move the file to the Trash: permission denied"
        );
    }

    #[test]
    fn the_command_never_deletes_for_good() {
        let source = include_str!("mlx_outputs.rs");
        let production = &source[..source.find("#[cfg(test)]").unwrap()];
        for hard in ["remove_file", "remove_dir", "fs::rename"] {
            assert!(!production.contains(hard), "{hard} is not the Trash");
        }
        // The Trash itself lives in os_trash.rs since 3.0.8, shared with the
        // download, the model check and the runtime folder.
        assert!(production.contains("pub(crate) use crate::commands::os_trash::system_trash;"));
        let trash = include_str!("os_trash.rs");
        assert!(trash.contains("DeleteMethod::NsFileManager"), "asking Finder shows a permission prompt");
        for hard in ["remove_file", "remove_dir", "fs::rename"] {
            assert!(!trash.contains(hard), "{hard} is not the Trash");
        }
    }

    #[test]
    fn the_command_asks_for_a_path() {
        let state = AppState::new();
        assert_eq!(mlx_output_trash(&state, &json!({})).unwrap_err(), "missing path");
        assert_eq!(mlx_output_trash(&state, &json!({ "path": "relative.png" })).unwrap_err(), NOT_OURS);
    }
}
