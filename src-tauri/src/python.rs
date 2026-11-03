use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Die eine Stelle, die ein Python-Kommando baut.
///
/// Ein Python-Kind mit umgeleiteter Ausgabe kodiert unter Windows mit der alten
/// Codepage, und ein Ausnahmetext mit einem einzigen Zeichen ausserhalb von
/// ASCII bricht den Lauf dann mit einem UnicodeEncodeError ab, statt zu sagen,
/// was los ist. Diese Begruendung stand seit 2.6.8 ueber genau einem von acht
/// Python-Starts im Installer, dem Import-Test, und sie gilt woertlich fuer
/// jeden anderen. Ungeschuetzt waren ausgerechnet die beiden pip-Laeufe, die
/// die laengste Ausgabe erzeugen und dabei staendig Pfade drucken.
///
/// A user (Ticket 003, 03.09.) heisst auf seinem Windows "1 בוגר", also
/// stehen in jedem gedruckten Pfad hebraeische Zeichen. `CREATE_NO_WINDOW`
/// sitzt hier mit drin, damit auch das nicht Stelle fuer Stelle nachgezogen
/// werden muss.
pub fn python_command<S: AsRef<std::ffi::OsStr>>(python_bin: S) -> Command {
    crate::commands::note_interpreter_command();
    let mut cmd = Command::new(python_bin);
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    // K11/K14: the interpreter this runs is always the SYSTEM Python (or a
    // venv built from it), never a Python LU bundles itself, so it is a
    // foreign program in exactly the sense `foreign_system_command` names,
    // and pip (always invoked as `<python> -m pip`, see install/pip.rs)
    // rides along for free. `sanitize_appimage_python_env` above cleans
    // PYTHONHOME/PYTHONPATH globally at startup as a belt-and-braces measure
    // for anything spawned outside python_command; the full table
    // (LD_LIBRARY_PATH, SSL_CERT_FILE/DIR, the GLib/GTK/GStreamer module
    // paths, ...) cannot be cleaned globally because our OWN sidecars need
    // some of it, so every one of them is stripped here, per child, instead.
    crate::process_util::strip_appimage_env(&mut cmd);
    cmd
}

/// True when a `PYTHONHOME` / `PYTHONPATH` value points inside an AppImage's
/// throwaway mount instead of a real Python installation.
///
/// The Linux AppImage runtime mounts itself at `/tmp/.mount_<random>` and its
/// launcher exports `PYTHONHOME` / `PYTHONPATH` into that mount. Those are
/// inherited by every process we spawn, so a system `python3` looks for its
/// standard library inside our AppImage and dies before it runs a line:
///
/// ```text
/// Fatal Python error: init_fs_encoding: failed to get the Python codec of the filesystem encoding
/// ModuleNotFoundError: No module named 'encodings'
/// PYTHONHOME = '/tmp/.mount_LocallieGkad/usr/'
/// ```
///
/// A user hit exactly this installing ComfyUI on Linux Mint (Discord
/// 2026-07-28) with a perfectly healthy Python 3.12, and our diagnosis sent
/// them off to reinstall Python, which of course changed nothing. No AppImage
/// user could ever install ComfyUI.
pub fn is_appimage_python_env(value: &str) -> bool {
    let v = value.trim();
    if v.is_empty() {
        return false;
    }
    // PYTHONPATH is a list; poisoned if any entry points into the mount.
    v.split(':').any(|entry| {
        let e = entry.trim();
        e.starts_with("/tmp/.mount_")
            || std::env::var("APPDIR").is_ok_and(|d| !d.is_empty() && e.starts_with(&d))
    })
}

/// Drop AppImage-injected Python variables from our own environment, so every
/// child process we spawn sees the system Python the way a shell would.
///
/// Called once at startup, before any command runs. `LD_LIBRARY_PATH` is NOT
/// touched globally here on purpose, the AppImage needs it for our own
/// bundled libraries. That used to read "and it was never what broke Python
/// here"; K14 (Reddit, 2026-09-17) is the counterexample: a ComfyUI venv's
/// own `_ssl` extension failed to load under the inherited
/// `LD_LIBRARY_PATH` after an in-app AppImage update, `import ssl` raised,
/// and LU's own diagnosis misread that ImportError as "this Python was
/// built without ssl" instead of an environment collision. The venv's
/// interpreter is a foreign program in exactly `foreign_system_command`'s
/// sense, so it does not go through a global unset, `python_command` (this
/// file) clears it per child instead, alongside every other variable
/// `strip_appimage_env` knows about (see process_util.rs for the reasoning
/// this function's old comment used to carry alone).
pub fn sanitize_appimage_python_env() {
    for key in ["PYTHONHOME", "PYTHONPATH"] {
        if std::env::var(key).is_ok_and(|v| is_appimage_python_env(&v)) {
            tracing::info!(key, "dropping AppImage Python env var so child processes get a clean interpreter");
            std::env::remove_var(key);
        }
    }
}

/// Compute the path to the venv's Python interpreter for a ComfyUI install
/// at `comfyui_dir`. Layout matches what `python -m venv` produces.
///
/// * Windows: `<comfyui_dir>/venv/Scripts/python.exe`
/// * Unix:    `<comfyui_dir>/venv/bin/python`
///
/// The file is NOT guaranteed to exist — call `path.exists()` if you care.
/// Used by both the installer (Bug E — PEP 668 venv creation) and the
/// process launcher (so `start_comfyui` runs ComfyUI inside the same
/// isolated env that pip installed PyTorch into).
pub fn venv_python_path(comfyui_dir: &Path) -> PathBuf {
    venv_python_path_named(comfyui_dir, "venv")
}

/// Same as [`venv_python_path`] but for an arbitrary venv directory name.
/// ComfyUI installs in the wild use either the classic `venv` (LU's own
/// PEP 668 installer — Bug E) or the modern `.venv` (`uv`,
/// `python -m venv .venv`). The file is NOT guaranteed to exist.
pub fn venv_python_path_named(comfyui_dir: &Path, venv_name: &str) -> PathBuf {
    let venv = comfyui_dir.join(venv_name);
    if cfg!(target_os = "windows") {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

/// Where this ComfyUI keeps its packages. Three answers, not two.
///
/// P3 (Windows box, 03.09.2026): `venv\Scripts\python.exe` was renamed and the
/// launcher never noticed. It knew only "venv" and "no venv", a venv without
/// its interpreter fell into the second box, and the answer to "no venv" is
/// "use the system Python". So ComfyUI started on
/// `C:\Program Files\Python311\python.exe` and died on a torch import out of a
/// site-packages tree that has nothing to do with this install.
///
/// The missing answer is [`ComfyVenv::Broken`]: the packages live in that venv,
/// so no other interpreter can start this ComfyUI, and falling back is not a
/// rescue but a guaranteed error message about the wrong environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComfyVenv {
    /// A venv whose interpreter is there.
    Usable(String),
    /// A venv directory without its interpreter. `interpreter` is the file
    /// that is missing, which is the one fact the user cannot see from
    /// outside.
    Broken { venv_dir: PathBuf, interpreter: PathBuf },
    /// No venv. The normal case on Windows and macOS: `install_comfyui` only
    /// builds one when the system Python is PEP 668 protected, otherwise the
    /// requirements go into the system Python and starting from it is right.
    Absent,
}

/// Which of the three answers holds for `comfyui_dir`.
///
/// Both the classic `venv` and the modern `.venv` are checked (issue #51,
/// A user: a macOS/Linux ComfyUI installed into `.venv` was missed and started
/// on the system Python). `venv` first, so LU's own installer keeps its exact
/// behaviour. Usable beats Broken beats Absent.
///
/// What makes a directory a venv rather than a leftover folder: either its
/// PEP 405 marker `pyvenv.cfg`, or torch sitting in its site-packages. The
/// second half is deliberately the same question
/// [`crate::commands::process::prefix_has_torch`] answers for the
/// completeness check, because this module answering it differently is the
/// whole bug: the panel called the install complete (it found torch in the
/// venv) while the launcher called the venv absent (it found no interpreter).
/// An empty folder called `venv` is neither, and must not block a start.
pub fn comfy_venv_state(comfyui_dir: &Path) -> ComfyVenv {
    let mut broken: Option<ComfyVenv> = None;
    for venv_name in ["venv", ".venv"] {
        let interpreter = venv_python_path_named(comfyui_dir, venv_name);
        if interpreter.exists() {
            return ComfyVenv::Usable(interpreter.to_string_lossy().to_string());
        }
        if broken.is_some() {
            continue;
        }
        let venv_dir = comfyui_dir.join(venv_name);
        if venv_dir.join("pyvenv.cfg").exists()
            || crate::commands::process::prefix_has_torch(&venv_dir)
        {
            broken = Some(ComfyVenv::Broken { venv_dir, interpreter });
        }
    }
    // Comfy Desktop (Discord 25.10.2026) keeps each install as
    // `ComfyUI-Installs\<name>\ComfyUI`, and its environment presumably one
    // level up, beside that folder. Without a venv of its own LU started such
    // an install on the system Python. Only inside `ComfyUI-Installs`: an
    // ordinary `~/ComfyUI` must never pick up an unrelated `~/.venv`.
    if broken.is_none() && in_comfy_desktop_installs(comfyui_dir) {
        if let Some(parent) = comfyui_dir.parent() {
            for venv_name in [".venv", "venv"] {
                let interpreter = venv_python_path_named(parent, venv_name);
                if interpreter.exists() {
                    return ComfyVenv::Usable(interpreter.to_string_lossy().to_string());
                }
            }
        }
    }
    broken.unwrap_or(ComfyVenv::Absent)
}

/// Below a `ComfyUI-Installs` folder, the layout of Comfy Desktop.
fn in_comfy_desktop_installs(dir: &Path) -> bool {
    dir.to_string_lossy().split(['\\', '/']).any(|seg| seg.eq_ignore_ascii_case("ComfyUI-Installs"))
}

/// The venv Python for `comfyui_dir` iff it is usable, as a String (matching
/// the API that `process::start_comfyui` uses for its `bundled_python` /
/// `system_python` slots).
///
/// None still means "do not launch from a venv", which is what the installer,
/// the updater and the custom-node path want. Only the launcher has to tell
/// Broken from Absent, so only the launcher asks [`comfy_venv_state`].
pub fn resolve_comfyui_venv_python(comfyui_dir: &Path) -> Option<String> {
    match comfy_venv_state(comfyui_dir) {
        ComfyVenv::Usable(p) => Some(p),
        ComfyVenv::Broken { .. } | ComfyVenv::Absent => None,
    }
}

/// Resolve the real Python binary path, filtering out the Microsoft Store stub
/// alias (`%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`) which prints
/// "Python was not found, run without arguments to install from the Microsoft
/// Store" and exits 1 — useless for `pip install`. Returns the empty string
/// when no real Python is available; callers must treat `""` as
/// "Python not installed". Falling back to the bare `"python"` string the way
/// older versions did re-introduces the Store-stub trap on a fresh Windows
/// box, which is exactly the bug P14 fixes.
/// Non-Windows: walk `os_paths::unix_python_candidates()` and return the first
/// interpreter that resolves on PATH *and* answers `--version`.
///
/// Two constraints decide the shape of this function.
///
/// 1. BUG-008. Grabbing a bare `python3` is wrong on any box whose `python3`
///    is ahead of the ML wheels (3.14 today): ComfyUI, faster-whisper and
///    Piper all die at the first `pip install` with "no matching distribution",
///    and the user has no way to see why. The ordered candidate list that
///    prefers 3.12/3.11 already existed in `os_paths` — it was simply never
///    on the install path, because `find_python` (which uses it) is called by
///    the media lanes and `get_python_bin` (which did not) is called by
///    `AppState::new`, i.e. by everything that installs. This is the wiring.
/// 2. The result must be an ABSOLUTE path. Everything downstream derives
///    facts from it — `commands::process` reads the interpreter's prefix to
///    find torch, error messages quote it — and a bare name has no prefix:
///    `Path::new("python3").parent()` is `Some("")`, which silently turns
///    every derived path into a relative one.
///
/// `which` resolves the name; the `--version` run stays because a dangling
/// symlink or a shim that exits non-zero must be skipped, not cached.
/// Returns the empty string when nothing usable exists — callers treat `""`
/// as "no Python on this box" (see `is_real_python`).
#[cfg(not(target_os = "windows"))]
pub fn get_python_bin() -> String {
    for name in crate::os_paths::unix_python_candidates() {
        for path in python_paths_for(name) {
            let mut cmd = python_command(&path);
            cmd.arg("--version");
            match cmd.output() {
                Ok(output) if output.status.success() => {
                    return path.to_string_lossy().to_string();
                }
                _ => continue,
            }
        }
    }
    String::new()
}

/// The directories a Python lands in that a Finder-started app never has on
/// its PATH.
///
/// An app opened from the Finder or the Dock inherits the launchd PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), not the shell's. So `brew install
/// python@3.12`, which is exactly what our own "Python not found" message
/// tells the user to run, put an interpreter into `/opt/homebrew/bin` that
/// `which` could not see, and the same message came back (Fehlerkontrolle
/// Mac, 08.10.2026, Fund 1). These are looked at in addition to PATH, in this
/// order: Homebrew on Apple Silicon, Homebrew on Intel and python.org, the
/// pyenv shims, uv and pipx, and the real interpreter of the Xcode Command
/// Line Tools.
#[cfg(not(target_os = "windows"))]
pub fn fixed_python_dirs(home: &Path) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        home.join(".pyenv/shims"),
        home.join(".local/bin"),
        PathBuf::from("/Library/Developer/CommandLineTools/usr/bin"),
    ]
}

// The lookup itself is shared with every other program a Finder-started app
// has to find outside its PATH, see `finder_path`.
#[cfg(not(target_os = "windows"))]
pub use crate::finder_path::find_in_dirs;

/// Every place `name` resolves to: the PATH hit first, so a shell-started app
/// keeps its exact behaviour, then the fixed directories. `/usr/bin/python3`
/// is left out while nothing stands behind it (see `apple_shim_is_backed`).
#[cfg(not(target_os = "windows"))]
pub fn python_paths_for(name: &str) -> Vec<PathBuf> {
    let on_path = which::which(name).ok();
    let fixed = find_in_dirs(name, &fixed_python_dirs(&crate::os_paths::home()));
    let mut out: Vec<PathBuf> = Vec::new();
    for path in on_path.into_iter().chain(fixed) {
        if is_apple_python_shim(&path) && !apple_shim_is_backed(developer_dir().as_deref()) {
            continue;
        }
        if !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

/// `/usr/bin/python3` on macOS is not an interpreter but a shim into the
/// developer tools. Without them, starting it pops up the system dialog
/// "Install Command Line Developer Tools" in the middle of our probe.
#[cfg(not(target_os = "windows"))]
pub fn is_apple_python_shim(path: &Path) -> bool {
    cfg!(target_os = "macos") && (path == Path::new("/usr/bin/python3") || path == Path::new("/usr/bin/python"))
}

/// Whether the shim has an interpreter to hand over to: the active developer
/// directory carries its own `usr/bin/python3`.
#[cfg(not(target_os = "windows"))]
pub fn apple_shim_is_backed(developer_dir: Option<&Path>) -> bool {
    developer_dir.is_some_and(|d| d.join("usr/bin/python3").is_file())
}

/// What `xcode-select -p` names. It only prints a path and never opens the
/// install dialog, which is the whole reason to ask it first.
#[cfg(not(target_os = "windows"))]
fn developer_dir() -> Option<PathBuf> {
    static DIR: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let out = crate::process_util::foreign_system_command("/usr/bin/xcode-select").arg("-p").output().ok()?;
        if !out.status.success() {
            return None;
        }
        let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!dir.is_empty()).then(|| PathBuf::from(dir))
    })
    .clone()
}

/// Windows: probe in order of reliability. Crucially this now tries the `py -3`
/// launcher and C:\Program Files\Python* — without them, an all-users python.org
/// install that skipped the "Add to PATH" checkbox (the a user "python not
/// installed" Discord report) was invisible to LU even though Python WAS
/// installed: `where python` returned nothing (or only the Store stub) and the
/// fixed-path scan only looked at the bare `C:\PythonXX` drive-root layout.
#[cfg(target_os = "windows")]
pub fn get_python_bin() -> String {
    if let Some(p) = python_via_where() { return p; }
    if let Some(p) = python_via_py_launcher() { return p; }
    if let Some(p) = python_in_fixed_paths() { return p; }
    if let Some(p) = python_in_program_files() { return p; }
    if let Some(p) = python_in_appdata() { return p; }
    if let Some(p) = python_in_conda() { return p; }
    println!("[Python] No real Python found on PATH or known locations — returning empty sentinel");
    String::new()
}

/// Run a candidate interpreter and confirm it's real (exits 0, not the MS Store
/// stub which prints an install nag and exits 1).
#[cfg(target_os = "windows")]
fn verify_python_path(path: &str) -> bool {
    if path.is_empty() || path.contains("WindowsApps") {
        return false;
    }
    let mut cmd = python_command(path);
    cmd.arg("--version");
    crate::process_util::suppress_window(&mut cmd);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

/// `where python` on PATH, skipping the WindowsApps Store-stub alias.
#[cfg(target_os = "windows")]
fn python_via_where() -> Option<String> {
    let mut where_cmd = crate::process_util::foreign_system_command("where");
    where_cmd.arg("python");
    crate::process_util::suppress_window(&mut where_cmd);
    let output = where_cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let path = line.trim();
        if !path.is_empty() && !path.contains("WindowsApps") && verify_python_path(path) {
            println!("[Python] Found via `where`: {}", path);
            return Some(path.to_string());
        }
    }
    None
}

/// The Windows `py -3` launcher (C:\Windows\py.exe) is installed system-wide by
/// the python.org installer regardless of the "Add to PATH" checkbox and the
/// install dir, so it finds Pythons that `where` + fixed-path scans miss. We ask
/// Python for its own sys.executable so we cache the concrete python.exe (needed
/// for venv creation / pip), not the launcher shim.
#[cfg(target_os = "windows")]
fn python_via_py_launcher() -> Option<String> {
    let mut cmd = python_command("py");
    cmd.args(["-3", "-c", "import sys; print(sys.executable)"]);
    crate::process_util::suppress_window(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if verify_python_path(&path) {
        println!("[Python] Found via `py -3` launcher: {}", path);
        Some(path)
    } else {
        None
    }
}

/// Standard single-version python.org install dirs at the drive root.
#[cfg(target_os = "windows")]
const WINDOWS_FIXED_PYTHONS: [&str; 5] = [
    "C:\\Python313\\python.exe",
    "C:\\Python312\\python.exe",
    "C:\\Python311\\python.exe",
    "C:\\Python310\\python.exe",
    "C:\\Python39\\python.exe",
];

#[cfg(target_os = "windows")]
fn python_in_fixed_paths() -> Option<String> {
    for p in WINDOWS_FIXED_PYTHONS {
        if Path::new(p).exists() && verify_python_path(p) {
            println!("[Python] Found at fixed path: {}", p);
            return Some(p.to_string());
        }
    }
    None
}

/// All-users python.org installs land in C:\Program Files\PythonXX (and the
/// 32-bit build under Program Files (x86)) — neither was scanned before, the
/// other half of the report.
#[cfg(target_os = "windows")]
fn python_in_program_files() -> Option<String> {
    for env_key in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Ok(base) = std::env::var(env_key) {
            if let Some(p) = scan_python_subdirs(Path::new(&base), "Program Files") {
                return Some(p);
            }
        }
    }
    None
}

/// Per-user python.org installs: %LOCALAPPDATA%\Programs\Python\Python3xx.
#[cfg(target_os = "windows")]
fn python_in_appdata() -> Option<String> {
    let localappdata = std::env::var("LOCALAPPDATA").ok()?;
    let base = Path::new(&localappdata).join("Programs").join("Python");
    scan_python_subdirs(&base, "AppData")
}

/// Scan `base` for `Python3xx\python.exe`, newest version first.
#[cfg(target_os = "windows")]
fn scan_python_subdirs(base: &Path, label: &str) -> Option<String> {
    let path = python_subdirs(base).into_iter().next()?;
    println!("[Python] Found in {}: {}", label, path);
    Some(path)
}

/// Every runnable `Python3xx\python.exe` under `base`, newest version first.
#[cfg(target_os = "windows")]
fn python_subdirs(base: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(base) else { return Vec::new() };
    let mut dirs: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().ok().is_some_and(|ft| ft.is_dir())
                && e.file_name().to_string_lossy().to_lowercase().starts_with("python")
        })
        .collect();
    dirs.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
    dirs.into_iter()
        .map(|dir| dir.path().join("python.exe"))
        .filter(|exe| exe.exists())
        .map(|exe| exe.to_string_lossy().to_string())
        .filter(|path| verify_python_path(path))
        .collect()
}

/// Miniconda / Anaconda base env in the user profile.
#[cfg(target_os = "windows")]
fn conda_candidates() -> Vec<PathBuf> {
    let Ok(userprofile) = std::env::var("USERPROFILE") else { return Vec::new() };
    vec![
        Path::new(&userprofile).join("miniconda3").join("python.exe"),
        Path::new(&userprofile).join("anaconda3").join("python.exe"),
        Path::new(&userprofile).join("miniconda3").join("Scripts").join("python.exe"),
        Path::new(&userprofile).join("anaconda3").join("Scripts").join("python.exe"),
    ]
}

#[cfg(target_os = "windows")]
fn python_in_conda() -> Option<String> {
    for p in conda_candidates() {
        if p.exists() {
            let path = p.to_string_lossy().to_string();
            if verify_python_path(&path) {
                println!("[Python] Found Conda: {}", path);
                return Some(path);
            }
        }
    }
    None
}

/// True for a 64-bit x86 interpreter, the only architecture PyTorch's Windows
/// CUDA wheels exist for. `bits` is `struct.calcsize('P') * 8`, which is what
/// actually answers "32-bit or 64-bit": a 32-bit interpreter running under
/// WOW64 on a 64-bit Windows still reports `platform.machine() == "AMD64"`,
/// because that reads the OS, not the process. `machine` is
/// `platform.machine()`, which is what actually answers "x86 or ARM": a
/// native ARM64 interpreter is genuinely 64-bit, and torch still has no
/// Windows wheel for it. Both have to agree.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn is_trainer_arch(bits: u32, machine: &str) -> bool {
    bits == 64 && machine.eq_ignore_ascii_case("AMD64")
}

/// Every interpreter this machine has, LU's usual order, duplicates and the
/// Store stub dropped. `get_python_bin` answers "which Python does LU use";
/// a lane whose wheels stop at a version has to ask "which Pythons are
/// there" and pick its own. Until 2.6.8 nobody asked, so a box whose newest
/// Python was 3.14 built the trainer venv from 3.14 and died at step 4/4
/// (Discord, August and ticket 0004 on 2026-09-05).
///
/// Runde 3, B1(a): PATH alone missed the exact boxes the torch preflight
/// exists for. `uv python install` and `pyenv install`, the two commands
/// the preflight message itself now suggests, put their interpreters
/// somewhere PATH never sees unless the user also runs `pyenv init` or
/// `uv python pin`, so a machine that just followed the suggested command
/// would still show up as "no compatible interpreter found" on the very
/// next Repair. This walks those install locations directly, plus the
/// explicit `python3.10`..`python3.13` names (torch's usual served range),
/// so the install-then-repair loop the message promises actually closes.
///
/// Nothing here starts an interpreter beyond the `--version` gate the
/// existing scans apply; the caller asks each hit for its version.
#[cfg(not(target_os = "windows"))]
pub fn python_interpreters() -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut push = |path: PathBuf| {
        if !path.exists() {
            return;
        }
        // Runde 4, review Runde 3 "Kleinere Punkte zu B1": the `python3.*`
        // glob patterns below also match `python3.13-config` and
        // `python3.13-gdb.py`, siblings the real interpreter's own install
        // drops next to it. Neither ever starts (execution fails, so
        // `python_version_tuple` returns None), but both would still show
        // up as "(version unknown)" ghost lines in the customer-facing
        // preflight message, making it longer and more confusing than the
        // interpreters actually found warrant. Only the bare `python3` or
        // `python3.<digits>` shape is a real interpreter name.
        let is_python_binary_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n == "python" || n == "python3" || {
                n.strip_prefix("python3.").is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
            });
        if !is_python_binary_name {
            return;
        }
        let path = path.to_string_lossy().to_string();
        if !found.contains(&path) {
            found.push(path);
        }
    };
    for name in crate::os_paths::unix_python_candidates() {
        if let Ok(path) = which::which(name) {
            push(path);
        }
    }
    // Explicit names beyond what `unix_python_candidates` orders for the
    // default picker (that list stops at 3.11/3.12/3.13 by design, oldest
    // first is never its job): 3.10 through 3.13 is the range the torch
    // preflight message actually needs to reason about, and 3.14 is the
    // newest the Mac engines' pins have wheels for (GH #188), so a 3.14 next
    // to a `python3` that is already 3.15 is found.
    for minor in 10..=14 {
        if let Ok(path) = which::which(format!("python3.{minor}")) {
            push(path);
        }
    }
    let home = crate::os_paths::home();
    // pyenv: every installed version keeps its own bin/ under versions/.
    for pattern in [
        home.join(".pyenv/versions/*/bin/python3"),
        home.join(".pyenv/versions/*/bin/python"),
        // uv-managed interpreters: `uv python install 3.12` lands here,
        // named after the exact version instead of a generic "python3".
        home.join(".local/share/uv/python/*/bin/python3"),
        home.join(".local/share/uv/python/*/bin/python3.*"),
    ] {
        for entry in glob::glob(&pattern.to_string_lossy()).into_iter().flatten().flatten() {
            push(entry);
        }
    }
    // Fixed, non-PATH-guaranteed locations named in the review: a user's own
    // pip-installed interpreter (`~/.local/bin`), a distro's optional package
    // prefix (`/opt/<name>/bin`), and the common source-build prefix
    // (`/usr/local/bin`), none of which every shell's PATH carries by default.
    for base in [home.join(".local/bin"), PathBuf::from("/usr/local/bin")] {
        for minor in 10..=14 {
            push(base.join(format!("python3.{minor}")));
        }
    }
    for pattern in ["/opt/*/bin/python3", "/opt/*/bin/python3.*"] {
        for entry in glob::glob(pattern).into_iter().flatten().flatten() {
            push(entry);
        }
    }
    found
}

/// Windows walks the launcher registry first: `py -0p` lists every
/// python.org install with its path (PEP 514), whether or not it is on PATH.
/// Then the same places `get_python_bin` looks, all hits instead of the
/// first.
#[cfg(target_os = "windows")]
pub fn python_interpreters() -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut push = |p: String| {
        if !p.is_empty()
            && !p.contains("WindowsApps")
            && !found.iter().any(|f| f.eq_ignore_ascii_case(&p))
        {
            found.push(p);
        }
    };
    let mut launcher = python_command("py");
    launcher.arg("-0p");
    crate::process_util::suppress_window(&mut launcher);
    if let Ok(out) = launcher.output() {
        if out.status.success() {
            for p in launcher_list_paths(&String::from_utf8_lossy(&out.stdout)) {
                push(p);
            }
        }
    }
    let mut where_cmd = crate::process_util::foreign_system_command("where");
    where_cmd.arg("python");
    crate::process_util::suppress_window(&mut where_cmd);
    if let Ok(out) = where_cmd.output() {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                push(line.trim().to_string());
            }
        }
    }
    for p in WINDOWS_FIXED_PYTHONS {
        if Path::new(p).exists() {
            push(p.to_string());
        }
    }
    for env_key in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Ok(base) = std::env::var(env_key) {
            for p in python_subdirs(Path::new(&base)) {
                push(p);
            }
        }
    }
    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        for p in python_subdirs(&Path::new(&localappdata).join("Programs").join("Python")) {
            push(p);
        }
    }
    for p in conda_candidates() {
        if p.exists() {
            push(p.to_string_lossy().to_string());
        }
    }
    found
}

/// The path column of `py -0p`. Lines look like
/// ` -V:3.13 *        C:\Python313\python.exe` (launcher 3.11 and newer) or
/// ` -3.11-64 *       C:\Program Files\Python311\python.exe` (older), the
/// star marks the default, and a path may contain spaces, so everything after
/// the tag and the optional star is the path.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn launcher_list_paths(listing: &str) -> Vec<String> {
    listing
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('-'))
        .filter_map(|l| {
            let rest = l[l.find(char::is_whitespace)?..].trim_start();
            let rest = rest.strip_prefix('*').map_or(rest, str::trim_start);
            let rest = rest.trim();
            (!rest.is_empty()).then(|| rest.to_string())
        })
        .collect()
}

/// True iff `bin` looks like a real, runnable Python binary (not the empty
/// sentinel from `get_python_bin` and not a Microsoft Store stub).
pub fn is_real_python(bin: &str) -> bool {
    if bin.is_empty() {
        return false;
    }
    if bin.contains("WindowsApps") {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // ── Ticket 003: die Kodierung haengt am Kommando, nicht am Aufrufer ────

    #[test]
    fn python_command_carries_the_utf8_environment() {
        let cmd = python_command("python3");
        let envs: Vec<(String, Option<String>)> = cmd
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().to_string(),
                    v.map(|v| v.to_string_lossy().to_string()),
                )
            })
            .collect();
        assert!(
            envs.contains(&("PYTHONIOENCODING".to_string(), Some("utf-8".to_string()))),
            "ohne PYTHONIOENCODING bricht ein Pfad mit hebraeischen Zeichen den Lauf ab: {envs:?}",
        );
        assert!(
            envs.contains(&("PYTHONUTF8".to_string(), Some("1".to_string()))),
            "ohne PYTHONUTF8 bleibt die alte Codepage die Voreinstellung: {envs:?}",
        );
        assert_eq!(cmd.get_program(), "python3", "das Programm darf nicht verloren gehen");
    }

    #[test]
    fn python_command_strips_an_appimage_ld_library_path() {
        // K11: the interpreter python_command builds is always the SYSTEM
        // python (or a venv on top of it), never something LU bundles, so it
        // must not inherit an AppImage's own library path the way `git` did
        // on CachyOS/Arch (K2/K11 field report, a user 2026-09-16).
        std::env::set_var("APPDIR", "/tmp/.mount_LocallieGkad");
        std::env::set_var(
            "LD_LIBRARY_PATH",
            "/tmp/.mount_LocallieGkad/usr/lib:/usr/local/lib",
        );
        let cmd = python_command("python3");
        let ld = cmd
            .get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new("LD_LIBRARY_PATH"))
            .and_then(|(_, v)| v)
            .map(|v| v.to_string_lossy().into_owned());
        assert_eq!(ld.as_deref(), Some("/usr/local/lib"), "the AppImage entry should have been stripped");

        // Negative control: without APPDIR (every platform but a running
        // Linux AppImage) nothing overrides LD_LIBRARY_PATH at all.
        std::env::remove_var("APPDIR");
        let cmd = python_command("python3");
        assert!(
            cmd.get_envs().all(|(k, _)| k != std::ffi::OsStr::new("LD_LIBRARY_PATH")),
            "no APPDIR means LD_LIBRARY_PATH must be left untouched"
        );
        std::env::remove_var("LD_LIBRARY_PATH");
    }

    #[test]
    fn python_command_takes_a_path_as_well_as_a_string() {
        // Die Aufrufstellen halten mal einen String, mal einen Pfad. Beide
        // muessen durch dieselbe Tuer passen, sonst baut die naechste sich
        // wieder ihr eigenes Kommando.
        let p = std::path::PathBuf::from("/usr/bin/python3");
        assert_eq!(python_command(&p).get_program(), p.as_os_str());
        assert_eq!(python_command(String::from("py")).get_program(), "py");
    }

    // ── AppImage Python env poisoning (Discord 2026-07-28) ────────

    /// The exact values from the failing install on Linux Mint. Our own
    /// AppImage mount, inherited by the python3 we spawn, which then cannot
    /// find its standard library.
    #[test]
    fn appimage_mount_paths_are_recognised() {
        assert!(is_appimage_python_env("/tmp/.mount_LocallieGkad/usr/"));
        assert!(is_appimage_python_env("/tmp/.mount_LocallieGkad/usr/share/pyshared/:"));
        assert!(is_appimage_python_env("/tmp/.mount_ABC123/usr/lib/python3.12"));
    }

    #[test]
    fn a_poisoned_entry_anywhere_in_the_list_counts() {
        // PYTHONPATH is colon-separated; one bad entry breaks the interpreter.
        assert!(is_appimage_python_env("/home/u/mylib:/tmp/.mount_XY/usr/share/pyshared/"));
    }

    #[test]
    fn real_python_installs_are_left_alone() {
        assert!(!is_appimage_python_env("/usr/lib/python3.12"));
        assert!(!is_appimage_python_env("/home/user/.local/lib/python3.12"));
        assert!(!is_appimage_python_env("/opt/python3.11"));
        assert!(!is_appimage_python_env("C:\\Python312"));
        // A user's own directory that merely lives under /tmp is not a mount.
        assert!(!is_appimage_python_env("/tmp/my-python-experiment"));
    }

    #[test]
    fn empty_and_whitespace_are_not_poisoned() {
        assert!(!is_appimage_python_env(""));
        assert!(!is_appimage_python_env("   "));
    }

    // ── venv_python_path layout (Bug E — Arch PEP 668 venv) ─────────────────

    #[test]
    fn a_comfy_desktop_install_starts_from_the_venv_beside_it() {
        let tmp = tempfile::tempdir().unwrap();
        let install = tmp.path().join("Comfy-Desktop").join("ComfyUI-Installs").join("ComfyUI");
        let comfy = install.join("ComfyUI");
        std::fs::create_dir_all(&comfy).unwrap();
        let py = venv_python_path_named(&install, ".venv");
        std::fs::create_dir_all(py.parent().unwrap()).unwrap();
        std::fs::write(&py, b"").unwrap();
        assert_eq!(comfy_venv_state(&comfy), ComfyVenv::Usable(py.to_string_lossy().to_string()));
        // A venv of its own still wins.
        let own = venv_python_path_named(&comfy, "venv");
        std::fs::create_dir_all(own.parent().unwrap()).unwrap();
        std::fs::write(&own, b"").unwrap();
        assert_eq!(comfy_venv_state(&comfy), ComfyVenv::Usable(own.to_string_lossy().to_string()));
    }

    #[test]
    fn an_ordinary_comfyui_never_takes_the_venv_of_its_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        std::fs::create_dir_all(&comfy).unwrap();
        let py = venv_python_path_named(tmp.path(), ".venv");
        std::fs::create_dir_all(py.parent().unwrap()).unwrap();
        std::fs::write(&py, b"").unwrap();
        assert_eq!(comfy_venv_state(&comfy), ComfyVenv::Absent);
    }

    #[test]
    fn venv_python_path_matches_platform_layout() {
        let p = venv_python_path(Path::new("/home/u/ComfyUI"));
        let s = p.to_string_lossy().to_string();
        // On Windows expect `Scripts/python.exe`, on Unix expect `bin/python`.
        if cfg!(target_os = "windows") {
            assert!(
                s.ends_with("venv\\Scripts\\python.exe") || s.ends_with("venv/Scripts/python.exe"),
                "got {} on Windows",
                s
            );
        } else {
            assert!(s.ends_with("venv/bin/python"), "got {} on Unix", s);
        }
    }

    #[test]
    fn venv_python_path_is_under_comfyui_dir() {
        let comfy = Path::new("/some/where/ComfyUI");
        let venv_py = venv_python_path(comfy);
        assert!(
            venv_py.starts_with(comfy),
            "venv python {} did not start with {}",
            venv_py.display(),
            comfy.display()
        );
    }

    // ── resolve_comfyui_venv_python — existence gate ────────────────────────

    /// ── Why these three no longer name their own directory ──
    ///
    /// They used the FIXED paths `<temp>/lu-venv-test-missing`,
    /// `…-present` and `lu-dotvenv-test-present`, and each began by deleting
    /// its own. Every concurrent copy of this test binary used the same three,
    /// so one copy's `remove_dir_all` landed between another's `create_dir_all`
    /// and its `resolve_comfyui_venv_python` — the stub python was gone and the
    /// resolver correctly answered `None`. Measured on 01.09.2026 under six
    /// concurrent copies of the suite, ten rounds:
    /// `resolve_returns_some_when_venv_python_exists` and
    /// `resolve_finds_dot_venv_layout` failed 1 of 60 runs each.
    ///
    /// `crate::os_paths::test_dir` puts the process id and the thread id in the
    /// name and sweeps up on `Drop`, even when an assertion panics.
    #[test]
    fn resolve_returns_none_when_venv_missing() {
        let tmp = crate::os_paths::test_dir("venv-missing");
        assert!(resolve_comfyui_venv_python(&tmp).is_none());
    }

    #[test]
    fn resolve_returns_some_when_venv_python_exists() {
        // Build the exact layout `python -m venv` would produce so the
        // resolver finds it without actually invoking Python.
        let tmp = crate::os_paths::test_dir("venv-present");
        let inner = if cfg!(target_os = "windows") {
            tmp.join("venv").join("Scripts")
        } else {
            tmp.join("venv").join("bin")
        };
        fs::create_dir_all(&inner).unwrap();
        let py = if cfg!(target_os = "windows") {
            inner.join("python.exe")
        } else {
            inner.join("python")
        };
        fs::write(&py, "stub").unwrap();
        let resolved = resolve_comfyui_venv_python(&tmp);
        assert!(resolved.is_some(), "expected resolver to find {}", py.display());
        assert!(resolved.unwrap().contains("venv"));
    }

    #[test]
    fn resolve_finds_dot_venv_layout() {
        // Issue #51: ComfyUI installed into `.venv` (uv / modern
        // `python -m venv .venv`) must also be picked up, not just `venv`.
        let tmp = crate::os_paths::test_dir("dotvenv-present");
        let inner = if cfg!(target_os = "windows") {
            tmp.join(".venv").join("Scripts")
        } else {
            tmp.join(".venv").join("bin")
        };
        fs::create_dir_all(&inner).unwrap();
        let py = if cfg!(target_os = "windows") {
            inner.join("python.exe")
        } else {
            inner.join("python")
        };
        fs::write(&py, "stub").unwrap();
        let resolved = resolve_comfyui_venv_python(&tmp);
        assert!(resolved.is_some(), "expected resolver to find {}", py.display());
        assert!(resolved.unwrap().contains(".venv"));
    }

    // ── P3: comfy_venv_state, die dritte Antwort ───────────────────────────
    //
    // Der Tester hat `venv\Scripts\python.exe` umbenannt und Start gedrueckt.
    // Die App hat es nicht gemerkt und still
    // `C:\Program Files\Python311\python.exe` gestartet, weil "venv ohne
    // Interpreter" und "kein venv" bis dahin dieselbe Antwort waren.

    /// Legt ein venv an, dem genau der Interpreter fehlt. `Lib/site-packages`
    /// ist die Windows-Form, und `prefix_has_torch` prueft alle Formen auf
    /// jeder Plattform, also braucht der Test keinen Plattformzweig.
    fn broken_venv(tmp: &std::path::Path, venv_name: &str, marker: bool, torch: bool) {
        let venv = tmp.join(venv_name);
        fs::create_dir_all(&venv).unwrap();
        if marker {
            fs::write(venv.join("pyvenv.cfg"), "home = C:\\Program Files\\Python311\n").unwrap();
        }
        if torch {
            fs::create_dir_all(venv.join("Lib").join("site-packages").join("torch")).unwrap();
        }
    }

    #[test]
    fn ein_venv_ohne_interpreter_ist_kaputt_und_nicht_abwesend() {
        let tmp = crate::os_paths::test_dir("venv-broken");
        broken_venv(&tmp, "venv", true, true);
        assert_eq!(
            comfy_venv_state(&tmp),
            ComfyVenv::Broken {
                venv_dir: tmp.join("venv"),
                interpreter: venv_python_path_named(&tmp, "venv"),
            },
            "der Fall des Testers muss von 'kein venv' unterscheidbar sein",
        );
        // Der Vertrag der sechs anderen Aufrufer bleibt: kaputt heisst weiter
        // "starte hier nicht heraus".
        assert!(resolve_comfyui_venv_python(&tmp).is_none());
    }

    #[test]
    fn ein_venv_ohne_marke_aber_mit_torch_ist_auch_kaputt() {
        // process.rs:628-632 nennt die Form ausdruecklich: manche Werkzeuge
        // legen site-packages ohne pyvenv.cfg an. Die Vollstaendigkeitspruefung
        // zaehlt so ein Verzeichnis als fertige Installation, also darf der
        // Launcher es nicht als abwesend lesen.
        let tmp = crate::os_paths::test_dir("venv-broken-nomarker");
        broken_venv(&tmp, "venv", false, true);
        assert!(matches!(comfy_venv_state(&tmp), ComfyVenv::Broken { .. }));
    }

    #[test]
    fn ein_leerer_ordner_namens_venv_ist_kein_venv() {
        // Negativkontrolle zu den beiden darueber: wer `Broken` am blossen
        // Ordnernamen festmacht, verweigert hier einen Start, der heute laeuft.
        let tmp = crate::os_paths::test_dir("venv-empty");
        broken_venv(&tmp, "venv", false, false);
        assert_eq!(comfy_venv_state(&tmp), ComfyVenv::Absent);
        assert!(resolve_comfyui_venv_python(&tmp).is_none());
    }

    #[test]
    fn auch_ein_punkt_venv_kann_kaputt_sein() {
        // Issue #51 noch einmal, eine Ebene tiefer: die uv-Form darf nicht
        // durch dasselbe Raster fallen wie damals.
        let tmp = crate::os_paths::test_dir("dotvenv-broken");
        broken_venv(&tmp, ".venv", true, false);
        assert_eq!(
            comfy_venv_state(&tmp),
            ComfyVenv::Broken {
                venv_dir: tmp.join(".venv"),
                interpreter: venv_python_path_named(&tmp, ".venv"),
            },
        );
    }

    #[test]
    fn ein_benutzbares_venv_gewinnt_weiterhin() {
        let tmp = crate::os_paths::test_dir("venv-usable-wins");
        // Ein kaputtes `.venv` daneben, damit die Reihenfolge geprueft wird und
        // nicht nur der Einzelfall.
        broken_venv(&tmp, ".venv", true, false);
        broken_venv(&tmp, "venv", true, true);
        let py = venv_python_path_named(&tmp, "venv");
        fs::create_dir_all(py.parent().unwrap()).unwrap();
        fs::write(&py, "stub").unwrap();
        assert_eq!(
            comfy_venv_state(&tmp),
            ComfyVenv::Usable(py.to_string_lossy().to_string()),
        );
        assert_eq!(
            resolve_comfyui_venv_python(&tmp).as_deref(),
            Some(py.to_string_lossy().as_ref()),
        );
    }

    // ── is_real_python (Bug P14 — Microsoft Store stub filter) ──────────────

    #[test]
    fn real_python_rejects_empty() {
        assert!(!is_real_python(""));
    }

    #[test]
    fn real_python_rejects_windowsapps_stub() {
        assert!(!is_real_python("C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe"));
    }

    #[test]
    fn real_python_accepts_real_path() {
        assert!(is_real_python("/usr/bin/python3"));
        assert!(is_real_python("C:\\Python312\\python.exe"));
    }

    // ── get_python_bin wiring (OI-6: BUG-008 resolver was never called) ─────

    /// The install path must never hand out a bare `python3`. Two things break
    /// on it: BUG-008 (a 3.14 with no ML wheels wins over an installed 3.12),
    /// and every consumer that derives a path from the interpreter, because
    /// `Path::new("python3").parent()` is `Some("")` and not a real prefix.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn get_python_bin_returns_an_absolute_interpreter_or_the_empty_sentinel() {
        let bin = get_python_bin();
        if bin.is_empty() {
            // No Python on this box — the documented sentinel, not a failure.
            return;
        }
        let p = Path::new(&bin);
        assert!(p.is_absolute(), "get_python_bin returned a bare name: {bin}");
        assert!(p.exists(), "get_python_bin returned a path that does not exist: {bin}");
        // The regression in one line: a bare name has no usable parent.
        let parent = p.parent().expect("an absolute interpreter has a parent");
        assert!(
            !parent.as_os_str().is_empty(),
            "interpreter prefix is empty, derived paths would be relative: {bin}"
        );
    }

    /// It has to come from the ordered list, not from a fresh probe of its
    /// own — that list IS the BUG-008 fix.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn get_python_bin_picks_a_candidate_from_the_bug_008_order() {
        let bin = get_python_bin();
        if bin.is_empty() {
            return;
        }
        let resolved: Vec<String> = crate::os_paths::unix_python_candidates()
            .iter()
            .flat_map(|n| python_paths_for(n))
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        assert!(
            resolved.contains(&bin),
            "{bin} is not one of the BUG-008 candidates {resolved:?}"
        );
    }

    // ── Fehlerkontrolle Mac, Fund 1: ein Python ausserhalb von PATH ─────────

    /// A Finder-started app has `/usr/bin:/bin:/usr/sbin:/sbin` and nothing
    /// else, so the directories Homebrew, pyenv and uv install into have to be
    /// named outright.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn the_fixed_directories_cover_homebrew_pyenv_uv_and_the_command_line_tools() {
        let dirs = fixed_python_dirs(Path::new("/Users/someone"));
        for expected in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/Users/someone/.pyenv/shims",
            "/Users/someone/.local/bin",
            "/Library/Developer/CommandLineTools/usr/bin",
        ] {
            assert!(dirs.contains(&PathBuf::from(expected)), "{expected} is not searched");
        }
        assert_eq!(dirs[0], PathBuf::from("/opt/homebrew/bin"), "Homebrew on Apple Silicon comes first");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn an_interpreter_in_a_fixed_directory_is_found_without_path() {
        let tmp = crate::os_paths::test_dir("fixed-python");
        let brew = tmp.join("opt/homebrew/bin");
        let local = tmp.join("usr/local/bin");
        fs::create_dir_all(&brew).unwrap();
        fs::create_dir_all(&local).unwrap();
        fs::write(local.join("python3.12"), "stub").unwrap();
        // A directory of that name is not an interpreter.
        fs::create_dir_all(brew.join("python3.11")).unwrap();
        let dirs = [brew.clone(), local.clone(), tmp.join("missing")];
        assert_eq!(find_in_dirs("python3.12", &dirs), vec![local.join("python3.12")]);
        assert!(find_in_dirs("python3.11", &dirs).is_empty());
        fs::write(brew.join("python3.12"), "stub").unwrap();
        assert_eq!(
            find_in_dirs("python3.12", &dirs),
            vec![brew.join("python3.12"), local.join("python3.12")],
            "the order of the directories is the order of the answers"
        );
    }

    /// Without the developer tools `/usr/bin/python3` opens an install dialog
    /// instead of answering, so it is only started when something backs it.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn the_apple_shim_counts_only_with_developer_tools_behind_it() {
        assert!(!apple_shim_is_backed(None), "no developer directory, no interpreter");
        let tmp = crate::os_paths::test_dir("clt");
        assert!(!apple_shim_is_backed(Some(&tmp)), "a developer directory without python3");
        fs::create_dir_all(tmp.join("usr/bin")).unwrap();
        fs::write(tmp.join("usr/bin/python3"), "stub").unwrap();
        assert!(apple_shim_is_backed(Some(&tmp)));
        assert!(!is_apple_python_shim(Path::new("/opt/homebrew/bin/python3")));
        assert_eq!(is_apple_python_shim(Path::new("/usr/bin/python3")), cfg!(target_os = "macos"));
    }

    // ── Windows resolver helpers (Bug B — a user "python not installed") ────

    #[cfg(target_os = "windows")]
    #[test]
    fn verify_rejects_stub_and_empty() {
        assert!(!verify_python_path(""));
        assert!(!verify_python_path(
            "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe"
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn scan_python_subdirs_none_for_missing_dir() {
        let missing = std::env::temp_dir().join("lu-no-such-python-dir-zzz");
        let _ = fs::remove_dir_all(&missing);
        assert!(scan_python_subdirs(&missing, "test").is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn scan_python_subdirs_skips_non_python_dirs() {
        // A dir with no Python3xx subfolder yields None (doesn't pick garbage).
        let tmp = std::env::temp_dir().join("lu-pf-scan-test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("NotPython").join("nested")).unwrap();
        assert!(scan_python_subdirs(&tmp, "test").is_none());
        let _ = fs::remove_dir_all(&tmp);
    }

    // ── K4: a 64-bit interpreter can still be the wrong architecture ────────
    // (Discord 2026-09-16: a 3.11/3.12 that passes every version
    // check and still cannot install torch).

    #[test]
    fn a_64_bit_x86_interpreter_is_the_only_one_the_trainer_wants() {
        assert!(is_trainer_arch(64, "AMD64"));
        // platform.machine() case varies by Python build; the check must not.
        assert!(is_trainer_arch(64, "amd64"));
    }

    #[test]
    fn a_native_arm64_interpreter_is_64_bit_and_still_wrong() {
        // The pointer-size check alone would let this through: ARM64 Windows
        // Python is genuinely 64-bit, torch just has no wheel for it.
        assert!(!is_trainer_arch(64, "ARM64"));
    }

    #[test]
    fn a_32_bit_interpreter_is_wrong_even_when_wow64_says_amd64() {
        // A 32-bit interpreter on 64-bit Windows still reports
        // platform.machine() == "AMD64" (that reads the OS, not the
        // process); struct.calcsize('P') is the one that catches it.
        assert!(!is_trainer_arch(32, "AMD64"));
    }

    // ── the launcher registry, read for a lane that needs a versioned Python ─
    //
    // `py -0p` is the one list on Windows that names every python.org install
    // with its path whether or not "Add to PATH" was ticked. Both launcher
    // formats appear in the wild, the default carries a star, and Program
    // Files puts a space in the path, so the parse must not split on spaces.

    #[test]
    fn the_launcher_listing_yields_every_path_including_ones_with_spaces() {
        let listing = " -V:3.13 *        C:\\Python313\\python.exe\n\
                        -V:3.11          C:\\Program Files\\Python311\\python.exe\n\
                        -V:3.10          C:\\Users\\d\\AppData\\Local\\Programs\\Python\\Python310\\python.exe\n\
                        -3.9-64 *        C:\\Python39\\python.exe\n\
                       Installed Pythons found by py Launcher for Windows\n";
        assert_eq!(
            launcher_list_paths(listing),
            vec![
                "C:\\Python313\\python.exe",
                "C:\\Program Files\\Python311\\python.exe",
                "C:\\Users\\d\\AppData\\Local\\Programs\\Python\\Python310\\python.exe",
                "C:\\Python39\\python.exe",
            ]
        );
        assert!(launcher_list_paths("").is_empty());
        assert!(launcher_list_paths("no launcher here\n").is_empty());
    }

    // Ticket 0004, 2026-09-06: his machine runs the new Python
    // install manager, whose `py -0p` prints the tag with a bitness suffix in
    // brackets. The path after the star is what matters, and it is read.
    #[test]
    fn the_install_manager_listing_with_its_bracketed_tag_is_read_too() {
        let listing = "-V:3.14[-64] *   C:\\Users\\alice\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe\n";
        assert_eq!(
            launcher_list_paths(listing),
            vec!["C:\\Users\\alice\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe"]
        );
        // and that Python is outside the trainer's range, so the winget step runs
        assert!(!crate::commands::trainer::trainer_supports_python("3.14.6"));
        assert!(crate::commands::trainer::choose_trainer_python(&[(
            "C:\\Users\\alice\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe".to_string(),
            "3.14.6".to_string(),
        )])
        .is_none());
    }
}
