//! A34 / GitHub #254: Piper gets an environment of its own.
//!
//! Until 3.1.2 `pip install piper-tts` went, unpinned, into whatever
//! `resolve_lu_python` returned: ComfyUI's venv, else the system Python. On
//! Windows 11 that ended in "Cannot install piper-tts==1.1.0 ... 1.8.0 because
//! these package versions have conflicting dependencies. ResolutionImpossible".
//! Every piper-tts from 1.3.0 on is one abi3 wheel for Python 3.9 and newer;
//! what it cannot do without is onnxruntime, and onnxruntime has wheels for
//! Python 3.11 to 3.14 only. A Python outside that range (3.15 is out since
//! October 2026, a Discord machine had nothing else, see base_python.rs), and
//! every piper-tts is unresolvable. The app then showed pip's last line,
//! without the "The conflict is caused by" lines that say why.
//!
//! Now Piper lives in `<data_dir>/piper-venv`, built from a Python inside the
//! range (one of the machine's, else LU's own 3.12, the same one ComfyUI and
//! the trainer fall back to), with pinned versions and wheels only. ComfyUI's
//! venv is no longer touched by it. A Piper that an older LU put into
//! ComfyUI's venv keeps working until the next install (`piper_python`).

use std::path::{Path, PathBuf};
use std::process::Stdio;

/// The versions installed, checked on PyPI 19.11.2026: piper-tts 1.8.0
/// (2026-09-04, GPL-3.0, OHF-Voice/piper1-gpl, cp39-abi3 wheels for Windows
/// x64, macOS, Linux x64/arm64), pathvalidate 3.3.1 (2025-06-15, MIT).
pub const PIPER_TTS: &str = "piper-tts==1.8.0";
pub const PATHVALIDATE: &str = "pathvalidate==3.3.1";

/// onnxruntime (MIT, Microsoft). 1.31.1 (2026-10-26) has wheels for Python
/// 3.11 to 3.14 on Windows and Linux; on macOS only for arm64 and macOS 14 or
/// newer, so a Mac takes the newest one that has a wheel for it, below 1.32
/// (1.32.0 came out on 13.11., too fresh to ship).
pub fn onnxruntime_requirement(os: &str) -> &'static str {
    if os == "macos" {
        "onnxruntime>=1.17,<1.32"
    } else {
        "onnxruntime==1.31.1"
    }
}

/// The Pythons Piper's environment is built from: onnxruntime's range.
pub fn piper_accepts(v: (u32, u32)) -> bool {
    v.0 == 3 && (11..=14).contains(&v.1)
}

pub const PIPER_PYTHON_RANGE: &str = "Python 3.11 to 3.14";

/// Written into the venv once `import piper` worked in it.
const READY_MARKER: &str = ".lu-piper-ready";

pub fn piper_venv_dir() -> PathBuf {
    crate::os_paths::data_dir().join("piper-venv")
}

fn venv_python_in(dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        dir.join("Scripts").join("python.exe")
    } else {
        dir.join("bin").join("python")
    }
}

/// Piper's own interpreter, when its environment is complete.
pub fn ready_python_in(dir: &Path) -> Option<String> {
    let py = venv_python_in(dir);
    (py.exists() && dir.join(READY_MARKER).exists()).then(|| py.to_string_lossy().into_owned())
}

/// The interpreter every Piper call starts: its own environment when there
/// is one, else the Python an older LU installed Piper into.
pub fn piper_python(fallback: impl FnOnce() -> String) -> String {
    ready_python_in(&piper_venv_dir()).unwrap_or_else(fallback)
}

/// `python -m pip install` for Piper: pinned, wheels only (nothing is built on
/// the customer's machine), quiet progress, no prompt.
pub fn pip_args(os: &str) -> Vec<&'static str> {
    vec![
        "-m", "pip", "install",
        "--progress-bar", "off",
        "--no-input",
        "--only-binary=:all:",
        PIPER_TTS,
        onnxruntime_requirement(os),
        PATHVALIDATE,
    ]
}

/// "3.12.4" → (3, 12).
pub fn major_minor(version: &str) -> Option<(u32, u32)> {
    let mut it = version.trim().split('.');
    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
}

/// The first Python of the machine inside the range, in the order given
/// (LU's default first). Each entry is (path, version).
pub fn choose_machine_python(found: &[(String, String)]) -> Option<String> {
    found
        .iter()
        .find(|(_, v)| major_minor(v).is_some_and(piper_accepts))
        .map(|(p, _)| p.clone())
}

/// pip's own explanation of a ResolutionImpossible: the "Cannot install"
/// line and the "The conflict is caused by:" block. pip prints the block on
/// stdout, so it is read from the install log, where the streamed lines
/// land; the error text alone ends with pip's last line. Empty when the log
/// holds no such block.
pub fn conflict_lines(log: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut inside = false;
    for line in log.iter().flat_map(|l| l.lines()) {
        let t = line.trim_end();
        if t.contains("because these package versions have conflicting dependencies") {
            out.push(t.trim_start_matches("ERROR: ").trim().to_string());
            continue;
        }
        if t.trim_start().starts_with("The conflict is caused by") {
            inside = true;
            out.push(t.trim().to_string());
            continue;
        }
        if inside {
            if t.trim().is_empty() || t.trim_start().starts_with("To fix this") || t.trim_start().starts_with("Additionally") {
                inside = false;
                continue;
            }
            out.push(format!("  {}", t.trim()));
        }
    }
    out.dedup();
    out
}

/// The sentence of a failed Piper install: LU's own words, pip's reason when
/// it gave one, then pip's diagnosis.
pub fn failure_message(diagnosis: &str, log: &[String], python: &str, version: &str) -> String {
    let conflict = conflict_lines(log);
    let mut msg = format!("Neural TTS (Piper) could not be installed into its own environment (Python {version} at {python}).");
    if !conflict.is_empty() {
        msg.push_str("\n\npip says:\n");
        msg.push_str(&conflict.join("\n"));
    }
    msg.push_str("\n\n");
    msg.push_str(diagnosis.trim());
    msg
}

/// (version, 64-bit) of an interpreter, or why it does not start.
pub fn probe(python: &str) -> Result<(String, bool), String> {
    let out = crate::python::python_command(python)
        .args(["-c", "import struct,sys;print('%d.%d.%d'%sys.version_info[:3]);print(struct.calcsize('P')*8)"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| crate::os_error::english(&e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("it exited with an error").trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let version = lines.next().unwrap_or("").trim().to_string();
    let bits: u32 = lines.next().and_then(|l| l.trim().parse().ok()).unwrap_or(0);
    if version.is_empty() {
        return Err("it printed no version".to_string());
    }
    Ok((version, bits == 64))
}

/// `base -m venv <dir>`, after clearing a half-built one.
pub fn build_venv(base: &str, dir: &Path) -> Result<String, String> {
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| format!("could not clear {}: {}", dir.display(), crate::os_error::english(&e)))?;
    }
    if let Some(parent) = dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let out = crate::python::python_command(base)
        .args(["-m", "venv"])
        .arg(dir)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| crate::os_error::english(&e))?;
    let py = venv_python_in(dir);
    if !out.status.success() || !py.exists() {
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no venv was made").trim().to_string();
        return Err(line);
    }
    Ok(py.to_string_lossy().into_owned())
}

/// After a working `import piper`: the environment counts as Piper's.
pub fn mark_ready(dir: &Path) {
    let _ = std::fs::write(dir.join(READY_MARKER), PIPER_TTS);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_range_is_onnxruntimes() {
        for ok in [(3, 11), (3, 12), (3, 13), (3, 14)] {
            assert!(piper_accepts(ok), "{ok:?}");
        }
        // #254 most likely: a 3.15 has no onnxruntime wheel, and then no
        // piper-tts resolves at all.
        for no in [(3, 9), (3, 10), (3, 15), (2, 7), (4, 0)] {
            assert!(!piper_accepts(no), "{no:?}");
        }
    }

    #[test]
    fn the_machines_python_in_range_is_taken_in_order() {
        let found = vec![
            ("C:\\Python315\\python.exe".to_string(), "3.15.0".to_string()),
            ("C:\\Python313\\python.exe".to_string(), "3.13.9".to_string()),
            ("C:\\Python312\\python.exe".to_string(), "3.12.4".to_string()),
        ];
        assert_eq!(choose_machine_python(&found).as_deref(), Some("C:\\Python313\\python.exe"));
        assert_eq!(choose_machine_python(&found[..1]), None, "then LU's own Python");
    }

    #[test]
    fn the_install_is_pinned_and_takes_wheels_only() {
        let win = pip_args("windows");
        assert_eq!(&win[..3], &["-m", "pip", "install"]);
        assert!(win.contains(&"--only-binary=:all:"));
        assert!(win.contains(&"piper-tts==1.8.0"));
        assert!(win.contains(&"onnxruntime==1.31.1"));
        assert!(win.contains(&"pathvalidate==3.3.1"));
        assert!(!win.contains(&"piper-tts"), "never the bare name again");
        assert!(pip_args("macos").contains(&"onnxruntime>=1.17,<1.32"));
    }

    /// pip 24's words for #254, stdout and stderr as they reach the log.
    const RESOLUTION_IMPOSSIBLE: &str = "Collecting piper-tts==1.8.0
ERROR: Cannot install piper-tts==1.8.0 because these package versions have conflicting dependencies.

The conflict is caused by:
    piper-tts 1.8.0 depends on onnxruntime<2 and >=1
    The user requested onnxruntime==1.31.1

To fix this you could try to:
1. loosen the range of package versions you've specified
2. remove package versions to allow pip to attempt to solve the dependency conflict

ERROR: ResolutionImpossible: for help visit https://pip.pypa.io/en/latest/topics/dependency-resolution/#dealing-with-dependency-conflicts";

    #[test]
    fn the_conflict_lines_reach_the_message() {
        let log: Vec<String> = RESOLUTION_IMPOSSIBLE.lines().map(str::to_string).collect();
        assert_eq!(
            conflict_lines(&log),
            vec![
                "Cannot install piper-tts==1.8.0 because these package versions have conflicting dependencies.",
                "The conflict is caused by:",
                "  piper-tts 1.8.0 depends on onnxruntime<2 and >=1",
                "  The user requested onnxruntime==1.31.1",
            ]
        );
        let msg = failure_message("ERROR: ResolutionImpossible", &log, "C:\\py\\python.exe", "3.12.4");
        assert!(msg.contains("The conflict is caused by:"), "{msg}");
        assert!(msg.contains("Python 3.12.4"), "{msg}");
        assert!(conflict_lines(&["Successfully installed piper-tts-1.8.0".to_string()]).is_empty());
    }

    #[test]
    fn a_venv_counts_only_with_its_marker() {
        let dir = std::env::temp_dir().join(format!("lu-piper-test-{}", std::process::id()));
        let py = venv_python_in(&dir);
        std::fs::create_dir_all(py.parent().unwrap()).unwrap();
        std::fs::write(&py, b"").unwrap();
        assert_eq!(ready_python_in(&dir), None, "a half-built venv is not Piper's");
        mark_ready(&dir);
        assert_eq!(ready_python_in(&dir), Some(py.to_string_lossy().into_owned()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn version_strings_are_read() {
        assert_eq!(major_minor("3.12.4"), Some((3, 12)));
        assert_eq!(major_minor("3.15.0rc1"), Some((3, 15)));
        assert_eq!(major_minor("x"), None);
    }
}
