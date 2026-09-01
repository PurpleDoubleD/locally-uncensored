//! Ob auf dieser Maschine ein git liegt, mit dem sich klonen lässt.
//!
//! Der geteilte Zustand ist die Ausgabe von `git --version` und was drei
//! verschiedene Aufrufer daraus schließen. Die ComfyUI-Installation, das
//! Update und der Custom-Node-Install klonen alle, und alle drei brauchen
//! dieselbe Unterscheidung: fehlt git ganz, oder liegt ein nicht-natives
//! (WSL-, MSYS-) git zuerst im PATH, das den Klon erst anfängt und dann an
//! Windows-Pfaden stirbt.
//!
//! Die Naht liegt zwischen dem Absetzen des Prozesses und der Deutung seiner
//! Ausgabe: `windows_git_probe_from_output` ist rein und bleibt auf jedem
//! Betriebssystem übersetzt, damit die Windows-Einstufung auf dem Rechner
//! prüfbar bleibt, auf dem entwickelt wird. `check_git_installed` sitzt
//! daneben, weil die Codex-Ansicht dieselbe Sonde für ihr eigenes Banner
//! braucht — dieselbe Frage, anderer Adressat.

use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

/// Bug N — git probe before ComfyUI install (juliandiggins-stack issue #40).
///
/// On Windows the in-app ComfyUI install + custom-node install both shell out
/// to `git clone`. The previous spawn-error guard only catches a flat
/// "git not on PATH" — but on a Windows machine where a WSL / Linux-mounted
/// git binary is first on PATH, `git --version` succeeds and clone *starts*,
/// then dies because the Linux binary can't handle Windows-style target paths.
/// juliandiggins-stack hit this on v2.4.5: clone silently fails, user gets
/// a half-installed ComfyUI with no actionable hint.
///
/// Probe at start of every clone path, classify, and surface the right hint:
/// Missing → "install Git for Windows", NonNative → "WSL/non-native git on
/// PATH may break Windows-path clones", Native → proceed.
#[derive(Debug, Clone, PartialEq, Eq)]
/// Dead on every non-Windows target and deliberately so: the only production
/// caller is `windows_git_probe`, which needs `CommandExt::creation_flags` and
/// therefore cannot be compiled off Windows. Keeping THIS half uncfg'd is what
/// lets the unit tests below prove the Windows classification on a macOS run.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub enum WindowsGitState {
    /// `git --version` failed to run (not installed or not on PATH).
    Missing,
    /// `git version 2.x.x.windows.y` — Git for Windows. Clone will work.
    Native,
    /// `git --version` ran but output doesn't include the `.windows` tag —
    /// could be WSL git, MSYS git, Cygwin git, or something else. May work,
    /// may break on Windows paths. Surface a soft warning, proceed anyway.
    NonNative,
}

/// Pure helper for testability. Classifies a `git --version` invocation
/// from its stdout (trimmed) plus the spawn/exit status.
/// Dead on every non-Windows target and deliberately so: the only production
/// caller is `windows_git_probe`, which needs `CommandExt::creation_flags` and
/// therefore cannot be compiled off Windows. Keeping THIS half uncfg'd is what
/// lets the unit tests below prove the Windows classification on a macOS run.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn windows_git_probe_from_output(stdout: &str, exited_successfully: bool) -> WindowsGitState {
    if !exited_successfully {
        return WindowsGitState::Missing;
    }
    let lower = stdout.to_lowercase();
    if !lower.starts_with("git version") {
        // Some non-git binary on PATH that responded to --version with garbage.
        return WindowsGitState::Missing;
    }
    if lower.contains(".windows") {
        WindowsGitState::Native
    } else {
        WindowsGitState::NonNative
    }
}

/// Run `git --version` and classify. Only meaningful on Windows; on other
/// platforms a stock `git` is fine.
#[cfg(target_os = "windows")]
pub fn windows_git_probe() -> WindowsGitState {
    let mut cmd = Command::new("git");
    cmd.arg("--version").creation_flags(CREATE_NO_WINDOW);
    match cmd.output() {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout).trim().to_string();
            windows_git_probe_from_output(&stdout, true)
        }
        _ => WindowsGitState::Missing,
    }
}

/// User-facing hint for the probed state. Returns `None` for Native (no hint
/// needed). For Missing the hint is fatal; for NonNative it's a soft warning.
/// Dead on every non-Windows target and deliberately so: the only production
/// caller is `windows_git_probe`, which needs `CommandExt::creation_flags` and
/// therefore cannot be compiled off Windows. Keeping THIS half uncfg'd is what
/// lets the unit tests below prove the Windows classification on a macOS run.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn windows_git_install_hint(state: &WindowsGitState) -> Option<String> {
    match state {
        WindowsGitState::Native => None,
        WindowsGitState::Missing => Some(
            "Git is not installed or not on PATH. Install Git for Windows from \
             https://git-scm.com/download/win and restart LU so the new PATH \
             is picked up.".to_string(),
        ),
        WindowsGitState::NonNative => Some(
            "A non-native `git` binary is first on PATH (likely WSL or a Linux \
             mount). It may fail to clone into Windows-style paths. If the \
             ComfyUI install errors out during clone, install Git for Windows \
             from https://git-scm.com/download/win and make sure its `cmd` \
             folder is ahead of any WSL git in your PATH.".to_string(),
        ),
    }
}

/// Git availability for the Codex coding view (v2.5.0). The coding agent shells
/// out to `git` for `git_status`/`git_diff`/`git_commit`/`git_log`, so if git
/// isn't on PATH those tools fail with confusing errors. The Codex view calls
/// this on open and, when git is missing, shows a minimal "Install Git" banner.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GitStatus {
    /// `git --version` ran successfully.
    pub installed: bool,
    /// Windows: Git-for-Windows (clone-safe). Other OS: same as `installed`.
    pub native: bool,
    /// The raw `git --version` line, when available.
    pub version: Option<String>,
    /// User-facing hint when missing / non-native; `None` when all good.
    pub hint: Option<String>,
    /// Platform-correct git download page for the install button.
    pub download_url: String,
}

/// Run `git --version` (no console window on Windows) and return the trimmed
/// stdout line, or `None` if git is missing / failed to run.
fn git_version_string() -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("--version");
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.output() {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            (!s.is_empty()).then_some(s)
        }
        _ => None,
    }
}

/// Platform-correct git download page.
fn git_download_url() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "https://git-scm.com/download/win"
    }
    #[cfg(target_os = "macos")]
    {
        "https://git-scm.com/download/mac"
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        "https://git-scm.com/download/linux"
    }
}

/// Cross-platform git availability check for the Codex view's install banner.
// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread,
// so every millisecond spent here is a frozen window. Same treatment
// `lmstudio_server_status` already got — this one was simply missed.
#[tauri::command]
pub async fn check_git_installed() -> GitStatus {
    tokio::task::spawn_blocking(check_git_installed_blocking)
        .await
        .unwrap_or_else(|e| GitStatus {
            installed: false,
            native: false,
            version: None,
            hint: Some(format!("git probe task failed: {e}")),
            download_url: git_download_url().to_string(),
        })
}

fn check_git_installed_blocking() -> GitStatus {
    let download_url = git_download_url().to_string();
    let version = git_version_string();

    #[cfg(target_os = "windows")]
    {
        let state = windows_git_probe();
        GitStatus {
            installed: state != WindowsGitState::Missing,
            native: state == WindowsGitState::Native,
            version,
            hint: windows_git_install_hint(&state),
            download_url,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let installed = version.is_some();
        GitStatus {
            installed,
            native: installed,
            version,
            hint: if installed {
                None
            } else {
                Some(
                    "Git is not installed or not on PATH. Install it from your \
                     package manager (e.g. `sudo apt install git`, `brew install \
                     git`) or https://git-scm.com/downloads, then restart LU so the \
                     new PATH is picked up."
                        .to_string(),
                )
            },
            download_url,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Bug N — windows_git_probe classification matrix ──────────────────
    //
    // juliandiggins-stack hit a half-installed ComfyUI on Windows because a
    // WSL git on PATH ran the clone but choked on the Windows-style target
    // path. The probe is the gate that should surface a clear hint instead.
    // These tests pin the classification — the actual `git --version` call
    // is integration-only and lives in the live E2E section.

    #[test]
    fn git_probe_native_git_for_windows() {
        // Git for Windows always tags its version with `.windows.<n>`.
        let stdout = "git version 2.43.0.windows.1";
        let state = windows_git_probe_from_output(stdout, true);
        assert_eq!(state, WindowsGitState::Native);
    }

    #[test]
    fn git_probe_native_git_for_windows_recent_build() {
        // Newer Git for Windows builds keep the same tag shape.
        let stdout = "git version 2.45.2.windows.1";
        let state = windows_git_probe_from_output(stdout, true);
        assert_eq!(state, WindowsGitState::Native);
    }

    #[test]
    fn git_probe_wsl_git_is_non_native() {
        // WSL ships stock upstream git — no `.windows` tag.
        let stdout = "git version 2.43.0";
        let state = windows_git_probe_from_output(stdout, true);
        assert_eq!(state, WindowsGitState::NonNative);
    }

    #[test]
    fn git_probe_msys_git_is_non_native() {
        // MSYS2 git: also no `.windows` tag, even though it can sometimes
        // handle Windows paths. We classify as NonNative and let the user
        // decide based on the soft warning.
        let stdout = "git version 2.44.0.msys";
        let state = windows_git_probe_from_output(stdout, true);
        assert_eq!(state, WindowsGitState::NonNative);
    }

    #[test]
    fn git_probe_failed_exit_is_missing() {
        // `git --version` ran but exited non-zero (broken install).
        let state = windows_git_probe_from_output("", false);
        assert_eq!(state, WindowsGitState::Missing);
    }

    #[test]
    fn git_probe_empty_stdout_is_missing() {
        // Spawn succeeded but no output — shouldn't happen with real git.
        let state = windows_git_probe_from_output("", true);
        assert_eq!(state, WindowsGitState::Missing);
    }

    #[test]
    fn git_probe_garbage_output_is_missing() {
        // Some other binary on PATH answered to --version. Treat as missing
        // git (the user wants the *real* git, not whatever-this-is).
        let state = windows_git_probe_from_output("hello world", true);
        assert_eq!(state, WindowsGitState::Missing);
    }

    #[test]
    fn git_probe_case_insensitive_match() {
        // Defensive: real git always emits lowercase "git version", but a
        // theoretical shim could uppercase it. We lower-case before checking.
        let stdout = "GIT VERSION 2.43.0.WINDOWS.1";
        let state = windows_git_probe_from_output(stdout, true);
        assert_eq!(state, WindowsGitState::Native);
    }

    // ── windows_git_install_hint copy ─────────────────────────────────────

    #[test]
    fn git_hint_native_returns_none() {
        // Native git → no hint needed, install proceeds silently.
        assert!(windows_git_install_hint(&WindowsGitState::Native).is_none());
    }

    #[test]
    fn git_hint_missing_mentions_git_scm_download() {
        let hint = windows_git_install_hint(&WindowsGitState::Missing).unwrap();
        let lower = hint.to_lowercase();
        // Must point at the canonical install URL so users can copy-paste.
        assert!(
            lower.contains("git-scm.com/download/win"),
            "Missing hint must point at canonical Git for Windows download: {}",
            hint
        );
        // Must use the word "install" so users understand the action.
        assert!(lower.contains("install"), "got: {}", hint);
    }

    /// LIVE E2E for Bug N — only runs on real Windows hosts because
    /// `windows_git_probe` is `cfg(target_os = "windows")`. Verifies that
    /// the actual `git --version` on the build machine classifies the way
    /// we expect. On a fresh Windows tester box with Git for Windows
    /// installed (the common case), this is `Native` and silent.
    #[cfg(target_os = "windows")]
    #[test]
    fn git_probe_live_on_this_host() {
        let state = windows_git_probe();
        // We can't assert a specific variant — that depends on what's on
        // the build box. But we can assert the result is well-formed and
        // that whatever variant came back the hint is consistent.
        let hint = windows_git_install_hint(&state);
        match state {
            WindowsGitState::Native => assert!(hint.is_none(), "Native must produce no hint"),
            _ => {
                let h = hint.expect("Non-Native states must produce a hint");
                assert!(h.to_lowercase().contains("git-scm.com/download/win"));
            }
        }
        println!("[live E2E] windows_git_probe() on this host returned: {:?}", state);
    }

    #[test]
    fn git_hint_nonnative_warns_about_wsl_and_path() {
        let hint = windows_git_install_hint(&WindowsGitState::NonNative).unwrap();
        let lower = hint.to_lowercase();
        // Must call out the WSL/PATH ordering scenario juliandiggins hit so
        // users know exactly what to check.
        assert!(lower.contains("path"), "NonNative hint must mention PATH: {}", hint);
        assert!(
            lower.contains("wsl") || lower.contains("linux"),
            "NonNative hint should mention WSL or Linux: {}",
            hint
        );
        assert!(lower.contains("git-scm.com/download/win"), "got: {}", hint);
    }

}
