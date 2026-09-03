use crate::os_error;
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
        .map_err(|e| format!("SearXNG: {}", os_error::english(&e)))?;

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
        .map_err(|e| format!("DDG: {}", os_error::english(&e)))?;

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
    for (i, title) in titles.iter().take(count).enumerate() {
        let url = urls.get(i).cloned().unwrap_or_default();
        let snippet = snippets.get(i).cloned().unwrap_or_default();
        if !url.is_empty() {
            results.push(SearchResult {
                title: title.clone(),
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

/// Parse a Brave Search API response body into results. Split out of
/// `try_brave` so the shape mapping is unit-testable without network.
fn parse_brave_results(json: &serde_json::Value, count: usize) -> Vec<SearchResult> {
    json.pointer("/web/results")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .take(count)
                .filter_map(|r| {
                    Some(SearchResult {
                        title: html_decode(&strip_html(r.get("title")?.as_str()?)),
                        url: r.get("url")?.as_str()?.to_string(),
                        snippet: r
                            .get("description")
                            .and_then(|d| d.as_str())
                            .map(|d| html_decode(&strip_html(d)))
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Brave Search API (paid/free-tier key from Settings → Agent → Search
/// Provider). The settings fields existed since v2.4 but were never wired
/// into this command — the key was silently ignored (same bug class as
/// GitHub #59's silent reset button). Now: explicit provider support.
async fn try_brave(query: &str, count: usize, api_key: &str) -> Result<Vec<SearchResult>, String> {
    let url = format!(
        "https://api.search.brave.com/res/v1/web/search?q={}&count={}",
        urlencoding::encode(query),
        count.min(20)
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .header("X-Subscription-Token", api_key)
        .send()
        .await
        .map_err(|e| format!("Brave: {}", os_error::english(&e)))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Brave: HTTP {} (check the API key)", status.as_u16()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| format!("Brave: {}", e))?;
    let results = parse_brave_results(&json, count);
    if results.is_empty() {
        Err("Brave: no results".to_string())
    } else {
        Ok(results)
    }
}

/// Parse a Tavily API response body into results (unit-testable, no network).
fn parse_tavily_results(json: &serde_json::Value, count: usize) -> Vec<SearchResult> {
    json.get("results")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .take(count)
                .filter_map(|r| {
                    Some(SearchResult {
                        title: r.get("title")?.as_str()?.to_string(),
                        url: r.get("url")?.as_str()?.to_string(),
                        snippet: r
                            .get("content")
                            .and_then(|c| c.as_str())
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Tavily search API. Key in the JSON body (legacy) AND as Bearer header
/// (current docs) — both are accepted by Tavily, covering old + new plans.
async fn try_tavily(query: &str, count: usize, api_key: &str) -> Result<Vec<SearchResult>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post("https://api.tavily.com/search")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&serde_json::json!({
            "api_key": api_key,
            "query": query,
            "max_results": count.min(20),
        }))
        .send()
        .await
        .map_err(|e| format!("Tavily: {}", os_error::english(&e)))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Tavily: HTTP {} (check the API key)", status.as_u16()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| format!("Tavily: {}", e))?;
    let results = parse_tavily_results(&json, count);
    if results.is_empty() {
        Err("Tavily: no results".to_string())
    } else {
        Ok(results)
    }
}

/// Traegt der Text deutsche Signale? Umlaute und ss zaehlen sofort, danach
/// haeufige Funktionswoerter, danach typische Endungen von Fachwoertern.
///
/// Der Anlass, gemessen am 04.09.2026: „Transparenzgesetz Hamburg
/// Antragsfristen" ergibt auf en.wikipedia 0 Treffer und auf de.wikipedia 31
/// (verkuerzt auf die ersten beiden Begriffe). Zusammen mit DuckDuckGos
/// Bot-Sperre (HTTP 202 auf `html.` UND `lite.`) hatte eine deutsche
/// Recherche damit keine einzige funktionierende Suchstufe mehr.
pub fn sprach_signal_deutsch(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }
    if t.chars().any(|c| matches!(c, 'ä' | 'ö' | 'ü' | 'ß' | 'Ä' | 'Ö' | 'Ü')) {
        return true;
    }
    let klein = t.to_lowercase();
    const WOERTER: &[&str] = &[
        "der", "die", "das", "des", "dem", "den", "und", "oder", "nicht", "welche", "welcher",
        "wie", "was", "wer", "wann", "warum", "von", "vom", "zum", "zur", "fuer", "ueber",
        "mit", "nach", "bei", "auf", "aus", "ein", "eine", "einer", "einem", "ist", "sind",
        "war", "waren", "wird", "werden", "kann", "koennen", "muss", "soll", "gibt", "sich",
    ];
    if klein.split_whitespace().any(|w| WOERTER.contains(&w)) {
        return true;
    }
    const ENDUNGEN: &[&str] = &[
        "gesetz", "gesetze", "gesetzes", "fristen", "frist", "ordnung", "verordnung",
        "pflicht", "pflichten", "recht", "rechte", "antrag", "verfahren", "verwaltung",
        "gebuehren", "kammer",
    ];
    klein
        .split_whitespace()
        .any(|w| w.len() > 6 && ENDUNGEN.iter().any(|e| w.ends_with(e)))
}

/// Die Anfragen, die die Wikipedia-Stufe der Reihe nach versucht:
/// (Sprache, Suchbegriffe). Gekuerzt wird von hinten, weil Wikipedia die
/// Begriffe UND-verknuepft und der letzte ueblicherweise die engste
/// Einschraenkung ist; nie unter zwei Begriffe, und hoechstens vier Versuche —
/// die letzte Rettungsstufe darf keine Suchmaschine werden.
pub fn wiki_versuche(query: &str, max_versuche: usize) -> Vec<(&'static str, String)> {
    let begriffe: Vec<&str> = query.split_whitespace().filter(|w| !w.is_empty()).collect();
    if begriffe.is_empty() {
        return Vec::new();
    }
    let mut varianten = vec![begriffe.join(" ")];
    let mut n = begriffe.len().saturating_sub(1);
    while n >= 2 {
        varianten.push(begriffe[..n].join(" "));
        n -= 1;
    }
    let sprachen: [&'static str; 2] = if sprach_signal_deutsch(query) {
        ["de", "en"]
    } else {
        ["en", "de"]
    };
    let mut out = Vec::new();
    for sprache in sprachen {
        for v in &varianten {
            out.push((sprache, v.clone()));
            if out.len() >= max_versuche {
                return out;
            }
        }
    }
    out
}

async fn try_wikipedia(query: &str, count: usize) -> Result<Vec<SearchResult>, String> {
    let mut letzter = "No Wikipedia results".to_string();
    for (sprache, anfrage) in wiki_versuche(query, 4) {
        match try_wikipedia_einmal(sprache, &anfrage, count).await {
            Ok(r) => return Ok(r),
            Err(e) => letzter = e,
        }
    }
    Err(letzter)
}

async fn try_wikipedia_einmal(
    sprache: &str,
    query: &str,
    count: usize,
) -> Result<Vec<SearchResult>, String> {
    let url = format!(
        "https://{}.wikipedia.org/w/api.php?action=query&list=search&srsearch={}&format=json&srlimit={}",
        sprache, urlencoding::encode(query), count
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Wikipedia: {}", os_error::english(&e)))?;

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let results: Vec<SearchResult> = json.pointer("/query/search")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let title = r.get("title")?.as_str()?;
                    Some(SearchResult {
                        title: title.to_string(),
                        // Die Adresse MUSS die gefragte Sprachwiki tragen: ein
                        // Treffer aus de.wikipedia unter einer en-Adresse ist ein
                        // 404, das wie ein Beleg aussieht (nachgemessen).
                        url: format!("https://{}.wikipedia.org/wiki/{}", sprache, urlencoding::encode(title)),
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
    provider: Option<String>,
    brave_api_key: Option<String>,
    tavily_api_key: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let count = count.unwrap_or(5);
    let provider = provider.unwrap_or_else(|| "auto".to_string());
    let brave_key = brave_api_key.unwrap_or_default();
    let tavily_key = tavily_api_key.unwrap_or_default();

    // The frontend has offered Brave / Tavily in Settings → Agent → Search
    // Provider since v2.4, but this command silently dropped the choice and
    // always ran the free tiers. Honor it now:
    //   - explicit 'brave' / 'tavily' → use that provider; on failure fall
    //     back to the free tiers but surface why in `providerError`.
    //   - 'auto' → paid provider first when a key is configured, then the
    //     free tiers (SearXNG → DuckDuckGo → Wikipedia).
    let mut provider_error: Option<String> = None;

    match provider.as_str() {
        "brave" => {
            if brave_key.is_empty() {
                provider_error = Some(
                    "Brave Search is selected but no API key is configured (Settings → Agent → Search Provider).".to_string(),
                );
            } else {
                match try_brave(&query, count, &brave_key).await {
                    Ok(results) => return Ok(serde_json::json!({"results": results, "provider": "brave"})),
                    Err(e) => provider_error = Some(e),
                }
            }
        }
        "tavily" => {
            if tavily_key.is_empty() {
                provider_error = Some(
                    "Tavily is selected but no API key is configured (Settings → Agent → Search Provider).".to_string(),
                );
            } else {
                match try_tavily(&query, count, &tavily_key).await {
                    Ok(results) => return Ok(serde_json::json!({"results": results, "provider": "tavily"})),
                    Err(e) => provider_error = Some(e),
                }
            }
        }
        _ => {
            // auto: a configured key signals intent — prefer that provider.
            if !brave_key.is_empty() {
                if let Ok(results) = try_brave(&query, count, &brave_key).await {
                    return Ok(serde_json::json!({"results": results, "provider": "brave"}));
                }
            }
            if !tavily_key.is_empty() {
                if let Ok(results) = try_tavily(&query, count, &tavily_key).await {
                    return Ok(serde_json::json!({"results": results, "provider": "tavily"}));
                }
            }
        }
    }

    // Free tiers. Reached directly in 'auto' or as fallback after a paid
    // provider failed (provider_error carries the reason to the model).
    let attach = |mut v: serde_json::Value| {
        if let Some(err) = &provider_error {
            v["providerError"] = serde_json::json!(err);
        }
        v
    };

    // Try SearXNG first
    if state.searxng_available.load(Ordering::Relaxed) {
        if let Ok(results) = try_searxng(&query, count).await {
            return Ok(attach(serde_json::json!({"results": results, "provider": "searxng"})));
        }
    }

    // Fallback to DuckDuckGo
    if let Ok(results) = try_ddg(&query, count).await {
        return Ok(attach(serde_json::json!({"results": results, "provider": "duckduckgo"})));
    }

    // Fallback to Wikipedia
    if let Ok(results) = try_wikipedia(&query, count).await {
        return Ok(attach(serde_json::json!({"results": results, "provider": "wikipedia"})));
    }

    // Was hier steht, muss dem Nutzer sagen, was er tun kann. Eine Persona las
    // am 03.09.2026 nur „All search tiers failed" und konnte daraus nicht
    // schliessen, dass ein API-Schluessel die Kette wieder ganz macht — das
    // Modell konnte es auch nicht und erfand stattdessen eine Tabelle.
    let hinweis = if brave_key.is_empty() && tavily_key.is_empty() {
        "All search tiers failed. The free tiers are unreliable (DuckDuckGo answers automated requests with a bot check). Configure Brave or Tavily under Settings → Agent → Search Provider for dependable search."
    } else {
        "All search tiers failed"
    };
    Ok(attach(serde_json::json!({"results": [], "error": hinweis})))
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
    // URL hardening: http(s) only and the host must not be localhost, a
    // private/reserved range, or a cloud-metadata endpoint. The agent should
    // fetch public pages, not poke internal services (Ollama, ComfyUI, LAN
    // boxes, 169.254.169.254). Reuse the shared SSRF validator — the old
    // substring blocklist missed 172.16/12, IPv6, and decimal/hex/octal IP
    // encodings, and didn't re-check redirects.
    let trimmed = url.trim();
    crate::commands::proxy::validate_public_url(trimmed)?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(crate::commands::proxy::ssrf_safe_redirect_policy(6))
        .user_agent("Mozilla/5.0 (compatible; LocallyUncensored-Agent/1.0)")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(trimmed)
        .header("Accept", "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.5")
        .header("Accept-Language", "en,de;q=0.8")
        .send()
        .await
        .map_err(|e| format!("Fetch failed: {}", os_error::english(&e)))?;

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

/// Case-insensitive search for an ASCII needle, returning a byte index that is
/// valid in `haystack` itself. `to_lowercase()` changes byte length for some
/// characters (ẞ is 3 bytes and lowercases to 2, İ is 2 and lowercases to 3),
/// so an index taken from a lowercased copy cuts the original in the wrong
/// place — or panics when it lands inside a character.
fn find_ascii_ci(haystack: &str, needle: &str) -> Option<usize> {
    let n = needle.as_bytes();
    if n.is_empty() {
        return Some(0);
    }
    haystack
        .as_bytes()
        .windows(n.len())
        .position(|w| w.eq_ignore_ascii_case(n))
}

fn strip_block_tag(s: &str, tag: &str) -> String {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        match find_ascii_ci(rest, &open) {
            Some(start_idx) => {
                out.push_str(&rest[..start_idx]);
                let after = &rest[start_idx..];
                match find_ascii_ci(after, &close) {
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

fn capture_first(s: &str, open: &str, close: &str) -> Option<String> {
    let start = find_ascii_ci(s, open)?;
    let rest = &s[start..];
    let open_end = rest.find('>')? + 1;
    let inner = &rest[open_end..];
    let end = find_ascii_ci(inner, close)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brave_parses_web_results() {
        let json: serde_json::Value = serde_json::json!({
            "web": { "results": [
                { "title": "Rust <strong>lang</strong>", "url": "https://rust-lang.org", "description": "A &amp; B systems language" },
                { "title": "Second", "url": "https://example.com", "description": "More" },
                { "title": "Third", "url": "https://third.example" }
            ]}
        });
        let r = parse_brave_results(&json, 2);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].title, "Rust lang");
        assert_eq!(r[0].url, "https://rust-lang.org");
        assert_eq!(r[0].snippet, "A & B systems language");
    }

    #[test]
    fn brave_missing_description_is_empty_snippet() {
        let json: serde_json::Value = serde_json::json!({
            "web": { "results": [ { "title": "T", "url": "https://x.example" } ] }
        });
        let r = parse_brave_results(&json, 5);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].snippet, "");
    }

    #[test]
    fn brave_unexpected_shape_yields_empty() {
        let json: serde_json::Value = serde_json::json!({ "message": "invalid key" });
        assert!(parse_brave_results(&json, 5).is_empty());
    }

    #[test]
    fn tavily_parses_results() {
        let json: serde_json::Value = serde_json::json!({
            "results": [
                { "title": "Doc", "url": "https://docs.example", "content": "Body text" },
                { "title": "NoContent", "url": "https://b.example" }
            ],
            "answer": "ignored"
        });
        let r = parse_tavily_results(&json, 5);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].snippet, "Body text");
        assert_eq!(r[1].snippet, "");
    }

    #[test]
    fn tavily_unexpected_shape_yields_empty() {
        let json: serde_json::Value = serde_json::json!({ "detail": "unauthorized" });
        assert!(parse_tavily_results(&json, 5).is_empty());
    }

    #[test]
    fn tavily_respects_count_cap() {
        let arr: Vec<serde_json::Value> = (0..10)
            .map(|i| serde_json::json!({ "title": format!("t{}", i), "url": format!("https://e{}.example", i), "content": "" }))
            .collect();
        let json = serde_json::json!({ "results": arr });
        assert_eq!(parse_tavily_results(&json, 3).len(), 3);
    }

    #[test]
    fn strip_block_tag_matches_case_insensitively() {
        assert_eq!(strip_block_tag("a<SCRIPT>x</Script>b", "script"), "ab");
    }

    #[test]
    fn strip_block_tag_survives_length_changing_uppercase() {
        // ẞ lowercases to a shorter ß, İ to a longer i̇ — both used to shift the
        // cut into the wrong place, and ẞ right before a tag panicked outright.
        assert_eq!(strip_block_tag("ẞ<script>x</script>t", "script"), "ẞt");
        assert_eq!(strip_block_tag("STRAẞE<script>x</script>t", "script"), "STRAẞEt");
        assert_eq!(strip_block_tag("İstanbul<script>x</script>t", "script"), "İstanbult");
    }

    #[test]
    fn capture_first_survives_length_changing_uppercase() {
        assert_eq!(capture_first("ẞ<title>Hallo</title>", "<title", "</title>").as_deref(), Some("Hallo"));
        assert_eq!(
            capture_first("<h1>STRAẞE</h1><TITLE>Hallo</TITLE>", "<title", "</title>").as_deref(),
            Some("Hallo")
        );
    }

    #[test]
    fn readable_text_of_a_german_caps_page_keeps_the_body() {
        let (title, text) = extract_readable_text(
            "<html><head><title>STRAẞE</title><script>evil()</script></head><body><p>Inhalt</p></body></html>",
            "text/html",
        );
        assert_eq!(title, "STRAẞE");
        assert!(text.contains("Inhalt"), "body text lost: {:?}", text);
        assert!(!text.contains("evil"), "script survived: {:?}", text);
    }
}

#[cfg(test)]
mod wiki_sprache_tests {
    use super::{sprach_signal_deutsch, wiki_versuche};

    // Der Anlass steht bei `sprach_signal_deutsch`: gemessen am 04.09.2026,
    // en.wikipedia 0 Treffer / de.wikipedia 31, DuckDuckGo HTTP 202.

    #[test]
    fn die_frage_der_persona_geht_zuerst_an_die_deutsche() {
        let v = wiki_versuche("Transparenzgesetz Hamburg Antragsfristen", 4);
        assert_eq!(v[0], ("de", "Transparenzgesetz Hamburg Antragsfristen".to_string()));
        // Und der zweite Versuch ist der, der wirklich Treffer hat.
        assert_eq!(v[1], ("de", "Transparenzgesetz Hamburg".to_string()));
    }

    #[test]
    fn englische_fragen_bleiben_bei_der_englischen() {
        let v = wiki_versuche("Hamburg transparency law deadlines", 4);
        assert_eq!(v[0].0, "en");
    }

    #[test]
    fn beide_sprachen_bleiben_erreichbar() {
        // Eine Vermutung, die die andere Sprache ausschliesst, wiederholt genau
        // den Fehler, den sie beheben soll.
        let v = wiki_versuche("Transparenzgesetz", 4);
        assert!(v.iter().any(|(s, _)| *s == "de"));
        assert!(v.iter().any(|(s, _)| *s == "en"));
    }

    #[test]
    fn nie_unter_zwei_begriffe_und_gedeckelt() {
        let v = wiki_versuche("a b c d e f g h", 4);
        assert_eq!(v.len(), 4);
        assert!(v.iter().all(|(_, q)| q.split_whitespace().count() >= 2));
    }

    #[test]
    fn leere_anfrage_ergibt_keinen_versuch() {
        assert!(wiki_versuche("   ", 4).is_empty());
    }

    #[test]
    fn umlaute_zaehlen_sofort() {
        assert!(sprach_signal_deutsch("Gebührenordnung"));
        assert!(sprach_signal_deutsch("Straßenverkehr"));
        assert!(!sprach_signal_deutsch("transparency law"));
    }
}
