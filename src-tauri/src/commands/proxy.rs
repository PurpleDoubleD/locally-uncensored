/// Generic HTTP proxy — fetch any external URL and return body as string.
/// Used for CivitAI API calls, workflow JSON downloads, etc.
#[tauri::command]
pub async fn fetch_external(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/1.5")
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
    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/1.5")
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

/// Proxy search requests to ollama.com (needed because frontend can't CORS to ollama.com)
#[tauri::command]
pub async fn ollama_search(query: String) -> Result<serde_json::Value, String> {
    let url = format!(
        "https://ollama.com/search?q={}&p=1",
        urlencoding::encode(&query)
    );

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/1.3")
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
