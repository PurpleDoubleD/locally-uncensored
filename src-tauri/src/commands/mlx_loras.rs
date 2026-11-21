//! The LoRA folder of the Mac's image engine.
//!
//! On Windows and Linux a LoRA is a file in ComfyUI's `models/loras`, and
//! ComfyUI lists it. The Mac has no ComfyUI: its second image engine (mflux,
//! `image_mflux.rs`) is handed LoRA files on its command line. So the Mac has
//! a folder of its own in the app's data folder. The user puts `.safetensors`
//! files there, the Model Manager and the LoRA stack in Create list them, and
//! a run names them by the path below that folder. The video engines of the
//! Mac read the same folder for the models that take `--lora`
//! (`commands::video`, `lora_stack`).
//!
//! The engine opens whatever path it is handed, so a name from the interface
//! is only ever resolved here (`resolve`): a `.safetensors` file inside the
//! folder, with no way out of it.

use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use crate::commands::CmdResult;
use crate::os_error;
use crate::state::AppState;

/// Where the LoRA files live: `loras` in the app's data folder.
pub(crate) fn loras_root() -> PathBuf {
    crate::os_paths::data_dir().join("loras")
}

/// How deep the listing looks. A folder per model family or per author is
/// common, a tree is not.
const MAX_DEPTH: usize = 3;

/// The most a safetensors header is read: the largest LoRA headers are a few
/// megabytes, and a file that claims more is not read at all.
const MAX_HEADER_BYTES: u64 = 64 * 1024 * 1024;

/// How a LoRA file names its matrices. The engine matches key names exactly,
/// and which names a model family reads differs (`image_mflux.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Keys {
    /// `lora_A` / `lora_B` (PEFT, diffusers, the ComfyUI export of them).
    Peft,
    /// `lora_down` / `lora_up` (Kohya and what follows its naming).
    Kohya,
    /// A safetensors file with neither (LoKr, full weights, something else).
    Other,
    /// Not a safetensors file, or its header cannot be read.
    Unreadable,
}

impl Keys {
    pub(crate) const fn id(self) -> &'static str {
        match self {
            Keys::Peft => "peft",
            Keys::Kohya => "kohya",
            Keys::Other => "other",
            Keys::Unreadable => "unreadable",
        }
    }
}

/// What the header of a LoRA file says about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Header {
    pub keys: Keys,
    /// DoRA magnitudes next to the matrices. The engine ends with an error on
    /// those.
    pub dora: bool,
}

/// Sort the tensor names of a file. A file with both namings counts as PEFT:
/// that is the one every family of the engine reads.
pub(crate) fn classify<'a>(names: impl IntoIterator<Item = &'a str>) -> Header {
    let (mut peft, mut kohya, mut dora) = (false, false, false);
    for name in names {
        for part in name.split('.') {
            match part {
                "lora_A" | "lora_B" => peft = true,
                "lora_down" | "lora_up" => kohya = true,
                "dora_scale" | "lora_magnitude_vector" => dora = true,
                _ => {}
            }
        }
    }
    let keys = if peft {
        Keys::Peft
    } else if kohya {
        Keys::Kohya
    } else {
        Keys::Other
    };
    Header { keys, dora }
}

/// The header of a safetensors file as it is on disk: eight bytes of length,
/// then that much JSON. Comes back with the file, which then stands at the
/// first byte of the tensor data.
pub(crate) fn header_json(path: &Path) -> Option<(std::fs::File, Vec<u8>)> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut len = [0u8; 8];
    file.read_exact(&mut len).ok()?;
    let n = u64::from_le_bytes(len);
    if n == 0 || n > MAX_HEADER_BYTES || n.saturating_add(8) > total {
        return None;
    }
    let mut buf = vec![0u8; n as usize];
    file.read_exact(&mut buf).ok()?;
    Some((file, buf))
}

/// Read the tensor names out of a safetensors header. Its keys are the names.
pub(crate) fn read_header(path: &Path) -> Header {
    const UNREADABLE: Header = Header { keys: Keys::Unreadable, dora: false };
    match tensor_names(path) {
        Some(names) => classify(names.iter().map(String::as_str)),
        None => UNREADABLE,
    }
}

/// The tensor names of a safetensors file, or None when its header cannot be
/// read. The video engines match some of them by their prefix
/// (`commands::video`), which the sorting of `classify` does not keep.
pub(crate) fn tensor_names(path: &Path) -> Option<Vec<String>> {
    let (_, buf) = header_json(path)?;
    // The values are not needed, and not built.
    let header = serde_json::from_slice::<std::collections::HashMap<String, serde::de::IgnoredAny>>(&buf).ok()?;
    Some(header.into_keys().filter(|k| k != "__metadata__").collect())
}

/// What a LoRA file says about the weight of its layers.
///
/// A layer may carry a scalar `<layer>.alpha` next to its two matrices, and
/// is then meant to count `alpha / rank` times what the matrices say. ComfyUI
/// reads it. The engine of the Mac reads it for most families and not for
/// Qwen-Image 2.1, whose key table names no alpha (`image_mflux.rs`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Alpha {
    /// No alpha in the file, or nothing about it that can be read.
    None,
    /// Every layer has the same `alpha / rank`: this number.
    Uniform(f64),
    /// The layers differ. No single strength stands for them.
    Mixed,
}

impl Alpha {
    pub(crate) const fn id(self) -> &'static str {
        match self {
            Alpha::None => "none",
            Alpha::Uniform(_) => "uniform",
            Alpha::Mixed => "mixed",
        }
    }
}

/// One entry of a safetensors header. `__metadata__` is the other kind.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum Entry {
    Tensor { dtype: String, shape: Vec<u64>, data_offsets: (u64, u64) },
    Other(serde::de::IgnoredAny),
}

/// What the header says about one layer: the rank by either matrix, and
/// where its alpha is.
#[derive(Default)]
struct Layer {
    down_rank: Option<u64>,
    up_rank: Option<u64>,
    alpha: Option<(String, u64, u64)>,
}

/// A scalar of the tensor data as a number. `file` stands anywhere, `data`
/// is where the tensor data begins.
fn read_scalar(file: &mut std::fs::File, data: u64, dtype: &str, start: u64, end: u64) -> Option<f64> {
    use std::io::{Read, Seek, SeekFrom};
    let width: u64 = match dtype {
        "F16" | "BF16" => 2,
        "F32" => 4,
        "F64" => 8,
        _ => return None,
    };
    if end.checked_sub(start)? != width {
        return None;
    }
    let mut raw = [0u8; 8];
    let bytes = &mut raw[..width as usize];
    file.seek(SeekFrom::Start(data.checked_add(start)?)).ok()?;
    file.read_exact(bytes).ok()?;
    let value = match dtype {
        "F16" => half_to_f64(u16::from_le_bytes([bytes[0], bytes[1]])),
        // The upper half of a 32 bit float.
        "BF16" => f32::from_bits((u16::from_le_bytes([bytes[0], bytes[1]]) as u32) << 16) as f64,
        "F32" => f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f64,
        _ => f64::from_le_bytes(raw),
    };
    value.is_finite().then_some(value)
}

/// A 16 bit float (IEEE 754 half) as a number.
fn half_to_f64(bits: u16) -> f64 {
    let sign = if bits >> 15 == 1 { -1.0 } else { 1.0 };
    let exponent = ((bits >> 10) & 0x1f) as i32;
    let fraction = (bits & 0x3ff) as f64 / 1024.0;
    match exponent {
        0 => sign * fraction * 2f64.powi(-14),
        0x1f if fraction == 0.0 => sign * f64::INFINITY,
        0x1f => f64::NAN,
        _ => sign * (1.0 + fraction) * 2f64.powi(exponent - 15),
    }
}

/// Read `alpha / rank` of every layer without loading a weight: the header
/// names the shape of each matrix and where each alpha lies, and an alpha is
/// a single number. A layer without an alpha counts in full, as it does
/// everywhere. Whatever cannot be read (a broken header, an alpha of an
/// unknown type, a file cut short) answers `None`, and the file is then
/// handled as it always was.
pub(crate) fn read_alpha(path: &Path) -> Alpha {
    let Some((mut file, buf)) = header_json(path) else { return Alpha::None };
    let data = 8 + buf.len() as u64;
    let Ok(header) = serde_json::from_slice::<std::collections::HashMap<String, Entry>>(&buf) else { return Alpha::None };
    let mut layers: std::collections::HashMap<&str, Layer> = std::collections::HashMap::new();
    for (name, entry) in &header {
        let Entry::Tensor { dtype, shape, data_offsets } = entry else { continue };
        let before = |part: &str| name.find(part).map(|at| &name[..at]);
        if let Some(layer) = name.strip_suffix(".alpha") {
            if shape.iter().product::<u64>() != 1 {
                return Alpha::None;
            }
            layers.entry(layer).or_default().alpha = Some((dtype.clone(), data_offsets.0, data_offsets.1));
        } else if let Some(layer) = before(".lora_A.").or_else(|| before(".lora_down.")) {
            layers.entry(layer).or_default().down_rank = shape.first().copied();
        } else if let Some(layer) = before(".lora_B.").or_else(|| before(".lora_up.")) {
            layers.entry(layer).or_default().up_rank = shape.get(1).copied();
        }
    }
    if layers.values().all(|l| l.alpha.is_none()) {
        return Alpha::None;
    }
    let mut ratio: Option<f64> = None;
    for layer in layers.values() {
        // An alpha without matrices scales nothing.
        let Some(rank) = layer.down_rank.or(layer.up_rank) else { continue };
        if rank == 0 {
            return Alpha::None;
        }
        let this = match &layer.alpha {
            Some((dtype, start, end)) => match read_scalar(&mut file, data, dtype, *start, *end) {
                Some(alpha) => alpha / rank as f64,
                None => return Alpha::None,
            },
            None => 1.0,
        };
        match ratio {
            None => ratio = Some(this),
            Some(first) if (first - this).abs() > 1e-6 * first.abs().max(this.abs()) => return Alpha::Mixed,
            Some(_) => {}
        }
    }
    ratio.map_or(Alpha::None, Alpha::Uniform)
}

/// The strength the engine is handed where it does not read the alpha of a
/// file itself: what was asked for times `alpha / rank`, which is what the
/// same file and number give in ComfyUI. Not put back on the grid of
/// `strength`: an alpha of 1 at rank 128 is a factor below it. Layers that
/// differ leave the strength as it is, and so does a file without an alpha.
pub(crate) fn scaled(strength: f32, alpha: Alpha) -> f32 {
    match alpha {
        Alpha::Uniform(factor) => (strength as f64 * factor) as f32,
        Alpha::None | Alpha::Mixed => strength,
    }
}

fn is_safetensors(name: &str) -> bool {
    name.len() > ".safetensors".len() && name.to_ascii_lowercase().ends_with(".safetensors")
}

/// One file of the folder as the interface lists it.
#[derive(Debug, PartialEq)]
pub(crate) struct Listed {
    /// The path below the folder, with `/` between its parts. This is the
    /// name a run sends back.
    pub name: String,
    pub bytes: u64,
    pub keys: Keys,
    pub alpha: Alpha,
}

/// Every `.safetensors` file in the folder, by name. A folder that is not
/// there lists nothing. Hidden entries are left out, and so is anything a
/// link leads out of the folder.
pub(crate) fn list(root: &Path) -> Vec<Listed> {
    let Ok(real_root) = root.canonicalize() else { return Vec::new() };
    let mut out = Vec::new();
    walk(&real_root, &real_root, "", 0, &mut out);
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name)));
    out
}

fn walk(real_root: &Path, dir: &Path, prefix: &str, depth: usize, out: &mut Vec<Listed>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Some(file_name) = entry.file_name().to_str().map(str::to_string) else { continue };
        if file_name.starts_with('.') {
            continue;
        }
        let Ok(real) = entry.path().canonicalize() else { continue };
        if !real.starts_with(real_root) {
            continue;
        }
        let name = format!("{prefix}{file_name}");
        if real.is_dir() {
            if depth + 1 < MAX_DEPTH {
                walk(real_root, &real, &format!("{name}/"), depth + 1, out);
            }
        } else if real.is_file() && is_safetensors(&file_name) {
            let bytes = std::fs::metadata(&real).map(|m| m.len()).unwrap_or(0);
            out.push(Listed { name, bytes, keys: read_header(&real).keys, alpha: read_alpha(&real) });
        }
    }
}

/// What a LoRA is called in a sentence: its file name without the ending.
pub(crate) fn stem(name: &str) -> &str {
    let file = name.rsplit('/').next().unwrap_or(name);
    file.rsplit_once('.').map(|(s, _)| s).unwrap_or(file)
}

/// The file behind a name the interface sent, or the sentence for the user.
///
/// A name is the path below the folder as `list` gave it out. It is taken
/// only as that: relative, made of plain parts (no `..`, no `.`, no root, no
/// backslash), ending in `.safetensors`, and after every link is followed
/// still a file inside the folder.
pub(crate) fn resolve(root: &Path, name: &str) -> Result<PathBuf, String> {
    const NOT_OURS: &str = "This LoRA is not a .safetensors file in LU's LoRA folder.";
    if name.is_empty() || name.contains(['\\', '\0']) || !is_safetensors(name) {
        return Err(NOT_OURS.to_string());
    }
    let relative = Path::new(name);
    if relative.is_absolute()
        || name.split('/').any(|part| part.is_empty() || part == "." || part == "..")
        || !relative.components().all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(NOT_OURS.to_string());
    }
    let gone = || format!("The LoRA {} is no longer in the LoRA folder. Turn it off or put the file back.", stem(name));
    let real_root = root.canonicalize().map_err(|_| gone())?;
    let real = root.join(relative).canonicalize().map_err(|_| gone())?;
    if !real.starts_with(&real_root) {
        return Err(NOT_OURS.to_string());
    }
    if !real.is_file() {
        return Err(gone());
    }
    Ok(real)
}

/// The strength a run takes: what Create's number field lets through (-20 to
/// 20 on a grid of 0.01, lib/lora-strength.ts), and 1 for something that is
/// not a number. mflux and the video engines scale the LoRA by it as it is,
/// a negative value included.
pub(crate) fn strength(asked: f32) -> f32 {
    if !asked.is_finite() {
        return 1.0;
    }
    (asked.clamp(-20.0, 20.0) * 100.0).round() / 100.0
}

fn ensure_root() -> Result<PathBuf, String> {
    let root = loras_root();
    std::fs::create_dir_all(&root)
        .map_err(|e| crate::commands::internal(format!("cannot create {}: {}", root.display(), os_error::english(&e))))?;
    Ok(root)
}

fn listing(root: &Path) -> Value {
    let loras: Vec<Value> = list(root)
        .into_iter()
        .map(|l| json!({ "name": l.name, "sizeBytes": l.bytes, "keys": l.keys.id(), "alpha": l.alpha.id() }))
        .collect();
    json!({ "dir": root.to_string_lossy(), "loras": loras })
}

/// `mlx_loras`: the folder and what is in it. The folder is made on the
/// first call, so "Open folder" and a download have somewhere to go.
pub fn mlx_loras(_state: &AppState, _args: &Value) -> CmdResult {
    Ok(listing(&ensure_root()?))
}

/// `mlx_loras_open_folder`: show the folder in Finder.
pub fn mlx_loras_open_folder(_state: &AppState, _args: &Value) -> CmdResult {
    let root = ensure_root()?;
    #[cfg(target_os = "macos")]
    {
        let mut cmd = crate::process_util::hidden_command("open");
        cmd.arg(&root);
        cmd.spawn()
            .map_err(|e| crate::commands::internal(format!("cannot open {}: {}", root.display(), os_error::english(&e))))?;
        Ok(json!({ "ok": true, "dir": root.to_string_lossy() }))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(crate::commands::bad_request(format!(
            "This folder belongs to the image engine of the Mac. On this system LoRAs live in ComfyUI's models/loras folder. ({})",
            root.display()
        )))
    }
}

/// `mlx_lora_delete`: take one file out of the folder. It goes to the Trash,
/// as a render does (`mlx_outputs.rs`): a LoRA is a download of hundreds of
/// megabytes or a file the user trained, and a misclick must stay
/// recoverable.
// Desktop only, like the command and like `mlx_outputs`: the `trash` crate does not compile for a phone.
#[cfg(desktop)]
pub fn mlx_lora_delete(_state: &AppState, args: &Value) -> CmdResult {
    let name = args.get("name").and_then(|v| v.as_str()).ok_or_else(|| crate::commands::bad_request("missing name"))?;
    let root = loras_root();
    delete(&root, name, crate::commands::mlx_outputs::system_trash)?;
    Ok(json!({ "ok": true, "name": name }))
}

/// Resolve `name` and hand the file to `bin`. Where the Trash refuses, the
/// file stays and the user reads why: it is never deleted for good instead.
#[cfg(any(desktop, test))]
fn delete(root: &Path, name: &str, bin: impl FnOnce(&Path) -> Result<(), String>) -> Result<(), String> {
    let file = resolve(root, name).map_err(crate::commands::bad_request)?;
    bin(&file).map_err(|e| crate::commands::internal(format!("Could not move {} to the Trash: {e}", stem(name))))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A safetensors file with the given tensor names and no data.
    pub(crate) fn write_lora(path: &Path, tensors: &[&str]) {
        let mut header = serde_json::Map::new();
        header.insert("__metadata__".into(), json!({ "format": "pt" }));
        for name in tensors {
            header.insert((*name).into(), json!({ "dtype": "F32", "shape": [0, 0], "data_offsets": [0, 0] }));
        }
        let body = serde_json::to_vec(&header).unwrap();
        let mut bytes = (body.len() as u64).to_le_bytes().to_vec();
        bytes.extend(body);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    /// A safetensors file with real tensor data: each tensor with its type,
    /// its shape and its bytes, laid out in the order given.
    pub(crate) fn write_tensors(path: &Path, tensors: &[(&str, &str, &[u64], Vec<u8>)]) {
        let mut header = serde_json::Map::new();
        header.insert("__metadata__".into(), json!({ "format": "pt" }));
        let mut data: Vec<u8> = Vec::new();
        for (name, dtype, shape, bytes) in tensors {
            let start = data.len();
            data.extend(bytes);
            header.insert((*name).into(), json!({ "dtype": dtype, "shape": shape, "data_offsets": [start, data.len()] }));
        }
        let body = serde_json::to_vec(&header).unwrap();
        let mut file = (body.len() as u64).to_le_bytes().to_vec();
        file.extend(body);
        file.extend(data);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, file).unwrap();
    }

    /// The alpha of a layer in a test file: its type and its bytes.
    pub(crate) type TestAlpha = Option<(&'static str, Vec<u8>)>;

    /// The two matrices of one layer at `rank`, four values wide, as zeros.
    fn matrices(layer: &str, rank: u64) -> Vec<(String, &'static str, Vec<u64>, Vec<u8>)> {
        let zeros = vec![0u8; (rank * 4 * 4) as usize];
        vec![
            (format!("{layer}.lora_A.weight"), "F32", vec![rank, 4], zeros.clone()),
            (format!("{layer}.lora_B.weight"), "F32", vec![4, rank], zeros),
        ]
    }

    /// A LoRA of two layers in the naming Qwen-Image 2.1 reads, each layer
    /// with its rank and, where given, an alpha of that type and those bytes.
    pub(crate) fn write_alpha_lora(path: &Path, layers: &[(u64, TestAlpha)]) {
        let mut owned = Vec::new();
        for (i, (rank, alpha)) in layers.iter().enumerate() {
            let layer = format!("transformer.transformer_blocks.{i}.attn.to_q");
            owned.extend(matrices(&layer, *rank));
            if let Some((dtype, bytes)) = alpha {
                owned.push((format!("{layer}.alpha"), *dtype, vec![], bytes.clone()));
            }
        }
        let tensors: Vec<(&str, &str, &[u64], Vec<u8>)> = owned.iter().map(|(n, d, s, b)| (n.as_str(), *d, s.as_slice(), b.clone())).collect();
        write_tensors(path, &tensors);
    }

    pub(crate) fn f32_alpha(value: f32) -> TestAlpha {
        Some(("F32", value.to_le_bytes().to_vec()))
    }

    pub(crate) const PEFT: &[&str] = &[
        "transformer.transformer_blocks.0.attn.to_q.lora_A.weight",
        "transformer.transformer_blocks.0.attn.to_q.lora_B.weight",
    ];
    pub(crate) const KOHYA: &[&str] = &[
        "lora_unet_transformer_blocks_0_attn_to_q.lora_down.weight",
        "lora_unet_transformer_blocks_0_attn_to_q.lora_up.weight",
        "lora_unet_transformer_blocks_0_attn_to_q.alpha",
    ];

    #[test]
    fn the_folder_is_in_the_apps_data_folder() {
        assert_eq!(loras_root(), crate::os_paths::data_dir().join("loras"));
    }

    #[test]
    fn the_key_names_of_a_file_say_which_naming_it_uses() {
        assert_eq!(classify(PEFT.iter().copied()), Header { keys: Keys::Peft, dora: false });
        assert_eq!(classify(["transformer_blocks.3.attn.to_k.lora_B.default.weight"]).keys, Keys::Peft);
        assert_eq!(classify(["diffusion_model.transformer_blocks.3.img_mlp.gate_up.lora_A.weight"]).keys, Keys::Peft);
        assert_eq!(classify(KOHYA.iter().copied()), Header { keys: Keys::Kohya, dora: false });
        assert_eq!(classify(["lycoris_blocks_0.lokr_w1", "lycoris_blocks_0.lokr_w2"]).keys, Keys::Other);
        // A name that only contains the letters is not the matrix.
        assert_eq!(classify(["model.my_lora_A_notes.weight"]).keys, Keys::Other);
        let dora = classify(["transformer.x.lora_A.weight", "transformer.x.lora_B.weight", "transformer.x.lora_magnitude_vector.weight"]);
        assert_eq!(dora, Header { keys: Keys::Peft, dora: true });
        assert!(classify(["x.lora_down.weight", "x.lora_up.weight", "x.dora_scale"]).dora);
    }

    #[test]
    fn a_header_is_read_from_a_real_file_and_garbage_is_said_to_be_garbage() {
        let dir = crate::os_paths::test_dir("loras-header");
        let good = dir.join("good.safetensors");
        write_lora(&good, PEFT);
        assert_eq!(read_header(&good).keys, Keys::Peft);

        let text = dir.join("text.safetensors");
        std::fs::write(&text, b"this is a web page that says login required").unwrap();
        assert_eq!(read_header(&text).keys, Keys::Unreadable);
        let empty = dir.join("empty.safetensors");
        std::fs::write(&empty, b"").unwrap();
        assert_eq!(read_header(&empty).keys, Keys::Unreadable);
        // A length that claims more than the file holds.
        let short = dir.join("short.safetensors");
        std::fs::write(&short, [200u8, 0, 0, 0, 0, 0, 0, 0, b'{', b'}']).unwrap();
        assert_eq!(read_header(&short).keys, Keys::Unreadable);
        assert_eq!(read_header(&dir.join("absent.safetensors")).keys, Keys::Unreadable);
    }

    #[test]
    fn a_file_without_an_alpha_has_none() {
        let dir = crate::os_paths::test_dir("loras-alpha-none");
        let plain = dir.join("plain.safetensors");
        write_alpha_lora(&plain, &[(16, None), (16, None)]);
        assert_eq!(read_alpha(&plain), Alpha::None);
        // The files of the other tests: names alone, no data.
        let names = dir.join("names.safetensors");
        write_lora(&names, PEFT);
        assert_eq!(read_alpha(&names), Alpha::None);
        assert_eq!(scaled(0.8, Alpha::None), 0.8);
    }

    #[test]
    fn one_alpha_over_rank_for_every_layer_is_the_factor_of_the_file() {
        let dir = crate::os_paths::test_dir("loras-alpha-uniform");
        let half = dir.join("half.safetensors");
        write_alpha_lora(&half, &[(16, f32_alpha(8.0)), (16, f32_alpha(8.0))]);
        assert_eq!(read_alpha(&half), Alpha::Uniform(0.5));
        assert_eq!(scaled(0.8, Alpha::Uniform(0.5)), 0.4);
        assert_eq!(scaled(-4.0, Alpha::Uniform(0.5)), -2.0);
        // Different ranks, the same share.
        let shares = dir.join("shares.safetensors");
        write_alpha_lora(&shares, &[(16, f32_alpha(4.0)), (32, f32_alpha(8.0))]);
        assert_eq!(read_alpha(&shares), Alpha::Uniform(0.25));
        // An alpha as large as the rank changes nothing, and one above it lifts.
        let full = dir.join("full.safetensors");
        write_alpha_lora(&full, &[(16, f32_alpha(16.0)), (16, f32_alpha(16.0))]);
        assert_eq!(read_alpha(&full), Alpha::Uniform(1.0));
        assert_eq!(scaled(0.8, Alpha::Uniform(1.0)), 0.8);
        let double = dir.join("double.safetensors");
        write_alpha_lora(&double, &[(8, f32_alpha(16.0)), (8, f32_alpha(16.0))]);
        assert_eq!(read_alpha(&double), Alpha::Uniform(2.0));
        // The Kohya naming, rank read from the up matrix alone.
        let kohya = dir.join("kohya.safetensors");
        write_tensors(
            &kohya,
            &[
                ("lora_unet_blocks_0_attn_to_q.lora_up.weight", "F32", &[4, 8], vec![0u8; 128]),
                ("lora_unet_blocks_0_attn_to_q.alpha", "F32", &[], 2f32.to_le_bytes().to_vec()),
            ],
        );
        assert_eq!(read_alpha(&kohya), Alpha::Uniform(0.25));
    }

    #[test]
    fn an_alpha_is_read_in_every_float_type_a_file_stores_it_in() {
        let dir = crate::os_paths::test_dir("loras-alpha-types");
        // 8.0 as a half is 0x4800, as the upper half of a float 0x4100.
        let cases: [(&'static str, Vec<u8>); 4] = [
            ("F16", 0x4800u16.to_le_bytes().to_vec()),
            ("BF16", 0x4100u16.to_le_bytes().to_vec()),
            ("F32", 8f32.to_le_bytes().to_vec()),
            ("F64", 8f64.to_le_bytes().to_vec()),
        ];
        for (dtype, bytes) in cases {
            let file = dir.join(format!("{dtype}.safetensors"));
            write_alpha_lora(&file, &[(16, Some((dtype, bytes.clone()))), (16, Some((dtype, bytes)))]);
            assert_eq!(read_alpha(&file), Alpha::Uniform(0.5), "{dtype}");
        }
        assert_eq!(half_to_f64(0x3c00), 1.0);
        assert_eq!(half_to_f64(0xc000), -2.0);
        assert_eq!(half_to_f64(0x3800), 0.5);
        assert_eq!(half_to_f64(0x0001), 2f64.powi(-24));
        assert_eq!(half_to_f64(0x0000), 0.0);
        assert!(half_to_f64(0x7c00).is_infinite() && half_to_f64(0x7e00).is_nan());
    }

    #[test]
    fn layers_that_differ_are_said_to_differ_and_never_averaged() {
        let dir = crate::os_paths::test_dir("loras-alpha-mixed");
        let mixed = dir.join("mixed.safetensors");
        write_alpha_lora(&mixed, &[(16, f32_alpha(8.0)), (16, f32_alpha(16.0))]);
        assert_eq!(read_alpha(&mixed), Alpha::Mixed);
        // One alpha for layers of two ranks is two shares.
        let ranks = dir.join("ranks.safetensors");
        write_alpha_lora(&ranks, &[(16, f32_alpha(8.0)), (32, f32_alpha(8.0))]);
        assert_eq!(read_alpha(&ranks), Alpha::Mixed);
        // A layer without an alpha counts in full next to one at a half.
        let partly = dir.join("partly.safetensors");
        write_alpha_lora(&partly, &[(16, f32_alpha(8.0)), (16, None)]);
        assert_eq!(read_alpha(&partly), Alpha::Mixed);
        for strength in [0.8, -4.0, 1.0] {
            assert_eq!(scaled(strength, Alpha::Mixed), strength);
        }
    }

    #[test]
    fn an_alpha_that_cannot_be_read_leaves_the_file_as_it_always_was() {
        let dir = crate::os_paths::test_dir("loras-alpha-broken");
        let none = |file: &Path, why: &str| assert_eq!(read_alpha(file), Alpha::None, "{why}");

        let text = dir.join("text.safetensors");
        std::fs::write(&text, b"this is a web page that says login required").unwrap();
        none(&text, "no header");
        let short = dir.join("short.safetensors");
        std::fs::write(&short, [200u8, 0, 0, 0, 0, 0, 0, 0, b'{', b'}']).unwrap();
        none(&short, "a length past the end of the file");
        let json = dir.join("json.safetensors");
        let body = b"{\"a.lora_A.weight\": {\"dtype\": \"F32\", ";
        let mut bytes = (body.len() as u64).to_le_bytes().to_vec();
        bytes.extend(body);
        std::fs::write(&json, bytes).unwrap();
        none(&json, "a header that is not JSON");
        none(&dir.join("absent.safetensors"), "no file");

        // The header is whole and the data it points at is not there.
        let cut = dir.join("cut.safetensors");
        write_alpha_lora(&cut, &[(16, f32_alpha(8.0)), (16, f32_alpha(8.0))]);
        let whole = std::fs::read(&cut).unwrap();
        let header_end = 8 + u64::from_le_bytes(whole[..8].try_into().unwrap()) as usize;
        std::fs::write(&cut, &whole[..header_end + 2]).unwrap();
        none(&cut, "data cut short");

        let odd: [(&str, &str, &[u64], Vec<u8>); 4] = [
            ("an alpha of an integer type", "I64", &[], 8i64.to_le_bytes().to_vec()),
            ("an alpha that is not one number", "F32", &[2], [8f32.to_le_bytes(), 8f32.to_le_bytes()].concat()),
            ("an alpha whose bytes do not fit its type", "F32", &[], 8f64.to_le_bytes().to_vec()),
            ("an alpha that is no number", "F32", &[], f32::NAN.to_le_bytes().to_vec()),
        ];
        for (why, dtype, shape, bytes) in odd {
            let file = dir.join("odd.safetensors");
            write_tensors(
                &file,
                &[
                    ("transformer.a.lora_A.weight", "F32", &[16, 4], vec![0u8; 256]),
                    ("transformer.a.lora_B.weight", "F32", &[4, 16], vec![0u8; 256]),
                    ("transformer.a.alpha", dtype, shape, bytes),
                ],
            );
            none(&file, why);
        }
        // A rank of zero divides nothing.
        let zero = dir.join("zero.safetensors");
        write_tensors(
            &zero,
            &[("transformer.a.lora_A.weight", "F32", &[0, 4], Vec::new()), ("transformer.a.alpha", "F32", &[], 8f32.to_le_bytes().to_vec())],
        );
        none(&zero, "rank zero");
    }

    #[test]
    fn the_listing_says_what_the_alpha_of_each_file_is() {
        let dir = crate::os_paths::test_dir("loras-alpha-list");
        let root = dir.join("loras");
        write_alpha_lora(&root.join("half.safetensors"), &[(16, f32_alpha(8.0)), (16, f32_alpha(8.0))]);
        write_alpha_lora(&root.join("mixed.safetensors"), &[(16, f32_alpha(8.0)), (16, f32_alpha(16.0))]);
        write_alpha_lora(&root.join("plain.safetensors"), &[(16, None), (16, None)]);
        let value = listing(&root);
        let said: Vec<(&str, &str)> =
            value["loras"].as_array().unwrap().iter().map(|l| (l["name"].as_str().unwrap(), l["alpha"].as_str().unwrap())).collect();
        assert_eq!(said, [("half.safetensors", "uniform"), ("mixed.safetensors", "mixed"), ("plain.safetensors", "none")]);
    }

    #[test]
    fn the_listing_holds_the_safetensors_files_by_name_and_nothing_else() {
        let dir = crate::os_paths::test_dir("loras-list");
        let root = dir.join("loras");
        assert!(list(&root).is_empty(), "a folder that is not there lists nothing");
        write_lora(&root.join("Zebra.safetensors"), KOHYA);
        write_lora(&root.join("apple style.SAFETENSORS"), PEFT);
        write_lora(&root.join("qwen/detail.safetensors"), PEFT);
        write_lora(&root.join("a/b/deep.safetensors"), PEFT);
        write_lora(&root.join("a/b/c/too-deep.safetensors"), PEFT);
        write_lora(&root.join(".hidden.safetensors"), PEFT);
        write_lora(&root.join(".cache/x.safetensors"), PEFT);
        std::fs::write(root.join("notes.txt"), b"x").unwrap();
        std::fs::write(root.join("half.safetensors.download"), b"x").unwrap();
        std::fs::write(root.join("model.ckpt"), b"x").unwrap();
        std::fs::write(root.join(".safetensors"), b"x").unwrap();

        let listed = list(&root);
        let names: Vec<&str> = listed.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["a/b/deep.safetensors", "apple style.SAFETENSORS", "qwen/detail.safetensors", "Zebra.safetensors"]);
        assert_eq!(listed[3].keys, Keys::Kohya);
        assert_eq!(listed[1].keys, Keys::Peft);
        assert_eq!(listed[1].bytes, std::fs::metadata(root.join("apple style.SAFETENSORS")).unwrap().len());

        // What the command hands the interface.
        let value = listing(&root);
        assert_eq!(value["dir"], json!(root.to_string_lossy()));
        assert_eq!(value["loras"][3], json!({ "name": "Zebra.safetensors", "sizeBytes": listed[3].bytes, "keys": "kohya", "alpha": "none" }));
    }

    #[test]
    fn a_name_resolves_to_a_file_inside_the_folder_and_to_nothing_else() {
        let dir = crate::os_paths::test_dir("loras-resolve");
        let root = dir.join("loras");
        write_lora(&root.join("style.safetensors"), PEFT);
        write_lora(&root.join("qwen/detail v2.safetensors"), PEFT);
        write_lora(&dir.join("outside.safetensors"), PEFT);
        std::fs::write(root.join("notes.txt"), b"x").unwrap();
        std::fs::create_dir_all(root.join("folder.safetensors")).unwrap();
        let real_root = root.canonicalize().unwrap();

        assert_eq!(resolve(&root, "style.safetensors").unwrap(), real_root.join("style.safetensors"));
        assert_eq!(resolve(&root, "qwen/detail v2.safetensors").unwrap(), real_root.join("qwen/detail v2.safetensors"));

        let outside = dir.join("outside.safetensors");
        for bad in [
            "",
            "../outside.safetensors",
            "qwen/../../outside.safetensors",
            "qwen/../style.safetensors",
            "./style.safetensors",
            "qwen//detail v2.safetensors",
            "/etc/passwd",
            outside.to_str().unwrap(),
            "..\\outside.safetensors",
            "qwen\\detail v2.safetensors",
            "notes.txt",
            "style",
            "style.safetensors/",
            "style.safetensors\0.txt",
            ".safetensors",
            "--help.txt",
        ] {
            let said = resolve(&root, bad).unwrap_err();
            assert!(said.starts_with("This LoRA is not a .safetensors file"), "{bad:?} was answered with: {said}");
        }
        // A file that was there and is gone, and a folder with the ending.
        for gone in ["gone.safetensors", "folder.safetensors"] {
            let said = resolve(&root, gone).unwrap_err();
            assert!(said.contains("is no longer in the LoRA folder"), "{gone}: {said}");
        }
        assert!(resolve(&root, "gone.safetensors").unwrap_err().contains("The LoRA gone is"));
        // No folder at all.
        assert!(resolve(&dir.join("nowhere"), "style.safetensors").unwrap_err().contains("no longer"));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_folder_is_neither_listed_nor_resolved() {
        let dir = crate::os_paths::test_dir("loras-link");
        let root = dir.join("loras");
        write_lora(&root.join("inside.safetensors"), PEFT);
        write_lora(&dir.join("secret/outside.safetensors"), PEFT);
        std::os::unix::fs::symlink(dir.join("secret/outside.safetensors"), root.join("link.safetensors")).unwrap();
        std::os::unix::fs::symlink(dir.join("secret"), root.join("linked")).unwrap();
        // A link that stays inside is a file like any other.
        std::os::unix::fs::symlink(root.join("inside.safetensors"), root.join("alias.safetensors")).unwrap();

        let names: Vec<String> = list(&root).into_iter().map(|l| l.name).collect();
        assert_eq!(names, ["alias.safetensors", "inside.safetensors"]);
        assert!(resolve(&root, "link.safetensors").unwrap_err().starts_with("This LoRA is not"));
        assert!(resolve(&root, "linked/outside.safetensors").unwrap_err().starts_with("This LoRA is not"));
        assert!(resolve(&root, "alias.safetensors").is_ok());
    }

    #[test]
    fn delete_moves_one_file_of_the_folder_to_the_bin_and_no_other() {
        let dir = crate::os_paths::test_dir("loras-delete");
        let root = dir.join("loras");
        write_lora(&root.join("style.safetensors"), PEFT);
        write_lora(&root.join("qwen/detail.safetensors"), PEFT);
        write_lora(&dir.join("outside.safetensors"), PEFT);
        // The bin of the test is a folder.
        let trash = dir.join("trash");
        std::fs::create_dir_all(&trash).unwrap();
        let bin = |file: &Path| std::fs::rename(file, trash.join(file.file_name().unwrap())).map_err(|e| os_error::english(&e));

        // Not ours: no call.
        let none = |_: &Path| -> Result<(), String> { panic!("not ours") };
        assert!(delete(&root, "../outside.safetensors", none).unwrap_err().starts_with("This LoRA is not"));
        assert!(dir.join("outside.safetensors").is_file());

        let before = std::fs::read(root.join("style.safetensors")).unwrap();
        delete(&root, "style.safetensors", bin).unwrap();
        assert!(!root.join("style.safetensors").exists());
        assert_eq!(std::fs::read(trash.join("style.safetensors")).unwrap(), before, "the file is in the bin, whole");
        assert!(root.join("qwen/detail.safetensors").is_file());

        // Gone already: no call, and the sentence of a file that is gone.
        let none = |_: &Path| -> Result<(), String> { panic!("nothing to move") };
        assert!(delete(&root, "style.safetensors", none).unwrap_err().contains("no longer"));
    }

    #[test]
    fn a_bin_that_refuses_leaves_the_file_and_says_why() {
        let dir = crate::os_paths::test_dir("loras-delete-refused");
        let root = dir.join("loras");
        write_lora(&root.join("qwen/detail v2.safetensors"), PEFT);
        let refuses = |_: &Path| Err("permission denied".to_string());
        assert_eq!(
            delete(&root, "qwen/detail v2.safetensors", refuses).unwrap_err(),
            "Could not move detail v2 to the Trash: permission denied"
        );
        assert!(root.join("qwen/detail v2.safetensors").is_file());
    }

    #[test]
    fn the_folder_never_deletes_for_good() {
        let source = include_str!("mlx_loras.rs");
        let production = &source[..source.find("#[cfg(test)]").unwrap()];
        for hard in ["remove_file", "remove_dir", "fs::rename"] {
            assert!(!production.contains(hard), "{hard} is not the Trash");
        }
        assert!(production.contains("delete(&root, name, crate::commands::mlx_outputs::system_trash)"));
    }

    #[test]
    fn a_strength_is_a_number_between_minus_twenty_and_twenty() {
        assert_eq!(strength(0.8), 0.8);
        assert_eq!(strength(-4.0), -4.0);
        assert_eq!(strength(15.0), 15.0);
        assert_eq!(strength(-12.5), -12.5);
        assert_eq!(strength(20.0), 20.0);
        assert_eq!(strength(25.0), 20.0);
        assert_eq!(strength(-25.0), -20.0);
        assert_eq!(strength(0.456), 0.46);
        assert_eq!(strength(f32::NAN), 1.0);
        assert_eq!(strength(f32::INFINITY), 1.0);
        assert_eq!(strength(0.0), 0.0);
    }

    #[test]
    fn the_name_in_a_sentence_is_the_file_without_folder_and_ending() {
        assert_eq!(stem("qwen/detail v2.safetensors"), "detail v2");
        assert_eq!(stem("style.safetensors"), "style");
    }
}
