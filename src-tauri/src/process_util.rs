//! Process spawning + lifecycle helpers used by ComfyUI / LM Studio / Claude
//! Code lifecycle commands.
//!
//! On Windows we use Job Objects (KILL_ON_JOB_CLOSE) so any child process tree
//! gets cleaned up when the bridge exits, and prefer `taskkill /T /F` for
//! recursive kills. On Unix `kill_tree` walks the real parent/child links: a
//! process-group kill only reaches children that were put in a group at spawn,
//! which is true for `spawn_piped` but not for every caller.

use std::process::{Child, Command, Stdio};

#[cfg(windows)]
pub fn no_window() -> u32 {
    0x08000000 // CREATE_NO_WINDOW
}

/// Suppress the console window for a std `Command` on Windows (CREATE_NO_WINDOW);
/// no-op elsewhere. Use for every CLI we shell out to (lms, git, python probes)
/// so users don't get console flashes.
pub fn suppress_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(no_window());
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

// ── Reading the process table by COMMAND LINE ───────────────────────────────
//
// `System::refresh_processes` does NOT fetch command lines. Its refresh kind is
// memory + cpu + disk_usage + exe (sysinfo-0.33 `common/system.rs:296`), so
// `Process::cmd()` comes back as an EMPTY slice for every process, and any
// matcher that joins it silently compares against "".
//
// That is not a hypothetical. It cost this repo two independent bugs, and the
// second one is the reason this helper exists rather than a third copy of the
// same three lines:
//
//   * `process::find_orphaned_comfyui` (T-68) — the scan for a ComfyUI orphaned
//     by a hard kill found nothing at all, so Stop stayed the no-op the audit
//     described even after the adoption path was written.
//   * `remote::kill_orphaned_tunnels` (T-39) — the startup sweep that kills a
//     cloudflared tunnel surviving from the last run could never match, so a
//     tunnel kept publishing the LAN server to the internet while the app's own
//     indicator read OFF. AUDIT-COVERAGE.md recorded that finding as fixed,
//     because the fix LOOKED like it applied.
//
// One of the two got repaired and the other did not, purely because nobody knew
// they were the same line twice. So: one helper, one place to get this wrong.

/// A refreshed process table whose entries actually carry their command lines.
///
/// Use this — never a bare `System::new()` + `refresh_processes()` — whenever
/// the answer depends on `Process::cmd()`.
pub fn process_table_with_cmdlines() -> sysinfo::System {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        // `name()` stays populated by the base discovery, so a matcher that
        // reads both the name and the argv is served by this one refresh.
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    sys
}

/// One process's command line as owned strings, in argv order.
pub fn cmdline_of(process: &sysinfo::Process) -> Vec<String> {
    process
        .cmd()
        .iter()
        .map(|c| c.to_string_lossy().to_string())
        .collect()
}

/// Spawn a command with stdout+stderr piped, console suppressed on Windows.
pub fn spawn_piped(mut cmd: Command) -> std::io::Result<Child> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(no_window());
    }
    #[cfg(unix)]
    {
        // Create our own process group so we can kill the whole tree later.
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc_setpgid_self() != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    cmd.spawn()
}

/// Every process in `root`'s tree, root last, paired with its start time.
///
/// The start time is the anti-PID-reuse token for the delayed SIGKILL below:
/// a descendant is reparented to init the moment its parent dies, init reaps
/// it, and the kernel is then free to hand that number to a stranger inside
/// our own grace window. Same pid AND same start time is the same process.
#[cfg(unix)]
fn tree_snapshot(root: u32) -> Vec<(u32, u64)> {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let mut order = crate::commands::shell::descendants(root, &sys);
    order.reverse(); // leaves first — a live parent can't respawn what we killed
    order.push(root);
    order
        .into_iter()
        .map(|pid| {
            let start = sys
                .process(Pid::from_u32(pid))
                .map(|p| p.start_time())
                .unwrap_or(0);
            (pid, start)
        })
        .collect()
}

/// How long a SIGTERM'd tree is given before the SIGKILL goes out.
///
/// A named constant because it is the subject of
/// `the_call_does_not_block_for_the_grace_period`: the whole point of the
/// detached thread below is that the CALLER never spends this. It was written
/// twice, once per escalation path, and a change to one of the two would have
/// been silent.
#[cfg(unix)]
const KILL_GRACE: std::time::Duration = std::time::Duration::from_millis(800);

/// Recursive process-tree kill: SIGTERM the whole tree now, SIGKILL whatever
/// is left after a grace. Windows delegates the walk to `taskkill /T /F`.
///
/// The Unix branch used to signal the process GROUP (`kill -- -PGID`). That
/// only reaches a child that was made a group leader at spawn, and it is not
/// what either caller here does:
///
/// * `video::video_cancel` (the mlx_video Python job) spawns through a plain
///   `Command::spawn`, so the child is in OUR group and `-PID` addressed a
///   group that never existed — the kill went nowhere and the generation kept
///   running on the GPU. This is the case the explicit walk was written for.
/// * `remote::kill_tunnel_child` (the cloudflared quick tunnel) spawns through
///   `spawn_piped`, so that child IS its own group leader and the old group
///   kill would have worked for it. The walk works for it too: it follows the
///   parent links, which exist either way, and it never signals a pid that is
///   not in the snapshot — so the wider process group is not a hazard.
///
/// What BOTH callers have to satisfy is the reaping contract: the tree MUST be
/// walked before the root dies (afterwards its children are reparented to init
/// and the parent links that identify them are gone), and the caller must not
/// have reaped the child itself — the `waitpid` at the end of the detached
/// thread is what keeps the pid reserved until the escalation has fired, and it
/// is also what keeps the process from becoming a permanent zombie. Both
/// callers hand over an unreaped `Child` and drop it afterwards without
/// waiting, which is exactly right.
///
/// Nothing here blocks the caller: `video_cancel` holds the `video_process`
/// mutex across this call and the UI polls that same mutex, so the old
/// 800 ms sleep froze the window for the whole grace. The tunnel path has the
/// same shape on quit. The grace, the escalation and the final reap run on a
/// detached thread instead.
pub fn kill_tree(child: &mut Child) -> std::io::Result<()> {
    let pid = child.id();
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = child.kill();
        let _ = child.wait();
    }
    #[cfg(unix)]
    {
        let tree = tree_snapshot(pid);
        for (p, _) in &tree {
            unsafe {
                libc::kill(*p as i32, libc::SIGTERM);
            }
        }
        std::thread::spawn(move || {
            std::thread::sleep(KILL_GRACE);
            let survivors = {
                use sysinfo::{Pid, ProcessesToUpdate, System};
                let mut sys = System::new();
                sys.refresh_processes(ProcessesToUpdate::All, true);
                tree.iter()
                    .filter(|(p, start)| {
                        sys.process(Pid::from_u32(*p))
                            .map(|proc_| *start == 0 || proc_.start_time() == *start)
                            .unwrap_or(false)
                    })
                    .map(|(p, _)| *p)
                    .collect::<Vec<u32>>()
            };
            for p in survivors {
                unsafe {
                    libc::kill(p as i32, libc::SIGKILL);
                }
            }
            // The caller drops its `Child` without waiting, and a dropped
            // Child is never reaped — the job would sit in the table as a
            // zombie for as long as LU runs. Its pid also cannot be recycled
            // until this call, which is what makes the SIGKILL above safe.
            unsafe {
                let mut status: libc::c_int = 0;
                libc::waitpid(pid as libc::pid_t, &mut status, 0);
            }
        });
    }
    Ok(())
}

/// Same escalation as [`kill_tree`], but for a pid this process does NOT own.
///
/// The case it exists for (T-68): LU is hard-killed, its ComfyUI child is
/// reparented to init and survives. The next launch can identify that process
/// but has no `Child` for it — so there is nothing to `wait()` on, and calling
/// `waitpid` on a stranger would fail with ECHILD anyway. Everything else is
/// the same walk: snapshot the tree while the parent links still exist,
/// SIGTERM it, then SIGKILL whatever is still there (and still the same
/// process, by start time) after the grace, off the caller's thread.
pub fn kill_pid_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        let tree = tree_snapshot(pid);
        for (p, _) in &tree {
            unsafe {
                libc::kill(*p as i32, libc::SIGTERM);
            }
        }
        std::thread::spawn(move || {
            std::thread::sleep(KILL_GRACE);
            use sysinfo::{Pid, ProcessesToUpdate, System};
            let mut sys = System::new();
            sys.refresh_processes(ProcessesToUpdate::All, true);
            for (p, start) in tree {
                let same = sys
                    .process(Pid::from_u32(p))
                    .map(|proc_| start == 0 || proc_.start_time() == start)
                    .unwrap_or(false);
                if same {
                    unsafe {
                        libc::kill(p as i32, libc::SIGKILL);
                    }
                }
            }
            // No waitpid: an adopted orphan is init's child, not ours. init
            // reaps it.
        });
    }
}

/// Best-effort stop of whatever process is LISTENING on a local TCP port.
/// Used by the "Stop" buttons for port-bound backends the bridge didn't spawn
/// itself (so there's no `Child` handle to kill) — the MLX sidecar and the
/// Ollama server. Only the listener is targeted (`-sTCP:LISTEN`), so the
/// bridge's own client connections to that port aren't hit.
// Gated like its only caller (state.rs, app quit): on Windows and Linux the
// function had no caller and a unix-only body, and `-D warnings` on the
// Windows CI row rejected it as dead. The gate says where it is alive.
#[cfg(target_os = "macos")]
pub fn kill_listeners_on_port(port: u16) {
    #[cfg(unix)]
    {
        if let Ok(out) = Command::new("lsof")
            .args(["-ti", &format!("tcp:{port}"), "-sTCP:LISTEN"])
            .stderr(Stdio::null())
            .output()
        {
            for pid in String::from_utf8_lossy(&out.stdout)
                .split_whitespace()
                .filter_map(|s| s.parse::<i32>().ok())
            {
                unsafe {
                    libc::kill(pid, libc::SIGTERM);
                }
            }
        }
    }
    #[cfg(windows)]
    {
        if let Ok(out) = Command::new("cmd")
            .args(["/C", &format!("netstat -ano -p tcp | findstr LISTENING | findstr :{port}")])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
        {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if let Some(pid) = line.split_whitespace().last() {
                    let _ = Command::new("taskkill")
                        .args(["/F", "/PID", pid])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
            }
        }
    }
}

#[cfg(unix)]
extern "C" {
    fn setpgid(pid: libc::pid_t, pgid: libc::pid_t) -> libc::c_int;
}

#[cfg(unix)]
fn libc_setpgid_self() -> libc::c_int {
    unsafe { setpgid(0, 0) }
}

// Minimal libc binding so we can avoid an extra crate.
#[cfg(unix)]
#[allow(non_camel_case_types)]
mod libc {
    pub type pid_t = i32;
    pub type c_int = i32;
    pub const SIGTERM: c_int = 15;
    pub const SIGKILL: c_int = 9;
    extern "C" {
        pub fn kill(pid: pid_t, sig: c_int) -> c_int;
        pub fn waitpid(pid: pid_t, status: *mut c_int, options: c_int) -> pid_t;
    }
}

#[cfg(all(test, unix))]
mod kill_tree_tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn alive(pid: u32) -> bool {
        let out = Command::new("ps")
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

    fn wait_until_gone(pids: &[u32], max: Duration) {
        let deadline = Instant::now() + max;
        loop {
            let left: Vec<u32> = pids.iter().copied().filter(|p| alive(*p)).collect();
            if left.is_empty() {
                return;
            }
            assert!(Instant::now() < deadline, "still running: {left:?}");
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// One of the two callers (`video_cancel`) spawns with a plain
    /// `Command::spawn`, so the child is NOT a process-group leader — which is
    /// exactly why the old `kill(-pid)` signalled nothing and left the tree
    /// running. (The other, `remote::kill_tunnel_child`, goes through
    /// `spawn_piped` and IS a group leader; the parent-link walk covers both,
    /// and the group-leader case is exercised in remote.rs's own tunnel tests.)
    #[test]
    fn a_child_without_a_process_group_still_loses_its_whole_tree() {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("sleep 40 & sleep 40")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sh");
        let pid = child.id();

        // Waits for the CONDITION — sh has actually forked — with a ceiling,
        // instead of guessing 400 ms at it. The old fixed sleep made the
        // "test setup is wrong" assertion below a load measurement: on a busy
        // machine sh simply had not got there yet.
        let deadline = Instant::now() + Duration::from_secs(10);
        let kids = loop {
            let mut sys = sysinfo::System::new();
            sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            let kids = crate::commands::shell::descendants(pid, &sys);
            if !kids.is_empty() {
                break kids;
            }
            assert!(
                Instant::now() < deadline,
                "sh spawned nothing in 10s — test setup is wrong",
            );
            std::thread::sleep(Duration::from_millis(50));
        };

        kill_tree(&mut child).expect("kill_tree");

        let mut all = kids.clone();
        all.push(pid);
        wait_until_gone(&all, Duration::from_secs(5));
    }

    /// `video_cancel` holds the `video_process` mutex for the duration of this
    /// call and the progress poll waits on the same mutex, so a blocking grace
    /// froze the window. The kill must be ordered, not awaited.
    ///
    /// ── Why there is no stopwatch in here any more ──
    ///
    /// It used to time the call and assert `took < 400 ms`. That number is not
    /// the grace and it is not a property of the code: the unavoidable work
    /// inside `kill_tree` is `tree_snapshot`, which enumerates the ENTIRE
    /// process table, and how long that takes belongs to the machine and to
    /// whatever else is running on it. Measured on 01.09.2026 under six
    /// concurrent copies of the suite — every one of them walking the process
    /// table too — it failed 17 of 18 runs. The kill was ordered, not awaited,
    /// in all 18; the enumeration was simply slower than the budget.
    ///
    /// So the question is asked without a clock. `kill_tree` hands the grace,
    /// the SIGKILL and the final `waitpid` to a detached thread. The `waitpid`
    /// is the LAST of those, and until it runs the child is our unreaped
    /// zombie, which is a pid `kill(pid, 0)` can still address. An
    /// implementation that awaited the grace would return AFTER that thread had
    /// finished, and the pid would be gone. One signal-0, no wall clock, no
    /// budget to blow — and it fails for exactly the regression this test
    /// exists to catch (put `thread::sleep(KILL_GRACE)` back in the caller's
    /// path and the child is reaped before the assertion runs).
    #[test]
    fn the_call_does_not_block_for_the_grace_period() {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("sleep 40")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sh");
        let pid = child.id();

        // Self-check instead of a settle sleep: wait for the CONDITION that the
        // stand-in is a live process carrying the argv this test chose, with a
        // ceiling. A `sh` that died on the spot would otherwise be killed as a
        // corpse and every assertion below would still pass. `checked_table`
        // owns the ceiling and the retry, including the one for a child that is
        // in the table but has not finished `exec` yet.
        let table = crate::test_support::checked_table(pid).unwrap_or_else(|why| panic!("{why}"));
        let argv = crate::process_util::cmdline_of(
            table
                .process(sysinfo::Pid::from_u32(pid))
                .expect("checked_table only returns a table containing this pid"),
        );
        assert!(
            argv.join(" ").contains("sleep"),
            "the stand-in is not the sleeper this test spawned: {argv:?}",
        );

        kill_tree(&mut child).expect("kill_tree");

        // Still ours, still unreaped → the detached thread has not reached its
        // `waitpid` yet → this call cannot have waited for the grace.
        let still_ours = unsafe { libc::kill(pid as i32, 0) } == 0;
        assert!(
            still_ours,
            "kill_tree returned only after the escalation thread had already \
             reaped pid {pid} — it waited out the {KILL_GRACE:?} grace",
        );

        wait_until_gone(&[pid], Duration::from_secs(5));
    }

    /// A killed child that nobody waits on stays in the process table as a
    /// zombie for the app's lifetime — and its pid can never be recycled.
    #[test]
    fn the_direct_child_is_reaped_not_left_as_a_zombie() {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("sleep 40")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sh");
        let pid = child.id();
        std::thread::sleep(Duration::from_millis(200));
        kill_tree(&mut child).expect("kill_tree");
        drop(child); // exactly what video_cancel does with its taken handle

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let out = Command::new("ps")
                .args(["-o", "state=", "-p", &pid.to_string()])
                .output()
                .expect("ps");
            let st = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if st.is_empty() {
                return; // gone from the table entirely == reaped
            }
            assert!(Instant::now() < deadline, "pid {pid} is still listed as {st:?}");
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// The one regression this helper exists to stop: a process table without
/// command lines.
///
/// Both callers (`process::find_orphaned_comfyui`, `remote::kill_orphaned_tunnels`)
/// match on argv, and both were silently matching against "" before this was
/// centralised. This test is the shared guard — it fails for either of them.
#[cfg(test)]
mod process_table_tests {
    // Only the unix test below reads anything from the parent; on Windows the
    // import was the one thing in this module clippy could see — and rejected.
    #[cfg(unix)]
    use super::*;

    #[cfg(unix)]
    #[test]
    fn the_table_carries_command_lines() {
        use std::process::{Command, Stdio};
        // The trailing `; :` stops sh from exec'ing the single command and
        // handing over its own argv — which would erase what is being read.
        let marker = "lu-process-table-probe-8f3a";
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 30; :", marker, "--flag", "value"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn the stand-in");

        let mut seen: Option<Vec<String>> = None;
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let sys = process_table_with_cmdlines();
            if let Some(p) = sys.process(sysinfo::Pid::from_u32(child.id())) {
                let cmd = cmdline_of(p);
                if !cmd.is_empty() {
                    seen = Some(cmd);
                    break;
                }
            }
        }
        let _ = child.kill();
        let _ = child.wait();

        let cmd = seen.expect(
            "the process table came back with an EMPTY command line — \
             refresh_processes does not fetch cmd, and every argv matcher in \
             this repo would silently be comparing against \"\"",
        );
        assert!(cmd.iter().any(|a| a == marker), "{cmd:?}");
        assert!(cmd.iter().any(|a| a == "--flag"), "{cmd:?}");
    }

    /// Nobody may quietly reintroduce a second, cmd-less refresh for an argv
    /// match. The two known matchers must go through the helper.
    #[test]
    fn the_argv_matchers_share_one_refresh() {
        const PROCESS_RS: &str = include_str!("commands/process.rs");
        const REMOTE_RS: &str = include_str!("commands/remote.rs");
        for (name, src, func) in [
            ("process.rs", PROCESS_RS, "pub(crate) fn find_orphaned_comfyui"),
            ("remote.rs", REMOTE_RS, "fn kill_orphaned_tunnels"),
        ] {
            let start = src.find(func).unwrap_or_else(|| panic!("{func} is gone from {name}"));
            let body = &src[start..start + 1200];
            assert!(
                body.contains("process_table_with_cmdlines()"),
                "{name}: {func} builds its own process table again"
            );
        }
    }
}
