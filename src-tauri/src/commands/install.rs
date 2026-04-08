use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::State;

use crate::state::AppState;

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

    std::thread::spawn(move || {
        // Step 1: Git clone
        println!("[Install] Cloning ComfyUI to {:?}", target_dir);
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
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                // Directory might already exist
                if stderr.contains("already exists") {
                    println!("[Install] ComfyUI directory already exists, updating...");
                    let mut pull = Command::new("git");
                    pull.args(["pull"]).current_dir(&target_dir)
                        .stdout(Stdio::piped()).stderr(Stdio::piped());
                    #[cfg(target_os = "windows")]
                    pull.creation_flags(CREATE_NO_WINDOW);
                    let _ = pull.output();
                } else {
                    println!("[Install] Git clone failed: {}", stderr);
                    return;
                }
            }
            Err(e) => {
                println!("[Install] Git not available: {}", e);
                return;
            }
        }

        // Step 2: Detect GPU and install PyTorch
        let mut nv = Command::new("nvidia-smi");
        nv.stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        nv.creation_flags(CREATE_NO_WINDOW);
        let has_nvidia = nv.output().map(|o| o.status.success()).unwrap_or(false);

        println!("[Install] GPU detected: {}", if has_nvidia { "NVIDIA CUDA" } else { "CPU only" });

        let torch_args = if has_nvidia {
            vec!["-m", "pip", "install", "torch", "torchvision", "torchaudio",
                 "--index-url", "https://download.pytorch.org/whl/cu121"]
        } else {
            vec!["-m", "pip", "install", "torch", "torchvision", "torchaudio"]
        };

        println!("[Install] Installing PyTorch...");
        let mut pip = Command::new(&python_bin);
        pip.args(&torch_args).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        pip.creation_flags(CREATE_NO_WINDOW);
        let _ = pip.output();

        // Step 3: Install ComfyUI requirements
        println!("[Install] Installing ComfyUI requirements...");
        let reqs = target_dir.join("requirements.txt");
        if reqs.exists() {
            let mut pip_req = Command::new(&python_bin);
            pip_req.args(["-m", "pip", "install", "-r"]).arg(&reqs)
                .stdout(Stdio::piped()).stderr(Stdio::piped());
            #[cfg(target_os = "windows")]
            pip_req.creation_flags(CREATE_NO_WINDOW);
            let _ = pip_req.output();
        }

        println!("[Install] ComfyUI installation complete");
    });

    Ok(serde_json::json!({"status": "installing"}))
}

#[tauri::command]
pub fn install_comfyui_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.install_status.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
    }))
}

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
