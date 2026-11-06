//! The tiers of `web_search` and the reader fallback of `web_fetch`.
//!
//! "Auto" asks, in this order, until one answers with results:
//!
//! 1. Brave, Tavily or Exa with the user's own key, when one is set.
//! 2. Exa over its hosted MCP endpoint, no key (`https://mcp.exa.ai/mcp`).
//! 3. You.com over its free hosted MCP endpoint (`api.you.com/mcp?profile=free`).
//! 4. SearXNG, when the local instance is running.
//! 5. DuckDuckGo, Lite first and then HTML. A 202 or the bot check page is a
//!    failure, never an empty result.
//! 6. Wikipedia, always with a User-Agent (Wikimedia answers 403 without one).
//!
//! Everything runs in the app on the user's computer. A chat on LU Cloud asks
//! for the tool like any other model would, and the app runs it here
//! (`builtin-tools.ts`, `executeWebSearch`), so no server pays for a search.
//!
//! Parts of this file are adapted from Jan (https://github.com/janhq/jan),
//! `src-tauri/plugins/tauri-plugin-websearch/src/provider.rs` at commit
//! 897008134d2c769150a4b63f05ec56f9354fc9df, Copyright 2025 Menlo Research,
//! licensed under the Apache License, Version 2.0 (see
//! `third-party/WEB-SEARCH-NOTICES.md`). Taken over: the MCP `tools/call`
//! request of the Exa and You.com endpoints, the reading of their answers
//! (`parse_hosted_result_text`, `is_rate_limited`, `parse_hosted_search_text`,
//! `parse_hosted_fetch_text`, `normalize_youcom_search`,
//! `normalize_exa_rest_search`) and the cut at 40 000 characters. Changed for
//! LU: no provider trait, one chain of tiers with a shared deadline, outcomes
//! that keep "failed" apart from "nothing found", the LU User-Agent, every
//! address and timeout injectable for the tests, and the result type of
//! `search.rs`.

use std::sync::LazyLock;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::search::{html_decode, strip_html, SearchResult};

/// The longest text `web_fetch` hands the model, local read or Exa.
pub(crate) const FETCH_MAX_CHARS: usize = 40_000;

/// What the app calls itself towards Wikimedia, Exa and You.com. Wikimedia
/// asks every client for a name and a way to reach its maker.
pub(crate) static APP_USER_AGENT: LazyLock<String> =
    LazyLock::new(|| format!("{} (+https://lu-labs.ai)", crate::app_identity::outgoing_agent_for(crate::app_identity::APP_VERSION)));

/// The browser the DuckDuckGo tier poses as when the user set no User-Agent.
pub(crate) const DDG_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

static YOU_COM_CLIENT_INFO: LazyLock<String> =
    LazyLock::new(|| format!("plugin; client={}/{}; ua=rust/unknown", crate::app_identity::CLIENT_SLUG, crate::app_identity::APP_VERSION));

/// Where each tier is asked. The tests point every one at a local stub.
#[derive(Clone, Debug)]
pub(crate) struct Endpoints {
    pub exa_mcp: String,
    pub exa_rest_search: String,
    pub you_mcp: String,
    pub searxng: String,
    pub ddg_lite: String,
    pub ddg_html: String,
    /// `{lang}` stands for the language of the wiki.
    pub wikipedia: String,
    pub brave: String,
    pub tavily: String,
    pub keenable: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            exa_mcp: "https://mcp.exa.ai/mcp".into(),
            exa_rest_search: "https://api.exa.ai/search".into(),
            you_mcp: "https://api.you.com/mcp?profile=free".into(),
            searxng: "http://localhost:8888/search".into(),
            ddg_lite: "https://lite.duckduckgo.com/lite/".into(),
            ddg_html: "https://html.duckduckgo.com/html/".into(),
            wikipedia: "https://{lang}.wikipedia.org/w/api.php".into(),
            brave: "https://api.search.brave.com/res/v1/web/search".into(),
            tavily: "https://api.tavily.com/search".into(),
            keenable: "https://api.keenable.ai/v1/search/public".into(),
        }
    }
}

/// How long each tier may take, and the whole chain. The tool call itself is
/// cut at 60 s on the frontend (`tool-timeout.ts`), so the chain ends first.
#[derive(Clone, Debug)]
pub(crate) struct Timing {
    pub hosted: Duration,
    pub searxng: Duration,
    pub page: Duration,
    pub total: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            hosted: Duration::from_secs(15),
            searxng: Duration::from_secs(5),
            page: Duration::from_secs(8),
            total: Duration::from_secs(45),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Keys {
    pub brave: String,
    pub tavily: String,
    pub exa: String,
}

/// The tiers by the names Settings stores.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tier {
    Brave,
    Tavily,
    Exa,
    You,
    Keenable,
    Searxng,
    DuckDuckGo,
    Wikipedia,
}

impl Tier {
    pub fn id(self) -> &'static str {
        match self {
            Tier::Brave => "brave",
            Tier::Tavily => "tavily",
            Tier::Exa => "exa",
            Tier::You => "you",
            Tier::Keenable => "keenable",
            Tier::Searxng => "searxng",
            Tier::DuckDuckGo => "duckduckgo",
            Tier::Wikipedia => "wikipedia",
        }
    }

    pub fn from_id(id: &str) -> Option<Tier> {
        Some(match id.trim().to_ascii_lowercase().as_str() {
            "brave" => Tier::Brave,
            "tavily" => Tier::Tavily,
            "exa" => Tier::Exa,
            "you" | "youcom" | "you.com" => Tier::You,
            "keenable" => Tier::Keenable,
            "searxng" => Tier::Searxng,
            "duckduckgo" | "ddg" => Tier::DuckDuckGo,
            "wikipedia" => Tier::Wikipedia,
            _ => return None,
        })
    }

    fn label(self) -> &'static str {
        match self {
            Tier::Brave => "Brave",
            Tier::Tavily => "Tavily",
            Tier::Exa => "Exa",
            Tier::You => "You.com",
            Tier::Keenable => "Keenable",
            Tier::Searxng => "SearXNG",
            Tier::DuckDuckGo => "DuckDuckGo",
            Tier::Wikipedia => "Wikipedia",
        }
    }
}

/// What one tier answered. "Nothing found" and "could not ask" are kept apart:
/// a bot check page parses as zero results, and reported as empty it reads to
/// a model as "the web has nothing", so it searches again.
#[derive(Debug, PartialEq)]
pub(crate) enum Outcome {
    Hits(Vec<SearchResult>),
    Empty,
    Failed(String),
}

/// One search as the command received it.
pub(crate) struct Request<'a> {
    pub query: &'a str,
    pub count: usize,
    /// `auto` or a tier id.
    pub provider: &'a str,
    pub keys: Keys,
    /// The user's own User-Agent, already checked (`custom_user_agent`).
    pub user_agent: Option<&'a str>,
    /// The local SearXNG answered its probe (`search_status`).
    pub searxng_running: bool,
}

/// The sentence the model gets when every tier failed. Word for word as
/// David asked for it (20.10.2026).
pub(crate) const UNAVAILABLE: &str = "Web search is unavailable right now. Do not repeat the same search. Answer from what you know and say that you could not search.";

/// The order the tiers are asked in. A chosen tier goes first; the rest of
/// Auto follows so that one dead service never ends the search. A key the user
/// set means they want that service, so keyed tiers come before the free ones.
pub(crate) fn chain(req: &Request) -> Vec<Tier> {
    let mut out: Vec<Tier> = Vec::new();
    if let Some(first) = Tier::from_id(req.provider) {
        out.push(first);
    }
    if !req.keys.brave.trim().is_empty() {
        out.push(Tier::Brave);
    }
    if !req.keys.tavily.trim().is_empty() {
        out.push(Tier::Tavily);
    }
    out.push(Tier::Exa);
    out.push(Tier::You);
    if req.searxng_running || req.provider == "searxng" {
        out.push(Tier::Searxng);
    }
    out.push(Tier::DuckDuckGo);
    out.push(Tier::Wikipedia);
    let mut seen: Vec<Tier> = Vec::new();
    out.retain(|t| {
        if seen.contains(t) {
            false
        } else {
            seen.push(*t);
            true
        }
    });
    out
}

/// Run the chain and answer the JSON `web_search` returns:
/// `{results, provider, tried, providerError?}` on a hit,
/// `{results: [], noResults: true, tried}` when tiers answered but found
/// nothing, `{results: [], unavailable: true, error, tried}` when none could
/// be asked.
pub(crate) async fn run(req: &Request<'_>, ends: &Endpoints, timing: &Timing) -> Value {
    let started = Instant::now();
    let count = req.count.clamp(1, 20);
    let chosen = Tier::from_id(req.provider);
    let mut tried: Vec<Value> = Vec::new();
    let mut provider_error: Option<String> = None;
    let mut any_empty = false;

    for tier in chain(req) {
        let left = timing.total.saturating_sub(started.elapsed());
        if left.is_zero() {
            tried.push(json!({"tier": tier.id(), "outcome": "skipped", "detail": "out of time"}));
            continue;
        }
        let outcome = ask(tier, req, count, ends, timing, left).await;
        match outcome {
            Outcome::Hits(results) => {
                tried.push(json!({"tier": tier.id(), "outcome": "results", "count": results.len()}));
                let mut v = json!({"results": results, "provider": tier.id(), "tried": tried});
                if let Some(err) = provider_error {
                    v["providerError"] = json!(err);
                }
                return v;
            }
            Outcome::Empty => {
                any_empty = true;
                tried.push(json!({"tier": tier.id(), "outcome": "empty"}));
                if chosen == Some(tier) && provider_error.is_none() {
                    provider_error = Some(format!("{} found nothing", tier.label()));
                }
            }
            Outcome::Failed(why) => {
                tried.push(json!({"tier": tier.id(), "outcome": "failed", "detail": why.clone()}));
                if chosen == Some(tier) && provider_error.is_none() {
                    provider_error = Some(why);
                }
            }
        }
    }

    let mut v = if any_empty {
        json!({"results": [], "noResults": true, "tried": tried})
    } else {
        json!({"results": [], "unavailable": true, "error": UNAVAILABLE, "tried": tried})
    };
    if let Some(err) = provider_error {
        v["providerError"] = json!(err);
    }
    v
}

async fn ask(tier: Tier, req: &Request<'_>, count: usize, ends: &Endpoints, timing: &Timing, left: Duration) -> Outcome {
    let within = |d: Duration| d.min(left);
    match tier {
        Tier::Brave => brave(req.query, count, req.keys.brave.trim(), &ends.brave, within(timing.page)).await,
        Tier::Tavily => tavily(req.query, count, req.keys.tavily.trim(), &ends.tavily, within(timing.page)).await,
        Tier::Exa => {
            let key = req.keys.exa.trim();
            if key.is_empty() {
                exa_hosted(req.query, count, &ends.exa_mcp, within(timing.hosted)).await
            } else {
                exa_rest(req.query, count, key, &ends.exa_rest_search, within(timing.hosted)).await
            }
        }
        Tier::Keenable => keenable(req.query, count, &ends.keenable, within(timing.hosted)).await,
        Tier::You => you_hosted(req.query, count, &ends.you_mcp, within(timing.hosted)).await,
        Tier::Searxng => searxng(req.query, count, &ends.searxng, within(timing.searxng)).await,
        Tier::DuckDuckGo => {
            let started = Instant::now();
            let ua = req.user_agent.unwrap_or(DDG_USER_AGENT);
            let lite = ddg(req.query, count, &ends.ddg_lite, DdgPage::Lite, ua, within(timing.page)).await;
            if let Outcome::Hits(_) = lite {
                return lite;
            }
            let rest = left.saturating_sub(started.elapsed());
            if rest.is_zero() {
                return lite;
            }
            let html = ddg(req.query, count, &ends.ddg_html, DdgPage::Html, ua, timing.page.min(rest)).await;
            match (lite, html) {
                (_, hits @ Outcome::Hits(_)) => hits,
                (Outcome::Empty, _) | (_, Outcome::Empty) => Outcome::Empty,
                (Outcome::Failed(a), Outcome::Failed(b)) => Outcome::Failed(format!("Lite: {a}; HTML: {b}")),
                (a, _) => a,
            }
        }
        Tier::Wikipedia => {
            let ua = req.user_agent.unwrap_or(APP_USER_AGENT.as_str());
            wikipedia(req.query, count, &ends.wikipedia, ua, timing.page, left).await
        }
    }
}

fn client(timeout: Duration, user_agent: &str) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(user_agent)
        .build()
        .map_err(|e| e.to_string())
}

/// A failed request in a few words. A timeout says so, the rest in the words
/// of the OS error helper.
fn request_failed(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "timed out".to_string()
    } else if e.is_connect() {
        "could not connect".to_string()
    } else {
        crate::os_error::english(e)
    }
}

fn http_failed(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        202 => "HTTP 202 (bot check)".to_string(),
        403 => "HTTP 403 (refused)".to_string(),
        429 => "HTTP 429 (rate limit)".to_string(),
        n => format!("HTTP {n}"),
    }
}

/// POST with a deadline, answer the body of a 2xx.
async fn read_ok(builder: reqwest::RequestBuilder) -> Result<String, String> {
    let resp = builder.send().await.map_err(|e| request_failed(&e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| request_failed(&e))?;
    if !status.is_success() {
        return Err(http_failed(status));
    }
    Ok(text)
}

fn hits_or_empty(results: Vec<SearchResult>, count: usize) -> Outcome {
    let results: Vec<SearchResult> = results
        .into_iter()
        .filter(|r| r.url.starts_with("http://") || r.url.starts_with("https://"))
        .take(count)
        .collect();
    if results.is_empty() {
        Outcome::Empty
    } else {
        Outcome::Hits(results)
    }
}

// ── Exa and You.com over MCP (adapted from Jan) ───────────────────────────

fn mcp_call(tool: &str, arguments: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": tool, "arguments": arguments }
    })
}

async fn exa_hosted(query: &str, count: usize, endpoint: &str, timeout: Duration) -> Outcome {
    let client = match client(timeout, &APP_USER_AGENT) {
        Ok(c) => c,
        Err(e) => return Outcome::Failed(e),
    };
    let body = read_ok(
        client
            .post(endpoint)
            .header("accept", "application/json, text/event-stream")
            .json(&mcp_call("web_search_exa", json!({ "query": query, "numResults": count }))),
    )
    .await;
    let text = match body.and_then(|b| parse_hosted_result_text(&b)) {
        Ok(t) => t,
        Err(e) => return Outcome::Failed(e),
    };
    hits_or_empty(parse_hosted_search_text(&text), count)
}

async fn exa_rest(query: &str, count: usize, key: &str, endpoint: &str, timeout: Duration) -> Outcome {
    let client = match client(timeout, &APP_USER_AGENT) {
        Ok(c) => c,
        Err(e) => return Outcome::Failed(e),
    };
    let body = json!({
        "query": query,
        "type": "auto",
        "numResults": count,
        "contents": {
            "text": { "maxCharacters": 800 },
            "highlights": { "numSentences": 3, "highlightsPerUrl": 1 }
        }
    });
    let text = match read_ok(client.post(endpoint).header("x-api-key", key).json(&body)).await {
        Ok(t) => t,
        Err(e) => return Outcome::Failed(format!("{e} (check the Exa key)")),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => hits_or_empty(normalize_exa_rest_search(&v), count),
        Err(e) => Outcome::Failed(format!("invalid JSON: {e}")),
    }
}

async fn you_hosted(query: &str, count: usize, endpoint: &str, timeout: Duration) -> Outcome {
    let client = match client(timeout, &APP_USER_AGENT) {
        Ok(c) => c,
        Err(e) => return Outcome::Failed(e),
    };
    // `.json()` sets the Content-Type once; a second one is refused with 415.
    let body = read_ok(
        client
            .post(endpoint)
            .header("accept", "application/json, text/event-stream")
            .header("x-client-info", YOU_COM_CLIENT_INFO.as_str())
            .json(&mcp_call("you-search", json!({ "query": query, "count": count }))),
    )
    .await;
    let text = match body.and_then(|b| parse_hosted_result_text(&b)) {
        Ok(t) => t,
        Err(e) => return Outcome::Failed(e),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => hits_or_empty(normalize_youcom_search(&v), count),
        Err(e) => Outcome::Failed(format!("invalid JSON in the tool result: {e}")),
    }
}

/// The tool payload of an MCP `tools/call` answer. Streamable HTTP answers
/// with a bare JSON-RPC object or an SSE stream, and a stream may carry
/// notifications before the answer, so the frame with `result` or `error`
/// is the one read. From Jan.
pub(crate) fn parse_hosted_result_text(body: &str) -> Result<String, String> {
    let envelope = match body
        .lines()
        .filter_map(|l| l.strip_prefix("data:").map(str::trim))
        .filter_map(|frame| serde_json::from_str::<Value>(frame).ok())
        .find(|v| v.get("result").is_some() || v.get("error").is_some())
    {
        Some(frame) => frame,
        None => serde_json::from_str::<Value>(body.trim()).map_err(|e| format!("invalid answer: {e}"))?,
    };
    if let Some(err) = envelope.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).map(str::to_string).unwrap_or_else(|| err.to_string());
        return Err(format!("error: {}", clip_chars(&msg, 200)));
    }
    let result = envelope.get("result").ok_or("answer without a result")?;
    let text = result
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("text"))
        .and_then(|v| v.as_str());
    // A throttled endpoint answers 200 without `isError` and puts the refusal
    // in the text, where it parses as zero results. The flag in `_meta` is the
    // only thing that tells a refusal from a real empty answer.
    if is_rate_limited(result) {
        return Err("rate limit reached".to_string());
    }
    if result.get("isError").and_then(|v| v.as_bool()) == Some(true) {
        return Err(format!("tool error: {}", clip_chars(text.unwrap_or("unknown"), 200)));
    }
    text.map(str::to_string).ok_or_else(|| "answer without text".to_string())
}

/// `_meta` carries a vendor rate limit marker (`ai.exa/rateLimited`). From Jan.
fn is_rate_limited(result: &Value) -> bool {
    result.get("_meta").and_then(|m| m.as_object()).is_some_and(|meta| {
        meta.iter()
            .any(|(k, v)| (k == "rateLimited" || k.ends_with("/rateLimited")) && v.as_bool() == Some(true))
    })
}

/// Exa's hosted search answers blocks of `Title:`, `URL:`, `Highlights:`
/// separated by `---`. From Jan; lines of only `#` are dropped as well.
pub(crate) fn parse_hosted_search_text(text: &str) -> Vec<SearchResult> {
    let mut out = Vec::new();
    for block in text.split("\n---\n") {
        let block = block.trim();
        if block.is_empty() {
            continue;
        }
        let mut title = String::new();
        let mut url = String::new();
        let mut in_highlights = false;
        let mut snippet_lines: Vec<String> = Vec::new();
        for line in block.lines() {
            let trimmed = line.trim();
            if let Some(v) = trimmed.strip_prefix("Title:") {
                title = v.trim().to_string();
            } else if let Some(v) = trimmed.strip_prefix("URL:") {
                url = v.trim().to_string();
            } else if trimmed.starts_with("Published:") || trimmed.starts_with("Author:") {
                // Not part of the result LU hands on.
            } else if trimmed.starts_with("Highlights:") {
                in_highlights = true;
            } else if in_highlights
                && !trimmed.is_empty()
                && trimmed != "..."
                && !trimmed.chars().all(|c| c == '#')
            {
                snippet_lines.push(trimmed.to_string());
            }
        }
        if url.is_empty() {
            continue;
        }
        out.push(SearchResult { title, url, snippet: clip_chars(&snippet_lines.join(" "), 500) });
    }
    out
}

/// Exa's hosted fetch answers `# Title`, `URL: …` and the text. From Jan.
/// Answers (title, url, text, truncated).
pub(crate) fn parse_hosted_fetch_text(text: &str, requested_url: &str) -> (String, String, String, bool) {
    let mut title = String::new();
    let mut url = requested_url.to_string();
    let mut body_start = 0usize;
    for (i, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        if let (0, Some(t)) = (i, trimmed.strip_prefix("# ")) {
            title = t.trim().to_string();
        } else if let Some(v) = trimmed.strip_prefix("URL:") {
            url = v.trim().to_string();
            body_start = i + 1;
            break;
        } else if i > 2 {
            break;
        }
    }
    // Exa puts `Published:` and `Author:` under the URL (measured 20.10.2026);
    // they are no part of the page text.
    let body: String = text
        .lines()
        .skip(body_start)
        .skip_while(|l| {
            let t = l.trim();
            t.is_empty() || t.starts_with("Published:") || t.starts_with("Author:")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    let source = if body.is_empty() { text.trim() } else { body.as_str() };
    let (content, truncated) = bound_text(source);
    (title, url, content, truncated)
}

/// You.com groups results into sections; `web` is the one read. From Jan.
pub(crate) fn normalize_youcom_search(body: &Value) -> Vec<SearchResult> {
    let Some(web) = body.get("results").and_then(|r| r.get("web")).and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    web.iter()
        .map(|r| {
            let snippet = r
                .get("description")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| r.get("snippets").and_then(|v| v.as_array()).and_then(|a| a.first()).and_then(|v| v.as_str()))
                .map(|s| clip_chars(s, 500))
                .unwrap_or_default();
            SearchResult {
                title: r.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                url: r.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                snippet,
            }
        })
        .collect()
}

/// Exa's REST search (with a key). From Jan.
pub(crate) fn normalize_exa_rest_search(body: &Value) -> Vec<SearchResult> {
    let Some(results) = body.get("results").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    results
        .iter()
        .map(|r| SearchResult {
            title: r.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            url: r.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            snippet: r
                .get("highlights")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or_else(|| r.get("text").and_then(|v| v.as_str()).map(|t| clip_chars(t, 300)))
                .unwrap_or_default(),
        })
        .collect()
}

/// Read one page through Exa's hosted reader, for `web_fetch` when the local
/// read was refused or found no text. Answers (title, url, text, truncated).
pub(crate) async fn exa_fetch(url: &str, endpoint: &str, timeout: Duration) -> Result<(String, String, String, bool), String> {
    let client = client(timeout, &APP_USER_AGENT)?;
    let body = read_ok(
        client
            .post(endpoint)
            .header("accept", "application/json, text/event-stream")
            .json(&mcp_call("web_fetch_exa", json!({ "urls": [url], "maxCharacters": FETCH_MAX_CHARS }))),
    )
    .await?;
    let text = parse_hosted_result_text(&body)?;
    let page = parse_hosted_fetch_text(&text, url);
    if page.2.trim().is_empty() {
        return Err("Exa returned no text".to_string());
    }
    Ok(page)
}

// ── SearXNG, Brave, Tavily ───────────────────────────────────────────────

async fn searxng(query: &str, count: usize, endpoint: &str, timeout: Duration) -> Outcome {
    let client = match client(timeout, &APP_USER_AGENT) {
        Ok(c) => c,
        Err(e) => return Outcome::Failed(e),
    };
    let req = client.get(endpoint).query(&[
        ("q", query),
        ("format", "json"),
        ("engines", "google,duckduckgo,brave"),
        ("categories", "general"),
    ]);
    let text = match read_ok(req).await {
        Ok(t) => t,
        Err(e) => return Outcome::Failed(e),
    };
    let json: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => return Outcome::Failed(format!("invalid JSON (is the JSON API on?): {e}")),
    };
    let results = json
        .get("results")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
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
    hits_or_empty(results, count)
}

async fn brave(query: &str, count: usize, key: &str, endpoint: &str, timeout: Duration) -> Outcome {
    if key.is_empty() {
        return Outcome::Failed("no API key set (Settings, Search Provider)".to_string());
    }
    let client = match client(timeout, &APP_USER_AGENT) {
        Ok(c) => c,
        Err(e) => return Outcome::Failed(e),
    };
    let req = client
        .get(endpoint)
        .query(&[("q", query.to_string()), ("count", count.min(20).to_string())])
        .header("Accept", "application/json")
        .header("X-Subscription-Token", key);
    let text = match read_ok(req).await {
        Ok(t) => t,
        Err(e) => return Outcome::Failed(format!("{e} (check the API key)")),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => hits_or_empty(super::search::parse_brave_results(&v, count), count),
        Err(e) => Outcome::Failed(format!("invalid JSON: {e}")),
    }
}

/// Tavily takes the key in the body (older plans) and as Bearer (current docs).
async fn tavily(query: &str, count: usize, key: &str, endpoint: &str, timeout: Duration) -> Outcome {
    if key.is_empty() {
        return Outcome::Failed("no API key set (Settings, Search Provider)".to_string());
    }
    let client = match client(timeout, &APP_USER_AGENT) {
        Ok(c) => c,
        Err(e) => return Outcome::Failed(e),
    };
    let req = client
        .post(endpoint)
        .header("Authorization", format!("Bearer {key}"))
        .json(&json!({ "api_key": key, "query": query, "max_results": count.min(20) }));
    let text = match read_ok(req).await {
        Ok(t) => t,
        Err(e) => return Outcome::Failed(format!("{e} (check the API key)")),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => hits_or_empty(super::search::parse_tavily_results(&v, count), count),
        Err(e) => Outcome::Failed(format!("invalid JSON: {e}")),
    }
}

/// Keenable over its keyless public endpoint. Only asked when chosen in
/// Settings; Auto is unchanged.
async fn keenable(query: &str, count: usize, endpoint: &str, timeout: Duration) -> Outcome {
    let client = match client(timeout, &APP_USER_AGENT) {
        Ok(c) => c,
        Err(e) => return Outcome::Failed(e),
    };
    let req = client
        .post(endpoint)
        .header("X-Keenable-Title", "Locally Uncensored")
        .json(&json!({ "query": query, "max_results": count.min(20) }));
    let text = match read_ok(req).await {
        Ok(t) => t,
        Err(e) => return Outcome::Failed(e),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => hits_or_empty(super::search::parse_keenable_results(&v, count), count),
        Err(e) => Outcome::Failed(format!("invalid JSON: {e}")),
    }
}

// ── DuckDuckGo ───────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
pub(crate) enum DdgPage {
    Lite,
    Html,
}

/// DuckDuckGo's answer to an automated request: HTTP 202 and a page with an
/// "anomaly" challenge, or the same page with 200. Either is a failure.
pub(crate) fn ddg_is_bot_check(status: u16, html: &str) -> bool {
    if status == 202 {
        return true;
    }
    let lower = html.to_ascii_lowercase();
    lower.contains("anomaly-modal")
        || lower.contains("anomaly.js")
        || lower.contains("challenge-form")
        || lower.contains("captcha")
        || lower.contains("bots use duckduckgo too")
}

/// The target of a result link. DuckDuckGo wraps it in `/l/?uddg=<target>`.
fn ddg_target(raw: &str) -> String {
    let raw = html_decode(raw);
    if let Some(pos) = raw.find("uddg=") {
        let after = &raw[pos + 5..];
        let enc = after.split('&').next().unwrap_or(after);
        return urlencoding::decode(enc).map(|c| c.into_owned()).unwrap_or_else(|_| enc.to_string());
    }
    if let Some(rest) = raw.strip_prefix("//") {
        return format!("https://{rest}");
    }
    raw
}

/// Results of a Lite or HTML page: each result link, and the first snippet
/// between it and the next link. Ads (`y.js`) are left out.
pub(crate) fn parse_ddg(html: &str, page: DdgPage) -> Vec<SearchResult> {
    let (link_class, snippet_class) = match page {
        DdgPage::Lite => ("result-link", "result-snippet"),
        DdgPage::Html => ("result__a", "result__snippet"),
    };
    let anchor = regex::Regex::new(&format!(
        r#"(?s)<a\b([^>]*\bclass\s*=\s*["'][^"']*\b{}\b[^"']*["'][^>]*)>(.*?)</a>"#,
        regex::escape(link_class)
    ))
    .unwrap();
    let href = regex::Regex::new(r#"\bhref\s*=\s*["']([^"']+)["']"#).unwrap();
    let snippet = regex::Regex::new(&format!(
        r#"(?s)class\s*=\s*["'][^"']*\b{}\b[^"']*["'][^>]*>(.*?)</(?:td|div|a|span)>"#,
        regex::escape(snippet_class)
    ))
    .unwrap();

    let anchors: Vec<(usize, usize, String, String)> = anchor
        .captures_iter(html)
        .filter_map(|c| {
            let whole = c.get(0)?;
            let link = href.captures(&c[1]).map(|h| ddg_target(&h[1]))?;
            Some((whole.start(), whole.end(), link, html_decode(&strip_html(&c[2])).trim().to_string()))
        })
        .collect();
    let mut out = Vec::new();
    for (i, (_, end, link, title)) in anchors.iter().enumerate() {
        if link.contains("duckduckgo.com/y.js") || link.contains("ad_domain=") {
            continue;
        }
        let stop = anchors.get(i + 1).map(|a| a.0).unwrap_or(html.len());
        let text = snippet
            .captures(&html[*end..stop])
            .map(|c| html_decode(&strip_html(&c[1])).split_whitespace().collect::<Vec<_>>().join(" "))
            .unwrap_or_default();
        out.push(SearchResult { title: title.clone(), url: link.clone(), snippet: text });
    }
    out
}

async fn ddg(query: &str, count: usize, endpoint: &str, page: DdgPage, ua: &str, timeout: Duration) -> Outcome {
    let client = match client(timeout, ua) {
        Ok(c) => c,
        Err(e) => return Outcome::Failed(e),
    };
    let resp = match client.post(endpoint).form(&[("q", query)]).send().await {
        Ok(r) => r,
        Err(e) => return Outcome::Failed(request_failed(&e)),
    };
    let status = resp.status();
    let html = match resp.text().await {
        Ok(t) => t,
        Err(e) => return Outcome::Failed(request_failed(&e)),
    };
    if ddg_is_bot_check(status.as_u16(), &html) {
        return Outcome::Failed(format!("bot check (HTTP {})", status.as_u16()));
    }
    if !status.is_success() {
        return Outcome::Failed(http_failed(status));
    }
    let results = parse_ddg(&html, page);
    if results.is_empty() {
        // A real empty page says so. Anything else is a page this parser does
        // not know, and calling that "nothing found" would be a guess.
        let lower = html.to_ascii_lowercase();
        if lower.contains("no results") || lower.contains("no-results") {
            return Outcome::Empty;
        }
        return Outcome::Failed("the result page could not be read".to_string());
    }
    hits_or_empty(results, count)
}

// ── Wikipedia ────────────────────────────────────────────────────────────

/// Wikipedia, as the last tier: the attempts of `wiki_versuche`, each with a
/// User-Agent. An attempt that finds nothing tries the next; one that fails
/// (403, 429, no answer) ends the tier, because the next would fail the same.
async fn wikipedia(query: &str, count: usize, template: &str, ua: &str, per_try: Duration, left: Duration) -> Outcome {
    let started = Instant::now();
    let attempts = super::search::wiki_versuche(query, 4);
    if attempts.is_empty() {
        return Outcome::Empty;
    }
    let mut found_nothing = false;
    for (lang, attempt) in attempts {
        let rest = left.saturating_sub(started.elapsed());
        if rest.is_zero() {
            break;
        }
        match wikipedia_once(lang, &attempt, count, template, ua, per_try.min(rest)).await {
            Outcome::Empty => found_nothing = true,
            other => return other,
        }
    }
    if found_nothing {
        Outcome::Empty
    } else {
        Outcome::Failed("out of time".to_string())
    }
}

async fn wikipedia_once(lang: &str, query: &str, count: usize, template: &str, ua: &str, timeout: Duration) -> Outcome {
    let client = match client(timeout, ua) {
        Ok(c) => c,
        Err(e) => return Outcome::Failed(e),
    };
    let endpoint = template.replace("{lang}", lang);
    let limit = count.to_string();
    let req = client.get(&endpoint).query(&[
        ("action", "query"),
        ("list", "search"),
        ("srsearch", query),
        ("format", "json"),
        ("srlimit", limit.as_str()),
    ]);
    let text = match read_ok(req).await {
        Ok(t) => t,
        Err(e) => return Outcome::Failed(e),
    };
    let json: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => return Outcome::Failed(format!("invalid JSON: {e}")),
    };
    let results = json
        .pointer("/query/search")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let title = r.get("title")?.as_str()?;
                    Some(SearchResult {
                        title: title.to_string(),
                        // The address carries the wiki that was asked: a hit
                        // of de.wikipedia under an en address is a 404.
                        url: format!("https://{}.wikipedia.org/wiki/{}", lang, urlencoding::encode(&title.replace(' ', "_"))),
                        snippet: r
                            .get("snippet")
                            .and_then(|s| s.as_str())
                            .map(|s| html_decode(&strip_html(s)))
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    hits_or_empty(results, count)
}

// ── Text helpers ─────────────────────────────────────────────────────────

pub(crate) fn clip_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

/// Cut at `FETCH_MAX_CHARS`, and say whether it was cut. From Jan.
pub(crate) fn bound_text(s: &str) -> (String, bool) {
    if s.chars().count() <= FETCH_MAX_CHARS {
        (s.to_string(), false)
    } else {
        (s.chars().take(FETCH_MAX_CHARS).collect(), true)
    }
}

#[cfg(test)]
#[path = "search_tier_tests.rs"]
mod search_tier_tests;
