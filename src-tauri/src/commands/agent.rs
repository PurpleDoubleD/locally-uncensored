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
///
/// `state` (when present) is consulted for a per-chat override the user
/// picked via the Remote dispatch folder picker — when set, the override
/// path wins over the default `~/agent-workspace/<chat_id>/` so the
/// agent writes land where the user expects (#29 follow-up).
fn agent_workspace(chat_id: Option<&str>, state: Option<&AppState>) -> PathBuf {
    if let (Some(id), Some(s)) = (chat_id, state) {
        if let Ok(map) = s.chat_workspace_overrides.lock() {
            if let Some(p) = map.get(id) {
                return p.clone();
            }
        }
    }
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

/// Public alias used by remote.rs's `/remote-api/agent-tool` route — that
/// endpoint already has &AppState and resolves the per-chat workspace
/// before delegating to file_read/file_write. Exposing this lets the
/// remote bridge honour the same override map without crossing module
/// privacy.
#[allow(dead_code)]
pub(crate) fn agent_workspace_for(chat_id: Option<&str>, state: &AppState) -> PathBuf {
    agent_workspace(chat_id, Some(state))
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

fn resolve_agent_path(path: &str, chat_id: Option<&str>, state: Option<&AppState>) -> PathBuf {
    let cleaned = normalize_duplicate_drive_prefix(path);
    let p = std::path::Path::new(&cleaned);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        agent_workspace(chat_id, state).join(&cleaned)
    }
}

#[cfg(test)]
mod path_tests {
    use super::normalize_duplicate_drive_prefix as n;
    use super::*;
    use crate::state::AppState;

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

    /// Bug 1 (Remote file_list wrong path): without an override the
    /// agent workspace falls back to the per-chat slug under
    /// ~/agent-workspace/.
    #[test]
    fn workspace_default_uses_chat_slug() {
        let state = AppState::new();
        let path = agent_workspace(Some("__remote__"), Some(&state));
        let s = path.to_string_lossy().to_string();
        // No override present → magic key is sanitised as the folder
        // name and joined under ~/agent-workspace/.
        assert!(s.contains("agent-workspace"), "got: {}", s);
        assert!(s.ends_with("__remote__"), "got: {}", s);
    }

    /// Override path wins over the default workspace.
    #[test]
    fn workspace_override_wins() {
        let state = AppState::new();
        let target = std::env::temp_dir().join("lu-test-remote-workspace");
        // Insert override under the magic remote key.
        state
            .chat_workspace_overrides
            .lock()
            .unwrap()
            .insert("__remote__".to_string(), target.clone());

        let resolved = agent_workspace(Some("__remote__"), Some(&state));
        assert_eq!(resolved, target);
    }

    /// Cleanup: remove() restores the default behaviour.
    #[test]
    fn workspace_override_clear_falls_back_to_default() {
        let state = AppState::new();
        let target = std::env::temp_dir().join("lu-test-remote-workspace-2");
        state
            .chat_workspace_overrides
            .lock()
            .unwrap()
            .insert("__remote__".to_string(), target.clone());

        // Clear it out
        state
            .chat_workspace_overrides
            .lock()
            .unwrap()
            .remove("__remote__");

        let resolved = agent_workspace(Some("__remote__"), Some(&state));
        let s = resolved.to_string_lossy().to_string();
        assert!(s.contains("agent-workspace") && s.ends_with("__remote__"), "got: {}", s);
        assert_ne!(resolved, target);
    }

    /// Resolve a relative path: should be joined onto the override folder
    /// when one is set. This is the regression check for Bug 1: file_list
    /// passing `path: "client/public"` while the user picked
    /// `D:\Projects\my-site` should land in `D:\Projects\my-site\client\public`.
    /// Path separators are normalised for comparison since PathBuf::join
    /// keeps whatever separator it found in the input verbatim.
    #[test]
    fn resolve_relative_uses_override_subfolder() {
        let state = AppState::new();
        let target = std::env::temp_dir().join("lu-test-remote-resolve-relative");
        state
            .chat_workspace_overrides
            .lock()
            .unwrap()
            .insert("__remote__".to_string(), target.clone());

        let resolved = resolve_agent_path("client/public", Some("__remote__"), Some(&state));
        let actual = resolved.to_string_lossy().replace('\\', "/");
        let expected = target.join("client").join("public").to_string_lossy().replace('\\', "/");
        assert_eq!(actual, expected);
    }

    /// Absolute paths must NOT be rewritten — the user passed a literal
    /// drive path, we hand it back as-is.
    #[test]
    fn resolve_absolute_path_untouched_with_override() {
        let state = AppState::new();
        let target = std::env::temp_dir().join("lu-test-remote-absolute-passthrough");
        state
            .chat_workspace_overrides
            .lock()
            .unwrap()
            .insert("__remote__".to_string(), target.clone());

        // Absolute path should pass through, ignoring the override.
        let abs = if cfg!(windows) { "C:/elsewhere/foo.txt" } else { "/tmp/elsewhere/foo.txt" };
        let resolved = resolve_agent_path(abs, Some("__remote__"), Some(&state));
        assert!(resolved.is_absolute());
        let s = resolved.to_string_lossy().to_string().replace('\\', "/");
        assert!(s.ends_with("/elsewhere/foo.txt"), "got: {}", s);
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
    let workspace = agent_workspace(chatId.as_deref(), Some(&*state));
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
pub fn file_read(
    path: String,
    chatId: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let full_path = resolve_agent_path(&path, chatId.as_deref(), Some(&*state));
    if !full_path.exists() {
        return Err(format!("File not found: {}", full_path.display()));
    }
    let content = fs::read_to_string(&full_path)
        .map_err(|e| format!("Read error: {}", e))?;
    Ok(serde_json::json!({"content": content}))
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn file_write(
    path: String,
    content: String,
    chatId: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let full_path = resolve_agent_path(&path, chatId.as_deref(), Some(&*state));
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Create dir: {}", e))?;
    }
    fs::write(&full_path, &content).map_err(|e| format!("Write error: {}", e))?;
    Ok(serde_json::json!({"status": "saved", "path": full_path.to_string_lossy()}))
}

/// Persist a per-chat agent workspace override. Set by the Remote
/// dispatch flow (#29 follow-up) when the user picks a custom folder
/// — every subsequent file_read / file_write / execute_code call
/// from this chat resolves relative paths against that folder
/// instead of `~/agent-workspace/<chat_id>/`. Pass `path: null` (or
/// empty string) to clear.
#[tauri::command]
#[allow(non_snake_case)]
pub fn set_chat_workspace_override(
    chatId: String,
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let id = chatId.trim();
    if id.is_empty() {
        return Err("chatId cannot be empty".into());
    }
    let mut map = state.chat_workspace_overrides.lock().map_err(|e| e.to_string())?;
    match path.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(p) => {
            let pb = std::path::PathBuf::from(p);
            // Best-effort: create the folder if missing so the first
            // file_write doesn't fail with "no such directory".
            let _ = std::fs::create_dir_all(&pb);
            map.insert(id.to_string(), pb);
        }
        None => {
            map.remove(id);
        }
    }
    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn get_chat_workspace_override(
    chatId: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let map = state.chat_workspace_overrides.lock().map_err(|e| e.to_string())?;
    Ok(map.get(chatId.trim()).map(|p| p.to_string_lossy().to_string()))
}
