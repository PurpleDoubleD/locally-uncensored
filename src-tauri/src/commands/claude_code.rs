use std::io::{BufRead, BufReader, Write as IoWrite};
use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;

/// Windows: hide console windows for spawned processes
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ── Detect Claude Code CLI ────────────────────────────────────────────────

#[tauri::command]
pub fn detect_claude_code() -> Result<serde_json::Value, String> {
    let mut cmd = Command::new("claude");
    cmd.args(["--version"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    match cmd.output() {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            // Try to find the full path
            let path = find_claude_path().unwrap_or_default();
            Ok(serde_json::json!({
                "installed": true,
                "version": version,
                "path": path,
            }))
        }
        _ => Ok(serde_json::json!({
            "installed": false,
            "version": null,
            "path": null,
        })),
    }
}

fn find_claude_path() -> Option<String> {
    let cmd_name = if cfg!(target_os = "windows") { "where" } else { "which" };
    let mut cmd = Command::new(cmd_name);
    cmd.arg("claude")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.output().ok().and_then(|o| {
        if o.status.success() {
            let output = String::from_utf8_lossy(&o.stdout);
            // On Windows, `where` returns multiple lines. Prefer .cmd or .exe over bare scripts.
            if cfg!(target_os = "windows") {
                let lines: Vec<&str> = output.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
                // First try .exe, then .cmd, then first result
                lines.iter().find(|l| l.ends_with(".exe")).map(|s| s.to_string())
                    .or_else(|| lines.iter().find(|l| l.ends_with(".cmd")).map(|s| s.to_string()))
                    .or_else(|| lines.first().map(|s| s.to_string()))
            } else {
                Some(output.lines().next()?.trim().to_string())
            }
        } else {
            None
        }
    })
}

// ── Install Claude Code ───────────────────────────────────────────────────

#[tauri::command]
pub fn install_claude_code(
    method: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let mut install = state.claude_code_install.lock().unwrap();
    if install.status == "installing" || install.status == "downloading" {
        return Ok(serde_json::json!({"status": "already_installing"}));
    }

    install.status = "installing".to_string();
    install.logs.clear();
    install.logs.push("Starting Claude Code installation...".to_string());
    drop(install);

    let install_state = state.claude_code_install.clone();

    std::thread::spawn(move || {
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = install_state.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        match method.as_str() {
            "npm" => {
                // Check Node.js
                update("installing", "Checking Node.js...");
                let mut node_cmd = Command::new("node");
                node_cmd.args(["--version"])
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                #[cfg(target_os = "windows")]
                node_cmd.creation_flags(CREATE_NO_WINDOW);

                match node_cmd.output() {
                    Ok(output) if output.status.success() => {
                        let ver = String::from_utf8_lossy(&output.stdout).trim().to_string();
                        update("installing", &format!("Node.js {} found.", ver));
                    }
                    _ => {
                        update("error", "Node.js not found. Install Node.js 18+ first, or use the native installer method.");
                        return;
                    }
                }

                // npm install -g @anthropic-ai/claude-code
                update("installing", "Installing @anthropic-ai/claude-code via npm...");
                let mut npm = Command::new("npm");
                npm.args(["install", "-g", "@anthropic-ai/claude-code"])
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                #[cfg(target_os = "windows")]
                npm.creation_flags(CREATE_NO_WINDOW);

                match npm.output() {
                    Ok(output) if output.status.success() => {
                        update("complete", "Claude Code installed successfully!");
                    }
                    Ok(output) => {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        update("error", &format!("npm install failed: {}", stderr.chars().take(300).collect::<String>()));
                    }
                    Err(e) => {
                        update("error", &format!("npm not found: {}", e));
                    }
                }
            }
            "native" => {
                // Native installer
                if cfg!(target_os = "windows") {
                    update("installing", "Running native installer for Windows...");
                    // PowerShell one-liner from Anthropic
                    let mut ps = Command::new("powershell");
                    ps.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
                        "irm https://claude.ai/install.ps1 | iex"])
                        .stdout(Stdio::piped())
                        .stderr(Stdio::piped());
                    #[cfg(target_os = "windows")]
                    ps.creation_flags(CREATE_NO_WINDOW);

                    match ps.output() {
                        Ok(output) if output.status.success() => {
                            update("complete", "Claude Code installed successfully!");
                        }
                        Ok(output) => {
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            let stdout = String::from_utf8_lossy(&output.stdout);
                            // Native installer may print to stdout
                            let msg = if stderr.is_empty() { stdout } else { stderr };
                            update("error", &format!("Installation failed: {}", msg.chars().take(300).collect::<String>()));
                        }
                        Err(e) => {
                            update("error", &format!("PowerShell not found: {}", e));
                        }
                    }
                } else {
                    // macOS/Linux: curl installer
                    update("installing", "Running native installer...");
                    let mut sh = Command::new("sh");
                    sh.args(["-c", "curl -fsSL https://claude.ai/install.sh | bash"])
                        .stdout(Stdio::piped())
                        .stderr(Stdio::piped());

                    match sh.output() {
                        Ok(output) if output.status.success() => {
                            update("complete", "Claude Code installed successfully!");
                        }
                        Ok(output) => {
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            update("error", &format!("Installation failed: {}", stderr.chars().take(300).collect::<String>()));
                        }
                        Err(e) => {
                            update("error", &format!("Shell not available: {}", e));
                        }
                    }
                }
            }
            _ => {
                update("error", &format!("Unknown install method: {}", method));
            }
        }
    });

    Ok(serde_json::json!({"status": "installing"}))
}

#[tauri::command]
pub fn install_claude_code_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.claude_code_install.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
    }))
}

// ── Start Claude Code Session ─────────────────────────────────────────────

#[allow(non_snake_case)]
#[tauri::command]
pub fn start_claude_code(
    app: AppHandle,
    state: State<'_, AppState>,
    workingDir: String,
    model: String,
    prompt: String,
    ollamaBaseUrl: String,
    permissionMode: String,
) -> Result<serde_json::Value, String> {
    // Check if already running
    {
        let proc = state.claude_code_process.lock().unwrap();
        if proc.is_some() {
            return Ok(serde_json::json!({"status": "already_running"}));
        }
    }

    // Resolve CLI path
    let claude_bin = find_claude_path().unwrap_or_else(|| "claude".to_string());

    // Build command args
    let mut args = vec![
        "--print".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--model".to_string(),
        model.clone(),
        "--verbose".to_string(),
    ];

    // Permission mode
    match permissionMode.as_str() {
        "auto-approve" => {
            args.push("--dangerously-skip-permissions".to_string());
        }
        "read-only" => {
            args.push("--allowedTools".to_string());
            args.push("Read,Grep,Glob,WebSearch,WebFetch".to_string());
        }
        _ => {
            // Default "ask" mode — Claude Code will prompt for permissions
            // We handle permission_request events in the frontend
        }
    }

    // Add the actual prompt
    args.push(prompt);

    println!("[ClaudeCode] Starting: {} {:?}", claude_bin, args);
    println!("[ClaudeCode] Working dir: {}", workingDir);
    println!("[ClaudeCode] Ollama base URL: {}", ollamaBaseUrl);
    println!("[ClaudeCode] Model: {}", model);

    // Spawn the process
    let effective_dir = if workingDir.is_empty() {
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string())
    } else {
        workingDir.clone()
    };

    let mut cmd = Command::new(&claude_bin);
    cmd.args(&args)
        .current_dir(&effective_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("ANTHROPIC_BASE_URL", &ollamaBaseUrl)
        .env("ANTHROPIC_API_KEY", "sk-local-placeholder")
        .env("DISABLE_PROMPT_CACHING", "1")
        .env_remove("CLAUDECODE")  // Prevent "nested session" detection
        .env_remove("CLAUDE_CODE_ENTRYPOINT");

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| format!("Failed to start Claude Code (bin: {}, dir: {}): {}", claude_bin, effective_dir, e))?;

    let pid = child.id();
    println!("[ClaudeCode] Started with PID {}", pid);

    // Take stdout and stderr
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    // Store process handle
    {
        let mut proc = state.claude_code_process.lock().unwrap();
        *proc = Some(child);
    }

    // Spawn thread to read stdout (JSON events)
    let app_stdout = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    let trimmed = text.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    // Try to parse as JSON, otherwise wrap as text event
                    let event = if trimmed.starts_with('{') {
                        match serde_json::from_str::<serde_json::Value>(trimmed) {
                            Ok(json) => json,
                            Err(_) => serde_json::json!({"type": "text", "content": trimmed}),
                        }
                    } else {
                        serde_json::json!({"type": "text", "content": trimmed})
                    };
                    let _ = app_stdout.emit("claude-code-event", &event);
                }
                Err(e) => {
                    let _ = app_stdout.emit("claude-code-event",
                        serde_json::json!({"type": "error", "content": format!("Read error: {}", e)}));
                    break;
                }
            }
        }
        // Process ended
        let _ = app_stdout.emit("claude-code-event",
            serde_json::json!({"type": "done", "content": "Claude Code session ended."}));
        println!("[ClaudeCode] stdout reader finished");
    });

    // Spawn thread to read stderr
    let app_stderr = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(text) = line {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    println!("[ClaudeCode stderr] {}", trimmed);
                    let _ = app_stderr.emit("claude-code-event",
                        serde_json::json!({"type": "error", "content": trimmed}));
                }
            }
        }
    });

    Ok(serde_json::json!({
        "status": "started",
        "pid": pid,
    }))
}

// ── Stop Claude Code ──────────────────────────────────────────────────────

#[tauri::command]
pub fn stop_claude_code(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut proc = state.claude_code_process.lock().unwrap();
    if let Some(ref mut child) = *proc {
        let pid = child.id();
        println!("[ClaudeCode] Stopping PID {}", pid);

        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill")
                .args(["/pid", &pid.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = child.kill();
        }

        *proc = None;
        Ok(serde_json::json!({"status": "stopped"}))
    } else {
        Ok(serde_json::json!({"status": "not_running"}))
    }
}

// ── Send input to Claude Code stdin (permission approvals) ────────────────

#[tauri::command]
pub fn send_claude_code_input(
    input: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let mut proc = state.claude_code_process.lock().unwrap();
    if let Some(ref mut child) = *proc {
        if let Some(ref mut stdin) = child.stdin {
            stdin.write_all(input.as_bytes())
                .map_err(|e| format!("Failed to write to stdin: {}", e))?;
            stdin.write_all(b"\n")
                .map_err(|e| format!("Failed to write newline: {}", e))?;
            stdin.flush()
                .map_err(|e| format!("Failed to flush stdin: {}", e))?;
            Ok(serde_json::json!({"status": "sent"}))
        } else {
            Err("stdin not available".to_string())
        }
    } else {
        Err("Claude Code is not running".to_string())
    }
}
