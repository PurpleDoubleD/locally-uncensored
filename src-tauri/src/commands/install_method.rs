//! Who owns the running binary?
//!
//! The updater plugin never asks. It reads a string that the bundler patched
//! into the executable at package time (`__TAURI_BUNDLE_TYPE_VAR_DEB` and
//! friends, tauri-utils-2.8.3/src/platform.rs:349) and treats it as the truth
//! about the machine it is running on. That holds for every install we ship
//! ourselves and breaks for every install somebody else repackaged.
//!
//! The AUR package `locally-uncensored-bin` unpacks our `.deb` into `/usr`.
//! The marker travels with the file, so on Arch the updater picks
//! `linux-x86_64-deb` out of latest.json, downloads a Debian package and runs
//! `pkexec dpkg -i` on a system that has no dpkg. polkit asks for the
//! password first and the command fails afterwards, which is exactly what the
//! customer sees: download fine, password fine, install broken. Full trace in
//! UPDATER-LINUX-BEFUND.md.
//!
//! This module answers the question the plugin skips, by asking the package
//! managers that are actually installed which one of them owns the file. The
//! frontend calls it before it downloads anything and refuses the update on
//! the installs where taking it would be wrong.
//!
//! Deliberately free of every dependency, tauri and serde included: the rules
//! below are the whole fix, and they have to be provable on a real Arch and a
//! real Ubuntu container with nothing but `rustc install_method.rs`. The Tauri
//! command that hands the result to the frontend lives next door in
//! `install_method_cmd.rs`.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How a copy of LU got onto the machine, as far as the machine can tell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallKind {
    /// A single `.AppImage` file the user downloaded. The updater may replace
    /// it in place, provided the folder is writable.
    AppImage,
    /// dpkg owns the file. The updater's `dpkg -i` path is the right one.
    Deb,
    /// rpm owns the file. The updater's `rpm -U` path is the right one.
    Rpm,
    /// pacman owns the file. Nothing may overwrite it behind pacman's back.
    Pacman,
    /// Windows. Msi or Nsis, the updater handles both and the difference does
    /// not change anything we do here.
    Msi,
    /// Nobody claims the file. Includes the dangerous case: a binary under
    /// `/usr` that no package manager knows about, which is a repackaged or
    /// hand-unpacked install.
    Unknown,
}

impl InstallKind {
    /// The wire value. The frontend switches on these strings, so they are
    /// part of the contract and are not to be reworded.
    pub fn as_str(self) -> &'static str {
        match self {
            InstallKind::AppImage => "appimage",
            InstallKind::Deb => "deb",
            InstallKind::Rpm => "rpm",
            InstallKind::Pacman => "pacman",
            InstallKind::Msi => "msi",
            InstallKind::Unknown => "unknown",
        }
    }
}

/// Everything `detect` is allowed to know. One struct so the rules can be
/// tested against an Arch box, an Ubuntu box and a locked-down `/opt` without
/// any of them being present.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Probes {
    /// The `APPIMAGE` variable. Set by the AppImage runtime to the path of the
    /// `.AppImage` file itself, which is also what the updater uses as its
    /// target (tauri-plugin-updater-2.10.1/src/lib.rs:102).
    pub appimage_env: Option<String>,
    /// The file we are asking about. The AppImage path when `APPIMAGE` is set,
    /// otherwise `current_exe()`.
    pub exe_path: PathBuf,
    /// Can this user create a file next to it? `rename` needs write access to
    /// the DIRECTORY, not to the file, and the AppImage path in the updater
    /// starts with exactly that rename (updater.rs:1003).
    pub exe_dir_writable: bool,
    pub has_dpkg: bool,
    pub has_rpm: bool,
    pub has_pacman: bool,
    /// `pacman -Qo <exe>` succeeded.
    pub pacman_owns_exe: bool,
    /// `dpkg -S <exe>` succeeded.
    pub dpkg_owns_exe: bool,
    /// `rpm -qf <exe>` succeeded.
    pub rpm_owns_exe: bool,
}

/// The Linux rules, pure. Order matters: an AppImage carries the marker of
/// whatever bundle it was built from, and a file can be reported by more than
/// one package manager on a box that has several installed.
pub fn detect(p: &Probes) -> InstallKind {
    // An AppImage says so itself, and it is the only kind that knows its own
    // name without asking anybody.
    if p.appimage_env.as_deref().is_some_and(|v| !v.is_empty()) {
        return InstallKind::AppImage;
    }
    // pacman first. It is the one that must never be overruled: on Arch the
    // file under /usr belongs to a package database, and writing past it
    // leaves the database and the disk disagreeing.
    if p.pacman_owns_exe {
        return InstallKind::Pacman;
    }
    if p.dpkg_owns_exe {
        return InstallKind::Deb;
    }
    if p.rpm_owns_exe {
        return InstallKind::Rpm;
    }
    // Nobody owns it. Under /usr that is the Arch case with the AUR helper
    // gone, or a hand-unpacked deb; anywhere else it is a build directory or
    // a tarball. Neither may be overwritten by a package install.
    InstallKind::Unknown
}

/// True when the file sits in the system tree a package manager owns. Only
/// used for the wording of the hint: `detect` answers Unknown either way.
pub fn is_under_usr(exe: &Path) -> bool {
    exe.starts_with("/usr")
}

/// What we tell the user, in English, as a fallback for anything the frontend
/// does not have its own sentence for.
pub fn hint_for(kind: InstallKind, p: &Probes) -> String {
    match kind {
        InstallKind::Pacman => {
            "Installed with pacman. Update it with your package manager, for example \
             yay -Syu locally-uncensored-bin."
                .to_string()
        }
        InstallKind::Deb => {
            "Installed with dpkg. Installing the update runs a package install, and the \
             system asks for your password."
                .to_string()
        }
        InstallKind::Rpm => {
            "Installed with rpm. Installing the update runs a package install, and the \
             system asks for your password."
                .to_string()
        }
        InstallKind::AppImage if p.exe_dir_writable => {
            "Running as an AppImage. The update replaces the file in place.".to_string()
        }
        InstallKind::AppImage => format!(
            "The AppImage sits in a folder you cannot write to ({}).",
            p.exe_path.display()
        ),
        InstallKind::Msi => "Installed with the Windows installer.".to_string(),
        InstallKind::Unknown if is_under_usr(&p.exe_path) => format!(
            "{} is in the system folders and no package manager claims it. It was \
             installed by a repackaged build or a script.",
            p.exe_path.display()
        ),
        InstallKind::Unknown => {
            "LU does not recognise how this copy was installed.".to_string()
        }
    }
}

/// What the frontend gets.
#[derive(Debug, Clone)]
pub struct Report {
    pub kind: InstallKind,
    pub exe_path: String,
    /// Whether the folder holding the executable can be written to. Only
    /// meaningful for the AppImage case, where the update is a file swap.
    pub writable: bool,
    pub hint: String,
}

/// The whole answer for the machine we are on.
pub fn report() -> Report {
    let probes = collect_probes();
    let kind = if cfg!(target_os = "windows") {
        // The updater's msi and nsis paths both work: the installer runs with
        // its own elevation and there is no package database to walk past.
        InstallKind::Msi
    } else if cfg!(target_os = "macos") {
        // No macOS build ships, and a .app in /Applications is fine for the
        // updater anyway: Unknown is "no reason to refuse" off Linux.
        InstallKind::Unknown
    } else {
        detect(&probes)
    };
    Report {
        kind,
        exe_path: probes.exe_path.to_string_lossy().to_string(),
        writable: probes.exe_dir_writable,
        hint: hint_for(kind, &probes),
    }
}

/// A package manager query is allowed this long. `dpkg -S` and `pacman -Qo`
/// answer in milliseconds; `rpm -qf` can be slower on a cold cache. Past this
/// we stop waiting rather than hold up the update check.
const QUERY_TIMEOUT: Duration = Duration::from_secs(4);

/// The facts, read off the real machine.
pub fn collect_probes() -> Probes {
    let appimage_env = std::env::var("APPIMAGE").ok().filter(|v| !v.is_empty());

    // For an AppImage, current_exe() points inside the read-only squashfs
    // mount, which is never what gets replaced. The APPIMAGE path is the file
    // on disk, and it is what the updater targets.
    let exe_path = appimage_env
        .as_deref()
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok())
        .unwrap_or_default();

    collect_probes_for(exe_path, appimage_env)
}

/// The same probes, for a file we name rather than for the running process.
///
/// Split out so the proof can be honest: the containers in
/// UPDATER-LINUX-BEFUND.md run THIS file, unchanged, against the binary the
/// AUR package and the deb actually put on disk. A harness that could only ask
/// about itself would prove nothing about `/usr/bin/locally-uncensored`.
///
/// Every probe is best effort: a missing binary, a permission error and a hung
/// query all answer the same "no".
pub fn collect_probes_for(exe_path: PathBuf, appimage_env: Option<String>) -> Probes {
    let exe_dir_writable = exe_path
        .parent()
        .map(dir_is_writable)
        .unwrap_or(false);

    let mut probes = Probes {
        appimage_env,
        exe_path,
        exe_dir_writable,
        ..Default::default()
    };

    // Only Linux has the three package managers worth asking, and only there
    // does the answer change what the updater is allowed to do.
    if !cfg!(target_os = "linux") {
        return probes;
    }

    probes.has_pacman = on_path("pacman");
    probes.has_dpkg = on_path("dpkg");
    probes.has_rpm = on_path("rpm");

    let exe = probes.exe_path.as_os_str();
    // Short-circuit in the order `detect` uses them, so a box with all three
    // installed still only pays for the query that decides the answer.
    if probes.has_pacman {
        probes.pacman_owns_exe = query_owner("pacman", &[OsStr::new("-Qo"), exe]);
    }
    if !probes.pacman_owns_exe && probes.has_dpkg {
        probes.dpkg_owns_exe = query_owner("dpkg", &[OsStr::new("-S"), exe]);
    }
    if !probes.pacman_owns_exe && !probes.dpkg_owns_exe && probes.has_rpm {
        probes.rpm_owns_exe = query_owner("rpm", &[OsStr::new("-qf"), exe]);
    }

    probes
}

/// A `which` that does not need the `which` crate, so this file stays free of
/// dependencies. Good enough for the three names we ask about.
pub fn on_path(name: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| {
        let candidate = dir.join(name);
        candidate.is_file()
    })
}

/// Run a package manager query and report whether it claimed the file.
///
/// Exit status is the entire answer, so both streams go to /dev/null: nothing
/// is read back, and a child that cannot fill a pipe cannot deadlock on one.
/// A missing binary, a crash and a query that runs past the deadline are all
/// "no" - the caller must not learn anything from a probe that did not finish.
fn query_owner(program: &str, args: &[&OsStr]) -> bool {
    let mut child = match Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };

    let deadline = Instant::now() + QUERY_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Can this user create a file in that directory?
///
/// Asked by trying, because the permission bits alone do not answer it: the
/// mount may be read-only, the directory may belong to root, and on the
/// AppImage path the updater's very first step is a `rename` INTO this
/// directory. The probe file is removed again whether or not the create
/// worked.
pub fn dir_is_writable(dir: &Path) -> bool {
    if dir.as_os_str().is_empty() {
        return false;
    }
    let probe = dir.join(format!(".lu-update-write-probe-{}", std::process::id()));
    let created = std::fs::File::create(&probe).is_ok();
    let _ = std::fs::remove_file(&probe);
    created
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A machine with no package manager and nothing set.
    fn bare() -> Probes {
        Probes {
            exe_path: PathBuf::from("/usr/bin/locally-uncensored"),
            ..Default::default()
        }
    }

    #[test]
    fn the_zen_case_arch_with_the_aur_package() {
        // What the AUR package leaves behind: our deb binary under /usr, owned
        // by pacman, on a box that has never heard of dpkg. The updater would
        // read the patched-in DEB marker and run pkexec dpkg -i here.
        let p = Probes {
            exe_path: PathBuf::from("/usr/bin/locally-uncensored"),
            exe_dir_writable: false,
            has_pacman: true,
            pacman_owns_exe: true,
            ..Default::default()
        };
        assert_eq!(detect(&p), InstallKind::Pacman);
        assert_eq!(detect(&p).as_str(), "pacman");
    }

    #[test]
    fn arch_with_the_deb_merely_unpacked_is_unknown() {
        // Same file, same place, but nobody ran makepkg: the data.tar.gz was
        // extracted straight into /. pacman is installed and disowns it.
        let p = Probes {
            exe_path: PathBuf::from("/usr/bin/locally-uncensored"),
            has_pacman: true,
            pacman_owns_exe: false,
            ..Default::default()
        };
        assert_eq!(detect(&p), InstallKind::Unknown);
        assert!(is_under_usr(&p.exe_path));
        assert!(hint_for(InstallKind::Unknown, &p).contains("no package manager claims it"));
    }

    #[test]
    fn ubuntu_with_our_deb() {
        let p = Probes {
            exe_path: PathBuf::from("/usr/bin/locally-uncensored"),
            has_dpkg: true,
            dpkg_owns_exe: true,
            ..Default::default()
        };
        assert_eq!(detect(&p), InstallKind::Deb);
    }

    #[test]
    fn fedora_with_our_rpm() {
        let p = Probes {
            exe_path: PathBuf::from("/usr/bin/locally-uncensored"),
            has_rpm: true,
            rpm_owns_exe: true,
            ..Default::default()
        };
        assert_eq!(detect(&p), InstallKind::Rpm);
    }

    #[test]
    fn an_appimage_in_the_home_folder() {
        let p = Probes {
            appimage_env: Some("/home/zen/Apps/LU.AppImage".to_string()),
            exe_path: PathBuf::from("/home/zen/Apps/LU.AppImage"),
            exe_dir_writable: true,
            ..Default::default()
        };
        assert_eq!(detect(&p), InstallKind::AppImage);
        assert!(hint_for(InstallKind::AppImage, &p).contains("replaces the file in place"));
    }

    #[test]
    fn an_appimage_in_opt_without_write_rights() {
        // The updater's first step is a rename of this file, which needs write
        // access to /opt. It fails with EACCES and no prompt of any kind.
        let p = Probes {
            appimage_env: Some("/opt/LU.AppImage".to_string()),
            exe_path: PathBuf::from("/opt/LU.AppImage"),
            exe_dir_writable: false,
            ..Default::default()
        };
        assert_eq!(detect(&p), InstallKind::AppImage);
        assert!(!p.exe_dir_writable);
        assert!(hint_for(InstallKind::AppImage, &p).contains("/opt/LU.AppImage"));
    }

    #[test]
    fn an_empty_appimage_variable_does_not_count() {
        // Some launchers export APPIMAGE= with nothing in it.
        let p = Probes {
            appimage_env: Some(String::new()),
            has_dpkg: true,
            dpkg_owns_exe: true,
            ..bare()
        };
        assert_eq!(detect(&p), InstallKind::Deb);
    }

    #[test]
    fn the_appimage_wins_over_the_package_managers() {
        // An AppImage on a Debian box: dpkg may well own an older copy under
        // /usr, but the file we are running is the AppImage.
        let p = Probes {
            appimage_env: Some("/home/zen/LU.AppImage".to_string()),
            exe_path: PathBuf::from("/home/zen/LU.AppImage"),
            exe_dir_writable: true,
            has_dpkg: true,
            dpkg_owns_exe: true,
            ..Default::default()
        };
        assert_eq!(detect(&p), InstallKind::AppImage);
    }

    #[test]
    fn pacman_wins_over_dpkg_when_both_answer() {
        // A box with dpkg installed from the AUR, which happens.
        let p = Probes {
            has_pacman: true,
            has_dpkg: true,
            pacman_owns_exe: true,
            dpkg_owns_exe: true,
            ..bare()
        };
        assert_eq!(detect(&p), InstallKind::Pacman);
    }

    #[test]
    fn a_binary_nobody_owns_outside_usr_is_unknown() {
        let p = Probes {
            exe_path: PathBuf::from("/home/zen/build/locally-uncensored"),
            exe_dir_writable: true,
            has_dpkg: true,
            ..Default::default()
        };
        assert_eq!(detect(&p), InstallKind::Unknown);
        assert!(!is_under_usr(&p.exe_path));
        assert!(hint_for(InstallKind::Unknown, &p).contains("does not recognise"));
    }

    #[test]
    fn every_kind_has_a_stable_wire_name() {
        // The frontend switches on these strings.
        for (kind, name) in [
            (InstallKind::AppImage, "appimage"),
            (InstallKind::Deb, "deb"),
            (InstallKind::Rpm, "rpm"),
            (InstallKind::Pacman, "pacman"),
            (InstallKind::Msi, "msi"),
            (InstallKind::Unknown, "unknown"),
        ] {
            assert_eq!(kind.as_str(), name);
        }
    }

    #[test]
    fn a_missing_program_answers_no_instead_of_panicking() {
        assert!(!query_owner(
            "lu-no-such-package-manager",
            &[OsStr::new("-Qo"), OsStr::new("/usr/bin/locally-uncensored")]
        ));
        assert!(!on_path("lu-no-such-package-manager"));
    }

    #[test]
    fn the_write_probe_leaves_nothing_behind() {
        let dir = std::env::temp_dir();
        assert!(dir_is_writable(&dir));
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .expect("temp dir")
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".lu-update-write-probe-"))
            .collect();
        assert!(leftovers.is_empty(), "probe file was not removed: {leftovers:?}");
        assert!(!dir_is_writable(Path::new("/lu-does-not-exist-at-all")));
    }
}
