//! Ein pip-Lauf: durchführen, mitschreiben, wiederholen, deuten.
//!
//! Der geteilte Zustand ist der `InstallState` des jeweiligen Installers.
//! Alles hier schreibt in dieselben drei Felder — `logs` für die Zeilen, die
//! der Nutzer im Panel liest, und `download_progress`/`download_total`/
//! `download_speed` für den Balken daneben. Deshalb liegen der Streaming-Lauf,
//! das Zählen der angekündigten Wheel-Größen und das Auslesen der
//! gelesenen Bytes des Kindprozesses zusammen: sie füllen ein und dieselbe
//! Anzeige, und ein Wiederholungsversuch muss sie gemeinsam zurücksetzen,
//! sonst zählt er dieselben Wheels ein zweites Mal.
//!
//! Die Fehlerdeutung gehört dazu und nicht woandershin: `is_transient_pip_error`
//! entscheidet, ob überhaupt wiederholt wird, und `diagnose_pip_error_*`
//! macht aus dem, was nach dem letzten Versuch übrig ist, einen Satz, den der
//! Nutzer befolgen kann. Beide lesen denselben stderr-Text desselben Laufs.
//!
//! Was hier NICHT liegt: welche Pakete installiert werden. Das entscheidet
//! `torch`, `voice` oder der Aufrufer — dieses Modul bekommt fertige
//! Argumente und führt sie aus.

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::state::InstallState;

use super::children::TrackedInstallerChild;
#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

// ── pip helpers (issue #32: PyTorch / ComfyUI install reliability) ───────────

/// Push a log line to the shared install state. Best-effort — silently
/// no-ops if the mutex is poisoned (which only happens if a thread panicked
/// while holding the lock; the install is already broken at that point).
fn push_install_log(state: &Arc<Mutex<InstallState>>, msg: &str) {
    if let Ok(mut s) = state.lock() {
        s.logs.push(msg.to_string());
    }
}

/// Detect pip errors that warrant an automatic retry with backoff.
/// Conservative — only retries on errors caused by transient network
/// conditions, not on auth, permission, disk-full, or python-side bugs.
fn is_transient_pip_error(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("403 ")
        || lower.contains("502 ")
        || lower.contains("503 ")
        || lower.contains("504 ")
        || lower.contains("429 ")
        || lower.contains("sslerror")
        || lower.contains("ssl: ")
        || lower.contains("readtimeouterror")
        || lower.contains("connecttimeouterror")
        || lower.contains("connectiontimeouterror")
        || lower.contains("connectionerror")
        || lower.contains("connectionreseterror")
        || lower.contains("connection reset")
        || lower.contains("connection aborted")
        || lower.contains("connection refused")
        || lower.contains("incompleteread")
        || lower.contains("temporary failure")
        || lower.contains("network is unreachable")
        || lower.contains("could not fetch")
        || lower.contains("read timed out")
        || lower.contains("eof occurred in violation of protocol")
        || lower.contains("max retries exceeded")
}

/// Turn raw pip stderr into a user-friendly hint with troubleshooting
/// guidance. The first line of the returned string is a short diagnosis;
/// the rest is the truncated original error for context.
/// "Python 3.8.10 at C:\Python38\python.exe", or just the path when the
/// interpreter will not say. Costs one process launch, which is fine on an
/// error path and is the single fact that turns "no matching wheel" from a
/// riddle into an instruction: willes0504 (Discord 2026-07-28) had a stray
/// 3.8 first in PATH and needed a volunteer plus a day to find that out.
fn interpreter_description(python_bin: &str) -> String {
    let mut cmd = Command::new(python_bin);
    cmd.arg("--version");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    match cmd.output() {
        Ok(out) => {
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            let version = text.trim().lines().next().unwrap_or("").trim().to_string();
            if version.is_empty() {
                python_bin.to_string()
            } else {
                format!("{version} at {python_bin}")
            }
        }
        Err(_) => python_bin.to_string(),
    }
}

pub(super) fn diagnose_pip_error(stderr: &str) -> String {
    diagnose_pip_error_for(stderr, None)
}

/// Same diagnosis, plus which interpreter produced it when the caller knows.
/// Version-shaped failures are unanswerable without that line.
fn diagnose_pip_error_for(stderr: &str, python_bin: Option<&str>) -> String {
    let base = diagnose_pip_error_inner(stderr);
    let needs_interpreter = {
        let lower = stderr.to_lowercase();
        lower.contains("could not find a version")
            || lower.contains("no matching distribution")
            || lower.contains("no module named")
            || lower.contains("modulenotfounderror")
    };
    match (needs_interpreter, python_bin) {
        (true, Some(bin)) => format!("{base}\n\nLU used {}.", interpreter_description(bin)),
        _ => base,
    }
}

fn diagnose_pip_error_inner(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    let snippet: String = stderr.chars().take(400).collect();

    let hint = if lower.contains("externally-managed-environment")
        || lower.contains("error: externally-managed")
    {
        "Your Python is PEP 668 protected (Arch Linux, Debian 12+, Fedora 38+, \
         Ubuntu 23.04+ block system-wide pip installs by default). LU should have \
         created a venv inside the ComfyUI folder automatically — if you see this \
         error, the venv module is missing. Install it and retry:\n\
         • Arch:   sudo pacman -S python-virtualenv\n\
         • Debian/Ubuntu: sudo apt install python3-venv\n\
         • Fedora: sudo dnf install python3-virtualenv"
    } else if lower.contains("ssl module in python is not available") {
        // numbrain (Discord, 2026-08-02): a pyenv/source-built python without
        // the _ssl extension can't reach pypi AT ALL, and the generic SSL hint
        // below (antivirus/clock) sent him in the wrong direction.
        "This Python was built without the ssl module, so pip cannot reach \
         pypi.org at all. Use your distro's regular python3 (it ships with \
         ssl): check with  python3 -c \"import ssl\"  — if that fails, \
         reinstall python3 via your package manager (pyenv builds need the \
         OpenSSL headers installed first, e.g. libssl-dev / openssl-devel), \
         then retry."
    } else if lower.contains("ssl") {
        "SSL error reaching pypi.org. Often caused by an antivirus / firewall \
         intercepting TLS, or a stale system clock. Disable TLS interception \
         for python.exe, fix the system clock, then retry."
    } else if lower.contains("403 ") {
        "HTTP 403 from pypi.org or pytorch.org. The mirror may be blocked on \
         your network. Try a different network or VPN, then retry."
    } else if lower.contains("429 ") {
        "Rate limited (HTTP 429). Wait a few minutes and retry."
    } else if lower.contains("timeout") || lower.contains("timed out") {
        "Network timeout. Slow connection or congested mirror. Retry on a \
         faster network, or run the install during off-peak hours."
    } else if lower.contains("connection") {
        "Connection error. Check internet connectivity, restart the app, \
         and retry."
    } else if lower.contains("no space") || lower.contains("errno 28") {
        "Out of disk space. PyTorch + dependencies need ~5 GB free. Free up \
         space and retry."
    } else if lower.contains("permission") || lower.contains("errno 13") {
        "Permission denied. Make sure no other process is using Python, then \
         retry. On Windows: close any open Python REPLs / Jupyter / IDE \
         debuggers."
    } else if lower.contains("no module named") || lower.contains("modulenotfounderror") {
        "Python install is missing pip or is broken. Reinstall Python 3.10+ \
         from python.org with 'Add to PATH' checked."
    } else if lower.contains("could not find a version") {
        "No matching wheel for your Python version. ComfyUI needs Python \
         3.10, 3.11, or 3.12. Reinstall a supported Python version."
    } else {
        ""
    };

    if hint.is_empty() {
        snippet
    } else {
        format!("{}\n\n--- pip output ---\n{}", hint, snippet)
    }
}

/// Run a `python -m pip install ...` command, streaming its stdout + stderr
/// line-by-line into the install state's `logs` so the user sees live
/// progress instead of a frozen UI. Retries up to `max_attempts` times on
/// transient network errors with exponential backoff (10s, 30s, 90s).
///
/// On non-transient errors or after exhausting retries, returns Err with a
/// human-readable diagnosis prepended to the truncated original error.
/// Streaming pip install with retry. When `cancel` is `Some`, polls the
/// shared flag between line reads and waits, and kills the pip child on
/// cancel — used by `install_comfyui` so the user's Cancel button
/// (Bug #1 — techx69 v2.4.3) actually stops the running install instead
/// of waiting for pip to finish naturally. When `cancel` is `None`, the
/// install runs to completion as before — used by `install_python` and
/// callers that haven't been wired up to the new cancel flow.
pub fn pip_install_streaming_with_retry_cancellable(
    args: &[&str],
    python_bin: &str,
    max_attempts: u32,
    install_state: &Arc<Mutex<InstallState>>,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<(), String> {
    let mut delay_seconds = 10u64;
    let mut last_stderr = String::new();

    for attempt in 1..=max_attempts {
        if cancel.as_ref().map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
            return Err("cancelled".to_string());
        }
        if attempt > 1 {
            push_install_log(
                install_state,
                &format!(
                    "Transient network error — retry {}/{} after {}s wait...",
                    attempt, max_attempts, delay_seconds
                ),
            );
            // Sleep in 1-second chunks so cancel reacts within ~1s.
            for _ in 0..delay_seconds {
                if cancel.as_ref().map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
                    return Err("cancelled".to_string());
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
            delay_seconds = (delay_seconds * 3).min(180);
        }

        // Fresh download stats per pip run; a retry must not double the
        // announced total by counting the same wheels twice.
        if let Ok(mut s) = install_state.lock() {
            s.download_progress = 0;
            s.download_total = 0;
            s.download_speed = 0.0;
        }
        let announced_total = Arc::new(AtomicU64::new(0));

        let mut cmd = Command::new(python_bin);
        cmd.args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return Err(format!("Could not start pip ({}). Is Python on PATH?", e)),
        };
        // OI-7: registered for the whole run, so Cancel and Quit can reach
        // pip's build subprocesses and not just pip. Dropped on every exit
        // path below, including the `?`-free early returns and a panic.
        let _tracked = TrackedInstallerChild::register(child.id());

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stderr_capture: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));

        // Stream stdout to install logs
        let stdout_state = install_state.clone();
        let announced = announced_total.clone();
        let stdout_handle = std::thread::spawn(move || {
            if let Some(out) = stdout {
                let reader = BufReader::new(out);
                for line in reader.lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        if let Some(bytes) = parse_pip_download_size(trimmed) {
                            announced.fetch_add(bytes, Ordering::Relaxed);
                        }
                        if let Ok(mut s) = stdout_state.lock() {
                            s.logs.push(trimmed.to_string());
                        }
                    }
                }
            }
        });

        // Stream stderr to install logs AND capture for retry decision
        let stderr_state = install_state.clone();
        let stderr_capture_clone = stderr_capture.clone();
        let stderr_handle = std::thread::spawn(move || {
            if let Some(err) = stderr {
                let reader = BufReader::new(err);
                for line in reader.lines().map_while(Result::ok) {
                    if let Ok(mut buf) = stderr_capture_clone.lock() {
                        buf.push_str(&line);
                        buf.push('\n');
                    }
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        if let Ok(mut s) = stderr_state.lock() {
                            s.logs.push(trimmed.to_string());
                        }
                    }
                }
            }
        });

        // Poll for either the child to exit or the cancel flag to flip.
        // try_wait avoids blocking the cancel check; sleep keeps CPU idle.
        // Once a second the child's cumulative read bytes turn the announced
        // wheel sizes into progress and speed for the install status, which
        // the UI renders next to the rebuild spinner.
        let pid = child.id();
        let mut io_baseline: Option<(u64, Instant)> = None;
        let mut tick: u32 = 0;
        let exit_status = loop {
            if cancel.as_ref().map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
                // Kill the child so pip doesn't keep saturating disk — the
                // TREE, not just pip: a source wheel that is mid-compile has
                // its own descendants, and `Child::kill` never reached them.
                crate::commands::shell::kill_tree(pid);
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                return Err("cancelled".to_string());
            }
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) => {
                    tick += 1;
                    if tick.is_multiple_of(5) {
                        let total = announced_total.load(Ordering::Relaxed);
                        if total > 0 {
                            if let Some(read) = process_read_bytes(pid) {
                                let (base, since) =
                                    *io_baseline.get_or_insert((read, Instant::now()));
                                let progress = read.saturating_sub(base).min(total);
                                let elapsed = since.elapsed().as_secs_f64();
                                let speed =
                                    if elapsed > 0.5 { progress as f64 / elapsed } else { 0.0 };
                                if let Ok(mut s) = install_state.lock() {
                                    s.download_progress = progress;
                                    s.download_total = total;
                                    s.download_speed = speed;
                                }
                            }
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                Err(e) => return Err(format!("pip wait failed: {}", e)),
            }
        };
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();

        // The run is over either way; a frozen speed would read as a live
        // download next to a finished or failed step.
        if let Ok(mut s) = install_state.lock() {
            if exit_status.success() && s.download_total > 0 {
                s.download_progress = s.download_total;
            }
            s.download_speed = 0.0;
        }

        if exit_status.success() {
            return Ok(());
        }

        last_stderr = stderr_capture
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default();

        if !is_transient_pip_error(&last_stderr) {
            return Err(diagnose_pip_error_for(&last_stderr, Some(python_bin)));
        }
    }

    Err(format!(
        "Exhausted {} retry attempts for transient network errors.\n\n{}",
        max_attempts,
        diagnose_pip_error_for(&last_stderr, Some(python_bin))
    ))
}

/// Bytes a pip "Downloading <thing> (<size>)" stdout line announces. pip
/// prints decimal units, kB means 1000 bytes. "Using cached" lines are not
/// network traffic and must not count.
pub(crate) fn parse_pip_download_size(line: &str) -> Option<u64> {
    let rest = line.trim().strip_prefix("Downloading ")?;
    let inner = rest[rest.rfind('(')? + 1..].strip_suffix(')')?;
    let mut parts = inner.split_whitespace();
    let num: f64 = parts.next()?.parse().ok()?;
    let unit = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let factor = match unit {
        "bytes" | "B" => 1.0,
        "kB" => 1e3,
        "MB" => 1e6,
        "GB" => 1e9,
        _ => return None,
    };
    Some((num * factor).round() as u64)
}

/// Cumulative bytes the process has read from files and sockets. pip
/// downloads in-process, so this is the live counter behind the progress
/// display next to the rebuild spinner. None where the platform has no
/// cheap probe and on any probe error; the caller then keeps the plain
/// spinner instead of guessing.
#[cfg(target_os = "windows")]
pub(crate) fn process_read_bytes(pid: u32) -> Option<u64> {
    #[repr(C)]
    struct IoCounters {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn GetProcessIoCounters(handle: isize, counters: *mut IoCounters) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }
    const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid);
        if handle == 0 {
            return None;
        }
        let mut counters = std::mem::zeroed::<IoCounters>();
        let ok = GetProcessIoCounters(handle, &mut counters);
        CloseHandle(handle);
        (ok != 0).then_some(counters.read_bytes)
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn process_read_bytes(pid: u32) -> Option<u64> {
    std::fs::read_to_string(format!("/proc/{}/io", pid))
        .ok()?
        .lines()
        .find_map(|l| l.strip_prefix("rchar:"))
        .and_then(|v| v.trim().parse().ok())
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub(crate) fn process_read_bytes(_pid: u32) -> Option<u64> {
    None
}

// ── tests (issue #32: PyTorch / ComfyUI install reliability) ────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Download-Anzeige am Rebuilding-Spinner (#162) ───────────────────

    #[test]
    fn pip_download_size_parses_decimal_units() {
        assert_eq!(
            parse_pip_download_size(
                "Downloading torch-2.5.1+cu121-cp311-cp311-win_amd64.whl (2445.5 MB)"
            ),
            Some(2_445_500_000)
        );
        assert_eq!(
            parse_pip_download_size(
                "Downloading https://download.pytorch.org/whl/jinja2-3.1.6-py3-none-any.whl (134 kB)"
            ),
            Some(134_000)
        );
        assert_eq!(
            parse_pip_download_size("Downloading foo-1.0.tar.gz (1.2 GB)"),
            Some(1_200_000_000)
        );
        assert_eq!(
            parse_pip_download_size("Downloading mdurl-0.1.2-py3-none-any.whl.metadata (1.6 kB)"),
            Some(1_600)
        );
    }

    #[test]
    fn pip_download_size_ignores_lines_that_are_no_download() {
        // Negative controls: cache hits and chatter must not inflate the total.
        assert_eq!(
            parse_pip_download_size("Using cached torch-2.5.1-cp311-win_amd64.whl (2445.5 MB)"),
            None
        );
        assert_eq!(parse_pip_download_size("Installing collected packages: torch"), None);
        assert_eq!(parse_pip_download_size("Downloading build artifacts"), None);
        assert_eq!(
            parse_pip_download_size("Collecting torch (from -r requirements.txt (line 10))"),
            None
        );
    }

    // ── is_transient_pip_error ────────────────────────────────────────────

    #[test]
    fn transient_detects_403() {
        assert!(is_transient_pip_error(
            "ERROR: HTTP error 403 while getting https://files.pythonhosted.org/packages/.../torch.whl"
        ));
    }

    #[test]
    fn transient_detects_502() {
        assert!(is_transient_pip_error(
            "WARNING: Retrying after connection broken by 'NewConnectionError: 502 Bad Gateway'"
        ));
    }

    #[test]
    fn transient_detects_503() {
        assert!(is_transient_pip_error(
            "HTTP 503 service unavailable from pypi"
        ));
    }

    #[test]
    fn transient_detects_429_rate_limit() {
        assert!(is_transient_pip_error(
            "ERROR: 429 Too Many Requests"
        ));
    }

    #[test]
    fn transient_detects_ssl_error() {
        assert!(is_transient_pip_error(
            "SSLError(SSLZeroReturnError(...)) caused TLS handshake failure"
        ));
    }

    #[test]
    fn transient_detects_read_timeout() {
        assert!(is_transient_pip_error(
            "ReadTimeoutError(HTTPSConnectionPool(host='pypi.org', port=443): Read timed out.)"
        ));
    }

    #[test]
    fn transient_detects_connect_timeout() {
        assert!(is_transient_pip_error(
            "ConnectTimeoutError reaching pypi.org"
        ));
    }

    #[test]
    fn transient_detects_connection_reset() {
        assert!(is_transient_pip_error(
            "ConnectionResetError(10054, 'An existing connection was forcibly closed by the remote host', None, 10054, None)"
        ));
    }

    #[test]
    fn transient_detects_connection_aborted() {
        assert!(is_transient_pip_error(
            "ConnectionError: ('Connection aborted.', RemoteDisconnected(...))"
        ));
    }

    #[test]
    fn transient_detects_connection_refused() {
        assert!(is_transient_pip_error(
            "ConnectionRefusedError: [Errno 111] Connection refused"
        ));
    }

    #[test]
    fn transient_detects_incomplete_read() {
        assert!(is_transient_pip_error(
            "IncompleteRead(0 bytes read, 1024 more expected)"
        ));
    }

    #[test]
    fn transient_detects_max_retries() {
        assert!(is_transient_pip_error(
            "Max retries exceeded with url: /packages/torch.whl"
        ));
    }

    #[test]
    fn transient_rejects_permission_error() {
        assert!(!is_transient_pip_error(
            "PermissionError: [Errno 13] Permission denied: 'C:\\\\Python\\\\Lib\\\\site-packages\\\\torch'"
        ));
    }

    #[test]
    fn transient_rejects_no_module_error() {
        assert!(!is_transient_pip_error(
            "ModuleNotFoundError: No module named 'pip'"
        ));
    }

    #[test]
    fn transient_rejects_disk_full() {
        assert!(!is_transient_pip_error(
            "OSError: [Errno 28] No space left on device"
        ));
    }

    #[test]
    fn transient_rejects_no_matching_distribution() {
        assert!(!is_transient_pip_error(
            "ERROR: Could not find a version that satisfies the requirement torch (from versions: none)"
        ));
    }

    #[test]
    fn transient_rejects_404_missing_package() {
        // 404 means the file genuinely doesn't exist — retry won't help.
        assert!(!is_transient_pip_error(
            "ERROR: HTTP error 404 while getting nonexistent-package.whl"
        ));
    }

    // ── diagnose_pip_error ────────────────────────────────────────────────

    #[test]
    fn diagnose_ssl_includes_antivirus_hint() {
        let msg = diagnose_pip_error("SSLError(SSLZeroReturnError(...))");
        let lower = msg.to_lowercase();
        assert!(lower.contains("antivirus") || lower.contains("firewall") || lower.contains("clock"));
    }

    #[test]
    fn a_python_without_ssl_is_named_not_blamed_on_antivirus() {
        // numbrain's exact pip wording (Discord 2026-08-02): the interpreter
        // itself has no _ssl, so the antivirus/clock hint is the wrong trail.
        let msg = diagnose_pip_error(
            "WARNING: pip is configured with locations that require TLS/SSL, \
             however the ssl module in Python is not available.",
        );
        let lower = msg.to_lowercase();
        assert!(lower.contains("built without the ssl module"));
        assert!(lower.contains("import ssl"));
        assert!(!lower.contains("antivirus"));
    }

    #[test]
    fn diagnose_403_suggests_vpn() {
        let msg = diagnose_pip_error("HTTP 403 from pytorch.org");
        let lower = msg.to_lowercase();
        assert!(lower.contains("vpn") || lower.contains("network") || lower.contains("blocked"));
    }

    #[test]
    fn diagnose_429_mentions_rate_limit() {
        let msg = diagnose_pip_error("HTTP 429 Too Many Requests");
        assert!(msg.to_lowercase().contains("rate limit"));
    }

    #[test]
    fn diagnose_disk_full_mentions_space() {
        let msg = diagnose_pip_error("OSError: [Errno 28] No space left on device");
        assert!(msg.to_lowercase().contains("disk") || msg.to_lowercase().contains("space"));
    }

    #[test]
    fn diagnose_permission_suggests_close_python() {
        let msg = diagnose_pip_error("PermissionError: [Errno 13] Permission denied");
        let lower = msg.to_lowercase();
        assert!(lower.contains("permission") && (lower.contains("python") || lower.contains("close") || lower.contains("ide")));
    }

    #[test]
    fn diagnose_no_module_suggests_python_reinstall() {
        let msg = diagnose_pip_error("ModuleNotFoundError: No module named 'pip'");
        let lower = msg.to_lowercase();
        assert!(lower.contains("python") && (lower.contains("reinstall") || lower.contains("3.10")));
    }

    #[test]
    fn diagnose_no_matching_version_suggests_python_version() {
        let msg = diagnose_pip_error("ERROR: Could not find a version that satisfies the requirement torch");
        let lower = msg.to_lowercase();
        assert!(lower.contains("python") || lower.contains("version") || lower.contains("3.10"));
    }

    /// willes0504 (Discord 2026-07-28) read "ComfyUI needs Python 3.10, 3.11
    /// or 3.12" while a stray 3.8 sat first in PATH. Naming the interpreter we
    /// actually used is the difference between a riddle and an instruction.
    #[test]
    fn a_version_failure_names_the_interpreter_lu_used() {
        let msg = diagnose_pip_error_for(
            "ERROR: Could not find a version that satisfies the requirement torch (from versions: none)",
            Some("/definitely/not/a/real/python-zzz"),
        );
        assert!(msg.contains("LU used"), "got: {msg}");
        assert!(msg.contains("/definitely/not/a/real/python-zzz"), "got: {msg}");
    }

    #[test]
    fn a_missing_module_failure_also_names_the_interpreter() {
        let msg = diagnose_pip_error_for(
            "ModuleNotFoundError: No module named 'encodings'",
            Some("/definitely/not/a/real/python-zzz"),
        );
        assert!(msg.contains("LU used"), "got: {msg}");
    }

    #[test]
    fn unrelated_failures_do_not_get_an_interpreter_line() {
        // A disk-full or permission problem says nothing about the version.
        let msg = diagnose_pip_error_for(
            "OSError: [Errno 28] No space left on device",
            Some("/definitely/not/a/real/python-zzz"),
        );
        assert!(!msg.contains("LU used"), "got: {msg}");
    }

    #[test]
    fn without_an_interpreter_the_diagnosis_is_unchanged() {
        let stderr = "ERROR: Could not find a version that satisfies the requirement torch";
        assert_eq!(diagnose_pip_error(stderr), diagnose_pip_error_for(stderr, None));
    }

    #[test]
    fn diagnose_unknown_error_falls_through_to_snippet() {
        let raw = "some_completely_random_error_we_haven_t_categorized";
        let msg = diagnose_pip_error(raw);
        assert!(msg.contains(raw));
    }

    #[test]
    fn diagnose_truncates_giant_stderr_to_400_chars_snippet_block() {
        let huge: String = "x".repeat(2000);
        let raw = format!("SSLError: {}", huge);
        let msg = diagnose_pip_error(&raw);
        // Snippet portion is bounded to 400 chars; full message includes hint + label
        // so it should be much shorter than the raw 2000-char input.
        assert!(msg.len() < 1200, "diagnose output was {} chars", msg.len());
    }

    // ── push_install_log ──────────────────────────────────────────────────

    #[test]
    fn push_install_log_appends_to_logs() {
        let state = Arc::new(Mutex::new(InstallState::default()));
        push_install_log(&state, "first");
        push_install_log(&state, "second");
        let s = state.lock().unwrap();
        assert_eq!(s.logs, vec!["first", "second"]);
    }

    #[test]
    fn push_install_log_does_not_clobber_status() {
        let state = Arc::new(Mutex::new(InstallState::default()));
        {
            let mut s = state.lock().unwrap();
            s.status = "installing".to_string();
        }
        push_install_log(&state, "log line");
        let s = state.lock().unwrap();
        assert_eq!(s.status, "installing");
        assert_eq!(s.logs, vec!["log line"]);
    }

    #[test]
    fn diagnose_externally_managed_mentions_venv() {
        let raw = "error: externally-managed-environment\n\
                   × This environment is externally managed\n\
                   ╰─> To install Python packages system-wide, try 'pacman -S python-xyz'";
        let msg = diagnose_pip_error(raw);
        let lower = msg.to_lowercase();
        assert!(
            lower.contains("pep 668") || lower.contains("externally") || lower.contains("venv"),
            "diagnose did not surface PEP 668 context: {}",
            msg
        );
    }

    #[test]
    fn diagnose_externally_managed_includes_distro_install_commands() {
        let raw = "error: externally-managed-environment";
        let msg = diagnose_pip_error(raw);
        let lower = msg.to_lowercase();
        // We want at least one of the platform-specific install commands so
        // the user has something to copy-paste instead of just an error.
        assert!(
            lower.contains("pacman") || lower.contains("apt") || lower.contains("dnf"),
            "diagnose did not include a distro install command: {}",
            msg
        );
    }

    #[test]
    fn diagnose_externally_managed_alt_format_matches() {
        // The exact wording on Arch 2026 is `error: externally-managed`
        // without the `-environment` suffix — make sure the matcher covers
        // both spellings.
        let raw = "error: externally-managed (pip blocked by PEP 668)";
        let msg = diagnose_pip_error(raw);
        let lower = msg.to_lowercase();
        assert!(
            lower.contains("pacman") || lower.contains("apt"),
            "diagnose missed the alt spelling: {}",
            msg
        );
    }

    #[test]
    fn transient_rejects_externally_managed() {
        // PEP 668 errors are deterministic — retrying without venv would
        // just loop forever. Must NOT be classified as transient.
        assert!(!is_transient_pip_error(
            "error: externally-managed-environment"
        ));
    }

}
