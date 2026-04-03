use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::State;

use crate::state::AppState;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn agent_workspace() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join("agent-workspace")
}

fn validate_path(path: &str) -> Result<PathBuf, String> {
    if path.contains("..") {
        return Err("Path traversal not allowed".to_string());
    }
    let workspace = agent_workspace();
    let full = workspace.join(path);
    if !full.starts_with(&workspace) {
        return Err("Path outside workspace".to_string());
    }
    Ok(full)
}

#[tauri::command]
pub fn execute_code(
    code: String,
    timeout: Option<u64>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let timeout_ms = timeout.unwrap_or(30000);

    let tmp_dir = std::env::temp_dir();
    let script_path = tmp_dir.join(format!("agent-code-{}.py", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()));

    fs::write(&script_path, &code)
        .map_err(|e| format!("Write temp script: {}", e))?;

    let workspace = agent_workspace();
    let _ = fs::create_dir_all(&workspace);

    let mut cmd = Command::new(&state.python_bin);
    cmd.arg(&script_path)
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn()
        .map_err(|e| format!("Spawn Python: {}", e))?;

    // Poll-based timeout since std::process::Child has no wait_timeout
    let start = std::time::Instant::now();
    let timeout_dur = std::time::Duration::from_millis(timeout_ms);

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout_str = String::new();
                let mut stderr_str = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    let _ = stdout.read_to_string(&mut stdout_str);
                }
                if let Some(mut stderr) = child.stderr.take() {
                    let _ = stderr.read_to_string(&mut stderr_str);
                }

                let _ = fs::remove_file(&script_path);
                return Ok(serde_json::json!({
                    "stdout": stdout_str,
                    "stderr": stderr_str,
                    "exitCode": status.code().unwrap_or(-1),
                    "timedOut": false,
                }));
            }
            Ok(None) => {
                if start.elapsed() > timeout_dur {
                    let _ = child.kill();
                    let _ = fs::remove_file(&script_path);
                    return Ok(serde_json::json!({
                        "stdout": "",
                        "stderr": format!("Execution timed out after {}ms", timeout_ms),
                        "exitCode": -1,
                        "timedOut": true,
                    }));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => {
                let _ = fs::remove_file(&script_path);
                return Err(format!("Wait error: {}", e));
            }
        }
    }
}

#[tauri::command]
pub fn file_read(path: String) -> Result<serde_json::Value, String> {
    let full_path = validate_path(&path)?;
    if !full_path.exists() {
        return Err(format!("File not found: {}", path));
    }
    let content = fs::read_to_string(&full_path)
        .map_err(|e| format!("Read error: {}", e))?;
    Ok(serde_json::json!({"content": content}))
}

#[tauri::command]
pub fn file_write(path: String, content: String) -> Result<serde_json::Value, String> {
    let full_path = validate_path(&path)?;
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Create dir: {}", e))?;
    }
    fs::write(&full_path, &content).map_err(|e| format!("Write error: {}", e))?;
    Ok(serde_json::json!({"status": "saved", "path": full_path.to_string_lossy()}))
}
