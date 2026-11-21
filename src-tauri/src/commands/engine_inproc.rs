//! The built-in engine of a phone: llama.cpp IN the app process, behind the
//! exact HTTP surface the desktop `llama-server` sidecar has.
//!
//! A phone cannot start a second program, so there is no sidecar on Android
//! or iOS. This file is the one engine both of them use. It is also built into
//! a macOS build with the cargo feature `inproc-engine`, for one reason: an
//! iPhone computes on Metal, there is no iPhone on the desk, and a Mac has the
//! same chip family and the same Metal backend. So the same Rust, the same
//! llama.cpp and the same embedded shaders are exercised there
//! (MOBILE-ZIEL.md section 5, the tests at the bottom of this file).
//!
//! ── Shape ──────────────────────────────────────────────────────────────────
//!
//! Per engine (chat on 8127, embeddings on 8128, the desktop ports, so the
//! frontend's `http://127.0.0.1:8127/v1` works without a branch):
//!
//!   * one WORKER thread that owns `LlamaModel` and `LlamaContext`. The
//!     context is not `Send` and never leaves it. Jobs arrive over an mpsc
//!     channel, results stream back over a tokio channel.
//!   * one SERVER thread with a current-thread tokio runtime and an axum
//!     router on `127.0.0.1:<port>`: `/health`, `/props`, `/v1/models`,
//!     `/v1/models/{id}`, `/v1/chat/completions` (SSE and plain),
//!     `/v1/embeddings`.
//!
//! Both threads hang on one [`InProcChild`], which answers the three questions
//! the rest of the app asks a sidecar's `std::process::Child`: is it still
//! there (`try_wait`), stop (`kill`), and wait until it is gone (`wait`). On a
//! phone `BundledEngine::child` IS this type, so the status commands, the
//! dead-engine watch and the shutdown path in `engine.rs` and `state.rs` are
//! the desktop code, unchanged. Stopping joins both threads, which drops the
//! model and frees the GGUF from memory.
//!
//! ── Card or processor ──────────────────────────────────────────────────────
//!
//! Android: processor. The build carries no GPU backend.
//!
//! Apple: Metal is always compiled in (llama-cpp-sys-2 has no switch for it on
//! Apple targets), and the only switch is the layer count at load time. Metal
//! in the iOS Simulator initialises without an error, takes every layer, and
//! then computes garbage: 48 exclamation marks at 4 tokens per second, exit 0,
//! nothing in the log (measured, mobile-docs/IOS-MACHBARKEIT.md 2.5). llama.cpp
//! does not notice. So:
//!
//!   1. In the Simulator the engine asks for no layers at all.
//!   2. Wherever layers ARE asked for, the engine answers a short fixed
//!      question right after loading and the answer is judged
//!      (`engine_sanity::judge`, the same rules the desktop probe uses).
//!      Unreadable means: unload, load again with `n_gpu_layers = 0`, and say
//!      so. `cpu_fallback` and `sanity_note` on the `BundledEngine` carry that
//!      into `bundled_engine_status` (`cpuOnly`, `gpuLayers`, `sanityNote`,
//!      and `accelerator` on a phone), where the frontend can ask for it at
//!      any time.

// On a Mac this file is only built for its tests (feature `inproc-engine`),
// and nothing in the desktop app calls into it.
#![cfg_attr(not(mobile), allow(dead_code))]

use std::num::NonZeroU32;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::{Path as UrlPath, State as HttpState};
use axum::http::StatusCode;
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use llama_cpp_2::context::params::{KvCacheType, LlamaContextParams, LlamaPoolingType};
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaChatMessage, LlamaChatTemplate, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;
use tokio_util::sync::CancellationToken;

use super::engine_continue::{self, LeadTrim, Prefill};
use super::engine_sanity;
use super::engine_token;

/// The largest context a phone opens. The KV cache grows with it, and a phone
/// does not have the memory for the desktop default of 8192.
pub(crate) const MAX_CTX: u32 = 4096;
/// The smallest one a caller may ask for.
pub(crate) const MIN_CTX: u32 = 512;

/// Room kept free for the answer when the prompt is trimmed to fit.
///
/// Fitting the prompt alone is not enough: a history that stops one token
/// short of the window leaves a budget of 4, and the model is cut off after
/// two words. That reads like a broken model, not like a full context.
const REPLY_RESERVE: u32 = 512;
/// Prompt-feed batch size for the chat engine.
const N_BATCH: u32 = 512;
/// Embedding inputs are cut to this. It has to fit one ubatch, because a
/// pooled model processes the whole sequence at once.
pub(crate) const EMBED_CTX: u32 = 2048;
/// How long a model may take to load. Cold mmap plus the first touch of every
/// weight on slow flash.
const LOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// How long the HTTP server may take to bind.
const BIND_TIMEOUT: Duration = Duration::from_secs(10);

/// "Every layer", the same sentinel the desktop argv uses (`engine::ALL_LAYERS`).
pub(crate) const ALL_LAYERS: u32 = 999;

/// The context a phone really opens for a request.
pub(crate) fn clamp_ctx(requested: u32) -> u32 {
    requested.clamp(MIN_CTX, MAX_CTX)
}

// ── Card or processor: the decision ─────────────────────────────────────────

/// What the app says when it left the card alone in the Simulator.
pub(crate) const SIMULATOR_CPU_NOTE: &str = "The iOS Simulator has no graphics card that computes correctly, so the model runs on the processor.";
/// What it says when the self-test caught the card computing garbage.
pub(crate) const SELFTEST_CPU_NOTE: &str = "The graphics card produced unreadable output in the self-test after loading, so the model was loaded again and runs on the processor.";
/// And when the processor produced garbage too. Then the card was not it.
pub(crate) const SELFTEST_GARBLED_ON_CPU_NOTE: &str = "The model produced unreadable output on the graphics card and on the processor, so the card is not the cause. The model file may be damaged.";

/// The facts the decision needs, so it can be tested for every platform on
/// any platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Platform {
    /// Metal exists (macOS and iOS). Android carries no GPU backend.
    pub has_gpu_backend: bool,
    /// The iOS Simulator, whose Metal computes garbage.
    pub simulator: bool,
}

impl Platform {
    pub(crate) fn current() -> Self {
        Platform {
            has_gpu_backend: cfg!(any(target_os = "ios", target_os = "macos")),
            // Both halves on purpose. The compile-time half is the build that
            // was made FOR the simulator; the environment variable is what
            // CoreSimulator gives every process it starts, and it catches a
            // build that somebody ran there some other way.
            simulator: cfg!(all(target_os = "ios", target_abi = "sim"))
                || (cfg!(target_os = "ios") && std::env::var_os("SIMULATOR_UDID").is_some()),
        }
    }
}

/// How many layers to ask the card for, and why not all of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GpuPlan {
    pub layers: u32,
    /// The app decided against the card by itself, as opposed to the user
    /// typing 0 or the platform having no card.
    pub app_chose_cpu: bool,
    pub note: Option<&'static str>,
}

/// `requested` is `EngineTuning::gpu_layers`: negative for "auto", otherwise
/// the number the user typed. `force_gpu` is the test switch
/// (`LU_INPROC_FORCE_GPU=1`) that lets the Simulator take the card anyway, so
/// the self-test and its fallback can be watched working there.
pub(crate) fn plan_gpu(platform: Platform, requested: i32, force_gpu: bool) -> GpuPlan {
    if !platform.has_gpu_backend {
        return GpuPlan { layers: 0, app_chose_cpu: false, note: None };
    }
    if requested == 0 {
        // Typed by the user: exactly what was asked for, nothing to report.
        return GpuPlan { layers: 0, app_chose_cpu: false, note: None };
    }
    if platform.simulator && !force_gpu {
        return GpuPlan { layers: 0, app_chose_cpu: true, note: Some(SIMULATOR_CPU_NOTE) };
    }
    let layers = if requested < 0 { ALL_LAYERS } else { requested as u32 };
    GpuPlan { layers, app_chose_cpu: false, note: None }
}

/// The test switch for [`plan_gpu`].
pub(crate) fn force_gpu_from_env() -> bool {
    std::env::var_os("LU_INPROC_FORCE_GPU").is_some_and(|v| v != "0" && !v.is_empty())
}

/// The identity of a running in-process engine, in the shape of the desktop
/// argv. There is no real argv here, but two things read one: the start
/// command compares it to decide whether a request is already being served,
/// and the status command reads the layer count back out of `-ngl`
/// (`engine::gpu_layers_reported`).
pub(crate) fn identity_args(model_path: &str, n_ctx: u32, gpu_layers: u32) -> Vec<String> {
    identity_args_tuned(model_path, n_ctx, gpu_layers, LoadTuning::default())
}

/// The identity with the load settings in it, so that a change on the engine
/// page is a different request and the model is loaded again with it. The
/// layer count stays last: the start command cuts it off there.
pub(crate) fn identity_args_tuned(model_path: &str, n_ctx: u32, gpu_layers: u32, tuning: LoadTuning) -> Vec<String> {
    let mut args = vec![
        "--in-process".to_string(),
        "-m".to_string(),
        model_path.to_string(),
        "--ctx-size".to_string(),
        n_ctx.to_string(),
    ];
    args.extend(tuning.identity_words());
    args.push("-ngl".to_string());
    args.push(gpu_layers.to_string());
    args
}

// ── Memory ──────────────────────────────────────────────────────────────────

/// What a model needs in memory: the file, a fifth on top for the KV cache
/// and the compute buffers, and 350 MB of room for the app itself.
pub(crate) fn memory_needed_for(model_bytes: u64) -> u64 {
    model_bytes + model_bytes / 5 + 350 * 1024 * 1024
}

/// The memory the app may still take, in bytes, or `None` when the system
/// will not say.
///
/// iOS: `os_proc_available_memory` is the app's limit minus its footprint,
/// which is the number that decides whether the system kills it. It answers 0
/// in the Simulator (measured) and for a process that is not an app, and then
/// nothing is known. Everything else asks sysinfo.
///
/// `LU_INPROC_AVAILABLE_MB` overrides both. In the Simulator sysinfo reports
/// the Mac's memory, so without the override no "does not fit" could ever be
/// shown there.
pub(crate) fn available_memory() -> Option<u64> {
    if let Some(mb) = std::env::var("LU_INPROC_AVAILABLE_MB").ok().and_then(|v| v.parse::<u64>().ok()) {
        return Some(mb * 1024 * 1024);
    }
    #[cfg(target_os = "ios")]
    {
        extern "C" {
            fn os_proc_available_memory() -> usize;
        }
        // SAFETY: a libSystem call without arguments (iOS 13 and later).
        let left = unsafe { os_proc_available_memory() } as u64;
        if left > 0 {
            return Some(left);
        }
        if Platform::current().simulator {
            return None;
        }
    }
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let available = sys.available_memory();
    (available > 0).then_some(available)
}

/// Refuse a load that cannot fit, before the old model is gone and before the
/// system kills the app for trying.
pub(crate) fn ram_guard(model_path: &str) -> Result<(), String> {
    let size = std::fs::metadata(model_path)
        .map_err(|e| format!("Could not read the model file: {}", crate::os_error::english(&e)))?
        .len();
    ram_verdict(size, available_memory())
}

/// The decision behind [`ram_guard`], pure. An unknown amount of memory is
/// not a refusal: a guard that cannot measure must not be the reason nothing
/// loads.
pub(crate) fn ram_verdict(model_bytes: u64, available: Option<u64>) -> Result<(), String> {
    let Some(available) = available else {
        return Ok(());
    };
    let needed = memory_needed_for(model_bytes);
    if needed > available {
        return Err(format!(
            "Not enough memory for this model: it needs about {} MB and this device has {} MB available right now. Close other apps or choose a smaller model.",
            needed / (1024 * 1024),
            available / (1024 * 1024),
        ));
    }
    Ok(())
}

// ── Load settings ───────────────────────────────────────────────────────────

/// Flash Attention, as the engine page stores it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FlashAttn {
    Auto,
    On,
    Off,
}

/// The KV cache types the phone engine opens. `F16` is "not quantised".
///
/// There is no 4 bit type here, on purpose. With a `q4_0` cache Qwen3 0.6B
/// answered "What is the capital of France?" with `creed, creed, creed` on
/// Metal and with a loop of half sentences on the processor, with `q8_0` it
/// answered `Paris.` on both (measured on a Mac, 2026-10-08, the test
/// `inproc_the_engine_page_settings_are_applied`). A phone runs small models,
/// and the small ones are the ones 4 bit breaks. So a stored `q4_0` is opened
/// as `q8_0`, which is the saving that is safe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KvQuant {
    F16,
    Q8,
}

impl KvQuant {
    fn parse(text: &str) -> Self {
        match text {
            "q8_0" | "q4_0" => KvQuant::Q8,
            // "f16", "bf16" and anything a settings file may hold by mistake.
            _ => KvQuant::F16,
        }
    }

    fn name(self) -> &'static str {
        match self {
            KvQuant::F16 => "f16",
            KvQuant::Q8 => "q8_0",
        }
    }

    fn llama(self) -> KvCacheType {
        match self {
            KvQuant::F16 => KvCacheType::F16,
            KvQuant::Q8 => KvCacheType::Q8_0,
        }
    }
}

/// The part of `EngineTuning` (settings.builtinEngine) that the phone engine
/// applies when it loads a model, next to the context size and the layer
/// count, which travel on their own.
///
/// Two fields of `EngineTuning` are NOT here, on purpose:
///
///   * `no_mmap`. The file stays mapped, always. Without the mapping the
///     footprint grew by 1.2 to 2.2 times the file on every model of the
///     catalog (mobile-docs/KATALOG-PROBE.md, runs e and f), and mapped pages
///     are the only part of a model the system can take back without ending
///     the app.
///   * `mlock`. Pinning takes exactly that away: the weights become memory the
///     system cannot reclaim, so under pressure it ends the app instead of
///     paging. Not measured on a phone, the reasoning is in
///     mobile-docs/ENGINE-NACHZUG.md.
///
/// `mmap_and_mlock_are_not_settings_on_a_phone` holds both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LoadTuning {
    /// Threads for generation. 0 or less: the engine picks.
    pub threads: i32,
    pub flash_attn: FlashAttn,
    pub cache_k: KvQuant,
    pub cache_v: KvQuant,
}

impl Default for LoadTuning {
    fn default() -> Self {
        LoadTuning { threads: 0, flash_attn: FlashAttn::Auto, cache_k: KvQuant::F16, cache_v: KvQuant::F16 }
    }
}

impl LoadTuning {
    /// From the strings of `EngineTuning`. Unknown values mean the default:
    /// a settings file is user-editable and never passed through verbatim.
    pub(crate) fn from_settings(threads: i32, flash_attn: &str, cache_type_k: &str, cache_type_v: &str) -> Self {
        LoadTuning {
            threads: threads.max(0),
            flash_attn: match flash_attn {
                "on" => FlashAttn::On,
                "off" => FlashAttn::Off,
                _ => FlashAttn::Auto,
            },
            cache_k: KvQuant::parse(cache_type_k),
            cache_v: KvQuant::parse(cache_type_v),
        }
        .effective()
    }

    /// What llama.cpp can really open. A quantised V cache needs Flash
    /// Attention ("V cache quantization requires flash_attn", and no context
    /// at all), so with Flash Attention switched off the V cache stays at 16
    /// bit instead of the load failing.
    pub(crate) fn effective(self) -> Self {
        if self.flash_attn == FlashAttn::Off && self.cache_v != KvQuant::F16 {
            return LoadTuning { cache_v: KvQuant::F16, ..self };
        }
        self
    }

    /// Everything but the threads back at the default: what a load falls back
    /// to when the context could not be opened with the settings asked for.
    fn without_cache_settings(self) -> Self {
        LoadTuning { threads: self.threads, ..LoadTuning::default() }
    }

    fn has_cache_settings(self) -> bool {
        self.without_cache_settings() != self
    }

    /// The settings as argv words, in the desktop's spelling. Only what
    /// differs from the default, so an untouched engine page gives the
    /// identity it always gave.
    fn identity_words(self) -> Vec<String> {
        let mut words = Vec::new();
        if self.threads > 0 {
            words.push("--threads".to_string());
            words.push(self.threads.to_string());
        }
        match self.flash_attn {
            FlashAttn::Auto => {}
            FlashAttn::On => words.extend(["-fa".to_string(), "on".to_string()]),
            FlashAttn::Off => words.extend(["-fa".to_string(), "off".to_string()]),
        }
        if self.cache_k != KvQuant::F16 {
            words.extend(["-ctk".to_string(), self.cache_k.name().to_string()]);
        }
        if self.cache_v != KvQuant::F16 {
            words.extend(["-ctv".to_string(), self.cache_v.name().to_string()]);
        }
        words
    }

    /// Read the settings back out of an identity, so a model that has to be
    /// brought back after a failed switch comes back the way it ran.
    pub(crate) fn from_identity(args: &[String]) -> Self {
        let value = |flag: &str| args.windows(2).find(|w| w[0] == flag).map(|w| w[1].as_str());
        LoadTuning::from_settings(
            value("--threads").and_then(|v| v.parse().ok()).unwrap_or(0),
            value("-fa").unwrap_or("auto"),
            value("-ctk").unwrap_or("f16"),
            value("-ctv").unwrap_or("f16"),
        )
    }
}

/// The threads a load really uses: what was asked for, held between one and
/// the cores the device has, and up to eight of them when nothing was asked.
pub(crate) fn threads_for(requested: i32, cores: usize) -> i32 {
    let cores = cores.max(1);
    if requested <= 0 {
        return cores.min(8) as i32;
    }
    (requested as usize).min(cores) as i32
}

/// What the app says when the cache settings could not be opened.
pub(crate) const TUNING_DROPPED_NOTE: &str = "This model could not be loaded with the chosen Flash Attention and cache settings, so it was loaded with the standard ones.";

// ── Chat format ─────────────────────────────────────────────────────────────
//
// A model answers correctly only when its prompt is written the way it was
// trained. The GGUF carries that as a Jinja template. llama-cpp-2 0.1.154
// cannot run Jinja: `apply_chat_template` hands the template TEXT to
// llama.cpp, which recognises a fixed list of formats by looking for their
// marker strings and writes the prompt itself. 28 of the 29 catalog models are
// on that list. Gemma 4 is not (neither in 0.1.159), and the engine used to
// fall back to ChatML without a word. Gemma 4 has no `<|im_end|>` token, so
// it wrote one as plain text and the user saw `Paris<|im_end|>`
// (mobile-docs/KATALOG-PROBE.md section 4).
//
// So the format is decided ONCE, when the model is loaded, and a format
// nobody knows is a refused load with a sentence, never a guess:
//
//   1. the template names `<|turn>`: Gemma 4, written by hand below
//   2. llama.cpp recognises the template: its own renderer
//   3. the file has no template, but its vocabulary has the ChatML control
//      tokens: ChatML, and a line in the log
//   4. anything else: the load fails

/// How the prompt of the loaded model is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PromptFormat {
    /// llama.cpp knows the template inside the GGUF.
    Gguf,
    /// Gemma 4, by hand ([`gemma4_prompt`]).
    Gemma4,
    /// No template in the file, ChatML control tokens in the vocabulary.
    ChatMl,
}

impl PromptFormat {
    pub(crate) fn name(self) -> &'static str {
        match self {
            PromptFormat::Gguf => "gguf",
            PromptFormat::Gemma4 => "gemma4",
            PromptFormat::ChatMl => "chatml",
        }
    }
}

/// How the loaded model marks its thinking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ThinkStyle {
    /// `<think>` ... `</think>` (Qwen3, Qwen 3.5, SmolLM3).
    Tags,
    /// `<|channel>thought` ... `<channel|>` (Gemma 4).
    Channel,
}

impl ThinkStyle {
    /// What closes a thinking block that the engine has to end itself.
    fn closing_text(self) -> &'static str {
        match self {
            ThinkStyle::Tags => "\n</think>\n\n",
            ThinkStyle::Channel => "<channel|>",
        }
    }
}

/// What the load refuses with when nobody knows the format.
pub(crate) const UNKNOWN_FORMAT_ERROR: &str = "This model uses a chat format that LU does not know on this device yet, so its answers would be wrong. Choose another model.";

/// The decision behind the format, pure.
///
/// `template`: the template text of the GGUF, if it has one. `recognised`:
/// llama.cpp could render a message with it. `chatml_tokens`: `<|im_start|>`
/// and `<|im_end|>` are single tokens of this vocabulary.
pub(crate) fn decide_format(template: Option<&str>, recognised: bool, chatml_tokens: bool) -> Result<PromptFormat, &'static str> {
    match template {
        // Before asking llama.cpp: its detection goes by substrings, and this
        // is the one format the engine was measured with by hand.
        Some(t) if t.contains("<|turn>") && t.contains("<turn|>") => Ok(PromptFormat::Gemma4),
        Some(_) if recognised => Ok(PromptFormat::Gguf),
        // A template llama.cpp cannot read. It is still ChatML when it says
        // so itself and the vocabulary agrees.
        Some(t) if chatml_tokens && t.contains("<|im_start|>") => Ok(PromptFormat::ChatMl),
        Some(_) => Err(UNKNOWN_FORMAT_ERROR),
        None if chatml_tokens => Ok(PromptFormat::ChatMl),
        None => Err(UNKNOWN_FORMAT_ERROR),
    }
}

/// Which thinking marks a model has, from its format and its template text.
pub(crate) fn decide_think_style(format: PromptFormat, template: Option<&str>) -> Option<ThinkStyle> {
    match format {
        PromptFormat::Gemma4 => Some(ThinkStyle::Channel),
        _ if template.is_some_and(|t| t.contains("<think>") || t.contains("enable_thinking")) => Some(ThinkStyle::Tags),
        _ => None,
    }
}

/// What a `<think>` model's own template does with the Thinking switch, read
/// from the template text, because the engine cannot run the template.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TagsPlan {
    /// What the template does when nobody says anything.
    pub default_on: bool,
    /// "On" is written into the prompt as an opened block (`<think>\n`), and
    /// the model continues inside it.
    pub opens_block: bool,
}

/// Two families are in the catalog, and their templates end differently:
///
/// ```text
/// Qwen3     {%- if enable_thinking is defined and enable_thinking is false %}<think>\n\n</think>\n\n
///           thinks unless told not to, and opens its block itself
/// Qwen 3.5  {%- if enable_thinking is defined and enable_thinking is true %}<think>\n
///           {%- else %}<think>\n\n</think>\n\n
///           does NOT think unless told to, and the template opens the block
/// ```
///
/// Left to itself (the prompt ending at `assistant\n`, which is all llama.cpp's
/// renderer writes) Qwen 3.5 2B thought 700 tokens about "Count from 1 to 10."
/// in the measurement run. Its template would never have let it.
pub(crate) fn tags_plan(template: &str) -> TagsPlan {
    let default_off = template.contains("enable_thinking is defined and enable_thinking is true")
        || template.contains("enable_thinking | default(false)")
        || template.contains("enable_thinking|default(false)");
    TagsPlan {
        default_on: !default_off,
        // The four characters backslash-n are in the Jinja source.
        opens_block: template.contains("'<think>\\n'") || template.contains("\"<think>\\n\""),
    }
}

/// What is appended to the prompt of a `<think>` model, and whether the
/// model then starts inside a thinking block.
pub(crate) fn tags_suffix(plan: TagsPlan, wish: Option<bool>) -> (&'static str, bool) {
    if !wish.unwrap_or(plan.default_on) {
        return (EMPTY_THINK_BLOCK, false);
    }
    if plan.opens_block {
        return ("<think>\n", true);
    }
    ("", false)
}

/// Remove `<|channel>...<channel|>` blocks from an earlier answer, as the
/// Gemma 4 template does (`strip_thinking`): the model must not read its own
/// thinking back as part of the conversation.
fn gemma4_strip_thinking(text: &str) -> String {
    let mut out = String::new();
    for part in text.split("<channel|>") {
        match part.find("<|channel>") {
            Some(at) => out.push_str(&part[..at]),
            None => out.push_str(part),
        }
    }
    out.trim().to_string()
}

/// The Gemma 4 prompt, written the way the template inside the GGUF writes it
/// for a conversation of text (18808 characters of Jinja, read on 2026-10-08
/// from `unsloth/gemma-4-E2B-it-GGUF`):
///
/// ```text
/// <|turn>system\n[<|think|>\n]{system}<turn|>\n      only with a system message or with thinking
/// <|turn>user\n{text}<turn|>\n
/// <|turn>model\n{answer}<turn|>\n
/// <|turn>model\n                                     the open turn the model continues
/// ```
///
/// The assistant is called `model`. Every text is trimmed. `<bos>` is not
/// written here: the tokenizer adds it (`AddBos::Always`). Thinking is off
/// unless `<|think|>` opens the system turn. Tool calls, pictures and sound
/// are not written, the engine is text only.
pub(crate) fn gemma4_prompt(msgs: &[(String, String)], thinking: bool) -> String {
    let mut s = String::new();
    let leading_system = msgs.first().filter(|(role, _)| role == "system" || role == "developer");
    if thinking || leading_system.is_some() {
        s.push_str("<|turn>system\n");
        if thinking {
            s.push_str("<|think|>\n");
        }
        if let Some((_, content)) = leading_system {
            s.push_str(content.trim());
        }
        s.push_str("<turn|>\n");
    }
    let rest = if leading_system.is_some() { &msgs[1..] } else { msgs };
    let mut previous_was_model = false;
    for (role, content) in rest {
        let (role, text) = match role.as_str() {
            "assistant" | "model" => ("model", gemma4_strip_thinking(content)),
            "system" | "developer" => ("system", content.trim().to_string()),
            // A tool result reaches this engine as text. The template has a
            // tool channel for it, which this engine does not write, so the
            // model reads it as something the user said.
            _ => ("user", content.trim().to_string()),
        };
        // Two answers in a row are one turn in this format.
        if role == "model" && previous_was_model {
            // Reopen the turn the previous answer closed.
            if s.ends_with("<turn|>\n") {
                s.truncate(s.len() - "<turn|>\n".len());
                s.push('\n');
            }
        } else {
            s.push_str("<|turn>");
            s.push_str(role);
            s.push('\n');
        }
        s.push_str(&text);
        s.push_str("<turn|>\n");
        previous_was_model = role == "model";
    }
    s.push_str("<|turn>model\n");
    s
}

/// ChatML by hand, for a file without a template.
pub(crate) fn chatml_prompt(msgs: &[(String, String)]) -> String {
    let mut s = String::new();
    for (role, content) in msgs {
        s.push_str(&format!("<|im_start|>{role}\n{content}<|im_end|>\n"));
    }
    s.push_str("<|im_start|>assistant\n");
    s
}

/// What a `<think>` model reads when the user switched thinking off: the
/// empty block its own template writes for `enable_thinking = false` (Qwen3,
/// Qwen 3.5, SmolLM3). The model then goes straight to the answer.
pub(crate) const EMPTY_THINK_BLOCK: &str = "<think>\n\n</think>\n\n";

// ── What must never reach the user ──────────────────────────────────────────

/// Turn markers of every format in the catalog, and of ChatML. A model writes
/// one of these as plain text only when something is wrong with its prompt,
/// and then the answer ends there: the marker is cut, nothing after it is
/// shown, and the request finishes with `stop`.
///
/// Written as real control tokens they never get this far, they end the
/// generation (`is_eog_token`) or render as nothing.
pub(crate) const STOP_MARKERS: [&str; 15] = [
    "<|im_end|>",
    "<|im_start|>",
    "<|endoftext|>",
    "<|end_of_text|>",
    "<|begin_of_text|>",
    "<|eot_id|>",
    "<|start_header_id|>",
    "<|end_header_id|>",
    "<end_of_turn>",
    "<start_of_turn>",
    "<turn|>",
    "<|turn>",
    "<|end|>",
    "<|user|>",
    "<|assistant|>",
];

/// Holds text back while it could still become a stop marker.
#[derive(Debug, Default)]
pub(crate) struct StopFilter {
    held: String,
    hit: bool,
}

impl StopFilter {
    /// Feed a piece, get what is safe to show. After a marker was found
    /// nothing comes out any more and [`StopFilter::hit`] is true.
    pub(crate) fn push(&mut self, piece: &str) -> String {
        if self.hit {
            return String::new();
        }
        self.held.push_str(piece);
        if let Some(at) = STOP_MARKERS.iter().filter_map(|m| self.held.find(m)).min() {
            self.hit = true;
            let out = self.held[..at].to_string();
            self.held.clear();
            return out;
        }
        // Keep the longest tail that is the start of a marker.
        let keep = (1..=self.held.len())
            .rev()
            .filter(|n| self.held.is_char_boundary(self.held.len() - n))
            .find(|n| {
                let tail = &self.held[self.held.len() - n..];
                STOP_MARKERS.iter().any(|m| m.len() > tail.len() && m.starts_with(tail))
            })
            .unwrap_or(0);
        let cut = self.held.len() - keep;
        let out = self.held[..cut].to_string();
        self.held.drain(..cut);
        out
    }

    pub(crate) fn hit(&self) -> bool {
        self.hit
    }

    /// The end of the generation: what was held back and never became a
    /// marker. A lone `<` belongs to the text. Three characters and more of a
    /// marker (`<|i`, `<en`) are the marker being cut off by the token limit,
    /// and half a marker is not shown either.
    pub(crate) fn finish(&mut self) -> String {
        let tail = std::mem::take(&mut self.held);
        if self.hit || tail.chars().count() >= 3 {
            return String::new();
        }
        tail
    }
}

/// One piece of output, sorted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Piece {
    Answer(String),
    Thought(String),
}

/// Sorts the stream into thinking and answer.
///
/// Two ways in: the model spells `<think>` and `</think>` as text
/// ([`ThinkSplitter::push`] finds them, also when they arrive in halves), or
/// it writes them as single tokens, which the generation loop sees by their
/// id and reports through [`ThinkSplitter::open`] and [`ThinkSplitter::close`].
/// Gemma 4 only has the second way: its channel tokens render as nothing.
///
/// The marks themselves never come out. White space right after an opening
/// or closing mark is dropped, so an empty block (`<think>\n\n</think>\n\n`)
/// leaves no trace and the answer starts at its first letter.
#[derive(Debug, Default)]
pub(crate) struct ThinkSplitter {
    thinking: bool,
    /// Which marks opened the block that is open now.
    style: Option<ThinkStyle>,
    held: String,
    /// Drop white space until the next visible character.
    trim_start: bool,
    /// Gemma 4 names the channel after the opening mark: `thought\n`.
    skip_word: bool,
}

const THINK_OPEN: &str = "<think>";
const THINK_CLOSE: &str = "</think>";
const CHANNEL_WORD: &str = "thought";

impl ThinkSplitter {
    /// A splitter for a prompt that already ends inside a thinking block.
    pub(crate) fn inside(style: ThinkStyle) -> Self {
        let mut s = ThinkSplitter::default();
        s.open(style);
        s
    }

    pub(crate) fn thinking(&self) -> bool {
        self.thinking
    }

    /// The marks that have to close the block that is open now.
    pub(crate) fn open_style(&self) -> Option<ThinkStyle> {
        if self.thinking { self.style } else { None }
    }

    /// The model wrote the opening mark as one token.
    pub(crate) fn open(&mut self, style: ThinkStyle) -> Vec<Piece> {
        let out = self.flush_held();
        self.thinking = true;
        self.style = Some(style);
        self.trim_start = true;
        self.skip_word = style == ThinkStyle::Channel;
        out
    }

    /// The model wrote the closing mark as one token, or the engine closed
    /// the block itself.
    pub(crate) fn close(&mut self) -> Vec<Piece> {
        self.skip_word = false;
        let out = self.flush_held();
        self.thinking = false;
        self.trim_start = true;
        out
    }

    fn flush_held(&mut self) -> Vec<Piece> {
        let text = std::mem::take(&mut self.held);
        self.emit(text).into_iter().collect()
    }

    fn emit(&mut self, mut text: String) -> Option<Piece> {
        if self.skip_word {
            // `thought` may arrive in two pieces. Wait until it is decided.
            let seen = text.trim_start();
            if CHANNEL_WORD.starts_with(seen) && seen.len() < CHANNEL_WORD.len() {
                self.held = text;
                return None;
            }
            if let Some(rest) = seen.strip_prefix(CHANNEL_WORD) {
                text = rest.to_string();
            }
            self.skip_word = false;
        }
        if self.trim_start {
            text = text.trim_start().to_string();
            if text.is_empty() {
                return None;
            }
            self.trim_start = false;
        }
        if text.is_empty() {
            return None;
        }
        Some(if self.thinking { Piece::Thought(text) } else { Piece::Answer(text) })
    }

    /// Feed text, get it back sorted.
    pub(crate) fn push(&mut self, text: &str) -> Vec<Piece> {
        let mut out = Vec::new();
        self.held.push_str(text);
        loop {
            let mark = if self.thinking { THINK_CLOSE } else { THINK_OPEN };
            if let Some(at) = self.held.find(mark) {
                let before = self.held[..at].to_string();
                let after = self.held[at + mark.len()..].to_string();
                self.held.clear();
                out.extend(self.emit(before));
                // A half word that was still waiting belongs to the block it was in.
                self.skip_word = false;
                out.extend(self.flush_held());
                if self.thinking {
                    self.thinking = false;
                } else {
                    self.thinking = true;
                    self.style = Some(ThinkStyle::Tags);
                }
                self.trim_start = true;
                self.held = after;
                continue;
            }
            // A closing mark without a block: the prompt ended inside one and
            // nobody said so. The mark goes, the text stays.
            if !self.thinking {
                if let Some(at) = self.held.find(THINK_CLOSE) {
                    let before = self.held[..at].to_string();
                    let after = self.held[at + THINK_CLOSE.len()..].to_string();
                    self.held.clear();
                    out.extend(self.emit(before));
                    self.trim_start = true;
                    self.held = after;
                    continue;
                }
            }
            break;
        }
        // Keep back what could still become a mark.
        let marks: &[&str] = if self.thinking { &[THINK_CLOSE] } else { &[THINK_OPEN, THINK_CLOSE] };
        let keep = (1..=self.held.len())
            .rev()
            .filter(|n| self.held.is_char_boundary(self.held.len() - n))
            .find(|n| {
                let tail = &self.held[self.held.len() - n..];
                marks.iter().any(|m| m.len() > tail.len() && m.starts_with(tail))
            })
            .unwrap_or(0);
        let cut = self.held.len() - keep;
        let ready = self.held[..cut].to_string();
        let tail = self.held[cut..].to_string();
        self.held.clear();
        out.extend(self.emit(ready));
        // `emit` may have parked a half word in `held`.
        self.held.push_str(&tail);
        out
    }

    /// The end of the generation: what was still held back.
    pub(crate) fn finish(&mut self) -> Vec<Piece> {
        self.skip_word = false;
        self.flush_held()
    }
}

/// How many tokens a thinking block may take before the engine closes it.
///
/// Half of what is left of the window after the prompt, so the answer always
/// has at least as much room as the thinking had, and never more than a
/// quarter of the window: 1024 tokens at 4096, 512 at 2048. Qwen 3.5 2B spent
/// 700 tokens thinking about "Count from 1 to 10." and was cut off in the
/// middle of the answer (mobile-docs/KATALOG-PROBE.md section 3).
pub(crate) fn think_budget(budget: u32, n_ctx: u32) -> u32 {
    (budget / 2).min(n_ctx / 4).max(1)
}

/// Does the request switch thinking on or off? `None`: the request does not
/// say, the model does what it does by itself.
///
/// The frontend sends both: `chat_template_kwargs.enable_thinking` for a
/// server that renders the model's own template, which is what this engine
/// is, and `reasoning_effort` for the OpenAI protocol (`none` is off). The
/// first wins where both are there.
pub(crate) fn thinking_wish(body: &serde_json::Value) -> Option<bool> {
    if let Some(on) = body.pointer("/chat_template_kwargs/enable_thinking").and_then(|v| v.as_bool()) {
        return Some(on);
    }
    match body.get("reasoning_effort").and_then(|v| v.as_str()) {
        Some("none") => Some(false),
        Some(_) => Some(true),
        None => None,
    }
}

// ── The llama backend ───────────────────────────────────────────────────────

static BACKEND: OnceLock<LlamaBackend> = OnceLock::new();
static BACKEND_INIT: Mutex<()> = Mutex::new(());

/// `llama_backend_init` may run once per process. Both engines share it.
fn ensure_backend() -> Result<&'static LlamaBackend, String> {
    if let Some(b) = BACKEND.get() {
        return Ok(b);
    }
    let _g = BACKEND_INIT
        .lock()
        .map_err(|_| "The engine could not be initialised (lock poisoned).".to_string())?;
    if let Some(b) = BACKEND.get() {
        return Ok(b);
    }
    // llama.cpp writes several hundred lines to stderr per model load. A
    // debug build sends them through tracing instead, which on Android is the
    // only way to see them at all (logcat, tag LU). A release build drops
    // them: what matters about a load is logged by this file itself.
    llama_cpp_2::send_logs_to_tracing(
        llama_cpp_2::LogOptions::default().with_logs_enabled(cfg!(debug_assertions)),
    );
    match LlamaBackend::init() {
        Ok(b) => Ok(BACKEND.get_or_init(|| b)),
        Err(e) => Err(format!("The engine could not be initialised: {e}")),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Chat,
    Embed,
}

enum Item {
    Token(String),
    /// A piece of the model's thinking. It goes out as `reasoning_content`.
    Thought(String),
    Done {
        finish_reason: &'static str,
        prompt_tokens: u32,
        completion_tokens: u32,
    },
    Embeddings(Vec<Vec<f32>>),
    Error(String),
}

struct ChatJob {
    messages: Vec<(String, String)>,
    temperature: Option<f32>,
    top_p: Option<f32>,
    /// The most tokens the ANSWER may have. Thinking has its own limit
    /// ([`think_budget`]), so a caller's small number cannot end the turn
    /// inside the thinking block.
    max_tokens: Option<u32>,
    /// The most tokens of any kind. Only the self-test sets it: it wants 24
    /// tokens of whatever the model writes, thinking included.
    hard_cap: Option<u32>,
    /// The Thinking switch of the request, see [`thinking_wish`].
    thinking: Option<bool>,
    /// The answer to go on with instead of starting a new one
    /// (engine_continue.rs). `messages` then ends with the question.
    prefill: Option<Prefill>,
    out: tokio::sync::mpsc::UnboundedSender<Item>,
}

struct EmbedJob {
    inputs: Vec<String>,
    out: tokio::sync::mpsc::UnboundedSender<Item>,
}

enum Job {
    Chat(ChatJob),
    Embed(EmbedJob),
    Stop,
}

/// State shared with the axum handlers.
struct Shared {
    kind: Kind,
    model_name: String,
    loaded: AtomicBool,
    n_ctx: AtomicU32,
    /// The loaded model has thinking marks the engine knows.
    thinks: AtomicBool,
    /// [`PromptFormat::name`] of the loaded model.
    format: OnceLock<&'static str>,
    cmd_tx: Mutex<std_mpsc::Sender<Job>>,
}

// ── The handle ──────────────────────────────────────────────────────────────

/// The running engine, in the three verbs the app has for a sidecar process.
///
/// Dropping it stops the engine and waits for both threads, so a handle that
/// is simply thrown away (`*slot = None` in `shutdown_subprocesses`) still
/// frees the model.
pub struct InProcChild {
    cmd_tx: std_mpsc::Sender<Job>,
    abort: Arc<AtomicBool>,
    cancel: CancellationToken,
    worker: Option<JoinHandle<()>>,
    server: Option<JoinHandle<()>>,
}

/// The "exit status" of an in-process engine. There is no process, but the
/// callers were written for `Child` and only ever look at whether there is
/// one.
fn exited() -> std::process::ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(0)
}

impl InProcChild {
    /// `Ok(Some(_))` once the worker thread has ended, which is the moment the
    /// model is gone. `Ok(None)` while it serves.
    pub fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        match self.worker.as_ref() {
            Some(w) if !w.is_finished() => Ok(None),
            _ => Ok(Some(exited())),
        }
    }

    /// Ask both threads to end. Returns at once; `wait` is what blocks. A
    /// generation in flight stops at its next token.
    pub fn kill(&mut self) -> std::io::Result<()> {
        self.abort.store(true, Ordering::Relaxed);
        let _ = self.cmd_tx.send(Job::Stop);
        self.cancel.cancel();
        Ok(())
    }

    /// Block until the worker has ended, then take the HTTP server down with
    /// it. Like `Child::wait` this waits for as long as the engine lives, so
    /// it is called after `kill`, or once `try_wait` has said the worker is
    /// gone.
    pub fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
        // A worker that ended by itself leaves a server that answers 503
        // forever. Nobody may be left waiting on that.
        self.cancel.cancel();
        if let Some(s) = self.server.take() {
            let _ = s.join();
        }
        Ok(exited())
    }
}

impl Drop for InProcChild {
    fn drop(&mut self) {
        let _ = self.kill();
        let _ = self.wait();
    }
}

// ── Launch ──────────────────────────────────────────────────────────────────

/// One request to load a model and serve it.
pub(crate) struct LaunchRequest<'a> {
    pub kind: Kind,
    pub model_path: &'a str,
    /// Already clamped by the caller ([`clamp_ctx`], [`EMBED_CTX`]).
    pub n_ctx: u32,
    pub port: u16,
    pub gpu: GpuPlan,
    /// Threads, Flash Attention and the KV cache types of the engine page.
    pub tuning: LoadTuning,
    /// Judges the self-test answer. `engine_sanity::judge` in production; a
    /// test hands in its own to play a card that computes garbage.
    pub is_garbled: fn(&str) -> bool,
}

/// What came up.
pub(crate) struct Launched {
    pub child: InProcChild,
    /// The context really opened: `min(requested, n_ctx_train)`. Reporting the
    /// request instead would have the token counter promise room the engine
    /// does not have (old Android findings A94, A107, A108).
    pub n_ctx: u32,
    /// The layers this engine really asked the card for. 0 after a fallback.
    pub gpu_layers: u32,
    /// The app took the card away by itself.
    pub cpu_fallback: bool,
    /// The one sentence about that, for the status.
    pub note: Option<&'static str>,
    /// The self-test caught garbage and the engine was loaded a second time.
    pub retried: bool,
    /// The answer was unreadable on the processor as well.
    pub garbled_on_cpu: bool,
    /// The context could not be opened with the Flash Attention and cache
    /// settings asked for, and the model runs with the standard ones
    /// ([`TUNING_DROPPED_NOTE`]).
    pub tuning_dropped: bool,
}

/// The production judge.
pub(crate) fn sanity_says_garbled(text: &str) -> bool {
    engine_sanity::judge(text).is_garbled()
}

/// Load, self-test where the card is used, and fall back to the processor
/// when the card computes garbage.
pub(crate) fn launch_with_fallback(req: &LaunchRequest) -> Result<Launched, String> {
    let first = launch(req.kind, req.model_path, req.n_ctx, req.port, req.gpu.layers, req.tuning)?;
    let on_card = req.gpu.layers > 0;

    let garbled = on_card
        && first
            .selftest
            .as_deref()
            .is_some_and(|text| {
                let bad = (req.is_garbled)(text);
                tracing::info!(
                    target: "engine",
                    verdict = if bad { "garbled" } else { "readable" },
                    sample = %engine_sanity::sample_for_log(text, 80),
                    "self-test after loading on the graphics card"
                );
                bad
            });

    if !garbled {
        return Ok(Launched {
            child: first.child,
            n_ctx: first.n_ctx,
            gpu_layers: req.gpu.layers,
            cpu_fallback: req.gpu.app_chose_cpu,
            note: req.gpu.note,
            retried: false,
            garbled_on_cpu: false,
            tuning_dropped: first.tuning_dropped,
        });
    }

    // The card computed garbage. Unload completely first: the port has to be
    // free again and two copies of the model must never be in memory at once.
    tracing::warn!(target: "engine", "the graphics card produced unreadable output, loading again on the processor");
    drop(first.child);

    let second = launch(req.kind, req.model_path, req.n_ctx, req.port, 0, req.tuning)?;
    // The processor run answered the same question the same way, so "the
    // card was not it" is a measurement and not a guess.
    let garbled_on_cpu = second.selftest.as_deref().is_some_and(|t| (req.is_garbled)(t));
    Ok(Launched {
        child: second.child,
        n_ctx: second.n_ctx,
        gpu_layers: 0,
        cpu_fallback: true,
        note: Some(if garbled_on_cpu { SELFTEST_GARBLED_ON_CPU_NOTE } else { SELFTEST_CPU_NOTE }),
        retried: true,
        garbled_on_cpu,
        tuning_dropped: second.tuning_dropped,
    })
}

/// One loaded engine plus what its self-test said.
struct Up {
    child: InProcChild,
    n_ctx: u32,
    /// The self-test answer. `None` for the embeddings engine, which has no
    /// text to judge.
    selftest: Option<String>,
    tuning_dropped: bool,
}

/// What the worker reports once the model is in memory.
struct Ready {
    n_ctx: u32,
    selftest: Option<String>,
    tuning_dropped: bool,
}

fn launch(kind: Kind, model_path: &str, n_ctx_req: u32, port: u16, gpu_layers: u32, tuning: LoadTuning) -> Result<Up, String> {
    let (cmd_tx, cmd_rx) = std_mpsc::channel::<Job>();
    let abort = Arc::new(AtomicBool::new(false));
    let cancel = CancellationToken::new();
    let model_name = Path::new(model_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("model")
        .to_string();
    let shared = Arc::new(Shared {
        kind,
        model_name,
        loaded: AtomicBool::new(false),
        n_ctx: AtomicU32::new(n_ctx_req),
        thinks: AtomicBool::new(false),
        format: OnceLock::new(),
        cmd_tx: Mutex::new(cmd_tx.clone()),
    });

    let (ready_tx, ready_rx) = std_mpsc::channel::<Result<Ready, String>>();
    // The self-test runs for every chat load. On the card it decides the
    // fallback. On the processor its answer is only read when a card run
    // before it failed.
    let worker = spawn_worker(
        kind,
        model_path.to_string(),
        n_ctx_req,
        gpu_layers,
        tuning,
        shared.clone(),
        ready_tx,
        cmd_rx,
        abort.clone(),
    );

    let (bind_tx, bind_rx) = std_mpsc::channel::<Result<(), String>>();
    let server = spawn_server(port, shared, cancel.clone(), bind_tx);

    // From here on the handle owns both threads: every early return below
    // drops it, and the drop stops and joins them.
    let child = InProcChild {
        cmd_tx,
        abort,
        cancel,
        worker: Some(worker),
        server: Some(server),
    };

    match bind_rx.recv_timeout(BIND_TIMEOUT) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            return Err(format!("The LU Engine could not open the local port {port}: {e}"));
        }
        Err(_) => {
            return Err("The LU Engine could not start its local server.".to_string());
        }
    }

    let ready = match ready_rx.recv_timeout(LOAD_TIMEOUT) {
        Ok(Ok(ready)) => ready,
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            return Err(format!(
                "The model did not finish loading within {} seconds.",
                LOAD_TIMEOUT.as_secs()
            ));
        }
    };

    Ok(Up { child, n_ctx: ready.n_ctx, selftest: ready.selftest, tuning_dropped: ready.tuning_dropped })
}

/// An architecture this engine is known not to load, with the sentence for it.
/// llama-cpp-2 0.1.154 predates Inkling 2, so on a phone it runs through Remote.
pub(crate) fn refused_architecture(arch: &str) -> Option<&'static str> {
    matches!(arch, "inkling2" | "inkling2_loop")
        .then_some("Inkling 2 Mini does not run on this phone yet. Use it through Remote from your computer.")
}

// ── Worker thread (owns model and context) ──────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn spawn_worker(
    kind: Kind,
    model_path: String,
    n_ctx_req: u32,
    gpu_layers: u32,
    tuning: LoadTuning,
    shared: Arc<Shared>,
    ready_tx: std_mpsc::Sender<Result<Ready, String>>,
    rx: std_mpsc::Receiver<Job>,
    abort: Arc<AtomicBool>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let backend = match ensure_backend() {
            Ok(b) => b,
            Err(e) => {
                let _ = ready_tx.send(Err(e));
                return;
            }
        };
        // Always said out loud, 0 included. Left at its default, llama.cpp
        // offloads every layer wherever a GPU backend is compiled in, and on
        // Apple one always is.
        let model_params = model_params_for(gpu_layers);
        let head = super::gguf::read_model_head(&model_path);
        if let Some(why) = head.as_ref().and_then(|h| h.arch()).and_then(refused_architecture) {
            let _ = ready_tx.send(Err(why.to_string()));
            return;
        }
        let model = match LlamaModel::load_from_file(backend, &model_path, &model_params) {
            Ok(m) => m,
            Err(e) => {
                let _ = ready_tx.send(Err(format!("The model could not be loaded: {e}")));
                return;
            }
        };

        // The chat format, before any memory goes into a context: a model
        // whose format nobody knows is refused here, with a sentence.
        let format = match kind {
            Kind::Chat => match resolve_format(&model) {
                Ok(f) => Some(f),
                Err(e) => {
                    tracing::warn!(target: "engine", model = %model_path, "refused: the chat format of this model is not known");
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            },
            Kind::Embed => None,
        };

        let train = model.n_ctx_train().max(MIN_CTX);
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let threads = threads_for(tuning.threads, cores);
        let n_ctx = n_ctx_req.min(train);
        // Flash Attention and the cache types belong to the chat engine. The
        // embeddings engine has no KV cache worth quantising.
        let wanted = match kind {
            Kind::Chat => tuning.effective(),
            Kind::Embed => tuning.without_cache_settings(),
        };
        let opened = match model.new_context(backend, context_params_for(kind, n_ctx, threads, wanted)) {
            Ok(c) => Ok((c, false)),
            // llama.cpp refuses some pairs of model and cache type (a block
            // size that does not divide the head size, for one). The settings
            // are a wish, the model loading is not, so it loads without them
            // and the app says so.
            Err(e) if wanted.has_cache_settings() => {
                tracing::warn!(target: "engine", error = %e, "the context could not be opened with the chosen cache settings, opening it with the standard ones");
                model
                    .new_context(backend, context_params_for(kind, n_ctx, threads, wanted.without_cache_settings()))
                    .map(|c| (c, true))
            }
            Err(e) => Err(e),
        };
        let (mut ctx, tuning_dropped) = match opened {
            Ok(pair) => pair,
            Err(e) => {
                let _ = ready_tx.send(Err(format!("The model's context could not be created: {e}")));
                return;
            }
        };

        // The self-test, before anyone is told the engine is up. See the
        // module head for why a load that "worked" proves nothing on Metal.
        let selftest = match kind {
            Kind::Chat => format.as_ref().map(|f| selftest_answer(&model, &mut ctx, n_ctx, f, &abort)),
            Kind::Embed => None,
        };
        if let Some(f) = format.as_ref() {
            shared.thinks.store(f.think.is_some(), Ordering::Relaxed);
            let _ = shared.format.set(f.prompt.name());
        }

        shared.n_ctx.store(n_ctx, Ordering::Relaxed);
        shared.loaded.store(true, Ordering::Relaxed);
        let _ = ready_tx.send(Ok(Ready { n_ctx, selftest, tuning_dropped }));
        tracing::info!(
            target: "engine",
            n_ctx, threads, gpu_layers,
            flash_attn = ?wanted.flash_attn, cache_k = wanted.cache_k.name(), cache_v = wanted.cache_v.name(), tuning_dropped,
            format = format.as_ref().map(|f| f.prompt.name()).unwrap_or("none"),
            model = %model_path,
            "model loaded in-process"
        );

        while let Ok(job) = rx.recv() {
            match job {
                Job::Stop => break,
                Job::Chat(j) => {
                    if let Some(f) = format.as_ref() {
                        run_chat(&model, &mut ctx, n_ctx, f, j, &abort);
                    } else {
                        let _ = j.out.send(Item::Error(
                            "this server runs in embeddings mode and does not serve chat".into(),
                        ));
                    }
                }
                Job::Embed(j) => {
                    if kind == Kind::Embed {
                        run_embed(&model, &mut ctx, n_ctx as usize, j, &abort);
                    } else {
                        let _ = j.out.send(Item::Error(
                            "the chat engine was not started with --embeddings".into(),
                        ));
                    }
                }
            }
        }
        shared.loaded.store(false, Ordering::Relaxed);
        // model and ctx drop here, and the GGUF is freed.
    })
}

/// How a model file is opened. The file is always mapped and never pinned,
/// whatever the settings say, see [`LoadTuning`].
fn model_params_for(gpu_layers: u32) -> LlamaModelParams {
    LlamaModelParams::default()
        .with_n_gpu_layers(gpu_layers)
        .with_use_mmap(true)
        .with_use_mlock(false)
}

fn context_params_for(kind: Kind, n_ctx: u32, threads: i32, tuning: LoadTuning) -> LlamaContextParams {
    let flash = match tuning.flash_attn {
        FlashAttn::Auto => llama_cpp_sys_2::LLAMA_FLASH_ATTN_TYPE_AUTO,
        FlashAttn::On => llama_cpp_sys_2::LLAMA_FLASH_ATTN_TYPE_ENABLED,
        FlashAttn::Off => llama_cpp_sys_2::LLAMA_FLASH_ATTN_TYPE_DISABLED,
    };
    let base = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(n_ctx))
        .with_n_threads(threads)
        .with_n_threads_batch(threads)
        .with_flash_attention_policy(flash)
        .with_type_k(tuning.cache_k.llama())
        .with_type_v(tuning.cache_v.llama());
    match kind {
        Kind::Chat => base.with_n_batch(N_BATCH),
        // Pooled embeddings need the whole sequence in one ubatch.
        Kind::Embed => base
            .with_n_batch(n_ctx)
            .with_n_ubatch(n_ctx)
            .with_embeddings(true)
            .with_pooling_type(LlamaPoolingType::Mean),
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The chat format of the loaded model, decided once at load
/// ([`decide_format`]), with the token ids that go with it.
struct ChatFormat {
    prompt: PromptFormat,
    /// The template of the GGUF, for [`PromptFormat::Gguf`].
    template: Option<LlamaChatTemplate>,
    /// The thinking marks this model has, if any.
    think: Option<ThinkStyle>,
    /// For [`ThinkStyle::Tags`]: what the template does with the switch.
    tags: TagsPlan,
    /// Thinking marks that are ONE token in this vocabulary: opening token,
    /// closing token, style. The generation loop compares ids, because a
    /// control token renders as nothing and would pass the text unseen.
    marks: Vec<(LlamaToken, LlamaToken, ThinkStyle)>,
}

/// The token a text is, when it is exactly one.
fn single_token(model: &LlamaModel, text: &str) -> Option<LlamaToken> {
    match model.str_to_token(text, AddBos::Never).ok()?.as_slice() {
        [one] => Some(*one),
        _ => None,
    }
}

fn resolve_format(model: &LlamaModel) -> Result<ChatFormat, String> {
    let template = model.chat_template(None).ok();
    let text = template.as_ref().and_then(|t| t.to_string().ok());
    let recognised = template.as_ref().is_some_and(|t| {
        LlamaChatMessage::new("user".to_string(), "Hello".to_string())
            .ok()
            .is_some_and(|m| model.apply_chat_template(t, &[m], true).is_ok())
    });
    let chatml_tokens = single_token(model, "<|im_start|>").is_some() && single_token(model, "<|im_end|>").is_some();
    let prompt = decide_format(text.as_deref(), recognised, chatml_tokens).map_err(str::to_string)?;
    if prompt == PromptFormat::ChatMl {
        tracing::warn!(
            target: "engine",
            has_template = text.is_some(),
            "llama.cpp cannot use the chat template of this model, using ChatML because its vocabulary has the ChatML tokens"
        );
    }
    let think = decide_think_style(prompt, text.as_deref());
    let mut marks = Vec::new();
    for (open, close, style) in [("<think>", "</think>", ThinkStyle::Tags), ("<|channel>", "<channel|>", ThinkStyle::Channel)] {
        if let (Some(o), Some(c)) = (single_token(model, open), single_token(model, close)) {
            marks.push((o, c, style));
        }
    }
    Ok(ChatFormat {
        prompt,
        template: if prompt == PromptFormat::Gguf { template } else { None },
        think,
        tags: tags_plan(text.as_deref().unwrap_or("")),
        marks,
    })
}

/// Write the conversation the way this model was trained to read it.
/// Returns the prompt and the thinking block it ends inside, if it does.
///
/// `thinking`: the wish of the request ([`thinking_wish`]). A `<think>` model
/// gets what its own template would have written for that wish
/// ([`tags_suffix`]). For Gemma 4 "on" opens the system turn with `<|think|>`,
/// and it does not think otherwise.
///
/// There is no fallback to another format in here. A prompt in the wrong
/// format is a wrong answer that looks like a right one.
///
/// `prefill`: the answer that is already there (engine_continue.rs). The
/// prompt then ends inside the open turn of the assistant, after that text,
/// and the model writes its next token. It does not think again: a `<think>`
/// model reads the empty block its template writes with thinking off, and
/// Gemma 4 gets no `<|think|>`.
fn build_prompt(
    model: &LlamaModel,
    format: &ChatFormat,
    msgs: &[(String, String)],
    thinking: Option<bool>,
    prefill: Option<&str>,
) -> Result<(String, Option<ThinkStyle>), String> {
    let mut prompt = match format.prompt {
        PromptFormat::Gemma4 => {
            let mut prompt = gemma4_prompt(msgs, thinking == Some(true) && prefill.is_none());
            prompt.push_str(prefill.unwrap_or(""));
            return Ok((prompt, None));
        }
        PromptFormat::ChatMl => chatml_prompt(msgs),
        PromptFormat::Gguf => {
            let lmsgs: Vec<LlamaChatMessage> = msgs
                .iter()
                .filter_map(|(r, c)| LlamaChatMessage::new(r.clone(), c.clone()).ok())
                .collect();
            let template = format.template.as_ref().ok_or("the chat template of this model is missing")?;
            model
                .apply_chat_template(template, &lmsgs, true)
                .map_err(|e| format!("the chat template of this model could not be applied: {e}"))?
        }
    };
    if let Some(text) = prefill {
        if format.think == Some(ThinkStyle::Tags) {
            prompt.push_str(EMPTY_THINK_BLOCK);
        }
        prompt.push_str(text);
        return Ok((prompt, None));
    }
    if format.think != Some(ThinkStyle::Tags) {
        return Ok((prompt, None));
    }
    let (suffix, inside) = tags_suffix(format.tags, thinking);
    prompt.push_str(suffix);
    Ok((prompt, inside.then_some(ThinkStyle::Tags)))
}

/// The self-test: the desktop probe's question (`engine_sanity::PROBE_PROMPT`),
/// answered greedily, cut at `engine_sanity::PROBE_TOKENS`. Greedy so that the
/// same build gives the same answer every time. Whatever goes wrong inside
/// comes back as an empty answer, which the judge treats as "cannot say", and
/// a test that cannot say must never be the reason a card is switched off.
///
/// Thinking counts as text here: what is judged is whether the card computes
/// readable words, and a thinking model spends its first 24 tokens thinking.
fn selftest_answer(model: &LlamaModel, ctx: &mut LlamaContext, n_ctx: u32, format: &ChatFormat, abort: &AtomicBool) -> String {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Item>();
    run_chat(
        model,
        ctx,
        n_ctx,
        format,
        ChatJob {
            messages: vec![("user".to_string(), engine_sanity::PROBE_PROMPT.to_string())],
            temperature: Some(0.0),
            top_p: None,
            max_tokens: None,
            hard_cap: Some(engine_sanity::PROBE_TOKENS),
            thinking: None,
            prefill: None,
            out: tx,
        },
        abort,
    );
    let mut text = String::new();
    while let Ok(item) = rx.try_recv() {
        if let Item::Token(t) | Item::Thought(t) = item {
            text.push_str(&t);
        }
    }
    // The next request starts from an empty cache either way (`run_chat`
    // clears it), this only keeps the test from leaving anything behind.
    ctx.clear_kv_cache();
    text
}

/// The blanks a model opens with after a text that ended in blanks are not
/// part of the answer ([`Prefill::drop_lead`]). Thoughts pass as they are.
fn trim_lead(lead: &mut LeadTrim, pieces: Vec<Piece>) -> Vec<Piece> {
    pieces
        .into_iter()
        .filter_map(|piece| match piece {
            Piece::Answer(text) => {
                let text = lead.push(&text);
                (!text.is_empty()).then_some(Piece::Answer(text))
            }
            thought => Some(thought),
        })
        .collect()
}

/// Send sorted pieces on. False when nobody listens any more.
fn send_pieces(out: &tokio::sync::mpsc::UnboundedSender<Item>, pieces: Vec<Piece>) -> bool {
    for piece in pieces {
        let item = match piece {
            Piece::Answer(t) => Item::Token(t),
            Piece::Thought(t) => Item::Thought(t),
        };
        if out.send(item).is_err() {
            return false;
        }
    }
    true
}

fn run_chat(model: &LlamaModel, ctx: &mut LlamaContext, n_ctx: u32, format: &ChatFormat, job: ChatJob, abort: &AtomicBool) {
    let out = job.out;
    ctx.clear_kv_cache();

    // Make the request fit instead of refusing it.
    //
    // The frontend budgets with a characters-by-four estimate. That is the
    // English figure. German runs closer to 2.8 characters per token and code
    // to 3, so a history the budget had just approved could really be over
    // the window, and the turn died on an English sentence about context
    // sizes with nothing the user could do about it. This is the only place
    // that knows the real count, so this is where it is fixed.
    //
    // Oldest first, and in pairs where the pair is a question and its answer,
    // so the alternation the strict chat templates want survives. The system
    // prompt and the message being answered are never dropped.
    let mut msgs = job.messages;
    let mut dropped = 0usize;
    // Going on with a cut answer: the text the prompt ends with. It is never
    // dropped with the old messages. When nothing else can go and it still
    // does not fit with room for more, it loses its beginning
    // (`engine_continue::shorter_tail`).
    let mut lead = LeadTrim::new(job.prefill.as_ref().is_some_and(|p| p.drop_lead));
    let mut prefill: Option<String> = job.prefill.map(|p| p.text);
    let mut prefill_cut = 0usize;
    let (tokens, starts_inside) = loop {
        let (prompt, starts_inside) = match build_prompt(model, format, &msgs, job.thinking, prefill.as_deref()) {
            Ok(p) => p,
            Err(e) => {
                let _ = out.send(Item::Error(e));
                return;
            }
        };
        let tokens = match model.str_to_token(&prompt, AddBos::Always) {
            Ok(t) => t,
            Err(e) => {
                let _ = out.send(Item::Error(format!("tokenize: {e}")));
                return;
            }
        };
        let n = tokens.len() as u32;
        let first = usize::from(msgs.first().is_some_and(|(r, _)| r == "system"));
        let can_drop = msgs.len() > first + 1;
        // A caller may ask for a window as small as 512. Reserving 512 of it
        // for the answer would drop the whole history every time, so the
        // reserve is a share of the window, not a fixed number.
        let reserve = REPLY_RESERVE.min(n_ctx / 4);
        if n + reserve >= n_ctx && !can_drop {
            if let Some(shorter) = prefill.as_deref().and_then(engine_continue::shorter_tail).map(str::to_string) {
                prefill = Some(shorter);
                prefill_cut += 1;
                continue;
            }
        }
        if n + reserve < n_ctx || !can_drop {
            // One last check for the case nothing could be dropped: a single
            // message longer than the whole window is the one request that
            // really cannot be served.
            if n + 8 >= n_ctx {
                let _ = out.send(Item::Error(format!(
                    "the request exceeds the available context size ({n} prompt tokens, context {n_ctx})"
                )));
                return;
            }
            break (tokens, starts_inside);
        }
        msgs.remove(first);
        dropped += 1;
        if msgs.len() > first + 1 && msgs[first].0 == "assistant" {
            msgs.remove(first);
            dropped += 1;
        }
    };
    if dropped > 0 {
        tracing::info!(target: "engine", dropped, n_ctx, "dropped old messages to fit the context");
    }
    if prefill_cut > 0 {
        tracing::info!(target: "engine", prefill_cut, n_ctx, "going on from the end of the answer, its beginning did not fit the context");
    }
    let n_prompt = tokens.len() as u32;

    let mut batch = LlamaBatch::new(N_BATCH as usize, 1);
    let mut pos: i32 = 0;
    let total = tokens.len();
    for chunk in tokens.chunks(N_BATCH as usize) {
        if abort.load(Ordering::Relaxed) || out.is_closed() {
            return;
        }
        batch.clear();
        let chunk_end = pos as usize + chunk.len();
        for (i, t) in chunk.iter().enumerate() {
            let is_last_of_prompt = chunk_end == total && i + 1 == chunk.len();
            if batch.add(*t, pos + i as i32, &[0], is_last_of_prompt).is_err() {
                let _ = out.send(Item::Error("prompt batch overflow".into()));
                return;
            }
        }
        pos += chunk.len() as i32;
        if let Err(e) = ctx.decode(&mut batch) {
            let _ = out.send(Item::Error(format!("prompt decode: {e}")));
            return;
        }
    }

    let temp = job.temperature.unwrap_or(0.8);
    let mut sampler = if temp <= 0.0 {
        LlamaSampler::greedy()
    } else {
        LlamaSampler::chain_simple([
            LlamaSampler::temp(temp),
            LlamaSampler::top_p(job.top_p.unwrap_or(0.95), 1),
            LlamaSampler::dist(rand::random::<u32>()),
        ])
    };

    // Three limits. `budget` is what the window still holds, and nothing gets
    // past it. `answer_cap` is the caller's `max_tokens` and counts the answer
    // only. `think_cap` is the engine's own limit for a thinking block.
    let window = (n_ctx - n_prompt).saturating_sub(4);
    let budget = job.hard_cap.unwrap_or(u32::MAX).min(window).max(1);
    let answer_cap = job.max_tokens.unwrap_or(budget).max(1);
    // From the window, not from `hard_cap`: the self-test stops after 24
    // tokens anyway and must not have a block closed for it at 12.
    let think_cap = think_budget(window, n_ctx);
    let mut decoder = encoding_rs::UTF_8.new_decoder();
    let mut stop = StopFilter::default();
    let mut split = starts_inside.map(ThinkSplitter::inside).unwrap_or_default();
    let mut generated: u32 = 0;
    let mut thought: u32 = 0;
    let mut answered: u32 = 0;
    let mut closed_by_engine = false;
    let mut finish: &'static str = "length";

    while generated < budget && answered < answer_cap {
        if abort.load(Ordering::Relaxed) || out.is_closed() {
            return; // client gone or engine stopping, no terminal chunk needed
        }
        let tok = sampler.sample(ctx, -1);
        if model.is_eog_token(tok) {
            finish = "stop";
            break;
        }
        generated += 1;

        let pieces = if let Some(&(_, _, style)) = format.marks.iter().find(|(open, _, _)| *open == tok) {
            split.open(style)
        } else if format.marks.iter().any(|(_, close, _)| *close == tok) {
            split.close()
        } else {
            let piece = model.token_to_piece(tok, &mut decoder, false, None).unwrap_or_default();
            let shown = stop.push(&piece);
            split.push(&shown)
        };
        if !send_pieces(&out, trim_lead(&mut lead, pieces)) {
            return;
        }
        if stop.hit() {
            // A turn marker as plain text. The answer ends here, see STOP_MARKERS.
            finish = "stop";
            break;
        }
        if split.thinking() {
            thought += 1;
        } else {
            answered += 1;
        }

        batch.clear();
        if batch.add(tok, pos, &[0], true).is_err() {
            break;
        }
        pos += 1;
        if let Err(e) = ctx.decode(&mut batch) {
            let _ = out.send(Item::Error(format!("decode: {e}")));
            return;
        }

        // The thinking has used its share. Close the block for the model, so
        // that what is left of the window goes into an answer. Once per turn:
        // a model that opens a second block afterwards is not chased.
        if !closed_by_engine && thought >= think_cap {
            if let Some(style) = split.open_style() {
                closed_by_engine = true;
                let closing = model.str_to_token(style.closing_text(), AddBos::Never).unwrap_or_default();
                if !closing.is_empty() && generated + (closing.len() as u32) < budget {
                    batch.clear();
                    let last = closing.len() - 1;
                    let fits = closing.iter().enumerate().all(|(i, t)| batch.add(*t, pos + i as i32, &[0], i == last).is_ok());
                    if !fits {
                        break;
                    }
                    pos += closing.len() as i32;
                    if let Err(e) = ctx.decode(&mut batch) {
                        let _ = out.send(Item::Error(format!("decode: {e}")));
                        return;
                    }
                    generated += closing.len() as u32;
                    tracing::info!(target: "engine", thought, think_cap, "closed the thinking block for the model");
                    if !send_pieces(&out, split.close()) {
                        return;
                    }
                }
            }
        }
    }

    // What the two filters still held back.
    let tail = stop.finish();
    let mut rest = split.push(&tail);
    rest.extend(split.finish());
    if !send_pieces(&out, trim_lead(&mut lead, rest)) {
        return;
    }

    let _ = out.send(Item::Done {
        finish_reason: finish,
        prompt_tokens: n_prompt,
        completion_tokens: generated,
    });
}

fn l2_normalize(v: &[f32]) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        v.iter().map(|x| x / norm).collect()
    } else {
        v.to_vec()
    }
}

fn run_embed(model: &LlamaModel, ctx: &mut LlamaContext, n_batch: usize, job: EmbedJob, abort: &AtomicBool) {
    let mut all: Vec<Vec<f32>> = Vec::with_capacity(job.inputs.len());
    let mut batch = LlamaBatch::new(n_batch, 1);
    for text in &job.inputs {
        if abort.load(Ordering::Relaxed) || job.out.is_closed() {
            return;
        }
        let mut tokens = match model.str_to_token(text, AddBos::Always) {
            Ok(t) => t,
            Err(e) => {
                let _ = job.out.send(Item::Error(format!("tokenize: {e}")));
                return;
            }
        };
        tokens.truncate(n_batch);
        if tokens.is_empty() {
            all.push(vec![0.0; model.n_embd().max(0) as usize]);
            continue;
        }
        ctx.clear_kv_cache();
        batch.clear();
        if let Err(e) = batch.add_sequence(&tokens, 0, true) {
            let _ = job.out.send(Item::Error(format!("embed batch: {e}")));
            return;
        }
        // BERT-style embedding models run through decode (non-causal graph);
        // encoder-only architectures need encode. Tried in that order.
        if ctx.decode(&mut batch).is_err() {
            if let Err(e) = ctx.encode(&mut batch) {
                let _ = job.out.send(Item::Error(format!("embed decode: {e}")));
                return;
            }
        }
        match ctx.embeddings_seq_ith(0) {
            Ok(e) => all.push(l2_normalize(e)),
            Err(e) => {
                let _ = job.out.send(Item::Error(format!("embeddings: {e}")));
                return;
            }
        }
    }
    let _ = job.out.send(Item::Embeddings(all));
}

// ── HTTP server thread ──────────────────────────────────────────────────────

/// The origins the app's own WebView has: `tauri://localhost` on iOS (and on
/// macOS), `http://tauri.localhost` on Android, `https://` there when the
/// config asks for it.
///
/// The app talks to the engine through the Rust proxy first, and a request
/// from Rust has no origin. The direct `fetch` from the page is the fallback,
/// and that one is cross-origin: without these headers WebKit refuses it
/// ("Origin tauri://localhost is not allowed by Access-Control-Allow-Origin",
/// and a 405 on the preflight of every POST; measured in the iOS Simulator on
/// 2026-10-08). The desktop sidecar answers such requests too.
///
/// Since the engine asks for its token (engine_token.rs), which the page does
/// not have, that fallback gets a 401: the proxy is the one way in. The
/// preflight is still answered, so the page reads the 401 instead of a CORS
/// failure.
///
/// Deliberately a list and not `*`: with `*` any web page open in the phone's
/// browser could read answers from the model while the app runs.
pub(crate) const WEBVIEW_ORIGINS: [&str; 3] = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

fn webview_cors() -> tower_http::cors::CorsLayer {
    use axum::http::{HeaderValue, Method};
    tower_http::cors::CorsLayer::new()
        .allow_origin(WEBVIEW_ORIGINS.map(HeaderValue::from_static))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(tower_http::cors::Any)
}

/// Every route asks for the token of this start (engine_token.rs). Loopback
/// is shared by all apps on a phone: without it any of them could use the
/// loaded model. 401 with no detail, the caller is not one of ours.
async fn require_token(request: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let given = request
        .headers()
        .get(engine_token::HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !engine_token::matches(given) {
        return oai_error(StatusCode::UNAUTHORIZED, "This engine only answers the app that started it.");
    }
    next.run(request).await
}

fn spawn_server(
    port: u16,
    shared: Arc<Shared>,
    cancel: CancellationToken,
    bind_tx: std_mpsc::Sender<Result<(), String>>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => {
                let _ = bind_tx.send(Err(format!("tokio runtime: {e}")));
                return;
            }
        };
        rt.block_on(async move {
            let app = Router::new()
                .route("/health", get(http_health))
                .route("/props", get(http_props))
                .route("/v1/models", get(http_models))
                .route("/v1/models/{id}", get(http_model_by_id))
                .route("/v1/chat/completions", post(http_chat_completions))
                .route("/v1/embeddings", post(http_embeddings))
                // Inside the CORS layer, so the preflight of the page (which
                // carries no headers of its own) is still answered.
                .layer(axum::middleware::from_fn(require_token))
                .layer(webview_cors())
                .with_state(shared);
            // Loopback only. Nothing outside the device can reach it.
            let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                Ok(l) => l,
                Err(e) => {
                    let _ = bind_tx.send(Err(crate::os_error::english(&e)));
                    return;
                }
            };
            // From here on the proxy adds the token to requests for this
            // port, and stops when the server ends.
            let _held = engine_token::BoundPort::hold(port);
            let _ = bind_tx.send(Ok(()));
            if let Err(e) = axum::serve(listener, app)
                .with_graceful_shutdown(async move { cancel.cancelled().await })
                .await
            {
                tracing::warn!(target: "engine", "the in-process HTTP server ended: {e}");
            }
        });
    })
}

fn oai_error(status: StatusCode, msg: &str) -> Response {
    (status, Json(oai::error_body(msg, status.as_u16()))).into_response()
}

/// llama-server's `/props`, which is how the frontend asks a server what it
/// can do. Without this route the probe got a 404, read that as "nobody said
/// anything" and left the strategy on `native`, so the request carried an
/// OpenAI `tools` array that `http_chat_completions` throws away: the model
/// never saw a single tool schema (old Android finding F8).
///
/// `supports_tools` is false because it is false. This engine has no native
/// tool-call channel, and saying so lets the strategy layer make the same
/// choice it makes for any desktop server whose template lacks one.
async fn http_props(HttpState(s): HttpState<Arc<Shared>>) -> Response {
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "chat_template_caps": {"supports_tools": false},
            // Not llama-server's: what this engine knows about the loaded
            // model. `thinking` says the Thinking switch has an effect.
            "lu": {
                "thinking": s.thinks.load(Ordering::Relaxed),
                "chat_format": s.format.get().copied(),
            },
            "default_generation_settings": {"n_ctx": s.n_ctx.load(Ordering::Relaxed)},
            "n_ctx": s.n_ctx.load(Ordering::Relaxed),
            "model_path": s.model_name,
        })),
    )
        .into_response()
}

async fn http_health(HttpState(s): HttpState<Arc<Shared>>) -> Response {
    if s.loaded.load(Ordering::Relaxed) {
        (StatusCode::OK, Json(serde_json::json!({"status": "ok"}))).into_response()
    } else {
        // llama-server's 503 shape while the model is loading.
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": {"code": 503, "message": "Loading model", "type": "unavailable_error"}
            })),
        )
            .into_response()
    }
}

async fn http_models(HttpState(s): HttpState<Arc<Shared>>) -> Response {
    Json(serde_json::json!({
        "object": "list",
        "data": [{
            "id": s.model_name,
            "object": "model",
            "created": now_secs(),
            "owned_by": "llamacpp",
        }],
    }))
    .into_response()
}

/// `/v1/models/{id}`: the frontend probes this for the real context window.
/// Reporting the LOADED n_ctx keeps its max_tokens budget honest.
async fn http_model_by_id(HttpState(s): HttpState<Arc<Shared>>, UrlPath(id): UrlPath<String>) -> Response {
    if id != s.model_name {
        return oai_error(StatusCode::NOT_FOUND, &format!("model '{id}' not found"));
    }
    Json(serde_json::json!({
        "id": s.model_name,
        "object": "model",
        "created": now_secs(),
        "owned_by": "llamacpp",
        "context_window": s.n_ctx.load(Ordering::Relaxed),
    }))
    .into_response()
}

/// Flatten OpenAI message content (a plain string OR an array of parts) to
/// text. Image parts are dropped: this engine is text only.
fn content_text(v: Option<&serde_json::Value>) -> String {
    match v {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| {
                if p.get("type").and_then(|t| t.as_str()) == Some("text") {
                    p.get("text").and_then(|t| t.as_str()).map(str::to_string)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

async fn http_chat_completions(
    HttpState(s): HttpState<Arc<Shared>>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if s.kind != Kind::Chat {
        return oai_error(
            StatusCode::NOT_IMPLEMENTED,
            "this server runs in embeddings mode and does not serve chat",
        );
    }
    if !s.loaded.load(Ordering::Relaxed) {
        return oai_error(StatusCode::SERVICE_UNAVAILABLE, "Loading model");
    }
    let msgs = match body.get("messages").and_then(|m| m.as_array()) {
        Some(a) if !a.is_empty() => a,
        _ => return oai_error(StatusCode::BAD_REQUEST, "\"messages\" must be a non-empty array"),
    };
    // NUL bytes would fail the CString conversion inside the chat template.
    let messages: Vec<(String, String)> = msgs
        .iter()
        .map(|m| {
            (
                m.get("role").and_then(|r| r.as_str()).unwrap_or("user").to_string(),
                content_text(m.get("content")).replace('\0', ""),
            )
        })
        .collect();
    // Unknown fields (`model`, `tools`) are IGNORED on
    // purpose, not answered with a 400. llama-server is as lenient, so the
    // frontend never needs its strip-and-retry against this engine.
    let stream = body.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
    let include_usage = body
        .pointer("/stream_options/include_usage")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let temperature = body.get("temperature").and_then(|v| v.as_f64()).map(|v| v as f32);
    let top_p = body.get("top_p").and_then(|v| v.as_f64()).map(|v| v as f32);
    let max_tokens = body
        .get("max_tokens")
        .or_else(|| body.get("max_completion_tokens"))
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok());

    let thinking = thinking_wish(&body);
    // "Continue" on a cut answer: the last message is that answer, and the
    // model goes on inside it instead of starting a new one.
    let (messages, prefill) = engine_continue::split_prefill(messages, engine_continue::wants_continue(&body));

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Item>();
    let job = Job::Chat(ChatJob { messages, temperature, top_p, max_tokens, hard_cap: None, thinking, prefill, out: tx });
    let sent = match s.cmd_tx.lock() {
        Ok(g) => g.send(job).is_ok(),
        Err(_) => false,
    };
    if !sent {
        return oai_error(StatusCode::SERVICE_UNAVAILABLE, "the engine is shutting down");
    }

    let created = now_secs();
    let id = format!("chatcmpl-{}", uuid::Uuid::new_v4().simple());
    let model_name = s.model_name.clone();

    if stream {
        let (etx, mut erx) = tokio::sync::mpsc::unbounded_channel::<Event>();
        tokio::spawn(async move {
            while let Some(item) = rx.recv().await {
                match item {
                    Item::Token(t) => {
                        let chunk = oai::stream_delta(&id, created, &model_name, &t);
                        if etx.send(Event::default().data(chunk.to_string())).is_err() {
                            return; // SSE client gone: rx drops, the worker stops
                        }
                    }
                    Item::Thought(t) => {
                        let chunk = oai::stream_reasoning(&id, created, &model_name, &t);
                        if etx.send(Event::default().data(chunk.to_string())).is_err() {
                            return;
                        }
                    }
                    Item::Done { finish_reason, prompt_tokens, completion_tokens } => {
                        let fin = oai::stream_finish(&id, created, &model_name, finish_reason);
                        let _ = etx.send(Event::default().data(fin.to_string()));
                        if include_usage {
                            let usage =
                                oai::stream_usage(&id, created, &model_name, prompt_tokens, completion_tokens);
                            let _ = etx.send(Event::default().data(usage.to_string()));
                        }
                        let _ = etx.send(Event::default().data("[DONE]"));
                        return;
                    }
                    Item::Error(e) => {
                        // A failure in the middle of a 200 stream goes out as
                        // an SSE error chunk, as llama-server does it. The
                        // frontend throws on `chunk.error`.
                        let err = serde_json::json!({"error": {"message": e, "type": "server_error"}});
                        let _ = etx.send(Event::default().data(err.to_string()));
                        return;
                    }
                    Item::Embeddings(_) => return,
                }
            }
        });
        let stream = futures_util::stream::poll_fn(move |cx| erx.poll_recv(cx))
            .map(Ok::<_, std::convert::Infallible>);
        return Sse::new(stream).into_response();
    }

    // Not streamed: collect until Done or Error.
    let mut content = String::new();
    let mut reasoning = String::new();
    let finish;
    let (pt, ct);
    loop {
        match rx.recv().await {
            Some(Item::Token(t)) => content.push_str(&t),
            Some(Item::Thought(t)) => reasoning.push_str(&t),
            Some(Item::Done { finish_reason, prompt_tokens, completion_tokens }) => {
                finish = finish_reason;
                pt = prompt_tokens;
                ct = completion_tokens;
                break;
            }
            Some(Item::Error(e)) => return oai_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
            Some(Item::Embeddings(_)) | None => {
                return oai_error(StatusCode::INTERNAL_SERVER_ERROR, "engine stopped mid-request")
            }
        }
    }
    Json(oai::completion(&oai::Completion {
        id: &id,
        created,
        model: &s.model_name,
        content: &content,
        reasoning: &reasoning,
        finish_reason: finish,
        prompt_tokens: pt,
        completion_tokens: ct,
    }))
    .into_response()
}

async fn http_embeddings(
    HttpState(s): HttpState<Arc<Shared>>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if s.kind != Kind::Embed {
        return oai_error(StatusCode::NOT_IMPLEMENTED, "this server was not started in embeddings mode");
    }
    if !s.loaded.load(Ordering::Relaxed) {
        return oai_error(StatusCode::SERVICE_UNAVAILABLE, "Loading model");
    }
    let inputs: Vec<String> = match body.get("input") {
        Some(serde_json::Value::String(t)) => vec![t.clone()],
        Some(serde_json::Value::Array(a)) => a.iter().map(|v| v.as_str().unwrap_or("").to_string()).collect(),
        _ => return oai_error(StatusCode::BAD_REQUEST, "\"input\" must be a string or an array of strings"),
    };
    if inputs.is_empty() {
        return oai_error(StatusCode::BAD_REQUEST, "\"input\" must not be empty");
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Item>();
    let sent = match s.cmd_tx.lock() {
        Ok(g) => g.send(Job::Embed(EmbedJob { inputs, out: tx })).is_ok(),
        Err(_) => false,
    };
    if !sent {
        return oai_error(StatusCode::SERVICE_UNAVAILABLE, "the engine is shutting down");
    }

    match rx.recv().await {
        Some(Item::Embeddings(vecs)) => {
            let data: Vec<serde_json::Value> = vecs
                .into_iter()
                .enumerate()
                .map(|(i, e)| serde_json::json!({"object": "embedding", "index": i, "embedding": e}))
                .collect();
            Json(serde_json::json!({
                "object": "list",
                "model": s.model_name,
                "data": data,
                "usage": {"prompt_tokens": 0, "total_tokens": 0},
            }))
            .into_response()
        }
        Some(Item::Error(e)) => oai_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
        _ => oai_error(StatusCode::INTERNAL_SERVER_ERROR, "engine stopped mid-request"),
    }
}

// ── The OpenAI wire shapes ──────────────────────────────────────────────────

/// The JSON this engine puts on the wire, one function per shape, so the
/// shapes are tested without a model. They are llama-server's: the frontend
/// parses one format and must not be able to tell the two engines apart.
pub(crate) mod oai {
    use serde_json::{json, Value};

    /// One streamed piece of the answer.
    pub(crate) fn stream_delta(id: &str, created: u64, model: &str, text: &str) -> Value {
        json!({
            "id": id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {"content": text},
                "finish_reason": null,
            }],
        })
    }

    /// One streamed piece of the model's thinking. `reasoning_content` is the
    /// field llama-server uses for it, and the one the frontend reads into
    /// its thinking block (api/providers/openai-provider.ts).
    pub(crate) fn stream_reasoning(id: &str, created: u64, model: &str, text: &str) -> Value {
        json!({
            "id": id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {"reasoning_content": text},
                "finish_reason": null,
            }],
        })
    }

    /// The last chunk that carries a choice: an empty delta and the reason.
    pub(crate) fn stream_finish(id: &str, created: u64, model: &str, finish_reason: &str) -> Value {
        json!({
            "id": id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": finish_reason,
            }],
        })
    }

    /// The usage chunk of `stream_options.include_usage`: no choices at all,
    /// sent after the finish chunk and before `[DONE]`.
    pub(crate) fn stream_usage(id: &str, created: u64, model: &str, prompt: u32, completion: u32) -> Value {
        json!({
            "id": id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [],
            "usage": {
                "prompt_tokens": prompt,
                "completion_tokens": completion,
                "total_tokens": prompt + completion,
            },
        })
    }

    /// What the whole answer of a request without a stream is made of.
    pub(crate) struct Completion<'a> {
        pub id: &'a str,
        pub created: u64,
        pub model: &'a str,
        pub content: &'a str,
        /// The model's thinking, empty when it did not think.
        pub reasoning: &'a str,
        pub finish_reason: &'a str,
        pub prompt_tokens: u32,
        pub completion_tokens: u32,
    }

    /// The whole answer of a request that did not ask for a stream.
    pub(crate) fn completion(c: &Completion<'_>) -> Value {
        let mut message = json!({"role": "assistant", "content": c.content});
        // Only when the model thought: an answer without thinking has the
        // plain shape it always had.
        if !c.reasoning.is_empty() {
            message["reasoning_content"] = json!(c.reasoning);
        }
        json!({
            "id": c.id,
            "object": "chat.completion",
            "created": c.created,
            "model": c.model,
            "choices": [{
                "index": 0,
                "message": message,
                "finish_reason": c.finish_reason,
            }],
            "usage": {
                "prompt_tokens": c.prompt_tokens,
                "completion_tokens": c.completion_tokens,
                "total_tokens": c.prompt_tokens + c.completion_tokens,
            },
        })
    }

    /// The body of an error answer.
    pub(crate) fn error_body(message: &str, code: u16) -> Value {
        let kind = match code {
            400 => "invalid_request_error",
            404 => "not_found_error",
            501 => "not_supported_error",
            503 => "unavailable_error",
            _ => "server_error",
        };
        json!({"error": {"code": code, "message": message, "type": kind}})
    }
}

// ── Memory pressure ─────────────────────────────────────────────────────────
//
// A phone that runs out of memory does not swap, it ends the app. Both
// systems say so shortly before: iOS with a memory warning, Android through
// onTrimMemory. The native layer turns both into one event with a level
// (plugins/lu-native, `memory-warning`), and `commands::mobile_native::setup`
// hands it to `on_memory_warning` on the Rust side, so the reaction does not
// depend on a webview being awake.
//
// The reaction is to give memory back, starting with what is cheapest to
// lose. A smaller context would need the model loaded again, which costs
// more memory before it saves any, so the engine is unloaded instead and the
// app says so. The next message loads it again.

/// What to give up at a memory warning.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MemoryReaction {
    Nothing,
    /// The embeddings model. Only document chat uses it, and it loads again
    /// on the next question about a document.
    UnloadEmbeddings,
    /// Chat model and embeddings model.
    UnloadEverything,
}

/// The decision, apart from the doing, so it can be tested.
///
/// `low`: the system is short. The embeddings model goes if there is one,
/// the chat model stays, because a running answer is worth more than the
/// memory. `critical`: the next step is the end of the app, and with it the
/// answer, the model and everything unsaved. So everything goes. A level
/// nobody knows counts as critical: an unknown warning is still a warning.
pub(crate) fn memory_reaction(level: &str, chat_loaded: bool, embed_loaded: bool) -> MemoryReaction {
    if !chat_loaded && !embed_loaded {
        return MemoryReaction::Nothing;
    }
    match level {
        "low" if embed_loaded => MemoryReaction::UnloadEmbeddings,
        "low" => MemoryReaction::Nothing,
        _ => MemoryReaction::UnloadEverything,
    }
}

/// Sent to the frontend when the engine was unloaded for memory. Payload:
/// `{ level, chat, embeddings, message }`, the two flags say what went.
pub const MEMORY_UNLOAD_EVENT: &str = "lu-engine-memory-unload";

/// The sentence for the user.
pub(crate) const MEMORY_UNLOAD_MESSAGE: &str =
    "The model was unloaded because this device was running out of memory. It loads again with your next message. A smaller model or closing other apps helps.";

/// Warnings come in bursts. One reaction per burst is enough.
const MEMORY_REACTION_PAUSE: Duration = Duration::from_secs(3);
static LAST_MEMORY_REACTION: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// True when a reaction ran so recently that this warning belongs to it.
/// Only asks. The pause starts in `note_memory_reaction`, and only when
/// something was really unloaded: a warning that found nothing to unload must
/// not make the next one deaf (M9).
fn memory_reaction_is_recent(now: std::time::Instant) -> bool {
    let last = LAST_MEMORY_REACTION.lock().unwrap_or_else(|p| p.into_inner());
    last.is_some_and(|at| now.duration_since(at) < MEMORY_REACTION_PAUSE)
}

/// A model was unloaded for a warning at `now`: the burst it belongs to is
/// answered.
fn note_memory_reaction(now: std::time::Instant) {
    *LAST_MEMORY_REACTION.lock().unwrap_or_else(|p| p.into_inner()) = Some(now);
}

// ── A warning while a model is being loaded (M9) ────────────────────────────
//
// During a load the handle is not in the state yet, so a warning finds
// nothing to unload and used to be dropped. The model then landed in memory
// and the system ended the app. Now the warning is remembered and answered
// the moment the load returns.

/// How many loads are running, and the worst warning that arrived meanwhile.
static LOADS_RUNNING: Mutex<(u32, Option<String>)> = Mutex::new((0, None));

/// Held for as long as a model is being loaded.
pub(crate) struct LoadInProgress(());

impl LoadInProgress {
    pub(crate) fn begin() -> Self {
        let mut loads = LOADS_RUNNING.lock().unwrap_or_else(|p| p.into_inner());
        if loads.0 == 0 {
            // A warning from before this load was answered then, or had
            // nothing to do with it.
            loads.1 = None;
        }
        loads.0 += 1;
        Self(())
    }
}

impl Drop for LoadInProgress {
    fn drop(&mut self) {
        let mut loads = LOADS_RUNNING.lock().unwrap_or_else(|p| p.into_inner());
        loads.0 = loads.0.saturating_sub(1);
    }
}

/// Remember a warning when a load is running. `critical` (and every level
/// nobody knows) outweighs `low`. Returns whether it was remembered.
pub(crate) fn remember_warning_during_load(level: &str) -> bool {
    let mut loads = LOADS_RUNNING.lock().unwrap_or_else(|p| p.into_inner());
    if loads.0 == 0 {
        return false;
    }
    let keeps_old = loads.1.as_deref().is_some_and(|old| old != "low") && level == "low";
    if !keeps_old {
        loads.1 = Some(level.to_string());
    }
    true
}

/// The warning that arrived during the load that just returned, once.
pub(crate) fn take_warning_from_load() -> Option<String> {
    LOADS_RUNNING.lock().unwrap_or_else(|p| p.into_inner()).1.take()
}

/// What a load answers when its model was unloaded again right away.
pub(crate) const MEMORY_DURING_LOAD_MESSAGE: &str =
    "The model was not kept loaded because this device ran short of memory while loading it. A smaller model or closing other apps helps.";

/// Give back what `reaction` names and tell the page. Returns (chat,
/// embeddings): what really went.
#[cfg(mobile)]
fn unload_for_memory(app: &tauri::AppHandle, level: &str, reaction: MemoryReaction, message: &str) -> (bool, bool) {
    use tauri::{Emitter, Manager};

    let state = app.state::<crate::state::AppState>();
    let (chat, embeddings) = match reaction {
        MemoryReaction::Nothing => return (false, false),
        MemoryReaction::UnloadEmbeddings => (false, super::engine::stop_embed_locked(&state)),
        MemoryReaction::UnloadEverything => {
            // The small one first: it is gone in an instant, the chat
            // model may have to stop a generation before it can go.
            let embeddings = super::engine::stop_embed_locked(&state);
            (super::engine::stop_engine_for_memory(&state), embeddings)
        }
    };
    if !chat && !embeddings {
        return (false, false);
    }
    note_memory_reaction(std::time::Instant::now());
    tracing::warn!(target: "engine", level = %level, chat, embeddings, "unloaded for a memory warning");
    let _ = app.emit(
        MEMORY_UNLOAD_EVENT,
        serde_json::json!({ "level": level, "chat": chat, "embeddings": embeddings, "message": message }),
    );
    (chat, embeddings)
}

/// React to a memory warning of the system. Returns at once: stopping an
/// engine joins its threads, and this is called from the thread the system
/// delivers the warning on.
#[cfg(mobile)]
pub(crate) fn on_memory_warning(app: &tauri::AppHandle, level: &str) {
    use tauri::Manager;

    // A load is running: its model is not in the state yet. The load answers
    // this warning itself when it returns (`answer_warning_from_load`). What
    // is loaded already is still looked at below.
    let during_load = remember_warning_during_load(level);
    if memory_reaction_is_recent(std::time::Instant::now()) {
        return;
    }
    let app = app.clone();
    let level = level.to_string();
    std::thread::spawn(move || {
        let state = app.state::<crate::state::AppState>();
        let chat_loaded = state.bundled_engine.lock().map(|g| g.is_some()).unwrap_or(false);
        let embed_loaded = state.bundled_embed.lock().map(|g| g.is_some()).unwrap_or(false);
        let reaction = memory_reaction(&level, chat_loaded, embed_loaded);
        if reaction == MemoryReaction::Nothing && during_load {
            tracing::warn!(target: "engine", level = %level, "a memory warning arrived while a model is loading, it is answered after the load");
        }
        unload_for_memory(&app, &level, reaction, MEMORY_UNLOAD_MESSAGE);
    });
}

/// Called by a load right after its model went into the state. When a
/// warning arrived meanwhile it is answered now, with the model counted as
/// loaded. Returns true when the chat model was unloaded again.
#[cfg(mobile)]
pub(crate) fn answer_warning_from_load(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;

    let Some(level) = take_warning_from_load() else { return false };
    let state = app.state::<crate::state::AppState>();
    let chat_loaded = state.bundled_engine.lock().map(|g| g.is_some()).unwrap_or(false);
    let embed_loaded = state.bundled_embed.lock().map(|g| g.is_some()).unwrap_or(false);
    let reaction = memory_reaction(&level, chat_loaded, embed_loaded);
    unload_for_memory(app, &level, reaction, MEMORY_DURING_LOAD_MESSAGE).0
}

#[cfg(test)]
mod tests {
    use super::*;

    const APPLE_DEVICE: Platform = Platform { has_gpu_backend: true, simulator: false };
    const SIMULATOR: Platform = Platform { has_gpu_backend: true, simulator: true };
    const ANDROID: Platform = Platform { has_gpu_backend: false, simulator: false };

    // ── Memory pressure: the decision ───────────────────────────────────────

    #[test]
    fn nothing_loaded_means_nothing_to_give_back() {
        for level in ["low", "critical", "whatever"] {
            assert_eq!(memory_reaction(level, false, false), MemoryReaction::Nothing, "{level}");
        }
    }

    #[test]
    fn a_low_warning_costs_the_embeddings_and_never_the_chat_model() {
        assert_eq!(memory_reaction("low", true, true), MemoryReaction::UnloadEmbeddings);
        assert_eq!(memory_reaction("low", false, true), MemoryReaction::UnloadEmbeddings);
        // Only the chat model is there: a running answer is kept.
        assert_eq!(memory_reaction("low", true, false), MemoryReaction::Nothing);
    }

    #[test]
    fn a_critical_warning_unloads_everything() {
        assert_eq!(memory_reaction("critical", true, false), MemoryReaction::UnloadEverything);
        assert_eq!(memory_reaction("critical", true, true), MemoryReaction::UnloadEverything);
        assert_eq!(memory_reaction("critical", false, true), MemoryReaction::UnloadEverything);
    }

    #[test]
    fn a_level_nobody_knows_counts_as_critical() {
        assert_eq!(memory_reaction("", true, false), MemoryReaction::UnloadEverything);
        assert_eq!(memory_reaction("LOW", true, false), MemoryReaction::UnloadEverything);
    }

    #[test]
    fn a_burst_of_warnings_is_one_reaction() {
        *LAST_MEMORY_REACTION.lock().unwrap() = None;
        let t0 = std::time::Instant::now();
        assert!(!memory_reaction_is_recent(t0), "the first warning reacts");
        // M9: a warning that unloaded nothing starts no pause. The next one,
        // a moment later, is heard.
        assert!(!memory_reaction_is_recent(t0 + Duration::from_millis(200)));
        // Something was unloaded: now the echoes of the burst are skipped.
        note_memory_reaction(t0);
        assert!(memory_reaction_is_recent(t0 + Duration::from_millis(200)), "the echo does not");
        assert!(memory_reaction_is_recent(t0 + Duration::from_secs(2)));
        assert!(!memory_reaction_is_recent(t0 + Duration::from_secs(4)), "a later warning reacts again");
        *LAST_MEMORY_REACTION.lock().unwrap() = None;
    }

    /// M9: the model is loading, the system warns. Nothing is in the state
    /// yet, so the warning is kept and handed to the load when it returns.
    #[test]
    fn a_warning_during_a_load_is_kept_for_the_end_of_the_load() {
        // No load: nothing is remembered.
        assert!(!remember_warning_during_load("critical"));
        assert_eq!(take_warning_from_load(), None);
        {
            let _load = LoadInProgress::begin();
            assert!(remember_warning_during_load("low"));
            assert!(remember_warning_during_load("critical"));
            // A later `low` does not talk the `critical` down.
            assert!(remember_warning_during_load("low"));
        }
        // With the model counted as loaded, the kept warning unloads it.
        let level = take_warning_from_load().expect("the warning was kept");
        assert_eq!(level, "critical");
        assert_eq!(memory_reaction(&level, true, false), MemoryReaction::UnloadEverything);
        // Handed out once.
        assert_eq!(take_warning_from_load(), None);

        // A warning left over from an earlier load does not hit the next one.
        {
            let _load = LoadInProgress::begin();
            assert!(remember_warning_during_load("critical"));
        }
        {
            let _next = LoadInProgress::begin();
        }
        assert_eq!(take_warning_from_load(), None);
        assert!(!MEMORY_DURING_LOAD_MESSAGE.contains('\u{2014}'));
    }

    /// The phone half is not compiled where these tests run, so its wiring
    /// is read from the source.
    #[test]
    fn the_phone_half_keeps_the_warning_and_the_load_answers_it() {
        const SRC: &str = include_str!("engine_inproc.rs");
        const ENGINE: &str = include_str!("engine.rs");
        let warn = &SRC[SRC.find("pub(crate) fn on_memory_warning(").unwrap()..];
        let warn = &warn[..warn.find("\n}\n").unwrap()];
        let keep = warn.find("remember_warning_during_load(level)").expect("the warning is kept");
        let pause = warn.find("memory_reaction_is_recent(").expect("the pause is asked");
        assert!(keep < pause, "kept before the pause can swallow it");
        assert!(!warn.contains("note_memory_reaction"), "the pause starts only where something went");

        let unload = &SRC[SRC.find("fn unload_for_memory(").unwrap()..];
        let unload = &unload[..unload.find("\n}\n").unwrap()];
        let nothing = unload.find("if !chat && !embeddings").expect("nothing unloaded is checked");
        let note = unload.find("note_memory_reaction(").expect("the pause starts here");
        assert!(nothing < note);

        for signature in ["#[cfg(mobile)]\nfn start_bundled_engine_blocking(", "#[cfg(mobile)]\nfn start_bundled_embed_blocking("] {
            let body = &ENGINE[ENGINE.find(signature).unwrap_or_else(|| panic!("{signature} exists"))..];
            let body = &body[..body.find("\n}\n").unwrap()];
            let begin = body.find("inproc::LoadInProgress::begin()").unwrap_or_else(|| panic!("{signature} marks the load"));
            let answer = body.find("inproc::answer_warning_from_load(").unwrap_or_else(|| panic!("{signature} answers the warning"));
            assert!(begin < answer);
        }
    }

    #[test]
    fn the_sentence_for_the_user_says_what_happened_and_what_to_do() {
        assert!(MEMORY_UNLOAD_MESSAGE.contains("unloaded"));
        assert!(MEMORY_UNLOAD_MESSAGE.contains("memory"));
        assert!(MEMORY_UNLOAD_MESSAGE.contains("next message"));
    }

    // ── Card or processor: the decision ─────────────────────────────────────

    #[test]
    fn android_never_asks_for_a_card() {
        for requested in [-1, 0, 20, 999] {
            let plan = plan_gpu(ANDROID, requested, true);
            assert_eq!(plan.layers, 0, "requested {requested}");
            assert!(!plan.app_chose_cpu && plan.note.is_none(), "there was no card to take away");
        }
    }

    #[test]
    fn the_simulator_stays_on_the_processor_and_says_so() {
        let plan = plan_gpu(SIMULATOR, -1, false);
        assert_eq!(plan.layers, 0);
        assert!(plan.app_chose_cpu);
        assert_eq!(plan.note, Some(SIMULATOR_CPU_NOTE));
        // A number the user typed does not get past it either.
        assert_eq!(plan_gpu(SIMULATOR, 20, false).layers, 0);
    }

    #[test]
    fn the_test_switch_lets_the_simulator_take_the_card() {
        // Only so the self-test can be watched catching it there.
        let plan = plan_gpu(SIMULATOR, -1, true);
        assert_eq!(plan.layers, ALL_LAYERS);
        assert!(!plan.app_chose_cpu);
    }

    #[test]
    fn a_real_apple_device_takes_every_layer_on_auto() {
        let plan = plan_gpu(APPLE_DEVICE, -1, false);
        assert_eq!(plan.layers, ALL_LAYERS);
        assert!(!plan.app_chose_cpu && plan.note.is_none());
        assert_eq!(plan_gpu(APPLE_DEVICE, 12, false).layers, 12);
    }

    #[test]
    fn a_typed_zero_is_a_choice_and_not_a_fallback() {
        for platform in [APPLE_DEVICE, SIMULATOR] {
            let plan = plan_gpu(platform, 0, false);
            assert_eq!(plan.layers, 0);
            assert!(!plan.app_chose_cpu, "the user asked for the processor, nothing was taken away");
            assert!(plan.note.is_none());
        }
    }

    #[test]
    fn the_judge_catches_what_the_simulator_really_produced() {
        // The measured output of Metal in the iOS Simulator: 48 exclamation
        // marks (mobile-docs/IOS-MACHBARKEIT.md 2.4).
        assert!(sanity_says_garbled(&"!".repeat(48)));
        // And 24 of them, which is all the self-test generates.
        assert!(sanity_says_garbled(&"!".repeat(engine_sanity::PROBE_TOKENS as usize)));
        assert!(!sanity_says_garbled("Fishing boats left before sunrise and returned in the afternoon."));
        // Too short to judge is not a verdict against the card.
        assert!(!sanity_says_garbled(""));
        assert!(!sanity_says_garbled("Boats."));
    }

    #[test]
    fn the_identity_carries_the_layer_count_where_the_status_reads_it() {
        let args = identity_args("/m/a.gguf", 4096, 0);
        assert_eq!(crate::commands::engine::gpu_layers_in(&args), Some(0));
        assert_eq!(crate::commands::engine::gpu_layers_reported(&args), Some(0));
        // Every layer is the sentinel, and the status reports that as "all".
        let all = identity_args("/m/a.gguf", 4096, ALL_LAYERS);
        assert_eq!(crate::commands::engine::gpu_layers_reported(&all), None);
        // Model and context are part of the identity.
        assert_ne!(identity_args("/m/a.gguf", 4096, 0), identity_args("/m/b.gguf", 4096, 0));
        assert_ne!(identity_args("/m/a.gguf", 4096, 0), identity_args("/m/a.gguf", 2048, 0));
    }

    // ── Load settings ───────────────────────────────────────────────────────

    #[test]
    fn the_engine_page_settings_are_read_and_unknown_words_mean_the_default() {
        let t = LoadTuning::from_settings(6, "on", "q8_0", "f16");
        assert_eq!(t, LoadTuning { threads: 6, flash_attn: FlashAttn::On, cache_k: KvQuant::Q8, cache_v: KvQuant::F16 });
        // What a hand-edited settings file may hold.
        assert_eq!(LoadTuning::from_settings(-1, "maybe", "q2_k; rm -rf", ""), LoadTuning::default());
        // The desktop's own defaults are the phone's defaults.
        assert_eq!(LoadTuning::from_settings(-1, "auto", "f16", "f16"), LoadTuning::default());
        // bf16 is on the desktop's list and not on the phone's page.
        assert_eq!(LoadTuning::from_settings(0, "auto", "bf16", "bf16"), LoadTuning::default());
    }

    #[test]
    fn a_stored_4_bit_cache_is_opened_with_8_bit() {
        // Measured: q4_0 turns the answers of Qwen3 0.6B into word salad, on
        // Metal and on the processor. See KvQuant.
        let t = LoadTuning::from_settings(0, "auto", "q4_0", "q4_0");
        assert_eq!((t.cache_k, t.cache_v), (KvQuant::Q8, KvQuant::Q8));
        assert!(!identity_args_tuned("/m/a.gguf", 4096, 0, t).iter().any(|a| a == "q4_0"));
    }

    #[test]
    fn a_quantised_v_cache_without_flash_attention_stays_at_16_bit() {
        // llama.cpp opens no context for this pair at all.
        let t = LoadTuning::from_settings(0, "off", "q8_0", "q8_0");
        assert_eq!(t.cache_v, KvQuant::F16);
        assert_eq!(t.cache_k, KvQuant::Q8, "the K cache has no such rule");
        // With Flash Attention on or left to llama.cpp the wish stands.
        assert_eq!(LoadTuning::from_settings(0, "auto", "f16", "q8_0").cache_v, KvQuant::Q8);
        assert_eq!(LoadTuning::from_settings(0, "on", "f16", "q8_0").cache_v, KvQuant::Q8);
    }

    #[test]
    fn threads_are_held_between_one_and_the_cores_of_the_device() {
        assert_eq!(threads_for(0, 6), 6);
        assert_eq!(threads_for(-1, 12), 8, "nothing asked: at most eight");
        assert_eq!(threads_for(4, 8), 4);
        assert_eq!(threads_for(16, 6), 6, "more threads than cores only slows a phone down");
        assert_eq!(threads_for(3, 0), 1);
    }

    #[test]
    fn the_settings_are_part_of_the_identity_and_can_be_read_back() {
        // Untouched settings: the identity the engine always had.
        assert_eq!(
            identity_args_tuned("/m/a.gguf", 4096, 0, LoadTuning::default()),
            ["--in-process", "-m", "/m/a.gguf", "--ctx-size", "4096", "-ngl", "0"]
        );
        let tuned = LoadTuning::from_settings(4, "on", "q8_0", "q8_0");
        let args = identity_args_tuned("/m/a.gguf", 4096, ALL_LAYERS, tuned);
        // A change on the engine page is a different request.
        assert_ne!(args, identity_args("/m/a.gguf", 4096, ALL_LAYERS));
        assert_eq!(LoadTuning::from_identity(&args), tuned);
        assert_eq!(LoadTuning::from_identity(&identity_args("/m/a.gguf", 4096, 0)), LoadTuning::default());
        // The readers of the identity still find what they read.
        assert_eq!(crate::commands::engine::gpu_layers_in(&args), Some(ALL_LAYERS));
        assert_eq!(args.last().map(String::as_str), Some("999"), "the layer count stays last");
        assert_eq!(args.windows(2).find(|w| w[0] == "--ctx-size").map(|w| w[1].as_str()), Some("4096"));
    }

    #[test]
    fn mmap_and_mlock_are_not_settings_on_a_phone() {
        // KATALOG-PROBE.md, runs e and f: without the mapping the footprint
        // grows by 1.2 to 2.2 times the file.
        for layers in [0, ALL_LAYERS] {
            let params = model_params_for(layers);
            assert!(params.use_mmap(), "the model file is always mapped");
            assert!(!params.use_mlock(), "and never pinned");
        }
        // And nothing in this file can ask for anything else.
        let src = include_str!("engine_inproc.rs");
        let code = &src[..src.find("#[cfg(test)]\nmod tests").expect("the tests module")];
        assert_eq!(code.matches("with_use_mmap(").count(), 1);
        assert_eq!(code.matches("with_use_mlock(").count(), 1);
        assert!(code.contains(".with_use_mmap(true)") && code.contains(".with_use_mlock(false)"));
    }

    // ── Chat format: the decision ───────────────────────────────────────────

    #[test]
    fn gemma_4_is_written_by_hand_and_never_as_chatml() {
        let gemma4 = "{{- bos_token -}}{{- '<|turn>' + role + '\\n' }}...{{- '<turn|>\\n' -}}";
        // llama.cpp does not know it (0.1.154 and 0.1.159), and the
        // vocabulary has no ChatML tokens.
        assert_eq!(decide_format(Some(gemma4), false, false), Ok(PromptFormat::Gemma4));
        // Should llama.cpp ever claim to know it, the measured way still wins.
        assert_eq!(decide_format(Some(gemma4), true, false), Ok(PromptFormat::Gemma4));
    }

    #[test]
    fn a_template_llama_cpp_knows_is_used_as_it_is() {
        assert_eq!(decide_format(Some("<|im_start|>{{ role }}"), true, true), Ok(PromptFormat::Gguf));
        assert_eq!(decide_format(Some("<start_of_turn>{{ role }}"), true, false), Ok(PromptFormat::Gguf));
    }

    #[test]
    fn inkling_is_refused_with_a_sentence_and_nothing_else_is() {
        assert!(refused_architecture("inkling2").is_some());
        assert!(refused_architecture("inkling2_loop").is_some());
        for arch in ["qwen3", "gemma4", "llama", "lfm3", ""] {
            assert_eq!(refused_architecture(arch), None, "{arch}");
        }
    }

    #[test]
    fn an_unknown_format_is_a_refused_load_and_never_silent_chatml() {
        // The case that showed `Paris<|im_end|>`: a template nobody can
        // render, in a vocabulary without the ChatML tokens.
        assert_eq!(decide_format(Some("<|some_new_turn|>{{ role }}"), false, false), Err(UNKNOWN_FORMAT_ERROR));
        // The ChatML tokens alone do not make a foreign template ChatML.
        assert_eq!(decide_format(Some("<|some_new_turn|>{{ role }}"), false, true), Err(UNKNOWN_FORMAT_ERROR));
        // No template and no ChatML tokens: nothing to go by.
        assert_eq!(decide_format(None, false, false), Err(UNKNOWN_FORMAT_ERROR));
        assert!(UNKNOWN_FORMAT_ERROR.contains("chat format"));
    }

    #[test]
    fn chatml_is_only_used_where_the_vocabulary_has_its_tokens() {
        assert_eq!(decide_format(None, false, true), Ok(PromptFormat::ChatMl));
        assert_eq!(decide_format(Some("a jinja dialect llama.cpp cannot read, <|im_start|>"), false, true), Ok(PromptFormat::ChatMl));
        assert_eq!(decide_format(Some("a jinja dialect llama.cpp cannot read, <|im_start|>"), false, false), Err(UNKNOWN_FORMAT_ERROR));
    }

    #[test]
    fn the_thinking_marks_follow_the_format() {
        assert_eq!(decide_think_style(PromptFormat::Gemma4, Some("<|turn>")), Some(ThinkStyle::Channel));
        assert_eq!(decide_think_style(PromptFormat::Gguf, Some("... '<think>\\n\\n</think>\\n\\n' ...")), Some(ThinkStyle::Tags));
        assert_eq!(decide_think_style(PromptFormat::Gguf, Some("{% if enable_thinking %}")), Some(ThinkStyle::Tags));
        assert_eq!(decide_think_style(PromptFormat::Gguf, Some("<|start_header_id|>")), None);
        assert_eq!(decide_think_style(PromptFormat::ChatMl, None), None);
    }

    #[test]
    fn the_thinking_switch_follows_what_the_models_own_template_does() {
        // The last lines of the two templates in the catalog, as they are in
        // the GGUF files (read on 2026-10-08).
        let qwen3 = r#"{{- '<|im_start|>assistant\n' }}
    {%- if enable_thinking is defined and enable_thinking is false %}
        {{- '<think>\n\n</think>\n\n' }}
    {%- endif %}"#;
        let qwen35 = r#"{{- '<|im_start|>assistant\n' }}
    {%- if enable_thinking is defined and enable_thinking is true %}
        {{- '<think>\n' }}
    {%- else %}
        {{- '<think>\n\n</think>\n\n' }}
    {%- endif %}"#;

        // Qwen3 thinks unless told not to, and opens its block itself.
        let plan = tags_plan(qwen3);
        assert_eq!(plan, TagsPlan { default_on: true, opens_block: false });
        assert_eq!(tags_suffix(plan, None), ("", false));
        assert_eq!(tags_suffix(plan, Some(true)), ("", false));
        assert_eq!(tags_suffix(plan, Some(false)), (EMPTY_THINK_BLOCK, false));

        // Qwen 3.5 does not think unless told to, and then the prompt opens
        // the block, so the model's first token is already thinking.
        let plan = tags_plan(qwen35);
        assert_eq!(plan, TagsPlan { default_on: false, opens_block: true });
        assert_eq!(tags_suffix(plan, None), (EMPTY_THINK_BLOCK, false));
        assert_eq!(tags_suffix(plan, Some(false)), (EMPTY_THINK_BLOCK, false));
        assert_eq!(tags_suffix(plan, Some(true)), ("<think>\n", true));

        // A template that says nothing about it: the model decides.
        assert_eq!(tags_suffix(tags_plan("<think>"), None), ("", false));
    }

    // ── Gemma 4 by hand ─────────────────────────────────────────────────────

    fn msgs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(r, c)| (r.to_string(), c.to_string())).collect()
    }

    #[test]
    fn gemma4_one_question_is_the_prompt_that_was_measured() {
        // KATALOG-PROBE.md section 4, the prompt that answered "Paris".
        assert_eq!(
            gemma4_prompt(&msgs(&[("user", "What is the capital of France? Answer in one word.")]), false),
            "<|turn>user\nWhat is the capital of France? Answer in one word.<turn|>\n<|turn>model\n"
        );
    }

    #[test]
    fn gemma4_system_message_and_several_rounds() {
        let prompt = gemma4_prompt(
            &msgs(&[
                ("system", "  You are brief.  "),
                ("user", "Hi"),
                ("assistant", "Hello."),
                ("user", "And again"),
            ]),
            false,
        );
        assert_eq!(
            prompt,
            "<|turn>system\nYou are brief.<turn|>\n<|turn>user\nHi<turn|>\n<|turn>model\nHello.<turn|>\n<|turn>user\nAnd again<turn|>\n<|turn>model\n"
        );
        // The assistant is called `model`, never `assistant`, and there is no
        // ChatML in it.
        assert!(!prompt.contains("assistant") && !prompt.contains("<|im_"));
        // The tokenizer adds `<bos>`, the prompt must not carry a second one.
        assert!(!prompt.contains("<bos>"));
    }

    #[test]
    fn gemma4_thinking_opens_the_system_turn_and_only_when_asked() {
        assert_eq!(
            gemma4_prompt(&msgs(&[("user", "Hi")]), true),
            "<|turn>system\n<|think|>\n<turn|>\n<|turn>user\nHi<turn|>\n<|turn>model\n"
        );
        assert_eq!(
            gemma4_prompt(&msgs(&[("system", "Be brief."), ("user", "Hi")]), true),
            "<|turn>system\n<|think|>\nBe brief.<turn|>\n<|turn>user\nHi<turn|>\n<|turn>model\n"
        );
        assert!(!gemma4_prompt(&msgs(&[("system", "Be brief."), ("user", "Hi")]), false).contains("<|think|>"));
    }

    #[test]
    fn gemma4_does_not_read_its_own_thinking_back() {
        let prompt = gemma4_prompt(
            &msgs(&[("user", "Hi"), ("assistant", "<|channel>thought\nThe user greets me.<channel|>Hello."), ("user", "Bye")]),
            false,
        );
        assert_eq!(prompt, "<|turn>user\nHi<turn|>\n<|turn>model\nHello.<turn|>\n<|turn>user\nBye<turn|>\n<|turn>model\n");
    }

    #[test]
    fn gemma4_other_roles_have_a_place() {
        // A tool result arrives as text and is read as something the user said.
        let prompt = gemma4_prompt(&msgs(&[("user", "Look it up"), ("tool", "42"), ("developer", "Stay short")]), false);
        assert_eq!(prompt, "<|turn>user\nLook it up<turn|>\n<|turn>user\n42<turn|>\n<|turn>system\nStay short<turn|>\n<|turn>model\n");
        // Two answers in a row are one turn.
        let twice = gemma4_prompt(&msgs(&[("user", "Go"), ("assistant", "One."), ("assistant", "Two.")]), false);
        assert_eq!(twice, "<|turn>user\nGo<turn|>\n<|turn>model\nOne.\nTwo.<turn|>\n<|turn>model\n");
    }

    // ── What must never reach the user ──────────────────────────────────────

    fn through_stop(pieces: &[&str]) -> (String, bool) {
        let mut f = StopFilter::default();
        let mut out = String::new();
        for p in pieces {
            out.push_str(&f.push(p));
        }
        let hit = f.hit();
        out.push_str(&f.finish());
        (out, hit)
    }

    #[test]
    fn the_marker_gemma_4_wrote_as_text_is_cut() {
        // The seven tokens of KATALOG-PROBE.md section 4: `Paris<|im_end|>`.
        assert_eq!(through_stop(&["Paris", "<", "|", "im", "_", "end", "|>"]), ("Paris".to_string(), true));
        assert_eq!(through_stop(&["Paris<|im_end|>"]), ("Paris".to_string(), true));
        // Nothing after the marker is shown either.
        assert_eq!(through_stop(&["Paris<|im_end|>\n<|im_start|>user\nMore"]), ("Paris".to_string(), true));
    }

    #[test]
    fn every_turn_marker_is_cut_however_it_is_split() {
        for marker in STOP_MARKERS {
            let text = format!("An answer.{marker}and more");
            // In one piece, and character by character.
            assert_eq!(through_stop(&[&text]), ("An answer.".to_string(), true), "{marker}");
            let chars: Vec<String> = text.chars().map(String::from).collect();
            let chars: Vec<&str> = chars.iter().map(String::as_str).collect();
            assert_eq!(through_stop(&chars), ("An answer.".to_string(), true), "{marker} by character");
        }
    }

    #[test]
    fn ordinary_text_with_angle_brackets_passes_whole() {
        for text in ["if a < b && b > c { }", "<b>bold</b>", "x <| y", "a <turn> b", "2 < 3", "<", "tail <"] {
            let chars: Vec<String> = text.chars().map(String::from).collect();
            let chars: Vec<&str> = chars.iter().map(String::as_str).collect();
            assert_eq!(through_stop(&chars), (text.to_string(), false), "{text}");
        }
        // Umlauts and emoji survive the holding back.
        assert_eq!(through_stop(&["Gr", "ü", "ße <", "3 ", "🙂"]), ("Grüße <3 🙂".to_string(), false));
    }

    #[test]
    fn half_a_marker_at_the_token_limit_is_not_shown() {
        assert_eq!(through_stop(&["Paris", "<|im", "_en"]), ("Paris".to_string(), false));
    }

    fn sorted(pieces: Vec<Piece>) -> (String, String) {
        let (mut answer, mut thought) = (String::new(), String::new());
        for p in pieces {
            match p {
                Piece::Answer(t) => answer.push_str(&t),
                Piece::Thought(t) => thought.push_str(&t),
            }
        }
        (answer, thought)
    }

    fn through_split(pieces: &[&str]) -> (String, String) {
        let mut s = ThinkSplitter::default();
        let mut all = Vec::new();
        for p in pieces {
            all.extend(s.push(p));
        }
        all.extend(s.finish());
        sorted(all)
    }

    #[test]
    fn a_think_block_becomes_thinking_and_the_tags_are_gone() {
        let (answer, thought) = through_split(&["<think>\nThe capital of France is Paris.\n</think>\n\nParis"]);
        assert_eq!(answer, "Paris");
        assert_eq!(thought, "The capital of France is Paris.\n");
        // The same text in the pieces a model really sends, tags in halves.
        let (answer, thought) = through_split(&["<th", "ink>", "\n", "The capital", " of France is Paris.\n", "</", "think", ">", "\n\n", "Par", "is"]);
        assert_eq!(answer, "Paris");
        assert_eq!(thought, "The capital of France is Paris.\n");
    }

    #[test]
    fn an_empty_think_block_leaves_no_trace() {
        // What Qwen 3.5 0.8B and SmolLM3 write: `<think>\n\n</think>\n\nParis`.
        assert_eq!(through_split(&["<think>\n\n</think>\n\nParis"]), ("Paris".to_string(), String::new()));
        assert_eq!(through_split(&["<think>", "\n\n", "</think>", "\n\n", "Paris"]), ("Paris".to_string(), String::new()));
    }

    #[test]
    fn thinking_that_never_closes_stays_thinking() {
        let (answer, thought) = through_split(&["<think>\nStill working on", " it"]);
        assert_eq!(answer, "");
        assert_eq!(thought, "Still working on it");
    }

    #[test]
    fn text_that_only_looks_like_a_tag_is_text() {
        assert_eq!(through_split(&["a <", "b> c </", "p> d <thin air>"]).0, "a <b> c </p> d <thin air>");
        // A closing tag without a block goes, the text around it stays.
        assert_eq!(through_split(&["Paris", "</think>", "\n\nFrance"]), ("ParisFrance".to_string(), String::new()));
    }

    #[test]
    fn marks_that_arrive_as_single_tokens_sort_the_same_way() {
        // Qwen3: `<think>` and `</think>` are one token each.
        let mut s = ThinkSplitter::default();
        let mut all = s.open(ThinkStyle::Tags);
        all.extend(s.push("\nLet me count.\n"));
        assert!(s.thinking());
        assert_eq!(s.open_style(), Some(ThinkStyle::Tags));
        all.extend(s.close());
        all.extend(s.push("\n\n1, 2, 3"));
        all.extend(s.finish());
        assert!(!s.thinking());
        assert_eq!(sorted(all), ("1, 2, 3".to_string(), "Let me count.\n".to_string()));
    }

    #[test]
    fn the_gemma_4_channel_loses_its_name() {
        // `<|channel>` and `<channel|>` render as nothing, the word `thought`
        // after the first one is the channel's name and not thinking.
        for pieces in [vec!["thought\nThe user asks for a count."], vec!["thou", "ght", "\n", "The user asks", " for a count."]] {
            let mut s = ThinkSplitter::default();
            let mut all = s.open(ThinkStyle::Channel);
            for p in pieces {
                all.extend(s.push(p));
            }
            assert_eq!(s.open_style(), Some(ThinkStyle::Channel));
            all.extend(s.close());
            all.extend(s.push("1, 2, 3"));
            all.extend(s.finish());
            assert_eq!(sorted(all), ("1, 2, 3".to_string(), "The user asks for a count.".to_string()));
        }
        // A model that does not name the channel loses nothing.
        let mut s = ThinkSplitter::default();
        let mut all = s.open(ThinkStyle::Channel);
        all.extend(s.push("thorough analysis"));
        all.extend(s.finish());
        assert_eq!(sorted(all).1, "thorough analysis");
    }

    #[test]
    fn a_prompt_that_ends_inside_a_block_starts_in_thinking() {
        let mut s = ThinkSplitter::inside(ThinkStyle::Tags);
        let mut all = s.push("Hm.</think>Yes");
        all.extend(s.finish());
        assert_eq!(sorted(all), ("Yes".to_string(), "Hm.".to_string()));
    }

    #[test]
    fn neither_filter_lets_a_mark_through_whatever_the_cut() {
        // The whole path of a token: stop filter first, then the splitter.
        let text = "<think>\nplan\n</think>\n\nParis<|im_end|>\n<|im_start|>user";
        for width in 1..=text.len() {
            let mut stop = StopFilter::default();
            let mut split = ThinkSplitter::default();
            let mut all = Vec::new();
            let bytes = text.as_bytes();
            for chunk in bytes.chunks(width) {
                let shown = stop.push(std::str::from_utf8(chunk).unwrap());
                all.extend(split.push(&shown));
                if stop.hit() {
                    break;
                }
            }
            let tail = stop.finish();
            all.extend(split.push(&tail));
            all.extend(split.finish());
            let (answer, thought) = sorted(all);
            assert_eq!(answer, "Paris", "pieces of {width}");
            assert_eq!(thought, "plan\n", "pieces of {width}");
        }
    }

    // ── Thinking: the limits and the switch ─────────────────────────────────

    #[test]
    fn thinking_gets_half_of_what_is_left_and_at_most_a_quarter_of_the_window() {
        assert_eq!(think_budget(4000, 4096), 1024);
        assert_eq!(think_budget(2000, 2048), 512);
        // A long history: 300 tokens left, the answer keeps half of them.
        assert_eq!(think_budget(300, 4096), 150);
        assert_eq!(think_budget(480, 512), 128);
        assert_eq!(think_budget(0, 4096), 1);
        // Above the 700 tokens Qwen 3.5 2B needed at the full window.
        assert!(think_budget(4096 - 17 - 4, 4096) > 700);
    }

    #[test]
    fn the_thinking_switch_is_read_from_both_fields_the_frontend_sends() {
        use serde_json::json;
        assert_eq!(thinking_wish(&json!({"messages": []})), None);
        assert_eq!(thinking_wish(&json!({"chat_template_kwargs": {"enable_thinking": false}})), Some(false));
        assert_eq!(thinking_wish(&json!({"chat_template_kwargs": {"enable_thinking": true}})), Some(true));
        assert_eq!(thinking_wish(&json!({"reasoning_effort": "none"})), Some(false));
        assert_eq!(thinking_wish(&json!({"reasoning_effort": "high"})), Some(true));
        // Both: the one made for a template-rendering server wins.
        assert_eq!(
            thinking_wish(&json!({"reasoning_effort": "high", "chat_template_kwargs": {"enable_thinking": false}})),
            Some(false)
        );
        // Nonsense is no wish.
        assert_eq!(thinking_wish(&json!({"chat_template_kwargs": {"enable_thinking": "no"}})), None);
    }

    #[test]
    fn thinking_goes_out_in_its_own_field() {
        let v = oai::stream_reasoning("chatcmpl-1", 7, "m", "Let me think");
        assert_eq!(v["object"], "chat.completion.chunk");
        assert_eq!(v["choices"][0]["delta"]["reasoning_content"], "Let me think");
        assert!(v["choices"][0]["delta"].get("content").is_none());
        let v = oai::completion(&oai::Completion {
            id: "chatcmpl-1",
            created: 7,
            model: "m",
            content: "Paris",
            reasoning: "The capital is Paris.",
            finish_reason: "stop",
            prompt_tokens: 3,
            completion_tokens: 9,
        });
        assert_eq!(v["usage"]["total_tokens"], 12);
        assert_eq!(v["choices"][0]["message"]["content"], "Paris");
        assert_eq!(v["choices"][0]["message"]["reasoning_content"], "The capital is Paris.");
    }

    // ── Context and memory ──────────────────────────────────────────────────

    #[test]
    fn a_phone_never_opens_more_than_its_cap() {
        assert_eq!(clamp_ctx(8192), MAX_CTX);
        assert_eq!(clamp_ctx(32768), MAX_CTX);
        assert_eq!(clamp_ctx(2048), 2048);
        assert_eq!(clamp_ctx(0), MIN_CTX);
    }

    #[test]
    fn the_memory_guard_refuses_what_cannot_fit_and_names_both_numbers() {
        let gb = 1024 * 1024 * 1024u64;
        // 4 GB model, 3 GB available.
        let err = ram_verdict(4 * gb, Some(3 * gb)).unwrap_err();
        assert!(err.contains("5265 MB"), "{err}");
        assert!(err.contains("3072 MB"), "{err}");
        // 400 MB model, 3 GB available.
        assert!(ram_verdict(400 * 1024 * 1024, Some(3 * gb)).is_ok());
    }

    #[test]
    fn a_guard_that_cannot_measure_does_not_refuse() {
        assert!(ram_verdict(u64::MAX / 4, None).is_ok());
    }

    // ── The handle ──────────────────────────────────────────────────────────

    fn handle_around(worker: JoinHandle<()>, server: JoinHandle<()>) -> (InProcChild, std_mpsc::Receiver<Job>, CancellationToken) {
        let (cmd_tx, cmd_rx) = std_mpsc::channel::<Job>();
        let cancel = CancellationToken::new();
        let child = InProcChild {
            cmd_tx,
            abort: Arc::new(AtomicBool::new(false)),
            cancel: cancel.clone(),
            worker: Some(worker),
            server: Some(server),
        };
        (child, cmd_rx, cancel)
    }

    #[test]
    fn the_handle_answers_like_a_process_would() {
        let (stop_tx, stop_rx) = std_mpsc::channel::<()>();
        let worker = std::thread::spawn(move || {
            let _ = stop_rx.recv();
        });
        let (cancel_tx, cancel_rx) = std_mpsc::channel::<CancellationToken>();
        let server = std::thread::spawn(move || {
            let cancel = cancel_rx.recv().unwrap();
            while !cancel.is_cancelled() {
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        let (mut child, _jobs, cancel) = handle_around(worker, server);
        cancel_tx.send(cancel).unwrap();

        assert!(matches!(child.try_wait(), Ok(None)), "a serving engine is not an exited one");
        // The worker ends by itself: that is a dead engine.
        stop_tx.send(()).unwrap();
        for _ in 0..200 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(matches!(child.try_wait(), Ok(Some(_))));
        // And reaping it must not hang on the server that is still up.
        child.wait().unwrap();
        assert!(matches!(child.try_wait(), Ok(Some(_))));
    }

    #[test]
    fn kill_then_wait_stops_a_worker_that_is_waiting_for_work() {
        let (cmd_tx, cmd_rx) = std_mpsc::channel::<Job>();
        let worker = std::thread::spawn(move || {
            while let Ok(job) = cmd_rx.recv() {
                if matches!(job, Job::Stop) {
                    break;
                }
            }
        });
        let cancel = CancellationToken::new();
        let c2 = cancel.clone();
        let server = std::thread::spawn(move || {
            while !c2.is_cancelled() {
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        let mut child = InProcChild {
            cmd_tx,
            abort: Arc::new(AtomicBool::new(false)),
            cancel,
            worker: Some(worker),
            server: Some(server),
        };
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(child.abort.load(Ordering::Relaxed));
        // Dropping an already stopped handle is a no-op, not a second join.
        drop(child);
    }

    // ── The wire shapes ─────────────────────────────────────────────────────

    #[test]
    fn oai_stream_delta_is_the_chunk_the_frontend_parses() {
        let v = oai::stream_delta("chatcmpl-1", 7, "m", "Hi");
        assert_eq!(v["object"], "chat.completion.chunk");
        assert_eq!(v["choices"][0]["delta"]["content"], "Hi");
        assert!(v["choices"][0]["finish_reason"].is_null());
        assert_eq!(v["choices"][0]["index"], 0);
    }

    #[test]
    fn oai_stream_finish_has_an_empty_delta_and_a_reason() {
        let v = oai::stream_finish("chatcmpl-1", 7, "m", "stop");
        assert_eq!(v["choices"][0]["finish_reason"], "stop");
        assert_eq!(v["choices"][0]["delta"], serde_json::json!({}));
    }

    #[test]
    fn oai_stream_usage_has_no_choices_and_adds_up() {
        let v = oai::stream_usage("chatcmpl-1", 7, "m", 12, 30);
        assert_eq!(v["choices"], serde_json::json!([]));
        assert_eq!(v["usage"]["prompt_tokens"], 12);
        assert_eq!(v["usage"]["completion_tokens"], 30);
        assert_eq!(v["usage"]["total_tokens"], 42);
    }

    #[test]
    fn oai_completion_and_error_have_the_plain_shapes() {
        let v = oai::completion(&oai::Completion {
            id: "chatcmpl-1",
            created: 7,
            model: "m",
            content: "Hello",
            reasoning: "",
            finish_reason: "length",
            prompt_tokens: 3,
            completion_tokens: 4,
        });
        assert_eq!(v["id"], "chatcmpl-1");
        assert_eq!(v["created"], 7);
        assert_eq!(v["model"], "m");
        assert_eq!(v["usage"]["prompt_tokens"], 3);
        assert_eq!(v["usage"]["completion_tokens"], 4);
        assert!(v["choices"][0]["message"].get("reasoning_content").is_none(), "no thinking, no field");
        assert_eq!(v["object"], "chat.completion");
        assert_eq!(v["choices"][0]["message"]["role"], "assistant");
        assert_eq!(v["choices"][0]["message"]["content"], "Hello");
        assert_eq!(v["choices"][0]["finish_reason"], "length");
        assert_eq!(v["usage"]["total_tokens"], 7);
        let e = oai::error_body("Loading model", 503);
        assert_eq!(e["error"]["code"], 503);
        assert_eq!(e["error"]["type"], "unavailable_error");
        assert_eq!(oai::error_body("x", 500)["error"]["type"], "server_error");
    }

    #[test]
    fn content_parts_are_flattened_and_pictures_dropped() {
        let parts = serde_json::json!([
            {"type": "text", "text": "what is this"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
            {"type": "text", "text": "and this"},
        ]);
        assert_eq!(content_text(Some(&parts)), "what is this\nand this");
        assert_eq!(content_text(Some(&serde_json::json!("plain"))), "plain");
        assert_eq!(content_text(None), "");
    }

    // ── With a real model ───────────────────────────────────────────────────
    //
    // The tests below load a GGUF and are skipped unless `LU_TEST_GGUF` names
    // one. They are the Mac half of the iPhone gap: same engine file, Metal.
    //
    //   LU_TEST_GGUF=/path/to/model.gguf \
    //     cargo test --features inproc-engine inproc -- --nocapture --test-threads=1
    //
    // Run a second time with GGML_METAL_TENSOR_DISABLE=1: this Mac uses the
    // tensor API that only M5 and A19 have, and the variable switches it to
    // the path the older iPhone chips take.

    fn test_model() -> Option<String> {
        let path = std::env::var("LU_TEST_GGUF").ok().filter(|p| !p.is_empty())?;
        assert!(Path::new(&path).is_file(), "LU_TEST_GGUF names no file: {path}");
        Some(path)
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port()
    }

    fn post_json(port: u16, path: &str, body: serde_json::Value) -> (u16, String) {
        let resp = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap()
            .post(format!("http://127.0.0.1:{port}{path}"))
            .header(engine_token::HEADER, engine_token::token())
            .json(&body)
            .send()
            .expect("the engine answers");
        (resp.status().as_u16(), resp.text().unwrap_or_default())
    }

    fn get(port: u16, path: &str) -> (u16, String) {
        let resp = reqwest::blocking::Client::new()
            .get(format!("http://127.0.0.1:{port}{path}"))
            .header(engine_token::HEADER, engine_token::token())
            .send()
            .expect("the engine answers");
        (resp.status().as_u16(), resp.text().unwrap_or_default())
    }

    /// The HTTP server alone, without a model behind it. `/health` then says
    /// "loading", which is all the CORS tests need.
    fn server_without_model(port: u16) -> (CancellationToken, JoinHandle<()>) {
        let (cmd_tx, _cmd_rx) = std_mpsc::channel::<Job>();
        let shared = Arc::new(Shared {
            kind: Kind::Chat,
            model_name: "none".to_string(),
            loaded: AtomicBool::new(false),
            n_ctx: AtomicU32::new(0),
            thinks: AtomicBool::new(false),
            format: OnceLock::new(),
            cmd_tx: Mutex::new(cmd_tx),
        });
        let cancel = CancellationToken::new();
        let (bind_tx, bind_rx) = std_mpsc::channel();
        let server = spawn_server(port, shared, cancel.clone(), bind_tx);
        bind_rx.recv_timeout(BIND_TIMEOUT).expect("the server reports").expect("the port binds");
        (cancel, server)
    }

    /// M7: another app on the phone reaches the port but not the model. Every
    /// route answers 401 without the token of this start, and with a wrong one.
    #[test]
    fn the_engine_answers_only_with_the_token_of_this_start() {
        let port = free_port();
        let (cancel, server) = server_without_model(port);
        let client = reqwest::blocking::Client::new();
        let url = format!("http://127.0.0.1:{port}");

        for path in ["/health", "/props", "/v1/models", "/v1/models/none"] {
            let bare = client.get(format!("{url}{path}")).send().unwrap();
            assert_eq!(bare.status().as_u16(), 401, "{path} without a token");
            let wrong = client.get(format!("{url}{path}")).header(engine_token::HEADER, "0".repeat(64)).send().unwrap();
            assert_eq!(wrong.status().as_u16(), 401, "{path} with a wrong token");
        }
        for path in ["/v1/chat/completions", "/v1/embeddings"] {
            let bare = client.post(format!("{url}{path}")).json(&serde_json::json!({"messages": []})).send().unwrap();
            assert_eq!(bare.status().as_u16(), 401, "{path} without a token");
        }
        // The answer does not carry the token back.
        let body = client.get(format!("{url}/props")).send().unwrap().text().unwrap();
        assert!(!body.contains(engine_token::token()));

        // The app itself: the helper of these tests sends the header.
        assert_eq!(get(port, "/props").0, 200);
        // And the proxy would add it for exactly this port while it is bound.
        assert_eq!(engine_token::token_for_url(&format!("{url}/v1/chat/completions")), Some(engine_token::token()));
        assert_eq!(engine_token::token_for_port(port), Some(engine_token::token()));

        cancel.cancel();
        let _ = server.join();
        assert_eq!(engine_token::token_for_port(port), None);
    }

    /// The page of the app is cross-origin to the engine. WebKit sends a
    /// preflight before every JSON POST and reads the answer only when its
    /// own origin is allowed. Seen failing in the iOS Simulator on 2026-10-08.
    #[test]
    fn the_webview_origin_may_fetch_the_engine_and_a_foreign_page_may_not() {
        let port = free_port();
        let (cancel, server) = server_without_model(port);
        let client = reqwest::blocking::Client::new();
        let url = format!("http://127.0.0.1:{port}");

        for origin in WEBVIEW_ORIGINS {
            let preflight = client
                .request(reqwest::Method::OPTIONS, format!("{url}/v1/chat/completions"))
                .header("Origin", origin)
                .header("Access-Control-Request-Method", "POST")
                .header("Access-Control-Request-Headers", "content-type")
                .send()
                .expect("the server answers");
            assert!(preflight.status().is_success(), "{origin}: preflight {}", preflight.status());
            let h = preflight.headers();
            assert_eq!(h.get("access-control-allow-origin").and_then(|v| v.to_str().ok()), Some(origin));
            assert!(h.get("access-control-allow-methods").and_then(|v| v.to_str().ok()).unwrap_or("").contains("POST"));
            assert!(h.contains_key("access-control-allow-headers"), "{origin}: content-type must be allowed");

            let health = client
                .get(format!("{url}/health"))
                .header("Origin", origin)
                .header(engine_token::HEADER, engine_token::token())
                .send()
                .unwrap();
            assert_eq!(
                health.headers().get("access-control-allow-origin").and_then(|v| v.to_str().ok()),
                Some(origin)
            );
        }

        // A page from somewhere else gets an answer without the header, and
        // its browser then keeps the body from it.
        let foreign = client.get(format!("{url}/health")).header("Origin", "https://example.com").send().unwrap();
        assert!(!foreign.headers().contains_key("access-control-allow-origin"));
        // And never the wildcard.
        assert!(!WEBVIEW_ORIGINS.contains(&"*"));

        cancel.cancel();
        server.join().unwrap();
    }

    fn chat_request(model_path: &str, port: u16, gpu: GpuPlan, is_garbled: fn(&str) -> bool) -> Launched {
        launch_with_fallback(&LaunchRequest {
            kind: Kind::Chat,
            model_path,
            n_ctx: clamp_ctx(4096),
            port,
            gpu,
            tuning: LoadTuning::default(),
            is_garbled,
        })
        .expect("the model loads")
    }

    #[test]
    fn inproc_engine_serves_openai_chat_on_the_card_and_on_the_processor() {
        let Some(model) = test_model() else {
            eprintln!("skipped: LU_TEST_GGUF is not set");
            return;
        };
        for (label, plan) in [
            ("card", plan_gpu(Platform::current(), -1, false)),
            ("processor", plan_gpu(Platform::current(), 0, false)),
        ] {
            let port = free_port();
            let started = std::time::Instant::now();
            let mut up = chat_request(&model, port, plan, sanity_says_garbled);
            eprintln!(
                "[{label}] loaded in {:?}: n_ctx {}, gpu_layers {}, cpu_fallback {}, note {:?}",
                started.elapsed(), up.n_ctx, up.gpu_layers, up.cpu_fallback, up.note
            );
            assert_eq!(up.gpu_layers, plan.layers, "{label}: the self-test must pass on this machine");
            assert!(!up.retried && !up.cpu_fallback, "{label}: no fallback expected, got {:?}", up.note);

            assert_eq!(get(port, "/health").0, 200);
            let (status, props) = get(port, "/props");
            assert_eq!(status, 200);
            let props: serde_json::Value = serde_json::from_str(&props).unwrap();
            assert_eq!(props["n_ctx"], up.n_ctx);
            assert_eq!(props["chat_template_caps"]["supports_tools"], false);

            // Not streamed.
            let asked = std::time::Instant::now();
            let (status, body) = post_json(port, "/v1/chat/completions", serde_json::json!({
                "messages": [{"role": "user", "content": "Count from 1 to 10."}],
                "temperature": 0,
                "max_tokens": 48,
            }));
            assert_eq!(status, 200, "{body}");
            let v: serde_json::Value = serde_json::from_str(&body).unwrap();
            let text = v["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
            let tokens = v["usage"]["completion_tokens"].as_u64().unwrap_or(0);
            eprintln!(
                "[{label}] answer ({tokens} tokens, {:.1} tokens/s): {text:?}",
                tokens as f64 / asked.elapsed().as_secs_f64()
            );
            assert!(text.contains('1') && text.contains("10"), "{label}: not a count: {text:?}");
            // The judge is made for sentences. Gemma 4 answers with the bare
            // numbers, which it calls unreadable, so a count in the right
            // order stands in for it.
            let counted = (1..=9).try_fold(0, |at, n| text[at..].find(&n.to_string()).map(|i| at + i)).is_some();
            assert!(counted || !sanity_says_garbled(&text), "{label}: unreadable: {text:?}");

            // Streamed, with usage: delta chunks, a finish chunk, a usage
            // chunk without choices, then [DONE], in that order.
            let (status, sse) = post_json(port, "/v1/chat/completions", serde_json::json!({
                "messages": [{"role": "user", "content": "Say hello in one short sentence."}],
                "temperature": 0,
                "max_tokens": 24,
                "stream": true,
                "stream_options": {"include_usage": true},
            }));
            assert_eq!(status, 200);
            let events: Vec<&str> = sse.lines().filter_map(|l| l.strip_prefix("data: ")).collect();
            assert!(events.len() >= 4, "{label}: too few events: {sse}");
            assert_eq!(*events.last().unwrap(), "[DONE]");
            let usage: serde_json::Value = serde_json::from_str(events[events.len() - 2]).unwrap();
            assert_eq!(usage["choices"], serde_json::json!([]));
            assert!(usage["usage"]["completion_tokens"].as_u64().unwrap() > 0);
            let fin: serde_json::Value = serde_json::from_str(events[events.len() - 3]).unwrap();
            assert!(fin["choices"][0]["finish_reason"].is_string());
            let streamed: String = events[..events.len() - 3]
                .iter()
                .filter_map(|e| serde_json::from_str::<serde_json::Value>(e).ok())
                .filter_map(|v| v["choices"][0]["delta"]["content"].as_str().map(str::to_string))
                .collect();
            eprintln!("[{label}] streamed: {streamed:?}");
            assert!(!streamed.trim().is_empty());

            // Stop: the port answers no more, and the handle says it is gone.
            up.child.kill().unwrap();
            up.child.wait().unwrap();
            assert!(matches!(up.child.try_wait(), Ok(Some(_))));
            assert!(reqwest::blocking::get(format!("http://127.0.0.1:{port}/health")).is_err());
        }
    }

    /// Round 10: "Continue" goes on inside the answer. The model gets its own
    /// first numbers back as the open turn and writes the next one. Asked the
    /// old way (a new question) a small model starts the count again.
    #[test]
    fn inproc_continue_goes_on_inside_the_cut_answer() {
        let Some(model) = test_model() else {
            eprintln!("skipped: LU_TEST_GGUF is not set");
            return;
        };
        let port = free_port();
        let mut up = chat_request(&model, port, plan_gpu(Platform::current(), 0, false), sanity_says_garbled);
        let question = "Count from 1 to 20. One number per line, nothing else.";
        let numbers = |text: &str| -> Vec<u32> {
            text.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).filter_map(|p| p.parse().ok()).collect()
        };

        let (status, body) = post_json(port, "/v1/chat/completions", serde_json::json!({
            "messages": [{"role": "user", "content": question}],
            "temperature": 0,
            "max_tokens": 12,
        }));
        assert_eq!(status, 200, "{body}");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["choices"][0]["finish_reason"], "length", "the first answer must be cut for this test: {body}");
        let cut = v["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
        let before = numbers(&cut);
        assert!(before.len() >= 3 && before[0] == 1, "not the start of a count: {cut:?}");

        let (status, body) = post_json(port, "/v1/chat/completions", serde_json::json!({
            "messages": [{"role": "user", "content": question}, {"role": "assistant", "content": cut}],
            "continue_final_message": true,
            "temperature": 0,
            "max_tokens": 24,
        }));
        assert_eq!(status, 200, "{body}");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        let more = v["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
        eprintln!("cut: {cut:?}\nmore: {more:?}");
        assert!(!more.trim().is_empty(), "nothing was written");
        // What the caller holds plus what came back is one count without a
        // gap and without a second start.
        let whole = numbers(&format!("{cut}{more}"));
        assert!(whole.len() > before.len(), "the count did not go on: {whole:?}");
        for (i, n) in whole.iter().enumerate() {
            assert_eq!(*n, i as u32 + 1, "the count broke or began again: {cut:?} then {more:?}");
        }
        // The prompt held the cut answer: more tokens than the question alone.
        assert!(v["usage"]["prompt_tokens"].as_u64().unwrap() > 12);

        // Without the field the same messages are a finished turn, as before.
        let (status, _) = post_json(port, "/v1/chat/completions", serde_json::json!({
            "messages": [{"role": "user", "content": question}, {"role": "assistant", "content": cut}],
            "temperature": 0,
            "max_tokens": 8,
        }));
        assert_eq!(status, 200);

        up.child.kill().unwrap();
        up.child.wait().unwrap();
    }

    #[test]
    fn inproc_a_card_that_computes_garbage_is_replaced_by_the_processor() {
        let Some(model) = test_model() else {
            eprintln!("skipped: LU_TEST_GGUF is not set");
            return;
        };
        let plan = plan_gpu(Platform::current(), -1, false);
        if plan.layers == 0 {
            eprintln!("skipped: this platform asks for no card");
            return;
        }
        // The Simulator's Metal, played by a judge: whatever came off the
        // card is "garbage", what the processor says afterwards is judged for
        // real. The Mac's own Metal computes correctly, so nothing else here
        // could make the fallback run.
        static CALLS: AtomicU32 = AtomicU32::new(0);
        fn first_answer_is_garbage(text: &str) -> bool {
            if CALLS.fetch_add(1, Ordering::SeqCst) == 0 {
                true
            } else {
                sanity_says_garbled(text)
            }
        }
        let port = free_port();
        let up = chat_request(&model, port, plan, first_answer_is_garbage);
        eprintln!("fallback: gpu_layers {}, cpu_fallback {}, note {:?}", up.gpu_layers, up.cpu_fallback, up.note);
        assert!(up.retried);
        assert!(up.cpu_fallback, "the status must be able to say the card was taken away");
        assert_eq!(up.gpu_layers, 0);
        assert_eq!(up.note, Some(SELFTEST_CPU_NOTE));
        assert!(!up.garbled_on_cpu);
        // And it serves, on the same port, from the processor.
        let (status, body) = post_json(port, "/v1/chat/completions", serde_json::json!({
            "messages": [{"role": "user", "content": "Count from 1 to 5."}],
            "temperature": 0,
            "max_tokens": 24,
        }));
        assert_eq!(status, 200, "{body}");
        assert!(body.contains('5'), "{body}");
    }

    // ── With a real model: format, marks, thinking, settings ────────────────

    fn load(model_path: &str, port: u16, n_ctx: u32, gpu: GpuPlan, tuning: LoadTuning) -> Result<Launched, String> {
        launch_with_fallback(&LaunchRequest {
            kind: Kind::Chat,
            model_path,
            n_ctx,
            port,
            gpu,
            tuning,
            is_garbled: sanity_says_garbled,
        })
    }

    /// One request, not streamed: (answer, thinking, finish reason, completion tokens).
    fn ask(port: u16, mut body: serde_json::Value) -> (String, String, String, u64) {
        body["temperature"] = serde_json::json!(0);
        let (status, text) = post_json(port, "/v1/chat/completions", body);
        assert_eq!(status, 200, "{text}");
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let message = &v["choices"][0]["message"];
        (
            message["content"].as_str().unwrap_or("").to_string(),
            message["reasoning_content"].as_str().unwrap_or("").to_string(),
            v["choices"][0]["finish_reason"].as_str().unwrap_or("").to_string(),
            v["usage"]["completion_tokens"].as_u64().unwrap_or(0),
        )
    }

    /// Nothing of any format's markup may be in what the user reads.
    fn assert_clean(label: &str, text: &str) {
        for marker in STOP_MARKERS {
            assert!(!text.contains(marker), "{label}: {marker} in the visible text: {text:?}");
        }
        for mark in ["<think>", "</think>", "<|channel>", "<channel|>", "<|think|>", "<bos>", "<eos>", "<|"] {
            assert!(!text.contains(mark), "{label}: {mark} in the visible text: {text:?}");
        }
    }

    fn props(port: u16) -> serde_json::Value {
        serde_json::from_str(&get(port, "/props").1).unwrap()
    }

    #[test]
    fn inproc_no_marker_reaches_the_visible_text_with_system_message_and_rounds() {
        let Some(model) = test_model() else {
            eprintln!("skipped: LU_TEST_GGUF is not set");
            return;
        };
        for (label, plan) in [
            ("card", plan_gpu(Platform::current(), -1, false)),
            ("processor", plan_gpu(Platform::current(), 0, false)),
        ] {
            let port = free_port();
            let up = load(&model, port, clamp_ctx(4096), plan, LoadTuning::default()).expect("the model loads");
            let p = props(port);
            eprintln!("[{label}] chat_format {}, thinking {}", p["lu"]["chat_format"], p["lu"]["thinking"]);
            assert!(p["lu"]["chat_format"].is_string());

            // One question. The answer that used to be `Paris<|im_end|>`.
            let (answer, thinking, finish, tokens) = ask(port, serde_json::json!({
                "messages": [{"role": "user", "content": "What is the capital of France? Answer in one word."}],
                "max_tokens": 64,
            }));
            eprintln!("[{label}] paris: {answer:?} (finish {finish}, {tokens} tokens, thinking {} chars)", thinking.len());
            assert_clean(label, &answer);
            assert_clean(label, &thinking);
            assert!(answer.contains("Paris"), "{label}: {answer:?}");
            assert_eq!(finish, "stop", "{label}: the model must end its turn by itself: {answer:?}");

            // A system message that decides the answer.
            let (answer, thinking, finish, _) = ask(port, serde_json::json!({
                "messages": [
                    {"role": "system", "content": "You are a ship's parrot called Polly. When asked for your name, you say Polly."},
                    {"role": "user", "content": "What is your name?"},
                ],
                "max_tokens": 64,
            }));
            eprintln!("[{label}] system: {answer:?} (finish {finish})");
            assert_clean(label, &answer);
            assert_clean(label, &thinking);
            assert!(answer.contains("Polly"), "{label}: the system message did not arrive: {answer:?}");

            // Several rounds: the answer is only in the first one.
            let (answer, thinking, finish, _) = ask(port, serde_json::json!({
                "messages": [
                    {"role": "system", "content": "You are a helpful assistant."},
                    {"role": "user", "content": "My dog is called Bruno."},
                    {"role": "assistant", "content": "Bruno is a lovely name for a dog."},
                    {"role": "user", "content": "I also have a cat."},
                    {"role": "assistant", "content": "Nice. What is the cat called?"},
                    {"role": "user", "content": "Never mind the cat. What is my dog called? Answer with the name only."},
                ],
                "max_tokens": 64,
            }));
            eprintln!("[{label}] rounds: {answer:?} (finish {finish})");
            assert_clean(label, &answer);
            assert_clean(label, &thinking);
            assert!(answer.contains("Bruno"), "{label}: the earlier rounds did not arrive: {answer:?}");

            // The count of the measurement run, with room for a thinking block.
            let (answer, thinking, finish, tokens) = ask(port, serde_json::json!({
                "messages": [{"role": "user", "content": "Count from 1 to 10."}],
                "max_tokens": 96,
            }));
            eprintln!("[{label}] count: {answer:?} (finish {finish}, {tokens} tokens, thinking {} chars)", thinking.len());
            assert_clean(label, &answer);
            let mut at = 0;
            for n in 1..=10 {
                let found = answer[at..].find(&n.to_string());
                assert!(found.is_some(), "{label}: {n} is missing or out of order: {answer:?}");
                at += found.unwrap();
            }

            // Streamed: the same rule for every delta.
            let (status, sse) = post_json(port, "/v1/chat/completions", serde_json::json!({
                "messages": [{"role": "user", "content": "Name three colours, separated by commas."}],
                "temperature": 0,
                "max_tokens": 48,
                "stream": true,
            }));
            assert_eq!(status, 200);
            let mut streamed = String::new();
            for event in sse.lines().filter_map(|l| l.strip_prefix("data: ")) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(event) {
                    if let Some(t) = v["choices"][0]["delta"]["content"].as_str() {
                        streamed.push_str(t);
                    }
                }
            }
            eprintln!("[{label}] streamed: {streamed:?}");
            assert_clean(label, &streamed);
            assert!(!streamed.trim().is_empty());
            drop(up);
        }
    }

    #[test]
    fn inproc_thinking_is_its_own_field_can_be_switched_off_and_never_eats_the_answer() {
        let Some(model) = test_model() else {
            eprintln!("skipped: LU_TEST_GGUF is not set");
            return;
        };
        let plan = plan_gpu(Platform::current(), -1, false);
        let port = free_port();
        let up = load(&model, port, clamp_ctx(4096), plan, LoadTuning::default()).expect("the model loads");
        let thinks = props(port)["lu"]["thinking"] == serde_json::json!(true);
        eprintln!("thinking marks known for this model: {thinks}");
        let question = serde_json::json!([{"role": "user", "content": "Count from 1 to 10."}]);

        // As the model does it by itself.
        let (answer, thinking, finish, tokens) = ask(port, serde_json::json!({"messages": question, "max_tokens": 64}));
        eprintln!("default: {tokens} tokens, finish {finish}, thinking {} chars, answer {answer:?}", thinking.len());
        assert_clean("default", &answer);
        assert!(!answer.trim().is_empty(), "the answer must not be lost in the thinking");

        // Switched on.
        let (answer_on, thinking_on, finish, tokens_on) = ask(port, serde_json::json!({
            "messages": question, "max_tokens": 64, "chat_template_kwargs": {"enable_thinking": true},
        }));
        eprintln!("on: {tokens_on} tokens, finish {finish}, thinking {} chars: {:?}, answer {answer_on:?}", thinking_on.len(), engine_sanity::sample_for_log(&thinking_on, 100));
        assert_clean("on", &answer_on);
        assert_clean("on", &thinking_on);
        assert!(!answer_on.trim().is_empty());
        // 64 tokens are the ANSWER's limit: with the thinking they are more.
        if !thinking_on.is_empty() {
            assert!(answer_on.contains("10"), "the thinking ate the answer: {answer_on:?}");
        }

        // Switched off, in both spellings the frontend sends.
        for (label, body) in [
            ("off (enable_thinking)", serde_json::json!({"messages": question, "max_tokens": 64, "chat_template_kwargs": {"enable_thinking": false}})),
            ("off (reasoning_effort)", serde_json::json!({"messages": question, "max_tokens": 64, "reasoning_effort": "none"})),
        ] {
            let (answer_off, thinking_off, finish, tokens_off) = ask(port, body);
            eprintln!("{label}: {tokens_off} tokens, finish {finish}, thinking {} chars, answer {answer_off:?}", thinking_off.len());
            assert_clean(label, &answer_off);
            assert!(answer_off.contains("10"), "{label}: {answer_off:?}");
            if thinks {
                assert!(thinking_off.trim().is_empty(), "{label}: the model still thought: {thinking_off:?}");
                assert!(tokens_off <= 64, "{label}: no thinking, so the whole turn fits the answer's limit");
            }
        }

        // Streamed with thinking on: the thinking arrives as reasoning_content
        // and no content delta carries a tag.
        let (status, sse) = post_json(port, "/v1/chat/completions", serde_json::json!({
            "messages": question, "temperature": 0, "max_tokens": 64, "stream": true,
            "chat_template_kwargs": {"enable_thinking": true},
        }));
        assert_eq!(status, 200);
        let (mut content, mut reasoning) = (String::new(), String::new());
        for event in sse.lines().filter_map(|l| l.strip_prefix("data: ")) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(event) {
                content.push_str(v["choices"][0]["delta"]["content"].as_str().unwrap_or(""));
                reasoning.push_str(v["choices"][0]["delta"]["reasoning_content"].as_str().unwrap_or(""));
            }
        }
        eprintln!("streamed on: reasoning {} chars, content {content:?}", reasoning.len());
        assert_clean("streamed", &content);
        assert_eq!(reasoning, thinking_on, "streamed and plain give the same thinking");
        assert_eq!(content, answer_on);
        drop(up);

        // A small window: the engine has to close the thinking itself.
        let port = free_port();
        let small = load(&model, port, 512, plan, LoadTuning::default()).expect("the model loads");
        assert_eq!(small.n_ctx, 512);
        let (answer, thinking, finish, tokens) = ask(port, serde_json::json!({
            "messages": [{"role": "user", "content": "Count from 1 to 10. Think it through very carefully first."}],
            "chat_template_kwargs": {"enable_thinking": true},
        }));
        eprintln!("window 512: {tokens} tokens, finish {finish}, thinking {} chars, answer {answer:?}", thinking.len());
        assert_clean("window 512", &answer);
        assert!(!answer.trim().is_empty(), "a thinking block must never be all there is: finish {finish}");
        drop(small);
    }

    #[test]
    fn inproc_the_engine_page_settings_are_applied() {
        let Some(model) = test_model() else {
            eprintln!("skipped: LU_TEST_GGUF is not set");
            return;
        };
        let question = serde_json::json!({
            "messages": [{"role": "user", "content": "What is the capital of France? Answer in one word."}],
            "max_tokens": 64, "chat_template_kwargs": {"enable_thinking": false},
        });
        for (where_, plan) in [
            ("card", plan_gpu(Platform::current(), -1, false)),
            ("processor", plan_gpu(Platform::current(), 0, false)),
        ] {
            for (label, tuning) in [
                ("standard", LoadTuning::default()),
                ("2 threads", LoadTuning::from_settings(2, "auto", "f16", "f16")),
                ("flash on", LoadTuning::from_settings(0, "on", "f16", "f16")),
                ("flash off", LoadTuning::from_settings(0, "off", "f16", "f16")),
                ("cache q8_0", LoadTuning::from_settings(0, "auto", "q8_0", "q8_0")),
                ("cache q8_0, flash on, 4 threads", LoadTuning::from_settings(4, "on", "q8_0", "q8_0")),
                // A stored q4_0 is opened as q8_0, and without Flash
                // Attention only the K cache is quantised.
                ("stored q4_0", LoadTuning::from_settings(0, "auto", "q4_0", "q4_0")),
                ("flash off, cache q8_0", LoadTuning::from_settings(0, "off", "q8_0", "q8_0")),
            ] {
                let port = free_port();
                let started = std::time::Instant::now();
                let up = match load(&model, port, clamp_ctx(4096), plan, tuning) {
                    Ok(up) => up,
                    Err(e) => panic!("[{where_}] {label}: a setting must never keep a model from loading: {e}"),
                };
                let loaded = started.elapsed();
                let (answer, _, finish, _) = ask(port, question.clone());
                // A longer answer, for the speed and because one right word
                // proves little about a cache.
                let asked = std::time::Instant::now();
                let (count, _, _, tokens) = ask(port, serde_json::json!({
                    "messages": [{"role": "user", "content": "Count from 1 to 20, numbers only, separated by commas."}],
                    "max_tokens": 96, "chat_template_kwargs": {"enable_thinking": false},
                }));
                let speed = tokens as f64 / asked.elapsed().as_secs_f64();
                eprintln!(
                    "[{where_}] {label}: loaded in {loaded:?}, gpu_layers {}, cpu_fallback {}, tuning_dropped {}, answer {answer:?} (finish {finish}), count {count:?} ({tokens} tokens, {speed:.0} tokens/s)",
                    up.gpu_layers, up.cpu_fallback, up.tuning_dropped
                );
                assert_clean(label, &answer);
                assert_clean(label, &count);
                assert!(answer.contains("Paris"), "[{where_}] {label}: {answer:?}");
                assert!(count.contains("19") && count.contains("20"), "[{where_}] {label}: {count:?}");
                assert!(!up.tuning_dropped, "[{where_}] {label}: every setting the page offers must open");
                assert_eq!(up.gpu_layers, plan.layers, "[{where_}] {label}: no fallback expected");
                drop(up);
            }
        }
    }
}
