use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::path::PathBuf;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use base64::Engine;
use tauri::{Manager, State};

use crate::state::AppState;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct WhisperServer {
    process: Option<Child>,
    stdin_tx: Option<std::io::BufWriter<std::process::ChildStdin>>,
    response_rx: Option<mpsc::Receiver<serde_json::Value>>,
    pub ready: bool,
    pub backend: Option<String>,
}

impl WhisperServer {
    pub fn new() -> Self {
        Self {
            process: None,
            stdin_tx: None,
            response_rx: None,
            ready: false,
            backend: None,
        }
    }

    pub fn start(&mut self, python_bin: &str, script_path: &str) -> Result<(), String> {
        if self.process.is_some() {
            return Ok(());
        }

        println!("[Whisper] Starting persistent server: {} {}", python_bin, script_path);

        let mut cmd = Command::new(python_bin);
        cmd.arg(script_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Note: DO NOT use CREATE_NO_WINDOW for Python — libraries need valid stderr.
        // Piped stderr already hides the console window.
        let mut child = cmd.spawn()
            .map_err(|e| format!("Failed to start whisper server: {}", e))?;

        let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to get stderr")?;

        self.stdin_tx = Some(std::io::BufWriter::new(stdin));

        // Channel for passing responses from reader thread to callers
        let (tx, rx) = mpsc::channel();
        self.response_rx = Some(rx);

        // Stdout reader thread — parses JSON lines from whisper_server.py
        let tx_clone = tx.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
                        let _ = tx_clone.send(json);
                    }
                }
            }
        });

        // Stderr reader thread — log Python output
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    if !line.trim().is_empty() {
                        println!("[Whisper] {}", line.trim());
                    }
                }
            }
        });

        self.process = Some(child);

        // Wait for the "ready" signal (up to 5 minutes for model loading)
        if let Some(ref rx) = self.response_rx {
            match rx.recv_timeout(std::time::Duration::from_secs(300)) {
                Ok(msg) => {
                    if msg.get("status").and_then(|s| s.as_str()) == Some("ready") {
                        self.ready = true;
                        self.backend = msg.get("backend").and_then(|b| b.as_str()).map(|s| s.to_string());
                        println!("[Whisper] Server ready (backend: {})", self.backend.as_deref().unwrap_or("unknown"));
                    } else if msg.get("status").and_then(|s| s.as_str()) == Some("error") {
                        let err = msg.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
                        return Err(format!("Whisper server error: {}", err));
                    }
                }
                Err(_) => {
                    return Err("Whisper server did not become ready within 5 minutes".to_string());
                }
            }
        }

        Ok(())
    }

    pub fn send_command(&mut self, cmd: &serde_json::Value) -> Result<serde_json::Value, String> {
        if !self.ready {
            return Err("Whisper server not ready".to_string());
        }

        let stdin = self.stdin_tx.as_mut().ok_or("No stdin connection")?;
        let json_str = serde_json::to_string(cmd).map_err(|e| e.to_string())?;

        stdin.write_all(json_str.as_bytes()).map_err(|e| format!("stdin write: {}", e))?;
        stdin.write_all(b"\n").map_err(|e| format!("stdin newline: {}", e))?;
        stdin.flush().map_err(|e| format!("stdin flush: {}", e))?;

        // Wait for response (60s timeout for transcription)
        let rx = self.response_rx.as_ref().ok_or("No response channel")?;
        rx.recv_timeout(std::time::Duration::from_secs(60))
            .map_err(|_| "Whisper transcription timed out".to_string())
    }

    pub fn stop(&mut self) {
        if let Some(ref mut stdin) = self.stdin_tx {
            let _ = stdin.write_all(b"{\"action\":\"quit\"}\n");
            let _ = stdin.flush();
        }
        if let Some(ref mut child) = self.process {
            let _ = child.kill();
        }
        self.process = None;
        self.stdin_tx = None;
        self.response_rx = None;
        self.ready = false;
        println!("[Whisper] Server stopped");
    }
}

#[tauri::command]
pub fn whisper_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let whisper = state.whisper.lock().unwrap();
    Ok(serde_json::json!({
        "available": whisper.process.is_some(),
        "backend": whisper.backend,
        "loading": whisper.process.is_some() && !whisper.ready,
    }))
}

#[tauri::command]
pub fn transcribe(audio_base64: String, content_type: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let audio_bytes = base64::engine::general_purpose::STANDARD
        .decode(&audio_base64)
        .map_err(|e| format!("base64 decode: {}", e))?;

    if audio_bytes.is_empty() {
        return Err("Empty audio data".to_string());
    }

    // Determine file extension
    let ext = if content_type.contains("wav") { ".wav" }
        else if content_type.contains("mp3") || content_type.contains("mpeg") { ".mp3" }
        else if content_type.contains("ogg") { ".ogg" }
        else if content_type.contains("mp4") || content_type.contains("m4a") { ".m4a" }
        else { ".webm" };

    // Write to temp file
    let tmp_dir = std::env::temp_dir();
    let tmp_file = tmp_dir.join(format!("whisper-{}{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(), ext));

    std::fs::write(&tmp_file, &audio_bytes)
        .map_err(|e| format!("Write temp file: {}", e))?;

    let audio_path = tmp_file.to_string_lossy().replace('\\', "/");
    println!("[Whisper] Transcribing: {} ({:.1} KB)", audio_path, audio_bytes.len() as f64 / 1024.0);

    // Send to persistent whisper server
    let result = {
        let mut whisper = state.whisper.lock().unwrap();
        whisper.send_command(&serde_json::json!({
            "action": "transcribe",
            "path": audio_path,
        }))
    };

    // Clean up temp file
    let _ = std::fs::remove_file(&tmp_file);

    match result {
        Ok(response) => {
            if let Some(transcript) = response.get("transcript").and_then(|t| t.as_str()) {
                println!("[Whisper] Transcribed: \"{}\" (lang: {})",
                    &transcript[..transcript.len().min(80)],
                    response.get("language").and_then(|l| l.as_str()).unwrap_or("?"));
            }
            Ok(response)
        }
        Err(e) => Err(e),
    }
}

/// Synchronous whisper startup (runs in background thread)
pub fn auto_start_whisper_sync(app: &tauri::AppHandle, python_bin: &str, whisper: &Arc<Mutex<WhisperServer>>) {
    // Check if faster-whisper is installed
    let mut cmd = Command::new(python_bin);
    cmd.args(["-c", "import faster_whisper"]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let check = cmd.output();

    match check {
        Ok(output) if output.status.success() => {
            println!("[Whisper] faster-whisper found, starting persistent server...");
        }
        _ => {
            println!("[Whisper] faster-whisper not installed — STT disabled");
            return;
        }
    }

    // Resolve whisper_server.py path from bundled resources
    let script_path: Option<PathBuf> = app.path()
        .resource_dir()
        .ok()
        .map(|d: PathBuf| d.join("resources").join("whisper_server.py"))
        .filter(|p: &PathBuf| p.exists())
        .or_else(|| {
            let dev_path = PathBuf::from("public").join("whisper_server.py");
            if dev_path.exists() { Some(dev_path) } else { None }
        });

    match script_path {
        Some(path) => {
            let path_str: String = path.to_string_lossy().to_string();
            let mut ws = whisper.lock().unwrap();
            if let Err(e) = ws.start(python_bin, &path_str) {
                println!("[Whisper] Failed to start: {}", e);
            }
        }
        None => {
            println!("[Whisper] whisper_server.py not found");
        }
    }
}
