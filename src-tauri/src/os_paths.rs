//! Cross-platform path helpers — Python lookup, LM Studio CLI, common
//! install destinations. Mirrors the path-resolution logic from the old
//! Locally Uncensored Tauri binary.
//!
//! Jeder app-eigene Verzeichnisname kommt aus [`crate::app_identity`] und wird
//! hier NICHT noch einmal als Literal geschrieben. Auf diesem Branch trägt er
//! einen Suffix, damit der Experiment-Build die Daten der echten App weder
//! liest noch überschreibt — die Begründung steht in `app_identity`.

use crate::app_identity::{AGENT_WORKSPACE_DIR, APP_CONFIG_DIR, APP_DIR, APP_DISPLAY_DIR};
use std::path::PathBuf;

pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

pub fn data_dir() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DIR)
}

pub fn cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DIR)
}

/// `config_dir()`-Zweig desselben Verzeichnisses. Unter macOS/Windows fällt er
/// mit [`data_dir`] zusammen, unter Linux ist es `~/.config/<APP_DIR>` — dort
/// liegen die erzeugten Bilder (`commands::mlx`) und Videos
/// (`commands::video`).
pub fn config_root() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DIR)
}

/// Ordner der `config.json` (ComfyUI-Pfad/-Port, Ollama-Basis, Trainer-Root).
/// Historisch ein anderer Name als [`data_dir`] — deshalb eine eigene
/// Konstante statt eines zweiten Literals.
pub fn app_config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_CONFIG_DIR)
}

/// Die `config.json` selbst.
pub fn app_config_json() -> PathBuf {
    app_config_dir().join("config.json")
}

/// Ablage für Hilfsbinaries, die die App selbst herunterlädt (`cloudflared`).
pub fn tools_bin_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_CONFIG_DIR)
        .join("bin")
}

/// Modellordner der eingebauten Engine. Bewusst `dirs::data_dir()` (unter
/// Windows also `%APPDATA%`, nicht `%LOCALAPPDATA%`) — das ist der Pfad, den
/// `detect_model_path("builtin")` seit jeher zurückgibt.
pub fn builtin_models_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DISPLAY_DIR)
        .join("models")
}

/// Sandkasten-Wurzel der Agenten. Pro Chat entsteht darin ein Unterordner;
/// `commands::filesystem::contain_within` lässt nichts darüber hinaus.
pub fn agent_workspace_root() -> PathBuf {
    home().join(AGENT_WORKSPACE_DIR)
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
/// macOS:   ~/Library/Application Support/<APP_DIR>/logs
/// Windows: %LOCALAPPDATA%\<APP_DIR>\logs
/// Linux:   ~/.local/share/<APP_DIR>/logs
///
/// `<APP_DIR>` ist `lu-labs` in der echten App und trägt auf diesem Branch
/// einen Suffix — siehe [`crate::app_identity`].
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
/// FINDING (clippy paydown, 01.09.2026): nothing in this repository calls this —
/// not the Rust side, not a `#[tauri::command]` wrapper, not the frontend. It is
/// kept rather than deleted because deleting a detection helper is a product
/// decision, not a lint decision; the `allow` is here so the rest of the crate
/// can run under `-D warnings` while that decision is pending. Wire it or drop
/// it, but do not leave it in this state indefinitely.
#[allow(dead_code)]
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
/// FINDING (clippy paydown, 01.09.2026): nothing in this repository calls this —
/// not the Rust side, not a `#[tauri::command]` wrapper, not the frontend. It is
/// kept rather than deleted because deleting a detection helper is a product
/// decision, not a lint decision; the `allow` is here so the rest of the crate
/// can run under `-D warnings` while that decision is pending. Wire it or drop
/// it, but do not leave it in this state indefinitely.
#[allow(dead_code)]
pub fn ollama_installed() -> bool {
    find_ollama_bin().is_some() || find_ollama_app().is_some()
}

/// Reasonable places to look for an existing ComfyUI install.
/// FINDING (clippy paydown, 01.09.2026): nothing in this repository calls this —
/// not the Rust side, not a `#[tauri::command]` wrapper, not the frontend. It is
/// kept rather than deleted because deleting a detection helper is a product
/// decision, not a lint decision; the `allow` is here so the rest of the crate
/// can run under `-D warnings` while that decision is pending. Wire it or drop
/// it, but do not leave it in this state indefinitely.
#[allow(dead_code)]
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
/// Only the path-inventory test in `app_identity.rs` calls this today — no
/// production caller is left, so it is dead in the `bin` target and alive in the
/// `test` one. Same standing decision as the helpers above.
#[allow(dead_code)]
pub fn default_comfyui_dir() -> PathBuf {
    data_dir().join("ComfyUI")
}

// ── Testwurzeln ───────────────────────────────────────────────────────────

/// Basis für die Wegwerf-Verzeichnisse der Tests.
///
/// Unter macOS/Linux ist das weiterhin `std::env::temp_dir()`: dort liegt temp
/// bei `/var/folders/…` bzw. `/tmp`, also ausserhalb von `$HOME` — nichts
/// ändert sich.
///
/// Unter WINDOWS darf es `std::env::temp_dir()` NICHT sein, und das ist der
/// ganze Grund, warum diese Funktion existiert. Dort ist temp
/// `%LOCALAPPDATA%\Temp` == `C:\Users\<user>\AppData\Local\Temp`, und `AppData`
/// steht in `commands::filesystem::forbidden_root_prefixes()` als PRÄFIX auf
/// der Sperrliste — darunter liegen Browserprofile, Token und Zugangsdaten,
/// und genau die zu sperren ist der Zweck der Wurzel-Härtung. Damit ist jede
/// Testwurzel unter `temp_dir()` "Not an allowed workspace folder", und
/// `allow_root_for_test` paniert, bevor der Test überhaupt anfängt. Die Regel
/// ist richtig, der ORT der Testverzeichnisse war es nicht — wer das hier auf
/// `temp_dir()` zurückdreht, macht 15 Windows-Tests wieder rot.
///
/// Der Ersatz ist das `target`-Verzeichnis der Kiste: es liegt im Repo (also
/// im Benutzerprofil, aber NICHT unter `AppData` — von der Regel ausdrücklich
/// erlaubt, weil `forbidden_exact_roots()` `C:\Users` und `$HOME` nur EXAKT
/// sperrt), ist beschreibbar, gitignoriert und gehört ohnehin zum Build.
/// Echte Nutzerverzeichnisse (`Documents`, `Desktop`) kommen nicht in Frage:
/// Tests schreiben nicht dorthin, wo der Nutzer arbeitet.
#[cfg(test)]
pub(crate) fn test_scratch_root() -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("lu-test-scratch")
    }
    #[cfg(not(windows))]
    {
        std::env::temp_dir()
    }
}

/// Ein Wegwerf-Testverzeichnis, das sich beim Verlassen selbst wieder abräumt.
///
/// Der Aufräum-Schritt hängt am `Drop`, nicht an einer letzten Zeile im Test:
/// ein `let _ = fs::remove_dir_all(…)` am Ende läuft bei einem gescheiterten
/// `assert!` nie, und unter `target/` bliebe der Rest liegen.
#[cfg(test)]
#[derive(Debug)]
pub(crate) struct TestDir(PathBuf);

#[cfg(test)]
impl std::ops::Deref for TestDir {
    type Target = std::path::Path;
    fn deref(&self) -> &std::path::Path {
        &self.0
    }
}

#[cfg(test)]
impl AsRef<std::path::Path> for TestDir {
    fn as_ref(&self) -> &std::path::Path {
        &self.0
    }
}

#[cfg(test)]
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Legt ein frisches, leeres Testverzeichnis unter [`test_scratch_root`] an.
///
/// Der Name trägt Prozess-ID und ThreadId — dieselbe Machart wie die
/// `lu-…-<pid>-<thread>`-Namen, die im Bestand schon so gebaut waren —, damit
/// parallel laufende Tests sich nicht in dasselbe Verzeichnis setzen.
#[cfg(test)]
pub(crate) fn test_dir(tag: &str) -> TestDir {
    let thread: String = format!("{:?}", std::thread::current().id())
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect();
    let path = test_scratch_root().join(format!("lu-{}-{}-{}", tag, std::process::id(), thread));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).expect("Testverzeichnis anlegen");
    TestDir(path)
}
