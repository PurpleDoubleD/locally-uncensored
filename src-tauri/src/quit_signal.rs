//! A quit by signal cleans up like a quit by menu (macOS and Linux).
//!
//! Found while testing the Local API for 3.1.0 (P-J): a `kill <pid>` of the
//! app (SIGTERM) left its `lu-llama-server` running with the model loaded.
//! Nothing in the app answered SIGTERM, SIGINT or SIGHUP, so the default
//! action ended the process on the spot. `RunEvent::Exit` never ran, and
//! neither did `AppState::shutdown_subprocesses`, the one routine every other
//! quit path goes through (tray Quit, Cmd+Q, the close button without a tray,
//! `exit_app`). The next start of the app ended the orphan
//! (`engine::reap_orphaned_sidecars`), but only on a Mac, and until then the
//! model held its memory and its port.
//!
//! Who sends these signals: `kill`, `pkill`, a service manager stopping a
//! headless LU on a Linux server (systemd sends SIGTERM, then SIGKILL after a
//! grace period), Ctrl+C in the terminal that started it (SIGINT), a closed
//! terminal or SSH session (SIGHUP).
//!
//! What happens now: the first of them runs `shutdown_subprocesses` and then
//! leaves with the conventional code 128 + signal (143 for SIGTERM). The
//! cleanup is bounded: if it has not finished after `GNADENFRIST`, or a second
//! signal arrives, the process leaves anyway, so a hung child can never keep
//! LU from quitting when it is told to.
//!
//! Windows needs none of this: every engine child joins the app's
//! kill-on-close job object (`commands::process::tie_child_to_app_lifetime`),
//! so the system ends them with the app, also on a hard `taskkill /F`.
//! SIGKILL cannot be caught by anyone; for that the reap at the next start
//! stays.

#[cfg(unix)]
use std::time::Duration;

/// How long the cleanup may take before the process leaves anyway. Under
/// systemd's default stop timeout (90 s), and long enough for the slowest
/// branch of `shutdown_subprocesses` (the trainer's process-table walk).
#[cfg(unix)]
pub const GNADENFRIST: Duration = Duration::from_secs(10);

/// The exit code of a process that ended because of `signal`.
#[cfg(unix)]
pub fn exit_code(signal: i32) -> i32 {
    128 + signal
}

/// Waits for SIGTERM, SIGINT or SIGHUP, then runs `aufraeumen` and calls
/// `beenden` with the exit code. A second signal during the cleanup, or the
/// end of `frist`, calls `beenden` without waiting for the cleanup.
///
/// Generic over both actions so the test can run it in a child process with a
/// real grandchild and a real signal (see the tests below).
#[cfg(unix)]
pub async fn warte_und_raeume<A, B>(aufraeumen: A, beenden: B, frist: Duration)
where
    A: FnOnce() + Send + 'static,
    B: Fn(i32) + Send + Sync + 'static,
{
    use tokio::signal::unix::{signal, SignalKind};
    let (Ok(mut term), Ok(mut int), Ok(mut hup)) = (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
        signal(SignalKind::hangup()),
    ) else {
        tracing::warn!("quit signals could not be watched; a kill leaves the engine to the next start");
        return;
    };
    let sig = tokio::select! {
        _ = term.recv() => 15,
        _ = int.recv() => 2,
        _ = hup.recv() => 1,
    };
    tracing::info!(signal = sig, "quit by signal: stopping the engine and the other child processes");
    let beenden = std::sync::Arc::new(beenden);
    let aufraeumen = tokio::task::spawn_blocking(aufraeumen);
    tokio::select! {
        _ = aufraeumen => {}
        _ = tokio::time::sleep(frist) => {
            tracing::warn!(signal = sig, "cleanup after a quit signal took too long; leaving anyway");
        }
        _ = term.recv() => {}
        _ = int.recv() => {}
        _ = hup.recv() => {}
    }
    beenden(exit_code(sig));
}

/// Starts the watch for the app. Desktop unix only; see the head of the file.
#[cfg(all(unix, desktop))]
pub fn install(app: tauri::AppHandle) {
    use tauri::Manager;
    let fuer_aufraeumen = app.clone();
    tauri::async_runtime::spawn(warte_und_raeume(
        move || {
            if let Some(state) = fuer_aufraeumen.try_state::<crate::state::AppState>() {
                state.shutdown_subprocesses();
            }
        },
        // `std::process::exit`, not `app.exit`: the cleanup has run, and the
        // event loop may be the very thing that hangs.
        |code| std::process::exit(code),
        GNADENFRIST,
    ));
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    const KIND_ENV: &str = "LU_QUIT_SIGNAL_CHILD";
    const PID_DATEI_ENV: &str = "LU_QUIT_SIGNAL_PIDFILE";

    #[test]
    fn der_exitcode_ist_128_plus_signal() {
        assert_eq!(exit_code(15), 143);
        assert_eq!(exit_code(2), 130);
        assert_eq!(exit_code(1), 129);
    }

    fn lebt(pid: i32) -> bool {
        // `kill -0` without sending anything; a reaped process is ESRCH.
        Command::new("kill").args(["-0", &pid.to_string()]).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
    }

    /// The child half of the test below: it plays the app. It starts a
    /// long-running grandchild (the engine stand-in), writes its pid, and
    /// waits for a quit signal with the real `warte_und_raeume`. Run only as
    /// the child (the variable is set), never on its own.
    #[test]
    #[ignore = "child process of ein_signal_raeumt_die_kinder_weg"]
    fn kindprozess_spielt_die_app() {
        let Ok(datei) = std::env::var(PID_DATEI_ENV) else { return };
        if std::env::var(KIND_ENV).is_err() {
            return;
        }
        let mut enkel = Command::new("sleep").arg("300").spawn().expect("sleep starts");
        let pid = enkel.id();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async move {
            let warten = tokio::spawn(warte_und_raeume(
                move || {
                    let _ = enkel.kill();
                    let _ = enkel.wait();
                },
                |code| std::process::exit(code),
                Duration::from_secs(5),
            ));
            // The handlers are registered once the task has run its first
            // poll; only then may the parent send.
            tokio::time::sleep(Duration::from_millis(200)).await;
            std::fs::write(&datei, pid.to_string()).unwrap();
            let _ = warten.await;
        });
    }

    /// A SIGTERM or SIGINT to the "app" ends its child as well, and the app
    /// leaves with 128 + signal. Without the watch, the grandchild survives
    /// its parent (that was the orphaned `lu-llama-server`).
    #[test]
    fn ein_signal_raeumt_die_kinder_weg() {
        let exe = std::env::current_exe().unwrap();
        for (sig, name) in [(15, "TERM"), (2, "INT"), (1, "HUP")] {
            let dir = std::env::temp_dir().join(format!("lu-quit-signal-{}-{}", std::process::id(), sig));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let datei = dir.join("enkel.pid");
            let mut kind = Command::new(&exe)
                .args(["quit_signal::tests::kindprozess_spielt_die_app", "--exact", "--ignored", "--nocapture", "--test-threads=1"])
                .env(KIND_ENV, "1")
                .env(PID_DATEI_ENV, &datei)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let mut enkel: Option<i32> = None;
            for _ in 0..200 {
                if let Ok(t) = std::fs::read_to_string(&datei) {
                    if let Ok(p) = t.trim().parse() {
                        enkel = Some(p);
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let enkel = enkel.expect("the child wrote the grandchild's pid");
            assert!(lebt(enkel), "the grandchild runs before the signal");

            let ok = Command::new("kill").args([&format!("-{}", name), &kind.id().to_string()]).status().unwrap().success();
            assert!(ok);
            let status = kind.wait().unwrap();
            assert_eq!(status.code(), Some(exit_code(sig)), "SIG{name}: the app leaves with 128 + signal");

            let mut weg = false;
            for _ in 0..60 {
                if !lebt(enkel) {
                    weg = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            if !weg {
                let _ = Command::new("kill").args(["-9", &enkel.to_string()]).status();
            }
            let _ = std::fs::remove_dir_all(&dir);
            assert!(weg, "SIG{name}: the child process outlived the app");
        }
    }

    /// The app installs the watch at start (lib.rs), on desktop unix.
    #[test]
    fn die_app_installiert_die_wache() {
        let lib = include_str!("lib.rs");
        assert!(lib.contains("quit_signal::install(app.handle().clone());"), "lib.rs no longer starts the quit-signal watch");
    }
}
