//! Every tier of `web_search` and the reader fallback of `web_fetch` against
//! a local stub server: results, empty, 202 and the bot check page, 403, a
//! timeout, and the fall to the next tier. No test here reaches the network.

use super::*;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// One request the stub saw.
#[derive(Clone, Debug)]
struct Seen {
    path: String,
    /// Header names in lower case.
    headers: Vec<(String, String)>,
    body: String,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

struct Reply {
    status: u16,
    content_type: &'static str,
    body: String,
    delay: Duration,
}

fn reply(status: u16, content_type: &'static str, body: impl Into<String>) -> Reply {
    Reply { status, content_type, body: body.into(), delay: Duration::ZERO }
}

fn slow(mut r: Reply, delay: Duration) -> Reply {
    r.delay = delay;
    r
}

type Handler = Arc<dyn Fn(&Seen) -> Reply + Send + Sync>;

struct Stub {
    base: String,
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Stub {
    fn hits(&self, prefix: &str) -> Vec<Seen> {
        self.seen.lock().unwrap().iter().filter(|s| s.path.starts_with(prefix)).cloned().collect()
    }

    fn endpoints(&self) -> Endpoints {
        Endpoints {
            exa_mcp: format!("{}/exa", self.base),
            exa_rest_search: format!("{}/exa-rest", self.base),
            you_mcp: format!("{}/you?profile=free", self.base),
            searxng: format!("{}/searxng", self.base),
            ddg_lite: format!("{}/lite/", self.base),
            ddg_html: format!("{}/html/", self.base),
            wikipedia: format!("{}/wiki/{{lang}}/w/api.php", self.base),
            brave: format!("{}/brave", self.base),
            tavily: format!("{}/tavily", self.base),
            keenable: format!("{}/keenable", self.base),
        }
    }
}

async fn stub<F>(answer: F) -> Stub
where
    F: Fn(&Seen) -> Reply + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen: Arc<Mutex<Vec<Seen>>> = Arc::new(Mutex::new(Vec::new()));
    let handler: Handler = Arc::new(answer);
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            let handler = handler.clone();
            let log = log.clone();
            tokio::spawn(async move {
                let mut buf: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 8192];
                let head_end = loop {
                    let Ok(n) = sock.read(&mut chunk).await else { return };
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let mut lines = head.split("\r\n");
                let path = lines.next().unwrap_or("").split(' ').nth(1).unwrap_or("").to_string();
                let headers: Vec<(String, String)> = lines
                    .filter_map(|l| l.split_once(':'))
                    .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
                    .collect();
                let len: usize = headers
                    .iter()
                    .find(|(k, _)| k == "content-length")
                    .and_then(|(_, v)| v.parse().ok())
                    .unwrap_or(0);
                while buf.len() < head_end + len {
                    let Ok(n) = sock.read(&mut chunk).await else { return };
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let body = String::from_utf8_lossy(&buf[head_end..]).to_string();
                let seen = Seen { path, headers, body };
                log.lock().unwrap().push(seen.clone());
                let r = handler(&seen);
                if !r.delay.is_zero() {
                    tokio::time::sleep(r.delay).await;
                }
                let out = format!(
                    "HTTP/1.1 {} X\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    r.status,
                    r.content_type,
                    r.body.len(),
                    r.body
                );
                let _ = sock.write_all(out.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    Stub { base: format!("http://127.0.0.1:{port}"), port, seen }
}

fn fast() -> Timing {
    Timing {
        hosted: Duration::from_millis(1500),
        searxng: Duration::from_millis(1500),
        page: Duration::from_millis(1500),
        total: Duration::from_secs(20),
    }
}

fn request<'a>(query: &'a str, provider: &'a str) -> Request<'a> {
    Request { query, count: 5, provider, keys: Keys::default(), user_agent: None, searxng_running: false }
}

// ── What each service answers ────────────────────────────────────────────

const JSON: &str = "application/json";
const SSE: &str = "text/event-stream";
const HTML: &str = "text/html; charset=utf-8";

fn sse(v: Value) -> String {
    format!("event: message\ndata: {}\n\n", v)
}

fn exa_hits() -> Reply {
    let text = "Title: Rust\nURL: https://www.rust-lang.org/\nPublished: N/A\nAuthor: N/A\nHighlights:\n#####\nA language empowering everyone.\n...\n---\nTitle: Rust (programming language)\nURL: https://en.wikipedia.org/wiki/Rust_(programming_language)\nPublished: N/A\nAuthor: N/A\nHighlights:\nRust is a general-purpose language.";
    reply(200, SSE, sse(json!({"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": text}]}})))
}

fn exa_empty() -> Reply {
    reply(200, SSE, sse(json!({"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": ""}]}})))
}

fn exa_rate_limited() -> Reply {
    reply(
        200,
        SSE,
        sse(json!({"jsonrpc": "2.0", "id": 1, "result": {
            "_meta": {"ai.exa/rateLimited": true},
            "content": [{"type": "text", "text": "You've hit Exa's free MCP rate limit."}]
        }})),
    )
}

fn you_hits() -> Reply {
    let payload = json!({"results": {"web": [
        {"url": "https://doc.rust-lang.org/book/", "title": "The Rust Book", "description": "Learn Rust."},
        {"url": "https://crates.io/", "title": "crates.io", "snippets": ["The Rust package registry."]}
    ], "news": []}});
    let notice = json!({"jsonrpc": "2.0", "method": "notifications/message", "params": {"level": "info", "data": "Search successful"}});
    let answer = json!({"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": payload.to_string()}]}});
    reply(200, SSE, format!("{}{}", sse(notice), sse(answer)))
}

fn you_empty() -> Reply {
    let payload = json!({"results": {"web": [], "news": []}});
    reply(200, SSE, sse(json!({"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": payload.to_string()}]}})))
}

fn searxng_hits() -> Reply {
    reply(200, JSON, json!({"results": [{"title": "SearX hit", "url": "https://searx.example/a", "content": "From SearXNG"}]}).to_string())
}

const DDG_LITE_HITS: &str = r#"<html><body><form action="/lite/" method="post"><input name="q"></form>
<table border="0">
<tr><td valign="top">1.&nbsp;</td><td><a rel="nofollow" href="https://duckduckgo.com/y.js?ad_domain=ads.example&amp;u3=x" class='result-link'>An ad</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>Buy now.</td></tr>
<tr><td valign="top">2.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rust%2Dlang.org%2Flearn&amp;rut=abc" class='result-link'>Learn <b>Rust</b></a></td></tr>
<tr><td>&nbsp;&nbsp;&nbsp;</td><td class='result-snippet'>Get started with <b>Rust</b> &amp; Cargo.</td></tr>
<tr><td>&nbsp;&nbsp;&nbsp;</td><td><span class='link-text'>www.rust-lang.org/learn</span></td></tr>
<tr><td valign="top">3.&nbsp;</td><td><a rel="nofollow" href="https://blog.rust-lang.org/" class='result-link'>Rust Blog</a></td></tr>
<tr><td>&nbsp;&nbsp;&nbsp;</td><td class='result-snippet'>Empowering everyone.</td></tr>
</table></body></html>"#;

const DDG_HTML_HITS: &str = r#"<html><body><div class="results">
<div class="result results_links results_links_deep web-result"><div class="links_main links_deep result__body">
<h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.rs%2Freqwest&amp;rut=1">reqwest - Rust</a></h2>
<div class="result__extras"><a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.rs%2Freqwest">docs.rs/reqwest</a></div>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.rs%2Freqwest">An ergonomic HTTP <b>Client</b>.</a>
</div></div></div></body></html>"#;

/// DuckDuckGo's answer to an automated request, cut down: HTTP 202 and the
/// anomaly challenge (as measured from this Mac, 20.10.2026).
const DDG_BOT_PAGE: &str = r#"<!DOCTYPE html><html><head><title>DuckDuckGo</title></head><body>
<form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=lite&amp;cc=sre" method="POST"></form>
<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></body></html>"#;

const DDG_NO_RESULTS: &str = r#"<html><body><table><tr><td>No results.</td></tr></table></body></html>"#;

fn wiki_hits(lang: &str) -> Reply {
    reply(
        200,
        JSON,
        json!({"batchcomplete": "", "query": {"search": [
            {"title": format!("Treffer {lang}"), "snippet": "Ein <span class=\"searchmatch\">Treffer</span> &amp; mehr"}
        ]}})
        .to_string(),
    )
}

fn wiki_empty() -> Reply {
    reply(200, JSON, json!({"batchcomplete": "", "query": {"search": []}}).to_string())
}

fn wikimedia_rule(s: &Seen) -> Option<Reply> {
    // Wikimedia's rule: no User-Agent, 403.
    if s.header("user-agent").unwrap_or("").is_empty() {
        return Some(reply(403, "text/plain", "Please set a user-agent and respect our robot policy"));
    }
    None
}

fn dead(_: &Seen) -> Reply {
    reply(503, "text/plain", "down")
}

fn tiers_of(v: &Value) -> Vec<(String, String)> {
    v["tried"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| (t["tier"].as_str().unwrap().to_string(), t["outcome"].as_str().unwrap().to_string()))
        .collect()
}

fn pair(tier: &str, outcome: &str) -> (String, String) {
    (tier.to_string(), outcome.to_string())
}

// ── The order ────────────────────────────────────────────────────────────

#[test]
fn auto_asks_exa_you_searxng_duckduckgo_wikipedia_in_this_order() {
    let mut req = request("q", "auto");
    assert_eq!(chain(&req), vec![Tier::Exa, Tier::You, Tier::DuckDuckGo, Tier::Wikipedia]);
    req.searxng_running = true;
    assert_eq!(chain(&req), vec![Tier::Exa, Tier::You, Tier::Searxng, Tier::DuckDuckGo, Tier::Wikipedia]);
}

#[test]
fn a_key_puts_its_service_first_and_a_chosen_tier_goes_before_all() {
    let mut req = request("q", "auto");
    req.keys.brave = "BSA-x".into();
    req.keys.tavily = "tvly-x".into();
    assert_eq!(chain(&req)[..3], [Tier::Brave, Tier::Tavily, Tier::Exa]);
    let req = request("q", "wikipedia");
    assert_eq!(chain(&req), vec![Tier::Wikipedia, Tier::Exa, Tier::You, Tier::DuckDuckGo]);
    let req = request("q", "searxng");
    assert_eq!(chain(&req)[0], Tier::Searxng, "a chosen SearXNG is asked even before its probe answered");
    assert_eq!(chain(&request("q", "something-else")), chain(&request("q", "auto")));
}

// ── Exa ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn exa_with_results_answers_and_nothing_else_is_asked() {
    let s = stub(|r| if r.path == "/exa" { exa_hits() } else { dead(r) }).await;
    let v = run(&request("rust", "auto"), &s.endpoints(), &fast()).await;
    assert_eq!(v["provider"], "exa");
    let results = v["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0]["url"], "https://www.rust-lang.org/");
    assert_eq!(results[0]["snippet"], "A language empowering everyone.");
    assert_eq!(s.hits("/you").len(), 0);
    let exa = &s.hits("/exa")[0];
    let body: Value = serde_json::from_str(&exa.body).unwrap();
    assert_eq!(body["method"], "tools/call");
    assert_eq!(body["params"]["name"], "web_search_exa");
    assert_eq!(body["params"]["arguments"]["query"], "rust");
    assert_eq!(exa.header("user-agent"), Some(APP_USER_AGENT.as_str()));
    assert!(exa.header("x-api-key").is_none(), "keyless");
}

#[tokio::test]
async fn exa_empty_falls_to_you_com() {
    let s = stub(|r| match r.path.as_str() {
        "/exa" => exa_empty(),
        p if p.starts_with("/you") => you_hits(),
        _ => dead(r),
    })
    .await;
    let v = run(&request("rust book", "auto"), &s.endpoints(), &fast()).await;
    assert_eq!(v["provider"], "you");
    assert_eq!(tiers_of(&v), vec![pair("exa", "empty"), pair("you", "results")]);
    let results = v["results"].as_array().unwrap();
    assert_eq!(results[0]["snippet"], "Learn Rust.");
    assert_eq!(results[1]["snippet"], "The Rust package registry.", "snippets when there is no description");
    let you = &s.hits("/you")[0];
    assert_eq!(you.path, "/you?profile=free");
    let body: Value = serde_json::from_str(&you.body).unwrap();
    assert_eq!(body["params"]["name"], "you-search");
    assert_eq!(you.header("x-client-info").map(|c| c.starts_with("plugin; client=locally-uncensored/")), Some(true));
    assert_eq!(you.headers.iter().filter(|(k, _)| k == "content-type").count(), 1, "one Content-Type, a second is a 415");
}

#[tokio::test]
async fn an_exa_rate_limit_is_a_failure_not_an_empty_web() {
    let s = stub(|r| match r.path.as_str() {
        "/exa" => exa_rate_limited(),
        p if p.starts_with("/you") => you_hits(),
        _ => dead(r),
    })
    .await;
    let v = run(&request("rust", "auto"), &s.endpoints(), &fast()).await;
    assert_eq!(v["provider"], "you");
    assert_eq!(v["tried"][0]["outcome"], "failed");
    assert_eq!(v["tried"][0]["detail"], "rate limit reached");
}

#[tokio::test]
async fn exa_403_and_exa_timeout_fall_to_the_next_tier() {
    for exa in ["403", "slow"] {
        let s = stub(move |r| match r.path.as_str() {
            "/exa" if exa == "403" => reply(403, "text/plain", "no"),
            "/exa" => slow(exa_hits(), Duration::from_secs(4)),
            p if p.starts_with("/you") => you_hits(),
            _ => dead(r),
        })
        .await;
        let started = Instant::now();
        let v = run(&request("rust", "auto"), &s.endpoints(), &fast()).await;
        assert_eq!(v["provider"], "you", "{exa}");
        let detail = v["tried"][0]["detail"].as_str().unwrap();
        if exa == "403" {
            assert_eq!(detail, "HTTP 403 (refused)");
        } else {
            assert_eq!(detail, "timed out");
            assert!(started.elapsed() < Duration::from_secs(4), "the tier waited past its own timeout");
        }
    }
}

#[tokio::test]
async fn an_exa_key_uses_the_rest_api_with_that_key() {
    let s = stub(|r| match r.path.as_str() {
        "/exa-rest" => reply(200, JSON, json!({"results": [{"title": "T", "url": "https://t.example/", "highlights": ["H"]}]}).to_string()),
        _ => dead(r),
    })
    .await;
    let mut req = request("rust", "auto");
    req.keys.exa = "exa-key-1".into();
    let v = run(&req, &s.endpoints(), &fast()).await;
    assert_eq!(v["provider"], "exa");
    assert_eq!(v["results"][0]["snippet"], "H");
    assert_eq!(s.hits("/exa-rest")[0].header("x-api-key"), Some("exa-key-1"));
    assert_eq!(s.hits("/exa").iter().filter(|h| h.path == "/exa").count(), 0, "the keyless endpoint is not asked");
}

// ── You.com ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn you_com_empty_and_failed_fall_on() {
    let s = stub(|r| match r.path.as_str() {
        "/exa" => reply(500, "text/plain", "boom"),
        p if p.starts_with("/you") => you_empty(),
        "/lite/" => reply(200, HTML, DDG_LITE_HITS),
        _ => dead(r),
    })
    .await;
    let v = run(&request("rust", "auto"), &s.endpoints(), &fast()).await;
    assert_eq!(v["provider"], "duckduckgo");
    assert_eq!(tiers_of(&v), vec![pair("exa", "failed"), pair("you", "empty"), pair("duckduckgo", "results")]);
}

#[tokio::test]
async fn you_com_tool_error_is_a_failure() {
    let s = stub(|r| match r.path.as_str() {
        p if p.starts_with("/you") => reply(
            200,
            SSE,
            sse(json!({"jsonrpc": "2.0", "id": 1, "result": {"isError": true, "content": [{"type": "text", "text": "quota"}]}})),
        ),
        _ => dead(r),
    })
    .await;
    let v = run(&request("rust", "you"), &s.endpoints(), &fast()).await;
    assert_eq!(v["tried"][0]["tier"], "you");
    assert_eq!(v["tried"][0]["detail"], "tool error: quota");
    assert_eq!(v["providerError"], "tool error: quota");
}

// ── SearXNG ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn searxng_is_asked_when_it_runs_and_skipped_when_it_does_not() {
    let s = stub(|r| match r.path.as_str() {
        p if p.starts_with("/searxng") => searxng_hits(),
        _ => dead(r),
    })
    .await;
    let mut req = request("rust", "auto");
    let off = run(&req, &s.endpoints(), &fast()).await;
    assert_eq!(off["unavailable"], true);
    assert_eq!(s.hits("/searxng").len(), 0);
    req.searxng_running = true;
    let on = run(&req, &s.endpoints(), &fast()).await;
    assert_eq!(on["provider"], "searxng");
    assert!(s.hits("/searxng")[0].path.contains("format=json"));
}

// ── DuckDuckGo ───────────────────────────────────────────────────────────

#[tokio::test]
async fn duckduckgo_lite_results_are_read_without_the_ads() {
    let s = stub(|r| match r.path.as_str() {
        "/lite/" => reply(200, HTML, DDG_LITE_HITS),
        _ => dead(r),
    })
    .await;
    let v = run(&request("rust", "duckduckgo"), &s.endpoints(), &fast()).await;
    assert_eq!(v["provider"], "duckduckgo");
    let r = v["results"].as_array().unwrap();
    assert_eq!(r.len(), 2, "{r:?}");
    assert_eq!(r[0]["url"], "https://www.rust-lang.org/learn");
    assert_eq!(r[0]["title"], "Learn Rust");
    assert_eq!(r[0]["snippet"], "Get started with Rust & Cargo.");
    assert_eq!(r[1]["url"], "https://blog.rust-lang.org/");
    let lite = &s.hits("/lite/")[0];
    assert_eq!(lite.body, "q=rust");
    assert_eq!(lite.header("user-agent"), Some(DDG_USER_AGENT));
    assert_eq!(s.hits("/html/").len(), 0);
}

#[tokio::test]
async fn a_202_bot_page_is_a_failure_and_the_html_page_is_tried() {
    let s = stub(|r| match r.path.as_str() {
        "/lite/" => reply(202, HTML, DDG_BOT_PAGE),
        "/html/" => reply(200, HTML, DDG_HTML_HITS),
        _ => dead(r),
    })
    .await;
    let v = run(&request("reqwest", "duckduckgo"), &s.endpoints(), &fast()).await;
    assert_eq!(v["provider"], "duckduckgo");
    assert_eq!(v["results"][0]["url"], "https://docs.rs/reqwest");
    assert_eq!(v["results"][0]["snippet"], "An ergonomic HTTP Client.");
}

#[tokio::test]
async fn the_bot_page_is_never_an_empty_result_even_with_200() {
    for status in [202u16, 200] {
        let s = stub(move |r| match r.path.as_str() {
            "/lite/" | "/html/" => reply(status, HTML, DDG_BOT_PAGE),
            _ => dead(r),
        })
        .await;
        let v = run(&request("reqwest", "duckduckgo"), &s.endpoints(), &fast()).await;
        let ddg = v["tried"].as_array().unwrap().iter().find(|t| t["tier"] == "duckduckgo").unwrap().clone();
        assert_eq!(ddg["outcome"], "failed", "{status}");
        assert!(ddg["detail"].as_str().unwrap().contains("bot check"), "{ddg}");
        assert_eq!(v["unavailable"], true, "{status}: a bot page must not read as 'nothing found'");
        assert!(v.get("noResults").is_none());
    }
}

#[tokio::test]
async fn a_duckduckgo_page_with_no_results_is_empty() {
    let s = stub(|r| match r.path.as_str() {
        "/lite/" | "/html/" => reply(200, HTML, DDG_NO_RESULTS),
        _ => dead(r),
    })
    .await;
    let v = run(&request("zzqx", "duckduckgo"), &s.endpoints(), &fast()).await;
    assert_eq!(v["tried"][0]["outcome"], "empty");
}

#[tokio::test]
async fn a_user_agent_from_settings_goes_to_duckduckgo_and_wikipedia() {
    let s = stub(|r| match r.path.as_str() {
        "/lite/" | "/html/" => reply(202, HTML, DDG_BOT_PAGE),
        p if p.starts_with("/wiki/en/") => wiki_hits("en"),
        _ => dead(r),
    })
    .await;
    let mut req = request("rust language", "auto");
    req.user_agent = Some("MyBrowser/9.0");
    let v = run(&req, &s.endpoints(), &fast()).await;
    assert_eq!(v["provider"], "wikipedia");
    assert_eq!(s.hits("/lite/")[0].header("user-agent"), Some("MyBrowser/9.0"));
    assert_eq!(s.hits("/wiki/")[0].header("user-agent"), Some("MyBrowser/9.0"));
    assert_eq!(s.hits("/exa")[0].header("user-agent"), Some(APP_USER_AGENT.as_str()), "the APIs keep the app's name");
}

// ── Wikipedia ────────────────────────────────────────────────────────────

#[tokio::test]
async fn wikipedia_is_always_asked_with_a_user_agent() {
    let s = stub(|r| {
        if r.path.starts_with("/wiki/") {
            return wikimedia_rule(r).unwrap_or_else(|| wiki_hits("en"));
        }
        dead(r)
    })
    .await;
    let v = run(&request("rust language", "auto"), &s.endpoints(), &fast()).await;
    assert_eq!(v["provider"], "wikipedia");
    let wiki = &s.hits("/wiki/")[0];
    assert_eq!(wiki.header("user-agent"), Some(APP_USER_AGENT.as_str()));
    assert!(APP_USER_AGENT.starts_with("LocallyUncensored/") && APP_USER_AGENT.ends_with("(+https://lu-labs.ai)"));
    assert!(wiki.path.starts_with("/wiki/en/w/api.php?action=query&list=search&srsearch=rust+language"));
    assert_eq!(v["results"][0]["url"], "https://en.wikipedia.org/wiki/Treffer_en");
    assert_eq!(v["results"][0]["snippet"], "Ein Treffer & mehr");
}

#[tokio::test]
async fn a_wikipedia_403_ends_the_tier_at_once() {
    let s = stub(|r| if r.path.starts_with("/wiki/") { reply(403, "text/plain", "no") } else { dead(r) }).await;
    let v = run(&request("a b c d", "wikipedia"), &s.endpoints(), &fast()).await;
    assert_eq!(s.hits("/wiki/").len(), 1, "a refusal is not retried with fewer words");
    assert_eq!(v["providerError"], "HTTP 403 (refused)");
    assert_eq!(v["unavailable"], true);
}

#[tokio::test]
async fn wikipedia_empty_tries_shorter_and_the_other_language() {
    let s = stub(|r| {
        if r.path.starts_with("/wiki/de/") && r.path.contains("srsearch=Transparenzgesetz+Hamburg&") {
            return wiki_hits("de");
        }
        if r.path.starts_with("/wiki/") {
            return wiki_empty();
        }
        dead(r)
    })
    .await;
    let v = run(&request("Transparenzgesetz Hamburg Antragsfristen", "wikipedia"), &s.endpoints(), &fast()).await;
    assert_eq!(v["provider"], "wikipedia");
    assert_eq!(s.hits("/wiki/").len(), 2);
    assert_eq!(v["results"][0]["url"], "https://de.wikipedia.org/wiki/Treffer_de");
}

// ── The end of the chain ─────────────────────────────────────────────────

#[tokio::test]
async fn when_every_tier_fails_the_model_is_told_not_to_search_again() {
    let s = stub(|r| match r.path.as_str() {
        "/exa" => reply(429, "text/plain", "slow down"),
        p if p.starts_with("/you") => slow(you_hits(), Duration::from_secs(4)),
        "/lite/" | "/html/" => reply(202, HTML, DDG_BOT_PAGE),
        p if p.starts_with("/wiki/") => reply(403, "text/plain", "no"),
        _ => dead(r),
    })
    .await;
    let v = run(&request("anything", "auto"), &s.endpoints(), &fast()).await;
    assert_eq!(v["results"].as_array().unwrap().len(), 0);
    assert_eq!(v["unavailable"], true);
    assert_eq!(
        v["error"],
        "Web search is unavailable right now. Do not repeat the same search. Answer from what you know and say that you could not search."
    );
    assert_eq!(
        tiers_of(&v),
        vec![pair("exa", "failed"), pair("you", "failed"), pair("duckduckgo", "failed"), pair("wikipedia", "failed")]
    );
    let details: Vec<&str> = v["tried"].as_array().unwrap().iter().map(|t| t["detail"].as_str().unwrap()).collect();
    assert_eq!(details[0], "HTTP 429 (rate limit)");
    assert_eq!(details[1], "timed out");
    assert!(details[2].contains("bot check"));
    assert_eq!(details[3], "HTTP 403 (refused)");
}

#[tokio::test]
async fn when_tiers_answer_but_find_nothing_it_says_no_results_not_unavailable() {
    let s = stub(|r| match r.path.as_str() {
        "/exa" => exa_empty(),
        p if p.starts_with("/you") => you_empty(),
        "/lite/" | "/html/" => reply(202, HTML, DDG_BOT_PAGE),
        p if p.starts_with("/wiki/") => wiki_empty(),
        _ => dead(r),
    })
    .await;
    let v = run(&request("zzqx qqzz", "auto"), &s.endpoints(), &fast()).await;
    assert_eq!(v["noResults"], true);
    assert!(v.get("unavailable").is_none());
    assert!(v.get("error").is_none());
}

#[tokio::test]
async fn a_chosen_tier_that_fails_is_named_and_auto_carries_on() {
    let s = stub(|r| match r.path.as_str() {
        p if p.starts_with("/brave?") => reply(401, JSON, "{}"),
        "/exa" => exa_hits(),
        _ => dead(r),
    })
    .await;
    let mut req = request("rust", "brave");
    req.keys.brave = "BSA-bad".into();
    let v = run(&req, &s.endpoints(), &fast()).await;
    assert_eq!(v["provider"], "exa");
    assert_eq!(v["providerError"], "HTTP 401 (check the API key)");
    assert_eq!(s.hits("/brave")[0].header("x-subscription-token"), Some("BSA-bad"));
    // Brave chosen without a key: said so, and the search still runs.
    let v = run(&request("rust", "brave"), &s.endpoints(), &fast()).await;
    assert_eq!(v["provider"], "exa");
    assert!(v["providerError"].as_str().unwrap().contains("no API key"));
}

#[tokio::test]
async fn tavily_with_a_key_answers() {
    let s = stub(|r| match r.path.as_str() {
        "/tavily" => reply(200, JSON, json!({"results": [{"title": "Doc", "url": "https://docs.example/", "content": "Body"}]}).to_string()),
        _ => dead(r),
    })
    .await;
    let mut req = request("rust", "auto");
    req.keys.tavily = "tvly-1".into();
    let v = run(&req, &s.endpoints(), &fast()).await;
    assert_eq!(v["provider"], "tavily");
    let t = &s.hits("/tavily")[0];
    assert_eq!(t.header("authorization"), Some("Bearer tvly-1"));
}

#[tokio::test]
async fn keenable_chosen_answers_without_a_key() {
    let s = stub(|r| match r.path.as_str() {
        "/keenable" => reply(200, JSON, json!({"results": [{"title": "Doc", "url": "https://docs.example/", "description": "", "snippet": "Body"}]}).to_string()),
        _ => dead(r),
    })
    .await;
    let v = run(&request("rust", "keenable"), &s.endpoints(), &fast()).await;
    assert_eq!(v["provider"], "keenable");
    assert_eq!(v["results"][0]["snippet"], "Body");
    assert_eq!(s.hits("/keenable")[0].header("x-keenable-title"), Some("Locally Uncensored"));
}

#[test]
fn keenable_is_not_in_auto() {
    assert!(!chain(&request("q", "auto")).contains(&Tier::Keenable));
    assert_eq!(chain(&request("q", "keenable"))[0], Tier::Keenable);
}

#[tokio::test]
async fn the_whole_chain_ends_inside_its_deadline() {
    let s = stub(|r| slow(dead(r), Duration::from_secs(3))).await;
    let timing = Timing { total: Duration::from_millis(2500), ..fast() };
    let started = Instant::now();
    let v = run(&request("rust", "auto"), &s.endpoints(), &timing).await;
    assert!(started.elapsed() < Duration::from_millis(3500), "{:?}", started.elapsed());
    assert_eq!(v["unavailable"], true);
    assert!(v["tried"].as_array().unwrap().iter().any(|t| t["outcome"] == "skipped"));
}

#[test]
fn results_without_a_web_address_are_dropped() {
    let out = hits_or_empty(
        vec![
            SearchResult { title: "a".into(), url: "javascript:alert(1)".into(), snippet: String::new() },
            SearchResult { title: "b".into(), url: "".into(), snippet: String::new() },
        ],
        5,
    );
    assert_eq!(out, Outcome::Empty);
}

#[test]
fn the_hosted_answer_is_read_from_sse_and_from_plain_json() {
    assert_eq!(
        parse_hosted_result_text("event: message\ndata: {\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}\n\n").unwrap(),
        "hi"
    );
    assert_eq!(parse_hosted_result_text("{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}").unwrap(), "hi");
    assert!(parse_hosted_result_text("{\"error\":{\"code\":-32000,\"message\":\"boom\"}}").unwrap_err().contains("boom"));
    assert!(parse_hosted_result_text("<html>gateway</html>").is_err());
}

// ── web_fetch: the local read and the Exa reader ─────────────────────────

/// Names ending in `.test` stand for public names and answer loopback, where
/// the stub lives. Everything else goes through the real gate.
fn stub_gate() -> crate::commands::web_reach::Gate {
    Arc::new(|raw: &str| {
        let parsed = url::Url::parse(raw).map_err(|e| e.to_string())?;
        let port = parsed.port_or_known_default().unwrap_or(80);
        if parsed.host_str().unwrap_or("").ends_with(".test") {
            return Ok(vec![std::net::SocketAddr::new("127.0.0.1".parse().unwrap(), port)]);
        }
        crate::commands::web_reach::model_url_addrs(raw)
    })
}

fn article(paragraphs: usize) -> String {
    let p = "<p>The Rust compiler checks every borrow before the program runs, so a whole class of memory errors never reaches a user. This paragraph says it at length so that Readability has an article to score.</p>";
    format!(
        "<!doctype html><html><head><title>Rust article</title></head><body><nav><a href=\"/\">Home</a> <a href=\"/a\">About</a> <a href=\"/b\">Blog</a> Menu entry one Menu entry two</nav><article><h1>Borrowing</h1>{}</article><footer>Copyright footer text</footer></body></html>",
        p.repeat(paragraphs)
    )
}

fn exa_page() -> Reply {
    reply(
        200,
        SSE,
        sse(json!({"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": "# Read by Exa\nURL: https://page.test/\n\nThe text Exa read from the page."}]}})),
    )
}

#[tokio::test]
async fn a_readable_page_is_read_locally_and_exa_is_never_asked() {
    let s = stub(|r| match r.path.as_str() {
        "/page" => reply(200, HTML, article(6)),
        "/exa" => exa_page(),
        _ => dead(r),
    })
    .await;
    let url = format!("http://page.test:{}/page", s.port);
    let v = crate::commands::search::web_fetch_with(&url, None, stub_gate(), &format!("{}/exa", s.base), Duration::from_secs(2))
        .await
        .unwrap();
    assert!(v.get("via").is_none());
    assert_eq!(v["title"], "Rust article");
    let text = v["text"].as_str().unwrap();
    assert!(text.contains("checks every borrow"), "{text}");
    assert!(!text.contains("Menu entry"), "Readability leaves the navigation out: {text}");
    assert!(!text.contains("Copyright footer"), "{text}");
    assert_eq!(s.hits("/exa").len(), 0);
}

#[tokio::test]
async fn a_long_page_is_cut_at_forty_thousand_characters() {
    let s = stub(|r| if r.path == "/long" { reply(200, HTML, article(400)) } else { dead(r) }).await;
    let url = format!("http://page.test:{}/long", s.port);
    let v = crate::commands::search::web_fetch_with(&url, None, stub_gate(), &format!("{}/exa", s.base), Duration::from_secs(2))
        .await
        .unwrap();
    assert_eq!(v["truncated"], true);
    assert_eq!(v["text"].as_str().unwrap().chars().count(), FETCH_MAX_CHARS);
}

#[tokio::test]
async fn a_refused_or_javascript_page_is_read_through_exa() {
    let js_shell = "<!doctype html><html><head><title>App</title></head><body><noscript>You need to enable JavaScript to run this app.</noscript><div id=\"root\"></div></body></html>";
    for (path, status, body) in [
        ("/blocked", 403u16, "<html><body>Access denied</body></html>".to_string()),
        ("/cloudflare", 503, "<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>".to_string()),
        ("/js", 200, js_shell.to_string()),
    ] {
        let s = stub(move |r| match r.path.as_str() {
            p if p == path => reply(status, HTML, body.clone()),
            "/exa" => exa_page(),
            _ => dead(r),
        })
        .await;
        let url = format!("http://page.test:{}{}", s.port, path);
        let v = crate::commands::search::web_fetch_with(&url, None, stub_gate(), &format!("{}/exa", s.base), Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(v["via"], "exa", "{path}");
        assert_eq!(v["status"], 200);
        assert_eq!(v["title"], "Read by Exa");
        assert_eq!(v["text"], "The text Exa read from the page.");
        let exa: Value = serde_json::from_str(&s.hits("/exa")[0].body).unwrap();
        assert_eq!(exa["params"]["name"], "web_fetch_exa");
        assert_eq!(exa["params"]["arguments"]["urls"][0], url.as_str());
        assert_eq!(exa["params"]["arguments"]["maxCharacters"], FETCH_MAX_CHARS);
    }
}

#[tokio::test]
async fn a_local_read_that_cannot_connect_is_read_through_exa() {
    let s = stub(|r| match r.path.as_str() {
        "/exa" => exa_page(),
        _ => dead(r),
    })
    .await;
    // A name with no stub behind it: the local read cannot connect.
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = closed.local_addr().unwrap().port();
    drop(closed);
    let url = format!("http://gone.test:{port}/");
    let v = crate::commands::search::web_fetch_with(&url, None, stub_gate(), &format!("{}/exa", s.base), Duration::from_secs(2))
        .await
        .unwrap();
    assert_eq!(v["via"], "exa");
    assert!(v["localProblem"].as_str().unwrap().starts_with("the local read failed"));
}

#[tokio::test]
async fn a_404_stays_a_404_and_exa_is_not_asked() {
    let s = stub(|r| if r.path == "/exa" { exa_page() } else { reply(404, HTML, "<html><title>Not found</title></html>") }).await;
    let url = format!("http://page.test:{}/missing", s.port);
    let v = crate::commands::search::web_fetch_with(&url, None, stub_gate(), &format!("{}/exa", s.base), Duration::from_secs(2))
        .await
        .unwrap();
    assert_eq!(v["status"], 404);
    assert_eq!(s.hits("/exa").len(), 0);
}

#[tokio::test]
async fn a_closed_address_never_leaves_this_computer() {
    let s = stub(|r| if r.path == "/exa" { exa_page() } else { dead(r) }).await;
    for url in ["http://127.0.0.1:9/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/"] {
        let err = crate::commands::search::web_fetch_with(url, None, stub_gate(), &format!("{}/exa", s.base), Duration::from_secs(2))
            .await
            .unwrap_err();
        assert!(err.starts_with("Blocked"), "{url}: {err}");
    }
    assert_eq!(s.hits("/exa").len(), 0);
}

#[tokio::test]
async fn when_exa_fails_too_the_local_answer_stands_with_the_reason() {
    let s = stub(|r| match r.path.as_str() {
        "/blocked" => reply(403, HTML, "<html><body>Forbidden</body></html>"),
        _ => reply(500, "text/plain", "exa down"),
    })
    .await;
    let url = format!("http://page.test:{}/blocked", s.port);
    let v = crate::commands::search::web_fetch_with(&url, None, stub_gate(), &format!("{}/exa", s.base), Duration::from_secs(2))
        .await
        .unwrap();
    assert_eq!(v["status"], 403);
    assert_eq!(v["readerError"], "HTTP 500");
}

#[test]
fn the_reader_fallback_reasons() {
    use crate::commands::search::reader_fallback_reason as why;
    let long = "word ".repeat(200);
    assert!(why(200, "Article", &long, false).is_none());
    assert!(why(404, "", "", false).is_none());
    assert!(why(200, "", "", true).is_none(), "a PDF is answered as such");
    assert!(why(403, "", &long, false).is_some());
    assert!(why(429, "", &long, false).is_some());
    assert!(why(202, "", &long, false).is_some());
    assert!(why(200, "Just a moment...", "Checking your browser before accessing", false).is_some());
    assert!(why(200, "", "Please enable JavaScript to continue.", false).is_some());
    assert!(why(200, "Tiny", "ok", false).is_some());
    // A long article that mentions a captcha in passing is still the article.
    assert!(why(200, "On captchas", &format!("{long} captcha"), false).is_none());
}

#[test]
fn the_exa_reader_answer_loses_its_header_lines() {
    // The shape Exa answered for a Reddit thread on 20.10.2026, cut down.
    let text = "# Need some LLM model recommendations : r/LocalLLaMA\nURL: https://www.reddit.com/r/LocalLLaMA/comments/1rv99g7/x/\nPublished: 2026-03-16\nAuthor: u/someone\n\n# Need some LLM model recommendations\n\nPosted by u/someone in r/LocalLLaMA";
    let (title, url, body, truncated) = parse_hosted_fetch_text(text, "https://www.reddit.com/r/LocalLLaMA/comments/1rv99g7/x/");
    assert_eq!(title, "Need some LLM model recommendations : r/LocalLLaMA");
    assert_eq!(url, "https://www.reddit.com/r/LocalLLaMA/comments/1rv99g7/x/");
    assert!(body.starts_with("# Need some LLM model recommendations\n"), "{body}");
    assert!(!body.contains("Published:") && !body.contains("Author:"));
    assert!(!truncated);
}

#[test]
fn the_exa_search_answer_of_the_live_run_is_read() {
    // Exa's answer for "rust reqwest timeout" on 20.10.2026, cut down.
    let text = "Title: ClientBuilder in reqwest - Rust\nURL: https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html\nPublished: N/A\nAuthor: N/A\nHighlights:\n#####\n\n...\n\nTLS backend ... initialized, ... resolver ... load\n\n---\n\nTitle: RequestBuilder in reqwest - Rust\nURL: https://docs.rs/reqwest/latest/reqwest/struct.RequestBuilder.html\nPublished: N/A\nAuthor: N/A\nHighlights:\nSource pub fn timeout(self, timeout: Duration) -> RequestBuilder\n\nEnables a request timeout.";
    let r = parse_hosted_search_text(text);
    assert_eq!(r.len(), 2);
    assert_eq!(r[0].title, "ClientBuilder in reqwest - Rust");
    assert_eq!(r[0].snippet, "TLS backend ... initialized, ... resolver ... load");
    assert_eq!(r[1].snippet, "Source pub fn timeout(self, timeout: Duration) -> RequestBuilder Enables a request timeout.");
}

/// The real services, by hand only:
/// `cargo test live_search_against_the_real_services -- --ignored --nocapture`
#[tokio::test]
#[ignore]
async fn live_search_against_the_real_services() {
    let queries = [
        "rust reqwest timeout",
        "Hamburg Transparenzgesetz Antragsfristen",
        "I want to run a local language model on a Windows laptop with an RTX 3060. Which quantization fits into 12 GB of VRAM and still gives good answers?",
        "Ich suche eine Wanderung im Harz mit Hund. Welche Route ist im Herbst unter 15 Kilometer lang und gut ausgeschildert?",
    ];
    for provider in ["auto", "exa", "you", "duckduckgo", "wikipedia"] {
        for q in queries {
            let started = Instant::now();
            let v = run(&request(q, provider), &Endpoints::default(), &Timing::default()).await;
            let first = v["results"].get(0).map(|r| r["url"].as_str().unwrap_or("").to_string()).unwrap_or_default();
            println!(
                "{provider:<10} {:>5.1}s provider={} n={} first={} tried={}",
                started.elapsed().as_secs_f32(),
                v["provider"],
                v["results"].as_array().map(|a| a.len()).unwrap_or(0),
                first,
                v["tried"]
            );
            println!("           q={}", &q[..q.len().min(60)]);
        }
    }
    for url in ["https://en.wikipedia.org/wiki/Rust_(programming_language)", "https://www.reddit.com/r/LocalLLaMA/"] {
        let v = crate::commands::search::web_fetch(url.to_string(), None).await;
        match v {
            Ok(v) => println!(
                "fetch {url}: status={} via={} title={} chars={} truncated={}",
                v["status"], v["via"], v["title"], v["text"].as_str().map(|t| t.chars().count()).unwrap_or(0), v["truncated"]
            ),
            Err(e) => println!("fetch {url}: error {e}"),
        }
    }
}
