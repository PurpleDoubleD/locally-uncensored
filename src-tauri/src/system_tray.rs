// Is there a system tray this process can build, and what does the close
// button do when there is none?
//
// GH #204 (3.0.8, CachyOS): the AppImage aborted at start with
// "Failed to load ayatana-appindicator3 or appindicator3 dynamic library".
// On Linux the tray is an AppIndicator, and `libappindicator-sys` 0.9 loads
// that library with `dlopen` inside a lazy static and `panic!`s when neither
// name loads. The release profile has `panic = "abort"`, so no catch_unwind
// can stop it: the only way to start without a tray is to not build one.
// This module asks the dynamic loader the same question first.

/// The names `libappindicator-sys` 0.9.0 tries, in its order (src/lib.rs, the
/// `LIB` static; the `.so` fallbacks sit behind its `backcompat` feature,
/// which `tray-icon` 0.21 does not turn on). If none of these loads here, the
/// crate panics when the tray is built.
pub(crate) const APPINDICATOR_LIBS: &[&str] =
    &["libayatana-appindicator3.so.1", "libappindicator3.so.1"];

/// The line a user reads in the terminal when LU started without a tray.
pub(crate) const NO_TRAY_LOG: &str = "[Tray] No system tray: neither libayatana-appindicator3.so.1 \
     nor libappindicator3.so.1 could be loaded. LU runs without a tray icon, and closing the \
     window quits LU. Install libayatana-appindicator (Arch: libayatana-appindicator, \
     Debian/Ubuntu: libayatana-appindicator3-1, Fedora: libayatana-appindicator-gtk3) to get it back.";

/// Can the tray be built? `loads` answers whether one library name loads,
/// injected so every branch runs on a Mac too.
pub(crate) fn tray_available(linux: bool, loads: impl Fn(&str) -> bool) -> bool {
    !linux || APPINDICATOR_LIBS.iter().any(|name| loads(name))
}

/// Does the close button hide the window to the tray? Only when there is a
/// tray to bring it back from. Without one a hidden window could never be
/// shown again and the process would sit there with the GPU still full, so
/// the button quits instead, through the same shutdown as the tray's Quit.
pub(crate) fn close_hides_to_tray(tray_present: bool) -> bool {
    tray_present
}

/// The real loader, the same call `libloading` makes for the crate (dlopen
/// with RTLD_NOW). The handle is closed again; the crate opens its own.
#[cfg(target_os = "linux")]
pub(crate) fn dlopen_loads(name: &str) -> bool {
    let Ok(c) = std::ffi::CString::new(name) else {
        return false;
    };
    // SAFETY: a plain dlopen/dlclose pair on a NUL-terminated name. The
    // library's constructors run, which the tray build would do anyway.
    unsafe {
        let handle = libc::dlopen(c.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL);
        if handle.is_null() {
            return false;
        }
        libc::dlclose(handle);
    }
    true
}

/// The answer for this process.
#[cfg(desktop)]
pub(crate) fn system_tray_available() -> bool {
    #[cfg(target_os = "linux")]
    let available = tray_available(true, dlopen_loads);
    #[cfg(not(target_os = "linux"))]
    let available = tray_available(false, |_| true);
    if !available {
        // println! as well as tracing, like the Wayland lines: a user who
        // starts the AppImage from a terminal must see why there is no icon.
        println!("{NO_TRAY_LOG}");
        tracing::warn!(target: "tray", "{NO_TRAY_LOG}");
    }
    available
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_appindicator_library_means_no_tray_on_linux() {
        assert!(!tray_available(true, |_| false));
    }

    #[test]
    fn either_appindicator_name_is_enough() {
        assert!(tray_available(true, |n| n == "libayatana-appindicator3.so.1"));
        assert!(tray_available(true, |n| n == "libappindicator3.so.1"));
    }

    #[test]
    fn the_probe_asks_for_exactly_the_names_the_crate_loads() {
        // A `.so` without the ABI suffix would make the probe say yes while
        // libappindicator-sys (no backcompat feature) still panics.
        assert!(!tray_available(true, |n| n == "libayatana-appindicator3.so"));
        assert!(!tray_available(true, |n| n == "libappindicator3.so"));
    }

    #[test]
    fn mac_and_windows_always_have_a_tray() {
        assert!(tray_available(false, |_| false));
    }

    #[test]
    fn without_a_tray_the_close_button_quits() {
        assert!(!close_hides_to_tray(false));
        assert!(close_hides_to_tray(true));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_real_loader_says_no_to_a_library_that_does_not_exist() {
        assert!(!dlopen_loads("liblu-p10-does-not-exist.so.1"));
        assert!(dlopen_loads("libc.so.6"));
    }

    #[test]
    fn the_name_list_matches_the_locked_libappindicator_sys() {
        // The list above is copied from libappindicator-sys 0.9.0. A bump of
        // that crate can change the names; this makes the bump look here.
        let lock = include_str!("../Cargo.lock");
        let pos = lock
            .find("name = \"libappindicator-sys\"\nversion = \"")
            .expect("libappindicator-sys in Cargo.lock");
        let version = &lock[pos..].lines().nth(1).unwrap();
        assert_eq!(*version, "version = \"0.9.0\"", "check APPINDICATOR_LIBS against the new crate");
    }
}
