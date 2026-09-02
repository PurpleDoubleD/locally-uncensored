//! English text for errors the operating system worded itself.
//!
//! David, 2026-08-22, from the box: the app showed a proxy failure whose text
//! was half German. No German word exists anywhere in this repo. Windows wrote
//! it: `std::io::Error`'s Display calls FormatMessageW, which answers in the
//! system language, so a German Windows hands us "Es konnte keine Verbindung
//! hergestellt werden ... (os error 10061)" and we pass it straight through to
//! a user who set the app to English.
//!
//! The rule is that our messages are English. The cure cannot be a translation
//! table: we would be translating FROM an unknown language, and the set of
//! codes is open. So we do the opposite and never show the OS wording at all.
//! `ErrorKind` and the numeric code are language neutral, and between them they
//! carry everything the message was worth: what went wrong, and the number to
//! search for.
//!
//! This does NOT touch the output of foreign processes (pip, git, ComfyUI).
//! Their stderr is theirs, we only promise that OUR frame around it is English.

use std::io::ErrorKind;

/// The English phrase for a language neutral `ErrorKind`.
///
/// `ErrorKind` is `#[non_exhaustive]` and most Windows codes land in the
/// unstable `Uncategorized` arm, so this returns None more often than it
/// looks. The numeric code carries those.
fn kind_phrase(kind: ErrorKind) -> Option<&'static str> {
    Some(match kind {
        ErrorKind::NotFound => "not found",
        ErrorKind::PermissionDenied => "permission denied",
        ErrorKind::ConnectionRefused => "connection refused",
        ErrorKind::ConnectionReset => "connection reset by peer",
        ErrorKind::ConnectionAborted => "connection aborted",
        ErrorKind::NotConnected => "not connected",
        ErrorKind::AddrInUse => "address already in use",
        ErrorKind::AddrNotAvailable => "address not available",
        ErrorKind::BrokenPipe => "broken pipe",
        ErrorKind::AlreadyExists => "already exists",
        ErrorKind::WouldBlock => "operation would block",
        ErrorKind::InvalidInput => "invalid input",
        ErrorKind::InvalidData => "invalid data",
        ErrorKind::TimedOut => "timed out",
        ErrorKind::WriteZero => "write returned zero bytes",
        ErrorKind::Interrupted => "interrupted",
        ErrorKind::Unsupported => "unsupported operation",
        ErrorKind::UnexpectedEof => "unexpected end of file",
        ErrorKind::OutOfMemory => "out of memory",
        _ => return None,
    })
}

/// The handful of codes that reach a user often enough to be worth naming, and
/// that Rust does not categorise on the platform where they occur.
///
/// Deliberately short. A code we cannot name is still printed as a number, and
/// a number is what anyone searches for anyway. Guessing at a code we have not
/// seen would be inventing an English error to replace a true German one.
fn code_phrase(code: i32) -> Option<&'static str> {
    Some(match code {
        // Windows. The first two are gated because those numbers are also unix
        // errnos with entirely different meanings: 32 is EPIPE and 33 is EDOM,
        // so the ungated table told a Mac that a broken pipe was a file in use.
        // Found while wiring the whisper pipe errors through here, where EPIPE
        // is the everyday case on Mac and Linux.
        #[cfg(windows)]
        32 => "the file is in use by another process",
        #[cfg(windows)]
        33 => "the file is locked by another process",
        // No unix errno reaches these, so they need no gate. Linux stops at
        // 133 and macOS well below that.
        145 => "the directory is not empty",
        1224 => "the file is open by another process",
        // The whisper server's stdin, after the python process died: the box
        // showed "stdin flush: Die Pipe wird gerade geschlossen. (os error 232)"
        // in the red hint over the microphone (B4 Gegenprobe, 29.08.).
        // ERROR_NO_DATA, and no unix errno collides with it.
        232 => "the pipe is closing",
        10013 => "the port is blocked, by permissions or by a firewall",
        // hyper-util logs a failed set_nodelay with this one, and that log
        // line is what showed German text in lu-app-exit.log on the box.
        10022 => "an invalid argument was supplied",
        10048 => "the port is already in use",
        10049 => "the address is not available on this machine",
        10060 => "the connection timed out",
        10061 => "connection refused, nothing is listening on that port",
        _ => return None,
    })
}

/// One OS error, in English.
///
/// Order matters: the specific code wins over the broad kind, because
/// "the port is already in use" is worth more than "address already in use",
/// and a categorised kind wins over nothing. The number always rides along, so
/// the answer is never less searchable than what Windows wrote.
pub fn io_english(e: &std::io::Error) -> String {
    match e.raw_os_error() {
        Some(code) => {
            let phrase = code_phrase(code)
                .or_else(|| kind_phrase(e.kind()))
                .unwrap_or("the operating system refused the operation");
            format!("{} (os error {})", phrase, code)
        }
        // No OS code means Rust built this error itself, so the text is ours
        // and it is already English.
        None => e.to_string(),
    }
}

/// Any error, with every OS worded part of it replaced by English.
///
/// The reason this is not simply `io_english` is reqwest and hyper. Their
/// Display walks their own source chain, so the string we would have shown is
/// "error sending request for url (...): error trying to connect: tcp connect
/// error: <whatever Windows said>". The English scaffolding is worth keeping,
/// and only the leaf is the OS talking, so we render the chain as usual and
/// then swap out exactly the leaf.
pub fn english_dyn(err: &(dyn std::error::Error + 'static)) -> String {
    // The error IS an OS error: nothing to keep, answer outright.
    if let Some(io) = err.downcast_ref::<std::io::Error>() {
        return io_english(io);
    }
    let mut text = err.to_string();
    let mut cur = err.source();
    while let Some(e) = cur {
        if let Some(io) = e.downcast_ref::<std::io::Error>() {
            let os_worded = io.to_string();
            let ours = io_english(io);
            if os_worded != ours {
                text = text.replace(&os_worded, &ours);
            }
        }
        cur = e.source();
    }
    text
}

/// `english_dyn` for a concrete error type, so call sites read as
/// `map_err(|e| format!("...: {}", os_error::english(&e)))`.
pub fn english<E>(err: &E) -> String
where
    E: std::error::Error + 'static,
{
    english_dyn(err)
}

/// Every operating system worded phrase in a line of text, replaced by ours.
///
/// `english_dyn` above can only help where we hold the error value. A log line
/// written INSIDE a dependency is past that point: hyper-util renders a failed
/// `set_nodelay` with `warn!("tcp set_nodelay error: {}", e)`, and on the
/// German Windows box that reached lu-app-exit.log as
/// `tcp set_nodelay error: Ein ungueltiges Argument wurde angegeben.
/// (os error 10022)`. We cannot patch the crate, but the log sink is ours, so
/// the wording is repaired on the way out.
///
/// No guessing is involved and no phrase is parsed. A `(os error N)` in the
/// text names the code; asking this machine for that code's own Display gives
/// back the exact bytes the operating system would have written, and those
/// exact bytes are what gets replaced. A line that carries no code, or whose
/// wording is already ours, comes back untouched and unallocated.
pub fn sanitize_os_wording(text: &str) -> std::borrow::Cow<'_, str> {
    const MARK: &str = "(os error ";
    if !text.contains(MARK) {
        return std::borrow::Cow::Borrowed(text);
    }

    // Every distinct code the line mentions.
    let mut codes: Vec<i32> = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find(MARK) {
        let after = &rest[at + MARK.len()..];
        let end = after.find(|c: char| !c.is_ascii_digit()).unwrap_or(after.len());
        if end > 0 && after[end..].starts_with(')') {
            if let Ok(code) = after[..end].parse::<i32>() {
                if !codes.contains(&code) {
                    codes.push(code);
                }
            }
        }
        rest = &after[end..];
    }

    let mut out = std::borrow::Cow::Borrowed(text);
    for code in codes {
        let e = std::io::Error::from_raw_os_error(code);
        let os_worded = e.to_string();
        let ours = io_english(&e);
        if os_worded != ours && out.contains(&os_worded) {
            out = std::borrow::Cow::Owned(out.replace(&os_worded, &ours));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    /// An error that wraps another, the shape reqwest and hyper have.
    #[derive(Debug)]
    struct Wrapper {
        head: String,
        source: Error,
    }
    impl std::fmt::Display for Wrapper {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            // Exactly what reqwest does: render the head, then the source.
            write!(f, "{}: {}", self.head, self.source)
        }
    }
    impl std::error::Error for Wrapper {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&self.source)
        }
    }

    /// The connection-refused code of the machine the test runs on, so the
    /// suite proves the same journey on every platform.
    #[cfg(windows)]
    const REFUSED: i32 = 10061;
    #[cfg(target_os = "macos")]
    const REFUSED: i32 = 61;
    #[cfg(all(unix, not(target_os = "macos")))]
    const REFUSED: i32 = 111;

    /// A second, different code, so a line carrying two of them is covered.
    #[cfg(windows)]
    const NOT_FOUND: i32 = 2;
    #[cfg(unix)]
    const NOT_FOUND: i32 = 2;

    #[test]
    fn an_os_error_is_answered_in_our_words_not_the_systems() {
        let e = Error::from_raw_os_error(REFUSED);
        let ours = io_english(&e);
        // The point of the whole module: the answer is fixed by us, not read
        // off the operating system. On a German Windows e.to_string() is
        // German; this assertion is the same either way.
        assert!(ours.starts_with("connection refused"), "got: {}", ours);
        assert!(ours.contains(&format!("os error {}", REFUSED)), "got: {}", ours);
    }

    /// The exact code from the box, which must read the same on any machine.
    ///
    /// `sanitize_os_wording` cannot help here and this test is why it is not
    /// used at that call site: it repairs a line by asking THIS machine for the
    /// code's wording, and a Mac has no German to recognise. `english()` at the
    /// call site never asks, so the answer is fixed by us on every platform.
    #[test]
    fn the_pipe_code_from_the_box_reads_in_our_words_on_every_platform() {
        let ours = io_english(&Error::from_raw_os_error(232));
        assert_eq!(ours, "the pipe is closing (os error 232)");
    }

    /// The whole failure the user saw, rebuilt, and the shape it has now.
    #[test]
    fn the_red_hint_over_the_microphone_is_english() {
        let e = Error::from_raw_os_error(232);
        // What the three call sites used to write: the error's own Display,
        // which on a German Windows is "Die Pipe wird gerade geschlossen.".
        let before = format!("stdin flush: {}", e);
        // What they write now.
        let after = format!("stdin flush: {}", io_english(&e));
        assert_eq!(after, "stdin flush: the pipe is closing (os error 232)");
        // On a German box `before` is German; here it is only "Unknown error",
        // so the assertion that says something on every platform is that the
        // new wording no longer depends on what the system happens to say.
        assert!(!after.contains(&e.to_string()) || e.to_string() == io_english(&e));
    }

    /// The gate, from the side that was wrong.
    #[test]
    #[cfg(unix)]
    fn a_broken_pipe_on_unix_is_not_described_as_a_file_in_use() {
        // errno 32 is EPIPE here and ERROR_SHARING_VIOLATION there. Rust
        // categorises this one, so the kind carries it.
        let ours = io_english(&Error::from_raw_os_error(32));
        assert!(ours.contains("broken pipe"), "got: {}", ours);
        assert!(!ours.contains("in use by another process"), "got: {}", ours);
        assert!(ours.contains("os error 32"), "got: {}", ours);
    }

    #[test]
    fn the_number_survives_even_when_the_code_has_no_name() {
        // A code no table knows. It must still be searchable.
        let e = Error::from_raw_os_error(31337);
        let ours = io_english(&e);
        assert!(ours.contains("os error 31337"), "got: {}", ours);
        assert!(!ours.is_empty());
    }

    #[test]
    fn an_error_rust_built_itself_is_left_alone() {
        // No raw OS code means no FormatMessageW was involved, so the text is
        // ours already and rewriting it would only lose detail.
        let e = Error::new(ErrorKind::InvalidData, "the manifest has no version field");
        assert_eq!(io_english(&e), "the manifest has no version field");
    }

    #[test]
    fn a_wrapped_os_error_loses_the_system_wording_and_keeps_the_scaffolding() {
        let inner = Error::from_raw_os_error(REFUSED);
        let os_worded = inner.to_string();
        let w = Wrapper { head: "error trying to connect".into(), source: inner };
        let ours = english(&w);
        assert!(ours.starts_with("error trying to connect: "), "got: {}", ours);
        assert!(ours.contains("connection refused"), "got: {}", ours);
        // The leaf the operating system wrote is gone from the message.
        assert!(!ours.contains(&os_worded), "the OS wording survived: {}", ours);
    }

    #[test]
    fn two_layers_deep_is_still_reached() {
        // reqwest wraps hyper wraps io, which is the real depth on a refused
        // localhost backend.
        let inner = Error::from_raw_os_error(REFUSED);
        let os_worded = inner.to_string();
        let mid = Wrapper { head: "tcp connect error".into(), source: inner };
        // A third layer that renders the second, the way reqwest renders hyper.
        #[derive(Debug)]
        struct Outer(Wrapper);
        impl std::fmt::Display for Outer {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "error sending request: {}", self.0)
            }
        }
        impl std::error::Error for Outer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }
        let ours = english(&Outer(mid));
        assert!(ours.starts_with("error sending request: tcp connect error: "), "got: {}", ours);
        assert!(!ours.contains(&os_worded), "the OS wording survived: {}", ours);
    }

    #[test]
    fn a_log_line_written_inside_a_dependency_loses_the_system_wording() {
        // The exact shape from lu-app-exit.log on the box, with this machine's
        // own code standing in for 10022: hyper-util formats the io::Error
        // itself, so what lands in the log is the operating system's wording.
        let e = Error::from_raw_os_error(REFUSED);
        let line = format!("tcp set_nodelay error: {}", e);
        let fixed = sanitize_os_wording(&line);
        assert!(fixed.starts_with("tcp set_nodelay error: "), "got: {}", fixed);
        // The number is the whole point of keeping anything at all.
        assert!(fixed.contains(&format!("os error {}", REFUSED)), "got: {}", fixed);
        assert!(fixed.contains("connection refused"), "got: {}", fixed);
        // And the wording the system chose is gone. On a German Windows that
        // string is German; this assertion does not care which language it was.
        assert!(!fixed.contains(&e.to_string()), "the system wording survived: {}", fixed);
    }

    #[test]
    fn two_codes_in_one_line_are_both_repaired() {
        let a = Error::from_raw_os_error(REFUSED);
        let b = Error::from_raw_os_error(NOT_FOUND);
        let line = format!("first: {} | second: {}", a, b);
        let fixed = sanitize_os_wording(&line);
        assert!(!fixed.contains(&a.to_string()), "got: {}", fixed);
        assert!(!fixed.contains(&b.to_string()), "got: {}", fixed);
        assert!(fixed.contains(&format!("os error {}", REFUSED)), "got: {}", fixed);
        assert!(fixed.contains(&format!("os error {}", NOT_FOUND)), "got: {}", fixed);
        assert!(fixed.contains(" | second: "), "the scaffolding was eaten: {}", fixed);
    }

    // Negative controls: everything that is not the operating system talking
    // has to come back byte for byte, and without an allocation.
    #[test]
    fn an_ordinary_log_line_is_returned_untouched() {
        for line in [
            "LU starting version=2.6.7",
            "engine loaded mlabonne_gemma-3-4b-it-abliterated-Q4_K_M",
            "the file is in use by another process",
            // A number that is not a code, and a marker that never closes.
            "os error is not the same as (os error ) here",
            "(os error abc)",
        ] {
            let out = sanitize_os_wording(line);
            assert_eq!(out, line);
            assert!(matches!(out, std::borrow::Cow::Borrowed(_)), "allocated for: {}", line);
        }
    }

    #[test]
    fn a_line_that_already_reads_in_our_words_is_left_exactly_as_it_is() {
        let ours = io_english(&Error::from_raw_os_error(REFUSED));
        let line = format!("proxy_localhost: {}", ours);
        let out = sanitize_os_wording(&line);
        assert_eq!(out, line);
        assert!(matches!(out, std::borrow::Cow::Borrowed(_)), "rewrote its own output");
    }

    #[test]
    fn a_chain_without_an_os_error_is_returned_untouched() {
        let inner = Error::new(ErrorKind::InvalidData, "bad json");
        let w = Wrapper { head: "parse failed".into(), source: inner };
        assert_eq!(english(&w), "parse failed: bad json");
    }

    #[test]
    fn every_named_code_reads_as_a_sentence_and_none_is_empty() {
        // A guard on the tables: an entry added with an empty or capitalised
        // string would read wrong inside "Failed to X: <phrase>".
        #[cfg(windows)]
        const NAMED: &[i32] = &[32, 33, 145, 232, 1224, 10013, 10022, 10048, 10049, 10060, 10061];
        #[cfg(not(windows))]
        const NAMED: &[i32] = &[145, 232, 1224, 10013, 10022, 10048, 10049, 10060, 10061];
        for &code in NAMED {
            let p = code_phrase(code).expect("table entry vanished");
            assert!(!p.is_empty());
            assert!(p.chars().next().unwrap().is_lowercase(), "code {} is capitalised", code);
        }
        for kind in [ErrorKind::NotFound, ErrorKind::PermissionDenied, ErrorKind::TimedOut] {
            let p = kind_phrase(kind).expect("kind entry vanished");
            assert!(p.chars().next().unwrap().is_lowercase());
        }
    }
}
/// The drift guard: no new code may hand the operating system's own wording to
/// the frontend.
///
/// The fix was 86 call sites. Without this the 87th arrives next week and
/// nobody notices, because on an English machine the bug is invisible: the OS
/// wording and our wording read the same, and only a German or French Windows
/// tells them apart. So the check has to be static, and it has to run here.
///
/// It looks for one shape: a line that both performs an operation the OS can
/// fail (a filesystem call, a process spawn, an HTTP send) and renders the
/// error straight into a string, without going through this module.
#[cfg(test)]
mod drift_guard {
    use std::path::{Path, PathBuf};

    /// Calls whose error is written by the operating system.
    const OS_CALLS: &[&str] = &[
        "fs::read", "fs::write", "fs::create_dir", "fs::remove", "fs::copy",
        "fs::rename", "fs::metadata", "fs::read_dir", "fs::read_to_string",
        "File::create", "File::open", ".spawn()", ".output()",
        // Deliberately NOT ".status()": Command::status and HTTP resp.status()
        // read the same, and the HTTP one is everywhere. Spawn and output cover
        // the process side of the same journey.
        // The network calls, because the bug that started all of this was one
        // of these: reqwest renders its own source chain, and the leaf of that
        // chain on a refused localhost port is the operating system talking.
        ".send()", ".bytes()", ".chunk()",
        // The pipe calls. These are how we talk to the sidecars, and the
        // whisper server's stdin is where the German text came back a second
        // time: writing to a dead child fails with ERROR_NO_DATA, and the
        // three call sites rendered that straight into the red hint over the
        // microphone (B4 Gegenprobe 29.08.). The guard did not look at write
        // or flush, so nothing complained.
        ".write_all(", ".flush()", ".read_to_end(", ".read_to_string(",
        // Reaping a child. A15 (Windows Nachlauf 02.09.): the repair and the
        // git clone both polled their child and rendered the poll's own error
        // straight into the progress card.
        ".try_wait()", ".wait()",
    ];

    /// The other half of the same rule: the error is not mapped, it is MATCHED.
    ///
    /// A15, Windows Nachlauf 02.09.: the failure the box actually showed was
    /// `if let Err(e) = std::fs::remove_dir_all(&venv_dir)` followed by a
    /// `format!` that rendered `e`, and the guard above never looked at that
    /// shape because there is no `map_err` anywhere in it. Fourteen call sites
    /// in the installer alone were written that way.
    fn binds_the_error_in_a_match(line: &str) -> bool {
        line.contains("Err(e)")
            && (line.contains("{e}")
                || line.contains("{e:")
                || line.contains(", e)")
                || line.contains("e.to_string()")
                || line.trim_end().ends_with(", e"))
    }

    /// How many lines a single call may be spread over.
    ///
    /// The reqwest shape is the reason this is not 1. A request reads
    /// `.send()` / `.await` / `.map_err(...)` on three separate lines, which is
    /// exactly the call that showed a German message on the box, and a
    /// line-at-a-time check would have walked straight past it.
    const WINDOW: usize = 4;

    /// Rendering the error value itself into a message.
    fn renders_the_error(line: &str) -> bool {
        line.contains("map_err(|e|")
            && (line.contains("{e}") || line.contains(", e)") || line.contains("e.to_string()"))
    }

    /// A line with its trailing comment removed, so prose about the pattern is
    /// never mistaken for the pattern.
    fn strip_comment(line: &str) -> &str {
        match line.find("//") {
            Some(at) => &line[..at],
            None => line,
        }
    }

    fn is_suspect(text: &str) -> bool {
        let code = strip_comment(text);
        if code.contains("os_error::") {
            return false;
        }
        OS_CALLS.iter().any(|c| code.contains(c)) && renders_the_error(code)
    }

    /// How many lines the match shape may be spread over.
    ///
    /// Wider than `WINDOW` because a match arm puts the call, the arm, the
    /// `format!` and its arguments on separate lines. The winget arm in the
    /// installer runs to seven.
    const MATCH_WINDOW: usize = 8;

    fn is_suspect_match(text: &str) -> bool {
        let code = strip_comment(text);
        if code.contains("os_error::") {
            return false;
        }
        OS_CALLS.iter().any(|c| code.contains(c)) && binds_the_error_in_a_match(code)
    }

    /// The other shape: not a map_err at all, but an error FIELD in a payload
    /// built straight from the value. `start_ollama` answered a failed spawn
    /// with `json!({"status": "error", "error": e.to_string()})`, which the
    /// window scan above cannot see, because the spawn is in a match arm
    /// several lines up.
    fn is_suspect_field(line: &str) -> bool {
        let code = strip_comment(line);
        if code.contains("os_error::") {
            return false;
        }
        code.contains("\"error\"") && code.contains("e.to_string()")
    }

    fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("src is readable").flatten() {
            let path = entry.path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    #[test]
    fn no_call_site_hands_the_system_wording_to_the_frontend() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_files(&src, &mut files);
        assert!(files.len() > 10, "the file walk found almost nothing");

        let mut found = Vec::new();
        for file in &files {
            // This module's own tests talk about the shape on purpose.
            if file.ends_with("os_error.rs") {
                continue;
            }
            let text = std::fs::read_to_string(file).expect("readable");
            let lines: Vec<&str> = text.lines().collect();
            for i in 0..lines.len() {
                let end = (i + WINDOW).min(lines.len());
                // The call and its map_err may sit on different lines, so the
                // window is joined and judged as one statement. Anchored on the
                // OS call, so each offender is reported once, at the line the
                // fix belongs on.
                if !OS_CALLS.iter().any(|c| strip_comment(lines[i]).contains(c)) {
                    continue;
                }
                let joined: String = lines[i..end].iter().map(|l| strip_comment(l)).collect::<Vec<_>>().join(" ");
                if is_suspect(&joined) {
                    found.push(format!("{}:{}: {}", file.display(), i + 1, lines[i].trim()));
                    continue;
                }
                // The match shape, over its own wider window.
                let wide_end = (i + MATCH_WINDOW).min(lines.len());
                let wide: String = lines[i..wide_end]
                    .iter()
                    .map(|l| strip_comment(l))
                    .collect::<Vec<_>>()
                    .join(" ");
                if is_suspect_match(&wide) {
                    found.push(format!("{}:{}: {}", file.display(), i + 1, lines[i].trim()));
                }
            }
            for (i, line) in lines.iter().enumerate() {
                if is_suspect_field(line) {
                    found.push(format!("{}:{}: {}", file.display(), i + 1, line.trim()));
                }
            }
        }
        assert!(
            found.is_empty(),
            "these render the operating system's own wording into a message the user reads.\n\
             Windows answers FormatMessageW in the system language, so on a German machine this\n\
             is a German error in an English app. Wrap the value in os_error::english(&e).\n\n{}",
            found.join("\n")
        );
    }

    #[test]
    fn the_guard_would_actually_catch_one() {
        // A guard that matches nothing passes forever. These are the exact
        // shapes that were fixed, and the shapes that must keep failing.
        assert!(is_suspect(r#"fs::read(&p).map_err(|e| format!("Read error: {}", e))?;"#));
        assert!(is_suspect(r#"cmd.spawn().map_err(|e| format!("start failed: {e}"))?;"#));
        assert!(is_suspect(r#"std::fs::write(&p, b).map_err(|e| e.to_string())?;"#));
        // And the shapes that must not.
        assert!(!is_suspect(
            r#"fs::read(&p).map_err(|e| format!("Read error: {}", os_error::english(&e)))?;"#
        ));
        assert!(!is_suspect(r#"// fs::read(&p).map_err(|e| format!("x: {e}"))"#));
        // The multi-line reqwest shape, joined the way the scan joins it.
        assert!(is_suspect(r#".send() .await .map_err(|e| format!("proxy: {}", e))?"#));
        assert!(!is_suspect(
            r#".send() .await .map_err(|e| format!("proxy: {}", os_error::english(&e)))?"#
        ));
        assert!(!is_suspect(r#"let n = parse(s).map_err(|e| format!("bad number: {e}"))?;"#));
        // The payload shape, which no window around the failing call can reach.
        assert!(is_suspect_field(r#"json!({"status": "error", "error": e.to_string()})"#));
        assert!(!is_suspect_field(
            r#"json!({"status": "error", "error": os_error::english(&e)})"#
        ));
        assert!(!is_suspect_field(r#"json!({"error": "All search tiers failed"})"#));
        // The widened list: the three whisper pipe writes are the shape that
        // slipped past the guard, so they have to fail it now.
        assert!(is_suspect(r#"stdin.flush().map_err(|e| format!("stdin flush: {}", e))?;"#));
        assert!(is_suspect(r#"stdin.write_all(b"\n").map_err(|e| format!("stdin newline: {}", e))?;"#));
        assert!(!is_suspect(
            r#"stdin.flush().map_err(|e| format!("stdin flush: {}", os_error::english(&e)))?;"#
        ));
    }

    /// The match shape, from both sides. These are the exact statements the
    /// A15 round fixed, joined the way the scan joins them.
    #[test]
    fn the_guard_catches_an_error_that_is_matched_instead_of_mapped() {
        // The one the box showed: a German sentence in an English card.
        assert!(is_suspect_match(
            r#"if let Err(e) = std::fs::remove_dir_all(&venv_dir) { update( "error", &format!( "Could not remove the old venv at {}: {}. ...", venv_dir.display(), e"#
        ));
        assert!(is_suspect_match(
            r#"let mut child = match cmd.spawn() { Ok(c) => c, Err(e) => return Err(bare(&format!("Could not start pip ({}). Is Python on PATH?", e))), };"#
        ));
        assert!(is_suspect_match(
            r#"match child.try_wait() { Ok(Some(s)) => break s, Err(e) => return Err(format!("{label} wait failed: {e}")), }"#
        ));
        // And the shapes that must not fail it.
        assert!(!is_suspect_match(
            r#"if let Err(e) = std::fs::remove_dir_all(&venv_dir) { update("error", &venv_removal_error(&venv_dir, &e)); }"#
        ));
        assert!(!is_suspect_match(
            r#"match cmd.spawn() { Err(e) => println!("failed: {}", os_error::english(&e)), }"#
        ));
        // No OS call in the window: a parse error words itself.
        assert!(!is_suspect_match(
            r#"match s.parse::<u32>() { Ok(n) => n, Err(e) => return Err(format!("bad number: {e}")), }"#
        ));
        // An OS call whose error is never rendered.
        assert!(!is_suspect_match(
            r#"match cmd.spawn() { Ok(c) => c, Err(_) => return Err("could not start".to_string()), }"#
        ));
    }
}
