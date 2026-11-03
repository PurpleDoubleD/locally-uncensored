//! The window on Windows is a WebView2, and the runtime behind it has to be
//! there for the Windows user who starts LU.
//!
//! 2026-11-03, a fresh Windows install: right after setup LU showed only
//! Tauri's own dialog, "Could not find the WebView2 Runtime ... You may have it
//! installed on another user account, but it is not available for this one",
//! and ended. The installer is the first line (installer-hooks.nsh,
//! LU_ENSURE_WEBVIEW2, says when the stock section skips the runtime). This is
//! the second, for whatever still slips through: a runtime that exists only
//! for another account, a setup that failed, a runtime removed later.
//!
//! Before any window is built LU asks WebView2 itself, the same question
//! Tauri asks. Without an answer it says in plain words what is missing and
//! offers to install it for this user with the Microsoft bootstrapper the
//! installer left in the install folder. That runs without admin rights. Where
//! the bootstrapper is missing or the install fails, it opens Microsoft's
//! download page instead of leaving the user with an error.

use std::path::{Path, PathBuf};

/// Microsoft's page for the runtime, the one the installer names too.
pub(crate) const DOWNLOAD_PAGE: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

/// The file the installer keeps next to the app (installer-hooks.nsh).
pub(crate) const BOOTSTRAPPER: &str = "MicrosoftEdgeWebview2Setup.exe";

/// What LU offers when the runtime is missing.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Offer {
    /// Run Microsoft's bootstrapper from the install folder.
    Install(PathBuf),
    /// Nothing to run here: open Microsoft's download page.
    DownloadPage,
}

pub(crate) fn offer(exe_dir: Option<&Path>) -> Offer {
    match exe_dir.map(|d| d.join(BOOTSTRAPPER)) {
        Some(p) if p.is_file() => Offer::Install(p),
        _ => Offer::DownloadPage,
    }
}

pub(crate) fn missing_text(offer: &Offer) -> String {
    let head = "LU needs the Microsoft Edge WebView2 Runtime to show its window, \
                and it is not available for this Windows user. It may be installed \
                only for another account on this PC.";
    match offer {
        Offer::Install(_) => format!(
            "{head}\n\nInstall it for this user now? It comes from Microsoft and \
             needs no admin rights.\n\nYes: install it, then LU starts.\n\
             No: open Microsoft's download page instead:\n{DOWNLOAD_PAGE}"
        ),
        Offer::DownloadPage => format!(
            "{head}\n\nPress OK to open Microsoft's download page, install the \
             Evergreen runtime there and start LU again:\n{DOWNLOAD_PAGE}"
        ),
    }
}

pub(crate) fn still_missing_text() -> String {
    format!(
        "The WebView2 Runtime is still not available for this Windows user.\n\n\
         Press OK to open Microsoft's download page, install the Evergreen \
         runtime there and start LU again:\n{DOWNLOAD_PAGE}"
    )
}

/// Runs before the Tauri builder. Returns when the runtime is there; ends the
/// process when it is not and could not be installed.
#[cfg(windows)]
pub(crate) fn ensure_runtime() {
    if tauri::webview_version().is_ok() {
        return;
    }
    tracing::warn!("WebView2 runtime not available for this user");
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    let offer = offer(exe_dir.as_deref());
    match &offer {
        Offer::Install(setup) => {
            if ask_yes_no(&missing_text(&offer)) {
                // Not silent on purpose: the user just said yes and should
                // see Microsoft's progress, not a frozen nothing.
                let status = std::process::Command::new(setup).arg("/install").status();
                tracing::info!(?status, "WebView2 bootstrapper finished");
                if tauri::webview_version().is_ok() {
                    return;
                }
                tell(&still_missing_text());
            }
        }
        Offer::DownloadPage => tell(&missing_text(&offer)),
    }
    let _ = std::process::Command::new("explorer").arg(DOWNLOAD_PAGE).spawn();
    std::process::exit(1);
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn message_box(text: &str, style: u32) -> i32 {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_SETFOREGROUND};
    let (text, title) = (wide(text), wide("LU"));
    // SAFETY: both pointers are NUL-terminated UTF-16 buffers that outlive
    // the call; a null owner window is allowed.
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), style | MB_SETFOREGROUND) }
}

#[cfg(windows)]
fn ask_yes_no(text: &str) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IDYES, MB_ICONWARNING, MB_YESNO};
    message_box(text, MB_YESNO | MB_ICONWARNING) == IDYES
}

#[cfg(windows)]
fn tell(text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONWARNING, MB_OK};
    message_box(text, MB_OK | MB_ICONWARNING);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bootstrapper_next_to_the_app_is_offered() {
        let dir = std::env::temp_dir().join(format!("lu-wv2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(offer(Some(&dir)), Offer::DownloadPage);
        std::fs::write(dir.join(BOOTSTRAPPER), b"x").unwrap();
        assert_eq!(offer(Some(&dir)), Offer::Install(dir.join(BOOTSTRAPPER)));
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(offer(None), Offer::DownloadPage);
    }

    #[test]
    fn every_text_names_the_runtime_and_microsofts_page() {
        for t in [
            missing_text(&Offer::Install(PathBuf::from("x"))),
            missing_text(&Offer::DownloadPage),
            still_missing_text(),
        ] {
            assert!(t.contains("WebView2 Runtime"), "{t}");
            assert!(t.contains(DOWNLOAD_PAGE), "{t}");
        }
        assert!(DOWNLOAD_PAGE.starts_with("https://developer.microsoft.com/"));
    }

    #[test]
    fn the_check_runs_before_the_builder() {
        let src = include_str!("lib.rs");
        let run = &src[src.find("\npub fn run() {").expect("run exists")..];
        let check = run.find("webview2_check::ensure_runtime()").expect("run calls the check");
        let builder = run.find("tauri::Builder::default()").expect("run builds");
        assert!(check < builder, "the check must come before any window exists");
    }

    #[test]
    fn the_installer_leaves_the_file_the_app_looks_for() {
        let hooks = include_str!("../windows/installer-hooks.nsh");
        assert!(hooks.contains(&format!("$INSTDIR\\{BOOTSTRAPPER}")));
    }
}
