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
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::state::InstallState;
use crate::os_error;
use crate::python::python_command;

use super::children::TrackedInstallerChild;
#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

// ── pip helpers (issue #32: PyTorch / ComfyUI install reliability) ───────────

/// Push a log line to the shared install state. Best-effort — silently
/// no-ops if the mutex is poisoned (which only happens if a thread panicked
/// while holding the lock; the install is already broken at that point).
pub(super) fn push_install_log(state: &Arc<Mutex<InstallState>>, msg: &str) {
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
    let mut cmd = python_command(python_bin);
    cmd.arg("--version");
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
pub(super) fn diagnose_pip_error_for(stderr: &str, python_bin: Option<&str>) -> String {
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
    let snippet: String = stderr.chars().take(400).collect();
    let hint = pip_failure_hint(pip_failure_kind(stderr), stderr);

    if hint.is_empty() {
        snippet
    } else {
        format!("{}\n\n--- pip output ---\n{}", hint, snippet)
    }
}

/// The plain form every existing caller uses: the diagnosis only.
pub fn pip_install_streaming_with_retry_cancellable(
    args: &[&str],
    python_bin: &str,
    max_attempts: u32,
    install_state: &Arc<Mutex<InstallState>>,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<(), String> {
    pip_install_streaming_with_retry_raw(args, python_bin, max_attempts, install_state, cancel)
        .map_err(|f| f.diagnosis)
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

/// The Visual C++ runtime files a PyTorch wheel loads and that Windows does
/// not ship on its own. Named rather than guessed: the whole point of the
/// diagnosis is to tell the customer which file Windows went looking for.
/// A3 (falconbob_20415, anglefire, hypocritical_rj, petermanmancusso,
/// jamiet99uk, Discord 2026-08-26 to 2026-09-02): "VCOMP140.DLL was not
/// found" and "[WinError 1114] ... c10.dll" were shown to five customers as
/// a raw crash with no sentence attached.
pub(crate) const VC_RUNTIME_DLLS: &[&str] = &[
    "vcomp140.dll",
    "vcomp140_1.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "msvcp140.dll",
    "msvcp140_1.dll",
    "concrt140.dll",
];

/// Where Microsoft publishes the current x64 redistributable. The page is
/// version free on purpose: linking a numbered installer would pin a version
/// that goes stale the moment Microsoft ships the next one.
pub(crate) const VC_REDIST_PAGE: &str = "https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist";

/// The wording Windows and Python use when a library is not there.
///
/// `winerror` carries the weight on a non English Windows: the bracketed code
/// is not localised, while the sentence after it is. Everything else here is
/// an English phrase and is only ever a second chance.
fn reads_as_missing(lower: &str) -> bool {
    // R1: a file that is THERE and refused, or THERE and locked, is not a file
    // that is absent. `winerror` alone would read both as missing, and pip
    // names the blocked path in the same line: "[WinError 5] Access is denied:
    // '...\\torch\\lib\\msvcp140.dll'". That sent the customer after a
    // redistributable they already have, and it cost them the --user escape,
    // because the permission arm never saw the failure.
    if reads_as_refused(lower) {
        return false;
    }
    lower.contains("winerror")
        || lower.contains("not found")
        || lower.contains("could not be found")
        || lower.contains("error loading")
        || lower.contains("dll load failed")
        || lower.contains("cannot open shared object file")
}

/// A file the process may not write, or may not touch because something else
/// holds it. Both are answered by installing somewhere else, which is what the
/// per user site is for.
fn reads_as_refused(lower: &str) -> bool {
    lower.contains("access is denied")
        || lower.contains("permission denied")
        || lower.contains("winerror 5]")
        || lower.contains("winerror 32]")
        || lower.contains("errno 13")
        || lower.contains("used by another process")
}

/// The Visual C++ runtime file a failure names, when it names one.
///
/// Asked PER LINE, not over the whole log. `torch\lib` ships msvcp140.dll and
/// vcomp140.dll itself, so any log that lists that directory mentions both
/// names; a whole log that also contains the word "missing" somewhere else
/// would otherwise be read as a missing runtime.
pub(crate) fn missing_runtime_library(text: &str) -> Option<&'static str> {
    for raw in text.lines() {
        let line = raw.to_ascii_lowercase();
        let Some(dll) = VC_RUNTIME_DLLS.iter().copied().find(|d| line.contains(d)) else {
            continue;
        };
        if reads_as_missing(&line) {
            return Some(dll);
        }
    }
    None
}

/// What went wrong, decided once and reused. The trainer's setup step reads
/// the same verdict, which is how A2 stage one gets fixed: every failure
/// there was dressed as "check that you are online", including the ones that
/// had nothing to do with the network.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PipFailureKind {
    ExternallyManaged,
    PythonWithoutSsl,
    MissingRuntimeLibrary,
    NativeLoadFailure,
    TorchWithoutGpuSupport,
    Ssl,
    Forbidden,
    RateLimited,
    Timeout,
    Network,
    DiskFull,
    Permission,
    PipBroken,
    NoMatchingWheel,
    Unknown,
}

/// Classify raw pip / interpreter output.
///
/// Order matters twice. The native library arms sit before the broad
/// `contains("connection")` and permission arms, because a Windows DLL message
/// carries words those would otherwise swallow. And the disk and PEP 668 arms
/// sit before the native ones, because a rollback on a full drive prints a
/// `Moving to ...torch\lib\....dll` line for every file it moves.
pub(crate) fn pip_failure_kind(text: &str) -> PipFailureKind {
    let lower = text.to_lowercase();
    if lower.contains("externally-managed-environment") || lower.contains("error: externally-managed") {
        PipFailureKind::ExternallyManaged
    } else if lower.contains("ssl module in python is not available") {
        PipFailureKind::PythonWithoutSsl
    // Before the native arms: a full disk rolls torch back file by file, and
    // every one of those lines names a DLL under torch\lib.
    } else if lower.contains("no space") || lower.contains("errno 28") {
        PipFailureKind::DiskFull
    // R1, and for the same reason as the disk arm above it: pip names the
    // blocked file in the message, and under Program Files that file is
    // regularly one of the runtime DLLs torch ships.
    } else if is_permission_denied_pip_error(text) {
        PipFailureKind::Permission
    } else if missing_runtime_library(text).is_some() {
        PipFailureKind::MissingRuntimeLibrary
    } else if lower.contains("winerror 1114")
        || lower.contains("winerror 126")
        || lower.contains("winerror 127")
        || lower.contains("dll load failed")
        || lower.contains("initialization routine failed")
        || lower.contains("0xc0000005")
        || lower.contains("exception_access_violation")
    {
        PipFailureKind::NativeLoadFailure
    } else if lower.contains("torch not compiled with cuda enabled")
        || lower.contains("no kernel image is available")
    {
        PipFailureKind::TorchWithoutGpuSupport
    } else if lower.contains("ssl") {
        PipFailureKind::Ssl
    } else if lower.contains("403 ") {
        PipFailureKind::Forbidden
    } else if lower.contains("429 ") {
        PipFailureKind::RateLimited
    } else if lower.contains("timeout") || lower.contains("timed out") {
        PipFailureKind::Timeout
    } else if lower.contains("connection") {
        PipFailureKind::Network
    } else if lower.contains("no module named") || lower.contains("modulenotfounderror") {
        PipFailureKind::PipBroken
    } else if lower.contains("could not find a version") {
        PipFailureKind::NoMatchingWheel
    } else {
        PipFailureKind::Unknown
    }
}

/// The sentence that belongs to a verdict. Empty for `Unknown`, where the
/// caller falls back to quoting the log.
pub(crate) fn pip_failure_hint(kind: PipFailureKind, text: &str) -> String {
    match kind {
        PipFailureKind::ExternallyManaged =>
            "Your Python is PEP 668 protected (Arch Linux, Debian 12+, Fedora 38+, \
             Ubuntu 23.04+ block system-wide pip installs by default). LU should have \
             created a venv inside the ComfyUI folder automatically. If you see this \
             error, the venv module is missing. Install it and retry:\n\
             • Arch:   sudo pacman -S python-virtualenv\n\
             • Debian/Ubuntu: sudo apt install python3-venv\n\
             • Fedora: sudo dnf install python3-virtualenv".to_string(),
        // numbrain (Discord, 2026-08-02): a pyenv/source-built python without
        // the _ssl extension can't reach pypi AT ALL, and the generic SSL hint
        // below (antivirus/clock) sent him in the wrong direction.
        PipFailureKind::PythonWithoutSsl =>
            "This Python was built without the ssl module, so pip cannot reach \
             pypi.org at all. Use your distro's regular python3 (it ships with \
             ssl): check with  python3 -c \"import ssl\". If that fails, \
             reinstall python3 via your package manager (pyenv builds need the \
             OpenSSL headers installed first, e.g. libssl-dev / openssl-devel), \
             then retry.".to_string(),
        // Ticket 007: beide Saetze endeten auf "then press Repair environment"
        // und widersprachen sich damit selbst, der erste sogar im selben Absatz
        // ("nothing pip does can fix this"). Ein Neubau des venv holt dieselben
        // Wheels an dieselbe Stelle; was fehlt, wohnt in Windows. falcon bob hat
        // die Reparatur gedrueckt, den Neubau abgewartet und stand vor derselben
        // Meldung. Der Satz sagt jetzt, was wirklich hilft.
        PipFailureKind::MissingRuntimeLibrary => {
            let dll = missing_runtime_library(text).unwrap_or("VCOMP140.DLL").to_uppercase();
            format!(
                "A Microsoft Visual C++ runtime library is missing on this machine: {dll}. \
                 PyTorch loads it at import time and Windows does not install it on its own, \
                 so nothing pip does can fix this. Install the current Visual C++ \
                 Redistributable for x64 from {VC_REDIST_PAGE}, restart Windows, then start \
                 ComfyUI again. Repair environment does not help here: the missing library \
                 belongs to Windows, not to the ComfyUI folder."
            )
        }
        PipFailureKind::NativeLoadFailure => format!(
            "PyTorch is on disk but its native libraries will not load on this machine. \
             Two things cause that, in this order: the Microsoft Visual C++ Redistributable \
             for x64 is missing or out of date (install the current one from {VC_REDIST_PAGE} \
             and restart Windows), or the GPU driver is older than the CUDA build that was \
             installed (update the graphics driver). Do both, then start ComfyUI again. \
             Repair environment does not help here: it rebuilds the folder, and both of \
             these live outside it."
        ),
        PipFailureKind::TorchWithoutGpuSupport =>
            "The PyTorch in this environment carries no support for the card in this machine, \
             so it can only run on the processor. Press Repair environment: the rebuild probes \
             the card again and picks the matching wheels.".to_string(),
        PipFailureKind::Ssl =>
            "SSL error reaching pypi.org. Often caused by an antivirus / firewall \
             intercepting TLS, or a stale system clock. Disable TLS interception \
             for python.exe, fix the system clock, then retry.".to_string(),
        PipFailureKind::Forbidden =>
            "HTTP 403 from pypi.org or pytorch.org. The mirror may be blocked on \
             your network. Try a different network or VPN, then retry.".to_string(),
        PipFailureKind::RateLimited => "Rate limited (HTTP 429). Wait a few minutes and retry.".to_string(),
        PipFailureKind::Timeout =>
            "Network timeout. Slow connection or congested mirror. Retry on a \
             faster network, or run the install during off-peak hours.".to_string(),
        PipFailureKind::Network =>
            "Connection error. Check internet connectivity, restart the app, \
             and retry.".to_string(),
        PipFailureKind::DiskFull =>
            "Out of disk space. PyTorch + dependencies need ~5 GB free. Free up \
             space and retry.".to_string(),
        PipFailureKind::Permission =>
            "Permission denied. Make sure no other process is using Python, then \
             retry. On Windows: close any open Python REPLs / Jupyter / IDE \
             debuggers.".to_string(),
        PipFailureKind::PipBroken =>
            "Python install is missing pip or is broken. Reinstall Python 3.10+ \
             from python.org with 'Add to PATH' checked.".to_string(),
        PipFailureKind::NoMatchingWheel =>
            "No matching wheel for your Python version. ComfyUI needs Python \
             3.10, 3.11, or 3.12. Reinstall a supported Python version.".to_string(),
        PipFailureKind::Unknown => String::new(),
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
/// A pip run that failed: the sentence for the customer, and the raw stderr
/// behind it.
///
/// The two are not interchangeable. `diagnosis` carries a hint plus the FIRST
/// 400 characters of the log, so a decision taken on it (retry into the user
/// site, say) is taken on a string that may have cut the deciding line off.
pub(crate) struct PipFailure {
    pub(crate) diagnosis: String,
    pub(crate) stderr: String,
    /// How far the run got. A15 review: this used to be inferred from an empty
    /// `stderr`, which is true for a spawn that failed and equally true for a
    /// pip that ran, printed nothing and exited non-zero, and for a `try_wait`
    /// that failed on a live process. Two of those three were then reported as
    /// "pip could not be started", which is a lie the log cannot correct.
    pub(crate) stage: PipStage,
}

/// How far a failed pip run got before it failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PipStage {
    /// No process. The spawn failed, or the cancel arrived before pip was ever
    /// asked to start.
    NotStarted,
    /// pip was a live process. It may have exited non-zero, printed nothing, or
    /// refused to be reaped, but it ran.
    Ran,
}

impl PipFailure {
    /// A failure with no pip log behind it. The stage says whether that is
    /// because pip never started or because it left nothing behind.
    fn bare(stage: PipStage, diagnosis: &str) -> Self {
        PipFailure { diagnosis: diagnosis.to_string(), stderr: String::new(), stage }
    }
}

pub(crate) fn pip_install_streaming_with_retry_raw(
    args: &[&str],
    python_bin: &str,
    max_attempts: u32,
    install_state: &Arc<Mutex<InstallState>>,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<(), PipFailure> {
    let mut delay_seconds = 10u64;
    let mut last_stderr = String::new();

    for attempt in 1..=max_attempts {
        if cancel.as_ref().map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
            return Err(PipFailure::bare(PipStage::NotStarted, "cancelled"));
        }
        if attempt > 1 {
            push_install_log(
                install_state,
                &format!(
                    "Transient network error, retry {}/{} after {}s wait...",
                    attempt, max_attempts, delay_seconds
                ),
            );
            // Sleep in 1-second chunks so cancel reacts within ~1s.
            for _ in 0..delay_seconds {
                if cancel.as_ref().map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
                    return Err(PipFailure::bare(PipStage::NotStarted, "cancelled"));
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

        let mut cmd = python_command(python_bin);
        cmd.args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                return Err(PipFailure::bare(
                    PipStage::NotStarted,
                    &format!(
                        "Could not start pip ({}). Is Python on PATH?",
                        os_error::english(&e)
                    ),
                ))
            }
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
                return Err(PipFailure::bare(PipStage::Ran, "cancelled"));
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
                Err(e) => {
                    return Err(PipFailure::bare(
                        PipStage::Ran,
                        &format!("pip wait failed: {}", os_error::english(&e)),
                    ))
                }
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
            return Err(PipFailure {
                diagnosis: diagnose_pip_error_for(&last_stderr, Some(python_bin)),
                stderr: last_stderr,
                stage: PipStage::Ran,
            });
        }
    }

    Err(PipFailure {
        diagnosis: format!(
            "Exhausted {} retry attempts for transient network errors.\n\n{}",
            max_attempts,
            diagnose_pip_error_for(&last_stderr, Some(python_bin))
        ),
        stderr: last_stderr,
        stage: PipStage::Ran,
    })
}

/// Why a requirements.txt could not be installed, in a few words.
///
/// A15, Windows Nachlauf 02.09.: a requirements.txt whose first line named a
/// package that does not exist made `pip install -r` fail, the run went on with
/// LU's own package list, and it ended on "Environment repaired" with nothing
/// said. The fallback itself is right, because a core whose file will not
/// resolve must not block a rebuild. The silence is not: the user is left with
/// a ComfyUI missing whatever that file asked for on top of our list.
pub(crate) fn requirements_failure_reason(pip_output: &str) -> &'static str {
    match pip_failure_kind(pip_output) {
        PipFailureKind::NoMatchingWheel => "pip found no installable version for a package it names",
        PipFailureKind::Network
        | PipFailureKind::Timeout
        | PipFailureKind::Ssl
        | PipFailureKind::Forbidden
        | PipFailureKind::RateLimited => "pip could not reach the package index",
        PipFailureKind::Permission => "pip was not allowed to write the packages",
        PipFailureKind::DiskFull => "the disk ran out of space",
        PipFailureKind::ExternallyManaged => "this Python refuses installs outside a venv",
        PipFailureKind::PipBroken | PipFailureKind::PythonWithoutSsl => {
            "pip in this environment is not usable"
        }
        PipFailureKind::MissingRuntimeLibrary
        | PipFailureKind::NativeLoadFailure
        | PipFailureKind::TorchWithoutGpuSupport => {
            "a package in it will not load on this machine"
        }
        PipFailureKind::Unknown => "pip exited with an error",
    }
}

/// The same question asked of a whole pip failure rather than of its text.
///
/// The stage decides, not the emptiness of the log. A pip that never started
/// says so; a pip that ran is judged on what it printed, and a run that printed
/// nothing at all still exited with an error rather than failing to start.
pub(crate) fn requirements_failure_reason_for(f: &PipFailure) -> &'static str {
    match f.stage {
        PipStage::NotStarted => "pip could not be started",
        // It ran. Whatever it left behind is what decides, and a run that left
        // nothing behind still exited with an error.
        PipStage::Ran => requirements_failure_reason(&f.stderr),
    }
}

/// Whether a failed pip run should be tried again into the per user site.
///
/// Two conditions, and both matter. A venv REFUSES `--user` ("Can not perform
/// a '--user' install"), so retrying there swaps one failure for another. And
/// only a refused write is worth retrying at all: a network failure would just
/// fail again, twice as slowly.
pub(crate) fn should_retry_in_user_site(in_venv: bool, stderr: &str) -> bool {
    !in_venv && pip_failure_kind(stderr) == PipFailureKind::Permission
}

/// True iff a failed pip run died on filesystem permissions (admin-only
/// site-packages, e.g. python.org installs under Program Files on Windows).
/// Those are fixable by re-running the same install with `--user`.
pub(super) fn is_permission_denied_pip_error(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("permission denied")
        || lower.contains("errno 13")
        || lower.contains("access is denied")
        || lower.contains("winerror 5")
        // A DLL another process still holds open is the same dead end with a
        // different code, and it has the same way out: install into the per
        // user site instead of into the one that is locked.
        || lower.contains("winerror 32]")
        || lower.contains("used by another process")
}

/// Die exakte pip-Ausgabe der Gegenprobe: ein erfundenes Paket auf Zeile 1
/// von ComfyUIs requirements.txt. Zwei Testmodule prüfen gegen genau diesen
/// Text, deshalb steht er einmal hier und nicht zweimal.
#[cfg(test)]
pub(super) const INVENTED_PACKAGE: &str = "ERROR: Could not find a version that satisfies the \
    requirement lu-gegenprobe-gibt-es-nicht-4711==9.9.9 (from versions: none)\n\
    ERROR: No matching distribution found for lu-gegenprobe-gibt-es-nicht-4711==9.9.9";

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::comfy_job::requirements_fallback_log;

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

    /// A pip that never started is not a pip that exited with an error.
    #[test]
    fn a_pip_that_never_ran_is_not_reported_as_a_pip_that_failed() {
        let never_ran = PipFailure::bare(
            PipStage::NotStarted,
            "Could not start pip (not found). Is Python on PATH?",
        );
        assert_eq!(requirements_failure_reason_for(&never_ran), "pip could not be started");
        // Negative control: a real pip failure keeps its own classification and
        // does not fall into the "could not be started" arm.
        let really_failed = PipFailure {
            diagnosis: "whatever the hint says".to_string(),
            stderr: INVENTED_PACKAGE.to_string(),
            stage: PipStage::Ran,
        };
        assert_eq!(
            requirements_failure_reason_for(&really_failed),
            "pip found no installable version for a package it names"
        );
    }

    /// The two cases the empty-stderr shortcut used to get wrong. Both are a
    /// pip that RAN, so neither may claim it could not be started.
    #[test]
    fn a_pip_that_ran_is_never_reported_as_one_that_could_not_start() {
        // The reaping failed on a live child. pip was there.
        let wait_failed = PipFailure::bare(PipStage::Ran, "pip wait failed: interrupted");
        assert_eq!(requirements_failure_reason_for(&wait_failed), "pip exited with an error");
        // And a silent non-zero exit: it ran, it failed, it printed nothing.
        let silent = PipFailure {
            diagnosis: String::new(),
            stderr: String::new(),
            stage: PipStage::Ran,
        };
        assert_eq!(requirements_failure_reason_for(&silent), "pip exited with an error");
    }

    #[test]
    fn a_missing_visual_cpp_runtime_is_named_and_not_read_as_a_network_fault() {
        let text = "ImportError: VCOMP140.DLL was not found. Error loading \"C:\\ComfyUI\\venv\\Lib\\site-packages\\torch\\lib\\c10.dll\"";
        assert_eq!(pip_failure_kind(text), PipFailureKind::MissingRuntimeLibrary);
        assert_eq!(missing_runtime_library(text), Some("vcomp140.dll"));
        let hint = pip_failure_hint(PipFailureKind::MissingRuntimeLibrary, text);
        assert!(hint.contains("VCOMP140.DLL"), "the file is not named: {hint}");
        assert!(hint.contains(VC_REDIST_PAGE), "no way to get the runtime: {hint}");
        // The page is deliberately the version free one: a numbered installer
        // link goes stale the moment Microsoft ships the next build.
        assert!(!hint.contains("vc_redist"), "pins a numbered installer: {hint}");
        assert!(!hint.to_lowercase().contains("online"), "still blames the network: {hint}");
    }

    #[test]
    fn a_dll_that_is_only_mentioned_is_not_a_missing_runtime() {
        // Negative control: torch\lib SHIPS msvcp140.dll and vcomp140.dll, so
        // any log that lists that directory names them. Asking the whole log
        // whether it also contains the word "missing" somewhere turned every
        // such log into a redistributable problem.
        let text = "Collecting torch\n\
                    Installing collected packages: torch\n\
                    Copying torch\\lib\\msvcp140.dll\n\
                    ERROR: some other package is missing a build backend";
        assert_eq!(missing_runtime_library(text), None, "read the wrong line");
        assert_ne!(pip_failure_kind(text), PipFailureKind::MissingRuntimeLibrary);
    }

    #[test]
    fn a_rollback_on_a_full_drive_is_a_disk_failure_not_a_dll_failure() {
        // The exact shape measured on the box on 2026-08-15: pip moves every
        // file aside before it replaces it, and each of those lines names a
        // DLL under torch\lib. The disk arm has to be asked first.
        let mut log = String::from(
            "ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device\n",
        );
        for name in ["msvcp140.dll", "vcomp140.dll", "c10.dll"] {
            log.push_str(&format!("Moving to c:\\comfyui\\venv\\lib\\site-packages\\torch\\lib\\{name}\n"));
        }
        assert_eq!(pip_failure_kind(&log), PipFailureKind::DiskFull, "{log}");
    }

    #[test]
    fn winerror_1114_reads_as_a_native_load_failure_not_a_connection_error() {
        let text = "OSError: [WinError 1114] A dynamic link library (DLL) initialization routine failed. Error loading \"c10.dll\" or one of its dependencies.";
        assert_eq!(pip_failure_kind(text), PipFailureKind::NativeLoadFailure);
        let hint = pip_failure_hint(PipFailureKind::NativeLoadFailure, text);
        assert!(hint.contains(VC_REDIST_PAGE), "{hint}");
        assert!(hint.to_lowercase().contains("driver"), "the second cause is unnamed: {hint}");
    }

    #[test]
    fn a_dll_line_in_another_language_is_still_recognised() {
        // The bracketed WinError code is not localised; the sentence after it
        // is. A German Windows says "Eine DLL-Initialisierungsroutine ist
        // fehlgeschlagen", which contains not one English word we matched on.
        let text = "OSError: [WinError 126] Das angegebene Modul wurde nicht gefunden. VCOMP140.DLL";
        assert_eq!(missing_runtime_library(text), Some("vcomp140.dll"), "{text}");
        let text2 = "OSError: [WinError 1114] Eine DLL-Initialisierungsroutine ist fehlgeschlagen.";
        assert_eq!(pip_failure_kind(text2), PipFailureKind::NativeLoadFailure);
    }

    #[test]
    fn an_access_violation_is_a_native_load_failure() {
        assert_eq!(
            pip_failure_kind("Process exited with code 0xC0000005"),
            PipFailureKind::NativeLoadFailure
        );
    }

    #[test]
    fn a_torch_without_kernels_for_this_card_points_at_repair_not_at_the_network() {
        let text = "AssertionError: Torch not compiled with CUDA enabled";
        assert_eq!(pip_failure_kind(text), PipFailureKind::TorchWithoutGpuSupport);
        let hint = pip_failure_hint(PipFailureKind::TorchWithoutGpuSupport, text);
        assert!(hint.contains("Repair environment"), "{hint}");
    }

    #[test]
    fn the_windows_wordings_for_a_refused_write_count_as_permission() {
        // python.org under Program Files answers with these, and neither one
        // contains the word permission. The custom node path has known them
        // since 2026-07-19; the classifier did not, so the ComfyUI
        // requirements step never took the --user escape.
        for text in [
            "ERROR: Could not install packages due to an OSError: [WinError 5] Access is denied: 'C:\\Program Files\\Python312\\Lib\\site-packages\\yaml'",
            "ERROR: Access is denied",
            "PermissionError: [Errno 13] Permission denied",
        ] {
            assert_eq!(pip_failure_kind(text), PipFailureKind::Permission, "{text}");
        }
        // Negative control: a plain HTTP failure must not become a permission
        // problem just because pip mentions access somewhere.
        assert_eq!(
            pip_failure_kind("ERROR: 403 Forbidden from pypi.org "),
            PipFailureKind::Forbidden
        );
    }

    #[test]
    fn a_runtime_dll_that_is_blocked_is_a_permission_failure_not_a_missing_file() {
        // R1. pip names the file it could not write, and under Program Files
        // that file is regularly one of the DLLs torch ships. Reading those
        // two lines as a missing runtime sent the customer after a
        // redistributable they already have AND cost them the --user escape,
        // because should_retry_in_user_site never saw a permission failure.
        for line in [
            "ERROR: Could not install packages due to an OSError: [WinError 5] Access is denied: 'C:\\Program Files\\Python312\\Lib\\site-packages\\torch\\lib\\msvcp140.dll'",
            "ERROR: Could not install packages due to an OSError: [WinError 32] The process cannot access the file because it is being used by another process: 'C:\\Program Files\\Python312\\Lib\\site-packages\\torch\\lib\\vcomp140.dll'",
        ] {
            assert_eq!(pip_failure_kind(line), PipFailureKind::Permission, "{line}");
            assert_eq!(missing_runtime_library(line), None, "read a blocked file as an absent one: {line}");
            assert!(should_retry_in_user_site(false, line), "the escape is lost: {line}");
            let hint = pip_failure_hint(pip_failure_kind(line), line);
            assert!(!hint.contains(VC_REDIST_PAGE), "still sends them to microsoft.com: {hint}");
        }
    }

    #[test]
    fn a_runtime_dll_that_is_really_absent_is_still_a_missing_file() {
        // Negative control for the arm above: the genuine case must not be
        // swept into the permission arm along with it.
        let line = "OSError: [WinError 126] The specified module could not be found. Error loading \"vcomp140.dll\"";
        assert_eq!(pip_failure_kind(line), PipFailureKind::MissingRuntimeLibrary, "{line}");
        assert_eq!(missing_runtime_library(line), Some("vcomp140.dll"));
        assert!(!should_retry_in_user_site(false, line), "a --user retry cannot install a runtime");
        assert!(pip_failure_hint(pip_failure_kind(line), line).contains(VC_REDIST_PAGE));
    }

    #[test]
    fn the_old_verdicts_still_come_out_of_the_new_classifier() {
        // The rewrite must not move any existing case: these are the arms the
        // shipped diagnoses were built on.
        for (text, kind) in [
            ("error: externally-managed-environment", PipFailureKind::ExternallyManaged),
            ("the ssl module in Python is not available", PipFailureKind::PythonWithoutSsl),
            ("SSLError: certificate verify failed", PipFailureKind::Ssl),
            ("ERROR: 403 Forbidden ", PipFailureKind::Forbidden),
            ("ERROR: 429 Too Many Requests ", PipFailureKind::RateLimited),
            ("ReadTimeoutError: read timed out", PipFailureKind::Timeout),
            ("ConnectionResetError: connection reset by peer", PipFailureKind::Network),
            ("OSError: [Errno 28] No space left on device", PipFailureKind::DiskFull),
            ("PermissionError: [Errno 13] Permission denied", PipFailureKind::Permission),
            ("No module named pip", PipFailureKind::PipBroken),
            ("ERROR: Could not find a version that satisfies", PipFailureKind::NoMatchingWheel),
            ("something nobody has seen before", PipFailureKind::Unknown),
        ] {
            assert_eq!(pip_failure_kind(text), kind, "wrong verdict for {text:?}");
        }
    }


    #[test]
    fn a_requirements_file_pip_cannot_resolve_is_named_with_its_reason() {
        let reason = requirements_failure_reason(INVENTED_PACKAGE);
        assert_eq!(reason, "pip found no installable version for a package it names");
        let line = requirements_fallback_log("C:\\Users\\ddrob\\ComfyUI", reason);
        assert!(line.starts_with("requirements.txt in C:\\Users\\ddrob\\ComfyUI could not be used ("), "got: {line}");
        assert!(line.ends_with("installing LU's own package list instead."), "got: {line}");
        assert!(line.contains(reason), "got: {line}");
    }

    /// Every pip failure gets a reason, and none of them reads as a sentence
    /// fragment inside "could not be used (...)".
    #[test]
    fn every_pip_failure_has_a_short_lowercase_reason() {
        for output in [
            INVENTED_PACKAGE,
            "ERROR: Connection broken: ConnectionResetError",
            "ERROR: Could not install packages due to an OSError: [Errno 13] Permission denied",
            "OSError: [Errno 28] No space left on device",
            "error: externally-managed-environment",
            "read timed out",
            "",
        ] {
            let r = requirements_failure_reason(output);
            assert!(!r.is_empty());
            assert!(r.chars().next().unwrap().is_lowercase(), "capitalised: {r}");
            assert!(!r.ends_with('.'), "the reason carries its own full stop: {r}");
        }
    }

    #[test]
    fn permission_predicate_matches_windows_and_unix_denials() {
        assert!(is_permission_denied_pip_error(
            "ERROR: Could not install packages due to an OSError: [Errno 13] Permission denied: 'C:\\\\Program Files\\\\Python311\\\\Lib\\\\site-packages\\\\onnxruntime'"
        ));
        assert!(is_permission_denied_pip_error(
            "PermissionError: [WinError 5] Access is denied"
        ));
        assert!(is_permission_denied_pip_error("EACCES: permission denied"));
    }

    #[test]
    fn permission_predicate_rejects_other_pip_failures() {
        assert!(!is_permission_denied_pip_error(
            "error: externally-managed-environment"
        ));
        assert!(!is_permission_denied_pip_error(
            "ReadTimeoutError: HTTPSConnectionPool(host='pypi.org')"
        ));
        assert!(!is_permission_denied_pip_error(
            "ERROR: Could not find a version that satisfies the requirement onnxruntime-gpu"
        ));
    }

}
