//! The tauri side of the self migration: the two commands the update button
//! calls on an install the plugin cannot serve.
//!
//! Split from `self_migrate.rs` for the same reason `install_method_cmd.rs` is
//! split from `install_method.rs`: everything that decides something has to be
//! runnable inside a container against the real AUR package, and nothing that
//! needs tauri can be. What is left here is the network, the config and the
//! progress events.
//!
//! Two commands and not one, because the download must not restart the app.
//! `stage` fetches and checks the file, which is what auto download may do on
//! its own; `finish` moves it into place and starts it, which never happens
//! without a click.

use std::path::PathBuf;

use tauri::Emitter;

use super::install_method;
use super::self_migrate::{self, Layout};
use crate::os_error;

/// How often the download reports back. A 46 MB file at chunk size would emit
/// thousands of events and the progress bar cannot show more than a percent.
const PROGRESS_EVERY_BYTES: u64 = 512 * 1024;

/// The event both commands report on. One name, one payload shape, so the
/// store has a single listener for the whole sequence.
const PROGRESS_EVENT: &str = "update-migration";

fn emit(app: &tauri::AppHandle, phase: &str, downloaded: u64, total: u64) {
    let _ = app.emit(
        PROGRESS_EVENT,
        serde_json::json!({ "phase": phase, "downloaded": downloaded, "total": total }),
    );
}

/// The endpoints and the public key out of `tauri.conf.json`, read from the
/// config the app was built with rather than copied into a second place. The
/// plugin reads the very same two values, so they cannot drift apart.
fn updater_config(app: &tauri::AppHandle) -> Result<(Vec<String>, String), String> {
    let plugins = &app.config().plugins.0;
    let updater = plugins
        .get("updater")
        .ok_or("this build has no updater configuration")?;
    let pubkey = updater
        .get("pubkey")
        .and_then(|v| v.as_str())
        .ok_or("this build has no update signing key")?
        .to_string();
    let version = app.package_info().version.to_string();
    let endpoints: Vec<String> = updater
        .get("endpoints")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str())
                .map(|raw| self_migrate::resolve_endpoint(raw, &version))
                .collect()
        })
        .unwrap_or_default();
    if endpoints.is_empty() {
        return Err("this build has no update server configured".to_string());
    }
    Ok((endpoints, pubkey))
}

/// Refuse to run anywhere the plugin does its job. The frontend already asks
/// `install_method` before it calls this, and this is the answer to the same
/// question asked in the process that would do the writing.
fn only_where_it_is_needed() -> Result<Layout, String> {
    let report = install_method::report();
    if !self_migrate::migrates_itself(report.kind, report.writable) {
        return Err("this installation updates itself through the installer, so nothing was moved".to_string());
    }
    Layout::from_env()
}

/// Fetch the manifest, download the AppImage and check its signature.
///
/// Nothing outside `<data home>/locally-uncensored` is touched, and a file
/// that fails the signature check is deleted before this returns.
#[tauri::command]
pub async fn self_migrate_stage(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let layout = tauri::async_runtime::spawn_blocking(only_where_it_is_needed)
        .await
        .map_err(|e| format!("the install check failed to run: {e}"))??;

    let (endpoints, pubkey) = updater_config(&app)?;
    let release = fetch_manifest(&endpoints).await?;

    let dir = layout.install_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {}", dir.display(), os_error::english(&e)))?;
    let staged = layout.staged();
    // A previous attempt that died mid download leaves bytes behind, and
    // appending to them would produce a file that fails the signature check
    // for a reason nobody could guess.
    let _ = std::fs::remove_file(&staged);

    emit(&app, "download", 0, 0);
    let total = download(&app, &release.url, &staged).await.inspect_err(|_| {
        let _ = std::fs::remove_file(&staged);
    })?;

    emit(&app, "verify", total, total);
    let staged_for_check = staged.clone();
    let signature = release.signature.clone();
    let verdict = tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&staged_for_check)
            .map_err(|e| format!("could not read the download back: {}", os_error::english(&e)))?;
        self_migrate::verify_signature(&bytes, &signature, &pubkey)
    })
    .await
    .map_err(|e| format!("the signature check failed to run: {e}"))?;

    if let Err(why) = verdict {
        let _ = std::fs::remove_file(&staged);
        return Err(why);
    }

    Ok(serde_json::json!({
        "version": release.version,
        "bytes": total,
        "staged": staged.to_string_lossy(),
    }))
}

/// Move the checked download into place, give it a menu entry and start it.
///
/// The caller exits the app right after this returns: the new AppImage waits
/// for that (`self_migrate::relaunch_script`) because single instance would
/// otherwise hand it straight back to this process.
#[tauri::command]
pub async fn self_migrate_finish(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let pid = std::process::id();
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let layout = only_where_it_is_needed()?;
        let staged = layout.staged();
        if !staged.is_file() {
            return Err("the update was not downloaded yet, so there is nothing to install".to_string());
        }

        emit(&handle, "install", 0, 0);
        let appimage = layout.appimage();
        self_migrate::place_appimage(&staged, &appimage)?;

        let desktop_file = self_migrate::write_desktop_entry(&layout, &appimage)?;
        let icons = self_migrate::copy_icons(
            &layout,
            &self_migrate::icon_source_roots(
                std::env::var("APPDIR").ok(),
                std::env::var("XDG_DATA_DIRS").ok(),
            ),
        );
        self_migrate::refresh_desktop_database(&layout);

        emit(&handle, "start", 0, 0);
        self_migrate::launch_after_exit(&appimage, pid)?;

        Ok(serde_json::json!({
            "exe_path": appimage.to_string_lossy(),
            "desktop_file": desktop_file.to_string_lossy(),
            "icons": icons.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
        }))
    })
    .await
    .map_err(|e| format!("the install step failed to run: {e}"))?
}

/// The first endpoint that answers wins. The list is the plugin's own, so a
/// mirror that is added there is used here too.
async fn fetch_manifest(endpoints: &[String]) -> Result<self_migrate::Release, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("could not start the update request: {}", os_error::english(&e)))?;

    let mut last = String::new();
    for endpoint in endpoints {
        match client.get(endpoint).send().await {
            Ok(res) if res.status().is_success() => match res.text().await {
                Ok(body) => match self_migrate::pick_appimage(&body) {
                    Ok(release) => return Ok(release),
                    Err(why) => last = why,
                },
                Err(e) => {
                    last = format!("the update server answer could not be read: {}", os_error::english(&e))
                }
            },
            Ok(res) => last = format!("the update server answered {}", res.status()),
            Err(e) => last = format!("the update server could not be reached: {}", os_error::english(&e)),
        }
    }
    Err(last)
}

/// Stream the AppImage to disk, reporting bytes as they land.
async fn download(app: &tauri::AppHandle, url: &str, target: &PathBuf) -> Result<u64, String> {
    use tokio::io::AsyncWriteExt;

    let client = reqwest::Client::builder()
        // No overall deadline: this is a 46 MB file on whatever line the user
        // has. The connect timeout is what protects against a dead server.
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("could not start the download: {}", os_error::english(&e)))?;

    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("the download could not be started: {}", os_error::english(&e)))?;
    if !response.status().is_success() {
        return Err(format!("the download answered {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);

    let mut file = tokio::fs::File::create(target).await.map_err(|e| {
        format!("could not write to {}: {}", target.display(), os_error::english(&e))
    })?;

    let mut downloaded: u64 = 0;
    let mut announced: u64 = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("the download broke off: {}", os_error::english(&e)))?
    {
        file.write_all(&chunk).await.map_err(|e| {
            format!("could not write to {}: {}", target.display(), os_error::english(&e))
        })?;
        downloaded += chunk.len() as u64;
        if downloaded - announced >= PROGRESS_EVERY_BYTES {
            announced = downloaded;
            emit(app, "download", downloaded, total);
        }
    }
    file.flush().await.map_err(|e| {
        format!("could not finish writing {}: {}", target.display(), os_error::english(&e))
    })?;
    // The last chunk is almost never on a 512 KB boundary, so the bar would
    // stop just short of the end without this.
    emit(app, "download", downloaded, total.max(downloaded));

    Ok(downloaded)
}
