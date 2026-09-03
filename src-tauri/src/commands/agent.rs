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
    crate::os_paths::agent_workspace_root()
}

/// Per-chat workspace directory. Each LU chat / Remote chat / Codex chat
/// gets its own isolated subfolder so writes from one agent don't clobber
/// another's files. If `chat_id` is None (legacy callers, CLI, etc.),
/// we fall back to `agent-workspace/default/` so nobody pollutes the
/// top-level folder with orphan files.
///
/// `chat_id` is sanitised by `sanitize_chat_slug` to prevent path traversal.
/// The original id is kept in the chat UI; only the filesystem form is
/// sanitised.
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
    root.join(sanitize_chat_slug(chat_id.unwrap_or("default")))
}

/// Filesystem-safe folder name for a chat id — the ONLY thing standing between
/// a client-supplied id and the shape of the jail root.
///
/// SECURITY (audit IPC-1, critical). `.` used to be in the allow-list, so an id
/// of `".."` survived sanitisation verbatim. `root.join("..")` then pointed one
/// level ABOVE `~/agent-workspace`, and `contain_within` normalises `..`
/// lexically (`ParentDir => out.pop()`), so the JAIL ROOT ITSELF collapsed to
/// `$HOME` — every containment check afterwards passed for the entire home
/// directory. The id arrives straight out of client JSON on the remote HTTP
/// bridge (`remote.rs`, `#[serde(rename = "chatId")]`), so a paired device could
/// read `~/.ssh` / `~/.aws` and write shell rc files or LaunchAgents, i.e. code
/// execution at next login without ever holding the `shell` permission.
///
/// `.` is therefore treated like every other special character and replaced with
/// `_`: `".."` becomes `"__"`, an ordinary folder INSIDE the root. Dropping the
/// dot costs nothing, because no legitimate id has ever contained one — desktop
/// slugs are `[a-z0-9-]` (`src/api/agent-context.ts::chatWorkspaceSlug`), mobile
/// ids are `c-<millis>-<base36>` (`remote.rs::uid()`), conversation ids are
/// UUIDs, and the magic key is `__remote__`.
///
/// Everything outside `[A-Za-z0-9_-]` becomes `_`, the result is capped at 64
/// chars, and an empty id falls back to `default` so nobody writes orphan files
/// into the top-level workspace folder. Note that the fallback is only for an
/// EMPTY result: an all-underscore slug like `"__"` is a perfectly good folder
/// name and must stay distinct from `default`, or two different chats would
/// share one directory.
pub(crate) fn sanitize_chat_slug(id: &str) -> String {
    let safe: String = id
        .chars()
        .take(64)
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    if safe.is_empty() { "default".to_string() } else { safe }
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

    /// Security, audit IPC-1 (critical): the escape used to be in the chat ID,
    /// not in the path. `.` was allowed through the slug filter, so a chat id
    /// of ".." made the JAIL ROOT itself `~/agent-workspace/..` == `$HOME` and
    /// every path check below it then passed for the whole home directory. The
    /// id is client-supplied over the remote HTTP bridge, so this was reachable
    /// from any paired device.
    #[test]
    fn chat_id_dotdot_cannot_move_the_jail_root() {
        // `..` is neutralised into an ordinary folder name, NOT preserved.
        assert_eq!(sanitize_chat_slug(".."), "__");
        assert_eq!(sanitize_chat_slug("."), "_");
        assert_eq!(sanitize_chat_slug("a.b"), "a_b");

        // No traversal character survives, whichever way it is spelled.
        for evil in ["..", ".", "../..", "../../.ssh", "..\\..", "a.b", "....//"] {
            let slug = sanitize_chat_slug(evil);
            assert!(
                !slug.contains('.') && !slug.contains('/') && !slug.contains('\\'),
                "{evil:?} sanitised to {slug:?}"
            );
        }

        // The workspace for a ".." id stays a child of ~/agent-workspace.
        let root = agent_workspace_root();
        let ws = agent_workspace(Some(".."), None);
        assert_eq!(ws, root.join("__"));
        assert!(ws.starts_with(&root), "workspace escaped the root: {:?}", ws);
    }

    /// The end-to-end consequence of the above: with chat id "..", a remote
    /// client asked for `~/.ssh/id_rsa` and got it, because the jail root had
    /// become $HOME. It must be rejected now. Also covers the write side of
    /// the same hole (shell rc / LaunchAgents under $HOME).
    #[test]
    fn chat_id_dotdot_cannot_reach_home_dot_files() {
        let home = dirs::home_dir().unwrap_or_default();

        for evil_id in ["..", "../..", "."] {
            for target in [home.join(".ssh").join("id_rsa"), home.join(".zshrc")] {
                let got = resolve_agent_path(&target.to_string_lossy(), Some(evil_id), None);
                assert!(
                    got.is_err(),
                    "id {evil_id:?} still reaches {:?} (resolved to {:?})",
                    target,
                    got
                );
            }
        }

        // A relative path under such an id lands inside the sanitised folder,
        // not one level up.
        let resolved = resolve_agent_path("notes.md", Some(".."), None).unwrap();
        assert_eq!(resolved, agent_workspace_root().join("__").join("notes.md"));

        // And a dotted id can no longer address a sibling of the workspace.
        let resolved = resolve_agent_path("x.txt", Some("a.b"), None).unwrap();
        assert_eq!(resolved, agent_workspace_root().join("a_b").join("x.txt"));
    }

    /// Negative control for the fix: ordinary ids are untouched, and the
    /// existing "default" fallback still catches the empty id. An all-underscore
    /// slug is a legitimate folder name and must NOT be folded into "default",
    /// or two different chats would end up sharing one directory.
    #[test]
    fn normal_chat_ids_survive_and_empty_falls_back_to_default() {
        // Real-world shapes: desktop slug, mobile uid, magic remote key, UUID.
        for id in [
            "coding-agent-8b0c71",
            "codex-chat-386d5b",
            "c-1756612345678-ab12x",
            "__remote__",
            "8f7c2a1b-4d5e-6f70-8192-a3b4c5d6e7f8",
            "default",
        ] {
            assert_eq!(sanitize_chat_slug(id), id, "id {id:?} was altered");
        }

        // Empty (and whitespace-free empty) → the default bucket.
        assert_eq!(sanitize_chat_slug(""), "default");
        assert_eq!(agent_workspace(Some(""), None), agent_workspace_root().join("default"));
        assert_eq!(agent_workspace(None, None), agent_workspace_root().join("default"));

        // Not empty → keeps its own folder, even if it is all underscores.
        assert_eq!(sanitize_chat_slug("...."), "____");
        assert_ne!(sanitize_chat_slug(".."), sanitize_chat_slug("default"));

        // A leading '-' is harmless: the slug is always joined onto an absolute
        // root, so it is never read as a CLI flag. It stays a normal folder.
        assert_eq!(sanitize_chat_slug("-rf"), "-rf");
        assert!(agent_workspace(Some("-rf"), None).starts_with(agent_workspace_root()));

        // The 64-char cap survived the rewrite.
        assert_eq!(sanitize_chat_slug(&"x".repeat(200)).chars().count(), 64);
    }
}

/// Runs on the blocking pool: the poll loop below waits for the Python process
/// for up to `timeout_ms`, and a sync #[command] would spend all of that on the
/// Tauri main thread with the window frozen (same class as the installer tree and the
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

/// Put the agent's script somewhere only this user can read it, under a name
/// nobody can guess, and hand back the directory that owns its lifetime.
///
/// It used to be `<shared temp>/agent-code-<millis>.py`, executed by that exact
/// path. Both halves are the problem: a millisecond timestamp is guessable by
/// any process on the machine, and the shared temp directory is world-readable
/// — the script (which carries whatever the user or the model put in it, file
/// paths included) was readable by every account on the box, and a racing local
/// process could swap the file between the write and the spawn.
///
/// The mechanics — 0700 directory, `create_new` 0600 file, lifetime owned by
/// the returned handle — live in `private_tmp`, because the dictation take in
/// commands/whisper.rs is the same problem and used to carry its own unfixed
/// copy of this code.
fn write_private_script(code: &str) -> Result<(tempfile::TempDir, PathBuf), String> {
    crate::private_tmp::write_private_temp("lu-agent-code-", "agent-code.py", code.as_bytes())
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

    // The handle is never read, only held: dropping it deletes the directory,
    // and it must outlive the interpreter that is running the script in it.
    let (_script_dir, script_path) = write_private_script(&code)?;

    // cwd: prefer the agent's folder workspace (the repo the user picked,
    // threaded from chatCtx as workingDirectory) so a script's relative file
    // I/O lands in that repo; otherwise the per-chat sandbox (#62). Same
    // resolution order as the file_* tools and shell_execute.
    let workspace = match workingDirectory.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(wd) => PathBuf::from(wd),
        None => agent_workspace(chatId.as_deref(), Some(state)),
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
    // KF-15, and the SECOND door with this shape: a path that names no file
    // (`""`, `"."`, `"unterordner/.."`) resolves to the workspace root, and the
    // three lines below turn that root into a FILE holding the caller's bytes.
    // This is the door the MODEL calls (`file_write`), so it is the one a
    // prompt-injected model reaches first. Same guard as fs_write's — one
    // function, two call sites, because "two routes that should do the same
    // thing, only one maintained" is how this hole got here.
    crate::commands::filesystem::reject_root_as_write_target(
        &agent_workspace(chatId.as_deref(), Some(&*state)),
        &full_path,
    )?;
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
    set_chat_workspace_override_impl(&chatId, path.as_deref(), state.inner())
}

/// The body of the command above, minus the `State` wrapper — the validation
/// it performs is the reason it needs to be reachable from a test.
pub(crate) fn set_chat_workspace_override_impl(
    chat_id: &str,
    path: Option<&str>,
    state: &AppState,
) -> Result<(), String> {
    let id = chat_id.trim();
    if id.is_empty() {
        return Err("chatId cannot be empty".into());
    }
    let mut map = state.chat_workspace_overrides.lock().map_err(|e| e.to_string())?;
    match path.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(p) => {
            let pb = std::path::PathBuf::from(p);
            // This path becomes a JAIL ROOT for every later file op of this
            // chat, including the ones the remote bridge serves — so it is
            // checked here, once, instead of being trusted on every call.
            //
            // Checked, and deliberately NOT recorded as picked: `path` arrived
            // over IPC from the WebView, so recording it here would let the
            // caller write its own entry into the allowlist that constrains it.
            // The folder becomes allowed in `system::pick_folder`, i.e. when a
            // human chooses it in the native dialog — which is exactly what the
            // frontend does immediately before calling this.
            crate::commands::filesystem::validate_workspace_root(&pb)?;
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
    Ok(directory_names_in(&agent_workspace_root()))
}

/// The listing rule itself, on a root the caller names.
///
/// Split out of `list_agent_workspaces` because its test could not reach it:
/// `agent_workspace_root()` is `~/<AGENT_WORKSPACE_DIR>` with no seam, so
/// `lists_only_directory_names_sorted` had COPIED these six lines into the test
/// module and asserted on the copy. It therefore stayed green for any change to
/// the real function — sorting removed, files no longer filtered — and only ever
/// measured that `read_dir` works. One function, called by the command and by
/// the test, is what makes the test's headline true.
fn directory_names_in(root: &std::path::Path) -> Vec<String> {
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
        .collect();
    names.sort();
    names
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

/// ── Why these two no longer share a directory with every other copy ────────
///
/// `lists_only_directory_names_sorted` used the FIXED path
/// `<temp>/lu-test-agent-workspace-listing`, and it began by deleting it. Every
/// concurrent copy of this test binary used the same one, so one copy's
/// `remove_dir_all` ran between another's `create_dir_all` and its `read_dir`.
/// Measured on 01.09.2026 under the apparatus the finding was raised in — the
/// whole suite run three times over, ten rounds — it failed 5 of 30 runs, always
/// with a short list (`["alpha-aabbcc"]` instead of both names): a stranger had
/// swept the directory mid-test.
///
/// `crate::os_paths::test_dir` is the house answer and predates this test by
/// several commits — the name carries the process id and the thread id, and the
/// `Drop` sweeps up even when an assertion panics. Nothing else changes.
#[cfg(test)]
mod workspace_listing_tests {
    use super::directory_names_in;
    use std::fs;

    /// The listing rule the frontend's fallback search depends on: folder
    /// names, directories only, sorted, and a plain file is not a workspace.
    ///
    /// Asserts on the PRODUCTION function now, not on a copy of its body.
    #[test]
    fn lists_only_directory_names_sorted() {
        let root = crate::os_paths::test_dir("agent-workspace-listing");
        fs::create_dir_all(root.join("zeta-5e61db")).unwrap();
        fs::create_dir_all(root.join("alpha-aabbcc")).unwrap();
        fs::write(root.join("loose.txt"), b"not a workspace").unwrap();

        assert_eq!(
            directory_names_in(&root),
            vec!["alpha-aabbcc".to_string(), "zeta-5e61db".to_string()],
        );
    }

    /// Negative control: a root that does not exist is an empty list, not an
    /// error, so a fresh install never sees a failure here.
    #[test]
    fn missing_root_is_empty_not_an_error() {
        let parent = crate::os_paths::test_dir("agent-workspace-absent");
        let never_created = parent.join("nicht-da");
        assert!(!never_created.exists(), "the fixture must not exist");
        assert!(directory_names_in(&never_created).is_empty());
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

/// The agent's script is code, and it used to be written to a world-readable
/// temp path whose name was a millisecond timestamp — guessable, and swappable
/// between the write and the spawn.
#[cfg(test)]
mod script_file_tests {
    use super::*;

    #[test]
    fn the_script_lands_in_a_private_directory_under_an_unguessable_name() {
        let (dir_a, path_a) = write_private_script("print('a')").expect("write");
        let (dir_b, path_b) = write_private_script("print('b')").expect("write");

        assert_eq!(fs::read_to_string(&path_a).unwrap(), "print('a')");
        assert_ne!(dir_a.path(), dir_b.path(), "two runs shared a directory");
        // No timestamp, no pid: nothing a second process can compute.
        let name = dir_a.path().file_name().unwrap().to_string_lossy().to_string();
        let suffix = name.trim_start_matches("lu-agent-code-");
        assert!(suffix.len() >= 6, "name is too short to be unguessable: {name}");
        assert!(
            !suffix.chars().all(|c| c.is_ascii_digit()),
            "the name is a plain number again: {name}",
        );
        drop(dir_b);
        assert!(!path_b.exists(), "the script outlived its handle");
    }

    #[cfg(unix)]
    #[test]
    fn nothing_outside_this_user_can_read_the_script() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, path) = write_private_script("print('secret')").expect("write");

        let dmode = fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(dmode, 0o700, "temp dir is {dmode:o}, not 0700");
        let fmode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(fmode & 0o077, 0, "script is group/world accessible: {fmode:o}");
    }

    /// The whole directory goes with the handle, so no early return can leave
    /// the script behind.
    #[test]
    fn dropping_the_handle_removes_the_directory() {
        let (dir, path) = write_private_script("print('x')").expect("write");
        let dir_path = dir.path().to_path_buf();
        drop(dir);
        assert!(!path.exists());
        assert!(!dir_path.exists());
    }

    /// A name that already exists is an error, never a target: `create_new`
    /// keeps a pre-placed file (or symlink) from being written through.
    #[test]
    fn an_existing_file_is_not_written_through() {
        let (dir, path) = write_private_script("print('first')").expect("write");
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        assert!(opts.open(&path).is_err(), "create_new accepted an existing path");
        drop(dir);
    }
}

/// The override path becomes a JAIL ROOT for every later file op of that chat,
/// including the ones the remote HTTP bridge serves — so it is checked when it
/// is set, not trusted on every call.
#[cfg(test)]
mod workspace_override_tests {
    use super::*;

    #[test]
    fn a_system_or_home_root_is_refused() {
        let state = AppState::new();
        let home = dirs::home_dir().unwrap_or_default();
        let home_s = home.to_string_lossy().to_string();
        let ssh = home.join(".ssh").to_string_lossy().to_string();
        let roots: Vec<&str> = if cfg!(windows) {
            vec!["C:/", "C:/Windows", &home_s, &ssh]
        } else {
            vec!["/", "/etc", &home_s, &ssh]
        };
        for root in roots {
            let got = set_chat_workspace_override_impl("__remote__", Some(root), &state);
            assert!(got.is_err(), "{root:?} was accepted as a workspace override");
        }
        assert!(
            state.chat_workspace_overrides.lock().unwrap().is_empty(),
            "a refused root was still stored",
        );
    }

    /// The command takes its path from the WebView, so it may VALIDATE against
    /// the allowlist but must never write to it. A folder nobody chose in the
    /// native dialog is refused however ordinary it looks — otherwise a
    /// compromised renderer would simply name its own jail root and the
    /// allowlist would constrain nothing.
    #[test]
    fn a_folder_that_was_never_picked_cannot_be_made_a_workspace() {
        let state = AppState::new();
        let dir = crate::os_paths::test_dir("unpicked");
        let s = dir.to_string_lossy().to_string();

        let got = set_chat_workspace_override_impl("__remote__", Some(&s), &state);
        assert!(got.is_err(), "an unpicked folder became a jail root: {got:?}");
        assert!(
            state.chat_workspace_overrides.lock().unwrap().is_empty(),
            "a refused root was still stored",
        );
        assert!(
            crate::commands::filesystem::validate_workspace_root(&dir).is_err(),
            "the refused call still added the folder to the allowlist",
        );
    }

    /// The real flow: the user picks a folder in the native dialog (which is
    /// what puts it on the allowlist), the frontend passes that path here, and
    /// it is stored.
    #[test]
    fn a_picked_project_folder_is_stored_and_trusted_afterwards() {
        let state = AppState::new();
        let dir = crate::os_paths::test_dir("ovr");
        let s = dir.to_string_lossy().to_string();
        // `system::pick_folder` does this for real; the dialog cannot run here.
        crate::commands::filesystem::allow_root_for_test(&dir);

        set_chat_workspace_override_impl("__remote__", Some(&s), &state).expect("accepted");
        assert_eq!(
            state.chat_workspace_overrides.lock().unwrap().get("__remote__"),
            Some(&dir.to_path_buf()),
        );
        assert!(dir.is_dir(), "the folder was not created");
        assert!(crate::commands::filesystem::validate_workspace_root(&dir).is_ok());

        // Clearing still works and takes the entry with it.
        set_chat_workspace_override_impl("__remote__", None, &state).expect("cleared");
        assert!(state.chat_workspace_overrides.lock().unwrap().is_empty());
    }
}

/// KF-15, second door. `fs_write` (commands/filesystem.rs) and `file_write`
/// here are the two write routes into an agent workspace, and both had the same
/// hole: a path that names no file resolves to the workspace ROOT, and the
/// write turns that root into a regular file holding the caller's bytes. This
/// one is the door the MODEL calls.
///
/// Measured before the guard, with a chat workspace override pointing at a
/// folder that did not exist yet: all five spellings resolved to the root, and
/// `file_write`'s own three following lines left a file there containing
/// `GEHEIM`.
#[cfg(test)]
mod write_needs_a_target_tests {
    use super::*;
    use crate::state::AppState;

    /// Every spelling of "no file". The last two only collapse onto the root
    /// once `..` is applied — a check on the raw string misses them, which is
    /// why the guard measures the RESOLVED path.
    const ROOT_SPELLINGS: [&str; 5] = ["", ".", "./", "unterordner/..", "a/b/../.."];

    #[test]
    fn no_spelling_of_the_root_survives_the_write_guard() {
        let state = AppState::new();
        let parent = crate::os_paths::test_dir("kf15-agent");
        let root = parent.join("chat-9"); // the workspace — not created yet
        state
            .chat_workspace_overrides
            .lock()
            .unwrap()
            .insert("c".to_string(), root.clone());

        for spelling in ROOT_SPELLINGS {
            let full = resolve_agent_path(spelling, Some("c"), Some(&state))
                .unwrap_or_else(|e| panic!("{spelling:?} did not resolve: {e}"));
            assert_eq!(full, root, "{spelling:?} did not resolve to the workspace root");

            let got = crate::commands::filesystem::reject_root_as_write_target(
                &agent_workspace(Some("c"), Some(&state)),
                &full,
            );
            let err = got
                .err()
                .unwrap_or_else(|| panic!("{spelling:?} was accepted as a write target"));
            assert!(err.starts_with("Not a file:"), "{spelling:?}: {err}");
        }

        // A named file inside the same workspace is untouched by the guard.
        let named = resolve_agent_path("a/b/../notiz.txt", Some("c"), Some(&state)).unwrap();
        assert!(
            crate::commands::filesystem::reject_root_as_write_target(
                &agent_workspace(Some("c"), Some(&state)),
                &named,
            )
            .is_ok(),
            "the guard refused an ordinary file",
        );
        assert!(!root.exists(), "the probe created something on disk");
    }

    /// The guard has to be WIRED IN, not merely available: the composition
    /// above is the test's, and only the source says `file_write` performs it.
    /// A `State`-taking command cannot be called from a unit test without
    /// Tauri's `test` feature, which this crate does not build with.
    #[test]
    fn file_write_actually_calls_the_guard() {
        const SRC: &str = include_str!("agent.rs");
        let at = SRC.find("pub fn file_write(").expect("file_write is gone");
        let body_end = at + SRC[at..].find("\n}\n").expect("unterminated file_write");
        let body = &SRC[at..body_end];
        assert!(
            body.contains("reject_root_as_write_target("),
            "file_write lost the KF-15 guard: {body}",
        );
        // …and before anything is created, or the guard is decoration.
        let guard_at = body.find("reject_root_as_write_target(").unwrap();
        let mkdir_at = body.find("create_dir_all(").expect("file_write stopped creating parents");
        assert!(guard_at < mkdir_at, "the guard runs after the directory is created");
    }
}
