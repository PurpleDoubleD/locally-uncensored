//! Desktop end of the sealed remote channel (REMOTE-PROTOKOLL v2,
//! `mobile-docs/remote/PROTOKOLL.md`).
//!
//! Every call into `crate::remote_seal` sits in this file. remote.rs hands
//! over a sealed HTTP body and gets an HTTP answer back; for the inner request
//! it is called with plain values (method, path, headers, body and the paired
//! device) and runs them through its own router. When the channel module
//! changes, only this file follows.
//!
//! What lives here:
//! - the desktop key (one secret in the system keychain, on Linux a private
//!   file in the app data folder),
//! - the list of paired devices (a file, public keys only, rights per device,
//!   "reach this computer from anywhere"),
//! - the sessions in memory, pairing tickets, pairing requests waiting for
//!   the human at the desktop, deferred answers (`x-lu-pending`),
//! - the handshake limits of the tunnel listener.
//!
//! Nothing here logs a key, a ticket, a code or a session secret.

use crate::remote_seal::{
    self as seal, DesktopHandshake, DesktopHello, DeviceSecret, InnerRequest, InnerResponse,
    PairState, PairingLink, PairingRef, PairingSecret, SealError, Session, Ticket,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use zeroize::Zeroizing;

// ─── Constants ───

/// Loopback port of the tunnel listener; cloudflared points here and nowhere
/// else (PROTOKOLL 10).
pub(crate) const TUNNEL_PORT: u16 = 11436;
/// Upper bound of a sealed HTTP body, framing included.
pub(crate) const MAX_SEALED_BODY: usize = seal::MAX_BODY;
/// Largest router answer carried back through the channel. Leaves room for
/// the inner head inside one sealed message.
pub(crate) const MAX_INNER_ANSWER: usize = seal::MAX_MESSAGE - 64 * 1024;
/// Header the channel sets on every inner request (the paired device's id).
pub(crate) const DEVICE_HEADER: &str = seal::DEVICE_HEADER;

const PAIR_STATUS_PATH: &str = "/remote-api/pair/status";
const PAIR_REVEAL_PATH: &str = "/remote-api/pair/reveal";
const FORGET_SELF_PATH: &str = "/remote-api/devices/self/forget";
/// Answer headers the desktop passes back (PROTOKOLL 8). The three `x-lu-`
/// headers of a Create result piece say where the piece sits in the file.
const RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "retry-after",
    "x-lu-pending",
    "x-lu-remote-memory-revoked",
    "x-lu-offset",
    "x-lu-total-bytes",
    "x-lu-sha256",
];
const FEATURE_PENDING: &str = "pending";
/// "Sign in with my computer" (PROTOKOLL 15), named only in the
/// authenticated status inside the channel.
pub(crate) const FEATURE_SIGNIN: &str = "signin";
const SIGNIN_PATH: &str = "/remote-api/signin/request";
/// Sign-in questions per device and for all devices in this window.
const SIGNIN_WINDOW_SECS: u64 = 10 * 60;
const SIGNIN_ASKS_PER_DEVICE: usize = 3;
const SIGNIN_ASKS_TOTAL: usize = 10;
/// Flag byte of a code pairing in HS_INIT (PROTOKOLL 6.1).
const HS_FLAG_CODE: u8 = 0x02;

/// An inner request is held this long before the answer is deferred.
const HOLD: Duration = Duration::from_secs(30);
/// A poll of a deferred answer is held this long.
const POLL_HOLD: Duration = Duration::from_secs(25);
/// A finished deferred answer can be fetched this long.
const PENDING_KEEP_SECS: u64 = 10 * 60;
/// Unfinished deferred work is stopped after this long.
const PENDING_MAX_AGE_SECS: u64 = 60 * 60;
const MAX_PENDING_PER_DEVICE: usize = 64;

/// A session without a frame for this long is dropped.
const IDLE_SECS: u64 = 2 * 60 * 60;
/// Confirmed sessions (first data frame opened) per device and in total.
const MAX_SESSIONS_PER_DEVICE: usize = 4;
const MAX_SESSIONS: usize = 32;
/// Sessions whose first data frame has not arrived yet: they only displace
/// each other and fall after this long (PROTOKOLL 6.3, finding M3).
const UNCONFIRMED_SECS: u64 = 60;
const MAX_UNCONFIRMED_PER_DEVICE: usize = 4;
const MAX_UNCONFIRMED: usize = 16;

/// Time the human at the desktop has to answer a pairing request.
const PAIR_DECISION_SECS: u64 = 2 * 60;
/// A denied pairing still answers `pair/status` this long.
const DENIED_KEEP_SECS: u64 = 2 * 60;
/// How long the QR or Dispatch panel at the desktop counts as open without
/// being opened again. Only then does the LAN status name this desktop.
pub(crate) const PAIRING_WINDOW_SECS: u64 = 30 * 60;
/// The browser page and the plain code login, once allowed at the desktop
/// while phones are paired or "anywhere" is on.
pub(crate) const LEGACY_ACCESS_SECS: u64 = 30 * 60;

/// Handshake limits, per sender (`CF-Connecting-IP` on the tunnel, an IPv6
/// sender as its /64) and for all together. Pairings and known devices count
/// apart: failed pairings never lock out a known device's handshake.
const WINDOW_SECS: u64 = 60;
const HANDSHAKES_PER_SOURCE: u32 = 10;
const IK_HANDSHAKES_PER_SOURCE: u32 = 30;
const PAIR_FAILS_PER_SOURCE: u32 = 3;
const LOCK_SECS: u64 = 60;
const GLOBAL_FAILS_PER_WINDOW: u32 = 60;
const GLOBAL_HANDSHAKES_PER_WINDOW: u32 = 600;
const MAX_SOURCES: usize = 4096;
/// First messages are remembered by their ephemeral key for as long as a
/// session can live, so a recorded one cannot be played again.
const EPHEMERAL_KEEP_SECS: u64 = seal::SESSION_MAX_AGE_SECS;
const MAX_SEEN_EPHEMERALS: usize = 8192;
const HS_FLAG_TICKET: u8 = 0x01;

/// A first message is small: a hello and a few keys.
pub(crate) const MAX_HS_INIT_BODY: usize = 8 * 1024;
/// Sealed requests read at the same time, per listener. More wait.
const SEALED_SLOTS: usize = 32;

const DEVICES_FILE: &str = "remote-devices.json";
#[cfg(any(not(any(target_os = "windows", target_os = "macos")), feature = "e2e-remote"))]
const KEY_FILE: &str = "remote-channel.key";
const FALLBACK_NAME: &str = "LU desktop";

// ─── Rights ───

/// Rights of one paired device (PROTOKOLL 12). The global switches of the
/// Remote permission panel stay the upper bound: what reaches a handler is
/// the device's right AND the global switch.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DeviceRights {
    pub chat: bool,
    pub agent: bool,
    /// `filesystem` and `downloads`.
    pub files: bool,
    /// `shell` and `process_control`.
    pub terminal: bool,
    /// The Create routes `/remote-api/create/*` and the agent's
    /// `image_generate` / `video_generate` (commands/remote_create.rs).
    pub create: bool,
}

impl DeviceRights {
    /// What a newly paired device may do (PROTOKOLL 5.3).
    pub(crate) fn first_pairing() -> Self {
        Self { chat: true, agent: true, ..Self::default() }
    }

    pub(crate) fn allows(&self, right: &str) -> bool {
        match right {
            "chat" => self.chat,
            "agent" => self.agent,
            "files" => self.files,
            "terminal" => self.terminal,
            "create" => self.create,
            _ => false,
        }
    }
}

/// The device right a global permission belongs to. Anything not named falls
/// to `terminal`, the strictest one.
pub(crate) fn right_of_permission(permission: &str) -> &'static str {
    match permission {
        "filesystem" | "downloads" => "files",
        "create" => "create",
        _ => "terminal",
    }
}

/// The device right a route needs before any handler runs. `None` means the
/// route itself decides (tool and proxy gates use [`SealedCaller::lacks`]).
pub(crate) fn right_for_path(path: &str) -> Option<&'static str> {
    if path.starts_with("/api/")
        || path == "/remote-api/chat-event"
        || path == "/remote-api/config"
        || path == "/remote-api/chats"
        || path == "/remote-api/chat-models"
        || path.starts_with("/remote-api/chats/")
        || path.starts_with("/remote-api/approvals/")
        || path == "/remote-api/tasks"
        || path == crate::commands::remote_voice::STATUS_PATH
        || path.starts_with("/remote-api/voice/")
    {
        Some("chat")
    } else if path == "/remote-api/agent-tool" {
        Some("agent")
    } else if path.starts_with("/comfyui/") || path == "/ws" {
        Some("terminal")
    } else if path == "/remote-api/create" || path.starts_with("/remote-api/create/") {
        Some("create")
    } else {
        None
    }
}

/// The uploads route serves Create and the chat's attachments: either right
/// opens it (CHATS-V1.md). Only pictures, PDF and text go in there at all.
pub(crate) const UPLOADS_PATH: &str = "/remote-api/create/uploads";

/// `Err(right)` when a device with these rights may not use this path.
pub(crate) fn path_allowed(rights: &DeviceRights, path: &str) -> Result<(), &'static str> {
    if path == UPLOADS_PATH {
        return if rights.chat || rights.create { Ok(()) } else { Err("create") };
    }
    match right_for_path(path) {
        Some(right) if !rights.allows(right) => Err(right),
        _ => Ok(()),
    }
}

/// The paired device behind an inner request. Set by the channel as a request
/// extension, never from anything the network sends.
#[derive(Clone, Debug)]
pub(crate) struct SealedCaller {
    pub device_id: String,
    pub rights: DeviceRights,
    /// The device's generation when this request was let in. Unpairing and
    /// every taken right raise it: work started under an older one is not
    /// entered anywhere any more ([`SealedHub::caller_current`]).
    pub generation: u64,
}

impl SealedCaller {
    /// `Some(right)` when the device lacks the right a global permission
    /// belongs to.
    pub(crate) fn lacks(&self, permission: &str) -> Option<&'static str> {
        let right = right_of_permission(permission);
        (!self.rights.allows(right)).then_some(right)
    }
}

// ─── Paired devices ───

/// One paired device as stored: public parts only.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PairedDevice {
    pub device_id: String,
    pub x25519: String,
    pub ed25519: String,
    pub name: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub app_version: String,
    #[serde(default)]
    pub rights: DeviceRights,
    #[serde(default)]
    pub paired_at: u64,
    #[serde(default)]
    pub last_seen: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct DeviceBook {
    #[serde(default)]
    v: u32,
    /// "Reach this computer from anywhere": rebuild the tunnel when LU starts.
    #[serde(default)]
    anywhere: bool,
    /// The rights a newly paired device starts with, set in the Remote
    /// settings. Not set: [`DeviceRights::first_pairing`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    new_device_rights: Option<DeviceRights>,
    #[serde(default)]
    devices: Vec<PairedDevice>,
}

/// Write a file that only this user may read, without a half written state:
/// a temporary file next to it (tempfile creates it with 0600 on Unix), then
/// one rename.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let dir = path.parent().ok_or_else(|| "No folder for the remote files.".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| crate::os_error::english(&e))?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| crate::os_error::english(&e))?;
    tmp.write_all(bytes).map_err(|e| crate::os_error::english(&e))?;
    tmp.as_file().sync_all().map_err(|e| crate::os_error::english(&e))?;
    tmp.persist(path).map_err(|e| crate::os_error::english(&e.error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| crate::os_error::english(&e))?;
    }
    Ok(())
}

fn load_book(path: &Path) -> DeviceBook {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<DeviceBook>(&bytes) {
            Ok(book) => book,
            Err(_) => {
                // Unreadable: keep it aside instead of overwriting it, start
                // with an empty list (phones pair again).
                let aside = path.with_extension(format!("broken-{}", now_secs()));
                let _ = std::fs::rename(path, &aside);
                tracing::warn!("remote device list unreadable, kept aside, starting empty");
                DeviceBook::default()
            }
        },
        Err(_) => DeviceBook::default(),
    }
}

// ─── Desktop key ───

enum KeyStore {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    Keychain,
    #[cfg_attr(any(target_os = "windows", target_os = "macos"), allow(dead_code))]
    File(PathBuf),
}

impl KeyStore {
    fn for_platform(_dir: &Path) -> Self {
        // Device tests (feature e2e-remote): a rebuilt, unsigned test app would
        // wait on a keychain prompt nobody answers. The key lives in the test
        // identity's own folder instead.
        #[cfg(feature = "e2e-remote")]
        if crate::e2e_remote::active() {
            return KeyStore::File(_dir.join(KEY_FILE));
        }
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            KeyStore::Keychain
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            KeyStore::File(_dir.join(KEY_FILE))
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            KeyStore::Keychain => "keychain",
            KeyStore::File(_) => "file",
        }
    }

    /// The stored secret, made once. A stored value that does not read back
    /// is an error, never silently replaced (that would unpair every phone).
    fn load_or_create(&self) -> Result<DeviceSecret, String> {
        match self {
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            KeyStore::Keychain => {
                if let Some(text) = crate::commands::secret::remote_channel_key_get()? {
                    let text = Zeroizing::new(text);
                    return DeviceSecret::from_b64(text.trim())
                        .map_err(|_| "The stored remote key is unreadable.".to_string());
                }
                let secret = DeviceSecret::generate().map_err(|e| e.to_string())?;
                crate::commands::secret::remote_channel_key_set(&secret.to_b64())?;
                Ok(secret)
            }
            KeyStore::File(path) => match std::fs::read_to_string(path) {
                Ok(text) => {
                    let text = Zeroizing::new(text);
                    DeviceSecret::from_b64(text.trim())
                        .map_err(|_| "The stored remote key is unreadable.".to_string())
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    let secret = DeviceSecret::generate().map_err(|e| crate::os_error::english(&e))?;
                    write_private(path, secret.to_b64().as_bytes())?;
                    Ok(secret)
                }
                Err(e) => Err(crate::os_error::english(&e)),
            },
        }
    }
}

// ─── Values crossing to remote.rs ───

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Listener {
    /// 0.0.0.0:11435, the network at home.
    Lan,
    /// 127.0.0.1:11436, only cloudflared reaches it.
    Tunnel,
}

/// The six digit code as the desktop currently shows it (LAN only).
pub(crate) enum CodeOffer {
    Absent,
    /// The source is locked out for this many seconds.
    Locked(u64),
    Shown(Zeroizing<String>),
}

pub(crate) struct SealedInput<'a> {
    pub listener: Listener,
    /// `CF-Connecting-IP` on the tunnel listener, the TCP peer on the LAN.
    pub source: &'a str,
    pub body: &'a [u8],
    pub code: CodeOffer,
}

/// What the code path did, so remote.rs can keep its code counters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodeUse {
    /// A code handshake decrypted: the code is used up.
    Consumed,
    /// A code handshake with the shown code failed.
    Failed,
}

pub(crate) struct SealedOutcome {
    pub status: u16,
    pub body: Vec<u8>,
    /// true: `body` is a frame (`application/octet-stream`), else JSON.
    pub sealed: bool,
    pub retry_after: Option<u64>,
    pub code_use: Option<CodeUse>,
}

/// An inner request ready for the router.
pub(crate) struct InnerCall {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub caller: SealedCaller,
}

/// The router's answer to an inner request.
#[derive(Clone, Debug)]
pub(crate) struct InnerAnswer {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl InnerAnswer {
    pub(crate) fn json(status: u16, value: serde_json::Value) -> Self {
        Self {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            body: serde_json::to_vec(&value).unwrap_or_default(),
        }
    }

    fn empty(status: u16) -> Self {
        Self { status, headers: Vec::new(), body: Vec::new() }
    }
}

fn outer(code: &str) -> SealedOutcome {
    SealedOutcome {
        status: outer_status(code),
        body: serde_json::to_vec(&serde_json::json!({ "error": code })).unwrap_or_default(),
        sealed: false,
        retry_after: None,
        code_use: None,
    }
}

fn rate_limited(wait: u64) -> SealedOutcome {
    SealedOutcome { retry_after: Some(wait.max(1)), ..outer("rate_limited") }
}

/// How much of a sealed body to read, decided from its first bytes.
pub(crate) enum BodyPlan {
    /// Read on, up to this many bytes in all.
    Limit(usize),
    /// Answer without reading further.
    Refuse(SealedOutcome),
}

/// HTTP status of an outer error (PROTOKOLL 16).
fn outer_status(code: &str) -> u16 {
    match code {
        "version_unsupported" => 426,
        "too_large" => 413,
        "unknown_ticket" | "handshake_failed" | "bad_binding" | "unknown_device" => 401,
        "pairing_denied" => 403,
        "session_unknown" => 404,
        "session_expired" => 410,
        "replay" => 409,
        "rate_limited" => 429,
        "internal" => 500,
        _ => 400,
    }
}

/// Outer code for a frame or session error.
fn frame_error(e: &SealError) -> &'static str {
    match e {
        SealError::Rng => "internal",
        SealError::BadEncoding | SealError::BadInner | SealError::BadSignature | SealError::BadAddress
        | SealError::ForbiddenPath | SealError::ResponseMismatch | SealError::BadLink
        | SealError::ClockSkew | SealError::WrongDesktop | SealError::BadReveal => "bad_frame",
        other => other.code(),
    }
}

/// Outer code for a failed first message: everything that is not about the
/// frame layout or the ticket says "the handshake did not complete".
fn handshake_error(e: &SealError) -> &'static str {
    match e {
        SealError::BadFrame => "bad_frame",
        SealError::VersionUnsupported => "version_unsupported",
        SealError::WrongKind => "wrong_kind",
        SealError::UnknownTicket => "unknown_ticket",
        SealError::BadBinding => "bad_binding",
        SealError::TooLarge => "too_large",
        SealError::Rng => "internal",
        _ => "handshake_failed",
    }
}

// ─── Sessions, tickets, deferred answers, limits ───

#[derive(Clone, Debug)]
struct PeerInfo {
    name: String,
    platform: String,
    app_version: String,
    x25519: String,
    ed25519: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Link {
    Paired,
    /// Waiting for the human. `asked` is false on the code path until the
    /// phone's reveal arrived: only then is there a comparison code to show.
    Pending { request_id: String, since: u64, asked: bool, by_code: bool },
    Denied { since: u64 },
}

struct Channel {
    session: Session,
    device_id: String,
    peer: PeerInfo,
    link: Mutex<Link>,
    created: u64,
    last_used: AtomicU64,
    /// Set by the first data frame that opened. Before that the session does
    /// not count against the per device limit (a replayed IK init must not
    /// push real sessions out).
    confirmed: AtomicBool,
    comparison: Mutex<Option<String>>,
}

struct OpenTicket {
    ticket: Ticket,
    expires: u64,
}

struct Deferred {
    device_id: String,
    created: u64,
    done: Mutex<Option<(InnerAnswer, u64)>>,
    notify: tokio::sync::Notify,
    abort: Mutex<Option<tokio::task::AbortHandle>>,
}

impl Deferred {
    fn result(&self) -> Option<InnerAnswer> {
        lock(&self.done).as_ref().map(|(a, _)| a.clone())
    }

    fn finished_at(&self) -> Option<u64> {
        lock(&self.done).as_ref().map(|(_, t)| *t)
    }

    fn stop(&self) {
        if let Some(h) = lock(&self.abort).take() {
            h.abort();
        }
    }

    async fn wait(&self, limit: Duration) -> Option<InnerAnswer> {
        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if let Some(a) = self.result() {
            return Some(a);
        }
        let _ = tokio::time::timeout(limit, notified).await;
        self.result()
    }
}

/// Attempts in the current window of one kind.
#[derive(Default, Clone, Copy)]
struct Bucket {
    start: u64,
    attempts: u32,
}

impl Bucket {
    /// One more attempt, unless `max` are used up in this window.
    fn take(&mut self, now: u64, max: u32) -> Result<(), u64> {
        if now.saturating_sub(self.start) >= WINDOW_SECS {
            self.start = now;
            self.attempts = 0;
        }
        if self.attempts >= max {
            return Err((self.start + WINDOW_SECS).saturating_sub(now).max(1));
        }
        self.attempts += 1;
        Ok(())
    }

    fn active(&self, now: u64) -> bool {
        now.saturating_sub(self.start) < WINDOW_SECS
    }
}

#[derive(Default, Clone, Copy)]
struct SourceCount {
    pair: Bucket,
    pair_fails: u32,
    pair_locked_until: u64,
    known: Bucket,
}

#[derive(Default)]
struct Limiter {
    sources: HashMap<String, SourceCount>,
    global_start: u64,
    global_fails: u32,
    global_handshakes: u32,
}

/// The sender as the limits count it: an IPv6 address stands for its /64
/// (one household or one phone gets a whole /64), anything else as is.
pub(crate) fn source_key(raw: &str) -> String {
    match raw.trim().parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V6(v6)) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => {
                let s = v6.segments();
                format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
            }
        },
        Ok(ip) => ip.to_string(),
        Err(_) => raw.trim().chars().take(64).collect(),
    }
}

impl Limiter {
    fn roll_global(&mut self, now: u64) {
        if now.saturating_sub(self.global_start) >= WINDOW_SECS {
            self.global_start = now;
            self.global_fails = 0;
            self.global_handshakes = 0;
        }
    }

    /// May this source try a handshake now? `Err(seconds)` when not.
    fn admit(&mut self, source: &str, now: u64, pairing: bool) -> Result<(), u64> {
        if self.sources.len() >= MAX_SOURCES {
            self.sources
                .retain(|_, c| c.pair_locked_until > now || c.pair.active(now) || c.known.active(now));
        }
        self.roll_global(now);
        let global_wait = (self.global_start + WINDOW_SECS).saturating_sub(now).max(1);
        // A ceiling for all handshakes together: each costs key agreement.
        if self.global_handshakes >= GLOBAL_HANDSHAKES_PER_WINDOW {
            return Err(global_wait);
        }
        let global_full = self.global_fails >= GLOBAL_FAILS_PER_WINDOW;
        let c = self.sources.entry(source_key(source)).or_default();
        if pairing {
            if c.pair_locked_until > now {
                return Err(c.pair_locked_until - now);
            }
            // Many failures from everywhere: no new pairings for a moment.
            if global_full {
                return Err(global_wait);
            }
            c.pair.take(now, HANDSHAKES_PER_SOURCE)?;
        } else {
            // A known device counts on its own: what strangers at the same
            // address did with pairings does not touch it.
            c.known.take(now, IK_HANDSHAKES_PER_SOURCE)?;
        }
        self.global_handshakes += 1;
        Ok(())
    }

    fn failed(&mut self, source: &str, now: u64, pairing: bool) {
        self.roll_global(now);
        self.global_fails = self.global_fails.saturating_add(1);
        if pairing {
            let c = self.sources.entry(source_key(source)).or_default();
            c.pair_fails += 1;
            if c.pair_fails >= PAIR_FAILS_PER_SOURCE {
                c.pair_locked_until = now + LOCK_SECS;
                c.pair_fails = 0;
            }
        }
    }
}

/// Ephemeral keys of first messages already read, oldest first.
#[derive(Default)]
struct SeenEphemerals {
    when: HashMap<[u8; 32], u64>,
    order: std::collections::VecDeque<[u8; 32]>,
}

impl SeenEphemerals {
    /// Takes the key as seen. False when it was seen already.
    fn claim(&mut self, key: [u8; 32], now: u64) -> bool {
        while let Some(old) = self.order.front().copied() {
            let expired = self.when.get(&old).is_none_or(|t| now.saturating_sub(*t) >= EPHEMERAL_KEEP_SECS);
            if expired || self.order.len() >= MAX_SEEN_EPHEMERALS {
                self.order.pop_front();
                self.when.remove(&old);
            } else {
                break;
            }
        }
        if self.when.contains_key(&key) {
            return false;
        }
        self.when.insert(key, now);
        self.order.push_back(key);
        true
    }

    /// A first message that did not read gives its key back.
    fn release(&mut self, key: &[u8; 32]) {
        if self.when.remove(key).is_some() {
            self.order.retain(|k| k != key);
        }
    }
}

/// The phone's ephemeral key: the first 32 bytes of the Noise message,
/// after version, kind, flags and, with a ticket, its id.
fn init_ephemeral(body: &[u8]) -> Option<[u8; 32]> {
    let flags = *body.get(2)?;
    let start = if flags == HS_FLAG_TICKET { 3 + 8 } else { 3 };
    body.get(start..start + 32)?.try_into().ok()
}

/// Aborts a task when dropped while it still holds one.
struct AbortOnDrop(Option<tokio::task::AbortHandle>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        if let Some(h) = self.0.take() {
            h.abort();
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(crate) type Notifier = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;
/// Called with a device id when that device is unpaired or loses its right
/// `create`: whatever it started elsewhere (Create jobs) ends with it.
pub(crate) type DeviceCut = Arc<dyn Fn(&str) + Send + Sync>;
/// Told when a device loses rights (`Some`, the rights it keeps) or is
/// unpaired (`None`): work it started under the old rights is narrowed or
/// stopped (shared chats).
pub(crate) type RightsTaken = Arc<dyn Fn(&str, Option<DeviceRights>) + Send + Sync>;
pub(crate) type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// The desktop side of the channel: one per app.
pub(crate) struct SealedHub {
    secret: DeviceSecret,
    name: String,
    storage: &'static str,
    devices_path: Option<PathBuf>,
    book: Mutex<DeviceBook>,
    sessions: Mutex<HashMap<[u8; 16], Arc<Channel>>>,
    tickets: Mutex<Vec<OpenTicket>>,
    /// Device tests (src/e2e_remote.rs): tickets of the link in the test's
    /// file, kept apart so the QR panel of the desktop does not end them.
    #[cfg(feature = "e2e-remote")]
    e2e_tickets: Mutex<Vec<OpenTicket>>,
    pending: Mutex<HashMap<String, Arc<Deferred>>>,
    limiter: Mutex<Limiter>,
    seen_ephemerals: Mutex<SeenEphemerals>,
    notifier: Mutex<Option<Notifier>>,
    on_device_cut: Mutex<Option<DeviceCut>>,
    on_rights_taken: Mutex<Option<RightsTaken>>,
    /// Per device, raised by unpairing and by a taken right.
    generations: Mutex<HashMap<String, u64>>,
    clock: Clock,
    hold: Duration,
    poll_hold: Duration,
    /// The tunnel address as cloudflared printed it, while the tunnel runs.
    tunnel_address: Mutex<Option<String>>,
    /// Host name the tunnel listener answers under (`*.trycloudflare.com`).
    tunnel_host: Mutex<Option<String>>,
    announce: Mutex<AnnounceStatus>,
    announce_task: Mutex<Option<tokio::task::AbortHandle>>,
    /// Bumped by every start and stop of the announce loop; a loop whose
    /// number is old writes nothing any more.
    announce_gen: AtomicU64,
    announce_net: Mutex<AnnounceNet>,
    signins: Mutex<HashMap<String, SigninAsk>>,
    signin_wait: Mutex<Duration>,
    /// When which device asked to be signed in, for the limits.
    signin_asked: Mutex<std::collections::VecDeque<(String, u64)>>,
    /// Sealed requests in reading, per listener.
    slots_lan: Arc<tokio::sync::Semaphore>,
    slots_tunnel: Arc<tokio::sync::Semaphore>,
    /// Hub clock second until which the QR or Dispatch panel is open.
    pairing_until: AtomicU64,
    /// Hub clock second until which the browser page and the plain code
    /// login stay reachable although phones are paired.
    legacy_until: AtomicU64,
}

/// A name as the dialogs and the channel show it: format characters (zero
/// width, bidi controls, the tag characters of flag emoji) dropped, controls
/// and line or paragraph separators made spaces, white space collapsed and
/// trimmed, at most 64 characters and 256 bytes. What comes out always passes
/// the name rule of `remote_seal`. Empty gives `fallback`.
pub(crate) fn clean_label(raw: &str, fallback: &str) -> String {
    let spaced: String = raw
        .chars()
        .filter(|&c| !seal::is_format_char(c))
        .map(|c| if seal::is_forbidden_name_char(c) { ' ' } else { c })
        .collect();
    let mut out = String::new();
    for (i, word) in spaced.split_whitespace().enumerate() {
        let piece = if i == 0 { word.to_string() } else { format!(" {word}") };
        if out.chars().count() + piece.chars().count() > 64 || out.len() + piece.len() > 256 {
            for c in piece.chars() {
                if out.chars().count() >= 64 || out.len() + c.len_utf8() > 256 {
                    break;
                }
                out.push(c);
            }
            break;
        }
        out.push_str(&piece);
    }
    let out = out.trim_end().to_string();
    if out.is_empty() { fallback.to_string() } else { out }
}

fn clean_name(raw: &str) -> String {
    clean_label(raw, FALLBACK_NAME)
}

/// A short, readable part of a device id for the dialogs: the first four
/// bytes in hex, as two groups ("3F2A 9C01"). The phone shows the same.
pub(crate) fn device_fingerprint(device_id: &str) -> String {
    match seal::b64_decode_exact::<16>(device_id) {
        Ok(b) => format!("{:02X}{:02X} {:02X}{:02X}", b[0], b[1], b[2], b[3]),
        Err(_) => String::new(),
    }
}

const FALLBACK_PHONE: &str = "Phone";

impl SealedHub {
    /// Opens the hub for this app: reads or makes the key, reads the device
    /// list. Blocks (keychain), so run it on a blocking thread.
    pub(crate) fn open(app_data: &Path, name: &str) -> Result<Self, String> {
        let store = KeyStore::for_platform(app_data);
        let secret = store.load_or_create()?;
        let path = app_data.join(DEVICES_FILE);
        let book = load_book(&path);
        Ok(Self::assemble(secret, name, store.kind(), Some(path), book, Arc::new(now_secs), HOLD, POLL_HOLD))
    }

    #[allow(clippy::too_many_arguments)]
    fn assemble(
        secret: DeviceSecret,
        name: &str,
        storage: &'static str,
        devices_path: Option<PathBuf>,
        book: DeviceBook,
        clock: Clock,
        hold: Duration,
        poll_hold: Duration,
    ) -> Self {
        Self {
            secret,
            name: clean_name(name),
            storage,
            devices_path,
            book: Mutex::new(book),
            sessions: Mutex::new(HashMap::new()),
            tickets: Mutex::new(Vec::new()),
            #[cfg(feature = "e2e-remote")]
            e2e_tickets: Mutex::new(Vec::new()),
            pending: Mutex::new(HashMap::new()),
            limiter: Mutex::new(Limiter::default()),
            seen_ephemerals: Mutex::new(SeenEphemerals::default()),
            notifier: Mutex::new(None),
            on_device_cut: Mutex::new(None),
            on_rights_taken: Mutex::new(None),
            generations: Mutex::new(HashMap::new()),
            clock,
            hold,
            poll_hold,
            tunnel_address: Mutex::new(None),
            tunnel_host: Mutex::new(None),
            announce: Mutex::new(AnnounceStatus::default()),
            announce_task: Mutex::new(None),
            announce_gen: AtomicU64::new(0),
            announce_net: Mutex::new(AnnounceNet::default()),
            signins: Mutex::new(HashMap::new()),
            signin_wait: Mutex::new(Duration::from_secs(PAIR_DECISION_SECS)),
            signin_asked: Mutex::new(std::collections::VecDeque::new()),
            slots_lan: Arc::new(tokio::sync::Semaphore::new(SEALED_SLOTS)),
            slots_tunnel: Arc::new(tokio::sync::Semaphore::new(SEALED_SLOTS)),
            pairing_until: AtomicU64::new(0),
            legacy_until: AtomicU64::new(0),
        }
    }

    fn now(&self) -> u64 {
        (self.clock)()
    }

    pub(crate) fn set_notifier(&self, notifier: Notifier) {
        *lock(&self.notifier) = Some(notifier);
    }

    pub(crate) fn set_on_device_cut(&self, cut: DeviceCut) {
        *lock(&self.on_device_cut) = Some(cut);
    }

    pub(crate) fn set_on_rights_taken(&self, cb: RightsTaken) {
        *lock(&self.on_rights_taken) = Some(cb);
    }

    fn rights_taken(&self, device_id: &str, kept: Option<DeviceRights>) {
        let cb = lock(&self.on_rights_taken).clone();
        if let Some(cb) = cb {
            cb(device_id, kept);
        }
    }

    pub(crate) fn generation(&self, device_id: &str) -> u64 {
        lock(&self.generations).get(device_id).copied().unwrap_or(0)
    }

    fn bump_generation(&self, device_id: &str) {
        *lock(&self.generations).entry(device_id.to_string()).or_insert(0) += 1;
    }

    /// Is a request let in under `generation` still the device's own: still
    /// paired, nothing taken since?
    pub(crate) fn caller_current(&self, device_id: &str, generation: u64) -> bool {
        self.is_paired(device_id) && self.generation(device_id) == generation
    }

    fn device_cut(&self, device_id: &str) {
        let cut = lock(&self.on_device_cut).clone();
        if let Some(cut) = cut {
            cut(device_id);
        }
    }

    fn notify(&self, event: &str, payload: serde_json::Value) {
        let n = lock(&self.notifier).clone();
        if let Some(n) = n {
            n(event, payload);
        }
    }

    /// "keychain" or "file": where the desktop key lives.
    pub(crate) fn storage_kind(&self) -> &'static str {
        self.storage
    }

    /// What every paired device hears in the handshake and in the status
    /// inside the channel. Create is named per device in the authenticated
    /// status (`status_features` in remote.rs).
    pub(crate) fn features() -> Vec<String> {
        vec![seal::FEATURE_SEALED.to_string(), FEATURE_PENDING.to_string()]
    }

    /// Body of `GET /remote-api/status`. The tunnel listener tells only the
    /// protocol and the features; the LAN listener adds what the code path
    /// needs (PROTOKOLL 11).
    pub(crate) fn status_body(&self, listener: Listener) -> serde_json::Value {
        let mut v = serde_json::json!({
            "status": "ok",
            "protocol": seal::PROTOCOL_VERSION,
            "features": Self::features(),
        });
        // The code path needs these, and only while someone at the desktop
        // shows a code.
        if listener == Listener::Lan && self.pairing_window_open() {
            v["desktop_id"] = self.secret.desktop_id().into();
            v["x25519"] = seal::b64(&self.secret.x25519_public()).into();
            v["name"] = self.name.clone().into();
        }
        v
    }

    // ── Pairing window and the old way in ──

    /// The QR or Dispatch panel opened (or is still open) or closed.
    pub(crate) fn set_pairing_window(&self, open: bool) {
        let until = if open { self.now() + PAIRING_WINDOW_SECS } else { 0 };
        self.pairing_until.store(until, Ordering::SeqCst);
        // The ticket in the QR goes with the panel.
        if !open {
            lock(&self.tickets).clear();
        }
    }

    pub(crate) fn pairing_window_open(&self) -> bool {
        self.pairing_until.load(Ordering::SeqCst) > self.now()
    }

    /// The old way in (browser page, plain code login) needs a yes at the
    /// desktop once a phone is paired or "anywhere" is on.
    pub(crate) fn legacy_needs_consent(&self) -> bool {
        let book = lock(&self.book);
        book.anywhere || !book.devices.is_empty()
    }

    /// Allow the old way in for [`LEGACY_ACCESS_SECS`], or end it now.
    /// Returns the end in unix seconds of the hub clock, 0 when off.
    pub(crate) fn set_legacy_access(&self, on: bool) -> u64 {
        let until = if on { self.now() + LEGACY_ACCESS_SECS } else { 0 };
        self.legacy_until.store(until, Ordering::SeqCst);
        until
    }

    /// End of the allowed old way in, when it is allowed right now.
    pub(crate) fn legacy_access_until(&self) -> Option<u64> {
        let until = self.legacy_until.load(Ordering::SeqCst);
        (until > self.now()).then_some(until)
    }

    /// May the LAN listener serve more than status and the sealed door?
    pub(crate) fn lan_legacy_allowed(&self) -> bool {
        !self.legacy_needs_consent() || self.legacy_access_until().is_some()
    }

    // ── Book keeping ──

    fn save(&self, book: &DeviceBook) -> Result<(), String> {
        let Some(path) = &self.devices_path else { return Ok(()) };
        let mut out = book.clone();
        out.v = 1;
        let bytes = serde_json::to_vec_pretty(&out).map_err(|e| e.to_string())?;
        write_private(path, &bytes)
    }

    /// The paired devices, names cleaned (a list from an older build may
    /// hold names from before the name rule).
    pub(crate) fn devices(&self) -> Vec<PairedDevice> {
        let mut list = lock(&self.book).devices.clone();
        for d in &mut list {
            d.name = clean_label(&d.name, FALLBACK_PHONE);
        }
        list
    }

    fn is_paired(&self, device_id: &str) -> bool {
        lock(&self.book).devices.iter().any(|d| d.device_id == device_id)
    }

    fn rights_of(&self, device_id: &str) -> Option<DeviceRights> {
        lock(&self.book).devices.iter().find(|d| d.device_id == device_id).map(|d| d.rights)
    }

    pub(crate) fn anywhere(&self) -> bool {
        lock(&self.book).anywhere
    }

    pub(crate) fn set_anywhere(self: &Arc<Self>, on: bool) -> Result<(), String> {
        let mut book = lock(&self.book);
        let mut next = book.clone();
        next.anywhere = on;
        self.save(&next)?;
        *book = next;
        drop(book);
        self.announce_follow();
        Ok(())
    }

    /// The rights a newly paired device starts with.
    pub(crate) fn new_device_rights(&self) -> DeviceRights {
        lock(&self.book).new_device_rights.unwrap_or_else(DeviceRights::first_pairing)
    }

    /// Sets them for the next pairings; devices paired before keep theirs.
    pub(crate) fn set_new_device_rights(&self, rights: DeviceRights) -> Result<(), String> {
        let mut book = lock(&self.book);
        let mut next = book.clone();
        next.new_device_rights = Some(rights);
        self.save(&next)?;
        *book = next;
        Ok(())
    }

    pub(crate) fn set_rights(&self, device_id: &str, rights: DeviceRights) -> Result<(), String> {
        let lost_create = {
            let mut book = lock(&self.book);
            let mut next = book.clone();
            let dev = next
                .devices
                .iter_mut()
                .find(|d| d.device_id == device_id)
                .ok_or_else(|| "This device is no longer paired.".to_string())?;
            let lost_create = dev.rights.create && !rights.create;
            let old = dev.rights;
            let taken = (old.chat && !rights.chat)
                || (old.agent && !rights.agent)
                || (old.files && !rights.files)
                || (old.terminal && !rights.terminal)
                || lost_create;
            dev.rights = rights;
            self.save(&next)?;
            *book = next;
            // Before anything is cut: work let in under the old rights can no
            // longer be entered after this point.
            if taken {
                self.bump_generation(device_id);
            }
            (lost_create, taken)
        };
        let (lost_create, taken) = lost_create;
        if lost_create {
            self.device_cut(device_id);
        }
        if taken {
            self.rights_taken(device_id, Some(rights));
        }
        self.notify("remote-devices-changed", serde_json::json!({}));
        Ok(())
    }

    /// Unpair a device: off the list, every session and deferred answer of
    /// it gone at once, its Create jobs ended, its uploads and results out of
    /// reach. The next frame of that phone gets `session_unknown`, its next
    /// handshake `unknown_device`.
    pub(crate) fn forget(&self, device_id: &str) -> Result<bool, String> {
        // First: nothing let in before this point is entered anywhere later.
        self.bump_generation(device_id);
        let removed = {
            let mut book = lock(&self.book);
            let mut next = book.clone();
            let before = next.devices.len();
            next.devices.retain(|d| d.device_id != device_id);
            let removed = next.devices.len() != before;
            if removed {
                self.save(&next)?;
                *book = next;
            }
            removed
        };
        lock(&self.sessions).retain(|_, c| c.device_id != device_id);
        lock(&self.pending).retain(|_, d| {
            if d.device_id == device_id {
                d.stop();
                false
            } else {
                true
            }
        });
        self.device_cut(device_id);
        self.rights_taken(device_id, None);
        self.drop_signins_of(device_id);
        if removed {
            self.notify("remote-devices-changed", serde_json::json!({}));
        }
        Ok(removed)
    }

    fn touch_device(&self, device_id: &str, now: u64) {
        let mut book = lock(&self.book);
        if let Some(d) = book.devices.iter_mut().find(|d| d.device_id == device_id) {
            d.last_seen = now;
        }
    }

    /// Writes "last seen" of a device to the file, at most every five minutes.
    fn persist_last_seen(&self, device_id: &str, now: u64) {
        let snapshot = {
            let mut book = lock(&self.book);
            let Some(d) = book.devices.iter_mut().find(|d| d.device_id == device_id) else { return };
            let stale = now.saturating_sub(d.last_seen) >= 300 || d.last_seen == 0;
            d.last_seen = now;
            if !stale {
                return;
            }
            book.clone()
        };
        if let Err(e) = self.save(&snapshot) {
            tracing::warn!(error = %e, "remote device list not saved");
        }
    }

    /// Drop every session (server stopped). Paired devices stay.
    pub(crate) fn drop_all_sessions(&self) {
        self.set_pairing_window(false);
        self.set_legacy_access(false);
        lock(&self.sessions).clear();
        self.drop_signins_of_all();
        let mut pending = lock(&self.pending);
        for d in pending.values() {
            d.stop();
        }
        pending.clear();
    }

    // ── Pairing ──

    /// A new QR link with a fresh ticket (5 minutes, once). Returns the link
    /// and when its ticket ends. The link holds the ticket: it goes into the
    /// QR picture and nowhere else. Only while the QR panel is open, and
    /// only one ticket at a time: a new QR ends the one shown before.
    pub(crate) fn pairing_link(&self, lan: Option<String>, tunnel: Option<String>) -> Result<(Zeroizing<String>, u64), String> {
        if !self.pairing_window_open() {
            return Err("Open the QR panel to pair a phone.".to_string());
        }
        let (uri, open) = self.new_link(lan, tunnel)?;
        let expires = open.expires;
        let mut tickets = lock(&self.tickets);
        tickets.clear();
        tickets.push(open);
        Ok((uri, expires))
    }

    /// Device tests only: a link whose ticket the QR panel does not end.
    /// At most four such tickets at a time, each still once and five minutes.
    #[cfg(feature = "e2e-remote")]
    pub(crate) fn e2e_pairing_link(&self, lan: Option<String>, tunnel: Option<String>) -> Result<Zeroizing<String>, String> {
        let (uri, open) = self.new_link(lan, tunnel)?;
        let now = self.now();
        let mut tickets = lock(&self.e2e_tickets);
        tickets.retain(|t| t.expires > now);
        while tickets.len() >= 4 {
            tickets.remove(0);
        }
        tickets.push(open);
        Ok(uri)
    }

    fn new_link(&self, lan: Option<String>, tunnel: Option<String>) -> Result<(Zeroizing<String>, OpenTicket), String> {
        let now = self.now();
        let ticket = Ticket::generate().map_err(|e| e.to_string())?;
        let expires = now + seal::TICKET_TTL_SECS;
        let tunnel = tunnel.filter(|t| seal::check_tunnel_address(t).is_ok());
        let link = PairingLink {
            desktop_id: self.secret.desktop_id(),
            desktop_x25519: self.secret.x25519_public(),
            ticket: ticket.clone(),
            name: self.name.clone(),
            lan,
            tunnel,
        };
        let uri = Zeroizing::new(link.to_uri().map_err(|e| format!("Pairing link not possible: {e}"))?);
        Ok((uri, OpenTicket { ticket, expires }))
    }

    /// Takes the ticket with this id out of the open ones (once, unexpired).
    fn take_ticket(&self, id: &[u8; 8], now: u64) -> Option<Ticket> {
        let mut tickets = lock(&self.tickets);
        tickets.retain(|t| t.expires > now);
        if let Some(pos) = tickets.iter().position(|t| &t.ticket.id() == id) {
            return Some(tickets.remove(pos).ticket);
        }
        #[cfg(feature = "e2e-remote")]
        {
            let mut e2e = lock(&self.e2e_tickets);
            e2e.retain(|t| t.expires > now);
            if let Some(pos) = e2e.iter().position(|t| &t.ticket.id() == id) {
                return Some(e2e.remove(pos).ticket);
            }
        }
        None
    }

    fn request_payload(ch: &Channel, request_id: &str) -> serde_json::Value {
        serde_json::json!({
            "requestId": request_id,
            "name": ch.peer.name,
            "fingerprint": device_fingerprint(&ch.device_id),
            "platform": ch.peer.platform,
            // Both paths show one: the QR path from the handshake right away,
            // the code path once the phone's reveal is in.
            "comparisonCode": lock(&ch.comparison).clone().or_else(|| ch.session.sas().map(str::to_string)),
        })
    }

    /// Pairing requests the human has not answered yet (for a reloaded window).
    pub(crate) fn open_requests(&self) -> Vec<serde_json::Value> {
        self.prune(self.now());
        lock(&self.sessions)
            .values()
            .filter_map(|ch| match &*lock(&ch.link) {
                Link::Pending { request_id, asked: true, .. } => Some(Self::request_payload(ch, request_id)),
                _ => None,
            })
            .collect()
    }

    /// The human's answer to "Allow '<name>' to use LU on this computer?".
    /// Without this call a new pairing has no effect.
    pub(crate) fn decide(&self, request_id: &str, allow: bool) -> Result<(), String> {
        let now = self.now();
        self.prune(now);
        let ch = lock(&self.sessions)
            .values()
            .find(|ch| matches!(&*lock(&ch.link), Link::Pending { request_id: r, asked: true, .. } if r.as_str() == request_id))
            .cloned()
            .ok_or_else(|| "This pairing request is no longer open.".to_string())?;
        if allow {
            {
                let mut book = lock(&self.book);
                let mut next = book.clone();
                let rights = next.new_device_rights.unwrap_or_else(DeviceRights::first_pairing);
                if !next.devices.iter().any(|d| d.device_id == ch.device_id) {
                    next.devices.push(PairedDevice {
                        device_id: ch.device_id.clone(),
                        x25519: ch.peer.x25519.clone(),
                        ed25519: ch.peer.ed25519.clone(),
                        name: ch.peer.name.clone(),
                        platform: ch.peer.platform.clone(),
                        app_version: ch.peer.app_version.clone(),
                        rights,
                        paired_at: now,
                        last_seen: now,
                    });
                }
                self.save(&next)?;
                *book = next;
            }
            *lock(&ch.link) = Link::Paired;
            self.notify("remote-devices-changed", serde_json::json!({}));
        } else {
            *lock(&ch.link) = Link::Denied { since: now };
        }
        self.notify(
            "remote-pair-resolved",
            serde_json::json!({ "requestId": request_id, "outcome": if allow { "allowed" } else { "denied" } }),
        );
        Ok(())
    }

    // ── Housekeeping ──

    fn prune(&self, now: u64) {
        let mut expired_requests = Vec::new();
        {
            let mut sessions = lock(&self.sessions);
            sessions.retain(|_, ch| {
                if ch.session.is_expired(now) {
                    return false;
                }
                let confirmed = ch.confirmed.load(Ordering::SeqCst);
                if !confirmed && now.saturating_sub(ch.created) >= UNCONFIRMED_SECS {
                    // A pending pairing whose phone never sent a frame is
                    // gone with it; a request that was shown gets closed.
                    if let Link::Pending { request_id, asked: true, .. } = &*lock(&ch.link) {
                        expired_requests.push(request_id.clone());
                    }
                    return false;
                }
                if now.saturating_sub(ch.last_used.load(Ordering::SeqCst)) >= IDLE_SECS {
                    return false;
                }
                let mut link = lock(&ch.link);
                let next = match &*link {
                    Link::Pending { request_id, since, asked, .. } if now.saturating_sub(*since) >= PAIR_DECISION_SECS => {
                        if *asked {
                            expired_requests.push(request_id.clone());
                        }
                        Some(Link::Denied { since: now })
                    }
                    Link::Denied { since } if now.saturating_sub(*since) >= DENIED_KEEP_SECS => return false,
                    _ => None,
                };
                if let Some(next) = next {
                    *link = next;
                }
                true
            });
        }
        lock(&self.tickets).retain(|t| t.expires > now);
        lock(&self.pending).retain(|_, d| match d.finished_at() {
            Some(t) => now.saturating_sub(t) < PENDING_KEEP_SECS,
            None => {
                let keep = now.saturating_sub(d.created) < PENDING_MAX_AGE_SECS;
                if !keep {
                    d.stop();
                }
                keep
            }
        });
        for id in expired_requests {
            self.notify("remote-pair-resolved", serde_json::json!({ "requestId": id, "outcome": "expired" }));
        }
    }

    /// A fresh session counts only among the unconfirmed ones until its
    /// first data frame opens.
    fn insert_unconfirmed(&self, ch: Arc<Channel>) {
        let mut sessions = lock(&self.sessions);
        loop {
            let unconfirmed: Vec<([u8; 16], u64, bool)> = sessions
                .iter()
                .filter(|(_, c)| !c.confirmed.load(Ordering::SeqCst))
                .map(|(k, c)| (*k, c.created, c.device_id == ch.device_id))
                .collect();
            let same = unconfirmed.iter().filter(|(_, _, s)| *s).count();
            let victim = if same >= MAX_UNCONFIRMED_PER_DEVICE {
                unconfirmed.iter().filter(|(_, _, s)| *s).min_by_key(|(_, t, _)| *t)
            } else if unconfirmed.len() >= MAX_UNCONFIRMED {
                unconfirmed.iter().min_by_key(|(_, t, _)| *t)
            } else {
                None
            };
            match victim {
                Some((k, _, _)) => {
                    sessions.remove(k);
                }
                None => break,
            }
        }
        sessions.insert(ch.session.id(), ch);
    }

    /// First data frame opened: the session now counts, and the oldest
    /// confirmed one of the device (or of all) falls when over the limit.
    fn confirm(&self, sid: &[u8; 16], ch: &Channel) {
        if ch.confirmed.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut sessions = lock(&self.sessions);
        loop {
            let confirmed: Vec<([u8; 16], u64, bool)> = sessions
                .iter()
                .filter(|(k, c)| *k != sid && c.confirmed.load(Ordering::SeqCst))
                .map(|(k, c)| (*k, c.last_used.load(Ordering::SeqCst), c.device_id == ch.device_id))
                .collect();
            let same: Vec<_> = confirmed.iter().filter(|(_, _, s)| *s).collect();
            let victim = if same.len() >= MAX_SESSIONS_PER_DEVICE {
                // Oldest by creation for the device: least recently used is
                // close enough and needs no second field.
                same.iter().min_by_key(|(_, t, _)| *t).map(|v| v.0)
            } else if confirmed.len() >= MAX_SESSIONS {
                confirmed.iter().min_by_key(|(_, t, _)| *t).map(|v| v.0)
            } else {
                None
            };
            match victim {
                Some(k) => {
                    sessions.remove(&k);
                }
                None => break,
            }
        }
    }

    // ── The door ──

    /// The reading slots of one listener.
    pub(crate) fn slots(&self, listener: Listener) -> Arc<tokio::sync::Semaphore> {
        match listener {
            Listener::Lan => self.slots_lan.clone(),
            Listener::Tunnel => self.slots_tunnel.clone(),
        }
    }

    /// Outer answer for an error code, for remote.rs (too large, busy).
    pub(crate) fn refusal(code: &str, retry_after: Option<u64>) -> SealedOutcome {
        SealedOutcome { retry_after, ..outer(code) }
    }

    /// From the first bytes of a body: how far to read. A first message may
    /// be [`MAX_HS_INIT_BODY`], a data frame is read in full only when it
    /// names a session this desktop has. `None`: not enough bytes yet.
    pub(crate) fn plan_body(&self, head: &[u8], done: bool) -> Option<BodyPlan> {
        if head.len() < 2 {
            return done.then(|| BodyPlan::Refuse(outer("bad_frame")));
        }
        match seal::frame_kind(head) {
            Err(e) => Some(BodyPlan::Refuse(outer(frame_error(&e)))),
            Ok(seal::KIND_HS_INIT) => Some(BodyPlan::Limit(MAX_HS_INIT_BODY)),
            Ok(seal::KIND_DATA_TO_DESKTOP) => match seal::peek_session_id(head) {
                Ok(sid) => Some(if lock(&self.sessions).contains_key(&sid) {
                    BodyPlan::Limit(MAX_SEALED_BODY)
                } else {
                    BodyPlan::Refuse(outer("session_unknown"))
                }),
                Err(_) if !done => None,
                Err(e) => Some(BodyPlan::Refuse(outer(frame_error(&e)))),
            },
            Ok(_) => Some(BodyPlan::Refuse(outer("wrong_kind"))),
        }
    }

    /// One `POST /remote-api/sealed`. `dispatch` runs an inner request
    /// through the router; it is only called for a paired session.
    pub(crate) async fn handle<D, F>(self: &Arc<Self>, input: SealedInput<'_>, dispatch: D) -> SealedOutcome
    where
        D: FnOnce(InnerCall) -> F,
        F: Future<Output = InnerAnswer> + Send + 'static,
    {
        let now = self.now();
        self.prune(now);
        if input.body.len() > MAX_SEALED_BODY {
            return outer("too_large");
        }
        match seal::frame_kind(input.body) {
            Err(e) => outer(frame_error(&e)),
            Ok(seal::KIND_HS_INIT) => self.handshake(&input, now),
            Ok(seal::KIND_DATA_TO_DESKTOP) => self.data(input.body, now, dispatch).await,
            Ok(_) => outer("wrong_kind"),
        }
    }

    fn handshake(&self, input: &SealedInput<'_>, now: u64) -> SealedOutcome {
        let Some(&flags) = input.body.get(2) else { return outer("bad_frame") };
        let pairing = flags != 0;
        let by_code = flags == HS_FLAG_CODE;
        let tunnel = input.listener == Listener::Tunnel;
        // The same limits on both listeners: the home network is no safer
        // a place to send a flood from.
        if let Err(wait) = lock(&self.limiter).admit(input.source, now, pairing) {
            return rate_limited(wait);
        }
        // A first message read once is never read again.
        let Some(ephemeral) = init_ephemeral(input.body) else { return outer("bad_frame") };
        if !lock(&self.seen_ephemerals).claim(ephemeral, now) {
            return outer("replay");
        }
        let outcome = self.handshake_inner(input, now, pairing, by_code, tunnel);
        if outcome.status != 200 {
            lock(&self.seen_ephemerals).release(&ephemeral);
        }
        outcome
    }

    fn handshake_inner(&self, input: &SealedInput<'_>, now: u64, pairing: bool, by_code: bool, tunnel: bool) -> SealedOutcome {
        if by_code {
            // Never over the internet (decision E2).
            if tunnel {
                lock(&self.limiter).failed(input.source, now, true);
                return outer("unknown_ticket");
            }
            if let CodeOffer::Locked(wait) = &input.code {
                return rate_limited(*wait);
            }
        }
        let mut code_tried = false;
        let read = DesktopHandshake::read_init(&self.secret, input.body, |r| match r {
            PairingRef::Ticket(id) => self.take_ticket(&id, now).map(PairingSecret::Ticket),
            PairingRef::Code => match &input.code {
                CodeOffer::Shown(code) => {
                    code_tried = true;
                    PairingSecret::code(code).ok()
                }
                _ => None,
            },
        });
        let hs = match read {
            Ok(hs) => hs,
            Err(e) => {
                lock(&self.limiter).failed(input.source, now, pairing);
                let mut o = outer(handshake_error(&e));
                if by_code && code_tried {
                    o.code_use = Some(CodeUse::Failed);
                }
                return o;
            }
        };
        let device_id = hs.phone_device_id();
        let known = self.is_paired(&device_id);
        if !hs.is_pairing() && !known {
            lock(&self.limiter).failed(input.source, now, false);
            return outer("unknown_device");
        }
        let hello = hs.hello().clone();
        let peer = PeerInfo {
            name: clean_label(&hello.name, FALLBACK_PHONE),
            platform: hello.platform.clone(),
            app_version: hello.app_version.clone(),
            x25519: seal::b64(&hs.phone_x25519()),
            ed25519: hello.ed25519_pub.clone(),
        };
        let code_use = (hs.pairing() == Some(PairingRef::Code)).then_some(CodeUse::Consumed);
        let state = if known { PairState::Paired } else { PairState::Pending };
        let answer = DesktopHello::new(&self.secret, &self.name, state, Self::features(), now);
        let (session, frame) = match hs.respond(&answer, now) {
            Ok(x) => x,
            Err(e) => return SealedOutcome { code_use, ..outer(handshake_error(&e)) },
        };
        let link = if known {
            Link::Paired
        } else {
            let request_id = match seal::new_request_id() {
                Ok(id) => id,
                Err(_) => return SealedOutcome { code_use, ..outer("internal") },
            };
            // QR path: ask right away. Code path: ask once the reveal is in.
            Link::Pending { request_id, since: now, asked: !by_code, by_code }
        };
        let ch = Arc::new(Channel {
            session,
            device_id,
            peer,
            link: Mutex::new(link.clone()),
            created: now,
            last_used: AtomicU64::new(now),
            confirmed: AtomicBool::new(false),
            comparison: Mutex::new(None),
        });
        self.insert_unconfirmed(ch.clone());
        if let Link::Pending { request_id, asked: true, .. } = &link {
            self.notify("remote-pair-request", Self::request_payload(&ch, request_id));
        }
        SealedOutcome { status: 200, body: frame, sealed: true, retry_after: None, code_use }
    }

    async fn data<D, F>(self: &Arc<Self>, body: &[u8], now: u64, dispatch: D) -> SealedOutcome
    where
        D: FnOnce(InnerCall) -> F,
        F: Future<Output = InnerAnswer> + Send + 'static,
    {
        let sid = match seal::peek_session_id(body) {
            Ok(s) => s,
            Err(e) => return outer(frame_error(&e)),
        };
        let found = lock(&self.sessions).get(&sid).cloned();
        let Some(ch) = found else { return outer("session_unknown") };
        let message = match ch.session.open(body, now) {
            Ok(m) => m,
            Err(e) => {
                if matches!(e, SealError::SessionExpired | SealError::SessionExhausted) {
                    lock(&self.sessions).remove(&sid);
                }
                return outer(frame_error(&e));
            }
        };
        let link = lock(&ch.link).clone();
        // A device unpaired since its handshake: the session is dead too.
        if link == Link::Paired && !self.is_paired(&ch.device_id) {
            lock(&self.sessions).remove(&sid);
            return outer("session_unknown");
        }
        ch.last_used.store(now, Ordering::SeqCst);
        self.confirm(&sid, &ch);
        if link == Link::Paired {
            self.persist_last_seen(&ch.device_id, now);
        }
        let request = match InnerRequest::decode(&message) {
            Ok(r) => r,
            Err(e) => {
                let Some(id) = salvage_request_id(&message) else { return outer("bad_frame") };
                let code = if e == SealError::ForbiddenPath { "forbidden_path" } else { "bad_inner" };
                return self.reply(&ch, &id, InnerAnswer::json(400, serde_json::json!({ "error": code })), now);
            }
        };
        let started = std::time::Instant::now();
        let answer = self.route(&ch, &request, link, now, dispatch).await;
        // One line per inner request, as the plain routes have
        // (remote.rs `access_log`): the inner path, never a token.
        tracing::info!(
            channel = "sealed",
            method = %request.method,
            path = %crate::commands::remote::loggable_path(&request.path),
            status = answer.status,
            ms = started.elapsed().as_millis() as u64,
            "remote request"
        );
        self.reply(&ch, &request.id, answer, now)
    }

    async fn route<D, F>(self: &Arc<Self>, ch: &Arc<Channel>, request: &InnerRequest, link: Link, now: u64, dispatch: D) -> InnerAnswer
    where
        D: FnOnce(InnerCall) -> F,
        F: Future<Output = InnerAnswer> + Send + 'static,
    {
        let path = request.path.split('?').next().unwrap_or("");
        match link {
            Link::Pending { asked, by_code, request_id, .. } => {
                if path == PAIR_STATUS_PATH {
                    return InnerAnswer::json(200, serde_json::json!({ "state": "pending" }));
                }
                if path == PAIR_REVEAL_PATH && request.method == "POST" && by_code && !asked {
                    return self.reveal(ch, &request_id, &request.body);
                }
                InnerAnswer::json(403, serde_json::json!({ "error": "pairing_pending" }))
            }
            Link::Denied { .. } => {
                if path == PAIR_STATUS_PATH {
                    return InnerAnswer::json(200, serde_json::json!({ "state": "denied" }));
                }
                InnerAnswer::json(403, serde_json::json!({ "error": "pairing_denied" }))
            }
            Link::Paired => {
                if path == PAIR_STATUS_PATH {
                    return InnerAnswer::json(200, serde_json::json!({ "state": "paired" }));
                }
                if path == PAIR_REVEAL_PATH {
                    return InnerAnswer::json(400, serde_json::json!({ "error": "bad_reveal" }));
                }
                if let Some(token) = path.strip_prefix(seal::PENDING_PATH_PREFIX) {
                    return self.pending_call(&ch.device_id, token, &request.method).await;
                }
                if path == SIGNIN_PATH {
                    if request.method != "POST" {
                        return InnerAnswer::json(405, serde_json::json!({ "error": "bad_inner" }));
                    }
                    let generation = self.generation(&ch.device_id);
                    return match self.signin_ask(ch) {
                        Ok(wait) => self.run_deferred(&ch.device_id, generation, wait).await,
                        Err(refusal) => refusal,
                    };
                }
                if path == FORGET_SELF_PATH && request.method == "POST" {
                    return match self.forget(&ch.device_id) {
                        Ok(_) => InnerAnswer::json(200, serde_json::json!({ "forgotten": true })),
                        Err(_) => InnerAnswer::json(500, serde_json::json!({ "error": "not_saved" })),
                    };
                }
                let generation = self.generation(&ch.device_id);
                let rights = self.rights_of(&ch.device_id).unwrap_or_default();
                let routed = match request.for_router(&ch.device_id) {
                    Ok(r) => r,
                    Err(_) => return InnerAnswer::json(400, serde_json::json!({ "error": "bad_inner" })),
                };
                self.touch_device(&ch.device_id, now);
                let call = InnerCall {
                    method: routed.method,
                    path: routed.path,
                    headers: routed.headers,
                    body: routed.body,
                    caller: SealedCaller { device_id: ch.device_id.clone(), rights, generation },
                };
                self.run_deferred(&ch.device_id, generation, dispatch(call)).await
            }
        }
    }

    /// Code path: the phone opens its commitment. Only now is there a
    /// comparison code, and only now does the desktop ask its user.
    fn reveal(&self, ch: &Arc<Channel>, request_id: &str, body: &[u8]) -> InnerAnswer {
        let n = serde_json::from_slice::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v.get("n").and_then(|n| n.as_str()).map(str::to_string));
        let accepted = n.as_deref().map(|n| ch.session.accept_sas_reveal(n).map(str::to_string));
        match accepted {
            Some(Ok(code)) => {
                *lock(&ch.comparison) = Some(code);
                if let Link::Pending { asked, .. } = &mut *lock(&ch.link) {
                    *asked = true;
                }
                self.notify("remote-pair-request", Self::request_payload(ch, request_id));
                InnerAnswer::json(200, serde_json::json!({ "state": "pending" }))
            }
            _ => {
                // The pairing is void (PROTOKOLL 16, bad_reveal).
                *lock(&ch.link) = Link::Denied { since: self.now() };
                InnerAnswer::json(400, serde_json::json!({ "error": "bad_reveal" }))
            }
        }
    }

    /// Runs the router for up to [`HOLD`]; after that the answer is deferred
    /// under a token the phone polls (PROTOKOLL 9).
    async fn run_deferred<F>(&self, device_id: &str, generation: u64, work: F) -> InnerAnswer
    where
        F: Future<Output = InnerAnswer> + Send + 'static,
    {
        let entry = Arc::new(Deferred {
            device_id: device_id.to_string(),
            created: self.now(),
            done: Mutex::new(None),
            notify: tokio::sync::Notify::new(),
            abort: Mutex::new(None),
        });
        let done = entry.clone();
        let clock = self.clock.clone();
        let task = tokio::spawn(async move {
            let answer = work.await;
            *lock(&done.done) = Some((answer, clock()));
            done.notify.notify_waiters();
        });
        *lock(&entry.abort) = Some(task.abort_handle());
        // Until the work is handed to `pending`, it ends with this call (a
        // dropped request leaves nothing running).
        let mut held = AbortOnDrop(Some(task.abort_handle()));
        if let Some(answer) = entry.wait(self.hold).await {
            held.0 = None;
            return answer;
        }
        let token = match seal::new_request_id() {
            Ok(t) => t,
            Err(_) => {
                entry.stop();
                return InnerAnswer::json(500, serde_json::json!({ "error": "internal" }));
            }
        };
        {
            let mut pending = lock(&self.pending);
            // Unpaired or a right taken while the work ran: it is not kept.
            if !self.caller_current(device_id, generation) {
                drop(pending);
                entry.stop();
                held.0 = None;
                return InnerAnswer::json(403, serde_json::json!({ "error": "unknown_device" }));
            }
            let mut mine: Vec<(String, u64)> = pending
                .iter()
                .filter(|(_, d)| d.device_id == device_id)
                .map(|(k, d)| (k.clone(), d.created))
                .collect();
            mine.sort_by_key(|(_, t)| *t);
            while mine.len() >= MAX_PENDING_PER_DEVICE {
                let (k, _) = mine.remove(0);
                if let Some(d) = pending.remove(&k) {
                    d.stop();
                }
            }
            pending.insert(token.clone(), entry);
        }
        held.0 = None;
        Self::deferred(token)
    }

    fn deferred(token: String) -> InnerAnswer {
        InnerAnswer { status: 202, headers: vec![(seal::PENDING_HEADER.to_string(), token)], body: Vec::new() }
    }

    async fn pending_call(&self, device_id: &str, token: &str, method: &str) -> InnerAnswer {
        let entry = lock(&self.pending).get(token).cloned().filter(|d| d.device_id == device_id);
        let Some(entry) = entry else {
            return InnerAnswer::json(404, serde_json::json!({ "error": "unknown_pending" }));
        };
        match method {
            "GET" => match entry.wait(self.poll_hold).await {
                Some(answer) => answer,
                None => Self::deferred(token.to_string()),
            },
            "DELETE" => {
                entry.stop();
                lock(&self.pending).remove(token);
                InnerAnswer::empty(204)
            }
            _ => InnerAnswer::json(405, serde_json::json!({ "error": "bad_inner" })),
        }
    }

    /// Seals the inner answer for the phone.
    fn reply(&self, ch: &Channel, id: &str, answer: InnerAnswer, now: u64) -> SealedOutcome {
        let headers: Vec<(String, String)> = answer
            .headers
            .into_iter()
            .map(|(k, v)| (k.to_ascii_lowercase(), v))
            .filter(|(k, v)| {
                RESPONSE_HEADERS.contains(&k.as_str())
                    && v.len() <= 8192
                    && !v.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0)
            })
            .collect();
        let response = InnerResponse { id: id.to_string(), status: answer.status, headers, body: answer.body };
        let message = match response.encode() {
            Ok(m) => m,
            Err(_) => {
                let small = InnerResponse {
                    id: id.to_string(),
                    status: 413,
                    headers: vec![("content-type".into(), "application/json".into())],
                    body: br#"{"error":"too_large"}"#.to_vec(),
                };
                match small.encode() {
                    Ok(m) => m,
                    Err(e) => return outer(frame_error(&e)),
                }
            }
        };
        match ch.session.seal(&message, now) {
            Ok(frame) => SealedOutcome { status: 200, body: frame, sealed: true, retry_after: None, code_use: None },
            Err(e) => outer(frame_error(&e)),
        }
    }
}

/// The request id of an inner message that did not pass the checks, so the
/// refusal can still be addressed to it. Reads only the head (PROTOKOLL 8:
/// u32 length, JSON head).
fn salvage_request_id(message: &[u8]) -> Option<String> {
    let len = u32::from_be_bytes(message.get(..4)?.try_into().ok()?) as usize;
    let head = message.get(4..4usize.checked_add(len)?)?;
    let v: serde_json::Value = serde_json::from_slice(head).ok()?;
    let id = v.get("id")?.as_str()?;
    seal::check_id(id).ok()?;
    Some(id.to_string())
}

// ─── Address directory (PROTOKOLL 14) ───

/// Base of the lu-labs.ai routes. The same setting as `CLOUD_BASE` in
/// src/api/cloud/config.ts: `VITE_LU_CLOUD_URL` when the build sets it,
/// otherwise the public site.
pub(crate) const CLOUD_BASE: &str = match option_env!("VITE_LU_CLOUD_URL") {
    Some(url) => url,
    None => "https://lu-labs.ai",
};
const ANNOUNCE_ROUTE: &str = "/api/remote/announce";
/// The directory forgets an address after 7 days without a new announcement;
/// the desktop announces again well before that (PROTOKOLL 14: every 6 h).
const ANNOUNCE_REFRESH: Duration = Duration::from_secs(6 * 60 * 60);
const ANNOUNCE_RETRY_FIRST: Duration = Duration::from_secs(10);
const ANNOUNCE_RETRY_MAX: Duration = Duration::from_secs(30 * 60);
const ANNOUNCE_TIMEOUT: Duration = Duration::from_secs(15);

/// Does the tunnel address answer? Given the address, true when its status
/// route answered with success.
pub(crate) type ProbeFuture = std::pin::Pin<Box<dyn Future<Output = bool> + Send>>;
pub(crate) type Probe = Arc<dyn Fn(String) -> ProbeFuture + Send + Sync>;

/// Where and how the announcement goes. Tests point `base` at a stand-in on
/// loopback and replace the probe.
#[derive(Clone)]
pub(crate) struct AnnounceNet {
    pub base: String,
    pub probe: Probe,
    pub retry_first: Duration,
    pub retry_max: Duration,
    pub refresh: Duration,
}

impl Default for AnnounceNet {
    fn default() -> Self {
        Self {
            base: CLOUD_BASE.trim_end_matches('/').to_string(),
            probe: Arc::new(|address: String| -> ProbeFuture { Box::pin(probe_tunnel(address)) }),
            retry_first: ANNOUNCE_RETRY_FIRST,
            retry_max: ANNOUNCE_RETRY_MAX,
            refresh: ANNOUNCE_REFRESH,
        }
    }
}

async fn probe_tunnel(address: String) -> bool {
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(8)).no_proxy().build() else {
        return false;
    };
    matches!(client.get(format!("{address}/remote-api/status")).send().await, Ok(r) if r.status().is_success())
}

/// What the Remote settings show about the announcement.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnounceStatus {
    /// `off` (switch off), `idle` (no tunnel), `announcing`, `ok`, `failed`.
    pub state: &'static str,
    /// Unix seconds of the last announcement the directory took.
    pub last_ok_at: Option<u64>,
    /// Why the last try failed, in words for the panel.
    pub error: Option<String>,
    /// Unix seconds of the next try after a failure.
    pub next_try_at: Option<u64>,
}

/// One failed try: the words for the panel and how long the directory asked
/// to wait (`retry-after`).
struct AnnounceFailure {
    message: String,
    retry_after: Option<Duration>,
}

impl AnnounceFailure {
    fn new(message: &str) -> Self {
        Self { message: message.to_string(), retry_after: None }
    }
}

fn announce_refusal(status: u16, code: &str) -> String {
    match code {
        "clock_skew" => "The clock of this computer is more than five minutes off.".to_string(),
        "rate_limited" => "Too many announcements in a short time.".to_string(),
        "key_mismatch" => "lu-labs.ai knows this computer's id with a different key.".to_string(),
        "stale" => "lu-labs.ai already has a newer announcement of this computer.".to_string(),
        // Only a plain code from the answer is shown, never free text.
        other if !other.is_empty() && other.len() <= 32 && other.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') => {
            format!("lu-labs.ai refused the address ({other}).")
        }
        _ => format!("lu-labs.ai refused the address (HTTP {status})."),
    }
}

/// Wait before try number `fails + 1`: the first wait, tripled per failure,
/// never longer than the ceiling.
fn announce_backoff(net: &AnnounceNet, fails: u32) -> Duration {
    let factor = 3u32.saturating_pow(fails.saturating_sub(1).min(16));
    net.retry_first.saturating_mul(factor).min(net.retry_max)
}

impl SealedHub {
    /// Replace where announcements go (tests).
    #[cfg(test)]
    pub(crate) fn set_announce_net(&self, net: AnnounceNet) {
        *lock(&self.announce_net) = net;
    }

    #[cfg(test)]
    pub(crate) fn set_signin_wait(&self, wait: Duration) {
        *lock(&self.signin_wait) = wait;
    }

    pub(crate) fn announce_status(&self) -> AnnounceStatus {
        let mut status = lock(&self.announce).clone();
        if status.state.is_empty() {
            status.state = if self.anywhere() { "idle" } else { "off" };
        }
        status
    }

    fn set_announce(&self, generation: u64, status: AnnounceStatus) {
        if self.announce_gen.load(Ordering::SeqCst) != generation {
            return;
        }
        let changed = {
            let mut current = lock(&self.announce);
            let changed = *current != status;
            *current = status;
            changed
        };
        if changed {
            self.notify("remote-announce-changed", serde_json::to_value(self.announce_status()).unwrap_or_default());
        }
    }

    /// The tunnel is up at `address` (cloudflared printed it).
    pub(crate) fn tunnel_up(self: &Arc<Self>, address: &str) {
        let same = lock(&self.tunnel_address).as_deref() == Some(address);
        *lock(&self.tunnel_address) = Some(address.to_string());
        let running = lock(&self.announce_task).as_ref().is_some_and(|t| !t.is_finished());
        if same && running {
            return;
        }
        self.announce_follow();
    }

    /// The address cloudflared printed: the tunnel listener answers under
    /// its host only. A value of another form is not taken.
    pub(crate) fn expect_tunnel_host(&self, address: &str) {
        let host = seal::check_tunnel_address(address)
            .ok()
            .and_then(|_| address.strip_prefix("https://"))
            .map(str::to_string);
        *lock(&self.tunnel_host) = host;
    }

    pub(crate) fn tunnel_host(&self) -> Option<String> {
        lock(&self.tunnel_host).clone()
    }

    /// The tunnel is gone: no more announcing until the next one.
    pub(crate) fn tunnel_down(&self) {
        *lock(&self.tunnel_host) = None;
        *lock(&self.tunnel_address) = None;
        self.announce_follow_inner(None);
    }

    /// Start or stop the announce loop after a change of the switch or the
    /// tunnel.
    fn announce_follow(self: &Arc<Self>) {
        self.announce_follow_inner(Some(self.clone()));
    }

    fn announce_follow_inner(&self, me: Option<Arc<SealedHub>>) {
        let generation = self.announce_gen.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(task) = lock(&self.announce_task).take() {
            task.abort();
        }
        let address = lock(&self.tunnel_address).clone();
        let last_ok_at = lock(&self.announce).last_ok_at;
        if !self.anywhere() {
            self.set_announce(generation, AnnounceStatus { state: "off", last_ok_at, ..Default::default() });
            return;
        }
        let (Some(address), Some(me)) = (address, me) else {
            self.set_announce(generation, AnnounceStatus { state: "idle", last_ok_at, ..Default::default() });
            return;
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
        self.set_announce(generation, AnnounceStatus { state: "announcing", last_ok_at, ..Default::default() });
        let weak = Arc::downgrade(&me);
        drop(me);
        let task = runtime.spawn(announce_loop(weak, address, generation));
        *lock(&self.announce_task) = Some(task.abort_handle());
    }

    /// One announcement: is the address reachable, then the signed message to
    /// the directory. No account, no session, only the desktop key.
    async fn announce_once(&self, address: &str) -> Result<(), AnnounceFailure> {
        let net = lock(&self.announce_net).clone();
        if seal::check_tunnel_address(address).is_err() {
            return Err(AnnounceFailure::new("The tunnel address has an unexpected form."));
        }
        if !(net.probe)(address.to_string()).await {
            return Err(AnnounceFailure::new("The tunnel address does not answer yet."));
        }
        let announce = seal::sign_announce(&self.secret, address, self.now())
            .map_err(|_| AnnounceFailure::new("The announcement could not be signed."))?;
        let client = reqwest::Client::builder()
            .timeout(ANNOUNCE_TIMEOUT)
            .build()
            .map_err(|_| AnnounceFailure::new("lu-labs.ai could not be reached."))?;
        let res = client
            .post(format!("{}{ANNOUNCE_ROUTE}", net.base))
            .json(&announce)
            .send()
            .await
            .map_err(|_| AnnounceFailure::new("lu-labs.ai could not be reached."))?;
        let status = res.status().as_u16();
        if res.status().is_success() {
            return Ok(());
        }
        let retry_after = res
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        let code = res
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
            .unwrap_or_default();
        Err(AnnounceFailure { message: announce_refusal(status, &code), retry_after })
    }
}

/// Announces `address` until stopped: again after the refresh time, and after
/// a failure with a growing wait.
async fn announce_loop(hub: std::sync::Weak<SealedHub>, address: String, generation: u64) {
    let mut fails: u32 = 0;
    loop {
        let Some(h) = hub.upgrade() else { return };
        if h.announce_gen.load(Ordering::SeqCst) != generation {
            return;
        }
        if !h.anywhere() {
            let last_ok_at = lock(&h.announce).last_ok_at;
            h.set_announce(generation, AnnounceStatus { state: "off", last_ok_at, ..Default::default() });
            return;
        }
        let net = lock(&h.announce_net).clone();
        let wait = match h.announce_once(&address).await {
            Ok(()) => {
                fails = 0;
                h.set_announce(generation, AnnounceStatus { state: "ok", last_ok_at: Some(h.now()), ..Default::default() });
                net.refresh
            }
            Err(failure) => {
                fails = fails.saturating_add(1);
                let wait = announce_backoff(&net, fails).max(failure.retry_after.unwrap_or_default());
                let last_ok_at = lock(&h.announce).last_ok_at;
                tracing::warn!(attempt = fails, "remote address announcement failed");
                h.set_announce(
                    generation,
                    AnnounceStatus {
                        state: "failed",
                        last_ok_at,
                        error: Some(failure.message),
                        next_try_at: Some(h.now() + wait.as_secs()),
                    },
                );
                wait
            }
        };
        drop(h);
        tokio::time::sleep(wait).await;
    }
}

// ─── "Sign in with my computer" (PROTOKOLL 15) ───

/// The human's answer to "Sign this phone in to your LU account?". The window
/// fetches the code with its own session; only the code comes back here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SigninDecision {
    Allow { code: String, expires: u64 },
    Deny,
    /// LU on this computer is not signed in to an account.
    SignedOut,
    /// lu-labs.ai did not give a code.
    Unavailable,
}

struct SigninAsk {
    device_id: String,
    payload: serde_json::Value,
    tx: tokio::sync::oneshot::Sender<SigninDecision>,
}

/// Ends an open question when its waiting request goes away (answered, timed
/// out, given up by the phone, aborted).
struct SigninGuard {
    hub: std::sync::Weak<SealedHub>,
    request_id: String,
}

impl Drop for SigninGuard {
    fn drop(&mut self) {
        let Some(hub) = self.hub.upgrade() else { return };
        if lock(&hub.signins).remove(&self.request_id).is_some() {
            hub.notify("remote-signin-resolved", serde_json::json!({ "requestId": self.request_id, "outcome": "expired" }));
        }
    }
}

fn signin_answer(decision: Option<SigninDecision>) -> InnerAnswer {
    match decision {
        Some(SigninDecision::Allow { code, expires }) => {
            InnerAnswer::json(200, serde_json::json!({ "code": code, "expires": expires }))
        }
        Some(SigninDecision::SignedOut) => InnerAnswer::json(
            409,
            serde_json::json!({
                "error": "desktop_signed_out",
                "message": "LU on your computer is not signed in. Sign in there first, then try again.",
            }),
        ),
        Some(SigninDecision::Unavailable) => InnerAnswer::json(502, serde_json::json!({ "error": "signin_unavailable" })),
        Some(SigninDecision::Deny) | None => InnerAnswer::json(403, serde_json::json!({ "error": "signin_denied" })),
    }
}

impl SealedHub {
    /// A paired phone asks to be signed in. Shows the question at the desktop
    /// and returns the wait for the answer, or the refusal right away.
    fn signin_ask(self: &Arc<Self>, ch: &Arc<Channel>) -> Result<impl Future<Output = InnerAnswer> + Send + 'static, InnerAnswer> {
        let device = lock(&self.book).devices.iter().find(|d| d.device_id == ch.device_id).cloned();
        let Some(device) = device else {
            return Err(InnerAnswer::json(403, serde_json::json!({ "error": "unknown_device" })));
        };
        // The phone's Ed25519 key, tied to its channel key by `bind` at the
        // pairing handshake: the code will be bound to exactly this key.
        if seal::b64_decode_exact::<32>(&device.ed25519).is_err() || device.ed25519 != ch.peer.ed25519 {
            return Err(InnerAnswer::json(400, serde_json::json!({ "error": "bad_binding" })));
        }
        // One question at a time on this desktop, whoever asks.
        if !lock(&self.signins).is_empty() {
            return Err(InnerAnswer::json(409, serde_json::json!({ "error": "signin_pending" })));
        }
        {
            let now = self.now();
            let mut asked = lock(&self.signin_asked);
            while asked.front().is_some_and(|(_, t)| now.saturating_sub(*t) >= SIGNIN_WINDOW_SECS) {
                asked.pop_front();
            }
            let mine = asked.iter().filter(|(d, _)| d == &device.device_id).count();
            if mine >= SIGNIN_ASKS_PER_DEVICE || asked.len() >= SIGNIN_ASKS_TOTAL {
                let oldest = asked
                    .iter()
                    .find(|(d, _)| mine < SIGNIN_ASKS_PER_DEVICE || d == &device.device_id)
                    .map(|(_, t)| *t)
                    .unwrap_or(now);
                let wait = (oldest + SIGNIN_WINDOW_SECS).saturating_sub(now).max(1);
                let mut refusal = InnerAnswer::json(429, serde_json::json!({ "error": "rate_limited" }));
                refusal.headers.push(("retry-after".into(), wait.to_string()));
                return Err(refusal);
            }
            asked.push_back((device.device_id.clone(), now));
        }
        let request_id = seal::new_request_id().map_err(|_| InnerAnswer::json(500, serde_json::json!({ "error": "internal" })))?;
        let payload = serde_json::json!({
            "requestId": request_id,
            "name": clean_label(&device.name, FALLBACK_PHONE),
            "fingerprint": device_fingerprint(&device.device_id),
            "platform": device.platform,
            "devicePub": device.ed25519,
        });
        let (tx, rx) = tokio::sync::oneshot::channel();
        lock(&self.signins).insert(
            request_id.clone(),
            SigninAsk { device_id: device.device_id.clone(), payload: payload.clone(), tx },
        );
        self.notify("remote-signin-request", payload);
        let wait = *lock(&self.signin_wait);
        let guard = SigninGuard { hub: Arc::downgrade(self), request_id };
        Ok(async move {
            let decision = tokio::time::timeout(wait, rx).await.ok().and_then(Result::ok);
            drop(guard);
            signin_answer(decision)
        })
    }

    /// Questions waiting for an answer (for a reloaded window).
    pub(crate) fn open_signins(&self) -> Vec<serde_json::Value> {
        lock(&self.signins).values().map(|a| a.payload.clone()).collect()
    }

    /// The human answered. An `Allow` without a well formed code counts as
    /// "no code available"; nothing but the code and its end reaches the phone.
    pub(crate) fn signin_decide(&self, request_id: &str, decision: SigninDecision) -> Result<(), String> {
        let decision = match decision {
            SigninDecision::Allow { code, .. } if seal::check_signin_code(&code).is_err() => SigninDecision::Unavailable,
            other => other,
        };
        let outcome = match &decision {
            SigninDecision::Allow { .. } => "allowed",
            SigninDecision::Deny => "denied",
            SigninDecision::SignedOut => "signed_out",
            SigninDecision::Unavailable => "unavailable",
        };
        let ask = lock(&self.signins)
            .remove(request_id)
            .ok_or_else(|| "This sign-in request is no longer open.".to_string())?;
        let _ = ask.tx.send(decision);
        self.notify("remote-signin-resolved", serde_json::json!({ "requestId": request_id, "outcome": outcome }));
        Ok(())
    }

    fn drop_signins_of(&self, device_id: &str) {
        let gone: Vec<String> = {
            let mut asks = lock(&self.signins);
            let ids: Vec<String> = asks.iter().filter(|(_, a)| a.device_id == device_id).map(|(k, _)| k.clone()).collect();
            for id in &ids {
                asks.remove(id);
            }
            ids
        };
        for id in gone {
            self.notify("remote-signin-resolved", serde_json::json!({ "requestId": id, "outcome": "expired" }));
        }
    }

    fn drop_signins_of_all(&self) {
        let gone: Vec<String> = lock(&self.signins).drain().map(|(k, _)| k).collect();
        for id in gone {
            self.notify("remote-signin-resolved", serde_json::json!({ "requestId": id, "outcome": "expired" }));
        }
    }
}

// ─── The one hub of this app ───

static HUB: tokio::sync::Mutex<Option<Arc<SealedHub>>> = tokio::sync::Mutex::const_new(None);

/// The hub, opened on first use. A failure (keychain refused) is reported and
/// tried again next time; Remote then runs without the sealed channel.
pub(crate) async fn shared_hub(app: &tauri::AppHandle) -> Result<Arc<SealedHub>, String> {
    use tauri::{Emitter, Manager};
    let mut slot = HUB.lock().await;
    if let Some(hub) = slot.as_ref() {
        return Ok(hub.clone());
    }
    let dir = app.path().app_data_dir().map_err(|e| crate::os_error::english(&e))?;
    let name = crate::commands::remote::desktop_display_name();
    let hub = tokio::task::spawn_blocking(move || SealedHub::open(&dir, &name))
        .await
        .map_err(|e| e.to_string())??;
    let hub = Arc::new(hub);
    let handle = app.clone();
    hub.set_notifier(Arc::new(move |event: &str, payload: serde_json::Value| {
        let _ = handle.emit(event, payload);
    }));
    *slot = Some(hub.clone());
    Ok(hub)
}

/// Remote stopped: no session outlives the server. Waits for the hub slot:
/// a hub that is being opened right now is stopped all the same.
pub(crate) async fn server_stopped() {
    let hub = HUB.lock().await.clone();
    if let Some(hub) = hub {
        hub.drop_all_sessions();
    }
}

/// The tunnel is up at `address`: announce it when "Reach this computer from
/// anywhere" is on (PROTOKOLL 14).
pub(crate) async fn tunnel_started(address: &str) {
    let hub = HUB.lock().await.clone();
    if let Some(hub) = hub {
        hub.tunnel_up(address);
    }
}

/// cloudflared printed its address: the tunnel listener answers under it.
pub(crate) async fn tunnel_expected(address: &str) {
    let hub = HUB.lock().await.clone();
    if let Some(hub) = hub {
        hub.expect_tunnel_host(address);
    }
}

/// The tunnel is gone: stop announcing.
pub(crate) async fn tunnel_stopped() {
    let hub = HUB.lock().await.clone();
    if let Some(hub) = hub {
        hub.tunnel_down();
    }
}

// ─── Tauri commands (the desktop's own window only) ───

#[tauri::command]
pub async fn remote_paired_devices(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    match shared_hub(&app).await {
        Ok(hub) => Ok(serde_json::json!({
            "available": true,
            "storage": hub.storage_kind(),
            "anywhere": hub.anywhere(),
            "legacy": {
                "needsConsent": hub.legacy_needs_consent(),
                "until": hub.legacy_access_until(),
            },
            "announce": hub.announce_status(),
            "newDeviceRights": hub.new_device_rights(),
            "devices": devices_for_window(hub.devices()),
        })),
        Err(e) => Ok(serde_json::json!({ "available": false, "error": e, "devices": [] })),
    }
}

/// The paired devices for the settings list, each with the fingerprint the
/// phone shows as well.
fn devices_for_window(devices: Vec<PairedDevice>) -> Vec<serde_json::Value> {
    devices
        .into_iter()
        .map(|d| {
            let fingerprint = device_fingerprint(&d.device_id);
            let mut v = serde_json::to_value(&d).unwrap_or_default();
            if let Some(o) = v.as_object_mut() {
                o.insert("fingerprint".into(), fingerprint.into());
            }
            v
        })
        .collect()
}

#[tauri::command]
pub async fn remote_set_new_device_rights(app: tauri::AppHandle, rights: DeviceRights) -> Result<(), String> {
    shared_hub(&app).await?.set_new_device_rights(rights)
}

#[tauri::command]
pub async fn remote_forget_device(app: tauri::AppHandle, device_id: String) -> Result<bool, String> {
    shared_hub(&app).await?.forget(&device_id)
}

#[tauri::command]
pub async fn remote_set_device_rights(app: tauri::AppHandle, device_id: String, rights: DeviceRights) -> Result<(), String> {
    shared_hub(&app).await?.set_rights(&device_id, rights)
}

#[tauri::command]
pub async fn remote_pair_decide(app: tauri::AppHandle, request_id: String, allow: bool) -> Result<(), String> {
    shared_hub(&app).await?.decide(&request_id, allow)
}

#[tauri::command]
pub async fn remote_pair_requests(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    Ok(shared_hub(&app).await?.open_requests())
}

#[tauri::command]
pub async fn remote_signin_requests(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    Ok(shared_hub(&app).await?.open_signins())
}

/// The answer to "Sign this phone in to your LU account?". `outcome` is
/// `allow` (with the code the window fetched), `deny`, `signed_out` or
/// `unavailable`. The window's session never comes here, only the code.
#[tauri::command]
pub async fn remote_signin_decide(
    app: tauri::AppHandle,
    request_id: String,
    outcome: String,
    code: Option<String>,
    expires: Option<u64>,
) -> Result<(), String> {
    let decision = match (outcome.as_str(), code, expires) {
        ("allow", Some(code), Some(expires)) => SigninDecision::Allow { code, expires },
        ("allow", _, _) | ("unavailable", _, _) => SigninDecision::Unavailable,
        ("signed_out", _, _) => SigninDecision::SignedOut,
        _ => SigninDecision::Deny,
    };
    shared_hub(&app).await?.signin_decide(&request_id, decision)
}

/// The browser page and the plain code login for older phones: allowed at
/// the desktop for [`LEGACY_ACCESS_SECS`], or ended. Answers the end.
#[tauri::command]
pub async fn remote_set_legacy_access(app: tauri::AppHandle, on: bool) -> Result<Option<u64>, String> {
    let hub = shared_hub(&app).await?;
    hub.set_legacy_access(on);
    Ok(hub.legacy_access_until())
}

#[tauri::command]
pub async fn remote_set_anywhere(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    shared_hub(&app).await?.set_anywhere(on)
}

// ─── Tests ───

#[cfg(test)]
mod tests;
