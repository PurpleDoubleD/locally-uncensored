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
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::State;
use tracing::{error, info};

use crate::state::AppState;

use super::children::TrackedInstallerChild;
use super::comfy_job::{ComfyJob, COMFY_JOB};
use super::comfy_job::comfy_job_busy_message;
use super::pip::pip_install_streaming_with_retry_cancellable;
use super::torch::plan_pytorch_install;
use super::venv::{create_comfyui_venv, is_pep668_protected};
#[cfg(target_os = "windows")]
use super::git::{windows_git_install_hint, windows_git_probe, WindowsGitState};
#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

// ── Disk-pressure pre-flight (Bug #1 — techx69 100%-busy-drive hang) ────────

/// Return a human-readable warning when the target install drive is short
/// on free space (<5 GB — ComfyUI + PyTorch wheels need ~5 GB) or its
/// pending I/O queue suggests sustained 100% utilisation. Best-effort —
/// returns None if sysinfo can't get reliable data, so we never block a
/// well-meaning install over a probing flake.
fn check_install_disk_pressure(target_dir: &Path) -> Option<String> {
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

    // Bug #1 (techx69): pre-flight disk pressure check. On a drive sitting
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
    // the active ComfyUI path once the install completes (andy_38747).
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

        let cancelled = || cancel_flag.load(Ordering::SeqCst);

        if cancelled() {
            update("cancelled", "Install cancelled before it started.");
            return;
        }

        // Bug N (juliandiggins-stack issue #40, 2026-05-18) — probe Windows
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

        // Step 1: Git clone — spawn+poll instead of cmd.output() so the
        // Cancel button can kill an in-flight clone (Bug #1).
        println!("[Install] Cloning ComfyUI to {:?}", target_dir);
        update("downloading", "Step 1/3: Downloading ComfyUI repository...");

        let mut cmd = Command::new("git");
        cmd.args(["clone", "https://github.com/comfyanonymous/ComfyUI.git"])
            .arg(&target_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut clone_child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let err = format!("Git is not installed or not in PATH: {}", e);
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
                    update("error", &format!("git wait failed: {}", e));
                    return;
                }
            }
        };

        if clone_exit.success() {
            println!("[Install] Git clone successful");
            update("installing", "Repository cloned successfully.");
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
                update("installing", "ComfyUI already exists, pulling latest...");
                if cancelled() {
                    update("cancelled", "Install cancelled.");
                    return;
                }
                let mut pull = Command::new("git");
                pull.args(["pull"]).current_dir(&target_dir)
                    .stdout(Stdio::piped()).stderr(Stdio::piped());
                #[cfg(target_os = "windows")]
                pull.creation_flags(CREATE_NO_WINDOW);
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

        // Bug E (rzgrozt — Arch GH #32 comment, 2026-05-08): if the system
        // Python is PEP 668 protected (Arch, Debian 12+, Fedora 38+, Ubuntu
        // 23.04+), a bare `python -m pip install ...` exits with
        // `error: externally-managed-environment` and leaves the user with
        // a half-cloned ComfyUI dir and no diagnostic. Detect the marker
        // file via the system Python, then create a venv inside the
        // ComfyUI folder and use the venv's Python for every subsequent
        // pip step. The launcher in `process.rs` mirrors this check and
        // prefers the venv when starting ComfyUI, so the user gets a
        // consistent isolated environment without ever touching pacman.
        let effective_python = if is_pep668_protected(&python_bin) {
            update(
                "installing",
                "Python is PEP 668 protected (Arch / Debian 12+ / Fedora 38+ / \
                 Ubuntu 23.04+). Creating an isolated venv at ComfyUI/venv so \
                 pip can install PyTorch + ComfyUI deps without touching your \
                 system Python …",
            );
            match create_comfyui_venv(&target_dir, &python_bin) {
                Ok(venv_py) => {
                    let p = venv_py.to_string_lossy().to_string();
                    update(
                        "installing",
                        &format!("venv ready — using {} for the install.", p),
                    );
                    p
                }
                Err(e) => {
                    update("error", &format!("venv creation failed.\n\n{}", e));
                    return;
                }
            }
        } else {
            python_bin.clone()
        };

        // Step 2: Detect GPU and install PyTorch (probe + wheel choice shared
        // with repair_comfyui_env via plan_pytorch_install).
        let (torch_args, gpu_info) = plan_pytorch_install();
        println!("[Install] {}", gpu_info);
        update("installing", &format!("Step 2/3: {}", gpu_info));
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
        update("installing", "Step 3/3: Installing ComfyUI dependencies (live pip output below)...");

        let reqs = target_dir.join("requirements.txt");
        if reqs.exists() {
            let reqs_str = reqs.to_string_lossy().to_string();
            let req_args = vec![
                "-m", "pip", "install",
                "--progress-bar", "off",
                "--no-input",
                "-r", reqs_str.as_str(),
            ];
            match pip_install_streaming_with_retry_cancellable(&req_args, &effective_python, 3, &install_status, Some(&cancel_flag)) {
                Ok(()) => {
                    update("installing", "Dependencies installed successfully.");
                }
                Err(diagnosis) if diagnosis == "cancelled" => {
                    update("cancelled", "Install cancelled during requirements install.");
                    return;
                }
                Err(diagnosis) => {
                    // Don't fail the whole install — some optional deps may fail
                    // but ComfyUI can still start and the user can fix them later.
                    println!("[Install] Requirements install warning: {}", diagnosis);
                    update("installing", "Some optional dependencies had warnings (non-critical, ComfyUI should still start).");
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

        println!("[Install] ComfyUI installation complete");

        // andy_38747 (Discord): the install target is user-configurable now.
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
            let _ = std::fs::write(
                &config_file,
                serde_json::to_string_pretty(&config).unwrap_or_default(),
            );
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

}
