//! The key the LU Engine answers to.
//!
//! Found in the security pass of 2026-10-13: llama-server has no login, and it
//! writes the origin of every request back into `Access-Control-Allow-Origin`.
//! So any web page open in the user's browser could talk to the engine on
//! 127.0.0.1: read its state, read what sits in its slots and run the model.
//! Reproduced on the Mac build of the same server.
//!
//! The fix is the server's own lock. Every engine LU starts (chat and
//! embeddings) gets one key, made fresh when the app starts and handed over in
//! the environment (`LLAMA_API_KEY`), never on the command line where every
//! program of the user can read it. The web view never learns it: everything
//! that talks to the engine goes through the Rust side, and the Rust side puts
//! the key on exactly the requests that go to a port an LU engine holds.
//!
//! Health checks (`/health`, `/v1/health`) remain public. Model discovery
//! (`/models`, `/v1/models`) requires the same key as inference requests.

use std::sync::OnceLock;

/// The environment variable llama-server reads its key from (`--api-key`).
pub const KEY_ENV: &str = "LLAMA_API_KEY";

/// The key of this app run. Made once, the same for every engine started in
/// this run, gone when the app ends.
pub fn engine_key() -> &'static str {
    static KEY: OnceLock<String> = OnceLock::new();
    KEY.get_or_init(super::local_api::generate_token)
}

/// Puts the key into the environment of an engine about to start.
pub fn apply(cmd: &mut std::process::Command) {
    cmd.env(KEY_ENV, engine_key());
}

/// The ports the LU engines of this app run hold right now.
pub fn engine_ports(state: &crate::state::AppState) -> Vec<u16> {
    let mut ports = Vec::new();
    for slot in [&state.bundled_engine, &state.bundled_embed] {
        if let Ok(guard) = slot.lock() {
            if let Some(engine) = guard.as_ref() {
                ports.push(engine.port);
            }
        }
    }
    ports
}

/// Does a request to `url` go to one of the LU engines? Only a loopback
/// address on one of their ports counts: the key never leaves this machine,
/// and a foreign server on another port never sees it.
pub fn goes_to_engine(url: &str, ports: &[u16]) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else { return false };
    if parsed.scheme() != "http" {
        return false;
    }
    let loopback = match parsed.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    loopback && parsed.port_or_known_default().is_some_and(|p| ports.contains(&p))
}

/// The `Authorization` value for a request to an LU engine.
pub fn bearer() -> String {
    format!("Bearer {}", engine_key())
}

/// Adds the key to a request that goes to an LU engine, and leaves any other
/// request as it was.
pub fn authorize(
    request: reqwest::RequestBuilder,
    url: &str,
    ports: &[u16],
) -> reqwest::RequestBuilder {
    if goes_to_engine(url, ports) {
        request.header(reqwest::header::AUTHORIZATION, bearer())
    } else {
        request
    }
}

/// The same for the blocking client (engine.rs talks to its own process
/// from blocking threads).
pub fn authorize_blocking(request: reqwest::blocking::RequestBuilder) -> reqwest::blocking::RequestBuilder {
    request.header(reqwest::header::AUTHORIZATION, bearer())
}

/// The key for the one caller outside the Rust side that talks to the engine
/// itself: the voice service (a Python process the web view hands its model
/// settings to). Only for an address that is an LU engine of this run, so the
/// web view cannot fish the key out for anything else.
#[tauri::command]
pub fn engine_key_for(url: String, state: tauri::State<'_, crate::state::AppState>) -> Option<String> {
    goes_to_engine(&url, &engine_ports(&state)).then(|| engine_key().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_is_long_and_stays_the_same_for_the_run() {
        assert_eq!(engine_key().len(), 64);
        assert_eq!(engine_key(), engine_key());
    }

    #[test]
    fn the_key_goes_into_the_environment_and_not_onto_the_command_line() {
        let mut cmd = std::process::Command::new("llama-server");
        cmd.args(["--port", "8127"]);
        apply(&mut cmd);
        assert!(cmd.get_envs().any(|(k, v)| k == KEY_ENV && v == Some(std::ffi::OsStr::new(engine_key()))));
        assert!(!cmd.get_args().any(|a| a.to_string_lossy().contains(engine_key())));
    }

    #[test]
    fn only_a_loopback_address_on_an_engine_port_gets_the_key() {
        let ports = [8127, 8128];
        for yes in [
            "http://127.0.0.1:8127/v1/chat/completions",
            "http://localhost:8127/v1/models",
            "http://LOCALHOST:8128/v1/embeddings",
            "http://[::1]:8127/slots",
            "http://127.0.0.2:8127/props",
        ] {
            assert!(goes_to_engine(yes, &ports), "{yes}");
        }
        for no in [
            "http://127.0.0.1:11434/api/chat",
            "http://127.0.0.1:1234/v1/models",
            "http://192.168.1.20:8127/v1/chat/completions",
            "http://box.local:8127/v1/chat/completions",
            "https://127.0.0.1:8127/v1/chat/completions",
            "http://evil.example/?u=http://127.0.0.1:8127/",
            "not a url",
        ] {
            assert!(!goes_to_engine(no, &ports), "{no}");
        }
        assert!(!goes_to_engine("http://127.0.0.1:8127/v1/models", &[]));
    }

    #[test]
    fn a_request_to_the_engine_carries_the_key_and_any_other_does_not() {
        let client = reqwest::Client::new();
        let ports = [8127];
        let to_engine = authorize(client.get("http://127.0.0.1:8127/slots"), "http://127.0.0.1:8127/slots", &ports)
            .build()
            .unwrap();
        assert_eq!(to_engine.headers()[reqwest::header::AUTHORIZATION], bearer().as_str());
        let elsewhere = authorize(client.get("http://127.0.0.1:11434/api/tags"), "http://127.0.0.1:11434/api/tags", &ports)
            .build()
            .unwrap();
        assert!(elsewhere.headers().get(reqwest::header::AUTHORIZATION).is_none());
    }
}
