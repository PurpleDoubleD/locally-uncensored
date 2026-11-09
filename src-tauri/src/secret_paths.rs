//! Paths a remote agent never reads, lists, searches or runs a command on
//! (C59). The desktop agents meet the same list in `src/lib/secret-paths.ts`
//! at tool registration; the phone's tools run here in `remote.rs` and never
//! pass that registry, so the list lives twice. `secret_paths_parity` in the
//! TS tests holds the two against the same sample paths.
//!
//! Not a sandbox: a shell command can reach a file without naming it. This
//! catches what a model writes, which is the name.

fn segs(p: &str) -> Vec<&str> {
    p.split('/').filter(|s| !s.is_empty()).collect()
}

fn ends_with_any(p: &str, names: &[&str]) -> bool {
    let last = p.rsplit('/').next().unwrap_or("");
    names.contains(&last)
}

/// `~`, `$HOME`, `${HOME}`, `%USERPROFILE%`, backslashes, quotes, `file://`.
pub fn normalise(raw: &str) -> String {
    let mut p = raw.trim().trim_matches(|c| c == '"' || c == '\'').replace('\\', "/");
    if let Some(rest) = p.strip_prefix("file://") { p = rest.to_string(); }
    for pre in ["${HOME}", "$HOME", "%USERPROFILE%"] {
        if p.len() >= pre.len() && p[..pre.len()].eq_ignore_ascii_case(pre) {
            let rest = &p[pre.len()..];
            if rest.is_empty() || rest.starts_with('/') { p = format!("~{}", rest); }
            break;
        }
    }
    while p.contains("//") { p = p.replace("//", "/"); }
    p.to_lowercase()
}

/// Why `path` is off limits, or None.
pub fn reason(path: &str) -> Option<&'static str> {
    let p = normalise(path);
    if p.is_empty() { return None; }
    let s = segs(&p);
    let last = *s.last().unwrap_or(&"");
    let joined = format!("/{}", s.join("/"));
    if s.contains(&".ssh") { return Some("SSH keys"); }
    if joined.ends_with("/huggingface/token") || joined.ends_with("/.huggingface/token")
        || joined.ends_with("/.cache/huggingface/stored_tokens") { return Some("a Hugging Face access token"); }
    if s.contains(&".aws") { return Some("AWS credentials"); }
    if joined.contains("/.config/gcloud") { return Some("Google Cloud credentials"); }
    if s.contains(&".azure") { return Some("Azure credentials"); }
    if joined.ends_with("/.kube/config") { return Some("Kubernetes credentials"); }
    if ends_with_any(&p, &[".netrc", "_netrc", ".git-credentials", ".pgpass", ".npmrc", ".pypirc"]) { return Some("stored passwords or tokens"); }
    if joined.ends_with("/.docker/config.json") { return Some("Docker registry credentials"); }
    if joined.ends_with("/.config/gh/hosts.yml") || joined.ends_with("/.config/gh/hosts.yaml") { return Some("the GitHub CLI token"); }
    if s.contains(&".gnupg") { return Some("GPG keys"); }
    if joined.contains("/library/keychains") || last.ends_with(".keychain") || last.ends_with(".keychain-db") { return Some("the system keychain"); }
    for ext in [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".ppk"] {
        if last.ends_with(ext) { return Some("a private key or certificate store"); }
    }
    for k in ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"] {
        let base = last.trim_end_matches(".pub").trim_end_matches("_sk");
        if base == k { return Some("an SSH key"); }
    }
    if last == ".env" || (last.starts_with(".env.") && !matches!(&last[5..], "example" | "sample" | "template" | "dist" | "defaults")) {
        return Some("environment secrets (.env)");
    }
    if last == "secrets.json" || last == "secret.json" { return Some("stored API keys"); }
    if joined.starts_with("/volumes/") && s.get(1).map(|v| v.contains("credential")).unwrap_or(false) { return Some("a credentials volume"); }
    let browser_file = ["cookies", "login data", "web data", "logins.json", "key3.db", "key4.db", "cookies.sqlite"];
    if browser_file.iter().any(|f| last == *f || last == format!("{}-journal", f))
        || ["/library/application support/google/chrome", "/library/application support/bravesoftware",
            "/library/application support/microsoft edge", "/library/application support/firefox",
            "/library/application support/arc/user data", "/library/cookies"].iter().any(|d| joined.contains(d)) {
        return Some("browser cookies or saved logins");
    }
    None
}

fn words(command: &str) -> Vec<String> {
    command
        .split(|c: char| c.is_whitespace() || ";|&<>()`".contains(c))
        .flat_map(|w| w.split('=').map(|x| x.to_string()).collect::<Vec<_>>())
        .map(|w| w.trim_matches(|c| c == '"' || c == '\'').to_string())
        .filter(|w| w.len() > 1)
        .collect()
}

/// The first secret path a remote tool call names: path-like arguments, and
/// the words of a shell command or stdin script. Content to be written is not
/// looked at.
pub fn hit_in_args(args: &serde_json::Value) -> Option<(String, &'static str)> {
    let strs = |v: Option<&serde_json::Value>| -> Vec<String> {
        match v {
            Some(serde_json::Value::String(s)) => vec![s.clone()],
            Some(serde_json::Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect(),
            _ => vec![],
        }
    };
    for key in ["path", "paths", "cwd", "file", "files", "directory", "dir", "source", "destination", "target", "url", "args"] {
        for s in strs(args.get(key)) {
            if let Some(why) = reason(&s) { return Some((s, why)); }
        }
    }
    for key in ["command", "stdin", "script"] {
        for s in strs(args.get(key)) {
            for w in words(&s) {
                if let Some(why) = reason(&w) { return Some((w, why)); }
            }
        }
    }
    None
}

pub fn refusal(path: &str, why: &str) -> String {
    format!("Refused: {} holds {}. LU never lets an agent read, list, search or run commands on secret files, in any mode. Nothing was read.", path, why)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_paths_from_the_list_are_refused() {
        for p in [
            "~/.huggingface/token", "~/.cache/huggingface/token", "/Users/x/.ssh/id_ed25519", "$HOME/.aws/credentials",
            "~/.config/gcloud/application_default_credentials.json", "~/.netrc", "~/.git-credentials",
            "~/.docker/config.json", "~/Library/Keychains/login.keychain-db", "certs/server.pem", "deploy.key",
            "id_rsa", ".env", "app/.env.local", "secrets.json", "/Volumes/MyCredentials/x.txt",
            "~/Library/Application Support/Google/Chrome/Default/Cookies", "C:\\Users\\x\\.ssh\\config",
        ] {
            assert!(reason(p).is_some(), "{p} should be refused");
        }
    }

    #[test]
    fn ordinary_files_pass() {
        for p in ["notes.txt", "src/env.ts", ".env.example", "docs/keys.md", "README.md", "config.json", "src/secret_paths.rs"] {
            assert!(reason(p).is_none(), "{p} should pass");
        }
    }

    #[test]
    fn a_shell_command_naming_one_is_refused() {
        assert!(hit_in_args(&json!({ "command": "cat ~/.ssh/id_rsa" })).is_some());
        assert!(hit_in_args(&json!({ "command": "grep TOKEN \"$HOME/.aws/credentials\"" })).is_some());
        assert!(hit_in_args(&json!({ "command": "ls -la src" })).is_none());
        assert!(hit_in_args(&json!({ "path": "notes.txt", "content": "see .env" })).is_none());
    }
}
