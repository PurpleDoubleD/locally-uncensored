use crate::os_error;
use base64::Engine;
use sysinfo::System;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Free, total and used bytes of the volume that holds `path`.
///
/// `path` does not have to exist yet: an install asks before it creates its
/// folder, so the nearest ancestor that is there answers for it. `None` means
/// "could not be measured", and callers then let the install go ahead.
///
/// Only the Mac measures. The callers are the MLX installers, which run
/// nowhere else, and `libc` is a dependency of the Mac build alone.
pub fn volume_space_for(path: &std::path::Path) -> Option<(u64, u64, u64)> {
    let existing = path.ancestors().find(|p| p.exists())?;
    volume_space_of_existing(existing)
}

#[cfg(target_os = "macos")]
fn volume_space_of_existing(path: &std::path::Path) -> Option<(u64, u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // statfs and not statvfs: on macOS the block counts of statvfs are 32 bit.
    let mut stat = std::mem::MaybeUninit::<libc::statfs>::zeroed();
    // SAFETY: `c_path` is a NUL terminated string that outlives the call, and
    // `stat` points at writable memory of the size the call fills.
    if unsafe { libc::statfs(c_path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: statfs returned 0, so it filled the struct.
    let stat = unsafe { stat.assume_init() };
    let block = u64::from(stat.f_bsize);
    // f_bavail is what this user may still write, f_bfree would count the
    // blocks the system keeps for itself.
    let free = stat.f_bavail.saturating_mul(block);
    let total = stat.f_blocks.saturating_mul(block);
    Some((free, total, total.saturating_sub(stat.f_bfree.saturating_mul(block))))
}

#[cfg(not(target_os = "macos"))]
fn volume_space_of_existing(_path: &std::path::Path) -> Option<(u64, u64, u64)> {
    None
}

/// The sentence an install stops with when `need` bytes do not fit, or `None`
/// when they do. `what` names the thing being installed, `note` is an optional
/// reason for the size ("incl. the one-time convert").
pub fn disk_shortfall(what: &str, need: u64, free: u64, note: &str) -> Option<String> {
    if free >= need {
        return None;
    }
    let note = if note.is_empty() { String::new() } else { format!(" ({note})") };
    Some(format!(
        "Not enough disk space: {what} needs about {:.0} GB{note}, and only {:.0} GB are free. Free up space and try again.",
        (need as f64 / 1e9).ceil(),
        (free as f64 / 1e9).floor(),
    ))
}

/// The disk check every MLX model install runs before it downloads anything:
/// measure the volume that holds `target` and refuse with one sentence when
/// `need` bytes do not fit. A volume that cannot be measured lets it through.
pub fn ensure_free_space(target: &std::path::Path, what: &str, need: u64, note: &str) -> Result<(), String> {
    match volume_space_for(target) {
        Some((free, _, _)) => disk_shortfall(what, need, free, note).map_or(Ok(()), Err),
        None => Ok(()),
    }
}

/// Installed memory in bytes. On Apple Silicon this is the one pool the
/// models, the system and every other app share.
pub fn total_memory_bytes() -> u64 {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.total_memory()
}

#[tauri::command]
pub fn system_info() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "hostname": hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_default(),
        "username": whoami::username(),
        "totalMemory": System::new_all().total_memory(),
        "cpuCount": num_cpus::get(),
    }))
}

#[tauri::command]
pub fn process_list() -> Result<serde_json::Value, String> {
    let mut sys = System::new_all();
    sys.refresh_all();

    let mut processes: Vec<serde_json::Value> = sys
        .processes()
        .values()
        .map(|p| {
            serde_json::json!({
                "name": p.name().to_string_lossy(),
                "pid": p.pid().as_u32(),
                "memory": p.memory(),
                "cpu": p.cpu_usage(),
            })
        })
        .collect();

    // Sort by memory desc, limit to top 50
    processes.sort_by(|a, b| {
        b.get("memory")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            .cmp(
                &a.get("memory")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
            )
    });
    processes.truncate(50);

    Ok(serde_json::json!({ "processes": processes, "count": processes.len() }))
}

// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread,
// so every millisecond spent here is a frozen window. Same treatment
// `lmstudio_server_status` already got — this one was simply missed.
#[tauri::command]
pub async fn screenshot() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(screenshot_blocking)
        .await
        .map_err(|e| format!("screenshot task: {e}"))?
}

fn screenshot_blocking() -> Result<serde_json::Value, String> {
    // Unique per call. The capture used to land on a fixed `lu-screenshot.png`,
    // and TWO callers reach this: the agent's screenshot tool and the phone
    // bridge (remote.rs). Overlapping calls read each other's half-written PNG,
    // or one deleted the file the other was about to read ("Read screenshot: no
    // such file"), or a caller simply got the other one's screen.
    //
    // The PROCESS id joined the uuid on 01.09.2026. The uuid alone already made
    // the name unique; what it did not do is say WHOSE the file is. The temp
    // directory is shared by every process on the machine — a second LU, an
    // older build, three copies of the test suite — so neither an operator
    // finding a leftover `lu-screenshot-*.png` nor
    // `every_screenshot_gets_its_own_temp_file` could tell a file this process
    // made from a stranger's. That test counted the whole directory and failed
    // 5 of 30 runs under three concurrent suites (measured, 01.09.2026) because
    // ANOTHER copy had a capture in flight across its two counts.
    let tmp = std::env::temp_dir().join(format!(
        "lu-screenshot-{}-{}.png",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let captured = capture_screen_to(&tmp)
        .and_then(|()| std::fs::read(&tmp).map_err(|e| format!("Read screenshot: {}", os_error::english(&e))));
    // Always — the old code returned early on a read error and left a full
    // picture of the user's screen sitting in the temp directory.
    let _ = std::fs::remove_file(&tmp);

    let b64 = base64::engine::general_purpose::STANDARD.encode(&captured?);
    Ok(serde_json::json!({ "image": b64, "format": "png", "encoding": "base64" }))
}

/// How long a screen capture may take before we stop waiting for it.
///
/// G28 (Mac, R01a, 2026-08-07): the agent's `screenshot` step took 138
/// SECONDS. macOS shows its Screen Recording consent dialog and holds
/// `/usr/sbin/screencapture` until somebody answers it, and `.status()` waits
/// forever by definition. An interactive agent run cannot stand still for two
/// minutes on a picture of the screen. 20 s is far above a real capture (tens
/// of milliseconds, seconds at worst on a huge display) and far below the
/// wait a blocked consent dialog imposes.
// Only the Windows and macOS capture paths use the deadline; Linux has no
// capture command yet, and its clippy gate runs with -D warnings.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
const SCREENSHOT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Run a capture command with a deadline. `Ok(())` only when it exited zero in
/// time; the process is killed on timeout so no orphan sits on the display
/// server. Exported for the unit test, which is the only honest way to prove
/// the deadline fires without a consent dialog to hand.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub(crate) fn run_capture_bounded(
    mut cmd: std::process::Command,
    max: std::time::Duration,
    timeout_msg: &str,
) -> Result<(), String> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Screenshot failed: {}", os_error::english(&e)))?;
    let deadline = std::time::Instant::now() + max;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err("Screenshot failed: the capture command exited with an error.".to_string())
                }
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(timeout_msg.to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(e) => return Err(format!("Screenshot failed: {}", os_error::english(&e))),
        }
    }
}

/// Quote a path for a PowerShell SINGLE-quoted string literal: only `'` is
/// special there, and it escapes by doubling.
///
/// The old code doubled BACKSLASHES instead, which is C/JSON escaping, not
/// PowerShell — inside single quotes that produced a literal `C:\\Users\\…`
/// and only worked because Windows collapses repeated separators. It also left
/// `'` untouched, so any user whose profile contains an apostrophe
/// (C:\Users\O'Brien\AppData\Local\Temp) ended the string early and the script
/// died with a parse error.
// Only the Windows capture path calls this; its tests run on every platform.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn ps_single_quoted(s: &str) -> String {
    s.replace('\'', "''")
}

#[cfg(target_os = "windows")]
fn capture_screen_to(tmp: &std::path::Path) -> Result<(), String> {
    let ps_script = format!(
        r#"
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
        $bitmap.Save('{}')
        $graphics.Dispose()
        $bitmap.Dispose()
        "#,
        ps_single_quoted(&tmp.to_string_lossy())
    );

    // Same deadline as macOS (G28). PowerShell itself can wedge on a locked
    // session or a stalled GDI call, and an agent run must not stand still
    // for it either. stderr is dropped in exchange for the bound; the
    // actionable half was always the exit status.
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
        .creation_flags(0x08000000); // CREATE_NO_WINDOW
    run_capture_bounded(
        cmd,
        SCREENSHOT_TIMEOUT,
        &format!(
            "Screenshot timed out after {}s. The screen may be locked or a remote session has no display attached.",
            SCREENSHOT_TIMEOUT.as_secs()
        ),
    )
}

// macOS: the native `screencapture` CLI. `-x` = silent (no shutter sound),
// `-t png` = PNG. Needs the app to hold Screen Recording permission (TCC);
// without it screencapture exits non-zero ("could not create image from
// display") and writes nothing, so give an actionable hint instead of a
// generic failure.
#[cfg(target_os = "macos")]
fn capture_screen_to(tmp: &std::path::Path) -> Result<(), String> {
    const PERMISSION_HINT: &str = "grant LU the Screen Recording permission in System Settings ▸ Privacy & Security ▸ Screen Recording, then try again.";
    let mut cmd = std::process::Command::new("/usr/sbin/screencapture");
    cmd.args(["-x", "-t", "png"]).arg(tmp);
    // A timeout here almost always means the consent dialog is up and nobody
    // has answered it, so say that rather than blaming the capture.
    run_capture_bounded(
        cmd,
        SCREENSHOT_TIMEOUT,
        &format!(
            "Screenshot timed out after {}s, macOS is most likely waiting for a Screen Recording permission dialog. Answer it, or {}",
            SCREENSHOT_TIMEOUT.as_secs(),
            PERMISSION_HINT
        ),
    )?;
    if !tmp.exists() {
        return Err(format!("Screenshot failed, no image was written. Please {}", PERMISSION_HINT));
    }
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn capture_screen_to(_tmp: &std::path::Path) -> Result<(), String> {
    Err("Screenshot not implemented for this platform yet".to_string())
}

/// The native folder dialog — and the ONLY way a folder joins the workspace
/// allowlist (`filesystem::remember_picked_root`).
///
/// That is the whole point of routing it through here: the jail root for every
/// agent/remote file op used to be a string the WebView sent, so a script
/// injected into the renderer could name `/` and read the disk through
/// `fs_read`. A renderer cannot open this dialog or click in it, so "folders a
/// human chose here" is a set it cannot extend.
///
/// Recording is best-effort for the callers that are not choosing a workspace:
/// this dialog also picks the GGUF download folder, and that one may perfectly
/// well live somewhere `check_workspace_root` would never accept as a jail root.
/// Such a folder is simply not recorded and still comes back for its own use.
///
/// `as_workspace` is for the callers that ARE choosing a workspace, and it turns
/// the refusal into this command's error instead of dropping it (bug D,
/// Discord 2026-09-08). Without it the picker answered
/// `Ok(Some(path))` for a folder it had just refused to record: the Code tab put
/// that path in its header as the working directory, and every file op after it
/// answered "pick it again to allow it", which the user had just done. The
/// reason was produced, discarded here, and never reached anybody.
#[cfg(desktop)]
#[tauri::command]
pub async fn pick_folder(
    default_path: Option<String>,
    as_workspace: Option<bool>,
) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(ref p) = default_path {
        dialog = dialog.set_directory(p);
    }
    let result = dialog.pick_folder().await;
    let picked = result.map(|f| f.path().to_path_buf());
    if let Some(ref p) = picked {
        let recorded = crate::commands::filesystem::remember_picked_root(p);
        if as_workspace.unwrap_or(false) {
            recorded?;
        }
    }
    Ok(picked.map(|p| p.to_string_lossy().to_string()))
}

/// A phone has no folder picker, and no folder outside the app to pick.
#[cfg(mobile)]
#[tauri::command]
pub async fn pick_folder(
    default_path: Option<String>,
    as_workspace: Option<bool>,
) -> Result<Option<String>, String> {
    let _ = (default_path, as_workspace);
    Err(crate::commands::filesystem::NO_FILE_DIALOG.to_string())
}

/// Exit the app. Used by the "full quit" of the command palette and by the
/// update lane where LU installs itself, which has started the new version
/// before it calls this. The plugin's lane ends in `restart_after_update`.
///
/// Live-tested on 2026-05-25: Tauri v2's `app.exit(0)` returns from the run
/// loop without dropping the managed `AppState` on Windows, so subprocess
/// children (Ollama, ComfyUI, Claude Code) survived every "graceful" quit
/// path. We work around it by explicitly running the shutdown chain BEFORE
/// asking Tauri to exit. This is what makes a user's Ollama-orphan fix
/// (v2.4.9, Discord 2026-05-23) actually deliver on the tray-Quit + auto-
/// updater paths in the released binary.
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) {
    use tauri::Manager;
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        state.shutdown_subprocesses();
    }
    app.exit(0);
}

/// Start the app again after the updater plugin has replaced it, then leave.
///
/// The update button says "Restart Now", and only Windows used to keep that
/// promise, because there the NSIS installer starts the app itself (the
/// plugin passes it `/R`) and this process never gets past `install()`. On
/// macOS and Linux `install()` returns into the old process, and all that
/// followed was `exit_app`: the window closed and the user had to find the
/// icon again (GitHub discussion 150).
///
/// macOS takes Tauri's own restart. It runs the exit event first, so single
/// instance has let go of its socket before the new process asks for it.
///
/// Linux cannot: the restart would start `current_exe()`, which after a deb
/// or rpm update is a name the kernel has marked as deleted, and it would
/// hand the new AppImage the environment of the old mount. So the helper that
/// already starts the new file after LU has installed itself does it here
/// too. It waits for this process to be gone and cleans that environment.
///
/// Whatever goes wrong with the start, the app still exits: the update is
/// installed at this point, and a window that stays open on the old build
/// would be worse than one the user has to open again.
#[tauri::command]
pub fn restart_after_update(app: tauri::AppHandle) {
    use tauri::Manager;
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        state.shutdown_subprocesses();
    }

    #[cfg(target_os = "linux")]
    {
        use super::self_migrate;
        let target = self_migrate::relaunch_target(
            std::env::var("APPIMAGE").ok(),
            std::env::current_exe().ok(),
        )
        .filter(|exe| exe.is_file());
        match target {
            Some(exe) => {
                if let Err(why) = self_migrate::launch_after_exit(&exe, std::process::id()) {
                    tracing::warn!("[update] the updated app was not started again: {why}");
                }
            }
            None => tracing::warn!("[update] no file to start the updated app from, exiting only"),
        }
        app.exit(0);
    }

    #[cfg(not(target_os = "linux"))]
    app.request_restart();
}

/// Get the persistent settings dir — outside the (NSIS) install dir so it
/// survives updates. On Windows this stays `%APPDATA%/<APP_DISPLAY_DIR>` (the
/// path existing installs already back up to). `APPDATA` is Windows-only, so on
/// macOS/Linux the whole backup/restore + onboarding-marker cluster used to
/// hard-error; there we use the shared app data dir instead.
///
/// `<APP_DISPLAY_DIR>` ist `Locally Uncensored` in der echten App; auf diesem
/// Branch trägt der Name einen Suffix (`crate::app_identity`). Genau diese
/// Datei — `store_backup.json` — hat der Experiment-Build am 2026-08-31 im
/// Verzeichnis der echten App überschrieben.
pub(crate) fn persistent_dir() -> Result<std::path::PathBuf, String> {
    #[cfg(test)]
    {
        if cfg!(windows) {
            Ok(crate::os_paths::test_storage::display_data_dir())
        } else {
            Ok(crate::os_paths::data_dir().join("stores"))
        }
    }
    #[cfg(all(not(test), target_os = "windows"))]
    {
        let appdata = std::env::var("APPDATA").map_err(|_| "APPDATA not set".to_string())?;
        Ok(std::path::PathBuf::from(appdata).join(crate::app_identity::APP_DISPLAY_DIR))
    }
    #[cfg(all(not(test), not(target_os = "windows")))]
    {
        Ok(crate::os_paths::data_dir().join("stores"))
    }
}

/// Which keys the previous backup carried that the incoming snapshot does not.
///
/// A key is only ever ABSENT from a snapshot when the storage read came back
/// empty, which means the store is gone, not that the user emptied it: a
/// cleared chat list still serialises to a present, valid value. So a missing
/// key is a signal that something was lost since the last backup, never a
/// deletion the user asked for.
///
/// Both sides must be JSON objects for this to mean anything. Anything else
/// answers "nothing was lost", which leaves the plain overwrite in place
/// rather than inventing a merge over data we cannot read.
pub(crate) fn keys_lost(previous: &str, incoming: &str) -> Vec<String> {
    let (Ok(serde_json::Value::Object(prev)), Ok(serde_json::Value::Object(next))) = (
        serde_json::from_str::<serde_json::Value>(previous),
        serde_json::from_str::<serde_json::Value>(incoming),
    ) else {
        return Vec::new();
    };
    prev.iter()
        .filter(|(k, v)| {
            !v.as_str().unwrap_or("").is_empty()
                && next.get(*k).and_then(|n| n.as_str()).unwrap_or("").is_empty()
        })
        .map(|(k, _)| k.clone())
        .collect()
}

/// The snapshot that actually goes to disk: the incoming one, plus every key
/// it lost carried over from the backup that is already there.
///
/// A user, 2.6.5, Discord #general 18.08.: "My code chats are
/// vaporised". chat-conversations lives in IndexedDB, localStorage does not,
/// and they are different storage layers with different lifetimes. A hard
/// process kill during a self update can leave Chromium discarding the whole
/// IndexedDB database on the next start while localStorage comes back
/// untouched. On that boot the snapshot the frontend builds simply has no
/// chat-conversations in it, and this command wrote that over the one
/// remaining copy of the chats, five seconds after launch, every launch.
///
/// A backup is not a mirror. It may lag, it may hold something the live store
/// no longer has, and it must never be the thing that finishes a data loss.
pub(crate) fn merged_backup(previous: &str, incoming: &str, lost: &[String]) -> String {
    if lost.is_empty() {
        return incoming.to_string();
    }
    let (Ok(serde_json::Value::Object(prev)), Ok(serde_json::Value::Object(mut next))) = (
        serde_json::from_str::<serde_json::Value>(previous),
        serde_json::from_str::<serde_json::Value>(incoming),
    ) else {
        return incoming.to_string();
    };
    for key in lost {
        if let Some(v) = prev.get(key) {
            next.insert(key.clone(), v.clone());
        }
    }
    serde_json::Value::Object(next).to_string()
}

/// How many rotated generations of the store backup are kept beside the live
/// one. Three plus the live file plus store_backup.prev.json is a handful of
/// megabytes on a big history, and it is the difference between one file
/// standing between a user and their chats and several.
pub(crate) const BACKUP_GENERATIONS: usize = 3;

/// A generation is only cut when the newest one is at least this old. The
/// backup triad fires every 5 s and after every chat mutation, so rotating on
/// every write would burn through the whole ring in under a minute and leave
/// three copies of the same instant.
const ROTATE_AFTER_SECS: u64 = 30 * 60;

/// Whether the ring should be shifted. `None` means there is no generation
/// yet, which is the first rotation.
pub(crate) fn should_rotate(newest_age: Option<std::time::Duration>) -> bool {
    match newest_age {
        None => true,
        Some(age) => age.as_secs() >= ROTATE_AFTER_SECS,
    }
}

/// The backup files a restore may read, newest first.
///
/// store_backup.prev.json comes last: it is the one set aside when a snapshot
/// arrived with a key missing, so it is older than every generation, and it is
/// only worth reading when nothing newer can be parsed at all.
pub(crate) fn backup_candidates(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut paths = vec![dir.join("store_backup.json")];
    for i in 1..=BACKUP_GENERATIONS {
        paths.push(dir.join(format!("store_backup.{i}.json")));
    }
    paths.push(dir.join("store_backup.prev.json"));
    // The chat archives (archive_dropped_chats) come after everything else:
    // each one is a whole backup from before chats left the store, so it is
    // older than the live file and the ring. Listing them here also keeps the
    // attachment collector from deleting the images their chats point at.
    paths.extend(chat_archives(dir));
    paths
}

/// How many chat archives (`store_backup.chats-<ms>.json`) are kept.
pub(crate) const CHAT_ARCHIVES_KEPT: usize = 5;

const CHAT_ARCHIVE_PREFIX: &str = "store_backup.chats-";

/// The chat archives in `dir`, newest first. A folder that cannot be listed
/// has none.
pub(crate) fn chat_archives(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut found: Vec<(u128, std::path::PathBuf)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let stamp = name.strip_prefix(CHAT_ARCHIVE_PREFIX)?.strip_suffix(".json")?.parse::<u128>().ok()?;
            Some((stamp, e.path()))
        })
        .collect();
    found.sort_by_key(|f| std::cmp::Reverse(f.0));
    found.into_iter().map(|(_, p)| p).collect()
}

/// The conversation list inside a backup file's `chat-conversations` value.
/// None when the file, the value or the list cannot be read.
fn backup_conversation_list(backup: &str) -> Option<Vec<serde_json::Value>> {
    let outer: serde_json::Value = serde_json::from_str(backup).ok()?;
    let chat = outer.get(crate::commands::chat_attachments::CHAT_KEY)?.as_str()?;
    let mut inner: serde_json::Value = serde_json::from_str(chat).ok()?;
    match inner.pointer_mut("/state/conversations")?.take() {
        serde_json::Value::Array(list) => Some(list),
        _ => None,
    }
}

/// The conversation ids in a backup file. None when there is no readable list.
///
/// Runs on every backup write, so it reads into typed shapes that skip
/// everything but the ids instead of building the whole history as a Value.
fn backup_chat_ids(backup: &str) -> Option<std::collections::HashSet<String>> {
    #[derive(serde::Deserialize)]
    struct Outer {
        #[serde(rename = "chat-conversations")]
        chat: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct Blob {
        state: Option<State>,
    }
    #[derive(serde::Deserialize)]
    struct State {
        conversations: Option<Vec<Option<Entry>>>,
    }
    #[derive(serde::Deserialize)]
    struct Entry {
        id: Option<serde_json::Value>,
    }
    let outer: Outer = serde_json::from_str(backup).ok()?;
    let blob: Blob = serde_json::from_str(&outer.chat?).ok()?;
    let list = blob.state?.conversations?;
    Some(
        list.into_iter()
            .flatten()
            .filter_map(|c| c.id.and_then(|v| v.as_str().map(str::to_string)))
            .collect(),
    )
}

/// The conversation ids the previous backup had and the one about to replace
/// it has not.
///
/// perrt, Discord 05.11.2026, 3.0.8: the chat store came back empty, the
/// merge in `merged_backup` kept the chats while the key was missing, and the
/// moment the store wrote a fresh, nearly empty list the next snapshot carried
/// a valid value again and replaced the only complete copy. A missing key is
/// not the only shape of a loss: a list without the old chats is one too.
///
/// An incoming snapshot without a chat value answers nothing here, that case
/// is the merge's (the old value stays in the file). An unreadable previous
/// list answers nothing as well, there is nothing to compare.
pub(crate) fn chat_ids_dropped(previous: &str, incoming: &str) -> Vec<String> {
    let Some(before) = backup_chat_ids(previous) else { return Vec::new() };
    let incoming_has_chats = serde_json::from_str::<serde_json::Value>(incoming)
        .ok()
        .and_then(|v| v.get(crate::commands::chat_attachments::CHAT_KEY).and_then(|c| c.as_str()).map(|s| !s.is_empty()))
        .unwrap_or(false);
    if !incoming_has_chats {
        return Vec::new();
    }
    let after = backup_chat_ids(incoming).unwrap_or_default();
    let mut dropped: Vec<String> = before.difference(&after).cloned().collect();
    dropped.sort();
    dropped
}

/// Keep the previous backup as a chat archive before chats leave it.
///
/// Not a judgement on whether the loss was wanted: deleting a chat drops its
/// id too, and the archive costs one file. When the newest archive already
/// holds every dropped chat nothing is written, so deleting chats one by one
/// does not rotate the archives through. At most `CHAT_ARCHIVES_KEPT` stay.
/// Returns the archive written, if any. Best effort: an archive that cannot be
/// written must not stop the backup itself.
pub(crate) fn archive_dropped_chats(
    dir: &std::path::Path,
    previous: &str,
    dropped: &[String],
    now_ms: u128,
) -> Option<std::path::PathBuf> {
    if dropped.is_empty() || previous.is_empty() {
        return None;
    }
    let archives = chat_archives(dir);
    if let Some(newest) = archives.first() {
        let held = std::fs::read_to_string(newest).ok().and_then(|raw| backup_chat_ids(&raw));
        if held.is_some_and(|ids| dropped.iter().all(|id| ids.contains(id))) {
            return None;
        }
    }
    // A name that is already taken (two writes in the same millisecond) moves
    // on rather than replacing an archive.
    let mut stamp = now_ms;
    let mut path = dir.join(format!("{CHAT_ARCHIVE_PREFIX}{stamp}.json"));
    while path.exists() {
        stamp += 1;
        path = dir.join(format!("{CHAT_ARCHIVE_PREFIX}{stamp}.json"));
    }
    let tmp = dir.join("store_backup.chats.tmp");
    let written = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(previous.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&tmp, &path)
    })();
    if let Err(e) = written {
        tracing::warn!("chat archive could not be written: {}", os_error::english(&e));
        let _ = std::fs::remove_file(&tmp);
        return None;
    }
    for old in chat_archives(dir).into_iter().skip(CHAT_ARCHIVES_KEPT) {
        let _ = std::fs::remove_file(old);
    }
    Some(path)
}

/// Every chat in every backup file (the live one, the ring, the file set aside
/// and the chat archives), one entry per id. Where several files hold the same
/// chat the copy with the newest `updatedAt` wins, on a tie the one with more
/// messages.
pub(crate) fn chats_in_backups(raws: impl IntoIterator<Item = String>) -> Vec<serde_json::Value> {
    let mut by_id: std::collections::HashMap<String, serde_json::Value> = std::collections::HashMap::new();
    let rank = |c: &serde_json::Value| {
        (
            c.get("updatedAt").and_then(|v| v.as_f64()).unwrap_or(0.0),
            c.get("messages").and_then(|v| v.as_array()).map(|m| m.len()).unwrap_or(0),
        )
    };
    for raw in raws {
        for chat in backup_conversation_list(&raw).unwrap_or_default() {
            let Some(id) = chat.get("id").and_then(|v| v.as_str()).map(str::to_string) else { continue };
            if !chat.get("messages").is_some_and(|m| m.is_array()) {
                continue;
            }
            let better = match by_id.get(&id) {
                None => true,
                Some(held) => {
                    let (a, b) = (rank(&chat), rank(held));
                    a.0 > b.0 || (a.0 == b.0 && a.1 > b.1)
                }
            };
            if better {
                by_id.insert(id, chat);
            }
        }
    }
    let mut list: Vec<serde_json::Value> = by_id.into_values().collect();
    let id_of = |c: &serde_json::Value| c.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    list.sort_by(|a, b| {
        rank(b).0.partial_cmp(&rank(a).0).unwrap_or(std::cmp::Ordering::Equal).then_with(|| id_of(a).cmp(&id_of(b)))
    });
    list
}

/// The chats of every backup file, for "Restore chats from backup" in
/// Settings and the hint at launch. The WebView decides which of them it is
/// missing. Inline images are moved into the attachment store here, natively,
/// like `restore_stores` does, so an old backup never reaches the renderer as
/// one huge string.
#[tauri::command]
pub async fn chat_backup_conversations() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = persistent_dir()?;
        let raws = backup_candidates(&dir).into_iter().filter_map(|p| std::fs::read_to_string(p).ok());
        let mut list = serde_json::Value::Array(chats_in_backups(raws));
        if let Ok(attachments) = crate::commands::chat_attachments::attachment_dir() {
            crate::commands::chat_attachments::externalize_conversations(&mut list, &attachments);
        }
        Ok(list.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A backup is worth restoring from when it parses as a JSON object that still
/// carries at least one non-empty string value.
///
/// The rename below is atomic, so a half written file should not be reachable,
/// but the payload is not on the platter yet when the rename lands unless the
/// write was synced, and a machine that loses power there can come back with a
/// zero length or garbled file under the right name. That is the same class of
/// event that took the chats in the first place, so the restore path must not
/// stop at the newest name and call it a day.
pub(crate) fn is_usable_backup(raw: &str) -> bool {
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    map.iter()
        .any(|(k, v)| k != "__ts" && !v.as_str().unwrap_or("").is_empty())
}

/// The candidate to restore from: the first usable one in the order given, or
/// the newest unusable one when the whole ring reads as nothing.
///
/// Handing an unusable file back rather than `None` keeps the caller's own "no
/// backup at all" branch for the case it was written for, a machine that has
/// never written one.
///
/// Lazy over the iterator on purpose: a full history is a multi megabyte file
/// and there are up to five of them, so a healthy boot reads exactly one.
pub(crate) fn pick_backup<I: IntoIterator<Item = String>>(candidates: I) -> Option<String> {
    let mut newest: Option<String> = None;
    for raw in candidates {
        if is_usable_backup(&raw) {
            return Some(raw);
        }
        if newest.is_none() {
            newest = Some(raw);
        }
    }
    newest
}

/// Copy the live backup into the ring and drop the oldest generation, but only
/// when the newest generation has had time to age. Best effort throughout: a
/// generation that cannot be written is not a reason to refuse the backup that
/// actually matters.
fn rotate_generations(dir: &std::path::Path) {
    let live = dir.join("store_backup.json");
    if !live.exists() {
        return;
    }
    let newest = dir.join("store_backup.1.json");
    let age = std::fs::metadata(&newest)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok());
    if !should_rotate(if newest.exists() { age } else { None }) {
        return;
    }
    for i in (1..BACKUP_GENERATIONS).rev() {
        let from = dir.join(format!("store_backup.{i}.json"));
        let to = dir.join(format!("store_backup.{}.json", i + 1));
        if from.exists() {
            let _ = std::fs::rename(&from, &to);
        }
    }
    let _ = std::fs::copy(&live, &newest);
}

/// Backup all stores to %APPDATA% (survives NSIS updates). Atomic write (temp
/// file + rename) so a crash mid-write cannot truncate a previous backup.
///
/// Never destructive: a snapshot that lost a key keeps the old value for it,
/// and the untouched previous file is set aside once as store_backup.prev.json
/// so the loss can still be looked at afterwards. See merged_backup.
///
/// The temp file is synced before the rename. Without that the rename can land
/// while the bytes are still only in the page cache, and a hard kill there
/// leaves a file with the right name and no usable contents, which is exactly
/// the shape of failure this whole path exists to survive.
#[tauri::command]
pub fn backup_stores(data: String) -> Result<(), String> {
    let dir = persistent_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| os_error::english(&e))?;
    let target = dir.join("store_backup.json");
    let tmp = dir.join("store_backup.tmp");

    let previous = std::fs::read_to_string(&target).unwrap_or_default();
    let lost = keys_lost(&previous, &data);
    let payload = if lost.is_empty() {
        data
    } else {
        tracing::warn!("backup snapshot lost {:?}, keeping the previous values", lost);
        // Set the last complete file aside before it is replaced, once. The
        // merge means the next snapshot is complete again, so a machine in
        // this state writes this file on the first boot after the loss and
        // never again.
        let aside = dir.join("store_backup.prev.json");
        if !aside.exists() {
            let _ = std::fs::write(&aside, &previous);
        }
        merged_backup(&previous, &data, &lost)
    };

    // Chats that are about to leave the backup go to an archive first, see
    // chat_ids_dropped (perrt, 05.11.2026).
    let dropped = chat_ids_dropped(&previous, &payload);
    if !dropped.is_empty() {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        if let Some(path) = archive_dropped_chats(&dir, &previous, &dropped, now_ms) {
            tracing::warn!(
                "{} chats left the chat store, the previous backup is kept as {}",
                dropped.len(),
                path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
            );
        }
    }

    rotate_generations(&dir);

    {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp).map_err(|e| os_error::english(&e))?;
        file.write_all(payload.as_bytes()).map_err(|e| os_error::english(&e))?;
        file.sync_all().map_err(|e| os_error::english(&e))?;
    }
    std::fs::rename(&tmp, &target).map_err(|e| os_error::english(&e))?;
    // A complete snapshot just landed, so the set of images anything can still
    // point at is known: the live stores (this file) and the older backups.
    // Not after a merged one: its chat value may be older than the live store.
    if lost.is_empty() {
        crate::commands::chat_attachments::collect_garbage_soon(dir);
    }
    Ok(())
}

/// Read the store backup, falling back through the rotated generations when
/// the newest file cannot be read as a backup at all. Plain read, for the
/// native callers that only look inside (the onboarding decision).
pub fn read_store_backup() -> Result<Option<String>, String> {
    let dir = persistent_dir()?;
    Ok(pick_backup(
        backup_candidates(&dir)
            .into_iter()
            .filter_map(|p| std::fs::read_to_string(p).ok()),
    ))
}

/// Restore stores from the %APPDATA% backup, for the WebView.
///
/// A backup written before the attachment store carries every chat image
/// inline, and handing that to the WebView as one string is the largest
/// allocation the renderer ever sees: the IPC string, its parse, the
/// IndexedDB write, and after the reload the hydration read of the same
/// value. So the images are moved into `chat-attachments` HERE, in native
/// memory and off the main thread, and the WebView receives the small form.
/// An image whose file cannot be written stays inline, so nothing is lost.
#[tauri::command]
pub async fn restore_stores() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(raw) = read_store_backup()? else { return Ok(None) };
        let dir = crate::commands::chat_attachments::attachment_dir()?;
        Ok(Some(crate::commands::chat_attachments::externalize_store_backup(&raw, &dir).unwrap_or(raw)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Backup the IndexedDB RAG chunks (embedding vectors) to %APPDATA%.
///
/// The chat-persistence triad (`store_backup.json`) only covers localStorage
/// stores. RAG embedding chunks live in IndexedDB under
/// `locally-uncensored-rag → chunks` because the 768-float vectors blow past
/// localStorage's ~10 MB quota for any non-trivial document. After an NSIS
/// upgrade or WebView2 data reset, localStorage restores the document
/// metadata but the IndexedDB chunks were silently lost — every "RAG enabled"
/// chat would show the document name + remain non-searchable.
///
/// A user report (Discord 2026-05-23, #help-chat thread 1507756765612216411,
/// running v2.4.8): "is there a way to keep chats with the plugins and the
/// attached documents via RAG when i close the app and reopen it?" References
/// Discussion #26 as "'fixed' but not really fixed" — the v2.3.4 fix was the
/// chat-message half; this commit is the RAG embeddings half.
///
/// The payload is the JSON-serialized snapshot of every objectStore entry
/// (the frontend uses `getAll()` on the chunks store and `JSON.stringify`s
/// the map `documentId → TextChunk[]`). Same atomic-temp-rename pattern as
/// `backup_stores` so a crash mid-write doesn't truncate a previous backup.
#[tauri::command]
pub fn backup_rag_chunks(data: String) -> Result<(), String> {
    let dir = persistent_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| os_error::english(&e))?;
    let target = dir.join("rag_chunks_backup.json");
    let tmp = dir.join("rag_chunks_backup.tmp");
    std::fs::write(&tmp, &data).map_err(|e| os_error::english(&e))?;
    std::fs::rename(&tmp, &target).map_err(|e| os_error::english(&e))?;
    Ok(())
}

/// Restore RAG chunks (counterpart to `backup_rag_chunks`). Returns the JSON
/// payload (same shape: `Record<documentId, TextChunk[]>`) or `None` when no
/// backup exists yet. The frontend writes each entry back into IndexedDB on
/// cold start so RAG retrieval works after WebView2 data is wiped.
#[tauri::command]
pub fn restore_rag_chunks() -> Result<Option<String>, String> {
    let path = persistent_dir()?.join("rag_chunks_backup.json");
    if path.exists() {
        let data = std::fs::read_to_string(&path).map_err(|e| os_error::english(&e))?;
        Ok(Some(data))
    } else {
        Ok(None)
    }
}

/// Check if onboarding was completed (marker file in %APPDATA%, survives NSIS updates)
#[tauri::command]
pub fn is_onboarding_done() -> bool {
    persistent_dir()
        .map(|dir| dir.join("onboarding_done").exists())
        .unwrap_or(false)
}

/// Write (or clear) the marker file `is_onboarding_done` reads. Plain IO, no
/// window logic — `set_onboarding_done` and the startup migration in
/// `onboarding_window::decide_first_window` both come through here.
pub(crate) fn write_onboarding_marker(done: bool) -> Result<(), String> {
    let dir = persistent_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| os_error::english(&e))?;
    let path = dir.join("onboarding_done");
    if done {
        std::fs::write(&path, "1").map_err(|e| os_error::english(&e))?;
    } else if path.exists() {
        std::fs::remove_file(&path).map_err(|e| os_error::english(&e))?;
    }
    Ok(())
}

/// Persist onboarding completion to %APPDATA% (outside NSIS install dir).
/// Pass `done: false` to clear the marker so the first-launch wizard runs again.
///
/// The windows follow the marker (`onboarding_window::follow_marker`): `true`
/// from the onboarding window hands over to the main window, `false` from
/// Settings → "Re-run onboarding" brings the small window back. Only after a
/// successful write — the marker is the one truth the windows are decided
/// from, and moving them on a marker that is not there would leave the main
/// window hidden behind a rule it can never satisfy.
// ASYNC: this command BUILDS A WINDOW. `follow_marker(false)`, the
// Settings "Re-run onboarding" path, goes through `onboarding_window::open`,
// and that is the only WebviewWindowBuilder in the app. A synchronous Tauri
// command runs in the CALLER's thread, and that is the main thread inside
// WebView2's WebResourceRequested handler, with the deferral still open for
// the very IPC request it is answering. Building a webview there pumps a
// nested Windows message loop and waits on the same browser process that is
// waiting for that answer: the command never returns, and with it the WHOLE
// command layer stops answering anything (T11 point 2, 2026-09-11: four
// empty chat replies, Models stuck on "Loading models", the window cross
// dead, only taskkill /F /T helped). With `(async)` Tauri dispatches the body
// off the main thread, so `Message::CreateWindow` is posted to the event loop
// instead of being built in place. Same treatment `find_comfyui`
// (commands/process.rs) and `fs_search` (commands/filesystem.rs) already got.
// The window build arrived with be2e3849 (2026-09-01) and shipped in 2.6.8
// and 2.6.9.
#[tauri::command(async)]
pub fn set_onboarding_done(app: tauri::AppHandle, done: Option<bool>) -> Result<(), String> {
    let done = done.unwrap_or(true);
    write_onboarding_marker(done)?;
    crate::onboarding_window::follow_marker(&app, done);
    Ok(())
}

/// Return the current local date/time/timezone. Agents should call this
/// instead of googling "what day is it" — the info is free and exact.
///
/// This used to shell out (`powershell (Get-Date).ToString('zzz')` on Windows,
/// `date +%z` elsewhere) purely to learn the UTC offset, on the main thread,
/// on EVERY call — and the tool sits in ALWAYS_INCLUDE, so the model may call
/// it any turn. A PowerShell cold start is 300-900 ms, more with an AV hooked
/// into process creation, and the window is frozen for all of it. Worse, when
/// the spawn failed the offset silently fell back to 0, so the agent reported
/// UTC as the user's local time.
///
/// chrono was already in the dependency tree (via jsonwebtoken, with the
/// `clock` feature and iana-time-zone resolved), so reading the real offset
/// in-process costs no new crate and no process at all.
#[tauri::command]
pub fn get_current_time() -> Result<serde_json::Value, String> {
    use chrono::{Offset, Utc};

    let local = chrono::Local::now();
    let utc = local.with_timezone(&Utc);
    let offset_minutes = local.offset().fix().local_minus_utc() / 60;

    Ok(serde_json::json!({
        "unix":            utc.timestamp(),
        "iso_local":       local.format("%Y-%m-%d %H:%M:%S").to_string(),
        "iso_utc":         utc.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        "timezone":        local.format("%z").to_string(),
        "timezone_offset": offset_minutes,
    }))
}


#[cfg(test)]
mod tests {
    use super::*;

    /// Fund 5: die Vorpruefung war am Mac ein Platzhalter, der immer `None`
    /// gab. Sie misst jetzt das Volume, auch fuer einen Ordner, den es noch
    /// nicht gibt.
    #[cfg(target_os = "macos")]
    #[test]
    fn volume_space_measures_the_volume_of_a_folder_that_does_not_exist_yet() {
        let dir = tempfile::tempdir().unwrap();
        let (free, total, used) = volume_space_for(dir.path()).expect("the Mac measures its volume");
        assert!(total > 0 && free > 0 && free <= total, "free {free} of {total}");
        assert!(used <= total);
        // An install asks before it creates its folder.
        let later = dir.path().join("mlx-video").join("some-model").join("src");
        assert!(!later.exists());
        let (free_later, total_later, _) = volume_space_for(&later).expect("the nearest folder answers");
        assert_eq!(total_later, total, "the same volume");
        // Other processes write while this runs, so the two readings may differ a little.
        assert!(free_later.abs_diff(free) < 5_000_000_000, "{free_later} vs {free}");
    }

    #[test]
    fn disk_shortfall_is_one_sentence_with_both_numbers() {
        assert_eq!(disk_shortfall("Wan 2.1 T2V 14B", 100, 100, ""), None, "it fits exactly");
        assert_eq!(disk_shortfall("Wan 2.1 T2V 14B", 100, 101, "x"), None);
        let msg = disk_shortfall("LTX-2 Distilled", 111_000_000_000, 60_400_000_000, "").unwrap();
        assert_eq!(
            msg,
            "Not enough disk space: LTX-2 Distilled needs about 111 GB, and only 60 GB are free. Free up space and try again."
        );
        let msg = disk_shortfall("Wan 2.1 T2V 14B", 142_000_000_000, 60_000_000_000, "incl. the one-time convert").unwrap();
        assert!(msg.contains("needs about 142 GB (incl. the one-time convert), and only 60 GB are free"), "{msg}");
        assert!(!msg.contains('\u{2014}') && !msg.contains('\u{2013}'));
    }

    #[test]
    fn total_memory_is_measured() {
        assert!(total_memory_bytes() >= 1_073_741_824, "{}", total_memory_bytes());
    }

    /// A user, 2.6.5, Discord #general 18.08. 12:59 "has anyone lost
    /// their chats after a restart??" and 16:12 "My code chats are vaporised".
    ///
    /// chat-conversations lives in IndexedDB and the rest of the stores live
    /// in localStorage. Those are different storage layers with different
    /// lifetimes, so a boot can come back with one gone and the other whole.
    /// On such a boot the snapshot the frontend hands this command has no
    /// chat-conversations in it at all, and the old code wrote it straight
    /// over the only remaining copy.
    #[test]
    fn a_snapshot_that_lost_the_chats_does_not_take_the_backup_with_it() {
        let previous = r#"{"__ts":"old","chat-conversations":"{\"chats\":42}","chat-settings":"{}"}"#;
        let incoming = r#"{"__ts":"new","chat-settings":"{}"}"#;

        let lost = keys_lost(previous, incoming);
        assert_eq!(lost, vec!["chat-conversations".to_string()]);

        let merged = merged_backup(previous, incoming, &lost);
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["chat-conversations"], "{\"chats\":42}");
        // The rest of the snapshot is still the new one.
        assert_eq!(v["__ts"], "new");

        // Negative control: the old rule was the incoming string, unread.
        let old_rule: serde_json::Value = serde_json::from_str(incoming).unwrap();
        assert!(old_rule.get("chat-conversations").is_none());
    }

    /// The one case that must NOT be treated as a loss. A user who deletes
    /// every chat still has a live store, so the key is present and carries a
    /// valid empty payload. Carrying the old value over there would resurrect
    /// chats somebody deliberately deleted.
    #[test]
    fn an_emptied_store_is_not_a_lost_one() {
        let previous = r#"{"chat-conversations":"{\"state\":{\"conversations\":[1,2]}}"}"#;
        let incoming = r#"{"chat-conversations":"{\"state\":{\"conversations\":[]}}"}"#;
        assert!(keys_lost(previous, incoming).is_empty());
        assert_eq!(merged_backup(previous, incoming, &[]), incoming);
    }

    #[test]
    fn a_first_backup_and_unreadable_neighbours_are_left_alone() {
        let incoming = r#"{"__ts":"new","chat-conversations":"x"}"#;
        // No previous file at all.
        assert!(keys_lost("", incoming).is_empty());
        assert_eq!(merged_backup("", incoming, &[]), incoming);
        // A previous file that is not JSON, or not an object, cannot be
        // reasoned about, and guessing over unreadable data is worse than the
        // plain overwrite this replaced.
        assert!(keys_lost("not json at all", incoming).is_empty());
        assert!(keys_lost("[1,2,3]", incoming).is_empty());
        // And an incoming payload we cannot read is written as it came.
        assert!(keys_lost(r#"{"a":"1"}"#, "not json").is_empty());
    }

    #[test]
    fn an_empty_string_value_counts_as_lost_too() {
        // The frontend skips falsy values, so this shape should not occur, but
        // an empty payload is a loss by any reading and must not overwrite.
        let previous = r#"{"chat-conversations":"real"}"#;
        let incoming = r#"{"chat-conversations":""}"#;
        assert_eq!(keys_lost(previous, incoming), vec!["chat-conversations".to_string()]);
        let merged = merged_backup(previous, incoming, &["chat-conversations".to_string()]);
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["chat-conversations"], "real");
    }

    #[test]
    fn every_key_that_went_missing_comes_back_not_just_the_first() {
        let previous = r#"{"chat-conversations":"c","locally-uncensored-memory":"m","rag-store":"r"}"#;
        let incoming = r#"{"rag-store":"r2"}"#;
        let mut lost = keys_lost(previous, incoming);
        lost.sort();
        assert_eq!(lost, vec!["chat-conversations".to_string(), "locally-uncensored-memory".to_string()]);
        let merged = merged_backup(previous, incoming, &lost);
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["chat-conversations"], "c");
        assert_eq!(v["locally-uncensored-memory"], "m");
        // A key the snapshot DID bring keeps the new value, not the old one.
        assert_eq!(v["rag-store"], "r2");
    }

    /// The old implementation spawned a process for the UTC offset and fell
    /// back to 0 when that failed, so it could report UTC as local time. These
    /// assert the three values stay consistent with each other.
    /// Two callers reach the screenshot tool (agent + phone bridge). A fixed
    /// temp name meant they clobbered each other; the name must differ per call
    /// and the file must be gone afterwards.
    ///
    /// ── Why the count is now over THIS process only ──
    ///
    /// It used to count every `lu-screenshot-*` in the shared temp directory,
    /// before and after, and assert the two numbers matched. That is a question
    /// about the MACHINE, not about this call: measured on 01.09.2026 under
    /// three concurrent copies of the suite it failed 5 of 30 runs with
    /// `left: 0, right: 1` — a second copy's capture was in flight between the
    /// two counts, and this test reported it as "screenshot left a temp file
    /// behind". `screenshot_blocking` puts the process id in the name, so the
    /// prefix below matches only files this process could have written.
    #[test]
    fn every_screenshot_gets_its_own_temp_file() {
        let seen: std::collections::HashSet<String> = (0..50)
            .map(|_| format!("lu-screenshot-{}-{}.png", std::process::id(), uuid::Uuid::new_v4()))
            .collect();
        assert_eq!(seen.len(), 50);

        // Ours, and nobody else's — a concurrent copy of this binary has a
        // different pid and its files do not match this prefix.
        let mine = format!("lu-screenshot-{}-", std::process::id());
        let ours = || {
            std::fs::read_dir(std::env::temp_dir())
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().starts_with(&mine))
                .count()
        };

        // The capture fails on this platform, but the temp file must still be
        // cleaned up rather than left behind on the early return.
        let before = ours();
        let _ = screenshot_blocking();
        let after = ours();
        assert_eq!(before, after, "screenshot left a temp file behind");
        // Self-check: the prefix the count filters on has to be the one
        // `screenshot_blocking` actually writes. Without this, moving the pid
        // out of the name again would leave both counts at 0 for the wrong
        // reason and this test would pass while looking at nothing.
        const SRC: &str = include_str!("system.rs");
        let at = SRC.find("fn screenshot_blocking").expect("screenshot_blocking is gone");
        let body = &SRC[at..at + SRC[at..].find("\n}\n").expect("unterminated fn")];
        assert!(
            body.contains(r#""lu-screenshot-{}-{}.png""#) && body.contains("std::process::id()"),
            "screenshot_blocking no longer builds the name this test filters on:\n{body}",
        );
    }

    /// PowerShell single-quoted strings escape `'` by doubling it, and treat a
    /// backslash as an ordinary character. C:\Users\O'Brien used to end the
    /// string early and kill the script.
    #[test]
    fn powershell_paths_survive_an_apostrophe() {
        assert_eq!(
            ps_single_quoted(r"C:\Users\O'Brien\AppData\Local\Temp\a.png"),
            r"C:\Users\O''Brien\AppData\Local\Temp\a.png"
        );
        // A plain path is passed through untouched — no backslash doubling.
        assert_eq!(ps_single_quoted(r"C:\Users\alex\a.png"), r"C:\Users\alex\a.png");
    }

    #[test]
    fn current_time_is_internally_consistent() {
        let v = get_current_time().expect("get_current_time");
        let unix = v["unix"].as_i64().unwrap();
        let offset_min = v["timezone_offset"].as_i64().unwrap();

        // Local wall clock must be exactly `offset` minutes ahead of UTC.
        let utc = chrono::DateTime::parse_from_rfc3339(v["iso_utc"].as_str().unwrap())
            .expect("iso_utc parses as RFC3339");
        let local = chrono::NaiveDateTime::parse_from_str(
            v["iso_local"].as_str().unwrap(),
            "%Y-%m-%d %H:%M:%S",
        )
        .expect("iso_local parses");
        let delta_min = (local - utc.naive_utc()).num_minutes();
        assert_eq!(delta_min, offset_min, "local clock must be utc + offset");

        assert_eq!(utc.timestamp(), unix, "iso_utc must match the unix field");

        // "+0200" / "-0500" — the shape the agent prompt documents.
        let tz = v["timezone"].as_str().unwrap();
        assert!(
            tz.len() == 5 && (tz.starts_with('+') || tz.starts_with('-'))
                && tz[1..].chars().all(|c| c.is_ascii_digit()),
            "unexpected timezone format: {tz}"
        );
    }

    #[test]
    fn current_time_costs_no_process_spawn() {
        // Measured: the old `date +%z` path cost 36.8 ms for 20 calls on this
        // Mac, and a PowerShell cold start on Windows is 300-900 ms EACH. In
        // process it is microseconds, so 20 ms fails either spawn path while
        // leaving plenty of room on a loaded box.
        //
        // The BEST of five batches is what gets judged, not one batch: on a
        // fresh 4-vCPU Ubuntu box the full suite runs ~1100 tests in parallel,
        // and a single batch was stalled by the scheduler to 87 ms and 184 ms
        // in two of five runs (2026-09-05) with nothing spawning at all. A
        // spawn path is slow in EVERY batch, so the minimum still catches it;
        // a stall hits one batch and leaves the minimum in the microseconds.
        let mut best = std::time::Duration::MAX;
        for _ in 0..5 {
            let started = std::time::Instant::now();
            for _ in 0..20 {
                let _ = get_current_time().unwrap();
            }
            best = best.min(started.elapsed());
        }
        assert!(
            best < std::time::Duration::from_millis(20),
            "the fastest of five batches of 20 calls took {best:?} — is something spawning a process again?"
        );
    }

    /// G28 (Mac, R01a 2026-08-07): the screenshot step took 138 SECONDS
    /// because macOS held `screencapture` on its consent dialog and the old
    /// code waited with `.status()`, which has no deadline at all. These use
    /// `/bin/sleep` as a stand-in for a blocked capture, because a real
    /// consent dialog cannot be summoned from a unit test.
    #[test]
    #[cfg(unix)]
    fn a_blocked_capture_is_killed_at_the_deadline() {
        let mut cmd = std::process::Command::new("/bin/sleep");
        cmd.arg("30");
        let started = std::time::Instant::now();
        let err = run_capture_bounded(
            cmd,
            std::time::Duration::from_millis(300),
            "Screenshot timed out, the consent dialog is probably up.",
        )
        .unwrap_err();
        assert!(err.contains("timed out"), "message must say what happened: {err}");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(3),
            "the deadline did not fire, waited {:?}",
            started.elapsed()
        );
    }

    /// NEGATIVE CONTROL: a capture that finishes normally is untouched by the
    /// deadline and must not be reported as a failure.
    #[test]
    #[cfg(unix)]
    fn a_normal_capture_is_not_cut_short() {
        let mut ok = std::process::Command::new("/usr/bin/true");
        ok.stdout(std::process::Stdio::null());
        assert!(run_capture_bounded(ok, std::time::Duration::from_secs(5), "unused").is_ok());
    }

    /// NEGATIVE CONTROL: a real failure still reads as a failure, not as a
    /// timeout, so the permission hint is not blamed for the wrong thing.
    #[test]
    #[cfg(unix)]
    fn a_failing_capture_is_reported_as_a_failure() {
        let mut bad = std::process::Command::new("/usr/bin/false");
        bad.stdout(std::process::Stdio::null());
        let err = run_capture_bounded(bad, std::time::Duration::from_secs(5), "TIMEOUT-MARKER").unwrap_err();
        assert!(!err.contains("TIMEOUT-MARKER"), "a non-zero exit is not a timeout: {err}");
        assert!(err.contains("Screenshot failed"), "{err}");
    }

    /// The deadline shipped to users has to be generous enough for a real
    /// capture on a big display and short enough to not stall an agent run.
    #[test]
    fn the_shipped_deadline_is_sane() {
        assert!(SCREENSHOT_TIMEOUT >= std::time::Duration::from_secs(5));
        assert!(SCREENSHOT_TIMEOUT <= std::time::Duration::from_secs(60));
    }

    // ── Bug A1 (2.6.7): more than one file stands between a user and their
    // chats, and the newest name is not automatically the usable one.

    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lu-a1-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A user lost the chats to a boot that came back with the
    /// IndexedDB gone. The file on disk was fine that time. It does not have
    /// to be: the rename that publishes store_backup.json is atomic in name
    /// only, the bytes are not on the platter until they are synced, and a
    /// hard kill in that window leaves the right name over nothing readable.
    ///
    /// So the restore walks the ring instead of stopping at the newest name.
    #[test]
    fn a_newest_backup_that_reads_as_nothing_is_stepped_over() {
        let corrupt = String::from("\u{0}\u{0}\u{0}");
        let truncated = String::from("{\"chat-conversations\":\"{\\\"chats");
        let good = String::from(r#"{"__ts":"older","chat-conversations":"{\"chats\":42}"}"#);

        let picked = pick_backup([corrupt.clone(), truncated.clone(), good.clone()]);
        assert_eq!(picked.as_deref(), Some(good.as_str()));

        // And a ring where nothing is usable still answers with the newest
        // file, so the caller's "no backup at all" branch stays reserved for a
        // machine that has never written one.
        assert_eq!(
            pick_backup([corrupt.clone(), truncated.clone()]).as_deref(),
            Some(corrupt.as_str())
        );
        assert_eq!(pick_backup(Vec::<String>::new()), None);

        // NEGATIVE CONTROL: the old rule was "read store_backup.json, hand it
        // over". On this disk that is the corrupt file, and the chats sitting
        // one generation away are never looked at.
        let old_rule = corrupt.clone();
        assert!(!is_usable_backup(&old_rule));
        assert!(!old_rule.contains("chat-conversations"));
    }

    /// A backup with nothing but its own timestamp in it is not a backup. It
    /// is what a boot with wiped storage would produce, and restoring from it
    /// would be the loss all over again.
    #[test]
    fn a_snapshot_with_only_a_timestamp_is_not_usable() {
        assert!(!is_usable_backup(r#"{"__ts":"2026-08-28T00:00:00.000Z"}"#));
        assert!(!is_usable_backup(r#"{"__ts":"x","chat-conversations":""}"#));
        assert!(!is_usable_backup(""));
        assert!(!is_usable_backup("[1,2,3]"));
        assert!(is_usable_backup(r#"{"__ts":"x","chat-settings":"{}"}"#));
    }

    /// Newest first, and the file set aside before a loss is the last resort
    /// rather than the first answer.
    #[test]
    fn the_candidate_order_runs_newest_to_oldest() {
        let dir = std::path::Path::new("/nowhere");
        let names: Vec<String> = backup_candidates(dir)
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec![
                "store_backup.json",
                "store_backup.1.json",
                "store_backup.2.json",
                "store_backup.3.json",
                "store_backup.prev.json",
            ]
        );
    }

    /// The triad writes every 5 s and after every chat mutation. Rotating on
    /// each of those would fill the ring with three copies of the same minute
    /// and throw away the older states that make a ring worth having.
    #[test]
    fn the_ring_is_only_cut_when_the_newest_generation_has_aged() {
        assert!(should_rotate(None));
        assert!(!should_rotate(Some(std::time::Duration::from_secs(5))));
        assert!(!should_rotate(Some(std::time::Duration::from_secs(60))));
        assert!(should_rotate(Some(std::time::Duration::from_secs(ROTATE_AFTER_SECS))));
        assert!(should_rotate(Some(std::time::Duration::from_secs(60 * 60 * 24))));
    }

    /// Shifting the ring keeps the agreed number of generations and no more.
    #[test]
    fn rotating_shifts_the_ring_and_drops_the_oldest() {
        let dir = scratch_dir("rotate");
        std::fs::write(dir.join("store_backup.json"), "live-1").unwrap();
        rotate_generations(&dir);
        assert_eq!(
            std::fs::read_to_string(dir.join("store_backup.1.json")).unwrap(),
            "live-1"
        );

        // A second rotation right away is refused, the newest generation is
        // seconds old.
        std::fs::write(dir.join("store_backup.json"), "live-2").unwrap();
        rotate_generations(&dir);
        assert_eq!(
            std::fs::read_to_string(dir.join("store_backup.1.json")).unwrap(),
            "live-1"
        );

        // Force the shifts the clock would otherwise take an hour and a half
        // to allow, by moving the ring by hand the way rotate_generations does.
        std::fs::rename(dir.join("store_backup.1.json"), dir.join("store_backup.2.json")).unwrap();
        std::fs::write(dir.join("store_backup.1.json"), "gen-1").unwrap();
        std::fs::write(dir.join("store_backup.3.json"), "gen-3").unwrap();
        std::fs::remove_file(dir.join("store_backup.1.json")).unwrap();
        std::fs::write(dir.join("store_backup.json"), "live-3").unwrap();
        rotate_generations(&dir);

        assert_eq!(std::fs::read_to_string(dir.join("store_backup.1.json")).unwrap(), "live-3");
        assert_eq!(std::fs::read_to_string(dir.join("store_backup.3.json")).unwrap(), "live-1");
        // BACKUP_GENERATIONS is the cap, nothing beyond it is written.
        assert!(!dir.join(format!("store_backup.{}.json", BACKUP_GENERATIONS + 1)).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A backup file in the shape 3.0.8 writes: `chat-conversations` is the
    /// zustand blob as a string, with `state.conversations`.
    fn backup_with_chats(ids: &[&str]) -> String {
        let conversations: Vec<serde_json::Value> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| serde_json::json!({ "id": id, "title": id, "createdAt": 1, "updatedAt": 10 + i, "messages": [] }))
            .collect();
        let chat = serde_json::json!({ "state": { "conversations": conversations, "activeConversationId": null } });
        serde_json::json!({ "__ts": "t", "chat-conversations": chat.to_string(), "chat-settings": "{}" }).to_string()
    }

    /// perrt, 05.11.2026: the merge kept the chats while the key was missing,
    /// then the store wrote a fresh list and the next snapshot replaced the
    /// only complete copy. The previous file now goes to an archive first.
    #[test]
    fn a_snapshot_whose_list_lost_chats_archives_the_previous_backup() {
        let dir = scratch_dir("chat-archive");
        let previous = backup_with_chats(&["a", "b", "c"]);
        let incoming = backup_with_chats(&["new"]);

        let dropped = chat_ids_dropped(&previous, &incoming);
        assert_eq!(dropped, vec!["a", "b", "c"]);
        // Negative control: the rule that decides the merge sees no loss here,
        // which is exactly how the chats went.
        assert!(keys_lost(&previous, &incoming).is_empty());

        let path = archive_dropped_chats(&dir, &previous, &dropped, 1000).expect("archived");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), previous);
        assert_eq!(chat_archives(&dir), vec![path.clone()]);
        // And a restore and the attachment collector see it.
        assert!(backup_candidates(&dir).contains(&path));

        // The same chats dropped again: the newest archive has them, no new file.
        assert!(archive_dropped_chats(&dir, &previous, &["b".to_string()], 2000).is_none());
        assert_eq!(chat_archives(&dir).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_archive_without_a_dropped_chat() {
        let previous = backup_with_chats(&["a", "b"]);
        // Grown, unchanged, or a snapshot without the key (the merge's case).
        assert!(chat_ids_dropped(&previous, &backup_with_chats(&["a", "b", "c"])).is_empty());
        assert!(chat_ids_dropped(&previous, &previous).is_empty());
        assert!(chat_ids_dropped(&previous, r#"{"chat-settings":"{}"}"#).is_empty());
        // No previous list to compare with.
        assert!(chat_ids_dropped("", &backup_with_chats(&["a"])).is_empty());
        assert!(chat_ids_dropped(r#"{"chat-conversations":"garbled"}"#, &backup_with_chats(&[])).is_empty());
    }

    #[test]
    fn a_stray_null_in_the_list_does_not_hide_the_loss() {
        let chat = serde_json::json!({ "state": { "conversations": [null, { "id": "a", "messages": [] }] } });
        let previous = serde_json::json!({ "chat-conversations": chat.to_string() }).to_string();
        assert_eq!(chat_ids_dropped(&previous, &backup_with_chats(&[])), vec!["a"]);
    }

    #[test]
    fn only_the_newest_five_archives_stay() {
        let dir = scratch_dir("chat-archive-ring");
        for i in 0..7u128 {
            let id = format!("chat{i}");
            let previous = backup_with_chats(&[id.as_str()]);
            archive_dropped_chats(&dir, &previous, &[id], 100 + i).expect("archived");
        }
        let names: Vec<String> = chat_archives(&dir)
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), CHAT_ARCHIVES_KEPT);
        assert_eq!(names[0], "store_backup.chats-106.json");
        assert_eq!(names[4], "store_backup.chats-102.json");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Restore chats from backup: one entry per id across every file, the
    /// newest copy wins, entries without an id or messages are skipped.
    #[test]
    fn chats_in_backups_merges_every_file_by_id() {
        let live = backup_with_chats(&["new"]);
        let older = backup_with_chats(&["a", "b"]);
        let newer_b = serde_json::json!({
            "chat-conversations": serde_json::json!({ "state": { "conversations": [
                { "id": "b", "updatedAt": 99, "messages": [{ "id": "m" }] },
                { "id": "broken" },
                { "title": "no id", "messages": [] }
            ] } }).to_string()
        })
        .to_string();
        let list = chats_in_backups(vec![live, older, newer_b, "not json".to_string()]);
        let ids: Vec<&str> = list.iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["b", "a", "new"]);
        assert_eq!(list[0]["updatedAt"], 99);
    }

    /// perrt's folder after five more hours: the ring holds only the two new
    /// chats, store_backup.prev.json the old ones. Both come back, side by side.
    #[test]
    fn the_file_set_aside_is_read_next_to_an_emptied_ring() {
        let dir = scratch_dir("rescue-prev");
        std::fs::write(dir.join("store_backup.json"), backup_with_chats(&["new1", "new2"])).unwrap();
        for i in 1..=BACKUP_GENERATIONS {
            std::fs::write(dir.join(format!("store_backup.{i}.json")), backup_with_chats(&["new1"])).unwrap();
        }
        std::fs::write(dir.join("store_backup.prev.json"), backup_with_chats(&["old1", "old2", "old3"])).unwrap();
        let raws = backup_candidates(&dir).into_iter().filter_map(|p| std::fs::read_to_string(p).ok());
        let mut ids: Vec<String> = chats_in_backups(raws).iter().map(|c| c["id"].as_str().unwrap().to_string()).collect();
        ids.sort();
        assert_eq!(ids, vec!["new1", "new2", "old1", "old2", "old3"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Nothing to rotate must not create an empty generation that then reads
    /// as a backup on the next boot.
    #[test]
    fn a_first_run_with_no_live_backup_writes_no_generation() {
        let dir = scratch_dir("first");
        rotate_generations(&dir);
        assert!(!dir.join("store_backup.1.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
