use crate::os_error;
use std::net::SocketAddr;
use std::time::Duration;
use tauri::Emitter;

/// The host as an IP, or None for a real DNS name. Strips the brackets the URL
/// parser keeps around an IPv6 literal.
fn parse_ip_host(host: &str) -> Option<std::net::IpAddr> {
    host.trim_matches(|c| c == '[' || c == ']').parse().ok()
}

/// True for an address that no external fetch may reach: loopback, the RFC1918
/// LAN ranges, link-local (where the cloud-metadata endpoints live), and the
/// unspecified block. IPv4-mapped/compatible IPv6 is folded down to v4 first, so
/// `::ffff:127.0.0.1` is judged as `127.0.0.1` and not as a global address.
///
/// This is the predicate the RESOLVED addresses are held to. A hostname carries
/// no evidence about where it points: `db.attacker.tld` and `localtest.me` are
/// ordinary public names whose A record is 127.0.0.1, and behind that record sit
/// the built-in engine, Ollama, LM Studio, ComfyUI, the remote bridge, the
/// router and the internal wiki.
///
/// 100.64.0.0/10 is deliberately NOT blocked: that is where Tailscale puts a
/// user's own machines, and the literal-host gate has always allowed it.
fn is_blocked_ip(ip: std::net::IpAddr) -> bool {
    // Fold v4 + IPv4-mapped/compatible v6 to v4 and judge on the v4 ranges.
    let folded = match ip {
        std::net::IpAddr::V4(v4) => Some(v4),
        std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped().or_else(|| v6.to_ipv4()),
    };
    if let Some(v4) = folded {
        let o = v4.octets();
        return matches!(o,
            [10, ..] |                  // 10.0.0.0/8
            [172, 16..=31, ..] |        // 172.16.0.0/12
            [192, 168, ..] |            // 192.168.0.0/16
            [127, ..] |                 // 127.0.0.0/8
            [169, 254, ..] |            // 169.254.0.0/16 link-local incl. AWS/GCP/Azure IMDS
            [0, ..]                     // 0.0.0.0/8 (and ::, ::1 once folded)
        ) || o == [100, 100, 100, 200]; // Alibaba IMDS
    }
    match ip {
        std::net::IpAddr::V6(v6) => {
            let s = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || (s[0] & 0xfe00) == 0xfc00   // fc00::/7 ULA, incl. GCP fd00:ec2::254
                || (s[0] & 0xffc0) == 0xfe80   // fe80::/10 link-local
        }
        std::net::IpAddr::V4(_) => false,
    }
}

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

    // An IP written straight into the URL is judged by the same predicate the
    // resolved addresses face, so the two can never drift apart.
    if let Some(ip) = parse_ip_host(host) {
        if is_blocked_ip(ip) {
            return Err(format!("Blocked: private/reserved IP {}", ip));
        }
    }

    Ok(())
}

/// A URL fit to appear in an error message or a log line.
///
/// The query string is dropped, and so is any userinfo. A secret in a URL is a
/// secret in every log that ever quotes the URL, and the log scrubber cannot
/// see a token that is just another substring of a URL. The CivitAI search used
/// to put the user's API key there, and this function is the second half of
/// closing that: the first half is not putting it there at all.
pub(crate) fn redact_url(raw: &str) -> String {
    match url::Url::parse(raw) {
        Ok(mut u) => {
            u.set_query(None);
            u.set_fragment(None);
            let _ = u.set_username("");
            let _ = u.set_password(None);
            u.to_string()
        }
        // Unparseable: say nothing rather than echo whatever it was.
        Err(_) => "the requested URL".to_string(),
    }
}

/// Generic HTTP proxy — fetch any external URL and return body as string.
/// Used for CivitAI API calls, workflow JSON downloads, etc.
///
/// `authToken` is the user's CivitAI API key and is sent as a Bearer header,
/// ONLY to a CivitAI host, exactly like the download path. It is not a generic
/// "send this to whatever host" parameter: a bearer that follows any URL a
/// catalogue hands us is a credential leak waiting for a redirect.
#[allow(non_snake_case)]
#[tauri::command]
pub async fn fetch_external(url: String, authToken: Option<String>) -> Result<String, String> {
    let bearer = authToken
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let resp = ssrf_safe_fetch(&url, "fetch_external", Duration::from_secs(60), 10, bearer).await?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status().as_u16(), redact_url(&url)));
    }

    resp.text().await.map_err(|e| os_error::english(&e))
}

/// Binary HTTP proxy — fetch any external URL and return bytes.
/// Used for downloading ZIP files, images, model files.
#[tauri::command]
pub async fn fetch_external_bytes(url: String) -> Result<Vec<u8>, String> {
    let resp = ssrf_safe_fetch(&url, "fetch_external_bytes", Duration::from_secs(300), 10, None).await?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status().as_u16(), redact_url(&url)));
    }

    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| os_error::english(&e))
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

/// Fold an address to its IPv4 form, collapsing IPv4-mapped (`::ffff:a.b.c.d`)
/// and IPv4-compatible (`::a.b.c.d`) IPv6 down to v4 — so the metadata/LAN checks
/// can't be bypassed by encoding the address as IPv6 (e.g.
/// `::ffff:169.254.169.254` resolves on the v4 stack). `host` must be already
/// bracket-stripped + lowercased.
fn as_ipv4(host: &str) -> Option<std::net::Ipv4Addr> {
    match host.parse::<std::net::IpAddr>().ok()? {
        std::net::IpAddr::V4(v4) => Some(v4),
        std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped().or_else(|| v6.to_ipv4()),
    }
}

/// Cloud-metadata / link-local addresses that must NEVER be proxied, even if a
/// host somehow lands in an allow-list. The classic SSRF targets (AWS/GCP/Azure
/// 169.254.169.254, Alibaba 100.100.100.200, GCP IPv6 IMDS fd00:ec2::254) plus
/// the whole IPv4 link-local block — a real LAN LLM backend never lives there.
/// Defense-in-depth on top of host registration (Bug A; hardened for
/// IPv4-mapped-IPv6 bypass M1).
fn is_blocked_proxy_host(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']').to_lowercase();
    // GCP IPv6 IMDS literal (a genuine IPv6 address, not a mapped-v4 form).
    if h == "fd00:ec2::254" {
        return true;
    }
    // Fold v4 + IPv4-mapped/compatible v6 to v4, then block link-local + the
    // known metadata IPs (so ::ffff:169.254.169.254 / ::ffff:6464:64c8 etc. can't
    // slip past the v4 string/parse checks).
    if let Some(v4) = as_ipv4(&h) {
        let o = v4.octets();
        if o[0] == 169 && o[1] == 254 {     // 169.254.0.0/16 incl. AWS/GCP/Azure IMDS
            return true;
        }
        if o == [100, 100, 100, 200] {       // Alibaba IMDS
            return true;
        }
    }
    false
}

/// Strict public-URL validation for agent/downloader fetches: http(s) only and
/// the host must not be localhost, a private/reserved range, or a cloud-metadata
/// endpoint (incl. IPv4-mapped-IPv6 forms). Combines `validate_external_url`
/// (RFC1918/loopback/link-local ranges) with `is_blocked_proxy_host`
/// (metadata + mapped-v6). This is the single SSRF gate — reuse it everywhere
/// instead of ad-hoc substring blocklists (which miss 172.16/12, IPv6, and
/// decimal/hex/octal IP encodings).
pub(crate) fn validate_public_url(raw: &str) -> Result<(), String> {
    validate_public_url_addrs(raw).map(|_| ())
}

/// Where the gate learns what a hostname actually points at. Injected so a test
/// can hand back the answer a hostile resolver would give — a plain public name
/// that maps to 127.0.0.1 — which is the entire attack and cannot be staged
/// against the machine's real resolver.
type HostResolver = fn(&str, u16) -> Result<Vec<SocketAddr>, String>;

/// Resolve with a hard cap. `to_socket_addrs` has no timeout knob and an
/// unreachable resolver parks the calling thread for the OS default (tens of
/// seconds on some stacks); the gate sits on a request path, so it caps the wait
/// and fails closed rather than hanging the command.
fn resolve_host(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    use std::net::ToSocketAddrs;
    const CAP: Duration = Duration::from_secs(5);
    let target = format!("{}:{}", host, port);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let resolved = target
            .to_socket_addrs()
            .map(|it| it.collect::<Vec<_>>())
            // Windows words a resolver failure in the system language; the app
            // is English-only.
            .map_err(|e| os_error::english(&e));
        let _ = tx.send(resolved);
    });
    match rx.recv_timeout(CAP) {
        Ok(Ok(addrs)) => Ok(addrs),
        Ok(Err(e)) => Err(format!("Blocked: cannot resolve host ({})", e)),
        Err(_) => Err(format!(
            "Blocked: '{}' did not resolve within {} s",
            host,
            CAP.as_secs()
        )),
    }
}

/// The gate, returning the addresses it approved so the caller can pin the
/// connection to exactly those (see `pinned_client`).
pub(crate) fn validate_public_url_addrs(raw: &str) -> Result<Vec<SocketAddr>, String> {
    validate_public_url_addrs_with(raw, resolve_host)
}

fn validate_public_url_addrs_with(
    raw: &str,
    resolve: HostResolver,
) -> Result<Vec<SocketAddr>, String> {
    validate_external_url(raw)?;
    let parsed = url::Url::parse(raw).map_err(|e| format!("Invalid URL: {}", e))?;
    let host = parsed.host_str().unwrap_or("");
    if is_blocked_proxy_host(host) {
        return Err("Blocked: cloud-metadata / link-local address".into());
    }
    // Reject inet_aton-style numeric hosts: a bare decimal integer
    // (http://2852039166 == 169.254.169.254) or a 0x-hex integer
    // (http://0xA9FEA9FE) parses as a "domain" here, slips past the
    // dotted-quad range checks, then the OS resolver expands it to an IP. A
    // legitimate public hostname is never all-digits or `0x…`.
    let h = host.trim_matches(|c| c == '[' || c == ']').to_lowercase();
    let is_decimal_int = !h.is_empty() && h.chars().all(|c| c.is_ascii_digit());
    let is_hex_int = h.starts_with("0x") && h.len() > 2 && h[2..].chars().all(|c| c.is_ascii_hexdigit());
    if is_decimal_int || is_hex_int {
        return Err("Blocked: numeric host form (possible IP-encoding bypass)".into());
    }

    let port = parsed.port_or_known_default().unwrap_or(80);
    if let Some(ip) = parse_ip_host(host) {
        // Written as a literal, so the checks above already judged the address
        // itself — there is nothing a resolver could change about it.
        return Ok(vec![SocketAddr::new(ip, port)]);
    }

    // Everything above only read the host TEXT, and the text is not evidence:
    // any name the caller controls can answer 127.0.0.1 or 192.168.1.1. The
    // local backends, the remote bridge, the router and the internal wiki are
    // all exactly one such record away, so the ADDRESSES decide.
    let addrs = resolve(&h, port)?;
    if addrs.is_empty() {
        return Err(format!("Blocked: '{}' resolved to no address", h));
    }
    for addr in &addrs {
        if is_blocked_ip(addr.ip()) {
            return Err(format!(
                "Blocked: '{}' resolves to {}, a private/loopback/link-local address",
                h,
                addr.ip()
            ));
        }
    }
    Ok(addrs)
}

/// Redirect policy that re-validates EVERY hop with `validate_public_url`, so a
/// public URL can't 30x-redirect into localhost / a private host / cloud
/// metadata (the classic SSRF-via-redirect bypass). Use this on any reqwest
/// client that fetches a renderer- or model-supplied URL.
///
/// The hop check now resolves the target too, but reqwest opens the connection
/// itself afterwards, so the address is looked up a second time — a rebinding
/// resolver still has a window here. `ssrf_safe_fetch` closes it by following
/// redirects by hand and pinning each hop; prefer that where the request shape
/// allows it.
pub(crate) fn ssrf_safe_redirect_policy(max: usize) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= max {
            return attempt.error("too many redirects");
        }
        match validate_public_url(attempt.url().as_str()) {
            Ok(()) => attempt.follow(),
            Err(_) => attempt.error("redirect to a blocked (private/metadata) host"),
        }
    })
}

/// A client pinned to the addresses the gate just approved. Without the pin the
/// name is resolved a SECOND time when the socket is opened, and a resolver that
/// answers a public IP to the check and 127.0.0.1 to the connect (DNS rebinding)
/// walks through untouched. `resolve_to_addrs` overrides only the address — the
/// port always comes from the URL.
fn pinned_client(host: &str, addrs: &[SocketAddr], timeout: Duration) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(timeout)
        // Redirects are followed by hand in `ssrf_safe_fetch` so every hop gets
        // its own check AND its own pin; letting reqwest follow them would
        // re-resolve the next host behind our back.
        .redirect(reqwest::redirect::Policy::none());
    if parse_ip_host(host).is_none() {
        builder = builder.resolve_to_addrs(host, addrs);
    }
    builder.build().map_err(|e| os_error::english(&e))
}

/// GET a renderer-supplied URL with the SSRF gate applied to EVERY hop, each one
/// connected to the address that hop was checked against.
///
/// reqwest's default policy follows up to 10 redirects and checks nothing on the
/// way, so a public URL answering `302 Location: http://169.254.169.254/…` (or
/// `http://127.0.0.1:11434/…`) reached the blocked host through the front door.
///
/// `bearer` is the user's CivitAI API key. It is attached per hop and ONLY while
/// that hop is a CivitAI host, so a redirect off CivitAI drops the credential
/// instead of handing it to whoever the catalogue pointed at.
async fn ssrf_safe_fetch(
    url: &str,
    label: &str,
    timeout: Duration,
    max_hops: usize,
    bearer: Option<&str>,
) -> Result<reqwest::Response, String> {
    let mut current = url.to_string();
    for _ in 0..=max_hops {
        let target = current.clone();
        // The resolver blocks; keep it off the reactor.
        let addrs = tokio::task::spawn_blocking(move || validate_public_url_addrs(&target))
            .await
            .map_err(|e| format!("{}: resolver task failed: {}", label, e))??;
        let parsed = url::Url::parse(&current).map_err(|e| format!("Invalid URL: {}", e))?;
        let host = parsed.host_str().unwrap_or("").to_string();
        let client = pinned_client(&host, &addrs, timeout)?;
        let mut request = client.get(current.clone());
        // Jeder Sprung wird neu geprueft, der Bearer folgt nie einer Umleitung
        // von CivitAI weg.
        if let Some(token) =
            bearer.filter(|_| crate::commands::download::is_civitai_host(&current))
        {
            request = request.bearer_auth(token);
        }
        let resp = request
            .send()
            .await
            .map_err(|e| format!("{}: {}", label, os_error::english(&e)))?;
        // Only the statuses reqwest itself would have followed. 300 and 304 are
        // redirection-class but carry no target, and handing those back to the
        // caller is what happened before.
        if !matches!(resp.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            return Ok(resp);
        }
        let location = match resp.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()) {
            Some(l) => l.to_string(),
            None => return Ok(resp),
        };
        current = parsed
            .join(&location)
            .map_err(|e| format!("Invalid redirect target: {}", e))?
            .to_string();
    }
    Err(format!("{}: too many redirects", label))
}

/// True only for private/LAN hosts a user could legitimately point a local
/// backend at. `register_openai_host` requires this so the RUST boundary — not
/// the JS caller — enforces the LAN-only intent and can't be tricked into
/// allow-listing arbitrary public/intranet hosts (SSRF hardening M2). Mirrors
/// the frontend `isPrivateOrLanHost`. Input must be bracket-stripped+lowercased.
fn is_registerable_lan_host(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']').to_lowercase();
    if h.is_empty() {
        return false;
    }
    if matches!(h.as_str(), "localhost" | "127.0.0.1" | "::1" | "0.0.0.0")
        || h.ends_with(".localhost")
    {
        return true;
    }
    if h.ends_with(".local") || h.ends_with(".lan") || h.ends_with(".internal")
        || h.ends_with(".intra") || h.ends_with(".home") || h.ends_with(".home.arpa")
    {
        return true;
    }
    if let Ok(ip) = h.parse::<std::net::IpAddr>() {
        if let Some(v4) = as_ipv4(&h) {
            let o = v4.octets();
            // 169.254/16 (link-local) + public ranges → false; RFC1918 + CGNAT → true.
            return (o[0] == 10)
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
                || (o[0] == 127)
                || (o[0] == 100 && (64..=127).contains(&o[1]));
        }
        if let std::net::IpAddr::V6(v6) = ip {
            let s = v6.segments();
            return (s[0] & 0xfe00) == 0xfc00   // fc00::/7 ULA
                || (s[0] & 0xffc0) == 0xfe80;   // fe80::/10 link-local
        }
        return false;
    }
    // Bare single-label machine name (no dots, no stray ':') = LAN host.
    !h.contains('.') && !h.contains(':')
}

/// True for a public hostname a user can legitimately host an OpenAI-compatible
/// backend on (their own domain, or a cloud vendor LU has no preset for). These
/// need the proxy too: the pinned webview CSP only permits a DIRECT fetch to the
/// handful of hosts listed in tauri.conf.json, so anything else is blocked
/// before it leaves the webview (GH #87 family).
///
/// Deliberately narrow: FQDNs only. IP literals are refused — a bare public IP
/// backend is not a case LU needs to serve, and IP/numeric host forms are the
/// classic SSRF-bypass surface (decimal `2852039166`, hex `0xA9FEA9FE`).
fn is_registerable_public_host(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']').to_lowercase();
    if h.is_empty() || !h.contains('.') || h.ends_with('.') || h.starts_with('.') {
        return false;
    }
    if h.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }
    if h.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return false;
    }
    h.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
}

/// The proxy allow-list, frozen at the moment a request starts.
///
/// A snapshot rather than a live `AppState` read for two reasons: the redirect
/// policy runs inside reqwest and cannot borrow a `tauri::State`, and a host
/// registered while a redirect chain is already in flight must not be able to
/// widen that chain retroactively.
#[derive(Clone, Default)]
struct ProxyAllowList {
    ollama: String,
    comfy: String,
    openai: std::collections::HashSet<String>,
}

impl ProxyAllowList {
    fn snapshot(state: &crate::state::AppState) -> Self {
        Self {
            // Configured Ollama host (Issue #31: users with OLLAMA_HOST=192.168.x.x).
            ollama: state
                .ollama_base
                .lock()
                .ok()
                .map(|g| configured_host(&g))
                .unwrap_or_default(),
            // Configured ComfyUI host (v2.3.6 feature).
            comfy: state
                .comfy_host
                .lock()
                .ok()
                .map(|g| configured_host(&g))
                .unwrap_or_default(),
            // Configured OpenAI-compatible LAN backends (Bug A / GH #49),
            // registered via `register_openai_host`.
            openai: state
                .openai_hosts
                .lock()
                .ok()
                .map(|g| g.clone())
                .unwrap_or_default(),
        }
    }

    /// Validate that a URL targets either localhost or one of the user-configured
    /// backend hosts.
    ///
    /// SSRF policy: the proxy only forwards to hosts the user explicitly pointed
    /// LU at. A JS-level compromise still cannot reach arbitrary intranet
    /// services; it can only reach the host the user already wanted to reach.
    fn check(&self, raw: &str) -> Result<(), String> {
        let parsed = url::Url::parse(raw)
            .map_err(|e| format!("Invalid URL: {}", e))?;

        match parsed.scheme() {
            "http" | "https" => {}
            other => return Err(format!("Blocked scheme: {}", other)),
        }

        let host = parsed.host_str().unwrap_or("").to_lowercase();

        // Hard block: cloud-metadata / link-local — never proxied, even if a host
        // somehow got allow-listed (SSRF defense-in-depth, Bug A).
        if is_blocked_proxy_host(&host) {
            return Err(format!(
                "Blocked: '{}' is a metadata/link-local address and is never proxied", host
            ));
        }

        // Always-allowed: localhost variants. Covers the common case + any
        // backend bound to 0.0.0.0 on the same machine.
        let is_local = matches!(host.as_str(),
            "localhost" | "127.0.0.1" | "::1" | "[::1]" | "0.0.0.0"
        ) || host.ends_with(".localhost");
        if is_local {
            return Ok(());
        }

        if !self.ollama.is_empty() && host == self.ollama {
            return Ok(());
        }
        if !self.comfy.is_empty() && host == self.comfy {
            return Ok(());
        }
        if self.openai.contains(&host) {
            return Ok(());
        }

        Err(format!(
            "proxy_localhost: host '{}' not allowed. Configure remote backends via Settings → Providers or Settings → ComfyUI (Host).",
            host
        ))
    }
}

/// The client every proxy command uses.
///
/// The redirect policy is the point: with reqwest's default one, a backend
/// answering `302 Location: http://169.254.169.254/latest/meta-data/` — or any
/// intranet host the allow-list never approved — was followed without a second
/// look, so a single redirect from a machine the user did trust reached a
/// machine they did not. Every hop is put through the same allow-list as the
/// first request, and the chain is short: a local LLM backend has no legitimate
/// reason to bounce a request more than a couple of times.
fn proxy_client(timeout: Duration, allow: ProxyAllowList) -> Result<reqwest::Client, String> {
    const MAX_HOPS: usize = 3;
    reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= MAX_HOPS {
                return attempt.error("too many redirects");
            }
            match allow.check(attempt.url().as_str()) {
                Ok(()) => attempt.follow(),
                Err(_) => attempt.error("redirect to a host outside the proxy allow-list"),
            }
        }))
        .build()
        .map_err(|e| os_error::english(&e))
}

/// Register a user-configured OpenAI-compatible backend host (LAN LM Studio,
/// vLLM, …) into the proxy allow-list so `proxy_localhost` will forward to it.
/// Mirrors the Ollama/ComfyUI host-registration model (Bug A / GH #49): the
/// webview CSP + the backend's CORS block a direct LAN fetch, so these requests
/// are proxied through Rust instead.
///
/// SSRF policy: only the host the user explicitly pointed LU at is added, and
/// metadata/link-local addresses are refused outright (defense-in-depth on top
/// of validate_proxy_url's hard block). Accepts a bare host or a full URL.
#[tauri::command]
pub fn register_openai_host(
    host: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let h = configured_host(&host);
    if h.is_empty() || h.contains('/') || h.contains(' ') {
        return Err("invalid host".to_string());
    }
    if is_blocked_proxy_host(&h) {
        return Err(format!("refused: '{}' is a metadata/link-local address", h));
    }
    // SSRF hardening (M2): the Rust boundary decides which hosts are usable as a
    // backend, not the JS caller. Private/LAN hosts (CORS) and public FQDNs (the
    // pinned CSP blocks a direct fetch to anything outside tauri.conf.json's
    // connect-src) both need the proxy; IP literals, metadata addresses and
    // numeric IP encodings stay refused.
    if !is_registerable_lan_host(&h) && !is_registerable_public_host(&h) {
        return Err(format!("refused: '{}' is not a usable backend host", h));
    }
    if let Ok(mut hosts) = state.openai_hosts.lock() {
        // Bound the set (m1) — defend against a runaway registration loop.
        if hosts.len() >= 64 && !hosts.contains(&h) {
            return Err("too many registered hosts".to_string());
        }
        hosts.insert(h);
    }
    Ok(())
}

/// Attach the body and the caller's headers to a proxied request.
///
/// reqwest's `.header()` APPENDS, it does not replace. Setting Content-Type
/// here and forwarding a caller that sends its own put the header on the wire
/// twice, and aiohttp answers that with "Duplicate 'Content-Type' header
/// found" — every Create submit on a ComfyUI with aiohttp 3.9+ died on it
/// (GH #95). The caller's own value wins; we only fill in the default.
fn apply_body_and_headers(
    mut request: reqwest::RequestBuilder,
    body: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
) -> reqwest::RequestBuilder {
    // Headers the HTTP stack derives from the request itself. A caller that
    // sends one too would put it on the wire twice, which is the same failure
    // as the Content-Type one below: aiohttp treats all of these as singletons
    // and rejects the whole request when it sees two.
    const STACK_OWNED: [&str; 4] = ["content-length", "host", "transfer-encoding", "connection"];

    let caller_sets_content_type = headers
        .as_ref()
        .is_some_and(|h| h.keys().any(|k| k.eq_ignore_ascii_case("content-type")));

    if let Some(body_str) = body {
        if !caller_sets_content_type {
            request = request.header("Content-Type", "application/json");
        }
        request = request.body(body_str);
    }

    // Caller headers (Authorization for keyed backends) — dropping them made
    // every proxied request to an authed OpenAI-compat server 401.
    if let Some(hdrs) = headers {
        for (k, v) in hdrs {
            if STACK_OWNED.iter().any(|s| k.eq_ignore_ascii_case(s)) {
                continue;
            }
            request = request.header(k.as_str(), v.as_str());
        }
    }

    request
}

// ── The built-in engine may only answer AS the model it is holding ──────────
//
// Counter-check, Windows box 2026-08-28: with Gemma loaded, a request carrying
// `"model": "Hermes-3-Llama-3.2-3B.Q4_K_M"` and one carrying
// `"model": "gibt-es-nicht-42"` were both answered by Gemma, with no error and
// no model change. That is llama-server behaving as documented: it serves the
// single model it was started with and treats `model` as a label. Nothing
// above it ever compared the two, so the app could show one name and deliver
// another model's words.
//
// The app layer reloads before a send (`api/builtin-ensure.ts`). This is the
// guard at the root, so the rule holds no matter who builds the request: a
// plugin, a workflow, a future feature, or a hand-made call through the same
// proxy. It refuses rather than reloads, because a swap here would stop and
// restart the engine underneath a request that is already in flight, and the
// layer that CAN reload sits above and already does.

/// The picker id of a bundled GGUF, derived from the path the engine was
/// started with. Twin of `builtinModelNameFromPath` in
/// `src/lib/builtin-model-identity.ts`, and it has to stay one: a split GGUF
/// is listed under its base name while the loaded path points at part 1.
pub(crate) fn builtin_model_name_from_path(path: &str) -> String {
    let leaf = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let stem = match leaf.len().checked_sub(5) {
        Some(cut) if leaf[cut..].eq_ignore_ascii_case(".gguf") => &leaf[..cut],
        _ => leaf,
    };
    match crate::commands::engine::split_shard_stem(stem) {
        Some((base, _, _)) => base.to_string(),
        None => stem.to_string(),
    }
}

/// The bare model id behind a picker id (`openai::name` becomes `name`).
/// Twin of `bareBuiltinModelName`, and it strips nothing else for the same
/// reason: the id is the name the user reads back in the refusal.
fn bare_model_name(name: &str) -> &str {
    let trimmed = name.trim();
    let parts: Vec<&str> = trimmed.split("::").collect();
    if parts.len() == 2 {
        parts[1]
    } else {
        trimmed
    }
}

/// Is this URL a generation request against the built-in engine's own port.
///
/// Deliberately narrow. `/v1/models`, `/props`, `/health` and every other
/// endpoint carry no model field and must keep working; and a request to any
/// other port belongs to Ollama, LM Studio or ComfyUI, whose model handling is
/// their own business.
fn is_builtin_generation_url(url: &str, engine_port: u16) -> bool {
    let parsed = match url::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return false,
    };
    let host = parsed.host_str().unwrap_or("");
    let loopback = host == "127.0.0.1"
        || host == "localhost"
        || host == "::1"
        || host == "[::1]"
        || host.parse::<std::net::Ipv4Addr>().map(|ip| ip.is_loopback()).unwrap_or(false);
    if !loopback || parsed.port() != Some(engine_port) {
        return false;
    }
    let path = parsed.path().trim_end_matches('/');
    path.ends_with("/chat/completions") || path.ends_with("/completions") || path.ends_with("/infill")
}

/// The `model` field of a request body, when there is one worth checking.
fn requested_model(body: Option<&str>) -> Option<String> {
    let raw = body?;
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let name = value.get("model")?.as_str()?.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// The English refusal for a request that names a model the engine is not
/// holding, or None when there is nothing to complain about.
///
/// Pure, so the whole rule is testable without a running engine.
pub(crate) fn builtin_model_conflict(
    url: &str,
    body: Option<&str>,
    loaded_path: &str,
    engine_port: u16,
) -> Option<String> {
    if !is_builtin_generation_url(url, engine_port) {
        return None;
    }
    let loaded = builtin_model_name_from_path(loaded_path);
    if loaded.is_empty() {
        return None;
    }
    let asked_raw = requested_model(body)?;
    // Through the same normaliser as the loaded path, so a request naming
    // "model.gguf" is compared against "model" and not refused for nothing.
    let asked = builtin_model_name_from_path(bare_model_name(&asked_raw));
    if asked.is_empty() || asked == loaded {
        return None;
    }
    Some(format!(
        "The LU Engine has \"{loaded}\" loaded, but this request asked for \"{asked}\". \
         The engine answers with the model it was started with, whatever the model field says, \
         so this request was refused instead of being answered by the wrong model. \
         Load \"{asked}\" first (Models, or the chat model picker) and send again."
    ))
}

/// The guard as the proxy commands call it: reads the running engine out of
/// the app state and applies `builtin_model_conflict`. No engine running means
/// no claim to check.
fn guard_builtin_model(
    url: &str,
    body: Option<&str>,
    state: &tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let loaded = match state.bundled_engine.lock() {
        Ok(guard) => guard.as_ref().map(|e| (e.port, e.model_path.clone())),
        Err(_) => None,
    };
    let (port, path) = match loaded {
        Some(v) => v,
        None => return Ok(()),
    };
    match builtin_model_conflict(url, body, &path, port) {
        Some(msg) => Err(msg),
        None => Ok(()),
    }
}

/// Generic localhost proxy — fetch any localhost or configured-backend URL
/// bypassing CORS. Used for Ollama and ComfyUI API calls in production mode.
///
/// `timeout_ms` (optional) overrides the default 300 s timeout. Backend
/// detection passes 2000 — without that override the onboarding "Searching
/// for local backends..." step would freeze for 5 minutes whenever a port
/// happens to be answered by software that takes the TCP connect but
/// never replies HTTP (Discord report — Docker dev container on 8000,
/// firewall throttling, another LLM tool with a slow health endpoint, ...).
/// Long-running calls (Ollama pull, ComfyUI generate) keep the 300 s default.
#[tauri::command]
pub async fn proxy_localhost(
    url: String,
    method: Option<String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    headers: Option<std::collections::HashMap<String, String>>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<String, String> {
    let allow = ProxyAllowList::snapshot(&state);
    allow.check(&url)?;
    // A generation request may not name a model the engine is not holding.
    guard_builtin_model(&url, body.as_deref(), &state)?;

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(300_000));

    let client = proxy_client(timeout, allow)?;

    let http_method = method.unwrap_or_else(|| "GET".to_string());

    let mut request = match http_method.as_str() {
        "POST" => client.post(&url),
        "DELETE" => client.delete(&url),
        "PUT" => client.put(&url),
        _ => client.get(&url),
    };

    request = apply_body_and_headers(request, body, headers);

    let resp = request
        .send()
        .await
        .map_err(|e| format!("proxy_localhost: {}", os_error::english(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }

    resp.text().await.map_err(|e| os_error::english(&e))
}

/// Streaming localhost proxy — BUFFERS the whole body (no streaming). Kept for
/// non-streaming callers (e.g. proxy-download). For chat, use the chunked variant
/// below so a long generation doesn't look like a multi-minute "model loading" hang.
#[tauri::command]
pub async fn proxy_localhost_stream(url: String, method: Option<String>, body: Option<String>, headers: Option<std::collections::HashMap<String, String>>, state: tauri::State<'_, crate::state::AppState>) -> Result<Vec<u8>, String> {
    let allow = ProxyAllowList::snapshot(&state);
    allow.check(&url)?;
    // A generation request may not name a model the engine is not holding.
    guard_builtin_model(&url, body.as_deref(), &state)?;

    let client = proxy_client(Duration::from_secs(7200), allow)?;

    let http_method = method.unwrap_or_else(|| "GET".to_string());

    let mut request = match http_method.as_str() {
        "POST" => client.post(&url),
        "DELETE" => client.delete(&url),
        "PUT" => client.put(&url),
        _ => client.get(&url),
    };

    request = apply_body_and_headers(request, body, headers);

    let resp = request
        .send()
        .await
        .map_err(|e| format!("proxy_localhost_stream: {}", os_error::english(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }

    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| os_error::english(&e))
}

/// Chunked streaming localhost proxy for Ollama chat (David 2026-06-02).
///
/// The webview CANNOT fetch Ollama directly — its origin is `http://tauri.localhost`
/// and Ollama's CORS rejects it ("TypeError: Failed to fetch"), so ALL chat traffic
/// is routed through the proxy. The buffered `proxy_localhost_stream` awaits the
/// ENTIRE body (2-hour timeout), so a long/slow generation produced NOTHING in the UI
/// until fully finished — a multi-minute "model loading"/hang (dhasim Discord report).
/// This variant forwards each chunk to the caller's `on_chunk` Channel as it arrives
/// → true token-by-token streaming. (`Channel` must be a required arg — wrapping it in
/// `Option` does not implement `Deserialize`, hence a separate command.)
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn proxy_localhost_stream_chunked(
    url: String,
    method: Option<String>,
    body: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    on_chunk: tauri::ipc::Channel<Vec<u8>>,
    // Optional id so the JS side can deterministically cancel THIS stream via
    // `cancel_proxy_stream(stream_id)`. Without it, aborting only broke the JS
    // read-loop while Ollama kept generating to completion on the proxy path
    // (David 2026-06-15: deleting/Stopping a chat must stop the backend too).
    stream_id: Option<String>,
    // Max silence between two chunks once the backend has started answering.
    // Optional so the renderer can widen it for a backend that is known to
    // think for minutes between tokens; see IDLE_TIMEOUT_MS for the default.
    idle_timeout_ms: Option<u64>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    // No chunk for this long once the stream is running means the backend died
    // in a way that leaves the socket open (killed process, suspended
    // container, dropped Wi-Fi on a LAN backend). The only other bound is the
    // 7200 s whole-request timeout, so without this the UI sat on a dead
    // stream for two hours.
    const IDLE_TIMEOUT_MS: u64 = 60_000;
    // Before the FIRST chunk the same silence is normal: that is where a cold
    // model is read off disk and pushed into VRAM, which takes minutes for a
    // large GGUF. Killing that at 60 s would break loading, not protect it.
    const FIRST_CHUNK_GRACE: Duration = Duration::from_secs(600);

    let allow = ProxyAllowList::snapshot(&state);
    allow.check(&url)?;
    // A generation request may not name a model the engine is not holding.
    guard_builtin_model(&url, body.as_deref(), &state)?;

    // Built before the token is registered: everything after the registration
    // has to reach the pump, which is what guarantees the EOF marker and the
    // registry cleanup. An early `?` between the two would skip both.
    let idle = Duration::from_millis(idle_timeout_ms.unwrap_or(IDLE_TIMEOUT_MS));
    let client = proxy_client(Duration::from_secs(7200), allow)?;

    // Register a cancellation token under stream_id (mirrors pull_tokens).
    let token = tokio_util::sync::CancellationToken::new();
    let registry = state.stream_tokens.clone();
    if let Some(id) = stream_id.as_ref() {
        if let Some(old) = registry.lock().unwrap().insert(id.clone(), token.clone()) {
            old.cancel(); // a stale stream under the same id — cancel it first
        }
    }

    let run = pump_proxy_stream(
        &client,
        &url,
        method,
        body,
        headers,
        &token,
        idle,
        FIRST_CHUNK_GRACE,
        &move |chunk| on_chunk.send(chunk).is_ok(),
    )
    .await;

    if let Some(id) = stream_id.as_ref() {
        registry.lock().unwrap().remove(id);
    }
    run
}

/// The stream pump behind `proxy_localhost_stream_chunked`, with the IPC channel
/// reduced to a sink (`false` = the receiving side is gone) so every exit path
/// can be exercised without a webview.
#[allow(clippy::too_many_arguments)]
async fn pump_proxy_stream(
    client: &reqwest::Client,
    url: &str,
    method: Option<String>,
    body: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    token: &tokio_util::sync::CancellationToken,
    idle: Duration,
    first_chunk_grace: Duration,
    sink: &(dyn Fn(Vec<u8>) -> bool + Send + Sync),
) -> Result<(), String> {
    // Lives outside the pump because the EOF marker below has to know whether a
    // single byte of an answer ever reached the renderer.
    let mut seen_first_chunk = false;
    let run = async {
        let http_method = method.unwrap_or_else(|| "GET".to_string());

        let mut request = match http_method.as_str() {
            "POST" => client.post(url),
            "DELETE" => client.delete(url),
            "PUT" => client.put(url),
            _ => client.get(url),
        };

        request = apply_body_and_headers(request, body, headers);

        // Race the request against cancellation even during connect/headers.
        let resp = tokio::select! {
            _ = token.cancelled() => return Ok(()),
            r = request.send() => r.map_err(|e| format!("proxy_localhost_stream_chunked: {}", os_error::english(&e)))?,
        };

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("HTTP {}: {}", status, text));
        }

        use futures_util::StreamExt;
        let mut stream = resp.bytes_stream();
        loop {
            let window = if seen_first_chunk { idle } else { first_chunk_grace };
            tokio::select! {
                // Stop fires → drop `stream`/`resp` → the HTTP connection closes
                // → Ollama stops generating (frees the GPU). This is the fix.
                _ = token.cancelled() => break,
                item = tokio::time::timeout(window, stream.next()) => match item {
                    Err(_) => return Err(if seen_first_chunk {
                        format!(
                            "the backend stopped sending data (nothing for {} s). The model server may have crashed or been killed — check that it is still running and try again.",
                            window.as_secs()
                        )
                    } else {
                        format!(
                            "the backend accepted the request but sent nothing for {} s. A very large model can take this long to load; if it is not loading, restart the backend and try again.",
                            window.as_secs()
                        )
                    }),
                    Ok(Some(it)) => {
                        let bytes = it.map_err(|e| os_error::english(&e))?;
                        if bytes.is_empty() { continue; }
                        seen_first_chunk = true;
                        // JS side gone (reader cancelled / window closed) → stop.
                        if !sink(bytes.to_vec()) { break; }
                    }
                    Ok(None) => break,
                }
            }
        }
        Ok(())
    }
    .await;

    // Explicit EOF marker (empty chunk — data chunks are never empty, the loop
    // above skips them). The JS side closes its ReadableStream on THIS, not on
    // the command's return: WebView2 149 delivers queued channel messages AFTER
    // the invoke result resolves (live find 2026-06-11), so closing on the
    // result raced ahead of the data and silently dropped every chunk.
    //
    // It is emitted HERE, after the pump and outside every early return, because
    // those returns used to skip it: Stop pressed during connect or while the
    // model was still loading returned Ok(()) with no marker at all, and the
    // renderer then held the stream open on its 15 s grace timer — Stop looked
    // frozen for fifteen seconds on the proxy-first loopback path, which is the
    // default for the built-in engine, Ollama and LM Studio.
    //
    // But NOT when the pump died before a single byte arrived. The marker settles
    // the renderer's Response as 200 with an empty body, and the real error, which
    // only reaches JS one tick later on the rejected invoke, is then thrown away
    // as a late answer. Every unreachable local backend read as "The connection
    // dropped before the model finished its answer. Check your network and try
    // again." while the truth was a refused connection on 127.0.0.1 (counter-check
    // P1, 2026-09-04, LU Engine switched off). A failure with no answer behind it
    // must travel as a failure.
    if run.is_ok() || seen_first_chunk {
        sink(Vec::new());
    }

    run
}

/// Cancel an in-flight `proxy_localhost_stream_chunked` by its stream id. Fired
/// from the JS side when the user hits Stop or deletes/closes a chat, so the
/// upstream Ollama request is actually aborted (not just the JS read-loop).
#[tauri::command]
pub fn cancel_proxy_stream(
    state: tauri::State<'_, crate::state::AppState>,
    stream_id: String,
) -> Result<(), String> {
    if let Some(token) = state.stream_tokens.lock().unwrap().remove(&stream_id) {
        token.cancel();
    }
    Ok(())
}

/// Upload an image to ComfyUI's `/upload/image` as a clean multipart POST from
/// Rust. `uploadImage()` in the frontend used a RAW browser `fetch()` — the only
/// non-proxy fetch left — which 400'd on some WebView2 builds (multipart /
/// boundary / CORS-preflight quirks; konata 2026-06-14 "Failed to upload image:
/// HTTP 400"). reqwest's multipart is machine-independent and removes WebView2
/// as a variable, matching the "everything via the Rust proxy" pattern
/// (WebView2-149 finding). Returns ComfyUI's JSON body ({ name, subfolder, type }).
#[tauri::command]
pub async fn comfy_upload_image(
    url: String,
    filename: String,
    content_type: Option<String>,
    file_bytes: Vec<u8>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<String, String> {
    let allow = ProxyAllowList::snapshot(&state);
    allow.check(&url)?;
    if file_bytes.is_empty() {
        return Err("the source image is empty (0 bytes)".to_string());
    }
    let ct = content_type.filter(|c| !c.is_empty()).unwrap_or_else(|| "image/png".to_string());
    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(filename)
        .mime_str(&ct)
        .map_err(|e| os_error::english(&e))?;
    let form = reqwest::multipart::Form::new()
        .part("image", part)
        .text("overwrite", "true");
    let client = proxy_client(Duration::from_secs(120), allow)?;
    let resp = client.post(&url).multipart(form).send().await
        .map_err(|e| format!("comfy_upload_image: {}", os_error::english(&e)))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), body.trim()));
    }
    Ok(body)
}

/// The `/api/pull` request body.
///
/// The model name arrives from the renderer, and a name carrying a `"` used to
/// terminate the JSON string early: `x","insecure":true,"name":"y` was pasted
/// verbatim into a hand-formatted body, so the caller decided which fields
/// Ollama parsed, not this function. serde does the quoting.
fn ollama_pull_body(name: &str) -> String {
    serde_json::json!({ "name": name, "stream": true }).to_string()
}

/// One `pull-progress` payload. Same reason as the body: the model name and the
/// error text both reach this string from outside, and a quote in either one
/// used to produce a payload the renderer's `JSON.parse` threw away — or, worse,
/// one it parsed with fields the caller chose.
fn pull_progress_payload(name: &str, data: serde_json::Value) -> String {
    serde_json::json!({ "model": name, "data": data }).to_string()
}

/// A progress line as it should be forwarded. Ollama sends NDJSON; a line that
/// does not parse is passed on as a plain status string instead of being
/// spliced in raw, which used to make the whole payload invalid JSON.
fn pull_progress_line(line: &str) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(line)
        .unwrap_or_else(|_| serde_json::json!({ "status": line }))
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
        .map_err(|e| os_error::english(&e))?;

    // Route to the configured Ollama base (Issue #31 — was hardcoded
    // http://localhost:11434 so remote Ollama hosts never got the pull).
    let ollama_base = state.ollama_base.lock().ok()
        .map(|g| g.clone())
        .unwrap_or_else(|| "http://localhost:11434".to_string());
    let pull_url = format!("{}/api/pull", ollama_base.trim_end_matches('/'));

    let resp = client
        .post(&pull_url)
        .header("Content-Type", "application/json")
        .body(ollama_pull_body(&name))
        .send()
        .await
        .map_err(|e| format!("pull_model_stream: {}", os_error::english(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        state.pull_tokens.lock().unwrap().remove(&name);
        return Err(format!("HTTP {}: {}", status, text));
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    let mut was_cancelled = false;
    // Bug Z/a v2.5.0 — leonsk29 GH #48. We need to know whether the stream
    // ever produced a terminal "success" line, OR whether it produced an
    // `error` field. Ollama 0.4+ responds to a broken HF reference (e.g.
    // bartowski/Hermes-3 GGUF on llama.cpp-incompatible builds) with HTTP
    // 200 + a stream that ends after emitting `{"status":"pulling manifest"}`
    // (no error field, no `success` line). Pre-v2.5.0 we treated that as
    // success and the frontend flipped the badge to "Completed" despite no
    // blob being written. Now we track the last status + watch for any
    // `error` field, and surface a real error to the caller if neither
    // success nor an explicit error came in.
    let mut last_status: Option<String> = None;
    let mut saw_success = false;
    let mut error_msg: Option<String> = None;

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
                                // Bug Z/a — inspect each line for status/error fields
                                let parsed = pull_progress_line(&line);
                                if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
                                    error_msg = Some(err.to_string());
                                }
                                if let Some(st) = parsed.get("status").and_then(|v| v.as_str()) {
                                    last_status = Some(st.to_string());
                                    if st == "success" {
                                        saw_success = true;
                                    }
                                }
                                // Emit with model name so frontend can route
                                let _ = app.emit("pull-progress", &pull_progress_payload(&name, parsed));
                            }
                        }
                    }
                    Some(Err(e)) => {
                        let _ = app.emit("pull-progress", &pull_progress_payload(
                            &name,
                            serde_json::json!({ "status": format!("Error: {}", e) }),
                        ));
                        error_msg = Some(format!("network: {}", e));
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
            // Same status/error inspection for the flushed tail
            let parsed = pull_progress_line(&remaining);
            if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
                error_msg = Some(err.to_string());
            }
            if let Some(st) = parsed.get("status").and_then(|v| v.as_str()) {
                last_status = Some(st.to_string());
                if st == "success" {
                    saw_success = true;
                }
            }
            let _ = app.emit("pull-progress", &pull_progress_payload(&name, parsed));
        }
    }

    // Cleanup token
    state.pull_tokens.lock().unwrap().remove(&name);

    if was_cancelled {
        return Err("cancelled".to_string());
    }

    // Bug Z/a v2.5.0 — only declare success if Ollama actually said so. If
    // the stream ended without `{"status":"success"}` and without an
    // explicit error field, surface the last status as the failure reason
    // (e.g. "stream ended at: pulling manifest"). The frontend's catch
    // will now show this to the user instead of silently flipping to
    // "Completed".
    if let Some(err) = error_msg {
        Err(format!("ollama: {}", err))
    } else if saw_success {
        Ok(())
    } else {
        let tail = last_status.unwrap_or_else(|| "no status received".to_string());
        Err(format!("pull did not complete: stream ended at \"{}\". Repo may be incompatible with llama.cpp (try a different GGUF mirror).", tail))
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
        .map_err(|e| os_error::english(&e))?;

    let resp = client.get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Ollama search: {}", os_error::english(&e)))?;

    let text = resp.text().await.map_err(|e| os_error::english(&e))?;

    // Try to parse as JSON; if it's HTML, return empty results
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(json) => Ok(json),
        Err(_) => Ok(serde_json::json!({"models": []})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn built_headers(
        body: Option<String>,
        headers: Option<std::collections::HashMap<String, String>>,
    ) -> reqwest::header::HeaderMap {
        apply_body_and_headers(
            reqwest::Client::new().post("http://127.0.0.1:8188/prompt"),
            body,
            headers,
        )
        .build()
        .unwrap()
        .headers()
        .clone()
    }

    fn caller(name: &str, value: &str) -> std::collections::HashMap<String, String> {
        let mut h = std::collections::HashMap::new();
        h.insert(name.to_string(), value.to_string());
        h
    }

    /// GH #95: the Create submit sends its own Content-Type, the proxy appended
    /// a second one, and ComfyUI (aiohttp) answered "Duplicate 'Content-Type'
    /// header found" — Create was dead on 2.6.0 for anyone on a current aiohttp.
    #[test]
    fn caller_content_type_is_never_sent_twice() {
        for name in ["Content-Type", "content-type", "CONTENT-TYPE"] {
            let sent = built_headers(
                Some(r#"{"prompt":{}}"#.to_string()),
                Some(caller(name, "application/json")),
            );
            assert_eq!(
                sent.get_all(reqwest::header::CONTENT_TYPE).iter().count(),
                1,
                "{} produced a duplicate Content-Type",
                name
            );
        }
    }

    #[test]
    fn the_callers_own_content_type_wins() {
        let sent = built_headers(
            Some("<xml/>".to_string()),
            Some(caller("Content-Type", "application/xml")),
        );
        assert_eq!(sent.get(reqwest::header::CONTENT_TYPE).unwrap(), "application/xml");
    }

    #[test]
    fn a_body_without_caller_headers_still_gets_json() {
        let sent = built_headers(Some("{}".to_string()), None);
        assert_eq!(sent.get(reqwest::header::CONTENT_TYPE).unwrap(), "application/json");
    }

    /// The reason caller headers are forwarded at all: a keyed OpenAI-compat
    /// backend answered 401 without them.
    #[test]
    fn authorization_still_rides_along() {
        let sent = built_headers(Some("{}".to_string()), Some(caller("Authorization", "Bearer k")));
        assert_eq!(sent.get(reqwest::header::AUTHORIZATION).unwrap(), "Bearer k");
        assert_eq!(sent.get_all(reqwest::header::CONTENT_TYPE).iter().count(), 1);
    }

    #[test]
    fn a_get_without_body_carries_no_content_type() {
        let sent = built_headers(None, Some(caller("Authorization", "Bearer k")));
        assert!(sent.get(reqwest::header::CONTENT_TYPE).is_none());
    }

    /// Live proof over a real socket against the strict aiohttp parser, the
    /// one that rejected every 2.6.0 Create submit. Start the stub first
    /// (scratchpad/strict-comfy-stub.py, AIOHTTP_NO_EXTENSIONS=1), then:
    ///   cargo test --bin locally-uncensored live_strict -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_strict_aiohttp_takes_the_fixed_request_and_refuses_the_old_one() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let url = "http://127.0.0.1:18899/prompt";
            let client = reqwest::Client::builder()
                .user_agent("LocallyUncensored/2.0")
                .build()
                .unwrap();

            // Exactly what 2.6.0 put on the wire: our own Content-Type, then
            // the caller's on top.
            let old = client
                .post(url)
                .header("Content-Type", "application/json")
                .body(r#"{"prompt":{}}"#)
                .header("Content-Type", "application/json")
                .send()
                .await
                .expect("stub not running?");
            let old_status = old.status();
            let old_text = old.text().await.unwrap();

            let new = apply_body_and_headers(
                client.post(url),
                Some(r#"{"prompt":{}}"#.to_string()),
                Some(caller("Content-Type", "application/json")),
            )
            .send()
            .await
            .unwrap();
            let new_status = new.status();
            let new_text = new.text().await.unwrap();

            println!("2.6.0 path : {} {}", old_status, old_text.trim());
            println!("fixed path : {} {}", new_status, new_text.trim());

            assert_eq!(old_status, 400, "the old order should still be refused");
            // 3.13.2 names the header canonically, 3.13.5 echoes the spelling
            // off the wire (reqwest sends it lowercase). Both are this bug.
            assert!(old_text.to_lowercase().contains("duplicate 'content-type' header found"));
            assert!(new_status.is_success(), "the fixed request must be accepted");
            assert!(new_text.contains("prompt_id"));
        });
    }

    /// The same trap as Content-Type, one level down: these are derived from
    /// the request itself, so a caller that also sends one would double it.
    /// aiohttp counts every one of them as a singleton.
    #[test]
    fn stack_owned_headers_are_never_doubled() {
        let mut h = std::collections::HashMap::new();
        h.insert("Content-Length".to_string(), "999".to_string());
        h.insert("Host".to_string(), "evil.example".to_string());
        h.insert("Transfer-Encoding".to_string(), "chunked".to_string());
        h.insert("Connection".to_string(), "close".to_string());
        h.insert("User-Agent".to_string(), "caller/1.0".to_string());
        h.insert("Content-Type".to_string(), "application/json".to_string());
        h.insert("Authorization".to_string(), "Bearer k".to_string());

        let req = apply_body_and_headers(
            reqwest::Client::builder()
                .user_agent("LocallyUncensored/2.0")
                .build()
                .unwrap()
                .post("http://127.0.0.1:8188/prompt"),
            Some(r#"{"prompt":{}}"#.to_string()),
            Some(h),
        )
        .build()
        .unwrap();

        for name in [
            "content-type",
            "content-length",
            "host",
            "transfer-encoding",
            "connection",
            "user-agent",
            "authorization",
        ] {
            assert!(
                req.headers().get_all(name).iter().count() <= 1,
                "{} went out more than once",
                name
            );
        }
        // The caller cannot talk us into a wrong Host or a bogus length.
        assert!(req.headers().get("host").is_none());
        assert!(req.headers().get(reqwest::header::CONTENT_LENGTH).is_none());
        // What it is allowed to set still arrives.
        assert_eq!(req.headers().get(reqwest::header::AUTHORIZATION).unwrap(), "Bearer k");
        assert_eq!(req.headers().get(reqwest::header::USER_AGENT).unwrap(), "caller/1.0");
    }

    #[test]
    fn blocks_cloud_metadata_and_link_local() {
        // Classic SSRF metadata targets — must be blocked even if registered.
        assert!(is_blocked_proxy_host("169.254.169.254")); // AWS/GCP/Azure IMDS
        assert!(is_blocked_proxy_host("100.100.100.200")); // Alibaba
        assert!(is_blocked_proxy_host("fd00:ec2::254"));   // GCP IPv6 IMDS
        assert!(is_blocked_proxy_host("[fd00:ec2::254]")); // bracketed form
        // Whole IPv4 link-local 169.254.0.0/16.
        assert!(is_blocked_proxy_host("169.254.0.1"));
        assert!(is_blocked_proxy_host("169.254.255.255"));
    }

    #[test]
    fn allows_real_lan_and_localhost() {
        for h in ["192.168.1.50", "10.0.0.5", "172.16.4.4", "localhost",
                  "127.0.0.1", "100.64.0.1" /* Tailscale CGNAT, not metadata */] {
            assert!(!is_blocked_proxy_host(h), "{} should not be blocked", h);
        }
    }

    #[test]
    fn blocks_ipv4_mapped_ipv6_metadata() {
        // M1: encoding the metadata IP as IPv4-mapped/compatible IPv6 must NOT
        // bypass the block.
        assert!(is_blocked_proxy_host("::ffff:169.254.169.254"));
        assert!(is_blocked_proxy_host("[::ffff:169.254.169.254]"));
        assert!(is_blocked_proxy_host("::ffff:a9fe:a9fe"));   // hex form of 169.254.169.254
        assert!(is_blocked_proxy_host("::ffff:6464:64c8"));   // 100.100.100.200 mapped
        assert!(is_blocked_proxy_host("fd00:ec2::254"));
        // Real LAN/global addresses are not metadata.
        assert!(!is_blocked_proxy_host("192.168.0.74"));
        assert!(!is_blocked_proxy_host("2606:4700::1111"));
    }

    /// goonerforporn's key used to ride in the search URL as `&token=`, and
    /// this function is what quotes that URL back into an error the app then
    /// logs. The scrubber cannot see a secret that is only a substring of a
    /// URL, so the query goes.
    #[test]
    fn a_url_in_an_error_carries_no_query_and_no_userinfo() {
        assert_eq!(
            redact_url("https://civitai.com/api/v1/models?query=x&token=SECRET"),
            "https://civitai.com/api/v1/models",
        );
        assert_eq!(
            redact_url("https://civitai.com/api/v1/models?token=SECRET#frag"),
            "https://civitai.com/api/v1/models",
        );
        assert!(!redact_url("https://user:pw@civitai.com/x?token=SECRET").contains("pw"));
        assert!(!redact_url("https://user:pw@civitai.com/x?token=SECRET").contains("SECRET"));
    }

    /// Negative control: a plain URL is left alone, so the message still says
    /// which resource failed, and an unparseable one is not echoed at all.
    #[test]
    fn a_plain_url_survives_and_a_broken_one_is_not_echoed() {
        assert_eq!(
            redact_url("https://huggingface.co/repo/resolve/main/m.gguf"),
            "https://huggingface.co/repo/resolve/main/m.gguf",
        );
        assert_eq!(redact_url("token=SECRET"), "the requested URL");
    }

    #[test]
    fn validate_public_url_blocks_private_and_loopback() {
        for u in [
            "http://localhost/x", "http://127.0.0.1/x", "http://10.0.0.5/x",
            "http://192.168.1.1/x", "http://172.16.4.4/x", "http://169.254.169.254/x",
            "http://[::1]/x", "http://[fd00::1]/x", "http://0.0.0.0/x",
        ] {
            assert!(validate_public_url(u).is_err(), "{} should be blocked", u);
        }
    }

    #[test]
    fn validate_public_url_blocks_numeric_ip_encodings() {
        // inet_aton-style forms the OS resolver would expand to a blocked IP.
        assert!(validate_public_url("http://2852039166/").is_err()); // decimal 169.254.169.254
        assert!(validate_public_url("http://0xA9FEA9FE/").is_err()); // hex 169.254.169.254
        assert!(validate_public_url("http://0x7f000001/").is_err()); // hex 127.0.0.1
    }

    #[test]
    fn validate_public_url_blocks_non_http_schemes() {
        assert!(validate_public_url("file:///etc/passwd").is_err());
        assert!(validate_public_url("ftp://example.com/x").is_err());
        assert!(validate_public_url("not a url").is_err());
    }

    #[test]
    fn validate_public_url_allows_real_public_hosts() {
        // Resolution is stubbed: the assertion is about the policy, and a test
        // that needs a working resolver fails offline for reasons that have
        // nothing to do with the policy.
        for u in [
            "https://huggingface.co/model", "https://civitai.com/api",
            "http://example.com/", "https://8.8.8.8/", "https://3com.com/",
        ] {
            assert!(
                validate_public_url_addrs_with(u, public_answer).is_ok(),
                "{} should be allowed", u
            );
        }
    }

    // ── SSRF: the gate has to judge the ADDRESS, not the host text (M3a) ─────
    //
    // A hostname carries no evidence about where it points. `ollama.attacker.tld`
    // is an ordinary public name whose A record is 127.0.0.1, and `localtest.me`
    // is a public name that does the same by design — so a text-only gate let
    // web_fetch (which needs no remote permission) reach the built-in engine,
    // Ollama, LM Studio, ComfyUI, the remote bridge, the router and the
    // internal wiki.

    fn addr(ip: &str, port: u16) -> SocketAddr {
        SocketAddr::new(ip.parse().unwrap(), port)
    }

    fn public_answer(_host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
        Ok(vec![addr("93.184.216.34", port)])
    }
    fn loopback_answer(_host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
        Ok(vec![addr("127.0.0.1", port)])
    }
    fn lan_answer(_host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
        Ok(vec![addr("192.168.1.50", port)])
    }
    fn metadata_answer(_host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
        Ok(vec![addr("169.254.169.254", port)])
    }
    fn mapped_loopback_answer(_host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
        Ok(vec![addr("::ffff:127.0.0.1", port)])
    }
    fn ula_answer(_host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
        Ok(vec![addr("fd00::1", port)])
    }
    /// A resolver that returns a good address AND a bad one — round-robin DNS
    /// picks per connection, so one poisoned record is enough.
    fn split_answer(_host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
        Ok(vec![addr("93.184.216.34", port), addr("127.0.0.1", port)])
    }
    fn empty_answer(_host: &str, _port: u16) -> Result<Vec<SocketAddr>, String> {
        Ok(vec![])
    }

    #[test]
    fn a_hostname_is_judged_by_the_address_it_answers_with() {
        let hostile: [(&str, HostResolver); 6] = [
            ("loopback", loopback_answer),
            ("LAN", lan_answer),
            ("cloud metadata", metadata_answer),
            ("IPv4-mapped loopback", mapped_loopback_answer),
            ("IPv6 ULA", ula_answer),
            ("one poisoned record among good ones", split_answer),
        ];
        for (what, resolve) in hostile {
            // Nothing about this URL's text is suspicious. Only the answer is.
            let out = validate_public_url_addrs_with("http://ollama.attacker.tld/api/tags", resolve);
            assert!(out.is_err(), "a {} answer was let through", what);
        }
    }

    #[test]
    fn a_hostname_that_answers_a_public_address_is_allowed_and_reported_for_pinning() {
        let addrs =
            validate_public_url_addrs_with("https://huggingface.co/model", public_answer).unwrap();
        // Returned so the caller can pin the socket to exactly this address and
        // not re-resolve (DNS rebinding).
        assert_eq!(addrs, vec![addr("93.184.216.34", 443)]);
    }

    #[test]
    fn a_name_that_answers_nothing_is_refused_rather_than_assumed_public() {
        assert!(validate_public_url_addrs_with("https://nowhere.example/", empty_answer).is_err());
    }

    #[test]
    fn the_blocked_ranges_are_the_same_whether_written_or_resolved() {
        for ip in ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.4.4", "169.254.169.254",
                   "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1",
                   "100.100.100.200"] {
            assert!(is_blocked_ip(ip.parse().unwrap()), "{} should be blocked", ip);
        }
        for ip in ["93.184.216.34", "8.8.8.8", "2606:4700::1111",
                   "100.64.0.1" /* Tailscale CGNAT — the user's own machines */] {
            assert!(!is_blocked_ip(ip.parse().unwrap()), "{} should be allowed", ip);
        }
    }

    // ── SSRF via redirect: the hard block has to survive a 302 (M3b) ─────────

    /// A loopback HTTP stub that answers `/start` with a 302 to `location` and
    /// anything else with 200 "ok".
    async fn redirect_stub<F>(location: F) -> u16
    where
        F: FnOnce(u16) -> String,
    {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let location = location(port);
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let location = location.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let resp = if req.starts_with("GET /start") {
                        format!(
                            "HTTP/1.1 302 Found\r\nLocation: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            location
                        )
                    } else {
                        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_string()
                    };
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.flush().await;
                });
            }
        });
        port
    }

    /// The proxy allow-list waves localhost through, so a backend on localhost
    /// that answers `302 Location: http://169.254.169.254/…` used to hand the
    /// caller the cloud-metadata service — the exact address the hard block
    /// exists for. The redirect never leaves the machine in this test: it is
    /// refused before a connection to 169.254.169.254 is attempted.
    #[test]
    fn a_backend_redirect_into_the_metadata_service_is_not_followed() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let port = redirect_stub(|_| {
                "http://169.254.169.254/latest/meta-data/iam/security-credentials/".to_string()
            })
            .await;
            let client = proxy_client(Duration::from_secs(10), ProxyAllowList::default()).unwrap();
            let out = client.get(format!("http://127.0.0.1:{}/start", port)).send().await;
            let err = out.expect_err("the metadata redirect must not be followed");
            assert!(err.is_redirect(), "refused for the wrong reason: {err}");
        });
    }

    #[test]
    fn a_redirect_that_stays_inside_the_allow_list_is_still_followed() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let port = redirect_stub(|p| format!("http://127.0.0.1:{}/ok", p)).await;
            let client = proxy_client(Duration::from_secs(10), ProxyAllowList::default()).unwrap();
            let resp = client
                .get(format!("http://127.0.0.1:{}/start", port))
                .send()
                .await
                .expect("a localhost → localhost redirect is legitimate");
            assert!(resp.status().is_success());
            assert_eq!(resp.text().await.unwrap(), "ok");
        });
    }

    #[test]
    fn the_allow_list_refuses_every_hop_target_it_would_refuse_as_a_first_request() {
        let allow = ProxyAllowList::default();
        for u in [
            "http://169.254.169.254/latest/meta-data/",
            "http://[::ffff:169.254.169.254]/",
            "http://100.100.100.200/",
            "http://192.168.1.99/v1/models",   // LAN host the user never configured
            "http://intranet.corp/wiki",
            "file:///etc/passwd",
        ] {
            assert!(allow.check(u).is_err(), "{} should be refused", u);
        }
        // What the proxy exists for still passes.
        for u in ["http://127.0.0.1:11434/api/chat", "http://localhost:8188/prompt"] {
            assert!(allow.check(u).is_ok(), "{} should be allowed", u);
        }
    }

    // ── The stream always ends with an EOF marker ────────────────────────────

    /// A loopback stub that writes `script` verbatim and then, if `hold` is set,
    /// keeps the socket open without sending anything — what a backend that
    /// died mid-generation looks like from the client side.
    async fn raw_stub(script: &'static str, hold: Option<Duration>) -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let _ = sock.write_all(script.as_bytes()).await;
                    let _ = sock.flush().await;
                    if let Some(d) = hold {
                        tokio::time::sleep(d).await;
                    }
                });
            }
        });
        port
    }

    async fn pump_and_collect(
        url: &str,
        token: &tokio_util::sync::CancellationToken,
        idle: Duration,
        grace: Duration,
    ) -> (Result<(), String>, Vec<Vec<u8>>) {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Vec<u8>>::new()));
        let sink_store = seen.clone();
        let sink = move |chunk: Vec<u8>| {
            sink_store.lock().unwrap().push(chunk);
            true
        };
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap();
        let out = pump_proxy_stream(&client, url, None, None, None, token, idle, grace, &sink).await;
        let chunks = seen.lock().unwrap().clone();
        (out, chunks)
    }

    /// The renderer closes its ReadableStream on the empty chunk and on nothing
    /// else; the invoke result does not close it. A path that ends without the
    /// marker leaves the reader hanging on a 15 s grace timer, which is why Stop
    /// used to look frozen. Loopback is proxy-first in Tauri, so this is the
    /// default route for the built-in engine, Ollama and LM Studio.
    ///
    /// The marker is NOT free, though, and the first version of this test had
    /// that backwards. It settles the renderer's Response as 200 with an empty
    /// body. Send it after a failure that produced no answer, and the real
    /// error, which reaches JS one tick later on the rejected invoke, arrives
    /// too late and is dropped: every unreachable local backend came out as
    /// "The connection dropped before the model finished its answer. Check your
    /// network and try again." (counter-check P1, 2026-09-04, LU Engine
    /// switched off; the truth was a refused connection on 127.0.0.1). So the
    /// rule is: end what has an end. A cancel and a finished body have one, and
    /// so does a stream that died after delivering data. A connect failure and
    /// a rejected status do not, and they must travel as failures.
    #[test]
    fn the_marker_ends_an_answer_and_never_hides_a_failure() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let short = Duration::from_millis(200);

            // 1. Stop pressed before the connection is even up.
            let port = raw_stub("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi", None).await;
            let token = tokio_util::sync::CancellationToken::new();
            token.cancel();
            let (out, chunks) = pump_and_collect(
                &format!("http://127.0.0.1:{}/", port), &token, short, short).await;
            assert!(out.is_ok(), "cancel is not an error: {out:?}");
            assert_eq!(chunks, vec![Vec::<u8>::new()], "cancel must still emit EOF");

            // 2. Nothing listening: the failure happens before the first byte.
            //    No marker, or the refused connection reads as a dropped answer.
            let dead = {
                let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let p = l.local_addr().unwrap().port();
                drop(l);
                p
            };
            let token = tokio_util::sync::CancellationToken::new();
            let (out, chunks) = pump_and_collect(
                &format!("http://127.0.0.1:{}/", dead), &token, short, short).await;
            assert!(out.is_err());
            assert!(chunks.is_empty(), "a refused connection must not look like an ended answer: {chunks:?}");

            // 3. The backend answers, but with an error status. Same rule: the
            //    renderer has to see the status and the body, not an empty 200.
            let port = raw_stub(
                "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 5\r\nConnection: close\r\n\r\nboom",
                None,
            ).await;
            let token = tokio_util::sync::CancellationToken::new();
            let (out, chunks) = pump_and_collect(
                &format!("http://127.0.0.1:{}/", port), &token, short, short).await;
            assert!(out.is_err());
            assert!(chunks.is_empty(), "a rejected status must not look like an ended answer: {chunks:?}");

            // 4. The ordinary path: chunks, then the marker, in that order.
            let port = raw_stub(
                "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
                None,
            ).await;
            let token = tokio_util::sync::CancellationToken::new();
            let (out, chunks) = pump_and_collect(
                &format!("http://127.0.0.1:{}/", port), &token, short, short).await;
            assert!(out.is_ok(), "{out:?}");
            assert_eq!(chunks.first().map(|c| c.as_slice()), Some(&b"hello"[..]));
            assert_eq!(chunks.last(), Some(&Vec::<u8>::new()));

            // 5. The backend delivers, then goes quiet with the socket open.
            //    There IS half an answer in the window, so it gets a clean end
            //    and the reader keeps what it already has.
            let port = raw_stub(
                "HTTP/1.1 200 OK\r\nContent-Length: 32\r\n\r\nhalf",
                Some(Duration::from_secs(2)),
            ).await;
            let token = tokio_util::sync::CancellationToken::new();
            let (out, chunks) = pump_and_collect(
                &format!("http://127.0.0.1:{}/", port), &token, short, short).await;
            assert!(out.is_err(), "the idle window has to fire: {out:?}");
            assert_eq!(chunks.first().map(|c| c.as_slice()), Some(&b"half"[..]));
            assert_eq!(chunks.last(), Some(&Vec::<u8>::new()), "data seen, so the stream gets an end");
        });
    }

    /// The only other bound on a proxied stream is the 7200 s whole-request
    /// timeout, so a backend that dies with the socket still open (killed
    /// process, suspended container, LAN backend that fell off the Wi-Fi) held
    /// the UI for two hours.
    #[test]
    fn a_stalled_stream_is_cut_with_a_reason_and_still_emits_eof() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            // Headers + one chunk of a chunked body, then silence — the
            // terminating 0-chunk never arrives.
            let port = raw_stub(
                "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n",
                Some(Duration::from_secs(30)),
            ).await;
            let token = tokio_util::sync::CancellationToken::new();
            let (out, chunks) = pump_and_collect(
                &format!("http://127.0.0.1:{}/", port),
                &token,
                Duration::from_millis(250),
                Duration::from_secs(10),
            ).await;
            let err = out.expect_err("a stalled stream must not hang");
            assert!(err.contains("stopped sending data"), "unhelpful reason: {err}");
            assert_eq!(chunks.first().map(|c| c.as_slice()), Some(&b"hello"[..]));
            assert_eq!(chunks.last(), Some(&Vec::<u8>::new()));
        });
    }

    /// A cold model is read off disk and pushed into VRAM before the first
    /// token, which for a large GGUF takes minutes. Cutting that at the idle
    /// timeout would break loading rather than protect it, so the window before
    /// the first chunk is its own, much longer one.
    ///
    /// When it does run out there is no answer to end, so no marker either, and
    /// the reason travels as the failure it is. Before 04.09.2026 the marker
    /// went out anyway, the renderer settled a 200 with an empty body, and the
    /// sentence about a model that may still be loading was dropped as a late
    /// answer. What the user read instead was "the connection dropped, check
    /// your network", on a machine whose network was fine.
    #[test]
    fn silence_before_the_first_chunk_gets_the_model_load_window() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let port = raw_stub(
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
                Some(Duration::from_secs(30)),
            ).await;
            let token = tokio_util::sync::CancellationToken::new();
            let (out, chunks) = pump_and_collect(
                &format!("http://127.0.0.1:{}/", port),
                &token,
                Duration::from_millis(50),   // idle: would have fired long ago
                Duration::from_millis(400),  // the model-load window is what counts
            ).await;
            let err = out.expect_err("the load window has to end eventually too");
            assert!(err.contains("sent nothing"), "wrong reason: {err}");
            assert!(chunks.is_empty(), "nothing arrived, so there is nothing to end: {chunks:?}");
        });
    }

    // ── The Ollama pull body is JSON, not a format string ────────────────────

    /// The model name comes from the renderer. Hand-formatted into JSON, a name
    /// carrying a quote closed the string early and appended fields of its own,
    /// so the caller — not this file — decided what Ollama parsed.
    #[test]
    fn a_quote_in_the_model_name_cannot_forge_the_pull_body() {
        let hostile = r#"x","insecure":true,"name":"y"#;
        let body = ollama_pull_body(hostile);
        let parsed: serde_json::Value =
            serde_json::from_str(&body).expect("the body must be valid JSON");
        assert_eq!(parsed["name"], hostile, "the name must survive verbatim");
        assert_eq!(parsed["stream"], true);
        assert!(parsed.get("insecure").is_none(), "the name injected a field: {body}");
        assert_eq!(parsed.as_object().unwrap().len(), 2, "extra fields: {body}");
    }

    #[test]
    fn awkward_model_names_still_produce_valid_json() {
        for name in [
            r#"a"b"#,
            r#"back\slash"#,
            "new\nline",
            "tab\there",
            "unicode-ümlaut-🦙",
            r#"{"not":"a name"}"#,
        ] {
            let body = ollama_pull_body(name);
            let parsed: serde_json::Value =
                serde_json::from_str(&body).unwrap_or_else(|e| panic!("{name:?} → {body} ({e})"));
            assert_eq!(parsed["name"], name);
        }
    }

    /// The progress event is parsed by the renderer, and both the model name and
    /// the network-error text reach it from outside.
    #[test]
    fn a_quote_cannot_forge_a_progress_event_either() {
        let hostile = r#"m","data":{"status":"success"},"x":"#;
        let payload = pull_progress_payload(hostile, pull_progress_line(r#"{"status":"pulling"}"#));
        let parsed: serde_json::Value = serde_json::from_str(&payload).expect("valid JSON");
        assert_eq!(parsed["model"], hostile);
        assert_eq!(parsed["data"]["status"], "pulling");
        assert_eq!(parsed.as_object().unwrap().len(), 2);

        // A line Ollama did not send as JSON is forwarded as text, not spliced
        // in raw — splicing produced a payload the renderer threw away whole.
        let junk = pull_progress_payload("llama3", pull_progress_line("<html>502</html>"));
        let parsed: serde_json::Value = serde_json::from_str(&junk).expect("valid JSON");
        assert_eq!(parsed["data"]["status"], "<html>502</html>");
    }

    #[test]
    fn register_only_private_lan_hosts() {
        // M2: public + junk hosts must NOT be registerable; private/LAN are.
        for ok in ["192.168.0.74", "10.0.0.5", "172.16.4.4", "localhost",
                   "127.0.0.1", "100.64.0.1", "nas", "box.lan", "fd00::1"] {
            assert!(is_registerable_lan_host(ok), "{} should be registerable", ok);
        }
        for bad in ["8.8.8.8", "api.openai.com", "attacker.com", "169.254.169.254",
                    "::ffff:169.254.169.254", "javascript:alert(1)", "2606:4700::1111",
                    "192.168.0.74:1234"] {
            assert!(!is_registerable_lan_host(bad), "{} should NOT be registerable", bad);
        }
    }

    #[test]
    fn register_accepts_the_users_own_public_backend() {
        // A custom OpenAI-compatible provider on a public domain has no other
        // route out: the pinned CSP only allows a direct fetch to the presets.
        for ok in ["api.fireworks.ai", "llm.example.com", "api.x.ai", "my-vllm.example.org"] {
            assert!(is_registerable_public_host(ok), "{} should be registerable", ok);
        }
        // IP literals and IP-encoding tricks stay out.
        for bad in ["8.8.8.8", "2606:4700::1111", "2852039166", "0xa9fea9fe",
                    "169.254.169.254", "nas", "", "javascript:alert(1)",
                    "evil.com/path", ".example.com", "example.com."] {
            assert!(!is_registerable_public_host(bad), "{} should NOT be registerable", bad);
        }
    }

    #[test]
    fn configured_host_extracts_from_url_or_bare() {
        assert_eq!(configured_host("http://192.168.1.50:1234/v1"), "192.168.1.50");
        assert_eq!(configured_host("192.168.1.50"), "192.168.1.50");
        assert_eq!(configured_host("HTTP://Host.LAN:8080"), "host.lan");
        assert_eq!(configured_host("  nas  "), "nas");
    }
}

/// The root guard on model identity: a request to the built-in engine may not
/// name a model the engine is not holding.
///
/// The finding these pin down was measured, not reasoned about: on the Windows
/// box, with Gemma loaded, `"model": "Hermes-3-Llama-3.2-3B.Q4_K_M"` and
/// `"model": "gibt-es-nicht-42"` were both answered by Gemma without an error.
#[cfg(test)]
mod builtin_model_guard_tests {
    use super::*;

    const PORT: u16 = 8127;
    const GEMMA: &str = "C:\\Users\\ddrob\\AppData\\Roaming\\lu\\models\\mlabonne_gemma-3-4b-it-abliterated-Q4_K_M.gguf";
    const CHAT: &str = "http://127.0.0.1:8127/v1/chat/completions";

    fn body(model: &str) -> String {
        format!(r#"{{"model":"{}","messages":[{{"role":"user","content":"hi"}}]}}"#, model)
    }

    #[test]
    fn a_foreign_model_name_is_refused_in_english_naming_both_models() {
        let b = body("Hermes-3-Llama-3.2-3B.Q4_K_M");
        let msg = builtin_model_conflict(CHAT, Some(&b), GEMMA, PORT)
            .expect("the wrong model must not be answered silently");
        assert!(msg.contains("mlabonne_gemma-3-4b-it-abliterated-Q4_K_M"), "got: {msg}");
        assert!(msg.contains("Hermes-3-Llama-3.2-3B.Q4_K_M"), "got: {msg}");
        // English, and no localised wording can reach this string at all: it is
        // built from two file names and our own words.
        assert!(msg.is_ascii(), "got: {msg}");
    }

    #[test]
    fn a_model_that_does_not_exist_is_refused_too() {
        let b = body("gibt-es-nicht-42");
        assert!(builtin_model_conflict(CHAT, Some(&b), GEMMA, PORT).is_some());
    }

    // ── Negative controls: everything that must still pass through ──────────

    #[test]
    fn the_loaded_model_passes_prefixed_or_not() {
        for name in [
            "mlabonne_gemma-3-4b-it-abliterated-Q4_K_M",
            "openai::mlabonne_gemma-3-4b-it-abliterated-Q4_K_M",
            "mlabonne_gemma-3-4b-it-abliterated-Q4_K_M.gguf",
        ] {
            let b = body(name);
            assert!(
                builtin_model_conflict(CHAT, Some(&b), GEMMA, PORT).is_none(),
                "the loaded model was refused under the name {name}"
            );
        }
    }

    #[test]
    fn another_port_is_none_of_our_business() {
        // Ollama, LM Studio, ComfyUI and the embeddings server all answer on
        // their own ports and manage their own models.
        let b = body("llama3.1:8b");
        for url in [
            "http://127.0.0.1:11434/v1/chat/completions",
            "http://127.0.0.1:1234/v1/chat/completions",
            "http://127.0.0.1:8128/v1/completions",
        ] {
            assert!(builtin_model_conflict(url, Some(&b), GEMMA, PORT).is_none(), "{url}");
        }
    }

    #[test]
    fn endpoints_without_a_model_claim_are_untouched() {
        let b = body("Hermes-3-Llama-3.2-3B.Q4_K_M");
        for url in [
            "http://127.0.0.1:8127/v1/models",
            "http://127.0.0.1:8127/props",
            "http://127.0.0.1:8127/health",
            "http://127.0.0.1:8127/slots",
        ] {
            assert!(builtin_model_conflict(url, Some(&b), GEMMA, PORT).is_none(), "{url}");
        }
    }

    #[test]
    fn a_request_that_names_no_model_is_not_invented_into_a_conflict() {
        assert!(builtin_model_conflict(CHAT, None, GEMMA, PORT).is_none());
        assert!(builtin_model_conflict(CHAT, Some("{}"), GEMMA, PORT).is_none());
        assert!(builtin_model_conflict(CHAT, Some(r#"{"model":""}"#), GEMMA, PORT).is_none());
        assert!(builtin_model_conflict(CHAT, Some(r#"{"model":null}"#), GEMMA, PORT).is_none());
        // Not JSON at all: the guard has no claim to check, and mangling the
        // request would be worse than forwarding it.
        assert!(builtin_model_conflict(CHAT, Some("not json"), GEMMA, PORT).is_none());
    }

    #[test]
    fn nothing_loaded_means_nothing_to_contradict() {
        let b = body("Hermes-3-Llama-3.2-3B.Q4_K_M");
        assert!(builtin_model_conflict(CHAT, Some(&b), "", PORT).is_none());
    }

    #[test]
    fn localhost_spellings_are_all_the_same_engine() {
        let b = body("Hermes-3-Llama-3.2-3B.Q4_K_M");
        for url in [
            "http://localhost:8127/v1/chat/completions",
            "http://127.0.0.1:8127/v1/chat/completions/",
            "http://127.0.0.2:8127/v1/completions",
        ] {
            assert!(builtin_model_conflict(url, Some(&b), GEMMA, PORT).is_some(), "{url}");
        }
    }

    #[test]
    fn a_split_gguf_is_known_by_the_name_the_picker_shows() {
        // scan_gguf_models lists a split set under its base name and points at
        // part 1, so a raw stem compare would refuse every split model.
        let loaded = "/m/DeepSeek-V4-Flash-Q4_K_M-00001-of-00003.gguf";
        let b = body("DeepSeek-V4-Flash-Q4_K_M");
        assert!(builtin_model_conflict(CHAT, Some(&b), loaded, PORT).is_none());
        assert_eq!(builtin_model_name_from_path(loaded), "DeepSeek-V4-Flash-Q4_K_M");
        // And a name that only looks like a shard marker keeps it.
        assert_eq!(builtin_model_name_from_path("/m/best-of-both-worlds.gguf"), "best-of-both-worlds");
    }

    #[test]
    fn the_name_is_read_off_both_path_shapes_and_any_extension_case() {
        assert_eq!(builtin_model_name_from_path("/Users/x/models/qwen2.5-0.5b.gguf"), "qwen2.5-0.5b");
        assert_eq!(builtin_model_name_from_path("C:\\m\\qwen2.5-0.5b.GGUF"), "qwen2.5-0.5b");
        assert_eq!(builtin_model_name_from_path("qwen2.5-0.5b"), "qwen2.5-0.5b");
    }
}
