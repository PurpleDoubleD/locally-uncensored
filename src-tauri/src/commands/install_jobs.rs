//! Every install that fetches something, in one list for the Downloads tray.
//!
//! Model files have their own queue (`download.rs`) and the Mac's engines their
//! slots (`mlxInstallStore`). Everything else kept its progress in a status
//! field of its own, read only by the screen that started it: leave the screen
//! and a 2.5 GB pip run went on with no row and no way to stop it (David's
//! Windows PC, 21.11.2026, the trainer setup).
//!
//! This module reads those fields and does not own them. Each install still
//! writes its own status, so its screen works as before.
//!
//! Pause is honest here: pip, winget, docker and an installer cannot be frozen
//! and picked up again, so a job says that instead of offering a dead button.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::Manager;

use crate::state::{AppState, InstallState};

/// The tray's sentence for a job without a pause button.
pub(crate) const NO_PAUSE: &str = "This step can be stopped, not paused.";
/// For a step LU cannot interrupt without leaving something broken.
pub(crate) const NO_STOP: &str = "This step finishes on its own.";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallJob {
    pub id: String,
    pub label: String,
    /// running | cancelling | complete | error | cancelled
    pub status: String,
    pub phase: String,
    pub progress: u64,
    pub total: u64,
    pub speed: u64,
    pub can_cancel: bool,
    pub note: String,
}

/// One status word of the installers in the tray's five. None is "nothing to
/// show" (idle, or a word this list does not know).
pub(crate) fn job_status(word: &str) -> Option<&'static str> {
    match word {
        "installing" | "downloading" | "starting" | "running" => Some("running"),
        "cancelling" => Some("cancelling"),
        "complete" | "done" => Some("complete"),
        "error" | "failed" => Some("error"),
        "cancelled" => Some("cancelled"),
        _ => None,
    }
}

/// The line under the name: the headline when the install keeps one, else its
/// last log line, cut so that a pip command does not fill the tray.
pub(crate) fn job_phase(phase: &str, logs: &[String]) -> String {
    let line = if phase.trim().is_empty() { logs.last().map(String::as_str).unwrap_or("") } else { phase };
    let line = line.lines().next().unwrap_or("").trim();
    if line.chars().count() > 120 {
        format!("{}…", line.chars().take(119).collect::<String>())
    } else {
        line.to_string()
    }
}

pub(crate) fn job_from_state(id: &str, label: &str, st: &InstallState, can_cancel: bool) -> Option<InstallJob> {
    let status = job_status(&st.status)?;
    let live = status == "running";
    Some(InstallJob {
        id: id.to_string(),
        label: label.to_string(),
        status: status.to_string(),
        phase: job_phase(&st.phase, &st.logs),
        progress: st.download_progress,
        total: st.download_total,
        speed: st.download_speed.max(0.0) as u64,
        can_cancel: live && can_cancel,
        note: if !live { String::new() } else if can_cancel { NO_PAUSE.to_string() } else { NO_STOP.to_string() },
    })
}

/// A job from one of the Mac's install slots. The tray reads the image, video
/// and music slots through `mlxInstallStore`; the 3D slot had no reader.
pub(crate) fn job_from_slot(id: &str, label: &str, p: &crate::install_state::InstallProgress) -> Option<InstallJob> {
    let status = job_status(&p.status)?;
    let live = status == "running";
    let phase = match p.error.as_deref() {
        Some(e) if status == "error" => job_phase(e, &[]),
        _ => job_phase("", &p.logs),
    };
    Some(InstallJob {
        id: id.to_string(),
        label: label.to_string(),
        status: status.to_string(),
        phase,
        progress: p.download_progress,
        total: p.download_total,
        speed: p.download_speed,
        can_cancel: live,
        note: if live { NO_PAUSE.to_string() } else { String::new() },
    })
}

fn read(id: &str, label: &str, slot: &Mutex<InstallState>, can_cancel: impl Fn(&InstallState) -> bool) -> Option<InstallJob> {
    let st = slot.lock().unwrap_or_else(|e| e.into_inner());
    job_from_state(id, label, &st, can_cancel(&st))
}

// ── Cancel flags of the installs that had none ───────────────────────────

type CancelFlags = Vec<(&'static str, Arc<AtomicBool>)>;

static FLAGS: LazyLock<Mutex<CancelFlags>> = LazyLock::new(|| Mutex::new(Vec::new()));

/// The cancel flag of `id`, lowered. Called when that install starts.
pub(crate) fn fresh_cancel_flag(id: &'static str) -> Arc<AtomicBool> {
    let mut flags = FLAGS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, flag)) = flags.iter().find(|(k, _)| *k == id) {
        flag.store(false, Ordering::SeqCst);
        return flag.clone();
    }
    let flag = Arc::new(AtomicBool::new(false));
    flags.push((id, flag.clone()));
    flag
}

fn raise_flag(id: &str) {
    let flags = FLAGS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, flag)) = flags.iter().find(|(k, _)| *k == id) {
        flag.store(true, Ordering::SeqCst);
    }
}

/// Mark a running install as stopping. `download_file_blocking` reads this.
fn mark_cancelling(slot: &Mutex<InstallState>) -> bool {
    let mut st = slot.lock().unwrap_or_else(|e| e.into_inner());
    if job_status(&st.status) == Some("running") {
        st.status = "cancelling".to_string();
        true
    } else {
        false
    }
}

// ── The list ─────────────────────────────────────────────────────────────

/// A job from the JSON status of an install that keeps its own struct. Every
/// one of them can stop while it runs.
fn from_value(id: &str, label: &str, v: &Value, phase_key: &str, done: &str, of: &str, rate: &str) -> Option<InstallJob> {
    let status = job_status(v.get("status")?.as_str()?)?;
    let num = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
    let live = status == "running";
    Some(InstallJob {
        id: id.to_string(),
        label: label.to_string(),
        status: status.to_string(),
        phase: job_phase(v.get(phase_key).and_then(Value::as_str).unwrap_or(""), &[]),
        progress: num(done),
        total: num(of),
        speed: num(rate),
        can_cancel: live,
        note: if live { NO_PAUSE.to_string() } else { String::new() },
    })
}

fn collect(state: &AppState) -> Vec<InstallJob> {
    let mut jobs: Vec<InstallJob> = Vec::new();
    jobs.extend(read("comfyui", "ComfyUI", &state.install_status, |_| true));
    jobs.extend(read("python", "Python", &state.python_install, |_| false));
    // Only the download of these two can stop. Their installer then runs with
    // Windows' own rights, and killing it halfway breaks the program.
    jobs.extend(read("ollama", "Ollama", &state.ollama_install, |s| s.status == "downloading"));
    jobs.extend(read("lmstudio", "LM Studio", &state.lmstudio_install, |s| s.status == "downloading"));
    jobs.extend(read("whisper", "Speech to text", &state.whisper_install, |_| true));
    jobs.extend(read("tts", "Neural voice", &state.tts_install, |_| true));
    jobs.extend(read("trainer", "Trainer setup", &state.trainer_install, |_| true));
    jobs.extend(read("searxng", "SearXNG", &state.searxng_install, |_| true));
    // A training run repairs its own environment first. Only that part is a
    // download, the training itself has its own progress on its screen.
    if let Ok(run) = state.trainer_run.lock() {
        if run.status == "running" && run.phase.starts_with("Repairing the trainer") {
            jobs.extend(job_from_state("trainer-repair", "Trainer repair", &run, true));
        }
    }
    jobs.extend(job_from_slot("mesh3d", "3D model", &state.install_mesh3d().snapshot()));
    let voice = state.voice_loop.job.snapshot();
    if let Ok(v) = serde_json::to_value(&voice) {
        jobs.extend(from_value("voice-loop", "Voice mode", &v, "message", "bytes_done", "bytes_total", "bytes_per_second"));
    }
    #[cfg(desktop)]
    {
        let view = crate::commands::parakeet::parakeet_status().job;
        if view.running {
            jobs.push(InstallJob {
                id: "parakeet".to_string(),
                label: "Parakeet dictation".to_string(),
                status: "running".to_string(),
                phase: String::new(),
                progress: view.done_bytes,
                total: view.total_bytes,
                speed: 0,
                can_cancel: true,
                note: NO_PAUSE.to_string(),
            });
        }
        let neuron = crate::commands::neuron::neuron_status();
        if neuron.get("kind").and_then(Value::as_str) == Some("download") {
            jobs.extend(from_value("neuron", "Neuron feature data", &neuron, "phase_label", "bytes_done", "bytes_total", "rate_bps"));
        }
    }
    let abliterate = crate::commands::abliterate::abliterate_status();
    if abliterate.get("status").and_then(Value::as_str) == Some("running")
        && abliterate.get("bytes").and_then(Value::as_bool) == Some(true)
    {
        jobs.extend(from_value("abliterate", "Abliteration model", &abliterate, "phaseLabel", "step", "total", "rateBps"));
    }
    for (id, label) in crate::install_state::activities() {
        jobs.push(InstallJob {
            id,
            label,
            status: "running".to_string(),
            phase: String::new(),
            progress: 0,
            total: 0,
            speed: 0,
            can_cancel: false,
            note: NO_STOP.to_string(),
        });
    }
    jobs
}

/// Cheap and meant to be polled: it reads status fields and starts nothing.
#[tauri::command]
pub async fn install_jobs(app: tauri::AppHandle) -> Result<Vec<InstallJob>, String> {
    // Parakeet's status looks at the disk, so not on the main thread.
    tokio::task::spawn_blocking(move || collect(&app.state::<AppState>()))
        .await
        .map_err(|e| format!("install_jobs task: {e}"))
}

fn cancel(state: &AppState, id: &str) -> Result<(), String> {
    match id {
        "comfyui" => crate::commands::install::cancel_comfyui_install_blocking(state).map(|_| ()),
        "trainer" | "trainer-repair" => crate::commands::trainer::cancel_character_training_blocking(state),
        "whisper" => {
            raise_flag(id);
            mark_cancelling(&state.whisper_install);
            Ok(())
        }
        "tts" => {
            raise_flag(id);
            mark_cancelling(&state.tts_install);
            Ok(())
        }
        "searxng" => {
            raise_flag(id);
            mark_cancelling(&state.searxng_install);
            Ok(())
        }
        "ollama" => stop_download(&state.ollama_install),
        "lmstudio" => stop_download(&state.lmstudio_install),
        "mesh3d" => {
            state.install_mesh3d().cancel();
            Ok(())
        }
        "voice-loop" => {
            state.voice_loop.job.cancel();
            Ok(())
        }
        "abliterate" => {
            crate::commands::abliterate::cancel_now();
            Ok(())
        }
        #[cfg(desktop)]
        "parakeet" => {
            crate::commands::parakeet::parakeet_cancel();
            Ok(())
        }
        #[cfg(desktop)]
        "neuron" => {
            crate::commands::neuron::neuron_cancel();
            Ok(())
        }
        other => Err(format!("{other} cannot be stopped.")),
    }
}

fn stop_download(slot: &Mutex<InstallState>) -> Result<(), String> {
    let downloading = slot.lock().unwrap_or_else(|e| e.into_inner()).status == "downloading";
    if !downloading {
        return Err("The installer is already running and finishes on its own.".to_string());
    }
    mark_cancelling(slot);
    Ok(())
}

#[tauri::command]
pub async fn cancel_install_job(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || cancel(&app.state::<AppState>(), &id))
        .await
        .map_err(|e| format!("cancel_install_job task: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(status: &str) -> InstallState {
        InstallState { status: status.to_string(), ..InstallState::default() }
    }

    #[test]
    fn every_status_word_the_installers_write_has_a_place() {
        for (word, want) in [
            ("installing", "running"), ("downloading", "running"), ("starting", "running"), ("running", "running"),
            ("cancelling", "cancelling"), ("complete", "complete"), ("done", "complete"),
            ("error", "error"), ("failed", "error"), ("cancelled", "cancelled"),
        ] {
            assert_eq!(job_status(word), Some(want), "{word}");
        }
        assert_eq!(job_status("idle"), None);
    }

    #[test]
    fn an_idle_install_is_not_a_row() {
        assert!(job_from_state("x", "X", &st("idle"), true).is_none());
    }

    #[test]
    fn a_running_job_says_what_it_cannot_do_instead_of_a_dead_button() {
        let stoppable = job_from_state("x", "X", &st("installing"), true).unwrap();
        assert!(stoppable.can_cancel);
        assert_eq!(stoppable.note, NO_PAUSE);
        let fixed = job_from_state("x", "X", &st("installing"), false).unwrap();
        assert!(!fixed.can_cancel);
        assert_eq!(fixed.note, NO_STOP);
    }

    #[test]
    fn a_finished_job_offers_no_stop() {
        let done = job_from_state("x", "X", &st("complete"), true).unwrap();
        assert!(!done.can_cancel);
        assert!(done.note.is_empty());
    }

    #[test]
    fn the_headline_wins_and_a_long_line_is_cut() {
        assert_eq!(job_phase("Step 3", &["pip chatter".to_string()]), "Step 3");
        assert_eq!(job_phase("", &["last".to_string()]), "last");
        assert_eq!(job_phase(&"x".repeat(300), &[]).chars().count(), 120);
    }

    #[test]
    fn the_3d_slot_of_a_mac_is_a_row_with_a_stop() {
        use crate::install_state::InstallProgress;
        let running = InstallProgress { status: "installing".into(), logs: vec!["downloading".into()], download_total: 10, ..InstallProgress::default() };
        let job = job_from_slot("mesh3d", "3D model", &running).unwrap();
        assert!(job.can_cancel);
        assert_eq!((job.phase.as_str(), job.total), ("downloading", 10));
        let failed = InstallProgress { status: "error".into(), error: Some("no room".into()), ..InstallProgress::default() };
        assert_eq!(job_from_slot("mesh3d", "3D model", &failed).unwrap().phase, "no room");
        assert!(job_from_slot("mesh3d", "3D model", &InstallProgress::default()).is_none());
    }

    #[test]
    fn a_new_run_lowers_the_flag_of_the_last_one() {
        let flag = fresh_cancel_flag("test-flag");
        raise_flag("test-flag");
        assert!(flag.load(Ordering::SeqCst));
        let again = fresh_cancel_flag("test-flag");
        assert!(!again.load(Ordering::SeqCst));
    }

    #[test]
    fn marking_stops_only_what_runs() {
        let running = Mutex::new(st("downloading"));
        assert!(mark_cancelling(&running));
        assert_eq!(running.lock().unwrap().status, "cancelling");
        let done = Mutex::new(st("complete"));
        assert!(!mark_cancelling(&done));
        assert_eq!(done.lock().unwrap().status, "complete");
    }
}
