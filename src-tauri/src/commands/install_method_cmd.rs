//! The Tauri side of `install_method`.
//!
//! Kept apart from the rules themselves on purpose. `install_method.rs` uses
//! nothing but `std`, which is what lets the exact file that ships be compiled
//! and run inside an Arch, an Ubuntu and a Fedora container to prove the
//! detection before anyone trusts it. Everything that needs tauri or serde
//! lives here, and here only.

use super::install_method;

/// What kind of install this is, and whether the in-app updater may touch it.
///
/// ASYNC + spawn_blocking: this shells out to `pacman -Qo` / `dpkg -S` /
/// `rpm -qf`, and a synchronous Tauri command runs on the MAIN thread, where
/// even a fast subprocess is a visible stutter and a hung one is a frozen
/// window.
#[tauri::command]
pub async fn install_method() -> Result<serde_json::Value, String> {
    let report = tauri::async_runtime::spawn_blocking(install_method::report)
        .await
        .map_err(|e| format!("install method probe failed to run: {e}"))?;

    Ok(serde_json::json!({
        "kind": report.kind.as_str(),
        "exe_path": report.exe_path,
        "writable": report.writable,
    }))
}
