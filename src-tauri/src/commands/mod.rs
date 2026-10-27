pub mod abliterate;
pub mod agent;
pub mod bg_tasks;
pub mod chat_attachments;
pub mod character_files;
// Saves through a file dialog (rfd), which a phone does not have.
#[cfg(desktop)]
pub mod cloud_file;
pub mod repo_map;
// Which attention flag a ComfyUI that LU starts gets (Comfy Kitchen, flash).
pub mod comfy_attention;
pub mod comfy_folders;
pub mod comfy_user_paths;
pub mod comfy_ws;
// Astra computer use reads the screen and moves mouse and keyboard. Its
// crates (enigo, xcap, the global shortcut plugin) are desktop-only in
// Cargo.toml, and a phone has nothing for it to act on.
#[cfg(desktop)]
pub mod computer;
pub mod custom_models;
pub mod download;
// The same download commands on a phone, where the transfer belongs to the
// operating system (plugins/lu-native).
pub mod download_mobile;
pub mod engine;
pub mod engine_idle;
pub mod engine_key;
// The engine of a phone, where no sidecar can be started. Also built into a
// macOS build with the feature `inproc-engine`, to test its Metal path.
#[cfg(any(mobile, all(target_os = "macos", feature = "inproc-engine")))]
pub mod engine_inproc;
// Going on with a cut answer in the in-process engine. Built everywhere,
// used only where that engine runs.
pub mod engine_continue;
pub mod engine_sanity;
// The access token of the in-process engine. Built everywhere, used only
// where that engine runs.
pub mod engine_token;
pub mod filesystem;
pub mod gguf;
pub mod gpu;
pub mod gpu_roles;
pub mod vram_plan;
#[cfg(test)]
mod vram_plan_live;
pub mod health;
// The installers stay compiled on a phone because other modules use their
// helpers, but every per-platform arm in them is a desktop one, and what only
// those arms use is unused there. None of their commands is registered on a
// phone (lib.rs).
#[cfg_attr(mobile, allow(unused_imports, unused_variables))]
pub mod install;
pub mod install_method;
pub mod install_method_cmd;
pub mod self_migrate;
pub mod self_migrate_cmd;
pub mod local_api;
pub mod logging;
pub mod media_cmds;
pub mod mlx;
pub mod mlx_cutout;
pub mod mlx_loras;
// Moves a render of the Mac engines to the system Trash. No such engine on a
// phone, and the `trash` crate does not compile there.
#[cfg(desktop)]
pub mod mlx_outputs;
pub mod os_trash;
pub mod mlx_snapshot;
pub mod music;
pub mod plugin_rea;
// What a phone must not run, and the check in front of every command.
pub mod mobile_guard;
// Secure storage, the save picker and the memory warning of a phone.
pub mod mobile_native;
pub mod model_sniff;
pub mod model_verify;
pub mod oauth;
pub mod process;
pub mod proxy;
pub mod lan_address;
pub mod remote;
pub mod remote_chats;
pub mod remote_create;
pub mod video_thumb;
// Colour settle across the seams of a long video, on ComfyUI's Python.
// Desktop only: it starts a process.
#[cfg(desktop)]
pub mod video_settle;
pub mod win_firewall;
pub mod remote_sealed;
pub mod runtime_folder;
pub mod storage;
// The phone end of the sealed remote channel (REMOTE-PROTOKOLL v2). The
// commands are registered on a phone only; the core is tested everywhere.
// The desktop end is remote_sealed above.
pub mod remote_sealed_phone;
// The saved characters of Create beside the store backup. Registered on a
// phone only (lib.rs); built for the tests everywhere.
#[cfg(any(mobile, test))]
#[cfg_attr(not(mobile), allow(dead_code))]
pub mod saved_characters_backup;
pub mod search;
pub mod search_tiers;
pub mod secret;
pub mod shell;
pub mod system;
pub mod torch_wheels;
pub mod trainer;
pub mod tts;
pub mod video;
pub mod voice_loop;
pub mod web_body;
pub mod web_reach;
pub mod funnel;
// Moves a ComfyUI render to the system trash. No ComfyUI and no trash on a
// phone, and the `trash` crate does not compile there.
#[cfg(desktop)]
pub mod gallery_files;
pub mod whisper;

// ── the web app-compat error helpers ────────────────────────────────────────
//
// the web app's bridge daemon (axum) uses `internal(msg)` / `bad_request(msg)` /
// `not_found(msg)` helpers that return a structured (StatusCode, Json)
// tuple. The desktop Tauri command convention is `Result<Value, String>`
// where every error collapses to a plain String — Tauri's IPC bridge
// turns it into a JS-side rejection. Re-export the same three names as
// no-op `Into<String>` helpers so files ported verbatim from the web app
// compile without rewriting every `bad_request(...)` call site.
pub type CmdResult = Result<serde_json::Value, String>;

#[allow(dead_code)]
pub fn internal(msg: impl Into<String>) -> String { msg.into() }
#[allow(dead_code)]
pub fn bad_request(msg: impl Into<String>) -> String { msg.into() }
#[allow(dead_code)]
pub fn not_found(msg: impl Into<String>) -> String { msg.into() }

// ── What the latency guard counts ─────────────────────────────────────
//
// A command the interface waits on reads files and memory. It starts no
// interpreter (a tenth of a second at best, five with `import mlx_video`) and
// asks no network: both belong to an install thread, behind the answer.
// `media_latency_guard` holds the status and list commands to that by counting
// on the thread that runs them. Outside the tests the two `note_*` calls are
// empty.

#[cfg(test)]
thread_local! {
    static INTERPRETER_COMMANDS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static HUB_REQUESTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Called wherever an interpreter command is built (`python::python_command`).
pub(crate) fn note_interpreter_command() {
    #[cfg(test)]
    INTERPRETER_COMMANDS.with(|n| n.set(n.get() + 1));
}

/// Called by every request towards the model hub (`mlx::hub_get`).
pub(crate) fn note_hub_request() {
    #[cfg(test)]
    HUB_REQUESTS.with(|n| n.set(n.get() + 1));
}

#[cfg(test)]
pub(crate) fn interpreter_commands_built() -> usize {
    INTERPRETER_COMMANDS.with(|n| n.get())
}

#[cfg(test)]
pub(crate) fn hub_requests_sent() -> usize {
    HUB_REQUESTS.with(|n| n.get())
}

#[cfg(test)]
mod media_latency_guard;

/// The real run on the Mac: the commands above against real engines and real
/// models. Ignored unless asked for by name, see the file.
#[cfg(all(test, target_os = "macos"))]
mod real_run_mac;
