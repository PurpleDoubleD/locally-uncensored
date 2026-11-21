//! macOS: `xcap` for displays, capture and the window list, `enigo` for
//! input, AppKit for the identity of an app. No accessibility tree yet.
//!
//! The input space is points, the capture is pixels (twice as many on a
//! Retina display). Simulated input is sent from the main thread, which is
//! where the keyboard layout services of macOS want to be called.
//!
//! Two permissions decide what works: Accessibility for input and Screen
//! Recording for the capture and for window titles. Nothing in the adapter
//! itself requests them: a missing one comes back as an error that names it,
//! and the interface then offers the way to grant it (`request_permission`).
//! Without that request a fresh LU never shows up in the two lists of System
//! Settings, and an entry of a copy with another signature does not count
//! for this one (`forget_permission`). The owner's test of 07.10.2026 ended with a sentence
//! about permissions and no way to act on it.

use super::super::adapter::{Desktop, InputOp};
use super::super::blocklist::{self, Platform};
use super::super::types::{AppIdentity, ElementInfo, MonitorInfo, Permission, Permissions, PlatformError, PlatformResult, Rect, WindowInfo};
use super::{input, on_main, MainThread};
use enigo::Mouse;
use image::RgbaImage;
use objc2_app_kit::{NSApplicationActivationOptions, NSApplicationActivationPolicy, NSRunningApplication};
use std::collections::HashMap;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn IsSecureEventInputEnabled() -> u8;
}

pub struct MacDesktop {
    own_pid: u32,
    main: MainThread,
}

impl MacDesktop {
    pub fn new(own_pid: u32, main: MainThread) -> Self {
        Self { own_pid, main }
    }
}

fn no_accessibility() -> PlatformError {
    PlatformError::needs(
        Permission::Accessibility,
        "LU needs the Accessibility permission to control the mouse and keyboard. Grant it in System Settings under Privacy and Security, Accessibility, then try again.",
    )
}

fn no_screen_recording() -> PlatformError {
    PlatformError::needs(
        Permission::ScreenRecording,
        "LU needs the Screen Recording permission to see the screen. Grant it in System Settings under Privacy and Security, Screen Recording, then restart LU.",
    )
}

/// What macOS has granted LU right now.
pub fn permissions() -> Permissions {
    Permissions {
        needed: true,
        accessibility: unsafe { AXIsProcessTrusted() } != 0,
        screen_recording: unsafe { CGPreflightScreenCaptureAccess() },
    }
}

/// The name the privacy database of macOS and `tccutil` use for a permission.
fn privacy_service(permission: Permission) -> &'static str {
    match permission {
        Permission::Accessibility => "Accessibility",
        Permission::ScreenRecording => "ScreenCapture",
    }
}

/// The list in System Settings a permission is granted in.
fn settings_url(permission: Permission) -> String {
    format!("x-apple.systempreferences:com.apple.preference.security?Privacy_{}", privacy_service(permission))
}

/// Ask macOS for one permission and open the list it is granted in.
///
/// The request is what puts LU into that list: macOS shows its own prompt
/// the first time and adds the app with the switch off. After that the
/// request does nothing visible, so the list is opened as well. Call it on
/// the main thread.
pub fn request_permission(permission: Permission) {
    match permission {
        Permission::Accessibility => {
            // enigo asks with the prompt option of the Accessibility API
            // (AXIsProcessTrustedWithOptions).
            let settings = enigo::Settings { open_prompt_to_get_permissions: true, ..enigo::Settings::default() };
            drop(enigo::Enigo::new(&settings));
        }
        Permission::ScreenRecording => {
            unsafe { CGRequestScreenCaptureAccess() };
        }
    }
    let _ = crate::process_util::hidden_command("/usr/bin/open").arg(settings_url(permission)).spawn();
}

/// What `tccutil` is called with to drop LU's entry for one permission.
/// None for an id that is not a plain bundle id: without one `tccutil` would
/// reset that permission for every app on the Mac.
fn forget_arguments(permission: Permission, bundle_id: &str) -> Option<[String; 3]> {
    let plain = bundle_id.starts_with(|c: char| c.is_ascii_alphanumeric())
        && bundle_id.contains('.')
        && bundle_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    plain.then(|| ["reset".to_string(), privacy_service(permission).to_string(), bundle_id.to_string()])
}

/// Make macOS forget what it stored about LU for one permission.
///
/// macOS ties a grant to the signature of the app. The released LU is signed
/// with one fixed identity, so its grant carries over to every update. A test
/// build without that signature is identified by the hash of its code, and an
/// entry it left behind makes the released app a stranger: the list in System
/// Settings still shows LU, even switched on, and the system answers "not
/// granted" all the same (the owner's Mac on 07.10.2026: an Accessibility
/// entry and a Screen Recording entry of two builds from August; on
/// 12.10.2026 a Screen Recording entry of a test build). Dropping the entry
/// lets the next request create one for the copy that is running.
pub fn forget_permission(permission: Permission, bundle_id: &str) -> PlatformResult<()> {
    let failed = || PlatformError::failed("macOS did not remove the old entry of LU. Remove LU from the list in System Settings with the minus button, then try again.");
    let arguments = forget_arguments(permission, bundle_id).ok_or_else(failed)?;
    let status = crate::process_util::hidden_command("/usr/bin/tccutil").args(arguments).status().map_err(|_| failed())?;
    if status.success() {
        Ok(())
    } else {
        Err(failed())
    }
}

fn xcap_failed() -> PlatformError {
    PlatformError::failed("macOS did not hand out the screen or the window list.")
}

struct AppFacts {
    identity: AppIdentity,
    /// An app with a Dock icon and windows of its own.
    regular: bool,
}

fn app_facts(pid: u32, fallback_name: &str) -> AppFacts {
    let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid as libc::pid_t);
    let bundle_id = app.as_ref().and_then(|a| a.bundleIdentifier()).map(|s| s.to_string());
    let name = app.as_ref().and_then(|a| a.localizedName()).map(|s| s.to_string()).filter(|n| !n.trim().is_empty());
    let exe = app.as_ref().and_then(|a| a.executableURL()).and_then(|url| url.path()).map(|s| s.to_string());
    let regular = app.as_ref().is_some_and(|a| a.activationPolicy() == NSApplicationActivationPolicy::Regular);
    let name = name.unwrap_or_else(|| fallback_name.to_string());
    let key = bundle_id.clone().unwrap_or_else(|| name.clone()).to_lowercase();
    AppFacts { identity: AppIdentity { key, name, exe, bundle_id }, regular }
}

/// Windows of regular apps plus the windows of anything on the blocklist,
/// front to back. The Dock, the menu bar and the window server own screen
/// sized layers that are not windows anyone clicks into; counting them would
/// make every click land "in the Dock" and every blocked window look covered.
fn list_windows(own_pid: u32) -> PlatformResult<(Vec<WindowInfo>, Option<u64>)> {
    let windows = xcap::Window::all().map_err(|_| xcap_failed())?;
    let mut facts: HashMap<u32, AppFacts> = HashMap::new();
    let mut out = Vec::new();
    let mut foreground = None;
    for window in windows {
        let (Ok(id), Ok(pid)) = (window.id(), window.pid()) else { continue };
        let fallback = window.app_name().unwrap_or_default();
        let app = facts.entry(pid).or_insert_with(|| app_facts(pid, &fallback));
        let (Ok(x), Ok(y), Ok(width), Ok(height)) = (window.x(), window.y(), window.width(), window.height()) else { continue };
        let info = WindowInfo {
            id: u64::from(id),
            pid,
            app: app.identity.clone(),
            title: window.title().unwrap_or_default(),
            class_name: None,
            rect: Rect::new(x, y, width as i32, height as i32),
            minimized: window.is_minimized().unwrap_or(false),
            // A process of root shows no windows in a user session; the
            // system dialogs that act for it are on the blocklist by name.
            elevated: None,
            is_self: pid == own_pid,
            launcher: false,
            capture_excluded: false,
        };
        if !app.regular && !info.is_self && blocklist::blocked(Platform::MacOs, &info).is_none() {
            continue;
        }
        if info.rect.is_empty() {
            continue;
        }
        if foreground.is_none() && window.is_focused().unwrap_or(false) {
            foreground = Some(info.id);
        }
        out.push(info);
    }
    Ok((out, foreground))
}

impl Desktop for MacDesktop {
    fn platform(&self) -> Platform {
        Platform::MacOs
    }

    fn input_ready(&self) -> PlatformResult<()> {
        if unsafe { AXIsProcessTrusted() } == 0 {
            return Err(no_accessibility());
        }
        Ok(())
    }

    fn monitors(&self) -> PlatformResult<Vec<MonitorInfo>> {
        let mut out = Vec::new();
        for monitor in xcap::Monitor::all().map_err(|_| xcap_failed())? {
            let (Ok(id), Ok(x), Ok(y), Ok(width), Ok(height)) = (monitor.id(), monitor.x(), monitor.y(), monitor.width(), monitor.height()) else {
                continue;
            };
            let scale = monitor.scale_factor().unwrap_or(1.0);
            out.push(MonitorInfo {
                id,
                name: monitor.friendly_name().or_else(|_| monitor.name()).unwrap_or_default(),
                rect: Rect::new(x, y, width as i32, height as i32),
                pixel_width: (width as f32 * scale).round() as u32,
                pixel_height: (height as f32 * scale).round() as u32,
                scale_factor: scale,
                primary: monitor.is_primary().unwrap_or(false),
            });
        }
        if out.is_empty() {
            return Err(xcap_failed());
        }
        Ok(out)
    }

    fn capture(&self, monitor_id: u32) -> PlatformResult<RgbaImage> {
        // Without the permission macOS hands out the wallpaper and nothing else.
        if !unsafe { CGPreflightScreenCaptureAccess() } {
            return Err(no_screen_recording());
        }
        let monitor = xcap::Monitor::all()
            .map_err(|_| xcap_failed())?
            .into_iter()
            .find(|m| m.id().ok() == Some(monitor_id))
            .ok_or_else(|| PlatformError::failed("That display is not connected any more."))?;
        monitor.capture_image().map_err(|_| xcap_failed())
    }

    fn cursor(&self) -> PlatformResult<(i32, i32)> {
        on_main(&self.main, || input::with_enigo(|enigo| enigo.location().map_err(|_| PlatformError::failed("macOS did not report the pointer position."))))
    }

    fn windows(&self) -> PlatformResult<Vec<WindowInfo>> {
        Ok(list_windows(self.own_pid)?.0)
    }

    fn foreground(&self) -> PlatformResult<Option<WindowInfo>> {
        let (windows, foreground) = list_windows(self.own_pid)?;
        Ok(foreground.and_then(|id| windows.into_iter().find(|w| w.id == id)))
    }

    fn focus_window(&self, window: &WindowInfo) -> PlatformResult<()> {
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(window.pid as libc::pid_t)
            .ok_or_else(|| PlatformError::failed("That app is not running any more."))?;
        // macOS brings an app to the front, not one of its windows.
        if !app.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows) {
            return Err(PlatformError::failed("macOS did not let LU bring that app to the front. Click it once yourself, then try again."));
        }
        Ok(())
    }

    fn input(&self, op: &InputOp) -> PlatformResult<()> {
        let op = op.clone();
        on_main(&self.main, move || input::with_enigo(|enigo| input::apply(enigo, &op)))
    }

    fn release_all(&self) {
        let _ = on_main(&self.main, || {
            input::with_enigo(|enigo| {
                input::release_all(enigo);
                Ok(())
            })
        });
    }

    /// Without a tree there is one signal left: macOS turns on secure event
    /// input while a password field has the focus.
    fn focused_element(&self) -> PlatformResult<Option<ElementInfo>> {
        if unsafe { IsSecureEventInputEnabled() } != 0 {
            return Ok(Some(ElementInfo { role: "Edit".to_string(), name: String::new(), password: true }));
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_permission_opens_its_own_list_in_system_settings() {
        assert_eq!(settings_url(Permission::Accessibility), "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
        assert_eq!(settings_url(Permission::ScreenRecording), "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    }

    #[test]
    fn forgetting_names_the_permission_and_only_this_app() {
        assert_eq!(
            forget_arguments(Permission::Accessibility, "com.purpledoubled.locally-uncensored").unwrap(),
            ["reset", "Accessibility", "com.purpledoubled.locally-uncensored"]
        );
        assert_eq!(forget_arguments(Permission::ScreenRecording, "com.example.app").unwrap()[1], "ScreenCapture");
    }

    /// `tccutil reset Accessibility` without an id resets every app.
    #[test]
    fn forgetting_without_a_plain_bundle_id_never_reaches_tccutil() {
        for id in ["", " ", "LU", "com.example.app --all", "com.example/app", "-com.example", "com.example\n"] {
            assert!(forget_arguments(Permission::Accessibility, id).is_none(), "{id:?}");
            assert!(forget_permission(Permission::Accessibility, id).is_err(), "{id:?}");
        }
    }

    #[test]
    fn a_missing_permission_names_itself_in_the_error() {
        assert_eq!(no_accessibility().permission, Some(Permission::Accessibility));
        assert_eq!(no_screen_recording().permission, Some(Permission::ScreenRecording));
        assert!(no_screen_recording().message.contains("restart LU"));
    }
}
