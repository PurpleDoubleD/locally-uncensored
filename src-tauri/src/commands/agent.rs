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

/// Base directory for all agent workspaces. Per-chat subfolders are
/// created lazily by `agent_workspace(chat_id)` on the first write.
fn agent_workspace_root() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join("agent-workspace")
}

/// Per-chat workspace directory. Each LU chat / Remote chat / Codex chat
/// gets its own isolated subfolder so writes from one agent don't clobber
/// another's files. If `chat_id` is None (legacy callers, CLI, etc.),
/// we fall back to `agent-workspace/default/` so nobody pollutes the
/// top-level folder with orphan files.
///
/// `chat_id` is sanitised to prevent path traversal — anything outside
/// `[A-Za-z0-9_\-\.]` is replaced with `_` and the string is capped at
/// 64 chars. The original id is kept in the chat UI; only the filesystem
/// form is sanitised.
fn agent_workspace(chat_id: Option<&str>) -> PathBuf {
    let root = agent_workspace_root();
    let id = chat_id.unwrap_or("default");
    let safe: String = id
        .chars()
        .take(64)
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' { c } else { '_' })
        .collect();
    let slug = if safe.is_empty() { "default".to_string() } else { safe };
    root.join(slug)
}

/// Defensive normalization that strips duplicate drive-letter prefixes.
///
/// The caller (desktop useCodex.ts or the model itself) can end up with paths
/// like `D:/Pictures/foo/D:/Pictures/foo/index.html` when:
///   1. `useCodex.ts` used to only treat `C:` as absolute and prepended workDir
///      in front of any `D:/…` path (now fixed there, but belt-and-suspenders).
///   2. The model hallucinated a doubled prefix after seeing an earlier error.
///
/// If the path contains more than one drive-letter `X:/` or `X:\` pattern, we
/// keep only the substring starting at the LAST one. A single drive prefix at
/// the start is untouched.
fn normalize_duplicate_drive_prefix(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.len() < 3 { return path.to_string(); }
    let mut last_drive_idx: Option<usize> = None;
    let mut i = 1;
    while i + 1 < bytes.len() {
        if bytes[i] == b':'
            && bytes[i - 1].is_ascii_alphabetic()
            && (bytes[i + 1] == b'/' || bytes[i + 1] == b'\\')
        {
            last_drive_idx = Some(i - 1);
        }
        i += 1;
    }
    match last_drive_idx {
        Some(idx) if idx > 0 => path[idx..].to_string(),
        _ => path.to_string(),
    }
}

fn resolve_agent_path(path: &str, chat_id: Option<&str>) -> PathBuf {
    let cleaned = normalize_duplicate_drive_prefix(path);
    let p = std::path::Path::new(&cleaned);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        agent_workspace(chat_id).join(&cleaned)
    }
}

#[cfg(test)]
mod path_tests {
    use super::normalize_duplicate_drive_prefix as n;

    #[test]
    fn single_drive_prefix_untouched() {
        assert_eq!(n("C:/foo/bar.txt"), "C:/foo/bar.txt");
        assert_eq!(n("D:\\foo\\bar.txt"), "D:\\foo\\bar.txt");
    }

    #[test]
    fn duplicate_drive_prefix_trimmed() {
        assert_eq!(
            n("D:/Pictures/foo/D:/Pictures/foo/index.html"),
            "D:/Pictures/foo/index.html"
        );
        assert_eq!(n("D:\\x\\D:\\x\\y.txt"), "D:\\x\\y.txt");
    }

    #[test]
    fn triple_drive_prefix_trimmed_to_last() {
        assert_eq!(n("D:/a/D:/a/D:/a/file.html"), "D:/a/file.html");
    }

    #[test]
    fn different_drives_trims_to_last() {
        assert_eq!(n("C:/temp/D:/real/x.txt"), "D:/real/x.txt");
    }

    #[test]
    fn relative_path_untouched() {
        assert_eq!(n("./foo.txt"), "./foo.txt");
        assert_eq!(n("foo/bar.txt"), "foo/bar.txt");
    }

    #[test]
    fn unix_absolute_untouched() {
        assert_eq!(n("/etc/passwd"), "/etc/passwd");
        assert_eq!(n("/home/user/x.txt"), "/home/user/x.txt");
    }

    #[test]
    fn short_path_untouched() {
        assert_eq!(n(""), "");
        assert_eq!(n("a"), "a");
        assert_eq!(n("ab"), "ab");
    }

    #[test]
    fn path_that_looks_like_drive_but_is_not() {
        assert_eq!(n("label:value"), "label:value");
        assert_eq!(n("key:val/x"), "key:val/x");
    }
}

#[tauri::command]
pub fn execute_code(
    code: String,
    timeout: Option<u64>,
    #[allow(non_snake_case)] chatId: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let timeout_ms = timeout.unwrap_or(30000);

    let tmp_dir = std::env::temp_dir();
    let script_path = tmp_dir.join(format!("agent-code-{}.py", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()));

    fs::write(&script_path, &code)
        .map_err(|e| format!("Write temp script: {}", e))?;

    // cwd = per-chat workspace (auto-created). Python scripts that do
    // relative file I/O land in the same isolated folder as file_read /
    // file_write for this chat.
    let workspace = agent_workspace(chatId.as_deref());
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
#[allow(non_snake_case)]
pub fn file_read(path: String, chatId: Option<String>) -> Result<serde_json::Value, String> {
    let full_path = resolve_agent_path(&path, chatId.as_deref());
    if !full_path.exists() {
        return Err(format!("File not found: {}", full_path.display()));
    }
    let content = fs::read_to_string(&full_path)
        .map_err(|e| format!("Read error: {}", e))?;
    Ok(serde_json::json!({"content": content}))
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn file_write(path: String, content: String, chatId: Option<String>) -> Result<serde_json::Value, String> {
    let full_path = resolve_agent_path(&path, chatId.as_deref());
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Create dir: {}", e))?;
    }
    fs::write(&full_path, &content).map_err(|e| format!("Write error: {}", e))?;
    Ok(serde_json::json!({"status": "saved", "path": full_path.to_string_lossy()}))
}
