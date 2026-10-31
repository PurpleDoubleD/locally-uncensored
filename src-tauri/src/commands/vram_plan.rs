//! How much memory a start of the LU Engine takes, worked out from the GGUF
//! head, and how many layers that leaves for the graphics card (3.0.8, A25).
//!
//! WHY. Until 3.0.7 the plan in engine.rs priced the KV cache with one number,
//! 4 MiB per layer per 1024 tokens, for every model. Discord, 22.10.2026
//! (RTX 5070 Ti 16 GB, 32 GB RAM): gemma-4-31B at 64K context. 50 of its 60
//! layers use a sliding window of 1024 tokens and keep only 4,608 cells
//! however long the context is, the other 10 keep 4 KV heads of 512. The real
//! cache is 8.5 GiB, the flat rate said 15 GiB, and the start put 22 layers on
//! the card where about 27 fit. At 8K it went the other way: 4.1 GiB real
//! against 1.9 priced, so too many layers and the risk of running out.
//!
//! WHAT. Everything here follows llama.cpp b9949 line by line, and the tests
//! check it against that llama.cpp's own numbers (`llama-fit-params --fit-print` and the buffer
//! sizes `llama-server -lv 4` reports) for real model heads:
//!
//!   E1 (3.0.9) moved the pin to b11960 without new oracle files. Measured
//!   there with the same argv (Qwen3.5-9B Q4_K_M, Metal, 8K): weights and
//!   KV/RS buffers identical, compute buffers +16 MiB on the card and +16 MiB
//!   on the processor (120.02/40.02 against 104.39/24.02). The after-start
//!   check reads the real numbers, so that gap is caught there.
//!
//!   * weights: summed per layer from the tensor table (llama-model.cpp,
//!     `load_tensors`). `-ngl N` puts the OUTPUT layer on the card first and
//!     then the last N-1 repeating layers (`i_gpu_start = n_layer + 1 - N`);
//!     the token embedding always stays on the processor, and a model without
//!     its own output matrix gets a copy of the embedding for it.
//!   * KV cache: per layer, K and V widths apart (`n_embd_k_gqa(il)`), the KV
//!     heads per layer (an array in the head when they differ), separate head
//!     widths for sliding window layers (`key_length_swa`), MLA keeping only
//!     its latent K, layers that reuse another layer's cache (Gemma 3n/4).
//!     The server runs 4 slots on one unified cache (`-np` auto), so a full
//!     attention layer keeps `ctx` cells and a sliding window layer
//!     `n_swa * 4 + 512` (llama-kv-cache-iswa.cpp), both padded to 256.
//!   * recurrent state of Mamba/SSM and of the recurrent layers of a hybrid
//!     (Qwen3-Next, Qwen3.5, Granite 4, Jamba, Nemotron-H, LFM2):
//!     `(n_embd_r + n_embd_s) * 4 bytes * 4 slots` per layer, no KV there.
//!   * the KV type (f16, bf16, q8_0, q4_0), with V padded to the widest layer
//!     when Flash Attention is off.
//!   * work buffers: fitted to what the server reports (see `compute_bytes`).
//!
//! The plan is pure: no file is read and no card asked here, the callers in
//! engine.rs collect the inputs. So every answer can be checked on a machine
//! without the card it is about.

use crate::commands::gguf::GgufHead;

pub(crate) const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;

/// llama-server's slots when `-np` is not given: 4, on one unified KV cache
/// (tools/server/server.cpp). LU never passes `-np`.
pub(crate) const SERVER_SLOTS: u64 = 4;
/// Physical batch (`-ub`), llama.cpp's default. The sliding window cache adds
/// one of these to the window, and the work buffers scale with it.
pub(crate) const UBATCH: u64 = 512;

/// The KV cache types LU offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KvType {
    F16,
    Bf16,
    Q8_0,
    Q4_0,
}

impl KvType {
    /// Anything LU does not offer reads as f16, which is what llama-server
    /// gets when engine.rs leaves the flag out.
    pub(crate) fn parse(s: &str) -> Self {
        match s {
            "bf16" => Self::Bf16,
            "q8_0" => Self::Q8_0,
            "q4_0" => Self::Q4_0,
            _ => Self::F16,
        }
    }

    /// `ggml_row_size`: bytes for `n` elements of this type.
    pub(crate) fn row_bytes(self, n: u64) -> u64 {
        match self {
            Self::F16 | Self::Bf16 => n * 2,
            Self::Q8_0 => n.div_ceil(32) * 34,
            Self::Q4_0 => n.div_ceil(32) * 18,
        }
    }
}

/// One repeating layer, as far as memory goes.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Layer {
    /// Bytes of every tensor of this layer.
    pub weights: u64,
    /// The part of `weights` in MoE expert tensors (`ffn_*_exps`), the part
    /// `--n-cpu-moe` keeps on the processor.
    pub experts: u64,
    /// Cached K and V elements per token, 0 for a layer without a KV cache
    /// of its own (recurrent, reusing another layer's, MLA's V).
    pub k: u64,
    pub v: u64,
    /// Uses the sliding window (or chunked) cache.
    pub swa: bool,
    /// Bytes of recurrent state this layer keeps for all slots.
    pub state: u64,
    /// The largest single tensor of this layer. A layer whose weights stay on
    /// the processor gets its big matrix products done on the card anyway
    /// when a batch is large (ggml's op offload), and the copy of the weight
    /// lands in the card's work buffer.
    pub largest: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Window {
    /// Every layer attends to the whole context.
    None,
    /// Some layers keep only the last `n` tokens (Gemma 2/3/4, gpt-oss,
    /// Cohere 2, OLMo 2, EXAONE 4) or attend in chunks of `n` (Llama 4).
    Sliding(u64),
}

/// A model, as the plan sees it. Built from the GGUF head by `from_head`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ModelShape {
    pub arch: String,
    pub layers: Vec<Layer>,
    /// Stays on the processor whatever `-ngl` says (token embedding).
    pub input: u64,
    /// The output layer: final norm and output matrix (or the copy of the
    /// embedding a tied model gets). The first thing `-ngl` puts on the card.
    pub output: u64,
    pub window: Window,
    pub n_embd: u64,
    pub n_vocab: u64,
    /// The widest FFN of any layer (the work buffers scale with it), for an
    /// MoE layer the routed experts' width times the experts used.
    pub n_ff: u64,
    /// Query heads times key width, the widest layer.
    pub q_width: u64,
    /// The most query heads of any layer.
    pub n_head: u64,
    pub ctx_train: Option<u32>,
    /// Models llama.cpp runs without any cache (embedding and diffusion).
    pub no_cache: bool,
    /// A tensor of a type this build does not know: the weights are then
    /// taken from the file size instead.
    pub unknown_types: bool,
}

/// Architectures llama.cpp creates no memory for (llama-model.cpp,
/// `create_memory`).
pub(crate) const NO_CACHE_ARCHS: &[&str] = &[
    "bert", "jina-bert-v2", "jina-bert-v3", "nomic-bert", "nomic-bert-moe", "neo-bert", "eurobert",
    "wavtokenizer-dec", "modern-bert", "gemma-embedding", "dream", "llada", "llada-moe", "rnd1",
];

/// Purely recurrent architectures (llama-arch.cpp, `llm_arch_is_recurrent`).
const RECURRENT_ARCHS: &[&str] = &["mamba", "mamba2", "rwkv6", "rwkv6qwen2", "rwkv7", "arwkv7"];

/// Hybrids that mark a layer recurrent by giving it no KV heads.
const RECURRENT_BY_ZERO_HEADS: &[&str] = &["jamba", "granitehybrid", "lfm2", "lfm2moe", "plamo2", "kimi-linear"];

/// Architectures that skip their NextN/MTP layers' tensors in a normal start
/// (`TENSOR_SKIP` in their `load_arch_tensors`).
const SKIPS_NEXTN_WEIGHTS: &[&str] = &["bailingmoe2", "deepseek32", "exaone4", "exaone-moe", "glm4", "glm4moe", "glm-dsa", "kimi-linear", "mimo2"];

/// `<name>` is an MoE expert tensor (common.h, `LLM_FFN_EXPS_REGEX`).
fn is_expert_tensor(name: &str) -> bool {
    ["ffn_up_exps", "ffn_down_exps", "ffn_gate_exps", "ffn_gate_up_exps", "ffn_up_chexps", "ffn_down_chexps", "ffn_gate_chexps", "ffn_gate_up_chexps"]
        .iter()
        .any(|p| name.contains(p))
}

/// The layer a `blk.<il>.` tensor belongs to.
fn block_of(name: &str) -> Option<usize> {
    let rest = name.strip_prefix("blk.")?;
    rest[..rest.find('.')?].parse().ok()
}

/// Tensors of the output layer.
fn is_output_tensor(name: &str) -> bool {
    name.starts_with("output.") || name.starts_with("output_norm.") || name.starts_with("cls.") || name.starts_with("cls_out.")
}

/// `set_swa_pattern` of llama-hparams.cpp.
fn swa_pattern(n_layer: usize, period: i64, dense_first: bool) -> Vec<bool> {
    (0..n_layer)
        .map(|il| {
            let il = il as i64;
            if period <= 0 {
                true
            } else if dense_first {
                il % period != 0
            } else {
                il % period < period - 1
            }
        })
        .collect()
}

impl ModelShape {
    /// The model in this head, `None` when the head names no architecture or
    /// no layer count, which leaves the caller on its old behaviour.
    pub(crate) fn from_head(head: &GgufHead, file_bytes: u64) -> Option<Self> {
        let arch = head.arch()?.to_string();
        let n_all = usize::try_from(head.arch_int("block_count")?).ok().filter(|n| *n > 0 && *n <= 4096)?;
        let a = arch.as_str();
        let nextn = head.arch_int("nextn_predict_layers").unwrap_or(0).clamp(0, n_all as i64 - 1) as usize;
        let n_layer = n_all - nextn;
        let n_embd = head.arch_int("embedding_length").unwrap_or(0).max(0) as u64;

        let heads = head.arch_per_layer("attention.head_count", n_all).unwrap_or_else(|| vec![0; n_all]);
        // n_head_kv defaults to n_head (llama-model.cpp, load_hparams).
        let heads_kv = head.arch_per_layer("attention.head_count_kv", n_all).unwrap_or_else(|| heads.clone());
        let n_head0 = heads.first().copied().unwrap_or(0).max(0) as u64;
        let default_width = n_embd.checked_div(n_head0).unwrap_or(0);
        let head_k = head.arch_int("attention.key_length").map(|v| v.max(0) as u64).unwrap_or(default_width);
        let head_v = head.arch_int("attention.value_length").map(|v| v.max(0) as u64).unwrap_or(default_width);
        let head_k_swa = head.arch_int("attention.key_length_swa").map(|v| v.max(0) as u64).unwrap_or(head_k);
        let head_v_swa = head.arch_int("attention.value_length_swa").map(|v| v.max(0) as u64).unwrap_or(head_v);
        let mla = head.arch_int("attention.key_length_mla").unwrap_or(0) > 0 && head.arch_int("attention.value_length_mla").unwrap_or(0) > 0;
        let ffs = head.arch_per_layer("feed_forward_length", n_all).unwrap_or_else(|| vec![0; n_all]);

        // ── which layers slide (each model file of llama.cpp's src/models) ──
        let n_swa_key = head.arch_int("attention.sliding_window").unwrap_or(0).max(0) as u64;
        let pattern_scalar = (!head.arch_is_array("attention.sliding_window_pattern"))
            .then(|| head.arch_int("attention.sliding_window_pattern"))
            .flatten();
        let pattern_array = || -> Vec<bool> {
            head.arch_per_layer("attention.sliding_window_pattern", n_all)
                .filter(|_| head.arch_is_array("attention.sliding_window_pattern"))
                .map(|v| v.into_iter().map(|b| b != 0).collect())
                .unwrap_or_else(|| vec![false; n_all])
        };
        let periodic = |default: i64, dense_first: bool| swa_pattern(n_all, pattern_scalar.unwrap_or(default), dense_first);
        let (n_swa, swa): (u64, Vec<bool>) = match a {
            "gemma2" => (if n_swa_key > 0 { n_swa_key } else { 4096 }, periodic(2, false)),
            "gemma3" | "olmo2" | "afmoe" | "plamo3" if n_swa_key > 0 => {
                let d = match a { "gemma3" => 6, "plamo3" => 8, _ => 4 };
                (n_swa_key, periodic(d, false))
            }
            "gemma3n" => (n_swa_key, periodic(5, false)),
            "gemma4" | "gemma4-assistant" | "mimo2" | "step35" | "dflash" => (n_swa_key, pattern_array()),
            "cohere2" => (n_swa_key, periodic(4, false)),
            "cohere2moe" => (n_swa_key, if pattern_scalar.is_some() { periodic(4, true) } else { pattern_array() }),
            "exaone-moe" => (if n_swa_key > 0 { n_swa_key } else { 128 }, periodic(4, false)),
            "exaone4" if n_layer == 64 => (if n_swa_key > 0 { n_swa_key } else { 4096 }, periodic(4, false)),
            "gpt-oss" => (n_swa_key, periodic(2, false)),
            "smallthinker" if n_swa_key > 0 => (4096, periodic(4, true)),
            "mellum" if n_swa_key > 0 => (n_swa_key, if pattern_scalar.is_some() { periodic(4, false) } else { pattern_array() }),
            // Llama 4 attends in chunks of 8192 unless the head says 0.
            "llama4" if head.arch_int("attention.sliding_window") != Some(0) => (8192, periodic(4, false)),
            _ => (0, vec![false; n_all]),
        };

        // ── which layers are recurrent ──
        let recurrent: Vec<bool> = if RECURRENT_ARCHS.contains(&a) || a == "falcon-h1" {
            vec![true; n_all]
        } else if RECURRENT_BY_ZERO_HEADS.contains(&a) {
            (0..n_all).map(|il| il < n_layer && heads_kv[il] == 0).collect()
        } else if a == "nemotron_h" || a == "nemotron_h_moe" {
            (0..n_all).map(|il| il < n_layer && heads_kv[il] == 0 && ffs[il] == 0).collect()
        } else if matches!(a, "qwen3next" | "qwen35" | "qwen35moe") {
            match head.arch_per_layer("attention.recurrent_layers", n_all) {
                Some(v) if head.arch_is_array("attention.recurrent_layers") => v.into_iter().map(|b| b != 0).collect(),
                _ => {
                    let every = head.arch_int("full_attention_interval").filter(|n| *n > 0).unwrap_or(4) as usize;
                    (0..n_all).map(|il| il < n_layer && (il + 1) % every != 0).collect()
                }
            }
        } else {
            vec![false; n_all]
        };
        // LFM2 slides on every attention layer when the head names a window.
        let swa: Vec<bool> = if a == "lfm2" && n_swa_key > 0 { recurrent.iter().map(|r| !r).collect() } else { swa };
        let n_swa = if a == "lfm2" && n_swa_key > 0 { n_swa_key } else { n_swa };
        let window = if n_swa > 0 && swa.iter().any(|s| *s) { Window::Sliding(n_swa) } else { Window::None };
        let swa: Vec<bool> = if window == Window::None { vec![false; n_all] } else { swa };

        // ── recurrent state width (llama-hparams.cpp, n_embd_r / n_embd_s) ──
        let ssm = |k: &str| head.arch_int(k).unwrap_or(0).max(0) as u64;
        let (embd_r, embd_s) = if ssm("wkv.head_size") > 0 {
            let shift = head.arch_int("token_shift_count").unwrap_or(2).max(0) as u64;
            (shift * n_embd, n_embd * ssm("wkv.head_size"))
        } else if ssm("shortconv.l_cache") > 0 {
            (n_embd * (ssm("shortconv.l_cache") - 1), 0)
        } else if ssm("kda.head_dim") > 0 {
            let d = ssm("kda.head_dim");
            let conv = if ssm("ssm.conv_kernel") > 0 { ssm("ssm.conv_kernel") - 1 } else { 3 };
            (3 * conv * n_head0 * d, d * d * n_head0)
        } else {
            let conv = ssm("ssm.conv_kernel").saturating_sub(1);
            let inner = ssm("ssm.inner_size");
            let state = ssm("ssm.state_size");
            (conv * (inner + 2 * ssm("ssm.group_count") * state), state * inner)
        };
        // `mem_size = max(1, n_seq_max)` rows of f32 per recurrent layer.
        let state_bytes = (embd_r + embd_s) * 4 * SERVER_SLOTS;

        // ── which layers keep a KV cache of their own ──
        let kv_from_start: Option<usize> = match a {
            "gemma3n" => Some(20),
            "gemma4" => Some(n_all.saturating_sub(head.arch_int("attention.shared_kv_layers").unwrap_or(0).max(0) as usize)),
            _ => None,
        };
        let no_cache = NO_CACHE_ARCHS.contains(&a);
        let mut layers: Vec<Layer> = (0..n_all)
            .map(|il| {
                let rec = recurrent[il];
                let attends = !(no_cache || rec && a != "falcon-h1")
                    && kv_from_start.is_none_or(|k| il < k)
                    // Qwen3.5 and Step 3.5 keep no cache for their MTP layers
                    // in a normal start (`create_memory` filters).
                    && !(matches!(a, "qwen35" | "qwen35moe" | "step35") && il >= n_layer);
                let hk = heads_kv[il].max(0) as u64;
                let (wk, wv) = if swa[il] { (head_k_swa, head_v_swa) } else { (head_k, head_v) };
                Layer {
                    k: if attends { hk * wk } else { 0 },
                    v: if attends && !mla { hk * wv } else { 0 },
                    swa: swa[il],
                    state: if rec && il < n_layer && !no_cache { state_bytes } else { 0 },
                    ..Layer::default()
                }
            })
            .collect();

        // ── weights from the tensor table ──
        let mut input = 0u64;
        let mut output = 0u64;
        let mut embd = 0u64;
        let mut has_output_matrix = false;
        let mut unknown_types = false;
        let mut n_vocab = 0u64;
        for t in &head.tensors {
            let Some(bytes) = t.bytes() else {
                unknown_types = true;
                continue;
            };
            if let Some(il) = block_of(&t.name) {
                if let Some(l) = layers.get_mut(il) {
                    if il >= n_layer && SKIPS_NEXTN_WEIGHTS.contains(&a) {
                        continue;
                    }
                    l.weights += bytes;
                    l.largest = l.largest.max(bytes);
                    if is_expert_tensor(&t.name) {
                        l.experts += bytes;
                    }
                }
            } else if is_output_tensor(&t.name) {
                output += bytes;
                if t.name == "output.weight" {
                    has_output_matrix = true;
                    n_vocab = n_vocab.max(t.dims.get(1).copied().unwrap_or(0));
                }
            } else {
                input += bytes;
                if t.name == "token_embd.weight" {
                    embd = bytes;
                    n_vocab = n_vocab.max(t.dims.get(1).copied().unwrap_or(0));
                }
            }
        }
        if !has_output_matrix {
            // Tied embeddings: the output layer gets its own copy of the
            // embedding (`TENSOR_DUPLICATED`).
            output += embd;
        }
        if unknown_types || head.tensors.is_empty() {
            // No tensor table to sum: spread the file over the layers, the
            // way the plan did before 3.0.8.
            unknown_types = true;
            let per = file_bytes / n_all as u64;
            for l in &mut layers {
                l.weights = per;
                l.experts = 0;
                l.largest = per / 4;
            }
            input = 0;
            output = 0;
        }

        let n_expert_used = head.arch_int("expert_used_count").unwrap_or(0).max(0) as u64;
        let n_ff_exp = head.arch_int("expert_feed_forward_length").unwrap_or(0).max(0) as u64;
        let n_ff = ffs.iter().map(|f| f.max(&0)).copied().max().unwrap_or(0) as u64;
        let n_ff = n_ff.max(n_expert_used * n_ff_exp);
        let q_width = heads
            .iter()
            .zip(swa.iter())
            .map(|(h, s)| h.max(&0).unsigned_abs() * if *s { head_k_swa } else { head_k })
            .max()
            .unwrap_or(0);

        Some(Self {
            arch,
            layers,
            input,
            output,
            window,
            n_embd,
            n_vocab,
            n_ff,
            q_width,
            n_head: heads.iter().map(|h| h.max(&0).unsigned_abs()).max().unwrap_or(0),
            ctx_train: head.arch_int("context_length").and_then(|v| u32::try_from(v).ok()),
            no_cache,
            unknown_types,
        })
    }

    /// A model whose head names no architecture the plan can read: the file
    /// spread evenly over its layers and a cache of 4 KiB per token per
    /// layer, the flat rate 3.0.7 priced every model with. The layer count is
    /// taken low (16) when the head does not name one, because it only
    /// divides the file: a count below the truth asks for fewer layers than
    /// fit, never more.
    pub(crate) fn rough(file_bytes: u64, block_count: Option<u32>) -> Self {
        let n = block_count.filter(|b| *b > 0 && *b <= 4096).unwrap_or(16) as usize;
        let per = file_bytes / n as u64;
        Self {
            arch: String::new(),
            layers: vec![Layer { weights: per, k: 1024, v: 1024, largest: per / 4, ..Layer::default() }; n],
            input: 0,
            output: 0,
            window: Window::None,
            n_embd: 4096,
            n_vocab: 0,
            n_ff: 14336,
            q_width: 4096,
            n_head: 32,
            ctx_train: None,
            no_cache: false,
            unknown_types: true,
        }
    }

    pub(crate) fn n_layer(&self) -> u32 {
        self.layers.len() as u32
    }

    /// What `-ngl` means "everything": every layer and the output layer.
    pub(crate) fn all_layers(&self) -> u32 {
        self.n_layer() + 1
    }

    pub(crate) fn is_moe(&self) -> bool {
        self.layers.iter().any(|l| l.experts > 0)
    }

    #[cfg(test)]
    pub(crate) fn weights(&self) -> u64 {
        self.input + self.output + self.layers.iter().map(|l| l.weights).sum::<u64>()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FlashAttn {
    /// llama.cpp decides per device; it turns it on wherever the backend
    /// has a kernel for the model's head widths, which is every common case
    /// on CUDA, Metal and Vulkan. The plan prices it as on, and the check
    /// after the start (`EngineReport`) sees when it was not.
    Auto,
    On,
    Off,
}

impl FlashAttn {
    pub(crate) fn parse(s: &str) -> Self {
        match s {
            "on" => Self::On,
            "off" => Self::Off,
            _ => Self::Auto,
        }
    }
}

/// What a start asks for that changes the memory it takes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct CacheConfig {
    pub ctx: u32,
    pub k: KvType,
    pub v: KvType,
    pub flash_attn: FlashAttn,
    /// The backend runs the attention of a layer on the processor on the
    /// card for a long prompt, copying that layer's cache there (Vulkan and
    /// CUDA do, Metal does not; measured on the box, see `compute_bytes_placed`).
    pub offload_copies_cache: bool,
}

impl CacheConfig {
    pub(crate) fn with_ctx(self, ctx: u32) -> Self {
        Self { ctx, ..self }
    }

    pub(crate) fn new(ctx: u32, k: &str, v: &str, fa: &str) -> Self {
        Self { ctx, k: KvType::parse(k), v: KvType::parse(v), flash_attn: FlashAttn::parse(fa), offload_copies_cache: !cfg!(target_os = "macos") }
    }
}

fn pad(n: u64, to: u64) -> u64 {
    n.div_ceil(to) * to
}

impl ModelShape {
    /// Cells of the full attention cache and of the sliding window cache.
    pub(crate) fn cells(&self, ctx: u32) -> (u64, u64) {
        // llama-context.cpp pads n_ctx to 256; the unified cache keeps it all.
        let base = pad(ctx.max(1) as u64, 256);
        let swa = match self.window {
            Window::None => 0,
            Window::Sliding(n) => pad(base.min(n * SERVER_SLOTS + UBATCH), 256),
        };
        (base, swa)
    }

    /// Bytes of cache layer `il` keeps (KV or recurrent state).
    pub(crate) fn layer_cache(&self, il: usize, cfg: &CacheConfig) -> u64 {
        let Some(l) = self.layers.get(il) else { return 0 };
        let (base, swa) = self.cells(cfg.ctx);
        let cells = if l.swa { swa } else { base };
        // With Flash Attention off, V is stored transposed and every layer's
        // V is padded to the widest one (llama-kv-cache.cpp, v_trans).
        let v = if cfg.flash_attn == FlashAttn::Off && l.v > 0 {
            self.layers.iter().map(|x| x.v).max().unwrap_or(l.v)
        } else {
            l.v
        };
        let kv = if l.k > 0 { cells * (cfg.k.row_bytes(l.k) + cfg.v.row_bytes(v)) } else { 0 };
        kv + l.state
    }

    /// The whole cache.
    pub(crate) fn cache_bytes(&self, cfg: &CacheConfig) -> u64 {
        (0..self.layers.len()).map(|il| self.layer_cache(il, cfg)).sum()
    }
}

/// Where the parts of a start go.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct Placement {
    /// `-ngl` as llama.cpp counts it: the output layer, then repeating
    /// layers from the last one down. `all_layers()` is everything.
    pub ngl: u32,
    /// `--n-cpu-moe`: the expert tensors of the first this many layers stay
    /// on the processor (the rest of those layers is on the card).
    pub cpu_moe: u32,
}

/// Memory of one start, split by where it lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct Need {
    pub weights: u64,
    pub cache: u64,
    pub compute: u64,
}

impl Need {
    pub(crate) fn total(&self) -> u64 {
        self.weights + self.cache + self.compute
    }
}

/// Graphics card and RAM side of one placement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct Split {
    pub card: Need,
    pub host: Need,
    /// Repeating layers on the card (without the output layer).
    pub layers_on_card: u32,
}

impl ModelShape {
    /// Which repeating layers `-ngl n` puts on the card: `il >= first`.
    fn first_card_layer(&self, ngl: u32) -> usize {
        (self.all_layers().saturating_sub(ngl)) as usize
    }

    /// The memory of a start with this placement and cache.
    pub(crate) fn split(&self, place: Placement, cfg: &CacheConfig, part: &ImagePart) -> Split {
        let ngl = place.ngl.min(self.all_layers());
        let first = self.first_card_layer(ngl);
        let mut card = Need::default();
        let mut host = Need { weights: self.input, ..Need::default() };
        if ngl >= 1 {
            card.weights += self.output;
        } else {
            host.weights += self.output;
        }
        for (il, l) in self.layers.iter().enumerate() {
            let cache = self.layer_cache(il, cfg);
            if il >= first && ngl >= 1 {
                let cpu_experts = if (il as u32) < place.cpu_moe { l.experts } else { 0 };
                card.weights += l.weights - cpu_experts;
                host.weights += cpu_experts;
                card.cache += cache;
            } else {
                host.weights += l.weights;
                host.cache += cache;
            }
        }
        let layers_on_card = (self.layers.len() - first.min(self.layers.len())) as u32;
        let (cc, hc) = self.compute_bytes_placed(Placement { ngl, cpu_moe: place.cpu_moe }, cfg);
        card.compute = cc;
        host.compute = hc;
        // The image part goes to the card whenever anything does
        // (mmproj offload is on by default), with its own work buffer.
        if part.bytes > 0 {
            let p = if ngl >= 1 { &mut card } else { &mut host };
            p.weights += part.bytes;
            p.compute += part.compute;
        }
        Split { card, host, layers_on_card }
    }

    /// Work buffers (card, host) llama-server allocates for this start.
    ///
    /// FITTED, not derived. The buffers are what ggml's graph allocator needs
    /// at the peak of one ubatch of 512 tokens, and that depends on each
    /// architecture's graph. What `llama-server -lv 4` reported for the
    /// twelve heads in fixtures/gguf-heads (server-compute-b9949-metal.json)
    /// comes down to:
    ///
    ///   * about ten copies of the hidden state and three of the queries of a
    ///     ubatch in f32 (least squares over the twelve, then 20 % on top so
    ///     the fit errs high: none of them is underestimated by more than
    ///     20 MiB);
    ///   * the attention mask, cells x ubatch in f16, once for the full cache
    ///     and once for the window cache, on the card and again on the host
    ///     where it is built. That is the 56 MiB every model gains from 8K
    ///     to 64K;
    ///   * without Flash Attention the attention matrix of one layer, cells x
    ///     ubatch x heads in f32, which is what makes a long context without
    ///     it so costly (2 GiB at 32K for an 8B model);
    ///   * with weights on the processor, the largest of their tensors, which
    ///     ggml copies to the card for a long prompt (op offload); for an MoE
    ///     model that is a whole expert block, 280 MiB for Gemma 4 26B.
    ///
    /// The tests hold the fit to the reported sizes, and the check after
    /// every start corrects a model it got wrong (`learn`).
    pub(crate) fn compute_bytes_placed(&self, place: Placement, cfg: &CacheConfig) -> (u64, u64) {
        let (base, swa) = self.cells(cfg.ctx);
        let unit = UBATCH * 4;
        let graph = (unit * (10 * self.n_embd + 3 * self.q_width) + 10 * MIB) * 6 / 5;
        let full_layers = self.layers.iter().any(|l| l.k > 0 && !l.swa);
        let mask = if full_layers { base * UBATCH * 2 } else { 0 } + swa * UBATCH * 2;
        let attn = if cfg.flash_attn == FlashAttn::Off {
            let cells = if full_layers { base } else { swa };
            cells * UBATCH * self.n_head.max(1) * 4 * 19 / 20
        } else {
            0
        };
        let ngl = place.ngl.min(self.all_layers());
        let first = self.first_card_layer(ngl);
        // The largest weight that stays on the processor and is multiplied
        // in a batch: whole layers below `first`, the experts of the first
        // `cpu_moe` layers.
        let cpu_largest = self
            .layers
            .iter()
            .enumerate()
            .map(|(il, l)| {
                if (il < first || ngl == 0) && l.experts > 0 {
                    l.largest
                } else if (il as u32) < place.cpu_moe && l.experts > 0 {
                    l.largest.min(l.experts)
                } else {
                    0
                }
            })
            .max()
            .unwrap_or(0);
        // A layer on the processor keeps its cache there, and for a long
        // prompt its attention runs on the card anyway, with that cache
        // copied into the work buffer: Qwen3-4B at 64K with 34 of 37 layers
        // on an RTX 3060 (Vulkan) reserved 479 MiB instead of 83, one
        // layer's 256 MiB of cache and some. MLA multiplies with its latent
        // cache like with a weight and copies it twice (GLM-4.7-Flash at 64K
        // with ten layers on the card, Metal: 144 MiB more).
        let mla = self.layers.iter().any(|l| l.k > 0) && self.layers.iter().all(|l| l.v == 0);
        let biggest_cpu_cache = (0..first.min(self.layers.len())).map(|il| self.layer_cache(il, cfg)).max().unwrap_or(0);
        let mla_copy = if ngl >= 1 && first > 0 && biggest_cpu_cache > 0 {
            if mla {
                2 * biggest_cpu_cache
            } else if cfg.offload_copies_cache {
                biggest_cpu_cache + 64 * MIB
            } else {
                0
            }
        } else {
            0
        };
        let some_on_host = ngl < self.all_layers() || place.cpu_moe > 0;
        let card = if ngl >= 1 || cpu_largest > 0 {
            let own = if ngl >= 1 { graph + mask + attn } else { 0 };
            own.max(cpu_largest + mask) + mla_copy
        } else {
            0
        };
        let host = if some_on_host && (ngl < self.all_layers()) {
            graph + mask + attn + 16 * MIB
        } else {
            20 * MIB + mask
        };
        (card, host)
    }
}

/// The image part (mmproj) of a start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct ImagePart {
    pub bytes: u64,
    /// The work buffer of the image encoder at its largest picture.
    pub compute: u64,
}

impl ImagePart {
    /// A projector of `bytes` on disk whose head was not read: priced as an
    /// image encoder (see `from_head`).
    #[cfg(test)]
    pub(crate) fn of(bytes: u64) -> Self {
        Self::priced(bytes, true, false)
    }

    /// A projector, priced from its head: the weights once, plus the work
    /// buffer each encoder reserves for its largest input. Measured with
    /// llama-server -lv 4 (b9949): the image encoder of gemma-4-31B (1145
    /// MiB) reserves 151 MiB for a 768x768 picture, llama.cpp's own estimate
    /// for the part is 1302 MiB; the audio encoder of a Gemma 4 12B part 59
    /// MiB. Priced at 160 MiB or 14 % of the weights for pictures, whichever
    /// is more, and 64 MiB for sound.
    pub(crate) fn from_head(bytes: u64, head: Option<&GgufHead>) -> Self {
        let flag = |k: &str| head.and_then(|h| h.keys.get(k)).map(|m| matches!(m, crate::commands::gguf::Meta::Int(1)));
        let vision = flag("clip.has_vision_encoder").unwrap_or(true);
        let audio = flag("clip.has_audio_encoder").unwrap_or(false);
        Self::priced(bytes, vision, audio)
    }

    fn priced(bytes: u64, vision: bool, audio: bool) -> Self {
        if bytes == 0 {
            return Self::default();
        }
        let picture = if vision { (bytes / 100 * 14).max(160 * MIB) } else { 0 };
        let sound = if audio { 64 * MIB } else { 0 };
        Self { bytes, compute: picture + sound }
    }
}

// ── Planning ─────────────────────────────────────────────────────────────

/// Graphics memory held back from what a probe reports, before the plan
/// spends any of it.
///
/// Measured-free (`nvidia-smi`'s memory.free, `llama-server --list-devices`)
/// is what the card has left right now. What the engine needs on top of the
/// buffers this file counts is the CUDA context and cuBLAS' workspace,
/// measured at 280 to 420 MiB on the box (RTX 3060, driver 581) as the gap
/// between nvidia-smi before and after a start and the buffers llama.cpp
/// reports, and llama.cpp's own fit leaves 1 GiB for the same reason
/// (`--fit-target`, default 1024). Between the two: 768 MiB. That covers the
/// context, the alignment of a few hundred buffers, and a browser that opens
/// a tab while the model loads, and costs one or two layers of a big model.
pub(crate) const RESERVE_MEASURED: u64 = 768 * MIB;

/// The reserve when only the card's TOTAL is known (`detect_gpus`, no free
/// reading): the desktop, a browser and the last render may hold some of it.
pub(crate) const RESERVE_UNMEASURED: u64 = 2048 * MIB;

/// How much of a Mac's memory Metal lets one process use when the system
/// does not say (`iogpu.wired_limit_mb` 0): about two thirds up to 36 GB of
/// RAM and three quarters above, which is what
/// `recommendedMaxWorkingSetSize` answers on Apple silicon.
pub(crate) fn mac_gpu_budget(total_ram: u64, wired_limit_mb: u64) -> u64 {
    if wired_limit_mb > 0 {
        return wired_limit_mb * MIB;
    }
    if total_ram <= 36 * GIB {
        total_ram / 3 * 2
    } else {
        total_ram / 4 * 3
    }
}

/// What a plan may spend on the card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Budget {
    /// Bytes the probe reported.
    pub bytes: u64,
    /// `bytes` is free memory (true) or the card's total (false).
    pub free: bool,
    /// What the check after earlier starts learned the engine takes on the
    /// card beyond its buffers (`Calibration::overhead`), 0 when nothing
    /// was learned yet.
    pub learned_overhead: u64,
}

impl Budget {
    pub(crate) fn reserve(&self) -> u64 {
        let base = if self.free { RESERVE_MEASURED } else { RESERVE_UNMEASURED };
        base.max(self.learned_overhead + 256 * MIB)
    }

    /// What the buffers may take.
    pub(crate) fn usable(&self) -> u64 {
        self.bytes.saturating_sub(self.reserve())
    }
}

/// The best placement within `usable` bytes of the card: as many layers as
/// fit, and for an MoE model that does not fit whole, every layer on the card
/// with the experts of the first layers on the processor (`--n-cpu-moe`),
/// which is what llama.cpp's own fit does and runs about twice as fast as
/// whole layers on the processor, because the expert weights are the bulk of
/// an MoE layer and only a few of them are read per token.
pub(crate) fn place(shape: &ModelShape, cfg: &CacheConfig, part: &ImagePart, usable: u64) -> Placement {
    let all = shape.all_layers();
    let fits = |p: Placement| shape.split(p, cfg, part).card.total() <= usable;
    if fits(Placement { ngl: all, cpu_moe: 0 }) {
        return Placement { ngl: all, cpu_moe: 0 };
    }
    if shape.is_moe() {
        // Fewest layers' experts off the card such that the rest fits.
        let n = shape.n_layer();
        if let Some(k) = (1..=n).find(|k| fits(Placement { ngl: all, cpu_moe: *k })) {
            return Placement { ngl: all, cpu_moe: k };
        }
    }
    // Dense (or an MoE whose non-expert part alone does not fit): whole
    // layers, from the output layer down.
    let ngl = (0..all).rev().find(|n| fits(Placement { ngl: *n, cpu_moe: 0 })).unwrap_or(0);
    Placement { ngl, cpu_moe: 0 }
}

/// Repeating layers a placement has on the card, for the sentence a person
/// reads ("33 of 60 layers"). An MoE placement with experts off the card
/// counts its layers as on the card minus a share for the experts: what the
/// person wants to know is how much of the model runs at the card's speed.
pub(crate) fn layers_on_card(shape: &ModelShape, place: Placement) -> u32 {
    let n = shape.n_layer();
    let on = place.ngl.min(shape.all_layers()).saturating_sub(1).min(n);
    if place.cpu_moe == 0 {
        return on;
    }
    let total: u64 = shape.layers.iter().map(|l| l.weights).sum();
    let off: u64 = shape.layers.iter().take(place.cpu_moe as usize).map(|l| l.experts).sum();
    if total == 0 {
        return on;
    }
    (((total - off.min(total)) as f64 / total as f64) * n as f64).floor() as u32
}

// ── The check after a start (step 4 of A25) ──────────────────────────────

/// What llama-server says it allocated, read from its start (it prints the
/// sizes with `-lv 4`): per kind, card and host apart.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct EngineReport {
    pub card: Need,
    pub host: Need,
    /// `offloaded N/M layers to GPU`.
    pub offloaded: Option<(u32, u32)>,
    /// The image encoder's weights and work buffer, as clip reports them.
    pub image_part: u64,
    /// Flash Attention as the context came up (`flash_attn = enabled`).
    pub flash_attn: Option<bool>,
}

/// A buffer name that lives in RAM: `CPU`, `CPU_Mapped`, `CPU_REPACK`,
/// `CUDA_Host`, `Vulkan_Host`, ... Everything else (`CUDA0`, `Vulkan0`,
/// `ROCm0`, `MTL0`, `MTL0_Mapped`) is a device.
fn is_host_buffer(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.starts_with("cpu") || n.ends_with("_host") || n == "host"
}

fn mib_value(s: &str) -> Option<u64> {
    let v: f64 = s.trim().parse().ok()?;
    (v.is_finite() && v >= 0.0).then(|| (v * MIB as f64).round() as u64)
}

/// Read the buffer lines of a llama-server start.
///
///   load_tensors:        CUDA0 model buffer size =  7600.00 MiB
///   llama_kv_cache:      CUDA0 KV buffer size =  4240.00 MiB
///   llama_memory_recurrent:  CUDA0 RS buffer size =   599.00 MiB
///   sched_reserve:       CUDA0 compute buffer size =   533.00 MiB
///   llama_context:  CUDA_Host  output buffer size =     3.97 MiB
///   load_tensors: offloaded 22/61 layers to GPU
///
/// and the image encoder's (`clip_model_loader: ... model size: N MiB`,
/// `alloc_compute_meta: CUDA0 compute buffer size = N MiB`). `None` when the
/// text has no buffer line at all (an engine started without `-lv 4`).
pub(crate) fn parse_engine_report(text: &str) -> Option<EngineReport> {
    let mut r = EngineReport::default();
    let mut any = false;
    for line in text.lines() {
        if let Some(at) = line.find("offloaded ") {
            let rest = &line[at + "offloaded ".len()..];
            if let Some((a, b)) = rest.split_once('/') {
                let b = b.split_whitespace().next().unwrap_or("");
                if let (Ok(a), Ok(b)) = (a.trim().parse(), b.parse()) {
                    r.offloaded = Some((a, b));
                }
            }
            continue;
        }
        if line.contains("flash_attn") && line.contains('=') {
            let v = line.rsplit('=').next().unwrap_or("").trim();
            match v {
                "enabled" | "on" | "1" | "true" => r.flash_attn = Some(true),
                "disabled" | "off" | "0" | "false" => r.flash_attn = Some(false),
                _ => {}
            }
        }
        let Some(at) = line.find(" buffer size =") else { continue };
        let before = line[..at].trim_end();
        let mut words = before.split_whitespace().rev();
        let kind = words.next().unwrap_or("");
        let buf = words.next().unwrap_or("");
        let Some(bytes) = mib_value(line[at + " buffer size =".len()..].trim().trim_end_matches("MiB")) else { continue };
        // The image encoder's work buffer (clip.cpp, `reserve_compute_meta`;
        // `alloc_compute_meta` in older builds) belongs to the image part.
        let clip = line.contains("compute_meta") || line.contains("clip");
        if clip {
            if !is_host_buffer(buf) {
                r.image_part += bytes;
            }
            any = true;
            continue;
        }
        let side = if is_host_buffer(buf) { &mut r.host } else { &mut r.card };
        match kind {
            "model" => side.weights += bytes,
            "KV" | "RS" => side.cache += bytes,
            "compute" | "output" => side.compute += bytes,
            _ => continue,
        }
        any = true;
    }
    // The image encoder names its weights in a line of its own, once per
    // encoder (a part with pictures and sound loads twice and says so twice;
    // the weights are counted once).
    if let Some(v) = text
        .lines()
        .filter(|l| (l.contains("clip_model_loader") || l.contains("load_hparams")) && l.contains("model size:"))
        .filter_map(|l| l.split("model size:").nth(1).and_then(|s| mib_value(s.trim().trim_end_matches("MiB").trim())))
        .max()
    {
        r.image_part += v;
        any = true;
    }
    any.then_some(r)
}

/// How far a report is from the plan, as one sentence for the log.
pub(crate) fn compare_sentence(plan: &Split, report: &EngineReport) -> String {
    let m = |b: u64| b / MIB;
    format!(
        "plan check: on the card the plan said {} MiB (weights {}, cache {}, work {}), llama.cpp allocated {} MiB (weights {}, cache {}, work {}){}; in RAM the plan said {} MiB, llama.cpp {} MiB",
        m(plan.card.total()),
        m(plan.card.weights),
        m(plan.card.cache),
        m(plan.card.compute),
        m(report.card.total()),
        m(report.card.weights),
        m(report.card.cache),
        m(report.card.compute),
        if report.image_part > 0 { format!(", image part {} MiB", m(report.image_part)) } else { String::new() },
        m(plan.host.total()),
        m(report.host.total()),
    )
}

/// What earlier starts of a model taught the plan. Kept per model file and
/// cache config in `engine-memory.json` next to the settings
/// (engine.rs, `calibration_for`).
#[derive(Debug, Clone, Copy, PartialEq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Calibration {
    /// Card bytes llama.cpp allocated beyond the plan's (0 when the plan was
    /// high or right). Added to the next plan of the same model and config.
    pub extra: u64,
    /// Card memory the engine took beyond its buffers (driver context,
    /// cuBLAS), from nvidia-smi before and after the start.
    pub overhead: u64,
}

/// A plan that came out this much too low is corrected at the next start;
/// below it the difference is alignment and noise.
pub(crate) const CORRECTION_THRESHOLD: u64 = 128 * MIB;

/// What a finished start teaches: the gap between plan and report on the
/// card, when the plan was too low by more than the threshold, and the
/// overhead beyond the buffers when nvidia-smi saw the card before and after.
/// Never more than 4 GiB of either: a number that large is a misreading (a
/// second program loading at the same time), not a lesson.
pub(crate) fn learn(plan: &Split, report: &EngineReport, free_before: Option<u64>, free_after: Option<u64>) -> Calibration {
    let gap = report.card.total().saturating_sub(plan.card.total());
    let extra = if gap > CORRECTION_THRESHOLD { gap.min(4 * GIB) } else { 0 };
    let overhead = match (free_before, free_after) {
        (Some(b), Some(a)) if b > a => (b - a).saturating_sub(report.card.total() + report.image_part).min(4 * GIB),
        _ => 0,
    };
    Calibration { extra, overhead }
}

// ── The start decision: context, layers, image part, advice ──────────────

/// What the person asked for, in the terms the plan needs (from the LU
/// Engine settings, engine.rs `EngineTuning`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Request {
    pub cache: CacheConfig,
    /// The context was set by the person (Settings or the chat's context
    /// menu), not left at the default. A chosen context is never changed.
    pub ctx_chosen: bool,
    /// A layer count typed into Settings; `None` is the auto default.
    pub typed_layers: Option<u32>,
}

/// The machine side of a start.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Card {
    /// Nothing measured a card: every layer is asked for, as always.
    None,
    /// A card, with what may be spent on it.
    Measured(Budget),
    /// A Mac: one memory for the processor and the graphics, of which Metal
    /// lets one process use `budget` bytes.
    Unified { budget: u64 },
}

/// One button under the advice.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FitAction {
    /// What the button says ("Context 16K", "KV q8_0").
    pub label: String,
    /// The context it sets, when it sets one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ctx: Option<u32>,
    /// The KV type it sets for K and V, when it sets one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kv: Option<&'static str>,
}

/// The sentence a person reads about how the model fits, with the buttons
/// that change it. Shown in the model menu's standing line and in Settings,
/// LU Engine (`fitNote` in `bundled_engine_status`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FitAdvice {
    pub text: String,
    pub actions: Vec<FitAction>,
}

/// What a start does about memory.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct StartDecision {
    /// The context the start uses.
    pub ctx: u32,
    /// `-ngl`: `None` asks for every layer exactly as before 3.0.8.
    pub ngl: Option<u32>,
    /// `--n-cpu-moe`, 0 for none.
    pub cpu_moe: u32,
    /// Whether the image part is loaded.
    pub with_image_part: bool,
    /// `--cache-ram` in MiB when the prompt cache in RAM is capped, `None`
    /// for llama-server's default (8 GiB).
    pub cache_ram_mib: Option<u64>,
    /// One English clause for the log line.
    pub why: String,
    /// What the plan expects, for the check after the start.
    pub plan: Option<Split>,
    pub advice: Option<FitAdvice>,
}

/// The default context of the LU Engine (engine.rs `effective_ctx`).
pub(crate) const DEFAULT_CTX: u32 = 8192;

/// How far the auto default may raise the context when everything fits with
/// room to spare. 32K is what the agent mode asks for anyway
/// (AGENT_CONTEXT_CAP in the frontend), long enough for documents and long
/// chats, and still a small cache for the window and hybrid models. Above it
/// the cache of a full-attention model grows into gigabytes nobody asked for,
/// memory a render in Create would then have to take back.
pub(crate) const AUTO_CTX_CAP: u32 = 32768;

/// The steps the auto default and the advice choose from.
const CTX_STEPS: &[u32] = &[8192, 16384, 32768, 65536, 131072];

fn k_label(ctx: u32) -> String {
    if ctx >= 1024 && ctx.is_multiple_of(1024) { format!("{}K", ctx / 1024) } else { ctx.to_string() }
}

fn gb(bytes: u64) -> String {
    let v = bytes as f64 / GIB as f64;
    if v >= 10.0 { format!("{v:.0} GB") } else { format!("{v:.1} GB") }
}

/// Share of the RAM a PC's model may take before the advice says the
/// computer will get slow; on a Mac its memory as a whole. Same lines as the
/// "Tight fit" sentence of 3.0.7 drew (engine.rs, memory_fit_note).
const TIGHT_RAM_SHARE_PC: f64 = 0.5;
const TIGHT_RAM_SHARE_MAC: f64 = 0.7;

/// The machine's RAM and whether it is a Mac.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Host {
    pub total_ram: u64,
    pub mac: bool,
}

/// Decide a start: the context, the layers on the card, the experts kept on
/// the processor, whether the image part comes along, how much RAM the
/// prompt cache may take, and what to tell the person.
///
/// The person's settings are never changed behind their back: a chosen
/// context and the KV type stay as they are, and when they cost layers the
/// advice says how many and offers the change as a button. Only the default
/// context, which nobody chose, is raised by the plan when the card has room.
pub(crate) fn decide(shape: &ModelShape, req: &Request, card: Card, host: Host, part: ImagePart, calibration: Calibration) -> StartDecision {
    let all = shape.all_layers();
    let n = shape.n_layer();
    let mut cfg = req.cache;
    let train = shape.ctx_train.unwrap_or(u32::MAX).max(1);

    // ── a typed layer count: the person's answer, nothing is planned ──
    if let Some(typed) = req.typed_layers {
        let plan = shape.split(Placement { ngl: typed, cpu_moe: 0 }, &cfg, &part);
        return StartDecision {
            ctx: cfg.ctx,
            ngl: Some(typed),
            cpu_moe: 0,
            with_image_part: true,
            cache_ram_mib: cache_ram_cap(&plan, host),
            why: format!("GPU layers was set to {typed} in Settings, so that is what the engine gets"),
            advice: ram_advice(&plan, host, typed.min(all) == 0, None).map(|text| FitAdvice { text, actions: vec![] }),
            plan: Some(plan),
        };
    }

    match card {
        Card::None => {
            let plan = shape.split(Placement { ngl: all, cpu_moe: 0 }, &cfg, &part);
            StartDecision {
                ctx: cfg.ctx,
                ngl: None,
                cpu_moe: 0,
                with_image_part: true,
                cache_ram_mib: None,
                why: "no probe measured graphics memory on this machine, so every layer is requested exactly as before".into(),
                plan: Some(plan),
                advice: None,
            }
        }
        Card::Unified { budget } => {
            // A Mac: every layer on Metal, whatever the plan; what can be
            // planned is the context, against what Metal lets one process
            // use and what the rest of the Mac needs.
            let limit = budget.min((host.total_ram as f64 * TIGHT_RAM_SHARE_MAC) as u64);
            let need = |c: &CacheConfig| shape.split(Placement { ngl: all, cpu_moe: 0 }, c, &part).card.total();
            let mut raised = None;
            if !req.ctx_chosen {
                let c = auto_ctx(cfg.ctx, train, |ctx| need(&CacheConfig { ctx, ..cfg }) + GIB <= limit);
                if c != cfg.ctx {
                    raised = Some(c);
                    cfg.ctx = c;
                }
            }
            let plan = shape.split(Placement { ngl: all, cpu_moe: 0 }, &cfg, &part);
            let total = plan.card.total();
            let advice = (total > limit).then(|| {
                let mut text = format!(
                    "With {} context this model needs about {}, more than the {} this Mac can give it without slowing down.",
                    k_label(cfg.ctx),
                    gb(total),
                    gb(limit)
                );
                let mut actions = vec![];
                if let Some(smaller) = smaller_ctx_that_fits(shape, &cfg, |c| need(c) <= limit) {
                    text.push_str(&format!(" {} needs {}.", k_label(smaller), gb(need(&CacheConfig { ctx: smaller, ..cfg }))));
                    actions.push(FitAction { label: format!("Context {}", k_label(smaller)), ctx: Some(smaller), kv: None });
                }
                if let Some(a) = q8_action(&cfg) {
                    actions.push(a);
                }
                FitAdvice { text, actions }
            });
            StartDecision {
                ctx: cfg.ctx,
                ngl: None,
                cpu_moe: 0,
                with_image_part: true,
                cache_ram_mib: None,
                why: format!(
                    "a Mac shares its memory with the graphics: model, cache and work buffers need about {} MiB of the {} MiB Metal gives one program{}",
                    total / MIB,
                    limit / MIB,
                    raised.map(|r| format!(", so the context nobody chose is set to {r}, the most that fits")).unwrap_or_default()
                ),
                plan: Some(plan),
                advice,
                // Prompt cache: unified memory is the same RAM.
            }
        }
        Card::Measured(budget) => {
            let usable = budget.usable().saturating_sub(calibration.extra);
            let reserve = budget.bytes - budget.bytes.min(usable);
            let vram_clause = if budget.free {
                format!("{} MiB are free", budget.bytes / MIB)
            } else {
                format!("the card holds {} MiB in total (actual free memory was not measured)", budget.bytes / MIB)
            };
            // The image part: when the model fits whole without it but not
            // with it, the model is loaded whole and without the part (a
            // chat at the card's speed that cannot see beats one that can
            // and crawls; October 2026). A part that does not fit at all is
            // left out too.
            let none = ImagePart::default();
            let full = |c: &CacheConfig, p: &ImagePart| place(shape, c, p, usable) == Placement { ngl: all, cpu_moe: 0 };

            // ── the default context may grow while everything fits ──
            let mut raised = None;
            // Only against memory that was measured free: a card's total says
            // nothing about what the desktop and a browser hold of it.
            if !req.ctx_chosen && budget.free {
                let c = auto_ctx(cfg.ctx, train, |ctx| full(&CacheConfig { ctx, ..cfg }, &part));
                if c != cfg.ctx {
                    raised = Some(c);
                    cfg.ctx = c;
                }
            }

            let mut with_part = true;
            let mut use_part = part;
            let pushes_off = !full(&cfg, &part) && full(&cfg, &none);
            let never_fits = part.bytes + part.compute >= usable;
            if part.bytes > 0 && (pushes_off || never_fits) {
                with_part = false;
                use_part = none;
            }
            let p = place(shape, &cfg, &use_part, usable);
            let plan = shape.split(p, &cfg, &use_part);
            let everything = p == Placement { ngl: all, cpu_moe: 0 };
            let on = layers_on_card(shape, p);
            let need_all = shape.split(Placement { ngl: all, cpu_moe: 0 }, &cfg, &use_part).card.total();

            let why = if everything {
                let what = if use_part.bytes > 0 { "the model, its cache and its image part" } else { "the model and its cache" };
                let mut w = format!("{what} need about {} MiB on the card and {vram_clause}, so every layer is requested", need_all / MIB);
                if let Some(r) = raised {
                    w.push_str(&format!(", and the context nobody chose is set to {r}, the most that fits"));
                }
                if part.bytes > 0 && !with_part {
                    w.push_str(&format!(", but the image part needs {} MiB more than that leaves, so the model is loaded without image input", (part.bytes + part.compute) / MIB));
                }
                w
            } else if p.cpu_moe > 0 {
                format!(
                    "the model and its cache need about {} MiB on the card but {vram_clause}, so every layer goes on the card with the experts of the first {} of {n} layers on the processor (--n-cpu-moe), {} MiB held back for the driver",
                    need_all / MIB,
                    p.cpu_moe,
                    reserve / MIB
                )
            } else {
                format!(
                    "the model and its cache need about {} MiB on the card but {vram_clause}, so {on} of {n} layers and the output layer go on the card (-ngl {}), {} MiB of weights and cache per layer on average and {} MiB held back for the driver",
                    need_all / MIB,
                    p.ngl,
                    plan.card.weights.saturating_add(plan.card.cache).checked_div(p.ngl.max(1) as u64).unwrap_or(0) / MIB,
                    reserve / MIB
                )
            };

            // A card whose free memory was not measured gets its layers from
            // llama.cpp's own fit (engine.rs, GH #156), so a layer count
            // worked out here against its total would be a number the engine
            // does not follow. Only the RAM half is said then.
            let advice = if everything || !budget.free {
                ram_advice(&plan, host, false, None).map(|text| FitAdvice { text, actions: vec![] })
            } else {
                Some(card_advice(shape, req, &cfg, &use_part, usable, p, &plan, host))
            };
            StartDecision {
                ctx: cfg.ctx,
                // Every layer, with or without experts on the processor, is
                // the sentinel the app has always sent.
                ngl: (p.ngl < all).then_some(p.ngl),
                cpu_moe: p.cpu_moe,
                with_image_part: with_part,
                cache_ram_mib: cache_ram_cap(&plan, host),
                why,
                plan: Some(plan),
                advice,
            }
        }
    }
}

/// The context for a start whose context nobody chose: as much as fits.
///
/// `asked` is the house default (8192) or the agent mode's own raise
/// (frontend `ensureBuiltinAgentCtx`, up to 32K). The plan goes up to 32K
/// (`AUTO_CTX_CAP`) while everything still fits, and down when the asked
/// context would cost layers on the card, but never below the house default,
/// and never below 16K for an agent raise, whose system prompt and tools
/// need the room. When nothing fits whole, that floor is the answer: it buys
/// the most layers among the contexts allowed.
pub(crate) fn auto_ctx(asked: u32, trained: u32, fits: impl Fn(u32) -> bool) -> u32 {
    let floor = if asked > DEFAULT_CTX { asked.min(16384) } else { asked };
    let ceiling = asked.max(AUTO_CTX_CAP).min(trained.max(floor));
    let mut options: Vec<u32> = CTX_STEPS.iter().copied().filter(|s| *s >= floor && *s <= ceiling).collect();
    options.push(asked.min(ceiling).max(floor));
    options.sort_unstable();
    options.dedup();
    options.iter().rev().copied().find(|c| fits(*c)).unwrap_or(floor)
}

/// The largest context below the current one (from the usual steps) for
/// which `ok` holds, or `None`.
fn smaller_ctx_that_fits(shape: &ModelShape, cfg: &CacheConfig, ok: impl Fn(&CacheConfig) -> bool) -> Option<u32> {
    let _ = shape;
    CTX_STEPS.iter().rev().copied().filter(|s| *s < cfg.ctx).find(|s| ok(&CacheConfig { ctx: *s, ..*cfg }))
}

/// "KV q8_0", when the cache is not quantized already.
fn q8_action(cfg: &CacheConfig) -> Option<FitAction> {
    let wide = |t: KvType| matches!(t, KvType::F16 | KvType::Bf16);
    (wide(cfg.k) || wide(cfg.v)).then(|| FitAction { label: "KV q8_0".into(), ctx: None, kv: Some("q8_0") })
}

/// The sentence for a model that does not fit the card whole.
#[allow(clippy::too_many_arguments)]
fn card_advice(shape: &ModelShape, req: &Request, cfg: &CacheConfig, part: &ImagePart, usable: u64, p: Placement, plan: &Split, host: Host) -> FitAdvice {
    let n = shape.n_layer();
    let all = Placement { ngl: shape.all_layers(), cpu_moe: 0 };
    let on = layers_on_card(shape, p);
    let layers_at = |c: &CacheConfig| layers_on_card(shape, place(shape, c, part, usable));
    let fits_at = |c: &CacheConfig| place(shape, c, part, usable) == all;
    let mut actions = vec![];
    let _ = req;
    let lead = if cfg.ctx > DEFAULT_CTX {
        format!("With {} context, {on} of {n} layers fit on the graphics card; the rest run on the processor, which is slower.", k_label(cfg.ctx))
    } else {
        format!("This model is larger than the graphics card: {on} of {n} layers fit, the rest run on the processor, which is slower.")
    };
    let mut text = lead;
    // A shorter context: the largest one that fits everything, or else the
    // largest step within one layer of the best the shorter steps reach, if
    // that buys any. A window model gains little below 16K (its window cache
    // does not shrink), so 8K would cost half the context for one layer.
    let shorter = smaller_ctx_that_fits(shape, cfg, fits_at).or_else(|| {
        let steps: Vec<(u32, u32)> = CTX_STEPS
            .iter()
            .copied()
            .filter(|s| *s < cfg.ctx && *s >= DEFAULT_CTX)
            .map(|s| (s, layers_at(&CacheConfig { ctx: s, ..*cfg })))
            .collect();
        let best = steps.iter().map(|(_, l)| *l).max()?;
        steps.iter().filter(|(_, l)| *l + 1 >= best && *l > on).map(|(s, _)| *s).max()
    });
    if let Some(s) = shorter {
        let c = CacheConfig { ctx: s, ..*cfg };
        if fits_at(&c) {
            text.push_str(&format!(" With {}, all of it fits.", k_label(s)));
        } else {
            text.push_str(&format!(" With {}, {} fit.", k_label(s), layers_at(&c)));
        }
        actions.push(FitAction { label: format!("Context {}", k_label(s)), ctx: Some(s), kv: None });
    }
    if let Some(a) = q8_action(cfg) {
        let c = CacheConfig { k: KvType::Q8_0, v: KvType::Q8_0, ..*cfg };
        let gain = layers_at(&c);
        if fits_at(&c) {
            text.push_str(" With KV q8_0, all of it fits.");
            actions.push(a);
        } else if gain > on {
            text.push_str(&format!(" With KV q8_0, {gain} fit."));
            actions.push(a);
        }
    }
    if let Some(ram) = ram_advice(plan, host, p.ngl == 0, Some(())) {
        text.push(' ');
        text.push_str(&ram);
    }
    FitAdvice { text, actions }
}

/// The RAM half: a model that holds more than half a PC's RAM (or 70 % of a
/// Mac's) leaves the rest of the computer little room. `short` drops the
/// lead-in when it follows a sentence about the card.
fn ram_advice(plan: &Split, host: Host, all_on_cpu: bool, short: Option<()>) -> Option<String> {
    if host.total_ram == 0 {
        return None;
    }
    let in_ram = plan.host.total();
    let share = if host.mac { TIGHT_RAM_SHARE_MAC } else { TIGHT_RAM_SHARE_PC };
    if host.mac || (in_ram as f64) <= host.total_ram as f64 * share {
        return None;
    }
    Some(if short.is_some() {
        format!("That keeps about {} of this PC's {} RAM busy, so other programs get little room.", gb(in_ram), gb(host.total_ram))
    } else if all_on_cpu {
        format!("Tight fit: all of this model runs on the processor and keeps about {} of this PC's {} RAM busy, so other programs get little room.", gb(in_ram), gb(host.total_ram))
    } else {
        format!("Tight fit: about {} of this model stay in RAM, of this PC's {}, so other programs get little room.", gb(in_ram), gb(host.total_ram))
    })
}

/// llama-server keeps finished prompts in RAM to answer the next turn of a
/// chat faster (`--cache-ram`, 8 GiB by default). On a PC whose RAM already
/// holds most of the model that cache is what fills the rest. Capped there
/// to what is left after the model and 4 GiB for the system and the app,
/// never below 512 MiB (one long chat), never above the default.
fn cache_ram_cap(plan: &Split, host: Host) -> Option<u64> {
    if host.mac || host.total_ram == 0 {
        return None;
    }
    let default = 8192 * MIB;
    let left = host.total_ram.saturating_sub(plan.host.total() + 4 * GIB);
    (left < default).then(|| (left.max(512 * MIB)) / MIB)
}

#[cfg(test)]
#[path = "vram_plan_tests.rs"]
mod tests;
