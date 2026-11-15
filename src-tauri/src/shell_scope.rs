//! The remote agent's shell stays inside its folder (CA, 14.11.2026, AG10).
//!
//! Same rule as `src/lib/shell-scope.ts` on the desktop side: a command that
//! points at the home folder, the disk root or an absolute path outside the
//! agent's workspace is refused before it runs. The phone reaches the desktop
//! over the network, so there is no switch for it here: the remote agent
//! always stays in its folder.
//!
//! It reads the command, it does not sandbox the process. It stops what
//! models actually do, which is to type the path (a measured run went through
//! `find / -maxdepth 6`, `ls /Users/<name>` and ~/Library for 32 minutes).

use std::path::Path;

use regex::Regex;
use std::sync::OnceLock;

fn home_ref() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r#"(?i)(^|[\s=:"'(])~([/\s"')]|$)|\$\{?HOME\}?|%USERPROFILE%|%HOMEPATH%|%APPDATA%|%LOCALAPPDATA%|\$env:(USERPROFILE|HOME|APPDATA|LOCALAPPDATA)"#)
            .expect("home regex")
    })
}

fn words() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r#""([^"]*)"|'([^']*)'|([^\s;|&()<>]+)"#).expect("word regex"))
}

fn system_top() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"^/(Users|home|root|Volumes|mnt|media|etc|var|private|Library|System|Applications|opt|srv|proc|sys)(/|$)")
            .expect("system regex")
    })
}

fn always_fine(p: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"^/dev/(null|stdin|stdout|stderr|tty|zero|u?random)$|^/(private/)?tmp(/|$)|^/var/folders/|^/(usr/(local/)?|opt/homebrew/)?s?bin/|^/usr/bin/env$")
            .expect("fine regex")
    })
    .is_match(p)
}

fn is_abs(p: &str) -> bool {
    let b = p.as_bytes();
    p.starts_with('/') || p.starts_with("\\\\") || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\'))
}

fn path_in(word: &str) -> Option<String> {
    let w = word.trim_start_matches(|c: char| c.is_ascii_digit()).trim_start_matches('>').trim_start_matches('>');
    let v = match w.split_once('=') {
        Some((opt, val)) if opt.starts_with('-') => val,
        _ => w,
    };
    let has_dotdot = v.split(['/', '\\']).any(|seg| seg == "..");
    if is_abs(v) || has_dotdot { Some(v.to_string()) } else { None }
}

/// The first place `command` reaches outside `root`, as a sentence for the
/// model, or None. `cwd` is where relative paths start.
pub fn refusal(command: &str, root: &Path, cwd: &Path) -> Option<String> {
    let reach = reach_outside(command, root, cwd)?;
    Some(format!(
        "Refused: this command reaches {}. You work only inside your folder. Use paths inside the folder. If what you need is not there, stop searching and say so in your answer.",
        reach
    ))
}

fn reach_outside(command: &str, root: &Path, cwd: &Path) -> Option<String> {
    if home_ref().is_match(command) {
        return Some("the home folder".into());
    }
    for cap in words().captures_iter(command) {
        let (text, quoted) = match (cap.get(1), cap.get(2), cap.get(3)) {
            (Some(m), _, _) | (_, Some(m), _) => (m.as_str(), true),
            (_, _, Some(m)) => (m.as_str(), false),
            _ => continue,
        };
        let Some(p) = path_in(text) else { continue };
        let b = p.as_bytes();
        if p == "/" || (b.len() <= 3 && b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') {
            return Some("the whole disk".into());
        }
        if always_fine(&p) || p.contains("://") {
            continue;
        }
        if quoted && p.starts_with('/') && !system_top().is_match(&p) {
            continue;
        }
        let candidate = if is_abs(&p) { Path::new(&p).to_path_buf() } else { cwd.join(&p) };
        if crate::commands::filesystem::contain_within(root, &candidate).is_err() {
            return Some(format!("\"{}\", outside your folder", p));
        }
    }
    None
}

/// Python code for code_execute: the home folder and absolute system paths
/// typed into the code.
pub fn code_refusal(code: &str) -> Option<String> {
    static HOME: OnceLock<Regex> = OnceLock::new();
    static ABS: OnceLock<Regex> = OnceLock::new();
    let home = HOME.get_or_init(|| {
        Regex::new(r#"expanduser\(|Path\.home\(|os\.environ(\.get)?\(?\[?["']HOME["']|getenv\(["']HOME["']|\$\{?HOME\}?|["']~/"#).expect("code home")
    });
    let abs = ABS.get_or_init(|| Regex::new(r#"["'](/[^"'\n]*)["']"#).expect("code abs"));
    let what = if home.is_match(code) {
        Some("the home folder".to_string())
    } else {
        abs.captures_iter(code).find_map(|c| {
            let p = c.get(1)?.as_str();
            if p == "/" {
                Some("the whole disk".to_string())
            } else if system_top().is_match(p) && !always_fine(p) {
                Some(format!("\"{}\", outside your folder", p))
            } else {
                None
            }
        })
    }?;
    Some(format!(
        "Refused: this code reaches {}. You work only inside your folder. If what you need is not there, say so in your answer.",
        what
    ))
}

/// The remote shell's timeout: the model's wish, at most two minutes, a test
/// run five (the same budgets the desktop tool names). A command still running
/// then goes on as a background task, it is not killed.
pub const REMOTE_SHELL_TIMEOUT_MAX_MS: u64 = 120_000;
pub const REMOTE_TEST_TIMEOUT_MAX_MS: u64 = 300_000;

fn is_test_run(command: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(^|[\s;&|])((npm|pnpm|yarn|bun)\s+(run\s+)?test|npx\s+(vitest|jest|playwright)|vitest|jest|pytest|python3?\s+-m\s+(pytest|unittest)|cargo\s+test|go\s+test|node\s+--test)(\s|$)")
            .expect("test regex")
    })
    .is_match(command)
}

pub fn capped_timeout(requested: Option<u64>, command: &str) -> Option<u64> {
    let (default, cap) = if is_test_run(command) {
        (REMOTE_TEST_TIMEOUT_MAX_MS, REMOTE_TEST_TIMEOUT_MAX_MS)
    } else {
        (REMOTE_SHELL_TIMEOUT_MAX_MS, REMOTE_SHELL_TIMEOUT_MAX_MS)
    };
    Some(requested.unwrap_or(default).clamp(1_000, cap))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn ws() -> PathBuf {
        std::env::temp_dir().join("lu-scope-ws")
    }

    #[test]
    fn the_folder_itself_is_fine() {
        let r = ws();
        for c in ["ls", "find . -name '*.json'", "cat src/a.ts | grep x", "node --test 2>/dev/null", "grep -r \"/api/v1\" .", "/usr/bin/env python3 x.py"] {
            assert!(refusal(c, &r, &r).is_none(), "{c}");
        }
        let inside = format!("cat {}/notes.txt", r.display());
        assert!(refusal(&inside, &r, &r).is_none());
    }

    #[test]
    fn home_root_and_outside_are_refused() {
        let r = ws();
        for c in ["find / -maxdepth 6 -iname '*memor*'", "ls ~/Library", "grep -r x $HOME", "ls -la /Users/someone", "cat ../../.ssh/id_rsa", "cat \"/etc/hosts\"", "dir %USERPROFILE%"] {
            assert!(refusal(c, &r, &r).is_some(), "{c}");
        }
    }

    #[test]
    fn code_paths() {
        assert!(code_refusal("import os\nprint(os.path.expanduser('~'))").is_some());
        assert!(code_refusal("open('/etc/passwd').read()").is_some());
        assert!(code_refusal("open('data.json').read()").is_none());
        assert!(code_refusal("open('/tmp/x').write('a')").is_none());
    }

    #[test]
    fn timeout_is_capped() {
        assert_eq!(capped_timeout(Some(600_000), "find . -name x"), Some(120_000));
        assert_eq!(capped_timeout(None, "ls"), Some(120_000));
        assert_eq!(capped_timeout(Some(5_000), "ls"), Some(5_000));
        assert_eq!(capped_timeout(Some(900_000), "npm test"), Some(300_000));
        assert_eq!(capped_timeout(None, "cargo test --lib"), Some(300_000));
    }
}
