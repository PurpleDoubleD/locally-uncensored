use crate::os_error;

// P1 — Built-in inference engine (bundled llama.cpp `llama-server`).
//
// The whole point of 2.5.7's "onboarding without external providers" is that
// the app ships its own inference engine and never *requires* Ollama / LM
// Studio again. `llama-server` speaks an OpenAI-compatible API, so the
// existing `OpenAIProvider` + `proxy_localhost_stream_chunked` path drives it
// unchanged — this module owns only the *lifecycle* (spawn / health-wait /
// stop / model-swap) of the sidecar process, mirroring `start_ollama`.
//
// One model per process: `llama-server` loads a single GGUF, so a model swap
// is a stop→start with a new `-m` (Ollama-like, ~1-3 s). The child handle
// lives in `AppState.bundled_engine` and is killed in `shutdown_subprocesses`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::state::{AppState, BundledEngine};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Default loopback port for the managed chat engine. Matches the `builtin`
/// preset base URL on the frontend (`http://127.0.0.1:8127/v1`).
pub const DEFAULT_ENGINE_PORT: u16 = 8127;

/// Default loopback port for the managed EMBEDDINGS server (P5). Separate
/// process/port from the chat engine so Document-Chat/RAG can embed while a
/// chat model stays loaded. Matches `embedBaseUrl()` on the frontend
/// (`http://127.0.0.1:8128/v1`).
pub const DEFAULT_EMBED_PORT: u16 = 8128;

/// How long to wait for `/health` to flip to 200 after spawn. A cold GGUF
/// load (mmap + Metal warm-up) on a big model can take a while on a slow disk;
/// 60 s is comfortably above a normal 1-3 s load without hanging forever on a
/// binary that never comes up.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(60);

// ── Pure helpers (unit-tested without a real binary) ─────────────────────────

/// Sidecar file name Tauri produces from
/// `externalBin: ["bin/lu-llama-server"]` inside the bundled app (target
/// triple suffix stripped, `.exe` on Windows).
///
/// GitHub #120 (AnnSdf1969, Ubuntu 26.04, 2026-08-28): the file used to be
/// called `llama-server`, and Tauri's deb bundler copies every external
/// binary straight into `/usr/bin`. Debian ships its own `llama.cpp-tools`
/// package that owns `/usr/bin/llama-server`, so dpkg refused the whole
/// install with "trying to overwrite '/usr/bin/llama-server', which is also
/// in package llama.cpp-tools". The bundler offers no way to put a sidecar
/// anywhere else, so the name carries the app prefix instead. Renaming beats
/// a Debian Conflicts entry: a conflict would make the user uninstall their
/// own llama.cpp to install ours.
pub(crate) fn sidecar_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "lu-llama-server.exe"
    } else {
        "lu-llama-server"
    }
}

/// Rust host target-triple, used to locate the dev-time sidecar produced by
/// `scripts/build-llama.sh` (`bin/lu-llama-server-<triple>[.exe]`). mac-first for
/// 2.5.7; win/linux triples are here so P6 doesn't need to touch this.
pub(crate) fn host_target_triple() -> String {
    let arch = std::env::consts::ARCH; // "aarch64" | "x86_64" | ...
    match std::env::consts::OS {
        "macos" => format!("{arch}-apple-darwin"),
        "windows" => format!("{arch}-pc-windows-msvc"),
        _ => format!("{arch}-unknown-linux-gnu"),
    }
}

/// Expert tuning for the chat engine, settable from the app's Built-in Engine
/// settings. `Default` reproduces the exact argv the app has always used, so
/// an absent/partial tuning is never a behavior change. Values are whitelisted
/// in `build_server_args` — an unknown string falls back to the default flag
/// (settings files are user-editable; never pass them through verbatim).
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EngineTuning {
    /// Context window (`--ctx-size`). 0 is NOT forwarded as llama-server's
    /// "use model default" — a 128k-trained model would allocate a huge KV
    /// cache unprompted; 0/absent means our 8192 default.
    pub ctx: u32,
    /// Flash Attention: "auto" (binary default, omitted), "on", "off".
    pub flash_attn: String,
    /// KV cache quantization for K / V: "f16" (default, omitted), "bf16",
    /// "q8_0", "q4_0". Quantized V requires Flash Attention in llama.cpp.
    pub cache_type_k: String,
    pub cache_type_v: String,
    /// CPU threads for generation. <=0 = auto (omitted).
    pub threads: i32,
    /// GPU layers to offload. <0 = all (999, today's behavior); >=0 explicit
    /// (0 = CPU-only is a valid expert choice on RAM-starved boxes).
    pub gpu_layers: i32,
    /// Pin model in RAM (`--mlock`).
    pub mlock: bool,
    /// Disable mmap (`--no-mmap`): slower load, fewer pageouts.
    pub no_mmap: bool,
}

impl Default for EngineTuning {
    fn default() -> Self {
        Self {
            ctx: 8192,
            flash_attn: "auto".into(),
            cache_type_k: "f16".into(),
            cache_type_v: "f16".into(),
            threads: -1,
            gpu_layers: -1,
            mlock: false,
            no_mmap: false,
        }
    }
}

/// KV cache types this build of llama-server accepts and we consider sane.
const KV_CACHE_TYPES: &[&str] = &["f16", "bf16", "q8_0", "q4_0"];

/// The context size actually passed to the server (`tuning.ctx`, with 0
/// falling back to the 8192 default — see `EngineTuning::ctx`).
pub(crate) fn effective_ctx(tuning: &EngineTuning) -> u32 {
    if tuning.ctx == 0 { 8192 } else { tuning.ctx }
}

/// Name a vision projector gets on disk: `<model stem>.mmproj.gguf`, written
/// next to the model. Mirrors `mmprojFileName` in src/api/discover.ts, which is
/// what the downloader writes. Derived from the model name rather than kept
/// under the upstream name because the built-in models dir is FLAT: two vision
/// models in it would otherwise both claim one `mmproj-F16.gguf`.
pub(crate) fn mmproj_sibling_path(model_path: &str) -> PathBuf {
    let p = Path::new(model_path);
    let stem = p
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.strip_suffix(".gguf").or_else(|| s.strip_suffix(".GGUF")).unwrap_or(s))
        .unwrap_or("");
    p.with_file_name(format!("{stem}.mmproj.gguf"))
}

/// True for a file name that is a vision projector, not a model. Keeps
/// projectors out of the model picker: they are GGUFs in the same folder, so
/// the plain "every .gguf is a model" scan would offer them as chat models and
/// llama-server would refuse to load them. Covers our own `.mmproj.gguf`
/// convention and the upstream `mmproj-*.gguf` names a user may drop in by hand.
pub(crate) fn is_projector_file(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    let stem = lower.strip_suffix(".gguf").unwrap_or(&lower);
    stem.ends_with(".mmproj") || stem.starts_with("mmproj")
}

/// Absolute path of the projector belonging to `model_path`, if it is on disk.
/// Absence is the normal case (text-only model) and never an error.
fn existing_mmproj(model_path: &str) -> Option<String> {
    let p = mmproj_sibling_path(model_path);
    p.is_file().then(|| p.to_string_lossy().to_string())
}

/// Build the `llama-server` argv for a chat engine. `-ngl 999` offloads every
/// layer to the GPU (Metal on mac); llama-server clamps to the real layer
/// count, so an over-large value is the idiomatic "all layers" request.
/// Default tuning yields exactly the legacy argv (pinned by regression test).
///
/// `mmproj` turns the model multimodal. A text GGUF has no image tower, so
/// without the flag a vision model loads and answers, it just cannot see, which
/// is exactly the silent failure the Discover download avoids by fetching the
/// projector with the model.
pub(crate) fn build_server_args(model_path: &str, tuning: &EngineTuning, port: u16, slot_save_dir: Option<&str>, mmproj: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-m".into(),
        model_path.into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "--ctx-size".into(),
        effective_ctx(tuning).to_string(),
        "-ngl".into(),
        if tuning.gpu_layers < 0 {
            "999".into()
        } else {
            tuning.gpu_layers.to_string()
        },
    ];
    if matches!(tuning.flash_attn.as_str(), "on" | "off") {
        args.push("-fa".into());
        args.push(tuning.flash_attn.clone());
    }
    if tuning.cache_type_k != "f16" && KV_CACHE_TYPES.contains(&tuning.cache_type_k.as_str()) {
        args.push("-ctk".into());
        args.push(tuning.cache_type_k.clone());
    }
    if tuning.cache_type_v != "f16" && KV_CACHE_TYPES.contains(&tuning.cache_type_v.as_str()) {
        args.push("-ctv".into());
        args.push(tuning.cache_type_v.clone());
    }
    if tuning.threads > 0 {
        args.push("-t".into());
        args.push(tuning.threads.to_string());
    }
    if tuning.mlock {
        args.push("--mlock".into());
    }
    if tuning.no_mmap {
        args.push("--no-mmap".into());
    }
    if let Some(path) = mmproj {
        args.push("--mmproj".into());
        args.push(path.into());
    }
    // GH #85 (I-Am-LongXi): enable llama-server's slot save/restore API so the
    // VRAM handoff can serialize the KV cache to disk before evicting the
    // engine for a render, and restore it after the reload instead of
    // re-processing the whole conversation. The flag only enables the
    // endpoint; nothing is written until a save is requested. With an mmproj
    // loaded llama.cpp refuses the save (check_no_mtmd) and answers with a
    // plain error instead of writing a file, which the handoff already treats
    // as "not saved" and skips the restore. So the flag stays on either way.
    if let Some(dir) = slot_save_dir {
        args.push("--slot-save-path".into());
        args.push(dir.into());
    }
    args
}

/// Build the `llama-server` argv for the EMBEDDINGS server (P5). `--embeddings`
/// switches llama-server into pooled-embedding mode so `/v1/embeddings`
/// returns vectors instead of chat completions. `--pooling mean` matches how
/// nomic/bge embedding GGUFs are meant to be pooled. `-ngl 999` offloads all
/// layers (Metal on mac); embedding models are tiny so this is cheap.
pub(crate) fn build_embed_args(model_path: &str, port: u16) -> Vec<String> {
    vec![
        "-m".into(),
        model_path.into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "--embeddings".into(),
        "--pooling".into(),
        "mean".into(),
        "-ngl".into(),
        "999".into(),
        // One chunk is embedded in a single batch, and llama-server's default
        // physical batch is 512 tokens. A document whose text has few sentence
        // breaks produced longer chunks and Document Chat died on
        // "input (658 tokens) is too large to process, increase the physical
        // batch size" (ChrisMcSheehy, D#91). The chunker keeps chunks well
        // under this now; the headroom means a near-miss is not a failed
        // import. Cheap: these models are small and the batch only bounds a
        // scratch buffer.
        "-b".into(),
        "2048".into(),
        "-ub".into(),
        "2048".into(),
    ]
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct BundledModel {
    /// File name without the `.gguf` extension — the id the frontend shows and
    /// passes back to `swap_bundled_model`.
    pub name: String,
    /// Absolute path to the GGUF file.
    pub path: String,
    /// File size in bytes (0 if it couldn't be stat-ed).
    pub size: u64,
}

/// Parse a llama.cpp gguf-split file stem: `<base>-NNNNN-of-MMMMM` (4 or 5
/// digit groups, mirroring the frontend's GGUF_SHARD_RE). Returns
/// (base, part, total) or None for ordinary single-file stems.
fn split_shard_stem(stem: &str) -> Option<(&str, u32, u32)> {
    let (rest, total_s) = stem.rsplit_once("-of-")?;
    let (base, part_s) = rest.rsplit_once('-')?;
    for s in [part_s, total_s] {
        if !(4..=5).contains(&s.len()) || !s.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    let part: u32 = part_s.parse().ok()?;
    let total: u32 = total_s.parse().ok()?;
    if base.is_empty() || part == 0 || total == 0 || part > total {
        return None;
    }
    Some((base, part, total))
}

/// Scan a directory (non-recursive) for `*.gguf` files. Case-insensitive on
/// the extension so `Model.GGUF` from a manual copy still shows up. Sorted by
/// name for a stable UI ordering. Missing dir → empty list (not an error): a
/// fresh install has no models yet.
///
/// Split GGUFs (`-NNNNN-of-NNNNN`, e.g. the 80+ GB DeepSeek V4 Flash 0731
/// quants) collapse into ONE entry: name without the shard suffix, path of
/// part 1 (llama-server loads the rest from the same folder itself), size as
/// the sum of all parts. Listing each shard would offer parts 2..N as
/// "models" that can never load. A set with missing parts is not listed at
/// all, so a paused or aborted multi-part download never impersonates an
/// installed model (same rule a9ea114 established for MLX downloads).
pub(crate) fn scan_gguf_models(dir: &Path) -> Vec<BundledModel> {
    let mut out = Vec::new();
    // (dir, base, total) → (part-numbers seen, path of part 1, byte sum).
    // The directory is part of the key: two unrelated split sets that share a
    // base name in different subfolders must never merge into one entry.
    let mut sets: std::collections::HashMap<(PathBuf, String, u32), (Vec<u32>, Option<String>, u64)> =
        std::collections::HashMap::new();
    scan_gguf_dir(dir, 0, &mut out, &mut sets);
    for ((_dir, base, total), (mut parts, first_path, size)) in sets {
        parts.sort_unstable();
        parts.dedup();
        let complete = parts.len() as u32 == total && parts.first() == Some(&1);
        if let (true, Some(path)) = (complete, first_path) {
            out.push(BundledModel {
                name: base,
                path,
                size,
            });
        }
    }
    // A name is the picker id, so it has to be unique. The shallowest copy
    // wins (the flat app dir is the canonical place); ties fall to the path.
    out.sort_by(|a, b| {
        let depth = |p: &str| p.matches(['/', '\\']).count();
        a.name
            .cmp(&b.name)
            .then(depth(&a.path).cmp(&depth(&b.path)))
            .then(a.path.cmp(&b.path))
    });
    out.dedup_by(|a, b| a.name == b.name);
    out
}

/// How far below the app models dir the scan walks. 0 alone was the shipped
/// behaviour and it is still where every model the app writes today lands.
///
/// GH #118 (nayffy, 2026-08-27): before the download-routing fix, a chat model
/// installed on a fresh box was written to `<models>/<user>/<repo>/x.gguf`,
/// the LM Studio layout. The routing is fixed, but the boxes that already ran
/// the broken build have multi-gigabyte files sitting in those folders. Two
/// levels reach them, so those installs heal on the next model refresh instead
/// of asking the user to download everything a second time. Deeper than that
/// buys nothing and only costs directory reads.
const MAX_SCAN_DEPTH: usize = 2;

fn scan_gguf_dir(
    dir: &Path,
    depth: usize,
    out: &mut Vec<BundledModel>,
    sets: &mut std::collections::HashMap<(PathBuf, String, u32), (Vec<u32>, Option<String>, u64)>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth < MAX_SCAN_DEPTH {
                scan_gguf_dir(&path, depth + 1, out, sets);
            }
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let is_gguf = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("gguf"))
            .unwrap_or(false);
        if !is_gguf {
            continue;
        }
        // Vision projectors live next to their model and are GGUFs too, but
        // they are not chat models. Listing them would put a file in the
        // picker that llama-server cannot serve.
        if path
            .file_name()
            .and_then(|s| s.to_str())
            .map(is_projector_file)
            .unwrap_or(false)
        {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if let Some((base, part, total)) = split_shard_stem(&name) {
            let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
            let slot = sets
                .entry((parent, base.to_string(), total))
                .or_insert((Vec::new(), None, 0));
            slot.0.push(part);
            if part == 1 {
                slot.1 = Some(path.to_string_lossy().to_string());
            }
            slot.2 += size;
            continue;
        }
        out.push(BundledModel {
            name,
            path: path.to_string_lossy().to_string(),
            size,
        });
    }
}

/// App-owned models directory for the built-in engine:
/// `{data_dir}/Locally Uncensored/models`. Created on demand so the first
/// download / scan just works on a fresh box. This is the same path
/// `detect_model_path("builtin")` returns.
pub fn builtin_models_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or("Cannot resolve app data directory")?;
    let dir = base.join("Locally Uncensored").join("models");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Create built-in models dir: {}", os_error::english(&e)))?;
    Ok(dir)
}

// ── Sidecar resolution ───────────────────────────────────────────────────────

/// Locate the bundled `llama-server` binary. Prod: next to the main
/// executable (where Tauri copies `externalBin`). Dev: the target-triple
/// artifact `scripts/build-llama.sh` drops into `src-tauri/bin/`.
fn resolve_engine_binary(app: &AppHandle) -> Option<PathBuf> {
    // 1. Bundled: same dir as the running app binary.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(sidecar_binary_name());
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    // 2. Resource dir (belt-and-suspenders for platforms that stage it there).
    if let Ok(res) = app.path().resource_dir() {
        let candidate = res.join(sidecar_binary_name());
        if candidate.exists() {
            return Some(candidate);
        }
    }

    // 3. Dev: src-tauri/bin/lu-llama-server-<triple>[.exe]. `tauri dev` runs
    //    the binary from target/debug, so walk up to the manifest dir.
    let triple = host_target_triple();
    let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
    let dev_name = format!("lu-llama-server-{triple}{suffix}");
    let mut dev_candidates: Vec<PathBuf> = Vec::new();
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        dev_candidates.push(PathBuf::from(&manifest).join("bin").join(&dev_name));
    }
    if let Ok(cwd) = std::env::current_dir() {
        dev_candidates.push(cwd.join("src-tauri").join("bin").join(&dev_name));
        dev_candidates.push(cwd.join("bin").join(&dev_name));
    }
    dev_candidates.into_iter().find(|p| p.exists())
}

// ── Health probe ─────────────────────────────────────────────────────────────

/// The slot that actually holds the conversation. llama-server distributes
/// requests across its `-np` parallel slots by prompt similarity, so slot 0
/// is only right by luck: the Z36 counter-check (2026-08-22) watched the
/// 626 MB history sit in slot 3 while the save hit slot 0 and wrote a
/// 20 byte husk. A used slot carries `n_prompt_tokens` in GET /slots and an
/// untouched one does not carry the field at all (measured on the bundled
/// b1-049326a engine), so the biggest value marks the history worth saving.
/// Any surprise falls back to 0, exactly the old behaviour.
pub(crate) fn pick_save_slot(slots: &serde_json::Value) -> u32 {
    let arr = match slots.as_array() {
        Some(a) => a,
        None => return 0,
    };
    let mut best = 0u32;
    let mut best_tokens = -1i64;
    for s in arr {
        let id = s.get("id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let toks = s.get("n_prompt_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
        if toks > best_tokens {
            best_tokens = toks;
            best = id;
        }
    }
    best
}

/// Save or restore llama-server's KV cache across the VRAM handoff (GH #85).
/// The webview cannot fetch the engine port directly (CSP; all engine traffic
/// rides the Rust proxy), so the handoff calls this instead. One fixed
/// filename: the handoff carries at most one conversation across one eviction
/// at a time. A save asks GET /slots first and targets the slot that really
/// holds the tokens (see `pick_save_slot`); a restore loads into slot 0 and
/// the server's own prompt-similarity slot selection routes the next turn to
/// the restored cache. `ok:false` is a normal outcome (old binary, empty
/// slot, ctx mismatch after a settings change) and means the next turn
/// re-processes the history, exactly the pre-#85 cost.
#[tauri::command]
pub async fn kv_slot_action(port: u16, action: String) -> Result<serde_json::Value, String> {
    if action != "save" && action != "restore" {
        return Err("action must be 'save' or 'restore'".to_string());
    }
    let slot_id = if action == "save" {
        match reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
        {
            Ok(probe) => match probe
                .get(format!("http://127.0.0.1:{port}/slots"))
                .send()
                .await
            {
                Ok(res) => res
                    .json::<serde_json::Value>()
                    .await
                    .map(|v| pick_save_slot(&v))
                    .unwrap_or(0),
                Err(_) => 0,
            },
            Err(_) => 0,
        }
    } else {
        0
    };
    let url = format!("http://127.0.0.1:{port}/slots/{slot_id}?action={action}");
    let client = reqwest::Client::builder()
        // Serializing a multi-GB KV cache to disk takes a while on slow disks.
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| os_error::english(&e))?;
    let res = client
        .post(&url)
        .json(&serde_json::json!({ "filename": "lu-handoff.bin" }))
        .send()
        .await
        .map_err(|e| format!("slot {action} failed: {}", os_error::english(&e)))?;
    let ok = res.status().is_success();
    let body: serde_json::Value = res.json().await.unwrap_or_else(|_| serde_json::json!({}));
    Ok(serde_json::json!({ "ok": ok, "body": body }))
}

fn engine_healthy(port: u16) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(400))
        .build()
        .ok()
        .and_then(|c| c.get(format!("http://127.0.0.1:{port}/health")).send().ok())
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// The last `max` non-empty lines of a sidecar's stderr, for an error message.
fn tail_lines(text: &str, max: usize) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let start = lines.len().saturating_sub(max);
    lines[start..].join("\n")
}

/// Health budget scaled to the GGUF on disk: base 60s + 4s per GiB, capped
/// at 10 minutes. A 0.5 GB model keeps the old 60s; a 40 GB one gets ~220s —
/// big models legitimately need minutes on a cold first load, and a fixed
/// 60s turned that into a false "did not become healthy" (ENG-4).
fn health_timeout_for_bytes(bytes: u64) -> Duration {
    let gb = (bytes / 1_073_741_824).min(1024) as u32;
    (HEALTH_TIMEOUT + Duration::from_secs(4) * gb).min(Duration::from_secs(600))
}

fn health_timeout_for(model_path: &str) -> Duration {
    std::fs::metadata(model_path)
        .map(|m| health_timeout_for_bytes(m.len()))
        .unwrap_or(HEALTH_TIMEOUT)
}

/// Block until `/health` returns 200 or `timeout` elapses (callers scale the
/// budget to the model size via `health_timeout_for`). Returns `Ok(())` on
/// ready, `Err` with a hint on timeout so the UI can surface a real message
/// instead of a silent hang.
fn wait_for_health(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if engine_healthy(port) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Err(format!(
        "Built-in engine did not become healthy on port {port} within {}s (the budget scales with model size — huge GGUFs can take minutes on a cold first load)",
        timeout.as_secs()
    ))
}

/// How a health wait ended.
#[derive(Debug, PartialEq)]
enum HealthWait {
    Ready,
    /// The child we spawned is gone. Nothing more will happen on that port.
    ChildExited,
    TimedOut,
}

/// Block until `/health` returns 200, the child exits, or the budget runs out.
///
/// The child half is the GH #118 half: `wait_for_health` watched only the
/// port, so an engine that died on a missing runtime library or a GPU backend
/// it could not initialise still left the user staring at a spinner for the
/// full budget (60 s, and up to 10 minutes on a big GGUF) before any message
/// appeared. The process is ours, its exit is knowable in milliseconds, so it
/// is checked on the same 300 ms tick as the port.
fn wait_for_health_or_exit(state: &AppState, port: u16, timeout: Duration) -> HealthWait {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if engine_healthy(port) {
            return HealthWait::Ready;
        }
        let gone = {
            let mut guard = state.bundled_engine.lock().unwrap();
            match guard.as_mut() {
                Some(e) => e.child.try_wait().ok().flatten().is_some(),
                None => true,
            }
        };
        if gone {
            // One last look: a server can bind, answer, and the process can
            // still be reaped between the two checks on a fast load.
            return if engine_healthy(port) { HealthWait::Ready } else { HealthWait::ChildExited };
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    HealthWait::TimedOut
}

/// Markers in llama-server's stderr that point at the GPU rather than at the
/// model file or the app. Lower-cased input.
fn stderr_blames_the_gpu(stderr: &str) -> bool {
    const MARKERS: &[&str] = &[
        "cuda",
        "no kernel image",
        "hip",
        "rocm",
        "vulkan",
        "out of memory",
        "cublas",
        "device memory",
        "ggml_backend_alloc",
        "failed to allocate",
        "compute capability",
    ];
    let lower = stderr.to_ascii_lowercase();
    MARKERS.iter().any(|m| lower.contains(m))
}

/// Markers that point at the model file itself.
fn stderr_blames_the_model(stderr: &str) -> bool {
    const MARKERS: &[&str] = &[
        "unknown model architecture",
        "failed to load model",
        "invalid magic",
        "unsupported model",
        "wrong number of tensors",
        "tensor .* not found",
        "gguf_init_from_file",
    ];
    let lower = stderr.to_ascii_lowercase();
    MARKERS.iter().any(|m| lower.contains(m))
}

/// One English sentence a user can act on, plus llama-server's own last words
/// so a bug report still carries them.
///
/// GH #118: "did not become healthy" named no cause, and the fresh-install
/// case named nothing at all because no start was ever attempted. The GPU
/// hint matters most on new cards: a Blackwell RTX 50-series board with a
/// driver or engine build that does not know it fails at load time, and
/// setting GPU Layers to 0 is the one setting in this app that gets the user
/// chatting anyway.
pub(crate) fn start_failure_message(failure: &StartFailure, port: u16, budget: Duration) -> String {
    let head = if failure.port_taken {
        format!(
            "Port {port} answers health checks, but the engine this app just started exited immediately. Another llama-server (likely left over from a previous session or crash) is occupying the port. Quit that process or reboot, then try again."
        )
    } else if failure.died {
        let hint = if stderr_blames_the_gpu(&failure.stderr) {
            " This looks like a graphics-card problem. Open Settings, Built-in Engine and set GPU Layers to 0 to run on the CPU, then try again."
        } else if stderr_blames_the_model(&failure.stderr) {
            " The engine refused the model file. Open Models, Discover and install a different quant."
        } else {
            " Reinstall Locally Uncensored if this keeps happening, or pick a different backend in Settings, AI Backends."
        };
        format!("The built-in engine started and exited again before it could serve on port {port}. It was tried twice.{hint}")
    } else {
        format!(
            "The built-in engine did not become healthy on port {port} within {}s (the budget scales with model size, and huge GGUFs can take minutes on a cold first load).",
            budget.as_secs()
        )
    };
    if failure.stderr.is_empty() {
        head
    } else {
        format!("{head}\n\n{}", failure.stderr)
    }
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Start (or reuse) the managed chat engine for `model_path`. Idempotent: if
/// the same model is already loaded and healthy, returns `already_running`.
/// A different model in flight is stopped first (single-process engine).
/// Freeze fix: loading a GGUF takes seconds to a minute, and `wait_for_health`
/// blocks for all of it. As a plain sync `#[command]` that ran on the Tauri main
/// thread, so the whole window sat frozen while the built-in engine started —
/// the same class already fixed for the ComfyUI probes and the custom-node
/// install. The blocking half runs on the blocking pool; the JS caller still
/// awaits exactly as before.
#[tauri::command]
pub async fn start_bundled_engine(
    app: AppHandle,
    model_path: String,
    tuning: Option<EngineTuning>,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        start_bundled_engine_blocking(&app, &state, model_path, tuning, port)
    })
    .await
    .map_err(|e| format!("Engine start task failed to run: {e}"))?
}

fn start_bundled_engine_blocking(
    app: &AppHandle,
    state: &State<'_, AppState>,
    model_path: String,
    tuning: Option<EngineTuning>,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    let _gate = crate::commands::process::start_gate(&crate::commands::process::ENGINE_START);
    let tuning = tuning.unwrap_or_default();
    let port = port.unwrap_or(DEFAULT_ENGINE_PORT);

    if !Path::new(&model_path).exists() {
        return Err(format!("Model file not found: {model_path}"));
    }

    // KV-slot directory next to the built-in models (GH #85). Best effort: a
    // failure here only disables slot save/restore, never the engine itself.
    let slot_dir = builtin_models_dir()
        .ok()
        .and_then(|models| models.parent().map(|p| p.join("kv-slots")))
        .and_then(|dir| {
            std::fs::create_dir_all(&dir).ok()?;
            Some(dir.to_string_lossy().to_string())
        });
    // Vision projector sitting next to the model (written by the Discover
    // download). Present = start multimodal, absent = unchanged text argv.
    let mmproj = existing_mmproj(&model_path);
    let desired_args = build_server_args(&model_path, &tuning, port, slot_dir.as_deref(), mmproj.as_deref());

    // Already serving this exact argv and healthy → no-op. The argv is the
    // idempotence key: a ctx/KV-quant/flash-attn change restarts the server,
    // an identical request reuses the running process.
    {
        let guard = state.bundled_engine.lock().unwrap();
        if let Some(engine) = guard.as_ref() {
            if engine.args == desired_args && engine_healthy(engine.port) {
                return Ok(serde_json::json!({
                    "status": "already_running",
                    "port": engine.port,
                    "model_path": engine.model_path,
                    "ctx": engine.ctx,
                }));
            }
        }
    }

    // Different model (or dead) → stop the old process before spawning.
    stop_engine_locked(state);

    // The port must actually be FREE now: our own previous child (if any) was
    // killed AND reaped above, so anything still answering the health probe is
    // an orphaned or foreign llama-server — left over from a crashed /
    // hard-killed session, or user-run. Spawning against it would LOOK green:
    // the health probe below is answered by the stranger while our child is
    // still loading its model and only later dies on "address already in use"
    // — so chats would silently hit an unknown model with unknown ctx, tuning
    // would never apply, and no shutdown of ours could ever reap it. (Live
    // repro 2026-07-28: an embed server orphaned by a hard-killed dev session
    // made every later start look successful.)
    if engine_healthy(port) {
        return Err(format!(
            "Port {port} is already serving another llama-server that this app does not manage (likely left over from a previous session or crash). Quit that process or reboot, then try again."
        ));
    }

    // Mirror image of the Create-tab handoff: a render leaves ComfyUI's
    // checkpoint cached in VRAM (`includeComfyui:false` keeps it warm between
    // runs). On a single-GPU box the returning chat engine then fights that
    // cache for memory — llama-server with `-ngl 999` loses as a CUDA OOM
    // (RTX 5080 field report: ACE-Step → chat = crash until app restart). Ask
    // ComfyUI to drop its cache first; best-effort no-op when it isn't running.
    if crate::commands::process::free_comfyui_memory() {
        println!("[Engine] asked ComfyUI to free VRAM before engine start");
    }

    // Ollama fights for the same VRAM and, unlike ComfyUI, its freshly-used
    // pages are hot enough that WDDM won't demote them: on a 12 GB 3060 with a
    // just-active 14B loaded, this engine's own load crawled through paging and
    // blew the health budget (live repro 2026-07-31; an IDLE model gets evicted
    // fine). Evict via keep_alive:0 — Ollama reloads lazily on its next use.
    if crate::commands::process::offload_ollama_loaded_models() {
        println!("[Engine] asked Ollama to evict loaded models before engine start");
    }

    let binary = resolve_engine_binary(app).ok_or_else(|| {
        // This used to name a build script. On a user's machine that is not an
        // instruction, it is noise; the only real remedies are a reinstall or a
        // different backend (GH #118).
        format!(
            "The built-in engine program ({}) is missing from this installation. Reinstall Locally Uncensored, or pick a different backend in Settings, AI Backends.",
            sidecar_binary_name()
        )
    })?;

    // Attempt 1, then exactly one clean retry.
    //
    // GH #118 (nayffy, 2026-08-27): the only thing a user ever saw when this
    // chain failed was a refused connection on 127.0.0.1:8127. Two things were
    // wrong with the old shape. The health wait watched only the port, so a
    // child that died in the first second still burned the whole budget (60 s
    // and up, scaled by model size) before saying anything. And a start was
    // one shot: the VRAM this very function asks ComfyUI and Ollama to release
    // is released ASYNCHRONOUSLY, so an engine that lost the race to a driver
    // still holding those pages had no second chance. House rule is
    // self-healing before an error message, so a died-on-start attempt gets
    // one more try after a short settle, and only what survives that becomes a
    // message.
    let deadline = health_timeout_for(&model_path);
    let ctx = effective_ctx(&tuning);
    let first = spawn_engine_attempt(state, &binary, &desired_args, &model_path, port, ctx);
    let failure = match first {
        Ok(()) => {
            println!("[Engine] Built-in engine healthy on port {port}");
            return Ok(serde_json::json!({
                "status": "started",
                "port": port,
                "model_path": model_path,
                "ctx": ctx,
            }));
        }
        Err(f) => f,
    };

    if !failure.died {
        // The budget ran out with the child still alive: it is loading slowly,
        // not failing. Retrying would just spend the budget twice.
        return Err(start_failure_message(&failure, port, deadline));
    }

    println!("[Engine] first start attempt exited immediately, retrying once");
    std::thread::sleep(Duration::from_millis(1500));
    match spawn_engine_attempt(state, &binary, &desired_args, &model_path, port, ctx) {
        Ok(()) => {
            println!("[Engine] Built-in engine healthy on port {port} (second attempt)");
            Ok(serde_json::json!({
                "status": "started",
                "port": port,
                "model_path": model_path,
                "ctx": ctx,
                "retried": true,
            }))
        }
        Err(second) => Err(start_failure_message(&second, port, deadline)),
    }
}

/// What one spawn-and-wait produced when it did not come up.
pub(crate) struct StartFailure {
    /// The child was gone before the health budget ran out. Distinguishes a
    /// crash (retry is worth it) from a slow load (retry is not).
    pub died: bool,
    /// True when the port answered health checks but our own child was dead.
    /// Somebody else owns that port.
    pub port_taken: bool,
    /// llama-server's own last words. Empty when it said nothing.
    pub stderr: String,
}

/// Spawn the engine and wait for it, watching BOTH the health endpoint and the
/// child. Reaps the child on every failure path so no half-loaded server is
/// left behind.
fn spawn_engine_attempt(
    state: &State<'_, AppState>,
    binary: &Path,
    args: &[String],
    model_path: &str,
    port: u16,
    ctx: u32,
) -> Result<(), StartFailure> {
    println!("[Engine] Starting built-in llama-server on port {port}, model {model_path}");
    let mut cmd = Command::new(binary);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // llama-server writes the REASON a start fails here: a GGUF it refuses,
        // a quant this build has no kernel for, a port already taken, too little
        // VRAM. Sending it to /dev/null left the user with "did not become
        // healthy", which names no cause at all. Drained on its own thread so
        // the pipe can never fill and stall the server (see commands/shell.rs).
        .stderr(Stdio::piped());
    // Forward the user's GPU pick (CUDA/HIP/OneAPI) exactly like start_ollama;
    // no-op in the default "auto" mode. On mac this is inert (Metal).
    if let Ok(sel) = state.gpu_selection.lock() {
        crate::commands::gpu::apply_gpu_env(&mut cmd, &sel);
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Err(StartFailure {
                died: true,
                port_taken: false,
                stderr: format!("Failed to spawn bundled engine: {}", os_error::english(&e)),
            })
        }
    };
    let diagnostics = child.stderr.take().map(super::shell::drain);

    *state.bundled_engine.lock().unwrap() = Some(BundledEngine {
        child,
        model_path: model_path.to_string(),
        port,
        ctx: Some(ctx),
        args: args.to_vec(),
    });

    let outcome = wait_for_health_or_exit(&**state, port, health_timeout_for(model_path));
    if matches!(outcome, HealthWait::Ready) {
        // Health said OK, but was it OUR child that answered? A spawn that
        // loses the port to an orphaned llama-server (left behind by a crashed
        // or hard-killed session) dies on "address already in use" within
        // milliseconds, and the probe then hits the STRANGER: unknown model,
        // unknown ctx, tuning that silently never applies, and a process no
        // shutdown of ours can ever reap. Fail honestly instead of adopting
        // it. (Live repro 2026-07-28: an embed server orphaned by a previous
        // dev session made every later start look green.)
        let ours_alive = {
            let mut guard = state.bundled_engine.lock().unwrap();
            match guard.as_mut() {
                Some(e) => e.child.try_wait().ok().flatten().is_none(),
                None => false,
            }
        };
        if ours_alive {
            return Ok(());
        }
        let why = diagnostics
            .map(|(buf, _)| tail_lines(&super::shell::captured_text(&buf), 12))
            .unwrap_or_default();
        stop_engine_locked(state);
        return Err(StartFailure { died: true, port_taken: true, stderr: why });
    }

    let why = diagnostics
        .map(|(buf, _)| tail_lines(&super::shell::captured_text(&buf), 12))
        .unwrap_or_default();
    stop_engine_locked(state);
    Err(StartFailure {
        died: matches!(outcome, HealthWait::ChildExited),
        port_taken: false,
        stderr: why,
    })
}

/// Stop the managed engine, killing the child. Idempotent.
#[tauri::command]
pub async fn stop_bundled_engine(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // kill + wait on a server that is mid-load is not instant.
        let state = app.state::<AppState>();
        let was_running = stop_engine_locked(&state);
        serde_json::json!({ "status": if was_running { "stopped" } else { "idle" } })
    })
    .await
    .map_err(|e| format!("Engine stop task failed to run: {e}"))
}

/// Report whether the engine is up, which model, on which port, and a live
/// health probe. `running` reflects the child handle; `healthy` the HTTP probe
/// (they diverge briefly during cold load).
/// Async because of the health probe: it is a blocking HTTP call with a 400 ms
/// timeout, and the UI polls this. On the main thread that was a stutter on
/// every poll and a 400 ms stall whenever the engine was starting or gone.
#[tauri::command]
pub async fn bundled_engine_status(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let probe = {
            let guard = state.bundled_engine.lock().unwrap();
            guard.as_ref().map(|e| (e.port, e.model_path.clone(), e.ctx))
        };
        match probe {
            Some((port, model_path, ctx)) => serde_json::json!({
                "running": true,
                "healthy": engine_healthy(port),
                "port": port,
                // Model file size feeds the handoff's fits/doesn't-fit call
                // (GH #85): a GGUF's on-disk size is a close proxy for its
                // VRAM footprint at full offload.
                "modelBytes": std::fs::metadata(&model_path).map(|m| m.len()).unwrap_or(0),
                "model_path": model_path,
                "ctx": ctx,
            }),
            None => serde_json::json!({
                "running": false,
                "healthy": false,
                "port": DEFAULT_ENGINE_PORT,
                "model_path": null,
                "ctx": null,
            }),
        }
    })
    .await
    .map_err(|e| format!("Engine status task failed to run: {e}"))
}

/// Swap the loaded model: stop the current process and start `model_path` on
/// the same port. Thin wrapper over `start_bundled_engine` (which already
/// stops a mismatched model), kept as a distinct command so the intent reads
/// clearly at the call site and the port is preserved.
#[tauri::command]
pub async fn swap_bundled_model(
    app: AppHandle,
    model_path: String,
    tuning: Option<EngineTuning>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let port = state
            .bundled_engine
            .lock()
            .unwrap()
            .as_ref()
            .map(|e| e.port)
            .unwrap_or(DEFAULT_ENGINE_PORT);
        start_bundled_engine_blocking(&app, &state, model_path, tuning, Some(port))
    })
    .await
    .map_err(|e| format!("Engine swap task failed to run: {e}"))?
}

/// List `*.gguf` files in the built-in models dir, marking the one currently
/// loaded. Used by the frontend instead of `/v1/models` (which would only
/// report the single loaded model).
// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread.
// The State borrow cannot cross into the blocking pool, so the handle is
// re-resolved there from the AppHandle (same pattern as engine.rs/whisper.rs).
#[tauri::command]
pub async fn list_bundled_models(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        list_bundled_models_blocking(&state)
    })
    .await
    .map_err(|e| format!("list_bundled_models task: {e}"))?
}

fn list_bundled_models_blocking(state: &AppState) -> Result<serde_json::Value, String> {
    let dir = builtin_models_dir()?;
    let loaded = state
        .bundled_engine
        .lock()
        .unwrap()
        .as_ref()
        .map(|e| e.model_path.clone());
    let models: Vec<serde_json::Value> = scan_gguf_models(&dir)
        .into_iter()
        .map(|m| {
            let is_loaded = loaded.as_deref() == Some(m.path.as_str());
            // Trained context limit from the GGUF header (ENG-6c) — the ONLY
            // place it exists; /props and /v1/models don't carry it. None on
            // any parse hiccup so a weird file can never break the listing.
            let ctx_train = crate::commands::gguf::context_length(&m.path);
            serde_json::json!({
                "name": m.name,
                "path": m.path,
                "size": m.size,
                "loaded": is_loaded,
                "ctx_train": ctx_train,
            })
        })
        .collect();
    Ok(serde_json::json!({
        "dir": dir.to_string_lossy(),
        "models": models,
    }))
}

// ── Import from other local tools (Ollama, LM Studio) ───────────────────────
// Discord feedback 2026-08-16: "how do I bring my existing models along?"
// Ollama blobs and LM Studio downloads ARE plain GGUFs, so the answer is a
// hard link into the built-in models dir: zero copy, zero download, the file
// keeps living in the original store and both tools stay functional.

/// A GGUF found in another local tool's store that the built-in engine could
/// use via a hard link.
#[derive(Debug, Clone, Serialize)]
pub struct ImportCandidate {
    pub name: String,
    pub source: String,
    pub path: String,
    pub size: u64,
    pub already_imported: bool,
}

/// File name a candidate gets inside the built-in models dir. Tag colons,
/// separators and spaces become dashes, everything outside [A-Za-z0-9._-] is
/// dropped, leading dots and dashes are trimmed so a hostile name can never
/// escape the folder, and the result always ends in .gguf.
pub(crate) fn sanitize_model_file_name(name: &str) -> String {
    let mut base: String = name
        .chars()
        .map(|c| match c {
            ':' | '/' | '\\' | ' ' => '-',
            other => other,
        })
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();
    base = base.trim_matches(|c| c == '.' || c == '-').to_string();
    if base.is_empty() {
        base = "model".to_string();
    }
    if base.to_ascii_lowercase().ends_with(".gguf") {
        base
    } else {
        format!("{base}.gguf")
    }
}

/// Digest of the layer that carries the actual weights in an Ollama manifest,
/// mediaType application/vnd.ollama.image.model. None when the JSON does not
/// parse or no such layer exists (the other layers are template, params,
/// license and so on).
pub(crate) fn ollama_manifest_model_digest(manifest_json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(manifest_json).ok()?;
    let layers = v.get("layers")?.as_array()?;
    layers.iter().find_map(|l| {
        let mt = l.get("mediaType")?.as_str()?;
        if mt != "application/vnd.ollama.image.model" {
            return None;
        }
        l.get("digest")?.as_str().map(str::to_string)
    })
}

/// Walk an Ollama store (default ~/.ollama/models). Every file under
/// manifests/ is registry/namespace/repo/tag, the weights sit in blobs/ under
/// the digest with the colon flattened to a dash. A manifest whose blob is
/// missing is skipped, so a half pulled model never shows up as importable.
pub(crate) fn scan_ollama_models(root: &Path) -> Vec<ImportCandidate> {
    let mut out = Vec::new();
    let mut stack = vec![root.join("manifests")];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let manifest = match std::fs::read_to_string(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let Some(digest) = ollama_manifest_model_digest(&manifest) else {
                continue;
            };
            let blob = root.join("blobs").join(digest.replace(':', "-"));
            let Ok(meta) = std::fs::metadata(&blob) else {
                continue;
            };
            let tag = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            let repo = path
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|s| s.to_str())
                .unwrap_or("");
            if tag.is_empty() || repo.is_empty() {
                continue;
            }
            out.push(ImportCandidate {
                name: format!("{repo}-{tag}"),
                source: "ollama".to_string(),
                path: blob.to_string_lossy().to_string(),
                size: meta.len(),
                already_imported: false,
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Walk an LM Studio store recursively for *.gguf files
/// (models/publisher/repo/file.gguf). Case-insensitive on the extension,
/// same as scan_gguf_models.
pub(crate) fn scan_lmstudio_models(root: &Path) -> Vec<ImportCandidate> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let is_gguf = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("gguf"))
                .unwrap_or(false);
            if !is_gguf {
                continue;
            }
            // A projector is not a model. It rides along with its model in
            // import_model_file instead of being offered as its own import.
            if path
                .file_name()
                .and_then(|s| s.to_str())
                .map(is_projector_file)
                .unwrap_or(false)
            {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(ImportCandidate {
                name: stem.to_string(),
                source: "lmstudio".to_string(),
                path: path.to_string_lossy().to_string(),
                size,
                already_imported: false,
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Hard link src into dest_dir under the sanitized name. Deliberately no copy
/// fallback: a copy would eat the disk twice for a 10 GB model, and the error
/// tells the user the honest way out (same drive, or move the models folder).
pub(crate) fn import_model_file(src: &Path, dest_dir: &Path, name: &str) -> Result<PathBuf, String> {
    if !src.is_file() {
        return Err(format!("Source model not found: {}", src.display()));
    }
    let target = dest_dir.join(sanitize_model_file_name(name));
    if target.exists() {
        return Err(format!(
            "A model named {} already exists in the built-in models folder",
            target.file_name().and_then(|s| s.to_str()).unwrap_or("?")
        ));
    }
    std::fs::hard_link(src, &target).map_err(|e| {
        format!(
            "Could not link the model into the built-in folder ({e}). \
             Linking needs source and destination on the same drive. \
             Move the models folder (Settings, Model Storage) to that drive, \
             or copy the file there yourself."
        )
    })?;
    // A vision model without its projector loads and answers but cannot see, so
    // the projector comes along. Best effort: the model is already linked and
    // usable, and a missing projector is exactly what a text-only model looks
    // like. (Ollama sources are content-addressed blobs with no sibling to
    // find; those import text-only, which is why vision models are worth
    // pulling through Ollama itself.)
    if let Some(projector) = find_projector_sibling(src) {
        let _ = std::fs::hard_link(&projector, mmproj_sibling_path(&target.to_string_lossy()));
    }
    Ok(target)
}

/// The projector belonging to a model file in another tool's store. Prefers our
/// own `<stem>.mmproj.gguf` naming, then falls back to a single upstream
/// `mmproj*.gguf` in the same folder (LM Studio keeps one repo per folder). Two
/// or more candidates mean guessing, and a wrong projector is worse than none.
fn find_projector_sibling(model: &Path) -> Option<PathBuf> {
    let exact = mmproj_sibling_path(&model.to_string_lossy());
    if exact.is_file() {
        return Some(exact);
    }
    let dir = model.parent()?;
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|s| s.to_str())
                    .map(is_projector_file)
                    .unwrap_or(false)
        })
        .collect();
    found.sort();
    if found.len() == 1 {
        found.pop()
    } else {
        None
    }
}

/// GGUFs found in local Ollama and LM Studio stores, ready to link into the
/// built-in engine. Candidates whose target file already exists are flagged
/// instead of hidden so the UI can show them as done.
#[tauri::command]
pub async fn list_importable_models() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(|| {
        let dest = builtin_models_dir()?;
        let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
        let mut all = scan_ollama_models(&home.join(".ollama").join("models"));
        let lm_primary = home.join(".lmstudio").join("models");
        let lm = if lm_primary.is_dir() {
            lm_primary
        } else {
            home.join(".cache").join("lm-studio").join("models")
        };
        all.extend(scan_lmstudio_models(&lm));
        for c in &mut all {
            c.already_imported = dest.join(sanitize_model_file_name(&c.name)).exists();
        }
        Ok(serde_json::json!({ "candidates": all }))
    })
    .await
    .map_err(|e| format!("list_importable_models task: {e}"))?
}

/// Link one candidate into the built-in models dir (zero copy hard link).
/// The next list_bundled_models picks it up like any downloaded GGUF.
#[tauri::command]
pub async fn import_local_model(path: String, name: String) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let dest = builtin_models_dir()?;
        let target = import_model_file(Path::new(&path), &dest, &name)?;
        Ok(serde_json::json!({ "path": target.to_string_lossy() }))
    })
    .await
    .map_err(|e| format!("import_local_model task: {e}"))?
}

/// Kill the managed engine child if present. Returns whether one was running.
/// Takes the state lock internally; callers must not already hold it.
pub(crate) fn stop_engine_locked(state: &AppState) -> bool {
    let mut guard = state.bundled_engine.lock().unwrap();
    if let Some(mut engine) = guard.take() {
        let _ = engine.child.kill();
        let _ = engine.child.wait();
        println!("[Engine] Built-in engine stopped (port {})", engine.port);
        true
    } else {
        false
    }
}

// ── Embeddings server (P5) ────────────────────────────────────────────────────
//
// A second `llama-server` in `--embeddings` mode on its own port. Same
// lifecycle shape as the chat engine (spawn → health-wait → stop), reusing
// `resolve_engine_binary` / `wait_for_health` / `engine_healthy` (all
// port-generic). Document-Chat / RAG POST to `/v1/embeddings` on this port
// instead of Ollama's `/api/embed`, so the RAG path is Ollama-free.

/// Start (or reuse) the managed embeddings server for `model_path`. Idempotent
/// for the same model + healthy. A different embed model in flight is stopped
/// first (single-process server).
#[tauri::command]
pub async fn start_bundled_embed(
    app: AppHandle,
    model_path: String,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        start_bundled_embed_blocking(&app, &state, model_path, port)
    })
    .await
    .map_err(|e| format!("Embeddings start task failed to run: {e}"))?
}

fn start_bundled_embed_blocking(
    app: &AppHandle,
    state: &State<'_, AppState>,
    model_path: String,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    let _gate = crate::commands::process::start_gate(&crate::commands::process::EMBED_START);
    let port = port.unwrap_or(DEFAULT_EMBED_PORT);

    if !Path::new(&model_path).exists() {
        return Err(format!("Embedding model file not found: {model_path}"));
    }

    // Already serving this exact model and healthy → no-op.
    {
        let guard = state.bundled_embed.lock().unwrap();
        if let Some(embed) = guard.as_ref() {
            if embed.model_path == model_path && engine_healthy(embed.port) {
                return Ok(serde_json::json!({
                    "status": "already_running",
                    "port": embed.port,
                    "model_path": embed.model_path,
                }));
            }
        }
    }

    stop_embed_locked(state);

    // Same stranger-on-the-port refusal as the chat engine (see there for the
    // full story): a health answer on a port we hold no child for is an
    // orphan/foreign server, and spawning against it only looks like success.
    if engine_healthy(port) {
        return Err(format!(
            "Port {port} is already serving another llama-server that this app does not manage (likely left over from a previous session or crash). Quit that process or reboot, then try again."
        ));
    }

    let binary = resolve_engine_binary(app).ok_or_else(|| {
        format!(
            "Bundled engine binary not found ({}). Run scripts/build-llama.sh to produce the sidecar.",
            sidecar_binary_name()
        )
    })?;

    println!("[Engine] Starting built-in embeddings server on port {port}, model {model_path}");
    let mut cmd = Command::new(&binary);
    cmd.args(build_embed_args(&model_path, port))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Ok(sel) = state.gpu_selection.lock() {
        crate::commands::gpu::apply_gpu_env(&mut cmd, &sel);
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn embeddings server: {}", os_error::english(&e)))?;
    let diagnostics = child.stderr.take().map(super::shell::drain);

    *state.bundled_embed.lock().unwrap() = Some(BundledEngine {
        child,
        model_path: model_path.clone(),
        port,
        // No --ctx-size on the embed server; args recorded for symmetry (its
        // idempotence check stays model_path-based, embeds have no tuning).
        ctx: None,
        args: build_embed_args(&model_path, port),
    });

    if let Err(e) = wait_for_health(port, health_timeout_for(&model_path)) {
        let why = diagnostics
            .map(|(buf, _)| tail_lines(&super::shell::captured_text(&buf), 12))
            .unwrap_or_default();
        stop_embed_locked(state);
        return Err(if why.is_empty() { e } else { format!("{e}\n\n{why}") });
    }

    // Same stranger-on-the-port guard as the chat engine: a healthy probe is
    // only proof of SOME server on the port. If our spawn already exited, the
    // answerer is an orphan/foreign process — embeddings would come from an
    // unknown model and our shutdown could never reap it.
    let spawn_died = {
        let mut guard = state.bundled_embed.lock().unwrap();
        match guard.as_mut() {
            Some(e) => e.child.try_wait().ok().flatten().is_some(),
            None => true,
        }
    };
    if spawn_died {
        let why = diagnostics
            .map(|(buf, _)| tail_lines(&super::shell::captured_text(&buf), 12))
            .unwrap_or_default();
        stop_embed_locked(state);
        return Err(format!(
            "Port {port} answers health checks, but the embeddings server this app just started exited immediately — another llama-server (likely left over from a previous session or crash) is occupying the port. Quit that process or reboot, then try again.{}",
            if why.is_empty() { String::new() } else { format!("\n\n{why}") }
        ));
    }

    println!("[Engine] Built-in embeddings server healthy on port {port}");
    Ok(serde_json::json!({
        "status": "started",
        "port": port,
        "model_path": model_path,
    }))
}

/// Stop the managed embeddings server, killing the child. Idempotent.
#[tauri::command]
pub async fn stop_bundled_embed(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let was_running = stop_embed_locked(&state);
        serde_json::json!({ "status": if was_running { "stopped" } else { "idle" } })
    })
    .await
    .map_err(|e| format!("Embeddings stop task failed to run: {e}"))
}

/// Report whether the embeddings server is up, which model, on which port.
#[tauri::command]
pub async fn bundled_embed_status(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // Probe OUTSIDE the lock: holding it across a blocking HTTP call made
        // every other engine command queue behind the status poll.
        let probe = {
            let guard = state.bundled_embed.lock().unwrap();
            guard.as_ref().map(|e| (e.port, e.model_path.clone()))
        };
        match probe {
            Some((port, model_path)) => serde_json::json!({
                "running": true,
                "healthy": engine_healthy(port),
                "port": port,
                "model_path": model_path,
            }),
            None => serde_json::json!({
                "running": false,
                "healthy": false,
                "port": DEFAULT_EMBED_PORT,
                "model_path": null,
            }),
        }
    })
    .await
    .map_err(|e| format!("Embeddings status task failed to run: {e}"))
}

/// Kill the managed embeddings child if present. Returns whether one was
/// running. Takes the state lock internally; callers must not already hold it.
pub(crate) fn stop_embed_locked(state: &AppState) -> bool {
    let mut guard = state.bundled_embed.lock().unwrap();
    if let Some(mut embed) = guard.take() {
        let _ = embed.child.kill();
        let _ = embed.child.wait();
        println!("[Engine] Built-in embeddings server stopped (port {})", embed.port);
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_timeout_scales_with_model_size_and_caps() {
        assert_eq!(health_timeout_for_bytes(0), Duration::from_secs(60));
        // 0.5 GiB rounds down to the 60s base.
        assert_eq!(health_timeout_for_bytes(536_870_912), Duration::from_secs(60));
        assert_eq!(health_timeout_for_bytes(8 * 1_073_741_824), Duration::from_secs(92));
        assert_eq!(health_timeout_for_bytes(40 * 1_073_741_824), Duration::from_secs(220));
        // Absurd sizes hit the 10-minute cap instead of overflowing.
        assert_eq!(health_timeout_for_bytes(u64::MAX), Duration::from_secs(600));
    }

    #[test]
    fn slot_save_dir_appends_the_flag_and_none_stays_legacy() {
        // GH #85: the KV-slot flag rides at the end so every earlier pin holds.
        let with = build_server_args("/m.gguf", &EngineTuning::default(), 8127, Some("/data/kv-slots"), None);
        let tail: Vec<&str> = with.iter().rev().take(2).map(String::as_str).collect();
        assert_eq!(tail, vec!["/data/kv-slots", "--slot-save-path"]);
        let without = build_server_args("/m.gguf", &EngineTuning::default(), 8127, None, None);
        assert!(!without.iter().any(|a| a == "--slot-save-path"));
    }

    #[test]
    fn default_tuning_args_match_legacy_shape() {
        // Pin: absent/default tuning must produce EXACTLY the argv the app has
        // shipped since 2.5.7 — expert settings are opt-in, never a drift.
        let args = build_server_args("/models/qwen.gguf", &EngineTuning::default(), 8127, None, None);
        assert_eq!(
            args,
            vec![
                "-m", "/models/qwen.gguf",
                "--host", "127.0.0.1",
                "--port", "8127",
                "--ctx-size", "8192",
                "-ngl", "999",
            ]
        );
    }

    #[test]
    fn mmproj_rides_the_argv_only_when_a_projector_exists() {
        let with = build_server_args(
            "/models/qwen3.8.gguf",
            &EngineTuning::default(),
            8127,
            None,
            Some("/models/qwen3.8.mmproj.gguf"),
        );
        let at = with.iter().position(|a| a == "--mmproj").expect("--mmproj missing");
        assert_eq!(with[at + 1], "/models/qwen3.8.mmproj.gguf");
        // Negative control: a model without a projector keeps the legacy argv,
        // so a text-only model can never gain a flag it cannot honour.
        let without = build_server_args("/models/qwen3.8.gguf", &EngineTuning::default(), 8127, None, None);
        assert!(!without.iter().any(|a| a == "--mmproj"));
        assert_eq!(without.len(), with.len() - 2);
    }

    #[test]
    fn mmproj_stays_ahead_of_the_slot_save_flag() {
        // The KV-slot flag is pinned to the tail (GH #85); the projector has to
        // slot in before it or that pin breaks.
        let args = build_server_args(
            "/m.gguf",
            &EngineTuning::default(),
            8127,
            Some("/data/kv-slots"),
            Some("/m.mmproj.gguf"),
        );
        let tail: Vec<&str> = args.iter().rev().take(2).map(String::as_str).collect();
        assert_eq!(tail, vec!["/data/kv-slots", "--slot-save-path"]);
        assert!(args.iter().any(|a| a == "--mmproj"));
    }

    #[test]
    fn mmproj_sibling_path_follows_the_model_name() {
        assert_eq!(
            mmproj_sibling_path("/models/Qwen3.8-27B-UD-Q4_K_M.gguf"),
            PathBuf::from("/models/Qwen3.8-27B-UD-Q4_K_M.mmproj.gguf")
        );
        // Upper-case extension is the same file to the OS on mac/Windows.
        assert_eq!(
            mmproj_sibling_path("/models/A.GGUF"),
            PathBuf::from("/models/A.mmproj.gguf")
        );
        // Dots inside the name must survive: file_stem would cut at ".8".
        assert_eq!(
            mmproj_sibling_path("/models/qwen3.8-27b.gguf"),
            PathBuf::from("/models/qwen3.8-27b.mmproj.gguf")
        );
    }

    #[test]
    fn import_takes_the_projector_along_and_leaves_text_models_alone() {
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        // Vision model in an LM Studio style folder: model plus upstream mmproj.
        std::fs::write(src.path().join("Qwen3.8-27B-UD-Q4_K_M.gguf"), b"weights").unwrap();
        std::fs::write(src.path().join("mmproj-F16.gguf"), b"projector").unwrap();
        let target = import_model_file(
            &src.path().join("Qwen3.8-27B-UD-Q4_K_M.gguf"),
            dest.path(),
            "Qwen3.8-27B-UD-Q4_K_M.gguf",
        )
        .unwrap();
        assert!(target.is_file());
        assert!(dest.path().join("Qwen3.8-27B-UD-Q4_K_M.mmproj.gguf").is_file());
        // The projector must not be offered as a model of its own.
        assert!(!scan_gguf_models(dest.path()).iter().any(|m| m.name.contains("mmproj")));
        assert_eq!(scan_gguf_models(dest.path()).len(), 1);

        // Negative control: a text-only model imports without inventing one.
        let plain = tempfile::tempdir().unwrap();
        std::fs::write(plain.path().join("text.gguf"), b"weights").unwrap();
        let dest2 = tempfile::tempdir().unwrap();
        import_model_file(&plain.path().join("text.gguf"), dest2.path(), "text.gguf").unwrap();
        assert!(!dest2.path().join("text.mmproj.gguf").exists());
    }

    #[test]
    fn an_ambiguous_projector_is_left_alone() {
        // Two projectors in one folder means guessing; a wrong image tower is
        // worse than a model that is honestly text-only.
        let src = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("m.gguf"), b"weights").unwrap();
        std::fs::write(src.path().join("mmproj-F16.gguf"), b"a").unwrap();
        std::fs::write(src.path().join("mmproj-BF16.gguf"), b"b").unwrap();
        assert!(find_projector_sibling(&src.path().join("m.gguf")).is_none());
        // The exact-name convention still wins over the ambiguous pair.
        std::fs::write(src.path().join("m.mmproj.gguf"), b"c").unwrap();
        assert_eq!(
            find_projector_sibling(&src.path().join("m.gguf")),
            Some(src.path().join("m.mmproj.gguf"))
        );
    }

    #[test]
    fn projectors_are_not_offered_as_models() {
        assert!(is_projector_file("Qwen3.8-27B-UD-Q4_K_M.mmproj.gguf"));
        assert!(is_projector_file("mmproj-F16.gguf"));
        assert!(is_projector_file("mmproj-model-bf16.gguf"));
        assert!(!is_projector_file("Qwen3.8-27B-UD-Q4_K_M.gguf"));
        assert!(!is_projector_file("Huihui-Qwen3.8-27B-abliterated-Q4_K.gguf"));
    }

    #[test]
    fn expert_tuning_adds_all_flags_in_stable_order() {
        let tuning = EngineTuning {
            ctx: 16384,
            flash_attn: "on".into(),
            cache_type_k: "q8_0".into(),
            cache_type_v: "q8_0".into(),
            threads: 8,
            gpu_layers: 20,
            mlock: true,
            no_mmap: true,
        };
        let args = build_server_args("/m.gguf", &tuning, 8127, None, None);
        assert_eq!(
            args,
            vec![
                "-m", "/m.gguf",
                "--host", "127.0.0.1",
                "--port", "8127",
                "--ctx-size", "16384",
                "-ngl", "20",
                "-fa", "on",
                "-ctk", "q8_0",
                "-ctv", "q8_0",
                "-t", "8",
                "--mlock",
                "--no-mmap",
            ]
        );
    }

    #[test]
    fn junk_tuning_values_fall_back_to_legacy_argv() {
        // Settings files are user-editable JSON — junk enum strings must be
        // dropped (binary defaults), never passed through to the argv.
        let tuning = EngineTuning {
            ctx: 0,
            flash_attn: "banana".into(),
            cache_type_k: "'; rm -rf /".into(),
            cache_type_v: "zzz".into(),
            threads: -4,
            gpu_layers: -1,
            mlock: false,
            no_mmap: false,
        };
        let args = build_server_args("/m.gguf", &tuning, 8127, None, None);
        assert_eq!(
            args,
            vec![
                "-m", "/m.gguf",
                "--host", "127.0.0.1",
                "--port", "8127",
                "--ctx-size", "8192",
                "-ngl", "999",
            ]
        );
    }

    #[test]
    fn gpu_layers_zero_means_cpu_only_not_all() {
        let tuning = EngineTuning { gpu_layers: 0, ..Default::default() };
        let args = build_server_args("/m.gguf", &tuning, 8127, None, None);
        let ngl = args.iter().position(|a| a == "-ngl").unwrap();
        assert_eq!(args[ngl + 1], "0");
    }

    #[test]
    fn partial_tuning_json_deserializes_with_defaults() {
        // The frontend sends partial objects ({ctx: 16384}); serde(default)
        // must fill the rest so a partial settings write never breaks starts.
        let t: EngineTuning = serde_json::from_str(r#"{"ctx":16384,"cacheTypeK":"q8_0"}"#).unwrap();
        assert_eq!(t.ctx, 16384);
        assert_eq!(t.cache_type_k, "q8_0");
        assert_eq!(t.flash_attn, "auto");
        assert_eq!(t.gpu_layers, -1);
    }

    #[test]
    fn embed_args_enable_embeddings_and_mean_pooling() {
        let args = build_embed_args("/models/nomic-embed.gguf", 8128);
        assert_eq!(
            args,
            vec![
                "-m", "/models/nomic-embed.gguf",
                "--host", "127.0.0.1",
                "--port", "8128",
                "--embeddings",
                "--pooling", "mean",
                "-ngl", "999",
                "-b", "2048",
                "-ub", "2048",
            ]
        );
        // The whole point of P5: the embed server must NOT carry --ctx-size
        // (chat-only) and MUST carry --embeddings so /v1/embeddings works.
        assert!(args.iter().any(|a| a == "--embeddings"));
        assert!(!args.iter().any(|a| a == "--ctx-size"));
    }

    /// D#91: the default physical batch is 512 tokens and one chunk is one
    /// batch, so a document with long unbroken passages failed to index with
    /// "input (658 tokens) is too large to process".
    #[test]
    fn embed_args_raise_the_physical_batch_past_the_512_default() {
        let args = build_embed_args("/models/nomic-embed.gguf", 8128);
        for flag in ["-b", "-ub"] {
            let at = args.iter().position(|a| a == flag).unwrap_or_else(|| panic!("{flag} missing"));
            let value: u32 = args[at + 1].parse().expect("batch size is a number");
            assert!(value > 512, "{flag} must clear the 512 default, got {value}");
        }
    }

    #[test]
    fn host_triple_is_platform_shaped() {
        let t = host_target_triple();
        if cfg!(target_os = "macos") {
            assert!(t.ends_with("-apple-darwin"), "got {t}");
        } else if cfg!(target_os = "windows") {
            assert!(t.ends_with("-pc-windows-msvc"), "got {t}");
        } else {
            assert!(t.ends_with("-unknown-linux-gnu"), "got {t}");
        }
    }

    #[test]
    fn sidecar_name_has_exe_only_on_windows() {
        let name = sidecar_binary_name();
        if cfg!(target_os = "windows") {
            assert_eq!(name, "lu-llama-server.exe");
        } else {
            assert_eq!(name, "lu-llama-server");
        }
    }

    #[test]
    fn the_bundled_sidecar_name_is_ours_and_not_one_debian_already_owns() {
        // GitHub #120 (AnnSdf1969, Ubuntu 26.04): Tauri's deb bundler copies
        // every externalBin straight into /usr/bin, so the file name IS the
        // system path. Debian's own llama.cpp-tools package owns
        // /usr/bin/llama-server, and dpkg refused the entire LU install over
        // it. Two things have to hold, and both are checked from the shipped
        // config rather than from a second copy of the string: the name the
        // config bundles is the name this code looks for, and it is not a
        // name the distro package already claims.
        let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
            .expect("tauri.conf.json parses");
        let names: Vec<&str> = conf["bundle"]["externalBin"]
            .as_array()
            .expect("bundle.externalBin is an array")
            .iter()
            .filter_map(|b| b.as_str())
            .map(|b| b.rsplit('/').next().unwrap_or(b))
            .collect();
        let name = sidecar_binary_name();
        let stem = name.strip_suffix(".exe").unwrap_or(name);
        assert!(
            names.contains(&stem),
            "the config bundles {names:?} but the app looks for {stem}",
        );
        // Negative control: the four binaries Debian's llama.cpp-tools puts
        // in /usr/bin. None of them may be a name we bundle.
        for owned in ["llama-server", "llama-cli", "llama-bench", "llama-quantize"] {
            assert!(
                !names.contains(&owned),
                "{owned} is owned by llama.cpp-tools in /usr/bin, dpkg would refuse the install",
            );
        }
    }

    #[test]
    fn scan_finds_gguf_marks_none_loaded_and_ignores_others() {
        let dir = std::env::temp_dir().join(format!("lu-engine-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("alpha.gguf"), b"x").unwrap();
        std::fs::write(dir.join("Beta.GGUF"), b"yy").unwrap();
        std::fs::write(dir.join("notes.txt"), b"zzz").unwrap();
        std::fs::write(dir.join("model.bin"), b"w").unwrap();

        let models = scan_gguf_models(&dir);
        let names: Vec<&str> = models.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["Beta", "alpha"]); // sorted, case-insensitive ext
        assert_eq!(models[1].size, 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    // ── GH #118 ────────────────────────────────────────────────────────────

    #[test]
    fn scan_finds_a_model_the_broken_routing_nested_under_user_and_repo() {
        // The exact shape a v2.6.6 fresh install produced: no active chat
        // model, so the LM Studio branch wrote the GGUF two levels down and
        // the flat scan reported an empty models folder while a 8 GB file sat
        // right there (nayffy, 2026-08-27).
        let dir = std::env::temp_dir().join(format!("lu-engine-nested-{}", std::process::id()));
        let nested = dir.join("TheDrummer").join("Cydonia-24B-v4.1-GGUF");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("Cydonia-24B-v4.1-Q4_K_M.gguf"), b"aaaa").unwrap();

        let models = scan_gguf_models(&dir);
        assert_eq!(models.len(), 1, "the nested model must be listed");
        assert_eq!(models[0].name, "Cydonia-24B-v4.1-Q4_K_M");
        assert!(models[0].path.ends_with("Cydonia-24B-v4.1-Q4_K_M.gguf"));
        assert_eq!(models[0].size, 4);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_stops_below_two_levels_and_prefers_the_flat_copy() {
        let dir = std::env::temp_dir().join(format!("lu-engine-depth-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Flat copy: the canonical location, and the one the picker must get.
        std::fs::write(dir.join("dup.gguf"), b"a").unwrap();
        let nested = dir.join("user").join("repo");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("dup.gguf"), b"bb").unwrap();
        // Three levels down is out of reach on purpose.
        let deep = dir.join("a").join("b").join("c");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("toodeep.gguf"), b"ccc").unwrap();

        let models = scan_gguf_models(&dir);
        let names: Vec<&str> = models.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["dup"], "one id per name, nothing from level 3");
        assert!(
            !models[0].path.contains("user"),
            "the flat copy wins: {}",
            models[0].path
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn shard_sets_in_different_folders_never_merge() {
        // Two halves of the same base name in two repos are two broken sets,
        // not one complete one. Merging them would offer a model that cannot
        // load, which is the rule a9ea114 established for MLX downloads.
        let dir = std::env::temp_dir().join(format!("lu-engine-shardsplit-{}", std::process::id()));
        let one = dir.join("userA").join("repo");
        let two = dir.join("userB").join("repo");
        std::fs::create_dir_all(&one).unwrap();
        std::fs::create_dir_all(&two).unwrap();
        std::fs::write(one.join("Big-00001-of-00002.gguf"), b"a").unwrap();
        std::fs::write(two.join("Big-00002-of-00002.gguf"), b"b").unwrap();

        assert!(scan_gguf_models(&dir).is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A port nothing on this machine serves, so `engine_healthy` answers
    /// "refused" immediately instead of talking to a real engine.
    const DEAD_PORT: u16 = 49871;

    fn park_child(state: &AppState, child: std::process::Child) {
        *state.bundled_engine.lock().unwrap() = Some(BundledEngine {
            child,
            model_path: "/tmp/does-not-matter.gguf".into(),
            port: DEAD_PORT,
            ctx: Some(8192),
            args: Vec::new(),
        });
    }

    #[test]
    #[cfg_attr(target_os = "windows", ignore = "uses sh")]
    fn a_child_that_dies_on_start_is_reported_at_once_and_not_after_the_budget() {
        // GH #118: the health wait watched only the port, so an engine that
        // exited in the first second (a missing runtime library, a GPU backend
        // that will not initialise) still burned the whole budget before the
        // user was told anything. The budget here is 30s; the answer has to
        // arrive in a fraction of that.
        let state = AppState::new();
        let child = std::process::Command::new("sh")
            .args(["-c", "exit 3"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a child that exits immediately");
        park_child(&state, child);

        let began = Instant::now();
        let out = wait_for_health_or_exit(&state, DEAD_PORT, Duration::from_secs(30));
        let took = began.elapsed();

        assert_eq!(out, HealthWait::ChildExited);
        assert!(took < Duration::from_secs(5), "waited {took:?}, which is the old dead wait");
    }

    #[test]
    fn an_empty_engine_slot_is_not_something_to_wait_for() {
        let state = AppState::new();
        let began = Instant::now();
        assert_eq!(
            wait_for_health_or_exit(&state, DEAD_PORT, Duration::from_secs(30)),
            HealthWait::ChildExited
        );
        assert!(began.elapsed() < Duration::from_secs(5));
    }

    #[test]
    #[cfg_attr(target_os = "windows", ignore = "uses sleep")]
    fn a_child_that_is_still_loading_is_left_alone_until_the_budget_ends() {
        // Negative control for the check above: a LIVE child must still get
        // its full budget, or a big GGUF on a cold disk would be declared dead
        // while it is only slow (ENG-4).
        let state = AppState::new();
        let child = std::process::Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a live child");
        park_child(&state, child);

        assert_eq!(
            wait_for_health_or_exit(&state, DEAD_PORT, Duration::from_millis(900)),
            HealthWait::TimedOut
        );

        // Do not leave the sleeper behind.
        {
            let mut guard = state.bundled_engine.lock().unwrap();
            if let Some(e) = guard.as_mut() {
                let _ = e.child.kill();
                let _ = e.child.wait();
            }
        }
    }

    #[test]
    fn a_dead_start_names_the_graphics_card_when_the_engine_blamed_it() {
        let f = StartFailure {
            died: true,
            port_taken: false,
            stderr: "ggml_cuda_init: failed to initialize CUDA: no kernel image is available for execution on the device".into(),
        };
        let msg = start_failure_message(&f, 8127, Duration::from_secs(60));
        assert!(msg.contains("exited again"), "{msg}");
        assert!(msg.contains("tried twice"), "{msg}");
        assert!(msg.contains("GPU Layers to 0"), "{msg}");
        // llama-server's own words survive so a bug report still carries them.
        assert!(msg.contains("no kernel image"), "{msg}");
    }

    #[test]
    fn a_dead_start_points_at_the_model_when_the_engine_blamed_the_file() {
        let f = StartFailure {
            died: true,
            port_taken: false,
            stderr: "llama_model_load: error loading model: unknown model architecture 'wanx'".into(),
        };
        let msg = start_failure_message(&f, 8127, Duration::from_secs(60));
        assert!(msg.contains("refused the model file"), "{msg}");
        assert!(!msg.contains("GPU Layers"), "{msg}");
    }

    #[test]
    fn a_stranger_on_the_port_keeps_its_own_message() {
        let f = StartFailure { died: true, port_taken: true, stderr: String::new() };
        let msg = start_failure_message(&f, 8127, Duration::from_secs(60));
        assert!(msg.contains("occupying the port"), "{msg}");
        assert!(!msg.contains("tried twice"), "{msg}");
    }

    #[test]
    fn a_slow_load_still_reports_the_budget_and_never_claims_a_crash() {
        let f = StartFailure { died: false, port_taken: false, stderr: String::new() };
        let msg = start_failure_message(&f, 8127, Duration::from_secs(220));
        assert!(msg.contains("did not become healthy on port 8127 within 220s"), "{msg}");
        assert!(!msg.contains("exited"), "{msg}");
    }

    #[test]
    fn gpu_blame_needs_actual_gpu_words() {
        assert!(stderr_blames_the_gpu("CUDA error: out of memory"));
        assert!(stderr_blames_the_gpu("ggml_vulkan: no devices found"));
        // Negative control: a plain port collision is not a GPU problem, and
        // sending that user into the GPU Layers setting would waste their time.
        assert!(!stderr_blames_the_gpu("error: bind(): Address already in use"));
        assert!(!stderr_blames_the_model("error: bind(): Address already in use"));
    }

    #[test]
    fn scan_missing_dir_is_empty_not_error() {
        let dir = std::env::temp_dir().join("lu-engine-nonexistent-xyz-123");
        assert!(scan_gguf_models(&dir).is_empty());
    }

    #[test]
    fn scan_collapses_a_complete_shard_set_into_one_model() {
        let dir = std::env::temp_dir().join(format!("lu-engine-shards-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Big-UD-IQ1_S-00001-of-00003.gguf"), b"aa").unwrap();
        std::fs::write(dir.join("Big-UD-IQ1_S-00002-of-00003.gguf"), b"bbb").unwrap();
        std::fs::write(dir.join("Big-UD-IQ1_S-00003-of-00003.gguf"), b"c").unwrap();
        std::fs::write(dir.join("solo.gguf"), b"dddd").unwrap();

        let models = scan_gguf_models(&dir);
        let names: Vec<&str> = models.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["Big-UD-IQ1_S", "solo"]);
        let set = &models[0];
        assert!(set.path.ends_with("Big-UD-IQ1_S-00001-of-00003.gguf"));
        assert_eq!(set.size, 6); // sum of all three parts

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_hides_incomplete_shard_sets() {
        let dir = std::env::temp_dir().join(format!("lu-engine-partial-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // part 2 missing → mid-download, must not impersonate a loadable model
        std::fs::write(dir.join("Half-00001-of-00003.gguf"), b"a").unwrap();
        std::fs::write(dir.join("Half-00003-of-00003.gguf"), b"c").unwrap();
        // part 1 missing → can never load
        std::fs::write(dir.join("Tail-00002-of-00002.gguf"), b"z").unwrap();

        assert!(scan_gguf_models(&dir).is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn shard_stem_parser_rejects_lookalikes() {
        assert_eq!(
            split_shard_stem("M-00001-of-00003"),
            Some(("M", 1, 3))
        );
        assert_eq!(split_shard_stem("M-0001-of-0002"), Some(("M", 1, 2)));
        assert_eq!(split_shard_stem("plain-model"), None);
        assert_eq!(split_shard_stem("v2-out-of-band"), None); // non-numeric groups
        assert_eq!(split_shard_stem("M-001-of-002"), None); // too short
        assert_eq!(split_shard_stem("M-00004-of-00003"), None); // part > total
        assert_eq!(split_shard_stem("-00001-of-00002"), None); // empty base
    }

    #[test]
    fn sanitized_import_names_stay_inside_the_folder() {
        assert_eq!(sanitize_model_file_name("qwen2.5-coder:14b"), "qwen2.5-coder-14b.gguf");
        assert_eq!(sanitize_model_file_name("Already.GGUF"), "Already.GGUF");
        // Negative control: traversal and separators can never survive.
        assert_eq!(sanitize_model_file_name("../../evil"), "evil.gguf");
        assert_eq!(sanitize_model_file_name("a/b\\c d"), "a-b-c-d.gguf");
        assert_eq!(sanitize_model_file_name("###"), "model.gguf");
    }

    #[test]
    fn ollama_manifest_digest_picks_the_model_layer_only() {
        let manifest = r#"{"layers":[
            {"mediaType":"application/vnd.ollama.image.template","digest":"sha256:aaa"},
            {"mediaType":"application/vnd.ollama.image.model","digest":"sha256:bbb"},
            {"mediaType":"application/vnd.ollama.image.params","digest":"sha256:ccc"}
        ]}"#;
        assert_eq!(ollama_manifest_model_digest(manifest), Some("sha256:bbb".into()));
        // Negative controls: no model layer, and garbage JSON.
        let no_model = r#"{"layers":[{"mediaType":"application/vnd.ollama.image.params","digest":"sha256:ccc"}]}"#;
        assert_eq!(ollama_manifest_model_digest(no_model), None);
        assert_eq!(ollama_manifest_model_digest("not json"), None);
    }

    #[test]
    fn ollama_scan_finds_blobs_and_skips_half_pulled_models() {
        let root = tempfile::tempdir().unwrap();
        let mdir = root.path().join("manifests/registry.ollama.ai/library/qwen2.5-coder");
        std::fs::create_dir_all(&mdir).unwrap();
        std::fs::create_dir_all(root.path().join("blobs")).unwrap();
        std::fs::write(root.path().join("blobs/sha256-abc"), b"weights").unwrap();
        let manifest = r#"{"layers":[{"mediaType":"application/vnd.ollama.image.model","digest":"sha256:abc"}]}"#;
        std::fs::write(mdir.join("14b"), manifest).unwrap();
        // Negative control: manifest whose blob was never finished.
        let missing = r#"{"layers":[{"mediaType":"application/vnd.ollama.image.model","digest":"sha256:gone"}]}"#;
        std::fs::write(mdir.join("7b"), missing).unwrap();

        let found = scan_ollama_models(root.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "qwen2.5-coder-14b");
        assert_eq!(found[0].source, "ollama");
        assert_eq!(found[0].size, 7);
        assert!(found[0].path.ends_with("sha256-abc"));
    }

    #[test]
    fn lmstudio_scan_is_recursive_and_gguf_only() {
        let root = tempfile::tempdir().unwrap();
        let deep = root.path().join("lmstudio-community/qwen");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("qwen-7b-Q4.gguf"), b"gg").unwrap();
        // Negative control: sidecar files never count as models.
        std::fs::write(deep.join("README.md"), b"docs").unwrap();

        let found = scan_lmstudio_models(root.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "qwen-7b-Q4");
        assert_eq!(found[0].source, "lmstudio");
    }

    #[test]
    fn import_links_once_and_refuses_dupes_and_missing_sources() {
        let store = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let src = store.path().join("sha256-abc");
        std::fs::write(&src, b"weights").unwrap();

        let target = import_model_file(&src, dest.path(), "qwen2.5-coder:14b").unwrap();
        assert_eq!(target, dest.path().join("qwen2.5-coder-14b.gguf"));
        assert_eq!(std::fs::read(&target).unwrap(), b"weights");

        // Negative controls: a second import of the same name, and a source
        // that does not exist. Both must fail loudly, nothing silent.
        let dupe = import_model_file(&src, dest.path(), "qwen2.5-coder:14b");
        assert!(dupe.unwrap_err().contains("already exists"));
        let missing = import_model_file(&store.path().join("nope"), dest.path(), "x");
        assert!(missing.unwrap_err().contains("not found"));
    }
}

#[cfg(test)]
mod diag_tests {
    use super::{pick_save_slot, tail_lines};

    #[test]
    fn tail_keeps_the_last_lines_and_drops_blanks() {
        let log = "loading model\n\n  error: unknown pre-tokenizer type  \nfailed to load\n\n";
        assert_eq!(
            tail_lines(log, 2),
            "error: unknown pre-tokenizer type\nfailed to load"
        );
    }

    #[test]
    fn tail_of_a_short_log_is_the_whole_log() {
        assert_eq!(tail_lines("only line", 12), "only line");
        assert_eq!(tail_lines("", 12), "");
    }

    // Z36 counter-check 2026-08-22: the KV save hit slot 0 while the engine
    // held the 626 MB history in slot 3, so the handoff wrote a 20 byte husk
    // and the next turn re-processed everything. `pick_save_slot` reads the
    // real GET /slots shape of the bundled engine (b1-049326a): a used slot
    // carries n_prompt_tokens, an untouched one does not carry the field.
    #[test]
    fn save_slot_follows_the_tokens_not_slot_zero() {
        let slots = serde_json::json!([
            { "id": 0, "n_ctx": 8192, "is_processing": false },
            { "id": 1, "n_ctx": 8192, "is_processing": false },
            { "id": 2, "n_ctx": 8192, "is_processing": false },
            { "id": 3, "n_ctx": 8192, "is_processing": false, "n_prompt_tokens": 732 }
        ]);
        assert_eq!(pick_save_slot(&slots), 3);
    }

    #[test]
    fn the_biggest_history_wins_when_several_slots_are_used() {
        let slots = serde_json::json!([
            { "id": 0, "n_prompt_tokens": 34 },
            { "id": 1, "n_prompt_tokens": 945 },
            { "id": 2, "n_prompt_tokens": 12 }
        ]);
        assert_eq!(pick_save_slot(&slots), 1);
    }

    #[test]
    fn negative_control_untouched_engine_and_garbage_stay_on_slot_zero() {
        // All slots untouched (no token field anywhere): the old behaviour.
        let idle = serde_json::json!([
            { "id": 0, "n_ctx": 8192 }, { "id": 1, "n_ctx": 8192 }
        ]);
        assert_eq!(pick_save_slot(&idle), 0);
        // Not an array, an empty array, or plain garbage: fall back to 0.
        assert_eq!(pick_save_slot(&serde_json::json!({})), 0);
        assert_eq!(pick_save_slot(&serde_json::json!([])), 0);
        assert_eq!(pick_save_slot(&serde_json::json!(null)), 0);
    }
}
