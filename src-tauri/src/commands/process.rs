use crate::os_error;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};
use tracing::{error, info};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::state::AppState;

/// What every ComfyUI entry point answers on macOS. Local media there is Apple
/// MLX and nothing else, so the honest answer names the surface that does work
/// instead of failing with a bare error.
pub const MACOS_COMFY_REFUSAL: &str =
    "ComfyUI is not used on macOS. Local image and video run on Apple MLX — set it up in Settings → AI Backends → Local Media (Apple MLX).";

/// One definition of "may this machine run a local ComfyUI at all". Every entry
/// point asks this rather than testing the target itself, so the rule has a
/// single place to be read, tested, and changed.
pub fn comfy_supported_here() -> bool {
    !cfg!(target_os = "macos")
}

/// Windows: hide console windows for spawned processes
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Assign a child process to the app-wide Windows Job Object with
/// KILL_ON_JOB_CLOSE. When the Tauri parent process dies (even via Task
/// Manager, even via a hard kill from a build script), the OS kernel
/// automatically terminates every process in the job, with no Drop needed.
#[cfg(target_os = "windows")]
fn assign_to_kill_on_close_job(child: &std::process::Child) {
    assign_pid_to_kill_on_close_job(child.id());
}

/// The ONE kill-on-close job object of this process, created on first use.
///
/// It used to be one fresh job per child, with the handle leaked on purpose so
/// the job outlived the call. That is correct for a child spawned once, and a
/// slow leak for one spawned again and again: the built-in engine is restarted
/// on every model swap, and a session that switches models a few dozen times
/// (measured on the Windows box on 2026-08-29: 30 restarts in eleven minutes)
/// leaked a kernel job handle every single time. A process may belong to
/// several jobs on Windows 8 and later, so one shared job holds every child
/// just as well and leaks exactly one handle for the whole run.
#[cfg(target_os = "windows")]
fn kill_on_close_job() -> isize {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::*;

    // The raw HANDLE is a pointer and therefore not `Sync`; the numeric value
    // is, and it is what every call site needs.
    static JOB: OnceLock<isize> = OnceLock::new();
    *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        // Intentionally never closed. The handle must stay alive for the
        // lifetime of the app. When the app dies the OS closes it and
        // KILL_ON_JOB_CLOSE takes the children with it.
        job as isize
    })
}

/// PID-based variant of [`assign_to_kill_on_close_job`]. Usable from spawn paths
/// that don't own a `std::process::Child`, notably `tokio::process::Child`
/// (whose `id()` is `Option<u32>`) in the background-task runner (bg_tasks.rs).
/// Same KILL_ON_JOB_CLOSE semantics; a pid of 0 is ignored.
#[cfg(target_os = "windows")]
pub(crate) fn assign_pid_to_kill_on_close_job(pid: u32) {
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::Foundation::*;

    if pid == 0 { return; }
    let job = kill_on_close_job();
    if job == 0 { return; }
    unsafe {
        let handle = windows_sys::Win32::System::Threading::OpenProcess(
            windows_sys::Win32::System::Threading::PROCESS_SET_QUOTA
            | windows_sys::Win32::System::Threading::PROCESS_TERMINATE,
            0, // FALSE
            pid,
        );
        if !handle.is_null() {
            AssignProcessToJobObject(job as _, handle);
            CloseHandle(handle);
        }
    }
}

/// Tie a spawned child to the lifetime of the app: on Windows it joins the
/// kill-on-close job object, everywhere else this is a no-op (Unix children of
/// a dead parent are reparented, and the graceful shutdown path plus the
/// process-group kill in `process_util` cover what matters there).
///
/// Every long lived child goes through here: the bundled llama-server (chat
/// and embeddings), Ollama, the whisper server, the trainer, ComfyUI. Before
/// 2.6.7 only ComfyUI, Ollama-by-Drop and the background-task runner were
/// covered, so an app that died without running its shutdown path left a
/// llama-server behind holding the whole model in VRAM. Proved on the Windows
/// box on 2026-08-29: the app was terminated at 09:48:19, both ComfyUI
/// processes went with it, and lu-llama-server stayed up on 3633 MiB.
///
/// Cross platform on purpose (no `#[cfg]` at the call sites) so the call is
/// visible and testable on every platform, not only the one that needs it.
pub(crate) fn tie_child_to_app_lifetime(pid: u32) {
    #[cfg(target_os = "windows")]
    assign_pid_to_kill_on_close_job(pid);
    #[cfg(not(target_os = "windows"))]
    let _ = pid;
}

/// Show the main window (called from frontend after React renders)
#[tauri::command]
pub fn show_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
    }
}

/// Bug J: does this system need ComfyUI's --cpu fallback flag?
///
/// ComfyUI 0.21.x's `main.py` calls `get_torch_device()` which calls
/// `torch.cuda.current_device()` unconditionally during import. On systems
/// without an NVIDIA driver, that raises `RuntimeError: Found no NVIDIA
/// driver on your system` and main.py crashes before binding the port.
///
/// We pass `--cpu` to fall back to CPU inference when:
/// - Not on macOS (Mac PyTorch uses MPS, which doesn't touch cuda APIs), AND
/// - `nvidia-smi` is missing or exits non-zero (no NVIDIA card present).
///
/// AMD ROCm + Intel XPU setups CURRENTLY fall into this branch too, which
/// is conservative: they downgrade to CPU instead of crashing. A future
/// enhancement can probe `rocm-smi` / Intel devices and skip `--cpu` for
/// real hardware accel paths. For now the safe default is "no crash."
pub fn needs_cpu_fallback() -> bool {
    if cfg!(target_os = "macos") {
        return false;
    }
    !nvidia_present()
}

/// Is an NVIDIA driver present (nvidia-smi exits 0)?
fn nvidia_present() -> bool {
    // CREATE_NO_WINDOW: this probe runs on every ComfyUI start — without it an
    // NVIDIA Windows box flashes a console window each time. End users must
    // never see a terminal pop up.
    let mut cmd = Command::new("nvidia-smi");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// User override for the ComfyUI CPU/GPU decision (settings.comfyGpuMode).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ComfyGpuMode {
    /// Probe: NVIDIA fast-path, else the comfy python's torch GPU availability.
    Auto,
    /// Always pass `--cpu` (stable but slow — e.g. a card that OOMs on image gen).
    ForceCpu,
    /// Never pass `--cpu` (user vouches for a non-NVIDIA accel, e.g. DirectML).
    ForceGpu,
}

impl ComfyGpuMode {
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "cpu" => ComfyGpuMode::ForceCpu,
            "gpu" => ComfyGpuMode::ForceGpu,
            _ => ComfyGpuMode::Auto,
        }
    }
}

/// How long after a spawn a still-living child counts as proof of a start.
/// ComfyUI imports for 20 to 60 seconds before it binds the port, so we cannot
/// wait for the port here. We can wait for the crash: a bad dependency kills
/// main.py on the first import, well inside this window.
const COMFY_STARTUP_WATCH: std::time::Duration = std::time::Duration::from_millis(2_000);
const COMFY_STARTUP_STEP: std::time::Duration = std::time::Duration::from_millis(200);

/// After this long without the port opening, "starting" is a lie.
/// The slowest honest start measured on the 3060 box is about a minute; a
/// custom-node-heavy install can take longer, so this is deliberately generous.
const COMFY_STARTING_GRACE_SECS: u64 = 300;

/// What the panel should say about a child that is alive but has not bound the
/// port: `(starting, stalled)`.
///
/// Measured on the Windows box on 2026-08-14: `starting` was
/// `process_alive && !running` and nothing else, so a handle that never
/// resolved left the panel claiming a start that had been over for six
/// minutes. `starting` now expires, and the caller reports `stalled` so the UI
/// can offer the output instead of a spinner.
pub fn comfy_starting_state(
    process_alive: bool,
    running: bool,
    since_start: Option<std::time::Duration>,
) -> (bool, bool) {
    if running || !process_alive {
        return (false, false);
    }
    match since_start {
        // A handle we cannot date (kept from an earlier call, or a start we did
        // not make) gets the old reading rather than a stall we cannot prove.
        None => (true, false),
        Some(waited) if waited.as_secs() > COMFY_STARTING_GRACE_SECS => (false, true),
        Some(_) => (true, false),
    }
}

/// The message a start that is already over has to carry.
///
/// The traceback was never the missing part: `capture` has been putting every
/// line into `comfy_output` since GH #98. The missing part was anyone reading
/// it at the moment the start failed, which is why the box showed `Stopped`
/// with no reason while `main.py`'s ImportError sat in the ring buffer.
pub fn comfy_startup_failure(
    python: &str,
    code: Option<i32>,
    tail: &[String],
    has_own_python_env: bool,
) -> String {
    let mut msg = format!("ComfyUI exited right after starting (python={python}");
    if let Some(c) = code {
        msg.push_str(&format!(", exit code {c}"));
    }
    msg.push_str(").");
    if !has_own_python_env {
        msg.push_str(
            " This install has no python_embeded and no venv, so it ran on the system Python, \
             which usually does not have ComfyUI's dependencies. Settings, ComfyUI, Install \
             builds one.",
        );
    }
    let lines: Vec<&str> = tail
        .iter()
        .map(|l| l.trim_end())
        .filter(|l| !l.is_empty())
        .rev()
        .take(8)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if !lines.is_empty() {
        msg.push_str("\n\nLast output:\n");
        msg.push_str(&lines.join("\n"));
    }
    msg
}

/// Whether a startup crash reads as a broken Python environment (GH #98,
/// joelnewswanger 2026-08-14). His torch lived in the shared system Python
/// and died inside `infer_schema.py` on import, so the tail shows a traceback
/// running through site-packages with no ModuleNotFoundError anywhere;
/// kryptoxide's variant was a shadowing `comfy` package ("No module named
/// 'comfy.options'"). Both are exactly what a fresh venv fixes.
///
/// Excluded on purpose, because a rebuild cannot fix them and their own
/// messages are better: a port collision and a full disk.
pub fn comfy_env_failure(tail: &[String]) -> bool {
    let joined = tail.join("\n");
    if joined.contains("Address already in use")
        || joined.contains("only one usage of each socket address")
        || joined.contains("No space left on device")
        || joined.contains("not enough space on the disk")
    {
        return false;
    }
    joined.contains("ModuleNotFoundError")
        || joined.contains("No module named")
        || joined.contains("ImportError")
        || joined.contains("DLL load failed")
        || (joined.contains("Traceback (most recent call last)") && joined.contains("site-packages"))
}

/// Pure decision (all probes done by the caller): pass `--cpu` to ComfyUI?
///
/// - `baseline_needs_cpu`: `needs_cpu_fallback()` — false when NVIDIA present or macOS.
/// - `torch_gpu`: Some(true) = the comfy python's torch reports a usable GPU
///   (CUDA / ROCm / ZLUDA all answer via `torch.cuda.is_available()`),
///   Some(false) = no usable GPU, None = not probed / probe failed.
///
/// rhodium92 (AMD RX 6600 XT, 2026-07-01): before this, ANY non-NVIDIA box was
/// force-dropped to `--cpu`, so a ROCm/ZLUDA ComfyUI never used the AMD card.
pub fn decide_comfy_cpu_flag(
    mode: ComfyGpuMode,
    baseline_needs_cpu: bool,
    torch_gpu: Option<bool>,
) -> bool {
    match mode {
        ComfyGpuMode::ForceCpu => true,
        ComfyGpuMode::ForceGpu => false,
        ComfyGpuMode::Auto => {
            if !baseline_needs_cpu {
                // NVIDIA present (or macOS MPS) — the GPU is already fine.
                false
            } else {
                // No NVIDIA driver: a torch that reports a usable GPU (ROCm/ZLUDA)
                // means main.py won't crash on torch.cuda → run on the GPU.
                match torch_gpu {
                    Some(true) => false,
                    _ => true, // Some(false) = no GPU, None = probe failed → conservative --cpu
                }
            }
        }
    }
}

/// Force GPU is a promise LU keeps, not a claim LU checks: the flag drops
/// `--cpu` and ComfyUI then asks torch for a device. On a venv holding
/// CUDA-only wheels and an AMD card that ends in
/// "Torch not compiled with CUDA enabled" and nothing else, which is what
/// numbrain, lapbo, petermanmancusso and sancora all saw. The flag still
/// wins, the user asked for it, but the reason is in the output panel before
/// the traceback is.
///
/// `torch_gpu`: Some(false) = the venv's torch reports no usable GPU,
/// Some(true) = it does, None = the probe did not answer and we say nothing
/// rather than guess.
pub(crate) fn force_gpu_warning(
    mode: ComfyGpuMode,
    torch_gpu: Option<bool>,
    has_amd: bool,
    os: &str,
) -> Option<String> {
    if mode != ComfyGpuMode::ForceGpu || torch_gpu != Some(false) {
        return None;
    }
    let head = "ComfyUI GPU is set to Force GPU, but the PyTorch in this ComfyUI                 environment reports no usable GPU. ComfyUI will stop with                 \"Torch not compiled with CUDA enabled\" instead of rendering.";
    let fix = match (has_amd, os) {
        (true, "linux") => {
            "Your card is AMD and this environment holds CUDA-only wheels. Reinstall the              ComfyUI environment from Settings > ComfyUI: LU now installs the ROCm build              of PyTorch when it sees an AMD card."
        }
        (true, "windows") => {
            // Since Runde 12 LU does install AMD's own Windows ROCm wheels for
            // the RDNA 3, 3.5 and 4 cards AMD supports, so the old absolute
            // "PyTorch ships no ROCm wheels for Windows" is no longer true.
            // What IS true whenever this branch fires is that the environment
            // ended up with processor wheels anyway, either because the card is
            // outside that list or because the index did not answer. Still no
            // reinstall advice: on the cards that reach this message a rebuild
            // lands in the same place.
            "Your card is AMD, and this ComfyUI environment holds processor wheels:              pytorch.org publishes no Windows ROCm wheels, and AMD's own Windows ROCm              index either does not cover this card or did not answer when the              environment was built. Use a ComfyUI of your own on ZLUDA or DirectML, or              set ComfyUI GPU back to Auto and render on the processor."
        }
        _ => {
            "Reinstall the ComfyUI environment from Settings > ComfyUI so PyTorch is              rebuilt for the card LU detects, or set ComfyUI GPU back to Auto."
        }
    };
    Some(format!("[LU] {head} {fix}"))
}

/// Skip these directories during ComfyUI search
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "__pycache__", "venv", ".venv", "site-packages",
    "Windows", "Program Files", "Program Files (x86)", "$Recycle.Bin", "AppData",
];

fn scan_for_comfyui(dir: &Path, depth: u32) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return None,
    };
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue, // Skip entries with permission errors
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') || SKIP_DIRS.contains(&name_str.as_ref()) {
            continue;
        }
        let full = entry.path();
        // Check if this directory IS ComfyUI
        if name_str.eq_ignore_ascii_case("comfyui") && full.join("main.py").exists() {
            return Some(full);
        }
        // Recurse deeper
        if let Some(found) = scan_for_comfyui(&full, depth - 1) {
            return Some(found);
        }
    }
    None
}

/// Heuristic: does this ComfyUI directory look like a *complete* install,
/// i.e. one that will actually start when we run `python main.py`?
///
/// "Complete" here means: torch is reachable. Three environments qualify,
/// and the order below is the order LU itself creates them in:
///
/// 1. ComfyUI's OWN venv — `ComfyUI/venv` (what LU's PEP 668 installer and
///    `repair_comfyui_env` build) or `ComfyUI/.venv` (uv, modern
///    `python -m venv .venv`). This is where torch lives for every install
///    LU has made since Bug E, and for every install that has ever been
///    through a repair.
/// 2. Portable variants ship a `python_embeded/` directory with the
///    matching torch wheel pre-baked.
/// 3. From-source installs that predate the venv path depend on the system
///    Python having torch, so the system interpreters' prefixes are read.
///
/// All three are directory probes, never `python -c "import torch"`: the
/// scan runs over every candidate directory on the box and importing torch
/// costs seconds each.
///
/// OI-1 (2.6.7 audit): case 1 did not exist and case 3 could not fire on
/// Unix, so on Linux the answer was `false` for every from-source install and
/// for every install on any platform that had been repaired. The user was
/// told a working ComfyUI was broken, permanently — the onboarding step was
/// passable only via "Skip for now" and Settings offered only "Re-install"
/// (another 2 GB of PyTorch). See `python_prefix_has_torch` for the exact
/// mechanism that made the Unix branch dead code.
///
/// Returning `false` for a `main.py`-only carcass is still the point of
/// P14: a half-cloned ComfyUI dir from a previous abort (Python missing,
/// pip 403, network drop) used to be detected as "installed", which left
/// the user staring at "ComfyUI not responding" forever. Reporting it as
/// incomplete instead lets the install flow retry cleanly.
fn is_comfyui_install_complete(comfy_path: &Path) -> bool {
    is_comfyui_install_complete_with(comfy_path, &collect_candidate_pythons())
}

/// Testable core of [`is_comfyui_install_complete`]. The interpreter list is
/// injected because the probe's platform branches cannot otherwise be checked:
/// the box running the tests has exactly one of the two prefix layouts, and
/// the layout that broke (Unix) is not the one CI happens to be on. With the
/// list injected, both layouts are exercised from fixture directories.
fn is_comfyui_install_complete_with(comfy_path: &Path, candidate_pythons: &[String]) -> bool {
    if !comfy_path.join("main.py").exists() {
        return false;
    }

    // 1. ComfyUI's own venv — the environment LU builds itself.
    for venv_name in ["venv", ".venv"] {
        if prefix_has_torch(&comfy_path.join(venv_name)) {
            return true;
        }
    }

    // 2. Portable layouts (next-to or inside the ComfyUI dir).
    let portable_candidates = [
        comfy_path.parent().map(|p| p.join("python_embeded")),
        Some(comfy_path.join("python_embeded")),
    ];
    for c in portable_candidates.into_iter().flatten() {
        if prefix_has_torch(&c) {
            return true;
        }
    }

    // 3. System Python — derive each interpreter's prefix and look for torch
    // in the standard sysconfig locations. Catches the pre-venv from-source
    // case where pip dropped torch into the system Python's site-packages.
    candidate_pythons
        .iter()
        .any(|py| python_prefix_has_torch(Path::new(py)))
}

/// Does the environment rooted at `prefix` hold a `torch` package?
///
/// `prefix` is a Python *prefix*: a venv root, a `python_embeded` dir, or the
/// `sys.prefix` of a system install. Both layouts are probed because LU has
/// to answer for boxes it is not running on:
///
/// * Windows: `<prefix>/Lib/site-packages/torch`
/// * Unix:    `<prefix>/lib/python3.X/site-packages/torch` (and `lib64`),
///   with the minor version unknown, so the version dirs are enumerated.
///
/// An empty prefix is refused up front. That is not defensive noise: it is
/// exactly the OI-1 bug. `Path::new("python3").parent()` is `Some("")`, and
/// joining onto `""` yields a RELATIVE path — `Lib/site-packages/torch` —
/// which `exists()` resolves against LU's working directory. So the Windows
/// probe silently asked about a path on the user's desktop, and the Unix
/// probe below it was never reached at all, because `Path::new("").parent()`
/// is `None`.
fn prefix_has_torch(prefix: &Path) -> bool {
    if prefix.as_os_str().is_empty() {
        return false;
    }
    if prefix.join("Lib").join("site-packages").join("torch").exists() {
        return true;
    }
    // A venv's own `pyvenv.cfg`-less sibling layout: some tools drop
    // site-packages directly under the prefix.
    if prefix.join("site-packages").join("torch").exists() {
        return true;
    }
    for lib_name in ["lib", "lib64"] {
        let lib = prefix.join(lib_name);
        if lib.join("site-packages").join("torch").exists() {
            return true;
        }
        // <prefix>/lib/python3.X/site-packages/torch — the minor version is
        // whatever built the env, so enumerate rather than guess.
        if let Ok(entries) = std::fs::read_dir(&lib) {
            for e in entries.flatten() {
                if e.path().join("site-packages").join("torch").exists() {
                    return true;
                }
            }
        }
    }
    false
}

/// Does the interpreter at `interpreter` have torch on its prefix?
///
/// The interpreter sits one or two levels below its prefix depending on the
/// platform — `<prefix>/python.exe` on Windows, `<prefix>/bin/python3` on
/// Unix — so both the containing directory and its parent are tried. A
/// relative interpreter name (no directory component at all) yields no
/// prefix and is refused rather than silently probed against the cwd.
fn python_prefix_has_torch(interpreter: &Path) -> bool {
    let Some(bin_dir) = interpreter.parent() else {
        return false;
    };
    if bin_dir.as_os_str().is_empty() {
        return false;
    }
    if prefix_has_torch(bin_dir) {
        return true;
    }
    match bin_dir.parent() {
        Some(p) if !p.as_os_str().is_empty() => prefix_has_torch(p),
        _ => false,
    }
}

/// Collect the system Python paths we might want to probe. Mirrors the
/// search order in `python::get_python_bin` but returns *all* hits, not
/// just the first — so the carcass check works even when the user has
/// torch installed in a non-default Python.
///
/// Every entry is an ABSOLUTE interpreter path. That is a hard requirement of
/// the callers, not a nicety: they read the interpreter's prefix off the path,
/// and a bare name has none (OI-1). The old Unix branch pushed the literal
/// strings `"python3"` and `"python"`.
fn collect_candidate_pythons() -> Vec<String> {
    // Same two-block shape as `os_paths::find_python`: exactly one is
    // compiled, and it is the function's tail.
    #[cfg(not(target_os = "windows"))]
    {
        // Same ordered candidate list the installer resolves through
        // (BUG-008: a bare `python3` can be a 3.14 with no ML wheels), so the
        // probe and the install path cannot disagree about which interpreter
        // "the system Python" is. `which` turns each name into a real path.
        let mut out: Vec<String> = Vec::new();
        for name in crate::os_paths::unix_python_candidates() {
            if let Ok(p) = which::which(name) {
                let s = p.to_string_lossy().to_string();
                if !out.contains(&s) {
                    out.push(s);
                }
            }
        }
        out
    }

    #[cfg(target_os = "windows")]
    {
    let mut out: Vec<String> = Vec::new();
    // `where python` candidates (excluding WindowsApps stub).
    let mut where_cmd = Command::new("where");
    where_cmd.arg("python");
    #[cfg(target_os = "windows")]
    where_cmd.creation_flags(CREATE_NO_WINDOW);
    if let Ok(output) = where_cmd.output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let path = line.trim();
                if !path.is_empty() && !path.contains("WindowsApps") {
                    out.push(path.to_string());
                }
            }
        }
    }

    for p in [
        "C:\\Python313\\python.exe",
        "C:\\Python312\\python.exe",
        "C:\\Python311\\python.exe",
        "C:\\Python310\\python.exe",
        "C:\\Python39\\python.exe",
    ] {
        if Path::new(p).exists() {
            out.push(p.to_string());
        }
    }

    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        let programs = Path::new(&localappdata).join("Programs").join("Python");
        if let Ok(entries) = std::fs::read_dir(&programs) {
            for e in entries.flatten() {
                let py = e.path().join("python.exe");
                if py.exists() {
                    out.push(py.to_string_lossy().to_string());
                }
            }
        }
    }

    out
    }
}

/// Probe order for the ComfyUI Desktop App's Working Directory when the
/// user-supplied path is the binary install dir (contains `ComfyUI.exe` but
/// no `main.py`). Comfy-Org/desktop lets the user pick this dir at install
/// time and defaults to `~\Documents\ComfyUI`. We additionally try the
/// `%APPDATA%\ComfyUI\config.json` `basePath` hint which the desktop app
/// writes after the picker, and the legacy `electron-userdata` location.
fn desktop_app_working_dir_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let home = dirs::home_dir().unwrap_or_default();
    out.push(home.join("Documents").join("ComfyUI"));
    out.push(home.join("Documents").join("ComfyUI").join("ComfyUI"));
    if cfg!(target_os = "windows") {
        if let Ok(appdata) = std::env::var("APPDATA") {
            // 1. config.json basePath hint, if present
            let cfg = PathBuf::from(&appdata).join("ComfyUI").join("config.json");
            if let Ok(raw) = std::fs::read_to_string(&cfg) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(p) = v.get("basePath").and_then(|x| x.as_str()) {
                        out.push(PathBuf::from(p));
                    }
                }
            }
            // 2. %APPDATA%\ComfyUI itself (some installer variants)
            out.push(PathBuf::from(&appdata).join("ComfyUI"));
        }
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            out.push(PathBuf::from(&localappdata).join("ComfyUI"));
            // The desktop installer also bundles a ComfyUI tree under the
            // app's resources for first-launch seeding.
            out.push(PathBuf::from(&localappdata).join("Programs").join("ComfyUI").join("resources").join("ComfyUI"));
        }
    }
    out
}

/// Best-effort: turn whatever the user/auto-detector handed us into a
/// directory that contains `main.py`. Accepts either:
///   - A directory with `main.py` (classic / portable / from-source install)
///   - A directory with `ComfyUI.exe` (Comfy-Org desktop app binary dir) —
///     we then look up the Working Directory via the probe order above.
fn resolve_comfyui_path(input: &str) -> Option<String> {
    let p = Path::new(input);
    if p.join("main.py").exists() {
        return Some(input.to_string());
    }
    if p.join("ComfyUI.exe").exists() {
        for candidate in desktop_app_working_dir_candidates() {
            if candidate.join("main.py").exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

pub fn find_comfyui_path() -> Option<String> {
    // 1. Check environment variable
    if let Ok(env_path) = std::env::var("COMFYUI_PATH") {
        if let Some(p) = resolve_comfyui_path(&env_path) {
            return Some(p);
        }
    }

    // 2. Read from app config
    {
        let config_file = crate::os_paths::app_config_json();
        if config_file.exists() {
            if let Ok(content) = fs::read_to_string(&config_file) {
                if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(path) = config.get("comfyui_path").and_then(|v| v.as_str()) {
                        if let Some(resolved) = resolve_comfyui_path(path) {
                            return Some(resolved);
                        }
                    }
                }
            }
        }
    }

    let home = dirs::home_dir().unwrap_or_default();

    // 3. Check common fixed locations (including Stability Matrix, portable installs)
    let mut fixed: Vec<PathBuf> = vec![
        home.join("ComfyUI"),
        home.join("Desktop").join("ComfyUI"),
        home.join("Documents").join("ComfyUI"),
        PathBuf::from("C:\\ComfyUI"),
        PathBuf::from("D:\\ComfyUI"),
    ];

    if cfg!(target_os = "windows") {
        // Stability Matrix stores ComfyUI in AppData
        if let Ok(appdata) = std::env::var("APPDATA") {
            fixed.push(PathBuf::from(&appdata).join("StabilityMatrix").join("Packages").join("ComfyUI"));
            // Comfy-Org/desktop app working dir (GH #47, levoy1 2026-05-24)
            fixed.push(PathBuf::from(&appdata).join("ComfyUI"));
        }
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            fixed.push(PathBuf::from(&localappdata).join("StabilityMatrix").join("Packages").join("ComfyUI"));
            fixed.push(PathBuf::from(&localappdata).join("ComfyUI"));
        }
        // Common Program Files locations
        fixed.push(PathBuf::from("C:\\Program Files\\ComfyUI"));
        fixed.push(PathBuf::from("C:\\AI\\ComfyUI"));
        fixed.push(PathBuf::from("D:\\AI\\ComfyUI"));
    }

    for p in &fixed {
        if p.join("main.py").exists() {
            return Some(p.to_string_lossy().to_string());
        }
    }

    // 3b. Deep scan of the user home (finds ComfyUI in non-standard paths like
    // Desktop/bs/IMage Gen/ComfyUI). Runs AFTER config + fixed locations: as a
    // FIRST candidate its directory-walk order could pick a stale second copy
    // over the standard install — LU then downloads/checks models in a folder
    // the running ComfyUI never scans ("installed but not recognized",
    // pnwpdr4519 Discord 2026-07-27). Same lesson as d9146e3 ("deep home scan
    // last").
    if let Some(found) = scan_for_comfyui(&home, 7) {
        println!("[ComfyUI] Found via deep home scan: {}", found.display());
        return Some(found.to_string_lossy().to_string());
    }

    // 4. Recursive scan of Desktop, Documents, Downloads, and drive roots
    let mut scan_roots: Vec<PathBuf> = vec![
        home.join("Desktop"),
        home.join("Documents"),
        home.join("Downloads"),
    ];
    if cfg!(target_os = "windows") {
        scan_roots.push(PathBuf::from("C:\\"));
        scan_roots.push(PathBuf::from("D:\\"));
        scan_roots.push(PathBuf::from("E:\\"));
    } else {
        scan_roots.push(PathBuf::from("/opt"));
        scan_roots.push(PathBuf::from("/usr/local"));
    }

    for root in &scan_roots {
        if root.exists() {
            if let Some(found) = scan_for_comfyui(root, 5) {
                return Some(found.to_string_lossy().to_string());
            }
        }
    }

    None
}

/// Information about a discovered ComfyUI install — surfaced to the
/// frontend so the user picks the right one when multiple coexist.
///
/// Background (Bug #3 — ninjastic2008 v2.4.3): a user with both a manual
/// `C:\Users\admin\ComfyUI` install (complete, with its own python_embeded)
/// AND an empty `C:\ComfyUI-ai` directory hit `find_comfyui_path()` which
/// returned only the first hit (their manual install). LU then tried to
/// drive that install using the system Python — incompatible with the
/// dir's bundled python_embeded — and ComfyUI loaded indefinitely. The
/// "complete + has_embedded_python" fields let the onboarding UI explain
/// which path to pick and why.
#[derive(serde::Serialize, Clone, Debug)]
pub struct ComfyUIInstall {
    pub path: String,
    /// True when this directory looks ready to start without any further
    /// pip steps (main.py + torch reachable). Same heuristic as
    /// `is_comfyui_install_complete`.
    pub complete: bool,
    /// True when the directory ships its own `python_embeded\python.exe`.
    /// Portable ComfyUI builds (and Stability Matrix packages) ship one;
    /// from-source clones don't. We start ComfyUI with this Python when
    /// present — using the system Python on a portable install was the
    /// exact failure mode ninjastic2008 hit.
    pub has_embedded_python: bool,
    /// Where we found this install. Helps the user disambiguate.
    pub source: String,
}

fn classify_comfy_install(path: &Path, source: &str) -> ComfyUIInstall {
    let has_embed = path.join("python_embeded").join("python.exe").exists()
        || path
            .parent()
            .map(|p| p.join("python_embeded").join("python.exe").exists())
            .unwrap_or(false);
    ComfyUIInstall {
        path: path.to_string_lossy().to_string(),
        complete: is_comfyui_install_complete(path),
        has_embedded_python: has_embed,
        source: source.to_string(),
    }
}

/// Enumerate every plausible ComfyUI install on the box. Used by the
/// onboarding UI to decide between auto-pick (one hit) and an explicit
/// picker (multiple hits).
///
/// Performance contract: this MUST finish in under ~3 s even on machines
/// with deep file trees. The implementation is `async` so it runs on
/// tokio's blocking-thread pool instead of the IPC main thread — without
/// that the Tauri WebView lock-up on a 200k-file home dir made the whole
/// app report "Not responding" during the ComfyUI step. (Bug #3 sweep,
/// found during E2E 2026-05-11.)
///
/// Scan tiers, in order:
///   1. Explicit pointers — env var, config.json
///   2. Well-known fixed locations (home/Desktop/Documents/StabilityMatrix/…)
///   3. Bounded deep scan of the user's data dirs (depth 4, skip noise)
///   We DO NOT walk C:\, D:\, E:\ from their roots anymore — that path was
///   the locker. find_comfyui_path keeps its drive-root fallback for the
///   single-hit auto-pick case which can afford a slow first-match exit.
#[tauri::command]
pub async fn detect_all_comfyui_installs() -> Vec<ComfyUIInstall> {
    tokio::task::spawn_blocking(detect_all_comfyui_installs_sync)
        .await
        .unwrap_or_default()
}

const MAX_MULTI_DETECT_HITS: usize = 16;
const MULTI_DETECT_DEPTH: i32 = 4;

fn detect_all_comfyui_installs_sync() -> Vec<ComfyUIInstall> {
    let mut out: Vec<ComfyUIInstall> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let push_if_new = |path: PathBuf, source: &str, out: &mut Vec<ComfyUIInstall>, seen: &mut std::collections::HashSet<String>| -> bool {
        if !path.join("main.py").exists() {
            return false;
        }
        // Canonicalise to dedupe symlinks / case-different paths on Windows
        let key = std::fs::canonicalize(&path)
            .map(|c| c.to_string_lossy().to_string())
            .unwrap_or_else(|_| path.to_string_lossy().to_string())
            .to_lowercase();
        if seen.insert(key) {
            out.push(classify_comfy_install(&path, source));
            return true;
        }
        false
    };

    // 1. COMFYUI_PATH env var
    if let Ok(env_path) = std::env::var("COMFYUI_PATH") {
        push_if_new(PathBuf::from(&env_path), "COMFYUI_PATH env var", &mut out, &mut seen);
    }

    // 2. app config.json
    {
        let config_file = crate::os_paths::app_config_json();
        if let Ok(content) = fs::read_to_string(&config_file) {
            if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(path) = config.get("comfyui_path").and_then(|v| v.as_str()) {
                    push_if_new(PathBuf::from(path), "config.json", &mut out, &mut seen);
                }
            }
        }
    }

    let home = dirs::home_dir().unwrap_or_default();

    // 3. Well-known fixed locations
    let mut fixed: Vec<(PathBuf, &str)> = vec![
        (home.join("ComfyUI"), "home"),
        (home.join("Desktop").join("ComfyUI"), "Desktop"),
        (home.join("Documents").join("ComfyUI"), "Documents"),
        (PathBuf::from("C:\\ComfyUI"), "C:\\"),
        (PathBuf::from("D:\\ComfyUI"), "D:\\"),
    ];
    if cfg!(target_os = "windows") {
        if let Ok(appdata) = std::env::var("APPDATA") {
            fixed.push((PathBuf::from(&appdata).join("StabilityMatrix").join("Packages").join("ComfyUI"), "StabilityMatrix"));
            // Comfy-Org/desktop default Working Directory hint (GH #47).
            fixed.push((PathBuf::from(&appdata).join("ComfyUI"), "Desktop App data"));
        }
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            fixed.push((PathBuf::from(&localappdata).join("StabilityMatrix").join("Packages").join("ComfyUI"), "StabilityMatrix"));
            fixed.push((PathBuf::from(&localappdata).join("ComfyUI"), "Desktop App data"));
        }
        fixed.push((PathBuf::from("C:\\Program Files\\ComfyUI"), "Program Files"));
        fixed.push((PathBuf::from("C:\\AI\\ComfyUI"), "C:\\AI"));
        fixed.push((PathBuf::from("D:\\AI\\ComfyUI"), "D:\\AI"));
        // ComfyUI Desktop App often pairs its `%LOCALAPPDATA%\Programs\ComfyUI`
        // binary with a `%APPDATA%\ComfyUI\config.json` whose `basePath` field
        // points at the Working Directory. Honour the hint so users with a
        // non-default Working Dir (e.g. on D:\ for space) are still found.
        if let Ok(appdata) = std::env::var("APPDATA") {
            let cfg = PathBuf::from(&appdata).join("ComfyUI").join("config.json");
            if let Ok(raw) = std::fs::read_to_string(&cfg) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(base) = v.get("basePath").and_then(|x| x.as_str()) {
                        fixed.push((PathBuf::from(base), "Desktop App basePath"));
                    }
                }
            }
        }
    }
    for (p, source) in fixed {
        push_if_new(p, source, &mut out, &mut seen);
    }

    // 4. Bounded deep scan — user data dirs only. Drive roots (C:\, D:\, E:\)
    //    are intentionally NOT walked here: the deep walk through hundreds of
    //    thousands of system files made `detect_all_comfyui_installs` lock
    //    Tauri for 30+ s on real Windows boxes. Power users with ComfyUI in
    //    `D:\AI\projects\custom\dir\` still get auto-picked by find_comfyui_path
    //    (single-hit, slow first-match-exit) — they just don't surface in the
    //    Multi-ComfyUI picker, which is acceptable: that picker exists for
    //    accidental multi-install collisions, not exhaustive enumeration.
    let scan_roots: Vec<(PathBuf, &str)> = vec![
        (home.clone(), "home (deep scan)"),
        (home.join("Desktop"), "Desktop"),
        (home.join("Documents"), "Documents"),
        (home.join("Downloads"), "Downloads"),
    ];
    for (root, source) in &scan_roots {
        if out.len() >= MAX_MULTI_DETECT_HITS {
            break;
        }
        if root.exists() {
            walk_for_comfyui(root, MULTI_DETECT_DEPTH, &mut |p| {
                if out.len() >= MAX_MULTI_DETECT_HITS {
                    return;
                }
                push_if_new(p, source, &mut out, &mut seen);
            });
        }
    }

    out
}

fn walk_for_comfyui<F: FnMut(PathBuf)>(dir: &Path, depth: i32, cb: &mut F) {
    if depth < 0 {
        return;
    }
    if dir.join("main.py").exists() && dir.join("comfy").exists() {
        cb(dir.to_path_buf());
        // Don't recurse into a confirmed install — its subdirs aren't
        // independent installs.
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        // Skip the obvious noise dirs that blow up walk time. node_modules
        // and .git are common in dev projects; the rest are system locations
        // that should never own a ComfyUI install anyway.
        if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
            if matches!(name,
                "node_modules" | ".git" | "AppData" | "$Recycle.Bin"
                | "Windows" | "System32" | "ProgramData" | ".cache"
                | "target" | ".cargo" | ".rustup" | ".npm" | ".pnpm"
                | "Library"     // macOS, harmless on Windows
                | "OneDrive"    // huge synced trees; ComfyUI shouldn't live there
            ) {
                continue;
            }
            // Hidden dirs (Linux/macOS dotfiles) are almost never ComfyUI roots.
            if name.starts_with('.') && name.len() > 1 {
                continue;
            }
        }
        walk_for_comfyui(&p, depth - 1, cb);
    }
}

fn is_comfyui_running_on_port(port: u16) -> bool {
    reqwest::blocking::get(format!("http://localhost:{}/system_stats", port))
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Kill whatever process listens on `port` (David 2026-07-17, "Let me do it
/// for you" CORS-fix button). Only ever called with the user-configured
/// ComfyUI port, on an explicit button press — LU is about to relaunch that
/// ComfyUI under its own management with the CORS flag. Best effort: a port
/// nobody listens on is a no-op.
fn kill_port_owner(port: u16) {
    let own_pid = std::process::id();
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("netstat");
        cmd.args(["-ano", "-p", "tcp"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let Ok(out) = cmd.output() else { return };
        let text = String::from_utf8_lossy(&out.stdout);
        let needle = format!(":{}", port);
        let mut pids: Vec<u32> = Vec::new();
        for line in text.lines() {
            // Match on the LOCAL address column only; the state column is
            // locale-dependent ("LISTENING" / "ABHÖREN"), so don't parse it.
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() >= 5 && cols[0].eq_ignore_ascii_case("tcp") && cols[1].ends_with(&needle) {
                if let Ok(pid) = cols[cols.len() - 1].parse::<u32>() {
                    if pid != 0 && pid != own_pid && !pids.contains(&pid) {
                        pids.push(pid);
                    }
                }
            }
        }
        for pid in pids {
            println!("[ComfyUI] CORS fix: killing port {} owner pid {}", port, pid);
            let mut kill = Command::new("taskkill");
            kill.args(["/pid", &pid.to_string(), "/T", "/F"]);
            kill.creation_flags(CREATE_NO_WINDOW);
            let _ = kill.output();
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(out) = Command::new("lsof").args(["-ti", &format!("tcp:{}", port), "-sTCP:LISTEN"]).output() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if let Ok(pid) = line.trim().parse::<u32>() {
                    if pid != 0 && pid != own_pid {
                        let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
                    }
                }
            }
        }
    }
}

/// One-click fix for the ComfyUI 0.19+ cross-origin block banner (#75/#82
/// follow-up, David 2026-07-17): stop the user-managed ComfyUI on the
/// configured port and relaunch it under LU's management — LU-started
/// ComfyUI always carries `--enable-cors-header`, so direct media loads and
/// the native progress feed work again. Requires a known install path; on a
/// remote host LU can't manage the process at all.
// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread.
// The State borrow cannot cross into the blocking pool, so the handle is
// re-resolved there from the AppHandle (same pattern as engine.rs/whisper.rs).
#[tauri::command]
pub async fn fix_comfyui_cors(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        fix_comfyui_cors_blocking(&state)
    })
    .await
    .map_err(|e| format!("fix_comfyui_cors task: {e}"))?
}

fn fix_comfyui_cors_blocking(state: &AppState) -> Result<serde_json::Value, String> {
    let host = state.comfy_host.lock().unwrap().clone();
    if !is_local_host(&host) {
        return Err(
            "ComfyUI runs on a remote host, so LU can't restart it from here. Add --enable-cors-header http://tauri.localhost to the launch command on that machine instead.".to_string(),
        );
    }
    let path_known = state
        .comfy_path
        .lock()
        .unwrap()
        .clone()
        .or_else(find_comfyui_path)
        .is_some();
    if !path_known {
        return Err(
            "LU doesn't know this ComfyUI's folder yet. Set it under Settings → AI Backends → ComfyUI → Path, then press the button again. Or add --enable-cors-header http://tauri.localhost to your own launch script.".to_string(),
        );
    }
    let port = *state.comfy_port.lock().unwrap();

    // Stop our own child cleanly first (if any), then whatever else owns the port.
    {
        let mut proc = state.comfy_process.lock().unwrap();
        if let Some(ref mut child) = *proc {
            let pid = child.id();
            #[cfg(target_os = "windows")]
            {
                let mut cmd = Command::new("taskkill");
                cmd.args(["/pid", &pid.to_string(), "/T", "/F"]);
                cmd.creation_flags(CREATE_NO_WINDOW);
                let _ = cmd.output();
            }
            #[cfg(not(target_os = "windows"))]
            let _ = child.kill();
            info!(pid = pid, "cors fix: stopped LU-managed comfyui");
            *proc = None;
        }
    }
    kill_port_owner(port);

    // Wait for the port to actually free up — start_comfyui short-circuits
    // with "already_running" while the old process is still winding down.
    for _ in 0..20 {
        if !is_comfyui_running_on_port(port) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(400));
    }

    start_comfyui_blocking(state)
}

// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread.
// The State borrow cannot cross into the blocking pool, so the handle is
// re-resolved there from the AppHandle (same pattern as engine.rs/whisper.rs).
#[tauri::command]
pub async fn start_ollama(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        start_ollama_blocking(&state)
    })
    .await
    .map_err(|e| format!("start_ollama task: {e}"))?
}

/// Serialise a "check that nothing runs, then spawn it" path.
///
/// These used to be serialised BY ACCIDENT: a synchronous `#[tauri::command]`
/// runs on the Tauri main thread, so two invocations could never overlap. Now
/// that the bodies run on the blocking pool, two triggers close together (a
/// mount effect alongside a click, a double click, onboarding's retry loop) can
/// BOTH pass the "nothing is running" check — the window between that check and
/// storing the child is long, it contains a filesystem search — and both spawn a
/// server. Only the second child gets stored, so the first is an orphan holding
/// VRAM that no stop_* will ever kill. That orphan is exactly the zombie
/// `start_comfyui` warns about a few lines below.
///
/// The second caller waits instead of being turned away, so once it proceeds the
/// normal "already running" check answers it — no new status value, no change
/// for the frontend.
pub(crate) fn start_gate(lock: &'static Mutex<()>) -> std::sync::MutexGuard<'static, ()> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) static COMFY_START: Mutex<()> = Mutex::new(());
pub(crate) static OLLAMA_START: Mutex<()> = Mutex::new(());
pub(crate) static ENGINE_START: Mutex<()> = Mutex::new(());
pub(crate) static EMBED_START: Mutex<()> = Mutex::new(());

/// Is an Ollama server already listening?
///
/// This used to shell out to `tasklist /FI "IMAGENAME eq ollama.exe"` — a
/// WINDOWS-only command, run unconditionally on every platform. Observed live
/// on macOS 2026-07-28: the spawn fails, `if let Ok(output)` is false, the
/// check is skipped entirely, and the app starts a SECOND `ollama serve` that
/// cannot bind 11434 and dies within milliseconds. The dead child is then
/// stored in AppState as the tracked server, and the log claims "Started".
///
/// The port is what actually matters — an Ollama started by launchd, a service
/// or Docker counts just as much as one whose process happens to be named
/// ollama.exe — so probe that instead. Same shape as lmstudio_port_open.
fn ollama_port_open() -> bool {
    use std::net::{SocketAddr, TcpStream};
    let addr: SocketAddr = ([127, 0, 0, 1], 11434).into();
    TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)).is_ok()
}

fn start_ollama_blocking(state: &AppState) -> Result<serde_json::Value, String> {
    let _gate = start_gate(&OLLAMA_START);
    if ollama_port_open() {
        println!("[Ollama] Already running");
        return Ok(serde_json::json!({"status": "already_running"}));
    }

    println!("[Ollama] Starting...");
    let mut cmd = Command::new("ollama");
    cmd.arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Bug BB v2.5.0 — BobbyT. Forward the user's GPU pick as
    // CUDA_VISIBLE_DEVICES / HIP_VISIBLE_DEVICES / ONEAPI_DEVICE_SELECTOR
    // so Ollama uses the pinned card on multi-vendor / multi-GPU machines.
    // No-op when the pick is "auto" (default).
    if let Ok(sel) = state.gpu_selection.lock() {
        crate::commands::gpu::apply_gpu_env(&mut cmd, &sel);
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let result = cmd.spawn();

    match result {
        Ok(child) => {
            // Store the Child so AppState::Drop kills our spawned ollama on
            // shutdown (kj103x — Discord 2026-05-23 #help-chat 1507756765612216411).
            // Note: tasklist check above means we only get here if WE start it,
            // so we never kill a user-managed ollama serve.
            //
            // The Drop only covers a shutdown that runs. A hard kill of the app
            // does not run one, so the child also joins the kill-on-close job.
            tie_child_to_app_lifetime(child.id());
            *state.ollama_process.lock().unwrap() = Some(child);
            println!("[Ollama] Started");
            info!("ollama spawned");
            Ok(serde_json::json!({"status": "started"}))
        }
        Err(e) => {
            println!("[Ollama] Failed to start: {}", e);
            error!(error = %e, "ollama spawn failed");
            Ok(serde_json::json!({"status": "error", "error": os_error::english(&e)}))
        }
    }
}

/// Does `python` have a working flash-attn? Real import test (not pip-list):
/// a half-installed or ABI-mismatched wheel fails the import, and we must
/// never pass `--use-flash-attention` then — ComfyUI would error at startup.
///
/// Three-state result: Some(true) = import OK, Some(false) = the process
/// DEFINITIVELY failed (ImportError etc.), None = timeout / couldn't spawn.
/// The distinction matters for caching: importing flash_attn loads torch,
/// which is ~4 s warm but can blow well past 25 s during an app-boot disk
/// storm (live miss 2026-06-11: flag silently absent for the whole session
/// because a cold-start timeout was cached as "not installed").
pub(crate) fn probe_flash_attention(python: &str) -> Option<bool> {
    if python.is_empty() {
        return Some(false);
    }
    let mut cmd = Command::new(python);
    cmd.args(["-c", "from flash_attn import flash_attn_func"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return None,
    };
    // 90 s ceiling: an ABSENT package fails fast (ModuleNotFoundError in
    // seconds), so the long window only ever delays a start where flash-attn
    // exists but the disk is busy — exactly the case worth waiting for.
    for _ in 0..450 {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.success()),
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(200)),
            Err(_) => return None,
        }
    }
    let _ = child.kill();
    None
}

/// Probe with per-python cache. Only DEFINITIVE results are cached — a
/// timeout returns false for this call but is retried on the next start,
/// so one slow boot can't disable Flash Attention for the whole session.
fn flash_attention_cached(state: &AppState, python: &str) -> bool {
    if let Some(v) = state.flash_attn_cache.lock().unwrap().get(python).copied() {
        return v;
    }
    match probe_flash_attention(python) {
        Some(v) => {
            state
                .flash_attn_cache
                .lock()
                .unwrap()
                .insert(python.to_string(), v);
            v
        }
        None => {
            println!("[ComfyUI] flash-attn probe timed out — starting without the flag (will retry next start)");
            false
        }
    }
}

/// GPU-aware version of the Bug J `--cpu` check used at ComfyUI start. Only
/// probes the comfy python's torch when it might change the answer (Auto + no
/// NVIDIA driver), so NVIDIA machines keep the EXACT fast-path they had before.
fn comfy_needs_cpu(
    python: &str,
    mode: ComfyGpuMode,
    cache: Option<&Mutex<HashMap<String, bool>>>,
) -> bool {
    let baseline = needs_cpu_fallback();
    let torch_gpu = if mode == ComfyGpuMode::Auto && baseline && !python.is_empty() {
        comfy_gpu_available_cached(python, cache)
    } else {
        None
    };
    decide_comfy_cpu_flag(mode, baseline, torch_gpu)
}

/// torch-GPU probe with an optional per-python cache (mirrors flash_attention_cached).
/// Only DEFINITIVE results are cached; a timeout returns None and is retried next start.
fn comfy_gpu_available_cached(
    python: &str,
    cache: Option<&Mutex<HashMap<String, bool>>>,
) -> Option<bool> {
    if let Some(c) = cache {
        if let Some(v) = c.lock().unwrap().get(python).copied() {
            return Some(v);
        }
    }
    match probe_comfy_gpu(python) {
        Some(v) => {
            if let Some(c) = cache {
                c.lock().unwrap().insert(python.to_string(), v);
            }
            Some(v)
        }
        None => {
            println!("[ComfyUI] GPU probe timed out — treating as no accel for this start (will retry)");
            None
        }
    }
}

/// Does `python`'s torch report a usable GPU (CUDA / ROCm / ZLUDA)?
///
/// `torch.cuda.is_available()` is SAFE — it never raises (unlike
/// `current_device()`): on a stock-CUDA torch on an AMD box it simply returns
/// False. So this cleanly separates "ROCm/ZLUDA torch → run on GPU" from "stock
/// torch, no GPU → --cpu". Some(true/false) = definitive, None = timeout / spawn fail.
pub(crate) fn probe_comfy_gpu(python: &str) -> Option<bool> {
    if python.is_empty() {
        return Some(false);
    }
    let mut cmd = Command::new(python);
    cmd.args([
        "-c",
        "import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return None,
    };
    // 60 s ceiling: torch import is ~4 s warm but can lag during an app-boot disk
    // storm; a missing/broken torch exits non-zero fast.
    for _ in 0..300 {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.success()),
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(200)),
            Err(_) => return None,
        }
    }
    let _ = child.kill();
    None
}

// The `check_flash_attention` Tauri command + its `resolve_comfyui_python`
// helper were removed in 2.5.8: the 2.5.7 Create redesign dropped the flash-attn
// hint UI that was their only caller, leaving them orphaned (#74). The probe
// itself (probe_flash_attention / flash_attention_cached, above) stays — both
// start_comfyui and the boot auto-start use it to gate `--use-flash-attention`.
// Note: ComfyUI's flash path is FA2-only (`from flash_attn import ...`); FA3
// (module `flash_attn_3`) is a different API ComfyUI does not consume, so the
// FA2 import probe is the correct signal.

// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread.
// The State borrow cannot cross into the blocking pool, so the handle is
// re-resolved there from the AppHandle (same pattern as engine.rs/whisper.rs).
#[tauri::command]
pub async fn start_comfyui(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        start_comfyui_blocking(&state)
    })
    .await
    .map_err(|e| format!("start_comfyui task: {e}"))?
}

fn start_comfyui_blocking(state: &AppState) -> Result<serde_json::Value, String> {
    let _gate = start_gate(&COMFY_START);
    // If user pointed LU at a remote ComfyUI, we have no local process to spawn.
    // Just report status — the remote side is responsible for running ComfyUI.
    {
        let host = state.comfy_host.lock().unwrap().clone();
        if !is_local_host(&host) {
            return Ok(serde_json::json!({
                "status": "remote",
                "host": host,
                "message": "Remote ComfyUI — manage the Python process on the server itself"
            }));
        }
    }

    // macOS is MLX-only for local media — a hard product rule, not a preference.
    // The frontend hides every ComfyUI surface there, but the frontend is not
    // the only caller: the remote/mobile control surface reaches these commands
    // directly, and any future caller would too. Refusing here is what actually
    // makes the rule true. The remote-host branch above still answers, so a Mac
    // pointed at someone else's ComfyUI keeps working — only spawning a local
    // one is refused.
    if !comfy_supported_here() {
        return Err(MACOS_COMFY_REFUSAL.to_string());
    }

    let port = *state.comfy_port.lock().unwrap();

    if is_comfyui_running_on_port(port) {
        return Ok(serde_json::json!({"status": "already_running"}));
    }

    // The port probe alone misses a ComfyUI that is STARTING: it imports for
    // 20-60s before it binds the port. Spawning a second copy in that window
    // overwrites the tracked child handle — the first child keeps running
    // untracked, wins the port bind, and every later stop/restart kills only
    // the tracked twin while the zombie keeps serving the stale node list
    // (the "install spinner never ends" chain). Report 'starting' instead;
    // callers already poll the connection afterwards.
    {
        let mut proc = state.comfy_process.lock().unwrap();
        if let Some(child) = proc.as_mut() {
            match child.try_wait() {
                Ok(None) => return Ok(serde_json::json!({"status": "starting"})),
                _ => *proc = None, // exited or unreapable — clear and start fresh
            }
        }
    }

    let comfy_path = {
        let path = state.comfy_path.lock().unwrap();
        path.clone()
    };

    let comfy_path = comfy_path
        .or_else(|| find_comfyui_path())
        .ok_or_else(|| "ComfyUI not found".to_string())?;

    // Store the path for future use
    {
        let mut path = state.comfy_path.lock().unwrap();
        *path = Some(comfy_path.clone());
    }

    // Prefer the portable's bundled Python over the system one. ComfyUI
    // Portable (NVIDIA, AMD, CPU variants) ships its own Python with the
    // matching torch wheel pre-installed — using the system Python instead
    // wastes that and on AMD it actively fails because system Python lacks
    // the DirectML / ROCm bindings the portable installer prepared. Layout:
    //   <ComfyUI>/python_embeded/python.exe   ← what we want
    //   <ComfyUI>/main.py
    // Fixed Discord report from reload__: AMD Portable launchte nicht.
    let portable_python = std::path::Path::new(&comfy_path)
        .parent()
        .and_then(|p| {
            let candidate = p.join("python_embeded").join("python.exe");
            if candidate.exists() { Some(candidate.to_string_lossy().to_string()) } else { None }
        });
    let bundled_python = portable_python.or_else(|| {
        // Some portable variants nest python_embeded inside the ComfyUI dir
        // itself rather than alongside it.
        let candidate = std::path::Path::new(&comfy_path).join("python_embeded").join("python.exe");
        if candidate.exists() { Some(candidate.to_string_lossy().to_string()) } else { None }
    });
    // Bug E (rzgrozt — Arch PEP 668): when the installer detected an
    // externally-managed Python it created a venv at <ComfyUI>/venv and
    // installed PyTorch + deps into it. Launch from the venv so we don't
    // crash with `ModuleNotFoundError: torch` because the system Python
    // (which is what `state.python_bin` resolves to) never received those
    // packages. Falls back to bundled portable (Windows) or system (Mac /
    // older Linux without PEP 668) when no venv exists.
    let venv_python = crate::python::resolve_comfyui_venv_python(std::path::Path::new(&comfy_path));
    let system_python = state.python_bin.lock().unwrap().clone();
    let python = bundled_python
        .clone()
        .or_else(|| venv_python.clone())
        .unwrap_or(system_python.clone());
    let port_str = port.to_string();
    if python.is_empty() {
        return Err(
            "No Python available — install Python first (Settings → ComfyUI → Install Python). \
             ComfyUI from-source needs a system Python; install one and retry."
                .to_string(),
        );
    }
    if bundled_python.is_some() {
        println!("[ComfyUI] Using bundled portable Python: {}", python);
    } else if venv_python.is_some() {
        println!("[ComfyUI] Using ComfyUI venv Python (PEP 668 install): {}", python);
    } else {
        println!("[ComfyUI] Using system Python: {}", python);
    }
    println!("[ComfyUI] Starting from: {} on port {}", comfy_path, port);
    info!(port = port, "comfyui start");

    // Bug J (discovered during 2026-05-17 Arch live test): on systems without
    // an NVIDIA driver (most Linux non-NVIDIA setups: AMD, Intel, CPU-only;
    // also Windows boxes without an NVIDIA card), ComfyUI's main.py calls
    // get_torch_device() → torch.cuda.current_device() → which raises
    // `RuntimeError: Found no NVIDIA driver on your system` before
    // main.py ever binds the port. The user sees LU stuck on "ComfyUI
    // loading..." (which Bug B's 60-s panel now correctly surfaces, but
    // the underlying spawn-then-crash loop wastes the user's time on every
    // start). Detect NVIDIA via `nvidia-smi` and pass --cpu when absent,
    // except on macOS where PyTorch uses MPS and never calls cuda APIs.
    let gpu_mode = ComfyGpuMode::parse(&state.comfy_gpu_mode.lock().unwrap());
    let needs_cpu_fallback = comfy_needs_cpu(&python, gpu_mode, Some(&state.comfy_gpu_cache));
    // shd_scorpion (RX 7900 XTX): remember what we actually launched with so
    // the Create tab can warn instead of letting a CPU gen time out silently.
    *state.comfy_started_cpu.lock().unwrap() = Some(needs_cpu_fallback);
    // Force GPU skips the probe above on purpose, so ask separately and only
    // in that mode: the answer costs a torch import once per python path and
    // buys the sentence that explains the crash that is about to happen.
    let force_gpu_note = if gpu_mode == ComfyGpuMode::ForceGpu {
        let (_, has_amd) = crate::commands::torch_wheels::gpu_vendors_present();
        force_gpu_warning(
            gpu_mode,
            comfy_gpu_available_cached(&python, Some(&state.comfy_gpu_cache)),
            has_amd,
            std::env::consts::OS,
        )
    } else {
        None
    };
    if let Some(note) = &force_gpu_note {
        println!("[ComfyUI] {note}");
    }
    let mut comfy_args: Vec<&str> = vec![
        "main.py",
        "--listen", "127.0.0.1",
        "--port", &port_str,
        "--enable-cors-header", "*",
    ];
    if needs_cpu_fallback {
        comfy_args.push("--cpu");
        println!("[ComfyUI] No NVIDIA driver detected — passing --cpu to ComfyUI (CPU inference fallback)");
    }
    // Auto-enable Flash Attention when the package actually imports in THIS
    // python (David 2026-06-11: measured 4-5x faster WAN video sampling vs
    // pytorch SDPA on a 12 GB 3060). ComfyUI only uses FA2 with the flag, so
    // an installed wheel does nothing without this. The real-import probe
    // guarantees we never pass the flag on a broken install (ComfyUI would
    // error at startup); probe result is cached per python path. CPU mode
    // skips it — flash-attn is CUDA-only.
    if !needs_cpu_fallback && flash_attention_cached(&state, &python) {
        comfy_args.push("--use-flash-attention");
        println!("[ComfyUI] flash-attn detected in {} — enabling Flash Attention", python);
    }
    let mut cmd = Command::new(&python);
    cmd.args(&comfy_args)
        .current_dir(&comfy_path)
        .env("TQDM_DISABLE", "1")
        .env("PYTHONUNBUFFERED", "1")
        // Windows fix (plum133, Discord 2026-06-07): ComfyUI / its nodes print
        // Unicode progress glyphs (e.g. '▍' U+258D) to stdout. On a non-UTF-8
        // Windows console codepage (cp1252) Python's *piped* stdout defaults to
        // the locale codec and raises UnicodeEncodeError ("'charmap' codec
        // can't encode character '▍' …"), which propagates out of the
        // KSampler progress callback and aborts generation ("Generation
        // failed: … (KSampler)"). Force UTF-8 I/O so any Unicode output is
        // encodable on every locale — also keeps the Rust-side line reader's
        // UTF-8 assumption valid.
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Bug BB v2.5.0 — same GPU env forwarding as start_ollama. ComfyUI's
    // backend (torch / DirectML / IPEX) reads these on import, so the pick
    // takes effect on next spawn (current process must be restarted for a
    // change to apply — surfaced as a hint in the Settings UI).
    if let Ok(sel) = state.gpu_selection.lock() {
        crate::commands::gpu::apply_gpu_env(&mut cmd, &sel);
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn()
        .map_err(|e| {
            // The log keeps whatever the OS wrote, in whatever language: it is
            // ours to read and the original wording helps support. Only the
            // line the user sees is rewritten.
            error!(error = %e, python = %python, "comfyui start failed");
            format!("Failed to start ComfyUI (python={}): {}", python, os_error::english(&e))
        })?;

    // Assign to Job Object so child dies when parent dies (even via Task Manager)
    #[cfg(target_os = "windows")]
    assign_to_kill_on_close_job(&child);

    // Drain stdout/stderr in background threads to prevent buffer deadlock.
    // Each line also lands in the comfy_output ring buffer (GH #98): the
    // shipped app has no console, so a startup crash printed here was
    // invisible and every "did not come up" report ended in a blind spot.
    {
        let mut buf = state.comfy_output.lock().unwrap();
        buf.clear();
        buf.push_back(format!("[start] {} main.py --port {}", python, port_str));
        if let Some(note) = &force_gpu_note {
            buf.push_back(note.clone());
        }
    }
    let capture = |line: String, sink: &Arc<Mutex<std::collections::VecDeque<String>>>| {
        println!("[ComfyUI] {}", line);
        if let Ok(mut buf) = sink.lock() {
            if buf.len() >= 400 {
                buf.pop_front();
            }
            buf.push_back(line);
        }
    };
    if let Some(stdout) = child.stdout.take() {
        let sink = state.comfy_output.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                capture(line, &sink);
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let sink = state.comfy_output.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                capture(line, &sink);
            }
        });
    }

    // A spawn is not a start (E16, measured on the Windows box 2026-08-14).
    // That install had ComfyUI's source but neither python_embeded nor a venv,
    // so this fell back to the system Python, which has none of the
    // dependencies: main.py died on its first import inside a second. We
    // reported {"status":"started"} anyway, the panel showed `Stopped` with no
    // reason, and the traceback sat unread in our own ring buffer.
    //
    // The port cannot be the test here, ComfyUI imports for 20 to 60 seconds
    // before it binds. The crash can: it happens far inside this window. So
    // watch briefly, and if the child is already gone, fail with what it said.
    let mut watched = std::time::Duration::ZERO;
    let early_exit = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status.code()),
            Ok(None) => {}
            Err(_) => break None,
        }
        if watched >= COMFY_STARTUP_WATCH {
            break None;
        }
        std::thread::sleep(COMFY_STARTUP_STEP);
        watched += COMFY_STARTUP_STEP;
    };
    if let Some(code) = early_exit {
        let tail: Vec<String> = state
            .comfy_output
            .lock()
            .map(|b| b.iter().cloned().collect())
            .unwrap_or_default();
        let msg = comfy_startup_failure(
            &python,
            code,
            &tail,
            bundled_python.is_some() || venv_python.is_some(),
        );
        error!(python = %python, "comfyui exited during startup");
        *state.comfy_start_at.lock().unwrap() = None;
        return Err(msg);
    }

    // Store process
    {
        let mut proc = state.comfy_process.lock().unwrap();
        *proc = Some(child);
    }
    *state.comfy_start_at.lock().unwrap() = Some(std::time::Instant::now());

    println!("[ComfyUI] Started");
    info!("comfyui started");
    Ok(serde_json::json!({"status": "started", "path": comfy_path}))
}

// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread.
// The State borrow cannot cross into the blocking pool, so the handle is
// re-resolved there from the AppHandle (same pattern as engine.rs/whisper.rs).
#[tauri::command]
pub async fn stop_comfyui(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        stop_comfyui_blocking(&state)
    })
    .await
    .map_err(|e| format!("stop_comfyui task: {e}"))?
}

fn stop_comfyui_blocking(state: &AppState) -> Result<serde_json::Value, String> {
    let mut proc = state.comfy_process.lock().unwrap();
    if let Some(ref mut child) = *proc {
        let pid = child.id();
        if cfg!(target_os = "windows") {
            let mut cmd = Command::new("taskkill");
            cmd.args(["/pid", &pid.to_string(), "/T", "/F"]);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = cmd.output();
        } else {
            let _ = child.kill();
        }
        // Reap before returning: guarantees the listen socket is released, so
        // a start_comfyui right after us cannot lose the port bind (10048) to
        // the dying process and silently leave the OLD node list being served.
        let _ = child.wait();
        *proc = None;
        *state.comfy_start_at.lock().unwrap() = None;
        println!("[ComfyUI] Stopped");
        info!(pid = pid, "comfyui stopped");
        Ok(serde_json::json!({"status": "stopped"}))
    } else {
        Ok(serde_json::json!({"status": "not_running"}))
    }
}

/// The last lines ComfyUI printed (GH #98). This is what "Check Settings →
/// AI Backends" could never show: the actual crash. Also reports whether the
/// tracked child has exited, so the frontend can say "crashed" instead of
/// "still starting" while it polls a port that will never open.
#[tauri::command]
pub fn comfyui_last_output(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let lines: Vec<String> = state
        .comfy_output
        .lock()
        .map(|b| b.iter().cloned().collect())
        .unwrap_or_default();
    let exited = {
        let mut proc = state.comfy_process.lock().unwrap();
        match proc.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(Some(_)) | Err(_)),
            None => true,
        }
    };
    // envBroken drives the self-repair (GH #98): only a crash that looks like
    // a dead Python environment may trigger the venv rebuild, everything else
    // keeps its own message.
    let env_broken = exited && comfy_env_failure(&lines);
    Ok(serde_json::json!({ "lines": lines, "exited": exited, "envBroken": env_broken }))
}

#[tauri::command]
pub async fn comfyui_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let port = *state.comfy_port.lock().unwrap();
    let host = state.comfy_host.lock().unwrap().clone();
    let is_local = is_local_host(&host);

    // Probe the configured host (not just localhost). Remote ComfyUI
    // still reports running: true if the /system_stats endpoint responds.
    let running = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok()
        .and_then(|c| Some(c.get(format!("http://{}:{}/system_stats", host, port))))
        .map(|req| async move { req.send().await.map(|r| r.status().is_success()).unwrap_or(false) })
    ;
    let running = match running {
        Some(fut) => fut.await,
        None => false,
    };

    // Reap the spawned child so a crash-on-startup doesn't read as "alive".
    // We store the Child from start_comfyui in state.comfy_process. If that
    // process exits early (the classic case: ComfyUI's main.py aborts on a bad
    // dependency / missing torch / SQLAlchemy<2.0 / "no NVIDIA driver" before it
    // binds the port), the handle would otherwise linger as Some(_) forever —
    // making process_alive=true and therefore `starting` (process_alive &&
    // !running) STICK TRUE INDEFINITELY. The user then stares at an endless
    // "ComfyUI starting…" with no error. try_wait() detects the early exit so we
    // clear the handle and report "stopped", letting the UI re-offer "click to
    // start" + the troubleshoot panel instead of a phantom loading state.
    let process_alive = {
        let mut proc = state.comfy_process.lock().unwrap();
        match proc.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(status)) => {
                    error!(exit = ?status, "comfyui process exited early (crash on startup?) — clearing handle");
                    *proc = None;
                    false
                }
                Ok(None) => true,  // still running; just hasn't bound the port yet
                Err(_) => true,    // can't determine — assume alive, don't thrash
            },
            None => false,
        }
    };

    let path = {
        let p = state.comfy_path.lock().unwrap();
        p.clone()
    };

    // For remote hosts we don't care whether a local install path exists.
    let resolved_path: Option<String> = if is_local {
        path.clone().or_else(find_comfyui_path)
    } else {
        None
    };

    let found = if is_local {
        resolved_path.is_some()
    } else {
        true  // the remote side handles its own install
    };

    // Carcass detection: a local install is only "complete" if torch is
    // actually reachable. Remote hosts are reported complete by definition
    // — the remote side owns its own install state.
    let complete = if is_local {
        match &resolved_path {
            Some(p) => is_comfyui_install_complete(Path::new(p)),
            None => false,
        }
    } else {
        true
    };

    let since_start = state.comfy_start_at.lock().unwrap().map(|t| t.elapsed());
    let (starting, stalled) = comfy_starting_state(process_alive, running, since_start);

    Ok(serde_json::json!({
        "running": running,
        "starting": starting,
        "stalled": stalled,
        "found": found,
        "complete": complete,
        "path": path,
        "port": port,
        "host": host,
        "isLocal": is_local,
        "processAlive": process_alive,
    }))
}

/// Returns true when `host` refers to the local machine.
/// Anything else = remote and LU won't try to manage the process.
pub fn is_local_host(host: &str) -> bool {
    let h = host.trim().to_ascii_lowercase();
    matches!(h.as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0" | "")
}

#[tauri::command]
pub fn find_comfyui() -> Result<serde_json::Value, String> {
    match find_comfyui_path() {
        Some(path) => {
            // Surface install completeness so the UI can distinguish a
            // working ComfyUI from a half-cloned carcass and offer the
            // right action (Continue vs. Re-install). See
            // is_comfyui_install_complete for the definition of "complete".
            let complete = is_comfyui_install_complete(Path::new(&path));
            Ok(serde_json::json!({
                "found": true,
                "path": path,
                "complete": complete,
            }))
        }
        None => Ok(serde_json::json!({
            "found": false,
            "path": null,
            "complete": false,
        })),
    }
}

/// Frontend-owned override for the ComfyUI CPU/GPU device decision
/// (settings.comfyGpuMode). "auto" | "cpu" | "gpu". Desktop-relevant only — the
/// web build points at a remote ComfyUI and never starts a local one.
#[tauri::command]
pub fn set_comfy_gpu_mode(mode: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let normalized = match mode.trim().to_ascii_lowercase().as_str() {
        "cpu" => "cpu",
        "gpu" => "gpu",
        _ => "auto",
    };
    *state.comfy_gpu_mode.lock().unwrap() = normalized.to_string();
    // The mode can flip the target device, so drop cached probe results; the
    // next start re-probes cleanly under the new mode.
    state.comfy_gpu_cache.lock().unwrap().clear();
    println!("[ComfyUI] GPU mode = {}", normalized);
    Ok(serde_json::json!({ "mode": normalized }))
}

/// shd_scorpion (Discord 2026-07-03, RX 7900 XTX): a forced-CPU ComfyUI showed
/// "Ready to generate" and then died with "timed out after 20 minutes" — no
/// hint it never used the GPU. Lets the Create tab render an honest warning.
/// `startedCpu` is None until LU itself has (re)started ComfyUI this session
/// (an externally started ComfyUI is the user's own device choice).
#[tauri::command]
pub fn get_comfy_gpu_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mode = state.comfy_gpu_mode.lock().unwrap().clone();
    let started_cpu = *state.comfy_started_cpu.lock().unwrap();
    // The vendor is what turns "this ran on the processor" into a sentence the
    // user can act on: an AMD card on Linux wants a rebuilt environment, the
    // same card on Windows wants to be told no rebuild can help. Same probe the
    // hardware picker and the installers use.
    let (_, has_amd) = crate::commands::torch_wheels::gpu_vendors_present();
    Ok(serde_json::json!({ "mode": mode, "startedCpu": started_cpu, "hasAmd": has_amd }))
}

#[tauri::command]
pub fn set_comfyui_path(path: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // Resolve the path the user gave us to a directory that actually contains
    // `main.py`. Direct hit short-circuits; otherwise we look at the ComfyUI
    // Desktop App layout (Comfy-Org/desktop, GH #47, levoy1 2026-05-24): the
    // user typically points at `%LOCALAPPDATA%\Programs\ComfyUI` (the binary
    // dir with `ComfyUI.exe` next to no `main.py`) because that's what their
    // shortcut targets, but the actual Working Directory with `main.py` +
    // `models/` + `custom_nodes/` lives under `~\Documents\ComfyUI` or
    // `%APPDATA%\ComfyUI` depending on the install picker. We transparently
    // re-route in that case so the error doesn't look unfixable.
    let resolved = resolve_comfyui_path(&path)
        .ok_or_else(|| {
            if Path::new(&path).join("ComfyUI.exe").exists() {
                format!(
                    "Looks like the ComfyUI Desktop App binary folder ({}). LU needs the ComfyUI Working Directory (with main.py, models/, custom_nodes/) — by default `~\\Documents\\ComfyUI` or wherever you picked during install. Open the Desktop App once, check Settings → ComfyUI Working Directory, and paste that path here.",
                    path
                )
            } else {
                format!("main.py not found in {}", path)
            }
        })?;

    let path = resolved;

    // Store in memory
    {
        let mut p = state.comfy_path.lock().unwrap();
        *p = Some(path.clone());
    }

    // Persist to config file
    {
        let app_config = crate::os_paths::app_config_dir();
        let _ = fs::create_dir_all(&app_config);
        let config_file = app_config.join("config.json");

        let mut config: serde_json::Value = if config_file.exists() {
            fs::read_to_string(&config_file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        config["comfyui_path"] = serde_json::json!(path);
        let _ = fs::write(&config_file, serde_json::to_string_pretty(&config).unwrap());
    }

    Ok(serde_json::json!({"status": "saved", "path": path}))
}

/// Split a trailing `:port` off a host the user typed. The neighbouring Ollama
/// field accepts `host:port`, so people type it here too — and it broke
/// everything downstream without saying so: the proxy allow-list compares
/// against the PARSED host (no port) and refused the request, while the progress
/// socket built `ws://host:port:port`. The user then read "host not allowed,
/// configure it in Settings" about the field they had just filled in.
/// IPv6 literals (more than one colon) are left alone.
fn split_host_port(input: &str) -> (String, Option<u16>) {
    if input.matches(':').count() == 1 {
        if let Some((h, p)) = input.rsplit_once(':') {
            if !h.is_empty() && !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) {
                if let Ok(port) = p.parse::<u16>() {
                    if port > 0 {
                        return (h.to_string(), Some(port));
                    }
                }
            }
        }
    }
    (input.to_string(), None)
}

#[tauri::command]
pub fn set_comfyui_host(host: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return Err("Host must not be empty".to_string());
    }
    // Reject obviously invalid chars — helps avoid URL-injection style typos.
    if trimmed.contains('/') || trimmed.contains(' ') || trimmed.contains('?') {
        return Err("Host must be a plain hostname or IP, no slashes/spaces".to_string());
    }
    let (final_host, typed_port) = split_host_port(trimmed);

    {
        let mut h = state.comfy_host.lock().unwrap();
        *h = final_host.clone();
    }
    if let Some(port) = typed_port {
        let mut p = state.comfy_port.lock().unwrap();
        *p = port;
    }

    // Persist to config file
    {
        let app_config = crate::os_paths::app_config_dir();
        let _ = fs::create_dir_all(&app_config);
        let config_file = app_config.join("config.json");

        let mut config: serde_json::Value = if config_file.exists() {
            fs::read_to_string(&config_file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        config["comfyui_host"] = serde_json::json!(final_host);
        if let Some(port) = typed_port {
            config["comfyui_port"] = serde_json::json!(port);
        }
        let _ = fs::write(&config_file, serde_json::to_string_pretty(&config).unwrap());
    }

    let is_local = is_local_host(&final_host);
    println!("[ComfyUI] Host set to {} (local={})", final_host, is_local);
    Ok(serde_json::json!({"status": "saved", "host": final_host, "isLocal": is_local}))
}

#[tauri::command]
pub fn set_comfyui_port(port: u16, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    if port == 0 {
        return Err("Port must be greater than 0".to_string());
    }

    {
        let mut p = state.comfy_port.lock().unwrap();
        *p = port;
    }

    // Persist to config file
    {
        let app_config = crate::os_paths::app_config_dir();
        let _ = fs::create_dir_all(&app_config);
        let config_file = app_config.join("config.json");

        let mut config: serde_json::Value = if config_file.exists() {
            fs::read_to_string(&config_file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        config["comfyui_port"] = serde_json::json!(port);
        let _ = fs::write(&config_file, serde_json::to_string_pretty(&config).unwrap());
    }

    println!("[ComfyUI] Port set to {}", port);
    Ok(serde_json::json!({"status": "saved", "port": port}))
}

/// Normalize user input into a full Ollama base URL.
/// Accepts bare `host:port`, scheme-less host, or full URL.
/// Returns full URL without trailing slash, or Err for obviously bad input.
fn normalize_ollama_base(input: &str) -> Result<String, String> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Endpoint must not be empty".into());
    }
    // Reject whitespace / newlines inside the URL.
    if trimmed.chars().any(|c| c.is_whitespace()) {
        return Err("Endpoint must not contain whitespace".into());
    }
    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{}", trimmed)
    };
    // Sanity-check with a URL parse so "http://" alone or "http://:1234" can't pass.
    match url::Url::parse(&with_scheme) {
        Ok(u) if u.host_str().map_or(false, |h| !h.is_empty()) => Ok(with_scheme),
        _ => Err(format!("Not a valid URL: {}", input)),
    }
}

#[tauri::command]
pub fn set_ollama_host(host: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let final_base = normalize_ollama_base(&host)?;

    {
        let mut b = state.ollama_base.lock().unwrap();
        *b = final_base.clone();
    }

    // Persist to config file under ollama_base — next startup will pick it
    // up via load_ollama_base() before any request fires.
    {
        let app_config = crate::os_paths::app_config_dir();
        let _ = fs::create_dir_all(&app_config);
        let config_file = app_config.join("config.json");

        let mut config: serde_json::Value = if config_file.exists() {
            fs::read_to_string(&config_file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        config["ollama_base"] = serde_json::json!(final_base);
        let _ = fs::write(&config_file, serde_json::to_string_pretty(&config).unwrap());
    }

    let is_local = url::Url::parse(&final_base)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
        .map(|h| matches!(h.as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0"))
        .unwrap_or(false);

    println!("[Ollama] Base URL set to {} (local={})", final_base, is_local);
    Ok(serde_json::json!({"status": "saved", "base": final_base, "isLocal": is_local}))
}

// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread.
// The State borrow cannot cross into the blocking pool, so the handle is
// re-resolved there from the AppHandle (same pattern as engine.rs/whisper.rs).
#[tauri::command]
pub async fn get_ollama_host(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        get_ollama_host_blocking(&state)
    })
    .await
    .map_err(|e| format!("get_ollama_host task: {e}"))?
}

fn get_ollama_host_blocking(state: &AppState) -> Result<serde_json::Value, String> {
    let base = state.ollama_base.lock().unwrap().clone();
    let is_local = url::Url::parse(&base)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
        .map(|h| matches!(h.as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0"))
        .unwrap_or(false);
    Ok(serde_json::json!({"base": base, "isLocal": is_local}))
}

/// Auto-start Ollama on app launch (called from setup)
pub fn auto_start_ollama(state: &AppState) {
    if ollama_port_open() {
        println!("[Ollama] Already running");
        return;
    }

    println!("[Ollama] Starting...");
    let mut cmd = Command::new("ollama");
    cmd.arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    match cmd.spawn() {
        Ok(child) => {
            // Same orphan-prevention rationale as `start_ollama` above.
            tie_child_to_app_lifetime(child.id());
            *state.ollama_process.lock().unwrap() = Some(child);
            println!("[Ollama] Started");
        }
        Err(e) => println!("[Ollama] Failed to start: {}", e),
    }
}

/// Auto-start ComfyUI on app launch (called from setup)
pub fn auto_start_comfyui(state: &AppState) {
    // Hard rule: macOS local media is MLX only, NEVER ComfyUI (see
    // commands::mlx / commands::video). Auto-starting ComfyUI on Mac violated
    // that rule (2026-07-23 log: "[ComfyUI] Already running on port 8188").
    // ComfyUI itself stays fully intact for Windows/Linux and for a user who
    // manually invokes `start_comfyui` — only the unattended boot path skips it.
    if cfg!(target_os = "macos") {
        println!("[ComfyUI] Auto-start skipped on macOS — local media is MLX-only");
        return;
    }
    // If user configured a remote host, don't try to auto-start anything locally.
    {
        let host = state.comfy_host.lock().unwrap().clone();
        if !is_local_host(&host) {
            println!("[ComfyUI] Remote host configured ({}), skipping local auto-start", host);
            return;
        }
    }

    // Always try to find and store the ComfyUI path (needed for downloads)
    if state.comfy_path.lock().unwrap().is_none() {
        if let Some(path) = find_comfyui_path() {
            println!("[ComfyUI] Found at: {}", path);
            *state.comfy_path.lock().unwrap() = Some(path);
        }
    }

    let port = *state.comfy_port.lock().unwrap();

    if is_comfyui_running_on_port(port) {
        println!("[ComfyUI] Already running on port {}", port);
        return;
    }

    match find_comfyui_path() {
        Some(path) => {
            let port_str = port.to_string();
            println!("[ComfyUI] Auto-starting from: {} on port {}", path, port);
            *state.comfy_path.lock().unwrap() = Some(path.clone());

            // Mirror the start_comfyui Python preference: use the portable's
            // bundled Python when present so AMD / cu126 / CPU portables boot
            // with the right torch wheel. See start_comfyui for full context.
            let portable_python = std::path::Path::new(&path)
                .parent()
                .and_then(|p| {
                    let c = p.join("python_embeded").join("python.exe");
                    if c.exists() { Some(c.to_string_lossy().to_string()) } else { None }
                })
                .or_else(|| {
                    let c = std::path::Path::new(&path).join("python_embeded").join("python.exe");
                    if c.exists() { Some(c.to_string_lossy().to_string()) } else { None }
                });
            // Bug E: prefer the per-install venv that the PEP 668 path
            // creates (Arch / Debian 12+ / Fedora 38+ / Ubuntu 23.04+).
            // Without this auto-start would launch with the system Python
            // that doesn't have torch and crash on first import.
            let venv_python = crate::python::resolve_comfyui_venv_python(std::path::Path::new(&path));
            let system_python = state.python_bin.lock().unwrap().clone();
            let python = portable_python
                .clone()
                .or_else(|| venv_python.clone())
                .unwrap_or_else(|| system_python.clone());
            if python.is_empty() {
                println!("[ComfyUI] Auto-start skipped: no Python available (install via P14 flow)");
                return;
            }
            if portable_python.is_some() {
                println!("[ComfyUI] Auto-start using bundled portable Python: {}", python);
            } else if venv_python.is_some() {
                println!("[ComfyUI] Auto-start using ComfyUI venv Python (PEP 668 install): {}", python);
            }

            // Bug J: same --cpu fallback as start_comfyui to avoid the
            // "Found no NVIDIA driver" crash loop on non-NVIDIA systems.
            let auto_gpu_mode = ComfyGpuMode::parse(&state.comfy_gpu_mode.lock().unwrap());
            let auto_needs_cpu = comfy_needs_cpu(&python, auto_gpu_mode, Some(&state.comfy_gpu_cache));
            // Mirror of start_comfyui: expose the real launch mode to the UI.
            *state.comfy_started_cpu.lock().unwrap() = Some(auto_needs_cpu);
            let mut comfy_args: Vec<&str> = vec![
                "main.py",
                "--listen", "127.0.0.1",
                "--port", &port_str,
                "--enable-cors-header", "*",
            ];
            if auto_needs_cpu {
                comfy_args.push("--cpu");
                println!("[ComfyUI] Auto-start: no NVIDIA driver — passing --cpu");
            }
            // Mirror start_comfyui: auto-enable Flash Attention (FA2) when it
            // actually imports in this python. Boot auto-start previously never
            // passed the flag, so auto-started ComfyUI ran WAN video 4-5x slower
            // than a manual start even with flash-attn installed. The probe is
            // cached per python; an absent package fails fast, so the rare cost
            // is one slow first-probe on a cold boot with flash-attn present.
            if !auto_needs_cpu && flash_attention_cached(state, &python) {
                comfy_args.push("--use-flash-attention");
                println!("[ComfyUI] Auto-start: flash-attn detected — enabling Flash Attention");
            }
            let mut cmd = Command::new(&python);
            cmd.args(&comfy_args)
                .current_dir(&path)
                .env("TQDM_DISABLE", "1")
                .env("PYTHONUNBUFFERED", "1")
                // Windows UTF-8 fix — see start_comfyui (plum133 2026-06-07):
                // prevents the cp1252 'charmap' UnicodeEncodeError crash when
                // ComfyUI prints Unicode progress glyphs to the piped stdout.
                .env("PYTHONIOENCODING", "utf-8")
                .env("PYTHONUTF8", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            match cmd.spawn() {
                Ok(mut child) => {
                    // Assign to Job Object so child dies when parent dies (even via Task Manager)
                    #[cfg(target_os = "windows")]
                    assign_to_kill_on_close_job(&child);

                    // Drain stdout/stderr in background threads to prevent buffer deadlock
                    if let Some(stdout) = child.stdout.take() {
                        std::thread::spawn(move || {
                            use std::io::{BufRead, BufReader};
                            let reader = BufReader::new(stdout);
                            for line in reader.lines() {
                                if let Ok(line) = line {
                                    println!("[ComfyUI] {}", line);
                                }
                            }
                        });
                    }
                    if let Some(stderr) = child.stderr.take() {
                        std::thread::spawn(move || {
                            use std::io::{BufRead, BufReader};
                            let reader = BufReader::new(stderr);
                            for line in reader.lines() {
                                if let Ok(line) = line {
                                    println!("[ComfyUI] {}", line);
                                }
                            }
                        });
                    }

                    *state.comfy_process.lock().unwrap() = Some(child);
                    println!("[ComfyUI] Started");
                }
                Err(e) => println!("[ComfyUI] Failed to start: {}", e),
            }
        }
        None => println!("[ComfyUI] Not found. Install ComfyUI or set path in settings."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── OI-1: "your working ComfyUI is a broken torso" ───────────────────
    //
    // The probe answered `false` for every from-source Linux install and for
    // every install on any platform that had been through `repair_comfyui_env`,
    // because (a) it never looked inside ComfyUI's own venv, which is where
    // both of those put torch, and (b) its system-Python branch was dead code:
    // the candidate list held the bare string "python3",
    // `Path::new("python3").parent()` is `Some("")`, and `"".parent()` is
    // `None`, so the Unix arm could not be reached and the Windows arm
    // degenerated to the relative path `Lib/site-packages/torch`.
    //
    // Both prefix layouts are built as fixture directories and the interpreter
    // list is injected, so the Windows layout is checked on Unix and vice
    // versa. What is NOT checked here: that a real ComfyUI with a real torch
    // starts — that needs an actual 2 GB install.

    /// Lay out `<root>/<rel>/torch` as a directory, creating parents.
    fn touch_torch(root: &Path, rel: &str) {
        let dir = root.join(rel).join("torch");
        std::fs::create_dir_all(&dir).unwrap();
    }

    fn comfy_fixture() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        std::fs::create_dir_all(&comfy).unwrap();
        std::fs::write(comfy.join("main.py"), b"# comfy").unwrap();
        (tmp, comfy)
    }

    #[test]
    fn a_main_py_only_carcass_is_still_incomplete() {
        // P14's guarantee must survive the OI-1 fix: a half-cloned dir with
        // nothing but main.py has no torch anywhere and stays incomplete.
        let (_tmp, comfy) = comfy_fixture();
        assert!(!is_comfyui_install_complete_with(&comfy, &[]));
    }

    #[test]
    fn a_directory_without_main_py_is_not_a_comfyui_at_all() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("NotComfy");
        // Even with a fully populated venv: no main.py, nothing to start.
        touch_torch(&dir, "venv/lib/python3.12/site-packages");
        assert!(!is_comfyui_install_complete_with(&dir, &[]));
    }

    #[test]
    fn torch_in_comfyuis_own_venv_unix_layout_is_complete() {
        // The Linux from-source install and EVERY repaired install. This is
        // the case that reported "broken torso" to every affected user.
        let (_tmp, comfy) = comfy_fixture();
        touch_torch(&comfy, "venv/lib/python3.12/site-packages");
        assert!(is_comfyui_install_complete_with(&comfy, &[]));
    }

    #[test]
    fn torch_in_comfyuis_own_venv_windows_layout_is_complete() {
        let (_tmp, comfy) = comfy_fixture();
        touch_torch(&comfy, "venv/Lib/site-packages");
        assert!(is_comfyui_install_complete_with(&comfy, &[]));
    }

    #[test]
    fn a_dot_venv_counts_like_a_venv() {
        // `uv` and a modern `python -m venv .venv` — same install, other name
        // (issue #51, adhney; `resolve_comfyui_venv_python` already knows it).
        let (_tmp, comfy) = comfy_fixture();
        touch_torch(&comfy, ".venv/lib/python3.11/site-packages");
        assert!(is_comfyui_install_complete_with(&comfy, &[]));
    }

    #[test]
    fn a_venv_without_torch_is_not_complete() {
        // Negative control: the venv exists (a repair that died during the
        // PyTorch download) but holds no torch, so it cannot start.
        let (_tmp, comfy) = comfy_fixture();
        std::fs::create_dir_all(comfy.join("venv").join("lib").join("python3.12").join("site-packages")).unwrap();
        assert!(!is_comfyui_install_complete_with(&comfy, &[]));
    }

    #[test]
    fn a_portable_python_embeded_still_counts_inside_or_beside() {
        let (_tmp, comfy) = comfy_fixture();
        touch_torch(&comfy, "python_embeded/Lib/site-packages");
        assert!(is_comfyui_install_complete_with(&comfy, &[]));

        // The other portable shape: python_embeded is a SIBLING of ComfyUI.
        let (_tmp2, comfy2) = comfy_fixture();
        let beside = comfy2.parent().unwrap().to_path_buf();
        touch_torch(&beside, "python_embeded/Lib/site-packages");
        assert!(is_comfyui_install_complete_with(&comfy2, &[]));
    }

    #[test]
    fn a_unix_system_python_prefix_is_read_through_bin() {
        // /usr/bin/python3 → prefix /usr → /usr/lib/python3.12/site-packages.
        // The interpreter is one level BELOW its prefix on Unix, which is why
        // the probe has to try the parent too.
        let (_tmp, comfy) = comfy_fixture();
        let root = comfy.parent().unwrap().join("usr");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        let py = root.join("bin").join("python3");
        std::fs::write(&py, b"stub").unwrap();
        touch_torch(&root, "lib/python3.12/site-packages");
        assert!(is_comfyui_install_complete_with(
            &comfy,
            &[py.to_string_lossy().to_string()]
        ));
    }

    #[test]
    fn a_windows_system_python_prefix_is_read_next_to_the_exe() {
        // C:\Python312\python.exe → C:\Python312\Lib\site-packages. Here the
        // interpreter sits IN its prefix, not one below it.
        let (_tmp, comfy) = comfy_fixture();
        let root = comfy.parent().unwrap().join("Python312");
        std::fs::create_dir_all(&root).unwrap();
        let py = root.join("python.exe");
        std::fs::write(&py, b"stub").unwrap();
        touch_torch(&root, "Lib/site-packages");
        assert!(is_comfyui_install_complete_with(
            &comfy,
            &[py.to_string_lossy().to_string()]
        ));
    }

    #[test]
    fn a_bare_interpreter_name_can_never_answer_yes() {
        // The mechanism of the bug, pinned. `Path::new("python3").parent()`
        // is `Some("")`; joining onto it makes a RELATIVE path that resolves
        // against LU's working directory, and `"".parent()` is `None`, which
        // is what made the Unix arm unreachable.
        assert_eq!(Path::new("python3").parent(), Some(Path::new("")));
        assert_eq!(Path::new("").parent(), None);
        assert!(!python_prefix_has_torch(Path::new("python3")));
        assert!(!python_prefix_has_torch(Path::new("python")));
        assert!(!prefix_has_torch(Path::new("")));
    }

    #[test]
    fn every_candidate_python_is_an_absolute_path() {
        // The callers derive a prefix from these strings, so a bare name is
        // not a weaker answer, it is a wrong one.
        for p in collect_candidate_pythons() {
            assert!(
                Path::new(&p).is_absolute(),
                "candidate python is not absolute: {p}"
            );
        }
    }

    // ── E16: a start that fails has to say so ────────────────────────────
    //
    // Measured on the Windows box on 2026-08-14. The install had ComfyUI's
    // source but neither python_embeded nor a venv, so the launch fell back to
    // the system Python, which has none of the dependencies. main.py died on
    // its first import inside a second. What the user got: `start_comfyui`
    // answered {"status":"started"}, `comfyui_status` answered
    // processAlive true / running false / starting true, the panel showed
    // `Stopped`, and six minutes later it still showed `Stopped` with no
    // reason anywhere, while the ImportError sat in our own ring buffer.

    #[test]
    fn a_start_that_is_already_over_stops_claiming_to_be_starting() {
        // Inside the grace period a slow import is a normal start.
        assert_eq!(
            comfy_starting_state(true, false, Some(std::time::Duration::from_secs(30))),
            (true, false),
        );
        // Past it, the handle is not proof of anything. `starting` has to end,
        // and the caller needs to know it ended badly rather than quietly.
        assert_eq!(
            comfy_starting_state(true, false, Some(std::time::Duration::from_secs(COMFY_STARTING_GRACE_SECS + 1))),
            (false, true),
        );
        // A port that answers is the end of the question, however long it took.
        assert_eq!(
            comfy_starting_state(true, true, Some(std::time::Duration::from_secs(9_999))),
            (false, false),
        );
        // No child, nothing to wait for.
        assert_eq!(comfy_starting_state(false, false, None), (false, false));
        // Unknown start time (handle from an earlier session): fall back to the
        // old reading rather than declaring a stall we cannot date.
        assert_eq!(comfy_starting_state(true, false, None), (true, false));
    }

    #[test]
    fn the_failure_message_carries_the_traceback_and_the_likely_cause() {
        let tail = vec![
            "[start] C:\\Python313\\python.exe main.py --port 8188".to_string(),
            "Traceback (most recent call last):".to_string(),
            "  File \"main.py\", line 25, in <module>".to_string(),
            "    from app.assets.seeder import asset_seeder".to_string(),
            "ModuleNotFoundError: No module named 'app'".to_string(),
        ];
        let msg = comfy_startup_failure("C:\\Python313\\python.exe", Some(1), &tail, false);

        // The reason the user can act on, verbatim from the child.
        assert!(msg.contains("ModuleNotFoundError: No module named 'app'"), "{msg}");
        assert!(msg.contains("exit code 1"), "{msg}");
        // And the one sentence that explains why it happened on THIS install.
        assert!(msg.contains("no python_embeded and no venv"), "{msg}");

        // With a proper environment the guess would be wrong, so it is not made.
        let msg2 = comfy_startup_failure("C:\\ComfyUI\\venv\\Scripts\\python.exe", None, &tail, true);
        assert!(!msg2.contains("no python_embeded"), "{msg2}");
        assert!(msg2.contains("ModuleNotFoundError"), "{msg2}");
    }

    #[test]
    fn the_failure_message_keeps_the_last_lines_not_the_first() {
        // A crash prints its reason at the END. Keeping the head of a 400 line
        // ring buffer would show the banner and hide the error.
        let mut tail: Vec<String> = (0..50).map(|i| format!("line {i}")).collect();
        tail.push("RuntimeError: the actual reason".to_string());
        let msg = comfy_startup_failure("python", Some(1), &tail, true);
        assert!(msg.contains("RuntimeError: the actual reason"), "{msg}");
        assert!(!msg.contains("line 0"), "{msg}");
    }

    #[test]
    fn a_host_typed_with_its_port_keeps_both() {
        assert_eq!(split_host_port("192.168.1.50:8188"), ("192.168.1.50".into(), Some(8188)));
        assert_eq!(split_host_port("comfy.local:7860"), ("comfy.local".into(), Some(7860)));
    }

    #[test]
    fn a_plain_host_is_left_alone() {
        assert_eq!(split_host_port("192.168.1.50"), ("192.168.1.50".into(), None));
        assert_eq!(split_host_port("localhost"), ("localhost".into(), None));
        // Not a port: no digits, empty, or out of range.
        assert_eq!(split_host_port("host:abc"), ("host:abc".into(), None));
        assert_eq!(split_host_port("host:"), ("host:".into(), None));
        assert_eq!(split_host_port("host:0"), ("host:0".into(), None));
        assert_eq!(split_host_port("host:99999"), ("host:99999".into(), None));
        // IPv6 literals must survive untouched.
        assert_eq!(split_host_port("fd00::1"), ("fd00::1".into(), None));
    }

    // ── Bug J: needs_cpu_fallback platform short-circuit ─────────────────

    #[test]
    fn comfy_is_refused_on_macos_and_allowed_elsewhere() {
        // "Mac local media is MLX, never ComfyUI" is a product rule, and the
        // UI-side hiding of the buttons is not where a rule is kept — the
        // remote/mobile control surface calls these commands directly.
        if cfg!(target_os = "macos") {
            assert!(!comfy_supported_here(), "macOS must refuse a local ComfyUI");
            // The refusal has to say where the working surface is; a bare
            // "unsupported" leaves the user with nothing to do next.
            assert!(MACOS_COMFY_REFUSAL.contains("MLX"));
            assert!(MACOS_COMFY_REFUSAL.contains("Settings"));
        } else {
            assert!(comfy_supported_here(), "Windows/Linux keep ComfyUI");
        }
    }

    #[test]
    fn needs_cpu_fallback_is_false_on_macos() {
        // On macOS, PyTorch uses MPS and never calls cuda APIs that crash
        // the way Linux+no-NVIDIA does. The fallback must be a no-op there
        // so we don't downgrade real Mac users (M1/M2/etc) to CPU inference.
        if cfg!(target_os = "macos") {
            assert!(!needs_cpu_fallback(), "macOS must short-circuit to false");
        } else {
            // On non-macOS, the result depends on whether nvidia-smi is
            // installed + returns success. The function is total — it must
            // not panic in either branch. We just call it and assert it
            // returns a bool (compiler-enforced anyway).
            let _ = needs_cpu_fallback();
        }
    }

    #[test]
    fn needs_cpu_fallback_is_deterministic_for_repeat_calls() {
        // Two consecutive calls must agree — no time-based or random
        // behaviour smuggled in (Bug J's fix probes nvidia-smi each call,
        // so if nvidia-smi state doesn't change, the answer doesn't either).
        let a = needs_cpu_fallback();
        let b = needs_cpu_fallback();
        assert_eq!(a, b, "needs_cpu_fallback returned inconsistent results");
    }

    // ── Broken-env classifier fuer die Selbstheilung (GH #98) ────────────

    fn zeilen(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn joels_torch_import_death_reads_as_broken_env() {
        // 14.08.: kein ModuleNotFoundError im Tail, nur ein Traceback durch
        // site-packages\torch — genau der Fall, den nur die Frame-Regel faengt.
        let tail = zeilen(&[
            "[start] python main.py --port 8188",
            "Traceback (most recent call last):",
            r#"  File "C:\Users\joeln\AppData\Local\Python\pythoncore-3.12-64\Lib\site-packages\torch\_library\infer_schema.py", line 106, in infer_schema"#,
            "    error_fn(",
            "RuntimeError: infer_schema(func): Parameter dtype has unsupported type",
        ]);
        assert!(comfy_env_failure(&tail));
    }

    #[test]
    fn kryptoxides_shadowing_package_reads_as_broken_env() {
        let tail = zeilen(&[
            "Traceback (most recent call last):",
            r#"  File "I:\comfyui\main.py", line 1, in <module>"#,
            "    import comfy.options",
            "ModuleNotFoundError: No module named 'comfy.options'",
        ]);
        assert!(comfy_env_failure(&tail));
    }

    #[test]
    fn a_port_collision_is_not_an_env_failure() {
        // Ein venv-Neubau kann den Port nicht freimachen; die eigene Meldung
        // ist besser. Der Frame laeuft trotzdem durch site-packages (aiohttp),
        // deshalb braucht es den expliziten Ausschluss.
        let tail = zeilen(&[
            "Traceback (most recent call last):",
            r#"  File "C:\Python312\Lib\site-packages\aiohttp\web_runner.py", line 119, in start"#,
            "OSError: [Errno 10048] error while attempting to bind on address ('127.0.0.1', 8188): only one usage of each socket address",
        ]);
        assert!(!comfy_env_failure(&tail));
    }

    #[test]
    fn a_full_disk_and_a_clean_tail_are_not_env_failures() {
        let voll = zeilen(&[
            "Traceback (most recent call last):",
            r#"  File "C:\Python312\Lib\site-packages\torch\serialization.py", line 998"#,
            "OSError: [Errno 28] No space left on device",
        ]);
        assert!(!comfy_env_failure(&voll));
        let sauber = zeilen(&["[start] python main.py --port 8188", "Total VRAM 12288 MB"]);
        assert!(!comfy_env_failure(&sauber));
    }

    // ── AMD/ROCm ComfyUI GPU decision (rhodium92, 2026-07-01) ────────────

    #[test]
    fn comfy_gpu_mode_parse_maps_known_values_and_defaults_to_auto() {
        assert_eq!(ComfyGpuMode::parse("auto"), ComfyGpuMode::Auto);
        assert_eq!(ComfyGpuMode::parse("cpu"), ComfyGpuMode::ForceCpu);
        assert_eq!(ComfyGpuMode::parse("gpu"), ComfyGpuMode::ForceGpu);
        assert_eq!(ComfyGpuMode::parse("GPU"), ComfyGpuMode::ForceGpu);
        assert_eq!(ComfyGpuMode::parse("  Cpu "), ComfyGpuMode::ForceCpu);
        assert_eq!(ComfyGpuMode::parse("nonsense"), ComfyGpuMode::Auto);
        assert_eq!(ComfyGpuMode::parse(""), ComfyGpuMode::Auto);
    }

    #[test]
    fn decide_force_modes_ignore_baseline_and_probe() {
        // ForceCpu is always --cpu; ForceGpu is never --cpu, no matter what the
        // baseline check or the torch probe report.
        for &baseline in &[true, false] {
            for torch in [Some(true), Some(false), None] {
                assert!(
                    decide_comfy_cpu_flag(ComfyGpuMode::ForceCpu, baseline, torch),
                    "ForceCpu must always request --cpu"
                );
                assert!(
                    !decide_comfy_cpu_flag(ComfyGpuMode::ForceGpu, baseline, torch),
                    "ForceGpu must never request --cpu"
                );
            }
        }
    }

    #[test]
    fn decide_auto_nvidia_or_macos_never_uses_cpu() {
        // baseline_needs_cpu == false means NVIDIA present (or macOS MPS): the GPU
        // is already fine, so the torch probe is irrelevant and it's never --cpu.
        assert!(!decide_comfy_cpu_flag(ComfyGpuMode::Auto, false, None));
        assert!(!decide_comfy_cpu_flag(ComfyGpuMode::Auto, false, Some(false)));
        assert!(!decide_comfy_cpu_flag(ComfyGpuMode::Auto, false, Some(true)));
    }

    #[test]
    fn decide_auto_amd_rocm_or_zluda_torch_skips_cpu() {
        // No NVIDIA driver (baseline == true) but the comfy python's torch reports
        // a usable GPU (ROCm/ZLUDA) → run on the GPU, no --cpu. The rhodium92 fix.
        assert!(!decide_comfy_cpu_flag(ComfyGpuMode::Auto, true, Some(true)));
    }

    #[test]
    fn decide_auto_no_usable_gpu_falls_back_to_cpu() {
        // No NVIDIA and torch has no usable GPU (stock CUDA torch on an AMD box,
        // or a CPU-only install) → --cpu, exactly the pre-fix safe behaviour.
        assert!(decide_comfy_cpu_flag(ComfyGpuMode::Auto, true, Some(false)));
        // Probe failed / timed out → conservative --cpu (never risk the main.py
        // "Found no NVIDIA driver" crash loop).
        assert!(decide_comfy_cpu_flag(ComfyGpuMode::Auto, true, None));
    }

    #[test]
    fn probe_comfy_gpu_on_empty_python_is_definitive_false() {
        assert_eq!(probe_comfy_gpu(""), Some(false));
    }

    #[test]
    fn force_gpu_on_a_torch_without_a_gpu_says_why_before_the_crash() {
        let linux = force_gpu_warning(ComfyGpuMode::ForceGpu, Some(false), true, "linux")
            .expect("an AMD Linux box with CUDA wheels must be told");
        assert!(linux.contains("Torch not compiled with CUDA enabled"), "{linux}");
        assert!(linux.contains("ROCm"), "the Linux way out is a reinstall: {linux}");
        let win = force_gpu_warning(ComfyGpuMode::ForceGpu, Some(false), true, "windows")
            .expect("an AMD Windows box must be told too");
        assert!(win.contains("DirectML"), "{win}");
        // Never promise a reinstall that cannot exist: there are no ROCm
        // wheels for Windows, so the message must not send the user there.
        assert!(!win.contains("Reinstall the ComfyUI environment"), "{win}");
        let other = force_gpu_warning(ComfyGpuMode::ForceGpu, Some(false), false, "windows")
            .expect("a non-AMD box with a dead torch is still worth a word");
        assert!(!other.contains("AMD"), "{other}");
    }

    #[test]
    fn nothing_is_said_when_there_is_nothing_to_say() {
        // Negative controls: the note only belongs to Force GPU on a torch
        // that answered "no GPU". Everything else stays quiet.
        assert_eq!(force_gpu_warning(ComfyGpuMode::ForceGpu, Some(true), true, "linux"), None);
        assert_eq!(force_gpu_warning(ComfyGpuMode::ForceGpu, None, true, "linux"), None);
        assert_eq!(force_gpu_warning(ComfyGpuMode::Auto, Some(false), true, "linux"), None);
        assert_eq!(force_gpu_warning(ComfyGpuMode::ForceCpu, Some(false), true, "linux"), None);
    }
}

/// Cloud mode = cloud-only inference: release every LOCAL model backend so
/// nothing sits in RAM/VRAM while the app talks to the cloud (David 2026-07-11).
/// Best-effort per backend — one failing step never blocks the others. Local
/// mode reloads everything LAZILY on first use, so this is safe to run on every
/// switch into cloud and on launch-in-cloud. (LM Studio is offloaded separately
/// by the frontend via `lmstudio_unload_model("--all")`.)
/// `include_comfyui` = whether to also free ComfyUI's VRAM. Cloud switch passes
/// nothing (defaults true — release everything). A LOCAL render passes `false`:
/// it wants the chat LLMs out of VRAM to make room, but ComfyUI keeps its own
/// checkpoint cached across consecutive Create runs (freeing it here would force
/// a slow reload between every generate).
// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread.
// The State borrow cannot cross into the blocking pool, so the handle is
// re-resolved there from the AppHandle (same pattern as engine.rs/whisper.rs).
#[tauri::command]
pub async fn offload_local_models(app: tauri::AppHandle, include_comfyui: Option<bool>) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        offload_local_models_blocking(&state, include_comfyui)
    })
    .await
    .map_err(|e| format!("offload_local_models task: {e}"))?
}

pub(crate) fn offload_local_models_blocking(state: &AppState, include_comfyui: Option<bool>) -> Result<serde_json::Value, String> {
    let free_comfy = include_comfyui.unwrap_or(true);
    let mut freed: Vec<&str> = Vec::new();

    // 1) Whisper STT — the python server holds the model resident; stopping it
    //    frees ~360 MB. transcribe() lazily restarts it on the next local use.
    if let Ok(mut w) = state.whisper.lock() {
        if w.is_running() {
            w.stop();
            freed.push("whisper");
        }
    }

    // 2) Bundled llama.cpp chat + embeddings sidecars (managed GGUF in RAM).
    //    Both are graceful no-ops when not running, and lazy-start on next use.
    // Call the lifecycle helpers directly — the #[command] wrappers are async
    // now (they moved off the Tauri main thread) and this caller is sync.
    if crate::commands::engine::stop_engine_locked(&state) {
        freed.push("bundled-engine");
    }
    if crate::commands::engine::stop_embed_locked(&state) {
        freed.push("bundled-embed");
    }

    // 3) Ollama — keep `serve` up (cheap, idle) but evict every loaded model.
    if offload_ollama_loaded_models() {
        freed.push("ollama");
    }

    // 4) ComfyUI — free VRAM/RAM without killing the server, so the next local
    //    render just reloads the checkpoint (no slow process restart). Skipped
    //    when a local render is the caller (it keeps its own checkpoint cached).
    if free_comfy && free_comfyui_memory() {
        freed.push("comfyui");
    }

    println!("[Offload] released local model backends (comfyui={}): {:?}", free_comfy, freed);
    Ok(serde_json::json!({ "offloaded": freed }))
}

/// Evict every model Ollama currently holds in memory via `keep_alive: 0`,
/// leaving `ollama serve` running (idle serve is cheap). Best-effort.
pub(crate) fn offload_ollama_loaded_models() -> bool {
    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let ps = match client
        .get("http://localhost:11434/api/ps")
        .send()
        .ok()
        .and_then(|r| r.json::<serde_json::Value>().ok())
    {
        Some(v) => v,
        None => return false,
    };
    let models = match ps.get("models").and_then(|m| m.as_array()) {
        Some(a) => a,
        None => return false,
    };
    let mut any = false;
    for m in models {
        if let Some(name) = m
            .get("name")
            .or_else(|| m.get("model"))
            .and_then(|n| n.as_str())
        {
            let _ = client
                .post("http://localhost:11434/api/generate")
                .json(&serde_json::json!({ "model": name, "keep_alive": 0 }))
                .send();
            any = true;
        }
    }
    any
}

/// Ask ComfyUI to unload checkpoints and free memory, keeping the server up so
/// the next local render reloads on demand. Best-effort (default port 8188).
/// Also used by the character trainer — on a 12 GB card a cached video
/// checkpoint next door is the difference between training and CUDA OOM.
pub(crate) fn free_comfyui_memory() -> bool {
    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client
        .post("http://localhost:8188/free")
        .json(&serde_json::json!({ "unload_models": true, "free_memory": true }))
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

#[cfg(test)]
mod start_gate_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_GATE: Mutex<()> = Mutex::new(());

    /// The window that matters: two threads both pass a "nothing is running"
    /// check and both spawn. With the gate, the second one cannot enter until
    /// the first has finished storing its child.
    #[test]
    fn two_concurrent_starts_never_overlap() {
        static INSIDE: AtomicUsize = AtomicUsize::new(0);
        static MAX_SEEN: AtomicUsize = AtomicUsize::new(0);

        let threads: Vec<_> = (0..8)
            .map(|_| {
                std::thread::spawn(|| {
                    let _gate = start_gate(&TEST_GATE);
                    let now = INSIDE.fetch_add(1, Ordering::AcqRel) + 1;
                    MAX_SEEN.fetch_max(now, Ordering::AcqRel);
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    INSIDE.fetch_sub(1, Ordering::AcqRel);
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(MAX_SEEN.load(Ordering::Acquire), 1, "two starts ran at once");
    }

    /// A panic inside a start must not wedge every later start.
    #[test]
    fn a_poisoned_gate_still_opens() {
        static POISON_ME: Mutex<()> = Mutex::new(());
        let _ = std::thread::spawn(|| {
            let _gate = start_gate(&POISON_ME);
            panic!("start blew up");
        })
        .join();
        let _gate = start_gate(&POISON_ME); // would panic on a plain .unwrap()
    }
}

#[cfg(test)]
mod ollama_probe_tests {
    use super::*;

    /// Observed on macOS 2026-07-28: the "is Ollama already running?" check
    /// shelled out to `tasklist`, which does not exist outside Windows, so the
    /// check was skipped and a second server was spawned on every launch. The
    /// probe must answer on THIS platform, not just on Windows.
    #[test]
    fn the_probe_answers_without_shelling_out() {
        let started = std::time::Instant::now();
        let _ = ollama_port_open();
        assert!(
            started.elapsed() < std::time::Duration::from_millis(500),
            "probe took {:?} — is it spawning a process again?",
            started.elapsed()
        );
    }

    /// A listener on the port must be seen as "already running" on every
    /// platform. Binds a throwaway listener to prove the probe mechanism
    /// itself works here, without touching the real Ollama port.
    #[test]
    fn a_listening_socket_is_detected() {
        use std::net::{SocketAddr, TcpListener, TcpStream};
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr: SocketAddr = listener.local_addr().unwrap();
        assert!(
            TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)).is_ok(),
            "the probe cannot see a socket that is demonstrably listening",
        );
        drop(listener);
    }
}

/// Orphan safety: every long lived child the app spawns has to die with the
/// app, including the deaths that never reach `shutdown_subprocesses` (a hard
/// kill, Task Manager, a build script that clears the way for itself).
///
/// The evidence these tests were written from, Windows box 2026-08-29: the app
/// was terminated at 09:48:19, both ComfyUI processes went with it because
/// ComfyUI was in the kill-on-close job, and lu-llama-server survived holding
/// 3633 MiB of VRAM because the engine spawn was not.
#[cfg(test)]
mod orphan_safety_tests {
    use super::*;

    /// Source of the files that spawn a long lived child, read at compile
    /// time. A grep in a test is a blunt instrument, but it is the only guard
    /// available for a Windows kernel behaviour that cannot be exercised on
    /// this machine, and it fails loudly when a NEW spawn path forgets the
    /// call rather than after the next VRAM leak in the field.
    const ENGINE_RS: &str = include_str!("engine.rs");
    const WHISPER_RS: &str = include_str!("whisper.rs");
    const TRAINER_RS: &str = include_str!("trainer.rs");
    const PROCESS_RS: &str = include_str!("process.rs");

    fn ties(src: &str) -> usize {
        src.matches("tie_child_to_app_lifetime(").count()
            - src.matches("fn tie_child_to_app_lifetime(").count()
    }

    #[test]
    fn the_bundled_engine_and_the_embeddings_server_are_both_tied_to_the_app() {
        // Two spawns in engine.rs: the chat server and the embeddings server.
        // Neither was tied before 2.6.7, and the chat one is the orphan that
        // was measured holding 3633 MiB after the app was gone.
        assert!(
            ENGINE_RS.contains("tie_child_to_app_lifetime(child.id())"),
            "the bundled engine spawn must tie its child to the app lifetime"
        );
        assert_eq!(
            ties(ENGINE_RS),
            2,
            "engine.rs has two long lived spawns (chat + embeddings); both must be tied"
        );
    }

    /// process.rs up to this test module. The assertions below mention the
    /// call by name many times over, and counting those as call sites would
    /// make the guard meaningless.
    fn process_rs_production_code() -> &'static str {
        PROCESS_RS
            .split_once("mod orphan_safety_tests {")
            .map(|(head, _)| head)
            .expect("this module is part of process.rs")
    }

    #[test]
    fn the_other_long_lived_children_are_tied_too() {
        assert_eq!(ties(WHISPER_RS), 1, "the persistent whisper server must be tied");
        assert_eq!(ties(TRAINER_RS), 1, "the trainer must be tied");
        // Ollama is spawned twice: the command and the auto-start path.
        assert_eq!(
            ties(process_rs_production_code()),
            2,
            "both ollama spawns must be tied"
        );
    }

    #[test]
    fn comfyui_keeps_the_job_it_already_had() {
        // Negative control: the fix must not have moved ComfyUI off the
        // mechanism that demonstrably worked on 2026-08-29.
        assert_eq!(
            process_rs_production_code()
                .matches("assign_to_kill_on_close_job(&child)")
                .count(),
            2,
            "both ComfyUI spawns must stay on the kill-on-close job"
        );
    }

    #[test]
    fn tying_a_child_leaves_it_running_and_a_zero_pid_is_ignored() {
        // The call is a no-op off Windows and must never be a way to kill
        // something by accident. A pid of 0 means "no process" on both
        // families and must not be handed to the OS at all.
        tie_child_to_app_lifetime(0);

        #[cfg(not(target_os = "windows"))]
        {
            let mut child = std::process::Command::new("sleep")
                .arg("5")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn a sleeper");
            tie_child_to_app_lifetime(child.id());
            std::thread::sleep(std::time::Duration::from_millis(200));
            assert!(
                child.try_wait().expect("try_wait").is_none(),
                "tying a child must not disturb it"
            );
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    #[test]
    fn the_job_object_is_created_once_and_shared() {
        // The old code made a fresh job per child and leaked the handle every
        // time; the engine restarts on every model swap (30 restarts in eleven
        // minutes were logged on 2026-08-29), so that leaked 30 handles.
        assert_eq!(
            process_rs_production_code().matches("CreateJobObjectW(").count(),
            1,
            "there must be exactly one place that creates the job object"
        );
        assert!(
            PROCESS_RS.contains("static JOB: OnceLock<isize>"),
            "the job handle must be created once and reused"
        );
    }
}
