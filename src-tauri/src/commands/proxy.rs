use tauri::Emitter;

/// Validate that an external URL is safe to fetch (no SSRF).
/// Blocks private IP ranges, non-HTTP schemes, and localhost.
fn validate_external_url(raw: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw)
        .map_err(|e| format!("Invalid URL: {}", e))?;

    // Only allow http and https
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Blocked scheme: {}", other)),
    }

    let host = parsed.host_str().unwrap_or("");

    // Block localhost variants
    if host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
        || host == "0.0.0.0" || host.ends_with(".localhost")
    {
        return Err("Blocked: localhost access not allowed for external fetch".into());
    }

    // Block private/reserved IPv4 ranges
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        let octets = ip.octets();
        let blocked = matches!(octets,
            [10, ..] |                                          // 10.0.0.0/8
            [172, 16..=31, ..] |                                // 172.16.0.0/12
            [192, 168, ..] |                                    // 192.168.0.0/16
            [127, ..] |                                         // 127.0.0.0/8
            [169, 254, ..] |                                    // 169.254.0.0/16 (link-local)
            [0, ..]                                             // 0.0.0.0/8
        );
        if blocked {
            return Err(format!("Blocked: private/reserved IP {}", ip));
        }
    }

    // Block private IPv6 (fc00::/7, fe80::/10, ::1)
    if let Ok(ip) = host.trim_matches(|c| c == '[' || c == ']').parse::<std::net::Ipv6Addr>() {
        let segments = ip.segments();
        let blocked = ip.is_loopback()
            || (segments[0] & 0xfe00) == 0xfc00   // fc00::/7 (unique local)
            || (segments[0] & 0xffc0) == 0xfe80;  // fe80::/10 (link-local)
        if blocked {
            return Err(format!("Blocked: private/reserved IPv6 {}", ip));
        }
    }

    Ok(())
}

/// Generic HTTP proxy — fetch any external URL and return body as string.
/// Used for CivitAI API calls, workflow JSON downloads, etc.
#[tauri::command]
pub async fn fetch_external(url: String) -> Result<String, String> {
    validate_external_url(&url)?;

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("fetch_external: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status().as_u16(), url));
    }

    resp.text().await.map_err(|e| e.to_string())
}

/// Binary HTTP proxy — fetch any external URL and return bytes.
/// Used for downloading ZIP files, images, model files.
#[tauri::command]
pub async fn fetch_external_bytes(url: String) -> Result<Vec<u8>, String> {
    validate_external_url(&url)?;

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("fetch_external_bytes: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status().as_u16(), url));
    }

    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

/// Extract the host from `ollama_base` + `comfy_host` so we can allow-list
/// user-configured remote backends through the CORS proxy. Returns a
/// lowercase host string (or empty if the configured URL is malformed).
fn configured_host(url_or_host: &str) -> String {
    // ollama_base is always stored as a full URL (see load_ollama_base); try
    // that parse first.
    if let Ok(u) = url::Url::parse(url_or_host) {
        if let Some(h) = u.host_str() {
            return h.to_lowercase();
        }
    }
    // comfy_host is stored as a bare hostname/IP.
    url_or_host.trim().to_lowercase()
}

/// Validate that a URL targets either localhost or one of the user-configured
/// backend hosts (Ollama via `ollama_base`, ComfyUI via `comfy_host`).
///
/// SSRF policy: the proxy only forwards to hosts the user explicitly pointed
/// LU at. A JS-level compromise still cannot reach arbitrary intranet
/// services; it can only reach the host the user already wanted to reach.
fn validate_proxy_url(raw: &str, state: &crate::state::AppState) -> Result<(), String> {
    let parsed = url::Url::parse(raw)
        .map_err(|e| format!("Invalid URL: {}", e))?;

    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Blocked scheme: {}", other)),
    }

    let host = parsed.host_str().unwrap_or("").to_lowercase();

    // Always-allowed: localhost variants. Covers the common case + any
    // backend bound to 0.0.0.0 on the same machine.
    let is_local = matches!(host.as_str(),
        "localhost" | "127.0.0.1" | "::1" | "[::1]" | "0.0.0.0"
    ) || host.ends_with(".localhost");
    if is_local {
        return Ok(());
    }

    // Configured Ollama host (Issue #31: users with OLLAMA_HOST=192.168.x.x).
    let ollama_host = state.ollama_base.lock()
        .ok()
        .map(|g| configured_host(&g))
        .unwrap_or_default();
    if !ollama_host.is_empty() && host == ollama_host {
        return Ok(());
    }

    // Configured ComfyUI host (v2.3.6 feature).
    let comfy_host = state.comfy_host.lock()
        .ok()
        .map(|g| configured_host(&g))
        .unwrap_or_default();
    if !comfy_host.is_empty() && host == comfy_host {
        return Ok(());
    }

    Err(format!(
        "proxy_localhost: host '{}' not allowed. Configure remote backends via Settings → Providers (Ollama) or Settings → ComfyUI (Host).",
        host
    ))
}

/// Generic localhost proxy — fetch any localhost or configured-backend URL
/// bypassing CORS. Used for Ollama and ComfyUI API calls in production mode.
#[tauri::command]
pub async fn proxy_localhost(url: String, method: Option<String>, body: Option<String>, state: tauri::State<'_, crate::state::AppState>) -> Result<String, String> {
    validate_proxy_url(&url, &state)?;

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let http_method = method.unwrap_or_else(|| "GET".to_string());

    let mut request = match http_method.as_str() {
        "POST" => client.post(&url),
        "DELETE" => client.delete(&url),
        "PUT" => client.put(&url),
        _ => client.get(&url),
    };

    if let Some(body_str) = body {
        request = request.header("Content-Type", "application/json").body(body_str);
    }

    let resp = request
        .send()
        .await
        .map_err(|e| format!("proxy_localhost: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }

    resp.text().await.map_err(|e| e.to_string())
}

/// Streaming localhost proxy — returns raw bytes for streaming responses (Ollama pull/chat).
#[tauri::command]
pub async fn proxy_localhost_stream(url: String, method: Option<String>, body: Option<String>, state: tauri::State<'_, crate::state::AppState>) -> Result<Vec<u8>, String> {
    validate_proxy_url(&url, &state)?;

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(7200))
        .build()
        .map_err(|e| e.to_string())?;

    let http_method = method.unwrap_or_else(|| "GET".to_string());

    let mut request = match http_method.as_str() {
        "POST" => client.post(&url),
        "DELETE" => client.delete(&url),
        "PUT" => client.put(&url),
        _ => client.get(&url),
    };

    if let Some(body_str) = body {
        request = request.header("Content-Type", "application/json").body(body_str);
    }

    let resp = request
        .send()
        .await
        .map_err(|e| format!("proxy_localhost_stream: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }

    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

/// Streaming Ollama model pull — emits per-model progress events.
/// Each event is a JSON object: { "model": "name", "data": { ...ollama progress... } }
#[tauri::command]
pub async fn pull_model_stream(app: tauri::AppHandle, state: tauri::State<'_, crate::state::AppState>, name: String) -> Result<(), String> {
    use futures_util::StreamExt;

    // Create cancellation token for this pull
    let token = tokio_util::sync::CancellationToken::new();
    {
        let mut tokens = state.pull_tokens.lock().unwrap();
        // Cancel any existing pull for same model
        if let Some(old) = tokens.remove(&name) {
            old.cancel();
        }
        tokens.insert(name.clone(), token.clone());
    }

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(7200))
        .build()
        .map_err(|e| e.to_string())?;

    // Route to the configured Ollama base (Issue #31 — was hardcoded
    // http://localhost:11434 so remote Ollama hosts never got the pull).
    let ollama_base = state.ollama_base.lock().ok()
        .map(|g| g.clone())
        .unwrap_or_else(|| "http://localhost:11434".to_string());
    let pull_url = format!("{}/api/pull", ollama_base.trim_end_matches('/'));

    let resp = client
        .post(&pull_url)
        .header("Content-Type", "application/json")
        .body(format!(r#"{{"name":"{}","stream":true}}"#, name))
        .send()
        .await
        .map_err(|e| format!("pull_model_stream: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        state.pull_tokens.lock().unwrap().remove(&name);
        return Err(format!("HTTP {}: {}", status, text));
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    let mut was_cancelled = false;

    loop {
        tokio::select! {
            _ = token.cancelled() => {
                was_cancelled = true;
                break;
            }
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        buffer.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(pos) = buffer.find('\n') {
                            let line = buffer[..pos].trim().to_string();
                            buffer = buffer[pos + 1..].to_string();
                            if !line.is_empty() {
                                // Emit with model name so frontend can route
                                let payload = format!(r#"{{"model":"{}","data":{}}}"#, name, line);
                                let _ = app.emit("pull-progress", &payload);
                            }
                        }
                    }
                    Some(Err(e)) => {
                        let _ = app.emit("pull-progress", &format!(
                            r#"{{"model":"{}","data":{{"status":"Error: {}"}}}}"#, name, e
                        ));
                        break;
                    }
                    None => break, // Stream finished
                }
            }
        }
    }

    // Flush remaining (only if not cancelled)
    if !was_cancelled {
        let remaining = buffer.trim().to_string();
        if !remaining.is_empty() {
            let payload = format!(r#"{{"model":"{}","data":{}}}"#, name, remaining);
            let _ = app.emit("pull-progress", &payload);
        }
    }

    // Cleanup token
    state.pull_tokens.lock().unwrap().remove(&name);

    if was_cancelled {
        Err("cancelled".to_string())
    } else {
        Ok(())
    }
}

/// Cancel an active Ollama model pull
#[tauri::command]
pub fn cancel_model_pull(state: tauri::State<'_, crate::state::AppState>, name: String) -> Result<(), String> {
    let mut tokens = state.pull_tokens.lock().unwrap();
    if let Some(token) = tokens.remove(&name) {
        token.cancel();
        Ok(())
    } else {
        Ok(()) // Already finished or never started
    }
}

/// Proxy search requests to ollama.com (needed because frontend can't CORS to ollama.com)
#[tauri::command]
pub async fn ollama_search(query: String) -> Result<serde_json::Value, String> {
    let url = format!(
        "https://ollama.com/search?q={}&p=1",
        urlencoding::encode(&query)
    );

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Ollama search: {}", e))?;

    let text = resp.text().await.map_err(|e| e.to_string())?;

    // Try to parse as JSON; if it's HTML, return empty results
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(json) => Ok(json),
        Err(_) => Ok(serde_json::json!({"models": []})),
    }
}
