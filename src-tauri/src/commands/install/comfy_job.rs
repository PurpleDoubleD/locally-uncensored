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

/// What the log says the moment Cancel is pressed.
///
/// One sentence for all three jobs, because cancel cannot tell them apart:
/// the only thing it can read is the shared status string, and that says
/// "installing" whether git is cloning, pip is downloading, an import probe is
/// running or a folder is being moved aside. A sentence naming a subprocess is
/// therefore a guess, and P3 caught it guessing wrong.
pub(crate) const CANCEL_WAIT_LINE: &str = "Cancellation requested. Stopping at the next safe point...";

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
            // P3 (04.09.): this line used to promise "waiting for the active
            // subprocess to exit", and the only thing cancel can see is that
            // status string, which says nothing about what kind of work is
            // running. During the venv step of a repair there is no subprocess
            // at all, so the sentence was simply wrong at the moment the user
            // read it. What every step DOES share is the shape of the answer:
            // each one stops at its next check.
            s.logs.push(CANCEL_WAIT_LINE.to_string());
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
        // Empty for every run that has nothing to add. A finished run that had
        // to skip the ComfyUI requirements.txt puts its one closing line here,
        // because the log itself is dropped the moment the panel goes idle.
        "notice": install.notice,
        "notice_kind": install.notice_kind,
        "download_progress": install.download_progress,
        "download_total": install.download_total,
        "download_speed": install.download_speed,
    }))
}



/// The live log line that names the fallback while it happens.
///
/// It says what the run really does, and only since P3 (04.09.) is that worth
/// saying: the environment check holds its own list of packages
/// (`KNOWN_IMPORT_NAMES`), imports every one of them and installs back what is
/// missing. Before that the check read its target state from the same
/// requirements.txt pip had just failed on, so the old wording, "installing
/// LU's own package list instead", promised a list that did nothing.
pub(crate) fn requirements_fallback_log(folder: &str, reason: &str) -> String {
    format!(
        "requirements.txt in {} could not be used ({}), checking the packages LU knows about and \
         installing the ones that are missing.",
        folder, reason
    )
}

/// The line every finished run leaves behind.
///
/// David, 03.09.: a run that worked has to say so. The cancel already had a
/// closing sentence and the success had none, so the abort was better labelled
/// than the success (A13 Befund 1a), and three full repairs of six to eight
/// minutes each ended with the card simply vanishing. The requirements hint is
/// appended rather than substituted: the run did finish, and the user needs
/// both halves of that.
pub(crate) fn finished_notice(
    done: &str,
    fallback: Option<&(String, &'static str)>,
) -> (String, &'static str) {
    match fallback {
        Some((folder, reason)) => (
            format!("{} {}", done, requirements_fallback_notice(folder, reason)),
            "warn",
        ),
        None => (done.to_string(), "ok"),
    }
}

/// The half sentence about a requirements.txt the run had to pass over. Without
/// it the panel goes back to idle and every word about the skipped file scrolls
/// away with the log.
pub(crate) fn requirements_fallback_notice(folder: &str, reason: &str) -> String {
    format!(
        "The requirements.txt in {} could not be used ({}), so LU checked the packages it knows \
         about and installed the ones that were missing. Anything that file asks for on top of \
         that list is not installed.",
        folder, reason
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::pip::{requirements_failure_reason, INVENTED_PACKAGE};

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


    #[test]
    fn the_closing_line_says_what_is_missing_afterwards() {
        let notice = requirements_fallback_notice(
            "C:\\Users\\ddrob\\ComfyUI",
            requirements_failure_reason(INVENTED_PACKAGE),
        );
        assert!(notice.contains("C:\\Users\\ddrob\\ComfyUI"), "got: {notice}");
        assert!(notice.contains("LU checked the packages it knows about"), "got: {notice}");
        assert!(notice.contains("installed the ones that were missing"), "got: {notice}");
        // The half the report asked for: the user has to learn that ComfyUI is
        // now short of whatever that file wanted.
        assert!(notice.contains("is not installed"), "got: {notice}");
    }


    /// Negative control on the state itself: nothing is carried over from a
    /// run that never happened.
    #[test]
    fn a_fresh_install_state_carries_no_closing_line() {
        let fresh = crate::state::InstallState::default();
        assert!(fresh.notice.is_empty());
        assert!(fresh.notice_kind.is_empty());
        let json = serde_json::to_value(&fresh).expect("serialises");
        assert_eq!(json["notice"], serde_json::json!(""));
        assert_eq!(json["notice_kind"], serde_json::json!(""));
    }

    /// David, 03.09.: a run that worked says so, every time. And it does not
    /// say it in the colour of a warning (A15 review).
    #[test]
    fn a_run_that_worked_leaves_a_closing_line_of_its_own() {
        for done in [
            "Install finished. ComfyUI is ready to start.",
            "Repair finished. ComfyUI is ready.",
            "Update finished. Restart ComfyUI to load the new nodes.",
        ] {
            let (line, kind) = finished_notice(done, None);
            assert_eq!(line, done);
            assert_eq!(kind, "ok");
        }
    }

    /// And a run that had to skip the requirements.txt says both halves, in
    /// that order: it finished, and here is what it could not use. That one is
    /// a warning.
    #[test]
    fn a_finished_run_that_skipped_the_file_says_both_halves() {
        let fallback = (
            "C:\\Users\\ddrob\\ComfyUI".to_string(),
            requirements_failure_reason(INVENTED_PACKAGE),
        );
        let (line, kind) = finished_notice("Repair finished. ComfyUI is ready.", Some(&fallback));
        assert!(line.starts_with("Repair finished. ComfyUI is ready. "), "got: {line}");
        assert!(line.contains("could not be used"), "got: {line}");
        assert!(line.contains("C:\\Users\\ddrob\\ComfyUI"), "got: {line}");
        // Negative control on the substitution: the success half is not
        // replaced by the warning, which is what a run that finished deserves.
        assert!(line.contains("Repair finished"), "got: {line}");
        assert_eq!(kind, "warn");
    }

    // ── P3 (04.09.): the line cancel writes must be true in every step ─────

    #[test]
    fn cancel_does_not_promise_a_subprocess_it_cannot_see() {
        // The tester cancelled during "Removing the old venv", where no child
        // process is running at all, and was told LU was waiting for one to
        // exit. Cancel's only input is the status string, so it cannot know
        // better; the fix is a sentence that does not claim to.
        let state = AppState::new();
        {
            let mut s = state.install_status.lock().unwrap();
            s.status = "installing".to_string();
            s.logs.push("Removing the old venv (models, outputs and custom nodes stay untouched)...".to_string());
        }

        cancel_comfyui_install_blocking(&state).expect("cancel refused");

        let s = state.install_status.lock().unwrap();
        assert_eq!(s.status, "cancelling", "the panel was not switched over");
        let last = s.logs.last().expect("cancel wrote no line at all");
        assert!(
            !last.to_lowercase().contains("subprocess"),
            "cancel still names a subprocess: {last}"
        );
        assert!(last.contains("Cancellation requested"), "got: {last}");
        // And it says what actually happens, so the wait is not a mystery.
        assert!(last.contains("next safe point"), "got: {last}");
    }

    #[test]
    fn cancel_writes_nothing_into_a_run_that_is_not_going() {
        // The control on the other side. The status guard is what keeps a
        // stray Cancel from stamping "Cancellation requested" over a finished
        // run's log, and a test that only reads the sentence would not see it
        // if that guard were dropped along with the old wording.
        let state = AppState::new();
        {
            let mut s = state.install_status.lock().unwrap();
            s.status = "complete".to_string();
            s.logs.push("Repair finished. ComfyUI is ready.".to_string());
        }

        cancel_comfyui_install_blocking(&state).expect("cancel refused");

        let s = state.install_status.lock().unwrap();
        assert_eq!(s.status, "complete", "a finished run was marked as cancelling");
        assert_eq!(
            s.logs.last().map(String::as_str),
            Some("Repair finished. ComfyUI is ready."),
            "cancel wrote into a run that was already over"
        );
    }

}
