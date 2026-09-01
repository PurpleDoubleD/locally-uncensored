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

use std::sync::Mutex;

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

}
