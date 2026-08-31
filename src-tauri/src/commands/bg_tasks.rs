//! Background shell tasks — Sprint C #7.
//!
//! Spawns a shell command as a detached subprocess and keeps it tracked
//! in a process-wide registry keyed by a UUID. The browser polls
//! `shell_task_status` (or lists everything via `shell_task_list`) and
//! can `shell_task_kill` to cancel. Stdout/stderr are tail-buffered
//! (last 64 KiB each) so a long-running script's tail is always
//! available even after the browser reconnects.
//!
//! Architectural decision: we deliberately do NOT use a Tokio task per
//! waiter. Each spawned child has one reader task that pumps bytes into
//! the tail buffer + updates exit status when the process ends; client
//! requests resolve from that buffer synchronously. This means the
//! browser tab can close and reopen without losing any output.
//!
//! Ported 1:1 from uselu's `apps/bridge/src/commands/bg_tasks.rs` —
//! every body is identical; only the outermost layer is wrapped in
//! `#[tauri::command]` for the desktop IPC bridge.

use crate::os_error;
use crate::commands::{bad_request, internal, not_found, CmdResult};
use crate::state::AppState;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::io::AsyncReadExt;
use tokio::process::Command as TokioCommand;
use uuid::Uuid;

// tokio::process::Command has `creation_flags` as an inherent method on
// Windows (since tokio 1.6) so no `CommandExt` trait import is needed.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const TAIL_BYTES: usize = 64 * 1024;

/// How often the reader task checks whether the child has exited.
///
/// It polls instead of awaiting `child.wait()` because the reap has to happen
/// under the task lock, together with clearing the pid — see the loop in
/// `shell_task_start_impl`. These tasks are builds and installs; 50 ms of
/// latency on noticing the exit of a multi-minute command is not observable,
/// and it buys an ordering the shutdown sweep can rely on.
const REAP_POLL: std::time::Duration = std::time::Duration::from_millis(50);

#[derive(Clone, Debug, Serialize)]
pub struct BgTaskStatus {
    pub id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub exit_code: Option<i32>,
    pub running: bool,
    pub cancelled: bool,
    /// Tail of combined stdout+stderr (last ~64 KiB).
    pub output_tail: String,
}

struct BgTaskInner {
    status: BgTaskStatus,
    /// stdout + stderr appended together — order-preserving for the user.
    output_buf: Vec<u8>,
    /// Send `()` to ask the reader task to terminate the child.
    cancel_tx: Option<tokio::sync::oneshot::Sender<()>>,
    /// The shell's pid, kept out of the serialized status. The reader task owns
    /// the `Child`, so this is the only handle the shutdown sweep below has on
    /// a task it must kill.
    pid: Option<u32>,
}

#[derive(Clone)]
struct BgTask {
    inner: Arc<Mutex<BgTaskInner>>,
}

#[derive(Default)]
struct BgRegistry {
    tasks: Mutex<Vec<BgTask>>,
}

impl BgRegistry {
    fn insert(&self, t: BgTask) {
        let mut g = self.tasks.lock().unwrap();
        // Cap the registry at 200 tasks — drop the oldest *finished* one
        // when we hit the cap so live tasks never get evicted by accident.
        if g.len() >= 200 {
            if let Some(idx) = g
                .iter()
                .position(|t| !t.inner.lock().unwrap().status.running)
            {
                g.remove(idx);
            }
        }
        g.push(t);
    }
    fn get(&self, id: &str) -> Option<BgTask> {
        self.tasks
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.inner.lock().unwrap().status.id == id)
            .cloned()
    }
    fn list(&self) -> Vec<BgTaskStatus> {
        self.tasks
            .lock()
            .unwrap()
            .iter()
            .map(|t| t.inner.lock().unwrap().status.clone())
            .collect()
    }
}

static REGISTRY: Lazy<BgRegistry> = Lazy::new(BgRegistry::default);

/// Test isolation for the process-wide registry.
///
/// `kill_all_background_tasks` kills every RUNNING task in the registry, and
/// the registry is one static shared by every test in this binary — so a test
/// that sweeps and a test that is standing up a live task must not overlap, or
/// the second one loses its child to the first one's quit. Both kinds hold this
/// lock. (Poisoning is ignored on purpose: a panicking test has already failed,
/// and turning that into a cascade of poisoned-lock failures hides which one.)
#[cfg(test)]
static SWEEP_ISOLATION: Mutex<()> = Mutex::new(());

#[cfg(test)]
fn sweep_isolation() -> std::sync::MutexGuard<'static, ()> {
    SWEEP_ISOLATION.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn append_tail(buf: &mut Vec<u8>, bytes: &[u8]) {
    buf.extend_from_slice(bytes);
    if buf.len() > TAIL_BYTES {
        let excess = buf.len() - TAIL_BYTES;
        buf.drain(0..excess);
    }
}

fn render_tail(buf: &[u8]) -> String {
    // Lossy UTF-8 is fine — the browser only needs to *read* the tail.
    String::from_utf8_lossy(buf).to_string()
}

#[derive(Deserialize)]
struct StartArgs {
    command: String,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    shell: Option<String>,
    // Same chat context the flat `shell_execute` path carries, so a background
    // task defaults to the SAME folder its foreground twin would use.
    #[serde(default)]
    chat_id: Option<String>,
    #[serde(default)]
    working_directory: Option<String>,
}

// ── Internal impls (verbatim from uselu, sans &AppState) ──────────────
// The Tauri-command wrappers below delegate here. Tests bypass the
// State-wrapping layer and call these directly — same as uselu's tests
// did against the originally `pub` fns with a hand-built `AppState`.

pub(crate) async fn shell_task_start_impl(args: &Value) -> CmdResult {
    let a: StartArgs =
        serde_json::from_value(args.clone()).map_err(|e| bad_request(e.to_string()))?;
    if a.command.trim().is_empty() {
        return Err(bad_request("command is empty"));
    }
    // Without an explicit cwd the child used to inherit LU's OWN process
    // directory — the install folder on Windows. The tool exists for
    // `pnpm install` / `cargo build`, so a task the model started "in the
    // project" ran somewhere else entirely. Fall back to the workspace the
    // foreground shell tool resolves.
    let cwd = match a.cwd.clone() {
        Some(c) => Some(c),
        None => crate::commands::filesystem::workspace_root(
            a.chat_id.as_deref(),
            a.working_directory.as_deref(),
        )
        .to_str()
        .map(|s| s.to_string())
        .filter(|s| std::path::Path::new(s).is_dir()),
    };
    if let Some(cwd) = &cwd {
        let p = std::path::Path::new(cwd);
        if !p.is_dir() {
            return Err(bad_request(format!("cwd does not exist: {}", cwd)));
        }
    }

    let id = Uuid::new_v4().to_string();
    let (program, args_vec) = if cfg!(target_os = "windows") {
        let shell = a.shell.unwrap_or_else(|| "powershell".into());
        (
            shell,
            vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                a.command.clone(),
            ],
        )
    } else {
        let shell = a.shell.unwrap_or_else(|| "bash".into());
        (shell, vec!["-c".into(), a.command.clone()])
    };

    let mut cmd = TokioCommand::new(&program);
    cmd.args(&args_vec);
    if let Some(cwd) = &cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| internal(format!("spawn {}: {}", program, os_error::english(&e))))?;

    // Orphan-safety: tie the child to a kill-on-close Job Object so a true app
    // Quit (tray Quit / parent death) tears these long-running background tasks
    // down too — matching how Ollama/ComfyUI are handled. shutdown_subprocesses
    // (state.rs) only knows the AppState-held PIDs, never this static REGISTRY,
    // so without this a `shell_execute_background` task (e.g. a long build) would
    // be orphaned on Windows after Quit. (v2.5.0 audit fix.)
    #[cfg(target_os = "windows")]
    if let Some(pid) = child.id() {
        crate::commands::process::assign_pid_to_kill_on_close_job(pid);
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();

    let inner = Arc::new(Mutex::new(BgTaskInner {
        status: BgTaskStatus {
            id: id.clone(),
            command: a.command.clone(),
            cwd: cwd.clone(),
            started_at: now_secs(),
            finished_at: None,
            exit_code: None,
            running: true,
            cancelled: false,
            output_tail: String::new(),
        },
        output_buf: Vec::with_capacity(8 * 1024),
        cancel_tx: Some(cancel_tx),
        pid: child.id(),
    }));
    arm_exit_sweep();

    REGISTRY.insert(BgTask {
        inner: Arc::clone(&inner),
    });

    let reader_inner = Arc::clone(&inner);
    tokio::spawn(async move {
        // Pump stdout + stderr into the tail buffer concurrently.
        let inner_so = Arc::clone(&reader_inner);
        let inner_se = Arc::clone(&reader_inner);
        let stdout_task = tokio::spawn(async move {
            if let Some(mut s) = stdout {
                let mut tmp = [0u8; 4096];
                loop {
                    match s.read(&mut tmp).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut g = inner_so.lock().unwrap();
                            append_tail(&mut g.output_buf, &tmp[..n]);
                        }
                    }
                }
            }
        });
        let stderr_task = tokio::spawn(async move {
            if let Some(mut s) = stderr {
                let mut tmp = [0u8; 4096];
                loop {
                    match s.read(&mut tmp).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut g = inner_se.lock().unwrap();
                            append_tail(&mut g.output_buf, &tmp[..n]);
                        }
                    }
                }
            }
        });

        // REAPING THE CHILD FREES ITS PID, and the shutdown sweep kills by pid.
        // Those two must never be able to interleave.
        //
        // `tokio::select! { child.wait() }` could not give us that: the reap
        // happens inside the await, while `pid` stays in the registry until
        // this task takes the lock again — which is only after both readers
        // have drained, and a grandchild that inherited the pipe can keep them
        // draining for minutes. Everything in that window was a kill aimed at a
        // number the kernel had already handed to somebody else, and this
        // module's tasks are `pnpm install` / `cargo build`, so "somebody else"
        // is whatever the user started next.
        //
        // The reap is therefore a non-blocking `try_wait` performed while
        // HOLDING the task lock, in the same critical section that clears the
        // pid — and the sweep kills while holding that same lock (see
        // `kill_all_background_tasks`). Either the sweep sees a pid that is
        // still a live process, or it sees none. The price is one poll interval
        // of latency on noticing the exit of a task that runs for minutes by
        // design.
        let mut cancel_rx = cancel_rx;
        let (exit_code, cancelled) = loop {
            let cancel_requested = tokio::select! {
                biased;
                _ = &mut cancel_rx => true,
                _ = tokio::time::sleep(REAP_POLL) => false,
            };
            if cancel_requested {
                // Nothing has reaped this child — this task is its only reaper
                // and it is right here — so the pid still means what it meant
                // at spawn. Take it out of the registry BEFORE the kill below
                // reaps it, so the sweep cannot pick it up afterwards.
                let pid = reader_inner.lock().unwrap().pid.take();
                // `child.kill()` sends SIGKILL to the SHELL only. This module
                // exists for `pnpm install` / `cargo build` — the commands with
                // the deepest process trees — so cancelling used to leave the
                // actual worker running detached, exactly the bug 743c310 fixed
                // for the foreground shell tool. The Windows job object does not
                // help here either: it fires when LU dies, not on a cancel.
                if let Some(pid) = pid {
                    crate::commands::shell::kill_tree(pid);
                }
                let _ = child.kill().await;
                break (None, true);
            }
            let mut g = reader_inner.lock().unwrap();
            match child.try_wait() {
                Ok(Some(status)) => {
                    g.pid = None;
                    break (status.code(), false);
                }
                // Still running: keep the pid, it still addresses this process.
                Ok(None) => {}
                Err(_) => {
                    // We can no longer tell whether it is alive, so the pid is
                    // no longer safe to shoot at.
                    g.pid = None;
                    break (None, false);
                }
            }
        };
        // Wait for readers to drain so the tail is final.
        let _ = stdout_task.await;
        let _ = stderr_task.await;
        let mut g = reader_inner.lock().unwrap();
        g.status.exit_code = exit_code;
        g.status.cancelled = cancelled;
        g.status.running = false;
        g.status.finished_at = Some(now_secs());
        g.status.output_tail = render_tail(&g.output_buf);
        g.cancel_tx = None;
        // Already cleared above, in the same critical section as the reap —
        // this only pins the invariant for any path that reaches here without
        // going through the loop. Clearing it HERE was the whole bug: by this
        // line the process has been reaped for as long as the readers took to
        // drain, and the number has belonged to a stranger for just as long.
        debug_assert!(g.pid.is_none(), "a finished task still carries a reaped pid");
        g.pid = None;
    });

    Ok(json!({ "id": id }))
}

#[derive(Deserialize)]
struct IdArgs {
    id: String,
}

pub(crate) async fn shell_task_status_impl(args: &Value) -> CmdResult {
    let a: IdArgs = serde_json::from_value(args.clone()).map_err(|e| bad_request(e.to_string()))?;
    let task = REGISTRY
        .get(&a.id)
        .ok_or_else(|| not_found(format!("task not found: {}", a.id)))?;
    let mut g = task.inner.lock().unwrap();
    // Refresh the tail every time so live tasks aren't stuck at start-time.
    g.status.output_tail = render_tail(&g.output_buf);
    Ok(json!(g.status))
}

pub(crate) async fn shell_task_kill_impl(args: &Value) -> CmdResult {
    let a: IdArgs = serde_json::from_value(args.clone()).map_err(|e| bad_request(e.to_string()))?;
    let task = REGISTRY
        .get(&a.id)
        .ok_or_else(|| not_found(format!("task not found: {}", a.id)))?;
    let tx = {
        let mut g = task.inner.lock().unwrap();
        g.cancel_tx.take()
    };
    if let Some(tx) = tx {
        let _ = tx.send(());
        Ok(json!({ "ok": true, "cancelled": true }))
    } else {
        Ok(json!({ "ok": true, "cancelled": false, "reason": "already finished" }))
    }
}

/// Kill every still-running background task, children included.
///
/// These tasks exist for `pnpm install` / `cargo build`, so they are long-lived
/// by design and their trees are deep. Windows ties each one to a kill-on-close
/// Job Object at spawn, so LU dying takes them along; macOS and Linux have no
/// equivalent, and `AppState::shutdown_subprocesses` only knows the pids IT
/// holds — never this process-wide REGISTRY. A background build therefore
/// outlived every quit, forever, still holding its port and CPU.
// On Windows only the tests reach it — the Job Object gets there first.
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub(crate) fn kill_all_background_tasks() {
    let tasks: Vec<BgTask> = {
        // try_lock, not lock: this also runs from the process-exit hook, where
        // a thread that is holding the registry mutex may never be scheduled
        // again. Losing the sweep beats hanging the quit.
        let mut got = None;
        for _ in 0..20 {
            if let Ok(g) = REGISTRY.tasks.try_lock() {
                got = Some(g.iter().cloned().collect::<Vec<BgTask>>());
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        match got {
            Some(t) => t,
            None => return,
        }
    };
    for task in tasks {
        // Kill while HOLDING the task's own lock, rather than collecting pids
        // and firing afterwards. That lock is what makes the pid mean anything:
        // the reader task reaps and clears the pid inside the same critical
        // section, so a pid read here cannot be freed — and handed to a
        // stranger — before the kill goes out. Reading it and releasing first
        // reopened exactly the window this is closing.
        let inner = match lock_briefly(&task) {
            Some(g) => g,
            None => continue,
        };
        if !inner.status.running {
            continue;
        }
        // Read, do not take: the reader task is the one that clears the pid,
        // and it does so in the same breath as the reap. Holding the lock is
        // what makes the number valid here; removing it would only hide the
        // task from a second sweep, which is already harmless.
        if let Some(pid) = inner.pid {
            crate::commands::shell::kill_tree(pid);
        }
    }
}

/// `try_lock` with a short retry — same reasoning as the registry lock above:
/// never block the quit forever, but do not give up on the first contention
/// either (the reader task holds this lock for a `try_wait` at a time).
fn lock_briefly(task: &BgTask) -> Option<std::sync::MutexGuard<'_, BgTaskInner>> {
    for _ in 0..20 {
        if let Ok(g) = task.inner.try_lock() {
            return Some(g);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    None
}

/// Run the sweep when the process exits.
///
/// Every quit path ends in `exit()` — the tray Quit, `exit_app`, the updater,
/// Tauri's own `RunEvent::Exit` — and a C `atexit` handler fires on all of
/// them, including the ones that never construct or drop `AppState`. Windows
/// needs none of this: the Job Object from `shell_task_start_impl` already
/// kills the tree when the app's handle closes.
#[cfg(not(target_os = "windows"))]
fn arm_exit_sweep() {
    use std::sync::Once;
    static ARMED: Once = Once::new();
    extern "C" fn sweep() {
        kill_all_background_tasks();
    }
    extern "C" {
        fn atexit(cb: extern "C" fn()) -> std::os::raw::c_int;
    }
    ARMED.call_once(|| unsafe {
        atexit(sweep);
    });
}

#[cfg(target_os = "windows")]
fn arm_exit_sweep() {}

pub(crate) async fn shell_task_list_impl(_args: &Value) -> CmdResult {
    let mut tasks = REGISTRY.list();
    // Reverse-chronological — newest first reads better in the UI.
    tasks.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(json!({ "tasks": tasks }))
}

// ── Tauri-callable wrappers ───────────────────────────────────────────

#[tauri::command]
pub async fn shell_task_start(
    _state: tauri::State<'_, AppState>,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    shell_task_start_impl(&args).await
}

#[tauri::command]
pub async fn shell_task_status(
    _state: tauri::State<'_, AppState>,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    shell_task_status_impl(&args).await
}

#[tauri::command]
pub async fn shell_task_kill(
    _state: tauri::State<'_, AppState>,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    shell_task_kill_impl(&args).await
}

#[tauri::command]
pub async fn shell_task_list(
    _state: tauri::State<'_, AppState>,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    shell_task_list_impl(&args).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // `echo` works on Linux/macOS; PowerShell's `Write-Output` works on
    // Windows. The spawn path picks the right shell automatically based
    // on `cfg!(target_os = "windows")`.
    fn echo_cmd(msg: &str) -> String {
        if cfg!(target_os = "windows") {
            format!("Write-Output {}", msg)
        } else {
            format!("echo {}", msg)
        }
    }
    fn sleep_cmd_30s() -> &'static str {
        if cfg!(target_os = "windows") {
            "Start-Sleep -Seconds 30"
        } else {
            "sleep 30"
        }
    }

    #[tokio::test]
    async fn start_runs_a_command_and_status_eventually_reports_finished() {
        let r = shell_task_start_impl(&json!({ "command": echo_cmd("hi") }))
            .await
            .unwrap();
        let id = r["id"].as_str().unwrap().to_string();
        // Poll for completion (test envs vary; cap at 5s).
        for _ in 0..50 {
            let s = shell_task_status_impl(&json!({ "id": id })).await.unwrap();
            if !s["running"].as_bool().unwrap_or(true) {
                assert_eq!(s["exit_code"].as_i64(), Some(0));
                assert!(s["output_tail"].as_str().unwrap_or("").contains("hi"));
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("command never finished");
    }

    #[tokio::test]
    async fn start_rejects_empty_commands() {
        let err = shell_task_start_impl(&json!({ "command": "" })).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn status_returns_404_for_unknown_id() {
        let err = shell_task_status_impl(&json!({ "id": "nonexistent" })).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn kill_cancels_a_running_task() {
        let r = shell_task_start_impl(&json!({ "command": sleep_cmd_30s() }))
            .await
            .unwrap();
        let id = r["id"].as_str().unwrap().to_string();
        // Give the spawn a moment.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let _ = shell_task_kill_impl(&json!({ "id": id.clone() })).await.unwrap();
        for _ in 0..50 {
            let s = shell_task_status_impl(&json!({ "id": id.clone() })).await.unwrap();
            if !s["running"].as_bool().unwrap_or(true) {
                assert!(s["cancelled"].as_bool().unwrap_or(false));
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("kill did not cancel the task");
    }

    #[tokio::test]
    async fn list_returns_active_tasks_newest_first() {
        let r1 = shell_task_start_impl(&json!({ "command": echo_cmd("a") }))
            .await
            .unwrap();
        // Force a deterministic ordering: started_at granularity is 1s so
        // sleep through it before starting the second task.
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let r2 = shell_task_start_impl(&json!({ "command": echo_cmd("b") }))
            .await
            .unwrap();
        let id1 = r1["id"].as_str().unwrap().to_string();
        let id2 = r2["id"].as_str().unwrap().to_string();
        let listing = shell_task_list_impl(&json!({})).await.unwrap();
        let tasks = listing["tasks"].as_array().unwrap();
        let ids: Vec<&str> = tasks
            .iter()
            .map(|t| t["id"].as_str().unwrap())
            .collect();
        let pos1 = ids.iter().position(|s| *s == id1).unwrap();
        let pos2 = ids.iter().position(|s| *s == id2).unwrap();
        assert!(pos2 < pos1, "newer task should appear first");
    }
}

#[cfg(test)]
mod cancel_tests {
    use super::*;

    fn alive(pid: u32) -> bool {
        let out = std::process::Command::new("ps")
            .args(["-o", "state=", "-p", &pid.to_string()])
            .output();
        match out {
            Ok(o) => {
                let st = String::from_utf8_lossy(&o.stdout).trim().to_string();
                !st.is_empty() && !st.starts_with('Z')
            }
            Err(_) => false,
        }
    }

    /// A background task is started for the long builds — `pnpm install`,
    /// `cargo build` — so its process tree is deep by definition. Cancelling
    /// used to SIGKILL the shell alone and leave the real worker running
    /// detached, the same defect 743c310 fixed for the foreground shell tool.
    #[tokio::test]
    #[cfg_attr(target_os = "windows", ignore = "uses sh/ps")]
    async fn cancelling_takes_the_grandchild_with_it() {
        let _isolation = super::sweep_isolation();
        // The shell prints its grandchild's pid, then waits on it.
        let start = shell_task_start_impl(&json!({
            "command": "sleep 30 & echo $! ; wait",
            "shell": "sh",
        }))
        .await
        .expect("start");
        let id = start["id"].as_str().expect("id").to_string();

        // Wait for the pid line to land in the tail buffer.
        let mut grandchild = None;
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let st = shell_task_status_impl(&json!({ "id": id })).await.expect("status");
            let tail = st["output_tail"].as_str().unwrap_or("");
            if let Some(line) = tail.lines().find(|l| l.trim().parse::<u32>().is_ok()) {
                grandchild = line.trim().parse::<u32>().ok();
                break;
            }
        }
        let grandchild = grandchild.expect("grandchild never reported its pid");
        assert!(alive(grandchild), "grandchild was not running to begin with");

        shell_task_kill_impl(&json!({ "id": id })).await.expect("kill");
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;

        assert!(
            !alive(grandchild),
            "cancel killed the shell but left the grandchild ({grandchild}) running",
        );
    }
}

/// Shutdown sweep (audit: bg tasks were only tied to the app's lifetime on
/// Windows). The atexit registration itself cannot be exercised in-process —
/// the handler runs after the test harness is gone — so the sweep it calls is
/// tested directly, with a real tree.
#[cfg(test)]
mod shutdown_sweep_tests {
    use super::*;

    fn alive(pid: u32) -> bool {
        let out = std::process::Command::new("ps")
            .args(["-o", "state=", "-p", &pid.to_string()])
            .output();
        match out {
            Ok(o) => {
                let st = String::from_utf8_lossy(&o.stdout).trim().to_string();
                !st.is_empty() && !st.starts_with('Z')
            }
            Err(_) => false,
        }
    }

    #[tokio::test]
    #[cfg_attr(target_os = "windows", ignore = "uses sh/ps; Windows has the Job Object")]
    async fn quitting_takes_a_running_task_and_its_children_with_it() {
        let _isolation = super::sweep_isolation();
        let start = shell_task_start_impl(&json!({
            "command": "sleep 30 & echo $! ; wait",
            "shell": "sh",
        }))
        .await
        .expect("start");
        let id = start["id"].as_str().expect("id").to_string();

        let mut grandchild = None;
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let st = shell_task_status_impl(&json!({ "id": id })).await.expect("status");
            let tail = st["output_tail"].as_str().unwrap_or("");
            if let Some(line) = tail.lines().find(|l| l.trim().parse::<u32>().is_ok()) {
                grandchild = line.trim().parse::<u32>().ok();
                break;
            }
        }
        let grandchild = grandchild.expect("grandchild never reported its pid");
        let shell_pid = REGISTRY
            .get(&id)
            .and_then(|t| t.inner.lock().unwrap().pid)
            .expect("a running task must carry its pid");
        assert!(alive(shell_pid) && alive(grandchild), "test setup is wrong");

        kill_all_background_tasks();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while alive(shell_pid) || alive(grandchild) {
            assert!(
                std::time::Instant::now() < deadline,
                "the quit sweep left {shell_pid}/{grandchild} running",
            );
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    /// Is this number still a process — zombie included?
    ///
    /// `alive()` above reports a zombie as dead, which is the wrong question
    /// here: a zombie has NOT been reaped, so its pid is still reserved. What
    /// matters for the sweep is the moment the kernel is free to hand the
    /// number out again, and that is the moment `ps` stops listing it at all.
    #[cfg(unix)]
    fn in_process_table(pid: u32) -> bool {
        std::process::Command::new("ps")
            .args(["-o", "pid=", "-p", &pid.to_string()])
            .output()
            .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
            .unwrap_or(false)
    }

    /// The window the reaping fix closes.
    ///
    /// `child.wait()` reaps, and from that instant the pid may be reused. The
    /// pid was cleared much later — after both output readers had drained —
    /// and a grandchild that inherited stdout keeps them draining for as long
    /// as it lives. So: shell exits immediately, grandchild holds the pipe, and
    /// for the next three seconds the registry kept handing the sweep a number
    /// that belonged to whatever the kernel gave it to next.
    #[tokio::test]
    #[cfg_attr(target_os = "windows", ignore = "uses sh/ps")]
    #[cfg(unix)]
    async fn a_reaped_pid_is_gone_from_the_registry_the_instant_it_is_freed() {
        let _isolation = super::sweep_isolation();
        let start = shell_task_start_impl(&json!({
            // The shell exits at once; the grandchild inherits stdout and keeps
            // the reader task running long after the shell has been reaped.
            "command": "sleep 3 & exit 0",
            "shell": "sh",
        }))
        .await
        .expect("start");
        let id = start["id"].as_str().expect("id").to_string();

        let task = REGISTRY.get(&id).expect("the task is in the registry");
        let shell_pid = task
            .inner
            .lock()
            .unwrap()
            .pid
            .expect("a running task must carry its pid");

        // Wait for the kernel to release the number — i.e. for the reap.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while in_process_table(shell_pid) {
            assert!(
                std::time::Instant::now() < deadline,
                "the shell ({shell_pid}) never exited, so there is nothing to prove",
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        // The reader is still draining the grandchild's pipe, so the task is
        // still marked running — and that is exactly when the sweep would fire.
        // Read the state out and release the lock BEFORE asserting: a panic
        // holding this guard poisons the shared registry and every other test
        // in the binary fails on the poison instead of on its own subject.
        let (still_listed, running) = {
            let inner = task.inner.lock().unwrap();
            (inner.pid, inner.status.running)
        };
        assert!(
            still_listed.is_none(),
            "the registry still hands out {shell_pid}, which the kernel has already freed \
             (running={running})",
        );
    }

    /// A finished task's pid may already belong to somebody else — the sweep
    /// must never fire at it. Sweeping an idle registry must also not panic.
    #[tokio::test]
    #[cfg_attr(target_os = "windows", ignore = "uses sh")]
    async fn a_finished_task_is_not_swept() {
        let _isolation = super::sweep_isolation();
        let start = shell_task_start_impl(&json!({ "command": "true", "shell": "sh" }))
            .await
            .expect("start");
        let id = start["id"].as_str().unwrap().to_string();
        for _ in 0..50 {
            let st = shell_task_status_impl(&json!({ "id": id })).await.unwrap();
            if !st["running"].as_bool().unwrap_or(true) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(
            REGISTRY.get(&id).and_then(|t| t.inner.lock().unwrap().pid).is_none(),
            "a finished task still carries a pid the sweep could kill",
        );
        kill_all_background_tasks();
    }
}

#[cfg(test)]
mod cwd_default_tests {
    use super::*;

    /// The tool exists for `pnpm install` / `cargo build`, so the folder it
    /// runs in IS the point. Without an explicit cwd the child used to inherit
    /// LU's own process directory — the install folder on Windows — so a task
    /// the model started "in the project" ran somewhere else.
    #[tokio::test]
    #[cfg_attr(target_os = "windows", ignore = "uses sh/pwd")]
    async fn a_task_without_an_explicit_cwd_lands_in_the_workspace() {
        let ws = std::env::temp_dir().join(format!("lu-bg-ws-{}", std::process::id()));
        std::fs::create_dir_all(&ws).unwrap();
        // macOS hands out /var/... which is a symlink to /private/var; pwd
        // reports the resolved path, so compare against that.
        let expected = std::fs::canonicalize(&ws).unwrap();

        let start = shell_task_start_impl(&json!({
            "command": "pwd",
            "shell": "sh",
            "working_directory": ws.to_string_lossy(),
        }))
        .await
        .expect("start");
        let id = start["id"].as_str().unwrap().to_string();

        let mut seen = String::new();
        for _ in 0..40 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let st = shell_task_status_impl(&json!({ "id": id })).await.unwrap();
            seen = st["output_tail"].as_str().unwrap_or("").to_string();
            if !seen.trim().is_empty() {
                break;
            }
        }
        assert_eq!(
            seen.trim(),
            expected.to_string_lossy(),
            "background task did not start in the workspace",
        );
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// An explicit cwd from the caller still wins over the derived default.
    #[tokio::test]
    #[cfg_attr(target_os = "windows", ignore = "uses sh/pwd")]
    async fn an_explicit_cwd_still_wins() {
        let a = std::env::temp_dir().join(format!("lu-bg-a-{}", std::process::id()));
        let b = std::env::temp_dir().join(format!("lu-bg-b-{}", std::process::id()));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let expected = std::fs::canonicalize(&b).unwrap();

        let start = shell_task_start_impl(&json!({
            "command": "pwd",
            "shell": "sh",
            "cwd": b.to_string_lossy(),
            "working_directory": a.to_string_lossy(),
        }))
        .await
        .expect("start");
        let id = start["id"].as_str().unwrap().to_string();

        let mut seen = String::new();
        for _ in 0..40 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let st = shell_task_status_impl(&json!({ "id": id })).await.unwrap();
            seen = st["output_tail"].as_str().unwrap_or("").to_string();
            if !seen.trim().is_empty() {
                break;
            }
        }
        assert_eq!(seen.trim(), expected.to_string_lossy());
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }
}
