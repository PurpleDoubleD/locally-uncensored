use std::fs;
use std::io::{BufRead, BufReader, Read as IoRead};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::State;

use crate::state::{AppState, InstallState};

/// Windows: hide console windows for spawned processes
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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
fn diagnose_pip_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    let snippet: String = stderr.chars().take(400).collect();

    let hint = if lower.contains("ssl") {
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
fn pip_install_streaming_with_retry(
    args: &[&str],
    python_bin: &str,
    max_attempts: u32,
    install_state: &Arc<Mutex<InstallState>>,
) -> Result<(), String> {
    let mut delay_seconds = 10u64;
    let mut last_stderr = String::new();

    for attempt in 1..=max_attempts {
        if attempt > 1 {
            push_install_log(
                install_state,
                &format!(
                    "Transient network error — retry {}/{} after {}s wait...",
                    attempt, max_attempts, delay_seconds
                ),
            );
            std::thread::sleep(std::time::Duration::from_secs(delay_seconds));
            delay_seconds = (delay_seconds * 3).min(180);
        }

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

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stderr_capture: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));

        // Stream stdout to install logs
        let stdout_state = install_state.clone();
        let stdout_handle = std::thread::spawn(move || {
            if let Some(out) = stdout {
                let reader = BufReader::new(out);
                for line in reader.lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
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

        let exit_status = match child.wait() {
            Ok(s) => s,
            Err(e) => return Err(format!("pip wait failed: {}", e)),
        };
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();

        if exit_status.success() {
            return Ok(());
        }

        last_stderr = stderr_capture
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default();

        if !is_transient_pip_error(&last_stderr) {
            return Err(diagnose_pip_error(&last_stderr));
        }
    }

    Err(format!(
        "Exhausted {} retry attempts for transient network errors.\n\n{}",
        max_attempts,
        diagnose_pip_error(&last_stderr)
    ))
}

#[tauri::command]
pub fn install_comfyui(
    install_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let mut install = state.install_status.lock().unwrap();
    if install.status == "installing" {
        return Ok(serde_json::json!({"status": "already_installing"}));
    }

    install.status = "installing".to_string();
    install.logs.clear();
    install.logs.push("Starting ComfyUI installation...".to_string());
    drop(install);

    let target_dir = install_path
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("ComfyUI"));

    // Pre-flight: refuse to start ComfyUI install without a real Python.
    // The frontend is expected to call `install_python` first when this
    // returns the "no python" error — that flow shows a Python-install
    // progress card before re-firing `install_comfyui`. The ComfyUI carcass
    // bug (P14) was caused by skipping this check: pip got fed the Microsoft
    // Store stub `python.exe`, which exit-1'd, leaving a half-cloned
    // ComfyUI dir on disk that LU then mistakenly detected as "installed".
    let python_bin = state.python_bin.lock().unwrap().clone();
    if python_bin.is_empty() || !crate::python::is_real_python(&python_bin) {
        // Reset install state so the frontend's polling sees the error
        // immediately — without this the spawned thread below never runs and
        // the UI sits on "installing" forever.
        let mut install = state.install_status.lock().unwrap();
        install.status = "error".to_string();
        install.logs.push(
            "Python is not installed on this machine. \
             Install Python first (Settings → ComfyUI → Install Python, \
             or click 'Install Python' in the onboarding ComfyUI step), \
             then retry the ComfyUI install."
                .to_string(),
        );
        return Err(
            "no_python: Python must be installed before ComfyUI. Call install_python first."
                .to_string(),
        );
    }
    let install_status = state.install_status.clone();

    std::thread::spawn(move || {
        // Helper to update install status + logs
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = install_status.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        // Step 1: Git clone
        println!("[Install] Cloning ComfyUI to {:?}", target_dir);
        update("downloading", "Step 1/3: Downloading ComfyUI repository...");

        let mut cmd = Command::new("git");
        cmd.args(["clone", "https://github.com/comfyanonymous/ComfyUI.git"])
            .arg(&target_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let clone = cmd.output();

        match clone {
            Ok(output) if output.status.success() => {
                println!("[Install] Git clone successful");
                update("installing", "Repository cloned successfully.");
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                if stderr.contains("already exists") {
                    println!("[Install] ComfyUI directory already exists, updating...");
                    update("installing", "ComfyUI already exists, pulling latest...");
                    let mut pull = Command::new("git");
                    pull.args(["pull"]).current_dir(&target_dir)
                        .stdout(Stdio::piped()).stderr(Stdio::piped());
                    #[cfg(target_os = "windows")]
                    pull.creation_flags(CREATE_NO_WINDOW);
                    let _ = pull.output();
                } else {
                    let err = format!("Git clone failed: {}", stderr);
                    println!("[Install] {}", err);
                    update("error", &err);
                    return;
                }
            }
            Err(e) => {
                let err = format!("Git is not installed or not in PATH: {}", e);
                println!("[Install] {}", err);
                update("error", &err);
                return;
            }
        }

        // Step 2: Detect GPU and install PyTorch
        let mut nv = Command::new("nvidia-smi");
        nv.stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        nv.creation_flags(CREATE_NO_WINDOW);
        let has_nvidia = nv.output().map(|o| o.status.success()).unwrap_or(false);

        let gpu_info = if has_nvidia { "NVIDIA GPU detected — installing CUDA PyTorch" } else { "No NVIDIA GPU — installing CPU PyTorch" };
        println!("[Install] {}", gpu_info);
        update("installing", &format!("Step 2/3: {}", gpu_info));
        update(
            "installing",
            "Downloading PyTorch + Torchvision + Torchaudio (~2 GB total). \
             On a typical home connection this takes 10–15 minutes; on slower \
             links it can be longer. Live pip output below — if you see new \
             lines appearing, the install is making progress, not hung.",
        );

        let torch_args: Vec<&str> = if has_nvidia {
            vec![
                "-m", "pip", "install",
                "--progress-bar", "off",
                "--no-input",
                "torch", "torchvision", "torchaudio",
                "--index-url", "https://download.pytorch.org/whl/cu121",
            ]
        } else {
            vec![
                "-m", "pip", "install",
                "--progress-bar", "off",
                "--no-input",
                "torch", "torchvision", "torchaudio",
            ]
        };

        match pip_install_streaming_with_retry(&torch_args, &python_bin, 3, &install_status) {
            Ok(()) => {
                update("installing", "PyTorch installed successfully.");
            }
            Err(diagnosis) => {
                let err = format!("PyTorch installation failed.\n\n{}", diagnosis);
                println!("[Install] {}", err);
                update("error", &err);
                return;
            }
        }

        // Step 3: Install ComfyUI requirements
        println!("[Install] Installing ComfyUI requirements...");
        update("installing", "Step 3/3: Installing ComfyUI dependencies (live pip output below)...");

        let reqs = target_dir.join("requirements.txt");
        if reqs.exists() {
            let reqs_str = reqs.to_string_lossy().to_string();
            let req_args = vec![
                "-m", "pip", "install",
                "--progress-bar", "off",
                "--no-input",
                "-r", reqs_str.as_str(),
            ];
            match pip_install_streaming_with_retry(&req_args, &python_bin, 3, &install_status) {
                Ok(()) => {
                    update("installing", "Dependencies installed successfully.");
                }
                Err(diagnosis) => {
                    // Don't fail the whole install — some optional deps may fail
                    // but ComfyUI can still start and the user can fix them later.
                    println!("[Install] Requirements install warning: {}", diagnosis);
                    update("installing", "Some optional dependencies had warnings (non-critical, ComfyUI should still start).");
                }
            }
        }

        println!("[Install] ComfyUI installation complete");
        update("complete", "ComfyUI installed successfully!");
    });

    Ok(serde_json::json!({"status": "installing"}))
}

#[tauri::command]
pub fn install_comfyui_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.install_status.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
        "download_progress": install.download_progress,
        "download_total": install.download_total,
        "download_speed": install.download_speed,
    }))
}

// ── Shared helper: download a file with progress tracking ────────────────────

fn download_file_blocking(
    url: &str,
    dest: &PathBuf,
    install_state: &Arc<Mutex<InstallState>>,
) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("LocallyUncensored/2.3")
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(7200))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let response = client.get(url).send().map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let total = response.content_length().unwrap_or(0);
    if let Ok(mut s) = install_state.lock() {
        s.download_total = total;
        s.status = "downloading".to_string();
    }

    let mut file = fs::File::create(dest).map_err(|e| format!("Create file: {}", e))?;
    let mut reader = std::io::BufReader::new(response);
    let mut downloaded: u64 = 0;
    let start = Instant::now();
    let mut last_update = Instant::now();
    let mut buf = [0u8; 65536]; // 64KB chunks

    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Read error: {}", e))?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| format!("Write: {}", e))?;
        downloaded += n as u64;

        if last_update.elapsed().as_millis() > 500 {
            let elapsed = start.elapsed().as_secs_f64().max(0.001);
            let speed = downloaded as f64 / elapsed;
            if let Ok(mut s) = install_state.lock() {
                s.download_progress = downloaded;
                s.download_speed = speed;
            }
            last_update = Instant::now();
        }
    }

    // Final update
    if let Ok(mut s) = install_state.lock() {
        s.download_progress = downloaded;
        s.download_total = downloaded; // in case Content-Length was missing
        s.download_speed = 0.0;
    }

    Ok(())
}

// ── Ollama Install ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn install_ollama(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut install = state.ollama_install.lock().unwrap();
    if install.status == "downloading" || install.status == "installing" || install.status == "starting" {
        return Ok(serde_json::json!({"status": "already_installing"}));
    }

    install.status = "downloading".to_string();
    install.logs.clear();
    install.download_progress = 0;
    install.download_total = 0;
    install.download_speed = 0.0;
    install.logs.push("Downloading Ollama installer...".to_string());
    drop(install);

    let ollama_state = state.ollama_install.clone();

    std::thread::spawn(move || {
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = ollama_state.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        // Step 1: Download OllamaSetup.exe
        let temp_dir = std::env::temp_dir();
        let installer_path = temp_dir.join("OllamaSetup.exe");

        println!("[Ollama] Downloading OllamaSetup.exe...");

        match download_file_blocking(
            "https://ollama.com/download/OllamaSetup.exe",
            &installer_path,
            &ollama_state,
        ) {
            Ok(()) => {
                println!("[Ollama] Download complete");
                update("installing", "Download complete. Installing Ollama...");
            }
            Err(e) => {
                let err = format!("Download failed: {}", e);
                println!("[Ollama] {}", err);
                update("error", &err);
                return;
            }
        }

        // Step 2: Run silent install
        println!("[Ollama] Running silent installer...");
        let mut cmd = Command::new(&installer_path);
        cmd.arg("/S");
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        match cmd.output() {
            Ok(output) if output.status.success() => {
                println!("[Ollama] Installation successful");
                update("starting", "Ollama installed. Starting Ollama...");
            }
            Ok(output) => {
                let code = output.status.code().unwrap_or(-1);
                // NSIS installer returns 0 on success; non-zero might still be OK
                println!("[Ollama] Installer exited with code {}", code);
                update("starting", &format!("Installer finished (code {}). Starting Ollama...", code));
            }
            Err(e) => {
                let err = format!("Could not run installer: {}", e);
                println!("[Ollama] {}", err);
                update("error", &err);
                return;
            }
        }

        // Cleanup installer
        let _ = fs::remove_file(&installer_path);

        // Step 3: Start ollama serve
        println!("[Ollama] Starting ollama serve...");
        let mut serve = Command::new("ollama");
        serve.arg("serve").stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        serve.creation_flags(CREATE_NO_WINDOW);

        // Try to start — may already be running as service
        let _ = serve.spawn();

        // Step 4: Wait for Ollama to respond (up to 30 seconds)
        println!("[Ollama] Waiting for Ollama to be ready...");
        update("starting", "Waiting for Ollama to start...");

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap_or_default();

        let mut ready = false;
        for i in 0..15 {
            std::thread::sleep(std::time::Duration::from_secs(2));
            match client.get("http://localhost:11434/api/tags").send() {
                Ok(res) if res.status().is_success() => {
                    ready = true;
                    break;
                }
                _ => {
                    println!("[Ollama] Not ready yet, attempt {}/15", i + 1);
                }
            }
        }

        if ready {
            println!("[Ollama] Ready!");
            update("complete", "Ollama is ready!");
        } else {
            update("error", "Ollama installed but not responding. Try restarting the app.");
        }
    });

    Ok(serde_json::json!({"status": "downloading"}))
}

#[tauri::command]
pub fn install_ollama_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.ollama_install.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
        "download_progress": install.download_progress,
        "download_total": install.download_total,
        "download_speed": install.download_speed,
    }))
}

// ── LM Studio Install (Windows) ─────────────────────────────────────────────
//
// LM Studio doesn't run as a Windows service like Ollama — it's a desktop app
// whose embedded server is started via either the GUI ("Server" tab) or the
// `lms` CLI (`lms server start`). The install flow here:
//   1. Download the official LM Studio installer .exe
//   2. Silent install with /S (NSIS / electron-builder convention)
//   3. Run `lms bootstrap` to register the CLI on PATH
//   4. Start the server on port 1234 via `lms server start --cors`
//
// Step 4 is what makes this Plug & Play — without it the user has to manually
// open the app and toggle the server, which is exactly the "version one
// usability cliff" we're trying to remove. If lms isn't on PATH yet (e.g.
// install is too fresh), we look in `%USERPROFILE%/.lmstudio/bin/lms.exe`
// directly.
//
// The hard-coded URL points to a known-stable release. LM Studio's installer
// host doesn't expose a /latest redirect — every version is its own URL — so
// the alternative would be to bake in a remote-version-check, which adds an
// extra failure mode for offline users. A stale URL just means the user gets
// a slightly older LM Studio; functionally fine.
const LMSTUDIO_INSTALLER_URL: &str =
    "https://installers.lmstudio.ai/win32/x64/0.3.16-6/LM-Studio-0.3.16-6-x64.exe";
const LMSTUDIO_DEFAULT_PORT: u16 = 1234;

fn lmstudio_lms_path() -> Option<PathBuf> {
    // Post-bootstrap: `lms bootstrap` materialises the launcher here and adds
    // the same path to PATH. Cheapest check first.
    let direct = dirs::home_dir().map(|h| h.join(".lmstudio").join("bin").join("lms.exe"));
    if let Some(ref p) = direct {
        if p.exists() {
            return direct;
        }
    }

    // Pre-bootstrap: on a fresh install, lms.exe ships inside the GUI app's
    // resources dir before `lms bootstrap` ever runs. Calling this binary
    // directly is how we *do* the bootstrap on a brand-new box — without it
    // the user has to open LM Studio once from the Start menu just to seed
    // the CLI, which is exactly the noob-cliff this sweep is removing.
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        let pre_bootstrap = PathBuf::from(la)
            .join("Programs")
            .join("LM Studio")
            .join("resources")
            .join("app")
            .join(".webpack")
            .join("lms.exe");
        if pre_bootstrap.exists() {
            return Some(pre_bootstrap);
        }
    }

    // Last resort: PATH lookup. Catches non-standard installs (Chocolatey,
    // user-relocated install dir, etc.).
    if let Ok(out) = Command::new("where").arg("lms").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = s.lines().next() {
                let p = PathBuf::from(line.trim());
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }

    None
}

/// Path to the LM Studio GUI executable on Windows. We only need to launch
/// this in the rare case where `lms bootstrap` from the pre-bootstrap binary
/// reports success but `~/.lmstudio/` is still missing — some installs
/// require a one-time GUI launch to populate user-data dirs before
/// `lms bootstrap` will register the CLI on PATH.
fn lmstudio_gui_exe() -> Option<PathBuf> {
    let la = std::env::var("LOCALAPPDATA").ok()?;
    let p = PathBuf::from(la)
        .join("Programs")
        .join("LM Studio")
        .join("LM Studio.exe");
    if p.exists() { Some(p) } else { None }
}

fn lmstudio_server_running() -> bool {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(800))
        .build();
    if let Ok(c) = client {
        return c
            .get(format!("http://localhost:{}/v1/models", LMSTUDIO_DEFAULT_PORT))
            .send()
            .map(|r| r.status().is_success() || r.status() == 401)
            .unwrap_or(false);
    }
    false
}

#[tauri::command]
pub fn install_lmstudio(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut install = state.lmstudio_install.lock().unwrap();
    if install.status == "downloading"
        || install.status == "installing"
        || install.status == "starting"
    {
        return Ok(serde_json::json!({"status": "already_installing"}));
    }

    install.status = "downloading".to_string();
    install.logs.clear();
    install.download_progress = 0;
    install.download_total = 0;
    install.download_speed = 0.0;
    install
        .logs
        .push("Downloading LM Studio installer...".to_string());
    drop(install);

    let lms_state = state.lmstudio_install.clone();

    std::thread::spawn(move || {
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = lms_state.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        // Pre-check: if LM Studio is already installed (an `lms.exe` is
        // findable in any of the locations `lmstudio_lms_path()` knows about)
        // we skip the ~570 MB download entirely. Re-installing on a box where
        // it's already there was the previous behaviour and made the
        // "LM Studio detected but server offline" Plug-and-Play scenario
        // turn into a 5-minute no-op download. The bootstrap + server-start
        // steps below are idempotent, so the same code path now serves both
        // first-install and offline-reactivation users.
        let already_installed = lmstudio_lms_path().is_some();
        if already_installed && lmstudio_server_running() {
            update(
                "complete",
                "LM Studio is already installed and the server is up on localhost:1234.",
            );
            return;
        }

        if already_installed {
            update(
                "starting",
                "LM Studio is already installed — skipping download. Bootstrapping CLI and starting server…",
            );
        } else {
            let temp_dir = std::env::temp_dir();
            let installer_path = temp_dir.join("LMStudioSetup.exe");

            println!("[LMStudio] Downloading {}", LMSTUDIO_INSTALLER_URL);
            if let Err(e) =
                download_file_blocking(LMSTUDIO_INSTALLER_URL, &installer_path, &lms_state)
            {
                let err = format!(
                    "Download failed: {}. If the network is fine, the installer URL may have rotated — fall back to https://lmstudio.ai/download in your browser.",
                    e
                );
                println!("[LMStudio] {}", err);
                update("error", &err);
                return;
            }

            update(
                "installing",
                "Download complete. Running silent installer (this can take a minute)...",
            );

            // electron-builder NSIS supports /S for silent install. Ignore exit
            // code: real failures surface via the absence of lms.exe afterwards.
            let mut cmd = Command::new(&installer_path);
            cmd.arg("/S");
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            match cmd.output() {
                Ok(_) => println!("[LMStudio] Installer finished"),
                Err(e) => {
                    let err = format!("Could not run installer: {}", e);
                    println!("[LMStudio] {}", err);
                    update("error", &err);
                    return;
                }
            }

            let _ = fs::remove_file(&installer_path);
        }

        // Bootstrap the lms CLI. We do this in two passes:
        //   (1) Run `lms bootstrap` from whatever path `lmstudio_lms_path()`
        //       resolves — on a fresh install that's the pre-bootstrap binary
        //       inside `resources/app/.webpack/lms.exe`. This alone is enough
        //       on most boxes.
        //   (2) Verify that ~/.lmstudio/bin/lms.exe now exists. If not, some
        //       LM Studio builds require the GUI to run once to populate
        //       ~/.lmstudio/ before the bootstrap registers a launcher there.
        //       In that case we briefly launch the GUI, wait for ~/.lmstudio/
        //       to appear, retry bootstrap, then move on. The user sees the
        //       GUI flash up — not ideal, but strictly better than the old
        //       "Open LM Studio once from the Start menu" error dialog and a
        //       failed install.
        update("starting", "Bootstrapping `lms` CLI...");
        let initial_lms = lmstudio_lms_path();
        match &initial_lms {
            Some(p) => {
                let mut bs = Command::new(p);
                bs.arg("bootstrap");
                #[cfg(target_os = "windows")]
                bs.creation_flags(CREATE_NO_WINDOW);
                let _ = bs.output();
            }
            None => {
                update(
                    "error",
                    "LM Studio installed but `lms.exe` not found in any expected location. \
                     The installer may have failed silently. Try installing LM Studio manually \
                     from https://lmstudio.ai/download and then click Re-Scan.",
                );
                return;
            }
        }

        // Did pass 1 produce ~/.lmstudio/bin/lms.exe?  If yes, skip the GUI
        // dance entirely. If no, fall back to launching the GUI so it seeds
        // its user-data dir, then retry bootstrap.
        let post_bootstrap_path = dirs::home_dir()
            .map(|h| h.join(".lmstudio").join("bin").join("lms.exe"));
        let needs_gui_seed = post_bootstrap_path
            .as_ref()
            .map(|p| !p.exists())
            .unwrap_or(true);

        if needs_gui_seed {
            update(
                "starting",
                "Launching LM Studio briefly to finalise CLI setup (you may see the window flash)...",
            );
            if let Some(gui) = lmstudio_gui_exe() {
                let mut g = Command::new(&gui);
                #[cfg(target_os = "windows")]
                g.creation_flags(CREATE_NO_WINDOW);
                let _ = g.spawn();
            }

            // Wait up to 30 s for ~/.lmstudio/ to appear. The first GUI launch
            // typically writes this within 3–8 s, but on a slow VM 30 s is a
            // safer ceiling than failing the install.
            let lmstudio_dir = dirs::home_dir().map(|h| h.join(".lmstudio"));
            for _ in 0..30 {
                std::thread::sleep(std::time::Duration::from_secs(1));
                if let Some(d) = &lmstudio_dir {
                    if d.exists() {
                        break;
                    }
                }
            }

            // Retry bootstrap from the (now possibly different) lms.exe.
            // After GUI launch the .lmstudio dir might already contain a
            // launcher; if not, the pre-bootstrap path is still valid.
            if let Some(p) = lmstudio_lms_path() {
                let mut bs = Command::new(&p);
                bs.arg("bootstrap");
                #[cfg(target_os = "windows")]
                bs.creation_flags(CREATE_NO_WINDOW);
                let _ = bs.output();
            }
        }

        // Start the embedded server. `lms server start` is non-blocking — it
        // detaches a background httpd. --cors so LU's web view (which is on a
        // tauri:// origin) isn't blocked by the SOP. Port matches the
        // provider-store default of 1234 so user config Just Works.
        // Re-resolve the path because the bootstrap dance above may have
        // promoted us from the pre-bootstrap path to ~/.lmstudio/bin/lms.exe.
        update("starting", "Starting LM Studio server on port 1234...");
        if let Some(p) = lmstudio_lms_path() {
            let mut srv = Command::new(&p);
            srv.args(["server", "start", "--cors", "--port"])
                .arg(LMSTUDIO_DEFAULT_PORT.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(target_os = "windows")]
            srv.creation_flags(CREATE_NO_WINDOW);
            let _ = srv.spawn();
        }

        // Wait for the server to respond. LM Studio's server typically takes
        // ~3-5 s to bind in a fresh install (it loads its model index first).
        update("starting", "Waiting for LM Studio server...");
        let mut ready = false;
        for i in 0..15 {
            std::thread::sleep(std::time::Duration::from_secs(2));
            if lmstudio_server_running() {
                ready = true;
                break;
            }
            println!("[LMStudio] Server not ready, attempt {}/15", i + 1);
        }

        if ready {
            update("complete", "LM Studio server is up on localhost:1234.");
        } else {
            update(
                "error",
                "LM Studio installed but the server didn't come up. Open LM Studio from the Start menu and toggle the Server tab on, then click Re-Scan.",
            );
        }
    });

    Ok(serde_json::json!({"status": "downloading"}))
}

#[tauri::command]
pub fn install_lmstudio_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.lmstudio_install.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
        "download_progress": install.download_progress,
        "download_total": install.download_total,
        "download_speed": install.download_speed,
    }))
}

/// Best-effort: spawn `lms server start` so we don't make the user open the
/// LM Studio GUI just to flip the Server toggle. Idempotent — quick early-exit
/// if the server is already responding.
#[tauri::command]
pub fn start_lmstudio_server() -> Result<serde_json::Value, String> {
    if lmstudio_server_running() {
        return Ok(serde_json::json!({"status": "already_running"}));
    }
    match lmstudio_lms_path() {
        Some(p) => {
            let mut srv = Command::new(&p);
            srv.args(["server", "start", "--cors", "--port"])
                .arg(LMSTUDIO_DEFAULT_PORT.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(target_os = "windows")]
            srv.creation_flags(CREATE_NO_WINDOW);
            srv.spawn()
                .map_err(|e| format!("spawn lms: {}", e))?;
            Ok(serde_json::json!({"status": "starting"}))
        }
        None => Err(
            "LM Studio is not installed (no lms.exe found). Use Settings → Install LM Studio first."
                .to_string(),
        ),
    }
}

#[tauri::command]
pub fn lmstudio_server_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "running": lmstudio_server_running(),
        "port": LMSTUDIO_DEFAULT_PORT,
        "lms_present": lmstudio_lms_path().is_some(),
    }))
}

// ── Python Auto-Install (P14: Plug-and-Play, blocking pre-req for ComfyUI) ──
//
// On a fresh Windows box `python.exe` is the Microsoft Store stub at
// `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe` — it prints "Python was
// not found, run without arguments to install from the Microsoft Store" and
// exits 1. That kills `pip install torch ...` 200 ms in, leaves a half-cloned
// ComfyUI dir on disk, and the user sees "ComfyUI not responding". The
// only Plug-and-Play fix for newbies is to install Python ourselves; this is
// what `install_python` does. Same shape as `install_ollama` /
// `install_lmstudio`: kick off a background thread, surface status via a
// shared `InstallState`, and re-resolve `python_bin` once it finishes so
// subsequent `install_comfyui` calls find it without an app restart.

#[tauri::command]
pub fn install_python(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // If Python is already there, short-circuit so the UI can skip the
    // install card and go straight to ComfyUI. is_real_python rejects
    // the empty sentinel and WindowsApps stub paths.
    {
        let current = state.python_bin.lock().unwrap().clone();
        if crate::python::is_real_python(&current) {
            return Ok(serde_json::json!({"status": "already_installed", "path": current}));
        }
    }

    let mut install = state.python_install.lock().unwrap();
    if install.status == "downloading"
        || install.status == "installing"
        || install.status == "starting"
    {
        return Ok(serde_json::json!({"status": "already_installing"}));
    }

    install.status = "installing".to_string();
    install.logs.clear();
    install.download_progress = 0;
    install.download_total = 0;
    install.download_speed = 0.0;
    install
        .logs
        .push("Installing Python 3.12 via winget (~30 MB)…".to_string());
    drop(install);

    let py_state = state.python_install.clone();
    let py_bin_slot = state.python_bin.clone();

    std::thread::spawn(move || {
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = py_state.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        // Stream-friendly winget invocation. `--silent --accept-*-agreements`
        // drops the EULA prompts; without them winget will sit and wait for
        // user input forever inside our background thread. Python.Python.3.12
        // is the canonical winget id for the python.org installer (matches
        // `winget search python` top result).
        update("installing", "Running: winget install Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements");

        let mut cmd = Command::new("winget");
        cmd.args([
            "install",
            "Python.Python.3.12",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--scope",
            "user",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                update(
                    "error",
                    &format!(
                        "Could not run winget: {}. winget ships with Windows 10/11 — \
                         if it's missing, run 'Get App Installer' from the Microsoft \
                         Store (free) and retry.",
                        e
                    ),
                );
                return;
            }
        };

        // Stream stdout + stderr line-by-line so the UI's log card animates
        // as winget extracts and installs (otherwise it freezes for 1–2 min).
        let mut child = child;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdout_state = py_state.clone();
        let stdout_handle = std::thread::spawn(move || {
            if let Some(out) = stdout {
                let reader = BufReader::new(out);
                for line in reader.lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        if let Ok(mut s) = stdout_state.lock() {
                            s.logs.push(trimmed.to_string());
                        }
                    }
                }
            }
        });
        let stderr_state = py_state.clone();
        let stderr_handle = std::thread::spawn(move || {
            if let Some(err) = stderr {
                let reader = BufReader::new(err);
                for line in reader.lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        if let Ok(mut s) = stderr_state.lock() {
                            s.logs.push(trimmed.to_string());
                        }
                    }
                }
            }
        });

        let exit_status = match child.wait() {
            Ok(s) => s,
            Err(e) => {
                update("error", &format!("winget wait failed: {}", e));
                return;
            }
        };
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();

        if !exit_status.success() {
            // winget exit codes are HRESULT-shaped; -1978335189 (0x8A150011)
            // means "no upgrade applicable" which is fine if Python is
            // already present. Anything else is a real failure.
            let code = exit_status.code().unwrap_or(-1);
            // Re-resolve regardless: Python may already be on the box from
            // a previous install attempt that the original where-scan
            // missed (e.g. Add-to-PATH was unchecked).
            let resolved = crate::python::get_python_bin();
            if crate::python::is_real_python(&resolved) {
                if let Ok(mut slot) = py_bin_slot.lock() {
                    *slot = resolved.clone();
                }
                update(
                    "complete",
                    &format!("Python ready (winget exit {} ignored, Python detected at {})", code, resolved),
                );
                return;
            }
            update(
                "error",
                &format!(
                    "winget exited with code {}. Python was not detected after \
                     install. Try installing manually from python.org with the \
                     'Add Python to PATH' checkbox on, then return here and \
                     click Re-Scan.",
                    code
                ),
            );
            return;
        }

        update("starting", "winget finished. Re-resolving Python…");

        // Give the freshly installed Python a moment to settle (winget can
        // signal completion before the file is fully linked into PATH on
        // some boxes), then re-resolve and persist.
        for attempt in 0..15 {
            std::thread::sleep(std::time::Duration::from_secs(1));
            let resolved = crate::python::get_python_bin();
            if crate::python::is_real_python(&resolved) {
                if let Ok(mut slot) = py_bin_slot.lock() {
                    *slot = resolved.clone();
                }
                update(
                    "complete",
                    &format!("Python ready at {}", resolved),
                );
                return;
            }
            println!("[Python] post-install resolve attempt {}/15 — not yet on PATH", attempt + 1);
        }

        update(
            "error",
            "winget reported success but Python is still not on PATH. \
             Restart Locally Uncensored — sometimes Windows needs the new PATH \
             to take effect. If it still doesn't show up, install manually \
             from python.org with 'Add Python to PATH' on.",
        );
    });

    Ok(serde_json::json!({"status": "installing"}))
}

#[tauri::command]
pub fn install_python_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.python_install.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
        "download_progress": install.download_progress,
        "download_total": install.download_total,
        "download_speed": install.download_speed,
    }))
}

/// Cheap synchronous probe: is there a real Python on the box?  The frontend
/// calls this before kicking off `install_comfyui` so it can decide whether
/// to show the Python install step first. Returns the resolved path on
/// success so the UI can display it ("Found Python at C:\\…").
#[tauri::command]
pub fn python_check(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let current = state.python_bin.lock().unwrap().clone();
    if crate::python::is_real_python(&current) {
        return Ok(serde_json::json!({"available": true, "path": current}));
    }

    // The slot may have been empty at startup (fresh box) and Python may
    // have been installed since (e.g. via this same install_python flow on
    // another launch). Re-resolve as a refresh.
    let resolved = crate::python::get_python_bin();
    if crate::python::is_real_python(&resolved) {
        if let Ok(mut slot) = state.python_bin.lock() {
            *slot = resolved.clone();
        }
        Ok(serde_json::json!({"available": true, "path": resolved}))
    } else {
        Ok(serde_json::json!({"available": false, "path": null}))
    }
}

// ──────────────────────────────────────────────────────────────────────────────

#[allow(non_snake_case)]
#[tauri::command]
pub fn install_custom_node(
    state: State<'_, AppState>,
    repoUrl: String,
    nodeName: String,
) -> Result<serde_json::Value, String> {
    let repo_url = repoUrl;
    let node_name = nodeName;
    // Find ComfyUI path from state
    let comfy_path = {
        let path = state.comfy_path.lock().unwrap();
        path.clone()
    };

    let comfy_dir = match comfy_path {
        Some(p) => PathBuf::from(p),
        None => {
            // Try to find it
            match crate::commands::process::find_comfyui_path() {
                Some(p) => PathBuf::from(p),
                None => return Err("ComfyUI not found. Install ComfyUI first.".to_string()),
            }
        }
    };

    let custom_nodes_dir = comfy_dir.join("custom_nodes");
    let target_dir = custom_nodes_dir.join(&node_name);

    // Create custom_nodes dir if it doesn't exist
    if !custom_nodes_dir.exists() {
        fs::create_dir_all(&custom_nodes_dir)
            .map_err(|e| format!("Failed to create custom_nodes directory: {}", e))?;
    }

    if target_dir.exists() {
        // Already exists — git pull to update
        println!("[Install] Custom node {} already exists, updating...", node_name);
        let mut cmd = Command::new("git");
        cmd.args(["pull"]).current_dir(&target_dir)
            .stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = cmd.output()
            .map_err(|e| format!("Git pull failed: {}", e))?;

        let status = if output.status.success() { "updated" } else { "update_failed" };
        Ok(serde_json::json!({
            "status": status,
            "path": target_dir.to_string_lossy(),
        }))
    } else {
        // Clone the repo
        println!("[Install] Cloning custom node {} from {}", node_name, repo_url);
        let mut cmd = Command::new("git");
        cmd.args(["clone", &repo_url]).arg(&target_dir)
            .stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = cmd.output()
            .map_err(|e| format!("Git clone failed: {}", e))?;

        if output.status.success() {
            // Install requirements.txt if it exists
            let reqs = target_dir.join("requirements.txt");
            if reqs.exists() {
                let python_bin = state.python_bin.lock().unwrap().clone();
                println!("[Install] Installing requirements for {}...", node_name);
                let mut pip = Command::new(&python_bin);
                pip.args(["-m", "pip", "install", "-r"]).arg(&reqs)
                    .stdout(Stdio::piped()).stderr(Stdio::piped());
                #[cfg(target_os = "windows")]
                pip.creation_flags(CREATE_NO_WINDOW);
                let _ = pip.output();
            }

            Ok(serde_json::json!({
                "status": "installed",
                "path": target_dir.to_string_lossy(),
            }))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Failed to clone {}: {}", node_name, stderr))
        }
    }
}

// ── tests (issue #32: PyTorch / ComfyUI install reliability) ────────────────

#[cfg(test)]
mod tests {
    use super::*;

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
}
