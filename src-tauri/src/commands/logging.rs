//! The log file, as seen from the frontend.
//!
//! Audit finding #01: LU wrote no log file at all. `init_tracing` had a single
//! stdout layer, and a shipped desktop app has no stdout — on Windows the
//! release binary is built with `windows_subsystem = "windows"`, on macOS it is
//! launched from Finder. Any bug that could not be reproduced on a developer
//! machine was therefore unreachable: the user had nothing to send.
//!
//! main.rs now owns the Rust half (a rolling file writer next to the crash
//! log). This module is the part the WebView can reach:
//!
//! * `log_write`   — the frontend mirrors its own warn/error lines into the
//!                   same file, so a support log holds BOTH halves of the app
//!                   in one chronological stream. Without it the file would
//!                   describe the backend of a bug whose visible half happened
//!                   in React.
//! * `log_file_path` — Settings → Troubleshoot shows the user where the file
//!                   is, which is the whole point of writing one.
//! * `log_reveal`  — opens that folder in the file manager. `plugin:shell|open`
//!                   cannot do this: with no `plugins.shell.open` entry in
//!                   tauri.conf.json the plugin falls back to its built-in
//!                   validator, which only accepts `https?:` / `mailto:` /
//!                   `tel:` URLs and rejects a filesystem path.

use serde::Serialize;

/// Trusted callers only, but "trusted" here means "our own bundled frontend",
/// and a runaway loop in it must not be able to fill the user's disk through
/// a rolling file that is only pruned once a day. One line is capped here;
/// the daily rotation and `max_log_files` cap the rest.
const MAX_MESSAGE_CHARS: usize = 4000;

/// Filename parts of the rolling appender. Kept next to the command that
/// reports the path so the two cannot drift apart; main.rs builds the
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
        let mut c = std::process::Command::new("open");
        c.arg(&dir);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer");
        c.arg(&dir);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
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

#[cfg(test)]
mod tests {
    use super::*;

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
        // tracing-appender builds `<prefix>.<date>.<suffix>`; if main.rs and
        // this command disagree, Settings shows a path that does not exist.
        assert_eq!(log_file_name("2026-08-31"), "lu.2026-08-31.log");
    }

    #[test]
    fn main_builds_the_appender_from_these_same_constants() {
        // The name is only right because both sides use the constants above.
        // A refactor that inlines "lu" in main.rs would break the Settings
        // path silently, so pin the wiring here.
        let src = include_str!("../main.rs");
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
