//! The newest published version, for the update hint of the open Android
//! package (the APK from GitHub has no store that would tell its users).
//!
//! One fixed address and nothing from the caller: no parameter, no cookie, no
//! account, no device data. GitHub's `releases/latest` leaves out drafts and
//! prereleases, and the phone checks both flags again (`lib/app-update.ts`).
//! In Rust and not in the WebView so the content security policy of the app
//! does not have to open for another host.

use std::time::Duration;

/// The official repository by its number: a phone package does not spell the
/// long product name (`app_identity.rs`), and the number survives a rename.
const LATEST_URL: &str = "https://api.github.com/repositories/1191052193/releases/latest";
/// A release with its notes is a few dozen KB.
const MAX_ANSWER_BYTES: usize = 2 * 1024 * 1024;

fn too_large(declared: Option<u64>) -> bool {
    declared.is_some_and(|n| n > MAX_ANSWER_BYTES as u64)
}

/// Only what the hint reads. The notes of the release do not reach the WebView.
fn slim(raw: &serde_json::Value) -> serde_json::Value {
    let assets: Vec<serde_json::Value> = raw["assets"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|a| serde_json::json!({ "name": a["name"], "digest": a["digest"], "url": a["browser_download_url"] }))
                .collect()
        })
        .unwrap_or_default();
    serde_json::json!({ "tag": raw["tag_name"], "draft": raw["draft"], "prerelease": raw["prerelease"], "assets": assets })
}

#[tauri::command]
pub async fn app_latest_release() -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        // GitHub refuses a call without a User-Agent. This one is the short name, without a version.
        .user_agent(crate::app_identity::PRODUCT_NAME)
        .build()
        .map_err(|_| "update check unavailable".to_string())?;
    let answer = client
        .get(LATEST_URL)
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "update check failed".to_string())?;
    if !answer.status().is_success() || too_large(answer.content_length()) {
        return Err("update check failed".to_string());
    }
    let bytes = answer.bytes().await.map_err(|_| "update check failed".to_string())?;
    if bytes.len() > MAX_ANSWER_BYTES {
        return Err("update check failed".to_string());
    }
    let raw: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "update check failed".to_string())?;
    Ok(slim(&raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_fields_of_the_hint_leave_this_file() {
        let v = slim(&serde_json::json!({
            "tag_name": "v3.1.3", "draft": false, "prerelease": false, "body": "the notes", "author": { "login": "x" },
            "assets": [{ "name": "LU-3.1.3-Android.apk", "digest": "sha256:ab", "browser_download_url": "https://github.com/a", "uploader": {} }],
        }));
        assert_eq!(v["tag"], "v3.1.3");
        assert!(v.get("body").is_none() && v.get("author").is_none());
        assert_eq!(v["assets"][0], serde_json::json!({ "name": "LU-3.1.3-Android.apk", "digest": "sha256:ab", "url": "https://github.com/a" }));
    }

    #[test]
    fn a_large_answer_is_refused_before_it_is_read() {
        assert!(too_large(Some(MAX_ANSWER_BYTES as u64 + 1)));
        assert!(!too_large(Some(1000)) && !too_large(None));
    }

    #[test]
    fn the_address_is_the_official_repository() {
        assert_eq!(LATEST_URL, "https://api.github.com/repositories/1191052193/releases/latest");
    }
}
