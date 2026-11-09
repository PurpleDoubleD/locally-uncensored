//! Workflows aus dem Netz holen, für den Chat (C60-S5).
//!
//! `fetch_external` nimmt jede öffentliche https-Adresse. Der Chat-Weg ist
//! enger, und zwar hier in Rust, nicht nur im TypeScript:
//!
//! * Von sich aus sucht LU nur bei CivitAI, in der Comfy Registry und in den
//!   GitHub-Repos, die die Registry nennt (`api.github.com`,
//!   `raw.githubusercontent.com`). Jede andere Adresse wird abgelehnt.
//! * Eine Adresse, die der Nutzer selbst in seine Nachricht geschrieben hat
//!   (OpenArt und ähnliche), geht über `userLink = true`. Dann gilt nur die
//!   SSRF-Prüfung wie überall. Dass der Link wirklich in der Nachricht des
//!   Nutzers steht, prüft der Aufrufer (`workflow-tools.ts`).
//! * Höchstens 4 MiB, nur GET, nur https. Ein Workflow ist Daten: was hier
//!   ankommt, wird gelesen und geprüft, nie ausgeführt.
//!
//! Umleitungen folgt `ssrf_safe_fetch` und prüft jeden Sprung neu (CivitAI
//! liefert Dateien über ein CDN aus). Den CivitAI-Schlüssel bekommt nur ein
//! CivitAI-Host, wie bei jedem anderen Abruf.

use std::time::Duration;

use crate::os_error;

use super::proxy::{redact_url, ssrf_safe_fetch};

/// Größte Antwort, die der Chat-Weg liest. Ein Workflow selbst darf 2 MiB
/// haben (`workflow-inspect.ts`), ein ZIP von CivitAI etwas mehr, und eine
/// Suchantwort von CivitAI mit 10 Treffern liegt weit darunter.
pub(crate) const WORKFLOW_FETCH_MAX_BYTES: usize = 4 * 1024 * 1024;

/// Hosts, die LU ohne Link des Nutzers fragt.
const AUTO_HOSTS: &[&str] = &[
    "civitai.com",
    "civitai.red",
    "api.comfy.org",
    "api.github.com",
    "raw.githubusercontent.com",
];

/// Ob LU diese Adresse von sich aus abrufen darf (ohne Link des Nutzers).
pub(crate) fn auto_fetch_allowed(raw: &str) -> Result<(), String> {
    let url = url::Url::parse(raw).map_err(|_| "That is not a valid address.".to_string())?;
    if url.scheme() != "https" {
        return Err("Only https addresses are fetched.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("An address with a user name is not fetched.".into());
    }
    if url.port().is_some() {
        return Err("An address with its own port is not fetched.".into());
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if AUTO_HOSTS.contains(&host.as_str()) {
        Ok(())
    } else {
        Err(format!(
            "LU only searches CivitAI, the Comfy Registry and GitHub on its own, not {host}. A link from another site works when the user sends it."
        ))
    }
}

fn user_link_allowed(raw: &str) -> Result<(), String> {
    let url = url::Url::parse(raw).map_err(|_| "That is not a valid address.".to_string())?;
    if url.scheme() != "https" {
        return Err("Only https addresses are fetched.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("An address with a user name is not fetched.".into());
    }
    Ok(())
}

/// Einen Workflow, eine Suchantwort oder ein Workflow-ZIP holen.
#[allow(non_snake_case)]
#[tauri::command]
pub async fn workflow_fetch(
    url: String,
    userLink: Option<bool>,
    authToken: Option<String>,
) -> Result<Vec<u8>, String> {
    if userLink.unwrap_or(false) {
        user_link_allowed(&url)?;
    } else {
        auto_fetch_allowed(&url)?;
    }
    let bearer = authToken.as_deref().map(str::trim).filter(|t| !t.is_empty());
    let mut resp = ssrf_safe_fetch(&url, "workflow_fetch", Duration::from_secs(60), 5, bearer).await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status().as_u16(), redact_url(&url)));
    }
    if resp.content_length().is_some_and(|n| n > WORKFLOW_FETCH_MAX_BYTES as u64) {
        return Err(too_large(&url));
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(piece) = resp.chunk().await.map_err(|e| os_error::english(&e))? {
        if body.len() + piece.len() > WORKFLOW_FETCH_MAX_BYTES {
            return Err(too_large(&url));
        }
        body.extend_from_slice(&piece);
    }
    Ok(body)
}

fn too_large(url: &str) -> String {
    format!(
        "The answer from {} is larger than {} MB, so it was not read.",
        redact_url(url),
        WORKFLOW_FETCH_MAX_BYTES / (1024 * 1024)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn von_sich_aus_nur_die_festen_hosts() {
        for ok in [
            "https://civitai.com/api/v1/models?types=Workflows",
            "https://civitai.red/api/download/models/1",
            "https://api.comfy.org/nodes/search?search=wan",
            "https://api.github.com/repos/city96/ComfyUI-GGUF/contents/example_workflows",
            "https://raw.githubusercontent.com/a/b/main/x.json",
        ] {
            assert!(auto_fetch_allowed(ok).is_ok(), "{ok}");
        }
        for nein in [
            "https://openart.ai/workflows/x",
            "http://civitai.com/api/v1/models",
            "https://civitai.com.evil.example/x",
            "https://evil.civitai.com/x",
            "https://user:pw@civitai.com/x",
            "https://civitai.com:8443/x",
            "https://github.com/evil/repo",
            "file:///etc/passwd",
            "https://127.0.0.1/x",
            "nicht einmal eine adresse",
        ] {
            assert!(auto_fetch_allowed(nein).is_err(), "{nein}");
        }
    }

    #[test]
    fn nutzerlink_nur_https_ohne_nutzername() {
        assert!(user_link_allowed("https://openart.ai/workflows/abc").is_ok());
        assert!(user_link_allowed("http://openart.ai/workflows/abc").is_err());
        assert!(user_link_allowed("https://a:b@openart.ai/").is_err());
        assert!(user_link_allowed("ftp://x/y").is_err());
    }
}
