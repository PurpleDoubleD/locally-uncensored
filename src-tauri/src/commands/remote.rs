use crate::os_error;
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
use tracing::{error, info, warn};

// ─── Constants ───

// 15 minutes. The pairing code the user types on the phone. Was 5 min, but it
// auto-rotates on expiry, and 5 min silently rotated the code mid-connect when
// there was any delay between reading it and entering it (David 2026-06-15).
// 15 min gives a comfortable pairing window; the live panel still shows a
// countdown + the current code, and the JWT issued after pairing has its own
// (separate) lifetime, so this only widens the one-time pairing window.
const PASSCODE_TTL_SECS: u64 = 900;
const JWT_TTL_SECS: u64 = 60 * 60;  // 1 hour — how long an authenticated session lasts
// #73/security-review 2.5.7: hard ceiling on how long a session may keep sliding
// itself alive. After this (measured from the token's issued-at, which is copied
// unchanged across refreshes), the sliding refresh stops and the device must
// re-pair — so a leaked bearer token can't be renewed forever.
const MAX_SESSION_SECS: u64 = 24 * 60 * 60;  // 24 hours
const MAX_FAILED_ATTEMPTS: u32 = 3;
const COOLDOWN_SECS: u64 = 60;

// ─── Shared server state ───

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct RemotePermissions {
    pub filesystem: bool,
    pub downloads: bool,
    pub process_control: bool,
    /// Shell + arbitrary code execution over the remote bridge. OFF by default:
    /// this is RCE-equivalent, so it must be explicitly opted into and is kept
    /// SEPARATE from `filesystem` (granting file access should never imply
    /// arbitrary command execution). `#[serde(default)]` so older client
    /// payloads that omit the field deserialize to `false`.
    #[serde(default)]
    pub shell: bool,
}

/// RA-1: EVERYTHING off by default.
///
/// The desktop permission panel renders its toggles from the frontend store,
/// which starts all-false. The server used to start filesystem/downloads/
/// process_control at `true`, so a user who deliberately left every switch
/// off still handed a paired phone workspace read/write, screenshots,
/// process_list, model pull/delete and ComfyUI start/stop. The displayed
/// control was decoration.
///
/// Two halves fix that and both are needed: this conservative default (the
/// server can no longer be more permissive than the panel claims) and the
/// read-back — `start_remote_server` / `remote_server_status` report the
/// effective permissions so the panel can never drift from the server again.
///
/// All four scopes are set on the desktop and nowhere else. `shell` always
/// was, for the RCE-equivalent reason documented on the field; the other three
/// joined it once it was clear that a paired device could POST them back on
/// itself (see `merge_remote_permissions`).
impl Default for RemotePermissions {
    fn default() -> Self {
        Self {
            filesystem: false,
            downloads: false,
            process_control: false,
            shell: false,
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
    /// Full Ollama base URL (e.g. `http://localhost:11434` or `http://192.168.1.50:11434`).
    /// Mirrors AppState.ollama_base so mobile clients dispatched through the
    /// Remote Access proxy reach the same Ollama instance the desktop is
    /// configured for (Issue #31).
    ollama_base: String,
    /// #87: active backend kind for the mobile chat proxy — "ollama" (native
    /// /api/tags + /api/chat) or "openai" (OpenAI-compatible /v1: the built-in
    /// engine, LM Studio, Lemonade, llama.cpp, vLLM). Remote used to hard-assume
    /// Ollama, so any non-Ollama desktop backend showed "No models found" plus a
    /// chat 400. For "openai" the proxy translates the mobile's Ollama-shaped
    /// calls to /v1 and back so remote chat works with the desktop's real backend.
    backend_kind: String,
    /// OpenAI-compatible base URL including `/v1` (only read when backend_kind ==
    /// "openai"), snapshotted from the desktop provider config at dispatch time.
    openai_base: String,
    /// Optional bearer key for the OpenAI-compatible backend (e.g. a LAN vLLM);
    /// empty for keyless local servers (built-in engine, LM Studio, llama.cpp).
    openai_key: String,
    comfy_port: u16,
    /// Configurable ComfyUI host — mirrors AppState.comfy_host so the mobile
    /// proxy forwards to the right machine when the user pointed LU at a
    /// remote ComfyUI instance.
    comfy_host: String,
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
    /// Session start (unix secs). Set once at pairing and COPIED UNCHANGED into
    /// every sliding refresh, so the server can cap total session age regardless
    /// of how many times the token was renewed. `serde(default)` = a pre-upgrade
    /// token without this claim decodes with iat 0 → treated as past the cap →
    /// stops sliding and re-pairs, instead of failing to decode.
    #[serde(default)]
    iat: usize,
}

fn generate_passcode() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    format!("{:06}", rng.gen_range(0..1000000))
}

/// Compare a supplied pairing code against the live one without leaking how
/// much of it was right.
///
/// `String`'s `==` stops at the first differing byte, so the reply time grows
/// with the length of the correct prefix. On a LAN that difference is
/// measurable, and it turns a 10^6 search into six 10-way searches. The
/// lockout above makes that slow rather than impossible, which is a reason to
/// close the oracle, not a substitute for closing it.
///
/// An empty stored code is never a match: it would otherwise pair anyone who
/// sends an empty string to a server whose passcode has not been set yet.
fn passcode_matches(supplied: &str, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    let a = supplied.as_bytes();
    let b = expected.as_bytes();
    // Lengths are compared without branching on content; a wrong length is
    // folded into the same accumulator as a wrong byte.
    let mut diff: u8 = if a.len() == b.len() { 0 } else { 1 };
    for i in 0..a.len().max(b.len()) {
        diff |= a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0);
    }
    diff == 0
}

fn generate_jwt(secret: &str, ip: &str, sub: &str, iat: u64) -> Result<String, String> {
    use jsonwebtoken::{encode, Header, EncodingKey};
    let exp = chrono_now_secs() + JWT_TTL_SECS;
    let claims = Claims {
        sub: sub.to_string(),
        ip: ip.to_string(),
        exp: exp as usize,
        iat: iat as usize,
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

/// The client IP this server is willing to believe.
///
/// Bug #3: on LAN there is no reverse proxy, so both XFF and X-Real-IP are
/// empty and every client collapsed into the "unknown" bucket — sharing one
/// rate-limit window and appearing as the same row in Connected Devices.
///
/// The exactly ONE reverse proxy that can ever sit in front of this server is
/// cloudflared, and it runs on this machine and reaches us over loopback.
/// Every other peer is talking to us directly, so a forwarding header from a
/// non-loopback peer is a value the client typed itself. Trusting it there was
/// not cosmetic: `handle_auth` deduplicates Connected Devices on this string,
/// and a device row IS a session (auth_middleware only honours a token whose
/// device is still listed). A second paired device that claimed the first
/// one's address therefore took over its row — hiding itself from the desktop
/// list AND ending the legitimate device's session in one request.
///
/// Even behind the tunnel the header is only half trusted: Cloudflare APPENDS
/// the visitor to any `X-Forwarded-For` the visitor already sent, so the first
/// hop is attacker-written and the LAST one is the proxy's. `CF-Connecting-IP`
/// is a single value the edge overwrites, so it is preferred.
///
/// No peer address at all means we cannot tell whether a proxy is in front of
/// us, so nothing is trusted.
fn client_ip(headers: &HeaderMap, socket: Option<SocketAddr>) -> String {
    let Some(addr) = socket else {
        return "unknown".to_string();
    };
    if addr.ip().is_loopback() {
        if let Some(ip) = headers.get("cf-connecting-ip")
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return ip.to_string()
        }
        if let Some(ip) = headers.get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.rsplit(',').next())
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
    }
    addr.ip().to_string()
}

// ─── Auth middleware ───

/// Which paired device is making this request — the `sub` of its JWT, attached
/// to the request by `auth_middleware`.
///
/// "Authenticated" used to be the only thing a handler could know, so every
/// paired device looked alike and `/remote-api/disconnect` accepted the id of
/// ANY row in the list. Handlers that act on a specific device read this
/// instead of the id in the body.
#[derive(Clone)]
struct CallerDevice(String);

async fn auth_middleware(
    AxumState(state): AxumState<RemoteState>,
    mut req: Request,
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
        .find_map(|c| c.trim().strip_prefix("lu-remote-token="))
        .unwrap_or("");

    let query_token = req.uri().query().unwrap_or("").split('&')
        .find_map(|p| p.strip_prefix("token="))
        .unwrap_or("");

    let token = if let Some(bearer) = auth_header.strip_prefix("Bearer ") {
        bearer
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
            // #73 (ossobucco): the JWT expired 60 min after PAIRING no matter
            // how active the session was — the next request 401'd, the mobile
            // page reloaded to the passcode view, and the typed message was
            // lost. Sliding refresh: once a valid token is past half its TTL,
            // mint a fresh one and hand it back on the response (header for
            // the JS client, Set-Cookie for /comfyui asset loads). An idle
            // token still dies after the full TTL and needs re-pairing —
            // deliberate on this surface; only USE keeps a session alive.
            // #73 revocation (security-review 2.5.7): only honor the token while
            // its device is still in the connected list. Disconnect removes the
            // row and a server restart clears the in-memory list, so BOTH now
            // truly end the session — previously a valid token kept working (and
            // kept sliding) even after Disconnect, so a leaked token was
            // effectively unrevocable short of restarting the whole server.
            let device_known = {
                let mut devices = state.connected_devices.lock().await;
                if let Some(dev) = devices.iter_mut().find(|d| d.id == claims.sub) {
                    dev.last_seen = chrono_now_secs();
                    true
                } else {
                    false
                }
            };
            if !device_known {
                drop(jwt_secret);
                return (StatusCode::UNAUTHORIZED, "Session ended — re-pair from the desktop.")
                    .into_response();
            }
            // #73 sliding refresh, now bounded: renew a past-half-life token only
            // while the session (from the unchanging `iat`) is under MAX_SESSION,
            // and carry `iat` forward unchanged so the cap actually bites.
            let refreshed = if should_slide_session(claims.iat as u64, claims.exp as u64, chrono_now_secs()) {
                generate_jwt(&jwt_secret, &claims.ip, &claims.sub, claims.iat as u64).ok()
            } else {
                None
            };
            drop(jwt_secret);
            // Identity for the handlers below. Set only on the path where the
            // token validated AND its device is still listed, so a handler
            // that finds it can act on it without re-checking either.
            req.extensions_mut().insert(CallerDevice(claims.sub.clone()));
            let mut response = next.run(req).await;
            if let Some(fresh) = refreshed {
                let cookie = format!(
                    "lu-remote-token={}; Path=/; Max-Age={}; SameSite=Strict",
                    fresh, JWT_TTL_SECS
                );
                // Defensive parses — a malformed value must not panic
                // (the process runs with panic = "abort").
                if let Ok(hv) = fresh.parse() {
                    response.headers_mut().insert("x-lu-refreshed-token", hv);
                }
                if let Ok(cv) = cookie.parse() {
                    response.headers_mut().append(header::SET_COOKIE, cv);
                }
            }
            response
        }
        Err(_) => (StatusCode::UNAUTHORIZED, "Invalid or expired token").into_response(),
    }
}

/// #73: slide the session once a still-valid token is past half of its
/// lifetime. Pure so it is unit-testable. `exp`/`now` in unix seconds.
fn should_refresh_jwt(exp: u64, now: u64, ttl_secs: u64) -> bool {
    exp > now && exp.saturating_sub(now) < ttl_secs / 2
}

/// #73/security-review 2.5.7: the full sliding-refresh decision. Renew only when
/// the token is past half-life AND the session (measured from the unchanging
/// `iat`) is still under the hard MAX_SESSION_SECS cap — so an active session
/// renews smoothly, but a captured token can't be kept alive past the cap. Pure
/// so it is unit-testable.
fn should_slide_session(iat: u64, exp: u64, now: u64) -> bool {
    now.saturating_sub(iat) < MAX_SESSION_SECS && should_refresh_jwt(exp, now, JWT_TTL_SECS)
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

/// Register (or refresh) the row for a device that just paired.
///
/// Dedup by IP: if this IP is already registered (reauth, refresh, regenerated
/// passcode), update the existing entry in place instead of stacking a second
/// ghost device. Also auto-prune entries that have been silent for more than
/// the JWT TTL — the client's token would be invalid anyway.
///
/// The key this collapses on has to be an address the CLIENT cannot choose;
/// see `client_ip`. Taking over another device's row is not a display glitch,
/// it ends that device's session.
///
/// Split out of `handle_auth` so the dedup can be exercised without a server.
fn upsert_device(
    devices: &mut Vec<ConnectedDevice>,
    device_id: String,
    ip: String,
    user_agent: String,
    now: u64,
) {
    devices.retain(|d| now.saturating_sub(d.last_seen) < JWT_TTL_SECS);
    if let Some(existing) = devices.iter_mut().find(|d| d.ip == ip) {
        existing.id = device_id;
        existing.user_agent = user_agent;
        existing.last_seen = now;
    } else {
        devices.push(ConnectedDevice { id: device_id, ip, user_agent, last_seen: now });
    }
}

async fn handle_auth(
    AxumState(state): AxumState<RemoteState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<AuthRequest>,
) -> Response {
    let ip = client_ip(&headers, Some(addr));
    // Anti-spoof: rate-limit/lockout is keyed on the REAL TCP peer
    // (`ConnectInfo`), NOT on `X-Forwarded-For`. A client can set XFF to a
    // fresh value per request and otherwise reset the per-IP cooldown, which
    // would make the 6-digit passcode brute-forceable. Over the Cloudflare
    // tunnel every request shares cloudflared's loopback peer, so they share
    // one (stricter) bucket — acceptable. `ip` above stays XFF-aware for the
    // device label / JWT claim only.
    let rate_key = addr.ip().to_string();

    let now = chrono_now_secs();

    // Rate limiting + passcode verification
    {
        let mut pc = state.passcode.lock().await;

        // Rate limit check
        if let Some(&(count, cooldown_until)) = pc.failed_attempts.get(&rate_key) {
            if count >= MAX_FAILED_ATTEMPTS && now < cooldown_until {
                let remaining = cooldown_until - now;
                return (StatusCode::TOO_MANY_REQUESTS,
                    format!("Too many attempts. Try again in {}s", remaining)
                ).into_response();
            }
            // Reset if cooldown expired
            if count >= MAX_FAILED_ATTEMPTS && now >= cooldown_until {
                pc.failed_attempts.remove(&rate_key);
            }
        }

        // Auto-regenerate expired passcode
        if now >= pc.expires_at {
            pc.code = generate_passcode();
            pc.expires_at = now + PASSCODE_TTL_SECS;
            println!("[Remote] Passcode auto-regenerated (expired)");
        }

        // Verify passcode
        if !passcode_matches(&body.passcode, &pc.code) {
            let entry = pc.failed_attempts.entry(rate_key.clone()).or_insert((0, 0));
            entry.0 += 1;
            if entry.0 >= MAX_FAILED_ATTEMPTS {
                entry.1 = now + COOLDOWN_SECS;
            }
            return (StatusCode::FORBIDDEN, "Invalid code").into_response();
        }

        // Success: clear failed attempts
        pc.failed_attempts.remove(&rate_key);
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
    // `now` (captured at the top of handle_auth) is the pairing time — the
    // session start. It seeds `iat` and is copied unchanged into every later
    // refresh so MAX_SESSION_SECS is measured from here, not from the last renew.
    match generate_jwt(&jwt_secret, &ip, &device_id, now) {
        Ok(token) => {
            drop(jwt_secret);
            let now = chrono_now_secs();
            let mut devices = state.connected_devices.lock().await;
            upsert_device(&mut devices, device_id, ip.clone(), user_agent, now);
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
        "app": "LU",
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

/// Pre-resolve a relative path argument the way `agent::resolve_agent_path`
/// does — honouring the per-chat workspace override map. Absolute paths are
/// returned unchanged. Used by remote handlers that delegate to filesystem
/// commands (`fs_list` / `fs_search`) which take no `&AppState` and would
/// otherwise resolve relatives against `~/agent-workspace/<chat_id>/` and
/// completely miss the user-picked Remote dispatch folder. This is the
/// fix for the silent-failure: file_list landed in
/// `~/agent-workspace/__remote__/` (the magic key sanitised as the folder
/// name) instead of e.g. `D:\Projects\my-site\` which the user selected.
pub(crate) fn resolve_remote_path(
    path: &str,
    chat_id: Option<&str>,
    state: &crate::state::AppState,
) -> Result<String, String> {
    use std::path::Path;
    // CONTAIN to the remote workspace (the user-picked override folder or the
    // per-chat sandbox). A remote client must not be able to read/write/cd
    // outside it via an absolute path or `..` (security: this is the network
    // attack surface).
    let workspace = crate::commands::agent::agent_workspace_for(chat_id, state);
    let p = Path::new(path);
    let candidate = if p.is_absolute() { p.to_path_buf() } else { workspace.join(path) };
    let contained = crate::commands::filesystem::contain_within(&workspace, &candidate)?;
    Ok(contained.to_string_lossy().to_string())
}

/// What a remote tool needs before it may run.
#[derive(Debug, PartialEq)]
enum ToolGate {
    /// Harmless to a paired device: no toggle required.
    Open,
    /// Requires the named permission to be ON.
    Needs(&'static str),
    /// Not decided → refused. See `gate_for`.
    Unknown,
}

/// Permission decision per tool. Fails CLOSED on purpose: the old mapping ended
/// in `_ => None`, so anything not listed ran ungated — and `process_list` did
/// exactly that. It hands a remote client the desktop's running processes,
/// which is the same "look at what this person is doing" class as `screenshot`,
/// and screenshot was gated. With the default flipped, a tool added to the
/// dispatch without a decision here is refused instead of silently exposed.
/// Line window for `file_read` (audit C1) — mirror of the desktop
/// `sliceFileReadResult`, so the relay and the app answer the same contract.
/// No offset and no limit returns the content untouched.
fn slice_file_read(content: &str, offset: Option<u64>, limit: Option<u64>) -> String {
    if offset.unwrap_or(0) == 0 && limit.unwrap_or(0) == 0 {
        return content.to_string();
    }
    let lines: Vec<&str> = content.split('\n').collect();
    let total = lines.len();
    let start = offset.filter(|o| *o > 0).unwrap_or(1).min(total as u64 + 1) as usize;
    let count = limit.filter(|l| *l > 0).map(|l| l as usize).unwrap_or(total);
    let window: Vec<&str> = lines.iter().skip(start - 1).take(count).copied().collect();
    let end = start + window.len() - if window.is_empty() { 0 } else { 1 };
    let mut out = format!("[lines {}-{} of {}]\n{}", start, end, total, window.join("\n"));
    if end < total {
        let rest = total - end;
        out.push_str(&format!(
            "\n[{} more line{} — call file_read again with offset: {}]",
            rest,
            if rest == 1 { "" } else { "s" },
            end + 1
        ));
    }
    out
}

fn gate_for(tool: &str) -> ToolGate {
    match tool {
        // RCE-equivalent: gated behind the dedicated, default-OFF `shell`
        // permission (NOT `filesystem`) so a remote client can't get arbitrary
        // command/code execution just by having file access enabled.
        "shell_execute" | "code_execute" => ToolGate::Needs("shell"),
        "file_read" | "file_write" | "file_list" | "file_search" | "screenshot" => {
            ToolGate::Needs("filesystem")
        }
        "image_generate" | "process_list" => ToolGate::Needs("process_control"),
        // Read-only and not about this machine's contents.
        "web_search" | "web_fetch" | "system_info" | "get_current_time" => ToolGate::Open,
        _ => ToolGate::Unknown,
    }
}

/// Run a single agent tool on behalf of an authenticated mobile client.
/// Mirrors `executeTool` in `src/api/agents.ts`. Permission-gated so a
/// remote client cannot reach into the desktop without explicit toggle:
///   - file_read / file_write   → requires `filesystem`
///   - shell_execute / code_execute → requires `shell` (default OFF, RCE-class)
///   - image_generate / process_list → requires `process_control`
///   - web_search / web_fetch / system_info / get_current_time → no permission
///   - anything else            → refused (see `gate_for`)
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
    match gate_for(&tool_name) {
        ToolGate::Open => {}
        ToolGate::Needs(perm) => {
            let on = match perm {
                "shell" => perms.shell,
                "filesystem" => perms.filesystem,
                "process_control" => perms.process_control,
                _ => false,
            };
            if !on {
                return graceful_perm_error(&tool_name, perm);
            }
        }
        ToolGate::Unknown => {
            eprintln!("[Remote agent] tool `{}` has no permission decision — refused", tool_name);
            return graceful_error(&format!(
                "`{}` is not available to remote clients.",
                tool_name
            ));
        }
    }

    // Per-chat workspace slug — threaded into every file tool so each
    // mobile chat gets its own isolated `~/agent-workspace/<slug>/` and
    // agents running in different chats can't clobber each other.
    //
    // #29 follow-up: when the user picked a folder during Remote
    // dispatch, the desktop set a "__remote__" workspace override. The
    // mobile sends its own chat id here (different from the desktop's
    // dispatched conv id), so we substitute the magic remote key when
    // an override is present — every tool call lands in the user-
    // chosen folder regardless of which mobile chat made the call.
    let chat_id_raw = body.chat_id.clone();
    let chat_id = {
        let has_remote_override = app_state
            .chat_workspace_overrides
            .lock()
            .ok()
            .map(|m| m.contains_key("__remote__"))
            .unwrap_or(false);
        if has_remote_override {
            Some("__remote__".to_string())
        } else {
            chat_id_raw
        }
    };

    let result: Result<serde_json::Value, String> = match tool_name.as_str() {
        "file_read" => {
            let path = body.args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if path.is_empty() { Err("file_read needs a non-empty `path` argument.".into()) }
            else {
                // Windowed read parity with the desktop tool (audit C1): the
                // relay serves the same tool contract, so offset/limit have to
                // page here too or a mobile agent reads a 5000-line file whole.
                let offset = body.args.get("offset").and_then(|v| v.as_u64());
                let limit = body.args.get("limit").and_then(|v| v.as_u64());
                crate::commands::agent::file_read(path, chat_id.clone(), app_state.clone())
                    .map(|v| {
                        let text = v.get("content").and_then(|c| c.as_str()).unwrap_or("");
                        serde_json::json!({ "content": slice_file_read(text, offset, limit) })
                    })
            }
        }
        "file_write" => {
            let path = body.args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let content = body.args.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if path.is_empty() { Err("file_write needs a non-empty `path` argument.".into()) }
            else { crate::commands::agent::file_write(path, content, chat_id.clone(), app_state.clone()) }
        }
        "code_execute" => {
            let code = body.args.get("code").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let timeout = body.args.get("timeout").and_then(|v| v.as_u64());
            if code.is_empty() { Err("code_execute needs a non-empty `code` argument.".into()) }
            else { crate::commands::agent::execute_code_blocking(code, timeout, chat_id.clone(), None, &app_state) }
        }
        "web_search" => {
            let query = body.args.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let count = body.args.get("maxResults")
                .or_else(|| body.args.get("count"))
                .and_then(|v| v.as_u64())
                .map(|n| n as usize);
            if query.is_empty() { Err("web_search needs a non-empty `query` argument.".into()) }
            // Remote clients carry no provider settings — None/None/None =
            // 'auto' without keys, i.e. the free tiers (pre-2.5.3 behaviour).
            else { crate::commands::search::web_search(query, count, None, None, None, app_state).await }
        }
        "web_fetch" => {
            let url = body.args.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if url.is_empty() { Err("web_fetch needs a non-empty `url` argument.".into()) }
            else { crate::commands::search::web_fetch(url).await }
        }
        "file_list" => {
            let raw_path = body.args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let recursive = body.args.get("recursive").and_then(|v| v.as_bool());
            let pattern = body.args.get("pattern").and_then(|v| v.as_str()).map(String::from);
            if raw_path.is_empty() { Err("file_list needs a non-empty `path` argument.".into()) }
            else {
                // Pass the user-picked Remote workspace as the working dir so
                // fs_list resolves relatives there AND re-applies the path-jail
                // against it — an absolute or `..` path can't escape the
                // workspace (security: remote = network surface).
                let ws = crate::commands::agent::agent_workspace_for(chat_id.as_deref(), &app_state)
                    .to_string_lossy().to_string();
                crate::commands::filesystem::fs_list(raw_path, recursive, pattern, None, Some(ws))
            }
        }
        "file_search" => {
            let raw_path = body.args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let pattern = body.args.get("query")
                .or_else(|| body.args.get("pattern"))
                .and_then(|v| v.as_str()).unwrap_or("").to_string();
            // Bug: AGENT_TOOLS sends `maxResults` (camelCase); also accept
            // snake-case for older clients.
            let max = body.args.get("maxResults")
                .or_else(|| body.args.get("max_results"))
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            if raw_path.is_empty() || pattern.is_empty() {
                Err("file_search needs both `path` and `pattern` arguments.".into())
            } else {
                // Jail to the remote workspace (see file_list above).
                let ws = crate::commands::agent::agent_workspace_for(chat_id.as_deref(), &app_state)
                    .to_string_lossy().to_string();
                crate::commands::filesystem::fs_search(raw_path, pattern, max, None, Some(ws))
            }
        }
        "shell_execute" => {
            let command = body.args.get("command").and_then(|v| v.as_str()).unwrap_or("").to_string();
            // Background-task actions folded into shell_execute (2.6.6 merge):
            // task: "status" | "list" | "kill" plus task_id, and background:
            // true for a detached start. Same registry as the desktop side.
            let task = body.args.get("task").and_then(|v| v.as_str()).unwrap_or("");
            if !task.is_empty() {
                let id = body.args.get("task_id").or_else(|| body.args.get("id")).and_then(|v| v.as_str()).unwrap_or("");
                let id_args = serde_json::json!({ "id": id });
                match task {
                    "status" => crate::commands::bg_tasks::shell_task_status_impl(&id_args).await,
                    "kill" => crate::commands::bg_tasks::shell_task_kill_impl(&id_args).await,
                    "list" => crate::commands::bg_tasks::shell_task_list_impl(&id_args).await,
                    other => Err(format!("shell_execute: unknown task action \"{}\" (use status | list | kill).", other)),
                }
            }
            else if command.is_empty() { Err("shell_execute needs a non-empty `command` argument (or a task action).".into()) }
            else if body.args.get("background").and_then(|v| v.as_bool()).unwrap_or(false) {
                let cwd_raw = body.args.get("cwd").and_then(|v| v.as_str()).map(String::from);
                let cwd = cwd_raw
                    .filter(|c| !c.trim().is_empty())
                    .and_then(|c| resolve_remote_path(&c, chat_id.as_deref(), &app_state).ok())
                    .or_else(|| Some(crate::commands::agent::agent_workspace_for(chat_id.as_deref(), &app_state)
                        .to_string_lossy()
                        .to_string()));
                let start_args = serde_json::json!({ "command": command, "cwd": cwd, "chat_id": chat_id });
                crate::commands::bg_tasks::shell_task_start_impl(&start_args).await
            }
            else {
                // Default cwd → the per-chat workspace folder so `npm install`
                // / `git status` / etc. land in the same directory the agent
                // is writing files to. Without this, shells default to the
                // app's launch directory and every relative command fails
                // with "no such file" while the model thinks it succeeded.
                let cwd_raw = body.args.get("cwd").and_then(|v| v.as_str()).map(String::from);
                // Jail the cwd to the remote workspace; an out-of-workspace cwd
                // falls back to the workspace root rather than running anywhere.
                let cwd = cwd_raw
                    .filter(|c| !c.trim().is_empty())
                    .and_then(|c| resolve_remote_path(&c, chat_id.as_deref(), &app_state).ok())
                    .or_else(|| Some(crate::commands::agent::agent_workspace_for(chat_id.as_deref(), &app_state)
                        .to_string_lossy()
                        .to_string()));
                // Best-effort: ensure the cwd exists before the shell command
                // runs. Saves the model an extra "Error: directory not found"
                // round-trip for the very first shell call in a new chat.
                if let Some(ref dir) = cwd {
                    let _ = std::fs::create_dir_all(dir);
                }
                let timeout = body.args.get("timeout").and_then(|v| v.as_u64());
                let shell = body.args.get("shell").and_then(|v| v.as_str()).map(String::from);
                let stdin = body.args.get("stdin").and_then(|v| v.as_str()).map(String::from);
                crate::commands::shell::shell_execute(command, None, cwd, timeout, shell, stdin, chat_id.clone(), None).await
            }
        }
        "system_info" => crate::commands::system::system_info(),
        "process_list" => crate::commands::system::process_list(),
        "screenshot" => crate::commands::system::screenshot().await,
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
        "Tool `{}` is gated behind the `{}` permission. Open the Menu, tap Settings, and turn it on under Remote Permissions.",
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

/// The path as the TARGET's router will see it: percent-decoded and with dot
/// segments removed.
///
/// axum hands us `uri().path()` exactly as it arrived and routes on those raw
/// bytes, so our own routing and the auth middleware agree with each other. The
/// proxy targets do not: gin (Ollama) and aiohttp (ComfyUI) both decode before
/// dispatching, so `/%75pload/image` never started with "/upload" for us while
/// ComfyUI resolved it to the upload handler all the same. Every permission
/// check on a proxied path goes through here.
///
/// Decoded ONCE, matching the target's single decode, so a double-encoded
/// `%2570` stays inert on both sides rather than being over-blocked here and
/// harmlessly delivered there. Only the GATE uses this: what gets forwarded is
/// still the raw path, so a legitimately encoded segment (ComfyUI addresses
/// /userdata/<name> with the slashes inside the name escaped) survives intact.
fn gate_path(raw: &str) -> String {
    let decoded = urlencoding::decode(raw)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| raw.to_string());
    let mut out: Vec<&str> = Vec::new();
    for seg in decoded.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    format!("/{}", out.join("/"))
}

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

    // #87: when the desktop's active chat backend is OpenAI-compatible (the
    // built-in engine, LM Studio, Lemonade, llama.cpp, vLLM), the mobile still
    // speaks Ollama protocol here — translate its /api/* calls to /v1 instead of
    // blindly proxying to Ollama (which the user may not even run). Ollama stays
    // the default path below.
    if state.backend_kind == "openai" {
        return proxy_openai_compat(&state, req).await;
    }

    // Enforce the `downloads` permission for any endpoint that writes model
    // state. Read-only endpoints (/api/tags, /api/chat, /api/show, etc.)
    // always remain open so an authenticated mobile can actually chat.
    if ollama_requires_downloads(&gate_path(&path)) {
        let perms = state.permissions.lock().await;
        if !perms.downloads {
            println!("[Remote] BLOCKED (downloads disabled): {} {}", req.method(), path);
            return forbidden("Downloads permission disabled for remote clients");
        }
    }

    let query = req.uri().query().map(|q| format!("?{}", q)).unwrap_or_default();
    // Route to the configured Ollama base URL. For the common localhost case
    // we rewrite "localhost" → "127.0.0.1" because reqwest inside the Tauri
    // subprocess fails on localhost resolution (known proxy_localhost bug).
    // Remote LAN/Docker hosts stay verbatim since they resolve via normal DNS.
    let base = state.ollama_base.trim_end_matches('/');
    let base_final = if base.contains("://localhost") {
        base.replace("://localhost", "://127.0.0.1")
    } else {
        base.to_string()
    };
    let target = format!("{}{}{}", base_final, path, query);
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
        if let Some(extra) = comfy_extra_permission(&gate_path(&stripped_owned)) {
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
    let target = format!("http://{}:{}{}{}", state.comfy_host, state.comfy_port, stripped_owned, query);
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

// ─── #87: OpenAI-compatible bridge for the mobile client ───
//
// The mobile page (see mobile_landing) is a self-contained Ollama client: it
// lists models via GET /api/tags and chats via POST /api/chat (Ollama's native
// shape). When the desktop's active backend is an OpenAI-compatible server we
// translate those calls to /v1 and translate the response back, so remote chat
// works with the built-in engine / LM Studio / Lemonade / llama.cpp / vLLM —
// not only Ollama. Like proxy_to_target this buffers the full response (the
// mobile already receives Ollama replies buffered), so no streaming state
// machine is needed: we ask the backend for stream:false and reshape once.

/// Strip the leading `provider::` prefix a desktop model name may carry (e.g.
/// `openai::qwen3:8b` → `qwen3:8b`). Matches the desktop's own `/^[^:]+::/`
/// strip (first prefix only). Ollama tags use `:` but never `::`. Defensive —
/// the desktop already sends a bare model, this is belt-and-suspenders.
fn strip_provider_prefix(model: &str) -> &str {
    match model.split_once("::") {
        Some((_, m)) => m,
        None => model,
    }
}

/// Raw base64 (Ollama `images[]`) → data URL (OpenAI `image_url`). Detect the
/// mime from the base64 magic so the declared type is right; default jpeg.
fn to_data_url(b64: &str) -> String {
    if b64.starts_with("data:") {
        return b64.to_string();
    }
    let mime = if b64.starts_with("iVBORw0KGgo") {
        "image/png"
    } else if b64.starts_with("/9j/") {
        "image/jpeg"
    } else if b64.starts_with("R0lGOD") {
        "image/gif"
    } else if b64.starts_with("UklGR") {
        "image/webp"
    } else {
        "image/jpeg"
    };
    format!("data:{};base64,{}", mime, b64)
}

/// OpenAI `GET /v1/models` response → Ollama `/api/tags` shape the mobile reads.
fn openai_models_to_ollama_tags(v: &serde_json::Value) -> serde_json::Value {
    let list = v
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| v.get("models").and_then(|d| d.as_array()));
    let mut out = Vec::new();
    if let Some(arr) = list {
        for m in arr {
            let id = m
                .get("id")
                .and_then(|x| x.as_str())
                .or_else(|| m.get("name").and_then(|x| x.as_str()))
                .or_else(|| m.get("model").and_then(|x| x.as_str()))
                .unwrap_or("");
            if id.is_empty() {
                continue;
            }
            out.push(serde_json::json!({
                "name": id, "model": id, "modified_at": "", "size": 0
            }));
        }
    }
    serde_json::json!({ "models": out })
}

/// Is this relay target a backend on this machine or the LAN?
///
/// Such a backend renders the MODEL'S OWN Jinja chat template, which is where
/// the thinking switch actually lives (`enable_thinking`, reached through
/// `chat_template_kwargs`). A cloud endpoint implements the protocol itself
/// and the strict ones refuse an unknown body field outright, and the relay
/// has no walk-down ladder to recover from that, so it only ever asks a local
/// server. Mirrors `isLanBackend` on the desktop side.
pub(crate) fn is_lan_base(base: &str) -> bool {
    let host = base
        .split("://")
        .nth(1)
        .unwrap_or(base)
        .split('/')
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("");
    let host = host.trim_start_matches('[');
    let host = host.split(']').next().unwrap_or(host);
    let host = if host.contains(':') && !host.contains("::") {
        host.split(':').next().unwrap_or(host)
    } else {
        host
    };
    let h = host.to_ascii_lowercase();
    h == "localhost"
        || h == "127.0.0.1"
        || h == "::1"
        || h.ends_with(".local")
        || h.starts_with("10.")
        || h.starts_with("192.168.")
        || h.starts_with("fd")
        || h.starts_with("fe80:")
        || (h.starts_with("172.")
            && h.split('.')
                .nth(1)
                .and_then(|o| o.parse::<u8>().ok())
                .map(|o| (16..=31).contains(&o))
                .unwrap_or(false))
}

/// Ollama `/api/chat` request → OpenAI `/v1/chat/completions` request. Always
/// asks the backend for stream:false (we reshape the reply for the mobile's
/// requested mode afterwards). Ollama tool defs are already OpenAI-shaped, so
/// tools pass through, and the `options` knobs are Ollama-only and dropped.
///
/// `think` is NOT dropped any more (2.6.7 Denk-Audit, Loch 9). It used to be,
/// so the phone's Think button did nothing at all whenever the box relayed to
/// an OpenAI-compatible backend, the built-in engine included. It is carried
/// the way a template-rendering server reads it, and only to a local one.
fn ollama_chat_req_to_openai(req: &serde_json::Value, lan: bool) -> serde_json::Value {
    let model = strip_provider_prefix(req.get("model").and_then(|v| v.as_str()).unwrap_or(""));
    let mut messages = Vec::new();
    if let Some(arr) = req.get("messages").and_then(|m| m.as_array()) {
        for m in arr {
            let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("user");
            let content = m.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let images = m.get("images").and_then(|v| v.as_array());
            match images {
                Some(imgs) if !imgs.is_empty() => {
                    let mut parts = Vec::new();
                    if !content.is_empty() {
                        parts.push(serde_json::json!({"type": "text", "text": content}));
                    }
                    for im in imgs {
                        if let Some(b64) = im.as_str() {
                            parts.push(serde_json::json!({
                                "type": "image_url",
                                "image_url": { "url": to_data_url(b64) }
                            }));
                        }
                    }
                    messages.push(serde_json::json!({"role": role, "content": parts}));
                }
                _ => {
                    messages.push(serde_json::json!({"role": role, "content": content}));
                }
            }
        }
    }
    let max_tokens = req
        .get("options")
        .and_then(|o| o.get("num_predict"))
        .and_then(|v| v.as_i64())
        .filter(|n| *n > 0)
        .unwrap_or(16384);
    let mut out = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": false,
        "max_tokens": max_tokens,
    });
    if let Some(tools) = req.get("tools") {
        if tools.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            out["tools"] = tools.clone();
        }
    }
    if lan {
        if let Some(think) = req.get("think").and_then(|v| v.as_bool()) {
            out["chat_template_kwargs"] = serde_json::json!({ "enable_thinking": think });
            out["reasoning_effort"] = serde_json::json!(if think { "high" } else { "none" });
        }
    }
    out
}

/// Pull `{content, thinking, tool_calls}` out of an OpenAI non-streaming reply.
fn openai_choice_parts(resp: &serde_json::Value) -> (String, String, Vec<serde_json::Value>) {
    let msg = resp
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("message"));
    let content = msg
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let thinking = msg
        .and_then(|m| m.get("reasoning_content").or_else(|| m.get("reasoning")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut tool_calls = Vec::new();
    if let Some(tcs) = msg.and_then(|m| m.get("tool_calls")).and_then(|v| v.as_array()) {
        for tc in tcs {
            if let Some(f) = tc.get("function") {
                let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("");
                // OpenAI sends `arguments` as a JSON string — the mobile's
                // repairToolCallArgs already handles that, so pass it through.
                let args = f.get("arguments").cloned().unwrap_or(serde_json::json!(""));
                tool_calls.push(serde_json::json!({"function": {"name": name, "arguments": args}}));
            }
        }
    }
    (content, thinking, tool_calls)
}

/// OpenAI reply → single Ollama `/api/chat` message object (mobile requested
/// stream:false — the native tool-calling path reads `data.message`).
fn openai_resp_to_ollama_message(resp: &serde_json::Value) -> serde_json::Value {
    let (content, thinking, tool_calls) = openai_choice_parts(resp);
    let mut message = serde_json::json!({"role": "assistant", "content": content});
    if !thinking.is_empty() {
        message["thinking"] = serde_json::json!(thinking);
    }
    if !tool_calls.is_empty() {
        message["tool_calls"] = serde_json::json!(tool_calls);
    }
    serde_json::json!({"model": "", "created_at": "", "message": message, "done": true, "done_reason": "stop"})
}

/// OpenAI reply → Ollama NDJSON stream (mobile requested stream:true — plain
/// chat). Emits a content line then a terminal done line; streamResponse()
/// consumes these exactly like Ollama's native stream.
fn openai_resp_to_ollama_ndjson(resp: &serde_json::Value) -> String {
    let (content, thinking, _) = openai_choice_parts(resp);
    let mut first = serde_json::json!({
        "model": "", "created_at": "",
        "message": {"role": "assistant", "content": content}, "done": false
    });
    if !thinking.is_empty() {
        first["message"]["thinking"] = serde_json::json!(thinking);
    }
    let done = serde_json::json!({
        "model": "", "created_at": "",
        "message": {"role": "assistant", "content": ""}, "done": true, "done_reason": "stop"
    });
    format!("{}\n{}\n", first, done)
}

async fn proxy_openai_compat(state: &RemoteState, req: Request) -> Response {
    let path = req.uri().path().to_string();
    let base = state.openai_base.trim_end_matches('/');
    let base_final = if base.contains("://localhost") {
        base.replace("://localhost", "://127.0.0.1")
    } else {
        base.to_string()
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("Client init: {}", e)).into_response()
        }
    };

    // Model list: /api/tags → GET {base}/models
    if path.ends_with("/tags") {
        let url = format!("{}/models", base_final);
        let mut rb = client.get(&url);
        if !state.openai_key.is_empty() {
            rb = rb.bearer_auth(&state.openai_key);
        }
        return match rb.send().await {
            Ok(resp) => {
                let ok = resp.status().is_success();
                match resp.json::<serde_json::Value>().await {
                    Ok(v) if ok => Json(openai_models_to_ollama_tags(&v)).into_response(),
                    _ => Json(serde_json::json!({ "models": [] })).into_response(),
                }
            }
            Err(e) => (StatusCode::BAD_GATEWAY, format!("Proxy error: {}", e)).into_response(),
        };
    }

    // Chat: /api/chat → POST {base}/chat/completions
    if path.ends_with("/chat") {
        let body_bytes = axum::body::to_bytes(req.into_body(), 100 * 1024 * 1024)
            .await
            .unwrap_or_default();
        let ollama_req: serde_json::Value =
            serde_json::from_slice(&body_bytes).unwrap_or_else(|_| serde_json::json!({}));
        let want_stream = ollama_req
            .get("stream")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let oai_req = ollama_chat_req_to_openai(&ollama_req, is_lan_base(&base_final));
        let url = format!("{}/chat/completions", base_final);
        let mut rb = client.post(&url).json(&oai_req);
        if !state.openai_key.is_empty() {
            rb = rb.bearer_auth(&state.openai_key);
        }
        return match rb.send().await {
            Ok(resp) => {
                let status = StatusCode::from_u16(resp.status().as_u16())
                    .unwrap_or(StatusCode::BAD_GATEWAY);
                if !status.is_success() {
                    let txt = resp.text().await.unwrap_or_default();
                    return (status, txt).into_response();
                }
                match resp.json::<serde_json::Value>().await {
                    Ok(v) => {
                        if want_stream {
                            let ndjson = openai_resp_to_ollama_ndjson(&v);
                            Response::builder()
                                .status(StatusCode::OK)
                                .header(header::CONTENT_TYPE, "application/x-ndjson")
                                .body(Body::from(ndjson))
                                .unwrap_or_else(|_| {
                                    (StatusCode::INTERNAL_SERVER_ERROR, "build").into_response()
                                })
                        } else {
                            Json(openai_resp_to_ollama_message(&v)).into_response()
                        }
                    }
                    Err(e) => (StatusCode::BAD_GATEWAY, format!("Read error: {}", e)).into_response(),
                }
            }
            Err(e) => (StatusCode::BAD_GATEWAY, format!("Proxy error: {}", e)).into_response(),
        };
    }

    // Other Ollama-only endpoints (/api/pull, /api/show, /api/delete, …) have no
    // clean OpenAI-compatible equivalent. Return a benign empty object so the
    // mobile degrades gracefully instead of surfacing a proxy error.
    Json(serde_json::json!({})).into_response()
}

#[cfg(test)]
mod openai_bridge_tests {
    use super::{
        is_lan_base, ollama_chat_req_to_openai, openai_models_to_ollama_tags,
        openai_resp_to_ollama_message, openai_resp_to_ollama_ndjson, strip_provider_prefix,
        to_data_url,
    };

    #[test]
    fn strip_prefix_only_on_double_colon() {
        assert_eq!(strip_provider_prefix("openai::qwen3:8b"), "qwen3:8b");
        assert_eq!(strip_provider_prefix("qwen3:8b"), "qwen3:8b");
        // Only the FIRST provider:: prefix is stripped (matches the desktop).
        assert_eq!(strip_provider_prefix("a::b::c"), "b::c");
    }

    #[test]
    fn tags_from_openai_data_array() {
        let v = serde_json::json!({"data": [{"id": "qwen3:8b"}, {"id": "gemma"}]});
        let out = openai_models_to_ollama_tags(&v);
        let models = out["models"].as_array().unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["name"], "qwen3:8b");
        assert_eq!(models[0]["model"], "qwen3:8b");
    }

    #[test]
    fn tags_empty_when_no_models() {
        assert_eq!(
            openai_models_to_ollama_tags(&serde_json::json!({}))["models"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn chat_req_maps_knobs_and_strips_prefix() {
        let req = serde_json::json!({
            "model": "openai::qwen", "messages": [{"role": "user", "content": "hi"}],
            "stream": true, "options": {"num_predict": 2048}, "think": false
        });
        let out = ollama_chat_req_to_openai(&req, true);
        assert_eq!(out["model"], "qwen");
        assert_eq!(out["stream"], false);
        assert_eq!(out["max_tokens"], 2048);
        // The Ollama-only spelling never goes on an OpenAI wire.
        assert!(out.get("think").is_none());
        assert_eq!(out["messages"][0]["content"], "hi");
    }

    // 2.6.7 Denk-Audit, Loch 9: the relay dropped `think` on the floor, so the
    // phone's Think button did nothing whenever the box relayed to an
    // OpenAI-compatible backend, the built-in engine included.
    #[test]
    fn chat_req_carries_the_think_switch_to_a_local_backend() {
        let on = ollama_chat_req_to_openai(
            &serde_json::json!({"model": "m", "messages": [], "think": true}),
            true,
        );
        assert_eq!(on["chat_template_kwargs"]["enable_thinking"], true);
        assert_eq!(on["reasoning_effort"], "high");

        let off = ollama_chat_req_to_openai(
            &serde_json::json!({"model": "m", "messages": [], "think": false}),
            true,
        );
        assert_eq!(off["chat_template_kwargs"]["enable_thinking"], false);
        assert_eq!(off["reasoning_effort"], "none");
    }

    #[test]
    fn chat_req_asks_a_cloud_backend_for_nothing_it_may_refuse() {
        let out = ollama_chat_req_to_openai(
            &serde_json::json!({"model": "m", "messages": [], "think": true}),
            false,
        );
        assert!(out.get("chat_template_kwargs").is_none());
        assert!(out.get("reasoning_effort").is_none());
    }

    #[test]
    fn chat_req_without_a_switch_stays_silent_even_locally() {
        let out = ollama_chat_req_to_openai(
            &serde_json::json!({"model": "m", "messages": []}),
            true,
        );
        assert!(out.get("chat_template_kwargs").is_none());
        assert!(out.get("reasoning_effort").is_none());
    }

    #[test]
    fn lan_base_knows_local_from_cloud() {
        for b in [
            "http://127.0.0.1:8127/v1",
            "http://localhost:1234/v1",
            "http://192.168.0.54:11434/v1",
            "http://10.0.0.5:8080/v1",
            "http://172.20.1.2:8080/v1",
            "http://box.local:8127/v1",
            "http://[::1]:8127/v1",
        ] {
            assert!(is_lan_base(b), "expected LAN: {}", b);
        }
        for b in [
            "https://api.openai.com/v1",
            "https://openrouter.ai/api/v1",
            "https://api.lu-labs.ai/v1",
            "http://172.32.0.1:8080/v1",
        ] {
            assert!(!is_lan_base(b), "expected cloud: {}", b);
        }
    }

    #[test]
    fn chat_req_images_become_vision_parts() {
        let req = serde_json::json!({
            "model": "m",
            "messages": [{"role": "user", "content": "look", "images": ["/9j/abc"]}]
        });
        let out = ollama_chat_req_to_openai(&req, true);
        let parts = out["messages"][0]["content"].as_array().unwrap();
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[1]["type"], "image_url");
        assert!(parts[1]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/jpeg;base64,/9j/"));
    }

    #[test]
    fn chat_req_tools_pass_through() {
        let req = serde_json::json!({
            "model": "m", "messages": [],
            "tools": [{"type": "function", "function": {"name": "f"}}]
        });
        let out = ollama_chat_req_to_openai(&req, true);
        assert_eq!(out["tools"][0]["function"]["name"], "f");
    }

    #[test]
    fn to_data_url_detects_png() {
        assert!(to_data_url("iVBORw0KGgoAAA").starts_with("data:image/png;base64,"));
        assert_eq!(to_data_url("data:image/png;base64,x"), "data:image/png;base64,x");
    }

    #[test]
    fn resp_message_maps_content_thinking_toolcalls() {
        let resp = serde_json::json!({"choices": [{"message": {
            "content": "ok", "reasoning_content": "hmm",
            "tool_calls": [{"id": "1", "function": {"name": "file_read", "arguments": "{\"path\":\"a\"}"}}]
        }}]});
        let out = openai_resp_to_ollama_message(&resp);
        assert_eq!(out["message"]["content"], "ok");
        assert_eq!(out["message"]["thinking"], "hmm");
        assert_eq!(out["message"]["tool_calls"][0]["function"]["name"], "file_read");
        assert_eq!(out["message"]["tool_calls"][0]["function"]["arguments"], "{\"path\":\"a\"}");
        assert_eq!(out["done"], true);
    }

    #[test]
    fn resp_ndjson_content_line_then_done() {
        let resp = serde_json::json!({"choices": [{"message": {"content": "hello"}}]});
        let s = openai_resp_to_ollama_ndjson(&resp);
        let lines: Vec<&str> = s.trim().split('\n').collect();
        assert_eq!(lines.len(), 2);
        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["message"]["content"], "hello");
        assert_eq!(first["done"], false);
        let second: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(second["done"], true);
    }
}

// #87 live end-to-end proof: the exact reqwest calls proxy_openai_compat makes,
// against a real OpenAI-compatible server, piped through the real translation
// functions. Verifies the whole chain over HTTP, not just hand-written fixtures.
//
// The base URL is an env var on purpose. #87 was reported against llama.cpp and
// Lemonade, and every one of these servers has its own /v1 quirks (LM Studio
// ships ids with '@' and '/' in them and omits `created`; llama.cpp answers
// /v1/models with a single entry named after the loaded file). Proving it once
// against Ollama's /v1 was never proof for the reporter's stack, so the same
// test now runs against whatever server you point it at.
//
// #[ignore]d so CI (which runs no inference server) stays green. Run locally:
//   cargo test --manifest-path src-tauri/Cargo.toml openai_bridge_live -- --ignored --nocapture
//   LU_OPENAI_LIVE_BASE=http://127.0.0.1:1234/v1  (LM Studio)
//   LU_OPENAI_LIVE_BASE=http://127.0.0.1:8000/api/v1  (Lemonade)
//
// Run 2026-07-26 against LM Studio 127.0.0.1:1234/v1 with 6 models loaded:
// tags ok (6 models, ids with '@' survive), chat non-stream ok, stream ndjson ok.
#[cfg(test)]
mod openai_bridge_live_tests {
    use super::{
        is_lan_base, ollama_chat_req_to_openai, openai_models_to_ollama_tags,
        openai_resp_to_ollama_message, openai_resp_to_ollama_ndjson,
    };

    #[test]
    #[ignore]
    fn openai_bridge_live_against_openai_compatible_server() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let base_owned = std::env::var("LU_OPENAI_LIVE_BASE")
                .unwrap_or_else(|_| "http://127.0.0.1:11434/v1".to_string());
            let base = base_owned.as_str();
            println!("LIVE base = {}", base);
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .unwrap();

            // /api/tags → GET /v1/models → Ollama tags shape
            let raw: serde_json::Value = client
                .get(format!("{}/models", base))
                .send()
                .await
                .expect("/v1/models reachable — is the server in LU_OPENAI_LIVE_BASE running?")
                .json()
                .await
                .unwrap();
            let tags = openai_models_to_ollama_tags(&raw);
            let models = tags["models"].as_array().unwrap();
            assert!(!models.is_empty(), "expected >=1 model from /v1/models");
            assert_eq!(models[0]["name"], models[0]["model"]);
            let first = models[0]["name"].as_str().unwrap().to_string();
            println!("LIVE tags ok: {} models, first = {}", models.len(), first);

            // /api/chat stream:false (tool path shape) → single Ollama message
            let ollama_req = serde_json::json!({
                "model": first,
                "messages": [{"role": "user", "content": "reply with the single word pong"}],
                "stream": false, "options": {"num_predict": 32}
            });
            let resp: serde_json::Value = client
                .post(format!("{}/chat/completions", base))
                .json(&ollama_chat_req_to_openai(&ollama_req, is_lan_base(base)))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let msg = openai_resp_to_ollama_message(&resp);
            assert!(
                !msg["message"]["content"].as_str().unwrap_or("").is_empty(),
                "expected non-empty translated chat content"
            );
            assert_eq!(msg["done"], true);
            println!("LIVE chat(non-stream) ok: content = {:?}", msg["message"]["content"]);

            // /api/chat stream:true (plain chat) → Ollama NDJSON the mobile reads
            let stream_req = serde_json::json!({
                "model": first,
                "messages": [{"role": "user", "content": "say hi"}],
                "stream": true, "options": {"num_predict": 16}
            });
            let resp2: serde_json::Value = client
                .post(format!("{}/chat/completions", base))
                .json(&ollama_chat_req_to_openai(&stream_req, is_lan_base(base)))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let ndjson = openai_resp_to_ollama_ndjson(&resp2);
            let lines: Vec<&str> = ndjson.trim().split('\n').collect();
            assert_eq!(lines.len(), 2, "expected a content line then a done line");
            let l0: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
            let l1: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
            assert_eq!(l0["done"], false);
            assert!(l0["message"]["content"].is_string());
            assert_eq!(l1["done"], true);
            println!("LIVE chat(stream ndjson) ok: 2 lines, first content = {:?}", l0["message"]["content"]);
        });
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
    let comfy_host = state.comfy_host.clone();
    ws.on_upgrade(move |client_socket| async move {
        use futures_util::{SinkExt, StreamExt};

        let ws_url = format!("ws://{}:{}/ws", comfy_host, comfy_port);
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

/// The page a paired phone receives, assembled from `mobile-client/`.
///
/// Until 2026-09-01 the whole client lived here as a 2 964-line `r#"…"#`
/// literal — HTML, 334 lines of CSS and 2 606 lines of JavaScript inside a
/// Rust string. Nothing in the JavaScript toolchain can look into a Rust
/// string, so `tsc`, `eslint`, `prettier` and `vitest` had never seen a line
/// of it. What stood in for tests were TypeScript re-implementations of the
/// same rules, hand-copied next to it: two versions of `CAVEMAN_PROMPTS`, two
/// of `buildSystemPrompt`, and a green suite either way.
///
/// The source now lives in `mobile-client/` as real files. `build.rs` glues
/// them back together on every build and writes the result into `OUT_DIR`;
/// see `crate::mobile_page` for the assembly and for what happens when a
/// source is missing (the build stops — it does not ship the last good page).
///
/// The bytes did not change. `mobile_landing_is_what_the_sources_say` below
/// re-derives the page from `mobile-client/` on every `cargo test` and
/// compares it with what is embedded here.
const MOBILE_CLIENT_PAGE: &str = include_str!(concat!(env!("OUT_DIR"), "/mobile-client.html"));

async fn mobile_landing() -> Html<String> {
    Html(MOBILE_CLIENT_PAGE.to_string())
}

// ─── QR Code generation ───

/// Deliberately carries NO passcode.
///
/// The desktop's `remote_qr_code` command still returns one — that side is the
/// person standing at the machine. Over HTTP the caller is by definition a
/// device that already paired, and handing it the code that pairs the NEXT
/// device makes Disconnect meaningless: a device removed from the list could
/// re-pair itself with a code it had already read. The QR image and the URL
/// are things the caller necessarily knows; the code is not.
#[derive(Serialize)]
struct QrResponse {
    qr_png_base64: String,
    url: String,
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
        Err(_) => return Json(QrResponse { qr_png_base64: String::new(), url }),
    };
    let qr_image = qr.render::<image::Luma<u8>>()
        .quiet_zone(true)
        .min_dimensions(256, 256)
        .build();
    let mut png_bytes: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut png_bytes);
    image::DynamicImage::ImageLuma8(qr_image).write_to(&mut cursor, image::ImageFormat::Png).unwrap_or(());

    let qr_base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png_bytes);

    Json(QrResponse { qr_png_base64: qr_base64, url })
}

// ─── Devices ───

/// The connected-device list as a stand-alone axum sub-state.
///
/// The two handlers below need nothing from `RemoteState` except this list, and
/// `RemoteState` carries an `AppHandle` — which cannot be built in a unit test.
/// Extracting the list instead of the whole state is what makes the handler
/// BODIES (the caller check, the filtering) reachable from a test rather than
/// only the helpers they call: a gegenprüfer who reverts a handler to its old
/// body must see a red test, and that only works if the test runs the handler.
#[derive(Clone)]
struct DeviceRegistry(Arc<TokioMutex<Vec<ConnectedDevice>>>);

impl axum::extract::FromRef<RemoteState> for DeviceRegistry {
    fn from_ref(state: &RemoteState) -> Self {
        DeviceRegistry(state.connected_devices.clone())
    }
}

/// Show the caller its OWN row, and only that one.
///
/// "Authenticated" is not the only rung on this ladder any more (see
/// `handle_disconnect` for the same class). This endpoint used to hand every
/// paired phone the full list: the id, the LAN/public IP and the user agent of
/// every OTHER device paired with this desktop. The id is the interesting part
/// — it is the `sub` of the other device's session and was, until the fix below,
/// all it took to end that session. The desktop's own list is not served over
/// HTTP at all (`remote_connected_devices`, a Tauri command), so nothing that
/// legitimately needs the full roster loses it here.
fn own_device_rows(devices: &[ConnectedDevice], caller_id: &str) -> Vec<ConnectedDevice> {
    devices.iter().filter(|d| d.id == caller_id).cloned().collect()
}

async fn handle_devices(
    AxumState(DeviceRegistry(devices)): AxumState<DeviceRegistry>,
    caller: Option<axum::Extension<CallerDevice>>,
) -> Response {
    // Set by auth_middleware on everything that got past it; this route is
    // behind it, so a missing one means the caller was never identified.
    let Some(axum::Extension(CallerDevice(caller_id))) = caller else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let devices = devices.lock().await;
    Json(own_device_rows(&devices, &caller_id)).into_response()
}

#[derive(Deserialize)]
struct DisconnectRequest {
    id: String,
}

/// Remove the CALLER's own row, and only that one.
///
/// The endpoint used to remove whatever id the body named. Because a device
/// row is a session — `auth_middleware` rejects a token whose device is no
/// longer listed — that made "disconnect" a weapon rather than a revocation:
/// any paired phone could end every other phone's session, including the one
/// the desktop owner was using, and the desktop's own list showed nothing
/// unusual afterwards. Removing SOMEONE ELSE is a desktop-side decision and
/// stays with the `disconnect_remote_device` command.
///
/// Split out so the rule can be tested without a server.
fn remove_own_device(
    devices: &mut Vec<ConnectedDevice>,
    caller_id: &str,
    requested_id: &str,
) -> StatusCode {
    if requested_id != caller_id {
        return StatusCode::FORBIDDEN;
    }
    devices.retain(|d| d.id != caller_id);
    StatusCode::OK
}

async fn handle_disconnect(
    AxumState(DeviceRegistry(devices)): AxumState<DeviceRegistry>,
    caller: Option<axum::Extension<CallerDevice>>,
    Json(body): Json<DisconnectRequest>,
) -> StatusCode {
    // The extension is set by auth_middleware on every request that got past
    // it, and this route is behind it — so a missing one means the caller was
    // never identified and must not act on the list at all.
    let Some(axum::Extension(CallerDevice(caller_id))) = caller else {
        return StatusCode::UNAUTHORIZED;
    };
    let mut devices = devices.lock().await;
    remove_own_device(&mut devices, &caller_id, &body.id)
}

// ─── Dispatch config (model + system prompt for mobile) ───

/// The platform sentence for the relay's agent prompt (task 215).
///
/// Word for word `platformPromptLine()` in src/lib/host-platform.ts, and it
/// has to be: the two are the same sentence on the same machine, and a phone
/// that phrases it differently is a second prompt nobody remembers to update.
/// The test below pins them against each other so a change to one fails until
/// it reaches the other.
///
/// This lives in Rust and not in the served JavaScript because the page runs
/// on the PHONE while every tool it calls runs here. `navigator.platform` in
/// that page describes an Android or an iPhone, which is the one answer that
/// is never right, and it was the reason a phone run on a Mac reached for
/// `explorer`.
///
/// There is no `unknown` arm on purpose: this is compiled for the machine it
/// will answer for, so an unrecognised target is a build that does not exist.
pub fn host_platform_prompt_line() -> &'static str {
    if cfg!(target_os = "macos") {
        r##"This machine runs macOS and shell_execute runs bash. Open a file or folder with `open <path>`, reveal it in Finder with `open -R <path>`, start an application with `open -a "<App Name>"`."##
    } else if cfg!(target_os = "windows") {
        r##"This machine runs Windows and shell_execute runs PowerShell. Open a file or folder with `Invoke-Item <path>`, reveal it in Explorer with `explorer "/select,<path>"` (one argument, the comma matters), start an application with `Start-Process "<App Name>"`."##
    } else {
        r##"This machine runs Linux and shell_execute runs bash. Open a file or folder with `xdg-open <path>`, start an application with `gtk-launch <name>`. There is no reveal, so open the containing folder instead."##
    }
}

/// The body of `/remote-api/config`, split out from the handler so a test can
/// read it without an AppHandle.
fn config_payload(model: String, system_prompt: String) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "systemPrompt": system_prompt,
        // Stable half of the environment block. The volatile half, the clock,
        // is built in the page on every turn instead of being frozen into the
        // one config fetch a session makes.
        "platformLine": host_platform_prompt_line(),
    })
}

async fn handle_config(AxumState(state): AxumState<RemoteState>) -> Json<serde_json::Value> {
    let model = state.dispatched_model.lock().await.clone();
    let system_prompt = state.dispatched_system_prompt.lock().await.clone();
    Json(config_payload(model, system_prompt))
}

// ─── Permissions ───

async fn handle_get_permissions(AxumState(state): AxumState<RemoteState>) -> Json<RemotePermissions> {
    let perms = state.permissions.lock().await;
    Json(perms.clone())
}

/// What a remote-supplied permissions update is allowed to change: nothing.
///
/// `shell` was already desktop-controlled, for the RCE-equivalent reason
/// documented on the field. The other three were not, and "authenticated" is
/// the only rung on this ladder — so any paired phone could
/// `POST {"filesystem":true,"downloads":true,"process_control":true}` and hand
/// ITSELF the workspace read/write, the screenshots, the model pull/delete and
/// the engine start/stop that the desktop panel had deliberately left off. A
/// permission a device can grant itself is not a permission.
///
/// The endpoint survives so a phone can READ back what it may do (the desktop
/// is where it is decided); the body is data the server does not act on.
fn merge_remote_permissions(current: &RemotePermissions, body: RemotePermissions) -> RemotePermissions {
    let _ = body;
    current.clone()
}

async fn handle_set_permissions(
    AxumState(state): AxumState<RemoteState>,
    Json(body): Json<RemotePermissions>,
) -> Json<RemotePermissions> {
    let mut perms = state.permissions.lock().await;
    let merged = merge_remote_permissions(&perms, body);
    *perms = merged;
    // Answer with what is actually in force, so a client that toggled
    // something can show the truth instead of its own optimistic guess.
    Json(perms.clone())
}

// ─── Server lifecycle (Tauri commands) ───

use tokio::task::JoinHandle;

/// Create the listener for the pairing port, with the address-reuse flag each
/// OS actually needs.
///
/// The two flags share a name and mean opposite things:
///
/// * Unix `SO_REUSEADDR` only skips the TIME_WAIT wait on a port whose old
///   connections are still draining. It cannot take a live listener away from
///   another process, so it is safe and it is what keeps
///   Dispatch → Stop → Dispatch working after a hard kill.
/// * Windows `SO_REUSEADDR` is a hijack primitive: any process running as this
///   user may bind the same address and the LAST binder receives the incoming
///   connections. On 0.0.0.0:11435 that is the pairing socket, so a local
///   process could sit in front of the phone and collect passcode attempts.
///   The comment that used to stand here claimed the opposite. Windows gets
///   `SO_EXCLUSIVEADDRUSE` instead, which is the flag that keeps the address
///   ours; the port is still released as soon as this process dies, so the
///   rebind-after-crash case the reuse flag was added for is unaffected.
fn build_reusable_listener(addr: SocketAddr) -> std::io::Result<tokio::net::TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};
    let domain = match addr {
        SocketAddr::V4(_) => Domain::IPV4,
        SocketAddr::V6(_) => Domain::IPV6,
    };
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;
    #[cfg(not(windows))]
    socket.set_reuse_address(true)?;
    #[cfg(windows)]
    set_exclusive_addr_use(&socket)?;
    socket.set_nonblocking(true)?;
    socket.bind(&addr.into())?;
    socket.listen(1024)?;
    tokio::net::TcpListener::from_std(socket.into())
}

/// `setsockopt(SOL_SOCKET, SO_EXCLUSIVEADDRUSE, 1)` — no other process may
/// bind this address while we hold it, whatever flags it passes.
///
/// socket2 0.5 has no wrapper for it and the winsock feature of `windows-sys`
/// is not enabled for this crate, so the one call is declared here. Same
/// approach `process_util` takes for `kill`/`setpgid`: a two-line binding
/// rather than a dependency. `ws2_32` is already linked into every Windows
/// build by std.
#[cfg(windows)]
fn set_exclusive_addr_use(socket: &socket2::Socket) -> std::io::Result<()> {
    use std::os::windows::io::AsRawSocket;

    const SOL_SOCKET: i32 = 0xffff;
    // winsock2.h defines it as ~SO_REUSEADDR.
    const SO_EXCLUSIVEADDRUSE: i32 = !0x0004;

    #[link(name = "ws2_32")]
    extern "system" {
        fn setsockopt(s: usize, level: i32, optname: i32, optval: *const u8, optlen: i32) -> i32;
    }

    let on: i32 = 1;
    let rc = unsafe {
        setsockopt(
            socket.as_raw_socket() as usize,
            SOL_SOCKET,
            SO_EXCLUSIVEADDRUSE,
            &on as *const i32 as *const u8,
            std::mem::size_of::<i32>() as i32,
        )
    };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Stored in AppState — holds the running remote server handle
pub struct RemoteServer {
    pub handle: Option<JoinHandle<()>>,
    pub port: u16,
    pub jwt_secret: Arc<TokioMutex<String>>,
    pub passcode: Arc<TokioMutex<PasscodeState>>,
    pub permissions: Arc<TokioMutex<RemotePermissions>>,
    pub connected_devices: Arc<TokioMutex<Vec<ConnectedDevice>>>,
    /// The cloudflared process itself, not just its pid.
    ///
    /// It used to be a bare `Option<u32>`, killed only when the user pressed
    /// Stop. Quitting the app left the quick tunnel running, so a public
    /// `*.trycloudflare.com` address kept pointing at 127.0.0.1:11435 — and
    /// the next launch bound that same port, which handed the survivor the NEW
    /// session while `tunnel_status` reported the tunnel as off. Holding the
    /// `Child` is what lets `Drop` and every stop path reap it (see
    /// `kill_tunnel_child`), and `start_remote_server` sweeps the ones that a
    /// hard kill still manages to orphan.
    pub tunnel_child: Option<std::process::Child>,
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
            tunnel_child: None,
            tunnel_url: Arc::new(TokioMutex::new(None)),
            dispatched_model: Arc::new(TokioMutex::new(String::new())),
            dispatched_system_prompt: Arc::new(TokioMutex::new(String::new())),
        }
    }

    /// The pid for status/logging. `None` means no tunnel process is held.
    pub fn tunnel_pid(&self) -> Option<u32> {
        self.tunnel_child.as_ref().map(|c| c.id())
    }

    /// End the tunnel and empty its slot. The one entry point for "the app is
    /// going away", shared by `Drop` below and by
    /// `AppState::shutdown_subprocesses`, which is the path that actually runs
    /// on a quit.
    ///
    /// `take()` and not a borrow, for the same reason every slot in
    /// `state.rs` takes: the two callers can BOTH fire on one quit (the
    /// explicit shutdown, then Tauri dropping the managed state if it happens
    /// to). A second pass must find nothing. It is not a harmless repeat —
    /// `kill_tree`'s snapshot includes the root, so the second call would
    /// SIGTERM/SIGKILL a pid that the kernel is free to have handed to a
    /// stranger in between, and on Windows `taskkill /T /F` would take that
    /// stranger's whole tree.
    pub fn shutdown_tunnel(&mut self) {
        if let Some(child) = self.tunnel_child.take() {
            kill_tunnel_child(child);
        }
    }
}

/// Kill and reap the tunnel process.
///
/// `kill_tree` and not `Child::kill`: it walks whatever cloudflared started,
/// escalates SIGTERM to SIGKILL on its own, and reaps — the old kill-by-pid
/// path did none of the three, so a stopped tunnel stayed in the process table
/// as a zombie for the rest of the app's life.
fn kill_tunnel_child(mut child: std::process::Child) {
    let pid = child.id();
    let _ = crate::process_util::kill_tree(&mut child);
    println!("[Tunnel] Stopped (PID {})", pid);
}

/// Spawn the tunnel and hand it to the shared state IN THE SAME STEP.
///
/// The child used to be held in a local variable for the whole of `start_tunnel`
/// — the 15 s wait for the public URL plus the ~12 s edge-readiness probe. For
/// those ~27 seconds on EVERY start the process was running and reachable from
/// nothing: `stop_tunnel` found an empty slot, `Drop` found an empty slot, and a
/// quit in that window left a live `*.trycloudflare.com` address pointing at
/// this machine with the app's own indicator reading OFF. That is the same
/// finding the `Child` was introduced for, just narrowed to a window.
///
/// So the slot is filled first and the outcome decided afterwards: from here on
/// every failure path goes through `kill_registered_tunnel`, which takes the
/// child back out of the slot instead of dropping a forgotten handle.
///
/// `stderr` is taken before the child leaves this function — it is the only
/// thing the caller still needs, and after the handover the `Child` belongs to
/// the shared state.
fn spawn_and_register_tunnel(
    cmd: std::process::Command,
    remote: &std::sync::Mutex<RemoteServer>,
) -> Result<(u32, std::process::ChildStderr), String> {
    let mut child = crate::process_util::spawn_piped(cmd).map_err(|e| {
        error!(error = %e, "cloudflared tunnel spawn failed");
        format!("Failed to start cloudflared: {}", os_error::english(&e))
    })?;
    let pid = child.id();
    // The tunnel is the one child whose survival is a security event and not
    // just a leak: it publishes this machine on the internet. On Windows this
    // puts it in the app's kill-on-close job object, so the OS takes it down
    // even when nothing in this process gets to run a shutdown path.
    crate::commands::process::tie_child_to_app_lifetime(pid);
    let stderr = match child.stderr.take() {
        Some(s) => s,
        None => {
            kill_tunnel_child(child);
            return Err("cloudflared had no stderr handle".into());
        }
    };
    // Anything already in the slot is killed rather than dropped — dropping a
    // `Child` does not kill it, it just forgets it, which is how the leak this
    // whole area fixes started.
    let displaced = {
        let mut guard = remote.lock().map_err(|e| e.to_string())?;
        guard.tunnel_child.replace(child)
    };
    if let Some(old) = displaced {
        kill_tunnel_child(old);
    }
    Ok((pid, stderr))
}

/// Take the tunnel back out of the shared slot and kill it — the failure-path
/// counterpart of `spawn_and_register_tunnel`.
///
/// Only if the slot still holds THIS pid: a concurrent `start_tunnel` may have
/// replaced it (and killed ours) already, and a failing start must never reap
/// the tunnel that succeeded after it.
fn kill_registered_tunnel(remote: &std::sync::Mutex<RemoteServer>, pid: u32) {
    let child = match remote.lock() {
        Ok(mut guard) => match guard.tunnel_child.as_ref().map(|c| c.id()) {
            Some(held) if held == pid => guard.tunnel_child.take(),
            _ => None,
        },
        Err(_) => None,
    };
    if let Some(child) = child {
        kill_tunnel_child(child);
    }
}

/// Belt-and-suspenders for the public tunnel, exactly like `Drop for AppState`.
///
/// This used to be the tunnel's ONLY quit path, and that was the gap: Tauri v2
/// does not reliably drop managed state on `app.exit(0)`, which is why
/// `AppState::shutdown_subprocesses` exists and why every other daemon —
/// Ollama, ComfyUI, the bundled llama-server, the embeddings server, the MLX
/// sidecar, the trainer — is listed there. The tunnel was not, so on the quit
/// paths where Tauri skipped our destructors a `cloudflared` survived and kept
/// publishing `*.trycloudflare.com` at 127.0.0.1:11435 — the port the NEXT
/// launch binds, which hands the survivor the new session while the app's own
/// indicator reads OFF. That is the core of T-39.
///
/// `shutdown_subprocesses` now takes the tunnel with it, so this Drop covers
/// only the remaining "Tauri DID run our destructor" case and finds an empty
/// slot whenever the explicit path got there first. On Windows the
/// kill-on-close job object (`tie_child_to_app_lifetime`) covers a hard kill,
/// and on Unix the startup sweep in `start_remote_server` is the second line.
impl Drop for RemoteServer {
    fn drop(&mut self) {
        self.shutdown_tunnel();
    }
}

/// The quit path's door to the tunnel: lock the shared slot and end what is in
/// it. Same shape as `install::kill_installer_children()` — the caller in
/// `state.rs` names one thing and this module owns how it dies.
///
/// A poisoned lock is recovered rather than skipped. Every other slot in
/// `shutdown_subprocesses` uses `if let Ok(..)` and gives up on a poisoned
/// mutex; for those the cost is a leaked local daemon. Here it is a public
/// address left pointing at this machine, and taking an `Option<Child>` out of
/// the struct cannot observe a half-updated invariant, so there is nothing to
/// protect by giving up.
pub fn shutdown_tunnel(remote: &std::sync::Mutex<RemoteServer>) {
    remote
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .shutdown_tunnel();
}

/// Best-effort: open the LAN port in Windows Firewall so phones on the same
/// network can actually reach the remote server. Adding a firewall rule needs
/// admin, so this silently no-ops for a non-elevated per-user install (that
/// user has to allow it once via an elevated prompt / manually) — but it
/// auto-fixes per-machine / admin-run installs. Without ANY rule, Windows drops
/// inbound on the port and the phone can't connect even though the QR points at
/// the correct LAN IP (David 2026-06-15: no rule existed and LU never made one,
/// so LAN access silently failed while the IP/QR were correct).
#[cfg(target_os = "windows")]
fn ensure_lan_firewall_rule(port: u16) {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let name = format!("LU Remote {}", port);
    // One-release legacy sweep: <=2.5.6 created the rule under the old brand
    // name and no uninstall path removes it, so clear it here best-effort.
    let legacy = format!("Locally Uncensored Remote {}", port);
    let _ = Command::new("netsh")
        .args(["advfirewall", "firewall", "delete", "rule", &format!("name={}", legacy)])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    // Idempotent: drop any prior rule for this name, then add a fresh inbound allow.
    let _ = Command::new("netsh")
        .args(["advfirewall", "firewall", "delete", "rule", &format!("name={}", name)])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let _ = Command::new("netsh")
        .args([
            "advfirewall", "firewall", "add", "rule",
            &format!("name={}", name),
            "dir=in", "action=allow", "protocol=TCP",
            &format!("localport={}", port),
            "profile=private,domain",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(target_os = "windows"))]
fn ensure_lan_firewall_rule(_port: u16) {}

/// Is this a cloudflared quick tunnel pointed at OUR port?
///
/// Narrow on purpose. A user may run cloudflared for their own reasons, and a
/// tunnel to some other port is none of our business — the only process this
/// may ever match is one that publishes the port we are about to bind.
///
/// Pure so the matching can be tested without a process table.
fn is_stale_tunnel_process(process_name: &str, cmd: &[String], port: u16) -> bool {
    let name = process_name.to_ascii_lowercase();
    if name != "cloudflared" && name != "cloudflared.exe" {
        return false;
    }
    let joined = cmd.join(" ");
    targets_loopback_port(&joined, port)
}

/// Does this command line publish EXACTLY `port` on loopback?
///
/// A substring test does not answer that: `contains("127.0.0.1:1143")` is also
/// true of `127.0.0.1:11435`, so the sweep for one port killed the tunnel of
/// another — and this sweep runs before the bind, on processes the user may
/// well have started for their own reasons. The whole digit run after the host
/// has to equal the port, which rules out both a shorter prefix and a longer
/// suffix.
fn targets_loopback_port(text: &str, port: u16) -> bool {
    let wanted = port.to_string();
    for host in ["127.0.0.1:", "localhost:"] {
        let mut rest = text;
        while let Some(at) = rest.find(host) {
            let tail = &rest[at + host.len()..];
            let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
            if digits == wanted {
                return true;
            }
            rest = tail;
        }
    }
    false
}

/// Kill cloudflared processes left over from a previous run that still publish
/// this port, and report how many.
///
/// This is the half of the fix that a hard kill cannot defeat. Without it, a
/// tunnel that survived the last quit keeps its public `*.trycloudflare.com`
/// address and starts serving the session we are about to start — a server the
/// user believes is LAN-only, reachable from the internet, with the app's own
/// tunnel indicator reading OFF because this process never started it.
fn kill_orphaned_tunnels(port: u16) -> usize {
    // The table MUST come from this helper. Until 2026-09-01 this function
    // built its own with `System::refresh_processes`, which does not fetch
    // command lines — so `process.cmd()` was EMPTY, `targets_loopback_port`
    // was handed "", and the sweep could never match a single process. It ran
    // on every start, reported 0, and looked like it worked. The identical
    // mistake sat in `process::find_orphaned_comfyui`; only one of the two was
    // ever noticed, which is why the refresh now lives in one place.
    let sys = crate::process_util::process_table_with_cmdlines();
    let mut killed = 0usize;
    for pid in find_stale_tunnels(&sys, port) {
        if let Some(process) = sys.process(sysinfo::Pid::from_u32(pid)) {
            if process.kill() {
                killed += 1;
            }
        }
    }
    killed
}

/// The pids of every cloudflared publishing `port`, read off an already
/// refreshed table.
///
/// Split from the kill so the scan can be tested against real processes
/// without the test having to kill anything.
fn find_stale_tunnels(sys: &sysinfo::System, port: u16) -> Vec<u32> {
    sys.processes()
        .iter()
        .filter(|(_, process)| {
            let name = process.name().to_string_lossy().to_string();
            is_stale_tunnel_process(&name, &crate::process_util::cmdline_of(process), port)
        })
        .map(|(pid, _)| pid.as_u32())
        .collect()
}

#[tauri::command]
pub async fn start_remote_server(
    app: AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    model: Option<String>,
    system_prompt: Option<String>,
    // #87: the desktop tells us which backend serves the dispatched model so the
    // mobile proxy reaches the real backend, not just Ollama. Defaults keep the
    // Ollama path for older callers / a plain Ollama dispatch.
    backend_kind: Option<String>,
    backend_base: Option<String>,
    backend_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let backend_kind = backend_kind.unwrap_or_else(|| "ollama".to_string());
    let openai_base = backend_base.unwrap_or_default();
    let openai_key = backend_key.unwrap_or_default();
    // Clone Arcs from std::sync::Mutex, then drop it before any .await
    let (jwt_secret_arc, passcode_arc, permissions_arc, devices_arc, tunnel_url_arc, dispatched_model_arc, dispatched_system_prompt_arc, port, comfy_port, comfy_host, ollama_base) = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        if remote.handle.is_some() {
            return Err("Remote server already running".into());
        }
        // No `.unwrap()` here — release builds use `panic = abort`, so any
        // unwrap on a poisoned mutex would terminate the entire app. Treat
        // a missing comfy_port as a non-fatal "no comfy yet" (port 0).
        let comfy_port = state.comfy_port.lock().map(|g| *g).unwrap_or(0);
        let comfy_host = state.comfy_host.lock().map(|g| g.clone()).unwrap_or_else(|_| "localhost".to_string());
        // Issue #31: snapshot the current Ollama base URL so the mobile proxy
        // forwards to whatever the desktop currently targets.
        let ollama_base = state.ollama_base.lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| "http://localhost:11434".to_string());

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
            comfy_host,
            ollama_base,
        )
    }; // std::sync::MutexGuard dropped here

    // Generate new passcode + JWT secret. The secret is 32 bytes from a CSPRNG
    // (256-bit) — the old `lu-<timestamp>-<u64>` form had a guessable prefix
    // and only ~64 bits of entropy.
    let passcode = generate_passcode();
    let jwt_secret_str = {
        use rand::RngCore;
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>()
    };
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

    // RA-1: the Arc moves into the axum state below, so keep a second handle to
    // read the effective permissions back into the start response. The desktop
    // store maps them in the same `set()` that flips `enabled: true`, so there
    // is no window in which the panel shows something the server isn't doing.
    let permissions_readback = permissions_arc.clone();

    let server_state = RemoteState {
        jwt_secret: jwt_secret_arc,
        passcode: passcode_arc,
        ollama_base,
        backend_kind,
        openai_base,
        openai_key,
        comfy_port,
        comfy_host,
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
    // Robust bind: a zombie socket left over from a previous hard-killed Tauri
    // process must not block subsequent Dispatch clicks — without that, a
    // single crash of `locally-uncensored.exe` left port 11435 unbindable for
    // ~4 minutes and every new Dispatch failed with "Server stopped". The flag
    // that buys it differs per OS and one of the two is a hijack primitive;
    // `build_reusable_listener` documents which is which.

    // Before anything listens on this port again: no tunnel from an earlier
    // run gets to inherit this session. A quick tunnel that outlived its app
    // is still publishing 127.0.0.1:11435 to the internet, and the moment we
    // bind, it is publishing US — silently, with the tunnel indicator off,
    // because this process never started it.
    let swept = kill_orphaned_tunnels(port);
    if swept > 0 {
        println!("[Tunnel] Killed {swept} orphaned cloudflared tunnel(s) on port {port}");
        warn!(count = swept, port = port, "orphaned cloudflared tunnel(s) killed before bind");
    }

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("[Remote] Server starting on {}", addr);
    info!(port = port, "remote server connect");
    let listener = build_reusable_listener(addr)
        .map_err(|e| {
            error!(error = %e, port = port, "remote server bind failed");
            format!("Could not bind {}: {}. Another instance may be running — try Stop first.", addr, e)
        })?;

    // Best-effort: open the LAN port in Windows Firewall so the phone can reach
    // us (see fn docs). Non-fatal — needs admin, so it only takes effect for
    // elevated / per-machine installs; per-user installs still need a one-time
    // manual allow. Never blocks server startup.
    ensure_lan_firewall_rule(port);

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
            error!(error = %e, "remote axum serve exited with error");
        }
    });

    // Store handle back
    {
        let mut remote = state.remote.lock().map_err(|e| e.to_string())?;
        remote.handle = Some(handle);
    }

    // #aldrich (Discord 2026-06-17, STILL "Error HTTP:503" on the phone after
    // the 2.5.4 tunnel-readiness poll): that earlier poll only checks the
    // Cloudflare EDGE url, never the LOCAL origin. axum::serve binds inside the
    // spawned task above, which may not be listening yet when we return here —
    // so the tunnel edge (or a fast phone on LAN) can hit a not-yet-bound origin
    // and Cloudflare relays the upstream 503. Gate the return on our OWN loopback
    // /remote-api/status (public, no auth, instant) so the server is provably
    // serving before the frontend ever starts the tunnel or shows the QR. Use
    // 127.0.0.1 (IPv4) not localhost to avoid the slow ::1 refused-connect path.
    // Bounded: proceed anyway after the budget rather than hang (old behaviour).
    if let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(400))
        .no_proxy()
        .build()
    {
        let probe = format!("http://127.0.0.1:{}/remote-api/status", port);
        for _ in 0..25 { // ~25 × 200 ms ≈ 5 s readiness budget
            match client.get(&probe).send().await {
                Ok(resp) if resp.status().is_success() => break,
                _ => tokio::time::sleep(std::time::Duration::from_millis(200)).await,
            }
        }
    }

    let lan_ip = local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string());

    let permissions = permissions_readback.lock().await.clone();

    info!(port = port, "remote server started");
    Ok(serde_json::json!({
        "port": port,
        "passcode": passcode,
        "passcodeExpiresAt": now + PASSCODE_TTL_SECS,
        "lanUrl": format!("http://{}:{}", lan_ip, port),
        "mobileUrl": format!("http://{}:{}/mobile", lan_ip, port),
        // RA-1: effective permissions, so the UI is never out of sync with the
        // server it just started. `restart_remote_server` delegates here, so it
        // reports them too.
        "permissions": permissions,
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
    backend_kind: Option<String>,
    backend_base: Option<String>,
    backend_key: Option<String>,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    // Stop first (ignore errors if not running)
    let _ = stop_remote_server(state).await;
    // Small delay so the TCP listener on 11435 fully unbinds
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    // Start fresh with a re-acquired State handle from the AppHandle
    let state2 = app.state::<crate::state::AppState>();
    start_remote_server(app.clone(), state2, model, system_prompt, backend_kind, backend_base, backend_key).await
}

#[tauri::command]
pub async fn stop_remote_server(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let (handle, tunnel_child, tunnel_url_arc) = {
        let mut remote = state.remote.lock().map_err(|e| e.to_string())?;
        (remote.handle.take(), remote.tunnel_child.take(), remote.tunnel_url.clone())
    };

    // Stop tunnel if running
    if let Some(child) = tunnel_child {
        kill_tunnel_child(child);
    }
    {
        let mut turl = tunnel_url_arc.lock().await;
        *turl = None;
    }

    // Stop server
    if let Some(handle) = handle {
        handle.abort();
        println!("[Remote] Server stopped");
        info!("remote server disconnected");
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_server_status(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<serde_json::Value, String> {
    let (running, port, passcode_arc, tunnel_url_arc, tunnel_pid, permissions_arc) = {
        let remote = state.remote.lock().map_err(|e| e.to_string())?;
        (
            remote.handle.is_some(),
            remote.port,
            remote.passcode.clone(),
            remote.tunnel_url.clone(),
            remote.tunnel_pid(),
            remote.permissions.clone(),
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

    // RA-1: report the EFFECTIVE server permissions so the desktop panel reads
    // the server's truth instead of showing a hardcoded all-false guess. This is
    // also how a change made from the mobile permissions panel gets back to the
    // desktop UI.
    let permissions = permissions_arc.lock().await.clone();

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
        "permissions": permissions,
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
    let dir = crate::os_paths::tools_bin_dir();
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

    // (Re)download cloudflared if missing OR stale. It used to be cached
    // FOREVER (download only `if !exists`), but trycloudflare's quick-tunnel
    // API evolves and an old client then gets "500 / error code 1101"
    // unmarshal failures with NO public URL — the tunnel silently never comes
    // up (David 2026-06-15: stuck on cloudflared 2026.3.0 from March → every
    // tunnel attempt 500'd). Re-pull the latest when the cached binary is more
    // than 30 days old so the tunnel self-heals without the user ever knowing
    // cloudflared exists.
    let cf_stale = cf_path.metadata().ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .map(|age| age > std::time::Duration::from_secs(30 * 24 * 60 * 60))
        .unwrap_or(true); // unknown mtime → treat as stale and refresh
    if !cf_path.exists() || cf_stale {
        if cf_path.exists() {
            println!("[Tunnel] cloudflared is stale (>30 days) — re-downloading the latest");
            let _ = std::fs::remove_file(&cf_path);
        }
        let dir = cf_path.parent().ok_or("Invalid cloudflared install path")?;
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir: {}", os_error::english(&e)))?;

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

        let resp = client.get(download_url).send().await.map_err(|e| format!("Download failed: {}", os_error::english(&e)))?;
        if !resp.status().is_success() {
            return Err(format!("Download HTTP {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| os_error::english(&e))?;

        // Integrity gate before we write + chmod +x + spawn a downloaded binary.
        // cloudflared pins to `releases/latest` on purpose (the self-heal design:
        // a frozen version 500's once trycloudflare's tunnel API moves on), so a
        // static SHA-256 pin isn't compatible here. Instead verify the three
        // things we *can* assert about `latest`: it came over HTTPS from the
        // official host, it's a plausible binary size, and it has the platform's
        // executable magic bytes. This rejects a MITM'd HTML error page, a
        // truncated download, or a swapped host before any of it is executed.
        if !download_url.starts_with("https://github.com/") {
            return Err("Refusing to fetch cloudflared from a non-github.com URL".into());
        }
        if bytes.len() < 1_000_000 {
            // cloudflared is tens of MB; under 1 MB is an error page / truncation.
            return Err(format!(
                "cloudflared download too small ({} bytes) — looks like an error page, not the binary",
                bytes.len()
            ));
        }
        let magic_ok = if cfg!(windows) {
            bytes.starts_with(b"MZ") // PE executable
        } else if cfg!(target_os = "linux") {
            bytes.starts_with(&[0x7f, b'E', b'L', b'F']) // ELF
        } else {
            bytes.starts_with(&[0x1f, 0x8b]) // gzip (.tgz for darwin)
        };
        if !magic_ok {
            return Err("cloudflared download failed integrity check (unexpected file header)".into());
        }

        // macOS ships cloudflared as a gzip tarball (.tgz), not a raw binary —
        // writing it straight to cf_path and exec'ing it is an ENOEXEC. Extract
        // the `cloudflared` executable from the archive (system `tar` is always
        // present on macOS). Windows/Linux download the raw binary.
        #[cfg(target_os = "macos")]
        {
            let tgz = dir.join("cloudflared.tgz");
            std::fs::write(&tgz, &bytes).map_err(|e| format!("write tgz: {}", os_error::english(&e)))?;
            let status = std::process::Command::new("tar")
                .arg("-xzf")
                .arg(&tgz)
                .arg("-C")
                .arg(dir)
                .status()
                .map_err(|e| format!("tar spawn: {}", os_error::english(&e)))?;
            let _ = std::fs::remove_file(&tgz);
            if !status.success() {
                return Err("Failed to extract cloudflared from its .tgz archive".into());
            }
            if !cf_path.exists() {
                return Err("cloudflared binary missing after extracting the archive".into());
            }
        }
        #[cfg(not(target_os = "macos"))]
        std::fs::write(&cf_path, &bytes).map_err(|e| format!("write: {}", os_error::english(&e)))?;

        // Make executable on Unix
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&cf_path, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("chmod: {}", e))?;
        }
        println!("[Tunnel] Downloaded cloudflared to {:?}", cf_path);
    }

    // Start cloudflared tunnel (hidden — no terminal window for end users).
    // `spawn_piped` gives it its own process group on Unix (so `kill_tree`
    // reaches anything it starts) and suppresses the console window on
    // Windows, exactly like every other child this app spawns.
    let mut cmd = std::process::Command::new(&cf_path);
    // 127.0.0.1 (not "localhost") avoids a ~2 s IPv6 (::1) connect detour on
    // some Windows boxes before cloudflared falls back to IPv4 (aldrich 2026-06).
    cmd.args(["tunnel", "--url", &format!("http://127.0.0.1:{}", port)]);
    // Registered in the shared slot BY the spawn, not once the start is judged
    // successful — everything below this line can fail, and every one of those
    // paths must be able to reach the process it left running.
    let (pid, stderr) = spawn_and_register_tunnel(cmd, &state.remote)?;
    info!(pid = pid, port = port, "tunnel started");
    println!("[Tunnel] cloudflared started (PID {}), tunneling localhost:{}", pid, port);

    let captured_url = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let url_clone = captured_url.clone();

    // Spawn thread to read stderr and capture the URL
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
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

    // #aldrich (Discord 2026-06-13, "Error HTTP:503" on the phone): a
    // trycloudflare quick-tunnel PRINTS its public URL several seconds before
    // Cloudflare's edge↔origin path is actually ready to serve — so a phone
    // that scans the QR immediately gets a transient 503. Poll the public
    // /mobile route (exactly what the QR points at) until it answers, before we
    // mark the URL ready. Bounded with a fallback: if it never becomes ready
    // within the budget we proceed anyway (old behaviour) rather than hang.
    if !url.is_empty() {
        if let Ok(client) = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .no_proxy()
            .build()
        {
            let probe = format!("{}/mobile", url);
            for _ in 0..20 { // ~20 × 600 ms ≈ 12 s readiness budget
                match client.get(&probe).send().await {
                    Ok(resp) if resp.status().is_success() => break,
                    _ => tokio::time::sleep(std::time::Duration::from_millis(600)).await,
                }
            }
        }
    }

    if url.is_empty() {
        // #29: previously we returned `Ok("Tunnel started but URL not yet
        // available...")` here, which the frontend stored as `tunnelUrl`
        // and then happily appended `/mobile` to — pointing the QR at a
        // sentence instead of a URL. Return Err so `startTunnel()` in the
        // store keeps `tunnelActive=false`, the QR falls back to the LAN
        // URL, and the user sees a real reason in the error chip.
        //
        // The process goes with the error. cloudflared may still print its URL
        // a minute later and go live, and reporting a failure the caller
        // records as `tunnelActive=false` while leaving a live public tunnel
        // behind is exactly the state this whole area is being fixed for.
        warn!(pid = pid, "tunnel URL did not appear within 15s");
        kill_registered_tunnel(&state.remote, pid);
        {
            let mut turl = tunnel_url_arc.lock().await;
            *turl = None;
        }
        return Err(format!(
            "Cloudflare tunnel started but no public URL appeared within 15 s (cloudflared PID {}). \
             This usually means cloudflared can't reach Cloudflare's edge — check firewall / VPN, \
             then click Restart. LAN dispatch still works in the meantime.",
            pid
        ));
    }

    // The process is already in the slot (`spawn_and_register_tunnel`), so all
    // that is left is publishing the URL.

    // Store tunnel URL in shared state (so axum handlers see it)
    {
        let mut turl = tunnel_url_arc.lock().await;
        *turl = Some(url.clone());
    }

    Ok(url)
}

#[tauri::command]
pub async fn stop_tunnel(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let (child, tunnel_url_arc) = {
        let mut remote = state.remote.lock().map_err(|e| e.to_string())?;
        (remote.tunnel_child.take(), remote.tunnel_url.clone())
    };

    if let Some(child) = child {
        kill_tunnel_child(child);
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
        (remote.tunnel_pid(), remote.tunnel_url.clone())
    };
    let turl = tunnel_url_arc.lock().await;
    Ok(serde_json::json!({
        "active": pid.is_some(),
        "url": turl.clone(),
    }))
}

// ─── Router builder ───

fn build_router(state: RemoteState) -> Router {
    // Same-origin only. The mobile page is served from this server and calls
    // its APIs same-origin, so no cross-origin access is needed. The previous
    // `CorsLayer::permissive()` reflected ANY origin onto the shell/file/proxy
    // routes — an unnecessary exposure if a token ever leaked. `new()` adds no
    // permissive CORS headers (same-origin requests are unaffected).
    let cors = CorsLayer::new();

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

#[cfg(test)]
mod jwt_refresh_tests {
    use super::{
        generate_jwt, validate_jwt, should_refresh_jwt, should_slide_session, JWT_TTL_SECS,
        MAX_SESSION_SECS,
    };

    // #73 (ossobucco): sliding-session decision boundaries.
    #[test]
    fn refresh_only_in_second_half_of_ttl() {
        let ttl = JWT_TTL_SECS; // 3600
        let now = 1_000_000u64;
        // Fresh token (full TTL left) — no refresh yet
        assert!(!should_refresh_jwt(now + ttl, now, ttl));
        // Just past half spent — refresh
        assert!(should_refresh_jwt(now + ttl / 2 - 1, now, ttl));
        // Exactly half left — boundary, no refresh
        assert!(!should_refresh_jwt(now + ttl / 2, now, ttl));
        // Expired or exactly-now — never refresh (the 401 path owns that)
        assert!(!should_refresh_jwt(now - 1, now, ttl));
        assert!(!should_refresh_jwt(now, now, ttl));
    }

    // Security-review 2.5.7: the sliding refresh must STOP at the session cap so
    // a leaked token can't be renewed forever.
    #[test]
    fn slide_stops_past_max_session() {
        let iat = 1_000_000u64;
        // A token past half-life, early in the session → slides.
        let now_early = iat + 100;
        let exp_soon = now_early + JWT_TTL_SECS / 2 - 1;
        assert!(should_slide_session(iat, exp_soon, now_early));
        // Same past-half-life token, but the session is now past the cap → no slide,
        // even though should_refresh_jwt alone would still say yes.
        let now_late = iat + MAX_SESSION_SECS + 1;
        let exp_late = now_late + JWT_TTL_SECS / 2 - 1;
        assert!(should_refresh_jwt(exp_late, now_late, JWT_TTL_SECS));
        assert!(!should_slide_session(iat, exp_late, now_late));
        // Exactly at the cap boundary → no slide.
        let now_cap = iat + MAX_SESSION_SECS;
        assert!(!should_slide_session(iat, now_cap + JWT_TTL_SECS / 2 - 1, now_cap));
    }

    #[test]
    fn refreshed_jwt_roundtrips_with_same_identity_and_iat() {
        let secret = "test-secret";
        let session_start = 1_700_000_000u64;
        let tok = generate_jwt(secret, "1.2.3.4", "device-1", session_start).unwrap();
        let claims = validate_jwt(secret, &tok).unwrap();
        assert_eq!(claims.sub, "device-1");
        assert_eq!(claims.ip, "1.2.3.4");
        assert_eq!(claims.iat as u64, session_start);
        // A refresh mints a token for the SAME identity, carrying iat UNCHANGED
        // (so the session cap is measured from the original pairing, not the renew).
        let fresh = generate_jwt(secret, &claims.ip, &claims.sub, claims.iat as u64).unwrap();
        let fresh_claims = validate_jwt(secret, &fresh).unwrap();
        assert_eq!(fresh_claims.sub, "device-1");
        assert_eq!(fresh_claims.ip, "1.2.3.4");
        assert_eq!(fresh_claims.iat as u64, session_start);
        assert!(fresh_claims.exp >= claims.exp);
    }
}

#[cfg(test)]
mod proxy_gate_path_tests {
    use super::{comfy_extra_permission, gate_path, ollama_requires_downloads};

    /// Security review 2026-07-30. The gates matched `uri().path()`, which axum
    /// hands over undecoded, and then forwarded that same raw path to a target
    /// that decodes before dispatching. So `/api/%70ull` was not "/api/pull" for
    /// us and was exactly that for Ollama, and `/%75pload/image` reached
    /// ComfyUI's real upload handler with the filesystem permission switched off.
    #[test]
    fn a_percent_encoded_path_still_hits_its_permission_gate() {
        for evil in [
            "/api/%70ull",
            "/api/pu%6Cl",
            "/api/%64elete",
            "/api/%70%75%6C%6C",
            "/api/x/%2e%2e/pull",
        ] {
            assert!(
                ollama_requires_downloads(&gate_path(evil)),
                "downloads gate missed {evil:?} (gate saw {:?})",
                gate_path(evil),
            );
        }
        for (evil, want) in [
            ("/%75pload/image", "filesystem"),
            ("/upl%6Fad/mask", "filesystem"),
            ("/%6Danager/queue", "downloads"),
            ("/customnode%2Finstall", "downloads"),
        ] {
            assert_eq!(
                comfy_extra_permission(&gate_path(evil)),
                Some(want),
                "comfy gate missed {evil:?}",
            );
        }
    }

    /// Only the gate decodes. Ordinary paths must not change meaning, and a
    /// double-encoded escape has to stay inert on both sides: we decode once,
    /// the target decodes once, so `%2570` is "%70" to them and never "/pull".
    #[test]
    fn decoding_is_single_pass_and_leaves_ordinary_paths_alone() {
        assert_eq!(gate_path("/api/tags"), "/api/tags");
        assert_eq!(gate_path("/api/chat"), "/api/chat");
        assert_eq!(gate_path("/userdata/workflows%2Ffoo.json"), "/userdata/workflows/foo.json");
        assert_eq!(gate_path("/api/%2570ull"), "/api/%70ull");
        assert!(!ollama_requires_downloads(&gate_path("/api/%2570ull")));
        // Read-only endpoints stay open, or an authenticated phone cannot chat.
        for open in ["/api/tags", "/api/chat", "/api/show", "/api/embeddings"] {
            assert!(!ollama_requires_downloads(&gate_path(open)), "{open} got gated");
        }
        assert_eq!(comfy_extra_permission(&gate_path("/prompt")), None);
        assert_eq!(comfy_extra_permission(&gate_path("/history/abc-123")), None);
    }
}

#[cfg(test)]
mod remote_path_tests {
    use super::resolve_remote_path;
    use crate::state::AppState;

    /// Bug 1 regression — without the override the relative path from a
    /// mobile `file_list` falls back to ~/agent-workspace/__remote__/ and
    /// the user's actual project folder is never touched.
    #[test]
    fn relative_without_override_uses_default_workspace() {
        let state = AppState::new();
        let resolved = resolve_remote_path("client/public", Some("__remote__"), &state).unwrap();
        let s = resolved.replace('\\', "/");
        let erwartet = format!(
            "{}/__remote__/client/public",
            crate::app_identity::AGENT_WORKSPACE_DIR
        );
        assert!(s.contains(&erwartet), "got: {}", s);
    }

    /// Override set → relative paths land inside it.
    /// Path separators are normalised — PathBuf::join keeps the input
    /// separator verbatim, so on Windows `target.join("client/public")`
    /// still contains the forward slash.
    #[test]
    fn relative_with_override_lands_in_override_folder() {
        let state = AppState::new();
        let target = std::env::temp_dir().join("lu-rrp-test-rel");
        state
            .chat_workspace_overrides
            .lock()
            .unwrap()
            .insert("__remote__".to_string(), target.clone());

        let resolved = resolve_remote_path("client/public/index.html", Some("__remote__"), &state).unwrap();
        let actual = resolved.replace('\\', "/");
        let expected = target
            .join("client")
            .join("public")
            .join("index.html")
            .to_string_lossy()
            .replace('\\', "/");
        assert_eq!(actual, expected);
    }

    /// Security (path-jail): an absolute path INSIDE the override workspace is
    /// accepted, but one OUTSIDE it — or a `..` escape — is rejected, so a
    /// remote client can't read/write/cd to arbitrary disk locations.
    #[test]
    fn absolute_inside_ok_outside_and_traversal_rejected() {
        let state = AppState::new();
        let target = std::env::temp_dir().join("lu-rrp-test-jail");
        state
            .chat_workspace_overrides
            .lock()
            .unwrap()
            .insert("__remote__".to_string(), target.clone());

        // Inside the workspace → allowed.
        let inside = target.join("sub").join("foo.txt");
        assert!(resolve_remote_path(&inside.to_string_lossy(), Some("__remote__"), &state).is_ok());

        // Outside the workspace → rejected.
        let abs = if cfg!(windows) { "C:/Windows/System32/foo.txt" } else { "/etc/passwd" };
        assert!(resolve_remote_path(abs, Some("__remote__"), &state).is_err());

        // `..` climbing out → rejected.
        assert!(resolve_remote_path("../../../../etc/passwd", Some("__remote__"), &state).is_err());
    }

    #[test]
    fn every_dispatched_tool_has_a_permission_decision() {
        use super::{gate_for, ToolGate};
        // The list mirrors the match in handle_agent_tool's dispatch. If a tool
        // is added there without a decision in gate_for, this fails instead of
        // the tool quietly running ungated.
        for tool in [
            "file_read", "file_write", "file_list", "file_search", "screenshot",
            "shell_execute", "code_execute", "image_generate", "process_list",
            "web_search", "web_fetch", "system_info", "get_current_time",
        ] {
            assert_ne!(gate_for(tool), ToolGate::Unknown, "{} has no gate", tool);
        }
    }

    #[test]
    fn looking_at_the_desktop_needs_a_toggle() {
        use super::{gate_for, ToolGate};
        // Both show what the person is doing on their machine.
        assert_eq!(gate_for("screenshot"), ToolGate::Needs("filesystem"));
        assert_eq!(gate_for("process_list"), ToolGate::Needs("process_control"));
    }

    #[test]
    fn code_execution_never_rides_on_file_access() {
        use super::{gate_for, ToolGate};
        assert_eq!(gate_for("shell_execute"), ToolGate::Needs("shell"));
        assert_eq!(gate_for("code_execute"), ToolGate::Needs("shell"));
    }

    #[test]
    fn an_unlisted_tool_is_refused() {
        use super::{gate_for, ToolGate};
        assert_eq!(gate_for("file_delete"), ToolGate::Unknown);
        assert_eq!(gate_for(""), ToolGate::Unknown);
    }

    #[test]
    fn shell_permission_is_off_by_default() {
        // C1: a freshly-dispatched remote server must NOT grant shell/code
        // execution by default — it's RCE-class and opt-in only.
        let p = super::RemotePermissions::default();
        assert!(!p.shell, "remote `shell` permission must default to false");
    }

    #[test]
    fn all_remote_permissions_are_off_by_default() {
        // RA-1: the desktop panel renders every toggle OFF on a fresh start.
        // The server default has to agree, otherwise a user who deliberately
        // granted nothing still handed a paired phone workspace read/write,
        // model pull/delete and ComfyUI start/stop.
        let p = super::RemotePermissions::default();
        assert!(!p.filesystem, "filesystem must default to false");
        assert!(!p.downloads, "downloads must default to false");
        assert!(!p.process_control, "process_control must default to false");
        assert!(!p.shell, "shell must default to false");
    }

    #[test]
    fn remote_permissions_serialize_with_snake_case_keys() {
        // RA-1 read-back contract: `start_remote_server` / `remote_server_status`
        // embed this struct as `permissions`, and the frontend store maps
        // exactly these key names into RemoteState.permissions.
        let json = serde_json::to_value(super::RemotePermissions {
            filesystem: true,
            downloads: false,
            process_control: true,
            shell: false,
        })
        .unwrap();
        assert_eq!(json["filesystem"], serde_json::json!(true));
        assert_eq!(json["downloads"], serde_json::json!(false));
        assert_eq!(json["process_control"], serde_json::json!(true));
        assert_eq!(json["shell"], serde_json::json!(false));
    }

    #[test]
    fn remote_permissions_deserialize_without_shell_defaults_false() {
        // Older mobile/client payloads omit `shell`; serde default must be false.
        let p: super::RemotePermissions =
            serde_json::from_str(r#"{"filesystem":true,"downloads":true,"process_control":true}"#).unwrap();
        assert!(!p.shell);
    }

    #[test]
    fn a_paired_device_cannot_raise_any_permission() {
        // SECURITY: an authenticated client POSTing every scope true must not
        // move a single one of them. "Authenticated" is the only rung on this
        // ladder, so a scope a device can set is a scope with no gate at all —
        // it would hand itself the workspace, the screenshots, the model
        // pull/delete, the engine start/stop and (once) arbitrary commands.
        let current = super::RemotePermissions { filesystem: false, downloads: false, process_control: false, shell: false };
        let body = super::RemotePermissions { filesystem: true, downloads: true, process_control: true, shell: true };
        let merged = super::merge_remote_permissions(&current, body);
        assert!(!merged.filesystem, "remote bridge must NOT be able to grant filesystem");
        assert!(!merged.downloads, "remote bridge must NOT be able to grant downloads");
        assert!(!merged.process_control, "remote bridge must NOT be able to grant process_control");
        assert!(!merged.shell, "remote bridge must NOT be able to grant shell");
    }

    #[test]
    fn remote_merge_preserves_every_desktop_choice() {
        // The other direction: what the desktop granted stays granted. A phone
        // clearing the boxes is not a decision the desktop made, and a second
        // paired phone must not be able to switch the first one's session off
        // either. All four scopes live on the desktop, in both directions.
        let current = super::RemotePermissions { filesystem: true, downloads: false, process_control: true, shell: true };
        let body = super::RemotePermissions { filesystem: false, downloads: true, process_control: false, shell: false };
        let merged = super::merge_remote_permissions(&current, body);
        assert!(merged.filesystem, "desktop-set filesystem must survive a remote update");
        assert!(!merged.downloads, "a scope the desktop left off must stay off");
        assert!(merged.process_control, "desktop-set process_control must survive a remote update");
        assert!(merged.shell, "desktop-set shell must survive a remote update");
    }
}

/// The remote bridge's five soft spots, all of them variations on one theme:
/// something the phone side was allowed to say about itself was believed.
///
/// * a forwarding header decided which row in Connected Devices a device owned
/// * a permissions POST decided what that device was allowed to do
/// * a disconnect body decided whose session ended
/// * `/remote-api/qr` handed a paired device the code that pairs the next one
/// * the code itself was compared with an operator that stops at the first
///   wrong digit
///
/// and the sixth, on the other side of the app: the public tunnel outlived the
/// process that opened it.
#[cfg(test)]
mod remote_hardening_tests {
    use super::*;
    use axum::http::HeaderMap;
    use std::net::SocketAddr;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        h
    }

    fn peer(s: &str) -> Option<SocketAddr> {
        Some(s.parse().unwrap())
    }

    // ── client_ip: who the peer says it is vs. who it is ──

    #[test]
    fn a_lan_client_cannot_choose_its_own_address() {
        // The attack: a second paired phone sets X-Forwarded-For to the first
        // phone's address. Devices dedup on this string, so it took over the
        // first phone's row — which ends that phone's session, because
        // auth_middleware only honours a token whose device is still listed.
        let h = headers(&[("x-forwarded-for", "192.168.1.10"), ("x-real-ip", "192.168.1.10")]);
        assert_eq!(client_ip(&h, peer("192.168.1.77:51000")), "192.168.1.77");
    }

    #[test]
    fn the_local_tunnel_is_the_only_trusted_proxy() {
        // cloudflared runs on this machine and reaches us over loopback. That
        // is the one peer whose forwarding headers describe someone else.
        let h = headers(&[("x-forwarded-for", "203.0.113.9")]);
        assert_eq!(client_ip(&h, peer("127.0.0.1:41234")), "203.0.113.9");
    }

    #[test]
    fn a_prepended_forwarded_for_hop_loses_to_the_proxys_own() {
        // Cloudflare APPENDS the visitor to whatever X-Forwarded-For the
        // visitor already sent, so the first entry is the one the attacker
        // wrote and the last is the edge's. Reading the first made the header
        // forgeable again on the one path where it is trusted at all.
        let h = headers(&[("x-forwarded-for", "10.0.0.1, 203.0.113.9")]);
        assert_eq!(client_ip(&h, peer("127.0.0.1:41234")), "203.0.113.9");
    }

    #[test]
    fn cf_connecting_ip_beats_a_forged_forwarded_for() {
        // The edge overwrites CF-Connecting-IP instead of appending to it.
        let h = headers(&[
            ("cf-connecting-ip", "203.0.113.9"),
            ("x-forwarded-for", "10.0.0.1"),
        ]);
        assert_eq!(client_ip(&h, peer("127.0.0.1:41234")), "203.0.113.9");
    }

    #[test]
    fn without_a_peer_address_nothing_is_trusted() {
        // No peer means we cannot tell whether a proxy is in front of us.
        let h = headers(&[("x-forwarded-for", "203.0.113.9")]);
        assert_eq!(client_ip(&h, None), "unknown");
    }

    #[test]
    fn a_lan_client_without_headers_still_gets_its_own_address() {
        // Bug #3 must stay fixed: no headers on LAN used to collapse every
        // client into one "unknown" bucket, sharing a rate limit and a row.
        assert_eq!(client_ip(&HeaderMap::new(), peer("192.168.1.42:52000")), "192.168.1.42");
    }

    // ── the device list ──

    fn device(id: &str, ip: &str, last_seen: u64) -> ConnectedDevice {
        ConnectedDevice {
            id: id.to_string(),
            ip: ip.to_string(),
            user_agent: "test".to_string(),
            last_seen,
        }
    }

    #[test]
    fn two_lan_devices_keep_two_rows() {
        let now = 1_700_000_000u64;
        let mut devices = vec![device("dev-a", "192.168.1.10", now)];
        upsert_device(&mut devices, "dev-b".into(), "192.168.1.77".into(), "phone".into(), now);
        assert_eq!(devices.len(), 2, "two distinct peers must not share a row");
        assert!(devices.iter().any(|d| d.id == "dev-a"));
        assert!(devices.iter().any(|d| d.id == "dev-b"));
    }

    #[test]
    fn the_same_device_reauthenticating_keeps_one_row() {
        // Reauth after a passcode regen must refresh the row, not stack a ghost.
        let now = 1_700_000_000u64;
        let mut devices = vec![device("dev-a", "192.168.1.10", now - 5)];
        upsert_device(&mut devices, "dev-a2".into(), "192.168.1.10".into(), "phone".into(), now);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "dev-a2");
        assert_eq!(devices[0].last_seen, now);
    }

    #[test]
    fn a_device_silent_past_the_token_lifetime_is_pruned() {
        let now = 1_700_000_000u64;
        let mut devices = vec![device("stale", "192.168.1.10", now - JWT_TTL_SECS - 1)];
        upsert_device(&mut devices, "fresh".into(), "192.168.1.77".into(), "phone".into(), now);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "fresh");
    }

    // ── disconnect ──

    #[test]
    fn disconnect_removes_the_caller_and_leaves_the_rest() {
        let now = 1_700_000_000u64;
        let mut devices = vec![device("mine", "192.168.1.10", now), device("theirs", "192.168.1.77", now)];
        assert_eq!(remove_own_device(&mut devices, "mine", "mine"), StatusCode::OK);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "theirs");
    }

    #[test]
    fn disconnect_cannot_end_another_devices_session() {
        // The whole point: a device row IS a session, so naming someone else's
        // id was a way to log the desktop owner's phone out from another phone.
        let now = 1_700_000_000u64;
        let mut devices = vec![device("mine", "192.168.1.10", now), device("theirs", "192.168.1.77", now)];
        assert_eq!(remove_own_device(&mut devices, "mine", "theirs"), StatusCode::FORBIDDEN);
        assert_eq!(devices.len(), 2, "a refused disconnect must change nothing");
    }

    // ── the disconnect/devices HANDLERS, not just their helpers ──
    //
    // The two tests above prove `remove_own_device`. They do NOT prove that the
    // endpoint uses it: a gegenprüfer put the old, vulnerable body back into
    // `handle_disconnect` and the whole suite stayed green, because nothing ran
    // the handler. These do — the handlers take the device list as their axum
    // sub-state precisely so they can be called here.

    fn registry(devices: Vec<ConnectedDevice>) -> DeviceRegistry {
        DeviceRegistry(Arc::new(TokioMutex::new(devices)))
    }

    fn caller(id: &str) -> Option<axum::Extension<CallerDevice>> {
        Some(axum::Extension(CallerDevice(id.to_string())))
    }

    async fn body_json(resp: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.expect("read body");
        serde_json::from_slice(&bytes).expect("json body")
    }

    #[tokio::test]
    async fn the_disconnect_endpoint_refuses_to_end_someone_elses_session() {
        let now = 1_700_000_000u64;
        let reg = registry(vec![
            device("mine", "192.168.1.10", now),
            device("theirs", "192.168.1.77", now),
        ]);
        let code = handle_disconnect(
            AxumState(reg.clone()),
            caller("mine"),
            Json(DisconnectRequest { id: "theirs".into() }),
        )
        .await;
        assert_eq!(code, StatusCode::FORBIDDEN, "the endpoint ended another device's session");
        let devices = reg.0.lock().await;
        assert_eq!(devices.len(), 2, "a refused disconnect must change nothing");
        assert!(devices.iter().any(|d| d.id == "theirs"), "the victim's row is gone");
    }

    #[tokio::test]
    async fn the_disconnect_endpoint_still_ends_the_callers_own_session() {
        let now = 1_700_000_000u64;
        let reg = registry(vec![
            device("mine", "192.168.1.10", now),
            device("theirs", "192.168.1.77", now),
        ]);
        let code = handle_disconnect(
            AxumState(reg.clone()),
            caller("mine"),
            Json(DisconnectRequest { id: "mine".into() }),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        let devices = reg.0.lock().await;
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "theirs");
    }

    #[tokio::test]
    async fn an_unidentified_caller_cannot_touch_the_device_list() {
        let now = 1_700_000_000u64;
        let reg = registry(vec![device("mine", "192.168.1.10", now)]);
        let code = handle_disconnect(
            AxumState(reg.clone()),
            None,
            Json(DisconnectRequest { id: "mine".into() }),
        )
        .await;
        assert_eq!(code, StatusCode::UNAUTHORIZED);
        assert_eq!(reg.0.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn the_devices_endpoint_shows_a_phone_only_its_own_row() {
        // Same class as the disconnect finding: "paired" was the only rung, so
        // every phone could read every other phone's id, address and user agent
        // — and that id was all the disconnect endpoint asked for.
        let now = 1_700_000_000u64;
        let reg = registry(vec![
            device("mine", "192.168.1.10", now),
            device("theirs", "192.168.1.77", now),
        ]);
        let json = body_json(handle_devices(AxumState(reg), caller("mine")).await).await;
        let rows = json.as_array().expect("a list of devices");
        assert_eq!(rows.len(), 1, "the endpoint served somebody else's row: {json}");
        assert_eq!(rows[0]["id"], "mine");
        assert!(!json.to_string().contains("192.168.1.77"), "another device's address leaked");
    }

    #[tokio::test]
    async fn the_devices_endpoint_refuses_an_unidentified_caller() {
        let reg = registry(vec![device("mine", "192.168.1.10", 1_700_000_000)]);
        let resp = handle_devices(AxumState(reg), None).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    // ── the pairing code ──

    #[test]
    fn the_passcode_compare_answers_correctly() {
        assert!(passcode_matches("123456", "123456"));
        assert!(!passcode_matches("123457", "123456"));
        assert!(!passcode_matches("023456", "123456"), "a wrong first digit is still wrong");
        assert!(!passcode_matches("12345", "123456"), "a short guess is not a prefix match");
        assert!(!passcode_matches("1234567", "123456"), "a long guess is not a match either");
    }

    #[test]
    fn an_unset_passcode_matches_nothing() {
        // A server whose code has not been generated yet must not pair anyone
        // who sends an empty string.
        assert!(!passcode_matches("", ""));
        assert!(!passcode_matches("000000", ""));
    }

    // ── source guards ──
    //
    // Three of these fixes are properties of a code path that cannot be
    // exercised here: a Windows kernel flag, a process the OS kills for us,
    // and the absence of a short-circuiting comparison. A grep is a blunt
    // instrument, but it fails when the next edit undoes the fix rather than
    // after the next incident.

    const REMOTE_RS: &str = include_str!("remote.rs");

    /// remote.rs with EVERY `#[cfg(test)]` module cut out. The assertions below
    /// quote the code they are guarding, and matching themselves would make
    /// them free.
    ///
    /// This used to split on the first line of `jwt_refresh_tests` and keep the
    /// head. Two test modules (`openai_bridge_tests`, `openai_bridge_live_tests`)
    /// sit ABOVE that one, so their bodies counted as production code: a guard
    /// that asserts a string is absent could be satisfied by a test having it,
    /// and a guard that asserts a string is present could be satisfied by a
    /// test quoting it. Every `#[cfg(test)]` block is removed instead, so the
    /// result is the half that actually ships however the file is reordered.
    fn production_code() -> &'static str {
        static PROD: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        PROD.get_or_init(|| {
            const MARKER: &str = "\n#[cfg(test)]\n";
            let mut out = String::with_capacity(REMOTE_RS.len());
            let mut rest = REMOTE_RS;
            while let Some(at) = rest.find(MARKER) {
                out.push_str(&rest[..=at]); // everything before the attribute
                let block = &rest[at + 1..]; // starts at `#[cfg(test)]`
                // A top-level item ends at the first `}` in column 0.
                match block.find("\n}\n") {
                    Some(end) => rest = &block[end + 3..],
                    None => {
                        rest = "";
                        break;
                    }
                }
            }
            out.push_str(rest);
            out
        })
    }

    #[test]
    fn the_source_guard_really_reads_the_production_half() {
        // A guard on the guards: if the split silently returned everything, or
        // nothing, every assertion below would pass for free.
        let head = production_code();
        assert!(head.len() < REMOTE_RS.len(), "the split kept the test modules");
        assert!(head.contains("async fn handle_auth("), "the split dropped production code");
        assert!(!head.contains("mod remote_hardening_tests"), "the split kept this module");
        // EVERY test module, not just the first one: the modules above
        // jwt_refresh_tests used to count as production code.
        for m in [
            "mod openai_bridge_tests",
            "mod openai_bridge_live_tests",
            "mod jwt_refresh_tests",
            "mod proxy_gate_path_tests",
            "mod remote_path_tests",
            "mod mobile_decay_tests",
            "mod mobile_environment_tests",
        ] {
            assert!(!head.contains(m), "the split kept {m}");
        }
        assert!(
            !head.contains("#[cfg(test)]"),
            "a test-only block survived the split",
        );
        // And it must not have eaten the production code that follows the
        // first test module — build_router lives well below it.
        assert!(head.contains("fn build_router("), "the split dropped everything after the first test module");
        assert!(head.contains("pub async fn start_tunnel("), "the split dropped the tunnel code");
    }

    /// The body of a top-level `fn` in the production half, from its signature
    /// to the closing brace in column 0.
    fn fn_body(name: &str) -> &'static str {
        let head = production_code();
        let at = head
            .find(&format!("fn {name}("))
            .unwrap_or_else(|| panic!("fn {name} is gone"));
        let end = head[at..].find("\n}\n").expect("unterminated fn") + at;
        &head[at..end]
    }

    #[test]
    fn the_function_slicer_reads_one_function() {
        // A guard on the guard below: a slicer that returned the whole file
        // would make every assertion on a function body meaningless.
        let body = fn_body("passcode_matches");
        assert!(body.contains("fn passcode_matches("));
        assert!(!body.contains("fn generate_jwt("), "the slice ran past its function");
    }

    #[test]
    fn the_passcode_is_never_compared_with_a_short_circuiting_operator() {
        // Nothing observable distinguishes a constant-time compare from a fast
        // one on a machine under load, so what is pinned is the shape: every
        // byte folded into one accumulator, and no `==`/`!=` on the two codes
        // anywhere. Timing was the whole point — a `==` that returns the right
        // answer is still the bug.
        let head = production_code();
        assert!(
            head.contains("if !passcode_matches(&body.passcode, &pc.code)"),
            "handle_auth no longer routes the code through the constant-time compare"
        );
        assert!(
            !head.contains("body.passcode != pc.code"),
            "the short-circuiting compare is back"
        );
        let body = fn_body("passcode_matches");
        assert!(
            body.contains("diff |="),
            "the compare no longer folds the bytes into one accumulator"
        );
        for shortcut in ["a == b", "a != b", "supplied == expected", "supplied != expected"] {
            assert!(
                !body.contains(shortcut),
                "passcode_matches short-circuits again on `{shortcut}`"
            );
        }
    }

    #[test]
    fn windows_never_asks_for_a_reusable_address() {
        // On Unix SO_REUSEADDR only skips TIME_WAIT. On Windows it lets any
        // process running as this user bind 0.0.0.0:11435 too and take the
        // incoming pairing connections.
        let head = production_code();
        assert!(
            head.contains("#[cfg(not(windows))]\n    socket.set_reuse_address(true)?;"),
            "the reuse flag is not gated off Windows any more"
        );
        assert!(
            head.contains("#[cfg(windows)]\n    set_exclusive_addr_use(&socket)?;"),
            "Windows must bind the address exclusively"
        );
        assert_eq!(
            head.matches("set_reuse_address(").count(),
            1,
            "there is exactly one place that sets the reuse flag"
        );
    }

    #[test]
    fn the_tunnel_is_tied_to_the_app_lifetime() {
        // The repo's own mechanism for "this child dies with the app": on
        // Windows the kill-on-close job object, which survives a hard kill.
        let head = production_code();
        assert!(
            head.contains("crate::commands::process::tie_child_to_app_lifetime(pid);"),
            "the cloudflared spawn no longer joins the app's lifetime"
        );
        assert!(
            head.contains("crate::process_util::spawn_piped(cmd)"),
            "the tunnel must be spawned through process_util (own process group)"
        );
    }

    // ── the tunnel process ──

    #[test]
    fn only_a_cloudflared_pointed_at_our_port_is_swept() {
        let cmd = |s: &str| s.split(' ').map(String::from).collect::<Vec<_>>();
        assert!(is_stale_tunnel_process(
            "cloudflared",
            &cmd("cloudflared tunnel --url http://127.0.0.1:11435"),
            11435
        ));
        assert!(is_stale_tunnel_process(
            "cloudflared.exe",
            &cmd("cloudflared.exe tunnel --url http://localhost:11435"),
            11435
        ));
        // A tunnel the user runs for their own reasons is none of our business.
        assert!(!is_stale_tunnel_process(
            "cloudflared",
            &cmd("cloudflared tunnel --url http://127.0.0.1:8080"),
            11435
        ));
        // Neither is anything else that happens to mention the port.
        assert!(!is_stale_tunnel_process(
            "ngrok",
            &cmd("ngrok http 127.0.0.1:11435"),
            11435
        ));
        assert!(!is_stale_tunnel_process("cloudflared", &cmd("cloudflared --version"), 11435));
    }

    // ── the sweep against the REAL process table ────────────────────────────
    //
    // The pure tests above feed `is_stale_tunnel_process` hand-written strings
    // and have always passed — including for the fifteen months the sweep could
    // not match anything at all, because `refresh_processes` never fetched the
    // argv they were pretending to be. Something has to read real data.
    //
    // ── 01.09.2026: why the stand-in changed ──
    //
    // It used to be a COPY of `/bin/sh` named `cloudflared`, which is the only
    // way to get a live process whose `name()` is what the matcher wants. That
    // stand-in was reported failing twice under a full rebuild, and measuring
    // it explains why: **macOS SIGKILLs it.** An exec'd copy of a SIP platform
    // binary lived 95–486 ms across 15 measured spawns (mean ~250 ms) and was
    // then killed by the kernel, every single time — `sleep 30` was never
    // reached. The old test slept 50 ms and then took a process-table snapshot,
    // so it was racing the kernel inside a window of a few hundred
    // milliseconds. Idle it won; under load it did not, because the first
    // snapshot alone costs ~280 ms when 18 test threads contend for it
    // (measured). Once the window closed, the remaining 39 iterations scanned
    // for a corpse and the test reported "the sweep did not find a live
    // cloudflared" — blaming the sweep for the kernel's decision.
    //
    // So the stand-in is now a shebang script, which the OS keeps running
    // indefinitely: `/bin/sh` reading from a pipe this test holds. It blocks in
    // a builtin, so there is no `sleep` grandchild to orphan, and closing the
    // pipe or killing the child ends it at once.
    //
    // A shebang's `name()` is the interpreter ("bash" on macOS), not the
    // script, so THAT stand-in cannot impersonate a cloudflared — it carries a
    // real argv and a real name, which is what the three decomposed tests
    // below need, but not the name the sweep looks for.
    //
    // The positive end-to-end direction gets its own stand-in, and the reason
    // it is a different one is worth writing down: SIP kills copies of
    // PLATFORM binaries, not copies of anything. Measured the same way, 15
    // spawns of a copy of this crate's own (ad-hoc, linker-signed) test binary
    // ran past a second and exited normally every time, with no SIGKILL at
    // all. So `examples/park.rs` is compiled by the toolchain and copied under
    // the name `cloudflared` — a real process, really named that, really
    // publishing our port, found by the real sweep. See
    // `the_sweep_finds_a_real_cloudflared_by_its_argv`.

    /// A live process with an argv we chose, that the OS will keep running.
    ///
    /// Returns the child plus the tempdir that has to outlive it.
    #[cfg(unix)]
    fn live_stand_in(port: u16) -> (tempfile::TempDir, std::process::Child) {
        use std::os::unix::fs::PermissionsExt;
        use std::process::{Command, Stdio};

        let dir = tempfile::tempdir().expect("tempdir");
        let script = dir.path().join("cloudflared");
        // `read` is a shell builtin: the process blocks in it without forking,
        // so nothing is left behind when this test drops the pipe.
        std::fs::write(&script, "#!/bin/sh\nread ignored\n").expect("write the stand-in");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        let child = Command::new(&script)
            .args(["tunnel", "--url", &format!("http://127.0.0.1:{port}")])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn the stand-in");
        (dir, child)
    }

    /// A process table that has PROVEN itself, or the reason it could not.
    ///
    /// Moved to `test_support::checked_table` when `commands/process.rs` needed
    /// the same guarantee for the ComfyUI adoption scan — the argument for it is
    /// written out there, in one copy.
    #[cfg(unix)]
    use crate::test_support::checked_table;

    /// A live process that really is NAMED `cloudflared`, publishing `port`.
    ///
    /// `examples/park.rs` compiled by this same toolchain, copied under the
    /// name the matcher reads. Ad-hoc/linker-signed rather than platform-
    /// signed, so none of the SIGKILL story above applies to it; it blocks on
    /// the stdin pipe this test holds, so it lives exactly as long as the test
    /// wants and leaves nothing behind.
    #[cfg(unix)]
    fn live_cloudflared(port: u16) -> (tempfile::TempDir, std::process::Child) {
        use std::process::{Command, Stdio};

        let park = crate::test_support::park_binary();

        let dir = tempfile::tempdir().expect("tempdir");
        let bin = dir.path().join("cloudflared");
        std::fs::copy(&park, &bin).expect("copy the stand-in");

        let child = Command::new(&bin)
            .args(["tunnel", "--url", &format!("http://127.0.0.1:{port}")])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn the stand-in");
        (dir, child)
    }

    /// The positive end-to-end direction, and the one T-39 depends on: a real,
    /// live `cloudflared` publishing our port is FOUND by the sweep.
    ///
    /// Everything in it is real — the process, its name, its argv, the process
    /// table, the matcher. Nothing is substituted. It is asserted on a snapshot
    /// `checked_table` has already vouched for, so there is no clock and no
    /// retry standing in for a guarantee.
    #[cfg(unix)]
    #[test]
    fn the_sweep_finds_a_real_cloudflared_by_its_argv() {
        // Its own port, so that nothing it asserts can depend on what the other
        // stand-ins in this module happen to be doing at the same moment.
        let port: u16 = 61436;
        let (_dir, mut child) = live_cloudflared(port);
        let pid = child.id();
        let table = checked_table(pid);
        let _ = child.kill();
        let _ = child.wait();

        let sys = table.unwrap_or_else(|why| panic!("{why}"));
        let entry = sys
            .process(sysinfo::Pid::from_u32(pid))
            .expect("checked_table only returns a table containing this pid");

        // If this ever fails the rest means nothing: the stand-in would not be
        // impersonating a cloudflared at all.
        assert_eq!(
            entry.name().to_string_lossy(),
            "cloudflared",
            "the stand-in is not reported under the name the sweep matches on",
        );
        assert!(
            find_stale_tunnels(&sys, port).contains(&pid),
            "the sweep did not find a live cloudflared publishing {port} — this is exactly \
             the state the sweep was in while it reported 0 killed on every start. argv={:?}",
            crate::process_util::cmdline_of(entry),
        );
        assert!(
            !find_stale_tunnels(&sys, port + 1).contains(&pid),
            "a sweep for another port matched this tunnel",
        );
    }

    /// The fifteen-month bug itself, on real data.
    ///
    /// `refresh_processes` does not fetch command lines, so `Process::cmd()`
    /// came back EMPTY for every process and every matcher was silently handed
    /// "". `process_table_with_cmdlines` exists to prevent that, and this is
    /// the only test that can tell whether it does: a live process whose argv
    /// this test chose, read back out of the real table.
    #[cfg(unix)]
    #[test]
    fn the_process_table_really_carries_a_live_process_argv() {
        let port: u16 = 61435;
        let (_dir, mut child) = live_stand_in(port);
        let pid = child.id();
        let table = checked_table(pid);
        let _ = child.kill();
        let _ = child.wait();

        let sys = table.unwrap_or_else(|why| panic!("{why}"));
        let entry = sys
            .process(sysinfo::Pid::from_u32(pid))
            .expect("checked_table only returns a table containing this pid");
        let argv = crate::process_util::cmdline_of(entry);

        assert!(
            !argv.is_empty(),
            "the process table carries NO command line for a live process — this is the \
             state every argv matcher in this repo was silently in for fifteen months",
        );
        assert!(
            argv.iter().any(|a| a.contains(&format!("127.0.0.1:{port}"))),
            "the argv came back but not the one this test spawned: {argv:?}",
        );
    }

    /// The port half of the matcher, fed from the real table rather than from a
    /// string this test wrote.
    ///
    /// This is the join that was broken: `find_stale_tunnels` hands
    /// `cmdline_of(process)` to `is_stale_tunnel_process`, which joins it and
    /// asks `targets_loopback_port`. With an empty argv that join is "" and the
    /// answer is always false.
    #[cfg(unix)]
    #[test]
    fn the_port_matcher_reads_the_argv_the_table_actually_returns() {
        let port: u16 = 61435;
        let (_dir, mut child) = live_stand_in(port);
        let pid = child.id();
        let table = checked_table(pid);
        let _ = child.kill();
        let _ = child.wait();

        let sys = table.unwrap_or_else(|why| panic!("{why}"));
        let argv = crate::process_util::cmdline_of(
            sys.process(sysinfo::Pid::from_u32(pid)).expect("checked"),
        );
        let joined = argv.join(" ");

        assert!(
            targets_loopback_port(&joined, port),
            "the port matcher does not see the port in an argv read off the real table: {joined:?}",
        );
        assert!(
            !targets_loopback_port(&joined, port + 1),
            "a sweep for the neighbouring port matched this argv: {joined:?}",
        );
        // And the composition the sweep actually performs, with the one field
        // this platform will not let a stand-in carry substituted in: had this
        // real argv belonged to a process NAMED cloudflared, the sweep would
        // have taken it. The name half is covered exhaustively by
        // `only_a_cloudflared_pointed_at_our_port_is_swept` above.
        assert!(
            is_stale_tunnel_process("cloudflared", &argv, port),
            "a real cloudflared with this real argv would not have been swept: {argv:?}",
        );
    }

    /// The direction that can hurt a user: the sweep runs before the bind, on
    /// processes the user may well have started themselves, and it must leave
    /// every one of them alone. Asserted against a REAL live process that
    /// mentions our port and is not a cloudflared.
    #[cfg(unix)]
    #[test]
    fn the_sweep_leaves_a_live_stranger_on_our_port_alone() {
        let port: u16 = 61435;
        let (_dir, mut child) = live_stand_in(port);
        let pid = child.id();
        let table = checked_table(pid);
        let _ = child.kill();
        let _ = child.wait();

        let sys = table.unwrap_or_else(|why| panic!("{why}"));
        let entry = sys
            .process(sysinfo::Pid::from_u32(pid))
            .expect("checked_table only returns a table containing this pid");

        assert!(
            !find_stale_tunnels(&sys, port).contains(&pid),
            "the sweep would have killed a live process that publishes our port but is not a \
             cloudflared (name={:?}) — before the bind, on a machine that is not ours to \
             tidy up",
            entry.name(),
        );
    }

    #[test]
    fn a_sweep_for_one_port_does_not_kill_the_tunnel_of_another() {
        // The port was matched as a substring, so `127.0.0.1:1143` was "found"
        // inside `127.0.0.1:11435` — a sweep for 1143 killed the tunnel that
        // publishes 11435, and this sweep runs before the bind on processes the
        // user may have started themselves.
        let cmd = |s: &str| s.split(' ').map(String::from).collect::<Vec<_>>();
        let live = cmd("cloudflared tunnel --url http://127.0.0.1:11435");
        assert!(!is_stale_tunnel_process("cloudflared", &live, 1143), "a prefix of the port matched");
        assert!(!is_stale_tunnel_process("cloudflared", &live, 1), "a shorter prefix matched");
        assert!(!is_stale_tunnel_process("cloudflared", &live, 435), "a suffix of the port matched");
        assert!(is_stale_tunnel_process("cloudflared", &live, 11435), "the exact port stopped matching");
        // Same rule for the spelled-out host.
        let local = cmd("cloudflared tunnel --url http://localhost:11435");
        assert!(!is_stale_tunnel_process("cloudflared", &local, 1143));
        assert!(is_stale_tunnel_process("cloudflared", &local, 11435));
        // A port that only appears as part of a longer number is not our port.
        assert!(!targets_loopback_port("http://127.0.0.1:114350", 11435));
        assert!(!targets_loopback_port("http://127.0.0.1:911435", 11435));
    }

    /// A live child that outlives the test unless something kills it, spawned
    /// the way the tunnel is.
    #[cfg(unix)]
    fn sleeper() -> std::process::Child {
        let mut cmd = std::process::Command::new("sleep");
        cmd.arg("30");
        crate::process_util::spawn_piped(cmd).expect("spawn a sleeper")
    }

    /// A killed-but-unreaped child is a ZOMBIE — `ps -p` still lists it, so
    /// the process STATE has to be read, not its mere existence.
    #[cfg(unix)]
    fn alive(pid: u32) -> bool {
        let out = std::process::Command::new("ps")
            .args(["-o", "state=", "-p", &pid.to_string()])
            .output();
        match out {
            Ok(o) => {
                let st = String::from_utf8_lossy(&o.stdout).trim().to_string();
                !st.is_empty() && !st.starts_with('Z')
            }
            Err(_) => false,
        }
    }

    /// `kill_tree` signals now and escalates on a detached thread, so death is
    /// not observable on the calling line. Poll rather than sample once —
    /// asserting immediately would be a race dressed up as a test.
    #[cfg(unix)]
    fn dies_within(pid: u32, budget: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + budget;
        while std::time::Instant::now() < deadline {
            if !alive(pid) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        !alive(pid)
    }

    #[test]
    #[cfg(unix)]
    fn the_tunnel_dies_with_the_server_state() {
        // The finding: quitting the app left the quick tunnel running, so a
        // public *.trycloudflare.com address kept pointing at 127.0.0.1:11435
        // and the next launch silently published its session on it while the
        // UI reported the tunnel as off.
        let mut server = RemoteServer::new();
        let child = sleeper();
        let pid = child.id();
        server.tunnel_child = Some(child);
        assert!(alive(pid), "the stand-in tunnel did not start");

        drop(server);

        assert!(
            dies_within(pid, std::time::Duration::from_secs(5)),
            "the tunnel survived the server state it belongs to"
        );
    }

    #[test]
    #[cfg(unix)]
    fn the_tunnel_is_in_the_shared_slot_from_the_moment_it_is_spawned() {
        // The finding the `Child` was introduced for, narrowed to a window: the
        // process was held in a local variable until the start was judged
        // successful — 15 s waiting for the public URL plus ~12 s probing the
        // edge. For those ~27 seconds on EVERY start, `stop_tunnel` and `Drop`
        // both looked at an empty slot while a public *.trycloudflare.com
        // address was already live.
        let remote = std::sync::Mutex::new(RemoteServer::new());
        let mut cmd = std::process::Command::new("sleep");
        cmd.arg("30");
        let (pid, _stderr) = spawn_and_register_tunnel(cmd, &remote).expect("spawn a stand-in tunnel");
        assert!(alive(pid), "the stand-in tunnel did not start");
        assert_eq!(
            remote.lock().unwrap().tunnel_pid(),
            Some(pid),
            "the spawned tunnel is not reachable from the state every stop path reads",
        );

        // ...which is exactly what makes the failure paths able to close it.
        kill_registered_tunnel(&remote, pid);
        assert!(remote.lock().unwrap().tunnel_pid().is_none(), "the slot still holds a dead tunnel");
        assert!(
            dies_within(pid, std::time::Duration::from_secs(5)),
            "a failed start left the tunnel running",
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_failed_start_never_reaps_the_tunnel_that_replaced_it() {
        // Two starts race: the second replaces (and kills) the first, then the
        // first one's timeout fires. It must not take the live tunnel down.
        let remote = std::sync::Mutex::new(RemoteServer::new());
        let mut first = std::process::Command::new("sleep");
        first.arg("30");
        let (first_pid, _e1) = spawn_and_register_tunnel(first, &remote).expect("spawn first");
        let mut second = std::process::Command::new("sleep");
        second.arg("30");
        let (second_pid, _e2) = spawn_and_register_tunnel(second, &remote).expect("spawn second");
        assert_ne!(first_pid, second_pid);
        assert!(dies_within(first_pid, std::time::Duration::from_secs(5)), "the displaced tunnel survived");

        kill_registered_tunnel(&remote, first_pid);
        assert_eq!(
            remote.lock().unwrap().tunnel_pid(),
            Some(second_pid),
            "the stale failure path evicted the live tunnel",
        );
        assert!(alive(second_pid), "the stale failure path killed the live tunnel");

        kill_registered_tunnel(&remote, second_pid);
        assert!(dies_within(second_pid, std::time::Duration::from_secs(5)));
    }

    #[test]
    #[cfg(unix)]
    fn a_stopped_tunnel_is_reaped_and_not_left_as_a_zombie() {
        // The old kill-by-pid path never waited, so every stop left a zombie
        // for the rest of the app's life.
        let child = sleeper();
        let pid = child.id();
        kill_tunnel_child(child);
        assert!(
            dies_within(pid, std::time::Duration::from_secs(5)),
            "the stopped tunnel is still running or left behind as a zombie"
        );
    }

    #[test]
    #[cfg(unix)]
    fn stopping_the_tunnel_takes_its_children_with_it() {
        // `process_util::kill_tree` has two callers, and they do not spawn the
        // same way: video_cancel uses a plain `Command::spawn` (the child is in
        // OUR process group), this one uses `spawn_piped` (the child is its own
        // group leader). The walk is by parent link, so the difference must not
        // matter — asserted here rather than assumed, because the comment on
        // kill_tree used to claim video_cancel was the only caller.
        let mut cmd = std::process::Command::new("sh");
        cmd.arg("-c").arg("sleep 30 & sleep 30");
        let child = crate::process_util::spawn_piped(cmd).expect("spawn a tunnel stand-in");
        let pid = child.id();
        std::thread::sleep(std::time::Duration::from_millis(400));

        let mut sys = sysinfo::System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let kids = crate::commands::shell::descendants(pid, &sys);
        assert!(!kids.is_empty(), "the stand-in spawned nothing — test setup is wrong");

        kill_tunnel_child(child);

        for p in kids.iter().copied().chain(std::iter::once(pid)) {
            assert!(
                dies_within(p, std::time::Duration::from_secs(5)),
                "{p} survived the tunnel stop",
            );
        }
    }

    /// The body of `AppState::shutdown_subprocesses`, code lines only.
    ///
    /// Comment lines are dropped because the assertions below look for words
    /// like `kill` and `.lock(`, and the prose in that method is full of them.
    /// Only whole-line comments are stripped, so no string literal is touched.
    fn shutdown_body() -> String {
        let state_rs = include_str!("../state.rs");
        let from = state_rs
            .find("pub fn shutdown_subprocesses")
            .expect("state.rs no longer has a shutdown_subprocesses");
        let body = &state_rs[from..];
        let to = body
            .find("\nimpl Drop for AppState")
            .expect("state.rs no longer ends the shutdown impl with Drop for AppState");
        body[..to]
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// KF-1, as a pure decision — no process, no signal, every platform.
    ///
    /// The runtime proof lives in `state.rs` and needs a stand-in child; this
    /// one only asks whether the explicit quit path reaches for the tunnel
    /// slot at all, which is the whole of the bug: `shutdown_subprocesses`
    /// listed every other daemon and named the tunnel nowhere, so the tunnel
    /// depended on `Drop`, the very thing that method exists because Tauri
    /// does not reliably run. Cheap guard against a refactor quietly dropping
    /// the one line again — the same shape as trainer.rs's guard, for the same
    /// reason.
    #[test]
    fn the_explicit_quit_path_reaches_the_tunnel() {
        assert!(
            shutdown_body().contains("remote::shutdown_tunnel(&self.remote)"),
            "shutdown_subprocesses no longer kills the cloudflared tunnel (KF-1)",
        );
        // ...and it must take the slot, not borrow it: `Drop for AppState`
        // calls this method a second time and the managed `RemoteServer`'s own
        // Drop may follow, at a pid that may have been recycled.
        assert!(
            production_code().contains("self.tunnel_child.take()"),
            "the tunnel is no longer taken out of its slot, so a second pass re-kills its pid",
        );
    }

    /// The tunnel goes FIRST, and that is a promise, not a comment.
    ///
    /// ── Why this is a source test and not a runtime one ──
    ///
    /// "Died first" is not observable here without a race. Every kill in
    /// `shutdown_subprocesses` is issued microseconds after the previous one,
    /// and they are not even the same signal: the tunnel gets SIGTERM through
    /// `kill_tree` (SIGKILL only after an 800 ms grace), while Ollama and
    /// ComfyUI get `Child::kill`, which is SIGKILL immediately. So the daemon
    /// killed SECOND routinely reaches the reaper FIRST. A test that watched
    /// wall-clock death order would assert the opposite of the property, and
    /// flakily at that. The property is about the order the kills are ISSUED,
    /// and the source is where that order lives.
    ///
    /// ── What is asserted, and why it is not brittle ──
    ///
    /// Not "the tunnel is on line N", and not a list of the other daemons in
    /// order — both would go red for a harmless reshuffle. Only this: nothing
    /// is killed, and no other slot is even locked, BEFORE the tunnel. That is
    /// exactly the property the ordering argument rests on (the door is shut
    /// before the rooms behind it are emptied) and nothing more. Reordering
    /// the daemons below the tunnel, renaming a slot, or adding a log line in
    /// front all stay green; moving the tunnel down does not.
    #[test]
    fn the_tunnel_is_the_first_thing_the_quit_path_kills() {
        let body = shutdown_body();
        let at = body
            .find("remote::shutdown_tunnel(&self.remote)")
            .expect("the quit path does not kill the tunnel at all — see the test above");
        let before = &body[..at];

        for forbidden in [".lock(", "kill", ".stop("] {
            assert!(
                !before.contains(forbidden),
                "`{forbidden}` appears in shutdown_subprocesses BEFORE the tunnel is closed.\n\
                 The tunnel has to go first: while it is up, the internet still reaches the \n\
                 remote server on 11435, which proxies to the very daemons this method is \n\
                 killing. Every branch below it blocks (taskkill, lsof, process-table walks), \n\
                 so anything moved in front of it holds that door open for the whole of it.\n\
                 Offending prefix:\n{before}"
            );
        }
    }

    #[test]
    fn dropping_a_server_without_a_tunnel_is_a_no_op() {
        drop(RemoteServer::new());
        let mut server = RemoteServer::new();
        assert!(server.tunnel_pid().is_none());
        server.tunnel_child = None;
        drop(server);
    }

    // ── the QR endpoint ──

    #[test]
    fn the_qr_payload_carries_no_passcode() {
        // /remote-api/qr is reachable by anything that already paired. Handing
        // it the live code makes Disconnect undoable by the disconnected.
        let json = serde_json::to_value(QrResponse {
            qr_png_base64: "AAA".into(),
            url: "http://192.168.1.10:11435/mobile".into(),
        })
        .unwrap();
        assert!(json.get("passcode").is_none(), "the QR payload leaks the pairing code");
        assert!(json.get("url").is_some(), "the payload lost the field the caller needs");
    }

    #[test]
    fn the_listener_still_binds() {
        // Whichever flag the platform gets, the socket has to work.
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let _guard = rt.enter();
        let listener = build_reusable_listener(addr).expect("bind an ephemeral port");
        assert!(listener.local_addr().unwrap().port() != 0);
    }
}

/// T-75: the embedded page and `mobile-client/` are the same page.
///
/// `build.rs` assembles the client on every build and cargo re-runs it
/// whenever a source changes, so the embedded copy cannot lag behind in
/// practice. This module does not trust that. It re-derives the page from
/// `mobile-client/` right now and compares — because the failure this whole
/// change is about is exactly "two versions, one of them maintained", and a
/// generated artefact that silently keeps an old body is that failure wearing
/// a build step.
#[cfg(test)]
mod mobile_source_of_truth_tests {
    use crate::mobile_page;

    #[test]
    fn mobile_landing_is_what_the_sources_say() {
        let from_sources = mobile_page::assemble(&mobile_page::client_dir())
            .expect("mobile-client/ does not assemble");
        let served = {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async { super::mobile_landing().await.0 })
        };
        assert_eq!(
            served.len(),
            from_sources.len(),
            "the embedded page is {} bytes, mobile-client/ assembles to {} — the build \
             embedded a different page than the one in the working tree",
            served.len(),
            from_sources.len()
        );
        if served != from_sources {
            let at = served
                .char_indices()
                .zip(from_sources.char_indices())
                .find(|((_, a), (_, b))| a != b)
                .map(|((i, _), _)| i)
                .unwrap_or(0);
            let from = at.saturating_sub(60);
            panic!(
                "the embedded page and mobile-client/ differ at byte {at}:\n\
                 embedded: {:?}\n  source: {:?}",
                &served[from..(at + 60).min(served.len())],
                &from_sources[from..(at + 60).min(from_sources.len())],
            );
        }
    }

    /// The file name appears twice — once in `build.rs`'s output path and
    /// once in the `include_str!` above, which needs a literal and cannot
    /// read the constant. This is the seam that holds the two together: rename
    /// one and this goes red instead of the build quietly embedding nothing.
    #[test]
    fn the_embedded_file_is_the_one_the_build_script_writes() {
        let embedded = concat!(env!("OUT_DIR"), "/mobile-client.html");
        assert!(
            embedded.ends_with(mobile_page::EMBED_NAME),
            "remote.rs embeds {embedded}, build.rs writes {}",
            mobile_page::EMBED_NAME
        );
        assert!(
            std::path::Path::new(embedded).is_file(),
            "{embedded} is not on disk — the build script did not run"
        );
    }

    /// A guard on the guard. If `mobile_landing` ever returned an empty
    /// string, or the assembler did, the comparison above would pass on two
    /// pieces of nothing.
    #[test]
    fn the_comparison_is_made_on_a_real_page() {
        let served = {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async { super::mobile_landing().await.0 })
        };
        assert!(
            served.len() > 100_000,
            "the served mobile page is only {} bytes",
            served.len()
        );
        assert!(served.starts_with("<!DOCTYPE html>"));
        assert!(served.ends_with("</html>"));
        // The three spliced modules each left a landmark; a splice that
        // produced an empty body would still start and end correctly.
        for needle in ["var CAVEMAN_PROMPTS = {", "var PERSONAS = [", "var AGENT_TOOLS = ["] {
            assert!(served.contains(needle), "the served page is missing {needle}");
        }
    }
}

/// A1 MOBILE (plan 2.6.6): the served page has to carry the decay, and it has
/// to carry the DESKTOP's numbers.
///
/// The behaviour of those helpers is proven in
/// src/api/__tests__/mobile-context-decay.test.ts, which cuts them out of this
/// file and runs them. What Rust owns is the other half: that the block is in
/// what ships, that the loop calls it, and that the two platforms did not
/// quietly grow two different caps. A relay that decays at 8k while the
/// desktop decays at 4k is a support case nobody can reproduce.
#[cfg(test)]
mod mobile_decay_tests {
    /// The page exactly as a phone receives it.
    fn page() -> String {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async { super::mobile_landing().await.0 })
    }

    /// A `const NAME = 123` or `var NAME = 123;` out of either language.
    fn number_after(source: &str, name: &str) -> Option<i64> {
        let at = source.find(name)?;
        let rest = &source[at + name.len()..];
        let eq = rest.find('=')?;
        rest[eq + 1..]
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse()
            .ok()
    }

    #[test]
    fn the_served_page_carries_the_decay_helpers() {
        let html = page();
        for needle in [
            "function capToolResult(",
            "function isDecayedAt(",
            "function decayToolResults(",
            "function msgChars(",
            "function dropOldImages(",
        ] {
            assert!(html.contains(needle), "mobile page is missing {}", needle);
        }
    }

    #[test]
    fn the_loop_pushes_the_iteration_with_every_observation() {
        // Without the iteration the decay cannot tell the newest result from
        // the ones that have done their job, and capping the newest is the one
        // thing it must never do.
        let html = page();
        assert!(html.contains("apiMessages.push({role:'tool', content:obs, iter:iter})"));
        assert!(html.contains("apiMessages.push({role:'tool', content:'Error: '+errMsg, iter:iter})"));
    }

    /// Offset of a statement that really RUNS: the line it sits on may hold
    /// nothing but whitespace before it. A plain `find` also matches the same
    /// text inside a `//` comment, which is exactly how a disabled call slips
    /// past a guard.
    fn live_statement(source: &str, statement: &str) -> Option<usize> {
        let mut from = 0;
        while let Some(rel) = source[from..].find(statement) {
            let at = from + rel;
            let line_start = source[..at].rfind('\n').map(|i| i + 1).unwrap_or(0);
            if source[line_start..at].trim().is_empty() {
                return Some(at);
            }
            from = at + statement.len();
        }
        None
    }

    #[test]
    fn decay_runs_before_compaction() {
        // Order matters: measuring full results and then dropping whole
        // messages throws away old context that would have fitted at 4k.
        let html = page();
        let decay = live_statement(&html, "decayToolResults(apiMessages, iter);")
            .expect("the decay call is missing or commented out");
        let compact = live_statement(&html, "apiMessages = compactApiMessages(apiMessages, 24000);")
            .expect("the compaction call is missing or commented out");
        assert!(decay < compact, "compaction runs before the decay");
    }

    #[test]
    fn the_comment_blind_spot_is_really_closed() {
        // A guard on the guard: the first version of decay_runs_before_compaction
        // used a plain find and stayed green with the call commented out.
        assert_eq!(live_statement("  doThing();", "doThing();"), Some(2));
        assert_eq!(live_statement("  // doThing();", "doThing();"), None);
        assert_eq!(live_statement("  // doThing();\n  doThing();", "doThing();"), Some(18));
    }

    #[test]
    fn the_budget_counts_image_bytes() {
        let html = page();
        assert!(html.contains("if(Array.isArray(m.images)){"), "msgChars ignores images");
        assert!(
            live_statement(&html, "dropOldImages(messages, IMAGE_KEEP_RECENT);").is_some(),
            "old images are never dropped"
        );
        assert!(
            live_statement(&html, "if(totalChars(messages) <= budget) return messages;").is_some(),
            "the budget check does not run over the image-aware count"
        );
        // The old accumulator counted content only. It must not come back.
        assert!(
            !html.contains("total += String(messages[i].content || '').length"),
            "the content-only budget is back"
        );
    }

    #[test]
    fn the_relay_caps_at_the_same_numbers_as_the_desktop() {
        let html = page();
        let desktop = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("src")
                .join("lib")
                .join("context-decay.ts"),
        )
        .expect("desktop decay module not found");

        for name in ["DECAY_RESULT_CHARS", "RESTORE_RESULT_CHARS", "DECAY_AFTER_ITERATIONS"] {
            let mine = number_after(&html, name)
                .unwrap_or_else(|| panic!("{} missing from the mobile page", name));
            let theirs = number_after(&desktop, name)
                .unwrap_or_else(|| panic!("{} missing from context-decay.ts", name));
            assert_eq!(mine, theirs, "{} drifted between relay and desktop", name);
        }
    }

    #[test]
    fn the_number_reader_really_reads_numbers() {
        // A guard on the guard: if number_after returned None for everything
        // the drift test above would only ever panic on the message, and if it
        // returned the same wrong value twice it would pass for free.
        assert_eq!(number_after("var DECAY_RESULT_CHARS = 4000;", "DECAY_RESULT_CHARS"), Some(4000));
        assert_eq!(number_after("export const X = 12 ", "X"), Some(12));
        assert_eq!(number_after("nothing here", "X"), None);
    }
}
/// Task 215: the relay says which machine it stands on, and what time it is.
///
/// The desktop coding and agent loops got that environment block in 2.6.6; the
/// phone relay runs the same tools on the same machine and never had it, so a
/// run started from the sofa guessed at `explorer` on a Mac and spent a step of
/// its budget on `uname`.
///
/// Two halves, two owners. The platform sentence is Rust's, because the page
/// executes on the phone and only this side knows the machine the tools land
/// on. The clock is the page's, because a session runs for hours and a
/// timestamp frozen into the one config fetch would age into a lie.
#[cfg(test)]
mod mobile_environment_tests {
    /// The page exactly as a phone receives it.
    fn page() -> String {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async { super::mobile_landing().await.0 })
    }

    /// The desktop module both sides have to agree with.
    fn desktop_host_platform() -> String {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("src")
                .join("lib")
                .join("host-platform.ts"),
        )
        .expect("src/lib/host-platform.ts not found")
    }

    #[test]
    fn the_relay_platform_sentence_is_the_desktop_one_word_for_word() {
        let ts = desktop_host_platform();
        let mine = super::host_platform_prompt_line();
        assert!(
            ts.contains(mine),
            "the relay platform sentence drifted from platformPromptLine():\n{}",
            mine
        );
    }

    #[test]
    fn the_reader_would_notice_a_drift() {
        // A guard on the guard. If host-platform.ts were ever read as an empty
        // string, or the sentence lost its landmarks, the test above would pass
        // for free on a `contains` that means nothing.
        let ts = desktop_host_platform();
        assert!(ts.contains("export function platformPromptLine"));
        for needle in ["This machine runs macOS", "This machine runs Windows", "This machine runs Linux"] {
            assert!(ts.contains(needle), "{} missing from host-platform.ts", needle);
        }
        assert!(!super::host_platform_prompt_line().is_empty());
        assert!(!ts.contains("This machine runs Plan 9"), "contains() is not matching everything");
    }

    #[test]
    fn the_config_endpoint_hands_the_platform_line_over() {
        let body = super::config_payload("qwen3:8b".into(), String::new());
        assert_eq!(
            body["platformLine"].as_str().unwrap(),
            super::host_platform_prompt_line()
        );
        // The fields the page already read must survive the split.
        assert_eq!(body["model"].as_str().unwrap(), "qwen3:8b");
        assert!(body.get("systemPrompt").is_some());
        // The clock is deliberately NOT in here: it is fetched once per
        // session and would be stale within the minute.
        assert!(body.get("clockLine").is_none(), "the clock must not be frozen into config");
    }

    #[test]
    fn the_served_page_builds_both_halves() {
        let html = page();
        for needle in [
            "var hostPlatformLine = '';",
            "hostPlatformLine = cfg.platformLine || '';",
            "function hostClockLine(now){",
            "Date and time at the start of this run: ",
            "Trust this line; there is no clock tool.",
        ] {
            assert!(html.contains(needle), "the relay page lost: {}", needle);
        }
    }

    #[test]
    fn the_clock_closes_the_prompt_and_the_platform_line_rides_in_front() {
        // Plan A5: an upstream prefix cache matches from byte 0 and stops at
        // the first difference. The platform sentence reads the same every
        // turn and may sit anywhere; the clock changes every minute and has to
        // be last, or every turn re-prices the whole prompt.
        let html = page();
        let platform_at = html.find("if(hostPlatformLine) parts.push(hostPlatformLine);").expect("platform push missing");
        let clock_at = html.find("parts.push(hostClockLine());").expect("clock push missing");
        let join_at = html[platform_at..].find("return parts.join(").expect("prompt builder lost its return") + platform_at;
        assert!(clock_at > platform_at, "the clock must come after the platform sentence");
        assert!(clock_at < join_at, "the clock has to be pushed before the prompt is joined");
    }

    #[test]
    fn plain_chat_gets_neither_line() {
        // Only the two surfaces that own tools pay for the block. A plain chat
        // has nothing to run, so the sentence would be tokens for nothing.
        let html = page();
        let gate = html.find("if(isCodex || agentOn){").expect("the environment block lost its gate");
        let clock_at = html.find("parts.push(hostClockLine());").expect("clock push missing");
        assert!(clock_at > gate, "the clock is pushed outside the tool-surface gate");
    }
}
