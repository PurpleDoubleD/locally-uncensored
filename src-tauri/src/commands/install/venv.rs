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

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::os_error;
use crate::python::venv_python_path;
use crate::state::AppState;

#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

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
    let mut cmd = Command::new(python_bin);
    cmd.args([
        "-c",
        "import os, sysconfig; \
         d = sysconfig.get_path('stdlib'); \
         print('YES' if os.path.exists(os.path.join(d, 'EXTERNALLY-MANAGED')) else 'NO')",
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let Ok(out) = cmd.output() else { return false };
    if !out.status.success() {
        return false;
    }
    String::from_utf8_lossy(&out.stdout).trim() == "YES"
}

/// Create a venv inside `comfyui_dir/venv` using the system `python_bin`.
/// Returns the path to the venv's Python interpreter on success. On Arch
/// boxes that haven't installed the `python-virtualenv` package this can
/// fail with `No module named venv` — we surface that with an actionable
/// hint pointing at the right pacman / apt invocation.
pub fn create_comfyui_venv(comfyui_dir: &Path, python_bin: &str) -> Result<PathBuf, String> {
    let venv_dir = comfyui_dir.join("venv");
    // venv is idempotent: re-running on an existing dir just no-ops, but be
    // explicit so the log reads cleanly.
    let already_existed = venv_dir.exists() && venv_python_path(comfyui_dir).exists();
    if already_existed {
        return Ok(venv_python_path(comfyui_dir));
    }

    let mut cmd = Command::new(python_bin);
    cmd.args(["-m", "venv", venv_dir.to_string_lossy().as_ref()])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let out = cmd
        .output()
        .map_err(|e| format!("Could not spawn `python -m venv`: {}", os_error::english(&e)))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
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

        let venv_py = create_comfyui_venv(&comfy_root, &fake_python)
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
        let venv_py_again = create_comfyui_venv(&comfy_root, &fake_python)
            .expect("second create_comfyui_venv should idempotently return existing venv");
        assert_eq!(venv_py, venv_py_again);
        println!("[live E2E] ✓ create_comfyui_venv is idempotent");

        // Cleanup
        let _ = std::fs::remove_dir_all(&comfy_root);
        println!("[live E2E] ALL ASSERTIONS PASSED");
    }

}
