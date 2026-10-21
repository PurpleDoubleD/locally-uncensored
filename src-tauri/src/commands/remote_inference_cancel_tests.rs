use super::*;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn state(base: &str, backend: &str) -> RemoteState {
    let server = RemoteServer::new();
    RemoteState {
        inference_calls: crate::cancel_registry::CancelRegistry::new(),
        memory_revoked: server.memory_revoked.clone(),
        jwt_secret: server.jwt_secret.clone(),
        passcode: server.passcode.clone(),
        ollama_base: base.into(),
        backend_kind: backend.into(),
        openai_base: format!("{base}/v1"),
        openai_key: String::new(),
        managed_engine_model: None,
        comfy_port: 0,
        comfy_host: "127.0.0.1".into(),
        permissions: server.permissions.clone(),
        connected_devices: server.connected_devices.clone(),
        tunnel_url: server.tunnel_url.clone(),
        dispatched_model: server.dispatched_model.clone(),
        dispatched_system_prompt: server.dispatched_system_prompt.clone(),
        page_title: server.page_title.clone(),
        app_handle: RemoteDesktop::unavailable(),
    }
}

async fn cancel(state: RemoteState, owner: &str, id: &str) -> Response {
    handle_cancel_inference(
        AxumState(state),
        Some(axum::Extension(CallerDevice(owner.into()))),
        Json(CancelInferenceRequest { id: id.into() }),
    )
    .await
}

fn request(owner: &str, id: &str) -> Request {
    let mut req = Request::builder()
        .method(Method::POST)
        .uri("/api/chat")
        .header("x-lu-inference-id", id)
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"model":"m","messages":[{"role":"user","content":"hello"}],"stream":false}"#,
        ))
        .unwrap();
    req.extensions_mut().insert(CallerDevice(owner.into()));
    req
}

// Send headers but never finish the completion body. A cancelled relay must
// close this socket; merely hiding the browser's reply would leave it open.
async fn hanging_upstream() -> (
    String,
    tokio::sync::oneshot::Receiver<()>,
    tokio::task::JoinHandle<bool>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (ready, started) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = [0; 8192];
        socket.read(&mut buf).await.unwrap();
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n\r\n{").await.unwrap();
        let _ = ready.send(());
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                match socket.read(&mut buf).await {
                    Ok(0) | Err(_) => return true,
                    Ok(_) => {}
                }
            }
        })
        .await
        .unwrap_or(false)
    });
    (base, started, task)
}

#[tokio::test]
async fn stop_closes_openai_and_ollama_upstreams_and_is_scoped_to_the_paired_device() {
    for backend in ["openai", "ollama"] {
        let (base, started, upstream) = hanging_upstream().await;
        let state = state(&base, backend);
        let proxy_state = state.clone();
        let proxy = tokio::spawn(async move {
            proxy_ollama(AxumState(proxy_state), request("phone-a", "run_1")).await
        });
        tokio::time::timeout(Duration::from_secs(3), started)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            cancel(state.clone(), "phone-b", "run_1").await.status(),
            StatusCode::OK
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            !proxy.is_finished(),
            "a different paired device cancelled the call"
        );
        assert_eq!(
            cancel(state, "phone-a", "run_1").await.status(),
            StatusCode::OK
        );
        let response = tokio::time::timeout(Duration::from_secs(3), proxy)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
        assert!(
            upstream.await.unwrap(),
            "{backend} kept its upstream socket after Stop"
        );
    }
}

#[tokio::test]
async fn cancel_before_registration_never_starts_inference() {
    let state = state("http://127.0.0.1:1", "openai");
    let mut legacy = request("phone-a", "legacy_1");
    legacy.headers_mut().remove("x-lu-inference-id");
    assert_eq!(
        proxy_ollama(AxumState(state.clone()), legacy)
            .await
            .status(),
        StatusCode::BAD_GATEWAY,
        "a legacy request must still reach its backend"
    );
    assert_eq!(
        cancel(state.clone(), "phone-a", "early_1").await.status(),
        StatusCode::OK
    );
    let response = proxy_ollama(AxumState(state), request("phone-a", "early_1")).await;
    assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
}

#[tokio::test]
async fn cancelled_managed_completion_drops_the_request_without_recovery_retry() {
    let (base, started, upstream) = hanging_upstream().await;
    let calls = crate::cancel_registry::CancelRegistry::new();
    let registry = calls.clone();
    let key = inference_key("phone-a", "managed_1");
    let running_key = key.clone();
    let targets = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = targets.clone();
    let running = tokio::spawn(async move {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let body = serde_json::json!({"model":"m","messages":[]});
        cancellable_inference(&registry, running_key, async {
            buffered_remote_completion(&client, &body, true, || {
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                std::future::ready(Ok((format!("{base}/v1"), String::new())))
            })
            .await
            .map(Json)
            .map(IntoResponse::into_response)
            .unwrap_or_else(IntoResponse::into_response)
        })
        .await
    });
    tokio::time::timeout(Duration::from_secs(3), started)
        .await
        .unwrap()
        .unwrap();
    calls.cancel(&key);
    assert_eq!(running.await.unwrap().status(), StatusCode::REQUEST_TIMEOUT);
    assert!(upstream.await.unwrap());
    assert_eq!(targets.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn successful_inference_cleans_registration_and_invalid_cancel_is_refused() {
    let calls = crate::cancel_registry::CancelRegistry::new();
    let key = inference_key("phone-a", "ok_1");
    let response = cancellable_inference(&calls, key.clone(), async {
        StatusCode::OK.into_response()
    })
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    // Cancelling after completion leaves an early-cancel tombstone for a fresh
    // registration, rather than cancelling a stale completed token.
    calls.cancel(&key);
    let response =
        cancellable_inference(&calls, key, async { StatusCode::OK.into_response() }).await;
    assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
    let state = state("http://127.0.0.1:1", "openai");
    assert_eq!(
        proxy_ollama(AxumState(state.clone()), request("phone-a", "bad.id"))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        handle_cancel_inference(
            AxumState(state),
            None,
            Json(CancelInferenceRequest { id: "ok_2".into() })
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[test]
fn cancellation_keys_are_bounded_and_unambiguous() {
    for id in ["", "space here", "line\nbreak", "🦙", &"a".repeat(129)] {
        assert!(!valid_inference_id(id));
    }
    assert!(valid_inference_id("c-123_4"));
    assert_ne!(inference_key("a:b", "c"), inference_key("a", "b:c"));
}
