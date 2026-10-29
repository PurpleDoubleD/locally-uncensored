//! `locallyuncensored://open-model?repo=<owner/name>&file=<path.gguf>`: the
//! link behind Hugging Face's "Use this model" button (B17, 3.0.9).
//!
//! A link is something any web page can fire at the app, so nothing here
//! trusts it. The link carries a repository id and a file path and nothing
//! else; the address the file comes from is built by the app itself and is
//! always huggingface.co. Every part is checked against the rules Hugging Face
//! itself enforces for repository names, the file has to be a `.gguf`, and an
//! unknown or repeated parameter rejects the whole link. A link that passes
//! starts nothing: it lands in an inbox, the page takes it out and asks the
//! user before a single byte is downloaded (DiscoverModels, HfLinkDialog).
//!
//! The webview gets no permission of the deep-link plugin. It reads the inbox
//! through `hf_link_take` and nothing else.

use serde::Serialize;
use std::sync::Mutex;

/// The scheme registered with the system (tauri.<platform>.conf.json).
pub const SCHEME: &str = "locallyuncensored";
/// The one action a link can name.
const ACTION: &str = "open-model";
/// Longer than any real link: two names of at most 96 characters and a path.
const MAX_LINK_LEN: usize = 2048;
const MAX_FILE_LEN: usize = 255;
const MAX_FILE_DEPTH: usize = 8;

/// What a link asks for, after every check passed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HfModelLink {
    /// `owner/name` of a model repository on huggingface.co.
    pub repo: String,
    /// Path of a `.gguf` inside it. None when the button was pressed without a
    /// file picked: the page then lists the repository's GGUF files.
    pub file: Option<String>,
}

/// What the page finds in the inbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Inbound {
    Model(HfModelLink),
    /// A link with our scheme that failed a check. The page says so instead
    /// of the click going nowhere; the reason never echoes the link itself.
    Rejected { reason: String },
}

#[derive(Default)]
pub struct HfLinkInbox(pub Mutex<Option<Inbound>>);

/// Hugging Face's rule for a repository name and for its owner: letters,
/// digits, `-`, `_`, `.`; no `-` or `.` at either end; no `--` or `..`; at
/// most 96 characters.
fn valid_name_part(s: &str) -> bool {
    let len = s.len();
    if len == 0 || len > 96 {
        return false;
    }
    if !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.') {
        return false;
    }
    let first = s.as_bytes()[0];
    let last = s.as_bytes()[len - 1];
    if matches!(first, b'-' | b'.') || matches!(last, b'-' | b'.') {
        return false;
    }
    !s.contains("--") && !s.contains("..")
}

pub fn valid_repo_id(repo: &str) -> bool {
    let mut parts = repo.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(owner), Some(name), None) => valid_name_part(owner) && valid_name_part(name),
        _ => false,
    }
}

/// A relative path inside the repository that ends in `.gguf`. Every segment
/// is plain: no `.` or `..`, no leading dot, no backslash, no spaces or
/// control characters. The file name is all that ever reaches the disk, but a
/// path that could mean something else is refused rather than cleaned.
pub fn valid_gguf_path(path: &str) -> bool {
    if path.is_empty() || path.len() > MAX_FILE_LEN {
        return false;
    }
    if !path.to_ascii_lowercase().ends_with(".gguf") {
        return false;
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() > MAX_FILE_DEPTH {
        return false;
    }
    segments.iter().all(|seg| {
        !seg.is_empty()
            && !seg.starts_with('.')
            && seg.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
    }) && path.rsplit('/').next().map(|name| name.len() > ".gguf".len()).unwrap_or(false)
}

/// Read a link. Err carries a sentence for the user.
pub fn parse(raw: &str) -> Result<HfModelLink, String> {
    if raw.len() > MAX_LINK_LEN {
        return Err("The link is too long.".into());
    }
    let url = url::Url::parse(raw).map_err(|_| "The link is not a valid address.".to_string())?;
    if url.scheme() != SCHEME {
        return Err("The link is not meant for this app.".into());
    }
    if url.host_str() != Some(ACTION) {
        return Err("The link asks for something this version cannot do.".into());
    }
    if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return Err("The link carries parts it must not have.".into());
    }
    if !matches!(url.path(), "" | "/") || url.fragment().is_some() {
        return Err("The link carries parts it must not have.".into());
    }
    let mut repo: Option<String> = None;
    let mut file: Option<String> = None;
    for (key, value) in url.query_pairs() {
        let slot = match key.as_ref() {
            "repo" => &mut repo,
            "file" => &mut file,
            _ => return Err("The link carries a parameter this version does not know.".into()),
        };
        if slot.is_some() {
            return Err("The link names a parameter twice.".into());
        }
        *slot = Some(value.into_owned());
    }
    let repo = repo.ok_or_else(|| "The link names no model.".to_string())?;
    if !valid_repo_id(&repo) {
        return Err("The link does not name a Hugging Face model repository.".into());
    }
    if let Some(f) = &file {
        if !valid_gguf_path(f) {
            return Err("The link does not name a GGUF file.".into());
        }
    }
    Ok(HfModelLink { repo, file })
}

/// One link from the system: checked, put in the inbox (a newer link replaces
/// an older one nobody took yet), the page told, the window brought forward.
#[cfg(desktop)]
pub fn accept(app: &tauri::AppHandle, raw: &str) {
    use tauri::{Emitter, Manager};
    let inbound = match parse(raw) {
        Ok(link) => {
            tracing::info!(repo = %link.repo, file = ?link.file, "Hugging Face link received");
            Inbound::Model(link)
        }
        Err(reason) => {
            // The link itself stays out of the log: it is whatever a page
            // chose to send.
            tracing::warn!(%reason, "Hugging Face link rejected");
            Inbound::Rejected { reason }
        }
    };
    if let Some(inbox) = app.try_state::<HfLinkInbox>() {
        *inbox.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(inbound);
    }
    let _ = app.emit("hf-link", ());
    crate::onboarding_window::bring_to_front(app);
}

/// Wire the plugin to the inbox: the link that started the app (Windows and
/// Linux read it from the command line) and every later one (a second start
/// on Windows and Linux, handed over by single-instance; the Opened event on
/// the Mac, also for the link that started it).
#[cfg(desktop)]
pub fn setup(app: &tauri::AppHandle) {
    use tauri::Manager;
    use tauri_plugin_deep_link::DeepLinkExt;
    app.manage(HfLinkInbox::default());
    // An AppImage is not installed by a package manager, so nobody wrote the
    // scheme's handler. The plugin writes the .desktop entry the bundler
    // writes for .deb and .rpm.
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_some() {
        if let Err(e) = app.deep_link().register_all() {
            tracing::warn!(error = %e, "could not register the link scheme of this app");
        }
    }
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            accept(&handle, url.as_str());
        }
    });
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            accept(app, url.as_str());
        }
    }
}

/// The page takes the waiting link, once.
#[tauri::command]
pub fn hf_link_take(inbox: tauri::State<'_, HfLinkInbox>) -> Option<Inbound> {
    inbox.0.lock().unwrap_or_else(|e| e.into_inner()).take()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(raw: &str) -> HfModelLink {
        parse(raw).unwrap_or_else(|e| panic!("{raw}: {e}"))
    }

    #[test]
    fn reads_a_link_with_and_without_file() {
        assert_eq!(
            ok("locallyuncensored://open-model?repo=bartowski/Qwen2.5-0.5B-Instruct-GGUF&file=Qwen2.5-0.5B-Instruct-Q4_K_M.gguf"),
            HfModelLink {
                repo: "bartowski/Qwen2.5-0.5B-Instruct-GGUF".into(),
                file: Some("Qwen2.5-0.5B-Instruct-Q4_K_M.gguf".into()),
            }
        );
        assert_eq!(ok("locallyuncensored://open-model/?repo=a/b").file, None);
        assert_eq!(ok("locallyuncensored://open-model?repo=unsloth/x&file=Q4_K_M/x-Q4_K_M-00001-of-00002.gguf").file.as_deref(), Some("Q4_K_M/x-Q4_K_M-00001-of-00002.gguf"));
        // Encoded slashes are what URLSearchParams writes.
        assert_eq!(ok("locallyuncensored://open-model?repo=a%2Fb&file=dir%2Fm.GGUF").file.as_deref(), Some("dir/m.GGUF"));
    }

    #[test]
    fn refuses_other_schemes_actions_and_url_parts() {
        for raw in [
            "https://open-model?repo=a/b",
            "lu://open-model?repo=a/b",
            "locallyuncensored://run?repo=a/b",
            "locallyuncensored://open-model.evil.com?repo=a/b",
            "locallyuncensored://user:pw@open-model?repo=a/b",
            "locallyuncensored://open-model:8080?repo=a/b",
            "locallyuncensored://open-model/etc/passwd?repo=a/b",
            "locallyuncensored://open-model?repo=a/b#frag",
            "locallyuncensored:open-model?repo=a/b",
            "not a url",
            "",
        ] {
            assert!(parse(raw).is_err(), "accepted {raw}");
        }
    }

    #[test]
    fn refuses_unknown_repeated_and_missing_parameters() {
        for raw in [
            "locallyuncensored://open-model",
            "locallyuncensored://open-model?file=m.gguf",
            "locallyuncensored://open-model?repo=a/b&repo=c/d",
            "locallyuncensored://open-model?repo=a/b&file=m.gguf&file=n.gguf",
            "locallyuncensored://open-model?repo=a/b&url=https://evil.example/m.gguf",
            "locallyuncensored://open-model?repo=a/b&run=1",
            "locallyuncensored://open-model?repo=a/b&endpoint=https://evil.example",
        ] {
            assert!(parse(raw).is_err(), "accepted {raw}");
        }
    }

    #[test]
    fn refuses_repo_ids_hugging_face_would_refuse_or_that_point_elsewhere() {
        for repo in [
            "a",
            "a/b/c",
            "/b",
            "a/",
            "../b",
            "a/..",
            "a/b..c",
            "a--x/b",
            "-a/b",
            "a/b-",
            ".a/b",
            "a/b.",
            "a b/c",
            "a/b%00",
            "a/b%0A",
            "a\\b/c",
            "https://evil.example/a/b",
            "evil.example%2Fa/b",
            "a/b?x=1",
            "a/%E2%80%AEb",
        ] {
            let raw = format!("locallyuncensored://open-model?repo={repo}");
            assert!(parse(&raw).is_err(), "accepted repo {repo}");
        }
        let long = "a".repeat(97);
        assert!(parse(&format!("locallyuncensored://open-model?repo={long}/b")).is_err());
        assert!(parse(&format!("locallyuncensored://open-model?repo={}/b", "a".repeat(96))).is_ok());
    }

    #[test]
    fn refuses_files_that_are_not_plain_gguf_paths() {
        for file in [
            "model.bin",
            "model.safetensors",
            "model.gguf.exe",
            "model.gguf%00.exe",
            "model.exe%00.gguf",
            ".gguf",
            "dir/.gguf",
            "../model.gguf",
            "dir/../../model.gguf",
            "./model.gguf",
            "/model.gguf",
            "dir//model.gguf",
            ".hidden.gguf",
            "dir\\model.gguf",
            "C:%5Cmodel.gguf",
            "%2Fetc%2Fmodel.gguf",
            "model%0A.gguf",
            "my model.gguf",
            "my+model.gguf",
            "mod%C3%A9l.gguf",
            "a/b/c/d/e/f/g/h/i.gguf",
        ] {
            let raw = format!("locallyuncensored://open-model?repo=a/b&file={file}");
            assert!(parse(&raw).is_err(), "accepted file {file}");
        }
        assert!(parse(&format!("locallyuncensored://open-model?repo=a/b&file={}.gguf", "m".repeat(250))).is_ok());
        assert!(parse(&format!("locallyuncensored://open-model?repo=a/b&file={}.gguf", "m".repeat(251))).is_err());
        assert!(parse(&format!("locallyuncensored://open-model?repo=a/b&file={}", "m".repeat(3000))).is_err());
    }

    #[test]
    fn a_rejection_never_echoes_the_link() {
        let raw = "locallyuncensored://open-model?repo=<script>alert(1)</script>/b";
        let reason = parse(raw).unwrap_err();
        assert!(!reason.contains("script"), "{reason}");
    }

    #[test]
    fn the_inbox_hands_a_link_out_once() {
        let inbox = HfLinkInbox::default();
        *inbox.0.lock().unwrap() = Some(Inbound::Model(ok("locallyuncensored://open-model?repo=a/b")));
        assert!(inbox.0.lock().unwrap().take().is_some());
        assert!(inbox.0.lock().unwrap().take().is_none());
    }

    #[test]
    fn the_page_reads_the_shape_it_expects() {
        let model = Inbound::Model(ok("locallyuncensored://open-model?repo=a/b&file=m.gguf"));
        assert_eq!(
            serde_json::to_value(model).unwrap(),
            serde_json::json!({ "kind": "model", "repo": "a/b", "file": "m.gguf" })
        );
        let rejected = Inbound::Rejected { reason: "x".into() };
        assert_eq!(serde_json::to_value(rejected).unwrap(), serde_json::json!({ "kind": "rejected", "reason": "x" }));
    }

    /// The scheme the code answers to is the scheme the bundles register.
    #[test]
    fn every_desktop_config_registers_the_scheme() {
        for conf in [
            include_str!("../tauri.macos.conf.json"),
            include_str!("../tauri.windows.conf.json"),
            include_str!("../tauri.linux.conf.json"),
        ] {
            let v: serde_json::Value = serde_json::from_str(conf).unwrap();
            assert_eq!(v["plugins"]["deep-link"]["desktop"]["schemes"], serde_json::json!([SCHEME]));
        }
    }
}
