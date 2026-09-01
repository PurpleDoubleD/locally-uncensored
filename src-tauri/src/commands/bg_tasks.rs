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

/// Start arguments for a task that keeps a CHILD process of its own alive —
/// the shape every teardown test needs, because a task with a deep tree is the
/// reason this module exists (`pnpm install`, `cargo build`).
///
/// Unix: `sh` running `sleep 30 & echo $! ; wait`, unchanged.
///
/// Windows: no `shell` at all, i.e. the PowerShell this module spawns by
/// default and therefore the shell a real background task actually runs
/// there, with `ping` as the child that outlives the test. Git Bash is still
/// deliberately not asked for — not because it would be mis-invoked any more
/// (the argument form follows the shell name now), but because a Git Bash
/// install is not something a Windows test run may assume.
#[cfg(test)]
fn a_task_that_starts_a_child() -> Value {
    if cfg!(target_os = "windows") {
        // -n 60 pings once a second, so the child stays for about a minute.
        json!({ "command": "ping -n 60 127.0.0.1" })
    } else {
        json!({ "command": "sleep 30 & echo $! ; wait", "shell": "sh" })
    }
}

/// A one-liner that exits at once, in the dialect of the platform's shell.
#[cfg(test)]
fn a_task_that_finishes_at_once() -> Value {
    if cfg!(target_os = "windows") {
        json!({ "command": "exit 0" })
    } else {
        json!({ "command": "true", "shell": "sh" })
    }
}

/// A one-liner that prints the directory the task is running in.
#[cfg(test)]
fn a_task_that_prints_its_directory(extra: Value) -> Value {
    let mut args = if cfg!(target_os = "windows") {
        json!({ "command": "(Get-Location).Path" })
    } else {
        json!({ "command": "pwd", "shell": "sh" })
    };
    let map = args.as_object_mut().expect("an object");
    for (k, v) in extra.as_object().expect("an object") {
        map.insert(k.clone(), v.clone());
    }
    args
}

/// The pid the registry holds for a task — the only handle the shutdown sweep
/// has on it, and the root of the tree the cancel path kills.
#[cfg(test)]
fn shell_pid_of(id: &str) -> u32 {
    REGISTRY
        .get(id)
        .and_then(|t| t.inner.lock().unwrap().pid)
        .expect("a running task must carry its pid")
}

/// Every process the task's shell has started, once there is at least one.
///
/// Read out of the process table rather than out of the task's own output:
/// PowerShell has no `$!`, and Git Bash's `$!` is an MSYS pid that no Windows
/// API can address. The process table is also the view `kill_tree` walks when
/// it takes the tree down, so the test and the code under test are looking at
/// the same processes.
#[cfg(test)]
async fn wait_for_children_of(shell_pid: u32) -> Vec<u32> {
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let kids = crate::test_support::worker_descendants_of(shell_pid);
        if !kids.is_empty() {
            return kids;
        }
    }
    panic!("the task's shell ({shell_pid}) never started a child process");
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
    // The argument form follows the SHELL, not the platform. This file used to
    // decide it here, on its own, and always built PowerShell's form on
    // Windows — so a caller-named `cmd` or `bash` was handed
    // `-NoProfile -NonInteractive -Command` and never ran the command at all.
    // The foreground twin already derived it from the shell name; both now ask
    // the same function, so a task started in the background and the same task
    // run in the foreground produce the identical command line.
    let (program, args_vec) = crate::commands::shell::shell_argv(
        cfg!(target_os = "windows"),
        a.shell.as_deref(),
        &a.command,
    );

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
    use crate::test_support::is_alive as alive;

    /// A background task is started for the long builds — `pnpm install`,
    /// `cargo build` — so its process tree is deep by definition. Cancelling
    /// used to SIGKILL the shell alone and leave the real worker running
    /// detached, the same defect 743c310 fixed for the foreground shell tool.
    ///
    /// Runs on Windows too: the cancel path is `kill_tree` on every platform
    /// (the Job Object does NOT help here, it fires when LU dies, not on a
    /// cancel), so this is live production behaviour there and not a Unix
    /// mechanism in disguise.
    #[tokio::test]
    async fn cancelling_takes_the_grandchild_with_it() {
        let _isolation = super::sweep_isolation();
        let start = shell_task_start_impl(&super::a_task_that_starts_a_child())
            .await
            .expect("start");
        let id = start["id"].as_str().expect("id").to_string();

        let shell_pid = super::shell_pid_of(&id);
        let grandchildren = super::wait_for_children_of(shell_pid).await;
        for pid in &grandchildren {
            assert!(alive(*pid), "grandchild {pid} was not running to begin with");
        }

        shell_task_kill_impl(&json!({ "id": id })).await.expect("kill");
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;

        for pid in &grandchildren {
            assert!(
                !alive(*pid),
                "cancel killed the shell but left the grandchild ({pid}) running",
            );
        }
    }
}

/// Shutdown sweep (audit: bg tasks were only tied to the app's lifetime on
/// Windows). The atexit registration itself cannot be exercised in-process —
/// the handler runs after the test harness is gone — so the sweep it calls is
/// tested directly, with a real tree.
#[cfg(test)]
mod shutdown_sweep_tests {
    use super::*;
    use crate::test_support::is_alive as alive;

    /// Unix only, and not because of the commands it runs: `kill_all_background_tasks`
    /// IS the quit mechanism here — `arm_exit_sweep` hangs it on `atexit` — while on
    /// Windows nothing in production ever calls it. There the same assurance is
    /// delivered by the Job Object, and it has its own test right below.
    #[tokio::test]
    #[cfg(unix)]
    async fn quitting_takes_a_running_task_and_its_children_with_it() {
        let _isolation = super::sweep_isolation();
        let start = shell_task_start_impl(&super::a_task_that_starts_a_child())
            .await
            .expect("start");
        let id = start["id"].as_str().expect("id").to_string();

        let shell_pid = super::shell_pid_of(&id);
        let grandchildren = super::wait_for_children_of(shell_pid).await;
        let whole_tree: Vec<u32> = std::iter::once(shell_pid)
            .chain(grandchildren.iter().copied())
            .collect();
        for pid in &whole_tree {
            assert!(alive(*pid), "test setup is wrong: {pid} is not running");
        }

        kill_all_background_tasks();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let survivors: Vec<u32> = whole_tree.iter().copied().filter(|p| alive(*p)).collect();
            if survivors.is_empty() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the quit sweep left {survivors:?} running",
            );
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    /// The Windows counterpart: same assurance — nothing a background task
    /// started survives LU's death — through the mechanism that delivers it
    /// there.
    ///
    /// Unix arms an `atexit` sweep. On Windows `arm_exit_sweep` is a no-op and
    /// `kill_all_background_tasks` is never called in production: the shell is
    /// handed to the app-wide Job Object with KILL_ON_JOB_CLOSE at spawn, so
    /// the kernel tears the tree down even for the deaths no handler ever sees
    /// (Task Manager, a hard kill from a build script). Running the Unix test
    /// here would prove something about a code path that does not run on this
    /// platform.
    ///
    /// What cannot be done in-process is watch it happen: that job's handle is
    /// deliberately never closed, and closing it here would disarm the
    /// mechanism for the rest of the test binary — and take every other test's
    /// children with it. What CAN be established is everything the kernel
    /// needs at that moment, and it is exactly what was missing when a
    /// background build outlived the app: the task's shell AND the process it
    /// started are both inside that one job, and that job carries
    /// KILL_ON_JOB_CLOSE. A process created by a process in a job belongs to
    /// the same job, which is why the second half is a real question and not a
    /// tautology — a breakaway flag on the job would end that inheritance.
    #[tokio::test]
    #[cfg(windows)]
    async fn quitting_takes_a_running_task_and_its_children_with_it_via_the_job_object() {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            IsProcessInJob, JobObjectExtendedLimitInformation, QueryInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION};

        /// Is this pid inside that job? False when the process cannot even be
        /// opened, which for a pid the test itself just spawned means the
        /// process is gone and the question is moot.
        fn in_job(pid: u32, job: isize) -> bool {
            unsafe {
                let handle = OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid);
                if handle.is_null() {
                    return false;
                }
                let mut member: i32 = 0;
                let queried = IsProcessInJob(handle, job as _, &mut member);
                CloseHandle(handle);
                queried != 0 && member != 0
            }
        }

        let _isolation = super::sweep_isolation();
        let start = shell_task_start_impl(&super::a_task_that_starts_a_child())
            .await
            .expect("start");
        let id = start["id"].as_str().expect("id").to_string();

        let shell_pid = super::shell_pid_of(&id);
        let grandchildren = super::wait_for_children_of(shell_pid).await;
        // Membership of a job the kernel will never have to act on proves
        // nothing, so the tree has to be running when it is asked.
        for pid in std::iter::once(shell_pid).chain(grandchildren.iter().copied()) {
            assert!(alive(pid), "test setup is wrong: {pid} is not running");
        }

        let job = crate::commands::process::kill_on_close_job_for_tests();
        assert!(job != 0, "the app-wide kill-on-close job was never created");

        // The limit flag is the entire mechanism. Without it the job is a
        // bookkeeping device and every child outlives the app.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let mut returned: u32 = 0;
        let queried = unsafe {
            QueryInformationJobObject(
                job as _,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                &mut returned,
            )
        };
        assert!(queried != 0, "the app-wide job object could not be queried");
        assert!(
            info.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE != 0,
            "the job does not kill its processes when the app's handle closes, \
             so quitting would leave every background task running",
        );

        assert!(
            in_job(shell_pid, job),
            "the task's shell ({shell_pid}) is not in the kill-on-close job, \
             so LU dying would leave the whole background task behind",
        );
        for pid in &grandchildren {
            assert!(
                in_job(*pid, job),
                "the task's shell is in the job but the process it started \
                 ({pid}) is not, so the actual worker would survive LU",
            );
        }

        // Do not leave a minute of ping behind for the rest of the run.
        let _ = shell_task_kill_impl(&json!({ "id": id })).await;
    }

    /// The window the reaping fix closes.
    ///
    /// `child.wait()` reaps, and from that instant the pid may be reused. The
    /// pid was cleared much later — after both output readers had drained —
    /// and a grandchild that inherited stdout keeps them draining for as long
    /// as it lives. So: shell exits immediately, grandchild holds the pipe, and
    /// for the next three seconds the registry kept handing the sweep a number
    /// that belonged to whatever the kernel gave it to next.
    ///
    /// Unix only, and there is nothing to port: the race it guards is the
    /// reap. Windows recycles a pid only once the LAST handle to the process
    /// object is closed, and `tokio::process::Child` holds one until it is
    /// dropped — which happens after this loop, not inside it — so the number
    /// cannot be handed to a stranger while the registry still names it. The
    /// registry hygiene itself (a finished task carries no pid) is asserted on
    /// both platforms by `a_finished_task_is_not_swept` below.
    #[tokio::test]
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

        // Wait for the kernel to release the number — i.e. for the reap. A
        // zombie still holds it, so this asks whether `ps` lists the pid at
        // all, not whether it is alive.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while crate::test_support::pid_is_taken(shell_pid) {
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
    async fn a_finished_task_is_not_swept() {
        let _isolation = super::sweep_isolation();
        let start = shell_task_start_impl(&super::a_task_that_finishes_at_once())
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

    /// What the task printed as its own directory, once it has printed
    /// anything. Five seconds, because a cold PowerShell start on Windows is
    /// not instant.
    async fn reported_directory(id: &str) -> String {
        let mut seen = String::new();
        for _ in 0..100 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let st = shell_task_status_impl(&json!({ "id": id })).await.unwrap();
            seen = st["output_tail"].as_str().unwrap_or("").to_string();
            if !seen.trim().is_empty() {
                break;
            }
        }
        seen.trim().to_string()
    }

    /// Did the task run in `expected`?
    ///
    /// Both sides go through `canonicalize`, because the two spellings of one
    /// directory differ per platform and neither side is wrong: macOS hands
    /// out `/var/...` which is a symlink to `/private/var` and `pwd` reports
    /// the resolved path, while on Windows the shell prints a plain `C:\...`
    /// and `canonicalize` yields the `\\?\C:\...` verbatim form. Resolving
    /// both is still an exact directory identity — the assertion is not
    /// loosened, it is asked in a form both kernels can answer.
    fn same_directory(reported: &str, expected: &std::path::Path) -> bool {
        match (
            std::fs::canonicalize(reported),
            std::fs::canonicalize(expected),
        ) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
    }

    /// The tool exists for `pnpm install` / `cargo build`, so the folder it
    /// runs in IS the point. Without an explicit cwd the child used to inherit
    /// LU's own process directory — the install folder on Windows — so a task
    /// the model started "in the project" ran somewhere else.
    #[tokio::test]
    async fn a_task_without_an_explicit_cwd_lands_in_the_workspace() {
        let ws = std::env::temp_dir().join(format!("lu-bg-ws-{}", std::process::id()));
        std::fs::create_dir_all(&ws).unwrap();

        let start = shell_task_start_impl(&super::a_task_that_prints_its_directory(json!({
            "working_directory": ws.to_string_lossy(),
        })))
        .await
        .expect("start");
        let id = start["id"].as_str().unwrap().to_string();

        let seen = reported_directory(&id).await;
        assert!(
            same_directory(&seen, &ws),
            "background task did not start in the workspace: reported {seen:?}, wanted {ws:?}",
        );
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// An explicit cwd from the caller still wins over the derived default.
    #[tokio::test]
    async fn an_explicit_cwd_still_wins() {
        let a = std::env::temp_dir().join(format!("lu-bg-a-{}", std::process::id()));
        let b = std::env::temp_dir().join(format!("lu-bg-b-{}", std::process::id()));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();

        let start = shell_task_start_impl(&super::a_task_that_prints_its_directory(json!({
            "cwd": b.to_string_lossy(),
            "working_directory": a.to_string_lossy(),
        })))
        .await
        .expect("start");
        let id = start["id"].as_str().unwrap().to_string();

        let seen = reported_directory(&id).await;
        assert!(
            same_directory(&seen, &b),
            "the explicit cwd lost: reported {seen:?}, wanted {b:?}",
        );
        // Negative control: the folder that must NOT have won.
        assert!(!same_directory(&seen, &a), "the task ran in the fallback {a:?}");
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }
}

/// The background task and its foreground twin, held against each other.
///
/// They are the same tool with two lifetimes: `shell_execute` waits,
/// `shell_execute` with `background: true` hands back a task id. A caller that
/// names a shell must get that shell, invoked the same way, on either path.
/// They drifted apart once — this file built PowerShell's argument form for
/// every program on Windows while the foreground built it from the shell's
/// name — and the drift was invisible to every non-Windows test run.
#[cfg(test)]
mod foreground_parity_tests {
    use super::*;

    /// A shell that is deliberately NOT the platform default, so the `shell`
    /// field is actually exercised rather than skipped.
    ///
    /// Windows: `cmd`, the exact value that used to be handed
    /// `-NoProfile -NonInteractive -Command` and fail. Unix: `sh`, which is
    /// not the `bash` default and is present on every machine this runs on.
    fn a_named_shell() -> &'static str {
        if cfg!(target_os = "windows") {
            "cmd"
        } else {
            "sh"
        }
    }

    /// One line, one word of output, and the same source text in cmd.exe and
    /// in a POSIX shell — so the assertion is about the invocation, not about
    /// a dialect difference in the command itself.
    const TOKEN: &str = "lu-parity-7f3a";

    fn the_command() -> String {
        format!("echo {TOKEN}")
    }

    /// A directory both runs can start in, so neither path has to fall back to
    /// the per-chat workspace and touch the user's home.
    ///
    /// `os_paths::test_dir` statt eines selbstgebauten `temp_dir().join(…)`:
    /// das Aufräumen hängt dort am `Drop` und läuft deshalb auch dann, wenn
    /// eine der Assertions dazwischen scheitert — die letzte Zeile des Tests
    /// tat das nicht, und genau im Fehlerfall blieb der Ordner liegen. Der
    /// Name trägt zusätzlich die ThreadId, und unter Windows liegt er unter
    /// `target/`, wo ein `cargo clean` ihn erwischt.
    fn a_directory() -> crate::os_paths::TestDir {
        crate::os_paths::test_dir("parity")
    }

    async fn what_the_foreground_printed(dir: &std::path::Path) -> (String, i64) {
        let out = crate::commands::shell::shell_execute(
            the_command(),
            None,
            Some(dir.to_string_lossy().to_string()),
            Some(20_000),
            Some(a_named_shell().to_string()),
            None,
            None,
            None,
        )
        .await
        .expect("the foreground shell tool ran");
        (
            out["stdout"].as_str().unwrap_or_default().trim().to_string(),
            out["exitCode"].as_i64().unwrap_or(-1),
        )
    }

    async fn what_the_background_printed(dir: &std::path::Path) -> (String, i64) {
        let start = shell_task_start_impl(&json!({
            "command": the_command(),
            "shell": a_named_shell(),
            "cwd": dir.to_string_lossy(),
        }))
        .await
        .expect("the background task started");
        let id = start["id"].as_str().expect("id").to_string();
        for _ in 0..200 {
            let st = shell_task_status_impl(&json!({ "id": id })).await.expect("status");
            if !st["running"].as_bool().unwrap_or(true) {
                return (
                    st["output_tail"].as_str().unwrap_or_default().trim().to_string(),
                    st["exit_code"].as_i64().unwrap_or(-1),
                );
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("the background task never finished");
    }

    /// The behavioural half: same shell, same command, same result.
    ///
    /// On Windows this fails outright without the shared argument builder —
    /// `cmd -NoProfile -NonInteractive -Command echo …` prints cmd.exe's usage
    /// complaint and never echoes the token. On Unix it holds `sh` to the same
    /// contract on both paths, which is the property that has to keep holding
    /// for the Windows one to stay true.
    ///
    /// The isolation guard is a plain `Mutex` held across the awaits below, on
    /// purpose and like every other test here that stands up a live task: it is
    /// what keeps the shutdown-sweep tests from killing this task's child
    /// mid-run. There is nothing to deadlock against — the lock is only ever
    /// taken by tests, never by the code under test.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_named_shell_behaves_the_same_in_the_background_as_in_the_foreground() {
        let _isolation = super::sweep_isolation();
        let dir = a_directory();

        let (foreground, fg_code) = what_the_foreground_printed(&dir).await;
        let (background, bg_code) = what_the_background_printed(&dir).await;

        // Both really ran — without this the assertion below would also pass
        // on two empty strings, i.e. on two equally broken paths.
        assert!(
            foreground.contains(TOKEN),
            "the foreground shell tool printed {foreground:?} with shell {:?}",
            a_named_shell(),
        );
        assert!(
            background.contains(TOKEN),
            "the background task printed {background:?} with shell {:?} — \
             the shell it was given was invoked with the wrong argument form",
            a_named_shell(),
        );
        assert_eq!(
            foreground, background,
            "the same command in the same shell came out differently on the two paths",
        );
        assert_eq!((fg_code, bg_code), (0, 0), "one of the two paths failed");
        // Kein `remove_dir_all` mehr: `dir` ist ein `TestDir` und räumt beim
        // Verlassen selbst auf, auch wenn eine Assertion oben vorher panickt.
    }

    /// The structural half: this file must not grow a second copy of the
    /// branch. The behavioural test above can only observe ONE shell per
    /// platform per run; a re-inlined branch that breaks a different shell
    /// would slip past it, and that is exactly how the original bug survived.
    ///
    /// Scoped to this file on purpose: `system.rs` and `install.rs` also spawn
    /// PowerShell with these flags, but they hardcode PowerShell for scripts of
    /// their own and never take a shell from a caller, so they are not twins of
    /// anything and are none of this test's business.
    #[test]
    fn the_background_path_builds_no_shell_flags_of_its_own() {
        const BG_TASKS_RS: &str = include_str!("bg_tasks.rs");
        // Split out of one string rather than written as separate literals:
        // a list of quoted flags would itself be the quoted flag this test
        // searches for, and the test would trip over its own source.
        for flag in "-NoProfile -NonInteractive -Command /C -c".split(' ') {
            let literal = format!("{:?}", flag);
            assert!(
                !BG_TASKS_RS.contains(&literal),
                "bg_tasks.rs builds the shell argument {flag} itself again — \
                 that branch belongs in shell::shell_argv, which the foreground \
                 path uses too",
            );
        }
        assert!(
            BG_TASKS_RS.contains("shell::shell_argv("),
            "the background path no longer goes through the shared argument builder",
        );
    }
}
