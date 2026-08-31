//! Cross-platform path helpers — Python lookup, LM Studio CLI, common
//! install destinations. Mirrors the path-resolution logic from the old
//! Locally Uncensored Tauri binary.

use std::path::PathBuf;

pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

pub fn data_dir() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("lu-labs")
}

pub fn cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("lu-labs")
}

/// Where the rolling application log is written (`init_tracing` in main.rs,
/// read back by the `log_file_path` command).
///
/// Deliberately NOT Tauri's `app_log_dir()`, for two reasons:
///
/// 1. Lifetime. `app_log_dir()` needs an `AppHandle`, which only exists once
///    `tauri::Builder::build()` has run. Tracing is initialised before that —
///    it has to be, or every line the app emits while starting up (the very
///    window where the hard-to-reproduce failures live) would be written to a
///    subscriber that does not exist yet. The `WorkerGuard` for the file
///    writer has the same problem: it must be created before the first event.
/// 2. Support. `crash.log` already lives in `data_dir()` (crash_report.rs).
///    Putting the rolling log in a sibling folder means one directory holds
///    every artefact a support request needs, instead of the panic record and
///    the log being two unrelated places on three different operating systems.
///
/// macOS:   ~/Library/Application Support/lu-labs/logs
/// Windows: %LOCALAPPDATA%\lu-labs\logs
/// Linux:   ~/.local/share/lu-labs/logs
pub fn log_dir() -> PathBuf {
    data_dir().join("logs")
}

/// Locate a usable Python interpreter. Returns the absolute path to the
/// binary, or `None` if no real Python is on the system.
///
/// On Windows we explicitly skip the WindowsApps stub that opens the
/// Microsoft Store instead of running Python, and every candidate is
/// verified with `--version` before we commit to it — a path that exists
/// but doesn't run (broken uninstall leftovers, the Store stub) must not
/// poison the cached python. Probe order: `where` → the `py -3` launcher
/// (present even when "Add to PATH" was skipped) → `C:\PythonXX` →
/// `C:\Program Files\Python*` (all-users installs) → `%LOCALAPPDATA%`.
pub fn find_python() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        find_python_windows()
    }
    #[cfg(not(target_os = "windows"))]
    {
        for c in unix_python_candidates() {
            if let Ok(p) = which::which(c) {
                return Some(p);
            }
        }
        None
    }
}

#[cfg(target_os = "windows")]
fn find_python_windows() -> Option<PathBuf> {
    python_via_where()
        .or_else(python_via_py_launcher)
        .or_else(python_in_fixed_paths)
        .or_else(python_in_program_files)
        .or_else(python_in_appdata)
}

/// Run a candidate interpreter and confirm it's real (exits 0 — the MS Store
/// stub prints an install nag and exits non-zero).
#[cfg(target_os = "windows")]
fn verify_python_path(path: &str) -> bool {
    if path.is_empty() || path.to_lowercase().contains("windowsapps") {
        return false;
    }
    let mut cmd = std::process::Command::new(path);
    cmd.arg("--version");
    crate::process_util::suppress_window(&mut cmd);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

/// `where python` on PATH, skipping the WindowsApps Store-stub alias.
#[cfg(target_os = "windows")]
fn python_via_where() -> Option<PathBuf> {
    let mut cmd = std::process::Command::new("where");
    cmd.arg("python");
    crate::process_util::suppress_window(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let p = line.trim();
        if !p.is_empty() && verify_python_path(p) {
            return Some(PathBuf::from(p));
        }
    }
    None
}

/// The Windows `py -3` launcher (C:\Windows\py.exe) is installed system-wide
/// by the python.org installer regardless of the "Add to PATH" checkbox and
/// the install dir, so it finds Pythons that `where` + fixed-path scans miss.
/// We ask Python for its own `sys.executable` so we return the concrete
/// python.exe (needed for venv creation / pip), not the launcher shim.
#[cfg(target_os = "windows")]
fn python_via_py_launcher() -> Option<PathBuf> {
    let mut cmd = std::process::Command::new("py");
    cmd.args(["-3", "-c", "import sys; print(sys.executable)"]);
    crate::process_util::suppress_window(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if verify_python_path(&path) {
        Some(PathBuf::from(path))
    } else {
        None
    }
}

/// Standard single-version python.org install dirs at the drive root.
#[cfg(target_os = "windows")]
fn python_in_fixed_paths() -> Option<PathBuf> {
    for ver in ["313", "312", "311", "310", "39"] {
        let p = PathBuf::from(format!("C:\\Python{ver}\\python.exe"));
        if p.exists() && verify_python_path(&p.to_string_lossy()) {
            return Some(p);
        }
    }
    None
}

/// All-users python.org installs land in `C:\Program Files\PythonXX` (and the
/// 32-bit build under Program Files (x86)) — invisible to `where` when "Add
/// to PATH" was skipped.
#[cfg(target_os = "windows")]
fn python_in_program_files() -> Option<PathBuf> {
    for env_key in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Ok(base) = std::env::var(env_key) {
            if let Some(p) = scan_python_subdirs(std::path::Path::new(&base)) {
                return Some(p);
            }
        }
    }
    None
}

/// Per-user python.org installs: `%LOCALAPPDATA%\Programs\Python\Python3xx`.
#[cfg(target_os = "windows")]
fn python_in_appdata() -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    scan_python_subdirs(&std::path::Path::new(&local).join("Programs").join("Python"))
}

/// Scan `base` for `Python*\python.exe`, newest version first, verifying each
/// candidate actually runs before returning it.
#[cfg(target_os = "windows")]
fn scan_python_subdirs(base: &std::path::Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(base).ok()?;
    let mut dirs: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().map(|ft| ft.is_dir()).unwrap_or(false)
                && e.file_name().to_string_lossy().to_lowercase().starts_with("python")
        })
        .collect();
    dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    for dir in dirs {
        let exe = dir.path().join("python.exe");
        if exe.exists() && verify_python_path(&exe.to_string_lossy()) {
            return Some(exe);
        }
    }
    None
}

/// Candidate interpreter names for macOS/Linux, ordered so a known-good minor
/// (3.12 / 3.11 — they have torch/mlx/diffusers wheels) beats a bare `python3`,
/// which on some machines is 3.14, too new for ML wheels (BUG-008). Keeps the
/// video + RAG path on the same interpreter the MLX image install picks.
///
/// `pub(crate)` because the ORDER is the fix, and until 2.6.8 it was reachable
/// only through `find_python`, which returns a single hit. The installer's
/// `python::get_python_bin` and the carcass probe in `commands::process` both
/// need to walk the same list themselves — one to apply its own `--version`
/// gate, the other to collect every interpreter, not just the first.
#[cfg(not(target_os = "windows"))]
pub(crate) fn unix_python_candidates() -> [&'static str; 5] {
    ["python3.12", "python3.11", "python3.13", "python3", "python"]
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod python_candidate_tests {
    #[cfg(not(target_os = "windows"))]
    use super::unix_python_candidates;

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn prefers_3_12_and_3_11_over_bare_python3() {
        let c = unix_python_candidates();
        let i312 = c.iter().position(|x| *x == "python3.12").unwrap();
        let i311 = c.iter().position(|x| *x == "python3.11").unwrap();
        let i3 = c.iter().position(|x| *x == "python3").unwrap();
        assert!(
            i312 < i3 && i311 < i3,
            "must prefer python3.12/3.11 over a bare python3 (BUG-008)"
        );
    }

    // ── Windows resolver (upstream 68de216) ─────────────────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn verify_rejects_stub_and_empty() {
        assert!(!super::verify_python_path(""));
        assert!(!super::verify_python_path(
            "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe"
        ));
        assert!(!super::verify_python_path("C:\\no\\such\\python.exe"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn scan_python_subdirs_prefers_newest_and_verifies() {
        // A dir tree with a fake (non-runnable) python.exe: exists() passes
        // but --version fails → the scan must reject it, not return it blind.
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path().join("Python312");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("python.exe"), b"not a real exe").unwrap();
        assert!(super::scan_python_subdirs(tmp.path()).is_none());
    }

    #[test]
    fn find_python_returns_verified_or_none() {
        // Cross-platform smoke: whatever comes back must exist on disk.
        if let Some(p) = super::find_python() {
            assert!(p.exists(), "find_python returned a non-existent path: {p:?}");
        }
    }
}

/// Look for the LM Studio CLI (`lms`). Three locations:
/// 1. Post-bootstrap install (`~/.lmstudio/bin/lms`)
/// 2. Pre-bootstrap (Windows package layout)
/// 3. PATH
pub fn find_lms_cli() -> Option<PathBuf> {
    let ext = if cfg!(target_os = "windows") { ".exe" } else { "" };
    let post = home().join(".lmstudio").join("bin").join(format!("lms{ext}"));
    if post.exists() {
        return Some(post);
    }
    if cfg!(target_os = "windows") {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let pre = PathBuf::from(local)
                .join("Programs")
                .join("LM Studio")
                .join("resources")
                .join("app")
                .join(".webpack")
                .join("lms.exe");
            if pre.exists() {
                return Some(pre);
            }
        }
    }
    which::which("lms").ok()
}

/// macOS Spotlight lookup for an app bundle by its on-disk name (e.g.
/// "LM Studio.app"). Finds installs buried in deep or hidden folders that PATH
/// and the fixed /Applications check miss — people drop apps in the weirdest
/// nested places. No-op (None) off macOS.
fn spotlight_app(fs_name: &str) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("mdfind")
            .arg(format!("kMDItemFSName == '{fs_name}'"))
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| PathBuf::from(l.trim()))
            .find(|p| p.exists())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = fs_name;
        None
    }
}

/// Locate the LM Studio app bundle anywhere on disk: the standard install dirs
/// first, then Spotlight for hidden / deeply-nested installs.
pub fn find_lmstudio_app() -> Option<PathBuf> {
    for p in [
        PathBuf::from("/Applications/LM Studio.app"),
        home().join("Applications").join("LM Studio.app"),
    ] {
        if p.exists() {
            return Some(p);
        }
    }
    spotlight_app("LM Studio.app")
}

/// Is LM Studio installed anywhere — the `lms` CLI or the app bundle?
pub fn lmstudio_installed() -> bool {
    find_lms_cli().is_some() || find_lmstudio_app().is_some()
}

/// Locate the Ollama app bundle anywhere on disk (fixed dirs, then Spotlight).
pub fn find_ollama_app() -> Option<PathBuf> {
    for p in [
        PathBuf::from("/Applications/Ollama.app"),
        home().join("Applications").join("Ollama.app"),
    ] {
        if p.exists() {
            return Some(p);
        }
    }
    spotlight_app("Ollama.app")
}

/// Locate the `ollama` CLI binary: PATH, common prefixes, then inside a
/// discovered Ollama.app bundle.
pub fn find_ollama_bin() -> Option<PathBuf> {
    if let Ok(p) = which::which("ollama") {
        return Some(p);
    }
    for c in [
        "/opt/homebrew/bin/ollama",
        "/usr/local/bin/ollama",
        "/usr/bin/ollama",
    ] {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    if let Some(app) = find_ollama_app() {
        for rel in [
            "Contents/Resources/ollama",
            "Contents/MacOS/Ollama",
            "Contents/MacOS/ollama",
        ] {
            let p = app.join(rel);
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

/// Is Ollama installed anywhere — CLI binary or app bundle?
pub fn ollama_installed() -> bool {
    find_ollama_bin().is_some() || find_ollama_app().is_some()
}

/// Reasonable places to look for an existing ComfyUI install.
pub fn comfyui_search_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let h = home();
    out.push(h.clone());
    out.push(h.join("Desktop"));
    out.push(h.join("Documents"));
    out.push(h.join("Downloads"));
    if cfg!(target_os = "windows") {
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            out.push(PathBuf::from(user_profile.clone()).join("StabilityMatrix"));
            out.push(PathBuf::from(user_profile).join("Packages"));
        }
    }
    out
}

/// Default ComfyUI install target — where install_comfyui will drop the
/// portable bundle on Windows / clone the repo on macOS+Linux.
pub fn default_comfyui_dir() -> PathBuf {
    data_dir().join("ComfyUI")
}
