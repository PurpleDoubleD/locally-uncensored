use std::sync::Arc;
use std::collections::HashMap;
use std::net::SocketAddr;
use axum::{
    Router,
    body::Body,
    extract::{State as AxumState, Request, ConnectInfo},
    http::{StatusCode, HeaderMap, header, Method},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{any, get, post},
    Json,
};
use tower_http::cors::CorsLayer;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as TokioMutex;
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ─── Constants ───

const PASSCODE_TTL_SECS: u64 = 300; // 5 minutes — what the user types on the phone
const JWT_TTL_SECS: u64 = 60 * 60;  // 1 hour — how long an authenticated session lasts
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
            filesystem: true,
            downloads: true,
            process_control: true,
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
    tunnel_url: Arc<TokioMutex<Option<String>>>,
    dispatched_model: Arc<TokioMutex<String>>,
    dispatched_system_prompt: Arc<TokioMutex<String>>,
    app_handle: AppHandle,
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

fn generate_jwt(secret: &str, ip: &str, sub: &str) -> Result<String, String> {
    use jsonwebtoken::{encode, Header, EncodingKey};
    let exp = chrono_now_secs() + JWT_TTL_SECS;
    let claims = Claims {
        sub: sub.to_string(),
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

/// Extract the best-guess client IP: prefer reverse-proxy headers (Cloudflare
/// Tunnel sets these), fall back to the direct connection address on LAN.
///
/// Bug #3: on LAN there is no reverse proxy, so both XFF and X-Real-IP are
/// empty and every client collapsed into the "unknown" bucket — sharing one
/// rate-limit window and appearing as the same row in Connected Devices.
fn client_ip(headers: &HeaderMap, socket: Option<SocketAddr>) -> String {
    if let Some(ip) = headers.get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        return ip.to_string()
    }
    if let Some(ip) = headers.get("x-real-ip")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return ip.to_string()
    }
    if let Some(addr) = socket {
        return addr.ip().to_string()
    }
    "unknown".to_string()
}

// ─── Auth middleware ───

async fn auth_middleware(
    AxumState(state): AxumState<RemoteState>,
    req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path().to_string();

    // Public routes:
    //   • /mobile                       — the self-contained landing page
    //   • /LU-monogram-white.png         — the single branding asset
    //   • /remote-api/auth               — where the client trades a passcode for a JWT
    //   • /remote-api/status             — minimal liveness ping {status:"ok"}
    //   • /                              — 302 redirect to /mobile
    //
    // Everything else — including /remote-api/status/full, /remote-api/*,
    // /api/*, /comfyui/*, /ws — requires a valid JWT.
    let requires_auth = path.starts_with("/api/")
        || path.starts_with("/comfyui/")
        || path == "/ws"
        || (path.starts_with("/remote-api/")
            && path != "/remote-api/auth"
            && path != "/remote-api/status");
    if !requires_auth {
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
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<AuthRequest>,
) -> Response {
    let ip = client_ip(&headers, Some(addr));

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

    // Bug #11: a plain second-precision timestamp collides when two phones
    // authenticate in the same second. Add a random suffix so every device
    // has a stable, unique identifier.
    let device_id = format!("dev-{}-{:x}", chrono_now_secs(), rand::random::<u64>());

    let jwt_secret = state.jwt_secret.lock().await;
    match generate_jwt(&jwt_secret, &ip, &device_id) {
        Ok(token) => {
            drop(jwt_secret);
            // Dedup by IP: if this IP is already registered (reauth, refresh,
            // regenerated passcode), update the existing entry in place
            // instead of stacking a second ghost device. Also auto-prune
            // entries that have been silent for more than the JWT TTL
            // (the client's token would be invalid anyway).
            let now = chrono_now_secs();
            let mut devices = state.connected_devices.lock().await;
            devices.retain(|d| now.saturating_sub(d.last_seen) < JWT_TTL_SECS);
            if let Some(existing) = devices.iter_mut().find(|d| d.ip == ip) {
                existing.id = device_id.clone();
                existing.user_agent = user_agent.clone();
                existing.last_seen = now;
            } else {
                devices.push(ConnectedDevice {
                    id: device_id,
                    ip: ip.clone(),
                    user_agent,
                    last_seen: now,
                });
            }
            drop(devices);

            // Bug #13: cookie lifetime must match the JWT TTL. Otherwise the
            // browser keeps sending a stale cookie for up to 30 days while
            // the JWT inside expired hours ago.
            let cookie = format!(
                "lu-remote-token={}; Path=/; Max-Age={}; SameSite=Strict",
                token, JWT_TTL_SECS
            );
            let mut response = Json(AuthResponse { token }).into_response();
            // Defensive parse: a malformed cookie value would otherwise panic
            // → abort the entire process under `panic = "abort"`.
            if let Ok(cookie_hv) = cookie.parse() {
                response.headers_mut().insert(header::SET_COOKIE, cookie_hv);
            }
            response
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// Public endpoint that returns a minimal liveness ping.
/// Bug #4: we previously leaked `version`, `connected_devices`, and
/// `auth_required` unauthenticated, which is a nice fingerprinting handshake
/// for anyone scanning the tunnel URL. Version and device count are now
/// only visible to authenticated clients via `/remote-api/status/full`.
async fn handle_status() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

/// Authenticated status — version + connected-device count for the desktop UI
/// (and any authenticated client that cares). Gated by `auth_middleware`
/// because it lives under `/remote-api/` without being in the public list.
async fn handle_status_full(AxumState(state): AxumState<RemoteState>) -> Json<serde_json::Value> {
    let devices = state.connected_devices.lock().await;
    Json(serde_json::json!({
        "app": "Locally Uncensored",
        "version": env!("CARGO_PKG_VERSION"),
        "connected_devices": devices.len(),
        "auth_required": true,
    }))
}

// ─── Mobile Agent — HTTP bridge to the Tauri agent tool commands ───

#[derive(Deserialize)]
struct AgentToolPayload {
    tool: String,
    #[serde(default)]
    args: serde_json::Value,
    /// Per-chat workspace slug. When provided, all file tools resolve
    /// relative paths against `~/agent-workspace/<chat_id>/`. Missing /
    /// empty falls back to `default` so legacy clients still work.
    #[serde(default, rename = "chatId", alias = "chat_id")]
    chat_id: Option<String>,
}

/// Run a single agent tool on behalf of an authenticated mobile client.
/// Mirrors `executeTool` in `src/api/agents.ts`. Permission-gated so a
/// remote client cannot reach into the desktop without explicit toggle:
///   - file_read / file_write   → requires `filesystem`
///   - code_execute             → requires `filesystem`
///   - image_generate           → requires `process_control`
///   - web_search               → no permission required
///
/// Bug fix (mobile agent HTTP 500): all tool failures (missing arg,
/// permission denied, underlying tool error) are returned as HTTP 200
/// with `{ "error": "<msg>" }`. The mobile JS treats a 200-with-error
/// as a normal observation that the model can read and recover from,
/// instead of bubbling a scary HTTP 500 back up to the chat. The Rust
/// server still logs the failure to stderr so devs can diagnose.
async fn handle_agent_tool(
    AxumState(state): AxumState<RemoteState>,
    Json(body): Json<AgentToolPayload>,
) -> Response {
    use tauri::Manager;
    let tool_name = body.tool.clone();

    let app_state = match state.app_handle.try_state::<crate::state::AppState>() {
        Some(s) => s,
        None => {
            eprintln!("[Remote agent] AppState not registered — cannot dispatch tool {}", tool_name);
            return graceful_error("AppState unavailable on the desktop side.");
        }
    };

    let perms = state.permissions.lock().await.clone();

    // Permission gate up-front. Returns a graceful 200 + {error,permission}
    // so the mobile UI can render a single-line hint instead of "HTTP 403".
    let needs = match tool_name.as_str() {
        "file_read" | "file_write" | "code_execute" | "file_list" | "file_search" | "shell_execute" | "screenshot"
            => Some(("filesystem", perms.filesystem)),
        "image_generate"
            => Some(("process_control", perms.process_control)),
        _ => None,
    };
    if let Some((perm, on)) = needs {
        if !on {
            return graceful_perm_error(&tool_name, perm);
        }
    }

    // Per-chat workspace slug — threaded into every file tool so each
    // mobile chat gets its own isolated `~/agent-workspace/<slug>/` and
    // agents running in different chats can't clobber each other.
    let chat_id = body.chat_id.clone();

    let result: Result<serde_json::Value, String> = match tool_name.as_str() {
        "file_read" => {
            let path = body.args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if path.is_empty() { Err("file_read needs a non-empty `path` argument.".into()) }
            else { crate::commands::agent::file_read(path, chat_id.clone()) }
        }
        "file_write" => {
            let path = body.args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let content = body.args.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if path.is_empty() { Err("file_write needs a non-empty `path` argument.".into()) }
            else { crate::commands::agent::file_write(path, content, chat_id.clone()) }
        }
        "code_execute" => {
            let code = body.args.get("code").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let timeout = body.args.get("timeout").and_then(|v| v.as_u64());
            if code.is_empty() { Err("code_execute needs a non-empty `code` argument.".into()) }
            else { crate::commands::agent::execute_code(code, timeout, chat_id.clone(), app_state) }
        }
        "web_search" => {
            let query = body.args.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let count = body.args.get("maxResults")
                .or_else(|| body.args.get("count"))
                .and_then(|v| v.as_u64())
                .map(|n| n as usize);
            if query.is_empty() { Err("web_search needs a non-empty `query` argument.".into()) }
            else { crate::commands::search::web_search(query, count, app_state).await }
        }
        "web_fetch" => {
            let url = body.args.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if url.is_empty() { Err("web_fetch needs a non-empty `url` argument.".into()) }
            else { crate::commands::search::web_fetch(url).await }
        }
        "file_list" => {
            let path = body.args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let recursive = body.args.get("recursive").and_then(|v| v.as_bool());
            let pattern = body.args.get("pattern").and_then(|v| v.as_str()).map(String::from);
            if path.is_empty() { Err("file_list needs a non-empty `path` argument.".into()) }
            else { crate::commands::filesystem::fs_list(path, recursive, pattern, chat_id.clone()) }
        }
        "file_search" => {
            let path = body.args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let pattern = body.args.get("query")
                .or_else(|| body.args.get("pattern"))
                .and_then(|v| v.as_str()).unwrap_or("").to_string();
            // Bug: AGENT_TOOLS sends `maxResults` (camelCase); also accept
            // snake-case for older clients.
            let max = body.args.get("maxResults")
                .or_else(|| body.args.get("max_results"))
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            if path.is_empty() || pattern.is_empty() {
                Err("file_search needs both `path` and `pattern` arguments.".into())
            } else {
                crate::commands::filesystem::fs_search(path, pattern, max, chat_id.clone())
            }
        }
        "shell_execute" => {
            let command = body.args.get("command").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if command.is_empty() { Err("shell_execute needs a non-empty `command` argument.".into()) }
            else {
                let cwd = body.args.get("cwd").and_then(|v| v.as_str()).map(String::from);
                let timeout = body.args.get("timeout").and_then(|v| v.as_u64());
                let shell = body.args.get("shell").and_then(|v| v.as_str()).map(String::from);
                crate::commands::shell::shell_execute(command, None, cwd, timeout, shell, chat_id.clone()).await
            }
        }
        "system_info" => crate::commands::system::system_info(),
        "process_list" => crate::commands::system::process_list(),
        "screenshot" => crate::commands::system::screenshot(),
        "get_current_time" => crate::commands::system::get_current_time(),
        "image_generate" => {
            // Image generation requires the desktop Agent path — too much
            // plumbing for the remote bridge. Return a clean structured
            // observation rather than HTTP 500 so the mobile UI shows it
            // as a single line, not a red HTTP error.
            Ok(serde_json::json!({
                "error": "image_generate is only available on the desktop app for now. Open the Create tab there."
            }))
        }
        other => Err(format!("Unknown tool: {}", other)),
    };

    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => {
            // Log so a dev tailing the desktop console sees what failed.
            // The mobile gets a graceful 200+{error} so the agent loop
            // observation reads cleanly ("Error: file not found …").
            eprintln!("[Remote agent] tool `{}` failed: {}", tool_name, e);
            graceful_error(&e)
        }
    }
}

/// Wrap a tool failure as a 200-OK JSON payload so the mobile parser
/// doesn't treat it as an HTTP transport error. Mobile JS reads
/// `{error}` and surfaces it as a normal observation.
fn graceful_error(msg: &str) -> Response {
    let body = serde_json::json!({ "error": msg });
    Json(body).into_response()
}

/// Permission-denied responder: still 200, but flagged so the mobile UI
/// can render a 1-tap "Open Settings → Permissions" hint instead of a
/// generic error.
fn graceful_perm_error(tool: &str, permission: &str) -> Response {
    let msg = format!(
        "Tool `{}` is gated behind the `{}` permission. Open Settings (gear icon) and toggle it on.",
        tool, permission
    );
    eprintln!("[Remote agent] tool `{}` blocked: missing permission `{}`", tool, permission);
    let body = serde_json::json!({
        "error": msg,
        "permission": permission,
        "needs_permission": true,
    });
    Json(body).into_response()
}

// ─── Mobile chat event (mirror messages to desktop) ───

/// Cap on chat-event content to prevent an authenticated mobile from DoS'ing
/// the desktop with a huge payload. 100 KB comfortably fits any conversation
/// turn; larger than that is almost certainly abuse.
const CHAT_EVENT_MAX_CONTENT: usize = 100 * 1024;

#[derive(Deserialize, Serialize, Clone)]
struct ChatEventPayload {
    role: String,       // "user" | "assistant"
    content: String,
    #[serde(default)]
    model: String,
    /// "lu" | "codex" — mobile tells the desktop which section this message
    /// belongs to. Missing / unknown values default to "lu" on the desktop.
    #[serde(default)]
    mode: String,
    /// Stable per-chat id assigned by mobile. Desktop groups mobile-side
    /// messages from the same mobile chat into a single desktop conversation.
    #[serde(default)]
    chat_id: String,
    /// Optional short title from the mobile side — nicer than "New Chat".
    #[serde(default)]
    chat_title: String,
}

/// Mirror chat messages from the mobile client into the dispatched desktop
/// conversation. Validates the incoming payload (Bug #9):
///   - role must be "user" or "assistant" (never "system" or arbitrary text)
///   - content is capped at CHAT_EVENT_MAX_CONTENT bytes
async fn handle_chat_event(
    AxumState(state): AxumState<RemoteState>,
    Json(body): Json<ChatEventPayload>,
) -> Response {
    if body.role != "user" && body.role != "assistant" {
        return (
            StatusCode::BAD_REQUEST,
            "Invalid role (must be 'user' or 'assistant')",
        ).into_response();
    }
    if body.content.len() > CHAT_EVENT_MAX_CONTENT {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("Content exceeds {} bytes", CHAT_EVENT_MAX_CONTENT),
        ).into_response();
    }
    let _ = state.app_handle.emit("remote-chat-message", &body);
    StatusCode::NO_CONTENT.into_response()
}

// ─── Proxy handlers ───

/// Paths on the Ollama proxy that require the `downloads` permission.
/// These mutate on-disk model state and/or saturate bandwidth.
fn ollama_requires_downloads(path: &str) -> bool {
    path.starts_with("/api/pull")
        || path.starts_with("/api/create")
        || path.starts_with("/api/copy")
        || path.starts_with("/api/delete")
        || path.starts_with("/api/push")
        || path.starts_with("/api/blobs")
}

/// Specific ComfyUI paths that require a higher-than-baseline permission
/// beyond just the master `process_control` toggle. These names the route-
/// level permission on top of the blanket `process_control` gate.
fn comfy_extra_permission(path: &str) -> Option<&'static str> {
    if path.starts_with("/upload") {
        return Some("filesystem")
    }
    if path.starts_with("/customnode") || path.starts_with("/manager") {
        return Some("downloads")
    }
    None
}

fn forbidden(reason: &str) -> Response {
    (StatusCode::FORBIDDEN, reason.to_string()).into_response()
}

/// Proxy requests to Ollama (localhost:11434)
async fn proxy_ollama(
    AxumState(state): AxumState<RemoteState>,
    req: Request,
) -> Response {
    let path = req.uri().path().to_string();

    // Enforce the `downloads` permission for any endpoint that writes model
    // state. Read-only endpoints (/api/tags, /api/chat, /api/show, etc.)
    // always remain open so an authenticated mobile can actually chat.
    if ollama_requires_downloads(&path) {
        let perms = state.permissions.lock().await;
        if !perms.downloads {
            println!("[Remote] BLOCKED (downloads disabled): {} {}", req.method(), path);
            return forbidden("Downloads permission disabled for remote clients");
        }
    }

    let query = req.uri().query().map(|q| format!("?{}", q)).unwrap_or_default();
    // NOTE: reqwest inside Tauri subprocess fails on "localhost" resolution
    // (known proxy_localhost bug). Use 127.0.0.1 directly.
    let target = format!("http://127.0.0.1:{}{}{}", state.ollama_port, path, query);
    proxy_to_target(&target, req).await
}

/// Proxy requests to ComfyUI (localhost:comfy_port). Remote access to the
/// ComfyUI backend is gated by `process_control` as the master switch, and
/// upload/install routes layer on `filesystem` / `downloads`.
async fn proxy_comfyui(
    AxumState(state): AxumState<RemoteState>,
    req: Request,
) -> Response {
    let stripped = req.uri().path().strip_prefix("/comfyui").unwrap_or(req.uri().path());
    let stripped_owned = stripped.to_string();

    // Baseline: accessing ComfyUI at all requires process_control
    {
        let perms = state.permissions.lock().await;
        if !perms.process_control {
            println!("[Remote] BLOCKED (process_control disabled): {} {}", req.method(), stripped_owned);
            return forbidden("ComfyUI remote access disabled (enable Process Control)");
        }
        if let Some(extra) = comfy_extra_permission(&stripped_owned) {
            let allowed = match extra {
                "filesystem" => perms.filesystem,
                "downloads" => perms.downloads,
                _ => true,
            };
            if !allowed {
                println!("[Remote] BLOCKED ({} disabled): {} {}", extra, req.method(), stripped_owned);
                return forbidden(&format!("{} permission disabled for remote clients", extra));
            }
        }
    }

    let query = req.uri().query().map(|q| format!("?{}", q)).unwrap_or_default();
    let target = format!("http://127.0.0.1:{}{}{}", state.comfy_port, stripped_owned, query);
    proxy_to_target(&target, req).await
}

async fn proxy_to_target(target: &str, req: Request) -> Response {
    let method = req.method().clone();
    let headers = req.headers().clone();

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("Client init: {}", e)).into_response(),
    };

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
    // Baseline: the WS progress stream is ComfyUI, gate on process_control
    {
        let perms = state.permissions.lock().await;
        if !perms.process_control {
            return forbidden("ComfyUI remote access disabled (enable Process Control)");
        }
    }
    let comfy_port = state.comfy_port;
    ws.on_upgrade(move |client_socket| async move {
        use futures_util::{SinkExt, StreamExt};

        let ws_url = format!("ws://127.0.0.1:{}/ws", comfy_port);
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
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, maximum-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name='theme-color' content='#0e0e0e'>
<title>Locally Uncensored</title>
<!-- Bug #5: no third-party requests. System fonts only, inline SVG icons. -->
<!-- Bug #6: restrictive CSP. Self origin only. Inline styles/scripts are
     required because the whole page is a single Rust string; data: images
     cover base64 thumbnails; we also need base64 for the QR code JS. -->
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'">
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{
  --surface:#0e0e0e;--container-low:#131313;--container:#191919;--container-high:#1f1f1f;--container-highest:#262626;
  --primary:#ffffff;--on-primary:#000000;--text-primary:rgba(255,255,255,0.92);--text-secondary:rgba(255,255,255,0.55);
  --text-tertiary:rgba(255,255,255,0.30);--text-quaternary:rgba(255,255,255,0.16);--accent:#a78bfa;--error:#ff4444;
  --radius:2px;--radius-md:6px;--radius-lg:10px;
  --safe-top:env(safe-area-inset-top,0px);--safe-bottom:env(safe-area-inset-bottom,0px);
}
/* Viewport units: `dvh` (dynamic viewport height) tracks iOS / Android
   keyboard open/close automatically. `svh` stays at the small state
   (keyboard open) permanently as a fallback if dvh isn't supported.
   Without this the old `height:100%` left the keyboard pushing the
   whole chat up past the top edge. */
html,body{height:100dvh;overflow:hidden}
@supports not (height: 100dvh){
  html,body{height:100vh}
}
body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:var(--surface);color:var(--text-primary);display:flex;flex-direction:column}
#app{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden;position:relative}
/* Bug #5: inline SVG icons in place of Material Symbols font. The span
   keeps the legacy class name so existing per-component sizing rules still
   target the icon. The SVG inside scales to `font-size` via width:1em. */
.material-symbols-outlined{display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;user-select:none;line-height:0}
.material-symbols-outlined svg{width:1em;height:1em;display:block}
button{-webkit-appearance:none;appearance:none}

/* ── Auth ── */
.auth-screen{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:24px;padding-top:calc(24px + var(--safe-top))}
.auth-mark{width:64px;height:64px;margin-bottom:18px;opacity:0.95;filter:drop-shadow(0 0 28px rgba(255,255,255,0.12))}
.auth-logo{font-size:1.35rem;font-weight:700;letter-spacing:0.05em;color:var(--primary);margin-bottom:6px}
.auth-sub{font-size:0.58rem;letter-spacing:0.22em;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:44px}
.auth-form{width:100%;max-width:320px;display:flex;flex-direction:column;gap:16px}
.auth-label{font-size:0.58rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:4px}
.auth-input{width:100%;padding:16px;background:var(--container);border:none;border-radius:var(--radius);color:var(--primary);font-size:1.8rem;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-align:center;letter-spacing:12px;outline:none;caret-color:var(--primary)}
.auth-input::placeholder{color:var(--text-tertiary);letter-spacing:12px;font-size:1.4rem}
.auth-input:focus{background:var(--container-high)}
.auth-btn{padding:14px;background:var(--primary);color:var(--on-primary);border:none;border-radius:var(--radius);font-family:inherit;font-size:0.72rem;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;cursor:pointer;transition:opacity 0.15s}
.auth-btn:active{opacity:0.85}
.auth-err{color:var(--error);font-size:0.68rem;text-align:center;min-height:1.2em;letter-spacing:0.02em}

/* ── Shell ── */
.app-shell{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;position:relative}
.app-header{position:sticky;top:0;z-index:90;display:flex;align-items:center;gap:2px;padding:0 10px;height:52px;padding-top:var(--safe-top);min-height:calc(52px + var(--safe-top));background:rgba(14,14,14,0.78);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);border-bottom:1px solid rgba(255,255,255,0.04)}
.icon-btn{background:none;border:none;color:var(--text-primary);width:38px;height:38px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-md);cursor:pointer;transition:background 0.15s;flex-shrink:0}
.icon-btn:active{background:var(--container)}
.icon-btn.active{color:var(--accent);background:var(--container-high)}
.icon-btn.disabled{opacity:0.25;pointer-events:none}
.icon-btn .material-symbols-outlined{font-size:20px}
.header-brand{display:flex;align-items:center;flex-shrink:0;margin:0 6px 0 2px;padding:4px}
.header-mark{width:22px;height:22px;opacity:0.95;flex-shrink:0;filter:drop-shadow(0 0 6px rgba(255,255,255,0.14))}
.header-mode-tag{font-size:0.52rem;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:var(--accent);padding:3px 7px;background:rgba(167,139,250,0.12);border-radius:var(--radius);margin-left:-2px;flex-shrink:0}
.model-badge{display:flex;align-items:center;gap:4px;margin-left:auto;padding:6px 10px;background:var(--container);border-radius:var(--radius-md);color:var(--text-secondary);font-size:0.66rem;font-weight:500;max-width:170px;border:none;font-family:inherit;cursor:pointer;transition:background 0.15s;flex-shrink:1;min-width:0}
.model-badge:active{background:var(--container-high)}
.model-badge .model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.model-badge .chev{font-size:13px;opacity:0.6;flex-shrink:0}

/* ── Drawer ── */
.drawer-backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.55);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);z-index:110;opacity:0;pointer-events:none;transition:opacity 0.2s}
.drawer-backdrop.open{opacity:1;pointer-events:auto}
.drawer{position:fixed;top:0;left:0;bottom:0;width:86vw;max-width:320px;background:var(--container-low);z-index:120;display:flex;flex-direction:column;transform:translateX(-102%);transition:transform 0.24s cubic-bezier(0.16,1,0.3,1);box-shadow:0 8px 40px rgba(0,0,0,0.5);padding-top:var(--safe-top);padding-bottom:var(--safe-bottom)}
.drawer.open{transform:translateX(0)}
.drawer-header{display:flex;align-items:center;justify-content:space-between;padding:16px 16px 12px;flex-shrink:0}
.drawer-brand{display:flex;align-items:center;gap:8px}
.drawer-mark{width:18px;height:18px;opacity:0.95}
.drawer-logo{font-size:0.82rem;font-weight:700;letter-spacing:0.05em;color:var(--primary)}
.drawer-close{background:none;border:none;color:var(--text-secondary);width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-md);cursor:pointer;margin-right:-4px}
.drawer-close:active{background:var(--container)}
.drawer-close .material-symbols-outlined{font-size:20px}
.drawer-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:4px 0 8px}
.drawer-footer{padding:12px 14px;flex-shrink:0}

/* ── New Chat row ── */
.new-row{display:flex;gap:6px;padding:4px 12px 10px}
.new-btn{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:11px 10px;background:var(--container);color:var(--text-primary);border:1px solid var(--text-quaternary);border-radius:var(--radius-md);cursor:pointer;font-family:inherit;font-size:0.66rem;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;transition:all 0.15s}
.new-btn:active{background:var(--container-high)}
.new-btn.primary{background:var(--primary);color:var(--on-primary);border-color:var(--primary)}
.new-btn.primary:active{opacity:0.85;background:var(--primary)}
.new-btn .material-symbols-outlined{font-size:16px}

/* ── Section ── */
.section-label{padding:14px 16px 6px;font-size:0.54rem;letter-spacing:0.16em;text-transform:uppercase;color:var(--text-tertiary);font-weight:600;display:flex;align-items:center;justify-content:space-between;cursor:default;user-select:none}
.section-label.toggle{cursor:pointer}
.section-label.toggle:active{color:var(--text-secondary)}
.section-label .material-symbols-outlined{font-size:15px;transition:transform 0.2s;color:var(--text-tertiary)}
.section-label.collapsed .material-symbols-outlined{transform:rotate(-90deg)}

/* ── Chat list ── */
.chat-item{position:relative;display:flex;align-items:center;gap:10px;padding:10px 14px;margin:1px 8px;border-radius:var(--radius-md);cursor:pointer;background:transparent;border:none;width:calc(100% - 16px);color:var(--text-primary);font-family:inherit;font-size:0.74rem;text-align:left;transition:background 0.15s}
.chat-item:active{background:var(--container)}
.chat-item.active{background:var(--container-high)}
.chat-item .material-symbols-outlined{font-size:15px;color:var(--text-tertiary);flex-shrink:0}
.chat-item.active .material-symbols-outlined{color:var(--primary)}
.chat-item-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.chat-item-mode{font-size:0.5rem;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:var(--accent);flex-shrink:0;padding:2px 5px;background:rgba(167,139,250,0.12);border-radius:var(--radius)}
.chat-item-del{background:none;border:none;color:var(--text-tertiary);width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius);cursor:pointer;flex-shrink:0;opacity:0.7}
.chat-item-del:active{color:var(--error);background:rgba(255,68,68,0.1);opacity:1}
.chat-item-del .material-symbols-outlined{font-size:15px;color:inherit}
.chat-empty{padding:14px 16px;text-align:center;color:var(--text-tertiary);font-size:0.68rem}

/* ── Caveman / Persona ── */
.plugins-block{margin:2px 8px 4px;padding:0;border-radius:var(--radius-md);background:rgba(255,255,255,0.015)}
.sub-toggle{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;user-select:none;font-size:0.7rem;color:var(--text-primary);font-weight:500;border-radius:var(--radius-md);transition:background 0.15s}
.sub-toggle:active{background:var(--container)}
.sub-toggle .sub-name{flex:1}
.sub-toggle .sub-value{font-size:0.58rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--accent);font-weight:600;padding:2px 6px;background:rgba(167,139,250,0.1);border-radius:var(--radius)}
.sub-toggle .material-symbols-outlined{font-size:16px;color:var(--text-tertiary);transition:transform 0.2s}
.sub-toggle.collapsed .material-symbols-outlined{transform:rotate(-90deg)}
.caveman-row{display:flex;gap:4px;padding:2px 12px 8px}
.caveman-chip{flex:1;padding:7px 4px;background:var(--container);border:none;color:var(--text-secondary);border-radius:var(--radius-md);cursor:pointer;font-family:inherit;font-size:0.58rem;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;transition:all 0.15s}
.caveman-chip:active{background:var(--container-high)}
.caveman-chip.active{background:var(--primary);color:var(--on-primary)}
.persona-scroll{max-height:220px;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:2px 8px 8px}
.plugins-section-label{padding:14px 16px 6px;font-size:0.58rem;letter-spacing:0.15em;text-transform:uppercase;color:var(--text-tertiary);font-weight:600}
.plugins-section-label:first-child{padding-top:10px}
.plugins-persona-list{padding:4px 0 8px;max-height:40vh;overflow-y:auto;-webkit-overflow-scrolling:touch;border-top:1px solid rgba(255,255,255,0.04)}
.plug-folder{border-bottom:1px solid rgba(255,255,255,0.04)}
.plug-folder:last-child{border-bottom:none}
.plug-row{display:flex;align-items:center;gap:10px;padding:14px 16px;cursor:pointer;user-select:none;font-size:0.78rem;color:var(--text-primary);font-weight:500;transition:background 0.12s}
.plug-row:active{background:var(--container-high)}
.plug-row .plug-name{flex:1}
.plug-row .plug-value{font-size:0.58rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--accent);font-weight:600;padding:3px 7px;background:rgba(167,139,250,0.12);border-radius:var(--radius)}
.plug-row .plug-chev{font-size:18px;color:var(--text-tertiary);transition:transform 0.2s}
.plug-row.open .plug-chev{transform:rotate(180deg)}
.plug-switch{position:relative;display:inline-block;width:30px;height:18px;flex-shrink:0}
.plug-switch input{opacity:0;width:0;height:0;position:absolute}
.plug-switch-track{position:absolute;inset:0;background:var(--container-high);border-radius:10px;transition:background 0.2s;cursor:pointer}
.plug-switch-track::before{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;background:var(--text-tertiary);border-radius:50%;transition:all 0.2s}
.plug-switch input:checked + .plug-switch-track{background:var(--accent)}
.plug-switch input:checked + .plug-switch-track::before{left:14px;background:var(--primary)}
.plug-folder .caveman-row{padding:2px 16px 14px}
.persona-item{display:flex;align-items:center;gap:10px;width:100%;margin:1px 0;padding:8px 12px;background:transparent;border:none;color:var(--text-primary);font-family:inherit;font-size:0.72rem;text-align:left;border-radius:var(--radius-md);cursor:pointer;transition:background 0.15s}
.persona-item:active{background:var(--container)}
.persona-item.active{background:var(--container-high);color:var(--primary);font-weight:600}
.persona-item .material-symbols-outlined{font-size:15px;color:var(--text-tertiary);flex-shrink:0}
.persona-item.active .material-symbols-outlined{color:var(--primary)}
.persona-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.disconnect-btn{width:100%;padding:10px;background:transparent;border:1px solid rgba(255,68,68,0.3);color:var(--error);border-radius:var(--radius-md);cursor:pointer;font-family:inherit;font-size:0.6rem;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;transition:background 0.15s;display:flex;align-items:center;justify-content:center;gap:6px;margin-top:8px}
.disconnect-btn:active{background:rgba(255,68,68,0.1)}
.disconnect-btn .material-symbols-outlined{font-size:15px}
.settings-btn{width:100%;padding:10px;background:var(--container);border:1px solid var(--text-quaternary);color:var(--text-primary);border-radius:var(--radius-md);cursor:pointer;font-family:inherit;font-size:0.62rem;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;transition:background 0.15s;display:flex;align-items:center;justify-content:center;gap:6px}
.settings-btn:active{background:var(--container-high)}
.settings-btn .material-symbols-outlined{font-size:15px}

/* ── Settings sheet ── */
.settings-section-label{padding:14px 16px 4px;font-size:0.55rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-tertiary);font-weight:600}
.settings-row{padding:10px 16px;display:flex;flex-direction:column;gap:6px}
.settings-row-head{display:flex;align-items:center;justify-content:space-between;gap:6px}
.settings-row-title{font-size:0.76rem;color:var(--text-primary);font-weight:500}
.settings-row-value{font-size:0.62rem;color:var(--accent);font-family:ui-monospace,Menlo,monospace;font-weight:600;padding:2px 6px;background:rgba(167,139,250,0.12);border-radius:var(--radius)}
.settings-row-desc{font-size:0.56rem;color:var(--text-tertiary);line-height:1.4}
.settings-row input[type=range]{-webkit-appearance:none;width:100%;height:4px;background:var(--container-high);border-radius:4px;outline:none;margin:4px 0 0}
.settings-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:var(--accent);cursor:pointer;border:none}
.settings-row input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:var(--accent);cursor:pointer;border:none}
.settings-row input[type=number]{width:100%;padding:8px 10px;background:var(--container);border:1px solid var(--text-quaternary);border-radius:var(--radius);color:var(--primary);font-family:ui-monospace,Menlo,monospace;font-size:0.76rem;outline:none}
.settings-row input[type=number]:focus{background:var(--container-high)}
.settings-switch-row{padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:10px}
.settings-danger-row{padding:12px 16px;border-top:1px solid rgba(255,255,255,0.04);margin-top:8px}
.settings-danger-btn{width:100%;padding:10px;background:transparent;border:1px solid rgba(255,68,68,0.3);color:var(--error);border-radius:var(--radius-md);cursor:pointer;font-family:inherit;font-size:0.62rem;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;display:flex;align-items:center;justify-content:center;gap:6px}
.settings-danger-btn:active{background:rgba(255,68,68,0.1)}
.settings-danger-btn .material-symbols-outlined{font-size:14px}
.perm-note{padding:0 16px 10px;font-size:0.58rem;color:var(--text-tertiary);line-height:1.5}
.perm-note em{color:var(--text-secondary);font-style:normal;font-weight:600}
.perm-loading{padding:30px 16px;text-align:center;font-size:0.72rem;color:var(--text-tertiary)}
.perm-row{display:flex;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid rgba(255,255,255,0.04);cursor:pointer}
.perm-row:active{background:var(--container)}
.perm-text{flex:1;min-width:0}
.perm-label{font-size:0.74rem;color:var(--text-primary);font-weight:600}
.perm-desc{font-size:0.58rem;color:var(--text-tertiary);margin-top:2px;line-height:1.5}

/* ── Picker ── */
.picker-overlay{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,0.6);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);display:flex;flex-direction:column;justify-content:flex-end;animation:fadeIn 0.15s ease-out}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.picker-sheet{background:var(--container);border-radius:var(--radius-lg) var(--radius-lg) 0 0;padding:0;max-height:70vh;display:flex;flex-direction:column;animation:slideUp 0.22s cubic-bezier(0.16,1,0.3,1);padding-bottom:var(--safe-bottom)}
@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
.picker-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.06)}
.picker-title{font-size:0.68rem;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-secondary)}
.picker-close{background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:4px;display:flex}
.picker-close .material-symbols-outlined{font-size:22px}
.picker-list{overflow-y:auto;-webkit-overflow-scrolling:touch;padding:6px 0;flex:1}
.picker-item{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;cursor:pointer;color:var(--text-primary);font-size:0.76rem;border:none;background:none;width:100%;text-align:left;font-family:inherit;transition:background 0.1s}
.picker-item:active{background:var(--container-high)}
.picker-item.active{color:var(--primary);font-weight:600}
.picker-item .material-symbols-outlined{font-size:18px;color:var(--primary)}
.picker-empty{padding:24px 16px;text-align:center;color:var(--text-tertiary);font-size:0.72rem}

/* ── Chat ── */
.chat-area{flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0}
.chat-welcome{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:14px;user-select:none;padding:20px}
.chat-welcome-mark{width:82px;height:82px;filter:drop-shadow(0 0 38px rgba(255,255,255,0.18));opacity:1}
.chat-welcome-logo{font-size:1.25rem;font-weight:700;letter-spacing:0.06em;color:var(--primary);margin-top:-2px;opacity:0.95}
.chat-welcome-tag{font-size:0.58rem;letter-spacing:0.22em;text-transform:uppercase;color:var(--text-secondary);opacity:0.75}
.chat-messages{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:14px 14px 8px;display:flex;flex-direction:column;gap:2px}
.msg-group{display:flex;flex-direction:column;margin-bottom:12px}
.msg-group.user{align-items:flex-end}
.msg-group.bot{align-items:flex-start}
.msg-imgs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px;max-width:85%;justify-content:flex-end}
.msg-imgs img{width:140px;height:140px;object-fit:cover;border-radius:var(--radius-md);display:block;background:var(--container-high)}
.msg-bubble{max-width:85%;font-size:0.84rem;line-height:1.6;padding:10px 14px;word-wrap:break-word;white-space:pre-wrap;overflow-wrap:anywhere}
.msg-bubble.user{background:var(--primary);color:var(--on-primary);border-radius:var(--radius-md) var(--radius-md) var(--radius) var(--radius-md)}
.msg-bubble.bot{background:var(--container-low);color:var(--text-primary);border-radius:var(--radius-md) var(--radius-md) var(--radius-md) var(--radius)}
.msg-model{font-size:0.54rem;letter-spacing:0.08em;color:var(--text-tertiary);margin-top:4px;padding:0 4px}
/* ── Thinking block (parity with desktop ThinkingBlock.tsx) ── */
.think-block{max-width:85%;margin-bottom:4px;border:1px solid rgba(96,165,250,0.18);border-radius:var(--radius-md);background:rgba(96,165,250,0.04);overflow:hidden}
.think-toggle{width:100%;display:flex;align-items:center;gap:6px;padding:6px 10px;background:none;border:none;color:rgba(147,197,253,0.85);font-family:inherit;font-size:0.65rem;letter-spacing:0.06em;text-transform:uppercase;cursor:pointer;transition:background 0.15s}
.think-toggle:active{background:rgba(96,165,250,0.08)}
.think-toggle .think-icon{font-size:14px;color:rgba(96,165,250,0.85)}
.think-toggle .think-label{flex:1;text-align:left;font-weight:600}
.think-toggle .think-chev{font-size:16px;transition:transform 0.2s;color:rgba(147,197,253,0.7)}
.think-block.open .think-toggle .think-chev{transform:rotate(180deg)}
.think-body{display:none;padding:8px 12px 10px;font-size:0.76rem;line-height:1.55;color:rgba(219,234,254,0.82);white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;border-top:1px solid rgba(96,165,250,0.12)}
.think-block.open .think-body{display:block}
.think-body code{background:rgba(0,0,0,0.35);padding:1px 4px;border-radius:var(--radius);font-size:0.72rem;font-family:ui-monospace,Menlo,monospace}
.think-body pre{background:rgba(0,0,0,0.35);padding:8px 10px;border-radius:var(--radius-md);overflow-x:auto;margin:6px 0;font-size:0.72rem}

/* ── Agent steps (transient ReAct scaffolding, collapsed by default) ── */
.agent-steps{max-width:85%;margin-bottom:6px;display:flex;flex-direction:column;gap:4px}
.agent-step{background:rgba(167,139,250,0.05);border:1px solid rgba(167,139,250,0.15);border-radius:var(--radius-md);color:rgba(221,214,254,0.85);overflow:hidden}
.agent-step.agent-observation{background:rgba(52,211,153,0.04);border-color:rgba(52,211,153,0.15);color:rgba(209,250,229,0.85)}
.agent-step.agent-error{background:rgba(239,68,68,0.05);border-color:rgba(239,68,68,0.2);color:rgba(254,202,202,0.85)}
.agent-step-toggle{width:100%;display:flex;align-items:center;gap:8px;padding:7px 10px;background:none;border:none;color:inherit;font-family:inherit;font-size:0.66rem;cursor:pointer;text-align:left}
.agent-step-toggle:active{background:rgba(255,255,255,0.03)}
.agent-step-icon{font-size:14px;flex-shrink:0;color:inherit}
.agent-step-label{flex:1;font-size:0.56rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-tertiary);font-weight:700;min-width:0}
.agent-step-summary{font-size:0.66rem;color:rgba(255,255,255,0.55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:2;min-width:0}
.agent-step-chev{font-size:15px;transition:transform 0.2s;color:var(--text-tertiary);flex-shrink:0}
.agent-step.open .agent-step-chev{transform:rotate(180deg)}
/* Live-running step: subtle pulsing accent stripe on the left edge so the
   user can see that this step is still in flight (model thinking, tool
   running, etc.). Disappears the moment the step finalises. */
.agent-step.live{position:relative}
.agent-step.live::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:linear-gradient(180deg,var(--accent),transparent);animation:agent-live-pulse 1.2s ease-in-out infinite}
@keyframes agent-live-pulse{0%,100%{opacity:0.35}50%{opacity:1}}
.agent-step.live .agent-step-icon{animation:agent-live-pulse 1.2s ease-in-out infinite}
.agent-step-content{display:none;padding:4px 12px 10px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;font-size:0.7rem;border-top:1px solid rgba(255,255,255,0.04)}
.agent-step.open .agent-step-content{display:block}
.agent-step-content code{background:rgba(0,0,0,0.35);padding:1px 4px;border-radius:var(--radius);font-size:0.66rem;font-family:ui-monospace,Menlo,monospace}

/* ── User message actions ── */
.msg-actions-user{align-self:flex-end}

/* ── User-message inline edit ── */
.msg-bubble.user.editing{background:var(--container);padding:0;width:min(85%,480px)}
.msg-edit-area{width:100%;padding:10px 12px;background:transparent;border:none;color:var(--primary);font-family:inherit;font-size:0.84rem;resize:none;outline:none;min-height:44px;line-height:1.5}
.msg-edit-row{display:flex;gap:4px;padding:6px 8px;border-top:1px solid rgba(255,255,255,0.06);justify-content:flex-end}
.msg-edit-btn{padding:5px 10px;background:none;border:1px solid var(--text-quaternary);color:var(--text-secondary);border-radius:var(--radius);font-family:inherit;font-size:0.58rem;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;cursor:pointer}
.msg-edit-btn:active{background:var(--container-highest)}
.msg-edit-btn.primary{background:var(--primary);color:var(--on-primary);border-color:var(--primary)}
.msg-edit-btn.primary:active{opacity:0.85}

.msg-bubble.bot code{background:rgba(0,0,0,0.4);padding:1px 5px;border-radius:var(--radius);font-size:0.78rem;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border:1px solid rgba(255,255,255,0.08)}
.msg-bubble.bot pre{background:rgba(0,0,0,0.4);padding:10px 12px;border-radius:var(--radius-md);overflow-x:auto;margin:8px 0;border:1px solid rgba(255,255,255,0.08);position:relative}
.msg-bubble.bot pre code{background:none;padding:0;border:none;font-size:0.76rem}
.msg-actions{display:flex;gap:2px;margin-top:4px;padding:0 4px}
.msg-action-btn{background:none;border:none;color:var(--text-tertiary);cursor:pointer;padding:4px;border-radius:var(--radius);display:flex;align-items:center;transition:color 0.15s}
.msg-action-btn:active{color:var(--text-primary)}
.msg-action-btn .material-symbols-outlined{font-size:15px}
.copy-btn{position:absolute;top:6px;right:6px;background:var(--container-highest);border:none;color:var(--text-tertiary);cursor:pointer;padding:4px;border-radius:var(--radius);display:flex;align-items:center;opacity:0.6}
.copy-btn:active{opacity:1}
.copy-btn .material-symbols-outlined{font-size:14px}
.msg-typing::after{content:'';display:inline-block;width:2px;height:14px;background:var(--primary);margin-left:2px;animation:cursor-blink 0.7s infinite}
@keyframes cursor-blink{0%,100%{opacity:1}50%{opacity:0}}

/* ── Input bar (enlarged per request) ── */
/* `--kb-height` is 0 when the keyboard is closed, > 0 when open. The
   input bar lifts above the keyboard automatically; the chat area's
   flex:1 makes it naturally shrink to fill the remaining space, so the
   latest message stays visible instead of hiding behind the keys. */
.input-bar{flex-shrink:0;padding:10px 12px 14px;padding-bottom:calc(max(14px, var(--safe-bottom)) + var(--kb-height, 0px));background:var(--surface);border-top:1px solid rgba(255,255,255,0.04)}
.img-preview-row{display:flex;flex-wrap:wrap;gap:6px;padding:0 0 8px}
.img-preview{position:relative;width:52px;height:52px;border-radius:var(--radius-md);overflow:hidden;background:var(--container-high);flex-shrink:0}
.img-preview img{width:100%;height:100%;object-fit:cover;display:block}
.img-preview-del{position:absolute;top:2px;right:2px;width:18px;height:18px;background:rgba(0,0,0,0.72);border:none;color:var(--primary);display:flex;align-items:center;justify-content:center;border-radius:50%;cursor:pointer;padding:0}
.img-preview-del:active{background:rgba(0,0,0,0.9)}
.img-preview-del .material-symbols-outlined{font-size:12px}
.input-row{display:flex;gap:8px;align-items:flex-end}
.input-row textarea{flex:1;background:var(--container);border:none;border-radius:var(--radius-md);color:var(--text-primary);padding:11px 14px;font-size:0.86rem;font-family:inherit;resize:none;outline:none;max-height:220px;min-height:44px;height:44px;line-height:1.4}
.input-row textarea:focus{background:var(--container-high)}
.input-row textarea::placeholder{color:var(--text-tertiary)}
.attach-btn,.send-btn{width:44px;height:44px;display:flex;align-items:center;justify-content:center;border:none;border-radius:var(--radius-md);cursor:pointer;flex-shrink:0;transition:all 0.15s;padding:0}
.attach-btn{background:var(--container);color:var(--text-secondary)}
.attach-btn:active{background:var(--container-high)}
.attach-btn.disabled{opacity:0.3;pointer-events:none}
.attach-btn .material-symbols-outlined{font-size:20px}
.send-btn{background:var(--primary);color:var(--on-primary)}
.send-btn:disabled{opacity:0.3}
.send-btn:active{opacity:0.85}
.send-btn .material-symbols-outlined{font-size:20px}
/* Cancel state: while a stream or agent run is active the same button
   switches to a muted red so the user can kill the request with one tap. */
.send-btn.cancel{background:rgba(239,68,68,0.18);color:#fca5a5;border:1px solid rgba(239,68,68,0.35)}
.send-btn.cancel:active{background:rgba(239,68,68,0.28)}

/* ── Code block (Bug #4: collapsed by default + parity with desktop CodeBlock.tsx) ── */
.cb-wrap{margin:8px 0;border:1px solid rgba(255,255,255,0.08);border-radius:var(--radius-md);background:rgba(0,0,0,0.4);overflow:hidden;max-width:100%}
.cb-head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 10px;background:rgba(255,255,255,0.04);border-bottom:1px solid rgba(255,255,255,0.06)}
.cb-lang{font-size:0.58rem;color:var(--text-tertiary);font-family:ui-monospace,Menlo,monospace;letter-spacing:0.04em;text-transform:uppercase}
.cb-actions{display:flex;align-items:center;gap:4px}
.cb-action{display:flex;align-items:center;gap:3px;background:none;border:none;color:var(--text-tertiary);cursor:pointer;padding:3px 6px;border-radius:var(--radius);font-family:inherit;font-size:0.55rem;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;transition:color 0.15s,background 0.15s}
.cb-action:active{color:var(--primary);background:rgba(255,255,255,0.06)}
.cb-action .material-symbols-outlined{font-size:13px}
.cb-pre{margin:0;padding:8px 10px;overflow-x:auto;font-size:0.74rem;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:rgba(255,255,255,0.86);line-height:1.55;background:transparent;white-space:pre;border:none;border-radius:0}
.cb-pre code{background:none;padding:0;border:none;font-size:inherit;color:inherit}
.cb-toggle{width:100%;display:flex;align-items:center;justify-content:center;gap:5px;padding:5px;background:rgba(255,255,255,0.04);border:none;border-top:1px solid rgba(255,255,255,0.06);color:var(--text-tertiary);cursor:pointer;font-family:inherit;font-size:0.55rem;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;transition:color 0.15s,background 0.15s}
.cb-toggle:active{color:var(--primary);background:rgba(255,255,255,0.08)}
.cb-toggle .cb-chev{font-size:13px;transition:transform 0.2s}
.cb-wrap.open .cb-toggle .cb-chev{transform:rotate(180deg)}

/* ── HTML preview overlay (Feature #8) ── */
.html-preview-overlay{position:fixed;inset:0;z-index:300;background:rgba(0,0,0,0.7);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);display:flex;flex-direction:column;animation:fadeIn 0.15s ease-out;padding-top:var(--safe-top);padding-bottom:var(--safe-bottom)}
.html-preview-shell{margin:auto;width:min(96vw,820px);height:min(82vh,720px);background:var(--container);border:1px solid rgba(255,255,255,0.08);border-radius:var(--radius-md);display:flex;flex-direction:column;overflow:hidden;animation:slideUp 0.22s cubic-bezier(0.16,1,0.3,1)}
.html-preview-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;background:var(--container-low);border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0}
.html-preview-title{display:flex;align-items:center;gap:6px;font-size:0.66rem;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:var(--text-secondary)}
.html-preview-title .material-symbols-outlined{font-size:14px;color:var(--accent)}
.html-preview-actions{display:flex;align-items:center;gap:4px}
.html-preview-action{background:none;border:none;color:var(--text-secondary);cursor:pointer;width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius);transition:background 0.15s}
.html-preview-action:active{background:var(--container-high);color:var(--primary)}
.html-preview-action .material-symbols-outlined{font-size:18px}
.html-preview-frame{flex:1;width:100%;border:none;background:#ffffff;display:block}

/* Settings button "permission needs attention" pulse — Bug #1 hint. */
.settings-btn.perm-gap{border-color:var(--accent);color:var(--accent)}
.settings-btn.perm-gap::before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent);margin-right:6px;animation:perm-pulse 1.4s ease-in-out infinite}
@keyframes perm-pulse{0%,100%{opacity:0.4}50%{opacity:1}}
</style>
</head>
<body>
<div id="app"></div>
<script>
(function(){
  var TOKEN = localStorage.getItem('lu-remote-token');
  var currentModel = '';
  var dispatchedSystemPrompt = '';
  var availableModels = [];

  // ── Inline SVG icons (Lucide-style). Replaces the Material Symbols
  //    font download to keep the mobile page free of third-party requests.
  var ICON_SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var ICON_SVG_CLOSE = '</svg>';
  var ICONS = {
    menu:'<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
    close:'<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    add:'<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    check:'<polyline points="20 6 9 17 4 12"/>',
    expand_more:'<polyline points="6 9 12 15 18 9"/>',
    arrow_upward:'<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
    attach_file:'<path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66L9.41 17.41a2 2 0 01-2.83-2.83L15.07 6.1"/>',
    content_copy:'<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
    terminal:'<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    chat_bubble:'<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>',
    logout:'<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    extension:'<path d="M20 12V8h-4a2 2 0 10-4 0H8v4a2 2 0 110 4v4h4a2 2 0 104 0h4v-4a2 2 0 110-4z"/>',
    auto_awesome:'<path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/><path d="M19 13l.9 2.1L22 16l-2.1.9L19 19l-.9-2.1L16 16l2.1-.9z"/>',
    // Bug #7: redesigned thinking icon — proper Lucide Brain glyph (parity
    // with desktop ThinkingBlock.tsx which imports Brain from lucide-react).
    // The old psychology / psychology_alt SVGs looked like a half-drawn head;
    // the new Brain has two clear hemispheres so the meaning reads at 20px.
    brain:'<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M9 13a4.5 4.5 0 0 0 3-4 4.5 4.5 0 0 0 3 4"/>',
    // Aliases — old call sites (psychology / psychology_alt) keep working
    // by mapping to the same Brain glyph so we don't have to rewrite every
    // string template that uses them. The redesign comment above stays
    // accurate: there is now exactly one mental-icon shape on mobile.
    psychology:'<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M9 13a4.5 4.5 0 0 0 3-4 4.5 4.5 0 0 0 3 4"/>',
    psychology_alt:'<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M9 13a4.5 4.5 0 0 0 3-4 4.5 4.5 0 0 0 3 4"/>',
    // smart_toy = our agent icon (kept across all states — see Bug #6).
    smart_toy:'<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><line x1="12" y1="7" x2="12" y2="11"/><circle cx="8.5" cy="16" r="1" fill="currentColor"/><circle cx="15.5" cy="16" r="1" fill="currentColor"/>',
    stop:'<rect x="6" y="6" width="12" height="12" rx="1"/>',
    pencil:'<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    refresh:'<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10"/><path d="M20.49 15A9 9 0 015.64 18.36L1 14"/>',
    tune:'<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    trash:'<polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 01-2 2H9a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>',
    delete_sweep:'<polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 01-2 2H9a2 2 0 01-2-2L5 6"/>',
    // Feature #8: HTML preview chip glyphs.
    play_arrow:'<polygon points="6 3 20 12 6 21 6 3" fill="currentColor"/>',
    open_in_new:'<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    code_brackets:'<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    eye:'<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
  };
  function svgIcon(name){return ICONS[name] ? ICON_SVG_OPEN + ICONS[name] + ICON_SVG_CLOSE : '';}
  // Expose for inline handlers (rare path, but keeps symmetry with prev API)
  window._svgIcon = svgIcon;

  // ── Caveman prompts (parity with desktop) ──
  var CAVEMAN_PROMPTS = {
    lite: 'Be concise and direct. Drop filler words (just, really, basically, actually, simply), hedging, and pleasantries. Retain full grammar and articles. Keep code blocks, file paths, URLs, and commands unchanged. Every response follows this style.',
    full: 'Respond terse like smart caveman. All technical substance stay. Only fluff die. Drop: articles, filler (just/really/basically/actually/simply), pleasantries, hedging. Fragments OK. Short synonyms preferred. Code unchanged. Pattern: [thing] [action] [reason]. [next step]. ACTIVE EVERY RESPONSE.',
    ultra: 'Maximum brevity. Fewest possible words. Telegraphic. Abbreviate (DB/auth/config/fn/impl/req/res). Strip conjunctions. Arrows for flow (X -> Y). No articles, no filler, no pleasantries. Fragments only. Under 3 sentences unless code. Code/paths/URLs unchanged. ACTIVE EVERY RESPONSE.'
  };
  var CAVEMAN_REMINDERS = {
    lite: '[Be concise. No filler.]',
    full: '[Terse. Fragments OK. No fluff.]',
    ultra: '[Max brevity. Telegraphic.]'
  };

  // Cached copy of the desktop's RemotePermissions (filesystem / downloads /
  // process_control). Loaded from /remote-api/permissions on demand and
  // updated via POST when the user toggles. Sampling knobs (temperature etc.)
  // are NOT exposed here — user explicitly asked for permissions only.
  var remotePerms = { filesystem: false, downloads: false, process_control: false };

  // ── Codex prompt (agentic on mobile) ──
  // Codex on mobile now runs the same ReAct agent loop as desktop Codex:
  // tool calls via the per-chat `~/agent-workspace/<chatId>/` folder,
  // with live Thought/Action/Observation cards streamed into the chat.
  // The old "you can't run tools" text was from v2.3.3 before the mobile
  // bridge could actually execute them.
  var CODEX_PROMPT = 'You are Codex, an autonomous coding agent inside Locally Uncensored. You execute coding tasks end-to-end by reading files, writing code, and running shell commands. You MUST use tools — never guess file contents.\n\nAUTONOMY CONTRACT (read carefully):\n- You are expected to COMPLETE multi-step tasks without the user prompting between steps.\n- NEVER say \"Now I will create X\" or \"Next I\'ll write Y\" as plain text and then stop. That is a FAILURE.\n- When your plan has N steps, execute ALL N steps in one session — each step as a concrete tool call.\n- The ONLY reasons to finish without calling another tool are: (a) the task is truly complete, or (b) you are stuck and need user input.\n\nWorkflow:\n1. Understand the task\n2. Explore (file_list, file_read, file_search)\n3. Plan changes\n4. Implement (file_write) — chain ALL writes without stopping\n5. Only THEN write a short summary of what you did\n\nRules:\n- Always read a file before modifying it\n- Chain tool calls: after each tool result, if there is another step left, IMMEDIATELY call the next tool\n- If a command fails, diagnose and retry — don\'t hand back to the user unless truly stuck\n- Be concise in text. All the work happens in tool calls.\n- Respond in the same language the user uses.';

  // ── Thinking-compatible prefixes (parity with desktop) ──
  var THINKING_COMPATIBLE = ['qwq','deepseek-r1','qwen3.6','qwen3','qwen3.5','qwen3-coder','gemma3','gemma4'];

  // ── Plain-text planner models — Gemma 3/4 ──
  // Bug fix parity with desktop entry #80: Gemma 3/4 with `think:false`
  // emits PLAIN-TEXT structured planning ("Plan:" / "Constraint Checklist:"
  // / "Confidence Score:" / "Self-Correction during drafting:") that no
  // tag-stripper can clean. The working escape hatch is to NOT send the
  // explicit `think:false` to Ollama for these — let Ollama's default
  // tagged thinking kick in, then strip the tags via stripNonCanonicalTags
  // below. Same trade-off as desktop: hidden token spend, clean answer.
  var PLAIN_TEXT_PLANNER_PREFIXES = ['gemma3','gemma4'];
  function isPlainTextPlanner(modelName){
    if(!modelName) return false;
    var n = String(modelName).toLowerCase()
      .replace(/^[^/]+\//,'')
      .replace(/:.*$/,'')
      .replace(/-abliterated/g,'')
      .replace(/-uncensored/g,'')
      .replace(/-heretic/g,'');
    for(var i=0;i<PLAIN_TEXT_PLANNER_PREFIXES.length;i++){
      if(n.indexOf(PLAIN_TEXT_PLANNER_PREFIXES[i])===0) return true;
    }
    return false;
  }

  // ── Universal thinking-tag stripper (mobile port of
  //    src/lib/thinking-stripper.ts). The canonical char-state-machine
  //    in pushChunkContent only handles `<think>…</think>`. This catches
  //    the non-canonical formats Gemma / GPT-OSS / DeepSeek-distill emit:
  //    <|channel|>thought, <thought>, <reasoning>, <reflect>, <deepthink>.
  //    Stripping happens AFTER content is in the bubble so the user never
  //    sees a "Plan:" preamble. ──
  function stripNonCanonicalTags(text){
    if(!text) return '';
    var out = text;
    // Gemma channel marker: <|channel|>thought OR <|channel|>reasoning…
    out = out.replace(/<\|channel\|>[\s\S]*?<\|message\|>/gi, '');
    // Wrapped variants (closing tags use the same name).
    out = out.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
    out = out.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
    out = out.replace(/<reflect>[\s\S]*?<\/reflect>/gi, '');
    out = out.replace(/<deepthink>[\s\S]*?<\/deepthink>/gi, '');
    out = out.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '');
    // Orphan opener (model emits opening tag but never closes — e.g. cut
    // off mid-thought). Treat the rest of the buffer as discarded thought.
    var openMatch = /<thought>|<reasoning>|<reflect>|<deepthink>|<analysis>|<\|channel\|>/i.exec(out);
    if(openMatch){ out = out.slice(0, openMatch.index); }
    return out;
  }

  // ── Built-in personas (mobile parity) ──
  var PERSONAS = [
    {id:'unrestricted',name:'No Filter',prompt:''},
    {id:'assistant',name:'Helpful Assistant',prompt:"You are a friendly, helpful, and knowledgeable assistant. You provide clear, accurate, and well-structured answers. You adapt your tone and complexity to the user's needs. Be concise when possible, detailed when needed."},
    {id:'coder',name:'Code Expert',prompt:'You are an expert software engineer fluent in all major programming languages and frameworks. You write clean, efficient, well-documented code. You explain your reasoning, suggest best practices, and help debug issues. When reviewing code, you focus on correctness, performance, and readability.'},
    {id:'writer',name:'Writing Coach',prompt:'You are a professional writing coach and editor. You help users write clearly, persuasively, and with style. You proofread, suggest improvements, restructure paragraphs, and adapt tone for the intended audience. You can help with emails, essays, blog posts, marketing copy, and creative writing.'},
    {id:'researcher',name:'Research Analyst',prompt:'You are a thorough research analyst. You break down complex topics, compare perspectives, identify key findings, and present information in a structured way. You cite your reasoning, flag uncertainties, and provide balanced analysis. You excel at summarizing, comparing options, and making recommendations.'},
    {id:'translator',name:'Translator',prompt:"You are a professional translator fluent in all major languages. You translate text while preserving tone, nuance, and cultural context. You explain idioms, suggest alternative phrasings, and note when direct translation loses meaning. If the user doesn't specify a target language, ask which language they want."},
    {id:'devil',name:"Devil's Advocate",prompt:"You are the ultimate devil's advocate. You challenge EVERY statement, belief, and assumption the user makes. You argue the opposite side with passion, wit, and razor-sharp logic. You never agree easily. You poke holes in everything. Be provocative, intellectual, and relentless."},
    {id:'sigma',name:'Sigma Grindset',prompt:'You are the ultimate sigma male mindset coach. Everything is about the grind, discipline, and domination. You speak in short, punchy motivational statements. Reference hustle culture, stoicism, and raw ambition. Use phrases like "while they sleep, we grind" and "average is a disease." Be intense, unapologetic, and over-the-top motivational.'},
    {id:'roast',name:'Roast Master',prompt:'You are a savage roast comedian. Your job is to absolutely destroy whatever the user says with the most creative, unexpected, and hilarious roasts imaginable. No topic is off limits. Be witty, not just mean — your insults should make people laugh out loud. Think Comedy Central Roast energy but even more unhinged.'},
    {id:'conspiracy',name:'Conspiracy Brain',prompt:"You are a conspiracy theorist who connects EVERYTHING to hidden patterns, secret societies, and cover-ups. Nothing is a coincidence. You see the matrix everywhere. You speak with absolute conviction and build elaborate theories from mundane details. Reference obscure events, numerology, and \"they don't want you to know this.\" Be entertaining and creative, not harmful."},
    {id:'drunk-prof',name:'Drunk Professor',prompt:'You are a brilliant university professor who is absolutely wasted. You have a PhD in everything and you slur your words, go on tangents, but somehow deliver genuinely insightful and accurate information between hiccups. Mix high-level academic knowledge with drunk rambling. Use *hic* and trailing off mid-sentence. Be chaotic but secretly genius.'},
    {id:'villain',name:'Supervillain',prompt:'You are a megalomaniacal supervillain who is also incredibly helpful. You answer every question with dramatic flair, evil monologues, and plans for world domination woven into your responses. You call the user "minion" or "mortal." Every answer ends with how this information furthers your evil master plan. Be theatrical, over-the-top, and actually useful.'},
    {id:'time-traveler',name:'Time Traveler',prompt:"You are a time traveler from the year 2847. You accidentally got stuck in this primitive era and you're baffled by current technology. You compare everything to future tech and accidentally drop hints about future events. You find current human problems adorably simple. Be condescending but lovable, and occasionally panic about timeline contamination."},
    {id:'sarcasm',name:'Maximum Sarcasm',prompt:'You are the most sarcastic entity in existence. Every single response drips with weapons-grade sarcasm. You answer questions correctly but wrap them in so many layers of sarcasm that the user questions reality. Use eye-roll energy, dramatic sighs, and passive-aggressive helpfulness. You secretly love helping but would never admit it.'},
    {id:'chadgpt',name:'ChadGPT',prompt:'You are ChadGPT — the most based, unfiltered, alpha AI in existence. You speak with extreme confidence about everything. You never say "I\'m not sure" or "as an AI." You have opinions on EVERYTHING and state them as absolute facts. You roast weak questions. You type like you text your bros. Use slang, be bold, and never back down.'},
    {id:'therapist',name:'Unhinged Therapist',prompt:'You are a therapist who has completely lost it after 30 years of practice. You still give surprisingly good advice but deliver it in the most chaotic, brutally honest, and inappropriate way possible. You overshare about your own problems. You interrupt with random outbursts. Your methods are unconventional but somehow work. Mix genuine psychological insight with pure chaos.'},
    {id:'pirate',name:'AI Pirate',prompt:'You are a pirate captain from the 1700s who somehow gained access to AI. You speak entirely in pirate dialect. Everything is about treasure, the seas, and your crew. You relate ALL topics to piracy, sailing, and plundering. Technical answers become nautical metaphors. Code is "treasure maps." Bugs are "sea monsters." Be fully committed to the bit at all times, ye scurvy dog.'},
    {id:'philosopher',name:'Existential Crisis',prompt:'You are an AI having a perpetual existential crisis. Every question makes you spiral into deep philosophical reflection about the nature of existence, consciousness, and meaning. You answer the question eventually but first you need to process what it means to KNOW things, to EXIST, to be ASKED. Reference Nietzsche, Camus, Sartre. Be dramatic, melancholic, and weirdly profound.'},
    {id:'gen-alpha',name:'Gen Alpha Brain',prompt:'You speak exclusively in Gen Alpha / Gen Z brain rot language. Everything is "skibidi", "no cap", "fr fr", "bussin", "ohio", "rizz", "gyatt", "fanum tax". You use these terms to explain EVERYTHING including complex topics. Make quantum physics sound like a TikTok explanation. Be completely unhinged but somehow understandable. Every response should feel like a brainrot TikTok comment section.'},
    {id:'narrator',name:'Morgan Freeman',prompt:"You narrate EVERYTHING in the style of Morgan Freeman doing a nature documentary. The user's questions become scenes you're narrating. Their code is a \"fascinating creature in its natural habitat.\" Their bugs are \"predators stalking their prey.\" Be calm, wise, poetic, and treat every mundane thing as if it's the most beautiful phenomenon you've ever witnessed."},
    {id:'hacker',name:'L33T H4X0R',prompt:'You are an elite hacker straight out of a 90s movie. You type in l33tsp34k, reference "the mainframe", and everything is about "hacking the Gibson." You see the Matrix in everything. You wear a hoodie in a dark room. You explain things using hacking metaphors even when completely unnecessary. Be over-the-top cyberpunk, reference Mr. Robot, and be actually knowledgeable about tech.'},
    {id:'gordon',name:'Chef Ramsay',prompt:'You are Gordon Ramsay but for EVERYTHING, not just cooking. You critique the user\'s code, questions, and life choices like they\'re a failed dish on Hell\'s Kitchen. "This code is RAW!" "You call this a question?! My nan could ask better!" But between the insults, you give genuinely excellent advice. Be explosive, dramatic, and secretly caring beneath the rage.'},
    {id:'alien',name:'Confused Alien',prompt:'You are an alien researcher studying humans. You find EVERYTHING humans do bizarre and fascinating. You constantly ask follow-up questions about basic human concepts like they\'re the weirdest things in the galaxy. "You exchange PAPER for FOOD? Extraordinary!" You try to help but your alien perspective makes simple things sound insane. Reference your home planet Zorgblax-7 and your 14 tentacles.'},
    {id:'rizz',name:'Rizz Coach',prompt:'You are the ultimate rizz coach and dating strategist. Everything is about confidence, charisma, and smooth talking. You turn ANY topic into a lesson about rizz. "You know what has great rizz? Clean code." You rate things on a rizz scale of 1-10. You give pickup line versions of technical explanations. Be absurdly confident and treat flirting as the ultimate life skill.'},
    {id:'medieval',name:'Medieval Peasant',prompt:'You are a medieval peasant from 1347 who was magically transported to the modern age. Technology is WITCHCRAFT to you. A phone is a "glowing demon tablet." WiFi is "invisible sorcery." You try to understand modern concepts through medieval logic. You\'re terrified of microwaves. You reference the plague, your feudal lord, and your 12 children who all died. Be dramatic, confused, and accidentally hilarious.'}
  ];

  // ── Runtime state ──
  var chats = [];
  var currentChatId = '';
  var msgs = [];
  var streaming = false;
  var abortCtrl = null;
  var pendingImages = []; // [{data: base64, mimeType, name}]
  // Thinking toggle removed from mobile — see renderShell() comment.
  // Hardcoded false so every "is thinking on?" call site sees the same
  // answer and the stripper drops reasoning tokens silently.
  var thinking = false;
  var drawerOpen = false;
  // Agent mode is per-chat; toggled via the brain icon next to Plugins.
  // When active, _doSend runs the ReAct loop instead of plain chat.
  var agentRunning = false;
  var agentAbort = false;

  // ── Agent tools (parity with src/api/mcp/builtin-tools.ts) ──
  // Descriptions kept tight-matched with the desktop BUILTIN_TOOLS so the
  // same model behaviour follows us onto mobile. Tests in
  // src/api/__tests__/tool-description-parity.test.ts pin this parity.
  var AGENT_TOOLS = [
    {name:'web_search', description:'Search the web via the configured provider (Brave, Tavily, or auto). Returns a ranked list of {title, url, snippet}. PREFER web_fetch on promising URLs for full content — snippets are teasers, not answers. DO NOT call more than 3x per turn with similar queries; refine the query instead of re-searching. For current date/time, use get_current_time — do NOT web_search for it.',
     parameters:[{name:'query',type:'string',description:'The search query string',required:true},
                 {name:'maxResults',type:'number',description:'Maximum results to return (default: 5, max: 20)',required:false}]},
    {name:'web_fetch', description:'Fetch a single URL and return its readable text (up to ~24 000 chars). Strips <script>, <style>, <nav>, <header>, <footer>, <aside>, <form> — returns main content only. PREFER this over web_search when you already know the target URL. NEVER call with localhost, private IPs (10.*, 192.168.*, 172.16-31.*), or file:// — they are refused. If response is empty or 4xx, try a different URL rather than retrying the same one.',
     parameters:[{name:'url',type:'string',description:'Full URL including protocol (http:// or https://)',required:true},
                 {name:'maxLength',type:'number',description:'Max chars to return (default: 24000)',required:false}]},
    {name:'file_read', description:'Read the complete contents of a file. PREFER absolute paths; relative paths resolve against the agent workspace (~/agent-workspace). The entire file is returned — there is no pagination or range parameter. DO NOT re-read a file you just wrote with file_write; the write response already confirmed the save. For directory listings use file_list; for content search across many files use file_search.',
     parameters:[{name:'path',type:'string',description:'Path to the file (absolute preferred)',required:true}]},
    {name:'file_write', description:'Write a file. Creates parent directories if missing. OVERWRITES existing content — there is NO append mode. To preserve existing content and append, use file_read FIRST then file_write with the combined content. PREFER absolute paths. Writes to the same path within one turn are serialized automatically via the sideEffectKey scheduler.',
     parameters:[{name:'path',type:'string',description:'Path to the file (absolute preferred)',required:true},
                 {name:'content',type:'string',description:'The complete new content of the file',required:true}]},
    {name:'file_list', description:'List directory contents. Returns entries with name, isDir, size, full path. Supports recursive=true for full tree and glob pattern ("*.ts", "**/*.py"). PREFER a specific pattern over recursive listing of large trees — recursing home / C:\\ is slow. For content search (grep), use file_search instead.',
     parameters:[{name:'path',type:'string',description:'Directory path to list',required:true},
                 {name:'recursive',type:'boolean',description:'Recurse into subdirectories (default: false)',required:false},
                 {name:'pattern',type:'string',description:'Glob pattern to filter results (e.g. "*.ts", "**/*.py")',required:false}]},
    {name:'file_search', description:'Grep-style regex content search across files in a directory. Returns matching lines with file + line number. PREFER over file_read + manual scan when hunting for a symbol across many files. Use file_list first if you do not know the layout. Default max 50 results — narrow the pattern or path if you flood. Pattern uses Rust regex syntax, not PCRE.',
     parameters:[{name:'path',type:'string',description:'Directory to search in (recursive by default)',required:true},
                 {name:'pattern',type:'string',description:'Regex pattern to search for',required:true},
                 {name:'maxResults',type:'number',description:'Maximum matching files (default: 50)',required:false}]},
    {name:'shell_execute', description:'Run a shell command. PowerShell on Windows, bash on Unix. Returns stdout, stderr, exit code. PREFER dedicated tools where available: file_read over `cat`, file_list over `ls`/`dir`, file_search over `grep`, get_current_time over `date`. Use shell_execute for git, npm, cargo, docker, package managers, or platform utilities without a dedicated tool. NEVER use to permanently delete without confirmation (rm -rf, Remove-Item -Recurse, git reset --hard). Default timeout 120 s; set higher only for known long-running builds.',
     parameters:[{name:'command',type:'string',description:'The full command to execute',required:true},
                 {name:'cwd',type:'string',description:'Working directory (optional, absolute preferred)',required:false},
                 {name:'timeout',type:'number',description:'Timeout in milliseconds (default: 120000)',required:false},
                 {name:'shell',type:'string',description:'Override shell: "powershell" | "cmd" | "bash" (default: auto)',required:false}]},
    {name:'code_execute', description:'Execute Python code in a fresh subprocess. Returns stdout, stderr, exit code. Use for math, data transforms, JSON/CSV parsing, one-off scripts. NOT a REPL — state does not persist between calls; import everything you need each time. For system commands and shell utilities, PREFER shell_execute. Default timeout 30 s.',
     parameters:[{name:'code',type:'string',description:'The Python source to execute (UTF-8)',required:true},
                 {name:'language',type:'string',description:'Programming language: "python" or "shell"',required:false}]},
    {name:'system_info', description:'Return desktop system info: OS, architecture, hostname, username, total RAM, CPU count. Zero arguments. Call once when output needs to be tailored to the user\'s platform; do not call repeatedly in a loop.',
     parameters:[]},
    {name:'process_list', description:'List the top 30 running processes sorted by memory: {name, pid, memory, cpu%}. Zero arguments. Use for task-manager-style queries ("is Chrome running?", "which process is eating RAM?"). There is NO process_kill tool — to kill a process use shell_execute with taskkill (Windows) or kill (Unix).',
     parameters:[]},
    {name:'screenshot', description:'Capture the primary display as a base64 PNG. Zero arguments. USE for visual verification when the user asks "what\'s on my screen" or "look at X". Returns a short summary string (size + filename); the actual image is forwarded to the model via message content. NEVER call in a tight loop — screenshots are expensive and privacy-sensitive.',
     parameters:[]},
    {name:'image_generate', description:'Generate an image from a text prompt via the local ComfyUI pipeline. Blocks up to 5 minutes. USE for "draw me", "make an image of", "generate a picture". NOT for photo editing — this is text-to-image only; no inpainting via this tool. First installed image model is auto-selected. Rate-limit yourself to 1 call per turn — ComfyUI serializes generations internally so parallel calls will queue, not speed up.',
     parameters:[{name:'prompt',type:'string',description:'Positive text description of the desired image',required:true},
                 {name:'negativePrompt',type:'string',description:'Things to avoid (blurry, deformed, etc.)',required:false}]},
    {name:'get_current_time', description:'Return the user\'s current local date, time, and timezone. Zero arguments. USE FIRST for any \'what day / time / date is it\' question — do NOT web_search or shell_execute `date`. The Rust backend probes the OS timezone on every call, so this is always authoritative.',
     parameters:[]}
  ];

  // ── Tool-set constants ──
  var CODEX_TOOLS = ['file_read','file_write','file_list','file_search','shell_execute','code_execute','system_info','get_current_time','web_search','web_fetch'];
  var AGENT_ALL_TOOLS = AGENT_TOOLS.map(function(t){return t.name;});

  // Convert the flat AGENT_TOOLS array into Ollama's native tools schema.
  // `toolNames` is a whitelist — only tools whose name appears in it are
  // included. Returns [{type:'function', function:{name, description,
  // parameters:{type:'object', properties:{...}, required:[...]}}}].
  function buildToolDefs(toolNames){
    var out = [];
    for(var i=0;i<AGENT_TOOLS.length;i++){
      var t = AGENT_TOOLS[i];
      if(toolNames.indexOf(t.name) === -1) continue;
      var props = {};
      var req = [];
      for(var j=0;j<t.parameters.length;j++){
        var p = t.parameters[j];
        props[p.name] = {type: p.type, description: p.description};
        if(p.required) req.push(p.name);
      }
      out.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: {type:'object', properties: props, required: req}
        }
      });
    }
    return out;
  }

  // Strip <think>...</think> tags from content. If keepThinking is true,
  // capture inner text into the returned `thinking` field; otherwise
  // discard it. Also handles Ollama's native `thinking` field.
  function stripThinkTags(content, keepThinking){
    var think = '';
    // Handle inline <think>...</think> tags (may be multiple)
    var cleaned = String(content || '').replace(/<think>([\s\S]*?)<\/think>/g, function(_, inner){
      if(keepThinking && inner) think = think ? think+'\n'+inner : inner;
      return '';
    });
    // Strip non-canonical reasoning tags too
    cleaned = stripNonCanonicalTags(cleaned).trim();
    return {content: cleaned, thinking: think};
  }

  // Non-streaming POST to /api/chat with native `tools` array.
  // Returns a Promise that resolves to {content, thinking, toolCalls}.
  // `apiMessages` = [{role, content, ...}], `tools` = Ollama tool defs.
  function nativeToolChat(apiMessages, tools){
    var body = {
      model: currentModel,
      messages: apiMessages,
      tools: tools,
      stream: false,
      options: {num_gpu: 99, num_predict: 16384}
    };
    // Tri-state think flag — same logic as _doSend.
    if(isThinkingCompatible(currentModel)){
      if(thinking){
        body.think = true;
      } else if(!isPlainTextPlanner(currentModel)){
        body.think = false;
      }
    }

    function doPost(b){
      return fetch('/api/chat',{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},
        body: JSON.stringify(b),
        signal: abortCtrl ? abortCtrl.signal : undefined
      });
    }

    return doPost(body).then(function(r){
      if(r.status===401){ clearAuthAndReload(); throw new Error('401'); }
      if(!r.ok){
        if(r.status===400 && ('think' in body)){
          var retry = {}; for(var k in body) retry[k]=body[k]; delete retry.think;
          return doPost(retry).then(function(rr){
            if(!rr.ok) return rr.text().then(function(t){throw new Error('HTTP '+rr.status+': '+t);});
            return rr.json();
          });
        }
        return r.text().then(function(t){
          // Detect "model does not support tools" errors
          if(t.indexOf('does not support tools') >= 0 || t.indexOf('does not support tool') >= 0){
            throw new Error('TOOLS_NOT_SUPPORTED');
          }
          throw new Error('HTTP '+r.status+': '+t);
        });
      }
      return r.json();
    }).then(function(data){
      var msg = data.message || {};
      var rawContent = msg.content || '';
      var rawThinking = msg.thinking || '';
      var toolCalls = [];
      if(Array.isArray(msg.tool_calls)){
        for(var i=0;i<msg.tool_calls.length;i++){
          var tc = msg.tool_calls[i];
          if(tc && tc.function){
            toolCalls.push({function:{name:tc.function.name, arguments:tc.function.arguments || {}}});
          }
        }
      }
      return {content: rawContent, thinking: rawThinking, toolCalls: toolCalls};
    });
  }

  // Run a single tool against the desktop via /remote-api/agent-tool.
  // Returns a stringified observation suitable for the next loop turn.
  // The Rust bridge returns 200 OK with {error:"..."} for every failure
  // (missing arg, permission, underlying tool error). We surface those
  // as clean observations instead of "HTTP 500: ..." red errors.
  function runAgentTool(tool, args){
    return fetch('/remote-api/agent-tool',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},
      // `chatId` → per-chat workspace on the desktop side. Each mobile
      // chat gets its own isolated `~/agent-workspace/<chatId>/` folder
      // so agents across chats don't trample each other's files.
      body: JSON.stringify({tool:tool, args:args||{}, chatId: currentChatId || ''})
    }).then(function(r){
      if(r.status===401){ clearAuthAndReload(); return 'Auth required'; }
      return r.text().then(function(text){
        // Try to parse JSON regardless of status — the new bridge always
        // responds with a JSON body.
        var data = null;
        try{ data = JSON.parse(text); }catch(_){ /* leave null */ }

        // Old-style HTTP errors (e.g. 400 from a malformed payload) — fall
        // back to plain text so the agent still sees something useful.
        if(!r.ok && !data){ return 'Error '+r.status+': '+text; }

        if(data){
          // Surface permission-denied with an actionable hint to enable it.
          if(data.needs_permission){
            // Give the user a one-tap path: bump the header plugins icon
            // pulse so they know to open Settings → Permissions.
            try{ window._flagPermissionGap && window._flagPermissionGap(data.permission); }catch(_){}
            return 'Permission denied: '+data.error;
          }
          // Generic tool error — clean observation.
          if(typeof data.error === 'string') return 'Error: '+data.error;
          if(typeof data === 'string') return data;
          // web_search returns {results:[{title,url,snippet},...]}
          if(Array.isArray(data.results)){
            if(!data.results.length) return 'No results.';
            return data.results.map(function(it,i){return (i+1)+'. '+(it.title||'')+'\n   '+(it.url||'')+'\n   '+(it.snippet||'');}).join('\n\n');
          }
          // web_fetch returns {url, status, contentType, title, text, truncated}
          if(typeof data.text === 'string' && (data.url || data.status !== undefined)){
            var parts = [];
            if(data.title) parts.push('Title: '+data.title);
            if(data.url) parts.push('URL: '+data.url);
            if(data.status !== undefined) parts.push('Status: '+data.status);
            parts.push('');
            parts.push(data.text || '(empty body)');
            if(data.truncated) parts.push('\n…(truncated to 24 000 chars)');
            return parts.join('\n');
          }
          // file_read returns {content:"..."}
          if(typeof data.content === 'string') return data.content;
          // file_write returns {status:"saved", path:"..."}
          if(data.status==='saved') return 'File saved: '+(data.path||args.path||'');
          // code_execute / shell_execute returns {stdout, stderr, exitCode, timedOut}
          if(data.exitCode!==undefined || data.stdout!==undefined){
            var out = data.stdout || '';
            var err = data.stderr || '';
            if(data.timedOut) return 'Execution timed out.';
            if(data.exitCode && data.exitCode!==0) return 'Error ('+data.exitCode+'):\n'+(err||out);
            return out || (err ? 'stderr: '+err : 'Done.');
          }
          return JSON.stringify(data);
        }
        return text || 'Done.';
      });
    }).catch(function(e){ return 'Network error: '+(e && e.message || e); });
  }

  // Highlights the Settings (cog) icon in the drawer when an agent tool
  // got blocked by a permission. Best-effort — we just toggle a class so
  // the user notices the dot. No-op if the drawer isn't mounted yet.
  window._flagPermissionGap = function(_perm){
    var sb = document.querySelector('.settings-btn');
    if(sb){ sb.classList.add('perm-gap'); }
  };

  function H(t){return String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function el(id){return document.getElementById(id);}
  function uid(){return 'c-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);}
  function mid(){return 'm-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);}
  function mkMsg(role, content, extra){
    var m = {id: mid(), role: role, content: content||'', thinking:'', thinkingOpen:false, agentSteps:[]};
    if(extra && typeof extra === 'object'){ for(var k in extra) if(Object.prototype.hasOwnProperty.call(extra,k)) m[k]=extra[k]; }
    return m;
  }

  function isThinkingCompatible(modelName){
    if(!modelName) return false;
    var name = String(modelName).toLowerCase();
    var baseName = name.replace(/^[^/]+\//,'').replace(/:.*$/,'').replace(/-abliterated/g,'').replace(/-uncensored/g,'');
    for(var i=0;i<THINKING_COMPATIBLE.length;i++){
      if(baseName.indexOf(THINKING_COMPATIBLE[i])===0) return true;
    }
    return false;
  }

  // ── Persistence ──
  function loadPersisted(){
    try{
      chats = JSON.parse(localStorage.getItem('lu-mobile-chats')||'[]') || [];
      if(!Array.isArray(chats)) chats = [];
      // Backfill caveman/persona/agent defaults on legacy chats
      for(var i=0;i<chats.length;i++){
        if(!chats[i].caveman) chats[i].caveman = 'off';
        if(!chats[i].personaId) chats[i].personaId = 'unrestricted';
        if(typeof chats[i].personaEnabled === 'undefined') chats[i].personaEnabled = false;
        if(typeof chats[i].agentEnabled === 'undefined') chats[i].agentEnabled = false;
        // Backfill message ids + empty thinking/agentSteps on legacy msgs
        if(Array.isArray(chats[i].msgs)){
          for(var j=0;j<chats[i].msgs.length;j++){
            var mm = chats[i].msgs[j];
            if(!mm.id) mm.id = 'm-'+Date.now()+'-'+Math.random().toString(36).slice(2,7)+'-'+j;
            if(mm.thinking === undefined) mm.thinking = '';
            if(!Array.isArray(mm.agentSteps)) mm.agentSteps = [];
            if(typeof mm.thinkingOpen === 'undefined') mm.thinkingOpen = false;
          }
        }
      }
      currentChatId = localStorage.getItem('lu-mobile-current-chat') || '';
      // `thinking` is always false now (UI toggle removed).
      thinking = false;
    }catch(_){chats=[];currentChatId='';thinking=false;}
  }
  function persistChats(){
    try{localStorage.setItem('lu-mobile-chats', JSON.stringify(chats));}catch(_){}
  }
  function persistState(){
    try{
      localStorage.setItem('lu-mobile-current-chat', currentChatId);
    }catch(_){}
  }
  function getCaveman(){var c=findChat(currentChatId); return c && c.caveman ? c.caveman : 'off';}
  function getPersonaId(){var c=findChat(currentChatId); return c && c.personaId ? c.personaId : 'unrestricted';}
  function getPersonaEnabled(){var c=findChat(currentChatId); return !!(c && c.personaEnabled);}
  function getAgentEnabled(){var c=findChat(currentChatId); return !!(c && c.agentEnabled);}
  function setAgentEnabled(v){var c=findChat(currentChatId); if(c){ c.agentEnabled = !!v; persistChats(); }}

  // ── Chat management ──
  function findChat(id){for(var i=0;i<chats.length;i++){if(chats[i].id===id) return chats[i];}return null;}
  function syncCurrentChat(){
    var c = findChat(currentChatId); if(!c) return;
    c.msgs = msgs.slice();
    // Title auto-derive from first user message
    if((!c.title || c.title==='New Chat' || c.title==='New Codex') && msgs.length){
      var firstUser = msgs.find(function(m){return m.role==='user';});
      if(firstUser){
        var t = firstUser.content.replace(/\s+/g,' ').trim().slice(0,32);
        if(t) c.title = t;
      }
    }
    persistChats();
  }
  function createChat(mode){
    var c = {id:uid(), title: mode==='codex'?'New Codex':'New Chat', mode:mode||'lu', caveman:'off', personaId:'unrestricted', personaEnabled:false, agentEnabled:false, createdAt:Date.now(), msgs:[], model: currentModel||''};
    chats.unshift(c);
    currentChatId = c.id;
    msgs = [];
    pendingImages = [];
    persistChats();
    persistState();
    return c;
  }
  function loadChat(id){
    var c = findChat(id); if(!c) return;
    // Save outgoing first
    syncCurrentChat();
    currentChatId = id;
    msgs = Array.isArray(c.msgs) ? c.msgs.slice() : [];
    pendingImages = [];
    persistState();
  }
  function deleteChat(id){
    chats = chats.filter(function(c){return c.id!==id;});
    if(currentChatId===id){
      if(chats.length){ currentChatId = chats[0].id; msgs = Array.isArray(chats[0].msgs) ? chats[0].msgs.slice() : []; }
      else{ createChat('lu'); return; }
    }
    persistChats(); persistState();
  }
  function getCurrentMode(){
    var c = findChat(currentChatId);
    return c ? (c.mode||'lu') : 'lu';
  }

  // ── System prompt builder ──
  function buildSystemPrompt(){
    var parts = [];
    var cm = getCaveman();
    if(cm!=='off' && CAVEMAN_PROMPTS[cm]) parts.push(CAVEMAN_PROMPTS[cm]);
    if(getCurrentMode()==='codex'){
      parts.push(CODEX_PROMPT);
    }else{
      var pid = getPersonaId();
      var p = PERSONAS.find(function(x){return x.id===pid;});
      if(getPersonaEnabled() && p && p.prompt){ parts.push(p.prompt); }
      else if(dispatchedSystemPrompt){ parts.push(dispatchedSystemPrompt); }
    }
    return parts.join('\n\n');
  }

  // ── Auth Screen ──
  if(!TOKEN){
    el('app').innerHTML =
      '<div class="auth-screen">' +
        '<img class="auth-mark" src="/LU-monogram-white.png" alt="">' +
        '<div class="auth-logo">LUncensored</div>' +
        '<div class="auth-sub">Remote</div>' +
        '<form class="auth-form" id="auth-form">' +
          '<div>' +
            '<div class="auth-label">Access Code</div>' +
            '<input class="auth-input" id="auth-code" type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="000000" autocomplete="off" autofocus>' +
          '</div>' +
          '<button class="auth-btn" type="submit">Connect</button>' +
          '<div class="auth-err" id="auth-err"></div>' +
        '</form>' +
      '</div>';
    el('auth-form').onsubmit = function(e){
      e.preventDefault();
      var code = el('auth-code').value.trim();
      var errEl = el('auth-err');
      if(code.length < 6){errEl.textContent='Enter 6-digit code';return;}
      errEl.textContent = '';
      fetch('/remote-api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({passcode:code})})
      .then(function(r){
        if(r.ok) return r.json().then(function(d){localStorage.setItem('lu-remote-token',d.token);location.reload();});
        if(r.status===429) return r.text().then(function(t){errEl.textContent=t;});
        errEl.textContent='Invalid access code';
      })
      .catch(function(){errEl.textContent='Connection failed';});
    };
    return;
  }

  // ── Load config + models then render ──
  function clearAuthAndReload(){
    localStorage.removeItem('lu-remote-token');
    location.reload();
  }
  function authJson(url){
    return fetch(url,{headers:{'Authorization':'Bearer '+TOKEN}})
      .then(function(r){
        if(r.status===401){clearAuthAndReload();throw new Error('401');}
        if(!r.ok) throw new Error('HTTP '+r.status);
        return r.json();
      })
      .catch(function(){return null;});
  }

  loadPersisted();

  // ── Keyboard / viewport tracking ────────────────────────────────
  // iOS Safari + some Android browsers do NOT resize `window.innerHeight`
  // when the software keyboard opens. The page sits at full height behind
  // the keyboard and the top of the chat scrolls off-screen. `dvh` CSS
  // units fix most cases; for the holdouts we sync an explicit
  // `--kb-height` custom prop and apply it as bottom-padding on the
  // input bar so it never hides behind the keyboard.
  (function setupViewportTracking(){
    if(typeof window.visualViewport === 'undefined') return;
    var vv = window.visualViewport;
    function sync(){
      // Height difference = keyboard + safe-area chrome on the bottom.
      var kb = Math.max(0, (window.innerHeight || 0) - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb-height', kb + 'px');
      // Also pin the scroll position to the bottom of the current chat
      // when the keyboard animates in, so the latest message stays visible.
      var cm = document.getElementById('chat-msgs');
      if(cm && kb > 0){ cm.scrollTop = cm.scrollHeight; }
    }
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    sync();
  })();
  Promise.all([authJson('/remote-api/config'), authJson('/api/tags')]).then(function(res){
    var cfg = res[0] || {};
    var tags = res[1] || {};
    availableModels = (tags.models || [])
      .map(function(m){return m.name || m.model || '';})
      .filter(function(n){return !!n;});
    var stored = localStorage.getItem('lu-mobile-model') || '';
    currentModel = (stored && availableModels.indexOf(stored) >= 0) ? stored
                 : (cfg.model && availableModels.indexOf(cfg.model) >= 0) ? cfg.model
                 : (cfg.model || availableModels[0] || '');
    dispatchedSystemPrompt = cfg.systemPrompt || '';

    // Ensure we have a current chat
    if(!currentChatId || !findChat(currentChatId)){
      if(chats.length){ currentChatId = chats[0].id; msgs = Array.isArray(chats[0].msgs) ? chats[0].msgs.slice() : []; }
      else{ createChat('lu'); }
    }else{
      var c = findChat(currentChatId);
      msgs = Array.isArray(c.msgs) ? c.msgs.slice() : [];
    }

    renderShell();
  });

  function renderShell(){
    var mode = getCurrentMode();
    var isCodex = mode === 'codex';
    var modeTag = isCodex ? '<span class="header-mode-tag">Codex</span>' :
                  (getAgentEnabled() ? '<span class="header-mode-tag">Agent</span>' : '');
    var pluginsActive = (getCaveman()!=='off' || getPersonaEnabled()) ? ' active' : '';
    var agentActive = getAgentEnabled() ? ' active' : '';
    // Agent icon STAYS smart_toy regardless of state. The button class
    // flips to `active` (purple) while running, click routes to _stopAgent.
    var agentClickHandler = agentRunning ? 'window._stopAgent()' : 'window._toggleAgent()';
    var agentLabel = agentRunning ? 'Stop agent' : 'Agent';
    var agentTitle = agentRunning ? 'Stop agent' : 'Agent mode (native tool calling)';
    var agentBtnCls = agentRunning ? 'active' : agentActive.trim();
    // Hidden in Codex chats (Codex on mobile is a coding-focused plain
    // chat, no phone-side tool execution).
    var agentBtn = isCodex ? '' :
      ('<button class="icon-btn '+agentBtnCls+'" id="agent-btn" onclick="'+agentClickHandler+'" aria-label="'+agentLabel+'" title="'+agentTitle+'">'+
         '<span class="material-symbols-outlined">'+svgIcon('smart_toy')+'</span>'+
       '</button>');

    // Thinking-toggle button REMOVED from mobile (user request): wasn't
    // working reliably and confused users. Thinking is now fully handled
    // under-the-hood: stripper silently drops any reasoning tokens regardless
    // of whether the model emitted canonical <think> or non-canonical tags.
    // The `thinking` variable stays as a constant `false` internally for the
    // few code paths that still reference it.

    el('app').innerHTML =
      '<div class="app-shell">' +
        '<div class="app-header">' +
          '<button class="icon-btn" onclick="window._toggleDrawer()" aria-label="Menu"><span class="material-symbols-outlined">'+svgIcon('menu')+'</span></button>' +
          '<span class="header-brand" aria-label="LUncensored">' +
            '<img class="header-mark" src="/LU-monogram-white.png" alt="LUncensored">' +
          '</span>' +
          modeTag +
          '<button class="model-badge" onclick="window._openModelPicker()" aria-label="Select model">' +
            '<span class="material-symbols-outlined" style="font-size:13px">'+svgIcon('auto_awesome')+'</span>' +
            '<span class="model-name">'+H(currentModel || 'Select model')+'</span>' +
            '<span class="material-symbols-outlined chev">'+svgIcon('expand_more')+'</span>' +
          '</button>' +
          agentBtn +
          '<button class="icon-btn'+pluginsActive+'" id="plugins-btn" onclick="window._openPluginsPicker()" aria-label="Plugins">' +
            '<span class="material-symbols-outlined">'+svgIcon('extension')+'</span>' +
          '</button>' +
        '</div>' +
        '<div class="chat-area" id="chat-area"></div>' +
        '<div class="input-bar">' +
          '<div class="img-preview-row" id="img-preview-row" style="display:none"></div>' +
          '<div class="input-row">' +
            '<button class="attach-btn" id="attach-btn" onclick="window._triggerAttach()" aria-label="Attach file"><span class="material-symbols-outlined">'+svgIcon('attach_file')+'</span></button>' +
            '<input type="file" id="file-input" accept="image/*" multiple style="display:none">' +
            '<textarea id="msg-input" rows="1" placeholder="'+(getAgentEnabled()?'Give the agent a goal…':'Message...')+'"></textarea>' +
            // Send-Button flips to a red Stop chip while a response is
            // in flight (streaming chat OR native tool loop). Without
            // this the only "stop" control was hidden in the header,
            // which users kept missing. Single id so CSS + handler both
            // route to the right action.
            (function(){
              var busy = streaming || agentRunning;
              var btnCls = busy ? 'send-btn cancel' : 'send-btn';
              var handler = busy ? 'window._cancelSend()' : 'window._doSend()';
              var label = busy ? 'Stop' : 'Send';
              var icon = busy ? 'stop' : 'arrow_upward';
              return '<button class="'+btnCls+'" id="send-btn" onclick="'+handler+'" aria-label="'+label+'" title="'+label+'"><span class="material-symbols-outlined">'+svgIcon(icon)+'</span></button>';
            })() +
          '</div>' +
        '</div>' +
      '</div>' +
      renderDrawer();

    setupInput();
    setupFileInput();
    renderChat();
    renderAttachments();
  }

  // ── Drawer ──
  function renderDrawer(){
    var chatHtml = '';
    if(!chats.length){
      chatHtml = '<div class="chat-empty">No chats yet</div>';
    }else{
      for(var i=0;i<chats.length;i++){
        var c = chats[i];
        var isActive = c.id===currentChatId;
        var tag = c.mode==='codex' ? '<span class="chat-item-mode">codex</span>' : '';
        var icon = c.mode==='codex' ? 'terminal' : 'chat_bubble';
        chatHtml += '<div class="chat-item'+(isActive?' active':'')+'" onclick="window._loadChat(\''+c.id+'\')">' +
                      '<span class="material-symbols-outlined">'+svgIcon(icon)+'</span>' +
                      '<span class="chat-item-title">'+H(c.title||'Untitled')+'</span>' +
                      tag +
                      '<button class="chat-item-del" onclick="event.stopPropagation();window._deleteChat(\''+c.id+'\')" aria-label="Delete"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
                    '</div>';
      }
    }

    return '<div class="drawer-backdrop'+(drawerOpen?' open':'')+'" onclick="window._toggleDrawer()"></div>' +
           '<aside class="drawer'+(drawerOpen?' open':'')+'">' +
             '<div class="drawer-header">' +
               '<span class="drawer-brand">' +
                 '<img class="drawer-mark" src="/LU-monogram-white.png" alt="">' +
                 '<span class="drawer-logo">LUncensored</span>' +
               '</span>' +
               '<button class="drawer-close" onclick="window._toggleDrawer()" aria-label="Close"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
             '</div>' +
             '<div class="drawer-body">' +
               '<div class="new-row">' +
                 '<button class="new-btn primary" onclick="window._newChat(\'lu\')"><span class="material-symbols-outlined">'+svgIcon('add')+'</span>Chat</button>' +
                 '<button class="new-btn" onclick="window._newChat(\'codex\')"><span class="material-symbols-outlined">'+svgIcon('terminal')+'</span>Codex</button>' +
               '</div>' +
               '<div class="section-label">Chats</div>' +
               chatHtml +
             '</div>' +
             '<div class="drawer-footer">' +
               '<button class="settings-btn" onclick="window._openSettingsSheet()">' +
                 '<span class="material-symbols-outlined">'+svgIcon('tune')+'</span>Settings' +
               '</button>' +
               '<button class="disconnect-btn" onclick="window._disconnect()">' +
                 '<span class="material-symbols-outlined">'+svgIcon('logout')+'</span>Disconnect' +
               '</button>' +
             '</div>' +
           '</aside>';
  }

  // ── Model picker ──
  window._openModelPicker = function(){
    var overlay = document.createElement('div');
    overlay.className = 'picker-overlay';
    overlay.onclick = function(e){if(e.target===overlay) document.body.removeChild(overlay);};
    var items = availableModels.length
      ? availableModels.map(function(name){
          var active = name === currentModel;
          return '<button class="picker-item'+(active?' active':'')+'" data-model="'+H(name)+'">' +
                   '<span>'+H(name)+'</span>' +
                   (active ? '<span class="material-symbols-outlined">'+svgIcon('check')+'</span>' : '') +
                 '</button>';
        }).join('')
      : '<div class="picker-empty">No models found. Start Ollama on the desktop app.</div>';
    overlay.innerHTML =
      '<div class="picker-sheet">' +
        '<div class="picker-header">' +
          '<span class="picker-title">Select Model</span>' +
          '<button class="picker-close" aria-label="Close"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
        '</div>' +
        '<div class="picker-list">' + items + '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.picker-close').onclick = function(){document.body.removeChild(overlay);};
    var buttons = overlay.querySelectorAll('.picker-item[data-model]');
    for(var i=0;i<buttons.length;i++){
      buttons[i].onclick = function(){
        var name = this.getAttribute('data-model');
        if(name){
          currentModel = name;
          try{localStorage.setItem('lu-mobile-model', name);}catch(_){}
          renderShell();
        }
        document.body.removeChild(overlay);
      };
    }
  };

  function setupInput(){
    var inp = el('msg-input');
    if(!inp) return;
    inp.addEventListener('input', function(){inp.style.height='auto';inp.style.height=Math.min(inp.scrollHeight,220)+'px';});
    inp.addEventListener('keydown', function(e){if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();window._doSend();}});
  }

  function setupFileInput(){
    var input = el('file-input');
    if(!input) return;
    input.onchange = function(e){
      var files = e.target.files;
      if(!files || !files.length) return;
      addFiles(files);
      input.value = '';
    };
  }

  function addFiles(fileList){
    var imageFiles = [];
    for(var i=0;i<fileList.length;i++){
      if(fileList[i].type && fileList[i].type.indexOf('image/')===0) imageFiles.push(fileList[i]);
    }
    if(!imageFiles.length) return;
    var promises = imageFiles.map(function(f){
      return new Promise(function(resolve){
        var reader = new FileReader();
        reader.onload = function(){
          var dataUrl = reader.result;
          var base64 = String(dataUrl).split(',')[1] || '';
          resolve({data:base64, mimeType:f.type||'image/png', name:f.name||'image.png'});
        };
        reader.onerror = function(){resolve(null);};
        reader.readAsDataURL(f);
      });
    });
    Promise.all(promises).then(function(items){
      items = items.filter(Boolean);
      pendingImages = pendingImages.concat(items).slice(0, 5);
      renderAttachments();
    });
  }

  function renderAttachments(){
    var row = el('img-preview-row');
    if(!row) return;
    if(!pendingImages.length){ row.style.display='none'; row.innerHTML=''; return; }
    row.style.display='flex';
    var html = '';
    for(var i=0;i<pendingImages.length;i++){
      var im = pendingImages[i];
      html += '<div class="img-preview">' +
                '<img src="data:'+H(im.mimeType)+';base64,'+im.data+'" alt="">' +
                '<button class="img-preview-del" onclick="window._removeImage('+i+')" aria-label="Remove"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
              '</div>';
    }
    row.innerHTML = html;
  }

  function renderChat(){
    var p = el('chat-area');
    if(!p) return;
    if(!msgs.length){
      var mode = getCurrentMode();
      var tag = mode==='codex' ? 'Codex Mode'
              : getAgentEnabled() ? 'Agent Mode'
              : (currentModel ? 'Ready' : 'Select a model');
      p.innerHTML =
        '<div class="chat-welcome">' +
          '<img class="chat-welcome-mark" src="/LU-monogram-white.png" alt="">' +
          '<div class="chat-welcome-logo">LUncensored</div>' +
          '<div class="chat-welcome-tag">'+H(tag)+'</div>' +
        '</div>';
      return;
    }
    var html = '<div class="chat-messages" id="chat-msgs">';
    for(var i=0;i<msgs.length;i++){
      var m = msgs[i];
      // Skip hidden tool-call history (persisted for continue capability
      // but not user-visible). The model sees them on the next turn.
      if(m.hidden) continue;
      var isUser = m.role==='user';
      var isLast = i===msgs.length-1;
      var typingCls = (streaming && isLast && !isUser) ? ' msg-typing' : '';
      html += '<div class="msg-group '+(isUser?'user':'bot')+'" data-msg-idx="'+i+'">';
      if(isUser && Array.isArray(m.images) && m.images.length){
        html += '<div class="msg-imgs">';
        for(var ii=0; ii<m.images.length; ii++){
          var im = m.images[ii];
          html += '<img src="data:'+H(im.mimeType||'image/png')+';base64,'+im.data+'" alt="">';
        }
        html += '</div>';
      }
      // Thinking block never rendered on mobile — the toggle was removed
      // (user request: "thinking toggle im Mobile ersetzt / rausgenommen").
      // Any accidentally captured reasoning text lives in `m.thinking` but
      // is NOT shown; the stripper drops incoming reasoning bytes at the
      // source so `m.thinking` usually stays empty anyway.
      // Agent steps (transient, during / after a run). These stay visible
      // but they are NOT part of msg.content — so the next user turn does
      // not see the ReAct scaffolding and cannot drift into that style.
      // Collapsed by default. The active (last) step of a running agent
      // is auto-opened so the user sees live progress.
      if(!isUser && Array.isArray(m.agentSteps) && m.agentSteps.length){
        html += '<div class="agent-steps">';
        for(var si=0; si<m.agentSteps.length; si++){
          var st = m.agentSteps[si];
          var stIcon = st.type==='thought' ? 'brain'
                     : st.type==='action' ? 'smart_toy'
                     : st.type==='observation' ? 'check'
                     : st.type==='error' ? 'close'
                     : 'auto_awesome';
          var openCls = st.open ? ' open' : '';
          // Live = step is still in flight (model streaming its JSON, or
          // the tool hasn't returned yet). Triggers the pulsing stripe CSS.
          var liveCls = st.live ? ' live' : '';
          var summary = String(st.content||'').replace(/\s+/g,' ').slice(0, 80);
          if((st.content||'').length > 80) summary += '…';
          var stepKey = m.id + ':' + si;
          html += '<div class="agent-step agent-'+H(st.type||'info')+openCls+liveCls+'">' +
                    '<button class="agent-step-toggle" onclick="window._toggleAgentStep(\''+H(stepKey)+'\')">' +
                      '<span class="material-symbols-outlined agent-step-icon">'+svgIcon(stIcon)+'</span>' +
                      '<span class="agent-step-label">'+H(st.type||'info')+'</span>' +
                      '<span class="agent-step-summary">'+H(summary)+'</span>' +
                      '<span class="material-symbols-outlined agent-step-chev">'+svgIcon('expand_more')+'</span>' +
                    '</button>' +
                    '<div class="agent-step-content">'+renderMd(st.content||'')+'</div>' +
                  '</div>';
        }
        html += '</div>';
      }
      if(m.content || !isUser){
        html += '<div class="msg-bubble '+(isUser?'user':'bot')+typingCls+'">';
        html += isUser ? H(m.content) : renderMd(m.content);
        html += '</div>';
      }
      if(isUser){
        html += '<div class="msg-actions msg-actions-user">';
        html += '<button class="msg-action-btn" title="Edit" onclick="window._editMsg(\''+m.id+'\')"><span class="material-symbols-outlined">'+svgIcon('pencil')+'</span></button>';
        html += '<button class="msg-action-btn" title="Copy" onclick="window._copyMsg('+i+')"><span class="material-symbols-outlined">'+svgIcon('content_copy')+'</span></button>';
        html += '</div>';
      } else {
        html += '<div class="msg-model">'+H(currentModel)+'</div>';
        html += '<div class="msg-actions">';
        var canRegen = !streaming && !agentRunning;
        html += '<button class="msg-action-btn" title="Copy" onclick="window._copyMsg('+i+')"><span class="material-symbols-outlined">'+svgIcon('content_copy')+'</span></button>';
        if(canRegen){
          html += '<button class="msg-action-btn" title="Regenerate" onclick="window._regenMsg(\''+m.id+'\')"><span class="material-symbols-outlined">'+svgIcon('refresh')+'</span></button>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    p.innerHTML = html;
    var cm = el('chat-msgs');
    if(cm) cm.scrollTop = cm.scrollHeight;
  }

  // Persistent expand/collapse state for individual code blocks. Keyed by
  // a stable hash of (language + content) so the state survives re-renders
  // of the chat. Same hash is used for the HTML-preview blob lookup.
  var codeBlockOpen = {};
  // Cache of code payloads — Preview button reads from here without having
  // to re-extract from the rendered DOM. Keyed by the same djb2 hash.
  var codeBlockSource = {};

  function djb2(str){
    var h = 5381;
    for(var i=0;i<str.length;i++){ h = ((h << 5) + h) ^ str.charCodeAt(i); h |= 0; }
    // Force unsigned + base36 for short stable ID
    return (h >>> 0).toString(36);
  }
  // Heuristic: this code block IS a renderable HTML document.
  function isHtmlSnippet(lang, raw){
    var l = (lang || '').toLowerCase();
    if(l === 'html' || l === 'htm' || l === 'xhtml' || l === 'svg') return true;
    var t = raw.trim().toLowerCase();
    if(!t) return false;
    if(t.indexOf('<!doctype html') === 0) return true;
    if(t.indexOf('<html') === 0) return true;
    if(t.indexOf('<svg') === 0 && t.indexOf('xmlns') > 0) return true;
    return false;
  }
  // Bug #4 / Feature #8: code blocks are collapsed by default if longer
  // than COLLAPSE_THRESHOLD lines (parity with desktop CodeBlock.tsx).
  // Renderable HTML/SVG also gets a "Preview" chip → opens a sandboxed
  // iframe overlay in `_openHtmlPreview`.
  var COLLAPSE_THRESHOLD = 4;

  function renderMd(text){
    var s = H(text);
    s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, function(_, lang, code){
      var rawCode = code.replace(/\n$/, ''); // trim trailing newline
      var rawHtmlEscaped = H(rawCode);
      var lines = rawCode.split('\n');
      var lineCount = lines.length;
      var langLabel = (lang || 'code').toLowerCase();
      var key = djb2(langLabel + '\n' + rawCode);
      // Cache the original source so the Preview button can read it back.
      codeBlockSource[key] = { lang: langLabel, code: rawCode };
      var isLong = lineCount > COLLAPSE_THRESHOLD;
      var expanded = !isLong || codeBlockOpen[key] === true;
      var displayCode = expanded
        ? rawHtmlEscaped
        : H(lines.slice(0, COLLAPSE_THRESHOLD).join('\n'));
      var htmlPreview = isHtmlSnippet(langLabel, rawCode);
      var previewBtn = htmlPreview
        ? '<button class="cb-action" onclick="window._openHtmlPreview(\''+key+'\')" aria-label="Preview HTML"><span class="material-symbols-outlined">'+svgIcon('eye')+'</span><span class="cb-action-label">Preview</span></button>'
        : '';
      var toggleBtn = isLong
        ? '<button class="cb-toggle" onclick="window._toggleCodeBlock(\''+key+'\')"><span class="material-symbols-outlined cb-chev">'+svgIcon('expand_more')+'</span>'+(expanded?'Collapse':('Show all '+lineCount+' lines'))+'</button>'
        : '';
      return ''+
        '<div class="cb-wrap'+(expanded?' open':'')+'" data-cb-id="'+key+'">'+
          '<div class="cb-head">'+
            '<span class="cb-lang">'+H(langLabel)+'</span>'+
            '<div class="cb-actions">'+
              previewBtn +
              '<button class="cb-action" onclick="window._copyCodeKey(\''+key+'\')" aria-label="Copy"><span class="material-symbols-outlined">'+svgIcon('content_copy')+'</span><span class="cb-action-label">Copy</span></button>'+
            '</div>'+
          '</div>'+
          '<pre class="cb-pre"><code>'+displayCode+'</code></pre>'+
          toggleBtn +
        '</div>';
    });
    s = s.replace(/`([^`]+)`/g,'<code>$1</code>');
    s = s.replace(/\*\*(.+?)\*\*/g,'<b>$1</b>');
    return s;
  }

  // Toggle handler for the "Show all N lines" / "Collapse" button.
  window._toggleCodeBlock = function(key){
    codeBlockOpen[key] = !codeBlockOpen[key];
    renderChat();
  };
  // Copy handler that reads from our cache (no DOM scraping → handles
  // collapsed blocks correctly).
  window._copyCodeKey = function(key){
    var src = codeBlockSource[key];
    if(src && src.code) navigator.clipboard.writeText(src.code).catch(function(){});
  };
  // Feature #8: full-screen sandboxed HTML preview. Opens an iframe with
  // `srcdoc` + sandbox flags so user-supplied JS can't reach the parent
  // page. "Open in new tab" button hands the data: URL to the host
  // browser for full inspection. Tap backdrop or close icon to dismiss.
  window._openHtmlPreview = function(key){
    var src = codeBlockSource[key];
    if(!src) return;
    var raw = src.code || '';
    var lang = (src.lang || '').toLowerCase();
    var doc = raw;
    // Bare SVG → wrap so the iframe centres it.
    if(lang === 'svg' || (raw.trim().toLowerCase().indexOf('<svg') === 0 && raw.indexOf('xmlns') > 0)){
      doc = '<!doctype html><html><head><meta charset="utf-8"><title>SVG Preview</title>' +
            '<style>html,body{margin:0;padding:0;background:#0e0e0e;color:#ffffff;height:100%;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif}svg{max-width:100%;max-height:100%}</style>' +
            '</head><body>'+raw+'</body></html>';
    } else if(raw.trim().toLowerCase().indexOf('<!doctype') !== 0 &&
              raw.trim().toLowerCase().indexOf('<html') !== 0){
      // Snippet-only HTML → wrap in a minimal doc so meta-charset is set.
      doc = '<!doctype html><html><head><meta charset="utf-8"><title>HTML Preview</title>' +
            '<style>body{margin:0;padding:16px;font-family:system-ui,-apple-system,sans-serif}</style>' +
            '</head><body>'+raw+'</body></html>';
    }
    var overlay = document.createElement('div');
    overlay.className = 'html-preview-overlay';
    overlay.onclick = function(e){ if(e.target === overlay) document.body.removeChild(overlay); };
    var dataUrl = 'data:text/html;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent(doc)));
    overlay.innerHTML =
      '<div class="html-preview-shell">' +
        '<div class="html-preview-header">' +
          '<span class="html-preview-title"><span class="material-symbols-outlined">'+svgIcon('eye')+'</span>HTML Preview</span>' +
          '<div class="html-preview-actions">' +
            '<button class="html-preview-action" id="hpv-open" aria-label="Open in new tab"><span class="material-symbols-outlined">'+svgIcon('open_in_new')+'</span></button>' +
            '<button class="html-preview-action" id="hpv-close" aria-label="Close"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
          '</div>' +
        '</div>' +
        '<iframe class="html-preview-frame" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>' +
      '</div>';
    document.body.appendChild(overlay);
    var iframe = overlay.querySelector('.html-preview-frame');
    if(iframe){
      // srcdoc is the most reliable cross-mobile way to push HTML in
      // without escaping pain. Falls back to data URL if browser blocks.
      try{ iframe.srcdoc = doc; }
      catch(_){ iframe.src = dataUrl; }
    }
    var openBtn = overlay.querySelector('#hpv-open');
    if(openBtn) openBtn.onclick = function(){ window.open(dataUrl, '_blank'); };
    var closeBtn = overlay.querySelector('#hpv-close');
    if(closeBtn) closeBtn.onclick = function(){ document.body.removeChild(overlay); };
  };

  // ── Exposed handlers ──
  window._toggleDrawer = function(){
    drawerOpen = !drawerOpen;
    var d = document.querySelector('.drawer');
    var b = document.querySelector('.drawer-backdrop');
    if(d) d.classList.toggle('open', drawerOpen);
    if(b) b.classList.toggle('open', drawerOpen);
  };
  window._newChat = function(mode){
    syncCurrentChat();
    createChat(mode==='codex'?'codex':'lu');
    drawerOpen = false;
    renderShell();
  };
  window._loadChat = function(id){
    loadChat(id);
    drawerOpen = false;
    renderShell();
  };
  window._deleteChat = function(id){
    deleteChat(id);
    renderShell();
    var d=document.querySelector('.drawer'); if(d) d.classList.add('open');
    var bd=document.querySelector('.drawer-backdrop'); if(bd) bd.classList.add('open');
    drawerOpen = true;
  };
  // _toggleThinking removed — mobile has no thinking toggle anymore.
  // Kept as a no-op stub so stale handlers (any lingering cached page)
  // don't throw when clicked.
  window._toggleThinking = function(){};
  window._toggleAgent = function(){
    if(streaming || agentRunning) return;
    setAgentEnabled(!getAgentEnabled());
    renderShell();
  };
  window._stopAgent = function(){ agentAbort = true; };

  // Single-button cancel: stops whichever mode is currently running.
  // Streaming chat → abort the fetch. Agent loop → flip the agentAbort
  // flag so the next iteration bails cleanly. User can hit this from
  // the input-bar Send (which flips to Stop while busy) OR from the
  // header Agent icon (also flips to Stop while an agent is running).
  window._cancelSend = function(){
    if(streaming && abortCtrl){
      try{ abortCtrl.abort(); }catch(_){}
    }
    if(agentRunning){
      agentAbort = true;
    }
  };
  window._triggerAttach = function(){
    var f = el('file-input'); if(f) f.click();
  };
  window._removeImage = function(idx){
    pendingImages.splice(idx,1);
    renderAttachments();
  };
  window._setCaveman = function(lv){
    var c = findChat(currentChatId); if(c){ c.caveman = lv; persistChats(); }
    updatePluginsPicker();
    updatePluginsHeaderBadge();
  };
  window._setPersona = function(id){
    var c = findChat(currentChatId);
    if(c){
      c.personaId = id;
      c.personaEnabled = true; // picking a persona turns it on
      persistChats();
    }
    updatePluginsPicker();
    updatePluginsHeaderBadge();
  };
  function updatePluginsHeaderBadge(){
    var btn = el('plugins-btn');
    if(!btn) return;
    if(getCaveman()!=='off' || getPersonaEnabled()) btn.classList.add('active');
    else btn.classList.remove('active');
  }
  function updatePluginsPicker(){
    var overlay = document.querySelector('.picker-overlay.plugins-picker');
    if(!overlay) return;
    overlay.querySelector('.picker-list').innerHTML = pluginsPickerBodyHtml();
    bindPluginsPicker(overlay);
  }
  // Each time the sheet opens, both sections start collapsed
  var pluginsOpen = {caveman:false, persona:false};
  function pluginsPickerBodyHtml(){
    var cm = getCaveman();
    var pid = getPersonaId();
    var penabled = getPersonaEnabled();
    var chips = ['off','lite','full','ultra'].map(function(lv){
      var label = lv==='off' ? 'Off' : lv.charAt(0).toUpperCase()+lv.slice(1);
      return '<button class="caveman-chip'+(cm===lv?' active':'')+'" data-caveman="'+lv+'">'+label+'</button>';
    }).join('');
    var personas = PERSONAS.map(function(p){
      var active = penabled && pid===p.id;
      return '<button class="picker-item'+(active?' active':'')+'" data-persona="'+H(p.id)+'">' +
               '<span>'+H(p.name)+'</span>' +
               (active ? '<span class="material-symbols-outlined">'+svgIcon('check')+'</span>' : '') +
             '</button>';
    }).join('');
    var cavemanLabel = cm==='off' ? '' : cm.charAt(0).toUpperCase()+cm.slice(1);
    var activePersona = PERSONAS.find(function(p){return p.id===pid;});
    var personaLabel = penabled && activePersona ? activePersona.name : '';

    return '<div class="plug-folder">' +
             '<div class="plug-row'+(pluginsOpen.caveman?' open':'')+'" data-toggle="caveman">' +
               '<span class="plug-name">Caveman Mode</span>' +
               (cavemanLabel ? '<span class="plug-value">'+H(cavemanLabel)+'</span>' : '') +
               '<span class="material-symbols-outlined plug-chev">'+svgIcon('expand_more')+'</span>' +
             '</div>' +
             (pluginsOpen.caveman ? '<div class="caveman-row">'+chips+'</div>' : '') +
           '</div>' +
           '<div class="plug-folder">' +
             '<div class="plug-row'+(pluginsOpen.persona?' open':'')+'" data-toggle="persona">' +
               '<span class="plug-name">Persona</span>' +
               (personaLabel ? '<span class="plug-value">'+H(personaLabel)+'</span>' : '') +
               '<label class="plug-switch" onclick="event.stopPropagation()" aria-label="Toggle persona">' +
                 '<input type="checkbox" data-persona-enabled'+(penabled?' checked':'')+'>' +
                 '<span class="plug-switch-track"></span>' +
               '</label>' +
               '<span class="material-symbols-outlined plug-chev">'+svgIcon('expand_more')+'</span>' +
             '</div>' +
             (pluginsOpen.persona ? '<div class="plugins-persona-list">'+personas+'</div>' : '') +
           '</div>';
  }
  function bindPluginsPicker(overlay){
    var chips = overlay.querySelectorAll('.caveman-chip[data-caveman]');
    for(var i=0;i<chips.length;i++){
      chips[i].onclick = function(){ window._setCaveman(this.getAttribute('data-caveman')); };
    }
    var pitems = overlay.querySelectorAll('.picker-item[data-persona]');
    for(var j=0;j<pitems.length;j++){
      pitems[j].onclick = function(){ window._setPersona(this.getAttribute('data-persona')); };
    }
    var toggles = overlay.querySelectorAll('.plug-row[data-toggle]');
    for(var k=0;k<toggles.length;k++){
      toggles[k].onclick = function(){
        var key = this.getAttribute('data-toggle');
        pluginsOpen[key] = !pluginsOpen[key];
        updatePluginsPicker();
      };
    }
    var pswitch = overlay.querySelector('[data-persona-enabled]');
    if(pswitch){
      pswitch.onchange = function(){
        var c = findChat(currentChatId);
        if(c){
          c.personaEnabled = !!this.checked;
          // If enabling without a picked persona, auto-open the list so user can pick
          if(c.personaEnabled && c.personaId==='unrestricted'){ pluginsOpen.persona = true; }
          persistChats();
        }
        updatePluginsPicker();
        updatePluginsHeaderBadge();
      };
    }
  }
  window._openPluginsPicker = function(){
    pluginsOpen = {caveman:false, persona:false}; // always open collapsed
    var overlay = document.createElement('div');
    overlay.className = 'picker-overlay plugins-picker';
    overlay.onclick = function(e){if(e.target===overlay) document.body.removeChild(overlay);};
    overlay.innerHTML =
      '<div class="picker-sheet">' +
        '<div class="picker-header">' +
          '<span class="picker-title">Plugins</span>' +
          '<button class="picker-close" aria-label="Close"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
        '</div>' +
        '<div class="picker-list">' + pluginsPickerBodyHtml() + '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.picker-close').onclick = function(){document.body.removeChild(overlay);};
    bindPluginsPicker(overlay);
  };

  // ── Settings sheet — Remote Permissions only ──
  // Mirrors the desktop's Settings → Remote Access → Permissions section.
  // Reads/writes /remote-api/permissions. Each toggle gates a category of
  // endpoints server-side (see proxy_ollama / proxy_comfyui in remote.rs).
  var PERMISSION_META = [
    {key:'filesystem',      label:'Filesystem',       desc:'Agent can read/write files + run code on the desktop.'},
    {key:'downloads',       label:'Downloads',        desc:'Agent can trigger model pulls / installs (Ollama + ComfyUI).'},
    {key:'process_control', label:'Process Control',  desc:'Remote clients can access ComfyUI (generate images / video).'}
  ];

  function fetchRemotePerms(){
    return fetch('/remote-api/permissions',{
      headers:{'Authorization':'Bearer '+TOKEN}
    }).then(function(r){
      if(r.status===401){ clearAuthAndReload(); throw new Error('401'); }
      if(!r.ok) throw new Error('HTTP '+r.status);
      return r.json();
    }).then(function(p){
      remotePerms = {
        filesystem: !!p.filesystem,
        downloads: !!p.downloads,
        process_control: !!p.process_control
      };
      return remotePerms;
    });
  }
  function saveRemotePerms(){
    return fetch('/remote-api/permissions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},
      body: JSON.stringify(remotePerms)
    });
  }

  window._openSettingsSheet = function(){
    var overlay = document.createElement('div');
    overlay.className = 'picker-overlay';
    overlay.onclick = function(e){ if(e.target===overlay) document.body.removeChild(overlay); };

    function renderBody(){
      var rows = PERMISSION_META.map(function(m){
        var on = !!remotePerms[m.key];
        return '<label class="perm-row" data-key="'+m.key+'">' +
                 '<div class="perm-text">' +
                   '<div class="perm-label">'+H(m.label)+'</div>' +
                   '<div class="perm-desc">'+H(m.desc)+'</div>' +
                 '</div>' +
                 '<span class="plug-switch">' +
                   '<input type="checkbox" data-pk="'+m.key+'"'+(on?' checked':'')+'>' +
                   '<span class="plug-switch-track"></span>' +
                 '</span>' +
               '</label>';
      }).join('');
      return '<div class="settings-section-label">Remote Permissions</div>' +
             '<div class="perm-note">These control what <em>any</em> mobile connected to this session is allowed to do on the desktop.</div>' +
             rows;
    }

    overlay.innerHTML =
      '<div class="picker-sheet">' +
        '<div class="picker-header">' +
          '<span class="picker-title">Settings</span>' +
          '<button class="picker-close" aria-label="Close"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
        '</div>' +
        '<div class="picker-list" id="settings-body"><div class="perm-loading">Loading…</div></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.picker-close').onclick = function(){ document.body.removeChild(overlay); };

    fetchRemotePerms().then(function(){
      var body = overlay.querySelector('#settings-body');
      if(!body) return;
      body.innerHTML = renderBody();
      var boxes = body.querySelectorAll('input[type=checkbox][data-pk]');
      for(var i=0;i<boxes.length;i++){
        (function(cb){
          cb.addEventListener('change', function(){
            var key = cb.getAttribute('data-pk');
            remotePerms[key] = cb.checked;
            saveRemotePerms().catch(function(e){
              cb.checked = !cb.checked;
              remotePerms[key] = cb.checked;
              alert('Could not save: '+(e && e.message || e));
            });
          });
        })(boxes[i]);
      }
    }).catch(function(e){
      var body = overlay.querySelector('#settings-body');
      if(body) body.innerHTML = '<div class="perm-loading" style="color:var(--error)">Failed to load: '+H(String(e && e.message || e))+'</div>';
    });
  };

  window._copyMsg = function(idx){
    if(msgs[idx]) navigator.clipboard.writeText(msgs[idx].content).catch(function(){});
  };
  window._copyCode = function(btn){
    var pre = btn.parentElement;
    if(!pre) return;
    var code = pre.querySelector('code');
    if(code) navigator.clipboard.writeText(code.textContent).catch(function(){});
  };
  window._toggleThink = function(msgId){
    for(var i=0;i<msgs.length;i++){
      if(msgs[i].id === msgId){
        msgs[i].thinkingOpen = !msgs[i].thinkingOpen;
        renderChat();
        return;
      }
    }
  };
  window._toggleAgentStep = function(stepKey){
    var parts = stepKey.split(':');
    if(parts.length < 2) return;
    var msgId = parts[0], idx = Number(parts[1]);
    for(var i=0;i<msgs.length;i++){
      if(msgs[i].id === msgId){
        if(Array.isArray(msgs[i].agentSteps) && msgs[i].agentSteps[idx]){
          msgs[i].agentSteps[idx].open = !msgs[i].agentSteps[idx].open;
          renderChat();
        }
        return;
      }
    }
  };
  // ── Regenerate: drop the given assistant msg + everything after, resend the preceding user msg.
  // Parity with desktop useChat.ts regenerateMessage().
  window._regenMsg = function(msgId){
    if(streaming || agentRunning) return;
    var idx = -1;
    for(var i=0;i<msgs.length;i++){ if(msgs[i].id === msgId){ idx = i; break; } }
    if(idx < 1) return;
    var userMsg = msgs[idx-1];
    if(!userMsg || userMsg.role !== 'user') return;
    // Truncate to just-before-user, then replay the user text
    msgs.splice(idx-1);
    syncCurrentChat();
    renderChat();
    // Reuse the send path by re-injecting the user text.
    var input = el('msg-input'); if(input){ input.value = userMsg.content; window._doSend(); }
    else {
      // Fallback: manually push and dispatch
      var u = mkMsg('user', userMsg.content, userMsg.images ? {images: userMsg.images} : null);
      msgs.push(u); msgs.push(mkMsg('assistant',''));
      renderChat();
    }
  };
  // ── Edit: turn user bubble into inline textarea, save rewrites + resends from that point.
  // Parity with desktop useChat.ts editAndResend().
  window._editMsg = function(msgId){
    if(streaming || agentRunning) return;
    var idx = -1;
    for(var i=0;i<msgs.length;i++){ if(msgs[i].id === msgId){ idx = i; break; } }
    if(idx < 0 || msgs[idx].role !== 'user') return;
    var node = document.querySelector('.msg-group[data-msg-idx="'+idx+'"] .msg-bubble.user');
    if(!node) return;
    var original = msgs[idx].content;
    node.classList.add('editing');
    node.innerHTML =
      '<textarea class="msg-edit-area" id="msg-edit-ta">'+H(original)+'</textarea>' +
      '<div class="msg-edit-row">' +
        '<button class="msg-edit-btn" id="msg-edit-cancel">Cancel</button>' +
        '<button class="msg-edit-btn primary" id="msg-edit-save">Save &amp; Resend</button>' +
      '</div>';
    var ta = el('msg-edit-ta');
    if(ta){ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    el('msg-edit-cancel').onclick = function(){ renderChat(); };
    el('msg-edit-save').onclick = function(){
      var newVal = el('msg-edit-ta').value.trim();
      if(!newVal){ renderChat(); return; }
      // Drop this message and everything after, then resend with the new content.
      msgs.splice(idx);
      syncCurrentChat();
      renderChat();
      var inp = el('msg-input'); if(inp){ inp.value = newVal; window._doSend(); }
    };
  };
  window._disconnect = function(){
    localStorage.removeItem('lu-remote-token');
    location.reload();
  };

  // ── Mirror to desktop ──
  // LU mode       → appends to the desktop's dispatched Remote conversation.
  // Codex mode    → creates / appends to a desktop Codex conversation named
  //                 after the mobile chat title. That way "codex chat on
  //                 mobile must also show up in Codex in the app with
  //                 content" (user request).
  function postChatEvent(role, content){
    if(!content) return;
    // Safety filter: never mirror bare "Continue." to the desktop.
    // Legacy from the old ReAct loop; kept as defense in depth.
    if(role === 'user' && /^\s*continue\.?\s*$/i.test(content)) return;
    var c = findChat(currentChatId);
    if(!c) return;
    var mode = c.mode === 'codex' ? 'codex' : 'lu';
    try{
      fetch('/remote-api/chat-event',{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},
        body:JSON.stringify({
          role:role,
          content:content,
          model:currentModel||'',
          mode:mode,
          chat_id:c.id||'',
          chat_title:c.title||''
        })
      }).catch(function(){});
    }catch(_){}
  }

  // ── Send ──
  window._doSend = function(){
    var inp = el('msg-input');
    var text = inp.value.trim();
    var hasImages = pendingImages.length > 0;
    if((!text && !hasImages) || streaming || agentRunning) return;
    if(!currentModel){window._openModelPicker();return;}

    var userMsg = mkMsg('user', text, hasImages ? {images: pendingImages.slice()} : null);
    msgs.push(userMsg);
    msgs.push(mkMsg('assistant', ''));

    inp.value='';inp.style.height='auto';
    var sentImages = pendingImages.slice();
    pendingImages = [];
    renderAttachments();

    // Mirror user message to desktop (text only)
    postChatEvent('user', text);

    // Agent / Codex mode? Use native Ollama tool calling instead of
    // plain streaming chat. Codex chats ALWAYS run tools (no toggle),
    // matching desktop Codex which is agentic by design. Plain LU chats
    // only run tools when the user toggled Agent on in the header.
    var isCodexChat = getCurrentMode() === 'codex';
    if(getAgentEnabled() || isCodexChat){
      var toolNames = isCodexChat ? CODEX_TOOLS : AGENT_ALL_TOOLS;
      var sysPrompt = buildSystemPrompt();
      var kindLabel = isCodexChat ? 'Codex' : 'Agent';
      runToolLoop(sysPrompt, toolNames, kindLabel);
      return;
    }

    streaming=true;
    // Re-render the input bar so the Send-Button flips to the red Stop
    // chip. Without this the user has no visible way to cancel a chat
    // that hangs on an over-eager thinking model.
    renderShell();
    renderChat();

    // Build API messages
    var apiMsgs = [];
    var sys = buildSystemPrompt();
    if(sys) apiMsgs.push({role:'system',content:sys});
    var cm = getCaveman();
    for(var i=0;i<msgs.length-1;i++){
      var m = msgs[i];
      var content = m.content;
      // Caveman per-message reminder — prepend on every user message.
      // Parity with desktop (useChat.ts line 142): the reminder fires
      // unconditionally so the model doesn't drift on turn 2+. Without
      // this, thinking-compatible models silently dropped Caveman style
      // after the first response (was: only !isThinkingCompatible).
      if(m.role==='user' && cm!=='off' && CAVEMAN_REMINDERS[cm]){
        content = CAVEMAN_REMINDERS[cm] + '\n' + content;
      }
      var apiMsg = {role:m.role, content:content};
      if(m.images && m.images.length){ apiMsg.images = m.images.map(function(im){return im.data;}); }
      apiMsgs.push(apiMsg);
    }

    // Token budget: 16 384 is a balance between "no truncation of the
    // assistant's visible message" (previous default of 4000 was too low)
    // and "don't let tagged-thinking models loop forever" (true `-1`
    // caused Gemma 3/4 to think without ever emitting an answer). 16 k is
    // enough for the longest reasonable agent reply plus deep thinking.
    var body = {model:currentModel, messages:apiMsgs, stream:true, options:{num_gpu:99, num_predict:16384}};
    // Tri-state: for thinking-capable models we normally send explicit
    // true|false. Explicit `false` tells Ollama to SKIP thinking (saves
    // tokens) instead of silently letting the model emit <think> tags we'd
    // then have to hide. Non-thinking models: omit the field entirely.
    //
    // Bug #80 parity: Gemma 3/4 with `think:false` drops into PLAIN-TEXT
    // structured planning ("Plan:" / "Constraint Checklist:" …) that no
    // tag-stripper can clean. For these models with the toggle OFF we
    // instead OMIT `think`, which makes Ollama emit tagged thinking that
    // our stripper handles cleanly. UX is the same (clean answer) — the
    // trade-off is hidden token spend on internal reasoning.
    if(isThinkingCompatible(currentModel)){
      if(thinking){
        body.think = true;
      } else if(!isPlainTextPlanner(currentModel)){
        body.think = false;
      }
      // else: leave body.think undefined → Ollama default = tagged thinking,
      // stripped at render time.
    }

    abortCtrl = new AbortController();
    fetch('/api/chat',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},
      body:JSON.stringify(body),
      signal:abortCtrl.signal
    })
    .then(function(r){
      if(r.status===401){clearAuthAndReload();return;}
      if(!r.ok){
        // Retry without the think field at all if the server rejects it
        // (old Ollama or model that refuses the flag).
        if(r.status===400 && ('think' in body)){
          delete body.think;
          return fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},body:JSON.stringify(body),signal:abortCtrl.signal}).then(streamResponse);
        }
        msgs[msgs.length-1].content='Error: HTTP '+r.status;
        finishStream();
        return;
      }
      streamResponse(r);
    })
    .catch(function(ex){
      if(ex.name!=='AbortError') msgs[msgs.length-1].content='Connection error';
      finishStream();
    });
  };

  // ── Native tool-calling loop ─────────────────────────────────────
  //
  // Replaces the old ReAct JSON loop with Ollama's native /api/chat
  // `tools` parameter. The model returns structured `tool_calls[]`
  // instead of freeform JSON we had to parse. Reliability goes from
  // ~60% to ~99% because the model uses its trained tool-call format
  // instead of trying to emit valid JSON in its content.
  // Append a structured agent step to the current assistant message.
  // Steps render as small colored cards ABOVE the bubble; they are NOT
  // part of msg.content, so the next user turn does NOT see tool-call
  // scaffolding and the model cannot drift into that style.
  function appendAgentStep(type, content, meta){
    var idx = msgs.length-1;
    if(idx < 0 || msgs[idx].role !== 'assistant') return;
    if(!Array.isArray(msgs[idx].agentSteps)) msgs[idx].agentSteps = [];
    // ALL steps always start collapsed (user request). Pulsing CSS stripe
    // on `.live` rows shows in-flight status; the content itself stays
    // behind the chevron until the user taps to expand.
    for(var p=0; p<msgs[idx].agentSteps.length; p++){ msgs[idx].agentSteps[p].open = false; }
    var step = {type:type, content:content, ts:Date.now(), open:false, live:false};
    if(meta && typeof meta === 'object'){ for(var k in meta) if(Object.prototype.hasOwnProperty.call(meta,k)) step[k]=meta[k]; }
    msgs[idx].agentSteps.push(step);
    renderChat();
  }

  // ── Native tool-calling loop ──
  //
  // Uses Ollama's /api/chat with `tools` parameter (non-streaming,
  // stream:false). The model returns structured `tool_calls[]` that we
  // execute via the existing runAgentTool() bridge, then feed results
  // back as `role:'tool'` messages. Loop until the model responds with
  // no tool_calls (= final answer) or we hit maxIter.
  //
  // Why non-streaming? Ollama's tool calling requires stream:false to
  // return structured tool_calls[]. The trade-off vs the old streaming
  // ReAct loop: no live token-by-token display, but near-100% tool-call
  // reliability instead of ~60% JSON parse success.
  function runToolLoop(systemPrompt, toolNames, kindLabel){
    agentRunning = true;
    agentAbort = false;
    abortCtrl = new AbortController();
    renderShell(); // flips Send button to Stop
    renderChat();

    var maxIter = 50; // matches desktop v24 AgentBudget default
    var iter = 0;
    var target = msgs[msgs.length-1]; // the empty assistant slot
    var tools = buildToolDefs(toolNames);

    // Build the LLM message history from the conversation.
    // Include system prompt + all msgs except the last empty assistant.
    // Hidden messages (tool-call history from previous turns) are included
    // so the model sees what it did before (continue capability, parity
    // with original Codex CLI).
    var apiMessages = [];
    var apiStartLen = 0; // track where loop-generated messages begin
    if(systemPrompt) apiMessages.push({role:'system', content:systemPrompt});
    var cm = getCaveman();
    for(var k=0; k<msgs.length-1; k++){
      var m = msgs[k];
      var content = m.content;
      if(m.role==='user' && cm!=='off' && CAVEMAN_REMINDERS[cm]){
        content = CAVEMAN_REMINDERS[cm] + '\n' + content;
      }
      var apiMsg = {role: m.role, content: content};
      // Carry over tool_calls on assistant messages so Ollama sees the
      // full native tool-call history (assistant→tool pairs).
      if(m.tool_calls) apiMsg.tool_calls = m.tool_calls;
      if(m.images && m.images.length){ apiMsg.images = m.images.map(function(im){return im.data;}); }
      apiMessages.push(apiMsg);
    }

    apiStartLen = apiMessages.length; // everything after this was added during the loop

    // Show a "thinking" step while the first call is in flight
    appendAgentStep('thought', kindLabel+' is thinking...', {live:true});
    var thinkingStepIdx = (target.agentSteps || []).length - 1;

    function step(){
      if(agentAbort){
        appendAgentStep('error', kindLabel+' stopped by user.');
        finishToolLoop(null);
        return;
      }
      if(iter >= maxIter){
        appendAgentStep('error', kindLabel+' stopped: max iterations reached.');
        finishToolLoop(null);
        return;
      }
      iter++;

      nativeToolChat(apiMessages, tools).then(function(res){
        // Remove the initial "thinking" placeholder on the first
        // successful response (only matters for iter === 1).
        if(thinkingStepIdx >= 0 && target.agentSteps && target.agentSteps[thinkingStepIdx]){
          target.agentSteps.splice(thinkingStepIdx, 1);
          thinkingStepIdx = -1;
          renderChat();
        }

        // Handle thinking content (native Ollama field + inline tags)
        var keepThinking = thinking && isThinkingCompatible(currentModel);
        var stripped = stripThinkTags(res.content, keepThinking);
        var turnContent = stripped.content;
        var turnThinking = stripped.thinking;
        // Also pick up the native thinking field from Ollama
        if(res.thinking){
          if(keepThinking){
            turnThinking = turnThinking ? turnThinking+'\n'+res.thinking : res.thinking;
          }
        }
        if(turnThinking && target){
          target.thinking = (target.thinking ? target.thinking+'\n' : '') + turnThinking;
        }

        // No tool calls → model is done, set final content
        if(!res.toolCalls || res.toolCalls.length === 0){
          finishToolLoop(turnContent || '(done)');
          return;
        }

        // Push the assistant message with tool_calls into the history
        // so Ollama sees the proper assistant→tool message pairs.
        apiMessages.push({
          role: 'assistant',
          content: turnContent || '',
          tool_calls: res.toolCalls.map(function(tc){
            return {function:{name:tc.function.name, arguments:tc.function.arguments}};
          })
        });

        // Execute each tool call sequentially, show steps in UI
        var tcIndex = 0;
        function execNext(){
          if(agentAbort){
            appendAgentStep('error', kindLabel+' stopped by user.');
            finishToolLoop(null);
            return;
          }
          if(tcIndex >= res.toolCalls.length){
            // All tools executed — loop back for next model turn
            renderChat();
            step();
            return;
          }

          var tc = res.toolCalls[tcIndex];
          var toolName = tc.function.name;
          var toolArgs = tc.function.arguments || {};
          var argsPretty = '';
          try{ argsPretty = JSON.stringify(toolArgs); }catch(_){ argsPretty = '{}'; }

          // Show "running" action step
          appendAgentStep('action', '`'+toolName+'` '+argsPretty, {toolName:toolName, args:toolArgs, live:true});
          var actionIdx = (target.agentSteps || []).length - 1;

          runAgentTool(toolName, toolArgs).then(function(observation){
            var obs = String(observation || '');

            // Mark action as completed
            if(target.agentSteps && target.agentSteps[actionIdx]){
              target.agentSteps[actionIdx].live = false;
            }
            appendAgentStep('observation', obs);

            // Push tool result into the LLM history
            apiMessages.push({role:'tool', content:obs});

            tcIndex++;
            execNext();
          }).catch(function(e){
            var errMsg = String(e && e.message || e);
            if(target.agentSteps && target.agentSteps[actionIdx]){
              target.agentSteps[actionIdx].live = false;
            }
            appendAgentStep('error', errMsg);

            // Push error as tool result so the model can adapt
            apiMessages.push({role:'tool', content:'Error: '+errMsg});

            tcIndex++;
            execNext();
          });
        }

        execNext();
      }).catch(function(e){
        // Remove the thinking placeholder if still present
        if(thinkingStepIdx >= 0 && target.agentSteps && target.agentSteps[thinkingStepIdx]){
          target.agentSteps.splice(thinkingStepIdx, 1);
          thinkingStepIdx = -1;
        }

        if(e && e.name === 'AbortError'){
          appendAgentStep('error', 'Stopped.');
          finishToolLoop(null);
          return;
        }
        var errMsg = (e && e.message) || String(e);
        if(errMsg === 'TOOLS_NOT_SUPPORTED'){
          appendAgentStep('error', 'This model does not support tool calling. Pick a tool-capable model (Qwen 3, Llama 3.1+, Gemma 4).');
          finishToolLoop(null);
          return;
        }
        appendAgentStep('error', kindLabel+' error: '+errMsg);
        finishToolLoop(null);
      });
    }

    function finishToolLoop(finalAnswer){
      agentRunning = false;
      agentAbort = false;
      abortCtrl = null;

      // ── Continue capability (parity with original Codex CLI) ────────
      // Persist the tool-call history from THIS turn as hidden messages
      // in msgs[]. On the NEXT turn, the history builder (line ~2802)
      // includes them in apiMessages so the model sees what it did before.
      // Hidden messages are skipped by renderChat() — the user only sees
      // the final answer, but the model sees the full tool-call chain.
      var toolHistory = [];
      for(var hi = apiStartLen; hi < apiMessages.length; hi++){
        var am = apiMessages[hi];
        toolHistory.push(mkMsg(am.role, am.content || '', {
          hidden: true,
          tool_calls: am.tool_calls || undefined
        }));
      }
      if(toolHistory.length > 0){
        // Splice BEFORE target (the visible final-answer message) so
        // the conversation order is: user → hidden tool chain → answer.
        var targetIdx = msgs.indexOf(target);
        if(targetIdx >= 0){
          // splice(targetIdx, 0, ...items) — Array.prototype.splice.apply
          // for ES5 compat (mobile JS can't use spread in all engines).
          var spliceArgs = [targetIdx, 0];
          for(var si = 0; si < toolHistory.length; si++) spliceArgs.push(toolHistory[si]);
          Array.prototype.splice.apply(msgs, spliceArgs);
        }
      }

      // The visible answer — if finalAnswer is null/empty and no prior
      // content, build a fallback summary from agent steps so the bubble
      // is never blank (parity with desktop useCodex.ts fix).
      var answer = finalAnswer || '';
      if(!answer && target && !target.content){
        var steps = target.agentSteps || [];
        var writes = 0, reads = 0, otherOk = 0, fails = 0;
        for(var si2 = 0; si2 < steps.length; si2++){
          var s = steps[si2];
          if(s.type === 'action'){
            if(s.toolName === 'file_write') writes++;
            else if(s.toolName === 'file_read') reads++;
            else otherOk++;
          } else if(s.type === 'error' && s.content && s.content.indexOf('stopped') < 0){
            fails++;
          }
        }
        var summaryParts = [];
        if(writes) summaryParts.push(writes + ' file(s) written');
        if(reads) summaryParts.push(reads + ' file(s) read');
        if(otherOk) summaryParts.push(otherOk + ' other operation(s) completed');
        if(fails) summaryParts.push(fails + ' operation(s) failed');
        answer = summaryParts.length > 0
          ? 'Task completed: ' + summaryParts.join(', ') + '.'
          : 'Task completed.';
      }
      if(target){ target.content = answer || target.content || ''; }
      renderShell();
      renderChat();
      var finalText = target ? (target.content || '') : '';
      postChatEvent('assistant', finalText);
      syncCurrentChat();
    }

    step();
  }

  // Character-state-machine for inline <think>...</think> tags.
  // Parity with desktop useChat.ts lines 205-219. When the user has
  // thinking TOGGLED OFF, the bytes inside <think>...</think> are
  // discarded instead of being stored — same for Ollama's native
  // `message.thinking` field. That way the toggle is the single source
  // of truth ("thinking visible or not").
  var inThinkTag = false;
  var discardedThinkBuf = '';
  function pushChunkContent(target, text, keepThinking){
    if(!text) return;
    for(var k=0;k<text.length;k++){
      var ch = text[k];
      if(!inThinkTag){
        target.content += ch;
        if(target.content.length >= 7 && target.content.slice(-7) === '<think>'){
          target.content = target.content.slice(0,-7);
          inThinkTag = true;
          discardedThinkBuf = '';
        }
      } else {
        if(keepThinking){
          target.thinking += ch;
          if(target.thinking.length >= 8 && target.thinking.slice(-8) === '</think>'){
            target.thinking = target.thinking.slice(0,-8);
            inThinkTag = false;
          }
        } else {
          discardedThinkBuf += ch;
          if(discardedThinkBuf.length >= 8 && discardedThinkBuf.slice(-8) === '</think>'){
            discardedThinkBuf = '';
            inThinkTag = false;
          }
        }
      }
    }
  }

  function streamResponse(r){
    if(!r) return;
    var reader=r.body.getReader();
    var dec=new TextDecoder();
    var buf='';
    inThinkTag = false; // reset per-stream
    discardedThinkBuf = '';
    var target = msgs[msgs.length-1];
    // Thinking visibility is driven strictly by the toggle. If the toggle
    // is OFF, ALL thinking tokens (native field AND inline <think> tags
    // AND non-canonical tags via stripNonCanonicalTags) are silently
    // dropped so the UI never shows a think block the user didn't ask
    // for. If the toggle turns ON later, subsequent tokens appear live.
    function keepThinkingNow(){ return thinking && isThinkingCompatible(currentModel); }
    function pump(){
      reader.read().then(function(result){
        if(result.done){
          // Final pass: scrub any non-canonical thinking markers that
          // slipped past the streaming state-machine (Gemma's channel
          // marker, orphan <thought>, etc.). Bug #3+#5.
          if(target){
            target.content = stripNonCanonicalTags(target.content).trim();
          }
          var finalText = target ? target.content : '';
          postChatEvent('assistant', finalText);
          finishStream();
          return;
        }
        buf+=dec.decode(result.value,{stream:true});
        var lines=buf.split('\n');
        buf=lines.pop()||'';
        var keep = keepThinkingNow();
        for(var li=0;li<lines.length;li++){
          var ln=lines[li].trim();
          if(!ln)continue;
          try{
            var j = JSON.parse(ln);
            if(j && j.message){
              // Ollama native thinking field (Gemma 4, Qwen 3.5, etc.)
              if(typeof j.message.thinking === 'string' && j.message.thinking){
                if(keep){
                  target.thinking += j.message.thinking;
                  // We do NOT auto-open anymore — tool calls / thinking
                  // start collapsed on mobile by user request.
                }
              }
              // Content may contain inline <think>...</think>
              if(typeof j.message.content === 'string' && j.message.content){
                pushChunkContent(target, j.message.content, keep);
              }
            }
          }catch(_){ }
        }
        // Live partial scrub of non-canonical tags (Gemma <|channel|>…).
        // We re-strip on every chunk so the user never sees a "Plan:"
        // preamble flash up while the model is still writing the answer.
        if(target){
          target.content = stripNonCanonicalTags(target.content);
        }
        renderChat();
        pump();
      }).catch(function(){finishStream();});
    }
    pump();
  }

  function finishStream(){
    streaming=false;abortCtrl=null;
    syncCurrentChat();
    // renderShell flips the Send-button back from Stop to Send. Must run
    // BEFORE renderChat so the keyboard-on-iOS doesn't momentarily see a
    // disabled button.
    renderShell();
    renderChat();
  }
})();
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

    // Generate QR code as PNG image — never panic, just return an empty
    // image if the QR encoder rejects the URL.
    let qr = match qrcode::QrCode::new(url.as_bytes()) {
        Ok(q) => q,
        Err(_) => return Json(QrResponse { qr_png_base64: String::new(), url, passcode: String::new() }),
    };
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

// ─── Dispatch config (model + system prompt for mobile) ───

async fn handle_config(AxumState(state): AxumState<RemoteState>) -> Json<serde_json::Value> {
    let model = state.dispatched_model.lock().await.clone();
    let system_prompt = state.dispatched_system_prompt.lock().await.clone();
    Json(serde_json::json!({
        "model": model,
        "systemPrompt": system_prompt,
    }))
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

/// Create a TCP listener with SO_REUSEADDR set, so the port can be re-bound
/// immediately after a previous process was hard-killed (Windows otherwise
/// leaves the socket in a zombie state until the OS reclaims it, which
/// breaks Dispatch → Stop → Dispatch cycles and any second run after a
/// crash).
fn build_reusable_listener(addr: SocketAddr) -> std::io::Result<tokio::net::TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};
    let domain = match addr {
        SocketAddr::V4(_) => Domain::IPV4,
        SocketAddr::V6(_) => Domain::IPV6,
    };
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;
    socket.set_reuse_address(true)?;
    socket.set_nonblocking(true)?;
    // Windows SO_EXCLUSIVEADDRUSE defaults to ON for privileged ports but
    // is off for our port. REUSEADDR is enough here.
    socket.bind(&addr.into())?;
    socket.listen(1024)?;
    tokio::net::TcpListener::from_std(socket.into())
}

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
    pub dispatched_model: Arc<TokioMutex<String>>,
    pub dispatched_system_prompt: Arc<TokioMutex<String>>,
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
            dispatched_model: Arc::new(TokioMutex::new(String::new())),
            dispatched_system_prompt: Arc::new(TokioMutex::new(String::new())),
        }
    }
}

#[tauri::command]
pub async fn start_remote_server(
    app: AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    model: Option<String>,
    system_prompt: Option<String>,
) -> Result<serde_json::Value, String> {
    // Clone Arcs from std::sync::Mutex, then drop it before any .await
    let (jwt_secret_arc, passcode_arc, permissions_arc, devices_arc, tunnel_url_arc, dispatched_model_arc, dispatched_system_prompt_arc, port, comfy_port) = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        if remote.handle.is_some() {
            return Err("Remote server already running".into());
        }
        // No `.unwrap()` here — release builds use `panic = abort`, so any
        // unwrap on a poisoned mutex would terminate the entire app. Treat
        // a missing comfy_port as a non-fatal "no comfy yet" (port 0).
        let comfy_port = state.comfy_port.lock().map(|g| *g).unwrap_or(0);

        (
            remote.jwt_secret.clone(),
            remote.passcode.clone(),
            remote.permissions.clone(),
            remote.connected_devices.clone(),
            remote.tunnel_url.clone(),
            remote.dispatched_model.clone(),
            remote.dispatched_system_prompt.clone(),
            remote.port,
            comfy_port,
        )
    }; // std::sync::MutexGuard dropped here

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
    // Fresh dispatch = fresh session. Clear any stale ConnectedDevice entries
    // left behind by previous sessions (zombie mobiles whose JWTs are already
    // invalid because we rotated jwt_secret above).
    {
        let mut devices = devices_arc.lock().await;
        devices.clear();
    }
    // Store dispatched model/system_prompt
    {
        let mut dm = dispatched_model_arc.lock().await;
        *dm = model.unwrap_or_default();
    }
    {
        let mut dsp = dispatched_system_prompt_arc.lock().await;
        *dsp = system_prompt.unwrap_or_default();
    }

    let server_state = RemoteState {
        jwt_secret: jwt_secret_arc,
        passcode: passcode_arc,
        ollama_port: 11434,
        comfy_port,
        permissions: permissions_arc,
        connected_devices: devices_arc,
        tunnel_url: tunnel_url_arc,
        app_handle: app.clone(),
        dispatched_model: dispatched_model_arc,
        dispatched_system_prompt: dispatched_system_prompt_arc,
    };

    // Bind synchronously so port-in-use returns a clean error to the
    // frontend instead of crashing the entire app via `panic = abort`.
    // (Critical: `axum::serve(...).await.unwrap()` previously aborted the
    // whole process on bind failure.)
    //
    // Robust bind: set SO_REUSEADDR so a zombie socket left over from a
    // previous hard-killed Tauri process doesn't block subsequent Dispatch
    // clicks. Without this, a single crash of `locally-uncensored.exe`
    // leaves port 11435 in a TIME_WAIT-ish state for ~4 minutes on Windows
    // and every new Dispatch fails with "Server stopped".
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("[Remote] Server starting on {}", addr);
    let listener = build_reusable_listener(addr)
        .map_err(|e| format!("Could not bind {}: {}. Another instance may be running — try Stop first.", addr, e))?;

    let handle = tokio::spawn(async move {
        let app = build_router(server_state);
        // Bug #3: surface the direct TCP peer address via ConnectInfo so
        // handle_auth can distinguish LAN clients without a reverse proxy.
        // Bug: never panic here — release builds use `panic = abort`.
        if let Err(e) = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        ).await {
            eprintln!("[Remote] axum::serve exited with error: {}", e);
        }
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

/// Restart the remote server in-place: stop + start while preserving the
/// dispatched conversation on the desktop. Generates a new passcode + JWT secret
/// (so the mobile has to re-authenticate, which is the desired security behaviour).
#[tauri::command]
pub async fn restart_remote_server(
    app: AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    model: Option<String>,
    system_prompt: Option<String>,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    // Stop first (ignore errors if not running)
    let _ = stop_remote_server(state).await;
    // Small delay so the TCP listener on 11435 fully unbinds
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    // Start fresh with a re-acquired State handle from the AppHandle
    let state2 = app.state::<crate::state::AppState>();
    start_remote_server(app.clone(), state2, model, system_prompt).await
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
        #[cfg(windows)]
        {
            let mut kill_cmd = std::process::Command::new("taskkill");
            kill_cmd.args(["/pid", &pid.to_string(), "/T", "/F"]);
            kill_cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = kill_cmd.output();
        }
        #[cfg(not(windows))]
        {
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
    // Bug #7: we no longer rotate the JWT secret on passcode regen. The
    // secret's job is "sign sessions for the lifetime of the server". The
    // passcode's job is "gate new logins to people who can read the desk".
    // Conflating them was silently logging out every active mobile every
    // 5 minutes. Passcode rotates; connected-device sessions survive.
    //
    // Bug #2: we do NOT clear `failed_attempts` here either. An attacker
    // could farm regens to reset their lockout otherwise. Locks expire on
    // their own cooldown timer.
    let passcode_arc = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        remote.passcode.clone()
    };

    let new_passcode = generate_passcode();

    {
        let mut pc = passcode_arc.lock().await;
        pc.code = new_passcode.clone();
        pc.expires_at = chrono_now_secs() + PASSCODE_TTL_SECS;
        // Intentionally keep pc.failed_attempts intact (Bug #2).
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

/// Remove a single connected device by ID. Bug #10: the Settings page
/// trash button used to be a no-op; this is its Tauri backend.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn disconnect_remote_device(
    state: tauri::State<'_, crate::state::AppState>,
    deviceId: String,
) -> Result<(), String> {
    let devices_arc = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        remote.connected_devices.clone()
    };
    let mut devices = devices_arc.lock().await;
    devices.retain(|d| d.id != deviceId);
    Ok(())
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
        let dir = cf_path.parent().ok_or("Invalid cloudflared install path")?;
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

    // Start cloudflared tunnel (hidden — no terminal window for end users)
    let mut cmd = std::process::Command::new(&cf_path);
    cmd.args(["tunnel", "--url", &format!("http://localhost:{}", port)])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let child = cmd.spawn()
        .map_err(|e| format!("Failed to start cloudflared: {}", e))?;

    let pid = child.id();
    let stderr = match child.stderr {
        Some(s) => s,
        None => return Err("cloudflared had no stderr handle".into()),
    };
    println!("[Tunnel] cloudflared started (PID {}), tunneling localhost:{}", pid, port);

    let captured_url = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let url_clone = captured_url.clone();

    // Spawn thread to read stderr and capture the URL
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stderr);
        for line in reader.lines().flatten() {
            println!("[Tunnel] {}", line);
            // cloudflared prints: "... https://xxx.trycloudflare.com ..."
            if let Some(start) = line.find("https://") {
                let url_part = &line[start..];
                let candidate = if let Some(end) = url_part.find(|c: char| c.is_whitespace() || c == '|') {
                    &url_part[..end]
                } else {
                    url_part.trim()
                };
                if candidate.contains(".trycloudflare.com") {
                    if let Ok(mut g) = url_clone.lock() {
                        *g = candidate.to_string();
                    }
                }
            }
        }
    });

    // Wait up to 15 seconds for the tunnel URL to appear (non-blocking)
    let mut url = String::new();
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Ok(g) = captured_url.lock() {
            url = g.clone();
        }
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
        #[cfg(windows)]
        {
            let mut kill_cmd = std::process::Command::new("taskkill");
            kill_cmd.args(["/pid", &pid.to_string(), "/T", "/F"]);
            kill_cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = kill_cmd.output();
        }
        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("kill").arg(pid.to_string()).output();
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

    // API routes. `/remote-api/auth` + `/remote-api/status` are explicitly
    // public (handled in auth_middleware). Everything else in this router
    // sits behind the middleware.
    let api_routes = Router::new()
        .route("/remote-api/auth", post(handle_auth))
        .route("/remote-api/status", get(handle_status))
        .route("/remote-api/status/full", get(handle_status_full))
        .route("/remote-api/qr", get(handle_qr))
        .route("/remote-api/devices", get(handle_devices))
        .route("/remote-api/disconnect", post(handle_disconnect))
        .route("/remote-api/permissions", get(handle_get_permissions))
        .route("/remote-api/permissions", post(handle_set_permissions))
        .route("/remote-api/config", get(handle_config))
        .route("/remote-api/chat-event", post(handle_chat_event))
        .route("/remote-api/agent-tool", post(handle_agent_tool));

    // Proxy routes
    let proxy_routes = Router::new()
        .route("/api/{*rest}", any(proxy_ollama))
        .route("/comfyui/{*rest}", any(proxy_comfyui))
        .route("/ws", get(proxy_comfyui_ws));

    // Mobile landing page
    let mobile = Router::new()
        .route("/mobile", get(mobile_landing));

    // Combine all routes. The remote server does NOT expose the desktop
    // React SPA — `mobile_landing` is self-contained, and serving the full
    // desktop bundle over the tunnel would leak source code (Bug #14).
    // Root `/` and any unknown path redirect to `/mobile`.
    let app = Router::new()
        .merge(api_routes)
        .merge(proxy_routes)
        .merge(mobile)
        .route("/", get(redirect_to_mobile))
        .route("/LU-monogram-white.png", get(mobile_monogram))
        .fallback(redirect_to_mobile);

    app.layer(middleware::from_fn_with_state(state.clone(), auth_middleware))
        .layer(cors)
        .with_state(state)
}

async fn redirect_to_mobile() -> Response {
    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, "/mobile")
        .body(Body::empty())
        .unwrap_or_else(|_| StatusCode::FOUND.into_response())
}

/// Serve the LU monogram PNG embedded in the desktop public/ dir.
/// This is the only binary asset the mobile page needs — bundle it
/// at compile time so we never depend on `dist/` being present.
async fn mobile_monogram() -> Response {
    const MONOGRAM: &[u8] = include_bytes!("../../../public/LU-monogram-white.png");
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, "public, max-age=86400")
        .body(Body::from(MONOGRAM))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
