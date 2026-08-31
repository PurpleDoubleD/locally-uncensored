use std::collections::{HashMap, HashSet};
use std::process::Child;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;

use crate::commands::gpu::GpuSelection;
use crate::commands::whisper::WhisperServer;
use crate::commands::remote::RemoteServer;
use crate::python::get_python_bin;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct DownloadProgress {
    pub progress: u64,
    pub total: u64,
    pub speed: f64,
    pub filename: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Absolute path of the file this transfer is writing. The map is keyed by
    /// bare filename, which two different models can share, so this is what
    /// tells a restart of the SAME download apart from a name collision — and
    /// it is how cancel finds the right `.download` temp file instead of
    /// guessing a handful of subfolders.
    #[serde(default)]
    pub dest: String,
}

/// Handle to a running bundled `llama-server`. One model per process, so
/// `model_path` identifies what's loaded and `port` is the loopback port the
/// OpenAI-compatible API is served on. Killed in `shutdown_subprocesses` like
/// the other spawned children.
///
/// Used for BOTH the chat engine (`bundled_engine`) and — P5 — the separate
/// `--embeddings` server (`bundled_embed`): same lifecycle shape, different
/// port + model + serve mode. Keeping one struct avoids duplicating the handle.
pub struct BundledEngine {
    pub child: Child,
    pub model_path: String,
    pub port: u16,
    /// Context size the CHAT engine was started with (`None` for the embed
    /// server, which never sets `--ctx-size`). Surfaced by the status command
    /// so the UI shows the true token-counter denominator.
    pub ctx: Option<u32>,
    /// Full argv the process was spawned with — the idempotence key: a start
    /// request resolving to the same argv reuses the running process, any
    /// difference (model, ctx, tuning, port) triggers a stop→start.
    pub args: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct InstallState {
    pub status: String,
    /// The current headline, i.e. the last line a caller passed to set_status,
    /// kept apart from `logs`. The log tail is whatever the child process
    /// printed last (pip chatter), so a UI reading only the tail cannot tell
    /// the user which phase is running and falls back to a dead spinner.
    #[serde(default)]
    pub phase: String,
    pub logs: Vec<String>,
    pub download_progress: u64,
    pub download_total: u64,
    pub download_speed: f64,
}

impl Default for InstallState {
    fn default() -> Self {
        Self {
            status: "idle".to_string(),
            phase: String::new(),
            logs: Vec::new(),
            download_progress: 0,
            download_total: 0,
            download_speed: 0.0,
        }
    }
}

/// Read persisted ComfyUI port + host from %APPDATA%/locally-uncensored/config.json.
/// Returns (port, host) with sensible defaults (8188, "localhost") on any error.
/// Called at startup so user-configured values survive app restarts.
pub(crate) fn load_comfy_config_values() -> (u16, String) {
    let mut port = 8188u16;
    let mut host = "localhost".to_string();

    if let Some(config_dir) = dirs::config_dir() {
        let config_file = config_dir.join("locally-uncensored").join("config.json");
        if let Ok(raw) = std::fs::read_to_string(&config_file) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(p) = v.get("comfyui_port").and_then(|x| x.as_u64()) {
                    if p > 0 && p < 65536 {
                        port = p as u16;
                    }
                }
                if let Some(h) = v.get("comfyui_host").and_then(|x| x.as_str()) {
                    let trimmed = h.trim();
                    if !trimmed.is_empty() {
                        host = trimmed.to_string();
                    }
                }
            }
        }
    }

    (port, host)
}

/// Read persisted Ollama base URL with the following priority:
///  1. `ollama_base` in config.json (GUI-configured)
///  2. `OLLAMA_HOST` env var (Ollama's own convention)
///  3. Default `http://localhost:11434`
///
/// Accepts bare `host:port`, scheme-less `host`, or full URL — returns full
/// URL without trailing slash. Matches Ollama's own OLLAMA_HOST semantics so
/// setting it as an env var before launching LU "just works".
pub(crate) fn load_ollama_base() -> String {
    let normalize = |raw: &str| -> String {
        let trimmed = raw.trim().trim_end_matches('/');
        if trimmed.is_empty() {
            "http://localhost:11434".to_string()
        } else if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            trimmed.to_string()
        } else {
            format!("http://{}", trimmed)
        }
    };

    // Priority 1: config.json override (GUI takes precedence)
    if let Some(config_dir) = dirs::config_dir() {
        let config_file = config_dir.join("locally-uncensored").join("config.json");
        if let Ok(raw) = std::fs::read_to_string(&config_file) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(b) = v.get("ollama_base").and_then(|x| x.as_str()) {
                    let normalized = normalize(b);
                    if !normalized.is_empty() {
                        return normalized;
                    }
                }
            }
        }
    }

    // Priority 2: OLLAMA_HOST env var — same semantics as Ollama itself.
    // Ollama docs explicitly document e.g. `OLLAMA_HOST=0.0.0.0:11434`.
    if let Ok(env) = std::env::var("OLLAMA_HOST") {
        let normalized = normalize(&env);
        if !normalized.is_empty() {
            return normalized;
        }
    }

    // Priority 3: default
    "http://localhost:11434".to_string()
}

pub struct AppState {
    pub comfy_process: Mutex<Option<Child>>,
    /// Child handle for an Ollama daemon LU spawned itself (kj103x bug, Discord
    /// 2026-05-23 #help-chat). The Drop impl below kills the tree on shutdown
    /// so `ollama.exe` doesn't linger eating ~200 MB after the tray quit.
    /// IMPORTANT: only populated when `start_ollama` / `auto_start_ollama` /
    /// the Ollama installer actually spawned — if a user-managed
    /// `ollama serve` was already running on the box (detected via tasklist
    /// before spawn), we leave it alone, so closing LU never kills someone
    /// else's Ollama.
    ///
    /// `Arc` because `install_ollama` spawns its serve from a worker thread
    /// that outlives the command's `State` borrow, and the installer's Ollama
    /// is just as much ours to reap as the one `start_ollama` spawns (OI-4).
    pub ollama_process: Arc<Mutex<Option<Child>>>,
    /// Built-in inference engine (bundled llama-server, P1). `None` until the
    /// onboarding / provider layer starts it via `start_bundled_engine`. The
    /// managed lifecycle (start/stop/swap) lives in `commands::engine`; this
    /// is just the handle so shutdown can reap it.
    pub bundled_engine: Mutex<Option<BundledEngine>>,
    /// Built-in EMBEDDINGS server (P5) — a second bundled `llama-server` run in
    /// `--embeddings` mode on its own port, serving OpenAI `/v1/embeddings` for
    /// Document-Chat / RAG so embeddings no longer require Ollama. `None` until
    /// started via `start_bundled_embed`; reaped in `shutdown_subprocesses`.
    pub bundled_embed: Mutex<Option<BundledEngine>>,
    /// Arc so the ComfyUI install worker thread can persist a custom install
    /// target as the active path on completion (andy_38747).
    pub comfy_path: Arc<Mutex<Option<String>>>,
    pub comfy_port: Mutex<u16>,
    /// Configurable ComfyUI host. Default "localhost". Setting this to a
    /// remote hostname/IP lets users point LU at a ComfyUI running on
    /// another machine (homelab, Docker, LAN). Persisted in config.json.
    pub comfy_host: Mutex<String>,
    /// Configurable Ollama base URL. Default `http://localhost:11434`.
    /// Seeded from (in priority order): config.json `ollama_base` field,
    /// `OLLAMA_HOST` env var, or the default. Updated at runtime via the
    /// `set_ollama_host` command. Every call that proxies Ollama reads this
    /// value so GUI changes reflect everywhere without a restart.
    pub ollama_base: Mutex<String>,
    /// Hosts of user-configured OpenAI-compatible backends reachable over the
    /// LAN (LM Studio / vLLM / etc. bound to 0.0.0.0 on another machine).
    /// Registered at runtime via `register_openai_host` so `validate_proxy_url`
    /// forwards to them — same allow-list model as `ollama_base`/`comfy_host`.
    /// In-memory only; rebuilt lazily from the persisted provider config the
    /// first time a LAN endpoint is used after launch (Bug A / GH #49).
    pub openai_hosts: Mutex<HashSet<String>>,
    pub whisper: Arc<Mutex<WhisperServer>>,
    pub downloads: Arc<Mutex<HashMap<String, DownloadProgress>>>,
    pub download_tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
    pub pull_tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
    /// Per-stream cancellation tokens for `proxy_localhost_stream_chunked`.
    /// When the user hits Stop or deletes/closes a chat, the JS side calls
    /// `cancel_proxy_stream(stream_id)` → the token fires → the upstream reqwest
    /// stream is dropped → Ollama actually stops generating (David 2026-06-15:
    /// "Aktivität komplett stoppen"; aborting only stopped the JS loop before).
    pub stream_tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
    pub install_status: Arc<Mutex<InstallState>>,
    /// Cancel flag for the ComfyUI installer (Bug #1, techx69 v2.4.3).
    /// `install_comfyui` polls this between steps; setting it from
    /// `cancel_comfyui_install` aborts the next git/pip subprocess and
    /// flips the install_status to "cancelled".
    pub comfyui_install_cancel: Arc<AtomicBool>,
    pub ollama_install: Arc<Mutex<InstallState>>,
    pub lmstudio_install: Arc<Mutex<InstallState>>,
    pub python_install: Arc<Mutex<InstallState>>,
    /// §24.9 — progress/log state for the in-app faster-whisper installer
    /// (the STT badge had no way to fix a ✗). Mirrors the other per-installer
    /// states; `install_whisper` writes it, `install_whisper_status` reads it.
    pub whisper_install: Arc<Mutex<InstallState>>,
    /// Progress/log state for the in-app Piper neural-TTS installer (mirrors
    /// `whisper_install`); `install_tts` writes it, `install_tts_status` reads it.
    pub tts_install: Arc<Mutex<InstallState>>,
    /// 2.5.8 local character trainer (musubi-tuner in its own venv, outside
    /// the ComfyUI dir). `trainer_install` streams the one-time environment
    /// setup; `trainer_run` streams an actual training run (status
    /// idle/running/complete/error, logs, step counters in
    /// download_progress/total). Commands live in `commands::trainer`.
    pub trainer_install: Arc<Mutex<InstallState>>,
    pub trainer_run: Arc<Mutex<InstallState>>,
    pub trainer_cancel: Arc<AtomicBool>,
    pub trainer_process: Arc<Mutex<Option<u32>>>,
    /// The environment failed its check AND failed the automatic repair.
    /// `character_trainer_status` folds this into `envReady`, because the
    /// readiness probe is a file-presence check and a torch that is on disk
    /// but unusable passes it, which used to leave the Set up button hidden
    /// in exactly the state that needs it. In memory only: after a restart
    /// the disk check speaks again, and a training run that fails the same
    /// way sets it right back. Cleared the moment a provision succeeds.
    pub trainer_env_broken: Arc<AtomicBool>,
    pub searxng_install: Mutex<InstallState>,
    pub searxng_available: AtomicBool,
    /// Resolved Python binary path. Empty string means "no real Python on
    /// this box" — callers must treat `""` as the missing-Python sentinel
    /// and surface the install_python flow rather than spawning `"python"`
    /// (which on Windows hits the Microsoft Store stub). Wrapped in a
    /// `Mutex` so `install_python` can update it at runtime once Python
    /// finishes installing — without that, the user would have to restart
    /// LU to pick up the freshly installed Python.
    pub python_bin: Arc<Mutex<String>>,
    // Remote Access
    pub remote: Mutex<RemoteServer>,
    /// Per-chat workspace overrides — when present, agent file ops with
    /// a relative path resolve against this folder instead of the
    /// default `~/agent-workspace/<chat_id>/`. Set when the user picks
    /// a folder during Remote dispatch (#29 follow-up); cleared on
    /// undispatch / chat delete.
    pub chat_workspace_overrides: Arc<Mutex<HashMap<String, std::path::PathBuf>>>,
    /// Bug BB v2.5.0 — BobbyT Discord 2026-05-26. User-pinned GPU vendor +
    /// indices, forwarded as CUDA_VISIBLE_DEVICES / HIP_VISIBLE_DEVICES /
    /// ONEAPI_DEVICE_SELECTOR on next start_ollama / start_comfyui spawn.
    /// Default "auto" + empty indices = no env-var, runtime picks default
    /// (pre-v2.5.0 behaviour).
    pub gpu_selection: Mutex<GpuSelection>,
    /// flash-attn probe results, keyed by python path (David 2026-06-11:
    /// measured 4-5x faster WAN video sampling vs pytorch SDPA on a 3060).
    /// The probe imports torch (~5-10 s), so only the first ComfyUI start /
    /// Create-tab check per python pays it.
    pub flash_attn_cache: Mutex<HashMap<String, bool>>,
    /// ComfyUI GPU torch-availability probe, keyed by python path (2026-07-01,
    /// rhodium92 AMD RX 6600 XT). `torch.cuda.is_available()` is true for CUDA,
    /// ROCm AND ZLUDA builds — the exact condition under which ComfyUI's main.py
    /// won't crash on `torch.cuda.current_device()`. Lets an AMD/ROCm ComfyUI run
    /// on the GPU instead of being force-dropped to `--cpu`.
    pub comfy_gpu_cache: Mutex<HashMap<String, bool>>,
    /// Frontend-owned override for the ComfyUI CPU/GPU decision
    /// (settings.comfyGpuMode): "auto" (probe), "cpu" (force --cpu), "gpu"
    /// (never --cpu). Pushed via set_comfy_gpu_mode on boot + change.
    pub comfy_gpu_mode: Mutex<String>,
    /// Whether the LAST ComfyUI start actually passed `--cpu` (shd_scorpion,
    /// RX 7900 XTX: gen "timed out after 20 minutes" with zero hint that it
    /// ran on the CPU). None = LU hasn't started ComfyUI this session.
    /// Surfaced to the Create tab via `get_comfy_gpu_status`.
    pub comfy_started_cpu: Mutex<Option<bool>>,
    /// Ring buffer of the last ComfyUI stdout/stderr lines (GH #98). The
    /// shipped app has no console, so a main.py that crashes on startup was
    /// invisible: the user saw "did not come up" with nothing to check.
    /// The drain threads push here; `comfyui_last_output` reads it back.
    /// Arc because the drain threads outlive the command's State borrow.
    pub comfy_output: Arc<Mutex<std::collections::VecDeque<String>>>,
    /// When the tracked ComfyUI child was spawned. Without it "starting" was
    /// just `process_alive && !running`, so a handle that never resolved left
    /// the panel claiming a start that had been over for minutes (E16,
    /// measured 2026-08-14). `comfy_starting_state` dates the wait against it.
    pub comfy_start_at: Mutex<Option<std::time::Instant>>,
    // ── In-process MLX media engine (macOS Apple-Silicon local image/video) ──
    // Ported from uselu/apps/bridge's `commands::mlx` / `commands::video`. The
    // app spawns its OWN Python MLX sidecar (server.py on 127.0.0.1:47712) —
    // no separate daemon. Hard rule: Mac local image/video is MLX only, never
    // ComfyUI.
    /// Install progress for the MLX-Stable-Diffusion engine (venv + torch +
    /// diffusers). `commands::mlx::install_mlx_diffusion`.
    pub install_mlx_diffusion: crate::install_state::InstallSlot,
    /// Install progress for a single MLX image-catalog model download.
    pub install_mlx_image_model: crate::install_state::InstallSlot,
    /// Install progress for the `mlx-video` pip package.
    pub install_mlx_video: crate::install_state::InstallSlot,
    /// Install progress for a single MLX video-catalog model download/convert.
    pub install_video_model: crate::install_state::InstallSlot,
    /// Live progress/log of the currently running (or last) video generation.
    pub video_progress: crate::install_state::InstallSlot,
    /// Handle to the running `mlx_video.*.generate` subprocess, if any. `Arc`-
    /// wrapped (unlike the other `Mutex<Option<Child>>` handles above) so the
    /// video-generation reaper thread can hold its own clone of the same
    /// mutex instead of needing a clone of the whole (non-`Clone`) `AppState`.
    pub video_process: Arc<Mutex<Option<Child>>>,
}

impl AppState {
    pub fn new() -> Self {
        let python_bin = get_python_bin();
        if python_bin.is_empty() {
            println!("[Python] Resolved: <none — install_python required for ComfyUI / agent code-exec>");
        } else {
            println!("[Python] Resolved: {}", python_bin);
        }

        // Load persisted ComfyUI port+host from config.json if available.
        // Fixes a pre-existing bug where `set_comfyui_port` wrote to disk but
        // startup never read it back. Same loader now handles the new host field.
        let (initial_port, initial_host) = load_comfy_config_values();
        if initial_port != 8188 {
            println!("[ComfyUI] Loaded persisted port: {}", initial_port);
        }
        if initial_host != "localhost" {
            println!("[ComfyUI] Loaded persisted host: {}", initial_host);
        }

        // Same bootstrap for Ollama — reads config.json first, then
        // OLLAMA_HOST env var, then defaults. Fixes Issue #31 where users
        // with OLLAMA_HOST set globally (Docker, homelab, LAN) saw "No local
        // backend detected" even though ollama.exe was running.
        let initial_ollama_base = load_ollama_base();
        if initial_ollama_base != "http://localhost:11434" {
            println!("[Ollama] Using base URL: {}", initial_ollama_base);
        }

        Self {
            comfy_process: Mutex::new(None),
            ollama_process: Arc::new(Mutex::new(None)),
            bundled_engine: Mutex::new(None),
            bundled_embed: Mutex::new(None),
            comfy_path: Arc::new(Mutex::new(None)),
            comfy_port: Mutex::new(initial_port),
            comfy_host: Mutex::new(initial_host),
            ollama_base: Mutex::new(initial_ollama_base),
            openai_hosts: Mutex::new(HashSet::new()),
            whisper: Arc::new(Mutex::new(WhisperServer::new())),
            downloads: Arc::new(Mutex::new(HashMap::new())),
            download_tokens: Arc::new(Mutex::new(HashMap::new())),
            pull_tokens: Arc::new(Mutex::new(HashMap::new())),
            stream_tokens: Arc::new(Mutex::new(HashMap::new())),
            install_status: Arc::new(Mutex::new(InstallState::default())),
            comfyui_install_cancel: Arc::new(AtomicBool::new(false)),
            ollama_install: Arc::new(Mutex::new(InstallState::default())),
            lmstudio_install: Arc::new(Mutex::new(InstallState::default())),
            python_install: Arc::new(Mutex::new(InstallState::default())),
            whisper_install: Arc::new(Mutex::new(InstallState::default())),
            tts_install: Arc::new(Mutex::new(InstallState::default())),
            trainer_install: Arc::new(Mutex::new(InstallState::default())),
            trainer_run: Arc::new(Mutex::new(InstallState::default())),
            trainer_cancel: Arc::new(AtomicBool::new(false)),
            trainer_process: Arc::new(Mutex::new(None)),
            trainer_env_broken: Arc::new(AtomicBool::new(false)),
            searxng_install: Mutex::new(InstallState::default()),
            searxng_available: AtomicBool::new(false),
            python_bin: Arc::new(Mutex::new(python_bin)),
            // Claude Code
            // Remote Access
            remote: Mutex::new(RemoteServer::new()),
            chat_workspace_overrides: Arc::new(Mutex::new(HashMap::new())),
            // Bug BB v2.5.0 — start in "auto" mode so existing installs are
            // unchanged until the user explicitly picks a GPU in Settings.
            gpu_selection: Mutex::new(GpuSelection::default()),
            flash_attn_cache: Mutex::new(HashMap::new()),
            comfy_gpu_cache: Mutex::new(HashMap::new()),
            comfy_gpu_mode: Mutex::new("auto".to_string()),
            comfy_started_cpu: Mutex::new(None),
            comfy_output: Arc::new(Mutex::new(std::collections::VecDeque::new())),
            comfy_start_at: Mutex::new(None),
            install_mlx_diffusion: crate::install_state::InstallSlot::default(),
            install_mlx_image_model: crate::install_state::InstallSlot::default(),
            install_mlx_video: crate::install_state::InstallSlot::default(),
            install_video_model: crate::install_state::InstallSlot::default(),
            video_progress: crate::install_state::InstallSlot::default(),
            video_process: Arc::new(Mutex::new(None)),
        }
    }
}

impl AppState {
    /// Install-progress accessors for the in-process MLX media engine — each
    /// returns a cloned handle (`InstallSlot` is a cheap `Arc`-backed clone),
    /// matching the accessor-method convention the ported `commands::mlx` /
    /// `commands::video` code expects (`state.install_mlx_diffusion()` etc.).
    pub fn install_mlx_diffusion(&self) -> crate::install_state::InstallSlot {
        self.install_mlx_diffusion.clone()
    }
    pub fn install_mlx_image_model(&self) -> crate::install_state::InstallSlot {
        self.install_mlx_image_model.clone()
    }
    pub fn install_mlx_video(&self) -> crate::install_state::InstallSlot {
        self.install_mlx_video.clone()
    }
    pub fn install_video_model(&self) -> crate::install_state::InstallSlot {
        self.install_video_model.clone()
    }
    pub fn video_progress(&self) -> crate::install_state::InstallSlot {
        self.video_progress.clone()
    }
    /// Cloned `Arc` handle to the video-subprocess mutex — cheap, and lets a
    /// spawned reaper thread hold its own reference without needing the
    /// (non-`Clone`) `AppState` itself. See the `video_process` field doc.
    pub fn video_process(&self) -> Arc<Mutex<Option<Child>>> {
        self.video_process.clone()
    }
    /// Resolved Python binary path, or `None` when no real Python was found
    /// on this box (`python_bin` stores `""` as that sentinel — see the field
    /// doc comment above).
    pub fn python_bin(&self) -> Option<String> {
        let bin = self.python_bin.lock().unwrap().clone();
        if bin.is_empty() { None } else { Some(bin) }
    }
}

// On Windows, spawn child processes without flashing a console window.
// Applied to every taskkill/kill call so LU's process lifecycle stays invisible
// to the user. 0x08000000 = CREATE_NO_WINDOW.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

impl AppState {
    /// Kill every subprocess we spawned (ComfyUI, Ollama, Claude Code, Whisper).
    ///
    /// Live testing on 2026-05-25 showed that Tauri v2's `app.exit(0)` returns
    /// from the run loop on Windows WITHOUT actually dropping the managed
    /// `AppState` — the process exits before Drop fires, so children spawned
    /// in `auto_start_*` survived every "graceful" quit path (tray → Quit,
    /// auto-updater's `exit_app`, etc.). The `Drop` impl below is still
    /// correct, but we can't rely on it firing. Call this method explicitly
    /// from every quit path instead so kj103x's Ollama-orphan stays fixed even
    /// when Tauri's destructor chain skips us.
    pub fn shutdown_subprocesses(&self) {
        if let Ok(mut proc) = self.ollama_process.lock() {
            // take(), not a borrow: leaving the pid in the slot let the Drop
            // pass below fire a second taskkill at it.
            if let Some(child) = proc.take() {
                let pid = child.id();
                #[cfg(windows)]
                {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/pid", &pid.to_string(), "/T", "/F"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                    drop(child);
                }
                #[cfg(not(windows))]
                {
                    let mut child = child;
                    let _ = child.kill();
                    let _ = pid;
                }
                println!("[Ollama] Stopped (explicit shutdown)");
            }
        }

        // Built-in engine (bundled llama-server, P1). Plain kill on all
        // platforms — it's a single loopback process with no child tree, so
        // the taskkill /T dance the daemons need isn't required here.
        if let Ok(mut engine) = self.bundled_engine.lock() {
            if let Some(ref mut e) = *engine {
                let _ = e.child.kill();
                println!("[Engine] Built-in engine stopped (explicit shutdown)");
            }
            *engine = None;
        }

        // Built-in embeddings server (P5) — same plain-kill treatment.
        if let Ok(mut embed) = self.bundled_embed.lock() {
            if let Some(ref mut e) = *embed {
                let _ = e.child.kill();
                println!("[Engine] Built-in embeddings server stopped (explicit shutdown)");
            }
            *embed = None;
        }

        if let Ok(mut proc) = self.comfy_process.lock() {
            // take(), not a borrow: leaving the pid in the slot let the Drop
            // pass below fire a second taskkill at it.
            if let Some(child) = proc.take() {
                let pid = child.id();
                #[cfg(windows)]
                {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/pid", &pid.to_string(), "/T", "/F"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                    drop(child);
                }
                #[cfg(not(windows))]
                {
                    let mut child = child;
                    let _ = child.kill();
                    let _ = pid;
                }
                println!("[ComfyUI] Stopped (explicit shutdown)");
            }
        }

        // In-process MLX video subprocess (`mlx_video.*.generate`). Plain kill —
        // it's a single Python process, no child tree to walk.
        if let Ok(mut proc) = self.video_process.lock() {
            if let Some(ref mut child) = *proc {
                let _ = child.kill();
                println!("[MLX] video subprocess stopped (explicit shutdown)");
            }
            *proc = None;
        }

        // MLX image sidecar (server.py on MLX_PORT). `mlx_start` deliberately
        // drops the Child handle — the sidecar outlives individual renders and
        // is addressed over loopback — so quitting used to orphan the venv
        // Python forever (observed live: LU gone, server.py still resident).
        // Kill it by its listening port, same mechanism as the Stop button.
        #[cfg(target_os = "macos")]
        {
            crate::process_util::kill_listeners_on_port(crate::commands::mlx::MLX_PORT);
            println!("[MLX] image sidecar stopped (explicit shutdown)");
        }

        // Character-LoRA training. The PID sits in AppState like every other
        // long-running child, but shutdown skipped it — so quitting during a
        // training run left an orphaned Python process holding the GPU, and
        // the UI that could have cancelled it was gone. Training is the
        // longest-lived and most VRAM-hungry child the app spawns.
        if let Ok(mut slot) = self.trainer_process.lock() {
            if let Some(pid) = slot.take() {
                crate::commands::trainer::kill_trainer_tree(pid);
                println!("[Trainer] Training stopped (explicit shutdown)");
            }
        }

        // Installer children (git clone, pip and everything pip forks). Unlike
        // every slot above, these live in a registry inside `commands::install`
        // rather than in AppState — the installers run on detached worker
        // threads that outlive the command's State borrow. Quitting mid-install
        // used to leave the whole pip tree resident with no UI left to stop it
        // (OI-7).
        let killed = crate::commands::install::kill_installer_children();
        if killed > 0 {
            println!("[Install] {killed} installer child tree(s) stopped (explicit shutdown)");
        }

        if let Ok(mut whisper) = self.whisper.lock() {
            whisper.stop();
        }
    }
}

impl Drop for AppState {
    fn drop(&mut self) {
        // Belt-and-suspenders. Tauri v2 doesn't reliably drop the managed
        // state on `app.exit(0)` on Windows, so every quit path explicitly
        // calls `shutdown_subprocesses` itself (see `commands::system::exit_app`
        // and the tray "quit" handler in `main.rs`). This Drop covers the
        // remaining "Tauri-managed shutdown DID happen to run our Drop" case
        // — and every branch now take()s its slot, so a second pass has
        // nothing left to kill. It used to leave the pids in place and call
        // the re-kill harmless; `taskkill /T /F` on a pid Windows has since
        // recycled is not harmless, it takes out a stranger's process tree.
        self.shutdown_subprocesses();
    }
}

#[cfg(test)]
mod shutdown_tests {
    use super::*;

    /// A live child that outlives the test unless something kills it.
    fn sleeper() -> std::process::Child {
        std::process::Command::new("sleep")
            .arg("30")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn sleeper")
    }

    /// A killed-but-unreaped child is a ZOMBIE — `ps -p` still lists it, so the
    /// process STATE has to be read. Z means the kill landed and only the exit
    /// status is still pending; at quit the parent dies and init reaps it.
    fn alive(pid: u32) -> bool {
        let out = std::process::Command::new("ps")
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

    /// The quit path is normally only reachable through the Tauri exit (tray
    /// Quit / exit_app), which cannot be triggered from a test or from a shell.
    /// It is a plain method though, so it CAN be exercised with real children —
    /// which is the only runtime proof available for it on this machine.
    #[test]
    #[cfg_attr(target_os = "windows", ignore = "uses sleep/ps")]
    fn shutdown_kills_the_tracked_children_and_empties_the_slots() {
        let state = AppState::new();

        let ollama = sleeper();
        let comfy = sleeper();
        let ollama_pid = ollama.id();
        let comfy_pid = comfy.id();
        *state.ollama_process.lock().unwrap() = Some(ollama);
        *state.comfy_process.lock().unwrap() = Some(comfy);

        // The trainer is tracked as a bare pid, which is exactly why the
        // shutdown used to skip it (d038209).
        let trainer = sleeper();
        let trainer_pid = trainer.id();
        std::mem::forget(trainer); // only the pid is tracked, as in the real flow
        *state.trainer_process.lock().unwrap() = Some(trainer_pid);

        state.shutdown_subprocesses();
        std::thread::sleep(std::time::Duration::from_millis(400));

        assert!(!alive(ollama_pid), "ollama child survived the shutdown");
        assert!(!alive(comfy_pid), "comfyui child survived the shutdown");
        assert!(!alive(trainer_pid), "TRAINER survived the shutdown (d038209)");

        // Slots emptied, so the Drop pass has nothing left to fire at — a pid
        // Windows may have recycled by then (3f3427c).
        assert!(state.ollama_process.lock().unwrap().is_none());
        assert!(state.comfy_process.lock().unwrap().is_none());
        assert!(state.trainer_process.lock().unwrap().is_none());
    }

    /// Quitting with nothing running must not panic or block.
    #[test]
    fn shutdown_on_an_idle_state_is_a_no_op() {
        let state = AppState::new();
        state.shutdown_subprocesses();
        state.shutdown_subprocesses();
    }
}
