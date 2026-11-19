//! TEST-LOGIN (3.1.3): sign a TEST BUILD in to LU Cloud with the fixed test
//! account, without anyone typing a password into it.
//!
//! This whole file only exists in a build made with the Cargo feature
//! `test-login` (see lib.rs, `#[cfg(feature = "test-login")] mod test_login`).
//! No default feature turns it on, no release workflow passes it, and
//! scripts/check-no-test-login.sh fails a release whose binary or web bundle
//! carries [`MARKER`] (src/lib/__tests__/test-login-never-ships.test.ts checks
//! all three).
//!
//! The way in, and only this one:
//!  * the app is started with `--test-login-stdin`, and the one line on its
//!    standard input is a Supabase one-time `token_hash` (magic link). Not an
//!    argument (visible to `ps`), not an environment variable, not a file and
//!    not a deep link (the system hands those to whoever asks).
//!    scripts/testbau/test-login.sh fetches it from the admin API and pipes it
//!    straight in.
//!  * the page takes it once (`test_login_take`) and signs in only when the
//!    account behind it is on the allow list compiled into this build from
//!    `LU_TEST_LOGIN_ALLOW` (comma separated e-mail addresses). Without that
//!    variable the feature does not build at all, so no test build accepts
//!    an account nobody named.
//!
//! The token is never logged, printed or written anywhere by LU.

use std::io::Read;
use std::sync::Mutex;

/// The string the release check looks for. It must stay in this file (and in
/// src/lib/test-login.ts), so a build that carries the way in shows it.
pub const MARKER: &str = "LU-TEST-LOGIN-ENTRANCE";

/// The accounts this build lets in, set when the build was made.
const ALLOW: &str = env!(
    "LU_TEST_LOGIN_ALLOW",
    "the test-login feature needs LU_TEST_LOGIN_ALLOW (the test account's e-mail) at build time"
);

/// The argument that makes the app read the token from standard input.
pub const STDIN_ARG: &str = "--test-login-stdin";

static TOKEN: Mutex<Option<String>> = Mutex::new(None);

/// The e-mail addresses of [`ALLOW`], trimmed and lower case.
pub fn allow_list() -> Vec<String> {
    parse_allow(ALLOW)
}

pub fn parse_allow(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| s.contains('@'))
        .collect()
}

/// A token hash as Supabase hands it out: hex (or url safe base64), a sane
/// length. Anything else is dropped, so nothing odd reaches the page.
pub fn clean_token(line: &str) -> Option<String> {
    let t = line.trim();
    let ok = (16..=256).contains(&t.len()) && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then(|| t.to_string())
}

/// At start: with [`STDIN_ARG`] given, read one line (at most 1 KB) from
/// standard input and keep it for the page. Runs in a thread of its own, so a
/// start without input never waits.
pub fn read_token_if_asked() {
    if !std::env::args().any(|a| a == STDIN_ARG) {
        return;
    }
    std::thread::spawn(|| {
        let mut buf = Vec::with_capacity(512);
        let _ = std::io::stdin().lock().take(1024).read_to_end(&mut buf);
        let line = String::from_utf8_lossy(&buf);
        let first = line.lines().next().unwrap_or("");
        match clean_token(first) {
            Some(token) => {
                if let Ok(mut slot) = TOKEN.lock() {
                    *slot = Some(token);
                }
                tracing::info!("test-login: a token arrived on stdin");
            }
            None => tracing::warn!("test-login: stdin held no usable token"),
        }
    });
}

/// The page asks once after start. The token leaves the slot with the answer,
/// so a second call (or a reload) gets nothing.
#[tauri::command]
pub fn test_login_take() -> Option<serde_json::Value> {
    let token = TOKEN.lock().ok()?.take()?;
    Some(serde_json::json!({
        "tokenHash": token,
        "allow": allow_list(),
        "marker": MARKER,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_token_shaped_line_is_kept() {
        assert_eq!(clean_token("  0123456789abcdef0123456789abcdef\n").as_deref(), Some("0123456789abcdef0123456789abcdef"));
        for bad in ["", "short", "has space inside 0123456789", "https://x.supabase.co/auth/v1/verify?token=abc", &"a".repeat(300)] {
            assert_eq!(clean_token(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_allow_list_is_read_case_blind_and_skips_junk() {
        assert_eq!(parse_allow(" Test@example.com , ,nobody, b@example.com"), vec!["test@example.com", "b@example.com"]);
        assert!(!allow_list().is_empty(), "a test-login build names at least one account");
    }

    #[test]
    fn the_token_is_handed_out_once() {
        *TOKEN.lock().unwrap() = Some("0123456789abcdef0123456789abcdef".into());
        let first = test_login_take().expect("first take");
        assert_eq!(first["tokenHash"], "0123456789abcdef0123456789abcdef");
        assert_eq!(first["marker"], MARKER);
        assert!(test_login_take().is_none(), "a second take gets nothing");
    }
}
