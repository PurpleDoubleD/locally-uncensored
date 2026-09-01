//! LM Studio auf Windows installieren — und was dabei angeheftet ist.
//!
//! Der geteilte Zustand ist der `InstallState` für LM Studio: der lange
//! Windows-Weg erzählt hinein, `install_lmstudio_status` liest ihn aus, und
//! sonst niemand.
//!
//! Die drei Konstanten oben liegen hier und nicht bei den Prüfregeln, weil
//! sie EIN Fakt in drei Zeilen sind: die versionsfeste URL, die genaue
//! Byte-Zahl, die sie ausliefert, und der Platz für den Prüfwert, sobald
//! ihn jemand an der Datei selbst gemessen hat. Wer die URL bewegt, muss die
//! Zahl neu messen; ein Test unten hält genau diese Kopplung fest. Wären
//! sie bei den allgemeinen Regeln gelandet, wäre die Kopplung an die URL
//! nur noch ein Kommentar.
//!
//! Der Bootstrap-Tanz danach ist kein Beiwerk, sondern der Grund, warum diese
//! Installation überhaupt Plug & Play heißt: ohne ihn muss der Nutzer LM
//! Studio einmal von Hand öffnen und den Server-Schalter umlegen.

use std::fs;
use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::State;

use crate::state::AppState;

use super::download::{download_file_blocking, verify_downloaded_installer};
use super::lmstudio::{lmstudio_gui_exe, lmstudio_lms_path, lmstudio_server_running,
    LMSTUDIO_DEFAULT_PORT};
#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

/// SHA-256 of the LM Studio installer at [`LMSTUDIO_INSTALLER_URL`].
///
/// That URL is version-pinned and immutable (`0.3.16-6`), so its bytes never
/// change and a digest here would be an integrity guarantee for an executable
/// LU runs with `/S`.
///
/// It is `None`, and it has to stay `None` until somebody fills it with a
/// digest they measured from that exact file. A guessed or mistyped value does
/// not weaken the check — it breaks every Windows LM Studio install outright.
/// This was written on a machine that could not fetch the file to measure it,
/// so the honest state is "not pinned yet". Measuring it is one command on a
/// box that has the installer:
///
/// ```text
/// certutil -hashfile LM-Studio-0.3.16-6-x64.exe SHA256
/// ```
///
/// The vendor publishes no checksum to copy instead: `<url>.sha256`,
/// `.sha256sum`, `.SHA256`, `.checksum` and the directory index all answer 404
/// (checked 2026-09-01). So the digest can only come from the file itself, and
/// a digest measured over the same unauthenticated channel the app downloads
/// through is trust-on-first-use: it pins against a LATER substitution at that
/// URL, not against a download that was already tampered with.
///
/// Until then the size checks and the Authenticode check below are what stands
/// between the user and an unverified executable.
///
/// Ollama's installer gets no pin at all and cannot: its URL
/// (`ollama.com/download/OllamaSetup.exe`) always serves the current release,
/// so its bytes change with every version. Signature + size is the whole
/// answer available there.
const LMSTUDIO_INSTALLER_SHA256: Option<&str> = None;

/// Exact byte count of the file at [`LMSTUDIO_INSTALLER_URL`].
///
/// The half of the pin that CAN be established without the file: the vendor's
/// own server reports it in one header request, so anyone can re-check it in a
/// second instead of moving 211 MiB.
///
/// ```text
/// curl -sI https://installers.lmstudio.ai/win32/x64/0.3.16-6/LM-Studio-0.3.16-6-x64.exe
/// ```
///
/// Measured 2026-09-01: `content-length: 221768208`, `last-modified: Fri, 23
/// May 2025 22:14:17 GMT`, `etag: "4c5f34448d76416730ec408b05a54270"` (32 hex
/// chars, no `-N` part suffix — a single-part object). A `last-modified` 15
/// months in the past under a version-pinned path is the evidence that this URL
/// is immutable; this constant is what turns that evidence from an ASSUMPTION
/// into something the code enforces.
///
/// It is deliberately much weaker than a digest — it catches a truncated or
/// substituted transfer of a different length, not a same-length forgery — and
/// it carries the same maintenance duty: if LM Studio ever re-uploads different
/// bytes here, the install fails loudly instead of silently running new,
/// unchecked bytes. That is the intended direction. `LMSTUDIO_INSTALLER_URL`
/// and this constant have to move together.
const LMSTUDIO_INSTALLER_BYTES: Option<u64> = Some(221_768_208);

// ── LM Studio Install (Windows) ─────────────────────────────────────────────
//
// LM Studio doesn't run as a Windows service like Ollama — it's a desktop app
// whose embedded server is started via either the GUI ("Server" tab) or the
// `lms` CLI (`lms server start`). The install flow here:
//   1. Download the official LM Studio installer .exe
//   2. Silent install with /S (NSIS / electron-builder convention)
//   3. Run `lms bootstrap` to register the CLI on PATH
//   4. Start the server on port 1234 via `lms server start --cors`
//
// Step 4 is what makes this Plug & Play — without it the user has to manually
// open the app and toggle the server, which is exactly the "version one
// usability cliff" we're trying to remove. If lms isn't on PATH yet (e.g.
// install is too fresh), we look in `%USERPROFILE%/.lmstudio/bin/lms.exe`
// directly.
//
// The hard-coded URL points to a known-stable release. LM Studio's installer
// host doesn't expose a /latest redirect — every version is its own URL — so
// the alternative would be to bake in a remote-version-check, which adds an
// extra failure mode for offline users. A stale URL just means the user gets
// a slightly older LM Studio; functionally fine.
const LMSTUDIO_INSTALLER_URL: &str =
    "https://installers.lmstudio.ai/win32/x64/0.3.16-6/LM-Studio-0.3.16-6-x64.exe";

#[tauri::command]
pub fn install_lmstudio(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut install = state.lmstudio_install.lock().unwrap();
    if install.status == "downloading"
        || install.status == "installing"
        || install.status == "starting"
    {
        return Ok(serde_json::json!({"status": "already_installing"}));
    }

    install.status = "downloading".to_string();
    install.logs.clear();
    install.download_progress = 0;
    install.download_total = 0;
    install.download_speed = 0.0;
    install
        .logs
        .push("Downloading LM Studio installer...".to_string());
    drop(install);

    let lms_state = state.lmstudio_install.clone();

    std::thread::spawn(move || {
        let update = |status: &str, msg: &str| {
            if let Ok(mut s) = lms_state.lock() {
                s.status = status.to_string();
                s.logs.push(msg.to_string());
            }
        };

        // Bug H (discovered during 2026-05-17 Arch live test): pre-fix
        // install_lmstudio unconditionally downloaded LMStudioSetup.exe
        // (Windows installer) and tried to `cmd.arg("/S")` it. On Linux
        // the execve crashes with "Exec format error"; on macOS the
        // mismatch is the same. LM Studio's Linux distribution is an
        // AppImage whose URL rotates with every release, so we can't
        // mirror it from a stable in-binary string — surface a clear
        // download pointer instead of pretending to auto-install.
        if cfg!(target_os = "linux") {
            update(
                "error",
                "LM Studio's Linux distribution is an AppImage with a URL that \
                 rotates per release. Download it from https://lmstudio.ai/download \
                 (pick 'Linux AppImage'), `chmod +x` the file, run it once to \
                 finish bootstrap, then come back to LU and click Re-detect.\n\n\
                 Tip: if you prefer the CLI-only path, the `lms` CLI ships with \
                 the AppImage and lands at ~/.lmstudio/bin/lms after first run.",
            );
        }
        if cfg!(target_os = "macos") {
            update(
                "error",
                "On macOS, download LM Studio.app from https://lmstudio.ai/download, \
                 drag it to /Applications, launch it once to finish setup, then \
                 come back to LU and click Re-detect.",
            );
        }

        // ── The Windows path ────────────────────────────────────────────────
        //
        // Everything below is the winget install. It used to sit behind the two
        // `return`s above, which made rustc call it an `unreachable statement`
        // on macOS and Linux — correct about the control flow, and saying
        // nothing about the code: this is not dead code, it is the OTHER
        // platform's implementation.
        //
        // `if cfg!` and not `#[cfg]`, for the reason `test_support.rs` states at
        // its top: a `#[cfg]` would delete this whole branch from a macOS build,
        // and with it the type-checking of ~150 lines of Windows installer plus
        // the dozen helpers it is the only caller of (`sha256_file`,
        // `installer_size_verdict`, `windows_git_probe_from_output` …), which
        // would then read as dead code here. Compiled-and-never-taken keeps the
        // Windows half honest on the machine this is developed on.
        //
        // The condition is `not(linux or macos)` rather than `windows` so the
        // set of targets that run it is exactly the set that ran it before.
        if !cfg!(any(target_os = "linux", target_os = "macos")) {
                // Pre-check: if LM Studio is already installed (an `lms.exe` is
                // findable in any of the locations `lmstudio_lms_path()` knows about)
                // we skip the ~570 MB download entirely. Re-installing on a box where
                // it's already there was the previous behaviour and made the
                // "LM Studio detected but server offline" Plug-and-Play scenario
                // turn into a 5-minute no-op download. The bootstrap + server-start
                // steps below are idempotent, so the same code path now serves both
                // first-install and offline-reactivation users.
                let already_installed = lmstudio_lms_path().is_some();
                if already_installed && lmstudio_server_running() {
                    update(
                        "complete",
                        "LM Studio is already installed and the server is up on localhost:1234.",
                    );
                    return;
                }

                if already_installed {
                    update(
                        "starting",
                        "LM Studio is already installed — skipping download. Bootstrapping CLI and starting server…",
                    );
                } else {
                    let temp_dir = std::env::temp_dir();
                    let installer_path = temp_dir.join("LMStudioSetup.exe");

                    println!("[LMStudio] Downloading {}", LMSTUDIO_INSTALLER_URL);
                    if let Err(e) =
                        download_file_blocking(LMSTUDIO_INSTALLER_URL, &installer_path, &lms_state)
                    {
                        let err = format!(
                            "Download failed: {}. If the network is fine, the installer URL may have rotated — fall back to https://lmstudio.ai/download in your browser.",
                            e
                        );
                        println!("[LMStudio] {}", err);
                        update("error", &err);
                        return;
                    }

                    // OI-8: verified before it is executed. See
                    // LMSTUDIO_INSTALLER_SHA256 for why the digest pin is not filled
                    // in yet and what filling it in takes.
                    if let Err(e) = verify_downloaded_installer(
                        &installer_path,
                        LMSTUDIO_INSTALLER_SHA256,
                        LMSTUDIO_INSTALLER_BYTES,
                        "LM Studio",
                    ) {
                        let _ = fs::remove_file(&installer_path);
                        println!("[LMStudio] {}", e);
                        update("error", &e);
                        return;
                    }

                    update(
                        "installing",
                        "Download complete. Running silent installer (this can take a minute)...",
                    );

                    // electron-builder NSIS supports /S for silent install. Ignore exit
                    // code: real failures surface via the absence of lms.exe afterwards.
                    let mut cmd = Command::new(&installer_path);
                    cmd.arg("/S");
                    #[cfg(target_os = "windows")]
                    cmd.creation_flags(CREATE_NO_WINDOW);
                    match cmd.output() {
                        Ok(_) => println!("[LMStudio] Installer finished"),
                        Err(e) => {
                            let err = format!("Could not run installer: {}", e);
                            println!("[LMStudio] {}", err);
                            update("error", &err);
                            return;
                        }
                    }

                    let _ = fs::remove_file(&installer_path);
                }

                // Bootstrap the lms CLI. We do this in two passes:
                //   (1) Run `lms bootstrap` from whatever path `lmstudio_lms_path()`
                //       resolves — on a fresh install that's the pre-bootstrap binary
                //       inside `resources/app/.webpack/lms.exe`. This alone is enough
                //       on most boxes.
                //   (2) Verify that ~/.lmstudio/bin/lms.exe now exists. If not, some
                //       LM Studio builds require the GUI to run once to populate
                //       ~/.lmstudio/ before the bootstrap registers a launcher there.
                //       In that case we briefly launch the GUI, wait for ~/.lmstudio/
                //       to appear, retry bootstrap, then move on. The user sees the
                //       GUI flash up — not ideal, but strictly better than the old
                //       "Open LM Studio once from the Start menu" error dialog and a
                //       failed install.
                update("starting", "Bootstrapping `lms` CLI...");
                let initial_lms = lmstudio_lms_path();
                match &initial_lms {
                    Some(p) => {
                        let mut bs = Command::new(p);
                        bs.arg("bootstrap");
                        #[cfg(target_os = "windows")]
                        bs.creation_flags(CREATE_NO_WINDOW);
                        let _ = bs.output();
                    }
                    None => {
                        update(
                            "error",
                            "LM Studio installed but `lms.exe` not found in any expected location. \
                             The installer may have failed silently. Try installing LM Studio manually \
                             from https://lmstudio.ai/download and then click Re-Scan.",
                        );
                        return;
                    }
                }

                // Did pass 1 produce ~/.lmstudio/bin/lms.exe?  If yes, skip the GUI
                // dance entirely. If no, fall back to launching the GUI so it seeds
                // its user-data dir, then retry bootstrap.
                let post_bootstrap_path = dirs::home_dir()
                    .map(|h| h.join(".lmstudio").join("bin").join("lms.exe"));
                let needs_gui_seed = post_bootstrap_path
                    .as_ref()
                    .map(|p| !p.exists())
                    .unwrap_or(true);

                if needs_gui_seed {
                    update(
                        "starting",
                        "Launching LM Studio briefly to finalise CLI setup (you may see the window flash)...",
                    );
                    if let Some(gui) = lmstudio_gui_exe() {
                        let mut g = Command::new(&gui);
                        #[cfg(target_os = "windows")]
                        g.creation_flags(CREATE_NO_WINDOW);
                        let _ = g.spawn();
                    }

                    // Wait up to 30 s for ~/.lmstudio/ to appear. The first GUI launch
                    // typically writes this within 3–8 s, but on a slow VM 30 s is a
                    // safer ceiling than failing the install.
                    let lmstudio_dir = dirs::home_dir().map(|h| h.join(".lmstudio"));
                    for _ in 0..30 {
                        std::thread::sleep(std::time::Duration::from_secs(1));
                        if let Some(d) = &lmstudio_dir {
                            if d.exists() {
                                break;
                            }
                        }
                    }

                    // Retry bootstrap from the (now possibly different) lms.exe.
                    // After GUI launch the .lmstudio dir might already contain a
                    // launcher; if not, the pre-bootstrap path is still valid.
                    if let Some(p) = lmstudio_lms_path() {
                        let mut bs = Command::new(&p);
                        bs.arg("bootstrap");
                        #[cfg(target_os = "windows")]
                        bs.creation_flags(CREATE_NO_WINDOW);
                        let _ = bs.output();
                    }
                }

                // Start the embedded server. `lms server start` is non-blocking — it
                // detaches a background httpd. --cors so LU's web view (which is on a
                // tauri:// origin) isn't blocked by the SOP. Port matches the
                // provider-store default of 1234 so user config Just Works.
                // Re-resolve the path because the bootstrap dance above may have
                // promoted us from the pre-bootstrap path to ~/.lmstudio/bin/lms.exe.
                update("starting", "Starting LM Studio server on port 1234...");
                if let Some(p) = lmstudio_lms_path() {
                    let mut srv = Command::new(&p);
                    srv.args(["server", "start", "--cors", "--port"])
                        .arg(LMSTUDIO_DEFAULT_PORT.to_string())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null());
                    #[cfg(target_os = "windows")]
                    srv.creation_flags(CREATE_NO_WINDOW);
                    let _ = srv.spawn();
                }

                // Wait for the server to respond. LM Studio's server typically takes
                // ~3-5 s to bind in a fresh install (it loads its model index first).
                update("starting", "Waiting for LM Studio server...");
                let mut ready = false;
                for i in 0..15 {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    if lmstudio_server_running() {
                        ready = true;
                        break;
                    }
                    println!("[LMStudio] Server not ready, attempt {}/15", i + 1);
                }

                if ready {
                    update("complete", "LM Studio server is up on localhost:1234.");
                } else {
                    update(
                        "error",
                        "LM Studio installed but the server didn't come up. Open LM Studio from the Start menu and toggle the Server tab on, then click Re-Scan.",
                    );
                }
        }
    });

    Ok(serde_json::json!({"status": "downloading"}))
}

#[tauri::command]
pub fn install_lmstudio_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.lmstudio_install.lock().unwrap();
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
    use super::super::download::{installer_size_verdict, verify_downloaded_installer,
        MIN_INSTALLER_BYTES};

    /// T-72 — the size pin for the immutable installer URL.
    ///
    /// WHAT THIS DOES NOT PROVE: that 221_768_208 is still what the vendor
    /// serves. That is one header request away (`curl -sI <url>`), and the
    /// constant's doc comment carries both the command and the date it was
    /// last measured. No test can hold that for you without going to the
    /// network on every run.
    #[test]
    fn a_file_of_the_wrong_length_from_the_immutable_url_is_refused() {
        let expected = LMSTUDIO_INSTALLER_BYTES.expect("the size pin was removed");
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("LMStudioSetup.exe");

        // Big enough to clear the generic floor, wrong for THIS url.
        std::fs::write(&f, vec![0u8; MIN_INSTALLER_BYTES as usize + 7]).unwrap();
        let err = verify_downloaded_installer(&f, None, Some(expected), "LM Studio").unwrap_err();
        assert!(err.contains(&expected.to_string()), "{err}");
        assert!(err.contains("immutable"), "{err}");
        assert!(err.contains("LM Studio"), "{err}");

        // The generic floor alone would have let it through — that is the gap
        // this pin closes.
        assert!(installer_size_verdict(MIN_INSTALLER_BYTES + 7).is_ok());
    }

    /// The URL and the size are one fact in two places. Moving one without the
    /// other is the failure mode this pin introduces, so it gets its own guard.
    #[test]
    fn the_pinned_url_and_the_pinned_size_belong_to_the_same_version() {
        assert!(
            LMSTUDIO_INSTALLER_URL.contains("0.3.16-6"),
            "the installer URL moved: re-measure LMSTUDIO_INSTALLER_BYTES with \
             `curl -sI {LMSTUDIO_INSTALLER_URL}` and update it in the same commit"
        );
        // A plausible installer size, not a placeholder someone left behind.
        let bytes = LMSTUDIO_INSTALLER_BYTES.expect("the size pin was removed");
        assert!(bytes > MIN_INSTALLER_BYTES, "the size pin is below the generic floor");
    }

    #[test]
    fn the_lmstudio_pin_is_either_absent_or_a_real_sha256() {
        // Guard rail for whoever fills LMSTUDIO_INSTALLER_SHA256 in: a
        // half-typed or truncated value there breaks every Windows install,
        // and the failure would only ever show up on Windows.
        if let Some(pin) = LMSTUDIO_INSTALLER_SHA256 {
            let clean: String = pin.chars().filter(|c| !c.is_whitespace()).collect();
            assert_eq!(clean.len(), 64, "pinned digest is not 64 hex chars: {pin}");
            assert!(clean.chars().all(|c| c.is_ascii_hexdigit()), "not hex: {pin}");
        }
    }

}
