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

use std::process::Stdio;


use tauri::State;
use tracing::{error, info};

use crate::state::AppState;
use crate::os_error;
use crate::python::python_command;

use super::base_python::machine_or_own;
use super::piper_env;
use super::pip::{pip_install_streaming_with_retry_cancellable, venv_pip_install_streaming_with_retry_cancellable};
use super::venv::{pip_escape_args_for, resolve_lu_python};

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
        // with the escape hatch so STT installs there too (Arch). No-op
        // on Windows/macOS and in any venv, which pip refuses `--user` for.
        args.extend(pip_escape_args_for(&target_python));
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

/// Install Piper (neural TTS) into an environment of its own
/// (`piper_env.rs`, A34 / GitHub #254), then download the default voice model
/// into `<app_data>/piper_voices/`. Progress is polled via
/// `install_tts_status`; `tts_status` reports usability.
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

    // LU's default Python is asked first; it no longer has to exist, LU's own
    // Python stands in when nothing on the machine fits.
    let default_python = resolve_lu_python(state.inner());
    let voices_dir = crate::commands::tts::piper_voices_dir(&app)?;
    let install_state = state.tts_install.clone();

    std::thread::spawn(move || {
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = install_state.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };
        let fail = |msg: &str| {
            println!("[TTS Install] {}", msg);
            update("error", msg);
        };
        let imports = |py: &str| {
            let mut probe = python_command(py);
            probe
                .args(["-c", "import piper.download_voices"])
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            probe.status().map(|s| s.success()).unwrap_or(false)
        };

        let dir = piper_env::piper_venv_dir();
        // A finished environment that still imports needs only the voice.
        let venv_python = match piper_env::ready_python_in(&dir).filter(|py| imports(py)) {
            Some(py) => {
                update("installing", "Piper is already installed, skipping pip.");
                py
            }
            None => match build_piper_env(&default_python, &dir, &install_state, &update, &imports) {
                Ok(py) => py,
                Err(msg) => {
                    fail(&msg);
                    return;
                }
            },
        };

        update(
            "installing",
            &format!(
                "Piper installed. Downloading the {} voice (~63 MB)…",
                crate::commands::tts::PIPER_VOICE
            ),
        );
        let _ = std::fs::create_dir_all(&voices_dir);
        let mut cmd = python_command(&venv_python);
        cmd.args([
            "-m",
            "piper.download_voices",
            crate::commands::tts::PIPER_VOICE,
            "--download-dir",
            &voices_dir.to_string_lossy(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        match cmd.output() {
            Ok(o) if o.status.success() => update("complete", "Neural TTS is ready."),
            Ok(o) => fail(&format!("Voice download failed:\n{}", String::from_utf8_lossy(&o.stderr))),
            Err(e) => fail(&format!("Voice download could not start: {}", os_error::english(&e))),
        }
    });

    Ok(serde_json::json!({"status": "installing"}))
}

/// Piper's environment, built from a Python in onnxruntime's range: the
/// machine's (LU's default first), else LU's own. Returns the venv's
/// interpreter once `import piper` works in it, or the sentence to show.
fn build_piper_env(
    default_python: &str,
    dir: &std::path::Path,
    install_state: &std::sync::Arc<std::sync::Mutex<crate::state::InstallState>>,
    update: &dyn Fn(&str, &str),
    imports: &dyn Fn(&str) -> bool,
) -> Result<String, String> {
    let mut candidates = vec![default_python.to_string()];
    candidates.extend(crate::python::python_interpreters());
    let mut found: Vec<(String, String)> = Vec::new();
    for p in candidates {
        if p.is_empty() || !crate::python::is_real_python(&p) || found.iter().any(|(s, _)| s.eq_ignore_ascii_case(&p)) {
            continue;
        }
        match piper_env::probe(&p) {
            Ok((v, true)) => found.push((p, v)),
            Ok((v, false)) => update("installing", &format!("Skipping {p} (Python {v}): not a 64-bit build, Piper has no wheels for it.")),
            Err(why) => update("installing", &format!("Skipping {p}: it did not start ({why}).")),
        }
    }
    let machine = piper_env::choose_machine_python(&found);
    if machine.is_none() {
        update("installing", &format!(
            "No Python on this computer fits Piper ({}; this computer has {}). Setting up LU's own Python 3.12, the Pythons already installed stay as they are...",
            piper_env::PIPER_PYTHON_RANGE,
            if found.is_empty() { "none that starts".to_string() } else { found.iter().map(|(_, v)| v.as_str()).collect::<Vec<_>>().join(" and ") },
        ));
    }
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let progress = crate::private_python::StatusProgress { status: install_state, cancel: &cancel };
    let why = crate::private_python::Why {
        log: "no Python 3.11 to 3.14 on this computer for Piper",
        sentence: "This computer has no Python 3.11 to 3.14 for neural TTS",
    };
    let base = machine_or_own(machine.clone(), piper_env::piper_accepts, &progress, why)?
        .ok_or_else(|| format!(
            "Neural TTS (Piper) needs {} and this computer has {}. Install Python 3.12 from python.org, then press Download & Install again.",
            piper_env::PIPER_PYTHON_RANGE,
            if found.is_empty() { "none that starts".to_string() } else { found.iter().map(|(_, v)| v.as_str()).collect::<Vec<_>>().join(" and ") },
        ))?;
    let version = piper_env::probe(&base).map(|(v, _)| v).unwrap_or_else(|_| "?".to_string());
    update("installing", &format!("Building Piper's own environment with Python {version} at {base}..."));
    let venv_python = match piper_env::build_venv(&base, dir) {
        Ok(py) => py,
        // A machine Python without its venv module (Debian without
        // python3-venv): LU's own Python has one.
        Err(why) if machine.is_some() => {
            update("installing", &format!("{base} could not make a venv ({why}). Trying LU's own Python..."));
            let own = machine_or_own(None, piper_env::piper_accepts, &progress, why_own())?
                .ok_or_else(|| format!("{base} could not make a venv ({why}), and LU has no Python of its own for this system."))?;
            piper_env::build_venv(&own, dir).map_err(|e| format!("LU's own Python could not make a venv for Piper: {e}"))?
        }
        Err(why) => return Err(format!("Python {version} at {base} could not make a venv for Piper: {why}")),
    };

    update("installing", &format!("Installing {} (this can take a few minutes)…", piper_env::PIPER_TTS));
    let args = piper_env::pip_args(std::env::consts::OS);
    if let Err(diagnosis) = venv_pip_install_streaming_with_retry_cancellable(&args, &venv_python, 3, install_state, None) {
        let log = install_state.lock().map(|s| s.logs.clone()).unwrap_or_default();
        return Err(piper_env::failure_message(&diagnosis, &log, &base, &version));
    }
    if !imports(&venv_python) {
        return Err(format!("Piper was installed with Python {version}, but `import piper` fails in its environment. Press Download & Install again; if it stays, send the log from Settings, Troubleshooting."));
    }
    piper_env::mark_ready(dir);
    Ok(venv_python)
}

fn why_own() -> crate::private_python::Why<'static> {
    crate::private_python::Why {
        log: "the machine's Python could not make a venv for Piper",
        sentence: "The Python on this computer could not make an environment for neural TTS",
    }
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

    /// A34 / #254 from end to end on a real machine: LU's default Python is
    /// a 3.15 (onnxruntime has no wheel for it, the case of the report), the
    /// install passes it over, builds Piper's environment from a Python in
    /// range and installs the pinned wheels; `import piper` works there.
    /// Downloads about 40 MB from PyPI, so it only runs when asked:
    /// `LU_PIPER_E2E_PY315=<python 3.15> LU_PIPER_E2E_DIR=<empty folder> cargo test piper_env_end_to_end -- --ignored --nocapture`
    #[test]
    #[ignore = "downloads piper-tts and onnxruntime, see LU_PIPER_E2E_PY315"]
    fn piper_env_end_to_end_passes_a_python_3_15_over() {
        let py315 = std::env::var("LU_PIPER_E2E_PY315").expect("LU_PIPER_E2E_PY315");
        let dir = std::path::PathBuf::from(std::env::var("LU_PIPER_E2E_DIR").expect("LU_PIPER_E2E_DIR")).join("piper-venv");
        let state = std::sync::Arc::new(std::sync::Mutex::new(crate::state::InstallState::default()));
        let update = |_: &str, msg: &str| {
            println!("{msg}");
            state.lock().unwrap().logs.push(msg.to_string());
        };
        let imports = |py: &str| python_command(py).args(["-c", "import piper.download_voices"]).status().map(|s| s.success()).unwrap_or(false);
        let venv_py = build_piper_env(&py315, &dir, &state, &update, &imports).unwrap_or_else(|e| panic!("{e}"));
        let (v, _) = piper_env::probe(&venv_py).unwrap();
        println!("Piper's environment: Python {v} at {venv_py}");
        assert!(piper_env::major_minor(&v).is_some_and(piper_env::piper_accepts), "{v}");
        assert!(imports(&venv_py));
        assert_eq!(piper_env::ready_python_in(&dir), Some(venv_py));
    }

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
