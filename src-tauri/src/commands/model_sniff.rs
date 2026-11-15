//! Which model family a main model file belongs to, read from the file itself.
//!
//! Discord 2026-09-26..28: Edit failed with "Node 1
//! (CheckpointLoaderSimple): Value not in list" for every model but the one
//! SDXL checkpoint. The frontend names a model's family from its FILE NAME,
//! and a name it cannot place fell to the checkpoint pipeline, which only
//! reads models/checkpoints. CivitAI names say nothing reliable about the
//! architecture, but the safetensors header does: it lists every tensor, and
//! each family has its own layout. Only the header is read (8 bytes plus a
//! JSON block of a few hundred KB), never the weights.
//!
//! The key layouts below were read off real headers on 2026-09-28 (HTTP range
//! requests against the Comfy-Org and vendor repos): FLUX 1 (dev unet and the
//! schnell all-in-one), FLUX 2 Klein, Krea 2, Z-Image Turbo, Qwen-Image 2.1,
//! Qwen-Image 1, ERNIE-Image, SDXL (ldm checkpoint and diffusers unet), SD 3.5,
//! HiDream, Chroma, Lumina 2 and Wan 2.2.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::download::{engine_folders, safe_subfolder, sanitize_filename, split_model_ref};
use crate::state::AppState;

/// A header larger than this is not a model header we want to parse.
const MAX_HEADER_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sniff {
    /// LU's name for the family ("flux", "zimage", ...), or a family LU has no
    /// pipeline for ("chroma", "hidream", ...). None when the layout is unknown.
    pub arch: Option<String>,
    /// The file carries its own text encoder (an all-in-one checkpoint).
    pub has_text_encoder: bool,
    /// The file carries its own VAE.
    pub has_vae: bool,
}

#[derive(Debug, Deserialize)]
pub struct SniffRequest {
    /// "checkpoints" or "diffusion_models": the ComfyUI list the name came from.
    pub folder: String,
    /// The name exactly as ComfyUI lists it, subfolders included.
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SniffResult {
    pub folder: String,
    pub name: String,
    #[serde(flatten)]
    pub sniff: Sniff,
}

/// The family, from tensor names and the one shape that separates Z-Image
/// from Lumina 2 (same layout, different caption width). Pure, so the tests
/// can feed it the real key sets.
pub fn classify<'a>(tensors: impl IntoIterator<Item = (&'a str, Option<&'a [u64]>)>) -> Sniff {
    let mut stems: HashSet<String> = HashSet::new();
    let mut has_text_encoder = false;
    let mut has_vae = false;
    let mut cap_width: Option<u64> = None;
    for (key, shape) in tensors {
        if key == "__metadata__" {
            continue;
        }
        if key.starts_with("text_encoders.") || key.starts_with("conditioner.") || key.starts_with("cond_stage_model.") {
            has_text_encoder = true;
            continue;
        }
        if key.starts_with("vae.") || key.starts_with("first_stage_model.") {
            has_vae = true;
            continue;
        }
        let bare = key
            .strip_prefix("model.diffusion_model.")
            .or_else(|| key.strip_prefix("diffusion_model."))
            .or_else(|| key.strip_prefix("model."))
            .unwrap_or(key);
        if bare == "cap_embedder.0.weight" {
            cap_width = shape.and_then(|s| s.first().copied());
        }
        if let Some(stem) = bare.split('.').next() {
            stems.insert(stem.to_string());
        }
    }
    let has = |s: &str| stems.contains(s);
    let arch = if has("audio_patch_proj") && has("video_patch_proj") {
        // MiniMax H3: picture and sound from one model (Discord 2026-09-26,
        // a CivitAI repack listed as an image model).
        Some("minimaxh3")
    } else if has("video_patch_proj") && has("token_refiner") && has("adaln_t_table") {
        // MiniMax H3 Image (Comfy-Org/MiniMax-H3-Image, 08.11.2026): the H3
        // layout without the sound half. A still model, not a video one
        // (C78, Discord feature-requests 11.11.2026). Read off the header of
        // minimax_h3_image_pruned_w4a8 on 12.11.2026.
        Some("minimaxh3image")
    } else if has("double_stream_modulation_img") {
        Some("flux2")
    } else if has("distilled_guidance_layer") {
        Some("chroma")
    } else if has("double_blocks") && has("single_blocks") {
        Some("flux")
    } else if has("txtfusion") && has("blocks") {
        Some("krea2")
    } else if has("noise_refiner") && has("context_refiner") && has("cap_embedder") {
        // Z-Image feeds Qwen3-4B (2560 wide); Lumina 2 feeds Gemma 2 (2304).
        Some(if cap_width == Some(2560) { "zimage" } else { "lumina2" })
    } else if has("text_proj") && has("x_embedder") && has("layers") {
        Some("ernie_image")
    } else if has("transformer_blocks") && has("img_in") && has("txt_in") {
        // 2.1 carries a shared top-level modulation; Qwen-Image 1 and its Edit
        // models carry txt_norm instead and need a different encoder.
        Some(if has("modulation") { "qwenimage" } else { "qwenimage1" })
    } else if has("double_stream_blocks") {
        Some("hidream")
    } else if has("joint_blocks") {
        Some("sd3")
    } else if has("input_blocks") && has("output_blocks") {
        Some(if has("label_emb") { "sdxl" } else { "sd15" })
    } else if has("down_blocks") && has("up_blocks") {
        Some(if has("add_embedding") { "sdxl" } else { "sd15" })
    } else if has("blocks") && has("patch_embedding") {
        Some("wan")
    } else if has("decoder") && (has("encoder") || has("post_quant_conv")) && !has_text_encoder {
        // A bare autoencoder that landed in a model folder (Discord
        // 2026-09-26: minimax_h3_video_vae_fp16 listed as an image model).
        Some("vae")
    } else if has("text_model") || has("embed_tokens") || (has("encoder") && has("shared")) {
        // CLIP, LLM or T5 text encoder, same story.
        Some("text_encoder")
    } else {
        None
    };
    Sniff { arch: arch.map(str::to_string), has_text_encoder, has_vae }
}

/// Read and classify one file's header. None when it is not a readable
/// safetensors file.
pub fn sniff_file(path: &Path) -> Option<Sniff> {
    let shapes = header_tensors(path)?;
    Some(classify(shapes.iter().map(|(k, s)| (k.as_str(), s.as_deref()))))
}

/// The tensor names and shapes of a safetensors header. None when the file
/// is not one.
fn header_tensors(path: &Path) -> Option<Vec<(String, Option<Vec<u64>>)>> {
    let mut f = File::open(path).ok()?;
    let total = f.metadata().ok()?.len();
    let mut len = [0u8; 8];
    f.read_exact(&mut len).ok()?;
    let n = u64::from_le_bytes(len);
    if n == 0 || n > MAX_HEADER_BYTES || n + 8 > total {
        return None;
    }
    let mut buf = vec![0u8; n as usize];
    f.read_exact(&mut buf).ok()?;
    let header: serde_json::Map<String, serde_json::Value> = serde_json::from_slice(&buf).ok()?;
    let shapes: Vec<(String, Option<Vec<u64>>)> = header
        .iter()
        .map(|(k, v)| {
            let shape = v.get("shape").and_then(|s| s.as_array()).map(|a| a.iter().filter_map(|x| x.as_u64()).collect());
            (k.clone(), shape)
        })
        .collect();
    Some(shapes)
}

// ── A27: which models folder a file belongs in ─────────────────────────────
//
// GitHub #234 (Kubuntu, RTX 5090): diffusion and video models downloaded
// through the CivitAI search landed in models/checkpoints. The folder came
// from the title alone (flux, wan, hunyuan, .gguf); LTX, MiniMax H3,
// Qwen-Image, Z-Image, Chroma, Krea, Mochi, CogVideoX and every Wan offshoot
// without "wan" in its title went to checkpoints, where ComfyUI's
// CheckpointLoaderSimple cannot load a bare diffusion model. The header says
// which it is.

/// The ComfyUI folders a header can send a file to.
pub const HEADER_FOLDERS: &[&str] = &["checkpoints", "diffusion_models", "vae", "text_encoders"];

/// The folder a file with these tensors belongs in, or None when the header
/// does not say (a LoRA, an unknown layout): then the caller keeps its own
/// guess. Pure, so the tests can feed it real headers.
///
///   * a bare VAE → vae, a bare text encoder → text_encoders;
///   * a diffusion model that carries its own VAE → checkpoints, the one
///     folder CheckpointLoaderSimple reads (SD 1.5, SDXL, the FLUX all-in-one,
///     LTX-Video, which ComfyUI loads as a checkpoint);
///   * a diffusion model without one → diffusion_models (UNETLoader).
pub fn folder_for_tensors<'a>(tensors: &[(&'a str, Option<&'a [u64]>)]) -> Option<&'static str> {
    // A LoRA names the blocks it changes, which would read as their model:
    // kohya (`lora_unet_…`), diffusers (`….lora_A.weight`), XLabs
    // (`….proj_lora1.down.weight`), LyCORIS (`lokr_`, `hada_`).
    let lora = tensors.iter().any(|(k, _)| {
        let k = k.to_ascii_lowercase();
        k.contains("lora") || k.contains("lokr_") || k.contains("hada_w") || k.contains("lycoris")
    });
    if lora {
        return None;
    }
    let sniff = classify(tensors.iter().copied());
    let diffusion = match sniff.arch.as_deref() {
        Some("vae") => return Some("vae"),
        Some("text_encoder") => return Some("text_encoders"),
        Some(_) => true,
        None => video_layout(tensors),
    };
    if !diffusion {
        return None;
    }
    Some(if sniff.has_vae { "checkpoints" } else { "diffusion_models" })
}

/// The video families `classify` leaves unnamed, because LU has no pipeline
/// of its own keyed on them. Layouts read off real headers on 14.11.2026:
/// LTX-Video 0.9.5 and 0.9.7 (Lightricks), Mochi and HunyuanVideo (the
/// Comfy-Org repacks, Hunyuan under `model.model.`), CogVideoX (THUDM).
fn video_layout(tensors: &[(&str, Option<&[u64]>)]) -> bool {
    let mut stems: HashSet<&str> = HashSet::new();
    for (key, _) in tensors {
        let bare = ["model.diffusion_model.", "diffusion_model.", "model.model.", "model."]
            .iter()
            .find_map(|p| key.strip_prefix(p))
            .unwrap_or(key);
        if let Some(stem) = bare.split('.').next() {
            stems.insert(stem);
        }
    }
    let has = |s: &str| stems.contains(s);
    (has("transformer_blocks") && (has("patchify_proj") || has("adaln_single")))
        || (has("transformer_blocks") && has("patch_embed") && has("time_embedding"))
        || (has("blocks") && has("t5_y_embedder"))
        || (has("double_blocks") && has("single_blocks"))
}

/// The folder for one file on disk; None as for `folder_for_tensors`, and
/// for a file that is not safetensors (a GGUF keeps the rule it has).
pub fn folder_for_file(path: &Path) -> Option<&'static str> {
    let shapes = header_tensors(path)?;
    let view: Vec<(&str, Option<&[u64]>)> = shapes.iter().map(|(k, s)| (k.as_str(), s.as_deref())).collect();
    folder_for_tensors(&view)
}

/// `unet` is ComfyUI's older name for diffusion_models.
fn same_folder(a: &str, b: &str) -> bool {
    fn n(x: &str) -> &str {
        if x == "unet" { "diffusion_models" } else { x }
    }
    n(a) == n(b)
}

/// Where a file downloaded into `guessed` (a folder picked from a title)
/// belongs by its header, and the move there. `dirs` maps each of
/// `HEADER_FOLDERS` to its directory. Returns the folder and the new path
/// when the file was moved. Leaves the file where it is when the header does
/// not say, when it already sits right, or when a file of that name is
/// already in the other folder (nothing is overwritten).
pub fn settle_by_header(file: &Path, guessed: &str, dirs: &HashMap<String, PathBuf>) -> Option<(&'static str, PathBuf)> {
    if !["checkpoints", "diffusion_models", "unet"].contains(&guessed) {
        return None;
    }
    let target = folder_for_file(file)?;
    if same_folder(guessed, target) {
        return None;
    }
    let dir = dirs.get(target)?;
    let dest = dir.join(file.file_name()?);
    if dest.exists() {
        tracing::warn!("{} belongs in {target}, but {} is taken; it stays", file.display(), dest.display());
        return None;
    }
    if let Err(e) = std::fs::create_dir_all(dir) {
        tracing::warn!("could not create {}: {}", dir.display(), crate::os_error::english(&e));
        return None;
    }
    if std::fs::rename(file, &dest).is_err() {
        // Another volume (a Storage folder on a second disk): copy, then remove.
        if let Err(e) = std::fs::copy(file, &dest) {
            let _ = std::fs::remove_file(&dest);
            tracing::warn!("could not move {} to {target}: {}", file.display(), crate::os_error::english(&e));
            return None;
        }
        let _ = std::fs::remove_file(file);
    }
    tracing::info!("{} read as a {target} file, moved to {}", file.display(), dest.display());
    Some((target, dest))
}

/// Which folder a file that already sits in a main model folder belongs in,
/// when that is another one: for the hint in Models → Details. Never moves.
pub fn belongs_elsewhere(file: &Path, found_in: &str) -> Option<&'static str> {
    let target = folder_for_file(file)?;
    (!same_folder(found_in, target)).then_some(target)
}

type CacheKey = (PathBuf, u64, Option<SystemTime>);
static CACHE: Mutex<Option<HashMap<CacheKey, Option<Sniff>>>> = Mutex::new(None);

fn sniff_cached(path: &Path) -> Option<Sniff> {
    let meta = path.metadata().ok()?;
    let key = (path.to_path_buf(), meta.len(), meta.modified().ok());
    if let Some(hit) = CACHE.lock().ok().and_then(|c| c.as_ref().and_then(|m| m.get(&key).cloned())) {
        return hit;
    }
    let sniff = sniff_file(path);
    if let Ok(mut c) = CACHE.lock() {
        c.get_or_insert_with(HashMap::new).insert(key, sniff.clone());
    }
    sniff
}

/// Where a listed name lives, looking only inside the given folders. The name
/// comes from a ComfyUI answer, so it is held to the same rule as the size
/// probe: no absolute paths, no `..`, nothing outside the model folders.
fn locate(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    let (sub, base) = split_model_ref(name);
    if !sub.is_empty() && safe_subfolder(&sub).is_err() {
        return None;
    }
    if sanitize_filename(&base) != base {
        return None;
    }
    let lower = base.to_ascii_lowercase();
    if !(lower.ends_with(".safetensors") || lower.ends_with(".sft")) {
        return None;
    }
    dirs.iter()
        .map(|d| if sub.is_empty() { d.join(&base) } else { d.join(&sub).join(&base) })
        .find(|p| p.is_file())
}

fn candidate_dirs(folders: Option<&crate::commands::comfy_folders::ComfyFolders>, comfy_path: &Option<String>, folder: &str) -> Vec<PathBuf> {
    let keys: &[&str] = match folder {
        "checkpoints" => &["checkpoints"],
        "diffusion_models" => &["diffusion_models", "unet"],
        _ => &[],
    };
    let mut dirs: Vec<PathBuf> = Vec::new();
    for key in keys {
        if let Some(f) = folders {
            for d in f.dirs_for(key) {
                if !dirs.contains(&d) {
                    dirs.push(d);
                }
            }
        }
        if let Some(base) = comfy_path {
            let d = PathBuf::from(base).join("models").join(key);
            if !dirs.contains(&d) {
                dirs.push(d);
            }
        }
    }
    dirs
}

/// The family of each listed main model, read from its header. A file this
/// machine cannot see (remote ComfyUI, GGUF, moved) comes back with no arch,
/// and the frontend keeps its name-based answer.
#[tauri::command]
pub async fn sniff_model_files(files: Vec<SniffRequest>, state: State<'_, AppState>) -> Result<Vec<SniffResult>, String> {
    let comfy_path = state.comfy_path.lock().map(|p| p.clone()).unwrap_or(None);
    let folders = engine_folders(&state).await;
    tauri::async_runtime::spawn_blocking(move || {
        files
            .into_iter()
            .map(|req| {
                let dirs = candidate_dirs(folders.as_ref(), &comfy_path, &req.folder);
                let sniff = locate(&dirs, &req.name).and_then(|p| sniff_cached(&p)).unwrap_or_default();
                SniffResult { folder: req.folder, name: req.name, sniff }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arch(keys: &[&str]) -> Option<String> {
        classify(keys.iter().map(|k| (*k, None))).arch
    }

    #[test]
    fn families_from_real_key_layouts() {
        assert_eq!(arch(&["double_blocks.0.img_attn.qkv.weight", "single_blocks.0.linear1.weight", "guidance_in.in_layer.weight"]).as_deref(), Some("flux"));
        assert_eq!(arch(&["double_blocks.0.x", "single_blocks.0.x", "double_stream_modulation_img.lin.weight"]).as_deref(), Some("flux2"));
        assert_eq!(arch(&["double_blocks.0.x", "single_blocks.0.x", "distilled_guidance_layer.in_proj.weight"]).as_deref(), Some("chroma"));
        assert_eq!(arch(&["blocks.0.attn.qkv.weight", "txtfusion.0.x", "tmlp.0.weight", "first.weight"]).as_deref(), Some("krea2"));
        assert_eq!(arch(&["layers.0.x", "text_proj.weight", "x_embedder.weight", "adaLN_modulation.1.weight"]).as_deref(), Some("ernie_image"));
        assert_eq!(arch(&["transformer_blocks.0.x", "img_in.weight", "txt_in.weight", "modulation.weight"]).as_deref(), Some("qwenimage"));
        assert_eq!(arch(&["transformer_blocks.0.x", "img_in.weight", "txt_in.weight", "txt_norm.weight"]).as_deref(), Some("qwenimage1"));
        assert_eq!(arch(&["double_stream_blocks.0.x", "caption_projection.0.x"]).as_deref(), Some("hidream"));
        assert_eq!(arch(&["model.diffusion_model.joint_blocks.0.x", "text_encoders.clip_l.x"]).as_deref(), Some("sd3"));
        assert_eq!(arch(&["blocks.0.x", "patch_embedding.weight", "text_embedding.0.weight"]).as_deref(), Some("wan"));
        assert_eq!(arch(&["blocks.0.attn.qkv_proj.weight", "token_refiner.0.x", "audio_patch_proj.weight", "video_patch_proj.weight", "adaln_t_table"]).as_deref(), Some("minimaxh3"));
        // H3 Image: the picture half with the H3 refiner and time table (C78).
        assert_eq!(
            arch(&["blocks.0.attn.qkv.weight", "token_refiner.0.x", "video_patch_proj.weight", "adaln_t_table", "condition_proj.weight", "final_layer.linear.weight", "rope"]).as_deref(),
            Some("minimaxh3image")
        );
        // One half alone is not H3.
        assert_eq!(arch(&["blocks.0.x", "video_patch_proj.weight"]), None);
        assert_eq!(arch(&["foo.weight"]), None);
        assert_eq!(arch(&["encoder.conv_in.weight", "decoder.conv_out.weight"]).as_deref(), Some("vae"));
        assert_eq!(arch(&["model.layers.0.mlp.weight", "model.embed_tokens.weight"]).as_deref(), Some("text_encoder"));
        assert_eq!(arch(&["encoder.block.0.x", "shared.weight"]).as_deref(), Some("text_encoder"));
        assert_eq!(arch(&["text_model.encoder.layers.0.x"]).as_deref(), Some("text_encoder"));
    }

    #[test]
    fn sdxl_and_sd15_in_both_layouts() {
        assert_eq!(arch(&["model.diffusion_model.input_blocks.0.0.weight", "model.diffusion_model.output_blocks.0.x", "model.diffusion_model.label_emb.0.0.weight"]).as_deref(), Some("sdxl"));
        assert_eq!(arch(&["model.diffusion_model.input_blocks.0.0.weight", "model.diffusion_model.output_blocks.0.x"]).as_deref(), Some("sd15"));
        assert_eq!(arch(&["down_blocks.0.x", "up_blocks.0.x", "add_embedding.linear_1.weight"]).as_deref(), Some("sdxl"));
        assert_eq!(arch(&["down_blocks.0.x", "up_blocks.0.x"]).as_deref(), Some("sd15"));
    }

    #[test]
    fn zimage_and_lumina2_differ_by_caption_width() {
        let keys = ["noise_refiner.0.x", "context_refiner.0.x", "cap_embedder.0.weight", "layers.0.x"];
        let z: Vec<(&str, Option<&[u64]>)> = keys.iter().map(|k| (*k, if *k == "cap_embedder.0.weight" { Some(&[2560u64][..]) } else { None })).collect();
        let l: Vec<(&str, Option<&[u64]>)> = keys.iter().map(|k| (*k, if *k == "cap_embedder.0.weight" { Some(&[2304u64][..]) } else { None })).collect();
        assert_eq!(classify(z).arch.as_deref(), Some("zimage"));
        assert_eq!(classify(l).arch.as_deref(), Some("lumina2"));
    }

    #[test]
    fn all_in_one_checkpoint_reports_its_parts() {
        let s = classify(["model.diffusion_model.double_blocks.0.x", "model.diffusion_model.single_blocks.0.x", "text_encoders.t5xxl.x", "vae.decoder.x"].iter().map(|k| (*k, None)));
        assert_eq!(s, Sniff { arch: Some("flux".into()), has_text_encoder: true, has_vae: true });
    }

    /// Against real headers (keys + shapes as JSON, fetched by range request).
    /// Skipped unless LU_SNIFF_FIXTURES points at such a folder; each file is
    /// named <expected arch>.json.
    #[test]
    fn real_headers_when_available() {
        let Ok(dir) = std::env::var("LU_SNIFF_FIXTURES") else { return };
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let shapes: Vec<(String, Option<Vec<u64>>)> = v["keys"].as_array().unwrap().iter().map(|k| {
                let k = k.as_str().unwrap().to_string();
                let s = v["shapes"].get(&k).and_then(|s| s.as_array()).map(|a| a.iter().filter_map(|x| x.as_u64()).collect());
                (k, s)
            }).collect();
            let got = classify(shapes.iter().map(|(k, s)| (k.as_str(), s.as_deref()))).arch.unwrap_or_default();
            let want = path.file_stem().unwrap().to_string_lossy().to_string();
            println!("{want}: {got}");
            assert_eq!(got, want);
        }
    }

    /// A27 (GitHub #234): the folder of real files, from their real headers
    /// (src-tauri/tests/fixtures/model_headers, read by range request on
    /// 14.11.2026; the keys of block 0 and everything outside the blocks).
    #[test]
    fn real_headers_name_their_folder() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/model_headers");
        let want: &[(&str, Option<&str>)] = &[
            // Video models, the ones the title rule sent to checkpoints.
            ("ltxv-2b-0.9.5", Some("checkpoints")),  // carries its VAE; ComfyUI loads LTX as a checkpoint
            ("ltxv-13b-0.9.7", Some("checkpoints")),
            ("mochi", Some("diffusion_models")),
            ("hunyuanvideo", Some("diffusion_models")),
            ("cogvideox-2b", Some("diffusion_models")),
            ("wan21-1.3b", Some("diffusion_models")),
            ("wan22-5b", Some("diffusion_models")),
            // Image models.
            ("qwen-image", Some("diffusion_models")),
            ("chroma1-hd", Some("diffusion_models")),
            ("zimage-turbo", Some("diffusion_models")),
            // All-in-one checkpoints stay checkpoints, also with flux in the title.
            ("flux-schnell-aio", Some("checkpoints")),
            ("sdxl-base", Some("checkpoints")),
            ("sd15", Some("checkpoints")),
            // A LoRA says nothing about a main model folder.
            ("flux-lora-xlabs", None),
            ("flux-lora-diffusers", None),
        ];
        for (name, folder) in want {
            let raw = std::fs::read(dir.join(format!("{name}.json"))).unwrap_or_else(|e| panic!("{name}: {e}"));
            let v: serde_json::Value = serde_json::from_slice(&raw).unwrap();
            let shapes: Vec<(String, Option<Vec<u64>>)> = v["keys"]
                .as_array()
                .unwrap()
                .iter()
                .map(|k| {
                    let k = k.as_str().unwrap().to_string();
                    let s = v["shapes"].get(&k).and_then(|s| s.as_array()).map(|a| a.iter().filter_map(|x| x.as_u64()).collect());
                    (k, s)
                })
                .collect();
            let view: Vec<(&str, Option<&[u64]>)> = shapes.iter().map(|(k, s)| (k.as_str(), s.as_deref())).collect();
            assert_eq!(folder_for_tensors(&view), *folder, "{name}");
        }
    }

    #[test]
    fn a_bare_vae_or_text_encoder_has_its_own_folder() {
        let f = |keys: &[&str]| folder_for_tensors(&keys.iter().map(|k| (*k, None)).collect::<Vec<_>>());
        assert_eq!(f(&["encoder.conv_in.weight", "decoder.conv_out.weight"]), Some("vae"));
        assert_eq!(f(&["encoder.block.0.x", "shared.weight"]), Some("text_encoders"));
        assert_eq!(f(&["foo.weight"]), None);
    }

    /// One safetensors file on disk with these keys, for the move tests.
    fn write_model(path: &Path, keys: &[&str]) {
        let mut header = serde_json::Map::new();
        for (i, k) in keys.iter().enumerate() {
            header.insert(k.to_string(), serde_json::json!({"dtype": "BF16", "shape": [1], "data_offsets": [i * 2, i * 2 + 2]}));
        }
        let header = serde_json::Value::Object(header).to_string();
        let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
        bytes.extend_from_slice(header.as_bytes());
        bytes.extend(std::iter::repeat_n(0u8, keys.len() * 2));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn model_dirs(root: &Path) -> HashMap<String, PathBuf> {
        HEADER_FOLDERS.iter().map(|k| (k.to_string(), root.join(k))).collect()
    }

    const LTX_BARE: &[&str] = &["model.diffusion_model.transformer_blocks.0.attn1.to_q.weight", "model.diffusion_model.patchify_proj.weight", "model.diffusion_model.adaln_single.linear.weight"];

    #[test]
    fn a_download_into_checkpoints_moves_to_diffusion_models_by_its_header() {
        let root = tempfile::tempdir().unwrap();
        let dirs = model_dirs(root.path());
        // "Wan 2.2 Rapid" and "LTX 2B distilled" from the CivitAI search: no flux/wan/hunyuan in the title.
        let file = root.path().join("checkpoints").join("ltx_distilled_bare.safetensors");
        write_model(&file, LTX_BARE);
        let (folder, dest) = settle_by_header(&file, "checkpoints", &dirs).expect("moved");
        assert_eq!(folder, "diffusion_models");
        assert_eq!(dest, root.path().join("diffusion_models").join("ltx_distilled_bare.safetensors"));
        assert!(dest.is_file() && !file.exists());
        // An all-in-one with flux in the title goes the other way.
        let aio = root.path().join("diffusion_models").join("flux_aio.safetensors");
        write_model(&aio, &["model.diffusion_model.double_blocks.0.x", "model.diffusion_model.single_blocks.0.x", "text_encoders.t5xxl.x", "vae.decoder.conv_in.weight"]);
        assert_eq!(settle_by_header(&aio, "diffusion_models", &dirs).map(|m| m.0), Some("checkpoints"));
    }

    #[test]
    fn nothing_moves_when_the_header_agrees_says_nothing_or_the_name_is_taken() {
        let root = tempfile::tempdir().unwrap();
        let dirs = model_dirs(root.path());
        let right = root.path().join("diffusion_models").join("ltx.safetensors");
        write_model(&right, LTX_BARE);
        assert!(settle_by_header(&right, "diffusion_models", &dirs).is_none());
        assert!(settle_by_header(&right, "unet", &dirs).is_none(), "unet is diffusion_models");
        let lora = root.path().join("checkpoints").join("style.safetensors");
        write_model(&lora, &["lora_unet_double_blocks_0_img_attn_proj.lora_down.weight"]);
        assert!(settle_by_header(&lora, "checkpoints", &dirs).is_none());
        let gguf = root.path().join("checkpoints").join("wan.gguf");
        std::fs::write(&gguf, b"GGUF....").unwrap();
        assert!(settle_by_header(&gguf, "checkpoints", &dirs).is_none());
        // Never overwrites: the same name in the target folder keeps both where they are.
        let twin = root.path().join("checkpoints").join("ltx.safetensors");
        write_model(&twin, LTX_BARE);
        assert!(settle_by_header(&twin, "checkpoints", &dirs).is_none());
        assert!(twin.is_file() && right.is_file());
        // A LoRA download is never asked.
        let loras = root.path().join("loras").join("bare.safetensors");
        write_model(&loras, LTX_BARE);
        assert!(settle_by_header(&loras, "loras", &dirs).is_none());
    }

    #[test]
    fn a_file_already_in_the_wrong_folder_is_named_not_moved() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("checkpoints").join("sub").join("qwen.safetensors");
        write_model(&file, &["transformer_blocks.0.x", "img_in.weight", "txt_in.weight", "txt_norm.weight"]);
        assert_eq!(belongs_elsewhere(&file, "checkpoints"), Some("diffusion_models"));
        assert!(file.is_file());
        assert_eq!(belongs_elsewhere(&file, "diffusion_models"), None);
    }

    #[test]
    fn reads_a_real_header_and_refuses_garbage() {
        let dir = std::env::temp_dir().join(format!("lu-sniff-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let header = br#"{"__metadata__":{"x":"y"},"cap_embedder.0.weight":{"dtype":"BF16","shape":[2560],"data_offsets":[0,2]},"noise_refiner.0.w":{"dtype":"BF16","shape":[1],"data_offsets":[2,4]},"context_refiner.0.w":{"dtype":"BF16","shape":[1],"data_offsets":[4,6]}}"#;
        let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
        bytes.extend_from_slice(header);
        bytes.extend_from_slice(&[0u8; 6]);
        let good = dir.join("renamed_by_civitai.safetensors");
        std::fs::write(&good, &bytes).unwrap();
        assert_eq!(sniff_file(&good).unwrap().arch.as_deref(), Some("zimage"));
        let bad = dir.join("broken.safetensors");
        std::fs::write(&bad, u64::MAX.to_le_bytes()).unwrap();
        assert_eq!(sniff_file(&bad), None);
        // Found by name inside the folder, never outside it.
        assert_eq!(locate(std::slice::from_ref(&dir), "renamed_by_civitai.safetensors"), Some(good));
        assert_eq!(locate(std::slice::from_ref(&dir), "../renamed_by_civitai.safetensors"), None);
        assert_eq!(locate(std::slice::from_ref(&dir), "model.gguf"), None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
