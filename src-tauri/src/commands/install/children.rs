//! Das Register der Kindprozesse, die die Installer gerade laufen haben.
//!
//! Der geteilte Zustand ist eine prozessweite Menge von PIDs: jeder pip-Lauf
//! und der git-Clone tragen sich beim Start ein und beim Ende wieder aus. Wer
//! diese Menge liest, will sie töten — deshalb liegt hier neben dem Register
//! auch der einzige Weg hinein (`TrackedInstallerChild`, RAII) und der einzige
//! Weg, sie zu leeren (`kill_installer_children`, Teil des App-Endes).
//!
//! Die Naht läuft genau um diese Menge herum. Sie gehört weder zu pip noch
//! zu ComfyUI, obwohl beide sie füllen: eine veraltete PID darin ist ein
//! Kill auf die Zahl, die das Betriebssystem inzwischen weiterverwendet hat,
//! und diese Gefahr lässt sich nur an einer Stelle im Blick behalten.

use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tracing::info;

// ── OI-7: installer children are tracked, and killed as a tree ──────────────

/// The pids of every subprocess the installers currently have running: the
/// git clone, and each pip run.
///
/// Two things were missing without it.
///
/// Cancel killed only the process LU itself spawned. `Child::kill()` signals
/// `pip` and nothing else, so the tree pip forks — `setup.py`, `ninja`, a full
/// compiler run for a source wheel — kept the disk and the CPU busy long after
/// the panel said "cancelled", which on the 100%-utilisation drives from Bug
/// #1 is precisely the machine that cannot afford it.
///
/// Quit killed nothing at all. ComfyUI, Ollama, the bundled engine, the MLX
/// sidecar and the trainer each have a slot that `shutdown_subprocesses`
/// walks; installer children had none, so closing the app mid-install left pip
/// and its descendants resident with no UI left that could stop them.
///
/// The kill goes through `shell::kill_tree` — the same pid-based recursive
/// kill the trainer and the agent shell already use.
static INSTALLER_CHILDREN: once_cell::sync::Lazy<Mutex<std::collections::HashSet<u32>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(std::collections::HashSet::new()));

/// Keeps a pid in [`INSTALLER_CHILDREN`] for as long as the value lives.
///
/// RAII rather than a register/unregister pair: a pip run has half a dozen
/// early returns plus a panic path, and a pid left behind after the process
/// exits is a kill aimed at whatever the OS recycles that number into.
pub(crate) struct TrackedInstallerChild(u32);

impl TrackedInstallerChild {
    pub(crate) fn register(pid: u32) -> Self {
        if let Ok(mut set) = INSTALLER_CHILDREN.lock() {
            set.insert(pid);
        }
        TrackedInstallerChild(pid)
    }
}

impl Drop for TrackedInstallerChild {
    fn drop(&mut self) {
        if let Ok(mut set) = INSTALLER_CHILDREN.lock() {
            set.remove(&self.0);
        }
    }
}

/// Kill every installer child still running, each one tree and all. Returns
/// the number of roots signalled.
///
/// Called from the app's shutdown path only. Cancel does NOT use it: the
/// registry is process-wide and holds the whisper, Piper, custom-node and
/// trainer pip runs as well, and "Cancel ComfyUI install" must not take those
/// with it. Cancel goes through the per-install cancel flag, whose poll loops
/// now do the same recursive kill on the one child they own.
pub fn kill_installer_children() -> usize {
    let pids: Vec<u32> = match INSTALLER_CHILDREN.lock() {
        Ok(set) => set.iter().copied().collect(),
        Err(e) => e.into_inner().iter().copied().collect(),
    };
    for pid in &pids {
        crate::commands::shell::kill_tree(*pid);
    }
    if !pids.is_empty() {
        info!(count = pids.len(), "killed installer child process trees");
    }
    pids.len()
}

/// Wait for an installer child, and give up the moment the cancel flag flips.
///
/// `Ok(status)` means the child ended by itself. `Err("cancelled")` is the
/// same sentinel `pip` and `env_check` already return, so callers catch a
/// cancel the way they always did. Any other `Err` is the wait itself failing.
///
/// The kill takes the whole TREE, not just the child LU spawned: `python -m
/// venv` runs `ensurepip` as its own process, and `Child::kill` never reaches
/// it. That is a kill on ONE pid, not on [`INSTALLER_CHILDREN`], which also
/// holds the whisper, Piper, custom-node and trainer pip runs.
///
/// P3 (04.09.): cancelling a repair took 76 seconds because the venv build had
/// no loop like this one and simply ran to the end. `pip.rs` keeps its own
/// copy of the loop deliberately: that one also turns the child's cumulative
/// read bytes into download progress and speed once a second, which is work
/// this bare version has no reason to do. Whoever removes the progress
/// counters from pip folds the two together.
pub(crate) fn wait_or_cancel(
    child: &mut Child,
    cancel: Option<&Arc<AtomicBool>>,
    label: &str,
) -> Result<ExitStatus, String> {
    let pid = child.id();
    loop {
        if cancel.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
            crate::commands::shell::kill_tree(pid);
            let _ = child.kill();
            let _ = child.wait();
            return Err("cancelled".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            // 200 ms is the interval every other cancel poll in the installer
            // uses, so the budget the UI promises is the same everywhere.
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(200)),
            Err(e) => {
                return Err(format!(
                    "Waiting for {label} failed: {}",
                    crate::os_error::english(&e)
                ))
            }
        }
    }
}

/// How many installer children are registered right now. Test-facing: the
/// registry's contract is that it is empty again once a run is over.
#[allow(dead_code)]
pub(crate) fn tracked_installer_children() -> usize {
    match INSTALLER_CHILDREN.lock() {
        Ok(set) => set.len(),
        Err(e) => e.into_inner().len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── OI-7: installer children are tracked ─────────────────────────────

    #[test]
    fn the_child_registry_empties_itself_when_a_run_ends() {
        // Every entry is a pid that will be handed to a recursive kill, so a
        // stale one is a kill aimed at whatever the OS recycled that number
        // into. The RAII guard is what keeps that from happening across pip's
        // many early returns.
        let before = tracked_installer_children();
        {
            let _a = TrackedInstallerChild::register(999_001);
            let _b = TrackedInstallerChild::register(999_002);
            assert!(tracked_installer_children() >= before + 2);
        }
        assert_eq!(tracked_installer_children(), before);
    }

    // ── P3 (04.09.): a cancel that is sat out is not a cancel ─────────────
    //
    // The repair's venv build had no wait loop, so pressing Cancel during it
    // did nothing until `python -m venv` was finished by itself. These two
    // drive the loop directly, with a real child and no Python needed.

    /// A child that will not end on its own inside a test's lifetime.
    fn a_child_that_never_ends() -> Child {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", "timeout", "/T", "120", "/NOBREAK"]);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = std::process::Command::new("sleep");
            c.arg("120");
            c
        };
        cmd.spawn().expect("a sleeping child could not be started")
    }

    #[test]
    fn a_cancelled_child_is_given_up_on_in_a_fraction_of_its_runtime() {
        let mut child = a_child_that_never_ends();
        let flag = Arc::new(AtomicBool::new(false));
        let trip = flag.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            trip.store(true, Ordering::SeqCst);
        });

        let started = std::time::Instant::now();
        let out = wait_or_cancel(&mut child, Some(&flag), "the test child");
        let waited = started.elapsed();

        assert_eq!(out.err().as_deref(), Some("cancelled"));
        // The child sleeps two minutes. Anything near that means the flag was
        // read once at the start and never again, which is the bug.
        assert!(
            waited < std::time::Duration::from_secs(5),
            "the cancel was sat out for {waited:?}"
        );
        // And the child is really gone, not just abandoned.
        assert!(
            child.try_wait().expect("try_wait after cancel").is_some(),
            "the child outlived the cancel"
        );
    }

    #[test]
    fn a_child_left_alone_still_runs_to_its_own_end() {
        // Negative control, and the important half: a helper that always
        // answered "cancelled" would pass the test above and kill every venv
        // build in the app. With no flag, and with a flag that stays down,
        // the child must finish and hand back its own exit status.
        for cancel in [None, Some(Arc::new(AtomicBool::new(false)))] {
            #[cfg(windows)]
            let mut child = std::process::Command::new("cmd")
                .args(["/C", "exit", "0"])
                .spawn()
                .expect("a short child could not be started");
            #[cfg(not(windows))]
            let mut child = std::process::Command::new("true")
                .spawn()
                .expect("a short child could not be started");

            let status = wait_or_cancel(&mut child, cancel.as_ref(), "the test child")
                .expect("a child nobody cancelled came back as an error");
            assert!(status.success(), "the child's own exit status was lost");
        }
    }

}
