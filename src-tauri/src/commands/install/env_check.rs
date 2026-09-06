//! Der Beweis, dass eine Python-Umgebung wirklich startet.
//!
//! Der geteilte Zustand ist ein einziger Lauf des Prüfskripts: `probe_targets`
//! entscheidet, was importiert wird, `import_probe_script` schreibt das
//! Skript, `run_import_probe_bounded` startet es mit Frist und Abbruch,
//! `parse_import_probe` liest seine Zeilen zurück, und `probe_verdict` fällt
//! aus genau diesem Bericht das Urteil. Sie teilen sich ein Protokoll aus vier
//! Wörtern, das nur hier steht und nirgends sonst gebraucht wird. Läge das
//! Urteil woanders, müsste das Protokoll zweimal gepflegt werden.
//!
//! Warum es ein eigenes Modul ist und nicht bei `comfy_install` liegt: die
//! Prüfung ist der letzte Schritt von DREI Wegen, nämlich Installation,
//! Reparatur und Update. Zwei davon stehen in `comfy_repair`. Ein Modul, das
//! aus zwei anderen gerufen wird, gehört keinem von beiden.
//!
//! Was hier NICHT liegt: die Deutung von pip-Ausgaben. Ob ein Fehlschlag am
//! Netz, an den Rechten oder an einer fehlenden Laufzeit-DLL liegt,
//! entscheidet `pip`, und dieses Modul fragt dort nach. Es entscheidet nur,
//! WAS geheilt wird, nicht, warum ein pip-Lauf misslang.

use std::fs;
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::atomic::AtomicU64;
use std::time::Instant;
use crate::os_error;
use crate::commands::torch_wheels;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::python::python_command;
use crate::state::InstallState;

use super::pip::{
    pip_failure_hint, pip_failure_kind, pip_install_streaming_with_retry_raw, push_install_log,
    should_retry_in_user_site, PipFailureKind,
};

/// Import names for the distributions ComfyUI's requirements.txt names.
///
/// ONLY distributions listed here are probed. Deriving an import name from a
/// distribution name is a guess (pyyaml imports as `yaml`, pillow as `PIL`),
/// and a wrong guess would turn a healthy environment into a false alarm and
/// send the customer to Repair environment for nothing. Anything the table
/// does not know is installed but not probed, which is exactly the behaviour
/// before this change.
///
/// The list is names only, it pins no version, and the third column says
/// whether the package is probed even when requirements.txt has stopped naming
/// it. `true` makes this table the floor of the check, which is the whole point
/// of it: pip buys from requirements.txt, so a check that also reads its target
/// state from requirements.txt cannot notice a line that is gone from both
/// halves at once.
///
/// `false` means "probe this one only where the file asks for it", and the two
/// PyTorch side wheels need exactly that. They come from `plan_pytorch_install`
/// and not from this file, and a trio member in `report.missing` empties the
/// heal list for the whole run (`dists_to_heal`) and fails it outright
/// (`probe_verdict`). A floor that demanded torchvision or torchaudio would
/// turn one absent side wheel into an aborted repair. `torch` itself stays on
/// the floor because it is the DLL canary and is added first regardless.
///
/// Anything added here that not every ComfyUI version ships has to be `false`
/// too, or the heal step installs a package that core never asked for.
pub(crate) const KNOWN_IMPORT_NAMES: &[(&str, &str, bool)] = &[
    ("torch", "torch", true),
    ("torchvision", "torchvision", false),
    ("torchaudio", "torchaudio", false),
    ("torchsde", "torchsde", true),
    ("numpy", "numpy", true),
    ("einops", "einops", true),
    ("transformers", "transformers", true),
    ("tokenizers", "tokenizers", true),
    ("sentencepiece", "sentencepiece", true),
    ("safetensors", "safetensors", true),
    ("aiohttp", "aiohttp", true),
    ("yarl", "yarl", true),
    ("pyyaml", "yaml", true),
    ("pillow", "PIL", true),
    ("scipy", "scipy", true),
    ("tqdm", "tqdm", true),
    ("psutil", "psutil", true),
    ("alembic", "alembic", true),
    ("sqlalchemy", "sqlalchemy", true),
    ("av", "av", true),
    ("kornia", "kornia", true),
    ("spandrel", "spandrel", true),
    ("soundfile", "soundfile", true),
    ("pydantic", "pydantic", true),
    ("pydantic-settings", "pydantic_settings", true),
    ("requests", "requests", true),
    ("filelock", "filelock", true),
    ("blake3", "blake3", true),
    ("simpleeval", "simpleeval", true),
];

/// The comment ComfyUI's own requirements.txt uses to separate the packages a
/// core needs from the ones it can start without. Everything below it is
/// reported and logged when it will not import, but it never fails an install:
/// kornia, spandrel, pydantic and friends live down there, and refusing to
/// finish over one of them would trade A3 for a worse bug.
///
/// Matched on the words, not on the exact line, so a reflow of that comment
/// does not silently turn six optional packages back into mandatory ones.
pub(crate) fn is_optional_section_marker(comment: &str) -> bool {
    let c = comment.to_ascii_lowercase();
    (c.contains("non essential") || c.contains("non-essential") || c.contains("optional"))
        && c.contains("dependencies")
}

/// One package the probe can ask about: what pip calls it, what Python calls
/// it, and whether a core can start without it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProbeTarget {
    pub(crate) dist: String,
    pub(crate) module: &'static str,
    pub(crate) essential: bool,
}

/// PEP 503 name normalisation, so `PyYAML`, `pyyaml` and `Py_YAML` are one
/// package.
pub(crate) fn normalize_dist(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = false;
    for c in name.trim().to_ascii_lowercase().chars() {
        let c = if c == '_' || c == '.' { '-' } else { c };
        if c == '-' {
            if !last_dash {
                out.push('-');
            }
            last_dash = true;
        } else {
            out.push(c);
            last_dash = false;
        }
    }
    out.trim_matches('-').to_string()
}

/// One line of a requirements.txt, as far as the probe cares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RequirementLine {
    pub(crate) dist: String,
    /// False below the optional-dependencies comment: reported, never fatal.
    pub(crate) essential: bool,
    /// The line carries an environment marker, so pip decides whether it
    /// applies to this machine. Kept rather than dropped: `probe_targets` has
    /// to see that the file has spoken about the package, or its floor would
    /// put a Windows only package back on a Linux box.
    pub(crate) platform_gated: bool,
}

/// Distribution names a requirements.txt asks for. Options (`-r`, `-e`,
/// `--index-url`), comments, blank lines and URLs are dropped; version
/// specifiers and extras are cut off.
///
/// A line carrying an environment marker (`foo ; sys_platform == "win32"`)
/// comes back with `platform_gated` set. pip owns the marker, so the probe
/// never asks for such a line, and it has no business asking for a Windows only
/// package on Linux and then calling the environment broken. It is kept rather
/// than dropped because the floor in `probe_targets` has to be able to tell
/// "this file never mentions the package" from "this file excludes it here".
pub(crate) fn parse_requirement_lines(text: &str) -> Vec<RequirementLine> {
    let mut out: Vec<RequirementLine> = Vec::new();
    let mut essential = true;
    for raw in text.lines() {
        let (code, comment) = match raw.split_once('#') {
            Some((c, rest)) => (c.trim(), rest),
            None => (raw.trim(), ""),
        };
        if is_optional_section_marker(comment) {
            essential = false;
        }
        if code.is_empty() || code.starts_with('-') {
            continue;
        }
        let (code, platform_gated) = match code.split_once(';') {
            Some((name, _marker)) => (name.trim(), true),
            None => (code, false),
        };
        // `name @ url` is still a name; a bare URL is not.
        let head = code.split('@').next().unwrap_or("").trim();
        if head.is_empty() || head.contains("://") {
            continue;
        }
        let end = head
            .find(|c: char| "[<>=!~ \t,(".contains(c))
            .unwrap_or(head.len());
        let dist = normalize_dist(&head[..end]);
        if dist.is_empty() || out.iter().any(|l| l.dist == dist) {
            continue;
        }
        out.push(RequirementLine {
            dist,
            essential,
            platform_gated,
        });
    }
    out
}

/// What the probe should import for a given requirements.txt.
///
/// The table is the floor and the file may only add to it. P3, 04.09.: the
/// tester deleted the simpleeval line from requirements.txt, pressed Repair,
/// and the check went from 28 packages to 27. pip buys from that file, so the
/// package was missing from the venv afterwards and the run still finished on
/// "ComfyUI is ready". The check has to hold a target state of its own, or it
/// can only ever confirm the shopping list it was handed.
///
/// torch always comes first and always comes along: it is installed in its own
/// step, it is the one package whose failure is a native library fault rather
/// than a missing file, and it is the canary for every DLL report in A3.
///
/// A package that only the floor asks for is never essential. `probe_verdict`
/// weighs Heal before it weighs essential, so such a package is reinstalled
/// first and only ends the run in a warning when pip cannot bring it. An older
/// or forked core that genuinely never needed it can therefore never fail a
/// repair over it.
pub(crate) fn probe_targets(requirements: &str) -> Vec<ProbeTarget> {
    let lines = parse_requirement_lines(requirements);
    let mut out = vec![ProbeTarget {
        dist: "torch".to_string(),
        module: "torch",
        essential: true,
    }];
    for line in &lines {
        if line.dist == "torch" || line.platform_gated {
            continue;
        }
        if let Some(&(_, module, _)) = KNOWN_IMPORT_NAMES.iter().find(|(d, _, _)| *d == line.dist) {
            out.push(ProbeTarget {
                dist: line.dist.clone(),
                module,
                essential: line.essential,
            });
        }
    }
    for &(dist, module, always) in KNOWN_IMPORT_NAMES {
        // A file that names the package has the last word, whether it asks for
        // it or excludes it with a marker.
        if !always
            || out.iter().any(|t| t.dist == dist)
            || lines.iter().any(|l| l.dist == dist)
        {
            continue;
        }
        out.push(ProbeTarget {
            dist: dist.to_string(),
            module,
            essential: false,
        });
    }
    out
}

/// The Python program the probe runs. It announces each module BEFORE trying
/// it and flushes, so an import that takes the whole interpreter down with it
/// (0xC0000005, reported by petermanmancusso) still leaves its name in the
/// output instead of an empty log and an exit code.
pub(crate) fn import_probe_script(modules: &[&str]) -> String {
    let list = modules
        .iter()
        .map(|m| format!("\"{m}\""))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "import importlib, sys\n\
         sys.stdout.write(\"PROBE_VENV \" + (\"1\" if sys.prefix != sys.base_prefix else \"0\") + \"\\n\"); sys.stdout.flush()\n\
         for m in [{list}]:\n\
         \x20   sys.stdout.write(\"PROBE_TRY \" + m + \"\\n\"); sys.stdout.flush()\n\
         \x20   try:\n\
         \x20       importlib.import_module(m)\n\
         \x20       sys.stdout.write(\"PROBE_OK \" + m + \"\\n\")\n\
         \x20   except BaseException as e:\n\
         \x20       sys.stdout.write(\"PROBE_FAIL \" + m + \" :: \" + type(e).__name__ + \": \" + \" \".join(str(e).split()) + \"\\n\")\n\
         \x20   sys.stdout.flush()\n\
         sys.stdout.write(\"PROBE_DONE\\n\"); sys.stdout.flush()\n"
    )
}

/// How long the probe may take before it counts as hung. Twenty four imports
/// on a cold Windows drive is minutes of disk, and torch alone can take most
/// of one; a Windows loader dialog behind the app takes forever. Generous
/// enough for a slow spinning disk, short enough that 4/4 is not a dead end.
const IMPORT_PROBE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(300);

/// What the probe found. `missing` is the healable half (pip can put those
/// back), everything else is not: no amount of pip fixes an absent Visual C++
/// runtime, a hung loader or an interpreter that dies on exit.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ImportProbeReport {
    pub(crate) missing: Vec<String>,
    pub(crate) broken: Vec<(String, String)>,
    /// Every failure's own words, keyed by the module we asked for. `missing`
    /// and `broken` say what to do; this says what Python said.
    pub(crate) reasons: Vec<(String, String)>,
    pub(crate) crashed: Option<String>,
    pub(crate) finished: bool,
    /// The probe hit its deadline and was killed.
    pub(crate) timed_out: bool,
    /// The interpreter walked the whole list and still exited non zero, which
    /// is a native library dying on shutdown. Every field above can be clean
    /// and the environment still be broken, so this one has to count.
    pub(crate) exited_badly: bool,
    /// The interpreter runs inside a virtual environment, so a `--user`
    /// install would be refused. Read from the probe itself rather than
    /// guessed from the path.
    pub(crate) in_venv: bool,
}

impl ImportProbeReport {
    pub(crate) fn is_healthy(&self) -> bool {
        self.finished
            && self.missing.is_empty()
            && self.broken.is_empty()
            && self.crashed.is_none()
            && !self.timed_out
            && !self.exited_badly
    }
}

/// The module name a `No module named 'X'` blames, which is not always the
/// module we asked for: a package whose own dependency chain is broken names
/// the dependency, and quoting only our side turns that into a riddle.
pub(crate) fn module_named_in_error(reason: &str) -> Option<String> {
    let at = reason.find("No module named")? + "No module named".len();
    let rest = reason[at..].trim_start();
    let quote = rest.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let inner = &rest[quote.len_utf8()..];
    let end = inner.find(quote)?;
    let name = inner[..end].trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// Read the probe's output. `interpreter_survived` is the process exit status:
/// an interpreter that died mid import leaves a `PROBE_TRY` with nothing after
/// it, and that name is the module that killed it.
pub(crate) fn parse_import_probe(stdout: &str, interpreter_survived: bool) -> ImportProbeReport {
    let mut report = ImportProbeReport::default();
    let mut pending: Option<String> = None;
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("PROBE_VENV ") {
            report.in_venv = v.trim() == "1";
        } else if let Some(m) = line.strip_prefix("PROBE_TRY ") {
            pending = Some(m.trim().to_string());
        } else if let Some(m) = line.strip_prefix("PROBE_OK ") {
            if pending.as_deref() == Some(m.trim()) {
                pending = None;
            }
        } else if let Some(rest) = line.strip_prefix("PROBE_FAIL ") {
            let (module, reason) = match rest.split_once(" :: ") {
                Some((m, r)) => (m.trim().to_string(), r.trim().to_string()),
                None => (rest.trim().to_string(), "no detail from python".to_string()),
            };
            if pending.as_deref() == Some(module.as_str()) {
                pending = None;
            }
            report.reasons.push((module.clone(), reason.clone()));
            // A plain ModuleNotFoundError is a file that is not there, which
            // is the sqlalchemy / pyyaml case and the only one pip can fix.
            if reason.to_ascii_lowercase().contains("modulenotfounderror") {
                report.missing.push(module);
            } else {
                report.broken.push((module, reason));
            }
        } else if line == "PROBE_DONE" {
            report.finished = true;
            pending = None;
        }
    }
    if !report.finished || !interpreter_survived {
        report.crashed = pending;
    }
    report.exited_badly = !interpreter_survived;
    report
}

/// Move a crash into `broken` only when the interpreter's dying words say
/// something we can name.
///
/// Torch and transformers write warnings to stderr on almost every start, so
/// the LAST stderr line of a crashed run is usually a deprecation notice.
/// Promoting on that turned an access violation into "Press Repair
/// environment" with no cause named, which is the message the crash case
/// exists to avoid.
pub(crate) fn promote_crash_from_stderr(report: &mut ImportProbeReport, stderr: &str) {
    let Some(module) = report.crashed.clone() else {
        return;
    };
    let named = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .rev()
        .find(|l| pip_failure_kind(l) != PipFailureKind::Unknown);
    if let Some(line) = named {
        report.broken.push((module, line.to_string()));
        report.crashed = None;
    }
}

/// What to do about a probe result. Pure, so every branch is testable without
/// an interpreter, a network or a card.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ProbeVerdict {
    /// Nothing to do.
    Healthy,
    /// Install these distributions, then probe once more.
    Heal(Vec<String>),
    /// Say it in the log, finish anyway. Only optional packages are affected.
    Warn(String),
    /// Stop, with a finished sentence for the status line.
    Fail(String),
}

/// The distributions a heal step should install: every missing module we can
/// name a package for.
///
/// PyTorch is never in the list. It comes from a channel the card decides
/// (`plan_pytorch_install`), and a bare `pip install torch` would take whatever
/// PyPI serves by default, which is how a machine ends up with a build that has
/// no kernels for its own card. A torch that is missing after its own step is a
/// failed install, and the rebuild is the answer.
pub(crate) fn dists_to_heal(targets: &[ProbeTarget], report: &ImportProbeReport) -> Vec<String> {
    if report
        .missing
        .iter()
        .any(|m| torch_wheels::TORCH_TRIO.contains(&m.as_str()))
    {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    for module in &report.missing {
        if let Some(t) = targets.iter().find(|t| t.module == module.as_str()) {
            if !out.contains(&t.dist) {
                out.push(t.dist.clone());
            }
        }
    }
    out
}


/// True for a module the core cannot start without.
fn is_essential(targets: &[ProbeTarget], module: &str) -> bool {
    targets
        .iter()
        .find(|t| t.module == module)
        .map(|t| t.essential)
        .unwrap_or(true)
}

/// The whole decision, in one place. `already_healed` says whether the heal
/// step has already run, so a second look never sends the caller round the pip
/// loop again.
pub(crate) fn probe_verdict(
    targets: &[ProbeTarget],
    report: &ImportProbeReport,
    already_healed: bool,
) -> ProbeVerdict {
    if report.is_healthy() {
        return ProbeVerdict::Healthy;
    }
    if report.timed_out {
        let what = report
            .crashed
            .clone()
            .map(|m| format!(" It was importing {m}."))
            .unwrap_or_default();
        return ProbeVerdict::Fail(format!(
            "The check of the ComfyUI environment did not finish within {} minutes and was \
             stopped.{what} A Windows dialog from the library loader sitting behind the app will \
             do that. Bring any hidden dialog to the front and close it, then press Repair \
             environment.",
            IMPORT_PROBE_DEADLINE.as_secs() / 60
        ));
    }
    if let Some(module) = &report.crashed {
        return ProbeVerdict::Fail(format!(
            "The Python environment crashed while importing {module}, so it cannot start ComfyUI. \
             A crash at import time (0xC0000005 on Windows) means a native library the package \
             loads does not match this machine. {}",
            pip_failure_hint(PipFailureKind::NativeLoadFailure, "")
        ));
    }
    // A hard failure that is about a package the core needs beats everything
    // below, so it is asked for first.
    if let Some((module, reason)) = report
        .broken
        .iter()
        .find(|(m, _)| is_essential(targets, m))
    {
        let hint = pip_failure_hint(pip_failure_kind(reason), reason);
        let hint = if hint.is_empty() {
            "Press Repair environment to rebuild the environment from scratch.".to_string()
        } else {
            hint
        };
        return ProbeVerdict::Fail(format!(
            "The ComfyUI environment cannot import {module}: {reason}\n\n{hint}"
        ));
    }
    if report
        .missing
        .iter()
        .any(|m| torch_wheels::TORCH_TRIO.contains(&m.as_str()))
    {
        return ProbeVerdict::Fail(format!(
            "PyTorch is not in the ComfyUI environment at all ({} could not be imported), so the \
             install did not finish. Press Repair environment: it rebuilds the environment and \
             fetches the PyTorch build that matches the card in this machine.",
            report.missing.join(", ")
        ));
    }
    if !already_healed {
        let heal = dists_to_heal(targets, report);
        if !heal.is_empty() {
            return ProbeVerdict::Heal(heal);
        }
    }
    let hard: Vec<String> = report
        .missing
        .iter()
        .filter(|m| is_essential(targets, m))
        .map(|m| describe_missing(report, m))
        .collect();
    if !hard.is_empty() {
        return ProbeVerdict::Fail(format!(
            "These packages are still missing from the ComfyUI environment after a reinstall: {}. \
             ComfyUI cannot start without them. Press Repair environment to rebuild the \
             environment from scratch, and if that fails too, send us the install log.",
            hard.join(", ")
        ));
    }
    if !report.finished {
        return ProbeVerdict::Fail(
            "The check of the ComfyUI environment did not run to the end, so the environment \
             cannot be called ready. Press Repair environment to rebuild it."
                .to_string(),
        );
    }
    if report.exited_badly {
        return ProbeVerdict::Fail(format!(
            "Every package imported, but the interpreter itself then ended with an error, which \
             is a native library failing as it unloads. {}",
            pip_failure_hint(PipFailureKind::NativeLoadFailure, "")
        ));
    }
    // Only the packages below the optional-dependencies line are left. Say so
    // and finish: refusing to complete over one of those would trade A3 for a
    // worse bug.
    let soft: Vec<String> = report
        .missing
        .iter()
        .map(|m| describe_missing(report, m))
        .chain(report.broken.iter().map(|(m, r)| format!("{m} ({r})")))
        .collect();
    if !soft.is_empty() {
        return ProbeVerdict::Warn(format!(
            "These optional packages do not import: {}. ComfyUI starts without them, but the \
             nodes that use them will not appear.",
            soft.join(", ")
        ));
    }
    ProbeVerdict::Healthy
}

/// `spandrel` when spandrel itself is gone, `spandrel (needs timm)` when the
/// import died on somebody else's package.
fn describe_missing(report: &ImportProbeReport, module: &str) -> String {
    let named = report
        .reasons
        .iter()
        .find(|(m, _)| m == module)
        .and_then(|(_, r)| module_named_in_error(r));
    match named {
        Some(dep) if dep != module => format!("{module} (needs {dep})"),
        _ => module.to_string(),
    }
}

/// The line the install panel shows for a probe line, if any. Twenty four
/// silent imports on a cold drive look exactly like a hung installer, so 4/4
/// says what it is doing.
pub(crate) fn probe_progress_line(line: &str) -> Option<String> {
    if let Some(m) = line.strip_prefix("PROBE_TRY ") {
        return Some(format!("Importing {}...", m.trim()));
    }
    if let Some(rest) = line.strip_prefix("PROBE_FAIL ") {
        let module = rest.split(" :: ").next().unwrap_or(rest).trim();
        return Some(format!("{module} does not import."));
    }
    None
}

/// Run the probe against one interpreter, with a hard deadline and the same
/// cancel flag every other step honours.
///
/// `Command::output()` waits forever. Twenty four imports on a cold Windows
/// drive is a minute of disk with no output at all, and a library loader that
/// puts up a modal dialog behind the app waits for a click that will never
/// come. Both leave the installer sitting on 4/4 with no way out, which is a
/// worse failure than the one this probe exists to catch. Modelled on
/// `shell::output_bounded`, extended to carry stderr, the exit status and the
/// cancel flag.
///
/// Err is only ever "cancelled". Everything else is a report: a probe that
/// could not start, timed out or died is reported, never called healthy.
fn run_import_probe(
    python_bin: &str,
    modules: &[&str],
    install_status: Option<&Arc<Mutex<InstallState>>>,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<ImportProbeReport, String> {
    run_import_probe_bounded(python_bin, modules, install_status, cancel, IMPORT_PROBE_DEADLINE)
}

/// Same, with the deadline as a parameter so a test can drive the timeout and
/// the cancel paths in a second instead of in five minutes.
fn run_import_probe_bounded(
    python_bin: &str,
    modules: &[&str],
    install_status: Option<&Arc<Mutex<InstallState>>>,
    cancel: Option<&Arc<AtomicBool>>,
    max: std::time::Duration,
) -> Result<ImportProbeReport, String> {
    let script = import_probe_script(modules);
    // Die Begruendung fuer die Kodierung wohnt jetzt in python_command, weil
    // sie fuer jeden Python-Start gilt und nicht nur fuer diesen hier
    // (Ticket 003).
    let mut cmd = python_command(python_bin);
    cmd.arg("-c").arg(&script);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Ok(ImportProbeReport {
                broken: vec![("python".to_string(), os_error::english(&e))],
                ..Default::default()
            })
        }
    };

    let out_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let err_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let readers_done = Arc::new(AtomicU64::new(0));
    if let Some(stdout) = child.stdout.take() {
        let sink = out_lines.clone();
        let done = readers_done.clone();
        let status = install_status.cloned();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                // Vor allem anderen, denn PROBE_FAIL kommt hier heraus und
                // traegt `str(e)` des Interpreters (P3, 7.3): "ImportError: DLL
                // load failed while importing _core: Das angegebene Modul wurde
                // nicht gefunden." Diese Zeile landet woertlich in der
                // Fehlermeldung, die der Kunde liest.
                let line = os_error::english_child_text(line.trim()).into_owned();
                if line.is_empty() {
                    continue;
                }
                if let (Some(state), Some(msg)) = (status.as_ref(), probe_progress_line(&line)) {
                    push_install_log(state, &msg);
                }
                if let Ok(mut v) = sink.lock() {
                    v.push(line);
                }
            }
            done.fetch_add(1, Ordering::Release);
        });
    } else {
        readers_done.fetch_add(1, Ordering::Release);
    }
    if let Some(stderr) = child.stderr.take() {
        let sink = err_lines.clone();
        let done = readers_done.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                // Dieselbe Behandlung wie auf stdout: der Absturztext geht
                // ueber `promote_crash_from_stderr` in dieselbe Meldung.
                let line = os_error::english_child_text(line.trim()).into_owned();
                if !line.is_empty() {
                    if let Ok(mut v) = sink.lock() {
                        v.push(line);
                    }
                }
            }
            done.fetch_add(1, Ordering::Release);
        });
    } else {
        readers_done.fetch_add(1, Ordering::Release);
    }

    let deadline = Instant::now() + max;
    let mut timed_out = false;
    let exit = loop {
        if cancel.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
            crate::commands::shell::kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            return Err("cancelled".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    // The tree, not just the child: a loader dialog belongs to
                    // this process, but a probe that spawned anything would
                    // otherwise keep the pipe open.
                    crate::commands::shell::kill_tree(child.id());
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break None;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(_) => break None,
        }
    };
    // The reader threads are deliberately not joined: the same reason
    // `run_streamed` gives, a surviving grandchild can hold the pipe open and
    // the join would hang instead of returning what we already have.
    let settle = Instant::now() + std::time::Duration::from_millis(500);
    while readers_done.load(Ordering::Acquire) < 2 && Instant::now() < settle {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    let stdout_text = out_lines.lock().map(|v| v.join("\n")).unwrap_or_default();
    let stderr_text = err_lines.lock().map(|v| v.join("\n")).unwrap_or_default();
    let survived = exit.map(|s| s.success()).unwrap_or(false);
    let mut report = parse_import_probe(&stdout_text, survived);
    report.timed_out = timed_out;
    if timed_out {
        report.finished = false;
    }
    promote_crash_from_stderr(&mut report, &stderr_text);
    Ok(report)
}

/// Import every package we can name, install back what is missing, import
/// again. Ok means the environment really starts; Err carries a finished
/// sentence for the status line.
///
/// This is the step "Repair environment" was missing. It rebuilt the venv and
/// then trusted pip's exit code, which is the same trust that produced the
/// broken environment in the first place.
pub(super) fn verify_and_heal_environment(
    python_bin: &str,
    requirements: &Path,
    install_status: &Arc<Mutex<InstallState>>,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<(), String> {
    // A file that cannot be read used to become an empty string without a
    // word, and the check then asked for a single package and called the
    // environment ready. The floor in `probe_targets` keeps the check whole,
    // and this says why it is running on the floor alone.
    let text = match fs::read_to_string(requirements) {
        Ok(t) => t,
        Err(e) => {
            push_install_log(
                install_status,
                &format!(
                    "requirements.txt could not be read ({}), checking the packages LU knows \
                     about instead.",
                    os_error::english(&e)
                ),
            );
            String::new()
        }
    };
    let targets = probe_targets(&text);
    let modules: Vec<&str> = targets.iter().map(|t| t.module).collect();
    push_install_log(
        install_status,
        &format!("Checking the environment: importing {} packages...", modules.len()),
    );

    let report = run_import_probe(python_bin, &modules, Some(install_status), cancel)?;
    let heal = match probe_verdict(&targets, &report, false) {
        ProbeVerdict::Healthy => {
            push_install_log(install_status, "All packages import cleanly.");
            return Ok(());
        }
        ProbeVerdict::Warn(msg) => {
            push_install_log(install_status, &msg);
            return Ok(());
        }
        ProbeVerdict::Fail(msg) => return Err(msg),
        ProbeVerdict::Heal(dists) => dists,
    };

    // Self-heal before the error message: the packages the mods were
    // installing by hand get installed here instead.
    push_install_log(
        install_status,
        &format!(
            "These packages are missing and are being installed now: {}.",
            heal.join(", ")
        ),
    );
    let mut args: Vec<&str> = vec!["-m", "pip", "install", "--progress-bar", "off", "--no-input"];
    args.extend(heal.iter().map(|s| s.as_str()));
    match pip_install_streaming_with_retry_raw(&args, python_bin, 3, install_status, cancel) {
        Ok(()) => {}
        Err(f) if f.diagnosis == "cancelled" => return Err("cancelled".to_string()),
        Err(f) => {
            // The same admin-only site-packages escape the requirements step
            // takes. Without it the heal dies on exactly the machine the heal
            // exists for: a python.org install under Program Files, where the
            // first wheel that is not already there cannot be written.
            let escaped = should_retry_in_user_site(report.in_venv, &f.stderr)
                && {
                    push_install_log(
                        install_status,
                        "The missing packages could not be written to the shared site-packages. \
                         Retrying into the per user site, which needs no administrator.",
                    );
                    let mut user_args = args.clone();
                    user_args.push("--user");
                    pip_install_streaming_with_retry_raw(&user_args, python_bin, 2, install_status, cancel)
                        .is_ok()
                };
            if !escaped {
                return Err(format!(
                    "The ComfyUI environment is missing {} and they could not be installed.\n\n{}",
                    heal.join(", "),
                    f.diagnosis
                ));
            }
        }
    }

    let second = run_import_probe(python_bin, &modules, Some(install_status), cancel)?;
    match probe_verdict(&targets, &second, true) {
        ProbeVerdict::Healthy => {
            push_install_log(install_status, "All packages import cleanly now.");
            Ok(())
        }
        ProbeVerdict::Warn(msg) => {
            push_install_log(install_status, &msg);
            Ok(())
        }
        ProbeVerdict::Heal(_) | ProbeVerdict::Fail(_) => {
            Err(match probe_verdict(&targets, &second, true) {
                ProbeVerdict::Fail(msg) => msg,
                _ => "The ComfyUI environment still does not import. Press Repair environment."
                    .to_string(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::pip::VC_REDIST_PAGE;

    /// The shape of ComfyUI's own requirements.txt, including the comment that
    /// splits it, the two names the mods were typing into the ticket, and the
    /// line P3 took out of the file on 04.09.
    const COMFY_REQUIREMENTS: &str = "comfyui-frontend-package\n\
                                      torch\n\
                                      torchsde\n\
                                      torchvision\n\
                                      numpy>=1.25.0\n\
                                      PyYAML\n\
                                      Pillow\n\
                                      SQLAlchemy\n\
                                      alembic\n\
                                      av\n\
                                      simpleeval>=1.0.0\n\
                                      #non essential dependencies:\n\
                                      kornia>=0.7.1\n\
                                      spandrel\n\
                                      pydantic~=2.0\n\
                                      pydantic-settings~=2.0\n";

    #[test]
    fn the_two_packages_the_mods_installed_by_hand_are_in_the_probe() {
        let targets = probe_targets(COMFY_REQUIREMENTS);
        let modules: Vec<&str> = targets.iter().map(|t| t.module).collect();
        assert!(modules.contains(&"yaml"), "pyyaml is not probed: {modules:?}");
        assert!(modules.contains(&"sqlalchemy"), "sqlalchemy is not probed: {modules:?}");
        assert!(modules.contains(&"PIL"), "pillow is not probed: {modules:?}");
        // torch leads, and it comes along even when it is installed in its own
        // step: it is the canary for every DLL report in A3.
        assert_eq!(targets[0].module, "torch");
        assert_eq!(targets.iter().filter(|t| t.module == "torch").count(), 1);
        // pip has to be handed the DISTRIBUTION name back, not the import name.
        let yaml = targets.iter().find(|t| t.module == "yaml").expect("pyyaml");
        assert_eq!(yaml.dist, "pyyaml");
    }

    #[test]
    fn the_packages_below_the_non_essential_comment_never_fail_an_install() {
        // requirements.txt splits itself, and kornia, spandrel and pydantic
        // live on the far side of that line. Treating them as mandatory would
        // trade A3 for a worse bug: an install that refuses to finish over a
        // package ComfyUI starts without.
        let targets = probe_targets(COMFY_REQUIREMENTS);
        let essential = |m: &str| targets.iter().find(|t| t.module == m).map(|t| t.essential);
        assert_eq!(essential("sqlalchemy"), Some(true), "above the line, so mandatory");
        assert_eq!(essential("yaml"), Some(true));
        assert_eq!(essential("torch"), Some(true));
        for soft in ["kornia", "spandrel", "pydantic", "pydantic_settings"] {
            assert_eq!(essential(soft), Some(false), "{soft} would fail an install");
        }
        // Negative control: without that comment the very same lines are
        // mandatory, so the split really comes from the file and not from a
        // hard-coded package list.
        let flat = COMFY_REQUIREMENTS.replace("#non essential dependencies:\n", "");
        let flat_targets = probe_targets(&flat);
        assert_eq!(
            flat_targets.iter().find(|t| t.module == "kornia").map(|t| t.essential),
            Some(true),
        );
    }

    #[test]
    fn a_line_with_an_environment_marker_is_installed_but_never_probed() {
        // pip owns the marker. Probing a Windows only package on Linux and
        // then calling the environment broken is a bug we would have shipped,
        // and the floor must not smuggle such a package back in.
        let with_marker = "torch\nsoundfile ; sys_platform == \"win32\"\n";
        let modules: Vec<&str> = probe_targets(with_marker).iter().map(|t| t.module).collect();
        assert!(!modules.contains(&"soundfile"), "a marked line was probed: {modules:?}");
        // Negative control, on the one package the table does NOT stand behind
        // on its own, so the marker rule and the floor cannot cover for each
        // other: with the marker torchaudio stays out, without it, it is
        // probed. Run against soundfile this would prove nothing, because the
        // floor asks for soundfile either way.
        let gated: Vec<&str> = probe_targets("torch\ntorchaudio ; sys_platform == \"win32\"\n")
            .iter()
            .map(|t| t.module)
            .collect();
        assert!(!gated.contains(&"torchaudio"), "{gated:?}");
        let plain: Vec<&str> = probe_targets("torch\ntorchaudio\n").iter().map(|t| t.module).collect();
        assert!(plain.contains(&"torchaudio"), "{plain:?}");
    }

    #[test]
    fn a_package_whose_import_name_we_do_not_know_is_never_guessed() {
        // Negative control: guessing would turn a healthy environment into a
        // false alarm and send the customer to Repair environment for nothing.
        let targets = probe_targets("comfyui-workflow-templates\nsome-brand-new-thing\n");
        for t in &targets {
            assert!(
                KNOWN_IMPORT_NAMES.iter().any(|(d, _, _)| *d == t.dist),
                "a package the table does not know was probed: {}",
                t.dist,
            );
        }
        let dists: Vec<&str> = targets.iter().map(|t| t.dist.as_str()).collect();
        assert!(!dists.contains(&"some-brand-new-thing"), "{dists:?}");
        assert!(!dists.contains(&"comfyui-workflow-templates"), "{dists:?}");
    }

    #[test]
    fn requirements_parsing_drops_the_lines_that_are_not_packages() {
        let reqs = "# a comment\n\n-r other.txt\n--index-url https://example.invalid/simple\nhttps://example.invalid/wheel.whl\ntorch==2.9.1\nPyYAML\nspandrel ; python_version >= \"3.10\"\nkornia[extra]>=0.7\n";
        let lines = parse_requirement_lines(reqs);
        let dists: Vec<&str> = lines.iter().map(|l| l.dist.as_str()).collect();
        assert_eq!(dists, vec!["torch", "pyyaml", "spandrel", "kornia"], "got {dists:?}");
        // The marked line keeps its name and its mark: the probe still never
        // asks for it, and the floor can tell that this file has spoken about
        // spandrel.
        let gated: Vec<&str> = lines
            .iter()
            .filter(|l| l.platform_gated)
            .map(|l| l.dist.as_str())
            .collect();
        assert_eq!(gated, vec!["spandrel"], "got {gated:?}");
    }

    #[test]
    fn a_line_that_disappears_from_the_file_is_still_probed() {
        // P3, 04.09.: simpleeval taken out of requirements.txt, Repair
        // pressed, and the check went from 28 packages to 27. pip installs
        // from the same file, so the package was gone from the venv and the
        // run still ended on "ComfyUI is ready".
        let full = probe_targets(COMFY_REQUIREMENTS);
        let short = probe_targets(&COMFY_REQUIREMENTS.replace("simpleeval>=1.0.0\n", ""));
        let modules: Vec<&str> = short.iter().map(|t| t.module).collect();
        assert!(modules.contains(&"simpleeval"), "the check shrank with the file: {modules:?}");
        assert_eq!(short.len(), full.len(), "{} against {}", short.len(), full.len());
        // Negative control one, the tester's second attempt: a name the table
        // does not know does not grow the list either, so this is not "probe
        // whatever the file says".
        let added = probe_targets(&format!("{COMFY_REQUIREMENTS}pywin32\n"));
        assert!(!added.iter().any(|t| t.dist == "pywin32"), "pywin32 became a target");
        assert_eq!(added.len(), full.len());
        // Negative control two: the floor is not "the whole table, whatever
        // the file says" either. A file that excludes a package for this
        // platform still wins.
        let gated = probe_targets(&format!("{COMFY_REQUIREMENTS}soundfile ; sys_platform == \"win32\"\n"));
        assert!(!gated.iter().any(|t| t.dist == "soundfile"), "the floor overrode a marker");
    }

    #[test]
    fn a_package_the_file_no_longer_names_is_reinstalled_and_not_just_reported() {
        // The other half of the tester's run: being probed is worth nothing
        // unless the heal step really reaches the package.
        let short = probe_targets(&COMFY_REQUIREMENTS.replace("simpleeval>=1.0.0\n", ""));
        let report = parse_import_probe(
            "PROBE_VENV 1\nPROBE_TRY torch\nPROBE_OK torch\n\
             PROBE_TRY simpleeval\nPROBE_FAIL simpleeval :: ModuleNotFoundError: No module named 'simpleeval'\n\
             PROBE_DONE\n",
            true,
        );
        assert_eq!(dists_to_heal(&short, &report), vec!["simpleeval"]);
        assert_eq!(
            probe_verdict(&short, &report, false),
            ProbeVerdict::Heal(vec!["simpleeval".to_string()]),
        );
        // Negative control one: once the heal has run, the same result is not
        // another trip round the pip loop.
        assert!(!matches!(probe_verdict(&short, &report, true), ProbeVerdict::Heal(_)));
        // Negative control two, and the reason the two PyTorch side wheels are
        // not on the floor: a missing trio member empties the heal list for
        // the WHOLE run and fails it outright, so a floor that asked for
        // torchaudio would turn one absent side wheel into an aborted repair.
        assert!(!probe_targets("").iter().any(|t| t.dist == "torchaudio"), "torchaudio is on the floor");
        let trio = parse_import_probe(
            "PROBE_VENV 1\nPROBE_TRY torchaudio\nPROBE_FAIL torchaudio :: ModuleNotFoundError: No module named 'torchaudio'\nPROBE_DONE\n",
            true,
        );
        let asked = probe_targets("torch\ntorchaudio\n");
        assert!(dists_to_heal(&asked, &trio).is_empty());
        assert!(matches!(probe_verdict(&asked, &trio, false), ProbeVerdict::Fail(_)));
    }

    #[test]
    fn a_requirements_txt_that_cannot_be_read_does_not_shrink_the_check_to_torch() {
        // The sharper edge of the same line: an unreadable file became an
        // empty string, the check asked for one package and the run said
        // ready. Now it falls back on the whole floor.
        let targets = probe_targets("");
        let modules: Vec<&str> = targets.iter().map(|t| t.module).collect();
        assert_eq!(modules[0], "torch", "{modules:?}");
        for m in ["sqlalchemy", "yaml", "PIL", "simpleeval"] {
            assert!(modules.contains(&m), "{m} fell out of the check: {modules:?}");
        }
        // Exactly the floor, so a `false` in the table means what it says.
        for &(dist, module, always) in KNOWN_IMPORT_NAMES {
            assert_eq!(modules.contains(&module), always, "{dist}");
        }
        // And a floor package can never fail a run on its own: torch stays the
        // one mandatory name, which is what keeps the DLL branch alive.
        assert!(targets[0].essential, "torch stopped being mandatory");
        assert!(
            targets.iter().skip(1).all(|t| !t.essential),
            "a package only the floor asks for could fail a repair",
        );
    }

    #[test]
    fn a_requirements_file_that_will_not_open_says_so_and_checks_the_floor() {
        // The read error used to be swallowed by unwrap_or_default(), and the
        // panel then showed "importing 1 packages" with nothing to explain it.
        // No interpreter needed: the probe is handed a binary that cannot
        // start, and what is asserted is the two log lines written before it.
        let state = Arc::new(Mutex::new(InstallState::default()));
        let gone = std::env::temp_dir().join("lu-no-such-requirements-abc123.txt");
        let _ = std::fs::remove_file(&gone);
        let _ = verify_and_heal_environment("lu-not-a-python-binary", &gone, &state, None);
        let logs = state.lock().unwrap().logs.join("\n");
        assert!(logs.contains("requirements.txt could not be read"), "{logs}");
        let count = format!("importing {} packages", probe_targets("").len());
        assert!(logs.contains(&count), "the check did not fall back on the floor: {logs}");
        // Negative control: a file that IS readable says nothing of the kind.
        let there = std::env::temp_dir().join("lu-a-real-requirements-abc123.txt");
        std::fs::write(&there, "torch\n").expect("fixture");
        let second = Arc::new(Mutex::new(InstallState::default()));
        let _ = verify_and_heal_environment("lu-not-a-python-binary", &there, &second, None);
        let quiet = second.lock().unwrap().logs.join("\n");
        let _ = std::fs::remove_file(&there);
        assert!(!quiet.contains("could not be read"), "{quiet}");
    }

    #[test]
    fn distribution_names_are_normalised_the_way_pip_normalises_them() {
        for name in ["Py_YAML", "py.yaml", "  py--yaml ", "PY-Yaml"] {
            assert_eq!(normalize_dist(name), "py-yaml", "{name}");
        }
        assert_eq!(normalize_dist("PyYAML"), "pyyaml");
        assert_eq!(normalize_dist("pydantic_settings"), "pydantic-settings");
    }

    #[test]
    fn the_optional_marker_is_read_from_the_words_not_from_one_exact_line() {
        assert!(is_optional_section_marker("non essential dependencies:"));
        assert!(is_optional_section_marker(" Non-Essential Dependencies "));
        assert!(is_optional_section_marker("optional dependencies below"));
        // Negative control: an ordinary comment must not silently turn the
        // rest of the file optional.
        assert!(!is_optional_section_marker(" pinned for the frontend package"));
        assert!(!is_optional_section_marker(" dependencies"));
    }

    #[test]
    fn a_probe_where_everything_imports_is_healthy() {
        let out = "PROBE_VENV 1\nPROBE_TRY torch\nPROBE_OK torch\nPROBE_TRY yaml\nPROBE_OK yaml\nPROBE_DONE\n";
        let report = parse_import_probe(out, true);
        assert!(report.is_healthy(), "{report:?}");
        assert!(report.in_venv, "the venv flag was not read");
        assert_eq!(probe_verdict(&probe_targets("torch\nPyYAML\n"), &report, false), ProbeVerdict::Healthy);
    }

    #[test]
    fn a_probe_that_finished_but_exited_non_zero_is_not_healthy() {
        // A native library that dies as it unloads walks the whole list first
        // and only then takes the process down. Every field was clean and the
        // exit status was the one thing nobody looked at.
        let out = "PROBE_VENV 0\nPROBE_TRY torch\nPROBE_OK torch\nPROBE_DONE\n";
        let bad = parse_import_probe(out, false);
        assert!(!bad.is_healthy(), "a non zero exit passed as healthy: {bad:?}");
        assert!(bad.exited_badly);
        let msg = match probe_verdict(&probe_targets("torch\n"), &bad, true) {
            ProbeVerdict::Fail(m) => m,
            other => panic!("{other:?}"),
        };
        assert!(msg.contains("unloads"), "{msg}");
        // Negative control: the identical output with exit 0 is healthy, so
        // the verdict really turns on the status and not on the log.
        assert!(parse_import_probe(out, true).is_healthy());
    }

    #[test]
    fn a_module_that_is_simply_not_installed_is_healed_before_it_is_reported() {
        let out = "PROBE_VENV 1\nPROBE_TRY torch\nPROBE_OK torch\n\
                   PROBE_TRY sqlalchemy\nPROBE_FAIL sqlalchemy :: ModuleNotFoundError: No module named 'sqlalchemy'\n\
                   PROBE_TRY yaml\nPROBE_FAIL yaml :: ModuleNotFoundError: No module named 'yaml'\n\
                   PROBE_DONE\n";
        let report = parse_import_probe(out, true);
        assert!(!report.is_healthy());
        assert_eq!(report.missing, vec!["sqlalchemy", "yaml"]);
        assert!(report.broken.is_empty());
        assert!(report.crashed.is_none());
        let targets = probe_targets(COMFY_REQUIREMENTS);
        // The heal list is what pip is handed: distribution names, so yaml has
        // to come back out as pyyaml.
        assert_eq!(dists_to_heal(&targets, &report), vec!["sqlalchemy", "pyyaml"]);
        assert_eq!(
            probe_verdict(&targets, &report, false),
            ProbeVerdict::Heal(vec!["sqlalchemy".to_string(), "pyyaml".to_string()]),
        );
        // Negative control: after the heal has run, the same result is a
        // failure and not another trip round the pip loop.
        assert!(matches!(probe_verdict(&targets, &report, true), ProbeVerdict::Fail(_)));
    }

    #[test]
    fn a_missing_torch_is_never_reinstalled_from_plain_pypi() {
        // Negative control for the heal path: torch comes from the channel the
        // card decides. A bare `pip install torch` would hand a Blackwell box
        // whatever PyPI serves by default, which is the bug the wheel planner
        // exists to prevent.
        let out = "PROBE_VENV 1\nPROBE_TRY torch\nPROBE_FAIL torch :: ModuleNotFoundError: No module named 'torch'\nPROBE_DONE\n";
        let report = parse_import_probe(out, true);
        let targets = probe_targets(COMFY_REQUIREMENTS);
        assert_eq!(report.missing, vec!["torch"]);
        assert!(dists_to_heal(&targets, &report).is_empty(), "the heal would fetch a wheel nobody chose");
        let msg = match probe_verdict(&targets, &report, false) {
            ProbeVerdict::Fail(m) => m,
            other => panic!("{other:?}"),
        };
        assert!(msg.contains("Repair environment"), "{msg}");
        assert!(msg.contains("matches the card"), "{msg}");
    }

    #[test]
    fn only_the_optional_half_missing_still_finishes_the_install() {
        // kornia below the non essential line: say it, log it, complete.
        let out = "PROBE_VENV 1\nPROBE_TRY torch\nPROBE_OK torch\n\
                   PROBE_TRY kornia\nPROBE_FAIL kornia :: ModuleNotFoundError: No module named 'kornia'\n\
                   PROBE_DONE\n";
        let report = parse_import_probe(out, true);
        let targets = probe_targets(COMFY_REQUIREMENTS);
        let verdict = probe_verdict(&targets, &report, true);
        let msg = match &verdict {
            ProbeVerdict::Warn(m) => m.clone(),
            other => panic!("an optional package stopped the install: {other:?}"),
        };
        assert!(msg.contains("kornia"), "{msg}");
        assert!(msg.contains("optional"), "{msg}");
        // Negative control: the same failure for a package ABOVE the line
        // stops the install.
        let hard = parse_import_probe(
            "PROBE_VENV 1\nPROBE_TRY sqlalchemy\nPROBE_FAIL sqlalchemy :: ModuleNotFoundError: No module named 'sqlalchemy'\nPROBE_DONE\n",
            true,
        );
        assert!(matches!(probe_verdict(&targets, &hard, true), ProbeVerdict::Fail(_)));
    }

    #[test]
    fn a_dll_failure_is_never_treated_as_something_pip_can_fix() {
        // Reinstalling a package cannot put a Visual C++ runtime on the
        // machine, so the probe must not send the installer round the pip loop.
        let out = "PROBE_VENV 1\nPROBE_TRY torch\nPROBE_FAIL torch :: OSError: [WinError 1114] A dynamic link library (DLL) initialization routine failed. Error loading \"c10.dll\"\nPROBE_DONE\n";
        let report = parse_import_probe(out, true);
        let targets = probe_targets(COMFY_REQUIREMENTS);
        assert!(dists_to_heal(&targets, &report).is_empty());
        let msg = match probe_verdict(&targets, &report, false) {
            ProbeVerdict::Fail(m) => m,
            other => panic!("pip is being asked to fix a DLL: {other:?}"),
        };
        assert!(msg.contains("torch"), "{msg}");
        assert!(msg.contains(VC_REDIST_PAGE), "no way out of the DLL failure: {msg}");
    }

    #[test]
    fn ein_probe_fail_mit_deutschem_windows_satz_kommt_englisch_in_der_meldung_an() {
        // P3, 7.2 und 7.3: der Interpreter schreibt `str(e)` auf stdout, und
        // auf einem deutschen Windows ist die Haelfte davon deutsch. Diese
        // Zeile landet woertlich in {reason} der Fail-Meldung.
        //
        // Die Zeile mit der Marke steht hier, weil sie ueberall beweisbar ist:
        // die Umschrift liest die Nummer und schneidet den fremden Satz
        // strukturell ab. Die Zeile OHNE Nummer (7.3) kann nur das Windows des
        // Nutzers aufloesen, dafuer steht der Beweis mit Attrappe in
        // `os_error::tests`.
        let raw = "PROBE_FAIL torch :: OSError: [WinError 126] Das angegebene Modul wurde nicht \
                   gefunden. Error loading \
                   \"C:\\Users\\ddrob\\ComfyUI\\venv\\Lib\\site-packages\\torch\\lib\\c10_cuda.dll\" \
                   or one of its dependencies.";
        // Genau der Griff, den der stdout-Leser der Probe tut.
        let line = os_error::english_child_text(raw).into_owned();
        let out = format!("PROBE_VENV 1\nPROBE_TRY torch\n{line}\nPROBE_DONE\n");
        let report = parse_import_probe(&out, true);
        let msg = match probe_verdict(&probe_targets(COMFY_REQUIREMENTS), &report, false) {
            ProbeVerdict::Fail(m) => m,
            other => panic!("{other:?}"),
        };
        assert!(!msg.contains("Das angegebene Modul"), "der deutsche Satz steht in der Meldung: {msg}");
        assert!(msg.contains("the specified module could not be found"), "{msg}");
        // Und alles, was die Meldung vorher konnte, kann sie weiter.
        assert!(msg.contains("torch"), "{msg}");
        assert!(msg.contains("c10_cuda.dll"), "der DLL-Pfad ist verloren gegangen: {msg}");
        assert!(msg.contains(VC_REDIST_PAGE), "no way out of the DLL failure: {msg}");
    }

    #[test]
    fn an_interpreter_that_dies_mid_import_names_the_module_that_killed_it() {
        // petermanmancusso: "Process exited with code 0xC0000005". No
        // traceback, no last line, just a dead process. The PROBE_TRY line
        // written before the import is the only thing left.
        let report = parse_import_probe("PROBE_VENV 1\nPROBE_TRY torch\n", false);
        assert_eq!(report.crashed.as_deref(), Some("torch"));
        assert!(!report.is_healthy());
        let msg = match probe_verdict(&probe_targets("torch\n"), &report, false) {
            ProbeVerdict::Fail(m) => m,
            other => panic!("{other:?}"),
        };
        assert!(msg.contains("torch"), "{msg}");
        assert!(msg.contains("0xC0000005"), "the crash is not named: {msg}");
        assert!(msg.contains(VC_REDIST_PAGE), "{msg}");
    }

    #[test]
    fn a_crash_is_only_explained_by_a_stderr_line_that_says_something() {
        // torch and transformers write warnings on nearly every start, so the
        // LAST stderr line of a crashed run is usually a deprecation notice.
        // Promoting on that turned an access violation into a shrug.
        let mut noisy = parse_import_probe("PROBE_TRY torch\n", false);
        promote_crash_from_stderr(
            &mut noisy,
            "UserWarning: torchvision is out of date\n  warnings.warn(msg)\n",
        );
        assert_eq!(noisy.crashed.as_deref(), Some("torch"), "a warning stole the crash");
        assert!(noisy.broken.is_empty());
        // And a line that DOES say something is taken, with the file named.
        let mut named = parse_import_probe("PROBE_TRY torch\n", false);
        promote_crash_from_stderr(
            &mut named,
            "UserWarning: something noisy\nImportError: VCOMP140.DLL was not found\n",
        );
        assert!(named.crashed.is_none(), "{named:?}");
        assert_eq!(named.broken.len(), 1);
        let msg = match probe_verdict(&probe_targets("torch\n"), &named, false) {
            ProbeVerdict::Fail(m) => m,
            other => panic!("{other:?}"),
        };
        assert!(msg.contains("VCOMP140.DLL"), "{msg}");
    }

    #[test]
    fn a_probe_that_never_reached_the_end_is_not_called_healthy() {
        // Negative control: exit code 0 with a truncated log used to be
        // indistinguishable from success, which is the whole class of bug A3
        // is made of.
        let report = parse_import_probe("PROBE_VENV 1\nPROBE_TRY torch\nPROBE_OK torch\n", true);
        assert!(!report.is_healthy(), "an unfinished probe passed as healthy: {report:?}");
        assert!(matches!(probe_verdict(&probe_targets("torch\n"), &report, true), ProbeVerdict::Fail(_)));
    }

    #[test]
    fn a_timed_out_probe_names_the_hidden_dialog_and_never_passes() {
        let mut report = parse_import_probe("PROBE_VENV 0\nPROBE_TRY torch\n", false);
        report.timed_out = true;
        assert!(!report.is_healthy());
        let msg = match probe_verdict(&probe_targets("torch\n"), &report, false) {
            ProbeVerdict::Fail(m) => m,
            other => panic!("a hung probe did not stop the install: {other:?}"),
        };
        assert!(msg.contains("did not finish"), "{msg}");
        assert!(msg.contains("torch"), "the module it hung on is unnamed: {msg}");
        assert!(msg.contains("dialog"), "the usual cause is unnamed: {msg}");
    }

    #[test]
    fn a_broken_dependency_chain_names_the_package_that_is_really_gone() {
        // spandrel imports and dies on timm. Quoting only our own side turns
        // that into a riddle.
        assert_eq!(
            module_named_in_error("ModuleNotFoundError: No module named 'timm'").as_deref(),
            Some("timm"),
        );
        assert_eq!(module_named_in_error("OSError: something else"), None);
        let report = parse_import_probe(
            "PROBE_VENV 1\nPROBE_TRY spandrel\nPROBE_FAIL spandrel :: ModuleNotFoundError: No module named 'timm'\nPROBE_DONE\n",
            true,
        );
        let targets = probe_targets("torch\nspandrel\n");
        let msg = match probe_verdict(&targets, &report, true) {
            ProbeVerdict::Fail(m) => m,
            other => panic!("{other:?}"),
        };
        assert!(msg.contains("spandrel (needs timm)"), "{msg}");
    }

    #[test]
    fn the_probe_script_announces_a_module_before_it_imports_it() {
        let script = import_probe_script(&["torch", "yaml"]);
        let try_at = script.find("PROBE_TRY").expect("no try marker");
        let import_at = script.find("importlib.import_module").expect("no import");
        assert!(try_at < import_at, "the name is written after the crash could happen");
        assert!(script.contains("flush()"), "an unflushed line is lost in a crash");
        assert!(script.contains("\"torch\", \"yaml\""), "modules missing: {script}");
        assert!(script.contains("BaseException"), "a SystemExit from an import would escape");
        assert!(script.contains("PROBE_VENV"), "nothing says whether --user would be refused");
    }

    #[test]
    fn the_user_site_escape_is_taken_exactly_where_it_can_work() {
        // The heal step used to lack this entirely, so it died on precisely
        // the machine it exists for: a python.org install under Program Files,
        // where the first wheel that is not already there cannot be written.
        let denied = "ERROR: Could not install packages due to an OSError: [WinError 5] Access is denied: 'C:\\Program Files\\Python312\\Lib\\site-packages'";
        assert!(should_retry_in_user_site(false, denied), "the escape is never taken");
        // Negative control one: a venv REFUSES --user, so retrying there swaps
        // one failure for another.
        assert!(!should_retry_in_user_site(true, denied), "a venv would reject --user");
        // Negative control two: a network failure would just fail again.
        assert!(!should_retry_in_user_site(false, "ConnectionResetError: connection reset by peer"));
    }

    #[test]
    fn the_install_panel_says_which_package_it_is_importing() {
        // Twenty four silent imports on a cold drive look exactly like a hung
        // installer, which is the state 4/4 must never be mistaken for.
        assert_eq!(probe_progress_line("PROBE_TRY torch").as_deref(), Some("Importing torch..."));
        assert_eq!(
            probe_progress_line("PROBE_FAIL yaml :: ModuleNotFoundError: x").as_deref(),
            Some("yaml does not import."),
        );
        // Negative control: the protocol's own bookkeeping is not shown.
        assert_eq!(probe_progress_line("PROBE_OK torch"), None);
        assert_eq!(probe_progress_line("PROBE_VENV 1"), None);
        assert_eq!(probe_progress_line("PROBE_DONE"), None);
    }

    /// PYTHONPATH is process wide and the test runner is threaded, so the live
    /// probe tests take turns. Without this they steal each other's module
    /// folder and fail for a reason that has nothing to do with the probe.
    static PROBE_ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Write a throwaway python module and put its folder on PYTHONPATH, so
    /// the probe can be driven against a real interpreter with a module that
    /// behaves exactly like the customer reports. Returns the module name.
    fn stage_probe_module(dir: &std::path::Path, name: &str, body: &str) -> String {
        std::fs::create_dir_all(dir).expect("probe dir");
        std::fs::write(dir.join(format!("{name}.py")), body).expect("probe module");
        std::env::set_var("PYTHONPATH", dir);
        name.to_string()
    }

    /// The interpreter the live probe tests run against, found the way the
    /// product finds it.
    ///
    /// Not the literal "python3": the CI matrix runs this suite on
    /// windows-latest too, where the interpreter is `python`, lives under
    /// Program Files, or answers only through the `py` launcher. Borrowing the
    /// product's own resolver means these tests cover Windows instead of being
    /// skipped there, and it returns the empty string when the box has no
    /// usable Python, which is the clean skip.
    fn probe_python() -> Option<String> {
        let bin = crate::python::get_python_bin();
        (!bin.is_empty() && crate::python::is_real_python(&bin)).then_some(bin)
    }

    /// The deadline the live tests use. The product waits five minutes for a
    /// cold drive; a test that waited that long would be a CI outage, and a
    /// test that never reaches its deadline proves nothing.
    const TEST_PROBE_DEADLINE: std::time::Duration = std::time::Duration::from_millis(1200);

    /// Long enough that only a broken cancel reaches it, short enough that a
    /// broken cancel fails the job in seconds instead of a minute.
    const TEST_CANCEL_DEADLINE: std::time::Duration = std::time::Duration::from_secs(8);

    /// The script is generated as text, so a stray indent or quote would only
    /// show up on a customer machine. Run it through a real interpreter here.
    /// Skipped where the test box has no python3, which is honest: this asserts
    /// nothing about Windows, only that the program we emit is valid Python.
    #[test]
    fn the_generated_script_is_valid_python_and_speaks_the_parsers_protocol() {
        let _turn = PROBE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(python) = probe_python() else {
            eprintln!("no usable Python on this box, skipping the live probe check");
            return;
        };
        let report = run_import_probe(&python, &["json", "definitely_not_a_real_module_lu"], None, None)
            .expect("not cancelled");
        assert_eq!(report.missing, vec!["definitely_not_a_real_module_lu"], "{report:?}");
        assert!(report.broken.is_empty(), "{report:?}");
        assert!(report.finished, "the DONE marker never arrived: {report:?}");
        assert!(!report.exited_badly, "{report:?}");
    }

    /// The whole reason `promote_crash_from_stderr` is careful: a real child
    /// that warns and then dies without a traceback.
    #[test]
    fn a_real_child_that_warns_then_dies_keeps_its_crash_unexplained() {
        let _turn = PROBE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(python) = probe_python() else {
            eprintln!("no usable Python on this box, skipping the live probe check");
            return;
        };
        let dir = std::env::temp_dir().join("lu-probe-crash-noisy");
        let name = stage_probe_module(
            &dir,
            "lu_probe_boom_noisy",
            "import sys, os\n\
             sys.stderr.write('UserWarning: a library being noisy\\n')\n\
             sys.stderr.flush()\n\
             os._exit(3)\n",
        );
        let report = run_import_probe(&python, &[&name], None, None).expect("not cancelled");
        std::env::remove_var("PYTHONPATH");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(report.crashed.as_deref(), Some(name.as_str()), "{report:?}");
        assert!(report.broken.is_empty(), "a warning was sold as the cause: {report:?}");
        assert!(!report.finished, "{report:?}");
    }

    /// And the same child whose last words DO name a cause.
    #[test]
    fn a_real_child_that_names_a_dll_before_it_dies_gets_that_cause() {
        let _turn = PROBE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(python) = probe_python() else {
            eprintln!("no usable Python on this box, skipping the live probe check");
            return;
        };
        let dir = std::env::temp_dir().join("lu-probe-crash-named");
        let name = stage_probe_module(
            &dir,
            "lu_probe_boom_named",
            "import sys, os\n\
             sys.stderr.write('UserWarning: a library being noisy\\n')\n\
             sys.stderr.write('ImportError: VCOMP140.DLL was not found\\n')\n\
             sys.stderr.flush()\n\
             os._exit(3)\n",
        );
        let report = run_import_probe(&python, &[&name], None, None).expect("not cancelled");
        std::env::remove_var("PYTHONPATH");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(report.crashed.is_none(), "{report:?}");
        assert_eq!(report.broken.len(), 1, "{report:?}");
        assert!(report.broken[0].1.contains("VCOMP140.DLL"), "{report:?}");
    }

    /// An import that never returns is the failure mode a modal loader dialog
    /// produces on Windows, and `Command::output()` would have waited for a
    /// click that never comes.
    #[test]
    fn a_probe_that_hangs_is_killed_at_the_deadline_and_never_passes() {
        let _turn = PROBE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(python) = probe_python() else {
            eprintln!("no usable Python on this box, skipping the live probe check");
            return;
        };
        let dir = std::env::temp_dir().join("lu-probe-hang");
        let name = stage_probe_module(&dir, "lu_probe_hang", "import time\ntime.sleep(120)\n");
        let started = std::time::Instant::now();
        let report = run_import_probe_bounded(&python, &[&name], None, None, TEST_PROBE_DEADLINE)
            .expect("not cancelled");
        std::env::remove_var("PYTHONPATH");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(started.elapsed() < std::time::Duration::from_secs(30), "the deadline did not bite");
        assert!(report.timed_out, "{report:?}");
        assert!(!report.is_healthy(), "a hung probe passed as healthy: {report:?}");
    }

    /// Cancel has to reach the probe too, or the button stops working exactly
    /// at 4/4.
    #[test]
    fn cancel_stops_the_probe_instead_of_waiting_it_out() {
        let _turn = PROBE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(python) = probe_python() else {
            eprintln!("no usable Python on this box, skipping the live probe check");
            return;
        };
        let dir = std::env::temp_dir().join("lu-probe-cancel");
        let name = stage_probe_module(&dir, "lu_probe_cancel", "import time\ntime.sleep(120)\n");
        let flag = Arc::new(AtomicBool::new(false));
        let trip = flag.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            trip.store(true, Ordering::SeqCst);
        });
        let started = std::time::Instant::now();
        let out = run_import_probe_bounded(&python, &[&name], None, Some(&flag), TEST_CANCEL_DEADLINE);
        std::env::remove_var("PYTHONPATH");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(out.err().as_deref(), Some("cancelled"));
        assert!(started.elapsed() < TEST_CANCEL_DEADLINE, "cancel waited the probe out");
    }

}
