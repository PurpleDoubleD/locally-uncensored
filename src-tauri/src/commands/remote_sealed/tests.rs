//! The desktop side of the sealed channel, end to end: a phone made of
//! `remote_seal::PhoneHandshake` talks to the real LAN and tunnel routers of
//! commands/remote.rs, in this process. The upstream "Ollama" is a small
//! server on loopback.

use super::*;
use crate::commands::remote::{sealed_test_rig, SealedTestRig};
use crate::remote_seal::{PhoneHandshake, PhoneHello};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::routing::any;
use axum::Router;
use std::net::SocketAddr;
use tower::ServiceExt;

const T0: u64 = 1_790_000_000;

struct Rig {
    hub: Arc<SealedHub>,
    clock: Arc<AtomicU64>,
    routers: SealedTestRig,
    events: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    upstream: tokio::task::JoinHandle<()>,
    _dir: tempfile::TempDir,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.upstream.abort();
    }
}

async fn rig_with(hold: Duration, poll_hold: Duration) -> Rig {
    let upstream_router = Router::new().fallback(any(|req: Request<Body>| async move {
        match req.uri().path() {
            "/api/tags" => axum::Json(serde_json::json!({ "models": [{ "name": "fixture-model" }] })).into_response(),
            "/api/slow" => {
                tokio::time::sleep(Duration::from_millis(600)).await;
                axum::Json(serde_json::json!({ "slow": "done" })).into_response()
            }
            _ => StatusCode::NOT_FOUND.into_response(),
        }
    }));
    let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", upstream_listener.local_addr().unwrap());
    let upstream = tokio::spawn(async move {
        let _ = axum::serve(upstream_listener, upstream_router).await;
    });
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(AtomicU64::new(T0));
    let c = clock.clone();
    let hub = Arc::new(SealedHub::assemble(
        DeviceSecret::from_bytes([0x22; 32]),
        "Studio PC",
        "file",
        Some(dir.path().join(DEVICES_FILE)),
        DeviceBook::default(),
        Arc::new(move || c.load(Ordering::SeqCst)),
        hold,
        poll_hold,
    ));
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    hub.set_notifier(Arc::new(move |e: &str, v: serde_json::Value| lock(&sink).push((e.to_string(), v))));
    hub.expect_tunnel_host(TEST_TUNNEL);
    let routers = sealed_test_rig(hub.clone(), base);
    Rig { hub, clock, routers, events, upstream, _dir: dir }
}

async fn rig() -> Rig {
    rig_with(Duration::from_secs(5), Duration::from_secs(5)).await
}

use axum::response::IntoResponse;

impl Rig {
    fn advance(&self, secs: u64) {
        self.clock.fetch_add(secs, Ordering::SeqCst);
    }

    fn now(&self) -> u64 {
        self.clock.load(Ordering::SeqCst)
    }

    fn ticket(&self) -> PairingSecret {
        self.hub.set_pairing_window(true);
        let (uri, _) = self.hub.pairing_link(Some("http://192.0.2.10:11435".into()), None).unwrap();
        PairingSecret::Ticket(PairingLink::parse(&uri).unwrap().ticket)
    }

    fn last_request_id(&self) -> String {
        lock(&self.events)
            .iter()
            .rev()
            .find(|(e, _)| e == "remote-pair-request")
            .map(|(_, v)| v["requestId"].as_str().unwrap().to_string())
            .expect("a pairing request was shown")
    }
}

#[derive(Clone, Copy)]
enum Via {
    Lan(&'static str),
    Tunnel(&'static str),
}

async fn send(rig: &Rig, via: Via, method: &str, path: &str, body: Vec<u8>) -> (StatusCode, HeaderMap, Vec<u8>) {
    let (router, peer, cf) = match via {
        Via::Lan(ip) => (rig.routers.lan.clone(), format!("{ip}:40000"), None),
        Via::Tunnel(ip) => (rig.routers.tunnel.clone(), "127.0.0.1:40000".to_string(), Some(ip)),
    };
    let mut builder = Request::builder().method(method).uri(path).header("content-type", "application/octet-stream");
    if let Some(ip) = cf {
        builder = builder.header("cf-connecting-ip", ip);
    }
    let mut req = tunnel_host(builder, via).body(Body::from(body)).unwrap();
    req.extensions_mut().insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
    let res = router.oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap().to_vec();
    (status, headers, bytes)
}

/// The request builder as the listener expects it (Host of the tunnel).
const TEST_TUNNEL: &str = "https://quiet-river-1234.trycloudflare.com";

fn tunnel_host(builder: axum::http::request::Builder, via: Via) -> axum::http::request::Builder {
    match via {
        Via::Tunnel(_) => builder.header("host", "quiet-river-1234.trycloudflare.com"),
        Via::Lan(_) => builder,
    }
}

fn error_of(body: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(body).unwrap()["error"].as_str().unwrap_or("").to_string()
}

struct Phone {
    secret: DeviceSecret,
    session: Option<Session>,
}

struct Answer {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Answer {
    fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
    }
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

impl Phone {
    fn new(seed: u8) -> Self {
        Self { secret: DeviceSecret::from_bytes([seed; 32]), session: None }
    }

    fn device_id(&self) -> String {
        self.secret.device_id()
    }

    fn init(&self, rig: &Rig, pairing: Option<&PairingSecret>) -> (PhoneHandshake, Vec<u8>) {
        let hello = PhoneHello::new(&self.secret, "Pixel 8", "android", "3.0.7");
        PhoneHandshake::start(&self.secret, &rig.hub.secret.desktop_id(), &rig.hub.secret.x25519_public(), pairing, &hello).unwrap()
    }

    /// Handshake; on 200 the phone keeps the session. Returns the outer
    /// status and the desktop's pairing state.
    async fn connect(&mut self, rig: &Rig, via: Via, pairing: Option<&PairingSecret>) -> (StatusCode, Option<PairState>, Vec<u8>) {
        let (hs, init) = self.init(rig, pairing);
        let (status, _, body) = send(rig, via, "POST", "/remote-api/sealed", init).await;
        if status != StatusCode::OK {
            return (status, None, body);
        }
        let (session, hello) = hs.finish(&body, rig.now()).unwrap();
        self.session = Some(session);
        (status, Some(hello.state), body)
    }

    fn seal_raw(&self, rig: &Rig, message: &[u8]) -> Vec<u8> {
        self.session.as_ref().unwrap().seal(message, rig.now()).unwrap()
    }

    fn open(&self, rig: &Rig, frame: &[u8], id: &str) -> Answer {
        let message = self.session.as_ref().unwrap().open(frame, rig.now()).unwrap();
        let r = InnerResponse::decode_for(&message, id).unwrap();
        Answer { status: r.status, headers: r.headers, body: r.body }
    }

    /// One inner request; `Ok(answer)` or `Err((outer status, outer code))`.
    async fn call(&self, rig: &Rig, via: Via, method: &str, path: &str, body: &[u8]) -> Result<Answer, (StatusCode, String)> {
        let id = seal::new_request_id().unwrap();
        let request = InnerRequest {
            id: id.clone(),
            method: method.into(),
            path: path.into(),
            headers: vec![("content-type".into(), "application/json".into()), ("x-lu-device".into(), "AAAAAAAAAAAAAAAAAAAAAA".into())],
            body: body.to_vec(),
        };
        let frame = self.seal_raw(rig, &request.encode().unwrap());
        let (status, _, out) = send(rig, via, "POST", "/remote-api/sealed", frame).await;
        if status != StatusCode::OK {
            return Err((status, error_of(&out)));
        }
        Ok(self.open(rig, &out, &id))
    }
}

/// Pairs a phone over the given way and has the desktop allow it.
async fn paired_phone(rig: &Rig, seed: u8, via: Via) -> Phone {
    let mut phone = Phone::new(seed);
    let ticket = rig.ticket();
    let (status, state, _) = phone.connect(rig, via, Some(&ticket)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(state, Some(PairState::Pending));
    // The first frame confirms the session.
    let a = phone.call(rig, via, "GET", PAIR_STATUS_PATH, b"").await.unwrap();
    assert_eq!(a.json()["state"], "pending");
    rig.hub.decide(&rig.last_request_id(), true).unwrap();
    phone
}

// ── Tunnel listener ──

#[tokio::test]
async fn the_tunnel_listener_knows_only_status_and_the_sealed_door() {
    let rig = rig().await;
    for (method, path) in [
        ("GET", "/mobile"),
        ("GET", "/"),
        ("POST", "/remote-api/auth"),
        ("GET", "/remote-api/status/full"),
        ("GET", "/remote-api/qr"),
        ("GET", "/remote-api/config"),
        ("POST", "/remote-api/agent-tool"),
        ("GET", "/api/tags"),
        ("POST", "/api/chat"),
        ("GET", "/comfyui/queue"),
        ("GET", "/ws"),
        ("GET", "/remote-api/sealed"),
        ("POST", "/remote-api/status"),
        ("GET", "/remote-api/pair/status"),
    ] {
        let (status, _, _) = send(&rig, Via::Tunnel("203.0.113.5"), method, path, Vec::new()).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
    }
    let (status, _, body) = send(&rig, Via::Tunnel("203.0.113.5"), "GET", "/remote-api/status", Vec::new()).await;
    assert_eq!(status, StatusCode::OK);
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["protocol"], 2);
    assert!(v["features"].as_array().unwrap().iter().any(|f| f == "sealed"));
    assert!(v.get("desktop_id").is_none() && v.get("x25519").is_none() && v.get("name").is_none());

    // The LAN listener names this desktop only while the QR panel is open.
    let (status, _, body) = send(&rig, Via::Lan("192.168.1.30"), "GET", "/remote-api/status", Vec::new()).await;
    assert_eq!(status, StatusCode::OK);
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(v.get("desktop_id").is_none() && v.get("x25519").is_none() && v.get("name").is_none());
    assert!(v["features"].as_array().unwrap().iter().any(|f| f == "sealed"));
    rig.hub.set_pairing_window(true);
    let (status, _, body) = send(&rig, Via::Lan("192.168.1.30"), "GET", "/remote-api/status", Vec::new()).await;
    assert_eq!(status, StatusCode::OK);
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["desktop_id"], rig.hub.secret.desktop_id());
    assert_eq!(v["x25519"], seal::b64(&rig.hub.secret.x25519_public()));
    assert_eq!(v["name"], "Studio PC");
}

/// #232: a browser under the tunnel address sees a notice, not a blank
/// page. The page sits behind the same gate, the API answers stay empty.
#[tokio::test]
async fn a_browser_on_the_tunnel_gets_the_app_only_notice() {
    let rig = rig().await;
    for path in ["/", "/mobile", "/mobile?x=1", "/anything/else"] {
        let (status, headers, body) = send(&rig, Via::Tunnel("203.0.113.5"), "GET", path, Vec::new()).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        assert!(headers["content-type"].to_str().unwrap().starts_with("text/html"), "{path}");
        let csp = headers["content-security-policy"].to_str().unwrap();
        assert!(csp.contains("default-src 'none'") && csp.contains("frame-ancestors 'none'"), "{csp}");
        assert!(!csp.contains("script-src"), "{csp}");
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert_eq!(headers["cache-control"], "no-store");
        let html = String::from_utf8(body).unwrap();
        assert!(html.contains("works only with the LU app"), "{path}");
        assert!(html.contains("home Wi-Fi"), "{path}");
        let lower = html.to_ascii_lowercase();
        for banned in ["<script", "http://", "https://", "src=", "href=", "studio pc", crate::app_identity::APP_VERSION] {
            assert!(!lower.contains(&banned.to_ascii_lowercase()), "{path}: {banned}");
        }
    }
    // Other methods and the API paths stay empty.
    for (method, path) in [
        ("POST", "/"),
        ("POST", "/mobile"),
        ("PUT", "/"),
        ("DELETE", "/mobile"),
        ("GET", "/remote-api/sealed"),
        ("GET", "/remote-api/qr"),
        ("POST", "/remote-api/status"),
    ] {
        let (status, _, body) = send(&rig, Via::Tunnel("203.0.113.5"), method, path, Vec::new()).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
        assert!(body.is_empty(), "{method} {path} answered with a body");
    }
    // The gate still comes first: a foreign name gets nothing.
    let mut req = Request::builder().method("GET").uri("/").header("host", "evil.example").body(Body::empty()).unwrap();
    req.extensions_mut().insert(ConnectInfo("127.0.0.1:40000".parse::<SocketAddr>().unwrap()));
    let res = rig.routers.tunnel.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert!(axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap().is_empty());
    // The sealed door is still reachable: an empty frame is refused by the
    // channel itself, not by the fallback.
    let (status, headers, _) = send(&rig, Via::Tunnel("203.0.113.5"), "POST", "/remote-api/sealed", Vec::new()).await;
    assert_ne!(status, StatusCode::NOT_FOUND);
    assert!(headers.get("content-security-policy").is_none());
    let (status, _, _) = send(&rig, Via::Tunnel("203.0.113.5"), "GET", "/remote-api/status", Vec::new()).await;
    assert_eq!(status, StatusCode::OK);
}

// ── Pairing ──
// ── Pairing ──

#[tokio::test]
async fn a_pairing_has_no_effect_until_the_desktop_allows_it() {
    let rig = rig().await;
    let mut phone = Phone::new(0x11);
    let ticket = rig.ticket();
    let (status, state, _) = phone.connect(&rig, Via::Tunnel("198.51.100.7"), Some(&ticket)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(state, Some(PairState::Pending));
    // Nothing but the pairing status before the answer.
    let a = phone.call(&rig, Via::Tunnel("198.51.100.7"), "GET", "/api/tags", b"").await.unwrap();
    assert_eq!((a.status, error_of(&a.body).as_str()), (403, "pairing_pending"));
    let a = phone.call(&rig, Via::Tunnel("198.51.100.7"), "GET", PAIR_STATUS_PATH, b"").await.unwrap();
    assert_eq!(a.json()["state"], "pending");
    assert!(rig.hub.devices().is_empty(), "listed before the human said yes");

    let request_id = rig.last_request_id();
    let shown = lock(&rig.events).iter().find(|(e, _)| e == "remote-pair-request").unwrap().1.clone();
    assert_eq!(shown["name"], "Pixel 8");
    assert_eq!(shown["comparisonCode"].as_str(), phone.session.as_ref().unwrap().sas(), "the QR path shows the comparison code");
    assert!(shown["comparisonCode"].as_str().is_some_and(|c| c.len() == 6));
    rig.hub.decide(&request_id, true).unwrap();

    let a = phone.call(&rig, Via::Tunnel("198.51.100.7"), "GET", PAIR_STATUS_PATH, b"").await.unwrap();
    assert_eq!(a.json()["state"], "paired");
    // The same session now reaches the router: the model list of the desktop.
    let a = phone.call(&rig, Via::Tunnel("198.51.100.7"), "GET", "/api/tags", b"").await.unwrap();
    assert_eq!(a.status, 200);
    assert_eq!(a.json()["models"][0]["name"], "fixture-model");
    let devices = rig.hub.devices();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].device_id, phone.device_id());
    assert_eq!(devices[0].rights, DeviceRights::first_pairing());
    // The list on disk has public parts only and survives a reload.
    let file = std::fs::read_to_string(rig._dir.path().join(DEVICES_FILE)).unwrap();
    assert!(file.contains(&phone.device_id()));
    assert!(!file.contains(&*phone.secret.to_b64()));
    assert_eq!(load_book(&rig._dir.path().join(DEVICES_FILE)).devices.len(), 1);
}

#[tokio::test]
async fn a_denied_or_unanswered_pairing_stays_without_effect() {
    let rig = rig().await;
    let mut phone = Phone::new(0x12);
    let ticket = rig.ticket();
    phone.connect(&rig, Via::Lan("192.168.1.31"), Some(&ticket)).await;
    phone.call(&rig, Via::Lan("192.168.1.31"), "GET", PAIR_STATUS_PATH, b"").await.unwrap();
    rig.hub.decide(&rig.last_request_id(), false).unwrap();
    let a = phone.call(&rig, Via::Lan("192.168.1.31"), "GET", PAIR_STATUS_PATH, b"").await.unwrap();
    assert_eq!(a.json()["state"], "denied");
    let a = phone.call(&rig, Via::Lan("192.168.1.31"), "GET", "/api/tags", b"").await.unwrap();
    assert_eq!(error_of(&a.body), "pairing_denied");
    assert!(rig.hub.devices().is_empty());
    let (status, _, body) = phone.connect(&rig, Via::Lan("192.168.1.31"), None).await;
    assert_eq!((status, error_of(&body).as_str()), (StatusCode::UNAUTHORIZED, "unknown_device"));

    // No answer within two minutes counts as no.
    let mut other = Phone::new(0x13);
    let ticket = rig.ticket();
    other.connect(&rig, Via::Lan("192.168.1.32"), Some(&ticket)).await;
    other.call(&rig, Via::Lan("192.168.1.32"), "GET", PAIR_STATUS_PATH, b"").await.unwrap();
    let request_id = rig.last_request_id();
    rig.advance(PAIR_DECISION_SECS + 1);
    let a = other.call(&rig, Via::Lan("192.168.1.32"), "GET", PAIR_STATUS_PATH, b"").await.unwrap();
    assert_eq!(a.json()["state"], "denied");
    assert!(rig.hub.decide(&request_id, true).is_err(), "a late yes must not pair");
    assert!(rig.hub.devices().is_empty());
}

#[tokio::test]
async fn a_ticket_works_once_and_for_five_minutes() {
    let rig = rig().await;
    let ticket = rig.ticket();
    let mut a = Phone::new(0x14);
    assert_eq!(a.connect(&rig, Via::Lan("192.168.1.33"), Some(&ticket)).await.0, StatusCode::OK);
    let mut b = Phone::new(0x15);
    let (status, _, body) = b.connect(&rig, Via::Lan("192.168.1.34"), Some(&ticket)).await;
    assert_eq!((status, error_of(&body).as_str()), (StatusCode::UNAUTHORIZED, "unknown_ticket"));

    let late = rig.ticket();
    rig.advance(seal::TICKET_TTL_SECS + 1);
    let (status, _, body) = b.connect(&rig, Via::Lan("192.168.1.34"), Some(&late)).await;
    assert_eq!((status, error_of(&body).as_str()), (StatusCode::UNAUTHORIZED, "unknown_ticket"));
}

// ── Lockout ──

#[tokio::test]
async fn a_stranger_with_wrong_handshakes_does_not_lock_the_owner_out() {
    let rig = rig().await;
    let mut owner = paired_phone(&rig, 0x16, Via::Tunnel("198.51.100.20")).await;
    // A stranger at another address with made up tickets.
    let stranger = Phone::new(0x17);
    for _ in 0..PAIR_FAILS_PER_SOURCE {
        let fake = PairingSecret::Ticket(Ticket::from_bytes([0x99; 16]));
        let (_, init) = stranger.init(&rig, Some(&fake));
        let (status, _, _) = send(&rig, Via::Tunnel("203.0.113.66"), "POST", "/remote-api/sealed", init).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    let fake = PairingSecret::Ticket(Ticket::from_bytes([0x99; 16]));
    let (_, init) = stranger.init(&rig, Some(&fake));
    let (status, headers, body) = send(&rig, Via::Tunnel("203.0.113.66"), "POST", "/remote-api/sealed", init).await;
    assert_eq!((status, error_of(&body).as_str()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    assert!(headers.get("retry-after").is_some());
    // Flooding with known-device frames from many addresses does not touch
    // the owner either.
    for i in 0..(GLOBAL_FAILS_PER_WINDOW + 5) {
        let (_, init) = stranger.init(&rig, None);
        let ip: &'static str = Box::leak(format!("203.0.113.{}", i % 200).into_boxed_str());
        send(&rig, Via::Tunnel(ip), "POST", "/remote-api/sealed", init).await;
    }
    // The owner's running session and a fresh handshake both still work.
    let a = owner.call(&rig, Via::Tunnel("198.51.100.20"), "GET", "/api/tags", b"").await.unwrap();
    assert_eq!(a.status, 200);
    let (status, state, _) = owner.connect(&rig, Via::Tunnel("198.51.100.20"), None).await;
    assert_eq!((status, state), (StatusCode::OK, Some(PairState::Paired)));
    let a = owner.call(&rig, Via::Tunnel("198.51.100.20"), "GET", "/api/tags", b"").await.unwrap();
    assert_eq!(a.status, 200);
}

#[tokio::test]
async fn the_lan_listener_limits_handshakes_and_keeps_its_code_lockout() {
    let rig = rig().await;
    // Many handshakes from one LAN sender: the same limit as on the tunnel.
    for _ in 0..HANDSHAKES_PER_SOURCE {
        let mut p = Phone::new(0x18);
        let t = rig.ticket();
        assert_eq!(p.connect(&rig, Via::Lan("192.168.1.40"), Some(&t)).await.0, StatusCode::OK);
    }
    let mut p = Phone::new(0x18);
    let t = rig.ticket();
    let (s, _, b) = p.connect(&rig, Via::Lan("192.168.1.40"), Some(&t)).await;
    assert_eq!((s, error_of(&b).as_str()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    // A locked out sender (the code login's map) is refused on the code path.
    {
        let mut pc = rig.routers.passcode.lock().await;
        pc.code = "123456".into();
        pc.expires_at = now_secs() + 900;
        pc.failed_attempts.insert("192.168.1.41".into(), (3, now_secs() + 60));
    }
    let phone = Phone::new(0x19);
    let code = PairingSecret::code("123456").unwrap();
    let (_, init) = phone.init(&rig, Some(&code));
    let (status, _, body) = send(&rig, Via::Lan("192.168.1.41"), "POST", "/remote-api/sealed", init).await;
    assert_eq!((status, error_of(&body).as_str()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
}

// ── Code pairing (LAN only) ──

#[tokio::test]
async fn code_pairing_asks_with_the_comparison_code_after_the_reveal_and_uses_the_code_up() {
    let rig = rig().await;
    {
        let mut pc = rig.routers.passcode.lock().await;
        pc.code = "482913".into();
        pc.expires_at = now_secs() + 900;
    }
    // Never over the tunnel.
    let mut phone = Phone::new(0x1a);
    let code = PairingSecret::code("482913").unwrap();
    let (status, _, body) = phone.connect(&rig, Via::Tunnel("198.51.100.30"), Some(&code)).await;
    assert_eq!((status, error_of(&body).as_str()), (StatusCode::UNAUTHORIZED, "unknown_ticket"));

    // A wrong code fails and counts.
    let wrong = PairingSecret::code("000001").unwrap();
    let (status, _, body) = phone.connect(&rig, Via::Lan("192.168.1.50"), Some(&wrong)).await;
    assert_eq!((status, error_of(&body).as_str()), (StatusCode::UNAUTHORIZED, "handshake_failed"));
    assert_eq!(rig.routers.passcode.lock().await.failed_attempts.get("192.168.1.50").map(|e| e.0), Some(1));

    let (status, state, _) = phone.connect(&rig, Via::Lan("192.168.1.50"), Some(&code)).await;
    assert_eq!((status, state), (StatusCode::OK, Some(PairState::Pending)));
    // The code is used up: a new one is shown.
    assert_ne!(rig.routers.passcode.lock().await.code, "482913");
    // No question before the reveal.
    assert!(lock(&rig.events).iter().all(|(e, _)| e != "remote-pair-request"));
    let reveal = phone.session.as_ref().unwrap().sas_reveal().unwrap();
    let a = phone
        .call(&rig, Via::Lan("192.168.1.50"), "POST", PAIR_REVEAL_PATH, &serde_json::to_vec(&serde_json::json!({ "n": reveal })).unwrap())
        .await
        .unwrap();
    assert_eq!(a.status, 200);
    let shown = lock(&rig.events).iter().find(|(e, _)| e == "remote-pair-request").unwrap().1.clone();
    assert_eq!(shown["comparisonCode"].as_str(), phone.session.as_ref().unwrap().sas());
    rig.hub.decide(&rig.last_request_id(), true).unwrap();
    let a = phone.call(&rig, Via::Lan("192.168.1.50"), "GET", PAIR_STATUS_PATH, b"").await.unwrap();
    assert_eq!(a.json()["state"], "paired");
}

#[tokio::test]
async fn a_wrong_reveal_voids_the_code_pairing() {
    let rig = rig().await;
    {
        let mut pc = rig.routers.passcode.lock().await;
        pc.code = "111222".into();
        pc.expires_at = now_secs() + 900;
    }
    let mut phone = Phone::new(0x1b);
    let code = PairingSecret::code("111222").unwrap();
    assert_eq!(phone.connect(&rig, Via::Lan("192.168.1.51"), Some(&code)).await.0, StatusCode::OK);
    let a = phone
        .call(&rig, Via::Lan("192.168.1.51"), "POST", PAIR_REVEAL_PATH, br#"{"n":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}"#)
        .await
        .unwrap();
    assert_eq!((a.status, error_of(&a.body).as_str()), (400, "bad_reveal"));
    let a = phone.call(&rig, Via::Lan("192.168.1.51"), "GET", PAIR_STATUS_PATH, b"").await.unwrap();
    assert_eq!(a.json()["state"], "denied");
    assert!(lock(&rig.events).iter().all(|(e, _)| e != "remote-pair-request"));
}

#[tokio::test]
async fn ten_failed_code_handshakes_from_anywhere_end_the_code() {
    let rig = rig().await;
    {
        let mut pc = rig.routers.passcode.lock().await;
        pc.code = "777888".into();
        pc.expires_at = now_secs() + 900;
    }
    let phone = Phone::new(0x1c);
    for i in 0..10 {
        let wrong = PairingSecret::code(&format!("{:06}", 100 + i)).unwrap();
        let (_, init) = phone.init(&rig, Some(&wrong));
        let ip: &'static str = Box::leak(format!("192.168.2.{i}").into_boxed_str());
        let (status, _, _) = send(&rig, Via::Lan(ip), "POST", "/remote-api/sealed", init).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    assert_ne!(rig.routers.passcode.lock().await.code, "777888", "the code outlived ten failures");
    let mut late = Phone::new(0x1d);
    let right = PairingSecret::code("777888").unwrap();
    let (status, _, _) = late.connect(&rig, Via::Lan("192.168.3.1"), Some(&right)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ── Unpairing, rights, paths ──

#[tokio::test]
async fn an_unpaired_device_fails_at_its_next_frame() {
    let rig = rig().await;
    let mut phone = paired_phone(&rig, 0x1e, Via::Tunnel("198.51.100.40")).await;
    assert_eq!(phone.call(&rig, Via::Tunnel("198.51.100.40"), "GET", "/api/tags", b"").await.unwrap().status, 200);
    assert!(rig.hub.forget(&phone.device_id()).unwrap());
    let err = phone.call(&rig, Via::Tunnel("198.51.100.40"), "GET", "/api/tags", b"").await.err().unwrap();
    assert_eq!(err, (StatusCode::NOT_FOUND, "session_unknown".to_string()));
    let (status, _, body) = phone.connect(&rig, Via::Tunnel("198.51.100.40"), None).await;
    assert_eq!((status, error_of(&body).as_str()), (StatusCode::UNAUTHORIZED, "unknown_device"));
}

#[tokio::test]
async fn an_inner_request_without_the_right_stays_blocked() {
    let rig = rig().await;
    let phone = paired_phone(&rig, 0x1f, Via::Lan("192.168.1.60")).await;
    let tool = |name: &str| serde_json::to_vec(&serde_json::json!({ "tool": name, "args": { "path": "a.txt", "command": "echo hi" } })).unwrap();
    // New devices have chat and agent, not files or terminal.
    for (name, right) in [("file_read", "files"), ("shell_execute", "terminal"), ("process_list", "terminal")] {
        let a = phone.call(&rig, Via::Lan("192.168.1.60"), "POST", "/remote-api/agent-tool", &tool(name)).await.unwrap();
        assert_eq!(a.status, 403, "{name}");
        assert_eq!(a.json(), serde_json::json!({ "error": "forbidden", "right": right }));
    }
    // The device right alone is not enough: the global switch still says no.
    rig.hub.set_rights(&phone.device_id(), DeviceRights { files: true, ..DeviceRights::first_pairing() }).unwrap();
    let a = phone.call(&rig, Via::Lan("192.168.1.60"), "POST", "/remote-api/agent-tool", &tool("file_read")).await.unwrap();
    assert_eq!(a.status, 200);
    assert_eq!(a.json()["needs_permission"], true);
    assert_eq!(a.json()["permission"], "filesystem");
    // What the phone reads back is the intersection.
    rig.routers.permissions.lock().await.filesystem = true;
    rig.routers.permissions.lock().await.shell = true;
    let a = phone.call(&rig, Via::Lan("192.168.1.60"), "GET", "/remote-api/permissions", b"").await.unwrap();
    assert_eq!(a.json()["filesystem"], true);
    assert_eq!(a.json()["shell"], false);
    // Writing permissions through the channel changes nothing.
    let a = phone
        .call(&rig, Via::Lan("192.168.1.60"), "POST", "/remote-api/permissions", br#"{"filesystem":true,"downloads":true,"process_control":true,"shell":true}"#)
        .await
        .unwrap();
    assert_eq!(a.json()["shell"], false);
    assert!(!rig.routers.permissions.lock().await.downloads);
    // Without chat no model list, without agent no tools, without create no Create.
    rig.hub.set_rights(&phone.device_id(), DeviceRights::default()).unwrap();
    for (method, path, right) in [("GET", "/api/tags", "chat"), ("GET", "/remote-api/config", "chat"), ("POST", "/remote-api/agent-tool", "agent"), ("GET", "/remote-api/create/jobs", "create")] {
        let a = phone.call(&rig, Via::Lan("192.168.1.60"), method, path, &tool("web_search")).await.unwrap();
        assert_eq!(a.json(), serde_json::json!({ "error": "forbidden", "right": right }), "{path}");
    }
}

#[tokio::test]
async fn nested_sealed_or_auth_requests_are_refused() {
    let rig = rig().await;
    let phone = paired_phone(&rig, 0x20, Via::Lan("192.168.1.61")).await;
    for path in ["/remote-api/sealed", "/remote-api/auth", "/Remote-Api/Auth/", "/remote-api/%61uth", "/remote-api/sealed?x=1"] {
        // Built by hand: the phone's own encoder refuses these paths.
        let id = seal::new_request_id().unwrap();
        let head = serde_json::to_vec(&serde_json::json!({ "v": 1, "id": id, "m": "POST", "p": path, "h": [] })).unwrap();
        let mut message = (head.len() as u32).to_be_bytes().to_vec();
        message.extend_from_slice(&head);
        message.extend_from_slice(br#"{"passcode":"123456"}"#);
        let frame = phone.seal_raw(&rig, &message);
        let (status, _, body) = send(&rig, Via::Lan("192.168.1.61"), "POST", "/remote-api/sealed", frame).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        let a = phone.open(&rig, &body, &id);
        assert_eq!((a.status, error_of(&a.body).as_str()), (400, "forbidden_path"), "{path}");
    }
}

#[tokio::test]
async fn a_replayed_frame_is_refused_and_not_run_twice() {
    let rig = rig().await;
    let phone = paired_phone(&rig, 0x21, Via::Tunnel("198.51.100.50")).await;
    let id = seal::new_request_id().unwrap();
    let request = InnerRequest { id: id.clone(), method: "GET".into(), path: "/api/tags".into(), headers: vec![], body: vec![] };
    let frame = phone.seal_raw(&rig, &request.encode().unwrap());
    let (status, _, _) = send(&rig, Via::Tunnel("198.51.100.50"), "POST", "/remote-api/sealed", frame.clone()).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, body) = send(&rig, Via::Tunnel("198.51.100.50"), "POST", "/remote-api/sealed", frame).await;
    assert_eq!((status, error_of(&body).as_str()), (StatusCode::CONFLICT, "replay"));
}

#[tokio::test]
async fn a_header_named_x_lu_device_from_the_network_opens_nothing() {
    let rig = rig().await;
    let phone = paired_phone(&rig, 0x22, Via::Lan("192.168.1.62")).await;
    // With the old way in allowed, so the request reaches the JWT check.
    rig.hub.set_legacy_access(true);
    let mut req = Request::builder().method("GET").uri("/api/tags").header("x-lu-device", phone.device_id()).body(Body::empty()).unwrap();
    req.extensions_mut().insert(ConnectInfo("192.168.1.62:4000".parse::<SocketAddr>().unwrap()));
    let res = rig.routers.lan.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

// ── Deferred answers ──

#[tokio::test]
async fn a_long_inner_request_is_deferred_and_fetched_by_token() {
    let rig = rig_with(Duration::from_millis(100), Duration::from_millis(100)).await;
    let phone = paired_phone(&rig, 0x23, Via::Tunnel("198.51.100.60")).await;
    let a = phone.call(&rig, Via::Tunnel("198.51.100.60"), "GET", "/api/slow", b"").await.unwrap();
    assert_eq!(a.status, 202);
    assert!(a.body.is_empty());
    let token = a.header("x-lu-pending").unwrap().to_string();
    let poll = format!("{}{}", seal::PENDING_PATH_PREFIX, token);
    // Another phone cannot fetch it.
    let other = paired_phone(&rig, 0x24, Via::Tunnel("198.51.100.61")).await;
    let b = other.call(&rig, Via::Tunnel("198.51.100.61"), "GET", &poll, b"").await.unwrap();
    assert_eq!(b.status, 404);
    let mut done = None;
    for _ in 0..30 {
        let p = phone.call(&rig, Via::Tunnel("198.51.100.60"), "GET", &poll, b"").await.unwrap();
        if p.status == 202 {
            assert_eq!(p.header("x-lu-pending"), Some(token.as_str()));
            continue;
        }
        done = Some(p);
        break;
    }
    let done = done.expect("the deferred answer arrived");
    assert_eq!(done.status, 200);
    assert_eq!(done.json()["slow"], "done");

    // Cancel: DELETE ends it, the token is gone.
    let a = phone.call(&rig, Via::Tunnel("198.51.100.60"), "GET", "/api/slow", b"").await.unwrap();
    let token = a.header("x-lu-pending").unwrap().to_string();
    let poll = format!("{}{}", seal::PENDING_PATH_PREFIX, token);
    assert_eq!(phone.call(&rig, Via::Tunnel("198.51.100.60"), "DELETE", &poll, b"").await.unwrap().status, 204);
    assert_eq!(phone.call(&rig, Via::Tunnel("198.51.100.60"), "GET", &poll, b"").await.unwrap().status, 404);
}

// ── Session table ──

#[tokio::test]
async fn idle_sessions_end_after_two_hours() {
    let rig = rig().await;
    let phone = paired_phone(&rig, 0x25, Via::Lan("192.168.1.63")).await;
    rig.advance(IDLE_SECS + 1);
    let err = phone.call(&rig, Via::Lan("192.168.1.63"), "GET", "/api/tags", b"").await.err().unwrap();
    assert_eq!(err.1, "session_unknown");
}

#[tokio::test]
async fn at_most_four_sessions_per_device_the_oldest_falls() {
    let rig = rig().await;
    let first = paired_phone(&rig, 0x26, Via::Lan("192.168.1.64")).await;
    let mut later = Vec::new();
    for _ in 0..MAX_SESSIONS_PER_DEVICE {
        rig.advance(1);
        let mut p = Phone { secret: DeviceSecret::from_bytes([0x26; 32]), session: None };
        assert_eq!(p.connect(&rig, Via::Lan("192.168.1.64"), None).await.0, StatusCode::OK);
        assert_eq!(p.call(&rig, Via::Lan("192.168.1.64"), "GET", PAIR_STATUS_PATH, b"").await.unwrap().status, 200);
        later.push(p);
    }
    let err = first.call(&rig, Via::Lan("192.168.1.64"), "GET", PAIR_STATUS_PATH, b"").await.err().unwrap();
    assert_eq!(err.1, "session_unknown");
    for p in &later {
        assert_eq!(p.call(&rig, Via::Lan("192.168.1.64"), "GET", PAIR_STATUS_PATH, b"").await.unwrap().status, 200);
    }
}

#[tokio::test]
async fn replayed_handshakes_do_not_push_real_sessions_out() {
    let rig = rig().await;
    let phone = paired_phone(&rig, 0x27, Via::Tunnel("198.51.100.70")).await;
    // Somebody at the tunnel edge kept an IK init of this phone and sends it
    // again and again. Each gets an answer, none may cost the phone its session.
    let (_, recorded) = phone.init(&rig, None);
    for i in 0..(MAX_SESSIONS_PER_DEVICE * 3) {
        let ip: &'static str = Box::leak(format!("203.0.113.{}", 100 + i).into_boxed_str());
        let (status, _, body) = send(&rig, Via::Tunnel(ip), "POST", "/remote-api/sealed", recorded.clone()).await;
        // The first copy is read, every further one is a replay.
        if i == 0 {
            assert_eq!(status, StatusCode::OK);
        } else {
            assert_eq!((status, error_of(&body).as_str()), (StatusCode::CONFLICT, "replay"));
        }
    }
    assert_eq!(phone.call(&rig, Via::Tunnel("198.51.100.70"), "GET", "/api/tags", b"").await.unwrap().status, 200);
    // And they fall after a minute without a frame.
    rig.advance(UNCONFIRMED_SECS + 1);
    rig.hub.prune(rig.now());
    assert_eq!(lock(&rig.hub.sessions).len(), 1);
}

// ── Storage ──

#[test]
fn the_key_file_is_private_and_read_back_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let store = KeyStore::File(dir.path().join("k.key"));
    let a = store.load_or_create().unwrap();
    let b = store.load_or_create().unwrap();
    assert_eq!(a.desktop_id(), b.desktop_id());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.path().join("k.key")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    // An unreadable stored key is an error, never silently replaced.
    std::fs::write(dir.path().join("k.key"), "not a key").unwrap();
    assert!(store.load_or_create().is_err());
    assert_eq!(std::fs::read_to_string(dir.path().join("k.key")).unwrap(), "not a key");
}

#[test]
fn rights_map_to_the_global_switches() {
    assert_eq!(right_of_permission("filesystem"), "files");
    assert_eq!(right_of_permission("downloads"), "files");
    assert_eq!(right_of_permission("shell"), "terminal");
    assert_eq!(right_of_permission("process_control"), "terminal");
    assert_eq!(right_of_permission("create"), "create");
    assert_eq!(right_of_permission("anything else"), "terminal");
    let r = DeviceRights::first_pairing();
    assert!(r.chat && r.agent && !r.files && !r.terminal && !r.create);
    // An older file without some field reads as "off".
    let parsed: DeviceRights = serde_json::from_str(r#"{"chat":true}"#).unwrap();
    assert_eq!(parsed, DeviceRights { chat: true, ..DeviceRights::default() });
}

// ── Create through the channel ──
//
// The phone talks to the real Create routes of commands/remote_create.rs
// through the sealed door; a FakeHost stands in for the window.

use crate::commands::remote_create::{tests::FakeHost, OutputRef};

struct CreateRig {
    rig: Rig,
    host: Arc<FakeHost>,
    out: tempfile::TempDir,
    _uploads: tempfile::TempDir,
}

async fn create_rig_with(hold: Duration, poll_hold: Duration) -> CreateRig {
    let rig = rig_with(hold, poll_hold).await;
    let out = tempfile::tempdir().unwrap();
    let uploads = tempfile::tempdir().unwrap();
    let host = Arc::new(FakeHost { roots: vec![out.path().to_path_buf()], uploads: uploads.path().to_path_buf(), ..Default::default() });
    rig.routers.create.set_host(host.clone());
    rig.routers.permissions.lock().await.create = true;
    CreateRig { rig, host, out, _uploads: uploads }
}

impl CreateRig {
    fn allow_create(&self, phone: &Phone) {
        self.rig.hub.set_rights(&phone.device_id(), DeviceRights { create: true, ..DeviceRights::first_pairing() }).unwrap();
    }

    /// The window finishes the job with a fake clip of `size` bytes.
    fn finish_with_clip(&self, job: &str, name: &str, size: usize) -> Vec<u8> {
        let mut data = vec![0, 0, 0, 0x18, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm'];
        data.extend((0..size.saturating_sub(12)).map(|i| (i * 31 % 251) as u8));
        let file = self.out.path().join(name);
        std::fs::write(&file, &data).unwrap();
        let out = OutputRef { path: Some(file.to_string_lossy().into()), ..Default::default() };
        self.rig.routers.create.finish(job, true, None, vec![out], crate::commands::remote_create::now_secs()).unwrap();
        data
    }

    fn runs(&self) -> Vec<String> {
        lock(&self.host.events)
            .iter()
            .filter(|e| e["action"] == "run")
            .map(|e| e["job"]["id"].as_str().unwrap().to_string())
            .collect()
    }

    fn cancels(&self) -> Vec<String> {
        lock(&self.host.events)
            .iter()
            .filter(|e| e["action"] == "cancel")
            .map(|e| e["id"].as_str().unwrap().to_string())
            .collect()
    }
}

fn job_body(kind: &str, prompt: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "kind": kind, "prompt": prompt })).unwrap()
}

#[tokio::test]
async fn create_runs_end_to_end_through_the_sealed_channel() {
    use sha2::{Digest, Sha256};
    let c = create_rig_with(Duration::from_secs(5), Duration::from_secs(5)).await;
    let via = Via::Tunnel("198.51.100.80");
    let phone = paired_phone(&c.rig, 0x31, via).await;

    // Without its own right the status names no Create, with it it does.
    let status = phone.call(&c.rig, via, "GET", "/remote-api/status/full", b"").await.unwrap();
    assert_eq!(status.json()["features"], serde_json::json!(["sealed", "pending", "signin", "voice"]));
    c.allow_create(&phone);
    let status = phone.call(&c.rig, via, "GET", "/remote-api/status/full", b"").await.unwrap();
    assert_eq!(status.json()["features"], serde_json::json!(["sealed", "pending", "signin", "create-image", "create-video", "voice"]));
    // The unauthenticated tunnel status stays without Create.
    let (_, _, body) = send(&c.rig, via, "GET", "/remote-api/status", Vec::new()).await;
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["features"], serde_json::json!(["sealed", "pending"]));

    // Capabilities over the channel name an upload size that fits a message.
    c.rig.routers.create.capabilities_reply("none", serde_json::json!({ "kinds": { "video": { "models": [{ "id": "wan" }] } } }));
    let caps = phone.call(&c.rig, via, "GET", "/remote-api/create/capabilities", b"").await.unwrap();
    assert_eq!(caps.status, 200);
    assert_eq!(caps.json()["limits"]["max_upload_bytes"], crate::commands::remote_create::MAX_SEALED_UPLOAD_BYTES);
    // Stage 2 (CREATE-V2.md): once the window answered, the gallery word;
    // a kind's word only where the engine can (here none).
    let status = phone.call(&c.rig, via, "GET", "/remote-api/status/full", b"").await.unwrap();
    assert_eq!(status.json()["features"], serde_json::json!(["sealed", "pending", "signin", "create-image", "create-video", "create-gallery", "voice"]));
    let unavailable = phone.call(&c.rig, via, "POST", "/remote-api/create/jobs", &job_body("music", "lofi")).await.unwrap();
    assert_eq!(unavailable.status, 409, "{:?}", unavailable.json());

    // The job: accepted at once with an id, handed to the window.
    let a = phone.call(&c.rig, via, "POST", "/remote-api/create/jobs", &job_body("video", "a cat on a boat")).await.unwrap();
    assert_eq!(a.status, 202, "{:?}", a.json());
    let job = a.json()["id"].as_str().unwrap().to_string();
    assert_eq!(c.runs(), vec![job.clone()]);
    let poll = format!("/remote-api/create/jobs/{job}");
    let s = phone.call(&c.rig, via, "GET", &poll, b"").await.unwrap();
    assert_eq!(s.json()["state"], "running");
    assert!(c.rig.routers.create.progress(&job, Some(0.5), Some("Sampling 12/30".into()), None, crate::commands::remote_create::now_secs()));
    let s = phone.call(&c.rig, via, "GET", &poll, b"").await.unwrap();
    assert_eq!(s.json()["progress"], 0.5);
    assert_eq!(s.json()["step_text"], "Sampling 12/30");

    // Done: a result bigger than one piece, fetched in pieces of 4 MiB.
    let data = c.finish_with_clip(&job, "clip.mp4", 5 * 1024 * 1024 + 321);
    let s = phone.call(&c.rig, via, "GET", &poll, b"").await.unwrap();
    assert_eq!(s.json()["state"], "done");
    let result = s.json()["results"][0].clone();
    let rid = result["id"].as_str().unwrap().to_string();
    let total = result["bytes"].as_u64().unwrap();
    assert_eq!(total, data.len() as u64);
    let mut joined = Vec::new();
    let mut pieces = 0;
    while (joined.len() as u64) < total {
        let path = format!("/remote-api/create/results/{rid}?offset={}&length={}", joined.len(), 4 * 1024 * 1024);
        let piece = phone.call(&c.rig, via, "GET", &path, b"").await.unwrap();
        assert_eq!(piece.status, 200);
        assert_eq!(piece.header("content-type"), Some("video/mp4"));
        assert_eq!(piece.header("x-lu-total-bytes"), Some(total.to_string().as_str()));
        assert!(!piece.body.is_empty() && piece.body.len() <= 4 * 1024 * 1024);
        joined.extend_from_slice(&piece.body);
        pieces += 1;
    }
    assert_eq!(pieces, 2);
    let sha: String = Sha256::digest(&joined).iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(sha, result["sha256"].as_str().unwrap());
    assert_eq!(joined, data);
}

#[tokio::test]
async fn a_device_without_create_gets_403_and_one_device_never_sees_another() {
    let c = create_rig_with(Duration::from_secs(5), Duration::from_secs(5)).await;
    let via_a = Via::Lan("192.168.1.81");
    let via_b = Via::Tunnel("198.51.100.82");
    let a = paired_phone(&c.rig, 0x32, via_a).await;
    let b = paired_phone(&c.rig, 0x33, via_b).await;

    // The global switch is on, the device right is not: the channel's 403.
    let forbidden = serde_json::json!({ "error": "forbidden", "right": "create" });
    for (method, path) in [
        ("GET", "/remote-api/create/capabilities"),
        ("POST", "/remote-api/create/jobs"),
        ("GET", "/remote-api/create/results/res_00000000000000000000000000000000"),
    ] {
        let r = a.call(&c.rig, via_a, method, path, &job_body("image", "x")).await.unwrap();
        assert_eq!((r.status, r.json()), (403, forbidden.clone()), "{method} {path}");
    }
    let tool = serde_json::to_vec(&serde_json::json!({ "tool": "image_generate", "args": { "prompt": "x" } })).unwrap();
    let r = a.call(&c.rig, via_a, "POST", "/remote-api/agent-tool", &tool).await.unwrap();
    assert_eq!((r.status, r.json()), (403, forbidden.clone()));
    assert!(c.runs().is_empty(), "nothing reached the window");

    // The device right alone is not enough either: the global switch says no.
    c.allow_create(&a);
    c.allow_create(&b);
    c.rig.routers.permissions.lock().await.create = false;
    let r = a.call(&c.rig, via_a, "POST", "/remote-api/create/jobs", &job_body("image", "x")).await.unwrap();
    assert_eq!(r.status, 403);
    assert_eq!(r.json()["permission"], "create");
    c.rig.routers.permissions.lock().await.create = true;

    // A's job and result are A's alone.
    let r = a.call(&c.rig, via_a, "POST", "/remote-api/create/jobs", &job_body("video", "a's clip")).await.unwrap();
    assert_eq!(r.status, 202);
    let job = r.json()["id"].as_str().unwrap().to_string();
    c.finish_with_clip(&job, "a.mp4", 4096);
    let mine = a.call(&c.rig, via_a, "GET", &format!("/remote-api/create/jobs/{job}"), b"").await.unwrap();
    let rid = mine.json()["results"][0]["id"].as_str().unwrap().to_string();
    for path in [
        format!("/remote-api/create/jobs/{job}"),
        format!("/remote-api/create/results/{rid}"),
    ] {
        let r = b.call(&c.rig, via_b, "GET", &path, b"").await.unwrap();
        assert_eq!(r.status, 404, "{path}");
    }
    let r = b.call(&c.rig, via_b, "POST", &format!("/remote-api/create/jobs/{job}/cancel"), b"").await.unwrap();
    assert_eq!(r.status, 404);
    // An upload of A cannot be used by B.
    let png: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
        0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xCF,
        0xC0, 0xF0, 0x1F, 0x00, 0x05, 0x00, 0x01, 0xFF, 0x89, 0x99, 0x3D, 0x1D, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60,
        0x82,
    ];
    let up = a.call(&c.rig, via_a, "POST", "/remote-api/create/uploads", png).await.unwrap();
    assert_eq!(up.status, 201, "{:?}", up.json());
    let upl = up.json()["id"].as_str().unwrap().to_string();
    let i2v = serde_json::to_vec(&serde_json::json!({ "kind": "image-to-video", "prompt": "move", "input_id": upl })).unwrap();
    let r = b.call(&c.rig, via_b, "POST", "/remote-api/create/jobs", &i2v).await.unwrap();
    assert_eq!(r.status, 400, "{:?}", r.json());
}

#[tokio::test]
async fn a_long_agent_generation_is_deferred_and_answered_through_pending() {
    let c = create_rig_with(Duration::from_millis(200), Duration::from_secs(5)).await;
    let via = Via::Tunnel("198.51.100.84");
    let phone = paired_phone(&c.rig, 0x34, via).await;
    c.allow_create(&phone);
    let tool = serde_json::to_vec(&serde_json::json!({ "tool": "video_generate", "args": { "prompt": "waves" } })).unwrap();
    let r = phone.call(&c.rig, via, "POST", "/remote-api/agent-tool", &tool).await.unwrap();
    assert_eq!(r.status, 202, "the agent call holds no request past the hold");
    let token = r.header("x-lu-pending").unwrap().to_string();
    let job = c.runs().first().cloned().expect("the job reached the window");
    c.finish_with_clip(&job, "waves.mp4", 2048);
    let poll = format!("{}{}", seal::PENDING_PATH_PREFIX, token);
    let mut done = None;
    for _ in 0..10 {
        let p = phone.call(&c.rig, via, "GET", &poll, b"").await.unwrap();
        if p.status != 202 {
            done = Some(p);
            break;
        }
    }
    let done = done.expect("the deferred answer arrived");
    assert_eq!(done.status, 200);
    assert_eq!(done.json()["job_id"], job.as_str());
    assert_eq!(done.json()["results"].as_array().unwrap().len(), 1);

    // Giving the deferred call up ends its job.
    let r = phone.call(&c.rig, via, "POST", "/remote-api/agent-tool", &tool).await.unwrap();
    assert_eq!(r.status, 202);
    let token = r.header("x-lu-pending").unwrap().to_string();
    let second = c.runs().last().cloned().unwrap();
    assert_ne!(second, job);
    let poll = format!("{}{}", seal::PENDING_PATH_PREFIX, token);
    assert_eq!(phone.call(&c.rig, via, "DELETE", &poll, b"").await.unwrap().status, 204);
    tokio::task::yield_now().await;
    let mut cancelled = false;
    for _ in 0..50 {
        if c.cancels().contains(&second) {
            cancelled = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(cancelled, "the window was told to stop");
    assert_eq!(c.rig.routers.create.view(None, &second).unwrap()["state"], "cancelled");
}

#[tokio::test]
async fn unpairing_a_device_ends_its_jobs_and_closes_its_results() {
    let c = create_rig_with(Duration::from_secs(5), Duration::from_secs(5)).await;
    let via_a = Via::Tunnel("198.51.100.86");
    let via_b = Via::Lan("192.168.1.87");
    let a = paired_phone(&c.rig, 0x35, via_a).await;
    let b = paired_phone(&c.rig, 0x36, via_b).await;
    c.allow_create(&a);
    c.allow_create(&b);
    // A: a finished job, a running one, a waiting one. B: one waiting.
    let done = a.call(&c.rig, via_a, "POST", "/remote-api/create/jobs", &job_body("video", "first")).await.unwrap().json()["id"].as_str().unwrap().to_string();
    c.finish_with_clip(&done, "first.mp4", 1024);
    let rid = c.rig.routers.create.view(None, &done).unwrap()["results"][0]["id"].as_str().unwrap().to_string();
    let running = a.call(&c.rig, via_a, "POST", "/remote-api/create/jobs", &job_body("video", "second")).await.unwrap().json()["id"].as_str().unwrap().to_string();
    let waiting = a.call(&c.rig, via_a, "POST", "/remote-api/create/jobs", &job_body("video", "third")).await.unwrap().json()["id"].as_str().unwrap().to_string();
    let other = b.call(&c.rig, via_b, "POST", "/remote-api/create/jobs", &job_body("video", "b's")).await.unwrap().json()["id"].as_str().unwrap().to_string();
    assert_eq!(c.rig.routers.create.view(None, &running).unwrap()["state"], "running");

    assert!(c.rig.hub.forget(&a.device_id()).unwrap());
    // The running job was stopped in the window and the engine.
    assert!(c.cancels().contains(&running));
    assert!(!lock(&c.host.aborts).is_empty());
    // Nothing of A is left to reach by id, not even the finished result.
    for id in [&done, &running, &waiting] {
        assert!(c.rig.routers.create.view(None, id).is_none(), "{id}");
    }
    assert!(c.rig.routers.create.result_file(None, &rid).is_none());
    // B's job moved up and runs.
    assert_eq!(c.rig.routers.create.view(None, &other).unwrap()["state"], "running");
    assert_eq!(b.call(&c.rig, via_b, "GET", &format!("/remote-api/create/jobs/{other}"), b"").await.unwrap().status, 200);

    // Taking the right away has the same effect.
    c.rig.hub.set_rights(&b.device_id(), DeviceRights::first_pairing()).unwrap();
    assert!(c.cancels().contains(&other));
    assert!(c.rig.routers.create.view(None, &other).is_none());
}

// ── Address directory (PROTOKOLL 14) ──

const VECTOR_ADDRESS: &str = "https://quiet-river-lamp.trycloudflare.com";
const VECTOR_ANNOUNCE_SIG: &str = "QcEB6tTcjkOLl-_l0IHPz9oFUUBmAswu9dQO1458sJPiDnk0-8JDBkePKkZUU3JJtBbiwiLG4puaDXvfDM2FBA";

/// A stand-in for the directory on loopback: records every announcement and
/// answers 503 for the first `fail_first` of them.
struct Directory {
    seen: Arc<Mutex<Vec<(std::time::Instant, serde_json::Value)>>>,
    server: tokio::task::JoinHandle<()>,
    base: String,
}

impl Drop for Directory {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Directory {
    async fn start(fail_first: u32) -> Self {
        let seen: Arc<Mutex<Vec<(std::time::Instant, serde_json::Value)>>> = Arc::new(Mutex::new(Vec::new()));
        let failures = Arc::new(std::sync::atomic::AtomicU32::new(fail_first));
        let log = seen.clone();
        let router = Router::new().route(
            "/api/remote/announce",
            axum::routing::post(move |body: axum::Json<serde_json::Value>| {
                let log = log.clone();
                let failures = failures.clone();
                async move {
                    lock(&log).push((std::time::Instant::now(), body.0));
                    let left = failures.load(Ordering::SeqCst);
                    if left > 0 {
                        failures.store(left - 1, Ordering::SeqCst);
                        return (StatusCode::SERVICE_UNAVAILABLE, axum::Json(serde_json::json!({ "error": "unavailable" }))).into_response();
                    }
                    axum::Json(serde_json::json!({ "ok": true })).into_response()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Self { seen, server, base }
    }

    fn count(&self) -> usize {
        lock(&self.seen).len()
    }

    fn body(&self, i: usize) -> serde_json::Value {
        lock(&self.seen)[i].1.clone()
    }

    async fn wait_for(&self, n: usize) {
        for _ in 0..400 {
            if self.count() >= n {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("expected {n} announcements, got {}", self.count());
    }
}

fn point_at(rig: &Rig, dir: &Directory, probe_ok: Arc<AtomicBool>) {
    rig.hub.set_announce_net(AnnounceNet {
        base: dir.base.clone(),
        probe: Arc::new(move |_address: String| -> ProbeFuture {
            let ok = probe_ok.load(Ordering::SeqCst);
            Box::pin(async move { ok })
        }),
        retry_first: Duration::from_millis(60),
        retry_max: Duration::from_secs(2),
        refresh: Duration::from_secs(3600),
    });
}

#[tokio::test]
async fn the_announcement_is_signed_and_a_new_address_is_announced_again() {
    let rig = rig().await;
    let dir = Directory::start(0).await;
    point_at(&rig, &dir, Arc::new(AtomicBool::new(true)));
    rig.hub.set_anywhere(true).unwrap();
    rig.hub.tunnel_up(VECTOR_ADDRESS);
    dir.wait_for(1).await;

    let a: seal::Announce = serde_json::from_value(dir.body(0)).unwrap();
    seal::verify_announce(&a, rig.now()).unwrap();
    // PROTOKOLL 18: desktop secret 32 x 0x22, time 1790000000, this address.
    assert_eq!(a.desktop_id, "or24zD2Qk4Z7byxTVSh6WQ");
    assert_eq!(a.ed25519_pub, "sp0jamO9uo3YElgxfMkXIq7CQPmUeT7pwo1yktEt2jk");
    assert_eq!(a.address, VECTOR_ADDRESS);
    assert_eq!(a.time, 1_790_000_000);
    assert_eq!(a.signature, VECTOR_ANNOUNCE_SIG);
    // Exactly the five fields of 14.1, nothing else leaves.
    let mut keys: Vec<String> = dir.body(0).as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["address", "desktop_id", "ed25519_pub", "signature", "time"]);
    for _ in 0..100 {
        if rig.hub.announce_status().state == "ok" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let status = rig.hub.announce_status();
    assert_eq!(status.state, "ok");
    assert_eq!(status.last_ok_at, Some(T0));
    assert!(lock(&rig.events).iter().any(|(e, v)| e == "remote-announce-changed" && v["state"] == "ok"));

    // The same address again (a second start call): no second announcement.
    rig.hub.tunnel_up(VECTOR_ADDRESS);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(dir.count(), 1);

    // A new tunnel, a new address: announced again, signed again.
    rig.advance(30);
    rig.hub.tunnel_up("https://bright-otter-tide.trycloudflare.com");
    dir.wait_for(2).await;
    let b: seal::Announce = serde_json::from_value(dir.body(1)).unwrap();
    assert_eq!(b.address, "https://bright-otter-tide.trycloudflare.com");
    seal::verify_announce(&b, rig.now()).unwrap();
    assert!(b.time > a.time);
}

#[tokio::test]
async fn a_failed_announcement_is_tried_again_with_growing_waits() {
    let rig = rig().await;
    let dir = Directory::start(2).await;
    let probe_ok = Arc::new(AtomicBool::new(false));
    point_at(&rig, &dir, probe_ok.clone());
    rig.hub.set_anywhere(true).unwrap();
    rig.hub.tunnel_up(VECTOR_ADDRESS);

    // The address does not answer yet: nothing is sent, the panel says why.
    for _ in 0..100 {
        if rig.hub.announce_status().state == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert_eq!(dir.count(), 0);
    let status = rig.hub.announce_status();
    assert_eq!(status.state, "failed");
    assert_eq!(status.error.as_deref(), Some("The tunnel address does not answer yet."));
    assert!(status.next_try_at.is_some());

    // Now it answers; the directory fails twice, then takes it.
    probe_ok.store(true, Ordering::SeqCst);
    dir.wait_for(3).await;
    let times: Vec<std::time::Instant> = lock(&dir.seen).iter().map(|(t, _)| *t).collect();
    let first_gap = times[1] - times[0];
    let second_gap = times[2] - times[1];
    // 60 ms, tripled per failure: the second wait is clearly longer.
    assert!(first_gap >= Duration::from_millis(150), "{first_gap:?}");
    assert!(second_gap >= Duration::from_millis(450), "{second_gap:?}");
    assert!(second_gap > first_gap);
    for _ in 0..100 {
        if rig.hub.announce_status().state == "ok" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(rig.hub.announce_status().state, "ok");
    assert!(lock(&rig.events).iter().any(|(e, v)| e == "remote-announce-changed" && v["state"] == "failed"));
    // The wait is bounded.
    let net = lock(&rig.hub.announce_net).clone();
    assert_eq!(announce_backoff(&net, 30), Duration::from_secs(2));
    assert_eq!(announce_backoff(&AnnounceNet::default(), 30), Duration::from_secs(30 * 60));
}

#[tokio::test]
async fn with_the_switch_off_nothing_is_announced() {
    let rig = rig().await;
    let dir = Directory::start(0).await;
    point_at(&rig, &dir, Arc::new(AtomicBool::new(true)));
    rig.hub.tunnel_up(VECTOR_ADDRESS);
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(dir.count(), 0);
    assert_eq!(rig.hub.announce_status().state, "off");

    // On: announced. Off again: a new address goes nowhere.
    rig.hub.set_anywhere(true).unwrap();
    dir.wait_for(1).await;
    rig.hub.set_anywhere(false).unwrap();
    assert_eq!(rig.hub.announce_status().state, "off");
    rig.hub.tunnel_up("https://bright-otter-tide.trycloudflare.com");
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(dir.count(), 1);

    // Tunnel gone while on: idle, nothing sent.
    rig.hub.set_anywhere(true).unwrap();
    dir.wait_for(2).await;
    rig.hub.tunnel_down();
    assert_eq!(rig.hub.announce_status().state, "idle");
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(dir.count(), 2);
}

#[test]
fn the_directory_base_is_the_public_site_unless_the_build_says_otherwise() {
    match option_env!("VITE_LU_CLOUD_URL") {
        Some(url) => assert_eq!(CLOUD_BASE, url),
        None => assert_eq!(CLOUD_BASE, "https://lu-labs.ai"),
    }
    assert_eq!(AnnounceNet::default().base, CLOUD_BASE.trim_end_matches('/'));
}

// ── "Sign in with my computer" (PROTOKOLL 15) ──

const VECTOR_CODE: &str = "Zx9_k-2mQpLr7TbW";
const VECTOR_SIGNIN_SIG: &str = "1lQOegmy0E6BYpNVvhyC9-pFsJoJe-xr8fdQDsNS1w3qtvSrtIeigA2ETW6OTNaG7-Gx5VIvXuMMsmMoWJRQAQ";

/// Waits for the question at the desktop and returns its payload.
async fn signin_question(rig: &Rig) -> serde_json::Value {
    for _ in 0..300 {
        if let Some((_, v)) = lock(&rig.events).iter().rev().find(|(e, _)| e == "remote-signin-request") {
            return v.clone();
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("no sign-in question was shown");
}

async fn ask_signin(rig: &Rig, phone: &Phone, via: Via, decision: Option<SigninDecision>) -> (Answer, serde_json::Value) {
    let decide = async {
        let q = signin_question(rig).await;
        if let Some(d) = decision {
            rig.hub.signin_decide(q["requestId"].as_str().unwrap(), d).unwrap();
        }
        q
    };
    let (answer, q) = tokio::join!(phone.call(rig, via, "POST", SIGNIN_PATH, b"{}"), decide);
    (answer.unwrap(), q)
}

#[tokio::test]
async fn sign_in_gives_exactly_one_code_and_only_after_allow() {
    let rig = rig().await;
    let via = Via::Tunnel("198.51.100.90");
    // The phone of the vectors: secret 32 x 0x11.
    let phone = paired_phone(&rig, 0x11, via).await;
    let (answer, q) = ask_signin(&rig, &phone, via, Some(SigninDecision::Allow { code: VECTOR_CODE.into(), expires: T0 + 120 })).await;
    // The question names the phone and carries the key the code is bound to.
    assert_eq!(q["name"], "Pixel 8");
    assert_eq!(q["devicePub"], "QXJWeQNQ-SQ9-vxUYr6oP_y6nSLlKqV4Sk0ptG01gRc");
    assert_eq!(answer.status, 200);
    // Only the code and its end, nothing else of the desktop.
    assert_eq!(answer.json(), serde_json::json!({ "code": VECTOR_CODE, "expires": T0 + 120 }));
    // The same question cannot be answered a second time.
    assert!(rig.hub.signin_decide(q["requestId"].as_str().unwrap(), SigninDecision::Allow { code: VECTOR_CODE.into(), expires: T0 }).is_err());
    assert!(rig.hub.open_signins().is_empty());

    // What the phone then sends to redeem checks against the bound key (vector 15).
    let sig = seal::sign_signin(&phone.secret, VECTOR_CODE, T0).unwrap();
    assert_eq!(sig, VECTOR_SIGNIN_SIG);
    seal::verify_signin(q["devicePub"].as_str().unwrap(), VECTOR_CODE, T0, &sig, T0).unwrap();
    seal::verify_bind(&seal::b64(&phone.secret.ed25519_public()), &phone.secret.x25519_public(), &seal::sign_bind(&phone.secret)).unwrap();

    // The feature is named inside the channel.
    let status = phone.call(&rig, via, "GET", "/remote-api/status/full", b"").await.unwrap();
    assert!(status.json()["features"].as_array().unwrap().iter().any(|f| f == "signin"));
    // And whether the Windows Firewall drops the Wi-Fi way (false where nothing was checked).
    assert_eq!(status.json()["lan_blocked"], false);
}

#[tokio::test]
async fn sign_in_without_allow_gives_no_code() {
    let rig = rig().await;
    let via = Via::Lan("192.168.1.90");
    let phone = paired_phone(&rig, 0x41, via).await;

    let (answer, _) = ask_signin(&rig, &phone, via, Some(SigninDecision::Deny)).await;
    assert_eq!(answer.status, 403);
    assert_eq!(answer.json(), serde_json::json!({ "error": "signin_denied" }));

    // Nobody answers (or the dialog was closed and the window never said):
    // after the wait it is a denial, and the question is gone.
    rig.hub.set_signin_wait(Duration::from_millis(150));
    lock(&rig.events).clear();
    let (answer, q) = ask_signin(&rig, &phone, via, None).await;
    assert_eq!(answer.status, 403);
    assert!(answer.json().get("code").is_none());
    assert!(rig.hub.open_signins().is_empty());
    assert!(lock(&rig.events).iter().any(|(e, v)| e == "remote-signin-resolved" && v["requestId"] == q["requestId"]));

    // A code of the wrong form from the window never reaches the phone.
    rig.hub.set_signin_wait(Duration::from_secs(5));
    lock(&rig.events).clear();
    let (answer, _) = ask_signin(&rig, &phone, via, Some(SigninDecision::Allow { code: "short".into(), expires: T0 })).await;
    assert_eq!(answer.status, 502);
    assert_eq!(answer.json(), serde_json::json!({ "error": "signin_unavailable" }));
}

#[tokio::test]
async fn a_signed_out_desktop_answers_the_protocol_error() {
    let rig = rig().await;
    let via = Via::Tunnel("198.51.100.91");
    let phone = paired_phone(&rig, 0x42, via).await;
    let (answer, _) = ask_signin(&rig, &phone, via, Some(SigninDecision::SignedOut)).await;
    assert_eq!(answer.status, 409);
    assert_eq!(answer.json()["error"], "desktop_signed_out");
    assert!(answer.json()["message"].as_str().unwrap().contains("not signed in"));
}

#[tokio::test]
async fn a_phone_that_is_not_paired_cannot_ask_to_sign_in() {
    let rig = rig().await;
    let via = Via::Tunnel("198.51.100.92");
    // Handshake done, the desktop has not allowed it yet.
    let mut phone = Phone::new(0x43);
    let ticket = rig.ticket();
    phone.connect(&rig, via, Some(&ticket)).await;
    let a = phone.call(&rig, via, "POST", SIGNIN_PATH, b"{}").await.unwrap();
    assert_eq!(a.status, 403);
    assert_eq!(a.json()["error"], "pairing_pending");
    assert!(!lock(&rig.events).iter().any(|(e, _)| e == "remote-signin-request"));

    // Denied: still nothing.
    rig.hub.decide(&rig.last_request_id(), false).unwrap();
    let a = phone.call(&rig, via, "POST", SIGNIN_PATH, b"{}").await.unwrap();
    assert_eq!(a.status, 403);
    assert_eq!(a.json()["error"], "pairing_denied");

    // Paired, then unpaired while the question is open: the question goes
    // and the phone gets no code.
    let other = paired_phone(&rig, 0x44, via).await;
    let ask = other.call(&rig, via, "POST", SIGNIN_PATH, b"{}");
    let forget = async {
        let q = signin_question(&rig).await;
        rig.hub.forget(&other.device_id()).unwrap();
        q
    };
    let (answer, q) = tokio::join!(ask, forget);
    assert_eq!(answer.unwrap().status, 403);
    assert!(rig.hub.open_signins().is_empty());
    assert!(rig.hub.signin_decide(q["requestId"].as_str().unwrap(), SigninDecision::Allow { code: VECTOR_CODE.into(), expires: T0 }).is_err());
    assert!(matches!(other.call(&rig, via, "POST", SIGNIN_PATH, b"{}").await, Err((_, code)) if code == "session_unknown"));
}

#[tokio::test]
async fn one_open_sign_in_question_per_phone() {
    let rig = rig().await;
    let via = Via::Lan("192.168.1.93");
    let phone = paired_phone(&rig, 0x45, via).await;
    let first = phone.call(&rig, via, "POST", SIGNIN_PATH, b"{}");
    let second = async {
        let q = signin_question(&rig).await;
        let again = phone.call(&rig, via, "POST", SIGNIN_PATH, b"{}").await.unwrap();
        rig.hub.signin_decide(q["requestId"].as_str().unwrap(), SigninDecision::Deny).unwrap();
        again
    };
    let (first, again) = tokio::join!(first, second);
    assert_eq!(again.status, 409);
    assert_eq!(again.json()["error"], "signin_pending");
    assert_eq!(first.unwrap().status, 403);
    let get = phone.call(&rig, via, "GET", SIGNIN_PATH, b"").await.unwrap();
    assert_eq!(get.status, 405);
}

// ── The old way in (findings H1) ──

async fn set_code(rig: &Rig, code: &str) {
    let mut pc = rig.routers.passcode.lock().await;
    pc.code = code.into();
    pc.expires_at = now_secs() + 900;
    pc.code_failures = (0, pc.expires_at);
}

async fn plain_auth(rig: &Rig, ip: &str, code: &str) -> (StatusCode, Option<String>) {
    let body = serde_json::to_vec(&serde_json::json!({ "passcode": code })).unwrap();
    let mut req = Request::builder().method("POST").uri("/remote-api/auth").header("content-type", "application/json").body(Body::from(body)).unwrap();
    req.extensions_mut().insert(ConnectInfo(format!("{ip}:40000").parse::<SocketAddr>().unwrap()));
    let res = rig.routers.lan.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let token = serde_json::from_slice::<serde_json::Value>(&bytes).ok().and_then(|v| v["token"].as_str().map(str::to_string));
    (status, token)
}

async fn with_token(rig: &Rig, method: &str, path: &str, token: &str) -> StatusCode {
    let mut req = Request::builder().method(method).uri(path).header("authorization", format!("Bearer {token}")).body(Body::from("{}")).unwrap();
    req.extensions_mut().insert(ConnectInfo("192.168.7.200:40000".parse::<SocketAddr>().unwrap()));
    rig.routers.lan.clone().oneshot(req).await.unwrap().status()
}

/// Was probe_old_code_login_is_an_oracle_and_ignores_device_rights: the plain
/// login now counts for the code, uses it up, and is gone once a phone is
/// paired, unless the desktop allows it for a while.
#[tokio::test]
async fn the_plain_code_login_counts_for_the_code_and_closes_once_phones_are_paired() {
    let rig = rig().await;
    set_code(&rig, "424242").await;
    // Nothing paired yet: the old way is there. Nine wrong guesses from nine
    // addresses leave the code, the tenth ends it.
    for i in 0..9u32 {
        let (s, _) = plain_auth(&rig, &format!("192.168.7.{i}"), &format!("{:06}", 100000 + i)).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
    }
    assert_eq!(rig.routers.passcode.lock().await.code, "424242");
    assert_eq!(rig.routers.passcode.lock().await.code_failures.0, 9);
    let (s, _) = plain_auth(&rig, "192.168.7.9", "100009").await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_ne!(rig.routers.passcode.lock().await.code, "424242", "the code outlived ten failures");
    let (s, _) = plain_auth(&rig, "192.168.7.10", "424242").await;
    assert_eq!(s, StatusCode::FORBIDDEN, "the ended code still logs in");

    // A login uses the code up.
    set_code(&rig, "515151").await;
    let (s, token) = plain_auth(&rig, "192.168.7.200", "515151").await;
    assert_eq!(s, StatusCode::OK);
    let token = token.unwrap();
    assert_ne!(rig.routers.passcode.lock().await.code, "515151", "a successful plain login keeps its code");
    let (s, _) = plain_auth(&rig, "192.168.7.201", "515151").await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    // A paired phone: the LAN listener knows only status and the sealed door.
    rig.routers.permissions.lock().await.downloads = true;
    let phone = paired_phone(&rig, 0x51, Via::Lan("192.168.1.90")).await;
    set_code(&rig, "616161").await;
    assert_eq!(plain_auth(&rig, "192.168.7.202", "616161").await.0, StatusCode::NOT_FOUND);
    assert_eq!(with_token(&rig, "POST", "/api/pull", &token).await, StatusCode::NOT_FOUND, "the JWT reached the proxy past the device rights");
    assert_eq!(with_token(&rig, "GET", "/mobile", &token).await, StatusCode::NOT_FOUND);
    assert_eq!(with_token(&rig, "GET", "/", &token).await, StatusCode::NOT_FOUND);
    let (s, _, _) = send(&rig, Via::Lan("192.168.1.90"), "GET", "/remote-api/status", Vec::new()).await;
    assert_eq!(s, StatusCode::OK);
    // The sealed phone keeps its own rights.
    let a = phone.call(&rig, Via::Lan("192.168.1.90"), "POST", "/api/pull", b"{}").await.unwrap();
    assert_eq!(a.status, 403);

    // Allowed at the desktop for a while, then closed again.
    rig.hub.set_legacy_access(true);
    assert_eq!(plain_auth(&rig, "192.168.7.203", "616161").await.0, StatusCode::OK);
    rig.advance(LEGACY_ACCESS_SECS + 1);
    set_code(&rig, "717171").await;
    assert_eq!(plain_auth(&rig, "192.168.7.204", "717171").await.0, StatusCode::NOT_FOUND);
    rig.hub.set_legacy_access(true);
    rig.hub.set_legacy_access(false);
    assert_eq!(plain_auth(&rig, "192.168.7.205", "717171").await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn anywhere_alone_closes_the_old_way_in() {
    let rig = rig().await;
    rig.hub.set_anywhere(true).unwrap();
    set_code(&rig, "818181").await;
    assert_eq!(plain_auth(&rig, "192.168.7.30", "818181").await.0, StatusCode::NOT_FOUND);
    rig.hub.set_anywhere(false).unwrap();
    assert_eq!(plain_auth(&rig, "192.168.7.31", "818181").await.0, StatusCode::OK);
}

// ── What a sealed body may cost (finding M1) ──

async fn send_body(rig: &Rig, via: Via, body: Body, length: Option<u64>) -> (StatusCode, Vec<u8>) {
    let (router, peer, cf) = match via {
        Via::Lan(ip) => (rig.routers.lan.clone(), format!("{ip}:40000"), None),
        Via::Tunnel(ip) => (rig.routers.tunnel.clone(), "127.0.0.1:40000".to_string(), Some(ip)),
    };
    let mut builder = Request::builder().method("POST").uri("/remote-api/sealed").header("content-type", "application/octet-stream");
    if let Some(ip) = cf {
        builder = builder.header("cf-connecting-ip", ip);
    }
    if let Some(n) = length {
        builder = builder.header("content-length", n.to_string());
    }
    let mut req = tunnel_host(builder, via).body(body).unwrap();
    req.extensions_mut().insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
    let res = tokio::time::timeout(Duration::from_secs(10), router.oneshot(req)).await.expect("answered without the whole body").unwrap();
    let status = res.status();
    (status, axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap().to_vec())
}

/// A body whose first bytes arrive and whose rest never does.
fn endless(head: Vec<u8>) -> Body {
    let first = futures_util::stream::once(async move { Ok::<_, std::io::Error>(axum::body::Bytes::from(head)) });
    Body::from_stream(futures_util::StreamExt::chain(first, futures_util::stream::pending()))
}

#[tokio::test]
async fn a_sealed_body_is_refused_before_it_is_read_in_full() {
    let rig = rig().await;
    for via in [Via::Lan("192.168.1.95"), Via::Tunnel("198.51.100.95")] {
        // A declared length over the limit.
        let (s, b) = send_body(&rig, via, Body::from(vec![1u8, 3]), Some(MAX_SEALED_BODY as u64 + 1)).await;
        assert_eq!((s, error_of(&b).as_str()), (StatusCode::PAYLOAD_TOO_LARGE, "too_large"));
        // A first message larger than 8 KiB.
        let mut big = vec![1u8, seal::KIND_HS_INIT, 0];
        big.resize(MAX_HS_INIT_BODY + 1, 0);
        let (s, b) = send_body(&rig, via, Body::from(big), None).await;
        assert_eq!((s, error_of(&b).as_str()), (StatusCode::PAYLOAD_TOO_LARGE, "too_large"));
        // A data frame for no session: answered after its head, the rest is
        // never waited for.
        let mut head = vec![1u8, seal::KIND_DATA_TO_DESKTOP];
        head.extend_from_slice(&[0x5a; 16]);
        head.extend_from_slice(&[0u8; 64]);
        let (s, b) = send_body(&rig, via, endless(head), None).await;
        assert_eq!((s, error_of(&b).as_str()), (StatusCode::NOT_FOUND, "session_unknown"));
    }
}

#[tokio::test]
async fn sealed_requests_wait_for_a_reading_slot() {
    let rig = rig().await;
    let slots = rig.hub.slots(Listener::Lan);
    let held = slots.clone().acquire_many_owned(SEALED_SLOTS as u32).await.unwrap();
    let phone = Phone::new(0x57);
    let (_, init) = phone.init(&rig, Some(&rig.ticket()));
    let (s, h, b) = send(&rig, Via::Lan("192.168.1.96"), "POST", "/remote-api/sealed", init.clone()).await;
    assert_eq!((s, error_of(&b).as_str()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    assert!(h.get("retry-after").is_some());
    drop(held);
    // A free slot again: the same request goes through.
    let (_, init) = phone.init(&rig, Some(&rig.ticket()));
    assert_eq!(send(&rig, Via::Lan("192.168.1.96"), "POST", "/remote-api/sealed", init).await.0, StatusCode::OK);
}

// ── Shared addresses (finding M2) ──

/// Was probe_shared_address_locks_the_owner_out_of_new_handshakes.
#[tokio::test]
async fn a_stranger_behind_the_same_address_does_not_lock_the_owner_out() {
    let rig = rig().await;
    let mut owner = paired_phone(&rig, 0x52, Via::Tunnel("198.51.100.99")).await;
    let stranger = Phone::new(0x53);
    for _ in 0..PAIR_FAILS_PER_SOURCE {
        let fake = PairingSecret::Ticket(Ticket::from_bytes([0x98; 16]));
        let (_, init) = stranger.init(&rig, Some(&fake));
        send(&rig, Via::Tunnel("198.51.100.99"), "POST", "/remote-api/sealed", init).await;
    }
    // The stranger's pairings are locked, the owner's handshake is not.
    let fake = PairingSecret::Ticket(Ticket::from_bytes([0x98; 16]));
    let (_, init) = stranger.init(&rig, Some(&fake));
    let (s, _, b) = send(&rig, Via::Tunnel("198.51.100.99"), "POST", "/remote-api/sealed", init).await;
    assert_eq!((s, error_of(&b).as_str()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    let (status, state, _) = owner.connect(&rig, Via::Tunnel("198.51.100.99"), None).await;
    assert_eq!((status, state), (StatusCode::OK, Some(PairState::Paired)));
}

#[test]
fn an_ipv6_sender_counts_as_its_64() {
    assert_eq!(source_key("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
    assert_eq!(source_key("2001:db8:1:2:bbbb:cccc:dddd:eeee"), "2001:db8:1:2::/64");
    assert_ne!(source_key("2001:db8:1:3::1"), source_key("2001:db8:1:2::1"));
    assert_eq!(source_key("::ffff:192.0.2.7"), "192.0.2.7");
    assert_eq!(source_key("192.0.2.7"), "192.0.2.7");
    let mut l = Limiter::default();
    for i in 0..PAIR_FAILS_PER_SOURCE {
        let ip = format!("2001:db8:1:2::{}", i + 1);
        l.admit(&ip, T0, true).unwrap();
        l.failed(&ip, T0, true);
    }
    assert!(l.admit("2001:db8:1:2:ffff::9", T0, true).is_err(), "another address of the same /64 got around the lock");
    assert!(l.admit("2001:db8:1:2:ffff::9", T0, false).is_ok(), "a known device is not locked by pairing failures");
}

#[test]
fn all_handshakes_together_have_a_ceiling() {
    let mut l = Limiter::default();
    for i in 0..GLOBAL_HANDSHAKES_PER_WINDOW {
        let ip = format!("10.{}.{}.1", i / 200, i % 200);
        l.admit(&ip, T0, false).unwrap();
    }
    assert!(l.admit("10.250.0.1", T0, false).is_err());
    assert!(l.admit("10.250.0.2", T0 + WINDOW_SECS, false).is_ok(), "the next window is open again");
}

// ── Replayed first messages (finding N2) ──

/// Was probe_replayed_ik_init_evicts_a_fresh_session_on_the_lan.
#[tokio::test]
async fn a_replayed_ik_init_is_refused_and_leaves_the_fresh_session() {
    let rig = rig().await;
    let mut owner = paired_phone(&rig, 0x54, Via::Lan("192.168.1.91")).await;
    let (hs, captured) = owner.init(&rig, None);
    let (status, _, body) = send(&rig, Via::Lan("192.168.1.91"), "POST", "/remote-api/sealed", captured.clone()).await;
    assert_eq!(status, StatusCode::OK);
    let (session, _) = hs.finish(&body, rig.now()).unwrap();
    owner.session = Some(session);
    rig.advance(1);
    for _ in 0..MAX_UNCONFIRMED_PER_DEVICE {
        let (s, _, b) = send(&rig, Via::Lan("192.168.1.66"), "POST", "/remote-api/sealed", captured.clone()).await;
        assert_eq!((s, error_of(&b).as_str()), (StatusCode::CONFLICT, "replay"));
    }
    let a = owner.call(&rig, Via::Lan("192.168.1.91"), "GET", "/api/tags", b"").await.unwrap();
    assert_eq!(a.status, 200);
    // A first message that failed may come again (it was never read).
    let (_, failed) = Phone::new(0x58).init(&rig, None);
    for _ in 0..2 {
        let (s, _, b) = send(&rig, Via::Lan("192.168.1.67"), "POST", "/remote-api/sealed", failed.clone()).await;
        assert_eq!((s, error_of(&b).as_str()), (StatusCode::UNAUTHORIZED, "unknown_device"));
    }
}

#[test]
fn seen_ephemerals_are_bounded_and_forgotten_after_a_day() {
    let mut seen = SeenEphemerals::default();
    assert!(seen.claim([1; 32], T0));
    assert!(!seen.claim([1; 32], T0 + 5));
    assert!(seen.claim([1; 32], T0 + EPHEMERAL_KEEP_SECS), "kept past a session's lifetime");
    for i in 0..(MAX_SEEN_EPHEMERALS + 10) {
        let mut k = [0u8; 32];
        k[..8].copy_from_slice(&(i as u64).to_be_bytes());
        k[31] = 9;
        seen.claim(k, T0 + EPHEMERAL_KEEP_SECS + 1);
    }
    assert!(seen.order.len() <= MAX_SEEN_EPHEMERALS && seen.when.len() == seen.order.len());
}

// ── Tickets (finding M4) ──

/// Was probe_replaced_qr_ticket_still_pairs.
#[tokio::test]
async fn only_the_ticket_of_the_qr_on_screen_pairs() {
    let rig = rig().await;
    let old = rig.ticket();
    let shown = rig.ticket();
    let mut p = Phone::new(0x56);
    let (status, _, body) = p.connect(&rig, Via::Tunnel("203.0.113.77"), Some(&old)).await;
    assert_eq!((status, error_of(&body).as_str()), (StatusCode::UNAUTHORIZED, "unknown_ticket"));
    // Closing the panel ends the shown one too.
    rig.hub.set_pairing_window(false);
    let (status, _, _) = p.connect(&rig, Via::Tunnel("203.0.113.77"), Some(&shown)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // No QR without the panel.
    assert!(rig.hub.pairing_link(None, None).is_err());
    // A server stop ends it as well.
    let latest = rig.ticket();
    rig.hub.drop_all_sessions();
    let (status, _, _) = p.connect(&rig, Via::Tunnel("203.0.113.78"), Some(&latest)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // The ticket on screen pairs.
    let now_shown = rig.ticket();
    let (status, state, _) = p.connect(&rig, Via::Tunnel("203.0.113.79"), Some(&now_shown)).await;
    assert_eq!((status, state), (StatusCode::OK, Some(PairState::Pending)));
}

// ── Names (finding N1) ──

/// Was probe_bidi_name_reaches_the_dialog.
#[tokio::test]
async fn a_bidi_name_never_reaches_the_dialog() {
    let rig = rig().await;
    let phone = Phone::new(0x55);
    let name = "Pixel 8\u{202E}ynoT\u{200B}\u{2028}x";
    let hello = PhoneHello::new(&phone.secret, name, "android", "3.0.7");
    let ticket = rig.ticket();
    if let Ok((_hs, init)) = PhoneHandshake::start(&phone.secret, &rig.hub.secret.desktop_id(), &rig.hub.secret.x25519_public(), Some(&ticket), &hello) {
        let (status, _, _) = send(&rig, Via::Lan("192.168.1.92"), "POST", "/remote-api/sealed", init).await;
        assert_ne!(status, StatusCode::OK);
    }
    assert!(lock(&rig.events).iter().all(|(e, _)| e != "remote-pair-request"));
    // A clean name arrives with a fingerprint of the device id.
    let mut p = Phone::new(0x59);
    let ticket = rig.ticket();
    p.connect(&rig, Via::Lan("192.168.1.93"), Some(&ticket)).await;
    let shown = lock(&rig.events).iter().find(|(e, _)| e == "remote-pair-request").unwrap().1.clone();
    assert_eq!(shown["name"], "Pixel 8");
    assert_eq!(shown["fingerprint"], device_fingerprint(&p.device_id()));
    assert_eq!(shown["fingerprint"].as_str().unwrap().len(), 9);
}

#[test]
fn labels_lose_format_and_separator_characters() {
    assert_eq!(clean_label("Pixel\u{202E} 8\u{200B}", "Phone"), "Pixel 8");
    assert_eq!(clean_label("  a\u{2028}b\u{2029}c\t\td  ", "Phone"), "a b c d");
    assert_eq!(clean_label("\u{200D}\u{2066}", "Phone"), "Phone");
    // Emoji joined with ZWJ, a flag from tag characters.
    assert_eq!(clean_label("\u{1F468}\u{200D}\u{1F469} Studio", "x"), "\u{1F468}\u{1F469} Studio");
    assert_eq!(clean_label("\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} Mac", "x"), "\u{1F3F4} Mac");
    let long = "\u{00E9}".repeat(200);
    let out = clean_label(&long, "x");
    assert!(out.chars().count() <= 64 && out.len() <= 256);
    let wide = "\u{1F600}".repeat(70);
    let out = clean_label(&wide, "x");
    assert!(out.chars().count() <= 64 && out.len() <= 256);
}

/// A computer name with emoji and joiners must not break the pairing.
#[tokio::test]
async fn a_desktop_name_with_emoji_and_joiners_still_pairs() {
    let dir = tempfile::tempdir().unwrap();
    let hub = Arc::new(SealedHub::assemble(
        DeviceSecret::from_bytes([0x23; 32]),
        "Mia\u{2019}s \u{1F468}\u{200D}\u{1F4BB} Mac\u{1F3F4}\u{E0067}\u{E0062}\u{E007F}\u{2028}",
        "file",
        Some(dir.path().join(DEVICES_FILE)),
        DeviceBook::default(),
        Arc::new(|| T0),
        Duration::from_secs(5),
        Duration::from_secs(5),
    ));
    hub.set_pairing_window(true);
    let (uri, _) = hub.pairing_link(Some("http://192.0.2.10:11435".into()), None).unwrap();
    let link = PairingLink::parse(&uri).unwrap();
    assert_eq!(link.name, "Mia\u{2019}s \u{1F468}\u{1F4BB} Mac\u{1F3F4}");
    let phone = DeviceSecret::from_bytes([0x5b; 32]);
    let hello = PhoneHello::new(&phone, "Pixel 8", "android", "3.0.7");
    let (hs, init) = PhoneHandshake::start(&phone, &link.desktop_id, &link.desktop_x25519, Some(&PairingSecret::Ticket(link.ticket)), &hello).unwrap();
    let out = hub.handshake(&SealedInput { listener: Listener::Lan, source: "192.0.2.50", body: &init, code: CodeOffer::Absent }, T0);
    assert_eq!(out.status, 200);
    let (_session, answer) = hs.finish(&out.body, T0).unwrap();
    assert_eq!(answer.name, "Mia\u{2019}s \u{1F468}\u{1F4BB} Mac\u{1F3F4}");
}

// ── Host names (finding N3) ──

async fn get_with_host(router: &Router, peer: &str, host: Option<&str>) -> StatusCode {
    get_path_with_host(router, "/remote-api/status", peer, host).await
}

async fn get_path_with_host(router: &Router, path: &str, peer: &str, host: Option<&str>) -> StatusCode {
    let mut b = Request::builder().method("GET").uri(path);
    if let Some(h) = host {
        b = b.header("host", h);
    }
    let mut req = b.body(Body::empty()).unwrap();
    req.extensions_mut().insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
    router.clone().oneshot(req).await.unwrap().status()
}

#[tokio::test]
async fn each_listener_answers_only_under_its_own_names() {
    let rig = rig().await;
    let lan = &rig.routers.lan;
    for ok in [None, Some("192.168.1.5:11435"), Some("[fe80::1]:11435"), Some("localhost:11435"), Some("127.0.0.1")] {
        assert_eq!(get_with_host(lan, "192.168.1.5:4000", ok).await, StatusCode::OK, "{ok:?}");
    }
    // The doors answer under a name too (studio.local, a router name); the
    // plain ways, allowed here for a while, only under an address.
    rig.hub.set_legacy_access(true);
    for name in ["studio.local:11435", "desktop.lan", "evil.example"] {
        assert_eq!(get_with_host(lan, "192.168.1.5:4000", Some(name)).await, StatusCode::OK, "{name}");
    }
    assert_ne!(get_path_with_host(lan, "/mobile", "192.168.1.5:4000", Some("192.168.1.5:11435")).await, StatusCode::NOT_FOUND);
    for bad in ["evil.example", "evil.example:11435", "quiet-river-1234.trycloudflare.com", "192.168.1.5.nip.io:11435", "studio.local"] {
        assert_eq!(get_path_with_host(lan, "/mobile", "192.168.1.5:4000", Some(bad)).await, StatusCode::NOT_FOUND, "{bad}");
    }
    rig.hub.set_legacy_access(false);
    let tunnel = &rig.routers.tunnel;
    assert_eq!(get_with_host(tunnel, "127.0.0.1:4000", Some("quiet-river-1234.trycloudflare.com")).await, StatusCode::OK);
    assert_eq!(get_with_host(tunnel, "127.0.0.1:4000", Some("127.0.0.1:11436")).await, StatusCode::OK);
    for bad in [None, Some("other-name-9.trycloudflare.com"), Some("evil.example"), Some("192.168.1.5:11436")] {
        assert_eq!(get_with_host(tunnel, "127.0.0.1:4000", bad).await, StatusCode::NOT_FOUND, "{bad:?}");
    }
    // No tunnel any more: only loopback.
    rig.hub.tunnel_down();
    assert_eq!(get_with_host(tunnel, "127.0.0.1:4000", Some("quiet-river-1234.trycloudflare.com")).await, StatusCode::NOT_FOUND);
}

// ── Stopping (finding N5) ──

/// The stop waits for the hub slot instead of giving up when it is busy.
#[tokio::test]
async fn a_stop_while_the_hub_slot_is_busy_still_ends_everything() {
    let rig = rig().await;
    rig.hub.set_pairing_window(true);
    let _phone = paired_phone(&rig, 0x5c, Via::Lan("192.168.1.97")).await;
    assert!(!lock(&rig.hub.sessions).is_empty());
    let mut slot = HUB.lock().await;
    let before = slot.replace(rig.hub.clone());
    let stop = tokio::spawn(server_stopped());
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!stop.is_finished(), "the stop did not wait for the slot");
    drop(slot);
    stop.await.unwrap();
    assert!(lock(&rig.hub.sessions).is_empty());
    assert!(!rig.hub.pairing_window_open());
    *HUB.lock().await = before;
}

// ── Races with unpairing (finding N4) ──

#[tokio::test]
async fn work_of_a_device_unpaired_meanwhile_is_not_kept_as_a_deferred_answer() {
    let rig = rig_with(Duration::from_millis(200), Duration::from_millis(100)).await;
    let phone = paired_phone(&rig, 0x5d, Via::Lan("192.168.1.98")).await;
    let id = phone.device_id();
    let hub = rig.hub.clone();
    let forget = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        hub.forget(&id).unwrap();
    });
    let a = phone.call(&rig, Via::Lan("192.168.1.98"), "GET", "/api/slow", b"").await.unwrap();
    forget.await.unwrap();
    assert_eq!((a.status, error_of(&a.body).as_str()), (403, "unknown_device"));
    assert!(lock(&rig.hub.pending).is_empty(), "a deferred answer outlived the unpairing");
}

#[tokio::test]
async fn a_dropped_request_ends_its_work_before_the_handover() {
    let rig = rig_with(Duration::from_secs(5), Duration::from_secs(5)).await;
    let phone = paired_phone(&rig, 0x5e, Via::Lan("192.168.1.99")).await;
    struct Flag(Arc<AtomicBool>);
    impl Drop for Flag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let dropped = Arc::new(AtomicBool::new(false));
    let flag = Flag(dropped.clone());
    let gen = rig.hub.generation(&phone.device_id());
    let work = async move {
        let _f = flag;
        tokio::time::sleep(Duration::from_secs(30)).await;
        InnerAnswer::empty(200)
    };
    let _ = tokio::time::timeout(Duration::from_millis(50), rig.hub.run_deferred(&phone.device_id(), gen, work)).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(dropped.load(Ordering::SeqCst), "the work ran on after its request was gone");
}

#[tokio::test]
async fn a_taken_right_or_an_unpairing_raises_the_generation() {
    let rig = rig().await;
    let phone = paired_phone(&rig, 0x5f, Via::Lan("192.168.1.100")).await;
    let id = phone.device_id();
    let g0 = rig.hub.generation(&id);
    assert!(rig.hub.caller_current(&id, g0));
    // A right added: nothing older is cut.
    rig.hub.set_rights(&id, DeviceRights { create: true, ..DeviceRights::first_pairing() }).unwrap();
    assert!(rig.hub.caller_current(&id, g0));
    rig.hub.set_rights(&id, DeviceRights::first_pairing()).unwrap();
    assert!(!rig.hub.caller_current(&id, g0));
    let g1 = rig.hub.generation(&id);
    // The job table refuses a job let in under the old generation.
    rig.routers.permissions.lock().await.create = true;
    let spec = crate::commands::remote_create::JobSpec::text(crate::commands::remote_create::Kind::Image, "a cat");
    assert_eq!(rig.routers.create.submit_as(&id, Some(g0), None, spec.clone(), 1).unwrap_err(), crate::commands::remote_create::CreateError::Gone);
    assert!(rig.routers.create.submit_as(&id, Some(g1), None, spec.clone(), 1).is_ok());
    rig.hub.forget(&id).unwrap();
    assert!(!rig.hub.caller_current(&id, g1));
    assert_eq!(rig.routers.create.submit_as(&id, Some(g1), None, spec, 2).unwrap_err(), crate::commands::remote_create::CreateError::Gone);
}

// ── Sign-in limits (review of the sign-in route) ──

#[tokio::test]
async fn sign_in_questions_are_one_at_a_time_and_limited() {
    let rig = rig().await;
    let via_a = Via::Lan("192.168.1.110");
    let via_b = Via::Lan("192.168.1.111");
    let a = paired_phone(&rig, 0x60, via_a).await;
    let b = paired_phone(&rig, 0x61, via_b).await;
    // While A's question is open, B is told to wait.
    let first = a.call(&rig, via_a, "POST", SIGNIN_PATH, b"{}");
    let other = async {
        let q = signin_question(&rig).await;
        let refused = b.call(&rig, via_b, "POST", SIGNIN_PATH, b"{}").await.unwrap();
        rig.hub.signin_decide(q["requestId"].as_str().unwrap(), SigninDecision::Deny).unwrap();
        refused
    };
    let (first, refused) = tokio::join!(first, other);
    assert_eq!(first.unwrap().status, 403);
    assert_eq!((refused.status, refused.json()["error"].as_str()), (409, Some("signin_pending")));
    // Three questions per phone in ten minutes, then a wait.
    for _ in 1..SIGNIN_ASKS_PER_DEVICE {
        let (answer, _) = ask_signin(&rig, &a, via_a, Some(SigninDecision::Deny)).await;
        assert_eq!(answer.status, 403);
    }
    let limited = a.call(&rig, via_a, "POST", SIGNIN_PATH, b"{}").await.unwrap();
    assert_eq!((limited.status, limited.json()["error"].as_str()), (429, Some("rate_limited")));
    assert!(limited.header("retry-after").is_some_and(|w| w.parse::<u64>().unwrap() > 0));
    // The other phone still has its own.
    let (answer, _) = ask_signin(&rig, &b, via_b, Some(SigninDecision::Deny)).await;
    assert_eq!(answer.status, 403);
    // Later the limit is gone.
    rig.advance(SIGNIN_WINDOW_SECS);
    let (answer, _) = ask_signin(&rig, &a, via_a, Some(SigninDecision::Deny)).await;
    assert_eq!(answer.status, 403);
}

#[test]
fn a_refusal_of_the_directory_shows_only_a_plain_code() {
    assert_eq!(announce_refusal(400, "bad_request"), "lu-labs.ai refused the address (bad_request).");
    assert_eq!(announce_refusal(400, "see https://x.example/<script>"), "lu-labs.ai refused the address (HTTP 400).");
}

#[tokio::test]
async fn shared_chats_go_through_the_channel_with_the_right_chat() {
    let rig = rig_with(Duration::from_secs(5), Duration::from_secs(5)).await;
    let via = Via::Tunnel("198.51.100.90");
    let phone = paired_phone(&rig, 0x51, via).await;
    // Before the window reported its list, no chat words.
    let status = phone.call(&rig, via, "GET", "/remote-api/status/full", b"").await.unwrap();
    assert!(!status.json()["features"].as_array().unwrap().contains(&serde_json::json!("chats")));
    rig.routers.chats.sync(&[serde_json::json!({ "id": "c1", "title": "Plan", "mode": "chat" })]);
    let status = phone.call(&rig, via, "GET", "/remote-api/status/full", b"").await.unwrap();
    let features = status.json()["features"].clone();
    for word in ["chats", "stream", "approvals", "tasks"] {
        assert!(features.as_array().unwrap().contains(&serde_json::json!(word)), "{word} in {features}");
    }
    let list = phone.call(&rig, via, "GET", "/remote-api/chats", b"").await.unwrap();
    assert_eq!(list.status, 200);
    assert_eq!(list.json()["chats"][0]["title"], "Plan");
    let body = serde_json::to_vec(&serde_json::json!({ "client_id": "k1", "content": "hi" })).unwrap();
    let sent = phone.call(&rig, via, "POST", "/remote-api/chats/c1/messages", &body).await.unwrap();
    assert_eq!(sent.status, 202, "{:?}", sent.json());
    // Without the right chat: the channel's 403 before any handler.
    rig.hub.set_rights(&phone.device_id(), DeviceRights { agent: true, ..DeviceRights::default() }).unwrap();
    let refused = phone.call(&rig, via, "GET", "/remote-api/chats", b"").await.unwrap();
    assert_eq!((refused.status, refused.json()["right"].clone()), (403, serde_json::json!("chat")));
    let tasks = phone.call(&rig, via, "GET", "/remote-api/tasks", b"").await.unwrap();
    assert_eq!(tasks.status, 403);
}

// ── Voice over remote (#212) ──

#[tokio::test]
async fn voice_goes_through_the_channel_with_the_right_chat() {
    let rig = rig_with(Duration::from_secs(5), Duration::from_secs(5)).await;
    let via = Via::Tunnel("198.51.100.93");
    let phone = paired_phone(&rig, 0x53, via).await;
    // The test server has no desktop behind it: the status says so, a take is answered 503 with the reason.
    let status = phone.call(&rig, via, "GET", "/remote-api/voice", b"").await.unwrap();
    assert_eq!(status.status, 200, "{:?}", status.json());
    assert_eq!(status.json()["listen"], false);
    assert!(status.json()["why"].as_str().unwrap().contains("desktop app"));
    let mut wav = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
    wav.resize(4000, 0);
    let take = phone.call(&rig, via, "POST", "/remote-api/voice/transcribe", &wav).await.unwrap();
    assert_eq!(take.status, 503, "{:?}", take.json());
    // Without the right chat: the channel's 403 before any handler.
    rig.hub.set_rights(&phone.device_id(), DeviceRights { agent: true, ..DeviceRights::default() }).unwrap();
    for path in ["/remote-api/voice", "/remote-api/voice/transcribe", "/remote-api/voice/speak"] {
        let method = if path == "/remote-api/voice" { "GET" } else { "POST" };
        let refused = phone.call(&rig, via, method, path, b"{}").await.unwrap();
        assert_eq!((refused.status, refused.json()["right"].clone()), (403, serde_json::json!("chat")), "{path}");
    }
    let status = phone.call(&rig, via, "GET", "/remote-api/status/full", b"").await.unwrap();
    assert!(!status.json()["features"].as_array().unwrap().contains(&serde_json::json!("voice")));
}

// ── Chat attachments with the right `chat` alone ──

#[tokio::test]
async fn a_chat_only_device_uploads_attachments_without_create() {
    let c = create_rig_with(Duration::from_secs(5), Duration::from_secs(5)).await;
    let via = Via::Lan("192.168.1.91");
    let a = paired_phone(&c.rig, 0x51, via).await;
    // Create is off everywhere: the switch, the hub, the device right.
    c.rig.routers.permissions.lock().await.create = false;
    c.rig.routers.create.set_enabled(false, crate::commands::remote_create::now_secs());
    let pdf = b"%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n";
    let up = a.call(&c.rig, via, "POST", "/remote-api/create/uploads", pdf).await.unwrap();
    assert_eq!(up.status, 201, "{:?}", up.json());
    assert_eq!(up.json()["mime"], "application/pdf");
    // Same rules as ever: only pictures, PDF and text.
    let r = a.call(&c.rig, via, "POST", "/remote-api/create/uploads", b"\x00\x01binary").await.unwrap();
    assert_eq!(r.status, 400, "{:?}", r.json());
    // A job still needs Create.
    let r = a.call(&c.rig, via, "POST", "/remote-api/create/jobs", &job_body("image", "x")).await.unwrap();
    assert_eq!(r.status, 403);
    // Without chat and without create: no uploads.
    c.rig.hub.set_rights(&a.device_id(), DeviceRights { agent: true, ..DeviceRights::default() }).unwrap();
    let r = a.call(&c.rig, via, "POST", "/remote-api/create/uploads", pdf).await.unwrap();
    assert_eq!((r.status, r.json()), (403, serde_json::json!({ "error": "forbidden", "right": "create" })));
}

#[test]
fn the_uploads_route_opens_with_chat_or_create() {
    let none = DeviceRights::default();
    assert_eq!(path_allowed(&DeviceRights { chat: true, ..none }, UPLOADS_PATH), Ok(()));
    assert_eq!(path_allowed(&DeviceRights { create: true, ..none }, UPLOADS_PATH), Ok(()));
    assert_eq!(path_allowed(&none, UPLOADS_PATH), Err("create"));
    assert_eq!(path_allowed(&DeviceRights { chat: true, ..none }, "/remote-api/create/jobs"), Err("create"));
    assert_eq!(path_allowed(&DeviceRights { chat: true, ..none }, "/remote-api/chats"), Ok(()));
}

// ── Device test hook (feature e2e-remote) ──

#[cfg(feature = "e2e-remote")]
#[tokio::test]
async fn the_device_test_link_carries_the_tunnel_when_it_runs() {
    let rig = rig().await;
    rig.hub.set_pairing_window(false);
    let lan = Some("http://192.0.2.10:11435".to_string());
    let uri = rig.hub.e2e_pairing_link(lan.clone(), Some(TEST_TUNNEL.into())).unwrap();
    let link = PairingLink::parse(&uri).unwrap();
    assert_eq!(link.tunnel.as_deref(), Some(TEST_TUNNEL));
    assert_eq!(link.lan, lan);
    // Without a tunnel, or with an address that is no tunnel, none in the link.
    for tunnel in [None, Some("https://evil.example".to_string())] {
        let uri = rig.hub.e2e_pairing_link(lan.clone(), tunnel).unwrap();
        assert_eq!(PairingLink::parse(&uri).unwrap().tunnel, None);
    }
}

// ── Rights a new device starts with (Remote settings) ──

#[tokio::test]
async fn a_new_device_starts_with_the_rights_set_for_new_devices() {
    let rig = rig().await;
    assert_eq!(rig.hub.new_device_rights(), DeviceRights::first_pairing(), "unset: as before");
    let first = paired_phone(&rig, 0x41, Via::Lan("192.168.1.30")).await;
    let chosen = DeviceRights { chat: true, agent: false, files: true, terminal: false, create: true };
    rig.hub.set_new_device_rights(chosen).unwrap();
    let second = paired_phone(&rig, 0x42, Via::Lan("192.168.1.31")).await;
    let rights = |id: &str| rig.hub.devices().into_iter().find(|d| d.device_id == id).unwrap().rights;
    assert_eq!(rights(&first.device_id()), DeviceRights::first_pairing(), "a device paired before keeps its rights");
    assert_eq!(rights(&second.device_id()), chosen);
    // Kept on disk; a book from before has none and gives the old default.
    let book = load_book(&rig._dir.path().join(DEVICES_FILE));
    assert_eq!(book.new_device_rights, Some(chosen));
    let old: DeviceBook = serde_json::from_str(r#"{"v":1,"anywhere":false,"devices":[]}"#).unwrap();
    assert_eq!(old.new_device_rights, None);
}

#[test]
fn the_settings_list_shows_each_device_with_its_fingerprint() {
    let id = seal::b64(&[0x3F, 0x2A, 0x9C, 0x01, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    let device = PairedDevice {
        device_id: id.clone(),
        x25519: String::new(),
        ed25519: String::new(),
        name: "Pixel 8".into(),
        platform: "android".into(),
        app_version: "3.0.8".into(),
        rights: DeviceRights::first_pairing(),
        paired_at: 1,
        last_seen: 2,
    };
    let shown = devices_for_window(vec![device]);
    assert_eq!(shown[0]["fingerprint"], "3F2A 9C01");
    assert_eq!(shown[0]["device_id"], id);
    assert_eq!(shown[0]["last_seen"], 2);
}

#[tokio::test]
async fn a_taken_right_and_unpairing_are_told_to_the_shared_chats() {
    let rig = rig().await;
    let phone = paired_phone(&rig, 0x61, Via::Lan("192.168.1.95")).await;
    type Heard = Vec<(String, Option<DeviceRights>)>;
    let heard: Arc<Mutex<Heard>> = Arc::new(Mutex::new(Vec::new()));
    let h = heard.clone();
    rig.hub.set_on_rights_taken(Arc::new(move |id: &str, kept: Option<DeviceRights>| h.lock().unwrap().push((id.to_string(), kept))));
    let more = DeviceRights { files: true, ..DeviceRights::first_pairing() };
    rig.hub.set_rights(&phone.device_id(), more).unwrap();
    assert!(heard.lock().unwrap().is_empty(), "a right given takes nothing");
    rig.hub.set_rights(&phone.device_id(), DeviceRights::first_pairing()).unwrap();
    rig.hub.forget(&phone.device_id()).unwrap();
    assert_eq!(*heard.lock().unwrap(), vec![(phone.device_id(), Some(DeviceRights::first_pairing())), (phone.device_id(), None)]);
}
