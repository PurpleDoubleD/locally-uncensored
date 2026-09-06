//! Einen systemweiten Python beschaffen, bevor irgendetwas anderes anfängt.
//!
//! Der geteilte Zustand sind zwei Schlitze im `AppState`, die zusammengehören:
//! der `InstallState` für den Fortschritt und `python_bin` für das Ergebnis.
//! Alle drei Befehle hier fassen beide an — die Installation füllt sie, die
//! Statusabfrage liest den einen, und `python_check` löst den anderen neu auf,
//! wenn er veraltet ist.
//!
//! Genau dieses Nachauflösen ist der Grund für die Naht. Auf einer frischen
//! Windows-Kiste ist `python.exe` der Store-Platzhalter, der nichts tut außer
//! mit Code 1 zu enden; wird während der Laufzeit ein echter Python
//! nachinstalliert, muss der zwischengespeicherte Pfad aktualisiert werden,
//! sonst meldet LU bis zum nächsten Start "kein Python gefunden". Diese
//! Regel gilt für alle drei Befehle und für keinen außerhalb dieser Datei.
//!
//! `linux_python_install_hint` steht dabei, weil auf Linux gar nicht
//! installiert wird: dort ist die einzige richtige Antwort der passende
//! Befehl für die vorliegende Distribution.

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::State;
use tracing::info;

use crate::os_error;
use crate::state::AppState;

#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

/// Bug I — Linux distro detection for the install_python error hint.
/// Parses `/etc/os-release` line-by-line, collects `ID` and `ID_LIKE`
/// tokens (stripping the quotes that systemd allows around multi-value
/// fields like `ID_LIKE="rhel centos fedora"`), and returns a distro
/// family install command. Pulled out so we can unit test the matching
/// logic without writing to /etc on the test box.
pub fn linux_python_install_hint(os_release: &str) -> String {
    // Collect family tokens from ID and ID_LIKE.
    let mut families: Vec<String> = Vec::new();
    for line in os_release.lines() {
        let trimmed = line.trim();
        let (key, value) = match trimmed.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        let key = key.trim().to_lowercase();
        if key != "id" && key != "id_like" {
            continue;
        }
        // Strip surrounding quotes if present, then split on whitespace
        // (ID_LIKE often carries multiple space-separated tokens).
        let value = value.trim().trim_matches('"').trim_matches('\'');
        for token in value.split_whitespace() {
            families.push(token.to_lowercase());
        }
    }
    let has = |needle: &str| families.iter().any(|f| f == needle);

    if has("arch") || has("manjaro") || has("endeavouros") || has("garuda") {
        "`sudo pacman -S python python-pip`".to_string()
    } else if has("debian") || has("ubuntu") || has("linuxmint") || has("pop") || has("elementary") {
        "`sudo apt install python3 python3-pip python3-venv`".to_string()
    } else if has("fedora") || has("rhel") || has("centos") || has("rocky") || has("almalinux") {
        "`sudo dnf install python3 python3-pip`".to_string()
    } else if has("opensuse") || has("opensuse-tumbleweed") || has("opensuse-leap") || has("suse") || has("sles") {
        "`sudo zypper install python3 python3-pip`".to_string()
    } else {
        "your distro's package manager".to_string()
    }
}

// ── Python Auto-Install (P14: Plug-and-Play, blocking pre-req for ComfyUI) ──
//
// On a fresh Windows box `python.exe` is the Microsoft Store stub at
// `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe` — it prints "Python was
// not found, run without arguments to install from the Microsoft Store" and
// exits 1. That kills `pip install torch ...` 200 ms in, leaves a half-cloned
// ComfyUI dir on disk, and the user sees "ComfyUI not responding". The
// only Plug-and-Play fix for newbies is to install Python ourselves; this is
// what `install_python` does. Same shape as `install_ollama` /
// `install_lmstudio`: kick off a background thread, surface status via a
// shared `InstallState`, and re-resolve `python_bin` once it finishes so
// subsequent `install_comfyui` calls find it without an app restart.

#[tauri::command]
pub fn install_python(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // If Python is already there, short-circuit so the UI can skip the
    // install card and go straight to ComfyUI. is_real_python rejects
    // the empty sentinel and WindowsApps stub paths.
    {
        let current = state.python_bin.lock().unwrap().clone();
        if crate::python::is_real_python(&current) {
            return Ok(serde_json::json!({"status": "already_installed", "path": current}));
        }
    }

    let mut install = state.python_install.lock().unwrap();
    if install.status == "downloading"
        || install.status == "installing"
        || install.status == "starting"
    {
        return Ok(serde_json::json!({"status": "already_installing"}));
    }

    install.status = "installing".to_string();
    install.logs.clear();
    install.download_progress = 0;
    install.download_total = 0;
    install.download_speed = 0.0;
    install
        .logs
        .push("Installing Python 3.12 via winget (~30 MB)…".to_string());
    drop(install);

    info!("python install start");

    let py_state = state.python_install.clone();
    let py_bin_slot = state.python_bin.clone();

    std::thread::spawn(move || {
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = py_state.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        // Bug I (discovered during 2026-05-17 Arch live test): pre-fix
        // install_python unconditionally invoked `winget` which is
        // Windows-exclusive. On Linux that fails with "winget: command
        // not found" and the user gets stuck. In practice every modern
        // Linux distro ships Python in the base group so the install
        // button rarely needs to fire — but when it does, surfacing the
        // right distro-specific install command beats a cryptic spawn
        // error.
        if cfg!(target_os = "linux") {
            let os_release = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
            let suggestion = linux_python_install_hint(&os_release);
            update(
                "error",
                &format!(
                    "Python isn't installed system-wide. On Linux, install it via {} \
                     then click Re-detect. (LU's auto-installer is Windows-only — on \
                     Linux your package manager is the right tool.)",
                    suggestion
                ),
            );
        }
        if cfg!(target_os = "macos") {
            update(
                "error",
                "Python isn't installed system-wide. On macOS, install it via \
                 `brew install python` (Homebrew) or download Python 3.12+ from \
                 https://www.python.org/downloads/macos/ then click Re-detect.",
            );
        }

        // ── The Windows path ────────────────────────────────────────────────
        //
        // Everything below is the winget install. It used to sit behind the two
        // `return`s above, which made rustc call it an `unreachable statement`
        // on macOS and Linux — correct about the control flow, and saying
        // nothing about the code: this is not dead code, it is the OTHER
        // platform's implementation.
        //
        // `if cfg!` and not `#[cfg]`, for the reason `test_support.rs` states at
        // its top: a `#[cfg]` would delete this whole branch from a macOS build,
        // and with it the type-checking of ~150 lines of Windows installer plus
        // the dozen helpers it is the only caller of (`sha256_file`,
        // `installer_size_verdict`, `windows_git_probe_from_output` …), which
        // would then read as dead code here. Compiled-and-never-taken keeps the
        // Windows half honest on the machine this is developed on.
        //
        // The condition is `not(linux or macos)` rather than `windows` so the
        // set of targets that run it is exactly the set that ran it before.
        if !cfg!(any(target_os = "linux", target_os = "macos")) {
                // Stream-friendly winget invocation. `--silent --accept-*-agreements`
                // drops the EULA prompts; without them winget will sit and wait for
                // user input forever inside our background thread. Python.Python.3.12
                // is the canonical winget id for the python.org installer (matches
                // `winget search python` top result).
                update("installing", "Running: winget install Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements");

                let mut cmd = Command::new("winget");
                cmd.args([
                    "install",
                    "Python.Python.3.12",
                    "--silent",
                    "--accept-package-agreements",
                    "--accept-source-agreements",
                    "--scope",
                    "user",
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
                #[cfg(target_os = "windows")]
                cmd.creation_flags(CREATE_NO_WINDOW);

                let child = match cmd.spawn() {
                    Ok(c) => c,
                    Err(e) => {
                        update(
                            "error",
                            &format!(
                                "Could not run winget: {}. winget ships with Windows 10/11 — \
                                 if it's missing, run 'Get App Installer' from the Microsoft \
                                 Store (free) and retry.",
                                e
                            ),
                        );
                        return;
                    }
                };

                // Stream stdout + stderr line-by-line so the UI's log card animates
                // as winget extracts and installs (otherwise it freezes for 1–2 min).
                let mut child = child;
                let stdout = child.stdout.take();
                let stderr = child.stderr.take();
                let stdout_state = py_state.clone();
                let stdout_handle = std::thread::spawn(move || {
                    if let Some(out) = stdout {
                        let reader = BufReader::new(out);
                        for line in reader.lines().map_while(Result::ok) {
                            // winget ist ein fremder Prozess, seine Zeilen
                            // stehen in unserer Fortschrittskarte, und ein
                            // Installationsfehler kommt vom Windows-Installer
                            // in der Systemsprache.
                            let line = os_error::english_child_text(&line).into_owned();
                            let trimmed = line.trim();
                            if !trimmed.is_empty() {
                                if let Ok(mut s) = stdout_state.lock() {
                                    s.logs.push(trimmed.to_string());
                                }
                            }
                        }
                    }
                });
                let stderr_state = py_state.clone();
                let stderr_handle = std::thread::spawn(move || {
                    if let Some(err) = stderr {
                        let reader = BufReader::new(err);
                        for line in reader.lines().map_while(Result::ok) {
                            let line = os_error::english_child_text(&line).into_owned();
                            let trimmed = line.trim();
                            if !trimmed.is_empty() {
                                if let Ok(mut s) = stderr_state.lock() {
                                    s.logs.push(trimmed.to_string());
                                }
                            }
                        }
                    }
                });

                let exit_status = match child.wait() {
                    Ok(s) => s,
                    Err(e) => {
                        update("error", &format!("winget wait failed: {}", os_error::english(&e)));
                        return;
                    }
                };
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();

                if !exit_status.success() {
                    // winget exit codes are HRESULT-shaped; -1978335189 (0x8A150011)
                    // means "no upgrade applicable" which is fine if Python is
                    // already present. Anything else is a real failure.
                    let code = exit_status.code().unwrap_or(-1);
                    // Re-resolve regardless: Python may already be on the box from
                    // a previous install attempt that the original where-scan
                    // missed (e.g. Add-to-PATH was unchecked).
                    let resolved = crate::python::get_python_bin();
                    if crate::python::is_real_python(&resolved) {
                        if let Ok(mut slot) = py_bin_slot.lock() {
                            *slot = resolved.clone();
                        }
                        update(
                            "complete",
                            &format!("Python ready (winget exit {} ignored, Python detected at {})", code, resolved),
                        );
                        return;
                    }
                    update(
                        "error",
                        &format!(
                            "winget exited with code {}. Python was not detected after \
                             install. Try installing manually from python.org with the \
                             'Add Python to PATH' checkbox on, then return here and \
                             click Re-Scan.",
                            code
                        ),
                    );
                    return;
                }

                update("starting", "winget finished. Re-resolving Python…");

                // Give the freshly installed Python a moment to settle (winget can
                // signal completion before the file is fully linked into PATH on
                // some boxes), then re-resolve and persist.
                for attempt in 0..15 {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let resolved = crate::python::get_python_bin();
                    if crate::python::is_real_python(&resolved) {
                        if let Ok(mut slot) = py_bin_slot.lock() {
                            *slot = resolved.clone();
                        }
                        update(
                            "complete",
                            &format!("Python ready at {}", resolved),
                        );
                        return;
                    }
                    println!("[Python] post-install resolve attempt {}/15 — not yet on PATH", attempt + 1);
                }

                update(
                    "error",
                    "winget reported success but Python is still not on PATH. \
                     Restart Locally Uncensored — sometimes Windows needs the new PATH \
                     to take effect. If it still doesn't show up, install manually \
                     from python.org with 'Add Python to PATH' on.",
                );
        }
    });

    Ok(serde_json::json!({"status": "installing"}))
}

#[tauri::command]
pub fn install_python_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.python_install.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
        "download_progress": install.download_progress,
        "download_total": install.download_total,
        "download_speed": install.download_speed,
    }))
}

/// Cheap synchronous probe: is there a real Python on the box?  The frontend
/// calls this before kicking off `install_comfyui` so it can decide whether
/// to show the Python install step first. Returns the resolved path on
/// success so the UI can display it ("Found Python at C:\\…").
#[tauri::command]
pub fn python_check(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let current = state.python_bin.lock().unwrap().clone();
    if crate::python::is_real_python(&current) {
        return Ok(serde_json::json!({"available": true, "path": current}));
    }

    // The slot may have been empty at startup (fresh box) and Python may
    // have been installed since (e.g. via this same install_python flow on
    // another launch). Re-resolve as a refresh.
    let resolved = crate::python::get_python_bin();
    if crate::python::is_real_python(&resolved) {
        if let Ok(mut slot) = state.python_bin.lock() {
            *slot = resolved.clone();
        }
        Ok(serde_json::json!({"available": true, "path": resolved}))
    } else {
        Ok(serde_json::json!({"available": false, "path": null}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Bug I — linux_python_install_hint distro detection ────────────────

    #[test]
    fn linux_hint_arch_via_id_field() {
        let release = "NAME=\"Arch Linux\"\nID=arch\nID_LIKE=archlinux\n";
        let hint = linux_python_install_hint(release);
        assert!(hint.contains("pacman"), "got: {}", hint);
        assert!(hint.contains("python") && hint.contains("pip"));
    }

    #[test]
    fn linux_hint_manjaro_via_id_like_arch() {
        let release = "NAME=\"Manjaro\"\nID=manjaro\nID_LIKE=arch\n";
        let hint = linux_python_install_hint(release);
        assert!(hint.contains("pacman"), "Manjaro should map to Arch family, got: {}", hint);
    }

    #[test]
    fn linux_hint_ubuntu_via_id_like_debian() {
        let release = "NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n";
        let hint = linux_python_install_hint(release);
        assert!(hint.contains("apt"), "got: {}", hint);
        assert!(hint.contains("python3"));
    }

    #[test]
    fn linux_hint_debian_via_id() {
        let release = "NAME=\"Debian GNU/Linux\"\nID=debian\n";
        let hint = linux_python_install_hint(release);
        assert!(hint.contains("apt"), "got: {}", hint);
    }

    #[test]
    fn linux_hint_fedora_via_id() {
        let release = "NAME=\"Fedora Linux\"\nID=fedora\nID_LIKE=\"fedora\"\n";
        let hint = linux_python_install_hint(release);
        assert!(hint.contains("dnf"), "got: {}", hint);
    }

    #[test]
    fn linux_hint_rocky_via_id_like_rhel() {
        let release = "NAME=\"Rocky Linux\"\nID=rocky\nID_LIKE=\"rhel centos fedora\"\n";
        let hint = linux_python_install_hint(release);
        assert!(hint.contains("dnf"), "RHEL-family should suggest dnf, got: {}", hint);
    }

    #[test]
    fn linux_hint_opensuse_via_id_like() {
        let release = "NAME=\"openSUSE Tumbleweed\"\nID=opensuse-tumbleweed\nID_LIKE=\"opensuse suse\"\n";
        let hint = linux_python_install_hint(release);
        assert!(hint.contains("zypper"), "got: {}", hint);
    }

    #[test]
    fn linux_hint_unknown_distro_falls_back() {
        let release = "NAME=\"Some Custom Distro\"\nID=mystery\n";
        let hint = linux_python_install_hint(release);
        assert!(hint.contains("package manager"), "got: {}", hint);
    }

    #[test]
    fn linux_hint_empty_input_falls_back() {
        let hint = linux_python_install_hint("");
        assert!(hint.contains("package manager"));
    }

}
