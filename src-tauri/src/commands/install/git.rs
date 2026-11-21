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

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

use crate::process_util::foreign_system_command;

/// Bug N — git probe before ComfyUI install (issue #40).
///
/// On Windows the in-app ComfyUI install + custom-node install both shell out
/// to `git clone`. The previous spawn-error guard only catches a flat
/// "git not on PATH" — but on a Windows machine where a WSL / Linux-mounted
/// git binary is first on PATH, `git --version` succeeds and clone *starts*,
/// then dies because the Linux binary can't handle Windows-style target paths.
/// A user hit this on v2.4.5: clone silently fails, user gets
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
    let mut cmd = foreign_system_command("git");
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
            "Git is not installed. Press Install Git and LU sets up its own Git \
             (about 40 MB, no admin rights needed). Or install Git for Windows from \
             https://git-scm.com/download/win and restart LU.".to_string(),
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
pub(crate) fn git_version_string() -> Option<String> {
    let mut cmd = foreign_system_command("git");
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

/// Linux package manager guess, read from `/etc/os-release`'s `ID` and
/// `ID_LIKE` fields. Both are documented (os-release(5)) to be
/// lowercase-ish identifiers; `ID_LIKE` is a space-separated fallback list
/// for derivatives that do not want to repeat every check their upstream
/// already covers (e.g. Linux Mint carries `ID_LIKE=ubuntu debian`).
/// Dead on every non-Linux target and deliberately so: the only production
/// caller is `git_download_preflight`, which is `cfg(target_os = "linux")`.
/// Keeping this half uncfg'd is what lets the unit tests below prove the
/// distro classification on a macOS run.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxPackageManager {
    Apt,
    Dnf,
    Pacman,
    Zypper,
    Unknown,
}

/// Pure: `/etc/os-release` text in, package manager guess out. Never reads
/// the filesystem itself, so this is exercised directly by unit tests on
/// any host, not only Linux.
///
/// Same token-matching shape as `python.rs`'s `linux_python_install_hint`
/// (exact family tokens out of `ID`/`ID_LIKE`, not a substring search), kept
/// as its own copy here rather than shared: the two hints classify into
/// different, unrelated result sets (a package manager command here, a
/// full install line there) and the pull would cost more than the four
/// duplicated match arms save.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn linux_package_manager_from_os_release(os_release: &str) -> LinuxPackageManager {
    let mut families: Vec<String> = Vec::new();
    for line in os_release.lines() {
        let trimmed = line.trim();
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim().to_lowercase();
        if key != "id" && key != "id_like" {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        for token in value.split_whitespace() {
            families.push(token.to_lowercase());
        }
    }
    let has = |needle: &str| families.iter().any(|f| f == needle);

    if has("debian") || has("ubuntu") || has("linuxmint") || has("pop") || has("elementary") {
        LinuxPackageManager::Apt
    } else if has("fedora") || has("rhel") || has("centos") || has("rocky") || has("almalinux") {
        LinuxPackageManager::Dnf
    } else if has("arch") || has("manjaro") || has("endeavouros") || has("garuda") {
        LinuxPackageManager::Pacman
    } else if has("opensuse") || has("opensuse-tumbleweed") || has("opensuse-leap") || has("suse") || has("sles") {
        LinuxPackageManager::Zypper
    } else {
        LinuxPackageManager::Unknown
    }
}

/// Pure: `/etc/os-release` text in, the English "git is missing" message
/// out, naming the one install command that actually applies on this
/// distro (or, when the distro cannot be classified, all four so the user
/// can pick).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn linux_git_missing_message(os_release: &str) -> String {
    match linux_package_manager_from_os_release(os_release) {
        LinuxPackageManager::Apt => {
            "Git is not installed. Install it first with `sudo apt install git`, then retry."
                .to_string()
        }
        LinuxPackageManager::Dnf => {
            "Git is not installed. Install it first with `sudo dnf install git`, then retry."
                .to_string()
        }
        LinuxPackageManager::Pacman => {
            "Git is not installed. Install it first with `sudo pacman -S git`, then retry."
                .to_string()
        }
        LinuxPackageManager::Zypper => {
            "Git is not installed. Install it first with `sudo zypper install git`, then retry."
                .to_string()
        }
        LinuxPackageManager::Unknown => {
            "Git is not installed. Install it with your distro's package manager, for example \
             `sudo apt install git` (Debian/Ubuntu), `sudo dnf install git` (Fedora/RHEL), \
             `sudo pacman -S git` (Arch), or `sudo zypper install git` (openSUSE), then retry."
                .to_string()
        }
    }
}

/// Pure: the one command that installs git on this distro, for "Install
/// Git" to show and copy (3.1.3). `None` when the distro is not known; the
/// message above then names all four.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn linux_git_command(os_release: &str) -> Option<&'static str> {
    match linux_package_manager_from_os_release(os_release) {
        LinuxPackageManager::Apt => Some("sudo apt install git"),
        LinuxPackageManager::Dnf => Some("sudo dnf install git"),
        LinuxPackageManager::Pacman => Some("sudo pacman -S git"),
        LinuxPackageManager::Zypper => Some("sudo zypper install git"),
        LinuxPackageManager::Unknown => None,
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn read_os_release() -> String {
    std::fs::read_to_string("/etc/os-release").unwrap_or_default()
}

/// Whether `git --version` succeeds, exposed as its own call so a caller
/// that needs the yes/no answer for more than the network preflight (the
/// trainer's archive-then-git fallback, review Runde 2 Nachbesserung 2)
/// probes git exactly once instead of running `git --version` a second
/// time right after `git_download_preflight` already ran it.
pub fn is_git_present() -> bool {
    git_version_string().is_some()
}

/// Pure core of [`git_download_preflight`]: whether git is present in, the
/// hint to abort with (or `None` to proceed) out. Kept separate from the OS
/// probe so the "git missing -> block before any download" behaviour is a
/// plain unit test on every host, not only Linux.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn git_download_preflight_core(is_git_present: bool, os_release: &str) -> Option<String> {
    if is_git_present {
        None
    } else {
        Some(linux_git_missing_message(os_release))
    }
}

/// Cross-platform preflight for every code path that shells out to `git`
/// for a network download (ComfyUI install/update, custom-node
/// install/update, trainer source clone). Only Linux gets a new check
/// here: fresh cloud/desktop images (measured: Debian 13 and Fedora 43
/// Cloud Edition, 2026-09, see e2e/linux/BERICHT-5-APPIMAGE.md) frequently
/// do not ship `git` at all, so a bare `git clone` used to die deep inside
/// the install worker with a generic "No such file or directory" instead
/// of a message that names the exact command to run.
///
/// Windows keeps its own `windows_git_probe`/`windows_git_install_hint`
/// pair (called separately at each site), so this returns `None` there.
/// macOS asks too since 3.1.3 (see below), so "Install Git" can show.
#[cfg(target_os = "linux")]
pub fn git_download_preflight() -> Option<String> {
    git_download_preflight_core(is_git_present(), &read_os_release())
}

/// macOS (3.1.3): without the Command Line Tools `/usr/bin/git` is only a
/// stub that fails, and the clone used to die on its "invalid active
/// developer path". Same sentence head as the other systems, so the
/// interface offers "Install Git" in the same place.
#[cfg(target_os = "macos")]
pub fn git_download_preflight() -> Option<String> {
    (!is_git_present()).then(|| MAC_GIT_MISSING.to_string())
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const MAC_GIT_MISSING: &str = "Git is not installed. Press Install Git: macOS then installs its \
     Command Line Tools, which include Git.";

/// Windows keeps its own probe at each call site (`windows_git_probe`).
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn git_download_preflight() -> Option<String> {
    None
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
    // A user hit a half-installed ComfyUI on Windows because a
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
    fn every_git_missing_sentence_starts_the_same_so_the_button_shows() {
        // src/lib/git-missing.ts finds the sentence by this head.
        let head = "Git is not installed";
        assert!(windows_git_install_hint(&WindowsGitState::Missing).unwrap().starts_with(head));
        assert!(MAC_GIT_MISSING.starts_with(head));
        for os in ["ID=debian", "ID=fedora", "ID=arch", "ID=opensuse", "ID=plan9"] {
            assert!(linux_git_missing_message(os).starts_with(head), "{os}");
        }
        assert!(windows_git_install_hint(&WindowsGitState::Missing).unwrap().contains("Install Git"));
    }

    #[test]
    fn the_linux_command_to_copy_fits_the_distro() {
        assert_eq!(linux_git_command("ID=ubuntu\nID_LIKE=debian"), Some("sudo apt install git"));
        assert_eq!(linux_git_command("ID=fedora"), Some("sudo dnf install git"));
        assert_eq!(linux_git_command("ID=manjaro\nID_LIKE=arch"), Some("sudo pacman -S git"));
        assert_eq!(linux_git_command("ID=opensuse-tumbleweed"), Some("sudo zypper install git"));
        assert_eq!(linux_git_command("ID=plan9"), None);
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
        // Must call out the WSL/PATH ordering scenario a user hit so
        // users know exactly what to check.
        assert!(lower.contains("path"), "NonNative hint must mention PATH: {}", hint);
        assert!(
            lower.contains("wsl") || lower.contains("linux"),
            "NonNative hint should mention WSL or Linux: {}",
            hint
        );
        assert!(lower.contains("git-scm.com/download/win"), "got: {}", hint);
    }

    // ── Linux distro detection: os-release text in, package manager out ───

    #[test]
    fn linux_pm_debian_is_apt() {
        let os_release = "PRETTY_NAME=\"Debian GNU/Linux 13 (trixie)\"\nID=debian\nID_LIKE=\n";
        assert_eq!(
            linux_package_manager_from_os_release(os_release),
            LinuxPackageManager::Apt
        );
    }

    #[test]
    fn linux_pm_ubuntu_is_apt() {
        let os_release = "NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n";
        assert_eq!(
            linux_package_manager_from_os_release(os_release),
            LinuxPackageManager::Apt
        );
    }

    #[test]
    fn linux_pm_debian_derivative_via_id_like_is_apt() {
        // Review Runde 2, B2: the old example here was Linux Mint
        // (ID=linuxmint), but "linuxmint" is itself in the Apt match list,
        // so that test passed even with ID_LIKE completely ignored: it
        // never actually exercised the ID_LIKE path. Zorin OS's own ID is
        // not in any family list; only ID_LIKE carries "ubuntu debian".
        let os_release = "NAME=\"Zorin OS\"\nID=zorin\nID_LIKE=\"ubuntu debian\"\n";
        assert_eq!(
            linux_package_manager_from_os_release(os_release),
            LinuxPackageManager::Apt
        );
    }

    #[test]
    fn linux_pm_fedora_is_dnf() {
        let os_release = "NAME=\"Fedora Linux\"\nID=fedora\nID_LIKE=\n";
        assert_eq!(
            linux_package_manager_from_os_release(os_release),
            LinuxPackageManager::Dnf
        );
    }

    #[test]
    fn linux_pm_rhel_derivative_via_id_like_is_dnf() {
        // Review Runde 2, B2: the old example here was Rocky Linux
        // (ID=rocky), but "rocky" is itself in the Dnf match list, so this
        // test passed even with ID_LIKE completely ignored. Nobara's own ID
        // is not in any family list; only ID_LIKE carries "fedora".
        let os_release = "NAME=\"Nobara Linux\"\nID=nobara\nID_LIKE=fedora\n";
        assert_eq!(
            linux_package_manager_from_os_release(os_release),
            LinuxPackageManager::Dnf
        );
    }

    #[test]
    fn linux_pm_arch_is_pacman() {
        let os_release = "NAME=\"Arch Linux\"\nID=arch\nID_LIKE=\n";
        assert_eq!(
            linux_package_manager_from_os_release(os_release),
            LinuxPackageManager::Pacman
        );
    }

    #[test]
    fn linux_pm_arch_derivative_via_id_like_is_pacman() {
        // Review Runde 2, B2: no Pacman example went through ID_LIKE at
        // all before this. CachyOS's own ID is not in any family list;
        // only ID_LIKE carries "arch".
        let os_release = "NAME=\"CachyOS Linux\"\nID=cachyos\nID_LIKE=arch\n";
        assert_eq!(
            linux_package_manager_from_os_release(os_release),
            LinuxPackageManager::Pacman
        );
    }

    #[test]
    fn linux_pm_opensuse_is_zypper() {
        let os_release = "NAME=\"openSUSE Leap\"\nID=opensuse-leap\nID_LIKE=\"suse opensuse\"\n";
        assert_eq!(
            linux_package_manager_from_os_release(os_release),
            LinuxPackageManager::Zypper
        );
    }

    #[test]
    fn linux_pm_unknown_distro_is_unknown() {
        let os_release = "NAME=\"Some New Distro\"\nID=somenewdistro\nID_LIKE=\n";
        assert_eq!(
            linux_package_manager_from_os_release(os_release),
            LinuxPackageManager::Unknown
        );
    }

    #[test]
    fn linux_pm_missing_os_release_is_unknown() {
        assert_eq!(
            linux_package_manager_from_os_release(""),
            LinuxPackageManager::Unknown
        );
    }

    // ── Linux distro detection: os-release text in, install command out ───

    #[test]
    fn linux_git_missing_message_names_apt_on_debian() {
        let os_release = "ID=debian\n";
        let msg = linux_git_missing_message(os_release);
        assert!(msg.contains("sudo apt install git"), "got: {}", msg);
        assert!(!msg.to_lowercase().contains("dnf"), "got: {}", msg);
    }

    #[test]
    fn linux_git_missing_message_names_dnf_on_fedora() {
        let os_release = "ID=fedora\n";
        let msg = linux_git_missing_message(os_release);
        assert!(msg.contains("sudo dnf install git"), "got: {}", msg);
        assert!(!msg.to_lowercase().contains("apt"), "got: {}", msg);
    }

    #[test]
    fn linux_git_missing_message_names_pacman_on_arch() {
        let os_release = "ID=arch\n";
        let msg = linux_git_missing_message(os_release);
        assert!(msg.contains("sudo pacman -S git"), "got: {}", msg);
    }

    #[test]
    fn linux_git_missing_message_names_zypper_on_opensuse() {
        let os_release = "ID=opensuse-leap\nID_LIKE=\"suse opensuse\"\n";
        let msg = linux_git_missing_message(os_release);
        assert!(msg.contains("sudo zypper install git"), "got: {}", msg);
    }

    #[test]
    fn linux_git_missing_message_names_all_four_when_unknown() {
        let os_release = "ID=somenewdistro\n";
        let msg = linux_git_missing_message(os_release);
        assert!(msg.contains("sudo apt install git"), "got: {}", msg);
        assert!(msg.contains("sudo dnf install git"), "got: {}", msg);
        assert!(msg.contains("sudo pacman -S git"), "got: {}", msg);
        assert!(msg.contains("sudo zypper install git"), "got: {}", msg);
    }

    // ── "git fehlt ergibt die Meldung und es wird nichts geladen" ─────────
    //
    // git_download_preflight_core is the pure decision point every clone
    // site calls through git_download_preflight() before spawning `git
    // clone`/`git pull`. Missing git must produce Some(hint) so the caller
    // returns before touching the network; present git must produce None
    // so the existing flow is untouched.

    #[test]
    fn preflight_blocks_with_hint_when_git_missing() {
        let hint = git_download_preflight_core(false, "ID=debian\n");
        assert_eq!(
            hint,
            Some("Git is not installed. Install it first with `sudo apt install git`, then retry.".to_string())
        );
    }

    #[test]
    fn preflight_allows_download_when_git_present() {
        let hint = git_download_preflight_core(true, "ID=debian\n");
        assert_eq!(hint, None, "git present must not block the download");
    }
}
