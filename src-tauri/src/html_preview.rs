//! The page behind the chat's HTML preview (B29, 3.0.9).
//!
//! Why a scheme of its own and not `srcdoc`: an `about:srcdoc` frame inherits
//! the policy of the page that holds it, and the app's policy says
//! `script-src 'self'`. The model's inline script was therefore never run in
//! the shipped app, only in the browser build without that policy. A document
//! served from `luprev://` has its own response and so its own policy, the one
//! [`preview_csp`] writes, and nothing of the app's.
//!
//! What keeps the preview away from the app, in layers:
//!
//! * The frame is sandboxed without `allow-same-origin` (frontend, tested in
//!   `html-preview.test.ts`), and the response says the same once more with
//!   the CSP `sandbox` directive, so even a top-level load of the URL gets an
//!   opaque origin.
//! * The policy has no `connect-src`, no `frame-src`, no `form-action`, no
//!   worker and no remote source of any kind. Network only when the user
//!   allowed it for this one preview, and then `https:` alone: never
//!   `http://localhost`, so Ollama, the engine and the app's own ports stay
//!   out of reach either way.
//! * The page does not exist until the user clicks Preview: the frontend puts
//!   the document here at that moment ([`html_preview_put`]) and gets a fresh
//!   random id back. Opening a chat runs nothing.
//! * The store keeps the last [`KEEP`] documents and nothing on disk.
use std::borrow::Cow;
use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex};

use tauri::http::{header, Request, Response, StatusCode};

/// The scheme name. On Windows and Android Tauri serves it as
/// `http://luprev.localhost/`, elsewhere as `luprev://localhost/`; the
/// frontend builds the URL with `convertFileSrc(id, 'luprev')`.
pub const SCHEME: &str = "luprev";

/// How many previews stay servable. A reload asks for a new id, so this only
/// has to cover the frames that are open at the same time.
const KEEP: usize = 16;

/// The biggest document the preview takes. A model answer is far below.
pub const MAX_BYTES: usize = 2 * 1024 * 1024;

struct Entry {
    id: String,
    doc: String,
    allow_network: bool,
}

static STORE: LazyLock<Mutex<VecDeque<Entry>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));

/// The policy of a preview page.
///
/// Inline script and style are what a generated page consists of, so they are
/// in; `eval` too, because small canvas demos and libraries pasted inline use
/// it, and it reaches nothing the inline script could not. Pictures, fonts
/// and media only as `data:` and `blob:` unless the user opened the network.
pub fn preview_csp(allow_network: bool) -> String {
    let net = if allow_network { " https:" } else { "" };
    [
        "default-src 'none'".to_string(),
        format!("script-src 'unsafe-inline' 'unsafe-eval'{net}"),
        format!("style-src 'unsafe-inline'{net}"),
        format!("img-src data: blob:{net}"),
        format!("font-src data:{net}"),
        format!("media-src data: blob:{net}"),
        if allow_network { "connect-src https:".to_string() } else { "connect-src 'none'".to_string() },
        "frame-src 'none'".to_string(),
        "worker-src 'none'".to_string(),
        "object-src 'none'".to_string(),
        "form-action 'none'".to_string(),
        "base-uri 'none'".to_string(),
        "sandbox allow-scripts".to_string(),
    ]
    .join("; ")
}

fn new_id() -> String {
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Keep `doc` for one preview and hand back its id.
pub fn put(doc: String, allow_network: bool) -> Result<String, String> {
    if doc.len() > MAX_BYTES {
        return Err("This page is too large to preview.".into());
    }
    let id = new_id();
    let mut store = STORE.lock().map_err(|_| "preview store poisoned".to_string())?;
    store.push_back(Entry { id: id.clone(), doc, allow_network });
    while store.len() > KEEP {
        store.pop_front();
    }
    Ok(id)
}

/// The id from a request path: `/<32 hex>`, nothing else.
fn id_of(path: &str) -> Option<&str> {
    let id = path.strip_prefix('/')?;
    (id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())).then_some(id)
}

/// Answer one request on the scheme.
pub fn respond(path: &str) -> Response<Cow<'static, [u8]>> {
    let hit = id_of(path).and_then(|id| {
        let store = STORE.lock().ok()?;
        store.iter().find(|e| e.id == id).map(|e| (e.doc.clone(), e.allow_network))
    });
    let Some((doc, allow_network)) = hit else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .header(header::CONTENT_SECURITY_POLICY, preview_csp(false))
            .body(Cow::Borrowed(&b"not found"[..]))
            .expect("static response");
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_SECURITY_POLICY, preview_csp(allow_network))
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Cow::Owned(doc.into_bytes()))
        .expect("preview response")
}

/// The scheme handler Tauri calls.
pub fn handle(request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    respond(request.uri().path())
}

/// Put a document up for preview. Called on the user's click, never on load.
#[tauri::command]
pub fn html_preview_put(doc: String, allow_network: bool) -> Result<String, String> {
    put(doc, allow_network)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The store is one per process; the eviction test fills it, so the
    /// tests take turns instead of racing each other's ids out.
    static TURN: Mutex<()> = Mutex::new(());

    fn csp_of(r: &Response<Cow<'static, [u8]>>) -> String {
        r.headers().get(header::CONTENT_SECURITY_POLICY).unwrap().to_str().unwrap().to_string()
    }

    #[test]
    fn served_page_has_its_own_closed_policy() {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        let id = put("<script>1</script>".into(), false).unwrap();
        let r = respond(&format!("/{id}"));
        assert_eq!(r.status(), StatusCode::OK);
        let csp = csp_of(&r);
        assert!(csp.contains("default-src 'none'"));
        assert!(csp.contains("connect-src 'none'"));
        assert!(csp.contains("frame-src 'none'"));
        assert!(csp.contains("form-action 'none'"));
        assert!(csp.contains("sandbox allow-scripts"));
        assert!(!csp.contains("allow-same-origin"));
        assert!(!csp.contains("http:"), "no plain http source, so no localhost: {csp}");
        assert!(!csp.contains("https:"), "no network without the user's yes: {csp}");
        assert!(!csp.contains("'self'"));
        assert_eq!(&r.body()[..], b"<script>1</script>");
    }

    #[test]
    fn network_only_https_and_only_when_allowed() {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        let id = put("x".into(), true).unwrap();
        let csp = csp_of(&respond(&format!("/{id}")));
        assert!(csp.contains("connect-src https:"));
        assert!(!csp.contains("http:"));
        assert!(!csp.contains("localhost"));
        assert!(!csp.contains("ws:"));
        assert!(csp.contains("sandbox allow-scripts"));
    }

    #[test]
    fn unknown_or_malformed_ids_are_not_found() {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(respond("/").status(), StatusCode::NOT_FOUND);
        assert_eq!(respond("/../etc/passwd").status(), StatusCode::NOT_FOUND);
        assert_eq!(respond(&format!("/{}", "a".repeat(32))).status(), StatusCode::NOT_FOUND);
        let id = put("x".into(), false).unwrap();
        assert_eq!(respond(&format!("/{id}/x")).status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn ids_are_fresh_and_old_pages_drop_out() {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        let first = put("first".into(), false).unwrap();
        let mut ids = vec![first.clone()];
        for i in 0..KEEP {
            ids.push(put(format!("p{i}"), false).unwrap());
        }
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len());
        assert_eq!(respond(&format!("/{first}")).status(), StatusCode::NOT_FOUND);
        assert_eq!(respond(&format!("/{}", ids.last().unwrap())).status(), StatusCode::OK);
    }

    #[test]
    fn oversized_documents_are_refused() {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        assert!(put("a".repeat(MAX_BYTES + 1), false).is_err());
    }
}
