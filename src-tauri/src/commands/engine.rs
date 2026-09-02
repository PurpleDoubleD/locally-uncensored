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

/// How far past the preferred port the engine may look for one it can open.
/// Bounded on purpose: twenty ports is far more than any desktop needs, and a
/// walk that never ends is a hang with extra steps.
const PORT_SEARCH_SPAN: u16 = 20;

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
pub(crate) fn existing_mmproj(model_path: &str) -> Option<String> {
    let p = mmproj_sibling_path(model_path);
    p.is_file().then(|| p.to_string_lossy().to_string())
}

/// Can this GGUF read images once the built-in engine loads it?
///
/// Exactly the question `existing_mmproj` answers when the server is started:
/// llama-server sees images only with `--mmproj`, and that flag rides the argv
/// only when the projector file sits next to the model. Reported with the
/// model list so the frontend stops guessing from the model NAME. Nebenbefund
/// N3 of the D1 counter-check (Windows build, 2026-08-29): a text-only
/// gemma-3-4b conversion is a gemma3 by name, the app fed it the picture it
/// had just generated, and the run ended on a red "This model can't read
/// images" line under a picture that came out fine.
pub(crate) fn model_can_see_images(model_path: &str) -> bool {
    existing_mmproj(model_path).is_some()
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
    /// `read_dir` on the root itself failed: gone, unplugged, unreadable.
    Unreachable,
    /// Not a path the OS can resolve on its own: relative, or a shell `~`.
    Unusable,
}

impl RootStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            RootStatus::Ok => "ok",
            RootStatus::Truncated => "truncated",
            RootStatus::Unreachable => "unreachable",
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
/// GH #122 (zrmdsxa, 2026-08-28): the folder the user names under Model
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
        // dead mount costs one timeout instead of one per directory.
        if std::fs::read_dir(root.dir).is_err() {
            statuses.push(RootStatus::Unreachable);
            continue;
        }
        let mut out = Vec::new();
        // (dir, base, total) → (part-numbers seen, path of part 1, byte sum).
        // The directory is part of the key: two unrelated split sets that share
        // a base name in different subfolders must never merge into one entry.
        let mut sets: std::collections::HashMap<(PathBuf, String, u32), (Vec<u32>, Option<String>, u64)> =
            std::collections::HashMap::new();
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
/// GH #118 (nayffy, 2026-08-27): before the download-routing fix, a chat model
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

fn scan_gguf_dir(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    budget: &mut ScanBudget,
    out: &mut Vec<BundledModel>,
    sets: &mut std::collections::HashMap<(PathBuf, String, u32), (Vec<u32>, Option<String>, u64)>,
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

// ── Port selection ───────────────────────────────────────────────────────────
//
// GH #118 (nayffy, 2026-08-27): the engine had exactly one port and no way out
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
        "The built-in engine could not open a local port. Every port it may use between {first} and {last} is taken or blocked on this machine. Close whatever is holding them (a llama-server left over from an earlier session is the usual cause), or check whether a firewall or a reserved Windows port range covers that block, then try again."
    )
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
        "Built-in engine did not become healthy on port {port} within {}s (the budget scales with model size, huge GGUFs can take minutes on a cold first load)",
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
        " A system library the built-in engine needs is missing on this machine: {lib}."
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

/// Markers in llama-server's stderr that point at the GPU rather than at the
/// model file or the app. Lower-cased input. Read only after
/// `stderr_names_a_missing_system_library`: "libvulkan.so.1" contains
/// "vulkan" and is a packaging problem, not a graphics-card problem.
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
    } else if failure.died
        && stderr_names_a_missing_system_library(&failure.stderr).is_none()
        && stderr_blames_the_gpu(&failure.stderr)
        && !stderr_blames_the_port(&failure.stderr)
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
        format!("The built-in engine started and exited again before it could serve on port {port}. It was tried twice. This looks like a graphics-card problem. Open Settings, Built-in Engine and set GPU Layers to 0 to run on the CPU, then try again.")
    } else if failure.died && stderr_blames_the_port(&failure.stderr) {
        format!(
            "The built-in engine could not open port {port}. Another program holds it, or the port sits in a range this system has reserved. The app already tried the next free ports and got the same answer. Close that program or reboot, then try again."
        )
    } else if failure.died {
        let hint = if let Some(lib) = stderr_names_a_missing_system_library(&failure.stderr) {
            missing_library_hint(&lib, cfg!(target_os = "linux"))
        } else if stderr_blames_the_model(&failure.stderr) {
            " The engine refused the model file. Open Models, Discover and install a different quant.".to_string()
        } else {
            " Reinstall Locally Uncensored if this keeps happening, or pick a different backend in Settings, AI Backends.".to_string()
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
            let args_on_its_port = build_server_args(
                &model_path,
                &tuning,
                engine.port,
                slot_dir.as_deref(),
                mmproj.as_deref(),
            );
            if engine.args == args_on_its_port
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

    // Different model (or dead) → stop the old process before spawning.
    stop_engine_locked(state);

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
        println!("[Engine] port {preferred_port} is taken, the built-in engine moves to {port}");
    }
    let desired_args =
        build_server_args(&model_path, &tuning, port, slot_dir.as_deref(), mmproj.as_deref());

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
    let retry_args = if retry_port == port {
        desired_args.clone()
    } else {
        println!("[Engine] the first attempt could not open port {port}, retrying on {retry_port}");
        build_server_args(
            &model_path,
            &tuning,
            retry_port,
            slot_dir.as_deref(),
            mmproj.as_deref(),
        )
    };
    match spawn_engine_attempt(state, &binary, &retry_args, &model_path, retry_port, ctx) {
        Ok(()) => {
            println!("[Engine] Built-in engine healthy on port {retry_port} (second attempt)");
            Ok(serde_json::json!({
                "status": "started",
                "port": retry_port,
                "model_path": model_path,
                "ctx": ctx,
                "retried": true,
            }))
        }
        Err(second) => Err(start_failure_message(&second, retry_port, deadline)),
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
        // A handle whose process died is not a running engine (A15).
        let probe = live_sidecar(&mut state.bundled_engine.lock().unwrap());
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

fn list_bundled_models_blocking(
    state: &AppState,
    extra_dirs: &[String],
) -> Result<serde_json::Value, String> {
    let dir = builtin_models_dir()?;
    let loaded = state
        .bundled_engine
        .lock()
        .unwrap()
        .as_ref()
        .map(|e| e.model_path.clone());
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
            serde_json::json!({
                "name": m.name,
                "path": m.path,
                "size": m.size,
                "loaded": is_loaded,
                "ctx_train": ctx_train,
                "vision": model_can_see_images(&m.path),
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
            println!(
                "[Engine] the built-in engine on port {} is gone, clearing the handle",
                e.port
            );
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
pub(crate) fn live_sidecar(slot: &mut Option<BundledEngine>) -> Option<(u16, String, Option<u32>)> {
    reap_dead_engine(slot);
    slot.as_ref().map(|e| (e.port, e.model_path.clone(), e.ctx))
}

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
        args: build_embed_args(&model_path, port),
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
        // Same as the chat engine: a killed sidecar is not a running one.
        let probe = live_sidecar(&mut state.bundled_embed.lock().unwrap());
        match probe {
            Some((port, model_path, _ctx)) => serde_json::json!({
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

        let outcome = scan_gguf_roots(&[
            ScanRoot { dir: &app, max_depth: MAX_SCAN_DEPTH },
            ScanRoot { dir: &gone, max_depth: MAX_CUSTOM_SCAN_DEPTH },
            ScanRoot { dir: &relative, max_depth: MAX_CUSTOM_SCAN_DEPTH },
        ]);
        assert_eq!(
            outcome.statuses,
            vec![RootStatus::Ok, RootStatus::Unreachable, RootStatus::Unusable],
        );
        // The app folder still answered, which is the point: one bad root is
        // not allowed to cost the list.
        assert_eq!(outcome.models.len(), 1);
        assert_eq!(outcome.models[0].name, "real");

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

    // ── A15, the two engine findings of the Windows Nachlauf ───────────────

    /// One engine handle around an arbitrary child, for the reaping tests.
    fn engine_around(child: std::process::Child, port: u16) -> Option<BundledEngine> {
        Some(BundledEngine {
            child,
            model_path: "/tmp/does-not-matter.gguf".into(),
            port,
            ctx: Some(8192),
            args: Vec::new(),
        })
    }

    #[test]
    #[cfg_attr(target_os = "windows", ignore = "uses sh")]
    fn an_engine_killed_from_outside_stops_counting_as_running() {
        // The box: `Stop-Process` on lu-llama-server, and the line kept saying
        // "Engine running / Port: 8127" for as long as anyone watched.
        let mut child = std::process::Command::new("sh")
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
    #[cfg_attr(target_os = "windows", ignore = "uses sh")]
    fn a_living_engine_is_left_exactly_where_it_is() {
        // Negative control. Without it the test above would pass on a function
        // that simply cleared the slot every time.
        let child = std::process::Command::new("sh")
            .args(["-c", "sleep 30"])
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
    #[cfg_attr(target_os = "windows", ignore = "uses sh")]
    fn a_status_read_reports_nothing_for_a_sidecar_whose_process_is_gone() {
        // The embeddings server had no reaping at all, so a killed sidecar kept
        // answering "running" on 8128 the way the chat engine used to on 8127.
        // Both status commands go through live_sidecar now, so this covers the
        // pair (A15 review).
        let mut child = std::process::Command::new("sh")
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
    #[cfg_attr(target_os = "windows", ignore = "uses sh")]
    fn a_status_read_reports_a_sidecar_that_is_really_there() {
        // Negative control for the test above: live_sidecar must not simply
        // answer None.
        let child = std::process::Command::new("sh")
            .args(["-c", "sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a long lived child");
        let mut slot = engine_around(child, DEFAULT_EMBED_PORT);

        let seen = live_sidecar(&mut slot);
        assert_eq!(seen.as_ref().map(|(p, _, _)| *p), Some(DEFAULT_EMBED_PORT));
        assert!(slot.is_some());

        let mut engine = slot.take().unwrap();
        let _ = engine.child.kill();
        let _ = engine.child.wait();
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
        };
        let msg = start_failure_message(&failure, 8127, Duration::from_secs(60));
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
        };
        assert!(start_failure_message(&other, 8127, Duration::from_secs(60)).contains("Reinstall"));
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
        let failure = StartFailure { died: true, port_taken: false, stderr: oom.into() };
        let msg = start_failure_message(&failure, 8127, Duration::from_secs(60));
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
        assert!(stderr_blames_the_gpu(stderr), "the cuda line is really there");
        let failure = StartFailure { died: true, port_taken: false, stderr: stderr.into() };
        let msg = start_failure_message(&failure, 8127, Duration::from_secs(60));
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
        let slow = StartFailure { died: false, port_taken: false, stderr: String::new() };
        let msg = start_failure_message(&slow, 8127, Duration::from_secs(60));
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
            let died = StartFailure { died: true, port_taken: false, stderr: stderr.into() };
            let m = start_failure_message(&died, 8127, Duration::from_secs(60));
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
        };
        let msg = start_failure_message(&f, 8127, Duration::from_secs(60));
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
            "Built-in engine did not become healthy on port 8128 within 60s",
            "lu-llama-server: error while loading shared libraries: libgomp.so.1: cannot open shared object file: No such file or directory",
        );
        assert!(msg.contains("libgomp.so.1"), "{msg}");
        assert!(msg.contains("A system library the built-in engine needs is missing"), "{msg}");
        // The engine's own last words survive for a bug report.
        assert!(msg.contains("cannot open shared object file"), "{msg}");
        // No port or retry wording from the chat path: this one refuses a
        // stranger earlier and never retries, so that would not be true.
        assert!(!msg.contains("tried twice"), "{msg}");

        // Negative control: an ordinary slow load keeps the plain message and
        // gains no packaging advice.
        let slow = embed_start_failure_message(
            "Built-in engine did not become healthy on port 8128 within 60s",
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
        };
        let msg = start_failure_message(&f, 8127, Duration::from_secs(60));
        assert!(msg.contains("GPU Layers to 0"), "{msg}");
        assert!(!msg.contains("apt install"), "{msg}");
        // And an empty stderr names no library at all.
        assert_eq!(stderr_names_a_missing_system_library(""), None);
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
