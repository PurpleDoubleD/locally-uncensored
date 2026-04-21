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

pub struct AppState {
    pub comfy_process: Mutex<Option<Child>>,
    pub comfy_path: Mutex<Option<String>>,
    pub comfy_port: Mutex<u16>,
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

        Self {
            comfy_process: Mutex::new(None),
            comfy_path: Mutex::new(None),
            comfy_port: Mutex::new(8188),
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
