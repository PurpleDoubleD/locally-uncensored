//! Die Erstinstallation von ComfyUI, vom leeren Ordner bis zum gespeicherten Pfad.
//!
//! Der geteilte Zustand ist das ZIELVERZEICHNIS, und zwar über die ganze
//! Laufzeit des Auftrags hinweg: erst als Frage (ist da genug Platz? was liegt
//! schon drin?), dann als Baustelle (Clone, venv, PyTorch, Requirements) und
//! am Ende als Tatsache, die in `config.json` geschrieben wird und dort jeden
//! späteren Aufruf von `find_comfyui_path` bestimmt.
//!
//! Deshalb liegen die Torwächter hier und nicht bei den allgemeinen Helfern.
//! `classify_existing_target` beantwortet die Frage, die git mit
//! "already exists" verschluckt — jedes nicht leere Verzeichnis bekommt diese
//! Antwort, auch ein Downloads-Ordner. Und `comfy_install_looks_finished` ist
//! das letzte Tor davor, dass ein Lauf sich selbst einen Erfolg nennt und
//! seinen Pfad festschreibt. Beide gehören zum Zielverzeichnis, beide sind
//! reine Pfadarbeit, und beide waren einmal nicht da: das ist der P14-Rumpf.

use std::io::Read as IoRead;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::State;
use tracing::{error, info};

use crate::state::AppState;
use crate::os_error;
use super::comfy_job::{finished_notice, requirements_fallback_log};
use super::env_check::verify_and_heal_environment;
use super::pip::{pip_install_streaming_with_retry_raw, requirements_failure_reason_for};

use super::children::TrackedInstallerChild;
use super::comfy_job::{ComfyJob, COMFY_JOB};
use super::comfy_job::comfy_job_busy_message;
use super::pip::pip_install_streaming_with_retry_cancellable;
use super::torch::plan_pytorch_install;
use super::venv::{create_comfyui_venv, restore_orphaned_venv_if_needed};
#[cfg(target_os = "windows")]
use super::git::{windows_git_install_hint, windows_git_probe, WindowsGitState};
#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

// ── Disk-pressure pre-flight (Bug #1 — 100%-busy-drive hang) ────────
//
// FREE SPACE IS THE ONLY THING MEASURED HERE, and that is deliberate. The doc
// comment below used to promise a second check as well — "or its pending I/O
// queue suggests sustained 100% utilisation" — which no version of this
// function ever performed (KF-28, read at HEAD 01.09.2026). Three reasons it
// stays that way rather than being built:
//
//   * Nothing consumes such a verdict. The one caller (`install_comfyui`)
//     pushes whatever string comes back into the install log and starts the
//     install regardless — it does not gate, retry or choose a drive. A
//     queue reading would produce a second sentence and change nothing.
//   * The busy-drive case in Bug #1 is answered somewhere else entirely, and
//     was already when this comment was written: the install became
//     CANCELLABLE (`state.comfyui_install_cancel`, polled between steps and
//     inside the pip retry loop, killing the live git/pip child). That is
//     what turned the 45-minute hang into something a user can leave. A
//     pre-flight guess about the drive is no substitute for a stop button.
//   * There is no reading to take. `sysinfo` 0.33 exposes `Disk::usage()` →
//     `DiskUsage`, which is four byte counters (read/written, total and
//     since-last-refresh). No queue depth, no utilisation percentage, on any
//     platform. Deriving "100% busy" from two byte deltas would be a guess
//     wearing a number.
//
// `disk_pressure_doc_matches_body` at the bottom of this file holds the two
// halves together, in both directions: promise without probe is red, and so
// is probe without promise. The "why not" lives up here, in a plain comment,
// so that the doc comment below can say only what the function does.

/// Return a human-readable warning when the target install drive is short on
/// free space — under 5 GB, since ComfyUI plus the PyTorch wheels need about
/// that much. That is the whole check; a drive with room comes back `None`.
///
/// Best-effort in the other direction too: `None` when `sysinfo` lists no
/// mount point that is a prefix of `target_dir`, so a probing flake never
/// blocks a well-meaning install.
pub(crate) fn check_install_disk_pressure(target_dir: &Path) -> Option<String> {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    // Find the disk that contains the target dir. sysinfo's Disk::mount_point
    // is a PathBuf — pick the longest mount that is a prefix of target_dir.
    let normalized = target_dir.to_path_buf();
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
    let total_bytes = disk.total_space();
    let needed_bytes: u64 = 5 * 1024 * 1024 * 1024; // 5 GB
    if free_bytes < needed_bytes {
        return Some(format!(
            "⚠ Low disk space on {}: {:.1} GB free of {:.1} GB total. \
             ComfyUI + PyTorch need about 5 GB. Consider freeing space or \
             choosing a drive with more room before continuing.",
            disk.mount_point().to_string_lossy(),
            free_bytes as f64 / 1_073_741_824.0,
            total_bytes as f64 / 1_073_741_824.0,
        ));
    }
    None
}

// ── OI-2: what git actually means by "already exists" ───────────────────────

/// What a clone target that git refused with `already exists` really is.
///
/// `git clone` prints "destination path '…' already exists and is not an empty
/// directory" for ANY non-empty directory — a Downloads folder, a half-cloned
/// ComfyUI, someone else's repo. The installer read that one string as "a
/// ComfyUI is already there, pull it", ran a `git pull` whose exit status it
/// threw away, and then walked the whole PyTorch + requirements path against a
/// directory that may never have held ComfyUI. Two GB later it reported
/// "ComfyUI installed successfully!" and persisted `comfyui_path` to that
/// directory, which then poisoned `find_comfyui_path` for every future call.
///
/// That is the P14 torso, re-entered through the back door. This type is the
/// gate: the branch has to know what it is looking at before it spends the
/// user's bandwidth.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum ExistingTarget {
    /// `.git` + `main.py`: a real ComfyUI checkout. Pull and carry on.
    ComfyCheckout,
    /// `.git` but no `main.py`: a git repo that is not ComfyUI, or a clone
    /// that died before checkout. Never install into it, never overwrite it.
    ForeignOrIncompleteRepo,
    /// Not a git repo at all. Whatever the user has in there, it is not
    /// something a `git pull` can turn into ComfyUI.
    NotARepo,
}

/// Classify a clone target. Pure path logic so the branch is testable without
/// git, a network, or a 2 GB download.
pub(crate) fn classify_existing_target(dir: &Path) -> ExistingTarget {
    if !dir.join(".git").exists() {
        return ExistingTarget::NotARepo;
    }
    if dir.join("main.py").exists() {
        ExistingTarget::ComfyCheckout
    } else {
        ExistingTarget::ForeignOrIncompleteRepo
    }
}

/// The message the user gets when the install refuses a target it cannot
/// safely use. Says which directory, what is wrong with it, and what to do —
/// a bare "install failed" on a path the user picked themselves is the same
/// dead end as the silent success it replaces.
pub(crate) fn existing_target_refusal(dir: &Path, verdict: ExistingTarget) -> String {
    match verdict {
        ExistingTarget::ComfyCheckout => String::new(),
        ExistingTarget::ForeignOrIncompleteRepo => format!(
            "{} is a git repository, but it is not a ComfyUI checkout (no main.py). \
             LU will not install into it — pick an empty folder, or delete this one \
             first if it is a failed download.",
            dir.display()
        ),
        ExistingTarget::NotARepo => format!(
            "{} already exists and is not a ComfyUI checkout. git refuses to clone \
             into a non-empty folder, and LU will not install on top of files it did \
             not put there. Pick an empty folder, or move this one aside and retry.",
            dir.display()
        ),
    }
}

/// The end-of-install gate: a finished ComfyUI has `main.py`. Checked before
/// success is reported AND before `comfyui_path` is persisted, because the
/// persisted path is what `find_comfyui_path` hands to every later call — a
/// wrong value there outlives the failed install by the whole lifetime of the
/// config file.
pub(crate) fn comfy_install_looks_finished(dir: &Path) -> bool {
    dir.join("main.py").exists()
}

#[tauri::command]
pub fn install_comfyui(
    install_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // Never on macOS: local media there is MLX. Refusing before we touch the
    // install slot means a stray call cannot even leave the status machine in
    // "installing" — see start_comfyui for why the guard lives in Rust and not
    // only in the UI that hides these buttons.
    if !crate::commands::process::comfy_supported_here() {
        return Err(crate::commands::process::MACOS_COMFY_REFUSAL.to_string());
    }

    // OI-5: take the runtime before touching the shared status slot. A second
    // click on Install is idempotent; a repair or update arriving mid-install
    // is refused loudly rather than allowed to delete the venv underneath us.
    let job_guard = match COMFY_JOB.try_acquire(ComfyJob::Install) {
        Ok(g) => g,
        Err(ComfyJob::Install) => return Ok(serde_json::json!({"status": "already_installing"})),
        Err(running) => return Err(comfy_job_busy_message(ComfyJob::Install, running)),
    };

    let mut install = state.install_status.lock().unwrap();
    install.status = "installing".to_string();
    install.logs.clear();
    install.notice.clear();
    install.notice_kind.clear();
    install.logs.push("Starting ComfyUI installation...".to_string());
    drop(install);

    info!("comfyui install start");

    // Reset cancel flag (Bug #1) — a previous cancelled install would
    // otherwise short-circuit the new run on first poll.
    state.comfyui_install_cancel.store(false, Ordering::SeqCst);
    let cancel_flag = state.comfyui_install_cancel.clone();

    let target_dir = install_path
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("ComfyUI"));

    // Bug #1: pre-flight disk pressure check. On a drive sitting
    // at 100% utilisation the install hangs for 45+ minutes and the app
    // OOMs. Surface the risk BEFORE we start — the user can free space
    // or pick a different drive instead of staring at a frozen progress
    // log. We don't refuse to start: some users will accept the slow path.
    if let Some(warning) = check_install_disk_pressure(&target_dir) {
        if let Ok(mut s) = state.install_status.lock() {
            s.logs.push(warning);
        }
    }

    // Pre-flight: refuse to start ComfyUI install without a real Python.
    // The frontend is expected to call `install_python` first when this
    // returns the "no python" error — that flow shows a Python-install
    // progress card before re-firing `install_comfyui`. The ComfyUI carcass
    // bug (P14) was caused by skipping this check: pip got fed the Microsoft
    // Store stub `python.exe`, which exit-1'd, leaving a half-cloned
    // ComfyUI dir on disk that LU then mistakenly detected as "installed".
    let python_bin = state.python_bin.lock().unwrap().clone();
    if python_bin.is_empty() || !crate::python::is_real_python(&python_bin) {
        // Reset install state so the frontend's polling sees the error
        // immediately — without this the spawned thread below never runs and
        // the UI sits on "installing" forever.
        let mut install = state.install_status.lock().unwrap();
        install.status = "error".to_string();
        install.logs.push(
            "Python is not installed on this machine. \
             Install Python first (Settings → ComfyUI → Install Python, \
             or click 'Install Python' in the onboarding ComfyUI step), \
             then retry the ComfyUI install."
                .to_string(),
        );
        error!("comfyui install aborted: no usable python");
        return Err(
            "no_python: Python must be installed before ComfyUI. Call install_python first."
                .to_string(),
        );
    }
    let install_status = state.install_status.clone();
    // Cloned into the worker so a custom install target can be persisted as
    // the active ComfyUI path once the install completes.
    let comfy_path_slot = state.comfy_path.clone();

    std::thread::spawn(move || {
        // Held for the whole job: dropping it hands the runtime back, and it
        // drops on every exit path from this closure, panics included.
        let _job_guard = job_guard;

        // Helper to update install status + logs
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

        let cancelled = || cancel_flag.load(Ordering::SeqCst);

        if cancelled() {
            update("cancelled", "Install cancelled before it started.");
            return;
        }

        // Runde 6, F12: a crash mid Repair can leave a `venv.lu-old-*` sibling
        // and no usable `venv` behind (see venv.rs's own doc). This used to be
        // adopted back only when the customer next pressed Repair; pressing
        // Install instead (a target directory that already has a ComfyUI
        // checkout, the "already exists" branch below) walked right past the
        // several-gigabyte orphan and read the folder as having no venv at
        // all. A no-op on a healthy install (`venv_python_path` already
        // exists), so this is safe to call unconditionally, before anything
        // else looks at the folder.
        restore_orphaned_venv_if_needed(&target_dir);

        // Bug N (issue #40, 2026-05-18) — probe Windows
        // git BEFORE clone so a WSL/non-native git on PATH surfaces a clear
        // hint instead of failing the clone halfway with cryptic stderr.
        #[cfg(target_os = "windows")]
        {
            let probe = windows_git_probe();
            if let Some(hint) = windows_git_install_hint(&probe) {
                if probe == WindowsGitState::Missing {
                    update("error", &hint);
                    return;
                }
                // NonNative — log the warning to the install panel but
                // proceed; many MSYS/Cygwin gits handle Windows paths fine.
                update("downloading", &hint);
            }
        }

        // Linux setup stolpstein (BERICHT-5-APPIMAGE.md): fresh Debian 13
        // and Fedora 43 cloud/desktop images ship no git at all. Probe
        // before spending any bytes on the clone and name the exact
        // package manager command instead of dying with a generic error.
        if let Some(hint) = super::git::git_download_preflight() {
            update("error", &hint);
            return;
        }

        // Step 1: Git clone — spawn+poll instead of cmd.output() so the
        // Cancel button can kill an in-flight clone (Bug #1).
        println!("[Install] Cloning ComfyUI to {:?}", target_dir);
        update("downloading", "Step 1/4: Downloading ComfyUI repository...");

        // 3.0.9: the release LU tested (comfy_pin.rs), not whatever master
        // is at this minute. Full history, so a later pin is a local move.
        let mut cmd = crate::process_util::foreign_system_command("git");
        cmd.args(["clone"])
            .args(super::comfy_pin::pinned_clone_args())
            .arg(&target_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut clone_child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let err = format!("Git is not installed or not in PATH: {}", os_error::english(&e));
                println!("[Install] {}", err);
                update("error", &err);
                return;
            }
        };
        // OI-7: same registration as the pip runs. `git clone` spawns its own
        // fetch/index-pack helpers, which a plain kill leaves writing.
        let clone_pid = clone_child.id();
        let _tracked_clone = TrackedInstallerChild::register(clone_pid);
        let clone_exit = loop {
            if cancelled() {
                crate::commands::shell::kill_tree(clone_pid);
                let _ = clone_child.kill();
                let _ = clone_child.wait();
                update("cancelled", "Install cancelled during git clone.");
                return;
            }
            match clone_child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(250)),
                Err(e) => {
                    update("error", &format!("git wait failed: {}", os_error::english(&e)));
                    return;
                }
            }
        };

        if clone_exit.success() {
            println!("[Install] Git clone successful");
            update(
                "installing",
                &format!("Repository cloned successfully (ComfyUI {}).", super::comfy_pin::COMFYUI_PINNED_TAG),
            );
            // The marker that lets Update keep exactly this folder on the pin
            // later on, and nothing the customer brought along. Not fatal:
            // an unmarked install still works, it updates the old way.
            if let Err(e) = super::comfy_pin::mark_lu_installed(&target_dir) {
                println!("[Install] Could not mark the ComfyUI as installed by LU: {e}");
            }
        } else {
            let mut stderr = String::new();
            if let Some(mut e) = clone_child.stderr.take() {
                let _ = e.read_to_string(&mut stderr);
            }
            if stderr.contains("already exists") {
                // OI-2: "already exists" is git's answer for ANY non-empty
                // directory. Find out what is actually in there before
                // spending 2 GB of the user's bandwidth on it.
                let verdict = classify_existing_target(&target_dir);
                if verdict != ExistingTarget::ComfyCheckout {
                    let err = existing_target_refusal(&target_dir, verdict);
                    println!("[Install] {}", err);
                    error!(target = %target_dir.display(), ?verdict, "comfyui install refused an unusable clone target");
                    update("error", &err);
                    return;
                }
                println!("[Install] ComfyUI directory already exists, updating...");
                if cancelled() {
                    update("cancelled", "Install cancelled.");
                    return;
                }
                // A ComfyUI LU cloned earlier sits on a tag without a branch,
                // so a pull has nothing to update: it is set to the pin
                // instead. Everything else keeps the pull it always got.
                if super::comfy_pin::is_lu_installed(&target_dir) {
                    let tag = super::comfy_pin::COMFYUI_PINNED_TAG;
                    update("installing", &format!("ComfyUI already exists, setting it to the tested release {tag}..."));
                    match super::comfy_pin::checkout_pinned_tag(&target_dir, tag, true) {
                        Ok(_) => update("installing", &format!("ComfyUI is on {tag}.")),
                        Err(e) => update(
                            "installing",
                            &format!(
                                "Could not set ComfyUI to {tag}, continuing with the ComfyUI already \
                                 on disk.\n{}",
                                e.chars().take(400).collect::<String>()
                            ),
                        ),
                    }
                } else {
                update("installing", "ComfyUI already exists, pulling latest...");
                let mut pull = crate::process_util::foreign_system_command("git");
                pull.args(["pull"]).current_dir(&target_dir)
                    .stdout(Stdio::piped()).stderr(Stdio::piped());
                #[cfg(target_os = "windows")]
                pull.creation_flags(CREATE_NO_WINDOW);
                // Hier landet auch ein Ordner, der gar kein git-Checkout ist:
                // eine Installation, die von einem anderen Rechner per Stick
                // kopiert wurde, so kam falconbob_20415 zu einem ComfyUI mit
                // fehlenden Dateien. Auch das wird gesagt statt still weiterzulaufen.
                // The pull's result was discarded outright before. It is not
                // fatal — the checkout is already a ComfyUI, so an offline box
                // or a diverged branch should still get its dependencies —
                // but it must be SAID, or the user reads "installed
                // successfully" over a core that never moved.
                match pull.output() {
                    Ok(o) if o.status.success() => {
                        update("installing", "Repository updated to the latest ComfyUI.");
                    }
                    Ok(o) => {
                        let detail = String::from_utf8_lossy(&o.stderr).trim().to_string();
                        update(
                            "installing",
                            &format!(
                                "git pull did not succeed, continuing with the ComfyUI already \
                                 on disk. If nodes are missing afterwards, update it manually.\n{}",
                                detail.chars().take(400).collect::<String>()
                            ),
                        );
                    }
                    Err(e) => {
                        update(
                            "installing",
                            &format!(
                                "Could not run git pull ({}), continuing with the ComfyUI \
                                 already on disk.",
                                e
                            ),
                        );
                    }
                }
                }
            } else {
                let err = format!("Git clone failed: {}", stderr);
                println!("[Install] {}", err);
                update("error", &err);
                return;
            }
        }

        if cancelled() {
            update("cancelled", "Install cancelled after clone.");
            return;
        }

        // Bug E (Arch GH #32 comment, 2026-05-08) was the first
        // reason ComfyUI got a venv of its own: a PEP 668 protected system
        // Python refuses `pip install` outright. Since 3.0.4 every fresh
        // install builds one (see the build below). The launcher in
        // `process.rs` prefers the venv when starting ComfyUI, so the user
        // gets one isolated environment without touching the system Python.
        // A venv that is already there wins over everything below. The
        // launcher starts ComfyUI out of it (process.rs) and update_comfyui
        // installs into it, so an installer that reached past it would put the
        // packages in one interpreter and start another: press Install after a
        // Repair and the requirements land in the system Python while ComfyUI
        // keeps running out of the venv that still has the hole.
        // P3: a venv without its interpreter is not "no venv". Installing past
        // it would put every package in the system Python while the launcher
        // refuses to start out of anything else, so the run stops here with
        // the sentence that names the missing file and the button that fixes
        // it.
        let existing_venv = match crate::python::comfy_venv_state(&target_dir) {
            crate::python::ComfyVenv::Usable(p) => Some(p),
            crate::python::ComfyVenv::Broken { venv_dir, interpreter } => {
                update(
                    "error",
                    &crate::commands::process::comfy_broken_venv_message(&venv_dir, &interpreter),
                );
                return;
            }
            crate::python::ComfyVenv::Absent => None,
        };

        // Step 2's GPU probe + wheel choice, pulled up here (Runde 3,
        // Nachbesserung 6): a venv must never be built from an interpreter
        // the preflight below is about to reject, so the channel has to be
        // known BEFORE any venv decision, not after. `plan_pytorch_install`
        // does not touch disk or venv state, only nvidia-smi/GPU facts, so
        // moving it earlier is free.
        let (torch_args, gpu_info, torch_index, torch_packages) = plan_pytorch_install();
        let torch_package_refs: Vec<&str> = torch_packages.iter().map(|s| s.as_str()).collect();

        let effective_python = if let Some(venv_py) = existing_venv {
            // Runde 4, B3 (review Runde 3, Abschnitt 2): Runde 3 moved the
            // whole preflight into the "no existing venv" branch below and
            // left THIS branch with no check at all, a regression against
            // Runde 2 and literally the Reddit reporter's case: an
            // externally installed ComfyUI whose own venv sat on Python
            // 3.14.7. Without this, LU would download 2 GB into that venv
            // and fail with pip's generic error, again. The venv itself is
            // still never rebuilt here (it may be hand-built, or carry
            // custom nodes' own state), only checked before the download.
            // Runde 6, F11: this branch never builds a venv, it only installs
            // into the one that is already there, so `ensurepip` is not
            // required of this interpreter, only that pip itself still works.
            let decision = super::torch::choose_torch_python(&venv_py, torch_index.as_deref(), &torch_package_refs, "press Install ComfyUI again", false);
            match super::torch::python_for_existing_venv(decision, &venv_py) {
                Ok(py) => {
                    update(
                        "installing",
                        &format!(
                            "This ComfyUI already has its own environment. Installing into {py}."
                        ),
                    );
                    py
                }
                Err(msg) => {
                    update("error", &msg);
                    return;
                }
            }
        } else {
            // B1(b): LU picks the interpreter itself, no Settings picker.
            // Runs BEFORE `create_comfyui_venv`/PEP-668 detection so a
            // healthy choice never gets discarded for one that cannot serve
            // torch (Nachbesserung 6).
            // No existing venv yet: `create_comfyui_venv` below builds one
            // from this exact interpreter, so the strict probe applies.
            // Nothing on the machine fits: LU's own Python 3.12 instead of a
            // dead end (Discord 14.10.2026, a machine with only 3.15).
            let decision = super::torch::choose_torch_python(&python_bin, torch_index.as_deref(), &torch_package_refs, "press Install ComfyUI again", true);
            let progress = crate::private_python::StatusProgress { status: &install_status, cancel: &cancel_flag };
            let chosen_python = match super::torch::base_for_new_venv(decision, &python_bin, &progress, &|line| update("installing", line)) {
                Ok(path) => path,
                Err(e) if e == "cancelled" => {
                    update("cancelled", "Install cancelled while LU's own Python was being set up.");
                    return;
                }
                Err(msg) => {
                    update("error", &msg);
                    return;
                }
            };
            // Always a venv of its own, on every platform. Without one,
            // Windows and macOS put PyTorch and every ComfyUI package into the
            // user's system Python, next to whatever other software had
            // installed there. A user (Discord 2026-09-22, Windows 11,
            // RX 9060 XT): the environment check died on "python.exe - Bad
            // Image" for a ROCm DLL in Python312\Lib\site-packages that came
            // from another install. Linux already did this whenever PEP 668
            // locked the system Python (Bug E, GH #32). A venv also needs no
            // administrator for a python.org install under Program Files.
            update(
                "installing",
                "Creating an isolated Python environment at ComfyUI/venv, so PyTorch and \
                 the ComfyUI packages never mix with other Python software on this machine …",
            );
            match create_comfyui_venv(&target_dir, &chosen_python, Some(&cancel_flag)) {
                Ok(venv_py) => {
                    let p = venv_py.to_string_lossy().to_string();
                    update(
                        "installing",
                        &format!("venv ready, using {} for the install.", p),
                    );
                    p
                }
                // A cancel the user asked for is not a failed install. Without
                // this arm the new cancel path inside `create_comfyui_venv`
                // would arrive here as the card "Installing ComfyUI did not
                // finish", over a run that stopped because they said so.
                Err(e) if e == "cancelled" => {
                    update("cancelled", "Install cancelled while the venv was being created.");
                    return;
                }
                Err(e) => {
                    update("error", &format!("venv creation failed.\n\n{}", e));
                    return;
                }
            }
        };

        println!("[Install] {}", gpu_info);
        update("installing", &format!("Step 2/4: {}", gpu_info));

        update(
            "installing",
            "Downloading PyTorch + Torchvision + Torchaudio (~2 GB total). \
             On a typical home connection this takes 10–15 minutes; on slower \
             links it can be longer. Live pip output below — if you see new \
             lines appearing, the install is making progress, not hung.",
        );

        let torch_arg_refs: Vec<&str> = torch_args.iter().map(|s| s.as_str()).collect();
        match pip_install_streaming_with_retry_cancellable(&torch_arg_refs, &effective_python, 3, &install_status, Some(&cancel_flag)) {
            Ok(()) => {
                update("installing", "PyTorch installed successfully.");
                // 3.0.8: a GPU build that cannot see the card says so here,
                // with the fix, instead of surfacing later as a slow render.
                if torch_index.is_some() {
                    let sees = crate::commands::process::probe_comfy_gpu(&effective_python);
                    if let Some(line) = crate::commands::torch_wheels::post_install_gpu_line(
                        torch_index.as_deref(),
                        sees,
                        std::env::consts::OS,
                    ) {
                        update("installing", &line);
                    }
                }
            }
            Err(diagnosis) if diagnosis == "cancelled" => {
                update("cancelled", "Install cancelled during PyTorch download.");
                return;
            }
            Err(diagnosis) => {
                let err = format!("PyTorch installation failed.\n\n{}", diagnosis);
                println!("[Install] {}", err);
                update("error", &err);
                return;
            }
        }

        if cancelled() {
            update("cancelled", "Install cancelled before requirements install.");
            return;
        }

        // Step 3: Install ComfyUI requirements
        println!("[Install] Installing ComfyUI requirements...");
        update("installing", "Step 3/4: Installing ComfyUI dependencies (live pip output below)...");

        // A3: a folder without requirements.txt is not a ComfyUI checkout, and
        // skipping the step silently is how falconbob_20415's copied install
        // reached "installed successfully" with nothing in it. The clone above
        // treats an existing folder as "pull and carry on", so this is the
        // place that notices.
        let reqs = target_dir.join("requirements.txt");
        if !reqs.exists() {
            update(
                "error",
                &format!(
                    "The folder {} has no requirements.txt, so it is not a complete ComfyUI \
                     checkout and its dependencies cannot be installed. Rename or delete that \
                     folder and run the install again.",
                    target_dir.display()
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
            match pip_install_streaming_with_retry_raw(&req_args, &effective_python, 3, &install_status, Some(&cancel_flag)) {
                Ok(()) => {
                    update("installing", "Dependencies installed successfully.");
                }
                Err(f) if f.diagnosis == "cancelled" => {
                    update("cancelled", "Install cancelled during requirements install.");
                    return;
                }
                Err(f) => {
                    let diagnosis = f.diagnosis.clone();
                    // Not fatal on its own: the import check below decides
                    // whether the environment can actually start. What is
                    // gone is the old "non-critical" verdict, which called
                    // a broken environment a finished one.
                    println!("[Install] Requirements install warning: {}", diagnosis);
                    let reason = requirements_failure_reason_for(&f);
                    let folder = target_dir.display().to_string();
                    requirements_fallback = Some((folder.clone(), reason));
                    update("installing", &requirements_fallback_log(&folder, reason));
                    update(
                        "installing",
                        &format!(
                            "Not every dependency installed. Checking what is really missing.\n\n{}",
                            diagnosis
                        ),
                    );
                }
            }
        }

        // OI-2: the last gate before this run is allowed to call itself a
        // success. Everything above can have gone through — clone reported
        // fine, pip reported fine — and still leave a directory with no
        // ComfyUI in it, and the persist step below writes that directory
        // into config.json where `find_comfyui_path` will keep handing it out
        // long after the install is forgotten.
        if !comfy_install_looks_finished(&target_dir) {
            let err = format!(
                "The install finished but {} has no main.py, so there is no ComfyUI to \
                 start. Nothing was saved as your ComfyUI path. Check the log above for \
                 the step that failed, then retry into an empty folder.",
                target_dir.display()
            );
            println!("[Install] {}", err);
            error!(target = %target_dir.display(), "comfyui install produced no main.py");
            update("error", &err);
            return;
        }

        if cancelled() {
            update("cancelled", "Install cancelled before the environment check.");
            return;
        }

        // Step 4: the environment has to prove it starts. Everything above
        // reads pip exit codes; this reads the interpreter.
        update("installing", "Step 4/4: Checking that the environment really starts...");
        match verify_and_heal_environment(&effective_python, &target_dir, &reqs, &install_status, Some(&cancel_flag)) {
            Ok(()) => {}
            Err(e) if e == "cancelled" => {
                update("cancelled", "Install cancelled during the environment check.");
                return;
            }
            Err(e) => {
                error!("comfyui install finished with an environment that does not import");
                update("error", &format!("ComfyUI was downloaded, but its Python environment is not usable.\n\n{}", e));
                return;
            }
        }

        println!("[Install] ComfyUI installation complete");

        // A user (Discord): the install target is user-configurable now.
        // Persist it exactly like `set_comfyui_path` does (memory + config.json),
        // otherwise a non-default target (e.g. D:\ComfyUI) is installed fine but
        // never found again — `find_comfyui_path` only scans standard locations.
        let dir_str = target_dir.to_string_lossy().to_string();
        {
            let mut p = comfy_path_slot.lock().unwrap();
            *p = Some(dir_str.clone());
        }
        {
            let app_config = crate::os_paths::app_config_dir();
            let _ = std::fs::create_dir_all(&app_config);
            let config_file = app_config.join("config.json");
            let mut config: serde_json::Value = std::fs::read_to_string(&config_file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            config["comfyui_path"] = serde_json::json!(dir_str);
            // An install the user asked LU to make is one LU may start with
            // itself (comfy_boot_plan). A ComfyUI LU merely found is not.
            config["comfyui_autostart"] = serde_json::json!(true);
            let _ = std::fs::write(
                &config_file,
                serde_json::to_string_pretty(&config).unwrap_or_default(),
            );
        }

        if let Ok(mut s) = install_status.lock() {
            let (line, kind) = finished_notice(
                "Install finished. ComfyUI is ready to start.",
                requirements_fallback.as_ref(),
            );
            s.notice = line;
            s.notice_kind = kind.to_string();
        }
        update("complete", "ComfyUI installed successfully!");
    });

    Ok(serde_json::json!({"status": "installing"}))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── OI-2: "ComfyUI installed successfully!" for an empty directory ────
    //
    // git says "already exists" for ANY non-empty target. The installer read
    // that as "a ComfyUI is there", threw the following pull's exit status
    // away, never checked for `.git`, never checked for main.py, and 2 GB
    // later persisted the directory as `comfyui_path` — which then poisoned
    // `find_comfyui_path` for the rest of the config file's life.
    //
    // These tests cover the classification and the final gate. NOT covered:
    // that git actually prints "already exists" for the cases below — that is
    // git's documented behaviour, not ours, and reproducing it needs a real
    // clone into a real directory.

    fn dir_with(entries: &[&str]) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        for e in entries {
            if e.ends_with('/') {
                std::fs::create_dir_all(tmp.path().join(e.trim_end_matches('/'))).unwrap();
            } else {
                std::fs::write(tmp.path().join(e), b"x").unwrap();
            }
        }
        tmp
    }

    #[test]
    fn a_real_comfyui_checkout_is_the_only_target_worth_pulling() {
        let d = dir_with(&[".git/", "main.py"]);
        assert_eq!(classify_existing_target(d.path()), ExistingTarget::ComfyCheckout);
        // And the refusal text for it is empty — there is nothing to refuse.
        assert!(existing_target_refusal(d.path(), ExistingTarget::ComfyCheckout).is_empty());
    }

    #[test]
    fn a_plain_non_empty_folder_is_refused_not_installed_into() {
        // The user pointed the installer at their Downloads folder, or at a
        // directory a previous run left half-populated. git refuses to clone
        // into it and says "already exists" — which is NOT permission to
        // spend 2 GB and call it a ComfyUI.
        let d = dir_with(&["some-file.txt", "notes/"]);
        assert_eq!(classify_existing_target(d.path()), ExistingTarget::NotARepo);
        let msg = existing_target_refusal(d.path(), ExistingTarget::NotARepo);
        assert!(msg.contains(&d.path().display().to_string()), "{msg}");
        assert!(msg.to_lowercase().contains("empty folder"), "{msg}");
    }

    #[test]
    fn a_git_repo_that_is_not_comfyui_is_refused() {
        // Someone else's checkout, or a clone that died before checkout. A
        // `git pull` in there succeeds and still leaves no ComfyUI.
        let d = dir_with(&[".git/", "README.md"]);
        assert_eq!(
            classify_existing_target(d.path()),
            ExistingTarget::ForeignOrIncompleteRepo
        );
        let msg = existing_target_refusal(d.path(), ExistingTarget::ForeignOrIncompleteRepo);
        assert!(msg.contains("main.py"), "{msg}");
    }

    #[test]
    fn an_empty_or_missing_directory_is_not_a_repo() {
        let d = dir_with(&[]);
        assert_eq!(classify_existing_target(d.path()), ExistingTarget::NotARepo);
        assert_eq!(
            classify_existing_target(&d.path().join("does-not-exist")),
            ExistingTarget::NotARepo
        );
    }

    #[test]
    fn the_final_gate_is_main_py_and_nothing_else_counts() {
        // The gate that has to hold before "installed successfully!" is said
        // and before the path is written into config.json. A directory with a
        // venv, a .git and requirements.txt but no main.py is the P14 torso.
        let torso = dir_with(&[".git/", "requirements.txt", "venv/"]);
        assert!(!comfy_install_looks_finished(torso.path()));
        let real = dir_with(&[".git/", "main.py"]);
        assert!(comfy_install_looks_finished(real.path()));
    }

    #[test]
    fn a_cancelled_venv_build_is_not_reported_as_a_failed_install() {
        // P3 (04.09.): `create_comfyui_venv` can answer "cancelled" now, and
        // the install's only error arm turns whatever it gets into "venv
        // creation failed", which the panel shows as "Installing ComfyUI did
        // not finish." So a cancel the user asked for would arrive as a
        // failure, on the PEP 668 path where this call lives.
        //
        // Read out of the source, like the order guards in comfy_repair.rs,
        // and with needles split in half for the same reason: written whole
        // they would match themselves here and the `.expect` could never fire.
        let src = include_str!("comfy_install.rs");
        let needle = |head: &str, tail: &str| format!("{head}{tail}");

        let build = needle("create_comfyui_venv(&target_dir, &chosen_python,", " Some(&cancel_flag))");
        let cancelled_arm = needle("\"Install cancelled while the venv", " was being created.\"");
        let failed_arm = needle("\"venv creation faile", "d.\\n\\n{}\"");

        let at_build = src.find(&build).expect("the install's venv build no longer gets the cancel flag");
        let at_cancelled = src.find(&cancelled_arm).expect("a cancelled venv build is reported as a failed install");
        let at_failed = src.find(&failed_arm).expect("the venv failure arm is gone");

        assert!(at_build < at_cancelled, "the cancel arm does not belong to this call");
        assert!(
            at_cancelled < at_failed,
            "the general failure arm comes first, so it swallows the cancel"
        );

        for (what, n) in [("the venv build", build), ("the cancel arm", cancelled_arm), ("the failure arm", failed_arm)] {
            assert_eq!(
                src.matches(&n).count(),
                1,
                "{what}: the search string finds itself in this test, so its .expect can never fire",
            );
        }
    }

    /// Runde 4, B3: an EXISTING, usable venv must still go through
    /// `choose_torch_python` before the 2 GB torch download starts, exactly
    /// as the freshly-built-venv path already does. Runde 3 moved the check
    /// into the "no existing venv" branch and left this one with none at
    /// all, the Reddit reporter's exact case (an externally installed
    /// ComfyUI whose own venv sat on an unsupported Python). Read out of
    /// the source like the sibling order guard above, needles split in
    /// half so they cannot match themselves here.
    #[test]
    fn an_existing_venv_is_also_checked_before_the_torch_download() {
        let src = include_str!("comfy_install.rs");
        let needle = |head: &str, tail: &str| format!("{head}{tail}");

        let existing_venv_check = needle("choose_torch_python(&venv_py,", " torch_index.as_deref(), &torch_package_refs, \"press Install ComfyUI again\", false)");
        let download_start = needle("Downloading PyTorch + Torchvision", " + Torchaudio (~2 GB total)");

        let at_check = src.find(&existing_venv_check).expect("the existing-venv path no longer checks torch/Python compatibility");
        let at_download = src.find(&download_start).expect("the download step marker is gone");

        assert!(at_check < at_download, "the existing-venv preflight must run before the download starts");

        for (what, n) in [("the existing-venv check", existing_venv_check), ("the download marker", download_start)] {
            assert_eq!(
                src.matches(&n).count(),
                1,
                "{what}: the search string finds itself in this test, so its .expect can never fire",
            );
        }
    }

    /// Runde 6, F12: a crashed Repair can leave an orphaned `venv.lu-old-*`
    /// sibling behind (venv.rs's `restore_orphaned_venv_if_needed`). Install
    /// must adopt it back too, before either the "already exists" branch or
    /// the fresh-venv branch looks at the folder, or a customer who presses
    /// Install instead of Repair after a crash loses a working venv to a
    /// silent rebuild. Read out of the source like the two guards above.
    #[test]
    fn install_also_recovers_an_orphaned_venv_before_touching_the_folder() {
        let src = include_str!("comfy_install.rs");
        let needle = |head: &str, tail: &str| format!("{head}{tail}");

        let recovery_call = needle("restore_orphaned_venv_if_needed(&target_dir", ");");
        let clone_start = needle("Cloning ComfyUI to ", "{:?}");
        let existing_venv_check = needle("comfy_venv_state(&target_dir", ")");

        let at_recovery = src.find(&recovery_call).expect("install no longer recovers an orphaned venv");
        let at_clone = src.find(&clone_start).expect("the clone step marker is gone");
        let at_existing_check = src.find(&existing_venv_check).expect("the existing-venv detection is gone");

        assert!(at_recovery < at_clone, "orphan recovery must run before git clone/pull touches the folder");
        assert!(at_recovery < at_existing_check, "orphan recovery must run before the existing-venv state is read");

        assert_eq!(src.matches(&recovery_call).count(), 1, "the recovery call must appear exactly once");
    }
}

/// KF-28: der Doc-Kommentar über `check_install_disk_pressure` darf nur
/// versprechen, was der Rumpf auch tut.
///
/// Er versprach zwei Prüfungen — „<5 GB frei" UND „or its pending I/O queue
/// suggests sustained 100% utilisation". Die zweite gab es nie; der Rumpf
/// prüft `available_space()` und gibt danach `None` zurück. Die Überschrift
/// des Blocks nennt sogar den Anlass (Bug #1, 100%-busy-drive), also genau
/// den Fall, den die erfundene Hälfte abzufangen schien.
///
/// Diese Wache liest den Quelltext und vergleicht die beiden Hälften
/// miteinander, in BEIDE Richtungen: ein Versprechen ohne Prüfung ist rot,
/// eine Prüfung ohne Versprechen ebenso. Wer die Queue-Prüfung eines Tages
/// wirklich baut, wird hier daran erinnert, den Kommentar mitzunehmen —
/// und wer nur den Kommentar aufhübscht, kommt nicht durch.
#[cfg(test)]
mod disk_pressure_doc_matches_body {
    /// Die eigene Quelle. `include_str!` statt eines Laufzeit-Pfades, damit
    /// der Test nicht davon abhängt, aus welchem Verzeichnis `cargo test`
    /// gestartet wurde.
    const SOURCE: &str = include_str!("comfy_install.rs");

    const SIGNATURE: &str = "fn check_install_disk_pressure";

    /// Die `///`-Zeilen unmittelbar über der Signatur.
    fn doc_comment() -> String {
        let lines: Vec<&str> = SOURCE.lines().collect();
        let at = lines
            .iter()
            .position(|l| l.contains(SIGNATURE) && !l.trim_start().starts_with("//"))
            .expect("check_install_disk_pressure steht noch in dieser Datei");
        let mut doc: Vec<&str> = Vec::new();
        for line in lines[..at].iter().rev() {
            let t = line.trim_start();
            if !t.starts_with("///") {
                break;
            }
            doc.push(t.trim_start_matches("///").trim());
        }
        doc.reverse();
        doc.join(" ").to_lowercase()
    }

    /// Der Rumpf: ab der Signatur bis zur schließenden Klammer in Spalte 0.
    fn body() -> String {
        let lines: Vec<&str> = SOURCE.lines().collect();
        let at = lines
            .iter()
            .position(|l| l.contains(SIGNATURE) && !l.trim_start().starts_with("//"))
            .expect("check_install_disk_pressure steht noch in dieser Datei");
        let end = lines[at..]
            .iter()
            .position(|l| *l == "}")
            .expect("die Funktion wird in Spalte 0 geschlossen");
        lines[at..=at + end].join("\n")
    }

    /// Sagt der Kommentar eine Warteschlangen- oder Auslastungsprüfung zu?
    fn doc_promises_queue(doc: &str) -> bool {
        ["i/o queue", "queue", "utilisation", "utilization", "busy"]
            .iter()
            .any(|w| doc.contains(w))
    }

    /// Steht im Rumpf irgendetwas, das eine solche Prüfung sein könnte?
    /// `sysinfo`-0.33 kennt dafür nur `Disk::usage()` → `DiskUsage`, und das
    /// sind Byte-Zähler seit dem letzten Refresh, keine Warteschlangenlänge.
    fn body_probes_queue(body: &str) -> bool {
        ["usage()", "DiskUsage", "read_bytes", "written_bytes"]
            .iter()
            .any(|w| body.contains(w))
    }

    #[test]
    fn the_comment_promises_exactly_what_the_body_checks() {
        let doc = doc_comment();
        let body = body();

        // Der Teil, der wahr ist und wahr bleiben soll.
        assert!(
            body.contains("available_space()"),
            "der Rumpf prüft den freien Platz nicht mehr — dann stimmt auch \
             der erste Satz des Kommentars nicht mehr"
        );
        assert!(
            doc.contains("free space") || doc.contains("5 gb"),
            "der Kommentar sagt den freien Platz nicht mehr an, den der Rumpf prüft"
        );

        // Und die eigentliche Aussage.
        assert_eq!(
            doc_promises_queue(&doc),
            body_probes_queue(&body),
            "Kommentar und Rumpf sind auseinander: der Kommentar {} von einer \
             Warteschlangen-/Auslastungsprüfung, der Rumpf {}. Beide Hälften \
             gehören zusammen geändert — und das „warum nicht\" steht im \
             Blockkommentar über der Funktion, nicht im Doc-Kommentar, damit \
             eine Absage nicht wie eine Zusage aussieht.\n\n\
             Kommentar:\n{doc}\n",
            if doc_promises_queue(&doc) { "spricht" } else { "spricht NICHT" },
            if body_probes_queue(&body) { "enthält eine" } else { "enthält KEINE" },
        );
    }
}

/// Review Runde 2, B1: nothing may delete the Linux git preflight in
/// `install_comfyui` or move it after the first network write it is meant
/// to guard, without a test going red. Same include_str! + marker technique
/// as `update_checks_the_interpreter_before_pulling_the_repository` in
/// comfy_repair.rs and `the_argv_matchers_share_one_refresh` in
/// process_util.rs: read the file's own source, cut it at the function
/// signature, and require the preflight call text to occur before both
/// download literals the function can hit ("clone" for the fresh install,
/// "pull" for the "already exists, update it" branch).
#[cfg(test)]
mod git_preflight_call_site_guard {
    #[test]
    fn install_comfyui_checks_git_before_clone_and_before_pull() {
        let src = include_str!("comfy_install.rs");
        let fn_start = src
            .find("pub fn install_comfyui(")
            .expect("install_comfyui is gone from comfy_install.rs");
        let body = &src[fn_start..];

        let at_preflight = body.find("git_download_preflight()").expect(
            "install_comfyui no longer calls git_download_preflight(): a fresh \
             Debian 13 or Fedora 43 box without git would clone straight into a \
             cryptic spawn error again instead of the distro-specific hint",
        );
        let at_clone = body
            .find("\"clone\"")
            .expect("the git clone literal is gone from install_comfyui");
        let at_pull = body
            .find("\"pull\"")
            .expect("the git pull literal (already-exists branch) is gone from install_comfyui");

        assert!(
            at_preflight < at_clone,
            "git_download_preflight() (byte {at_preflight}) must run before the \
             clone (byte {at_clone}), not after"
        );
        assert!(
            at_preflight < at_pull,
            "git_download_preflight() (byte {at_preflight}) must run before the \
             already-exists pull (byte {at_pull}) too: both start from the same \
             preflight call, which is single, up front"
        );
    }
}
