//! Test-only OS helpers — one place where "and how does that work on Windows"
//! is answered for the whole crate.
//!
//! Nothing here ships: the module is `#[cfg(test)]` in `main.rs`.
//!
//! It exists because the process-level tests — `state.rs` (the quit path),
//! `commands/engine.rs` (the health wait) and `commands/bg_tasks.rs`
//! (cancel, quit sweep, working directory) — all need the same four things
//! from the OS: a shell that runs a POSIX one-liner, a child that stays alive
//! while the test works, an answer to "is this pid still a process", and the
//! children a process started. Each of them used to spell those out in Unix
//! terms only (`sh`, `sleep`, `ps -o state=`), which is why eight of them were
//! switched off on Windows — that is, on the platform whose process handling
//! differs the most from the one they were written on, and where being
//! untested is worth the least.
//!
//! Everything below is compiled on every platform (`if cfg!(windows)`, not
//! `#[cfg(windows)]`), so the Windows half at least type-checks in a macOS
//! `cargo test` run and the pure parts of the resolver are unit-tested at the
//! bottom of this file.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

const BASH_EXE: &str = "bash.exe";

// ── The shell ─────────────────────────────────────────────────────────────

/// A shell that can run the POSIX one-liners these tests are written in.
///
/// Unix: `sh`, exactly as before.
///
/// Windows: the bash that Git for Windows installs. A bare `bash` is NOT
/// usable there, and that is the whole reason this function exists: on a
/// stock Windows 10/11 the PATH resolves `bash` to
/// `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe` — the WSL
/// app-execution-alias stub, a zero-length reparse point. `where bash` prints
/// it and every existence check says yes to it, but with no WSL distro
/// registered CreateProcess refuses it outright, so the spawn dies before a
/// shell is ever reached. Git for Windows always installs a real bash next to
/// git, so that one is resolved deterministically and every WindowsApps
/// candidate is dropped on the floor *before* it is even checked for
/// existence.
///
/// This is the Rust twin of `src/api/__tests__/bash-interpreter.ts`, which
/// solved the same problem for the vitest side; same sources, same order.
pub(crate) fn posix_shell() -> String {
    static RESOLVED: OnceLock<String> = OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            if !cfg!(windows) {
                return "sh".to_string();
            }
            let candidates = windows_bash_candidates();
            match candidates.iter().find(|c| is_usable_bash(c)) {
                Some(found) => found.clone(),
                None => panic!("{}", no_bash_message(&candidates)),
            }
        })
        .clone()
}

/// `...\WindowsApps\bash.exe` is the WSL alias stub — never an actual shell.
fn is_wsl_alias_stub(candidate: &str) -> bool {
    let lower = candidate.to_ascii_lowercase().replace('/', "\\");
    lower.contains("\\windowsapps\\")
}

/// The stub filter runs BEFORE the existence check, on purpose: the stub is a
/// file as far as the file system is concerned, so checking first would let it
/// win.
fn is_usable_bash(candidate: &str) -> bool {
    !is_wsl_alias_stub(candidate) && Path::new(candidate).is_file()
}

/// `where <program>` on Windows: one absolute path per line, and no lines at
/// all when the program is not on PATH. Off Windows there is no `where`
/// executable, the spawn fails, and the caller gets an empty list — which is
/// correct, because nothing off Windows asks.
fn where_on_path(program: &str) -> Vec<String> {
    let out = match Command::new("where").arg(program).output() {
        Ok(o) if o.status.success() => o.stdout,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&out)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// The documented install roots, for a git that is not on PATH at all.
fn program_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for var in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(v) = std::env::var_os(var) {
            roots.push(PathBuf::from(v));
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Programs"));
    }
    roots
}

fn windows_bash_candidates() -> Vec<String> {
    build_candidates(
        &where_on_path("git"),
        &program_roots(),
        &where_on_path("bash"),
    )
}

/// Every place a real bash could be, most trustworthy first. Nothing in here
/// is machine specific: git's own location is the primary source, the install
/// roots are the fallback, and PATH comes last — after the stub filter, so a
/// WSL alias can never win just because it happens to be first on PATH.
///
/// Split out from its inputs so the ordering can be tested without a Windows
/// machine (see the tests at the bottom of this file).
fn build_candidates(git_exes: &[String], roots: &[PathBuf], bash_on_path: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let add = |p: PathBuf, out: &mut Vec<String>| {
        let s = p.to_string_lossy().to_string();
        if !out.iter().any(|e| e.eq_ignore_ascii_case(&s)) {
            out.push(s);
        }
    };

    // 1. Derive it from git. Git for Windows ships bash in the same install,
    //    so `where git` -> ...\Git\cmd\git.exe pins down ...\Git\bin\bash.exe.
    //    Walk up a few levels instead of assuming `cmd\`, because git.exe also
    //    lives under mingw64\bin in some layouts.
    for git_exe in git_exes {
        let mut dir = PathBuf::from(git_exe);
        dir.pop(); // the directory holding git.exe
        for _ in 0..3 {
            if !dir.pop() {
                break;
            }
            add(dir.join("bin").join(BASH_EXE), &mut out);
            add(dir.join("usr").join("bin").join(BASH_EXE), &mut out);
        }
    }

    // 2. The install roots, for a git that is not on PATH at all.
    for root in roots {
        add(root.join("Git").join("bin").join(BASH_EXE), &mut out);
        add(
            root.join("Git").join("usr").join("bin").join(BASH_EXE),
            &mut out,
        );
    }

    // 3. Whatever PATH itself offers, last.
    for on_path in bash_on_path {
        add(PathBuf::from(on_path), &mut out);
    }

    out
}

/// The death message. It names every candidate that was looked at, marks the
/// ones that were skipped as stubs, and says how to get a real bash — a bare
/// "no bash found" on somebody else's machine is unactionable.
fn no_bash_message(candidates: &[String]) -> String {
    let mut msg = String::from(
        "no usable bash found on Windows. The `bash` on PATH is the WSL \
         app-execution-alias stub under WindowsApps, which cannot run without a \
         registered WSL distro, so it is deliberately ignored. Install Git for \
         Windows (https://git-scm.com/download/win, or `winget install --id \
         Git.Git`), which ships Git Bash. Checked:",
    );
    if candidates.is_empty() {
        msg.push_str("\n  (nothing — neither git nor bash is on PATH)");
    }
    for c in candidates {
        msg.push_str("\n  ");
        msg.push_str(c);
        if is_wsl_alias_stub(c) {
            msg.push_str("  (WSL stub, skipped)");
        }
    }
    msg
}

// ── A child that stays alive ──────────────────────────────────────────────

/// A child that runs for `secs` seconds and whose pid stays THIS process for
/// all of them.
///
/// Unix: `sleep`, as before. Windows: `ping`, the Windows sleep — a native
/// single process, always present in System32.
///
/// Deliberately NOT `bash -c "sleep 30"` on Windows: bash exec-optimises a
/// `-c` that holds a single command, and the MSYS runtime emulates `exec` by
/// starting a NEW Windows process while the original `bash.exe` exits. The pid
/// the test had just tracked would be gone within milliseconds and every
/// "the shutdown killed it" assertion would pass without proving anything.
pub(crate) fn sleeper(secs: u32) -> Command {
    if cfg!(windows) {
        // -n counts the pings; the first goes out at once and the rest are a
        // second apart, so n = secs + 1 lasts about `secs`.
        let mut cmd = Command::new("ping");
        cmd.args(["-n", &(secs + 1).to_string(), "127.0.0.1"]);
        cmd
    } else {
        let mut cmd = Command::new("sleep");
        cmd.arg(secs.to_string());
        cmd
    }
}

// ── Is this pid still a process ───────────────────────────────────────────

/// Is this pid a live process?
///
/// A killed-but-unreaped child is NOT alive: on Unix `ps -p` still lists a
/// zombie, so the process STATE has to be read — `Z` means the kill landed and
/// only the exit status is still pending; at quit the parent dies and init
/// reaps it. Windows has no zombies at all (a terminated process leaves the
/// table at once, even while a handle keeps its number reserved), so there the
/// question is simply whether the process table still lists it — read through
/// `sysinfo`, the same view the production `kill_tree` walks.
pub(crate) fn is_alive(pid: u32) -> bool {
    if cfg!(windows) {
        in_process_table(pid)
    } else {
        let state = unix_ps_field(pid, "state=");
        !state.is_empty() && !state.starts_with('Z')
    }
}

/// Is this number still taken — zombie included?
///
/// [`is_alive`] reports a zombie as dead, which is the wrong question when
/// what matters is the moment the kernel may hand the number out again: a
/// zombie has not been reaped, so its pid is still reserved, and `ps` keeps
/// listing it until it is. On Windows the number is held by the open process
/// handle rather than by an unreaped entry, and the process table is the only
/// thing that can be observed from outside.
pub(crate) fn pid_is_taken(pid: u32) -> bool {
    if cfg!(windows) {
        in_process_table(pid)
    } else {
        !unix_ps_field(pid, "pid=").is_empty()
    }
}

fn unix_ps_field(pid: u32, field: &str) -> String {
    Command::new("ps")
        .args(["-o", field, "-p", &pid.to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn in_process_table(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    // A full refresh, not `Some(&[pid])`: on Windows a terminated process can
    // still be opened by pid while somebody holds a handle to it, and the
    // per-pid refresh goes through exactly that door. The full snapshot lists
    // what is actually running.
    sys.refresh_processes(ProcessesToUpdate::All, true);
    sys.process(Pid::from_u32(pid)).is_some()
}

/// Everything below `root` in the real parent/child links that is actually
/// doing work.
///
/// The same view the production `kill_tree` walks, which is what makes it the
/// right way to find the child a shell started when the shell cannot report it
/// itself: PowerShell has no `$!`, and Git Bash's `$!` is an MSYS pid that no
/// Windows API can address.
///
/// `conhost.exe` is filtered out because Windows attaches one to every process
/// that gets a console — CREATE_NO_WINDOW still creates one — and it appears
/// as a child of the shell, usually before the shell has started anything of
/// its own. A test that grabbed it would end up asserting that Windows' own
/// console host dies, which says nothing about the `pnpm install` underneath.
/// The name matches nothing on Unix, so the filter is inert there.
pub(crate) fn worker_descendants_of(root: u32) -> Vec<u32> {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    crate::commands::shell::descendants(root, &sys)
        .into_iter()
        .filter(|pid| {
            sys.process(Pid::from_u32(*pid))
                .map(|p| !p.name().to_string_lossy().eq_ignore_ascii_case("conhost.exe"))
                .unwrap_or(false)
        })
        .collect()
}

// ── Tests for the helpers themselves ──────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wsl_alias_stub_is_recognised_in_both_slash_flavours() {
        for stub in [
            r"C:\Users\x\AppData\Local\Microsoft\WindowsApps\bash.exe",
            r"c:\users\x\appdata\local\microsoft\windowsapps\bash.exe",
            "C:/Users/x/AppData/Local/Microsoft/WindowsApps/bash.exe",
        ] {
            assert!(is_wsl_alias_stub(stub), "{stub} is the WSL stub");
        }
        for real in [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files\Git\usr\bin\bash.exe",
            "/bin/sh",
        ] {
            assert!(!is_wsl_alias_stub(real), "{real} is a real shell");
        }
        // The word has to be a path SEGMENT. A folder that merely starts with
        // it is somebody's own install, not the alias directory.
        assert!(!is_wsl_alias_stub(r"C:\WindowsAppsBackup\bin\bash.exe"));
    }

    /// Unix-shaped paths on purpose: the ORDER and the derivation are what is
    /// being tested, and `Path::join` is the only separator-aware part.
    #[test]
    fn git_comes_first_the_install_roots_next_and_path_last() {
        let candidates = build_candidates(
            &["/opt/Git/cmd/git.exe".to_string()],
            &[PathBuf::from("/Program Files")],
            &["/WindowsApps/bash.exe".to_string()],
        );

        // Derived from git: one level up from cmd\ is the install root.
        assert_eq!(candidates[0], "/opt/Git/bin/bash.exe");
        assert_eq!(candidates[1], "/opt/Git/usr/bin/bash.exe");
        // ...and it keeps walking up, because git.exe is not always in cmd\.
        assert!(candidates.contains(&"/opt/bin/bash.exe".to_string()));
        // The install roots come after everything git could tell us.
        let root_pos = candidates
            .iter()
            .position(|c| c == "/Program Files/Git/bin/bash.exe")
            .expect("the install root is a candidate");
        assert!(root_pos > 1, "the roots must not outrank git's own location");
        // PATH is last, so a WSL stub can never win a race it only leads
        // because it happens to come first on PATH.
        assert_eq!(candidates.last().unwrap(), "/WindowsApps/bash.exe");
        assert!(is_wsl_alias_stub(candidates.last().unwrap()));
    }

    #[test]
    fn a_candidate_is_never_listed_twice() {
        let candidates = build_candidates(
            &["/opt/Git/cmd/git.exe".to_string(), "/opt/Git/cmd/git.exe".to_string()],
            &[PathBuf::from("/opt")],
            &["/opt/Git/bin/bash.exe".to_string()],
        );
        let mut seen = candidates.clone();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), candidates.len(), "duplicate candidates: {candidates:?}");
    }

    #[test]
    fn the_failure_message_names_every_candidate_and_marks_the_stubs() {
        let msg = no_bash_message(&[
            r"C:\Program Files\Git\bin\bash.exe".to_string(),
            r"C:\Users\x\AppData\Local\Microsoft\WindowsApps\bash.exe".to_string(),
        ]);
        assert!(msg.contains(r"C:\Program Files\Git\bin\bash.exe"), "{msg}");
        assert!(msg.contains("WSL stub, skipped"), "{msg}");
        assert!(msg.contains("git-scm.com/download/win"), "{msg}");
        // The empty case must still say something an operator can act on.
        assert!(no_bash_message(&[]).contains("neither git nor bash is on PATH"));
    }

    /// The stub filter must run before the existence check, or a stub that
    /// really is on disk would be handed to CreateProcess.
    #[test]
    fn a_windowsapps_path_is_refused_even_when_the_file_exists() {
        let dir = std::env::temp_dir().join(format!("lu-wsl-stub-{}", std::process::id()));
        let apps = dir.join("WindowsApps");
        std::fs::create_dir_all(&apps).unwrap();
        let stub = apps.join(BASH_EXE);
        std::fs::write(&stub, b"").unwrap();
        let stub = stub.to_string_lossy().to_string();

        assert!(Path::new(&stub).is_file(), "the stub is a file on disk");
        assert!(!is_usable_bash(&stub), "and it must still be refused");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `sleeper` has one job: a child that is still there a moment later, with
    /// the pid the caller was handed.
    #[test]
    fn the_sleeper_is_alive_under_its_own_pid_and_dies_when_killed() {
        let mut child = sleeper(30)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn a sleeper");
        let pid = child.id();
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(is_alive(pid), "the sleeper must outlive the test's first look");
        assert!(pid_is_taken(pid));

        let _ = child.kill();
        let _ = child.wait(); // reaped, so not even a zombie is left
        assert!(!is_alive(pid), "a killed and reaped sleeper is not alive");
    }

    /// The descendant lookup is how the bg-task tests find the process a task
    /// started, so it has to actually find one — under the pid of whoever
    /// started it.
    #[test]
    fn descendants_finds_a_child_of_this_process() {
        let mut child = sleeper(20)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn a sleeper");
        let pid = child.id();

        let mut found = false;
        for _ in 0..20 {
            if worker_descendants_of(std::process::id()).contains(&pid) {
                found = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(found, "the child ({pid}) this test started was not found below it");

        let _ = child.kill();
        let _ = child.wait();
    }

    /// The resolved shell has to be a shell that RUNS.
    ///
    /// On Windows this is the end-to-end check on the whole resolver: the WSL
    /// alias stub the PATH offers passes every existence test and then fails
    /// in CreateProcess, so the only way to tell a real bash from it is to
    /// spawn it. `exit` is a shell builtin on purpose — this must not depend
    /// on which of Git Bash's directories are on PATH.
    #[test]
    fn the_resolved_shell_actually_runs_a_one_liner() {
        let status = Command::new(posix_shell())
            .args(["-c", "exit 7"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap_or_else(|e| panic!("could not spawn the resolved shell: {e}"));
        assert_eq!(
            status.code(),
            Some(7),
            "the resolved shell did not run the one-liner it was given",
        );
    }
}
