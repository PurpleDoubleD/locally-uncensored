//! What a phone must not be able to run.
//!
//! The desktop app starts processes, opens ports and reads the screen: a
//! shell for the agent, Ollama, ComfyUI, the local API, the Remote server,
//! a tunnel. The frontend calls all of that through commands, and the
//! command list is shared by every platform (lib.rs), so on a phone every
//! one of those names would be callable from the webview. Some of them would
//! even work: Android has a shell.
//!
//! `wrap` puts one check in front of the whole list. On Android and iOS a
//! command from `BLOCKED` is answered with an error before its function is
//! reached. On the desktop `wrap` changes nothing.
//!
//! The lists below are the decision, and the test at the bottom keeps them
//! complete: every command lib.rs registers for a phone has to stand in
//! exactly one of them. A new command that nobody sorted fails the test, it
//! does not slip onto the phone unseen.

use tauri::ipc::Invoke;
use tauri::Runtime;

/// The answer a blocked command gets.
#[cfg_attr(not(mobile), allow(dead_code))]
pub const REFUSAL: &str = "This function is not available in the phone app.";

/// Never reachable on a phone: starts a process, runs code, opens a port,
/// hands out a token for one, reads the screen or the process table.
pub const BLOCKED: &[&str] = &[
    // Desktop commands of 3.0.8, sorted when the phone line joined the
    // 3.0.8 candidate: the host side of Remote, storage and the runtime
    // folder, Abliteration, the model check, GPU roles, the REA plugin. A
    // phone runs none of them; its own end of Remote is
    // commands/remote_sealed_phone.rs. Importing a cloud character and
    // picking a GGUF file are not built for a phone at all.
    "abliterate_plan",
    "abliterate_start",
    "abliterate_status",
    "abliterate_cancel",
    "abliterate_dismiss",
    "abliterate_runs",
    "abliterate_trash_copy",
    "runtime_folder_status",
    "set_runtime_folder",
    "move_runtime_folder",
    "character_photos",
    "verify_model_files",
    "verify_model_files_status",
    "verify_model_files_cancel",
    "trash_model_file",
    "comfy_torch_plan",
    "plugin_rea_status",
    "mcp_child_path",
    "plugin_rea_fetch",
    "plugin_rea_guard",
    "storage_status",
    "storage_plan",
    "storage_apply",
    "storage_cancel",
    "set_engine_idle_unload",
    "engine_key_for",
    "set_remote_page_title",
    "remote_pairing_qr",
    "remote_pairing_window",
    "remote_paired_devices",
    "remote_forget_device",
    "remote_set_device_rights",
    "remote_set_new_device_rights",
    "remote_firewall_status",
    "remote_firewall_allow",
    "remote_pair_decide",
    "remote_pair_requests",
    "remote_set_anywhere",
    "remote_set_legacy_access",
    "remote_signin_requests",
    "remote_signin_decide",
    "remote_create_progress",
    "remote_create_finish",
    "remote_create_capabilities_reply",
    "remote_create_gallery_reply",
    "remote_chats_sync",
    "remote_chats_event",
    "remote_chats_reply",
    "remote_e2e_mode",
    "remote_create_cancel",
    "remote_create_snapshot",
    "set_gpu_roles",
    "get_gpu_roles",
    "describe_gpu_roles",
    // A shell and an interpreter for the agent.
    "shell_execute",
    "shell_execute_cancel",
    "execute_code",
    "execute_code_cancel",
    "shell_task_start",
    "shell_task_status",
    "shell_task_kill",
    "shell_task_list",
    // The screen and the processes of the device.
    "screenshot",
    "process_list",
    "kill_process_tree",
    // Programs the desktop starts and stops next to itself.
    "start_ollama",
    "start_comfyui",
    "stop_comfyui",
    "fix_comfyui_cors",
    "install_searxng",
    "transcribe",
    "synthesize",
    "synthesize_external",
    "transcribe_external",
    "log_reveal",
    // The desktop update lane: stops the engines and starts LU again. A phone
    // is updated by its store.
    "restart_after_update",
    // Servers. The phone is a client of a desktop LU, never the host.
    "start_local_api",
    "local_api_new_token",
    "start_remote_server",
    "restart_remote_server",
    "regenerate_remote_token",
    "remote_qr_code",
    "set_remote_permissions",
    "start_tunnel",
];

/// Registered on a phone and meant to be. Listed so that the test can tell
/// "decided" from "forgotten", nothing reads this at run time.
#[cfg(test)]
pub const ALLOWED: &[&str] = &[
    "oauth_start",
    "oauth_wait",
    // Status and settings of desktop programs: they answer "not there" or
    // store a value nothing uses. Stopping what cannot run is harmless and
    // must not fail, shared cleanup code calls it.
    "comfyui_status",
    "comfyui_last_output",
    "find_comfyui",
    "detect_all_comfyui_installs",
    "set_comfyui_path",
    "set_comfy_gpu_mode",
    "get_comfy_gpu_status",
    "set_comfyui_port",
    "set_comfyui_autostart",
    "set_comfyui_host",
    "set_ollama_host",
    "get_ollama_host",
    "offload_local_models",
    "show_window",
    "whisper_status",
    "tts_status",
    "download_voice",
    "installed_piper_voices",
    "stop_local_api",
    "local_api_status",
    "local_api_usage",
    "stop_remote_server",
    "revoke_remote_memory",
    "remote_server_status",
    "remote_connected_devices",
    "disconnect_remote_device",
    "stop_tunnel",
    "tunnel_status",
    "search_status",
    "searxng_status",
    // Files inside the app's own folders.
    "file_read",
    "file_write",
    "set_chat_workspace_override",
    "get_chat_workspace_override",
    "list_agent_workspaces",
    "fs_read",
    "fs_read_bytes",
    "fs_delete",
    "fs_write",
    "fs_write_bytes",
    "fs_list",
    "fs_search",
    "fs_info",
    "save_text_file_dialog",
    "save_binary_file_dialog",
    "validate_workspace_folder",
    "write_chat_attachment",
    "read_chat_attachment",
    "save_chat_attachment_dialog",
    "export_chats_dialog",
    "import_chats_dialog",
    "sniff_model_files",
    "repo_map",
    // The app itself.
    "system_info",
    "pick_folder",
    "is_onboarding_done",
    "set_onboarding_done",
    "get_current_time",
    "backup_stores",
    "restore_stores",
    "backup_rag_chunks",
    "restore_rag_chunks",
    "saved_characters_backup_missing",
    "saved_characters_backup_put",
    "saved_characters_backup_write_index",
    "saved_characters_backup_read_index",
    "saved_characters_backup_read_photo",
    "exit_app",
    "install_method",
    "onboarding_window_open",
    "system_health",
    "log_write",
    "log_file_path",
    "detect_gpus",
    "set_gpu_selection",
    "get_gpu_selection",
    "funnel_ping",
    // Models: download, list, run in the app's own engine.
    "download_model",
    "comfy_model_target",
    "download_model_to_path",
    "download_progress",
    "pause_download",
    "cancel_download",
    "clear_download_entry",
    "check_download_space",
    "find_orphan_downloads",
    "delete_orphan_download",
    "resume_download",
    "set_download_limit",
    "detect_model_path",
    "lmstudio_model_dir",
    "check_model_sizes",
    "delete_comfy_model",
    "set_hf_token",
    "hf_token_present",
    "start_bundled_engine",
    "stop_bundled_engine",
    "bundled_engine_status",
    "kv_slot_action",
    "swap_bundled_model",
    "list_bundled_models",
    "delete_bundled_model",
    "start_bundled_embed",
    "stop_bundled_embed",
    "bundled_embed_status",
    // Secure storage.
    "secret_set",
    "secret_get",
    "secret_delete",
    "secret_park_set",
    "secret_park_get",
    "secret_park_delete",
    // Remote client: private addresses and *.trycloudflare.com only. The
    // plain one only in the Wi-Fi (and the bare status over the tunnel).
    "remote_client_request",
    "remote_client_cancel",
    // The sealed channel: same address gate, the device key stays in Rust,
    // the six digit code only in the Wi-Fi (remote_sealed.rs).
    "remote_sealed_pair",
    "remote_sealed_request",
    "remote_sealed_fetch_result",
    "remote_sealed_cancel",
    "remote_sealed_forget",
    // "Sign in with my computer": signs only a code that came out of the channel.
    "remote_sealed_signin",
    // The end of the app's own log, as text.
    "read_log_tail",
    // Opens the settings page of this app, nothing else.
    "open_system_settings",
    // The network, each with its own address checks.
    "web_search",
    "web_fetch",
    "ollama_search",
    "fetch_external",
    "fetch_external_bytes",
    "proxy_localhost",
    "cancel_proxy_call",
    "proxy_localhost_stream",
    "proxy_localhost_stream_chunked",
    "cancel_proxy_stream",
    "comfy_upload_image",
    "register_openai_host",
    "pull_model_stream",
    "cancel_model_pull",
];

#[cfg_attr(not(mobile), allow(dead_code))]
pub fn is_blocked(command: &str) -> bool {
    BLOCKED.contains(&command)
}

/// Put the check in front of the generated handler.
fn wrap<R, H>(handler: H) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static
where
    R: Runtime,
    H: Fn(Invoke<R>) -> bool + Send + Sync + 'static,
{
    move |invoke| {
        #[cfg(mobile)]
        if is_blocked(invoke.message.command()) {
            tracing::warn!(command = invoke.message.command(), "blocked on a phone");
            invoke.resolver.reject(REFUSAL);
            return true;
        }
        handler(invoke)
    }
}

/// A builder whose next `invoke_handler` gets the check in front of it.
///
/// lib.rs writes `.mobile_guard().invoke_handler(tauri::generate_handler![..])`,
/// so the line every guard test and script looks for keeps its wording.
pub struct Guarded<R: Runtime>(tauri::Builder<R>);

impl<R: Runtime> Guarded<R> {
    pub fn invoke_handler<H>(self, handler: H) -> tauri::Builder<R>
    where
        H: Fn(Invoke<R>) -> bool + Send + Sync + 'static,
    {
        self.0.invoke_handler(wrap(handler))
    }
}

pub trait GuardExt<R: Runtime> {
    fn mobile_guard(self) -> Guarded<R>;
}

impl<R: Runtime> GuardExt<R> for tauri::Builder<R> {
    fn mobile_guard(self) -> Guarded<R> {
        Guarded(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIB_RS: &str = include_str!("../lib.rs");

    /// The names lib.rs registers on a phone: every entry of the handler
    /// list that does not carry `#[cfg(desktop)]`. An entry gated to mobile
    /// counts, an entry gated to the desktop does not.
    fn registered_on_a_phone() -> Vec<String> {
        let open = "tauri::generate_handler![";
        let from = LIB_RS.find(open).expect("the handler list is in lib.rs") + open.len();
        let to = from + LIB_RS[from..].find("\n        ])").expect("the handler list ends");
        let mut names = Vec::new();
        let mut desktop_only = false;
        for line in LIB_RS[from..to].lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with("//") {
                continue;
            }
            if line.starts_with("#[cfg(desktop)]") {
                desktop_only = true;
                continue;
            }
            if line.starts_with("#[") {
                // Any other gate (for example #[cfg(mobile)]) keeps the entry.
                continue;
            }
            let path = line.trim_end_matches(',');
            assert!(
                path.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ':'),
                "unexpected line in the handler list: {line}"
            );
            if !desktop_only {
                names.push(path.rsplit("::").next().unwrap().to_string());
            }
            desktop_only = false;
        }
        names
    }

    #[test]
    fn the_handler_list_is_wrapped() {
        let at = LIB_RS.find(".invoke_handler(tauri::generate_handler![").expect("the handler list is in lib.rs");
        assert!(
            LIB_RS[..at].trim_end().ends_with(".mobile_guard()"),
            "lib.rs has to call .mobile_guard() directly before .invoke_handler"
        );
        assert_eq!(LIB_RS.matches(".invoke_handler(").count(), 1, "one handler, and it is the wrapped one");
    }

    #[test]
    fn the_parser_sees_the_list() {
        let names = registered_on_a_phone();
        assert!(names.len() > 100, "only {} commands found, the parser lost the list", names.len());
        assert!(names.contains(&"secret_get".to_string()));
        // Desktop-only entries are not in it.
        assert!(!names.contains(&"install_ollama".to_string()));
        assert!(!names.contains(&"mlx_generate".to_string()));
    }

    #[test]
    fn every_phone_command_is_sorted_into_exactly_one_list() {
        let mut unsorted = Vec::new();
        let mut twice = Vec::new();
        for name in registered_on_a_phone() {
            let blocked = BLOCKED.contains(&name.as_str());
            let allowed = ALLOWED.contains(&name.as_str());
            if blocked && allowed {
                twice.push(name);
            } else if !blocked && !allowed {
                unsorted.push(name);
            }
        }
        assert!(
            unsorted.is_empty(),
            "registered on a phone and in neither list of mobile_guard.rs: {unsorted:?}. Decide: BLOCKED or ALLOWED."
        );
        assert!(twice.is_empty(), "in both lists: {twice:?}");
    }

    #[test]
    fn the_lists_name_nothing_that_is_gone() {
        let names = registered_on_a_phone();
        for name in BLOCKED.iter().chain(ALLOWED.iter()) {
            assert!(names.iter().any(|n| n == name), "{name} is in a list of mobile_guard.rs and not registered on a phone");
        }
    }

    #[test]
    fn what_starts_a_process_or_a_server_is_blocked() {
        for name in [
            "shell_execute",
            "execute_code",
            "screenshot",
            "shell_task_start",
            "shell_task_status",
            "shell_task_kill",
            "shell_task_list",
            "process_list",
            "start_ollama",
            "start_comfyui",
            "start_local_api",
            "start_remote_server",
            "start_tunnel",
            "install_searxng",
        ] {
            assert!(is_blocked(name), "{name} must not be reachable on a phone");
        }
    }

    #[test]
    fn a_name_that_merely_starts_like_a_blocked_one_is_not_blocked() {
        assert!(!is_blocked("shell_execute_more"));
        assert!(!is_blocked("start_bundled_engine"));
        assert!(!is_blocked(""));
    }

    /// Anything whose name says it starts, installs, executes or kills is
    /// blocked unless it is one of the engine's own, which run inside the app.
    #[test]
    fn nothing_that_sounds_like_a_launcher_is_allowed_by_accident() {
        let own = ["start_bundled_engine", "start_bundled_embed", "install_method"];
        for name in ALLOWED {
            if own.contains(name) {
                continue;
            }
            for word in ["start_", "install_", "execute", "shell_", "kill_", "spawn"] {
                assert!(
                    !name.starts_with(word) && !name.contains("_execute"),
                    "{name} is allowed on a phone and sounds like it starts something. If that is right, name it in this test."
                );
            }
        }
    }
}
