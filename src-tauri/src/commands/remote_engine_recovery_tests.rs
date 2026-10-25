use super::{buffered_remote_completion, StatusCode};
use axum::{extract::State, http::HeaderMap, response::IntoResponse, routing::post, Json, Router};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::Mutex;

type Captured = Arc<Mutex<Vec<(serde_json::Value, bool)>>>;

async fn upstream(statuses: Vec<u16>) -> (String, Captured, tokio::task::JoinHandle<()>) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let state = (
        Arc::new(statuses),
        Arc::new(AtomicUsize::new(0)),
        calls.clone(),
    );
    let router = Router::new()
        .route(
            "/v1/chat/completions",
            post(
                |State((statuses, index, calls)): State<(
                    Arc<Vec<u16>>,
                    Arc<AtomicUsize>,
                    Captured,
                )>,
                 headers: HeaderMap,
                 Json(body): Json<serde_json::Value>| async move {
                    calls.lock().await.push((
                        body,
                        headers
                            .get("authorization")
                            .is_some_and(|v| v == "Bearer synthetic-test-key"),
                    ));
                    let attempt = index.fetch_add(1, Ordering::SeqCst);
                    let status =
                        StatusCode::from_u16(statuses[attempt.min(statuses.len() - 1)]).unwrap();
                    if status.is_success() {
                        Json(serde_json::json!({"choices":[{"message":{"content":"recovered"}}]}))
                            .into_response()
                    } else {
                        (status, "synthetic upstream refusal").into_response()
                    }
                },
            ),
        )
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (base, calls, task)
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap()
}

#[test]
fn managed_dispatch_accepts_the_preferred_address_after_a_fallback_engine_crash() {
    let recipe = crate::commands::engine::EngineRecoveryRecipe {
        model_path: "C:/models/fixture.gguf".into(),
        tuning: crate::commands::engine::EngineTuning {
            ctx: 262_144,
            ..Default::default()
        },
        port: 8131,
    };
    for base in ["http://127.0.0.1:8127/v1", "http://localhost:8131/v1"] {
        assert_eq!(
            super::managed_remote_model(base, &recipe).unwrap(),
            recipe.model_path
        );
    }
    for base in [
        "http://192.168.0.60:8127/v1",
        "http://127.0.0.1:1234/v1",
        "https://127.0.0.1:8127/v1",
    ] {
        assert!(
            super::managed_remote_model(base, &recipe).is_err(),
            "must not adopt {base}"
        );
    }
}

#[tokio::test]
async fn managed_inference_retries_once_and_preserves_body_and_authorization() {
    let (base, calls, task) = upstream(vec![503, 200]).await;
    let prepares = AtomicUsize::new(0);
    let body = serde_json::json!({"model":"fixture", "messages":[{"role":"tool","content":"file_list already ran"}], "stream":false});
    let result = buffered_remote_completion(&client(), &body, true, || {
        prepares.fetch_add(1, Ordering::SeqCst);
        std::future::ready(Ok((base.clone(), "synthetic-test-key".into())))
    })
    .await
    .unwrap();
    assert_eq!(result["choices"][0]["message"]["content"], "recovered");
    let calls = calls.lock().await;
    assert_eq!(calls.len(), 2);
    assert_eq!(
        prepares.load(Ordering::SeqCst),
        2,
        "each attempt must recheck native lifecycle/port"
    );
    assert!(calls
        .iter()
        .all(|(sent, authorized)| sent == &body && *authorized));
    task.abort();
}

#[tokio::test]
async fn repeated_gateway_failure_is_bounded_to_two_inference_posts() {
    let (base, calls, task) = upstream(vec![502]).await;
    let result = buffered_remote_completion(&client(), &serde_json::json!({}), true, || {
        std::future::ready(Ok((base.clone(), String::new())))
    })
    .await;
    assert_eq!(result.unwrap_err().0, StatusCode::BAD_GATEWAY);
    assert_eq!(calls.lock().await.len(), 2);
    task.abort();
}

#[tokio::test]
async fn external_provider_gateway_failure_is_never_replayed() {
    let (base, calls, task) = upstream(vec![502, 200]).await;
    let result = buffered_remote_completion(&client(), &serde_json::json!({}), false, || {
        std::future::ready(Ok((base.clone(), String::new())))
    })
    .await;
    assert_eq!(result.unwrap_err().0, StatusCode::BAD_GATEWAY);
    assert_eq!(calls.lock().await.len(), 1);
    task.abort();
}

#[tokio::test]
async fn deterministic_model_error_is_not_retried() {
    let (base, calls, task) = upstream(vec![400, 200]).await;
    let result = buffered_remote_completion(&client(), &serde_json::json!({}), true, || {
        std::future::ready(Ok((base.clone(), String::new())))
    })
    .await;
    assert_eq!(result.unwrap_err().0, StatusCode::BAD_REQUEST);
    assert_eq!(calls.lock().await.len(), 1);
    task.abort();
}

#[tokio::test]
async fn failed_connection_can_follow_the_recovered_engine_to_a_new_port() {
    let dead = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead_base = format!("http://{}/v1", dead.local_addr().unwrap());
    drop(dead);
    let (base, calls, task) = upstream(vec![200]).await;
    let prepares = AtomicUsize::new(0);
    let result = buffered_remote_completion(
        &client(),
        &serde_json::json!({"model":"same-model"}),
        true,
        || {
            let base = if prepares.fetch_add(1, Ordering::SeqCst) == 0 {
                dead_base.clone()
            } else {
                base.clone()
            };
            std::future::ready(Ok((base, String::new())))
        },
    )
    .await;
    assert!(result.is_ok());
    assert_eq!(prepares.load(Ordering::SeqCst), 2);
    assert_eq!(calls.lock().await.len(), 1);
    task.abort();
}

#[tokio::test]
async fn deliberate_stop_prevents_the_retry_from_sending_any_more_inference() {
    let (base, calls, task) = upstream(vec![503, 200]).await;
    let prepares = AtomicUsize::new(0);
    let result = buffered_remote_completion(&client(), &serde_json::json!({}), true, || {
        std::future::ready(if prepares.fetch_add(1, Ordering::SeqCst) == 0 {
            Ok((base.clone(), String::new()))
        } else {
            Err("The LU Engine was deliberately stopped.".into())
        })
    })
    .await;
    assert_eq!(result.unwrap_err().0, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(calls.lock().await.len(), 1);
    task.abort();
}

#[tokio::test]
async fn a_successful_but_invalid_json_response_is_not_replayed() {
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    let router = Router::new().route(
        "/v1/chat/completions",
        post(move || {
            seen.fetch_add(1, Ordering::SeqCst);
            async { "invalid json" }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let result = buffered_remote_completion(&client(), &serde_json::json!({}), true, || {
        std::future::ready(Ok((base.clone(), String::new())))
    })
    .await;
    assert_eq!(result.unwrap_err().0, StatusCode::BAD_GATEWAY);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    task.abort();
}

#[tokio::test]
async fn a_connection_lost_mid_response_is_retried_before_exposing_an_answer() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let broken = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let broken_base = format!("http://{}/v1", broken.local_addr().unwrap());
    let broken_task = tokio::spawn(async move {
        let (mut socket, _) = broken.accept().await.unwrap();
        let mut request = [0u8; 4096];
        assert!(socket.read(&mut request).await.unwrap() > 0, "the relay sent no request");
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 128\r\nConnection: close\r\n\r\n{").await.unwrap();
        socket.shutdown().await.unwrap();
    });
    let (base, calls, task) = upstream(vec![200]).await;
    let prepares = AtomicUsize::new(0);
    let result = buffered_remote_completion(&client(), &serde_json::json!({}), true, || {
        let base = if prepares.fetch_add(1, Ordering::SeqCst) == 0 {
            broken_base.clone()
        } else {
            base.clone()
        };
        std::future::ready(Ok((base, String::new())))
    })
    .await
    .unwrap();
    assert_eq!(result["choices"][0]["message"]["content"], "recovered");
    assert_eq!(prepares.load(Ordering::SeqCst), 2);
    assert_eq!(calls.lock().await.len(), 1);
    broken_task.await.unwrap();
    task.abort();
}
