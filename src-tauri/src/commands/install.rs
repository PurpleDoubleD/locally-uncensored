use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use tauri::State;

use crate::state::AppState;

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
        let clone = Command::new("git")
            .args(["clone", "https://github.com/comfyanonymous/ComfyUI.git"])
            .arg(&target_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output();

        match clone {
            Ok(output) if output.status.success() => {
                println!("[Install] Git clone successful");
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                // Directory might already exist
                if stderr.contains("already exists") {
                    println!("[Install] ComfyUI directory already exists, updating...");
                    let _ = Command::new("git")
                        .args(["pull"])
                        .current_dir(&target_dir)
                        .output();
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
        let has_nvidia = Command::new("nvidia-smi")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        println!("[Install] GPU detected: {}", if has_nvidia { "NVIDIA CUDA" } else { "CPU only" });

        let torch_args = if has_nvidia {
            vec!["-m", "pip", "install", "torch", "torchvision", "torchaudio",
                 "--index-url", "https://download.pytorch.org/whl/cu121"]
        } else {
            vec!["-m", "pip", "install", "torch", "torchvision", "torchaudio"]
        };

        println!("[Install] Installing PyTorch...");
        let _ = Command::new(&python_bin)
            .args(&torch_args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output();

        // Step 3: Install ComfyUI requirements
        println!("[Install] Installing ComfyUI requirements...");
        let reqs = target_dir.join("requirements.txt");
        if reqs.exists() {
            let _ = Command::new(&python_bin)
                .args(["-m", "pip", "install", "-r"])
                .arg(&reqs)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output();
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

#[tauri::command]
pub fn install_custom_node(
    state: State<'_, AppState>,
    repo_url: String,
    node_name: String,
) -> Result<serde_json::Value, String> {
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
        let output = Command::new("git")
            .args(["pull"])
            .current_dir(&target_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("Git pull failed: {}", e))?;

        let status = if output.status.success() { "updated" } else { "update_failed" };
        Ok(serde_json::json!({
            "status": status,
            "path": target_dir.to_string_lossy(),
        }))
    } else {
        // Clone the repo
        println!("[Install] Cloning custom node {} from {}", node_name, repo_url);
        let output = Command::new("git")
            .args(["clone", &repo_url])
            .arg(&target_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("Git clone failed: {}", e))?;

        if output.status.success() {
            // Install requirements.txt if it exists
            let reqs = target_dir.join("requirements.txt");
            if reqs.exists() {
                let python_bin = state.python_bin.clone();
                println!("[Install] Installing requirements for {}...", node_name);
                let _ = Command::new(&python_bin)
                    .args(["-m", "pip", "install", "-r"])
                    .arg(&reqs)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .output();
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
