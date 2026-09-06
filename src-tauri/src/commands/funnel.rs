//! One anonymous counter for the Cloud switch (David, 06.09.2026): how many
//! presses open the gate, arm the switch, enter Cloud or go back to Local,
//! per day, platform and app version. Nothing else leaves the machine: no
//! identifier, no prompt, no IP kept (the table holds daily counts). The
//! frontend can only pass an event name from the allowlist below; platform
//! and version are read here, not trusted from the caller. The press that
//! reaches for the cloud is the one thing local mode reports, and that is
//! written into Settings and the privacy page.
use tauri::AppHandle;

use crate::os_error;

/// The LU Labs project (lu-labs.ai). The anon key is the browser key of the
/// web app, public by design; the counter table itself is service-role only,
/// the app can only call the counting function.
const LUC_SUPABASE_URL: &str = "https://lrrhheztdytyfpizvuup.supabase.co";
const LUC_SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxycmhoZXp0ZHl0eWZwaXp2dXVwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxNDkwNzUsImV4cCI6MjA5ODcyNTA3NX0.1AuX4tmup82d3NHLAgQx1KdXhwlCkPcX7liB6eNSkAU";

/// The four things a press on the Cloud switch can do (lib/cloud-switch-guard
/// on the frontend). The SQL function carries the same list.
pub(crate) const FUNNEL_EVENTS: &[&str] = &[
    "cloud_switch_gate",
    "cloud_switch_arm",
    "cloud_switch_enter",
    "cloud_switch_leave",
];

pub(crate) fn funnel_event_allowed(event: &str) -> bool {
    FUNNEL_EVENTS.contains(&event)
}

pub(crate) fn platform_label(os: &str) -> &'static str {
    match os {
        "windows" => "windows",
        "linux" => "linux",
        "macos" => "macos",
        _ => "unknown",
    }
}

/// The RPC arguments of `funnel_count`, exactly three, nothing user-shaped.
pub(crate) fn funnel_payload(event: &str, platform: &str, version: &str) -> serde_json::Value {
    serde_json::json!({
        "p_event": event,
        "p_platform": platform,
        "p_app_version": version,
    })
}

/// Fire and forget. Never an error to the caller and never awaited by the
/// switch: a counter that cannot be reached is a counter, not a feature.
#[tauri::command]
pub async fn funnel_ping(app: AppHandle, event: String) -> Result<(), String> {
    if !funnel_event_allowed(&event) {
        return Ok(());
    }
    let version = app.package_info().version.to_string();
    let payload = funnel_payload(&event, platform_label(std::env::consts::OS), &version);
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder()
            .user_agent(format!("LocallyUncensored/{version}"))
            .timeout(std::time::Duration::from_secs(5))
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };
        let url = format!("{LUC_SUPABASE_URL}/rest/v1/rpc/funnel_count");
        match client
            .post(&url)
            .header("apikey", LUC_SUPABASE_ANON_KEY)
            .header("Authorization", format!("Bearer {LUC_SUPABASE_ANON_KEY}"))
            .header("Content-Type", "application/json")
            .body(payload.to_string())
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {}
            Ok(r) => println!("[Funnel] {event} answered HTTP {}", r.status().as_u16()),
            Err(e) => println!("[Funnel] {event} not sent: {}", os_error::english(&e)),
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_four_presses_of_the_switch_count() {
        for e in FUNNEL_EVENTS {
            assert!(funnel_event_allowed(e), "{e}");
        }
        for e in ["", "cloud_switch_seen", "app_start", "cloud_switch_gate'; drop table x; --", "CLOUD_SWITCH_GATE"] {
            assert!(!funnel_event_allowed(e), "{e:?} must not count");
        }
    }

    #[test]
    fn the_platform_is_one_of_four_words() {
        assert_eq!(platform_label("windows"), "windows");
        assert_eq!(platform_label("linux"), "linux");
        assert_eq!(platform_label("macos"), "macos");
        assert_eq!(platform_label("freebsd"), "unknown");
        assert_eq!(platform_label(""), "unknown");
    }

    #[test]
    fn the_payload_is_exactly_the_three_rpc_arguments() {
        let p = funnel_payload("cloud_switch_enter", "windows", "2.6.8");
        let obj = p.as_object().expect("object");
        let mut keys: Vec<&String> = obj.keys().collect();
        keys.sort();
        assert_eq!(keys, ["p_app_version", "p_event", "p_platform"]);
        assert_eq!(p["p_event"], "cloud_switch_enter");
        assert_eq!(p["p_platform"], "windows");
        assert_eq!(p["p_app_version"], "2.6.8");
    }

    #[test]
    fn the_command_never_fails_the_switch_and_never_waits_on_the_network() {
        let src = include_str!("funnel.rs");
        let body = &src[src.find("pub async fn funnel_ping").expect("command")..];
        let body = &body[..body.find("#[cfg(test)]").expect("end")];
        assert!(!body.contains("return Err") && !body.contains("map_err") && !body.contains("?;"), "the switch must never hear an error from the counter");
        assert_eq!(body.matches("Ok(())").count(), 2, "both ways out of the command are Ok");
        assert!(body.contains("tauri::async_runtime::spawn"), "the request runs detached");
        assert!(!body.contains("email") && !body.contains("user_id") && !body.contains("token"), "nothing user-shaped goes out");
    }
}
