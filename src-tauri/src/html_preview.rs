//! The page behind the chat's HTML preview (B29, 3.0.9).
//!
//! Why a server of its own and not `srcdoc`: an `about:srcdoc` frame inherits
//! the policy of the page that holds it, and the app's policy says
//! `script-src 'self'`. The model's inline script was therefore never run in
//! the shipped app. A document served here has its own response and so its
//! own policy, the one [`preview_csp`] writes, and nothing of the app's.
//!
//! Why 127.0.0.1 and not a custom scheme (owner decision 30.10.2026, "zweite
//! Mauer"): Tauri counts every scheme the app registers as a LOCAL origin
//! (`Webview::is_local_url`), so a frame on one would carry the app's ACL.
//! `http://127.0.0.1:<port>` matches neither the app URL nor a registered
//! scheme, so Tauri treats the frame as REMOTE, and no capability of this app
//! names a remote URL (tested in `html-preview-b29.test.tsx`). What stays the
//! one lock for the app's own commands is Tauri's invoke key: this app has no
//! app ACL manifest, and Tauri checks the ACL for plugin commands only then.
//! The key is injected into the main frame only on macOS and Linux; for
//! Windows see [`GUARD`].
//!
//! What keeps the preview away from the app, in layers:
//!
//! * The frame is sandboxed without `allow-same-origin` (frontend), and the
//!   response says the same once more with the CSP `sandbox` directive.
//! * The policy has no `connect-src`, no `frame-src`, no `form-action`, no
//!   worker and no remote source. Network only after the user allowed it for
//!   this one page, and then `https:` alone, never `http:` or localhost.
//! * The server binds 127.0.0.1 on a random port, answers GET only, wants the
//!   `Host` it was reached under (no DNS rebinding) and a 128-bit token per
//!   page in the path. It starts with the first open preview and stops when
//!   the last one closes ([`html_preview_close`]).
//! * Every page starts with [`GUARD`], before any script of its own. WebView2
//!   (Windows) puts Tauri's init scripts into every frame, so there the
//!   frame has `__TAURI_INTERNALS__`, non-configurable. The guard locks the
//!   one door a page could take the invoke key through (html_preview_guard.js).
//! * The page does not exist until the user clicks Preview. Opening a chat
//!   runs nothing. Nothing is written to disk; at most [`KEEP`] pages live.
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

/// The script in front of every page (see html_preview_guard.js).
pub const GUARD: &str = include_str!("html_preview_guard.js");

/// `doc` with [`GUARD`] as its first script. It goes right behind a leading
/// doctype (before it a script would switch the page to quirks mode), else at
/// the very start. Only whitespace and comments can stand in front of a
/// doctype, so no script of the page runs before the guard.
pub fn with_guard(doc: &str) -> String {
    let tag = format!("<script>{GUARD}</script>");
    let at = doctype_end(doc).unwrap_or(0);
    format!("{}{tag}{}", &doc[..at], &doc[at..])
}

/// Where a leading `<!doctype …>` ends, past BOM, whitespace and comments.
fn doctype_end(doc: &str) -> Option<usize> {
    let mut i = 0;
    let b = doc.as_bytes();
    if doc.starts_with('\u{feff}') {
        i = '\u{feff}'.len_utf8();
    }
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if doc[i..].starts_with("<!--") {
            i += doc[i..].find("-->")? + 3;
            continue;
        }
        break;
    }
    let rest = doc.get(i..i + 9)?;
    if !rest.eq_ignore_ascii_case("<!doctype") {
        return None;
    }
    Some(i + doc[i..].find('>')? + 1)
}

/// How many previews stay servable. A reload asks for a new page, so this only
/// has to cover the frames that are open at the same time.
const KEEP: usize = 16;

/// The biggest document the preview takes. A model answer is far below.
pub const MAX_BYTES: usize = 2 * 1024 * 1024;

/// The longest request head the server reads. A GET with a token is tiny.
const MAX_HEAD: usize = 8 * 1024;

struct Entry {
    id: String,
    doc: String,
    allow_network: bool,
}

struct Running {
    port: u16,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
struct State {
    pages: VecDeque<Entry>,
    server: Option<Running>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| Mutex::new(State::default()));

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

/// What the frontend gets for one page.
#[derive(serde::Serialize, Debug, Clone)]
pub struct PreviewPage {
    /// Hand back to [`close`] when the preview goes.
    pub id: String,
    /// `http://127.0.0.1:<port>/<id>`, the frame's src.
    pub url: String,
}

/// Keep `doc` for one preview, start the server if it is not running, and
/// hand back where the frame loads it.
pub fn put(doc: String, allow_network: bool) -> Result<PreviewPage, String> {
    if doc.len() > MAX_BYTES {
        return Err("This page is too large to preview.".into());
    }
    let mut st = STATE.lock().map_err(|_| "preview store poisoned".to_string())?;
    if st.server.is_none() {
        st.server = Some(start()?);
    }
    let port = st.server.as_ref().map(|s| s.port).unwrap_or_default();
    let id = new_id();
    st.pages.push_back(Entry { id: id.clone(), doc, allow_network });
    while st.pages.len() > KEEP {
        st.pages.pop_front();
    }
    Ok(PreviewPage { url: format!("http://127.0.0.1:{port}/{id}"), id })
}

/// Forget one page. The last one closed stops the server.
pub fn close(id: &str) {
    let Ok(mut st) = STATE.lock() else { return };
    st.pages.retain(|e| e.id != id);
    if st.pages.is_empty() {
        if let Some(s) = st.server.take() {
            stop(s);
        }
    }
}

/// The port the server listens on, while it runs.
#[cfg(test)]
fn running_port() -> Option<u16> {
    STATE.lock().ok().and_then(|s| s.server.as_ref().map(|r| r.port))
}

fn start() -> Result<Running, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("preview server: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    std::thread::Builder::new()
        .name("html-preview".into())
        .spawn(move || {
            for conn in listener.incoming() {
                if flag.load(Ordering::SeqCst) {
                    break;
                }
                if let Ok(s) = conn {
                    serve(s, port);
                }
            }
        })
        .map_err(|e| e.to_string())?;
    tracing::info!(port, "html preview server started");
    Ok(Running { port, stop })
}

fn stop(r: Running) {
    r.stop.store(true, Ordering::SeqCst);
    // Wake the blocking accept so the thread sees the flag and drops the socket.
    let _ = TcpStream::connect_timeout(&([127, 0, 0, 1], r.port).into(), Duration::from_millis(300));
    tracing::info!(port = r.port, "html preview server stopped");
}

/// The id from a request path: `/<32 hex>`, nothing else.
fn id_of(path: &str) -> Option<&str> {
    let id = path.strip_prefix('/')?;
    (id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())).then_some(id)
}

/// One answer, as status, headers and body. Pure, so the tests read it whole.
pub fn respond(method: &str, path: &str, host: Option<&str>, port: u16) -> (u16, Vec<(String, String)>, Vec<u8>) {
    let closed = vec![
        ("Content-Type".to_string(), "text/plain; charset=utf-8".to_string()),
        ("Content-Security-Policy".to_string(), preview_csp(false)),
    ];
    if host != Some(format!("127.0.0.1:{port}").as_str()) {
        return (403, closed, b"forbidden".to_vec());
    }
    if method != "GET" {
        let mut h = closed;
        h.push(("Allow".into(), "GET".into()));
        return (405, h, b"method not allowed".to_vec());
    }
    let hit = id_of(path).and_then(|id| {
        let st = STATE.lock().ok()?;
        st.pages.iter().find(|e| e.id == id).map(|e| (e.doc.clone(), e.allow_network))
    });
    let Some((doc, allow_network)) = hit else {
        return (404, closed, b"not found".to_vec());
    };
    (
        200,
        vec![
            ("Content-Type".into(), "text/html; charset=utf-8".into()),
            ("Content-Security-Policy".into(), preview_csp(allow_network)),
            ("X-Content-Type-Options".into(), "nosniff".into()),
            ("Referrer-Policy".into(), "no-referrer".into()),
            ("Cache-Control".into(), "no-store".into()),
            ("Cross-Origin-Resource-Policy".into(), "same-origin".into()),
        ],
        with_guard(&doc).into_bytes(),
    )
}

fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Bad Request",
    }
}

fn serve(mut s: TcpStream, port: u16) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(10)));
    let mut head = Vec::with_capacity(512);
    let mut buf = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match s.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => head.extend_from_slice(&buf[..n]),
        }
        if head.len() > MAX_HEAD {
            break;
        }
    }
    let text = String::from_utf8_lossy(&head);
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or("").split_whitespace();
    let method = first.next().unwrap_or("");
    let path = first.next().unwrap_or("");
    let host = lines
        .take_while(|l| !l.is_empty())
        .find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case("host")).map(|(_, v)| v.trim().to_string()));
    let (code, headers, body) = if method.is_empty() {
        (400, Vec::new(), Vec::new())
    } else {
        respond(method, path, host.as_deref(), port)
    };
    let mut out = format!("HTTP/1.1 {code} {}\r\n", reason(code));
    for (k, v) in &headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()));
    let _ = s.write_all(out.as_bytes());
    let _ = s.write_all(&body);
    let _ = s.shutdown(Shutdown::Both);
}

/// Put a document up for preview. Called on the user's click, never on load.
#[tauri::command]
pub fn html_preview_put(doc: String, allow_network: bool) -> Result<PreviewPage, String> {
    put(doc, allow_network)
}

/// The preview went (closed, reloaded, network switched, chat left).
#[tauri::command]
pub fn html_preview_close(id: String) {
    close(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The state is one per process; the tests take turns.
    static TURN: Mutex<()> = Mutex::new(());

    fn turn() -> std::sync::MutexGuard<'static, ()> {
        let g = TURN.lock().unwrap_or_else(|e| e.into_inner());
        let ids: Vec<String> = STATE.lock().unwrap().pages.iter().map(|e| e.id.clone()).collect();
        for id in ids {
            close(&id);
        }
        g
    }

    fn http(port: u16, raw: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        s.write_all(raw.as_bytes()).unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    fn csp_line(resp: &str) -> String {
        resp.lines().find(|l| l.starts_with("Content-Security-Policy:")).unwrap_or("").to_string()
    }

    #[test]
    fn served_over_loopback_with_its_own_closed_policy() {
        let _t = turn();
        let p = put("<script>1</script>".into(), false).unwrap();
        let port = running_port().unwrap();
        assert_eq!(p.url, format!("http://127.0.0.1:{port}/{}", p.id));
        let r = http(port, &format!("GET /{} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n", p.id));
        assert!(r.starts_with("HTTP/1.1 200 OK"), "{r}");
        assert!(r.ends_with("<script>1</script>"));
        let csp = csp_line(&r);
        for d in ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "sandbox allow-scripts"] {
            assert!(csp.contains(d), "{d} missing: {csp}");
        }
        assert!(!csp.contains("allow-same-origin"));
        assert!(!csp.contains("http:"), "no plain http source, so no localhost: {csp}");
        assert!(!csp.contains("https:"), "no network without the user's yes: {csp}");
        assert!(!csp.contains("'self'"));
    }

    #[test]
    fn network_only_https_and_only_when_allowed() {
        let _t = turn();
        let p = put("x".into(), true).unwrap();
        let port = running_port().unwrap();
        let (_, h, _) = respond("GET", &format!("/{}", p.id), Some(&format!("127.0.0.1:{port}")), port);
        let csp = &h.iter().find(|(k, _)| k == "Content-Security-Policy").unwrap().1;
        assert!(csp.contains("connect-src https:"));
        assert!(!csp.contains("http:") && !csp.contains("localhost") && !csp.contains("ws:"));
        assert!(csp.contains("sandbox allow-scripts"));
    }

    #[test]
    fn only_get_only_its_own_host_only_known_tokens() {
        let _t = turn();
        let p = put("x".into(), false).unwrap();
        let port = running_port().unwrap();
        let host = format!("Host: 127.0.0.1:{port}");
        assert!(http(port, &format!("POST /{} HTTP/1.1\r\n{host}\r\nContent-Length: 0\r\n\r\n", p.id)).starts_with("HTTP/1.1 405"));
        assert!(http(port, &format!("GET /{} HTTP/1.1\r\nHost: evil.example:{port}\r\n\r\n", p.id)).starts_with("HTTP/1.1 403"));
        assert!(http(port, &format!("GET /{} HTTP/1.1\r\n\r\n", p.id)).starts_with("HTTP/1.1 403"));
        assert!(http(port, &format!("GET / HTTP/1.1\r\n{host}\r\n\r\n")).starts_with("HTTP/1.1 404"));
        assert!(http(port, &format!("GET /{} HTTP/1.1\r\n{host}\r\n\r\n", "a".repeat(32))).starts_with("HTTP/1.1 404"));
        assert!(http(port, &format!("GET /{}/x HTTP/1.1\r\n{host}\r\n\r\n", p.id)).starts_with("HTTP/1.1 404"));
        assert!(http(port, &format!("GET /../etc/passwd HTTP/1.1\r\n{host}\r\n\r\n")).starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn the_server_runs_only_while_a_preview_is_open() {
        let _t = turn();
        assert_eq!(running_port(), None, "no server before the first preview");
        let a = put("a".into(), false).unwrap();
        let b = put("b".into(), false).unwrap();
        let port = running_port().unwrap();
        close(&a.id);
        assert_eq!(running_port(), Some(port), "one preview still open");
        let r = http(port, &format!("GET /{} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n", a.id));
        assert!(r.starts_with("HTTP/1.1 404"), "a closed page is gone");
        close(&b.id);
        assert_eq!(running_port(), None);
        std::thread::sleep(Duration::from_millis(200));
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err(), "the port is closed after the last preview");
    }

    #[test]
    fn tokens_are_fresh_and_old_pages_drop_out() {
        let _t = turn();
        let first = put("first".into(), false).unwrap();
        let mut ids = vec![first.id.clone()];
        for i in 0..KEEP {
            ids.push(put(format!("p{i}"), false).unwrap().id);
        }
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len());
        let port = running_port().unwrap();
        let host = Some(format!("127.0.0.1:{port}"));
        assert_eq!(respond("GET", &format!("/{}", first.id), host.as_deref(), port).0, 404);
        assert_eq!(respond("GET", &format!("/{}", ids.last().unwrap()), host.as_deref(), port).0, 200);
    }

    #[test]
    fn oversized_documents_are_refused() {
        let _t = turn();
        assert!(put("a".repeat(MAX_BYTES + 1), false).is_err());
        assert_eq!(running_port(), None, "a refused page starts no server");
    }

    /// Windows (I1, box 31.10.): Tauri's globals reach the frame there. The
    /// guard has to run before any script of the page, on every page served.
    #[test]
    fn every_page_starts_with_the_guard_before_its_own_scripts() {
        let _t = turn();
        let tag = format!("<script>{GUARD}</script>");
        for (doc, before) in [
            ("<!DOCTYPE html><html><head><script>evil()</script>", "<!DOCTYPE html>"),
            ("\u{feff} <!-- a --> <!doctype html>\n<script>evil()</script>", "\u{feff} <!-- a --> <!doctype html>"),
            ("<script>evil()</script><!DOCTYPE html>", ""),
            ("<p>no doctype</p><script>evil()</script>", ""),
            ("<!-- open comment <script>evil()</script>", ""),
            ("", ""),
        ] {
            let out = with_guard(doc);
            assert!(out.starts_with(&format!("{before}{tag}")), "{doc:?} -> {out:?}");
            assert_eq!(out.find("<script"), Some(before.len()), "{doc:?}");
            assert_eq!(out.replacen(&tag, "", 1), doc);
        }
        // And over the wire.
        let p = put("<!doctype html><script>evil()</script>".into(), false).unwrap();
        let port = running_port().unwrap();
        let (code, _, body) = respond("GET", &format!("/{}", p.id), Some(&format!("127.0.0.1:{port}")), port);
        assert_eq!(code, 200);
        let body = String::from_utf8(body).unwrap();
        assert!(body.starts_with(&format!("<!doctype html>{tag}<script>evil()")), "{body}");
        // The guard keeps the key's header out and leaves the app's window alone.
        assert!(GUARD.contains("if (window === window.top) return"));
        assert!(GUARD.contains("'tauri-invoke-key'"));
    }

}
