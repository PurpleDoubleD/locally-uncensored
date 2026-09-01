//! Die beiden Sprachhälften nachinstallieren: Zuhören und Sprechen.
//!
//! Der geteilte Zustand ist der Interpreter, in den beide gehen. faster-whisper
//! und Piper werden in DENSELBEN Python installiert, den `resolve_lu_python`
//! liefert — in aller Regel ComfyUIs venv — und aus genau diesem Python
//! werden sie später auch gestartet. Fällt das auseinander, ist der Import
//! zur Laufzeit nicht da, obwohl die Installation gemeldet hat, sie sei
//! fertig.
//!
//! Deshalb stehen sie zusammen und nicht bei ihren jeweiligen Funktionen.
//! Beide brauchen denselben PEP-668-Ausweg, wenn der Zielpython doch der des
//! Systems ist; beide melden ihren Fehler im `error`-Feld und nicht nur im
//! Log, weil die Oberfläche sonst ein blankes "Install failed." zeigt; und
//! beide sind die Mitfahrer, die `venv::detect_venv_passengers` aufzählt und
//! die ComfyUI-Reparatur wieder einsetzen muss.

use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::{Manager, State};
use tracing::{error, info};

use crate::state::AppState;

use super::pip::pip_install_streaming_with_retry_cancellable;
use super::venv::{is_pep668_protected, resolve_lu_python};
#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

// ── Whisper (faster-whisper) installer (§24.9 — STT install affordance) ──────

/// The pip args to install faster-whisper. Extracted as a pure helper so the
/// exact invocation is unit-testable (and so the package name lives in one
/// place — the STT backend `whisper_server.py` imports `faster_whisper`, so
/// that's what we install). Mirrors the flags the ComfyUI installer uses:
/// `--no-input` (never block on a prompt) and `--progress-bar off` (the live
/// pip bars are noise in our log stream).
fn build_whisper_pip_args() -> Vec<&'static str> {
    vec![
        "-m", "pip", "install",
        "--progress-bar", "off",
        "--no-input",
        "faster-whisper",
    ]
}

/// §24.9 — Install faster-whisper so STT works, then start the persistent
/// whisper server so the Settings STT badge flips ✗ → ✓ without a restart.
///
/// Installs into the SAME Python the rest of LU's Python tooling uses: the
/// ComfyUI venv when one exists (matches `install_custom_node` /
/// `start_comfyui`), else the resolved system Python. The whisper server is
/// then started with that exact interpreter — critical, because starting it
/// with a different Python than we installed into would fail the
/// `import faster_whisper` check and leave the badge red.
#[tauri::command]
pub fn install_whisper(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    {
        let mut install = state.whisper_install.lock().unwrap();
        if install.status == "installing" {
            return Ok(serde_json::json!({"status": "already_installing"}));
        }
        install.status = "installing".to_string();
        install.logs.clear();
        install.logs.push("Starting faster-whisper installation...".to_string());
    }

    info!("whisper install start");

    // Resolve the target Python: ComfyUI venv (if present) → system Python,
    // re-resolving a stale cache (Bug B8 — Python installed after launch).
    let target_python = resolve_lu_python(state.inner());

    if target_python.is_empty() || !crate::python::is_real_python(&target_python) {
        let mut install = state.whisper_install.lock().unwrap();
        install.status = "error".to_string();
        install.logs.push(
            "No Python found. Install Python first (Settings → ComfyUI → Install Python), \
             then retry the Whisper install."
                .to_string(),
        );
        error!("whisper install aborted: no usable python");
        return Err("no_python: Python must be installed before faster-whisper.".to_string());
    }

    let install_state = state.whisper_install.clone();
    let whisper = state.whisper.clone();

    std::thread::spawn(move || {
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = install_state.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        update("installing", &format!("Installing faster-whisper via {} (this can take a few minutes)…", target_python));

        let mut args = build_whisper_pip_args();
        // Arch / Debian 12+ / Fedora 38+ system Python is PEP 668 protected, so a
        // bare `pip install` dies with externally-managed-environment. When that's
        // the target (no ComfyUI venv absorbed it), install into the user site
        // with the escape hatch so STT installs there too (joerack, Arch). No-op
        // on Windows/macOS/venv Pythons (not PEP 668 protected).
        if is_pep668_protected(&target_python) {
            args.push("--break-system-packages");
            args.push("--user");
        }
        // No cancel flag — this single pip install is short relative to the
        // ComfyUI PyTorch download, so we run it to completion like install_python.
        match pip_install_streaming_with_retry_cancellable(&args, &target_python, 3, &install_state, None) {
            Ok(()) => {
                update("installing", "faster-whisper installed. Starting the speech-to-text server…");
                // Start the persistent server with the SAME Python we installed
                // into, so the import check passes and whisper_status flips to
                // available without an app restart. auto_start_whisper_sync
                // re-checks `import faster_whisper` and locates whisper_server.py
                // from bundled resources (prod) or ./public (dev).
                {
                    let already_running = whisper.lock().map(|w| w.ready).unwrap_or(false);
                    if !already_running {
                        let _ = crate::commands::whisper::auto_start_whisper_sync(&app, &target_python, &whisper);
                    }
                }
                let started = whisper.lock().map(|w| w.ready).unwrap_or(false);
                if started {
                    update("complete", "Speech-to-text is ready.");
                } else {
                    // Install succeeded but the server didn't come up (e.g. model
                    // download still pending). Still a success for the install
                    // itself — the badge re-check / next launch will pick it up.
                    update("complete", "faster-whisper installed. The STT server will finish loading shortly (or on next launch).");
                }
            }
            Err(diagnosis) => {
                let err = format!("faster-whisper installation failed.\n\n{}", diagnosis);
                println!("[Whisper Install] {}", err);
                update("error", &err);
            }
        }
    });

    Ok(serde_json::json!({"status": "installing"}))
}

/// §24.9 — Poll the faster-whisper install progress (mirrors the other
/// `*_status` commands). The frontend re-runs `checkWhisperAvailable` when
/// this reports `complete`.
#[tauri::command]
pub fn install_whisper_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.whisper_install.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
        // The frontend shows `error` verbatim; without it every failure read
        // as a bare "Install failed." while the diagnosis sat in `logs`.
        "error": if install.status == "error" { install.logs.last().cloned() } else { None },
        "download_progress": install.download_progress,
        "download_total": install.download_total,
        "download_speed": install.download_speed,
    }))
}

/// pip args to install Piper TTS. `piper-tts` ships the `piper` CLI + the
/// `piper.download_voices` helper. Same flags as the whisper installer.
fn build_tts_pip_args() -> Vec<&'static str> {
    vec![
        "-m", "pip", "install",
        "--progress-bar", "off",
        "--no-input",
        "piper-tts",
    ]
}

/// Install Piper (neural TTS) into LU's Python, then download the default voice
/// model into `<app_data>/piper_voices/`. Mirrors `install_whisper`. Progress
/// is polled via `install_tts_status`; `tts_status` reports usability.
#[tauri::command]
pub fn install_tts(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    {
        let mut install = state.tts_install.lock().unwrap();
        if install.status == "installing" {
            return Ok(serde_json::json!({"status": "already_installing"}));
        }
        install.status = "installing".to_string();
        install.logs.clear();
        install.logs.push("Starting neural TTS (Piper) installation...".to_string());
    }

    info!("tts install start");

    let target_python = resolve_lu_python(state.inner());
    if target_python.is_empty() || !crate::python::is_real_python(&target_python) {
        let mut install = state.tts_install.lock().unwrap();
        install.status = "error".to_string();
        install.logs.push(
            "No Python found. Install Python first (Settings → ComfyUI → Install Python), \
             then retry the neural TTS install."
                .to_string(),
        );
        error!("tts install aborted: no usable python");
        return Err("no_python: Python must be installed before Piper TTS.".to_string());
    }

    let voices_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {}", e))?
        .join("piper_voices");

    let install_state = state.tts_install.clone();

    std::thread::spawn(move || {
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = install_state.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        // When `piper.download_voices` already imports (package AND its deps),
        // pip would only re-resolve pins — and that upgrade can collide with a
        // python process using the same site-packages: live repro 2026-07-31
        // (Windows), the app's own running ComfyUI held onnxruntime's DLL and
        // pip died on WinError 5, so read-aloud never got its voice. All that
        // is actually missing then is the voice file — go straight to it.
        let piper_ready = {
            let mut probe = Command::new(&target_python);
            probe
                .args(["-c", "import piper.download_voices"])
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(target_os = "windows")]
            probe.creation_flags(CREATE_NO_WINDOW);
            probe.status().map(|s| s.success()).unwrap_or(false)
        };

        let pip_result = if piper_ready {
            update("installing", "piper-tts is already installed — skipping pip.");
            Ok(())
        } else {
            update(
                "installing",
                &format!("Installing piper-tts via {} (this can take a few minutes)…", target_python),
            );
            let mut args = build_tts_pip_args();
            // PEP 668 escape hatch (Arch / Debian 12+ / Fedora 38+) — see
            // install_whisper. No-op on Windows/macOS/venv Pythons.
            if is_pep668_protected(&target_python) {
                args.push("--break-system-packages");
                args.push("--user");
            }
            pip_install_streaming_with_retry_cancellable(&args, &target_python, 3, &install_state, None)
        };
        match pip_result {
            Ok(()) => {
                update(
                    "installing",
                    &format!(
                        "piper-tts installed. Downloading the {} voice (~63 MB)…",
                        crate::commands::tts::PIPER_VOICE
                    ),
                );
                let _ = std::fs::create_dir_all(&voices_dir);
                let mut cmd = Command::new(&target_python);
                cmd.args([
                    "-m",
                    "piper.download_voices",
                    crate::commands::tts::PIPER_VOICE,
                    "--download-dir",
                    &voices_dir.to_string_lossy(),
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
                #[cfg(target_os = "windows")]
                cmd.creation_flags(CREATE_NO_WINDOW);
                match cmd.output() {
                    Ok(o) if o.status.success() => {
                        update("complete", "Neural TTS is ready.");
                    }
                    Ok(o) => {
                        update(
                            "error",
                            &format!("Voice download failed:\n{}", String::from_utf8_lossy(&o.stderr)),
                        );
                    }
                    Err(e) => {
                        update("error", &format!("Voice download could not start: {}", e));
                    }
                }
            }
            Err(diagnosis) => {
                let err = format!("piper-tts installation failed.\n\n{}", diagnosis);
                println!("[TTS Install] {}", err);
                update("error", &err);
            }
        }
    });

    Ok(serde_json::json!({"status": "installing"}))
}

/// Poll the Piper-TTS install progress (mirrors `install_whisper_status`).
#[tauri::command]
pub fn install_tts_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.tts_install.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
        // Same contract as install_whisper_status: the frontend reads `error`.
        "error": if install.status == "error" { install.logs.last().cloned() } else { None },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── §24.9 — Whisper pip args builder ──────────────────────────────────

    #[test]
    fn whisper_pip_args_install_faster_whisper() {
        let args = build_whisper_pip_args();
        // Drives `python -m pip install … faster-whisper` — the package the
        // STT backend (whisper_server.py) actually imports.
        assert_eq!(&args[..3], &["-m", "pip", "install"]);
        assert!(args.contains(&"faster-whisper"), "must install faster-whisper: {:?}", args);
        // Non-interactive + quiet progress, matching the ComfyUI installer.
        assert!(args.contains(&"--no-input"), "must pass --no-input: {:?}", args);
        let pos = args.iter().position(|a| *a == "--progress-bar");
        assert!(pos.is_some(), "must set --progress-bar: {:?}", args);
        assert_eq!(args[pos.unwrap() + 1], "off");
        // The package name is the LAST arg (after all flags) so pip parses it
        // as the install target, not as a flag value.
        assert_eq!(*args.last().unwrap(), "faster-whisper");
    }

}
