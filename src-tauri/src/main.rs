// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod python;
mod state;

use state::AppState;
use tauri::Manager;

fn main() {
    let app_state = AppState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            // Process management
            commands::process::start_ollama,
            commands::process::start_comfyui,
            commands::process::stop_comfyui,
            commands::process::comfyui_status,
            commands::process::find_comfyui,
            commands::process::set_comfyui_path,
            // Installation
            commands::install::install_comfyui,
            commands::install::install_comfyui_status,
            // Whisper STT
            commands::whisper::whisper_status,
            commands::whisper::transcribe,
            // Agent tools
            commands::agent::execute_code,
            commands::agent::file_read,
            commands::agent::file_write,
            // Downloads
            commands::download::download_model,
            commands::download::download_progress,
            // Web search
            commands::search::web_search,
            commands::search::search_status,
            commands::search::install_searxng,
            commands::search::searxng_status,
            // Proxy
            commands::proxy::ollama_search,
            commands::proxy::fetch_external,
            commands::proxy::fetch_external_bytes,
        ])
        .setup(|app| {
            let state = app.state::<AppState>();

            // Auto-start Ollama
            commands::process::auto_start_ollama(&state);

            // Auto-start ComfyUI
            commands::process::auto_start_comfyui(&state);

            // Start Whisper server (background — model loading takes minutes)
            commands::whisper::auto_start_whisper(app.handle(), &state);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
