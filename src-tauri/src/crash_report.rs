//! Last words. A record of an unexpected process death, written where a
//! support request can find it.
//!
//! Why this exists: the release profile builds with `panic = "abort"`
//! (Cargo.toml). A panic on ANY thread therefore takes the whole app down at
//! once, and `catch_unwind` cannot stop it, so "no unhandled panic in the
//! timer paths" cannot be delivered by catching. What can be delivered is a
//! trace. A shipped Windows build has no console: it is started from the
//! Start menu, `windows_subsystem = "windows"` is set, and stdout and stderr
//! go nowhere a user will ever look. Until now a panic in a background thread
//! ended the app with an empty screen and an empty log, which is exactly the
//! shape of the "it just died on its own" reports.
//!
//! What is written is deliberately small: one line per death, appended, with
//! a hard cap on the file so it can never grow without bound. Everything the
//! user might see is English (house rule), and the payload is what Rust
//! already prints for a panic, so it holds no user content beyond whatever a
//! panic message carries by itself.

use std::io::Write;

/// The name of the file, in the app data directory.
pub(crate) const CRASH_LOG: &str = "crash.log";

/// Keep the newest entries and no more than this many bytes. A panic line is
/// a few hundred bytes, so this is thousands of deaths, and the cap matters
/// only against a boot loop that panics on every start.
pub(crate) const MAX_BYTES: u64 = 256 * 1024;

/// One line for one death. Pure, so the format is testable without panicking
/// a test process.
///
/// `when` is passed in rather than read from the clock so the test can pin it.
pub(crate) fn crash_line(when: &str, thread: &str, location: &str, payload: &str) -> String {
    // Newlines in a panic payload would break "one death, one line" and make
    // the file unparseable, so they are folded. Runs of whitespace collapse to
    // a single space, otherwise a CRLF payload leaves double gaps and the line
    // reads worse than the panic it reports.
    let flat = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    format!(
        "{} FATAL thread={} at={} panic: {}\n",
        flat(when),
        flat(thread),
        flat(location),
        flat(payload)
    )
}

/// What Rust hands a panic hook, reduced to the two strings we can print.
/// `PanicHookInfo::payload` is `&str` for `panic!("...")` and `String` for a
/// formatted one; anything else has no text at all and says so rather than
/// being dropped silently.
pub(crate) fn payload_text(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "panic payload is not a string".to_string()
    }
}

/// Append one line, trimming the file first if it has grown past the cap.
///
/// Best effort throughout. This runs while the process is already dying: a
/// read-only directory, a full disk, or a file another process holds open
/// must not turn a panic into a second failure, and there is nobody left to
/// report an error to anyway.
pub(crate) fn append_capped(path: &std::path::Path, line: &str) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let too_big = std::fs::metadata(path).map(|m| m.len() > MAX_BYTES).unwrap_or(false);
    if too_big {
        // Keep the newest half. Reading the whole file is fine at this size,
        // and a partial line at the front is cut at the first newline so the
        // file stays one-record-per-line.
        if let Ok(old) = std::fs::read_to_string(path) {
            let keep_from = old.len().saturating_sub(MAX_BYTES as usize / 2);
            let tail = &old[keep_from..];
            let tail = match tail.find('\n') {
                Some(i) => &tail[i + 1..],
                None => "",
            };
            let _ = std::fs::write(path, tail);
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
        let _ = f.flush();
    }
}

/// Where the crash log lives.
pub(crate) fn crash_log_path() -> std::path::PathBuf {
    crate::os_paths::data_dir().join(CRASH_LOG)
}

/// Install the hook. Called once from `main`, before anything can panic.
///
/// The previous hook is kept and still runs, so the familiar
/// `thread '...' panicked at ...` line still reaches stderr for anyone who
/// started the app from a terminal.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let when = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| format!("unix={}", d.as_secs()))
            .unwrap_or_else(|_| "unix=unknown".to_string());
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".to_string());
        let payload = payload_text(info.payload());
        let line = crash_line(&when, &thread, &location, &payload);
        append_capped(&crash_log_path(), &line);
        // Also on stderr, where a debug launcher that redirects it will catch
        // it. The release profile aborts right after this hook returns, so
        // this is the last chance either sink gets.
        eprint!("{line}");
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_death_is_one_line_that_names_thread_place_and_reason() {
        let line = crash_line("unix=1", "backup-ring", "src/commands/system.rs:42:9", "index out of bounds");
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.contains("FATAL"));
        assert!(line.contains("thread=backup-ring"));
        assert!(line.contains("at=src/commands/system.rs:42:9"));
        assert!(line.contains("index out of bounds"));
    }

    #[test]
    fn a_multi_line_panic_message_is_folded_into_the_one_line() {
        // Negative control for the check above: a payload with newlines used
        // to be able to forge extra records in the file.
        let line = crash_line("unix=1", "main", "a.rs:1:1", "first\nsecond\r\nthird");
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.contains("first second third"));
    }

    #[test]
    fn both_panic_payload_shapes_keep_their_text() {
        let borrowed: Box<dyn std::any::Any + Send> = Box::new("a literal panic");
        let owned: Box<dyn std::any::Any + Send> = Box::new(String::from("a formatted panic"));
        assert_eq!(payload_text(&*borrowed), "a literal panic");
        assert_eq!(payload_text(&*owned), "a formatted panic");
    }

    #[test]
    fn a_payload_that_is_not_text_still_reports_something() {
        // Negative control: `panic_any(42)` carries no string, and dropping it
        // silently would leave the same empty log this module exists to end.
        let odd: Box<dyn std::any::Any + Send> = Box::new(42u8);
        assert_eq!(payload_text(&*odd), "panic payload is not a string");
    }

    #[test]
    fn every_line_is_english() {
        // House rule: nothing the user or support reads is localised, and no
        // OS string in any language is passed through here.
        let line = crash_line("unix=1", "main", "a.rs:1:1", "attempt to divide by zero");
        assert!(line.is_ascii(), "crash line must stay plain English ASCII: {line}");
    }

    #[test]
    fn appending_creates_the_file_and_keeps_the_records_in_order() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested").join(CRASH_LOG);
        append_capped(&path, "first\n");
        append_capped(&path, "second\n");
        let got = std::fs::read_to_string(&path).expect("crash log exists");
        assert_eq!(got, "first\nsecond\n");
    }

    #[test]
    fn a_log_past_the_cap_is_trimmed_but_the_newest_record_survives() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(CRASH_LOG);
        let filler = format!("{}\n", "x".repeat(1023));
        let mut bulk = String::new();
        while (bulk.len() as u64) < MAX_BYTES + 4096 {
            bulk.push_str(&filler);
        }
        std::fs::write(&path, &bulk).expect("write bulk");
        append_capped(&path, "the newest death\n");
        let got = std::fs::read_to_string(&path).expect("read back");
        assert!(got.len() < bulk.len(), "file was not trimmed: {} bytes", got.len());
        assert!(got.ends_with("the newest death\n"));
        assert!(got.starts_with("xxx"), "trim must cut at a record boundary");
    }

    #[test]
    fn a_log_under_the_cap_is_never_trimmed() {
        // Negative control for the trim above.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(CRASH_LOG);
        std::fs::write(&path, "old record\n").expect("write");
        append_capped(&path, "new record\n");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read back"),
            "old record\nnew record\n"
        );
    }
}
