// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod crash_report;
mod install_state;
mod os_error;
mod os_paths;
mod process_util;
mod python;
mod state;

use state::AppState;
use tauri::{
    Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    image::Image,
};

/// Bug D (v2.4.5 — emilmjt Discord 2026-05-11): on Arch Linux + Wayland
/// and on a handful of Mesa versions, Tauri 2's webkit2gtk-4.1 webview
/// initialises with DMABUF buffer-sharing or DMA-compositing enabled
/// and the GPU path silently fails — the window opens but the page
/// never paints, so the user sees an empty rectangle. Disabling those
/// two paths forces webkit back onto the slower-but-reliable software
/// composite, which is the same workaround the GNOME, KDE, and Tauri
/// upstream maintainers recommend (tauri-apps/tauri#9304, GNOME
/// GitLab #1731). Only applied when the user hasn't already set the
/// vars themselves — power users with a working DMABUF setup keep it.
///
/// Extracted to a module-level function (not `#[cfg(target_os = "linux")]`)
/// so the no-overwrite logic is unit-testable cross-platform — see
/// `tests::webkit_workaround_*` below.
fn apply_linux_webkit_workarounds() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
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
/// never worked". So it is handed back to `main`, which holds it for as long
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
/// `locally_uncensored=debug`, or a per-module spec.
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

fn main() {
    // First thing of all: a panic anywhere must leave a trace. The release
    // profile is `panic = "abort"`, so a panic on any thread ends the process
    // immediately, and a shipped Windows build has no console to print to.
    // Without this hook such a death is indistinguishable from the app being
    // killed from outside, which is exactly the confusion the 2026-08-29
    // Windows investigation had to untangle by hand.
    crash_report::install_panic_hook();

    #[cfg(target_os = "linux")]
    apply_linux_webkit_workarounds();
    // Before anything can spawn a child: an AppImage exports PYTHONHOME and
    // PYTHONPATH into its own mount, and every python3 we start inherits them
    // and dies on "No module named 'encodings'".
    python::sanitize_appimage_python_env();

    // Bound to a named local, not `let _ = ...`: `_log_guard` lives until the
    // end of `main`, i.e. as long as the app runs, while `_` would drop the
    // guard on this very line and take the file writer's worker thread down
    // with it before the first line was written.
    let _log_guard = init_tracing();
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        "LU starting"
    );

    let app_state = AppState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 2nd launch → focus existing window instead of spawning another process.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(app_state)
        .manage(commands::oauth::OauthPending::default())
        .invoke_handler(tauri::generate_handler![
            // LU Cloud OAuth loopback (Google/GitHub via system browser)
            commands::oauth::oauth_start,
            commands::oauth::oauth_wait,
            // Process management
            commands::process::start_ollama,
            commands::process::start_comfyui,
            commands::process::stop_comfyui,
            commands::process::fix_comfyui_cors,
            commands::process::comfyui_status,
            commands::process::comfyui_last_output,
            commands::process::find_comfyui,
            commands::process::detect_all_comfyui_installs,
            commands::process::set_comfyui_path,
            commands::process::set_comfy_gpu_mode,
            commands::process::get_comfy_gpu_status,
            commands::process::set_comfyui_port,
            commands::process::set_comfyui_host,
            commands::process::set_ollama_host,
            commands::process::get_ollama_host,
            commands::process::offload_local_models,
            // ComfyUI progress WebSocket via Rust (0.19+ origin-check bypass)
            commands::comfy_ws::comfy_ws_connect,
            commands::comfy_ws::comfy_ws_disconnect,
            // Installation
            commands::install::install_comfyui,
            commands::install::install_comfyui_status,
            commands::install::repair_comfyui_env,
            commands::install::update_comfyui,
            commands::install::cancel_comfyui_install,
            commands::install::install_ollama,
            commands::install::install_ollama_status,
            commands::install::install_lmstudio,
            commands::install::install_lmstudio_status,
            commands::install::start_lmstudio_server,
            commands::install::lmstudio_server_status,
            commands::install::lmstudio_list_loaded,
            commands::install::lmstudio_load_model,
            commands::install::lmstudio_model_context,
            commands::install::lmstudio_unload_model,
            commands::install::install_python,
            commands::install::install_python_status,
            commands::install::python_check,
            commands::install::install_custom_node,
            commands::install::install_whisper,
            commands::install::install_whisper_status,
            commands::install::install_tts,
            commands::install::install_tts_status,
            commands::install::check_git_installed,
            // Local character trainer (musubi-tuner)
            commands::trainer::install_character_trainer,
            commands::trainer::character_trainer_status,
            commands::trainer::stage_training_image,
            commands::trainer::clear_training_set,
            commands::trainer::start_character_training,
            commands::trainer::character_training_status,
            commands::trainer::cancel_character_training,
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
            commands::agent::file_read,
            commands::agent::file_write,
            commands::agent::set_chat_workspace_override,
            commands::agent::get_chat_workspace_override,
            commands::agent::list_agent_workspaces,
            // Shell
            commands::shell::shell_execute,
            // Filesystem
            commands::filesystem::fs_read,
            commands::filesystem::fs_read_bytes,
            commands::filesystem::fs_write,
            commands::filesystem::fs_list,
            commands::filesystem::fs_search,
            commands::filesystem::fs_info,
            commands::filesystem::save_text_file_dialog,
            commands::filesystem::save_binary_file_dialog,
            // System
            commands::system::system_info,
            commands::system::process_list,
            commands::system::screenshot,
            commands::system::pick_folder,
            commands::system::is_onboarding_done,
            commands::system::set_onboarding_done,
            commands::system::get_current_time,
            commands::system::backup_stores,
            commands::system::restore_stores,
            commands::system::backup_rag_chunks,
            commands::system::restore_rag_chunks,
            commands::system::exit_app,
            // Downloads
            commands::download::download_model,
            commands::download::download_model_to_path,
            commands::download::download_progress,
            commands::download::pause_download,
            commands::download::cancel_download,
            commands::download::clear_download_entry,
            commands::download::check_download_space,
            commands::download::find_orphan_downloads,
            commands::download::delete_orphan_download,
            commands::download::resume_download,
            commands::download::detect_model_path,
            commands::download::check_model_sizes,
            commands::download::delete_comfy_model,
            // Built-in inference engine (bundled llama-server, P1)
            commands::engine::start_bundled_engine,
            commands::engine::stop_bundled_engine,
            commands::engine::bundled_engine_status,
            commands::engine::kv_slot_action,
            commands::engine::swap_bundled_model,
            commands::engine::list_bundled_models,
            commands::engine::list_importable_models,
            commands::engine::import_local_model,
            // Built-in embeddings server (bundled llama-server --embeddings, P5)
            commands::engine::start_bundled_embed,
            commands::engine::stop_bundled_embed,
            commands::engine::bundled_embed_status,
            // In-process MLX media engine (macOS Apple-Silicon local image/video,
            // spawned in-process — no separate bridge daemon). See media_cmds.rs.
            commands::media_cmds::mlx_status,
            commands::media_cmds::mlx_start,
            commands::media_cmds::mlx_unload,
            commands::media_cmds::mlx_generate,
            commands::media_cmds::mlx_image_models,
            commands::media_cmds::set_hf_token,
            commands::media_cmds::hf_token_present,
            commands::media_cmds::mlx_image_install_model,
            commands::media_cmds::mlx_image_install_status,
            commands::media_cmds::mlx_image_delete_model,
            commands::media_cmds::install_mlx_diffusion,
            commands::media_cmds::install_mlx_diffusion_status,
            commands::media_cmds::video_status,
            commands::media_cmds::video_list_models,
            commands::media_cmds::video_install_mlx,
            commands::media_cmds::video_install_mlx_status,
            commands::media_cmds::video_install_model,
            commands::media_cmds::video_install_model_status,
            commands::media_cmds::video_delete_model,
            commands::media_cmds::video_generate,
            commands::media_cmds::video_progress,
            commands::media_cmds::video_cancel,
            commands::media_cmds::read_media_file,
            // Provider API-key keychain (H5)
            commands::secret::secret_set,
            commands::secret::secret_get,
            commands::secret::secret_delete,
            // Web search
            commands::search::web_search,
            commands::search::web_fetch,
            commands::search::search_status,
            commands::search::install_searxng,
            commands::search::searxng_status,
            // Claude Code
            // Remote Access
            commands::remote::start_remote_server,
            commands::remote::stop_remote_server,
            commands::remote::restart_remote_server,
            commands::remote::remote_server_status,
            commands::remote::regenerate_remote_token,
            commands::remote::remote_qr_code,
            commands::remote::remote_connected_devices,
            commands::remote::disconnect_remote_device,
            commands::remote::set_remote_permissions,
            commands::remote::start_tunnel,
            commands::remote::stop_tunnel,
            commands::remote::tunnel_status,
            // Proxy
            commands::proxy::ollama_search,
            commands::proxy::fetch_external,
            commands::proxy::fetch_external_bytes,
            commands::proxy::proxy_localhost,
            commands::proxy::proxy_localhost_stream,
            commands::proxy::proxy_localhost_stream_chunked,
            commands::proxy::cancel_proxy_stream,
            commands::proxy::comfy_upload_image,
            commands::proxy::register_openai_host,
            commands::proxy::pull_model_stream,
            commands::proxy::cancel_model_pull,
            // Cloud "Hosted LU Workflows" waitlist — opt-in email capture
            commands::waitlist::waitlist_submit,
            // B7 (uselu Phase 4 inspiration) — one-shot diagnostic probe
            commands::health::system_health,
            // Audit #01 — the app log file: the frontend mirrors its warn /
            // error lines into it, Settings shows and opens it.
            commands::logging::log_write,
            commands::logging::log_file_path,
            commands::logging::log_reveal,
            // Bug BB v2.5.0 — BobbyT GPU picker
            commands::gpu::detect_gpus,
            commands::gpu::set_gpu_selection,
            commands::gpu::get_gpu_selection,
            // Codex / Sprint A #2 — Repo-Map with Aider PageRank
            commands::repo_map::repo_map,
            // Codex / Sprint C #7 — long-running background shell tasks
            commands::bg_tasks::shell_task_start,
            commands::bg_tasks::shell_task_status,
            commands::bg_tasks::shell_task_kill,
            commands::bg_tasks::shell_task_list,
            // Window management
            commands::process::show_window,
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }

            // Remove Windows DWM shadow/border (the 1mm border around the window)
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_shadow(false);
            }

            // ─── Bug D (surfingbird1010): force-show fallback ───
            // The window starts hidden (visible:false in tauri.conf.json) and is
            // normally revealed by the frontend's invoke('show_window') once React
            // mounts (App.tsx). If the WebView never loads, or a render/hydration
            // throw happens before that effect runs (corrupt persisted state,
            // GPU/WebView2 fault), the window would stay hidden forever and the app
            // looks like it "runs with no window". Reveal it unconditionally after a
            // timeout so the user always gets a window. The frontend's earlier
            // show_window is idempotent, so a healthy launch sees no double-show /
            // flicker. 10 s is comfortably longer than a normal cold React mount
            // (~1-2 s) yet short enough not to feel broken on a slow i7/8 GB box.
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(10));
                    if let Some(window) = handle.get_webview_window("main") {
                        // Treat "unknown" as hidden → show (a redundant show on an
                        // already-visible window is a harmless no-op).
                        if !window.is_visible().unwrap_or(false) {
                            println!("[Window] Force-show fallback fired (frontend never called show_window)");
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });
            }

            // ─── System Tray ───
            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let tray_icon = Image::from_path("icons/icon.png")
                .or_else(|_| Image::from_path("icons/32x32.png"))
                .unwrap_or_else(|_| Image::from_bytes(include_bytes!("../icons/32x32.png")).expect("embedded icon"));

            TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("LU")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            // Tauri's AppState Drop doesn't fire reliably on
                            // Windows after `app.exit(0)` — run the explicit
                            // subprocess shutdown here so tray Quit doesn't
                            // leak Ollama / ComfyUI (kj103x V/b, v2.4.9).
                            let state = app.state::<AppState>();
                            state.shutdown_subprocesses();
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // ─── Close → hide to tray instead of quit ───
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                let hide_gen = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
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
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
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
            }
        });
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    // env vars are process-global; serialize these tests so they don't
    // stomp each other when cargo runs them in parallel.
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    const DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    const COMPOSITING: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";

    fn cleanup() {
        std::env::remove_var(DMABUF);
        std::env::remove_var(COMPOSITING);
    }

    #[test]
    fn webkit_workaround_sets_both_vars_when_unset() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        cleanup();
        super::apply_linux_webkit_workarounds();
        assert_eq!(std::env::var(DMABUF).ok().as_deref(), Some("1"));
        assert_eq!(std::env::var(COMPOSITING).ok().as_deref(), Some("1"));
        cleanup();
    }

    #[test]
    fn webkit_workaround_preserves_user_dmabuf_override() {
        // User explicitly disabled the workaround — e.g. their Mesa is fine
        // and they want full GPU compositing. We must NOT clobber.
        let _g = ENV_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        cleanup();
        std::env::set_var(DMABUF, "0");
        super::apply_linux_webkit_workarounds();
        assert_eq!(std::env::var(DMABUF).ok().as_deref(), Some("0"), "user-set DMABUF should be preserved");
        assert_eq!(std::env::var(COMPOSITING).ok().as_deref(), Some("1"), "unset COMPOSITING should still be applied");
        cleanup();
    }

    #[test]
    fn webkit_workaround_preserves_user_compositing_override() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        cleanup();
        std::env::set_var(COMPOSITING, "custom-value");
        super::apply_linux_webkit_workarounds();
        assert_eq!(std::env::var(DMABUF).ok().as_deref(), Some("1"), "unset DMABUF should still be applied");
        assert_eq!(std::env::var(COMPOSITING).ok().as_deref(), Some("custom-value"), "user-set COMPOSITING should be preserved");
        cleanup();
    }

    #[test]
    fn webkit_workaround_preserves_empty_string_as_explicit_unset() {
        // Edge case: empty value still counts as "set" via var_os().is_some(),
        // so we don't overwrite. Some shells/wrappers use "" to mean "unset
        // me explicitly" — respect that intent.
        let _g = ENV_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        cleanup();
        std::env::set_var(DMABUF, "");
        std::env::set_var(COMPOSITING, "");
        super::apply_linux_webkit_workarounds();
        assert_eq!(std::env::var(DMABUF).ok().as_deref(), Some(""));
        assert_eq!(std::env::var(COMPOSITING).ok().as_deref(), Some(""));
        cleanup();
    }

    #[test]
    fn webkit_workaround_is_idempotent() {
        // Calling twice should not change anything after the first call.
        let _g = ENV_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        cleanup();
        super::apply_linux_webkit_workarounds();
        let after_first = (
            std::env::var(DMABUF).ok(),
            std::env::var(COMPOSITING).ok(),
        );
        super::apply_linux_webkit_workarounds();
        let after_second = (
            std::env::var(DMABUF).ok(),
            std::env::var(COMPOSITING).ok(),
        );
        assert_eq!(after_first, after_second, "second call should be a no-op");
        cleanup();
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
        let src = include_str!("main.rs");
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
        const SRC: &str = include_str!("main.rs");
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
        let out = logged(|| tracing::info!(version = "2.6.7", "LU starting"));
        assert!(out.contains("LU starting"), "got: {out}");
        assert!(out.contains("version=\"2.6.7\""), "got: {out}");
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
    const SRC: &str = include_str!("main.rs");

    fn init_tracing_body() -> &'static str {
        let s = &SRC[SRC.find("fn init_tracing()").expect("init_tracing exists")..];
        &s[..s.find("\n}\n").expect("the function ends")]
    }

    #[test]
    fn the_worker_guard_is_held_by_main_and_not_dropped_on_the_spot() {
        // THE tracing-appender trap. `let _ = init_tracing();` compiles, runs,
        // and produces an empty log file, because `_` drops the guard
        // immediately and the writer thread dies with it. A named binding in
        // `main` lives until the process ends.
        // Bounded to main's own body — the negative assertion below matches
        // its own source text otherwise, and the test would fail on itself.
        let main_fn = &SRC[SRC.find("\nfn main() {").expect("main exists")..];
        let main_fn = &main_fn[..main_fn.find("\n}\n").expect("main ends")];
        assert!(
            main_fn.contains("let _log_guard = init_tracing();"),
            "main must bind the WorkerGuard to a named local for the app's lifetime"
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
}
