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
/// `reasons` is what the loader said for each name: "cannot open shared
/// object file" means the package is missing, an "undefined symbol" means it
/// is there but does not fit the libraries this build runs with.
pub(crate) fn no_tray_log(reasons: &[String]) -> String {
    format!(
        "[Tray] No system tray: {}. LU runs without a tray icon, and closing the window \
         quits LU. If the library is not installed, install libayatana-appindicator \
         (Arch: libayatana-appindicator, Debian/Ubuntu: libayatana-appindicator3-1, \
         Fedora: libayatana-appindicator-gtk3) to get it back.",
        reasons.join("; ")
    )
}

/// Can the tray be built? `loads` answers whether one library name loads,
/// injected so every branch runs on a Mac too.
pub(crate) fn tray_available(linux: bool, loads: impl Fn(&str) -> bool) -> bool {
    !linux || APPINDICATOR_LIBS.iter().any(|name| loads(name))
}

/// The loader's answer per name, turned into "tray or not" and the reasons
/// for the log. A name counts only when ITS dlopen succeeded: the message of
/// a failed one may name a different file (a dependency with an undefined
/// symbol), so it is never matched against the name.
pub(crate) fn probe_outcome(linux: bool, probed: Vec<(&str, Option<String>)>) -> (bool, Vec<String>) {
    let available = tray_available(linux, |name| {
        probed.iter().any(|(n, err)| *n == name && err.is_none())
    });
    let reasons = probed.into_iter().filter_map(|(_, err)| err).collect();
    (available, reasons)
}

/// Does the close button hide the window to the tray? Only when there is a
/// tray to bring it back from. Without one a hidden window could never be
/// shown again and the process would sit there with the GPU still full, so
/// the button quits instead, through the same shutdown as the tray's Quit.
pub(crate) fn close_hides_to_tray(tray_present: bool) -> bool {
    tray_present
}

/// The real loader, the same call `libloading` makes for the crate (dlopen
/// with RTLD_NOW). None when the library loads (the handle is closed again,
/// the crate opens its own), otherwise the loader's own message.
#[cfg(target_os = "linux")]
pub(crate) fn dlopen_error(name: &str) -> Option<String> {
    let Ok(c) = std::ffi::CString::new(name) else {
        return Some(format!("{name}: invalid name"));
    };
    // SAFETY: a plain dlopen/dlclose pair on a NUL-terminated name, and
    // dlerror read right after the failed call on the same thread. The
    // library's constructors run, which the tray build would do anyway.
    unsafe {
        let handle = libc::dlopen(c.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL);
        if handle.is_null() {
            let err = libc::dlerror();
            if err.is_null() {
                return Some(format!("{name}: cannot be loaded"));
            }
            return Some(std::ffi::CStr::from_ptr(err).to_string_lossy().into_owned());
        }
        libc::dlclose(handle);
    }
    None
}

/// The answer for this process.
#[cfg(desktop)]
pub(crate) fn system_tray_available() -> bool {
    #[cfg(target_os = "linux")]
    let probed: Vec<(&str, Option<String>)> =
        APPINDICATOR_LIBS.iter().map(|n| (*n, dlopen_error(n))).collect();
    #[cfg(not(target_os = "linux"))]
    let probed: Vec<(&str, Option<String>)> = Vec::new();
    let (available, reasons) = probe_outcome(cfg!(target_os = "linux"), probed);
    if !available {
        // println! as well as tracing, like the Wayland lines: a user who
        // starts the AppImage from a terminal must see why there is no icon.
        let line = no_tray_log(&reasons);
        println!("{line}");
        tracing::warn!(target: "tray", "{line}");
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
    fn a_dependency_with_an_undefined_symbol_means_no_tray() {
        // GH #204 on Arch with the package installed: the system dbusmenu
        // needs a newer GLib than the AppImage carries.
        let (available, reasons) = probe_outcome(
            true,
            vec![
                ("libayatana-appindicator3.so.1", Some("/usr/lib/libdbusmenu-glib.so.4: undefined symbol: g_once_init_leave_pointer".into())),
                ("libappindicator3.so.1", Some("libappindicator3.so.1: cannot open shared object file".into())),
            ],
        );
        assert!(!available);
        assert_eq!(reasons.len(), 2);
        let (available, reasons) = probe_outcome(true, vec![("libayatana-appindicator3.so.1", None), ("libappindicator3.so.1", Some("x".into()))]);
        assert!(available);
        assert_eq!(reasons, vec!["x".to_string()]);
    }

    #[test]
    fn the_log_line_carries_the_loaders_reason() {
        let line = no_tray_log(&[
            "/usr/lib/libdbusmenu-glib.so.4: undefined symbol: g_once_init_leave_pointer".into(),
            "libappindicator3.so.1: cannot open shared object file: No such file or directory".into(),
        ]);
        assert!(line.starts_with("[Tray] No system tray: /usr/lib/libdbusmenu-glib.so.4: undefined symbol"));
        assert!(line.contains("closing the window quits LU"));
        assert!(line.contains("libayatana-appindicator3-1"));
    }

    #[test]
    fn without_a_tray_the_close_button_quits() {
        assert!(!close_hides_to_tray(false));
        assert!(close_hides_to_tray(true));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_real_loader_says_no_to_a_library_that_does_not_exist() {
        let err = dlopen_error("liblu-p10-does-not-exist.so.1").expect("must not load");
        assert!(err.contains("liblu-p10-does-not-exist.so.1"), "{err}");
        assert_eq!(dlopen_error("libc.so.6"), None);
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
