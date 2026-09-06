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
//! The words of the operating system are ours to answer for even when a
//! foreign process (pip, git, ComfyUI, the import probe) carried them to us:
//! the user reads them inside our window, and P3 read two of them in German on
//! his English app. What such a process wrote ITSELF stays untouched, down to
//! the byte. Only the sentence Windows handed it is exchanged, and the code
//! that names it rides along.

use std::borrow::Cow;
use std::io::ErrorKind;
use std::sync::OnceLock;

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

/// The Windows loader codes that reach a user through a child process, with
/// our own English for each.
///
/// Same doctrine as `code_phrase` above and deliberately just as short: these
/// are the codes that kill a torch import, a pip wheel or ComfyUI's `main.py`,
/// and nothing else. A code that is not here is left alone, sentence and all,
/// because inventing English for a code we have never seen would replace a
/// true foreign message with a false familiar one.
///
/// Not gated on `cfg(windows)`. Behind the mark `[WinError N]` the number is a
/// Windows code no matter which machine reads the line, and a Mac reading a
/// log from the box has the same right to English.
///
/// Every phrase is lower case, carries no sentence break, and fits inside
/// another sentence. The table test holds all three, and the second one is
/// load bearing: the structural rule in `english_child_line` ends the foreign
/// sentence at the first `". "` that is followed by a capital.
const WIN_CODES: &[(i32, &str)] = &[
    (2, "the file was not found"),
    (3, "the path was not found"),
    (5, "access is denied"),
    (87, "a parameter is incorrect"),
    (126, "the specified module could not be found"),
    (127, "the entry point was not found"),
    (193, "the file is not a valid Windows program (32 bit against 64 bit)"),
    (998, "invalid access to that memory location"),
    (1114, "a DLL initialization routine failed"),
];

/// Our English for one Windows code, or None for a code we do not name.
fn win_code_phrase(code: i32) -> Option<&'static str> {
    WIN_CODES.iter().find(|(c, _)| *c == code).map(|(_, p)| *p)
}

/// What THIS machine's Windows says for a code, normalised.
///
/// The trick `sanitize_os_wording` already uses, one step further: the app
/// runs on the same Windows as the child process, so
/// `from_raw_os_error(126).to_string()` is byte for byte what the child was
/// handed. Nothing is parsed and no language is assumed.
///
/// The normalising is not cosmetic. Rust strips line ends, CPython strips
/// trailing dots as well, and the import probe collapses every run of
/// whitespace (`env_check.rs`). Both sides are compared in the same collapsed,
/// dotless form or they never meet.
#[cfg(windows)]
fn os_sentence(code: i32) -> Option<String> {
    let raw = std::io::Error::from_raw_os_error(code).to_string();
    let body = match raw.rfind(" (os error ") {
        Some(at) => &raw[..at],
        None => raw.as_str(),
    };
    let collapsed = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_end_matches('.').trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Off Windows there is no such sentence to ask for, and guessing one would be
/// the translation table this module exists to avoid.
#[cfg(not(windows))]
fn os_sentence(_code: i32) -> Option<String> {
    None
}

/// The sentences this machine would have written, built once per process.
///
/// Without the cache this is one `FormatMessageW` per table entry per line,
/// and the readers this runs in carry tens of thousands of pip lines.
fn win_sentence(code: i32) -> Option<String> {
    static TABLE: OnceLock<Vec<(i32, String)>> = OnceLock::new();
    let table = TABLE
        .get_or_init(|| WIN_CODES.iter().filter_map(|&(c, _)| os_sentence(c).map(|s| (c, s))).collect());
    table.iter().find(|(c, _)| *c == code).map(|(_, s)| s.clone())
}

/// The end of the first sentence in `s`: the index of a `.` that is followed by
/// a space and a capital.
///
/// Byte-wise on purpose and safe: only ASCII bytes are compared, and no
/// continuation byte of a multi-byte character can equal one of them, so the
/// index that comes back is always a character boundary.
fn sentence_end(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    (0..b.len().saturating_sub(2))
        .find(|&i| b[i] == b'.' && b[i + 1] == b' ' && b[i + 2].is_ascii_uppercase())
}

/// One line of a child process's output, with the operating system's own
/// sentence replaced by ours and everything the process wrote left alone.
///
/// P3 on a German Windows saw two shapes, and only the first carries a number:
///
/// * `OSError: [WinError 126] Das angegebene Modul wurde nicht gefunden. Error
///   loading "...\c10_cuda.dll" or one of its dependencies.`
/// * `ImportError: DLL load failed while importing _core: Das angegebene Modul
///   wurde nicht gefunden.`
///
/// So there are two passes. The first is anchored on the mark `[WinError N]`
/// and ends the foreign sentence structurally, at the first `". "` before a
/// capital, which is why it works on any host and in a unit test on a Mac.
/// `lookup` is only the shortcut there: when this machine can name the exact
/// sentence, exactly that many bytes are exchanged. The second pass is for the
/// line without a number; it can only ask the machine, and it ADDS the code
/// the text never had.
///
/// `lookup` is a parameter so a test can pretend to be a German Windows.
/// Nothing else in the line is touched, and a line with nothing to fix comes
/// back borrowed and unallocated.
pub fn english_child_line<'a>(line: &'a str, lookup: impl Fn(i32) -> Option<String>) -> Cow<'a, str> {
    let after_mark = replace_marked_sentences(line, &lookup);
    replace_bare_sentences(after_mark, &lookup)
}

/// Pass one: `[WinError N] <sentence the OS wrote>`.
fn replace_marked_sentences<'a>(line: &'a str, lookup: &impl Fn(i32) -> Option<String>) -> Cow<'a, str> {
    const MARK: &str = "[WinError ";
    if !line.contains(MARK) {
        return Cow::Borrowed(line);
    }
    let mut out = String::new();
    // How much of `line` has been copied into `out`, and where to look next.
    let mut copied = 0usize;
    let mut search = 0usize;
    while let Some(rel) = line[search..].find(MARK) {
        let at = search + rel;
        let num_start = at + MARK.len();
        let num_end = num_start
            + line[num_start..]
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(line.len() - num_start);
        search = num_end;
        if num_end == num_start || !line[num_end..].starts_with(']') {
            continue;
        }
        let Ok(code) = line[num_start..num_end].parse::<i32>() else {
            continue;
        };
        // A code we do not name keeps its own sentence: see WIN_CODES.
        let Some(phrase) = win_code_phrase(code) else {
            continue;
        };
        let mut body = num_end + 1;
        if line[body..].starts_with(' ') {
            body += 1;
        }
        // The shortcut: this machine knows the exact sentence, so exactly it
        // goes. Covers a system sentence that carries a full stop of its own,
        // which the structural rule below would cut short.
        let named = lookup(code).filter(|s| line[body..].starts_with(s.as_str()));
        let mut stop = match &named {
            Some(s) => body + s.len(),
            None => sentence_end(&line[body..]).map(|i| body + i).unwrap_or(line.len()),
        };
        // The full stop stays with the line, so a sentence that ends the line
        // does not lose it and one that does not never gains it.
        while stop > body && matches!(line.as_bytes()[stop - 1], b'.' | b' ') {
            stop -= 1;
        }
        if stop <= body {
            continue;
        }
        // Already our words: an English Windows writes this sentence itself,
        // and rewriting it would only change its capital letter.
        if line[body..stop].eq_ignore_ascii_case(phrase) {
            continue;
        }
        out.push_str(&line[copied..body]);
        out.push_str(phrase);
        copied = stop;
        search = stop;
    }
    if copied == 0 {
        return Cow::Borrowed(line);
    }
    out.push_str(&line[copied..]);
    Cow::Owned(out)
}

/// Pass two: the sentence without a number anywhere near it.
fn replace_bare_sentences<'a>(text: Cow<'a, str>, lookup: &impl Fn(i32) -> Option<String>) -> Cow<'a, str> {
    let mut out = text;
    for &(code, phrase) in WIN_CODES {
        let Some(sentence) = lookup(code) else {
            continue;
        };
        let sentence = sentence.trim();
        // This machine already speaks our words, so there is nothing to
        // exchange and appending the code would only make the line longer.
        if sentence.is_empty() || sentence.eq_ignore_ascii_case(phrase) {
            continue;
        }
        if !out.contains(sentence) {
            continue;
        }
        // The number is what the text was missing, and it is what anyone
        // searches for.
        let ours = format!("{phrase} (Windows error {code})");
        out = Cow::Owned(out.replace(sentence, &ours));
    }
    out
}

/// The production entry: one line of foreign output, in our words.
///
/// Both marks in one pass through, so a line that carries a `[WinError N]` and
/// an `(os error N)` comes out whole.
pub fn english_child_text(text: &str) -> Cow<'_, str> {
    match english_child_line(text, win_sentence) {
        Cow::Borrowed(s) => sanitize_os_wording(s),
        Cow::Owned(s) => Cow::Owned(sanitize_os_wording(&s).into_owned()),
    }
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
        // What the three call sites used to write was `format!("stdin flush: {e}")`
        // — the error's own Display, which on a German Windows is "Die Pipe wird
        // gerade geschlossen.". That used to be bound to a `before` variable and
        // then never read; `e.to_string()` in the last assertion is the same
        // string, so the binding is gone rather than renamed to `_before`.
        //
        // What they write now.
        let after = format!("stdin flush: {}", io_english(&e));
        assert_eq!(after, "stdin flush: the pipe is closing (os error 232)");
        // On a German box the old wording is German; here it is only "Unknown error",
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

    // ── Die Saetze, die ein fremder Prozess weitergereicht hat ──────────────
    //
    // P3 auf einem deutschen Windows, Punkt 7.2 und 7.3. Beide Zeilen stehen
    // hier woertlich, und die Attrappe spielt die Maschine: so laeuft der
    // Beweis auf dem Mac genauso wie auf der Box.

    /// Was ein deutsches Windows fuer ERROR_MOD_NOT_FOUND schreibt, in der
    /// Form, in der `os_sentence` ihn zurueckgibt: ohne Schlusspunkt.
    const GERMAN_126: &str = "Das angegebene Modul wurde nicht gefunden";

    fn german_windows(code: i32) -> Option<String> {
        (code == 126).then(|| GERMAN_126.to_string())
    }

    /// Eine Maschine, die keinen dieser Saetze kennt: jeder Mac, jedes Linux,
    /// und jeder Leser eines Protokolls von einer fremden Box.
    fn machine_knows_nothing(_code: i32) -> Option<String> {
        None
    }

    #[test]
    fn the_line_from_7_2_loses_the_system_wording_and_keeps_everything_else() {
        let line = r#"OSError: [WinError 126] Das angegebene Modul wurde nicht gefunden. Error loading "C:\Users\ddrob\ComfyUI\venv\Lib\site-packages\torch\lib\c10_cuda.dll" or one of its dependencies."#;
        // Ohne Lookup, also ueber die Strukturregel allein. Das ist der Punkt:
        // der Fall MIT Nummer haengt nicht daran, dass diese Maschine deutsch
        // spricht.
        let out = english_child_line(line, machine_knows_nothing);
        assert!(out.contains("[WinError 126]"), "die Marke ist weg: {out}");
        assert!(out.contains("the specified module could not be found"), "got: {out}");
        assert!(!out.contains("Das angegebene Modul"), "der Systemsatz lebt noch: {out}");
        // Was torch selbst geschrieben hat, bleibt Wort fuer Wort stehen.
        assert!(
            out.contains(r#"Error loading "C:\Users\ddrob\ComfyUI\venv\Lib\site-packages\torch\lib\c10_cuda.dll" or one of its dependencies."#),
            "got: {out}"
        );
    }

    #[test]
    fn the_machines_own_sentence_wins_over_the_structural_rule() {
        // Wofuer der Lookup in Durchgang 1 ueberhaupt noch gut ist: ein
        // Systemsatz, der selbst aus zwei Saetzen besteht. Die Strukturregel
        // wuerde am ersten Punkt abschneiden und die zweite Haelfte deutsch
        // stehen lassen; die Maschine kennt die genaue Laenge.
        //
        // Nebenbei die Normalisierung: der Lookup liefert punktlos, das Kind
        // hat mit Punkt gedruckt, und der Punkt gehoert der Zeile.
        const TWO_SENTENCES: &str = "Modul fehlt. Bitte neu installieren";
        let line = format!(r#"OSError: [WinError 126] {TWO_SENTENCES}. Error loading "c10.dll"."#);
        let out = english_child_line(&line, |c| (c == 126).then(|| TWO_SENTENCES.to_string()));
        assert_eq!(
            out,
            r#"OSError: [WinError 126] the specified module could not be found. Error loading "c10.dll"."#
        );
    }

    #[test]
    fn the_line_from_7_3_gains_the_number_it_never_had() {
        // Kein "[WinError N]" im Text: hier kann nur die Maschine helfen, und
        // die Nummer kommt hinzu statt verloren zu gehen.
        let line = format!("ImportError: DLL load failed while importing _core: {GERMAN_126}");
        let out = english_child_line(&line, german_windows);
        assert_eq!(
            out,
            "ImportError: DLL load failed while importing _core: the specified module could not be found (Windows error 126)"
        );
    }

    #[test]
    fn a_french_windows_needs_no_second_table() {
        // Die Probe gegen eine Wortliste: dasselbe Verfahren, eine Sprache,
        // die in diesem Baum nirgends vorkommt. Wer hier durchfaellt, hat eine
        // deutsche Wortliste gebaut statt eines Verfahrens.
        const FRENCH: &str = "Le module specifie est introuvable";
        let line = format!("ImportError: DLL load failed while importing _core: {FRENCH}");
        let out = english_child_line(&line, |c| (c == 126).then(|| FRENCH.to_string()));
        assert!(out.contains("the specified module could not be found (Windows error 126)"), "got: {out}");
        assert!(!out.contains(FRENCH), "got: {out}");
    }

    #[test]
    fn an_english_windows_line_is_not_reworded_into_a_lower_case_one() {
        // Auf einem englischen Windows sagen Tabelle und Maschine dasselbe,
        // nur mit grossem Anfangsbuchstaben. Wenn hier etwas Sichtbares
        // passiert, ist die Normalisierung falsch gebaut.
        let line = "OSError: [WinError 126] The specified module could not be found.";
        let out = english_child_line(line, |c| {
            (c == 126).then(|| "The specified module could not be found".to_string())
        });
        assert_eq!(out, line);
        assert!(matches!(out, Cow::Borrowed(_)), "allocated for an English line");
    }

    #[test]
    fn a_line_the_operating_system_never_wrote_comes_back_untouched() {
        for line in [
            // Eine gewoehnliche ComfyUI-Startzeile.
            "Total VRAM 12288 MB, total RAM 32601 MB",
            "Collecting torch==2.6.0",
            // 9c: Umlaute und japanische Zeichen im Pfad sind bestanden und
            // duerfen es bleiben. Eine ASCII-Wache haette genau das kaputt
            // getestet.
            r#"  File "C:\lu-nightshift\Übung 日本語 äöüß\ComfyUI\venv\Lib\site-packages\torch\__init__.py", line 309, in <module>"#,
            // Das Wort ohne die Klammer ist keine Marke.
            "WinError is just a word here",
            // Ein Code, den die Tabelle nicht kennt, behaelt seinen Satz.
            "OSError: [WinError 4711] Ein unbekannter Code behaelt seinen Satz.",
        ] {
            let out = english_child_line(line, german_windows);
            assert_eq!(out, line);
            assert!(matches!(out, Cow::Borrowed(_)), "allocated for: {line}");
        }
    }

    #[test]
    fn the_old_sanitiser_cannot_do_any_of_this() {
        // Die rote Gegenprobe zu den drei Faellen oben: `sanitize_os_wording`
        // kennt nur die Marke "(os error N)" und laesst alle drei unveraendert.
        // Sie bleibt trotzdem, `main.rs` braucht sie; dieser Test haelt fest,
        // dass die neue Funktion etwas kann, was die alte nicht kann, und
        // schuetzt gegen ein spaeteres Zusammenlegen.
        for line in [
            format!("OSError: [WinError 126] {GERMAN_126}. Error loading \"c10.dll\"."),
            format!("ImportError: DLL load failed while importing _core: {GERMAN_126}"),
            format!("[WinError 5] {GERMAN_126}"),
        ] {
            let out = sanitize_os_wording(&line);
            assert_eq!(out, line);
            assert!(matches!(out, Cow::Borrowed(_)), "allocated for: {line}");
        }
    }

    #[test]
    fn every_windows_phrase_is_a_sentence_part_and_carries_no_sentence_break() {
        for &(code, phrase) in WIN_CODES {
            assert!(!phrase.is_empty(), "code {code} has no phrase");
            assert!(
                phrase.chars().next().unwrap().is_lowercase(),
                "code {code} is capitalised and would read wrong inside a sentence"
            );
            // Die tragende Zusicherung: die Strukturregel in Durchgang 1
            // beendet den fremden Satz am ersten ". " vor einem Grossbuchstaben.
            // Ein Eintrag mit zwei Saetzen wuerde sie stumm brechen.
            assert!(sentence_end(phrase).is_none(), "code {code} carries a sentence break");
        }
        // Dieselbe Zusicherung fuer die Saetze DIESER Maschine, soweit es
        // welche gibt. Gross geschrieben sind sie mit Recht, deshalb nur die
        // Form, nicht der Anfangsbuchstabe.
        #[cfg(windows)]
        for &(code, _) in WIN_CODES {
            if let Some(s) = os_sentence(code) {
                assert!(!s.is_empty(), "code {code} normalised to nothing");
                assert!(!s.ends_with('.'), "code {code} kept its full stop");
                assert!(!s.contains("  "), "code {code} kept a double space");
            }
        }
    }

    #[test]
    fn both_marks_in_one_line_are_repaired_together() {
        // `english_child_text` ist der Produktionsweg und schickt die Zeile
        // durch beide Tore, damit eine Zeile mit beiden Marken ganz wird.
        let os_worded = Error::from_raw_os_error(REFUSED).to_string();
        let line = format!("[WinError 126] Das angegebene Modul wurde nicht gefunden. Then: {os_worded}");
        let out = english_child_text(&line);
        assert!(out.contains("the specified module could not be found"), "got: {out}");
        assert!(out.contains("connection refused"), "got: {out}");
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
        // Asking the platform where our own folders are. In tauri 2.10 this
        // fails with `Error::UnknownPath`, which carries no io::Error and is
        // English already, so today the guard changes nothing here. It is in
        // the list because the call is a platform lookup: the day a tauri
        // release words it from the OS, or wraps one, the Piper voices lookup
        // would have carried it raw again (A15 review).
        ".app_data_dir()",
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

    /// The fourth shape: a reader of a CHILD's output that puts the line into
    /// a sink the user reads.
    ///
    /// This is the shape that produced P3's finding, and none of the three
    /// above can see it: there is no `map_err`, no match arm and no payload
    /// field anywhere in it. The error was never a Rust value here. Python
    /// caught it, worded it in the system language and printed it, and the
    /// reader carried the line into the progress card, the ring buffer or the
    /// installer log.
    ///
    /// `BufReader::new` is required alongside `.lines()` on purpose: `.lines()`
    /// on a `String` is everywhere in this tree (parsing nvidia-smi, os-release,
    /// a manifest) and none of it is a pipe.
    /// `(line,` and `(line)` are the delegated sink: `process.rs` hands the
    /// line to a `capture` closure that owns both the log and the buffer.
    /// `println!("... {}", line)` does not read that way, which is what keeps
    /// the log-only readers green.
    const READER_SINKS: &[&str] = &[
        "push(", "push_str(", "push_back(", "push_install_log", ".log(", ".send(", "(line,", "(line)",
    ];

    /// How far a reader may be from its sink. The trainer's loop counts steps
    /// first and pushes twelve lines further down.
    const READER_WINDOW: usize = 14;

    /// How far back the pipe that feeds the loop may sit.
    const READER_LOOKBACK: usize = 3;

    /// Reader windows that carry no operating system wording, with the reason.
    ///
    /// A bare file name would be too broad, so the second field names the line
    /// that makes this reader different: the next reader in the same file has
    /// to pass the guard on its own. The third is what the FILE must still
    /// contain for the excuse to hold, so an exception cannot outlive the
    /// reason for it. Empty means no further condition.
    const READER_EXCEPTIONS: &[(&str, &str, &str)] = &[
        // whisper_server.py speaks JSON on stdout, and this reader forwards the
        // PARSED value rather than the line. A localised sentence cannot
        // survive `from_str`, and what does survive is our own protocol.
        ("whisper.rs", "serde_json::from_str::<serde_json::Value>(trimmed)", ""),
        // Both ComfyUI readers hand their line to one `capture` closure, which
        // is where the split lives: the log keeps what the OS wrote, the ring
        // buffer the user reads gets our words. The closure sits above the
        // loops and out of any window, so the third field checks it instead.
        // Take the rewrite out of it and both readers fail this guard again.
        (
            "process.rs",
            "capture(line, &sink)",
            "buf.push_back(os_error::english_child_text(&line).into_owned())",
        ),
    ];

    fn is_suspect_reader(window: &str) -> bool {
        if !window.contains(".lines()") || !window.contains("BufReader::new") {
            return false;
        }
        if window.contains("english_child") {
            return false;
        }
        READER_SINKS.iter().any(|s| window.contains(s))
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
        let mut readers = Vec::new();
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
            // The reader shape, anchored on the line that opens the pipe.
            for i in 0..lines.len() {
                if !strip_comment(lines[i]).contains(".lines()") {
                    continue;
                }
                // The window stops at the NEXT reader, not only at the
                // budget. Otherwise a repaired stdout reader vouches for the
                // raw stderr reader six lines below it, which is exactly how
                // the two halves of `run_streamed` sit in `video.rs`. And it
                // counts CODE lines: a comment block above the sink would
                // otherwise push the sink out of the window, which is how the
                // pip reader hid from a first version of this guard.
                let mut window = String::new();
                let mut code_lines = 0usize;
                for line in lines.iter().skip(i + 1) {
                    let code = strip_comment(line);
                    if code.contains(".lines()") {
                        break;
                    }
                    if code.trim().is_empty() {
                        continue;
                    }
                    window.push(' ');
                    window.push_str(code);
                    code_lines += 1;
                    if code_lines >= READER_WINDOW {
                        break;
                    }
                }
                // And a short run BACKWARDS, because `let reader =
                // BufReader::new(stderr);` usually sits on the line above the
                // loop, and without it half the readers in this tree read as
                // an ordinary `str::lines()`. It stops at the previous reader
                // for the same reason the forward run stops at the next one.
                let mut before = String::new();
                let mut back = 0usize;
                for line in lines[..i].iter().rev() {
                    let code = strip_comment(line);
                    if code.contains(".lines()") {
                        break;
                    }
                    if code.trim().is_empty() {
                        continue;
                    }
                    before.push(' ');
                    before.push_str(code);
                    back += 1;
                    if back >= READER_LOOKBACK {
                        break;
                    }
                }
                let window = format!("{} {} {}", before, strip_comment(lines[i]), window);
                let excused = READER_EXCEPTIONS.iter().any(|(f, needle, proof)| {
                    file.to_string_lossy().ends_with(f)
                        && window.contains(needle)
                        && text.contains(proof)
                });
                if !excused && is_suspect_reader(&window) {
                    readers.push(format!("{}:{}: {}", file.display(), i + 1, lines[i].trim()));
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
        assert!(
            readers.is_empty(),
            "these carry a child process's output into a message the user reads, unfiltered.\n\
             Python and pip word an OSError in the system language, so on a German Windows this\n\
             is a German sentence in an English app (P3, 7.2 and 7.3). Send the line through\n\
             os_error::english_child_text(&line) first, or name it in READER_EXCEPTIONS.\n\n{}",
            readers.join("\n")
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

    /// The reader shape, from both sides. The negative half is not optional:
    /// a guard that also stops a reader which only logs or only counts gets
    /// weakened the first time it stands in someone's way.
    #[test]
    fn the_guard_would_actually_catch_a_reader() {
        // Die vier Formen, die es in diesem Baum wirklich gibt.
        assert!(is_suspect_reader(
            r#"let reader = BufReader::new(stdout); for line in reader.lines().map_while(Result::ok) { if let Ok(mut s) = st.lock() { s.logs.push(line); } }"#
        ));
        assert!(is_suspect_reader(
            r#"for line in BufReader::new(s).lines().map_while(Result::ok) { so.log(line); }"#
        ));
        assert!(is_suspect_reader(
            r#"let reader = BufReader::new(stdout); for line in reader.lines().map_while(Result::ok) { capture(line, &sink); }"#
        ));
        assert!(is_suspect_reader(
            r#"for line in BufReader::new(stdout).lines().map_while(Result::ok) { buf.push_back(line); }"#
        ));
        // Und die, die durchgehen muessen.
        assert!(!is_suspect_reader(
            r#"for line in BufReader::new(s).lines().map_while(Result::ok) { so.log(os_error::english_child_text(&line).into_owned()); }"#
        ));
        // Nur ins Protokoll: das ist die ausdrueckliche Regel, die Zeile des
        // Betriebssystems bleibt dort in ihrer eigenen Sprache stehen.
        assert!(!is_suspect_reader(
            r#"let reader = BufReader::new(stderr); for line in reader.lines().map_while(Result::ok) { println!("[ComfyUI] {}", line); }"#
        ));
        // Nur zaehlen.
        assert!(!is_suspect_reader(
            r#"for _line in BufReader::new(stdout).lines().map_while(Result::ok) { seen += 1; }"#
        ));
        // Eine Zeichenkette im Speicher ist keine Rohrleitung: nvidia-smi,
        // os-release und jeder Katalog werden so gelesen.
        assert!(!is_suspect_reader(r#"for line in text.lines() { out.push(line.to_string()); }"#));
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
