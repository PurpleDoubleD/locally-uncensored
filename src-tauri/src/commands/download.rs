use crate::os_error;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::commands::comfy_folders;
use crate::commands::comfy_user_paths;
use crate::state::{AppState, DownloadProgress};

/// Reduce a download filename to a safe basename — no path separators, no
/// drive letter, no `..` — so a crafted `filename` (e.g. "..\\..\\Start
/// Menu\\Programs\\Startup\\x.bat") can't escape the target directory and drop
/// an autostart payload. Falls back to "download" if nothing usable remains.
pub(crate) fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !matches!(c, '/' | '\\' | ':' | '\0')).collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "download".to_string()
    } else {
        cleaned.to_string()
    }
}

/// Reject a subfolder that tries to escape the base (absolute path, drive
/// letter, or any `..` segment). Returns the subfolder unchanged when safe.
pub(crate) fn safe_subfolder(subfolder: &str) -> Result<(), String> {
    let norm = subfolder.replace('\\', "/");
    let p = std::path::Path::new(&norm);
    // `starts_with('/')` also catches Windows drive-relative roots like `/x`,
    // which `is_absolute()` does NOT treat as absolute.
    if p.is_absolute() || norm.starts_with('/') || norm.contains(':') {
        return Err("Invalid subfolder: absolute paths are not allowed".into());
    }
    if norm.split('/').any(|seg| seg == "..") {
        return Err("Invalid subfolder: path traversal is not allowed".into());
    }
    Ok(())
}

#[cfg(test)]
mod delete_message_tests {
    use super::not_ours_to_delete;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join("lu-delete-msg")
            .join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The button used to end in a flat "was not found" for a LoRA that lives
    /// in the user's own folder, which reads like a bug. LU still does not
    /// delete it: the folder is his.
    #[test]
    fn a_file_in_the_users_own_folder_is_named_as_such() {
        let root = scratch("own-folder");
        std::fs::create_dir_all(root.join("loras")).unwrap();
        std::fs::write(root.join("loras").join("pixelart.safetensors"), b"x").unwrap();

        let msg = not_ours_to_delete(
            "pixelart.safetensors",
            "pixelart.safetensors",
            &[root.to_string_lossy().to_string()],
        );
        assert!(msg.contains("your own model folder"), "{msg}");
        assert!(msg.contains(&root.join("loras").display().to_string()), "{msg}");
        assert!(msg.contains("Remove the file there"), "{msg}");

        std::fs::remove_dir_all(&root).ok();
    }

    /// Negative control: a name that is in no folder at all keeps the short
    /// answer. Blaming the custom folder for every miss would be its own lie.
    #[test]
    fn a_file_that_is_nowhere_keeps_the_short_answer() {
        let root = scratch("own-folder-empty");
        std::fs::create_dir_all(root.join("loras")).unwrap();

        let msg = not_ours_to_delete(
            "ghost.safetensors",
            "ghost.safetensors",
            &[root.to_string_lossy().to_string()],
        );
        assert_eq!(msg, "ghost.safetensors was not found in the ComfyUI models folders");

        // And with no custom folder set at all.
        let msg = not_ours_to_delete("ghost.safetensors", "ghost.safetensors", &[]);
        assert_eq!(msg, "ghost.safetensors was not found in the ComfyUI models folders");
        let msg = not_ours_to_delete("ghost.safetensors", "ghost.safetensors", &["  ".to_string()]);
        assert_eq!(msg, "ghost.safetensors was not found in the ComfyUI models folders");

        std::fs::remove_dir_all(&root).ok();
    }
}

/// The write target, held against the engine that has to find the file.
///
/// Discord help-chat 2026-09-02: FramePack F1 and Wan 2.1 both
/// downloaded through the Get button and appeared in no picker, and moving the
/// files into a different ComfyUI folder by hand fixed it. That sentence is
/// this test: the download went where LU guessed, the picker reads what the
/// running ComfyUI enumerates, and on his box those were two different trees.
#[cfg(test)]
mod model_folder_tests {
    use super::models_dir_in;
    use crate::commands::comfy_folders::ComfyFolders;
    use serde_json::json;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("lu-model-folders")
            .join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The shape of the report: `main.py` in the program folder, the models
    /// under the base directory the desktop app starts ComfyUI with.
    #[test]
    fn the_download_follows_the_engine_and_not_our_guess() {
        let root = scratch("base-directory");
        let program = root.join("Programs").join("ComfyUI").join("resources").join("ComfyUI");
        let base = root.join("Documents").join("ComfyUI");
        let engine_dir = base.join("models").join("diffusion_models");
        let folders = ComfyFolders::parse(&json!({
            "diffusion_models": [
                base.join("models").join("unet").to_string_lossy(),
                engine_dir.to_string_lossy(),
            ],
        }));

        let dest = models_dir_in(
            Some(&folders),
            &Some(program.to_string_lossy().to_string()),
            "diffusion_models",
        )
        .unwrap();

        // Where FramePackI2V_HY_fp8_e4m3fn.safetensors and
        // wan2.1_t2v_1.3B_bf16.safetensors have to land to be offered.
        assert_eq!(dest, engine_dir);
        assert!(dest.is_dir());
        // And NOT where the old rule put them, which is the folder he had to
        // move them out of.
        assert_ne!(dest, program.join("models").join("diffusion_models"));

        std::fs::remove_dir_all(&root).ok();
    }

    /// No engine to ask (the Model Manager downloads with ComfyUI shut down all
    /// the time) keeps the rule that has always been there.
    #[test]
    fn without_an_answer_the_old_rule_stands() {
        let root = scratch("no-engine");
        let dest = models_dir_in(None, &Some(root.to_string_lossy().to_string()), "checkpoints").unwrap();
        assert_eq!(dest, root.join("models").join("checkpoints"));

        // An engine that answers about other folders says nothing about this
        // one, and inventing a folder from a key it does not have would be the
        // same guess in a new place.
        let folders = ComfyFolders::parse(&json!({"vae": ["/srv/ai/vae"]}));
        let dest = models_dir_in(Some(&folders), &Some(root.to_string_lossy().to_string()), "checkpoints").unwrap();
        assert_eq!(dest, root.join("models").join("checkpoints"));

        std::fs::remove_dir_all(&root).ok();
    }

    /// A pack folder is not a ComfyUI folder key. It stays relative to the
    /// ComfyUI root, where the pack itself is.
    #[test]
    fn a_pack_folder_stays_under_the_comfyui_root() {
        let root = scratch("pack-folder");
        let folders = ComfyFolders::parse(&json!({
            "diffusion_models": ["/srv/ai/models/diffusion_models"]
        }));
        let dest = models_dir_in(
            Some(&folders),
            &Some(root.to_string_lossy().to_string()),
            "custom_nodes/ComfyUI-AnimateDiff-Evolved/models",
        )
        .unwrap();
        assert_eq!(dest, root.join("custom_nodes/ComfyUI-AnimateDiff-Evolved/models"));

        std::fs::remove_dir_all(&root).ok();
    }

    /// GH #143: a ComfyUI on another machine. Which hosts are this machine,
    /// and where its files go instead: the storage folder, ComfyUI's layout.
    #[test]
    fn a_remote_comfyui_gets_its_files_in_comfyui_layout_here() {
        for local in ["", "localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "127.0.0.2", " LOCALHOST "] {
            assert!(super::host_is_this_machine(local), "{local}");
        }
        for remote in ["192.168.1.20", "comfy.lan", "10.0.0.5", "ai-box"] {
            assert!(!super::host_is_this_machine(remote), "{remote}");
        }

        let root = scratch("remote-root");
        let dest = super::remote_models_dir(&root, "loras").unwrap();
        assert_eq!(dest, root.join("loras"));
        assert!(dest.is_dir());
        let pack = super::remote_models_dir(&root, "custom_nodes/ComfyUI-AnimateDiff-Evolved/models").unwrap();
        assert_eq!(pack, root.join("custom_nodes/ComfyUI-AnimateDiff-Evolved/models"));
        for bad in ["../../etc", "a/../../b", "/abs/path", "C:/x"] {
            assert!(super::remote_models_dir(&root, bad).is_err(), "{bad}");
        }
        std::fs::remove_dir_all(&root).ok();
    }

    /// GH #183: a shared folder in `extra_model_paths.yaml` is where the
    /// download goes, with ComfyUI shut down and with ComfyUI running (whose
    /// answer lists the instance folder of the same name first).
    #[test]
    fn the_configured_shared_folder_wins_over_the_instance() {
        let root = scratch("issue-183");
        let comfy = root.join("Comfy").join("ComfyUI");
        let shared = root.join("model");
        std::fs::create_dir_all(&comfy).unwrap();
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::write(
            comfy.join("extra_model_paths.yaml"),
            format!("# mine\ncomfyui:\n  base_path: '{}'\n  loras: loras/\n  checkpoints: checkpoints/\n", shared.display()),
        )
        .unwrap();
        let cp = Some(comfy.to_string_lossy().to_string());

        let dest = models_dir_in(None, &cp, "loras").unwrap();
        assert_eq!(dest, shared.join("loras"));
        assert!(dest.is_dir());

        let engine = ComfyFolders::parse(&json!({
            "loras": [comfy.join("models").join("loras").to_string_lossy(), shared.join("loras").to_string_lossy()],
        }));
        assert_eq!(models_dir_in(Some(&engine), &cp, "loras").unwrap(), shared.join("loras"));
        // A key the user did not configure keeps the old rule.
        assert_eq!(models_dir_in(None, &cp, "vae").unwrap(), comfy.join("models").join("vae"));
        // A pack folder is never redirected.
        assert_eq!(
            models_dir_in(None, &cp, "custom_nodes/x/models").unwrap(),
            comfy.join("custom_nodes/x/models"),
        );

        // A LoRA downloaded before this fix is still found in the instance.
        std::fs::create_dir_all(comfy.join("models").join("loras")).unwrap();
        std::fs::write(comfy.join("models").join("loras").join("old.safetensors"), b"x").unwrap();
        let user = crate::commands::comfy_user_paths::for_comfy(&cp);
        assert_eq!(
            super::existing_elsewhere(&user, None, &cp, "loras", "old.safetensors"),
            Some(comfy.join("models").join("loras").join("old.safetensors")),
        );
        // Neither the name nor the folder may climb out.
        assert_eq!(super::existing_elsewhere(&user, None, &cp, "loras", "../../old.safetensors"), None);
        assert_eq!(super::existing_elsewhere(&user, None, &cp, "../loras", "old.safetensors"), None);

        // A broken file costs only itself.
        std::fs::write(comfy.join("extra_model_paths.yaml"), "comfyui:\n  base_path: \"D:\\comfy\"\n").unwrap();
        assert_eq!(models_dir_in(None, &cp, "loras").unwrap(), comfy.join("models").join("loras"));

        std::fs::remove_dir_all(&root).ok();
    }

    /// The jail is unchanged, and it runs BEFORE anything the engine said.
    #[test]
    fn an_escaping_subfolder_is_still_refused() {
        let folders = ComfyFolders::parse(&json!({"checkpoints": ["/srv/ai/models/checkpoints"]}));
        for bad in ["../../etc", "a/../../b", "/abs/path", "C:/x"] {
            assert!(
                models_dir_in(Some(&folders), &Some("/tmp/comfy".to_string()), bad).is_err(),
                "{bad}",
            );
        }
    }

    /// Checking whether a model file is there creates none of its folders.
    #[test]
    fn checking_for_a_model_creates_no_folder() {
        use super::{check_one_file, CheckFileRequest};
        use crate::commands::comfy_user_paths::{Env, UserComfyPaths};
        let ask = |subfolder: &str, filename: &str, expected_bytes: u64| CheckFileRequest {
            subfolder: subfolder.to_string(),
            filename: filename.to_string(),
            expected_bytes,
        };
        let root = scratch("look-only");
        let comfy = root.join("ComfyUI");
        let shared = root.join("shared");
        std::fs::create_dir_all(&comfy).unwrap();
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::write(
            comfy.join("extra_model_paths.yaml"),
            format!("comfyui:\n  base_path: '{}'\n  loras: loras/\n", shared.display()),
        )
        .unwrap();
        let cp = Some(comfy.to_string_lossy().to_string());
        let env = Env { home: None, appdata: None, localappdata: None, var: Box::new(|_| None) };
        let user = UserComfyPaths::discover_with(&comfy, &env);
        let engine_dir = root.join("engine").join("checkpoints");
        let engine = ComfyFolders::parse(&json!({"checkpoints": [engine_dir.to_string_lossy()]}));
        let remote = root.join("remote");
        std::fs::create_dir_all(&remote).unwrap();

        // Every way a folder is resolved, asked about a file that is not there.
        let pack = "custom_nodes/ComfyUI-AnimateDiff-Evolved/models";
        for (subfolder, folders, remote_root, made) in [
            (pack, None, None, comfy.join(pack)),
            ("vae", None, None, comfy.join("models").join("vae")),
            ("loras", None, None, shared.join("loras")),
            ("checkpoints", Some(&engine), None, engine_dir.clone()),
            ("loras", None, Some(remote.as_path()), remote.join("loras")),
            (pack, None, Some(remote.as_path()), remote.join(pack)),
        ] {
            let r = check_one_file(&ask(subfolder, "missing.safetensors", 0), remote_root, &user, folders, &cp);
            assert!(!r.exists, "{subfolder}");
            assert!(!made.exists(), "the check created {}", made.display());
        }
        assert!(!comfy.join("custom_nodes").exists(), "the check created custom_nodes");
        assert!(!comfy.join("models").exists(), "the check created models");
        assert!(!root.join("engine").exists(), "the check created the engine folder");

        // POSITIVE CONTROL: a file that is there is still found, with its bytes.
        for (subfolder, remote_root, dir) in [
            (pack, None, comfy.join(pack)),
            ("vae", None, comfy.join("models").join("vae")),
            ("loras", None, shared.join("loras")),
            ("loras", Some(remote.as_path()), remote.join("loras")),
        ] {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("there.safetensors"), b"12345").unwrap();
            let r = check_one_file(&ask(subfolder, "there.safetensors", 8), remote_root, &user, None, &cp);
            assert!(r.exists, "{subfolder} in {}", dir.display());
            assert_eq!(r.actual_bytes, 5, "{subfolder}");
            assert!(r.complete, "{subfolder}");
        }
        std::fs::create_dir_all(&engine_dir).unwrap();
        std::fs::write(engine_dir.join("there.safetensors"), b"1").unwrap();
        let r = check_one_file(&ask("checkpoints", "there.safetensors", 0), None, &user, Some(&engine), &cp);
        assert!(r.exists && r.actual_bytes == 1);

        // NEGATIVE CONTROL: a refused subfolder is still refused, and makes nothing.
        let r = check_one_file(&ask("../escape", "there.safetensors", 0), None, &user, None, &cp);
        assert!(!r.exists);
        assert!(!root.join("escape").exists());

        // Check files and Repair resolve their file the same look-only way.
        let src = include_str!("download.rs");
        let verify = &src[src.find(concat!("pub(crate) async fn model_", "file_path(")).expect("model_file_path exists")..];
        let verify = &verify[..verify.find("\n}\n").expect("the function ends")];
        assert!(verify.contains("comfy_models_path(state"), "{verify}");
        assert!(!verify.contains("comfy_models_dir("), "{verify}");

        std::fs::remove_dir_all(&root).ok();
    }
}

#[cfg(test)]
mod civitai_auth_tests {
    use super::{download_http_error, http_error_message, is_civitai_host};

    #[test]
    fn the_key_goes_to_civitai_and_its_mirror_and_nowhere_else() {
        assert!(is_civitai_host("https://civitai.com/api/download/models/12345"));
        assert!(is_civitai_host("https://CIVITAI.COM/api/download/models/1"));
        // GH #53: the mirror LU offers where .com is blocked.
        assert!(is_civitai_host("https://civitai.red/api/download/models/1"));
        assert!(is_civitai_host("https://api.civitai.com/v1/x"));
    }

    /// Negative control, and the reason the check is on the HOST: a URL that
    /// merely mentions civitai must never collect the user's API key.
    #[test]
    fn a_url_that_only_mentions_civitai_gets_no_key() {
        assert!(!is_civitai_host("https://evil.test/?x=civitai.com"));
        assert!(!is_civitai_host("https://civitai.com.evil.test/file"));
        assert!(!is_civitai_host("https://notcivitai.com/file"));
        assert!(!is_civitai_host("https://huggingface.co/repo/resolve/main/m.safetensors"));
        // A userinfo prefix is not a host either.
        assert!(!is_civitai_host("https://civitai.com@evil.test/file"));
        assert!(!is_civitai_host("not a url"));
    }

    /// The backslash forms the hand written parser got wrong.
    ///
    /// In a special scheme the backslash ends the authority. The old check
    /// split the string by hand and disagreed with the transport in BOTH
    /// directions: `https://evil.test\.civitai.com/x` goes to `evil.test` and
    /// was called CivitAI, so the Bearer token would have ridden along, and
    /// `https://civitai.com\@evil.test/x` goes to `civitai.com` and was called
    /// something else. The frontend gates on `new URL()` too, so the app could
    /// not produce the first one, but a second gate that disagrees with the
    /// transport is not a gate.
    ///
    /// The property is the agreement itself: the check answers what the
    /// request will actually do, because it asks the same parser.
    #[test]
    fn the_check_agrees_with_the_host_the_request_will_reach() {
        for u in [
            "https://evil.test\\.civitai.com/x",
            "https://civitai.com\\@evil.test/x",
            "https://civitai.com\\.evil.test/x",
            "https://civitai.com/api/download/models/1",
            "https://evil.test/?x=civitai.com",
        ] {
            let host = url::Url::parse(u).unwrap().host_str().unwrap().to_ascii_lowercase();
            let reaches_civitai = host == "civitai.com"
                || host == "civitai.red"
                || host.ends_with(".civitai.com")
                || host.ends_with(".civitai.red");
            assert_eq!(
                is_civitai_host(u),
                reaches_civitai,
                "{u} really goes to {host}",
            );
        }
    }

    /// Negative control for the one that matters: the smuggling form must be
    /// refused, not merely "agree".
    #[test]
    fn a_backslash_cannot_send_the_key_to_another_host() {
        assert!(!is_civitai_host("https://evil.test\\.civitai.com/x"));
        assert_eq!(
            url::Url::parse("https://evil.test\\.civitai.com/x")
                .unwrap()
                .host_str()
                .unwrap(),
            "evil.test",
            "precondition: this URL really does reach evil.test",
        );
    }

    /// The request as it goes out, not as we hope it goes out.
    ///
    /// Built exactly the way `do_download` builds it and read back off the
    /// finished request, because the half that was missing in the report was
    /// never the store or the field: it was whether anything put the key on the
    /// wire. No network: `build()` hands back the request without sending it.
    #[test]
    fn the_key_is_on_the_wire_as_a_bearer_header_and_only_for_civitai() {
        use super::outgoing_token;
        const KEY: &str = "civitai-key-abcdef";
        let build = |url: &str, key: Option<&str>| {
            let client = reqwest::Client::new();
            let mut req = client.get(url);
            if let Some(t) = outgoing_token(url, key, None) {
                req = req.bearer_auth(t);
            }
            req.build().unwrap()
        };

        let civitai = build("https://civitai.com/api/download/models/128713", Some(KEY));
        assert_eq!(
            civitai.headers().get("authorization").map(|v| v.to_str().unwrap()),
            Some(format!("Bearer {KEY}").as_str()),
        );
        // The key is on the header and NOT in the address: the address is what
        // a log line and an error message quote.
        assert!(!civitai.url().as_str().contains(KEY), "{}", civitai.url());
        assert!(!civitai.url().as_str().contains("token="), "{}", civitai.url());

        // No key stored: the same download goes out anonymous, as it always did.
        let anonymous = build("https://civitai.com/api/download/models/128713", None);
        assert!(anonymous.headers().get("authorization").is_none());
        let blank = build("https://civitai.com/api/download/models/128713", Some("   "));
        assert!(blank.headers().get("authorization").is_none());

        // Negative control: every other catalog address carries nothing, even
        // with a key stored. This is the rule the whole host gate exists for.
        let hf = build("https://huggingface.co/TheDrummer/Cydonia/resolve/main/m.gguf", Some(KEY));
        assert!(hf.headers().get("authorization").is_none());
        let smuggled = build("https://evil.test\\.civitai.com/x", Some(KEY));
        assert!(smuggled.headers().get("authorization").is_none());
    }

    /// The hub token takes the same route to its own host and to no other.
    #[test]
    fn the_hub_token_is_host_gated_the_same_way() {
        use super::outgoing_token;
        assert_eq!(
            outgoing_token("https://huggingface.co/a/b/resolve/main/m.gguf", None, Some("hf_x")),
            Some("hf_x".to_string()),
        );
        // A CivitAI URL never carries the hub token, even when one is stored.
        assert_eq!(
            outgoing_token("https://civitai.com/api/download/models/1", None, Some("hf_x")),
            None,
        );
        assert_eq!(outgoing_token("https://example.test/m.gguf", Some("k"), Some("hf_x")), None);
    }

    /// The hub answers a `resolve` address with a redirect to a storage host
    /// whose address is already signed. v3.0.5 let reqwest follow it, and
    /// reqwest drops `Authorization` on every change of host. The redirects
    /// followed by hand have to do the same: a sub-domain of the hub is
    /// another host and gets no token.
    #[test]
    fn the_hub_token_does_not_follow_a_redirect_to_another_host() {
        use super::{key_stays_on_hop, RidingKey};
        let first = "https://huggingface.co/org/repo/resolve/main/m.gguf";
        let key = RidingKey::new(first, Some("hf_x".to_string()));
        assert_eq!(key.for_hop(first), Some("hf_x"));
        // A relative redirect on the hub itself keeps it.
        assert_eq!(key.for_hop("https://huggingface.co/api/resolve-cache/models/org/repo/abc/m.gguf"), Some("hf_x"));
        assert_eq!(key.for_hop("https://HuggingFace.co/x"), Some("hf_x"));
        // The signed storage hosts, old and new, get nothing.
        for hop in [
            "https://cdn-lfs.huggingface.co/repos/ab/cd/ef?X-Amz-Signature=1",
            "https://cdn-lfs-us-1.huggingface.co/repos/ab/cd/ef?Signature=1",
            "https://cas-bridge.xethub.hf.co/xet-bridge-us/abc?X-Amz-Signature=1",
            "https://evil.test/m.gguf",
        ] {
            let key = RidingKey::new(first, Some("hf_x".to_string()));
            assert_eq!(key.for_hop(first), Some("hf_x"));
            assert_eq!(key.for_hop(hop), None, "{hop}");
            // Asked again for the same hop (a retried connection): still nothing.
            assert_eq!(key.for_hop(hop), None, "{hop}");
            // Gone for the rest of the chain, also on the way back.
            assert_eq!(key.for_hop(first), None, "back from {hop}");
        }
        // Another port is another server, and https never steps down.
        assert!(!key_stays_on_hop("https://huggingface.co/a", "https://huggingface.co:8443/a"));
        assert!(!key_stays_on_hop("https://huggingface.co/a", "http://huggingface.co/a"));
        assert!(key_stays_on_hop("https://huggingface.co/a", "https://huggingface.co:443/b"));
        assert!(!key_stays_on_hop("not a url", "https://huggingface.co/a"));
        assert!(!key_stays_on_hop("https://huggingface.co/a", "not a url"));
        // The same rule for the CivitAI key.
        let civitai = RidingKey::new("https://civitai.com/api/download/models/1", Some("k".to_string()));
        assert_eq!(civitai.for_hop("https://civitai.com/api/download/models/1"), Some("k"));
        assert_eq!(civitai.for_hop("https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/m?sig=1"), None);
        // No token stored: nothing rides anywhere.
        assert_eq!(RidingKey::new(first, None).for_hop(first), None);
    }

    #[test]
    fn a_refused_civitai_download_names_the_field_instead_of_a_bare_number() {
        // A user, 2026-08-28: the download died on a bare HTTP 400 and
        // the field it was asking for was not in the interface at all.
        for status in [400u16, 401, 403] {
            let msg = download_http_error(
                "https://civitai.com/api/download/models/1",
                status,
                false,
                "pony.safetensors",
            );
            assert!(msg.contains(&format!("HTTP {status}")), "{msg}");
            assert!(msg.contains("API key"), "{msg}");
            assert!(msg.contains("Settings > AI Backends > CivitAI API key"), "{msg}");
            // A key the user can go and add is not a dead address: the
            // `(HTTP nnn)` shape would hide the Retry button he needs.
            assert!(!msg.contains(&format!("(HTTP {status})")), "{msg}");
        }
    }

    #[test]
    fn a_key_that_was_sent_and_refused_says_so() {
        let msg = download_http_error(
            "https://civitai.com/api/download/models/1",
            401,
            true,
            "pony.safetensors",
        );
        assert!(msg.contains("was sent and rejected"), "{msg}");
        // and does NOT tell the user to add a key he already has.
        assert!(!msg.contains("Add one under"), "{msg}");
    }

    /// Negative control: every other host and every other status is answered
    /// by `http_error_message` word for word. A dead HuggingFace link must not
    /// send people to the CivitAI setting.
    /// A gated hub repo is a missing credential, not a dead address.
    /// OrcaRouter's own GGUF repo answers 401 to everyone without a token
    /// (measured 2026-09-05); the old text said "trying again cannot help".
    #[test]
    fn a_refused_huggingface_download_names_the_token_field_and_keeps_retry() {
        for status in [401u16, 403] {
            let msg = download_http_error(
                "https://huggingface.co/orcarouter/Qwen3.8-27B-Uncensored-GGUF/resolve/main/m.gguf",
                status,
                false,
                "m.gguf",
            );
            assert!(msg.contains(&format!("HTTP {status}")), "{msg}");
            assert!(msg.contains("Settings > AI Backends > Hugging Face token"), "{msg}");
            assert!(msg.contains("accept its licence"), "{msg}");
            assert!(!msg.contains(&format!("(HTTP {status})")), "{msg}");
            assert!(!msg.contains("cannot help"), "{msg}");
        }
        let sent = download_http_error("https://hf.co/x/y/resolve/main/m.gguf", 401, true, "m.gguf");
        assert!(sent.contains("was sent and rejected"), "{sent}");
        assert!(!sent.contains("add a Hugging Face token"), "{sent}");
        // A 404 on the hub is still a dead address, brackets and all.
        let gone = download_http_error("https://huggingface.co/x/y/resolve/main/m.gguf", 404, false, "m.gguf");
        assert_eq!(gone, http_error_message(404, "m.gguf"));
    }

    #[test]
    fn the_hub_host_rule_is_as_strict_as_the_civitai_one() {
        assert!(super::is_huggingface_host("https://huggingface.co/a/b/resolve/main/m.gguf"));
        assert!(super::is_huggingface_host("https://HF.co/a/b/resolve/main/m.gguf"));
        assert!(super::is_huggingface_host("https://cdn-lfs.huggingface.co/x"));
        assert!(!super::is_huggingface_host("https://huggingface.co.evil.test/x"));
        assert!(!super::is_huggingface_host("https://evil.test/huggingface.co/x"));
        // The backslash ends the host in a special scheme: reqwest talks to
        // evil.test here, so the token must not go out.
        assert!(!super::is_huggingface_host("https://evil.test\\.huggingface.co/x"));
        assert!(!super::is_huggingface_host("not a url"));
    }

    #[test]
    fn other_hosts_and_other_statuses_get_no_civitai_hint() {
        for (url, status, sent) in [
            ("https://huggingface.co/repo/resolve/main/m.gguf", 404u16, false),
            ("https://example.test/repo/m.gguf", 401, false),
            ("https://civitai.com/api/download/models/1", 404, false),
            ("https://civitai.com/api/download/models/1", 500, true),
        ] {
            let msg = download_http_error(url, status, sent, "m.gguf");
            assert_eq!(msg, http_error_message(status, "m.gguf"), "{msg}");
            assert!(!msg.contains("API key"), "{msg}");
            assert!(!msg.contains("Settings >"), "{msg}");
        }
    }
}

#[cfg(test)]
mod download_security_tests {
    use super::{checked_model_path, safe_subfolder, sanitize_filename};
    use std::path::PathBuf;

    #[test]
    fn sanitize_strips_traversal_and_separators() {
        assert_eq!(sanitize_filename("model.safetensors"), "model.safetensors");
        assert_eq!(sanitize_filename("..\\..\\Startup\\x.bat"), "x.bat");
        assert_eq!(sanitize_filename("a/b/c/evil.exe"), "evil.exe");
        assert_eq!(sanitize_filename("C:evil.dll"), "Cevil.dll"); // colon stripped
        assert_eq!(sanitize_filename(".."), "download");
        assert_eq!(sanitize_filename(""), "download");
    }

    #[test]
    fn safe_subfolder_rejects_escapes() {
        assert!(safe_subfolder("checkpoints").is_ok());
        assert!(safe_subfolder("custom_nodes/foo").is_ok());
        assert!(safe_subfolder("../../etc").is_err());
        assert!(safe_subfolder("a/../../b").is_err());
        assert!(safe_subfolder("/abs/path").is_err());
        assert!(safe_subfolder("C:/x").is_err());
    }

    #[test]
    fn split_model_ref_handles_nested_and_plain_names() {
        assert_eq!(super::split_model_ref("model.safetensors"), (String::new(), "model.safetensors".into()));
        assert_eq!(super::split_model_ref("wan/model.gguf"), ("wan".into(), "model.gguf".into()));
        assert_eq!(super::split_model_ref("a\\b\\m.pt"), ("a/b".into(), "m.pt".into()));
        // Traversal segments survive the split and then die in safe_subfolder.
        let (dir, _) = super::split_model_ref("../../evil.bin");
        assert!(safe_subfolder(&dir).is_err());
    }

    /// The size probe reads names that come straight from a ComfyUI answer.
    /// A hostile ComfyUI must never be able to point it at a path outside the
    /// models folder, because exists() plus metadata().len() would hand it an
    /// existence and size oracle for the whole machine.
    #[test]
    fn check_path_never_escapes_dest_dir() {
        let dest = PathBuf::from("/comfy/models/embeddings");

        // Honest names keep working, nested ComfyUI enum names included.
        assert_eq!(
            checked_model_path(&dest, "pony.safetensors").unwrap(),
            dest.join("pony.safetensors")
        );
        assert_eq!(
            checked_model_path(&dest, "sdxl/pony.safetensors").unwrap(),
            dest.join("sdxl").join("pony.safetensors")
        );

        // Hostile names are either refused outright or land inside dest_dir,
        // never anywhere else.
        let hostile = [
            "/etc/passwd",
            "/Users/victim/.ssh/id_ed25519",
            "C:\\Windows\\win.ini",
            "..\\..\\..\\Windows\\win.ini",
            "../../../../etc/shadow",
            "..",
        ];
        for name in hostile {
            if let Some(p) = checked_model_path(&dest, name) {
                assert!(
                    p.starts_with(&dest),
                    "escaped dest_dir: {} resolved to {}",
                    name,
                    p.display()
                );
            }
        }
    }
}

/// Split a ComfyUI enum name ("wan/x.safetensors" or plain "x.safetensors")
/// into its relative dir + basename so both halves can go through the same
/// jail checks the downloader uses.
pub(crate) fn split_model_ref(name: &str) -> (String, String) {
    let norm = name.replace('\\', "/");
    match norm.rsplit_once('/') {
        Some((dir, base)) => (dir.to_string(), base.to_string()),
        None => (String::new(), norm),
    }
}

/// The model subdirs LU downloads into / ComfyUI enumerates from. Delete
/// searches exactly these — never custom_nodes, never arbitrary paths.
/// embeddings and style_models joined on 2026-08-30, with the five folders the
/// R5 re-measure found missing from the inventory. A file the Installed list
/// names has to be deletable from that same list, or the list is a wall.
const MODEL_SUBDIRS: &[&str] = &[
    "checkpoints", "diffusion_models", "unet", "vae", "loras",
    "text_encoders", "clip", "clip_vision", "audio_encoders",
    "controlnet", "upscale_models", "embeddings", "style_models",
    // LTX 2.5's x2 latent upscaler (LatentUpscaleModelLoader reads this folder).
    "latent_upscale_models",
];

/// Why a file ComfyUI listed is not in the ComfyUI models tree.
///
/// Two different answers, and the difference is the whole point: a file in the
/// user's own folder is there because he put it there, and LU deleting out of
/// a folder it does not own would be worse than the button not working.
pub(crate) fn not_ours_to_delete(filename: &str, base: &str, extra_dirs: &[String]) -> String {
    for raw in extra_dirs {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let root = Path::new(trimmed);
        for (_, folder) in crate::commands::custom_models::comfy_shaped_subdirs(root) {
            if folder.join(base).is_file() {
                return format!(
                    "{} sits in your own model folder ({}). LU does not delete from a folder you keep yourself. Remove the file there and it disappears from this list.",
                    filename,
                    folder.display(),
                );
            }
        }
    }
    format!("{} was not found in the ComfyUI models folders", filename)
}

/// Every copy of one ComfyUI model file in the folders LU downloads into and
/// ComfyUI enumerates from. Delete and Details look a file up the same way,
/// so the two buttons beside a row can never disagree about which file it is.
async fn comfy_model_hits(
    state: &State<'_, AppState>,
    comfy_path: &str,
    sub: &str,
    base: &str,
) -> Vec<PathBuf> {
    let models_root = PathBuf::from(comfy_path).join("models");
    // Both trees, because the download may have written into either: the
    // engine's own folders when it was running and could be asked, the classic
    // guess when it could not (see models_dir_in). A file the app put there is
    // a file the app has to be able to take away again.
    //
    // R1-4: asked fresh via engine_folders (a running ComfyUI's own answer),
    // not the stale process-wide cache from before this ComfyUI ever
    // started, a model the running engine had just remapped to a custom
    // folder looked like a foreign file and refused to delete.
    let mut roots: Vec<PathBuf> = MODEL_SUBDIRS.iter().map(|d| models_root.join(d)).collect();
    if let Some(folders) = engine_folders(state).await {
        for dir in folders.all_dirs() {
            if !roots.contains(&dir) {
                roots.push(dir);
            }
        }
    }
    // GH #183: the folders the user configured for ComfyUI, where a download
    // writes now even while ComfyUI is shut down.
    for dir in comfy_user_paths::for_comfy(&Some(comfy_path.to_string())).all_dirs() {
        if !roots.contains(&dir) {
            roots.push(dir);
        }
    }
    let mut hits: Vec<PathBuf> = Vec::new();
    for root in &roots {
        let cand = if sub.is_empty() {
            root.join(base)
        } else {
            root.join(sub).join(base)
        };
        if cand.is_file() && !hits.contains(&cand) {
            hits.push(cand);
        }
    }
    hits
}

/// Delete one installed model file from the ComfyUI models tree (the Model
/// Hub's trash action — Discord 2026-07-19: a 27 GB video
/// model his PC couldn't run had no in-app way back out). The name is the
/// ComfyUI enum entry; we jail-check it and look for the single file match
/// across the known model subdirs.
///
/// `extraDirs` is the folder the user named under Storage. LU tells
/// ComfyUI about the ComfyUI-shaped subfolders in it (GH #122), so ComfyUI now
/// lists files that are NOT ours to delete. It stays that way on purpose: a
/// folder the user keeps by hand is his. The button used to end in a flat
/// "was not found", which reads like a bug; it names the folder now and says
/// the file has to go from there.
#[allow(non_snake_case)]
#[tauri::command]
pub async fn delete_comfy_model(
    filename: String,
    extraDirs: Option<Vec<String>>,
    trash: Option<bool>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    if let Some(remote) = remote_comfy(&state) {
        return Err(format!(
            "{} is on the ComfyUI machine ({}), and LU cannot delete files there. Remove it from the models folder of ComfyUI on that machine.",
            filename, remote.host
        ));
    }
    let comfy_path = state
        .comfy_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("ComfyUI path not set. Please set it in settings or install ComfyUI first.")?;
    let (sub, base) = split_model_ref(&filename);
    if !sub.is_empty() {
        safe_subfolder(&sub)?;
    }
    let base = sanitize_filename(&base);
    let hits = comfy_model_hits(&state, &comfy_path, &sub, &base).await;
    match hits.len() {
        0 => Err(not_ours_to_delete(
            &filename,
            &base,
            &extraDirs.unwrap_or_default(),
        )),
        1 => {
            let f = &hits[0];
            let bytes = fs::metadata(f).map(|m| m.len()).unwrap_or(0);
            if trash.unwrap_or(false) {
                let file = f.clone();
                let name = base.clone();
                return tauri::async_runtime::spawn_blocking(move || {
                    to_the_bin(&file, &name, bytes, crate::commands::os_trash::system_trash)
                })
                .await
                .map_err(|e| e.to_string())?;
            }
            fs::remove_file(f).map_err(|e| format!("Delete failed: {}", os_error::english(&e)))?;
            // Sweep a stale resume-partial next to it (the timeout/abort case
            // leaves both the file and its .download twin behind).
            let _ = fs::remove_file(f.with_extension("download"));
            println!("[Models] Deleted {} ({} bytes)", f.display(), bytes);
            Ok(serde_json::json!({"status": "deleted", "bytes": bytes}))
        }
        _ => Err(format!(
            "{} exists in more than one models folder — remove it from the ComfyUI folder itself so the right copy goes",
            filename
        )),
    }
}

/// Details for one ComfyUI model file (D1, a user on Discord,
/// 01.11.2026: the ⓘ beside the bin did nothing for an image model or a
/// LoRA, because it asked Ollama, which knows no ComfyUI file). Found the
/// way Delete finds it; a file in the user's own Storage folder is shown
/// too, since reading is not deleting. Never a path outside those folders.
#[allow(non_snake_case)]
#[tauri::command]
pub async fn comfy_model_info(
    filename: String,
    extraDirs: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    if let Some(remote) = remote_comfy(&state) {
        return Err(format!(
            "{} is on the ComfyUI machine ({}). LU cannot read files there.",
            filename, remote.host
        ));
    }
    let comfy_path = state
        .comfy_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("ComfyUI path not set. Please set it in settings or install ComfyUI first.")?;
    let (sub, base) = split_model_ref(&filename);
    if !sub.is_empty() {
        safe_subfolder(&sub)?;
    }
    let base = sanitize_filename(&base);
    let mut hits = comfy_model_hits(&state, &comfy_path, &sub, &base).await;
    let mut own_folder = false;
    if hits.is_empty() {
        hits = own_folder_hits(&base, &extraDirs.unwrap_or_default());
        own_folder = !hits.is_empty();
    }
    let file = hits
        .first()
        .ok_or_else(|| format!("{} was not found in the ComfyUI models folders", filename))?;
    Ok(file_facts(file, own_folder, hits.len()))
}

/// A file of that name in the user's own model folder (Storage), the place
/// `not_ours_to_delete` names.
fn own_folder_hits(base: &str, extra_dirs: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for raw in extra_dirs {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        for (_, folder) in crate::commands::custom_models::comfy_shaped_subdirs(Path::new(trimmed)) {
            let cand = folder.join(base);
            if cand.is_file() && !out.contains(&cand) {
                out.push(cand);
            }
        }
    }
    out
}

/// What the Details dialog shows about a file on disk.
fn file_facts(file: &Path, own_folder: bool, copies: usize) -> serde_json::Value {
    let meta = fs::metadata(file).ok();
    let modified = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    serde_json::json!({
        "path": file.to_string_lossy(),
        "folder": file.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        "bytes": meta.map(|m| m.len()).unwrap_or(0),
        "modified": modified,
        "ownFolder": own_folder,
        "copies": copies,
    })
}

/// The delete with `trash`: the file goes to the system's Trash and can be
/// put back from there. A trained character is the user's own work and hours
/// of training, so its delete on the Create page takes this way, the same one
/// the gallery and the Mac's LoRA folder take. Where the Trash refuses, the
/// file stays and the answer says why.
fn to_the_bin(
    file: &Path,
    name: &str,
    bytes: u64,
    bin: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<serde_json::Value, String> {
    let bin_name = if cfg!(windows) { "Recycle Bin" } else { "Trash" };
    bin(file).map_err(|e| format!("Could not move {} to the {}: {}", name, bin_name, e))?;
    println!("[Models] Moved {} to the {} ({} bytes)", file.display(), bin_name, bytes);
    Ok(serde_json::json!({"status": "trashed", "bytes": bytes}))
}

/// Where a file of `subfolder` goes, and where every other path in this module
/// looks for it afterwards. THE definition, which is the whole point: the
/// download, the size probe, the space check and the delete all come through
/// here, so they cannot end up in different trees.
///
/// `folders` is what the RUNNING ComfyUI says about its own model folders
/// (see commands/comfy_folders.rs). It wins whenever it has an answer, because
/// the picker is built from that same process: a file written anywhere else is
/// a file no picker can ever offer (2026-09-02: FramePack F1 and
/// Wan 2.1 downloaded fine and showed up nowhere until he moved them into the
/// other ComfyUI folder by hand).
///
/// The old rule stays underneath for the two cases where there is nothing
/// better: ComfyUI is not running (the Model Manager downloads with the engine
/// shut down all the time), and the pack folders under `custom_nodes`, which
/// are not a ComfyUI `folder_paths` key at all.
///
/// GH #183: above the engine sits what the user configured for ComfyUI
/// itself (`extra_model_paths.yaml`, the start script, ComfyUI Desktop; see
/// comfy_user_paths.rs). The engine lists a shared folder too, but behind the
/// instance folder of the same name, and says nothing while it is shut down.
fn models_dir_in(
    folders: Option<&comfy_folders::ComfyFolders>,
    comfy_path: &Option<String>,
    subfolder: &str,
) -> Result<PathBuf, String> {
    let user = comfy_user_paths::for_comfy(comfy_path);
    models_dir_with(&user, folders, comfy_path, subfolder)
}

/// `models_dir_in` with the user's folders read once, for the loops that ask
/// for many files at a time.
fn models_dir_with(
    user: &comfy_user_paths::UserComfyPaths,
    folders: Option<&comfy_folders::ComfyFolders>,
    comfy_path: &Option<String>,
    subfolder: &str,
) -> Result<PathBuf, String> {
    let dir = models_path_with(user, folders, comfy_path, subfolder)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Create models dir: {}", os_error::english(&e)))?;
    Ok(dir)
}

/// The folder `models_dir_with` writes into, resolved without creating it.
fn models_path_with(
    user: &comfy_user_paths::UserComfyPaths,
    folders: Option<&comfy_folders::ComfyFolders>,
    comfy_path: &Option<String>,
    subfolder: &str,
) -> Result<PathBuf, String> {
    safe_subfolder(subfolder)?;
    let plain = !subfolder.contains('/') && !subfolder.contains('\\');
    if let Some(dir) = plain.then(|| user.write_dir(subfolder)).flatten() {
        return Ok(dir);
    }
    if let Some(dir) = folders.and_then(|f| f.dir_for(subfolder)) {
        return Ok(dir);
    }
    let base = comfy_path.as_ref().ok_or("ComfyUI path not set. Please set it in settings or install ComfyUI first.")?;
    // Subfolders starting with "custom_nodes/" are relative to ComfyUI root, not models/
    let dir = if subfolder.starts_with("custom_nodes/") || subfolder.starts_with("custom_nodes\\") {
        PathBuf::from(base).join(subfolder)
    } else {
        PathBuf::from(base).join("models").join(subfolder)
    };
    Ok(dir)
}

/// A ComfyUI on another machine (GH #143: Ollama and ComfyUI as
/// services on a LAN box, LU on a Windows PC). Its model folders are on THAT
/// machine and nothing here can write into them: the folder names it reports
/// are paths over there, and a ComfyUI install found on this PC is not the one
/// rendering. Downloads went to one or the other and ended in "Create models
/// dir: permission denied (os error 5)" or "ComfyUI path not set". They land
/// in the Storage folder now, in ComfyUI's own layout (`loras/...`,
/// `checkpoints/...`), so copying its folders into the `models` folder over
/// there, or sharing the folder with that machine, is all it takes.
pub(crate) struct RemoteComfy {
    pub host: String,
    pub root: PathBuf,
}

pub(crate) fn remote_comfy(state: &State<'_, AppState>) -> Option<RemoteComfy> {
    let host = state.comfy_host.lock().map(|h| h.clone()).unwrap_or_default();
    if host_is_this_machine(&host) {
        return None;
    }
    Some(RemoteComfy { host, root: remote_models_root() })
}

fn host_is_this_machine(host: &str) -> bool {
    let h = host.trim().trim_matches(|c| c == '[' || c == ']');
    crate::commands::process::is_local_host(h)
        || h.parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback() || ip.is_unspecified())
            .unwrap_or(false)
}

/// The Storage folder when one is set, else a folder in Downloads.
fn remote_models_root() -> PathBuf {
    use crate::commands::custom_models::{remembered_root, RememberedRoot};
    match remembered_root() {
        RememberedRoot::Folder(dir) => PathBuf::from(dir),
        _ => dirs::download_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(std::env::temp_dir)
            .join("LU ComfyUI models"),
    }
}

fn remote_models_dir(root: &Path, subfolder: &str) -> Result<PathBuf, String> {
    let dir = remote_models_path(root, subfolder)?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Create models dir {}: {}", dir.display(), os_error::english(&e)))?;
    Ok(dir)
}

/// The folder `remote_models_dir` writes into, resolved without creating it.
fn remote_models_path(root: &Path, subfolder: &str) -> Result<PathBuf, String> {
    safe_subfolder(subfolder)?;
    Ok(root.join(subfolder))
}

/// Where a ComfyUI model of `subfolder` goes: `models_dir_in`, plus the one
/// case its arguments cannot show, a ComfyUI on another machine.
async fn comfy_models_dir(
    state: &State<'_, AppState>,
    comfy_path: &Option<String>,
    subfolder: &str,
) -> Result<PathBuf, String> {
    if let Some(remote) = remote_comfy(state) {
        return remote_models_dir(&remote.root, subfolder);
    }
    models_dir_in(engine_folders(state).await.as_ref(), comfy_path, subfolder)
}

/// The folder `comfy_models_dir` writes into, resolved without creating it.
async fn comfy_models_path(
    state: &State<'_, AppState>,
    comfy_path: &Option<String>,
    subfolder: &str,
) -> Result<PathBuf, String> {
    if let Some(remote) = remote_comfy(state) {
        return remote_models_path(&remote.root, subfolder);
    }
    let user = comfy_user_paths::for_comfy(comfy_path);
    models_path_with(&user, engine_folders(state).await.as_ref(), comfy_path, subfolder)
}

/// For the frontend: whether ComfyUI models land on this machine only, and
/// where. The Model Manager and Create say so instead of waiting for a
/// ComfyUI that can never see the file.
#[tauri::command]
pub fn comfy_model_target(state: State<'_, AppState>) -> serde_json::Value {
    match remote_comfy(&state) {
        Some(r) => serde_json::json!({
            "remote": true,
            "host": r.host,
            "root": r.root.to_string_lossy(),
        }),
        None => serde_json::json!({ "remote": false }),
    }
}

/// The engine's answer, asked fresh, for the paths that can await it.
pub(crate) async fn engine_folders(state: &State<'_, AppState>) -> Option<comfy_folders::ComfyFolders> {
    let host = state.comfy_host.lock().map(|h| h.clone()).unwrap_or_default();
    let port = state.comfy_port.lock().map(|p| *p).unwrap_or(0);
    if port == 0 {
        return comfy_folders::cached();
    }
    match comfy_folders::folders_of(&host, port).await {
        Some(f) => Some(f),
        None => comfy_folders::cached(),
    }
}

#[allow(non_snake_case)]
#[tauri::command]
pub async fn download_model(
    url: String,
    subfolder: String,
    filename: String,
    expectedBytes: Option<u64>,
    expectedSha256: Option<String>,
    // The CivitAI API key, when the caller has one. Sent as a Bearer header
    // and ONLY to a CivitAI host (see do_download). Absent for every other
    // catalog, which is every other download in the app.
    authToken: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let expected_bytes = expectedBytes;
    let auth_token = authToken;
    let comfy_path = {
        let mut p = state.comfy_path.lock().unwrap();
        if p.is_none() {
            if let Some(found) = crate::commands::process::find_comfyui_path() {
                println!("[Download] Auto-discovered ComfyUI at: {}", found);
                *p = Some(found);
            }
        }
        p.clone()
    };

    let dest_dir = comfy_models_dir(&state, &comfy_path, &subfolder).await?;
    let dest_file = dest_dir.join(sanitize_filename(&filename));

    let expected_sha256 = match expectedSha256.as_deref() {
        Some(s) => Some(normalize_sha256(s)?),
        None => None,
    };

    if dest_file.exists() {
        let actual = dest_file.metadata().map(|m| m.len()).unwrap_or(0);
        // Ask the SERVER how big the file is. The catalog's `expectedBytes` is a
        // rounded GB estimate and may not decide this — see `judge_existing`.
        match judge_existing(actual, exact_remote_size(&url).await) {
            Existing::Complete => {
                return Ok(serde_json::json!({"status": "exists", "path": dest_file.to_string_lossy()}));
            }
            Existing::Mismatch { actual, exact } => {
                println!(
                    "[Download] {} exists with {} bytes but the host states {} — fetching it again",
                    filename, actual, exact
                );
                // Fall through to a fresh transfer.
            }
            Existing::Unverified { actual } => {
                // Offline, or a host that states no length. Nothing can be
                // checked, so nothing is claimed: the file stays, and the reason
                // it was not verified is on the record instead of nowhere.
                println!(
                    "[Download] {} exists with {} bytes and the host states no size — accepted UNVERIFIED",
                    filename, actual
                );
                return Ok(serde_json::json!({"status": "exists", "path": dest_file.to_string_lossy()}));
            }
        }
    }

    // Use filename as ID (matches frontend lookup)
    let id = filename.clone();

    // Check for existing partial download (resume support)
    let tmp_path = dest_file.with_extension("download");
    let resume_offset = if tmp_path.exists() {
        tmp_path.metadata().map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    // Claim the id before anything else touches shared state, so a second
    // start for the same file cannot take over the first one's token.
    match claim_download(&mut state.downloads.lock().unwrap(), &id, &filename, &dest_file, resume_offset) {
        Claim::Ok => {}
        Claim::AlreadyRunning => {
            return Ok(serde_json::json!({"status": "already_running", "id": id}));
        }
        Claim::NameConflict(other) => {
            return Ok(serde_json::json!({
                "status": "error",
                "error": format!("Another download is already writing a file called {filename} (to {other}). Wait for it to finish, then start this one again."),
            }));
        }
    }

    // Create cancellation token
    let token = CancellationToken::new();
    {
        let mut tokens = state.download_tokens.lock().unwrap();
        tokens.insert(id.clone(), token.clone());
    }

    let downloads_arc = Arc::clone(&state.downloads);
    let tokens_arc = Arc::clone(&state.download_tokens);
    let id_clone = id.clone();
    let filename_clone = filename.clone();

    tokio::spawn(async move {
        match do_download(&url, &dest_file, &downloads_arc, &id_clone, token, resume_offset,
                        CatalogClaims { expected_bytes, expected_sha256, auth_token }).await {
            Ok(_) => {
                if let Ok(mut dl) = downloads_arc.lock() {
                    if let Some(p) = dl.get_mut(&id_clone) {
                        p.status = "complete".to_string();
                    }
                }
                println!("[Download] Complete: {}", filename_clone);
            }
            Err(e) => {
                if e == "paused" {
                    println!("[Download] Paused: {}", filename_clone);
                    // Status already set to "paused" in do_download
                } else if e == "cancelled" {
                    // Clean up temp file
                    let tmp = dest_file.with_extension("download");
                    let _ = std::fs::remove_file(&tmp);
                    if let Ok(mut dl) = downloads_arc.lock() {
                        dl.remove(&id_clone);
                    }
                    println!("[Download] Cancelled: {}", filename_clone);
                } else {
                    if let Ok(mut dl) = downloads_arc.lock() {
                        if let Some(p) = dl.get_mut(&id_clone) {
                            p.status = "error".to_string();
                            p.error = Some(e.clone());
                        }
                    }
                    println!("[Download] Failed: {} - {}", filename_clone, e);
                }
            }
        }
        // Clean up token
        if let Ok(mut tokens) = tokens_arc.lock() {
            tokens.remove(&id_clone);
        }
    });

    Ok(serde_json::json!({"status": "started", "id": id}))
}

/// Outcome of trying to start a transfer under the id `filename`.
#[derive(Debug, PartialEq, Eq)]
pub enum Claim {
    /// Nobody else is on this id — the caller owns it.
    Ok,
    /// The very same file is already in flight. Harmless: the caller can just
    /// follow the existing progress entry.
    AlreadyRunning,
    /// A DIFFERENT file with the same name is in flight. Starting anyway would
    /// point two transfers at one `.download` temp file.
    NameConflict(String),
}

/// Decide whether `id` may start, and register its progress entry, in ONE
/// critical section.
///
/// Two starts for the same id used to overwrite each other: the second
/// clobbered the first's cancel token, so the first became impossible to pause
/// or cancel, and both tokio tasks then wrote the same `.download` file — one
/// truncating it via `File::create` while the other kept appending at its own
/// offset. The result still reached `total` bytes and was reported
/// "complete", so the user got a silently corrupt model.
pub fn claim_download(
    downloads: &mut HashMap<String, DownloadProgress>,
    id: &str,
    filename: &str,
    dest: &Path,
    resume_offset: u64,
) -> Claim {
    let dest_str = dest.to_string_lossy().to_string();
    if let Some(p) = downloads.get(id) {
        if matches!(p.status.as_str(), "connecting" | "downloading" | "pausing") {
            // An older entry predating `dest` carries an empty string; treat it
            // as the same file rather than inventing a conflict.
            return if p.dest.is_empty() || p.dest == dest_str {
                Claim::AlreadyRunning
            } else {
                Claim::NameConflict(p.dest.clone())
            };
        }
    }
    downloads.insert(
        id.to_string(),
        DownloadProgress {
            progress: resume_offset,
            total: 0,
            speed: 0.0,
            filename: filename.to_string(),
            status: "connecting".to_string(),
            error: None,
            dest: dest_str,
        },
    );
    Claim::Ok
}

/// A resume the host refuses with 416 (Range Not Satisfiable): the partial
/// on disk is as long as the file or longer, so asking for the rest can never
/// succeed. Only meaningful when a Range was sent at all.
pub(crate) fn partial_cannot_continue(resume_offset: u64, status: u16) -> bool {
    resume_offset > 0 && status == 416
}

/// Bytes already on disk that count toward this download. Only a 206 means the
/// server honoured the Range request; a 200 carries the whole body, the partial
/// file is truncated and restarted, and nothing may be counted.
fn resumed_bytes(resume_offset: u64, status: u16) -> u64 {
    if resume_offset > 0 && status == 206 { resume_offset } else { 0 }
}

// ── Download speed limit (Discord 2026-09-23) ─────────────
//
// "is there a way to limit download speed that this app does whenever it
// downloads anything?" Every model file LU fetches itself runs through
// do_download, so the limit sits there, shared by all downloads at once:
// two downloads under a 10 MB/s limit get 10 MB/s together, not 20. Ollama
// pulls and package installs run in other programs and are not limited.

/// Bytes per second, 0 for no limit. Set from Settings at boot and on change.
static DOWNLOAD_LIMIT_BPS: AtomicU64 = AtomicU64::new(0);
/// When the shared line is free again, across all running downloads.
static DOWNLOAD_NEXT_SLOT: Mutex<Option<Instant>> = Mutex::new(None);

/// How far the shared line may lie behind the clock and still count. The time
/// a read took is paid from it, so a line running at the limit arrives at the
/// limit and a line slower than the limit is not slowed further. It is also
/// the most a pause can turn into a burst afterwards.
const THROTTLE_CREDIT: Duration = Duration::from_millis(100);

/// How long the download that just received `bytes` waits before it reads
/// on, so that everything together stays at `limit_bps`. The line is a
/// schedule, not a pause after every piece: time already spent reading is
/// credited, up to `THROTTLE_CREDIT`.
fn throttle_wait(slot: &mut Option<Instant>, limit_bps: u64, bytes: u64, now: Instant) -> Duration {
    if limit_bps == 0 {
        *slot = None;
        return Duration::ZERO;
    }
    let floor = now.checked_sub(THROTTLE_CREDIT).unwrap_or(now);
    let start = match *slot {
        Some(t) if t > floor => t,
        Some(_) => floor,
        None => now,
    };
    let done = start + Duration::from_secs_f64(bytes as f64 / limit_bps as f64);
    *slot = Some(done);
    done.saturating_duration_since(now)
}

/// The limit in bytes per second, or why the number is not one.
pub(crate) fn download_limit_bps(mb_per_sec: f64) -> Result<u64, String> {
    if !mb_per_sec.is_finite() || mb_per_sec < 0.0 {
        return Err("The download limit has to be 0 or a positive number of MB/s.".to_string());
    }
    Ok((mb_per_sec * 1_000_000.0).round() as u64)
}

/// Settings, Storage: megabytes per second, 0 for no limit.
///
/// On a phone the command of the same name in download_mobile.rs answers:
/// the transfer there belongs to the native layer, which keeps the limit.
#[cfg_attr(desktop, tauri::command)]
#[cfg_attr(mobile, allow(dead_code))]
pub fn set_download_limit(mb_per_sec: f64) -> Result<(), String> {
    DOWNLOAD_LIMIT_BPS.store(download_limit_bps(mb_per_sec)?, Ordering::Relaxed);
    Ok(())
}

/// True when the body stopped before Content-Length was reached. `total == 0`
/// means the server declared no length — there is nothing to check against.
fn ended_early(total: u64, downloaded: u64) -> bool {
    total > 0 && downloaded < total
}

/// The full size of the file being fetched, and whether that number is only the
/// catalog's estimate rather than something the server stated.
///
/// A server that sends no `Content-Length` used to switch BOTH guards off
/// without a word: `unwrap_or(0)` produced `total == 0`, and 0 is exactly the
/// value the space check and the truncation check read as "nothing to compare
/// against". A 40 GB transfer then ran until the drive hit zero and a body that
/// stopped halfway was renamed into place, with nobody ever having been told
/// that either safeguard had turned itself off.
///
/// The catalog carries a size for these files, so the space guard gets that
/// estimate to plan with — a rough number is a far better plan than no number.
/// The flag is what keeps the two uses apart: an estimate may refuse a transfer
/// that clearly cannot fit, it may NEVER declare one finished.
fn total_size(declared: Option<u64>, resume_offset: u64, resumed: bool, estimate: Option<u64>) -> (u64, bool) {
    match declared {
        Some(n) if n > 0 => (if resumed { n + resume_offset } else { n }, false),
        _ => (estimate.unwrap_or(0), true),
    }
}

/// What a file that is already sitting at the destination is worth.
#[derive(Debug, PartialEq, Eq)]
pub enum Existing {
    /// Byte for byte the size the server states. Nothing left to fetch.
    Complete,
    /// The server states a different size than the file has. Fetch it again.
    Mismatch { actual: u64, exact: u64 },
    /// Nobody could name an exact size, so nothing here is verified.
    Unverified { actual: u64 },
}

/// Decide what to do with a file already at the destination.
///
/// The old rule was `actual >= expected as f64 * 0.9`, measured against a
/// catalog size that is a rounded GB estimate. A download aborted at 91 % was
/// therefore "complete" and never fetched again: several gigabytes of model
/// weights accepted on a file length with 10 % of slack, and the failure only
/// surfaced much later when a backend tried to load the truncated file.
///
/// There is no safe threshold here. Either a number is exact — then it has to
/// match to the byte — or it is not, and then it may not decide anything. The
/// exact number comes from the server (`exact_remote_size`), never from the
/// catalog.
pub fn judge_existing(actual: u64, exact: Option<u64>) -> Existing {
    match exact {
        Some(e) if e > 0 => {
            if actual == e {
                Existing::Complete
            } else {
                Existing::Mismatch { actual, exact: e }
            }
        }
        _ => Existing::Unverified { actual },
    }
}

/// Total size out of a `Content-Range: bytes 0-0/12345` header. A `*` for the
/// whole means the server knows the range but not the length, which is no
/// number to judge with.
fn total_from_content_range(v: &str) -> Option<u64> {
    v.rsplit('/').next()?.trim().parse::<u64>().ok()
}

/// A 64 character hex SHA256, lowercased.
///
/// Anything else is refused rather than quietly ignored: a mistyped digest that
/// silently disables the check is worse than no digest at all, because it looks
/// like the file was verified.
pub(crate) fn normalize_sha256(v: &str) -> Result<String, String> {
    let t = v.trim();
    if t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(t.to_ascii_lowercase())
    } else {
        Err(format!(
            "Expected sha256 must be 64 hex characters, got {} character(s)",
            t.chars().count()
        ))
    }
}

/// Turn a refused HTTP status into something the user can act on, and say in
/// the same breath whether pressing Retry could ever help.
///
/// The catalog hard-codes 106 HuggingFace addresses. The moment a repo is
/// renamed, made private, or gated behind a licence click, every one of them
/// answers 404 or 401/403 for good — and all the user got was the bare string
/// "HTTP 404" next to a Retry button that could not possibly work, which is a
/// loop with no exit.
///
/// The status code stays inside the text on purpose: it is the contract the
/// frontend reads to decide whether to offer Retry at all — see
/// `isPermanentDownloadError` in src/api/discover.ts. Changing the "(HTTP nnn)"
/// shape here breaks that decision there.
pub fn http_error_message(status: u16, filename: &str) -> String {
    match status {
        // The phone has no "Model Manager" and its copy carries no dash; the desktop sentence stays as it was.
        #[cfg(mobile)]
        404 | 410 => format!(
            "{filename} is not at this address any more (HTTP {status}). The repository was renamed, moved or taken down, so trying again cannot help. Look for a newer version of this model under Models, or update {product}. The address is part of the app's catalog.",
            product = crate::app_identity::PRODUCT_NAME
        ),
        #[cfg(not(mobile))]
        404 | 410 => format!(
            "{filename} is not at this address any more (HTTP {status}). The repository was renamed, moved or taken down, so trying again cannot help. Look for a newer version of this model in the Model Manager, or update {product} — the address is part of the app's catalog.",
            product = crate::app_identity::PRODUCT_NAME
        ),
        401 | 403 => format!(
            "{filename} cannot be downloaded without a login at this host (HTTP {status}). The address is gated or private: open it in a browser, sign in, accept any licence, and put the file into the model folder by hand. Trying again here cannot help."
        ),
        429 => format!(
            "The host is rate limiting this download (HTTP {status}). Wait a few minutes, then start {filename} again."
        ),
        500..=599 => format!(
            "The host could not serve {filename} right now (HTTP {status}). That is a problem on their side — start it again in a few minutes."
        ),
        _ => format!("HTTP {status} while downloading {filename}."),
    }
}

/// Headroom left free on the drive, on top of the bytes the download needs.
/// Windows starts failing in ways that have nothing to do with us once the
/// system drive runs dry, so the last gigabyte is never ours to take.
const SPACE_RESERVE: u64 = 1024 * 1024 * 1024;

/// Bytes still needed versus bytes still free, when the drive cannot hold the
/// rest of this download. `None` means it fits, or that there is nothing to
/// compare against: a server that declares no length gives no number to plan
/// with, and a drive we cannot measure must not block the download.
///
/// Without this the transfer simply ran until the drive hit zero. On
/// 2026-08-15 a 16.3 GB video model did exactly that on the test machine:
/// curl died with a write error at 0 bytes free, the half file stayed behind,
/// and the drive was too full for anything else to run. A model set is the one
/// download big enough to fill a disk, so the check belongs here, where every
/// download passes through, not in the caller that happens to know the sizes.
fn space_shortfall(total: u64, already_on_disk: u64, available: Option<u64>) -> Option<(u64, u64)> {
    space_shortfall_keeping(total, already_on_disk, available, SPACE_RESERVE)
}

/// `space_shortfall` with the headroom named by the caller.
fn space_shortfall_keeping(total: u64, already_on_disk: u64, available: Option<u64>, reserve: u64) -> Option<(u64, u64)> {
    let available = available?;
    if total == 0 {
        return None;
    }
    let needed = total.saturating_sub(already_on_disk).saturating_add(reserve);
    if available >= needed { None } else { Some((needed, available)) }
}

/// Headroom a whole bundle leaves free. Twice the single file's: a bundle is
/// tens of gigabytes in several transfers, and its plan is made from catalog
/// sizes before any server has stated a length (the box, 03.10.2026: 27.1 GB
/// started onto 29.6 GB free without a word).
const BUNDLE_SPACE_RESERVE: u64 = 2 * 1024 * 1024 * 1024;

/// What the user is told when a bundle does not fit: how much is missing
/// first, then the three numbers it comes from.
fn bundle_space_message(required: u64, reserved: u64, needed: u64, free: u64) -> String {
    format!(
        "Not enough free space: {} short. The download is {}, LU keeps {} of the drive free, and the drive has {} free.{} Free up some space and start it again.",
        gib(needed.saturating_sub(free)),
        gib(required),
        gib(BUNDLE_SPACE_RESERVE),
        gib(free),
        if reserved > 0 {
            format!(" Another {} is already promised to downloads that are still running.", gib(reserved))
        } else {
            String::new()
        },
    )
}

/// Free bytes on the drive that holds `dest`. The longest matching mount point
/// wins, so a model folder on a mounted volume is measured against that volume
/// and not against the root it hangs under.
///
/// The lookup itself lives in `crate::disk`, because a phone needs a different
/// one: inside an app sandbox sysinfo's disk list measures the wrong file
/// system and refused every download (Android finding A11).
pub(crate) fn available_space_for(dest: &Path) -> Option<u64> {
    crate::disk::available_bytes(dest)
}

/// Gibibyte, weil Windows und der Finder den freien Platz so anzeigen und der
/// Nutzer die Zahl aus der Meldung genau damit vergleicht. Der Katalog zaehlt
/// aus demselben Grund in derselben Einheit.
fn gib(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
}

/// Is this a CivitAI download URL?
///
/// `civitai.red` is the mirror LU offers for regions where `.com` is blocked
/// (GH #53), so both count. Parsed with the same URL parser the request itself
/// goes through, never picked apart by hand: a hand written host split does not
/// know that a backslash ends the host in a special scheme, so
/// `https://evil.test\.civitai.com/x` read as a CivitAI host here while reqwest
/// sent the Bearer token to `evil.test`. Same rule for
/// `https://civitai.com\@evil.test`.
pub(crate) fn is_civitai_host(url: &str) -> bool {
    let host = match url::Url::parse(url) {
        Ok(u) => u.host_str().unwrap_or("").to_ascii_lowercase(),
        Err(_) => return false,
    };
    host == "civitai.com"
        || host == "civitai.red"
        || host.ends_with(".civitai.com")
        || host.ends_with(".civitai.red")
}

/// Same rule for the Hugging Face hub, the only host the stored Hugging Face
/// token is ever sent to. `hf.co` is the hub's own short alias.
pub(crate) fn is_huggingface_host(url: &str) -> bool {
    let host = match url::Url::parse(url) {
        Ok(u) => u.host_str().unwrap_or("").to_ascii_lowercase(),
        Err(_) => return false,
    };
    host == "huggingface.co" || host == "hf.co" || host.ends_with(".huggingface.co")
}

/// What the user reads when a download comes back refused.
///
/// Discord #bug-reports 2026-08-28: CivitAI downloads ended in a
/// bare `HTTP 400` with nothing to act on, because the API key field had gone
/// missing from the interface and nobody could tell that a key was the point.
/// A refusal from CivitAI names the field and the way to it. Everything else
/// goes to `http_error_message`: inventing a CivitAI hint for a dead
/// HuggingFace link would send people to the wrong setting.
///
/// The section name is part of the message and it has to be the section that
/// really holds the field. It did not: the key moved out of Storage into
/// a section of its own (the A14 review found a tester saving a folder path as
/// his API key, because the two fields sat under each other), and this text
/// kept sending people to the folder settings, where the field they were
/// looking for is not. `src/components/settings/__tests__/
/// die-meldung-zeigt-auf-den-abschnitt-den-es-gibt.test.ts` holds every
/// `Settings > …` path in this file against the sections the app really has.
///
/// The CivitAI text carries its status WITHOUT the `(HTTP nnn)` brackets on
/// purpose. That shape is the contract `isPermanentDownloadError` reads in
/// src/api/discover.ts to replace Retry with "Unavailable", and a missing API
/// key is the one refusal the user can go and fix, so the button has to stay.
pub(crate) fn download_http_error(url: &str, status: u16, sent_token: bool, filename: &str) -> String {
    let refused = matches!(status, 400 | 401 | 403);
    // A gated Hugging Face repo (OrcaRouter's own GGUF repo is one) answers
    // 401 to everyone without an accepted licence and a token. That is not a
    // dead address, it is a missing credential, so the text names the field
    // and keeps the status out of the `(HTTP nnn)` shape: the Retry button
    // has to stay for the moment the token is in.
    if is_huggingface_host(url) && matches!(status, 401 | 403) {
        return if sent_token {
            format!(
                "Hugging Face refused this download with HTTP {status}. Your Hugging Face token was sent and rejected. \
                 Check it under Settings > AI Backends > Hugging Face token, and check that you accepted this \
                 repository's licence on huggingface.co with the same account."
            )
        } else {
            format!(
                "Hugging Face refused this download with HTTP {status}. This repository is gated or private and needs a \
                 Hugging Face account: open the repository page on huggingface.co, accept its licence, add a Hugging Face \
                 token under Settings > AI Backends > Hugging Face token, then start {filename} again."
            )
        };
    }
    if is_civitai_host(url) && refused {
        return if sent_token {
            format!(
                "CivitAI refused this download with HTTP {status}. Your CivitAI API key was sent and rejected. \
                 Check it under Settings > AI Backends > CivitAI API key, and check that your CivitAI account \
                 is allowed to download this model."
            )
        } else {
            format!(
                "CivitAI refused this download with HTTP {status}. Most CivitAI downloads need an API key. \
                 Add one under Settings > AI Backends > CivitAI API key, then start this download again."
            )
        };
    }
    http_error_message(status, filename)
}

/// Which credential, if any, rides on this request.
///
/// Discord #bug-reports 2026-08-28: CivitAI downloads died in
/// 400s because they went out anonymous. The key was in the store, read by the
/// search and by nothing on the download path.
///
/// A Bearer header rather than a `?token=` query parameter, which CivitAI
/// documents as well: a key in the URL is written into the download meta the
/// app persists, printed in every log line that quotes the address, and kept in
/// the browser history of the web build. reqwest strips Authorization itself
/// when a redirect leaves the host, which is exactly right here: CivitAI hands
/// the file to a signed CDN URL that must not see the key.
///
/// Host-gated both ways IN HERE, not only in the caller: the CivitAI key goes
/// to CivitAI, the Hugging Face token to the hub, and a URL that is neither
/// carries nothing. A blank key is no key. The caller still decides whether to
/// read the hub token out of the vault at all, which is a different question
/// from whether it may be sent.
fn outgoing_token(url: &str, civitai_key: Option<&str>, hf_token: Option<&str>) -> Option<String> {
    let civitai = civitai_key
        .map(str::trim)
        .filter(|t| !t.is_empty() && is_civitai_host(url));
    let hub = hf_token
        .map(str::trim)
        .filter(|t| !t.is_empty() && is_huggingface_host(url));
    civitai.or(hub).map(|t| t.to_string())
}

/// Does a credential that went out with `first` still belong on `hop`?
///
/// The rule reqwest applies when it follows a redirect itself, and the rule
/// every download of v3.0.5 lived by: `Authorization` survives a redirect only
/// while host and port stay the same. A sub-domain is another host. That
/// matters for the hub: `huggingface.co` answers a `resolve` address with a
/// redirect to a storage host (`cdn-lfs.huggingface.co`, `*.hf.co`) whose
/// address is already signed. A signed address that gets a Bearer header on
/// top answers 400, so the download would fail exactly for the people who
/// stored a token. Never down from https either.
fn key_stays_on_hop(first: &str, hop: &str) -> bool {
    let (a, b) = match (url::Url::parse(first), url::Url::parse(hop)) {
        (Ok(a), Ok(b)) => (a, b),
        _ => return false,
    };
    let host_a = a.host_str().unwrap_or("").to_ascii_lowercase();
    let host_b = b.host_str().unwrap_or("").to_ascii_lowercase();
    if host_a.is_empty() || host_a != host_b {
        return false;
    }
    if a.port_or_known_default() != b.port_or_known_default() {
        return false;
    }
    !(a.scheme() == "https" && b.scheme() != "https")
}

/// The credential of one download on its way through the redirects.
///
/// It rides while the hop is the address the download was started with (same
/// host, same port). Once a redirect has left that host the credential is
/// gone for the rest of the chain, even when a later hop comes back: reqwest
/// removes the header from the request it carries along, it never puts it
/// back.
pub(crate) struct RidingKey {
    first: String,
    token: Option<String>,
    dropped: std::sync::atomic::AtomicBool,
}

impl RidingKey {
    pub(crate) fn new(first: &str, token: Option<String>) -> Self {
        Self { first: first.to_string(), token, dropped: std::sync::atomic::AtomicBool::new(false) }
    }

    /// The token for this hop, or nothing. Asking twice for the same hop (a
    /// connection that is tried again) gives the same answer.
    pub(crate) fn for_hop(&self, hop: &str) -> Option<&str> {
        use std::sync::atomic::Ordering;
        if !key_stays_on_hop(&self.first, hop) {
            self.dropped.store(true, Ordering::SeqCst);
        }
        if self.dropped.load(Ordering::SeqCst) {
            return None;
        }
        self.token.as_deref()
    }
}

/// One reqwest client, built the same way for every request this module makes.
///
/// The SSRF guard is not optional and not a per-call decision: model downloads
/// come from public catalogs, and a crafted catalog or model URL must not be
/// able to reach an internal service or 169.254.169.254 — on the first hop or
/// on any redirect.
pub(crate) fn download_client(connect_secs: u64, read_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(crate::app_identity::outgoing_agent!("1.5"))
        .redirect(crate::commands::proxy::ssrf_safe_redirect_policy(10))
        .connect_timeout(std::time::Duration::from_secs(connect_secs))
        .read_timeout(std::time::Duration::from_secs(read_secs))
        .build()
        .map_err(|e| os_error::english(&e))
}

/// The exact byte count the SERVER states for `url`, or None when it will not
/// state one (offline, HEAD refused, chunked transfer, a probe that errors).
///
/// This is the only trustworthy size in the whole download path. The catalog's
/// `sizeGB` is a rounded human number — "9.2" for a file of 9 874 331 648 bytes
/// — so it can size a progress bar or refuse a full drive, but it can never
/// certify that a file on disk is the whole file.
/// Short timeouts, because this runs INSIDE the install click. A machine with
/// no network must cost the user a moment, not half a minute — the answer for
/// an unreachable host is "cannot tell", and arriving at it slowly helps
/// nobody.
pub(crate) async fn exact_remote_size(url: &str) -> Option<u64> {
    crate::commands::proxy::validate_public_url(url).ok()?;
    let client = download_client(8, 15).ok()?;

    // A transport error means offline or a black-holed host. Retrying the same
    // unreachable address with a second request only doubles the wait.
    let head = client.head(url).send().await.ok()?;
    if head.status().is_success() {
        if let Some(n) = head.content_length() {
            if n > 0 {
                return Some(n);
            }
        }
    }

    // The host answered, just not usefully: some CDNs reply 405 to HEAD, or drop
    // the length from it. A one byte ranged GET costs one more round trip and
    // carries the whole size in Content-Range.
    let r = client.get(url).header("Range", "bytes=0-0").send().await.ok()?;
    let v = r.headers().get(reqwest::header::CONTENT_RANGE)?.to_str().ok()?;
    total_from_content_range(v)
}

/// SHA256 of the first `len` bytes of `path`.
///
/// Only needed when a transfer RESUMES with a digest to check: the bytes
/// already on disk never passed through the hasher, so without replaying them
/// the final digest would be the hash of the tail alone and every resumed
/// download would look corrupt. Reading a large partial back costs seconds;
/// throwing the partial away costs hours.
async fn digest_of_prefix(path: &Path, len: u64) -> Result<Sha256, String> {
    use tokio::io::AsyncReadExt;
    let mut f = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Open partial file for hashing: {}", os_error::english(&e)))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut done: u64 = 0;
    while done < len {
        let want = std::cmp::min(buf.len() as u64, len - done) as usize;
        let n = f
            .read(&mut buf[..want])
            .await
            .map_err(|e| format!("Read partial file for hashing: {}", os_error::english(&e)))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        done += n as u64;
    }
    Ok(hasher)
}

/// What the caller knows about a file and where it comes from, as opposed to
/// what the server says on the wire. These travel together everywhere and are
/// the only arguments `do_download` takes that are not about the transfer
/// itself, so they ride as one. That also keeps the argument count under
/// `clippy::too_many_arguments`'s threshold without an `allow`, which the
/// CivitAI key would otherwise have pushed it over.
struct CatalogClaims {
    /// Catalog estimate. Plans the space guard when the server states no length;
    /// never decides that a transfer is finished.
    expected_bytes: Option<u64>,
    /// Digest from the catalog entry, already normalised. `None` means the
    /// content of this file cannot be verified at all.
    expected_sha256: Option<String>,
    /// The user's CivitAI API key, when there is one. Goes out as a Bearer
    /// header and ONLY to a CivitAI host; every other catalog in the app
    /// downloads without one.
    auth_token: Option<String>,
}

async fn do_download(
    url: &str,
    dest: &PathBuf,
    downloads: &Arc<Mutex<HashMap<String, DownloadProgress>>>,
    id: &str,
    token: CancellationToken,
    resume_offset: u64,
    claims: CatalogClaims,
) -> Result<(), String> {
    let CatalogClaims { expected_bytes, expected_sha256, auth_token } = claims;
    // SSRF guard: model downloads come from public catalogs (HuggingFace,
    // civitai, ollama). Block private/loopback/metadata hosts and re-validate
    // every redirect hop so a crafted catalog/model URL can't pull from an
    // internal service or 169.254.169.254.
    // The gate itself runs inside `send_download_request`, once per hop and
    // with the patient resolver: a slow line gets three lookups with growing
    // time instead of one of five seconds, and when the network really is
    // gone the row says so in a sentence of its own (models 26c).

    // A deadline on the whole request punishes people for having a slow line
    // rather than a broken one: the 2 hour cap this replaces killed any
    // download that legitimately took longer, and the catalog offers single
    // files of 40 GB and sets of 155 GB. Discord 2026-07-29,
    // after giving up: "all of your downloads have a habit of timing out".
    // What we actually want to catch is a stalled transfer, so the limits are
    // per-connect and per-read. A dead socket now fails in two minutes and
    // resumes from the partial on the next attempt; a slow one is left to
    // finish.

    // The Hugging Face token from Settings goes to the hub and to no other
    // host: gated repos answer 401 without it, and anonymous hub traffic is
    // throttled.
    let hf_token = if is_huggingface_host(url) { crate::commands::mlx::hf_token() } else { None };
    // Kept as a value: weiter unten fragt die Fehlermeldung noch einmal, ob
    // ein Schluessel mitgegangen ist.
    let sent_token: Option<String> = outgoing_token(url, auth_token.as_deref(), hf_token.as_deref());

    let mut resume_offset = resume_offset;
    let riding_key = RidingKey::new(url, sent_token.clone());
    let response = loop {
        if resume_offset > 0 {
            println!("[Download] Resuming from byte {}", resume_offset);
        }
        let offset = resume_offset;
        let response = crate::commands::proxy::send_download_request(url, 30, 120, 10, |client, hop| {
            let mut request = client.get(hop);
            // Asked again for every hop: a key follows a redirect only while the
            // hop is still the host the download was started with, as reqwest
            // did it in v3.0.5. The file itself usually comes from a signed
            // storage address that must not see it, see `key_stays_on_hop`.
            if let Some(t) = riding_key.for_hop(hop) {
                request = request.bearer_auth(t);
            }
            // Resume support: request only remaining bytes
            if offset > 0 {
                request = request.header("Range", format!("bytes={}-", offset));
            }
            request
        })
        .await?;

        // GH #113: a partial that already holds the whole file (the rename
        // after the last byte failed, or the app ended right there) or more
        // than the host now serves is answered 416 on every resume, so every
        // Retry ended in the same "HTTP 416" and the bundle hung for good.
        // The partial goes to the Trash, never deleted, and the transfer
        // starts over once.
        if partial_cannot_continue(resume_offset, response.status().as_u16()) {
            let tmp = dest.with_extension("download");
            println!(
                "[Download] {} cannot be resumed from byte {} (HTTP 416), moving the partial to the Trash and starting over",
                id, resume_offset
            );
            let moved = tmp.clone();
            tokio::task::spawn_blocking(move || crate::commands::os_trash::system_trash(&moved))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| format!(
                    "The partial download {} cannot be continued and could not be moved to the Trash ({}). Remove it, then start the download again.",
                    tmp.display(),
                    e
                ))?;
            resume_offset = 0;
            if let Ok(mut dl) = downloads.lock() {
                if let Some(p) = dl.get_mut(id) {
                    p.progress = 0;
                }
            }
            continue;
        }
        break response;
    };

    let status = response.status();
    if !status.is_success() && status.as_u16() != 206 {
        let name = dest
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "this file".to_string());
        return Err(download_http_error(url, status.as_u16(), sent_token.is_some(), &name));
    }

    let already_on_disk = resumed_bytes(resume_offset, status.as_u16());
    let resumed = already_on_disk > 0;

    // For resumed downloads, total = content_length + offset. When the server
    // states no length at all the catalog estimate steps in for the space
    // guard, and `estimated` records that it must not be trusted with anything
    // else — see `total_size`.
    let (total, estimated) = total_size(response.content_length(), resume_offset, resumed, expected_bytes);
    if estimated {
        println!(
            "[Download] {} — the host states no Content-Length. Truncation cannot be detected by size; the space check falls back to the catalog estimate ({} bytes).",
            id, total
        );
    }

    // Stop before the first byte if the drive cannot hold the rest. Saying it
    // now costs nothing; finding out at the end costs the whole transfer and
    // leaves the machine with a full disk.
    if let Some((needed, free)) = space_shortfall(total, already_on_disk, available_space_for(dest)) {
        return Err(format!(
            "Not enough free space for {}. It still needs {} and the drive has {} free. Free up some space and start it again, the part already downloaded is kept.",
            dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "this download".to_string()),
            gib(needed),
            gib(free),
        ));
    }

    // Update total size
    if let Ok(mut dl) = downloads.lock() {
        if let Some(p) = dl.get_mut(id) {
            p.total = total;
            p.status = "downloading".to_string();
        }
    }

    let tmp_path = dest.with_extension("download");

    // Open file for writing (append if resuming)
    let mut file = if resumed {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&tmp_path)
            .await
            .map_err(|e| format!("Open file for resume: {}", os_error::english(&e)))?
    } else {
        tokio::fs::File::create(&tmp_path)
            .await
            .map_err(|e| format!("Create file: {}", os_error::english(&e)))?
    };

    // The digest is only computed when there is something to compare it
    // against. Hashing 155 GB to write the result into a log line nobody reads
    // costs the user real minutes of CPU, so an entry without a `sha256` says
    // so once, loudly, and skips the work.
    let mut hasher = match (&expected_sha256, resumed) {
        (None, _) => {
            println!(
                "[Download] {} — no sha256 in the catalog entry, content will NOT be verified (size only)",
                id
            );
            None
        }
        (Some(_), false) => Some(Sha256::new()),
        // Resuming: the bytes already on disk never passed through the hasher,
        // so replay them or the final digest is the hash of the tail alone.
        (Some(_), true) => Some(digest_of_prefix(&tmp_path, already_on_disk).await?),
    };

    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = already_on_disk;
    let start = Instant::now();
    let mut last_update = Instant::now();

    use tokio::io::AsyncWriteExt;

    loop {
        tokio::select! {
            _ = token.cancelled() => {
                file.flush().await.ok();
                drop(file);

                // Check if this is a pause or cancel
                let is_paused = if let Ok(dl) = downloads.lock() {
                    dl.get(id).map(|p| p.status == "pausing").unwrap_or(false)
                } else {
                    false
                };

                if is_paused {
                    if let Ok(mut dl) = downloads.lock() {
                        if let Some(p) = dl.get_mut(id) {
                            p.status = "paused".to_string();
                            p.progress = downloaded;
                        }
                    }
                    return Err("paused".to_string());
                } else {
                    return Err("cancelled".to_string());
                }
            }
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        file.write_all(&bytes).await.map_err(|e| format!("Write: {}", os_error::english(&e)))?;
                        if let Some(h) = hasher.as_mut() { h.update(&bytes); }
                        downloaded += bytes.len() as u64;

                        let wait = {
                            let mut slot = DOWNLOAD_NEXT_SLOT.lock().unwrap_or_else(|p| p.into_inner());
                            throttle_wait(&mut slot, DOWNLOAD_LIMIT_BPS.load(Ordering::Relaxed), bytes.len() as u64, Instant::now())
                        };
                        if !wait.is_zero() {
                            // Pause and Cancel still answer at once: the
                            // outer select sees the token on the next turn.
                            tokio::select! {
                                _ = token.cancelled() => {}
                                _ = tokio::time::sleep(wait) => {}
                            }
                        }

                        // Update progress every 500ms
                        if last_update.elapsed().as_millis() > 500 {
                            last_update = Instant::now();
                            let elapsed = start.elapsed().as_secs_f64();
                            let speed = if elapsed > 0.0 {
                                (downloaded - already_on_disk) as f64 / elapsed
                            } else {
                                0.0
                            };

                            if let Ok(mut dl) = downloads.lock() {
                                if let Some(p) = dl.get_mut(id) {
                                    p.progress = downloaded;
                                    p.speed = speed;
                                }
                            }
                        }
                    }
                    Some(Err(e)) => {
                        return Err(format!("Stream error: {}", e));
                    }
                    None => {
                        // Stream complete
                        break;
                    }
                }
            }
        }
    }

    file.flush().await.map_err(|e| format!("Flush: {}", os_error::english(&e)))?;
    drop(file);

    // A body can end early without ever erroring — a CDN cutting the connection,
    // a laptop going to sleep, an antivirus dropping the stream. Renaming a short
    // file into place is the worst outcome: the Models page tolerates rough
    // catalog sizes (50%), so the truncated model would read as "Installed" and
    // only blow up much later, when the backend tries to load it. Keep the
    // .download part instead — the next attempt resumes from there.
    //
    // `estimated` means the number in `total` is the catalog's guess, not the
    // server's statement. A guess may not fail a transfer that is in fact
    // complete, so the size check is skipped and the digest — if there is one —
    // is what stands between the user and a truncated model.
    if !estimated && ended_early(total, downloaded) {
        return Err(format!(
            "Download ended early: {} of {} bytes received. Start it again to resume.",
            downloaded, total
        ));
    }
    if estimated {
        println!(
            "[Download] {} finished at {} bytes with no size stated by the host — completeness unchecked",
            id, downloaded
        );
    }

    // Content check, when the catalog gave us something to check against. A
    // wrong file is worse than a missing one: it installs, it is listed, and it
    // blows up hours later inside a backend. So the partial goes and the error
    // names the cause instead of leaving a plausible looking model behind.
    if let (Some(expected), Some(h)) = (expected_sha256.as_deref(), hasher) {
        let actual = format!("{:x}", h.finalize());
        if actual != expected {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(format!(
                "{} does not match the checksum the catalog lists for it (expected sha256 {}, got {}). The file was discarded — the download was corrupted in transit or the host is serving different content. Start it again.",
                dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "The file".to_string()),
                expected,
                actual,
            ));
        }
        println!("[Download] {} verified against sha256 {}", id, expected);
    }

    tokio::fs::rename(&tmp_path, dest)
        .await
        .map_err(|e| format!("Rename: {}", os_error::english(&e)))?;

    // Final progress update
    if let Ok(mut dl) = downloads.lock() {
        if let Some(p) = dl.get_mut(id) {
            p.progress = downloaded;
            p.total = downloaded;
            p.status = "complete".to_string();
        }
    }

    Ok(())
}

// Phone builds register the lu-native variant from download_mobile.rs under
// the same name, and one name can carry only one command macro.
#[cfg_attr(desktop, tauri::command)]
#[cfg_attr(mobile, allow(dead_code))]
pub fn pause_download(id: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // Set status to "pausing" so the download loop knows it's a pause, not cancel
    if let Ok(mut dl) = state.downloads.lock() {
        if let Some(p) = dl.get_mut(&id) {
            if p.status != "downloading" && p.status != "connecting" {
                return Ok(serde_json::json!({"status": "not_active"}));
            }
            p.status = "pausing".to_string();
        }
    }

    // Cancel the token (the download loop checks for "pausing" status to distinguish pause from cancel)
    if let Ok(tokens) = state.download_tokens.lock() {
        if let Some(token) = tokens.get(&id) {
            token.cancel();
        }
    }

    Ok(serde_json::json!({"status": "pausing"}))
}

/// The user aborting a transfer. Stops it AND removes the partial file.
///
/// This is one of two ways an entry leaves the progress map, and the two must
/// never be confused. Cancel is a decision: the user does not want this file,
/// so the bytes on disk go with it. `clear_download_entry` is bookkeeping: the
/// row is removed, the partial stays, and the next attempt resumes from it.
///
/// Retrying a failed download used to come through HERE, which is how a short
/// network outage on a 40 GB bundle turned into a full re-download: the error
/// text promised "start it again to resume", the user pressed the button the UI
/// offered, and the button deleted the 36 GB it was about to resume from. On a
/// bad line that never converges.
// Phone builds register the lu-native variant from download_mobile.rs under
// the same name, and one name can carry only one command macro.
#[cfg_attr(desktop, tauri::command)]
#[cfg_attr(mobile, allow(dead_code))]
pub fn cancel_download(id: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // Cancel the token
    if let Ok(tokens) = state.download_tokens.lock() {
        if let Some(token) = tokens.get(&id) {
            token.cancel();
        }
    }

    // If paused or errored (no active token), clean up directly. Errored
    // entries otherwise live in the map forever and resurrect the bundle
    // card's error state on every Models-tab remount after the user hit
    // Clear — refresh() re-reads this map on mount.
    // Take the recorded destination out with the entry: guessing five
    // subfolders missed every other one (controlnet, upscale_models, clip_vision)
    // and every download_model_to_path target outside the ComfyUI tree, so those
    // partial files were left behind for good.
    let dest = if let Ok(mut dl) = state.downloads.lock() {
        match dl.get(&id) {
            Some(p) if p.status == "paused" || p.status == "error" => {
                let d = p.dest.clone();
                dl.remove(&id);
                Some(d)
            }
            _ => None,
        }
    } else {
        None
    };

    if let Some(dest) = dest {
        if !dest.is_empty() {
            remove_partial(&dest);
        } else if let Ok(comfy_path) = state.comfy_path.lock() {
            // Entry from before `dest` existed — fall back to the old guess.
            if let Some(ref path) = *comfy_path {
                for subfolder in &["diffusion_models", "checkpoints", "vae", "text_encoders", "loras"] {
                    let tmp = PathBuf::from(path).join("models").join(subfolder).join(&id).with_extension("download");
                    let _ = std::fs::remove_file(&tmp);
                }
            }
        }
    }

    Ok(serde_json::json!({"status": "cancelled"}))
}

/// Which file goes when the download of a model is cancelled after its image
/// part already finished: the part, and only the part.
///
/// A model with image input is two files and one download. The part is the
/// small one, so it is usually complete long before the model is, and a cancel
/// that only stopped the model left a file of several hundred megabytes behind
/// that belongs to nothing and that no list in the app shows.
///
/// Three things have to hold, or nothing is deleted: the name is one this app
/// gives an image part (`<model>.mmproj.gguf`, no path in it), the file lies
/// directly in `dir`, and the model it belongs to is NOT there. The last one is
/// what keeps this from ever taking the part of an installed model.
pub(crate) fn image_part_to_remove(dir: &Path, filename: &str) -> Result<Option<PathBuf>, String> {
    let lower = filename.to_ascii_lowercase();
    if sanitize_filename(filename) != filename || !lower.ends_with(".mmproj.gguf") {
        return Err("Only the image part of a model can be removed here.".to_string());
    }
    let part = dir.join(filename);
    if !part.is_file() {
        return Ok(None);
    }
    let stem = &filename[..filename.len() - ".mmproj.gguf".len()];
    let model_is_there = std::fs::read_dir(dir)
        .map_err(|e| format!("Could not read the model folder: {}", os_error::english(&e)))?
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .any(|name| name.eq_ignore_ascii_case(&format!("{stem}.gguf")));
    if model_is_there {
        return Err("The model this image part belongs to is installed, so the part stays.".to_string());
    }
    Ok(Some(part))
}

/// Remove the finished image part of a model whose download was cancelled.
/// See `image_part_to_remove` for what it refuses.
#[tauri::command]
#[allow(non_snake_case)]
pub fn remove_image_part(destDir: String, filename: String) -> Result<serde_json::Value, String> {
    match image_part_to_remove(Path::new(&destDir), &filename)? {
        Some(part) => {
            std::fs::remove_file(&part)
                .map_err(|e| format!("Could not delete {}: {}", part.display(), os_error::english(&e)))?;
            Ok(serde_json::json!({ "removed": true }))
        }
        None => Ok(serde_json::json!({ "removed": false })),
    }
}

#[cfg(test)]
mod image_part_removal_tests {
    use super::image_part_to_remove;

    #[test]
    fn the_finished_part_of_a_cancelled_model_goes_and_nothing_else_does() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("Qwen3.5-9B-abliterated.Q4_K_M.mmproj.gguf");
        std::fs::write(&part, b"part").unwrap();
        // The model was cancelled: its partial is gone, the model never landed.
        assert_eq!(
            image_part_to_remove(dir.path(), "Qwen3.5-9B-abliterated.Q4_K_M.mmproj.gguf").unwrap(),
            Some(part)
        );
        // Nothing there is not an error, there is simply nothing to remove.
        assert_eq!(image_part_to_remove(dir.path(), "other.mmproj.gguf").unwrap(), None);
    }

    #[test]
    fn the_part_of_an_installed_model_is_never_taken() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("m.Q4_K_M.gguf"), b"model").unwrap();
        std::fs::write(dir.path().join("m.Q4_K_M.mmproj.gguf"), b"part").unwrap();
        let refused = image_part_to_remove(dir.path(), "m.Q4_K_M.mmproj.gguf").unwrap_err();
        assert!(refused.contains("installed"), "{refused}");
        assert!(dir.path().join("m.Q4_K_M.mmproj.gguf").is_file());
    }

    #[test]
    fn a_model_or_a_path_is_refused_by_name() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("m.gguf"), b"model").unwrap();
        for name in ["m.gguf", "../m.mmproj.gguf", "sub/m.mmproj.gguf", "mmproj-F16.gguf"] {
            assert!(image_part_to_remove(dir.path(), name).is_err(), "{name}");
        }
    }
}

/// Take a SETTLED entry out of the progress map and leave the disk alone.
///
/// The counterpart to `cancel_download`. The frontend has to clear the Rust
/// entry before a retry, or `download_model` short-circuits on the file that is
/// already there, never touches the map, and the next poll resurrects the error
/// row the user just retried. Doing that through cancel meant
/// paying for the bookkeeping with the partial file — several gigabytes for a
/// map key.
///
/// Refuses to touch a transfer that is still live: "connecting", "downloading"
/// and "pausing" own their entry, and dropping it under them would leave a
/// running tokio task writing into a file nothing knows about.
// Phone builds register the lu-native variant from download_mobile.rs under
// the same name, and one name can carry only one command macro.
#[cfg_attr(desktop, tauri::command)]
#[cfg_attr(mobile, allow(dead_code))]
pub fn clear_download_entry(id: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut dl = state
        .downloads
        .lock()
        .map_err(|_| "Download state is poisoned".to_string())?;
    match dl.get(&id) {
        Some(p) if !clearable(&p.status) => Ok(serde_json::json!({"status": "still_active"})),
        Some(_) => {
            dl.remove(&id);
            Ok(serde_json::json!({"status": "cleared"}))
        }
        None => Ok(serde_json::json!({"status": "not_found"})),
    }
}

/// May this entry be dropped from the map without stopping anything?
///
/// A live transfer owns its entry: the tokio task writes progress into it and
/// the cancel token is looked up by the same id, so removing it under a running
/// download would leave a writer nothing can reach.
pub fn clearable(status: &str) -> bool {
    !matches!(status, "connecting" | "downloading" | "pausing")
}

/// Remove the partial belonging to `dest`. Reports whether a file went.
///
/// Deliberately its own function with exactly ONE caller, `cancel_download`.
/// Deleting a partial is a user decision, never a side effect of tidying up
/// state — see the note on `cancel_download`.
fn remove_partial(dest: &str) -> bool {
    if dest.is_empty() {
        return false;
    }
    std::fs::remove_file(PathBuf::from(dest).with_extension("download")).is_ok()
}

/// Bytes that transfers already in flight still have to write.
///
/// The per-download space check answers "does the rest of THIS file fit", which
/// is the wrong question when a bundle starts four files at once: each of the
/// four passed against the same free bytes, all four started, and the drive
/// filled anyway. Whatever is still owed counts as taken.
pub fn reserved_bytes(downloads: &HashMap<String, DownloadProgress>) -> u64 {
    downloads
        .values()
        .filter(|p| matches!(p.status.as_str(), "connecting" | "downloading" | "pausing"))
        .map(|p| p.total.saturating_sub(p.progress))
        .sum()
}

/// Does `requiredBytes` still fit next to everything already in flight?
///
/// Asked ONCE for a whole bundle before the first transfer starts, which is the
/// only place the question can be answered honestly — see `reserved_bytes`.
/// Returns the numbers as well as the verdict so the caller can put real
/// gigabytes in front of the user instead of "not enough space".
#[allow(non_snake_case)]
#[tauri::command]
pub async fn check_download_space(
    subfolder: Option<String>,
    destDir: Option<String>,
    requiredBytes: u64,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let dir = match (subfolder, destDir) {
        (_, Some(d)) if !d.is_empty() => PathBuf::from(d),
        (Some(sub), _) => {
            let comfy_path = state.comfy_path.lock().unwrap().clone();
            // R1-4: engine_folders asks the running ComfyUI fresh instead of
            // reading a cache that can predate it, a cold cache pointed the
            // very first space check of a session at the wrong drive (K5's
            // customer-visible half of the same bug).
            comfy_models_path(&state, &comfy_path, &sub).await?
        }
        _ => return Err("check_download_space needs a subfolder or a destDir".to_string()),
    };

    let reserved = state
        .downloads
        .lock()
        .map(|dl| reserved_bytes(&dl))
        .unwrap_or(0);
    let available = available_space_for(&dir);
    let shortfall = space_shortfall_keeping(requiredBytes.saturating_add(reserved), 0, available, BUNDLE_SPACE_RESERVE);

    Ok(match shortfall {
        None => serde_json::json!({
            "fits": true,
            "requiredBytes": requiredBytes,
            "reservedBytes": reserved,
            "availableBytes": available,
        }),
        Some((needed, free)) => serde_json::json!({
            "fits": false,
            "requiredBytes": requiredBytes,
            "reservedBytes": reserved,
            "availableBytes": available,
            "message": bundle_space_message(requiredBytes, reserved, needed, free),
        }),
    })
}

/// A `.download` temp file with nobody watching it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanDownload {
    /// Basename without the `.download` suffix.
    ///
    /// NOT the download id. `Path::with_extension` REPLACES the extension, so
    /// the partial for `wan_2.1_vae.safetensors` is `wan_2.1_vae.download` and
    /// the original suffix is simply gone. The real filename is recovered on the
    /// frontend by matching this stem against the download meta it persisted and
    /// against the catalog — see `orphanFilename` in src/api/discover.ts.
    pub stem: String,
    /// Absolute path OF THE PARTIAL.
    pub path: String,
    /// Directory it sits in — the `destDir` a resume needs for a GGUF that does
    /// not live under the ComfyUI tree.
    pub dir: String,
    pub bytes: u64,
}

/// Basename minus its extension. The one place the `.download` naming rule is
/// read, so the orphan scan and the id matching cannot drift apart.
pub(crate) fn file_stem_of(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem.to_string(),
        _ => name.to_string(),
    }
}

/// Every root a `.download` file may legitimately live under.
///
/// Also the jail for `delete_orphan_download`: a path handed back to us is only
/// deleted when it still sits under one of these, so a crafted argument cannot
/// turn the sweeper into a "delete any file" command.
fn orphan_roots(state: &State<'_, AppState>, extra: &[String]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let comfy_path = state.comfy_path.lock().map(|p| p.clone()).unwrap_or(None);
    if let Some(ref path) = comfy_path {
        roots.push(PathBuf::from(path).join("models"));
        roots.push(PathBuf::from(path).join("custom_nodes"));
        // GH #183: downloads write into the configured shared folders now,
        // so a partial left there must be found and may be swept.
        for dir in comfy_user_paths::for_comfy(&comfy_path).all_dirs() {
            if !roots.contains(&dir) {
                roots.push(dir);
            }
        }
    }
    if let Ok(p) = crate::commands::engine::builtin_models_dir() {
        roots.push(p);
    }
    // Provider model dirs (LM Studio, Ollama, a custom path) are only known to
    // the frontend, which persists the destDir of every download it started.
    for d in extra {
        if d.is_empty() {
            continue;
        }
        let p = PathBuf::from(d);
        if p.is_absolute() {
            roots.push(p);
        }
    }
    roots
}

/// Partial downloads left behind by a previous run of the app.
///
/// Both sides of the download kept their state purely in RAM, so closing the
/// app during a multi-gigabyte transfer left the `.download` file on disk with
/// no row, no button and no way to finish or remove it — the bytes were simply
/// unreachable. This is the missing half: the disk still knows what was in
/// flight, so ask it.
///
/// Entries the running app is already working on are left out: those are not
/// orphans, they have a row.
#[allow(non_snake_case)]
// Phone builds register the lu-native variant from download_mobile.rs under
// the same name, and one name can carry only one command macro.
#[cfg_attr(desktop, tauri::command)]
#[cfg_attr(mobile, allow(dead_code))]
pub async fn find_orphan_downloads(
    extraDirs: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Vec<OrphanDownload>, String> {
    let extra = extraDirs.unwrap_or_default();
    let roots = orphan_roots(&state, &extra);
    // The map is keyed by full filename, the partial keeps only the stem, so the
    // comparison happens on stems.
    let live: Vec<String> = state
        .downloads
        .lock()
        .map(|dl| dl.keys().map(|k| file_stem_of(k)).collect())
        .unwrap_or_default();

    // Off the main thread: this runs at startup and a ComfyUI install with a
    // few dozen node packs is tens of thousands of directory entries. Freezing
    // the window to look for leftovers would be its own bug.
    tokio::task::spawn_blocking(move || scan_for_partials(roots, live))
        .await
        .map_err(|e| format!("Orphan scan failed: {}", e))
}

/// Directories that never hold a model and always hold thousands of files.
/// Skipping them is what keeps the startup scan off the user's clock.
const SCAN_SKIP: &[&str] = &[".git", "__pycache__", "node_modules", ".venv", "venv", ".cache"];

pub(crate) fn scan_for_partials(roots: Vec<PathBuf>, live: Vec<String>) -> Vec<OrphanDownload> {
    let mut out: Vec<OrphanDownload> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        // Depth 4 covers models/<subfolder>/<nested enum dir>/<file> and the
        // AnimateDiff pack's models dir under custom_nodes, without descending
        // into a whole ComfyUI checkout.
        let walk = walkdir::WalkDir::new(&root).max_depth(4).into_iter().filter_entry(|e| {
            !e.file_type().is_dir()
                || e.depth() == 0
                || !e.file_name().to_str().is_some_and(|n| SCAN_SKIP.contains(&n))
        });
        for entry in walk.filter_map(|e| e.ok()) {
            let p = entry.path();
            if !entry.file_type().is_file() || p.extension().and_then(|e| e.to_str()) != Some("download") {
                continue;
            }
            if !seen.insert(p.to_path_buf()) {
                continue;
            }
            let stem = match p.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            if live.contains(&stem) {
                continue;
            }
            out.push(OrphanDownload {
                stem,
                path: p.to_string_lossy().to_string(),
                dir: p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default(),
                bytes: entry.metadata().map(|m| m.len()).unwrap_or(0),
            });
        }
    }
    // Biggest first: that is the one whose loss would hurt most.
    out.sort_by_key(|o| std::cmp::Reverse(o.bytes));
    out
}

/// Delete one orphaned partial, on the user's explicit say-so.
///
/// Jailed to `orphan_roots` and to the `.download` suffix, because the argument
/// travels through the frontend and back: without both checks this would be a
/// command that deletes any path the webview asks for.
#[allow(non_snake_case)]
#[tauri::command]
pub fn delete_orphan_download(
    path: String,
    extraDirs: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let p = PathBuf::from(&path);
    if p.extension().and_then(|e| e.to_str()) != Some("download") {
        return Err("Only .download partials can be removed here".to_string());
    }
    let extra = extraDirs.unwrap_or_default();
    if !orphan_roots(&state, &extra).iter().any(|r| p.starts_with(r)) {
        return Err("That path is not inside a model folder this app downloads into".to_string());
    }
    let bytes = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
    fs::remove_file(&p).map_err(|e| format!("Delete failed: {}", os_error::english(&e)))?;
    println!("[Download] Removed orphaned partial {} ({} bytes)", p.display(), bytes);
    Ok(serde_json::json!({"status": "deleted", "bytes": bytes}))
}

#[allow(non_snake_case)]
// Phone builds register the lu-native variant from download_mobile.rs under
// the same name, and one name can carry only one command macro.
#[cfg_attr(desktop, tauri::command)]
#[cfg_attr(mobile, allow(dead_code))]
pub async fn resume_download(
    id: String,
    url: String,
    subfolder: String,
    expectedBytes: Option<u64>,
    expectedSha256: Option<String>,
    authToken: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let expected_bytes = expectedBytes;
    let expected_sha256 = match expectedSha256.as_deref() {
        Some(s) => Some(normalize_sha256(s)?),
        None => None,
    };
    let auth_token = authToken;
    let comfy_path = {
        let p = state.comfy_path.lock().unwrap();
        p.clone()
    };

    let dest_dir = comfy_models_dir(&state, &comfy_path, &subfolder).await?;
    let dest_file = dest_dir.join(&id);
    let tmp_path = dest_file.with_extension("download");

    let resume_offset = if tmp_path.exists() {
        tmp_path.metadata().map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    // Same claim as a fresh start: resuming a transfer that is already running
    // would put a second writer on the temp file.
    {
        let mut downloads = state.downloads.lock().unwrap();
        match claim_download(&mut downloads, &id, &id.clone(), &dest_file, resume_offset) {
            Claim::Ok => {}
            Claim::AlreadyRunning => {
                return Ok(serde_json::json!({"status": "already_running", "id": id}));
            }
            Claim::NameConflict(other) => {
                return Ok(serde_json::json!({
                    "status": "error",
                    "error": format!("Another download is already writing a file called {id} (to {other})."),
                }));
            }
        }
    }

    // Create new cancellation token
    let token = CancellationToken::new();
    {
        let mut tokens = state.download_tokens.lock().unwrap();
        tokens.insert(id.clone(), token.clone());
    }

    let downloads_arc = Arc::clone(&state.downloads);
    let tokens_arc = Arc::clone(&state.download_tokens);
    let id_clone = id.clone();

    tokio::spawn(async move {
        match do_download(&url, &dest_file, &downloads_arc, &id_clone, token, resume_offset,
                        CatalogClaims { expected_bytes, expected_sha256, auth_token }).await {
            Ok(_) => {
                if let Ok(mut dl) = downloads_arc.lock() {
                    if let Some(p) = dl.get_mut(&id_clone) {
                        p.status = "complete".to_string();
                    }
                }
                println!("[Download] Complete: {}", id_clone);
            }
            Err(e) => {
                if e == "paused" {
                    println!("[Download] Paused: {}", id_clone);
                } else if e == "cancelled" {
                    let tmp = dest_file.with_extension("download");
                    let _ = std::fs::remove_file(&tmp);
                    if let Ok(mut dl) = downloads_arc.lock() {
                        dl.remove(&id_clone);
                    }
                    println!("[Download] Cancelled: {}", id_clone);
                } else {
                    if let Ok(mut dl) = downloads_arc.lock() {
                        if let Some(p) = dl.get_mut(&id_clone) {
                            p.status = "error".to_string();
                            p.error = Some(e.clone());
                        }
                    }
                    println!("[Download] Failed: {} - {}", id_clone, e);
                }
            }
        }
        if let Ok(mut tokens) = tokens_arc.lock() {
            tokens.remove(&id_clone);
        }
    });

    Ok(serde_json::json!({"status": "resuming", "offset": resume_offset}))
}

// Phone builds register the lu-native variant from download_mobile.rs under
// the same name, and one name can carry only one command macro.
#[cfg_attr(desktop, tauri::command)]
#[cfg_attr(mobile, allow(dead_code))]
pub fn download_progress(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let downloads = state.downloads.lock().unwrap();
    let map: HashMap<String, DownloadProgress> = downloads.clone();
    Ok(serde_json::to_value(map).unwrap_or_default())
}

// ─── HuggingFace GGUF Downloads (to provider model dirs) ───

/// The names the built-in engine goes by. The Discover tab passes the display
/// name (`providers.openai.name`), not the internal id.
///
/// Written as a `match` with the arm on one line: the sweep for the old name
/// on screen exempts exactly that line (`no-built-in-engine-left-on-screen`).
#[allow(clippy::match_like_matches_macro)]
pub(crate) fn is_builtin_provider(provider_lower: &str) -> bool {
    match provider_lower {
        "builtin" | "lu engine" | "built-in engine" | "built in engine" => true,
        _ => false,
    }
}

#[tauri::command]
pub fn detect_model_path(provider: String) -> Result<serde_json::Value, String> {
    let provider_lower = provider.to_lowercase();

    // The built-in engine is answered BEFORE anyone asks for a home folder.
    // A phone has none (Android: no HOME, no XDG, cwd `/`), and with the
    // home lookup in front this command failed with "Cannot find home
    // directory" for the one provider a phone has, so the first model could
    // never be downloaded (Android finding A14).
    if is_builtin_provider(&provider_lower) {
        return crate::commands::engine::builtin_models_dir()
            .map(|p| serde_json::json!(p.to_string_lossy()));
    }

    let home = dirs::home_dir().ok_or("Cannot find home directory")?;

    // Providers with managed model directories. Checked in order, first
    // existing path wins. Falls through to LU fallback dir if none match —
    // that dir is then indexed by LU's own scanner (future work) or the
    // user can point their backend at it manually.
    //
    // Covers the 15 providers in src/api/providers/types.ts — only the ones
    // with a conventional managed dir (most CLI-run backends take a path
    // arg, so there's no one-true-path for them).
    let candidates: Vec<PathBuf> = match provider_lower.as_str() {
        // Built-in engine (P1): app-owned models dir. Handled before the
        // detection loop below because it must be auto-created on a fresh box —
        // returned directly here so onboarding can download into it immediately.
        // Accept the display name too ("Built-in Engine") — the Discover tab
        // passes `providers.openai.name`, not the internal id, so without these
        // aliases a built-in-active install couldn't add a second chat model.
        //
        // That answer is given at the top of this function now, before the
        // home lookup, so no arm for those names is left in this match.
        // Ollama manages its own blob store — treat as a pointer so LU can
        // later auto-create a Modelfile pointing at the downloaded GGUF.
        "ollama" => vec![
            home.join(".ollama").join("models"),
        ],
        // LM Studio 0.3.x+ uses ~/.lmstudio/models (Windows/Mac/Linux).
        // Legacy 0.2.x used ~/.cache/lm-studio/models.
        "lm studio" | "lmstudio" => vec![
            home.join(".lmstudio").join("models"),
            home.join(".cache").join("lm-studio").join("models"),
        ],
        // Jan: modern installers on Windows write to %APPDATA%\Jan\data\models,
        // Mac/Linux fall back to ~/jan/models.
        "jan" => vec![
            dirs::data_dir().unwrap_or_else(|| home.clone()).join("Jan").join("data").join("models"),
            home.join(".jan").join("models"),
            home.join("jan").join("models"),
        ],
        // GPT4All: Windows ships %LOCALAPPDATA%\nomic.ai\GPT4All. Mac/Linux
        // use ~/.cache/gpt4all. We check both.
        "gpt4all" => vec![
            dirs::data_local_dir().unwrap_or_else(|| home.clone()).join("nomic.ai").join("GPT4All"),
            home.join(".cache").join("gpt4all"),
        ],
        // LocalAI: single conventional path.
        "localai" => vec![
            home.join(".localai").join("models"),
        ],
        // text-generation-webui (aka oobabooga): installs into its own folder,
        // no one-true-path. Check common locations.
        "oobabooga" | "text-generation-webui" | "tgw" => vec![
            home.join("text-generation-webui").join("models"),
            home.join("oobabooga").join("models"),
        ],
        // KoboldCpp: single-binary, model dir next to the binary or ~ default.
        "koboldcpp" | "kobold" => vec![
            home.join(".koboldcpp").join("models"),
            home.join("koboldcpp").join("models"),
        ],
        // llama.cpp: no managed dir — users typically keep GGUFs anywhere.
        // We default to ~/models (common convention when running server.sh).
        "llama.cpp" | "llamacpp" | "llama-cpp" => vec![
            home.join("models"),
            home.join("llama.cpp").join("models"),
        ],
        // vLLM, SGLang, TabbyAPI, Aphrodite, TGI: all CLI-run, no conventional
        // dir. Fall through to LU's fallback.
        //
        // Cloud providers (OpenRouter, Groq, Together, DeepSeek, Mistral,
        // OpenAI, Custom) don't use a local model dir at all.
        _ => vec![],
    };

    for path in &candidates {
        if path.exists() {
            return Ok(serde_json::json!(path.to_string_lossy()));
        }
    }

    // No managed dir exists yet for this provider. For the two providers LU
    // actively writes downloads into (Ollama, LM Studio), pre-create the
    // conventional path so the first download just works on a fresh box —
    // this is the Plug & Play path. Frontend gating ensures we only ever
    // direct-write into the LM Studio dir; Ollama's path is here purely so
    // legacy callers don't get an Err — see download_model_to_path callers.
    //
    // The previous `~/locally-uncensored/models` fallback was unreachable
    // by any backend and produced the "downloaded but invisible" bug
    // (Discord, GH disc #35). We remove it: if a
    // user picked a backend with no conventional dir, return an explicit
    // error so the UI can show a real message instead of silently writing
    // into a junk folder.
    match provider_lower.as_str() {
        "ollama" => {
            let p = home.join(".ollama").join("models");
            fs::create_dir_all(&p).map_err(|e| format!("Create Ollama models dir: {}", os_error::english(&e)))?;
            Ok(serde_json::json!(p.to_string_lossy()))
        }
        "lm studio" | "lmstudio" => {
            let p = home.join(".lmstudio").join("models");
            fs::create_dir_all(&p).map_err(|e| format!("Create LM Studio models dir: {}", os_error::english(&e)))?;
            Ok(serde_json::json!(p.to_string_lossy()))
        }
        _ => Err(format!(
            "No conventional model directory for provider '{}'. Configure a custom path in Settings → Models, or pick a backend (Ollama / LM Studio) with a known model location.",
            provider
        )),
    }
}

/// Where LM Studio keeps its models, and whether LM Studio is on this machine
/// at all. Reads only: nothing is created.
///
/// `detect_model_path` cannot answer this. It is a DOWNLOAD TARGET, so for
/// Ollama and LM Studio it creates the folder when it is missing, which is
/// right for a download and wrong for a panel whose whole job is to say
/// "LM Studio is not installed". Asking it here would create
/// `~/.lmstudio/models` on a machine that has never seen LM Studio and then
/// report that folder as evidence of an install.
///
/// Installed is answered from the folder first because that is free on every
/// platform, and only then from `install::lmstudio_installed()`, which knows
/// the `lms` CLI and, on macOS, the app bundle. A user who has LM Studio but
/// has not downloaded a model yet is therefore still recognised.
///
/// ASYNC + spawn_blocking, the same shape as `list_bundled_models`: a
/// SYNCHRONOUS Tauri command runs on the MAIN thread, and neither half of this
/// one is cheap enough for that. `lmstudio_dir_in` touches the disk, and
/// `lmstudio_installed()` walks several fixed paths and falls back to a `which`
/// lookup, which spawns a process. Settings opens this on mount, so that was
/// the window freezing while a panel drew one line of grey text. That is the
/// same mistake the Mac ComfyUI search made in 2.6.8, one door further along.
#[tauri::command]
pub async fn lmstudio_model_dir() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(lmstudio_model_dir_blocking)
        .await
        .map_err(|e| format!("lmstudio_model_dir task: {e}"))?
}

fn lmstudio_model_dir_blocking() -> Result<serde_json::Value, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let found = lmstudio_dir_in(&home);
    let installed = found.is_some() || crate::commands::install::lmstudio_installed();
    Ok(serde_json::json!({
        "installed": installed,
        "path": found.map(|p| p.to_string_lossy().to_string()),
    }))
}

/// The LM Studio models folder under a given home, or None. Creates nothing.
///
/// Split out from the command so the "creates nothing" half can be proven
/// against a throwaway home directory instead of the tester's own.
///
/// Same two candidates and the same order as detect_model_path: LM Studio
/// 0.3.x writes ~/.lmstudio/models on all three platforms, 0.2.x used
/// ~/.cache/lm-studio/models.
pub fn lmstudio_dir_in(home: &Path) -> Option<PathBuf> {
    [
        home.join(".lmstudio").join("models"),
        home.join(".cache").join("lm-studio").join("models"),
    ]
    .into_iter()
    .find(|p| p.is_dir())
}

#[allow(non_snake_case)]
// Phone builds register the lu-native variant from download_mobile.rs under
// the same name, and one name can carry only one command macro.
#[cfg_attr(desktop, tauri::command)]
#[cfg_attr(mobile, allow(dead_code))]
pub async fn download_model_to_path(
    url: String,
    destDir: String,
    filename: String,
    expectedBytes: Option<u64>,
    expectedSha256: Option<String>,
    // The CivitAI API key, when the caller has one: a LoRA from the CivitAI
    // search into the Mac's LoRA folder. Sent ONLY to a CivitAI host (see
    // do_download). Absent for the text-model lane, which is every other
    // caller.
    authToken: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let dest_dir = destDir;
    let auth_token = authToken;
    let expected_bytes = expectedBytes;
    let expected_sha256 = match expectedSha256.as_deref() {
        Some(s) => Some(normalize_sha256(s)?),
        None => None,
    };
    let dir = PathBuf::from(&dest_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("Create dest dir: {}", os_error::english(&e)))?;
    let dest_file = dir.join(sanitize_filename(&filename));

    if dest_file.exists() {
        // Same rule as download_model: only a size the SERVER states may call a
        // file complete. The catalog estimate with 10 % of slack used to accept
        // a transfer that died at 91 %.
        let actual = dest_file.metadata().map(|m| m.len()).unwrap_or(0);
        match judge_existing(actual, exact_remote_size(&url).await) {
            Existing::Complete => {
                return Ok(serde_json::json!({"status": "exists", "path": dest_file.to_string_lossy()}));
            }
            Existing::Mismatch { actual, exact } => {
                println!(
                    "[Download] {} exists with {} bytes but the host states {} — fetching it again",
                    filename, actual, exact
                );
            }
            Existing::Unverified { actual } => {
                println!(
                    "[Download] {} exists with {} bytes and the host states no size — accepted UNVERIFIED",
                    filename, actual
                );
                return Ok(serde_json::json!({"status": "exists", "path": dest_file.to_string_lossy()}));
            }
        }
    }

    let id = filename.clone();
    let tmp_path = dest_file.with_extension("download");
    let resume_offset = if tmp_path.exists() {
        tmp_path.metadata().map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    match claim_download(&mut state.downloads.lock().unwrap(), &id, &filename, &dest_file, resume_offset) {
        Claim::Ok => {}
        Claim::AlreadyRunning => {
            return Ok(serde_json::json!({"status": "already_running", "id": id}));
        }
        Claim::NameConflict(other) => {
            return Ok(serde_json::json!({
                "status": "error",
                "error": format!("Another download is already writing a file called {filename} (to {other}). Wait for it to finish, then start this one again."),
            }));
        }
    }

    let token = CancellationToken::new();
    {
        let mut tokens = state.download_tokens.lock().unwrap();
        tokens.insert(id.clone(), token.clone());
    }

    let downloads_arc = Arc::clone(&state.downloads);
    let tokens_arc = Arc::clone(&state.download_tokens);
    let id_clone = id.clone();
    let filename_clone = filename.clone();

    tokio::spawn(async move {
        // The token is there only for a CivitAI LoRA on the Mac. The
        // text-model lane (HuggingFace GGUFs into the app models dir) sends
        // none, and do_download hands one to a CivitAI host alone.
        match do_download(&url, &dest_file, &downloads_arc, &id_clone, token, resume_offset,
                        CatalogClaims { expected_bytes, expected_sha256, auth_token }).await {
            Ok(_) => {
                if let Ok(mut dl) = downloads_arc.lock() {
                    if let Some(p) = dl.get_mut(&id_clone) {
                        p.status = "complete".to_string();
                    }
                }
                println!("[Download] Complete: {} -> {}", filename_clone, dest_dir);
            }
            Err(e) => {
                if e == "paused" {
                    println!("[Download] Paused: {}", filename_clone);
                } else if e == "cancelled" {
                    let tmp = dest_file.with_extension("download");
                    let _ = std::fs::remove_file(&tmp);
                    if let Ok(mut dl) = downloads_arc.lock() {
                        dl.remove(&id_clone);
                    }
                } else if let Ok(mut dl) = downloads_arc.lock() {
                    if let Some(p) = dl.get_mut(&id_clone) {
                        p.status = "error".to_string();
                        p.error = Some(e.clone());
                    }
                }
            }
        }
        if let Ok(mut tokens) = tokens_arc.lock() {
            tokens.remove(&id_clone);
        }
    });

    Ok(serde_json::json!({"status": "started", "id": id}))
}

// ─── File Size Validation ───

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckFileRequest {
    pub subfolder: String,
    pub filename: String,
    pub expected_bytes: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckFileResult {
    pub filename: String,
    pub exists: bool,
    pub actual_bytes: u64,
    pub complete: bool,
}

/// Resolve one `check_model_sizes` entry to a path that is guaranteed to sit
/// inside `dest_dir`.
///
/// The filename can arrive straight out of a ComfyUI answer (`/embeddings`,
/// `/object_info`), so it gets the same jail the delete path uses: a nested
/// enum name like "sdxl/pony.safetensors" keeps its relative dir, but an
/// absolute path, a drive letter or any `..` segment is refused. Without this,
/// `Path::join` silently drops `dest_dir` for an absolute name and turns the
/// size probe into an existence and size oracle for arbitrary paths on the
/// customer's machine. Returns None when the name has to be refused; the
/// caller then answers "not found" instead of touching the disk.
fn checked_model_path(dest_dir: &Path, filename: &str) -> Option<PathBuf> {
    let (sub, base) = split_model_ref(filename);
    if !sub.is_empty() && safe_subfolder(&sub).is_err() {
        return None;
    }
    let base = sanitize_filename(&base);
    if sub.is_empty() {
        Some(dest_dir.join(&base))
    } else {
        Some(dest_dir.join(&sub).join(&base))
    }
}

/// Where `download_model` puts `filename` of `subfolder`: the same ComfyUI
/// folder (the running engine's own answer first, a ComfyUI on another machine
/// in the Storage folder) and the same jail as `check_model_sizes`. Used
/// by Check files and Repair (model_verify.rs), so the check can never look in
/// another tree than the download wrote into. `None` for a name that has to be
/// refused.
pub(crate) async fn model_file_path(
    state: &State<'_, AppState>,
    subfolder: &str,
    filename: &str,
) -> Result<Option<PathBuf>, String> {
    let comfy_path = {
        let mut p = state.comfy_path.lock().unwrap();
        if p.is_none() {
            if let Some(found) = crate::commands::process::find_comfyui_path() {
                *p = Some(found);
            }
        }
        p.clone()
    };
    let dir = comfy_models_path(state, &comfy_path, subfolder).await?;
    let target = checked_model_path(&dir, filename);
    if target.as_ref().map(|p| p.exists()).unwrap_or(true) || remote_comfy(state).is_some() {
        return Ok(target);
    }
    // GH #183: a file from before the configured folder was honoured is still
    // in the instance folder. Check that one rather than calling it missing.
    let user = comfy_user_paths::for_comfy(&comfy_path);
    let folders = engine_folders(state).await;
    Ok(existing_elsewhere(&user, folders.as_ref(), &comfy_path, subfolder, filename).or(target))
}

/// Every other folder a file of `subfolder` may already sit in: the user's
/// configured ones, the engine's, and the instance's own `models/<key>`. In
/// that order, the first existing file wins. The write target is not in here;
/// the caller has looked there already.
fn existing_elsewhere(
    user: &comfy_user_paths::UserComfyPaths,
    folders: Option<&comfy_folders::ComfyFolders>,
    comfy_path: &Option<String>,
    subfolder: &str,
    filename: &str,
) -> Option<PathBuf> {
    if safe_subfolder(subfolder).is_err() || subfolder.contains('/') || subfolder.contains('\\') {
        return None;
    }
    let mut dirs: Vec<PathBuf> = user.dirs_for(subfolder);
    if let Some(f) = folders {
        dirs.extend(f.dirs_for(subfolder));
    }
    if let Some(base) = comfy_path {
        dirs.push(PathBuf::from(base).join("models").join(subfolder));
    }
    dirs.iter()
        .filter_map(|d| checked_model_path(d, filename))
        .find(|p| p.is_file())
}

#[tauri::command]
pub async fn check_model_sizes(
    files: Vec<CheckFileRequest>,
    state: State<'_, AppState>,
) -> Result<Vec<CheckFileResult>, String> {
    let comfy_path = {
        let mut p = state.comfy_path.lock().unwrap();
        if p.is_none() {
            if let Some(found) = crate::commands::process::find_comfyui_path() {
                *p = Some(found);
            }
        }
        p.clone()
    };
    // The same folders the download wrote into. Asking the old way here would
    // measure a tree nothing was written to and report every file as missing.
    let folders = engine_folders(&state).await;
    // A ComfyUI on another machine: the files are measured where they were
    // written, in the Storage folder (GH #143).
    let remote = remote_comfy(&state);
    // Read once for the whole list (GH #183).
    let user = comfy_user_paths::for_comfy(&comfy_path);

    Ok(files
        .iter()
        .map(|file| check_one_file(file, remote.as_ref().map(|r| r.root.as_path()), &user, folders.as_ref(), &comfy_path))
        .collect())
}

/// One entry of `check_model_sizes`, measured without the command's state.
fn check_one_file(
    file: &CheckFileRequest,
    remote_root: Option<&Path>,
    user: &comfy_user_paths::UserComfyPaths,
    folders: Option<&comfy_folders::ComfyFolders>,
    comfy_path: &Option<String>,
) -> CheckFileResult {
    let dest = match remote_root {
        Some(root) => remote_models_path(root, &file.subfolder),
        None => models_path_with(user, folders, comfy_path, &file.subfolder),
    };
    let dest_dir = match dest {
        Ok(d) => d,
        Err(_) => {
            return CheckFileResult {
                filename: file.filename.clone(),
                exists: false,
                actual_bytes: 0,
                complete: false,
            };
        }
    };

    let dest_file = match checked_model_path(&dest_dir, &file.filename) {
        // GH #183: a model downloaded before the configured folder was
        // honoured still counts as installed where it is.
        Some(p) if !p.exists() && remote_root.is_none() => {
            existing_elsewhere(user, folders, comfy_path, &file.subfolder, &file.filename).unwrap_or(p)
        }
        Some(p) => p,
        None => {
            return CheckFileResult {
                filename: file.filename.clone(),
                exists: false,
                actual_bytes: 0,
                complete: false,
            };
        }
    };
    if dest_file.exists() {
        let actual = dest_file.metadata().map(|m| m.len()).unwrap_or(0);
        // Use 50% threshold for install checks, since sizeGB values are rough estimates
        // (e.g. sizeGB: 0.9 for an 800 MB file), so no tighter bound is possible
        // from a catalog number alone. This answers "is there a plausible file
        // here" for the card, NOT "is this the whole file".
        //
        // The exact question is settled where it can be: download_model asks the
        // host for the byte count and compares to the byte (`judge_existing`), and
        // do_download verifies the digest when the entry carries one. The 90 %
        // rule that used to live there is gone: a threshold may size a card, it
        // may never certify a model.
        let threshold = if file.expected_bytes > 0 {
            (file.expected_bytes as f64 * 0.5) as u64
        } else {
            0
        };
        let complete = file.expected_bytes == 0 || actual >= threshold;
        CheckFileResult {
            filename: file.filename.clone(),
            exists: true,
            actual_bytes: actual,
            complete,
        }
    } else {
        CheckFileResult {
            filename: file.filename.clone(),
            exists: false,
            actual_bytes: 0,
            complete: false,
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_model_subdirs_are_plain_folder_names_and_cover_the_ltx_upscaler() {
        // Delete searches exactly these folders under models/. Each must be a single
        // lowercase path segment (no separators, so the join behaves the same on
        // every platform) and the LTX 2.5 upscaler folder must be among them, or a
        // file the Get button wrote there could never be deleted from the list.
        assert!(MODEL_SUBDIRS.contains(&"latent_upscale_models"));
        for d in MODEL_SUBDIRS {
            assert!(!d.is_empty() && !d.contains('/') && !d.contains('\\') && !d.contains(".."), "{d}");
            assert_eq!(*d, d.to_lowercase(), "{d}");
        }
        let mut sorted: Vec<&&str> = MODEL_SUBDIRS.iter().collect();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), MODEL_SUBDIRS.len(), "duplicate entry");
    }


    /// GH #113: a partial as long as the file is answered 416 on every
    /// resume. That and only that sends the partial to the Trash and starts
    /// over; a fresh transfer or any other status never does.
    #[test]
    fn only_a_refused_resume_gives_up_the_partial() {
        assert!(super::partial_cannot_continue(1_000, 416));
        assert!(!super::partial_cannot_continue(0, 416), "no Range was sent");
        for status in [200u16, 206, 404, 500] {
            assert!(!super::partial_cannot_continue(1_000, status), "{status}");
        }
        let src = include_str!("download.rs");
        let body = &src[src.find("async fn do_download(").unwrap()..];
        let body = &body[..body.find("let already_on_disk").unwrap()];
        assert!(body.contains("partial_cannot_continue(resume_offset"), "the check sits in the transfer");
        assert!(body.contains("system_trash"), "the partial goes to the Trash");
        assert!(!body.contains("remove_file"), "and is never deleted there");
    }

    #[test]
    fn the_download_limit_is_shared_and_off_at_zero() {
        let now = Instant::now();
        let mut slot = None;
        // 1 MB at 1 MB/s takes a second.
        assert_eq!(throttle_wait(&mut slot, 1_000_000, 1_000_000, now), Duration::from_secs(1));
        // A second download in the same instant queues behind the first.
        assert_eq!(throttle_wait(&mut slot, 1_000_000, 500_000, now), Duration::from_millis(1500));
        // After an idle stretch the line owes at most the credit, never the
        // whole pause.
        let later = now + Duration::from_secs(10);
        assert_eq!(throttle_wait(&mut slot, 1_000_000, 250_000, later), Duration::from_millis(150));
        // 0 means no limit and clears the queue.
        assert_eq!(throttle_wait(&mut slot, 0, 1_000_000, later), Duration::ZERO);
        assert_eq!(slot, None);
        assert!(set_download_limit(-1.0).is_err());
        assert!(set_download_limit(f64::NAN).is_err());
    }

    /// A read takes time. That time counts toward the limit instead of being
    /// added on top of it, or a 1 MB/s limit delivers well under 1 MB/s.
    #[test]
    fn the_time_a_read_took_is_paid_from_the_limit() {
        let limit = 1_000_000;
        let piece = 8 * 1024u64;
        let read = Duration::from_millis(3);
        let begin = Instant::now();
        let mut now = begin;
        let mut slot = None;
        let pieces = 2_000u64;
        for _ in 0..pieces {
            now += read;
            now += throttle_wait(&mut slot, limit, piece, now);
        }
        let rate = (pieces * piece) as f64 / (now - begin).as_secs_f64();
        assert!(rate > 0.98 * limit as f64 && rate <= 1.01 * limit as f64, "rate {rate}");
    }

    /// A line that is slower than the limit is never made to wait.
    #[test]
    fn a_line_below_the_limit_is_not_slowed_further() {
        let limit = 1_000_000;
        let piece = 8 * 1024u64;
        // 8 KiB every 10 ms is about 0.8 MB/s.
        let read = Duration::from_millis(10);
        let mut now = Instant::now();
        let mut slot = None;
        let mut waited = Duration::ZERO;
        for i in 0..2_000 {
            now += read;
            let w = throttle_wait(&mut slot, limit, piece, now);
            if i > 0 { waited += w; }
            now += w;
        }
        assert_eq!(waited, Duration::ZERO);
    }

    use super::*;

    /// Der Rueckfall, den dieser Test verhindert, ist im Zusammenschluss des
    /// Design-Stroms mit 2.6.8 einmal passiert: die Zeile fragte nur noch nach
    /// der `lms`-CLI. Wer LM Studio ueber die Oberflaeche installiert und
    /// `lms bootstrap` nie laufen laesst, hat keine CLI, und Settings meldete
    /// "nicht installiert", obwohl das Programm da war.
    ///
    /// Die Nadeln sind aus zwei Haelften gebaut, damit dieser Test sie nicht
    /// in sich selbst findet.
    /// R1-4 Quelltextwaechter: schneidet den Rumpf EINER Funktion aus der
    /// ganzen Datei heraus, ueber Klammerzaehlung statt einer festen
    /// Zeilenzahl, damit eine spaetere Aenderung an der Funktion den Test
    /// nicht am falschen Ende abschneidet.
    fn fn_body<'a>(src: &'a str, signature: &str) -> &'a str {
        let start = src.find(signature).unwrap_or_else(|| panic!("{signature} not found"));
        let open = src[start..].find('{').map(|i| start + i).expect("no opening brace");
        let mut depth = 0i32;
        for (i, c) in src[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &src[open..open + i + 1];
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced braces after {signature}");
    }

    /// B3 of the check "the desktop must not break". The frontend resumes a
    /// file that was downloaded by path (every GGUF of the built-in engine)
    /// through `download_model_to_path` now, where v3.0.5 called
    /// `resume_download`. That is only allowed to stay if the two continue a
    /// transfer the same way, so this holds them next to each other: both
    /// read the offset from `<target>.download`, both claim the row with it,
    /// both hand the same offset to the same `do_download`, both finish and
    /// fail into the same row states. What differs is where the target is:
    /// `resume_download` resolves a ComfyUI subfolder (for a GGUF by path
    /// that folder never held the partial, and without ComfyUI it is an
    /// error), the start by path takes the folder the file really went to.
    #[test]
    fn a_start_by_path_continues_a_partial_exactly_like_resume_download() {
        let src = include_str!("download.rs");
        let resume = fn_body(src, "pub async fn resume_download(");
        let by_path = fn_body(src, "pub async fn download_model_to_path(");
        let squeezed = |body: &str| body.split_whitespace().collect::<Vec<_>>().join(" ");
        let (resume, by_path) = (squeezed(resume), squeezed(by_path));
        for step in [
            // The partial sits next to the target, with this suffix.
            r#"let tmp_path = dest_file.with_extension("download");"#,
            // Its length is where the transfer goes on.
            "let resume_offset = if tmp_path.exists() { tmp_path.metadata().map(|m| m.len()).unwrap_or(0) } else { 0 };",
            // One writer per file, the row starts at the offset.
            "&dest_file, resume_offset) {",
            "Claim::AlreadyRunning => {",
            "Claim::NameConflict(other) => {",
            // The same transfer function with the same offset and the same claims of the catalog.
            "match do_download(&url, &dest_file, &downloads_arc, &id_clone, token, resume_offset, CatalogClaims { expected_bytes, expected_sha256, auth_token",
            // The same ends.
            r#"p.status = "complete".to_string();"#,
            r#"if e == "paused" {"#,
            r#"} else if e == "cancelled" { let tmp = dest_file.with_extension("download"); let _ = std::fs::remove_file(&tmp);"#,
            r#"p.status = "error".to_string(); p.error = Some(e.clone());"#,
        ] {
            assert!(resume.contains(step), "resume_download lost: {step}");
            assert!(by_path.contains(step), "download_model_to_path lost: {step}");
        }
        // The one difference, named: the folder.
        assert!(resume.contains("comfy_models_dir(&state, &comfy_path, &subfolder)"));
        assert!(by_path.contains("PathBuf::from(&dest_dir)"));
        assert!(!by_path.contains("comfy_models_dir"));
    }

    #[test]
    fn a_delete_with_trash_puts_the_file_in_the_bin_whole() {
        let dir = tempfile::tempdir().unwrap();
        let loras = dir.path().join("loras");
        let bin_dir = dir.path().join("bin");
        fs::create_dir_all(&loras).unwrap();
        fs::create_dir_all(&bin_dir).unwrap();
        let file = loras.join("char_anna_zimage.safetensors");
        fs::write(&file, b"weights").unwrap();
        let other = loras.join("style.safetensors");
        fs::write(&other, b"other").unwrap();
        let bin = |f: &Path| fs::rename(f, bin_dir.join(f.file_name().unwrap())).map_err(|e| os_error::english(&e));

        let answer = to_the_bin(&file, "char_anna_zimage.safetensors", 7, bin).unwrap();

        assert_eq!(answer["status"], "trashed");
        assert_eq!(answer["bytes"], 7);
        assert!(!file.exists(), "the file left the loras folder");
        assert_eq!(fs::read(bin_dir.join("char_anna_zimage.safetensors")).unwrap(), b"weights");
        assert!(other.exists(), "no other file goes with it");
    }

    #[test]
    fn a_bin_that_refuses_leaves_the_file_and_says_why() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("char_anna_zimage.safetensors");
        fs::write(&file, b"weights").unwrap();

        let err = to_the_bin(&file, "char_anna_zimage.safetensors", 7, |_| Err("no bin here".to_string()))
            .unwrap_err();

        assert!(err.contains("Could not move char_anna_zimage.safetensors to the "), "{err}");
        assert!(err.contains("no bin here"), "{err}");
        assert!(file.exists(), "the file stays where the bin refused it");
    }

    #[test]
    fn d1_details_read_a_file_in_the_users_own_folder_and_nothing_outside() {
        let dir = std::env::temp_dir().join(format!("lu-d1-own-{}", std::process::id()));
        let loras = dir.join("loras");
        fs::create_dir_all(&loras).unwrap();
        fs::write(loras.join("style.safetensors"), b"12345").unwrap();
        fs::write(dir.join("outside.safetensors"), b"x").unwrap();
        let extra = vec![dir.to_string_lossy().to_string()];
        let hits = own_folder_hits("style.safetensors", &extra);
        assert_eq!(hits, vec![loras.join("style.safetensors")]);
        // A file beside the model folders is not a model of that folder.
        assert!(own_folder_hits("outside.safetensors", &extra).is_empty());
        let facts = file_facts(&hits[0], true, 1);
        assert_eq!(facts["bytes"], 5);
        assert_eq!(facts["ownFolder"], true);
        assert_eq!(facts["folder"], loras.to_string_lossy().to_string());
        assert!(facts["modified"].as_u64().is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn d1_details_and_delete_find_a_file_the_same_way() {
        let src = include_str!("download.rs");
        let info = fn_body(src, "pub async fn comfy_model_info(");
        assert!(info.contains("comfy_model_hits(&state"), "{info}");
        assert!(info.contains("safe_subfolder(&sub)"), "{info}");
        assert!(info.contains("sanitize_filename(&base)"), "{info}");
    }

    #[test]
    fn the_trash_delete_never_removes_for_good() {
        // Quelltextwaechter: der Zweig mit `trash` geht an den System-Papierkorb
        // und kehrt zurueck, bevor das endgueltige remove_file erreicht wird.
        let src = include_str!("download.rs");
        let body = fn_body(src, "pub async fn delete_comfy_model(");
        let branch = body.find("if trash.unwrap_or(false)").expect("trash branch");
        let remove = body.find("fs::remove_file(f)").expect("remove branch");
        assert!(branch < remove, "the trash branch comes before the delete for good");
        assert!(body[branch..remove].contains("os_trash::system_trash"), "{body}");
        assert!(body[branch..remove].contains("return "), "{body}");
    }

    #[test]
    fn r1_4_delete_and_space_check_ask_the_engine_fresh_not_the_cache() {
        // R1-4: both commands used to read comfy_folders::cached(), a value
        // set once when ComfyUI last answered and never refreshed for the
        // FIRST click of a session. A model the running engine had just
        // remapped to a custom folder then looked foreign to delete, and the
        // very first space check of a session measured the wrong drive.
        let src = include_str!("download.rs");
        let delete_body = fn_body(src, "pub async fn delete_comfy_model(");
        let space_body = fn_body(src, "pub async fn check_download_space(");
        assert!(
            !delete_body.contains("comfy_folders::cached()"),
            "delete_comfy_model still reads the stale cache instead of asking the engine"
        );
        assert!(
            !space_body.contains("comfy_folders::cached()"),
            "check_download_space still reads the stale cache instead of asking the engine"
        );
        // Delete and Details share one lookup (D1), which asks the engine.
        assert!(delete_body.contains("comfy_model_hits(&state"), "{delete_body}");
        let hits_body = fn_body(src, "async fn comfy_model_hits(");
        assert!(!hits_body.contains("comfy_folders::cached()"), "{hits_body}");
        assert!(hits_body.contains("engine_folders(state).await"), "{hits_body}");
        // The space check goes through comfy_models_path, the look-only half
        // of comfy_models_dir (GH #143: a remote ComfyUI measures the Storage
        // folder), and that one asks the engine fresh for everything else.
        assert!(space_body.contains("comfy_models_path(&state"), "{space_body}");
        let dir_body = fn_body(src, "async fn comfy_models_path(");
        assert!(dir_body.contains("engine_folders(state).await"), "{dir_body}");
        assert!(!dir_body.contains("comfy_folders::cached()"), "{dir_body}");
    }

    #[test]
    fn the_lm_studio_row_asks_the_whole_question_not_just_the_cli() {
        // Die ganze Datei, nicht nur die ausgelieferte Haelfte: sie hat mehrere
        // Testmodule, ein Schnitt am ersten `#[cfg(test)]` liesse 98 Prozent
        // des Quelltextes ungelesen und der Test waere still gruen.
        let src = include_str!("download.rs");
        let ganze_frage = format!("{}{}", "lmstudio_inst", "alled()");
        let nur_cli = format!("{}{}", "lmstudio_lms_p", "ath().is_some()");
        assert!(
            src.contains(&ganze_frage),
            "die Settings-Zeile fragt nicht mehr nach der ganzen Installation"
        );
        assert!(
            !src.contains(&nur_cli),
            "die Settings-Zeile fragt wieder nur nach der CLI, das App-Bundle faellt damit weg"
        );
    }

    #[tokio::test]
    async fn the_lm_studio_row_never_runs_on_the_main_thread() {
        // A14 review 3. A SYNCHRONOUS Tauri command runs on the MAIN thread,
        // and this one reaches install::lmstudio_installed(), which walks
        // fixed paths and can end in a `which` lookup that spawns a process.
        // Settings asks on mount, so the synchronous shape froze the window
        // for as long as that took. The Spotlight lookup that made the worst
        // case seconds long is gone (see lmstudio_app_bundle), but disk and a
        // spawned process are still not main-thread work. Same mistake the
        // Mac ComfyUI search made in 2.6.8, one door further along.
        //
        // The guard is the TYPE, not the source text. A source-text check
        // would have been self-referential here: the assertion's own string
        // literal lives in this file, so the file contains it whatever the
        // signature says (tried, and it passed happily against a synchronous
        // version). Awaiting the call only compiles while the command really
        // returns a future, so a return to `pub fn` breaks the build.
        let value = lmstudio_model_dir().await.expect("the command answers");
        assert!(value.get("installed").is_some(), "{value}");
        assert!(value.get("path").is_some(), "{value}");

        // The blocking half answers the same question on its own, and it is
        // the half whose behaviour the test below pins.
        let direct = lmstudio_model_dir_blocking().expect("the blocking half answers");
        assert_eq!(direct.get("installed"), value.get("installed"));
    }

    #[test]
    fn the_lm_studio_row_looks_and_never_creates() {
        // A14: Storage has to be able to say "LM Studio is not
        // installed". detect_model_path cannot answer that, because it is a
        // download target and calls create_dir_all on the way out, so asking
        // it would conjure ~/.lmstudio/models on a machine that has never seen
        // LM Studio and then report that folder as proof of an install.
        let home = tempfile::tempdir().expect("tempdir");
        let h = home.path();

        // Nothing there: no answer, and nothing left behind.
        assert!(lmstudio_dir_in(h).is_none());
        assert!(!h.join(".lmstudio").exists(), "the look created a folder");
        assert!(!h.join(".cache").exists(), "the look created a folder");

        // The 0.2.x location alone is still an answer.
        let legacy = h.join(".cache").join("lm-studio").join("models");
        fs::create_dir_all(&legacy).expect("legacy dir");
        assert_eq!(lmstudio_dir_in(h).as_deref(), Some(legacy.as_path()));

        // With both present the modern one wins, same order as detect_model_path.
        let modern = h.join(".lmstudio").join("models");
        fs::create_dir_all(&modern).expect("modern dir");
        assert_eq!(lmstudio_dir_in(h).as_deref(), Some(modern.as_path()));

        // NEGATIVE CONTROL: a FILE named like the folder is not a folder, and
        // must not be reported as one.
        let other = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(other.path().join(".lmstudio")).expect("parent");
        fs::write(other.path().join(".lmstudio").join("models"), b"x").expect("file");
        assert!(lmstudio_dir_in(other.path()).is_none());
    }

    #[test]
    fn a_full_drive_is_named_before_the_first_byte() {
        // Der echte Fall vom 15.08.: 16,3 GB Videomodell, 15,2 GB frei.
        let modell = 16_331_849_976;
        let (needed, free) = space_shortfall(modell, 0, Some(15_200_000_000)).expect("muss knapp sein");
        assert_eq!(free, 15_200_000_000);
        assert!(needed > free);
        // Genug Platz plus Reserve: der Download laeuft.
        assert!(space_shortfall(modell, 0, Some(modell + SPACE_RESERVE)).is_none());
        // Exakt die Reserve zu wenig: das ist der Fall, der Windows lahmlegt.
        assert!(space_shortfall(modell, 0, Some(modell)).is_some());
    }

    #[test]
    fn a_bundle_keeps_two_gigabytes_free_and_says_how_much_is_missing() {
        const GIB: u64 = 1024 * 1024 * 1024;
        // The box, 03.10.2026: 27.1 GB to fetch, 29.6 GB free. That fits, and
        // it still does with the larger reserve.
        let ltx: u64 = 29_066_057_328;
        assert!(space_shortfall_keeping(ltx, 0, Some(31_782_000_000), BUNDLE_SPACE_RESERVE).is_none());
        // One gigabyte less free and the single file's reserve would still let
        // it start; the bundle's does not.
        let free = ltx + GIB + GIB / 2;
        assert!(space_shortfall(ltx, 0, Some(free)).is_none());
        let (needed, got) = space_shortfall_keeping(ltx, 0, Some(free), BUNDLE_SPACE_RESERVE).expect("too tight for a bundle");
        assert_eq!(needed, ltx + 2 * GIB);
        let message = bundle_space_message(ltx, 0, needed, got);
        assert!(message.starts_with("Not enough free space: 0.5 GB short."), "{message}");
        assert!(message.contains("The download is 27.1 GB"), "{message}");
        assert!(message.contains("keeps 2.0 GB of the drive free"), "{message}");
        assert!(!message.contains("promised"), "{message}");
        // Transfers still running are named, because their bytes are why.
        let busy = bundle_space_message(ltx, 4 * GIB, needed + 4 * GIB, got);
        assert!(busy.contains("Another 4.0 GB is already promised"), "{busy}");
        assert!(busy.starts_with("Not enough free space: 4.5 GB short."), "{busy}");
    }

    #[test]
    fn what_already_lies_on_disk_does_not_have_to_fit_twice() {
        // Fortsetzung: 12 GB von 16,3 GB liegen schon, es fehlen 4,3 GB.
        let total = 16_000_000_000;
        assert!(space_shortfall(total, 12_000_000_000, Some(5_500_000_000)).is_none());
        // Ohne Anrechnung des Vorhandenen waere derselbe Lauf abgelehnt worden.
        assert!(space_shortfall(total, 0, Some(5_500_000_000)).is_some());
    }

    #[test]
    fn without_a_number_nothing_is_blocked() {
        // Server nennt keine Laenge: es gibt nichts zu rechnen, also kein Nein.
        assert!(space_shortfall(0, 0, Some(1)).is_none());
        // Laufwerk nicht messbar: ein unbekannter Wert darf niemanden aussperren.
        assert!(space_shortfall(16_000_000_000, 0, None).is_none());
    }

    #[test]
    fn a_short_body_is_never_renamed_into_place() {
        assert!(ended_early(6_000_000_000, 3_500_000_000));
        assert!(!ended_early(6_000_000_000, 6_000_000_000));
        // Server declared no length: nothing to compare against, trust the stream.
        assert!(!ended_early(0, 17));
    }

    #[test]
    fn only_a_206_lets_the_partial_file_count() {
        assert_eq!(resumed_bytes(4096, 206), 4096);
        // Range ignored — the whole body arrives and the part file is restarted.
        assert_eq!(resumed_bytes(4096, 200), 0);
        assert_eq!(resumed_bytes(0, 206), 0);
    }

    /// Der Kern von Zeitbombe 3: `actual >= expected * 0.9` hat einen bei 91 %
    /// abgebrochenen Download als fertig durchgewinkt.
    #[test]
    fn an_existing_file_counts_only_at_the_exact_byte() {
        let exact = 6_000_000_000u64;
        assert_eq!(judge_existing(exact, Some(exact)), Existing::Complete);

        // 91 % — unter der alten Regel "fertig", hier genau das, was es ist.
        let at_91 = 5_460_000_000u64;
        assert_eq!(
            judge_existing(at_91, Some(exact)),
            Existing::Mismatch { actual: at_91, exact }
        );
        // Ein einziges fehlendes Byte reicht.
        assert_eq!(
            judge_existing(exact - 1, Some(exact)),
            Existing::Mismatch { actual: exact - 1, exact }
        );
        // Zu gross ist genauso falsch wie zu klein.
        assert_eq!(
            judge_existing(exact + 1, Some(exact)),
            Existing::Mismatch { actual: exact + 1, exact }
        );
        // Ohne exakte Zahl wird nichts behauptet — weder fertig noch kaputt.
        assert_eq!(judge_existing(at_91, None), Existing::Unverified { actual: at_91 });
        assert_eq!(judge_existing(at_91, Some(0)), Existing::Unverified { actual: at_91 });
    }

    #[test]
    fn a_missing_content_length_does_not_silently_disable_the_space_guard() {
        let estimate = Some(16_000_000_000u64);
        // Server nennt eine Laenge: die gilt, und sie ist keine Schaetzung.
        assert_eq!(total_size(Some(16_331_849_976), 0, false, estimate), (16_331_849_976, false));
        // Fortsetzung: der Rest plus das, was schon liegt.
        assert_eq!(total_size(Some(4_000_000_000), 12_000_000_000, true, estimate), (16_000_000_000, false));
        // Keine Laenge: der Katalogwert plant den Platz, markiert als Schaetzung.
        assert_eq!(total_size(None, 0, false, estimate), (16_000_000_000, true));
        assert_eq!(total_size(Some(0), 0, false, estimate), (16_000_000_000, true));
        // Weder Laenge noch Katalogwert: 0, und beide Guards wissen das.
        assert_eq!(total_size(None, 0, false, None), (0, true));

        // Die Schaetzung darf einen Abbruch niemals als Abbruch melden — sie
        // wuerde jeden Download bei abweichender Rundung fehlschlagen lassen.
        let (total, estimated) = total_size(None, 0, false, estimate);
        assert!(estimated);
        assert!(ended_early(total, 15_900_000_000), "die Zahl allein wuerde greifen");
        // do_download prueft deshalb `!estimated && ended_early(..)`.
    }

    #[test]
    fn the_whole_size_comes_out_of_content_range() {
        assert_eq!(total_from_content_range("bytes 0-0/12345"), Some(12345));
        assert_eq!(total_from_content_range("bytes 0-0/*"), None);
        assert_eq!(total_from_content_range("nonsense"), None);
    }

    #[test]
    fn only_a_real_digest_is_accepted() {
        // sha256 der leeren Datei, 64 Hexzeichen.
        let full = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert_eq!(full.len(), 64);
        assert_eq!(normalize_sha256(full).unwrap(), full);
        // Grossschreibung ist erlaubt, das Ergebnis ist normalisiert.
        assert_eq!(normalize_sha256(&full.to_uppercase()).unwrap(), full);
        assert_eq!(normalize_sha256(&format!("  {}  ", full)).unwrap(), full);
        // Ein Tippfehler schaltet die Pruefung nicht still ab, er faellt auf.
        assert!(normalize_sha256(&full[..63]).is_err(), "63 Zeichen sind kein sha256");
        assert!(normalize_sha256(&format!("{}ab", full)).is_err());
        assert!(normalize_sha256(&format!("sha256:{}", full)).is_err());
        assert!(normalize_sha256(&full.replace('e', "z")).is_err(), "kein Hex");
        assert!(normalize_sha256("").is_err());
    }

    /// `with_extension` ERSETZT die Endung: die Teildatei zu
    /// `wan_2.1_vae.safetensors` heisst `wan_2.1_vae.download`. Wer aus dem
    /// Fundstueck den Download-Namen zurueckrechnen will, muss das wissen.
    #[test]
    fn a_partial_keeps_only_the_stem_of_its_target() {
        let dest = PathBuf::from("/models/vae/wan_2.1_vae.safetensors");
        let part = dest.with_extension("download");
        assert_eq!(part.file_name().unwrap(), "wan_2.1_vae.download");
        assert_eq!(part.file_stem().unwrap(), "wan_2.1_vae");
        assert_eq!(file_stem_of("wan_2.1_vae.safetensors"), "wan_2.1_vae");
        assert_eq!(file_stem_of("wan_2.1_vae.download"), "wan_2.1_vae");
        // Ein Name ohne Endung bleibt, wie er ist.
        assert_eq!(file_stem_of("model"), "model");
    }

    /// Der Digest muss ueber Fortsetzungen hinweg derselbe sein, sonst waere
    /// jeder wiederaufgenommene Download "korrupt".
    #[tokio::test]
    async fn a_resumed_transfer_hashes_the_bytes_that_already_lie_there() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("m.safetensors.download");
        let head = b"the first half of a model file";
        let tail = b" and the second half";
        std::fs::write(&part, head).unwrap();

        let mut resumed = digest_of_prefix(&part, head.len() as u64).await.unwrap();
        resumed.update(tail);

        let mut in_one_go = Sha256::new();
        in_one_go.update(head);
        in_one_go.update(tail);

        assert_eq!(
            format!("{:x}", resumed.finalize()),
            format!("{:x}", in_one_go.finalize()),
        );
    }

    /// 106 fest verdrahtete HuggingFace-Adressen: wird ein Repo umbenannt oder
    /// gated, ist "HTTP 404" plus Retry-Button eine Sackgasse.
    #[test]
    fn a_dead_address_says_what_happened_and_carries_its_status() {
        let gone = http_error_message(404, "wan_2.1_vae.safetensors");
        assert!(gone.contains("(HTTP 404)"), "Frontend liest genau diese Form");
        assert!(gone.contains("wan_2.1_vae.safetensors"));
        assert!(gone.to_lowercase().contains("cannot help"), "Retry darf nicht angeboten werden");

        let gated = http_error_message(403, "flux1-dev.safetensors");
        assert!(gated.contains("(HTTP 403)"));
        assert!(gated.to_lowercase().contains("login"));
        assert!(gated.to_lowercase().contains("cannot help"));

        // Voruebergehendes darf weiterhin zum Wiederholen einladen.
        let busy = http_error_message(429, "m.gguf");
        assert!(busy.contains("(HTTP 429)"));
        assert!(!busy.to_lowercase().contains("cannot help"));
        let server = http_error_message(503, "m.gguf");
        assert!(server.contains("(HTTP 503)"));
        assert!(!server.to_lowercase().contains("cannot help"));
    }

    /// Der Bundle-Fall: vier Dateien starten gleichzeitig und pruefen jede fuer
    /// sich gegen dieselben freien Bytes.
    #[test]
    fn what_is_still_owed_counts_as_taken() {
        let mut map: HashMap<String, DownloadProgress> = HashMap::new();
        let mut add = |id: &str, status: &str, progress: u64, total: u64| {
            map.insert(
                id.to_string(),
                DownloadProgress {
                    progress,
                    total,
                    speed: 0.0,
                    filename: id.into(),
                    status: status.into(),
                    error: None,
                    dest: format!("/models/{id}"),
                },
            );
        };
        add("a.safetensors", "downloading", 1_000_000_000, 6_000_000_000);
        add("b.safetensors", "connecting", 0, 4_000_000_000);
        // Erledigtes und Fehlgeschlagenes schuldet nichts mehr.
        add("c.safetensors", "complete", 2_000_000_000, 2_000_000_000);
        add("d.safetensors", "error", 500_000_000, 3_000_000_000);

        assert_eq!(reserved_bytes(&map), 5_000_000_000 + 4_000_000_000);

        // Und daraus folgt die Absage, die die Einzelpruefung nie gegeben haette:
        // 12 GB frei, 9 GB schon versprochen, 8 GB neu angefragt.
        assert!(space_shortfall(8_000_000_000 + reserved_bytes(&map), 0, Some(12_000_000_000)).is_some());
        // Ohne Anrechnung des Laufenden waere derselbe Start durchgegangen.
        assert!(space_shortfall(8_000_000_000, 0, Some(12_000_000_000)).is_none());
    }

    /// Nach einem Neustart weiss nur noch die Platte, was unterwegs war.
    #[test]
    fn the_disk_still_knows_what_was_in_flight() {
        let root = tempfile::tempdir().unwrap();
        let vae = root.path().join("models").join("vae");
        std::fs::create_dir_all(&vae).unwrap();
        std::fs::write(vae.join("wan_2.1_vae.download"), vec![0u8; 4096]).unwrap();
        // Fertige Dateien und Rauschen gehen niemanden etwas an.
        std::fs::write(vae.join("done.safetensors"), b"x").unwrap();
        let noise = root.path().join("models").join("__pycache__");
        std::fs::create_dir_all(&noise).unwrap();
        std::fs::write(noise.join("cached.download"), b"x").unwrap();
        // Ein laufender Transfer ist kein Waisenkind.
        let unet = root.path().join("models").join("diffusion_models");
        std::fs::create_dir_all(&unet).unwrap();
        std::fs::write(unet.join("running.download"), vec![0u8; 8192]).unwrap();

        let found = scan_for_partials(
            vec![root.path().join("models")],
            vec![file_stem_of("running.gguf")],
        );

        assert_eq!(found.len(), 1, "gefunden: {:?}", found.iter().map(|o| &o.path).collect::<Vec<_>>());
        assert_eq!(found[0].stem, "wan_2.1_vae");
        assert_eq!(found[0].bytes, 4096);
        assert!(found[0].dir.ends_with("vae"), "der destDir muss mitkommen");
    }

    /// Wiederholen und Abbrechen sind zwei Wege, und nur einer raeumt auf.
    #[test]
    fn only_the_cancel_path_touches_the_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.safetensors");
        // Wie in do_download: with_extension ersetzt die Endung.
        let part = dest.with_extension("download");
        std::fs::write(&part, b"36 GB, sozusagen").unwrap();

        // Ein fehlgeschlagener oder pausierter Eintrag darf aus der Map — das
        // ist alles, was der Retry braucht, und es fasst die Datei nicht an.
        assert!(clearable("error"));
        assert!(clearable("paused"));
        assert!(clearable("complete"));
        assert!(part.exists(), "Buchhaltung loescht keine Nutzdaten");

        // Ein laufender Transfer besitzt seinen Eintrag.
        assert!(!clearable("downloading"));
        assert!(!clearable("connecting"));
        assert!(!clearable("pausing"));

        // Nur der Abbruch raeumt, und dann wirklich.
        assert!(remove_partial(&dest.to_string_lossy()));
        assert!(!part.exists());
        assert!(!remove_partial(""), "ohne Ziel gibt es nichts zu loeschen");
    }
}

/// One transfer per destination file.
///
/// The map is keyed by bare filename. A second start under the same key used
/// to overwrite the first entry AND the first cancel token, so the first
/// download could no longer be paused or cancelled and both tokio tasks wrote
/// the same `.download` file — one truncating it, the other appending at its
/// own offset. The file still reached `total` bytes and was reported
/// "complete": a silently corrupt model, several GB of it.
/// Guard for Android finding A14: a phone has no home folder, and the one
/// provider it has must not depend on one.
#[cfg(test)]
mod builtin_path_needs_no_home_tests {
    use super::*;

    #[test]
    fn every_name_of_the_builtin_engine_gets_the_app_models_folder() {
        let want = crate::commands::engine::builtin_models_dir().unwrap();
        // The two old spellings are put together here, so the sweep for the
        // old name on screen finds no string of it in this file.
        let old_dashed = ["Built", "in Engine"].join("-");
        let old_spaced = ["built", "in engine"].join(" ");
        for name in ["builtin", "LU Engine", old_dashed.as_str(), old_spaced.as_str()] {
            let got = detect_model_path(name.to_string()).unwrap();
            assert_eq!(got, serde_json::json!(want.to_string_lossy()), "{name}");
        }
        assert!(!is_builtin_provider("ollama"));
    }

    #[test]
    fn the_builtin_answer_comes_before_the_home_lookup() {
        // Read from the source: HOME cannot be taken away from a test that
        // shares its process with a thousand others. What matters is the
        // order, because `?` on a missing home ends the function.
        let src = include_str!("download.rs");
        let f = &src[src.find("pub fn detect_model_path(").expect("exists")..];
        let builtin = f.find("if is_builtin_provider(&provider_lower)").expect("the early answer exists");
        let home = f.find("dirs::home_dir()").expect("the home lookup exists");
        assert!(
            builtin < home,
            "detect_model_path must answer for the LU Engine before it asks for a home folder"
        );
        let early = &f[builtin..home];
        assert!(early.contains("return crate::commands::engine::builtin_models_dir()"), "{early}");
    }
}

#[cfg(test)]
mod claim_tests {
    use super::*;

    fn running(dest: &str) -> DownloadProgress {
        DownloadProgress {
            progress: 1024,
            total: 4096,
            speed: 10.0,
            filename: "model.safetensors".into(),
            status: "downloading".into(),
            error: None,
            dest: dest.into(),
        }
    }

    fn claim(map: &mut HashMap<String, DownloadProgress>, dest: &str) -> Claim {
        claim_download(map, "model.safetensors", "model.safetensors", Path::new(dest), 0)
    }

    #[test]
    fn an_untouched_id_is_claimed_and_records_its_destination() {
        let mut map = HashMap::new();
        assert_eq!(claim(&mut map, "/models/vae/model.safetensors"), Claim::Ok);
        let p = &map["model.safetensors"];
        assert_eq!(p.status, "connecting");
        assert_eq!(p.dest, "/models/vae/model.safetensors");
    }

    #[test]
    fn a_second_start_of_the_same_file_is_refused_and_leaves_the_first_alone() {
        let mut map = HashMap::new();
        map.insert("model.safetensors".to_string(), running("/models/vae/model.safetensors"));

        assert_eq!(claim(&mut map, "/models/vae/model.safetensors"), Claim::AlreadyRunning);
        // The caller returns before it can insert a token, so the running
        // transfer keeps the one that can still cancel it.
        let p = &map["model.safetensors"];
        assert_eq!(p.status, "downloading");
        assert_eq!(p.progress, 1024);
    }

    #[test]
    fn two_different_models_sharing_a_file_name_collide_visibly() {
        // "model.safetensors", "ae.safetensors", "diffusion_pytorch_model.safetensors"
        // are all over HuggingFace, so this is the normal case, not a corner.
        let mut map = HashMap::new();
        map.insert("model.safetensors".to_string(), running("/models/vae/model.safetensors"));

        assert_eq!(
            claim(&mut map, "/models/checkpoints/model.safetensors"),
            Claim::NameConflict("/models/vae/model.safetensors".to_string()),
        );
    }

    #[test]
    fn a_transfer_on_its_way_out_still_counts_as_running() {
        let mut map = HashMap::new();
        let mut p = running("/models/vae/model.safetensors");
        p.status = "pausing".into();
        map.insert("model.safetensors".to_string(), p);

        assert_eq!(claim(&mut map, "/models/vae/model.safetensors"), Claim::AlreadyRunning);
    }

    #[test]
    fn a_finished_paused_or_failed_entry_may_be_restarted() {
        for status in ["complete", "paused", "error"] {
            let mut map = HashMap::new();
            let mut p = running("/models/vae/model.safetensors");
            p.status = status.into();
            map.insert("model.safetensors".to_string(), p);

            assert_eq!(claim(&mut map, "/models/vae/model.safetensors"), Claim::Ok, "{status}");
            assert_eq!(map["model.safetensors"].status, "connecting");
        }
    }

    #[test]
    fn an_entry_from_before_this_field_is_not_mistaken_for_a_collision() {
        let mut map = HashMap::new();
        map.insert("model.safetensors".to_string(), running(""));

        assert_eq!(claim(&mut map, "/models/vae/model.safetensors"), Claim::AlreadyRunning);
    }
}
