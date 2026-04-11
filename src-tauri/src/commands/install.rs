use std::fs;
use std::io::Read as IoRead;
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

    let python_bin = state.python_bin.clone();
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

        let gpu_info = if has_nvidia { "NVIDIA GPU detected - installing CUDA PyTorch" } else { "No NVIDIA GPU - installing CPU PyTorch" };
        println!("[Install] {}", gpu_info);
        update("installing", &format!("Step 2/3: {} (this may take several minutes)...", gpu_info));

        let torch_args = if has_nvidia {
            vec!["-m", "pip", "install", "torch", "torchvision", "torchaudio",
                 "--index-url", "https://download.pytorch.org/whl/cu121"]
        } else {
            vec!["-m", "pip", "install", "torch", "torchvision", "torchaudio"]
        };

        let mut pip = Command::new(&python_bin);
        pip.args(&torch_args).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        pip.creation_flags(CREATE_NO_WINDOW);
        match pip.output() {
            Ok(output) if output.status.success() => {
                update("installing", "PyTorch installed successfully.");
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let err = format!("PyTorch installation failed: {}", stderr.chars().take(200).collect::<String>());
                println!("[Install] {}", err);
                update("error", &err);
                return;
            }
            Err(e) => {
                let err = format!("Python not found ({}). Install Python 3.10+ first.", e);
                println!("[Install] {}", err);
                update("error", &err);
                return;
            }
        }

        // Step 3: Install ComfyUI requirements
        println!("[Install] Installing ComfyUI requirements...");
        update("installing", "Step 3/3: Installing ComfyUI dependencies...");

        let reqs = target_dir.join("requirements.txt");
        if reqs.exists() {
            let mut pip_req = Command::new(&python_bin);
            pip_req.args(["-m", "pip", "install", "-r"]).arg(&reqs)
                .stdout(Stdio::piped()).stderr(Stdio::piped());
            #[cfg(target_os = "windows")]
            pip_req.creation_flags(CREATE_NO_WINDOW);
            match pip_req.output() {
                Ok(output) if output.status.success() => {
                    update("installing", "Dependencies installed successfully.");
                }
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    println!("[Install] Requirements install warning: {}", &stderr[..stderr.len().min(200)]);
                    // Don't fail — some optional deps may fail but ComfyUI can still work
                    update("installing", "Some dependencies had warnings (non-critical).");
                }
                Err(_) => {
                    update("installing", "Could not install some dependencies (non-critical).");
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
                let python_bin = state.python_bin.clone();
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
