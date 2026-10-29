//! The ComfyUI release LU installs, and how an LU install stays on it.
//!
//! Until 3.0.9 the installer cloned whatever `master` was at that minute and
//! Update ran `git pull --ff-only`, so two customers who installed a day
//! apart ran different ComfyUIs, and a bad commit upstream reached every new
//! install the moment it landed. Now a fresh install clones the tag below
//! (full history, so a later move to a newer tag is a local checkout) and
//! Update sets an LU install to that tag again, fetching it first.
//!
//! Only a ComfyUI that LU itself cloned is pinned. It is recognised by a
//! marker file inside its `.git` folder, written right after LU's clone:
//! inside `.git` so `git status` never lists it (Update refuses a dirty tree,
//! see `git_dirty_lines`) and it moves with the folder when the customer
//! moves it. A ComfyUI the customer brought along (a portable, Stability
//! Matrix, their own clone) has no marker and keeps the old behaviour, a
//! fast-forward pull of its own branch, or no update at all without git.
//!
//! Model gates on the TypeScript side (`dynamic-workflow.ts`) ask for up to
//! ComfyUI 0.37.0 today; the pin has to stay at or above the highest of them.

use std::path::Path;

/// Where ComfyUI comes from.
pub(crate) const COMFYUI_REPO_URL: &str = "https://github.com/comfyanonymous/ComfyUI.git";

/// The ComfyUI release LU installs and updates its own install to. v0.42.4
/// is the release of 22.10.2026; it carries `--use-ck-attention` (0.32.0+,
/// see commands/comfy_attention.rs) and every node the model gates ask for.
pub(crate) const COMFYUI_PINNED_TAG: &str = "v0.42.4";

/// The marker's name inside `.git`.
const LU_INSTALL_MARKER: &str = "lu-installed";

/// The arguments after `git clone` for a pinned install, without the target
/// folder. `--branch` takes a tag as well and leaves the checkout detached on
/// it; without `--depth` or `--single-branch` the whole history and every
/// branch come along, so an update to a later tag needs no reclone.
pub(crate) fn pinned_clone_args() -> [&'static str; 3] {
    ["--branch", COMFYUI_PINNED_TAG, COMFYUI_REPO_URL]
}

/// Note in `comfy_dir/.git` that LU cloned this ComfyUI. An error only when
/// `.git` is not a folder or cannot be written; the caller logs it and goes
/// on, an unmarked install simply keeps updating the old way.
pub(crate) fn mark_lu_installed(comfy_dir: &Path) -> Result<(), String> {
    let git_dir = comfy_dir.join(".git");
    if !git_dir.is_dir() {
        return Err(format!("{} is not a git folder", git_dir.display()));
    }
    std::fs::write(
        git_dir.join(LU_INSTALL_MARKER),
        format!("Installed by LU on ComfyUI {COMFYUI_PINNED_TAG}. LU keeps this ComfyUI on its tested release.\n"),
    )
    .map_err(|e| crate::os_error::english(&e))
}

/// Did LU clone this ComfyUI? Only then may Update move it to the pin.
pub(crate) fn is_lu_installed(comfy_dir: &Path) -> bool {
    comfy_dir.join(".git").join(LU_INSTALL_MARKER).is_file()
}

/// `git` inside `dir`, output captured, never waiting for a password.
fn git_ok(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = super::custom_nodes::git_in(dir, args)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// The commit a tag points at, if the checkout knows the tag.
fn tag_commit(dir: &Path, tag: &str) -> Option<String> {
    git_ok(dir, &["rev-parse", "--verify", "--quiet", &format!("refs/tags/{tag}^{{commit}}")]).ok()
}

/// What [`checkout_pinned_tag`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PinOutcome {
    /// HEAD already was the tag's commit; nothing moved.
    AlreadyThere,
    /// HEAD moved to the tag's commit.
    Moved,
}

/// Put an LU install on `tag`, detached.
///
/// `fetch` is the Update case: `git fetch --tags origin` first, so a newer
/// LU with a newer pin finds its tag. A fetch that fails (offline box, a
/// firewall) is not fatal while the tag is already known locally, the
/// install case where the clone brought it; without the tag it is the error.
pub(crate) fn checkout_pinned_tag(dir: &Path, tag: &str, fetch: bool) -> Result<PinOutcome, String> {
    let mut fetch_error = None;
    if fetch || tag_commit(dir, tag).is_none() {
        if let Err(e) = git_ok(dir, &["fetch", "--tags", "origin"]) {
            fetch_error = Some(e);
        }
    }
    let Some(target) = tag_commit(dir, tag) else {
        return Err(match fetch_error {
            Some(e) => format!("Could not fetch the ComfyUI release {tag}: {e}"),
            None => format!("The ComfyUI release {tag} does not exist in this checkout's origin."),
        });
    };
    if git_ok(dir, &["rev-parse", "HEAD"]).is_ok_and(|head| head.eq_ignore_ascii_case(&target)) {
        return Ok(PinOutcome::AlreadyThere);
    }
    git_ok(dir, &["-c", "advice.detachedHead=false", "checkout", "--detach", &target])?;
    Ok(PinOutcome::Moved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn git(dir: &Path, args: &[&str]) -> String {
        let mut all = vec!["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];
        all.extend_from_slice(args);
        git_ok(dir, &all).unwrap_or_else(|e| panic!("git {args:?} failed: {e}"))
    }

    /// An origin with three commits: `v0.41.0`, then the pinned tag, then a
    /// newer master commit nobody tested. Returns the temp dir, the origin and
    /// the three commit ids in that order.
    fn origin() -> (tempfile::TempDir, PathBuf, [String; 3]) {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin");
        std::fs::create_dir(&origin).unwrap();
        git(&origin, &["init", "-b", "master"]);
        git(&origin, &["config", "core.autocrlf", "false"]);
        let mut ids = Vec::new();
        for (content, tag) in [("old", Some("v0.41.0")), ("pinned", Some(COMFYUI_PINNED_TAG)), ("untested", None)] {
            std::fs::write(origin.join("main.py"), content).unwrap();
            git(&origin, &["add", "."]);
            git(&origin, &["commit", "-m", content]);
            if let Some(t) = tag {
                git(&origin, &["tag", t]);
            }
            ids.push(git(&origin, &["rev-parse", "HEAD"]));
        }
        (tmp, origin, ids.try_into().unwrap())
    }

    fn clone_pinned(origin: &Path, target: &Path) {
        // The real argument list with the test origin in place of GitHub.
        let mut args: Vec<&str> = pinned_clone_args().to_vec();
        assert_eq!(args[2], COMFYUI_REPO_URL);
        let origin_str = origin.to_string_lossy().to_string();
        args[2] = &origin_str;
        let target_str = target.to_string_lossy().to_string();
        let mut all = vec!["clone"];
        all.extend(args);
        all.push(&target_str);
        git(origin.parent().unwrap(), &all);
    }

    #[test]
    fn the_pin_is_the_checked_release() {
        assert_eq!(COMFYUI_PINNED_TAG, "v0.42.4");
        assert_eq!(pinned_clone_args(), ["--branch", "v0.42.4", "https://github.com/comfyanonymous/ComfyUI.git"]);
        // Never shallow: an update to a later tag must not need a reclone.
        assert!(!pinned_clone_args().iter().any(|a| a.starts_with("--depth") || *a == "--single-branch"));
    }

    #[test]
    fn a_pinned_clone_sits_on_the_tag_with_the_full_history() {
        let (tmp, origin, [old, pinned, untested]) = origin();
        let target = tmp.path().join("ComfyUI");
        clone_pinned(&origin, &target);
        assert_eq!(git(&target, &["rev-parse", "HEAD"]), pinned, "the clone is not on the pinned tag");
        assert_eq!(std::fs::read_to_string(target.join("main.py")).unwrap(), "pinned");
        // History before and after the tag came along.
        git(&target, &["cat-file", "-e", &format!("{old}^{{commit}}")]);
        git(&target, &["cat-file", "-e", &format!("{untested}^{{commit}}")]);
        assert_eq!(checkout_pinned_tag(&target, COMFYUI_PINNED_TAG, false).unwrap(), PinOutcome::AlreadyThere);
    }

    #[test]
    fn update_moves_an_lu_install_to_the_pin_and_not_to_master() {
        let (tmp, origin, [_old, pinned, untested]) = origin();
        let target = tmp.path().join("ComfyUI");
        // The state every install before the pin left behind: master.
        git(tmp.path(), &["clone", &origin.to_string_lossy(), &target.to_string_lossy()]);
        assert_eq!(git(&target, &["rev-parse", "HEAD"]), untested);
        assert_eq!(checkout_pinned_tag(&target, COMFYUI_PINNED_TAG, true).unwrap(), PinOutcome::Moved);
        assert_eq!(git(&target, &["rev-parse", "HEAD"]), pinned);
        // A second update has nothing to do.
        assert_eq!(checkout_pinned_tag(&target, COMFYUI_PINNED_TAG, true).unwrap(), PinOutcome::AlreadyThere);
    }

    #[test]
    fn a_tag_that_arrives_later_is_fetched() {
        let (tmp, origin, _) = origin();
        let target = tmp.path().join("ComfyUI");
        clone_pinned(&origin, &target);
        // A newer LU pins a release that did not exist at install time.
        std::fs::write(origin.join("main.py"), "next").unwrap();
        git(&origin, &["commit", "-am", "next"]);
        git(&origin, &["tag", "v9.0.0"]);
        let next = git(&origin, &["rev-parse", "HEAD"]);
        assert_eq!(checkout_pinned_tag(&target, "v9.0.0", true).unwrap(), PinOutcome::Moved);
        assert_eq!(git(&target, &["rev-parse", "HEAD"]), next);
    }

    #[test]
    fn a_missing_tag_is_an_error_and_moves_nothing() {
        let (tmp, origin, [_, pinned, _]) = origin();
        let target = tmp.path().join("ComfyUI");
        clone_pinned(&origin, &target);
        let err = checkout_pinned_tag(&target, "v99.0.0", true).unwrap_err();
        assert!(err.contains("v99.0.0"), "{err}");
        assert_eq!(git(&target, &["rev-parse", "HEAD"]), pinned, "a failed pin moved the checkout");
    }

    #[test]
    fn an_offline_update_still_pins_with_a_tag_the_clone_brought() {
        let (tmp, origin, [_, pinned, _]) = origin();
        let target = tmp.path().join("ComfyUI");
        git(tmp.path(), &["clone", &origin.to_string_lossy(), &target.to_string_lossy()]);
        // Origin gone: every fetch fails from here on.
        std::fs::remove_dir_all(&origin).unwrap();
        assert_eq!(checkout_pinned_tag(&target, COMFYUI_PINNED_TAG, true).unwrap(), PinOutcome::Moved);
        assert_eq!(git(&target, &["rev-parse", "HEAD"]), pinned);
        let err = checkout_pinned_tag(&target, "v99.0.0", true).unwrap_err();
        assert!(err.contains("Could not fetch"), "{err}");
    }

    #[test]
    fn only_a_folder_lu_marked_counts_as_an_lu_install_and_the_marker_stays_out_of_git_status() {
        let (tmp, origin, _) = origin();
        let target = tmp.path().join("ComfyUI");
        clone_pinned(&origin, &target);
        assert!(!is_lu_installed(&target), "a clone without the marker counts as LU's");
        mark_lu_installed(&target).unwrap();
        assert!(is_lu_installed(&target));
        assert_eq!(git(&target, &["status", "--porcelain"]), "", "the marker made the tree dirty, Update would refuse it");

        // A folder without git (a portable) cannot be marked and is never LU's.
        let portable = tmp.path().join("portable");
        std::fs::create_dir(&portable).unwrap();
        assert!(mark_lu_installed(&portable).is_err());
        assert!(!is_lu_installed(&portable));
    }
}
