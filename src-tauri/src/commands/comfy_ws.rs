// WebSocket proxy for the ComfyUI progress stream (2.5.8, GH #75 family).
//
// ComfyUI 0.19+ ships an origin-check middleware (upstream commit 76b75f3)
// that 403s every cross-site request — including the WebView's
// `ws://host:port/ws` upgrade from `http://tauri.localhost`, which killed the
// live progress bar unless the user passed `--enable-cors-header`. HTTP
// already goes through the Rust localhost proxy (no browser Origin header →
// passes); this gives the progress WebSocket the same treatment: the frontend
// asks Rust to open the socket, Rust connects with a plain client handshake
// (tokio-tungstenite sends no Origin) and relays every text frame to the
// WebView as a `comfy-ws-message` Tauri event.
//
// Receive-only by design: the frontend never sends application frames on this
// socket (see src/api/comfyui-ws.ts), so no send command is exposed. Binary
// frames: a live preview image (B28, 3.0.9) goes on as a `comfy-ws-preview`
// event, everything else binary is dropped. Host + port come from
// AppState (same user-validated values the HTTP proxy allow-lists), never
// from the frontend, so this opens no new SSRF surface.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use base64::Engine;
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio_tungstenite::tungstenite::Message;

use crate::state::AppState;

struct ConnHandle {
    generation: u64,
    task: tauri::async_runtime::JoinHandle<()>,
}

/// Single managed upstream connection — mirrors the frontend singleton
/// (`comfyWS` / one CLIENT_ID per app run). A new connect replaces the old
/// socket; generations keep a superseded reader from clobbering its
/// replacement's registration or emitting a stale close event.
static CONN: Lazy<tokio::sync::Mutex<Option<ConnHandle>>> =
    Lazy::new(|| tokio::sync::Mutex::new(None));
static NEXT_GEN: AtomicU64 = AtomicU64::new(1);

/// A live preview from the sampler, as the WebView gets it (B28).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PreviewPayload {
    pub mime: &'static str,
    /// The image, base64.
    pub data: String,
}

/// ComfyUI's PREVIEW_IMAGE frame (server.py `send_image`): a big-endian u32
/// event type 1, a big-endian u32 image type (1 JPEG, 2 PNG), then the image.
/// Anything else, including the metadata variant only sent to clients that
/// announce it, is not a preview here.
pub fn preview_payload(frame: &[u8]) -> Option<PreviewPayload> {
    if frame.len() <= 8 {
        return None;
    }
    let event = u32::from_be_bytes(frame[0..4].try_into().ok()?);
    if event != 1 {
        return None;
    }
    let mime = match u32::from_be_bytes(frame[4..8].try_into().ok()?) {
        1 => "image/jpeg",
        2 => "image/png",
        _ => return None,
    };
    Some(PreviewPayload {
        mime,
        data: base64::engine::general_purpose::STANDARD.encode(&frame[8..]),
    })
}

/// Open (or replace) the proxied ComfyUI progress socket. Resolves once the
/// upstream handshake succeeded — the frontend treats resolution like
/// `ws.onopen` and rejection like `ws.onerror` (falls back to /history
/// polling), so this must always settle; the timeout guarantees that.
#[tauri::command]
pub async fn comfy_ws_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    client_id: String,
) -> Result<(), String> {
    // Read the user-configured target before any await — these are std
    // Mutexes and must not be held across suspension points.
    let (host, port) = {
        let host = state.comfy_host.lock().unwrap().clone();
        let port = *state.comfy_port.lock().unwrap();
        (host, port)
    };
    let url = format!(
        "ws://{}:{}/ws?clientId={}",
        host,
        port,
        urlencoding::encode(&client_id)
    );

    let (stream, _resp) = tokio::time::timeout(
        Duration::from_secs(5),
        tokio_tungstenite::connect_async(&url),
    )
    .await
    .map_err(|_| "ComfyUI WebSocket connect timeout".to_string())?
    .map_err(|e| format!("ComfyUI WebSocket connect failed: {}", e))?;

    let generation = NEXT_GEN.fetch_add(1, Ordering::Relaxed);

    // Hold the registry lock across spawn+insert so the reader's shutdown
    // path (which also takes this lock) can never observe a half-registered
    // connection, even if the socket dies instantly.
    let mut guard = CONN.lock().await;
    if let Some(old) = guard.take() {
        old.task.abort();
    }

    let task = tauri::async_runtime::spawn(async move {
        // The unsplit stream auto-handles ping/pong on poll; we never write.
        let mut stream = stream;
        loop {
            match stream.next().await {
                Some(Ok(Message::Text(text))) => {
                    let _ = app.emit("comfy-ws-message", text.as_str());
                }
                Some(Ok(Message::Binary(bytes))) => {
                    if let Some(preview) = preview_payload(&bytes) {
                        let _ = app.emit("comfy-ws-preview", preview);
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                // Ping/pong, raw frames: intentionally dropped.
                Some(Ok(_)) => {}
            }
        }
        // Announce the close only if this reader is still the live one —
        // a replaced/aborted reader must stay silent so it can't trigger a
        // spurious frontend reconnect against the connection that replaced it.
        let mut guard = CONN.lock().await;
        if guard.as_ref().map(|c| c.generation) == Some(generation) {
            *guard = None;
            let _ = app.emit("comfy-ws-closed", ());
        }
    });

    *guard = Some(ConnHandle { generation, task });
    Ok(())
}

/// Tear down the proxied socket, if any. Deliberately emits no close event:
/// the frontend only calls this from its own `disconnect()`, which already
/// resets its state (mirrors the old `ws.onclose = null; ws.close()`).
#[tauri::command]
pub async fn comfy_ws_disconnect() -> Result<(), String> {
    let mut guard = CONN.lock().await;
    if let Some(old) = guard.take() {
        old.task.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(event: u32, kind: u32, image: &[u8]) -> Vec<u8> {
        let mut v = event.to_be_bytes().to_vec();
        v.extend_from_slice(&kind.to_be_bytes());
        v.extend_from_slice(image);
        v
    }

    #[test]
    fn a_jpeg_preview_goes_on_as_base64() {
        let p = preview_payload(&frame(1, 1, &[0xff, 0xd8, 0xff])).unwrap();
        assert_eq!(p, PreviewPayload { mime: "image/jpeg", data: "/9j/".into() });
        assert_eq!(preview_payload(&frame(1, 2, b"PNG")).unwrap().mime, "image/png");
    }

    #[test]
    fn other_binary_frames_are_not_previews() {
        assert!(preview_payload(&frame(4, 1, b"meta")).is_none());
        assert!(preview_payload(&frame(1, 9, b"x")).is_none());
        assert!(preview_payload(&frame(1, 1, b"")).is_none());
        assert!(preview_payload(&[0, 0, 0]).is_none());
    }
}
