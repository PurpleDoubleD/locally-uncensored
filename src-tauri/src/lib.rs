// The app. `main.rs` is the desktop executable around `run()`, the phone
// builds enter through the same function (`mobile_entry_point`).
//
// Desktop against phone is decided with `cfg(desktop)` and `cfg(mobile)`,
// which tauri-build sets from the target. `target_os` is only used where
// Android and iOS really differ from each other.

// A phone build leaves out the tray, the second window, the sidecar spawns
// and every installer, and what only those called is unused there. The
// desktop build keeps the full dead-code check, so anything that is dead on
// every platform is still reported.
#![cfg_attr(mobile, allow(dead_code))]

// The gate itself is plain logic and is tested on the desktop. Only Android
// has an entry point that can be called twice in one process.
#[cfg(any(target_os = "android", test))]
mod android_entry;
#[cfg(target_os = "linux")]
mod linux_media;
mod app_identity;
// The chat's HTML preview server. A phone starts no server (mobile_guard.rs).
#[cfg(desktop)]
mod html_preview;
mod cancel_registry;
mod commands;
mod crash_report;
mod disk;
mod finder_path;
#[cfg(desktop)]
mod hf_link;
mod host_kind;
mod install_state;
mod media_store;
// Assembles the mobile client page from mobile-client/ — the same code
// build.rs runs, compiled in again here so `cargo test` can re-derive the
// page and compare it with the embedded one. Nothing at runtime needs it:
// remote.rs embeds the finished page with include_str!.
#[cfg(test)]
mod mobile_page;
mod onboarding_window;
mod os_error;
mod os_paths;
mod phone_log;
#[cfg(test)]
mod phone_version;
mod private_python;
mod private_tmp;
mod process_util;
mod python;
// End-to-end sealed remote channel (REMOTE-PROTOKOLL v2). Pure: no network,
// no platform, used unchanged by the desktop server and the phone client.
mod remote_seal;
mod shown_path;
#[cfg(feature = "e2e-remote")]
mod e2e_remote;
mod runtime_root;
mod storage_move;
mod system_tray;
mod state;
// Test-only OS helpers (a shell, a sleeper, "is this pid alive"), shared by
// the process tests in state.rs, commands/engine.rs and commands/bg_tasks.rs
// so the Windows answers exist once instead of eight times.
#[cfg(test)]
mod test_support;

use state::AppState;
use tauri::Manager;
// The tray, its menu and the close-to-tray event exist on a desktop only:
// `tauri::tray` and `tauri::menu` are not compiled for a phone at all.
#[cfg(desktop)]
use tauri::{
    Emitter,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    image::Image,
};

/// The switch that turns every workaround in this section off.
pub(crate) const WAYLAND_OPT_OUT: &str = "LU_NO_WAYLAND_WORKAROUND";

/// The four libraries an AppImage must not carry, and the one this code looks
/// for. linuxdeploy bundles the build host's `libwayland-client.so.0` next to
/// the app, the host's Mesa is then loaded against it, and on a Wayland session
/// `eglGetDisplay` answers `EGL_BAD_PARAMETER`. The web process prints
/// "Could not create default EGL display: EGL_BAD_PARAMETER. Aborting..." and
/// dies, and the rest of the app keeps running with no window at all.
/// tauri-apps/tauri#15665, reproduced on CachyOS in espressif/idf-im-ui#755,
/// where deleting the bundled wayland libraries from the AppDir fixed the GUI.
const BUNDLED_WAYLAND_CLIENT: &str = "usr/lib/libwayland-client.so.0";

/// Where a distribution keeps the real one. The first that exists wins.
const SYSTEM_WAYLAND_CLIENT: &[&str] = &[
    "/usr/lib/x86_64-linux-gnu/libwayland-client.so.0",
    "/usr/lib64/libwayland-client.so.0",
    "/usr/lib/libwayland-client.so.0",
];

/// One environment variable the Linux webview needs set before it exists.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct WebviewEnv {
    pub(crate) key: &'static str,
    pub(crate) value: String,
    /// Logged next to the variable, so a support log says why it was set.
    pub(crate) why: &'static str,
}

/// Everything the decision below is allowed to know. Read from the process in
/// `linux_webview_env`, handed in by hand in the tests: the machine that
/// reproduces this bug is not the machine the tests run on.
#[derive(Debug, Default)]
pub(crate) struct LinuxSession {
    /// The SESSION is Wayland. Not the GDK backend: Tauri's AppImage already
    /// forces `GDK_BACKEND=x11` through its linuxdeploy gtk hook, and that
    /// moves GTK onto XWayland without moving the web process off the Wayland
    /// EGL platform. The session is what the failing call sees.
    pub(crate) wayland: bool,
    pub(crate) opted_out: bool,
    pub(crate) dmabuf_set: bool,
    pub(crate) compositing_set: bool,
    pub(crate) preload_set: bool,
    /// The system `libwayland-client.so.0` that has to shadow the bundled one,
    /// set only when this process really runs out of an AppImage that bundles
    /// one and the system really has a copy.
    pub(crate) shadow_bundled_wayland: Option<String>,
}

/// Bug D (v2.4.5, Discord 2026-05-11) and Bug g (Discord
/// 2026-09-04): what to set before the webview exists.
///
/// Bug D was a window that opened and never painted, on Arch and Wayland, and
/// the two WEBKIT_ variables below are its fix (tauri-apps/tauri#9304, WebKit
/// bug 291332, which is still open at WebKitGTK 2.48.1 with an AMD card).
/// Since 2.4.5 they were set on EVERY Linux session. They are now set on
/// Wayland only, and X11 is left alone: the DMA-BUF renderer webkitgtk 2.42
/// introduced is the thing being disabled, disabling it costs everyone the
/// fast buffer-sharing path, and Tauri's own page says not to ship it
/// unconditionally (https://v2.tauri.app/develop/debug/linux-graphics/).
///
/// Bug g is the harder one and the reason the third variable is here. A user
/// ran 2.6.7, which already set both WEBKIT_ variables, and still got no
/// window at all under Wayland on CachyOS. "No window" is a different symptom
/// from "a window that will not paint", and it has a different known cause:
/// the bundled libwayland above.
///
/// Pure, and module-level rather than `#[cfg(target_os = "linux")]`, so every
/// branch is testable on a Mac. See `tests::wayland_*`.
pub(crate) fn linux_webview_env(session: &LinuxSession) -> Vec<WebviewEnv> {
    if session.opted_out || !session.wayland {
        return Vec::new();
    }
    let mut out = Vec::new();
    if !session.dmabuf_set {
        out.push(WebviewEnv {
            key: "WEBKIT_DISABLE_DMABUF_RENDERER",
            value: "1".to_string(),
            why: "webkitgtk's DMA-BUF renderer leaves the page blank on several Mesa versions",
        });
    }
    if !session.compositing_set {
        out.push(WebviewEnv {
            key: "WEBKIT_DISABLE_COMPOSITING_MODE",
            value: "1".to_string(),
            why: "accelerated compositing is the second half of the same blank-page fault",
        });
    }
    if let (Some(path), false) = (&session.shadow_bundled_wayland, session.preload_set) {
        out.push(WebviewEnv {
            key: "LD_PRELOAD",
            value: path.clone(),
            why: "this AppImage bundles its own libwayland-client, and the host Mesa loaded \
                  against it cannot create an EGL display, so the web process dies before a \
                  window exists (tauri-apps/tauri#15665)",
        });
    }
    out
}

/// Is this a Wayland session? Pure over the two variables that say so.
pub(crate) fn is_wayland_session(session_type: Option<&str>, wayland_display: Option<&str>) -> bool {
    session_type.is_some_and(|t| t.eq_ignore_ascii_case("wayland"))
        || wayland_display.is_some_and(|d| !d.is_empty())
}

/// Does this process run out of an AppImage that bundles the library, and does
/// the system have one to put in front of it?
///
/// `exists` is injected for the same reason everything else here is pure.
pub(crate) fn shadow_bundled_wayland(
    appdir: Option<&str>,
    exists: impl Fn(&str) -> bool,
) -> Option<String> {
    let appdir = appdir.filter(|d| !d.is_empty())?;
    let bundled = format!("{}/{BUNDLED_WAYLAND_CLIENT}", appdir.trim_end_matches('/'));
    if !exists(&bundled) {
        return None;
    }
    SYSTEM_WAYLAND_CLIENT
        .iter()
        .find(|p| exists(p))
        .map(|p| p.to_string())
}

/// Read the session, decide, set, and say so. Never overwrites a variable the
/// user set: a power user with a working setup keeps it.
fn apply_linux_webview_env() {
    let var = |k: &str| std::env::var(k).ok();
    let session = LinuxSession {
        wayland: is_wayland_session(
            var("XDG_SESSION_TYPE").as_deref(),
            var("WAYLAND_DISPLAY").as_deref(),
        ),
        opted_out: std::env::var_os(WAYLAND_OPT_OUT).is_some_and(|v| v != "0"),
        dmabuf_set: std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some(),
        compositing_set: std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_some(),
        preload_set: std::env::var_os("LD_PRELOAD").is_some(),
        shadow_bundled_wayland: shadow_bundled_wayland(var("APPDIR").as_deref(), |p| {
            std::path::Path::new(p).exists()
        }),
    };
    for e in linux_webview_env(&session) {
        // println! as well as tracing: the tracing writer is not up yet when
        // this runs, and this has to be visible to a user who started the
        // AppImage from a terminal because the window never came.
        println!(
            "[Linux] Wayland session: setting {}={} because {}. Set {WAYLAND_OPT_OUT}=1 to turn this off.",
            e.key, e.value, e.why
        );
        std::env::set_var(e.key, &e.value);
    }
}

/// Bug g, the other half: what the console says when the window never came.
///
/// The force-show fallback in `onboarding_window` fires when the frontend
/// never asked for its window, which on Linux is the same event a user
/// reported: the process is up, the taskbar has an entry, there is nothing on
/// screen. 2.6.7 said nothing at all in that moment. The reporter's own
/// workaround is in here, plus the one thing that separates the two known
/// causes, so the next person gets an answer from the app instead of from a
/// three-day Discord thread.
///
/// None off Linux: this text is about a Linux graphics stack and would be
/// nonsense anywhere else.
pub(crate) fn linux_no_window_hint(linux: bool, wayland: bool, in_appimage: bool) -> Option<String> {
    if !linux {
        return None;
    }
    let mut msg = String::from(
        "[Linux] The window never asked to be shown. If nothing is on screen, the webview \
         did not start.",
    );
    if wayland {
        msg.push_str(
            "\n[Linux] This is a Wayland session. Start LU from a terminal and read the first \
             error line:\n\
             [Linux]   \"Could not create default EGL display: EGL_BAD_PARAMETER\" means the \
             bundled wayland library is the cause.\n\
             [Linux]   \"AcceleratedSurfaceDMABuf was unable to construct a complete \
             framebuffer\" means the webkit DMA-BUF renderer is.",
        );
    }
    if in_appimage {
        msg.push_str(
            "\n[Linux] Two things to try, each on its own:\n\
             [Linux]   LD_PRELOAD=/usr/lib/libwayland-client.so.0 ./LU.AppImage\n\
             [Linux]   GDK_BACKEND=x11 ./LU.AppImage",
        );
    } else {
        msg.push_str("\n[Linux] Try: GDK_BACKEND=x11 before starting LU.");
    }
    msg.push_str(&format!(
        "\n[Linux] To start with none of LU's own workarounds: {WAYLAND_OPT_OUT}=1"
    ));
    Some(msg)
}

/// How long the app waits after the window went to the tray before it releases
/// the local model backends. Long enough that a mis-click plus an immediate
/// reopen costs nothing, short enough that the GPU is not pinned for a coffee
/// break by a window the user believes is closed.
const HIDE_OFFLOAD_GRACE: std::time::Duration = std::time::Duration::from_secs(30);

/// Should the delayed post-hide offload still run?
///
/// `visible_now` is what the window reports once the grace period is over, so
/// a reopen inside the grace period cancels the offload. `hide_generation` is
/// the counter value the timer was started with and `current_generation` the
/// value now: a hide → show → hide sequence leaves an older timer in flight,
/// and that stale timer must not free the VRAM of the newer session seconds
/// after it started. Only the newest timer for a still-hidden window offloads.
///
/// Pure on purpose: the window handle is not constructible in a unit test, the
/// decision is. See `tests::hidden_offload_*`.
fn should_offload_after_hide(visible_now: bool, hide_generation: u64, current_generation: u64) -> bool {
    !visible_now && hide_generation == current_generation
}

/// Does a click on the Dock icon have to bring a window back?
///
/// Fehlerkontrolle Mac 2, Fund 1: the red traffic light hides the window
/// (`CloseRequested` below) and the app stays in the Dock. A click on the Dock
/// icon, or Cmd+Tab to the app, is the way every Mac user gets a window back,
/// and macOS reports it as `RunEvent::Reopen`. Nobody handled it, so the app
/// sat in the Dock without a window and looked hung; the only way back was the
/// "Show" item of the menu bar icon.
///
/// With a window on screen macOS already does the right thing by itself
/// (it activates the app and raises that window), so only the case without
/// one is ours. During the onboarding the small onboarding window is the
/// visible one and the hidden main window must stay hidden; that case arrives
/// here as `true` and is left alone.
#[cfg(any(target_os = "macos", test))]
fn reopen_needs_a_window(has_visible_windows: bool) -> bool {
    !has_visible_windows
}

/// A menu bar template image out of the app icon.
///
/// Fehlerkontrolle Mac 2, Fund 11. macOS draws a template image from its
/// alpha channel alone and colours it itself: black on a light menu bar,
/// white on a dark one, dimmed on an inactive display. The app icon is white
/// lettering on an opaque black plate, so used as it is the menu bar showed a
/// black tile that no other menu bar item looks like, and marking that same
/// picture as a template would have drawn the whole plate as one solid
/// square. The lettering is what has to stay: brightness becomes opacity, the
/// plate falls away, the colour is left to the system.
///
/// `PLATE_FLOOR` cuts the near-black of the plate and its antialiased edge to
/// nothing, so no faint square remains around the letters.
#[cfg(any(target_os = "macos", test))]
fn menu_bar_template_rgba(rgba: &[u8]) -> Vec<u8> {
    const PLATE_FLOOR: u32 = 48;
    let mut out = Vec::with_capacity(rgba.len());
    for px in rgba.as_chunks::<4>().0 {
        let brightness = (px[0] as u32 + px[1] as u32 + px[2] as u32) / 3;
        let alpha = if brightness < PLATE_FLOOR { 0 } else { px[3] as u32 * brightness / 255 };
        out.extend_from_slice(&[0, 0, 0, alpha as u8]);
    }
    out
}

/// How many rotated log files survive. The appender prunes on every
/// rotation, so this is "roughly the last week" at one file per day.
///
/// The number is a support trade-off, not a storage one: a user reporting a
/// bug from Monday is usually asked for the log on Wednesday, and a file that
/// was already pruned cannot be sent. Seven days of a desktop app's log is a
/// few MB — small enough that nobody notices, long enough that a report which
/// took a weekend to write still has its evidence.
const LOG_FILES_KEPT: usize = 7;

/// Build the rolling-file writer for the app log.
///
/// Returns the non-blocking writer together with its `WorkerGuard`. The guard
/// is the classic `tracing-appender` trap: it owns the background thread that
/// actually performs the writes, and dropping it shuts that thread down and
/// flushes. Dropped at the end of the function that made it — the shape you
/// get from `let (w, _guard) = non_blocking(...)` inside a helper — the log
/// file ends up empty or nearly so, which looks exactly like "the logging
/// never worked". So it is handed back to `run`, which holds it for as long
/// as the process runs. See the caller.
///
/// Returns `None` rather than failing the launch when the directory cannot be
/// created (read-only home, full disk, a locked-down corporate profile): a
/// missing log file is a degraded app, an app that refuses to start because
/// it could not open its log file is a broken one.
fn file_log_writer() -> Option<(tracing_appender::non_blocking::NonBlocking, tracing_appender::non_blocking::WorkerGuard)> {
    let dir = os_paths::log_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        // Same constants the `log_file_path` command reports from, so
        // Settings can never point at a name the appender does not write.
        .filename_prefix(commands::logging::LOG_FILE_PREFIX)
        .filename_suffix(commands::logging::LOG_FILE_SUFFIX)
        .max_log_files(LOG_FILES_KEPT)
        .build(&dir)
        .ok()?;
    Some(tracing_appender::non_blocking(appender))
}

/// Initialise tracing-subscriber once on app start. `LU_LOG_FORMAT=json`
/// switches to single-line JSON output (one object per event) for users
/// who pipe LU's stdout into Loki / Vector / a log file consumed by
/// something machine-readable. Default is the compact text formatter
/// because most desktop users just want a readable terminal.
///
/// `RUST_LOG` is honored as the filter — common values are `info`,
/// `locally_uncensored_lib=debug` (the library name, see Cargo.toml), or a per-module spec.
///
/// Audit finding #01: until now this was the stdout layer and nothing else,
/// and a shipped desktop app has no stdout. On Windows the release binary is
/// built with `windows_subsystem = "windows"`; on macOS it is launched from
/// Finder; the DevTools console only opens under `debug_assertions`. Every
/// line the app produced went nowhere, so a crash on a user's machine left no
/// artefact at all and any bug that did not reproduce locally was unreachable.
/// A rolling file layer is added ALONGSIDE the console layer — the terminal
/// output a developer runs `cargo tauri dev` for is unchanged, there is simply
/// now also a file to ask a user for.
///
/// The file layer is always the plain text formatter, even under
/// `LU_LOG_FORMAT=json`: that switch exists for someone piping stdout into a
/// log processor, whereas the file's reader is a human reading a support
/// attachment. ANSI is off for the same reason — escape codes in a file the
/// user opens in Notepad are noise.
///
/// Returns the writer's `WorkerGuard`, which the caller MUST keep alive.
#[must_use = "the WorkerGuard must outlive the app or the log file stays empty"]
fn init_tracing() -> Option<tracing_appender::non_blocking::WorkerGuard> {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};
    // `try_init` instead of `init` so we never panic if something else
    // (a test harness, a re-import) already set the global subscriber.
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let json_mode = std::env::var("LU_LOG_FORMAT")
        .map(|v| v.eq_ignore_ascii_case("json"))
        .unwrap_or(false);
    let (file_layer, guard) = match file_log_writer() {
        Some((writer, guard)) => (
            Some(
                fmt::layer()
                    .with_writer(writer)
                    .with_ansi(false)
                    .with_timer(VersionedTime)
                    .fmt_fields(EnglishFields(fmt::format::DefaultFields::new())),
            ),
            Some(guard),
        ),
        None => (None, None),
    };
    if json_mode {
        let _ = tracing_subscriber::registry()
            .with(filter)
            .with(file_layer)
            .with(
                fmt::layer()
                    .json()
                    .with_current_span(false)
                    .with_span_list(false)
                    .fmt_fields(EnglishFields(fmt::format::JsonFields::new())),
            )
            .try_init();
    } else {
        let _ = tracing_subscriber::registry()
            .with(filter)
            .with(file_layer)
            .with(fmt::layer().compact().fmt_fields(EnglishFields(fmt::format::DefaultFields::new())))
            .try_init();
    }
    guard
}

/// Tracing on a phone: no stdout.
///
/// Android has no stdout at all, so the lines go to logcat under the tag
/// `LU` (`adb logcat -s LU`). iOS gets the plain text layer on stderr, which
/// is what Xcode and `xcrun simctl launch --console-pty` show.
///
/// Both also write the same daily log files the desktop has, which is what
/// "Share log" reads (`read_log_tail`). A phone only learns its data folder
/// inside `setup` (`os_paths::set_mobile_dirs`), so the file layer writes
/// into `logging::LateFile`, which keeps the first lines until `setup` names
/// the folder (`logging::open_late_log`).
#[cfg(mobile)]
fn init_mobile_tracing() {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    // The file is what "Share log" hands out: its lines name `lu`, not the
    // module path of the crate (phone_log.rs, round 22, N12).
    let file_layer = fmt::layer()
        .with_writer(|| commands::logging::LateFile)
        .with_ansi(false)
        .event_format(phone_log::PhoneFormat)
        .fmt_fields(EnglishFields(fmt::format::DefaultFields::new()));
    #[cfg(target_os = "android")]
    {
        // Without logcat the file is still worth having.
        let _ = tracing_subscriber::registry()
            .with(filter)
            .with(tracing_android::layer("LU").ok())
            .with(file_layer)
            .try_init();
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = tracing_subscriber::registry()
            .with(filter)
            .with(file_layer)
            .with(
                fmt::layer()
                    .with_writer(std::io::stderr)
                    .with_ansi(false)
                    .fmt_fields(EnglishFields(fmt::format::DefaultFields::new())),
            )
            .try_init();
    }
}

/// The file log's timestamp, followed by the version of the build that wrote
/// the line.
///
/// A daily log file holds every run of that day and the file keeps seven days,
/// so after an update it still carries the lines of the version before. Only
/// the start line used to name a version, and a Discord report (3.0.7) had a
/// user on 3.0.6 reading "3.0.5" in his logs: the lines of the run before the
/// update, with nothing on them to say so. With the version on every line,
/// each one says which build wrote it. File only: the console is read by the
/// developer who started that very build.
struct VersionedTime;

impl tracing_subscriber::fmt::time::FormatTime for VersionedTime {
    fn format_time(&self, w: &mut tracing_subscriber::fmt::format::Writer<'_>) -> std::fmt::Result {
        tracing_subscriber::fmt::time::SystemTime.format_time(w)?;
        write!(w, " v{}", app_identity::APP_VERSION)
    }
}

/// A field formatter that runs the finished text through `os_error`.
///
/// The house rule is that our messages are English, and `os_error` keeps every
/// call site of ours to it. A log line written INSIDE a dependency is out of
/// that reach: hyper-util renders a failed `set_nodelay` itself, and on the
/// German Windows box that landed in lu-app-exit.log as
/// `tcp set_nodelay error: Ein ungueltiges Argument wurde angegeben.
/// (os error 10022)`. We cannot patch the crate, but every event passes
/// through here on its way out, so this is where the wording gets repaired.
///
/// It wraps the real formatter rather than replacing it, so the text and the
/// JSON mode keep their exact shapes (including the JSON escaping) and only
/// the operating system's own words are swapped for ours.
struct EnglishFields<F>(F);

impl<'writer, F> tracing_subscriber::fmt::FormatFields<'writer> for EnglishFields<F>
where
    F: for<'a> tracing_subscriber::fmt::FormatFields<'a>,
{
    fn format_fields<R: tracing_subscriber::field::RecordFields>(
        &self,
        mut writer: tracing_subscriber::fmt::format::Writer<'writer>,
        fields: R,
    ) -> std::fmt::Result {
        let mut buf = String::new();
        self.0
            .format_fields(tracing_subscriber::fmt::format::Writer::new(&mut buf), fields)?;
        writer.write_str(&os_error::sanitize_os_wording(&buf))
    }
}

// What llama.cpp needs from the system on iOS, written into the object file
// itself (Mach-O LC_LINKER_OPTION, the mechanism behind Clang's autolinking).
//
// On iOS this crate is a static library and Xcode links the app, so the
// `cargo:rustc-link-lib=framework=...` lines of llama-cpp-sys-2's build
// script reach nobody. The generated Xcode project happens to name Metal and
// MetalKit, but not Accelerate, and the link then stops with ten undefined
// `_vDSP_*` symbols from ggml. Naming the frameworks here keeps
// `src-tauri/gen/apple` a plain `tauri ios init` result that can be thrown
// away and generated again without a manual step.
//
// It sits next to `run()` on purpose: the linker only honours the options of
// archive members it loads, and the member holding the entry point is loaded
// always.
// Guard: src/lib/__tests__/mobile-ios-fallen.test.ts
#[cfg(target_os = "ios")]
core::arch::global_asm!(
    ".linker_option \"-framework\", \"Accelerate\"",
    ".linker_option \"-framework\", \"Metal\"",
    ".linker_option \"-framework\", \"MetalKit\"",
    ".linker_option \"-framework\", \"Foundation\"",
    ".linker_option \"-lc++\"",
);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First thing of all: a panic anywhere must leave a trace. The release
    // profile is `panic = "abort"`, so a panic on any thread ends the process
    // immediately, and a shipped Windows build has no console to print to.
    // Without this hook such a death is indistinguishable from the app being
    // killed from outside, which is exactly the confusion the 2026-08-29
    // Windows investigation had to untangle by hand.
    crash_report::install_panic_hook();

    // Android calls this function from every Activity.onCreate, and it
    // recreates the activity inside the running process on a resource-overlay
    // change. A second app in one process ended in a crash dialog
    // (android_entry.rs has the whole story). The second call builds nothing.
    #[cfg(target_os = "android")]
    if !android_entry::first_run_in_this_process() {
        android_entry::second_entry();
    }

    // `if cfg!` and not `#[cfg]`: the function is module-level on purpose so the
    // no-overwrite logic is unit-testable off Linux (see the note on it), and a
    // `#[cfg]` here left it without a single caller in a macOS build — dead code
    // by rustc's reckoning, for a function whose whole point is being reachable
    // from the tests.
    if cfg!(target_os = "linux") {
        apply_linux_webview_env();
    }
    // Before anything can spawn a child: an AppImage exports PYTHONHOME and
    // PYTHONPATH into its own mount, and every python3 we start inherits them
    // and dies on "No module named 'encodings'".
    python::sanitize_appimage_python_env();

    // Bound to a named local, not `let _ = ...`: `_log_guard` lives until the
    // end of `run`, i.e. as long as the app runs, while `_` would drop the
    // guard on this very line and take the file writer's worker thread down
    // with it before the first line was written.
    #[cfg(desktop)]
    let _log_guard = init_tracing();
    #[cfg(mobile)]
    init_mobile_tracing();
    // The desktop: the version of the crate, as before. A phone: the version
    // of its package (app_identity::APP_VERSION, round 22, N13).
    tracing::info!(
        version = app_identity::APP_VERSION,
        "LU starting"
    );

    let app_state = AppState::new();

    let builder = tauri::Builder::default();
    // A phone starts one instance of an app by itself, and the crate behind
    // this plugin is empty there.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 2nd launch → focus the existing window instead of spawning
            // another process. "The" window is the onboarding window while
            // setup runs, the main window afterwards (onboarding_window.rs).
            onboarding_window::bring_to_front(app);
        }));
    let builder = builder.plugin(tauri_plugin_shell::init());
    // Tells every webview what this binary was built for (desktop or
    // phone), before the page runs. The page decides by it which interface
    // loads, instead of guessing from the navigator (host_kind.rs).
    let builder = builder.plugin(host_kind::plugin());
    // The native layer of the phones (plugins/lu-native).
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_lu_native::init());
    // The links that open the app: lu://oauth/callback and lu://remote on a
    // phone, locallyuncensored://open-model on the desktop (hf_link.rs).
    let builder = builder.plugin(tauri_plugin_deep_link::init());
    // Updates of a phone app come through the store.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    // Only the stop shortcut of computer use, registered from Rust while a
    // session runs. The interface gets no permission for this plugin. A phone
    // has no computer use and no global shortcuts.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

    use commands::mobile_guard::GuardExt as _;
    builder
        .manage(app_state)
        .manage(commands::oauth::OauthPending::default())
        // Entries marked `#[cfg(desktop)]` are not registered on a phone:
        // ComfyUI's websocket, every installer, the character trainer, the
        // MLX image and video engine, the gallery trash, the AppImage
        // self-migration and the import from Ollama or LM Studio. None of
        // them has anything to act on there. Everything else keeps its name
        // on every platform, so the frontend calls one set of commands.
        // `mobile_guard()` stands in front of the whole list: on a phone it
        // refuses what starts a process or a server (the list is in
        // commands/mobile_guard.rs), on the desktop it does nothing.
        .mobile_guard()
        .invoke_handler(tauri::generate_handler![
            // The chat's HTML preview: a loopback page with its own closed
            // policy, served while a preview is open (html_preview.rs). Desktop
            // only: a phone starts no server, and its agent preview has its own.
            #[cfg(desktop)]
            html_preview::html_preview_put,
            #[cfg(desktop)]
            html_preview::html_preview_close,
            // Hugging Face "Use this model": the page takes the waiting link
            #[cfg(desktop)]
            hf_link::hf_link_take,
            // LU Cloud OAuth loopback (Google/GitHub via system browser)
            commands::oauth::oauth_start,
            commands::oauth::oauth_wait,
            // Process management
            commands::process::start_ollama,
            commands::process::start_comfyui,
            commands::process::stop_comfyui,
            commands::process::kill_process_tree,
            commands::process::fix_comfyui_cors,
            commands::process::comfyui_status,
            commands::process::comfyui_last_output,
            commands::process::find_comfyui,
            commands::process::detect_all_comfyui_installs,
            commands::process::set_comfyui_path,
            commands::process::set_comfy_gpu_mode,
            commands::process::get_comfy_gpu_status,
            commands::process::comfy_torch_plan,
            commands::process::set_comfyui_port,
            commands::process::set_comfyui_autostart,
            commands::process::set_comfyui_host,
            commands::process::set_ollama_host,
            commands::process::get_ollama_host,
            commands::process::offload_local_models,
            // ComfyUI progress WebSocket via Rust (0.19+ origin-check bypass)
            #[cfg(desktop)]
            commands::comfy_ws::comfy_ws_connect,
            #[cfg(desktop)]
            commands::comfy_ws::comfy_ws_disconnect,
            // Installation
            #[cfg(desktop)]
            commands::install::install_comfyui,
            #[cfg(desktop)]
            commands::install::install_comfyui_status,
            #[cfg(desktop)]
            commands::install::repair_comfyui_env,
            #[cfg(desktop)]
            commands::install::update_comfyui,
            #[cfg(desktop)]
            commands::install::cancel_comfyui_install,
            #[cfg(desktop)]
            commands::install::install_ollama,
            #[cfg(desktop)]
            commands::install::install_ollama_status,
            #[cfg(desktop)]
            commands::install::install_lmstudio,
            #[cfg(desktop)]
            commands::install::install_lmstudio_status,
            #[cfg(desktop)]
            commands::install::start_lmstudio_server,
            #[cfg(desktop)]
            commands::install::lmstudio_server_status,
            #[cfg(desktop)]
            commands::install::lmstudio_list_loaded,
            #[cfg(desktop)]
            commands::install::lmstudio_cancel_load,
            #[cfg(desktop)]
            commands::install::lmstudio_load_model,
            #[cfg(desktop)]
            commands::install::lmstudio_model_context,
            #[cfg(desktop)]
            commands::install::lmstudio_unload_model,
            #[cfg(desktop)]
            commands::install::install_python,
            #[cfg(desktop)]
            commands::install::install_python_status,
            #[cfg(desktop)]
            commands::install::python_check,
            #[cfg(desktop)]
            commands::install::install_custom_node,
            #[cfg(desktop)]
            commands::install::list_custom_nodes,
            #[cfg(desktop)]
            commands::install::remove_custom_node,
            #[cfg(desktop)]
            commands::install::custom_node_log,
            #[cfg(desktop)]
            commands::install::install_whisper,
            #[cfg(desktop)]
            commands::install::install_whisper_status,
            #[cfg(desktop)]
            commands::install::install_tts,
            #[cfg(desktop)]
            commands::install::install_tts_status,
            #[cfg(desktop)]
            commands::install::check_git_installed,
            // Local character trainer (musubi-tuner)
            #[cfg(desktop)]
            commands::trainer::install_character_trainer,
            #[cfg(desktop)]
            commands::trainer::character_trainer_status,
            #[cfg(desktop)]
            commands::trainer::stage_training_image,
            #[cfg(desktop)]
            commands::trainer::clear_training_set,
            #[cfg(desktop)]
            commands::trainer::start_character_training,
            #[cfg(desktop)]
            commands::trainer::character_training_status,
            #[cfg(desktop)]
            commands::trainer::cancel_character_training,
            // Remove refusals from a local model (A14)
            commands::abliterate::abliterate_plan,
            commands::abliterate::abliterate_start,
            commands::abliterate::abliterate_status,
            commands::abliterate::abliterate_cancel,
            commands::abliterate::abliterate_dismiss,
            commands::abliterate::abliterate_runs,
            commands::abliterate::abliterate_trash_copy,
            // Neuron tweaker (3.0.9, P11)
            #[cfg(desktop)]
            commands::neuron::neuron_presets,
            #[cfg(desktop)]
            commands::neuron::neuron_info,
            #[cfg(desktop)]
            commands::neuron::neuron_build,
            #[cfg(desktop)]
            commands::neuron::neuron_feature_add,
            #[cfg(desktop)]
            commands::neuron::neuron_delete,
            #[cfg(desktop)]
            commands::neuron::neuron_sae_download,
            #[cfg(desktop)]
            commands::neuron::neuron_sae_search,
            #[cfg(desktop)]
            commands::neuron::neuron_status,
            #[cfg(desktop)]
            commands::neuron::neuron_cancel,
            #[cfg(desktop)]
            commands::neuron::neuron_dismiss,
            #[cfg(desktop)]
            commands::neuron::neuron_apply,
            #[cfg(desktop)]
            commands::neuron::neuron_compare,
            // Whisper STT
            commands::whisper::whisper_status,
            commands::whisper::transcribe,
            // Piper neural TTS
            commands::tts::tts_status,
            commands::tts::synthesize,
            commands::tts::synthesize_external,
            commands::tts::download_voice,
            commands::tts::installed_piper_voices,
            // Agent tools (legacy)
            commands::agent::execute_code,
            commands::agent::execute_code_cancel,
            commands::agent::file_read,
            commands::agent::file_write,
            commands::agent::set_chat_workspace_override,
            commands::agent::get_chat_workspace_override,
            commands::agent::list_agent_workspaces,
            // Shell
            // REA as an agent plugin: the pinned package and what its start needs.
            commands::plugin_rea::plugin_rea_status,
            commands::plugin_rea::mcp_child_path,
            commands::plugin_rea::plugin_rea_fetch,
            commands::plugin_rea::plugin_rea_guard,
            commands::shell::shell_execute,
            commands::shell::shell_execute_cancel,
            // Filesystem
            commands::filesystem::fs_read,
            commands::filesystem::fs_read_bytes,
            commands::filesystem::fs_delete,
            commands::filesystem::fs_write,
            commands::filesystem::fs_write_bytes,
            commands::filesystem::fs_list,
            commands::filesystem::fs_search,
            commands::filesystem::fs_info,
            commands::filesystem::save_text_file_dialog,
            commands::filesystem::save_binary_file_dialog,
            commands::filesystem::validate_workspace_folder,
            #[cfg(desktop)]
            commands::filesystem::fs_whole_computer,
            #[cfg(desktop)]
            commands::filesystem::fs_whole_computer_forget,
            // System
            commands::system::system_info,
            commands::system::process_list,
            commands::system::screenshot,
            commands::system::pick_folder,
            // Settings, Storage: the folder of the voice engine, the
            // read-aloud voices and LU's own Python.
            commands::runtime_folder::runtime_folder_status,
            commands::runtime_folder::set_runtime_folder,
            commands::runtime_folder::move_runtime_folder,
            commands::storage::storage_status,
            commands::storage::storage_plan,
            commands::storage::storage_apply,
            commands::storage::storage_cancel,
            commands::system::is_onboarding_done,
            commands::system::set_onboarding_done,
            commands::system::get_current_time,
            commands::system::backup_stores,
            commands::chat_attachments::write_chat_attachment,
            commands::chat_attachments::read_chat_attachment,
            commands::chat_attachments::save_chat_attachment_dialog,
            // Desktop only: it asks a save dialog (rfd) where the file goes.
            #[cfg(desktop)]
            commands::cloud_file::save_cloud_file_dialog,
            #[cfg(desktop)]
            commands::cloud_file::cancel_cloud_file,
            #[cfg(desktop)]
            commands::character_files::import_cloud_character,
            commands::character_files::character_photos,
            commands::chat_attachments::export_chats_dialog,
            commands::chat_attachments::import_chats_dialog,
            commands::model_sniff::sniff_model_files,
            #[cfg(desktop)]
            commands::gallery_files::trash_comfy_output,
            commands::system::restore_stores,
            commands::system::backup_rag_chunks,
            commands::system::restore_rag_chunks,
            commands::system::exit_app,
            commands::system::restart_after_update,
            // Who owns this copy of LU (the updater plugin never asks)
            commands::install_method_cmd::install_method,
            #[cfg(desktop)]
            commands::self_migrate_cmd::self_migrate_stage,
            #[cfg(desktop)]
            commands::self_migrate_cmd::self_migrate_finish,
            // Downloads. Where an entry comes in a desktop and a mobile
            // form, the phone hands the transfer to the operating system
            // (commands/download_mobile.rs): same name, same answer.
            commands::download::download_model,
            commands::download::comfy_model_target,
            #[cfg(desktop)]
            commands::comfy_user_paths::comfy_folder_targets,
            #[cfg(desktop)]
            commands::download::download_model_to_path,
            #[cfg(mobile)]
            commands::download_mobile::download_model_to_path,
            #[cfg(desktop)]
            commands::download::download_progress,
            #[cfg(mobile)]
            commands::download_mobile::download_progress,
            #[cfg(desktop)]
            commands::download::pause_download,
            #[cfg(mobile)]
            commands::download_mobile::pause_download,
            #[cfg(desktop)]
            commands::download::cancel_download,
            #[cfg(mobile)]
            commands::download_mobile::cancel_download,
            #[cfg(desktop)]
            commands::download::clear_download_entry,
            #[cfg(mobile)]
            commands::download_mobile::clear_download_entry,
            commands::download::check_download_space,
            #[cfg(desktop)]
            commands::download::find_orphan_downloads,
            #[cfg(mobile)]
            commands::download_mobile::find_orphan_downloads,
            commands::download::delete_orphan_download,
            #[cfg(desktop)]
            commands::download::remove_image_part,
            #[cfg(desktop)]
            commands::download::resume_download,
            #[cfg(mobile)]
            commands::download_mobile::resume_download,
            #[cfg(desktop)]
            commands::download::set_download_limit,
            #[cfg(mobile)]
            commands::download_mobile::set_download_limit,
            commands::download::detect_model_path,
            commands::download::lmstudio_model_dir,
            commands::download::check_model_sizes,
            commands::download::delete_comfy_model,
            // Check files and Repair (GH #113)
            commands::model_verify::verify_model_files,
            commands::model_verify::verify_model_files_status,
            commands::model_verify::verify_model_files_cancel,
            commands::model_verify::trash_model_file,
            // Built-in inference engine (bundled llama-server, P1)
            commands::engine::start_bundled_engine,
            commands::engine::stop_bundled_engine,
            commands::engine::bundled_engine_status,
            commands::engine::kv_slot_action,
            commands::engine_idle::set_engine_idle_unload,
            commands::engine::swap_bundled_model,
            commands::engine::list_bundled_models,
            commands::engine::delete_bundled_model,
            #[cfg(desktop)]
            commands::engine::list_importable_models,
            // The user's own model folder, handed to ComfyUI (GH #122)
            #[cfg(desktop)]
            commands::custom_models::sync_custom_model_paths,
            #[cfg(desktop)]
            commands::engine::import_local_model,
            #[cfg(desktop)]
            commands::engine::pick_gguf_file,
            // Built-in embeddings server (bundled llama-server --embeddings, P5)
            commands::engine_key::engine_key_for,
            commands::engine::start_bundled_embed,
            commands::engine::stop_bundled_embed,
            commands::engine::bundled_embed_status,
            // In-process MLX media engine (macOS Apple-Silicon local image/video,
            // spawned in-process — no separate bridge daemon). See media_cmds.rs.
            #[cfg(desktop)]
            commands::media_cmds::mlx_status,
            #[cfg(desktop)]
            commands::media_cmds::mlx_start,
            #[cfg(desktop)]
            commands::media_cmds::mlx_unload,
            #[cfg(desktop)]
            commands::media_cmds::mlx_generate,
            #[cfg(desktop)]
            commands::media_cmds::mlx_generate_progress,
            #[cfg(desktop)]
            commands::media_cmds::mlx_generate_cancel,
            #[cfg(desktop)]
            commands::media_cmds::mlx_enhance_prompt,
            #[cfg(desktop)]
            commands::media_cmds::mlx_upscale,
            #[cfg(desktop)]
            commands::media_cmds::mlx_loras,
            #[cfg(desktop)]
            commands::media_cmds::mlx_loras_open_folder,
            #[cfg(desktop)]
            commands::media_cmds::mlx_lora_delete,
            #[cfg(desktop)]
            commands::media_cmds::mlx_output_trash,
            #[cfg(desktop)]
            commands::media_cmds::mlx_cutout,
            #[cfg(desktop)]
            commands::media_cmds::mlx_image_models,
            // Not desktop-only like their neighbours: a model download on a
            // phone sends the Hugging Face token too.
            commands::media_cmds::set_hf_token,
            commands::media_cmds::hf_token_present,
            #[cfg(desktop)]
            commands::media_cmds::mlx_image_install_model,
            #[cfg(desktop)]
            commands::media_cmds::mlx_image_install_status,
            #[cfg(desktop)]
            commands::media_cmds::mlx_image_cancel_install,
            #[cfg(desktop)]
            commands::media_cmds::mlx_image_delete_model,
            #[cfg(desktop)]
            commands::media_cmds::install_mlx_diffusion,
            #[cfg(desktop)]
            commands::media_cmds::install_mlx_diffusion_status,
            #[cfg(desktop)]
            commands::media_cmds::video_status,
            #[cfg(desktop)]
            commands::media_cmds::video_list_models,
            #[cfg(desktop)]
            commands::media_cmds::video_install_mlx,
            #[cfg(desktop)]
            commands::media_cmds::video_install_mlx_status,
            #[cfg(desktop)]
            commands::media_cmds::video_install_model,
            #[cfg(desktop)]
            commands::media_cmds::video_install_model_status,
            #[cfg(desktop)]
            commands::media_cmds::video_cancel_model_install,
            #[cfg(desktop)]
            commands::media_cmds::video_delete_model,
            #[cfg(desktop)]
            commands::media_cmds::video_generate,
            #[cfg(desktop)]
            commands::media_cmds::video_progress,
            #[cfg(desktop)]
            commands::media_cmds::video_cancel,
            #[cfg(desktop)]
            commands::media_cmds::read_media_file,
            #[cfg(desktop)]
            commands::media_cmds::video_stage_start_image,
            #[cfg(desktop)]
            commands::media_cmds::video_stage_motion_video,
            #[cfg(desktop)]
            commands::media_cmds::video_stage_voice,
            // Colour settle across the seams of a long ComfyUI video (3.0.9).
            #[cfg(desktop)]
            commands::video_settle::video_color_settle,
            // The music engine of the Mac (ACE-Step 1.5). See commands/music.rs.
            #[cfg(desktop)]
            commands::media_cmds::mlx_music_status,
            #[cfg(desktop)]
            commands::media_cmds::mlx_music_install,
            #[cfg(desktop)]
            commands::media_cmds::mlx_music_install_status,
            #[cfg(desktop)]
            commands::media_cmds::mlx_music_cancel_install,
            #[cfg(desktop)]
            commands::media_cmds::mlx_music_delete,
            #[cfg(desktop)]
            commands::media_cmds::mlx_music_generate,
            #[cfg(desktop)]
            commands::media_cmds::mlx_music_progress,
            #[cfg(desktop)]
            commands::media_cmds::mlx_music_cancel,
            #[cfg(desktop)]
            commands::media_cmds::mlx_train_status,
            #[cfg(desktop)]
            commands::media_cmds::mlx_train_stage,
            #[cfg(desktop)]
            commands::media_cmds::mlx_train_clear,
            #[cfg(desktop)]
            commands::media_cmds::mlx_train_start,
            #[cfg(desktop)]
            commands::media_cmds::mlx_train_progress,
            #[cfg(desktop)]
            commands::media_cmds::mlx_train_cancel,
            // Astra voice loop: in-app setup and sidecar lifecycle. Desktop
            // only: it installs a private Python and starts a sidecar.
            #[cfg(desktop)]
            commands::voice_loop::voice_loop_requirements,
            #[cfg(desktop)]
            commands::voice_loop::voice_loop_install,
            #[cfg(desktop)]
            commands::voice_loop::voice_loop_install_status,
            #[cfg(desktop)]
            commands::voice_loop::voice_loop_install_cancel,
            #[cfg(desktop)]
            commands::voice_loop::voice_loop_status,
            #[cfg(desktop)]
            commands::voice_loop::voice_loop_start,
            #[cfg(desktop)]
            commands::voice_loop::voice_loop_set_voice,
            #[cfg(desktop)]
            commands::voice_loop::voice_loop_stop,
            #[cfg(desktop)]
            commands::voice_loop::voice_loop_uninstall,
            // Astra computer use. Desktop only (commands/mod.rs).
            #[cfg(desktop)]
            commands::computer::computer_status,
            #[cfg(desktop)]
            commands::computer::computer_permissions,
            #[cfg(desktop)]
            commands::computer::computer_permission_request,
            #[cfg(desktop)]
            commands::computer::computer_permission_reset,
            #[cfg(desktop)]
            commands::computer::computer_session_begin,
            #[cfg(desktop)]
            commands::computer::computer_chat_ask,
            #[cfg(desktop)]
            commands::computer::computer_chat_answer,
            #[cfg(desktop)]
            commands::computer::computer_session_allow_app,
            #[cfg(desktop)]
            commands::computer::computer_session_revoke_app,
            #[cfg(desktop)]
            commands::computer::computer_session_set_autonomous,
            #[cfg(desktop)]
            commands::computer::computer_session_end,
            #[cfg(desktop)]
            commands::computer::computer_stop,
            #[cfg(desktop)]
            commands::computer::computer_request_attention,
            #[cfg(desktop)]
            commands::computer::computer_pause,
            #[cfg(desktop)]
            commands::computer::computer_takeover_answer,
            #[cfg(desktop)]
            commands::computer::computer_watch,
            #[cfg(desktop)]
            commands::computer::computer_surface,
            #[cfg(desktop)]
            commands::computer::computer_surface_corner,
            #[cfg(desktop)]
            commands::computer::computer_guard,
            #[cfg(desktop)]
            commands::computer::computer_windows,
            #[cfg(desktop)]
            commands::computer::computer_screen,
            #[cfg(desktop)]
            commands::computer::computer_action,
            #[cfg(desktop)]
            commands::computer::computer_tree,
            // Provider API-key keychain (H5)
            commands::secret::secret_set,
            commands::secret::secret_get,
            commands::secret::secret_delete,
            // Parked keys for a displaced OpenAI-compatible backend's API
            // key (R9, 2026-09-18): narrow prefix-plus-validated-id vault
            // namespace, separate from the fixed ALLOWED_ACCOUNTS list above.
            commands::secret::secret_park_set,
            commands::secret::secret_park_get,
            commands::secret::secret_park_delete,
            // Web search
            commands::search::web_search,
            commands::search::web_fetch,
            commands::search::search_status,
            commands::search::install_searxng,
            commands::search::searxng_status,
            // Claude Code
            // Remote Access
            commands::local_api::start_local_api,
            commands::local_api::stop_local_api,
            commands::local_api::local_api_status,
            commands::local_api::local_api_new_token,
            commands::local_api::local_api_usage,
            commands::remote::start_remote_server,
            commands::remote::revoke_remote_memory,
            commands::remote::stop_remote_server,
            commands::remote::restart_remote_server,
            commands::remote::remote_server_status,
            commands::remote::regenerate_remote_token,
            commands::remote::remote_qr_code,
            commands::remote::remote_connected_devices,
            commands::remote::disconnect_remote_device,
            commands::remote::set_remote_permissions,
            commands::remote::set_remote_page_title,
            commands::remote::start_tunnel,
            commands::remote::stop_tunnel,
            commands::remote::tunnel_status,
            commands::remote::remote_pairing_qr,
            commands::remote::remote_pairing_window,
            commands::remote_sealed::remote_paired_devices,
            commands::remote_sealed::remote_forget_device,
            commands::remote_sealed::remote_set_device_rights,
            commands::remote_sealed::remote_set_new_device_rights,
            commands::win_firewall::remote_firewall_status,
            commands::win_firewall::remote_firewall_allow,
            commands::remote_sealed::remote_pair_decide,
            commands::remote_sealed::remote_pair_requests,
            commands::remote_sealed::remote_set_anywhere,
            commands::remote_sealed::remote_set_legacy_access,
            commands::remote_sealed::remote_signin_requests,
            commands::remote_sealed::remote_signin_decide,
            commands::remote_create::remote_create_progress,
            commands::remote_create::remote_create_finish,
            commands::remote_create::remote_create_capabilities_reply,
            commands::remote_create::remote_create_gallery_reply,
            commands::remote_chats::remote_chats_sync,
            commands::remote_chats::remote_chats_event,
            commands::remote_chats::remote_chats_reply,
            #[cfg(feature = "e2e-remote")]
            e2e_remote::remote_e2e_mode,
            commands::remote_create::remote_create_cancel,
            commands::remote_create::remote_create_snapshot,
            // Proxy
            commands::proxy::ollama_search,
            commands::proxy::fetch_external,
            commands::proxy::fetch_external_bytes,
            commands::proxy::proxy_localhost,
            commands::proxy::cancel_proxy_call,
            commands::proxy::proxy_localhost_stream,
            commands::proxy::proxy_localhost_stream_chunked,
            commands::proxy::cancel_proxy_stream,
            commands::proxy::comfy_upload_image,
            commands::proxy::register_openai_host,
            commands::proxy::pull_model_stream,
            commands::proxy::cancel_model_pull,
            // The Cloud switch counts its presses anonymously (funnel.rs)
            commands::funnel::funnel_ping,
            // B7 (the web app Phase 4 inspiration) — one-shot diagnostic probe
            commands::health::system_health,
            // Audit #01 — the app log file: the frontend mirrors its warn /
            // error lines into it, Settings shows and opens it.
            commands::logging::log_write,
            commands::logging::log_file_path,
            commands::logging::log_reveal,
            // "Share log" on a phone: the end of the log as text (a phone
            // has no folder to reveal). The desktop reveals the folder
            // instead (log_reveal) and does not carry this command.
            #[cfg(mobile)]
            commands::logging::read_log_tail,
            // Bug BB v2.5.0 — a user GPU picker
            commands::gpu::detect_gpus,
            commands::gpu::set_gpu_selection,
            commands::gpu::get_gpu_selection,
            commands::gpu_roles::set_gpu_roles,
            commands::gpu_roles::get_gpu_roles,
            commands::engine::describe_gpu_roles,
            // Codex / Sprint A #2 — Repo-Map with Aider PageRank
            commands::repo_map::repo_map,
            // Codex / Sprint C #7 — long-running background shell tasks
            commands::bg_tasks::shell_task_start,
            commands::bg_tasks::shell_task_status,
            commands::bg_tasks::shell_task_kill,
            commands::bg_tasks::shell_task_list,
            // Window management
            commands::process::show_window,
            onboarding_window::onboarding_window_open,
            // The phone as a Remote client of a desktop LU, and the way to
            // the app's page in the system settings (commands/mobile_native.rs).
            #[cfg(mobile)]
            commands::mobile_native::remote_client_request,
            #[cfg(mobile)]
            commands::mobile_native::remote_client_cancel,
            // The sealed channel to a desktop (REMOTE-PROTOKOLL v2), the only
            // way to a desktop over the internet (commands/remote_sealed.rs).
            #[cfg(mobile)]
            commands::remote_sealed_phone::remote_sealed_pair,
            #[cfg(mobile)]
            commands::remote_sealed_phone::remote_sealed_request,
            #[cfg(mobile)]
            commands::remote_sealed_phone::remote_sealed_fetch_result,
            #[cfg(mobile)]
            commands::remote_sealed_phone::remote_sealed_cancel,
            #[cfg(mobile)]
            commands::remote_sealed_phone::remote_sealed_forget,
            #[cfg(mobile)]
            commands::remote_sealed_phone::remote_sealed_signin,
            #[cfg(mobile)]
            commands::mobile_native::open_system_settings,
            // The saved characters of Create, beside the store backup: a full
            // phone can make the WebView drop all of IndexedDB (gap L3).
            #[cfg(mobile)]
            commands::saved_characters_backup::saved_characters_backup_missing,
            #[cfg(mobile)]
            commands::saved_characters_backup::saved_characters_backup_put,
            #[cfg(mobile)]
            commands::saved_characters_backup::saved_characters_backup_write_index,
            #[cfg(mobile)]
            commands::saved_characters_backup::saved_characters_backup_read_index,
            #[cfg(mobile)]
            commands::saved_characters_backup::saved_characters_backup_read_photo,
        ])
        .setup(|app| {
            // A phone has no HOME the `dirs` crate could answer from. The
            // one folder the system gives the app is known from here on,
            // and every path helper in os_paths reads it.
            #[cfg(mobile)]
            os_paths::set_mobile_dirs(
                app.path().app_data_dir().ok(),
                app.path().app_cache_dir().ok(),
            );
            // From here on the log has a file (see init_mobile_tracing).
            #[cfg(mobile)]
            commands::logging::open_late_log(&os_paths::log_dir(), LOG_FILES_KEPT);
            // After the folders are known: the native layer learns where
            // models live, and the engine starts hearing memory warnings.
            #[cfg(mobile)]
            commands::mobile_native::setup(app.handle());

            // DevTools for debug builds used to open HERE, on the still
            // hidden main window. Measured on macOS (2026-09-01, debug
            // bundle): WebKit docks the inspector into the window and
            // orders that window front — a hidden main window became
            // visible at launch, next to the onboarding window. The
            // inspector now opens in `onboarding_window::reveal`, on
            // whichever window is actually shown, so a debug build behaves
            // like the shipped one.

            // The models an earlier Mac build left under ~/Library/Caches
            // move to the app's data folder. Here, before a window exists
            // and before a command can read a model folder: it is a rename,
            // and it does nothing on a Mac that has nothing to move. A phone
            // has no such store.
            #[cfg(desktop)]
            media_store::settle_at_start(&app.state::<AppState>());

            // locallyuncensored://open-model: the link that started the app
            // and every later one go to the inbox the page reads (hf_link.rs).
            #[cfg(desktop)]
            hf_link::setup(app.handle());

            // Remove Windows DWM shadow/border (the 1mm border around the window)
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_shadow(false);
            }

            // GitHub #162: WebKitGTK refuses the microphone unless the app
            // answers for it, and on Linux nobody else asks the user.
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.with_webview(|webview| linux_media::answer_microphone_requests(&webview.inner()));
            }

            // ─── Erststart: Onboarding im eigenen Fenster ───
            // Decided HERE, before any window is visible, from the marker file
            // (and the store backup, for installs older than the marker). With
            // the onboarding pending, a small centred window carries the wizard
            // and the main window stays hidden until the marker is written —
            // see onboarding_window.rs for the whole hand-over. A failure to
            // build that window fails setup: a hidden main window plus no
            // onboarding window would be an app without a window.
            //
            // Desktop only. A phone has exactly one window, and a second
            // webview behind it would be an onboarding nobody can reach in
            // front of an app that waits for it forever. There the wizard
            // runs in the main webview (`onboarding_window_open` answers
            // false, `AppShell.tsx` draws it).
            #[cfg(desktop)]
            if onboarding_window::decide_first_window() == onboarding_window::FirstWindow::Onboarding {
                onboarding_window::open(app.handle())?;
            }

            // ─── Bug D (surfingbird1010): force-show fallback ───
            // Every window starts hidden (visible:false in tauri.conf.json, and
            // the onboarding window is built the same way) and is normally
            // revealed by the frontend's invoke('show_window') once React
            // mounts. If the WebView never loads, or a render/hydration throw
            // happens before that effect runs (corrupt persisted state,
            // GPU/WebView2 fault), the window would stay hidden forever and the
            // app looks like it "runs with no window". Reveal the FRONT window
            // after a timeout so the user always gets one. The fallback goes
            // through the same rule as show_window, so it can never pop the
            // main window up over a running onboarding. The frontend's earlier
            // show_window is idempotent, so a healthy launch sees no
            // double-show / flicker. 10 s is comfortably longer than a normal
            // cold React mount (~1-2 s) yet short enough not to feel broken on
            // a slow i7/8 GB box.
            //
            // Desktop only: the one window of a phone is visible from the
            // start (tauri.android.conf.json, tauri.ios.conf.json).
            #[cfg(desktop)]
            onboarding_window::force_show_after(app.handle().clone(), onboarding_window::FORCE_SHOW_DELAY);

            // ─── The watch on the two llama-server sidecars ───
            // A16: a sidecar killed from outside (Task Manager, a crash, a
            // driver reset) was only noticed when something asked for its
            // status, and Settings asks once per mount. The watch asks on a
            // timer and emits `lu-sidecar-gone`, so the panel can be right
            // while it is standing open.
            commands::engine::spawn_sidecar_watch(app.handle().clone());

            // ─── System Tray ───
            // Desktop only, like the two sections after it: a phone has no
            // tray to hide in, and no Ollama or ComfyUI to start. Each
            // statement carries its own gate so the code keeps its place.
            #[cfg(desktop)]
            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            #[cfg(desktop)]
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            #[cfg(desktop)]
            let menu = Menu::with_items(app, &[&show, &quit])?;

            // GH #204: on Linux the tray needs libayatana-appindicator, and
            // building it without that library aborts the whole app. Without
            // it LU starts with no tray, and the close button quits.
            #[cfg(desktop)]
            let tray_present = system_tray::system_tray_available();

            #[cfg(desktop)]
            if tray_present {
                let tray_icon = Image::from_path("icons/icon.png")
                    .or_else(|_| Image::from_path("icons/32x32.png"))
                    .unwrap_or_else(|_| Image::from_bytes(include_bytes!("../icons/32x32.png")).expect("embedded icon"));

                // On a Mac the menu bar gets a template image (see
                // `menu_bar_template_rgba`), built from the embedded icon so it
                // does not depend on the working directory of a bundled app.
                #[cfg(target_os = "macos")]
                let tray_icon = {
                    let source = Image::from_bytes(include_bytes!("../icons/128x128.png")).expect("embedded icon");
                    let _ = tray_icon;
                    Image::new_owned(menu_bar_template_rgba(source.rgba()), source.width(), source.height())
                };
                let tray = TrayIconBuilder::new()
                    .icon(tray_icon)
                    .tooltip("LU");
                #[cfg(target_os = "macos")]
                let tray = tray.icon_as_template(true);
                tray
                    .menu(&menu)
                    .on_menu_event(|app, event| {
                        match event.id().as_ref() {
                            "show" => onboarding_window::bring_to_front(app),
                            "quit" => {
                                // Tauri's AppState Drop doesn't fire reliably on
                                // Windows after `app.exit(0)` — run the explicit
                                // subprocess shutdown here so tray Quit doesn't
                                // leak Ollama / ComfyUI (a user V/b, v2.4.9).
                                let state = app.state::<AppState>();
                                state.shutdown_subprocesses();
                                app.exit(0);
                            }
                            _ => {}
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                            onboarding_window::bring_to_front(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }

            // ─── Close → hide to tray instead of quit ───
            #[cfg(desktop)]
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                let hide_gen = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        // No tray (GH #204): a hidden window could never come
                        // back, so the close button is the Quit item.
                        if !system_tray::close_hides_to_tray(tray_present) {
                            let app = w.app_handle();
                            app.state::<AppState>().shutdown_subprocesses();
                            app.exit(0);
                            return;
                        }
                        // The hidden webview stays fully alive — read-aloud
                        // would keep talking and a running dictation would
                        // keep the mic hot behind a window the user believes
                        // is closed. Tell the frontend (useVoice) to stop
                        // both before the window goes to the tray.
                        let _ = w.emit("app:hidden", ());
                        let _ = w.hide();

                        // Gegenprobe 2026-08-30: the window vanished from the
                        // taskbar but lu-llama-server kept the whole model in
                        // VRAM, with no visible sign anything was still
                        // running (the tray icon sits in the overflow). The
                        // user pressed the X, believes the app is gone, and
                        // the GPU stays full. Hiding stays the behaviour, but
                        // it now releases the local backends the same way the
                        // switch into Cloud mode does. Everything restarts
                        // lazily on first use after Show, which is exactly
                        // what a fresh launch does (nothing but Ollama and
                        // ComfyUI auto-start there either).
                        let generation = hide_gen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                        let w2 = w.clone();
                        let gen_handle = hide_gen.clone();
                        std::thread::spawn(move || {
                            // The grace period keeps a mis-click free: hide,
                            // reopen, nothing was ever unloaded.
                            std::thread::sleep(HIDE_OFFLOAD_GRACE);
                            let visible = w2.is_visible().unwrap_or(false);
                            let current = gen_handle.load(std::sync::atomic::Ordering::SeqCst);
                            if !should_offload_after_hide(visible, generation, current) {
                                return;
                            }
                            let app = w2.app_handle();
                            let state = app.state::<AppState>();
                            match commands::process::offload_local_models_blocking(&state, Some(true)) {
                                Ok(v) => println!("[Window] hidden to tray, released local backends: {v}"),
                                Err(e) => println!("[Window] hidden to tray, offload failed: {e}"),
                            }
                        });
                    }
                });
            }

            // ─── Auto-start services (off the main thread) ───
            // find_comfyui_path() walks $HOME, which can take minutes on a big
            // disk — on the main thread that stalls window creation and the app
            // "runs with no window" until the scan finishes (2.5.6 regression).
            // Ollama/ComfyUI here are just SERVERS; no model loads until first use.
            //
            // Whisper STT is intentionally NOT pre-started any more: it used to
            // load its model (~360 MB) at launch even in Cloud mode. It now starts
            // LAZILY on the first transcription (whisper::transcribe) and is
            // released by offload_local_models whenever the app is in Cloud mode.
            #[cfg(desktop)]
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    // A crash or a Force Quit of the last run leaves its
                    // llama-server behind on a Mac, with the model loaded.
                    // Nothing has started a sidecar of this run yet.
                    #[cfg(target_os = "macos")]
                    commands::engine::reap_orphaned_sidecars(&handle);
                    // And the image generation of the second engine, which is
                    // a process of its own with a whole pack in memory.
                    #[cfg(target_os = "macos")]
                    commands::mlx::reap_orphaned_mflux();
                    // And a track of the music engine, the same way.
                    #[cfg(target_os = "macos")]
                    if let Some(pid) = commands::music::reap_orphaned_run() {
                        tracing::warn!(target: "music", pid, "ended a track orphaned by a previous run");
                    }
                    // And a character training, the same way.
                    #[cfg(target_os = "macos")]
                    if let Some(pid) = commands::mlx::train::reap_orphaned_run() {
                        tracing::warn!(target: "train", pid, "ended a training orphaned by a previous run");
                    }
                    let state = handle.state::<AppState>();
                    commands::process::auto_start_ollama(&state);
                    commands::process::auto_start_comfyui(&state);
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Every quit path ends here, including the ones nothing else
            // covered: Cmd+Q, the Apple menu, an `osascript quit`, a logout.
            // Only the tray's Quit item and the `exit_app` command called
            // shutdown_subprocesses; macOS quits fell through to `Drop for
            // AppState`, which Tauri v2 does not reliably run — so a normal
            // Cmd+Q left Ollama, ComfyUI, llama-server, the embeddings
            // server, the trainer and the MLX sidecar all running. Proved
            // live on 2026-07-28: app gone, the MLX Python still resident.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<AppState>() {
                    state.shutdown_subprocesses();
                }
                // Returning from here lets tao call `std::process::exit`,
                // whose exit handlers tear down static mutexes under the
                // threads that are still running (WebView, a recreated
                // activity): "FORTIFY: pthread_mutex_lock called on a
                // destroyed mutex", SIGABRT, crash dialog. `_exit` ends the
                // process without them.
                #[cfg(target_os = "android")]
                android_entry::leave_process(0);
            }
            // A click on the Dock icon while the window is hidden. Same call
            // as the menu bar's "Show": the window is shown again, and that is
            // also what takes back the unload after the hide. Inside
            // HIDE_OFFLOAD_GRACE the timer finds the window visible and does
            // nothing (`should_offload_after_hide`); after it, the backends
            // start again on first use, exactly as after "Show".
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
                if reopen_needs_a_window(has_visible_windows) {
                    onboarding_window::bring_to_front(app);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{is_wayland_session, linux_no_window_hint, linux_webview_env, shadow_bundled_wayland, LinuxSession, WAYLAND_OPT_OUT};

    /// Fehlerkontrolle Mac 2, Fund 1: the Dock click with no window on screen
    /// brings one back, and one that is already there is left to macOS.
    #[test]
    fn a_dock_click_without_a_window_brings_one_back() {
        assert!(super::reopen_needs_a_window(false));
        assert!(!super::reopen_needs_a_window(true));
    }

    /// The rule above is worth nothing unless the run loop asks it, and the
    /// way back is the one "Show" takes.
    #[test]
    fn the_run_loop_answers_the_dock_click_the_way_show_does() {
        let src = include_str!("lib.rs");
        let event = ["RunEvent::", "Reopen { has_visible_windows"].concat();
        let at = src.find(&event).expect("the run loop does not handle the Dock click");
        let handler = &src[at..at + 400];
        assert!(handler.contains("reopen_needs_a_window(has_visible_windows)"), "{handler}");
        assert!(handler.contains("onboarding_window::bring_to_front(app)"), "{handler}");
    }

    /// Fehlerkontrolle Mac 2, Fund 11: the letters stay, the plate goes, and
    /// no colour of ours is left for the menu bar to show.
    #[test]
    fn the_menu_bar_image_keeps_the_letters_and_drops_the_plate() {
        let white = [255, 255, 255, 255];
        let plate = [0, 0, 0, 255];
        let plate_edge = [20, 20, 20, 255];
        let outside = [0, 0, 0, 0];
        let half_white = [255, 255, 255, 128];
        let px: Vec<u8> = [white, plate, plate_edge, outside, half_white].concat();
        let out = super::menu_bar_template_rgba(&px);
        let alpha: Vec<u8> = out.as_chunks::<4>().0.iter().map(|p| p[3]).collect();
        assert_eq!(alpha, vec![255, 0, 0, 0, 128]);
        assert!(out.as_chunks::<4>().0.iter().all(|p| p[..3] == [0, 0, 0]), "a template carries no colour");
    }

    /// The real icon: a template of it has both clear and solid parts. An
    /// image that came out all solid would be the black square again, one
    /// that came out empty would be an invisible menu bar item.
    #[test]
    fn the_embedded_icon_makes_a_usable_template() {
        let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png")).expect("embedded icon");
        let out = super::menu_bar_template_rgba(icon.rgba());
        let total = out.len() / 4;
        let solid = out.as_chunks::<4>().0.iter().filter(|p| p[3] > 200).count();
        let clear = out.as_chunks::<4>().0.iter().filter(|p| p[3] == 0).count();
        assert!(solid * 20 > total, "only {solid} of {total} pixels are drawn");
        assert!(clear * 2 > total, "only {clear} of {total} pixels are clear, the plate is still there");
    }

    const DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    const COMPOSITING: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";

    /// A Wayland session with nothing set and no AppImage under it.
    fn wayland() -> LinuxSession {
        LinuxSession { wayland: true, ..Default::default() }
    }

    fn keys(session: &LinuxSession) -> Vec<&'static str> {
        linux_webview_env(session).into_iter().map(|e| e.key).collect()
    }

    // ── Bug g: the session decides, and only the session ──────────────────

    #[test]
    fn wayland_with_nothing_set_gets_both_webkit_switches() {
        let plan = linux_webview_env(&wayland());
        assert_eq!(keys(&wayland()), vec![DMABUF, COMPOSITING]);
        assert!(plan.iter().all(|e| e.value == "1"), "{plan:?}");
        assert!(plan.iter().all(|e| !e.why.is_empty()), "every switch says why");
    }

    #[test]
    fn x11_is_left_completely_alone() {
        // The change from 2.4.5, and the reason it is a change: the DMA-BUF
        // renderer being disabled here is webkitgtk's fast path, and X11 never
        // reported the fault it works around.
        let session = LinuxSession { wayland: false, ..Default::default() };
        assert!(linux_webview_env(&session).is_empty());
        // Not even with an AppImage that bundles the library: the EGL fault
        // that needs the preload is a Wayland one.
        let session = LinuxSession {
            wayland: false,
            shadow_bundled_wayland: Some("/usr/lib/libwayland-client.so.0".to_string()),
            ..Default::default()
        };
        assert!(linux_webview_env(&session).is_empty());
    }

    #[test]
    fn a_variable_the_user_set_is_never_overwritten() {
        let session = LinuxSession { dmabuf_set: true, ..wayland() };
        assert_eq!(keys(&session), vec![COMPOSITING]);
        let session = LinuxSession { compositing_set: true, ..wayland() };
        assert_eq!(keys(&session), vec![DMABUF]);
        let session = LinuxSession { dmabuf_set: true, compositing_set: true, ..wayland() };
        assert!(linux_webview_env(&session).is_empty());
    }

    #[test]
    fn the_escape_hatch_turns_everything_off() {
        // A user ran 2.6.7, which already set both WEBKIT_ variables, and had
        // no window. Without a way to start WITHOUT them, nobody can tell
        // whether LU's own workaround is the thing in the way.
        let session = LinuxSession {
            opted_out: true,
            shadow_bundled_wayland: Some("/usr/lib/libwayland-client.so.0".to_string()),
            ..wayland()
        };
        assert!(linux_webview_env(&session).is_empty());
    }

    #[test]
    fn an_appimage_that_bundles_wayland_gets_the_system_library_in_front() {
        let session = LinuxSession {
            shadow_bundled_wayland: Some("/usr/lib64/libwayland-client.so.0".to_string()),
            ..wayland()
        };
        let plan = linux_webview_env(&session);
        let preload = plan.iter().find(|e| e.key == "LD_PRELOAD").expect("{plan:?}");
        assert_eq!(preload.value, "/usr/lib64/libwayland-client.so.0");
        // A preload the user set is their business.
        let session = LinuxSession { preload_set: true, ..session };
        assert!(!keys(&session).contains(&"LD_PRELOAD"));
    }

    #[test]
    fn the_session_is_read_from_either_variable() {
        assert!(is_wayland_session(Some("wayland"), None));
        assert!(is_wayland_session(Some("Wayland"), None));
        assert!(is_wayland_session(None, Some("wayland-0")));
        assert!(!is_wayland_session(Some("x11"), None));
        assert!(!is_wayland_session(None, None));
        // An empty WAYLAND_DISPLAY is not a Wayland session.
        assert!(!is_wayland_session(Some("tty"), Some("")));
    }

    #[test]
    fn the_preload_needs_a_bundled_copy_and_a_system_copy() {
        let bundled = "/tmp/appdir/usr/lib/libwayland-client.so.0";
        let system = "/usr/lib/x86_64-linux-gnu/libwayland-client.so.0";
        // Both there: the system one is named.
        assert_eq!(
            shadow_bundled_wayland(Some("/tmp/appdir"), |p| p == bundled || p == system),
            Some(system.to_string())
        );
        // A trailing slash on APPDIR must not produce a double slash.
        assert_eq!(
            shadow_bundled_wayland(Some("/tmp/appdir/"), |p| p == bundled || p == system),
            Some(system.to_string())
        );
        // No AppImage at all, or one that bundles nothing: nothing to shadow.
        assert_eq!(shadow_bundled_wayland(None, |_| true), None);
        assert_eq!(shadow_bundled_wayland(Some(""), |_| true), None);
        assert_eq!(shadow_bundled_wayland(Some("/tmp/appdir"), |p| p == system), None);
        // Bundled, but this distribution keeps its libraries somewhere else:
        // an LD_PRELOAD pointing at nothing is worse than none.
        assert_eq!(shadow_bundled_wayland(Some("/tmp/appdir"), |p| p == bundled), None);
    }

    // ── Bug g: what the console says when no window came ──────────────────

    #[test]
    fn the_no_window_hint_is_linux_only() {
        assert!(linux_no_window_hint(false, true, true).is_none());
    }

    #[test]
    fn the_no_window_hint_names_the_two_causes_and_the_way_out() {
        let hint = linux_no_window_hint(true, true, true).expect("linux");
        assert!(hint.contains("EGL_BAD_PARAMETER"), "{hint}");
        assert!(hint.contains("AcceleratedSurfaceDMABuf"), "{hint}");
        assert!(hint.contains("LD_PRELOAD=/usr/lib/libwayland-client.so.0"), "{hint}");
        assert!(hint.contains("GDK_BACKEND=x11"), "{hint}");
        assert!(hint.contains(WAYLAND_OPT_OUT), "{hint}");
        // Every line is English and carries the tag, so a user can paste it.
        assert!(hint.lines().all(|l| l.starts_with("[Linux]")), "{hint}");
    }

    #[test]
    fn an_x11_session_gets_the_short_hint_without_the_wayland_causes() {
        let hint = linux_no_window_hint(true, false, false).expect("linux");
        assert!(!hint.contains("EGL_BAD_PARAMETER"), "{hint}");
        assert!(!hint.contains("LD_PRELOAD"), "{hint}");
        assert!(hint.contains("GDK_BACKEND=x11"), "{hint}");
    }

    // ─── Close-to-tray releases the GPU (Gegenprobe 2026-08-30) ───
    //
    // The window cross hides the app instead of quitting it, and until this
    // round lu-llama-server kept the model in VRAM behind a window that was
    // gone from the taskbar. The offload now runs after a grace period; these
    // cover exactly when it may and may not fire.

    #[test]
    fn hidden_offload_runs_when_the_window_stayed_hidden() {
        // Plain case: hidden at the start of the grace period, still hidden at
        // the end, no newer hide in between. This is the case that frees VRAM.
        assert!(super::should_offload_after_hide(false, 1, 1));
    }

    #[test]
    fn hidden_offload_skipped_when_the_user_reopened() {
        // Mis-click: cross pressed, window reopened from the tray inside the
        // grace period. Unloading the model under a visible window would be a
        // pointless reload, so the timer must back off.
        assert!(!super::should_offload_after_hide(true, 1, 1));
    }

    #[test]
    fn hidden_offload_skipped_when_a_newer_hide_owns_the_timer() {
        // hide → show → hide: the first timer fires while the window is hidden
        // again, but its grace period belongs to the OLD hide. Letting it
        // through would free the VRAM seconds after the second hide instead of
        // a full grace period later. The newest generation wins.
        assert!(!super::should_offload_after_hide(false, 1, 2));
        assert!(super::should_offload_after_hide(false, 2, 2));
    }

    #[test]
    fn hiding_to_tray_is_actually_wired_to_the_offload() {
        // The decision helper proves nothing on its own if nobody calls it.
        // Before this round the CloseRequested arm ended at `w.hide()` and the
        // engine kept the whole model in VRAM, which is exactly what the
        // Gegenprobe measured. Pin the wiring next to the hide call so a
        // refactor that drops it fails here instead of on someone's GPU.
        let src = include_str!("lib.rs");
        let hide = src
            .find("let _ = w.hide();")
            .expect("close-to-tray hide call should exist");
        let after = &src[hide..(hide + 2500).min(src.len())];
        assert!(
            after.contains("should_offload_after_hide"),
            "hiding to the tray must consult the offload decision"
        );
        assert!(
            after.contains("offload_local_models_blocking"),
            "hiding to the tray must release the local model backends"
        );
    }

    #[test]
    fn the_tray_is_only_built_when_its_library_loads() {
        // GH #204: 3.0.8 built the tray unconditionally, and on a Linux
        // without libayatana-appindicator that aborted the app at start. The
        // probe in `system_tray` is worth nothing unless the build sits
        // behind it and the close button knows there may be no tray.
        let src = include_str!("lib.rs");
        let builder = src
            .find("let tray = TrayIconBuilder::new()")
            .expect("tray builder should exist");
        let gate = src[..builder]
            .rfind("if tray_present {")
            .expect("the tray build must sit inside `if tray_present`");
        let probe = src[..gate]
            .rfind("system_tray::system_tray_available()")
            .expect("tray_present must come from the library probe");
        assert!(probe < gate && gate < builder);
        let close = src
            .find("if let tauri::WindowEvent::CloseRequested { api, .. } = event {")
            .expect("close handler should exist");
        let hide = src.find("let _ = w.hide();").expect("hide call should exist");
        assert!(
            src[close..hide].contains("system_tray::close_hides_to_tray(tray_present)"),
            "without a tray the close button must not hide the window"
        );
    }

    #[test]
    fn hidden_offload_grace_is_a_real_wait_and_not_a_coffee_break() {
        // A zero grace would unload on every stray hide, and a very long one
        // would leave the GPU pinned for as long as the user is away from the
        // machine. Bracket it so a future edit cannot quietly do either.
        let secs = super::HIDE_OFFLOAD_GRACE.as_secs();
        assert!((5..=120).contains(&secs), "grace period out of range: {secs}s");
    }
}

/// The log sink itself, driven end to end.
///
/// `os_error`'s own tests prove the rewriting; this proves it is actually
/// wired into the subscriber, which is the part a refactor drops for free.
#[cfg(test)]
mod log_english_tests {
    use std::sync::{Arc, Mutex};

    /// The connection-refused code of the machine the test runs on. Its
    /// Display is the operating system's wording, which on a German Windows is
    /// German and here differs from ours by its capital letter. Either way it
    /// is text we did not write, and it must not survive.
    #[cfg(windows)]
    const REFUSED: i32 = 10061;
    #[cfg(target_os = "macos")]
    const REFUSED: i32 = 61;
    #[cfg(all(unix, not(target_os = "macos")))]
    const REFUSED: i32 = 111;

    #[derive(Clone)]
    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Capture {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
        type Writer = Capture;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    fn logged(f: impl FnOnce()) -> String {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(Capture(buf.clone()))
            .with_ansi(false)
            .fmt_fields(super::EnglishFields(
                tracing_subscriber::fmt::format::DefaultFields::new(),
            ))
            .finish();
        tracing::subscriber::with_default(subscriber, f);
        let out = buf.lock().unwrap().clone();
        String::from_utf8(out).expect("the log is utf8")
    }

    /// Discord report (3.0.7): the file log names the build on every line,
    /// not only on the start line, so the lines of the run before an update
    /// can no longer pass for the installed version.
    #[test]
    fn every_file_log_line_names_the_build_that_wrote_it() {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(Capture(buf.clone()))
            .with_ansi(false)
            .with_timer(super::VersionedTime)
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!("first");
            tracing::warn!("second");
        });
        let out = String::from_utf8(buf.lock().unwrap().clone()).expect("the log is utf8");
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2, "got: {out}");
        let stamp = format!(" v{} ", crate::app_identity::APP_VERSION);
        for line in lines {
            assert!(line.contains(&stamp), "no version on: {line}");
        }
    }

    #[test]
    fn a_dependency_that_logs_an_os_error_still_reads_in_our_words() {
        // Exactly the hyper-util line that put German text into
        // lu-app-exit.log on the Windows box.
        let e = std::io::Error::from_raw_os_error(REFUSED);
        let os_worded = e.to_string();
        let out = logged(|| tracing::warn!("tcp set_nodelay error: {}", e));
        assert!(out.contains("tcp set_nodelay error: "), "got: {out}");
        assert!(out.contains("connection refused"), "got: {out}");
        assert!(out.contains(&format!("os error {REFUSED}")), "got: {out}");
        assert!(!out.contains(&os_worded), "the system wording survived: {out}");
    }

    /// The test above builds its own subscriber, so on its own it would still
    /// pass if `init_tracing` stopped using the wrapper. This is the other
    /// half: EVERY layer has to go through it, or a user on JSON logs keeps
    /// the German line the text mode no longer has — and since audit #01 the
    /// file layer is the one whose text actually reaches a support request.
    #[test]
    fn every_log_layer_is_wired_through_the_wrapper() {
        const SRC: &str = include_str!("lib.rs");
        let init = &SRC[SRC.find("fn init_tracing()").expect("init_tracing exists")..];
        let init = &init[..init.find("\n}\n").expect("the function ends")];
        let layers = init.matches("fmt::layer()").count();
        assert!(
            layers >= 3,
            "expected at least the file, text and json layers, found {layers}:\n{init}"
        );
        assert_eq!(
            init.matches("EnglishFields(").count(),
            layers,
            "every fmt layer must sanitise the operating system's wording:\n{init}"
        );
    }

    // Negative control: a line the operating system had no hand in must come
    // out byte for byte, fields and all.
    #[test]
    fn an_ordinary_line_is_logged_unchanged() {
        let out = logged(|| tracing::info!(version = "2.6.8", "LU starting"));
        assert!(out.contains("LU starting"), "got: {out}");
        assert!(out.contains("version=\"2.6.8\""), "got: {out}");
    }
}

/// The log FILE itself (audit finding #01).
///
/// Nothing here writes a real log — installing a global subscriber inside a
/// unit test would fight every other test in the binary for the process-wide
/// slot. What these pin is the part a refactor silently breaks: that the file
/// layer exists at all, that its guard is kept, and that the rotation cannot
/// quietly become unbounded.
#[cfg(test)]
mod log_file_tests {
    const SRC: &str = include_str!("lib.rs");

    fn init_tracing_body() -> &'static str {
        let s = &SRC[SRC.find("fn init_tracing()").expect("init_tracing exists")..];
        &s[..s.find("\n}\n").expect("the function ends")]
    }

    #[test]
    fn the_worker_guard_is_held_by_run_and_not_dropped_on_the_spot() {
        // THE tracing-appender trap. `let _ = init_tracing();` compiles, runs,
        // and produces an empty log file, because `_` drops the guard
        // immediately and the writer thread dies with it. A named binding in
        // `run` lives until the process ends.
        // Bounded to run's own body — the negative assertion below matches
        // its own source text otherwise, and the test would fail on itself.
        let main_fn = &SRC[SRC.find("\npub fn run() {").expect("run exists")..];
        let main_fn = &main_fn[..main_fn.find("\n}\n").expect("main ends")];
        assert!(
            main_fn.contains("let _log_guard = init_tracing();"),
            "run must bind the WorkerGuard to a named local for the app's lifetime"
        );
        assert!(
            !main_fn.contains("let _ = init_tracing();"),
            "`let _ =` drops the guard at once and empties the log file"
        );
    }

    #[test]
    fn the_file_layer_is_added_to_both_log_modes_and_replaces_neither() {
        // "Additionally, not instead of": a developer running `cargo tauri dev`
        // must keep the console output they read while working.
        let init = init_tracing_body();
        assert_eq!(
            init.matches(".with(file_layer)").count(),
            2,
            "text mode and json mode both need the file layer:\n{init}"
        );
        assert!(
            init.contains("fmt::layer().compact()"),
            "the stdout layer must survive alongside the file:\n{init}"
        );
    }

    #[test]
    fn rotation_is_bounded_in_both_directions() {
        // 0 would keep nothing (a log that prunes itself is no log), and a
        // large number turns "the app writes a log" into "the app fills the
        // disk of anyone who leaves it running for a year".
        assert!(
            (2..=31).contains(&super::LOG_FILES_KEPT),
            "kept log files out of range: {}",
            super::LOG_FILES_KEPT
        );
        let init = SRC
            .find("fn file_log_writer()")
            .map(|i| &SRC[i..i + 1200])
            .expect("file_log_writer exists");
        assert!(init.contains("max_log_files"), "the appender must prune:\n{init}");
        assert!(init.contains("Rotation::DAILY"), "rotation must be configured:\n{init}");
    }

    #[test]
    fn a_home_that_cannot_be_written_to_does_not_stop_the_app() {
        // Read-only profile / full disk: a missing log file is a degraded app,
        // an app that will not launch without one is a broken app. The helper
        // must therefore be fallible-but-soft, i.e. return an Option.
        let src = SRC
            .find("fn file_log_writer()")
            .map(|i| &SRC[i..i + 400])
            .expect("file_log_writer exists");
        assert!(src.contains("-> Option<"), "must degrade rather than panic:\n{src}");
    }

    #[test]
    fn the_log_lives_next_to_the_crash_log() {
        // One folder per support request. If these two drift apart, half the
        // evidence gets left behind on every report.
        let logs = crate::os_paths::log_dir();
        let crash = crate::crash_report::crash_log_path();
        assert_eq!(
            logs.parent(),
            crash.parent(),
            "the rolling log and crash.log must share one directory"
        );
    }

    #[test]
    fn the_appender_really_writes_the_file_name_settings_reports() {
        // The only test here that runs the real crate. Everything else about
        // the path is our own arithmetic; this pins it against
        // tracing-appender's actual behaviour, including the detail that the
        // date in the name is UTC and not the local day. A subscriber scoped
        // to this thread keeps it out of the global slot the other tests share.
        use tracing_subscriber::layer::SubscriberExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let appender = tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix(crate::commands::logging::LOG_FILE_PREFIX)
            .filename_suffix(crate::commands::logging::LOG_FILE_SUFFIX)
            .max_log_files(super::LOG_FILES_KEPT)
            .build(dir.path())
            .expect("the appender builds");
        let (writer, guard) = tracing_appender::non_blocking(appender);
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer().with_writer(writer).with_ansi(false),
        );
        tracing::subscriber::with_default(subscriber, || {
            tracing::warn!("a line that has to reach the disk");
        });
        // Dropping the guard shuts the writer thread down AND flushes it —
        // which is exactly why main must not drop it early.
        drop(guard);

        let expected = crate::commands::logging::log_file_name(
            &chrono::Utc::now().format("%Y-%m-%d").to_string(),
        );
        let written = std::fs::read_to_string(dir.path().join(&expected))
            .unwrap_or_else(|e| panic!("expected {expected} in the log dir: {e}"));
        assert!(
            written.contains("a line that has to reach the disk"),
            "the file exists but is empty — the guard was dropped too early: {written:?}"
        );
    }

    #[test]
    fn the_frontend_can_actually_reach_the_log_commands() {
        // The commands exist in logging.rs whether or not they are registered;
        // an unregistered command is an invoke that rejects at runtime with
        // "not allowed by scope" and no compile error anywhere.
        for cmd in [
            "commands::logging::log_write",
            "commands::logging::log_file_path",
            "commands::logging::log_reveal",
        ] {
            assert!(SRC.contains(cmd), "{cmd} is not in generate_handler!");
        }
    }

    #[test]
    fn the_frontend_can_actually_reach_the_parked_key_commands() {
        // R9: an unregistered command is an invoke that rejects at runtime
        // with "not allowed by scope", not a compile error, so the orchestrator's
        // later TS wiring would otherwise silently find nothing here.
        for cmd in [
            "commands::secret::secret_park_set",
            "commands::secret::secret_park_get",
            "commands::secret::secret_park_delete",
        ] {
            assert!(SRC.contains(cmd), "{cmd} is not in generate_handler!");
        }
    }

    #[test]
    fn the_frontend_can_actually_reach_the_runtime_folder_commands() {
        // Settings, Storage, "Voice and Python folder" (Discord D2).
        for cmd in [
            "commands::runtime_folder::runtime_folder_status",
            "commands::runtime_folder::set_runtime_folder",
            "commands::runtime_folder::move_runtime_folder",
        ] {
            assert!(SRC.contains(cmd), "{cmd} is not in generate_handler!");
        }
    }

    #[test]
    fn the_frontend_can_actually_reach_the_storage_commands() {
        // Settings, Storage: one folder for models, gallery and runtime.
        for cmd in [
            "commands::storage::storage_status",
            "commands::storage::storage_plan",
            "commands::storage::storage_apply",
            "commands::storage::storage_cancel",
        ] {
            assert!(SRC.contains(cmd), "{cmd} is not in generate_handler!");
        }
    }

    #[test]
    fn the_frontend_can_actually_reach_the_whole_linux_update_path() {
        // updateStore calls install_method BEFORE it downloads anything.
        // Unregistered, the invoke rejects, the store falls back to "unknown"
        // and the Arch install is back to running pkexec dpkg -i.
        // The two migration commands are what the
        // update button calls there instead of the plugin.
        for cmd in [
            "commands::install_method_cmd::install_method",
            "commands::self_migrate_cmd::self_migrate_stage",
            "commands::self_migrate_cmd::self_migrate_finish",
        ] {
            assert!(SRC.contains(cmd), "{cmd} is not in generate_handler!");
        }
    }

    #[test]
    fn the_update_button_can_reach_the_restart() {
        // updateStore calls this right after the plugin's install() on macOS
        // and Linux. Unregistered, the invoke rejects and the app falls back
        // to closing without coming back, which is discussion 150 again.
        // The comma is added here so that this line cannot be its own match.
        assert!(
            SRC.contains(concat!("commands::system::restart_after_update", ",")),
            "restart_after_update is not in generate_handler!"
        );
    }
}
