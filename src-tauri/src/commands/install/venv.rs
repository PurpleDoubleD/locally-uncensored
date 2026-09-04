//! Der Python, in den LU installiert, und was sonst noch darin wohnt.
//!
//! Der geteilte Zustand ist ein Verzeichnis auf der Platte: `ComfyUI/venv`.
//! `resolve_lu_python` zeigt darauf, `create_comfyui_venv` legt es an,
//! `venv_site_packages` findet seine `site-packages` in beiden
//! Plattform-Layouts, und `detect_venv_passengers` liest ab, welche
//! LU-eigenen Pakete darin liegen, die ComfyUI nicht gehören.
//!
//! Genau diese Mitfahrer sind der Grund für die Naht. faster-whisper und
//! Piper landen in ComfyUIs venv, weil das "LUs Python" ist; die Reparatur
//! löscht dieses venv im Ganzen. Wer eines von beidem ändert, muss das
//! andere vor Augen haben — also stehen sie in einer Datei. `is_pep668_protected`
//! gehört dazu, weil es die Frage beantwortet, ob überhaupt ein venv nötig
//! ist: auf einer PEP-668-Distribution ist es der einzige Weg, überhaupt zu
//! installieren.

use std::io::Read;
use std::path::{Path, PathBuf};
use crate::python::python_command;
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tracing::warn;

use super::children::{wait_or_cancel, TrackedInstallerChild};
use crate::os_error;
use crate::python::venv_python_path;
use crate::state::AppState;


// ── PEP 668 / venv helpers (Bug E — rzgrozt Arch externally-managed) ─────────

/// True iff the Python pointed to by `python_bin` is PEP 668 protected
/// (Arch Linux, Debian 12+, Fedora 38+, Ubuntu 23.04+ ship Python with an
/// `EXTERNALLY-MANAGED` marker file in the stdlib dir, which makes
/// `python -m pip install ...` exit with
/// `error: externally-managed-environment` unless `--break-system-packages`
/// is passed). We probe by asking Python itself whether the marker exists
/// — robust against distro-specific path layouts and avoids parsing locale
/// dependent pip error strings.
///
/// Returns `false` on any probe error (Python missing, sysconfig broken,
/// stdout unparseable). That is the safe default: a false negative just
/// means we install without a venv exactly like LU did before this bug,
/// which is fine on every distro that *isn't* PEP 668 protected.
pub fn is_pep668_protected(python_bin: &str) -> bool {
    if python_bin.is_empty() {
        return false;
    }
    let mut cmd = python_command(python_bin);
    cmd.args([
        "-c",
        "import os, sysconfig; \
         d = sysconfig.get_path('stdlib'); \
         print('YES' if os.path.exists(os.path.join(d, 'EXTERNALLY-MANAGED')) else 'NO')",
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let Ok(out) = cmd.output() else { return false };
    if !out.status.success() {
        return false;
    }
    String::from_utf8_lossy(&out.stdout).trim() == "YES"
}

/// Create a venv inside `comfyui_dir/venv` using the system `python_bin`.
/// Returns the path to the venv's Python interpreter on success. On Arch
/// boxes that haven't installed the `python-virtualenv` package this can
/// fail with `No module named venv`, and we surface that with an actionable
/// hint pointing at the right pacman / apt invocation.
///
/// `cancel` is read every 200 ms while the child runs, and it has to be:
/// `python -m venv` pulls `ensurepip` in, which is tens of seconds on Windows.
/// P3 (04.09.): cancelling a repair took 76 seconds, and part of that was this
/// call being sat out to the end because it was a single blocking `output()`.
///
/// On a cancel the half-built venv is deleted again before `Err("cancelled")`
/// goes back. `resolve_comfyui_venv_python` asks only whether the interpreter
/// file exists, and `python -m venv` writes that file BEFORE it runs
/// `ensurepip`, so leaving the ruin behind would have autostart launching
/// ComfyUI out of an env with an empty site-packages.
pub fn create_comfyui_venv(
    comfyui_dir: &Path,
    python_bin: &str,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<PathBuf, String> {
    let venv_dir = comfyui_dir.join("venv");
    // venv is idempotent: re-running on an existing dir just no-ops, but be
    // explicit so the log reads cleanly.
    let already_existed = venv_dir.exists() && venv_python_path(comfyui_dir).exists();
    if already_existed {
        return Ok(venv_python_path(comfyui_dir));
    }

    let mut cmd = python_command(python_bin);
    cmd.args(["-m", "venv", venv_dir.to_string_lossy().as_ref()])
        // Only stderr is ever read. stdout went into a buffer nobody looked at
        // even before this, and an unread pipe is one more way to block while
        // we are supposed to be polling the cancel flag.
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not spawn `python -m venv`: {}", os_error::english(&e)))?;
    // Same registry every other installer child joins, so closing the app
    // mid-build does not leave venv and ensurepip resident.
    let _tracked = TrackedInstallerChild::register(child.id());

    // Drained next to the wait, not after it: a full pipe would stall the
    // child while the loop below thinks it is still working.
    let stderr_pipe = child.stderr.take();
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    let sink = stderr_buf.clone();
    let reader = std::thread::spawn(move || {
        if let Some(mut pipe) = stderr_pipe {
            let mut text = String::new();
            let _ = pipe.read_to_string(&mut text);
            if let Ok(mut slot) = sink.lock() {
                *slot = text;
            }
        }
    });

    let waited = wait_or_cancel(&mut child, cancel, "`python -m venv`");
    let _ = reader.join();
    let stderr = stderr_buf.lock().map(|b| b.clone()).unwrap_or_default();

    let exit_status = match waited {
        Ok(s) => s,
        Err(e) if e == "cancelled" => {
            let _ = std::fs::remove_dir_all(&venv_dir);
            return Err(e);
        }
        Err(e) => return Err(e),
    };

    if !exit_status.success() {
        let lower = stderr.to_lowercase();
        // Most common Arch / minimal-Python failure: stdlib venv module
        // isn't available because the distro packages it separately.
        if lower.contains("no module named venv") || lower.contains("ensurepip") {
            return Err(format!(
                "Python's `venv` module is not available. Install it first:\n\
                 • Arch:   sudo pacman -S python-virtualenv\n\
                 • Debian/Ubuntu: sudo apt install python3-venv\n\
                 • Fedora: sudo dnf install python3-virtualenv\n\
                 Then retry the ComfyUI install.\n\n--- python output ---\n{}",
                stderr.chars().take(400).collect::<String>()
            ));
        }
        return Err(format!(
            "venv creation failed: {}",
            stderr.chars().take(400).collect::<String>()
        ));
    }

    let venv_py = venv_python_path(comfyui_dir);
    if !venv_py.exists() {
        return Err(format!(
            "venv was created at {} but no Python binary appeared at {}. \
             This usually means the venv module is broken — try `sudo pacman -S python-virtualenv` (Arch) or the equivalent on your distro.",
            venv_dir.display(),
            venv_py.display()
        ));
    }
    Ok(venv_py)
}

// ── P3 (04.09.): the old venv is moved out of the way, not deleted in line ──

/// The prefix every set-aside venv carries.
///
/// It starts with `venv` on purpose so it sorts next to the real one for
/// anybody reading the folder, and it is NOT `venv` or `.venv`, which is the
/// whole point: `python.rs::resolve_comfyui_venv_python` looks at exactly
/// those two names, so a retired folder is invisible to the launcher, to
/// autostart and to `resolve_lu_python`.
pub(crate) const RETIRED_VENV_PREFIX: &str = "venv.lu-old-";

/// Move `<comfy>/venv` out of the way and answer where it went.
///
/// Deleting it in line was the 76 seconds P3 measured: a venv holding PyTorch
/// is tens of thousands of files, `remove_dir_all` walks all of them in one
/// blocking call, and the cancel flag cannot be read inside it. The new name
/// is a sibling in the same parent, so it is on the same drive, so this is one
/// metadata operation no matter how much is inside. The deleting happens
/// afterwards on a worker thread, and the caller is free again the moment this
/// returns.
///
/// Nanoseconds plus our own process id in the name, so two runs never land on
/// the same folder.
pub(crate) fn retire_venv(venv_dir: &Path) -> std::io::Result<PathBuf> {
    let parent = venv_dir.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the venv path has no parent directory to move it into",
        )
    })?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let retired = parent.join(format!(
        "{}{}-{}",
        RETIRED_VENV_PREFIX,
        stamp,
        std::process::id()
    ));
    std::fs::rename(venv_dir, &retired)?;
    Ok(retired)
}

/// Delete whatever [`retire_venv`] left lying around.
///
/// Quietly, over tracing only: these are folders nobody is looking for, and a
/// failure to clear one must not colour a repair the user is watching. Every
/// repair runs it on the same worker that deletes its own retired folder, and
/// after that one, so an app that died between a rename and the end of its
/// delete does not keep the space forever and two deleters never meet on the
/// same tree.
///
/// Only names carrying [`RETIRED_VENV_PREFIX`] are touched. This runs inside
/// the user's ComfyUI folder, next to models, outputs and custom nodes, so the
/// match being too eager is the one way this could destroy something.
pub(crate) fn sweep_retired_venvs(comfy_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(comfy_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let retired = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with(RETIRED_VENV_PREFIX));
        if !retired || !path.is_dir() {
            continue;
        }
        if let Err(e) = std::fs::remove_dir_all(&path) {
            warn!(error = %e, folder = %path.display(), "a retired venv could not be swept");
        }
    }
}

// ── OI-3: the repair must not silently uninstall Voice ──────────────────────

/// A package LU installs into the ComfyUI venv that is NOT ComfyUI's.
///
/// `resolve_lu_python` sends faster-whisper (STT) and Piper (TTS) into
/// `ComfyUI/venv` whenever one exists, because that is "LU's Python". The
/// repair then deletes that venv wholesale and rebuilds it with PyTorch and
/// ComfyUI's requirements — and nothing else. Two features the user paid
/// bandwidth for disappear as a side effect of a repair they did not ask for
/// (the Create tab fires `repair_comfyui_env` automatically after a ComfyUI
/// startup crash), with not one log line connecting the two. What the user
/// experiences is "Voice just stopped".
///
/// Keeping them out of the venv was the other option and it is worse: LU
/// would have to maintain a second interpreter, and the TTS synthesizer and
/// whisper server both start with whatever `resolve_lu_python` returns, so
/// they would then be started from an env they were not installed into. The
/// venv stays the one Python; the repair takes responsibility for refilling it.
pub(crate) struct VenvPassenger {
    /// The import-name directory as it appears inside `site-packages`.
    pub marker: &'static str,
    /// What to hand pip.
    pub pip_name: &'static str,
    /// What the user calls the feature.
    pub label: &'static str,
}

pub(crate) const VENV_PASSENGERS: [VenvPassenger; 2] = [
    VenvPassenger { marker: "faster_whisper", pip_name: "faster-whisper", label: "Voice input (faster-whisper)" },
    VenvPassenger { marker: "piper", pip_name: "piper-tts", label: "Neural voice output (Piper TTS)" },
];

/// Every `site-packages` a venv can have, across both platform layouts.
/// Pure path math — enumerated rather than guessed, because the Unix minor
/// version (`lib/python3.12`) is whatever built the env.
pub(crate) fn venv_site_packages(venv_dir: &Path) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    // Windows: <venv>/Lib/site-packages
    candidates.push(venv_dir.join("Lib").join("site-packages"));
    // Unix: <venv>/lib/python3.X/site-packages (and lib64 on some distros)
    for lib_name in ["lib", "lib64"] {
        let lib = venv_dir.join(lib_name);
        candidates.push(lib.join("site-packages"));
        if let Ok(entries) = std::fs::read_dir(&lib) {
            for e in entries.flatten() {
                candidates.push(e.path().join("site-packages"));
            }
        }
    }

    // Both probes hit the same directory on a case-insensitive filesystem
    // (macOS, Windows), where `Lib` and `lib` are one directory. Dedupe by
    // canonical path so a caller counting the result gets the number of real
    // site-packages, not the number of spellings that reached them.
    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    for c in candidates {
        if !c.is_dir() {
            continue;
        }
        let key = std::fs::canonicalize(&c).unwrap_or_else(|_| c.clone());
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(c);
    }
    out
}

/// Which LU-owned passengers are in this venv right now. Read BEFORE the venv
/// is deleted; the result is what the repair has to put back.
pub(crate) fn detect_venv_passengers(venv_dir: &Path) -> Vec<&'static VenvPassenger> {
    let site_dirs = venv_site_packages(venv_dir);
    VENV_PASSENGERS
        .iter()
        .filter(|p| site_dirs.iter().any(|d| d.join(p.marker).exists()))
        .collect()
}

// ── Piper neural TTS installer (David 2026-06-06 — local neural TTS) ──────────

/// Resolve the Python LU's tooling uses: the ComfyUI venv when present, else
/// the resolved system Python. Shared by the faster-whisper + Piper-TTS
/// installers and the TTS synthesizer so they all target the same interpreter.
pub fn resolve_lu_python(state: &AppState) -> String {
    let comfy_dir: Option<PathBuf> = {
        let p = state.comfy_path.lock().unwrap().clone();
        p.map(PathBuf::from)
            .or_else(|| crate::commands::process::find_comfyui_path().map(PathBuf::from))
    };
    let venv_python = comfy_dir
        .as_deref()
        .and_then(crate::python::resolve_comfyui_venv_python);
    if let Some(v) = venv_python {
        return v;
    }
    // System Python: use the cached resolution, but if it's empty/stale —
    // Python may have been installed AFTER launch (Bug B8) — re-resolve once and
    // refresh the cache so install_tts/install_whisper don't wrongly report "no
    // Python found" until the next restart.
    let cached = state.python_bin.lock().map(|g| g.clone()).unwrap_or_default();
    if crate::python::is_real_python(&cached) {
        return cached;
    }
    let resolved = crate::python::get_python_bin();
    if crate::python::is_real_python(&resolved) {
        if let Ok(mut slot) = state.python_bin.lock() {
            *slot = resolved.clone();
        }
    }
    resolved
}

/// The card the user reads when Repair environment cannot delete the old venv.
///
/// A15, Windows Nachlauf 02.09.: this exact sentence carried the German
/// "Der Prozess kann nicht auf die Datei zugreifen, da sie von einem anderen
/// Prozess verwendet wird. (os error 32)" into an English app, because it
/// rendered the `io::Error` itself and Windows answers FormatMessageW in the
/// system language. Split out of the caller so the wording is testable without
/// a locked folder, and without Windows.
pub(crate) fn venv_removal_error(venv_dir: &Path, e: &std::io::Error) -> String {
    format!(
        "Could not remove the old venv at {}: {}. Close anything using it and retry.",
        venv_dir.display(),
        os_error::io_english(e)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── OI-3: the repair must not silently uninstall Voice ────────────────
    //
    // `resolve_lu_python` puts faster-whisper and Piper into ComfyUI's venv,
    // and `repair_comfyui_env` deletes that venv — automatically, after a
    // ComfyUI startup crash the user did not connect to Voice at all.
    // Detection is pure path work, so it is fully testable; the reinstall
    // itself is a pip run and needs a real network.

    fn venv_with_packages(names: &[&str], layout: &str) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let site = match layout {
            "windows" => tmp.path().join("venv").join("Lib").join("site-packages"),
            _ => tmp
                .path()
                .join("venv")
                .join("lib")
                .join("python3.12")
                .join("site-packages"),
        };
        std::fs::create_dir_all(&site).unwrap();
        for n in names {
            std::fs::create_dir_all(site.join(n)).unwrap();
        }
        tmp
    }

    #[test]
    fn both_voice_packages_are_seen_in_a_unix_venv() {
        let tmp = venv_with_packages(&["faster_whisper", "piper", "torch"], "unix");
        let found = detect_venv_passengers(&tmp.path().join("venv"));
        let names: Vec<&str> = found.iter().map(|p| p.pip_name).collect();
        assert_eq!(names, vec!["faster-whisper", "piper-tts"]);
    }

    #[test]
    fn both_voice_packages_are_seen_in_a_windows_venv() {
        // The layout LU's own Windows installs use, checked from a Unix box.
        let tmp = venv_with_packages(&["faster_whisper", "piper"], "windows");
        let found = detect_venv_passengers(&tmp.path().join("venv"));
        assert_eq!(found.len(), 2);
    }

    #[test]
    fn a_venv_without_voice_has_nothing_to_reinstall() {
        // Negative control: a plain ComfyUI venv must not trigger the extra
        // pip runs, or every repair would install Piper on machines that
        // never had it.
        let tmp = venv_with_packages(&["torch", "torchvision"], "unix");
        assert!(detect_venv_passengers(&tmp.path().join("venv")).is_empty());
        // And a venv that does not exist at all reads as empty, not an error:
        // the repair runs on installs that never had one.
        let missing = tempfile::tempdir().unwrap();
        assert!(detect_venv_passengers(&missing.path().join("venv")).is_empty());
    }

    #[test]
    fn only_the_whisper_half_is_detected_when_only_it_is_installed() {
        let tmp = venv_with_packages(&["faster_whisper"], "unix");
        let found = detect_venv_passengers(&tmp.path().join("venv"));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].pip_name, "faster-whisper");
        assert!(found[0].label.to_lowercase().contains("voice"));
    }

    #[test]
    fn site_packages_are_found_in_both_layouts_and_nowhere_else() {
        let unix = venv_with_packages(&[], "unix");
        assert_eq!(venv_site_packages(&unix.path().join("venv")).len(), 1);
        let win = venv_with_packages(&[], "windows");
        assert_eq!(venv_site_packages(&win.path().join("venv")).len(), 1);
        // A directory that is not a venv has none.
        let plain = tempfile::tempdir().unwrap();
        assert!(venv_site_packages(plain.path()).is_empty());
    }

    // ── Bug E (rzgrozt — Arch PEP 668 externally-managed) ─────────────────
    //
    // The detection function spawns a Python subprocess, so we can't unit
    // test it without a Python install. We DO test the safety guarantees:
    // empty `python_bin` returns false (regression-safe default), and the
    // diagnose path surfaces a useful hint when the marker error reaches
    // the user despite the auto-venv path.

    #[test]
    fn is_pep668_protected_returns_false_for_empty_bin() {
        // Empty sentinel from python.rs::get_python_bin must short-circuit
        // to false so a missing Python doesn't accidentally trigger venv
        // creation (which would also fail and confuse the error chain).
        assert!(!is_pep668_protected(""));
    }

    #[test]
    fn is_pep668_protected_returns_false_for_garbage_bin() {
        // Probing a non-existent path can't crash — the function must
        // swallow the spawn error and return false so install proceeds as
        // it always did on systems that aren't PEP 668 protected.
        assert!(!is_pep668_protected("/definitely/not/a/real/python-9.99"));
    }

    // ── Bug E — LIVE integration test ──────────────────────────────────────
    //
    // Runs against a real Python install with a real EXTERNALLY-MANAGED
    // marker planted in its stdlib. Requires the caller to point
    // `LU_PEP668_TEST_PYTHON` env var at a Python whose stdlib is writable
    // (typically a temp copy of system Python — see
    // `LU-E2E-Test-Kit/scripts/pep668_live_test.ps1` for the setup helper).
    //
    // Skipped by default via `#[ignore]` because:
    // 1. needs a real, modifiable Python install (not safe to mutate the
    //    system Python's stdlib — wedges every pip command on the box).
    // 2. writes to the filesystem and spawns 4-5 Python subprocesses.
    //
    // Run with: `cargo test --release --bins -- --ignored pep668_e2e_live`

    #[test]
    #[ignore]
    fn pep668_e2e_live_detect_and_create_venv() {
        let fake_python = std::env::var("LU_PEP668_TEST_PYTHON")
            .expect("set LU_PEP668_TEST_PYTHON to the fake-python path before running");
        assert!(
            std::path::Path::new(&fake_python).exists(),
            "LU_PEP668_TEST_PYTHON does not exist: {}",
            fake_python
        );

        // The helper script must have planted the marker BEFORE this test
        // runs. If it didn't, the detection should return false — that's
        // also informative, so we don't fail outright here; we just print
        // and check the more interesting assertions.

        // ── Phase 1: PEP 668 detection ──
        let detected = is_pep668_protected(&fake_python);
        assert!(
            detected,
            "is_pep668_protected({}) returned false — was the EXTERNALLY-MANAGED \
             marker planted in this Python's stdlib?",
            fake_python
        );
        println!("[live E2E] ✓ is_pep668_protected detected the marker");

        // ── Phase 2: create_comfyui_venv ──
        let comfy_root = std::env::temp_dir().join("lu-pep668-live-comfyui");
        let _ = std::fs::remove_dir_all(&comfy_root);
        std::fs::create_dir_all(&comfy_root).expect("temp dir create");

        let venv_py = create_comfyui_venv(&comfy_root, &fake_python, None)
            .expect("create_comfyui_venv should succeed against fake python");

        assert!(venv_py.exists(), "venv python at {} should exist", venv_py.display());
        assert!(venv_py.starts_with(&comfy_root), "venv python should be inside comfy dir");
        println!("[live E2E] ✓ create_comfyui_venv produced {}", venv_py.display());

        // ── Phase 3: nested venv's pip should be UNBLOCKED ──
        // The venv has its own site-packages, so PEP 668 doesn't apply to
        // it — this is the whole point of the fix. Verify pip install
        // works inside the nested venv. We use `--dry-run` so we don't
        // actually download anything heavy; the test is whether pip
        // refuses or proceeds.
        let pip_out = std::process::Command::new(venv_py.to_string_lossy().as_ref())
            .args(["-m", "pip", "install", "--dry-run", "--no-input", "pip"])
            .output()
            .expect("nested venv pip should spawn");
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&pip_out.stdout),
            String::from_utf8_lossy(&pip_out.stderr)
        );
        assert!(
            !combined.to_lowercase().contains("externally-managed"),
            "nested venv pip was STILL blocked — PEP 668 leaked through. \
             Output:\n{}",
            combined
        );
        assert!(pip_out.status.success(), "nested venv pip exit code != 0:\n{}", combined);
        println!("[live E2E] ✓ nested venv pip runs without PEP 668 block");

        // ── Phase 4: idempotency — second create_comfyui_venv must no-op ──
        let venv_py_again = create_comfyui_venv(&comfy_root, &fake_python, None)
            .expect("second create_comfyui_venv should idempotently return existing venv");
        assert_eq!(venv_py, venv_py_again);
        println!("[live E2E] ✓ create_comfyui_venv is idempotent");

        // Cleanup
        let _ = std::fs::remove_dir_all(&comfy_root);
        println!("[live E2E] ALL ASSERTIONS PASSED");
    }

    /// What code 32 reads as on the machine the test runs on. Windows means
    /// ERROR_SHARING_VIOLATION, which is the code from the box; every unix
    /// errno 32 is EPIPE. Both answers are ours, and neither is read off the
    /// operating system.
    #[cfg(windows)]
    const VENV_BUSY: &str = "the file is in use by another process (os error 32)";

    #[cfg(not(windows))]
    const VENV_BUSY: &str = "broken pipe (os error 32)";

    #[test]
    fn a_venv_held_by_another_process_is_reported_in_our_words() {
        let dir = PathBuf::from("C:\\Users\\ddrob\\ComfyUI\\venv");
        let e = std::io::Error::from_raw_os_error(32);
        let msg = venv_removal_error(&dir, &e);
        assert_eq!(
            msg,
            format!(
                "Could not remove the old venv at {}: {}. Close anything using it and retry.",
                dir.display(),
                VENV_BUSY
            )
        );
        // The finding itself: on the German box this sentence carried
        // "Der Prozess kann nicht auf die Datei zugreifen ...". Whatever this
        // machine's language calls code 32, that wording is not in here.
        assert!(!msg.contains(&e.to_string()), "the system wording survived: {msg}");
        assert!(msg.is_ascii(), "a localised message would not be ascii: {msg}");
    }

    /// Negative control: an error Rust worded itself is already English, and
    /// rewriting it would only lose the detail it carries.
    #[test]
    fn a_venv_failure_rust_worded_itself_is_passed_through_unchanged() {
        let e = std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the venv path is not a directory",
        );
        let msg = venv_removal_error(Path::new("/tmp/ComfyUI/venv"), &e);
        assert!(msg.contains("the venv path is not a directory"), "got: {msg}");
        assert!(msg.starts_with("Could not remove the old venv at /tmp/ComfyUI/venv: "), "got: {msg}");
    }

    // ── P3 (04.09.): cancelling a repair took 76 seconds ──────────────────
    //
    // Two blocking calls with no way out sat between the click and the stop:
    // `remove_dir_all` over a venv holding PyTorch, and `python -m venv`.
    // These pin the first half. The second half is `wait_or_cancel` in
    // children.rs, which is where its own tests live.

    /// A folder tree with `dirs` subfolders holding `per_dir` files each.
    fn tree_with_files(root: &Path, dirs: usize, per_dir: usize) {
        for d in 0..dirs {
            let sub = root.join(format!("pkg{d}"));
            std::fs::create_dir_all(&sub).unwrap();
            for f in 0..per_dir {
                std::fs::write(sub.join(format!("mod{f}.py")), b"x").unwrap();
            }
        }
    }

    #[test]
    fn retire_venv_moves_the_folder_instead_of_emptying_it() {
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        let venv = comfy.join("venv");
        tree_with_files(&venv, 3, 4);
        std::fs::write(venv.join("pyvenv.cfg"), b"home = /usr").unwrap();

        let retired = retire_venv(&venv).expect("the venv could not be set aside");

        assert!(!venv.exists(), "the old venv is still at its old name");
        assert!(retired.is_dir(), "the retired folder is not there: {}", retired.display());
        assert_eq!(retired.parent(), Some(comfy.as_path()), "it left the ComfyUI folder");
        assert!(
            retired
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(RETIRED_VENV_PREFIX)),
            "the retired folder does not carry the prefix: {}",
            retired.display()
        );
        // The whole point: nothing was walked, so nothing was lost. This is
        // what separates a rename from a delete, and it is what makes it fast.
        assert!(retired.join("pyvenv.cfg").exists(), "the contents were emptied out");
        for d in 0..3 {
            for f in 0..4 {
                let file = retired.join(format!("pkg{d}")).join(format!("mod{f}.py"));
                assert!(file.exists(), "a file did not survive: {}", file.display());
            }
        }
    }

    #[test]
    fn retiring_a_venv_is_orders_of_magnitude_faster_than_deleting_it() {
        // Self-calibrating rather than a fixed millisecond budget, so it says
        // the same thing on a fast NVMe and on a tired laptop drive: a delete
        // pays per file, a rename does not.
        let tmp = tempfile::tempdir().unwrap();
        let to_delete = tmp.path().join("delete-me").join("venv");
        let to_retire = tmp.path().join("retire-me").join("venv");
        tree_with_files(&to_delete, 40, 100);
        tree_with_files(&to_retire, 40, 100);

        let t0 = std::time::Instant::now();
        std::fs::remove_dir_all(&to_delete).unwrap();
        let deleting = t0.elapsed();

        let t1 = std::time::Instant::now();
        retire_venv(&to_retire).expect("the venv could not be set aside");
        let retiring = t1.elapsed();

        assert!(
            retiring * 10 < deleting,
            "setting aside took {retiring:?} against a delete of {deleting:?}. If the delete \
             itself was too quick to measure, the tree is too small: raise the file count."
        );
        // And in absolute terms, because the promise to the user is a number:
        // the cancel budget is five seconds and this step must not eat it.
        assert!(retiring < std::time::Duration::from_millis(250), "took {retiring:?}");
    }

    #[test]
    fn a_retired_venv_is_invisible_to_everything_that_looks_for_one() {
        // The reason the delete may run in the background at all. If the
        // launcher could still find the folder, a half-deleted venv would be
        // offered to `start_comfyui` and autostart as a working environment.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        let venv = comfy.join("venv");
        let site = venv.join("lib").join("python3.12").join("site-packages");
        std::fs::create_dir_all(site.join("faster_whisper")).unwrap();
        let interpreter = venv_python_path(&comfy);
        std::fs::create_dir_all(interpreter.parent().unwrap()).unwrap();
        std::fs::write(&interpreter, b"#!/bin/sh\n").unwrap();

        // Before: both finders see it, so the assertions below mean something.
        assert!(crate::python::resolve_comfyui_venv_python(&comfy).is_some());
        assert_eq!(detect_venv_passengers(&venv).len(), 1);

        retire_venv(&venv).expect("the venv could not be set aside");

        assert!(
            crate::python::resolve_comfyui_venv_python(&comfy).is_none(),
            "the launcher still offers a venv that is on its way to the bin"
        );
        assert!(
            detect_venv_passengers(&venv).is_empty(),
            "the passenger scan still reads the retired venv"
        );
    }

    #[test]
    fn the_sweep_takes_only_the_retired_folders() {
        // This runs inside the user's ComfyUI folder. A pattern one character
        // too short takes models with it, so the folders that must SURVIVE
        // are the point of this test.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        for keep in ["venv", "models", "custom_nodes", "output"] {
            std::fs::create_dir_all(comfy.join(keep)).unwrap();
        }
        std::fs::write(comfy.join("requirements.txt"), b"torch\n").unwrap();
        let gone = [
            comfy.join(format!("{RETIRED_VENV_PREFIX}1")),
            comfy.join(format!("{RETIRED_VENV_PREFIX}2")),
        ];
        for g in &gone {
            tree_with_files(g, 2, 2);
        }

        sweep_retired_venvs(&comfy);

        for g in &gone {
            assert!(!g.exists(), "a retired venv survived the sweep: {}", g.display());
        }
        for keep in ["venv", "models", "custom_nodes", "output"] {
            assert!(comfy.join(keep).is_dir(), "the sweep took {keep}");
        }
        assert!(comfy.join("requirements.txt").exists(), "the sweep took requirements.txt");
    }

    #[test]
    fn creating_a_venv_gives_up_on_a_raised_flag_and_leaves_no_ruin() {
        // The flag is raised before the call, so the outcome is the same on
        // every machine. That the loop keeps reading it WHILE the child runs
        // is the other half, and that is pinned deterministically in
        // children.rs against a child that sleeps two minutes; racing a real
        // `python -m venv` here would only be flaky.
        let Some(python) = probe_python() else {
            eprintln!("no usable Python on this box, skipping the live venv checks");
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        // Half a venv, the way a killed `python -m venv` leaves one: a folder
        // with something in it and no interpreter yet. Planted rather than
        // raced for, because the child dies too fast to build one reliably.
        let half_built = comfy.join("venv").join("lib");
        std::fs::create_dir_all(&half_built).unwrap();
        std::fs::write(half_built.join("half-written"), b"x").unwrap();

        let flag = Arc::new(AtomicBool::new(true));
        let out = create_comfyui_venv(&comfy, &python, Some(&flag));

        assert_eq!(out.err().as_deref(), Some("cancelled"));
        // A cancel that leaves the shell behind is worse than no cancel:
        // `resolve_comfyui_venv_python` asks only whether `venv/bin/python`
        // exists, `python -m venv` writes that file BEFORE the slow part, and
        // autostart would then launch ComfyUI out of an empty env.
        assert!(
            !comfy.join("venv").exists(),
            "the cancelled build left its half-finished venv behind"
        );
        assert!(
            crate::python::resolve_comfyui_venv_python(&comfy).is_none(),
            "the cancelled build left a startable ruin behind"
        );
    }

    #[test]
    #[ignore]
    fn a_venv_nobody_cancels_is_still_built_and_found() {
        // The control that has to stay green: a `create_comfyui_venv` that
        // always answered "cancelled" would pass every test above while
        // killing Repair and Install outright.
        //
        // `#[ignore]` for a reason that is about the product, not about this
        // test. The venv child now joins `INSTALLER_CHILDREN`, and
        // `kill_installer_children` walks that whole registry. Every dropped
        // `AppState` runs `shutdown_subprocesses`, which calls it, and this
        // test binary builds dozens of `AppState`s in parallel with this
        // test. The child then dies mid-build and the run reads as
        // "venv creation failed: " with empty stderr. Correct behaviour on a
        // real quit, unrunnable next to a hundred simulated ones.
        //
        // The everyday guard against "always cancelled" is
        // `a_child_left_alone_still_runs_to_its_own_end` in children.rs, which
        // drives the same wait loop with no registry and no Python.
        //
        // Run with: cargo test --bins -- --ignored --test-threads=1 a_venv_nobody_cancels
        let Some(python) = probe_python() else {
            eprintln!("no usable Python on this box, skipping the live venv checks");
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        std::fs::create_dir_all(&comfy).unwrap();

        let down = Arc::new(AtomicBool::new(false));
        let venv_py = create_comfyui_venv(&comfy, &python, Some(&down))
            .expect("a venv nobody cancelled was not built");

        assert!(venv_py.exists(), "no interpreter at {}", venv_py.display());
        assert_eq!(
            crate::python::resolve_comfyui_venv_python(&comfy).as_deref(),
            Some(venv_py.to_string_lossy().as_ref()),
            "the launcher does not find the venv that was just built"
        );
        // And a second call is still a no-op rather than a rebuild.
        assert_eq!(
            create_comfyui_venv(&comfy, &python, None).expect("second call"),
            venv_py
        );
    }

    /// The interpreter to run the two live checks against, or nothing.
    fn probe_python() -> Option<String> {
        let bin = crate::python::get_python_bin();
        (!bin.is_empty() && crate::python::is_real_python(&bin)).then_some(bin)
    }

}
