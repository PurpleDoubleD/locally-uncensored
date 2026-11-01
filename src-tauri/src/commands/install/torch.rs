//! Welches PyTorch-Rad diese Maschine bekommt.
//!
//! Der geteilte Zustand ist die Grafikkarte, wie sie sich abfragen lässt.
//! `parse_compute_cap_output` und `detect_nvidia_compute_cap` lesen sie,
//! `plan_pytorch_install` verbindet diese Lesung mit der Herstellerliste aus
//! `torch_wheels` zu einer Kanalwahl, und `pytorch_pip_args` gießt das
//! Ergebnis in die Argumentliste, die `pip` dann ausführt.
//!
//! Die Naht trennt die ENTSCHEIDUNG vom LAUF: alles hier ist reine
//! Rechnung über eine Sonde, ohne Netz und ohne Zustand, und ist deshalb
//! auf einem Rechner ohne die Hardware prüfbar. Der Einbau an zwei Stellen
//! — Erstinstallation und Reparatur — ist der Grund, warum diese Wahl
//! überhaupt eine eigene Funktion ist: die beiden dürfen nie
//! auseinanderlaufen.

use std::process::Stdio;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::commands::torch_wheels;

#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

// ── GPU helpers (Bug #10 — Blackwell PyTorch cu128 routing) ─────────────────

/// Probe NVIDIA's compute capability and return it as (major, minor):
/// (8, 6) for a 3060, (7, 5) for a 2080, (12, 0) for Blackwell.
///
/// `nvidia-smi --query-gpu=compute_cap` prints lines like `12.0` (one per
/// GPU). We take the highest across visible GPUs because pip can only install
/// ONE PyTorch build, so the higher capability set is the one that satisfies
/// every card on the box. Returns None when nvidia-smi is absent or the parse
/// fails, and the caller then picks the channel that covers the widest range.
///
/// The minor number was thrown away until 2.6.7 and is now load bearing:
/// CUDA 13 dropped everything below Turing, and Turing is 7.5 while Volta is
/// 7.0. A major-only reading cannot tell those two apart.
pub(crate) fn parse_compute_cap_output(s: &str) -> Option<(u32, u32)> {
    let mut best: Option<(u32, u32)> = None;
    for line in s.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.split('.');
        let major = match parts.next().unwrap_or("").parse::<u32>() {
            Ok(m) => m,
            Err(_) => continue,
        };
        // A card that prints a bare major keeps the old reading of .0 rather
        // than being dropped: an unparseable minor must never cost us the card.
        let minor = parts.next().unwrap_or("0").trim().parse::<u32>().unwrap_or(0);
        best = Some(best.map_or((major, minor), |prev| prev.max((major, minor))));
    }
    best
}

pub(crate) fn detect_nvidia_compute_cap() -> Option<(u32, u32)> {
    // K14: a foreign vendor CLI, never something LU bundles.
    let mut cmd = crate::process_util::foreign_system_command("nvidia-smi");
    cmd.args(["--query-gpu=compute_cap", "--format=csv,noheader,nounits"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    parse_compute_cap_output(&s)
}

/// The major alone, for the trainer, whose two channels (cu121 and cu128) are
/// split at Blackwell and have never needed the minor.
pub(crate) fn detect_nvidia_compute_cap_major() -> Option<u32> {
    detect_nvidia_compute_cap().map(|(major, _)| major)
}

/// Pure: the pip argument set for the PyTorch install, for a given wheel
/// index. Split from the probe so the arg shapes are testable without
/// nvidia-smi on the machine.
pub(crate) fn pytorch_pip_args(index_url: Option<&str>, packages: &[&str]) -> Vec<String> {
    let mut args: Vec<String> = ["-m", "pip", "install", "--progress-bar", "off", "--no-input"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    // The package names come from the plan: AMD's Windows index serves a slim
    // torch plus a device package behind an extra, so "torch" alone would build
    // an environment with no kernels for any card.
    args.extend(packages.iter().map(|s| s.to_string()));
    if let Some(u) = index_url {
        args.push("--index-url".to_string());
        args.push(u.to_string());
    }
    args
}

/// GPU probe + wheel choice + pip args, shared between the first install and
/// `repair_comfyui_env` so the two can never drift apart.
///
/// Bug #10 (RTX 6000 Blackwell, 2026-05-11): SM 12.0 GPUs need their
/// own CUDA channel, older ones simply do not ship the kernel and the first
/// compute call dies with "no kernel image is available".
///
/// Box measurement 2026-08-16 (W2, #98): everything below Blackwell used to
/// get cu121, but that channel is frozen at torch 2.5.1 while ComfyUI's own
/// unpinned requirements move on. Current cores import comfy_kitchen, whose
/// custom ops use builtin generic annotations (`kernel_size: list[int]`) that
/// torch only accepts from 2.6 on, so a freshly repaired venv died at import
/// with the infer_schema ValueError.
///
/// AMD bundle 2026-08-28: the
/// probe was `nvidia-smi` and nothing else, so an AMD card came out of it
/// looking exactly like a machine with no card, and the venv got the
/// processor wheels. Those wheels install cleanly and then answer
/// "Torch not compiled with CUDA enabled" the moment the user forces the GPU.
/// The vendor list now decides, and the choice itself lives in
/// `torch_wheels` where it is testable without any of the hardware.
/// Returns the ready-to-run pip args, the human-readable channel note, and
/// (index_url, packages) again on their own: Runde 2's preflight
/// ([`torch_python_preflight`]) needs those two separately, and re-deriving
/// them from the combined arg list would be a second copy of the exact
/// assembly `pytorch_pip_args` already does.
pub(crate) fn plan_pytorch_install() -> (Vec<String>, String, Option<String>, Vec<String>) {
    // 3.0.8: the plan knows Intel Arc too, and is the same plan the settings
    // show as "what LU installs here", so the line and the install agree.
    let plan = torch_wheels::comfy_wheel_plan_here();
    // The note is resolved WITH the index: a plan that reached for AMD's
    // Windows channel and found it dead falls back to the processor wheels,
    // and then the sentence in "Step 2/3" has to be the fallback's, not the
    // one the plan set out with.
    let (index, packages, note) = torch_wheels::resolve_plan(&plan);
    let gpu_info = match index {
        Some(url) => format!("{note} ({url})"),
        None => note,
    };
    let package_refs: Vec<&str> = packages.iter().map(String::as_str).collect();
    let args = pytorch_pip_args(index, &package_refs);
    (args, gpu_info, index.map(|s| s.to_string()), packages)
}

// ── Runde 2, Nachbesserung 12: torch/Python-version preflight ───────────────

/// Runde 5, Folgeposten (review Runde 4, Abschnitt 4: "Probe-Timeout: FEHLT"):
/// neither `python_version_tuple` nor `python_can_build_a_venv` had a
/// deadline, a blank `.output()` each. A stale network-mounted interpreter,
/// or a Homebrew stub waiting on something, blocks the install thread
/// forever while the UI keeps showing "installing". The live network probe
/// right below this already budgets 10 s connect / 20 s total; a local
/// process that talks to nothing at all gets less.
const PYTHON_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Run `cmd`, but kill it and return `None` if it has not finished within
/// `timeout`. `stdin` is always `null` first (an interpreter waiting on
/// input dies immediately rather than needing the timeout at all), so the
/// deadline only ever catches something genuinely hanging, not the ordinary
/// "no input given" case every probe already relied on being instant.
fn run_probe_with_timeout(mut cmd: std::process::Command, timeout: std::time::Duration) -> Option<std::process::Output> {
    use std::io::Read;
    use std::sync::{Arc, Mutex};
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let stdout_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let mut readers: Vec<std::thread::JoinHandle<()>> = Vec::new();
    if let Some(mut pipe) = child.stdout.take() {
        let sink = stdout_buf.clone();
        readers.push(std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            if let Ok(mut slot) = sink.lock() {
                *slot = buf;
            }
        }));
    }
    if let Some(mut pipe) = child.stderr.take() {
        let sink = stderr_buf.clone();
        readers.push(std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            if let Ok(mut slot) = sink.lock() {
                *slot = buf;
            }
        }));
    }
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => break None,
        }
    };
    for r in readers {
        let _ = r.join();
    }
    Some(std::process::Output {
        status: status?,
        stdout: stdout_buf.lock().map(|b| b.clone()).unwrap_or_default(),
        stderr: stderr_buf.lock().map(|b| b.clone()).unwrap_or_default(),
    })
}

/// The interpreter's own `(major, minor)`, the way wheel filenames spell it
/// (`cp312` -> `(3, 12)`).
/// Whether `python_bin` finds a torch package, without importing it: a
/// `find_spec` costs milliseconds where `import torch` costs seconds. Used
/// for an interpreter whose prefix holds no torch but whose user site might
/// (`pip install --user`). Bounded like every other probe here.
pub(crate) fn python_finds_torch(python_bin: &str) -> bool {
    if python_bin.is_empty() {
        return false;
    }
    let mut cmd = crate::python::python_command(python_bin);
    cmd.args(["-c", "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('torch') else 1)"]);
    matches!(run_probe_with_timeout(cmd, PYTHON_PROBE_TIMEOUT), Some(out) if out.status.success())
}

pub(crate) fn python_version_tuple(python_bin: &str) -> Option<(u32, u32)> {
    let mut cmd = crate::python::python_command(python_bin);
    cmd.args(["-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"]);
    let out = run_probe_with_timeout(cmd, PYTHON_PROBE_TIMEOUT)?;
    if !out.status.success() {
        return None;
    }
    parse_version_tuple(String::from_utf8_lossy(&out.stdout).trim())
}

// ── GH #211: an old pip in front of the PyTorch index ──────────────────────

/// GH #211 (31.10.2026, Windows, a ComfyUI venv on Python 3.10.11):
/// "PyTorch installation failed … No matching distribution found for
/// flit_core<4,>=3.11". Python 3.10.11 ships pip 23.0.1. Measured on the Mac
/// on 01.11.2026 with the same pip: it throws away the typing_extensions
/// 4.16.0 wheel from download.pytorch.org ("inconsistent Name: expected
/// 'typing-extensions', but metadata has 'typing_extensions'"), falls back to
/// the source archive, and building that needs flit_core, which the PyTorch
/// index does not carry. pip 23.1 fails the same way, pip 24.0 resolves the
/// whole set. Nothing about the Python itself was wrong, so the "no matching
/// wheel, press Repair environment" sentence sent the user in a circle: the
/// rebuild makes a venv with the same old pip.
pub(crate) const MODERN_PIP_MAJOR: u32 = 24;

/// The major of `python -m pip --version` ("pip 23.0.1 from … (python 3.10)").
pub(crate) fn pip_major_from_version_line(line: &str) -> Option<u32> {
    line.trim().strip_prefix("pip ")?.split('.').next()?.trim().parse().ok()
}

/// Pure: the pip args that lift an old pip before the PyTorch step, or None
/// when the pip there is new enough or could not be read (an unreadable pip
/// is left to the PyTorch step, which reports it with its own diagnosis).
/// The upgrade goes to PyPI, the index pip itself comes from.
pub(crate) fn pip_upgrade_before_torch_args(pip_version_line: Option<&str>) -> Option<Vec<String>> {
    let major = pip_major_from_version_line(pip_version_line?)?;
    if major >= MODERN_PIP_MAJOR {
        return None;
    }
    Some(
        ["-m", "pip", "install", "--progress-bar", "off", "--no-input", "--upgrade"]
            .iter()
            .map(|s| s.to_string())
            .chain(std::iter::once(format!("pip>={MODERN_PIP_MAJOR}.0")))
            .collect(),
    )
}

/// The venv's pip version line, under the same deadline as every other probe.
pub(crate) fn pip_version_line(python_bin: &str) -> Option<String> {
    let mut cmd = crate::python::python_command(python_bin);
    cmd.args(["-m", "pip", "--version"]);
    let out = run_probe_with_timeout(cmd, PYTHON_PROBE_TIMEOUT)?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Lift an old pip in `python_bin` before PyTorch is installed into it. A
/// failed upgrade is not fatal: the PyTorch step runs anyway and keeps its
/// own diagnosis. Returns the line for the install log, None when nothing
/// had to be done.
pub(crate) fn lift_old_pip_before_torch(
    python_bin: &str,
    install_state: &std::sync::Arc<std::sync::Mutex<crate::state::InstallState>>,
    cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Option<String> {
    let line = pip_version_line(python_bin);
    let args = pip_upgrade_before_torch_args(line.as_deref())?;
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    Some(match super::pip::pip_install_streaming_with_retry_cancellable(&refs, python_bin, 2, install_state, cancel) {
        Ok(()) => format!("Updated pip in this environment ({}), the one it had cannot read the PyTorch index.", line.unwrap_or_default()),
        Err(e) if e == "cancelled" => "pip update cancelled.".to_string(),
        Err(e) => format!("Could not update pip in this environment, trying PyTorch with the one it has. {e}"),
    })
}

pub(crate) fn parse_version_tuple(s: &str) -> Option<(u32, u32)> {
    let mut parts = s.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// Every distinct CPython `(major, minor)` a wheel index page's `.whl`
/// filenames declare support for (`torch-2.7.0-cp312-cp312-linux_x86_64.whl`
/// -> `(3, 12)`). Pure and network-free, so it is testable against a canned
/// page instead of the real index; see the module doc on why that beats a
/// hardcoded version table: this reads whatever the channel serves AT CALL
/// TIME, so it is never stale the day a channel adds or drops a version.
pub(crate) fn python_versions_from_index_html(html: &str) -> std::collections::BTreeSet<(u32, u32)> {
    // `cp3\d{1,2}-cp3\d{1,2}` rather than `cp(\d)(\d+)`: a wheel tag repeats
    // the ABI tag right after the Python tag (`cp312-cp312-...`), and asking
    // for that repeat is enough discipline to reject a stray "cp312" inside
    // some other token (a URL query string, a directory name) without also
    // pulling in a whole HTML parser.
    static TAG: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = TAG.get_or_init(|| regex::Regex::new(r"cp3(\d{1,2})-cp3\d{1,2}").unwrap());
    re.captures_iter(html)
        .filter_map(|c| c.get(1)?.as_str().parse::<u32>().ok())
        .map(|minor| (3u32, minor))
        .collect()
}

/// The Python versions this index serves `package` for, counting only the
/// wheels whose version falls into `range` (">=2.13,<2.14", or "" for all).
///
/// Only the two operators LU's own requirements use are understood. Anything
/// else in `range` reads as "no limit", which is what the old check did for
/// every package.
pub(crate) fn python_versions_in_range(html: &str, package: &str, range: &str) -> std::collections::BTreeSet<(u32, u32)> {
    if range.is_empty() {
        return python_versions_from_index_html(html);
    }
    let dist = package.replace('-', "_").to_lowercase();
    let mut out = std::collections::BTreeSet::new();
    // A wheel file name is "<dist>-<version>-<python tag>-<abi>-<platform>.whl";
    // the version may carry "+rocm10.1.0", URL-encoded as "%2B".
    for chunk in html.split(".whl") {
        let Some(start) = chunk.to_lowercase().rfind(&format!("{dist}-")) else { continue };
        let file = &chunk[start + dist.len() + 1..];
        let mut parts = file.splitn(2, '-');
        let (Some(version), Some(rest)) = (parts.next(), parts.next()) else { continue };
        let version = version.replace("%2B", "+").replace("%2b", "+");
        if !version_in_range(&version, range) {
            continue;
        }
        out.extend(python_versions_from_index_html(rest));
    }
    out
}

/// Does `version` (local label ignored) satisfy `range`, a comma list of
/// ">=X" and "<Y"? Pure, numeric release segments only.
pub(crate) fn version_in_range(version: &str, range: &str) -> bool {
    fn release(v: &str) -> Vec<u64> {
        v.split('+')
            .next()
            .unwrap_or(v)
            .split('.')
            .map(|p| p.chars().take_while(|c| c.is_ascii_digit()).collect::<String>())
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    }
    fn cmp(a: &[u64], b: &[u64]) -> std::cmp::Ordering {
        let n = a.len().max(b.len());
        for i in 0..n {
            let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
            if x != y {
                return x.cmp(&y);
            }
        }
        std::cmp::Ordering::Equal
    }
    let v = release(version);
    range.split(',').map(str::trim).filter(|c| !c.is_empty()).all(|clause| {
        if let Some(lo) = clause.strip_prefix(">=") {
            cmp(&v, &release(lo)) != std::cmp::Ordering::Less
        } else if let Some(hi) = clause.strip_prefix('<') {
            cmp(&v, &release(hi)) == std::cmp::Ordering::Less
        } else {
            true
        }
    })
}

/// Fetch a PEP 503 wheel index page (`<index_url>/<package>/`, or PyPI's own
/// simple index when `index_url` is `None`) and read the Python versions it
/// serves wheels for, per [`python_versions_from_index_html`].
///
/// Talks to the network, so it is the one function here `torch.rs`'s own
/// module doc excludes from "ohne Netz und ohne Zustand": everything ELSE
/// in this file stays a pure decision over a probe, on purpose, and this is
/// the deliberate, narrow exception, isolated so the pure half stays
/// testable without it.
fn fetch_index_python_versions(index_url: Option<&str>, package: &str, range: &str) -> Result<std::collections::BTreeSet<(u32, u32)>, String> {
    let base = index_url.unwrap_or("https://pypi.org/simple").trim_end_matches('/');
    let url = format!("{base}/{package}/");
    let client = reqwest::blocking::Client::builder()
        .user_agent(crate::app_identity::outgoing_agent!("3.0"))
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP client error: {}", crate::os_error::english(&e)))?;
    let resp = client.get(&url).send().map_err(|e| format!("index request failed: {}", crate::os_error::english(&e)))?;
    if !resp.status().is_success() {
        return Err(format!("index returned HTTP {}", resp.status()));
    }
    let html = resp.text().map_err(|e| format!("index body: {}", crate::os_error::english(&e)))?;
    Ok(python_versions_in_range(&html, package, range))
}

/// The Python versions EVERY package of the install has a wheel for on this
/// index, None when that cannot be told (no packages, an index that does not
/// answer, or one that lists nothing).
///
/// Discord 14.10.2026: only `torch` used to be asked. On the cu130 channel
/// torch and torchvision already ship cp315 wheels, torchaudio stops at
/// cp314, so a Python 3.15 was waved through and pip then ended on "No
/// matching wheel". The versions the whole trio has in common are the ones
/// the install can actually use.
fn served_python_versions(index_url: Option<&str>, packages: &[&str]) -> Option<std::collections::BTreeSet<(u32, u32)>> {
    common_python_versions(packages.iter().map(|package| {
        // The AMD Windows channel serves "torch[device-gfx1201]>=2.13,<2.14":
        // the extra and the range go, so the lookup is against the real package
        // directory, and the range comes along so only the wheels pip may pick
        // are counted. Otherwise a Python that only torch 2.14 serves would
        // pass a check for an install pinned to 2.13.
        let name = torch_wheels::requirement_name(package);
        fetch_index_python_versions(index_url, name, torch_wheels::requirement_range(package)).ok()
    }))
}

/// The pure half of [`served_python_versions`]: None as soon as one package
/// could not be read or lists nothing, otherwise what all of them share.
pub(crate) fn common_python_versions(
    per_package: impl IntoIterator<Item = Option<std::collections::BTreeSet<(u32, u32)>>>,
) -> Option<std::collections::BTreeSet<(u32, u32)>> {
    let mut common: Option<std::collections::BTreeSet<(u32, u32)>> = None;
    for served in per_package {
        let served = served.filter(|s| !s.is_empty())?;
        common = Some(match common {
            None => served,
            Some(c) => c.intersection(&served).copied().collect(),
        });
    }
    common.filter(|c| !c.is_empty())
}

/// One `(path, version)` pair per interpreter `python_interpreters()` found,
/// the version resolved eagerly so both the picker and the message below
/// read it once instead of re-spawning each interpreter a second time.
fn interpreter_inventory() -> Vec<(String, Option<(u32, u32)>)> {
    crate::python::python_interpreters()
        .into_iter()
        .map(|path| {
            let v = python_version_tuple(&path);
            (path, v)
        })
        .collect()
}

fn format_interpreter_lines(interpreters: &[(String, Option<(u32, u32)>)]) -> String {
    if interpreters.is_empty() {
        return "  (none found)".to_string();
    }
    interpreters
        .iter()
        .map(|(path, v)| match v {
            Some((maj, min)) => format!("  - {path} (Python {maj}.{min})"),
            None => format!("  - {path} (version unknown)"),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A candidate interpreter LU is about to pick FOR the customer must itself
/// be capable of the three things the venv path needs: `ssl` (pip talks to
/// the index over https), `venv` (`create_comfyui_venv` builds the venv
/// with it), AND `ensurepip` (`python -m venv` uses it to seed pip into the
/// new venv, and it is what actually fails on Debian/Ubuntu). Review Runde
/// 3, Abschnitt 2: `pyenv install 3.12` without OpenSSL headers passes the
/// version check and, before this, would have been picked automatically,
/// landing the customer on exactly `diagnose_python_ssl`'s "built without
/// the ssl module" sentence (pip.rs:537) after LU chose that interpreter
/// FOR them rather than the customer choosing it themselves.
///
/// Review Runde 4, B7(b): `import ssl, venv` alone missed the Debian/Ubuntu
/// shape entirely. On those distros `venv` ships in the standard library
/// (the module always imports), but `ensurepip` is packaged separately
/// (`python3-venv`), and `python -m venv` fails at exactly that step. The
/// codebase already knows this at four other call sites (venv.rs's own
/// "ensurepip" error-text match, pip.rs's PEP-668 hint, python.rs's
/// PYTHONHOME doc, trainer.rs), but the probe just never asked the same
/// question BEFORE picking the interpreter, only after `python -m venv`
/// had already failed against a venv this code had already committed to.
///
/// `foreign_system_command`, the same adapter `diagnose_python_ssl` itself
/// uses, since this spawns a foreign interpreter, not one of LU's own, and
/// `suppress_window` so the probe does not flash a console per candidate on
/// Windows (review Runde 4, Abschnitt 4). Timed out via
/// [`run_probe_with_timeout`], same reasoning as `python_version_tuple`.
fn python_can_build_a_venv(python_bin: &str) -> bool {
    let mut cmd = crate::process_util::foreign_system_command(python_bin);
    cmd.args(["-c", "import ssl, venv, ensurepip"]);
    crate::process_util::suppress_window(&mut cmd);
    matches!(run_probe_with_timeout(cmd, PYTHON_PROBE_TIMEOUT), Some(out) if out.status.success())
}

/// Review Runde 6, F11: the strict probe above asks for `ensurepip` even at
/// call sites that will never run `python -m venv` with this interpreter at
/// all, namely the interpreter of a venv that ALREADY EXISTS (Install over an
/// existing venv, Update). `ensurepip` is what Debian/Ubuntu package
/// separately (`python3-venv`); a customer who built that venv themselves
/// with `virtualenv` or `uv` never needed `ensurepip` to get it, and this
/// probe used to reject their perfectly working venv for lacking a package
/// LU was never going to use. What those two call sites actually need from
/// the interpreter is that it still runs pip: `ssl` (pip talks to the index
/// over https) and `python -m pip --version` (pip is present and importable
/// as a module, the same form every pip call in this codebase already uses).
fn python_can_use_an_existing_venv(python_bin: &str) -> bool {
    let mut ssl_cmd = crate::process_util::foreign_system_command(python_bin);
    ssl_cmd.args(["-c", "import ssl"]);
    crate::process_util::suppress_window(&mut ssl_cmd);
    let ssl_ok = matches!(run_probe_with_timeout(ssl_cmd, PYTHON_PROBE_TIMEOUT), Some(out) if out.status.success());
    if !ssl_ok {
        return false;
    }
    let mut pip_cmd = crate::process_util::foreign_system_command(python_bin);
    pip_cmd.args(["-m", "pip", "--version"]);
    crate::process_util::suppress_window(&mut pip_cmd);
    matches!(run_probe_with_timeout(pip_cmd, PYTHON_PROBE_TIMEOUT), Some(out) if out.status.success())
}

/// The newest interpreter this machine has for which the live index
/// actually serves a wheel, among the ones `python_interpreters` found,
/// AND that passes `probe` (in production, [`python_can_build_a_venv`]):
/// `None` when nothing qualifies. A version match that fails `probe` is
/// skipped in favor of the next-newest match rather than accepted anyway,
/// so a broken pyenv build never wins just because it happens to be the
/// newest version on the list.
///
/// `probe` is a parameter, not a direct call to `python_can_build_a_venv`,
/// so the ordering/fallback logic is unit-testable with a fake instead of
/// a real interpreter (review Runde 3: "Test mit Attrappe").
pub(crate) fn pick_newest_working_interpreter(
    interpreters: &[(String, Option<(u32, u32)>)],
    supported: &std::collections::BTreeSet<(u32, u32)>,
    mut probe: impl FnMut(&str) -> bool,
) -> Option<String> {
    let mut candidates: Vec<((u32, u32), String)> = interpreters
        .iter()
        .filter_map(|(path, v)| v.filter(|v| supported.contains(v)).map(|v| (v, path.clone())))
        .collect();
    candidates.sort_by_key(|(v, _)| std::cmp::Reverse(*v));
    candidates.into_iter().find(|(_, path)| probe(path)).map(|(_, path)| path)
}

/// The honest end of B1(c): no Settings claim (there is no picker), no
/// invented button. States what was found, what torch actually serves today
/// (from the live query, never a hardcoded table), and a concrete next step
/// that does not name a distro package this code never verified: `uv
/// python install` and `pyenv install` are cross-distro and both take the
/// exact version string already in hand. `python312`-style package names are
/// deliberately NOT suggested: on Arch that name is in the AUR, not pacman,
/// and no other distro's naming was checked either.
///
/// `retry_action`: the literal button the customer actually pressed to get
/// here, so the closing sentence names it truthfully instead of always
/// saying "Repair" (review Runde 4, Abschnitt 2: the Install path used to
/// say "press Repair again" verbatim, lifted from the Repair path, even
/// though the customer had pressed Install and there is no Repair button
/// on that screen at all when nothing is installed yet).
pub(crate) fn no_compatible_interpreter_message(
    current: (u32, u32),
    interpreters: &[(String, Option<(u32, u32)>)],
    supported: &std::collections::BTreeSet<(u32, u32)>,
    retry_action: &str,
) -> String {
    let mut versions: Vec<String> = supported.iter().map(|(a, b)| format!("{a}.{b}")).collect();
    versions.sort();
    let newest = versions.last().cloned().unwrap_or_else(|| "a supported version".to_string());
    format!(
        "This environment's Python is {maj}.{min}, and the PyTorch build LU needs for this \
         machine currently ships wheels only for Python {versions_joined}. LU checked every \
         Python interpreter it could find on this machine and none of them is on that list, so \
         it cannot pick one for you automatically.\n\n\
         Python interpreters LU found:\n{interpreters_block}\n\n\
         Install one of the versions above, for example \"uv python install {newest}\" (uv finds \
         it on its own after that) or \"pyenv install {newest}\" if you use pyenv - not a \
         distro package name, those are not verified here and vary by distro (python312, for \
         example, is on Arch's AUR, not in pacman). Once a supported interpreter is on this \
         machine, {retry_action}; LU finds it and uses it automatically, nothing else to \
         configure.",
        maj = current.0,
        min = current.1,
        versions_joined = versions.join(", "),
        interpreters_block = format_interpreter_lines(interpreters),
        newest = newest,
        retry_action = retry_action,
    )
}

/// What the caller should do about the venv it is about to build (or is
/// already using) for the PyTorch install.
pub(crate) enum TorchPythonDecision {
    /// This interpreter serves torch fine, or the check could not be made
    /// (offline, index unreachable, version probe failed) and therefore
    /// fails open rather than blocking on a network hiccup, same rule as
    /// the old `torch_python_preflight` documented.
    Proceed,
    /// A DIFFERENT interpreter this machine already has serves torch and
    /// `current` does not; the caller should build (or rebuild) the venv
    /// from this path instead: B1(b), no Settings picker, LU decides.
    ///
    /// Both versions travel WITH the decision (Runde 4, B7 "kleiner
    /// Mangel"): a caller that re-queries either interpreter a second time
    /// just to build a message can fail on that second query and fall back
    /// to a made-up `(0, 0)`, and "This ComfyUI's own Python is 0.0" is
    /// exactly the invented number the house rule forbids. Both were
    /// already known here, so they are handed over instead of re-derived.
    UseInstead { path: String, current_version: (u32, u32), chosen_version: (u32, u32) },
    /// Nothing on this machine serves torch for the chosen channel, but LU's
    /// own Python ([`crate::private_python`], 3.12) does: the caller builds
    /// the venv from that one, downloaded once into LU's data folder without
    /// admin rights (Discord 14.10.2026, a machine whose only Python was
    /// 3.15). `own_version` is the pinned version, so a message can name it.
    UseOwn { current_version: (u32, u32), own_version: (u32, u32) },
    /// Nothing on this machine serves torch for the chosen channel, and LU
    /// has no Python of its own for this system either. The message is
    /// ready to show as-is.
    Blocked(String),
}

/// Runde 4, B7(b): at least one interpreter's VERSION matches what torch
/// serves, but none of the version-matching candidates (current interpreter
/// included) could pass the probe. This is a different customer situation
/// from [`no_compatible_interpreter_message`] (which is "no version here
/// serves torch at all") and needs different wording: the version is fine,
/// but the interpreter itself cannot be used.
///
/// Runde 6, F11: which failure this actually is depends on `will_build_venv`.
/// At the two call sites that build (or rebuild) a venv with this
/// interpreter, a failed probe means `python -m venv` itself would fail, and
/// on Debian/Ubuntu that is almost always the separately packaged `venv`
/// support (`python3-venv`, or the minor-specific `python3.X-venv`), the
/// exact package name this codebase already quotes at venv.rs's own
/// `ensurepip` error hint and pip.rs's PEP-668 hint. At the two call sites
/// that only use an ALREADY EXISTING venv (Install over an existing venv,
/// Update), no venv is ever built here, so that package name would be a
/// false lead: what actually failed there is `ssl` or `pip` itself inside a
/// venv nothing here builds.
pub(crate) fn venv_probe_failed_message(
    current: (u32, u32),
    interpreters: &[(String, Option<(u32, u32)>)],
    supported: &std::collections::BTreeSet<(u32, u32)>,
    will_build_venv: bool,
) -> String {
    let mut versions: Vec<String> = supported.iter().map(|(a, b)| format!("{a}.{b}")).collect();
    versions.sort();
    let problem = if will_build_venv {
        "it could not build a new virtual environment with it (a check of that interpreter's \
         own ssl, venv and ensurepip support failed). On Debian or Ubuntu this usually means \
         that Python's venv support is a separate package from Python itself: try \"sudo apt \
         install python3-venv\", or \"python3.<minor>-venv\" for a specific version. On other \
         systems, reinstalling that Python (for example \"pyenv install <version>\" again, or \
         \"uv python install <version>\") usually restores a missing ssl or venv module too."
    } else {
        "its existing virtual environment's own pip no longer works (a check of that \
         interpreter's own ssl and pip support failed). Reinstalling that Python (for example \
         \"pyenv install <version>\" again, or \"uv python install <version>\") usually restores \
         a missing ssl or pip module."
    };
    format!(
        "This environment's Python is {maj}.{min}. LU found a Python version on this machine \
         that PyTorch supports, but {problem} Versions LU's PyTorch build serves: \
         {versions_joined}.\n\nPython interpreters LU found:\n{interpreters_block}",
        maj = current.0,
        min = current.1,
        problem = problem,
        versions_joined = versions.join(", "),
        interpreters_block = format_interpreter_lines(interpreters),
    )
}

/// Runde 3, B1: replaces the old report-only `torch_python_preflight`. Where
/// that function only ever said "this is broken, here is what LU found",
/// this one first asks whether something ELSE LU found would work, and only
/// falls back to the message when nothing does: the Sackgasse Opus found
/// (Runde 2 left the customer at a Settings picker that does not exist).
///
/// Runde 4, B7(a): the ssl/venv/ensurepip probe used to run ONLY on
/// replacement candidates inside `pick_newest_working_interpreter`, never on
/// the interpreter `Proceed` was about to hand back. A system Python whose
/// VERSION matched torch's list, but that was missing `python3-venv`,
/// sailed through as `Proceed` unchecked, and the caller then destroyed the
/// customer's working venv to rebuild one that failed at `python -m venv`
/// itself. `current_python` now goes through the exact same probe as every
/// other candidate before this returns `Proceed`.
///
/// Runde 6, BLOCKER B8 (review Runde 5): Runde 5's fix for B7(a) went too
/// far. It folded `current_python` into the SAME pool every replacement
/// candidate is drawn from and let `pick_newest_working_interpreter` pick
/// the newest version match out of that pool, so a healthy venv on 3.12
/// was told to rebuild the moment a 3.13 also happened to sit on the same
/// machine, even though 3.12 itself served torch fine and passed the probe.
/// That is not what B7(a) asked for: B7(a) only asked that the interpreter
/// LU was about to proceed with be PROBED, not that it be auctioned off
/// against a newer one. The rule is restored here: the interpreter that
/// would be used anyway wins outright the moment it clears both bars
/// (served by the live index, passes the probe), regardless of what else is
/// on the machine. A replacement is only ever looked for once `current_python`
/// itself has failed one of the two.
///
/// Runde 6, F11: `will_build_venv` says whether LU is actually going to run
/// `python -m venv` with `current_python` (Install without an existing venv,
/// Repair, both of which rebuild) or only ever run pip inside a venv that
/// already exists (Install over an existing venv, Update, neither of which
/// touches `python -m venv`). It picks both the probe (ensurepip is required
/// only when a venv will really be built) and the wording of a resulting
/// failure message.
pub(crate) fn choose_torch_python(current_python: &str, index_url: Option<&str>, packages: &[&str], retry_action: &str, will_build_venv: bool) -> TorchPythonDecision {
    let Some(current) = python_version_tuple(current_python) else {
        return TorchPythonDecision::Proceed;
    };
    let Some(supported) = served_python_versions(index_url, packages) else {
        // Empty or unreachable: cannot tell, so do not block (see doc above).
        return TorchPythonDecision::Proceed;
    };
    let probe: fn(&str) -> bool = if will_build_venv { python_can_build_a_venv } else { python_can_use_an_existing_venv };
    // Runde 6, F9 (review Runde 5, Abschnitt 7): `interpreter_inventory()`
    // spawns one subprocess per candidate path `python_interpreters()`
    // finds, and it used to run on EVERY Install/Repair/Update click
    // regardless of outcome, even the common, healthy-path case where
    // `current_python` itself already serves torch and passes the probe
    // (the early return `decide_torch_python` makes below). This mirrors
    // that same check here, before the scan, so a healthy environment never
    // pays for interpreters it was never going to need. `decide_torch_python`
    // keeps its own copy for callers that hand it an already-known
    // `interpreters` list directly (its unit tests, and any future caller
    // that already has one) rather than depending on this early return
    // upstream of it.
    if supported.contains(&current) && probe(current_python) {
        return TorchPythonDecision::Proceed;
    }
    let interpreters = interpreter_inventory();
    decide_torch_python(
        current_python,
        current,
        &supported,
        interpreters,
        retry_action,
        will_build_venv,
        crate::private_python::version_here(),
        probe,
    )
}

/// [`choose_torch_python`] with the machine scan replaced by `current`
/// alone, for the box run in `base_python.rs` (a test machine has other
/// Pythons that must not take part). The live index and the real probe stay.
#[cfg(test)]
pub(crate) fn decide_torch_python_for_box(current_python: &str, current: (u32, u32), index_url: Option<&str>, packages: &[&str]) -> TorchPythonDecision {
    let supported = served_python_versions(index_url, packages).expect("the index answers");
    println!("[box] every package of {packages:?} serves {supported:?}");
    assert!(!supported.contains(&current), "the index serves {current:?} by now, the premise of this run is gone");
    decide_torch_python(
        current_python,
        current,
        &supported,
        vec![(current_python.to_string(), Some(current))],
        "retry",
        true,
        crate::private_python::version_here(),
        python_can_build_a_venv,
    )
}

/// The pure decision core of [`choose_torch_python`], split out so B8's
/// "the interpreter LU would use anyway wins outright" rule is directly
/// testable with a fake probe and a canned interpreter list, without the
/// network fetch [`choose_torch_python`] itself does first. Everything
/// [`choose_torch_python`] does beyond this is resolving `current`'s version
/// and fetching what the live index serves; this is what decides.
///
/// `own` is the version of LU's own Python for this system, None where the
/// pin has no build. It is the last answer, after every interpreter the
/// machine has, and only when the index serves it.
#[allow(clippy::too_many_arguments)]
fn decide_torch_python(
    current_python: &str,
    current: (u32, u32),
    supported: &std::collections::BTreeSet<(u32, u32)>,
    mut interpreters: Vec<(String, Option<(u32, u32)>)>,
    retry_action: &str,
    will_build_venv: bool,
    own: Option<(u32, u32)>,
    mut probe: impl FnMut(&str) -> bool,
) -> TorchPythonDecision {
    if !interpreters.iter().any(|(p, _)| p == current_python) {
        interpreters.insert(0, (current_python.to_string(), Some(current)));
    }

    // B8: the interpreter that would be used anyway (the existing venv's
    // own Python, or today's default before a fresh venv exists) wins the
    // moment its OWN version is served and it passes the probe, no matter
    // whether a newer interpreter also happens to sit on this machine. Only
    // once this fails (wrong version, or the probe itself fails) does LU
    // start looking for a replacement.
    if supported.contains(&current) && probe(current_python) {
        return TorchPythonDecision::Proceed;
    }

    // current_python is out of the running now. Every OTHER interpreter this
    // machine has is the replacement pool; current_python itself is excluded
    // so it is never probed a second time and can never come back out of
    // this search (it already failed the check above).
    let replacement_pool: Vec<(String, Option<(u32, u32)>)> =
        interpreters.iter().filter(|(p, _)| p != current_python).cloned().collect();

    // Computed over the FULL list (current_python included): a version match
    // on current_python that only failed the probe is still "a version
    // matched, but the venv could not be built", the B7(b) story, not "no
    // version here serves torch at all".
    let any_version_match = interpreters.iter().any(|(_, v)| v.is_some_and(|v| supported.contains(&v)));

    let machine = pick_newest_working_interpreter(&replacement_pool, supported, &mut probe);
    match super::base_python::decide(machine, own, |v| supported.contains(&v)) {
        super::base_python::Base::Machine(path) => {
            // Always present: `path` came out of `interpreters` itself, and
            // only entries with a known, version-matching `Some(v)` are
            // ever returned by `pick_newest_working_interpreter`.
            let chosen_version = interpreters
                .iter()
                .find(|(p, _)| *p == path)
                .and_then(|(_, v)| *v)
                .unwrap_or(current);
            TorchPythonDecision::UseInstead { path, current_version: current, chosen_version }
        }
        super::base_python::Base::Own(own_version) => TorchPythonDecision::UseOwn { current_version: current, own_version },
        // Nothing passed both the version check AND the ssl/venv/ensurepip
        // probe. Two different customer stories need two different
        // messages: "torch does not serve any version I have" versus "I
        // have the right version, but it cannot build a venv" (B7(b)).
        super::base_python::Base::Missing if any_version_match => {
            TorchPythonDecision::Blocked(venv_probe_failed_message(current, &interpreters, supported, will_build_venv))
        }
        super::base_python::Base::Missing => {
            TorchPythonDecision::Blocked(no_compatible_interpreter_message(current, &interpreters, supported, retry_action))
        }
    }
}

/// Runde 4, B3: the message for a venv that ALREADY EXISTS and is not
/// silently rebuilt (it may be a venv the customer built by hand, or one
/// carrying custom nodes' own state - B1(b)'s reasoning for never touching
/// it without being asked). Unlike [`no_compatible_interpreter_message`],
/// there IS a fix that does not require the customer to install anything:
/// `python_bin`/`chosen` came from [`TorchPythonDecision::UseInstead`],
/// meaning LU already found a working interpreter elsewhere on this
/// machine. "Repair environment" (`repair_comfyui_env`) rebuilds the venv
/// from LU's own interpreter choice without touching `models/` or
/// `custom_nodes/`, so that is the concrete button this message can name,
/// not a manual command.
pub(crate) fn existing_venv_needs_repair_message(current: (u32, u32), chosen_path: &str, chosen: (u32, u32)) -> String {
    format!(
        "This ComfyUI's own Python is {cmaj}.{cmin}, and the PyTorch build LU needs for this \
         machine does not ship wheels for that version. LU found a Python it CAN use on this \
         machine already: {chosen_path} (Python {chmaj}.{chmin}).\n\n\
         This venv is not rebuilt automatically here, since it may be one you built yourself or \
         one holding custom nodes' own state. Press \"Repair environment\" in Settings: it \
         rebuilds ComfyUI's venv from that interpreter and leaves models and custom nodes \
         untouched, only the venv folder itself is replaced.",
        cmaj = current.0,
        cmin = current.1,
        chmaj = chosen.0,
        chmin = chosen.1,
    )
}

/// Runde 5 (review Runde 4, Abschnitt 3): what the existing-venv branch of
/// `comfy_install.rs` does with a `TorchPythonDecision`, pulled out into a
/// pure function so it is directly testable without network access, disk
/// state, or a running install thread. The reviewer's own point stands
/// without this: "wer `return;` im `UseInstead`-Arm entfernt, laedt wieder 2
/// GB in die falsche venv, und der Waechter bleibt gruen": a source-order
/// needle test can pin where the call happens, but only a test that actually
/// EXERCISES this mapping can catch the `return;` itself going missing. `Ok`
/// only for `Proceed`; both `UseInstead` and `Blocked` are `Err`, on purpose,
/// since this venv is never rebuilt here and switching interpreters under it
/// unasked would be silently wrong.
pub(crate) fn python_for_existing_venv(decision: TorchPythonDecision, venv_py: &str) -> Result<String, String> {
    match decision {
        TorchPythonDecision::Proceed => Ok(venv_py.to_string()),
        TorchPythonDecision::UseInstead { path, current_version, chosen_version } => {
            Err(existing_venv_needs_repair_message(current_version, &path, chosen_version))
        }
        TorchPythonDecision::UseOwn { current_version, own_version } => {
            Err(existing_venv_needs_own_python_message(current_version, own_version))
        }
        TorchPythonDecision::Blocked(msg) => Err(msg),
    }
}

/// The existing venv runs on a Python PyTorch has no wheels for, nothing else
/// on this machine does better, and LU's own Python would. The venv is not
/// rebuilt here (same reasoning as [`existing_venv_needs_repair_message`]),
/// so the sentence names the button that does it.
pub(crate) fn existing_venv_needs_own_python_message(current: (u32, u32), own: (u32, u32)) -> String {
    format!(
        "This ComfyUI's own Python is {cmaj}.{cmin}, and the PyTorch build LU needs for this \
         machine does not ship wheels for that version yet. LU can fix this itself: press \
         \"Repair environment\" in Settings. It rebuilds ComfyUI's venv with LU's own Python \
         {omaj}.{omin} (downloaded once into LU's folder, no administrator rights needed, the \
         Pythons already on this machine stay as they are) and leaves models and custom nodes \
         untouched.",
        cmaj = current.0,
        cmin = current.1,
        omaj = own.0,
        omin = own.1,
    )
}

/// What Install and Repair build a NEW venv from, after
/// [`choose_torch_python`] has decided. Both used to carry this match each,
/// word for word; the own Python is a fourth answer and it needs the
/// download, so it lives once here. `say` writes one line into the panel.
///
/// Every answer that is not `Blocked` goes through
/// [`super::base_python::machine_or_own`], the same function the trainer
/// uses, so "a Python of the machine, else LU's own" is decided in one place.
/// `Err("cancelled")` is a Stop during the download.
pub(crate) fn base_for_new_venv(
    decision: TorchPythonDecision,
    default_python: &str,
    progress: &dyn crate::private_python::Progress,
    say: &dyn Fn(&str),
) -> Result<String, String> {
    match decision {
        TorchPythonDecision::Proceed => Ok(default_python.to_string()),
        TorchPythonDecision::UseInstead { path, chosen_version, .. } => {
            say(&format!(
                "The default Python ({default_python}) does not have a PyTorch wheel for this \
                 machine yet; using {path} instead, found on this machine already."
            ));
            let served = move |v: (u32, u32)| v == chosen_version;
            super::base_python::machine_or_own(Some(path), served, progress, super::base_python::FOR_PYTORCH)
                .map(|p| p.unwrap_or_default())
        }
        TorchPythonDecision::UseOwn { current_version, own_version } => {
            say(&format!(
                "No Python on this machine has a PyTorch wheel for it yet (the default one is \
                 {}.{}), so LU sets up its own Python {}.{} for ComfyUI. The Pythons already \
                 installed stay as they are.",
                current_version.0, current_version.1, own_version.0, own_version.1
            ));
            match super::base_python::machine_or_own(None, |v| v == own_version, progress, super::base_python::FOR_PYTORCH)? {
                Some(path) => Ok(path),
                None => Err("LU has no Python of its own for this system.".to_string()),
            }
        }
        TorchPythonDecision::Blocked(msg) => Err(msg),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── GH #211 ────────────────────────────────────────────────────────────

    #[test]
    fn the_pip_of_python_3_10_11_is_lifted_before_torch() {
        let line = "pip 23.0.1 from C:\\Users\\User\\ComfyUI\\venv\\lib\\site-packages\\pip (python 3.10)";
        assert_eq!(pip_major_from_version_line(line), Some(23));
        let args = pip_upgrade_before_torch_args(Some(line)).expect("pip 23 is lifted");
        assert_eq!(&args[..3], ["-m", "pip", "install"]);
        assert!(args.iter().any(|a| a == "--upgrade"));
        assert_eq!(args.last().map(String::as_str), Some("pip>=24.0"));
        assert!(!args.iter().any(|a| a.contains("index-url")), "pip comes from PyPI: {args:?}");
        // 23.1 fails the same way on the Mac.
        assert!(pip_upgrade_before_torch_args(Some("pip 23.1 from /x (python 3.10)")).is_some());
    }

    #[test]
    fn a_pip_that_reads_the_index_is_left_alone() {
        assert_eq!(pip_upgrade_before_torch_args(Some("pip 24.0 from /x (python 3.12)")), None);
        assert_eq!(pip_upgrade_before_torch_args(Some("pip 26.0.1 from /x (python 3.13)")), None);
        assert_eq!(pip_upgrade_before_torch_args(None), None);
        assert_eq!(pip_upgrade_before_torch_args(Some("No module named pip")), None);
    }

    // ── PyTorch-Kanalwahl (W2-Befund 16.08., comfy_kitchen braucht 2.6+) ─

    #[test]
    fn pytorch_index_rides_living_channels() {
        use crate::commands::torch_wheels::{comfy_wheel_plan, WheelPlan};
        let first = |nv, cap, amd, os| match comfy_wheel_plan(nv, cap, amd, &[], os) {
            WheelPlan::Index { candidates, .. } => Some(candidates[0]),
            WheelPlan::IndexOrCpu { candidates, .. } => Some(candidates[0]),
            WheelPlan::Cpu { .. } => None,
        };
        assert_eq!(
            first(true, Some((12, 0)), false, "windows"),
            Some("https://download.pytorch.org/whl/cu130")
        );
        assert_eq!(
            first(true, Some((8, 6)), false, "windows"),
            Some("https://download.pytorch.org/whl/cu130")
        );
        assert_eq!(
            first(true, None, false, "windows"),
            Some("https://download.pytorch.org/whl/cu126")
        );
        assert_eq!(first(false, None, false, "linux"), None);
    }

    #[test]
    fn pytorch_index_never_picks_the_frozen_cu121_channel() {
        // Negative control: cu121 is stuck at torch 2.5.1, which current
        // ComfyUI cores reject at import (comfy_kitchen infer_schema).
        use crate::commands::torch_wheels::{comfy_wheel_plan, WheelPlan};
        for (nv, cap) in [
            (true, Some((6, 1))),
            (true, Some((7, 0))),
            (true, Some((7, 5))),
            (true, Some((8, 6))),
            (true, Some((9, 0))),
            (true, Some((12, 0))),
            (true, None),
        ] {
            if let WheelPlan::Index { candidates, .. } = comfy_wheel_plan(nv, cap, false, &[], "linux") {
                assert!(
                    !candidates.iter().any(|c| c.contains("cu121")),
                    "frozen channel chosen for cap {:?}",
                    cap
                );
            }
        }
    }

    // ── PyTorch-Args, geteilt zwischen Install und Repair (GH #98) ──────

    #[test]
    fn pytorch_args_carry_the_wheel_index_when_given() {
        use crate::commands::torch_wheels::TORCH_TRIO;
        let args = pytorch_pip_args(Some("https://download.pytorch.org/whl/cu128"), TORCH_TRIO);
        assert_eq!(args.first().map(String::as_str), Some("-m"));
        assert!(args.contains(&"torch".to_string()));
        assert!(args.contains(&"torchvision".to_string()));
        assert!(args.contains(&"torchaudio".to_string()));
        assert!(args.contains(&"--no-input".to_string()));
        let idx = args.iter().position(|a| a == "--index-url").expect("index flag");
        assert_eq!(args.get(idx + 1).map(String::as_str), Some("https://download.pytorch.org/whl/cu128"));
    }

    #[test]
    fn pytorch_args_without_index_stay_on_pypi() {
        use crate::commands::torch_wheels::TORCH_TRIO;
        let args = pytorch_pip_args(None, TORCH_TRIO);
        assert!(!args.iter().any(|a| a == "--index-url"));
        assert!(args.contains(&"torch".to_string()));
    }

    #[test]
    fn pytorch_args_pass_a_channels_own_package_names_through_untouched() {
        // AMD's Windows index serves torch behind a device extra. pip has to
        // see "torch[device-gfx1201]>=2.13,<2.14" verbatim; a bare "torch" from
        // that index is an environment with no kernels for any card.
        use crate::commands::torch_wheels::{amd_windows_packages, ROCM_WINDOWS_CHANNELS, TORCH_TRIO};
        let pkgs = amd_windows_packages(&["gfx1201"]);
        let refs: Vec<&str> = pkgs.iter().map(String::as_str).collect();
        let args = pytorch_pip_args(Some(ROCM_WINDOWS_CHANNELS[0]), &refs);
        assert!(args.contains(&"torch[device-gfx1201]>=2.13,<2.14".to_string()), "{args:?}");
        assert!(args.contains(&"torchvision[device-gfx1201]>=0.28,<0.29".to_string()), "{args:?}");
        assert!(args.contains(&"torchaudio>=2.11,<2.12".to_string()), "{args:?}");
        // NEGATIVE CONTROL: the extra is never bolted onto the normal channels.
        let plain = pytorch_pip_args(Some("https://download.pytorch.org/whl/cu130"), TORCH_TRIO);
        assert!(!plain.iter().any(|a| a.contains('[')), "{plain:?}");
    }

    // ── 3.0.8: the Python check counts only the wheels pip may pick ───────

    /// A cut of AMD's whl-next torch page as served on 2026-10-20, hrefs
    /// URL-encoded and link text plain, the way the index writes both.
    const AMD_TORCH_PAGE: &str = concat!(
        r#"<a href="torch-2.13.0%2Brocm10.1.0-cp312-cp312-win_amd64.whl">torch-2.13.0+rocm10.1.0-cp312-cp312-win_amd64.whl</a>"#,
        r#"<a href="torch-2.13.0%2Brocm10.1.0-cp313-cp313-win_amd64.whl">torch-2.13.0+rocm10.1.0-cp313-cp313-win_amd64.whl</a>"#,
        r#"<a href="torch-2.14.0%2Brocm10.1.0-cp310-cp310-win_amd64.whl">torch-2.14.0+rocm10.1.0-cp310-cp310-win_amd64.whl</a>"#,
        r#"<a href="torch-2.14.0%2Brocm10.1.0-cp314-cp314-win_amd64.whl">torch-2.14.0+rocm10.1.0-cp314-cp314-win_amd64.whl</a>"#,
    );

    #[test]
    fn the_python_check_counts_only_wheels_inside_the_pinned_series() {
        let all = python_versions_in_range(AMD_TORCH_PAGE, "torch", "");
        assert!(all.contains(&(3, 10)) && all.contains(&(3, 14)), "{all:?}");
        let pinned = python_versions_in_range(AMD_TORCH_PAGE, "torch", ">=2.13,<2.14");
        assert_eq!(pinned.into_iter().collect::<Vec<_>>(), vec![(3, 12), (3, 13)]);
        // NEGATIVE CONTROL: a range nothing on the page satisfies yields nothing
        assert!(python_versions_in_range(AMD_TORCH_PAGE, "torch", ">=2.15").is_empty());
    }

    #[test]
    fn the_version_range_reads_local_labels_and_the_two_operators() {
        assert!(version_in_range("2.13.0+rocm10.1.0", ">=2.13,<2.14"));
        assert!(!version_in_range("2.14.0+rocm10.1.0", ">=2.13,<2.14"));
        assert!(!version_in_range("2.12.0+rocm10.1.0", ">=2.13,<2.14"));
        assert!(version_in_range("0.28.0", ">=0.28,<0.29"));
        assert!(version_in_range("2.11.0.3", ">=2.11,<2.12"));
        assert!(version_in_range("9.9", ""));
    }

    #[test]
    fn a_requirement_splits_into_name_and_range() {
        use crate::commands::torch_wheels::{requirement_name, requirement_range};
        assert_eq!(requirement_name("torch[device-gfx1201]>=2.13,<2.14"), "torch");
        assert_eq!(requirement_range("torch[device-gfx1201]>=2.13,<2.14"), ">=2.13,<2.14");
        assert_eq!(requirement_name("torchaudio>=2.11,<2.12"), "torchaudio");
        assert_eq!(requirement_range("torchaudio>=2.11,<2.12"), ">=2.11,<2.12");
        assert_eq!(requirement_name("torch"), "torch");
        assert_eq!(requirement_range("torch"), "");
    }

    // ── parse_compute_cap_output (Bug #10 — Blackwell PyTorch routing) ────

    #[test]
    fn compute_cap_parses_ampere_single_gpu() {
        assert_eq!(parse_compute_cap_output("8.6\n"), Some((8, 6)));
    }

    #[test]
    fn compute_cap_parses_ada_single_gpu() {
        assert_eq!(parse_compute_cap_output("8.9\n"), Some((8, 9)));
    }

    #[test]
    fn compute_cap_parses_hopper() {
        assert_eq!(parse_compute_cap_output("9.0\n"), Some((9, 0)));
    }

    #[test]
    fn compute_cap_parses_blackwell() {
        assert_eq!(parse_compute_cap_output("12.0\n"), Some((12, 0)));
    }

    #[test]
    fn compute_cap_multi_gpu_picks_highest() {
        assert_eq!(parse_compute_cap_output("8.6\n12.0\n"), Some((12, 0)));
        // Same major, so only the minor can decide which of the two cards
        // the one PyTorch build has to satisfy.
        assert_eq!(parse_compute_cap_output("7.0\n7.5\n"), Some((7, 5)));
        assert_eq!(parse_compute_cap_output("7.5\n7.0\n"), Some((7, 5)));
    }

    #[test]
    fn compute_cap_survives_a_line_without_a_minor() {
        // Negative control for the new minor parse: a bare major must keep
        // the card rather than drop it, and read as .0.
        assert_eq!(parse_compute_cap_output("8\n"), Some((8, 0)));
        assert_eq!(parse_compute_cap_output("8.x\n"), Some((8, 0)));
    }

    #[test]
    fn compute_cap_handles_blank_lines() {
        assert_eq!(parse_compute_cap_output("\n8.6\n\n"), Some((8, 6)));
    }

    #[test]
    fn compute_cap_returns_none_for_empty_output() {
        assert_eq!(parse_compute_cap_output(""), None);
    }

    #[test]
    fn compute_cap_skips_unparseable_lines() {
        assert_eq!(parse_compute_cap_output("[Not Supported]\n8.6\n"), Some((8, 6)));
    }

    // ── Runde 2, Nachbesserung 12: torch/Python preflight ────────────────

    #[test]
    fn version_tuple_parses_the_usual_shape() {
        assert_eq!(parse_version_tuple("3.14"), Some((3, 14)));
        assert_eq!(parse_version_tuple("3.9"), Some((3, 9)));
        assert_eq!(parse_version_tuple(""), None);
        assert_eq!(parse_version_tuple("garbage"), None);
    }

    /// A trimmed but structurally real PEP 503 index page, the shape both
    /// pypi.org/simple and download.pytorch.org/whl/<channel> serve: one
    /// `<a>` per wheel file, cp-tagged twice (Python tag, then ABI tag).
    const SAMPLE_INDEX_HTML: &str = r#"<!DOCTYPE html>
<html><body>
<a href="torch-2.7.0-cp310-cp310-manylinux_2_28_x86_64.whl">torch-2.7.0-cp310-cp310-manylinux_2_28_x86_64.whl</a>
<a href="torch-2.7.0-cp311-cp311-manylinux_2_28_x86_64.whl">torch-2.7.0-cp311-cp311-manylinux_2_28_x86_64.whl</a>
<a href="torch-2.7.0-cp312-cp312-manylinux_2_28_x86_64.whl">torch-2.7.0-cp312-cp312-manylinux_2_28_x86_64.whl</a>
<a href="torch-2.7.0-cp313-cp313-manylinux_2_28_x86_64.whl">torch-2.7.0-cp313-cp313-manylinux_2_28_x86_64.whl</a>
<a href="torch-2.6.0-cp39-cp39-manylinux_2_28_x86_64.whl">torch-2.6.0-cp39-cp39-manylinux_2_28_x86_64.whl</a>
</body></html>"#;

    #[test]
    fn index_html_yields_every_python_version_the_channel_actually_serves() {
        let versions = python_versions_from_index_html(SAMPLE_INDEX_HTML);
        assert_eq!(
            versions,
            [(3, 9), (3, 10), (3, 11), (3, 12), (3, 13)].into_iter().collect()
        );
        // Python 3.14 is deliberately NOT in the sample: this is the exact
        // shape of the gap the preflight exists to catch (Punkt 12).
        assert!(!versions.contains(&(3, 14)));
    }

    #[test]
    fn index_html_with_no_wheels_yields_an_empty_set_not_a_panic() {
        assert!(python_versions_from_index_html("<html><body>nothing here</body></html>").is_empty());
        assert!(python_versions_from_index_html("").is_empty());
    }

    /// Negative control for the parser: a bare `cp312` with no repeated ABI
    /// tag (not a real wheel filename shape) must NOT be picked up. A parser
    /// that matched anything containing "cp3\d\d" would also fire on a stray
    /// digit sequence inside a URL query string or directory name.
    #[test]
    fn a_lone_cp_tag_without_the_repeated_abi_tag_is_not_counted() {
        let html = r#"<a href="/cp312/some-other-thing">not a wheel</a>"#;
        assert!(python_versions_from_index_html(html).is_empty());
    }

    // ── Runde 3, B1: auto-selection instead of a Settings picker ────────

    fn supported_3_10_through_13() -> std::collections::BTreeSet<(u32, u32)> {
        [(3, 10), (3, 11), (3, 12), (3, 13)].into_iter().collect()
    }

    /// Always-true stand-in for `python_can_build_a_venv` where a test only
    /// cares about version matching, not the ssl/venv probe.
    fn always_works(_: &str) -> bool {
        true
    }

    /// Required test from the coordinator's Runde 3 instructions: only 3.14
    /// on the box, nothing torch serves today, message required.
    #[test]
    fn only_3_14_present_yields_no_pick_and_a_message() {
        let interpreters = vec![("/usr/bin/python3".to_string(), Some((3, 14)))];
        let supported = supported_3_10_through_13();
        assert_eq!(pick_newest_working_interpreter(&interpreters, &supported, always_works), None);
        let msg = no_compatible_interpreter_message((3, 14), &interpreters, &supported, "press Repair again");
        assert!(msg.contains("3.14"), "{msg}");
        assert!(msg.contains("3.10, 3.11, 3.12, 3.13"), "{msg}");
        assert!(msg.contains("uv python install 3.13"), "{msg}");
        assert!(msg.contains("pyenv install 3.13"), "{msg}");
        assert!(msg.contains("Repair"), "{msg}");
        // B1(c): no Settings claim, no distro package name asserted as real.
        assert!(!msg.to_lowercase().contains("settings"), "{msg}");
        assert!(!msg.contains("pacman -S"), "{msg}");
        assert!(!msg.contains("apt install"), "{msg}");
    }

    /// Required test from the coordinator's Runde 3 instructions: 3.14 plus
    /// 3.12 (the pyenv shape) on the box picks 3.12 silently, no message.
    #[test]
    fn a_14_plus_pyenv_12_picks_12_without_a_message() {
        let interpreters = vec![
            ("/usr/bin/python3".to_string(), Some((3, 14))),
            (
                "/home/user/.pyenv/versions/3.12.7/bin/python3".to_string(),
                Some((3, 12)),
            ),
        ];
        let supported = supported_3_10_through_13();
        assert_eq!(
            pick_newest_working_interpreter(&interpreters, &supported, always_works),
            Some("/home/user/.pyenv/versions/3.12.7/bin/python3".to_string())
        );
    }

    /// Two compatible interpreters: the NEWEST one wins, not the first one
    /// `python_interpreters()` happened to list.
    #[test]
    fn the_newest_compatible_interpreter_wins_over_an_older_one() {
        let interpreters = vec![
            ("/usr/bin/python3.10".to_string(), Some((3, 10))),
            ("/usr/local/bin/python3.13".to_string(), Some((3, 13))),
            ("/usr/bin/python3.11".to_string(), Some((3, 11))),
        ];
        let supported = supported_3_10_through_13();
        assert_eq!(
            pick_newest_working_interpreter(&interpreters, &supported, always_works),
            Some("/usr/local/bin/python3.13".to_string())
        );
    }

    /// An interpreter whose version could not be read (`None`) must never be
    /// picked, and must never panic the sort/comparison.
    #[test]
    fn an_interpreter_with_an_unknown_version_is_never_picked() {
        let interpreters = vec![
            ("/broken/python".to_string(), None),
            ("/usr/bin/python3.12".to_string(), Some((3, 12))),
        ];
        let supported = supported_3_10_through_13();
        assert_eq!(
            pick_newest_working_interpreter(&interpreters, &supported, always_works),
            Some("/usr/bin/python3.12".to_string())
        );
    }

    /// Runde 4, Nachbesserung (review Runde 3, Abschnitt 2, "Test mit
    /// Attrappe"): a version-matching candidate that fails the ssl/venv
    /// probe (a pyenv build without OpenSSL, say) must be skipped in favor
    /// of the next-newest match, not picked anyway just because its version
    /// is newest. The fake probe stands in for `python_can_build_a_venv`.
    #[test]
    fn a_version_match_that_fails_the_ssl_venv_probe_is_skipped_for_the_next_newest() {
        let interpreters = vec![
            ("/home/user/.pyenv/versions/3.13.0/bin/python3".to_string(), Some((3, 13))),
            ("/usr/bin/python3.11".to_string(), Some((3, 11))),
        ];
        let supported = supported_3_10_through_13();
        // The dummy: the "newest" 3.13 build cannot import ssl/venv, so it
        // must be rejected even though it is the highest version match.
        let broken_pyenv_313 = "/home/user/.pyenv/versions/3.13.0/bin/python3";
        let probe = |path: &str| path != broken_pyenv_313;
        assert_eq!(
            pick_newest_working_interpreter(&interpreters, &supported, probe),
            Some("/usr/bin/python3.11".to_string())
        );
    }

    /// Negative control: if EVERY version match fails the probe, nothing is
    /// picked at all, same as no compatible interpreter existing.
    #[test]
    fn every_version_match_failing_the_probe_yields_no_pick() {
        let interpreters = vec![("/broken/pyenv/python3.12".to_string(), Some((3, 12)))];
        let supported = supported_3_10_through_13();
        assert_eq!(pick_newest_working_interpreter(&interpreters, &supported, |_| false), None);
    }

    /// Runde 4, B3: the message for an EXISTING venv that is not rebuilt
    /// automatically must name the button that actually fixes it
    /// ("Repair environment"), not a manual command, since LU already found
    /// a working interpreter elsewhere.
    #[test]
    fn existing_venv_message_names_repair_not_a_manual_command() {
        let msg = existing_venv_needs_repair_message((3, 14), "/home/user/.pyenv/versions/3.12.7/bin/python3", (3, 12));
        assert!(msg.contains("3.14"), "{msg}");
        assert!(msg.contains("3.12"), "{msg}");
        assert!(msg.contains("/home/user/.pyenv/versions/3.12.7/bin/python3"), "{msg}");
        assert!(msg.contains("Repair environment"), "{msg}");
        assert!(!msg.to_lowercase().contains("uv python install"), "{msg}");
        assert!(!msg.to_lowercase().contains("settings, ai"), "{msg}");
    }

    #[test]
    fn no_interpreters_at_all_still_yields_a_readable_message() {
        let msg = no_compatible_interpreter_message((3, 14), &[], &supported_3_10_through_13(), "press Repair again");
        assert!(msg.contains("(none found)"), "{msg}");
    }

    // ── Runde 5 (review Runde 4, Abschnitt 3): the UseInstead-arm behavior
    // test the reviewer asked for, on `python_for_existing_venv` rather than
    // on `comfy_install.rs` itself, since that function is a Tauri command
    // thread and cannot be driven from here. Whoever deletes the `return;`
    // that guards the download in comfy_install.rs also has to route the
    // decision through something other than this function to keep it green,
    // which is exactly the point: this is what must go red first.

    #[test]
    fn proceed_keeps_the_venv_python_unchanged() {
        let out = python_for_existing_venv(TorchPythonDecision::Proceed, "/venv/bin/python3");
        assert_eq!(out, Ok("/venv/bin/python3".to_string()));
    }

    #[test]
    fn use_instead_on_an_existing_venv_never_returns_a_python_to_install_into() {
        // This is the exact case B3/Runde 4 was about: an existing venv on a
        // Python PyTorch does not serve. Whatever calls this must NOT get a
        // path back to install into, or the 2 GB download runs into the
        // wrong (or broken) environment again with the guard staying green.
        let decision = TorchPythonDecision::UseInstead {
            path: "/home/user/.pyenv/versions/3.12.7/bin/python3".to_string(),
            current_version: (3, 14),
            chosen_version: (3, 12),
        };
        let out = python_for_existing_venv(decision, "/venv/bin/python3");
        let msg = out.expect_err("UseInstead on an existing venv must not yield a Python to install into");
        assert!(msg.contains("Repair environment"), "{msg}");
        assert!(msg.contains("3.14"), "{msg}");
        assert!(msg.contains("3.12"), "{msg}");
    }

    #[test]
    fn blocked_on_an_existing_venv_also_refuses() {
        let out = python_for_existing_venv(TorchPythonDecision::Blocked("no compatible interpreter".to_string()), "/venv/bin/python3");
        assert_eq!(out, Err("no compatible interpreter".to_string()));
    }

    // ── Runde 6, BLOCKER B8 (review Runde 5): the interpreter LU would use
    // anyway must win outright once it clears both bars, even if a NEWER
    // interpreter also sits on the machine. Runde 5's fix let the newest
    // version match win the pool instead, which broke Install and Update on
    // every perfectly healthy environment that happened to share a machine
    // with a newer Python.

    #[test]
    fn a_healthy_venv_python_proceeds_even_with_a_newer_python_on_the_box() {
        // The exact Beweis the task names: a healthy 3.12 venv, plus a 3.13
        // also found on the machine. Both pass the probe. Must Proceed with
        // 3.12, never UseInstead the newer one.
        let interpreters = vec![
            ("/comfy/venv/bin/python3".to_string(), Some((3, 12))),
            ("/usr/bin/python3.13".to_string(), Some((3, 13))),
        ];
        let supported = supported_3_10_through_13();
        let decision = decide_torch_python(
            "/comfy/venv/bin/python3",
            (3, 12),
            &supported,
            interpreters,
            "press Repair environment again",
            true,
            None,
            always_works,
        );
        assert!(
            matches!(decision, TorchPythonDecision::Proceed),
            "a healthy venv python must proceed even next to a newer interpreter"
        );
    }

    /// Negative control: swap which one is "current" and the answer flips
    /// with it. If `decide_torch_python` always returned `Proceed` for
    /// whichever path merely appears first, or always preferred the newest
    /// version regardless of which one is current, this would not catch it;
    /// together the two tests pin that the OUTCOME follows `current_python`,
    /// not the pool's shape.
    #[test]
    fn a_venv_on_an_unserved_version_still_gets_use_instead() {
        let interpreters = vec![
            ("/comfy/venv/bin/python3".to_string(), Some((3, 14))),
            ("/usr/bin/python3.12".to_string(), Some((3, 12))),
        ];
        let supported = supported_3_10_through_13();
        let decision = decide_torch_python(
            "/comfy/venv/bin/python3",
            (3, 14),
            &supported,
            interpreters,
            "press Repair environment again",
            true,
            None,
            always_works,
        );
        match decision {
            TorchPythonDecision::UseInstead { path, .. } => {
                assert_eq!(path, "/usr/bin/python3.12");
            }
            _ => panic!("a venv on an unserved version must not Proceed"),
        }
    }

    #[test]
    fn current_python_that_fails_the_probe_is_not_probed_a_second_time_as_a_replacement() {
        // current_python fails the probe exactly once (the mandatory B7(a)
        // check); it must never be handed to the probe a second time while
        // searching for a replacement. A count of how many times it was
        // probed pins this without assuming call order.
        let current = "/comfy/venv/bin/python3";
        let interpreters = vec![
            (current.to_string(), Some((3, 12))),
            ("/usr/bin/python3.11".to_string(), Some((3, 11))),
        ];
        let supported = supported_3_10_through_13();
        let mut current_probe_count = 0u32;
        let probe = |path: &str| {
            if path == current {
                current_probe_count += 1;
            }
            path != current
        };
        let decision = decide_torch_python(current, (3, 12), &supported, interpreters, "retry", true, None, probe);
        match decision {
            TorchPythonDecision::UseInstead { path, .. } => assert_eq!(path, "/usr/bin/python3.11"),
            _ => panic!("expected UseInstead"),
        }
        assert_eq!(current_probe_count, 1, "current_python must be probed exactly once, not re-tried as a replacement");
    }

    #[test]
    fn a_probe_failure_on_current_with_no_replacement_yields_the_venv_probe_failed_message() {
        // B7(b)'s message, still reachable after B8: current's version is
        // served, but it alone fails ssl/venv/ensurepip, and nothing else on
        // the machine has a matching version either.
        let current = "/comfy/venv/bin/python3";
        let interpreters = vec![(current.to_string(), Some((3, 12)))];
        let supported = supported_3_10_through_13();
        let decision = decide_torch_python(current, (3, 12), &supported, interpreters, "retry", true, None, |_| false);
        match decision {
            TorchPythonDecision::Blocked(msg) => {
                assert!(msg.contains("ssl, venv and ensurepip"), "{msg}");
            }
            _ => panic!("expected Blocked with the venv-probe-failed wording"),
        }
    }

    // ── Runde 6, F11 (review Runde 6, Abschnitt 2): the strict venv-build
    // probe (`import ssl, venv, ensurepip`) used to run even at call sites
    // that never build a venv with this interpreter at all (Update, Install
    // over an existing venv), rejecting a perfectly healthy, hand-built venv
    // on Debian/Ubuntu just because `python3-venv` (which ships `ensurepip`
    // separately there) was never installed. A fake interpreter that mirrors
    // exactly that shape (ssl and pip both work, `ensurepip` does not) proves
    // the light probe accepts it while the strict one still, correctly,
    // rejects it.

    #[cfg(not(windows))]
    fn write_fake_python_missing_ensurepip(dir: &std::path::Path) -> String {
        let path = dir.join("fake-python-no-ensurepip.sh");
        crate::test_support::write_script(
            &path,
            "#!/bin/sh\n\
             if [ \"$1\" = \"-c\" ]; then\n\
             case \"$2\" in\n\
             *ensurepip*) exit 1 ;;\n\
             *) exit 0 ;;\n\
             esac\n\
             fi\n\
             if [ \"$1\" = \"-m\" ] && [ \"$2\" = \"pip\" ]; then\n\
             echo \"pip 24.0\"\n\
             exit 0\n\
             fi\n\
             exit 1\n",
        );
        path.to_string_lossy().to_string()
    }

    #[cfg(windows)]
    fn write_fake_python_missing_ensurepip(dir: &std::path::Path) -> String {
        let path = dir.join("fake-python-no-ensurepip.bat");
        std::fs::write(
            &path,
            "@echo off\r\n\
             echo %* | findstr /C:\"ensurepip\" >nul\r\n\
             if %errorlevel%==0 exit /b 1\r\n\
             echo %* | findstr /C:\"-m pip\" >nul\r\n\
             if %errorlevel%==0 (\r\n\
             echo pip 24.0\r\n\
             exit /b 0\r\n\
             )\r\n\
             echo %* | findstr /C:\"-c\" >nul\r\n\
             if %errorlevel%==0 exit /b 0\r\n\
             exit /b 1\r\n",
        )
        .unwrap();
        path.to_string_lossy().to_string()
    }

    #[cfg(not(windows))]
    fn write_fake_python_without_ssl(dir: &std::path::Path) -> String {
        let path = dir.join("fake-python-no-ssl.sh");
        crate::test_support::write_script(&path, "#!/bin/sh\nexit 1\n");
        path.to_string_lossy().to_string()
    }

    #[cfg(windows)]
    fn write_fake_python_without_ssl(dir: &std::path::Path) -> String {
        let path = dir.join("fake-python-no-ssl.bat");
        std::fs::write(&path, "@echo off\r\nexit /b 1\r\n").unwrap();
        path.to_string_lossy().to_string()
    }

    #[test]
    fn python_can_use_an_existing_venv_accepts_an_interpreter_missing_ensurepip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = write_fake_python_missing_ensurepip(dir.path());
        assert!(python_can_use_an_existing_venv(&fake), "the light probe must accept an interpreter whose pip still works");
        // Negative control: the strict venv-build probe must still reject
        // this exact same interpreter, otherwise the two probes are not
        // actually different and F11 changed nothing.
        assert!(!python_can_build_a_venv(&fake), "the strict probe must still reject a missing ensurepip");
    }

    #[test]
    fn python_can_use_an_existing_venv_still_rejects_a_dead_interpreter() {
        // Negative control on the other axis: an interpreter that cannot
        // even import ssl must be rejected by BOTH probes, light or strict.
        // Without this, "light" could be read as "always true".
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = write_fake_python_without_ssl(dir.path());
        assert!(!python_can_use_an_existing_venv(&fake));
        assert!(!python_can_build_a_venv(&fake));
    }

    #[test]
    fn a_missing_ensurepip_probe_failure_on_an_existing_venv_does_not_mention_venv_building() {
        // The wording, not just the probe, must be honest at a call site
        // that never builds a venv: this failure is "pip inside your venv is
        // broken", not "LU could not build a new virtual environment",
        // which would be a false lead for a customer who never asked LU to
        // build anything.
        let current = "/comfy/venv/bin/python3";
        let interpreters = vec![(current.to_string(), Some((3, 12)))];
        let supported = supported_3_10_through_13();
        let decision = decide_torch_python(current, (3, 12), &supported, interpreters, "retry", false, None, |_| false);
        match decision {
            TorchPythonDecision::Blocked(msg) => {
                assert!(msg.contains("no longer works"), "{msg}");
                assert!(!msg.contains("build a new virtual environment"), "{msg}");
                assert!(!msg.contains("ensurepip"), "{msg}");
                assert!(!msg.contains("python3-venv"), "{msg}");
            }
            _ => panic!("expected Blocked with the existing-venv wording"),
        }
    }

    // ── Discord 14.10.2026: only Python 3.15 on the machine ────────────────

    #[test]
    fn only_3_15_on_the_machine_takes_lus_own_python() {
        let current = "C:\\Python315\\python.exe";
        let interpreters = vec![(current.to_string(), Some((3, 15)))];
        let decision = decide_torch_python(current, (3, 15), &supported_3_10_through_13(), interpreters, "retry", true, Some((3, 12)), always_works);
        match decision {
            TorchPythonDecision::UseOwn { current_version, own_version } => {
                assert_eq!(current_version, (3, 15));
                assert_eq!(own_version, (3, 12));
            }
            _ => panic!("expected UseOwn: nothing on the machine serves torch, LU's own 3.12 does"),
        }
    }

    #[test]
    fn a_3_12_on_the_machine_beats_lus_own_python() {
        let interpreters = vec![
            ("/usr/bin/python3.15".to_string(), Some((3, 15))),
            ("/usr/bin/python3.12".to_string(), Some((3, 12))),
        ];
        let decision = decide_torch_python("/usr/bin/python3.15", (3, 15), &supported_3_10_through_13(), interpreters, "retry", true, Some((3, 12)), always_works);
        match decision {
            TorchPythonDecision::UseInstead { path, chosen_version, .. } => {
                assert_eq!(path, "/usr/bin/python3.12");
                assert_eq!(chosen_version, (3, 12));
            }
            _ => panic!("a Python of the machine comes before LU's own"),
        }
    }

    #[test]
    fn a_healthy_current_python_never_reaches_lus_own() {
        let interpreters = vec![("/venv/bin/python".to_string(), Some((3, 12)))];
        let decision = decide_torch_python("/venv/bin/python", (3, 12), &supported_3_10_through_13(), interpreters, "retry", false, Some((3, 12)), always_works);
        assert!(matches!(decision, TorchPythonDecision::Proceed));
    }

    #[test]
    fn lus_own_python_is_only_taken_when_the_index_serves_it() {
        let only_3_13: std::collections::BTreeSet<(u32, u32)> = [(3, 13)].into_iter().collect();
        let current = "/usr/bin/python3.15";
        let decision = decide_torch_python(current, (3, 15), &only_3_13, vec![(current.to_string(), Some((3, 15)))], "retry", true, Some((3, 12)), always_works);
        assert!(matches!(decision, TorchPythonDecision::Blocked(_)));
    }

    #[test]
    fn an_existing_venv_on_3_15_is_sent_to_the_repair_not_to_a_python_reinstall() {
        let decision = TorchPythonDecision::UseOwn { current_version: (3, 15), own_version: (3, 12) };
        let msg = python_for_existing_venv(decision, "/venv/bin/python").expect_err("no install into a venv torch cannot serve");
        assert!(msg.contains("Repair environment"), "{msg}");
        assert!(msg.contains("3.15") && msg.contains("3.12"), "{msg}");
        assert!(!msg.to_lowercase().contains("reinstall"), "{msg}");
    }

    struct NoProgress(std::sync::Arc<std::sync::atomic::AtomicBool>);
    impl crate::private_python::Progress for NoProgress {
        fn log(&self, _: String) {}
        fn cancel_flag(&self) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
            self.0.clone()
        }
        fn set_download(&self, _: u64, _: u64, _: u64) {}
    }

    #[test]
    fn a_new_venv_is_built_from_the_decided_python_and_says_so() {
        let progress = NoProgress(Default::default());
        let said = std::cell::RefCell::new(Vec::<String>::new());
        let say = |l: &str| said.borrow_mut().push(l.to_string());
        assert_eq!(base_for_new_venv(TorchPythonDecision::Proceed, "/py312", &progress, &say), Ok("/py312".to_string()));
        assert!(said.borrow().is_empty());
        let got = base_for_new_venv(
            TorchPythonDecision::UseInstead { path: "/py311".to_string(), current_version: (3, 15), chosen_version: (3, 11) },
            "/py315",
            &progress,
            &say,
        );
        assert_eq!(got, Ok("/py311".to_string()));
        assert!(said.borrow().iter().any(|l| l.contains("/py311")), "{:?}", said.borrow());
        assert_eq!(
            base_for_new_venv(TorchPythonDecision::Blocked("why".to_string()), "/py315", &progress, &say),
            Err("why".to_string())
        );
    }

    #[test]
    fn only_versions_every_package_serves_count() {
        // cu130 on 14.10.2026: torch and torchvision with cp315, torchaudio
        // up to cp314. A Python 3.15 must not count as served.
        let page = |tags: &[&str]| python_versions_from_index_html(&tags.iter().map(|t| format!("x-{t}-{t}-win_amd64.whl ")).collect::<String>());
        let torch = page(&["cp312", "cp313", "cp314", "cp315"]);
        let vision = page(&["cp312", "cp313", "cp314", "cp315"]);
        let audio = page(&["cp312", "cp313", "cp314"]);
        let common = common_python_versions([Some(torch.clone()), Some(vision), Some(audio)]).unwrap();
        assert!(!common.contains(&(3, 15)), "{common:?}");
        assert!(common.contains(&(3, 14)) && common.contains(&(3, 12)), "{common:?}");
        // One package that could not be read: no answer, fail open as before.
        assert_eq!(common_python_versions([Some(torch.clone()), None]), None);
        assert_eq!(common_python_versions([Some(torch), Some(Default::default())]), None);
        assert_eq!(common_python_versions(Vec::new()), None);
    }

}
