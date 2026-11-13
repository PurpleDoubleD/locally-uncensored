//! Process spawning + lifecycle helpers used by ComfyUI / LM Studio / Claude
//! Code lifecycle commands.
//!
//! On Windows we use Job Objects (KILL_ON_JOB_CLOSE) so any child process tree
//! gets cleaned up when the bridge exits, and prefer `taskkill /T /F` for
//! recursive kills. On Unix `kill_tree` walks the real parent/child links: a
//! process-group kill only reaches children that were put in a group at spawn,
//! which is true for `spawn_piped` but not for every caller.

use std::process::{Child, Command, Stdio};

#[cfg(windows)]
pub fn no_window() -> u32 {
    0x08000000 // CREATE_NO_WINDOW
}

/// Suppress the console window for a std `Command` on Windows (CREATE_NO_WINDOW);
/// no-op elsewhere. Use for every CLI we shell out to (lms, git, python probes)
/// so users don't get console flashes.
pub fn suppress_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(no_window());
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

// ── K11/K14: foreign programs vs. our own bundled sidecars on Linux AppImage ─
//
// K2/K11 (Discord, 2026-09-16, CachyOS/Arch AppImage): after an
// in-app update, `git clone` inside the app failed with "no version
// information available" and custom-node installs broke the same way.
// Reinstalling did not help.
//
// linuxdeploy's AppRun exports `LD_LIBRARY_PATH` by PREPENDING
// `$APPDIR/usr/lib[/x86_64-linux-gnu]` onto whatever the shell already had,
// so it is inherited by every child process, including a system `git` found
// on PATH. On Arch/CachyOS, whose `libpcre2-8`/`libssl` are newer than the
// ones linuxdeploy bundled for the build host, the system `git` binary links
// against ITS OWN system libpcre2/libssl by SONAME, the dynamic loader finds
// LU's older bundled copies FIRST because of the inherited path, and either
// a symbol-versioning mismatch ("no version information available") or an
// outright crash follows. Our own bundled sidecars (the llama.cpp server,
// `whisper_server.py`'s interpreter, ...) need exactly the libraries that
// variable points at, so this fix is scoped per spawned command instead of
// touching the process-wide environment: only the one child actually being
// started gets the cleaned value.
//
// K14 (Reddit, Linux, 2026-09-17) is the same bug one variable over: a
// ComfyUI venv's own `_ssl` extension failed to load under the same
// inherited `LD_LIBRARY_PATH`, and LU's diagnosis misread the resulting
// ImportError as "this Python was built without ssl". The original fix
// above covered only `LD_LIBRARY_PATH` because that was the one variable
// K11's report named; K14 generalises it to the whole table linuxdeploy's
// AppRun is known to set (below), since nothing about the git bug was
// specific to that one variable.

/// K14 (Reddit, Linux, 2026-09-17): the same poisoning K11 fixed for
/// `LD_LIBRARY_PATH` also broke a ComfyUI venv's own `_ssl` extension after
/// an in-app AppImage update, `import ssl` failed inside a bundled
/// `LD_LIBRARY_PATH`, and LU's own diagnosis then misread that as "this
/// Python was built without ssl" and sent the customer to reinstall Python,
/// which fixes nothing. `LD_LIBRARY_PATH` was never the only variable
/// linuxdeploy's AppRun exports for the bundle: PATH, PYTHONHOME, PYTHONPATH,
/// the GLib/GTK/GStreamer module-search variables, XDG_DATA_DIRS and the two
/// SSL_CERT_* variables (the last a common source of a Python that "loses"
/// its certificate bundle after being pointed at an AppImage-internal one)
/// are all in the same boat: a foreign program that inherits them looks
/// inside the AppImage mount for things that live at a different version, or
/// not at all, there.
///
/// Two shapes, because the two kinds of variable break differently:
///   * `PathList`: colon-separated, like `LD_LIBRARY_PATH`. Only the
///     AppImage-mount ENTRIES are removed, the rest of the list survives.
///   * `SingleValue`: one path. If it points inside the AppImage mount at
///     all, the whole variable is unset: there is no "the rest of it" to
///     keep, and a foreign program reading it half-stripped would be reading
///     a path segment, not a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VarShape {
    PathList,
    SingleValue,
}

/// Every environment variable a linuxdeploy-built AppRun is known to set or
/// prepend onto, in the order a foreign spawn should have them cleaned.
pub const APPIMAGE_ENV_VARS: &[(&str, VarShape)] = &[
    ("LD_LIBRARY_PATH", VarShape::PathList),
    ("PATH", VarShape::PathList),
    ("PYTHONHOME", VarShape::SingleValue),
    ("PYTHONPATH", VarShape::PathList),
    ("GIO_MODULE_DIR", VarShape::SingleValue),
    ("GTK_PATH", VarShape::PathList),
    ("GTK_EXE_PREFIX", VarShape::SingleValue),
    ("GDK_PIXBUF_MODULE_FILE", VarShape::SingleValue),
    ("GST_PLUGIN_SYSTEM_PATH", VarShape::PathList),
    ("GST_PLUGIN_SYSTEM_PATH_1_0", VarShape::PathList),
    ("XDG_DATA_DIRS", VarShape::PathList),
    ("SSL_CERT_FILE", VarShape::SingleValue),
    ("SSL_CERT_DIR", VarShape::SingleValue),
];

/// A poisoned path-shaped entry never had a fallback of "/usr/bin without
/// the trailing slash landing inside a differently-named mount": Review
/// Runde 2, Punkt 9 named `/tmp/.mount_ABC` wrongly matching
/// `/tmp/.mount_ABCDEF/lib` under a bare `starts_with`. An entry counts as
/// inside `appdir` only if it IS `appdir`, or starts with `appdir` followed
/// by a path separator.
fn inside_appdir(entry: &str, appdir: &str) -> bool {
    entry == appdir || entry.starts_with(&format!("{appdir}/"))
}

/// PATH is never fully removed even when every inherited entry pointed
/// inside the AppImage mount (Review Runde 2, Punkt 10): a child with NO
/// PATH at all can only find a program through glibc's compiled-in default,
/// which is narrower than what any real shell offers and breaks lookups by
/// bare name (`Command::new("git")`) outright. This is the same base list
/// `/etc/environment` ships on Debian/Ubuntu/Arch by default.
pub const APPIMAGE_PATH_FALLBACK: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// What a single foreign-spawn variable should become, given the value this
/// process inherited, the AppImage's own mount point, and a fallback to use
/// if stripping would otherwise leave nothing at all (PATH only, Punkt 10
/// above; every other variable passes `None` here since an unset
/// PYTHONHOME/SSL_CERT_FILE/... is a perfectly normal, correct state).
///
/// Runde 3, Nachbesserung 8: this used to also accept a runtime-saved
/// `original: Option<&str>` and restore `APPIMAGE_ORIGINAL_<VAR>` when
/// present (Review Runde 2, Punkt 8's comment claimed "several AppRun
/// builds export" that variable). That claim could not be substantiated:
/// no AppRun source is vendored in this tree, and neither linuxdeploy's nor
/// AppImageKit's public repositories (checked by code search) define or
/// reference `APPIMAGE_ORIGINAL_` anywhere. Per the coordinator's explicit
/// instruction for an unbelegte claim like this, the branch is removed
/// rather than kept as unverified, dead-in-practice logic; the safe half
/// (filtering out entries under the AppImage mount, PATH's fallback to a
/// fixed base list) is unaffected and is all that remains.
///
/// Pure and testable off any platform: no `std::env` read happens here, only
/// in [`strip_appimage_env`] which calls this once per variable in
/// [`APPIMAGE_ENV_VARS`]. Returns:
///   * `None`: leave the variable exactly as inherited.
///   * `Some(None)`: remove the variable (a `SingleValue` that pointed
///     inside the AppImage, or a `PathList` whose every entry did and had
///     no fallback).
///   * `Some(Some(v))`: set the variable to `v`, either the fallback or (a
///     `PathList`) whatever survived filtering.
pub fn sanitized_env_value(
    shape: VarShape,
    current: &str,
    appdir: &str,
    empty_fallback: Option<&str>,
) -> Option<Option<String>> {
    if current.is_empty() {
        return None;
    }
    let appdir = appdir.trim_end_matches('/');
    if appdir.is_empty() {
        return None;
    }
    match shape {
        VarShape::SingleValue => {
            if inside_appdir(current, appdir) {
                Some(None)
            } else {
                None
            }
        }
        VarShape::PathList => {
            let entries: Vec<&str> = current.split(':').collect();
            let kept: Vec<&str> = entries
                .iter()
                .copied()
                .filter(|entry| !inside_appdir(entry, appdir) || entry.is_empty())
                .collect();
            if kept.len() == entries.len() {
                None
            } else if !kept.is_empty() {
                Some(Some(kept.join(":")))
            } else if let Some(fallback) = empty_fallback {
                Some(Some(fallback.to_string()))
            } else {
                Some(None)
            }
        }
    }
}

/// Clean every variable in [`APPIMAGE_ENV_VARS`] on a child `Command` for a
/// FOREIGN system program. No-op whenever `APPDIR` is unset, every platform
/// and packaging but a running Linux AppImage, so this is safe to call
/// unconditionally.
pub fn strip_appimage_env(cmd: &mut Command) {
    apply_appimage_env(&std_env_reader, |var, value| match value {
        Some(v) => { cmd.env(var, v); }
        None => { cmd.env_remove(var); }
    });
}

/// The two adapters below (`strip_appimage_env` for `std::process::Command`,
/// `strip_appimage_env_tokio` for `tokio::process::Command`) both funnel
/// through this one, plain function so the decision logic exists exactly
/// once. Review Runde 2, Punkt 6: `tokio::process::Command` is a DIFFERENT
/// type from `std::process::Command` (it wraps one, but does not deref to
/// it), so the original `strip_appimage_env(&mut std::process::Command)`
/// could not be called at all from `bg_tasks.rs`/`remote.rs`'s tokio spawns,
/// leaving that whole class of call sites structurally unable to clean up
/// even if someone remembered to.
///
/// `read_env` is the `std::env::var`-shaped lookup (swappable in tests, see
/// `apply_appimage_env_over_a_map_without_touching_the_process`), `set` and
/// `remove` are the two operations both `Command` types expose under
/// different method names but the same signatures.
fn apply_appimage_env(read_env: &dyn Fn(&str) -> Option<String>, mut apply: impl FnMut(&str, Option<&str>)) {
    let Some(appdir) = read_env("APPDIR") else { return };
    for &(var, shape) in APPIMAGE_ENV_VARS {
        let Some(current) = read_env(var) else { continue };
        let fallback = if var == "PATH" { Some(APPIMAGE_PATH_FALLBACK) } else { None };
        match sanitized_env_value(shape, &current, &appdir, fallback) {
            Some(Some(clean)) => apply(var, Some(&clean)),
            Some(None) => apply(var, None),
            None => {}
        }
    }
}

fn std_env_reader(var: &str) -> Option<String> {
    std::env::var(var).ok()
}

/// Clean every variable in [`APPIMAGE_ENV_VARS`] on a child
/// `tokio::process::Command` for a FOREIGN system program. Same rules as
/// [`strip_appimage_env`]; the two exist because tokio's `Command` is not
/// the same type as `std::process::Command` and cannot share one function
/// signature with it, only the logic in [`apply_appimage_env`].
pub fn strip_appimage_env_tokio(cmd: &mut tokio::process::Command) {
    apply_appimage_env(&std_env_reader, |var, value| match value {
        Some(v) => { cmd.env(var, v); }
        None => { cmd.env_remove(var); }
    });
}

/// Build a `Command` for a FOREIGN system program, `git`, a system Python
/// interpreter, `pip`, a system `ffmpeg`, `nvidia-smi`, `rocm-smi`,
/// `xdg-open`, `uv`: anything on `$PATH` that LU did not build and does not
/// bundle. Use this instead of a bare `Command::new` at every such call
/// site: it clears the AppImage's own environment out of the child (K11,
/// K14) so a foreign binary loads the SYSTEM libraries and modules it
/// actually links against, never our bundled copies. A no-op everywhere but
/// a running Linux AppImage.
///
/// Do NOT use this for our own bundled sidecars, call `Command::new`
/// directly for those, exactly as before: they are built against and need
/// exactly the AppImage-bundled libraries this strips out.
pub fn foreign_system_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut cmd = Command::new(program);
    strip_appimage_env(&mut cmd);
    cmd
}

/// Same as [`foreign_system_command`], for `tokio::process::Command` call
/// sites (`bg_tasks.rs`, `remote.rs`).
pub fn foreign_system_command_tokio<S: AsRef<std::ffi::OsStr>>(program: S) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    strip_appimage_env_tokio(&mut cmd);
    cmd
}

/// `APPDIR` and the variables it poisons are PROCESS-WIDE `std::env` state,
/// and `cargo test` runs every test in this binary concurrently on one
/// process. Any test anywhere in the crate that sets or reads `APPDIR` (this
/// module's own, and `commands::trainer`'s B1 proof that trainer-specific
/// variables survive the cleanup) takes this ONE crate-wide lock first, or
/// two such tests running on different threads can observe each other's
/// `APPDIR` mid-mutation -- an intermittent failure that has nothing to do
/// with the code under test. `#[cfg(test)]`-only: never reachable from
/// shipping code, so it needs no entry in `command_new_coverage_guard`.
#[cfg(test)]
pub(crate) fn appimage_env_test_guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod appimage_env_tests {
    use super::*;

    /// Delegates to the crate-wide guard so this module's own APPDIR tests
    /// and `commands::trainer`'s take the same lock, see
    /// [`appimage_env_test_guard`].
    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        appimage_env_test_guard()
    }

    /// Most tests below care only about the mount-stripping behaviour, not
    /// about a fallback: this pins the common call shape so those tests
    /// stay readable.
    fn sanitize(shape: VarShape, current: &str, appdir: &str) -> Option<Option<String>> {
        sanitized_env_value(shape, current, appdir, None)
    }

    #[test]
    fn appimage_entries_are_dropped_and_the_rest_survives() {
        let appdir = "/tmp/.mount_LocallieGkad";
        let current = "/tmp/.mount_LocallieGkad/usr/lib:/tmp/.mount_LocallieGkad/usr/lib/x86_64-linux-gnu:/usr/local/lib";
        let clean = sanitize(VarShape::PathList, current, appdir)
            .expect("appimage entries were present and should have been stripped")
            .expect("one entry survives, so this is a Some(value), not a removal");
        assert_eq!(clean, "/usr/local/lib");
        assert!(!clean.contains(".mount_LocallieGkad"));
    }

    #[test]
    fn a_value_with_nothing_from_the_appimage_is_left_alone() {
        // Negative control: a user who set LD_LIBRARY_PATH themselves, or an
        // AppImage runtime with nothing prepended, must not be rewritten ,
        // rewriting an unrelated value could break the very thing the user set.
        assert_eq!(sanitize(VarShape::PathList, "/usr/local/lib:/opt/cuda/lib64", "/tmp/.mount_x"), None);
        assert_eq!(sanitize(VarShape::PathList, "", "/tmp/.mount_x"), None);
        assert_eq!(sanitize(VarShape::PathList, "/usr/local/lib", ""), None);
    }

    #[test]
    fn a_trailing_slash_on_appdir_does_not_break_the_match() {
        let appdir = "/tmp/.mount_LocallieGkad/";
        let current = "/tmp/.mount_LocallieGkad/usr/lib:/usr/local/lib";
        assert_eq!(
            sanitize(VarShape::PathList, current, appdir),
            Some(Some("/usr/local/lib".to_string())),
        );
    }

    // ── Review Runde 2, Punkt 9: a prefix match needs a path boundary ──────

    #[test]
    fn a_mount_name_that_prefixes_another_mount_name_does_not_false_match() {
        // `/tmp/.mount_ABC` must not swallow a SIBLING mount
        // `/tmp/.mount_ABCDEF` just because one string starts with the
        // other. Only an exact segment match or a `/`-bounded prefix counts.
        let appdir = "/tmp/.mount_ABC";
        let current = "/tmp/.mount_ABCDEF/lib:/usr/local/lib";
        assert_eq!(
            sanitize(VarShape::PathList, current, appdir),
            None,
            "a differently-named sibling mount must not be treated as inside appdir"
        );
    }

    #[test]
    fn the_appdir_entry_itself_without_a_trailing_component_still_matches() {
        let appdir = "/tmp/.mount_ABC";
        let current = "/tmp/.mount_ABC:/usr/local/lib";
        assert_eq!(
            sanitize(VarShape::PathList, current, appdir),
            Some(Some("/usr/local/lib".to_string())),
            "the bare appdir entry itself is still inside appdir"
        );
    }

    // ── Runde 3, Nachbesserung 8: no APPIMAGE_ORIGINAL_* restore ────────────
    //
    // The restore branch (Review Runde 2, Punkt 8) is gone: unverifiable
    // against real AppRun/linuxdeploy source, see sanitized_env_value's doc
    // comment. A single-value variable inside the mount is always removed
    // now, with no "unless a saved original exists" exception left to test.

    #[test]
    fn a_single_value_var_inside_the_mount_is_always_removed() {
        let appdir = "/tmp/.mount_LU";
        let current = "/tmp/.mount_LU/etc/ssl/cert.pem";
        assert_eq!(sanitized_env_value(VarShape::SingleValue, current, appdir, None), Some(None));
    }

    // ── Review Runde 2, Punkt 10: PATH never goes fully empty ──────────────

    #[test]
    fn a_fully_poisoned_path_falls_back_to_a_base_list_instead_of_disappearing() {
        let appdir = "/tmp/.mount_LU";
        let current = "/tmp/.mount_LU/usr/bin";
        assert_eq!(
            sanitized_env_value(VarShape::PathList, current, appdir, Some(APPIMAGE_PATH_FALLBACK)),
            Some(Some(APPIMAGE_PATH_FALLBACK.to_string()))
        );
    }

    #[test]
    fn without_a_fallback_a_fully_poisoned_path_list_still_falls_back_to_removal() {
        // Negative control: any OTHER PathList variable (XDG_DATA_DIRS, say)
        // passes no fallback, and must keep the pre-Punkt-10 removal
        // behaviour rather than silently inventing a value for a variable
        // this feature was never meant to touch.
        let appdir = "/tmp/.mount_LU";
        let current = "/tmp/.mount_LU/usr/share";
        assert_eq!(sanitized_env_value(VarShape::PathList, current, appdir, None), Some(None));
    }

    #[test]
    fn foreign_system_command_is_a_noop_without_appdir() {
        // Negative control for the whole path: with no APPDIR (every
        // platform and packaging but a running Linux AppImage), the command
        // must come back with no environment override at all.
        let _guard = env_guard();
        std::env::remove_var("APPDIR");
        let cmd = foreign_system_command("git");
        assert_eq!(cmd.get_envs().count(), 0, "no APPDIR means nothing should be overridden");
    }

    #[test]
    fn foreign_system_command_cleans_the_env_a_spawned_git_would_inherit() {
        // K11/K2 (CachyOS/Arch AppImage, 2026-09-16): `git` on PATH
        // inherited the AppImage's LD_LIBRARY_PATH and loaded LU's bundled
        // libpcre2/libssl instead of the system's, printing "no version
        // information available". This is the exact call every
        // `Command::new("git")` in the codebase was switched to.
        let _guard = env_guard();
        std::env::set_var("APPDIR", "/tmp/.mount_LocallieGkad");
        std::env::set_var(
            "LD_LIBRARY_PATH",
            "/tmp/.mount_LocallieGkad/usr/lib:/tmp/.mount_LocallieGkad/usr/lib/x86_64-linux-gnu",
        );
        let cmd = foreign_system_command("git");
        // K14: the generalised strip_appimage_env removes a PathList
        // variable outright once every entry was inside the mount, rather
        // than setting it to an explicit "" the way the narrower
        // strip_appimage_ld_library_path used to, see
        // a_path_list_variable_with_every_entry_inside_the_mount_is_removed_not_emptied
        // for why that is the better of the two for a reader that treats an
        // empty search list differently from an unset one.
        let ld = cmd.get_envs().find(|(k, _)| *k == std::ffi::OsStr::new("LD_LIBRARY_PATH"));
        assert_eq!(
            ld,
            Some((std::ffi::OsStr::new("LD_LIBRARY_PATH"), None)),
            "both entries were inside the AppImage: the variable should be removed, not merely emptied"
        );
        assert_eq!(cmd.get_program(), "git");
        std::env::remove_var("APPDIR");
        std::env::remove_var("LD_LIBRARY_PATH");
    }

    // ── K14: the generalised sanitizer, as a pure function over a map ──────
    //
    // These never touch std::env, sanitized_env_value is given the current
    // value and the mount point directly, exactly as strip_appimage_env
    // reads them, so the whole APPIMAGE_ENV_VARS table is testable on every
    // platform this app builds for, CI included.

    #[test]
    fn a_single_value_variable_pointing_inside_the_mount_is_removed_entirely() {
        // PYTHONHOME/SSL_CERT_FILE/etc: there is no "rest of the value" to
        // keep once the ONE path it names is inside the AppImage. K14's
        // customer case: a bundled cert bundle or module dir shadows the
        // system one and a foreign Python reads garbage or nothing.
        let appdir = "/tmp/.mount_LU";
        let current = "/tmp/.mount_LU/usr/lib/python3.11";
        assert_eq!(sanitize(VarShape::SingleValue, current, appdir), Some(None));
    }

    #[test]
    fn a_single_value_variable_outside_the_mount_is_left_alone() {
        // Negative control: a user's own SSL_CERT_FILE (a corporate proxy's
        // CA bundle, say) must survive untouched.
        let appdir = "/tmp/.mount_LU";
        let current = "/etc/ssl/certs/ca-certificates.crt";
        assert_eq!(sanitize(VarShape::SingleValue, current, appdir), None);
    }

    #[test]
    fn a_path_list_variable_with_every_entry_inside_the_mount_is_removed_not_emptied() {
        // XDG_DATA_DIRS etc: emptying a PathList variable to "" is not the
        // same as removing it for every reader, some tools treat an EMPTY
        // XDG_DATA_DIRS as "search nothing" rather than "use the default",
        // which is worse than never having set it. So a PathList that
        // becomes empty after stripping is removed outright, same as a
        // SingleValue.
        let appdir = "/tmp/.mount_LU";
        let current = "/tmp/.mount_LU/usr/share:/tmp/.mount_LU/usr/share/gio-modules";
        assert_eq!(sanitize(VarShape::PathList, current, appdir), Some(None));
    }

    #[test]
    fn a_path_list_variable_keeps_its_non_appimage_entries() {
        let appdir = "/tmp/.mount_LU";
        let current = "/tmp/.mount_LU/usr/share:/usr/local/share:/usr/share";
        assert_eq!(
            sanitize(VarShape::PathList, current, appdir),
            Some(Some("/usr/local/share:/usr/share".to_string()))
        );
    }

    #[test]
    fn every_appimage_env_var_is_covered_exactly_once() {
        // Guards the table itself: no duplicate entries (a second sanitize
        // pass overwriting the first's cleaned value with the raw one from
        // std::env would be silent), and every name in it is one linuxdeploy
        // is actually known to touch.
        let names: Vec<&str> = APPIMAGE_ENV_VARS.iter().map(|(n, _)| *n).collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), names.len(), "a variable appears twice in APPIMAGE_ENV_VARS");
        assert!(names.contains(&"LD_LIBRARY_PATH"));
        assert!(names.contains(&"PYTHONHOME"));
        assert!(names.contains(&"SSL_CERT_FILE"));
        assert!(names.contains(&"SSL_CERT_DIR"));
        assert!(names.contains(&"XDG_DATA_DIRS"));
    }

    #[test]
    fn strip_appimage_env_cleans_every_poisoned_variable_at_once() {
        // K14 end to end: several of the table's variables poisoned together
        // (the realistic AppRun shape), one strip_appimage_env call, every
        // one of them comes back clean or gone.
        let _guard = env_guard();
        let appdir = "/tmp/.mount_LU2";
        std::env::set_var("APPDIR", appdir);
        std::env::set_var("LD_LIBRARY_PATH", format!("{appdir}/usr/lib:/usr/local/lib"));
        std::env::set_var("PYTHONHOME", format!("{appdir}/usr"));
        std::env::set_var("SSL_CERT_FILE", format!("{appdir}/usr/ssl/cacert.pem"));
        std::env::set_var("XDG_DATA_DIRS", format!("{appdir}/usr/share"));
        // A variable this AppImage never touched, present only because the
        // shell it launched from set it, must survive untouched.
        std::env::set_var("SSL_CERT_DIR", "/etc/ssl/certs");

        let mut cmd = Command::new("python3");
        strip_appimage_env(&mut cmd);
        let envs: std::collections::HashMap<String, Option<String>> = cmd
            .get_envs()
            .map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned())))
            .collect();

        assert_eq!(envs.get("LD_LIBRARY_PATH").and_then(|v| v.clone()), Some("/usr/local/lib".to_string()));
        // An explicit removal shows up in get_envs() as the key mapped to
        // `None` (Command::env_remove), which is Some(None) once wrapped in
        // this test's outer HashMap, distinct from the key being absent,
        // which would mean "left untouched", the wrong outcome here.
        assert_eq!(envs.get("PYTHONHOME"), Some(&None), "PYTHONHOME must be explicitly removed");
        assert_eq!(envs.get("SSL_CERT_FILE"), Some(&None), "SSL_CERT_FILE must be explicitly removed");
        assert_eq!(envs.get("XDG_DATA_DIRS"), Some(&None), "the whole list was inside the mount, so it is removed");
        assert!(
            !envs.contains_key("SSL_CERT_DIR"),
            "SSL_CERT_DIR pointed outside the mount and must not appear as an override at all"
        );

        std::env::remove_var("APPDIR");
        std::env::remove_var("LD_LIBRARY_PATH");
        std::env::remove_var("PYTHONHOME");
        std::env::remove_var("SSL_CERT_FILE");
        std::env::remove_var("XDG_DATA_DIRS");
        std::env::remove_var("SSL_CERT_DIR");
    }
}


// ── Reading the process table by COMMAND LINE ───────────────────────────────
//
// `System::refresh_processes` does NOT fetch command lines. Its refresh kind is
// memory + cpu + disk_usage + exe (sysinfo-0.33 `common/system.rs:296`), so
// `Process::cmd()` comes back as an EMPTY slice for every process, and any
// matcher that joins it silently compares against "".
//
// That is not a hypothetical. It cost this repo two independent bugs, and the
// second one is the reason this helper exists rather than a third copy of the
// same three lines:
//
//   * `process::find_orphaned_comfyui` (T-68) — the scan for a ComfyUI orphaned
//     by a hard kill found nothing at all, so Stop stayed the no-op the audit
//     described even after the adoption path was written.
//   * `remote::kill_orphaned_tunnels` (T-39) — the startup sweep that kills a
//     cloudflared tunnel surviving from the last run could never match, so a
//     tunnel kept publishing the LAN server to the internet while the app's own
//     indicator read OFF. The audit sheet recorded that finding as fixed,
//     because the fix LOOKED like it applied.
//
// One of the two got repaired and the other did not, purely because nobody knew
// they were the same line twice. So: one helper, one place to get this wrong.

/// A refreshed process table whose entries actually carry their command lines.
///
/// Use this — never a bare `System::new()` + `refresh_processes()` — whenever
/// the answer depends on `Process::cmd()`.
pub fn process_table_with_cmdlines() -> sysinfo::System {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        // `name()` stays populated by the base discovery, so a matcher that
        // reads both the name and the argv is served by this one refresh.
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    sys
}

/// One process's command line as owned strings, in argv order.
pub fn cmdline_of(process: &sysinfo::Process) -> Vec<String> {
    process
        .cmd()
        .iter()
        .map(|c| c.to_string_lossy().to_string())
        .collect()
}

/// Spawn a command with stdout+stderr piped, console suppressed on Windows.
pub fn spawn_piped(mut cmd: Command) -> std::io::Result<Child> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(no_window());
    }
    #[cfg(unix)]
    {
        // Create our own process group so we can kill the whole tree later.
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc_setpgid_self() != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    cmd.spawn()
}

/// Every process in `root`'s tree, root last, paired with its start time.
///
/// The start time is the anti-PID-reuse token for the delayed SIGKILL below:
/// a descendant is reparented to init the moment its parent dies, init reaps
/// it, and the kernel is then free to hand that number to a stranger inside
/// our own grace window. Same pid AND same start time is the same process.
#[cfg(unix)]
fn tree_snapshot(root: u32) -> Vec<(u32, u64)> {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let mut order = crate::commands::shell::descendants(root, &sys);
    order.reverse(); // leaves first — a live parent can't respawn what we killed
    order.push(root);
    order
        .into_iter()
        .map(|pid| {
            let start = sys
                .process(Pid::from_u32(pid))
                .map(|p| p.start_time())
                .unwrap_or(0);
            (pid, start)
        })
        .collect()
}

/// How long a SIGTERM'd tree is given before the SIGKILL goes out.
///
/// A named constant because it is the subject of
/// `the_call_does_not_block_for_the_grace_period`: the whole point of the
/// detached thread below is that the CALLER never spends this. It was written
/// twice, once per escalation path, and a change to one of the two would have
/// been silent.
#[cfg(unix)]
const KILL_GRACE: std::time::Duration = std::time::Duration::from_millis(800);

/// Recursive process-tree kill: SIGTERM the whole tree now, SIGKILL whatever
/// is left after a grace. Windows hands the whole walk to
/// `commands::shell::kill_tree`, the one sweep that also waits out a worker
/// the tree starts while it is being felled.
///
/// The Unix branch used to signal the process GROUP (`kill -- -PGID`). That
/// only reaches a child that was made a group leader at spawn, and it is not
/// what either caller here does:
///
/// * `video::video_cancel` (the mlx_video Python job) spawns through a plain
///   `Command::spawn`, so the child is in OUR group and `-PID` addressed a
///   group that never existed — the kill went nowhere and the generation kept
///   running on the GPU. This is the case the explicit walk was written for.
/// * `remote::kill_tunnel_child` (the cloudflared quick tunnel) spawns through
///   `spawn_piped`, so that child IS its own group leader and the old group
///   kill would have worked for it. The walk works for it too: it follows the
///   parent links, which exist either way, and it never signals a pid that is
///   not in the snapshot — so the wider process group is not a hazard.
///
/// What BOTH callers have to satisfy is the reaping contract: the tree MUST be
/// walked before the root dies (afterwards its children are reparented to init
/// and the parent links that identify them are gone), and the caller must not
/// have reaped the child itself — the `waitpid` at the end of the detached
/// thread is what keeps the pid reserved until the escalation has fired, and it
/// is also what keeps the process from becoming a permanent zombie. Both
/// callers hand over an unreaped `Child` and drop it afterwards without
/// waiting, which is exactly right.
///
/// On Unix, nothing here blocks the caller: `video_cancel` holds the
/// `video_process` mutex across this call and the UI polls that same mutex,
/// so the old 800 ms sleep froze the window for the whole grace. The tunnel
/// path has the same shape on quit. The grace, the escalation and the final
/// reap run on a detached thread instead.
///
/// review-winfix.md A2: on Windows the caller now waits. The `#[cfg(windows)]`
/// branch below calls `commands::shell::kill_tree` (its own doc comment has
/// the measurement and the reason) synchronously, no detached thread; the
/// bauer measured 120 to 248 ms for the ordinary case, and up to
/// `shell::TREE_KILL_SETTLE` (1.5 s) in the worst one. For `video_cancel` that
/// wait sits UNDER the held `video_process` mutex the UI polls, so a Windows
/// cancel can freeze that window for the same span the old 800 ms sleep did;
/// `shutdown_tunnel` pays the same cost on the program's quit path instead.
pub fn kill_tree(child: &mut Child) -> std::io::Result<()> {
    let pid = child.id();
    #[cfg(windows)]
    {
        // The same sweep the shell's cancel path uses, not a second copy of
        // `taskkill /T`: a tunnel or a video job that is stopped while it is
        // still starting up loses its worker to the identical race, and a
        // second copy would have had to be found and fixed twice.
        crate::commands::shell::kill_tree(pid);
        let _ = child.kill();
        let _ = child.wait();
    }
    #[cfg(unix)]
    {
        let tree = tree_snapshot(pid);
        for (p, _) in &tree {
            unsafe {
                libc::kill(*p as i32, libc::SIGTERM);
            }
        }
        std::thread::spawn(move || {
            std::thread::sleep(KILL_GRACE);
            let survivors = {
                use sysinfo::{Pid, ProcessesToUpdate, System};
                let mut sys = System::new();
                sys.refresh_processes(ProcessesToUpdate::All, true);
                tree.iter()
                    .filter(|(p, start)| {
                        sys.process(Pid::from_u32(*p))
                            .map(|proc_| *start == 0 || proc_.start_time() == *start)
                            .unwrap_or(false)
                    })
                    .map(|(p, _)| *p)
                    .collect::<Vec<u32>>()
            };
            for p in survivors {
                unsafe {
                    libc::kill(p as i32, libc::SIGKILL);
                }
            }
            // The caller drops its `Child` without waiting, and a dropped
            // Child is never reaped — the job would sit in the table as a
            // zombie for as long as LU runs. Its pid also cannot be recycled
            // until this call, which is what makes the SIGKILL above safe.
            unsafe {
                let mut status: libc::c_int = 0;
                libc::waitpid(pid as libc::pid_t, &mut status, 0);
            }
        });
    }
    Ok(())
}

/// Same escalation as [`kill_tree`], but for a pid this process does NOT own.
///
/// The case it exists for (T-68): LU is hard-killed, its ComfyUI child is
/// reparented to init and survives. The next launch can identify that process
/// but has no `Child` for it — so there is nothing to `wait()` on, and calling
/// `waitpid` on a stranger would fail with ECHILD anyway. Everything else is
/// the same walk: snapshot the tree while the parent links still exist,
/// SIGTERM it, then SIGKILL whatever is still there (and still the same
/// process, by start time) after the grace, off the caller's thread.
pub fn kill_pid_tree(pid: u32) {
    #[cfg(windows)]
    {
        crate::commands::shell::kill_tree(pid);
    }
    #[cfg(unix)]
    {
        let tree = tree_snapshot(pid);
        for (p, _) in &tree {
            unsafe {
                libc::kill(*p as i32, libc::SIGTERM);
            }
        }
        std::thread::spawn(move || {
            std::thread::sleep(KILL_GRACE);
            use sysinfo::{Pid, ProcessesToUpdate, System};
            let mut sys = System::new();
            sys.refresh_processes(ProcessesToUpdate::All, true);
            for (p, start) in tree {
                let same = sys
                    .process(Pid::from_u32(p))
                    .map(|proc_| start == 0 || proc_.start_time() == start)
                    .unwrap_or(false);
                if same {
                    unsafe {
                        libc::kill(p as i32, libc::SIGKILL);
                    }
                }
            }
            // No waitpid: an adopted orphan is init's child, not ours. init
            // reaps it.
        });
    }
}

/// One process LISTENING on a local TCP port, as far as the process table
/// knows it: its parent and its argv.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, PartialEq)]
pub struct PortListener {
    pub pid: u32,
    pub parent: Option<u32>,
    pub cmd: Vec<String>,
}

/// Every process listening on `port` (`lsof -sTCP:LISTEN`, so the bridge's
/// own client connections to that port are not among them).
#[cfg(target_os = "macos")]
pub fn listeners_on_port(port: u16) -> Vec<PortListener> {
    let Ok(out) = foreign_system_command("lsof")
        .args(["-nP", "-ti", &format!("tcp:{port}"), "-sTCP:LISTEN"])
        .stderr(Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    let table = process_table_with_cmdlines();
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .filter_map(|s| s.parse::<u32>().ok())
        .map(|pid| {
            let process = table.process(sysinfo::Pid::from_u32(pid));
            PortListener {
                pid,
                parent: process.and_then(|p| p.parent()).map(|p| p.as_u32()),
                cmd: process.map(cmdline_of).unwrap_or_default(),
            }
        })
        .collect()
}

/// Stop the listeners on `port` that `owned` says are ours, and only those.
/// Returns the pids that were asked to stop.
///
/// Until 3.1.0 this was `kill_listeners_on_port`: SIGTERM to whatever listened
/// on the port, no questions asked (N2's finding, 13.11.2026). Its caller is
/// the quit path, and the quit path also runs in `Drop for AppState`, so every
/// `cargo test` that built and dropped an `AppState` ended the MLX sidecar of
/// the real LU running on the same Mac. A second LU, or a test build with its
/// own identity, lost its sidecar the same way when the other one quit. The
/// caller now names what it owns; a stranger on the port is left alone.
#[cfg(target_os = "macos")]
pub fn kill_own_listeners_on_port(port: u16, owned: impl Fn(&PortListener) -> bool) -> Vec<u32> {
    let mut stopped = Vec::new();
    for listener in listeners_on_port(port) {
        if listener.pid == std::process::id() || !owned(&listener) {
            continue;
        }
        unsafe {
            libc::kill(listener.pid as i32, libc::SIGTERM);
        }
        stopped.push(listener.pid);
    }
    stopped
}

#[cfg(unix)]
extern "C" {
    fn setpgid(pid: libc::pid_t, pgid: libc::pid_t) -> libc::c_int;
}

#[cfg(unix)]
fn libc_setpgid_self() -> libc::c_int {
    unsafe { setpgid(0, 0) }
}

/// Ask a child to stop the way Ctrl+C does. True when the request went out.
///
/// For a tool that ends its own work on an interrupt and drops it on a kill.
/// Windows has no interrupt for a child without a console of its own, so
/// there it is always false and the caller goes on to [`kill_tree`].
pub fn interrupt(child: &Child) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGINT) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = child;
        false
    }
}

// Minimal libc binding so we can avoid an extra crate.
#[cfg(unix)]
#[allow(non_camel_case_types)]
mod libc {
    pub type pid_t = i32;
    pub type c_int = i32;
    pub const SIGINT: c_int = 2;
    pub const SIGTERM: c_int = 15;
    pub const SIGKILL: c_int = 9;
    extern "C" {
        pub fn kill(pid: pid_t, sig: c_int) -> c_int;
        pub fn waitpid(pid: pid_t, status: *mut c_int, options: c_int) -> pid_t;
    }
}

#[cfg(test)]
mod one_windows_tree_kill_guard {
    /// NB4: this module used to carry its OWN `taskkill /T /F`, a second
    /// answer to a question `commands::shell::kill_tree` already answers, and
    /// it had the identical gap: one enumeration, so a worker the tree starts
    /// while the sweep runs survives. `remote::kill_tunnel_child` (cloudflared)
    /// and `video::video_cancel` cancel through here, so the bug would have had
    /// to be found twice and fixed twice.
    ///
    /// A behaviour test cannot stand guard over that from here: the sweep
    /// itself is proven in `commands::shell`, and both branches would look the
    /// same from outside on a tree with nothing left over. What has to stay
    /// true is that there is only ONE of them, and that is what this reads.
    /// Same shape as `command_new_coverage_guard` below.
    #[test]
    fn the_windows_tree_kill_is_not_written_a_second_time() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/process_util.rs");
        let src = std::fs::read_to_string(path).expect("read this file");
        // The two Windows branches that fell a tree: `kill_tree` and
        // `kill_pid_tree`. Comment lines are skipped so the prose above them
        // can name the call without standing in for it. The `taskkill /F` in
        // `free_port` is a different job (one stranger holding a port, no
        // tree) and is deliberately not counted here.
        // Spelled in two halves so this line is not itself one of the hits.
        let needle = format!("crate::commands::shell::{}(pid)", "kill_tree");
        let delegations = src
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .filter(|l| l.contains(&needle))
            .count();
        assert_eq!(
            delegations, 2,
            "both Windows tree kills here have to reach the one sweep in commands::shell; \
             a copy of taskkill in their place would have to be found and fixed twice, \
             and a cancelled tunnel or video job would keep the worker it started late"
        );
    }
}

#[cfg(all(test, unix))]
mod kill_tree_tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn alive(pid: u32) -> bool {
        let out = Command::new("ps")
            .args(["-o", "state=", "-p", &pid.to_string()])
            .output();
        match out {
            Ok(o) => {
                let st = String::from_utf8_lossy(&o.stdout).trim().to_string();
                !st.is_empty() && !st.starts_with('Z')
            }
            Err(_) => false,
        }
    }

    fn wait_until_gone(pids: &[u32], max: Duration) {
        let deadline = Instant::now() + max;
        loop {
            let left: Vec<u32> = pids.iter().copied().filter(|p| alive(*p)).collect();
            if left.is_empty() {
                return;
            }
            assert!(Instant::now() < deadline, "still running: {left:?}");
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// One of the two callers (`video_cancel`) spawns with a plain
    /// `Command::spawn`, so the child is NOT a process-group leader — which is
    /// exactly why the old `kill(-pid)` signalled nothing and left the tree
    /// running. (The other, `remote::kill_tunnel_child`, goes through
    /// `spawn_piped` and IS a group leader; the parent-link walk covers both,
    /// and the group-leader case is exercised in remote.rs's own tunnel tests.)
    #[test]
    fn a_child_without_a_process_group_still_loses_its_whole_tree() {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("sleep 40 & sleep 40")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sh");
        let pid = child.id();

        // Waits for the CONDITION — sh has actually forked — with a ceiling,
        // instead of guessing 400 ms at it. The old fixed sleep made the
        // "test setup is wrong" assertion below a load measurement: on a busy
        // machine sh simply had not got there yet.
        let deadline = Instant::now() + Duration::from_secs(10);
        let kids = loop {
            let mut sys = sysinfo::System::new();
            sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            let kids = crate::commands::shell::descendants(pid, &sys);
            if !kids.is_empty() {
                break kids;
            }
            assert!(
                Instant::now() < deadline,
                "sh spawned nothing in 10s — test setup is wrong",
            );
            std::thread::sleep(Duration::from_millis(50));
        };

        kill_tree(&mut child).expect("kill_tree");

        let mut all = kids.clone();
        all.push(pid);
        wait_until_gone(&all, Duration::from_secs(5));
    }

    /// `video_cancel` holds the `video_process` mutex for the duration of this
    /// call and the progress poll waits on the same mutex, so a blocking grace
    /// froze the window. The kill must be ordered, not awaited.
    ///
    /// ── Why there is no stopwatch in here any more ──
    ///
    /// It used to time the call and assert `took < 400 ms`. That number is not
    /// the grace and it is not a property of the code: the unavoidable work
    /// inside `kill_tree` is `tree_snapshot`, which enumerates the ENTIRE
    /// process table, and how long that takes belongs to the machine and to
    /// whatever else is running on it. Measured on 01.09.2026 under six
    /// concurrent copies of the suite — every one of them walking the process
    /// table too — it failed 17 of 18 runs. The kill was ordered, not awaited,
    /// in all 18; the enumeration was simply slower than the budget.
    ///
    /// So the question is asked without a clock. `kill_tree` hands the grace,
    /// the SIGKILL and the final `waitpid` to a detached thread. The `waitpid`
    /// is the LAST of those, and until it runs the child is our unreaped
    /// zombie, which is a pid `kill(pid, 0)` can still address. An
    /// implementation that awaited the grace would return AFTER that thread had
    /// finished, and the pid would be gone. One signal-0, no wall clock, no
    /// budget to blow — and it fails for exactly the regression this test
    /// exists to catch (put `thread::sleep(KILL_GRACE)` back in the caller's
    /// path and the child is reaped before the assertion runs).
    #[test]
    fn the_call_does_not_block_for_the_grace_period() {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("sleep 40")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sh");
        let pid = child.id();

        // Self-check instead of a settle sleep: wait for the CONDITION that the
        // stand-in is a live process carrying the argv this test chose, with a
        // ceiling. A `sh` that died on the spot would otherwise be killed as a
        // corpse and every assertion below would still pass. `checked_table`
        // owns the ceiling and the retry, including the one for a child that is
        // in the table but has not finished `exec` yet.
        let table = crate::test_support::checked_table(pid).unwrap_or_else(|why| panic!("{why}"));
        let argv = crate::process_util::cmdline_of(
            table
                .process(sysinfo::Pid::from_u32(pid))
                .expect("checked_table only returns a table containing this pid"),
        );
        assert!(
            argv.join(" ").contains("sleep"),
            "the stand-in is not the sleeper this test spawned: {argv:?}",
        );

        kill_tree(&mut child).expect("kill_tree");

        // Still ours, still unreaped → the detached thread has not reached its
        // `waitpid` yet → this call cannot have waited for the grace.
        let still_ours = unsafe { libc::kill(pid as i32, 0) } == 0;
        assert!(
            still_ours,
            "kill_tree returned only after the escalation thread had already \
             reaped pid {pid} — it waited out the {KILL_GRACE:?} grace",
        );

        wait_until_gone(&[pid], Duration::from_secs(5));
    }

    /// A killed child that nobody waits on stays in the process table as a
    /// zombie for the app's lifetime — and its pid can never be recycled.
    #[test]
    fn the_direct_child_is_reaped_not_left_as_a_zombie() {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("sleep 40")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sh");
        let pid = child.id();
        std::thread::sleep(Duration::from_millis(200));
        kill_tree(&mut child).expect("kill_tree");
        drop(child); // exactly what video_cancel does with its taken handle

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let out = Command::new("ps")
                .args(["-o", "state=", "-p", &pid.to_string()])
                .output()
                .expect("ps");
            let st = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if st.is_empty() {
                return; // gone from the table entirely == reaped
            }
            assert!(Instant::now() < deadline, "pid {pid} is still listed as {st:?}");
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// The one regression this helper exists to stop: a process table without
/// command lines.
///
/// Both callers (`process::find_orphaned_comfyui`, `remote::kill_orphaned_tunnels`)
/// match on argv, and both were silently matching against "" before this was
/// centralised. This test is the shared guard — it fails for either of them.
#[cfg(test)]
mod process_table_tests {
    // Only the unix test below reads anything from the parent; on Windows the
    // import was the one thing in this module clippy could see — and rejected.
    #[cfg(unix)]
    use super::*;

    #[cfg(unix)]
    #[test]
    fn the_table_carries_command_lines() {
        use std::process::{Command, Stdio};
        // The trailing `; :` stops sh from exec'ing the single command and
        // handing over its own argv — which would erase what is being read.
        let marker = "lu-process-table-probe-8f3a";
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 30; :", marker, "--flag", "value"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn the stand-in");

        let mut seen: Option<Vec<String>> = None;
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let sys = process_table_with_cmdlines();
            if let Some(p) = sys.process(sysinfo::Pid::from_u32(child.id())) {
                let cmd = cmdline_of(p);
                if !cmd.is_empty() {
                    seen = Some(cmd);
                    break;
                }
            }
        }
        let _ = child.kill();
        let _ = child.wait();

        let cmd = seen.expect(
            "the process table came back with an EMPTY command line — \
             refresh_processes does not fetch cmd, and every argv matcher in \
             this repo would silently be comparing against \"\"",
        );
        assert!(cmd.iter().any(|a| a == marker), "{cmd:?}");
        assert!(cmd.iter().any(|a| a == "--flag"), "{cmd:?}");
    }

    /// Nobody may quietly reintroduce a second, cmd-less refresh for an argv
    /// match. The two known matchers must go through the helper.
    #[test]
    fn the_argv_matchers_share_one_refresh() {
        const PROCESS_RS: &str = include_str!("commands/process.rs");
        const REMOTE_RS: &str = include_str!("commands/remote.rs");
        for (name, src, func) in [
            ("process.rs", PROCESS_RS, "pub(crate) fn find_orphaned_comfyui"),
            ("remote.rs", REMOTE_RS, "fn kill_orphaned_tunnels"),
        ] {
            let start = src.find(func).unwrap_or_else(|| panic!("{func} is gone from {name}"));
            let body = &src[start..start + 1200];
            assert!(
                body.contains("process_table_with_cmdlines()"),
                "{name}: {func} builds its own process table again"
            );
        }
    }
}

/// Review Runde 2, Nachbesserung 7: a guard that counts every
/// `Command::new` in shipping code and requires it to be either the
/// [`foreign_system_command`] / [`foreign_system_command_tokio`] /
/// `python_command` adapter's own body, or an explicit, reasoned exception.
///
/// Scope: the files Runde 2's coverage sweep (Nachbesserung 5) actually
/// swept. `engine.rs` and `trainer.rs` are deliberately NOT in this list:
/// both are owned by a concurrently-working Bauer on this same review pass
/// (the "sidecar" Bauer rebuilding engine.rs's own spawn point for K1's
/// ggml-cpu variants, and the trainer Bauer on `fix/301-trainer`), and
/// hardcoding an expectation about either file's Command::new count here
/// would just be a merge-time landmine for their in-flight work. The
/// orchestrator integrating both branches is the right place to widen this
/// list to the whole crate once those two land. Until then this guard
/// covers everything Runde 2 claims to have covered, and nothing it does
/// not: an honest subset, not a false "every Command::new in the codebase"
/// claim.
///
/// Technique: the same one `whisper.rs`'s `healing_is_wired_in` and
/// `process.rs`'s own `every_python_start_in_this_file_goes_through_
/// python_command` guard already use: split the file at its FIRST
/// `#[cfg(test)]` and only count what comes before. This only works for a
/// file whose test modules are grouped at the end; `remote.rs` interleaves
/// `#[cfg(test)]` modules among production code (its first one starts at
/// line 108, with plenty of shipping code still to come), so a single split
/// point there would hide real production sites past it. A brace-depth
/// tracker was tried and dropped: test bodies in this codebase routinely
/// embed `json!({...})` literals and shell one-liners whose string content
/// has its own unbalanced-looking braces, and a naive counter closes the
/// span early on those. `remote.rs` gets its own pair of targeted,
/// needle-based checks below instead, against the two spots the coverage
/// sweep actually touched there.
#[cfg(test)]
mod command_new_coverage_guard {
    /// `(file relative to CARGO_MANIFEST_DIR, expected Command::new count in
    /// the shipping half)`. Every non-zero entry is the adapter function's
    /// own body, the one place `Command::new` is correct because it IS the
    /// sanitizing; every count skips lines whose trimmed text starts with
    /// `//`, so a doc comment mentioning `Command::new(...)` as an example
    /// (os_paths.rs, install/ollama.rs) needs no exception of its own.
    const SCOPED_FILES: &[(&str, usize)] = &[
        ("src/process_util.rs", 2), // foreign_system_command + its tokio twin
        ("src/python.rs", 1),       // python_command's own body
        ("src/commands/bg_tasks.rs", 0),
        ("src/commands/self_migrate.rs", 0),
        ("src/commands/process.rs", 0),
        ("src/commands/tts.rs", 0),
        ("src/commands/agent.rs", 0),
        ("src/commands/whisper.rs", 0),
        ("src/commands/video.rs", 0),
        ("src/commands/mlx.rs", 0),
        ("src/commands/image_mflux.rs", 0),
        ("src/commands/search.rs", 0),
        ("src/commands/install_method.rs", 0),
        ("src/os_paths.rs", 0),
        ("src/commands/install/lmstudio.rs", 0),
        ("src/commands/install/lmstudio_install.rs", 0),
        ("src/commands/install/ollama.rs", 0),
        ("src/commands/install/children.rs", 0),
        // Runde 3, Nachbesserung 3: the foreground shell spawn now goes
        // through `foreign_system_command` too, matching its background
        // twin (bg_tasks.rs). The remaining 1 is `taskkill.exe` at
        // shell.rs:204, `#[cfg(windows)]`-gated and windows-only exactly
        // like the review's own Ausnahmeliste for that file names.
        ("src/commands/shell.rs", 1),
        // Trainer-3.0.1-Folgeauftrag B1 (bau/engine.md, Nachbesserung 11):
        // every foreign program trainer.rs starts (winget, the venv's own
        // python, the two pip installs, the four musubi-tuner steps) now
        // goes through foreign_system_command. Zero raw Command::new left
        // in shipping code; trainer.rs spawns no bundled sidecar of its
        // own, unlike engine.rs below.
        ("src/commands/trainer.rs", 0),
        // Same Nachbesserung, engine.rs half: these 2 are NOT foreign
        // programs, they are engine.rs's own two llama-server spawns (the
        // chat/completion server and the embeddings server), our own
        // bundled sidecar. K11/K14's doc comment on foreign_system_command
        // is explicit that a bundled sidecar stays raw, it needs exactly
        // the AppImage-bundled libraries the adapter would strip out.
        // 3.0.8 (A2) adds the third: the same sidecar asked
        // `--list-devices` to find the chat card's Vulkan device. A14 (3.0.8)
        // a fourth, the same sidecar started for the refusal-removal tool's
        // check (`spawn_private_server`).
        ("src/commands/engine.rs", 4),
        // The refusal-removal tool's one raw spawn is `lu-llama-quantize`,
        // a sidecar LU ships next to the engine; its Python steps go through
        // python_command.
        ("src/commands/abliterate/mod.rs", 1),
        // The login shell that is asked for the user's PATH on a Mac is a
        // foreign program like any other and goes through the adapter.
        ("src/finder_path.rs", 0),
    ];

    /// Runde 3, Nachbesserung 10: the review caught this before it bit
    /// anyone (`review-engine.md` Runde 2 Abschnitt 2, letzter Absatz): a
    /// file whose only test module is tagged `#[cfg(all(test, unix))]` (or
    /// any other compound predicate with `test` as one of the conjuncts)
    /// has NO literal `#[cfg(test)]` substring anywhere, so the plain
    /// search used to fall through to "no test module, count the whole
    /// file as shipping code". `process_util.rs`'s own `kill_tree_tests`
    /// module only escaped that by luck: this file also happens to carry a
    /// plain `#[cfg(test)]` later on. `shell.rs` does not have that luck
    /// once `foreign_system_command` covers its foreground shell spawn
    /// (Nachbesserung 3): its ONLY other test module is
    /// `#[cfg(all(test, windows))]`, sitting ahead of its first plain
    /// `#[cfg(test)]`, so the truncation point matters for real now, not
    /// just in theory. This takes the EARLIEST of either shape.
    fn shipping_half(src: &str) -> &str {
        let plain = src.find("#[cfg(test)]");
        let compound = src.find("#[cfg(all(test");
        let at = match (plain, compound) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) | (None, Some(a)) => Some(a),
            (None, None) => None,
        };
        match at {
            Some(at) => &src[..at],
            None => src,
        }
    }

    fn count_command_new(shipping: &str) -> usize {
        shipping
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .map(|line| line.matches("Command::new(").count())
            .sum()
    }

    #[test]
    fn every_command_new_outside_tests_is_the_adapter_or_a_named_exception() {
        let mut failures: Vec<String> = Vec::new();
        for (rel_path, expected) in SCOPED_FILES {
            let full = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel_path);
            let src = std::fs::read_to_string(&full)
                .unwrap_or_else(|e| panic!("{rel_path} is unreadable: {e}"));
            let found = count_command_new(shipping_half(&src));
            if found != *expected {
                failures.push(format!(
                    "{rel_path}: found {found} shipping-code Command::new (expected {expected}), \
                     either a new site needs foreign_system_command/python_command, or this \
                     guard's expected count is stale"
                ));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    /// Negative control: the split-and-count above must be ABLE to see a
    /// violation, not just always agree with the table. A synthetic file
    /// shaped like the real ones, with one raw Command::new ahead of its
    /// first #[cfg(test)].
    #[test]
    fn the_guard_would_catch_a_real_regression() {
        let synthetic = "fn spawn_it() {\n    let _ = Command::new(\"lms\");\n}\n\n#[cfg(test)]\nmod tests {}\n";
        assert_eq!(count_command_new(shipping_half(synthetic)), 1);
    }

    /// Runde 3, Nachbesserung 10: a file whose ONLY test module is tagged
    /// `#[cfg(all(test, unix))]` (no bare `#[cfg(test)]` anywhere) must
    /// still have its test-only `Command::new` excluded, not counted as
    /// shipping code. Before this fix, `shipping_half` found no plain
    /// `#[cfg(test)]` and returned the WHOLE file, silently double-counting
    /// exactly the shape shell.rs now has.
    #[test]
    fn a_compound_cfg_test_predicate_is_also_recognized() {
        let synthetic = "fn spawn_it() {\n    let _ = Command::new(\"lms\");\n}\n\n\
                          #[cfg(all(test, unix))]\nmod tests {\n    fn t() { Command::new(\"x\"); }\n}\n";
        assert_eq!(count_command_new(shipping_half(synthetic)), 1);
    }

    /// `remote.rs`'s own two spots, checked by name instead of a whole-file
    /// split (see the module doc comment for why). Both were the review's
    /// coverage-table entries for this file. A full parse of each
    /// function's real end (matching brace) is overkill here, so this
    /// bounds the search to a fixed character window instead, wide enough
    /// for either body with room to grow.
    #[test]
    fn remote_rs_firewall_and_tunnel_spawns_go_through_the_adapter() {
        const REMOTE_RS: &str = include_str!("commands/remote.rs");
        for (needle, window, min_adapter_calls) in [
            ("fn ensure_lan_firewall_rule(port: u16) {", 1600, 3),
            // start_tunnel(): downloads cloudflared (tar -xzf on macOS) and
            // then spawns it as the tunnel process, both foreign programs.
            ("pub async fn start_tunnel(", 6500, 2),
        ] {
            let start = REMOTE_RS
                .find(needle)
                .unwrap_or_else(|| panic!("remote.rs: {needle:?} is gone"));
            let body = &REMOTE_RS[start..(start + window).min(REMOTE_RS.len())];
            let raw: usize = body
                .lines()
                .filter(|line| !line.trim_start().starts_with("//"))
                .map(|line| line.matches("Command::new(").count())
                .sum();
            assert_eq!(raw, 0, "remote.rs: a raw Command::new is back near {needle:?}: {body}");
            let adapter_calls = body.matches("foreign_system_command(").count();
            assert!(
                adapter_calls >= min_adapter_calls,
                "remote.rs: expected at least {min_adapter_calls} foreign_system_command \
                 call(s) near {needle:?}, found {adapter_calls}"
            );
        }
    }
}

/// Windows-Gegenprobe, 09.10.2026: the MLX port sweep (since 3.1.0
/// `commands::mlx::sweep_orphaned_sidecar`) exists on the Mac
/// alone, and a call without the same gate compiles on the Mac and nowhere
/// else. `mlx.rs` had one, and the branch did not build on Windows. Nothing
/// on a Mac says so, so this reads the sources on every platform.
#[cfg(test)]
mod mac_only_port_sweep_guard {
    const CALL: &str = "sweep_orphaned_sidecar(";
    const GATE: &str = "#[cfg(target_os = \"macos\")]";

    /// The lines that call the sweep without the gate on one of the three
    /// lines before them (the attribute, or the attribute and the brace of
    /// its block). Comments and the definition itself are not calls.
    fn ungated_calls(src: &str) -> Vec<usize> {
        let lines: Vec<&str> = src.lines().collect();
        (0..lines.len())
            .filter(|&i| {
                let line = lines[i].trim_start();
                line.contains(CALL) && !line.starts_with("//") && !line.starts_with("pub fn ")
            })
            .filter(|&i| !lines[i.saturating_sub(3)..i].iter().any(|l| l.trim() == GATE))
            .map(|i| i + 1)
            .collect()
    }

    fn rust_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("src is readable").flatten() {
            let path = entry.path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    #[test]
    fn every_call_of_the_mac_only_port_sweep_is_gated_like_the_sweep() {
        let mut files = Vec::new();
        rust_files(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
        assert!(files.len() > 50, "only {} sources were read", files.len());
        let mut calls = 0;
        let mut open: Vec<String> = Vec::new();
        for file in &files {
            let src = std::fs::read_to_string(file).expect("a source file is readable");
            // This module names the call in its own text and is not a caller.
            let src = src.split("mod mac_only_port_sweep_guard").next().unwrap_or_default();
            calls += src.lines().filter(|l| l.contains(CALL) && !l.trim_start().starts_with("//")).count();
            open.extend(ungated_calls(src).into_iter().map(|line| format!("{}:{line}", file.display())));
        }
        assert!(calls >= 3, "the definition and its callers were not found, the guard reads nothing");
        assert!(open.is_empty(), "these calls do not compile on Windows and Linux:\n{}", open.join("\n"));
    }

    #[test]
    fn the_guard_sees_a_call_without_the_gate() {
        let gated = "fn a() {\n    #[cfg(target_os = \"macos\")]\n    crate::commands::mlx::sweep_orphaned_sidecar();\n}\n";
        let block = "fn a() {\n    #[cfg(target_os = \"macos\")]\n    {\n        sweep_orphaned_sidecar();\n    }\n}\n";
        let bare = "fn a() {\n    stop();\n    crate::commands::mlx::sweep_orphaned_sidecar();\n}\n";
        let comment = "// sweep_orphaned_sidecar() was here\n";
        assert!(ungated_calls(gated).is_empty());
        assert!(ungated_calls(block).is_empty());
        assert!(ungated_calls(comment).is_empty());
        assert_eq!(ungated_calls(bare), vec![3]);
    }
}
