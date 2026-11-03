use std::sync::atomic::Ordering;
use tauri::State;

use crate::commands::search_tiers;
use crate::state::AppState;

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// The longest User-Agent taken from Settings. A real one is a few hundred
/// characters at most; anything longer is pasted by mistake.
const MAX_USER_AGENT_LEN: usize = 512;

/// The User-Agent the user set under Settings, Search Provider (D16), or
/// `None` when the free tiers and `web_fetch` keep their own.
///
/// Empty means "as before". So does a value that cannot go into a header as it
/// stands (a line break, a character outside printable ASCII, too long): the
/// request must not fail over a setting, and the field under Settings says the
/// same with `userAgentProblem`.
pub(crate) fn custom_user_agent(raw: Option<&str>) -> Option<String> {
    let text = raw?.trim();
    if text.is_empty() || text.len() > MAX_USER_AGENT_LEN {
        return None;
    }
    if !text.bytes().all(|b| (0x20..0x7f).contains(&b)) {
        return None;
    }
    reqwest::header::HeaderValue::from_str(text).ok()?;
    Some(text.to_string())
}

/// Parse a Brave Search API response body into results. Split out of
/// the Brave tier (`search_tiers.rs`) so the shape mapping is testable without network.
pub(crate) fn parse_brave_results(json: &serde_json::Value, count: usize) -> Vec<SearchResult> {
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

/// Parse a Tavily API response body into results (unit-testable, no network).
pub(crate) fn parse_tavily_results(json: &serde_json::Value, count: usize) -> Vec<SearchResult> {
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

/// Parse a Keenable API response body into results (unit-testable, no network).
/// `description` is often empty, so the snippet falls back to `snippet`, cut
/// to 500 characters (it can hold a whole page).
pub(crate) fn parse_keenable_results(json: &serde_json::Value, count: usize) -> Vec<SearchResult> {
    json.get("results")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .take(count)
                .filter_map(|r| {
                    let text = r
                        .get("description")
                        .and_then(|c| c.as_str())
                        .filter(|s| !s.trim().is_empty())
                        .or_else(|| r.get("snippet").and_then(|c| c.as_str()))
                        .unwrap_or("");
                    Some(SearchResult {
                        title: r.get("title")?.as_str()?.to_string(),
                        url: r.get("url")?.as_str()?.to_string(),
                        snippet: text.chars().take(500).collect(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
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

pub(crate) fn html_decode(s: &str) -> String {
    s.replace("&amp;", "&")
     .replace("&lt;", "<")
     .replace("&gt;", ">")
     .replace("&quot;", "\"")
     .replace("&#39;", "'")
     .replace("&#x27;", "'")
     .replace("&apos;", "'")
     .replace("&nbsp;", " ")
}

pub(crate) fn strip_html(s: &str) -> String {
    let re = regex::Regex::new(r"<[^>]+>").unwrap();
    re.replace_all(s, "").to_string()
}

/// `web_search` of the agent and the chat tools. The tiers and their order
/// live in `search_tiers.rs`; this command only gathers what Settings sent.
///
/// `provider` is `auto` or one tier (`exa`, `you`, `searxng`, `duckduckgo`,
/// `wikipedia`, `brave`, `tavily`, `keenable`). A chosen tier is asked first and the rest
/// of Auto follows, with `providerError` saying why the chosen one did not
/// answer. The keys come from the user's own Settings and stay on this
/// computer; empty means that service is asked without one or not at all.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn web_search(
    query: String,
    count: Option<usize>,
    provider: Option<String>,
    brave_api_key: Option<String>,
    tavily_api_key: Option<String>,
    user_agent: Option<String>,
    exa_api_key: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // D16: the tiers that read a public page as a browser would (DuckDuckGo,
    // Wikipedia) send the user's own User-Agent when one is set. The APIs
    // (Exa, You.com, Brave, Tavily) and the local SearXNG get the app's name.
    let user_agent = custom_user_agent(user_agent.as_deref());
    let provider = provider.unwrap_or_else(|| "auto".to_string());
    let request = search_tiers::Request {
        query: query.trim(),
        count: count.unwrap_or(5),
        provider: provider.trim(),
        keys: search_tiers::Keys {
            brave: brave_api_key.unwrap_or_default(),
            tavily: tavily_api_key.unwrap_or_default(),
            exa: exa_api_key.unwrap_or_default(),
        },
        user_agent: user_agent.as_deref(),
        searxng_running: state.searxng_available.load(Ordering::Relaxed),
    };
    Ok(search_tiers::run(&request, &search_tiers::Endpoints::default(), &search_tiers::Timing::default()).await)
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
        let mut pull_cmd = crate::process_util::foreign_system_command("docker");
        pull_cmd.args(["pull", "searxng/searxng"]);
        crate::process_util::suppress_window(&mut pull_cmd);
        let pull = pull_cmd.output();

        match pull {
            Ok(output) if output.status.success() => {
                let mut run_cmd = crate::process_util::foreign_system_command("docker");
                run_cmd.args([
                    "run", "-d", "--name", "searxng",
                    "-p", "8888:8080",
                    "-e", crate::app_identity::SEARXNG_INSTANCE_ENV,
                    "searxng/searxng",
                ]);
                crate::process_util::suppress_window(&mut run_cmd);
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

/// Fetch a URL and return its readable text. The agent calls this after
/// `web_search` to read a page; snippets alone answer nothing.
///
/// First locally, on this computer: `web_reach` checks every address (no
/// localhost, no private range, no cloud metadata), pins the connection to
/// that answer, follows redirects by hand and stops reading at 8 MB. The body
/// is unpacked, decoded and read with Readability (`readable_text`), cut at
/// 40 000 characters.
///
/// When that read is refused (403, 429, a bot check) or finds no text (a page
/// built by JavaScript), the same public address goes to Exa's reader, and
/// the answer says so in `via`. An address the local check refuses never
/// leaves this computer.
#[tauri::command]
pub async fn web_fetch(url: String, user_agent: Option<String>) -> Result<serde_json::Value, String> {
    let agent = custom_user_agent(user_agent.as_deref());
    web_fetch_with(
        url.trim(),
        agent.as_deref(),
        std::sync::Arc::new(crate::commands::web_reach::model_url_addrs),
        &search_tiers::Endpoints::default().exa_mcp,
        std::time::Duration::from_secs(20),
    )
    .await
}

/// Why a local read is worth a second try through Exa, or `None` when what it
/// got is the answer (the page itself, a 404, a file that is no text).
pub(crate) fn reader_fallback_reason(status: u16, title: &str, text: &str, not_text: bool) -> Option<String> {
    if not_text {
        return None;
    }
    if matches!(status, 404 | 410) {
        return None;
    }
    if !(200..300).contains(&status) || status == 202 {
        return Some(format!("the site answered HTTP {status}"));
    }
    let lower = format!("{} {}", title, text.chars().take(2_000).collect::<String>()).to_lowercase();
    const WALLS: &[&str] = &[
        "just a moment",
        "attention required",
        "verify you are human",
        "are you a robot",
        "captcha",
        "enable javascript",
        "javascript is disabled",
        "please turn javascript on",
        "access denied",
    ];
    let short = text.trim().chars().count() < 400;
    if short && WALLS.iter().any(|w| lower.contains(w)) {
        return Some("the site showed a bot check or needs JavaScript".to_string());
    }
    if text.trim().chars().count() < 80 {
        return Some("the page had no readable text".to_string());
    }
    None
}

pub(crate) async fn web_fetch_with(
    url: &str,
    user_agent: Option<&str>,
    gate: crate::commands::web_reach::Gate,
    exa_endpoint: &str,
    exa_timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    use crate::commands::web_reach;
    let local = web_reach::fetch_page_with(
        url,
        gate.clone(),
        web_reach::MAX_BODY,
        web_reach::DEADLINE,
        user_agent.unwrap_or(web_reach::USER_AGENT),
    )
    .await;

    let (local_json, why) = match local {
        Ok(page) => {
            let v = page_json(&page.final_url, page.status, &page.content_type, &page.content_encoding, &page.body).await;
            let why = reader_fallback_reason(
                page.status,
                v["title"].as_str().unwrap_or(""),
                v["text"].as_str().unwrap_or(""),
                v.get("notText").is_some(),
            );
            (Ok(v), why)
        }
        Err(e) => {
            // A refused address stays refused: it is not handed to anyone.
            if e.starts_with("Blocked") || e.starts_with("Invalid URL") || e.contains("larger than") {
                return Err(e);
            }
            let why = format!("the local read failed ({e})");
            (Err(e), Some(why))
        }
    };
    let Some(why) = why else {
        return local_json;
    };
    // The address check again before the address leaves this computer: a
    // redirect may have ended somewhere the first hop did not show.
    let target = url.to_string();
    let check = gate.clone();
    let public = tokio::task::spawn_blocking(move || check(&target)).await.map(|r| r.is_ok()).unwrap_or(false);
    if !public {
        return local_json;
    }
    match search_tiers::exa_fetch(url, exa_endpoint, exa_timeout).await {
        Ok((title, final_url, text, truncated)) => Ok(serde_json::json!({
            "url": final_url,
            "status": 200,
            "contentType": "text/plain",
            "title": title,
            "text": text,
            "truncated": truncated,
            "via": "exa",
            "localProblem": why,
        })),
        Err(exa_err) => match local_json {
            Ok(mut v) => {
                v["readerError"] = serde_json::json!(exa_err);
                Ok(v)
            }
            Err(e) => Err(format!("{e} (Exa could not read it either: {exa_err})")),
        },
    }
}

/// What `web_fetch` answers for one response: the readable text of the page,
/// or `notText` with one sentence when the body is no text (a PDF, an image,
/// an archive) or its packing could not be undone. `text` is empty then, so a
/// reader that does not know `notText` sees an empty body and never bytes.
///
/// A server may pack its answer although the request did not ask for it
/// (python.org does, acceptance on Android with 8 GB, B2). `web_body` undoes
/// gzip, deflate, brotli and zstd.
async fn page_json(
    final_url: &str,
    status: u16,
    content_type: &str,
    content_encoding: &str,
    raw: &[u8],
) -> serde_json::Value {
    use crate::commands::web_body;
    let refused = |sentence: String| {
        serde_json::json!({
            "url": final_url,
            "status": status,
            "contentType": content_type,
            "title": "",
            "text": "",
            "truncated": false,
            "notText": sentence,
        })
    };
    let body = match web_body::unpack(raw, content_encoding) {
        Ok(body) => body,
        Err(reason) => return refused(web_body::unpack_failed_sentence(&reason)),
    };
    if let Some(kind) = web_body::not_text(content_type, &body) {
        return refused(web_body::not_text_sentence(&kind));
    }
    let decoded = decode_charset(body, content_type).await;
    let (ct, url) = (content_type.to_string(), final_url.to_string());
    let (title, text) = tokio::task::spawn_blocking(move || readable_text(&decoded, &ct, &url))
        .await
        .unwrap_or_default();
    let (capped, truncated) = search_tiers::bound_text(&text);

    serde_json::json!({
        "url": final_url,
        "status": status,
        "contentType": content_type,
        "title": title,
        "text": capped,
        "truncated": truncated,
    })
}

/// The most elements Readability scores. A page past it is read by the plain
/// extractor below, which is linear; scoring a huge DOM is not.
const READABILITY_MAX_ELEMENTS: usize = 100_000;

fn looks_like_html(body: &str, content_type: &str) -> bool {
    content_type.contains("html")
        || body.trim_start().get(..9).is_some_and(|h| h.eq_ignore_ascii_case("<!doctype"))
        || body.contains("<html")
}

/// The text of a page as Firefox Reader View would show it (dom_smoothie, a
/// port of Mozilla Readability), or the plain extractor's text when
/// Readability finds no article: a list, a search page, a page too small to
/// score. Readability is only taken when it kept a real share of the page;
/// one paragraph out of a long listing is worse than the listing.
fn readable_text(body: &str, content_type: &str, url: &str) -> (String, String) {
    let (title, plain) = extract_readable_text(body, content_type);
    if !looks_like_html(body, content_type) {
        return (title, plain);
    }
    let cfg = dom_smoothie::Config {
        text_mode: dom_smoothie::TextMode::Formatted,
        max_elements_to_parse: READABILITY_MAX_ELEMENTS,
        ..Default::default()
    };
    let doc_url = url::Url::parse(url)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .map(|_| url);
    let article = dom_smoothie::Readability::new(body, doc_url, Some(cfg)).and_then(|mut r| r.parse());
    if let Ok(article) = article {
        let text = collapse_whitespace(&article.text_content);
        let kept = text.chars().count();
        if kept >= 250 && kept * 10 >= plain.chars().count() {
            let title = if title.is_empty() { article.title.trim().to_string() } else { title };
            return (title, text);
        }
    }
    (title, plain)
}

/// Bytes to text by the charset the `Content-Type` names, UTF-8 without one.
///
/// The HTTP client knows every charset a page may declare. It only decodes a
/// response it holds, so the unpacked bytes are handed back to it as one.
async fn decode_charset(body: Vec<u8>, content_type: &str) -> String {
    let mut builder = axum::http::Response::builder();
    if !content_type.is_empty() {
        builder = builder.header(reqwest::header::CONTENT_TYPE, content_type);
    }
    match builder.body(body.clone()) {
        Ok(response) => match reqwest::Response::from(response).text().await {
            Ok(text) => text,
            Err(_) => String::from_utf8_lossy(&body).into_owned(),
        },
        Err(_) => String::from_utf8_lossy(&body).into_owned(),
    }
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
    fn d16_a_user_agent_from_settings_is_taken_as_it_is_typed() {
        assert_eq!(custom_user_agent(Some("MyBot/1.0")), Some("MyBot/1.0".to_string()));
        assert_eq!(
            custom_user_agent(Some("  Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0  ")),
            Some("Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0".to_string()),
            "spaces around it are trimmed"
        );
    }

    #[test]
    fn d16_empty_or_unusable_keeps_the_user_agent_of_today() {
        assert_eq!(custom_user_agent(None), None);
        assert_eq!(custom_user_agent(Some("")), None);
        assert_eq!(custom_user_agent(Some("   ")), None);
        // A line break would start a second header; never sent.
        assert_eq!(custom_user_agent(Some("Bot/1.0\r\nX-Evil: 1")), None);
        assert_eq!(custom_user_agent(Some("Bot/1.0\nX")), None);
        assert_eq!(custom_user_agent(Some("Bot\t1")), None);
        assert_eq!(custom_user_agent(Some("Böt/1.0")), None, "printable ASCII only");
        assert_eq!(custom_user_agent(Some(&"a".repeat(MAX_USER_AGENT_LEN + 1))), None);
        assert!(custom_user_agent(Some(&"a".repeat(MAX_USER_AGENT_LEN))).is_some());
    }

    #[test]
    fn d16_the_user_agent_reaches_every_free_tier_and_web_fetch() {
        // Quelltextwaechter: die Einstellung wird in beiden Befehlen geprueft
        // und bis zu den Anfragen durchgereicht. Dass sie dort auch ankommt,
        // pruefen die Stub-Tests in `search_tier_tests`.
        let src = include_str!("search.rs");
        let search = &src[src.find("pub async fn web_search(").unwrap()..src.find("pub async fn search_status(").unwrap()];
        assert!(search.contains("custom_user_agent(user_agent.as_deref())"));
        assert!(search.contains("user_agent: user_agent.as_deref(),"));
        let fetch = &src[src.find("pub async fn web_fetch(").unwrap()..src.find("pub(crate) fn reader_fallback_reason(").unwrap()];
        assert!(fetch.contains("custom_user_agent(user_agent.as_deref())"));
        assert!(fetch.contains("agent.as_deref(),"));
        let tiers = include_str!("search_tiers.rs");
        assert!(tiers.contains("req.user_agent.unwrap_or(DDG_USER_AGENT)"));
        assert!(tiers.contains("req.user_agent.unwrap_or(APP_USER_AGENT.as_str())"));
    }

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

#[cfg(test)]
mod page_tests {
    use super::page_json;
    use std::io::Write;

    const PAGE: &str = "<!doctype html><html><head><title>Python Release</title><script>var x = 1;</script></head><body><p>Python 3.15.0 is the newest release.</p></body></html>";

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    fn zlib(data: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    fn br(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut w = brotli::CompressorWriter::new(&mut out, 4096, 5, 22);
            w.write_all(data).unwrap();
        }
        out
    }

    /// The case of the acceptance run (B2): python.org packs its page with
    /// gzip although the request never asked for it. One response per coding.
    #[tokio::test]
    async fn a_packed_page_is_read_as_the_page_for_every_coding() {
        let bodies: Vec<(&str, Vec<u8>)> = vec![
            ("", PAGE.as_bytes().to_vec()),
            ("gzip", gzip(PAGE.as_bytes())),
            ("deflate", zlib(PAGE.as_bytes())),
            ("br", br(PAGE.as_bytes())),
            ("zstd", zstd::stream::encode_all(PAGE.as_bytes(), 3).unwrap()),
        ];
        for (coding, body) in bodies {
            let v = page_json("https://www.python.org/downloads/release/python-3150/", 200, "text/html; charset=utf-8", coding, &body).await;
            assert_eq!(v["title"], "Python Release", "{coding}");
            let text = v["text"].as_str().unwrap();
            assert!(text.ends_with("Python 3.15.0 is the newest release."), "{coding}: {text}");
            assert!(!text.contains("var x"), "{coding}: {text}");
            assert_eq!(v["status"], 200, "{coding}");
            assert!(v.get("notText").is_none(), "{coding}");
        }
    }

    #[tokio::test]
    async fn bytes_that_are_no_text_come_back_as_one_sentence_and_never_as_text() {
        let pdf = page_json("https://example.org/a.pdf", 200, "application/pdf", "", b"%PDF-1.7\n\x00\x01\x02").await;
        assert_eq!(pdf["text"], "");
        assert!(pdf["notText"].as_str().unwrap().starts_with("This address returned a PDF, not a page of text"));

        // A coding this app cannot undo: a reason, not the packed bytes.
        let odd = page_json("https://example.org/", 200, "text/html", "compress", &gzip(PAGE.as_bytes())).await;
        assert_eq!(odd["text"], "");
        assert!(odd["notText"].as_str().unwrap().contains("\"compress\""));

        // A body that says gzip and is not: the same.
        let broken = page_json("https://example.org/", 200, "text/html", "gzip", b"\x1f\x8b\x08 nothing useful").await;
        assert_eq!(broken["text"], "");
        assert!(broken["notText"].as_str().unwrap().starts_with("This page cannot be read"));
    }

    /// A zip bomb and a tower of codings both end in one sentence, with no
    /// text and nothing of the body in the answer.
    #[tokio::test]
    async fn a_bomb_and_a_tower_of_codings_come_back_as_one_sentence() {
        let bomb = gzip(&vec![0u8; crate::commands::web_body::MAX_UNPACKED + 1]);
        assert!(bomb.len() < 64 * 1024);
        let v = page_json("https://example.org/", 200, "text/html", "gzip", &bomb).await;
        assert_eq!(v["text"], "");
        assert_eq!(v["notText"], "This page cannot be read: it unpacks to more than 8 MB. Use a different address.");

        let tower = page_json("https://example.org/", 200, "text/html", "gzip, gzip, br, gzip, gzip", b"x").await;
        assert_eq!(tower["text"], "");
        assert!(tower["notText"].as_str().unwrap().contains("packed 5 times over"));
    }

    #[tokio::test]
    async fn the_charset_of_the_header_still_decides_after_unpacking() {
        let latin1 = b"<html><head><title>Gr\xfc\xdfe</title></head><body><p>K\xf6ln</p></body></html>";
        let plain = page_json("https://example.org/", 200, "text/html; charset=iso-8859-1", "", latin1).await;
        assert_eq!(plain["title"], "Gr\u{fc}\u{df}e");
        let packed = page_json("https://example.org/", 200, "text/html; charset=iso-8859-1", "gzip", &gzip(latin1)).await;
        assert_eq!(packed["title"], "Gr\u{fc}\u{df}e");
        assert!(packed["text"].as_str().unwrap().contains("K\u{f6}ln"));
    }
}
