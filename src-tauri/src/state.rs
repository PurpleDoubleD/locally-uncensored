use std::collections::HashMap;
use std::process::Child;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;

use crate::commands::whisper::WhisperServer;
use crate::commands::remote::RemoteServer;
use crate::python::get_python_bin;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct DownloadProgress {
    pub progress: u64,
    pub total: u64,
    pub speed: f64,
    pub filename: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct InstallState {
    pub status: String,
    pub logs: Vec<String>,
    pub download_progress: u64,
    pub download_total: u64,
    pub download_speed: f64,
}

impl Default for InstallState {
    fn default() -> Self {
        Self {
            status: "idle".to_string(),
            logs: Vec::new(),
            download_progress: 0,
            download_total: 0,
            download_speed: 0.0,
        }
    }
}

/// Read persisted ComfyUI port + host from %APPDATA%/locally-uncensored/config.json.
/// Returns (port, host) with sensible defaults (8188, "localhost") on any error.
/// Called at startup so user-configured values survive app restarts.
pub(crate) fn load_comfy_config_values() -> (u16, String) {
    let mut port = 8188u16;
    let mut host = "localhost".to_string();

    if let Some(config_dir) = dirs::config_dir() {
        let config_file = config_dir.join("locally-uncensored").join("config.json");
        if let Ok(raw) = std::fs::read_to_string(&config_file) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(p) = v.get("comfyui_port").and_then(|x| x.as_u64()) {
                    if p > 0 && p < 65536 {
                        port = p as u16;
                    }
                }
                if let Some(h) = v.get("comfyui_host").and_then(|x| x.as_str()) {
                    let trimmed = h.trim();
                    if !trimmed.is_empty() {
                        host = trimmed.to_string();
                    }
                }
            }
        }
    }

    (port, host)
}

pub struct AppState {
    pub comfy_process: Mutex<Option<Child>>,
    pub comfy_path: Mutex<Option<String>>,
    pub comfy_port: Mutex<u16>,
    /// Configurable ComfyUI host. Default "localhost". Setting this to a
    /// remote hostname/IP lets users point LU at a ComfyUI running on
    /// another machine (homelab, Docker, LAN). Persisted in config.json.
    pub comfy_host: Mutex<String>,
    pub whisper: Arc<Mutex<WhisperServer>>,
    pub downloads: Arc<Mutex<HashMap<String, DownloadProgress>>>,
    pub download_tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
    pub pull_tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
    pub install_status: Arc<Mutex<InstallState>>,
    pub ollama_install: Arc<Mutex<InstallState>>,
    pub searxng_install: Mutex<InstallState>,
    pub searxng_available: AtomicBool,
    pub python_bin: String,
    // Claude Code
    pub claude_code_process: Mutex<Option<Child>>,
    pub claude_code_install: Arc<Mutex<InstallState>>,
    // Remote Access
    pub remote: Mutex<RemoteServer>,
}

impl AppState {
    pub fn new() -> Self {
        let python_bin = get_python_bin();
        println!("[Python] Resolved: {}", python_bin);

        // Load persisted ComfyUI port+host from config.json if available.
        // Fixes a pre-existing bug where `set_comfyui_port` wrote to disk but
        // startup never read it back. Same loader now handles the new host field.
        let (initial_port, initial_host) = load_comfy_config_values();
        if initial_port != 8188 {
            println!("[ComfyUI] Loaded persisted port: {}", initial_port);
        }
        if initial_host != "localhost" {
            println!("[ComfyUI] Loaded persisted host: {}", initial_host);
        }

        Self {
            comfy_process: Mutex::new(None),
            comfy_path: Mutex::new(None),
            comfy_port: Mutex::new(initial_port),
            comfy_host: Mutex::new(initial_host),
            whisper: Arc::new(Mutex::new(WhisperServer::new())),
            downloads: Arc::new(Mutex::new(HashMap::new())),
            download_tokens: Arc::new(Mutex::new(HashMap::new())),
            pull_tokens: Arc::new(Mutex::new(HashMap::new())),
            install_status: Arc::new(Mutex::new(InstallState::default())),
            ollama_install: Arc::new(Mutex::new(InstallState::default())),
            searxng_install: Mutex::new(InstallState::default()),
            searxng_available: AtomicBool::new(false),
            python_bin,
            // Claude Code
            claude_code_process: Mutex::new(None),
            claude_code_install: Arc::new(Mutex::new(InstallState::default())),
            // Remote Access
            remote: Mutex::new(RemoteServer::new()),
        }
    }
}

// On Windows, spawn child processes without flashing a console window.
// Applied to every taskkill/kill call so LU's process lifecycle stays invisible
// to the user. 0x08000000 = CREATE_NO_WINDOW.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

impl Drop for AppState {
    fn drop(&mut self) {
        // Kill ComfyUI process tree
        if let Ok(mut proc) = self.comfy_process.lock() {
            if let Some(ref mut child) = *proc {
                {
                    let pid = child.id();
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        let _ = std::process::Command::new("taskkill")
                            .args(["/pid", &pid.to_string(), "/T", "/F"])
                            .creation_flags(CREATE_NO_WINDOW)
                            .output();
                    }
                    #[cfg(not(windows))]
                    {
                        let _ = child.kill();
                        let _ = pid; // silence unused on non-Windows
                    }
                }
                println!("[ComfyUI] Stopped");
            }
        }

        // Kill Claude Code process
        if let Ok(mut proc) = self.claude_code_process.lock() {
            if let Some(ref mut child) = *proc {
                let pid = child.id();
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    let _ = std::process::Command::new("taskkill")
                        .args(["/pid", &pid.to_string(), "/T", "/F"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                }
                #[cfg(not(windows))]
                {
                    let _ = child.kill();
                    let _ = pid;
                }
                println!("[ClaudeCode] Stopped");
            }
        }

        // Stop Whisper server
        if let Ok(mut whisper) = self.whisper.lock() {
            whisper.stop();
        }
    }
}
