use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// True when a `PYTHONHOME` / `PYTHONPATH` value points inside an AppImage's
/// throwaway mount instead of a real Python installation.
///
/// The Linux AppImage runtime mounts itself at `/tmp/.mount_<random>` and its
/// launcher exports `PYTHONHOME` / `PYTHONPATH` into that mount. Those are
/// inherited by every process we spawn, so a system `python3` looks for its
/// standard library inside our AppImage and dies before it runs a line:
///
/// ```text
/// Fatal Python error: init_fs_encoding: failed to get the Python codec of the filesystem encoding
/// ModuleNotFoundError: No module named 'encodings'
/// PYTHONHOME = '/tmp/.mount_LocallieGkad/usr/'
/// ```
///
/// numbrain hit exactly this installing ComfyUI on Linux Mint (Discord
/// 2026-07-28) with a perfectly healthy Python 3.12, and our diagnosis sent
/// them off to reinstall Python, which of course changed nothing. No AppImage
/// user could ever install ComfyUI.
pub fn is_appimage_python_env(value: &str) -> bool {
    let v = value.trim();
    if v.is_empty() {
        return false;
    }
    // PYTHONPATH is a list; poisoned if any entry points into the mount.
    v.split(':').any(|entry| {
        let e = entry.trim();
        e.starts_with("/tmp/.mount_")
            || std::env::var("APPDIR").is_ok_and(|d| !d.is_empty() && e.starts_with(&d))
    })
}

/// Drop AppImage-injected Python variables from our own environment, so every
/// child process we spawn sees the system Python the way a shell would.
///
/// Called once at startup, before any command runs. `LD_LIBRARY_PATH` is left
/// alone on purpose: the AppImage needs it for our own bundled libraries, and
/// it was never what broke Python here.
pub fn sanitize_appimage_python_env() {
    for key in ["PYTHONHOME", "PYTHONPATH"] {
        if std::env::var(key).is_ok_and(|v| is_appimage_python_env(&v)) {
            tracing::info!(key, "dropping AppImage Python env var so child processes get a clean interpreter");
            std::env::remove_var(key);
        }
    }
}

/// Compute the path to the venv's Python interpreter for a ComfyUI install
/// at `comfyui_dir`. Layout matches what `python -m venv` produces.
///
/// * Windows: `<comfyui_dir>/venv/Scripts/python.exe`
/// * Unix:    `<comfyui_dir>/venv/bin/python`
///
/// The file is NOT guaranteed to exist — call `path.exists()` if you care.
/// Used by both the installer (Bug E — PEP 668 venv creation) and the
/// process launcher (so `start_comfyui` runs ComfyUI inside the same
/// isolated env that pip installed PyTorch into).
pub fn venv_python_path(comfyui_dir: &Path) -> PathBuf {
    venv_python_path_named(comfyui_dir, "venv")
}

/// Same as [`venv_python_path`] but for an arbitrary venv directory name.
/// ComfyUI installs in the wild use either the classic `venv` (LU's own
/// PEP 668 installer — Bug E) or the modern `.venv` (`uv`,
/// `python -m venv .venv`). The file is NOT guaranteed to exist.
pub fn venv_python_path_named(comfyui_dir: &Path, venv_name: &str) -> PathBuf {
    let venv = comfyui_dir.join(venv_name);
    if cfg!(target_os = "windows") {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

/// Resolve the venv Python for `comfyui_dir` iff it exists. Returns the
/// path as a String (matching the API that `process::start_comfyui` already
/// uses for its `bundled_python` / `system_python` slots), or None when
/// no venv has been created — caller falls back to the system Python.
///
/// Checks both the classic `venv` and the modern `.venv` directory (issue #51,
/// adhney): a macOS/Linux ComfyUI installed into `.venv` was previously missed,
/// so `start_comfyui` fell back to the system Python and crashed with
/// `ModuleNotFoundError: torch`. `venv` is checked first to preserve the exact
/// behavior for users whose env LU's own installer created.
pub fn resolve_comfyui_venv_python(comfyui_dir: &Path) -> Option<String> {
    for venv_name in ["venv", ".venv"] {
        let candidate = venv_python_path_named(comfyui_dir, venv_name);
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

/// Resolve the real Python binary path, filtering out the Microsoft Store stub
/// alias (`%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`) which prints
/// "Python was not found, run without arguments to install from the Microsoft
/// Store" and exits 1 — useless for `pip install`. Returns the empty string
/// when no real Python is available; callers must treat `""` as
/// "Python not installed". Falling back to the bare `"python"` string the way
/// older versions did re-introduces the Store-stub trap on a fresh Windows
/// box, which is exactly the bug P14 fixes.
/// Non-Windows: walk `os_paths::unix_python_candidates()` and return the first
/// interpreter that resolves on PATH *and* answers `--version`.
///
/// Two constraints decide the shape of this function.
///
/// 1. BUG-008. Grabbing a bare `python3` is wrong on any box whose `python3`
///    is ahead of the ML wheels (3.14 today): ComfyUI, faster-whisper and
///    Piper all die at the first `pip install` with "no matching distribution",
///    and the user has no way to see why. The ordered candidate list that
///    prefers 3.12/3.11 already existed in `os_paths` — it was simply never
///    on the install path, because `find_python` (which uses it) is called by
///    the media lanes and `get_python_bin` (which did not) is called by
///    `AppState::new`, i.e. by everything that installs. This is the wiring.
/// 2. The result must be an ABSOLUTE path. Everything downstream derives
///    facts from it — `commands::process` reads the interpreter's prefix to
///    find torch, error messages quote it — and a bare name has no prefix:
///    `Path::new("python3").parent()` is `Some("")`, which silently turns
///    every derived path into a relative one.
///
/// `which` resolves the name; the `--version` run stays because a dangling
/// symlink or a shim that exits non-zero must be skipped, not cached.
/// Returns the empty string when nothing usable exists — callers treat `""`
/// as "no Python on this box" (see `is_real_python`).
#[cfg(not(target_os = "windows"))]
pub fn get_python_bin() -> String {
    for name in crate::os_paths::unix_python_candidates() {
        let Ok(path) = which::which(name) else { continue };
        let mut cmd = Command::new(&path);
        cmd.arg("--version");
        match cmd.output() {
            Ok(output) if output.status.success() => {
                return path.to_string_lossy().to_string();
            }
            _ => continue,
        }
    }
    String::new()
}

/// Windows: probe in order of reliability. Crucially this now tries the `py -3`
/// launcher and C:\Program Files\Python* — without them, an all-users python.org
/// install that skipped the "Add to PATH" checkbox (the aldrich "python not
/// installed" Discord report) was invisible to LU even though Python WAS
/// installed: `where python` returned nothing (or only the Store stub) and the
/// fixed-path scan only looked at the bare `C:\PythonXX` drive-root layout.
#[cfg(target_os = "windows")]
pub fn get_python_bin() -> String {
    if let Some(p) = python_via_where() { return p; }
    if let Some(p) = python_via_py_launcher() { return p; }
    if let Some(p) = python_in_fixed_paths() { return p; }
    if let Some(p) = python_in_program_files() { return p; }
    if let Some(p) = python_in_appdata() { return p; }
    if let Some(p) = python_in_conda() { return p; }
    println!("[Python] No real Python found on PATH or known locations — returning empty sentinel");
    String::new()
}

/// Run a candidate interpreter and confirm it's real (exits 0, not the MS Store
/// stub which prints an install nag and exits 1).
#[cfg(target_os = "windows")]
fn verify_python_path(path: &str) -> bool {
    if path.is_empty() || path.contains("WindowsApps") {
        return false;
    }
    let mut cmd = Command::new(path);
    cmd.arg("--version");
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

/// `where python` on PATH, skipping the WindowsApps Store-stub alias.
#[cfg(target_os = "windows")]
fn python_via_where() -> Option<String> {
    let mut where_cmd = Command::new("where");
    where_cmd.arg("python");
    where_cmd.creation_flags(CREATE_NO_WINDOW);
    let output = where_cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let path = line.trim();
        if !path.is_empty() && !path.contains("WindowsApps") && verify_python_path(path) {
            println!("[Python] Found via `where`: {}", path);
            return Some(path.to_string());
        }
    }
    None
}

/// The Windows `py -3` launcher (C:\Windows\py.exe) is installed system-wide by
/// the python.org installer regardless of the "Add to PATH" checkbox and the
/// install dir, so it finds Pythons that `where` + fixed-path scans miss. We ask
/// Python for its own sys.executable so we cache the concrete python.exe (needed
/// for venv creation / pip), not the launcher shim.
#[cfg(target_os = "windows")]
fn python_via_py_launcher() -> Option<String> {
    let mut cmd = Command::new("py");
    cmd.args(["-3", "-c", "import sys; print(sys.executable)"]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if verify_python_path(&path) {
        println!("[Python] Found via `py -3` launcher: {}", path);
        Some(path)
    } else {
        None
    }
}

/// Standard single-version python.org install dirs at the drive root.
#[cfg(target_os = "windows")]
fn python_in_fixed_paths() -> Option<String> {
    const COMMON: [&str; 5] = [
        "C:\\Python313\\python.exe",
        "C:\\Python312\\python.exe",
        "C:\\Python311\\python.exe",
        "C:\\Python310\\python.exe",
        "C:\\Python39\\python.exe",
    ];
    for p in COMMON {
        if Path::new(p).exists() && verify_python_path(p) {
            println!("[Python] Found at fixed path: {}", p);
            return Some(p.to_string());
        }
    }
    None
}

/// All-users python.org installs land in C:\Program Files\PythonXX (and the
/// 32-bit build under Program Files (x86)) — neither was scanned before, the
/// other half of the aldrich report.
#[cfg(target_os = "windows")]
fn python_in_program_files() -> Option<String> {
    for env_key in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Ok(base) = std::env::var(env_key) {
            if let Some(p) = scan_python_subdirs(Path::new(&base), "Program Files") {
                return Some(p);
            }
        }
    }
    None
}

/// Per-user python.org installs: %LOCALAPPDATA%\Programs\Python\Python3xx.
#[cfg(target_os = "windows")]
fn python_in_appdata() -> Option<String> {
    let localappdata = std::env::var("LOCALAPPDATA").ok()?;
    let base = Path::new(&localappdata).join("Programs").join("Python");
    scan_python_subdirs(&base, "AppData")
}

/// Scan `base` for `Python3xx\python.exe`, newest version first.
#[cfg(target_os = "windows")]
fn scan_python_subdirs(base: &Path, label: &str) -> Option<String> {
    let entries = std::fs::read_dir(base).ok()?;
    let mut dirs: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().ok().map_or(false, |ft| ft.is_dir())
                && e.file_name().to_string_lossy().to_lowercase().starts_with("python")
        })
        .collect();
    dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    for dir in dirs {
        let exe = dir.path().join("python.exe");
        if exe.exists() {
            let path = exe.to_string_lossy().to_string();
            if verify_python_path(&path) {
                println!("[Python] Found in {}: {}", label, path);
                return Some(path);
            }
        }
    }
    None
}

/// Miniconda / Anaconda base env in the user profile.
#[cfg(target_os = "windows")]
fn python_in_conda() -> Option<String> {
    let userprofile = std::env::var("USERPROFILE").ok()?;
    let candidates = [
        Path::new(&userprofile).join("miniconda3").join("python.exe"),
        Path::new(&userprofile).join("anaconda3").join("python.exe"),
        Path::new(&userprofile).join("miniconda3").join("Scripts").join("python.exe"),
        Path::new(&userprofile).join("anaconda3").join("Scripts").join("python.exe"),
    ];
    for p in candidates {
        if p.exists() {
            let path = p.to_string_lossy().to_string();
            if verify_python_path(&path) {
                println!("[Python] Found Conda: {}", path);
                return Some(path);
            }
        }
    }
    None
}

/// True iff `bin` looks like a real, runnable Python binary (not the empty
/// sentinel from `get_python_bin` and not a Microsoft Store stub).
pub fn is_real_python(bin: &str) -> bool {
    if bin.is_empty() {
        return false;
    }
    if bin.contains("WindowsApps") {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // ── AppImage Python env poisoning (numbrain, Discord 2026-07-28) ────────

    /// The exact values from the failing install on Linux Mint. Our own
    /// AppImage mount, inherited by the python3 we spawn, which then cannot
    /// find its standard library.
    #[test]
    fn appimage_mount_paths_are_recognised() {
        assert!(is_appimage_python_env("/tmp/.mount_LocallieGkad/usr/"));
        assert!(is_appimage_python_env("/tmp/.mount_LocallieGkad/usr/share/pyshared/:"));
        assert!(is_appimage_python_env("/tmp/.mount_ABC123/usr/lib/python3.12"));
    }

    #[test]
    fn a_poisoned_entry_anywhere_in_the_list_counts() {
        // PYTHONPATH is colon-separated; one bad entry breaks the interpreter.
        assert!(is_appimage_python_env("/home/u/mylib:/tmp/.mount_XY/usr/share/pyshared/"));
    }

    #[test]
    fn real_python_installs_are_left_alone() {
        assert!(!is_appimage_python_env("/usr/lib/python3.12"));
        assert!(!is_appimage_python_env("/home/user/.local/lib/python3.12"));
        assert!(!is_appimage_python_env("/opt/python3.11"));
        assert!(!is_appimage_python_env("C:\\Python312"));
        // A user's own directory that merely lives under /tmp is not a mount.
        assert!(!is_appimage_python_env("/tmp/my-python-experiment"));
    }

    #[test]
    fn empty_and_whitespace_are_not_poisoned() {
        assert!(!is_appimage_python_env(""));
        assert!(!is_appimage_python_env("   "));
    }

    // ── venv_python_path layout (Bug E — Arch PEP 668 venv) ─────────────────

    #[test]
    fn venv_python_path_matches_platform_layout() {
        let p = venv_python_path(Path::new("/home/u/ComfyUI"));
        let s = p.to_string_lossy().to_string();
        // On Windows expect `Scripts/python.exe`, on Unix expect `bin/python`.
        if cfg!(target_os = "windows") {
            assert!(
                s.ends_with("venv\\Scripts\\python.exe") || s.ends_with("venv/Scripts/python.exe"),
                "got {} on Windows",
                s
            );
        } else {
            assert!(s.ends_with("venv/bin/python"), "got {} on Unix", s);
        }
    }

    #[test]
    fn venv_python_path_is_under_comfyui_dir() {
        let comfy = Path::new("/some/where/ComfyUI");
        let venv_py = venv_python_path(comfy);
        assert!(
            venv_py.starts_with(comfy),
            "venv python {} did not start with {}",
            venv_py.display(),
            comfy.display()
        );
    }

    // ── resolve_comfyui_venv_python — existence gate ────────────────────────

    /// ── Why these three no longer name their own directory ──
    ///
    /// They used the FIXED paths `<temp>/lu-venv-test-missing`,
    /// `…-present` and `lu-dotvenv-test-present`, and each began by deleting
    /// its own. Every concurrent copy of this test binary used the same three,
    /// so one copy's `remove_dir_all` landed between another's `create_dir_all`
    /// and its `resolve_comfyui_venv_python` — the stub python was gone and the
    /// resolver correctly answered `None`. Measured on 01.09.2026 under six
    /// concurrent copies of the suite, ten rounds:
    /// `resolve_returns_some_when_venv_python_exists` and
    /// `resolve_finds_dot_venv_layout` failed 1 of 60 runs each.
    ///
    /// `crate::os_paths::test_dir` puts the process id and the thread id in the
    /// name and sweeps up on `Drop`, even when an assertion panics.
    #[test]
    fn resolve_returns_none_when_venv_missing() {
        let tmp = crate::os_paths::test_dir("venv-missing");
        assert!(resolve_comfyui_venv_python(&tmp).is_none());
    }

    #[test]
    fn resolve_returns_some_when_venv_python_exists() {
        // Build the exact layout `python -m venv` would produce so the
        // resolver finds it without actually invoking Python.
        let tmp = crate::os_paths::test_dir("venv-present");
        let inner = if cfg!(target_os = "windows") {
            tmp.join("venv").join("Scripts")
        } else {
            tmp.join("venv").join("bin")
        };
        fs::create_dir_all(&inner).unwrap();
        let py = if cfg!(target_os = "windows") {
            inner.join("python.exe")
        } else {
            inner.join("python")
        };
        fs::write(&py, "stub").unwrap();
        let resolved = resolve_comfyui_venv_python(&tmp);
        assert!(resolved.is_some(), "expected resolver to find {}", py.display());
        assert!(resolved.unwrap().contains("venv"));
    }

    #[test]
    fn resolve_finds_dot_venv_layout() {
        // Issue #51 (adhney): ComfyUI installed into `.venv` (uv / modern
        // `python -m venv .venv`) must also be picked up, not just `venv`.
        let tmp = crate::os_paths::test_dir("dotvenv-present");
        let inner = if cfg!(target_os = "windows") {
            tmp.join(".venv").join("Scripts")
        } else {
            tmp.join(".venv").join("bin")
        };
        fs::create_dir_all(&inner).unwrap();
        let py = if cfg!(target_os = "windows") {
            inner.join("python.exe")
        } else {
            inner.join("python")
        };
        fs::write(&py, "stub").unwrap();
        let resolved = resolve_comfyui_venv_python(&tmp);
        assert!(resolved.is_some(), "expected resolver to find {}", py.display());
        assert!(resolved.unwrap().contains(".venv"));
    }

    // ── is_real_python (Bug P14 — Microsoft Store stub filter) ──────────────

    #[test]
    fn real_python_rejects_empty() {
        assert!(!is_real_python(""));
    }

    #[test]
    fn real_python_rejects_windowsapps_stub() {
        assert!(!is_real_python("C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe"));
    }

    #[test]
    fn real_python_accepts_real_path() {
        assert!(is_real_python("/usr/bin/python3"));
        assert!(is_real_python("C:\\Python312\\python.exe"));
    }

    // ── get_python_bin wiring (OI-6: BUG-008 resolver was never called) ─────

    /// The install path must never hand out a bare `python3`. Two things break
    /// on it: BUG-008 (a 3.14 with no ML wheels wins over an installed 3.12),
    /// and every consumer that derives a path from the interpreter, because
    /// `Path::new("python3").parent()` is `Some("")` and not a real prefix.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn get_python_bin_returns_an_absolute_interpreter_or_the_empty_sentinel() {
        let bin = get_python_bin();
        if bin.is_empty() {
            // No Python on this box — the documented sentinel, not a failure.
            return;
        }
        let p = Path::new(&bin);
        assert!(p.is_absolute(), "get_python_bin returned a bare name: {bin}");
        assert!(p.exists(), "get_python_bin returned a path that does not exist: {bin}");
        // The regression in one line: a bare name has no usable parent.
        let parent = p.parent().expect("an absolute interpreter has a parent");
        assert!(
            !parent.as_os_str().is_empty(),
            "interpreter prefix is empty, derived paths would be relative: {bin}"
        );
    }

    /// It has to come from the ordered list, not from a fresh probe of its
    /// own — that list IS the BUG-008 fix.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn get_python_bin_picks_a_candidate_from_the_bug_008_order() {
        let bin = get_python_bin();
        if bin.is_empty() {
            return;
        }
        let resolved: Vec<String> = crate::os_paths::unix_python_candidates()
            .iter()
            .filter_map(|n| which::which(n).ok())
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        assert!(
            resolved.contains(&bin),
            "{bin} is not one of the BUG-008 candidates {resolved:?}"
        );
    }

    // ── Windows resolver helpers (Bug B — aldrich "python not installed") ────

    #[cfg(target_os = "windows")]
    #[test]
    fn verify_rejects_stub_and_empty() {
        assert!(!verify_python_path(""));
        assert!(!verify_python_path(
            "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe"
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn scan_python_subdirs_none_for_missing_dir() {
        let missing = std::env::temp_dir().join("lu-no-such-python-dir-zzz");
        let _ = fs::remove_dir_all(&missing);
        assert!(scan_python_subdirs(&missing, "test").is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn scan_python_subdirs_skips_non_python_dirs() {
        // A dir with no Python3xx subfolder yields None (doesn't pick garbage).
        let tmp = std::env::temp_dir().join("lu-pf-scan-test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("NotPython").join("nested")).unwrap();
        assert!(scan_python_subdirs(&tmp, "test").is_none());
        let _ = fs::remove_dir_all(&tmp);
    }
}
