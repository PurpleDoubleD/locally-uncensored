use crate::os_error;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::{AppHandle, Manager, State};

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

/// Resolve + CONTAIN an agent file-op path to its per-chat workspace (or the
/// user-picked override folder). A relative path resolves under the workspace;
/// an absolute path is accepted only when it falls inside it. Any escape
/// (`..`, an out-of-workspace absolute path) is rejected — this is the security
/// boundary that stops a prompt-injected model or a remote client from reading
/// `~/.ssh/id_rsa` or writing into the Startup folder.
fn resolve_agent_path(path: &str, chat_id: Option<&str>, state: Option<&AppState>) -> Result<PathBuf, String> {
    let cleaned = normalize_duplicate_drive_prefix(path);
    let root = agent_workspace(chat_id, state);
    let p = std::path::Path::new(&cleaned);
    let candidate = if p.is_absolute() { p.to_path_buf() } else { root.join(&cleaned) };
    crate::commands::filesystem::contain_within(&root, &candidate)
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

        let resolved = resolve_agent_path("client/public", Some("__remote__"), Some(&state)).unwrap();
        let actual = resolved.to_string_lossy().replace('\\', "/");
        let expected = target.join("client").join("public").to_string_lossy().replace('\\', "/");
        assert_eq!(actual, expected);
    }

    /// Security (path-jail): an absolute path INSIDE the workspace is accepted,
    /// but one OUTSIDE it is rejected — a remote client / model can't read or
    /// write arbitrary disk locations by passing a literal drive path.
    #[test]
    fn resolve_absolute_inside_override_is_allowed_outside_is_rejected() {
        let state = AppState::new();
        let target = std::env::temp_dir().join("lu-test-remote-jail");
        state
            .chat_workspace_overrides
            .lock()
            .unwrap()
            .insert("__remote__".to_string(), target.clone());

        // Inside the override → allowed.
        let inside = target.join("foo.txt");
        let resolved = resolve_agent_path(&inside.to_string_lossy(), Some("__remote__"), Some(&state));
        assert!(resolved.is_ok(), "inside path should be allowed: {:?}", resolved);

        // Outside the override → rejected.
        let abs = if cfg!(windows) { "C:/Windows/System32/foo.txt" } else { "/etc/passwd" };
        assert!(resolve_agent_path(abs, Some("__remote__"), Some(&state)).is_err());

        // `..` climbing out of the workspace → rejected.
        assert!(resolve_agent_path("../../../../etc/passwd", Some("__remote__"), Some(&state)).is_err());
    }
}

/// Runs on the blocking pool: the poll loop below waits for the Python process
/// for up to `timeout_ms`, and a sync #[command] would spend all of that on the
/// Tauri main thread with the window frozen (same class as install.rs and the
/// built-in engine). The shell tool next door already did it this way.
#[tauri::command]
pub async fn execute_code(
    app: AppHandle,
    code: String,
    timeout: Option<u64>,
    #[allow(non_snake_case)] chatId: Option<String>,
    #[allow(non_snake_case)] workingDirectory: Option<String>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        execute_code_blocking(code, timeout, chatId, workingDirectory, &state)
    })
    .await
    .map_err(|e| format!("Code execution task failed to run: {e}"))?
}

#[allow(non_snake_case)]
pub(crate) fn execute_code_blocking(
    code: String,
    timeout: Option<u64>,
    chatId: Option<String>,
    workingDirectory: Option<String>,
    state: &State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let timeout_ms = timeout.unwrap_or(30000);

    let tmp_dir = std::env::temp_dir();
    let script_path = tmp_dir.join(format!("agent-code-{}.py", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)));

    fs::write(&script_path, &code)
        .map_err(|e| format!("Write temp script: {}", os_error::english(&e)))?;

    // cwd: prefer the agent's folder workspace (the repo the user picked,
    // threaded from chatCtx as workingDirectory) so a script's relative file
    // I/O lands in that repo; otherwise the per-chat sandbox (#62). Same
    // resolution order as the file_* tools and shell_execute.
    let workspace = match workingDirectory.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(wd) => PathBuf::from(wd),
        None => agent_workspace(chatId.as_deref(), Some(&*state)),
    };
    let _ = fs::create_dir_all(&workspace);

    let python_bin = state.python_bin.lock().unwrap().clone();
    if python_bin.is_empty() {
        return Err(
            "Python is not installed — agent code execution requires Python. \
             Install it from Settings → ComfyUI → Install Python first."
                .to_string(),
        );
    }
    let mut cmd = Command::new(&python_bin);
    cmd.arg(&script_path)
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn()
        .map_err(|e| format!("Spawn Python: {}", os_error::english(&e)))?;

    // Both pipes are drained on their own threads from here on. A script that
    // prints more than a pipe buffer would otherwise block on write and never
    // exit — the tool call ate the full timeout and returned nothing. Same
    // machinery as the shell tool (commands/shell.rs).
    let (out_buf, out_done) = super::shell::drain(child.stdout.take().expect("stdout is piped"));
    let (err_buf, err_done) = super::shell::drain(child.stderr.take().expect("stderr is piped"));

    // Poll-based timeout since std::process::Child has no wait_timeout
    let start = std::time::Instant::now();
    let timeout_dur = std::time::Duration::from_millis(timeout_ms);

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                super::shell::settle(&out_done, &err_done, std::time::Duration::from_millis(500));
                let _ = fs::remove_file(&script_path);
                return Ok(serde_json::json!({
                    "stdout": super::shell::captured_text(&out_buf),
                    "stderr": super::shell::captured_text(&err_buf),
                    "exitCode": status.code().unwrap_or(-1),
                    "timedOut": false,
                }));
            }
            Ok(None) => {
                if start.elapsed() > timeout_dur {
                    super::shell::kill_tree(child.id());
                    let _ = child.kill();
                    let _ = child.wait();
                    super::shell::settle(&out_done, &err_done, std::time::Duration::from_millis(200));
                    let _ = fs::remove_file(&script_path);
                    let mut stderr_str = super::shell::captured_text(&err_buf);
                    if !stderr_str.is_empty() {
                        stderr_str.push('\n');
                    }
                    stderr_str.push_str(&format!("Execution timed out after {}ms", timeout_ms));
                    return Ok(serde_json::json!({
                        "stdout": super::shell::captured_text(&out_buf),
                        "stderr": stderr_str,
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
    let full_path = resolve_agent_path(&path, chatId.as_deref(), Some(&*state))?;
    if !full_path.exists() {
        return Err(format!("File not found: {}", full_path.display()));
    }
    // A file that is not valid UTF-8 used to come back as a raw
    // "stream did not contain valid UTF-8" error, leaving the caller with no
    // way forward — and that hits more than images: a legacy CP1252 source file
    // is enough. The desktop path (fs_read + builtin-tools) answers with a
    // marker instead, so the model knows to leave the file alone rather than
    // writing mangled text back over it. Same answer here, same wording.
    let content = match fs::read_to_string(&full_path) {
        Ok(c) => c,
        Err(_) => {
            let bytes = fs::metadata(&full_path).map(|m| m.len()).unwrap_or(0);
            format!(
                "[binary file — {}, not shown. This tool reads text only; do not write binary content back through file_write.]",
                format_bytes(bytes)
            )
        }
    };
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
    let full_path = resolve_agent_path(&path, chatId.as_deref(), Some(&*state))?;
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Create dir: {}", os_error::english(&e)))?;
    }
    // Same treatment the desktop path (fs_write) already gets: keep the file's
    // EOL/BOM convention, skip an identical write, and swap the new bytes in
    // atomically. A plain fs::write here could leave a user's source file
    // truncated if the app died mid-write, and it rewrote a CRLF repo as LF —
    // which shows up as "every line changed" in git.
    let existing = fs::read(&full_path).ok();
    let out_bytes = crate::commands::filesystem::normalize_to_existing_style(
        existing.as_deref(),
        &content,
    );
    if existing.as_deref() == Some(out_bytes.as_slice()) {
        return Ok(serde_json::json!({
            "status": "unchanged",
            "path": full_path.to_string_lossy(),
        }));
    }
    crate::commands::filesystem::write_atomic(&full_path, &out_bytes)?;
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


/// Sub-folder names of `~/agent-workspace`, so the app can find the folder an
/// OLDER chat already owns.
///
/// The frontend used to rebuild a chat's folder name from its title on every
/// turn, and the auto-rename after the first message therefore moved the
/// folder out from under a running agent (counter-check round 2, 2026-08-29).
/// The name is pinned per conversation now, but chats that predate the pin
/// have only their folder on disk to go by. Their names all end in the stable
/// `-<id6>` suffix, so one listing is enough to adopt the right one.
///
/// Names only, no paths, directories only. A missing or unreadable root is an
/// empty list, never an error: not finding a legacy folder simply means a new
/// one gets created.
#[tauri::command]
pub fn list_agent_workspaces() -> Result<Vec<String>, String> {
    let root = agent_workspace_root();
    let entries = match fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
        .collect();
    names.sort();
    Ok(names)
}

/// Human byte size for tool messages. Mirrors formatBytes in builtin-tools.ts
/// so the desktop and relay paths say the same thing about the same file.
fn format_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b < KB {
        format!("{} B", bytes)
    } else if b < KB * KB {
        format!("{:.1} KB", b / KB)
    } else if b < KB * KB * KB {
        format!("{:.1} MB", b / (KB * KB))
    } else {
        format!("{:.1} GB", b / (KB * KB * KB))
    }
}

#[cfg(test)]
mod workspace_listing_tests {
    use std::fs;

    /// The listing rule the frontend's fallback search depends on: folder
    /// names, directories only, sorted, and a plain file is not a workspace.
    #[test]
    fn lists_only_directory_names_sorted() {
        let root = std::env::temp_dir().join("lu-test-agent-workspace-listing");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("zeta-5e61db")).unwrap();
        fs::create_dir_all(root.join("alpha-aabbcc")).unwrap();
        fs::write(root.join("loose.txt"), b"not a workspace").unwrap();

        let entries = fs::read_dir(&root).unwrap();
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
            .collect();
        names.sort();

        assert_eq!(names, vec!["alpha-aabbcc".to_string(), "zeta-5e61db".to_string()]);
        let _ = fs::remove_dir_all(&root);
    }

    /// Negative control: a root that does not exist is an empty list, not an
    /// error, so a fresh install never sees a failure here.
    #[test]
    fn missing_root_is_empty_not_an_error() {
        let root = std::env::temp_dir().join("lu-test-agent-workspace-absent");
        let _ = fs::remove_dir_all(&root);
        let listed: Vec<String> = match fs::read_dir(&root) {
            Ok(e) => e.flatten().filter_map(|x| x.file_name().to_str().map(|s| s.to_string())).collect(),
            Err(_) => Vec::new(),
        };
        assert!(listed.is_empty());
    }
}

#[cfg(test)]
mod read_tests {
    use super::format_bytes;

    #[test]
    fn byte_sizes_read_like_the_desktop_path() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(2048), "2.0 KB");
        assert_eq!(format_bytes(5 * 1024 * 1024), "5.0 MB");
        assert_eq!(format_bytes(3 * 1024 * 1024 * 1024), "3.0 GB");
    }
}
