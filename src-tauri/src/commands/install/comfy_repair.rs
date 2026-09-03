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
use crate::os_error;
use std::path::Path;
use super::comfy_job::{finished_notice, requirements_fallback_log};
use super::env_check::verify_and_heal_environment;
use super::pip::{pip_install_streaming_with_retry_raw, requirements_failure_reason_for};
use super::venv::venv_removal_error;

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
        install.notice.clear();
        install.notice_kind.clear();
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

        // Set when `pip install -r requirements.txt` failed and the run carried
        // on with LU's own package list. Folder plus reason, so the live log
        // line and the line the finished run leaves behind agree (A15).
        let mut requirements_fallback: Option<(String, &'static str)> = None;

        // A16 (A15-2): before anything is deleted and before anything is
        // downloaded. A folder with no requirements.txt is not a ComfyUI
        // checkout, and nothing later in this run can change that, so there is
        // no reason to spend three minutes and two gigabytes finding out, nor
        // to throw away a venv for a rebuild that cannot finish.
        if let Err(msg) = repair_precheck(&comfy_dir) {
            update("error", &msg);
            return;
        }

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
                update("error", &venv_removal_error(&venv_dir, &e));
                return;
            }
        }

        update(
            "installing",
            "Step 1/4: Creating a fresh isolated venv inside the ComfyUI folder...",
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
        update("installing", &format!("Step 2/4: {}", gpu_info));
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
        // Checked once at the top already. Kept as a guard for the file being
        // renamed or deleted while the rebuild was running, which is a real
        // few minutes on a slow line.
        if !reqs.exists() {
            update("error", &missing_requirements_for_repair(&comfy_dir));
            return;
        }
        {
            update(
                "installing",
                "Step 3/4: Installing ComfyUI dependencies into the venv...",
            );
            let reqs_str = reqs.to_string_lossy().to_string();
            let req_args = vec![
                "-m", "pip", "install",
                "--progress-bar", "off",
                "--no-input",
                "-r", reqs_str.as_str(),
            ];
            match pip_install_streaming_with_retry_raw(&req_args, &venv_py, 3, &install_status, Some(&cancel_flag)) {
                Ok(()) => update("installing", "Dependencies installed."),
                Err(f) if f.diagnosis == "cancelled" => {
                    update("cancelled", "Repair cancelled during the requirements install.");
                    return;
                }
                Err(f) => {
                    let reason = requirements_failure_reason_for(&f);
                    let folder = comfy_dir.display().to_string();
                    requirements_fallback = Some((folder.clone(), reason));
                    update("installing", &requirements_fallback_log(&folder, reason));
                    update(
                        "installing",
                        &format!(
                            "Not every dependency installed. Checking what is really missing.\n\n{}",
                            f.diagnosis
                        ),
                    );
                }
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

        // A3: this is the step the button was missing. Two of the five
        // reporters pressed Repair environment and nothing changed, because a
        // rebuild that trusts pip's exit code rebuilds the same hole.
        update("installing", "Step 4/4: Checking that the environment really starts...");
        match verify_and_heal_environment(&venv_py, &reqs, &install_status, Some(&cancel_flag)) {
            Ok(()) => {}
            Err(e) if e == "cancelled" => {
                update("cancelled", "Repair cancelled during the environment check.");
                return;
            }
            Err(e) => {
                error!("comfyui env repair left an environment that does not import");
                update("error", &format!("The environment was rebuilt, but it still does not start.\n\n{}", e));
                return;
            }
        }

        let (notice_text, closing) = if lost.is_empty() {
            (
                "Repair finished. ComfyUI is ready.".to_string(),
                "Environment repaired. ComfyUI now runs from its own venv; start it again."
                    .to_string(),
            )
        } else {
            let names = lost.join(" and ");
            (
                format!("Repair finished, but {} could not be reinstalled.", names),
                format!(
                    "ComfyUI's environment is repaired and can be started again, but {} could not \
                     be reinstalled into the new venv and {} not available until you install {} \
                     again from Settings.",
                    names,
                    if lost.len() == 1 { "is" } else { "are" },
                    if lost.len() == 1 { "it" } else { "them" },
                ),
            )
        };
        if let Ok(mut s) = install_status.lock() {
            let (line, kind) = finished_notice(&notice_text, requirements_fallback.as_ref());
            s.notice = line;
            s.notice_kind = kind.to_string();
        }
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
        install.notice.clear();
        install.notice_kind.clear();
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
    // The update runs through the same status slot, the same panel and the
    // same Cancel button as the install, so it gets the same flag. Reset
    // first, for the reason install_comfyui resets it (Bug #1): a previously
    // cancelled run would otherwise abort this one on the first poll.
    state.comfyui_install_cancel.store(false, Ordering::SeqCst);
    let cancel_flag = state.comfyui_install_cancel.clone();
    std::thread::spawn(move || {
        let _job_guard = job_guard;
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = install_status.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        // Set when `pip install -r requirements.txt` failed and the run carried
        // on with LU's own package list. Folder plus reason, so the live log
        // line and the line the finished run leaves behind agree (A15).
        let mut requirements_fallback: Option<(String, &'static str)> = None;

        #[cfg(target_os = "windows")]
        {
            let probe = windows_git_probe();
            if probe == WindowsGitState::Missing {
                update("error", &windows_git_install_hint(&probe).unwrap_or_default());
                return;
            }
        }

        update("installing", "Step 1/3: Pulling the latest ComfyUI...");
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
                update("error", &format!("Could not run git: {}", os_error::english(&e)));
                return;
            }
        }

        update(
            "installing",
            "Step 2/3: Updating Python dependencies (live pip output below)...",
        );
        let reqs = comfy_dir.join("requirements.txt");
        if !reqs.exists() {
            update(
                "error",
                &format!(
                    "The folder {} has no requirements.txt after the pull, so its dependencies \
                     cannot be updated. Reinstall ComfyUI from Settings.",
                    comfy_dir.display()
                ),
            );
            return;
        }
        {
            let reqs_str = reqs.to_string_lossy().to_string();
            let req_args = vec![
                "-m", "pip", "install",
                "--progress-bar", "off",
                "--no-input",
                "-r", reqs_str.as_str(),
            ];
            match pip_install_streaming_with_retry_raw(
                &req_args,
                &python_bin,
                3,
                &install_status,
                Some(&cancel_flag),
            ) {
                Ok(()) => update("installing", "Dependencies updated."),
                Err(f) if f.diagnosis == "cancelled" => {
                    update("cancelled", "Update cancelled during the requirements install.");
                    return;
                }
                Err(f) => {
                    println!("[Update] Requirements warning: {}", f.diagnosis);
                    let reason = requirements_failure_reason_for(&f);
                    let folder = comfy_dir.display().to_string();
                    requirements_fallback = Some((folder.clone(), reason));
                    update("installing", &requirements_fallback_log(&folder, reason));
                    update(
                        "installing",
                        &format!(
                            "Not every dependency updated. Checking what is really missing.\n\n{}",
                            f.diagnosis
                        ),
                    );
                }
            }
        }

        // A pull that brings new requirements is the third way into A3: the
        // core moves on, one wheel does not land, and the update reports
        // finished over an environment that no longer imports.
        update("installing", "Step 3/3: Checking that the environment really starts...");
        if let Err(e) = verify_and_heal_environment(&python_bin, &reqs, &install_status, Some(&cancel_flag)) {
            if e == "cancelled" {
                update("cancelled", "Update cancelled during the environment check.");
                return;
            }
            error!("comfyui update left an environment that does not import");
            update("error", &format!("ComfyUI was updated, but its Python environment is not usable.\n\n{}", e));
            return;
        }

        println!("[Update] ComfyUI update complete");
        if let Ok(mut s) = install_status.lock() {
            let (line, kind) = finished_notice(
                "Update finished. Restart ComfyUI to load the new nodes.",
                requirements_fallback.as_ref(),
            );
            s.notice = line;
            s.notice_kind = kind.to_string();
        }
        update(
            "complete",
            "ComfyUI updated. Restart ComfyUI to load the new nodes.",
        );
    });

    Ok(serde_json::json!({"status": "installing"}))
}


/// What Repair says about a folder with no requirements.txt.
///
/// A16 (A15-2), Windows counter-check 02.09.: the sentence itself was right and
/// arrived after 181,6 seconds, because the file was only looked at when pip
/// was about to be pointed at it, which is after the venv has been deleted and
/// PyTorch has been downloaded into the new one. Three minutes and two
/// gigabytes to learn that the folder was never a ComfyUI checkout, and a
/// half-built environment left behind for it. The check runs before any of
/// that now, and the wording is here so the early check and the late one, kept
/// as a guard against the file going away mid run, cannot drift apart.
fn missing_requirements_for_repair(dir: &Path) -> String {
    format!(
        "The folder {} has no requirements.txt, so it is not a complete ComfyUI \
         checkout and the environment cannot be rebuilt from it. Rename or delete \
         that folder and install ComfyUI again.",
        dir.display()
    )
}

/// Everything Repair can rule out before it destroys or downloads anything.
///
/// One function so the order is not a matter of where a call happens to sit:
/// this is called first in the run, and what it refuses costs the user
/// nothing.
fn repair_precheck(comfy_dir: &Path) -> Result<(), String> {
    if !comfy_dir.join("requirements.txt").exists() {
        return Err(missing_requirements_for_repair(comfy_dir));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repair_refuses_a_folder_without_requirements_before_it_spends_anything() {
        // The counter-check renamed requirements.txt and pressed Repair. The
        // run deleted the venv, downloaded two gigabytes of PyTorch and then,
        // after 181,6 seconds, said the folder was never a ComfyUI checkout.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        std::fs::create_dir(&comfy).unwrap();
        std::fs::create_dir(comfy.join("venv")).unwrap();

        let refused = repair_precheck(&comfy).expect_err("a folder with no requirements.txt was accepted");

        assert!(refused.contains("requirements.txt"), "the file is not named: {refused}");
        assert!(refused.contains(&comfy.display().to_string()), "the folder is not named: {refused}");
        assert!(refused.contains("install ComfyUI again"), "no way out is offered: {refused}");
        // Nothing was touched on the way to that answer.
        assert!(comfy.join("venv").exists(), "the venv was removed by a run that could not finish");
    }

    #[test]
    fn repair_lets_a_real_checkout_through() {
        // Negative control. Without it the check above would pass on a
        // precheck that refused every folder, which would kill Repair outright.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        std::fs::create_dir(&comfy).unwrap();
        std::fs::write(comfy.join("requirements.txt"), "torch\n").unwrap();

        assert!(repair_precheck(&comfy).is_ok(), "a real ComfyUI checkout was refused");
    }

    #[test]
    fn the_repair_precheck_really_runs_before_the_venv_and_the_download() {
        // The weaker proof, and labelled as such: the repair body is a thread
        // inside a Tauri command and cannot be driven from here, so the ORDER
        // is pinned by reading this file. It catches the check drifting back
        // down the function, which is exactly what the counter-check found.
        //
        // Every needle is assembled from two halves, and that is not cosmetic.
        // Written whole, each one would stand in THIS file as well, `find`
        // would return the position of the copy in this test body whenever the
        // real line was gone, and the `.expect` beside it could never fire. A
        // guard that cannot fail is not a guard. Split, the halves never form
        // a contiguous match in the source, so a missing line is a `None` and
        // the message next to it is the one the reader gets.
        let src = include_str!("comfy_repair.rs");
        let needle = |head: &str, tail: &str| format!("{head}{tail}");
        let call = src.find(&needle("if let Err(msg) = repair_prech", "eck(&comfy_dir) {"))
            .expect("Repair no longer prechecks at all");
        let venv = src.find(&needle("\"Removing the old venv (models, outputs", " and custom nodes stay untouched)...\","))
            .expect("the venv removal step is gone");
        let torch = src.find(&needle("\"Downloading PyTorch into the fresh venv", " (~2 GB). Live pip output below.\","))
            .expect("the PyTorch step is gone");
        assert!(call < venv, "the precheck runs after the venv is deleted");
        assert!(call < torch, "the precheck runs after the PyTorch download");

        // And the guard on the guard: each needle occurs EXACTLY once in the
        // file. Two occurrences would mean this test body carries a copy of
        // the line it is looking for, which is how the three `.expect`s above
        // became unreachable in the first place.
        for (what, n) in [
            ("the precheck call", needle("if let Err(msg) = repair_prech", "eck(&comfy_dir) {")),
            ("the venv step", needle("\"Removing the old venv (models, outputs", " and custom nodes stay untouched)...\",")),
            ("the PyTorch step", needle("\"Downloading PyTorch into the fresh venv", " (~2 GB). Live pip output below.\",")),
        ] {
            assert_eq!(
                src.matches(&n).count(),
                1,
                "{what}: the search string finds itself in this test, so its .expect can never fire",
            );
        }
    }

}
