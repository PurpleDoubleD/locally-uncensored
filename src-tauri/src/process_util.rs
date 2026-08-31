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
            std::thread::sleep(std::time::Duration::from_millis(800));
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

/// Best-effort stop of whatever process is LISTENING on a local TCP port.
/// Used by the "Stop" buttons for port-bound backends the bridge didn't spawn
/// itself (so there's no `Child` handle to kill) — the MLX sidecar and the
/// Ollama server. Only the listener is targeted (`-sTCP:LISTEN`), so the
/// bridge's own client connections to that port aren't hit.
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
        std::thread::sleep(Duration::from_millis(400));

        let mut sys = sysinfo::System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let kids = crate::commands::shell::descendants(pid, &sys);
        assert!(!kids.is_empty(), "sh spawned nothing — test setup is wrong");

        kill_tree(&mut child).expect("kill_tree");

        let mut all = kids.clone();
        all.push(pid);
        wait_until_gone(&all, Duration::from_secs(5));
    }

    /// `video_cancel` holds the `video_process` mutex for the duration of this
    /// call and the progress poll waits on the same mutex, so a blocking grace
    /// froze the window. The kill must be ordered, not awaited.
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
        std::thread::sleep(Duration::from_millis(200));

        let started = Instant::now();
        kill_tree(&mut child).expect("kill_tree");
        let took = started.elapsed();

        assert!(took < Duration::from_millis(400), "kill_tree blocked for {took:?}");
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
