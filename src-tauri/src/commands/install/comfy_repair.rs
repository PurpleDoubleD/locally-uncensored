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
use std::process::Stdio;
use std::sync::atomic::Ordering;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::{Manager, State};
use tracing::{error, info};

use crate::state::AppState;
use crate::os_error;
use std::path::Path;
use super::comfy_job::{finished_notice, requirements_fallback_log};
use super::env_check::verify_and_heal_environment;
use super::pip::{pip_install_streaming_with_retry_raw, requirements_failure_reason_for};

use super::comfy_job::{ComfyJob, COMFY_JOB};
use super::comfy_job::comfy_job_busy_message;
use super::pip::pip_install_streaming_with_retry_cancellable;
use super::torch::plan_pytorch_install;
use super::venv::{
    create_comfyui_venv, detect_venv_passengers, finish_rebuild, restore_after_failed_rebuild,
    restore_orphaned_venv_if_needed, retire_for_rebuild,
};
#[cfg(target_os = "windows")]
use super::git::{windows_git_install_hint, windows_git_probe, WindowsGitState};
#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

/// GH #98 (2026-08-14): ComfyUI installed once, then died at
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
        // on with the packages LU knows about. Folder plus reason, so the live
        // log line and the line the finished run leaves behind agree (A15).
        let mut requirements_fallback: Option<(String, &'static str)> = None;

        // Runde 6, B9 "Wiederanlauf": before ANYTHING else touches this
        // folder, recover from a rebuild that died between retiring the old
        // venv and the new one passing verification (crash, power loss, the
        // app being killed). A healthy environment sees no difference at
        // all: this is a no-op the moment a usable `venv` already exists.
        restore_orphaned_venv_if_needed(&comfy_dir);

        // A16 (A15-2): before anything is deleted and before anything is
        // downloaded. A folder with no requirements.txt is not a ComfyUI
        // checkout, and nothing later in this run can change that, so there is
        // no reason to spend three minutes and two gigabytes finding out, nor
        // to throw away a venv for a rebuild that cannot finish.
        if let Err(msg) = repair_precheck(&comfy_dir) {
            update("error", &msg);
            return;
        }

        // P3 (04.09.): the repair had exactly one cancel check, and it sat
        // BEHIND the venv build. Everything before it was a click the app
        // swallowed. This is the same helper the installer has had all along
        // (comfy_install.rs), and the checks below are placed the same way:
        // before each stretch that cannot be interrupted from inside.
        let cancelled = || cancel_flag.load(Ordering::SeqCst);
        if cancelled() {
            update("cancelled", "Repair cancelled before anything was changed.");
            return;
        }

        let venv_dir = comfy_dir.join("venv");

        // Runde 6, B9: the old venv and the new one now BOTH sit on disk at
        // the same time, from the moment the old one is retired until it is
        // swept away in the background after the new one passes
        // verification. The flat 5 GB estimate below never accounted for
        // that second copy; this one does, and it REFUSES rather than warns,
        // before anything is touched, so a drive that genuinely cannot hold
        // both says so up front instead of failing minutes into the PyTorch
        // download with the old venv already gone.
        if let Some(msg) = check_repair_disk_pressure(&comfy_dir, &venv_dir) {
            update("error", &msg);
            return;
        }
        // The generic warning (soft, not a refusal) the installer also
        // shows, kept for the same reason it always was: room for
        // everything ELSE a repair downloads besides the venv itself.
        if let Some(warning) = super::comfy_install::check_install_disk_pressure(&comfy_dir) {
            update("installing", &warning);
        }

        // Runde 3, Nachbesserung 6: the torch/Python preflight used to run
        // AFTER the old venv was already gone (`torch_python_preflight` sat
        // right before Step 2's download, well past the delete below). A
        // repair that then turned out to have no usable interpreter left the
        // customer with a freshly emptied venv folder and a failed run, the
        // exact "a healthy venv must never be destroyed for a run that then
        // fails anyway" case. Moving the check here, before `venv_dir` is
        // touched at all, means a repair that cannot proceed leaves the old
        // venv exactly as it was. Also folds in B1(b): LU picks the newest
        // interpreter that actually has a torch wheel itself, no Settings
        // picker, and the picked interpreter is what builds the new venv
        // further down instead of always `python_bin`.
        let (torch_args, gpu_info, torch_index, torch_packages) = plan_pytorch_install();
        let torch_package_refs: Vec<&str> = torch_packages.iter().map(|s| s.as_str()).collect();
        // Repair always rebuilds the venv from this interpreter, so the
        // strict ensurepip probe applies (Runde 6, F11).
        // Nothing on the machine fits: LU's own Python 3.12 instead of a
        // dead end (Discord 14.10.2026, a machine with only 3.15). Fetched
        // here, before the old venv is touched, like everything above.
        let decision = super::torch::choose_torch_python(&python_bin, torch_index.as_deref(), &torch_package_refs, "press \"Repair environment\" again", true);
        let progress = crate::private_python::StatusProgress { status: &install_status, cancel: &cancel_flag };
        let chosen_python = match super::torch::base_for_new_venv(decision, &python_bin, &progress, &|line| update("installing", line)) {
            Ok(path) => path,
            Err(e) if e == "cancelled" => {
                update("cancelled", "Repair cancelled while LU's own Python was being set up. Nothing was changed.");
                return;
            }
            Err(msg) => {
                update("error", &msg);
                return;
            }
        };

        // Runde 6, BLOCKER B9 (review Runde 5): Runde 5's build-then-swap
        // built the new venv under a staging name and renamed the folder
        // into place afterwards. A venv is not relocatable: every console
        // script's shebang, `pip`'s own launcher, and every activate script
        // bake in the ABSOLUTE path it was BUILT at, so that rename left
        // `venv/bin/pip` and every other script pointing at a staging folder
        // that no longer existed. See `venv::retire_for_rebuild`'s doc for
        // the measured proof. The fix: the OLD venv is retired (renamed
        // aside, reversibly (reversible because restoring it uses the EXACT
        // same name it already had) FIRST, and the NEW venv is then built
        // DIRECTLY under the final `venv` name via `create_comfyui_venv`, so
        // its build path and its resting path are the same string from the
        // very first `python -m venv` call. Never renamed again afterwards.
        //
        // OI-3: faster-whisper and Piper live in the OLD venv too. Read
        // BEFORE it is touched (it still is not, at this point).
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
                     reinstall them once the new environment is verified; do not close the app \
                     until that step is done.",
                    names.join(" and ")
                ),
            );
        }

        // Nothing of ours may still be running out of the OLD venv before it
        // is even RETIRED, or its files stay open on Windows and the rename
        // fails (see `venv::windows_lock_aware_retire_error`'s doc: this is
        // the same OI-3 reasoning Runde 5 applied right before its swap; it
        // has to run before the retire now, since the retire is the first
        // destructive step).
        if venv_dir.exists() {
            if let Ok(mut w) = whisper.lock() {
                if w.is_running() {
                    update(
                        "installing",
                        "Stopping the voice-input server, which runs from the existing \
                         environment. It restarts by itself the next time you use voice input.",
                    );
                    w.stop();
                }
            }
        }

        update("installing", "Step 1/4: Setting the existing environment aside...");
        let retired = match retire_for_rebuild(&venv_dir) {
            Ok(r) => r,
            Err(msg) => {
                update("error", &msg);
                return;
            }
        };

        // Every early return from here on has to leave the customer with a
        // WORKING venv again: either the freshly verified new one, or, on
        // ANY failure (a failed build, a failed download, a failed
        // requirements install, a failed verification, or the user
        // cancelling at any of those points), the retired old one restored.
        // One place, so that guarantee is enforced once instead of repeated
        // at each call site, the same reasoning Runde 5's `abandon_staging`
        // documented for the staging approach.
        let abort_and_restore = |status: &str, msg: &str, install_status: &std::sync::Arc<std::sync::Mutex<crate::state::InstallState>>| {
            let restore_note = match restore_after_failed_rebuild(&comfy_dir, &venv_dir, retired.clone()) {
                Ok(()) => String::new(),
                Err(e) => format!("\n\n{}", e),
            };
            if let Ok(mut s) = install_status.lock() {
                s.status = status.to_string();
                s.logs.push(format!("{msg}{restore_note}"));
            }
        };

        let venv_py = match create_comfyui_venv(&comfy_dir, &chosen_python, Some(&cancel_flag)) {
            Ok(p) => p.to_string_lossy().to_string(),
            Err(e) if e == "cancelled" => {
                abort_and_restore(
                    "cancelled",
                    "Repair cancelled while the new environment was being built. Your previous \
                     environment was restored.",
                    &install_status,
                );
                return;
            }
            Err(e) => {
                abort_and_restore(
                    "error",
                    &format!(
                        "Building the new environment failed. Your previous environment was \
                         restored.\n\n{}",
                        e
                    ),
                    &install_status,
                );
                return;
            }
        };

        update("installing", &format!("Step 2/4: {}", gpu_info));

        update(
            "installing",
            "Downloading PyTorch into the new environment (~2 GB). Live pip output below.",
        );
        let refs: Vec<&str> = torch_args.iter().map(|s| s.as_str()).collect();
        match pip_install_streaming_with_retry_cancellable(&refs, &venv_py, 3, &install_status, Some(&cancel_flag)) {
            Ok(()) => {
                update("installing", "PyTorch installed.");
                // 3.0.8: same check as the installer, see post_install_gpu_line.
                if torch_index.is_some() {
                    let sees = crate::commands::process::probe_comfy_gpu(&venv_py);
                    if let Some(line) = crate::commands::torch_wheels::post_install_gpu_line(
                        torch_index.as_deref(),
                        sees,
                        std::env::consts::OS,
                    ) {
                        update("installing", &line);
                    }
                }
            }
            Err(d) if d == "cancelled" => {
                abort_and_restore(
                    "cancelled",
                    "Repair cancelled during the PyTorch download. Your previous environment was \
                     restored.",
                    &install_status,
                );
                return;
            }
            Err(d) => {
                abort_and_restore(
                    "error",
                    &format!(
                        "PyTorch installation failed. Your previous environment was \
                         restored.\n\n{}",
                        d
                    ),
                    &install_status,
                );
                return;
            }
        }

        let reqs = comfy_dir.join("requirements.txt");
        // Checked once at the top already. Kept as a guard for the file being
        // renamed or deleted while the rebuild was running, which is a real
        // few minutes on a slow line.
        if !reqs.exists() {
            abort_and_restore("error", &missing_requirements_for_repair(&comfy_dir), &install_status);
            return;
        }
        {
            update(
                "installing",
                "Step 3/4: Installing ComfyUI dependencies into the new environment...",
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
                    abort_and_restore(
                        "cancelled",
                        "Repair cancelled during the requirements install. Your previous \
                         environment was restored.",
                        &install_status,
                    );
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

        // OI-3: put the passengers back, into the new environment. Failures
        // here are reported but do not fail the repair, since a working
        // ComfyUI is nearly ready at this point, and burying it under a
        // Piper wheel error would trade one silent loss for another. What
        // must never happen again is the repair finishing without saying
        // what happened to Voice.
        let mut lost: Vec<&str> = Vec::new();
        for p in &passengers {
            update(
                "installing",
                &format!("Reinstalling {} into the new environment...", p.label),
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
                    abort_and_restore(
                        "cancelled",
                        &format!(
                            "Repair cancelled while reinstalling {}. Your previous environment \
                             was restored.",
                            p.label
                        ),
                        &install_status,
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
        // rebuild that trusts pip's exit code rebuilds the same hole. Now
        // also the B9 gate: this is the LAST check before the retired old
        // venv is discarded for good, so a new environment that does not
        // import never leaves the customer with neither one.
        update("installing", "Step 4/4: Checking that the new environment really starts...");
        match verify_and_heal_environment(&venv_py, &comfy_dir, &reqs, &install_status, Some(&cancel_flag)) {
            Ok(()) => {}
            Err(e) if e == "cancelled" => {
                abort_and_restore(
                    "cancelled",
                    "Repair cancelled during the environment check. Your previous environment \
                     was restored.",
                    &install_status,
                );
                return;
            }
            Err(e) => {
                error!("comfyui env repair built an environment that does not import");
                abort_and_restore(
                    "error",
                    &format!(
                        "The new environment was built, but it still does not start, so your \
                         previous environment was restored instead of being replaced with one \
                         that does not work either.\n\n{}",
                        e
                    ),
                    &install_status,
                );
                return;
            }
        }

        // The new environment is built, populated and VERIFIED, and it is
        // already at its final path: nothing above this line ever renamed
        // it, so there is no swap left to do. Only now is the retired old
        // one discarded for good.
        update("installing", "Removing the previous, now-replaced environment...");
        finish_rebuild(&comfy_dir, retired);

        // Runde 5 Folgeposten (review Runde 4, Abschnitt 2): the repair's own
        // log line promises "custom nodes stay untouched", true for the
        // FOLDERS but not for what they import: their own requirements.txt
        // never followed the venv into the rebuild. Reusing
        // `install_node_requirements` (the same function `install_custom_node`
        // itself calls, #72's rule) against the now-final venv, one folder's
        // failure never stopping the rest.
        //
        // Runde 6, Folgeposten (a) (review Runde 5, F2): a node's own
        // requirements.txt (an unpinned old torch, a `numpy<2`, ...) must not
        // be allowed to quietly downgrade the core packages this repair just
        // spent four steps verifying. A constraints file built from THIS
        // venv's own `pip freeze` of torch/torchvision/torchaudio/numpy makes
        // pip refuse such a change outright: the node's own install fails
        // loudly and by name, through the existing per-node failure list,
        // instead of the environment silently regressing. `verify_and_heal_
        // environment` then runs a SECOND time after the whole node loop: a
        // node with an `install.py` or another way around the constraint
        // (F10, still open) could still break something the constraints file
        // does not cover, and this is the backstop for that.
        //
        // Runde 6, Folgeposten (b): a name and a log line per node while this
        // runs (there was one blanket sentence before), and the cancel flag
        // is now read between nodes, so twenty custom nodes no longer look
        // like a hang with a Cancel button that does nothing.
        let mut broken_nodes: Vec<(String, String)> = Vec::new();
        if comfy_dir.join("custom_nodes").is_dir() {
            let constraints = super::custom_nodes::write_package_constraints(&venv_py, &super::custom_nodes::CORE_PACKAGES);
            let outcome = super::custom_nodes::reinstall_all_node_requirements(
                &comfy_dir,
                &venv_py,
                constraints.as_deref(),
                Some(&cancel_flag),
                |name| update("installing", &format!("Restoring dependencies for {}...", name)),
            );
            if let Some(c) = &constraints {
                let _ = std::fs::remove_file(c);
            }
            for (name, _) in &outcome.failures {
                update("installing", &format!("Could not restore requirements for {}.", name));
            }
            if outcome.cancelled {
                update(
                    "cancelled",
                    "Repair cancelled while restoring custom node dependencies. ComfyUI's \
                     environment itself was already rebuilt and verified; some custom nodes may \
                     still be missing their own dependencies.",
                );
                return;
            }
            // Runde 6, F13 (review Runde 6, Abschnitt 5): see
            // `NodeReinstallOutcome::needs_reverification`'s own doc. This
            // gate used to run only when EVERY node succeeded, which skipped
            // it whenever an unrelated node failed even though a different
            // node had already installed something that could have damaged
            // the environment.
            if outcome.needs_reverification() {
                update(
                    "installing",
                    "Re-checking the environment after restoring custom node dependencies...",
                );
                if let Err(e) = verify_and_heal_environment(&venv_py, &comfy_dir, &reqs, &install_status, Some(&cancel_flag)) {
                    if e == "cancelled" {
                        update(
                            "cancelled",
                            "Repair cancelled during the post-restore environment check. ComfyUI's \
                             environment itself was already rebuilt and verified.",
                        );
                        return;
                    }
                    // A3: the same rule that governs the FIRST verification
                    // governs this one too. The constraints file above is
                    // the primary defense, but it cannot cover every way a
                    // node's own install could break something (an
                    // `install.py`, F10, still open); this is the backstop,
                    // and it must stop the run rather than report "complete"
                    // over an environment that no longer starts. The venv
                    // itself is left exactly as it is (its own build already
                    // passed verification once): only the node loop's
                    // outcome is undone, by naming it, not by rolling back
                    // the whole rebuild.
                    error!(nodes = ?outcome.reinstalled, "comfyui repair: custom node dependencies left the environment unable to start");
                    let suspects = outcome.reinstalled.join(", ");
                    update("error",
                        &format!(
                            "The environment was rebuilt and verified, but restoring custom node \
                             dependencies left it unable to start again. One of these likely \
                             caused it: {}. Disabling that node (move its folder out of \
                             custom_nodes and add .disabled to the name) and repairing again \
                             usually clears it.\n\n{}",
                            suspects, e
                        ),
                    );
                    return;
                }
            }
            broken_nodes = outcome.failures;
        }

        // What used to say "custom nodes stay untouched" unconditionally. That
        // was only ever true of the folders, not of what they import, and the
        // repair now actually restores their dependencies instead of merely
        // promising it (Runde 5 Folgeposten). What is reported here is
        // whichever of that restoration and the voice passengers above did NOT
        // make it back in, so the closing line stays true either way.
        let node_names: Vec<&str> = broken_nodes.iter().map(|(name, _)| name.as_str()).collect();
        let mut unrestored: Vec<&str> = lost.clone();
        unrestored.extend(node_names.iter().copied());
        let (notice_text, closing) = if unrestored.is_empty() {
            (
                "Repair finished. ComfyUI is ready.".to_string(),
                "Environment repaired. ComfyUI now runs from its own venv; start it again."
                    .to_string(),
            )
        } else {
            let names = unrestored.join(", ");
            (
                format!("Repair finished, but {} could not be fully restored.", names),
                format!(
                    "ComfyUI's environment is repaired and can be started again, but {} could not \
                     be fully restored into the new venv. Voice packages: reinstall from Settings. \
                     Custom nodes: reinstalling the node's own dependencies from its README, or \
                     reinstalling the node, usually fixes it.",
                    names,
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

/// What the customer is told when Update finds a ComfyUI on the configured
/// port that this app never started: not the tracked child from this run,
/// and not an earlier one it can still identify as its own (T-68's
/// `find_orphaned_comfyui`). Pulled out so the wording used to refuse the
/// update and the wording a test checks for cannot drift apart.
fn foreign_comfyui_blocks_update(port: u16) -> String {
    format!(
        "ComfyUI is running on port {port}, but this app did not start it. Close that ComfyUI \
         first, then run Update ComfyUI again. Nothing was changed."
    )
}

/// What the customer is told when Update refuses to interrupt a render.
/// box-gruen/n9 punkt 87, final review (B3): an own or adoptable ComfyUI used
/// to be killed on the spot, mid-render or not, and the work was gone with
/// nothing on screen to say so.
const COMFYUI_BUSY_REFUSAL: &str =
    "ComfyUI is generating something right now. Wait for it to finish, or stop the render \
     yourself, then run Update ComfyUI again. Nothing was changed.";

/// Whether ComfyUI's own `/queue` response (`{"queue_running": [...],
/// "queue_pending": [...]}`, the same shape `isPromptQueued` in
/// `comfyui.ts` reads) names any work at all. Pure and separate from the
/// HTTP call below so both directions are provable with a literal
/// `serde_json::Value`, no server required.
fn queue_has_work(body: &serde_json::Value) -> bool {
    let non_empty = |key: &str| {
        body.get(key)
            .and_then(serde_json::Value::as_array)
            .is_some_and(|a| !a.is_empty())
    };
    non_empty("queue_running") || non_empty("queue_pending")
}

/// Is ComfyUI on `port` doing anything right now? Read straight from its own
/// `/queue` endpoint, because Update is about to stop this process and a
/// customer mid-render has no other warning that the run is about to die.
///
/// Errs on the side of caution: a `/queue` that cannot be reached or parsed
/// answers `Err`, and the caller refuses the update rather than risk killing
/// a render it could not see.
fn comfyui_queue_busy(port: u16) -> Result<bool, String> {
    comfyui_queue_busy_with_timeout(port, std::time::Duration::from_secs(3))
}

/// Same check, with the HTTP timeout as a parameter so a test can hand it a
/// server that never answers without waiting out the real 3 s (final review
/// Runde 2, R2-2). `reqwest::blocking::get` has no deadline of its own; the
/// house pattern everywhere else that calls a local model server
/// (`engine_sanity.rs`, `mlx.rs`, `trainer.rs`, `ollama.rs`, `lmstudio.rs`,
/// `torch.rs`, `process.rs`) builds a `Client` with `.timeout(...)` instead,
/// and this does the same. A ComfyUI that holds the port but stopped
/// answering ("Not responding" in this same panel) used to hang this call,
/// and with it the whole `COMFY_JOB` lock, forever. A timed-out or failed
/// request is still an `Err` here, which the caller already turns into a
/// refusal, so a stalled ComfyUI fails closed exactly like an unreadable one.
fn comfyui_queue_busy_with_timeout(port: u16, timeout: std::time::Duration) -> Result<bool, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("could not build an HTTP client to check ComfyUI's queue: {e}"))?;
    let resp = client
        .get(format!("http://localhost:{port}/queue"))
        .send()
        .map_err(|e| format!("could not reach ComfyUI's queue: {}", crate::os_error::english(&e)))?;
    if !resp.status().is_success() {
        return Err(format!("ComfyUI's queue endpoint answered with {}", resp.status()));
    }
    let body: serde_json::Value = resp
        .json()
        .map_err(|e| format!("could not read ComfyUI's queue: {}", crate::os_error::english(&e)))?;
    Ok(queue_has_work(&body))
}

/// Poll `is_occupied` every `interval` until it reports the port free or
/// `cap` has passed, whichever comes first. Returns whether the port ended up
/// free.
///
/// Pure of any real I/O of its own (final review Runde 2, R2-1): the probe is
/// a closure, so both directions -- a port that frees up partway through the
/// wait, and one that never does -- are provable with a counting closure and
/// millisecond-scale durations, no real ComfyUI and no real 10 s wait in the
/// test suite.
fn wait_for_port_free(
    interval: std::time::Duration,
    cap: std::time::Duration,
    mut is_occupied: impl FnMut() -> bool,
) -> bool {
    let deadline = std::time::Instant::now() + cap;
    loop {
        if !is_occupied() {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(interval);
    }
}

/// Stop whatever ComfyUI this app itself is responsible for before Update
/// touches the checkout, and refuse outright if the port is held by anything
/// else or by a render in progress.
///
/// The own-vs-foreign line is `classify_comfyui_ownership`, the exact
/// question `comfyui_status`'s `ownedByApp` field answers for the panel, so
/// the two cannot disagree about the same ComfyUI (box-gruen/n9 punkt 87,
/// final review B2). The actual stop, once the ComfyUI is confirmed to be
/// ours, is `stop_comfyui_blocking` itself, the same function the Stop
/// button calls (final review B1): a bare `child.kill()` only signals the
/// direct child, and on Windows that can leave the real ComfyUI process
/// (a grandchild through a launcher) holding the port while the checkout
/// underneath it is rewritten. After the stop, the port is probed again: a
/// ComfyUI that refuses to die is not silently worked around.
///
/// Remote hosts are not this function's concern: `comfyui_status` never
/// offers the Update button once `isLocal` is false, and this app manages no
/// process there either way.
fn ensure_comfyui_stopped_for_update(state: &State<'_, AppState>) -> Result<(), String> {
    let port = *state.comfy_port.lock().unwrap();
    match stop_own_idle_comfyui(state) {
        OwnComfyStop::NotRunning | OwnComfyStop::Stopped => Ok(()),
        OwnComfyStop::Foreign => {
            println!("[Update] Refusing: port {port} is served by a ComfyUI this app did not start");
            Err(foreign_comfyui_blocks_update(port))
        }
        OwnComfyStop::Busy => {
            println!("[Update] Refusing: ComfyUI on port {port} is generating something");
            Err(COMFYUI_BUSY_REFUSAL.to_string())
        }
        OwnComfyStop::QueueUnknown(e) => {
            println!("[Update] Refusing: could not check ComfyUI's queue on port {port}: {e}");
            Err(format!(
                "Could not check whether ComfyUI is generating something right now, so the \
                 update was refused rather than risk interrupting a render ({e}). Nothing \
                 was changed."
            ))
        }
        OwnComfyStop::StopFailed(e) => Err(e),
        OwnComfyStop::StillRunning => Err(format!(
            "ComfyUI on port {port} did not stop, so the update was not started. Try \
             Stop in Settings, then run Update ComfyUI again. Nothing was changed."
        )),
    }
}

/// What became of the ComfyUI on the configured port when a job asked for it
/// to be out of the way.
pub(crate) enum OwnComfyStop {
    /// Nothing was serving the port (or the host is another machine).
    NotRunning,
    /// It was this app's own, it was idle, and it is down now.
    Stopped,
    /// A ComfyUI this app never started. Left alone.
    Foreign,
    /// This app's own, but it is rendering. Left alone.
    Busy,
    /// This app's own, but its queue could not be read. Left alone.
    QueueUnknown(String),
    /// The stop itself failed, with the reason.
    StopFailed(String),
    /// The stop went through and the port still answers.
    StillRunning,
}

/// Stop this app's own ComfyUI when it is idle, and say what was found. Never
/// touches a ComfyUI this app did not start and never interrupts a render.
/// Shared by Update ComfyUI and by a node pack whose requirements replace a
/// file the running ComfyUI holds open (custom_nodes.rs).
pub(crate) fn stop_own_idle_comfyui(state: &AppState) -> OwnComfyStop {
    let host = state.comfy_host.lock().unwrap().clone();
    if !crate::commands::process::is_local_host(&host) {
        return OwnComfyStop::NotRunning;
    }
    let port = *state.comfy_port.lock().unwrap();
    let port_occupied = crate::commands::process::is_comfyui_running_on_port(port);

    // Peeked, never taken: the actual stop happens inside
    // `stop_comfyui_blocking` below, in its own single lock. Reading the
    // handle here decides only whether this ComfyUI is ours to stop at all.
    // Skipped outright when nothing is even on the port, so the process-table
    // scan `find_orphaned_comfyui` only ever costs anything when it can
    // actually change the answer.
    let own_child_alive = port_occupied && {
        let mut proc = state.comfy_process.lock().unwrap();
        match proc.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => true,
                Ok(Some(_)) => {
                    *proc = None;
                    false
                }
                Err(_) => true,
            },
            None => false,
        }
    };
    let orphan_pid = if !port_occupied || own_child_alive {
        None
    } else {
        crate::commands::process::find_orphaned_comfyui(port)
    };

    // The real `port_occupied` goes into the classification (final review
    // Runde 2, R2-k3): a hardcoded `true` here, kept alive by the early
    // return that used to sit above this block, made the `NotRunning` arm
    // below dead code that only LOOKED like a check.
    match crate::commands::process::classify_comfyui_ownership(port_occupied, own_child_alive, orphan_pid) {
        crate::commands::process::ComfyOwnership::NotRunning => OwnComfyStop::NotRunning,
        crate::commands::process::ComfyOwnership::Foreign => OwnComfyStop::Foreign,
        crate::commands::process::ComfyOwnership::Own => {
            match comfyui_queue_busy(port) {
                Ok(true) => OwnComfyStop::Busy,
                Err(e) => OwnComfyStop::QueueUnknown(e),
                Ok(false) => {
                    let result = match crate::commands::process::stop_comfyui_blocking(state) {
                        Ok(r) => r,
                        Err(e) => return OwnComfyStop::StopFailed(e),
                    };
                    let status = result.get("status").and_then(|s| s.as_str()).unwrap_or("");
                    if status == "not_ours" {
                        // A race between the classify above and the stop: the
                        // handle exited and something else grabbed the port
                        // in between. Rare, and treated exactly like a plain
                        // foreign ComfyUI would be.
                        return OwnComfyStop::Foreign;
                    }
                    info!(port = port, status = status, "stopped the app's own idle ComfyUI");
                    // final review Runde 2, R2-1: a single check right here
                    // used to fire before the kill had actually landed.
                    // `stop_comfyui_blocking`'s own-child path reaps with
                    // `child.wait()`, but the adopted-orphan path
                    // (`process_util::kill_pid_tree`) sends SIGTERM and
                    // returns immediately on Unix, with the SIGKILL only
                    // following `KILL_GRACE` (800 ms) later on a background
                    // thread; `shell::kill_tree` on Windows likewise does not
                    // wait for the tree to actually exit. The immediate check
                    // therefore caught a ComfyUI LU had just killed a moment
                    // before, still mid-shutdown, and told the customer it
                    // "did not stop" -- untrue, and it pointed them at a Stop
                    // button with nothing left to stop. Poll instead, capped
                    // a little past the grace period.
                    if !wait_for_port_free(
                        std::time::Duration::from_millis(400),
                        std::time::Duration::from_secs(10),
                        || crate::commands::process::is_comfyui_running_on_port(port),
                    ) {
                        return OwnComfyStop::StillRunning;
                    }
                    OwnComfyStop::Stopped
                }
            }
        }
    }
}

/// Clear `install_status` back to its startup shape before a new run's
/// worker thread is even spawned.
///
/// final review Runde 4, R4-1: without this, `install_status` keeps
/// whatever the previous install/repair/update run left in it (`idle` is
/// only ever set once, in `InstallState::default`) for as long as the
/// running-instance guard is still deciding whether this run gets to start
/// at all -- up to 13s (R2-1/R2-2) before the worker thread writes anything
/// of its own. A poll landing in that window reads the STALE status as this
/// run's own outcome: a leftover `complete` reads as "already finished",
/// a leftover `error` or `cancelled` reads as this run having failed or
/// been cancelled before it even started, and every one of those three
/// stops the store's poll for good, so a genuine refusal the guard produces
/// afterward is never shown. `idle` is deliberately not a stop condition for
/// the poll (only `complete`/`error`/`cancelled` are), so watching carries
/// on right through the guard's wait until the worker writes "installing" or
/// its own refusal.
fn reset_install_status_for_new_run(state: &AppState) {
    let mut install = state.install_status.lock().unwrap();
    install.status = "idle".to_string();
    install.logs.clear();
    install.notice.clear();
    install.notice_kind.clear();
}

/// Update an existing ComfyUI install in place: `git pull --ff-only` plus a
/// venv-aware `pip install -r requirements.txt`. Since 3.0.9 a ComfyUI that
/// LU cloned itself is set to the pinned release instead of pulled
/// (comfy_pin.rs); a ComfyUI the customer brought keeps the pull. The 2.5.8 local Create lanes
/// (music / talking character / extend / motion) need node classes that ship
/// with current ComfyUI cores, and the UI gates on node PRESENCE, so when the
/// nodes are missing this command is the one-click "Update ComfyUI" path.
/// Progress streams through the same `install_status` channel the installer
/// uses, so the existing `install_comfyui_status` polling UI works unchanged.
// final review Runde 3, R3-1: this stays a plain, synchronous
// `#[tauri::command]`, NOT `#[tauri::command(async)]`. The running-instance
// guard below (`ensure_comfyui_stopped_for_update`) and the git/pip work
// after it are all `reqwest::blocking`/`std::process::Command`, and running
// those on a Tokio async worker panics (`lmstudio.rs:320`'s note on the same
// trap); this repo has no `#[tauri::command(async)]` that calls
// `reqwest::blocking`, and this function does not become the first. `app` is
// only here so the worker thread below can re-resolve `AppState` for itself,
// the same pattern `fix_comfyui_cors`/`cancel_character_training` use to
// cross into `spawn_blocking`. See `ensure_comfyui_stopped_for_update_runs_
// inside_the_worker_thread_not_on_the_main_thread` for the guard that pins
// this.
#[tauri::command]
pub fn update_comfyui(state: State<'_, AppState>, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    // OI-5: same lock as install and repair. This command's old guard was the
    // strictest of the three ("installing" OR "downloading"), which is exactly
    // why the inconsistency was invisible from here — it was the other two
    // that let a job in mid-clone.
    let job_guard = match COMFY_JOB.try_acquire(ComfyJob::Update) {
        Ok(g) => g,
        Err(ComfyJob::Update) => return Ok(serde_json::json!({"status": "already_installing"})),
        Err(running) => return Err(comfy_job_busy_message(ComfyJob::Update, running)),
    };

    // The update runs through the same status slot, the same panel and the
    // same Cancel button as the install, so it gets the same flag. Reset
    // first, for the reason install_comfyui resets it (Bug #1): a previously
    // cancelled run would otherwise abort this one on the first poll. Cheap
    // (an atomic store plus an Arc clone), so it stays here on the caller's
    // thread rather than moving into the worker below.
    state.comfyui_install_cancel.store(false, Ordering::SeqCst);
    let cancel_flag = state.comfyui_install_cancel.clone();

    // final review Runde 4, R4-1: this command returns immediately, but
    // `install.status` is only set to "installing" inside the worker thread
    // below, AFTER the running-instance guard (up to 3s queue check plus up
    // to 10s port-free poll, R2-1/R2-2). `install_status` is never reset to
    // "idle" between runs (`state.rs`'s `InstallState::default` is the only
    // place that ever writes "idle", and only at process startup) -- it just
    // carries whatever the LAST install/repair/update run left behind. The
    // panel starts polling `install_comfyui_status` 2s after this call
    // (comfyInstallStore's POLL_MS), which can land well inside the guard's
    // wait, and the poll's own `complete`/`error`/`cancelled` branches all
    // stop watching right there: a stale "complete" from an earlier run read
    // as this run's own end, "Update finished" shown for an update that had
    // not even started yet, and any refusal the guard produces afterward
    // never reaches the screen because nothing is watching anymore. Clearing
    // the slot back to "idle" here, on the caller's thread, is one Mutex
    // write with no wait of its own, so R3-1 (nothing here blocks the main
    // thread) stays intact; "idle" itself is not one of the terminal states
    // the store's poll treats as the run being over, so it keeps watching
    // right through the guard's wait until the worker writes "installing" or
    // an "error" refusal.
    reset_install_status_for_new_run(state.inner());

    std::thread::spawn(move || {
        let _job_guard = job_guard;
        // Re-resolved from the AppHandle, not the `state` argument above: a
        // `State<'_, AppState>` borrow cannot cross into a spawned thread.
        // Same instance either way, Tauri hands out one shared AppState.
        let state = app.state::<AppState>();
        let install_status = state.install_status.clone();
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = install_status.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        // box-gruen/n9 Punkt 87 (ENG-18): the button used to start "Installing
        // ComfyUI…" with no lock at all, even with a ComfyUI already serving
        // the configured port, be that the app's own or a copy started
        // outside LU. A Cancel taken 1-2 seconds later left a real Windows
        // box with a pulled core and a venv that never finished,
        // `ModuleNotFoundError: No module named 'comfy_aimdo.storage'` on the
        // next start.
        //
        // Same split Stop already draws (`find_orphaned_comfyui`, T-68): a
        // process LU itself started, whether the tracked child from this run
        // or one it started in an earlier run and lost the handle to, is
        // stopped cleanly here before anything touches the checkout. A
        // process this app never launched is left alone; the update is
        // refused instead.
        //
        // final review Runde 3, R3-1: this guard used to run right here but
        // on the CALLER's thread, before this worker thread even existed,
        // i.e. on the Tauri main thread, freezing the window for as long as
        // the guard's own waits took (up to 3 s for the queue check plus up
        // to 10 s for the port-free poll, R2-1/R2-2, worst case over 13 s
        // with "Not responding" over the window the whole time). Moved into
        // the worker thread this function already spawns for the rest of the
        // update, so it now costs the same time without ever blocking the
        // window; its refusal is reported through the same `install_status`
        // slot every other guard below already uses, so the panel shows the
        // identical English wording either way, just from `install_status`
        // instead of a thrown error. The "nothing was changed" property is
        // unaffected: this still runs before anything below touches the
        // checkout.
        if let Err(msg) = ensure_comfyui_stopped_for_update(&state) {
            error!("comfyui update aborted: {}", msg);
            update("error", &msg);
            return;
        }

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
        let Some(comfy_dir) = comfy_dir else {
            let msg = "ComfyUI not found. Install ComfyUI first.";
            error!("comfyui update aborted: {}", msg);
            update("error", msg);
            return;
        };
        if !comfy_dir.join(".git").exists() {
            // Portable / zip installs carry no git metadata, nothing to pull.
            let msg = "This ComfyUI was not installed from git, so it can't be updated in place. \
                        Update it with its own updater, or reinstall from Settings.";
            error!("comfyui update aborted: {}", msg);
            update("error", msg);
            return;
        }

        // Runde 6, F12: same reasoning as install_comfyui's call. Without this,
        // an Update pressed after a Repair that crashed mid rebuild reads
        // `comfy_venv_state` below as `Absent` (the retired `venv.lu-old-*`
        // sibling is not named `venv`), falls back to the system Python, and
        // never notices the several-gigabyte orphan sitting right next to it.
        // A no-op once a usable `venv` already exists.
        restore_orphaned_venv_if_needed(&comfy_dir);

        // Prefer the install's venv Python (same preference the launcher uses);
        // refuse without a usable interpreter, since a pulled core with stale
        // requirements is worse than no update (frontend package pins move often).
        // P3: the same third answer the launcher has. Updating into the system
        // Python while ComfyUI can only ever start out of this venv leaves the
        // hole exactly where it was, one git pull further along.
        let python_bin = match crate::python::comfy_venv_state(&comfy_dir) {
            crate::python::ComfyVenv::Usable(p) => p,
            crate::python::ComfyVenv::Broken { venv_dir, interpreter } => {
                let msg = crate::commands::process::comfy_broken_venv_message(&venv_dir, &interpreter);
                error!("comfyui update aborted: {}", msg);
                update("error", &msg);
                return;
            }
            // Discord 14.10.2026: the Python that holds this install's torch,
            // not whatever LU resolves as its default today.
            crate::python::ComfyVenv::Absent => {
                let default = state.python_bin.lock().unwrap().clone();
                match crate::commands::process::bound_comfy_python(&comfy_dir, &default) {
                    Some(p) => p,
                    None => {
                        let msg = crate::commands::process::comfy_no_torch_python_message(&comfy_dir);
                        error!("comfyui update aborted: {}", msg);
                        update("error", &msg);
                        return;
                    }
                }
            }
        };
        if python_bin.is_empty() || !crate::python::is_real_python(&python_bin) {
            let msg = "No usable Python found for this ComfyUI. Press \"Repair environment\" in Settings: LU builds ComfyUI an environment of its own, then retry the update.";
            error!("comfyui update aborted: {}", msg);
            update("error", msg);
            return;
        }

        // Set when `pip install -r requirements.txt` failed and the run carried
        // on with the packages LU knows about. Folder plus reason, so the live
        // log line and the line the finished run leaves behind agree (A15).
        let mut requirements_fallback: Option<(String, &'static str)> = None;

        #[cfg(target_os = "windows")]
        {
            let probe = windows_git_probe();
            if probe == WindowsGitState::Missing {
                update("error", &windows_git_install_hint(&probe).unwrap_or_default());
                return;
            }
        }

        // Linux setup stolpstein (BERICHT-5-APPIMAGE.md): fresh Debian 13
        // and Fedora 43 cloud/desktop images ship no git at all. Probe
        // before the `git pull --ff-only` below touches anything.
        if let Some(hint) = super::git::git_download_preflight() {
            update("error", &hint);
            return;
        }

        // Runde 6, F8 (review Runde 5, same objection as Runde 4 raised for
        // the Install path): this preflight used to sit AFTER `git pull
        // --ff-only`, so an update on a venv with no compatible interpreter
        // still mutated the checkout (fast-forwarded to a newer ComfyUI)
        // before telling the customer their environment cannot be updated
        // at all. The check itself only needs `python_bin` (already known)
        // and the live index, neither of which depends on the pull having
        // happened, so it moves ahead of it: a run that is going to refuse
        // now refuses before touching the repository, exactly the "nothing
        // was changed" property Install and Repair already have.
        let (_torch_args, _gpu_info, torch_index, torch_packages) = plan_pytorch_install();
        let torch_package_refs: Vec<&str> = torch_packages.iter().map(|s| s.as_str()).collect();
        // Runde 6, F11: Update never rebuilds the venv, so the light probe
        // (ssl, pip) applies, not the ensurepip probe a venv build would need.
        match super::torch::choose_torch_python(&python_bin, torch_index.as_deref(), &torch_package_refs, "press \"Update ComfyUI\" again", false) {
            super::torch::TorchPythonDecision::Proceed => {}
            super::torch::TorchPythonDecision::UseInstead { path, current_version, chosen_version } => {
                update("error", &super::torch::existing_venv_needs_repair_message(current_version, &path, chosen_version));
                return;
            }
            super::torch::TorchPythonDecision::UseOwn { current_version, own_version } => {
                update("error", &super::torch::existing_venv_needs_own_python_message(current_version, own_version));
                return;
            }
            super::torch::TorchPythonDecision::Blocked(msg) => {
                update("error", &msg);
                return;
            }
        }

        // box-gruen/n9 Punkt 87 (ENG-18 Nebenfund): the real damage on the
        // Windows box was not the missing lock above, it was what a Cancel
        // taken 1-2 seconds after the click left behind. `git pull` had
        // already moved HEAD to a newer ComfyUI, and the pip step that new
        // core needs never got to run, so the next start died on an import
        // the old venv had no reason to carry. `old_commit` is where a
        // cancel or a hard failure below rolls the checkout back to, so a
        // half-finished update never outlives the run that started it.
        //
        // Recorded only when the tree is clean: `git reset --hard` on a
        // dirty checkout would erase whatever the customer changed by hand,
        // and that is worse than refusing the update outright and saying
        // why, so a dirty tree never gets this far.
        let old_commit = match git_dirty_lines(&comfy_dir) {
            Ok(dirty) if dirty.is_empty() => match git_current_commit(&comfy_dir) {
                Ok(commit) => commit,
                Err(e) => {
                    update(
                        "error",
                        &format!(
                            "Could not read the current ComfyUI version, so a failed or cancelled \
                             update could not be rolled back safely. Nothing was changed.\n\n{}",
                            e
                        ),
                    );
                    return;
                }
            },
            Ok(dirty) => {
                // box-gruen/n9 punkt 87, final review (B5): `dirty` already
                // excludes LU's own venv rebuild siblings
                // (`venv.lu-old-*`/`venv.lu-new-*`/`venv.lu-failed-*`), so
                // whatever is left here is genuinely the customer's, and the
                // message names it instead of a blanket "you changed
                // something".
                update(
                    "error",
                    &format!(
                        "The ComfyUI folder has local changes, so a failed or cancelled update could \
                         not be rolled back safely without erasing them. Commit or discard these, \
                         then retry. Nothing was changed.\n\n{}",
                        dirty.join("\n"),
                    ),
                );
                return;
            }
            Err(e) => {
                update(
                    "error",
                    &format!("Could not check the ComfyUI folder for local changes. Nothing was changed.\n\n{}", e),
                );
                return;
            }
        };

        // 3.0.9: a ComfyUI LU cloned itself is set to the release LU tested
        // (comfy_pin.rs: fetch the tags, check the pinned one out), never
        // pulled to master. A ComfyUI the customer brought along has no LU
        // marker and keeps the fast-forward pull of its own branch below.
        if super::comfy_pin::is_lu_installed(&comfy_dir) {
            let tag = super::comfy_pin::COMFYUI_PINNED_TAG;
            update("installing", &format!("Step 1/3: Setting ComfyUI to the tested release {tag}..."));
            match super::comfy_pin::checkout_pinned_tag(&comfy_dir, tag, true) {
                Ok(super::comfy_pin::PinOutcome::AlreadyThere) => {
                    update("installing", &format!("ComfyUI is already on {tag}."));
                }
                Ok(super::comfy_pin::PinOutcome::Moved) => {
                    update("installing", &format!("ComfyUI moved to {tag}."));
                }
                Err(e) => {
                    // Nothing moved: checkout_pinned_tag only checks out a tag
                    // it found, so the checkout is still on `old_commit`.
                    update(
                        "error",
                        &format!("Could not set ComfyUI to {tag}. Nothing was changed.\n\n{e}"),
                    );
                    return;
                }
            }
        } else {
        update("installing", "Step 1/3: Pulling the latest ComfyUI...");
        let mut pull = crate::process_util::foreign_system_command("git");
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
                    update("cancelled", &rollback_after_cancelled_update(&comfy_dir, &old_commit, "the requirements install"));
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
        if let Err(e) = verify_and_heal_environment(&python_bin, &comfy_dir, &reqs, &install_status, Some(&cancel_flag)) {
            if e == "cancelled" {
                update("cancelled", &rollback_after_cancelled_update(&comfy_dir, &old_commit, "the environment check"));
                return;
            }
            error!("comfyui update left an environment that does not import");
            update("error", &format!("ComfyUI was updated, but its Python environment is not usable.\n\n{}", e));
            return;
        }

        println!("[Update] ComfyUI update complete");
        // The box, 03.10.2026: the guard at the top stopped LU's own ComfyUI,
        // and the run ended on "Restart ComfyUI to load the new nodes" with
        // the status on Stopped. It comes back up here, before `complete`:
        // the panel and a render that asked for this update both stop
        // watching on that word, and the render goes on as soon as the port
        // answers. A start that fails does not undo the update, it is said in
        // the closing line with its reason.
        update("installing", "Starting ComfyUI again...");
        let restarted = crate::commands::process::start_comfyui_blocking(&state).map(|_| ());
        let (done, restart_failed) = update_finished_line(&restarted);
        if let Ok(mut s) = install_status.lock() {
            let (line, kind) = finished_notice(&done, requirements_fallback.as_ref());
            s.notice = line;
            s.notice_kind = if restart_failed { "warn" } else { kind }.to_string();
        }
        update("complete", &done);
    });

    Ok(serde_json::json!({"status": "installing"}))
}

/// The closing line of an update, and whether it is a warning: ComfyUI is on
/// its way up again, or it did not start and here is why.
fn update_finished_line(restarted: &Result<(), String>) -> (String, bool) {
    match restarted {
        Ok(()) => ("Update finished. ComfyUI is starting again with the new nodes.".to_string(), false),
        Err(reason) => (
            format!("Update finished, but ComfyUI did not start again. Press Start to try again.\n\n{reason}"),
            true,
        ),
    }
}

/// LU's own throwaway siblings inside a ComfyUI checkout, none of them named
/// in ComfyUI's own `.gitignore`.
///
/// box-gruen/n9 punkt 87, final review (B5): `retire_venv` (`venv.rs`) parks
/// the previous venv at `venv.lu-old-<stamp>` right next to the checkout
/// while the new one is built, and a rebuild that fails leaves a half-built
/// one at `venv.lu-failed-<stamp>` until a background thread deletes it
/// (`restore_after_failed_rebuild`); `venv.lu-new-*` is the same idea during
/// a build that has not yet been renamed to plain `venv`. A crash or a
/// cancelled Repair can leave one of these sitting in the checkout, and
/// without this list `git status --porcelain` sees it as a local change:
/// Update would then refuse every single time afterwards and blame the
/// customer for LU's own leftovers, on exactly the boxes where something
/// already went wrong once.
const LU_VENV_SCRATCH_PREFIXES: [&str; 3] = ["venv.lu-old-", "venv.lu-new-", "venv.lu-failed-"];

/// Does this one `git status --porcelain` line belong to one of LU's own
/// venv rebuild siblings? Porcelain lines are two status characters, a
/// space, then the path (`"?? venv.lu-old-171.../"` for an untracked
/// directory), so the path starts at byte 3; that slice is always a valid
/// UTF-8 boundary because the status characters and the separator are ASCII.
fn is_lu_venv_scratch_status_line(line: &str) -> bool {
    let path = line.get(3..).unwrap_or("").trim_start();
    LU_VENV_SCRATCH_PREFIXES.iter().any(|prefix| path.starts_with(prefix))
}

/// The `git status --porcelain` lines that count as "dirty" for Update's
/// rollback safety check: every real line except LU's own venv rebuild
/// siblings (`LU_VENV_SCRATCH_PREFIXES`), which Update and Repair produce
/// themselves and must never blame on the customer. Empty means the tree is
/// safe to pull and, if needed later, safe to `git reset --hard` back out of.
fn git_dirty_lines(dir: &Path) -> Result<Vec<String>, String> {
    let mut cmd = crate::process_util::foreign_system_command("git");
    cmd.args(["status", "--porcelain"])
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().map_err(|e| os_error::english(&e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text
        .lines()
        .filter(|line| !line.trim().is_empty() && !is_lu_venv_scratch_status_line(line))
        .map(str::to_string)
        .collect())
}

/// The commit `dir` is on right now, as `git rev-parse HEAD` reports it.
fn git_current_commit(dir: &Path) -> Result<String, String> {
    let mut cmd = crate::process_util::foreign_system_command("git");
    cmd.args(["rev-parse", "HEAD"])
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().map_err(|e| os_error::english(&e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let commit = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if commit.is_empty() {
        return Err("git rev-parse HEAD printed nothing".to_string());
    }
    Ok(commit)
}

/// Move `dir` back to `commit` with `git reset --hard`.
///
/// Only ever called from `update_comfyui`, and only on a checkout
/// `git_dirty_lines` found empty (LU's own venv scratch siblings aside)
/// right before the pull that moved it away from `commit`: a hard reset
/// otherwise destroys uncommitted work, which is exactly what recording the
/// commit only on a clean tree exists to prevent.
fn git_reset_hard(dir: &Path, commit: &str) -> Result<(), String> {
    let mut cmd = crate::process_util::foreign_system_command("git");
    cmd.args(["reset", "--hard", commit])
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().map_err(|e| os_error::english(&e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// The first 8 characters of a commit hash, for a message a customer might
/// actually read. Falls back to the whole string if it is somehow shorter.
fn short_commit(commit: &str) -> &str {
    &commit[..commit.len().min(8)]
}

/// What Update tells the customer once a cancel has landed at `stage`,
/// AFTER `git pull` already moved the checkout past `old_commit`.
///
/// Rolls the checkout back so a cancelled update never leaves a newer
/// ComfyUI core wired to an older or half-installed venv, the exact shape
/// of the real damage box-gruen/n9 punkt 87 found on a Windows box
/// (`ModuleNotFoundError: No module named 'comfy_aimdo.storage'` after a
/// Cancel taken 1-2 seconds into the run). Packages pip already installed or
/// upgraded before the cancel took effect cannot be un-installed by moving
/// the code back, so the message says that honestly instead of promising a
/// clean rollback.
fn rollback_after_cancelled_update(comfy_dir: &Path, old_commit: &str, stage: &str) -> String {
    match git_reset_hard(comfy_dir, old_commit) {
        Ok(()) => format!(
            "Update cancelled during {stage}. The ComfyUI code was rolled back to the version \
             from before the update ({short}). Some packages may already have been installed or \
             upgraded before the cancel took effect, so they could be slightly ahead of that \
             code; if ComfyUI does not start, run Update ComfyUI again to finish it, or Repair \
             environment to rebuild the packages from scratch.",
            short = short_commit(old_commit),
        ),
        Err(e) => format!(
            "Update cancelled during {stage}, and the code could not be rolled back automatically \
             ({e}). ComfyUI's code and its installed packages may now be out of step; run Update \
             ComfyUI again to finish it, or Repair environment to rebuild the packages from \
             scratch.",
        ),
    }
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

/// The total size on disk of everything under `dir`, in bytes. Best-effort:
/// a file that vanishes mid-walk (a background delete, a concurrent process)
/// is simply skipped rather than failing the whole measurement, since this
/// feeds a space ESTIMATE, not an exact accounting.
fn dir_size(dir: &Path) -> u64 {
    walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// Pure core of [`check_repair_disk_pressure`]: free bytes, the existing
/// venv's measured size and the mount point label (for the message only)
/// in, the refusal message (or `None` to proceed) out. Kept separate from
/// the disk enumeration below so the threshold arithmetic and the wording
/// are a plain unit test on every host, the same split
/// `git_download_preflight_core` (git.rs) uses for the same reason: the OS
/// read stays a thin, untested shell around a tested decision.
///
/// No behaviour change from before the split: same 5 GB constant, same
/// `saturating_add`, same strict `<` comparison (free space exactly equal
/// to the requirement is enough), same message text.
fn check_repair_disk_pressure_core(free_bytes: u64, existing_bytes: u64, mount_point: &str) -> Option<String> {
    let needed_for_new_build: u64 = 5 * 1024 * 1024 * 1024;
    let required = needed_for_new_build.saturating_add(existing_bytes);
    if free_bytes < required {
        return Some(format!(
            "Not enough free space to rebuild this environment. The existing environment is \
             about {:.1} GB, and building a new one alongside it before the old one is removed \
             needs about 5 GB more ({:.1} GB total); only {:.1} GB is free on {}. Free up space \
             and try again; nothing was changed.",
            existing_bytes as f64 / 1_073_741_824.0,
            required as f64 / 1_073_741_824.0,
            free_bytes as f64 / 1_073_741_824.0,
            mount_point,
        ));
    }
    None
}

/// Runde 6, B9: the old venv and the new one sit on the same drive at the
/// same time now, from the moment the old one is retired until the new one
/// passes verification. `check_install_disk_pressure`'s flat 5 GB estimate
/// (still shown as a soft warning right after this) never accounted for
/// that second copy, and it never refused outright either. This does both:
/// it adds the existing venv's real, measured size to the ~5 GB a fresh
/// build needs, and it is a REFUSAL, run before `retire_for_rebuild` touches
/// anything, so a drive that genuinely cannot hold both says so honestly
/// up front instead of failing part-way through with the old venv already
/// gone.
///
/// `None` both when the drive cannot be identified (same fallback
/// `check_install_disk_pressure` uses) and when there is no existing venv at
/// all yet: a first build's own soft warning already covers that case.
fn check_repair_disk_pressure(comfy_dir: &Path, venv_dir: &Path) -> Option<String> {
    if !venv_dir.exists() {
        return None;
    }
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    let normalized = comfy_dir.to_path_buf();
    let mut best: Option<&sysinfo::Disk> = None;
    let mut best_len: usize = 0;
    for d in &disks {
        let mp = d.mount_point();
        if normalized.starts_with(mp) {
            let len = mp.as_os_str().len();
            if len > best_len {
                best_len = len;
                best = Some(d);
            }
        }
    }
    let disk = best?;
    let free_bytes = disk.available_space();
    let existing_bytes = dir_size(venv_dir);
    check_repair_disk_pressure_core(free_bytes, existing_bytes, &disk.mount_point().to_string_lossy())
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
        let build = src.find(&needle("\"Step 1/4: Setting the existing environ", "ment aside...\");"))
            .expect("the retire-the-old-venv step is gone");
        let torch = src.find(&needle("\"Downloading PyTorch into the new env", "ironment (~2 GB). Live pip output below.\","))
            .expect("the PyTorch step is gone");
        assert!(call < build, "the precheck runs after the old venv is retired");
        assert!(call < torch, "the precheck runs after the PyTorch download");

        // And the guard on the guard: each needle occurs EXACTLY once in the
        // file. Two occurrences would mean this test body carries a copy of
        // the line it is looking for, which is how the three `.expect`s above
        // became unreachable in the first place.
        for (what, n) in [
            ("the precheck call", needle("if let Err(msg) = repair_prech", "eck(&comfy_dir) {")),
            ("the retire-the-old-venv step", needle("\"Step 1/4: Setting the existing environ", "ment aside...\");")),
            ("the PyTorch step", needle("\"Downloading PyTorch into the new env", "ironment (~2 GB). Live pip output below.\",")),
        ] {
            assert_eq!(
                src.matches(&n).count(),
                1,
                "{what}: the search string finds itself in this test, so its .expect can never fire",
            );
        }
    }

    #[test]
    fn the_repair_never_discards_the_old_venv_before_the_new_one_is_verified() {
        // Runde 6, B9: the old venv used to be RENAMED INTO the new venv's
        // build folder (Runde 5's staging approach), which left every
        // console script's shebang pointing at a name that no longer
        // existed. Now the old venv is only ever RETIRED (a reversible
        // rename, back to the exact name it already had if anything fails)
        // and the new one is built DIRECTLY at the final `venv` name, never
        // renamed at all. What still has to hold: the retired old venv is
        // discarded for good (`finish_rebuild`) only strictly after the new
        // one, built at the final name, has passed verification.
        //
        // Same shape as the precheck order test above, and for the same
        // reason: the body is a thread inside a Tauri command, so the order
        // is read out of this file. Needles split in half so they never
        // match themselves here.
        let src = include_str!("comfy_repair.rs");
        let needle = |head: &str, tail: &str| format!("{head}{tail}");

        let retire = needle("let retired = match retire_for_reb", "uild(&venv_dir) {");
        let build = needle("let venv_py = match create_comfyui_v", "env(&comfy_dir, &chosen_python, Some(&cancel_flag)) {");
        let verify = needle("verify_and_heal_environment(&venv_p", "y, &comfy_dir, &reqs, &install_status, Some(&cancel_flag))");
        let finish = needle("finish_rebuild(&comfy_d", "ir, retired);");

        let at_retire = src.find(&retire).expect("the retire-for-rebuild call is gone");
        let at_build = src.find(&build).expect("the new venv is no longer built directly at the final name");
        let at_verify = src.find(&verify).expect("the verify-and-heal call on the new venv is gone");
        let at_finish = src.find(&finish).expect("the old venv is no longer discarded via finish_rebuild");

        assert!(at_retire < at_build, "the old venv is retired after the new one is already being built");
        assert!(at_build < at_verify, "the new venv is verified before it is even built");
        assert!(at_verify < at_finish, "the old venv is discarded before the new one is verified");

        // The old way out has to be gone, not merely bypassed. Any direct
        // `retire_venv`/`remove_dir_all` on the OLD venv outside of
        // `retire_for_rebuild`, `restore_after_failed_rebuild` and
        // `finish_rebuild` would bring back exactly the failure mode this
        // guards against.
        assert!(
            !src.contains(&needle("retire_venv(&venv", "_dir)")),
            "something in this file still retires the old venv directly, outside retire_for_rebuild"
        );
        assert!(
            !src.contains(&needle("std::fs::remove_dir_all(&venv", "_dir)")),
            "something in this file still deletes the old venv directly, outside the venv module's own helpers"
        );

        // verify_and_heal_environment runs a SECOND time after the custom
        // node dependency restore (Runde 6, Folgeposten a); every other
        // needle is expected exactly once.
        for (what, n, expected) in [
            ("the retire call", retire, 1),
            ("the venv build call", build, 1),
            ("the verify call", verify, 2),
            ("the finish_rebuild call", finish, 1),
        ] {
            assert_eq!(
                src.matches(&n).count(),
                expected,
                "{what}: expected {expected} occurrence(s) in this file",
            );
        }
    }

    /// Runde 6, F12: Update reads `comfy_venv_state` synchronously, before
    /// even spawning its worker thread, to decide which Python to install
    /// requirements into. Without recovering an orphaned `venv.lu-old-*`
    /// first, that read comes back `Absent` and Update silently falls back
    /// to the system Python instead of adopting the recoverable venv, the
    /// exact failure mode F12 is about, just from the Update button instead
    /// of Install.
    #[test]
    fn update_also_recovers_an_orphaned_venv_before_reading_the_venv_state() {
        let src = include_str!("comfy_repair.rs");
        let needle = |head: &str, tail: &str| format!("{head}{tail}");

        let update_fn_start = src.find("pub fn update_comfyui(").expect("update_comfyui is gone");
        let recovery_call = needle("restore_orphaned_venv_if_needed(&comfy_d", "ir);");
        let venv_state_read = needle("comfy_venv_state(&comfy_d", "ir)");

        // Both needles occur twice in the file (Repair has its own copies);
        // only the occurrence inside update_comfyui, i.e. after its `fn`
        // keyword, is what this test is about.
        let at_recovery = src[update_fn_start..].find(&recovery_call).map(|i| i + update_fn_start).expect("update_comfyui no longer recovers an orphaned venv");
        let at_state_read = src[update_fn_start..].find(&venv_state_read).map(|i| i + update_fn_start).expect("update_comfyui no longer reads the venv state");

        assert!(at_recovery < at_state_read, "orphan recovery must run before update_comfyui reads the venv state");
    }

    /// Runde 6, F8 (review Runde 5, same objection as Runde 4 raised for
    /// Install): Update used to run `git pull --ff-only` before the torch
    /// preflight, so an update on a venv with no compatible interpreter
    /// still fast-forwarded the checkout before telling the customer
    /// anything. The preflight (`choose_torch_python`) needs only
    /// `python_bin`, already known before the pull, so it must run first.
    #[test]
    fn update_checks_the_interpreter_before_pulling_the_repository() {
        let src = include_str!("comfy_repair.rs");
        let needle = |head: &str, tail: &str| format!("{head}{tail}");

        let update_fn_start = src.find("pub fn update_comfyui(").expect("update_comfyui is gone");
        let preflight_call = needle("choose_torch_python(&python_bin, torch_index.as_deref(), &torch_package_refs, \"press \\\"Update", " ComfyUI\\\" again\", false)");
        let pull_start = needle("Pulling the latest Comfy", "UI...");

        let at_preflight = src[update_fn_start..].find(&preflight_call).map(|i| i + update_fn_start).expect("update_comfyui no longer checks torch/Python compatibility");
        let at_pull = src[update_fn_start..].find(&pull_start).map(|i| i + update_fn_start).expect("the git pull step marker is gone");

        assert!(at_preflight < at_pull, "the interpreter preflight must run before git pull touches the checkout");
    }

    // ── box-gruen/n9 Punkt 87 (ENG-18): the running-instance lock, and the
    //    "no half state" rollback for a cancel between pull and pip ─────────

    /// Builds a throwaway git repo with one commit, `HEAD~1`'s file content
    /// `"a"` and `HEAD`'s `"b"`, and returns `(tempdir, dir, commit_a,
    /// commit_b)`. Real `git`, no mocking: the rollback this guards
    /// (`git reset --hard` after a cancelled update) is exactly the kind of
    /// thing a source-only needle test cannot prove.
    fn two_commit_repo() -> (tempfile::TempDir, PathBuf, String, String) {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("ComfyUI");
        std::fs::create_dir(&dir).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&dir)
                .env("GIT_AUTHOR_NAME", "test")
                .env("GIT_AUTHOR_EMAIL", "test@example.com")
                .env("GIT_COMMITTER_NAME", "test")
                .env("GIT_COMMITTER_EMAIL", "test@example.com")
                .output()
                .unwrap();
            assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-q"]);
        // Make this repo's line-ending behaviour independent of the user's
        // (or CI machine's) global git config. On Windows, a global
        // core.autocrlf=true rewrites "a\n" to "a\r\n" on checkout, which
        // breaks the exact string comparisons below even though the
        // product's own git handling is unaffected. Pin both settings
        // before the first commit so the test is self-contained.
        git(&["config", "core.autocrlf", "false"]);
        git(&["config", "core.eol", "lf"]);
        std::fs::write(dir.join("requirements.txt"), "a\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "a"]);
        let commit_a = git_current_commit(&dir).unwrap();
        std::fs::write(dir.join("requirements.txt"), "b\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "b"]);
        let commit_b = git_current_commit(&dir).unwrap();
        (tmp, dir, commit_a, commit_b)
    }

    #[test]
    fn git_dirty_lines_tells_a_clean_checkout_from_a_dirty_one() {
        let (_tmp, dir, _a, _b) = two_commit_repo();
        assert!(git_dirty_lines(&dir).expect("status failed").is_empty(), "a freshly committed checkout is not clean");

        // An untracked file counts as dirty: it is exactly what a hard reset
        // would erase.
        std::fs::write(dir.join("a_new_file.txt"), "custom node config").unwrap();
        let dirty = git_dirty_lines(&dir).expect("status failed");
        assert!(!dirty.is_empty(), "an untracked file was not seen as a local change");
        assert!(dirty.iter().any(|l| l.contains("a_new_file.txt")), "the dirty file is not named: {dirty:?}");

        // Negative control the other way: removing it restores clean.
        std::fs::remove_file(dir.join("a_new_file.txt")).unwrap();
        assert!(git_dirty_lines(&dir).expect("status failed").is_empty(), "clean again after the untracked file is gone");
    }

    #[test]
    fn lu_own_venv_scratch_siblings_never_count_as_dirty() {
        // box-gruen/n9 punkt 87, final review (B5): a crashed or cancelled
        // Repair can leave one of these next to the checkout. Update must
        // treat the tree as clean anyway, or it refuses forever afterwards
        // and blames the customer for LU's own leftovers.
        let (_tmp, dir, _a, _b) = two_commit_repo();
        for name in ["venv.lu-old-1737400000", "venv.lu-new-1737400001", "venv.lu-failed-1737400002"] {
            std::fs::create_dir(dir.join(name)).unwrap();
            std::fs::write(dir.join(name).join("marker"), "x").unwrap();
        }

        let dirty = git_dirty_lines(&dir).expect("status failed");
        assert!(dirty.is_empty(), "LU's own venv rebuild siblings were treated as customer changes: {dirty:?}");

        // Gegenprobe: a look-alike name that is NOT one of the three exact
        // prefixes still counts as dirty, so the filter is not accidentally
        // matching every "venv.*" folder. (git does not track empty
        // directories at all, hence the marker file, same as the three above.)
        std::fs::create_dir(dir.join("venv.customer-backup")).unwrap();
        std::fs::write(dir.join("venv.customer-backup").join("marker"), "x").unwrap();
        let dirty = git_dirty_lines(&dir).expect("status failed");
        assert!(dirty.iter().any(|l| l.contains("venv.customer-backup")), "an unrelated venv.* folder was wrongly exempted: {dirty:?}");
    }

    #[test]
    fn git_current_commit_and_reset_hard_round_trip_on_a_real_repo() {
        let (_tmp, dir, commit_a, commit_b) = two_commit_repo();
        assert_ne!(commit_a, commit_b);
        assert_eq!(git_current_commit(&dir).unwrap(), commit_b, "HEAD should be the newer commit before any reset");

        git_reset_hard(&dir, &commit_a).expect("reset failed");

        assert_eq!(git_current_commit(&dir).unwrap(), commit_a, "reset did not move HEAD back");
        let contents = std::fs::read_to_string(dir.join("requirements.txt")).unwrap();
        assert_eq!(contents, "a\n", "the working tree still shows the newer commit's content after reset");
        assert!(git_dirty_lines(&dir).unwrap().is_empty(), "a hard reset should leave a clean tree");
    }

    #[test]
    fn rollback_after_cancelled_update_moves_head_back_and_says_packages_may_be_ahead() {
        // This is the exact shape of the box-gruen/n9 punkt 87 damage: `git
        // pull` (here, a plain commit) moved the checkout to commit_b, then a
        // cancel landed mid-pip. `old_commit` is commit_a, recorded before
        // the pull. The message must be honest that packages are not
        // provably rolled back with it.
        let (_tmp, dir, commit_a, commit_b) = two_commit_repo();
        assert_eq!(git_current_commit(&dir).unwrap(), commit_b);

        let msg = rollback_after_cancelled_update(&dir, &commit_a, "the requirements install");

        assert_eq!(git_current_commit(&dir).unwrap(), commit_a, "the checkout was not rolled back");
        assert!(msg.contains("the requirements install"), "the stage is not named: {msg}");
        assert!(msg.contains(short_commit(&commit_a)), "the commit the code fell back to is not named: {msg}");
        assert!(msg.contains("may already have been installed"), "no honest caveat about packages: {msg}");
    }

    #[test]
    fn rollback_after_cancelled_update_says_so_honestly_when_the_reset_itself_fails() {
        // Negative control: point it at a directory that is not a git repo
        // at all, so `git reset --hard` fails. The customer must not be told
        // a rollback happened when it did not.
        let tmp = tempfile::tempdir().unwrap();
        let msg = rollback_after_cancelled_update(tmp.path(), "deadbeef", "the environment check");
        assert!(msg.contains("could not be rolled back automatically"), "a failed reset must say so: {msg}");
        assert!(!msg.contains("was rolled back to the version"), "a failed reset must not claim success: {msg}");
    }

    #[test]
    fn update_records_the_rollback_commit_only_on_a_clean_tree_and_only_before_the_pull() {
        // Same reasoning as the precheck-ordering tests above: the update
        // body is a thread inside a Tauri command, so the ORDER is read out
        // of the source. `old_commit` has to exist before `git pull` runs,
        // or a cancel during pip has nothing safe to fall back to.
        let src = include_str!("comfy_repair.rs");
        let needle = |head: &str, tail: &str| format!("{head}{tail}");

        let update_fn_start = src.find("pub fn update_comfyui(").expect("update_comfyui is gone");
        let clean_check = needle("match git_dirty_l", "ines(&comfy_dir) {");
        let pull_start = needle("Pulling the latest Comfy", "UI...");
        let cancelled_pip = needle("rollback_after_cancelled_update(&comfy_d", "ir, &old_commit, \"the requirements install\")");
        let cancelled_verify = needle("rollback_after_cancelled_update(&comfy_d", "ir, &old_commit, \"the environment check\")");

        let at_clean_check = src[update_fn_start..].find(&clean_check).map(|i| i + update_fn_start)
            .expect("update_comfyui no longer checks the working tree before pulling");
        let at_pull = src[update_fn_start..].find(&pull_start).map(|i| i + update_fn_start)
            .expect("the git pull step marker is gone");
        let at_cancelled_pip = src[update_fn_start..].find(&cancelled_pip).map(|i| i + update_fn_start)
            .expect("a cancel during the requirements install no longer rolls the checkout back");
        let at_cancelled_verify = src[update_fn_start..].find(&cancelled_verify).map(|i| i + update_fn_start)
            .expect("a cancel during the environment check no longer rolls the checkout back");

        assert!(at_clean_check < at_pull, "the working tree must be checked, and old_commit recorded, before the pull");
        assert!(at_pull < at_cancelled_pip, "the rollback call must be after the pull it is rolling back");
        assert!(at_pull < at_cancelled_verify, "the rollback call must be after the pull it is rolling back");
    }

    #[test]
    fn update_stops_its_own_or_orphaned_comfyui_before_acquiring_the_status_slot() {
        // Same shape once more: prove from the source that the running-
        // instance guard runs before `update_comfyui` starts writing to
        // `install_status`, i.e. before it commits to the run at all. A
        // guard placed after that point could refuse having already told
        // the panel an update was starting.
        //
        // final review Runde 3, R3-1: the call itself moved from a `?`
        // early-return on the caller's thread into an `if let Err(...)` on
        // the worker thread, so the needle follows it there; the ordering
        // this test actually cares about (guard before the status slot is
        // touched) is unchanged.
        let src = include_str!("comfy_repair.rs");
        let needle = |head: &str, tail: &str| format!("{head}{tail}");

        let update_fn_start = src.find("pub fn update_comfyui(").expect("update_comfyui is gone");
        let guard_call = needle("if let Err(msg) = ensure_comfyui_stopped_for_upd", "ate(&state) {");
        let installing_status = needle("install.status = \"instal", "ling\".to_string();");

        let at_guard = src[update_fn_start..].find(&guard_call).map(|i| i + update_fn_start)
            .expect("update_comfyui no longer guards against a running ComfyUI");
        let at_installing = src[update_fn_start..].find(&installing_status).map(|i| i + update_fn_start)
            .expect("update_comfyui no longer marks the status slot as installing");

        assert!(at_guard < at_installing, "the running-instance guard must run before the status slot is claimed");
    }

    /// final review Runde 4, R4-1: `update_comfyui` returns immediately, but
    /// `install.status` is only ever set to "installing" INSIDE the worker
    /// thread, after the running-instance guard -- up to 13 s away
    /// (R2-1/R2-2). `install_status` is never reset to "idle" between runs
    /// on its own (`InstallState::default` is the only other writer, and
    /// that only ever runs once, at process startup), so without a reset
    /// here it keeps showing whatever the LAST install/repair/update run
    /// left behind for that whole wait. The panel's first poll lands 2 s
    /// after this call (`comfyInstallStore`'s `POLL_MS`), squarely inside
    /// that window on a slow guard, and a stale `complete`/`error`/
    /// `cancelled` there reads as THIS run already being over -- see the
    /// Vitest case in `comfy-update-confirm-dialog.test.ts` for the
    /// panel-side proof of that reading. This test proves the fix directly,
    /// not just its position in the source: a real `AppState` carrying an
    /// old `complete` does not survive the call.
    #[test]
    fn reset_install_status_for_new_run_clears_a_stale_complete_before_anything_else_runs() {
        let state = crate::state::AppState::new();
        {
            let mut install = state.install_status.lock().unwrap();
            install.status = "complete".to_string();
            install.notice = "Update finished. ComfyUI is starting again with the new nodes.".to_string();
            install.notice_kind = "ok".to_string();
            install.logs.push("a line from the run before this one".to_string());
        }

        reset_install_status_for_new_run(&state);

        let install = state.install_status.lock().unwrap();
        assert_eq!(install.status, "idle", "a stale 'complete' from an earlier run survived into the guard's wait");
        assert!(install.notice.is_empty(), "the previous run's closing notice survived");
        assert!(install.notice_kind.is_empty(), "the previous run's notice kind survived");
        assert!(install.logs.is_empty(), "the previous run's log lines survived");
    }

    /// Gegenprobe for the test above: `reset_install_status_for_new_run`
    /// existing and working is not enough on its own if `update_comfyui`
    /// never actually calls it, or calls it too late (after the worker
    /// thread already started writing). Source guard, same shape as
    /// `ensure_comfyui_stopped_for_update_runs_inside_the_worker_thread_not_
    /// on_the_main_thread` above: the call must sit textually BEFORE
    /// `std::thread::spawn` opens, i.e. on the caller's thread, so it always
    /// finishes before anyone starts watching.
    #[test]
    fn update_comfyui_resets_the_status_slot_before_spawning_its_worker_thread() {
        let src = include_str!("comfy_repair.rs");

        let update_fn_start = src.find("pub fn update_comfyui(").expect("update_comfyui is gone");
        let thread_spawn = "std::thread::spawn(move || {";
        let reset_call = "reset_install_status_for_new_run(state.inner());";

        let at_reset = src[update_fn_start..].find(reset_call).map(|i| i + update_fn_start)
            .expect("update_comfyui no longer resets the status slot before its worker thread");
        let at_spawn = src[update_fn_start..].find(thread_spawn).map(|i| i + update_fn_start)
            .expect("update_comfyui no longer spawns its worker thread");

        assert!(
            at_reset < at_spawn,
            "the status slot must be reset on the caller's thread, before the worker thread spawns -- \
             resetting it from inside the worker leaves the exact window (up to 13 s) open for a poll \
             to read a stale status from the previous run",
        );
    }

    /// final review Runde 3, R3-1: `ensure_comfyui_stopped_for_update` can
    /// sleep for up to 10 s (R2-1's `wait_for_port_free`) on top of up to 3 s
    /// for the queue check (R2-2), and it used to run on the CALLER's thread
    /// -- the Tauri main thread for a plain `#[tauri::command] pub fn` --
    /// before `update_comfyui`'s own worker thread even existed, freezing
    /// the window for as long as 13 s with "Not responding" over it the
    /// whole time. The fix is not observable by calling the guard directly
    /// (it behaves identically either way); only WHERE it is called from
    /// changed, so this is a source guard, the same shape as the ordering
    /// tests above and `filesystem.rs`'s `fs_search_is_dispatched_off_the_
    /// main_thread`. Pinned here instead of only in a bug report about a
    /// frozen window: the call must sit textually AFTER `std::thread::spawn`
    /// opens, i.e. inside the closure, not before it.
    #[test]
    fn ensure_comfyui_stopped_for_update_runs_inside_the_worker_thread_not_on_the_main_thread() {
        let src = include_str!("comfy_repair.rs");
        let needle = |head: &str, tail: &str| format!("{head}{tail}");

        let update_fn_start = src.find("pub fn update_comfyui(").expect("update_comfyui is gone");
        let thread_spawn = "std::thread::spawn(move || {";
        let guard_call = needle("if let Err(msg) = ensure_comfyui_stopped_for_upd", "ate(&state) {");

        let at_spawn = src[update_fn_start..].find(thread_spawn).map(|i| i + update_fn_start)
            .expect("update_comfyui no longer spawns its worker thread");
        let at_guard = src[update_fn_start..].find(&guard_call).map(|i| i + update_fn_start)
            .expect("update_comfyui no longer guards against a running ComfyUI");

        assert!(
            at_spawn < at_guard,
            "the running-instance guard must run inside the worker thread, not on the caller's \
             thread before it -- its own waits (up to 10 s for the port-free poll, up to 3 s for \
             the queue check) would otherwise freeze the window",
        );

        // The old shape must not come back either: a bare `?` early-return
        // needs a `Result`-returning scope, which only exists on the
        // caller's thread, so its presence anywhere in this function is
        // itself proof the call moved back out of the worker thread. Split
        // in half so this line does not match itself.
        let old_shape = needle("ensure_comfyui_stopped_for_upd", "ate(&state)?;");
        assert!(
            !src[update_fn_start..].contains(&old_shape),
            "the guard is back to a `?`-early-return, which only compiles on the caller's thread",
        );
    }

    /// The box, 03.10.2026: the update stops LU's own ComfyUI before it
    /// touches the checkout and then ended on "Restart ComfyUI to load the
    /// new nodes" with the status on Stopped. Nothing restarted it, so the
    /// customer had to find the Start button, and a render that had asked for
    /// the update had nothing to continue on. Whoever stops it starts it
    /// again: after the environment check passed, before the run reports
    /// `complete` (the panel and Create stop watching on that word).
    #[test]
    fn a_finished_update_starts_comfyui_again_before_it_reports_complete() {
        let src = include_str!("comfy_repair.rs");
        let needle = |head: &str, tail: &str| format!("{head}{tail}");
        let body_start = src.find("pub fn update_comfyui(").expect("update_comfyui is gone");
        let body = &src[body_start..];
        let body = &body[..body.find("\n}\n").expect("update_comfyui has no end")];

        let at_check = body.find("verify_and_heal_environment(").expect("the update no longer checks the environment");
        let at_start = body
            .find(&needle("process::start_comfyui_bloc", "king(&state)"))
            .expect("the update does not start ComfyUI again");
        let at_complete = body.rfind(&needle("\"comp", "lete\"")).expect("the update never reports complete");
        assert!(at_check < at_start, "ComfyUI must not be started on an environment nobody checked");
        assert!(at_start < at_complete, "ComfyUI must be on its way up before the run reports complete");
    }

    #[test]
    fn the_closing_line_of_an_update_says_whether_comfyui_came_back() {
        let (line, warn) = update_finished_line(&Ok(()));
        assert_eq!(line, "Update finished. ComfyUI is starting again with the new nodes.");
        assert!(!warn);

        let (line, warn) = update_finished_line(&Err("ModuleNotFoundError: No module named 'av'".to_string()));
        assert!(line.starts_with("Update finished, but ComfyUI did not start again. Press Start to try again."), "got: {line}");
        assert!(line.ends_with("ModuleNotFoundError: No module named 'av'"), "the reason is missing: {line}");
        assert!(warn, "a ComfyUI that stayed down is not good news");
        assert!(!line.contains("Restart ComfyUI"), "the customer is no longer the one who restarts it: {line}");
    }

    #[test]
    fn the_queue_is_checked_before_anything_is_stopped() {
        // box-gruen/n9 punkt 87, final review (B3): a check that runs AFTER
        // the kill is not a guard, it is a post-mortem. `stop_comfyui_blocking`
        // must not be called until `comfyui_queue_busy` has already answered.
        let src = include_str!("comfy_repair.rs");
        let needle = |head: &str, tail: &str| format!("{head}{tail}");

        let guard_fn_start = src.find("fn stop_own_idle_comfyui(").expect("the running-instance guard is gone");
        let queue_check = needle("comfyui_queue_bus", "y(port)");
        let stop_call = needle("process::stop_comfyui_bloc", "king(state)");

        let at_queue_check = src[guard_fn_start..].find(&queue_check).map(|i| i + guard_fn_start)
            .expect("the guard no longer checks whether ComfyUI is busy");
        let at_stop_call = src[guard_fn_start..].find(&stop_call).map(|i| i + guard_fn_start)
            .expect("the guard no longer stops ComfyUI through stop_comfyui_blocking");

        assert!(at_queue_check < at_stop_call, "the queue must be checked before anything is stopped");
    }

    #[test]
    fn foreign_comfyui_message_names_the_port_and_refuses_without_a_close_command() {
        let msg = foreign_comfyui_blocks_update(8188);
        assert!(msg.contains("8188"), "the port is not named: {msg}");
        assert!(msg.contains("did not start it"), "does not say the app never started it: {msg}");
        assert!(msg.contains("Close that ComfyUI first"), "does not tell the customer what to do: {msg}");
        assert!(msg.contains("Nothing was changed"), "does not say nothing was touched: {msg}");
    }

    // ── box-gruen/n9 Punkt 87, final review (B3): the queue-busy guard's
    //    JSON-parsing half, kept pure and provable with literal values ─────

    #[test]
    fn queue_has_work_reads_comfyuis_own_shape() {
        assert!(!queue_has_work(&serde_json::json!({"queue_running": [], "queue_pending": []})));
        assert!(queue_has_work(&serde_json::json!({"queue_running": [[0, "abc"]], "queue_pending": []})));
        assert!(queue_has_work(&serde_json::json!({"queue_running": [], "queue_pending": [[0, "abc"]]})));
        // A shape ComfyUI has never actually sent, kept as the honest
        // fallback: neither key present reads as no work, not as an error.
        assert!(!queue_has_work(&serde_json::json!({})));
    }

    // ── final review Runde 2, R2-1: the port-free wait after the stop ───────

    #[test]
    fn wait_for_port_free_returns_true_once_the_probe_actually_frees_up() {
        // Positive case: the port is still occupied on the first two polls
        // and free on the third, standing in for the real KILL_GRACE delay
        // without an actual 800 ms sleep in the test suite. Before this
        // helper existed, the single immediate check this replaced would
        // have read the first `true` and stopped right there.
        let mut calls = 0u32;
        let freed = wait_for_port_free(
            std::time::Duration::from_millis(1),
            std::time::Duration::from_millis(200),
            || {
                calls += 1;
                calls < 3
            },
        );
        assert!(freed, "the port never registered as free even though the probe said so on the third call");
        assert_eq!(calls, 3, "expected exactly the calls needed to observe the port going free, got {calls}");
    }

    #[test]
    fn wait_for_port_free_gives_up_once_the_cap_is_reached() {
        // Gegenprobe: a port that never frees up must still return, with the
        // caller then producing the "did not stop" refusal, not hang forever.
        let start = std::time::Instant::now();
        let freed = wait_for_port_free(
            std::time::Duration::from_millis(2),
            std::time::Duration::from_millis(20),
            || true,
        );
        assert!(!freed, "a port that never frees up must not be reported as free");
        assert!(
            start.elapsed() >= std::time::Duration::from_millis(20),
            "gave up before the cap even elapsed: {:?}",
            start.elapsed()
        );
    }

    // ── final review Runde 2, R2-2: the queue check needs a real deadline ──

    #[test]
    fn queue_check_fails_closed_instead_of_hanging_on_a_server_that_never_answers() {
        // A ComfyUI that holds the port but stopped answering ("Not
        // responding" in this same panel) is exactly what this simulates:
        // accept the connection, then never write a single byte back.
        // `reqwest::blocking::get` (no `Client::builder().timeout(...)`)
        // would hang here for as long as the OS lets a TCP connection sit
        // idle, which is why this test is the negative control for R2-2.
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                std::thread::sleep(std::time::Duration::from_secs(30));
                drop(stream);
            }
        });

        let start = std::time::Instant::now();
        let result = comfyui_queue_busy_with_timeout(port, std::time::Duration::from_millis(200));
        assert!(result.is_err(), "a server that never answers must fail closed, not report an empty queue");
        assert!(
            start.elapsed() < std::time::Duration::from_secs(2),
            "the call did not honor its timeout, took {:?}",
            start.elapsed()
        );
    }

    // ── check_repair_disk_pressure: the refusal has no test at all ────────

    /// Not enough room: the refusal fires, names the numbers, and offers a
    /// way out. The refusal is exercised through the pure core, not the
    /// disk-reading wrapper, so it needs no real filesystem free-space
    /// probe (see `check_repair_disk_pressure_core`'s doc comment for why
    /// the split mirrors `git_download_preflight_core`).
    /// The three numbers are deliberately three DIFFERENT rounded values
    /// (2.0 / 7.0 / 6.5 GB) rather than reusing one value for two roles.
    /// Review Runde 2 caught that the previous version put `free` one byte
    /// below `required`, so both rounded to "7.0 GB" and a swapped
    /// `existing`/`free` argument pair in the `format!` call would have
    /// gone unnoticed. With three distinct values, each `.contains` can
    /// only match the argument that actually produced it. The mount point
    /// is asserted too, closing the same kind of gap for the fourth
    /// argument.
    #[test]
    fn disk_pressure_core_refuses_when_free_space_is_below_required() {
        let existing_bytes = 2 * 1024 * 1024 * 1024; // 2 GB existing venv
        let required = 5 * 1024 * 1024 * 1024 + existing_bytes; // 7 GB
        let free_bytes = 6 * 1024 * 1024 * 1024 + 512 * 1024 * 1024; // 6.5 GB, below required
        assert!(free_bytes < required, "the test fixture itself must be below the threshold");
        let refused = check_repair_disk_pressure_core(free_bytes, existing_bytes, "/mnt/test-disk")
            .expect("free space below the requirement was accepted");
        assert!(refused.contains("Not enough free space"), "wrong message: {refused}");
        // Each number is asserted together with the words around it, not
        // as a bare substring: three distinct values can still swap
        // POSITIONS in the format! call (e.g. `existing` and `free`
        // trading places) while every bare number still occurs somewhere
        // in the message, letting the swap slip past. Binding each value
        // to its sentence closes that gap.
        assert!(refused.contains("is about 2.0 GB,"), "existing size not in its own sentence: {refused}");
        assert!(refused.contains("(7.0 GB total)"), "required total not in its own place: {refused}");
        assert!(
            refused.contains("only 6.5 GB is free on /mnt/test-disk"),
            "free space and mount point not named together: {refused}"
        );
        assert!(refused.contains("nothing was changed"), "no reassurance that nothing ran yet: {refused}");
    }

    /// Negative control for the test above: without it, a core that always
    /// refuses would pass the assertion just as well.
    #[test]
    fn disk_pressure_core_lets_enough_space_through() {
        let existing_bytes = 2 * 1024 * 1024 * 1024;
        let required = 5 * 1024 * 1024 * 1024 + existing_bytes;
        let free_bytes = required + 1024; // comfortably above
        assert!(
            check_repair_disk_pressure_core(free_bytes, existing_bytes, "/").is_none(),
            "enough free space was refused anyway"
        );
    }

    /// The boundary itself: free space exactly equal to the requirement
    /// must pass, since the production comparison is a strict `<`. This is
    /// the exact number a rounding change to `<=` would flip.
    #[test]
    fn disk_pressure_core_exactly_at_the_threshold_passes() {
        let existing_bytes = 2 * 1024 * 1024 * 1024;
        let required = 5 * 1024 * 1024 * 1024 + existing_bytes;
        assert!(
            check_repair_disk_pressure_core(required, existing_bytes, "/").is_none(),
            "free space exactly equal to the requirement was refused"
        );
        assert!(
            check_repair_disk_pressure_core(required - 1, existing_bytes, "/").is_some(),
            "one byte below the requirement was let through"
        );
    }

    /// Documents today's behaviour when the disk itself cannot be
    /// identified (no mount point in `sysinfo::Disks` is a prefix of
    /// `comfy_dir`, the same fallback the doc comment on
    /// `check_repair_disk_pressure` already names): it returns `None` and
    /// lets the repair proceed, exactly like "no existing venv yet". This
    /// is a characterization test, not an endorsement; it exists so a
    /// change to that fallback is a deliberate edit, not a silent drift.
    #[test]
    fn disk_pressure_lets_repair_proceed_when_the_disk_cannot_be_identified() {
        let tmp = tempfile::tempdir().unwrap();
        let venv = tmp.path().join("venv");
        std::fs::create_dir(&venv).unwrap();
        // A relative path matches no mount point's prefix (every mount
        // point sysinfo reports is absolute), so `best` stays `None`.
        let unidentifiable_comfy_dir = Path::new("this-path-is-relative-on-purpose");
        assert!(
            check_repair_disk_pressure(unidentifiable_comfy_dir, &venv).is_none(),
            "an unidentifiable disk was refused instead of let through"
        );
    }

    /// Source guard, not a runtime test: on a normal development or CI
    /// machine there is easily more than 5 GB free, so a runtime test that
    /// deletes the early exit and calls `check_repair_disk_pressure` on a
    /// missing venv would still return `None` and never go red, proving
    /// nothing. The early exit for "no venv to measure yet" is instead
    /// pinned by position: it must run before `sysinfo::Disks` is ever
    /// touched, inside `check_repair_disk_pressure`'s own body (cut at the
    /// following `#[cfg(test)]`, so nothing past the function can match).
    #[test]
    fn disk_pressure_wrapper_exits_before_a_missing_venv_ever_reaches_the_disk_probe() {
        const SRC: &str = include_str!("comfy_repair.rs");
        let fn_start = SRC
            .find("fn check_repair_disk_pressure(comfy_dir: &Path, venv_dir: &Path) -> Option<String> {")
            .expect("check_repair_disk_pressure is gone");
        let body_end = SRC[fn_start..]
            .find("\n#[cfg(test)]")
            .expect("the test module marker after check_repair_disk_pressure is gone; widen this guard's cut");
        let body = &SRC[fn_start..fn_start + body_end];

        let at_guard = body
            .find("if !venv_dir.exists() {")
            .expect("the early return for a not-yet-built venv is gone from check_repair_disk_pressure");
        let at_return = body[at_guard..]
            .find("return None;")
            .map(|i| i + at_guard)
            .expect("the early return no longer says None");
        let at_disks = body
            .find("sysinfo::Disks")
            .expect("the disk enumeration is gone from check_repair_disk_pressure");

        assert!(
            at_return < at_disks,
            "the missing-venv guard (byte {at_return}) must run before sysinfo enumerates \
             any disk (byte {at_disks}), not after"
        );
    }
}

/// Runde 6, B9 review: nothing may delete the repair disk-pressure refusal
/// in `repair_comfyui_env` or move it behind the first destructive step
/// (retiring the old venv) without a test going red. Same call-site-order
/// technique as `git_preflight_call_site_guard` below, with two
/// hardenings this guard specifically needs:
///
/// - the search is bounded to `repair_comfyui_env`'s OWN body, cut off at
///   the next top-level function (`foreign_comfyui_blocks_update`), not to
///   the end of the file, so a call added to some later, unrelated
///   function could never satisfy it;
/// - comment lines are stripped before searching, so a comment that
///   merely MENTIONS either call in the right order cannot fool the
///   position check (the technique `process_util.rs`'s
///   `count_command_new`/`shipping_half` guard already uses).
#[cfg(test)]
mod disk_pressure_call_site_guard {
    fn strip_comment_lines(src: &str) -> String {
        src.lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// `repair_comfyui_env`'s own source, cut at the next top-level `fn`
    /// so nothing past its real body can be matched, then stripped of
    /// comment lines.
    fn repair_comfyui_env_body() -> String {
        const SRC: &str = include_str!("comfy_repair.rs");
        let start = SRC
            .find("pub fn repair_comfyui_env(")
            .expect("repair_comfyui_env is gone from comfy_repair.rs");
        let next_fn_offset = SRC[start..]
            .find("\nfn foreign_comfyui_blocks_update(")
            .expect(
                "foreign_comfyui_blocks_update, the next function after \
                 repair_comfyui_env, is gone; widen this guard's cut",
            );
        strip_comment_lines(&SRC[start..start + next_fn_offset])
    }

    #[test]
    fn repair_checks_disk_pressure_before_retiring_the_old_venv() {
        let body = repair_comfyui_env_body();
        let at_check = body
            .find("check_repair_disk_pressure(&comfy_dir, &venv_dir)")
            .expect(
                "repair_comfyui_env no longer calls check_repair_disk_pressure: a drive \
                 that cannot hold both venvs would fail deep inside the rebuild again \
                 instead of refusing up front",
            );
        let at_retire = body.find("retire_for_rebuild(&venv_dir)").expect(
            "the retire-the-old-venv step is gone from repair_comfyui_env",
        );
        assert!(
            at_check < at_retire,
            "check_repair_disk_pressure (byte {at_check}) must run before \
             retire_for_rebuild (byte {at_retire}), not after"
        );

        // Each needle exactly once inside this scoped, comment-stripped
        // body: two occurrences would mean a stray copy (e.g. in a
        // comment this strip missed) could make the `.expect`s above
        // unreachable or the position check meaningless.
        for (what, n) in [
            ("the disk-pressure check", "check_repair_disk_pressure(&comfy_dir, &venv_dir)"),
            ("the retire call", "retire_for_rebuild(&venv_dir)"),
        ] {
            assert_eq!(body.matches(n).count(), 1, "{what}: expected exactly one occurrence");
        }
    }

    /// Negative control: the extraction-plus-filter has to be ABLE to see
    /// a regression, not just agree with the real file by construction. A
    /// synthetic body shaped like the real one, calls swapped, plus a
    /// comment that LIES about the order to prove the comment strip
    /// actually runs before the search.
    #[test]
    fn the_guard_would_catch_the_calls_swapped_even_past_a_lying_comment() {
        let synthetic = "fn repair_comfyui_env() {\n\
             // check_repair_disk_pressure(&comfy_dir, &venv_dir) runs first, trust me\n\
             retire_for_rebuild(&venv_dir);\n\
             check_repair_disk_pressure(&comfy_dir, &venv_dir);\n\
             }\n";
        let filtered = strip_comment_lines(synthetic);
        let at_check = filtered.find("check_repair_disk_pressure(&comfy_dir, &venv_dir)").unwrap();
        let at_retire = filtered.find("retire_for_rebuild(&venv_dir)").unwrap();
        assert!(
            at_retire < at_check,
            "the synthetic body was supposed to have the calls swapped"
        );
    }
}

/// Review Runde 2, B1: nothing may delete the Linux git preflight in
/// `update_comfyui` or move it after the `git pull --ff-only` it is meant
/// to guard, without a test going red. Same technique as
/// `update_checks_the_interpreter_before_pulling_the_repository` above.
#[cfg(test)]
mod git_preflight_call_site_guard {
    #[test]
    fn update_comfyui_checks_git_before_pull() {
        let src = include_str!("comfy_repair.rs");
        let fn_start = src
            .find("pub fn update_comfyui(")
            .expect("update_comfyui is gone from comfy_repair.rs");
        let body = &src[fn_start..];

        let at_preflight = body.find("git_download_preflight()").expect(
            "update_comfyui no longer calls git_download_preflight(): a fresh \
             Debian 13 or Fedora 43 box without git would pull straight into a \
             cryptic spawn error again instead of the distro-specific hint",
        );
        let at_pull = body
            .find("\"pull\"")
            .expect("the git pull literal is gone from update_comfyui");

        assert!(
            at_preflight < at_pull,
            "git_download_preflight() (byte {at_preflight}) must run before \
             git pull --ff-only (byte {at_pull}), not after"
        );
    }
}
