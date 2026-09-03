use crate::os_error;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

use std::path::{Path, PathBuf};

/// Resolve the per-chat agent workspace (`~/agent-workspace/<chat_id>/`).
/// Mirrors commands/filesystem.rs::resolve_path so shell output lands in the
/// SAME folder the file tools write to. Used as the fallback cwd when the
/// caller doesn't pass one — without it the child process inherits the LU
/// app's ambient cwd and dumps build output into ~/Documents (David 2026-06-04).
///
/// The slug comes from `agent::sanitize_chat_slug`, the one copy that drops
/// `.`: this file used to carry its own that kept it, so a chat id of ".."
/// resolved to `~/agent-workspace/..` == `$HOME` and the shell tool ran (and
/// created directories) straight in the user's home (audit IPC-1).
fn workspace_cwd(chat_id: Option<&str>) -> PathBuf {
    crate::os_paths::agent_workspace_root()
        .join(crate::commands::agent::sanitize_chat_slug(chat_id.unwrap_or("default")))
}

/// How much of a command's output travels back to the model. Anything past this
/// is still read off the pipe — it has to be, or the child blocks — but dropped.
const MAX_CAPTURE: usize = 256 * 1024;

#[derive(Default)]
pub(crate) struct Captured {
    kept: Vec<u8>,
    total: usize,
}

/// Drain a child pipe on its own thread. The pipe MUST be read while the process
/// runs: an OS pipe buffer is only tens of kilobytes, and a child that fills it
/// blocks on write forever. Reading only after `try_wait()` reports an exit
/// therefore deadlocks on any command with real output — it hit the full timeout
/// and returned nothing at all.
pub(crate) fn drain(mut pipe: impl Read + Send + 'static) -> (Arc<Mutex<Captured>>, Arc<AtomicBool>) {
    let buf = Arc::new(Mutex::new(Captured::default()));
    let done = Arc::new(AtomicBool::new(false));
    let sink = Arc::clone(&buf);
    let flag = Arc::clone(&done);
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut c) = sink.lock() {
                        c.total += n;
                        let room = MAX_CAPTURE.saturating_sub(c.kept.len());
                        if room > 0 {
                            c.kept.extend_from_slice(&chunk[..n.min(room)]);
                        }
                    }
                }
            }
        }
        flag.store(true, Ordering::Release);
    });
    (buf, done)
}

/// Decode captured bytes leniently. Build tools on a non-UTF-8 Windows codepage
/// emit bytes `read_to_string` rejects outright — that used to throw the whole
/// output away and hand the model an empty string next to a successful exit code.
pub(crate) fn captured_text(buf: &Arc<Mutex<Captured>>) -> String {
    let c = match buf.lock() {
        Ok(c) => c,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut text = String::from_utf8_lossy(&c.kept).into_owned();
    if c.total > c.kept.len() {
        text.push_str(&format!(
            "\n[output truncated: {} of {} bytes shown]",
            c.kept.len(),
            c.total
        ));
    }
    text
}

/// Every process descending from `root`, deepest last.
pub(crate) fn descendants(root: u32, sys: &sysinfo::System) -> Vec<u32> {
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for (pid, proc_) in sys.processes() {
        if let Some(parent) = proc_.parent() {
            children.entry(parent.as_u32()).or_default().push(pid.as_u32());
        }
    }
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue; // PID reuse can't be allowed to make this loop forever
        }
        if pid != root {
            out.push(pid);
        }
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    out
}

/// Kill the shell AND everything it started. `Child::kill()` signals only the
/// shell itself, so a timed-out `npm run dev`, build script or spawned server
/// kept running after the tool call gave up — still holding its port and CPU,
/// and still writing into a pipe nobody reads.
pub(crate) fn kill_tree(root: u32) {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    // Leaves first: a parent that is still alive can't respawn what we killed.
    let mut order = descendants(root, &sys);
    order.reverse();
    order.push(root);
    for pid in order {
        if let Some(p) = sys.process(Pid::from_u32(pid)) {
            p.kill();
        }
    }
}

/// Run a short-lived probe command with a HARD deadline and return its stdout.
///
/// `Command::output()` waits forever, and the tools this app probes with can
/// hang for real: a wedged NVIDIA driver makes `nvidia-smi` block for minutes,
/// `wmic` stalls on a busy WMI service, `lspci` can sit on a slow bus scan.
/// Those are exactly the machines whose owner opens the Troubleshoot panel or
/// the hardware picker — and an unbounded probe left both spinning with no
/// answer at all. Returns None on timeout, spawn failure or a non-zero exit.
pub(crate) fn output_bounded(mut cmd: Command, max: std::time::Duration) -> Option<String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let (out_buf, out_done) = drain(child.stdout.take()?);
    let (_err_buf, err_done) = drain(child.stderr.take()?);
    let deadline = std::time::Instant::now() + max;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                settle(&out_done, &err_done, std::time::Duration::from_millis(200));
                return if status.success() { Some(captured_text(&out_buf)) } else { None };
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    kill_tree(child.id());
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }
}

/// Give the reader threads a moment to hit EOF after the child is gone. Never
/// joins them: a grandchild can keep the pipe open (a spawned dev server), and
/// joining would hang the command instead of returning what we already have.
pub(crate) fn settle(a: &Arc<AtomicBool>, b: &Arc<AtomicBool>, max: std::time::Duration) {
    let deadline = std::time::Instant::now() + max;
    while std::time::Instant::now() < deadline {
        if a.load(Ordering::Acquire) && b.load(Ordering::Acquire) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

/// The command line a shell wants for "run this one string as a command": the
/// program to spawn, and the arguments to hand it.
///
/// ONE copy, because there used to be two. The foreground `shell_execute`
/// derived the argument form from the shell's NAME; the background
/// `shell_task_start` derived it from the PLATFORM alone and gave PowerShell's
/// `-NoProfile -NonInteractive -Command` to whatever program the caller had
/// named. A background task with `shell: "cmd"` — a value the tool schema
/// advertises — therefore became `cmd -NoProfile -NonInteractive -Command
/// <command>`, which cmd.exe rejects flag by flag; `shell: "bash"` fared no
/// better. Only one of the two copies was ever repaired, which is the entire
/// argument for there being a single function: the same shell must produce the
/// same command line whether the task runs in the foreground or the background.
///
/// `windows` is a parameter rather than a `cfg!` inside the body so that BOTH
/// platforms' argument forms can be asserted from either platform's test run —
/// the Windows form is precisely the half no Mac or Linux run would otherwise
/// ever look at.
///
/// `command` stays ONE argument. It is never folded into the flag string, so
/// nothing inside it can close the argument and open a second command.
pub(crate) fn shell_argv(
    windows: bool,
    shell: Option<&str>,
    command: &str,
) -> (String, Vec<String>) {
    let shell_bin = shell
        .map(str::to_string)
        .unwrap_or_else(|| default_shell(windows).to_string());
    let name = shell_bin.to_lowercase();
    let mut args: Vec<String> = if windows && name.contains("powershell") {
        vec![
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
        ]
    } else if windows && name.contains("cmd") {
        vec!["/C".into()]
    } else {
        // Every POSIX shell — and, on Windows, anything else the caller names,
        // `pwsh` included. Unchanged from what the foreground path has always
        // done with a name it does not recognise.
        vec!["-c".into()]
    };
    args.push(command.to_string());
    (shell_bin, args)
}

/// The shell a caller gets when it names none: PowerShell on Windows, bash
/// everywhere else. This is the path every user is on today.
pub(crate) fn default_shell(windows: bool) -> &'static str {
    if windows {
        "powershell"
    } else {
        "bash"
    }
}

/// The eight arguments are the IPC contract: `#[tauri::command]` derives the
/// invoke payload from this signature, so folding them into a struct would
/// change the JSON the frontend sends. `clippy::too_many_arguments` is allowed
/// here for that reason and not as a matter of taste.
#[tauri::command]
#[allow(non_snake_case, clippy::too_many_arguments)]
pub async fn shell_execute(
    command: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    timeout: Option<u64>,
    shell: Option<String>,
    stdin: Option<String>,
    chatId: Option<String>,
    workingDirectory: Option<String>,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        shell_execute_sync(command, args, cwd, timeout, shell, stdin, chatId, workingDirectory)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Mirrors `shell_execute`'s parameter list one-to-one on purpose — it is the
/// blocking half of the same command, and a different shape here would be a
/// second place to keep in step with the frontend contract.
#[allow(clippy::too_many_arguments)]
fn shell_execute_sync(
    command: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    timeout: Option<u64>,
    shell: Option<String>,
    stdin: Option<String>,
    chat_id: Option<String>,
    working_directory: Option<String>,
) -> Result<serde_json::Value, String> {
    let timeout_ms = timeout.unwrap_or(120_000);
    // Shell name in, program + argument form out — the same function the
    // background twin in bg_tasks.rs calls, so the two cannot drift apart.
    let (shell_bin, shell_args) =
        shell_argv(cfg!(target_os = "windows"), shell.as_deref(), &command);

    let mut cmd = Command::new(&shell_bin);
    cmd.args(&shell_args);

    // Append extra args
    if let Some(extra_args) = args {
        for a in extra_args {
            cmd.arg(&a);
        }
    }

    // Working directory. Use the explicit cwd when it exists; otherwise fall
    // back to the per-chat agent workspace (created if missing) so a relative
    // command never runs in the app's ambient cwd and scatters files into
    // ~/Documents (David 2026-06-04). Mirrors the file tools' path resolution.
    let workdir: PathBuf = match cwd.as_ref().map(Path::new) {
        Some(p) if p.is_dir() => p.to_path_buf(),
        _ => match working_directory.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            // Folder workspace (the user's repo, from chatCtx.workingDirectory)
            // wins over the per-chat sandbox for relative commands (#62).
            Some(wd) => PathBuf::from(wd),
            None => {
                let w = workspace_cwd(chat_id.as_deref());
                let _ = std::fs::create_dir_all(&w);
                w
            }
        },
    };
    if workdir.is_dir() {
        cmd.current_dir(&workdir);
    }

    // stdin feeds a script instead of quoting it (`python -`, `bash -s`),
    // replacing the code_execute tool (2.6.6 merge) and its PowerShell
    // quoting trap along the way. No stdin stays Stdio::null so interactive
    // commands still fail fast instead of hanging on a silent read.
    if stdin.is_some() {
        cmd.stdin(Stdio::piped());
    } else {
        cmd.stdin(Stdio::null());
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| format!("Spawn shell: {}", os_error::english(&e)))?;

    // Write on a thread: the child may fill its output pipes before it has
    // consumed stdin, and a blocking write here would deadlock against the
    // drain below.
    if let Some(input) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            std::thread::spawn(move || {
                use std::io::Write;
                let _ = pipe.write_all(input.as_bytes());
                // Dropping the pipe closes it, which is the EOF `bash -s`
                // and `python -` wait for.
            });
        }
    }

    // Start draining both pipes immediately — see `drain`.
    let (out_buf, out_done) = match child.stdout.take() {
        Some(p) => drain(p),
        None => (Arc::new(Mutex::new(Captured::default())), Arc::new(AtomicBool::new(true))),
    };
    let (err_buf, err_done) = match child.stderr.take() {
        Some(p) => drain(p),
        None => (Arc::new(Mutex::new(Captured::default())), Arc::new(AtomicBool::new(true))),
    };

    let start = std::time::Instant::now();
    let timeout_dur = std::time::Duration::from_millis(timeout_ms);

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                settle(&out_done, &err_done, std::time::Duration::from_millis(500));
                return Ok(serde_json::json!({
                    "stdout": captured_text(&out_buf),
                    "stderr": captured_text(&err_buf),
                    "exitCode": status.code().unwrap_or(-1),
                    "timedOut": false,
                }));
            }
            Ok(None) => {
                if start.elapsed() > timeout_dur {
                    kill_tree(child.id());
                    let _ = child.kill();
                    let _ = child.wait(); // reap, or the shell lingers as a zombie
                    settle(&out_done, &err_done, std::time::Duration::from_millis(200));
                    // Hand back whatever the command managed to print. A build
                    // that dies on the timeout still tells the model where it got.
                    let mut stderr_str = captured_text(&err_buf);
                    if !stderr_str.is_empty() {
                        stderr_str.push('\n');
                    }
                    stderr_str.push_str(&format!("Execution timed out after {}ms", timeout_ms));
                    return Ok(serde_json::json!({
                        "stdout": captured_text(&out_buf),
                        "stderr": stderr_str,
                        "exitCode": -1,
                        "timedOut": true,
                    }));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(format!("Wait error: {}", e)),
        }
    }
}

/// The argument form, asserted for both platforms from either platform.
///
/// `shell_argv` takes `windows` as a parameter precisely so this module can
/// pin the Windows command lines on a Mac and the Unix ones on Windows. The
/// bug that made the function necessary lived in the Windows half and was
/// therefore invisible to every non-Windows test run there had ever been.
#[cfg(test)]
mod shell_dialect_tests {
    use super::shell_argv;

    const WINDOWS: bool = true;
    const UNIX: bool = false;
    const CMD: &str = "echo hi";

    fn argv(windows: bool, shell: Option<&str>) -> (String, Vec<String>) {
        shell_argv(windows, shell, CMD)
    }

    fn args_of(windows: bool, shell: &str) -> Vec<String> {
        argv(windows, Some(shell)).1
    }

    fn powershell_form() -> Vec<String> {
        vec![
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            CMD.to_string(),
        ]
    }

    fn cmd_form() -> Vec<String> {
        vec!["/C".to_string(), CMD.to_string()]
    }

    fn posix_form() -> Vec<String> {
        vec!["-c".to_string(), CMD.to_string()]
    }

    /// The path every user is on today — no `shell` named at all. Windows gets
    /// PowerShell with `-Command`, Unix gets bash with `-c`, exactly as before
    /// the two branches were merged into one function.
    #[test]
    fn the_default_shell_is_unchanged_on_both_platforms() {
        assert_eq!(
            argv(WINDOWS, None),
            ("powershell".to_string(), powershell_form()),
        );
        assert_eq!(argv(UNIX, None), ("bash".to_string(), posix_form()));
    }

    /// On Windows the form follows the name, including a full path to the
    /// binary and the `.exe` suffix — the spellings a caller actually sends.
    #[test]
    fn windows_gets_the_form_of_the_shell_it_was_named() {
        for ps in [
            "powershell",
            "PowerShell",
            "powershell.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        ] {
            assert_eq!(args_of(WINDOWS, ps), powershell_form(), "{ps}");
        }
        for c in ["cmd", "CMD", "cmd.exe", r"C:\Windows\System32\cmd.exe"] {
            assert_eq!(args_of(WINDOWS, c), cmd_form(), "{c}");
        }
        // The two the background path used to break outright.
        for posix in ["bash", "sh", r"C:\Program Files\Git\bin\bash.exe"] {
            assert_eq!(args_of(WINDOWS, posix), posix_form(), "{posix}");
        }
    }

    /// PowerShell's flags are a Windows-only dialect. A `powershell` named on
    /// a Mac is a POSIX-style invocation like everything else there.
    #[test]
    fn unix_never_gets_windows_flags() {
        for shell in ["bash", "sh", "zsh", "/bin/sh", "powershell", "cmd"] {
            assert_eq!(args_of(UNIX, shell), posix_form(), "{shell}");
        }
    }

    /// The program is the shell the caller named, never a rewritten one.
    #[test]
    fn the_program_is_the_shell_that_was_named() {
        assert_eq!(argv(WINDOWS, Some("cmd.exe")).0, "cmd.exe");
        assert_eq!(argv(UNIX, Some("/bin/zsh")).0, "/bin/zsh");
    }

    /// No shell injection: the command travels as ONE argument, byte for byte,
    /// and never gets concatenated onto a flag. Quotes, `&&`, semicolons and
    /// newlines inside it are the shell's problem to parse, not a way to add a
    /// second argument to the shell's own command line.
    #[test]
    fn the_command_stays_a_single_argument() {
        let nasty = "echo \"a\" && whoami ; echo 'b'\nrm -rf /";
        for (windows, shell, flags) in [
            (WINDOWS, "powershell", 3usize),
            (WINDOWS, "cmd", 1),
            (WINDOWS, "bash", 1),
            (UNIX, "bash", 1),
        ] {
            let (_, args) = shell_argv(windows, Some(shell), nasty);
            assert_eq!(args.len(), flags + 1, "{shell} on windows={windows}");
            assert_eq!(args.last().map(String::as_str), Some(nasty));
        }
    }
}

/// The IPC surface itself, asserted against the shipped config files.
///
/// `shell:allow-spawn` is the only permission the WebView holds that starts a
/// process, and it used to list ~20 programs with `"args": true` — every
/// interpreter with a one-shot eval flag plus `docker`. Combined with
/// `withGlobalTauri`, that turned any script-execution bug in the WebView into
/// `node -e "…"` with the user's rights. These tests fail the moment either
/// half comes back.
#[cfg(test)]
mod ipc_surface_tests {
    use std::path::PathBuf;

    fn manifest_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    fn read_json(rel: &str) -> serde_json::Value {
        let p = manifest_dir().join(rel);
        let raw = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {p:?}: {e}"));
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {p:?}: {e}"))
    }

    #[test]
    fn the_spawn_allow_list_carries_no_general_purpose_interpreter() {
        let cap = read_json("capabilities/default.json");
        let mut spawn_entries = Vec::new();
        for perm in cap["permissions"].as_array().expect("permissions") {
            if perm.get("identifier").and_then(|v| v.as_str()) == Some("shell:allow-spawn") {
                for entry in perm["allow"].as_array().expect("allow list") {
                    spawn_entries.push(entry.clone());
                }
            }
        }
        assert!(!spawn_entries.is_empty(), "no shell:allow-spawn entry found");

        // Every one of the NINETEEN entries the hardening commit removed, and
        // not a subset: the list had 15, so `bunx`, `bunx.cmd`, `pnpm.cmd` and
        // `yarn.cmd` could have been put back without a single test noticing.
        // `bunx` is the one that matters most — it is npx's exact equivalent,
        // it fetches a package off the network and runs it, and it was in the
        // allow-list with `"args": true`.
        //
        // Anything that runs code handed to it on the command line, or that
        // runs whatever a package.json / image says.
        const BANNED: [&str; 19] = [
            "node", "node.cmd", "deno", "deno.cmd",
            "bun", "bun.cmd", "bunx", "bunx.cmd",
            "python", "python3", "py", "docker",
            "npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "uv",
        ];
        for entry in &spawn_entries {
            let name = entry["name"].as_str().unwrap_or_default().to_lowercase();
            let cmd = entry["cmd"].as_str().unwrap_or_default().to_lowercase();
            for bad in BANNED {
                assert_ne!(cmd, bad, "{bad} is back in the spawn allow-list");
                assert_ne!(name, bad, "{bad} is back in the spawn allow-list");
            }
        }
    }

    /// `withGlobalTauri` publishes the whole JS API on `window.__TAURI__`, i.e.
    /// hands any injected script a ready-made `shell.Command` without it having
    /// to know the internal invoke shape. The app detects its runtime through
    /// `__TAURI_INTERNALS__` (see `isTauri` in src/api/backend.ts), which Tauri
    /// injects regardless, so nothing needs the global.
    #[test]
    fn the_full_js_api_is_not_published_on_the_window_object() {
        let conf = read_json("tauri.conf.json");
        assert_eq!(
            conf["app"]["withGlobalTauri"],
            serde_json::Value::Bool(false),
            "withGlobalTauri is back on",
        );
    }

    /// The reason turning it off is safe — asserted instead of assumed. A
    /// `window.__TAURI__.something` anywhere in the frontend would go undefined
    /// at runtime with no compile-time warning.
    #[test]
    fn no_frontend_code_calls_through_the_global() {
        let src = manifest_dir().join("..").join("src");
        if !src.is_dir() {
            return; // source-less build tree: nothing to check
        }
        let mut offenders: Vec<String> = Vec::new();
        for entry in walkdir::WalkDir::new(&src).into_iter().filter_map(|e| e.ok()) {
            let p = entry.path();
            let is_source = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| matches!(e, "ts" | "tsx" | "js" | "jsx" | "html"))
                .unwrap_or(false);
            if !is_source {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(p) {
                for (i, line) in text.lines().enumerate() {
                    // A member access, not the `w.__TAURI__` presence check.
                    if line.contains("__TAURI__.") {
                        offenders.push(format!("{}:{}", p.display(), i + 1));
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "these still call through window.__TAURI__: {offenders:?}",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn capture(bytes: Vec<u8>) -> String {
        let (buf, done) = drain(Cursor::new(bytes));
        settle(&done, &done, std::time::Duration::from_secs(2));
        captured_text(&buf)
    }

    #[test]
    fn output_survives_bytes_that_are_not_utf8() {
        // "Grüße" in CP1252 — what a Windows build tool prints. read_to_string
        // used to reject this and leave the model with an empty result.
        let text = capture(vec![b'G', b'r', 0xfc, 0xdf, b'e']);
        assert!(text.starts_with("Gr"), "lost the output: {:?}", text);
        assert!(text.ends_with('e'), "lost the tail: {:?}", text);
    }

    #[test]
    fn oversized_output_is_capped_and_says_so() {
        let text = capture(vec![b'x'; MAX_CAPTURE + 5_000]);
        assert!(text.contains("output truncated"), "no truncation note: {:?}", &text[..64]);
        assert!(text.len() < MAX_CAPTURE + 200);
    }

    #[test]
    fn small_output_comes_back_whole_and_unannotated() {
        let text = capture(b"hello\n".to_vec());
        assert_eq!(text, "hello\n");
    }

    /// The shell tool creates its fallback cwd with `create_dir_all`. With the
    /// local sanitiser copy that still allowed `.`, a chat id of ".." resolved
    /// to `~/agent-workspace/..` — the user's HOME — and every relative command
    /// from that chat ran there (audit IPC-1, fixed in agent.rs only).
    #[test]
    fn a_dotted_chat_id_cannot_walk_the_cwd_out_of_the_workspace() {
        let root = crate::os_paths::agent_workspace_root();
        for id in ["..", ".", "../..", "a.b"] {
            let cwd = workspace_cwd(Some(id));
            assert!(cwd.starts_with(&root), "id {id:?} escaped to {cwd:?}");
            assert_ne!(cwd, root, "id {id:?} landed on the workspace root itself");
            // Only the SLUG, never the whole path: a machine whose home is
            // /Users/max.mustermann has a dot in every path under it, and this
            // assertion used to fail there for a reason that has nothing to do
            // with the chat id.
            //
            // The last COMPONENT, not `file_name()`: `file_name()` answers None
            // for a path ending in `..`, which is precisely the id this is
            // guarding against — the check would pass by not looking.
            let slug = cwd
                .components()
                .next_back()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .unwrap_or_default();
            assert!(
                !slug.contains('.'),
                "id {id:?} kept a dot in its folder name: {slug:?} (from {cwd:?})",
            );
        }
        // Ordinary ids keep their own folder.
        assert_eq!(workspace_cwd(Some("coding-agent-8b0c71")), root.join("coding-agent-8b0c71"));
        assert_eq!(workspace_cwd(None), root.join("default"));
    }

    #[cfg(unix)]
    #[test]
    fn a_bounded_probe_returns_output_and_gives_up_on_a_hang() {
        use std::process::Command;
        use std::time::{Duration, Instant};

        let mut ok = Command::new("bash");
        ok.arg("-c").arg("echo '12288, 4096'");
        assert_eq!(
            output_bounded(ok, Duration::from_secs(5)).as_deref().map(str::trim),
            Some("12288, 4096"),
        );

        // A wedged probe must not hold the caller hostage.
        let mut hang = Command::new("bash");
        hang.arg("-c").arg("sleep 30");
        let started = Instant::now();
        assert!(output_bounded(hang, Duration::from_millis(400)).is_none());
        assert!(started.elapsed() < Duration::from_secs(5), "the deadline did not bite");

        // A non-zero exit reads as "no answer", same as before.
        let mut fails = Command::new("bash");
        fails.arg("-c").arg("exit 3");
        assert!(output_bounded(fails, Duration::from_secs(5)).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_timeout_takes_the_grandchildren_with_it() {
        use std::process::{Command, Stdio};
        let mut child = Command::new("bash")
            .arg("-c")
            .arg("sleep 40 & sleep 40")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn bash");
        let pid = child.id();
        std::thread::sleep(std::time::Duration::from_millis(400));

        let mut sys = sysinfo::System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let spawned = descendants(pid, &sys);
        assert!(!spawned.is_empty(), "bash spawned nothing — test setup is wrong");

        kill_tree(pid);
        let _ = child.wait();

        // The grandchildren are reparented to init, which reaps them.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let mut check = sysinfo::System::new();
            check.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            let alive: Vec<u32> = spawned
                .iter()
                .copied()
                .filter(|p| check.process(sysinfo::Pid::from_u32(*p)).is_some())
                .collect();
            if alive.is_empty() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "these survived the kill: {:?}",
                alive
            );
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
}
