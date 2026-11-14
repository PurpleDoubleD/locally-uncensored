//! Watchers (3.1.x): tasks the AI runs by itself at a time the user named,
//! "check the prices at 18:00", "every morning at 8 sum up the news".
//!
//! This side holds the list and the clock, the window runs the turn
//! (src/lib/watchers/runner.ts), the same way a turn from the paired phone
//! runs (remote_chats.rs): the clock emits `watchers-due`, the window opens
//! the watcher's own chat, puts the watcher's rights over it as a cap and
//! sends the task through the normal send path, so the loop guard, the
//! working-folder jail and Autocompact apply as in any run.
//!
//! The clock lives here and not in a `setTimeout` of the page: the window
//! goes to the tray on close and a hidden webview's timers are throttled
//! (WebView2, App Nap). An event from Rust still reaches its listener.
//!
//! David's decisions of 14.11.2026, which shape this file:
//!  - A watcher lives as long as LU runs. Quitting LU ends every watcher; no
//!    autostart, nothing is caught up after a restart. The list is written to
//!    disk only so the next start can say, once, which watchers ended with
//!    the last quit (`Hint`).
//!  - No credit cap per run; the loop guard stays, it is no cost limit.
//!
//! Desktop only: a phone has no tray to wait in.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Emitted with the watcher when its time has come.
pub(crate) const DUE_EVENT: &str = "watchers-due";
/// Emitted whenever the list or a watcher's state changed.
pub(crate) const CHANGED_EVENT: &str = "watchers-changed";

/// More than this is no longer a handful of reminders but a job farm.
pub(crate) const MAX_WATCHERS: usize = 20;
/// The shortest repeat. A watcher is a turn with a model: every few seconds
/// would be a loop, and `/loop` exists for that.
pub(crate) const MIN_INTERVAL_MINUTES: u32 = 10;
/// The longest repeat: once a week.
pub(crate) const MAX_INTERVAL_MINUTES: u32 = 7 * 24 * 60;
/// The runs a watcher remembers.
pub(crate) const RUNS_KEPT: usize = 10;
/// A run the window never reported back (a reload, a crash of the webview)
/// stops counting as running after this long, so the watcher fires again.
const RUN_STALE_MS: i64 = 3 * 60 * 60 * 1000;
/// The clock looks again at least this often, so a changed system clock,
/// a wake from sleep or a missed wake-up costs at most this much.
const TICK_MAX_MS: i64 = 30_000;
const NAME_MAX: usize = 80;
const TASK_MAX: usize = 4_000;
const SUMMARY_MAX: usize = 400;

pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ── Data ─────────────────────────────────────────────────────────

/// When a watcher runs. Times are the computer's local time.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Schedule {
    /// Once, at this moment (milliseconds since 1970, UTC).
    Once { at: i64 },
    /// At this local time, on these days (0 = Monday … 6 = Sunday; empty =
    /// every day).
    Daily {
        hour: u8,
        minute: u8,
        #[serde(default)]
        days: Vec<u8>,
    },
    /// Every so many minutes, counted from the end of the last start.
    Interval { minutes: u32 },
}

/// What a watcher may do. Everything is off unless the user ticked it on the
/// card. The window turns this into a cap over the chat's own permissions
/// (lib/watchers/caps.ts); this side only stores it.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub(crate) struct Rights {
    #[serde(default)]
    pub web: bool,
    /// Read and write files in the working folder.
    #[serde(default)]
    pub files: bool,
    /// Run commands in the working folder.
    #[serde(default)]
    pub terminal: bool,
    /// Make pictures and videos.
    #[serde(default)]
    pub create: bool,
    /// Folders outside the working folder the user allowed by name.
    #[serde(default)]
    pub extra_folders: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct RunRecord {
    /// When the run started (ms).
    pub at: i64,
    /// How long it took (ms).
    pub ms: u64,
    /// `done`, `failed` or `stopped`.
    pub status: String,
    /// A short line about the result, for the list and the notification.
    #[serde(default)]
    pub summary: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct Watcher {
    pub id: String,
    pub name: String,
    /// The order the model gets on each run, fixed at creation.
    pub task: String,
    pub schedule: Schedule,
    #[serde(default)]
    pub rights: Rights,
    /// The working folder. None: the chat's own sandbox folder.
    #[serde(default)]
    pub folder: Option<String>,
    /// The model the run uses. None: the one active at the time of the run.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub paused: bool,
    pub created_at: i64,
    /// The next run (ms). None: nothing more to do (a single run that ran).
    #[serde(default)]
    pub next_at: Option<i64>,
    /// When the run that is going on started. None: not running.
    #[serde(default)]
    pub running_since: Option<i64>,
    /// The chat the runs write into, set by the window on the first run.
    #[serde(default)]
    pub conversation_id: Option<String>,
    /// The chat the watcher was made in.
    #[serde(default)]
    pub origin_conversation_id: Option<String>,
    #[serde(default)]
    pub runs: Vec<RunRecord>,
}

/// One line in the list after a start: a watcher that ended when LU quit.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct Hint {
    pub id: String,
    pub name: String,
    /// The run it would have made next.
    pub was_next: Option<i64>,
}

/// What the tool or the user hands over to make a watcher.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatcherSpec {
    pub name: String,
    pub task: String,
    pub schedule: Schedule,
    #[serde(default)]
    pub rights: Rights,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub origin_conversation_id: Option<String>,
}

/// A change to a watcher. Absent fields stay as they are.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatcherPatch {
    pub name: Option<String>,
    pub task: Option<String>,
    pub schedule: Option<Schedule>,
    pub rights: Option<Rights>,
    /// `Some("")` clears the folder (back to the sandbox).
    pub folder: Option<String>,
    /// `Some("")` clears the model (the active one at run time).
    pub model: Option<String>,
    pub paused: Option<bool>,
    pub conversation_id: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub(crate) struct Listing {
    pub watchers: Vec<Watcher>,
    pub hints: Vec<Hint>,
}

#[derive(Default)]
struct Inner {
    watchers: Vec<Watcher>,
    hints: Vec<Hint>,
    #[cfg(target_os = "macos")]
    nap: Option<nap::Token>,
}

#[derive(Default)]
pub(crate) struct WatcherState {
    inner: Mutex<Inner>,
    wake: tokio::sync::Notify,
}

// ── The schedule (pure) ──────────────────────────────────────────

/// A local wall-clock time on a date as an instant. In the hour a clock
/// skips (spring forward), the time does not exist and the first minute
/// after the gap is taken; in the hour that repeats, the first of the two.
fn local_instant<Tz: chrono::TimeZone>(tz: &Tz, date: chrono::NaiveDate, hour: u8, minute: u8) -> Option<i64> {
    let naive = date.and_hms_opt(hour as u32, minute as u32, 0)?;
    if let Some(t) = tz.from_local_datetime(&naive).earliest() {
        return Some(t.timestamp_millis());
    }
    // In a gap: walk forward a minute at a time, at most two hours.
    let mut probe = naive;
    for _ in 0..120 {
        probe += chrono::Duration::minutes(1);
        if let Some(t) = tz.from_local_datetime(&probe).earliest() {
            return Some(t.timestamp_millis());
        }
    }
    None
}

/// The first run strictly after `after` (ms), in the time zone `tz`.
/// None when there is none (a single run in the past).
pub(crate) fn next_after_in<Tz: chrono::TimeZone>(tz: &Tz, schedule: &Schedule, after: i64) -> Option<i64> {
    use chrono::Datelike;
    match schedule {
        Schedule::Once { at } => (*at > after).then_some(*at),
        Schedule::Interval { minutes } => Some(after + (*minutes as i64) * 60_000),
        Schedule::Daily { hour, minute, days } => {
            let start = chrono::DateTime::from_timestamp_millis(after)?.with_timezone(tz).date_naive();
            // Eight days reach the same weekday once more, whatever the set.
            for offset in 0..8 {
                let date = start + chrono::Duration::days(offset);
                let weekday = date.weekday().num_days_from_monday() as u8;
                if !days.is_empty() && !days.contains(&weekday) {
                    continue;
                }
                if let Some(t) = local_instant(tz, date, *hour, *minute) {
                    if t > after {
                        return Some(t);
                    }
                }
            }
            None
        }
    }
}

pub(crate) fn next_after(schedule: &Schedule, after: i64) -> Option<i64> {
    next_after_in(&chrono::Local, schedule, after)
}

fn clip(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        t.to_string()
    } else {
        let mut out: String = t.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

/// Checks a schedule; the error is a sentence the model can act on.
pub(crate) fn check_schedule(schedule: &Schedule, now: i64) -> Result<(), String> {
    match schedule {
        Schedule::Once { at } => {
            if *at <= now {
                return Err("That time has already passed. Pick a time in the future.".into());
            }
            if *at > now + 366 * 24 * 60 * 60 * 1000 {
                return Err("That is more than a year away. Pick a time within the next year.".into());
            }
        }
        Schedule::Daily { hour, minute, days } => {
            if *hour > 23 || *minute > 59 {
                return Err("The time of day is hour 0-23 and minute 0-59.".into());
            }
            if days.iter().any(|d| *d > 6) {
                return Err("Days are 0 (Monday) to 6 (Sunday).".into());
            }
        }
        Schedule::Interval { minutes } => {
            if *minutes < MIN_INTERVAL_MINUTES || *minutes > MAX_INTERVAL_MINUTES {
                return Err(format!(
                    "A repeat is every {MIN_INTERVAL_MINUTES} minutes at the shortest and once a week at the longest."
                ));
            }
        }
    }
    Ok(())
}

/// A folder a watcher may work in: absolute, existing, not the root of a
/// disk and not the home folder itself (the whole home is no working folder).
pub(crate) fn check_folder(path: &str) -> Result<String, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_absolute() {
        return Err(format!("The folder {path} is not a full path."));
    }
    if !p.is_dir() {
        return Err(format!("The folder {path} does not exist."));
    }
    if p.parent().is_none() || dirs::home_dir().map(|h| h == p).unwrap_or(false) {
        return Err(format!("{path} is too wide for a working folder. Name a folder inside it."));
    }
    Ok(p.to_string_lossy().to_string())
}

fn check_spec(spec: &WatcherSpec, now: i64) -> Result<(), String> {
    if spec.name.trim().is_empty() {
        return Err("The watcher needs a short name.".into());
    }
    if spec.task.trim().is_empty() {
        return Err("The watcher needs a task.".into());
    }
    if spec.task.chars().count() > TASK_MAX {
        return Err(format!("The task is longer than {TASK_MAX} characters."));
    }
    check_schedule(&spec.schedule, now)?;
    if let Some(f) = spec.folder.as_deref().filter(|f| !f.trim().is_empty()) {
        check_folder(f)?;
    }
    for f in &spec.rights.extra_folders {
        check_folder(f)?;
    }
    Ok(())
}

fn clean_rights(r: &Rights) -> Rights {
    let mut extra: Vec<String> = r.extra_folders.iter().filter_map(|f| check_folder(f).ok()).collect();
    extra.dedup();
    Rights { extra_folders: extra, ..r.clone() }
}

/// The watchers whose time has come, marked as running.
fn take_due(watchers: &mut [Watcher], now: i64) -> Vec<Watcher> {
    let mut due = Vec::new();
    for w in watchers.iter_mut() {
        if let Some(since) = w.running_since {
            if now - since > RUN_STALE_MS {
                w.running_since = None;
                push_run(w, RunRecord { at: since, ms: (now - since) as u64, status: "failed".into(), summary: "The window never reported this run back.".into() });
            }
        }
        if w.paused || w.running_since.is_some() {
            continue;
        }
        if matches!(w.next_at, Some(t) if t <= now) {
            w.running_since = Some(now);
            due.push(w.clone());
        }
    }
    due
}

fn push_run(w: &mut Watcher, mut run: RunRecord) {
    run.summary = clip(&run.summary, SUMMARY_MAX);
    w.runs.insert(0, run);
    w.runs.truncate(RUNS_KEPT);
}

/// After a run: the next time. A run that started late (the computer slept)
/// is not repeated for every slot it missed: the next slot is counted from
/// now.
fn finish(w: &mut Watcher, run: RunRecord, now: i64) {
    w.running_since = None;
    push_run(w, run);
    w.next_at = match w.schedule {
        Schedule::Once { .. } => None,
        _ => next_after(&w.schedule, now),
    };
}

/// The earliest moment the clock has to look again.
fn next_wake(watchers: &[Watcher], now: i64) -> i64 {
    watchers
        .iter()
        .filter(|w| !w.paused && w.running_since.is_none())
        .filter_map(|w| w.next_at)
        .min()
        .map(|t| t.clamp(now + 250, now + TICK_MAX_MS))
        .unwrap_or(now + TICK_MAX_MS)
}

/// Watchers that still wait for a run. These keep the Mac out of App Nap.
fn any_waiting(watchers: &[Watcher]) -> bool {
    watchers.iter().any(|w| !w.paused && (w.next_at.is_some() || w.running_since.is_some()))
}

/// The hints a start shows for the watchers the last quit ended.
pub(crate) fn hints_from(previous: &[Watcher]) -> Vec<Hint> {
    previous
        .iter()
        .filter(|w| w.next_at.is_some() && !w.paused)
        .map(|w| Hint { id: w.id.clone(), name: w.name.clone(), was_next: w.next_at })
        .collect()
}

// ── Disk: only for the hints after a restart ─────────────────────

fn list_path() -> PathBuf {
    crate::os_paths::data_dir().join("watchers.json")
}

fn save(watchers: &[Watcher]) {
    let path = list_path();
    if watchers.is_empty() {
        let _ = std::fs::remove_file(&path);
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec(watchers) {
        let _ = crate::commands::filesystem::write_atomic(&path, &bytes);
    }
}

fn load_previous() -> Vec<Watcher> {
    let path = list_path();
    let read = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Vec<Watcher>>(&b).ok()).unwrap_or_default();
    let _ = std::fs::remove_file(&path);
    read
}

// ── macOS: no App Nap while a watcher waits ──────────────────────

#[cfg(target_os = "macos")]
mod nap {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    /// NSActivityUserInitiatedAllowingIdleSystemSleep: no App Nap, no timer
    /// coalescing, but the Mac may still go to sleep by itself. A sleeping
    /// Mac runs no watcher, like one that is off.
    const OPTIONS: u64 = 0x00FF_FFFF & !(1 << 20);

    pub(super) struct Token(Retained<AnyObject>);
    // The token is an opaque object handed back to the same NSProcessInfo;
    // NSProcessInfo is thread-safe.
    unsafe impl Send for Token {}

    pub(super) fn begin() -> Option<Token> {
        unsafe {
            let info: Retained<AnyObject> = msg_send![class!(NSProcessInfo), processInfo];
            let reason = NSString::from_str("LU watchers wait for their time");
            let token: Option<Retained<AnyObject>> = msg_send![&*info, beginActivityWithOptions: OPTIONS, reason: &*reason];
            token.map(Token)
        }
    }

    pub(super) fn end(token: Token) {
        unsafe {
            let info: Retained<AnyObject> = msg_send![class!(NSProcessInfo), processInfo];
            let _: () = msg_send![&*info, endActivity: &*token.0];
        }
    }
}

#[cfg(target_os = "macos")]
fn hold_awake(inner: &mut Inner, wanted: bool) {
    match (wanted, inner.nap.is_some()) {
        (true, false) => inner.nap = nap::begin(),
        (false, true) => {
            if let Some(t) = inner.nap.take() {
                nap::end(t);
            }
        }
        _ => {}
    }
}

#[cfg(not(target_os = "macos"))]
fn hold_awake(_inner: &mut Inner, _wanted: bool) {}

// ── The clock ────────────────────────────────────────────────────

/// Loads the hints of the last quit and starts the clock. Once, at setup.
pub(crate) fn setup(app: &AppHandle) {
    app.manage(WatcherState::default());
    {
        let state = app.state::<WatcherState>();
        let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.hints = hints_from(&load_previous());
        if !inner.hints.is_empty() {
            tracing::info!(count = inner.hints.len(), "[Watchers] ended with the last quit, not caught up");
        }
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let state = app.state::<WatcherState>();
            let now = now_ms();
            let (due, wake_at) = {
                let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
                let due = take_due(&mut inner.watchers, now);
                let waiting = any_waiting(&inner.watchers);
                hold_awake(&mut inner, waiting);
                if !due.is_empty() {
                    save(&inner.watchers);
                }
                (due, next_wake(&inner.watchers, now))
            };
            for w in &due {
                tracing::info!(id = %w.id, "[Watchers] due, handed to the window");
                let _ = app.emit(DUE_EVENT, w);
            }
            if !due.is_empty() {
                let _ = app.emit(CHANGED_EVENT, ());
            }
            let wait = Duration::from_millis((wake_at - now).max(250) as u64);
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = state.wake.notified() => {}
            }
        }
    });
}

fn changed(app: &AppHandle, state: &WatcherState, inner: &Inner) {
    save(&inner.watchers);
    state.wake.notify_one();
    let _ = app.emit(CHANGED_EVENT, ());
}

fn listing(inner: &Inner) -> Listing {
    Listing { watchers: inner.watchers.clone(), hints: inner.hints.clone() }
}

// ── Commands ─────────────────────────────────────────────────────

#[tauri::command]
pub(crate) fn watchers_list(state: tauri::State<'_, WatcherState>) -> Listing {
    listing(&state.inner.lock().unwrap_or_else(|e| e.into_inner()))
}

#[tauri::command]
pub(crate) fn watchers_create(app: AppHandle, state: tauri::State<'_, WatcherState>, spec: WatcherSpec) -> Result<Watcher, String> {
    let now = now_ms();
    check_spec(&spec, now)?;
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    if inner.watchers.len() >= MAX_WATCHERS {
        return Err(format!("There are {MAX_WATCHERS} watchers already. Delete one first."));
    }
    let watcher = Watcher {
        id: uuid::Uuid::new_v4().to_string(),
        name: clip(&spec.name, NAME_MAX),
        task: spec.task.trim().to_string(),
        next_at: next_after(&spec.schedule, now),
        schedule: spec.schedule,
        rights: clean_rights(&spec.rights),
        folder: spec.folder.as_deref().filter(|f| !f.trim().is_empty()).and_then(|f| check_folder(f).ok()),
        model: spec.model.filter(|m| !m.trim().is_empty()),
        paused: false,
        created_at: now,
        running_since: None,
        conversation_id: None,
        origin_conversation_id: spec.origin_conversation_id,
        runs: Vec::new(),
    };
    inner.watchers.push(watcher.clone());
    tracing::info!(id = %watcher.id, next_at = ?watcher.next_at, "[Watchers] created");
    changed(&app, &state, &inner);
    Ok(watcher)
}

#[tauri::command]
pub(crate) fn watchers_update(app: AppHandle, state: tauri::State<'_, WatcherState>, id: String, patch: WatcherPatch) -> Result<Watcher, String> {
    let now = now_ms();
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    let w = inner.watchers.iter_mut().find(|w| w.id == id).ok_or("There is no such watcher.")?;
    let mut next = w.clone();
    if let Some(n) = patch.name {
        if n.trim().is_empty() {
            return Err("The watcher needs a short name.".into());
        }
        next.name = clip(&n, NAME_MAX);
    }
    if let Some(t) = patch.task {
        if t.trim().is_empty() || t.chars().count() > TASK_MAX {
            return Err(format!("The task is empty or longer than {TASK_MAX} characters."));
        }
        next.task = t.trim().to_string();
    }
    if let Some(s) = patch.schedule {
        check_schedule(&s, now)?;
        next.next_at = next_after(&s, now);
        next.schedule = s;
    }
    if let Some(r) = patch.rights {
        for f in &r.extra_folders {
            check_folder(f)?;
        }
        next.rights = clean_rights(&r);
    }
    if let Some(f) = patch.folder {
        next.folder = if f.trim().is_empty() { None } else { Some(check_folder(&f)?) };
    }
    if let Some(m) = patch.model {
        next.model = (!m.trim().is_empty()).then(|| m.trim().to_string());
    }
    if let Some(p) = patch.paused {
        // Resuming a repeat counts from now: a watcher paused over night does
        // not fire for the slot it slept through.
        if next.paused && !p && !matches!(next.schedule, Schedule::Once { .. }) {
            next.next_at = next_after(&next.schedule, now);
        }
        next.paused = p;
    }
    if let Some(c) = patch.conversation_id {
        next.conversation_id = (!c.is_empty()).then_some(c);
    }
    *w = next.clone();
    changed(&app, &state, &inner);
    Ok(next)
}

#[tauri::command]
pub(crate) fn watchers_delete(app: AppHandle, state: tauri::State<'_, WatcherState>, id: String) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    let before = inner.watchers.len();
    inner.watchers.retain(|w| w.id != id);
    if inner.watchers.len() == before {
        return Err("There is no such watcher.".into());
    }
    changed(&app, &state, &inner);
    Ok(())
}

/// Runs a watcher now, once, without changing its schedule.
#[tauri::command]
pub(crate) fn watchers_run_now(app: AppHandle, state: tauri::State<'_, WatcherState>, id: String) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    let w = inner.watchers.iter_mut().find(|w| w.id == id).ok_or("There is no such watcher.")?;
    if w.running_since.is_some() {
        return Err("This watcher is running already.".into());
    }
    w.next_at = Some(now_ms());
    w.paused = false;
    changed(&app, &state, &inner);
    Ok(())
}

/// The window reports a run as over.
#[tauri::command]
pub(crate) fn watchers_finished(app: AppHandle, state: tauri::State<'_, WatcherState>, id: String, run: RunRecord) -> Result<Option<Watcher>, String> {
    let now = now_ms();
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    // Deleted while it ran: nothing to record.
    let Some(w) = inner.watchers.iter_mut().find(|w| w.id == id) else { return Ok(None) };
    tracing::info!(id = %id, status = %run.status, ms = run.ms, "[Watchers] run finished");
    finish(w, run, now);
    let out = w.clone();
    changed(&app, &state, &inner);
    Ok(Some(out))
}

/// The window (re)loaded: a run it had started is gone with the old page.
#[tauri::command]
pub(crate) fn watchers_runner_ready(app: AppHandle, state: tauri::State<'_, WatcherState>) -> Listing {
    let now = now_ms();
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    let mut touched = false;
    for w in inner.watchers.iter_mut() {
        if let Some(since) = w.running_since {
            finish(w, RunRecord { at: since, ms: (now - since).max(0) as u64, status: "stopped".into(), summary: "The window was reloaded during the run.".into() }, now);
            touched = true;
        }
    }
    if touched {
        changed(&app, &state, &inner);
    }
    listing(&inner)
}

#[tauri::command]
pub(crate) fn watchers_dismiss_hint(app: AppHandle, state: tauri::State<'_, WatcherState>, id: Option<String>) {
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    match id {
        Some(id) => inner.hints.retain(|h| h.id != id),
        None => inner.hints.clear(),
    }
    let _ = app.emit(CHANGED_EVENT, ());
}

/// A notification of the system: Notification Center on a Mac, a toast on
/// Windows, the desktop's notification daemon on Linux. Also with the window
/// in the tray; the app icon is the one the system shows.
#[tauri::command]
pub(crate) fn watchers_notify(app: AppHandle, title: String, body: String, sound: bool) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let mut n = app.notification().builder().title(clip(&title, 90)).body(clip(&body, 280));
    if sound {
        n = n.sound(notification_sound());
    }
    let shown = n.show().map_err(|e| format!("The notification could not be shown: {e}"));
    match &shown {
        Ok(()) => tracing::info!(sound, "[Watchers] notification handed to the system"),
        Err(e) => tracing::warn!("[Watchers] {e}"),
    }
    shown
}

/// The system's own short sound.
fn notification_sound() -> &'static str {
    if cfg!(target_os = "linux") {
        // freedesktop sound naming spec
        "message-new-instant"
    } else {
        // NSUserNotificationDefaultSoundName on a Mac, the default toast sound on Windows.
        "default"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, TimeZone};

    fn tz() -> FixedOffset {
        FixedOffset::east_opt(3600).unwrap()
    }
    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        tz().with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap().timestamp_millis()
    }
    fn daily(hour: u8, minute: u8, days: Vec<u8>) -> Schedule {
        Schedule::Daily { hour, minute, days }
    }
    fn watcher(schedule: Schedule, next_at: Option<i64>) -> Watcher {
        Watcher {
            id: "w".into(), name: "w".into(), task: "t".into(), schedule, rights: Rights::default(), folder: None, model: None,
            paused: false, created_at: 0, next_at, running_since: None, conversation_id: None, origin_conversation_id: None, runs: vec![],
        }
    }

    #[test]
    fn daily_is_today_before_the_time_and_tomorrow_after_it() {
        let s = daily(18, 0, vec![]);
        assert_eq!(next_after_in(&tz(), &s, at(2026, 11, 14, 9, 0)), Some(at(2026, 11, 14, 18, 0)));
        assert_eq!(next_after_in(&tz(), &s, at(2026, 11, 14, 18, 0)), Some(at(2026, 11, 15, 18, 0)), "the same minute is past");
        assert_eq!(next_after_in(&tz(), &s, at(2026, 12, 31, 19, 0)), Some(at(2027, 1, 1, 18, 0)), "over the year end");
    }

    #[test]
    fn daily_keeps_to_the_named_days() {
        // 14.11.2026 is a Saturday. Mondays only (0) → Monday 16.11.
        let s = daily(7, 30, vec![0]);
        assert_eq!(next_after_in(&tz(), &s, at(2026, 11, 14, 9, 0)), Some(at(2026, 11, 16, 7, 30)));
        // Mon–Fri on a Friday evening → Monday.
        let s = daily(8, 0, vec![0, 1, 2, 3, 4]);
        assert_eq!(next_after_in(&tz(), &s, at(2026, 11, 13, 20, 0)), Some(at(2026, 11, 16, 8, 0)));
    }

    #[test]
    fn once_is_only_in_the_future_and_interval_counts_from_after() {
        let t = at(2026, 11, 14, 18, 0);
        assert_eq!(next_after_in(&tz(), &Schedule::Once { at: t }, t - 1), Some(t));
        assert_eq!(next_after_in(&tz(), &Schedule::Once { at: t }, t), None);
        assert_eq!(next_after_in(&tz(), &Schedule::Interval { minutes: 30 }, t), Some(t + 30 * 60_000));
    }

    #[test]
    fn a_local_time_maps_to_its_instant() {
        // chrono-tz is no dependency and a FixedOffset has no daylight-saving
        // gap, so only the plain path is pinned here; the gap walk is checked
        // on the real Mac clock in the live test.
        let d = chrono::NaiveDate::from_ymd_opt(2026, 3, 29).unwrap();
        assert_eq!(local_instant(&tz(), d, 2, 30), Some(at(2026, 3, 29, 2, 30)));
    }

    #[test]
    fn schedules_are_checked_with_sentences() {
        let now = at(2026, 11, 14, 12, 0);
        assert!(check_schedule(&Schedule::Once { at: now - 1 }, now).is_err());
        assert!(check_schedule(&Schedule::Once { at: now + 60_000 }, now).is_ok());
        assert!(check_schedule(&Schedule::Interval { minutes: 5 }, now).is_err());
        assert!(check_schedule(&Schedule::Interval { minutes: 10 }, now).is_ok());
        assert!(check_schedule(&daily(24, 0, vec![]), now).is_err());
        assert!(check_schedule(&daily(8, 0, vec![7]), now).is_err());
    }

    #[test]
    fn a_due_watcher_is_taken_once_and_a_paused_one_never() {
        let now = 1_000_000;
        let mut list = vec![watcher(Schedule::Interval { minutes: 10 }, Some(now - 1)), watcher(Schedule::Interval { minutes: 10 }, Some(now - 1))];
        list[1].paused = true;
        let due = take_due(&mut list, now);
        assert_eq!(due.len(), 1);
        assert_eq!(list[0].running_since, Some(now));
        assert!(take_due(&mut list, now + 1).is_empty(), "a running watcher is not taken again");
    }

    #[test]
    fn a_run_never_reported_back_frees_the_watcher_after_hours() {
        let mut list = vec![watcher(Schedule::Interval { minutes: 10 }, Some(0))];
        list[0].running_since = Some(0);
        let due = take_due(&mut list, RUN_STALE_MS + 1);
        assert_eq!(due.len(), 1, "taken again");
        assert_eq!(list[0].runs[0].status, "failed");
    }

    #[test]
    fn after_a_run_once_ends_and_a_repeat_counts_from_now_not_from_the_missed_slots() {
        let mut once = watcher(Schedule::Once { at: 10 }, Some(10));
        finish(&mut once, RunRecord { at: 10, ms: 5, status: "done".into(), summary: "ok".into() }, 20);
        assert_eq!(once.next_at, None);
        assert_eq!(once.runs.len(), 1);
        let mut rep = watcher(Schedule::Interval { minutes: 10 }, Some(0));
        let now = 5 * 60 * 60_000; // five hours late (the Mac slept)
        finish(&mut rep, RunRecord { at: now, ms: 5, status: "done".into(), summary: String::new() }, now);
        assert_eq!(rep.next_at, Some(now + 10 * 60_000), "one run, not thirty");
    }

    #[test]
    fn runs_are_capped_and_summaries_clipped() {
        let mut w = watcher(Schedule::Interval { minutes: 10 }, Some(0));
        for i in 0..(RUNS_KEPT + 5) {
            push_run(&mut w, RunRecord { at: i as i64, ms: 1, status: "done".into(), summary: "x".repeat(1000) });
        }
        assert_eq!(w.runs.len(), RUNS_KEPT);
        assert_eq!(w.runs[0].at, (RUNS_KEPT + 4) as i64, "newest first");
        assert_eq!(w.runs[0].summary.chars().count(), SUMMARY_MAX);
    }

    #[test]
    fn the_clock_wakes_for_the_next_run_but_at_least_every_thirty_seconds() {
        let now = 1_000_000;
        assert_eq!(next_wake(&[], now), now + TICK_MAX_MS);
        assert_eq!(next_wake(&[watcher(Schedule::Interval { minutes: 10 }, Some(now + 5_000))], now), now + 5_000);
        assert_eq!(next_wake(&[watcher(Schedule::Interval { minutes: 10 }, Some(now + 600_000))], now), now + TICK_MAX_MS);
    }

    #[test]
    fn a_restart_names_the_watchers_the_quit_ended_and_nothing_else() {
        let mut paused = watcher(Schedule::Interval { minutes: 10 }, Some(5));
        paused.paused = true;
        let done = watcher(Schedule::Once { at: 1 }, None);
        let live = Watcher { id: "a".into(), name: "Prices".into(), ..watcher(daily(18, 0, vec![]), Some(99)) };
        let hints = hints_from(&[paused, done, live]);
        assert_eq!(hints, vec![Hint { id: "a".into(), name: "Prices".into(), was_next: Some(99) }]);
    }

    #[test]
    fn a_folder_has_to_be_a_real_narrow_one() {
        assert!(check_folder("relative/dir").is_err());
        assert!(check_folder("/").is_err());
        if let Some(home) = dirs::home_dir() {
            assert!(check_folder(&home.to_string_lossy()).is_err());
        }
        let tmp = std::env::temp_dir().join(format!("lu-watch-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(check_folder(&tmp.to_string_lossy()).is_ok());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn the_schedule_reads_the_shape_the_window_sends() {
        let s: Schedule = serde_json::from_str(r#"{"kind":"daily","hour":8,"minute":0,"days":[0,1]}"#).unwrap();
        assert_eq!(s, daily(8, 0, vec![0, 1]));
        let s: Schedule = serde_json::from_str(r#"{"kind":"once","at":123}"#).unwrap();
        assert_eq!(s, Schedule::Once { at: 123 });
        let spec: WatcherSpec = serde_json::from_str(r#"{"name":"n","task":"t","schedule":{"kind":"interval","minutes":60},"rights":{"web":true}}"#).unwrap();
        assert!(spec.rights.web && !spec.rights.terminal);
    }
}
