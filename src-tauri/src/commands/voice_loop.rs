//! The voice loop of the Astra tool: its in-app setup and its lifecycle.
//!
//! The loop is a Python sidecar (`resources/voice_loop`, a loopback Pipecat
//! service). This module installs what it needs, starts and stops it, and
//! tells the interface what state it is in.
//!
//!   * `layout`    where things are on disk, which machines are supported
//!   * `manifest`  `models.json`, `python.json`, the pins in the lock file
//!   * `fetch`     resumable download that keeps nothing unverified
//!   * `install`   the background setup job, the report of what it would do,
//!     uninstall
//!   * `sidecar`   the process: token, stdout protocol, state, stop
//!
//! Everything below the Tauri commands works without an `AppHandle`, so the
//! tests run it against temporary folders and the real sidecar.

pub mod fetch;
pub mod install;
pub mod layout;
pub mod manifest;
pub mod sidecar;

#[cfg(test)]
mod live_tests;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::state::AppState;

use install::{InstallJob, InstallSnapshot, Installed, Marker, Requirements};
use layout::VoiceDirs;
use manifest::{ModelManifest, PythonManifest};
use sidecar::{LaunchSpec, LoopFailure, LoopPhase, Session, VoiceLoop};

/// The voice loop's slot in `AppState`: the one setup job and the one sidecar.
#[derive(Clone, Default)]
pub struct VoiceLoopHandle {
    pub job: InstallJob,
    pub sidecar: VoiceLoop,
}

impl VoiceLoopHandle {
    /// The app is quitting. The setup thread stops at its next check (its pip
    /// child is in the installer registry and is killed with the others), and
    /// the sidecar is given a moment to leave before it is killed.
    pub fn shutdown(&self) {
        self.job.cancel();
        if self.sidecar.is_running() {
            self.sidecar.stop(sidecar::SHUTDOWN_GRACE);
        }
    }
}

// ── the logic behind the commands, without Tauri ────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelVersion {
    pub id: String,
    pub name: String,
    pub role: String,
    pub revision: String,
}

/// Versions as the shipped files state them. Nothing here is asked of a
/// running process.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Versions {
    pub sidecar: Option<String>,
    /// The Python this version of LU installs.
    pub python: Option<String>,
    /// The Python that is installed, when one is.
    pub installed_python: Option<String>,
    pub packages: BTreeMap<String, String>,
    pub models: Vec<ModelVersion>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub supported: bool,
    pub unsupported_reason: Option<String>,
    pub installed: bool,
    pub parts: Installed,
    pub installing: bool,
    pub state: LoopPhase,
    pub running: bool,
    pub ready: bool,
    pub port: Option<u16>,
    /// Why the sidecar is not running, after a failed start or a crash.
    pub error: Option<LoopFailure>,
    pub log_tail: Vec<String>,
    pub versions: Versions,
    pub install_dir: String,
    /// Memory the voice engine holds right now, in bytes: the sidecar process
    /// and everything it started. None while it is not running.
    pub memory_bytes: Option<u64>,
}

/// The resident memory of a process and all its descendants, as the system
/// reports it at this moment. None when the process is gone.
pub fn process_tree_memory(pid: u32) -> Option<u64> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_memory());
    let root = sys.process(Pid::from_u32(pid))?.memory();
    let below: u64 = crate::commands::shell::descendants(pid, &sys)
        .into_iter()
        .filter_map(|child| sys.process(Pid::from_u32(child)).map(|process| process.memory()))
        .sum();
    Some(root + below)
}

pub fn versions(dirs: &VoiceDirs, sidecar_dir: &Path) -> Versions {
    let read = |name: &str| std::fs::read_to_string(sidecar_dir.join(name)).ok();
    let installed_python = Some(Marker::load(dirs).python_version).filter(|v| !v.is_empty());
    Versions {
        sidecar: read("lu_voice_loop/__init__.py").and_then(|text| manifest::sidecar_version(&text)),
        python: PythonManifest::load(sidecar_dir).ok().map(|m| m.version),
        installed_python,
        packages: read("requirements.txt")
            .map(|lock| manifest::pinned_versions(&lock, install::REPORTED_PACKAGES))
            .unwrap_or_default(),
        // The models of this installation: of the voices the chosen one.
        models: ModelManifest::load(sidecar_dir)
            .map(|m| {
                m.with_voice(&install::chosen_voice(dirs, sidecar_dir))
                    .models
                    .into_iter()
                    .map(|e| ModelVersion { id: e.id, name: e.name, role: e.role, revision: e.revision })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

pub fn status_report(
    dirs: &VoiceDirs,
    sidecar_dir: &Path,
    platform: Result<&str, String>,
    handle: &VoiceLoopHandle,
) -> StatusReport {
    let parts = install::installed(dirs, sidecar_dir);
    let live = handle.sidecar.status();
    StatusReport {
        supported: platform.is_ok(),
        unsupported_reason: platform.err(),
        installed: parts.complete,
        parts,
        installing: handle.job.is_running(),
        state: live.state,
        running: live.running,
        ready: live.ready,
        port: live.port,
        error: live.error,
        log_tail: live.log_tail,
        versions: versions(dirs, sidecar_dir),
        install_dir: dirs.root.display().to_string(),
        memory_bytes: if live.running { live.pid.and_then(process_tree_memory) } else { None },
    }
}

/// Start the sidecar of the installation in `dirs` and wait until it is ready.
pub fn start_loop(
    dirs: &VoiceDirs,
    sidecar_dir: &Path,
    platform: Result<&str, String>,
    handle: &VoiceLoopHandle,
    extra_origins: Vec<String>,
) -> Result<Session, String> {
    platform?;
    if !handle.sidecar.is_running() {
        if handle.job.is_running() {
            return Err("The voice setup is still running. Wait until it has finished, then start the voice loop.".to_string());
        }
        if !install::installed(dirs, sidecar_dir).complete {
            return Err("The voice loop is not installed. Run the voice setup first.".to_string());
        }
    }
    handle.sidecar.start(&LaunchSpec {
        python: dirs.venv_python(),
        sidecar_dir: sidecar_dir.to_path_buf(),
        models_dir: dirs.models(),
        extra_origins,
        log_file: Some(dirs.log_file()),
        ready_timeout: sidecar::READY_TIMEOUT,
    })
}

/// Start the setup. Returns `already_running` when one is in progress.
pub fn begin_install(dirs: &VoiceDirs, sidecar_dir: &Path, handle: &VoiceLoopHandle, force: bool) -> &'static str {
    if handle.job.is_running() {
        return "already_running";
    }
    // A running sidecar holds the files open that a repair replaces. Windows
    // would refuse to touch them.
    if handle.sidecar.is_running() && (force || !install::installed(dirs, sidecar_dir).complete) {
        handle.sidecar.stop(sidecar::STOP_GRACE);
    }
    if install::spawn_install(dirs.clone(), sidecar_dir.to_path_buf(), handle.job.clone(), force) {
        "started"
    } else {
        "already_running"
    }
}

/// Make `voice` the voice the answers are spoken in. On an installed engine
/// this fetches the one voice file when it is not there yet; the sidecar keeps
/// running and uses the voice from the next session on.
pub fn set_voice(dirs: &VoiceDirs, sidecar_dir: &Path, handle: &VoiceLoopHandle, voice: &str) -> Result<(), String> {
    if handle.job.is_running() {
        return Err("The voice setup is still running. Wait until it has finished, then pick the voice.".to_string());
    }
    // A job of its own: the download is one small file, and the setup panel
    // must not show it as a setup.
    install::select_voice(dirs, sidecar_dir, voice, &InstallJob::default())
}

/// Stop the sidecar and remove everything the setup wrote.
pub fn remove_installation(dirs: &VoiceDirs, handle: &VoiceLoopHandle) -> Result<(), String> {
    if handle.job.is_running() {
        return Err("The voice setup is still running. Cancel it first, then uninstall.".to_string());
    }
    handle.sidecar.stop(sidecar::STOP_GRACE);
    install::uninstall(dirs)?;
    handle.job.reset();
    Ok(())
}

// ── Tauri commands ──────────────────────────────────────────────────────────

/// Dictation in the chat may be running on the Python of this feature
/// (commands/whisper.rs). A repair or a removal must not find its files in
/// use; the dictation server starts again by itself at the next recording.
fn stop_dictation(state: &State<'_, AppState>) {
    if let Ok(mut whisper) = state.whisper.lock() {
        if whisper.is_running() {
            whisper.stop();
        }
    }
}

fn sidecar_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let resources = app.path().resource_dir().ok();
    layout::resolve_sidecar_dir(resources.as_deref(), layout::dev_sidecar_dir().as_deref())
}

/// The dev server's origin, when the app runs from one. The packaged app is
/// served from the origins the sidecar allows by itself.
fn dev_origins(app: &AppHandle) -> Vec<String> {
    if !tauri::is_dev() {
        return Vec::new();
    }
    app.config()
        .build
        .dev_url
        .as_ref()
        .map(|url| url.origin().ascii_serialization())
        .filter(|origin| origin != "null")
        .into_iter()
        .collect()
}

/// Everything here touches the disk or waits for a process. Tauri runs a
/// plain command on the main thread, so the work goes to the blocking pool.
async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "The voice loop task ended unexpectedly. Try again.".to_string())?
}

/// What the setup would download and write, before anything is started.
#[tauri::command]
pub async fn voice_loop_requirements(app: AppHandle) -> Result<Requirements, String> {
    let sidecar_dir = sidecar_dir(&app)?;
    blocking(move || {
        let dirs = VoiceDirs::current();
        install::requirements(&dirs, &sidecar_dir, layout::this_platform(), install::free_space(&dirs))
    })
    .await
}

/// Start the setup in the background. `force` is the repair: pip goes through
/// the lock again (and fetches only what is missing), the packages are loaded
/// once, and every model file is checked against its sha256 (and fetched again
/// only when it does not match).
#[tauri::command]
pub async fn voice_loop_install(
    app: AppHandle,
    state: State<'_, AppState>,
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    let handle = state.voice_loop.clone();
    let sidecar_dir = sidecar_dir(&app)?;
    let force = force.unwrap_or(false);
    if force {
        stop_dictation(&state);
    }
    blocking(move || {
        let status = begin_install(&VoiceDirs::current(), &sidecar_dir, &handle, force);
        Ok(serde_json::json!({ "status": status }))
    })
    .await
}

/// Progress of the setup. Cheap, meant to be polled.
#[tauri::command]
pub fn voice_loop_install_status(state: State<'_, AppState>) -> InstallSnapshot {
    state.voice_loop.job.snapshot()
}

/// Ask the running setup to stop. What is finished stays, a later run continues.
#[tauri::command]
pub fn voice_loop_install_cancel(state: State<'_, AppState>) {
    state.voice_loop.job.cancel();
}

#[tauri::command]
pub async fn voice_loop_status(app: AppHandle, state: State<'_, AppState>) -> Result<StatusReport, String> {
    let handle = state.voice_loop.clone();
    let sidecar_dir = sidecar_dir(&app)?;
    blocking(move || Ok(status_report(&VoiceDirs::current(), &sidecar_dir, layout::this_platform(), &handle))).await
}

/// Start the sidecar and wait until it is ready. The port and the launch token
/// go to this caller only; no status and no log line carries the token.
#[tauri::command]
pub async fn voice_loop_start(app: AppHandle, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let handle = state.voice_loop.clone();
    let sidecar_dir = sidecar_dir(&app)?;
    let origins = dev_origins(&app);
    blocking(move || {
        let session = start_loop(&VoiceDirs::current(), &sidecar_dir, layout::this_platform(), &handle, origins)?;
        Ok(serde_json::json!({
            "port": session.port,
            "token": session.token,
            "baseUrl": format!("http://127.0.0.1:{}", session.port),
            // The voice the next session asks the sidecar for.
            "voice": install::chosen_voice(&VoiceDirs::current(), &sidecar_dir),
        }))
    })
    .await
}

/// Choose the voice the answers are spoken in. Returns when the voice is
/// there, which on an installed engine can include one small download.
#[tauri::command]
pub async fn voice_loop_set_voice(app: AppHandle, state: State<'_, AppState>, voice: String) -> Result<(), String> {
    let handle = state.voice_loop.clone();
    let sidecar_dir = sidecar_dir(&app)?;
    blocking(move || set_voice(&VoiceDirs::current(), &sidecar_dir, &handle, &voice)).await
}

/// Stop the sidecar. Returns when the process is gone.
#[tauri::command]
pub async fn voice_loop_stop(state: State<'_, AppState>) -> Result<(), String> {
    let handle = state.voice_loop.clone();
    blocking(move || {
        handle.sidecar.stop(sidecar::STOP_GRACE);
        Ok(())
    })
    .await
}

/// Stop the sidecar and remove the Python, the packages and the models.
#[tauri::command]
pub async fn voice_loop_uninstall(state: State<'_, AppState>) -> Result<(), String> {
    let handle = state.voice_loop.clone();
    stop_dictation(&state);
    blocking(move || remove_installation(&VoiceDirs::current(), &handle)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn real_sidecar() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(layout::SIDECAR_RESOURCE_PATH)
    }

    #[test]
    fn the_status_of_a_fresh_machine_says_not_installed_and_names_the_versions() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = VoiceDirs::at(tmp.path().join("voice"));
        let report = status_report(&dirs, &real_sidecar(), Ok("aarch64-apple-darwin"), &VoiceLoopHandle::default());
        assert!(report.supported && !report.installed && !report.installing);
        assert!(!report.running && !report.ready && report.port.is_none() && report.error.is_none());
        assert_eq!(report.state, LoopPhase::Stopped);
        assert!(report.versions.sidecar.is_some());
        assert!(report.versions.python.as_deref().is_some_and(|v| v.starts_with("3.1")));
        assert!(report.versions.installed_python.is_none());
        assert!(report.versions.packages.contains_key("pipecat-ai"));
        assert_eq!(report.versions.models.len(), 3);
        assert!(report.versions.models.iter().all(|m| !m.revision.is_empty()));

        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["state"], "stopped");
        assert!(json.get("logTail").is_some() && json.get("installDir").is_some());
        assert!(!json.to_string().contains("token"));
    }

    #[test]
    fn a_stopped_voice_engine_reports_no_memory() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = VoiceDirs::at(tmp.path().join("voice"));
        let report = status_report(&dirs, &real_sidecar(), Ok("aarch64-apple-darwin"), &VoiceLoopHandle::default());
        assert!(report.memory_bytes.is_none());
        assert!(serde_json::to_value(&report).unwrap()["memoryBytes"].is_null());
    }

    #[test]
    fn the_memory_of_a_running_process_is_measured_and_a_gone_one_has_none() {
        // This test process itself: it certainly holds more than a megabyte.
        let own = process_tree_memory(std::process::id()).expect("the test process is running");
        assert!(own > 1_000_000, "got {own}");
        // A child that has exited and was collected is not a process any more.
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--list")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(process_tree_memory(pid).is_none());
    }

    #[test]
    fn the_memory_counts_what_the_process_started() {
        #[cfg(unix)]
        {
            let mut shell = std::process::Command::new("sh").args(["-c", "sleep 30 & sleep 30"]).spawn().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(300));
            let tree = process_tree_memory(shell.id()).expect("the shell is running");
            let mut sys = sysinfo::System::new();
            sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            let alone = sys.process(sysinfo::Pid::from_u32(shell.id())).map(|p| p.memory()).unwrap_or(0);
            crate::commands::shell::kill_tree(shell.id());
            let _ = shell.wait();
            assert!(tree > alone, "tree {tree}, shell alone {alone}");
        }
    }

    #[test]
    fn the_status_on_an_unsupported_machine_carries_the_reason() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = VoiceDirs::at(tmp.path().join("voice"));
        let platform = layout::platform_support("macos", "x86_64", Some("15.0"));
        let report = status_report(&dirs, &real_sidecar(), platform, &VoiceLoopHandle::default());
        assert!(!report.supported);
        assert!(report.unsupported_reason.unwrap().contains("Apple silicon"));
    }

    #[test]
    fn start_refuses_without_an_installation_and_on_an_unsupported_machine() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = VoiceDirs::at(tmp.path().join("voice"));
        let handle = VoiceLoopHandle::default();
        let err = start_loop(&dirs, &real_sidecar(), Ok("aarch64-apple-darwin"), &handle, vec![]).unwrap_err();
        assert!(err.contains("not installed") && err.contains("setup"), "{err}");

        let platform = layout::platform_support("macos", "aarch64", Some("13.0"));
        let err = start_loop(&dirs, &real_sidecar(), platform, &handle, vec![]).unwrap_err();
        assert!(err.contains("macOS 14"), "{err}");
        assert!(!handle.sidecar.is_running());
    }

    #[test]
    fn start_and_uninstall_wait_for_a_running_setup() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = VoiceDirs::at(tmp.path().join("voice"));
        let handle = VoiceLoopHandle::default();
        assert!(handle.job.begin());
        let err = start_loop(&dirs, &real_sidecar(), Ok("aarch64-apple-darwin"), &handle, vec![]).unwrap_err();
        assert!(err.contains("still running"), "{err}");
        let err = remove_installation(&dirs, &handle).unwrap_err();
        assert!(err.contains("Cancel it first"), "{err}");
        assert_eq!(begin_install(&dirs, &real_sidecar(), &handle, false), "already_running");
    }

    #[test]
    fn a_voice_is_not_chosen_while_the_setup_runs() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = VoiceDirs::at(tmp.path().join("voice"));
        let handle = VoiceLoopHandle::default();
        assert!(handle.job.begin());
        let err = set_voice(&dirs, &real_sidecar(), &handle, "alba").unwrap_err();
        assert!(err.contains("still running"), "{err}");
        handle.job.finish(Ok(()));
        // Before the first setup a choice is only written down.
        let other = ModelManifest::load(&real_sidecar()).unwrap().voices().nth(1).and_then(|m| m.voice().map(str::to_string)).unwrap();
        set_voice(&dirs, &real_sidecar(), &handle, &other).unwrap();
        assert_eq!(install::chosen_voice(&dirs, &real_sidecar()), other);
        assert_eq!(versions(&dirs, &real_sidecar()).models.len(), 3);
        assert!(versions(&dirs, &real_sidecar()).models.iter().any(|m| m.name == other));
        assert!(set_voice(&dirs, &real_sidecar(), &handle, "nobody").unwrap_err().contains("no voice named nobody"));
    }

    #[test]
    fn uninstall_on_nothing_is_fine_and_leaves_the_job_idle() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = VoiceDirs::at(tmp.path().join("voice"));
        let handle = VoiceLoopHandle::default();
        handle.job.begin();
        handle.job.finish(Err("cancelled".to_string()));
        assert_eq!(handle.job.snapshot().status, install::JobStatus::Cancelled);
        remove_installation(&dirs, &handle).unwrap();
        assert_eq!(handle.job.snapshot().status, install::JobStatus::Idle);
    }

    #[test]
    fn shutdown_cancels_a_running_setup() {
        let handle = VoiceLoopHandle::default();
        handle.job.begin();
        handle.shutdown();
        // The setup thread sees the flag at its next check.
        let tmp = tempfile::tempdir().unwrap();
        let dirs = VoiceDirs::at(tmp.path().join("voice"));
        let err = install::run_install(&dirs, &real_sidecar(), &handle.job, Ok("aarch64-apple-darwin"), false);
        assert_eq!(err.unwrap_err(), "cancelled");
    }

    // ── the bundle ──────────────────────────────────────────────────────

    /// One file's rules: (source pattern, target).
    type Rules = Vec<(String, Option<String>)>;

    /// The resource rules of every `tauri*.conf.json` that has some, as
    /// (source pattern, target). The list form keeps a file at its own path,
    /// the map form names the target file or, for a pattern, the target folder.
    /// A platform file replaces the list of the base file, it does not add to
    /// it, so every file is looked at on its own.
    fn resource_rules() -> Vec<(String, Rules)> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut all = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !(name.starts_with("tauri") && name.ends_with(".conf.json")) {
                continue;
            }
            let conf: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(entry.path()).unwrap()).unwrap();
            let rules: Rules = match conf.pointer("/bundle/resources") {
                Some(serde_json::Value::Array(list)) => {
                    list.iter().map(|v| (v.as_str().unwrap().to_string(), None)).collect()
                }
                // A --config overlay (tauri.linux-aarch64.conf.json, GitHub
                // #185) is a JSON merge patch: `null` removes a key of the file
                // it is laid over. It is no bundle of its own; the merge is
                // checked in src/lib/__tests__/gh185-linux-arm64-overlay.test.ts.
                Some(serde_json::Value::Object(map)) if map.values().any(|v| v.is_null()) => continue,
                Some(serde_json::Value::Object(map)) => {
                    map.iter().map(|(k, v)| (k.clone(), Some(v.as_str().unwrap().to_string()))).collect()
                }
                Some(other) => panic!("{name}: unexpected bundle.resources {other}"),
                None => continue,
            };
            all.push((name, rules));
        }
        all
    }

    /// Where a file of the source tree ends up in the bundle, by one file's rules.
    fn bundled_as(rules: &[(String, Option<String>)], source: &str) -> Option<String> {
        let options = glob::MatchOptions { require_literal_separator: true, ..Default::default() };
        for (pattern, target) in rules {
            let exact = pattern == source;
            if !exact && !glob::Pattern::new(pattern).is_ok_and(|p| p.matches_with(source, options)) {
                continue;
            }
            return Some(match target {
                None => source.to_string(),
                Some(target) if exact => target.clone(),
                Some(folder) => {
                    let file = source.rsplit('/').next().unwrap_or(source);
                    format!("{}/{file}", folder.trim_end_matches('/'))
                }
            });
        }
        None
    }

    #[test]
    fn every_bundle_carries_the_whole_sidecar_at_the_path_the_app_resolves() {
        let all = resource_rules();
        // The base file, and Windows, whose own list replaces the base one.
        for expected in ["tauri.conf.json", "tauri.windows.conf.json"] {
            assert!(all.iter().any(|(name, _)| name == expected), "{expected} lists no resources");
        }
        let root = real_sidecar();
        let mut wanted: Vec<String> = layout::SIDECAR_FILES.iter().map(|f| f.to_string()).collect();
        for entry in std::fs::read_dir(root.join("lu_voice_loop")).unwrap().flatten() {
            let file = entry.file_name().to_string_lossy().to_string();
            if file.ends_with(".py") {
                wanted.push(format!("lu_voice_loop/{file}"));
            }
        }
        wanted.sort();
        wanted.dedup();
        assert!(wanted.len() > layout::SIDECAR_FILES.len(), "the sidecar package has more modules than its entry point");
        for (name, rules) in &all {
            // A phone build has no voice loop: no private Python, no sidecar
            // process (lib.rs registers the commands for the desktop only).
            // Its resource list is its own and carries none of the sidecar.
            let phone = name == "tauri.android.conf.json" || name == "tauri.ios.conf.json";
            for file in &wanted {
                let source = format!("{}/{file}", layout::SIDECAR_RESOURCE_PATH);
                if phone {
                    assert_eq!(bundled_as(rules, &source), None, "{name} would ship {source} to a phone");
                    continue;
                }
                assert_eq!(
                    bundled_as(rules, &source).as_deref(),
                    Some(source.as_str()),
                    "{name} does not bundle {source} at the path resolve_sidecar_dir looks for"
                );
            }
        }
    }

    #[test]
    fn no_bundle_ships_the_tests_or_developer_files() {
        let outside = [
            "tests/conftest.py",
            "tests/test_auth.py",
            "tests/e2e_client.py",
            "tests/fixtures/rtvi_tool_messages.json",
            "requirements-dev.txt",
            "requirements.in",
            "pytest.ini",
            "lu_voice_loop/__pycache__/server.cpython-312.pyc",
            ".pytest_cache/README.md",
        ];
        let all = resource_rules();
        assert!(!all.is_empty());
        for (name, rules) in &all {
            for file in outside {
                let source = format!("{}/{file}", layout::SIDECAR_RESOURCE_PATH);
                assert_eq!(bundled_as(rules, &source), None, "{name} would ship {source}");
            }
            // No rule takes the directory as a whole or reaches into it recursively.
            for (pattern, _) in rules {
                assert!(
                    !pattern.contains("voice_loop/**") && pattern.trim_end_matches('/') != layout::SIDECAR_RESOURCE_PATH,
                    "{name}: {pattern} would ship the tests"
                );
            }
        }
    }

    #[test]
    fn every_voice_loop_command_is_registered() {
        // The handler list lives in lib.rs since the app became a library.
        let main_rs = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs")).unwrap();
        let this = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands/voice_loop.rs")).unwrap();
        let mut commands = Vec::new();
        let mut lines = this.lines();
        while let Some(line) = lines.next() {
            if line.trim() == "#[tauri::command]" {
                let decl = lines.next().unwrap_or("");
                let name = decl.split("fn ").nth(1).and_then(|rest| rest.split('(').next()).unwrap_or("").trim();
                commands.push(name.to_string());
            }
        }
        assert_eq!(commands.len(), 9, "{commands:?}");
        for command in commands {
            assert!(
                main_rs.contains(&format!("commands::voice_loop::{command},")),
                "{command} is not in the invoke_handler list"
            );
        }
    }
}
