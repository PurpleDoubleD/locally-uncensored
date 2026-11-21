//! Shared install-progress state. Each long-running installer (Python, ComfyUI,
//! LM Studio, Claude Code, SearXNG) owns one of these and the frontend polls
//! `install_*_status` to render progress + logs.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize)]
pub struct InstallProgress {
    pub status: String,
    pub logs: Vec<String>,
    pub download_progress: u64,
    pub download_total: u64,
    pub download_speed: u64,
    pub error: Option<String>,
}

impl Default for InstallProgress {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            logs: Vec::new(),
            download_progress: 0,
            download_total: 0,
            download_speed: 0,
            error: None,
        }
    }
}

#[derive(Clone, Default)]
pub struct InstallSlot {
    inner: Arc<Mutex<InstallProgress>>,
    /// Set by `cancel`, cleared by `start`. An install that ends after this
    /// goes back to idle instead of reporting an error.
    cancelled: Arc<AtomicBool>,
    /// The child the install is waiting on right now, so a cancel has
    /// something to stop. None between steps.
    child: Arc<Mutex<Option<u32>>>,
    /// Up while the child is a download from the hub (`run_hub_step`), so
    /// what it receives counts as progress. The child of another step (pip,
    /// a convert) receives things too, and they are not the model.
    fetching: Arc<AtomicBool>,
    /// Counts the installs this slot has started. Whatever follows one
    /// install from a thread of its own (`watch_dir_size`) knows by this
    /// number that the install it follows is no longer the one that runs.
    run: Arc<AtomicU64>,
}

impl InstallSlot {
    pub fn snapshot(&self) -> InstallProgress {
        self.inner.lock().unwrap().clone()
    }

    pub fn is_running(&self) -> bool {
        self.inner.lock().unwrap().status == "installing"
    }

    pub fn start(&self) {
        self.cancelled.store(false, Ordering::SeqCst);
        *self.child.lock().unwrap() = None;
        let mut g = self.inner.lock().unwrap();
        self.run.fetch_add(1, Ordering::SeqCst);
        *g = InstallProgress {
            status: "installing".into(),
            ..Default::default()
        };
    }

    /// Claim the slot for a new install: check and set under the one lock.
    /// Returns false when an install already runs, and then changes nothing.
    ///
    /// `is_running()` followed by `start()` leaves a gap that a double click
    /// fits through: both calls read "idle", both start, and two downloads
    /// write into the same cache while the second result overwrites the first.
    /// Callers use this instead and return early on false.
    #[must_use]
    pub fn try_start(&self) -> bool {
        let mut g = self.inner.lock().unwrap();
        if g.status == "installing" {
            return false;
        }
        self.cancelled.store(false, Ordering::SeqCst);
        *self.child.lock().unwrap() = None;
        self.run.fetch_add(1, Ordering::SeqCst);
        *g = InstallProgress {
            status: "installing".into(),
            ..Default::default()
        };
        true
    }

    /// Which install of this slot is the current one. See `run`.
    pub fn run_id(&self) -> u64 {
        self.run.load(Ordering::SeqCst)
    }

    pub fn log(&self, line: impl Into<String>) {
        let mut g = self.inner.lock().unwrap();
        let entry = line.into();
        tracing::info!("[install] {entry}");
        g.logs.push(entry);
        if g.logs.len() > 200 {
            let drop = g.logs.len() - 200;
            g.logs.drain(..drop);
        }
    }

    pub fn set_download(&self, progress: u64, total: u64, speed: u64) {
        let mut g = self.inner.lock().unwrap();
        g.download_progress = if total > 0 { progress.min(total) } else { progress };
        g.download_total = total;
        g.download_speed = speed;
    }

    pub fn complete(&self, msg: impl Into<String>) {
        let mut g = self.inner.lock().unwrap();
        g.status = "complete".into();
        g.logs.push(msg.into());
    }

    /// The child a step is about to wait on, or None once it has ended.
    ///
    /// A Stop that came while the child was being started found none to end.
    /// The step looked at the flag before it started the process, so it saw
    /// nothing either, and would wait for the child to its end. The child is
    /// ended here, the moment it is the slot's. The pid is stored first: a
    /// Stop from now on finds it, and one from before has set the flag.
    pub fn set_child(&self, pid: Option<u32>) {
        *self.child.lock().unwrap() = pid;
        if let Some(pid) = pid {
            if self.cancel_requested() {
                crate::process_util::kill_pid_tree(pid);
            }
        }
    }

    pub fn cancel_requested(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// The child the install is waiting on right now.
    pub fn child(&self) -> Option<u32> {
        *self.child.lock().unwrap()
    }

    /// Say that the step now running is, or no longer is, a download.
    pub fn set_fetching(&self, on: bool) {
        self.fetching.store(on, Ordering::SeqCst);
    }

    /// The child, when it is a download from the hub.
    pub fn fetching_child(&self) -> Option<u32> {
        self.fetching.load(Ordering::SeqCst).then(|| self.child()).flatten()
    }

    /// End the child the install is waiting on, and leave the install itself
    /// running: the step that waited sees its child fail and decides what
    /// comes next (a download that stalled is started again). Not a cancel,
    /// so the flag stays down. Returns whether there was a child.
    pub fn end_child(&self) -> bool {
        match *self.child.lock().unwrap() {
            Some(pid) => {
                crate::process_util::kill_pid_tree(pid);
                true
            }
            None => false,
        }
    }

    /// The flag itself, for a step that is not a child process and has to
    /// look for the stop on its own (a download inside the app).
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }

    /// Stop a running install. The child it is waiting on is ended, and the
    /// step that waited then fails into `fail`, which reads the flag and puts
    /// the slot back to idle. Returns whether there was anything to stop.
    ///
    /// What was downloaded stays where it is: the hub cache resumes a pull, so
    /// a second Get picks up from there instead of starting over.
    pub fn cancel(&self) -> bool {
        if !self.is_running() {
            return false;
        }
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(pid) = *self.child.lock().unwrap() {
            crate::process_util::kill_pid_tree(pid);
        }
        true
    }

    pub fn fail(&self, msg: impl Into<String>) {
        let mut g = self.inner.lock().unwrap();
        let m = msg.into();
        if self.cancel_requested() {
            // Stopped on request. That is not a failure, and a red line about
            // a process ended by a signal would read like one.
            tracing::info!("[install] cancelled ({m})");
            g.status = "idle".into();
            g.error = None;
            g.logs.push("Cancelled.".into());
            return;
        }
        tracing::error!("[install] failed: {m}");
        g.status = "error".into();
        g.error = Some(m.clone());
        g.logs.push(format!("ERROR: {m}"));
    }
}

/// Run an install on its own thread and make sure the slot hears how it ended.
///
/// `work` returns the closing line for `complete`, or the reason for `fail`.
/// The third way out is a panic, and that one used to be silent: the thread
/// died, nobody called `fail`, and the slot said "installing" until the app
/// was restarted, while every further click answered "installing" as well
/// (Fehlerkontrolle Mac, 08.10.2026, Fund 3). A panic now ends in `fail` like
/// any other error.
static ACTIVITIES: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

/// A short install step with no status of its own (a node pack, one voice).
/// It is a row in the Downloads tray for as long as this value lives.
pub struct ActivityGuard(String);

pub fn begin_activity(id: impl Into<String>, label: impl Into<String>) -> ActivityGuard {
    let id = id.into();
    ACTIVITIES.lock().unwrap_or_else(|e| e.into_inner()).push((id.clone(), label.into()));
    ActivityGuard(id)
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        let mut list = ACTIVITIES.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(at) = list.iter().position(|(id, _)| *id == self.0) {
            list.remove(at);
        }
    }
}

/// `(id, label)` of every short step running now.
pub fn activities() -> Vec<(String, String)> {
    ACTIVITIES.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

pub fn spawn_install<F>(slot: InstallSlot, work: F) -> std::thread::JoinHandle<()>
where
    F: FnOnce(&InstallSlot) -> Result<String, String> + Send + 'static,
{
    std::thread::spawn(move || {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(&slot)));
        match outcome {
            Ok(Ok(done)) => slot.complete(done),
            Ok(Err(why)) => slot.fail(why),
            Err(panic) => {
                let what = panic
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "no details".to_string());
                slot.fail(format!("The installer stopped unexpectedly ({what}). Start it again."));
            }
        }
    })
}

/// What THIS run added to a shared cache. Never negative: a cache that is
/// pruned mid-download must not make the bar walk backwards.
fn downloaded_into_shared(shared: Option<&std::path::Path>, base: u64) -> u64 {
    shared.map(|p| dir_size(p).saturating_sub(base)).unwrap_or(0)
}

/// The same for every folder the download writes into beside its own, each
/// held against what lay in it at the start.
fn downloaded_beside(shared: &[(std::path::PathBuf, u64)]) -> u64 {
    shared.iter().map(|(dir, base)| downloaded_into_shared(Some(dir), *base)).sum()
}

pub(crate) fn dir_size(path: &std::path::Path) -> u64 {
    let Ok(read) = std::fs::read_dir(path) else {
        return 0;
    };
    read.flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

/// Bytes a process has received from the network since it started, or `None`
/// where that cannot be read. macOS answers through `nettop`, in a few
/// hundredths of a second; a process without a connection has no row, and
/// that is zero bytes.
pub(crate) fn received_bytes(pid: u32) -> Option<u64> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = crate::process_util::hidden_command("/usr/bin/nettop")
        .args(["-P", "-L", "1", "-x", "-J", "bytes_in", "-p", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    received_in(&String::from_utf8_lossy(&out.stdout), pid)
}

/// The bytes of `pid` in what `nettop` printed, `None` when that is not its
/// table.
fn received_in(text: &str, pid: u32) -> Option<u64> {
    // A header line first. Without it the tool said something else entirely.
    let mut lines = text.lines();
    if !lines.next()?.contains("bytes_in") {
        return None;
    }
    let suffix = format!(".{pid}");
    Some(
        lines
            .filter_map(|line| {
                let mut cells = line.split(',');
                cells.next().filter(|name| name.ends_with(&suffix))?;
                cells.next()?.trim().parse::<u64>().ok()
            })
            .sum(),
    )
}

/// What the bar shows while one process downloads: what is on disk plus what
/// that process has received and not yet written.
///
/// The hub client's Xet transport holds what it fetches in memory and writes
/// it in large pieces. The 11.3 GB transformer of LTX-2.3 4-bit came in at
/// 4 MB/s for ten minutes without the folder growing by a byte, and the bar
/// stood still at "0.0 MB/s" the whole time (real run on the M5 Pro,
/// 09.10.2026). The folder alone says a download is dead when it is not.
///
/// The count of the network is the sum over the connections the process has
/// open, so it falls whenever one of them closes. The first version added
/// that count to the folder as it stood at the start, and in the next real
/// download the bar went back from 12.10 to 10.46 GB and then stood for eight
/// minutes behind a folder that was ahead of it. Only what the count GAINS is
/// taken, what reaches the disk is taken off again, and the number never goes
/// back while the same process is at work.
#[derive(Default)]
struct DownloadBar {
    shown: u64,
    on_disk: u64,
    in_flight: u64,
    received: Option<u64>,
}

impl DownloadBar {
    fn starting_at(on_disk: u64) -> Self {
        Self { shown: on_disk, on_disk, ..Self::default() }
    }

    fn step(&mut self, on_disk: u64, received: Option<u64>) -> u64 {
        if let (Some(now), Some(before)) = (received, self.received) {
            self.in_flight += now.saturating_sub(before);
        }
        if received.is_some() {
            self.received = received;
        }
        self.in_flight = self.in_flight.saturating_sub(on_disk.saturating_sub(self.on_disk));
        self.on_disk = on_disk;
        self.shown = self.shown.max(on_disk + self.in_flight);
        self.shown
    }
}

/// How long back the speed of a download looks. The disk grows in pieces
/// minutes apart and the network count in steps, so the gain of one second
/// was "0.0 MB/s" most of the time while 3 MB/s were coming in.
const SPEED_WINDOW: std::time::Duration = std::time::Duration::from_secs(20);

/// Bytes per second over the samples of the window, oldest first.
fn speed_over(samples: &std::collections::VecDeque<(std::time::Instant, u64)>) -> u64 {
    let (Some((first_at, first)), Some((last_at, last))) = (samples.front(), samples.back()) else {
        return 0;
    };
    let seconds = last_at.duration_since(*first_at).as_secs_f64();
    if seconds <= 0.0 || last <= first {
        return 0;
    }
    ((last - first) as f64 / seconds) as u64
}

/// Feed a slot's byte progress from the size of the directory the download
/// writes into, until the slot leaves "installing". The installers shell out
/// to `huggingface_hub.snapshot_download`, which reports nothing machine-
/// readable on stdout; the growing target directory is the one progress
/// signal that exists on every platform.
///
/// `shared` is a cache directory that the SAME download also writes into but
/// that other downloads share. Only its GROWTH during this run counts, because
/// whatever lay there when we started belongs to somebody else's model.
///
/// Why the second directory exists at all: since huggingface_hub 1.x the
/// default transport is Xet, and Xet does not stream into
/// `<repo>/blobs/<sha>.incomplete` the way the plain HTTP path does. It fills
/// its own chunk cache at `$HF_HOME/xet`, a SIBLING of the repo folder we
/// watch. So the watched folder stayed near empty while the line was busy, and
/// the downloads bar read "1.7 MB / 8.0 GB 0%" after four and a half minutes
/// of real traffic (bauer-m on the Mac, 11.09.2026, N1). The bytes were never
/// missing, they were being counted in the wrong place.
pub fn watch_dir_size(
    slot: InstallSlot,
    dir: std::path::PathBuf,
    shared: Vec<std::path::PathBuf>,
    total_bytes: u64,
) {
    // The install that asked. A slot that is stopped and started again within
    // one sleep of this loop reads "installing" both times, and the loop would
    // go on reporting the stopped download into the bar of the new one.
    let mine = slot.run_id();
    let follows = move |slot: &InstallSlot| slot.is_running() && slot.run_id() == mine;
    std::thread::spawn(move || {
        let mut samples: std::collections::VecDeque<(std::time::Instant, u64)> = Default::default();
        let shared: Vec<(std::path::PathBuf, u64)> = shared
            .into_iter()
            .map(|dir| {
                let base = dir_size(&dir);
                (dir, base)
            })
            .collect();
        // The process that is downloading right now, and its bar.
        let mut child: Option<(u32, DownloadBar)> = None;
        while follows(&slot) {
            let on_disk = dir_size(&dir) + downloaded_beside(&shared);
            child = match (slot.fetching_child(), child) {
                (Some(pid), Some((known, bar))) if pid == known => Some((pid, bar)),
                (Some(pid), _) => Some((pid, DownloadBar::starting_at(on_disk))),
                (None, _) => None,
            };
            let size = match child.as_mut() {
                Some((pid, bar)) => bar.step(on_disk, received_bytes(*pid)),
                None => on_disk,
            };
            // Measuring a large folder takes its time, and the answer of an
            // install that has ended since is not written.
            if !follows(&slot) {
                break;
            }
            let now = std::time::Instant::now();
            samples.push_back((now, size));
            while samples.front().is_some_and(|(at, _)| now.duration_since(*at) > SPEED_WINDOW) {
                samples.pop_front();
            }
            let speed = speed_over(&samples);
            slot.set_download(size, total_bytes, speed);
            std::thread::sleep(std::time::Duration::from_millis(1000));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What `nettop -P -L 1 -x -J bytes_in` prints, read without asking the
    /// system: a test that reads the live counter of its own process is red
    /// whenever another test in the same run has received something.
    #[test]
    fn the_bytes_of_a_process_are_read_from_the_table_of_nettop() {
        let table = ",bytes_in,\nlaunchd.1,0,\npython3.12.4711,6534,\npython3.12.4711,1000,\nnc.14711,99,\n";
        assert_eq!(received_in(table, 4711), Some(7534), "the rows of one process add up");
        assert_eq!(received_in(table, 1), Some(0));
        assert_eq!(received_in(table, 14711), Some(99), "a pid that ends like another is not that other");
        assert_eq!(received_in(table, 711), Some(0), "a process without a connection has no row, and has received nothing");
        assert_eq!(received_in("nettop: unable to allocate\n", 4711), None, "something else than the table is not zero bytes");
        assert_eq!(received_in("", 4711), None);
        let source = include_str!("install_state.rs");
        let read = &source[source.find("pub(crate) fn received_bytes").unwrap()..source.find("fn received_in").unwrap()];
        assert!(read.contains("received_in(&String::from_utf8_lossy(&out.stdout), pid)"));
    }

    #[test]
    fn the_bar_moves_while_the_hub_client_holds_its_download_in_memory() {
        const GB: u64 = 1_000_000_000;
        // Nine gigabytes of whole files, a process that takes in two more
        // and has written none of them yet: eleven, and not a bar that stands.
        let mut bar = DownloadBar::starting_at(9 * GB);
        assert_eq!(bar.step(9 * GB, Some(0)), 9 * GB);
        assert_eq!(bar.step(9 * GB, Some(GB)), 10 * GB);
        assert_eq!(bar.step(9 * GB, Some(2 * GB)), 11 * GB);
        // The piece reaches the disk: nothing is counted twice.
        assert_eq!(bar.step(11 * GB, Some(2 * GB)), 11 * GB);
        assert_eq!(bar.step(12 * GB, Some(2 * GB)), 12 * GB);
        // A network that cannot be read leaves the folder's own number.
        let mut blind = DownloadBar::starting_at(9 * GB);
        assert_eq!(blind.step(9 * GB, None), 9 * GB);
        assert_eq!(blind.step(10 * GB, None), 10 * GB);
        // And the watcher is the one that asks.
        let src = include_str!("install_state.rs");
        let watch = &src[src.find("pub fn watch_dir_size").unwrap()..src.find("#[cfg(test)]").unwrap()];
        assert!(watch.contains("bar.step(on_disk, received_bytes(*pid))"));
        // Only a download counts: pip fetching the engine is not the model.
        assert!(watch.contains("slot.fetching_child()"));
        let slot = InstallSlot::default();
        slot.start();
        slot.set_child(Some(4242));
        assert_eq!(slot.fetching_child(), None);
        slot.set_fetching(true);
        assert_eq!(slot.fetching_child(), Some(4242));
        slot.set_fetching(false);
        assert_eq!(slot.fetching_child(), None);
    }

    /// The real download of LTX-2.3 4-bit on 09.10.2026: the count of the
    /// network fell when connections closed, and the bar went back by 1.6 GB.
    #[test]
    fn the_bar_never_goes_back_when_the_count_of_the_network_falls() {
        const MB: u64 = 1_000_000;
        let mut bar = DownloadBar::starting_at(9_280 * MB);
        let mut shown = Vec::new();
        // (folder, count of the network) as they were seen, in megabytes.
        for (disk, net) in [(9_280, 0), (9_280, 2_750), (9_840, 2_820), (9_840, 2_280), (10_400, 1_180), (13_280, 1_300), (13_350, 1_500)] {
            shown.push(bar.step(disk * MB, Some(net * MB)));
        }
        assert!(shown.windows(2).all(|w| w[1] >= w[0]), "{shown:?}");
        // What came in after the count fell is still counted: of the last
        // 200 MB, 70 are in the folder and 130 are on their way to it.
        assert_eq!(*shown.last().unwrap(), 13_350 * MB + 130 * MB);
        // Never more in flight than was received: a folder that grows by more
        // than the network brought (the transport unpacks) leaves nothing over.
        let mut unpacked = DownloadBar::starting_at(0);
        unpacked.step(0, Some(0));
        unpacked.step(0, Some(800 * MB));
        assert_eq!(unpacked.step(1_000 * MB, Some(800 * MB)), 1_000 * MB);
        assert_eq!(unpacked.step(1_000 * MB, Some(900 * MB)), 1_100 * MB);
    }

    #[test]
    fn the_speed_is_that_of_the_last_seconds_and_not_of_the_last_tick() {
        use std::collections::VecDeque;
        use std::time::{Duration, Instant};
        let start = Instant::now();
        let at = |s: u64, bytes: u64| (start + Duration::from_secs(s), bytes);
        // A piece of 60 MB lands in second 3 and nothing in the others.
        let burst: VecDeque<_> = [at(0, 0), at(1, 0), at(2, 0), at(3, 60_000_000), at(4, 60_000_000), at(5, 60_000_000)].into();
        assert_eq!(speed_over(&burst), 12_000_000);
        // Nothing came: zero. One sample, or none: zero.
        assert_eq!(speed_over(&[at(0, 5), at(9, 5)].into()), 0);
        assert_eq!(speed_over(&[at(0, 5)].into()), 0);
        assert_eq!(speed_over(&VecDeque::new()), 0);
        let src = include_str!("install_state.rs");
        let watch = &src[src.find("pub fn watch_dir_size").unwrap()..src.find("#[cfg(test)]").unwrap()];
        assert!(watch.contains("speed_over(&samples)") && watch.contains("> SPEED_WINDOW"));
    }

    #[test]
    fn a_cancelled_install_ends_idle_and_not_as_an_error() {
        let slot = InstallSlot::default();
        assert!(!slot.cancel(), "nothing runs, so there is nothing to cancel");
        slot.start();
        assert!(slot.cancel());
        assert!(slot.cancel_requested());
        // The step that was waiting on the child reports what it saw.
        slot.fail("the process was ended by a signal");
        let s = slot.snapshot();
        assert_eq!(s.status, "idle");
        assert_eq!(s.error, None);
        assert_eq!(s.logs.last().map(String::as_str), Some("Cancelled."));
        // The next install starts clean and can fail for real again.
        slot.start();
        assert!(!slot.cancel_requested());
        slot.fail("no space left on device");
        assert_eq!(slot.snapshot().status, "error");
    }

    /// Fund 11: zwei Klicks gleichzeitig. Von vielen Aufrufern, die im selben
    /// Augenblick starten wollen, bekommt genau einer den Slot.
    /// Stop has to be heard at once, and the slot has to be free again right
    /// after: the interface puts the tile back the moment it is clicked, and a
    /// second Get must not find the old download still holding the slot.
    #[cfg(unix)]
    #[test]
    fn a_cancel_returns_at_once_and_frees_the_slot_right_after() {
        let slot = InstallSlot::default();
        assert!(slot.try_start());
        let worker = spawn_install(slot.clone(), |slot| {
            let mut cmd = std::process::Command::new("sleep");
            cmd.arg("60");
            crate::commands::video::run_streamed(slot, &mut cmd).map(|()| "done".to_string())
        });
        // Wait for the child to be the one the slot knows.
        let waited = std::time::Instant::now();
        while slot.child.lock().unwrap().is_none() {
            assert!(waited.elapsed() < std::time::Duration::from_secs(10), "the child never started");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let clicked = std::time::Instant::now();
        assert!(slot.cancel());
        let answered = clicked.elapsed();
        worker.join().unwrap();
        let freed = clicked.elapsed();
        assert!(answered < std::time::Duration::from_millis(500), "cancel took {answered:?} to return");
        assert!(freed < std::time::Duration::from_millis(700), "the slot was held for {freed:?} after the cancel, which is the kill grace or longer");
        let after = slot.snapshot();
        assert_eq!(after.status, "idle");
        assert_eq!(after.error, None);
        println!("PROBE cancel returned after {answered:?}, slot idle after {freed:?}");
    }

    #[test]
    fn try_start_hands_the_slot_to_exactly_one_caller() {
        let slot = InstallSlot::default();
        let gate = Arc::new(std::sync::Barrier::new(16));
        let handles: Vec<_> = (0..16)
            .map(|_| {
                let (slot, gate) = (slot.clone(), gate.clone());
                std::thread::spawn(move || {
                    gate.wait();
                    slot.try_start()
                })
            })
            .collect();
        let won = handles.into_iter().map(|h| h.join().unwrap()).filter(|w| *w).count();
        assert_eq!(won, 1, "one install, however many clicks");
        assert!(slot.is_running());

        // A running install keeps its log and its cancel flag.
        slot.log("downloading");
        assert!(!slot.try_start());
        assert_eq!(slot.snapshot().logs, vec!["downloading".to_string()]);

        // Once it has ended, the next one may start, and starts clean.
        slot.fail("no space left on device");
        assert!(slot.try_start());
        let s = slot.snapshot();
        assert_eq!((s.status.as_str(), s.error, s.logs.len()), ("installing", None, 0));
        assert!(!slot.cancel_requested());
    }

    /// Fund 3: ein Panic im Install-Thread. Der Slot darf danach nicht auf
    /// "installing" stehen bleiben, und der naechste Klick muss wieder starten.
    #[test]
    fn a_panic_in_the_install_thread_ends_as_an_error_and_frees_the_slot() {
        let slot = InstallSlot::default();
        assert!(slot.try_start());
        spawn_install(slot.clone(), |_| -> Result<String, String> {
            let stderr = "x".repeat(799) + "\u{2570}\u{2500}> pip";
            // The original defect: a byte slice through a box-drawing character.
            let cut = stderr[..800].to_string();
            Ok(cut)
        })
        .join()
        .unwrap();
        let s = slot.snapshot();
        assert_eq!(s.status, "error", "a dead thread must not read as a running install");
        assert!(s.error.as_deref().is_some_and(|e| e.starts_with("The installer stopped unexpectedly")), "{:?}", s.error);
        assert!(!slot.is_running());
        assert!(slot.try_start(), "the next click starts a new install");

        // The two ordinary ways out still land where they belong.
        spawn_install(slot.clone(), |s| {
            s.log("working");
            Ok("ready".into())
        })
        .join()
        .unwrap();
        assert_eq!(slot.snapshot().status, "complete");
        assert_eq!(slot.snapshot().logs.last().map(String::as_str), Some("ready"));
        assert!(slot.try_start());
        spawn_install(slot.clone(), |_| Err("no space left on device".into())).join().unwrap();
        assert_eq!(slot.snapshot().error.as_deref(), Some("no space left on device"));
    }

    #[test]
    fn set_download_clamps_to_total_and_keeps_speed() {
        let slot = InstallSlot::default();
        slot.start();
        slot.set_download(500, 1000, 42);
        let s = slot.snapshot();
        assert_eq!((s.download_progress, s.download_total, s.download_speed), (500, 1000, 42));
        // A convert step growing the dir past the download size must not
        // report more than 100%.
        slot.set_download(1500, 1000, 7);
        assert_eq!(slot.snapshot().download_progress, 1000);
        // No known total: pass the raw byte count through.
        slot.set_download(1500, 0, 0);
        assert_eq!(slot.snapshot().download_progress, 1500);
    }

    /// Der Stillstand der Anzeige, als Rechnung.
    ///
    /// bauer-m auf dem Mac, 11.09.2026 (N1): nach viereinhalb Minuten stand
    /// "1.7 MB / 8.0 GB 0%" in der Leiste, waehrend die Leitung arbeitete. Die
    /// Bytes lagen im Xet-Zwischenspeicher, einem GESCHWISTER des beobachteten
    /// Repo-Ordners, und wurden deshalb nicht gezaehlt.
    #[test]
    fn the_shared_cache_counts_what_this_run_added_to_it() {
        let root = std::env::temp_dir().join(format!("lu-shared-{}", std::process::id()));
        let xet = root.join("xet");
        std::fs::create_dir_all(&xet).unwrap();
        // Was beim Start schon dalag, gehoert einem anderen Modell.
        std::fs::write(xet.join("alt.bin"), vec![0u8; 2_000]).unwrap();
        let base = dir_size(&xet);
        assert_eq!(base, 2_000);
        assert_eq!(downloaded_into_shared(Some(&xet), base), 0, "fremde Bytes zaehlen nicht mit");

        // Und was dieser Lauf dazulegt, zaehlt sofort.
        std::fs::write(xet.join("neu.bin"), vec![0u8; 500]).unwrap();
        assert_eq!(downloaded_into_shared(Some(&xet), base), 500);

        // Ein geleerter Zwischenspeicher laesst den Balken nicht rueckwaerts laufen.
        std::fs::remove_file(xet.join("alt.bin")).unwrap();
        assert_eq!(downloaded_into_shared(Some(&xet), base), 0);

        // Gegenprobe: ohne zweiten Ordner bleibt es bei null, also genau beim
        // Verhalten von vorher.
        assert_eq!(downloaded_into_shared(None, 0), 0);
        // Two folders beside the model's own: each counts what it gained.
        let lora = root.join("lora");
        std::fs::create_dir_all(&lora).unwrap();
        std::fs::write(xet.join("chunk-c"), vec![0u8; 300]).unwrap();
        let beside = vec![(xet.clone(), dir_size(&xet)), (lora.clone(), 0)];
        std::fs::write(xet.join("chunk-d"), vec![0u8; 40]).unwrap();
        std::fs::write(lora.join("adapter.safetensors"), vec![0u8; 7]).unwrap();
        assert_eq!(downloaded_beside(&beside), 47);
        assert_eq!(downloaded_beside(&[]), 0);
        assert_eq!(downloaded_into_shared(Some(&root.join("gibt-es-nicht")), 0), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Fehlerkontrolle 3, 08.10.2026: a Stop in the moment a step starts its
    /// process. The step has looked at the flag and found nothing, the process
    /// is not the slot's yet, so the Stop ends nothing. Then the process is
    /// handed to the slot, and the step waited for it to the end: a download
    /// of many gigabytes that the interface had already taken off the screen.
    #[cfg(unix)]
    #[test]
    fn a_child_handed_over_after_the_stop_is_ended_as_well() {
        let slot = InstallSlot::default();
        assert!(slot.try_start());
        // The Stop arrives while the process is being started.
        assert!(slot.cancel());
        let mut child = std::process::Command::new("sleep").arg("60").spawn().unwrap();
        slot.set_child(Some(child.id()));
        let handed = std::time::Instant::now();
        let ended = loop {
            if child.try_wait().unwrap().is_some() {
                break true;
            }
            if handed.elapsed() > std::time::Duration::from_secs(3) {
                break false;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        if !ended {
            let _ = child.kill();
            let _ = child.wait();
        }
        assert!(ended, "the process ran on after the Stop");
        // A step that starts without a Stop keeps its process.
        assert!(!slot.try_start(), "the stopped install has not reported back yet");
        slot.fail("the process was ended by a signal");
        assert!(slot.try_start());
        let mut kept = std::process::Command::new("sleep").arg("60").spawn().unwrap();
        slot.set_child(Some(kept.id()));
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(kept.try_wait().unwrap().is_none(), "a process was ended without a Stop");
        let _ = kept.kill();
        let _ = kept.wait();
    }

    /// Fehlerkontrolle 3, 08.10.2026: Stop on one model and Get on the next.
    /// The watcher of the stopped download sleeps a second between looks, and
    /// the slot is "installing" again when it wakes, for the next model. It
    /// then went on reporting the folder and the total of the model that was
    /// stopped, in turn with the watcher of the new one, and the bar jumped
    /// between two downloads every second.
    #[test]
    fn the_watcher_of_a_stopped_install_does_not_report_into_the_next_one() {
        let root = std::env::temp_dir().join(format!("lu-watch-{}", std::process::id()));
        let (first, second) = (root.join("first"), root.join("second"));
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(first.join("a.bin"), vec![0u8; 300]).unwrap();
        std::fs::write(second.join("b.bin"), vec![0u8; 20]).unwrap();

        let slot = InstallSlot::default();
        assert!(slot.try_start());
        watch_dir_size(slot.clone(), first, Vec::new(), 1_000);
        // Let it take its first look and go to sleep.
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert_eq!(slot.snapshot().download_total, 1_000);
        // Stopped, and the next Get starts before the old watcher wakes.
        assert!(slot.cancel());
        slot.fail("the process was ended by a signal");
        assert!(slot.try_start());
        watch_dir_size(slot.clone(), second, Vec::new(), 5_000);

        // Three seconds of looks, more than two rounds of either watcher.
        let until = std::time::Instant::now() + std::time::Duration::from_millis(3_000);
        std::thread::sleep(std::time::Duration::from_millis(200));
        while std::time::Instant::now() < until {
            let s = slot.snapshot();
            assert_eq!(
                (s.download_progress, s.download_total),
                (20, 5_000),
                "the bar shows the download that was stopped"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        slot.complete("done");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dir_size_sums_nested_files() {
        let root = std::env::temp_dir().join(format!("lu-dirsize-{}", std::process::id()));
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(root.join("a.bin"), vec![0u8; 100]).unwrap();
        std::fs::write(sub.join("b.bin"), vec![0u8; 50]).unwrap();
        assert_eq!(dir_size(&root), 150);
        std::fs::remove_dir_all(&root).unwrap();
        // A directory that does not exist yet reads as empty, not an error;
        // the watcher starts before snapshot_download creates the target.
        assert_eq!(dir_size(&root), 0);
    }
}
