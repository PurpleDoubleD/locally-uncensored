// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod python;
mod state;

use state::AppState;
use tauri::{
    Manager,
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

fn main() {
    #[cfg(target_os = "linux")]
    apply_linux_webkit_workarounds();

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
        .invoke_handler(tauri::generate_handler![
            // Process management
            commands::process::start_ollama,
            commands::process::start_comfyui,
            commands::process::stop_comfyui,
            commands::process::comfyui_status,
            commands::process::find_comfyui,
            commands::process::detect_all_comfyui_installs,
            commands::process::set_comfyui_path,
            commands::process::set_comfyui_port,
            commands::process::set_comfyui_host,
            commands::process::set_ollama_host,
            commands::process::get_ollama_host,
            // Installation
            commands::install::install_comfyui,
            commands::install::install_comfyui_status,
            commands::install::cancel_comfyui_install,
            commands::install::install_ollama,
            commands::install::install_ollama_status,
            commands::install::install_lmstudio,
            commands::install::install_lmstudio_status,
            commands::install::start_lmstudio_server,
            commands::install::lmstudio_server_status,
            commands::install::install_python,
            commands::install::install_python_status,
            commands::install::python_check,
            commands::install::install_custom_node,
            // Whisper STT
            commands::whisper::whisper_status,
            commands::whisper::transcribe,
            // Agent tools (legacy)
            commands::agent::execute_code,
            commands::agent::file_read,
            commands::agent::file_write,
            commands::agent::set_chat_workspace_override,
            commands::agent::get_chat_workspace_override,
            // Shell
            commands::shell::shell_execute,
            // Filesystem
            commands::filesystem::fs_read,
            commands::filesystem::fs_write,
            commands::filesystem::fs_list,
            commands::filesystem::fs_search,
            commands::filesystem::fs_info,
            commands::filesystem::save_text_file_dialog,
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
            commands::download::resume_download,
            commands::download::detect_model_path,
            commands::download::check_model_sizes,
            // Web search
            commands::search::web_search,
            commands::search::web_fetch,
            commands::search::search_status,
            commands::search::install_searxng,
            commands::search::searxng_status,
            // Claude Code
            commands::claude_code::detect_claude_code,
            commands::claude_code::install_claude_code,
            commands::claude_code::install_claude_code_status,
            commands::claude_code::start_claude_code,
            commands::claude_code::stop_claude_code,
            commands::claude_code::send_claude_code_input,
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
            commands::proxy::proxy_comfyui_upload,
            commands::proxy::pull_model_stream,
            commands::proxy::cancel_model_pull,
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

            // ─── System Tray ───
            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let tray_icon = Image::from_path("icons/icon.png")
                .or_else(|_| Image::from_path("icons/32x32.png"))
                .unwrap_or_else(|_| Image::from_bytes(include_bytes!("../icons/32x32.png")).expect("embedded icon"));

            TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("Locally Uncensored")
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
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }

            // ─── Auto-start services ───
            let state = app.state::<AppState>();

            commands::process::auto_start_ollama(&state);
            commands::process::auto_start_comfyui(&state);

            let handle = app.handle().clone();
            let python_bin = state.python_bin.lock().unwrap().clone();
            let whisper = state.whisper.clone();
            std::thread::spawn(move || {
                // Whisper auto-start is best-effort and pip-installs faster-whisper
                // on first launch — silently skip when no Python is on the box, so
                // a fresh install doesn't fail the whole startup. The user can
                // install Python later via the ComfyUI flow; whisper picks up on
                // next launch.
                if !python_bin.is_empty() {
                    commands::whisper::auto_start_whisper_sync(&handle, &python_bin, &whisper);
                } else {
                    println!("[Whisper] Skipping auto-start: no Python yet (install via ComfyUI step)");
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
}
