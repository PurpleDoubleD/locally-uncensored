use std::sync::Arc;
use std::collections::HashMap;
use std::net::SocketAddr;
use axum::{
    Router,
    body::Body,
    extract::{State as AxumState, Request},
    http::{StatusCode, HeaderMap, header, Method},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{any, get, post},
    Json,
};
use tower_http::cors::CorsLayer;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as TokioMutex;

// ─── Constants ───

const PASSCODE_TTL_SECS: u64 = 300; // 5 minutes
const MAX_FAILED_ATTEMPTS: u32 = 3;
const COOLDOWN_SECS: u64 = 60;

// ─── Shared server state ───

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct RemotePermissions {
    pub filesystem: bool,
    pub downloads: bool,
    pub process_control: bool,
}

impl Default for RemotePermissions {
    fn default() -> Self {
        Self {
            filesystem: false,
            downloads: false,
            process_control: false,
        }
    }
}

#[derive(Clone)]
pub struct PasscodeState {
    pub code: String,
    pub expires_at: u64,
    pub failed_attempts: HashMap<String, (u32, u64)>, // ip -> (count, cooldown_until)
}

#[derive(Clone)]
struct RemoteState {
    jwt_secret: Arc<TokioMutex<String>>,
    passcode: Arc<TokioMutex<PasscodeState>>,
    ollama_port: u16,
    comfy_port: u16,
    permissions: Arc<TokioMutex<RemotePermissions>>,
    connected_devices: Arc<TokioMutex<Vec<ConnectedDevice>>>,
    static_dir: Option<String>,
    tunnel_url: Arc<TokioMutex<Option<String>>>,
}

#[derive(Clone, Serialize, Debug)]
pub struct ConnectedDevice {
    pub id: String,
    pub ip: String,
    pub user_agent: String,
    pub last_seen: u64,
}

// ─── JWT ───

#[derive(Serialize, Deserialize)]
struct Claims {
    sub: String,
    ip: String,
    exp: usize,
}

fn generate_passcode() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    format!("{:06}", rng.gen_range(0..1000000))
}

fn generate_jwt(secret: &str, ip: &str) -> Result<String, String> {
    use jsonwebtoken::{encode, Header, EncodingKey};
    let exp = chrono_now_secs() + (30 * 24 * 60 * 60); // 30 days
    let claims = Claims {
        sub: "remote-user".to_string(),
        ip: ip.to_string(),
        exp: exp as usize,
    };
    encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_bytes()))
        .map_err(|e| e.to_string())
}

fn validate_jwt(secret: &str, token: &str) -> Result<Claims, String> {
    use jsonwebtoken::{decode, Validation, DecodingKey};
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    ).map_err(|e| format!("Invalid token: {}", e))?;
    Ok(data.claims)
}

fn chrono_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// ─── Auth middleware ───

async fn auth_middleware(
    AxumState(state): AxumState<RemoteState>,
    req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path().to_string();

    // Public routes: auth, mobile landing, static assets (HTML/CSS/JS/images)
    // API routes (/api/*, /comfyui/*, /remote-api/*, /ws) require auth
    let is_api = path.starts_with("/api/")
        || path.starts_with("/comfyui/")
        || path == "/ws"
        || (path.starts_with("/remote-api/") && path != "/remote-api/auth" && path != "/remote-api/status");
    if !is_api {
        return next.run(req).await;
    }

    // Extract JWT from: Authorization header, cookie, or query param
    let auth_header = req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let cookie_header = req.headers()
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let cookie_token = cookie_header.split(';')
        .find_map(|c| {
            let c = c.trim();
            if c.starts_with("lu-remote-token=") {
                Some(&c[16..])
            } else {
                None
            }
        })
        .unwrap_or("");

    let query_token = req.uri().query().unwrap_or("").split('&')
        .find(|p| p.starts_with("token="))
        .map(|p| &p[6..])
        .unwrap_or("");

    let token = if auth_header.starts_with("Bearer ") {
        &auth_header[7..]
    } else if !cookie_token.is_empty() {
        cookie_token
    } else if !query_token.is_empty() {
        query_token
    } else {
        return (StatusCode::UNAUTHORIZED, "Missing authorization").into_response();
    };

    let jwt_secret = state.jwt_secret.lock().await;
    match validate_jwt(&jwt_secret, token) {
        Ok(claims) => {
            drop(jwt_secret);
            // Update last_seen for this device
            let mut devices = state.connected_devices.lock().await;
            if let Some(dev) = devices.iter_mut().find(|d| d.id == claims.sub) {
                dev.last_seen = chrono_now_secs();
            }
            next.run(req).await
        }
        Err(_) => (StatusCode::UNAUTHORIZED, "Invalid or expired token").into_response(),
    }
}

// ─── Route handlers ───

#[derive(Deserialize)]
struct AuthRequest {
    passcode: String,
}

#[derive(Serialize)]
struct AuthResponse {
    token: String,
}

async fn handle_auth(
    AxumState(state): AxumState<RemoteState>,
    headers: HeaderMap,
    Json(body): Json<AuthRequest>,
) -> Response {
    let ip = headers.get("x-forwarded-for")
        .or_else(|| headers.get("x-real-ip"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();

    let now = chrono_now_secs();

    // Rate limiting + passcode verification
    {
        let mut pc = state.passcode.lock().await;

        // Rate limit check
        if let Some(&(count, cooldown_until)) = pc.failed_attempts.get(&ip) {
            if count >= MAX_FAILED_ATTEMPTS && now < cooldown_until {
                let remaining = cooldown_until - now;
                return (StatusCode::TOO_MANY_REQUESTS,
                    format!("Too many attempts. Try again in {}s", remaining)
                ).into_response();
            }
            // Reset if cooldown expired
            if count >= MAX_FAILED_ATTEMPTS && now >= cooldown_until {
                pc.failed_attempts.remove(&ip);
            }
        }

        // Auto-regenerate expired passcode
        if now >= pc.expires_at {
            pc.code = generate_passcode();
            pc.expires_at = now + PASSCODE_TTL_SECS;
            println!("[Remote] Passcode auto-regenerated (expired)");
        }

        // Verify passcode
        if body.passcode != pc.code {
            let entry = pc.failed_attempts.entry(ip.clone()).or_insert((0, 0));
            entry.0 += 1;
            if entry.0 >= MAX_FAILED_ATTEMPTS {
                entry.1 = now + COOLDOWN_SECS;
            }
            return (StatusCode::FORBIDDEN, "Invalid code").into_response();
        }

        // Success: clear failed attempts
        pc.failed_attempts.remove(&ip);
    }

    let user_agent = headers.get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();

    let jwt_secret = state.jwt_secret.lock().await;
    match generate_jwt(&jwt_secret, &ip) {
        Ok(token) => {
            drop(jwt_secret);
            // Track connected device
            let device = ConnectedDevice {
                id: format!("dev-{}", chrono_now_secs()),
                ip: ip.clone(),
                user_agent,
                last_seen: chrono_now_secs(),
            };
            state.connected_devices.lock().await.push(device);

            // Set cookie so browser sends token automatically
            let cookie = format!("lu-remote-token={}; Path=/; Max-Age=2592000; SameSite=Strict", token);
            let mut response = Json(AuthResponse { token }).into_response();
            response.headers_mut().insert(
                header::SET_COOKIE,
                cookie.parse().unwrap(),
            );
            response
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

async fn handle_status(AxumState(state): AxumState<RemoteState>) -> Json<serde_json::Value> {
    let devices = state.connected_devices.lock().await;
    Json(serde_json::json!({
        "app": "Locally Uncensored",
        "version": env!("CARGO_PKG_VERSION"),
        "connected_devices": devices.len(),
        "auth_required": true,
    }))
}

// ─── Proxy handlers ───

/// Proxy requests to Ollama (localhost:11434)
async fn proxy_ollama(
    AxumState(state): AxumState<RemoteState>,
    req: Request,
) -> Response {
    let path = req.uri().path().to_string();
    let query = req.uri().query().map(|q| format!("?{}", q)).unwrap_or_default();
    let target = format!("http://localhost:{}{}{}", state.ollama_port, path, query);
    proxy_to_target(&target, req).await
}

/// Proxy requests to ComfyUI (localhost:comfy_port)
async fn proxy_comfyui(
    AxumState(state): AxumState<RemoteState>,
    req: Request,
) -> Response {
    let path = req.uri().path().strip_prefix("/comfyui").unwrap_or(req.uri().path());
    let query = req.uri().query().map(|q| format!("?{}", q)).unwrap_or_default();
    let target = format!("http://localhost:{}{}{}", state.comfy_port, path, query);
    proxy_to_target(&target, req).await
}

async fn proxy_to_target(target: &str, req: Request) -> Response {
    let method = req.method().clone();
    let headers = req.headers().clone();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .unwrap();

    let mut builder = match method {
        Method::POST => client.post(target),
        Method::PUT => client.put(target),
        Method::DELETE => client.delete(target),
        _ => client.get(target),
    };

    // Forward content-type
    if let Some(ct) = headers.get(header::CONTENT_TYPE) {
        builder = builder.header(header::CONTENT_TYPE, ct);
    }

    // Forward body
    let body_bytes = axum::body::to_bytes(req.into_body(), 100 * 1024 * 1024)
        .await
        .unwrap_or_default();
    if !body_bytes.is_empty() {
        builder = builder.body(body_bytes.to_vec());
    }

    match builder.send().await {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let resp_ct = resp.headers().get(header::CONTENT_TYPE).cloned();
            match resp.bytes().await {
                Ok(bytes) => {
                    let mut response = Response::builder().status(status);
                    if let Some(ct) = resp_ct {
                        response = response.header(header::CONTENT_TYPE, ct);
                    }
                    response.body(Body::from(bytes.to_vec())).unwrap_or_else(|_| {
                        (StatusCode::INTERNAL_SERVER_ERROR, "Response build error").into_response()
                    })
                }
                Err(e) => (StatusCode::BAD_GATEWAY, format!("Read error: {}", e)).into_response(),
            }
        }
        Err(e) => (StatusCode::BAD_GATEWAY, format!("Proxy error: {}", e)).into_response(),
    }
}

// ─── WebSocket proxy (ComfyUI progress) ───

async fn proxy_comfyui_ws(
    AxumState(state): AxumState<RemoteState>,
    ws: axum::extract::WebSocketUpgrade,
) -> Response {
    let comfy_port = state.comfy_port;
    ws.on_upgrade(move |client_socket| async move {
        use futures_util::{SinkExt, StreamExt};

        let ws_url = format!("ws://localhost:{}/ws", comfy_port);
        let upstream = match tokio_tungstenite::connect_async(&ws_url).await {
            Ok((stream, _)) => stream,
            Err(e) => {
                eprintln!("[Remote WS] Failed to connect to ComfyUI: {}", e);
                return;
            }
        };

        let (mut upstream_write, mut upstream_read) = upstream.split();
        let (mut client_write, mut client_read) = client_socket.split();

        // Forward: client -> ComfyUI
        let client_to_upstream = tokio::spawn(async move {
            while let Some(Ok(msg)) = client_read.next().await {
                let tung_msg = match msg {
                    axum::extract::ws::Message::Text(t) => tokio_tungstenite::tungstenite::Message::Text(t.to_string().into()),
                    axum::extract::ws::Message::Binary(b) => tokio_tungstenite::tungstenite::Message::Binary(b),
                    axum::extract::ws::Message::Ping(p) => tokio_tungstenite::tungstenite::Message::Ping(p),
                    axum::extract::ws::Message::Pong(p) => tokio_tungstenite::tungstenite::Message::Pong(p),
                    axum::extract::ws::Message::Close(_) => return,
                };
                if upstream_write.send(tung_msg).await.is_err() { return; }
            }
        });

        // Forward: ComfyUI -> client
        let upstream_to_client = tokio::spawn(async move {
            while let Some(Ok(msg)) = upstream_read.next().await {
                let axum_msg = match msg {
                    tokio_tungstenite::tungstenite::Message::Text(t) => axum::extract::ws::Message::Text(t.to_string().into()),
                    tokio_tungstenite::tungstenite::Message::Binary(b) => axum::extract::ws::Message::Binary(b),
                    tokio_tungstenite::tungstenite::Message::Ping(p) => axum::extract::ws::Message::Ping(p),
                    tokio_tungstenite::tungstenite::Message::Pong(p) => axum::extract::ws::Message::Pong(p),
                    tokio_tungstenite::tungstenite::Message::Close(_) => return,
                    _ => continue,
                };
                if client_write.send(axum_msg).await.is_err() { return; }
            }
        });

        // Wait for either direction to finish
        tokio::select! {
            _ = client_to_upstream => {},
            _ = upstream_to_client => {},
        }
    })
}

// ─── Mobile landing page ───

async fn mobile_landing() -> Html<String> {
    Html(r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Locally Uncensored</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e5e5e5;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
.logo{width:56px;height:56px;opacity:.25;filter:invert(1);margin-bottom:12px}
h1{font-size:1.1rem;font-weight:600;color:#a3a3a3;margin-bottom:4px;letter-spacing:.5px}
.sub{font-size:.7rem;color:#525252;margin-bottom:40px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;width:100%;max-width:320px;margin-bottom:24px}
.btn{display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px 12px;border-radius:12px;background:#171717;border:1px solid #262626;text-decoration:none;color:#d4d4d4;font-size:.8rem;font-weight:500;transition:all .15s}
.btn:active{background:#262626;transform:scale(.97)}
.btn svg{width:24px;height:24px;stroke:currentColor;fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.btn.chat{grid-column:span 2;flex-direction:row;gap:12px;padding:16px 20px}
.btn.chat svg{width:20px;height:20px}
.full{display:block;text-align:center;font-size:.65rem;color:#525252;text-decoration:underline;text-underline-offset:2px}
</style>
</head>
<body>
<img src="/LU-monogram-bw.png" alt="" class="logo">
<h1>LUncensored</h1>
<p class="sub">Generate anything. Locally. Uncensored.</p>
<div class="grid">
  <a href="/" class="btn chat" id="chat-btn">
    <svg><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
    Chat
  </a>
  <a href="/?view=create&tab=image" class="btn">
    <svg><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
    Image
  </a>
  <a href="/?view=create&tab=video" class="btn">
    <svg><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
    Video
  </a>
</div>
<a href="/" class="full">Open full app</a>
<script>
// Check auth on load
const token = localStorage.getItem('lu-remote-token');
if (!token) {
  document.body.innerHTML = `
    <img src="/LU-monogram-bw.png" alt="" class="logo" style="width:56px;height:56px;opacity:.25;filter:invert(1);margin-bottom:12px">
    <h1 style="font-size:1.1rem;font-weight:600;color:#a3a3a3;margin-bottom:20px">Connect</h1>
    <form id="auth-form" style="width:100%;max-width:300px;display:flex;flex-direction:column;gap:12px">
      <input id="phrase" type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="6-digit code" autocomplete="off" autocapitalize="off"
        style="width:100%;padding:14px 16px;border-radius:10px;background:#171717;border:1px solid #333;color:#e5e5e5;font-size:1.6rem;outline:none;text-align:center;letter-spacing:8px;font-family:monospace">
      <button type="submit" style="padding:12px;border-radius:10px;background:#3b82f6;color:white;border:none;font-size:.85rem;font-weight:500;cursor:pointer">Connect</button>
      <p id="error" style="color:#ef4444;font-size:.7rem;text-align:center;display:none"></p>
    </form>`;
  document.getElementById('auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const code = document.getElementById('phrase').value.trim();
    try {
      const res = await fetch('/remote-api/auth', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({passcode: code})
      });
      if (res.ok) {
        const {token} = await res.json();
        localStorage.setItem('lu-remote-token', token);
        location.reload();
      } else {
        const errEl = document.getElementById('error');
        const text = await res.text();
        errEl.textContent = res.status === 429 ? text : 'Invalid code';
        errEl.style.display = 'block';
      }
    } catch(ex) {
      const errEl = document.getElementById('error');
      errEl.textContent = 'Connection failed';
      errEl.style.display = 'block';
    }
  };
}
</script>
</body>
</html>"#.to_string())
}

// ─── QR Code generation ───

#[derive(Serialize)]
struct QrResponse {
    qr_png_base64: String,
    url: String,
    passcode: String,
}

async fn handle_qr(AxumState(state): AxumState<RemoteState>) -> Json<QrResponse> {
    // Use tunnel URL if active, otherwise LAN
    let tunnel_url = state.tunnel_url.lock().await.clone();
    let url = if let Some(ref turl) = tunnel_url {
        format!("{}/mobile", turl)
    } else {
        let lan_ip = local_ip_address::local_ip()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = 11435u16;
        format!("http://{}:{}/mobile", lan_ip, port)
    };

    // Generate QR code as PNG image
    let qr = qrcode::QrCode::new(url.as_bytes()).unwrap();
    let qr_image = qr.render::<image::Luma<u8>>()
        .quiet_zone(true)
        .min_dimensions(256, 256)
        .build();
    let mut png_bytes: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut png_bytes);
    image::DynamicImage::ImageLuma8(qr_image).write_to(&mut cursor, image::ImageFormat::Png).unwrap_or(());

    let qr_base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png_bytes);

    let pc = state.passcode.lock().await;
    Json(QrResponse {
        qr_png_base64: qr_base64,
        url,
        passcode: pc.code.clone(),
    })
}

// ─── Devices ───

async fn handle_devices(AxumState(state): AxumState<RemoteState>) -> Json<Vec<ConnectedDevice>> {
    let devices = state.connected_devices.lock().await;
    Json(devices.clone())
}

#[derive(Deserialize)]
struct DisconnectRequest {
    id: String,
}

async fn handle_disconnect(
    AxumState(state): AxumState<RemoteState>,
    Json(body): Json<DisconnectRequest>,
) -> StatusCode {
    let mut devices = state.connected_devices.lock().await;
    devices.retain(|d| d.id != body.id);
    StatusCode::OK
}

// ─── Permissions ───

async fn handle_get_permissions(AxumState(state): AxumState<RemoteState>) -> Json<RemotePermissions> {
    let perms = state.permissions.lock().await;
    Json(perms.clone())
}

async fn handle_set_permissions(
    AxumState(state): AxumState<RemoteState>,
    Json(body): Json<RemotePermissions>,
) -> StatusCode {
    let mut perms = state.permissions.lock().await;
    *perms = body;
    StatusCode::OK
}

// ─── Server lifecycle (Tauri commands) ───

use tokio::task::JoinHandle;

/// Stored in AppState — holds the running remote server handle
pub struct RemoteServer {
    pub handle: Option<JoinHandle<()>>,
    pub port: u16,
    pub jwt_secret: Arc<TokioMutex<String>>,
    pub passcode: Arc<TokioMutex<PasscodeState>>,
    pub permissions: Arc<TokioMutex<RemotePermissions>>,
    pub connected_devices: Arc<TokioMutex<Vec<ConnectedDevice>>>,
    pub tunnel_pid: Option<u32>,
    pub tunnel_url: Arc<TokioMutex<Option<String>>>,
}

impl RemoteServer {
    pub fn new() -> Self {
        Self {
            handle: None,
            port: 11435,
            jwt_secret: Arc::new(TokioMutex::new(String::new())),
            passcode: Arc::new(TokioMutex::new(PasscodeState {
                code: String::new(),
                expires_at: 0,
                failed_attempts: HashMap::new(),
            })),
            permissions: Arc::new(TokioMutex::new(RemotePermissions::default())),
            connected_devices: Arc::new(TokioMutex::new(Vec::new())),
            tunnel_pid: None,
            tunnel_url: Arc::new(TokioMutex::new(None)),
        }
    }
}

#[tauri::command]
pub async fn start_remote_server(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<serde_json::Value, String> {
    // Clone Arcs from std::sync::Mutex, then drop it before any .await
    let (jwt_secret_arc, passcode_arc, permissions_arc, devices_arc, tunnel_url_arc, port, comfy_port, static_dir) = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        if remote.handle.is_some() {
            return Err("Remote server already running".into());
        }
        let comfy_port = *state.comfy_port.lock().unwrap();

        // Resolve the static dir (React build output)
        let static_dir = {
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()));
            let candidates = [
                exe_dir.as_ref().map(|p| p.join("../../../dist")),
                exe_dir.as_ref().map(|p| p.join("dist")),
                exe_dir.as_ref().map(|p| p.join("../dist")),
                Some(std::path::PathBuf::from("dist")),
            ];
            candidates.into_iter()
                .flatten()
                .find(|p| p.join("index.html").exists())
                .map(|p| p.to_string_lossy().to_string())
        };

        (
            remote.jwt_secret.clone(),
            remote.passcode.clone(),
            remote.permissions.clone(),
            remote.connected_devices.clone(),
            remote.tunnel_url.clone(),
            remote.port,
            comfy_port,
            static_dir,
        )
    }; // std::sync::MutexGuard dropped here

    if let Some(ref dir) = static_dir {
        println!("[Remote] Serving static files from: {}", dir);
    } else {
        println!("[Remote] Warning: No dist/ directory found, static file serving disabled");
    }

    // Generate new passcode + JWT secret
    let passcode = generate_passcode();
    let jwt_secret_str = format!("lu-{}-{}", chrono_now_secs(), rand::random::<u64>());
    let now = chrono_now_secs();

    // Update shared state (safe to .await now, no std::sync::MutexGuard held)
    {
        let mut jwt = jwt_secret_arc.lock().await;
        *jwt = jwt_secret_str;
    }
    {
        let mut pc = passcode_arc.lock().await;
        pc.code = passcode.clone();
        pc.expires_at = now + PASSCODE_TTL_SECS;
        pc.failed_attempts.clear();
    }

    let server_state = RemoteState {
        jwt_secret: jwt_secret_arc,
        passcode: passcode_arc,
        ollama_port: 11434,
        comfy_port,
        permissions: permissions_arc,
        connected_devices: devices_arc,
        static_dir,
        tunnel_url: tunnel_url_arc,
    };

    let handle = tokio::spawn(async move {
        let app = build_router(server_state);
        let addr = SocketAddr::from(([0, 0, 0, 0], port));
        println!("[Remote] Server starting on {}", addr);

        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        axum::serve(listener, app).await.unwrap();
    });

    // Store handle back
    {
        let mut remote = state.remote.lock().map_err(|e| e.to_string())?;
        remote.handle = Some(handle);
    }

    let lan_ip = local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string());

    Ok(serde_json::json!({
        "port": port,
        "passcode": passcode,
        "passcodeExpiresAt": now + PASSCODE_TTL_SECS,
        "lanUrl": format!("http://{}:{}", lan_ip, port),
        "mobileUrl": format!("http://{}:{}/mobile", lan_ip, port),
    }))
}

#[tauri::command]
pub async fn stop_remote_server(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let (handle, tunnel_pid, tunnel_url_arc) = {
        let mut remote = state.remote.lock().map_err(|e| e.to_string())?;
        (remote.handle.take(), remote.tunnel_pid.take(), remote.tunnel_url.clone())
    };

    // Stop tunnel if running
    if let Some(pid) = tunnel_pid {
        if cfg!(windows) {
            let _ = std::process::Command::new("taskkill")
                .args(["/pid", &pid.to_string(), "/T", "/F"])
                .output();
        } else {
            let _ = std::process::Command::new("kill").arg(pid.to_string()).output();
        }
        println!("[Tunnel] Stopped");
    }
    {
        let mut turl = tunnel_url_arc.lock().await;
        *turl = None;
    }

    // Stop server
    if let Some(handle) = handle {
        handle.abort();
        println!("[Remote] Server stopped");
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_server_status(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<serde_json::Value, String> {
    let (running, port, passcode_arc, tunnel_url_arc, tunnel_pid) = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        (
            remote.handle.is_some(),
            remote.port,
            remote.passcode.clone(),
            remote.tunnel_url.clone(),
            remote.tunnel_pid,
        )
    };

    let now = chrono_now_secs();
    let (passcode, expires_at) = {
        let mut pc = passcode_arc.lock().await;
        // Auto-regenerate expired passcode
        if running && !pc.code.is_empty() && now >= pc.expires_at {
            pc.code = generate_passcode();
            pc.expires_at = now + PASSCODE_TTL_SECS;
            println!("[Remote] Passcode auto-regenerated (expired)");
        }
        (pc.code.clone(), pc.expires_at)
    };

    let tunnel_url = tunnel_url_arc.lock().await;
    let lan_ip = local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string());

    Ok(serde_json::json!({
        "running": running,
        "port": port,
        "passcode": if running { passcode } else { String::new() },
        "passcodeExpiresAt": if running { expires_at } else { 0 },
        "lanUrl": if running { format!("http://{}:{}", lan_ip, port) } else { String::new() },
        "mobileUrl": if running { format!("http://{}:{}/mobile", lan_ip, port) } else { String::new() },
        "tunnelActive": tunnel_pid.is_some(),
        "tunnelUrl": tunnel_url.clone().unwrap_or_default(),
    }))
}

#[tauri::command]
pub async fn regenerate_remote_token(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<String, String> {
    let (jwt_arc, passcode_arc, devices_arc) = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        (remote.jwt_secret.clone(), remote.passcode.clone(), remote.connected_devices.clone())
    };

    let new_passcode = generate_passcode();
    let new_secret = format!("lu-{}-{}", chrono_now_secs(), rand::random::<u64>());

    {
        let mut jwt = jwt_arc.lock().await;
        *jwt = new_secret;
    }
    {
        let mut pc = passcode_arc.lock().await;
        pc.code = new_passcode.clone();
        pc.expires_at = chrono_now_secs() + PASSCODE_TTL_SECS;
        pc.failed_attempts.clear();
    }
    {
        devices_arc.lock().await.clear();
    }

    Ok(new_passcode)
}

#[tauri::command]
pub async fn remote_qr_code(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<serde_json::Value, String> {
    let (running, port, passcode_arc, tunnel_url_arc) = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        (remote.handle.is_some(), remote.port, remote.passcode.clone(), remote.tunnel_url.clone())
    };

    if !running {
        return Err("Remote server not running".into());
    }

    // Use tunnel URL if active, otherwise LAN
    let tunnel_url = tunnel_url_arc.lock().await;
    let url = if let Some(ref turl) = *tunnel_url {
        format!("{}/mobile", turl)
    } else {
        let lan_ip = local_ip_address::local_ip()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|_| "127.0.0.1".to_string());
        format!("http://{}:{}/mobile", lan_ip, port)
    };
    drop(tunnel_url);

    let qr = qrcode::QrCode::new(url.as_bytes()).map_err(|e| e.to_string())?;
    let qr_image = qr.render::<image::Luma<u8>>()
        .quiet_zone(true)
        .min_dimensions(256, 256)
        .build();

    let mut png_bytes: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut png_bytes);
    image::DynamicImage::ImageLuma8(qr_image).write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;

    let qr_base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png_bytes);

    let pc = passcode_arc.lock().await;
    Ok(serde_json::json!({
        "qr_png_base64": qr_base64,
        "url": url,
        "passcode": pc.code,
    }))
}

#[tauri::command]
pub async fn remote_connected_devices(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Vec<ConnectedDevice>, String> {
    let devices_arc = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        remote.connected_devices.clone()
    }; // MutexGuard dropped here
    let devices = devices_arc.lock().await;
    Ok(devices.clone())
}

#[tauri::command]
pub async fn set_remote_permissions(
    state: tauri::State<'_, crate::state::AppState>,
    permissions: RemotePermissions,
) -> Result<(), String> {
    let perms_arc = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        remote.permissions.clone()
    }; // MutexGuard dropped here
    let mut perms = perms_arc.lock().await;
    *perms = permissions;
    Ok(())
}

// ─── Cloudflare Tunnel ───

/// Download cloudflared binary if not present, return its path
fn get_cloudflared_path() -> std::path::PathBuf {
    let dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("locally-uncensored")
        .join("bin");
    let exe_name = if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" };
    dir.join(exe_name)
}

#[tauri::command]
pub async fn start_tunnel(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<String, String> {
    let (port, tunnel_url_arc) = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        if remote.handle.is_none() {
            return Err("Remote server not running. Start it first.".into());
        }
        (remote.port, remote.tunnel_url.clone())
    };

    let cf_path = get_cloudflared_path();

    // Download cloudflared if not present
    if !cf_path.exists() {
        let dir = cf_path.parent().unwrap();
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir: {}", e))?;

        let download_url = if cfg!(windows) {
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
        } else if cfg!(target_os = "linux") {
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
        } else {
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz"
        };

        println!("[Tunnel] Downloading cloudflared from {}", download_url);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?;

        let resp = client.get(download_url).send().await.map_err(|e| format!("Download failed: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("Download HTTP {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        std::fs::write(&cf_path, &bytes).map_err(|e| format!("write: {}", e))?;

        // Make executable on Unix
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&cf_path, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("chmod: {}", e))?;
        }
        println!("[Tunnel] Downloaded cloudflared to {:?}", cf_path);
    }

    // Start cloudflared tunnel
    let child = std::process::Command::new(&cf_path)
        .args(["tunnel", "--url", &format!("http://localhost:{}", port)])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start cloudflared: {}", e))?;

    let pid = child.id();
    println!("[Tunnel] cloudflared started (PID {}), tunneling localhost:{}", pid, port);

    // Read stderr to find the tunnel URL (cloudflared prints it there)
    let stderr = child.stderr.unwrap();
    let captured_url = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let url_clone = captured_url.clone();

    // Spawn thread to read stderr and capture the URL
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(line) = line {
                println!("[Tunnel] {}", line);
                // cloudflared prints: "... https://xxx.trycloudflare.com ..."
                if let Some(start) = line.find("https://") {
                    let url_part = &line[start..];
                    if let Some(end) = url_part.find(|c: char| c.is_whitespace() || c == '|') {
                        let url = &url_part[..end];
                        if url.contains("trycloudflare.com") || url.contains("cloudflare") {
                            *url_clone.lock().unwrap() = url.to_string();
                        }
                    } else if url_part.contains("trycloudflare.com") {
                        *url_clone.lock().unwrap() = url_part.trim().to_string();
                    }
                }
            }
        }
    });

    // Wait up to 15 seconds for the tunnel URL to appear (non-blocking)
    let mut url = String::new();
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        url = captured_url.lock().unwrap().clone();
        if !url.is_empty() { break; }
    }

    // Store tunnel PID
    {
        let mut remote = state.remote.lock().map_err(|e| e.to_string())?;
        remote.tunnel_pid = Some(pid);
    }

    // Store tunnel URL in shared state (so axum handlers see it)
    {
        let mut turl = tunnel_url_arc.lock().await;
        *turl = if url.is_empty() { None } else { Some(url.clone()) };
    }

    if url.is_empty() {
        Ok("Tunnel started but URL not yet available. Check logs.".to_string())
    } else {
        Ok(url)
    }
}

#[tauri::command]
pub async fn stop_tunnel(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let (pid, tunnel_url_arc) = {
        let mut remote = state.remote.lock().map_err(|e| e.to_string())?;
        (remote.tunnel_pid.take(), remote.tunnel_url.clone())
    };

    if let Some(pid) = pid {
        if cfg!(windows) {
            let _ = std::process::Command::new("taskkill")
                .args(["/pid", &pid.to_string(), "/T", "/F"])
                .output();
        } else {
            let _ = std::process::Command::new("kill")
                .arg(pid.to_string())
                .output();
        }
        println!("[Tunnel] Stopped (PID {})", pid);
    }

    {
        let mut turl = tunnel_url_arc.lock().await;
        *turl = None;
    }

    Ok(())
}

#[tauri::command]
pub async fn tunnel_status(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<serde_json::Value, String> {
    let (pid, tunnel_url_arc) = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        (remote.tunnel_pid, remote.tunnel_url.clone())
    };
    let turl = tunnel_url_arc.lock().await;
    Ok(serde_json::json!({
        "active": pid.is_some(),
        "url": turl.clone(),
    }))
}

// ─── Router builder ───

fn build_router(state: RemoteState) -> Router {
    let cors = CorsLayer::permissive();

    // API routes (behind auth)
    let api_routes = Router::new()
        .route("/remote-api/auth", post(handle_auth))
        .route("/remote-api/status", get(handle_status))
        .route("/remote-api/qr", get(handle_qr))
        .route("/remote-api/devices", get(handle_devices))
        .route("/remote-api/disconnect", post(handle_disconnect))
        .route("/remote-api/permissions", get(handle_get_permissions))
        .route("/remote-api/permissions", post(handle_set_permissions));

    // Proxy routes
    let proxy_routes = Router::new()
        .route("/api/{*rest}", any(proxy_ollama))
        .route("/comfyui/{*rest}", any(proxy_comfyui))
        .route("/ws", get(proxy_comfyui_ws));

    // Mobile landing page
    let mobile = Router::new()
        .route("/mobile", get(mobile_landing));

    // Combine all routes
    let mut app = Router::new()
        .merge(api_routes)
        .merge(proxy_routes)
        .merge(mobile);

    // Static file serving (React SPA) with index.html fallback
    if let Some(ref dir) = state.static_dir {
        let serve_dir = tower_http::services::ServeDir::new(dir)
            .not_found_service(tower_http::services::ServeFile::new(
                format!("{}/index.html", dir),
            ));
        app = app.fallback_service(serve_dir);
    }

    app.layer(middleware::from_fn_with_state(state.clone(), auth_middleware))
        .layer(cors)
        .with_state(state)
}
