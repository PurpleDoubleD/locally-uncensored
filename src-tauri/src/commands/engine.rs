use crate::os_error;
use super::process::tie_child_to_app_lifetime;

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
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::{AppState, BundledEngine};
use super::engine_sanity;

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

/// How far past the preferred port the engine may look for one it can open.
/// Bounded on purpose: twenty ports is far more than any desktop needs, and a
/// walk that never ends is a hang with extra steps.
const PORT_SEARCH_SPAN: u16 = 20;

// ── Pure helpers (unit-tested without a real binary) ─────────────────────────

/// Sidecar file name Tauri produces from
/// `externalBin: ["bin/lu-llama-server"]` inside the bundled app (target
/// triple suffix stripped, `.exe` on Windows).
///
/// GitHub #120 (Ubuntu 26.04, 2026-08-28): the file used to be
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

/// A successful request, kept separately from the reapable process handle.
/// Keep the requested tuning (including auto GPU layers), and the port that
/// actually served. Recovery must never silently revert a chosen 256K context.
#[derive(Debug, Clone, PartialEq)]
pub struct EngineRecoveryRecipe {
    pub model_path: String,
    pub tuning: EngineTuning,
    pub port: u16,
}

const REMOTE_ENGINE_WAIT: Duration = Duration::from_secs(600);
const REMOTE_ENGINE_STOPPED: &str = "The LU Engine was deliberately stopped. Start it in Settings, AI Backends before continuing.";

/// Waiting for the existing start gate also waits for a desktop model/context
/// reload. Unlike an explicit start, recovery never clears a stop request.
fn recovery_gate<'a>(gate: &'a std::sync::Mutex<()>, stopped: &std::sync::atomic::AtomicBool) -> Result<std::sync::MutexGuard<'a, ()>, String> {
    let deadline = Instant::now() + REMOTE_ENGINE_WAIT;
    loop {
        if stopped.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(REMOTE_ENGINE_STOPPED.into());
        }
        match gate.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::Poisoned(error)) => return Ok(error.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => {}
        }
        if Instant::now() >= deadline {
            return Err("The LU Engine is still reloading. Wait for it to finish, then try again.".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Separated from Tauri/process creation so races with Stop, concurrent phone
/// requests and desktop swaps can be checked without launching a real model.
fn ensure_remote_engine_with(
    gate: &std::sync::Mutex<()>,
    stopped: &std::sync::atomic::AtomicBool,
    recipes: &std::sync::Mutex<Option<EngineRecoveryRecipe>>,
    dispatched_path: &str,
    probe: impl Fn() -> Option<(String, u16, bool)>,
    start: impl FnOnce(&EngineRecoveryRecipe) -> Result<u16, String>,
) -> Result<u16, String> {
    let _gate = recovery_gate(gate, stopped)?;
    if stopped.load(std::sync::atomic::Ordering::SeqCst) { return Err(REMOTE_ENGINE_STOPPED.into()); }
    let recipe = recipes.lock().map_err(|_| "LU Engine recovery state unavailable")?.clone()
        .ok_or("The LU Engine has no previously loaded model to recover. Start it in Settings, AI Backends.")?;
    if recipe.model_path != dispatched_path {
        return Err("The desktop changed the loaded model. Dispatch Remote Access again before continuing.".into());
    }
    if let Some((model, port, healthy)) = probe() {
        if model != dispatched_path {
            return Err("The desktop changed the loaded model. Dispatch Remote Access again before continuing.".into());
        }
        // An alive but unresponsive model is not evidence of a crash. Never
        // kill an inference another desktop/phone request may still be using.
        if !healthy { return Err("The LU Engine is running but is not ready. Wait for its current operation, then try again.".into()); }
        return Ok(port);
    }
    // A Stop arriving while we inspected the handle must still prevent spawn.
    if stopped.load(std::sync::atomic::Ordering::SeqCst) { return Err(REMOTE_ENGINE_STOPPED.into()); }
    start(&recipe)
}

pub(crate) async fn ensure_remote_engine(app: AppHandle, dispatched_path: String) -> Result<u16, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        ensure_remote_engine_with(
            &crate::commands::process::ENGINE_START,
            &state.engine_stop_requested,
            &state.bundled_engine_recovery,
            &dispatched_path,
            || {
                let live = { let mut slot = state.bundled_engine.lock().unwrap(); live_sidecar(&mut slot) }?;
                let healthy = engine_healthy(live.port);
                if !healthy {
                    // The process can exit during the HTTP probe itself.
                    // Reap that death now rather than report an alive/busy
                    // engine until the phone's next request.
                    let mut slot = state.bundled_engine.lock().unwrap();
                    live_sidecar(&mut slot)?;
                }
                Some((live.model_path, live.port, healthy))
            },
            |recipe| {
                tracing::warn!(target: "engine", port = recipe.port, ctx = effective_ctx(&recipe.tuning), "recovering the Remote session's exited LU Engine");
                let answer = start_engine_and_remember(&app, &state, recipe.model_path.clone(), recipe.tuning.clone(), recipe.port)?;
                if stop_was_requested(&state) || answer.get("status").and_then(|v| v.as_str()) == Some("stopped") {
                    return Err(REMOTE_ENGINE_STOPPED.into());
                }
                answer.get("port").and_then(|p| p.as_u64()).and_then(|p| u16::try_from(p).ok())
                    .ok_or_else(|| "The LU Engine restart did not return a serving port.".into())
            },
        )
    }).await.map_err(|e| format!("LU Engine recovery task failed: {e}"))?
}

/// KV cache types this build of llama-server accepts and we consider sane.
const KV_CACHE_TYPES: &[&str] = &["f16", "bf16", "q8_0", "q4_0"];

/// The context size actually passed to the server (`tuning.ctx`, with 0
/// falling back to the 8192 default — see `EngineTuning::ctx`).
pub(crate) fn effective_ctx(tuning: &EngineTuning) -> u32 {
    if tuning.ctx == 0 { 8192 } else { tuning.ctx }
}

/// A GGUF file name without its extension, whatever case the extension is in.
fn gguf_stem(file_name: &str) -> &str {
    let at = file_name.len().saturating_sub(".gguf".len());
    match file_name.get(at..) {
        Some(ext) if ext.eq_ignore_ascii_case(".gguf") => &file_name[..at],
        _ => file_name,
    }
}

/// Name a vision projector gets on disk: `<model stem>.mmproj.gguf`, written
/// next to the model. Mirrors `mmprojFileName` in src/api/discover.ts, which is
/// what the downloader writes. Derived from the model name rather than kept
/// under the upstream name because the built-in models dir is FLAT: two vision
/// models in it would otherwise both claim one `mmproj-F16.gguf`.
pub(crate) fn mmproj_sibling_path(model_path: &str) -> PathBuf {
    let p = Path::new(model_path);
    let stem = p.file_name().and_then(|s| s.to_str()).map(gguf_stem).unwrap_or("");
    p.with_file_name(format!("{stem}.mmproj.gguf"))
}

/// True for a file name that is a vision projector, not a model. Keeps
/// projectors out of the model picker: they are GGUFs in the same folder, so
/// the plain "every .gguf is a model" scan would offer them as chat models and
/// llama-server would refuse to load them. Covers our own `.mmproj.gguf`
/// convention and the upstream names a user may drop in by hand, which carry
/// `mmproj` in front (`mmproj-F16.gguf`) or as a word of its own further back
/// (`<model>.mmproj-Q8_0.gguf`, `<model>-mmproj-f16.gguf`).
pub(crate) fn is_projector_file(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    let stem = gguf_stem(&lower);
    stem.starts_with("mmproj") || stem.split(['-', '.']).any(|word| word == "mmproj")
}

/// The last word of a GGUF name when it says how the weights are stored
/// (`Q4_K_M`, `IQ4_XS`, `f16`) and not which model it is. Lowercase in.
fn is_quant_word(word: &str) -> bool {
    let digit_after = |prefix: &str| {
        word.strip_prefix(prefix)
            .and_then(|rest| rest.chars().next())
            .is_some_and(|c| c.is_ascii_digit())
    };
    digit_after("q")
        || digit_after("iq")
        || matches!(word, "f16" | "f32" | "bf16" | "fp16" | "fp32" | "int4" | "int8")
}

/// A lowercase GGUF stem without its trailing quant word, if it has one.
fn without_quant_word(stem: &str) -> &str {
    match stem.rfind(['-', '.']) {
        Some(at) if is_quant_word(&stem[at + 1..]) => &stem[..at],
        _ => stem,
    }
}

/// Which model a lowercase model stem is, whatever quant it was saved in:
/// `foo-bar-q4_k_m`, `foo-bar.q8_0` and `foo-bar.i1-q4_k_m` (the imatrix
/// builds of the same weights) are all `foo-bar`.
fn model_base(stem: &str) -> &str {
    let base = without_quant_word(stem);
    base.strip_suffix(".i1").or_else(|| base.strip_suffix("-i1")).unwrap_or(base)
}

/// The model an upstream projector names in its own file name, lowercase stem
/// in. These are the three shapes the big GGUF publishers use:
/// `mmproj-<model>-f16`, `<model>.mmproj-Q8_0` and `<model>-mmproj-f16`. None
/// for a projector that names nothing (`mmproj-F16`) and for one in our own
/// `<file>.mmproj` shape, which belongs to exactly that file and no other.
fn projector_names_model(stem: &str) -> Option<&str> {
    if stem.ends_with(".mmproj") {
        return None;
    }
    let named = without_quant_word(stem);
    named
        .strip_prefix("mmproj-")
        .or_else(|| named.strip_suffix(".mmproj"))
        .or_else(|| named.strip_suffix("-mmproj"))
        .filter(|model| !model.is_empty())
}

/// Pick the projector of `model_name` out of the GGUF file names in its folder.
/// The one rule for every folder, ours and another tool's alike:
///
/// 1. `<model file>.mmproj.gguf`, the name our own downloads write.
/// 2. An upstream projector that carries this model's name. Two of them (an
///    f16 and a Q8_0 of the same projector) are a choice we do not make.
/// 3. A projector that names nothing or names something else, but only when it
///    is the single projector in a folder that holds this one model and no
///    other (several quants of it count as one). That is a repo folder as
///    LM Studio keeps it, or a models folder with one model in it.
///
/// Anything else is a guess, and a guess is worse than none: the models folder
/// is flat, so one stray `mmproj-F16.gguf` would otherwise hang itself on every
/// text model in it and the app would call them all able to see.
fn pick_projector<'a>(model_name: &str, gguf_names: &'a [String]) -> Option<&'a str> {
    let model = gguf_stem(model_name).to_ascii_lowercase();
    let stems: Vec<(&'a str, String)> = gguf_names
        .iter()
        .map(|name| (name.as_str(), gguf_stem(name).to_ascii_lowercase()))
        .collect();
    let only = |mut found: Vec<&'a str>| if found.len() == 1 { found.pop() } else { None };

    let own = format!("{model}.mmproj");
    let ours: Vec<&str> = stems.iter().filter(|(_, stem)| *stem == own).map(|(name, _)| *name).collect();
    if !ours.is_empty() {
        return only(ours);
    }

    let base = model_base(&model);
    let projectors: Vec<&(&str, String)> = stems.iter().filter(|(name, _)| is_projector_file(name)).collect();
    let named: Vec<&str> = projectors
        .iter()
        .filter(|(_, stem)| projector_names_model(stem) == Some(base))
        .map(|(name, _)| *name)
        .collect();
    if !named.is_empty() {
        return only(named);
    }

    let models: Vec<&String> = stems
        .iter()
        .filter(|(name, _)| !is_projector_file(name))
        .map(|(_, stem)| stem)
        .collect();
    let one_model = models.contains(&&model) && models.iter().all(|stem| model_base(stem) == base);
    match projectors.as_slice() {
        [(name, stem)] if one_model && !stem.ends_with(".mmproj") => Some(name),
        _ => None,
    }
}

/// Absolute path of the projector belonging to `model_path`, if it is on disk.
/// Absence is the normal case (text-only model) and never an error. Which file
/// belongs is `pick_projector`'s rule; the folder is only read when the name
/// our own downloads write is not there.
pub(crate) fn existing_mmproj(model_path: &str) -> Option<String> {
    let exact = mmproj_sibling_path(model_path);
    if exact.is_file() {
        return Some(exact.to_string_lossy().to_string());
    }
    let model = Path::new(model_path);
    let dir = model.parent()?;
    let gguf_names: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| gguf_stem(name).len() < name.len())
        .collect();
    let picked = pick_projector(model.file_name()?.to_str()?, &gguf_names)?;
    Some(dir.join(picked).to_string_lossy().to_string())
}

/// Can this GGUF read images once the built-in engine loads it?
///
/// Exactly the question `existing_mmproj` answers when the server is started:
/// llama-server sees images only with `--mmproj`, and that flag rides the argv
/// only when `existing_mmproj` finds the projector next to the model. Reported
/// with the model list so the frontend stops guessing from the model NAME.
/// Nebenbefund N3 of the D1 counter-check (Windows build, 2026-08-29): a text-only
/// gemma-3-4b conversion is a gemma3 by name, the app fed it the picture it
/// had just generated, and the run ended on a red "This model can't read
/// images" line under a picture that came out fine.
pub(crate) fn model_can_see_images(model_path: &str) -> bool {
    existing_mmproj(model_path).is_some()
}

// ── How much of a model a card can actually hold (3.0.0 list, bugs u and a) ──
//
// `-ngl 999` means "every layer on the graphics card". llama.cpp clamps it to
// the model's real layer count, which is why it reads as the idiomatic way to
// say "all of it", and on a roomy card it is. The two reports that opened this
// are the other case:
//
//   * Discord ticket-0009 (2026-09-07): a 12B model on an 8 GB RTX 4060. The
//     engine "start and exit again before it could serve on port 8127. It was
//     tried twice."
//   * GitHub 128 and two more Discord reports: a 3B Q4_K_M on a 2 GB card
//     answers with token soup.
//
// The app already knew how to ask this question and never asked it here: the
// fit check lives in the model picker (`computeFit`, src/components/models/
// ModelTiles.tsx), where it paints a coloured dot, and nothing of it ever
// reached the engine arguments.
//
// NOT PROVEN ON THE REPORTERS' HARDWARE. There is no 2 GB and no 8 GB NVIDIA
// card on the machine this was written on, so what is proven here is the
// arithmetic, by the tests at the bottom of this file. What changes for a user
// is narrower than "bug a is fixed": a card too small for the whole model is
// no longer asked by default to take all of it, and the log now says what the
// engine was told to do.

/// One MiB, for the reserves below and the numbers in the log line.
const MIB: u64 = 1024 * 1024;

/// Graphics memory that is spoken for before a single weight is loaded: the
/// driver's own context plus llama.cpp's compute buffers. A CUDA context alone
/// runs to a few hundred MiB and the compute buffer adds a few hundred more at
/// the default batch sizes, so 512 MiB is the round number above both.
///
/// This is the reserve for a MEASURED-free reading (`nvidia-smi`'s
/// `memory.free`, `VramReading.free == true`): the number already excludes
/// whatever else is running, so only the driver and the compute buffers are
/// left to hold back.
const VRAM_OVERHEAD_BYTES: u64 = 512 * MIB;

/// R1-3: the reserve for a reading that is NOT known to be free, the
/// `detect_gpus` fallback (`VramReading.free == false`) reports the card's
/// TOTAL size, not what is currently unused. A desktop compositor, a browser
/// and whatever Create last rendered can all be sitting in that total already,
/// same as the free-memory case this file's own header comment describes for
/// `engine_vram_reading`. 512 MiB on top of a total-capacity number plans as
/// if the card were otherwise empty; this takes a bigger, still round, bite
/// out of it instead, so a start on this weaker signal fails toward "fewer
/// layers than would have fit" rather than toward a start that dies.
const VRAM_OVERHEAD_BYTES_UNMEASURED: u64 = 2048 * MIB;

/// KV cache per offloaded layer per 1024 tokens of context.
///
/// 4 MiB is the f16 figure for a modern grouped query model: K and V, 1024
/// key and value dimensions, two bytes each, is 4 KiB per token per layer. A
/// model with wider key and value heads needs more than this and will be given
/// fewer layers than it could have held. That error costs speed. The opposite
/// error costs the start, which is the failure this whole block exists to
/// prevent.
const KV_BYTES_PER_LAYER_PER_1K_CTX: u64 = 4 * MIB;

/// The layer count assumed when the GGUF header does not carry one.
///
/// Deliberately LOW. The count only ever multiplies the fraction of the model
/// that fits, so a guess BELOW the real block count can only ask for fewer
/// layers than would have fit, never for more, and fewer layers is the
/// direction in which a start survives. 16 is under the block count of every
/// chat GGUF this app offers.
const ASSUMED_BLOCK_COUNT: u32 = 16;

/// What `-ngl` carries when every layer is wanted.
///
/// A number rather than a string, because two questions are asked of it: what
/// to write into argv, and whether a layer count read back OUT of argv is this
/// sentinel or a real measurement. A surface that printed "999" at a user
/// would be printing the sentinel.
const ALL_LAYERS: u32 = 999;

/// What `-ngl` carries when the engine decides the layer count itself (GH
/// #156). Written into argv as `auto`, read back as this number, so the retry
/// and the restart ladder below see "layers on the card" and keep handing the
/// same word on. Never shown to anyone: `gpu_layers_reported` drops it like
/// `ALL_LAYERS`.
const ENGINE_DECIDES: u32 = 998;

/// Whether the auto default goes to llama-server's own fit instead of the plan
/// below (GH #156).
///
/// A reading that is not free memory is a card's total from `detect_gpus`:
/// every AMD and Intel card on Windows and Linux, which run the Vulkan build.
/// The plan has to guess the rest from that total (a 2 GiB reserve and a
/// fixed cache size per layer). GH #156 reports "-1" running as slow as the
/// processor on a Navi 10 card where a typed 99 was fast, and this guess is
/// the only place where the two differ (no log of that machine was seen, so
/// the layer count it got is not known). The pinned llama-server measures the
/// memory of the device it really uses (`-ngl auto` with `--fit`, on by
/// default), so where LU cannot measure, the engine does. A measured-free
/// reading (`nvidia-smi`) keeps the plan, and so does the Mac, whose unified
/// memory the plan has always handled.
pub(crate) fn engine_fits_layers(card: Option<&crate::commands::gpu::VramReading>, mac: bool) -> bool {
    card.is_some_and(|c| !c.free) && !mac
}

/// The numbers an offload decision is made from. Plain values, so the
/// arithmetic can be checked without a graphics card in the machine.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct OffloadInputs {
    /// The GGUF on disk. Its size is the honest proxy for what the weights
    /// take in graphics memory at full offload, and the app already treats it
    /// as one (`modelBytes` in `bundled_engine_status`, GH #85).
    pub model_bytes: u64,
    /// `<arch>.block_count` from the header, when it could be read.
    pub block_count: Option<u32>,
    /// Free graphics memory where a probe measured it, the card's total where
    /// it could not, `None` where nothing measured a card at all.
    pub vram_bytes: Option<u64>,
    /// The context this start will ask for, which is what the KV cache is
    /// sized from.
    pub ctx: u32,
    /// R1-3: whether `vram_bytes` is a measured-free reading (`nvidia-smi`)
    /// or a card's total capacity (`detect_gpus`, `VramReading.free`).
    /// Meaningless when `vram_bytes` is `None`. Drives both the reserve
    /// (`VRAM_OVERHEAD_BYTES` vs `VRAM_OVERHEAD_BYTES_UNMEASURED`) and the
    /// wording of `why`: "are free" is simply false of a total-capacity
    /// number, and the log line that started every start read that way
    /// regardless of which kind of number backed it.
    pub free: bool,
    /// Size of the image part (mmproj) that lies next to the model, 0 for a
    /// model without one. The part is loaded into graphics memory beside the
    /// weights, so it is part of what has to fit.
    pub image_part_bytes: u64,
}

/// What the start should send as `-ngl`, and the sentence that explains it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct OffloadPlan {
    /// `None` means "ask for all layers": what this app has always sent, and
    /// what a machine with room and a machine nothing could measure both keep
    /// getting.
    pub layers: Option<u32>,
    /// One English clause for the log line, naming the numbers it decided on.
    /// Without it the log would carry a layer count nobody could argue with.
    pub why: String,
    /// Whether the image part is loaded with the model. False in exactly one
    /// case: the model alone fits on the card and the part would push it off.
    /// Always true for a model without a part, where there is nothing to drop.
    pub with_image_part: bool,
}

fn mib(bytes: u64) -> u64 {
    bytes / MIB
}

/// Decide how many layers go on the card.
///
/// Three outcomes, and two of them are the old behaviour:
///
///   * Nothing measured a card: all layers, exactly as before, and the log
///     says the probe came back empty.
///   * The model and its cache fit with the reserve: all layers, exactly as
///     before.
///   * They do not fit: `floor(usable / per_layer)`, where `per_layer` is the
///     file size divided by the block count plus that layer's share of the KV
///     cache, and `usable` is the measured memory minus the driver reserve.
///
/// Pure. No file is read and no card is asked; the caller collects the inputs
/// so this can be checked against hardware nobody here owns.
pub(crate) fn plan_offload(input: &OffloadInputs) -> OffloadPlan {
    let part = input.image_part_bytes;
    let Some(vram) = input.vram_bytes else {
        return OffloadPlan {
            layers: None,
            why: "no probe measured graphics memory on this machine, so every layer is requested exactly as before".to_string(),
            with_image_part: true,
        };
    };
    // A header that answers zero is a header that answered nothing.
    let read_from_header = input.block_count.filter(|b| *b > 0);
    let blocks = read_from_header.unwrap_or(ASSUMED_BLOCK_COUNT);
    // Round the context UP to whole thousands: a 6000 token context pays for
    // six, because the error has to point at reserving too much.
    let ctx_k = (input.ctx.max(1) as u64).div_ceil(1024);
    let kv_per_layer = KV_BYTES_PER_LAYER_PER_1K_CTX * ctx_k;
    // R1-3: a total-capacity reading is not a free-memory reading, and the
    // reserve taken out of it has to be bigger for the same reason the
    // sentence below has to say something different.
    let overhead = if input.free { VRAM_OVERHEAD_BYTES } else { VRAM_OVERHEAD_BYTES_UNMEASURED };
    let vram_clause = if input.free {
        format!("{} MiB are free", mib(vram))
    } else {
        format!("the card holds {} MiB in total (actual free memory was not measured)", mib(vram))
    };
    let whole = input.model_bytes + kv_per_layer * blocks as u64 + overhead;
    if whole + part <= vram {
        let what = if part > 0 { "the model, its cache and its image part" } else { "the model and its cache" };
        return OffloadPlan {
            layers: None,
            why: format!(
                "{what} need about {} MiB and {vram_clause}, so every layer is requested",
                mib(whole + part)
            ),
            with_image_part: true,
        };
    }
    // The image part (October 2026). The model alone fits, and its part would
    // be the thing that pushes layers off the card: then the model is loaded
    // whole and without the part, and the app says so in one sentence. A model
    // that answers at full speed and cannot see beats one that can see and
    // crawls, and the user who wants the picture has a way to get it (a
    // smaller context), while nobody asked for a slow chat.
    if part > 0 && whole <= vram {
        return OffloadPlan {
            layers: None,
            why: format!(
                "the model and its cache need about {} MiB and {vram_clause}, so every layer is requested, but the image part needs {} MiB more than that leaves, so the model is loaded without image input",
                mib(whole),
                mib(part)
            ),
            with_image_part: false,
        };
    }
    // The model alone does not fit. It is shared between the card and the
    // processor either way, so here the part stays: it takes its room out of
    // the budget first and costs a few layers, and a model the user chose
    // larger than the card does not lose its image input for good over it.
    // Only a card that cannot hold the part at all loads without it.
    let budget = vram.saturating_sub(overhead);
    let with_image_part = part == 0 || part < budget;
    let usable = if with_image_part { budget - part } else { budget };
    let per_layer = input.model_bytes / blocks as u64 + kv_per_layer;
    // A layer that costs nothing cannot be divided into the budget, so that
    // case answers 0 layers instead of dividing by zero.
    let layers = usable
        .checked_div(per_layer)
        .map_or(0, |fit| fit.min(blocks as u64) as u32);
    let counted = match read_from_header {
        Some(b) => format!("{b} layers the GGUF header names"),
        None => format!("{ASSUMED_BLOCK_COUNT} layers assumed, because the GGUF header carries no block count"),
    };
    let part_clause = if part == 0 {
        String::new()
    } else if with_image_part {
        format!(", {} MiB of that set aside for the image part", mib(part))
    } else {
        format!(", and without image input because the image part of {} MiB does not fit at all", mib(part))
    };
    OffloadPlan {
        layers: Some(layers),
        why: format!(
            "the model and its cache need about {} MiB but {vram_clause}, so {layers} of {counted} go on the card, at about {} MiB per layer and {} MiB held back for the driver and the compute buffers{part_clause}",
            mib(whole),
            mib(per_layer),
            mib(overhead)
        ),
        with_image_part,
    }
}

/// Said when a model came up without its image part because the card has no
/// room for it. Shown as it is, in the model menu and on the Models page.
pub(crate) const IMAGE_PART_NO_ROOM_NOTE: &str =
    "Loaded without image input: the graphics memory has no room for the image part next to the model. A smaller context makes room.";

/// Said when the engine refused the image part and the model was started
/// again without it.
pub(crate) const IMAGE_PART_REFUSED_NOTE: &str =
    "Loaded without image input: the engine could not load this model's image part.";

/// Did llama-server die on the image part and not on the model?
///
/// The part is loaded AFTER the model, by its own code path, and that path
/// names itself when it fails: `clip_init: failed to load model`,
/// `mtmd_init_from_file: error:`, `failed to load multimodal model`. A line
/// that only mentions the part, like the one reporting that it was loaded,
/// does not count; the line has to name the part and a failure together.
///
/// NOT PROVEN ON A REAL FAILURE. The pinned llama.cpp loads every part this
/// was tried with, so the markers come from reading its source, and the
/// arithmetic is proven by the tests below. What it buys: a catalog model
/// whose part the engine does not understand still starts and answers, and
/// says that it cannot see, where it used to not start at all.
pub(crate) fn stderr_blames_the_image_part(stderr: &str) -> bool {
    const NAMES: &[&str] = &["mmproj", "mtmd", "clip_", "multimodal"];
    const FAILS: &[&str] = &["fail", "error", "unsupported", "not supported", "unknown", "invalid"];
    stderr.lines().any(|line| {
        let lower = line.to_ascii_lowercase();
        NAMES.iter().any(|n| lower.contains(n)) && FAILS.iter().any(|f| lower.contains(f))
    })
}

/// The `-ngl` value in a finished argv.
///
/// The retry reads the number back OUT of the arguments instead of working it
/// out a second time, so the decision it makes can never disagree with what
/// the first attempt was actually told.
///
/// `auto` reads back as `ENGINE_DECIDES`: layers are meant for the card, the
/// engine picks how many.
pub(crate) fn gpu_layers_in(args: &[String]) -> Option<u32> {
    args.windows(2).find(|w| w[0] == "-ngl").and_then(|w| {
        if w[1] == "auto" { Some(ENGINE_DECIDES) } else { w[1].parse().ok() }
    })
}

/// The `-ngl` word for an argv: a count, or `auto` for `ENGINE_DECIDES`.
fn ngl_arg(layers: u32) -> String {
    if layers == ENGINE_DECIDES { "auto".into() } else { layers.to_string() }
}

/// The layer count a surface may show the user, `None` when the start asked
/// for every layer.
///
/// `None` is what nearly every machine gets: a card with room, and a card
/// nothing could measure, both send the sentinel. A number here means the app
/// decided against the card (or the user typed one), which is the only case
/// worth a line on screen.
pub(crate) fn gpu_layers_reported(args: &[String]) -> Option<u32> {
    gpu_layers_in(args).filter(|n| *n != ALL_LAYERS && *n != ENGINE_DECIDES)
}

/// The argv with the `-ngl <n>` pair removed, for the idempotence check.
pub(crate) fn argv_without_gpu_layers(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut i = 0;
    while i < args.len() {
        if args[i] == "-ngl" && i + 1 < args.len() {
            i += 2;
            continue;
        }
        out.push(args[i].clone());
        i += 1;
    }
    out
}

/// Build the `llama-server` argv for a chat engine.
///
/// `auto_ngl` is what `plan_offload` resolved the "auto" default to, and it is
/// consulted ONLY when the user left GPU Layers on auto (`gpu_layers < 0`).
/// `None` there means "ask for all layers" and produces the exact argv this
/// app has always produced, which is what a machine nothing could measure and
/// a machine with room both get. A typed number always wins over both: an
/// expert who wrote 20 into Settings gets 20.
///
/// Default tuning with `auto_ngl` at `None` yields exactly the legacy argv
/// (pinned by regression test).
///
/// `mmproj` turns the model multimodal. A text GGUF has no image tower, so
/// without the flag a vision model loads and answers, it just cannot see, which
/// is exactly the silent failure the Discover download avoids by fetching the
/// projector with the model.
pub(crate) fn build_server_args(model_path: &str, tuning: &EngineTuning, port: u16, slot_save_dir: Option<&str>, mmproj: Option<&str>, auto_ngl: Option<u32>) -> Vec<String> {
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
            ngl_arg(auto_ngl.unwrap_or(ALL_LAYERS))
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
        // Qwen's image tower takes an image at a resolution of its own
        // choosing, and by default so small that a button on a full screen
        // is a handful of pixels. A floor of 1024 tokens per image is what
        // makes its clicks land (model card, and llama.cpp's own note for
        // grounding with Qwen). Other families ignore the flag or have a
        // fixed size, so it is set for Qwen alone.
        let stem = Path::new(model_path).file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
        if stem.contains("qwen") {
            args.push("--image-min-tokens".into());
            args.push("1024".into());
        }
    }
    // GH #85: enable llama-server's slot save/restore API so the
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

/// The whole `llama-server` invocation as one line, for the log file.
///
/// Bug o of the 3.0.0 list: every line this module wrote went to `println!`,
/// and a shipped Windows build has no stdout (`windows_subsystem = "windows"`,
/// see the finding at the top of commands/logging.rs). So the file behind
/// Settings, Troubleshoot said nothing at all about the engine: not the model,
/// not the context, not the layer count, not the port. A user whose engine
/// died on start could send a log that did not contain the start.
///
/// Quoting is for the human reading the file, not for a shell: a Windows model
/// path contains spaces, and without quotes `-m C:\Program Files\...` reads
/// like two arguments. Nothing here is ever executed, and nothing in this argv
/// is a secret: it is paths, numbers and flags.
pub(crate) fn command_line(binary: &Path, args: &[String]) -> String {
    let quote = |s: &str| -> String {
        if s.is_empty() || s.chars().any(char::is_whitespace) {
            format!("\"{s}\"")
        } else {
            s.to_string()
        }
    };
    let mut line = quote(&binary.to_string_lossy());
    for a in args {
        line.push(' ');
        line.push_str(&quote(a));
    }
    line
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
pub(crate) fn split_shard_stem(stem: &str) -> Option<(&str, u32, u32)> {
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
// Only the tests call this since the listing went multi-root, and they are the
// reason to keep it: every scan rule that predates GH #122 is pinned through
// this one-root door, so a change to the walk still has to survive them.
#[allow(dead_code)]
pub(crate) fn scan_gguf_models(dir: &Path) -> Vec<BundledModel> {
    scan_gguf_roots(&[ScanRoot { dir, max_depth: MAX_SCAN_DEPTH }]).models
}

/// One folder the GGUF scan walks, and how deep it may go there.
pub(crate) struct ScanRoot<'a> {
    pub dir: &'a Path,
    pub max_depth: usize,
}

/// How one root fared. The Model Storage panel reads this, because "no models"
/// and "I could not finish looking" are different answers and the user is the
/// only one who can act on the difference.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RootStatus {
    /// Walked to the end, within the budget.
    Ok,
    /// The deadline or the entry budget ran out. What was found is real, the
    /// list is not complete.
    Truncated,
    /// `read_dir` on the root itself failed: gone, or unplugged.
    Unreachable,
    /// The folder is there and this account may not read it. Its own answer,
    /// because "check that the drive is connected" sends the user looking for
    /// a fault that is not there (P3, 7.4).
    Denied,
    /// Not a path the OS can resolve on its own: relative, or a shell `~`.
    Unusable,
}

impl RootStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            RootStatus::Ok => "ok",
            RootStatus::Truncated => "truncated",
            RootStatus::Unreachable => "unreachable",
            RootStatus::Denied => "denied",
            RootStatus::Unusable => "unusable",
        }
    }
}

/// What a scan of several roots produced, and how each root fared.
pub(crate) struct ScanOutcome {
    pub models: Vec<BundledModel>,
    /// One entry per root, in the order the roots were given.
    pub statuses: Vec<RootStatus>,
}

/// Wall-clock ceiling for ONE root.
///
/// The walk has no idea what it was pointed at. Four levels below `C:\` or a
/// home directory is tens of thousands of `read_dir` calls, and `fetchModels`
/// awaits this: the Models tab, every picker and onboarding sit and wait for it.
/// A partial answer within a few seconds beats a complete one nobody stayed for,
/// and the panel says the answer is partial.
const SCAN_DEADLINE: Duration = Duration::from_secs(5);

/// Directory entries one root may look at. A second ceiling because a fast
/// local SSD can burn a very long list well inside the deadline, and because a
/// symlink loop is bounded by this and not by the clock.
const SCAN_ENTRY_BUDGET: usize = 20_000;

/// The ceilings for one root, carried down the walk.
struct ScanBudget {
    deadline: Instant,
    entries_left: usize,
    truncated: bool,
}

impl ScanBudget {
    fn new() -> Self {
        Self {
            deadline: Instant::now() + SCAN_DEADLINE,
            entries_left: SCAN_ENTRY_BUDGET,
            truncated: false,
        }
    }

    /// True while there is room for one more entry. Flips `truncated` the first
    /// time there is not, so the caller can say so instead of reporting a short
    /// list as the whole truth.
    fn take(&mut self) -> bool {
        if self.entries_left == 0 || Instant::now() >= self.deadline {
            self.truncated = true;
            return false;
        }
        self.entries_left -= 1;
        true
    }
}

/// The same scan over SEVERAL folders, in priority order.
///
/// GH #122 (2026-08-28): the folder the user names under Model
/// Storage was a download target and nothing else. A GGUF that was already
/// sitting in `G:\AI\Models`, or one an earlier LU download had put there,
/// was never looked at, so the Models tab stayed empty and the file could not
/// be loaded at all. The app models dir is root 0 and still wins every name
/// collision, so adding a custom folder can never displace what the app
/// installed itself.
pub(crate) fn scan_gguf_roots(roots: &[ScanRoot]) -> ScanOutcome {
    // (root index, model). The index is the first tie-break below, so an
    // earlier root always wins a duplicate name.
    let mut ranked: Vec<(usize, BundledModel)> = Vec::new();
    let mut statuses: Vec<RootStatus> = Vec::with_capacity(roots.len());
    for (rank, root) in roots.iter().enumerate() {
        if !crate::commands::custom_models::is_usable_root(root.dir) {
            statuses.push(RootStatus::Unusable);
            continue;
        }
        // One call answers "is it there and readable" before the walk, so a
        // dead mount costs one timeout instead of one per directory. The same
        // call as the ComfyUI handover makes, so the two verdicts about one
        // folder cannot drift apart.
        match crate::commands::custom_models::root_probe(root.dir) {
            None => {}
            Some(std::io::ErrorKind::PermissionDenied) => {
                statuses.push(RootStatus::Denied);
                continue;
            }
            Some(_) => {
                statuses.push(RootStatus::Unreachable);
                continue;
            }
        }
        let mut out = Vec::new();
        let mut sets = GgufSplitSets::new();
        let mut budget = ScanBudget::new();
        scan_gguf_dir(root.dir, 0, root.max_depth, &mut budget, &mut out, &mut sets);
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
        statuses.push(if budget.truncated { RootStatus::Truncated } else { RootStatus::Ok });
        ranked.extend(out.into_iter().map(|m| (rank, m)));
    }
    // A name is the picker id, so it has to be unique. The earlier root wins,
    // then the shallowest copy (the flat app dir is the canonical place);
    // ties fall to the path.
    ranked.sort_by(|a, b| {
        let depth = |p: &str| p.matches(['/', '\\']).count();
        a.1.name
            .cmp(&b.1.name)
            .then(a.0.cmp(&b.0))
            .then(depth(&a.1.path).cmp(&depth(&b.1.path)))
            .then(a.1.path.cmp(&b.1.path))
    });
    let mut models: Vec<BundledModel> = ranked.into_iter().map(|(_, m)| m).collect();
    models.dedup_by(|a, b| a.name == b.name);
    ScanOutcome { models, statuses }
}

/// How far below the app models dir the scan walks. 0 alone was the shipped
/// behaviour and it is still where every model the app writes today lands.
///
/// GH #118 (2026-08-27): before the download-routing fix, a chat model
/// installed on a fresh box was written to `<models>/<user>/<repo>/x.gguf`,
/// the LM Studio layout. The routing is fixed, but the boxes that already ran
/// the broken build have multi-gigabyte files sitting in those folders. Two
/// levels reach them, so those installs heal on the next model refresh instead
/// of asking the user to download everything a second time. Deeper than that
/// buys nothing and only costs directory reads.
pub(crate) const MAX_SCAN_DEPTH: usize = 2;

/// How far the scan walks below a folder the USER named under Model Storage.
/// Deeper than the app dir on purpose: a grown model library is filed by hand
/// (`G:\AI\Models\Text Generation\<author>\<repo>\file.gguf` in GH #122's
/// screenshots), and two levels stop one folder short of exactly that.
pub(crate) const MAX_CUSTOM_SCAN_DEPTH: usize = 4;

/// Accumulator for multi-part GGUF sets: `(dir, base, total)` maps to
/// `(part numbers seen, path of part 1, byte sum)`.
///
/// The directory is part of the key: two unrelated split sets that share a base
/// name in different subfolders must never merge into one entry. Named because
/// the bare type is what `clippy::type_complexity` fires on, and a name says
/// what the tuples mean better than the tuples do.
type GgufSplitSets =
    std::collections::HashMap<(PathBuf, String, u32), (Vec<u32>, Option<String>, u64)>;

fn scan_gguf_dir(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    budget: &mut ScanBudget,
    out: &mut Vec<BundledModel>,
    sets: &mut GgufSplitSets,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        // Both ceilings are asked per entry, so a folder the walk should never
        // have been pointed at costs seconds instead of minutes, and a symlink
        // that points back up the tree cannot spin forever.
        if !budget.take() {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            if depth < max_depth {
                scan_gguf_dir(&path, depth + 1, max_depth, budget, out, sets);
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
        // fs::metadata FOLLOWS the link, entry.metadata() does not. A GGUF
        // reached through a symlink otherwise reports the size of the link
        // itself, a hundred-odd bytes, and the HuggingFace cache is built
        // exactly that way: snapshots/<rev>/model.gguf is a link into blobs/.
        // The card would have shown a 14 GB model as 116 bytes.
        let size = std::fs::metadata(&path)
            .or_else(|_| entry.metadata())
            .map(|m| m.len())
            .unwrap_or(0);
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
    dirs::data_dir().ok_or("Cannot resolve app data directory")?;
    let dir = crate::os_paths::builtin_models_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Create LU Engine models folder: {}", os_error::english(&e)))?;
    Ok(dir)
}

// ── Sidecars a dead app left behind (macOS) ──────────────────────────────────
//
// Fehlerkontrolle Mac 2, Fund 9. On Windows a kill-on-close job object takes
// every sidecar down with the app, however the app ends. macOS has nothing of
// the kind: no job object, and no parent-death signal (Linux's
// `PR_SET_PDEATHSIG` does not exist here). After a crash or a "Force Quit"
// the llama-server stays, reparented to launchd, holding a whole model in the
// shared memory until the user finds it in Activity Monitor.
//
// The ways to close that, and why this one:
//
//   * a watcher thread in the app (kqueue `NOTE_EXIT`) dies with the app, so
//     it watches nothing in exactly the case that matters;
//   * the sidecar watching its parent itself needs a flag in the sidecar, and
//     llama-server has none (no "parent" option among the strings of
//     `bin/lu-llama-server-aarch64-apple-darwin`);
//   * a separate guardian process would be one more binary to build, sign and
//     notarise, for a rare event;
//   * so the next start cleans up. It cannot free the memory while the app is
//     gone, and that is the stated limit of it; it does make the leftover end
//     the moment the user opens the app again, which is what a user does
//     after a crash, and it needs nothing that could itself be orphaned.
//
// What counts as ours to kill is deliberately narrow, because the name alone
// is not ownership: the process runs the very file this app would start, AND
// its parent is launchd (pid 1), which is where the kernel puts a process
// whose parent died. A sidecar of a running app still has that app as parent
// and is never touched, and neither is a llama-server of another install,
// another worktree or the user's own.

/// One process, reduced to what the orphan rule reads.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ProcRow {
    pub pid: u32,
    pub parent: Option<u32>,
    pub exe: Option<PathBuf>,
}

/// The pids in `rows` that are sidecars of ours without a living app.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn orphaned_sidecars(rows: &[ProcRow], ours: &Path) -> Vec<u32> {
    // A temp or bundle path can be reached under two names (/var and
    // /private/var), so both sides are resolved before they are compared.
    let real = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let ours = real(ours);
    rows.iter()
        .filter(|row| row.parent == Some(1))
        .filter(|row| row.exe.as_deref().map(real).as_deref() == Some(ours.as_path()))
        .map(|row| row.pid)
        .collect()
}

/// The process table with executable paths. `refresh_processes` alone leaves
/// `exe()` empty for processes it has not been asked about, the same trap
/// `process_util::process_table_with_cmdlines` documents for `cmd()`.
#[cfg(target_os = "macos")]
fn process_rows() -> Vec<ProcRow> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
    );
    sys.processes()
        .iter()
        .map(|(pid, process)| ProcRow {
            pid: pid.as_u32(),
            parent: process.parent().map(|p| p.as_u32()),
            exe: process.exe().map(Path::to_path_buf),
        })
        .collect()
}

/// End every orphaned sidecar that runs `ours` and return their pids.
#[cfg(target_os = "macos")]
pub(crate) fn reap_orphaned_sidecars_of(ours: &Path) -> Vec<u32> {
    let found = orphaned_sidecars(&process_rows(), ours);
    for pid in &found {
        // SIGTERM first, SIGKILL after the grace: llama-server unloads on
        // SIGTERM, and a wedged one must not survive this either.
        crate::process_util::kill_pid_tree(*pid);
    }
    found
}

/// Called once at app start on a Mac, off the main thread.
#[cfg(target_os = "macos")]
pub fn reap_orphaned_sidecars(app: &AppHandle) {
    let Some(binary) = resolve_engine_binary(app) else { return };
    let ended = reap_orphaned_sidecars_of(&binary);
    if !ended.is_empty() {
        tracing::warn!(target: "engine", pids = ?ended, "ended sidecars orphaned by a previous run");
    }
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

/// K1 (3.0.1): directory holding the dynamic-ISA sidecar's companion
/// ggml-cpu-*/ggml-vulkan libraries (Windows, Linux; see
/// scripts/build-llama.sh). `None` on mac, which keeps the old static Metal
/// binary and has nothing to find, and `None` when nothing was built yet (a
/// start then runs exactly as it did before this change, and a genuine
/// failure still surfaces through the ordinary StartFailure path instead of
/// a made-up error here).
///
/// The one file every candidate backend_dir MUST contain to be real: ggml-base
/// is the shared runtime every CPU variant (and the exe itself) links
/// against (see verify-sidecar-isa.sh), so checking for it, not merely for
/// the directory's existence, is what tells a real build apart from an
/// unrelated directory that happens to be there. "lib" prefix only on
/// non-Windows: ggml/CMakeLists.txt strips it `if (WIN32)` only.
fn backend_marker_filename() -> &'static str {
    if cfg!(target_os = "windows") { "ggml-base.dll" } else { "libggml-base.so" }
}

/// Pure core of `resolve_engine_backend_dir`: given an ordered list of
/// candidate directories and a predicate for "does this directory really
/// hold the marker file", return the first candidate that passes. Split out
/// and made generic over the predicate (BLOCKER B2) specifically so both the
/// Windows and the Linux/mac logic branches can be unit tested on any host
/// OS with an injected filesystem, not only for real on the platform being
/// tested: `resource_dir()` is unconditionally the running exe's own
/// directory on Windows (tauri-utils 2.8.3, platform.rs:297-302), which is
/// ALWAYS an existing directory whether or not it holds any ggml DLLs, so a
/// `.is_dir()` check (what this used to be) always accepted it and made the
/// dev-mode fallback candidate unreachable there. Checking for a specific
/// file closes that gap on every platform, not just Windows.
fn pick_backend_dir(candidates: &[PathBuf], has_marker: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    candidates.iter().find(|c| has_marker(c)).cloned()
}

/// Mirrors `resolve_engine_binary`'s tiers: the bundled resource location
/// first, then the dev-time path the build script writes straight to.
fn resolve_engine_backend_dir(app: &AppHandle) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        return None;
    }
    let triple = host_target_triple();
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 1. Bundled. Windows: tauri.windows.conf.json flattens the companion
    //    DLLs into the ROOT of the resource dir, which on Windows IS the same
    //    directory as the running executable (tauri's own resource_dir()
    //    docs), so this is also where lu-llama-server.exe itself sits. Linux:
    //    tauri.linux.conf.json nests them under a "llama/" subdirectory
    //    instead, because deb/AppImage keep externalBin (the exe, in
    //    usr/bin) and `resources` (usr/lib/<exe_name>) apart (see GitHub
    //    #120 in sidecar_binary_name's comment above for the externalBin
    //    placement, and tauri::path::resource_dir's own platform doc for the
    //    resource placement).
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(if cfg!(target_os = "windows") { res } else { res.join("llama") });
    }

    // 2. Dev: scripts/build-llama.sh writes straight to
    //    src-tauri/resources/llama/<triple>/, the same source path
    //    tauri.windows.conf.json / tauri.linux.conf.json bundle from.
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        candidates.push(PathBuf::from(&manifest).join("resources").join("llama").join(&triple));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("resources").join("llama").join(&triple));
        candidates.push(cwd.join("resources").join("llama").join(&triple));
    }

    let marker = backend_marker_filename();
    pick_backend_dir(&candidates, |dir| dir.join(marker).is_file())
}

// ── K1-14 (3.0.1): long install paths on Windows ───────────────────────────
//
// See klaerung-63.md and BERICHT.md #63: on Windows, `Command::current_dir`
// can itself fail on a long backend_dir before the child process ever
// starts. The decision below (which path to hand to `current_dir`, if any)
// is kept free of any real Windows API call so it can be unit tested on
// every host OS; only `windows_current_dir_for_backend` (cfg(windows)) wires
// it up to the real `GetShortPathNameW` call and real UTF-16 lengths.
//
// review-longpath.md Runde 1, Auflage 5: `Command::current_dir` does NOT
// call `SetCurrentDirectoryW` in this (the parent) process. Rust hands the
// path straight through as `CreateProcessW`'s `lpCurrentDirectory` argument
// (`library/std/src/sys/process/windows.rs`, `make_dirp`/the `si.lpCurrentDirectory`
// wiring); no `SetCurrentDirectoryW` call happens here at all. The classic
// length ceiling still applies to `lpCurrentDirectory` regardless: Microsoft's
// own `SetCurrentDirectory` reference page states it as a general rule about
// process creation, not about that one function's own parameter: "Important:
// Setting a current directory longer than MAX_PATH causes CreateProcessW to
// fail." Unlike `GetShortPathNameW`'s `lpszLongPath` (Auflage 1 below) or the
// handful of directory functions Microsoft explicitly re-lists under
// "Functions without MAX_PATH restrictions" (`SetCurrentDirectoryW` among
// them, opt-in via a `longPathAware` manifest plus the `LongPathsEnabled`
// registry value), Microsoft documents no `\\?\` or opt-in escape for
// `lpCurrentDirectory` itself. There is nothing to opt into here: the
// short-name fallback below is the only lever this code has.

/// Classic Win32 `MAX_PATH` is 260 wide chars including the terminating NUL.
/// review-longpath.md Runde 1, Auflage 2 (BLOCKER): `backend_dir` never ends
/// in a trailing backslash (it comes from `resource_dir()`, a plain
/// `PathBuf`), and Microsoft's own `SetCurrentDirectory` reference is
/// explicit about what that costs: "the final character before the null
/// character must be a backslash... specify >MAX_PATH-2 characters for the
/// path unless you include the trailing backslash". Without one, the last
/// SAFE length is therefore `MAX_PATH - 2` = 258, not 259: at 259, Windows'
/// own appended backslash plus the terminator pushes the real total to
/// exactly `MAX_PATH`, which the same page calls out by name ("Setting a
/// current directory longer than MAX_PATH causes CreateProcessW to fail").
/// 248 (`MAX_PATH - 12`) is a DIFFERENT limit, `CreateDirectory`'s own room
/// for an 8.3 name, and does not apply here (confirmed against Rust's own
/// `sys/path/windows.rs`, which only cites 248 for `CreateDirectory`).
///
/// This app ships no `longPathAware` manifest (checked: no `.manifest`, no
/// `longPathAware` anywhere under `src-tauri/`), and in any case Microsoft
/// documents no such opt-in for `lpCurrentDirectory` (see the module doc
/// above), so 258 is the ceiling regardless of that manifest.
///
/// This constant and the pure functions below it are real production code
/// only on Windows, but are also compiled under `cfg(test)` on every host OS
/// (BLOCKER B2 style, see `pick_backend_dir`'s own comment) so the DECISION
/// logic (is this path too long, which fallback to pick) has a direct,
/// platform-independent unit test, not only a Windows-only integration test
/// that can only run on the box.
#[cfg(any(windows, test))]
const CLASSIC_MAX_PATH_CHARS: usize = 258;

/// Pure predicate: does this many UTF-16 code units exceed the classic
/// Windows current-directory limit? Split out from the actual length
/// measurement (`encode_wide().count()`, Windows-only) so the threshold
/// itself is testable with plain numbers on any host OS.
#[cfg(any(windows, test))]
fn exceeds_classic_current_dir_limit(utf16_len: usize) -> bool {
    utf16_len > CLASSIC_MAX_PATH_CHARS
}

/// What to hand `Command::current_dir` for a backend dir that might be too
/// long. Kept separate from the actual `GetShortPathNameW` call so the
/// decision itself is unit-testable on any host OS with a fake resolver.
#[cfg(any(windows, test))]
#[derive(Debug, PartialEq, Eq)]
enum LongPathDecision {
    /// Short enough already: pass `dir` through unchanged.
    UseAsIs,
    /// Too long, but an 8.3 short name for it fits inside the limit.
    UseShortName(PathBuf),
    /// Too long, and no usable short name (8dot3 name creation disabled on
    /// the volume, the short name is itself still too long, or the lookup
    /// failed outright): leave `current_dir` unset rather than fail the
    /// whole spawn.
    SkipCurrentDir,
}

/// Pure decision core. `dir_utf16_len` is the real directory's own UTF-16
/// length; `resolve_short_name` is called at most once, only when the
/// directory is over the limit, and returns the short name together with
/// ITS UTF-16 length so this function never has to measure a path itself
/// (that stays in the Windows-only caller). Tests exercise this directly
/// with canned lengths and closures, no real path or Windows API involved.
#[cfg(any(windows, test))]
fn decide_long_path_current_dir(
    dir_utf16_len: usize,
    resolve_short_name: impl FnOnce() -> Option<(PathBuf, usize)>,
) -> LongPathDecision {
    if !exceeds_classic_current_dir_limit(dir_utf16_len) {
        return LongPathDecision::UseAsIs;
    }
    match resolve_short_name() {
        Some((short, short_utf16_len)) if !exceeds_classic_current_dir_limit(short_utf16_len) => {
            LongPathDecision::UseShortName(short)
        }
        _ => LongPathDecision::SkipCurrentDir,
    }
}

/// Windows-only: a path's length the same way Win32 measures it (UTF-16 code
/// units), not `str::len()` (UTF-8 bytes, which undercounts for non-ASCII).
#[cfg(windows)]
fn utf16_len(path: &Path) -> usize {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().count()
}

// review-longpath.md Runde 1, Auflage 1 (BLOCKER): `GetShortPathNameW`'s OWN
// `lpszLongPath` input is capped at classic MAX_PATH unless it carries a
// `\\?\` (or, for a UNC path, `\\?\UNC\`) prefix (Microsoft,
// GetShortPathNameW docs, `lpszLongPath`: "By default, the name is limited
// to MAX_PATH characters. To extend this limit to 32,767 wide characters,
// prepend \\?\ to the path."). `backend_dir` is exactly the un-prefixed,
// over-the-limit path this whole fallback exists for, so without adding the
// prefix here, the call fails on the very input it was meant to rescue and
// `decide_long_path_current_dir` can only ever reach `SkipCurrentDir`. The
// two functions below add and remove that prefix; they work on raw UTF-16
// code units (not `Path`) so they are plain, allocation-cheap, and directly
// unit-testable on every host OS, same as the decision logic above.

/// `\\?\` (backslash, backslash, question mark, backslash: FOUR characters),
/// as UTF-16 code units (every character here is ASCII, so the `u16` and
/// `u8` values are the same).
#[cfg(any(windows, test))]
const VERBATIM_PREFIX: [u16; 4] = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];

/// `\\?\UNC\` (eight characters), the verbatim form Microsoft's own "Naming
/// Files, Paths, and Namespaces" page documents for a UNC path
/// (`\\server\share\...` becomes `\\?\UNC\server\share\...`, dropping the
/// path's own leading `\\`).
#[cfg(any(windows, test))]
const VERBATIM_UNC_PREFIX: [u16; 8] = [
    b'\\' as u16,
    b'\\' as u16,
    b'?' as u16,
    b'\\' as u16,
    b'U' as u16,
    b'N' as u16,
    b'C' as u16,
    b'\\' as u16,
];

/// A plain backslash, as a UTF-16 code unit.
#[cfg(any(windows, test))]
const BACKSLASH: u16 = b'\\' as u16;

/// A plain forward slash, as a UTF-16 code unit.
#[cfg(any(windows, test))]
const FORWARD_SLASH: u16 = b'/' as u16;

/// review-longpath.md Runde 2, Auflage 11 (small): fold ASCII `A-Z` to
/// lowercase, leaving every other code unit (backslashes, `?`, non-ASCII)
/// untouched. Used only to compare the fixed "UNC" letters of the verbatim
/// prefix case-insensitively; nothing here does general Unicode casing.
#[cfg(any(windows, test))]
fn ascii_lower(c: u16) -> u16 {
    if (b'A' as u16..=b'Z' as u16).contains(&c) { c + 32 } else { c }
}

/// Does `path` start with `\\?\UNC\`, comparing the "UNC" letters without
/// regard to case (review-longpath.md Runde 2, Auflage 11)? A plain
/// `[u16]::starts_with` would miss a `\\?\unc\...` input and leave
/// `strip_verbatim_prefix` stripping only the plain `\\?\` part of it,
/// handing back a broken relative path (`unc\server\share` instead of
/// `\\server\share`). `resource_dir()` never produces this in practice, but
/// `GetShortPathNameW` is free to hand back whatever casing it wants, and a
/// silent wrong answer is worse than one extra comparison.
#[cfg(any(windows, test))]
fn starts_with_verbatim_unc_prefix_ci(path: &[u16]) -> bool {
    path.len() >= VERBATIM_UNC_PREFIX.len()
        && path[..VERBATIM_UNC_PREFIX.len()]
            .iter()
            .zip(VERBATIM_UNC_PREFIX.iter())
            .all(|(&a, &b)| ascii_lower(a) == ascii_lower(b))
}

/// Add the verbatim prefix `GetShortPathNameW` needs to accept an
/// over-MAX_PATH input. A path that already carries `\\?\` is returned
/// unchanged (never doubled); a UNC path (`\\server\share\...`) becomes
/// `\\?\UNC\server\share\...`; anything else (a drive-letter path) is simply
/// prefixed with `\\?\`.
///
/// review-longpath.md Runde 2, Auflage 11 (small), two edge cases hardened:
/// - Forward slashes are normalized to backslashes FIRST. The verbatim
///   prefix "disables all string parsing" (Microsoft, "Naming Files, Paths,
///   and Namespaces"), forward-slash-as-separator included, so a
///   `C:/long/path` handed to `GetShortPathNameW` verbatim would not resolve
///   as a path at all; `resource_dir()` never produces one in practice
///   (`PathBuf` renders with the platform separator), but the call must not
///   quietly mis-parse one if it ever did.
/// - A device path (`\\.\...`) is not mistaken for a UNC share: both start
///   with two backslashes, but the third character tells them apart (`.`
///   for a device, anything else for a UNC server name). Prefixing a device
///   path as if it were UNC would silently point `GetShortPathNameW` at a
///   nonexistent `\\?\UNC\.\...` path instead of failing loudly; `SkipCurrentDir`
///   is still the safe outcome either way (klaerung-63.md), this just keeps
///   the failure honest rather than a wrong guess.
#[cfg(any(windows, test))]
fn verbatim_prefixed(long_path: &[u16]) -> Vec<u16> {
    if long_path.starts_with(&VERBATIM_PREFIX) {
        return long_path.to_vec();
    }
    let normalized: Vec<u16> =
        long_path.iter().map(|&c| if c == FORWARD_SLASH { BACKSLASH } else { c }).collect();
    let is_unc = normalized.len() >= 3
        && normalized[0] == BACKSLASH
        && normalized[1] == BACKSLASH
        && normalized[2] != b'.' as u16; // "\\.\..." is a device path, not UNC
    let mut out = Vec::with_capacity(normalized.len() + VERBATIM_UNC_PREFIX.len());
    if is_unc {
        out.extend_from_slice(&VERBATIM_UNC_PREFIX);
        out.extend_from_slice(&normalized[2..]); // drop the UNC path's own leading "\\"
    } else {
        out.extend_from_slice(&VERBATIM_PREFIX);
        out.extend_from_slice(&normalized);
    }
    out
}

/// Undo `verbatim_prefixed`. Needed for two reasons (review-longpath.md
/// Auflage 1): `lpCurrentDirectory` does not accept a verbatim path at all
/// (Rust's own std strips one right back off for this exact parameter,
/// `library/std/src/sys/process/windows.rs`, comment there: "the current
/// directory does not support verbatim paths"; this code must not rely on
/// that silently, both because it should not assume undocumented std
/// internals and because the LENGTH check below would still be wrong
/// otherwise), and counting the `\\?\`/`\\?\UNC\` characters themselves would
/// make `exceeds_classic_current_dir_limit` lie about how long the resolved
/// short path "really" is once handed to `current_dir`. A value carrying
/// neither prefix is returned unchanged. The UNC form is checked FIRST and
/// case-insensitively (`starts_with_verbatim_unc_prefix_ci`, Auflage 11):
/// checking the plain `\\?\` form first would match a `\\?\UNC\...` input
/// too (it starts with the same four characters) and strip only that much.
#[cfg(any(windows, test))]
fn strip_verbatim_prefix(path: &[u16]) -> Vec<u16> {
    if starts_with_verbatim_unc_prefix_ci(path) {
        // "\\?\UNC\server\share" -> "\\server\share"
        let rest = &path[VERBATIM_UNC_PREFIX.len()..];
        let mut out = Vec::with_capacity(rest.len() + 2);
        out.push(BACKSLASH);
        out.push(BACKSLASH);
        out.extend_from_slice(rest);
        return out;
    }
    if let Some(rest) = path.strip_prefix(VERBATIM_PREFIX.as_slice()) {
        return rest.to_vec();
    }
    path.to_vec()
}

/// Windows-only: resolve `dir`'s 8.3 short name via `GetShortPathNameW`.
/// `None` if the lookup fails outright (8dot3 name creation disabled on the
/// volume, the path does not exist, or any other API failure): callers must
/// treat that exactly like "no shorter path available", not panic or retry.
#[cfg(windows)]
fn get_short_path_name(dir: &Path) -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;

    let raw: Vec<u16> = dir.as_os_str().encode_wide().collect();
    let mut wide = verbatim_prefixed(&raw);
    wide.push(0); // GetShortPathNameW needs a NUL-terminated wide string.

    // SAFETY: passing a null output buffer with cchBuffer 0 is the documented
    // way to ask GetShortPathNameW for the required buffer length (Microsoft,
    // GetShortPathNameW docs); it never writes through a null pointer for
    // that call shape. `wide` is NUL-terminated above, per the same docs'
    // requirement for lpszLongPath.
    let needed = unsafe { GetShortPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0) };
    if needed == 0 {
        // review-longpath.md Auflage 6 (nit): name the real error instead of
        // logging nothing. This is exactly the number that tells "8dot3 name
        // creation disabled on this volume" (ERROR_PATH_NOT_FOUND or
        // ERROR_FILENAME_EXCED_RANGE at an ENABLED volume would instead point
        // back at a missing verbatim prefix, i.e. a regression of Auflage 1)
        // apart from every other failure reason.
        // SAFETY: GetLastError only reads thread-local state kernel32 itself
        // set on the GetShortPathNameW call just above; no pointers involved.
        let code = unsafe { GetLastError() };
        tracing::warn!(target: "engine", dir = %dir.display(), error_code = code, "GetShortPathNameW could not size a short name for this directory");
        return None;
    }

    let mut buf: Vec<u16> = vec![0u16; needed as usize];
    // SAFETY: `buf` has exactly `needed` elements (the length the previous
    // call reported, including room for the terminating NUL per the docs'
    // "size of the buffer... required to hold the path and the terminating
    // null character"), and `buf.len()` is passed back as cchBuffer, so the
    // call can only ever write within `buf`.
    let written = unsafe { GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
    if written == 0 {
        // SAFETY: see the identical call above.
        let code = unsafe { GetLastError() };
        tracing::warn!(target: "engine", dir = %dir.display(), error_code = code, "GetShortPathNameW could not resolve a short name for this directory");
        return None;
    }
    // A value >= buf.len() means the buffer was too small after all (docs:
    // this happens when the path changes between the two calls). Treat it
    // like any other failure rather than trust a possibly-truncated buffer.
    if written as usize >= buf.len() {
        return None;
    }
    buf.truncate(written as usize); // return value excludes the terminator
    let unprefixed = strip_verbatim_prefix(&buf);
    Some(PathBuf::from(OsString::from_wide(&unprefixed)))
}

/// Windows-only glue: measure `dir` for real and, if needed, resolve a real
/// short name, then let the pure `decide_long_path_current_dir` make the
/// call.
#[cfg(windows)]
fn windows_current_dir_for_backend(dir: &Path) -> LongPathDecision {
    decide_long_path_current_dir(utf16_len(dir), || {
        get_short_path_name(dir).map(|short| {
            let len = utf16_len(&short);
            (short, len)
        })
    })
}

/// Windows-only real check: is `dir` itself over the classic
/// current-directory length limit? Split from `apply_engine_backend_dir`'s
/// own decision so `start_failure_message` (compiled on every platform, see
/// review-longpath.md Auflage 3) can ask the same question without needing
/// `encode_wide()` itself (a Windows-only `OsStrExt` method). Always `false`
/// off Windows: nothing there shares this ceiling.
#[cfg(windows)]
fn windows_backend_dir_too_long(dir: &Path) -> bool {
    exceeds_classic_current_dir_limit(utf16_len(dir))
}
#[cfg(not(windows))]
fn windows_backend_dir_too_long(_dir: &Path) -> bool {
    false
}

/// The one sentence both failure paths (the immediate `cmd.spawn()` error and
/// `start_failure_message`'s generic "the engine died" case) use once the
/// backend dir itself is over Windows' classic current-directory length
/// limit (review-longpath.md Runde 1, Auflage 3): names the real, fixable
/// cause instead of a bare OS error number, and instead of the generic
/// "Reinstall Locally Uncensored" sentence, which would send the user right
/// back into the same too-long path.
fn long_install_path_hint() -> &'static str {
    "This installation's own folder path is longer than Windows allows for \
     starting its bundled engine. Install Locally Uncensored to a shorter \
     path (for example directly under C:\\) and try again."
}

/// K1 (3.0.1): point a bundled llama-server child at its companion
/// ggml-cpu-*/ggml-vulkan libraries. No-op when `backend_dir` is `None`
/// (mac, or nothing built yet).
///
/// This IS our own bundled sidecar, not a foreign program: `Command::new` is
/// the right call here and `foreign_system_command`/`strip_appimage_env`
/// (process_util.rs) would be wrong. On an AppImage this process WANTS the
/// AppImage-mounted `LD_LIBRARY_PATH` it inherits (its own libvulkan.so.1
/// etc, see the comment at ILLEGAL_INSTRUCTION_EXIT_CODE below); stripping
/// it would undo the very thing K11 fixed for foreign programs one file
/// over. This function only ever ADDS our own resources directory in front
/// of whatever LD_LIBRARY_PATH the process already inherited.
///
/// Measured against the pinned llama.cpp source, not assumed:
/// `ggml_backend_load_best` (ggml/src/ggml-backend-reg.cpp:479-486) scans
/// only two places when no explicit path is given, the executable's OWN
/// directory and the process's CURRENT directory. There is no search-LIST
/// environment variable: `GGML_BACKEND_PATH` (same file, line 582) loads
/// exactly one named file, so it cannot stand in for a directory holding
/// nine-plus CPU variants. The current directory is the one lever that
/// works the same way on every platform, so this sets it instead of
/// reaching for an env var that does not do what the name suggests.
///
/// On Windows the companions are bundled flattened into the exe's own
/// directory (see `resolve_engine_backend_dir`), which Windows' own DLL
/// search order normally covers with no help from this function. But
/// `current_dir` here is NOT redundant (review-sidecar.md, Runde 2,
/// Abschnitt 4): `get_executable_path()` (ggml-backend-reg.cpp:438-455)
/// calls `GetModuleFileNameW` into a FIXED `MAX_PATH` (260 wchar_t) buffer
/// with no retry on `ERROR_INSUFFICIENT_BUFFER`, so an install path longer
/// than 259 characters comes back silently truncated and ggml's own
/// "executable directory" search root stops existing. `current_dir` is the
/// only search root `ggml_backend_load_best` falls back to
/// (ggml-backend-reg.cpp:479-486, "the process's CURRENT directory") in
/// that case, so this line is the recovery path for a long installation
/// path, not a belt-and-suspenders extra: do not remove it as
/// "unnecessary".
///
/// On Linux the companions sit in a separate resources directory (deb/
/// AppImage keep externalBin and `resources` apart). `current_dir` alone
/// gets ggml's own variant SCAN right (the pinned llama.cpp build now sets
/// an `$ORIGIN`-relative RPATH on every staged companion, K1 BLOCKER B3/B4,
/// scripts/build-llama.sh's `-DCMAKE_BUILD_RPATH_USE_ORIGIN=ON` plus a
/// `patchelf` second line of defense, so a found companion's OWN dependency
/// on libggml-base.so.N resolves via $ORIGIN without any help from this
/// function). What $ORIGIN does NOT cover is the EXE itself: it lives in a
/// different directory from its companions on deb/AppImage, and $ORIGIN is
/// relative to the file that carries it, not to some shared root. `LD_LIBRARY_PATH`
/// closes exactly that remaining gap, for the exe's own DT_NEEDED entries.
///
/// K1-14 (3.0.1, klaerung-63.md): on Windows, `dir` can itself be too long
/// for `Command::current_dir` to hand to `CreateProcessW`'s
/// `lpCurrentDirectory` parameter. No `SetCurrentDirectoryW` call happens
/// here (review-longpath.md Runde 1, Auflage 5 corrected an earlier, wrong
/// claim that it does); the classic ~258 character ceiling on
/// `lpCurrentDirectory` is documented directly against `CreateProcessW`
/// instead (see the `CLASSIC_MAX_PATH_CHARS` doc comment above for the exact
/// citations and the 258-not-259-not-248 arithmetic). Measured on the box
/// (BERICHT.md #63): a 295 character install path made `cmd.spawn()` itself
/// fail with os error 267 (`ERROR_DIRECTORY`) before the child process, and
/// thus ggml's own fallback search, ever ran. In that SAME measured run the
/// exe path and the model path argument were not the cause (a
/// `FileName`/argv problem surfaces as a different Windows error, not 267,
/// and `CreateProcessW`'s own MAX_PATH note for `lpCommandLine` only applies
/// when `lpApplicationName` is NULL, which Rust does not do): this is
/// disproved for the measured case, not proven safe in general, and does not
/// cover a model file the user themselves buried in an equally deep folder.
///
/// `windows_current_dir_for_backend` tries the 8.3 short name first
/// (`GetShortPathNameW`, through the verbatim-prefix dance
/// `get_short_path_name` does internally: required, or the lookup fails on
/// exactly the over-the-limit input this fallback exists for). If that is
/// unavailable (8dot3 name creation can be disabled per volume) or still too
/// long, `current_dir` is left unset instead of letting the whole spawn
/// fail. The app then starts, but ggml then has NEITHER of its two search
/// roots (its own truncated `GetModuleFileNameW` reading, or a usable
/// current directory) and the sidecar will not find its backend either way;
/// `start_failure_message` names the real cause for that case instead of the
/// generic "Reinstall..." sentence (review-longpath.md Auflage 3).
fn apply_engine_backend_dir(cmd: &mut Command, backend_dir: Option<&Path>) {
    let Some(dir) = backend_dir else { return };
    #[cfg(windows)]
    {
        match windows_current_dir_for_backend(dir) {
            LongPathDecision::UseAsIs => {
                cmd.current_dir(dir);
            }
            LongPathDecision::UseShortName(short) => {
                tracing::info!(
                    target: "engine",
                    backend_dir = %dir.display(),
                    "backend dir is over the classic Windows current-directory length limit, using its 8.3 short name for current_dir"
                );
                cmd.current_dir(short);
            }
            LongPathDecision::SkipCurrentDir => {
                tracing::warn!(
                    target: "engine",
                    backend_dir = %dir.display(),
                    "backend dir is over the classic Windows current-directory length limit and no usable 8.3 short name was found; starting the engine without current_dir set"
                );
            }
        }
    }
    #[cfg(not(windows))]
    {
        cmd.current_dir(dir);
    }
    #[cfg(target_os = "linux")]
    {
        let mut value = std::ffi::OsString::from(dir);
        if let Some(existing) = std::env::var_os("LD_LIBRARY_PATH") {
            if !existing.is_empty() {
                value.push(":");
                value.push(existing);
            }
        }
        cmd.env("LD_LIBRARY_PATH", value);
    }
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

/// Whether llama-server can save and restore a slot for an engine started with
/// these arguments. Not with an image part: in the pinned b9949 every slot
/// save, restore and erase first runs `check_no_mtmd`, which answers 501 "This
/// feature is not supported by multimodal" as soon as a projector is loaded
/// (tools/server/server-context.cpp). No flag of that build lifts the check
/// while the projector stays loaded. `--no-mmproj` turns the image part off
/// and counts as without one.
pub(crate) fn kv_handoff_possible(args: &[String]) -> bool {
    !args.iter().any(|a| {
        let flag = a.split('=').next().unwrap_or(a);
        matches!(flag, "--mmproj" | "-mm" | "--mmproj-url" | "-mmu")
    })
}

/// The model the "no KV hand-off with an image part" line was last written
/// for. One line per model and session, not one per render.
static KV_SKIP_NOTED_FOR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Whether the skip line is due for this model, and remember that it was.
fn kv_skip_note_due(model: &str) -> bool {
    let mut noted = KV_SKIP_NOTED_FOR.lock().unwrap_or_else(|e| e.into_inner());
    if noted.as_deref() == Some(model) {
        return false;
    }
    *noted = Some(model.to_string());
    true
}

fn note_kv_handoff_skipped(model: &str) {
    if kv_skip_note_due(model) {
        tracing::info!(
            target: "engine",
            model = %model,
            "KV hand-off skipped: llama-server cannot save a slot while the model runs with its image part; the next turn after a render re-reads the history"
        );
    }
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
pub async fn kv_slot_action(
    port: u16,
    action: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    if action != "save" && action != "restore" {
        return Err("action must be 'save' or 'restore'".to_string());
    }
    // An engine with an image part refuses both with 501 (box runs d307-b and
    // d307-c, H1), so neither is sent there. See `kv_handoff_possible`.
    let multimodal = {
        let guard = state.bundled_engine.lock().unwrap();
        guard
            .as_ref()
            .filter(|e| e.port == port && !kv_handoff_possible(&e.args))
            .map(|e| e.model_path.clone())
    };
    if let Some(model) = multimodal {
        note_kv_handoff_skipped(&model);
        return Ok(serde_json::json!({ "ok": false, "skipped": "multimodal", "body": {} }));
    }
    // The slots are the engine's memory of a conversation, so they sit behind
    // its key. The key goes only to a port an LU engine holds (engine_key.rs).
    let ports = super::engine_key::engine_ports(&state);
    let slot_id = if action == "save" {
        match reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
        {
            Ok(probe) => match super::engine_key::authorize(
                probe.get(format!("http://127.0.0.1:{port}/slots")),
                &format!("http://127.0.0.1:{port}/slots"),
                &ports,
            )
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
    let res = super::engine_key::authorize(client.post(&url), &url, &ports)
        .json(&serde_json::json!({ "filename": "lu-handoff.bin" }))
        .send()
        .await
        .map_err(|e| format!("slot {action} failed: {}", os_error::english(&e)))?;
    let ok = res.status().is_success();
    let body: serde_json::Value = res.json().await.unwrap_or_else(|_| serde_json::json!({}));
    Ok(serde_json::json!({ "ok": ok, "body": body }))
}

// ── Port selection ───────────────────────────────────────────────────────────
//
// GH #118 (2026-08-27): the engine had exactly one port and no way out
// of it. Whatever held 8127 held the whole chat lane, and the app answered a
// user with "quit that process or reboot", which is an instruction, not a
// repair. Windows makes this worse than it sounds: Hyper-V and WSL reserve
// whole port blocks with nothing listening in them
// (`netsh interface ipv4 show excludedportrange`), so a port can be refused to
// a child while looking free from the outside. House rule is self-healing
// before an error message, so a taken port is now a different port.

/// The ports the managed chat engine may use, in the order it tries them: the
/// preferred one first, then a bounded walk upwards. The embeddings port is
/// skipped, because it belongs to the other managed sidecar and taking it
/// would break Document-Chat instead of fixing chat.
pub(crate) fn engine_port_candidates(preferred: u16) -> Vec<u16> {
    let mut out = vec![preferred];
    let mut port = preferred;
    while out.len() < PORT_SEARCH_SPAN as usize + 1 {
        port = match port.checked_add(1) {
            Some(p) => p,
            None => break,
        };
        if port == DEFAULT_EMBED_PORT {
            continue;
        }
        out.push(port);
    }
    out
}

/// First candidate `usable` accepts. Pure, so the walk is testable without
/// opening a single socket.
pub(crate) fn first_usable_port(candidates: &[u16], usable: impl Fn(u16) -> bool) -> Option<u16> {
    candidates.iter().copied().find(|p| usable(*p))
}

/// May a healthy engine that already serves the wanted argv simply be kept.
///
/// A15, Windows Nachlauf 02.09.: the engine walked from 8127 to 8129 because a
/// leftover listener held 8127, and it stayed on 8129 for the life of the app.
/// Two "Apply & Restart Engine" on a long-free 8127 changed nothing, because
/// the reuse check only asked whether the engine was healthy on the port it
/// happened to hold, and `swap_bundled_model` handed its own current port back
/// in as the preferred one. So a user who ends the blocking process is left
/// staring at the fallback port until the next app start.
///
/// The rule: an engine on the preferred port is kept, and an engine that had to
/// move is kept only while the port that pushed it away is still taken. The
/// probe is a closure because it costs a bind, and the common case (the engine
/// is already where it wants to be) never needs to ask.
pub(crate) fn may_keep_engine_where_it_is(
    running_port: u16,
    preferred_port: u16,
    preferred_is_free: impl FnOnce() -> bool,
) -> bool {
    running_port == preferred_port || !preferred_is_free()
}

/// Can this process open the loopback port right now. Exactly the question
/// llama-server is about to ask, asked one step earlier so a taken port turns
/// into another port instead of into a dead engine.
fn port_is_bindable(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Said when the whole bounded walk came back empty.
pub(crate) fn no_free_port_message(first: u16, last: u16) -> String {
    format!(
        "The LU Engine could not open a local port. Every port it may use between {first} and {last} is taken or blocked on this machine. Close whatever is holding them (a llama-server left over from an earlier session is the usual cause), or check whether a firewall or a reserved Windows port range covers that block, then try again."
    )
}

fn engine_healthy(port: u16) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(400))
        .build()
        .ok()
        .and_then(|c| super::engine_key::authorize_blocking(c.get(format!("http://127.0.0.1:{port}/health"))).send().ok())
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
        "LU Engine did not become healthy on port {port} within {}s (the budget scales with model size, huge GGUFs can take minutes on a cold first load)",
        timeout.as_secs()
    ))
}

/// How a health wait ended.
#[derive(Debug, PartialEq)]
enum HealthWait {
    Ready,
    /// The child we spawned is gone. Nothing more will happen on that port.
    /// Carries the process exit code, the single most useful number in a
    /// support log for this failure, plus the POSIX signal that killed it
    /// when there was one (K1 Runde 2, Punkt D: on Linux/macOS a SIGILL has
    /// no exit code at all, `code()` reads `None` either way, and the two
    /// causes ["the process asked to exit with no code" vs "a signal killed
    /// it"] used to be indistinguishable from here on).
    ChildExited { code: Option<i32>, signal: Option<i32> },
    /// The child was taken out of the slot and killed because somebody asked
    /// for the engine to be stopped. Not a death, and nothing to try again.
    Stopped,
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
                Some(e) => e.child.try_wait().ok().flatten().map(|s| (s.code(), unix_exit_signal(&s))),
                // The slot was cleared under us. Two things do that: a stop
                // somebody asked for, which takes the child out and kills it,
                // and the sidecar watch or a status read, which reap a child
                // that died by itself. Only the second one is a death. Reading
                // the first as one started the model the user had just
                // unloaded a second time, on the processor.
                None if stop_was_requested(state) => return HealthWait::Stopped,
                // Reaped by the watch, so there is no child left to wait on
                // and no exit code or signal to report.
                None => Some((None, None)),
            }
        };
        if let Some((code, signal)) = gone {
            // One last look: a server can bind, answer, and the process can
            // still be reaped between the two checks on a fast load.
            return if engine_healthy(port) {
                HealthWait::Ready
            } else {
                HealthWait::ChildExited { code, signal }
            };
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    HealthWait::TimedOut
}

/// Windows raises `STATUS_ILLEGAL_INSTRUCTION` (`0xC000001D`) when a process
/// executes an opcode the CPU does not support. `ExitStatus::code()` hands
/// that NTSTATUS back reinterpreted as a signed 32-bit number, which is this
/// constant (K1, GH thread "LU Engine not running?", 2026-09-15: Win10, RTX
/// 3050, exit -1073741795 on both the GPU and the CPU-only retry).
///
/// `scripts/build-llama.sh` pins `-DGGML_NATIVE=OFF`, but ggml's own
/// CMakeLists still turns AVX/AVX2/FMA/F16C ON by default whenever
/// `GGML_NATIVE` is off and the build is not cross-compiling (measured
/// against the pinned llama.cpp checkout, `ggml/CMakeLists.txt` around
/// `INS_ENB`). So every bundled Windows/Linux sidecar today requires AVX2 at
/// the first opcode it runs, GPU or CPU path alike, and a CPU without it
/// cannot even reach `main()` to print a reason. Retrying with the identical
/// binary cannot change that outcome, which is why this exit code short-
/// circuits the second attempt instead of spending it on a repeat crash.
pub(crate) const ILLEGAL_INSTRUCTION_EXIT_CODE: i32 = -1073741795;

/// True when a child's exit code is the Windows illegal-instruction fault.
/// Unix has no exit-code equivalent (the same fault there is the `SIGILL`
/// signal, which `ExitStatus::code()` cannot see at all, only `.signal()`),
/// so this only ever matches on Windows, which matches every report K1 has.
pub(crate) fn is_illegal_instruction_exit(code: Option<i32>) -> bool {
    code == Some(ILLEGAL_INSTRUCTION_EXIT_CODE)
}

/// `SIGILL`, the POSIX number every Unix (Linux, macOS, BSD) agrees on.
/// `libc::SIGILL` would pull in a whole crate for one constant this codebase
/// otherwise avoids (see `process_util.rs`'s own minimal `libc` binding).
pub(crate) const SIGILL: i32 = 4;

/// True when a child was killed by `SIGILL` on Unix. K1 Runde 2, Punkt D: the
/// Windows crash (`is_illegal_instruction_exit`) was the only side of this
/// bug LU could see; on Linux the identical AVX2-on-a-CPU-without-it fault
/// raises `SIGILL` instead, which has NO exit code at all
/// (`ExitStatus::code()` reads `None` for a signal death same as it would
/// for "no code", so the Linux case was silently indistinguishable from
/// "died with an empty exit code and no stderr" before this).
pub(crate) fn is_sigill(signal: Option<i32>) -> bool {
    signal == Some(SIGILL)
}

/// [`std::os::unix::process::ExitStatusExt::signal`], cross-platform: `None`
/// on Windows, where a `Command`'s `ExitStatus` has no such notion (a
/// process there either exits with a code or does not exit).
#[cfg(unix)]
fn unix_exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn unix_exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

/// Logs the x86 instruction sets this machine's CPU offers, once per process.
/// K1: without this line, a crash on the very first opcode left nothing in
/// the log that named the cause, so a support conversation had to ask the
/// user to run `wmic cpu get Name` by hand before anyone could even guess.
/// AVX/AVX2/FMA/F16C are exactly the four flags `scripts/build-llama.sh`
/// bakes into every bundled sidecar (see `ILLEGAL_INSTRUCTION_EXIT_CODE`
/// above), so this line is what turns that crash into a diagnosis: whichever
/// of the four reads `false` here is the one the CPU cannot run.
fn log_cpu_features_once() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        #[cfg(target_arch = "x86_64")]
        tracing::info!(
            target: "engine",
            avx = is_x86_feature_detected!("avx"),
            avx2 = is_x86_feature_detected!("avx2"),
            fma = is_x86_feature_detected!("fma"),
            f16c = is_x86_feature_detected!("f16c"),
            "CPU instruction sets the LU Engine sidecar was built to require"
        );
        #[cfg(not(target_arch = "x86_64"))]
        tracing::info!(
            target: "engine",
            arch = std::env::consts::ARCH,
            "CPU instruction-set log skipped: not x86_64, AVX/AVX2/FMA/F16C do not apply"
        );
    });
}

/// Counts the CPU-variant modules actually sitting in the sidecar's backend
/// folder (the same folder `resolve_engine_backend_dir` points at and
/// `ggml_backend_load_all()` dlopens from at runtime), by the same
/// loader-exact naming `backend_marker_filename` and `verify-sidecar-isa.sh`
/// use ("[lib]ggml-cpu-<variant>.[dll|so]").
///
/// K1 (3.0.1, BLOCKER C1): after the sidecar rebuild the bundled build ships
/// one variant per instruction-set floor instead of one AVX2-only binary, so
/// a CPU that still faults on its first opcode is no longer explained by "the
/// build requires AVX2" (Runde 3 disproved that: `verify-sidecar-isa.sh`
/// disassembles the baseline variant and the exe itself and fails the build
/// if either contains an AVX-or-above instruction). The far more likely cause
/// is that this installation's copy of the folder counted here is short one
/// or more files: a partial install, or an antivirus scanner that quarantined
/// an unsigned `ggml-cpu-*` module (the exact pattern generic packer
/// heuristics flag, review-integ.md Teil (a), Punkt 6). Counting the folder
/// is what tells those two cases apart in the message instead of guessing.
fn count_cpu_backend_modules(dir: &Path) -> usize {
    let prefix = if cfg!(target_os = "windows") { "ggml-cpu-" } else { "libggml-cpu-" };
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(prefix))
        .count()
}

/// The MEASURED names of the instruction sets this CPU is missing, out of
/// the six the bundled sidecar's build actually requires (AVX, AVX2, BMI2,
/// FMA, F16C, SSE4.2): pure, so `start_failure_message` can name exactly
/// what was found lacking instead of a generic "for example AVX2" that may
/// not even be the one this machine is missing. Runde 2 review, Punkt D:
/// the review specifically rejected the old wording for guessing rather
/// than reading the same data `log_cpu_features_once` already gathers.
///
/// Runde 3, Nachbesserung 4: the review measured the build's OWN
/// requirement directly (`scripts/build-llama.sh` passes `-DGGML_NATIVE=OFF`
/// and nothing else CPU-specific, and ggml's own CMakeLists.txt turns
/// `GGML_SSE42`, `GGML_AVX`, `GGML_AVX2`, `GGML_BMI2`, `GGML_FMA` and
/// `GGML_F16C` all ON by default whenever `GGML_NATIVE` is OFF) and found
/// BMI2 and SSE4.2 missing from the four this used to probe: a CPU missing
/// only one of those two got the generic sentence instead of the measured
/// one, exactly the imprecision Punkt 3 of the review existed to remove.
///
/// Empty on a non-x86_64 build (nothing here applies) or when every flag the
/// probe can see is present; the caller falls back to a plainer sentence in
/// that case rather than naming zero features as the reason.
pub(crate) fn missing_cpu_features() -> Vec<&'static str> {
    #[cfg(target_arch = "x86_64")]
    {
        missing_cpu_features_from(
            is_x86_feature_detected!("avx"),
            is_x86_feature_detected!("avx2"),
            is_x86_feature_detected!("bmi2"),
            is_x86_feature_detected!("fma"),
            is_x86_feature_detected!("f16c"),
            is_x86_feature_detected!("sse4.2"),
        )
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        Vec::new()
    }
}

/// Pure half of [`missing_cpu_features`], split out so the "which flags
/// are missing" computation is unit-testable against synthetic readings
/// instead of whatever the test machine's own CPU happens to have (a CI
/// runner has AVX2, so a test asserting on the real probe could never
/// exercise the branch that names it missing).
#[cfg_attr(not(target_arch = "x86_64"), allow(dead_code))]
#[allow(clippy::too_many_arguments)]
fn missing_cpu_features_from(avx: bool, avx2: bool, bmi2: bool, fma: bool, f16c: bool, sse42: bool) -> Vec<&'static str> {
    let mut missing = Vec::new();
    if !avx {
        missing.push("AVX");
    }
    if !avx2 {
        missing.push("AVX2");
    }
    if !bmi2 {
        missing.push("BMI2");
    }
    if !fma {
        missing.push("FMA");
    }
    if !f16c {
        missing.push("F16C");
    }
    if !sse42 {
        missing.push("SSE4.2");
    }
    missing
}

/// The shared object the dynamic loader could not find, if that is why the
/// sidecar never got as far as its own logging.
///
/// The Linux sidecar is not static: the ELF in the shipped deb carries
/// `DT_NEEDED libvulkan.so.1` and `DT_NEEDED libgomp.so.1`. On a machine
/// without them the process is spawned, ld.so refuses it, and the only thing
/// on stderr is one line of the form
///
///   lu-llama-server: error while loading shared libraries: libvulkan.so.1:
///   cannot open shared object file: No such file or directory
///
/// That line has to be read BEFORE `stderr_blames_the_gpu`, which matches on
/// the substring "vulkan" and would otherwise send a user whose loader is
/// short one package off to set GPU Layers to 0, a setting that cannot help
/// a binary that never started.
fn stderr_names_a_missing_system_library(stderr: &str) -> Option<String> {
    const MARKER: &str = "error while loading shared libraries:";
    for line in stderr.lines() {
        // to_ascii_lowercase keeps byte lengths, so the index maps back.
        let lower = line.to_ascii_lowercase();
        let Some(at) = lower.find(MARKER) else { continue };
        let lib = line[at + MARKER.len()..].split(':').next().unwrap_or("").trim();
        if !lib.is_empty() {
            return Some(lib.to_string());
        }
    }
    None
}

/// The command that installs a soname, for the two libraries the sidecar
/// actually links against. Anything else returns `None` on purpose: a guessed
/// package name sends the user to a package that may not exist.
fn install_commands_for(lib: &str) -> Option<(&'static str, &'static str)> {
    // (Debian and Ubuntu package, Fedora package). Other RPM distributions
    // name these differently, which is why the sentence below points them at
    // the library instead of at a name.
    match lib {
        "libvulkan.so.1" => Some(("libvulkan1", "vulkan-loader")),
        "libgomp.so.1" => Some(("libgomp1", "libgomp")),
        _ => None,
    }
}

/// What to tell a user whose loader is short one library.
///
/// `on_linux` is passed in rather than read from `cfg!` inside so both
/// branches are testable on every platform. On anything but Linux the apt and
/// dnf lines would be noise: the wording this is triggered by is ld.so's, and
/// macOS dyld and the Windows loader say something else entirely.
///
/// The last sentence only promises the deb and the rpm. The AppImage carries
/// no dependencies at all, and libvulkan.so.1 is on the AppImage exclude list
/// by design (the loader has to come from the host so it can see the host's
/// ICDs), so "reinstall and it comes along" would be a lie there.
pub(crate) fn missing_library_hint(lib: &str, on_linux: bool) -> String {
    let head = format!(
        " A system library the LU Engine needs is missing on this machine: {lib}."
    );
    if !on_linux {
        return format!("{head} Install the package that provides it, then try again.");
    }
    match install_commands_for(lib) {
        Some((deb, rpm)) => format!(
            "{head} Debian and Ubuntu: sudo apt install {deb}. Fedora: sudo dnf install {rpm}. On other distributions, install the package that provides {lib}. If you installed LU from the .deb or the .rpm, reinstalling also pulls it in."
        ),
        None => format!(
            "{head} Install the package that provides {lib} with your package manager, then try again."
        ),
    }
}

/// Words that only NAME a graphics backend. On their own they are worthless as
/// evidence: every start on an NVIDIA box prints `ggml_cuda_init: found 1 CUDA
/// devices` before it does anything at all, so on such a box a list like this
/// matches every log there is, healthy or not.
const GPU_BACKENDS: &[&str] = &["cuda", "hip", "rocm", "vulkan", "cublas"];

/// Words that name a graphics FAULT. One of these has to be in the log before
/// the app may send anyone to the GPU Layers slider.
///
/// `device memory` used to stand in the list above and is deliberately NOT
/// here: llama.cpp answers EVERY load error through its auto-fit path, and
/// that path prints `common_fit_params: encountered an error while trying to
/// fit params to free device memory`. A phrase that appears on every failure
/// cannot tell one failure from another. It is what made the app blame the
/// graphics card for two different broken files on 03.09.2026.
const GPU_FAULTS: &[&str] = &[
    "out of memory",
    "failed to allocate",
    "no kernel image",
    "compute capability",
    "no devices found",
    "cuda error",
    "hip error",
    "cudamalloc",
    "ggml_backend_alloc",
    "device-side assert",
];

/// Did the child die of the graphics card. Lower-cased internally.
///
/// A backend name AND a fault, never one alone. The name without a fault is
/// the routine banner of a working card. The fault without a name can be the
/// system's own memory, where sending the weights from the card into RAM makes
/// things worse, not better.
///
/// Read only after `stderr_names_a_missing_system_library`: "libvulkan.so.1"
/// carries "vulkan" and is a packaging problem, not a graphics-card problem.
fn stderr_blames_the_gpu(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    GPU_BACKENDS.iter().any(|m| lower.contains(m))
        && GPU_FAULTS.iter().any(|m| lower.contains(m))
}

/// Markers that say the child never got the socket, whatever else is in the
/// log. Whole sentences, so they cannot collide with anything.
///
/// The bundled binary's own wording is `couldn't bind HTTP server socket,
/// hostname: 127.0.0.1, port: 8127`, measured on the Mac sidecar 2026-09-02.
const PORT_SENTENCES: &[&str] = &[
    "address already in use",
    "address in use",
    "failed to bind",
    "error while binding",
    "couldn't bind",
    "could not bind",
    "bind: permission denied",
    "eaddrinuse",
];

/// Tokens that mean a port ONLY on a line that is about a socket. `10048` is
/// WSAEADDRINUSE and `10013` is WSAEACCES, which is what a port inside a
/// reserved Windows range answers while nothing is listening on it. As bare
/// substrings they are a trap: llama.cpp prints `10048.00 MiB` for a 10 GB
/// allocation, so a CUDA out-of-memory death used to be read as a busy port,
/// the user lost the GPU-Layers way out, and the retry hopped to another port
/// for nothing.
const PORT_TOKENS: &[&str] = &["10048", "10013", "eacces"];

/// Words that make a line a line about a socket.
const SOCKET_CONTEXT: &[&str] = &["wsa", "bind", "socket", "listen"];

/// Did the child fail because it never got the socket. Lower-cased internally.
pub(crate) fn stderr_blames_the_port(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    if PORT_SENTENCES.iter().any(|m| lower.contains(m)) {
        return true;
    }
    // Per LINE, not per log: a socket word somewhere in a 12 line tail says
    // nothing about the line that carries the number.
    lower.lines().any(|line| {
        PORT_TOKENS.iter().any(|t| line.contains(t))
            && SOCKET_CONTEXT.iter().any(|c| line.contains(c))
    })
}

/// Markers that point at the model file itself.
///
/// `gguf_init_from_` and not `gguf_init_from_file`: llama.cpp parses a GGUF in
/// `gguf_init_from_reader`, and the file entry point only wraps it. Every error
/// line of a header it cannot read carries the READER name, so the longer
/// marker matched nothing that a broken file actually prints.
///
/// `tensor .* not found` stood here until 03.09.2026 and could never match:
/// this is a substring test on a log, not a regular expression, and no line
/// ever carries the two characters `.*`. That case arrives through
/// `failed to load model` like every other load error.
///
/// `failed to load model` IS included here, unlike in the stricter
/// `stderr_blames_the_model_file` right below: llama.cpp also prints that
/// line on load failures that have nothing to do with the file (a CUDA
/// out-of-memory, no backend loaded at all), so `died_failure_hint` only
/// reaches this looser check once it has already ruled out a too-long
/// install path as the cause (review-longpath.md Runde 2, Blocker 9): this
/// function stays the right answer for every OTHER "the child died and said
/// something model-shaped" case, short-path included.
fn stderr_blames_the_model(stderr: &str) -> bool {
    const MARKERS: &[&str] = &[
        "unknown model architecture",
        "failed to load model",
        "invalid magic",
        "unsupported model",
        "wrong number of tensors",
        "gguf_init_from_",
    ];
    let lower = stderr.to_ascii_lowercase();
    MARKERS.iter().any(|m| lower.contains(m))
}

/// The subset of those markers that can ONLY come from the bytes in the file:
/// a header llama.cpp cannot parse, an architecture it does not know, a tensor
/// count that does not match the metadata.
///
/// Measured 2026-09-03 on the Windows release build with a deliberately
/// truncated GGUF (valid magic, 2 MB of zeroes). llama-server said
/// `error loading model: unknown model architecture: ''` and exited, and the
/// app answered "This looks like a graphics-card problem. Set GPU Layers to 0",
/// which cannot repair a file. It answered that because the routine
/// backend-init lines of every start on an NVIDIA box carry the word `cuda`,
/// `stderr_blames_the_gpu` matches on that bare word, and the graphics-card
/// branch is asked first.
///
/// So this question is asked BEFORE the card. `failed to load model` is
/// deliberately NOT in here: a CUDA out-of-memory prints that line too, and on
/// that failure GPU Layers 0 is exactly the right advice. Only markers that a
/// working card can never produce belong here.
///
/// Measured again 03.09.2026, same build, a DIFFERENT broken file: a GGUF
/// whose version field reads 684680038. llama.cpp answers that one through
/// `gguf_init_from_reader`, not `gguf_init_from_file`, so the marker list
/// missed it and the app blamed the graphics card a second time. The markers
/// name the reading routine now, not the wrapper around it.
fn stderr_blames_the_model_file(stderr: &str) -> bool {
    const MARKERS: &[&str] = &[
        "unknown model architecture",
        "invalid magic",
        "unsupported model",
        "wrong number of tensors",
        "gguf_init_from_",
        "failed to open gguf",
    ];
    let lower = stderr.to_ascii_lowercase();
    MARKERS.iter().any(|m| lower.contains(m))
}

/// Der Anfang einer GGUF: die Marke und die Formatversion.
const GGUF_MAGIC: &[u8; 4] = b"GGUF";

/// Ab hier sind die Bytes kein Kopf mehr, sondern Muell.
///
/// Das ist ausdruecklich KEINE Prüfung auf "die Version, die ich kenne". Die
/// steht heute bei 3, und eine llama.cpp, die morgen 4 liest, soll das auch
/// duerfen: eine feste Obergrenze auf dem heutigen Stand wuerde einer
/// neueren Engine ihre eigenen Dateien verbieten. Gesucht wird nur der Fall,
/// in dem an dieser Stelle offensichtlich gar keine Versionsnummer steht.
/// Die kaputte Datei aus der Messung vom 03.09.2026 meldete 684 680 038.
const GGUF_VERSION_UNSINN: u32 = 16;

/// Warum diese Datei keine brauchbare GGUF ist, oder None, wenn ihr Kopf in
/// Ordnung ist.
///
/// `role` benennt die Datei am Satzanfang, weil der Start ZWEI GGUFs braucht:
/// das Modell und die Sichtdatei daneben. "Download it again" hilft nur, wenn
/// dabei steht, welche der beiden gemeint ist.
///
/// Liest acht Bytes. Ein Lesefehler ist KEIN Grund: die Datei kann auf einem
/// langsamen Netzlaufwerk liegen oder gerade geschrieben werden, und dann
/// soll die Engine es versuchen und ihre eigene Antwort geben, statt dass
/// diese Vorpruefung sie ersetzt.
fn gguf_header_reason(path: &Path, role: &str) -> Option<String> {
    use std::io::Read;
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("this file")
        .to_string();
    let mut kopf = [0u8; 8];
    let mut datei = std::fs::File::open(path).ok()?;
    datei.read_exact(&mut kopf).ok()?;
    if &kopf[..4] != GGUF_MAGIC {
        return Some(format!(
            "{role} \"{name}\" does not start with the GGUF marker, so it is not a GGUF at all. Open Models, Get new and download it again."
        ));
    }
    let version = u32::from_le_bytes([kopf[4], kopf[5], kopf[6], kopf[7]]);
    if version == 0 || version > GGUF_VERSION_UNSINN {
        return Some(format!(
            "{role} \"{name}\" carries a GGUF version of {version}, which is not a version at all. The file is damaged, most likely a download that did not finish. Open Models, Get new and download it again."
        ));
    }
    None
}

/// Wie das Modell in einer Meldung der Vorpruefung heisst.
const GGUF_ROLE_MODEL: &str = "The model file";

/// Wie die Sichtdatei in einer Meldung der Vorpruefung heisst. Sie wird nie
/// ausgewaehlt, sondern still neben das Modell gelegt, also muss die Meldung
/// sagen, dass es sie ueberhaupt gibt.
const GGUF_ROLE_VISION: &str = "The vision file next to this model";

/// Beide GGUFs pruefen, die ein Start braucht, und den Pfad der Sichtdatei
/// zurueckgeben (None = reines Textmodell).
///
/// Das Modell allein reicht nicht. `existing_mmproj` fragt nur `is_file()`,
/// also Existenz, und ein abgebrochener Download ist eine Datei. Der Pfad
/// haengt danach als `--mmproj` am llama-server, also stirbt der Start an
/// einer halben Sichtdatei genauso wie an einem halben Modell, nur eben erst
/// im Prozess und damit hinter `stop_engine_locked`: die gesunde Engine ist
/// dann schon abgeraeumt. Beide Koepfe werden deshalb hier gelesen, bevor
/// irgendetwas angehalten wird.
fn precheck_model_files(model_path: &str) -> Result<Option<String>, String> {
    if let Some(grund) = gguf_header_reason(Path::new(model_path), GGUF_ROLE_MODEL) {
        return Err(grund);
    }
    let sicht = existing_mmproj(model_path);
    if let Some(pfad) = sicht.as_deref() {
        if let Some(grund) = gguf_header_reason(Path::new(pfad), GGUF_ROLE_VISION) {
            return Err(grund);
        }
    }
    Ok(sicht)
}

/// Put `note` directly under the first paragraph, ABOVE the engine's own log.
///
/// The order matters more than it looks. Persona P5 measured the message on
/// the real build on 03.09.2026: the good news, "The model that was serving
/// before is running again", sat at the very bottom, behind twelve lines of
/// llama-server output with full Windows paths. It is the only sentence in
/// that message a user can do anything with, and it was the last thing anyone
/// would ever read. A message is read from the top, so the sentences a person
/// needs belong at the top and the machine's own words at the end.
pub(crate) fn with_note_on_top(message: &str, note: &str) -> String {
    match message.split_once("\n\n") {
        Some((head, log)) => format!("{head}\n\n{note}\n\n{log}"),
        None => format!("{message}\n\n{note}"),
    }
}

/// What the second start attempt did differently, for the sentence the user
/// reads. "It was tried twice" is a true but empty promise when both tries
/// were the same experiment; naming the difference is what lets a reader tell
/// a card that cannot hold the model from one that is broken.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum SecondAttempt {
    /// One attempt only, or a retry that ran the same arguments (possibly on
    /// another port).
    SameOffload,
    /// The retry dropped GPU offload and ran on the processor.
    CpuOnly,
}

/// The sentence that points at the file the whole of bug o was about. Only
/// hung on the message that has two different attempts behind it, because that
/// is the one where the log holds something the message cannot.
const LOG_FILE_NOTE: &str =
    " The log file under Settings, Troubleshoot carries the full command line of both attempts and the engine's own output.";

/// The second sentence of the SIGILL/0xC000001D message: what to actually do
/// about it. Pure and takes the platform as a plain flag instead of reading
/// `cfg!()` inline, so both branches are testable on any host OS
/// (BLOCKER C2, review-integ.md Nachpruefung).
///
/// `resolve_engine_backend_dir` returns `None` UNCONDITIONALLY on macOS (its
/// very first line), because the Mac sidecar is a single static build with
/// Metal embedded and no dynamic ISA variants at all (`is_dynamic_isa_triple`
/// is false for both Darwin triples, `stage_dynamic_isa_companions` is a
/// documented no-op there with its own test) and never will be. Before this
/// split, that `None` fell into the exact same arm as a genuinely broken
/// Windows/Linux install (`module_count` also `None` there when
/// `resolve_engine_backend_dir` cannot find ANY candidate with the marker
/// file), so a Mac customer whose CPU is simply too old for the one Metal
/// build LU ships was told to reinstall or check antivirus quarantine for
/// files that this platform never has and never will. This path is real on
/// Mac: `is_sigill` is not Linux-only, it is every Unix, and
/// `cmake_flags_for`'s `x86_64-apple-darwin` branch carries no CPU-specific
/// flag either, so ggml's own `GGML_NATIVE=OFF` default turns on SSE4.2,
/// AVX, AVX2, BMI2, FMA and F16C there exactly like it used to on Windows.
///
/// `module_count` still distinguishes an empty Windows/Linux backend folder
/// from a partially populated one; the mac branch ignores it on purpose,
/// since the concept does not apply there regardless of what it reads.
fn illegal_instruction_repair_sentence(module_count: Option<usize>, is_macos: bool) -> String {
    if is_macos {
        return " The LU Engine on Mac is one single build for every Mac, and this processor does \
                 not have the instruction sets that build needs. Reinstalling would not change \
                 that."
            .to_string();
    }
    match module_count {
        // No backend folder at all, or the folder is empty of CPU
        // modules: the installation is missing files outright.
        Some(0) | None => " The engine's own folder has none of the separate CPU builds it ships for older \
             processors, which usually means an incomplete install or a security scanner \
             quarantining an unsigned file it does not recognise. Reinstall Locally \
             Uncensored, or check your antivirus software's quarantine for a file named \
             ggml-cpu, then try again."
            .to_string(),
        // Some modules are present, so the install is not simply empty:
        // the one this CPU needs is missing or was skipped, which points
        // more at antivirus removal of a single file than a wholesale
        // failed install.
        Some(n) => format!(
            " The engine's own folder holds {n} of the separate CPU builds it ships for older \
             processors, but not the one this CPU can run, which points at a security scanner \
             having quarantined that one file rather than a failed install. Reinstall Locally \
             Uncensored, or check your antivirus software's quarantine for a file named \
             ggml-cpu, then try again."
        ),
    }
}

/// The priority logic behind `start_failure_message`'s generic "the engine
/// died" sentence (review-longpath.md Runde 2, Blocker 9 and 10). Pulled out
/// as a pure function of `stderr` and a plain `backend_dir_too_long: bool`
/// (rather than a `Path` and a real Windows API call) specifically so it is
/// directly unit-testable on every host OS: `windows_backend_dir_too_long`
/// stays the one place that turns a real `backend_dir` into that bool.
///
/// Order, most specific (something the CHILD process itself proved) first:
/// 1. A named missing system library (`stderr_names_a_missing_system_library`),
///    read straight off the loader's own error line.
/// 2. `backend_dir_too_long`: a too-long install path is checked BEFORE the
///    general model-blame step, not after. Blocker 9: `stderr_blames_the_model`
///    (step 3) matches `failed to load model`, which llama.cpp prints on load
///    failures that have NOTHING to do with the file (its own doc comment
///    names a CUDA out-of-memory as one such case). With no backend loaded at
///    all (a too-long install path with no usable short name), the model load
///    aborts and prints exactly that line, and reading it in step 3 first
///    would have told a user with a perfectly good model file to download it
///    again while never mentioning the real, fixable cause. Checking the path
///    first REPLACES (not appends to) the generic "Reinstall..." catch-all,
///    which would send the user right back into the same too-long path
///    (review-longpath.md Runde 1, Auflage 3).
/// 3. The general model-blame markers (`stderr_blames_the_model`, which does
///    include `failed to load model`): once a too-long path is ruled out,
///    this is exactly right for a short-path model failure, CUDA
///    out-of-memory included as a case GPU Layers 0 already handles above
///    this function.
/// 4. The generic catch-all.
fn died_failure_hint(stderr: &str, backend_dir_too_long: bool, on_linux: bool) -> String {
    if let Some(lib) = stderr_names_a_missing_system_library(stderr) {
        missing_library_hint(&lib, on_linux)
    } else if backend_dir_too_long {
        format!(" {}", long_install_path_hint())
    } else if stderr_blames_the_model(stderr) {
        " The engine could not read the model file. It may be damaged, cut short, or of a type this engine cannot run. Open Models, Get new and download it again, or pick another model.".to_string()
    } else {
        " Reinstall Locally Uncensored if this keeps happening, or pick a different backend in Settings, AI Backends.".to_string()
    }
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
pub(crate) fn start_failure_message(
    failure: &StartFailure,
    port: u16,
    budget: Duration,
    second: SecondAttempt,
    backend_dir: Option<&Path>,
) -> String {
    let head = if is_illegal_instruction_exit(failure.exit_code) || is_sigill(failure.signal) {
        // K1 Runde 2, Punkt D: both the GPU and the CPU-only path run the
        // SAME binary, so a retry cannot change the outcome and is not
        // attempted (see start_after_stop). The cause and the next step both
        // go in this one sentence, since the log line stderr would otherwise
        // add is empty: the child never gets far enough to print anything.
        //
        // BLOCKER C1 (review-integ.md, Teil (c)): this used to say "the
        // bundled engine's build requires" the named instruction set and told
        // the user to wait for "a build with broader CPU support". Both
        // sentences were true against the pre-sidecar-rebuild engine and are
        // false against this one: K1 ships one CPU-code-path variant per
        // instruction-set floor, chosen at startup, and
        // `verify-sidecar-isa.sh` disassembles the baseline variant on every
        // build to prove it contains no AVX-or-above opcode. A crash here
        // therefore does not mean no build exists for this CPU; it means
        // something about THIS installation is broken. Counting the backend
        // folder (`count_cpu_backend_modules`) tells the two likely breakages
        // apart instead of guessing between them.
        let missing = missing_cpu_features();
        let missing_sentence = if missing.is_empty() {
            // The probe itself found nothing missing (or is not applicable,
            // non-x86_64): still true that the binary faulted on its first
            // opcode, just without a named cause to add.
            "This CPU is missing an instruction set the loaded CPU module needs.".to_string()
        } else {
            format!(
                "This CPU is missing {} the loaded CPU module needs.",
                if missing.len() == 1 {
                    format!("the {} instruction set", missing[0])
                } else {
                    format!("these instruction sets: {}", missing.join(", "))
                }
            )
        };
        let module_count = backend_dir.map(count_cpu_backend_modules);
        let repair_sentence =
            illegal_instruction_repair_sentence(module_count, cfg!(target_os = "macos"));
        format!(
            "The LU Engine exited immediately with an illegal-instruction fault. {missing_sentence} \
             The app did not retry, since the same binary would fail the same way again.{repair_sentence} \
             LU Cloud or a custom endpoint (Settings, AI Backends) stay available in the meantime. \
             Check Settings, Troubleshoot for the CPU features line in the log."
        )
    } else if failure.port_taken {
        format!(
            "Port {port} answers health checks, but the engine this app just started exited immediately. Another llama-server (likely left over from a previous session or crash) is occupying the port. Quit that process or reboot, then try again."
        )
    } else if failure.died
        && second == SecondAttempt::SameOffload
        && stderr_names_a_missing_system_library(&failure.stderr).is_none()
        && stderr_blames_the_gpu(&failure.stderr)
        && !stderr_blames_the_port(&failure.stderr)
        && !stderr_blames_the_model_file(&failure.stderr)
        && !backend_dir.is_some_and(windows_backend_dir_too_long)
    {
        // A missing system library is asked before the card: the loader line
        // "error while loading shared libraries: libvulkan.so.1" carries the
        // word vulkan, and GPU Layers 0 does not install a library.
        // The graphics card is asked BEFORE the port, because the port branch
        // used to swallow a CUDA out-of-memory whose allocation happened to
        // contain 10048, and the GPU-Layers way out is the one setting in this
        // app that gets such a user chatting at all. The port keeps the case
        // where the log carries a real bind sentence, because "cuda" appears in
        // the routine backend-init lines of every start on an NVIDIA box and
        // "set GPU Layers to 0" does not free a busy port.
        // And the FILE is asked before the card, for the same kind of reason
        // one step further: llama.cpp answers any load error through its
        // auto-fit path, whose line carries the words "device memory", so a
        // GGUF with a header it cannot parse used to arrive here and be sent
        // away as a graphics-card problem. No setting repairs a broken file.
        //
        // review-longpath.md Runde 2, Blocker 9 named this branch as one that
        // could ALSO swallow the honest long-install-path message (it is not
        // decidable at a desk whether `stderr_blames_the_gpu`'s loose word
        // match ever fires in that scenario, since the sidecar most likely
        // dies before reaching any GPU-init logging with no backend loaded at
        // all; box measurement, Runde 2 Messvorschrift Punkt 3, settles that
        // empirically). Guarded here regardless, the same way the model-file
        // check already is: "set GPU Layers to 0" cannot fix a too-long
        // installation path any more than it fixes a broken GGUF.
        //
        // And the whole branch is asked only of a retry that ran the SAME
        // offload. Once the second attempt has run on the processor by itself,
        // "set GPU Layers to 0" is advice the app has already taken, and
        // repeating it sends the user to a switch that will change nothing.
        format!("The LU Engine started and exited again before it could serve on port {port}. It was tried twice. This looks like a graphics-card problem. Open Settings, LU Engine and set GPU Layers to 0 to run on the CPU, then try again.")
    } else if failure.died && stderr_blames_the_port(&failure.stderr) {
        format!(
            "The LU Engine could not open port {port}. Another program holds it, or the port sits in a range this system has reserved. The app already tried the next free ports and got the same answer. Close that program or reboot, then try again."
        )
    } else if failure.died {
        let hint = died_failure_hint(
            &failure.stderr,
            backend_dir.is_some_and(windows_backend_dir_too_long),
            cfg!(target_os = "linux"),
        );
        match second {
            SecondAttempt::SameOffload => format!(
                "The LU Engine started and exited again before it could serve on port {port}. It was tried twice.{hint}"
            ),
            // The card has already been taken out of the picture once, so the
            // sentence says so: there is no setting left for this user to try,
            // and the next useful thing anyone can do is read the log.
            SecondAttempt::CpuOnly => format!(
                "The LU Engine exited before serving on port {port}. Tried with GPU offload and again on CPU.{hint}{LOG_FILE_NOTE}"
            ),
        }
    } else {
        format!(
            "The LU Engine did not become healthy on port {port} within {}s (the budget scales with model size, and huge GGUFs can take minutes on a cold first load).",
            budget.as_secs()
        )
    };
    if failure.stderr.is_empty() {
        head
    } else {
        format!("{head}\n\n{}", failure.stderr)
    }
}

/// The message the embeddings server hands back when it never became healthy.
///
/// The embeddings server is a second run of the SAME sidecar, so the missing
/// library that kills the chat engine kills this one too. It builds its
/// message itself and never went through `start_failure_message`, so
/// Document Chat used to answer a missing libvulkan.so.1 with a raw stderr
/// tail and no way out. It gets the same sentence now. The rest of
/// `start_failure_message` stays out of here on purpose: this path has
/// already refused a stranger on the port above and does not retry, so the
/// port and retry wording would not be true.
pub(crate) fn embed_start_failure_message(timeout_error: &str, stderr_tail: &str) -> String {
    let hint = stderr_names_a_missing_system_library(stderr_tail)
        .map(|lib| missing_library_hint(&lib, cfg!(target_os = "linux")))
        .unwrap_or_default();
    let head = format!("{timeout_error}{hint}");
    if stderr_tail.is_empty() {
        head
    } else {
        format!("{head}\n\n{stderr_tail}")
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
    // A stop that came before this start is history: whoever asks for a model
    // now wants it. Cleared under the gate, so it is only ever a stop that
    // arrives DURING this start that the waits below get to see.
    state.engine_stop_requested.store(false, std::sync::atomic::Ordering::SeqCst);
    start_engine_and_remember(app, state, model_path, tuning.unwrap_or_default(), port.unwrap_or(DEFAULT_ENGINE_PORT))
}

/// Caller holds ENGINE_START. Both explicit starts and Remote recovery use
/// the same startup, rollback, GPU fallback and model-file validation path.
/// Only an explicit start above is permitted to clear a deliberate Stop.
fn start_engine_and_remember(
    app: &AppHandle,
    state: &State<'_, AppState>,
    model_path: String,
    tuning: EngineTuning,
    port: u16,
) -> Result<serde_json::Value, String> {
    if stop_was_requested(state) { return Ok(stopped_answer(port, &model_path)); }
    let result = start_bundled_engine_locked(app, state, model_path.clone(), &tuning, port);
    remember_engine_request(&state.bundled_engine_recovery, &state.engine_stop_requested, model_path, tuning, &result);
    result
}

fn remember_engine_request(
    recipes: &std::sync::Mutex<Option<EngineRecoveryRecipe>>,
    stopped: &std::sync::atomic::AtomicBool,
    model_path: String,
    tuning: EngineTuning,
    result: &Result<serde_json::Value, String>,
) {
    let Ok(answer) = result else { return };
    if stopped.load(std::sync::atomic::Ordering::SeqCst) { return; }
    if !matches!(answer.get("status").and_then(|s| s.as_str()), Some("started" | "already_running")) { return; }
    let Some(port) = answer.get("port").and_then(|p| p.as_u64()).and_then(|p| u16::try_from(p).ok()) else { return };
    if let Ok(mut latest) = recipes.lock() {
        *latest = Some(EngineRecoveryRecipe { model_path, tuning, port });
    }
}

fn start_bundled_engine_locked(
    app: &AppHandle,
    state: &State<'_, AppState>,
    model_path: String,
    tuning: &EngineTuning,
    port: u16,
) -> Result<serde_json::Value, String> {

    if !Path::new(&model_path).exists() {
        return Err(format!("Model file not found: {model_path}"));
    }

    // Acht Bytes je Datei lesen, bevor irgendetwas angehalten wird. Persona P5
    // hat am 03./04.09.2026 am echten Build gemessen, was ein Klick auf eine
    // unbrauchbare Datei kostet: die gesunde Engine wird abgeraeumt, zwei
    // Versuche scheitern, die alte wird wieder hochgezogen, und der Nutzer
    // sitzt 7,4 s ohne Chat da. Fuer eine Datei, deren erste acht Bytes schon
    // sagen, dass llama.cpp sie nicht laden wird.
    //
    // Das Ergebnis ist zugleich der Pfad der Sichtdatei (Projektor aus dem
    // Discover-Download): vorhanden = multimodal starten, keine = unveraendert
    // das Text-argv.
    let mmproj = precheck_model_files(&model_path)?;

    // KV-slot directory next to the built-in models (GH #85). Best effort: a
    // failure here only disables slot save/restore, never the engine itself.
    let slot_dir = builtin_models_dir()
        .ok()
        .and_then(|models| models.parent().map(|p| p.join("kv-slots")))
        .and_then(|dir| {
            std::fs::create_dir_all(&dir).ok()?;
            Some(dir.to_string_lossy().to_string())
        });

    // Already serving this exact argv and healthy → no-op. The argv is the
    // idempotence key: a ctx/KV-quant/flash-attn change restarts the server,
    // an identical request reuses the running process.
    //
    // Asked on the port the engine ACTUALLY runs on, not on the preferred one.
    // An engine that had to move to a fallback port carries that port in its
    // argv, and comparing it against the preferred port would tear down a
    // perfectly healthy engine on every single call.
    {
        let guard = state.bundled_engine.lock().unwrap();
        if let Some(engine) = guard.as_ref() {
            // An engine that came up without the image part (no room on the
            // card, or the engine refused the part) is still the answer to
            // this request. Comparing it against an argv WITH the part would
            // restart a healthy engine on every single call, to arrive at the
            // same place each time.
            let part_it_runs_with = if engine.image_part_note.is_some() { None } else { mmproj.as_deref() };
            let args_on_its_port = build_server_args(
                &model_path,
                &tuning,
                engine.port,
                slot_dir.as_deref(),
                part_it_runs_with,
                None,
            );
            // With GPU Layers on auto the layer count is a MEASUREMENT, taken
            // after the old engine was stopped and the render caches were
            // freed, so it cannot be reproduced here and it is not part of the
            // request. Comparing it would restart a perfectly healthy engine
            // every time a browser tab changed how much memory was free. A
            // switch between auto and a typed number is still a real
            // difference, which is what `auto_layers` on both sides is for.
            let same_request = if tuning.gpu_layers < 0 && engine.auto_layers {
                argv_without_gpu_layers(&engine.args) == argv_without_gpu_layers(&args_on_its_port)
            } else {
                engine.args == args_on_its_port
            };
            if same_request
                && may_keep_engine_where_it_is(engine.port, port, || port_is_bindable(port))
                && engine_healthy(engine.port)
            {
                return Ok(serde_json::json!({
                    "status": "already_running",
                    "port": engine.port,
                    "model_path": engine.model_path,
                    "ctx": engine.ctx,
                }));
            }
        }
    }

    // Was gerade bedient wird, damit ein misslungener Wechsel es
    // zurueckbringen kann. Ein Wechsel ist ein Halt UND ein Start, und bis
    // 2.6.8 war nur der Halt sicher: ein Klick auf eine kaputte GGUF beendete
    // die gesunde Engine 0,4 s spaeter, also bevor der erste Versuch mit der
    // neuen Datei ueberhaupt begann, und niemand holte sie zurueck. Wer ein
    // kaputtes Modell antippte, stand ohne Chat da (gemessen am 03.09.2026,
    // 21:11:48.611, Gegenprobe zu 29f22a1a).
    let vorher = {
        let guard = state.bundled_engine.lock().unwrap();
        guard.as_ref().map(|e| PreviousEngine {
            model_path: e.model_path.clone(),
            args: e.args.clone(),
            auto_layers: e.auto_layers,
            cpu_fallback: e.cpu_fallback,
            port: e.port,
            ctx: e.ctx,
            image_part_note: e.image_part_note,
        })
    };

    // Different model (or dead) → stop the old process before spawning.
    stop_engine_locked(state);

    let outcome = start_after_stop(app, state, &model_path, &tuning, port, slot_dir.as_deref(), mmproj.as_deref());
    settle_switch(state, port, &model_path, outcome, || match (vorher, resolve_engine_binary(app)) {
        (Some(p), Some(bin)) => restore_engine(&bin, state, &p, resolve_engine_backend_dir(app).as_deref()),
        _ => false,
    })
}

/// What a switch answers once the start behind it has ended, and whether the
/// model that served before is brought back first.
///
/// A stop on request outranks everything else, whichever way the start ended.
/// Every exit of the start comes through here, so this one place covers all of
/// them: the previous model is NOT brought back (the user asked for an empty
/// engine), and the answer is not an error. An error is what the callers act
/// on: the resume loop of the app start runs the start again 1.5 s and 5 s
/// later, and the context raise falls back to a second start with the old
/// settings. Either one would load the model that was just unloaded.
///
/// The stop is asked about twice. The second time is for a stop that arrives
/// while the previous model is being brought back: that attempt is cut short
/// by the same mark, and its failure is not the user's news either.
///
/// A start that came up and was stopped right behind it answers "stopped" as
/// well. Nothing serves, and an answer that still carried the notes of the
/// sanity probe would describe an engine that is gone.
fn settle_switch(
    state: &AppState,
    port: u16,
    model_path: &str,
    outcome: Result<serde_json::Value, String>,
    restore_previous: impl FnOnce() -> bool,
) -> Result<serde_json::Value, String> {
    if stop_was_requested(state) {
        return Ok(stopped_answer(port, model_path));
    }
    let msg = match outcome {
        Ok(answer) => return Ok(answer),
        Err(msg) => msg,
    };
    let restored = restore_previous();
    if stop_was_requested(state) {
        return Ok(stopped_answer(port, model_path));
    }
    Err(if restored { with_note_on_top(&msg, RESTORED_NOTE) } else { msg })
}

/// Die Engine, die vor einem Wechsel bediente.
struct PreviousEngine {
    model_path: String,
    args: Vec<String>,
    port: u16,
    ctx: Option<u32>,
    /// Whether that engine's layer count was measured. Carried so the restored
    /// process is the same kind of start it was, and the idempotence check
    /// keeps answering the same way about it afterwards.
    auto_layers: bool,
    /// Whether that engine was already the CPU retry. Carried for the same
    /// reason: a restore brings the process back as it was, and a status read
    /// afterwards must not claim the card back for it.
    cpu_fallback: bool,
    /// Whether that engine ran without its image part, and why. Carried so
    /// the restored process keeps saying it.
    image_part_note: Option<&'static str>,
}

/// What `start_after_stop` hands up when the engine was stopped on request
/// before the model had finished loading. `settle_switch` turns it into
/// `stopped_answer`, so this sentence is for the log and never for a user.
const STOPPED_WHILE_LOADING: &str = "The LU Engine was stopped while it was loading the model.";

/// What a start answers when it was stopped on request. `port` is the port
/// that was asked for: nothing listens anywhere, and the next start names its
/// own.
fn stopped_answer(port: u16, model_path: &str) -> serde_json::Value {
    serde_json::json!({
        "status": "stopped",
        "port": port,
        "model_path": model_path,
    })
}

/// Whether somebody asked for the engine to be stopped since the running start
/// took the start gate. See `AppState::engine_stop_requested`.
fn stop_was_requested(state: &AppState) -> bool {
    state.engine_stop_requested.load(std::sync::atomic::Ordering::SeqCst)
}

/// Der Satz, der an die Fehlermeldung geht, wenn das alte Modell wieder laeuft.
/// Ohne ihn liest sich ein geglueckter Rueckfall wie ein Totalausfall, und der
/// Nutzer sucht nach etwas, das schon in Ordnung ist.
const RESTORED_NOTE: &str = "The model that was serving before is running again.";

/// Die vorherige Engine wieder starten, nachdem ein Wechsel gescheitert ist.
///
/// Der alte Prozess ist tot und laesst sich nicht zurueckholen, also wird er
/// aus genau dem argv neu gestartet, mit dem er lief. EIN Versuch, keine
/// Wiederholung: er bediente vor Sekunden noch, und ein zweiter Fehlschlag
/// hier waere nichts, woran ein Nutzer etwas aendern koennte. Er wuerde nur
/// die Fehlermeldung des eigentlichen Problems um Minuten verzoegern.
fn restore_engine(binary: &Path, state: &AppState, vorher: &PreviousEngine, backend_dir: Option<&Path>) -> bool {
    tracing::warn!(target: "engine", model = %vorher.model_path, port = vorher.port, "the model switch failed, bringing the previous model back");
    let ok = spawn_engine_attempt(
        state,
        binary,
        &vorher.args,
        &vorher.model_path,
        vorher.port,
        vorher.ctx,
        AttemptFlags { auto_layers: vorher.auto_layers, cpu_fallback: vorher.cpu_fallback },
        backend_dir,
    )
    .is_ok();
    if !ok {
        tracing::error!(target: "engine", model = %vorher.model_path, port = vorher.port, "could not bring the previous model back");
    } else if let Some(live) = state.bundled_engine.lock().unwrap().as_mut() {
        live.image_part_note = vorher.image_part_note;
    }
    ok
}

/// Der Startweg ab dem Punkt, an dem die alte Engine bereits gestoppt ist.
///
/// Eigene Funktion, damit JEDER Fehlerausgang darin durch den Rueckfall oben
/// laeuft. Vorher standen hier vier `return Err(...)` im selben Rumpf wie der
/// Stopp, und ein Rueckfall haette an vier Stellen wiederholt werden muessen.
#[allow(clippy::too_many_arguments)]
fn start_after_stop(
    app: &AppHandle,
    state: &State<'_, AppState>,
    model_path: &str,
    tuning: &EngineTuning,
    port: u16,
    slot_dir: Option<&str>,
    // The image part that lies next to the model, when there is one. Whether
    // it is LOADED is decided below, against the card.
    image_part: Option<&str>,
) -> Result<serde_json::Value, String> {

    // The port must actually be FREE now: our own previous child (if any) was
    // killed AND reaped above, so anything still holding it is an orphaned or
    // foreign server, left over from a crashed or hard-killed session, or
    // user-run. Spawning against it would LOOK green: the health probe below is
    // answered by the stranger while our child is still loading its model and
    // only later dies on "address already in use", so chats would silently hit
    // an unknown model with unknown ctx, tuning would never apply, and no
    // shutdown of ours could ever reap it. (Live repro 2026-07-28: an embed
    // server orphaned by a hard-killed dev session made every later start look
    // successful.)
    //
    // What used to happen here was an error telling the user to quit that
    // process or reboot. GH #118: that is an instruction, not a repair, and on
    // a fresh Windows install the thing holding the port is often a reserved
    // range nobody can quit. So the app takes the next port it can open, and
    // only a completely blocked block of ports is worth a message.
    let preferred_port = port;

    // Mirror image of the Create-tab handoff: a render leaves ComfyUI's
    // checkpoint cached in VRAM (`includeComfyui:false` keeps it warm between
    // runs). On a single-GPU box the returning chat engine then fights that
    // cache for memory — llama-server with `-ngl 999` loses as a CUDA OOM
    // (RTX 5080 field report: ACE-Step → chat = crash until app restart). Ask
    // ComfyUI to drop its cache first; best-effort no-op when it isn't running.
    // T-65: the address comes from AppState (user-configured port/host), and a
    // ComfyUI that is not this machine's is reported as such instead of
    // reading like an idle one.
    match crate::commands::process::free_comfyui_memory(state) {
        r if r.released() => {
            tracing::info!(target: "engine", "asked ComfyUI to free VRAM before engine start")
        }
        r => {
            if let Some((addr, why)) = r.not_responsible() {
                tracing::info!(target: "engine", addr = %addr, reason = %why, "did not free ComfyUI VRAM");
            }
        }
    }

    // Ollama fights for the same VRAM and, unlike ComfyUI, its freshly-used
    // pages are hot enough that WDDM won't demote them: on a 12 GB 3060 with a
    // just-active 14B loaded, this engine's own load crawled through paging and
    // blew the health budget (live repro 2026-07-31; an IDLE model gets evicted
    // fine). Evict via keep_alive:0 — Ollama reloads lazily on its next use.
    match crate::commands::process::offload_ollama_loaded_models(state) {
        r if r.released() => {
            tracing::info!(target: "engine", "asked Ollama to evict loaded models before engine start")
        }
        r => {
            if let Some((addr, why)) = r.not_responsible() {
                tracing::info!(target: "engine", addr = %addr, reason = %why, "did not evict Ollama models");
            }
        }
    }

    let binary = resolve_engine_binary(app).ok_or_else(|| {
        // This used to name a build script. On a user's machine that is not an
        // instruction, it is noise; the only real remedies are a reinstall or a
        // different backend (GH #118).
        format!(
            "The LU Engine program ({}) is missing from this installation. Reinstall Locally Uncensored, or pick a different backend in Settings, AI Backends.",
            sidecar_binary_name()
        )
    })?;
    // K1 (3.0.1): where the dynamic-ISA sidecar's companion libraries are,
    // None on mac / a static build. Resolved once here and carried through
    // both attempts and the sanity-probe restarts below, same as `binary`.
    let backend_dir = resolve_engine_backend_dir(app);

    // Attempt 1, then exactly one clean retry.
    //
    // GH #118 (2026-08-27): the only thing a user ever saw when this
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

    // The port is chosen HERE, immediately before the spawn, and not further
    // up. A bind probe is only true for as long as nobody else binds, and the
    // VRAM calls above take seconds on a busy box (S4): choosing early would
    // hand llama-server an answer that had gone stale in the meantime.
    let candidates = engine_port_candidates(preferred_port);
    let port = match first_usable_port(&candidates, port_is_bindable) {
        Some(p) => p,
        None => {
            return Err(no_free_port_message(
                preferred_port,
                *candidates.last().unwrap_or(&preferred_port),
            ))
        }
    };
    if port != preferred_port {
        tracing::warn!(target: "engine", wanted = preferred_port, port, "the preferred port is taken, the LU Engine moves");
    }
    // The layer count, decided against the card instead of assumed (bugs u and
    // a). Only for the auto default: a number typed into Settings is the
    // user's answer and the probe is not even run for it.
    //
    // Asked HERE and not further up, for the same reason the port is: the old
    // engine has been stopped and ComfyUI and Ollama have been asked to let go
    // a few lines above, so this is the first moment at which "free" means
    // free. Those two release asynchronously, so a reading taken while a
    // driver still holds their pages is too small rather than too large, and
    // too small costs speed while too large costs the start.
    let ctx_size = effective_ctx(tuning);
    let auto_layers = tuning.gpu_layers < 0;
    let auto_card = if auto_layers { crate::commands::gpu::engine_vram_reading() } else { None };
    let (auto_ngl, part_fits) = if auto_layers && engine_fits_layers(auto_card.as_ref(), cfg!(target_os = "macos")) {
        // GH #156: the card was not measured free, so the engine measures it.
        // The image part stays: if it does not fit, the engine says so and
        // the retry below starts again without it.
        tracing::info!(
            target: "engine",
            vram_mib = auto_card.as_ref().map(|c| (c.bytes / (1024 * 1024)).to_string()).unwrap_or_else(|| "unknown".into()),
            vram_source = auto_card.as_ref().map(|c| c.source).unwrap_or("none"),
            ctx = ctx_size,
            ngl = "auto",
            "the card's free graphics memory was not measured, only its total, so the engine measures it and picks the layer count itself"
        );
        (Some(ENGINE_DECIDES), true)
    } else if auto_layers {
        let card = auto_card;
        let header = crate::commands::gguf::read_header(model_path);
        let plan = plan_offload(&OffloadInputs {
            model_bytes: std::fs::metadata(model_path).map(|m| m.len()).unwrap_or(0),
            block_count: header.block_count,
            vram_bytes: card.as_ref().map(|c| c.bytes),
            ctx: ctx_size,
            free: card.as_ref().map(|c| c.free).unwrap_or(false),
            image_part_bytes: image_part
                .and_then(|p| std::fs::metadata(p).ok())
                .map(|m| m.len())
                .unwrap_or(0),
        });
        tracing::info!(
            target: "engine",
            vram_mib = card.as_ref().map(|c| (c.bytes / (1024 * 1024)).to_string()).unwrap_or_else(|| "unknown".into()),
            vram_is_free_memory = card.as_ref().map(|c| c.free).unwrap_or(false),
            vram_source = card.as_ref().map(|c| c.source).unwrap_or("none"),
            block_count = header.block_count.map(|b| b.to_string()).unwrap_or_else(|| "unknown".into()),
            ctx = ctx_size,
            ngl = plan.layers.unwrap_or(ALL_LAYERS).to_string(),
            "{}",
            plan.why
        );
        (plan.layers, plan.with_image_part)
    } else {
        // A layer count the user typed is the user's answer, and nothing is
        // measured for it. The image part is loaded as it always was.
        (None, true)
    };
    // The image part this start really passes along. A part that would push
    // the model off the card is left out, and the note says so afterwards.
    let mmproj = if part_fits { image_part } else { None };
    let image_note = (image_part.is_some() && !part_fits).then_some(IMAGE_PART_NO_ROOM_NOTE);
    let desired_args =
        build_server_args(model_path, tuning, port, slot_dir, mmproj, auto_ngl);

    let deadline = health_timeout_for(model_path);
    let ctx = Some(ctx_size);
    let first = spawn_engine_attempt(
        state,
        &binary,
        &desired_args,
        model_path,
        port,
        ctx,
        AttemptFlags { auto_layers, cpu_fallback: false },
        backend_dir.as_deref(),
    );
    let failure = match first {
        Ok(startup) => {
            tracing::info!(target: "engine", port, attempt = 1, "the LU Engine is serving");
            let mut answer = serve_or_heal_garbled(
                state,
                &binary,
                model_path,
                tuning,
                port,
                slot_dir,
                mmproj,
                &desired_args,
                ctx,
                auto_layers,
                &startup,
                backend_dir.as_deref(),
            );
            note_image_part(state, &mut answer, image_note);
            return Ok(answer);
        }
        Err(f) => f,
    };

    if stop_was_requested(state) {
        // The child did not die, it was stopped while it was loading (the
        // user switched away, went into Cloud, or closed the app). Every
        // retry below would start the model that was just unloaded.
        tracing::info!(target: "engine", port, "the LU Engine was stopped while it was loading, no second attempt");
        return Err(STOPPED_WHILE_LOADING.to_string());
    }

    if !failure.died {
        // The budget ran out with the child still alive: it is loading slowly,
        // not failing. Retrying would just spend the budget twice.
        return Err(start_failure_message(&failure, port, deadline, SecondAttempt::SameOffload, backend_dir.as_deref()));
    }

    if is_illegal_instruction_exit(failure.exit_code) || is_sigill(failure.signal) {
        // K1 Runde 2, Punkt D: the GPU-offload attempt and the CPU-only
        // retry run the exact same binary, so a CPU that crashes on an
        // opcode the first time crashes on it the second time too, whether
        // that crash reads back as Windows' 0xC000001D exit code or Linux's
        // SIGILL. The old code ran the retry anyway ("attempt=1/2" in the
        // log, both dying identically) and cost the user the full
        // settle-and-relaunch wait for a foregone conclusion; this
        // short-circuits straight to the message instead.
        tracing::error!(
            target: "engine",
            port,
            exit_code = failure.exit_code.unwrap_or_default(),
            signal = failure.signal.unwrap_or_default(),
            "the LU Engine crashed with an illegal-instruction fault, skipping the pointless second attempt"
        );
        return Err(start_failure_message(&failure, port, deadline, SecondAttempt::SameOffload, backend_dir.as_deref()));
    }

    // The engine died on the image part, not on the model. Then the second
    // attempt is the same start without the part: the card keeps its layers,
    // the model answers, and the note says that it cannot see. Running it on
    // the processor instead would change the one thing that was not at fault.
    if mmproj.is_some() && stderr_blames_the_image_part(&failure.stderr) {
        tracing::warn!(target: "engine", port, "the engine could not load the image part, retrying without it");
        std::thread::sleep(Duration::from_millis(1500));
        let args = build_server_args(model_path, tuning, port, slot_dir, None, auto_ngl);
        return match spawn_engine_attempt(
            state,
            &binary,
            &args,
            model_path,
            port,
            ctx,
            AttemptFlags { auto_layers, cpu_fallback: false },
            backend_dir.as_deref(),
        ) {
            Ok(startup) => {
                tracing::warn!(target: "engine", port, "the LU Engine is serving without the image part");
                let mut answer = serve_or_heal_garbled(
                    state,
                    &binary,
                    model_path,
                    tuning,
                    port,
                    slot_dir,
                    None,
                    &args,
                    ctx,
                    auto_layers,
                    &startup,
                    backend_dir.as_deref(),
                );
                answer["retried"] = serde_json::json!(true);
                note_image_part(state, &mut answer, Some(IMAGE_PART_REFUSED_NOTE));
                Ok(answer)
            }
            Err(second) => Err(start_failure_message(&second, port, deadline, SecondAttempt::SameOffload, backend_dir.as_deref())),
        };
    }

    tracing::warn!(target: "engine", port, "the first start attempt exited before it served, retrying once");
    std::thread::sleep(Duration::from_millis(1500));
    // A start that died ON THE PORT does not get better by using the same port
    // a second time, so the retry moves. The bind check above said the port was
    // free, and on Windows it can still be refused to the child (a reserved
    // range answers WSAEACCES rather than "in use"), which is exactly the
    // failure that leaves a user staring at ERR_CONNECTION_REFUSED forever.
    let retry_port = if stderr_blames_the_port(&failure.stderr) {
        let rest: Vec<u16> = engine_port_candidates(preferred_port)
            .into_iter()
            .filter(|p| *p != port)
            .collect();
        first_usable_port(&rest, port_is_bindable).unwrap_or(port)
    } else {
        port
    };
    if retry_port != port {
        tracing::warn!(target: "engine", port, retry_port, "the first attempt could not open the port, the retry moves");
    }

    // The retry used to run the SAME arguments on the same card, which is what
    // the sentence "It was tried twice" was really saying: twice the wait for
    // one experiment. If layers went onto a graphics card and the process died
    // before it served, the card is the first thing worth taking out of the
    // picture, so the second attempt runs on the processor. Slower, and it
    // serves. When the first attempt was already on the processor there is
    // nothing to take away and the retry stays what it was.
    let offload_was_tried = gpu_layers_in(&desired_args).is_some_and(|n| n > 0);
    let second_attempt = if offload_was_tried {
        SecondAttempt::CpuOnly
    } else {
        SecondAttempt::SameOffload
    };
    // R1-10: bound once so both the argv AND the sanity-probe restart ladder
    // below build against the SAME tuning the retry actually ran with, a
    // CPU-only retry must not have serve_or_heal_garbled think it still has
    // a card to give up.
    let retry_tuning = if offload_was_tried { on_the_processor(tuning) } else { tuning.clone() };
    let retry_args = if offload_was_tried {
        tracing::warn!(
            target: "engine",
            port = retry_port,
            "the retry drops GPU offload and runs the LU Engine on the processor"
        );
        build_server_args(model_path, &retry_tuning, retry_port, slot_dir, mmproj, None)
    } else if retry_port != port {
        build_server_args(model_path, &retry_tuning, retry_port, slot_dir, mmproj, auto_ngl)
    } else {
        desired_args.clone()
    };
    // A retry that ran on the processor was not an auto layer count, whatever
    // the request said, so the idempotence check must not treat it as one: the
    // next start with the same settings has to be allowed to try the card
    // again.
    let retry_auto = auto_layers && !offload_was_tried;
    match spawn_engine_attempt(
        state,
        &binary,
        &retry_args,
        model_path,
        retry_port,
        ctx,
        AttemptFlags { auto_layers: retry_auto, cpu_fallback: offload_was_tried },
        backend_dir.as_deref(),
    ) {
        Ok(startup) => {
            if offload_was_tried {
                tracing::warn!(
                    target: "engine",
                    port = retry_port,
                    "the LU Engine is serving on the processor only, the graphics card was taken out after the first attempt died"
                );
            } else {
                tracing::info!(target: "engine", port = retry_port, attempt = 2, "the LU Engine is serving");
            }
            // R1-10: the first attempt's success path already runs the
            // sanity probe (bug a) through serve_or_heal_garbled; the retry
            // path used to skip it entirely and hand back a bare "started"
            // object, so a garbled answer on the SECOND attempt was never
            // caught or healed. `retried`/`cpuOnly` are added on top so
            // every existing caller keeps reading exactly those two keys.
            let mut answer = serve_or_heal_garbled(
                state,
                &binary,
                model_path,
                &retry_tuning,
                retry_port,
                slot_dir,
                mmproj,
                &retry_args,
                ctx,
                retry_auto,
                &startup,
                backend_dir.as_deref(),
            );
            answer["retried"] = serde_json::json!(true);
            answer["cpuOnly"] = serde_json::json!(offload_was_tried);
            note_image_part(state, &mut answer, image_note);
            Ok(answer)
        }
        Err(second) => Err(start_failure_message(&second, retry_port, deadline, second_attempt, backend_dir.as_deref())),
    }
}

/// What a start answers when there is nothing to report about it. The exact
/// object this function has always returned; the probe below only ever ADDS
/// keys to it, so a healthy machine sees precisely what it saw before.
fn started_answer(port: u16, model_path: &str, ctx: Option<u32>) -> serde_json::Value {
    serde_json::json!({
        "status": "started",
        "port": port,
        "model_path": model_path,
        "ctx": ctx,
    })
}

/// The same request with Flash Attention switched off, and nothing else moved.
fn without_flash_attention(tuning: &EngineTuning) -> EngineTuning {
    EngineTuning { flash_attn: "off".into(), ..tuning.clone() }
}

/// The same request with the graphics card taken out of it.
///
/// `gpu_layers: 0` rather than a smaller number on purpose. A card that
/// answered unreadably has not proven it can be trusted with fewer layers, and
/// halving a broken thing is a guess; the processor is the one part of the
/// machine the three reports have never implicated. Everything else the user
/// asked for (context, cache types, threads, mlock, mmap, the vision file)
/// survives untouched, so only the one suspect variable moves.
fn on_the_processor(tuning: &EngineTuning) -> EngineTuning {
    EngineTuning { gpu_layers: 0, ..tuning.clone() }
}

/// The sanity probe, and the restart it may decide on (bug a).
///
/// Runs AFTER the engine has reported healthy, which is the whole point: a
/// healthy port is what the three reporters already had. One fixed question at
/// temperature 0, 24 tokens, and a look at the shape of the answer. Readable,
/// or unreadable and the graphics card comes out.
///
/// Costs nothing on a healthy machine that it would not have paid anyway: the
/// probe's prompt is the warm-up the user's first message would otherwise have
/// paid for, and it only ever runs at a start, never per message. A probe that
/// times out, is refused, or answers something unjudgeable leaves the engine
/// exactly where it is.
#[allow(clippy::too_many_arguments)]
fn serve_or_heal_garbled(
    state: &AppState,
    binary: &Path,
    model_path: &str,
    tuning: &EngineTuning,
    port: u16,
    slot_dir: Option<&str>,
    mmproj: Option<&str>,
    args: &[String],
    ctx: Option<u32>,
    auto_layers: bool,
    startup: &str,
    backend_dir: Option<&Path>,
) -> serde_json::Value {
    let mut answer = started_answer(port, model_path, ctx);
    // Measured once, from what llama-server itself printed on its way up. A
    // restart does not change the card, so this is not asked again.
    // GH #156: the pinned Vulkan build never prints its device line, so on
    // Windows and Linux silence counts as "may have none" (see
    // `may_lack_matrix_cores`). The Mac runs Metal.
    let no_matrix_cores = engine_sanity::may_lack_matrix_cores(startup, !cfg!(target_os = "macos"));
    let matrix_cores = engine_sanity::matrix_cores_label(startup);
    // What the engine currently runs with. Both move as the ladder is climbed,
    // and both are read back out of the argv that was actually spawned.
    let mut serving = tuning.clone();
    let mut serving_args = args.to_vec();
    // Three rungs at most (as it is, without flash attention, on the
    // processor), so a machine that is broken in some way this cannot mend
    // ends in seconds instead of restarting for ever.
    for _ in 0..3 {
        let Some(probe) = engine_sanity::probe_engine(port, engine_sanity::PROBE_TIMEOUT) else {
            // D3: `None` here means the probe itself never got an answer to
            // judge (timed out, refused, or an unexpected body), not that
            // the engine answered badly. On a run with no GPU layers this is
            // routine: a cold CPU-only load of `PROBE_TOKENS` can outrun the
            // probe's short budget on its own, with nothing wrong at all, and
            // the wording says so instead of reading like a fault.
            let cpu_only = gpu_layers_in(&serving_args).unwrap_or_default() == 0;
            let msg = format!(
                "the sanity probe did not get an answer to judge within its budget{}, the LU Engine is left as it is",
                if cpu_only { " (a cold CPU-only load can be slower than that on its own)" } else { "" }
            );
            tracing::info!(
                target: "engine",
                port,
                cpu_only,
                budget_s = engine_sanity::PROBE_TIMEOUT.as_secs(),
                "{}", msg
            );
            return answer;
        };
        let facts = engine_sanity::EngineFacts {
            gpu_layers: gpu_layers_in(&serving_args),
            flash_attention_on: serving.flash_attn != "off",
            every_device_without_matrix_cores: no_matrix_cores,
        };
        tracing::info!(
            target: "engine",
            port,
            verdict = engine_sanity::verdict_label(probe.verdict, probe.still_thinking),
            ms = probe.took.as_millis() as u64,
            ngl = facts.gpu_layers.map(ngl_arg).unwrap_or_else(|| "none".into()),
            flash_attention = facts.flash_attention_on,
            matrix_cores,
            flash_attention_rung = no_matrix_cores,
            answer = %probe.sample,
            "sanity probe on the LU Engine"
        );
        // `cpu_rung` is what the status line later reports as `cpuOnly`: the
        // processor rung is a fallback the user did not ask for, the flash
        // attention rung keeps whatever layer count was typed.
        let (next, cpu_rung) = match engine_sanity::decide(probe.verdict, &facts) {
            engine_sanity::AfterProbe::Serve => return answer,
            engine_sanity::AfterProbe::GiveUp => {
                tracing::error!(
                    target: "engine",
                    port,
                    verdict = engine_sanity::verdict_label(probe.verdict, probe.still_thinking),
                    "the LU Engine answers unreadably without the graphics card, so the card is not the cause"
                );
                answer["garbled"] = serde_json::json!(true);
                answer["note"] = serde_json::json!(engine_sanity::GARBLED_ON_CPU_NOTE);
                remember_sanity_note(state, engine_sanity::GARBLED_ON_CPU_NOTE);
                return answer;
            }
            engine_sanity::AfterProbe::RestartWithoutFlashAttention => {
                tracing::warn!(
                    target: "engine",
                    port,
                    verdict = engine_sanity::verdict_label(probe.verdict, probe.still_thinking),
                    "this card reports no matrix cores, restarting the LU Engine with Flash Attention off"
                );
                (without_flash_attention(&serving), false)
            }
            engine_sanity::AfterProbe::RestartOnCpu => {
                tracing::warn!(
                    target: "engine",
                    port,
                    verdict = engine_sanity::verdict_label(probe.verdict, probe.still_thinking),
                    "the graphics card produced unreadable output, restarting the LU Engine on the processor"
                );
                (on_the_processor(&serving), true)
            }
        };
        // A restart is a measurement thrown away: whatever `plan_offload` said
        // for the first start is not asked again, because the argument that is
        // being changed is not the layer count. So the layer count the engine
        // is actually running with is carried across instead of dropped, read
        // from the argv that was spawned, exactly as `facts.gpu_layers` above
        // reads it. `None` here would hand the sentinel to the flash attention
        // rung: a card measured at twelve layers would be asked for all of
        // them on the very restart that is meant to rescue it. On the
        // processor rung it changes nothing, `gpu_layers: 0` is a typed number
        // and outranks `auto_ngl` in `build_server_args`.
        let next_args = build_server_args(
            model_path,
            &next,
            port,
            slot_dir,
            mmproj,
            gpu_layers_in(&serving_args),
        );
        stop_engine_locked(state);
        // A restart is never an auto layer count, whatever the request said, so
        // the idempotence key must not remember it as one: the next start with
        // these settings has to be allowed to try the card again. Same rule as
        // the died-on-start retry.
        if spawn_engine_attempt(
            state,
            binary,
            &next_args,
            model_path,
            port,
            ctx,
            AttemptFlags { auto_layers: false, cpu_fallback: cpu_rung },
            backend_dir,
        ).is_err() {
            if stop_was_requested(state) {
                // The restart did not fail, the engine was stopped on request
                // while it loaded. Nothing is brought back and nothing is
                // noted about a restart: `settle_switch` answers "stopped".
                return answer;
            }
            // The restart did not come up, and an engine that at least served
            // has just been torn down for it. Put the first one back rather
            // than leave the user with nothing; ONE attempt, for the same
            // reason `restore_engine` takes only one.
            tracing::error!(
                target: "engine",
                port,
                "the restart did not come up, bringing the first LU Engine back"
            );
            let _ = spawn_engine_attempt(
                state,
                binary,
                args,
                model_path,
                port,
                ctx,
                AttemptFlags { auto_layers, cpu_fallback: false },
                backend_dir,
            );
            answer["garbled"] = serde_json::json!(true);
            // Not the CPU sentence. Nothing ran on the processor here and
            // nothing was judged there: the restart never came up, so
            // `probe_engine` was never called for it, and on the flash
            // attention rung the processor was not even the destination. The
            // user is told what actually happened, which is that the settings
            // could not be changed and the engine he already had is back.
            answer["note"] = serde_json::json!(engine_sanity::RESTART_DID_NOT_COME_BACK_NOTE);
            remember_sanity_note(state, engine_sanity::RESTART_DID_NOT_COME_BACK_NOTE);
            return answer;
        }
        answer["retried"] = serde_json::json!(true);
        answer["garbled"] = serde_json::json!(true);
        answer["cpuOnly"] = serde_json::json!(next.gpu_layers == 0);
        // The note tells the truth only after the next pass round this loop has
        // judged the new engine. Until then it says what was done, and the pass
        // that finds the answer readable returns it; a pass that does not
        // overwrites it.
        let healed = if cpu_rung {
            engine_sanity::HEALED_ON_CPU_NOTE
        } else {
            engine_sanity::HEALED_WITHOUT_FLASH_ATTENTION_NOTE
        };
        answer["note"] = serde_json::json!(healed);
        remember_sanity_note(state, healed);
        serving = next;
        serving_args = next_args;
    }
    answer
}

/// Pin "this engine runs without its image part" to the process and to the
/// answer of the start, after every restart the sanity probe may have made:
/// each of those spawns a fresh process, and a note set before them would be
/// gone with the old one. Nothing happens for an ordinary start.
fn note_image_part(state: &AppState, answer: &mut serde_json::Value, note: Option<&'static str>) {
    let Some(note) = note else { return };
    if let Some(live) = state.bundled_engine.lock().unwrap().as_mut() {
        live.image_part_note = Some(note);
    }
    answer["imageNote"] = serde_json::json!(note);
}

/// The image part a finished argv passes along, when it passes one.
pub(crate) fn image_part_in(args: &[String]) -> Option<&str> {
    let at = args.iter().position(|a| a == "--mmproj")?;
    args.get(at + 1).map(String::as_str)
}

/// Pin the sanity probe's sentence to the process it is about, so a status
/// read after the start call has returned can still say it. A slot that is
/// empty here means the engine died between the probe and now, and there is
/// nothing left to annotate.
fn remember_sanity_note(state: &AppState, note: &'static str) {
    if let Some(live) = state.bundled_engine.lock().unwrap().as_mut() {
        live.sanity_note = Some(note);
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
    /// The child's raw process exit code, when the OS reported one. `None`
    /// covers both "not this kind of failure" (timed out, port taken) and "a
    /// signal killed it". K1: this is what lets `is_illegal_instruction_exit`
    /// name the Windows 0xC000001D crash instead of it hiding in `stderr` as
    /// an empty string, since llama-server never gets to print anything.
    pub exit_code: Option<i32>,
    /// The POSIX signal that killed the child, on Unix, when there was one.
    /// Always `None` on Windows and on every non-signal death. K1 Runde 2,
    /// Punkt D: this is the Linux/macOS twin of `exit_code` for the SAME
    /// illegal-instruction crash: `exit_code` alone cannot see it, a signal
    /// death carries no exit code at all.
    pub signal: Option<i32>,
}

/// The two marks an attempt leaves in `BundledEngine`: the restart paths and
/// the idempotence key read them back from there. They travel together because
/// they describe the same attempt, not two independent switches.
#[derive(Clone, Copy)]
struct AttemptFlags {
    /// The layer count was measured for this start, not typed by the user.
    auto_layers: bool,
    /// This attempt is already the one without the graphics card.
    cpu_fallback: bool,
}

/// Spawn the engine and wait for it, watching BOTH the health endpoint and the
/// child. Reaps the child on every failure path so no half-loaded server is
/// left behind.
///
/// On success this hands back what llama-server said on its way up. That text
/// is not decoration: the Vulkan backend prints one line per device there,
/// naming fp16, the warp size and whether the card has matrix cores, and the
/// flash-attention rung of the sanity probe is decided on it. It used to be
/// read on the failure paths only and thrown away whenever the engine came up.
#[allow(clippy::too_many_arguments)]
fn spawn_engine_attempt(
    state: &AppState,
    binary: &Path,
    args: &[String],
    model_path: &str,
    port: u16,
    ctx: Option<u32>,
    flags: AttemptFlags,
    backend_dir: Option<&Path>,
) -> Result<String, StartFailure> {
    log_cpu_features_once();
    // A stop that arrived between two attempts (the settle before a retry, a
    // restart of the sanity probe) found an empty slot and had nothing to
    // kill. It still means what it said, so nothing is spawned after it.
    if stop_was_requested(state) {
        return Err(stopped_on_request());
    }
    // The one line a support log has to carry. Everything the start depends on
    // is in the argv: model path, context size, layer count, cache types,
    // thread count, mlock/mmap flags, the vision file and the port.
    tracing::info!(
        target: "engine",
        port,
        ctx = ctx.unwrap_or_default(),
        model_bytes = std::fs::metadata(model_path).map(|m| m.len()).unwrap_or(0),
        command = %command_line(binary, args),
        "starting the LU Engine llama-server"
    );
    let mut cmd = Command::new(binary);
    // The key the engine answers to, in its environment (engine_key.rs).
    super::engine_key::apply(&mut cmd);
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
    // B2 fix (review-w2rust.md): apply_gpu_env can now shell out to
    // nvidia-smi (GPU-UUID resolution) instead of doing zero I/O, so the
    // lock is held only long enough to clone the small selection out --
    // never across the detection call, which would freeze the Hardware
    // tab's set_gpu_selection/get_gpu_selection (same mutex) for however
    // long that subprocess I/O takes.
    let gpu_selection = state.gpu_selection.lock().ok().map(|sel| sel.clone());
    if let Some(sel) = gpu_selection {
        crate::commands::gpu::apply_gpu_env(&mut cmd, &sel);
    }
    // K1 (3.0.1): point a dynamic-ISA sidecar (Windows/Linux) at its
    // ggml-cpu-*/ggml-vulkan companion libraries. No-op on mac / a static
    // build, see apply_engine_backend_dir.
    apply_engine_backend_dir(&mut cmd, backend_dir);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let why = os_error::english(&e);
            tracing::error!(target: "engine", port, reason = %why, "the LU Engine program could not be started at all");
            // K1-14 (3.0.1, review-longpath.md Auflage 3): a spawn failure
            // while the backend dir is STILL over the classic Windows
            // current-directory length limit despite apply_engine_backend_dir
            // having already tried the short-name fallback is, on the
            // evidence in BERICHT.md #63, almost always this same
            // install-path problem wearing a generic OS error number
            // (267/ERROR_DIRECTORY there). Name the likely cause in plain
            // English alongside the opaque OS wording rather than replacing
            // it; `why` still carries the actual code to search for. This
            // branch should rarely fire for THIS reason any more now that
            // apply_engine_backend_dir itself avoids handing a too-long path
            // to current_dir, but it costs nothing to keep as a second line
            // of defense (e.g. `UseAsIs` failing for an unrelated reason
            // while the dir happens to be long).
            let long_path_hint =
                if backend_dir.is_some_and(windows_backend_dir_too_long) { format!(" {}", long_install_path_hint()) } else { String::new() };
            return Err(StartFailure {
                died: true,
                port_taken: false,
                stderr: format!("Failed to spawn bundled engine: {why}{long_path_hint}"),
                exit_code: None,
                signal: None,
            })
        }
    };
    // Tie the engine to the app's lifetime BEFORE anything else can go wrong.
    // The graceful shutdown path in `AppState::shutdown_subprocesses` kills this
    // child on a normal quit, but nothing runs on a hard kill or a crash, and
    // this is the single most expensive orphan the app can leave: a whole GGUF
    // resident in VRAM with no owner left to free it. Proved on the Windows box
    // on 2026-08-29 (app terminated 09:48:19, lu-llama-server still holding
    // 3633 MiB afterwards). ComfyUI survived the same event correctly because
    // it was already in the job and the engine was not.
    tie_child_to_app_lifetime(child.id());
    let diagnostics = child.stderr.take().map(super::shell::drain);

    {
        let mut slot = state.bundled_engine.lock().unwrap();
        // Asked again with the slot held. A stop sets its mark BEFORE it takes
        // this lock, so it either finds the child parked here and kills it, or
        // its mark is already visible now. There is no order in which a child
        // is parked after a stop and left running.
        if stop_was_requested(state) {
            drop(slot);
            let _ = child.kill();
            let _ = child.wait();
            return Err(stopped_on_request());
        }
        *slot = Some(BundledEngine {
            child,
            model_path: model_path.to_string(),
            port,
            ctx,
            args: args.to_vec(),
            auto_layers: flags.auto_layers,
            cpu_fallback: flags.cpu_fallback,
            sanity_note: None,
            image_part_note: None,
        });
    }

    let outcome = wait_for_health_or_exit(state, port, health_timeout_for(model_path));
    match &outcome {
        HealthWait::Ready => {
            tracing::info!(target: "engine", port, "the health probe answered")
        }
        HealthWait::ChildExited { code, signal } => tracing::warn!(
            target: "engine",
            port,
            exit_code = code.map(|c| c.to_string()).unwrap_or_else(|| "none".into()),
            signal = signal.map(|s| s.to_string()).unwrap_or_else(|| "none".into()),
            "the LU Engine exited before it served"
        ),
        HealthWait::Stopped => {
            tracing::info!(target: "engine", port, "the LU Engine was stopped on request before it served")
        }
        HealthWait::TimedOut => tracing::warn!(
            target: "engine",
            port,
            budget_s = health_timeout_for(model_path).as_secs(),
            "the health budget ran out with the LU Engine still alive"
        ),
    }
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
            return Ok(diagnostics
                .map(|(buf, _)| super::shell::captured_text(&buf))
                .unwrap_or_default());
        }
        if stop_was_requested(state) {
            // Health answered and the stop came right behind it. Our child is
            // gone because it was asked to go, not because a stranger holds
            // the port.
            return Err(stopped_on_request());
        }
        let why = diagnostics
            .map(|(buf, _)| tail_lines(&super::shell::captured_text(&buf), 12))
            .unwrap_or_default();
        stop_engine_locked(state);
        return Err(StartFailure { died: true, port_taken: true, stderr: why, exit_code: None, signal: None });
    }
    if matches!(outcome, HealthWait::Stopped) {
        return Err(stopped_on_request());
    }

    let why = diagnostics
        .map(|(buf, _)| tail_lines(&super::shell::captured_text(&buf), 12))
        .unwrap_or_default();
    let (died, exit_code, signal) = match outcome {
        HealthWait::ChildExited { code, signal } => (true, code, signal),
        _ => (false, None, None),
    };
    stop_engine_locked(state);
    Err(StartFailure { died, port_taken: false, stderr: why, exit_code, signal })
}

/// What an attempt reports when it ended because the engine was stopped on
/// request. Not `died`: a death is what `start_after_stop` retries.
fn stopped_on_request() -> StartFailure {
    StartFailure { died: false, port_taken: false, stderr: String::new(), exit_code: None, signal: None }
}

/// Stop the managed engine, killing the child. Idempotent.
#[tauri::command]
pub async fn stop_bundled_engine(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // kill + wait on a server that is mid-load is not instant.
        let state = app.state::<AppState>();
        let was_running = stop_engine_on_request(&state);
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
        // Probed inside its own block so the lock is provably gone before the
        // match below, whose arms make a blocking /health call.
        let probe = {
            let mut guard = state.bundled_engine.lock().unwrap();
            // A handle whose process died is not a running engine (A15).
            live_sidecar(&mut guard)
        };
        match probe {
            Some(live) => serde_json::json!({
                "running": true,
                "healthy": engine_healthy(live.port),
                "port": live.port,
                // Model file size feeds the handoff's fits/doesn't-fit call
                // (GH #85): a GGUF's on-disk size is a close proxy for its
                // VRAM footprint at full offload.
                // The image part is loaded next to the weights, so it counts.
                "modelBytes": std::fs::metadata(&live.model_path).map(|m| m.len()).unwrap_or(0) + live.image_part_bytes,
                "model_path": live.model_path,
                "ctx": live.ctx,
                // Where this engine computes, and how much of the model the
                // card really took (3.0.0 leftover). `start_bundled_engine`
                // answered `cpuOnly` once, in the return value of the call
                // that started it, and nothing kept it: the fallback was a
                // fact about the running process that no surface could ask
                // about afterwards, and a user who came back to the window
                // five minutes later found an engine that looked ordinary and
                // ran at a tenth of the speed.
                "cpuOnly": live.cpu_fallback,
                "gpuLayers": live.gpu_layers,
                // The sanity probe's verdict about THIS process (bug a). The
                // start call answered it once; the status keeps it, so the
                // standing line can say why the card was taken away, and
                // why an engine that kept its layers restarted at all.
                "sanityNote": live.sanity_note,
                // Why this model came up without its image part: no room on
                // the card, or the engine refused the part. Null on every
                // start that loaded it, and on a model that has none.
                "imageNote": live.image_part_note,
            }),
            None => serde_json::json!({
                "running": false,
                "healthy": false,
                "port": DEFAULT_ENGINE_PORT,
                "model_path": null,
                "ctx": null,
                "cpuOnly": false,
                "gpuLayers": null,
                "sanityNote": null,
                "imageNote": null,
            }),
        }
    })
    .await
    .map_err(|e| format!("Engine status task failed to run: {e}"))
}

/// Swap the loaded model: stop the current process and start `model_path`.
/// Thin wrapper over `start_bundled_engine` (which already stops a mismatched
/// model), kept as a distinct command so the intent reads clearly at the call
/// site. The port is chosen fresh, starting at the default (A15).
#[tauri::command]
pub async fn swap_bundled_model(
    app: AppHandle,
    model_path: String,
    tuning: Option<EngineTuning>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // No port is passed on purpose. This used to hand back the port the
        // engine was already on, which turned a one-off collision into a
        // permanent move: every restart started its walk at the fallback port
        // and 8127 was never asked about again (A15). The walk starts at the
        // default and steps aside only for a port that is genuinely taken.
        start_bundled_engine_blocking(&app, &state, model_path, tuning, None)
    })
    .await
    .map_err(|e| format!("Engine swap task failed to run: {e}"))?
}

/// Which folders `list_bundled_models` walks, in priority order: the app
/// models dir first, then whatever the user named under Model Storage.
///
/// A blank entry, a duplicate, and the app dir named a second time are all
/// dropped here, so the caller can hand the setting over raw.
pub(crate) fn bundled_scan_dirs(app_dir: &Path, extra: &[String]) -> Vec<PathBuf> {
    let mut out = vec![app_dir.to_path_buf()];
    // Windows paths arrive with a drive letter and backslashes and are
    // compared case-insensitively; `G:\AI\Models` and `g:/ai/models\` are one
    // folder. PathBuf does not know that, so the key is normalised by hand.
    //
    // The case fold is NOT applied on Linux. `/mnt/Models` and `/mnt/models`
    // are two different folders on ext4, and folding them would silently drop
    // one of the two from the scan. Windows and a default macOS volume are
    // case-insensitive, so there the fold is what stops one folder from being
    // walked twice under two spellings.
    let fold_case = !cfg!(target_os = "linux");
    let key = |p: &Path| {
        let normalised = p
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string();
        if fold_case { normalised.to_lowercase() } else { normalised }
    };
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    seen.insert(key(app_dir));
    for raw in extra {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = PathBuf::from(trimmed);
        if seen.insert(key(&path)) {
            out.push(path);
        }
    }
    out
}

/// List `*.gguf` files in the built-in models dir AND in every folder the user
/// named under Model Storage, marking the one currently loaded. Used by the
/// frontend instead of `/v1/models` (which would only report the single loaded
/// model).
// ASYNC + spawn_blocking: a SYNCHRONOUS Tauri command runs on the MAIN thread.
// The State borrow cannot cross into the blocking pool, so the handle is
// re-resolved there from the AppHandle (same pattern as engine.rs/whisper.rs).
#[tauri::command]
pub async fn list_bundled_models(
    app: tauri::AppHandle,
    extra_dirs: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        list_bundled_models_blocking(&state, &extra_dirs.unwrap_or_default())
    })
    .await
    .map_err(|e| format!("list_bundled_models task: {e}"))?
}

/// Which files go when the user deletes an LU Engine row: the GGUF itself, or
/// every part of a gguf-split set, and only inside a folder the listing reads
/// (the app's own models dir, or one named under Model Storage).
///
/// .dan_48 (help chat, 2026-09-05, 2.6.7, GTX 1660 Ti with 6 GB): the
/// Installed list had a bin on Ollama rows and none on LU Engine rows, and
/// nothing on the page said where the file was, so a model LU had downloaded
/// could neither be deleted nor found. The path is judged after canonicalize,
/// so a `..` that walks out of the folder is refused by where it lands.
pub(crate) fn gguf_delete_plan(path: &Path, roots: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("gguf")) {
        return Err("Only GGUF model files can be deleted here.".to_string());
    }
    let file = std::fs::canonicalize(path)
        .map_err(|e| format!("That model file could not be found: {}", os_error::english(&e)))?;
    let inside = roots
        .iter()
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .any(|r| file.starts_with(&r));
    if !inside {
        return Err(
            "LU only deletes models inside its own models folder or a folder named under Model Storage.".to_string(),
        );
    }
    let dir = file.parent().ok_or("That model file has no folder.")?.to_path_buf();
    let stem = file.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    // The image part goes with its model. It is named after the model (after
    // the first part of a split one), it is listed nowhere, and left behind it
    // would be several hundred megabytes that belong to nothing.
    let with_part = |mut files: Vec<PathBuf>| {
        if let Some(first) = files.first() {
            let part = mmproj_sibling_path(&first.to_string_lossy());
            if part.is_file() {
                files.push(part);
            }
        }
        files
    };
    let Some((base, _, total)) = split_shard_stem(stem) else {
        return Ok(with_part(vec![file]));
    };
    // A split set is one model: every sibling with the same base and total
    // goes along, whichever part the row pointed at, both digit widths.
    let mut parts: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| format!("Could not read the model folder: {}", os_error::english(&e)))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("gguf")))
        .filter(|p| {
            p.file_stem()
                .and_then(|s| s.to_str())
                .and_then(split_shard_stem)
                .is_some_and(|(b, _, t)| b == base && t == total)
        })
        .collect();
    parts.sort();
    Ok(with_part(parts))
}

/// Delete an LU Engine row's file(s). The loaded model is refused: on Windows
/// the mapped file cannot be removed while the engine holds it, and a delete
/// that half works is worse than one that says why. The frontend stops the
/// engine first when the row is the active one.
#[tauri::command]
pub async fn delete_bundled_model(
    app: tauri::AppHandle,
    path: String,
    extra_dirs: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let loaded = state
            .bundled_engine
            .lock()
            .unwrap()
            .as_ref()
            .map(|e| e.model_path.clone());
        let same = |a: &str, b: &str| {
            a == b
                || matches!(
                    (std::fs::canonicalize(a), std::fs::canonicalize(b)),
                    (Ok(x), Ok(y)) if x == y
                )
        };
        if loaded.as_deref().is_some_and(|l| same(l, &path)) {
            return Err(
                "This model is loaded in the LU Engine right now. Stop the engine or switch to another model, then delete it.".to_string(),
            );
        }
        let roots = bundled_scan_dirs(&builtin_models_dir()?, &extra_dirs.unwrap_or_default());
        let files = gguf_delete_plan(Path::new(&path), &roots)?;
        let mut bytes = 0u64;
        for f in &files {
            bytes += std::fs::metadata(f).map(|m| m.len()).unwrap_or(0);
            std::fs::remove_file(f)
                .map_err(|e| format!("Could not delete {}: {}", f.display(), os_error::english(&e)))?;
        }
        Ok(serde_json::json!({ "deleted": files.len(), "bytes": bytes }))
    })
    .await
    .map_err(|e| format!("delete_bundled_model task: {e}"))?
}

fn list_bundled_models_blocking(
    state: &AppState,
    extra_dirs: &[String],
) -> Result<serde_json::Value, String> {
    let dir = builtin_models_dir()?;
    // The loaded model, and whether its process was started with the image
    // part: what the engine can show a picture right now is a fact about the
    // process, not about the folder.
    let (loaded, loaded_sees) = {
        let guard = state.bundled_engine.lock().unwrap();
        (
            guard.as_ref().map(|e| e.model_path.clone()),
            guard.as_ref().is_some_and(|e| image_part_in(&e.args).is_some()),
        )
    };
    let dirs = bundled_scan_dirs(&dir, extra_dirs);
    let roots: Vec<ScanRoot> = dirs
        .iter()
        .enumerate()
        .map(|(i, d)| ScanRoot {
            dir: d.as_path(),
            max_depth: if i == 0 { MAX_SCAN_DEPTH } else { MAX_CUSTOM_SCAN_DEPTH },
        })
        .collect();
    let outcome = scan_gguf_roots(&roots);
    let models: Vec<serde_json::Value> = outcome
        .models
        .into_iter()
        .map(|m| {
            let is_loaded = loaded.as_deref() == Some(m.path.as_str());
            // Trained context limit from the GGUF header (ENG-6c) — the ONLY
            // place it exists; /props and /v1/models don't carry it. None on
            // any parse hiccup so a weird file can never break the listing.
            let ctx_train = crate::commands::gguf::context_length(&m.path);
            // Asked once: without the part under our own name this reads the
            // folder, and the list holds one entry per model in it.
            let image_part = model_can_see_images(&m.path);
            serde_json::json!({
                "name": m.name,
                "path": m.path,
                "size": m.size,
                "loaded": is_loaded,
                "ctx_train": ctx_train,
                // Can the engine show this model a picture? For the model that
                // is loaded: was it started with its image part (it is not
                // when the card had no room, or when the part arrived after
                // the start). For every other model: does the part lie next
                // to it, which is what the next start will pass along.
                "vision": if is_loaded { loaded_sees } else { image_part },
                // The part is on disk. Together with `vision` this tells a
                // model that cannot see from one that only has to be loaded
                // again, or loaded with a smaller context.
                "imagePart": image_part,
            })
        })
        .collect();
    // Every folder that was asked, app dir first, WITH how it fared. "No
    // models" and "I could not finish looking" are different answers, and the
    // Model Storage panel is where the user can act on the difference.
    let dir_rows: Vec<serde_json::Value> = dirs
        .iter()
        .zip(outcome.statuses.iter())
        .map(|(d, st)| {
            serde_json::json!({ "path": d.to_string_lossy(), "status": st.as_str() })
        })
        .collect();
    Ok(serde_json::json!({
        "dir": dir.to_string_lossy(),
        "dirs": dir_rows,
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
/// tells the user the honest way out. That way out only holds because the
/// import links into the LU Engine folder set under Model Storage when there
/// is one (see `import_dest_dir`): pointing that folder at the drive of the
/// file is then what makes the next import work.
pub(crate) fn import_model_file(src: &Path, dest_dir: &Path, name: &str) -> Result<PathBuf, String> {
    if !src.is_file() {
        return Err(format!("Source model not found: {}", src.display()));
    }
    let target = dest_dir.join(sanitize_model_file_name(name));
    if target.exists() {
        return Err(format!(
            "A model named {} already exists in the LU Engine models folder",
            target.file_name().and_then(|s| s.to_str()).unwrap_or("?")
        ));
    }
    std::fs::hard_link(src, &target).map_err(|e| {
        format!(
            "Could not link the model into the LU Engine folder ({e}). \
             Linking needs the model file and the LU Engine folder on the same drive. \
             Set the LU Engine folder (Settings, AI Backends, Model Storage) to a folder \
             on the drive of the model file and import again, or copy the file into the \
             LU Engine folder yourself."
        )
    })?;
    // A vision model without its projector loads and answers but cannot see, so
    // the projector comes along. Best effort: the model is already linked and
    // usable, and a missing projector is exactly what a text-only model looks
    // like. (Ollama sources are content-addressed blobs with no sibling to
    // find; those import text-only, which is why vision models are worth
    // pulling through Ollama itself.)
    if let Some(projector) = existing_mmproj(&src.to_string_lossy()) {
        let _ = std::fs::hard_link(&projector, mmproj_sibling_path(&target.to_string_lossy()));
    }
    Ok(target)
}

/// GGUFs found in local Ollama and LM Studio stores, ready to link into the
/// built-in engine. Candidates whose target file already exists are flagged
/// instead of hidden so the UI can show them as done.
#[tauri::command]
pub async fn list_importable_models(dest_dir: Option<String>) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        // Both folders count: a model imported before the LU Engine folder
        // was set sits in LU's own folder and is still listed from there.
        let dests = [import_dest_dir(dest_dir.as_deref())?, builtin_models_dir()?];
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
            let file = sanitize_model_file_name(&c.name);
            c.already_imported = dests.iter().any(|d| d.join(&file).exists());
        }
        Ok(serde_json::json!({ "candidates": all }))
    })
    .await
    .map_err(|e| format!("list_importable_models task: {e}"))?
}

/// Where an import lands: the LU Engine folder the user set under Model
/// Storage, else the app's own models dir. The set folder is where downloads
/// go and what the listing reads, and it is the one folder the user can move
/// to another drive, which is what the cross drive error tells him to do.
pub(crate) fn import_dest_dir(dest_dir: Option<&str>) -> Result<PathBuf, String> {
    match dest_dir.map(str::trim).filter(|d| !d.is_empty()) {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            std::fs::create_dir_all(&dir).map_err(|e| {
                format!("Create LU Engine folder {}: {}", dir.display(), os_error::english(&e))
            })?;
            Ok(dir)
        }
        None => builtin_models_dir(),
    }
}

/// D17: the system open dialog for one GGUF anywhere on the drive. Returns
/// the path, or None when the dialog was cancelled. The frontend hands the
/// path to `import_local_model`, the same link as the Ollama and LM Studio
/// import.
#[tauri::command]
pub async fn pick_gguf_file() -> Result<Option<String>, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_title("Choose a GGUF model")
        .add_filter("GGUF model", &["gguf", "GGUF"])
        .pick_file()
        .await;
    Ok(picked.map(|f| f.path().to_string_lossy().to_string()))
}

/// Link one candidate into the LU Engine folder (zero copy hard link).
/// The next list_bundled_models picks it up like any downloaded GGUF.
#[tauri::command]
pub async fn import_local_model(
    path: String,
    name: String,
    dest_dir: Option<String>,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let dest = import_dest_dir(dest_dir.as_deref())?;
        let target = import_model_file(Path::new(&path), &dest, &name)?;
        Ok(serde_json::json!({ "path": target.to_string_lossy() }))
    })
    .await
    .map_err(|e| format!("import_local_model task: {e}"))?
}

/// Kill the managed engine child if present. Returns whether one was running.
/// Takes the state lock internally; callers must not already hold it.
/// Drop the engine handle when the process behind it is gone, and say whether
/// that happened.
///
/// A15, Windows Nachlauf 02.09.: an engine killed from outside (Task Manager,
/// a crash, a driver reset) left the app showing "Engine running / Port: 8127"
/// for as long as anyone cared to watch. Collapsing the section did not help,
/// leaving Settings and coming back did not help; only an app restart cleared
/// it, and an engine that dies mid-session is exactly the moment the display
/// must not lie. `running` was read off the handle alone, and a handle outlives
/// its process. Reaping here also leaves the state fit for the next start,
/// which would otherwise find a stale child in the slot.
pub(crate) fn reap_dead_engine(slot: &mut Option<BundledEngine>) -> bool {
    let gone = match slot.as_mut() {
        // Ok(Some(status)) is an exited child; Ok(None) is a live one. An Err
        // means the question could not be asked, and a handle we cannot ask
        // about is not evidence of death, so it is left alone.
        Some(e) => matches!(e.child.try_wait(), Ok(Some(_))),
        None => false,
    };
    if gone {
        if let Some(mut e) = slot.take() {
            let _ = e.child.wait();
            // Said for both sidecars, so the wording names neither.
            tracing::warn!(target: "engine", port = e.port, "the sidecar is gone, clearing the handle");
        }
    }
    gone
}

/// What a status command should report for a sidecar slot: the port, the model
/// and the context, with a handle whose process is gone cleared first.
///
/// A15 review: the chat engine got the reaping and the embeddings server did
/// not, so an embed sidecar killed from outside kept answering "running" on
/// 8128 exactly the way the chat engine used to on 8127. Both status commands
/// go through this one function now, so the two cannot drift apart again.
/// What a live sidecar is, in the words its status answers need.
///
/// A tuple until the CPU fallback had to be reported. Five values read as
/// `(p, _, _, _, _)` at a call site, which is a shape nobody can check against
/// the thing it describes, so they have names.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LiveSidecar {
    pub port: u16,
    pub model_path: String,
    pub ctx: Option<u32>,
    /// The app took the graphics card away by itself after a start died.
    pub cpu_fallback: bool,
    /// The `-ngl` the process really carries, `None` when it asked for all of
    /// them (`gpu_layers_reported`).
    pub gpu_layers: Option<u32>,
    /// The sentence the sanity probe left behind (`BundledEngine::sanity_note`).
    pub sanity_note: Option<&'static str>,
    /// Why this engine runs without its image part, when it does.
    pub image_part_note: Option<&'static str>,
    /// Size of the image part this process loaded, 0 without one.
    pub image_part_bytes: u64,
}

pub(crate) fn live_sidecar(slot: &mut Option<BundledEngine>) -> Option<LiveSidecar> {
    reap_dead_engine(slot);
    slot.as_ref().map(|e| LiveSidecar {
        port: e.port,
        model_path: e.model_path.clone(),
        ctx: e.ctx,
        cpu_fallback: e.cpu_fallback,
        gpu_layers: gpu_layers_reported(&e.args),
        sanity_note: e.sanity_note,
        image_part_note: e.image_part_note,
        image_part_bytes: image_part_in(&e.args)
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .unwrap_or(0),
    })
}

// ── The watch that tells the UI a sidecar died ───────────────────────────────
//
// A16, Windows counter-check 02.09.: `reap_dead_engine` was only ever reached
// by someone ASKING, and Settings asks once, when the section is mounted. So
// killing lu-llama-server with the panel open left "Engine running / Port:
// 8127" on screen for 30 seconds and counting; folding the section and
// unfolding it was the only thing that corrected it, because that asked again.
// Reaping on a timer turns the same knowledge into something the app says by
// itself, and the event it emits is what lets the panel be right without
// polling the backend into the ground.

/// The event a sidecar's death raises. Payload: `{ sidecar, port }`.
pub const SIDECAR_GONE_EVENT: &str = "lu-sidecar-gone";

/// Which sidecar the event is about. The chat engine has a display in
/// Settings; the embeddings server has none, and is reported anyway so a
/// future display, or a log reader, gets the same answer for both.
pub(crate) const SIDECAR_ENGINE: &str = "engine";
pub(crate) const SIDECAR_EMBED: &str = "embed";

/// How often the watch looks.
///
/// The requirement is that the display is right within five seconds of a kill,
/// and the UI has its own poll behind this event, so the budget is shared. A
/// second and a half costs two `try_wait` calls and a mutex each, which is
/// nothing next to the health probe the status command already makes on every
/// poll, and leaves the worst case (the event lost, the poll doing the work)
/// comfortably inside the five.
pub(crate) const SIDECAR_WATCH_INTERVAL: Duration = Duration::from_millis(1500);

/// Reap one slot and, when something really was reaped, say which port it held.
///
/// Split out from the loop so the decision is testable without a Tauri app:
/// the port has to be read BEFORE the reap, because the reap is what throws
/// the handle away.
pub(crate) fn reaped_sidecar_port(slot: &mut Option<BundledEngine>) -> Option<u16> {
    let port = slot.as_ref().map(|e| e.port);
    if reap_dead_engine(slot) { port } else { None }
}

/// Start the watch. One thread for both sidecars, for the life of the app.
///
/// The two slots are locked one after the other and never together: everything
/// else in this file takes exactly one of them at a time, and a watch that took
/// both would be the only place in the process able to build a lock cycle.
pub fn spawn_sidecar_watch(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(SIDECAR_WATCH_INTERVAL);
            let state = app.state::<AppState>();
            let mut gone: Vec<(&'static str, u16)> = Vec::new();
            if let Ok(mut guard) = state.bundled_engine.lock() {
                if let Some(port) = reaped_sidecar_port(&mut guard) {
                    gone.push((SIDECAR_ENGINE, port));
                }
            }
            if let Ok(mut guard) = state.bundled_embed.lock() {
                if let Some(port) = reaped_sidecar_port(&mut guard) {
                    gone.push((SIDECAR_EMBED, port));
                }
            }
            for (sidecar, port) in gone {
                let _ = app.emit(SIDECAR_GONE_EVENT, serde_json::json!({
                    "sidecar": sidecar,
                    "port": port,
                }));
            }
        }
    });
}

/// Stop the engine because somebody outside the start asked for it: the
/// frontend's stop, the switch into Cloud, a render that needs the memory.
///
/// The mark is set BEFORE the child is taken, and it is set even when the slot
/// is empty: a start that is between two attempts has nothing parked, and it
/// must still not begin the next one.
pub(crate) fn stop_engine_on_request(state: &AppState) -> bool {
    state.engine_stop_requested.store(true, std::sync::atomic::Ordering::SeqCst);
    stop_engine_locked(state)
}

/// Kill and reap whatever is in the slot. The start's own stops (the old model
/// before a switch, a failed attempt, a restart of the sanity probe) use this
/// one, because none of them is a request to leave the engine empty.
fn stop_engine_locked(state: &AppState) -> bool {
    let mut guard = state.bundled_engine.lock().unwrap();
    if let Some(mut engine) = guard.take() {
        let _ = engine.child.kill();
        let _ = engine.child.wait();
        tracing::info!(target: "engine", port = engine.port, model = %engine.model_path, "the LU Engine was stopped");
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

    let embed_args = build_embed_args(&model_path, port);
    tracing::info!(
        target: "engine",
        port,
        command = %command_line(&binary, &embed_args),
        "starting the LU Engine embeddings server"
    );
    let mut cmd = Command::new(&binary);
    super::engine_key::apply(&mut cmd);
    cmd.args(&embed_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // B2 fix (review-w2rust.md): apply_gpu_env can now shell out to
    // nvidia-smi (GPU-UUID resolution) instead of doing zero I/O, so the
    // lock is held only long enough to clone the small selection out --
    // never across the detection call, which would freeze the Hardware
    // tab's set_gpu_selection/get_gpu_selection (same mutex) for however
    // long that subprocess I/O takes.
    let gpu_selection = state.gpu_selection.lock().ok().map(|sel| sel.clone());
    if let Some(sel) = gpu_selection {
        crate::commands::gpu::apply_gpu_env(&mut cmd, &sel);
    }
    // K1 (3.0.1): this is the same dynamic-ISA binary the chat engine spawns
    // (`spawn_engine_attempt`), so it needs the same companion-library
    // directory; see apply_engine_backend_dir.
    apply_engine_backend_dir(&mut cmd, resolve_engine_backend_dir(app).as_deref());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn embeddings server: {}", os_error::english(&e)))?;
    // Same orphan rule as the chat engine above.
    tie_child_to_app_lifetime(child.id());
    let diagnostics = child.stderr.take().map(super::shell::drain);

    *state.bundled_embed.lock().unwrap() = Some(BundledEngine {
        child,
        model_path: model_path.clone(),
        port,
        // No --ctx-size on the embed server; args recorded for symmetry (its
        // idempotence check stays model_path-based, embeds have no tuning).
        ctx: None,
        args: embed_args,
        // The embeddings server sends a fixed `-ngl 999` and nothing measures
        // anything for it: these models are a few hundred MiB and fit on
        // whatever is there, so there is also no GPU start for it to lose.
        auto_layers: false,
        cpu_fallback: false,
        sanity_note: None,
        image_part_note: None,
    });

    if let Err(e) = wait_for_health(port, health_timeout_for(&model_path)) {
        let why = diagnostics
            .map(|(buf, _)| tail_lines(&super::shell::captured_text(&buf), 12))
            .unwrap_or_default();
        stop_embed_locked(state);
        return Err(embed_start_failure_message(&e, &why));
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
            "Port {port} answers health checks, but the embeddings server this app just started exited immediately. Another llama-server (likely left over from a previous session or crash) is occupying the port. Quit that process or reboot, then try again.{}",
            if why.is_empty() { String::new() } else { format!("\n\n{why}") }
        ));
    }

    tracing::info!(target: "engine", port, "the LU Engine embeddings server is serving");
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
        // every other engine command queue behind the status poll. The guard is
        // dropped at the end of THIS block, which is the whole point of the
        // block; a `match` on the lock expression itself would hold it for the
        // length of every arm, and one of those arms probes /health.
        let probe = {
            let mut guard = state.bundled_embed.lock().unwrap();
            // Same as the chat engine: a killed sidecar is not a running one.
            live_sidecar(&mut guard)
        };
        match probe {
            Some(live) => serde_json::json!({
                "running": true,
                "healthy": engine_healthy(live.port),
                "port": live.port,
                "model_path": live.model_path,
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
        tracing::info!(target: "engine", port = embed.port, "the LU Engine embeddings server was stopped");
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    // .dan_48 (help chat, 2026-09-05): the bin on an LU Engine row. What it may
    // and may not take with it is decided here, on real files.
    #[test]
    fn the_delete_plan_takes_the_gguf_or_the_whole_split_and_nothing_outside_the_folder() {
        let dir = std::env::temp_dir().join(format!("lu-engine-delete-{}", std::process::id()));
        let outside = std::env::temp_dir().join(format!("lu-engine-delete-outside-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
        let inside = dir.join("inside");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let single = inside.join("a.gguf");
        let text = inside.join("notes.txt");
        let stranger = outside.join("b.gguf");
        std::fs::write(&single, b"x").unwrap();
        std::fs::write(&text, b"x").unwrap();
        std::fs::write(&stranger, b"x").unwrap();
        for i in 1..=3 {
            std::fs::write(inside.join(format!("big-0000{i}-of-00003.gguf")), b"x").unwrap();
        }
        std::fs::write(inside.join("other-00001-of-00002.gguf"), b"x").unwrap();
        let roots = vec![dir.clone()];

        assert_eq!(gguf_delete_plan(&single, &roots).unwrap(), vec![std::fs::canonicalize(&single).unwrap()]);
        assert!(gguf_delete_plan(&text, &roots).unwrap_err().contains("GGUF"));
        assert!(gguf_delete_plan(&stranger, &roots).unwrap_err().contains("Model Storage"));
        // whichever part the row pointed at, the set goes, and only that set
        let shards = gguf_delete_plan(&inside.join("big-00002-of-00003.gguf"), &roots).unwrap();
        assert_eq!(shards.len(), 3, "{shards:?}");
        assert!(shards.iter().all(|p| p.file_name().unwrap().to_str().unwrap().starts_with("big-")));
        // a path that walks out of the folder is judged by where it lands
        let sneaky = inside.join("..").join("..").join(outside.file_name().unwrap()).join("b.gguf");
        assert!(gguf_delete_plan(&sneaky, &roots).is_err());
        // a file that is gone already is not a plan
        assert!(gguf_delete_plan(&inside.join("missing.gguf"), &roots).unwrap_err().contains("could not be found"));

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn deleting_a_model_takes_its_image_part_along_and_no_other() {
        let dir = tempfile::tempdir().unwrap();
        let model = dir.path().join("Qwen3.5-9B.Q4_K_M.gguf");
        let part = dir.path().join("Qwen3.5-9B.Q4_K_M.mmproj.gguf");
        let other_part = dir.path().join("Other.Q4_K_M.mmproj.gguf");
        for f in [&model, &part, &other_part] {
            std::fs::write(f, b"x").unwrap();
        }
        for i in 1..=2 {
            std::fs::write(dir.path().join(format!("big-0000{i}-of-00002.gguf")), b"x").unwrap();
        }
        // A split model names its part after its first file.
        let split_part = dir.path().join("big-00001-of-00002.mmproj.gguf");
        std::fs::write(&split_part, b"x").unwrap();
        let roots = vec![dir.path().to_path_buf()];
        let canon = |p: &Path| std::fs::canonicalize(p).unwrap();

        assert_eq!(gguf_delete_plan(&model, &roots).unwrap(), vec![canon(&model), canon(&part)]);
        let split = gguf_delete_plan(&dir.path().join("big-00002-of-00002.gguf"), &roots).unwrap();
        assert_eq!(split.len(), 3, "{split:?}");
        assert_eq!(split.last().unwrap(), &canon(&split_part));
        assert!(!split.contains(&canon(&other_part)));
    }

    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

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
        let with = build_server_args("/m.gguf", &EngineTuning::default(), 8127, Some("/data/kv-slots"), None, None);
        let tail: Vec<&str> = with.iter().rev().take(2).map(String::as_str).collect();
        assert_eq!(tail, vec!["/data/kv-slots", "--slot-save-path"]);
        let without = build_server_args("/m.gguf", &EngineTuning::default(), 8127, None, None, None);
        assert!(!without.iter().any(|a| a == "--slot-save-path"));
    }

    #[test]
    fn default_tuning_args_match_legacy_shape() {
        // Pin: absent/default tuning must produce EXACTLY the argv the app has
        // shipped since 2.5.7 — expert settings are opt-in, never a drift.
        let args = build_server_args("/models/qwen.gguf", &EngineTuning::default(), 8127, None, None, None);
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
            None,
        );
        let at = with.iter().position(|a| a == "--mmproj").expect("--mmproj missing");
        assert_eq!(with[at + 1], "/models/qwen3.8.mmproj.gguf");
        // A Qwen that sees gets a floor for the size of an image.
        let floor = with.iter().position(|a| a == "--image-min-tokens").expect("--image-min-tokens missing");
        assert_eq!(with[floor + 1], "1024");
        let gemma = build_server_args("/models/gemma-4.gguf", &EngineTuning::default(), 8127, None, Some("/models/gemma-4.mmproj.gguf"), None);
        assert!(gemma.iter().any(|a| a == "--mmproj") && !gemma.iter().any(|a| a == "--image-min-tokens"));
        // Negative control: a model without a projector keeps the legacy argv,
        // so a text-only model can never gain a flag it cannot honour.
        let without = build_server_args("/models/qwen3.8.gguf", &EngineTuning::default(), 8127, None, None, None);
        assert!(!without.iter().any(|a| a == "--mmproj"));
        // The projector and the floor for the size of an image: two flags, two values.
        assert_eq!(without.len(), with.len() - 4);
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
            None,
        );
        let tail: Vec<&str> = args.iter().rev().take(2).map(String::as_str).collect();
        assert_eq!(tail, vec!["/data/kv-slots", "--slot-save-path"]);
        assert!(args.iter().any(|a| a == "--mmproj"));
    }

    #[test]
    fn vision_is_reported_from_the_projector_on_disk() {
        // Nebenbefund N3 of the D1 counter-check: the model list has to answer
        // "can this model read images" from the SAME file the engine passes as
        // --mmproj, not from the model name.
        let dir = tempfile::tempdir().unwrap();
        let vision = dir.path().join("Qwen3.8-27B-UD-Q4_K_M.gguf");
        std::fs::write(&vision, b"weights").unwrap();
        std::fs::write(dir.path().join("Qwen3.8-27B-UD-Q4_K_M.mmproj.gguf"), b"projector").unwrap();
        assert!(model_can_see_images(&vision.to_string_lossy()));

        // Negative control: a gemma3 by NAME with no projector next to it. This
        // is the exact file the counter-check ran, and the old name heuristic
        // called it vision-capable.
        let text_only = dir.path().join("gemma-3-4b-it-abliterated-Q4_K_M.gguf");
        std::fs::write(&text_only, b"weights").unwrap();
        assert!(!model_can_see_images(&text_only.to_string_lossy()));

        // Negative control: a projector belonging to ANOTHER model in the same
        // flat folder must not lend its vision to this one.
        assert!(!model_can_see_images(&dir.path().join("nothing-here.gguf").to_string_lossy()));
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

    /// A folder holding these GGUFs. The head is a real one, so the same files
    /// pass the header check a start runs.
    fn gguf_folder(names: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let mut head = b"GGUF".to_vec();
        head.extend_from_slice(&3u32.to_le_bytes());
        for name in names {
            std::fs::write(dir.path().join(name), &head).unwrap();
        }
        dir
    }

    /// The projector a model in `dir` gets, as a bare file name.
    fn projector_of(dir: &tempfile::TempDir, model: &str) -> Option<String> {
        existing_mmproj(&dir.path().join(model).to_string_lossy())
            .map(|p| Path::new(&p).file_name().unwrap().to_string_lossy().to_string())
    }

    #[test]
    fn a_stray_projector_does_not_hang_itself_on_every_model() {
        // GH discussion 67, and the reason the rule is narrow: the models
        // folder is flat. One hand-placed mmproj-F16.gguf next to two models
        // belongs to neither by name, so neither may be called able to see.
        let dir = gguf_folder(&["gemma-3-4b-it-Q4_K_M.gguf", "Nemo-12B-Q4_K_M.gguf", "mmproj-F16.gguf"]);
        assert_eq!(projector_of(&dir, "gemma-3-4b-it-Q4_K_M.gguf"), None);
        assert_eq!(projector_of(&dir, "Nemo-12B-Q4_K_M.gguf"), None);
        // A file that is not there owns nothing either.
        assert_eq!(projector_of(&dir, "nothing-here.gguf"), None);
    }

    #[test]
    fn one_model_and_one_projector_in_a_folder_belong_together() {
        // The names the big publishers ship that say nothing about the model.
        for projector in ["mmproj-F16.gguf", "mmproj-model-f16.gguf", "mmproj-model-f16-4B.gguf", "MMPROJ-BF16.GGUF"] {
            let dir = gguf_folder(&["gemma-3-4b-it-Q4_K_M.gguf", projector]);
            assert_eq!(projector_of(&dir, "gemma-3-4b-it-Q4_K_M.gguf").as_deref(), Some(projector));
        }
        // Two quants of the one model are still one model.
        let dir = gguf_folder(&["gemma-3-4b-it-Q4_K_M.gguf", "gemma-3-4b-it-Q8_0.gguf", "mmproj-model-f16.gguf"]);
        assert_eq!(projector_of(&dir, "gemma-3-4b-it-Q4_K_M.gguf").as_deref(), Some("mmproj-model-f16.gguf"));
        assert_eq!(projector_of(&dir, "gemma-3-4b-it-Q8_0.gguf").as_deref(), Some("mmproj-model-f16.gguf"));
        // NEGATIVE CONTROL: a look-alike is another model, and then nobody
        // gets the projector.
        let dir = gguf_folder(&["gemma-3-4b-it-Q4_K_M.gguf", "gemma-3-4b-it-abliterated-Q4_K_M.gguf", "mmproj-model-f16.gguf"]);
        assert_eq!(projector_of(&dir, "gemma-3-4b-it-Q4_K_M.gguf"), None);
        assert_eq!(projector_of(&dir, "gemma-3-4b-it-abliterated-Q4_K_M.gguf"), None);
        // NEGATIVE CONTROL: a part in our own naming belongs to the file it
        // names, also when that file is gone and one other model is left.
        let dir = gguf_folder(&["Nemo-12B-Q4_K_M.gguf", "gemma-3-4b-it-Q4_K_M.mmproj.gguf"]);
        assert_eq!(projector_of(&dir, "Nemo-12B-Q4_K_M.gguf"), None);
    }

    #[test]
    fn a_projector_that_names_its_model_finds_it_in_a_full_folder() {
        // The three shapes in use upstream, each next to a model it does not
        // belong to and a stray projector that names nothing.
        for (model, projector) in [
            ("google_gemma-3-4b-it-Q4_K_M.gguf", "mmproj-google_gemma-3-4b-it-f16.gguf"),
            ("Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf", "mmproj-Qwen2.5-VL-7B-Instruct-Q8_0.gguf"),
            ("Qwen2-VL-7B-Instruct-abliterated.Q4_K_M.gguf", "Qwen2-VL-7B-Instruct-abliterated.mmproj-fp16.gguf"),
            ("Qwen2-VL-7B-Instruct-abliterated.i1-Q4_K_M.gguf", "Qwen2-VL-7B-Instruct-abliterated.mmproj-Q8_0.gguf"),
            ("llava-llama-3-8b-v1_1-int4.gguf", "llava-llama-3-8b-v1_1-mmproj-f16.gguf"),
            // case of name and extension is the publisher's and the user's
            ("FOO-BAR-q4_k_m.GGUF", "MMPROJ-foo-bar-F16.Gguf"),
        ] {
            let dir = gguf_folder(&[model, projector, "Nemo-12B-Q4_K_M.gguf", "mmproj-F16.gguf"]);
            assert_eq!(projector_of(&dir, model).as_deref(), Some(projector), "{model}");
            assert_eq!(projector_of(&dir, "Nemo-12B-Q4_K_M.gguf"), None, "{model}");
        }
        // NEGATIVE CONTROL: a longer name is another model, not this one.
        let dir = gguf_folder(&[
            "gemma-3-4b-it-abliterated-Q4_K_M.gguf",
            "gemma-3-4b-it-Q4_K_M.gguf",
            "mmproj-gemma-3-4b-it-f16.gguf",
        ]);
        assert_eq!(projector_of(&dir, "gemma-3-4b-it-abliterated-Q4_K_M.gguf"), None);
        assert_eq!(projector_of(&dir, "gemma-3-4b-it-Q4_K_M.gguf").as_deref(), Some("mmproj-gemma-3-4b-it-f16.gguf"));
    }

    #[test]
    fn an_ambiguous_projector_is_left_alone() {
        // Two projectors in one folder means guessing; a wrong image tower is
        // worse than a model that is honestly text-only.
        let dir = gguf_folder(&["m.gguf", "mmproj-F16.gguf", "mmproj-BF16.gguf"]);
        assert_eq!(projector_of(&dir, "m.gguf"), None);
        // Two that both carry the model's name are a choice just the same.
        let dir = gguf_folder(&["m-Q4_K_M.gguf", "mmproj-m-f16.gguf", "mmproj-m-Q8_0.gguf"]);
        assert_eq!(projector_of(&dir, "m-Q4_K_M.gguf"), None);
        // One by name beats one that names nothing.
        let dir = gguf_folder(&["m-Q4_K_M.gguf", "mmproj-m-f16.gguf", "mmproj-F16.gguf"]);
        assert_eq!(projector_of(&dir, "m-Q4_K_M.gguf").as_deref(), Some("mmproj-m-f16.gguf"));
        // And our own naming wins over all of them.
        let dir = gguf_folder(&["m.gguf", "mmproj-F16.gguf", "mmproj-BF16.gguf", "mmproj-m-f16.gguf", "m.mmproj.gguf"]);
        assert_eq!(projector_of(&dir, "m.gguf").as_deref(), Some("m.mmproj.gguf"));
    }

    #[test]
    fn the_rule_reads_names_the_same_on_every_system() {
        // No disk in this one: Windows hands over names in whatever case the
        // user typed, and a case-sensitive disk can hold what Windows cannot.
        let names = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let folder = names(&["Model-Q4_K_M.GGUF", "MODEL-Q4_K_M.MMPROJ.GGUF", "other.gguf"]);
        assert_eq!(pick_projector("Model-Q4_K_M.GGUF", &folder), Some("MODEL-Q4_K_M.MMPROJ.GGUF"));
        assert_eq!(pick_projector("other.gguf", &folder), None);
        // Two spellings of our own part can only exist on a case-sensitive
        // disk, and then it is a choice again.
        let twice = names(&["m.gguf", "m.mmproj.gguf", "M.MMPROJ.gguf"]);
        assert_eq!(pick_projector("m.gguf", &twice), None);
        // A Windows path goes in whole and the folder part does not matter
        // to the name rule.
        assert_eq!(
            mmproj_sibling_path("C:\\Models\\a.Gguf").to_string_lossy().replace('\\', "/").rsplit('/').next(),
            Some("a.mmproj.gguf")
        );
    }

    #[test]
    fn what_the_list_calls_seeing_is_what_the_start_passes_along() {
        // One question, asked twice: the model list reports `vision`, the
        // start puts --mmproj on the argv. Every folder shape above has to
        // get the same answer from both, or the app shows a model as seeing
        // that then starts blind (or the other way round).
        for (folder, model) in [
            (vec!["a-Q4_K_M.gguf", "a-Q4_K_M.mmproj.gguf"], "a-Q4_K_M.gguf"),
            (vec!["a-Q4_K_M.gguf", "mmproj-F16.gguf"], "a-Q4_K_M.gguf"),
            (vec!["a-Q4_K_M.gguf", "b-Q4_K_M.gguf", "mmproj-a-f16.gguf"], "a-Q4_K_M.gguf"),
            (vec!["a-Q4_K_M.gguf", "b-Q4_K_M.gguf", "mmproj-a-f16.gguf"], "b-Q4_K_M.gguf"),
            (vec!["a-Q4_K_M.gguf", "b-Q4_K_M.gguf", "mmproj-F16.gguf"], "a-Q4_K_M.gguf"),
            (vec!["a-Q4_K_M.gguf", "mmproj-F16.gguf", "mmproj-BF16.gguf"], "a-Q4_K_M.gguf"),
            (vec!["a-Q4_K_M.gguf"], "a-Q4_K_M.gguf"),
        ] {
            let dir = gguf_folder(&folder);
            let path = dir.path().join(model).to_string_lossy().to_string();
            let started_with = precheck_model_files(&path).unwrap();
            assert_eq!(model_can_see_images(&path), started_with.is_some(), "{folder:?} {model}");
            let args = build_server_args(&path, &EngineTuning::default(), 8127, None, started_with.as_deref(), None);
            let on_argv = args.iter().position(|a| a == "--mmproj").map(|at| args[at + 1].clone());
            assert_eq!(on_argv, existing_mmproj(&path), "{folder:?} {model}");
        }
    }

    #[test]
    fn a_hand_placed_projector_gets_the_same_header_check() {
        // The net under the wider rule: a file picked up under its upstream
        // name is read before anything is stopped, exactly like our own.
        let dir = gguf_folder(&["a-Q4_K_M.gguf"]);
        std::fs::write(dir.path().join("mmproj-a-f16.gguf"), b"<!DOCTYPE html>").unwrap();
        let reason = precheck_model_files(&dir.path().join("a-Q4_K_M.gguf").to_string_lossy()).unwrap_err();
        assert!(reason.starts_with("The vision file next to this model "), "{reason}");
        assert!(reason.contains("mmproj-a-f16"), "{reason}");
    }

    #[test]
    fn projectors_are_not_offered_as_models() {
        assert!(is_projector_file("Qwen3.8-27B-UD-Q4_K_M.mmproj.gguf"));
        assert!(is_projector_file("mmproj-F16.gguf"));
        assert!(is_projector_file("mmproj-model-bf16.gguf"));
        // upstream names that carry the model in front
        assert!(is_projector_file("Qwen2-VL-7B-Instruct-abliterated.mmproj-fp16.gguf"));
        assert!(is_projector_file("llava-llama-3-8b-v1_1-mmproj-f16.gguf"));
        assert!(is_projector_file("X.MMPROJ.GGUF"));
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
        let args = build_server_args("/m.gguf", &tuning, 8127, None, None, None);
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
    fn the_log_line_of_a_start_carries_every_resolved_value() {
        // Bug o, positive control. A support log is worth having only if the
        // start it describes can be reconstructed from it, so every knob the
        // user can turn has to be IN the rendered line, with the value the
        // start resolved it to and not the value the settings file wrote.
        let tuning = EngineTuning {
            ctx: 0, // resolves to 8192
            flash_attn: "on".into(),
            cache_type_k: "q8_0".into(),
            cache_type_v: "q4_0".into(),
            threads: 6,
            gpu_layers: 24,
            mlock: true,
            no_mmap: true,
        };
        let args = build_server_args(
            "/Users/me/Library/Application Support/LU/models/Nemo 12B.gguf",
            &tuning,
            8129,
            Some("/slots"),
            Some("/models/Nemo 12B.mmproj.gguf"),
            None,
        );
        let line = command_line(Path::new("/opt/lu/lu-llama-server"), &args);

        for wanted in [
            "/opt/lu/lu-llama-server",
            "--port 8129",
            "--ctx-size 8192",
            "-ngl 24",
            "-fa on",
            "-ctk q8_0",
            "-ctv q4_0",
            "-t 6",
            "--mlock",
            "--no-mmap",
            "--slot-save-path /slots",
        ] {
            assert!(line.contains(wanted), "{wanted:?} missing from:\n{line}");
        }
        // A path with spaces stays ONE argument to the eye, or the reader of
        // the log counts two files where the start passed one.
        assert!(
            line.contains("-m \"/Users/me/Library/Application Support/LU/models/Nemo 12B.gguf\""),
            "{line}"
        );
        assert!(line.contains("--mmproj \"/models/Nemo 12B.mmproj.gguf\""), "{line}");
    }

    #[test]
    fn the_log_line_never_invents_a_flag_the_start_did_not_send() {
        // The negative control for the test above. A line that names flags the
        // argv does not carry sends the next reader hunting a setting nobody
        // made.
        let line = command_line(
            Path::new("/opt/lu/lu-llama-server"),
            &build_server_args("/m.gguf", &EngineTuning::default(), 8127, None, None, None),
        );
        for unwanted in ["-ctk", "-ctv", "-fa", "-t ", "--mlock", "--no-mmap", "--mmproj", "--slot-save-path"] {
            assert!(!line.contains(unwanted), "{unwanted:?} invented in:\n{line}");
        }
        assert!(line.contains("-ngl 999"), "{line}");
    }

    // ── Bugs u and a: how much of a model goes on the card ────────────────
    //
    // Every number below is a real one. None of them was measured on the
    // hardware that reported the bugs: there is no 2 GB and no 8 GB NVIDIA
    // card on this machine. What these tests prove is the arithmetic and the
    // direction of every rounding in it, not the effect on a reporter's box.

    /// A 3B Q4_K_M, the size class of the model behind GitHub 128.
    const THREE_B_Q4: u64 = 2_019_377_696;
    /// Its layer count.
    const THREE_B_BLOCKS: u32 = 28;
    /// A 12B IQ4_XS, the size class behind Discord ticket-0009.
    const TWELVE_B_IQ4: u64 = 7_300_000_000;
    const TWELVE_B_BLOCKS: u32 = 40;
    /// What a 2 GB card, an 8 GB RTX 4060 and a 12 GB RTX 3060 report.
    const CARD_2_GB: u64 = 2048 * 1024 * 1024;
    const CARD_8_GB: u64 = 8188 * 1024 * 1024;
    const CARD_12_GB: u64 = 12288 * 1024 * 1024;

    fn plan(model: u64, blocks: Option<u32>, vram: Option<u64>, ctx: u32) -> OffloadPlan {
        plan_free(model, blocks, vram, ctx, true)
    }

    /// R1-3: same as `plan`, with the free-vs-total flag exposed.
    fn plan_free(model: u64, blocks: Option<u32>, vram: Option<u64>, ctx: u32, free: bool) -> OffloadPlan {
        plan_offload(&OffloadInputs {
            model_bytes: model,
            block_count: blocks,
            vram_bytes: vram,
            ctx,
            free,
            image_part_bytes: 0,
        })
    }

    // ── The image part in the plan (October 2026) ───────────────────────────

    /// Qwen 3.5 9B Q4_K_M and its F16 image part, as the catalog states them.
    const NINE_B: u64 = 5_627_045_216;
    const NINE_B_PART: u64 = 918_166_080;

    fn plan_with_part(model: u64, part: u64, blocks: Option<u32>, vram: Option<u64>, ctx: u32) -> OffloadPlan {
        plan_offload(&OffloadInputs {
            model_bytes: model,
            block_count: blocks,
            vram_bytes: vram,
            ctx,
            free: true,
            image_part_bytes: part,
        })
    }

    #[test]
    fn a_model_and_its_image_part_that_fit_are_loaded_whole_and_together() {
        // The owner's test machine: a 9B with its part on a 12 GB card.
        let p = plan_with_part(NINE_B, NINE_B_PART, Some(32), Some(CARD_12_GB), 8192);
        assert_eq!(p.layers, None);
        assert!(p.with_image_part);
        assert!(p.why.contains("image part"), "{}", p.why);
    }

    #[test]
    fn a_part_that_would_push_the_model_off_the_card_is_left_out_and_the_model_stays_whole() {
        // The model with a 32k context needs about 9.9 GB and fits a card with
        // 10.2 GB free. The part needs 0.9 GB more than that leaves.
        let free = 10_400 * MIB;
        let alone = plan_with_part(NINE_B, 0, Some(32), Some(free), 32768);
        assert_eq!(alone.layers, None, "the model alone has to fit for this case: {}", alone.why);
        let p = plan_with_part(NINE_B, NINE_B_PART, Some(32), Some(free), 32768);
        // Every layer on the card, exactly as without a part: nothing moves to
        // the processor because of the image part.
        assert_eq!(p.layers, None);
        assert!(!p.with_image_part);
        assert!(p.why.contains("without image input"), "{}", p.why);
        // A smaller context makes room again, which is what the note advises.
        let smaller = plan_with_part(NINE_B, NINE_B_PART, Some(32), Some(free), 8192);
        assert!(smaller.with_image_part);
        assert_eq!(smaller.layers, None);
    }

    #[test]
    fn a_model_larger_than_the_card_keeps_its_part_and_pays_for_it_in_layers() {
        // A 27B at 16.5 GB on a 12 GB card is shared with the processor
        // either way. The part stays and costs layers, it is not dropped.
        let model = 17_716_740_096_u64;
        let part = 927_607_488_u64;
        let without = plan_with_part(model, 0, Some(64), Some(CARD_12_GB), 8192);
        let with = plan_with_part(model, part, Some(64), Some(CARD_12_GB), 8192);
        assert!(with.with_image_part);
        let (a, b) = (without.layers.unwrap(), with.layers.unwrap());
        assert!(b < a && b > 0, "the part costs layers and leaves some: {a} without, {b} with");
        assert!(with.why.contains("set aside for the image part"), "{}", with.why);
    }

    #[test]
    fn a_card_that_cannot_hold_the_part_at_all_loads_without_it() {
        // 2 GB card, 512 MiB reserve: 1.5 GB of budget, and the part of the
        // Qwen3-VL 8B is 1.1 GB. It "fits" the budget, so it stays.
        let vl = plan_with_part(5_000_000_000, 1_159_030_336, Some(36), Some(CARD_2_GB), 8192);
        assert!(vl.with_image_part);
        // A 5.4 GB part (Mistral Medium 3.5) does not.
        let big = plan_with_part(45_000_000_000, 5_356_846_528, Some(88), Some(CARD_2_GB), 8192);
        assert!(!big.with_image_part);
        assert!(big.why.contains("does not fit at all"), "{}", big.why);
        assert!(big.layers.is_some());
    }

    #[test]
    fn a_machine_nothing_measured_loads_the_part_as_before() {
        let p = plan_with_part(NINE_B, NINE_B_PART, Some(32), None, 8192);
        assert_eq!(p.layers, None);
        assert!(p.with_image_part);
    }

    #[test]
    fn a_model_without_a_part_plans_exactly_as_it_always_did() {
        for (vram, ctx) in [(Some(CARD_2_GB), 4096), (Some(CARD_8_GB), 8192), (Some(CARD_12_GB), 32768), (None, 8192)] {
            let a = plan(NINE_B, Some(32), vram, ctx);
            assert!(a.with_image_part, "nothing to drop means nothing is dropped");
            assert_eq!(a.layers, plan_with_part(NINE_B, 0, Some(32), vram, ctx).layers);
        }
    }

    #[test]
    fn a_death_on_the_image_part_is_told_from_a_death_on_the_model() {
        // What llama.cpp prints when the part is the problem.
        for line in [
            "clip_init: failed to load model '/m/x.mmproj.gguf': load_hparams: unknown projector type: gemma9v",
            "mtmd_init_from_file: error: Failed to load CLIP model from /m/x.mmproj.gguf",
            "srv    load_model: failed to load multimodal model, '/m/x.mmproj.gguf'",
        ] {
            assert!(stderr_blames_the_image_part(line), "{line}");
        }
        // The part loaded fine and something else died afterwards.
        let fine = "srv    load_model: loaded multimodal model, '/m/x.mmproj.gguf'\nggml_backend_cuda_buffer_type_alloc_buffer: allocating 9000.00 MiB on device 0: cudaMalloc failed: out of memory";
        assert!(!stderr_blames_the_image_part(fine));
        assert!(!stderr_blames_the_image_part("llama_model_load: error loading model: unknown model architecture: 'foo'"));
        assert!(!stderr_blames_the_image_part(""));
    }

    #[test]
    fn the_two_image_notes_are_english_sentences_that_name_what_happened() {
        for note in [IMAGE_PART_NO_ROOM_NOTE, IMAGE_PART_REFUSED_NOTE] {
            assert!(note.starts_with("Loaded without image input: "), "{note}");
            assert!(note.is_ascii(), "{note}");
            assert!(!note.contains(" - "), "{note}");
        }
        assert_ne!(IMAGE_PART_NO_ROOM_NOTE, IMAGE_PART_REFUSED_NOTE);
        assert!(IMAGE_PART_NO_ROOM_NOTE.contains("smaller context"));
    }

    #[test]
    fn the_image_part_of_a_running_engine_is_read_from_its_argv() {
        let tuning = EngineTuning::default();
        let with = build_server_args("/m/a.gguf", &tuning, 8127, None, Some("/m/a.mmproj.gguf"), None);
        let without = build_server_args("/m/a.gguf", &tuning, 8127, None, None, None);
        assert_eq!(image_part_in(&with), Some("/m/a.mmproj.gguf"));
        assert_eq!(image_part_in(&without), None);
    }

    #[test]
    fn a_model_that_fits_is_left_exactly_as_it_was() {
        // The rule this whole change lives under. A 3B on a 12 GB card has
        // room for its weights, its cache and the driver, so nothing about
        // that start may move.
        let p = plan(THREE_B_Q4, Some(THREE_B_BLOCKS), Some(CARD_12_GB), 8192);
        assert_eq!(p.layers, None, "{}", p.why);
        assert!(p.why.contains("every layer is requested"), "{}", p.why);
    }

    /// R1-3 table test: the SAME numbers, once with `free: true` (a measured
    /// `nvidia-smi` reading) and once with `free: false` (`detect_gpus`'
    /// total-capacity fallback). The sentence must differ and the total-
    /// capacity run must never ask for MORE layers than the measured-free run
    ///, a card that has not been shown to be empty is the case where asking
    /// for too much costs the start.
    #[test]
    fn r1_3_a_total_capacity_reading_never_outbids_a_measured_free_one() {
        let cases: &[(u64, Option<u32>, u64, u32)] = &[
            (THREE_B_Q4, Some(THREE_B_BLOCKS), CARD_12_GB, 8192),
            (TWELVE_B_IQ4, Some(TWELVE_B_BLOCKS), CARD_8_GB, 8192),
            (THREE_B_Q4, Some(THREE_B_BLOCKS), CARD_2_GB, 8192),
        ];
        for &(model, blocks, vram, ctx) in cases {
            let free = plan_free(model, blocks, Some(vram), ctx, true);
            let total = plan_free(model, blocks, Some(vram), ctx, false);

            assert_ne!(free.why, total.why, "the two readings must not read the same on screen");
            assert!(free.why.contains("are free"), "{}", free.why);
            assert!(
                total.why.contains("in total (actual free memory was not measured)"),
                "{}",
                total.why
            );

            let free_layers = free.layers.unwrap_or(ALL_LAYERS);
            let total_layers = total.layers.unwrap_or(ALL_LAYERS);
            assert!(
                total_layers <= free_layers,
                "an unmeasured total-capacity reading asked for MORE layers ({total_layers}) than \
                 the measured-free reading ({free_layers}) on the same {vram} bytes, \
                 free: {}\ntotal: {}",
                free.why,
                total.why
            );
        }
    }

    #[test]
    fn a_card_nothing_measured_keeps_todays_behaviour() {
        // Apple, a machine without vendor tools, a wedged driver. `None` is a
        // real answer and it has to mean "carry on as before", or this change
        // would take the graphics card away from everyone it cannot see.
        let p = plan(TWELVE_B_IQ4, Some(TWELVE_B_BLOCKS), None, 8192);
        assert_eq!(p.layers, None);
        assert!(p.why.contains("no probe measured"), "{}", p.why);
    }

    #[test]
    fn a_twelve_b_on_an_eight_gb_card_gets_a_layer_count_instead_of_all_of_them() {
        // Discord ticket-0009. 7.3 GB of weights plus 1.25 GB of cache at 8192
        // tokens plus the driver is more than the 8 GB board has, so the whole
        // model was never going to fit and `-ngl 999` was asking for it anyway.
        let p = plan(TWELVE_B_IQ4, Some(TWELVE_B_BLOCKS), Some(CARD_8_GB), 8192);
        assert_eq!(p.layers, Some(37), "{}", p.why);
        assert!(p.why.contains("40 layers the GGUF header names"), "{}", p.why);

        // And what it chose really does fit in what it measured.
        let per_layer = TWELVE_B_IQ4 / TWELVE_B_BLOCKS as u64 + 4 * 1024 * 1024 * 8;
        assert!(37 * per_layer + VRAM_OVERHEAD_BYTES <= CARD_8_GB);
        assert!(38 * per_layer + VRAM_OVERHEAD_BYTES > CARD_8_GB, "one layer short of the truth");
    }

    #[test]
    fn the_counter_check_the_old_code_would_have_sent_all_of_them() {
        // The same 8 GB case with the new decision switched off, which is what
        // `auto_ngl: None` is: the argv is the one that shipped, `-ngl 999`.
        // Without this the test above proves an arithmetic nobody asked for.
        let tuning = EngineTuning::default();
        assert_eq!(tuning.gpu_layers, -1, "the default is auto");
        let old = build_server_args("/models/nemo-12b.gguf", &tuning, 8127, None, None, None);
        assert_eq!(gpu_layers_in(&old), Some(999));

        let plan = plan(TWELVE_B_IQ4, Some(TWELVE_B_BLOCKS), Some(CARD_8_GB), 8192);
        let now = build_server_args("/models/nemo-12b.gguf", &tuning, 8127, None, None, plan.layers);
        assert_eq!(gpu_layers_in(&now), Some(37));
        // Nothing else about the argv moved.
        assert_eq!(argv_without_gpu_layers(&old), argv_without_gpu_layers(&now));
    }

    #[test]
    fn a_three_b_on_a_two_gb_card_stops_asking_for_the_whole_model() {
        // GitHub 128 and the two Discord reports. 2 GB of card, about 2 GB of
        // weights, and a cache on top.
        let p = plan(THREE_B_Q4, Some(THREE_B_BLOCKS), Some(CARD_2_GB), 8192);
        assert_eq!(p.layers, Some(15), "{}", p.why);
        let per_layer = THREE_B_Q4 / THREE_B_BLOCKS as u64 + 4 * 1024 * 1024 * 8;
        assert!(15 * per_layer + VRAM_OVERHEAD_BYTES <= CARD_2_GB);
        assert!(16 * per_layer + VRAM_OVERHEAD_BYTES > CARD_2_GB);
    }

    #[test]
    fn a_smaller_context_pays_for_fewer_layers_of_cache_and_buys_more_layers() {
        // The reserve is derived from the context, so the same card and the
        // same model at 2048 tokens has room for more of the model.
        let wide = plan(THREE_B_Q4, Some(THREE_B_BLOCKS), Some(CARD_2_GB), 8192);
        let narrow = plan(THREE_B_Q4, Some(THREE_B_BLOCKS), Some(CARD_2_GB), 2048);
        assert_eq!(narrow.layers, Some(20), "{}", narrow.why);
        assert!(narrow.layers > wide.layers);
    }

    #[test]
    fn a_header_without_a_layer_count_guesses_low_and_says_that_it_guessed() {
        // The fallback. 16 assumed layers against a model that really has 28
        // buys 10 layers where the truth would have bought 15, and 10 layers
        // of a 28 layer model really do fit. The guess is low ON PURPOSE: the
        // count only multiplies the fraction that fits, so guessing under the
        // real block count can only ask for too few layers, never too many.
        let guessed = plan(THREE_B_Q4, None, Some(CARD_2_GB), 8192);
        assert_eq!(guessed.layers, Some(10), "{}", guessed.why);
        assert!(guessed.why.contains("carries no block count"), "{}", guessed.why);

        let real_per_layer = THREE_B_Q4 / THREE_B_BLOCKS as u64 + 4 * 1024 * 1024 * 8;
        assert!(10 * real_per_layer + VRAM_OVERHEAD_BYTES <= CARD_2_GB, "the guess overshot");

        // A header that answers zero is a header that answered nothing.
        assert_eq!(plan(THREE_B_Q4, Some(0), Some(CARD_2_GB), 8192), guessed);
    }

    #[test]
    fn a_card_far_too_small_ends_up_on_the_processor_rather_than_at_a_bad_number() {
        // 512 MiB of memory cannot hold the driver's own reserve, let alone a
        // layer. Zero is the right answer and `saturating_sub` is why it is
        // not a panic.
        let p = plan(THREE_B_Q4, Some(THREE_B_BLOCKS), Some(256 * 1024 * 1024), 8192);
        assert_eq!(p.layers, Some(0), "{}", p.why);
    }

    #[test]
    fn gh156_auto_on_a_card_only_its_total_is_known_of_goes_to_the_engine() {
        use crate::commands::gpu::VramReading;
        // The RX 5700 of GH #156: Vulkan, no nvidia-smi, the card's total out
        // of sysfs or the registry. The engine measures, LU does not guess.
        let total = VramReading { bytes: 8176 * 1024 * 1024, free: false, source: "detect_gpus" };
        assert!(engine_fits_layers(Some(&total), false), "an AMD or Intel card on Windows or Linux");
        // A measured-free reading keeps the plan, and so does the Mac.
        let measured = VramReading { bytes: 7000 * 1024 * 1024, free: true, source: "nvidia-smi" };
        assert!(!engine_fits_layers(Some(&measured), false), "nvidia-smi measured it");
        assert!(!engine_fits_layers(Some(&total), true), "the Mac keeps its plan");
        // Nothing measured at all: every layer, as it always was.
        assert!(!engine_fits_layers(None, false));

        let auto = EngineTuning::default();
        assert_eq!(auto.gpu_layers, -1);
        let args = build_server_args("/m.gguf", &auto, 8127, None, None, Some(ENGINE_DECIDES));
        let at = args.iter().position(|a| a == "-ngl").expect("-ngl in argv");
        assert_eq!(args[at + 1], "auto", "llama-server gets its own word, not a number LU made up");
        assert!(!args.iter().any(|a| a == "--fit"), "fit is on by default in the pinned engine");
    }

    #[test]
    fn gh156_auto_by_the_engine_counts_as_layers_on_the_card_everywhere_after() {
        let auto = EngineTuning::default();
        let args = build_server_args("/m.gguf", &auto, 8127, None, None, Some(ENGINE_DECIDES));
        // The died-on-start retry takes the card out: layers were on it.
        assert!(gpu_layers_in(&args).is_some_and(|n| n > 0));
        // The sanity ladder sees a card it can take away, not "nothing to give up".
        let facts = crate::commands::engine_sanity::EngineFacts {
            gpu_layers: gpu_layers_in(&args),
            flash_attention_on: true,
            every_device_without_matrix_cores: false,
        };
        assert_eq!(
            crate::commands::engine_sanity::decide(crate::commands::engine_sanity::Sanity::Garbled(crate::commands::engine_sanity::Garble::Replacement), &facts),
            crate::commands::engine_sanity::AfterProbe::RestartOnCpu
        );
        // A restart that keeps the layer count hands the same word on.
        let again = build_server_args("/m.gguf", &auto, 8127, None, None, gpu_layers_in(&args));
        assert_eq!(gpu_layers_in(&again), Some(ENGINE_DECIDES));
        assert!(again.windows(2).any(|w| w[0] == "-ngl" && w[1] == "auto"));
        // The processor rung is a typed 0 and beats it.
        let cpu = on_the_processor(&auto);
        assert_eq!(gpu_layers_in(&build_server_args("/m.gguf", &cpu, 8127, None, None, gpu_layers_in(&args))), Some(0));
        // Nobody is shown the sentinel, and the idempotence check ignores it.
        assert_eq!(gpu_layers_reported(&args), None);
        assert_eq!(
            argv_without_gpu_layers(&args),
            argv_without_gpu_layers(&build_server_args("/m.gguf", &auto, 8127, None, None, None))
        );
        // A typed count still wins over the engine's word.
        let typed = EngineTuning { gpu_layers: 20, ..Default::default() };
        assert_eq!(gpu_layers_in(&build_server_args("/m.gguf", &typed, 8127, None, None, Some(ENGINE_DECIDES))), Some(20));
    }

    #[test]
    fn a_typed_layer_count_beats_every_measurement() {
        // The expert's setting is an answer, not a suggestion. `auto_ngl` is
        // only ever consulted for the auto default.
        let tuning = EngineTuning { gpu_layers: 20, ..Default::default() };
        let args = build_server_args("/m.gguf", &tuning, 8127, None, None, Some(3));
        assert_eq!(gpu_layers_in(&args), Some(20));
        let cpu = EngineTuning { gpu_layers: 0, ..Default::default() };
        assert_eq!(
            gpu_layers_in(&build_server_args("/m.gguf", &cpu, 8127, None, None, Some(3))),
            Some(0)
        );
    }

    #[test]
    fn the_status_shows_a_layer_count_but_never_the_sentinel() {
        // What a surface may print. 999 is llama.cpp's way of saying "all of
        // them", so printing it would put a magic number in front of a user
        // who owns a card with 32 layers.
        let auto = EngineTuning::default();
        let all = build_server_args("/m.gguf", &auto, 8127, None, None, None);
        assert_eq!(gpu_layers_reported(&all), None, "the sentinel reached a surface");
        let some = build_server_args("/m.gguf", &auto, 8127, None, None, Some(18));
        assert_eq!(gpu_layers_reported(&some), Some(18));
        // A start that ended on the processor names the zero rather than
        // hiding it: nought layers on the card is the whole story.
        let cpu = EngineTuning { gpu_layers: 0, ..Default::default() };
        assert_eq!(
            gpu_layers_reported(&build_server_args("/m.gguf", &cpu, 8127, None, None, None)),
            Some(0)
        );
    }

    #[test]
    fn the_idempotence_key_ignores_a_measurement_but_not_a_setting() {
        // Two auto starts a minute apart measure different free memory. That
        // is not a reason to tear down a healthy engine, and comparing the
        // whole argv would have made it one. A switch between auto and a typed
        // number still has to read as a different request.
        let auto = EngineTuning::default();
        let a = build_server_args("/m.gguf", &auto, 8127, None, None, Some(35));
        let b = build_server_args("/m.gguf", &auto, 8127, None, None, Some(33));
        assert_ne!(a, b);
        assert_eq!(argv_without_gpu_layers(&a), argv_without_gpu_layers(&b));

        // A model swap is still a difference with the layers stripped out.
        let other = build_server_args("/other.gguf", &auto, 8127, None, None, Some(35));
        assert_ne!(argv_without_gpu_layers(&a), argv_without_gpu_layers(&other));
        // And so is a context change.
        let wider = EngineTuning { ctx: 16384, ..Default::default() };
        assert_ne!(
            argv_without_gpu_layers(&a),
            argv_without_gpu_layers(&build_server_args("/m.gguf", &wider, 8127, None, None, Some(35)))
        );
    }

    #[test]
    fn the_second_attempt_says_that_it_ran_on_the_processor() {
        // The old message said "It was tried twice" about two identical
        // attempts. When the retry really did drop the card, the sentence has
        // to say so, and it must not go on to advise a setting the app has
        // already used up.
        let out_of_memory = StartFailure {
            died: true,
            port_taken: false,
            stderr: "ggml_backend_cuda_buffer_type_alloc_buffer: allocating 9216.00 MiB on device 0: cudaMalloc failed: out of memory".into(),
            exit_code: None, signal: None };
        let same = start_failure_message(&out_of_memory, 8127, Duration::from_secs(60), SecondAttempt::SameOffload, None);
        assert!(same.contains("It was tried twice"), "{same}");
        assert!(same.contains("set GPU Layers to 0"), "{same}");

        let cpu = start_failure_message(&out_of_memory, 8127, Duration::from_secs(60), SecondAttempt::CpuOnly, None);
        assert!(cpu.contains("The LU Engine exited before serving on port 8127."), "{cpu}");
        assert!(cpu.contains("Tried with GPU offload and again on CPU."), "{cpu}");
        assert!(!cpu.contains("GPU Layers"), "the way out was already taken:\n{cpu}");
        assert!(cpu.contains("Settings, Troubleshoot"), "{cpu}");
        // The engine's own last words still ride along for a bug report.
        assert!(cpu.contains("cudaMalloc failed"), "{cpu}");
    }

    #[test]
    fn a_retry_on_the_processor_is_only_offered_when_there_was_offload_to_drop() {
        // What `start_after_stop` reads to decide. A first attempt that was
        // already on the processor has nothing left to take away, so its
        // message keeps the old wording.
        let auto = EngineTuning::default();
        assert_eq!(
            gpu_layers_in(&build_server_args("/m.gguf", &auto, 8127, None, None, None)),
            Some(999)
        );
        let already_cpu = EngineTuning { gpu_layers: 0, ..Default::default() };
        assert_eq!(
            gpu_layers_in(&build_server_args("/m.gguf", &already_cpu, 8127, None, None, None)),
            Some(0)
        );
        // A measured zero is the same case: the card is already out.
        assert_eq!(
            gpu_layers_in(&build_server_args("/m.gguf", &auto, 8127, None, None, Some(0))),
            Some(0)
        );
        assert_eq!(gpu_layers_in(&["--port".to_string(), "8127".to_string()]), None);
    }

    // ── The sanity probe's half of the start path (bug a) ────────────────────

    #[test]
    fn a_healthy_start_answers_exactly_what_it_always_did() {
        // The counter-check to the probe: on a machine whose engine reads
        // fine, the object the frontend receives carries no new key at all, so
        // nothing about a working install changes.
        let answer = started_answer(8127, "/models/qwen.gguf", Some(8192));
        assert_eq!(
            answer,
            serde_json::json!({
                "status": "started",
                "port": 8127,
                "model_path": "/models/qwen.gguf",
                "ctx": 8192,
            })
        );
        assert!(answer.get("note").is_none());
        assert!(answer.get("garbled").is_none());
    }

    #[test]
    fn the_restart_after_unreadable_output_takes_the_card_out_and_changes_nothing_else() {
        let asked_for = EngineTuning {
            ctx: 4096,
            flash_attn: "on".into(),
            cache_type_k: "q8_0".into(),
            threads: 6,
            gpu_layers: -1,
            mlock: true,
            ..Default::default()
        };
        let kv = Some("/kv");
        let vision = Some("/m.mmproj.gguf");
        let on_the_card = build_server_args("/m.gguf", &asked_for, 8127, kv, vision, Some(12));
        let on_the_cpu =
            build_server_args("/m.gguf", &on_the_processor(&asked_for), 8127, kv, vision, None);
        assert_eq!(gpu_layers_in(&on_the_card), Some(12));
        assert_eq!(gpu_layers_in(&on_the_cpu), Some(0));
        // Exactly ONE variable moved. Context, flash attention, cache type,
        // threads, mlock, the KV slot folder and the vision file all survive.
        assert_eq!(argv_without_gpu_layers(&on_the_card), argv_without_gpu_layers(&on_the_cpu));
    }

    #[test]
    fn the_flash_attention_rung_moves_only_that_one_flag() {
        // The first rung of the ladder. The card keeps the layer count it was
        // measured at; the only difference in the argv is the `-fa` pair.
        //
        // The rung is built the way production builds it: the layer count is
        // not typed in here a second time, it is read back out of the argv the
        // running engine got, which is what `serve_or_heal_garbled` does.
        let auto = EngineTuning { ctx: 4096, threads: 6, ..Default::default() };
        assert_eq!(auto.flash_attn, "auto");
        let before = build_server_args("/m.gguf", &auto, 8127, None, None, Some(12));
        let after = build_server_args(
            "/m.gguf",
            &without_flash_attention(&auto),
            8127,
            None,
            None,
            gpu_layers_in(&before),
        );
        assert!(!before.iter().any(|a| a == "-fa"), "auto is not forwarded: {before:?}");
        assert_eq!(after.windows(2).find(|w| w[0] == "-fa").map(|w| w[1].as_str()), Some("off"));
        assert_eq!(gpu_layers_in(&after), Some(12));
        let stripped: Vec<String> =
            after.iter().filter(|a| *a != "-fa" && *a != "off").cloned().collect();
        assert_eq!(stripped, before);
        // Negative control, the two ways this can go wrong. `None` on a tuning
        // that left GPU Layers on auto is the sentinel, 999 layers on a card
        // that was just measured at twelve; and the processor rung is not
        // touched by any of it, a typed 0 outranks `auto_ngl`.
        assert_eq!(
            gpu_layers_in(&build_server_args(
                "/m.gguf",
                &without_flash_attention(&auto),
                8127,
                None,
                None,
                None
            )),
            Some(999)
        );
        assert_eq!(
            gpu_layers_in(&build_server_args(
                "/m.gguf",
                &on_the_processor(&auto),
                8127,
                None,
                None,
                Some(12)
            )),
            Some(0)
        );
        // Quellanker, sonst ist der Test blind: er baut die Sprosse selbst und
        // wuerde gruen bleiben, waehrend die Produktionszeile weiter `None`
        // schickt. `split` schneidet den Rumpf der echten Funktion heraus, die
        // Suchbegriffe stehen zwar auch in diesem Test, aber nicht darin.
        let leiter = include_str!("engine.rs")
            .split("fn serve_or_heal_garbled(")
            .nth(1)
            .expect("the ladder is gone")
            .split("\nfn ")
            .next()
            .unwrap();
        let sprosse = leiter
            .split("let next_args = build_server_args(")
            .nth(1)
            .expect("the rung no longer builds its own argv")
            .split(");")
            .next()
            .unwrap();
        assert!(
            sprosse.contains("gpu_layers_in(&serving_args)"),
            "the restart throws the measured layer count away: {sprosse}"
        );
        assert!(
            !sprosse.contains("None"),
            "the restart hands the sentinel to the rung again: {sprosse}"
        );
    }

    #[test]
    fn a_typed_layer_count_is_still_dropped_when_the_answer_is_unreadable() {
        // An expert who typed 20 into Settings gets 20 on the first start
        // (plan_offload is not even run for him), but a card that answers in
        // question marks is not a settings question. The restart takes it out
        // for him too, and the note says so.
        let typed = EngineTuning { gpu_layers: 20, flash_attn: "off".into(), ..Default::default() };
        let first = build_server_args("/m.gguf", &typed, 8127, None, None, None);
        assert_eq!(gpu_layers_in(&first), Some(20));
        assert_eq!(
            engine_sanity::decide(
                engine_sanity::judge("????????????????????????????????"),
                &engine_sanity::EngineFacts {
                    gpu_layers: gpu_layers_in(&first),
                    flash_attention_on: typed.flash_attn != "off",
                    every_device_without_matrix_cores: true,
                }
            ),
            engine_sanity::AfterProbe::RestartOnCpu
        );
        assert_eq!(
            gpu_layers_in(&build_server_args(
                "/m.gguf",
                &on_the_processor(&typed),
                8127,
                None,
                None,
                None
            )),
            Some(0)
        );
    }

    #[test]
    fn the_four_notes_are_english_and_say_different_things() {
        // UI strings, and the only four sentences this fix ever puts on
        // screen.
        let notes = [
            engine_sanity::HEALED_WITHOUT_FLASH_ATTENTION_NOTE,
            engine_sanity::HEALED_ON_CPU_NOTE,
            engine_sanity::GARBLED_ON_CPU_NOTE,
            engine_sanity::RESTART_DID_NOT_COME_BACK_NOTE,
        ];
        for note in notes {
            assert!(note.contains("Settings > Troubleshoot"), "{note}");
            assert!(note.is_ascii(), "{note}");
            assert!(!note.contains('-'), "no dashes in user-facing text: {note}");
        }
        assert!(engine_sanity::HEALED_WITHOUT_FLASH_ATTENTION_NOTE.contains("Flash Attention"));
        assert!(engine_sanity::HEALED_ON_CPU_NOTE.contains("restarted on the CPU"));
        assert!(engine_sanity::GARBLED_ON_CPU_NOTE.contains("on the CPU as well"));
        // The fourth one is the only one that may not claim a measurement.
        // Nothing ran on the processor in its branch, so the words must not be
        // there either.
        assert!(
            engine_sanity::RESTART_DID_NOT_COME_BACK_NOTE.contains("could not be restarted"),
            "{}",
            engine_sanity::RESTART_DID_NOT_COME_BACK_NOTE
        );
        assert!(
            !engine_sanity::RESTART_DID_NOT_COME_BACK_NOTE.contains("on the CPU"),
            "the note claims a CPU measurement that never happened: {}",
            engine_sanity::RESTART_DID_NOT_COME_BACK_NOTE
        );
        assert_eq!(
            notes.iter().collect::<std::collections::BTreeSet<_>>().len(),
            notes.len(),
            "the four notes have to be distinguishable"
        );
        // And each note sits in the branch it is true for. The block that puts
        // the first engine back must not reach for the CPU sentence any more;
        // the branch that really did judge the processor still carries it.
        // `split` takes what stands AFTER the anchor, and the anchors' first
        // occurrence is the production code far above this test.
        let quelle = include_str!("engine.rs");
        let block_ab = |anker: &str| -> String {
            quelle
                .split(anker)
                .nth(1)
                .unwrap_or_else(|| panic!("the branch is gone: {anker}"))
                .split("return answer;")
                .next()
                .unwrap_or("")
                .to_string()
        };
        let rueckfall = block_ab("the restart did not come up, bringing the first LU Engine back");
        assert!(
            !rueckfall.contains("GARBLED_ON_CPU_NOTE"),
            "the restart that never came up still claims a CPU measurement: {rueckfall}"
        );
        assert!(
            rueckfall.contains("RESTART_DID_NOT_COME_BACK_NOTE"),
            "the restart that never came up says nothing at all: {rueckfall}"
        );
        let aufgegeben = block_ab(
            "the LU Engine answers unreadably without the graphics card, so the card is not the cause",
        );
        assert!(
            aufgegeben.contains("GARBLED_ON_CPU_NOTE"),
            "the branch that really did run on the processor lost its sentence: {aufgegeben}"
        );
    }

    #[test]
    fn nothing_in_this_module_writes_to_a_stream_the_user_cannot_send() {
        // Bug o, and the guard against it coming back. A shipped Windows build
        // is linked with `windows_subsystem = "windows"` and has no stdout at
        // all (commands/logging.rs, finding #01), so a `println!` here is a
        // line that exists on a developer machine and nowhere else.
        //
        // The level matters as much as the macro: `init_tracing` in main.rs
        // builds its EnvFilter as `EnvFilter::new("info")` when RUST_LOG says
        // nothing, and that filter sits on the registry, ABOVE the rolling
        // file layer. Anything below info is therefore filtered out before the
        // file writer ever sees it, so a debug line would be exactly as
        // invisible as the println! it replaced.
        // Only what ships. `split` takes what stands BEFORE the first
        // `#[cfg(test)]`, so the four macro names spelled out below are not
        // themselves findings.
        let source = include_str!("engine.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("engine.rs has production code above its tests");
        let mut offenders: Vec<(usize, &str)> = Vec::new();
        for (no, line) in source.lines().enumerate() {
            let code = line.trim_start();
            if code.starts_with("//") || code.starts_with("*") {
                continue;
            }
            if code.contains("println!")
                || code.contains("eprintln!")
                || code.contains("tracing::debug!")
                || code.contains("tracing::trace!")
            {
                offenders.push((no + 1, line.trim()));
            }
        }
        assert!(offenders.is_empty(), "lines the log file will never hold: {offenders:#?}");
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
        let args = build_server_args("/m.gguf", &tuning, 8127, None, None, None);
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
        let args = build_server_args("/m.gguf", &tuning, 8127, None, None, None);
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
    fn cpu_features_are_logged_once_and_never_panic() {
        // K1: the log line that names AVX/AVX2/FMA/F16C is what turns an
        // illegal-instruction crash into a diagnosis instead of a guess, so
        // it must run without panicking on every architecture this app
        // ships for, and calling it twice (every engine start does) must
        // stay a no-op the second time round (`std::sync::Once`).
        log_cpu_features_once();
        log_cpu_features_once();
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

    // ── K1 (3.0.1): pick_backend_dir (BLOCKER B2) ─────────────────────────

    #[test]
    fn pick_backend_dir_returns_the_first_candidate_that_has_the_marker() {
        let candidates = vec![PathBuf::from("/bundled"), PathBuf::from("/dev-fallback")];
        let picked = pick_backend_dir(&candidates, |dir| dir == Path::new("/bundled"));
        assert_eq!(picked, Some(PathBuf::from("/bundled")));
    }

    #[test]
    fn pick_backend_dir_falls_through_to_a_later_candidate() {
        let candidates = vec![PathBuf::from("/bundled"), PathBuf::from("/dev-fallback")];
        let picked = pick_backend_dir(&candidates, |dir| dir == Path::new("/dev-fallback"));
        assert_eq!(picked, Some(PathBuf::from("/dev-fallback")));
    }

    #[test]
    fn pick_backend_dir_returns_none_when_no_candidate_has_the_marker() {
        // Negative control: every candidate directory "exists" in the sense
        // that it is a path, but none of them has the marker file, so this
        // must come back empty rather than picking a directory that holds
        // no ggml libraries at all.
        let candidates = vec![PathBuf::from("/bundled"), PathBuf::from("/dev-fallback")];
        let picked = pick_backend_dir(&candidates, |_| false);
        assert_eq!(picked, None);
    }

    #[test]
    fn pick_backend_dir_does_not_accept_a_directory_that_merely_exists() {
        // This is BLOCKER B2 itself, reproduced platform-independently: on
        // Windows, resource_dir() is unconditionally the running exe's own
        // directory, so it ALWAYS exists, whether or not any ggml DLLs are
        // inside it. The bug was checking `.is_dir()` (which such a
        // candidate always passes) instead of checking for the marker file.
        // Here the "exists" predicate for the first (bundled) candidate is
        // always true, exactly mirroring that always-existing Windows exe
        // directory, while `has_marker` (what pick_backend_dir actually
        // uses) is false for it, true only for the dev fallback. A
        // directory-existence check would incorrectly stop at the first
        // candidate and never reach the dev fallback; pick_backend_dir must
        // fall through to it instead.
        let candidates = vec![PathBuf::from("/always-exists-but-empty"), PathBuf::from("/dev-fallback-with-dlls")];
        let dir_exists = |_: &Path| true; // simulates Windows resource_dir() always existing
        let has_marker = |dir: &Path| dir == Path::new("/dev-fallback-with-dlls");
        // The old, buggy check (directory existence only) would have picked
        // the first candidate:
        assert_eq!(candidates.iter().find(|c| dir_exists(c)).cloned(), Some(PathBuf::from("/always-exists-but-empty")));
        // pick_backend_dir, using the marker predicate, correctly falls
        // through to the one that actually has the companion libraries:
        assert_eq!(pick_backend_dir(&candidates, has_marker), Some(PathBuf::from("/dev-fallback-with-dlls")));
    }

    #[test]
    fn backend_marker_filename_has_lib_prefix_only_off_windows() {
        let marker = backend_marker_filename();
        if cfg!(target_os = "windows") {
            assert_eq!(marker, "ggml-base.dll");
        } else {
            assert_eq!(marker, "libggml-base.so");
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

    // ── K1 (3.0.1): apply_engine_backend_dir ──────────────────────────────

    #[test]
    fn apply_engine_backend_dir_is_a_noop_without_a_directory() {
        // mac (static build) and "nothing built yet" both pass None here, and
        // the spawned Command must come out exactly as `Command::new` left
        // it: no current_dir, no LD_LIBRARY_PATH this function did not put
        // there itself.
        let mut cmd = Command::new("echo");
        apply_engine_backend_dir(&mut cmd, None);
        assert!(cmd.get_current_dir().is_none());
        assert!(!cmd.get_envs().any(|(k, _)| k == "LD_LIBRARY_PATH"));
    }

    #[test]
    fn apply_engine_backend_dir_sets_current_dir_when_given_one() {
        // The one lever ggml_backend_load_best actually reads when no
        // explicit search path is passed (ggml-backend-reg.cpp:479-486): the
        // executable's own directory, and the process's CURRENT directory.
        // Without this, a dynamic-ISA sidecar spawned from an arbitrary cwd
        // would silently fail to find ggml-cpu-*/ggml-vulkan.
        let dir = std::env::temp_dir();
        let mut cmd = Command::new("echo");
        apply_engine_backend_dir(&mut cmd, Some(&dir));
        assert_eq!(cmd.get_current_dir(), Some(dir.as_path()));
    }

    // ── K1-14 (3.0.1): long install paths on Windows ────────────────────────
    //
    // Pure decision logic, platform independent by construction: plain
    // numbers and canned closures stand in for real paths and the real
    // GetShortPathNameW call, so these run (and matter) on every host OS,
    // this Mac included, not only on the Windows box.

    #[test]
    fn exceeds_classic_current_dir_limit_is_false_at_and_below_258() {
        // Negative control: 258 itself, and anything under it, must NOT be
        // flagged as too long. review-longpath.md Runde 1, Auflage 2:
        // `backend_dir` never carries a trailing backslash, and without one
        // MAX_PATH-2 = 258 is the last length Windows appends its own
        // backslash to without crossing MAX_PATH (260, including the NUL).
        assert!(!exceeds_classic_current_dir_limit(0));
        assert!(!exceeds_classic_current_dir_limit(258));
    }

    #[test]
    fn exceeds_classic_current_dir_limit_is_true_above_258() {
        // 259 is the exact off-by-one Auflage 2 corrected: it looks like it
        // should fit under MAX_PATH (260), but Windows' own appended
        // backslash plus the terminator pushes it to exactly MAX_PATH, which
        // Microsoft's own SetCurrentDirectory page says makes CreateProcessW
        // fail. This is the one assertion that would have caught Runde 1's
        // bug had it existed then.
        assert!(exceeds_classic_current_dir_limit(259));
        assert!(exceeds_classic_current_dir_limit(295)); // BERICHT.md #63's own measured length
    }

    // ── verbatim_prefixed / strip_verbatim_prefix (Auflage 1) ────────────────
    //
    // Pure UTF-16-code-unit logic, no Windows API involved: testable, and
    // tested, on every host OS.

    fn utf16(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn verbatim_prefixed_adds_the_prefix_to_a_drive_path() {
        assert_eq!(verbatim_prefixed(&utf16(r"C:\LU\long\path")), utf16(r"\\?\C:\LU\long\path"));
    }

    #[test]
    fn verbatim_prefixed_does_not_double_an_existing_prefix() {
        let already = utf16(r"\\?\C:\LU\long\path");
        assert_eq!(verbatim_prefixed(&already), already);
    }

    #[test]
    fn verbatim_prefixed_turns_a_unc_path_into_the_unc_verbatim_form() {
        // "\\server\share\x" -> "\\?\UNC\server\share\x", per Microsoft's own
        // "Naming Files, Paths, and Namespaces" (the leading "\\" is dropped,
        // not kept alongside "UNC\").
        assert_eq!(verbatim_prefixed(&utf16(r"\\server\share\x")), utf16(r"\\?\UNC\server\share\x"));
    }

    #[test]
    fn strip_verbatim_prefix_undoes_a_plain_verbatim_prefix() {
        assert_eq!(strip_verbatim_prefix(&utf16(r"\\?\C:\LU~1")), utf16(r"C:\LU~1"));
    }

    #[test]
    fn strip_verbatim_prefix_undoes_the_unc_verbatim_form() {
        assert_eq!(strip_verbatim_prefix(&utf16(r"\\?\UNC\server\share\x")), utf16(r"\\server\share\x"));
    }

    #[test]
    fn strip_verbatim_prefix_leaves_an_unprefixed_path_alone() {
        // Negative control: nothing to strip must not eat real characters.
        assert_eq!(strip_verbatim_prefix(&utf16(r"C:\LU~1")), utf16(r"C:\LU~1"));
    }

    #[test]
    fn verbatim_prefix_and_strip_round_trip_a_drive_path() {
        let original = utf16(r"C:\Program Files\Locally Uncensored\resources\llama\x86_64-pc-windows-msvc");
        assert_eq!(strip_verbatim_prefix(&verbatim_prefixed(&original)), original);
    }

    #[test]
    fn verbatim_prefix_and_strip_round_trip_a_unc_path() {
        let original = utf16(r"\\fileserver\share\LU\resources\llama\x86_64-pc-windows-msvc");
        assert_eq!(strip_verbatim_prefix(&verbatim_prefixed(&original)), original);
    }

    // ── Prefix edge cases (review-longpath.md Runde 2, Auflage 11) ──────────

    #[test]
    fn strip_verbatim_prefix_strips_a_lowercase_unc_marker_too() {
        // GetShortPathNameW is free to hand back any casing; a case-sensitive
        // compare here would strip only "\\?\" and leave the broken relative
        // path "unc\server\share\x" behind.
        assert_eq!(strip_verbatim_prefix(&utf16(r"\\?\unc\server\share\x")), utf16(r"\\server\share\x"));
        // Negative control: this must still be the ONLY thing that changes;
        // an unrelated path is not touched by the case-insensitive compare.
        assert_eq!(strip_verbatim_prefix(&utf16(r"C:\LU~1")), utf16(r"C:\LU~1"));
    }

    #[test]
    fn verbatim_prefixed_does_not_mistake_a_device_path_for_unc() {
        // "\\.\C:" and similar device paths also start with two backslashes,
        // but the third character (".") marks them as a device path, not a
        // UNC share. Getting this wrong would silently build a nonexistent
        // "\\?\UNC\.\..." path instead of just prefixing the device path
        // unchanged, "\\?\" followed by the original "\\.\C:\long\path".
        let expected: Vec<u16> = utf16(r"\\?\").into_iter().chain(utf16(r"\\.\C:\long\path")).collect();
        assert_eq!(verbatim_prefixed(&utf16(r"\\.\C:\long\path")), expected);
    }

    #[test]
    fn verbatim_prefixed_normalizes_forward_slashes_before_prefixing() {
        // The verbatim prefix disables all string parsing, forward slashes
        // included, so a mixed-separator input must be normalized to
        // backslashes FIRST or the result would not resolve as a path at all.
        assert_eq!(verbatim_prefixed(&utf16("C:/LU/long/path")), utf16(r"\\?\C:\LU\long\path"));
        // A UNC path with forward slashes must still be recognized as UNC
        // AFTER normalization, not missed because the check ran too early.
        assert_eq!(verbatim_prefixed(&utf16("//server/share/x")), utf16(r"\\?\UNC\server\share\x"));
    }

    #[test]
    fn decide_long_path_current_dir_uses_the_short_dir_as_is() {
        // Short enough already: the short-name resolver must never even run.
        let decision = decide_long_path_current_dir(120, || {
            panic!("resolve_short_name must not run for a short directory")
        });
        assert_eq!(decision, LongPathDecision::UseAsIs);
    }

    #[test]
    fn decide_long_path_current_dir_falls_back_to_a_short_name_that_fits() {
        let short = PathBuf::from(r"C:\LU~1");
        let decision = decide_long_path_current_dir(295, || Some((short.clone(), 7)));
        assert_eq!(decision, LongPathDecision::UseShortName(short));
    }

    #[test]
    fn decide_long_path_current_dir_skips_current_dir_when_the_short_name_is_still_too_long() {
        // An 8.3 short name is not guaranteed to be short: a deeply nested
        // long path still has one short component per level.
        let still_long = PathBuf::from("C:\\".to_string() + &"LU~1\\".repeat(60));
        let long_len = still_long.to_string_lossy().chars().count();
        assert!(exceeds_classic_current_dir_limit(long_len));
        let decision = decide_long_path_current_dir(295, || Some((still_long, long_len)));
        assert_eq!(decision, LongPathDecision::SkipCurrentDir);
    }

    #[test]
    fn decide_long_path_current_dir_skips_current_dir_when_the_short_name_lookup_fails() {
        // 8dot3 name creation can be disabled per volume (Microsoft,
        // GetShortPathNameW remarks): the lookup then fails outright rather
        // than returning a usable name.
        let decision = decide_long_path_current_dir(295, || None);
        assert_eq!(decision, LongPathDecision::SkipCurrentDir);
    }

    // ── died_failure_hint (review-longpath.md Runde 2, Blocker 9 and 10) ────
    //
    // Pure function of `stderr` and a plain `bool`, no Windows API or `Path`
    // involved: testable, and tested, on every host OS, closing the gap
    // Blocker 10 named (the real call site is only reachable through
    // `windows_backend_dir_too_long`, which is a hard `false` off Windows, so
    // nothing here was ever exercised on the Mac before this).

    #[test]
    fn died_failure_hint_names_a_missing_library_before_anything_else() {
        // Step 1 outranks even a long path: a library the loader itself named
        // is more certain than an inferred path-length cause.
        let hint = died_failure_hint(
            "lu-llama-server: error while loading shared libraries: libvulkan.so.1: cannot open shared object file",
            true,
            true,
        );
        assert!(hint.contains("libvulkan.so.1"), "{hint}");
        assert!(!hint.contains("installation's own folder path"), "{hint}");
    }

    #[test]
    fn died_failure_hint_blames_the_long_path_even_when_stderr_looks_like_a_model_failure() {
        // THE guard against Blocker 9: with no backend loaded at all (a long
        // path with no usable short name), llama.cpp's model loader aborts
        // and prints exactly this line, which has nothing to do with the
        // file's own bytes. A long path must win here, not "download it
        // again" for a perfectly good model.
        let hint = died_failure_hint("llama_model_load_from_file_impl: failed to load model", true, false);
        assert!(hint.contains("installation's own folder path"), "{hint}");
        assert!(!hint.contains("download it again"), "{hint}");
    }

    #[test]
    fn died_failure_hint_still_blames_the_model_on_a_short_path() {
        // The exact opposite of the test above, same stderr line: with a
        // SHORT path, `backend_dir_too_long` is false, so this is genuinely
        // the ordinary "the child died over a bad model" case and the model
        // hint is still correct. Negative control for the guard test: this
        // is what proves the guard checks the PATH, not just the stderr text.
        let hint = died_failure_hint("llama_model_load_from_file_impl: failed to load model", false, false);
        assert!(hint.contains("download it again"), "{hint}");
        assert!(!hint.contains("installation's own folder path"), "{hint}");
    }

    #[test]
    fn died_failure_hint_falls_back_to_reinstall_advice_with_nothing_else_to_go_on() {
        let hint = died_failure_hint("some unrelated crash text", false, false);
        assert!(hint.contains("Reinstall Locally Uncensored"), "{hint}");
    }

    #[test]
    fn died_failure_hint_names_the_long_path_with_an_empty_stderr_too() {
        // The plain case BERICHT.md #63's 8dot3-disabled scenario actually
        // produces: no specific stderr line at all, just a too-long path.
        let hint = died_failure_hint("", true, false);
        assert!(hint.contains("installation's own folder path"), "{hint}");
    }

    // Serializes the two tests below: both read and mutate the process-wide
    // LD_LIBRARY_PATH, and cargo test runs in threads by default. Same
    // pattern as process_util.rs's own env_guard, kept local here since that
    // one is private to its own test module.
    #[cfg(target_os = "linux")]
    fn ld_library_path_env_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn apply_engine_backend_dir_prepends_ld_library_path_on_linux() {
        // Linux-only: nothing in the pinned llama.cpp build sets an $ORIGIN
        // rpath (measured against the checkout, not assumed), so a
        // ggml-cpu-*.so's own dependency on libggml-base.so needs
        // LD_LIBRARY_PATH, current_dir alone is not enough there. This test
        // is red without the fix: before apply_engine_backend_dir touched
        // LD_LIBRARY_PATH at all, get_envs() never carried the key.
        let _guard = ld_library_path_env_guard();
        std::env::set_var("LD_LIBRARY_PATH", "/tmp/.mount_LocallieGkad/usr/lib");
        let dir = std::path::Path::new("/opt/lu/resources/llama/x86_64-unknown-linux-gnu");
        let mut cmd = Command::new("echo");
        apply_engine_backend_dir(&mut cmd, Some(dir));
        let value = cmd
            .get_envs()
            .find(|(k, _)| *k == "LD_LIBRARY_PATH")
            .and_then(|(_, v)| v)
            .expect("LD_LIBRARY_PATH must be set")
            .to_string_lossy()
            .into_owned();
        assert_eq!(value, "/opt/lu/resources/llama/x86_64-unknown-linux-gnu:/tmp/.mount_LocallieGkad/usr/lib");
        // The process's OWN inherited value (the AppImage's own
        // LD_LIBRARY_PATH, per K11/K14) survives behind it, not overwritten:
        // this process's own sidecar WANTS the AppImage-mounted libraries too
        // (Vulkan), unlike a foreign program.
        assert!(value.ends_with("/tmp/.mount_LocallieGkad/usr/lib"), "{value}");
        std::env::remove_var("LD_LIBRARY_PATH");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn apply_engine_backend_dir_does_not_drop_an_empty_inherited_value() {
        // Negative control: an empty (but SET) inherited LD_LIBRARY_PATH must
        // not turn into a trailing ":" with nothing after it.
        let _guard = ld_library_path_env_guard();
        std::env::set_var("LD_LIBRARY_PATH", "");
        let dir = std::path::Path::new("/opt/lu/resources/llama/x86_64-unknown-linux-gnu");
        let mut cmd = Command::new("echo");
        apply_engine_backend_dir(&mut cmd, Some(dir));
        let value = cmd
            .get_envs()
            .find(|(k, _)| *k == "LD_LIBRARY_PATH")
            .and_then(|(_, v)| v)
            .expect("LD_LIBRARY_PATH must be set")
            .to_string_lossy()
            .into_owned();
        assert_eq!(value, dir.to_str().unwrap());
        std::env::remove_var("LD_LIBRARY_PATH");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn apply_engine_backend_dir_sets_ld_library_path_with_none_inherited() {
        // The base case: no LD_LIBRARY_PATH in the environment at all (a
        // plain deb/rpm install, not an AppImage). Must still be set to
        // exactly the backend dir, nothing appended.
        let _guard = ld_library_path_env_guard();
        std::env::remove_var("LD_LIBRARY_PATH");
        let dir = std::path::Path::new("/opt/lu/resources/llama/x86_64-unknown-linux-gnu");
        let mut cmd = Command::new("echo");
        apply_engine_backend_dir(&mut cmd, Some(dir));
        let value = cmd
            .get_envs()
            .find(|(k, _)| *k == "LD_LIBRARY_PATH")
            .and_then(|(_, v)| v)
            .expect("LD_LIBRARY_PATH must be set")
            .to_string_lossy()
            .into_owned();
        assert_eq!(value, dir.to_str().unwrap());
    }

    // ── K1-14 (3.0.1): real GetShortPathNameW + a real child spawn ──────────
    //
    // These run only on the Windows box (klaerung-63.md, BERICHT.md #63): a
    // genuinely long directory, a real Windows API call, and a real
    // Command::spawn, not a fake. The pure decision logic above already has
    // its own platform-independent tests; this section proves that the real
    // wiring (utf16_len, GetShortPathNameW, current_dir) actually lets a
    // child process start, which the plain decision tests cannot show.
    //
    // review-longpath.md Runde 1, Auflage 4 (BLOCKER) shaped this section:
    // the PRODUCTION input to `windows_current_dir_for_backend` never carries
    // a `\\?\` prefix (that only exists inside `get_short_path_name`'s own
    // call to `GetShortPathNameW`), so the fixture below builds the long
    // directory in BOTH forms: a verbatim path used only for the filesystem
    // operations that need to survive being over MAX_PATH without
    // LongPathsEnabled (`create_dir_all`, `remove_dir_all`), and a plain,
    // unprefixed path, otherwise identical, that is what actually gets
    // passed to the function under test, matching what `resource_dir()`
    // would hand `apply_engine_backend_dir` for real.

    #[cfg(windows)]
    struct LongDirFixture {
        /// The verbatim form of the TOP-level directory this fixture itself
        /// created (the first of the repeated `component` levels, directly
        /// under `std::env::temp_dir()`). `Drop` removes THIS, not the
        /// bottom (leaf) directory: review-longpath.md Runde 2, Auflage 12
        /// found that removing only the deepest level (what `verbatim` used
        /// to point at) left every level above it behind on the box, run
        /// after run, because a leaf directory has nothing under it for
        /// `remove_dir_all` to recurse into.
        top_level_verbatim: PathBuf,
        /// The plain, unprefixed form of the deepest directory: what the
        /// code under test actually sees, same as it would from
        /// `resource_dir()`.
        plain: PathBuf,
    }

    #[cfg(windows)]
    impl LongDirFixture {
        /// Builds and creates a directory over the classic 258 character
        /// ceiling, and returns both spellings of its path.
        ///
        /// review-longpath.md Runde 2, Auflage 12: the sanity assertion used
        /// to run BEFORE constructing the returned `Self`, so a failing
        /// assertion (this fixture proving out over the limit is itself
        /// meant to be true, but a fixture bug should not compound into a
        /// leaked directory) skipped `Drop` entirely and left the directory
        /// on disk. The assertion now runs AFTER `fixture` is bound to a
        /// local of type `LongDirFixture`, so unwinding drops it and cleans
        /// up regardless of which assertion (here, or in the caller) fails.
        fn create() -> Self {
            use std::os::windows::ffi::OsStrExt;
            let base = std::env::temp_dir();
            let component = "a".repeat(50);
            let top_level_plain = base.join(&component);
            let top_level_verbatim = PathBuf::from(format!(r"\\?\{}", top_level_plain.display()));
            let mut plain = top_level_plain.clone();
            // One 50-character component per iteration, comfortably past 260
            // total once joined with the temp dir and a few levels.
            while plain.as_os_str().encode_wide().count() < 280 {
                plain.push(&component);
            }
            // Only needed to create the leaf directory below: `Drop` cleans
            // up through `top_level_verbatim` instead (see its field doc),
            // so this verbatim form of the leaf is not kept on the struct.
            let verbatim = PathBuf::from(format!(r"\\?\{}", plain.display()));
            std::fs::create_dir_all(&verbatim).expect("create a long verbatim test directory");
            let fixture = LongDirFixture { top_level_verbatim, plain };
            // Sanity check on the fixture itself: this must actually be over
            // the limit, or the test below would pass for the wrong reason.
            assert!(exceeds_classic_current_dir_limit(utf16_len(&fixture.plain)));
            fixture
        }
    }

    #[cfg(windows)]
    impl Drop for LongDirFixture {
        fn drop(&mut self) {
            // Best effort: a failed cleanup must not mask a real test
            // failure (and Drop cannot propagate one anyway). Removes the
            // TOP-level directory (verbatim form: ordinary, non-verbatim
            // removal is itself subject to the classic length limit without
            // LongPathsEnabled), which recursively takes every level
            // underneath it, including the leaf directory `create()` built.
            let _ = std::fs::remove_dir_all(&self.top_level_verbatim);
        }
    }

    #[test]
    #[cfg(windows)]
    fn windows_current_dir_for_backend_uses_the_short_name_and_lets_a_child_spawn() {
        // Expects an 8dot3-enabled volume, the ordinary case and the one
        // BERICHT.md #63 measured on the box (Auflage 4: a test must say
        // which branch it expects, not accept either silently). The
        // dedicated, #[ignore]d test below covers the disabled-volume branch.
        let fixture = LongDirFixture::create();

        let decision = windows_current_dir_for_backend(&fixture.plain);
        let LongPathDecision::UseShortName(short) = decision else {
            panic!(
                "expected UseShortName on an 8dot3-enabled volume, got {decision:?}; if 8dot3 name \
                 creation is disabled on this test volume, run the ignored \
                 windows_current_dir_for_backend_skips_current_dir_when_short_names_are_unavailable test instead"
            );
        };
        // The short name itself must actually be short, or this proves
        // nothing: a no-op GetShortPathNameW that just echoes the long name
        // back (Microsoft's own documented "no short name on-disk" case)
        // would otherwise slip through as a false UseShortName.
        assert!(!exceeds_classic_current_dir_limit(utf16_len(&short)));

        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "exit", "0"]).current_dir(&short);
        let status = cmd.status().expect("cmd.exe must spawn with the resolved short name as current_dir");
        assert!(status.success());
    }

    #[test]
    #[cfg(windows)]
    #[ignore = "needs 8dot3 name creation disabled on the test volume \
                (admin PowerShell: fsutil 8dot3name set 1 <drive>, then create a NEW long \
                directory - fsutil 8dot3name query <drive> confirms the setting first). \
                Not safe to toggle from an automated run, so this stays manual/box-only \
                (review-longpath.md Runde 1, Auflage 4)."]
    fn windows_current_dir_for_backend_skips_current_dir_when_short_names_are_unavailable() {
        let fixture = LongDirFixture::create();

        let decision = windows_current_dir_for_backend(&fixture.plain);
        assert_eq!(
            decision,
            LongPathDecision::SkipCurrentDir,
            "expected SkipCurrentDir with 8dot3 name creation disabled, got {decision:?}"
        );

        // The documented fallback itself must still work: a child with NO
        // current_dir set inherits this test process's own working
        // directory and must spawn without error (it does NOT prove ggml
        // would find its backend from there; review-longpath.md Auflage 3
        // covers the honest user-facing message for that separately).
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "exit", "0"]);
        let status = cmd.status().expect("cmd.exe must spawn even with current_dir left unset");
        assert!(status.success());
    }

    #[test]
    fn the_bundled_sidecar_name_is_ours_and_not_one_debian_already_owns() {
        // GitHub #120 (Ubuntu 26.04): Tauri's deb bundler copies
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
        // The rule is positive, not a list of four forbidden llama names:
        // every SIDECAR the bundler drops into /usr/bin carries our prefix,
        // so the NEXT one cannot walk into #120 either. It is a rule about
        // externalBin only. The main binary lands in /usr/bin too, as
        // locally-uncensored without the prefix, and that name is the deb
        // package's own, so nothing else can claim it. Same rule as
        // src/lib/__tests__/linux-package-owns-its-paths.test.ts, which is
        // the copy CI actually runs.
        fn is_ours(name: &str) -> bool {
            let stem = name.strip_suffix(".exe").unwrap_or(name);
            stem.strip_prefix("lu-").is_some_and(|rest| !rest.is_empty())
        }
        for bundled in &names {
            assert!(
                is_ours(bundled),
                "{bundled} would land in /usr/bin under a name we do not own",
            );
        }
        // Negative control: binaries a distribution package already puts in
        // /usr/bin. None of them may be a name we bundle, and none of them
        // passes the rule above.
        for owned in [
            "llama-server",
            "llama-cli",
            "llama-bench",
            "llama-quantize",
            "llama-embedding",
            "ffmpeg",
        ] {
            assert!(
                !names.contains(&owned),
                "{owned} is owned by a distribution package in /usr/bin, dpkg would refuse the install",
            );
            assert!(!is_ours(owned), "the rule has to reject {owned}");
        }
        assert!(is_ours("lu-llama-server") && is_ours("lu-llama-server.exe"));
        assert!(!is_ours("lu-"), "a bare prefix is not a name");
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
        // right there (2026-08-27).
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

    // ── GH #122: the user's own model folder ───────────────────────────────

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("lu-engine-custom")
            .join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn roots<'a>(app: &'a Path, custom: &'a Path) -> Vec<ScanRoot<'a>> {
        vec![
            ScanRoot { dir: app, max_depth: MAX_SCAN_DEPTH },
            ScanRoot { dir: custom, max_depth: MAX_CUSTOM_SCAN_DEPTH },
        ]
    }

    #[test]
    fn the_custom_folder_is_read_at_the_depth_a_hand_filed_library_needs() {
        // The two shapes from the issue: the folder itself (`G:\AI\Models`)
        // with the model one level down under `Text Generation`, and a library
        // filed by author and repo below that.
        let app = scratch("app-empty");
        let custom = scratch("custom-deep");
        let one = custom.join("Text Generation");
        std::fs::create_dir_all(&one).unwrap();
        std::fs::write(one.join("Cydonia-24B-v4.1-Q4_K_M.gguf"), b"aaaa").unwrap();
        let four = custom
            .join("Text Generation")
            .join("TheDrummer")
            .join("Cydonia-GGUF");
        std::fs::create_dir_all(&four).unwrap();
        std::fs::write(four.join("Rocinante-12B-Q6_K.gguf"), b"bb").unwrap();

        let models = scan_gguf_roots(&roots(&app, &custom)).models;
        let names: Vec<&str> = models.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["Cydonia-24B-v4.1-Q4_K_M", "Rocinante-12B-Q6_K"]);
        // The path is absolute and points into the user's folder, which is
        // what makes the model loadable: llama-server is started with it.
        assert!(models[0].path.contains("Text Generation"));

        std::fs::remove_dir_all(&app).ok();
        std::fs::remove_dir_all(&custom).ok();
    }

    /// Negative control: without the custom root the same folder produces
    /// nothing at all. This is the shipped behaviour GH #122 reported.
    #[test]
    fn without_the_custom_root_the_same_folder_stays_invisible() {
        let app = scratch("app-empty-neg");
        let custom = scratch("custom-neg");
        let one = custom.join("Text Generation");
        std::fs::create_dir_all(&one).unwrap();
        std::fs::write(one.join("Cydonia-24B-v4.1-Q4_K_M.gguf"), b"aaaa").unwrap();

        assert!(scan_gguf_models(&app).is_empty());

        std::fs::remove_dir_all(&app).ok();
        std::fs::remove_dir_all(&custom).ok();
    }

    #[test]
    fn the_app_folder_wins_a_duplicate_name_even_when_it_lies_deeper() {
        let app = scratch("app-dup");
        let custom = scratch("custom-dup");
        let nested = app.join("user").join("repo");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("dup.gguf"), b"a").unwrap();
        std::fs::write(custom.join("dup.gguf"), b"bb").unwrap();

        let models = scan_gguf_roots(&roots(&app, &custom)).models;
        assert_eq!(models.len(), 1, "one id per name");
        assert!(
            models[0].path.contains("app-dup"),
            "the app copy must win: {}",
            models[0].path
        );

        std::fs::remove_dir_all(&app).ok();
        std::fs::remove_dir_all(&custom).ok();
    }

    #[test]
    fn a_split_set_in_the_custom_folder_is_one_entry_and_an_incomplete_one_is_none() {
        let app = scratch("app-shards");
        let custom = scratch("custom-shards");
        std::fs::write(custom.join("Big-00001-of-00002.gguf"), b"a").unwrap();
        std::fs::write(custom.join("Big-00002-of-00002.gguf"), b"bb").unwrap();
        // Negative control in the same folder: a set missing part 2 is not a
        // model and must not be offered.
        std::fs::write(custom.join("Half-00001-of-00003.gguf"), b"c").unwrap();

        let models = scan_gguf_roots(&roots(&app, &custom)).models;
        let names: Vec<&str> = models.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["Big"]);
        assert_eq!(models[0].size, 3, "the set weighs both parts");

        std::fs::remove_dir_all(&app).ok();
        std::fs::remove_dir_all(&custom).ok();
    }

    #[test]
    fn the_scan_list_drops_blanks_duplicates_and_the_app_dir_named_again() {
        let app = Path::new("/data/Locally Uncensored/models");
        let dirs = bundled_scan_dirs(
            app,
            &[
                "  ".to_string(),
                "G:\\AI\\Models".to_string(),
                // The same folder with a trailing slash and the other
                // separator: one entry, on every platform.
                "G:/AI/Models/".to_string(),
                "/data/Locally Uncensored/models".to_string(),
                "/mnt/second".to_string(),
            ],
        );
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/data/Locally Uncensored/models"),
                PathBuf::from("G:\\AI\\Models"),
                PathBuf::from("/mnt/second"),
            ],
        );
    }

    /// Case folding follows the file system, not the developer's machine.
    ///
    /// Windows and a default macOS volume are case-insensitive, so `g:/ai` and
    /// `G:/AI` are one folder and folding them is what stops a double walk. On
    /// Linux they are two folders, and folding would silently drop one of them.
    #[test]
    fn two_spellings_are_one_folder_only_where_the_file_system_says_so() {
        let app = Path::new("/data/models");
        let dirs = bundled_scan_dirs(
            app,
            &["/mnt/Models".to_string(), "/mnt/models".to_string()],
        );
        if cfg!(target_os = "linux") {
            assert_eq!(dirs.len(), 3, "ext4 keeps both: {dirs:?}");
        } else {
            assert_eq!(dirs.len(), 2, "one folder under two spellings: {dirs:?}");
        }
        // Either way the first entry given wins, so the app dir stays root 0.
        assert_eq!(dirs[0], PathBuf::from("/data/models"));
    }

    // ── The scan has to come back (S1, S6) ────────────────────────────────

    #[test]
    fn a_root_that_is_gone_or_relative_is_named_and_costs_the_others_nothing() {
        let app = scratch("status-app");
        std::fs::write(app.join("real.gguf"), b"a").unwrap();
        let gone = scratch("status-gone");
        std::fs::remove_dir_all(&gone).unwrap();
        let relative = PathBuf::from("some/relative/models");

        // P3, 7.4: ein vierter Root, der da ist und den dieses Konto nicht
        // lesen darf. Unter Windows laesst sich das in einem Unit-Test nicht
        // herstellen (eine ACL ohne Leserecht fuer den eigenen Benutzer
        // braucht eine zweite Identitaet), dort steht der Beweis auf der Box.
        // Laeuft der Test als root, liest read_dir trotzdem, und dann wird der
        // Fall ehrlich uebersprungen statt gruen gefaerbt.
        #[cfg(unix)]
        let denied = {
            use std::os::unix::fs::PermissionsExt;
            let d = scratch("status-denied");
            std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o000)).unwrap();
            d
        };
        #[cfg(unix)]
        let denied_holds = std::fs::read_dir(&denied).is_err();

        // Only the unix branch below pushes; Windows clippy runs -D warnings.
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut roots = vec![
            ScanRoot { dir: &app, max_depth: MAX_SCAN_DEPTH },
            ScanRoot { dir: &gone, max_depth: MAX_CUSTOM_SCAN_DEPTH },
            ScanRoot { dir: &relative, max_depth: MAX_CUSTOM_SCAN_DEPTH },
        ];
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut expected = vec![RootStatus::Ok, RootStatus::Unreachable, RootStatus::Unusable];
        #[cfg(unix)]
        if denied_holds {
            roots.push(ScanRoot { dir: &denied, max_depth: MAX_CUSTOM_SCAN_DEPTH });
            expected.push(RootStatus::Denied);
        }

        let outcome = scan_gguf_roots(&roots);
        // Der Gegenpol steht in derselben Liste: der geloeschte Ordner bleibt
        // unreachable. Ohne ihn haette man beide Faelle auf einen neuen Wert
        // gelegt und nichts unterschieden.
        assert_eq!(outcome.statuses, expected);
        // The app folder still answered, which is the point: one bad root is
        // not allowed to cost the list.
        assert_eq!(outcome.models.len(), 1);
        assert_eq!(outcome.models[0].name, "real");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o700));
            std::fs::remove_dir_all(&denied).ok();
        }
        std::fs::remove_dir_all(&app).ok();
    }

    #[test]
    fn a_folder_too_big_for_the_budget_returns_what_it_has_and_says_so() {
        // The entry budget is the ceiling that does not depend on how fast the
        // disk is, so it is the one a test can hold.
        let app = scratch("budget-app");
        let big = scratch("budget-big");
        for i in 0..(SCAN_ENTRY_BUDGET + 50) {
            std::fs::write(big.join(format!("m{i:05}.gguf")), b"a").unwrap();
        }

        let outcome = scan_gguf_roots(&[
            ScanRoot { dir: &app, max_depth: MAX_SCAN_DEPTH },
            ScanRoot { dir: &big, max_depth: MAX_CUSTOM_SCAN_DEPTH },
        ]);
        assert_eq!(outcome.statuses, vec![RootStatus::Ok, RootStatus::Truncated]);
        // What came back is real, there is just not all of it.
        assert!(!outcome.models.is_empty());
        assert!(outcome.models.len() <= SCAN_ENTRY_BUDGET);

        std::fs::remove_dir_all(&app).ok();
        std::fs::remove_dir_all(&big).ok();
    }

    /// Negative control: a folder that fits reports Ok and the complete list.
    /// Without this, "truncated" above could just be the scan's normal answer.
    #[test]
    fn a_folder_inside_the_budget_reports_ok_and_everything_in_it() {
        let app = scratch("budget-small-app");
        let small = scratch("budget-small");
        for i in 0..10 {
            std::fs::write(small.join(format!("m{i}.gguf")), b"a").unwrap();
        }
        let outcome = scan_gguf_roots(&[
            ScanRoot { dir: &app, max_depth: MAX_SCAN_DEPTH },
            ScanRoot { dir: &small, max_depth: MAX_CUSTOM_SCAN_DEPTH },
        ]);
        assert_eq!(outcome.statuses, vec![RootStatus::Ok, RootStatus::Ok]);
        assert_eq!(outcome.models.len(), 10);

        std::fs::remove_dir_all(&app).ok();
        std::fs::remove_dir_all(&small).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_model_reached_through_a_symlink_reports_the_models_size() {
        // The HuggingFace cache layout: the real bytes sit in blobs/, and
        // snapshots/<rev>/<name>.gguf is a link to them. entry.metadata() does
        // not follow the link and reported the link's own size.
        let app = scratch("symlink-app");
        let custom = scratch("symlink-custom");
        let blobs = custom.join("blobs");
        let snap = custom.join("snapshots").join("abc123");
        std::fs::create_dir_all(&blobs).unwrap();
        std::fs::create_dir_all(&snap).unwrap();
        let real = blobs.join("deadbeef");
        std::fs::write(&real, vec![7u8; 4096]).unwrap();
        std::os::unix::fs::symlink(&real, snap.join("Cydonia-Q4_K_M.gguf")).unwrap();

        let outcome = scan_gguf_roots(&[
            ScanRoot { dir: &app, max_depth: MAX_SCAN_DEPTH },
            ScanRoot { dir: &custom, max_depth: MAX_CUSTOM_SCAN_DEPTH },
        ]);
        let found = outcome
            .models
            .iter()
            .find(|m| m.name == "Cydonia-Q4_K_M")
            .expect("the linked model must be listed");
        assert_eq!(found.size, 4096, "the link's own size is not the model's");

        std::fs::remove_dir_all(&app).ok();
        std::fs::remove_dir_all(&custom).ok();
    }

    /// Negative control for the same walk: a symlink pointing back at its own
    /// parent must not spin. The entry budget is what stops it.
    #[cfg(unix)]
    #[test]
    fn a_symlink_loop_ends_instead_of_running_forever() {
        let app = scratch("loop-app");
        let custom = scratch("loop-custom");
        let inner = custom.join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(inner.join("real.gguf"), b"abc").unwrap();
        std::os::unix::fs::symlink(&custom, inner.join("back")).unwrap();

        let started = Instant::now();
        let outcome = scan_gguf_roots(&[
            ScanRoot { dir: &app, max_depth: MAX_SCAN_DEPTH },
            ScanRoot { dir: &custom, max_depth: MAX_CUSTOM_SCAN_DEPTH },
        ]);
        assert!(started.elapsed() < SCAN_DEADLINE * 3, "the walk did not come back");
        assert!(outcome.models.iter().any(|m| m.name == "real"));

        std::fs::remove_dir_all(&app).ok();
        std::fs::remove_dir_all(&custom).ok();
    }

    /// Negative control: no custom folder set leaves the list exactly as it
    /// shipped, one root.
    #[test]
    fn no_custom_folder_leaves_one_root() {
        let app = Path::new("/data/Locally Uncensored/models");
        assert_eq!(bundled_scan_dirs(app, &[]), vec![PathBuf::from(app)]);
        assert_eq!(
            bundled_scan_dirs(app, &["".to_string(), "   ".to_string()]),
            vec![PathBuf::from(app)],
        );
    }

    /// A port nothing on this machine serves, so `engine_healthy` answers
    /// "refused" immediately instead of talking to a real engine.
    const DEAD_PORT: u16 = 49871;

    /// A `(binary, args)` pair that runs for `secs` seconds without going
    /// through a shell, the shape `restore_engine`'s callers hand it after a
    /// real launch (a binary path plus its own argv), so a shell cannot be
    /// substituted in like `test_support::sleeper` does for a bare `Command`.
    ///
    /// Windows: `ping`, same binary and reasoning as `test_support::sleeper`:
    /// `<shell> -c "sleep N"` gets exec-optimised by the MSYS runtime into a
    /// BRAND NEW Windows process while the shell that was supposed to hold the
    /// pid exits, so the `Child` this test tracks would already show as dead.
    /// Unix: `sleep` directly; no shell needed there either.
    fn long_lived_argv(secs: u32) -> (PathBuf, Vec<String>) {
        if cfg!(windows) {
            (
                PathBuf::from("ping"),
                vec!["-n".to_string(), (secs + 1).to_string(), "127.0.0.1".to_string()],
            )
        } else {
            (PathBuf::from("sleep"), vec![secs.to_string()])
        }
    }

    fn park_child(state: &AppState, child: std::process::Child) {
        *state.bundled_engine.lock().unwrap() = Some(BundledEngine {
            child,
            model_path: "/tmp/does-not-matter.gguf".into(),
            port: DEAD_PORT,
            ctx: Some(8192),
            args: Vec::new(),
            auto_layers: false,
            cpu_fallback: false,
            sanity_note: None,
            image_part_note: None,
        });
    }

    #[test]
    fn a_child_that_dies_on_start_is_reported_at_once_and_not_after_the_budget() {
        // GH #118: the health wait watched only the port, so an engine that
        // exited in the first second (a missing runtime library, a GPU backend
        // that will not initialise) still burned the whole budget before the
        // user was told anything. The budget here is 30s; the answer has to
        // arrive in a fraction of that.
        //
        // The shell is resolved, not spelled `sh`: on Windows that name is not
        // on PATH at all and a bare `bash` is the WSL alias stub. See
        // `test_support::posix_shell`.
        let state = AppState::new();
        let child = std::process::Command::new(crate::test_support::posix_shell())
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

        // The exit code rides along now (bug o): the child was told to exit
        // with 3, and 3 is what the log line has to be able to print. This
        // used to be thrown away at the `is_some()` above, and a support log
        // that says "it exited" without saying how is a log that cannot tell a
        // refused GGUF from a card that ran out of memory.
        assert_eq!(out, HealthWait::ChildExited { code: Some(3), signal: None });
        assert!(took < Duration::from_secs(5), "waited {took:?}, which is the old dead wait");
    }

    // ── Der Rueckfall nach einem misslungenen Wechsel ─────────────────────
    //
    // Gegenprobe zu 29f22a1a am 03.09.2026: ein Klick auf eine kaputte GGUF
    // beendete die laufende, gesunde Engine 0,4 s spaeter und liess den
    // Nutzer ohne Chat zurueck. Der Wechsel ist ein Halt und ein Start; nur
    // der Halt war sicher.

    /// Ein winziger Server, der auf `/health` mit 200 antwortet, bis der
    /// Schalter faellt. Damit ist der GESUNDE Ausgang von
    /// `spawn_engine_attempt` pruefbar, ohne eine echte llama-server-Binaerdatei:
    /// die Funktion fragt nur diesen einen Port.
    fn gesunder_port() -> (u16, Arc<AtomicBool>, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let mein_stop = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            while !mein_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut sock, _)) => {
                        let mut puffer = [0u8; 1024];
                        let _ = sock.set_read_timeout(Some(Duration::from_millis(200)));
                        let _ = sock.read(&mut puffer);
                        let _ = sock.write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                        );
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(20)),
                }
            }
        });
        (port, stop, handle)
    }

    #[test]
    fn a_failed_switch_puts_the_previous_model_back_on_its_own_port() {
        let (port, stop, handle) = gesunder_port();
        let state = AppState::new();
        let (binary, args) = long_lived_argv(30);
        let vorher = PreviousEngine {
            model_path: "/tmp/hermes.gguf".into(),
            args,
            auto_layers: false,
            cpu_fallback: false,
            port,
            ctx: Some(8192),
            image_part_note: None,
        };

        let zurueck = restore_engine(&binary, &state, &vorher, None);

        assert!(zurueck, "the previous engine did not come back");
        {
            let guard = state.bundled_engine.lock().unwrap();
            let e = guard.as_ref().expect("the slot is empty after a restore");
            // Genau das alte Modell, auf genau seinem Port, mit genau seinem
            // Kontext. Ein Rueckfall, der irgendetwas anderes startet, waere
            // schlimmer als keiner: der Nutzer chattet dann mit einem Modell,
            // das er nie gewaehlt hat.
            assert_eq!(e.model_path, "/tmp/hermes.gguf");
            assert_eq!(e.port, port);
            assert_eq!(e.ctx, Some(8192));
            assert_eq!(e.args, vorher.args);
        }

        stop.store(true, Ordering::Relaxed);
        let mut engine = state.bundled_engine.lock().unwrap().take().unwrap();
        let _ = engine.child.kill();
        let _ = engine.child.wait();
        let _ = handle.join();
    }

    #[test]
    fn a_restore_that_fails_says_so_instead_of_claiming_success() {
        // Negativkontrolle. Ohne sie ginge der Fall oben auch auf einer
        // Funktion durch, die einfach immer `true` zurueckgibt, und die
        // Fehlermeldung verspraeche dem Nutzer ein Modell, das nicht laeuft.
        let state = AppState::new();
        let vorher = PreviousEngine {
            model_path: "/tmp/hermes.gguf".into(),
            args: vec!["-c".into(), "exit 1".into()],
            auto_layers: false,
            cpu_fallback: false,
            port: DEAD_PORT,
            ctx: Some(8192),
            image_part_note: None,
        };

        assert!(!restore_engine(
            Path::new(&crate::test_support::posix_shell()),
            &state,
            &vorher,
            None,
        ));
        assert!(
            state.bundled_engine.lock().unwrap().is_none(),
            "a dead child was left in the slot, so the app would report it as running"
        );
    }

    #[test]
    fn every_failed_switch_runs_through_the_fallback() {
        // Quellanker: der Wechsel merkt sich die laufende Engine VOR dem Stopp
        // und hat genau EINEN Fehlerausgang, der den Rueckfall versucht. Vier
        // einzelne `return Err` im selben Rumpf waren der Grund, warum der
        // Rueckfall ueberhaupt fehlen konnte.
        let src = include_str!("engine.rs");
        let wechsel = src
            .split("fn start_bundled_engine_locked(")
            .nth(1)
            .expect("the switch is gone")
            .split("\nfn ")
            .next()
            .unwrap();
        assert!(
            wechsel.contains("let vorher = {"),
            "the switch no longer remembers what was serving"
        );
        assert!(
            wechsel.contains("restore_engine("),
            "the switch no longer brings the previous engine back"
        );
        // Der Stopp steht VOR dem Start, sonst gaebe es nichts zu merken.
        let stopp = wechsel.find("stop_engine_locked(state);").expect("no stop");
        let merken = wechsel.find("let vorher = {").expect("no memory");
        assert!(merken < stopp, "the engine is stopped before it is remembered");
        // Und der Startweg danach ist EINE Funktion, nicht wieder ein Rumpf
        // mit eigenen Ausgaengen.
        assert!(wechsel.contains("start_after_stop("));
        // Die gute Nachricht wird eingesetzt, nicht angehaengt. Ein
        // `format!("{msg}\n\n...")` schoebe sie wieder hinter das Protokoll.
        let ausgang = src
            .split("fn settle_switch(")
            .nth(1)
            .expect("the one exit of the switch is gone")
            .split("\nfn ")
            .next()
            .unwrap();
        assert!(wechsel.contains("settle_switch("), "the switch no longer ends in its one exit");
        assert!(
            ausgang.contains("with_note_on_top(&msg, RESTORED_NOTE)"),
            "the good news is appended again instead of put on top"
        );
    }

    #[test]
    fn the_retry_in_start_after_stop_runs_the_sanity_probe_too() {
        // R1-10: `start_after_stop`'s FIRST attempt success path always ran
        // the sanity probe (bug a) through `serve_or_heal_garbled`, but the
        // SECOND attempt (the one clean retry) used to hand back a bare
        // "started" object instead, a garbled answer on the retry was
        // never caught or healed. `serve_or_heal_garbled(` must appear once
        // per way this function can come up: the first attempt, the clean
        // retry, and (since October 2026) the retry without the image part.
        let src = include_str!("engine.rs");
        let body = src
            .split("fn start_after_stop(")
            .nth(1)
            .expect("start_after_stop is gone")
            .split("\nfn ")
            .next()
            .unwrap();
        let count = body.matches("serve_or_heal_garbled(").count();
        assert_eq!(count, 3, "expected the sanity probe on all three ways up, found it {count} time(s)");
    }

    #[test]
    fn die_gute_nachricht_steht_ueber_dem_protokoll_und_nicht_darunter() {
        let f = StartFailure {
            died: true,
            port_taken: false,
            stderr: KAPUTTE_VERSION_STDERR.into(),
            exit_code: None, signal: None };
        let msg = with_note_on_top(
            &start_failure_message(&f, 8127, Duration::from_secs(60), SecondAttempt::SameOffload, None),
            RESTORED_NOTE,
        );
        let notiz = msg.find(RESTORED_NOTE).expect("the note is gone");
        let protokoll = msg.find("gguf_init_from_reader").expect("the log is gone");
        assert!(
            notiz < protokoll,
            "the note sits behind the engine log again:\n{msg}"
        );
        // Und der Satz mit dem Handlungsvorschlag bleibt ganz oben.
        assert!(msg.find("could not read the model file").unwrap() < notiz, "{msg}");
    }

    #[test]
    fn eine_meldung_ganz_ohne_protokoll_bekommt_die_notiz_trotzdem() {
        // Negativkontrolle zum Aufteilen: ohne Leerzeile gibt es nichts zu
        // trennen, und die Notiz darf nicht verloren gehen.
        let msg = with_note_on_top("Es ging schief.", RESTORED_NOTE);
        assert_eq!(msg, format!("Es ging schief.\n\n{RESTORED_NOTE}"));
    }

    #[test]
    fn an_empty_engine_slot_is_not_something_to_wait_for() {
        let state = AppState::new();
        let began = Instant::now();
        // No child, so there is no exit code to report either.
        assert_eq!(
            wait_for_health_or_exit(&state, DEAD_PORT, Duration::from_secs(30)),
            HealthWait::ChildExited { code: None, signal: None }
        );
        assert!(began.elapsed() < Duration::from_secs(5));
    }

    // ── A15, the two engine findings of the Windows Nachlauf ───────────────

    /// One engine handle around an arbitrary child, for the reaping tests.
    fn engine_around(child: std::process::Child, port: u16) -> Option<BundledEngine> {
        Some(BundledEngine {
            child,
            model_path: "/tmp/does-not-matter.gguf".into(),
            port,
            ctx: Some(8192),
            args: Vec::new(),
            auto_layers: false,
            cpu_fallback: false,
            sanity_note: None,
            image_part_note: None,
        })
    }

    #[test]
    fn a_status_read_says_that_the_engine_ended_up_on_the_processor() {
        // The fallback was answered ONCE, in the return value of the start
        // call, and then forgotten. A status read a minute later described an
        // engine that ran at a tenth of its speed as an ordinary one.
        let child = crate::test_support::sleeper(30)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a long lived child");
        let mut slot = engine_around(child, DEFAULT_ENGINE_PORT);
        {
            let e = slot.as_mut().unwrap();
            e.cpu_fallback = true;
            e.args = build_server_args(
                "/m.gguf",
                &EngineTuning { gpu_layers: 0, ..Default::default() },
                DEFAULT_ENGINE_PORT,
                None,
                None,
                None,
            );
        }

        let seen = live_sidecar(&mut slot).expect("the engine is running");
        assert!(seen.cpu_fallback, "the fallback did not survive the status read");
        assert_eq!(seen.gpu_layers, Some(0));

        let mut engine = slot.take().unwrap();
        let _ = engine.child.kill();
        let _ = engine.child.wait();
    }

    #[test]
    fn a_status_read_carries_what_the_sanity_probe_worked_around() {
        // Bug a: the ladder answered its sentence ONCE, in the return value of
        // the start call, and nobody reads that object past `.port`. The
        // status is what every surface polls, so the sentence lives there.
        let child = crate::test_support::sleeper(30)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a long lived child");
        let mut slot = engine_around(child, DEFAULT_ENGINE_PORT);
        slot.as_mut().unwrap().sanity_note = Some(engine_sanity::HEALED_WITHOUT_FLASH_ATTENTION_NOTE);

        let seen = live_sidecar(&mut slot).expect("the engine is running");
        assert_eq!(seen.sanity_note, Some(engine_sanity::HEALED_WITHOUT_FLASH_ATTENTION_NOTE));
        // The flash attention rung keeps the card, so it is NOT a CPU fallback.
        assert!(!seen.cpu_fallback);

        let mut engine = slot.take().unwrap();
        let _ = engine.child.kill();
        let _ = engine.child.wait();
    }

    #[test]
    fn a_typed_cpu_setting_is_not_reported_as_a_failed_start() {
        // The counter-check to the test above. Someone who wrote 0 into GPU
        // Layers got what he asked for, and telling him the graphics card
        // failed would be an invention.
        let child = crate::test_support::sleeper(30)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a long lived child");
        let mut slot = engine_around(child, DEFAULT_ENGINE_PORT);
        slot.as_mut().unwrap().args = build_server_args(
            "/m.gguf",
            &EngineTuning { gpu_layers: 0, ..Default::default() },
            DEFAULT_ENGINE_PORT,
            None,
            None,
            None,
        );

        let seen = live_sidecar(&mut slot).expect("the engine is running");
        assert!(!seen.cpu_fallback, "a typed setting was reported as a fallback");
        assert_eq!(seen.gpu_layers, Some(0));

        let mut engine = slot.take().unwrap();
        let _ = engine.child.kill();
        let _ = engine.child.wait();
    }

    #[test]
    fn an_engine_killed_from_outside_stops_counting_as_running() {
        // The box: `Stop-Process` on lu-llama-server, and the line kept saying
        // "Engine running / Port: 8127" for as long as anyone watched.
        let mut child = std::process::Command::new(crate::test_support::posix_shell())
            .args(["-c", "exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a child that exits immediately");
        // Let it actually die before asking, otherwise the test races the OS.
        let _ = child.wait();
        let mut slot = engine_around(child, DEFAULT_ENGINE_PORT);

        assert!(reap_dead_engine(&mut slot), "a dead process was not noticed");
        assert!(slot.is_none(), "the handle survived its process");
        // And a second look is quiet: nothing left to reap, nothing to log.
        assert!(!reap_dead_engine(&mut slot));
    }

    #[test]
    fn a_living_engine_is_left_exactly_where_it_is() {
        // Negative control. Without it the test above would pass on a function
        // that simply cleared the slot every time.
        let child = crate::test_support::sleeper(30)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a long lived child");
        let mut slot = engine_around(child, DEFAULT_ENGINE_PORT);

        assert!(!reap_dead_engine(&mut slot), "a live engine was declared dead");
        assert!(slot.is_some());
        assert_eq!(slot.as_ref().unwrap().port, DEFAULT_ENGINE_PORT);

        let mut engine = slot.take().unwrap();
        let _ = engine.child.kill();
        let _ = engine.child.wait();
    }

    #[test]
    fn a_status_read_reports_nothing_for_a_sidecar_whose_process_is_gone() {
        // The embeddings server had no reaping at all, so a killed sidecar kept
        // answering "running" on 8128 the way the chat engine used to on 8127.
        // Both status commands go through live_sidecar now, so this covers the
        // pair (A15 review).
        let mut child = std::process::Command::new(crate::test_support::posix_shell())
            .args(["-c", "exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a child that exits immediately");
        let _ = child.wait();
        let mut slot = engine_around(child, DEFAULT_EMBED_PORT);

        assert_eq!(live_sidecar(&mut slot), None, "a dead sidecar was reported as running");
        assert!(slot.is_none(), "the handle survived its process");
    }

    #[test]
    fn a_status_read_reports_a_sidecar_that_is_really_there() {
        // Negative control for the test above: live_sidecar must not simply
        // answer None.
        let child = crate::test_support::sleeper(30)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a long lived child");
        let mut slot = engine_around(child, DEFAULT_EMBED_PORT);

        let seen = live_sidecar(&mut slot);
        assert_eq!(seen.as_ref().map(|s| s.port), Some(DEFAULT_EMBED_PORT));
        assert!(slot.is_some());

        let mut engine = slot.take().unwrap();
        let _ = engine.child.kill();
        let _ = engine.child.wait();
    }

    // ── A16: the watch that says a sidecar died without being asked ─────────

    #[test]
    fn the_watch_names_the_port_of_a_sidecar_that_died() {
        // What the loop does once per tick. The port has to come out of the
        // slot before the reap clears it, which is the whole reason this is a
        // function and not two lines inside the thread.
        let mut child = std::process::Command::new(crate::test_support::posix_shell())
            .args(["-c", "exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a child that exits immediately");
        let _ = child.wait();
        let mut slot = engine_around(child, DEFAULT_ENGINE_PORT);

        assert_eq!(
            reaped_sidecar_port(&mut slot),
            Some(DEFAULT_ENGINE_PORT),
            "the watch could not say which sidecar had gone",
        );
        assert!(slot.is_none(), "the handle survived its process");
        // A second tick has nothing to report: the event fires once, not on
        // every tick for the rest of the session.
        assert_eq!(reaped_sidecar_port(&mut slot), None);
    }

    #[test]
    fn the_watch_stays_quiet_about_a_sidecar_that_is_still_running() {
        // Negative control. Without it the test above would pass on a watch
        // that announced a death on every tick and cleared the slot with it,
        // which would take the running engine off the screen.
        let child = crate::test_support::sleeper(30)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a long lived child");
        let mut slot = engine_around(child, DEFAULT_EMBED_PORT);

        assert_eq!(reaped_sidecar_port(&mut slot), None, "a live sidecar was declared dead");
        assert!(slot.is_some());

        let mut engine = slot.take().unwrap();
        let _ = engine.child.kill();
        let _ = engine.child.wait();
    }

    #[test]
    fn the_watch_looks_often_enough_to_beat_the_five_second_promise() {
        // The display has to be right within five seconds of a kill. The tick
        // is the coarse half of that budget (the UI's own poll is the other),
        // so a tick slower than the promise would break it silently.
        assert!(
            SIDECAR_WATCH_INTERVAL <= Duration::from_secs(2),
            "the sidecar watch ticks too slowly to keep the five second promise",
        );
    }

    #[test]
    fn an_empty_slot_has_nothing_to_reap() {
        let mut slot: Option<BundledEngine> = None;
        assert!(!reap_dead_engine(&mut slot));
        assert!(slot.is_none());
    }

    #[test]
    fn a_restart_takes_the_default_port_back_as_soon_as_it_is_free() {
        // The exact walk from the box: 8127 held, engine moves to 8129, the
        // blocker goes away, "Apply & Restart Engine" is pressed.
        let moved = DEFAULT_ENGINE_PORT + 2;
        assert!(
            !may_keep_engine_where_it_is(moved, DEFAULT_ENGINE_PORT, || true),
            "the engine stayed on the fallback port with 8127 free, which is the bug"
        );
        // While the blocker is still there, the fallback is the right place and
        // nothing is torn down for nothing.
        assert!(may_keep_engine_where_it_is(moved, DEFAULT_ENGINE_PORT, || false));
        // An engine already on the preferred port is kept without asking, which
        // is what keeps a bind probe off the common path.
        assert!(may_keep_engine_where_it_is(
            DEFAULT_ENGINE_PORT,
            DEFAULT_ENGINE_PORT,
            || panic!("the free-port probe must not run for an engine already at home"),
        ));
    }

    // ── GH #118, the port half ─────────────────────────────────────────────

    #[test]
    fn the_preferred_port_comes_first_and_the_embed_port_is_never_offered() {
        let c = engine_port_candidates(DEFAULT_ENGINE_PORT);
        assert_eq!(c[0], DEFAULT_ENGINE_PORT, "the preferred port is tried first");
        assert!(
            !c.contains(&DEFAULT_EMBED_PORT),
            "taking 8128 would break Document-Chat instead of fixing chat: {c:?}"
        );
        assert_eq!(c.len(), PORT_SEARCH_SPAN as usize + 1, "the walk stays bounded");
        // Negative control: without the skip the second candidate WOULD be the
        // embed port, so the assertion above is really testing the skip.
        assert_eq!(DEFAULT_ENGINE_PORT + 1, DEFAULT_EMBED_PORT);
        assert_eq!(c[1], DEFAULT_EMBED_PORT + 1);
    }

    #[test]
    fn the_walk_ends_instead_of_wrapping_at_the_top_of_the_range() {
        let c = engine_port_candidates(u16::MAX - 2);
        assert_eq!(c, vec![u16::MAX - 2, u16::MAX - 1, u16::MAX]);
    }

    #[test]
    fn a_taken_preferred_port_becomes_the_next_free_one() {
        // The 2.6.6 answer to this situation was an error telling the user to
        // quit a process or reboot. It is a port, and there are others.
        let c = engine_port_candidates(DEFAULT_ENGINE_PORT);
        let taken = [DEFAULT_ENGINE_PORT, DEFAULT_EMBED_PORT + 1];
        let picked = first_usable_port(&c, |p| !taken.contains(&p));
        assert_eq!(picked, Some(DEFAULT_EMBED_PORT + 2));
        // Negative control: nothing free at all is the one case that has to
        // become a message rather than a silent hop.
        assert_eq!(first_usable_port(&c, |_| false), None);
    }

    #[test]
    fn a_completely_blocked_block_says_which_ports_it_tried() {
        let c = engine_port_candidates(DEFAULT_ENGINE_PORT);
        let msg = no_free_port_message(DEFAULT_ENGINE_PORT, *c.last().unwrap());
        assert!(msg.contains("8127"), "{msg}");
        assert!(msg.contains(&c.last().unwrap().to_string()), "{msg}");
        assert!(
            !msg.contains('\u{2014}') && !msg.contains('\u{2013}'),
            "no dashes: {msg}"
        );
    }

    #[test]
    fn a_bind_failure_is_recognised_on_every_platform_wording() {
        // llama.cpp on Linux/macOS, plus the two Winsock numbers Windows uses.
        // 10013 is the one that matters most: a port inside a reserved range
        // answers "permission denied" while nothing is listening on it.
        assert!(stderr_blames_the_port("error: bind: Address already in use"));
        assert!(stderr_blames_the_port("failed to bind to 127.0.0.1:8127"));
        assert!(stderr_blames_the_port("bind error 10048"));
        assert!(stderr_blames_the_port("WSAEACCES (10013)"));
        // Negative control: a GPU death must not be mistaken for a port death,
        // or the retry would move the port and change nothing.
        assert!(!stderr_blames_the_port(
            "ggml_backend_alloc: CUDA error: out of memory"
        ));
        assert!(!stderr_blames_the_port("failed to load model"));
    }

    #[test]
    fn a_port_death_gets_its_own_sentence_instead_of_the_reinstall_advice() {
        let failure = StartFailure {
            died: true,
            port_taken: false,
            stderr: "bind: Address already in use".into(),
            exit_code: None, signal: None };
        let msg = start_failure_message(&failure, 8127, Duration::from_secs(60), SecondAttempt::SameOffload, None);
        assert!(msg.contains("could not open port 8127"), "{msg}");
        assert!(
            !msg.contains("Reinstall"),
            "a busy port is not a broken installation: {msg}"
        );
        // Negative control: an unclassified death keeps the old advice.
        let other = StartFailure {
            died: true,
            port_taken: false,
            stderr: "something went wrong".into(),
            exit_code: None, signal: None };
        assert!(start_failure_message(&other, 8127, Duration::from_secs(60), SecondAttempt::SameOffload, None).contains("Reinstall"));
    }

    #[test]
    fn a_cuda_allocation_that_happens_to_contain_10048_is_not_a_busy_port() {
        // S1. llama.cpp prints allocation sizes in MiB, so a 10 GB buffer reads
        // "10048.00 MiB". As a bare substring that number used to make a CUDA
        // out-of-memory look like a taken port: the user lost the GPU-Layers
        // way out and the retry hopped to another port for nothing.
        let oom = "ggml_backend_cuda_buffer_type_alloc_buffer: allocating 10048.00 MiB on device 0 failed\nCUDA error: out of memory";
        assert!(!stderr_blames_the_port(oom));
        assert!(stderr_blames_the_gpu(oom));
        let failure = StartFailure { died: true, port_taken: false, stderr: oom.into() , exit_code: None, signal: None };
        let msg = start_failure_message(&failure, 8127, Duration::from_secs(60), SecondAttempt::SameOffload, None);
        assert!(msg.contains("GPU Layers to 0"), "the way out has to survive: {msg}");
        assert!(!msg.contains("could not open port"), "{msg}");
    }

    #[test]
    fn a_winsock_number_still_counts_on_a_line_that_is_about_a_socket() {
        // The same number, in the sentence it actually belongs to.
        assert!(stderr_blames_the_port(
            "bind() failed with WSAGetLastError 10048"
        ));
        assert!(stderr_blames_the_port(
            "error creating server socket: 10013"
        ));
        // Negative control: the number alone, on a line about nothing else.
        assert!(!stderr_blames_the_port("model buffer size = 10013.50 MiB"));
        // Negative control across lines: a socket word elsewhere in the tail
        // must not lend context to a number on a different line.
        assert!(!stderr_blames_the_port(
            "srv start: listening\nkv cache size = 10048.00 MiB"
        ));
    }

    #[test]
    fn a_real_bind_sentence_on_an_nvidia_box_still_reads_as_a_port() {
        // Every start on an NVIDIA box drags "cuda" through the log, so the
        // graphics branch must not adopt a failure that names the socket. This
        // is the bundled binary's own wording, measured 2026-09-02.
        let stderr = "ggml_cuda_init: found 1 CUDA devices\nsrv start: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 8127";
        // The banner is there and says nothing: naming the card is not the
        // same as failing on it. Until 03.09.2026 the bare word "cuda" was
        // enough, and the branch order was the only thing keeping this case
        // out of the graphics-card answer.
        assert!(!stderr_blames_the_gpu(stderr), "a banner is not a defect");
        let failure = StartFailure { died: true, port_taken: false, stderr: stderr.into() , exit_code: None, signal: None };
        let msg = start_failure_message(&failure, 8127, Duration::from_secs(60), SecondAttempt::SameOffload, None);
        assert!(msg.contains("could not open port 8127"), "{msg}");
        assert!(!msg.contains("GPU Layers"), "a busy port is not freed by CPU mode: {msg}");
    }

    #[test]
    fn the_retry_moves_to_another_port_only_when_the_port_was_the_cause() {
        // S7: the decision the retry makes, without spawning anything. This is
        // the shape of the code in start_bundled_engine_blocking.
        let hop = |stderr: &str, tried: u16| -> u16 {
            if stderr_blames_the_port(stderr) {
                let rest: Vec<u16> = engine_port_candidates(DEFAULT_ENGINE_PORT)
                    .into_iter()
                    .filter(|p| *p != tried)
                    .collect();
                first_usable_port(&rest, |p| p != tried).unwrap_or(tried)
            } else {
                tried
            }
        };
        assert_ne!(
            hop("srv start: couldn't bind HTTP server socket", DEFAULT_ENGINE_PORT),
            DEFAULT_ENGINE_PORT,
            "a port death has to land somewhere else"
        );
        // Negative control: a GPU death retries on the SAME port, because the
        // VRAM this function asked for is released asynchronously and the port
        // was never the problem.
        assert_eq!(
            hop("CUDA error: out of memory", DEFAULT_ENGINE_PORT),
            DEFAULT_ENGINE_PORT
        );
        assert_eq!(hop("10048.00 MiB", DEFAULT_ENGINE_PORT), DEFAULT_ENGINE_PORT);
    }

    #[test]
    fn a_slow_load_stays_recognisable_as_a_timeout_for_the_frontend() {
        // Contract with lib/engine-start-failure.ts: the boot resume may only
        // repeat a start that DIED. Repeating a start that merely ran out of
        // its budget spends the same budget again (up to 10 minutes on a big
        // GGUF) and re-runs the ComfyUI and Ollama evictions each time.
        let slow = StartFailure { died: false, port_taken: false, stderr: String::new() , exit_code: None, signal: None };
        let msg = start_failure_message(&slow, 8127, Duration::from_secs(60), SecondAttempt::SameOffload, None);
        assert!(
            msg.contains("did not become healthy"),
            "the frontend matches on this phrase: {msg}"
        );
        // Negative control: no death message may carry it, or every failure
        // would be treated as a slow load and never retried.
        for stderr in [
            "srv start: couldn't bind HTTP server socket",
            "CUDA error: out of memory",
            "failed to load model",
            "something went wrong",
        ] {
            let died = StartFailure { died: true, port_taken: false, stderr: stderr.into() , exit_code: None, signal: None };
            let m = start_failure_message(&died, 8127, Duration::from_secs(60), SecondAttempt::SameOffload, None);
            assert!(!m.contains("did not become healthy"), "{m}");
        }
    }

    #[test]
    fn a_port_this_process_holds_is_not_offered_to_the_engine() {
        // The one socket-level check: bind a port, then ask for it.
        let held = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind an ephemeral port");
        let taken = held.local_addr().unwrap().port();
        assert!(!port_is_bindable(taken), "port {taken} is held by this test");
        let candidates = engine_port_candidates(taken);
        let picked = first_usable_port(&candidates, port_is_bindable);
        assert!(picked.is_some(), "the walk has to find a way out");
        assert_ne!(picked, Some(taken));
        // Negative control: the held port is still FIRST in the walk, so it was
        // the bind check that skipped it and not the order of the candidates.
        assert_eq!(first_usable_port(&candidates, |_| true), Some(taken));
        drop(held);
    }

    #[test]
    fn a_child_that_is_still_loading_is_left_alone_until_the_budget_ends() {
        // Negative control for the check above: a LIVE child must still get
        // its full budget, or a big GGUF on a cold disk would be declared dead
        // while it is only slow (ENG-4).
        let state = AppState::new();
        let child = crate::test_support::sleeper(30)
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

    // ── A stop that arrives while the model is still loading ──────────────
    //
    // The start holds ENGINE_START for the whole load, the stop does not wait
    // for it: it takes the child out of the slot and kills it. The waiting
    // start then found an empty slot and read that as "the engine died", and
    // a death is what earns the second attempt, 1.5 s later, on the processor.
    // The model somebody had just unloaded came back, slower, and stayed.

    /// Stand in for the frontend: wait until the start has parked its child,
    /// then stop the engine the way `stop_bundled_engine` does.
    fn stop_once_loading(state: &Arc<AppState>) -> std::thread::JoinHandle<bool> {
        let state = Arc::clone(state);
        std::thread::spawn(move || {
            let began = Instant::now();
            while state.bundled_engine.lock().unwrap().is_none() {
                assert!(began.elapsed() < Duration::from_secs(10), "the start never parked a child");
                std::thread::sleep(Duration::from_millis(20));
            }
            stop_engine_on_request(&state)
        })
    }

    #[test]
    fn a_stop_while_the_model_loads_is_not_read_as_a_death() {
        let state = Arc::new(AppState::new());
        let (binary, args) = long_lived_argv(30);
        let stopper = stop_once_loading(&state);

        let began = Instant::now();
        let failure = spawn_engine_attempt(
            &state,
            &binary,
            &args,
            "/tmp/does-not-matter.gguf",
            DEAD_PORT,
            Some(8192),
            AttemptFlags { auto_layers: true, cpu_fallback: false },
            None,
        )
        .expect_err("nothing serves on that port, the attempt cannot have come up");
        let took = began.elapsed();

        assert!(stopper.join().unwrap(), "the stop found nothing to stop");
        assert!(took < Duration::from_secs(10), "the stop was only noticed after {took:?}");
        // `died` is the one thing `start_after_stop` asks before it starts the
        // model a second time.
        assert!(!failure.died, "a stop the user asked for was reported as a crash, so the start runs again");
        assert!(stop_was_requested(&state), "the stop left no mark for the start to read");
        assert!(state.bundled_engine.lock().unwrap().is_none(), "the stopped engine is back in the slot");
    }

    #[test]
    fn an_emptied_slot_is_a_stop_only_when_somebody_asked_for_one() {
        // Negative control. The sidecar watch and every status read clear the
        // slot too, for a child that died by itself, and THAT must stay a
        // death: it is the crash the second attempt exists for.
        let state = AppState::new();
        assert_eq!(
            wait_for_health_or_exit(&state, DEAD_PORT, Duration::from_secs(5)),
            HealthWait::ChildExited { code: None, signal: None }
        );
        assert!(!stop_engine_on_request(&state), "there was nothing to stop");
        assert_eq!(wait_for_health_or_exit(&state, DEAD_PORT, Duration::from_secs(5)), HealthWait::Stopped);
    }

    #[test]
    fn nothing_is_started_after_a_stop_that_found_the_slot_empty() {
        // The window between two attempts: the first child is reaped, the
        // start sleeps its 1.5 s settle, and the stop arrives. It has nothing
        // to kill and answers "idle", and the retry used to start the model
        // right behind it.
        let state = AppState::new();
        assert!(!stop_engine_on_request(&state));
        let (binary, args) = long_lived_argv(30);

        let began = Instant::now();
        let failure = spawn_engine_attempt(
            &state,
            &binary,
            &args,
            "/tmp/does-not-matter.gguf",
            DEAD_PORT,
            Some(8192),
            AttemptFlags { auto_layers: false, cpu_fallback: true },
            None,
        )
        .expect_err("an attempt ran after the engine was stopped");

        assert!(!failure.died);
        assert!(began.elapsed() < Duration::from_secs(2), "the attempt waited on a child it should never have spawned");
        assert!(state.bundled_engine.lock().unwrap().is_none(), "a child was parked after the stop");
    }

    #[test]
    fn a_stopped_start_answers_without_claiming_an_engine() {
        let answer = stopped_answer(8127, "/models/hermes.gguf");
        assert_eq!(answer["status"], "stopped");
        assert_eq!(answer["port"], 8127);
        assert_eq!(answer["model_path"], "/models/hermes.gguf");
        // Nothing a caller could mistake for the processor fallback this used
        // to end in.
        assert!(answer.get("cpuOnly").is_none() && answer.get("retried").is_none(), "{answer}");
    }

    #[test]
    fn a_stop_at_any_moment_of_the_attempt_ends_it_without_a_death() {
        // The first test waits until the child is parked. A real stop does not
        // wait for anything, so this one lets it land wherever it lands:
        // before the spawn, between the spawn and the slot, during the wait.
        // Whichever window it hits, the attempt must end at once, must not
        // report a death, and must leave nothing in the slot.
        for delay_ms in [0u64, 1, 2, 3, 5, 8, 12, 20, 35, 60, 100, 250] {
            let state = Arc::new(AppState::new());
            let (binary, args) = long_lived_argv(30);
            let stopper = {
                let state = Arc::clone(&state);
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(delay_ms));
                    stop_engine_on_request(&state)
                })
            };

            let began = Instant::now();
            let failure = spawn_engine_attempt(
                &state,
                &binary,
                &args,
                "/tmp/does-not-matter.gguf",
                DEAD_PORT,
                Some(8192),
                AttemptFlags { auto_layers: true, cpu_fallback: false },
                None,
            )
            .expect_err("nothing serves on that port, the attempt cannot have come up");
            let took = began.elapsed();
            stopper.join().unwrap();

            assert!(!failure.died, "a stop {delay_ms} ms into the attempt was reported as a crash");
            assert!(took < Duration::from_secs(10), "a stop {delay_ms} ms into the attempt was only noticed after {took:?}");
            assert!(
                state.bundled_engine.lock().unwrap().is_none(),
                "a stop {delay_ms} ms into the attempt left a child in the slot"
            );
        }
    }

    #[test]
    fn the_end_of_the_app_while_the_model_loads_is_a_stop_too() {
        // `shutdown_subprocesses` kills the child itself instead of going
        // through `stop_engine_on_request`, so it has to leave the same mark.
        let state = Arc::new(AppState::new());
        let (binary, args) = long_lived_argv(30);
        let closer = {
            let state = Arc::clone(&state);
            std::thread::spawn(move || {
                let began = Instant::now();
                while state.bundled_engine.lock().unwrap().is_none() {
                    assert!(began.elapsed() < Duration::from_secs(10), "the start never parked a child");
                    std::thread::sleep(Duration::from_millis(20));
                }
                state.shutdown_subprocesses();
            })
        };

        let failure = spawn_engine_attempt(
            &state,
            &binary,
            &args,
            "/tmp/does-not-matter.gguf",
            DEAD_PORT,
            Some(8192),
            AttemptFlags { auto_layers: true, cpu_fallback: false },
            None,
        )
        .expect_err("nothing serves on that port, the attempt cannot have come up");
        closer.join().unwrap();

        assert!(!failure.died, "the end of the app was reported as a crash, so the start runs again");
        assert!(state.bundled_engine.lock().unwrap().is_none());
    }

    #[test]
    fn a_child_that_dies_by_itself_is_still_a_death_after_the_fix() {
        // Negative control on the whole attempt: the crash the second attempt
        // exists for must keep earning it.
        let state = AppState::new();
        let (binary, args) = long_lived_argv(0);
        let failure = spawn_engine_attempt(
            &state,
            &binary,
            &args,
            "/tmp/does-not-matter.gguf",
            DEAD_PORT,
            Some(8192),
            AttemptFlags { auto_layers: true, cpu_fallback: false },
            None,
        )
        .expect_err("nothing serves on that port, the attempt cannot have come up");
        assert!(failure.died, "a child that exited by itself is no longer a death, so a real crash gets no retry");
        assert!(!stop_was_requested(&state));
    }

    #[test]
    fn settle_switch_answers_stopped_and_brings_nothing_back_after_a_stop() {
        // The start failed BECAUSE it was stopped. An error here is what the
        // resume loop and the context raise answer with another start.
        let state = AppState::new();
        stop_engine_on_request(&state);
        let restores = std::cell::Cell::new(0);
        let answer = settle_switch(&state, 8127, "/models/hermes.gguf", Err(STOPPED_WHILE_LOADING.into()), || {
            restores.set(restores.get() + 1);
            true
        })
        .expect("a stop the user asked for was reported as a failed start");
        assert_eq!(answer["status"], "stopped");
        assert_eq!(restores.get(), 0, "the previous model was started again after the user stopped the engine");

        // The start came up and the stop landed right behind it. Whatever the
        // start had to say describes an engine that is gone.
        let mut served = started_answer(8127, "/models/hermes.gguf", Some(8192));
        served["cpuOnly"] = serde_json::json!(true);
        let answer = settle_switch(&state, 8127, "/models/hermes.gguf", Ok(served), || unreachable!()).unwrap();
        assert_eq!(answer["status"], "stopped");
        assert!(answer.get("cpuOnly").is_none(), "{answer}");
    }

    #[test]
    fn settle_switch_reads_a_stop_that_arrives_while_the_previous_model_comes_back() {
        let state = AppState::new();
        let answer = settle_switch(&state, 8127, "/models/hermes.gguf", Err("it broke".into()), || {
            stop_engine_on_request(&state);
            false
        })
        .expect("the stop that cut the restore short was reported as a failed start");
        assert_eq!(answer["status"], "stopped");
    }

    #[test]
    fn settle_switch_without_a_stop_is_the_switch_it_always_was() {
        // Negative control: a start that fails for a reason of its own still
        // brings the previous model back and still says so on top.
        let state = AppState::new();
        let served = started_answer(8127, "/models/hermes.gguf", Some(8192));
        assert_eq!(
            settle_switch(&state, 8127, "/models/hermes.gguf", Ok(served.clone()), || unreachable!()),
            Ok(served)
        );
        let restored = settle_switch(&state, 8127, "/models/hermes.gguf", Err("it broke".into()), || true).unwrap_err();
        assert!(restored.contains(RESTORED_NOTE) && restored.contains("it broke"), "{restored}");
        assert_eq!(
            settle_switch(&state, 8127, "/models/hermes.gguf", Err("it broke".into()), || false),
            Err("it broke".to_string())
        );
    }

    #[test]
    fn a_stopped_start_neither_retries_nor_brings_the_previous_model_back() {
        // Source anchors, in the manner of `every_failed_switch_runs_through_
        // the_fallback`: the two functions below need an AppHandle and cannot
        // be run here, so the order of their exits is pinned instead.
        let src = include_str!("engine.rs");
        let body_of = |name: &str| {
            src.split(name).nth(1).expect("the function is gone").split("\nfn ").next().unwrap().to_string()
        };

        let start = body_of("fn start_after_stop(");
        let asked = start.find("if stop_was_requested(state) {").expect("start_after_stop no longer asks whether it was stopped");
        for later in ["if !failure.died {", "retrying without it", "retrying once", "the retry drops GPU offload"] {
            let at = start.find(later).unwrap_or_else(|| panic!("`{later}` is gone from start_after_stop"));
            assert!(asked < at, "the stop is asked about after `{later}`");
        }

        let wrapper = body_of("fn start_bundled_engine_blocking(");
        let cleared = wrapper.find("engine_stop_requested.store(false").expect("a start no longer clears an old stop");
        let gate = wrapper.find("start_gate(").expect("the start gate is gone");
        let work = wrapper.find("start_engine_and_remember(").expect("the serialized start is gone");
        assert!(gate < cleared && cleared < work, "an old stop is not cleared under the gate, before the work begins");
        let switch = body_of("fn start_bundled_engine_locked(");
        // Whether the previous model comes back is decided in one place, and
        // `settle_switch_*` below run that place.
        let handed_over = switch.find("settle_switch(").expect("the switch no longer ends in settle_switch");
        assert!(
            handed_over < switch.find("restore_engine(").unwrap(),
            "the previous model is brought back outside settle_switch, where no stop is asked about"
        );

        // The restart of the sanity probe puts the first engine back when it
        // does not come up. Not after a stop.
        let heal = body_of("fn serve_or_heal_garbled(");
        let asked = heal.find("if stop_was_requested(state) {").expect("the sanity restart no longer asks whether it was stopped");
        let back = heal.find("bringing the first LU Engine back").expect("the sanity restart no longer puts the first engine back");
        assert!(asked < back, "the first engine is put back before the stop is asked about");

        // The requests from outside set the mark, the start's own stops do not.
        let command = body_of("pub async fn stop_bundled_engine(");
        assert!(command.contains("stop_engine_on_request(&state)"), "the frontend's stop no longer says that it is one");
        let cloud = include_str!("process.rs");
        assert!(cloud.contains("commands::engine::stop_engine_on_request(state)"), "the switch into Cloud no longer says that it is a stop");
        for own in ["fn start_after_stop(", "fn serve_or_heal_garbled(", "fn spawn_engine_attempt("] {
            assert!(!body_of(own).contains("stop_engine_on_request("), "`{own}` marks its own stop as a request");
        }
    }

    #[test]
    fn an_illegal_instruction_exit_code_is_recognised_and_nothing_else_is() {
        // K1: -1073741795 is 0xC000001D (STATUS_ILLEGAL_INSTRUCTION)
        // reinterpreted as a signed i32, which is exactly what
        // `ExitStatus::code()` hands back on Windows.
        assert!(is_illegal_instruction_exit(Some(-1073741795)));
        assert_eq!(ILLEGAL_INSTRUCTION_EXIT_CODE, -1073741795);
        // Negative control: neither "no code at all" (killed by a signal) nor
        // an ordinary crash code reads as the CPU fault.
        assert!(!is_illegal_instruction_exit(None));
        assert!(!is_illegal_instruction_exit(Some(1)));
        assert!(!is_illegal_instruction_exit(Some(-1073741819))); // 0xC0000005, access violation
    }

    #[test]
    fn an_illegal_instruction_exit_names_the_cpu_and_skips_the_second_try() {
        // K1: both the GPU attempt and the CPU-only retry run the identical
        // binary, so the message must not promise a retry that never
        // happens, and it must name the cause (an unsupported instruction
        // set) instead of the generic "reinstall" advice.
        //
        // Runde 2, Punkt D rewrote the wording: no OS-specific status code
        // (the same sentence now has to fit Windows' 0xC000001D AND Linux's
        // SIGILL, see the SIGILL test below), no competing product name, and
        // no hardcoded "for example AVX2": the real missing features depend
        // on the machine running this test, which a CI runner's modern CPU
        // will not actually be missing any of, so this only checks the
        // structural properties every branch must have, not a specific
        // feature name. `missing_cpu_features_from`'s own tests cover the
        // per-feature wording directly, against synthetic readings.
        let f = StartFailure {
            died: true,
            port_taken: false,
            stderr: String::new(),
            exit_code: Some(ILLEGAL_INSTRUCTION_EXIT_CODE),
            signal: None,
        };
        let msg = start_failure_message(&f, 8127, Duration::from_secs(60), SecondAttempt::SameOffload, None);
        assert!(!msg.contains("0xC000001D"), "no OS-specific status code: {msg}");
        assert!(!msg.contains("STATUS_ILLEGAL_INSTRUCTION"), "{msg}");
        assert!(!msg.contains("for example AVX2"), "the guess is gone: {msg}");
        assert!(!msg.contains("Ollama"), "no competing product named: {msg}");
        // BLOCKER C1 (review-integ.md): after the sidecar rebuild, "the
        // bundled engine's build requires X" and "until a build with broader
        // CPU support is available" are both false, K1 shipped exactly that
        // broader build. The message must not claim the build itself lacks
        // support for this CPU any more.
        assert!(!msg.contains("build requires"), "the build-lacks-support claim is gone: {msg}");
        assert!(!msg.contains("broader CPU support"), "{msg}");
        assert!(msg.contains("LU Cloud"), "the cloud stays available, but not as the only answer: {msg}");
        assert!(msg.contains("did not retry"), "{msg}");
        assert!(!msg.contains("tried twice"), "no second try ran: {msg}");
        assert!(
            !regex::Regex::new(r"\d+\.\d+\.\d+").unwrap().is_match(&msg),
            "no version number in an update promise: {msg}"
        );

        // Negative control: an ordinary death (no illegal-instruction exit
        // code, no signal) is unaffected and keeps its own wording.
        let ordinary = StartFailure { exit_code: None, signal: None, ..f };
        let ordinary_msg = start_failure_message(
            &ordinary,
            8127,
            Duration::from_secs(60),
            SecondAttempt::SameOffload,
            None,
        );
        assert!(!ordinary_msg.contains("illegal-instruction"), "{ordinary_msg}");
    }

    /// BLOCKER C1 (review-integ.md, Teil (c)): with no backend folder to
    /// count at all (`None`, mirroring a fresh or broken Windows/Linux
    /// install where `resolve_engine_backend_dir` found nothing), the
    /// message must point at an incomplete installation or antivirus
    /// quarantine and offer a reinstall, not repeat the old "wait for a
    /// broader build" claim.
    ///
    /// BLOCKER C2 (review-integ.md, Nachpruefung): tests the PURE
    /// `illegal_instruction_repair_sentence` with `is_macos` injected
    /// explicitly, not `start_failure_message` with `cfg!(target_os = ...)`
    /// baked in, precisely so this test's verdict does not depend on which
    /// OS happens to run `cargo test`. On this repo's own dev machine
    /// (macOS) `cfg!(target_os = "macos")` is always true at compile time,
    /// so going through `start_failure_message` here would silently test the
    /// mac branch instead of the Windows/Linux one it claims to cover.
    #[test]
    fn illegal_instruction_with_no_backend_dir_blames_the_installation() {
        let msg = illegal_instruction_repair_sentence(None, false);
        assert!(msg.contains("Reinstall Locally Uncensored"), "{msg}");
        assert!(msg.to_lowercase().contains("antivirus"), "{msg}");
        assert!(msg.contains("none of the separate CPU builds"), "{msg}");
    }

    /// Negative control for the two cases `count_cpu_backend_modules` tells
    /// apart: a folder that holds every expected CPU variant still crashed,
    /// so the wording must not claim the folder is empty (that would send a
    /// user with a genuinely complete install looking for files that are
    /// already there), while still pointing at antivirus/reinstall rather
    /// than at "no build exists for this CPU". Same C2 note as the test
    /// above: `is_macos` is passed explicitly as `false`.
    #[test]
    fn illegal_instruction_with_a_full_backend_dir_does_not_claim_it_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let names: &[&str] = if cfg!(target_os = "windows") {
            &["ggml-cpu-x64.dll", "ggml-cpu-sse42.dll", "ggml-cpu-haswell.dll"]
        } else {
            &["libggml-cpu-x64.so", "libggml-cpu-sse42.so", "libggml-cpu-haswell.so"]
        };
        for name in names {
            std::fs::write(dir.path().join(name), b"stub").unwrap();
        }
        let count = count_cpu_backend_modules(dir.path());
        assert_eq!(count, 3);
        let msg = illegal_instruction_repair_sentence(Some(count), false);
        assert!(msg.contains("Reinstall Locally Uncensored"), "{msg}");
        assert!(msg.to_lowercase().contains("antivirus"), "{msg}");
        assert!(msg.contains("holds 3 of the separate CPU builds"), "{msg}");
        assert!(!msg.contains("none of the separate CPU builds"), "a full folder is not an empty one: {msg}");

        // Negative control: an EMPTY folder (created but never populated) is
        // reported as empty, not as "3 of the separate CPU builds".
        let empty_dir = tempfile::tempdir().unwrap();
        let empty_count = count_cpu_backend_modules(empty_dir.path());
        let empty_msg = illegal_instruction_repair_sentence(Some(empty_count), false);
        assert!(empty_msg.contains("none of the separate CPU builds"), "{empty_msg}");
        assert!(!empty_msg.contains("holds 3"), "{empty_msg}");
    }

    /// BLOCKER C2 (review-integ.md, Nachpruefung): on macOS,
    /// `resolve_engine_backend_dir` returns `None` unconditionally (the Mac
    /// sidecar is one static build with Metal embedded, no dynamic ISA
    /// variants, and `is_dynamic_isa_triple` is false for both Darwin
    /// triples). The mac branch must say the true thing (this processor
    /// lacks what the one Mac build needs) and must NEVER promise a
    /// reinstall or mention antivirus, since neither can produce a file that
    /// this platform does not ship in the first place.
    #[test]
    fn illegal_instruction_on_macos_never_blames_the_installation() {
        let msg = illegal_instruction_repair_sentence(None, true);
        // Reinstalling is mentioned, but only to rule it out as a fix (a
        // true statement); it must not be OFFERED as the way out the way
        // "Reinstall Locally Uncensored" is on Windows/Linux.
        assert!(!msg.contains("Reinstall Locally Uncensored"), "{msg}");
        assert!(!msg.to_lowercase().contains("antivirus"), "{msg}");
        assert!(!msg.contains("separate CPU builds"), "{msg}");
        assert!(msg.contains("single build for every Mac"), "{msg}");

        // Negative control: this is NOT a quirk of `None` specifically. A
        // real backend_dir with some or all modules present would be
        // impossible on a real Mac (resolve_engine_backend_dir never
        // returns Some there), but the pure function must still ignore
        // module_count on the mac branch rather than reading it, so an
        // injected Some(0) and Some(9) read exactly the same as None here.
        let same_as_zero = illegal_instruction_repair_sentence(Some(0), true);
        let same_as_nine = illegal_instruction_repair_sentence(Some(9), true);
        assert_eq!(msg, same_as_zero, "the mac branch must not read module_count at all");
        assert_eq!(msg, same_as_nine, "the mac branch must not read module_count at all");

        // Negative control across the platform flag itself: the SAME
        // module_count reads as two different, non-overlapping sentences
        // depending only on is_macos.
        let windows_or_linux_msg = illegal_instruction_repair_sentence(None, false);
        assert_ne!(msg, windows_or_linux_msg);
        assert!(windows_or_linux_msg.contains("Reinstall"), "{windows_or_linux_msg}");
    }

    /// `count_cpu_backend_modules` itself, isolated from the message
    /// wording: loader-exact prefix, not a bare substring match, and unaware
    /// of `ggml-base`/`ggml-vulkan`/the exe sitting in the same folder.
    #[test]
    fn count_cpu_backend_modules_counts_only_the_cpu_variants() {
        let dir = tempfile::tempdir().unwrap();
        let prefix = if cfg!(target_os = "windows") { "ggml-cpu-" } else { "libggml-cpu-" };
        let ext = if cfg!(target_os = "windows") { "dll" } else { "so" };
        for variant in ["x64", "sse42", "haswell"] {
            std::fs::write(dir.path().join(format!("{prefix}{variant}.{ext}")), b"stub").unwrap();
        }
        // Siblings that must NOT be counted: the shared runtime, the GPU
        // backend, and the exe itself.
        let base = if cfg!(target_os = "windows") { "ggml-base.dll" } else { "libggml-base.so" };
        let vulkan = if cfg!(target_os = "windows") { "ggml-vulkan.dll" } else { "libggml-vulkan.so" };
        std::fs::write(dir.path().join(base), b"stub").unwrap();
        std::fs::write(dir.path().join(vulkan), b"stub").unwrap();
        assert_eq!(count_cpu_backend_modules(dir.path()), 3);

        // Negative control: a directory holding only the non-CPU siblings
        // counts as zero, not as "found something".
        let siblings_only = tempfile::tempdir().unwrap();
        std::fs::write(siblings_only.path().join(base), b"stub").unwrap();
        std::fs::write(siblings_only.path().join(vulkan), b"stub").unwrap();
        assert_eq!(count_cpu_backend_modules(siblings_only.path()), 0);

        // A directory that does not exist at all behaves like an empty one
        // instead of panicking (a stale or unresolved backend_dir).
        assert_eq!(count_cpu_backend_modules(&dir.path().join("does-not-exist")), 0);
    }

    #[test]
    fn a_linux_sigill_is_recognised_the_same_way_the_windows_exit_code_is() {
        // K1 Runde 2, Punkt D: `ExitStatus::code()` reads `None` for BOTH "no
        // code at all" and "a signal killed it", so before `StartFailure`
        // carried its own `signal` field this case was silently
        // indistinguishable from an ordinary, causeless death. is_sigill is
        // the Unix twin of is_illegal_instruction_exit.
        assert!(is_sigill(Some(SIGILL)));
        assert_eq!(SIGILL, 4);
        assert!(!is_sigill(None));
        assert!(!is_sigill(Some(6))); // SIGABRT, a different crash entirely

        let f = StartFailure {
            died: true,
            port_taken: false,
            stderr: String::new(),
            exit_code: None,
            signal: Some(SIGILL),
        };
        let msg = start_failure_message(&f, 8127, Duration::from_secs(60), SecondAttempt::SameOffload, None);
        assert!(msg.contains("illegal-instruction"), "SIGILL reads as the same crash: {msg}");
        assert!(msg.contains("did not retry"), "{msg}");
        assert!(!msg.contains("0xC000001D"), "{msg}");
    }

    #[test]
    fn missing_cpu_features_from_names_exactly_the_flags_that_are_false() {
        // Argument order: avx, avx2, bmi2, fma, f16c, sse42.
        assert_eq!(missing_cpu_features_from(true, true, true, true, true, true), Vec::<&str>::new());
        assert_eq!(missing_cpu_features_from(true, false, true, true, true, true), vec!["AVX2"]);
        assert_eq!(
            missing_cpu_features_from(false, false, false, false, false, false),
            vec!["AVX", "AVX2", "BMI2", "FMA", "F16C", "SSE4.2"]
        );
        // Negative control: a single true flag among the rest false ones
        // must not appear in the list; a function that just returned every
        // name unconditionally would pass every assertion above except
        // this one.
        assert!(!missing_cpu_features_from(true, false, false, false, false, false).contains(&"AVX"));
    }

    /// Runde 3, Nachbesserung 4: the whole point of measuring BMI2 and
    /// SSE4.2 too is that a CPU missing ONLY one of those two must not fall
    /// back to the generic sentence, the exact imprecision the review named
    /// for AVX2 in Runde 2 (Punkt 3/6). Both checked on their own, plus a
    /// negative control that neither shows up when everything is present.
    #[test]
    fn a_cpu_missing_only_bmi2_or_only_sse42_is_named_precisely() {
        assert_eq!(missing_cpu_features_from(true, true, false, true, true, true), vec!["BMI2"]);
        assert_eq!(missing_cpu_features_from(true, true, true, true, true, false), vec!["SSE4.2"]);
        let all_present = missing_cpu_features_from(true, true, true, true, true, true);
        assert!(!all_present.contains(&"BMI2"));
        assert!(!all_present.contains(&"SSE4.2"));
    }

    #[test]
    fn the_illegal_instruction_message_names_the_measured_missing_feature() {
        // Wires missing_cpu_features_from's output into the actual sentence,
        // without depending on this test machine's real CPU: this checks
        // the STRING-BUILDING half (start_failure_message would call
        // missing_cpu_features(), the real probe, in production; this test
        // exercises the same wording logic by constructing the sentence the
        // same way missing_cpu_features_from's result feeds it).
        let missing = missing_cpu_features_from(true, false, true, true, true, true);
        assert_eq!(missing, vec!["AVX2"]);
        let sentence = if missing.len() == 1 {
            format!("This CPU is missing the {} instruction set", missing[0])
        } else {
            format!("This CPU is missing these instruction sets: {}", missing.join(", "))
        };
        assert_eq!(sentence, "This CPU is missing the AVX2 instruction set");
    }

    #[test]
    fn the_retry_is_skipped_before_it_would_run_for_an_illegal_instruction_exit() {
        // Structural guard, mirroring `every_failed_switch_runs_through_the_
        // fallback` above: `start_after_stop` must ask
        // `is_illegal_instruction_exit` and return BEFORE the line that logs
        // and starts the second attempt, so a CPU that cannot run the
        // sidecar is never asked to try the exact same binary twice.
        let src = include_str!("engine.rs");
        let body = src
            .split("fn start_after_stop(")
            .nth(1)
            .expect("start_after_stop is gone")
            .split("\nfn ")
            .next()
            .unwrap();
        let guard = body
            .find("is_illegal_instruction_exit(failure.exit_code)")
            .expect("the illegal-instruction short-circuit is gone from start_after_stop");
        let retry = body
            .find("retrying once")
            .expect("the retry log line is gone from start_after_stop");
        assert!(guard < retry, "the illegal-instruction check no longer runs before the retry");
    }

    #[test]
    fn a_dead_start_names_the_graphics_card_when_the_engine_blamed_it() {
        let f = StartFailure {
            died: true,
            port_taken: false,
            stderr: "ggml_cuda_init: failed to initialize CUDA: no kernel image is available for execution on the device".into(),
            exit_code: None, signal: None };
        let msg = start_failure_message(&f, 8127, Duration::from_secs(60), SecondAttempt::SameOffload, None);
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
            exit_code: None, signal: None };
        let msg = start_failure_message(&f, 8127, Duration::from_secs(60), SecondAttempt::SameOffload, None);
        assert!(msg.contains("could not read the model file"), "{msg}");
        assert!(!msg.contains("GPU Layers"), "{msg}");
    }

    /// The real tail of a real failure, captured 2026-09-03 on the Windows
    /// release build after starting a deliberately truncated GGUF (valid
    /// magic, 2 MB of zeroes) through the Use button.
    ///
    /// It carries no `cuda` line at all. What put it on the graphics-card
    /// branch is llama.cpp's own auto-fit line, "trying to fit params to free
    /// DEVICE MEMORY", which it prints on any load error, and which matches
    /// the `device memory` marker in `stderr_blames_the_gpu`. So the user was
    /// told to set GPU Layers to 0 on a file that no setting can repair.
    const KAPUTTE_GGUF_STDERR: &str = "\
srv    load_model: loading model 'C:\\Users\\x\\models\\diag-kaputt.gguf'
llama_model_load: error loading model: unknown model architecture: ''
llama_model_load_from_file_impl: failed to load model
common_fit_params: encountered an error while trying to fit params to free device memory: failed to load model
cmn    common_init_: failed to load model 'C:\\Users\\x\\models\\diag-kaputt.gguf'
srv    llama_server: exiting due to model loading error";

    #[test]
    fn a_broken_file_is_not_reported_as_a_graphics_card_problem() {
        let f = StartFailure {
            died: true,
            port_taken: false,
            stderr: KAPUTTE_GGUF_STDERR.into(),
            exit_code: None, signal: None };
        let msg = start_failure_message(&f, 8127, Duration::from_secs(60), SecondAttempt::SameOffload, None);
        assert!(msg.contains("could not read the model file"), "{msg}");
        assert!(!msg.contains("GPU Layers"), "{msg}");
        assert!(!msg.contains("graphics-card"), "{msg}");
        // The engine's own last words still travel, for a bug report.
        assert!(msg.contains("unknown model architecture"), "{msg}");
    }

    /// Wort fuer Wort, was llama-server am 03.09.2026 im echten Windows-Build
    /// zu einer GGUF mit unbrauchbarer Versionsnummer gesagt hat. Persona P5
    /// hat es ueber CDP aus dem Fenster gelesen, und die App antwortete darauf
    /// wieder mit der Grafikkarte. Der Grund steht in der Zeile
    /// `gguf_init_from_reader`: sie traegt den Namen der lesenden Routine, die
    /// alte Marke suchte nach der Huelle `gguf_init_from_file` darum herum.
    const KAPUTTE_VERSION_STDERR: &str = r#"0.00.262.272 E gguf_init_from_reader: failed to read header
0.00.262.420 E llama_model_load: error loading model: llama_model_loader: failed to load model from C:\Users\alice\AppData\Roaming\Locally Uncensored\models\P5-Kaputt-Test-Q4_K_M.gguf
0.00.262.483 E llama_model_load_from_file_impl: failed to load model
0.00.262.556 E common_fit_params: encountered an error while trying to fit params to free device memory: failed to load model
0.00.262.723 E gguf_init_from_reader: this GGUF file is version 684680038 but this software only supports up to version 3
0.00.262.887 E cmn  common_init_: failed to load model
0.00.264.147 E srv  llama_server: exiting due to model loading error"#;

    /// Eine Datei mit `kopf` als erste Bytes, unter einem eigenen Namen.
    fn datei_mit(name: &str, kopf: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("lu-kopf-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("{name}.gguf"));
        std::fs::write(&p, kopf).unwrap();
        p
    }

    #[test]
    fn ein_kaputter_kopf_wird_erkannt_bevor_irgendetwas_angehalten_wird() {
        // Genau die Datei aus der Messung vom 03.09.2026: GGUF-Marke vorn,
        // dahinter Muell, und die Versionsnummer las sich als 684680038.
        let mut kopf = b"GGUF".to_vec();
        kopf.extend_from_slice(&684_680_038u32.to_le_bytes());
        let p = datei_mit("P5-Kaputt-Test-Q4_K_M", &kopf);
        let grund = gguf_header_reason(&p, GGUF_ROLE_MODEL).expect("der Kopf ist Muell");
        assert!(grund.contains("684680038"), "{grund}");
        assert!(grund.contains("P5-Kaputt-Test-Q4_K_M"), "{grund}");
        assert!(grund.contains("download it again"), "{grund}");
        // Und die Meldung sagt, WELCHE Datei gemeint ist.
        assert!(grund.starts_with("The model file "), "{grund}");
        // Und kein Wort ueber die Grafikkarte.
        assert!(!grund.to_lowercase().contains("gpu"), "{grund}");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn eine_datei_ohne_gguf_marke_ist_kein_modell() {
        let p = datei_mit("Nicht-Ein-Modell", b"PK\x03\x04abcd");
        let grund = gguf_header_reason(&p, GGUF_ROLE_MODEL).expect("keine Marke");
        assert!(grund.contains("GGUF marker"), "{grund}");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn eine_gesunde_gguf_kommt_ungehindert_durch() {
        // Negativkontrolle. Version 3 ist der heutige Stand.
        let mut kopf = b"GGUF".to_vec();
        kopf.extend_from_slice(&3u32.to_le_bytes());
        let p = datei_mit("Gesund-Q4_K_M", &kopf);
        assert_eq!(gguf_header_reason(&p, GGUF_ROLE_MODEL), None);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn eine_kuenftige_formatversion_wird_nicht_verboten() {
        // Die Vorpruefung sucht Muell, nicht "die Version, die ich kenne".
        // Eine llama.cpp, die morgen Version 4 liest, soll das duerfen.
        for v in [4u32, 5, 9, GGUF_VERSION_UNSINN] {
            let mut kopf = b"GGUF".to_vec();
            kopf.extend_from_slice(&v.to_le_bytes());
            let p = datei_mit(&format!("Zukunft-v{v}"), &kopf);
            assert_eq!(
                gguf_header_reason(&p, GGUF_ROLE_MODEL),
                None,
                "Version {v} wurde verboten"
            );
            let _ = std::fs::remove_file(&p);
        }
    }

    #[test]
    fn eine_datei_die_sich_nicht_lesen_laesst_haelt_niemanden_auf() {
        // Ein Lesefehler ist kein Urteil. Die Datei kann auf einem langsamen
        // Netzlaufwerk liegen oder gerade geschrieben werden; dann soll die
        // Engine es versuchen und ihre eigene Antwort geben.
        let fehlt = std::env::temp_dir().join("lu-kopf-gibt-es-nicht.gguf");
        let _ = std::fs::remove_file(&fehlt);
        assert_eq!(gguf_header_reason(&fehlt, GGUF_ROLE_MODEL), None);
        // Und eine Datei, die kuerzer als acht Bytes ist, ebenso.
        let kurz = datei_mit("Zu-Kurz", b"GGUF");
        assert_eq!(gguf_header_reason(&kurz, GGUF_ROLE_MODEL), None);
        let _ = std::fs::remove_file(&kurz);
    }

    #[test]
    fn beide_koepfe_werden_vor_dem_halt_der_laufenden_engine_gelesen() {
        // Der Sinn der ganzen Pruefung. Steht sie hinter dem Halt, kostet ein
        // Klick auf eine kaputte Datei weiterhin 7,4 s Chat.
        //
        // Der Rumpf wird begrenzt wie im Test darueber. Ein erster Anlauf las
        // die ganze Datei und suchte darin nach zwei Zeichenketten; die
        // stehen aber auch in diesem Test selbst, also fand er sich selbst
        // und war immer gruen. Genau die Falle, die eine Gegenprobe aufdeckt:
        // die Vorpruefung entfernen und nichts wurde rot.
        let wechsel = include_str!("engine.rs")
            .split("fn start_bundled_engine_locked(")
            .nth(1)
            .expect("the switch is gone")
            .split("\nfn ")
            .next()
            .unwrap();
        let pruefung = wechsel.find("precheck_model_files(").expect("keine Vorpruefung");
        let halt = wechsel.find("stop_engine_locked(state);").expect("kein Halt");
        assert!(pruefung < halt, "die Pruefung steht hinter dem Halt");
        // Und die Sichtdatei wird nirgends daran vorbei geholt: ein blankes
        // existing_mmproj im Wechsel waere wieder die reine Existenzfrage.
        assert!(
            !wechsel.contains("existing_mmproj("),
            "die Sichtdatei geht an der Vorpruefung vorbei"
        );
    }

    #[test]
    fn eine_halbe_sichtdatei_haelt_den_wechsel_auf_statt_die_engine() {
        // Der abgebrochene Projektor-Download. `existing_mmproj` sieht nur,
        // DASS die Datei da ist; ihr Kopf sagt, dass llama-server sie hinter
        // --mmproj nicht laden wird. Ohne diese Pruefung faellt der Fehler
        // erst im Prozess, also nach dem Halt der gesunden Engine.
        let mut gesund = b"GGUF".to_vec();
        gesund.extend_from_slice(&3u32.to_le_bytes());
        let modell = datei_mit("Sicht-Modell-Q4_K_M", &gesund);
        let sicht = datei_mit("Sicht-Modell-Q4_K_M.mmproj", b"<!DOCTYPE html>");
        let pfad = modell.to_string_lossy().to_string();
        let grund = precheck_model_files(&pfad).expect_err("die Sichtdatei ist Muell");
        assert!(grund.starts_with("The vision file next to this model "), "{grund}");
        assert!(grund.contains("Sicht-Modell-Q4_K_M.mmproj"), "{grund}");
        assert!(grund.contains("GGUF marker"), "{grund}");
        assert!(grund.contains("download it again"), "{grund}");
        // Kein Wort ueber die Grafikkarte, und das gesunde Modell wird nicht
        // beschuldigt.
        assert!(!grund.to_lowercase().contains("gpu"), "{grund}");
        assert!(!grund.contains("The model file"), "{grund}");
        let _ = std::fs::remove_file(&modell);
        let _ = std::fs::remove_file(&sicht);
    }

    #[test]
    fn eine_heile_sichtdatei_und_ein_reines_textmodell_kommen_durch() {
        // Negativkontrolle zum Test darueber: die Vorpruefung sucht Muell,
        // nicht Anwesenheit. Sie reicht den Pfad weiter, den das argv als
        // --mmproj braucht, und None heisst reines Textmodell.
        let mut gesund = b"GGUF".to_vec();
        gesund.extend_from_slice(&3u32.to_le_bytes());
        let modell = datei_mit("Heile-Sicht-Q4_K_M", &gesund);
        let sicht = datei_mit("Heile-Sicht-Q4_K_M.mmproj", &gesund);
        let pfad = modell.to_string_lossy().to_string();
        assert_eq!(
            precheck_model_files(&pfad),
            Ok(Some(sicht.to_string_lossy().to_string()))
        );
        let _ = std::fs::remove_file(&sicht);
        assert_eq!(precheck_model_files(&pfad), Ok(None));
        let _ = std::fs::remove_file(&modell);
    }

    #[test]
    fn ein_kaputtes_modell_wird_weiter_zuerst_gemeldet() {
        // Die Reihenfolge in der Vorpruefung: wer ein kaputtes Modell
        // antippt, soll nicht ueber die Sichtdatei belehrt werden.
        let modell = datei_mit("Kaputt-Mit-Sicht-Q4_K_M", b"PK\x03\x04abcd");
        let sicht = datei_mit("Kaputt-Mit-Sicht-Q4_K_M.mmproj", b"PK\x03\x04abcd");
        let pfad = modell.to_string_lossy().to_string();
        let grund = precheck_model_files(&pfad).expect_err("das Modell ist Muell");
        assert!(grund.starts_with("The model file "), "{grund}");
        let _ = std::fs::remove_file(&modell);
        let _ = std::fs::remove_file(&sicht);
    }

    #[test]
    fn die_begruendung_der_startmeldung_steht_ueber_der_startmeldung() {
        // Ein neuer Block wurde zwischen den Doc-Kommentar und seine Funktion
        // geschoben, und die Begruendung fuer die Fehlermeldung des Starts
        // hing danach an GGUF_MAGIC. Wer bei der Konstanten aufschlug, las
        // die Begruendung fuer eine Meldung drei Bildschirme weiter unten,
        // und wer die Meldung aufschlug, fand keine.
        //
        // Beide Suchbegriffe stehen auch in diesem Test, aber `split().next()`
        // nimmt, was VOR dem ersten Vorkommen steht, und das ist die echte
        // Stelle weit oben in der Datei.
        let quelle = include_str!("engine.rs");
        let doc_ueber = |anker: &str| -> String {
            quelle
                .split(anker)
                .next()
                .unwrap_or("")
                .rsplit("\n\n")
                .next()
                .unwrap_or("")
                .to_string()
        };
        let bei_der_meldung = doc_ueber("pub(crate) fn start_failure_message(");
        assert!(bei_der_meldung.contains("GH #118"), "{bei_der_meldung}");
        assert!(bei_der_meldung.contains("GPU Layers"), "{bei_der_meldung}");
        let bei_der_konstante = doc_ueber("const GGUF_MAGIC:");
        assert!(!bei_der_konstante.contains("GH #118"), "{bei_der_konstante}");
    }

    #[test]
    fn eine_unlesbare_versionsnummer_ist_auch_kein_grafikkartenproblem() {
        let f = StartFailure {
            died: true,
            port_taken: false,
            stderr: KAPUTTE_VERSION_STDERR.into(),
            exit_code: None, signal: None };
        let msg = start_failure_message(&f, 8127, Duration::from_secs(60), SecondAttempt::SameOffload, None);
        assert!(msg.contains("could not read the model file"), "{msg}");
        assert!(!msg.contains("GPU Layers"), "{msg}");
        assert!(!msg.contains("graphics-card"), "{msg}");
    }

    #[test]
    fn a_card_that_runs_out_of_memory_keeps_the_gpu_layers_way_out() {
        // The negative control for the test above, and the reason
        // `failed to load model` is NOT one of the file-structure markers: a
        // CUDA out-of-memory prints that same line, and there GPU Layers 0 is
        // exactly the advice that gets the user chatting.
        let f = StartFailure {
            died: true,
            port_taken: false,
            stderr: "ggml_backend_cuda_buffer_type_alloc_buffer: allocating 9216.00 MiB on device 0: cudaMalloc failed: out of memory\nllama_model_load: error loading model: unable to allocate CUDA0 buffer\nllama_model_load_from_file_impl: failed to load model".into(),
            exit_code: None, signal: None };
        let msg = start_failure_message(&f, 8127, Duration::from_secs(60), SecondAttempt::SameOffload, None);
        assert!(msg.contains("GPU Layers"), "{msg}");
        assert!(!msg.contains("could not read the model file"), "{msg}");
    }

    #[test]
    fn a_stranger_on_the_port_keeps_its_own_message() {
        let f = StartFailure { died: true, port_taken: true, stderr: String::new() , exit_code: None, signal: None };
        let msg = start_failure_message(&f, 8127, Duration::from_secs(60), SecondAttempt::SameOffload, None);
        assert!(msg.contains("occupying the port"), "{msg}");
        assert!(!msg.contains("tried twice"), "{msg}");
    }

    #[test]
    fn a_slow_load_still_reports_the_budget_and_never_claims_a_crash() {
        let f = StartFailure { died: false, port_taken: false, stderr: String::new() , exit_code: None, signal: None };
        let msg = start_failure_message(&f, 8127, Duration::from_secs(220), SecondAttempt::SameOffload, None);
        assert!(msg.contains("did not become healthy on port 8127 within 220s"), "{msg}");
        assert!(!msg.contains("exited"), "{msg}");
    }

    #[test]
    fn a_dead_start_names_the_missing_library_instead_of_the_graphics_card() {
        // The Linux deb shipped a sidecar with DT_NEEDED libvulkan.so.1 and
        // DT_NEEDED libgomp.so.1 while its Depends named neither, so on a box
        // without those packages this is the ONLY thing the engine ever says.
        // "libvulkan.so.1" contains "vulkan", so before the loader line was
        // read first the user was told to set GPU Layers to 0, which cannot
        // help a binary the loader refused to start.
        let f = StartFailure {
            died: true,
            port_taken: false,
            stderr: "lu-llama-server: error while loading shared libraries: libvulkan.so.1: cannot open shared object file: No such file or directory".into(),
            exit_code: None, signal: None };
        let msg = start_failure_message(&f, 8127, Duration::from_secs(60), SecondAttempt::SameOffload, None);
        assert!(msg.contains("libvulkan.so.1"), "{msg}");
        assert!(!msg.contains("GPU Layers"), "{msg}");
        // The engine's own last words still ride along for a bug report.
        assert!(msg.contains("cannot open shared object file"), "{msg}");
    }

    #[test]
    fn the_install_advice_fits_the_library_and_never_guesses_a_package_name() {
        // Both sonames the shipped sidecar carries get a real command.
        let vulkan = missing_library_hint("libvulkan.so.1", true);
        assert!(vulkan.contains("sudo apt install libvulkan1"), "{vulkan}");
        assert!(vulkan.contains("sudo dnf install vulkan-loader"), "{vulkan}");
        let gomp = missing_library_hint("libgomp.so.1", true);
        assert!(gomp.contains("sudo apt install libgomp1"), "{gomp}");
        assert!(gomp.contains("sudo dnf install libgomp"), "{gomp}");
        // openSUSE and Mageia call these something else, so nobody is left
        // without a way out: the library is named as well as the packages.
        assert!(vulkan.contains("other distributions"), "{vulkan}");
        // The promise is scoped to the two packages that actually carry
        // dependencies. The AppImage has none, and it excludes the Vulkan
        // loader on purpose, so it must not be swept into the sentence.
        assert!(vulkan.contains("from the .deb or the .rpm"), "{vulkan}");
        assert!(!vulkan.contains("The current Linux package"), "{vulkan}");

        // Negative control: an unknown soname gets no command at all, because
        // a guessed package name is worse than none.
        let unknown = missing_library_hint("libfoobar.so.9", true);
        assert!(unknown.contains("package that provides libfoobar.so.9"), "{unknown}");
        assert!(!unknown.contains("apt install"), "{unknown}");
        assert!(!unknown.contains("dnf install"), "{unknown}");

        // Negative control: off Linux nobody is sent to apt or dnf. The
        // trigger wording is ld.so's, macOS and Windows word it differently.
        let elsewhere = missing_library_hint("libvulkan.so.1", false);
        assert!(elsewhere.contains("libvulkan.so.1"), "{elsewhere}");
        assert!(!elsewhere.contains("apt"), "{elsewhere}");
        assert!(!elsewhere.contains("dnf"), "{elsewhere}");
    }

    #[test]
    fn the_embeddings_server_gets_the_same_diagnosis_as_the_chat_engine() {
        // Same sidecar, same loader, same missing package. Document Chat used
        // to answer this with the raw stderr tail alone.
        let msg = embed_start_failure_message(
            "LU Engine did not become healthy on port 8128 within 60s",
            "lu-llama-server: error while loading shared libraries: libgomp.so.1: cannot open shared object file: No such file or directory",
        );
        assert!(msg.contains("libgomp.so.1"), "{msg}");
        assert!(msg.contains("A system library the LU Engine needs is missing"), "{msg}");
        // The engine's own last words survive for a bug report.
        assert!(msg.contains("cannot open shared object file"), "{msg}");
        // No port or retry wording from the chat path: this one refuses a
        // stranger earlier and never retries, so that would not be true.
        assert!(!msg.contains("tried twice"), "{msg}");

        // Negative control: an ordinary slow load keeps the plain message and
        // gains no packaging advice.
        let slow = embed_start_failure_message(
            "LU Engine did not become healthy on port 8128 within 60s",
            "load_tensors: loading model tensors",
        );
        assert!(!slow.contains("A system library"), "{slow}");
        assert!(slow.contains("load_tensors"), "{slow}");
        // And an empty tail leaves no dangling blank lines.
        let bare = embed_start_failure_message("timed out", "");
        assert_eq!(bare, "timed out");
    }

    #[test]
    fn a_missing_library_is_read_off_the_loader_line_and_nowhere_else() {
        assert_eq!(
            stderr_names_a_missing_system_library(
                "lu-llama-server: error while loading shared libraries: libgomp.so.1: cannot open shared object file: No such file or directory"
            )
            .as_deref(),
            Some("libgomp.so.1"),
        );
        // Negative control: a real Vulkan fault from a loaded binary is NOT a
        // packaging problem and has to keep the graphics-card hint.
        assert_eq!(stderr_names_a_missing_system_library("ggml_vulkan: no devices found"), None);
        let f = StartFailure {
            died: true,
            port_taken: false,
            stderr: "ggml_vulkan: no devices found".into(),
            exit_code: None, signal: None };
        let msg = start_failure_message(&f, 8127, Duration::from_secs(60), SecondAttempt::SameOffload, None);
        assert!(msg.contains("GPU Layers to 0"), "{msg}");
        assert!(!msg.contains("apt install"), "{msg}");
        // And an empty stderr names no library at all.
        assert_eq!(stderr_names_a_missing_system_library(""), None);
    }

    #[test]
    fn gpu_blame_needs_actual_gpu_words() {
        // A name and a fault together.
        assert!(stderr_blames_the_gpu("CUDA error: out of memory"));
        assert!(stderr_blames_the_gpu("ggml_vulkan: no devices found"));
        // A name alone is the banner of a card that works.
        assert!(!stderr_blames_the_gpu("ggml_cuda_init: found 1 CUDA devices"));
        // A fault alone can be the system's own memory, and there sending the
        // weights off the card into RAM makes it worse.
        assert!(!stderr_blames_the_gpu("std::bad_alloc: out of memory"));
        // The line llama.cpp prints on EVERY load error, whatever the cause.
        assert!(!stderr_blames_the_gpu(
            "common_fit_params: encountered an error while trying to fit params to free device memory"
        ));
        // Negative control: a plain port collision is not a GPU problem, and
        // sending that user into the GPU Layers setting would waste their time.
        assert!(!stderr_blames_the_gpu("error: bind(): Address already in use"));
        assert!(!stderr_blames_the_model_file("error: bind(): Address already in use"));
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

    #[test]
    fn import_lands_in_the_set_lu_engine_folder() {
        let root = tempfile::tempdir().unwrap();
        let set = root.path().join("on the other drive").join("models");
        // The set folder wins and is created when it is not there yet.
        assert_eq!(import_dest_dir(Some(set.to_str().unwrap())).unwrap(), set);
        assert!(set.is_dir());
        // Negative control: no folder set, or only blanks, is the app's own
        // models dir, the folder the import always used before.
        let own = builtin_models_dir().unwrap();
        assert_eq!(import_dest_dir(None).unwrap(), own);
        assert_eq!(import_dest_dir(Some("   ")).unwrap(), own);
    }

    #[test]
    fn the_cross_drive_error_names_the_lu_engine_folder_setting() {
        let dest = tempfile::tempdir().unwrap();
        // A source that is a file but whose link cannot be made: the target
        // folder does not exist, so hard_link fails and the error is shown.
        let store = tempfile::tempdir().unwrap();
        let src = store.path().join("m.gguf");
        std::fs::write(&src, b"w").unwrap();
        let err = import_model_file(&src, &dest.path().join("gone"), "m").unwrap_err();
        assert!(err.contains("LU Engine folder (Settings, AI Backends, Model Storage)"), "{err}");
        assert!(!err.contains("Move the models folder"), "{err}");
    }
}

#[cfg(test)]
mod orphaned_sidecar_tests {
    use super::*;

    fn row(pid: u32, parent: Option<u32>, exe: &str) -> ProcRow {
        ProcRow { pid, parent, exe: Some(PathBuf::from(exe)) }
    }

    const OURS: &str = "/Applications/LU.app/Contents/MacOS/lu-llama-server";

    /// Fehlerkontrolle Mac 2, Fund 9: only a sidecar of ours whose app is gone.
    #[test]
    fn only_our_own_binary_under_launchd_counts_as_orphaned() {
        let rows = vec![
            row(100, Some(1), OURS),                                   // the orphan
            row(101, Some(4242), OURS),                                // a running app's sidecar
            row(102, Some(1), "/opt/homebrew/bin/llama-server"),       // the user's own
            row(103, Some(1), "/Users/x/dev/lu/src-tauri/bin/lu-llama-server-aarch64-apple-darwin"),
            row(104, None, OURS),                                      // parent unknown: not proven
            ProcRow { pid: 105, parent: Some(1), exe: None },          // unreadable: not proven
        ];
        assert_eq!(orphaned_sidecars(&rows, Path::new(OURS)), vec![100]);
        assert!(orphaned_sidecars(&[], Path::new(OURS)).is_empty());
    }

    /// Against real processes, on the one platform the sweep runs on. Linux
    /// hands an orphan to the nearest subreaper (often `systemd --user`), not
    /// to pid 1, so the same test there would measure the session manager.
    #[cfg(target_os = "macos")]
    mod real {
        use super::*;
        use std::process::{Command, Stdio};

        /// A stand-in sidecar: the compiled `park` under the sidecar's name, in a
        /// folder of its own so no real sidecar on this machine can match it.
        fn stand_in(dir: &Path) -> PathBuf {
            let path = dir.join(sidecar_binary_name());
            std::fs::copy(crate::test_support::park_binary(), &path).expect("copy park");
            path
        }

        /// Start `binary` so that its parent exits at once and the kernel hands
        /// it to pid 1, which is what a crashed app leaves behind. It reads from a
        /// fifo it holds open itself, so it lives until it is killed.
        fn spawn_orphan(binary: &Path, dir: &Path) -> u32 {
            let fifo = dir.join("stdin.fifo");
            let out = Command::new("sh")
                .arg("-c")
                .arg(r#"mkfifo "$1"; exec 3<>"$1"; "$0" <&3 >/dev/null 2>&1 & echo $!"#)
                .arg(binary)
                .arg(&fifo)
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
                .expect("sh ran");
            String::from_utf8_lossy(&out.stdout).trim().parse().expect("a pid")
        }

        fn wait_until(what: impl Fn() -> bool) -> bool {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while std::time::Instant::now() < deadline {
                if what() {
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            what()
        }

        /// The whole way against real processes: an orphan and a child that still
        /// has its parent run the same file; the sweep ends the first and leaves
        /// the second alone.
        #[test]
        fn the_sweep_ends_a_real_orphan_and_spares_a_child_with_a_living_parent() {
            let dir = tempfile::tempdir().expect("tempdir");
            let binary = stand_in(dir.path());

            let orphan = spawn_orphan(&binary, dir.path());
            let mut kept = Command::new(&binary)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .expect("spawn the child with a living parent");

            // The subshell has to be gone before the orphan shows pid 1 as parent.
            let seen = wait_until(|| orphaned_sidecars(&process_rows(), &binary).contains(&orphan));
            let ended = if seen { reap_orphaned_sidecars_of(&binary) } else { Vec::new() };
            let gone = seen && wait_until(|| !crate::test_support::is_alive(orphan));
            let kept_alive = crate::test_support::is_alive(kept.id());

            // Clean up before any assertion can leave a process behind.
            unsafe {
                libc::kill(orphan as i32, libc::SIGKILL);
            }
            let _ = kept.kill();
            let _ = kept.wait();

            assert!(seen, "the orphan {orphan} was never seen as a child of pid 1");
            assert_eq!(ended, vec![orphan], "exactly the orphan is ended, never the child of a living parent");
            assert!(gone, "the orphan {orphan} survived the sweep");
            assert!(kept_alive, "the sweep killed a sidecar whose app is still running");
        }
    }
}

#[cfg(test)]
mod diag_tests {
    use super::{kv_handoff_possible, kv_skip_note_due, pick_save_slot, tail_lines};

    #[test]
    fn an_engine_with_an_image_part_gets_no_kv_handoff() {
        let argv = |extra: &[&str]| -> Vec<String> {
            ["-m", "/m/gemma.gguf", "--port", "8127", "--ctx-size", "8192"]
                .iter()
                .chain(extra.iter())
                .map(|s| s.to_string())
                .collect()
        };
        assert!(kv_handoff_possible(&argv(&[])));
        assert!(!kv_handoff_possible(&argv(&["--mmproj", "/m/gemma.mmproj.gguf"])));
        assert!(!kv_handoff_possible(&argv(&["-mm", "/m/gemma.mmproj.gguf"])));
        assert!(!kv_handoff_possible(&argv(&["--mmproj=/m/gemma.mmproj.gguf"])));
        assert!(!kv_handoff_possible(&argv(&["--mmproj-url", "https://example.invalid/p.gguf"])));
        assert!(kv_handoff_possible(&argv(&["--no-mmproj"])));
        assert!(kv_handoff_possible(&argv(&["--no-mmproj-offload"])));
        // The argv LU itself builds for a model with an image part.
        let ours = super::build_server_args(
            "/m/gemma.gguf",
            &super::EngineTuning::default(),
            8127,
            Some("/data/kv-slots"),
            Some("/m/gemma.mmproj.gguf"),
            None,
        );
        assert!(!kv_handoff_possible(&ours));
        let text_only = super::build_server_args("/m/qwen.gguf", &super::EngineTuning::default(), 8127, Some("/data/kv-slots"), None, None);
        assert!(kv_handoff_possible(&text_only));
    }

    #[test]
    fn the_skip_is_said_once_per_model_not_once_per_render() {
        assert!(kv_skip_note_due("/m/test-once-a.gguf"));
        assert!(!kv_skip_note_due("/m/test-once-a.gguf"));
        assert!(!kv_skip_note_due("/m/test-once-a.gguf"));
        assert!(kv_skip_note_due("/m/test-once-b.gguf"));
    }

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

#[cfg(test)]
#[path = "engine_remote_recovery_tests.rs"]
mod remote_recovery_tests;
