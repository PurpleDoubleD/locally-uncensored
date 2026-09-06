//! Ollama installieren und den Dienst danach am Leben lassen.
//!
//! Der geteilte Zustand ist zweigeteilt, und beide Hälften erklären, warum
//! dieses Modul so geschnitten ist. Die eine ist der `InstallState` für
//! Ollama, in den alle drei Plattformwege erzählen und den
//! `install_ollama_status` ausliest. Die andere ist der Prozessschlitz für
//! `ollama serve`: der Dienst, den wir starten, gehört uns, also muss sein
//! Handle dort landen, wo das App-Ende ihn wieder einsammelt.
//!
//! Genau daran war der Fehler. Alle drei Wege starteten `serve` von Hand und
//! ließen das `Child` in der nächsten Zeile fallen — womit die Lesenden der
//! Pipes zugingen und der Daemon an seiner ersten Logzeile starb. Deshalb
//! gibt es hier genau EINEN Weg, `serve` zu starten, und alle drei
//! Plattformzweige gehen durch ihn.
//!
//! Die Plattformzweige selbst sind der Rest: Windows lädt und führt aus,
//! Linux verweist auf den Paketmanager (die Release-Tarballs sind mehrere GB
//! groß und gehören nicht hinter einen Installationsknopf), macOS auf die
//! signierte App. Was sie eint, ist der Schluss — starten und warten, ob die
//! API antwortet.

use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

#[cfg(target_os = "windows")]
use std::fs;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::{Manager, State};
use tracing::info;
#[cfg(target_os = "windows")]
use tracing::error;

use crate::state::{AppState, InstallState};

#[cfg(target_os = "windows")]
use super::download::{download_file_blocking, verify_downloaded_installer};
#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

// ── Ollama Install ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn install_ollama(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut install = state.ollama_install.lock().unwrap();
    if install.status == "downloading" || install.status == "installing" || install.status == "starting" {
        return Ok(serde_json::json!({"status": "already_installing"}));
    }

    install.status = "downloading".to_string();
    install.logs.clear();
    install.download_progress = 0;
    install.download_total = 0;
    install.download_speed = 0.0;
    install.logs.push("Downloading Ollama installer...".to_string());
    drop(install);

    info!("ollama install start");

    let ollama_state = state.ollama_install.clone();
    // OI-4: the serve we are about to spawn belongs to LU, so its handle goes
    // into the same slot `start_ollama` uses and gets reaped on quit.
    let serve_slot = state.ollama_process.clone();

    std::thread::spawn(move || {
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = ollama_state.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        // Bug G (discovered during 2026-05-17 Arch live test): pre-fix
        // install_ollama unconditionally downloaded OllamaSetup.exe (a
        // Windows-only NSIS installer) and tried to execute it with /S.
        // On Linux that fails with "Exec format error" and on macOS with
        // a similar binary-format mismatch — the user sees a cryptic
        // install failure with no path forward. Dispatch by platform.
        #[cfg(target_os = "windows")]
        {
            install_ollama_windows_impl(&ollama_state, &serve_slot, update);
        }
        #[cfg(target_os = "linux")]
        {
            install_ollama_linux_impl(&ollama_state, &serve_slot, update);
        }
        #[cfg(target_os = "macos")]
        {
            install_ollama_macos_impl(&ollama_state, &serve_slot, update);
        }
    });

    Ok(serde_json::json!({"status": "downloading"}))
}

/// Start `ollama serve` so that it SURVIVES the installer, and hand the child
/// to the slot that reaps it on quit.
///
/// OI-4: all three install paths used to do this by hand as
/// `Command::new("ollama").arg("serve").stdout(piped).stderr(piped).spawn()`
/// with the returned `Child` dropped on the next line. Dropping a `Child`
/// closes the read ends of both pipes, so the very first line Ollama logs
/// gets EPIPE / SIGPIPE and the daemon dies seconds after we started it. The
/// install then waited 30 s, reported "installed but not responding" and told
/// the user to go run `ollama serve` in a terminal themselves — for a daemon
/// that had been alive and was killed by us.
///
/// `Stdio::null()` on all three handles is the fix and it is also what the
/// rest of the repo already does: `process::start_ollama` and
/// `auto_start_ollama` have spawned it this way since kj103x's orphan report.
/// Following that pattern to the end means keeping the `Child` (so a quit
/// reaps it instead of orphaning a daemon we started) and registering the pid
/// with the kill-on-close job on Windows.
fn spawn_ollama_serve(slot: &Arc<Mutex<Option<std::process::Child>>>) -> std::io::Result<()> {
    let mut cmd = Command::new("ollama");
    cmd.arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let child = cmd.spawn()?;
    crate::commands::process::tie_child_to_app_lifetime(child.id());
    if let Ok(mut g) = slot.lock() {
        // Whatever was in the slot is a handle to a process we no longer
        // manage; replacing it would leak the old one, so reap it first.
        if let Some(mut old) = g.take() {
            let _ = old.kill();
            let _ = old.wait();
        }
        *g = Some(child);
    }
    Ok(())
}

/// Wait for Ollama HTTP API to respond on the default port (best-effort
/// shared startup probe used after every platform-specific install path).
fn wait_for_ollama_ready() -> bool {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap_or_default();
    for i in 0..15 {
        std::thread::sleep(std::time::Duration::from_secs(2));
        match client.get("http://localhost:11434/api/tags").send() {
            Ok(res) if res.status().is_success() => return true,
            _ => println!("[Ollama] Not ready yet, attempt {}/15", i + 1),
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn install_ollama_windows_impl<F: Fn(&str, &str)>(
    ollama_state: &Arc<Mutex<InstallState>>,
    serve_slot: &Arc<Mutex<Option<std::process::Child>>>,
    update: F,
) {
    let temp_dir = std::env::temp_dir();
    let installer_path = temp_dir.join("OllamaSetup.exe");
    println!("[Ollama] Downloading OllamaSetup.exe...");
    if let Err(e) = download_file_blocking(
        "https://ollama.com/download/OllamaSetup.exe",
        &installer_path,
        ollama_state,
    ) {
        update("error", &format!("Download failed: {}", e));
        return;
    }
    // OI-8: verified before it is executed. Ollama's URL always serves the
    // current release, so there is no immutable digest to pin here — the size
    // and Authenticode checks are the whole answer available.
    if let Err(e) = verify_downloaded_installer(&installer_path, None, None, "Ollama") {
        let _ = fs::remove_file(&installer_path);
        error!(error = %e, "refused to execute an unverified Ollama installer");
        update("error", &e);
        return;
    }
    update("installing", "Download complete. Installing Ollama...");
    let mut cmd = Command::new(&installer_path);
    cmd.arg("/S");
    cmd.creation_flags(CREATE_NO_WINDOW);
    match cmd.output() {
        Ok(o) => {
            let code = o.status.code().unwrap_or(-1);
            update("starting", &format!("Installer finished (code {}). Starting Ollama...", code));
        }
        Err(e) => {
            update("error", &format!("Could not run installer: {}", crate::os_error::english(&e)));
            return;
        }
    }
    let _ = fs::remove_file(&installer_path);
    if let Err(e) = spawn_ollama_serve(serve_slot) {
        update(
            "error",
            &format!(
                "Ollama installed, but `ollama serve` could not be started: {}. Open a \
                 terminal and run `ollama serve` to see what it says.",
                e
            ),
        );
        return;
    }
    update("starting", "Waiting for Ollama to start...");
    if wait_for_ollama_ready() {
        update("complete", "Ollama is ready!");
    } else {
        update("error", "Ollama installed but not responding. Try restarting the app.");
    }
}

#[cfg(target_os = "linux")]
fn install_ollama_linux_impl<F: Fn(&str, &str)>(
    _ollama_state: &Arc<Mutex<InstallState>>,
    serve_slot: &Arc<Mutex<Option<std::process::Child>>>,
    update: F,
) {
    // If `ollama` is already on PATH (pacman -S ollama, manual install, etc.),
    // skip ahead to spawning the service.
    let already_installed = Command::new("which")
        .arg("ollama")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !already_installed {
        // Bug G revisit (2026-05-17 live test on Arch VM): Ollama's GitHub
        // release assets changed format. The old `ollama-linux-amd64` raw
        // binary URL now returns 404 — current releases ship as
        // `ollama-linux-amd64.tar.zst` which bundles the CUDA runtime libs
        // (multi-GB tarball). Auto-downloading 2-3 GB from a desktop-app
        // install button isn't user-friendly, so we surface a clear distro-
        // specific install hint instead. Every modern Linux distro ships an
        // ollama package or accepts ollama.com/install.sh; pointing at the
        // right command beats a stuck 2-GB progress bar.
        let os_release = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
        let suggestion = linux_ollama_install_hint(&os_release);
        update(
            "error",
            &format!(
                "Ollama auto-install on Linux isn't supported — current releases \
                 are multi-GB tarballs with bundled CUDA libs that are too large \
                 to fetch from an install button.\n\n\
                 Install via your distro: {}\n\n\
                 After install, click 'Re-detect' here.",
                suggestion
            ),
        );
        return;
    }

    // ollama is already on PATH — spawn it and poll the API.
    update("starting", "Ollama is already installed — starting service...");
    if let Err(e) = spawn_ollama_serve(serve_slot) {
        update(
            "error",
            &format!(
                    "Could not start `ollama serve`: {}. Try running it in a terminal.",
                    crate::os_error::english(&e)
                ),
        );
        return;
    }

    update("starting", "Waiting for Ollama to start...");
    if wait_for_ollama_ready() {
        update("complete", "Ollama is ready!");
    } else {
        update(
            "error",
            "Ollama is installed but the API isn't responding on localhost:11434. \
             Open a terminal and run `ollama serve` manually to see the failure \
             message — common causes: another process already binding 11434, or \
             missing GPU drivers.",
        );
    }
}

/// Bug G revisit — distro-specific install command for `ollama`. Same parsing
/// shape as `linux_python_install_hint` (ID + ID_LIKE tokens, quoted values
/// handled). Falls back to ollama.com/install.sh for unknown distros.
/// Dead off Linux: the only production caller is `install_ollama_linux_impl`,
/// which is `#[cfg(target_os = "linux")]` as a whole. The function itself is
/// left compiled everywhere so its distro table stays unit-tested here.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn linux_ollama_install_hint(os_release: &str) -> String {
    let mut families: Vec<String> = Vec::new();
    for line in os_release.lines() {
        let trimmed = line.trim();
        let (key, value) = match trimmed.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        let key = key.trim().to_lowercase();
        if key != "id" && key != "id_like" {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        for token in value.split_whitespace() {
            families.push(token.to_lowercase());
        }
    }
    let has = |needle: &str| families.iter().any(|f| f == needle);
    if has("arch") || has("manjaro") || has("endeavouros") || has("garuda") {
        "`sudo pacman -S ollama`".to_string()
    } else if has("debian") || has("ubuntu") || has("linuxmint") || has("pop") || has("elementary") {
        "`sudo apt install ollama` (Debian 12+ / Ubuntu 23.10+) or `curl -fsSL https://ollama.com/install.sh | sh`".to_string()
    } else if has("fedora") || has("rhel") || has("centos") || has("rocky") || has("almalinux") {
        "`curl -fsSL https://ollama.com/install.sh | sh`".to_string()
    } else if has("opensuse") || has("opensuse-tumbleweed") || has("opensuse-leap") || has("suse") {
        "`sudo zypper install ollama` (Tumbleweed) or `curl -fsSL https://ollama.com/install.sh | sh`".to_string()
    } else {
        "`curl -fsSL https://ollama.com/install.sh | sh` (official) or download manually from https://ollama.com/download/linux".to_string()
    }
}

#[cfg(target_os = "macos")]
fn install_ollama_macos_impl<F: Fn(&str, &str)>(
    _ollama_state: &Arc<Mutex<InstallState>>,
    serve_slot: &Arc<Mutex<Option<std::process::Child>>>,
    update: F,
) {
    if Command::new("which").arg("ollama").output().map(|o| o.status.success()).unwrap_or(false) {
        update("starting", "Ollama already installed — starting service...");
        if let Err(e) = spawn_ollama_serve(serve_slot) {
            update(
                "error",
                &format!(
                    "Could not start `ollama serve`: {}. Try running it in a terminal.",
                    crate::os_error::english(&e)
                ),
            );
            return;
        }
        if wait_for_ollama_ready() {
            update("complete", "Ollama is ready!");
        } else {
            update("error", "Ollama is installed but the API isn't responding. Try restarting Ollama.app.");
        }
        return;
    }
    // We don't auto-install on macOS because the official distribution is
    // the signed Ollama.app from ollama.com/download/mac. Surfacing a clear
    // pointer beats trying to script around macOS gatekeeper.
    update(
        "error",
        "On macOS, download Ollama.app from https://ollama.com/download/mac and \
         move it to /Applications, then come back here and click Re-detect.",
    );
}

// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread.
// The State borrow cannot cross into the blocking pool, so the handle is
// re-resolved there from the AppHandle (same pattern as engine.rs/whisper.rs).
#[tauri::command]
pub async fn install_ollama_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        install_ollama_status_blocking(&state)
    })
    .await
    .map_err(|e| format!("install_ollama_status task: {e}"))?
}

fn install_ollama_status_blocking(state: &AppState) -> Result<serde_json::Value, String> {
    let install = state.ollama_install.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
        "download_progress": install.download_progress,
        "download_total": install.download_total,
        "download_speed": install.download_speed,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ollama's URL always serves the current release, so pinning either its
    /// size or its digest would break the install on every Ollama release.
    /// Neither may be passed for it.
    #[test]
    fn the_moving_ollama_url_is_never_pinned() {
        const SRC: &str = include_str!("ollama.rs");
        assert!(
            SRC.contains(concat!("verify_downloaded_installer", "(&installer_path, None, None, \"Ollama\")")),
            "the Ollama installer path acquired a pin it cannot keep"
        );
    }

    // ── Bug G revisit — linux_ollama_install_hint distro detection ────────
    //
    // Bug G's original "auto-download raw binary" fix shipped broken because
    // Ollama removed the raw `ollama-linux-amd64` asset in late 2025 — current
    // releases ship as multi-GB tarballs with bundled CUDA libs. Auto-download
    // isn't user-friendly at that size, so we surface distro-specific install
    // commands instead. These tests pin the matrix.

    #[test]
    fn ollama_hint_arch_recommends_pacman_ollama() {
        let release = "NAME=\"Arch Linux\"\nID=arch\n";
        let hint = linux_ollama_install_hint(release);
        assert!(hint.contains("pacman -S ollama"), "got: {}", hint);
    }

    #[test]
    fn ollama_hint_manjaro_via_id_like_arch() {
        let release = "NAME=\"Manjaro\"\nID=manjaro\nID_LIKE=arch\n";
        let hint = linux_ollama_install_hint(release);
        assert!(hint.contains("pacman -S ollama"), "got: {}", hint);
    }

    #[test]
    fn ollama_hint_ubuntu_recommends_apt_or_install_sh() {
        let release = "NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n";
        let hint = linux_ollama_install_hint(release);
        assert!(hint.contains("apt install ollama"), "got: {}", hint);
        assert!(hint.contains("install.sh"), "should also offer official installer, got: {}", hint);
    }

    #[test]
    fn ollama_hint_fedora_recommends_official_install_sh() {
        let release = "NAME=\"Fedora Linux\"\nID=fedora\n";
        let hint = linux_ollama_install_hint(release);
        assert!(hint.contains("install.sh"), "got: {}", hint);
    }

    #[test]
    fn ollama_hint_rocky_via_id_like_rhel() {
        let release = "NAME=\"Rocky Linux\"\nID=rocky\nID_LIKE=\"rhel centos fedora\"\n";
        let hint = linux_ollama_install_hint(release);
        assert!(hint.contains("install.sh"), "RHEL-family should get install.sh, got: {}", hint);
    }

    #[test]
    fn ollama_hint_opensuse_recommends_zypper_or_install_sh() {
        let release = "NAME=\"openSUSE Tumbleweed\"\nID=opensuse-tumbleweed\nID_LIKE=\"opensuse suse\"\n";
        let hint = linux_ollama_install_hint(release);
        assert!(hint.contains("zypper install ollama") || hint.contains("install.sh"), "got: {}", hint);
    }

    #[test]
    fn ollama_hint_unknown_distro_falls_back_to_install_sh() {
        let release = "NAME=\"Some Custom Distro\"\nID=mystery\n";
        let hint = linux_ollama_install_hint(release);
        assert!(hint.contains("install.sh") || hint.contains("ollama.com"), "got: {}", hint);
    }

    #[test]
    fn ollama_hint_empty_input_falls_back() {
        let hint = linux_ollama_install_hint("");
        assert!(hint.contains("install.sh") || hint.contains("ollama.com"));
    }

}
