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
/// are also the folder names it uses on disk.
///
/// Two directions to keep straight, and a test for each. Every folder LU's own
/// inventory reads has to be in here, or a file the app can see would be one
/// LU never hands over (`subfolderForSource` in `src/api/comfyui.ts`). And
/// every entry here has to be a key ComfyUI really has, or the config file
/// carries a line ComfyUI ignores at best.
///
/// `clip` and `unet` are ComfyUI's older names for `text_encoders` and
/// `diffusion_models`; both are still live keys and a folder filed under the
/// old name is common. `audio_encoders` is the newer audio lane. None of the
/// three appears in `subfolderForSource`, which is why the first test can only
/// check one direction.
pub(crate) const COMFY_MODEL_FOLDERS: &[&str] = &[
    "audio_encoders",
    "checkpoints",
    "clip",
    "clip_vision",
    "controlnet",
    "diffusion_models",
    "embeddings",
    "loras",
    "style_models",
    "text_encoders",
    "unet",
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
/// SINGLE quotes, and every `'` inside the path doubled. A double-quoted YAML
/// scalar treats the backslash as an escape character, so a Windows path is not
/// a string there at all: PyYAML reads `"G:\AI\Models\loras"` as
/// `unknown escape character 'A'` and `"D:\text_encoders"` as `D:<TAB>ext_...`.
/// ComfyUI's `load_extra_path_config` runs without a try/except, so a file like
/// that does not cost the folder mapping, it costs ComfyUI: the Windows user
/// this whole fix exists for would have been left without one. A single-quoted
/// scalar has no escapes at all, which is exactly what a path needs.
///
/// A path carrying a line break or another control character is dropped instead
/// of quoted. No model folder has one, and a broken line would take the other
/// folders in the file down with it.
pub(crate) fn build_extra_model_paths_yaml(root: &Path) -> Option<String> {
    let found: Vec<(&str, PathBuf)> = comfy_shaped_subdirs(root)
        .into_iter()
        .filter(|(_, p)| !p.to_string_lossy().chars().any(|c| c.is_control()))
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
        s.push_str(&yaml_path_line(key, &path));
    }
    Some(s)
}

/// One `key: path` line. The single place the quoting rule above lives, so a
/// test can hold a literal Windows path against the SHIPPED formatting instead
/// of against a copy of it.
pub(crate) fn yaml_path_line(key: &str, path: &Path) -> String {
    format!(
        "  {}: '{}'\n",
        key,
        path.to_string_lossy().replace('\'', "''")
    )
}

/// Where the generated file lives: beside the app's own models dir, never
/// inside the user's ComfyUI folder.
pub(crate) fn extra_model_paths_file() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or("Cannot resolve app data directory")?;
    let dir = base.join(crate::app_identity::APP_DISPLAY_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Create app data dir: {}", crate::os_error::english(&e)))?;
    Ok(dir.join("lu_extra_model_paths.yaml"))
}

/// The file to pass to ComfyUI, or `None` when there is nothing to pass.
/// Called from the ComfyUI start path, so it never creates anything.
pub fn extra_model_paths_arg() -> Option<PathBuf> {
    let base = dirs::data_dir()?;
    let file = base
        .join(crate::app_identity::APP_DISPLAY_DIR)
        .join("lu_extra_model_paths.yaml");
    if file.is_file() {
        Some(file)
    } else {
        None
    }
}

/// Is this a path we can even ask the file system about?
///
/// A relative path would resolve against whatever the app's working directory
/// happens to be, and `~/models` is a shell convention the OS does not expand.
/// Both used to produce silence: no folders, no file, no word about it.
pub(crate) fn is_usable_root(root: &Path) -> bool {
    !root.as_os_str().is_empty() && root.is_absolute()
}

/// One syscall that answers "is the folder there and readable" before the
/// per-key stats run. On a dead network drive every stat blocks for the SMB
/// timeout, so asking twenty times what one call already answered is twenty
/// times the wait.
pub(crate) fn root_reachable(root: &Path) -> bool {
    std::fs::read_dir(root).is_ok()
}

/// What the folder is currently worth to ComfyUI.
pub(crate) fn folder_status(root: &Path) -> &'static str {
    if !is_usable_root(root) {
        "unusable"
    } else if !root_reachable(root) {
        "unreachable"
    } else {
        "ok"
    }
}

/// Write (or remove) the extra-model-paths file for the folder under Model
/// Storage. Idempotent, and safe to call on every settings change.
///
/// ASYNC + spawn_blocking, like `list_bundled_models`: a synchronous Tauri
/// command runs on the MAIN thread, and this one stats a path the user chose.
/// Point it at a network drive that went away and the whole window freezes
/// until the mount times out. Same pattern, same reason.
#[tauri::command]
pub async fn sync_custom_model_paths(dir: Option<String>) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || sync_custom_model_paths_blocking(dir.as_deref()))
        .await
        .map_err(|e| format!("sync_custom_model_paths task: {e}"))?
}

/// Reports what it did, so the Settings panel can name the folders it found,
/// or say why there were none, instead of claiming a success the user cannot
/// check.
pub(crate) fn sync_custom_model_paths_blocking(
    dir: Option<&str>,
) -> Result<serde_json::Value, String> {
    let file = extra_model_paths_file()?;
    // The Mac runs local media on MLX and never starts ComfyUI
    // (process::comfy_supported_here), so there is nobody to hand the folder
    // to. Say that instead of writing a file no process will ever open, and
    // clear one an earlier build may have left behind.
    if !crate::commands::process::comfy_supported_here() {
        let mut res = sync_custom_model_paths_to(&file, None)?;
        res["status"] = serde_json::json!("unsupported");
        return Ok(res);
    }
    sync_custom_model_paths_to(&file, dir)
}

/// The same work against a named file. The target is a parameter so the tests
/// write into a temp file of their own: the real one lives in the app data dir
/// and belongs to the installed app, not to a test run.
pub(crate) fn sync_custom_model_paths_to(
    file: &Path,
    dir: Option<&str>,
) -> Result<serde_json::Value, String> {
    let trimmed = dir.unwrap_or("").trim().to_string();
    let (status, folders, yaml) = if trimmed.is_empty() {
        ("off", Vec::new(), None)
    } else {
        let root = Path::new(&trimmed);
        match folder_status(root) {
            "ok" => {
                let found = comfy_shaped_subdirs(root);
                let names: Vec<String> = found.iter().map(|(k, _)| k.to_string()).collect();
                let yaml = build_extra_model_paths_yaml(root);
                // The names come from the same walk that produced the file, so
                // a folder that was dropped for an unquotable path can never be
                // reported as handed over.
                let names = if yaml.is_some() { names } else { Vec::new() };
                ("ok", names, yaml)
            }
            other => (other, Vec::new(), None),
        }
    };
    match &yaml {
        Some(text) => {
            std::fs::write(file, text)
                .map_err(|e| format!("Write model paths file: {}", crate::os_error::english(&e)))?;
        }
        None => {
            // A folder that stopped being ComfyUI-shaped, or that went away
            // with its drive, must not keep feeding ComfyUI the old paths.
            if file.exists() {
                std::fs::remove_file(file).map_err(|e| {
                    format!("Remove model paths file: {}", crate::os_error::english(&e))
                })?;
            }
        }
    }
    Ok(serde_json::json!({
        // True only when a file is on disk for ComfyUI to read. It used to be
        // derived from the folder list, which said "written" for a folder whose
        // only mappable path had been dropped.
        "written": yaml.is_some(),
        "status": status,
        "file": file.to_string_lossy(),
        "folders": folders,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("lu-custom-models-tests")
            .join(format!("{name}-{}", std::process::id()));
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

    /// The bug this file exists to avoid, held against a real YAML parser
    /// rather than against a count of quote characters.
    ///
    /// A double-quoted YAML scalar treats the backslash as an escape, so the
    /// shipped writer produced a file PyYAML refuses: `unknown escape
    /// character 'A'` for `G:\AI\...`, and a silent `D:<TAB>ext_encoders` for
    /// `D:\text_encoders`. ComfyUI reads that file without a try/except, so the
    /// Windows user this fix is for would have lost ComfyUI itself.
    #[test]
    fn a_literal_windows_path_survives_a_real_yaml_parser() {
        for raw in [
            r"G:\AI\Models",
            r"C:\Users\bob\models",
            r"D:",
            // The apostrophe is the one character a single-quoted scalar has to
            // handle, and a real folder can carry one.
            r"E:\Bob's Models",
        ] {
            let root = PathBuf::from(raw);
            // The folders are built by hand here: these paths do not exist on
            // the machine running the test, and the question is the QUOTING.
            let found = vec![
                ("loras", root.join("loras")),
                ("text_encoders", root.join("text_encoders")),
                ("vae", root.join("vae")),
            ];
            let mut yaml = String::from("lu_custom_models:\n");
            for (key, path) in &found {
                yaml.push_str(&yaml_path_line(key, path));
            }

            let parsed: serde_yaml::Value =
                serde_yaml::from_str(&yaml).unwrap_or_else(|e| panic!("{raw}: {e}\n{yaml}"));
            let block = parsed.get("lu_custom_models").expect("block missing");
            for (key, path) in &found {
                let got = block.get(*key).and_then(|v| v.as_str()).unwrap_or("");
                assert_eq!(
                    got,
                    path.to_string_lossy(),
                    "{raw}: {key} came back mangled",
                );
            }
        }
    }

    /// Negative control for the same parser: the shipped double-quoted form is
    /// genuinely broken, so the test above is not passing by accident.
    #[test]
    fn the_old_double_quoted_form_would_have_broken_comfyui() {
        let broken = "lu_custom_models:\n  loras: \"G:\\AI\\Models\\loras\"\n";
        assert!(
            serde_yaml::from_str::<serde_yaml::Value>(broken).is_err(),
            "a double-quoted Windows path must not parse: {broken}",
        );
        // And the quieter half: this one parses, into the wrong string.
        let silent = "lu_custom_models:\n  text_encoders: \"D:\\text_encoders\"\n";
        let parsed: serde_yaml::Value = serde_yaml::from_str(silent).expect("parses");
        let got = parsed["lu_custom_models"]["text_encoders"].as_str().unwrap();
        assert_ne!(got, r"D:\text_encoders");
        assert!(got.contains('\t'), "the \\t escape ate the folder name: {got:?}");
    }

    #[test]
    fn the_generated_file_parses_and_names_every_folder() {
        let root = tmp("yaml");
        std::fs::create_dir_all(root.join("loras")).unwrap();
        std::fs::create_dir_all(root.join("vae")).unwrap();
        let text = build_extra_model_paths_yaml(&root).unwrap();
        assert!(text.starts_with("# Written by Locally Uncensored"));

        let parsed: serde_yaml::Value = serde_yaml::from_str(&text).expect("must parse");
        let block = &parsed["lu_custom_models"];
        assert_eq!(block["loras"].as_str().unwrap(), root.join("loras").to_string_lossy());
        assert_eq!(block["vae"].as_str().unwrap(), root.join("vae").to_string_lossy());
    }

    /// The other direction of the drift test in
    /// `src/lib/__tests__/custom-model-dir-comfy.test.ts`, which can only prove
    /// that everything LU lists is mapped. This one pins the list against
    /// ComfyUI's own `folder_paths` keys, so a typo or an invented folder name
    /// cannot ride along into a config file ComfyUI then ignores.
    #[test]
    fn every_mapped_folder_is_a_key_comfyui_actually_has() {
        // ComfyUI folder_paths keys, as its own extra_model_paths.yaml.example
        // lists them. A copy on purpose: it is the thing being checked.
        const COMFYUI_KEYS: &[&str] = &[
            "audio_encoders", "checkpoints", "clip", "clip_vision", "configs",
            "controlnet", "diffusion_models", "embeddings", "gligen", "hypernetworks",
            "loras", "photomaker", "style_models", "text_encoders", "unet",
            "upscale_models", "vae", "vae_approx",
        ];
        for key in COMFY_MODEL_FOLDERS {
            assert!(COMFYUI_KEYS.contains(key), "{key} is not a ComfyUI folder_paths key");
        }
        // Negative control: the list is sorted and free of duplicates, so a
        // second entry for the same folder cannot write two lines for it.
        let mut sorted = COMFY_MODEL_FOLDERS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.as_slice(), COMFY_MODEL_FOLDERS);
        // And a folder that is not a model folder is not in here.
        assert!(!COMFY_MODEL_FOLDERS.contains(&"custom_nodes"));
        assert!(!COMFY_MODEL_FOLDERS.contains(&"output"));
    }

    // ── The folder the user typed, before any stat ────────────────────────

    #[test]
    fn a_relative_path_or_a_tilde_is_refused_instead_of_silently_doing_nothing() {
        assert!(!is_usable_root(Path::new("models")));
        assert!(!is_usable_root(Path::new("../models")));
        assert!(!is_usable_root(Path::new("~/models")));
        assert!(!is_usable_root(Path::new("")));
        assert_eq!(folder_status(Path::new("~/models")), "unusable");
    }

    /// Negative control: a real absolute folder is usable and reachable, so the
    /// guard above cannot be refusing everything.
    #[test]
    fn a_real_absolute_folder_passes_both_guards() {
        let root = tmp("guards");
        assert!(is_usable_root(&root));
        assert!(root_reachable(&root));
        assert_eq!(folder_status(&root), "ok");
    }

    #[test]
    fn a_folder_that_is_gone_reads_as_unreachable_not_as_empty() {
        let root = tmp("vanished");
        std::fs::remove_dir_all(&root).unwrap();
        assert!(is_usable_root(&root));
        assert!(!root_reachable(&root));
        assert_eq!(folder_status(&root), "unreachable");
    }

    // ── What the Settings panel is told ───────────────────────────────────

    #[test]
    fn the_sync_reports_the_folders_it_wrote_and_says_written_only_then() {
        let root = tmp("sync-ok");
        std::fs::create_dir_all(root.join("loras")).unwrap();
        let file = tmp("sync-ok-out").join("lu_extra_model_paths.yaml");
        let res = sync_custom_model_paths_to(&file, Some(root.to_str().unwrap())).unwrap();
        assert_eq!(res["status"], "ok");
        assert_eq!(res["written"], true);
        assert_eq!(res["folders"][0], "loras");
        let on_disk = std::fs::read_to_string(&file).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&on_disk).expect("must parse");
        assert_eq!(
            parsed["lu_custom_models"]["loras"].as_str().unwrap(),
            root.join("loras").to_string_lossy(),
        );
    }

    /// Negative control, and the bug in the first cut: a folder ComfyUI cannot
    /// use wrote no file and still reported `written: true`, and the same call
    /// has to take an older file away with it.
    #[test]
    fn a_flat_folder_writes_nothing_says_so_and_clears_an_older_file() {
        let file = tmp("sync-clear-out").join("lu_extra_model_paths.yaml");
        let good = tmp("sync-clear-good");
        std::fs::create_dir_all(good.join("vae")).unwrap();
        sync_custom_model_paths_to(&file, Some(good.to_str().unwrap())).unwrap();
        assert!(file.exists(), "precondition: a file was written");

        let flat = tmp("sync-clear-flat");
        std::fs::write(flat.join("sdxl.safetensors"), b"x").unwrap();
        let res = sync_custom_model_paths_to(&file, Some(flat.to_str().unwrap())).unwrap();
        assert_eq!(res["status"], "ok", "the folder itself is readable");
        assert_eq!(res["written"], false);
        assert_eq!(res["folders"].as_array().unwrap().len(), 0);
        assert!(!file.exists(), "the old file must not keep feeding ComfyUI");
    }

    #[test]
    fn an_unreachable_or_relative_folder_is_named_as_such_and_writes_nothing() {
        let gone = tmp("sync-gone");
        std::fs::remove_dir_all(&gone).unwrap();
        let file = tmp("sync-bad-out").join("lu_extra_model_paths.yaml");
        let res = sync_custom_model_paths_to(&file, Some(gone.to_str().unwrap())).unwrap();
        assert_eq!(res["status"], "unreachable");
        assert_eq!(res["written"], false);

        let res = sync_custom_model_paths_to(&file, Some("~/models")).unwrap();
        assert_eq!(res["status"], "unusable");
        assert_eq!(res["written"], false);

        // Negative control: no folder at all is not a fault, it is "off".
        let res = sync_custom_model_paths_to(&file, Some("   ")).unwrap();
        assert_eq!(res["status"], "off");
        assert_eq!(res["written"], false);
    }

    /// Negative control: a missing folder is not an error and not a config.
    #[test]
    fn a_folder_that_is_not_there_yields_nothing() {
        let root = std::env::temp_dir()
            .join("lu-custom-models-tests")
            .join(format!("nope-not-here-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        assert!(comfy_shaped_subdirs(&root).is_empty());
        assert!(build_extra_model_paths_yaml(&root).is_none());
    }
}
