//! Voice over Remote (GitHub #212): a phone talks to LU on this computer and
//! hears the answer.
//!
//! The phone records one take at a time (push to talk, or hands free where
//! the phone itself hears the end of a sentence), sends it here, and this
//! computer writes it down with the speech recognition it already has for
//! dictation (faster-whisper, `whisper.rs`). The text then goes into the chat
//! like a typed message. For the answer the phone uses its own voice first;
//! a phone without one asks this computer to speak it with Piper (`tts.rs`).
//!
//! Turns, not a live audio stream: the remote way is one sealed request after
//! the other, also through the tunnel, and a take of a few seconds fits in
//! one of them. Nothing of the take is kept: whisper.rs writes it to a private
//! temporary folder and removes it after the transcription.
//!
//! Routes, behind `auth_middleware` and the device right `chat`
//! (`remote_sealed::right_for_path`), on the LAN listener with a JWT and
//! inside the sealed channel:
//!
//! * `GET  /remote-api/voice`             what this computer can do right now
//! * `POST /remote-api/voice/transcribe`  a WAV take, answers `{ "text" }`
//! * `POST /remote-api/voice/speak`       `{ "text" }`, answers a WAV

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    body::Bytes,
    extract::{rejection::JsonRejection, State as AxumState},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::remote::CallerDevice;

pub(crate) const STATUS_PATH: &str = "/remote-api/voice";
pub(crate) const TRANSCRIBE_PATH: &str = "/remote-api/voice/transcribe";
pub(crate) const SPEAK_PATH: &str = "/remote-api/voice/speak";

/// The feature word in the authenticated status.
pub(crate) const FEATURE: &str = "voice";

/// A take, as WAV. Two minutes of 16 kHz mono 16 bit are 3.84 MB; a sealed
/// message holds 8 MiB, base64 included.
pub(crate) const MAX_TAKE_BYTES: usize = 4 * 1024 * 1024;
/// The longest take the phone records, told to it in the status.
pub(crate) const MAX_TAKE_MS: u64 = 120_000;
/// One piece of an answer to speak. The phone sends a sentence or a few.
pub(crate) const MAX_SPEAK_CHARS: usize = 1500;

// A take fits into one sealed message: base64 grows by a third, and the
// request around it needs room too.
const _: () = assert!(MAX_TAKE_BYTES * 4 / 3 + 64 * 1024 < crate::remote_seal::MAX_MESSAGE);
/// What the status said is kept this long: each answer of it starts Python twice.
const STATUS_KEEP: Duration = Duration::from_secs(20);

pub(crate) type EngineFuture<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send>>;

/// What this computer can do for a phone's voice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Abilities {
    /// Speech recognition is installed (faster-whisper).
    pub listen: bool,
    /// A Piper voice can speak.
    pub speak: bool,
}

/// The speech work itself. The real one runs the desktop's own engines; the
/// tests put in one of their own.
pub(crate) trait VoiceEngine: Send + Sync {
    fn abilities(&self) -> EngineFuture<Abilities>;
    /// The text of a take. `Err` carries a sentence for the user.
    fn transcribe(&self, wav: Vec<u8>) -> EngineFuture<String>;
    /// A WAV of `text`.
    fn speak(&self, text: String) -> EngineFuture<Vec<u8>>;
}

/// The status of the engines, and when it was asked.
type Kept = Arc<Mutex<Option<(Instant, Abilities)>>>;

/// What the voice routes need from the server state.
#[derive(Clone)]
pub(crate) struct VoiceCtx {
    pub engine: Option<Arc<dyn VoiceEngine>>,
    status: Kept,
}

impl VoiceCtx {
    #[cfg(test)]
    pub(crate) fn new(engine: Option<Arc<dyn VoiceEngine>>) -> Self {
        Self { engine, status: Arc::new(Mutex::new(None)) }
    }

    /// The context of the running server: the desktop's engines, and one kept
    /// status for the whole process (the server builds this per request).
    pub(crate) fn of_desktop(app: Option<&tauri::AppHandle>) -> Self {
        static KEPT: std::sync::OnceLock<Kept> = std::sync::OnceLock::new();
        let engine: Option<Arc<dyn VoiceEngine>> = app.map(|a| Arc::new(DesktopVoice::new(a.clone())) as Arc<dyn VoiceEngine>);
        Self { engine, status: KEPT.get_or_init(|| Arc::new(Mutex::new(None))).clone() }
    }

    async fn abilities(&self) -> Abilities {
        let Some(engine) = &self.engine else {
            return Abilities { listen: false, speak: false };
        };
        if let Some((at, kept)) = *self.status.lock().unwrap() {
            if at.elapsed() < STATUS_KEEP {
                return kept;
            }
        }
        let found = engine.abilities().await.unwrap_or(Abilities { listen: false, speak: false });
        *self.status.lock().unwrap() = Some((Instant::now(), found));
        found
    }

    /// Forget the kept status: after a failed take the next status asks again.
    fn forget(&self) {
        *self.status.lock().unwrap() = None;
    }
}

const NO_LISTEN: &str = "Speech recognition is not set up on the computer. In LU on the computer open Settings, Voice & Remote, and install speech to text, or set up Voice.";
const NO_SPEAK: &str = "The computer has no voice set up for reading aloud.";
const NOT_HERE: &str = "Voice over remote needs the LU desktop app on the computer.";

fn said(status: StatusCode, error: &str, message: &str) -> Response {
    (status, Json(json!({ "error": error, "message": message }))).into_response()
}

/// The status body. `why` names the one thing a phone can tell its user.
pub(crate) fn status_body(a: Abilities, here: bool) -> Value {
    let why = if !here {
        Some(NOT_HERE)
    } else if !a.listen {
        Some(NO_LISTEN)
    } else {
        None
    };
    json!({
        "listen": a.listen,
        "speak": a.speak,
        "max_take_bytes": MAX_TAKE_BYTES,
        "max_take_ms": MAX_TAKE_MS,
        "max_speak_chars": MAX_SPEAK_CHARS,
        "why": why,
    })
}

fn has_caller(caller: &Option<axum::Extension<CallerDevice>>) -> bool {
    caller.is_some()
}

pub(crate) async fn handle_status(AxumState(ctx): AxumState<VoiceCtx>, caller: Option<axum::Extension<CallerDevice>>) -> Response {
    if !has_caller(&caller) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let here = ctx.engine.is_some();
    Json(status_body(ctx.abilities().await, here)).into_response()
}

/// A RIFF/WAVE header, nothing more: the decoder on the other side checks the rest.
pub(crate) fn looks_like_wav(body: &[u8]) -> bool {
    body.len() > 44 && &body[0..4] == b"RIFF" && &body[8..12] == b"WAVE"
}

pub(crate) async fn handle_transcribe(
    AxumState(ctx): AxumState<VoiceCtx>,
    caller: Option<axum::Extension<CallerDevice>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !has_caller(&caller) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(engine) = ctx.engine.clone() else {
        return said(StatusCode::SERVICE_UNAVAILABLE, "unavailable", NOT_HERE);
    };
    if body.len() > MAX_TAKE_BYTES {
        return said(StatusCode::PAYLOAD_TOO_LARGE, "too_long", "The recording is too long. Keep a message under two minutes.");
    }
    let declared = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
    if !declared.is_empty() && !declared.starts_with("audio/wav") && !declared.starts_with("audio/x-wav") && !declared.starts_with("application/octet-stream") {
        return said(StatusCode::UNSUPPORTED_MEDIA_TYPE, "not_wav", "The recording has to be a WAV file.");
    }
    if !looks_like_wav(&body) {
        return said(StatusCode::BAD_REQUEST, "not_wav", "The recording is empty or not a WAV file.");
    }
    if !ctx.abilities().await.listen {
        return said(StatusCode::CONFLICT, "no_listen", NO_LISTEN);
    }
    match engine.transcribe(body.to_vec()).await {
        Ok(text) => Json(json!({ "text": text.trim() })).into_response(),
        Err(why) => {
            ctx.forget();
            said(StatusCode::BAD_GATEWAY, "failed", &why)
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct SpeakBody {
    text: String,
}

pub(crate) async fn handle_speak(
    AxumState(ctx): AxumState<VoiceCtx>,
    caller: Option<axum::Extension<CallerDevice>>,
    body: Result<Json<SpeakBody>, JsonRejection>,
) -> Response {
    if !has_caller(&caller) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(engine) = ctx.engine.clone() else {
        return said(StatusCode::SERVICE_UNAVAILABLE, "unavailable", NOT_HERE);
    };
    let Ok(Json(body)) = body else {
        return said(StatusCode::BAD_REQUEST, "bad_request", "Send the text as JSON: { \"text\": \"…\" }.");
    };
    let text = body.text.trim().to_string();
    if text.is_empty() {
        return said(StatusCode::BAD_REQUEST, "empty", "There is nothing to read aloud.");
    }
    if text.chars().count() > MAX_SPEAK_CHARS {
        return said(StatusCode::PAYLOAD_TOO_LARGE, "too_long", "Send the answer in shorter pieces.");
    }
    if !ctx.abilities().await.speak {
        return said(StatusCode::CONFLICT, "no_speak", NO_SPEAK);
    }
    match engine.speak(text).await {
        Ok(wav) => ([(header::CONTENT_TYPE, "audio/wav"), (header::CACHE_CONTROL, "no-store")], wav).into_response(),
        Err(why) => {
            ctx.forget();
            said(StatusCode::BAD_GATEWAY, "failed", &why)
        }
    }
}

/// The engines of this desktop: faster-whisper for the take, Piper for the answer.
pub(crate) struct DesktopVoice {
    app: tauri::AppHandle,
}

impl DesktopVoice {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

/// The Piper voice to speak in: the default when it is complete, else the first complete one.
fn pick_voice(installed: &[String]) -> Option<String> {
    let default = super::tts::PIPER_VOICE.to_string();
    if installed.contains(&default) {
        return Some(default);
    }
    installed.first().cloned()
}

impl VoiceEngine for DesktopVoice {
    fn abilities(&self) -> EngineFuture<Abilities> {
        let app = self.app.clone();
        Box::pin(async move {
            let listen = super::whisper::whisper_status(app.clone())
                .await
                .ok()
                .and_then(|v| v.get("available").and_then(Value::as_bool))
                .unwrap_or(false);
            let speak = tokio::task::spawn_blocking(move || {
                use tauri::Manager;
                let state = app.state::<crate::state::AppState>();
                super::tts::tts_status(None, state, app.clone())
                    .ok()
                    .and_then(|v| v.get("available").and_then(Value::as_bool))
                    .unwrap_or(false)
            })
            .await
            .unwrap_or(false);
            Ok(Abilities { listen, speak })
        })
    }

    fn transcribe(&self, wav: Vec<u8>) -> EngineFuture<String> {
        let app = self.app.clone();
        Box::pin(async move {
            let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav);
            let answer = super::whisper::transcribe(app, b64, "audio/wav".to_string()).await?;
            if let Some(error) = answer.get("error").and_then(Value::as_str) {
                return Err(error.to_string());
            }
            Ok(answer.get("transcript").and_then(Value::as_str).unwrap_or("").to_string())
        })
    }

    fn speak(&self, text: String) -> EngineFuture<Vec<u8>> {
        let app = self.app.clone();
        Box::pin(async move {
            let installed = super::tts::installed_piper_voices(app.clone()).unwrap_or_default();
            let Some(voice) = pick_voice(&installed) else {
                return Err(NO_SPEAK.to_string());
            };
            let answer = super::tts::synthesize(text, Some(voice), app).await?;
            let b64 = answer.get("audio_base64").and_then(Value::as_str).ok_or("The computer made no sound.")?;
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64).map_err(|_| "The computer made no sound.".to_string())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request, routing::{get, post}, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::ServiceExt;

    struct Fake {
        abilities: Abilities,
        asked: AtomicUsize,
        heard: Mutex<Vec<usize>>,
    }

    impl VoiceEngine for Fake {
        fn abilities(&self) -> EngineFuture<Abilities> {
            self.asked.fetch_add(1, Ordering::SeqCst);
            let a = self.abilities;
            Box::pin(async move { Ok(a) })
        }
        fn transcribe(&self, wav: Vec<u8>) -> EngineFuture<String> {
            self.heard.lock().unwrap().push(wav.len());
            Box::pin(async { Ok("  hello computer  ".to_string()) })
        }
        fn speak(&self, text: String) -> EngineFuture<Vec<u8>> {
            Box::pin(async move { Ok(format!("RIFF....WAVE{text}").into_bytes()) })
        }
    }

    fn fake(listen: bool, speak: bool) -> Arc<Fake> {
        Arc::new(Fake { abilities: Abilities { listen, speak }, asked: AtomicUsize::new(0), heard: Mutex::new(vec![]) })
    }

    fn router(engine: Option<Arc<dyn VoiceEngine>>, signed_in: bool) -> Router {
        let ctx = VoiceCtx::new(engine);
        let r = Router::new()
            .route(STATUS_PATH, get(handle_status))
            // As in remote.rs: the take may be larger than axum's default limit.
            .route(TRANSCRIBE_PATH, post(handle_transcribe).layer(axum::extract::DefaultBodyLimit::max(MAX_TAKE_BYTES + 1)))
            .route(SPEAK_PATH, post(handle_speak))
            .with_state(ctx);
        if signed_in {
            r.layer(axum::middleware::from_fn(|mut req: axum::extract::Request, next: axum::middleware::Next| async move {
                req.extensions_mut().insert(CallerDevice("phone-1".to_string()));
                next.run(req).await
            }))
        } else {
            r
        }
    }

    fn wav(len: usize) -> Vec<u8> {
        let mut v = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
        v.resize(len, 0);
        v
    }

    async fn call(r: Router, method: &str, path: &str, ct: &str, body: Vec<u8>) -> (StatusCode, Vec<u8>) {
        let req = Request::builder().method(method).uri(path).header("content-type", ct).body(Body::from(body)).unwrap();
        let res = r.oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap().to_vec();
        (status, bytes)
    }

    fn json_of(b: &[u8]) -> Value {
        serde_json::from_slice(b).unwrap()
    }

    #[tokio::test]
    async fn every_route_wants_a_known_device() {
        for (m, p) in [("GET", STATUS_PATH), ("POST", TRANSCRIBE_PATH), ("POST", SPEAK_PATH)] {
            let (s, _) = call(router(Some(fake(true, true)), false), m, p, "audio/wav", wav(100)).await;
            assert_eq!(s, StatusCode::UNAUTHORIZED, "{p}");
        }
    }

    #[tokio::test]
    async fn the_status_says_what_the_computer_can_and_why_not() {
        let (s, b) = call(router(Some(fake(true, false)), true), "GET", STATUS_PATH, "", vec![]).await;
        assert_eq!(s, StatusCode::OK);
        let v = json_of(&b);
        assert_eq!(v["listen"], true);
        assert_eq!(v["speak"], false);
        assert_eq!(v["max_take_bytes"], MAX_TAKE_BYTES);
        assert!(v["why"].is_null());

        let v = json_of(&call(router(Some(fake(false, true)), true), "GET", STATUS_PATH, "", vec![]).await.1);
        assert_eq!(v["listen"], false);
        assert!(v["why"].as_str().unwrap().contains("Settings, Voice & Remote"));

        let v = json_of(&call(router(None, true), "GET", STATUS_PATH, "", vec![]).await.1);
        assert_eq!(v["listen"], false);
        assert_eq!(v["why"], NOT_HERE);
    }

    #[tokio::test]
    async fn the_status_is_kept_a_little_while() {
        let engine = fake(true, true);
        let ctx = VoiceCtx::new(Some(engine.clone()));
        ctx.abilities().await;
        ctx.abilities().await;
        assert_eq!(engine.asked.load(Ordering::SeqCst), 1);
        ctx.forget();
        ctx.abilities().await;
        assert_eq!(engine.asked.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_take_comes_back_as_trimmed_text() {
        let engine = fake(true, false);
        let (s, b) = call(router(Some(engine.clone()), true), "POST", TRANSCRIBE_PATH, "audio/wav", wav(3000)).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(json_of(&b)["text"], "hello computer");
        assert_eq!(*engine.heard.lock().unwrap(), vec![3000]);
    }

    #[tokio::test]
    async fn a_take_that_is_no_wav_or_too_long_is_refused_before_the_engine() {
        let engine = fake(true, true);
        let (s, _) = call(router(Some(engine.clone()), true), "POST", TRANSCRIBE_PATH, "audio/wav", b"hello".to_vec()).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        let (s, _) = call(router(Some(engine.clone()), true), "POST", TRANSCRIBE_PATH, "audio/webm", wav(3000)).await;
        assert_eq!(s, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        let (s, b) = call(router(Some(engine.clone()), true), "POST", TRANSCRIBE_PATH, "audio/wav", wav(MAX_TAKE_BYTES + 1)).await;
        assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(json_of(&b)["error"], "too_long");
        assert!(engine.heard.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn without_speech_recognition_the_take_gets_the_reason() {
        let (s, b) = call(router(Some(fake(false, true)), true), "POST", TRANSCRIBE_PATH, "audio/wav", wav(3000)).await;
        assert_eq!(s, StatusCode::CONFLICT);
        assert_eq!(json_of(&b)["error"], "no_listen");
    }

    #[tokio::test]
    async fn speak_answers_a_wav_and_refuses_what_it_cannot() {
        let ok = call(router(Some(fake(true, true)), true), "POST", SPEAK_PATH, "application/json", br#"{"text":" Hi there. "}"#.to_vec()).await;
        assert_eq!(ok.0, StatusCode::OK);
        assert_eq!(ok.1, b"RIFF....WAVEHi there.".to_vec());

        let none = call(router(Some(fake(true, false)), true), "POST", SPEAK_PATH, "application/json", br#"{"text":"Hi"}"#.to_vec()).await;
        assert_eq!(none.0, StatusCode::CONFLICT);
        assert_eq!(json_of(&none.1)["error"], "no_speak");

        let empty = call(router(Some(fake(true, true)), true), "POST", SPEAK_PATH, "application/json", br#"{"text":"   "}"#.to_vec()).await;
        assert_eq!(empty.0, StatusCode::BAD_REQUEST);

        let long = json!({ "text": "a".repeat(MAX_SPEAK_CHARS + 1) }).to_string().into_bytes();
        let long = call(router(Some(fake(true, true)), true), "POST", SPEAK_PATH, "application/json", long).await;
        assert_eq!(long.0, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn the_default_voice_comes_first() {
        assert_eq!(pick_voice(&[]), None);
        assert_eq!(pick_voice(&["de_DE-thorsten-medium".into()]), Some("de_DE-thorsten-medium".into()));
        assert_eq!(pick_voice(&["de_DE-thorsten-medium".into(), super::super::tts::PIPER_VOICE.into()]), Some(super::super::tts::PIPER_VOICE.into()));
    }

    #[test]
    fn the_routes_need_the_right_chat() {
        use super::super::remote_sealed::right_for_path;
        for path in [STATUS_PATH, TRANSCRIBE_PATH, SPEAK_PATH] {
            assert_eq!(right_for_path(path), Some("chat"), "{path}");
        }
    }
}
