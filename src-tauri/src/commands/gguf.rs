//! Minimal, defensive GGUF header reader (ENG-6c).
//!
//! The bundled llama-server exposes neither `n_ctx_train` on `/props` nor any
//! model metadata on `/v1/models` (verified against b1-049326a), so the only
//! source for a model's TRAINED context limit is the GGUF header itself:
//! `general.architecture` = "<arch>", then `<arch>.context_length`. The
//! Context dropdown uses it to cap its presets — without it a 32k model
//! happily "accepts" -c 131072 and degrades silently (llama.cpp only warns).
//!
//! The same header carries `<arch>.block_count`, the number of transformer
//! layers `-ngl` counts in. The engine start needs it to answer "how much of
//! this model fits on this card" with a layer count instead of the blanket
//! 999 that put a 12B model onto an 8 GB board (3.0.0 list, bugs u and a).
//!
//! Deliberately paranoid: this runs against user-downloaded files inside
//! `list_bundled_models`, so it must NEVER panic or stall the listing —
//! every failure path is `None`, reads are bounded, and only the header is
//! touched (a few KB of a multi-GB file).

use std::fs::File;
use std::io::{BufReader, Read};

const GGUF_MAGIC: &[u8; 4] = b"GGUF";
/// Real models carry a few dozen KV pairs; hundreds is already absurd.
const MAX_KV: u64 = 4096;
/// Longest key/string value we are willing to read (keys are ~30 chars).
const MAX_STR: u64 = 64 * 1024;
/// Longest metadata array we are willing to SKIP element-by-element
/// (tokenizer vocabularies easily reach 150k entries).
const MAX_ARR: u64 = 10_000_000;

struct R<'a>(&'a mut dyn Read);

impl R<'_> {
    fn u8(&mut self) -> Option<u8> {
        let mut b = [0u8; 1];
        self.0.read_exact(&mut b).ok()?;
        Some(b[0])
    }
    fn u32(&mut self) -> Option<u32> {
        let mut b = [0u8; 4];
        self.0.read_exact(&mut b).ok()?;
        Some(u32::from_le_bytes(b))
    }
    fn u64(&mut self) -> Option<u64> {
        let mut b = [0u8; 8];
        self.0.read_exact(&mut b).ok()?;
        Some(u64::from_le_bytes(b))
    }
    fn skip(&mut self, n: u64) -> Option<()> {
        // io::copy into a sink honors non-seekable readers and bounds memory.
        // (&mut *) reborrows the trait object as a Sized `&mut dyn Read` so
        // `take` can consume it.
        let copied = std::io::copy(&mut (&mut *self.0).take(n), &mut std::io::sink()).ok()?;
        (copied == n).then_some(())
    }
    fn string(&mut self, max: u64) -> Option<String> {
        let len = self.u64()?;
        if len > max {
            return None;
        }
        let mut buf = vec![0u8; len as usize];
        self.0.read_exact(&mut buf).ok()?;
        String::from_utf8(buf).ok()
    }
}

/// GGUF metadata value types (spec v3). Returns the byte size of FIXED-width
/// types; strings/arrays are handled by the caller.
fn fixed_size(ty: u32) -> Option<u64> {
    match ty {
        0 | 1 | 7 => Some(1), // u8 / i8 / bool
        2 | 3 => Some(2),     // u16 / i16
        4..=6 => Some(4), // u32 / i32 / f32
        10..=12 => Some(8), // u64 / i64 / f64
        _ => None,            // 8 = string, 9 = array, unknown
    }
}

enum Val {
    UInt(u64),
    Str(String),
    Other,
}

fn read_value(r: &mut R, ty: u32) -> Option<Val> {
    match ty {
        4 => Some(Val::UInt(r.u32()? as u64)),
        10 => Some(Val::UInt(r.u64()?)),
        0 => Some(Val::UInt(r.u8()? as u64)),
        2 => {
            let mut b = [0u8; 2];
            r.0.read_exact(&mut b).ok()?;
            Some(Val::UInt(u16::from_le_bytes(b) as u64))
        }
        8 => Some(Val::Str(r.string(MAX_STR)?)),
        9 => {
            // array: elem type + count, then elements — skip it whole.
            let elem_ty = r.u32()?;
            let count = r.u64()?;
            if count > MAX_ARR {
                return None;
            }
            if let Some(sz) = fixed_size(elem_ty) {
                r.skip(count.checked_mul(sz)?)?;
            } else if elem_ty == 8 {
                for _ in 0..count {
                    let len = r.u64()?;
                    if len > MAX_STR {
                        return None;
                    }
                    r.skip(len)?;
                }
            } else {
                return None; // nested arrays / unknown — bail out
            }
            Some(Val::Other)
        }
        _ => {
            r.skip(fixed_size(ty)?)?;
            Some(Val::Other)
        }
    }
}

/// The numbers this app reads out of a GGUF header.
///
/// Every field is independently optional: a header can name its architecture
/// and its context length and say nothing about its layers, and a file that
/// is not a GGUF at all answers with all of them empty rather than an error.
/// Nothing here is ever a reason to refuse a model.
#[derive(Debug, Default, PartialEq)]
pub struct HeaderFacts {
    /// `<arch>.context_length`, the context the model was TRAINED with.
    pub context_length: Option<u32>,
    /// `<arch>.block_count`, how many transformer layers there are to
    /// offload. This is the denominator of the per-layer size the engine
    /// start divides the free graphics memory by.
    pub block_count: Option<u32>,
}

/// The context length the model was TRAINED with (`<arch>.context_length`),
/// or `None` when the file is missing, not GGUF, truncated, or simply does
/// not carry the key. Never panics, never reads past the header.
pub fn context_length(path: &str) -> Option<u32> {
    // `list_bundled_models` calls this once per file in the models folder and
    // wants nothing else, so the scan is told it may stop at the first answer.
    scan_header(path, false).unwrap_or_default().context_length
}

/// Context length AND layer count in one pass. Costs more than
/// `context_length` on a file that carries no `block_count`, because the scan
/// then has to walk past the tokenizer vocabulary before it can say so; the
/// engine start pays that once per start, not once per listed model.
pub fn read_header(path: &str) -> HeaderFacts {
    scan_header(path, true).unwrap_or_default()
}

/// One bounded pass over the KV block.
///
/// `need_blocks` decides when the scan is allowed to stop early. Returns
/// `None` for anything that is not a readable GGUF header, which the callers
/// turn into empty facts. A header that ends mid-field is not evidence of
/// anything, and inventing a number from half a file is how a model gets
/// loaded with arguments nobody can explain afterwards.
fn scan_header(path: &str, need_blocks: bool) -> Option<HeaderFacts> {
    let file = File::open(path).ok()?;
    let mut buf = BufReader::new(file);
    let mut r = R(&mut buf);

    let mut magic = [0u8; 4];
    r.0.read_exact(&mut magic).ok()?;
    if &magic != GGUF_MAGIC {
        return None;
    }
    let version = r.u32()?;
    if !(2..=3).contains(&version) {
        return None;
    }
    let _tensor_count = r.u64()?;
    let kv_count = r.u64()?;
    if kv_count > MAX_KV {
        return None;
    }

    let mut arch: Option<String> = None;
    let mut ctx_by_key: Option<(String, u64)> = None;
    let mut blocks_by_key: Option<(String, u64)> = None;

    for _ in 0..kv_count {
        let key = r.string(MAX_STR)?;
        let ty = r.u32()?;
        let val = read_value(&mut r, ty)?;
        match val {
            Val::Str(s) if key == "general.architecture" => arch = Some(s),
            Val::UInt(n) if key.ends_with(".context_length") => {
                ctx_by_key = Some((key, n));
            }
            Val::UInt(n) if key.ends_with(".block_count") => {
                blocks_by_key = Some((key, n));
            }
            _ => {}
        }
        // Early exit once everything the caller asked for is known and agrees
        // with the architecture. What follows in a real file is the tokenizer
        // vocabulary, which is megabytes of skipping for nothing.
        if let Some(a) = &arch {
            let ctx_done = matches_arch(&ctx_by_key, a, "context_length");
            let blocks_done = !need_blocks || matches_arch(&blocks_by_key, a, "block_count");
            if ctx_done && blocks_done {
                return Some(HeaderFacts {
                    context_length: resolve(arch.as_deref(), ctx_by_key, "context_length"),
                    block_count: resolve(arch.as_deref(), blocks_by_key, "block_count"),
                });
            }
        }
    }

    // Architecture key came AFTER the numbers (order is unspecified), or the
    // arch never showed up. `resolve` accepts a lone match in that case.
    Some(HeaderFacts {
        context_length: resolve(arch.as_deref(), ctx_by_key, "context_length"),
        block_count: resolve(arch.as_deref(), blocks_by_key, "block_count"),
    })
}

/// The `general.*` part of a header: what the file says about itself.
///
/// The refusal-removal tool (`commands::abliterate`) reads where a GGUF came
/// from (`general.source.*`, `general.license.link`, `general.base_model.*`),
/// what it is called, its license and its quantization (`general.file_type`),
/// and whether LU made it (`general.description`). Strings only, plus the one
/// number; everything else is skipped. Same rules as above: bounded, never
/// panics, and a file that is not a GGUF answers with nothing.
#[derive(Debug, Default, PartialEq)]
pub struct GeneralFacts {
    pub strings: std::collections::BTreeMap<String, String>,
    pub file_type: Option<u32>,
}

impl GeneralFacts {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.strings.get(key).map(String::as_str).filter(|s| !s.trim().is_empty())
    }
}

/// One pass up to the tokenizer. Writers put `general.*` first and the
/// tokenizer last, and `general.file_type` sits between the architecture's
/// numbers and the vocabulary, so the vocabulary is never read.
pub fn read_general(path: &str) -> GeneralFacts {
    scan_general(path).unwrap_or_default()
}

fn scan_general(path: &str) -> Option<GeneralFacts> {
    let file = File::open(path).ok()?;
    let mut buf = BufReader::new(file);
    let mut r = R(&mut buf);
    let mut magic = [0u8; 4];
    r.0.read_exact(&mut magic).ok()?;
    if &magic != GGUF_MAGIC {
        return None;
    }
    let version = r.u32()?;
    if !(2..=3).contains(&version) {
        return None;
    }
    let _tensor_count = r.u64()?;
    let kv_count = r.u64()?;
    if kv_count > MAX_KV {
        return None;
    }
    let mut facts = GeneralFacts::default();
    for _ in 0..kv_count {
        let key = r.string(MAX_STR)?;
        if key.starts_with("tokenizer.") {
            break;
        }
        let ty = r.u32()?;
        match read_value(&mut r, ty)? {
            Val::Str(s) if key.starts_with("general.") => {
                facts.strings.insert(key, s);
            }
            Val::UInt(n) if key == "general.file_type" => facts.file_type = u32::try_from(n).ok(),
            _ => {}
        }
    }
    Some(facts)
}

/// True when `found` is the key this architecture would write.
fn matches_arch(found: &Option<(String, u64)>, arch: &str, suffix: &str) -> bool {
    matches!(found, Some((k, _)) if k == &format!("{arch}.{suffix}"))
}

/// The number, if the key belongs to this model's architecture, or if no
/// architecture was named at all, in which case a single `*.<suffix>` hit is
/// the only candidate there is.
fn resolve(arch: Option<&str>, found: Option<(String, u64)>, suffix: &str) -> Option<u32> {
    match (arch, found) {
        (Some(a), Some((k, n))) if k == format!("{a}.{suffix}") => u32::try_from(n).ok(),
        (None, Some((_, n))) => u32::try_from(n).ok(),
        _ => None,
    }
}

// ── The whole head: every key and the tensor table (3.0.8, A25) ──────────
//
// The VRAM plan (vram_plan.rs) needs more than two numbers. How much graphics
// memory a start takes is the weights of the layers that go to the card, the
// KV cache those layers keep, and the work buffers, and every one of those is
// written in the head: the KV heads per layer (an array when they differ,
// Gemma 4), the key and value widths (separate ones for the sliding window
// layers), the window and which layers use it, the state of the recurrent
// layers of a hybrid, the latent width of an MLA model, and the size and type
// of every tensor. The weights of a layer are summed from its own tensors, not
// taken as the file size over the layer count: the embedding and the output
// head of a model with a 262k vocabulary are a gigabyte each and belong to no
// layer, and an MoE layer is mostly experts.
//
// Same rules as above: bounded, never panics, `None` for anything that is not
// a readable head. The tokenizer arrays are skipped and only counted.

/// Numeric arrays longer than this are skipped (and only counted): per-layer
/// arrays are a few hundred entries, the tokenizer's are a hundred thousand.
const MAX_KEPT_ARRAY: u64 = 8192;
/// More tensors than any model has (DeepSeek V3 with every expert split out
/// has a few thousand).
const MAX_TENSORS: u64 = 1_000_000;
/// The longest tensor name we accept (llama.cpp's own limit is 64).
const MAX_TENSOR_NAME: u64 = 512;

/// One metadata value, as far as the plan needs it.
#[derive(Debug, Clone, PartialEq)]
pub enum Meta {
    /// Any unsigned or signed integer, or a bool (0/1).
    Int(i64),
    Float(f64),
    Str(String),
    /// An integer or bool array short enough to keep.
    Ints(Vec<i64>),
    /// Any other array: its element count, nothing else.
    Array(u64),
}

/// One entry of the tensor table.
#[derive(Debug, Clone, PartialEq)]
pub struct TensorInfo {
    pub name: String,
    /// `ne[0..n]`, innermost first, as the file lists them.
    pub dims: Vec<u64>,
    /// The ggml type number (`GGML_TYPE_*`).
    pub ggml_type: u32,
}

impl TensorInfo {
    /// Bytes this tensor takes in memory, `None` for a type this table does
    /// not know (a GGUF from a newer llama.cpp than the one LU ships).
    pub fn bytes(&self) -> Option<u64> {
        let (block, size) = ggml_type_block(self.ggml_type)?;
        let first = *self.dims.first().unwrap_or(&1);
        let rest: u64 = self.dims.iter().skip(1).try_fold(1u64, |a, d| a.checked_mul(*d))?;
        first.div_ceil(block).checked_mul(size)?.checked_mul(rest)
    }
}

/// (elements per block, bytes per block) of a ggml type, as ggml.c's
/// `type_traits` define them for llama.cpp b9949. The block sizes were
/// measured with `sizeof(block_*)` from ggml-common.h of that tree, not
/// copied from documentation. b11960 (the pin since E1, 3.0.9) has the same
/// type list (up to Q2_0 = 42, GGML_TYPE_COUNT 43) and the same block structs.
pub fn ggml_type_block(t: u32) -> Option<(u64, u64)> {
    Some(match t {
        0 => (1, 4),     // F32
        1 => (1, 2),     // F16
        2 => (32, 18),   // Q4_0
        3 => (32, 20),   // Q4_1
        6 => (32, 22),   // Q5_0
        7 => (32, 24),   // Q5_1
        8 => (32, 34),   // Q8_0
        9 => (32, 36),   // Q8_1
        10 => (256, 84), // Q2_K
        11 => (256, 110), // Q3_K
        12 => (256, 144), // Q4_K
        13 => (256, 176), // Q5_K
        14 => (256, 210), // Q6_K
        15 => (256, 292), // Q8_K
        16 => (256, 66), // IQ2_XXS
        17 => (256, 74), // IQ2_XS
        18 => (256, 98), // IQ3_XXS
        19 => (256, 50), // IQ1_S
        20 => (32, 18),  // IQ4_NL
        21 => (256, 110), // IQ3_S
        22 => (256, 82), // IQ2_S
        23 => (256, 136), // IQ4_XS
        24 => (1, 1),    // I8
        25 => (1, 2),    // I16
        26 => (1, 4),    // I32
        27 => (1, 8),    // I64
        28 => (1, 8),    // F64
        29 => (256, 56), // IQ1_M
        30 => (1, 2),    // BF16
        34 => (256, 54), // TQ1_0
        35 => (256, 66), // TQ2_0
        39 => (32, 17),  // MXFP4
        40 => (64, 36),  // NVFP4
        41 => (128, 18), // Q1_0
        42 => (64, 18),  // Q2_0
        _ => return None,
    })
}

/// A GGUF head read whole: its keys and its tensor table.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GgufHead {
    pub keys: std::collections::BTreeMap<String, Meta>,
    pub tensors: Vec<TensorInfo>,
}

impl GgufHead {
    pub fn arch(&self) -> Option<&str> {
        match self.keys.get("general.architecture") {
            Some(Meta::Str(s)) => Some(s.as_str()),
            _ => None,
        }
    }

    /// `<arch>.<suffix>` as an integer.
    pub fn arch_int(&self, suffix: &str) -> Option<i64> {
        let arch = self.arch()?;
        match self.keys.get(&format!("{arch}.{suffix}"))? {
            Meta::Int(n) => Some(*n),
            Meta::Float(f) if f.fract() == 0.0 => Some(*f as i64),
            _ => None,
        }
    }

    /// `<arch>.<suffix>` as one integer per layer: an array read as it is,
    /// a single value repeated (`get_key_or_arr` in llama.cpp). `None` when
    /// the key is missing or an array has the wrong length.
    pub fn arch_per_layer(&self, suffix: &str, n_layer: usize) -> Option<Vec<i64>> {
        let arch = self.arch()?;
        match self.keys.get(&format!("{arch}.{suffix}"))? {
            Meta::Int(n) => Some(vec![*n; n_layer]),
            Meta::Ints(v) if v.len() >= n_layer => Some(v[..n_layer].to_vec()),
            _ => None,
        }
    }

    /// Whether `<arch>.<suffix>` is an array (rather than a single value).
    pub fn arch_is_array(&self, suffix: &str) -> bool {
        self.arch()
            .and_then(|a| self.keys.get(&format!("{a}.{suffix}")))
            .is_some_and(|m| matches!(m, Meta::Ints(_) | Meta::Array(_)))
    }

    /// `split.count`, 1 for a model in one file.
    pub fn split_count(&self) -> u64 {
        match self.keys.get("split.count") {
            Some(Meta::Int(n)) if *n > 1 => *n as u64,
            _ => 1,
        }
    }
}

fn read_meta(r: &mut R, ty: u32) -> Option<Meta> {
    Some(match ty {
        0 => Meta::Int(r.u8()? as i64),
        1 => Meta::Int(r.u8()? as i8 as i64),
        2 | 3 => {
            let mut b = [0u8; 2];
            r.0.read_exact(&mut b).ok()?;
            if ty == 2 { Meta::Int(u16::from_le_bytes(b) as i64) } else { Meta::Int(i16::from_le_bytes(b) as i64) }
        }
        4 => Meta::Int(r.u32()? as i64),
        5 => Meta::Int(r.u32()? as i32 as i64),
        6 => Meta::Float(f32::from_bits(r.u32()?) as f64),
        7 => Meta::Int((r.u8()? != 0) as i64),
        8 => Meta::Str(r.string(MAX_STR)?),
        10 => Meta::Int(i64::try_from(r.u64()?).ok()?),
        11 => Meta::Int(r.u64()? as i64),
        12 => Meta::Float(f64::from_bits(r.u64()?)),
        9 => {
            let elem = r.u32()?;
            let count = r.u64()?;
            if count > MAX_ARR {
                return None;
            }
            let int_elem = matches!(elem, 0..=5 | 7 | 10 | 11);
            if int_elem && count <= MAX_KEPT_ARRAY {
                let mut v = Vec::with_capacity(count as usize);
                for _ in 0..count {
                    match read_meta(r, elem)? {
                        Meta::Int(n) => v.push(n),
                        _ => return None,
                    }
                }
                Meta::Ints(v)
            } else {
                // Skip it exactly as `read_value` does.
                if let Some(sz) = fixed_size(elem) {
                    r.skip(count.checked_mul(sz)?)?;
                } else if elem == 8 {
                    for _ in 0..count {
                        let len = r.u64()?;
                        if len > MAX_STR {
                            return None;
                        }
                        r.skip(len)?;
                    }
                } else {
                    return None;
                }
                Meta::Array(count)
            }
        }
        _ => return None,
    })
}

/// Read a GGUF head from any reader: every key and the tensor table, nothing
/// of the data behind it.
pub fn parse_head(reader: &mut dyn Read) -> Option<GgufHead> {
    let mut r = R(reader);
    let mut magic = [0u8; 4];
    r.0.read_exact(&mut magic).ok()?;
    if &magic != GGUF_MAGIC {
        return None;
    }
    let version = r.u32()?;
    if !(2..=3).contains(&version) {
        return None;
    }
    let tensor_count = r.u64()?;
    let kv_count = r.u64()?;
    if kv_count > MAX_KV || tensor_count > MAX_TENSORS {
        return None;
    }
    let mut head = GgufHead::default();
    for _ in 0..kv_count {
        let key = r.string(MAX_STR)?;
        let ty = r.u32()?;
        let val = read_meta(&mut r, ty)?;
        head.keys.insert(key, val);
    }
    head.tensors.reserve(tensor_count.min(65_536) as usize);
    for _ in 0..tensor_count {
        let name = r.string(MAX_TENSOR_NAME)?;
        let n_dims = r.u32()?;
        if n_dims > 8 {
            return None;
        }
        let mut dims = Vec::with_capacity(n_dims as usize);
        for _ in 0..n_dims {
            dims.push(r.u64()?);
        }
        let ggml_type = r.u32()?;
        let _offset = r.u64()?;
        head.tensors.push(TensorInfo { name, dims, ggml_type });
    }
    Some(head)
}

/// The sibling parts of a split model (`name-00001-of-00003.gguf`), in order,
/// the given file first. Just the given file when the name is not a split
/// name; `None` when a named part is missing.
fn split_parts(path: &std::path::Path, count: u64) -> Option<Vec<std::path::PathBuf>> {
    let file = path.file_name()?.to_str()?;
    let lower = file.to_ascii_lowercase();
    let at = lower.rfind("-of-")?;
    // `-00001-of-00003.gguf`: five digits before `-of-`, five after.
    let (num_start, rest) = (at.checked_sub(5)?, &file[at + 4..]);
    if file.as_bytes().get(num_start.checked_sub(1)?) != Some(&b'-') {
        return None;
    }
    let width = rest.find('.')?;
    let stem = &file[..num_start];
    let tail = &rest[width..];
    (1..=count)
        .map(|i| {
            let p = path.with_file_name(format!("{stem}{i:0w$}-of-{count:0w$}{tail}", w = width));
            p.is_file().then_some(p)
        })
        .collect()
}

/// The head of a model on disk, with the tensor tables of every part when it
/// is split. `None` when the file cannot be read as a GGUF head.
pub fn read_model_head(path: &str) -> Option<GgufHead> {
    let mut buf = BufReader::new(File::open(path).ok()?);
    let mut head = parse_head(&mut buf)?;
    let parts = head.split_count();
    if parts > 1 {
        if let Some(files) = split_parts(std::path::Path::new(path), parts) {
            for extra in files.iter().skip(1) {
                if let Some(h) = File::open(extra).ok().and_then(|f| parse_head(&mut BufReader::new(f))) {
                    head.tensors.extend(h.tensors);
                }
            }
        }
    }
    Some(head)
}

/// Bytes on disk of a model and all its parts, given its head.
pub fn model_file_bytes_of(path: &str, head: Option<&GgufHead>) -> u64 {
    let own = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let parts = head.map(|h| h.split_count()).unwrap_or(1);
    if parts <= 1 {
        return own;
    }
    split_parts(std::path::Path::new(path), parts)
        .map(|files| files.iter().filter_map(|p| std::fs::metadata(p).ok()).map(|m| m.len()).sum())
        .unwrap_or(own)
}

/// Bytes on disk of a model and all its parts.
#[cfg(test)]
pub fn model_file_bytes(path: &str) -> u64 {
    model_file_bytes_of(path, read_model_head(path).as_ref())
}

#[cfg(test)]
mod tests {
    use super::{context_length, read_general, read_header, HeaderFacts};
    use std::io::Write;

    // Tiny hand-rolled GGUF v3 writer — just enough for the header path.
    struct W(Vec<u8>);
    impl W {
        fn new(kv_count: u64) -> Self {
            let mut v = Vec::new();
            v.extend_from_slice(b"GGUF");
            v.extend_from_slice(&3u32.to_le_bytes()); // version
            v.extend_from_slice(&0u64.to_le_bytes()); // tensor_count
            v.extend_from_slice(&kv_count.to_le_bytes());
            W(v)
        }
        fn str_field(&mut self, key: &str, val: &str) {
            self.key(key);
            self.0.extend_from_slice(&8u32.to_le_bytes());
            self.0.extend_from_slice(&(val.len() as u64).to_le_bytes());
            self.0.extend_from_slice(val.as_bytes());
        }
        fn u32_field(&mut self, key: &str, val: u32) {
            self.key(key);
            self.0.extend_from_slice(&4u32.to_le_bytes());
            self.0.extend_from_slice(&val.to_le_bytes());
        }
        fn arr_str_field(&mut self, key: &str, items: &[&str]) {
            self.key(key);
            self.0.extend_from_slice(&9u32.to_le_bytes()); // array
            self.0.extend_from_slice(&8u32.to_le_bytes()); // of strings
            self.0.extend_from_slice(&(items.len() as u64).to_le_bytes());
            for s in items {
                self.0.extend_from_slice(&(s.len() as u64).to_le_bytes());
                self.0.extend_from_slice(s.as_bytes());
            }
        }
        fn key(&mut self, key: &str) {
            self.0.extend_from_slice(&(key.len() as u64).to_le_bytes());
            self.0.extend_from_slice(key.as_bytes());
        }
        fn write_to(&self, path: &std::path::Path) {
            let mut f = std::fs::File::create(path).unwrap();
            f.write_all(&self.0).unwrap();
        }
    }

    /// A directory these fixtures own for the length of one test.
    ///
    /// It used to be the FIXED `<temp>/lu-gguf-tests/`, with the fixture names
    /// fixed too (`ok.gguf`, `reversed.gguf`, …). Every concurrent copy of this
    /// test binary therefore wrote the same files, and `W::write_to` opens with
    /// `File::create` — which TRUNCATES. One copy truncating `reversed.gguf`
    /// while another was parsing it is a header that ends mid-field, and
    /// `context_length` correctly answers `None`.
    ///
    /// Measured on 01.09.2026 under three concurrent copies of the whole suite,
    /// ten rounds: `context_key_before_architecture_still_resolves` failed 2 of
    /// 30 and `reads_context_length_behind_skipped_values` 1 of 30, both with
    /// `left: None`. Nothing about the parser was wrong — the file under it was
    /// being rewritten mid-read.
    ///
    /// `test_dir` carries the process id and the thread id in the name and
    /// sweeps itself up on `Drop`. The returned guard has to stay in scope: the
    /// directory is removed when it is dropped.
    fn fixtures(tag: &str) -> crate::os_paths::TestDir {
        crate::os_paths::test_dir(&format!("gguf-{tag}"))
    }

    #[test]
    fn reads_the_general_strings_and_stops_at_the_tokenizer() {
        let dir = fixtures("general");
        let mut w = W::new(6);
        w.str_field("general.architecture", "qwen2");
        w.str_field("general.name", "Qwen2.5 0.5B Instruct");
        w.str_field("general.license.link", "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct/blob/main/LICENSE");
        w.u32_field("qwen2.context_length", 32768);
        w.u32_field("general.file_type", 7);
        w.arr_str_field("tokenizer.ggml.tokens", &["a", "b"]);
        let p = dir.join("general.gguf");
        w.write_to(&p);
        let facts = read_general(p.to_str().unwrap());
        assert_eq!(facts.get("general.name"), Some("Qwen2.5 0.5B Instruct"));
        assert_eq!(facts.get("general.architecture"), Some("qwen2"));
        assert_eq!(facts.file_type, Some(7));
        assert!(facts.get("general.description").is_none());
    }

    #[test]
    fn general_facts_of_a_file_that_is_not_a_gguf_are_empty() {
        let dir = fixtures("general-not");
        let p = dir.join("not.gguf");
        std::fs::write(&p, b"not a model").unwrap();
        assert_eq!(read_general(p.to_str().unwrap()), Default::default());
    }

    #[test]
    fn reads_context_length_behind_skipped_values() {
        let dir = fixtures("skipped");
        let mut w = W::new(4);
        w.str_field("general.name", "unit test model");
        w.arr_str_field("tokenizer.ggml.tokens", &["a", "b", "c"]);
        w.str_field("general.architecture", "qwen2");
        w.u32_field("qwen2.context_length", 32768);
        let p = dir.join("ok.gguf");
        w.write_to(&p);
        assert_eq!(context_length(p.to_str().unwrap()), Some(32768));
    }

    #[test]
    fn reads_the_layer_count_next_to_the_context_length() {
        // What the engine start divides the file size by. Both numbers come
        // out of one pass, and the tokenizer array between them is skipped.
        let dir = fixtures("blocks");
        let mut w = W::new(5);
        w.str_field("general.architecture", "llama");
        w.u32_field("llama.context_length", 8192);
        w.arr_str_field("tokenizer.ggml.tokens", &["a", "b", "c"]);
        w.u32_field("llama.block_count", 40);
        w.str_field("general.name", "unit test model");
        let p = dir.join("blocks.gguf");
        w.write_to(&p);
        assert_eq!(
            read_header(p.to_str().unwrap()),
            HeaderFacts { context_length: Some(8192), block_count: Some(40) }
        );
    }

    #[test]
    fn a_header_without_a_layer_count_says_so_instead_of_guessing() {
        // The engine start has a fallback for this, and the fallback only
        // works if the reader admits it found nothing. A number invented here
        // would be spent as if it had been measured.
        let dir = fixtures("no-blocks");
        let mut w = W::new(2);
        w.str_field("general.architecture", "llama");
        w.u32_field("llama.context_length", 4096);
        let p = dir.join("no-blocks.gguf");
        w.write_to(&p);
        let facts = read_header(p.to_str().unwrap());
        assert_eq!(facts.context_length, Some(4096));
        assert_eq!(facts.block_count, None);

        // A block count belonging to ANOTHER architecture is not this model's.
        let mut other = W::new(3);
        other.str_field("general.architecture", "llama");
        other.u32_field("llama.context_length", 4096);
        other.u32_field("qwen2.block_count", 28);
        let q = dir.join("foreign-blocks.gguf");
        other.write_to(&q);
        assert_eq!(read_header(q.to_str().unwrap()).block_count, None);
    }

    #[test]
    fn a_file_that_is_not_a_gguf_answers_with_empty_facts() {
        let dir = fixtures("blocks-garbage");
        let p = dir.join("garbage.gguf");
        std::fs::write(&p, b"MZ\x90definitely not a gguf").unwrap();
        assert_eq!(read_header(p.to_str().unwrap()), HeaderFacts::default());
        assert_eq!(read_header("/nonexistent/nope.gguf"), HeaderFacts::default());
    }

    #[test]
    fn context_key_before_architecture_still_resolves() {
        let dir = fixtures("reversed");
        let mut w = W::new(2);
        w.u32_field("llama.context_length", 8192);
        w.str_field("general.architecture", "llama");
        let p = dir.join("reversed.gguf");
        w.write_to(&p);
        assert_eq!(context_length(p.to_str().unwrap()), Some(8192));
    }

    #[test]
    fn garbage_missing_and_truncated_files_are_none() {
        let dir = fixtures("garbage");
        let p = dir.join("garbage.gguf");
        std::fs::write(&p, b"MZ\x90definitely not a gguf").unwrap();
        assert_eq!(context_length(p.to_str().unwrap()), None);
        assert_eq!(context_length("/nonexistent/nope.gguf"), None);

        // Valid magic, then the file just ends mid-header.
        let t = dir.join("truncated.gguf");
        std::fs::write(&t, b"GGUF\x03\x00\x00\x00").unwrap();
        assert_eq!(context_length(t.to_str().unwrap()), None);
    }

    // ── The one check in this file against a GGUF this module did not write ──
    //
    // Everything above parses bytes produced by `W`, the writer twenty lines
    // up. That cannot catch the failure both halves share a wrong assumption
    // about; only a file llama.cpp produced can. So this probe is worth
    // keeping — but the way it was written, it was worth nothing:
    //
    //     let home = std::env::var("HOME").unwrap_or_default();
    //     let p = format!("{home}/Library/Application Support/Locally \
    //                      Uncensored/models/Qwen2.5-0.5B-Instruct-Q8_0.gguf");
    //     if Path::new(&p).exists() { assert_eq!(...) }
    //
    // Two things were wrong with that.
    //
    // 1. It built the path by hand, so it was macOS-only and it named the
    //    directory of the PRODUCTION app directly instead of going through
    //    `os_paths`, which is the single place that knows the app directory
    //    and, on this branch, its isolation suffix. Reading is not a violation
    //    — but a hand-built copy of a path is how a WRITE ends up in the
    //    user's real data later.
    // 2. It turned itself off in silence. On every machine without that exact
    //    file — CI, Windows, Linux, a fresh checkout — it passed while
    //    asserting nothing, and said so nowhere. A test that quietly checks
    //    nothing is worse than a red one: the red one gets fixed.
    //
    // What replaces it: the path build is pinned by a test that always runs
    // and always asserts, and the file-dependent half announces its skip on a
    // stream the test harness does not capture.

    /// The model the built-in engine ships with. Its trained context length is
    /// a property of the file, not of this repo.
    const REAL_MODEL_FILE: &str = "Qwen2.5-0.5B-Instruct-Q8_0.gguf";
    const REAL_MODEL_CONTEXT: u32 = 32768;

    /// Wo ein echtes GGUF liegt: das Modellverzeichnis der eingebauten Engine,
    /// direkt aus `os_paths`. Bewusst kein hier zusammengebauter Pfad — ein
    /// von Hand gebauter Pfad ist genau der Weg, auf dem ein Testlauf spaeter
    /// in die echten Daten des Nutzers schreibt.
    fn real_gguf_path() -> std::path::PathBuf {
        crate::os_paths::builtin_models_dir().join(REAL_MODEL_FILE)
    }

    /// Laeuft immer, prueft immer: die Sonde schaut dorthin, wo `os_paths` es
    /// sagt, und nicht auf einen hier zusammengesetzten Namen.
    #[test]
    fn the_real_gguf_probe_goes_through_the_central_path_builder() {
        use crate::app_identity::APP_DISPLAY_DIR;

        let pfad = real_gguf_path();
        assert_eq!(
            pfad,
            crate::os_paths::builtin_models_dir().join(REAL_MODEL_FILE)
        );
        assert!(pfad.ends_with(REAL_MODEL_FILE));

        // Und der Pfad steht wirklich unter dem Verzeichnis dieser App, nicht
        // unter irgendeinem: <data_dir>/<APP_DISPLAY_DIR>/models/<datei>.
        let app_dir = pfad
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.file_name())
            .expect("kein App-Verzeichnis im gebauten Pfad");
        assert_eq!(app_dir, APP_DISPLAY_DIR);
    }

    /// Parses a real GGUF when one is on this machine — and says out loud when
    /// there is none, instead of passing in silence.
    ///
    /// The skip notice is written straight to `stderr` rather than through
    /// `eprintln!`: libtest's capture swaps the sink the print macros use, so
    /// a macro line from a PASSING test is swallowed, while a direct write to
    /// the handle reaches the terminal. Verified on this machine, 2026-09-01.
    #[test]
    fn a_real_gguf_parses_or_the_run_says_why_it_could_not() {
        let pfad = real_gguf_path();
        match pfad.exists() {
            true => {
                let path = &pfad;
                assert_eq!(
                    context_length(path.to_str().expect("non-UTF-8 model path")),
                    Some(REAL_MODEL_CONTEXT),
                    "parsing the real model at {} gave the wrong context length",
                    path.display()
                );
            }
            false => {
                use std::io::Write;
                let _ = writeln!(
                    std::io::stderr(),
                    "\n  SKIPPED gguf::a_real_gguf_parses_or_the_run_says_why_it_could_not\n  \
                     reason: no real {REAL_MODEL_FILE} on this machine, so the parser was \
                     not checked against a file llama.cpp produced.\n  looked at:\n    {}\n  \
                     to run it for real, download the LU Engine's model once.\n",
                    pfad.display()
                );
            }
        }
    }

    /// A head with keys and one tensor, written by hand.
    fn head_with_tensor(split: Option<(u16, u16)>, tensor: &str) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"GGUF");
        v.extend_from_slice(&3u32.to_le_bytes());
        v.extend_from_slice(&1u64.to_le_bytes()); // one tensor
        let kv: u64 = if split.is_some() { 2 } else { 1 };
        v.extend_from_slice(&kv.to_le_bytes());
        let key = |v: &mut Vec<u8>, k: &str| {
            v.extend_from_slice(&(k.len() as u64).to_le_bytes());
            v.extend_from_slice(k.as_bytes());
        };
        key(&mut v, "general.architecture");
        v.extend_from_slice(&8u32.to_le_bytes());
        v.extend_from_slice(&5u64.to_le_bytes());
        v.extend_from_slice(b"llama");
        if let Some((_, count)) = split {
            key(&mut v, "split.count");
            v.extend_from_slice(&2u32.to_le_bytes()); // u16
            v.extend_from_slice(&count.to_le_bytes());
        }
        key(&mut v, tensor);
        v.extend_from_slice(&2u32.to_le_bytes()); // two dims
        v.extend_from_slice(&4096u64.to_le_bytes());
        v.extend_from_slice(&4096u64.to_le_bytes());
        v.extend_from_slice(&12u32.to_le_bytes()); // Q4_K
        v.extend_from_slice(&0u64.to_le_bytes());
        v
    }

    #[test]
    fn the_whole_head_reads_keys_and_the_tensor_table_and_sizes_the_tensors() {
        let raw = head_with_tensor(None, "blk.0.ffn_up.weight");
        let h = super::parse_head(&mut &raw[..]).expect("parses");
        assert_eq!(h.arch(), Some("llama"));
        assert_eq!(h.tensors.len(), 1);
        // 4096 x 4096 in Q4_K: 16 blocks of 256 per row at 144 bytes.
        assert_eq!(h.tensors[0].bytes(), Some(4096 * 16 * 144));
        // An unknown ggml type has no size, it is not guessed.
        let mut t = h.tensors[0].clone();
        t.ggml_type = 99;
        assert_eq!(t.bytes(), None);
        // A truncated head is not a head.
        assert!(super::parse_head(&mut &raw[..raw.len() - 3]).is_none());
    }

    #[test]
    fn a_split_model_is_read_with_the_tensors_of_every_part() {
        let dir = fixtures("split");
        let p1 = dir.join("big-00001-of-00002.gguf");
        let p2 = dir.join("big-00002-of-00002.gguf");
        std::fs::write(&p1, head_with_tensor(Some((1, 2)), "blk.0.ffn_up.weight")).unwrap();
        std::fs::write(&p2, head_with_tensor(Some((2, 2)), "blk.1.ffn_up.weight")).unwrap();
        let h = super::read_model_head(p1.to_str().unwrap()).expect("head");
        assert_eq!(h.split_count(), 2);
        let names: Vec<&str> = h.tensors.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["blk.0.ffn_up.weight", "blk.1.ffn_up.weight"]);
        let both = std::fs::metadata(&p1).unwrap().len() + std::fs::metadata(&p2).unwrap().len();
        assert_eq!(super::model_file_bytes(p1.to_str().unwrap()), both);
        // A part missing: what is there is read, nothing is made up.
        std::fs::remove_file(&p2).unwrap();
        assert_eq!(super::read_model_head(p1.to_str().unwrap()).unwrap().tensors.len(), 1);
    }

}
