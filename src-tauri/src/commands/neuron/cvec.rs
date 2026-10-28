//! Control vectors as llama.cpp reads them (`--control-vector`), read and
//! written here so LU can mix several sliders into one file.
//!
//! The file is a plain GGUF: `general.architecture = "controlvector"`, a
//! model hint, a layer count and one F32 tensor `direction.N` of `n_embd`
//! values per layer. llama.cpp adds `direction.N` to the output of block N
//! (common.cpp `llama_control_vector_load`, llama-adapter.cpp: layer 1 lands
//! at index 0, there is never a direction for layer 0). Several files on the
//! command line are summed with their scales; LU does the sum itself, so the
//! engine always gets exactly one file and each slider keeps the layers it
//! was meant for.
//!
//! A file llama.cpp cannot read is skipped with a warning and the model runs
//! unsteered, which nobody would notice. So the writer only writes what the
//! loader accepts, and `read` rejects the same things the loader rejects.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::Path;

const MAGIC: &[u8; 4] = b"GGUF";
const ALIGN: u64 = 32;
const GGML_F32: u32 = 0;

/// One control vector: a direction per layer, all of the same width.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ControlVector {
    pub n_embd: usize,
    /// Layer number (1-based, as in `direction.N`) → values.
    pub layers: BTreeMap<usize, Vec<f32>>,
}

impl ControlVector {
    pub fn new(n_embd: usize) -> Self {
        Self { n_embd, layers: BTreeMap::new() }
    }

    /// Adds `scale × other` layer by layer.
    pub fn add_scaled(&mut self, other: &ControlVector, scale: f32) -> Result<(), String> {
        if other.n_embd != self.n_embd {
            return Err(format!("A direction of width {} cannot be mixed into one of width {}.", other.n_embd, self.n_embd));
        }
        for (layer, values) in &other.layers {
            let dst = self.layers.entry(*layer).or_insert_with(|| vec![0.0; self.n_embd]);
            for (d, s) in dst.iter_mut().zip(values) {
                *d += s * scale;
            }
        }
        Ok(())
    }

    /// Keeps only the layers in `start..=end`.
    pub fn restrict(&mut self, start: usize, end: usize) {
        self.layers.retain(|l, _| *l >= start && *l <= end);
    }

    /// True when no layer carries a value other than zero.
    pub fn is_zero(&self) -> bool {
        self.layers.values().all(|v| v.iter().all(|x| *x == 0.0))
    }
}

/// The layers a slider steers: the middle of the model, about the eighth to
/// the five-sixth part of its depth. The first layers still read tokens and
/// the last ones already write them; a push there breaks words before it
/// changes what is said (measured on Qwen2.5-0.5B: 3..=20 of 24 holds up to
/// a scale of 0.8, see P11-BERICHT.md).
pub fn band_for(n_layer: usize) -> (usize, usize) {
    if n_layer < 4 {
        return (1, n_layer.saturating_sub(1).max(1));
    }
    let start = ((n_layer as f32 * 0.125).round() as usize).max(1);
    let end = ((n_layer as f32 * 0.85).round() as usize).min(n_layer - 1).max(start);
    (start, end)
}

// ── reading ────────────────────────────────────────────────────────────────

struct R<'a>(&'a mut dyn Read, u64);

impl R<'_> {
    fn bytes<const N: usize>(&mut self) -> Result<[u8; N], String> {
        let mut b = [0u8; N];
        self.0.read_exact(&mut b).map_err(|_| "The file ends too early.".to_string())?;
        self.1 += N as u64;
        Ok(b)
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.bytes::<4>()?))
    }
    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.bytes::<8>()?))
    }
    fn skip(&mut self, n: u64) -> Result<(), String> {
        let got = std::io::copy(&mut self.0.take(n), &mut std::io::sink()).map_err(|e| crate::os_error::english(&e))?;
        if got != n {
            return Err("The file ends too early.".into());
        }
        self.1 += n;
        Ok(())
    }
    fn string(&mut self, max: u64) -> Result<String, String> {
        let len = self.u64()?;
        if len > max {
            return Err("A name in the file is too long.".into());
        }
        let mut b = vec![0u8; len as usize];
        self.0.read_exact(&mut b).map_err(|_| "The file ends too early.".to_string())?;
        self.1 += len;
        String::from_utf8(b).map_err(|_| "A name in the file is not text.".into())
    }
}

/// Size of a fixed-width GGUF value type, `None` for string and array.
pub(crate) fn fixed_size(ty: u32) -> Option<u64> {
    match ty {
        0 | 1 | 7 => Some(1),
        2 | 3 => Some(2),
        4..=6 => Some(4),
        10..=12 => Some(8),
        _ => None,
    }
}

/// Skips one value of type `ty`; strings and arrays included.
fn skip_value(r: &mut R, ty: u32) -> Result<(), String> {
    if let Some(n) = fixed_size(ty) {
        return r.skip(n);
    }
    match ty {
        8 => {
            let len = r.u64()?;
            r.skip(len)
        }
        9 => {
            let elem = r.u32()?;
            let count = r.u64()?;
            if let Some(n) = fixed_size(elem) {
                r.skip(count.checked_mul(n).ok_or("Array too large.")?)
            } else {
                for _ in 0..count {
                    skip_value(r, elem)?;
                }
                Ok(())
            }
        }
        _ => Err(format!("Unknown value type {ty}.")),
    }
}

/// Reads a control vector file. Rejects what llama.cpp would skip: a tensor
/// that is not `direction.N` with N ≥ 1, not F32, not one-dimensional, or of
/// another width than the first.
pub fn read(path: &Path) -> Result<ControlVector, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Cannot open {}: {}", path.display(), crate::os_error::english(&e)))?;
    let mut buf = std::io::BufReader::new(file);
    read_from(&mut buf)
}

pub fn read_from(reader: &mut dyn Read) -> Result<ControlVector, String> {
    let mut r = R(reader, 0);
    if &r.bytes::<4>()? != MAGIC {
        return Err("Not a GGUF file.".into());
    }
    let version = r.u32()?;
    if !(2..=3).contains(&version) {
        return Err(format!("GGUF version {version} is not supported."));
    }
    let n_tensors = r.u64()?;
    let n_kv = r.u64()?;
    if n_tensors > 4096 || n_kv > 4096 {
        return Err("This is not a control vector (too many entries).".into());
    }
    let mut align = ALIGN;
    for _ in 0..n_kv {
        let key = r.string(1 << 16)?;
        let ty = r.u32()?;
        if key == "general.alignment" && ty == 4 {
            align = r.u32()? as u64;
            if align == 0 || !align.is_multiple_of(8) {
                return Err("Bad alignment.".into());
            }
        } else {
            skip_value(&mut r, ty)?;
        }
    }
    let mut infos: Vec<(usize, u64, u64)> = Vec::new(); // (layer, n, offset)
    let mut n_embd: Option<u64> = None;
    for _ in 0..n_tensors {
        let name = r.string(512)?;
        let n_dims = r.u32()?;
        let mut dims = Vec::new();
        for _ in 0..n_dims {
            dims.push(r.u64()?);
        }
        let ty = r.u32()?;
        let offset = r.u64()?;
        let layer: usize = name
            .strip_prefix("direction.")
            .and_then(|n| n.parse().ok())
            .filter(|n| *n >= 1)
            .ok_or_else(|| format!("Tensor {name} is not a direction."))?;
        if ty != GGML_F32 {
            return Err(format!("Tensor {name} is not F32."));
        }
        if dims.len() != 1 {
            return Err(format!("Tensor {name} is not one-dimensional."));
        }
        match n_embd {
            None => n_embd = Some(dims[0]),
            Some(n) if n != dims[0] => return Err(format!("Tensor {name} has another width.")),
            _ => {}
        }
        infos.push((layer, dims[0], offset));
    }
    let n_embd = n_embd.unwrap_or(0) as usize;
    let pad = (align - r.1 % align) % align;
    r.skip(pad)?;
    let data_start = r.1;
    infos.sort_by_key(|i| i.2);
    let mut cv = ControlVector::new(n_embd);
    for (layer, n, offset) in infos {
        let at = data_start + offset;
        if at < r.1 {
            return Err("Tensors overlap.".into());
        }
        r.skip(at - r.1)?;
        let mut values = Vec::with_capacity(n as usize);
        for _ in 0..n {
            values.push(f32::from_le_bytes(r.bytes::<4>()?));
        }
        let dst = cv.layers.entry(layer).or_insert_with(|| vec![0.0; n_embd]);
        for (d, s) in dst.iter_mut().zip(values) {
            *d += s;
        }
    }
    Ok(cv)
}

// ── writing ────────────────────────────────────────────────────────────────

fn put_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u64).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

/// The bytes of a control vector file with a direction for every layer
/// `1..n_layer` (zeros where `cv` has none), the layout `export_gguf` in
/// cvector-generator writes.
pub fn to_bytes(cv: &ControlVector, model_hint: &str, n_layer: usize) -> Vec<u8> {
    let layers: Vec<usize> = (1..n_layer.max(2)).collect();
    let mut out = Vec::new();
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&3u32.to_le_bytes());
    out.extend_from_slice(&(layers.len() as u64).to_le_bytes());
    out.extend_from_slice(&3u64.to_le_bytes());
    put_str(&mut out, "general.architecture");
    out.extend_from_slice(&8u32.to_le_bytes());
    put_str(&mut out, "controlvector");
    put_str(&mut out, "controlvector.model_hint");
    out.extend_from_slice(&8u32.to_le_bytes());
    put_str(&mut out, model_hint);
    put_str(&mut out, "controlvector.layer_count");
    out.extend_from_slice(&5u32.to_le_bytes());
    out.extend_from_slice(&(layers.len() as i32).to_le_bytes());
    let tensor_bytes = (cv.n_embd as u64) * 4;
    let stride = tensor_bytes.div_ceil(ALIGN) * ALIGN;
    for (i, layer) in layers.iter().enumerate() {
        put_str(&mut out, &format!("direction.{layer}"));
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&(cv.n_embd as u64).to_le_bytes());
        out.extend_from_slice(&GGML_F32.to_le_bytes());
        out.extend_from_slice(&(i as u64 * stride).to_le_bytes());
    }
    let pad = (ALIGN - out.len() as u64 % ALIGN) % ALIGN;
    out.extend(std::iter::repeat_n(0u8, pad as usize));
    let zeros = vec![0.0f32; cv.n_embd];
    for layer in &layers {
        let values = cv.layers.get(layer).unwrap_or(&zeros);
        for v in values {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend(std::iter::repeat_n(0u8, (stride - tensor_bytes) as usize));
    }
    out
}

/// Writes atomically (temp file, then rename), so the engine never starts on
/// half a file.
pub fn write(path: &Path, cv: &ControlVector, model_hint: &str, n_layer: usize) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {}", dir.display(), crate::os_error::english(&e)))?;
    }
    let tmp = path.with_extension("part");
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("Cannot write {}: {}", tmp.display(), crate::os_error::english(&e)))?;
        f.write_all(&to_bytes(cv, model_hint, n_layer)).map_err(|e| crate::os_error::english(&e))?;
        f.sync_all().ok();
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("Cannot save {}: {}", path.display(), crate::os_error::english(&e)))
}

/// A short, stable name for a mix: the same sliders give the same file name,
/// any change gives a new one, so the engine's argv changes with the content.
pub fn content_tag(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ControlVector {
        let mut cv = ControlVector::new(5);
        cv.layers.insert(2, vec![1.0, -2.0, 0.5, 0.0, 3.25]);
        cv.layers.insert(4, vec![0.1, 0.2, 0.3, 0.4, 0.5]);
        cv
    }

    #[test]
    fn written_file_reads_back_with_zero_layers_filled_in() {
        let bytes = to_bytes(&sample(), "qwen2", 6);
        let back = read_from(&mut bytes.as_slice()).unwrap();
        assert_eq!(back.n_embd, 5);
        assert_eq!(back.layers.keys().copied().collect::<Vec<_>>(), vec![1, 2, 3, 4, 5]);
        assert_eq!(back.layers[&2], sample().layers[&2]);
        assert_eq!(back.layers[&4], sample().layers[&4]);
        assert!(back.layers[&1].iter().all(|v| *v == 0.0));
    }

    #[test]
    fn tensors_are_aligned_like_ggml_writes_them() {
        // n_embd 5 → 20 bytes per tensor, padded to 32.
        let bytes = to_bytes(&sample(), "x", 3);
        let back = read_from(&mut bytes.as_slice()).unwrap();
        assert_eq!(back.layers.len(), 2);
        assert_eq!(bytes.len() % 32, 0);
    }

    #[test]
    fn reads_a_file_cvector_generator_wrote() {
        // A real file from the pinned llama-cvector-generator (b9949) is too
        // big to keep; the generator's layout is what to_bytes writes, and a
        // tensor of another type must be refused, not summed.
        let mut bytes = to_bytes(&sample(), "x", 3);
        // Flip the type of the first tensor to F16 (1).
        let name = b"direction.1";
        let at = bytes.windows(name.len()).position(|w| w == name).unwrap() + name.len() + 4 + 8;
        bytes[at] = 1;
        assert!(read_from(&mut bytes.as_slice()).unwrap_err().contains("not F32"));
    }

    #[test]
    fn mixing_sums_with_scales() {
        let mut mix = ControlVector::new(5);
        mix.add_scaled(&sample(), 0.5).unwrap();
        mix.add_scaled(&sample(), -1.5).unwrap();
        assert_eq!(mix.layers[&2][0], -1.0);
        assert_eq!(mix.layers[&4][4], -0.5);
        assert!(mix.add_scaled(&ControlVector::new(6), 1.0).is_err());
    }

    #[test]
    fn zero_strength_mix_is_zero() {
        let mut mix = ControlVector::new(5);
        mix.add_scaled(&sample(), 0.0).unwrap();
        assert!(mix.is_zero());
    }

    #[test]
    fn restrict_keeps_the_band() {
        let mut cv = sample();
        cv.restrict(3, 9);
        assert_eq!(cv.layers.keys().copied().collect::<Vec<_>>(), vec![4]);
    }

    #[test]
    fn band_is_the_middle_of_the_model() {
        assert_eq!(band_for(24), (3, 20));
        assert_eq!(band_for(18), (2, 15));
        let (s, e) = band_for(80);
        assert!(s >= 1 && e < 80 && s < e);
        assert_eq!(band_for(2), (1, 1));
    }

    #[test]
    fn content_tag_follows_content() {
        assert_eq!(content_tag(b"a"), content_tag(b"a"));
        assert_ne!(content_tag(b"a"), content_tag(b"b"));
        assert_eq!(content_tag(b"a").len(), 16);
    }
}
