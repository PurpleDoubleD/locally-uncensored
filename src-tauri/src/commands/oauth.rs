// OAuth loopback listener for the LU Cloud login (Google/GitHub via the
// system browser). No deep links: the frontend binds a 127.0.0.1 port from a
// fixed ladder (registered in the Supabase redirect allow-list), opens the
// provider URL in the system browser, and Supabase redirects back to
// http://127.0.0.1:<port>/callback?code=… — this module catches that single
// request and hands the query string to the frontend, which exchanges the
// PKCE code for a session. The code alone is useless without the PKCE
// verifier held app-side, so a local port-sniffing race gains nothing.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

// Fixed port ladder — Supabase's uri_allow_list has no port wildcards, so
// these three exact URIs are registered. Three tries ride out a collision
// with another app or a lingering listener.
const PORT_LADDER: [u16; 3] = [17872, 17873, 17874];

// One armed attempt per port: the oneshot receiver oauth_wait consumes plus
// the accept task's handle. Aborting the task drops the bound TcpListener,
// which is the only way to free the port of an abandoned attempt (dropping
// the receiver alone never wakes a task parked in accept()). The id keeps a
// stale oauth_wait from tearing down a retry that re-armed the same port.
static NEXT_ATTEMPT: AtomicU64 = AtomicU64::new(0);

pub struct PendingLogin {
    id: u64,
    rx: Option<oneshot::Receiver<String>>,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
pub struct OauthPending(pub Mutex<HashMap<u16, PendingLogin>>);

/// The redirect URI handed to Supabase — and registered in its allow-list — is
/// always exactly this path on the ladder port.
const CALLBACK_PATH: &str = "/callback";

/// Longest request head this listener will read before giving up on a socket.
const MAX_HEAD_BYTES: usize = 16 * 1024;

/// What one accepted request turns out to be.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    /// A genuine provider callback; the query string goes to the frontend.
    Callback(String),
    /// Anything else: 404 it and stay armed for the real redirect.
    Reject,
}

/// Decide whether a raw HTTP request is the redirect this attempt is waiting
/// for.
///
/// This listener sits on a loopback port that ANY page in ANY browser can
/// reach — `<img src="http://127.0.0.1:17872/x?error=…">` is a cross-origin
/// request the browser sends without asking anyone, and no same-origin policy
/// stops it being SENT. It used to be enough for such a request to carry
/// `code=` or `error=` anywhere in its query: it was answered, the pending
/// sign-in was resolved with the stranger's query, and their attacker-written
/// `error_description` was displayed in LU's auth panel. Any page could
/// therefore kill a sign-in in progress and put text of its choosing in front
/// of the user. So a request now has to look like what Supabase actually
/// sends:
///
/// * `GET` — the redirect is a navigation, never a POST.
/// * exactly `/callback` — the only path in the redirect allow-list.
/// * `Host: 127.0.0.1:<port>` (or `localhost:<port>`) — a DNS-rebinding page
///   reaches this same socket under its own hostname, which is not that.
/// * no `Origin` header — a cross-site top-level navigation does not send
///   one, while every `fetch`/XHR (`no-cors` included) does.
/// * `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document` whenever the
///   browser sends those headers. A page cannot forge or drop them, and they
///   are exactly what separates the redirect from an `<img>`, `<script>` or
///   `<iframe>` pointed at the same URL. Absent (pre-2023 Safari, a non-
///   browser client) they simply do not vote.
///
/// KNOWN LIMITATION, stated plainly because the version of this comment that
/// stood here was wrong and wrong in the reassuring direction.
///
/// It claimed that what survives the checks above "needs a user gesture and
/// opens a visible window". It does not. `location.href = "http://127.0.0.1:
/// 17872/callback?error=…"`, a `<meta http-equiv="refresh">` and a server-side
/// 302 are all TOP-LEVEL navigations, any page the user already has open can
/// start one with no gesture and nothing visible, and the browser sends exactly
/// the shape this function accepts: `GET /callback`, the loopback `Host`, no
/// `Origin`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`. Nothing in
/// the request distinguishes it from Supabase's redirect.
///
/// So, while a sign-in is pending, any open tab can end the wait and choose the
/// text the user is then shown. What it CANNOT do is sign anyone in: the PKCE
/// verifier never leaves the app, so a stranger's `code` fails the exchange —
/// the residual is a denial of the sign-in plus attacker-chosen text, and
/// src/api/cloud/supabase.ts (`providerErrorText`) is what keeps that text from
/// posing as LU's own words. `a_scripted_top_level_navigation_…` below pins the
/// limitation so it stays visible.
///
/// What would actually close it is a per-attempt `state` nonce, and it cannot
/// be built here alone: the Supabase PKCE redirect carries `code` alone, so the
/// nonce would have to ride on the redirect URI as a query parameter
/// (`…/callback?state=<nonce>`) — and that URI is matched against the Supabase
/// project's `uri_allow_list`, which holds the three ladder URIs as EXACT
/// entries. A redirect URI with a query would not match, GoTrue would fall back
/// to the site URL, and sign-in would break for everyone. Making the nonce
/// possible is a server-side change to that allow-list (see the note in the
/// changelog); until it happens there is no half-measure worth adding here,
/// because a nonce this listener generates but the redirect never carries is
/// dead code that only looks like a defence.
fn classify(req: &str, port: u16) -> Verdict {
    let mut lines = req.lines();
    let Some(request_line) = lines.next() else {
        return Verdict::Reject;
    };
    let mut parts = request_line.split_whitespace();
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else {
        return Verdict::Reject;
    };
    if method != "GET" {
        return Verdict::Reject;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != CALLBACK_PATH {
        return Verdict::Reject;
    }
    if !query
        .split('&')
        .any(|kv| kv.starts_with("code=") || kv.starts_with("error="))
    {
        return Verdict::Reject;
    }
    let mut host_ok = false;
    for line in lines {
        if line.is_empty() {
            break; // end of the header block
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "host" => {
                host_ok = value == format!("127.0.0.1:{port}") || value == format!("localhost:{port}")
            }
            "origin" => return Verdict::Reject,
            "sec-fetch-mode" if !value.eq_ignore_ascii_case("navigate") => return Verdict::Reject,
            "sec-fetch-dest" if !value.eq_ignore_ascii_case("document") => return Verdict::Reject,
            _ => {}
        }
    }
    if !host_ok {
        return Verdict::Reject;
    }
    Verdict::Callback(query.to_string())
}

/// Read one request head (up to the blank line). The whole head shares a
/// single deadline rather than each read having its own: a socket dribbling a
/// byte at a time must not park the accept loop while the real callback waits
/// in the backlog.
async fn read_head(stream: &mut tokio::net::TcpStream) -> String {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    let mut head = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    loop {
        let n = match tokio::time::timeout_at(deadline, stream.read(&mut chunk)).await {
            Ok(Ok(n)) if n > 0 => n,
            _ => break,
        };
        head.extend_from_slice(&chunk[..n]);
        if head.windows(4).any(|w| w == b"\r\n\r\n") || head.len() >= MAX_HEAD_BYTES {
            break;
        }
    }
    String::from_utf8_lossy(&head).into_owned()
}

const CALLBACK_BODY: &str ="<!doctype html><html><body style=\"font-family:-apple-system,system-ui,sans-serif;background:#161616;color:#e5e5e5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\"><p>Signed in — you can close this tab and return to LU.</p></body></html>";
const DENIED_BODY: &str = "<!doctype html><html><body style=\"font-family:-apple-system,system-ui,sans-serif;background:#161616;color:#e5e5e5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\"><p>Sign-in didn't complete — you can close this tab and try again in LU.</p></body></html>";

/// Bind the first free ladder port and arm an accept loop that serves exactly
/// one callback (strays get a 404). Returns the port so the frontend can build
/// the redirect URI before opening the browser.
#[tauri::command]
pub async fn oauth_start(state: tauri::State<'_, OauthPending>) -> Result<u16, String> {
    // Only one sign-in flow at a time: abort every stale attempt first so an
    // abandoned one (closed browser tab, cancelled wait) releases its ladder
    // port instead of leaking the listener for the process lifetime.
    let stale: Vec<PendingLogin> = state.0.lock().unwrap().drain().map(|(_, p)| p).collect();
    for pending in stale {
        pending.task.abort();
        // Wait for the abort to land so the port is actually free to rebind.
        let _ = pending.task.await;
    }
    for port in PORT_LADDER {
        let listener = match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(_) => continue, // port taken — try the next rung
        };
        let (tx, rx) = oneshot::channel::<String>();
        let task = tauri::async_runtime::spawn(async move {
            // Accept until a request actually IS the provider redirect (see
            // classify). Everything else — browser preconnects that send no
            // bytes, favicon fetches, localhost port probes, and any page
            // trying to plant its own query here — gets a 404 while the armed
            // window stays open for the real redirect, so a stray can neither
            // resolve nor cancel the sign-in. oauth_wait's timeout/abort
            // bounds the loop's lifetime; the listener drops with this task.
            // If oauth_wait times out first, tx.send just errs into the void.
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let req = read_head(&mut stream).await;
                let Verdict::Callback(query) = classify(&req, port) else {
                    let _ = stream
                        .write_all(
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        )
                        .await;
                    let _ = stream.shutdown().await;
                    continue;
                };
                // Provider denial arrives as error=…&error_description=… — be
                // honest in the tab; the frontend gets the raw query either way.
                let body = if query.split('&').any(|kv| kv.starts_with("error=")) {
                    DENIED_BODY
                } else {
                    CALLBACK_BODY
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes()).await;
                let _ = stream.shutdown().await;
                let _ = tx.send(query);
                return;
            }
        });
        let id = NEXT_ATTEMPT.fetch_add(1, Ordering::Relaxed);
        state
            .0
            .lock()
            .unwrap()
            .insert(port, PendingLogin { id, rx: Some(rx), task });
        return Ok(port);
    }
    Err("no loopback port available (17872-17874) — close the app using them and retry".into())
}

/// Await the browser round-trip on a port armed by oauth_start. Returns the
/// raw callback query string (code=…, or error=…&error_description=…).
#[tauri::command]
pub async fn oauth_wait(
    port: u16,
    timeout_secs: u64,
    state: tauri::State<'_, OauthPending>,
) -> Result<String, String> {
    // Take the receiver but leave the entry, so a concurrent oauth_start
    // (retry after a UI cancel) can still find and abort the accept task.
    let (id, rx) = {
        let mut map = state.0.lock().unwrap();
        let pending = map
            .get_mut(&port)
            .ok_or("no pending oauth listener on that port")?;
        let rx = pending
            .rx
            .take()
            .ok_or("oauth wait already running on that port")?;
        (pending.id, rx)
    };
    let result =
        tokio::time::timeout(std::time::Duration::from_secs(timeout_secs.clamp(10, 900)), rx).await;
    // The attempt is over either way — drop the accept task so the listener
    // releases the port (no-op if it already served the callback). Only touch
    // our own attempt: a retry's oauth_start may have drained it and re-armed
    // the same port already.
    {
        let mut map = state.0.lock().unwrap();
        if map.get(&port).is_some_and(|p| p.id == id) {
            if let Some(pending) = map.remove(&port) {
                pending.task.abort();
            }
        }
    }
    match result {
        Ok(Ok(query)) => Ok(query),
        Ok(Err(_)) => Err("oauth listener closed before the browser returned".into()),
        Err(_) => Err("sign-in timed out — the browser never came back".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::{classify, Verdict};

    const PORT: u16 = 17872;

    /// What Supabase's 302 makes the browser send.
    fn real_redirect(query: &str) -> String {
        format!(
            "GET /callback?{query} HTTP/1.1\r\n\
             Host: 127.0.0.1:{PORT}\r\n\
             Upgrade-Insecure-Requests: 1\r\n\
             Accept: text/html,application/xhtml+xml\r\n\
             Sec-Fetch-Site: cross-site\r\n\
             Sec-Fetch-Mode: navigate\r\n\
             Sec-Fetch-Dest: document\r\n\
             Connection: close\r\n\r\n"
        )
    }

    #[test]
    fn the_real_redirect_is_accepted() {
        assert_eq!(
            classify(&real_redirect("code=abc123"), PORT),
            Verdict::Callback("code=abc123".into())
        );
    }

    #[test]
    fn a_provider_denial_is_still_a_callback() {
        let q = "error=access_denied&error_description=The+user+said+no";
        assert_eq!(classify(&real_redirect(q), PORT), Verdict::Callback(q.into()));
    }

    #[test]
    fn a_browser_that_sends_no_sec_fetch_headers_still_gets_in() {
        // Pre-16.4 Safari. Those headers cannot vote when they are absent.
        let req = format!(
            "GET /callback?code=abc HTTP/1.1\r\nHost: localhost:{PORT}\r\nConnection: close\r\n\r\n"
        );
        assert_eq!(classify(&req, PORT), Verdict::Callback("code=abc".into()));
    }

    // ── the attacks the loopback used to serve ──────────────────────────

    #[test]
    fn an_image_tag_on_any_page_cannot_kill_the_sign_in() {
        // <img src="http://127.0.0.1:17872/callback?error=…"> — same URL, but
        // the browser labels it as a subresource fetch, and only a browser can
        // set these headers.
        let req = format!(
            "GET /callback?error=nope&error_description=Your+account+was+closed HTTP/1.1\r\n\
             Host: 127.0.0.1:{PORT}\r\n\
             Sec-Fetch-Site: cross-site\r\n\
             Sec-Fetch-Mode: no-cors\r\n\
             Sec-Fetch-Dest: image\r\n\r\n"
        );
        assert_eq!(classify(&req, PORT), Verdict::Reject);
    }

    #[test]
    fn a_scripted_fetch_is_refused_by_its_origin_alone() {
        // fetch(url, {mode:'no-cors'}) reaches the socket, but always names
        // the page it came from.
        let req = format!(
            "GET /callback?code=attacker HTTP/1.1\r\n\
             Host: 127.0.0.1:{PORT}\r\n\
             Origin: https://evil.example\r\n\r\n"
        );
        assert_eq!(classify(&req, PORT), Verdict::Reject);
    }

    #[test]
    fn an_iframe_navigation_is_not_a_top_level_one() {
        let req = format!(
            "GET /callback?code=attacker HTTP/1.1\r\n\
             Host: 127.0.0.1:{PORT}\r\n\
             Sec-Fetch-Mode: navigate\r\n\
             Sec-Fetch-Dest: iframe\r\n\r\n"
        );
        assert_eq!(classify(&req, PORT), Verdict::Reject);
    }

    #[test]
    fn dns_rebinding_reaches_the_socket_under_the_wrong_host() {
        let req = "GET /callback?code=abc HTTP/1.1\r\n\
                   Host: rebind.evil.example:17872\r\n\
                   Sec-Fetch-Mode: navigate\r\n\
                   Sec-Fetch-Dest: document\r\n\r\n";
        assert_eq!(classify(req, PORT), Verdict::Reject);
    }

    #[test]
    fn a_host_naming_another_ladder_port_is_not_this_attempt() {
        let req = "GET /callback?code=abc HTTP/1.1\r\nHost: 127.0.0.1:17873\r\n\r\n";
        assert_eq!(classify(req, PORT), Verdict::Reject);
    }

    #[test]
    fn a_missing_host_header_is_not_trusted() {
        assert_eq!(
            classify("GET /callback?code=abc HTTP/1.1\r\n\r\n", PORT),
            Verdict::Reject
        );
    }

    #[test]
    fn the_query_must_live_on_the_callback_path() {
        let req = format!("GET /?code=abc HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\n\r\n");
        assert_eq!(classify(&req, PORT), Verdict::Reject);
        let req = format!("GET /callback/x?code=abc HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\n\r\n");
        assert_eq!(classify(&req, PORT), Verdict::Reject);
    }

    #[test]
    fn a_post_is_never_the_redirect() {
        let req = format!("POST /callback?code=abc HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\n\r\n");
        assert_eq!(classify(&req, PORT), Verdict::Reject);
    }

    /// THE RESIDUAL, pinned rather than described.
    ///
    /// `location.href = …` from any open tab produces this request — no user
    /// gesture, no visible window, and byte for byte what Supabase's 302
    /// produces. It is accepted, and it has to be: nothing in a top-level
    /// navigation says who started it. Only a per-attempt `state` nonce
    /// separates them, and the nonce needs a redirect URI with a query
    /// parameter, which the Supabase project's exact-match `uri_allow_list`
    /// refuses (see `classify`).
    ///
    /// This test therefore documents a limitation, not a guarantee. When the
    /// allow-list gains an entry that tolerates `?state=`, this is the test
    /// that must flip to `Reject` — and it will fail until someone does.
    #[test]
    fn a_scripted_top_level_navigation_is_indistinguishable_from_the_real_redirect() {
        let scripted = format!(
            "GET /callback?error=access_denied&error_description=Your+account+was+closed HTTP/1.1\r\n\
             Host: 127.0.0.1:{PORT}\r\n\
             Upgrade-Insecure-Requests: 1\r\n\
             Accept: text/html,application/xhtml+xml\r\n\
             Sec-Fetch-Site: cross-site\r\n\
             Sec-Fetch-Mode: navigate\r\n\
             Sec-Fetch-Dest: document\r\n\
             Connection: close\r\n\r\n"
        );
        // Identical to what the provider's redirect sends — same method, same
        // path, same Host, no Origin, same Sec-Fetch triple.
        assert_eq!(
            classify(&scripted, PORT),
            classify(
                &real_redirect("error=access_denied&error_description=Your+account+was+closed"),
                PORT
            ),
            "the two are distinguishable now — if that is a `state` check, this test is stale",
        );
    }

    // ── strays that must not end the attempt either ─────────────────────

    #[test]
    fn preconnects_and_probes_are_rejected_without_a_query() {
        for req in [
            "",
            "GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1:17872\r\n\r\n",
            "GET /callback HTTP/1.1\r\nHost: 127.0.0.1:17872\r\n\r\n",
        ] {
            assert_eq!(classify(req, PORT), Verdict::Reject);
        }
    }

    #[test]
    fn a_code_lookalike_parameter_is_not_a_code() {
        // `?decode=1` used to satisfy the old "contains code=" test.
        let req = format!("GET /callback?decode=1 HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\n\r\n");
        assert_eq!(classify(&req, PORT), Verdict::Reject);
    }

    #[test]
    fn header_names_are_matched_case_insensitively() {
        let req = format!(
            "GET /callback?code=abc HTTP/1.1\r\nHOST: 127.0.0.1:{PORT}\r\nSEC-FETCH-DEST: Document\r\n\r\n"
        );
        assert_eq!(classify(&req, PORT), Verdict::Callback("code=abc".into()));
    }
}
