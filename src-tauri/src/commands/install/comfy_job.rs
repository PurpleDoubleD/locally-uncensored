//! Wer gerade an ComfyUI arbeiten darf — und wie die Oberfläche davon erfährt.
//!
//! Drei Befehle greifen auf dasselbe ComfyUI-Verzeichnis zu: Installation,
//! Reparatur, Update. Sie teilen sich zwei Dinge, und beide liegen hier.
//!
//! Das erste ist der BESITZ. Bis 2.6.8 bewachte sich jeder der drei selbst,
//! indem er die Statuszeichenkette verglich — und zwar uneinheitlich, sodass
//! während des Clones (`"downloading"`) die Reparatur durchkam und das venv
//! unter einer laufenden Installation löschte. Eine Statuszeichenkette kann
//! "besetzt" nicht ausdrücken, weil sie zugleich der Fortschrittskanal der
//! Oberfläche ist. Also bekommt der Besitz ein eigenes Schloss.
//!
//! Das zweite ist der KANAL selbst: `install_comfyui_status` liest den
//! Statusschlitz, den alle drei beschreiben, und `cancel_comfyui_install`
//! setzt das Abbruchmerker-Flag, das alle drei in ihren Warteschleifen
//! abfragen. Beide gehören keinem der drei Aufträge allein — sie sind die
//! Bedienfläche über dem, was gerade läuft.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use tauri::{Manager, State};

use crate::state::AppState;

// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread.
// The State borrow cannot cross into the blocking pool, so the handle is
// re-resolved there from the AppHandle (same pattern as engine.rs/whisper.rs).
#[tauri::command]
pub async fn cancel_comfyui_install(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        cancel_comfyui_install_blocking(&state)
    })
    .await
    .map_err(|e| format!("cancel_comfyui_install task: {e}"))?
}

fn cancel_comfyui_install_blocking(state: &AppState) -> Result<serde_json::Value, String> {
    // OI-7: the flag is still what cancel uses, deliberately. It is scoped to
    // the ComfyUI install — the poll loops that watch it now take the child's
    // whole TREE down (see `pip_install_streaming_with_retry_cancellable` and
    // the clone loop), which is what was missing, and they notice within
    // ~200 ms. `kill_installer_children` is NOT called here: the registry it
    // walks also holds the pip runs of the whisper, Piper, custom-node and
    // trainer installers, and "Cancel ComfyUI install" must not take those
    // with it. That registry's kill belongs to shutdown, where killing
    // everything is the correct answer.
    state.comfyui_install_cancel.store(true, Ordering::SeqCst);
    if let Ok(mut s) = state.install_status.lock() {
        // Mark as cancelling immediately so the UI can switch to a
        // "Cancelling…" indicator even before the spawn loop notices.
        if s.status == "installing" || s.status == "downloading" {
            s.status = "cancelling".to_string();
            s.logs.push("Cancellation requested — waiting for active subprocess to exit…".to_string());
        }
    }
    Ok(serde_json::json!({"status": "cancelling"}))
}

// ── OI-5: one job per runtime, held by a lock and not by a string ───────────

/// The three commands that own ComfyUI's install directory: `install_comfyui`,
/// `repair_comfyui_env`, `update_comfyui`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ComfyJob {
    Install,
    Repair,
    Update,
}

impl ComfyJob {
    /// What to call this job in a sentence aimed at the user.
    pub(crate) fn label(self) -> &'static str {
        match self {
            ComfyJob::Install => "a ComfyUI installation",
            ComfyJob::Repair => "a ComfyUI environment repair",
            ComfyJob::Update => "a ComfyUI update",
        }
    }
}

/// Mutual exclusion for those three commands.
///
/// They all narrate into ONE `install_status` slot and all write the same
/// directory, and until 2.6.8 each guarded itself by comparing that slot's
/// status string — inconsistently: install and repair refused only on
/// `"installing"`, update refused on `"installing"` or `"downloading"`. The
/// installer sets `"downloading"` for the whole git clone, so during a clone
/// the repair's guard was open: it would delete the venv out from under a
/// running install, both would report success over a half-built environment,
/// and their log lines would interleave in the one panel the user is watching.
///
/// A status string cannot express "busy" because the status is also the UI's
/// progress channel — it changes for reasons that have nothing to do with
/// ownership. So ownership gets its own slot and a real lock: `Some(job)`
/// means that job owns the runtime until its guard drops, which happens when
/// its worker thread ends, however it ends, including a panic.
#[derive(Clone, Default)]
pub(crate) struct ComfyJobSlot {
    current: Arc<Mutex<Option<ComfyJob>>>,
}

/// Ownership of the ComfyUI runtime. Dropping it releases the runtime, so it
/// is moved into the worker thread and lives exactly as long as the job.
#[derive(Debug)]
pub(crate) struct ComfyJobGuard {
    current: Arc<Mutex<Option<ComfyJob>>>,
}

impl Drop for ComfyJobGuard {
    fn drop(&mut self) {
        // A poisoned mutex must not wedge the runtime for the rest of the
        // session, and a panic inside Drop during an unwind aborts the
        // process — so recover the guard rather than unwrapping it.
        let mut g = self.current.lock().unwrap_or_else(|e| e.into_inner());
        *g = None;
    }
}

impl ComfyJobSlot {
    /// Take the runtime for `job`, or report which job already holds it.
    pub(crate) fn try_acquire(&self, job: ComfyJob) -> Result<ComfyJobGuard, ComfyJob> {
        let mut g = self.current.lock().unwrap_or_else(|e| e.into_inner());
        match *g {
            Some(running) => Err(running),
            None => {
                *g = Some(job);
                Ok(ComfyJobGuard { current: self.current.clone() })
            }
        }
    }

    /// Which job owns the runtime right now, if any. Used by the tests to
    /// assert the guard releases; production code only ever needs `try_acquire`.
    #[allow(dead_code)]
    pub(crate) fn current(&self) -> Option<ComfyJob> {
        *self.current.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The process-wide slot. There is exactly one ComfyUI runtime per running
/// app, so there is exactly one of these; the type stays instantiable so the
/// tests exercise their own instead of racing on this one.
pub(super) static COMFY_JOB: once_cell::sync::Lazy<ComfyJobSlot> =
    once_cell::sync::Lazy::new(ComfyJobSlot::default);

/// Refusal text for a job that arrived while another one owns the runtime.
///
/// Returned as an `Err`, which matters for the self-healing path: the Create
/// tab fires `repair_comfyui_env` and then polls `install_comfyui_status`
/// until it reads `"complete"`. An `Ok` here would let it read the OTHER
/// job's completion as "environment repaired" and hand the user a repair that
/// never happened.
pub(crate) fn comfy_job_busy_message(wanted: ComfyJob, running: ComfyJob) -> String {
    format!(
        "Cannot start {} while {} is running — they share one ComfyUI folder and would \
         corrupt each other's environment. Wait for the running job to finish (its \
         progress is in the same panel), then retry.",
        wanted.label(),
        running.label()
    )
}

#[tauri::command]
pub fn install_comfyui_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.install_status.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
        "download_progress": install.download_progress,
        "download_total": install.download_total,
        "download_speed": install.download_speed,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── OI-5: install / repair / update share one runtime ─────────────────
    //
    // They guarded themselves by comparing the shared status string, and
    // inconsistently: install and repair refused only on "installing", update
    // also on "downloading". The installer sets "downloading" for the whole
    // git clone, so a repair started during a clone walked straight past the
    // guard and deleted the venv under a running install.
    //
    // The tests drive the lock itself. NOT covered: that a real concurrent
    // install and repair now interleave correctly — that needs two real
    // 2 GB installs.

    #[test]
    fn a_second_job_cannot_take_a_runtime_that_is_already_owned() {
        let slot = ComfyJobSlot::default();
        let held = slot.try_acquire(ComfyJob::Install).expect("free runtime");
        assert_eq!(slot.current(), Some(ComfyJob::Install));
        // This is the exact sequence that used to corrupt the venv: a repair
        // arriving while the installer is cloning.
        assert_eq!(slot.try_acquire(ComfyJob::Repair).err(), Some(ComfyJob::Install));
        assert_eq!(slot.try_acquire(ComfyJob::Update).err(), Some(ComfyJob::Install));
        drop(held);
        assert_eq!(slot.current(), None);
        assert!(slot.try_acquire(ComfyJob::Repair).is_ok());
    }

    #[test]
    fn the_runtime_comes_back_when_the_job_thread_panics() {
        // Guards are moved into worker threads. A thread that dies must not
        // leave ComfyUI locked for the rest of the session.
        let slot = ComfyJobSlot::default();
        let guard = slot.try_acquire(ComfyJob::Install).unwrap();
        let handle = std::thread::spawn(move || {
            let _g = guard;
            panic!("pip exploded");
        });
        assert!(handle.join().is_err());
        assert_eq!(slot.current(), None, "a panicking job left the runtime locked");
    }

    #[test]
    fn the_same_job_twice_is_told_it_is_already_running() {
        // Double-clicking Install is idempotent, not an error.
        let slot = ComfyJobSlot::default();
        let _held = slot.try_acquire(ComfyJob::Install).unwrap();
        assert_eq!(slot.try_acquire(ComfyJob::Install).err(), Some(ComfyJob::Install));
    }

    #[test]
    fn the_busy_message_names_both_jobs_and_says_why() {
        // This text is what the self-healing path surfaces instead of
        // silently reporting a repair that never ran.
        let msg = comfy_job_busy_message(ComfyJob::Repair, ComfyJob::Install);
        assert!(msg.contains("repair"), "{msg}");
        assert!(msg.contains("installation"), "{msg}");
        assert!(msg.to_lowercase().contains("corrupt"), "{msg}");
    }

}
