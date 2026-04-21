use std::sync::atomic::Ordering;
use tauri::State;

use crate::state::AppState;

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

async fn try_searxng(query: &str, count: usize) -> Result<Vec<SearchResult>, String> {
    let url = format!(
        "http://localhost:8888/search?q={}&format=json&engines=google,duckduckgo,brave&categories=general",
        urlencoding::encode(query)
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("SearXNG: {}", e))?;

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let results = json.get("results")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .take(count)
                .filter_map(|r| {
                    Some(SearchResult {
                        title: r.get("title")?.as_str()?.to_string(),
                        url: r.get("url")?.as_str()?.to_string(),
                        snippet: r.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(results)
}

async fn try_ddg(query: &str, count: usize) -> Result<Vec<SearchResult>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.post("https://html.duckduckgo.com/html/")
        .form(&[("q", query)])
        .send()
        .await
        .map_err(|e| format!("DDG: {}", e))?;

    let html = resp.text().await.map_err(|e| e.to_string())?;

    // Parse results — capture full inner HTML then strip tags
    let title_re = regex::Regex::new(r#"class="result__a"[^>]*>(.*?)</a>"#).unwrap();
    let url_re = regex::Regex::new(r#"class="result__url"[^>]*?href="([^"]*)"#).unwrap();
    let snippet_re = regex::Regex::new(r#"class="result__snippet"[^>]*>([\s\S]*?)</(?:td|div|a\s)"#).unwrap();

    let titles: Vec<String> = title_re.captures_iter(&html)
        .map(|c| html_decode(&strip_html(&c[1])))
        .collect();
    let urls: Vec<String> = url_re.captures_iter(&html)
        .map(|c| {
            let raw = &c[1];
            // DDG wraps URLs — extract actual URL from redirect
            if let Some(pos) = raw.find("uddg=") {
                let after = &raw[pos + 5..];
                urlencoding::decode(after.split('&').next().unwrap_or(after))
                    .unwrap_or_else(|_| after.into())
                    .to_string()
            } else {
                raw.to_string()
            }
        })
        .collect();
    let snippets: Vec<String> = snippet_re.captures_iter(&html)
        .map(|c| html_decode(&strip_html(&c[1])).trim().to_string())
        .collect();

    let mut results = Vec::new();
    for i in 0..titles.len().min(count) {
        let url = urls.get(i).cloned().unwrap_or_default();
        let snippet = snippets.get(i).cloned().unwrap_or_default();
        if !url.is_empty() {
            results.push(SearchResult {
                title: titles[i].clone(),
                url,
                snippet,
            });
        }
    }

    if results.is_empty() {
        Err("No DDG results".to_string())
    } else {
        Ok(results)
    }
}

async fn try_wikipedia(query: &str, count: usize) -> Result<Vec<SearchResult>, String> {
    let url = format!(
        "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={}&format=json&srlimit={}",
        urlencoding::encode(query), count
    );

    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Wikipedia: {}", e))?;

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let results: Vec<SearchResult> = json.pointer("/query/search")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let title = r.get("title")?.as_str()?;
                    Some(SearchResult {
                        title: title.to_string(),
                        url: format!("https://en.wikipedia.org/wiki/{}", urlencoding::encode(title)),
                        snippet: r.get("snippet").and_then(|s| s.as_str())
                            .map(|s| html_decode(&strip_html(s)))
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    if results.is_empty() {
        Err("No Wikipedia results".to_string())
    } else {
        Ok(results)
    }
}

fn html_decode(s: &str) -> String {
    s.replace("&amp;", "&")
     .replace("&lt;", "<")
     .replace("&gt;", ">")
     .replace("&quot;", "\"")
     .replace("&#39;", "'")
     .replace("&#x27;", "'")
     .replace("&apos;", "'")
     .replace("&nbsp;", " ")
}

fn strip_html(s: &str) -> String {
    let re = regex::Regex::new(r"<[^>]+>").unwrap();
    re.replace_all(s, "").to_string()
}

#[tauri::command]
pub async fn web_search(
    query: String,
    count: Option<usize>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let count = count.unwrap_or(5);

    // Try SearXNG first
    if state.searxng_available.load(Ordering::Relaxed) {
        if let Ok(results) = try_searxng(&query, count).await {
            return Ok(serde_json::json!({"results": results}));
        }
    }

    // Fallback to DuckDuckGo
    if let Ok(results) = try_ddg(&query, count).await {
        return Ok(serde_json::json!({"results": results}));
    }

    // Fallback to Wikipedia
    if let Ok(results) = try_wikipedia(&query, count).await {
        return Ok(serde_json::json!({"results": results}));
    }

    Ok(serde_json::json!({"results": [], "error": "All search tiers failed"}))
}

#[tauri::command]
pub async fn search_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let available = client.get("http://localhost:8888")
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);

    state.searxng_available.store(available, Ordering::Relaxed);

    Ok(serde_json::json!({"searxng": available}))
}

#[tauri::command]
pub fn install_searxng(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut install = state.searxng_install.lock().unwrap();
    if install.status == "installing" {
        return Ok(serde_json::json!({"status": "already_installing"}));
    }

    install.status = "installing".to_string();
    install.logs.clear();
    install.logs.push("Pulling SearXNG Docker image...".to_string());
    drop(install);

    // Run docker pull + run in background.
    // On Windows we add CREATE_NO_WINDOW so the docker CLI doesn't flash a
    // console window at the user when they install SearXNG from LU.
    std::thread::spawn(move || {
        #[cfg(windows)]
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let mut pull_cmd = std::process::Command::new("docker");
        pull_cmd.args(["pull", "searxng/searxng"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            pull_cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let pull = pull_cmd.output();

        match pull {
            Ok(output) if output.status.success() => {
                let mut run_cmd = std::process::Command::new("docker");
                run_cmd.args([
                    "run", "-d", "--name", "searxng",
                    "-p", "8888:8080",
                    "-e", "INSTANCE_NAME=locally-uncensored",
                    "searxng/searxng",
                ]);
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    run_cmd.creation_flags(CREATE_NO_WINDOW);
                }
                let _ = run_cmd.output();
                println!("[SearXNG] Installed and running on port 8888");
            }
            _ => {
                println!("[SearXNG] Docker pull failed. Is Docker installed?");
            }
        }
    });

    Ok(serde_json::json!({"status": "installing"}))
}

#[tauri::command]
pub fn searxng_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let install = state.searxng_install.lock().unwrap();
    Ok(serde_json::json!({
        "status": install.status,
        "logs": install.logs,
    }))
}

/// Fetch a URL and return plain readable text. The agent loop calls this
/// AFTER `web_search` to actually read a page — without it, the model
/// only ever sees titles + snippets which is useless for anything
/// research-heavy. Strips HTML aggressively:
///   - Drops <script>, <style>, <nav>, <header>, <footer>, <aside>, <noscript>
///   - Replaces block-level tags with newlines
///   - Removes remaining tags
///   - Collapses whitespace
///   - Caps at ~24 000 chars so we don't blow the context window
#[tauri::command]
pub async fn web_fetch(url: String) -> Result<serde_json::Value, String> {
    // Basic URL hardening: must start http(s) and not point at localhost /
    // private IPs. The agent should fetch public pages, not poke internal
    // services (Ollama, ComfyUI, LAN boxes).
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("URL must start with http:// or https://".into());
    }
    let lower = trimmed.to_lowercase();
    if lower.contains("://localhost")
        || lower.contains("://127.")
        || lower.contains("://0.0.0.0")
        || lower.contains("://10.")
        || lower.contains("://192.168.")
        || lower.contains("://169.254.")
    {
        return Err("Refusing to fetch private / loopback addresses from the agent.".into());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(6))
        .user_agent("Mozilla/5.0 (compatible; LocallyUncensored-Agent/1.0)")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(trimmed)
        .header("Accept", "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.5")
        .header("Accept-Language", "en,de;q=0.8")
        .send()
        .await
        .map_err(|e| format!("Fetch failed: {}", e))?;

    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let raw = resp
        .text()
        .await
        .map_err(|e| format!("Read body failed: {}", e))?;

    let (title, text) = extract_readable_text(&raw, &content_type);
    let capped: String = text.chars().take(24_000).collect();

    Ok(serde_json::json!({
        "url": final_url,
        "status": status,
        "contentType": content_type,
        "title": title,
        "text": capped,
        "truncated": text.chars().count() > 24_000,
    }))
}

/// Convert a raw HTML (or plain) body into readable text + try to grab the
/// <title> tag. Not a perfect readability engine, but enough to give the
/// agent real substance instead of just a snippet.
fn extract_readable_text(body: &str, content_type: &str) -> (String, String) {
    // Not HTML? Treat as plain text.
    if !content_type.contains("html") && !body.trim_start().to_lowercase().starts_with("<!doctype") && !body.contains("<html") {
        let text = collapse_whitespace(body);
        return (String::new(), text);
    }

    // Title
    let title = capture_first(body, "<title", "</title>")
        .map(|t| html_decode(&strip_tags(&t)).trim().to_string())
        .unwrap_or_default();

    // Drop noisy sections entirely
    let mut cleaned = body.to_string();
    for tag in &["script", "style", "noscript", "svg", "header", "footer", "nav", "aside", "form", "template"] {
        cleaned = strip_block_tag(&cleaned, tag);
    }

    // Replace common block-level tags with newlines so paragraph boundaries survive
    for tag in &[
        "</p>", "</div>", "</li>", "</h1>", "</h2>", "</h3>", "</h4>", "</h5>", "</h6>",
        "</section>", "</article>", "</blockquote>", "</pre>", "<br>", "<br/>", "<br />",
    ] {
        cleaned = cleaned.replace(tag, &format!("{}\n", tag));
    }

    // Remove all remaining tags
    let no_tags = strip_tags(&cleaned);
    let decoded = html_decode(&no_tags);
    let text = collapse_whitespace(&decoded);
    (title, text)
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        if ch == '<' { in_tag = true; continue; }
        if ch == '>' { in_tag = false; continue; }
        if !in_tag { out.push(ch); }
    }
    out
}

fn strip_block_tag(s: &str, tag: &str) -> String {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        match rest.to_lowercase().find(&open) {
            Some(start_idx) => {
                out.push_str(&rest[..start_idx]);
                let after = &rest[start_idx..];
                match after.to_lowercase().find(&close) {
                    Some(end_rel) => {
                        rest = &after[end_rel + close.len()..];
                    }
                    None => break,
                }
            }
            None => {
                out.push_str(rest);
                break;
            }
        }
    }
    out
}

fn capture_first<'a>(s: &'a str, open: &str, close: &str) -> Option<String> {
    let lower = s.to_lowercase();
    let start = lower.find(&open.to_lowercase())?;
    let rest = &s[start..];
    let open_end = rest.find('>')? + 1;
    let inner = &rest[open_end..];
    let end = inner.to_lowercase().find(&close.to_lowercase())?;
    Some(inner[..end].to_string())
}

fn collapse_whitespace(s: &str) -> String {
    // Preserve paragraph breaks (2+ newlines) but collapse runs of spaces.
    let mut out = String::with_capacity(s.len());
    let mut newline_run = 0;
    let mut space_run = false;
    for ch in s.chars() {
        if ch == '\n' || ch == '\r' {
            newline_run += 1;
            space_run = false;
            if newline_run <= 2 { out.push('\n'); }
        } else if ch == '\t' || ch == ' ' {
            newline_run = 0;
            if !space_run { out.push(' '); space_run = true; }
        } else {
            newline_run = 0;
            space_run = false;
            out.push(ch);
        }
    }
    out.trim().to_string()
}
