use crate::os_error;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

use std::path::{Path, PathBuf};

/// Resolve the per-chat agent workspace (`~/agent-workspace/<chat_id>/`).
/// Mirrors commands/filesystem.rs::resolve_path so shell output lands in the
/// SAME folder the file tools write to. Used as the fallback cwd when the
/// caller doesn't pass one — without it the child process inherits the LU
/// app's ambient cwd and dumps build output into ~/Documents (2026-06-04).
///
/// The slug comes from `agent::sanitize_chat_slug`, the one copy that drops
/// `.`: this file used to carry its own that kept it, so a chat id of ".."
/// resolved to `~/agent-workspace/..` == `$HOME` and the shell tool ran (and
/// created directories) straight in the user's home (audit IPC-1).
fn workspace_cwd(chat_id: Option<&str>) -> PathBuf {
    crate::os_paths::agent_workspace_root()
        .join(crate::commands::agent::sanitize_chat_slug(chat_id.unwrap_or("default")))
}

/// The folder a command runs in. The tool tells the model that `cwd` is
/// "relative to the workspace", so a relative one is joined onto the
/// workspace; it used to be checked against the app's own process folder,
/// failed there, and the command ran in the workspace root instead of the
/// subfolder the model asked for (C59 bench, 2026-11-09). An absolute cwd
/// that exists is used as is; anything that is not a folder falls back to
/// the workspace.
pub(crate) fn cwd_in_workspace(cwd: Option<&str>, base: &Path) -> PathBuf {
    match cwd.map(str::trim).filter(|s| !s.is_empty()).map(Path::new) {
        Some(p) => {
            let p = if p.is_absolute() { p.to_path_buf() } else { base.join(p) };
            if p.is_dir() { p } else { base.to_path_buf() }
        }
        None => base.to_path_buf(),
    }
}

/// How much of a command's output travels back to the model. Anything past this
/// is still read off the pipe — it has to be, or the child blocks — but dropped.
const MAX_CAPTURE: usize = 256 * 1024;

/// So viel vom ENDE einer Ausgabe bleibt immer erhalten (C81). `kept` haelt
/// den Anfang und hoert nach MAX_CAPTURE auf; ein llama-server, der nach
/// Stunden stirbt, hat seine letzten Worte aber weit dahinter geschrieben.
const TAIL_CAPTURE: usize = 16 * 1024;

#[derive(Default)]
pub(crate) struct Captured {
    kept: Vec<u8>,
    total: usize,
    /// Die letzten TAIL_CAPTURE Bytes, laufend nachgeschoben.
    tail: std::collections::VecDeque<u8>,
}

impl Captured {
    fn push(&mut self, bytes: &[u8]) {
        self.total += bytes.len();
        let room = MAX_CAPTURE.saturating_sub(self.kept.len());
        if room > 0 {
            self.kept.extend_from_slice(&bytes[..bytes.len().min(room)]);
        }
        let bytes = &bytes[bytes.len().saturating_sub(TAIL_CAPTURE)..];
        let overflow = (self.tail.len() + bytes.len()).saturating_sub(TAIL_CAPTURE);
        self.tail.drain(..overflow);
        self.tail.extend(bytes.iter().copied());
    }
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
                        c.push(&chunk[..n]);
                    }
                }
            }
        }
        flag.store(true, Ordering::Release);
    });
    (buf, done)
}

/// Terminal-Steuerzeichen aus eingefangener Ausgabe entfernen.
///
/// Kindprozesse faerben ihre Ausgabe, wenn sie ein Terminal vermuten, und eine
/// Pipe reicht vielen dafuer aus: llama-server, pip und ComfyUI tun es alle.
/// Die Sequenzen kommen bis 2.6.8 ungefiltert im Fenster an und stehen dort
/// als Kaestchen mitten im Satz (gemessen am 03.09.2026 im Fehlerfeld der
/// Engine).
///
/// Entfernt wird, was ein Terminal steuert, nicht was es zeigt: CSI
/// (`ESC [ … Endbuchstabe`, also auch Farben und Cursorbewegungen), OSC
/// (`ESC ] … BEL` oder `ESC \`, wo Programme Fenstertitel setzen) und die
/// kurzen Zwei-Zeichen-Escapes. Text ohne ESC laeuft unveraendert durch, und
/// ein einzelnes ESC am Ende eines abgeschnittenen Puffers faellt weg statt
/// den Rest zu verschlucken.
///
/// Hier und nicht in der Fehlermeldung: JEDE eingefangene Ausgabe geht durch
/// diese Stelle, also auch die Installerprotokolle und die Agentenausgabe. Und
/// die Mustererkennung darueber (`stderr_blames_the_model` und ihre
/// Geschwister) liest denselben Text; ein Farbcode mitten im Wort hat dort
/// schon Treffer gekostet.
pub(crate) fn strip_ansi(roh: &str) -> String {
    if !roh.contains('\u{1b}') {
        return roh.to_string();
    }
    let mut aus = String::with_capacity(roh.len());
    let mut zeichen = roh.chars().peekable();
    while let Some(c) = zeichen.next() {
        if c != '\u{1b}' {
            aus.push(c);
            continue;
        }
        match zeichen.next() {
            // CSI: Parameter- und Zwischenbytes, dann ein Endbuchstabe 0x40..0x7E.
            Some('[') => {
                for z in zeichen.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&z) {
                        break;
                    }
                }
            }
            // OSC: laeuft bis BEL oder bis ESC \.
            Some(']') => {
                while let Some(z) = zeichen.next() {
                    if z == '\u{7}' {
                        break;
                    }
                    if z == '\u{1b}' {
                        if zeichen.peek() == Some(&'\\') {
                            zeichen.next();
                        }
                        break;
                    }
                }
            }
            // Alles andere ist ein Zwei-Zeichen-Escape und ist damit erledigt.
            Some(_) | None => {}
        }
    }
    aus
}

/// Decode captured bytes leniently. Build tools on a non-UTF-8 Windows codepage
/// emit bytes `read_to_string` rejects outright — that used to throw the whole
/// output away and hand the model an empty string next to a successful exit code.
pub(crate) fn captured_text(buf: &Arc<Mutex<Captured>>) -> String {
    let c = match buf.lock() {
        Ok(c) => c,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut text = strip_ansi(&String::from_utf8_lossy(&c.kept));
    if c.total > c.kept.len() {
        text.push_str(&format!(
            "\n[output truncated: {} of {} bytes shown]",
            c.kept.len(),
            c.total
        ));
    }
    text
}

/// Die letzten `max_lines` nicht leeren Zeilen einer Ausgabe, aus dem
/// Ringpuffer statt aus dem Anfang (C81). Die erste Zeile im Puffer kann
/// abgeschnitten sein und faellt deshalb weg, sobald der Puffer voll war.
pub(crate) fn captured_tail(buf: &Arc<Mutex<Captured>>, max_lines: usize) -> String {
    let c = match buf.lock() {
        Ok(c) => c,
        Err(poisoned) => poisoned.into_inner(),
    };
    let bytes: Vec<u8> = c.tail.iter().copied().collect();
    let wrapped = c.total > c.tail.len();
    drop(c);
    let text = strip_ansi(&String::from_utf8_lossy(&bytes));
    let mut lines: Vec<&str> = text.lines().collect();
    if wrapped && !lines.is_empty() {
        lines.remove(0);
    }
    let lines: Vec<&str> = lines.into_iter().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
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

/// Everything below `root` in `sys` that is actually doing work, still alive,
/// deepest last.
///
/// `conhost.exe` is left out because Windows attaches one to every process
/// that gets a console, CREATE_NO_WINDOW included, and it shows up as a child
/// of the shell before the shell has started anything of its own. Killing it
/// says nothing about the `pnpm install` underneath, and counting it as a
/// survivor would make every cancel wait out its full settle window. The name
/// matches nothing on Unix, so the filter is inert there.
///
/// The production path only reaches this from the non-Windows `kill_tree`
/// below (Windows' own `kill_tree_with` walks `late_descendants` instead); a
/// plain Windows build with the test feature off therefore has no caller
/// left for it, which `cargo clippy --all-targets -- -D warnings` flags as
/// dead code in that one compilation unit even though the test build (via
/// `test_support::worker_descendants_of`, used on every platform) keeps
/// calling it. The gate below covers exactly the compilations that actually
/// use it: every non-Windows build, and every build with tests enabled.
#[cfg(any(not(windows), test))]
pub(crate) fn worker_descendants_in(sys: &sysinfo::System, root: u32) -> Vec<u32> {
    use sysinfo::Pid;
    descendants(root, sys)
        .into_iter()
        .filter(|pid| {
            sys.process(Pid::from_u32(*pid))
                .map(|p| !p.name().to_string_lossy().eq_ignore_ascii_case("conhost.exe"))
                .unwrap_or(false)
        })
        .collect()
}

/// Kill the shell AND everything it started. `Child::kill()` signals only the
/// shell itself, so a timed-out `npm run dev`, build script or spawned server
/// kept running after the tool call gave up — still holding its port and CPU,
/// and still writing into a pipe nobody reads.
#[cfg(not(windows))]
pub(crate) fn kill_tree(root: u32) {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    // Leaves first: a parent that is still alive can't respawn what we killed.
    let mut order = worker_descendants_in(&sys, root);
    order.reverse();
    order.push(root);
    for pid in order {
        if let Some(p) = sys.process(Pid::from_u32(pid)) {
            p.kill();
        }
    }
}

/// How long the Windows sweep keeps looking for a worker that appeared while
/// it was running, and how often it looks. A shell that is cancelled during
/// its own startup is the case this exists for, so the window only has to
/// cover a `CreateProcess` that was already under way.
#[cfg(windows)]
const TREE_KILL_SETTLE: Duration = Duration::from_millis(1500);
#[cfg(windows)]
const TREE_KILL_POLL: Duration = Duration::from_millis(50);

/// The ONE Windows tree kill. `process_util::kill_tree` and
/// `process_util::kill_pid_tree` hand their Windows branch to this function
/// instead of calling `taskkill` themselves, so the cloudflared tunnel, the
/// mlx_video job and an adopted ComfyUI get the same sweep the shell gets.
#[cfg(windows)]
pub(crate) fn kill_tree(root: u32) {
    kill_tree_with(root, start_time_of(root));
}

/// Same as [`kill_tree`], with the root's start time injected.
///
/// The real code path always comes through [`kill_tree`], which reads the
/// token itself while the root is still alive. It is separated so the sweep
/// can be tested against the state it exists for, a live worker under a dead
/// root, which cannot be reached any other way: producing that state means
/// felling the root first, and after that its start time is unreadable.
#[cfg(windows)]
pub(crate) fn kill_tree_with(root: u32, root_start: Option<u64>) {
    if root == 0 { return; }
    // sysinfo0.33 kills each snapshot member with a separate taskkill /PID.
    // During shell startup a new child can appear between those calls and
    // retain the output pipe after its parent dies. Ask Windows to end the
    // owned tree in one operation, not a stale list of individual processes.
    //
    // But one operation is still ONE enumeration. A shell cancelled while it
    // was starting up calls CreateProcess for its worker after taskkill has
    // already walked the tree: the shell dies, the worker lives, it holds the
    // inherited output pipes, and the task stays "running" until the worker
    // finishes by itself. Proven on the Windows box (2026-09-19): cancelling
    // `ping -n 31` 100 ms after the start left the task running for 30.4 s in
    // two of five rounds, exactly the ping's own lifetime, and for a
    // `cargo build` that is minutes of work that Stop claimed to have ended.
    //
    // So the tree is read once BEFORE the kill, for the root's start time, and
    // looked at again afterwards. taskkill cannot walk a tree from a root that
    // is already dead, which is why each leftover is felled as a root of its
    // own. The loop ends as soon as nothing is left, and otherwise after
    // TREE_KILL_SETTLE, for as long as taskkill itself returns.
    //
    // `/T` follows parent links and nothing else. When a process older than
    // `root` is recorded under it, the number `root` has was once held by that
    // stranger's creator, and `/T` would take the stranger and everything
    // below it along. Then only `root` itself is ended here, and the sweep
    // below fells what is provably its own.
    if carries_a_stranger(root, root_start) {
        taskkill_one(root);
    } else {
        taskkill_tree(root);
    }
    let deadline = Instant::now() + TREE_KILL_SETTLE;
    loop {
        let leftovers = late_descendants(root, root_start);
        if leftovers.is_empty() {
            return;
        }
        for pid in leftovers {
            taskkill_tree(pid);
        }
        if Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(TREE_KILL_POLL);
    }
}

/// End `root` and the tree Windows currently records below it, and wait for
/// that to have happened.
#[cfg(windows)]
fn taskkill_tree(root: u32) {
    taskkill(root, true);
}

/// End `root` alone and wait for that to have happened.
#[cfg(windows)]
fn taskkill_one(root: u32) {
    taskkill(root, false);
}

#[cfg(windows)]
fn taskkill(root: u32, with_tree: bool) {
    let pid = root.to_string();
    let args: &[&str] = if with_tree { &["/PID", &pid, "/T", "/F"] } else { &["/PID", &pid, "/F"] };
    let mut command = Command::new("taskkill.exe");
    command.args(args)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    crate::process_util::suppress_window(&mut command);
    if let Ok(mut killer) = command.spawn() {
        finish_tree_kill(&mut killer);
    }
}

/// Whether a process that is older than `root` is recorded as its child.
/// See [`late_descendants`] for why the age is the token. Without a start
/// time for `root` there is nothing to compare against, and the answer is no.
#[cfg(windows)]
fn carries_a_stranger(root: u32, root_start: Option<u64>) -> bool {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let Some(root_start) = root_start else { return false };
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    is_a_stranger_under(root, root_start, sys.processes().values().map(|p| (p.parent().map(Pid::as_u32), p.start_time())))
}

/// The rule of [`carries_a_stranger`] on plain numbers, so it can be tested
/// without a recycled pid, which no test can order from Windows.
#[cfg(any(windows, test))]
fn is_a_stranger_under(root: u32, root_start: u64, mut table: impl Iterator<Item = (Option<u32>, u64)>) -> bool {
    table.any(|(parent, start)| parent == Some(root) && start < root_start)
}

/// When `root` was created, read while it is still alive. `None` once it is
/// gone, and `None` is what stops the sweep below from running at all.
#[cfg(windows)]
fn start_time_of(root: u32) -> Option<u64> {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    sys.process(Pid::from_u32(root)).map(|p| p.start_time())
}

/// The processes still running under `root` that this sweep is allowed to
/// fell: reachable from `root` through parent links, each one no older than
/// the parent it hangs from, none of them older than `root` itself.
///
/// The age test is what keeps the sweep inside its own tree, and it is the
/// same token `process_util::tree_snapshot` uses for the delayed SIGKILL on
/// Unix ("same pid AND same start time is the same process"). Windows keeps
/// the parent pid in a process entry after the parent is gone, which is what
/// makes a leftover findable at all, but a stale entry is then
/// indistinguishable from a fresh one: a stranger whose own long dead creator
/// once held this number carries `root` as its parent too, and felling it with
/// `/T` would take its children with it. A stranger like that was started
/// before `root` was, so it is dropped here.
///
/// `start_time` counts whole seconds, so a worker started microseconds after
/// its shell usually reports the SAME second: the test has to be "not older",
/// not "strictly younger", and it therefore separates a process from a
/// SECOND-old stranger, not from a millisecond-old one. That is exactly the
/// distance the hazard has, since a stranger that inherits a recycled pid has
/// been running since long before this sweep began.
///
/// Without a start time for `root` there is no token at all, and then nothing
/// is swept: felling a process on a parent link alone is the thing this
/// function exists to avoid.
#[cfg(windows)]
fn late_descendants(root: u32, root_start: Option<u64>) -> Vec<u32> {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let Some(root_start) = root_start else { return Vec::new() };
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for (pid, proc_) in sys.processes() {
        if let Some(parent) = proc_.parent() {
            children.entry(parent.as_u32()).or_default().push(pid.as_u32());
        }
    }
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    seen.insert(root);
    // Level by level, so a child is only ever judged against a parent this
    // sweep has already accepted.
    let mut frontier = vec![(root, root_start)];
    while let Some((parent, parent_start)) = frontier.pop() {
        let Some(kids) = children.get(&parent) else { continue };
        for pid in kids.clone() {
            if !seen.insert(pid) {
                continue; // PID reuse can't be allowed to make this loop forever
            }
            let Some(proc_) = sys.process(Pid::from_u32(pid)) else { continue };
            if proc_.name().to_string_lossy().eq_ignore_ascii_case("conhost.exe") {
                continue;
            }
            let start = proc_.start_time();
            if start < parent_start {
                continue; // older than the process it claims to hang from
            }
            out.push(pid);
            frontier.push((pid, start));
        }
    }
    out
}

#[cfg(windows)]
fn finish_tree_kill(killer: &mut std::process::Child) {
    // Der Aufrufer toetet danach die Shell als Rueckfall. Kehrt diese Stelle
    // vor taskkill zurueck, verschwindet dessen Wurzel vor der Baumsuche und
    // das Kind ueberlebt. Den Helfer weiterlaufen zu lassen reicht nicht:
    // sein Ende muss vor dem Rueckfall liegen. Auf der Box mit einem um
    // 2,5 Sekunden verzoegerten Helfer samt Gegenprobe nachgewiesen.
    let _ = killer.wait();
}

#[cfg(all(test, windows))]
mod windows_stop_tests {
    use super::*;
    use crate::test_support::{is_alive, worker_descendants_of};
    use std::time::{Duration, Instant};

    #[test]
    fn a_slow_tree_killer_finishes_before_the_shell_fallback() {
        let mut shell = Command::new("powershell.exe");
        shell.args(["-NoProfile", "-NonInteractive", "-Command", "ping -n 31 127.0.0.1"])
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        crate::process_util::suppress_window(&mut shell);
        let mut shell = shell.spawn().expect("start test shell");
        let (_, out_done) = drain(shell.stdout.take().unwrap());
        let (_, err_done) = drain(shell.stderr.take().unwrap());
        let ready = Instant::now();
        let children = loop {
            let children = worker_descendants_of(shell.id());
            if !children.is_empty() { break children; }
            if ready.elapsed() >= Duration::from_secs(30) {
                kill_tree(shell.id());
                let _ = shell.wait();
                panic!("test shell did not start its child");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(children.iter().all(|pid| is_alive(*pid)));

        // Ein echter PID-begrenzter taskkill, nur sein Start liegt sicher
        // hinter der alten Zwei-Sekunden-Frist. Keine globale PATH-Aenderung.
        let mut killer = Command::new("powershell.exe");
        killer.args(["-NoProfile", "-NonInteractive", "-Command", &format!(
            "Start-Sleep -Milliseconds 2500; & $env:SystemRoot\\System32\\taskkill.exe /PID {} /T /F",
            shell.id(),
        )]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        crate::process_util::suppress_window(&mut killer);
        let mut killer = killer.spawn().expect("start delayed tree killer");
        finish_tree_kill(&mut killer);
        let _ = shell.kill();
        let _ = shell.wait();
        let _ = killer.wait();
        settle(&out_done, &err_done, Duration::from_millis(500));
        let survivors: Vec<_> = children.into_iter().filter(|pid| is_alive(*pid)).collect();
        let drained = out_done.load(Ordering::Acquire) && err_done.load(Ordering::Acquire);

        // Auch die rote Gegenprobe raeumt ausschliesslich ihre Kinder ab.
        for pid in &survivors { kill_tree(*pid); }
        assert!(survivors.is_empty(), "shell fallback orphaned children: {survivors:?}");
        assert!(drained, "cancelled tree retained an output pipe");
    }

    /// The startup race, held still. A shell cancelled while it is still
    /// starting up calls CreateProcess for its worker after taskkill has
    /// already walked the tree, and one instant later that worker is a live
    /// process under a dead parent, holding the output pipes it inherited.
    /// taskkill cannot walk a tree from a root that no longer exists, so the
    /// single enumeration the sweep used to rely on left the worker running
    /// and the cancelled task went on reporting "running" until the worker
    /// finished by itself: measured on the box as 30.4 s stalls in two of
    /// five cancels of a `ping -n 31` that Stop had supposedly killed, and
    /// for the `cargo build` this module exists for, minutes.
    ///
    /// Reproduced here without waiting for the race to happen: fell the shell
    /// alone, with `/F` and no `/T`, which leaves exactly that state behind.
    #[test]
    fn a_worker_left_under_a_dead_shell_is_still_felled() {
        let mut shell = Command::new("powershell.exe");
        shell.args(["-NoProfile", "-NonInteractive", "-Command", "ping -n 31 127.0.0.1"])
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        crate::process_util::suppress_window(&mut shell);
        let mut shell = shell.spawn().expect("start test shell");
        let (_, out_done) = drain(shell.stdout.take().unwrap());
        let (_, err_done) = drain(shell.stderr.take().unwrap());
        let ready = Instant::now();
        let workers = loop {
            let workers = worker_descendants_of(shell.id());
            if !workers.is_empty() { break workers; }
            if ready.elapsed() >= Duration::from_secs(30) {
                kill_tree(shell.id());
                let _ = shell.wait();
                panic!("test shell did not start its child");
            }
            std::thread::sleep(Duration::from_millis(20));
        };

        // Read while the shell is alive, exactly as `kill_tree` reads it, and
        // before the incomplete kill below makes it unreadable.
        let root_start = start_time_of(shell.id());

        // The shell only. Nothing walks the tree, so the worker stays: this
        // is the sweep that missed a worker started one instant behind it.
        let mut lonely = Command::new("taskkill.exe");
        lonely.args(["/PID", &shell.id().to_string(), "/F"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        crate::process_util::suppress_window(&mut lonely);
        if let Ok(mut lonely) = lonely.spawn() {
            let _ = lonely.wait();
        }
        // `shell` is deliberately not waited on yet: the open handle keeps the
        // number reserved, so the parent link the sweep follows still means
        // this shell and cannot have been handed to a stranger.
        assert!(
            workers.iter().all(|pid| is_alive(*pid)),
            "the worker was gone before the sweep was even asked: {workers:?}"
        );

        kill_tree_with(shell.id(), root_start);

        let _ = shell.wait();
        settle(&out_done, &err_done, Duration::from_millis(1500));
        let survivors: Vec<_> = workers.into_iter().filter(|pid| is_alive(*pid)).collect();
        let drained = out_done.load(Ordering::Acquire) && err_done.load(Ordering::Acquire);

        for pid in &survivors { kill_tree(*pid); }
        assert!(survivors.is_empty(), "a worker under a dead shell survived the sweep: {survivors:?}");
        assert!(drained, "the cancelled tree kept an output pipe");
    }

    /// The age test that keeps the sweep inside its own tree. Windows leaves
    /// the parent pid in a process entry after the parent is gone, so a
    /// stranger whose own long dead creator once held our number carries our
    /// root as its parent and would be felled with `/T`, children and all.
    /// Such a stranger has been running since before the root started, which
    /// is what the test below stands in for: with a root start time in the
    /// future, every real child is "older than its parent" and none may be
    /// touched. The other two cases pin the ends: the real start time finds
    /// the child, and no start time at all sweeps nothing.
    #[test]
    fn only_a_worker_no_older_than_its_root_is_swept() {
        let mut child = Command::new("ping.exe");
        child.args(["-n", "31", "127.0.0.1"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        crate::process_util::suppress_window(&mut child);
        let mut child = child.spawn().expect("start test worker");
        let worker = child.id();
        let me = std::process::id();
        let ready = Instant::now();
        while !worker_descendants_of(me).contains(&worker) {
            assert!(ready.elapsed() < Duration::from_secs(30), "the test worker never showed up below this process");
            std::thread::sleep(Duration::from_millis(20));
        }

        let an_hour_ahead = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() + 3600)
            .expect("a clock behind 1970");
        let too_old = late_descendants(me, Some(an_hour_ahead));
        let found = late_descendants(me, start_time_of(me));
        let no_token = late_descendants(me, None);

        let _ = child.kill();
        let _ = child.wait();

        assert!(
            !too_old.contains(&worker),
            "a worker older than the root it hangs from was swept anyway: {too_old:?}"
        );
        assert!(
            found.contains(&worker),
            "the real start time must still find this process's own worker: {found:?}"
        );
        assert!(
            no_token.is_empty(),
            "without a start time for the root there is nothing to judge against, so nothing may be swept: {no_token:?}"
        );
    }
}

// ── Stop erreicht einen schon gestarteten Befehl ──────────────────────────
//
// Bis heute konnte es das nicht, und der Kommentar an `executeShellExecute`
// auf der anderen Seite der Bruecke sagte es offen: "the bridge has NO cancel
// for it. Rust `shell_execute` takes no run id and there is no
// shell_execute_cancel, so the child keeps running to its own timeout. The
// executor stops WAITING on it, which ends the run and the UI, but the process
// survives."
//
// Der Ausfuehrer hoert also auf zu warten, die Oberflaeche wird ruhig, und der
// Befehl laeuft zu Ende: ein Build, ein Testlauf, ein Skript, das Dateien
// anfasst, bis zu zwei Minuten nachdem der Mensch Stop gedrueckt hat. Das ist
// dieselbe Sorte Luege wie ein Stopp-Knopf, der nichts abbricht, nur auf der
// Maschine des Nutzers statt auf der Rechnung.
//
// Was fehlte, war eine KENNUNG: ohne sie hat der Abbruch nichts, worauf er
// zeigen koennte. Der Aufrufer schickt jetzt eine mit, diese Karte haelt die
// zugehoerige Prozesskennung, und `shell_execute_cancel` faellt den Baum mit
// derselben `kill_tree`, die auch die Zeitgrenze benutzt.
//
// Der Wettlauf ist mitgedacht und der Grund fuer `cancelled` neben `pid`: der
// Abbruch kann eintreffen, BEVOR der Prozess ueberhaupt existiert. Dann gibt es
// keine Prozesskennung zu toeten, und ohne Merker liefe der Befehl los,
// nachdem er abgebrochen wurde. Die Karte merkt sich den Abbruch also auch
// ohne pid, und der Start sieht danach.

/// Ein Vordergrundbefehl, solange er laeuft. `pid` fehlt im Fenster zwischen
/// Anmelden und Start.
struct RunningShell {
    pid: Option<u32>,
    cancelled: bool,
    /// R1-9: wann diese Karte entstand. `shell_mark_cancelled` legt ueber
    /// `or_default()` einen Eintrag an, auch wenn der zugehoerige Lauf nie
    /// startet (ein doppelter oder verspaeteter Abbruch, eine falsche
    /// Kennung vom Aufrufer), ohne `pid` faellt `ShellSlot::drop` nie fuer
    /// ihn, also blieb die Karte fuer den Rest der Sitzung liegen. `Instant`
    /// statt `SystemTime`: eine Uhrumstellung darf das Fegen nicht verzerren.
    created_at: Instant,
}

impl Default for RunningShell {
    fn default() -> Self {
        RunningShell { pid: None, cancelled: false, created_at: Instant::now() }
    }
}

/// Wie alt eine Karte ohne `pid` werden darf, bevor `shell_register` sie
/// fegt. Eine Minute ist grosszuegig gegen jede reale Wettlaufbreite
/// zwischen Anmelden und Start (Millisekunden), aber kurz genug, dass eine
/// lang laufende Sitzung mit vielen Abbruechen nicht unbegrenzt waechst.
const STALE_SHELL_ENTRY_AGE: Duration = Duration::from_secs(60);

static RUNNING_SHELLS: once_cell::sync::Lazy<Mutex<std::collections::HashMap<String, RunningShell>>> =
    once_cell::sync::Lazy::new(Default::default);

/// Diesen Lauf anmelden, bevor gestartet wird. Ein Abbruch, der schon da war,
/// bleibt stehen — sonst gewaenne der Start den Wettlauf gegen den Stop.
///
/// R1-9: vor dem Eintragen werden veraltete `pid`-lose Karten weggeraeumt.
/// Ein Eintrag MIT `pid` ist ein echter laufender Prozess und wird nie
/// gefegt, gleich wie alt.
fn shell_register(call_id: &str) {
    let mut karte = RUNNING_SHELLS.lock().unwrap();
    karte.retain(|_, eintrag| eintrag.pid.is_some() || eintrag.created_at.elapsed() < STALE_SHELL_ENTRY_AGE);
    karte.entry(call_id.to_string()).or_default();
}

/// Die Prozesskennung nachtragen. Gibt `true`, wenn inzwischen abgebrochen
/// wurde: dann ist der eben gestartete Prozess sofort wieder zu toeten.
fn shell_attach_pid(call_id: &str, pid: u32) -> bool {
    let mut karte = RUNNING_SHELLS.lock().unwrap();
    match karte.get_mut(call_id) {
        Some(eintrag) => {
            eintrag.pid = Some(pid);
            eintrag.cancelled
        }
        // Nicht angemeldet heisst: dieser Lauf traegt keine Kennung, er ist
        // also auch nicht abbrechbar. Kein Grund, ihn zu toeten.
        None => false,
    }
}

fn shell_is_cancelled(call_id: &str) -> bool {
    RUNNING_SHELLS.lock().unwrap().get(call_id).map(|e| e.cancelled).unwrap_or(false)
}

fn shell_unregister(call_id: &str) {
    RUNNING_SHELLS.lock().unwrap().remove(call_id);
}

/// Abmelden beim Verlassen, an EINER Stelle.
///
/// `shell_execute_sync` kehrt an sechs Stellen zurueck, darunter zwei
/// Fehlerpfade mit `?`. Eine Aufraeumzeile, die an jeder davon stehen muss,
/// steht irgendwann an einer nicht mehr, und der Eintrag bliebe fuer den Rest
/// der Sitzung liegen: eine Karte, die nur waechst, und eine Kennung, die ein
/// spaeterer Abbruch auf einen laengst toten Prozess zeigen laesst. Dieselbe
/// Begruendung wie bei `lib/run-slot.ts` auf der anderen Seite.
struct ShellSlot(Option<String>);

impl ShellSlot {
    fn new(call_id: Option<&str>) -> Self {
        let kennung = call_id.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        if let Some(id) = kennung.as_deref() {
            shell_register(id);
        }
        Self(kennung)
    }

    fn id(&self) -> Option<&str> {
        self.0.as_deref()
    }
}

impl Drop for ShellSlot {
    fn drop(&mut self) {
        if let Some(id) = self.0.as_deref() {
            shell_unregister(id);
        }
    }
}

/// Abbrechen. Gibt die Prozesskennung zurueck, falls der Prozess schon lebt.
///
/// Der Eintrag wird ANGELEGT, wenn es ihn noch nicht gibt: ein Abbruch, der
/// den Start ueberholt, muss stehen bleiben, bis der Start ihn liest.
fn shell_mark_cancelled(call_id: &str) -> Option<u32> {
    let mut karte = RUNNING_SHELLS.lock().unwrap();
    let eintrag = karte.entry(call_id.to_string()).or_default();
    eintrag.cancelled = true;
    eintrag.pid
}

/// Was ein abgebrochener Befehl zurueckgibt.
///
/// Eigenes Feld `cancelled` und NICHT `timedOut`: eine Zeitgrenze ist etwas,
/// das dem Befehl passiert ist, ein Abbruch etwas, das der Mensch getan hat.
/// Auf der anderen Seite haengt daran, welchen Satz das Modell zu lesen bekommt.
/// `exitCode` bleibt -1, wie bei der Zeitgrenze auch, denn einen echten gibt es
/// nicht mehr.
fn cancelled_result(stdout: String) -> serde_json::Value {
    serde_json::json!({
        "stdout": stdout,
        "stderr": "Cancelled: the user stopped the run.",
        "exitCode": -1,
        "timedOut": false,
        "cancelled": true,
    })
}

/// Stop fuer einen laufenden `shell_execute`.
///
/// Ruft der Ausfuehrer, sobald das Abbruchsignal des Laufs feuert. Unbekannte
/// Kennungen sind KEIN Fehler: der Befehl kann in derselben Millisekunde fertig
/// geworden sein, und eine Fehlermeldung dafuer haette der Mensch nicht
/// verursacht.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn shell_execute_cancel(callId: String) -> Result<bool, String> {
    let pid = shell_mark_cancelled(&callId);
    match pid {
        Some(p) => {
            tokio::task::spawn_blocking(move || kill_tree(p))
                .await
                .map_err(|e| format!("Task join error: {}", e))?;
            Ok(true)
        }
        // Noch kein Prozess: der Merker steht, und der Start toetet sofort
        // selbst, sobald er ihn liest.
        None => Ok(false),
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
    callId: Option<String>,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        shell_execute_sync(command, args, cwd, timeout, shell, stdin, chatId, workingDirectory, callId)
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
    call_id: Option<String>,
) -> Result<serde_json::Value, String> {
    // VOR dem Bauen des Befehls angemeldet, damit ein Abbruch, der den Start
    // ueberholt, einen Platz hat, an dem er stehen bleiben kann.
    let slot = ShellSlot::new(call_id.as_deref());
    let timeout_ms = timeout.unwrap_or(120_000);
    // Shell name in, program + argument form out — the same function the
    // background twin in bg_tasks.rs calls, so the two cannot drift apart.
    let (shell_bin, shell_args) =
        shell_argv(cfg!(target_os = "windows"), shell.as_deref(), &command);

    // Runde 3, Nachbesserung 3: the background twin in bg_tasks.rs already
    // runs the shell itself through `foreign_system_command_tokio` (K14
    // Runde 2, Punkt 5/6) because it is a foreign program exactly like
    // `git`/`python`, and an AppImage's poisoned LD_LIBRARY_PATH can break
    // it the same way. This, the FOREGROUND twin using the identical
    // `shell_argv`, was the gap the review named as the most visible one
    // left: every `sh -c`/`bash -c` the coding agent runs here inherited
    // the poisoned environment, and with it every `git`/`pip`/`python` the
    // user types inside it.
    let mut cmd = crate::process_util::foreign_system_command(&shell_bin);
    cmd.args(&shell_args);

    // Fehlerkontrolle Mac 2, Fund 7: an app opened from the Finder has the
    // launchd PATH, and so had this shell. `brew`, `node`, `uv`, `ffmpeg` and
    // everything else under /opt/homebrew answered "command not found" for the
    // agent although the same line works in the user's terminal. The child
    // gets the PATH of the user's login shell instead (read once, bounded,
    // never an interactive shell; see `finder_path`).
    #[cfg(target_os = "macos")]
    cmd.env("PATH", crate::finder_path::child_path());

    // Append extra args
    if let Some(extra_args) = args {
        for a in extra_args {
            cmd.arg(&a);
        }
    }

    // Working directory. Use the explicit cwd when it exists; otherwise fall
    // back to the per-chat agent workspace (created if missing) so a relative
    // command never runs in the app's ambient cwd and scatters files into
    // ~/Documents (2026-06-04). Mirrors the file tools' path resolution.
    let base: PathBuf = match working_directory.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        // Folder workspace (the user's repo, from chatCtx.workingDirectory)
        // wins over the per-chat sandbox for relative commands (#62).
        Some(wd) => PathBuf::from(wd),
        None => {
            let w = workspace_cwd(chat_id.as_deref());
            let _ = std::fs::create_dir_all(&w);
            w
        }
    };
    let workdir = cwd_in_workspace(cwd.as_deref(), &base);
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

    // Der Abbruch kann zwischen Anmelden und Start eingetroffen sein. Dann gab
    // es keine Prozesskennung zu toeten, und dieser Prozess hier ist genau der,
    // den niemand mehr wollte.
    if let Some(id) = slot.id() {
        if shell_attach_pid(id, child.id()) {
            kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            return Ok(cancelled_result(String::new()));
        }
    }

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
        // Der Stop steht VOR dem Abholen des Endstands. Andersherum gewaenne
        // ein Befehl, den `shell_execute_cancel` gerade erschlagen hat, einen
        // gewoehnlichen Exit-Code, und das Modell bekaeme einen Fehlschlag
        // gemeldet statt eines Abbruchs, den der Mensch selbst ausgeloest hat.
        if slot.id().map(shell_is_cancelled).unwrap_or(false) {
            kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait(); // reap, or the shell lingers as a zombie
            settle(&out_done, &err_done, std::time::Duration::from_millis(200));
            // Was der Befehl bis hierher gedruckt hat, kommt mit — dieselbe
            // Regel wie bei der Zeitgrenze ein paar Zeilen weiter unten.
            return Ok(cancelled_result(captured_text(&out_buf)));
        }
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

/// Der Abbruch eines schon gestarteten Befehls.
///
/// Geprueft wird die BUCHFUEHRUNG, nicht das Toeten selbst: `kill_tree` haengt
/// am Betriebssystem und an echten Prozessen, die Reihenfolge dagegen ist
/// reine Logik und genau die Stelle, an der ein Abbruch lautlos verlorengeht.
///
/// Der teuerste Fall steht zuerst: der Abbruch, der den Start UEBERHOLT. Ohne
/// den Merker gaebe es in diesem Fenster keine Prozesskennung zu toeten, der
/// Befehl liefe an, nachdem der Mensch ihn gestoppt hat, und niemand saehe es.
///
/// Lauf: cargo test shell_cancel
#[cfg(test)]
mod shell_cancel_tests {
    use super::*;

    /// Eigene Kennung je Test: die Karte ist prozessweit, und cargo faehrt die
    /// Tests eines Binaries nebenlaeufig.
    fn kennung(name: &str) -> String {
        format!("test-{}-{:?}", name, std::thread::current().id())
    }

    #[test]
    fn shell_cancel_ein_abbruch_vor_dem_start_bleibt_stehen() {
        let id = kennung("vor-dem-start");
        shell_register(&id);
        // Der Abbruch kommt, waehrend noch kein Prozess existiert.
        assert_eq!(shell_mark_cancelled(&id), None, "es gibt noch keine Prozesskennung");
        // Und der Start liest ihn: `true` heisst "sofort wieder toeten".
        assert!(shell_attach_pid(&id, 4242), "der Start muss den Abbruch sehen");
        shell_unregister(&id);
    }

    #[test]
    fn shell_cancel_ein_abbruch_ohne_anmeldung_legt_den_merker_an() {
        // Die Reihenfolge, die der Wettlauf zwischen Fenster und Bruecke
        // wirklich erzeugt: der Abbruch ist schneller als der Rust-Aufruf.
        let id = kennung("ueberholt");
        assert_eq!(shell_mark_cancelled(&id), None);
        shell_register(&id); // darf den Merker NICHT ueberschreiben
        assert!(shell_is_cancelled(&id));
        assert!(shell_attach_pid(&id, 7));
        shell_unregister(&id);
    }

    #[test]
    fn shell_cancel_findet_den_laufenden_prozess() {
        let id = kennung("laeuft");
        shell_register(&id);
        assert!(!shell_attach_pid(&id, 1234), "ohne Abbruch laeuft er weiter");
        assert!(!shell_is_cancelled(&id));
        assert_eq!(shell_mark_cancelled(&id), Some(1234), "die Prozesskennung kommt zurueck");
        assert!(shell_is_cancelled(&id), "und die Schleife sieht den Abbruch");
        shell_unregister(&id);
    }

    #[test]
    fn shell_cancel_ein_lauf_ohne_kennung_ist_unberuehrt() {
        // Altbestand und die Fernbruecke schicken keine Kennung. Die duerfen
        // nicht plombiert werden, nur weil ein anderer Lauf abgebrochen wurde.
        let id = kennung("fremd");
        shell_mark_cancelled(&id);
        assert!(!shell_attach_pid("gar-nicht-angemeldet", 99));
        assert!(!shell_is_cancelled("gar-nicht-angemeldet"));
        shell_unregister(&id);
    }

    #[test]
    fn shell_cancel_der_platz_meldet_sich_beim_verlassen_ab() {
        // Sonst waechst die Karte mit jedem Befehl, und eine spaeter erneut
        // vergebene Kennung zeigte auf einen laengst toten Prozess.
        let id = kennung("aufraeumen");
        {
            let slot = ShellSlot::new(Some(&id));
            assert_eq!(slot.id(), Some(id.as_str()));
            shell_attach_pid(&id, 31337);
            assert_eq!(shell_mark_cancelled(&id), Some(31337));
        }
        assert!(!shell_is_cancelled(&id), "der Eintrag ist weg, nicht nur zurueckgesetzt");
        assert_eq!(shell_mark_cancelled(&id), None);
        shell_unregister(&id);
    }

    #[test]
    fn shell_cancel_eine_leere_kennung_zaehlt_als_keine() {
        // JSON aus dem Fenster kann "" liefern. Ein Platz unter dem leeren
        // Namen waere ein Eimer, in dem sich alle Laeufe treffen.
        let slot = ShellSlot::new(Some("   "));
        assert_eq!(slot.id(), None);
        let ohne = ShellSlot::new(None);
        assert_eq!(ohne.id(), None);
    }

    #[test]
    fn shell_cancel_die_antwort_nennt_den_abbruch_und_nicht_die_zeitgrenze() {
        // Eine Zeitgrenze ist etwas, das dem Befehl passiert ist, ein Abbruch
        // etwas, das der Mensch getan hat. Das Modell liest den Unterschied.
        let v = cancelled_result("halb fertig".to_string());
        assert_eq!(v["cancelled"], serde_json::json!(true));
        assert_eq!(v["timedOut"], serde_json::json!(false));
        assert_eq!(v["exitCode"], serde_json::json!(-1));
        assert_eq!(v["stdout"], serde_json::json!("halb fertig"));
        assert!(v["stderr"].as_str().unwrap().contains("stopped the run"));
    }

    /// R1-9 Testhelfer: `created_at` einer Karte auf ein Alter zurueckdatieren,
    /// ohne `sleep` im Test. `checked_sub` statt Subtraktion: `Instant` darf
    /// auf mancher Plattform nicht unter den Prozessstart fallen.
    fn shell_test_set_created_at(call_id: &str, age: Duration) {
        let mut karte = RUNNING_SHELLS.lock().unwrap();
        if let Some(eintrag) = karte.get_mut(call_id) {
            eintrag.created_at = Instant::now().checked_sub(age).unwrap_or_else(Instant::now);
        }
    }

    fn shell_test_contains(call_id: &str) -> bool {
        RUNNING_SHELLS.lock().unwrap().contains_key(call_id)
    }

    #[test]
    fn shell_register_fegt_alte_pid_lose_eintraege_weg() {
        // Negativkontrolle steht im naechsten Test: eine junge Karte ohne pid
        // bleibt stehen, nur das Alter entscheidet.
        //
        // Die Karte wird geprueft, solange sie jung ist. Die Karte ist eine
        // fuer alle Tests, und jedes `shell_register` eines Nachbartests fegt:
        // nach dem Zurueckdatieren darf die Karte also schon fort sein, bevor
        // der eigene Ausloeser laeuft. Linux, 08.10.2026: ein voller Lauf rot
        // an der Pruefung, die hier frueher nach dem Zurueckdatieren stand.
        let alt = kennung("alt-ohne-pid");
        shell_register(&alt);
        assert!(shell_test_contains(&alt), "die Karte muss vor dem Fegen existieren");
        shell_test_set_created_at(&alt, STALE_SHELL_ENTRY_AGE + Duration::from_secs(1));

        let ausloeser = kennung("ausloeser");
        shell_register(&ausloeser); // das naechste shell_register fegt

        assert!(!shell_test_contains(&alt), "eine veraltete pid-lose Karte muss weg sein");
        shell_unregister(&ausloeser);
    }

    #[test]
    fn shell_register_laesst_junge_pid_lose_eintraege_und_jeden_mit_pid_stehen() {
        let jung = kennung("jung-ohne-pid");
        shell_register(&jung);
        shell_test_set_created_at(&jung, Duration::from_secs(1));

        let alt_mit_pid = kennung("alt-mit-pid");
        shell_register(&alt_mit_pid);
        shell_attach_pid(&alt_mit_pid, 555);
        shell_test_set_created_at(&alt_mit_pid, STALE_SHELL_ENTRY_AGE + Duration::from_secs(60));

        let ausloeser = kennung("ausloeser-2");
        shell_register(&ausloeser);

        assert!(shell_test_contains(&jung), "eine junge Karte darf nicht gefegt werden");
        assert!(shell_test_contains(&alt_mit_pid), "eine Karte MIT pid wird nie gefegt, egal wie alt");

        shell_unregister(&jung);
        shell_unregister(&alt_mit_pid);
        shell_unregister(&ausloeser);
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

    /// Fehlerkontrolle Mac 2, Fund 7. The agent's shell runs with the PATH of
    /// the user's login shell and not with whatever this process inherited.
    /// From the Finder that inherited PATH is `/usr/bin:/bin:/usr/sbin:/sbin`.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_agents_shell_gets_the_login_path_on_a_mac() {
        let dir = tempfile::tempdir().expect("tempdir");
        let out = shell_execute_sync(
            "printf %s \"$PATH\"".to_string(),
            None,
            Some(dir.path().to_string_lossy().to_string()),
            Some(20_000),
            None,
            None,
            None,
            None,
            None,
        )
        .expect("the shell ran");
        let seen = out["stdout"].as_str().unwrap_or_default().to_string();
        assert_eq!(seen, crate::finder_path::child_path().to_string_lossy());
        // The property itself, not only the wiring: what a login shell adds
        // on every Mac (`/etc/paths` names /usr/local/bin) is there.
        assert!(seen.split(':').any(|p| p == "/usr/local/bin"), "{seen}");
    }

    /// The same rule holds for a task the agent starts in the background.
    #[test]
    fn both_shell_paths_hand_the_login_path_to_the_child() {
        let needle = ["finder_path", "::child_path()"].concat();
        for (name, src) in [("shell.rs", include_str!("shell.rs")), ("bg_tasks.rs", include_str!("bg_tasks.rs"))] {
            assert!(src.contains(&needle), "{name} starts a shell without the login PATH on a Mac");
        }
    }

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
    fn eingefangene_ausgabe_kommt_ohne_farbcodes_heraus() {
        // Die Verdrahtung, nicht der Filter: `strip_ansi` allein gruen zu
        // haben hiess bis hierher gar nichts, denn die Ausgabe lief an ihm
        // vorbei ins Fenster (gemessen am 03.09.2026 im Fehlerfeld der
        // Engine). Geprueft wird deshalb der Weg, den die echte Ausgabe nimmt.
        let text = capture(b"\x1b[0;33mwarn: \x1b[0mno kernel for this quant".to_vec());
        assert_eq!(text, "warn: no kernel for this quant");
        assert!(!text.contains('\u{1b}'), "an escape sequence reached the window: {text:?}");
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

#[cfg(test)]
mod farbcode_tests {
    use super::strip_ansi;

    /// Genau die Zeile, die am 03.09.2026 im Fehlerfeld stand: llama-server
    /// faerbt seine Warnungen, und die Escape-Sequenzen kamen als Kaestchen
    /// mitten im Satz an.
    const ECHT: &str = "\u{1b}[0;33mwarn: \u{1b}[0mfailed to load model\u{1b}[0m";

    #[test]
    fn eine_gefaerbte_zeile_kommt_als_reiner_text_an() {
        assert_eq!(strip_ansi(ECHT), "warn: failed to load model");
    }

    #[test]
    fn text_ohne_steuerzeichen_bleibt_zeichen_fuer_zeichen_gleich() {
        // Negativkontrolle gegen einen Filter, der zu gierig ist. Umlaute,
        // Klammern und eckige Klammern stehen in Pfaden und in pip-Ausgaben.
        let roh = "C:\\Users\\Jörg\\models\\qwen[q4].gguf (3,2 GiB) 100%";
        assert_eq!(strip_ansi(roh), roh);
    }

    #[test]
    fn zeilenumbrueche_und_wagenruecklaeufe_ueberleben() {
        // Fortschrittsbalken schreiben \r. Wer den mitentfernt, klebt zwei
        // Zeilen zusammen und macht das Protokoll unlesbar.
        assert_eq!(strip_ansi("a\r\nb\n"), "a\r\nb\n");
    }

    #[test]
    fn ein_fenstertitel_verschluckt_nicht_den_rest_der_zeile() {
        // OSC endet mit BEL oder mit ESC-Backslash. Wer nur CSI kennt, laesst
        // den Titel als Text stehen; wer das Ende nicht kennt, frisst alles
        // danach.
        assert_eq!(strip_ansi("\u{1b}]0;Titel\u{7}fertig"), "fertig");
        assert_eq!(strip_ansi("\u{1b}]0;Titel\u{1b}\\fertig"), "fertig");
    }

    #[test]
    fn ein_abgeschnittener_puffer_verliert_nur_das_bruchstueck() {
        // Der Einfangpuffer hat eine Obergrenze und kann mitten in einer
        // Sequenz enden. Dann faellt das Bruchstueck weg, nicht der Text davor.
        assert_eq!(strip_ansi("fertig\u{1b}[0;3"), "fertig");
        assert_eq!(strip_ansi("fertig\u{1b}"), "fertig");
    }

    #[test]
    fn cursorbewegungen_gehen_mit_und_nicht_nur_farben() {
        // ComfyUI setzt den Cursor zurueck, um seinen Balken zu ueberschreiben.
        assert_eq!(strip_ansi("\u{1b}[2K\u{1b}[1Gnode 3/7"), "node 3/7");
    }
}

#[cfg(test)]
mod stranger_tests {
    use super::is_a_stranger_under;

    #[test]
    fn a_child_older_than_its_recorded_parent_is_a_stranger() {
        // (parent, start): one own child, one process of another tree, and one
        // listed under 40 although it started 500 seconds before 40 did.
        let table = [(Some(40), 1000), (Some(7), 10), (Some(40), 500)];
        assert!(is_a_stranger_under(40, 1000, table.into_iter()));
    }

    #[test]
    fn children_of_the_same_second_or_later_are_its_own() {
        let table = [(Some(40), 1000), (Some(40), 1003), (None, 1), (Some(41), 2)];
        assert!(!is_a_stranger_under(40, 1000, table.into_iter()));
    }
}

#[cfg(test)]
mod cwd_in_workspace_tests {
    use super::cwd_in_workspace;

    #[test]
    fn a_relative_cwd_lands_inside_the_workspace() {
        let ws = std::env::temp_dir().join(format!("lu-cwd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(ws.join("fotos")).unwrap();
        assert_eq!(cwd_in_workspace(Some("fotos"), &ws), ws.join("fotos"));
        assert_eq!(cwd_in_workspace(Some(" fotos "), &ws), ws.join("fotos"));
        // Not a folder there: the workspace, never the app's own folder.
        assert_eq!(cwd_in_workspace(Some("fehlt"), &ws), ws);
        assert_eq!(cwd_in_workspace(None, &ws), ws);
        assert_eq!(cwd_in_workspace(Some(""), &ws), ws);
        // An absolute folder is used as it is.
        let abs = ws.join("fotos");
        assert_eq!(cwd_in_workspace(abs.to_str(), &ws), abs);
        let _ = std::fs::remove_dir_all(&ws);
    }
}

#[cfg(test)]
mod captured_tail_tests {
    use super::*;

    #[test]
    fn the_tail_keeps_the_last_words_long_after_the_head_stopped() {
        let buf = Arc::new(Mutex::new(Captured::default()));
        {
            let mut c = buf.lock().unwrap();
            // Mehr als MAX_CAPTURE an Geplapper, dann der Absturz.
            let line = b"slot update_slots: id  0 | task 7 | prompt processing progress\n";
            let mut written = 0;
            while written < MAX_CAPTURE + 64 * 1024 {
                c.push(line);
                written += line.len();
            }
            c.push(b"ggml_cuda_compute_forward: ROCm error: out of memory\n");
            c.push(b"\x1b[31mGGML_ABORT\x1b[0m failed\n");
        }
        let tail = captured_tail(&buf, 2);
        assert_eq!(tail, "ggml_cuda_compute_forward: ROCm error: out of memory\nGGML_ABORT failed");
        // Der Kopf bleibt, wie er war: abgeschnitten nach MAX_CAPTURE.
        assert!(captured_text(&buf).contains("[output truncated"));
    }

    #[test]
    fn a_short_output_is_all_tail_and_a_wrapped_first_line_is_dropped() {
        let buf = Arc::new(Mutex::new(Captured::default()));
        buf.lock().unwrap().push(b"one\n\ntwo\nthree\n");
        assert_eq!(captured_tail(&buf, 5), "one\ntwo\nthree");
        assert_eq!(captured_tail(&buf, 1), "three");
        let big = Arc::new(Mutex::new(Captured::default()));
        let mut chunk = vec![b'x'; TAIL_CAPTURE];
        chunk.extend_from_slice(b"\nlast\n");
        big.lock().unwrap().push(&chunk);
        // Die angeschnittene x-Zeile ist kein ganzer Satz und faellt weg.
        assert_eq!(captured_tail(&big, 5), "last");
        assert_eq!(captured_tail(&Arc::new(Mutex::new(Captured::default())), 5), "");
    }
}
