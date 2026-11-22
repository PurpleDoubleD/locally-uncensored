//! Linux: pip's temporary files and cache live on the disk ComfyUI goes to.
//!
//! GitHub issue 266: an install with about 200 GB free on the target ended on
//! "Out of disk space", with a traceback from `tempfile.py`. pip unpacks the
//! PyTorch wheels in the system temp folder, which on Linux can be a small
//! tmpfs that has nothing to do with the target disk.
//!
//! The guard is per thread because one install runs all of its pip calls on
//! one worker thread, through several modules. Windows and macOS never get a
//! scratch folder, so their pip runs keep the environment they always had.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::Command;

const SCRATCH_DIR: &str = ".lu-pip-scratch";

thread_local! {
    static ACTIVE: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

/// Holds the scratch folder for this thread and removes it when dropped, so
/// every way out of an install (error, cancel, panic) cleans up.
pub(crate) struct PipScratch {
    root: Option<PathBuf>,
}

impl PipScratch {
    pub(crate) fn enter(comfy_dir: &Path) -> Self {
        Self::enter_on(std::env::consts::OS, comfy_dir)
    }

    fn enter_on(os: &str, comfy_dir: &Path) -> Self {
        if os != "linux" {
            return PipScratch { root: None };
        }
        let root = comfy_dir.join(SCRATCH_DIR);
        // Without the folder pip simply runs as it did before.
        if prepare(&root).is_err() {
            return PipScratch { root: None };
        }
        ACTIVE.with(|active| *active.borrow_mut() = Some(root.clone()));
        PipScratch { root: Some(root) }
    }
}

impl Drop for PipScratch {
    fn drop(&mut self) {
        if let Some(root) = self.root.take() {
            ACTIVE.with(|active| *active.borrow_mut() = None);
            let _ = remove_real_dir(&root);
        }
    }
}

/// A leftover from a killed run goes first. A symlink or file of that name is
/// not ours: it stays, and this run does without a scratch folder.
fn prepare(root: &Path) -> std::io::Result<()> {
    remove_real_dir(root)?;
    create_private_dir(root)?;
    std::fs::create_dir(root.join("tmp"))?;
    std::fs::create_dir(root.join("cache"))
}

fn remove_real_dir(root: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(root) {
        Ok(meta) if meta.file_type().is_dir() => std::fs::remove_dir_all(root),
        Ok(_) => Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "not a plain folder")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(unix)]
fn create_private_dir(root: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().mode(0o700).create(root)
}

#[cfg(not(unix))]
fn create_private_dir(root: &Path) -> std::io::Result<()> {
    std::fs::create_dir(root)
}

fn active_root() -> Option<PathBuf> {
    ACTIVE.with(|active| active.borrow().clone())
}

/// Points one pip process at this thread's scratch folder, if it has one.
pub(super) fn apply_pip_scratch(cmd: &mut Command) {
    if let Some(root) = active_root() {
        cmd.env("TMPDIR", root.join("tmp")).env("PIP_CACHE_DIR", root.join("cache"));
    }
}

/// The path pip names in `No space left on device: '<path>'`, if it does.
fn path_in_disk_full_error(text: &str) -> Option<&str> {
    const MARK: &str = "no space left on device";
    let at = text.to_ascii_lowercase().find(MARK)? + MARK.len();
    let rest = text[at..].strip_prefix(':')?.trim_start();
    let quote = rest.chars().next().filter(|c| *c == '\'' || *c == '"')?;
    let body = &rest[1..];
    let path = &body[..body.find(quote)?];
    path.starts_with('/').then_some(path)
}

/// The disk-full message with the place that is full. Only on Linux, the
/// other systems keep their sentence.
pub(super) fn disk_full_hint(hint: String, text: &str) -> String {
    disk_full_hint_on(std::env::consts::OS, hint, text, active_root().as_deref())
}

fn disk_full_hint_on(os: &str, hint: String, text: &str, scratch: Option<&Path>) -> String {
    if os != "linux" && scratch.is_none() {
        return hint;
    }
    let place = path_in_disk_full_error(text)
        .map(str::to_string)
        .or_else(|| scratch.map(|root| root.join("tmp").display().to_string()))
        .unwrap_or_else(|| std::env::temp_dir().display().to_string());
    format!(
        "Out of disk space at {place}. PyTorch + dependencies need ~5 GB free there. \
         Free up space on that disk and retry."
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// Stands in for pip on a machine whose /tmp is a full tmpfs: it fails
    /// with Errno 28 unless its temp folder lies inside the ComfyUI target.
    fn run_fake_pip(dir: &Path, comfy: &Path) -> std::process::Output {
        let script = dir.join("fake-pip.sh");
        crate::test_support::write_script(
            &script,
            format!(
                "#!/bin/sh\n\
                 case \"$TMPDIR\" in\n\
                 '{comfy}'/*) [ -d \"$TMPDIR\" ] && [ -d \"$PIP_CACHE_DIR\" ] && exit 0 ;;\n\
                 esac\n\
                 echo \"OSError: [Errno 28] No space left on device\" 1>&2\n\
                 exit 1\n",
                comfy = comfy.display()
            ),
        );
        let mut cmd = Command::new(&script);
        cmd.env("TMPDIR", "/tmp").env_remove("PIP_CACHE_DIR");
        apply_pip_scratch(&mut cmd);
        cmd.output().expect("fake pip runs")
    }

    #[test]
    fn a_full_system_temp_no_longer_stops_the_install_on_linux() {
        let dir = tempfile::tempdir().unwrap();
        let comfy = dir.path().join("ComfyUI");
        std::fs::create_dir(&comfy).unwrap();

        let without = run_fake_pip(dir.path(), &comfy);
        assert!(!without.status.success(), "the full temp folder must reproduce the failure");
        assert!(String::from_utf8_lossy(&without.stderr).contains("Errno 28"));

        let scratch = PipScratch::enter_on("linux", &comfy);
        let with = run_fake_pip(dir.path(), &comfy);
        assert!(with.status.success(), "{}", String::from_utf8_lossy(&with.stderr));
        assert!(comfy.join(SCRATCH_DIR).is_dir());

        drop(scratch);
        assert!(!comfy.join(SCRATCH_DIR).exists(), "the scratch folder must be gone after the run");
        assert!(active_root().is_none());
    }

    #[test]
    fn windows_and_macos_keep_their_pip_environment() {
        let dir = tempfile::tempdir().unwrap();
        for os in ["windows", "macos"] {
            let _scratch = PipScratch::enter_on(os, dir.path());
            let mut cmd = Command::new("true");
            apply_pip_scratch(&mut cmd);
            assert_eq!(cmd.get_envs().count(), 0, "{os} must not get a changed environment");
            assert!(!dir.path().join(SCRATCH_DIR).exists());
        }
        let hint = "Out of disk space.".to_string();
        assert_eq!(disk_full_hint_on("windows", hint.clone(), "[Errno 28]", None), hint);
        assert_eq!(disk_full_hint_on("macos", hint.clone(), "[Errno 28]", None), hint);
    }

    #[test]
    fn a_leftover_is_replaced_and_a_foreign_link_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(SCRATCH_DIR);
        std::fs::create_dir_all(root.join("tmp/old")).unwrap();
        let scratch = PipScratch::enter_on("linux", dir.path());
        assert!(!root.join("tmp/old").exists(), "a killed run's files must not survive");
        drop(scratch);

        let elsewhere = tempfile::tempdir().unwrap();
        let keep = elsewhere.path().join("keep");
        std::fs::write(&keep, "x").unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), &root).unwrap();
        let scratch = PipScratch::enter_on("linux", dir.path());
        assert!(active_root().is_none());
        drop(scratch);
        assert!(keep.exists(), "the guard must never delete through a symlink");
    }

    #[test]
    fn the_message_names_the_place_that_is_full() {
        let hint = || "Out of disk space.".to_string();
        let named = disk_full_hint_on(
            "linux",
            hint(),
            "OSError: [Errno 28] No space left on device: '/tmp/pip-unpack-1/torch.whl'",
            None,
        );
        assert!(named.contains("/tmp/pip-unpack-1/torch.whl"), "{named}");

        let from_scratch = disk_full_hint_on(
            "linux",
            hint(),
            "OSError: [Errno 28] No space left on device",
            Some(Path::new("/data/ComfyUI/.lu-pip-scratch")),
        );
        assert!(from_scratch.contains("/data/ComfyUI/.lu-pip-scratch/tmp"), "{from_scratch}");
    }

    #[test]
    fn install_and_repair_run_pip_inside_the_guard() {
        let pip = include_str!("pip.rs");
        assert!(pip.contains("apply_pip_scratch(&mut cmd);"), "the pip loop no longer applies the scratch folder");
        for (name, source, dir) in [
            ("install", include_str!("comfy_install.rs"), "target_dir"),
            ("repair", include_str!("comfy_repair.rs"), "comfy_dir"),
        ] {
            let guard = format!("let _pip_scratch = PipScratch::enter(&{dir});");
            let at_guard = source.find(&guard).unwrap_or_else(|| panic!("{name} has no scratch guard"));
            let at_lift = source.find("lift_old_pip_before_torch(").unwrap();
            assert!(at_guard < at_lift, "{name}: the guard must stand before the first pip run");
        }
    }
}
