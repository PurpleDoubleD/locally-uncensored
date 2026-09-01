//! Die zwei Eingriffe an einer ComfyUI, die schon da ist.
//!
//! Der geteilte Zustand ist eine BESTEHENDE Installation — beide Befehle
//! fangen dort an, wo `comfy_install` aufhört, und beide müssen sie erst
//! finden, bevor sie etwas anfassen dürfen. Was sie unterscheidet, ist die
//! Hälfte, die sie ersetzen: die Reparatur wirft das venv weg und baut es
//! neu, das Update holt den Kern nach und lässt das venv stehen.
//!
//! Sie stehen zusammen, weil ihre Fehlerfälle dieselben sind und in beiden
//! Richtungen aufeinander zeigen. Beide brechen ab, wenn kein brauchbarer
//! Python da ist; beide behandeln fehlgeschlagene optionale Abhängigkeiten
//! als Warnung und nicht als Abbruch, weil ComfyUI danach trotzdem startet;
//! und beide erzählen in denselben Statusschlitz, den `install_comfyui_status`
//! ausliest. Wer die eine Regel ändert, muss die andere danebenlegen.
//!
//! Die Reparatur trägt zusätzlich die Pflicht, die ihr Auslöser ihr
//! aufgibt: sie läuft automatisch nach einem ComfyUI-Absturz, und sie
//! löscht dabei ein venv, in dem faster-whisper und Piper mitwohnen. Was sie
//! wegnimmt, muss sie am Ende wieder hinstellen — und es sagen, sonst liest
//! der Nutzer nur "die Sprachausgabe ist plötzlich weg".

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::State;
use tracing::{error, info};

use crate::state::AppState;

use super::comfy_job::{ComfyJob, COMFY_JOB};
use super::comfy_job::comfy_job_busy_message;
use super::pip::pip_install_streaming_with_retry_cancellable;
use super::torch::plan_pytorch_install;
use super::venv::{create_comfyui_venv, detect_venv_passengers};
#[cfg(target_os = "windows")]
use super::git::{windows_git_install_hint, windows_git_probe, WindowsGitState};
#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

/// GH #98 (joelnewswanger, 2026-08-14): ComfyUI installed once, then died at
/// import time on every start. His torch lived in the SHARED system Python's
/// site-packages, where anything the user ever pip-installed can break us,
/// and clicking install again changed nothing because pip saw every package
/// as "already satisfied". kryptoxide's night (same issue) was the same trap
/// from the other side: a stray `comfy 0.0.1` on the system Python shadowed
/// ComfyUI's own package.
///
/// The repair builds what those installs never had: a fresh venv inside the
/// ComfyUI folder, with PyTorch and the requirements installed into it. The
/// launcher already prefers ComfyUI/venv over the system Python, so the next
/// start picks it up with no further wiring. The system Python, models,
/// outputs and custom nodes are left alone. Progress goes through the same
/// install_status slot, so install_comfyui_status polling just works.
#[tauri::command]
pub fn repair_comfyui_env(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    if !crate::commands::process::comfy_supported_here() {
        return Err(crate::commands::process::MACOS_COMFY_REFUSAL.to_string());
    }
    // OI-5: acquired before any of the checks below, because every one of them
    // reads state a concurrent install is actively changing. Dropped again on
    // each early return.
    let job_guard = match COMFY_JOB.try_acquire(ComfyJob::Repair) {
        Ok(g) => g,
        Err(ComfyJob::Repair) => return Ok(serde_json::json!({"status": "already_installing"})),
        Err(running) => return Err(comfy_job_busy_message(ComfyJob::Repair, running)),
    };
    let comfy_dir = {
        let p = state.comfy_path.lock().unwrap().clone();
        p.or_else(crate::commands::process::find_comfyui_path)
    };
    let Some(comfy_dir) = comfy_dir else {
        return Err(
            "ComfyUI is not installed, so there is no environment to repair. Use Install ComfyUI instead."
                .to_string(),
        );
    };
    let comfy_dir = PathBuf::from(comfy_dir);
    // Portable installs bring their own python_embeded and the launcher
    // prefers it over any venv, so a rebuilt venv would never be used.
    let embeded_here = comfy_dir.join("python_embeded").join("python.exe").exists();
    let embeded_beside = comfy_dir
        .parent()
        .map(|p| p.join("python_embeded").join("python.exe").exists())
        .unwrap_or(false);
    if embeded_here || embeded_beside {
        return Err(
            "This is a portable ComfyUI with its own bundled Python. Re-extract the portable \
             package to repair it; the app cannot rebuild that environment."
                .to_string(),
        );
    }
    let python_bin = state.python_bin.lock().unwrap().clone();
    if python_bin.is_empty() || !crate::python::is_real_python(&python_bin) {
        return Err(
            "no_python: Python must be installed before the environment can be rebuilt. Call install_python first."
                .to_string(),
        );
    }
    {
        let mut install = state.install_status.lock().unwrap();
        install.status = "installing".to_string();
        install.logs.clear();
        install.logs.push("Repairing the ComfyUI environment...".to_string());
    }
    info!("comfyui env repair start");
    // A tracked child would hold venv files open on Windows; it is dead or
    // dying anyway (the repair only runs after a startup crash).
    {
        let mut proc = state.comfy_process.lock().unwrap();
        if let Some(mut child) = proc.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    state.comfyui_install_cancel.store(false, Ordering::SeqCst);
    let cancel_flag = state.comfyui_install_cancel.clone();
    let install_status = state.install_status.clone();
    // OI-3: the whisper server runs FROM this venv's Python. On Windows a
    // running interpreter holds its own files open, so leaving it up makes
    // `remove_dir_all` fail and the repair dies at step one with "close
    // anything using it and retry" — naming nothing the user can close.
    // Stopping it is also free: `ensure_whisper_running` brings it back on
    // the next voice input, then against the rebuilt venv.
    let whisper = state.whisper.clone();

    std::thread::spawn(move || {
        let _job_guard = job_guard;
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = install_status.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        // A broken venv must go entirely: pip inside it would report the
        // damaged packages as already satisfied, which is the exact dead end
        // this command exists to break.
        let venv_dir = comfy_dir.join("venv");
        // OI-3: faster-whisper and Piper live in this venv too. Take stock
        // BEFORE the delete, because afterwards there is nothing left to read.
        let passengers = detect_venv_passengers(&venv_dir);
        if !passengers.is_empty() {
            let names: Vec<&str> = passengers.iter().map(|p| p.label).collect();
            // The connection has to be in the log the user is looking at. Its
            // absence is what turned this into "Voice just stopped": two
            // unrelated-looking features died during a ComfyUI repair the
            // Create tab started on its own.
            info!(passengers = ?names, "comfyui repair will rebuild venv passengers");
            update(
                "installing",
                &format!(
                    "This venv also holds {}. Rebuilding it removes them, so LU will \
                     reinstall them at the end of the repair — do not close the app until \
                     that step is done.",
                    names.join(" and ")
                ),
            );
        }
        if venv_dir.exists() {
            // Before the delete: nothing of ours may still be running out of
            // this venv (see the `whisper` clone above).
            if let Ok(mut w) = whisper.lock() {
                if w.is_running() {
                    update(
                        "installing",
                        "Stopping the voice-input server, which runs from this venv. It \
                         restarts by itself the next time you use voice input.",
                    );
                    w.stop();
                }
            }
            update(
                "installing",
                "Removing the old venv (models, outputs and custom nodes stay untouched)...",
            );
            if let Err(e) = std::fs::remove_dir_all(&venv_dir) {
                update(
                    "error",
                    &format!(
                        "Could not remove the old venv at {}: {}. Close anything using it and retry.",
                        venv_dir.display(),
                        e
                    ),
                );
                return;
            }
        }

        update(
            "installing",
            "Step 1/3: Creating a fresh isolated venv inside the ComfyUI folder...",
        );
        let venv_py = match create_comfyui_venv(&comfy_dir, &python_bin) {
            Ok(p) => p.to_string_lossy().to_string(),
            Err(e) => {
                update("error", &format!("venv creation failed.\n\n{}", e));
                return;
            }
        };
        if cancel_flag.load(Ordering::SeqCst) {
            update("cancelled", "Repair cancelled.");
            return;
        }

        let (torch_args, gpu_info) = plan_pytorch_install();
        update("installing", &format!("Step 2/3: {}", gpu_info));
        update(
            "installing",
            "Downloading PyTorch into the fresh venv (~2 GB). Live pip output below.",
        );
        let refs: Vec<&str> = torch_args.iter().map(|s| s.as_str()).collect();
        match pip_install_streaming_with_retry_cancellable(&refs, &venv_py, 3, &install_status, Some(&cancel_flag)) {
            Ok(()) => update("installing", "PyTorch installed."),
            Err(d) if d == "cancelled" => {
                update("cancelled", "Repair cancelled during the PyTorch download.");
                return;
            }
            Err(d) => {
                update("error", &format!("PyTorch installation failed.\n\n{}", d));
                return;
            }
        }

        let reqs = comfy_dir.join("requirements.txt");
        if reqs.exists() {
            update(
                "installing",
                "Step 3/3: Installing ComfyUI dependencies into the venv...",
            );
            let reqs_str = reqs.to_string_lossy().to_string();
            let req_args = vec![
                "-m", "pip", "install",
                "--progress-bar", "off",
                "--no-input",
                "-r", reqs_str.as_str(),
            ];
            match pip_install_streaming_with_retry_cancellable(&req_args, &venv_py, 3, &install_status, Some(&cancel_flag)) {
                Ok(()) => update("installing", "Dependencies installed."),
                Err(d) if d == "cancelled" => {
                    update("cancelled", "Repair cancelled during the requirements install.");
                    return;
                }
                Err(d) => update(
                    "installing",
                    &format!("Some optional dependencies had warnings (non-critical): {}", d),
                ),
            }
        }

        // OI-3: put the passengers back. Failures here are reported but do not
        // fail the repair — ComfyUI itself is rebuilt at this point, and
        // burying a working ComfyUI under a Piper wheel error would trade one
        // silent loss for another. What must never happen again is the repair
        // finishing without saying what happened to Voice.
        let mut lost: Vec<&str> = Vec::new();
        for p in &passengers {
            update(
                "installing",
                &format!("Reinstalling {} into the fresh venv...", p.label),
            );
            let args = vec![
                "-m", "pip", "install",
                "--progress-bar", "off",
                "--no-input",
                p.pip_name,
            ];
            match pip_install_streaming_with_retry_cancellable(&args, &venv_py, 3, &install_status, Some(&cancel_flag)) {
                Ok(()) => update("installing", &format!("{} is back.", p.label)),
                Err(d) if d == "cancelled" => {
                    update(
                        "cancelled",
                        &format!(
                            "Repair cancelled while reinstalling {}. It is NOT installed — \
                             reinstall it from Settings.",
                            p.label
                        ),
                    );
                    return;
                }
                Err(d) => {
                    error!(package = p.pip_name, error = %d, "venv passenger reinstall failed after comfyui repair");
                    lost.push(p.label);
                    update(
                        "installing",
                        &format!("Could not reinstall {}: {}", p.label, d),
                    );
                }
            }
        }

        let closing = if lost.is_empty() {
            "Environment repaired. ComfyUI now runs from its own venv; start it again.".to_string()
        } else {
            format!(
                "ComfyUI's environment is repaired and can be started again, but {} could not \
                 be reinstalled into the new venv and {} not available until you install {} \
                 again from Settings.",
                lost.join(" and "),
                if lost.len() == 1 { "is" } else { "are" },
                if lost.len() == 1 { "it" } else { "them" },
            )
        };
        update("complete", &closing);
    });

    Ok(serde_json::json!({"status": "installing"}))
}

/// Update an existing ComfyUI install in place: `git pull --ff-only` plus a
/// venv-aware `pip install -r requirements.txt`. The 2.5.8 local Create lanes
/// (music / talking character / extend / motion) need node classes that ship
/// with current ComfyUI cores, and the UI gates on node PRESENCE — when the
/// nodes are missing this command is the one-click "Update ComfyUI" path.
/// Progress streams through the same `install_status` channel the installer
/// uses, so the existing `install_comfyui_status` polling UI works unchanged.
#[tauri::command]
pub fn update_comfyui(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // OI-5: same lock as install and repair. This command's old guard was the
    // strictest of the three ("installing" OR "downloading"), which is exactly
    // why the inconsistency was invisible from here — it was the other two
    // that let a job in mid-clone.
    let job_guard = match COMFY_JOB.try_acquire(ComfyJob::Update) {
        Ok(g) => g,
        Err(ComfyJob::Update) => return Ok(serde_json::json!({"status": "already_installing"})),
        Err(running) => return Err(comfy_job_busy_message(ComfyJob::Update, running)),
    };
    {
        let mut install = state.install_status.lock().unwrap();
        install.status = "installing".to_string();
        install.logs.clear();
        install.logs.push("Updating ComfyUI...".to_string());
    }

    info!("comfyui update start");

    let comfy_dir = {
        let p = state.comfy_path.lock().unwrap().clone();
        p.or_else(crate::commands::process::find_comfyui_path)
            .map(PathBuf::from)
    };
    let fail = |state: &State<'_, AppState>, msg: &str| -> Result<serde_json::Value, String> {
        let mut install = state.install_status.lock().unwrap();
        install.status = "error".to_string();
        install.logs.push(msg.to_string());
        error!("comfyui update aborted: {}", msg);
        Err(msg.to_string())
    };
    let Some(comfy_dir) = comfy_dir else {
        return fail(&state, "ComfyUI not found. Install ComfyUI first.");
    };
    if !comfy_dir.join(".git").exists() {
        // Portable / zip installs carry no git metadata — nothing to pull.
        return fail(
            &state,
            "This ComfyUI was not installed from git, so it can't be updated in place. \
             Update it with its own updater, or reinstall from Settings.",
        );
    }

    // Prefer the install's venv Python (same preference the launcher uses);
    // refuse without a usable interpreter — a pulled core with stale
    // requirements is worse than no update (frontend package pins move often).
    let python_bin = crate::python::resolve_comfyui_venv_python(&comfy_dir)
        .unwrap_or_else(|| state.python_bin.lock().unwrap().clone());
    if python_bin.is_empty() || !crate::python::is_real_python(&python_bin) {
        return fail(
            &state,
            "No usable Python found for this ComfyUI. Install Python first, then retry the update.",
        );
    }

    let install_status = state.install_status.clone();
    std::thread::spawn(move || {
        let _job_guard = job_guard;
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = install_status.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        #[cfg(target_os = "windows")]
        {
            let probe = windows_git_probe();
            if probe == WindowsGitState::Missing {
                update("error", &windows_git_install_hint(&probe).unwrap_or_default());
                return;
            }
        }

        update("installing", "Step 1/2: Pulling the latest ComfyUI...");
        let mut pull = Command::new("git");
        // --ff-only: a user-modified checkout must not silently merge; surface
        // the divergence honestly instead.
        pull.args(["pull", "--ff-only"])
            .current_dir(&comfy_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        pull.creation_flags(CREATE_NO_WINDOW);
        match pull.output() {
            Ok(o) if o.status.success() => {
                let out = String::from_utf8_lossy(&o.stdout);
                let line = out.lines().last().unwrap_or("").trim().to_string();
                update(
                    "installing",
                    if line.is_empty() { "Repository updated." } else { &line },
                );
            }
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                update(
                    "error",
                    &format!(
                        "git pull failed. If you changed files inside the ComfyUI folder, \
                         stash or revert them and retry.\n\n{}",
                        stderr.trim(),
                    ),
                );
                return;
            }
            Err(e) => {
                update("error", &format!("Could not run git: {}", e));
                return;
            }
        }

        update(
            "installing",
            "Step 2/2: Updating Python dependencies (live pip output below)...",
        );
        let reqs = comfy_dir.join("requirements.txt");
        if reqs.exists() {
            let reqs_str = reqs.to_string_lossy().to_string();
            let req_args = vec![
                "-m", "pip", "install",
                "--progress-bar", "off",
                "--no-input",
                "-r", reqs_str.as_str(),
            ];
            match pip_install_streaming_with_retry_cancellable(
                &req_args,
                &python_bin,
                3,
                &install_status,
                None,
            ) {
                Ok(()) => update("installing", "Dependencies updated."),
                Err(diagnosis) => {
                    // Same stance as the installer's step 3: optional deps may
                    // fail while ComfyUI still starts — log, don't abort.
                    println!("[Update] Requirements warning: {}", diagnosis);
                    update(
                        "installing",
                        "Some dependencies had warnings (non-critical, ComfyUI should still start).",
                    );
                }
            }
        }

        println!("[Update] ComfyUI update complete");
        update(
            "complete",
            "ComfyUI updated. Restart ComfyUI to load the new nodes.",
        );
    });

    Ok(serde_json::json!({"status": "installing"}))
}
