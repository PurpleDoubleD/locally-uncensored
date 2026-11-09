//! C9 (3.1.0): the gvfs warning of the AppImage.
//!
//! Started from the AppImage on a newer distribution (Debian 13, Ubuntu 24.04,
//! Fedora), LU printed
//!
//! ```text
//! Failed to load module: /usr/lib/x86_64-linux-gnu/gio/modules/libgvfsdbus.so
//! … libgvfscommon.so: undefined symbol: g_task_set_static_name
//! ```
//!
//! and on closing the same for dconf and libproxy. The AppImage is built on
//! Ubuntu 22.04 and carries that GLib (2.72). Its libgio looks for modules in
//! the directory it was compiled with, which is the HOST's
//! `/usr/lib/x86_64-linux-gnu/gio/modules`, and the host's modules there are
//! built against its newer GLib and need symbols 2.72 does not have. GIO skips
//! them, so the lines were harmless, but they are the first thing a user sees
//! in a terminal and they read like the crash (P10 report, GitHub #208).
//!
//! linuxdeploy's gtk hook only sets `GIO_EXTRA_MODULES` to the AppImage's own
//! module folder (which holds the TLS module, built against 2.72), it never
//! replaces the default. This does: `GIO_MODULE_DIR` points at the bundled
//! folder, so GIO loads its TLS module and nothing it cannot load.
//!
//! Only when the host's GLib is NEWER than the bundled one. With the same or an
//! older one the host modules load fine (gvfs, dconf, the proxy resolver) and
//! taking them away would cost something. On those hosts nothing changes.
//! A `GIO_MODULE_DIR` the user set is never touched, and child processes do
//! not inherit this one: `process_util::APPIMAGE_ENV_VARS` already strips a
//! value that points into the AppImage before a foreign program is started.

use std::path::{Path, PathBuf};

/// The bundled module folder inside the AppImage (linuxdeploy-plugin-gtk).
pub(crate) const BUNDLED_MODULES: &str = "usr/lib/x86_64-linux-gnu/gio/modules";
/// The bundled libgio.
pub(crate) const BUNDLED_GIO: &str = "usr/lib/libgio-2.0.so.0";
/// The host libgio next to the module folder the bundled libgio searches.
pub(crate) const HOST_GIO: &str = "/usr/lib/x86_64-linux-gnu/libgio-2.0.so.0";

/// GLib's minor version from a resolved library file name,
/// `libgio-2.0.so.0.7200.4` → 72. GLib encodes `2.MINOR.MICRO` as
/// `so.0.(MINOR*100).MICRO`.
pub(crate) fn glib_minor_from_soname(file_name: &str) -> Option<u32> {
    let rest = file_name.split(".so.0.").nth(1)?;
    let encoded: u32 = rest.split('.').next()?.parse().ok()?;
    if encoded < 100 {
        return None;
    }
    Some(encoded / 100)
}

/// Everything the decision may know. Read from the machine in `apply`,
/// handed in by hand in the tests.
#[derive(Debug, Default)]
pub(crate) struct GioSituation {
    pub(crate) appdir: Option<String>,
    pub(crate) user_set: bool,
    pub(crate) bundled_dir_exists: bool,
    pub(crate) bundled_minor: Option<u32>,
    pub(crate) host_minor: Option<u32>,
}

/// The folder to put into `GIO_MODULE_DIR`, or None to leave GIO alone.
pub(crate) fn gio_module_dir(s: &GioSituation) -> Option<PathBuf> {
    let appdir = s.appdir.as_deref().filter(|d| !d.is_empty())?;
    if s.user_set || !s.bundled_dir_exists {
        return None;
    }
    match (s.bundled_minor, s.host_minor) {
        (Some(bundled), Some(host)) if host > bundled => Some(Path::new(appdir).join(BUNDLED_MODULES)),
        _ => None,
    }
}

fn resolved_minor(path: &Path) -> Option<u32> {
    let real = std::fs::canonicalize(path).ok()?;
    glib_minor_from_soname(real.file_name()?.to_str()?)
}

/// Read the machine, decide, set, and say so. Called before GTK starts.
pub(crate) fn apply() {
    let appdir = std::env::var("APPDIR").ok();
    let situation = GioSituation {
        user_set: std::env::var_os("GIO_MODULE_DIR").is_some(),
        bundled_dir_exists: appdir
            .as_deref()
            .is_some_and(|d| Path::new(d).join(BUNDLED_MODULES).is_dir()),
        bundled_minor: appdir.as_deref().and_then(|d| resolved_minor(&Path::new(d).join(BUNDLED_GIO))),
        host_minor: resolved_minor(Path::new(HOST_GIO)),
        appdir,
    };
    if let Some(dir) = gio_module_dir(&situation) {
        // println! like the webview variables next to it: the tracing writer is
        // not up yet, and this belongs in a terminal start.
        println!(
            "[Linux] GLib 2.{} on this system is newer than the AppImage's 2.{}: GIO_MODULE_DIR={} \
             (only the bundled GIO modules, the system's cannot load here).",
            situation.host_minor.unwrap_or(0),
            situation.bundled_minor.unwrap_or(0),
            dir.display()
        );
        std::env::set_var("GIO_MODULE_DIR", dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_minor_version_comes_from_the_resolved_file_name() {
        assert_eq!(glib_minor_from_soname("libgio-2.0.so.0.7200.4"), Some(72));
        assert_eq!(glib_minor_from_soname("libgio-2.0.so.0.8400.2"), Some(84));
        assert_eq!(glib_minor_from_soname("libglib-2.0.so.0.8000.0"), Some(80));
        // The unresolved symlink names carry no version.
        assert_eq!(glib_minor_from_soname("libgio-2.0.so.0"), None);
        assert_eq!(glib_minor_from_soname("libgio-2.0.so"), None);
        assert_eq!(glib_minor_from_soname("libgio-2.0.so.0.x.1"), None);
    }

    fn newer_host() -> GioSituation {
        GioSituation {
            appdir: Some("/tmp/.mount_LU".into()),
            user_set: false,
            bundled_dir_exists: true,
            bundled_minor: Some(72),
            host_minor: Some(84),
        }
    }

    #[test]
    fn a_newer_host_glib_gets_the_bundled_folder() {
        assert_eq!(
            gio_module_dir(&newer_host()),
            Some(PathBuf::from("/tmp/.mount_LU/usr/lib/x86_64-linux-gnu/gio/modules"))
        );
    }

    #[test]
    fn the_same_or_an_older_host_keeps_its_modules() {
        // Ubuntu 22.04 itself: gvfs, dconf and the proxy resolver load fine.
        assert_eq!(gio_module_dir(&GioSituation { host_minor: Some(72), ..newer_host() }), None);
        assert_eq!(gio_module_dir(&GioSituation { host_minor: Some(70), ..newer_host() }), None);
    }

    #[test]
    fn nothing_changes_outside_an_appimage_or_against_the_user() {
        assert_eq!(gio_module_dir(&GioSituation { appdir: None, ..newer_host() }), None);
        assert_eq!(gio_module_dir(&GioSituation { appdir: Some(String::new()), ..newer_host() }), None);
        assert_eq!(gio_module_dir(&GioSituation { user_set: true, ..newer_host() }), None);
    }

    #[test]
    fn without_a_bundled_folder_or_a_known_version_nothing_is_set() {
        // An empty folder would take the TLS module away and break HTTPS in
        // the webview.
        assert_eq!(gio_module_dir(&GioSituation { bundled_dir_exists: false, ..newer_host() }), None);
        // Arch keeps its libgio in /usr/lib, not where the bundled libgio
        // looks for modules: nothing there to fail, nothing to change.
        assert_eq!(gio_module_dir(&GioSituation { host_minor: None, ..newer_host() }), None);
        assert_eq!(gio_module_dir(&GioSituation { bundled_minor: None, ..newer_host() }), None);
    }

    #[test]
    fn a_child_never_inherits_it() {
        // GIO_MODULE_DIR is on the list of variables a foreign spawn gets
        // cleaned of when they point into the AppImage.
        assert!(crate::process_util::APPIMAGE_ENV_VARS.iter().any(|(k, _)| *k == "GIO_MODULE_DIR"));
    }
}
