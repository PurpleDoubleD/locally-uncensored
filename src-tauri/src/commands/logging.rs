//! The log file, as seen from the frontend.
//!
//! Audit finding #01: LU wrote no log file at all. `init_tracing` had a single
//! stdout layer, and a shipped desktop app has no stdout — on Windows the
//! release binary is built with `windows_subsystem = "windows"`, on macOS it is
//! launched from Finder. Any bug that could not be reproduced on a developer
//! machine was therefore unreachable: the user had nothing to send.
//!
//! lib.rs now owns the Rust half (a rolling file writer next to the crash
//! log). This module is the part the WebView can reach:
//!
//! * `log_write` — the frontend mirrors its own warn/error lines into the
//!   same file, so a support log holds BOTH halves of the app in one
//!   chronological stream. Without it the file would describe the backend of a
//!   bug whose visible half happened in React.
//! * `log_file_path` — Settings → Troubleshoot shows the user where the file
//!   is, which is the whole point of writing one.
//! * `log_reveal` — opens that folder in the file manager. `plugin:shell|open`
//!   cannot do this: with no `plugins.shell.open` entry in tauri.conf.json the
//!   plugin falls back to its built-in validator, which only accepts
//!   `https?:` / `mailto:` / `tel:` URLs and rejects a filesystem path.

use serde::Serialize;

/// Trusted callers only, but "trusted" here means "our own bundled frontend",
/// and a runaway loop in it must not be able to fill the user's disk through
/// a rolling file that is only pruned once a day. One line is capped here;
/// the daily rotation and `max_log_files` cap the rest.
const MAX_MESSAGE_CHARS: usize = 4000;

/// Filename parts of the rolling appender. Kept next to the command that
/// reports the path so the two cannot drift apart; lib.rs builds the
/// appender from the same constants.
pub const LOG_FILE_PREFIX: &str = "lu";
pub const LOG_FILE_SUFFIX: &str = "log";

/// The five levels `tracing` knows, parsed from whatever the frontend sent.
///
/// Case-insensitive because the JS side uses lowercase names and a human
/// typing into a console will not. Anything else is rejected rather than
/// silently downgraded to `info`: a typo that logs at the wrong level is a
/// line nobody finds later, and the frontend's own logger only ever sends
/// `warn` / `error`, so a different value means a real bug on the caller side.
pub fn parse_level(raw: &str) -> Option<tracing::Level> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "trace" => Some(tracing::Level::TRACE),
        "debug" => Some(tracing::Level::DEBUG),
        "info" => Some(tracing::Level::INFO),
        "warn" | "warning" => Some(tracing::Level::WARN),
        "error" => Some(tracing::Level::ERROR),
        _ => None,
    }
}

/// One event, one line. A JS stack trace arrives with embedded newlines and
/// would otherwise break the "one record per line" shape the file has for
/// every Rust-side event, which is what makes it greppable at all. Runs of
/// whitespace collapse the same way `crash_report::crash_line` folds a panic
/// payload, and an over-long line is cut with a visible marker so a truncated
/// record can never be mistaken for a complete one.
pub fn sanitize_message(raw: &str) -> String {
    let flat = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= MAX_MESSAGE_CHARS {
        return flat;
    }
    let head: String = flat.chars().take(MAX_MESSAGE_CHARS).collect();
    format!("{head}… [truncated]")
}

/// Where a caller-supplied `target` ends up. Empty / missing collapses to a
/// single known value so the field is always present and always searchable.
pub fn sanitize_target(raw: Option<&str>) -> String {
    let t = raw.unwrap_or("").trim();
    if t.is_empty() {
        "frontend".to_string()
    } else {
        sanitize_message(t)
    }
}

/// Name of the file the daily rotation is writing right now.
///
/// `tracing_appender::rolling` builds its suffix from the **UTC** date
/// (`Rotation::round_date` works on `OffsetDateTime::now_utc()`), so the
/// caller must pass a UTC date or the reported path will be wrong for the
/// hours where local and UTC dates disagree — which is most of the day for
/// anyone west of Greenwich.
pub fn log_file_name(utc_date: &str) -> String {
    format!("{LOG_FILE_PREFIX}.{utc_date}.{LOG_FILE_SUFFIX}")
}

#[derive(Debug, Serialize)]
pub struct LogLocation {
    /// Folder holding the rotated files. This is what the "Open folder"
    /// button opens — the user needs the whole set, not only today's.
    pub dir: String,
    /// Today's file. May not exist yet when nothing has been logged since
    /// midnight UTC, hence `exists`.
    pub file: String,
    pub exists: bool,
    /// Bytes of `file`, 0 when it does not exist. Cheap sanity check for a
    /// support request: "0 bytes" means the writer never got going.
    pub size_bytes: u64,
}

/// Mirror one frontend log line into the app log file.
///
/// Deliberately thin: no formatting, no context object, no batching. The
/// frontend already scrubs its own secrets (src/lib/logger.ts) and serialises
/// its context before it calls this, so everything that arrives is a finished
/// string. Validation is the only real work — an unknown level is an error so
/// the caller learns about it instead of losing lines into a level nobody
/// reads.
#[tauri::command]
pub fn log_write(level: String, target: Option<String>, message: String) -> Result<(), String> {
    let lvl = parse_level(&level).ok_or_else(|| {
        format!("unknown log level {level:?} (expected trace, debug, info, warn or error)")
    })?;
    let src = sanitize_target(target.as_deref());
    let msg = sanitize_message(&message);
    // `tracing`'s `target:` must be a `&'static str`, so the caller's target
    // travels as a field instead. The static target marks the whole stream as
    // coming from the WebView, which is what an `RUST_LOG=ui=warn` filter
    // would key on.
    match lvl {
        tracing::Level::TRACE => tracing::trace!(target: "ui", src = %src, "{msg}"),
        tracing::Level::DEBUG => tracing::debug!(target: "ui", src = %src, "{msg}"),
        tracing::Level::INFO => tracing::info!(target: "ui", src = %src, "{msg}"),
        tracing::Level::WARN => tracing::warn!(target: "ui", src = %src, "{msg}"),
        tracing::Level::ERROR => tracing::error!(target: "ui", src = %src, "{msg}"),
    }
    Ok(())
}

/// Where the log lives, for Settings → Troubleshoot.
#[tauri::command]
pub fn log_file_path() -> Result<LogLocation, String> {
    let dir = crate::os_paths::log_dir();
    let file = dir.join(log_file_name(&chrono::Utc::now().format("%Y-%m-%d").to_string()));
    let meta = std::fs::metadata(&file).ok();
    Ok(LogLocation {
        dir: dir.to_string_lossy().to_string(),
        file: file.to_string_lossy().to_string(),
        exists: meta.is_some(),
        size_bytes: meta.map(|m| m.len()).unwrap_or(0),
    })
}

/// Open the log folder in the platform file manager.
///
/// The directory is created first: a user who asks for the logs on a machine
/// where nothing has been logged yet should get an empty folder, not a file
/// manager error about a path that does not exist.
#[tauri::command]
pub fn log_reveal() -> Result<(), String> {
    let dir = crate::os_paths::log_dir();
    // House rule (os_error.rs drift guard): never hand the operating system's
    // own wording to the user — on a German Windows it is a German sentence in
    // an English app.
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot create {}: {}", dir.display(), crate::os_error::english(&e)))?;

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = crate::process_util::hidden_command("open");
        c.arg(&dir);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = crate::process_util::hidden_command("explorer");
        c.arg(&dir);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        // K14: a foreign desktop-integration program, never something LU
        // bundles, and exactly the kind of Linux foreign spawn this posten
        // is about.
        let mut c = crate::process_util::foreign_system_command("xdg-open");
        c.arg(&dir);
        c
    };

    crate::process_util::suppress_window(&mut cmd);
    // `explorer.exe` returns exit code 1 even on success, so only a spawn
    // failure (no such binary — a bare Linux container without xdg-utils) is
    // reported. Waiting for the file manager to close would hang the command.
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("cannot open the log folder: {}", crate::os_error::english(&e)))
}

// ── The log file of a phone ──────────────────────────────────────────────
//
// The desktop opens its rolling log before Tauri exists, from a path the
// `dirs` crate answers. A phone learns its data folder only inside `setup`
// (`os_paths::set_mobile_dirs`), and the tracing layers have to be in place
// before that. So the phone's file layer writes into `LateFile`: it keeps
// the first lines in memory, and from the moment `open_late_log` names the
// folder it writes to the same daily files the desktop has (same names, so
// `log_file_path` and `read_log_tail` find them).

/// What is kept in memory before the folder is known. The start of an app
/// is a few dozen lines; a start that logs more than this loses the rest of
/// its early lines, never the app.
#[cfg_attr(not(mobile), allow(dead_code))]
const LATE_BUFFER_MAX: usize = 64 * 1024;

#[cfg_attr(not(mobile), allow(dead_code))]
pub(crate) enum LateState<W> {
    Waiting(Vec<u8>),
    Open(W),
    /// The folder could not be opened. Lines are dropped, the app runs.
    Off,
}

#[cfg_attr(not(mobile), allow(dead_code))]
pub(crate) fn late_write<W: std::io::Write>(state: &mut LateState<W>, bytes: &[u8]) {
    match state {
        LateState::Waiting(kept) => {
            let room = LATE_BUFFER_MAX.saturating_sub(kept.len());
            // Whole lines only: half a line at the cap would glue onto the next one.
            if bytes.len() <= room {
                kept.extend_from_slice(bytes);
            }
        }
        LateState::Open(writer) => {
            let _ = writer.write_all(bytes);
        }
        LateState::Off => {}
    }
}

/// Hand over the writer (or the news that there is none) and flush what was kept.
#[cfg_attr(not(mobile), allow(dead_code))]
pub(crate) fn late_open<W: std::io::Write>(state: &mut LateState<W>, writer: Option<W>) {
    let kept = match std::mem::replace(state, LateState::Off) {
        LateState::Waiting(kept) => kept,
        // Opened twice: the first one stays.
        other => {
            *state = other;
            return;
        }
    };
    if let Some(mut writer) = writer {
        let _ = writer.write_all(&kept);
        *state = LateState::Open(writer);
    }
}

#[cfg_attr(not(mobile), allow(dead_code))]
static LATE_LOG: std::sync::Mutex<LateState<tracing_appender::rolling::RollingFileAppender>> =
    std::sync::Mutex::new(LateState::Waiting(Vec::new()));

/// The writer the phone's file layer is built with.
#[cfg_attr(not(mobile), allow(dead_code))]
pub struct LateFile;

impl std::io::Write for LateFile {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        late_write(&mut LATE_LOG.lock().unwrap_or_else(|p| p.into_inner()), bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if let LateState::Open(writer) = &mut *LATE_LOG.lock().unwrap_or_else(|p| p.into_inner()) {
            let _ = writer.flush();
        }
        Ok(())
    }
}

/// Called once from `setup`, after the data folder is known.
#[cfg_attr(not(mobile), allow(dead_code))]
pub fn open_late_log(dir: &std::path::Path, files_kept: usize) {
    let appender = std::fs::create_dir_all(dir).ok().and_then(|_| {
        tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix(LOG_FILE_PREFIX)
            .filename_suffix(LOG_FILE_SUFFIX)
            .max_log_files(files_kept)
            .build(dir)
            .ok()
    });
    late_open(&mut LATE_LOG.lock().unwrap_or_else(|p| p.into_inner()), appender);
}

// ── "Share log" on a phone ───────────────────────────────────────────────
//
// A phone has no file manager to reveal a folder in, so `log_reveal` is
// refused there (commands/mobile_guard.rs). What a support request needs
// travels as text instead: the end of the newest log file and the last
// record of an unexpected death. The frontend hands that to the share sheet.

/// How much of a log file is read at most, from its end.
#[cfg_attr(not(mobile), allow(dead_code))]
const TAIL_MAX_BYTES: u64 = 256 * 1024;
#[cfg_attr(not(mobile), allow(dead_code))]
const TAIL_DEFAULT_LINES: usize = 400;
#[cfg_attr(not(mobile), allow(dead_code))]
const TAIL_MAX_LINES: usize = 2000;

#[cfg_attr(not(mobile), allow(dead_code))]
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogTail {
    /// Name of the file the lines come from, empty when there is no log yet.
    pub file: String,
    /// The last lines, oldest first, joined with line feeds.
    pub text: String,
    pub line_count: usize,
    /// True when the file holds more than what is in `text`.
    pub truncated: bool,
    /// The newest line of crash.log, when the app ever died unexpectedly.
    pub last_crash: Option<String>,
}

/// The last `max_lines` lines of `text`. A cut through the middle of the
/// first line (the file was read from an offset) drops that line.
#[cfg_attr(not(mobile), allow(dead_code))]
pub(crate) fn tail_lines(text: &str, max_lines: usize, starts_mid_line: bool) -> (String, usize, bool) {
    let mut lines: Vec<&str> = text.lines().collect();
    let mut truncated = false;
    if starts_mid_line && !lines.is_empty() {
        lines.remove(0);
        truncated = true;
    }
    if lines.len() > max_lines {
        lines.drain(..lines.len() - max_lines);
        truncated = true;
    }
    (lines.join("\n"), lines.len(), truncated)
}

/// The end of a file as text, at most `max_bytes`. The flag says whether the
/// read began behind the start of the file. Bytes that are not UTF-8 (a cut
/// through a character) are replaced, never an error.
#[cfg_attr(not(mobile), allow(dead_code))]
pub(crate) fn read_end(path: &std::path::Path, max_bytes: u64) -> Option<(String, bool)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let from = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut bytes = Vec::with_capacity((len - from) as usize);
    file.take(max_bytes).read_to_end(&mut bytes).ok()?;
    Some((String::from_utf8_lossy(&bytes).into_owned(), from > 0))
}

/// The newest rotated log file in `dir`. The date is part of the name, so
/// the newest is the last by name.
#[cfg_attr(not(mobile), allow(dead_code))]
pub(crate) fn newest_log_file(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.file_name().and_then(|n| n.to_str()).is_some_and(|name| {
                name.starts_with(&format!("{LOG_FILE_PREFIX}.")) && name.ends_with(&format!(".{LOG_FILE_SUFFIX}"))
            })
        })
        .collect();
    files.sort();
    files.pop()
}

#[cfg_attr(not(mobile), allow(dead_code))]
pub(crate) fn log_tail_from(dir: &std::path::Path, crash_log: &std::path::Path, max_lines: Option<usize>) -> LogTail {
    let max_lines = max_lines.unwrap_or(TAIL_DEFAULT_LINES).clamp(1, TAIL_MAX_LINES);
    let last_crash = read_end(crash_log, 16 * 1024)
        .and_then(|(text, _)| text.lines().rev().find(|line| !line.trim().is_empty()).map(str::to_string));
    let Some(file) = newest_log_file(dir) else {
        return LogTail { file: String::new(), text: String::new(), line_count: 0, truncated: false, last_crash };
    };
    let (raw, mid) = read_end(&file, TAIL_MAX_BYTES).unwrap_or_default();
    let (text, line_count, truncated) = tail_lines(&raw, max_lines, mid);
    LogTail {
        file: file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        text,
        line_count,
        truncated,
        last_crash,
    }
}

/// The end of the app log and the last crash record, as text to share.
/// `maxLines` defaults to 400 and is capped at 2000.
///
/// A command of the phone builds only. The desktop has "Open log folder" for
/// this and does not register it (lib.rs), as in v3.0.5.
#[cfg(mobile)]
#[tauri::command]
#[allow(non_snake_case)]
pub async fn read_log_tail(maxLines: Option<usize>) -> Result<LogTail, String> {
    tokio::task::spawn_blocking(move || {
        log_tail_from(&crate::os_paths::log_dir(), &crate::crash_report::crash_log_path(), maxLines)
    })
    .await
    .map_err(|_| "The log could not be read.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn early_lines_wait_and_arrive_in_order_once_the_file_is_known() {
        let mut state: LateState<Vec<u8>> = LateState::Waiting(Vec::new());
        late_write(&mut state, b"first\n");
        late_write(&mut state, b"second\n");
        late_open(&mut state, Some(Vec::new()));
        late_write(&mut state, b"third\n");
        match &state {
            LateState::Open(file) => assert_eq!(file.as_slice(), b"first\nsecond\nthird\n"),
            _ => panic!("the log should be open"),
        }
        // A second opening changes nothing.
        late_open(&mut state, Some(b"other".to_vec()));
        match &state {
            LateState::Open(file) => assert_eq!(file.as_slice(), b"first\nsecond\nthird\n"),
            _ => panic!("the log should still be the first one"),
        }
    }

    #[test]
    fn the_early_buffer_is_bounded_and_never_cuts_a_line() {
        let mut state: LateState<Vec<u8>> = LateState::Waiting(Vec::new());
        let line = [b'x'; 1000];
        for _ in 0..200 {
            late_write(&mut state, &line);
        }
        match &state {
            LateState::Waiting(kept) => {
                assert!(kept.len() <= LATE_BUFFER_MAX);
                assert_eq!(kept.len() % 1000, 0, "only whole lines are kept");
            }
            _ => panic!("still waiting"),
        }
    }

    #[test]
    fn a_folder_that_cannot_be_opened_drops_lines_and_nothing_else() {
        let mut state: LateState<Vec<u8>> = LateState::Waiting(b"early\n".to_vec());
        late_open(&mut state, None);
        late_write(&mut state, b"later\n");
        assert!(matches!(state, LateState::Off));
    }

    #[test]
    fn the_tail_is_the_newest_lines_in_order() {
        let (text, count, truncated) = tail_lines("a\nb\nc\nd\n", 2, false);
        assert_eq!((text.as_str(), count, truncated), ("c\nd", 2, true));
        let (text, count, truncated) = tail_lines("a\nb", 10, false);
        assert_eq!((text.as_str(), count, truncated), ("a\nb", 2, false));
        // Read from the middle of the file: the first piece is half a line.
        let (text, count, truncated) = tail_lines("lf of a line\nb\nc", 10, true);
        assert_eq!((text.as_str(), count, truncated), ("b\nc", 2, true));
        assert_eq!(tail_lines("", 10, false), (String::new(), 0, false));
    }

    #[test]
    fn the_log_tail_reads_the_newest_file_and_the_last_death() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join(log_file_name("2026-10-06"));
        let new = dir.path().join(log_file_name("2026-10-07"));
        std::fs::write(&old, "old line\n").unwrap();
        std::fs::write(&new, (1..=50).map(|n| format!("line {n}\n")).collect::<String>()).unwrap();
        std::fs::write(dir.path().join("notes.txt"), "not a log\n").unwrap();
        let crash = dir.path().join("crash.log");
        std::fs::write(&crash, "first death\nsecond death\n\n").unwrap();

        let tail = log_tail_from(dir.path(), &crash, Some(3));
        assert_eq!(tail.file, log_file_name("2026-10-07"));
        assert_eq!(tail.text, "line 48\nline 49\nline 50");
        assert_eq!(tail.line_count, 3);
        assert!(tail.truncated);
        assert_eq!(tail.last_crash.as_deref(), Some("second death"));

        let all = log_tail_from(dir.path(), &dir.path().join("no-crash.log"), None);
        assert_eq!(all.line_count, 50);
        assert!(!all.truncated);
        assert_eq!(all.last_crash, None);
    }

    #[test]
    fn no_log_yet_is_an_empty_answer_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let tail = log_tail_from(dir.path(), &dir.path().join("crash.log"), None);
        assert_eq!(tail, LogTail { file: String::new(), text: String::new(), line_count: 0, truncated: false, last_crash: None });
        let missing = log_tail_from(&dir.path().join("gone"), &dir.path().join("crash.log"), None);
        assert_eq!(missing.line_count, 0);
    }

    #[test]
    fn a_huge_log_is_read_from_its_end_only() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(log_file_name("2026-10-08"));
        let line = "x".repeat(99);
        std::fs::write(&file, (0..6000).map(|n| format!("{line}{n:05}\n")).collect::<String>()).unwrap();
        let tail = log_tail_from(dir.path(), &dir.path().join("crash.log"), Some(5000));
        assert!(tail.truncated);
        assert_eq!(tail.line_count, 2000, "the cap on lines holds");
        assert!(tail.text.ends_with("05999"));
        assert!(tail.text.len() as u64 <= TAIL_MAX_BYTES);
    }

    #[test]
    fn parses_every_level_case_insensitively() {
        assert_eq!(parse_level("warn"), Some(tracing::Level::WARN));
        assert_eq!(parse_level("WARN"), Some(tracing::Level::WARN));
        assert_eq!(parse_level("  Error "), Some(tracing::Level::ERROR));
        assert_eq!(parse_level("info"), Some(tracing::Level::INFO));
        assert_eq!(parse_level("debug"), Some(tracing::Level::DEBUG));
        assert_eq!(parse_level("trace"), Some(tracing::Level::TRACE));
        // JS console vocabulary — `warning` is what a few callers say.
        assert_eq!(parse_level("warning"), Some(tracing::Level::WARN));
    }

    #[test]
    fn rejects_anything_that_is_not_a_level() {
        // A typo must not quietly become `info`: the line would be written at
        // a level the support filter does not read, which is the same as
        // losing it.
        assert_eq!(parse_level("fatal"), None);
        assert_eq!(parse_level(""), None);
        assert_eq!(parse_level("wa rn"), None);
        assert_eq!(parse_level("../../etc/passwd"), None);
    }

    #[test]
    fn log_write_refuses_an_unknown_level_and_names_it() {
        let err = log_write("fatal".into(), None, "boom".into()).unwrap_err();
        assert!(err.contains("fatal"), "the error should quote the bad level: {err}");
    }

    #[test]
    fn log_write_accepts_a_valid_level() {
        // No subscriber is installed in a unit test, so this only proves the
        // validation path and that the macros compile for every arm.
        assert!(log_write("warn".into(), Some("chat".into()), "hi".into()).is_ok());
        assert!(log_write("error".into(), None, "hi".into()).is_ok());
    }

    #[test]
    fn a_js_stack_trace_stays_on_one_line() {
        let stack = "TypeError: x is not a function\n    at foo (app.js:1:2)\r\n    at bar";
        let out = sanitize_message(stack);
        assert!(!out.contains('\n'), "got: {out}");
        assert!(!out.contains('\r'), "got: {out}");
        assert!(out.contains("TypeError: x is not a function at foo (app.js:1:2) at bar"));
    }

    #[test]
    fn an_enormous_message_is_cut_and_says_so() {
        let out = sanitize_message(&"a".repeat(MAX_MESSAGE_CHARS * 3));
        assert!(out.ends_with("… [truncated]"), "a cut line must be recognisable as cut");
        assert!(out.chars().count() < MAX_MESSAGE_CHARS + 40);
    }

    #[test]
    fn a_short_message_is_untouched_apart_from_whitespace() {
        assert_eq!(sanitize_message("model load failed"), "model load failed");
        assert_eq!(sanitize_message("  padded  "), "padded");
    }

    #[test]
    fn a_missing_target_gets_a_searchable_default() {
        assert_eq!(sanitize_target(None), "frontend");
        assert_eq!(sanitize_target(Some("   ")), "frontend");
        assert_eq!(sanitize_target(Some("chatStore")), "chatStore");
    }

    #[test]
    fn the_reported_file_name_matches_the_appender_convention() {
        // tracing-appender builds `<prefix>.<date>.<suffix>`; if lib.rs and
        // this command disagree, Settings shows a path that does not exist.
        assert_eq!(log_file_name("2026-08-31"), "lu.2026-08-31.log");
    }

    #[test]
    fn main_builds_the_appender_from_these_same_constants() {
        // The name is only right because both sides use the constants above.
        // A refactor that inlines "lu" in lib.rs would break the Settings
        // path silently, so pin the wiring here.
        let src = include_str!("../lib.rs");
        assert!(
            src.contains("commands::logging::LOG_FILE_PREFIX")
                && src.contains("commands::logging::LOG_FILE_SUFFIX"),
            "the rolling appender must be named from logging.rs's constants"
        );
    }

    #[test]
    fn log_file_path_points_into_the_log_dir() {
        let loc = log_file_path().expect("path lookup never fails");
        assert!(loc.file.starts_with(&loc.dir), "{loc:?}");
        assert!(loc.file.ends_with(".log"), "{loc:?}");
        assert!(loc.dir.ends_with("logs"), "{loc:?}");
        // Never reports a size for a file it just said does not exist.
        assert!(loc.exists || loc.size_bytes == 0, "{loc:?}");
    }
}
