//! The user's own model folder, handed to ComfyUI.
//!
//! GH #122 (zrmdsxa) plus the Discord thread "Read me first" (ever.noob):
//! the folder under Settings → Model Storage was a download target and nothing
//! more. Chat GGUFs in it are read by `engine::scan_gguf_roots` now, but a
//! `.safetensors` is a different problem: LU never scans image or video models
//! off the disk at all. That inventory comes out of ComfyUI's own `/object_info`
//! enums, and ComfyUI only lists what sits under its own `models/` tree.
//!
//! So the honest way in is ComfyUI's own mechanism: an extra-model-paths config.
//! We write our own file and pass it with `--extra-model-paths-config`, so a
//! hand written `extra_model_paths.yaml` in the ComfyUI folder is never touched
//! and nothing changes for a user who set none. Two limits are real and the
//! Settings text says both: it reaches a ComfyUI that LU starts, and it takes
//! effect the next time ComfyUI starts.
//!
//! Only subfolders NAMED like ComfyUI's model folders are mapped. A flat dump
//! of mixed files is left alone on purpose: mapping it into every key would
//! offer one checkpoint as a LoRA, a VAE and a ControlNet at the same time.

use std::path::{Path, PathBuf};

/// The `folder_paths` keys ComfyUI accepts in an extra-model-paths file, which
/// are also the folder names it uses on disk. Kept in step with
/// `subfolderForSource` in `src/api/comfyui.ts` (a test holds the two lists
/// against each other).
pub(crate) const COMFY_MODEL_FOLDERS: &[&str] = &[
    "checkpoints",
    "clip_vision",
    "controlnet",
    "diffusion_models",
    "embeddings",
    "loras",
    "style_models",
    "text_encoders",
    "upscale_models",
    "vae",
];

/// Which ComfyUI-shaped folders exist below `root`.
///
/// Both layouts count: the folder the user picked may itself be a ComfyUI-style
/// tree (`G:\AI\Models\loras`) or may hold one (`G:\AI\Models\models\loras`).
/// Returned in the order of `COMFY_MODEL_FOLDERS` so the written file is stable
/// and a rewrite with nothing changed produces the same bytes.
pub(crate) fn comfy_shaped_subdirs(root: &Path) -> Vec<(&'static str, PathBuf)> {
    let mut out = Vec::new();
    for key in COMFY_MODEL_FOLDERS {
        for candidate in [root.join(key), root.join("models").join(key)] {
            if candidate.is_dir() {
                out.push((*key, candidate));
                break;
            }
        }
    }
    out
}

/// The YAML ComfyUI reads, or `None` when the folder holds nothing ComfyUI
/// could place. Absolute paths per key rather than one `base_path`, because the
/// two layouts above can be mixed inside one folder.
///
/// Windows paths are quoted, so a drive letter's colon and the backslashes
/// cannot be read as YAML syntax. A path with a `"` in it is dropped rather
/// than escaped: no model folder needs one, and a half-escaped path would make
/// ComfyUI fail to parse the whole file and lose the other folders with it.
pub(crate) fn build_extra_model_paths_yaml(root: &Path) -> Option<String> {
    let found: Vec<(&str, PathBuf)> = comfy_shaped_subdirs(root)
        .into_iter()
        .filter(|(_, p)| !p.to_string_lossy().contains('"'))
        .collect();
    if found.is_empty() {
        return None;
    }
    let mut s = String::from(
        "# Written by Locally Uncensored from Settings -> Model Storage.\n\
         # Edit the folder in the app, not this file: it is rewritten on every change.\n\
         lu_custom_models:\n",
    );
    for (key, path) in found {
        s.push_str(&format!("  {}: \"{}\"\n", key, path.to_string_lossy()));
    }
    Some(s)
}

/// Where the generated file lives: beside the app's own models dir, never
/// inside the user's ComfyUI folder.
pub(crate) fn extra_model_paths_file() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or("Cannot resolve app data directory")?;
    let dir = base.join("Locally Uncensored");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Create app data dir: {}", crate::os_error::english(&e)))?;
    Ok(dir.join("lu_extra_model_paths.yaml"))
}

/// The file to pass to ComfyUI, or `None` when there is nothing to pass.
/// Called from the ComfyUI start path, so it never creates anything.
pub fn extra_model_paths_arg() -> Option<PathBuf> {
    let base = dirs::data_dir()?;
    let file = base
        .join("Locally Uncensored")
        .join("lu_extra_model_paths.yaml");
    if file.is_file() {
        Some(file)
    } else {
        None
    }
}

/// Write (or remove) the extra-model-paths file for the folder under Model
/// Storage. Idempotent, and safe to call on every settings change.
///
/// Reports what it did, so the Settings panel can name the folders it found
/// instead of claiming a success the user cannot check.
#[tauri::command]
pub fn sync_custom_model_paths(dir: Option<String>) -> Result<serde_json::Value, String> {
    let file = extra_model_paths_file()?;
    let trimmed = dir.unwrap_or_default().trim().to_string();
    let yaml = if trimmed.is_empty() {
        None
    } else {
        build_extra_model_paths_yaml(Path::new(&trimmed))
    };
    let folders: Vec<String> = if trimmed.is_empty() {
        Vec::new()
    } else {
        comfy_shaped_subdirs(Path::new(&trimmed))
            .into_iter()
            .map(|(k, _)| k.to_string())
            .collect()
    };
    match yaml {
        Some(text) => {
            std::fs::write(&file, text)
                .map_err(|e| format!("Write model paths file: {}", crate::os_error::english(&e)))?;
        }
        None => {
            // A folder that stopped being ComfyUI-shaped must not keep feeding
            // ComfyUI the old paths, so the file goes away with it.
            if file.exists() {
                std::fs::remove_file(&file).map_err(|e| {
                    format!("Remove model paths file: {}", crate::os_error::english(&e))
                })?;
            }
        }
    }
    Ok(serde_json::json!({
        "written": !folders.is_empty(),
        "file": file.to_string_lossy(),
        "folders": folders,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("lu-custom-models-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_comfy_shaped_folders_in_both_layouts() {
        let root = tmp("both-layouts");
        std::fs::create_dir_all(root.join("loras")).unwrap();
        std::fs::create_dir_all(root.join("models").join("checkpoints")).unwrap();
        let found = comfy_shaped_subdirs(&root);
        let keys: Vec<&str> = found.iter().map(|(k, _)| *k).collect();
        assert_eq!(keys, vec!["checkpoints", "loras"]);
        assert_eq!(found[0].1, root.join("models").join("checkpoints"));
        assert_eq!(found[1].1, root.join("loras"));
    }

    #[test]
    fn the_direct_layout_wins_over_the_nested_one() {
        // Both exist: the folder the user pointed at is the one he meant.
        let root = tmp("direct-wins");
        std::fs::create_dir_all(root.join("vae")).unwrap();
        std::fs::create_dir_all(root.join("models").join("vae")).unwrap();
        let found = comfy_shaped_subdirs(&root);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].1, root.join("vae"));
    }

    /// Negative control: a folder full of models but with no ComfyUI folder
    /// name in it produces NO file. Mapping a flat dump into every key would
    /// offer one checkpoint as a LoRA and a ControlNet at the same time.
    #[test]
    fn a_flat_folder_produces_no_config() {
        let root = tmp("flat");
        std::fs::write(root.join("juggernautXL_v9.safetensors"), b"x").unwrap();
        std::fs::create_dir_all(root.join("Text Generation")).unwrap();
        assert!(comfy_shaped_subdirs(&root).is_empty());
        assert!(build_extra_model_paths_yaml(&root).is_none());
    }

    #[test]
    fn yaml_quotes_the_path_and_names_every_folder() {
        let root = tmp("yaml");
        std::fs::create_dir_all(root.join("loras")).unwrap();
        std::fs::create_dir_all(root.join("vae")).unwrap();
        let text = build_extra_model_paths_yaml(&root).unwrap();
        assert!(text.starts_with("# Written by Locally Uncensored"));
        assert!(text.contains("lu_custom_models:\n"));
        assert!(text.contains(&format!("  loras: \"{}\"\n", root.join("loras").display())));
        assert!(text.contains(&format!("  vae: \"{}\"\n", root.join("vae").display())));
        // Every value is quoted, so a Windows `G:\...` cannot be read as YAML.
        for line in text.lines().filter(|l| l.starts_with("  ")) {
            let value = line.split_once(": ").unwrap().1;
            assert!(value.starts_with('"') && value.ends_with('"'), "unquoted: {line}");
        }
    }

    /// Negative control: a missing folder is not an error and not a config.
    #[test]
    fn a_folder_that_is_not_there_yields_nothing() {
        let root = std::env::temp_dir().join("lu-custom-models-tests").join("nope-not-here");
        let _ = std::fs::remove_dir_all(&root);
        assert!(comfy_shaped_subdirs(&root).is_empty());
        assert!(build_extra_model_paths_yaml(&root).is_none());
    }
}
