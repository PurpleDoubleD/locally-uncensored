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

    read_text_capped(resp, FETCH_EXTERNAL_MAX_BYTES, &url).await
}

/// How much of an answer `fetch_external` reads before it gives up.
///
/// It used to read whatever came. On a phone a 100 MiB answer became one
/// string over the bridge and ended the app (out of memory); on the desktop it
/// only cost memory. The callers are the catalogue (Hugging Face search and
/// file tree, CivitAI search), with addresses the app builds. Measured on
/// 10.10.2026: Hugging Face search 9 to 15 KB, a file tree up to 127 KB (a
/// page of the tree API holds at most 1000 entries, about 0.4 MB), a CivitAI
/// search of 20 models 0.13 to 2.07 MB. The desktop limit is eight times the
/// largest of those. The phone never asks CivitAI, so its limit is eight
/// times a full page of a file tree, and far below what its memory gives.
const fn fetch_external_limit(phone: bool) -> usize {
    if phone {
        4 * 1024 * 1024
    } else {
        16 * 1024 * 1024
    }
}
const FETCH_EXTERNAL_MAX_BYTES: usize = fetch_external_limit(cfg!(mobile));

fn fetch_external_too_large(limit: usize, url: &str) -> String {
    format!(
        "The answer from {} is larger than {} MB, so it was not read.",
        redact_url(url),
        limit / (1024 * 1024)
    )
}

/// Read a text body piece by piece and stop at `limit` bytes. A
/// `Content-Length` over the limit ends it before the first piece; a body
/// without one is counted while it arrives, and dropping the response closes
/// the connection. What was read is then decoded by reqwest exactly as
/// `Response::text()` did before (charset of the Content-Type, UTF-8
/// otherwise, lossy), so an answer under the limit is the same string.
async fn read_text_capped(
    mut resp: reqwest::Response,
    limit: usize,
    url: &str,
) -> Result<String, String> {
    if resp.content_length().is_some_and(|len| len > limit as u64) {
        return Err(fetch_external_too_large(limit, url));
    }
    let content_type = resp.headers().get(reqwest::header::CONTENT_TYPE).cloned();
    let mut body: Vec<u8> = Vec::new();
    while let Some(piece) = resp.chunk().await.map_err(|e| os_error::english(&e))? {
        if body.len() + piece.len() > limit {
            return Err(fetch_external_too_large(limit, url));
        }
        body.extend_from_slice(&piece);
    }
    let mut rebuilt = axum::http::Response::builder();
    if let Some(value) = content_type {
        rebuilt = rebuilt.header(reqwest::header::CONTENT_TYPE, value);
    }
    let rebuilt = rebuilt
        .body(body)
        .map_err(|e| format!("fetch_external: {}", e))?;
    reqwest::Response::from(rebuilt)
        .text()
        .await
        .map_err(|e| os_error::english(&e))
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

/// What the user reads when a name could not be looked up.
///
/// Deliberately not worded as "Blocked": nothing was blocked. The gate could
/// not get an answer from the resolver, which on a phone on a train and on a
/// desktop behind a sleepy router means the same thing: the network is slow
/// or gone. The sentence says that and what to do, and it names the host so a
/// typo in a custom address is visible too.
pub(crate) fn lookup_failed_message(host: &str) -> String {
    format!(
        "Could not look up '{}'. The network seems to be slow or offline. Check the connection and try again.",
        host
    )
}

/// How long each attempt of a lookup may take. One entry is one attempt.
///
/// The quick list is for everything that sits inside a click or inside a
/// redirect hop of a short request: one attempt, five seconds, then "cannot
/// tell". The patient list is for a download, where five seconds was not
/// enough on a slow line and the user saw a failed row for a file that would
/// have started on the next try (models 26c): three attempts, each with more
/// time than the one before.
const QUICK_LOOKUP: &[Duration] = &[Duration::from_secs(5)];
const PATIENT_LOOKUP: &[Duration] =
    &[Duration::from_secs(5), Duration::from_secs(10), Duration::from_secs(20)];
/// A resolver that answers "unknown" at once is asked again after this pause:
/// a network that is just coming up answers the second time.
const LOOKUP_RETRY_PAUSE: Duration = Duration::from_millis(1500);

/// What a download does with a resolver that answers "unknown" AT ONCE.
///
/// On the phone that answer is what a network change looks like (WLAN to
/// mobile data), so the lookup is repeated after a breath. On the desktop an
/// instant "unknown" means there is no network, and v3.0.5 said so at once.
/// It still does: `None` makes that answer final. Only a lookup that runs
/// into its time limit, which is what a slow line looks like, is repeated
/// there.
const DOWNLOAD_LOOKUP_RETRY: Option<Duration> = download_lookup_retry(cfg!(mobile));

const fn download_lookup_retry(phone: bool) -> Option<Duration> {
    if phone {
        Some(LOOKUP_RETRY_PAUSE)
    } else {
        None
    }
}

/// The blocking lookup itself, injectable so the retry logic can be tested
/// against a resolver that hangs, fails or answers late.
type RawLookup = fn(&str, u16) -> std::io::Result<Vec<SocketAddr>>;

fn os_lookup(host: &str, port: u16) -> std::io::Result<Vec<SocketAddr>> {
    use std::net::ToSocketAddrs;
    format!("{}:{}", host, port).to_socket_addrs().map(|it| it.collect())
}

/// Resolve with a hard cap per attempt. `to_socket_addrs` has no timeout knob
/// and an unreachable resolver parks the calling thread for the OS default
/// (tens of seconds on some stacks); the gate sits on a request path, so it
/// caps the wait and fails closed rather than hanging the command.
///
/// Every attempt starts its own lookup and all of them report into one
/// channel: an answer that an earlier, slow attempt finally gets still
/// counts. Silent: nothing is shown or logged to the user between attempts.
fn resolve_with(
    host: &str,
    port: u16,
    caps: &[Duration],
    pause: Option<Duration>,
    lookup: RawLookup,
) -> Result<Vec<SocketAddr>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<std::io::Result<Vec<SocketAddr>>>();
    // Lookups that have not reported yet. A failure only counts once nobody
    // is left who could still bring an answer.
    let mut outstanding = 0usize;
    for (attempt, cap) in caps.iter().enumerate() {
        let last = attempt + 1 == caps.len();
        let tx = tx.clone();
        let target = host.to_string();
        std::thread::spawn(move || {
            let _ = tx.send(lookup(&target, port));
        });
        outstanding += 1;
        let deadline = std::time::Instant::now() + *cap;
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match rx.recv_timeout(left) {
                Ok(Ok(addrs)) => return Ok(addrs),
                Ok(Err(_)) => {
                    outstanding = outstanding.saturating_sub(1);
                    if outstanding > 0 {
                        continue;
                    }
                    if last {
                        return Err(lookup_failed_message(host));
                    }
                    // The resolver did answer, with "unknown". A network that
                    // is just coming up answers differently a moment later.
                    // Without a pause that answer is final: there is no
                    // network, and saying so now beats saying so later.
                    let Some(pause) = pause else {
                        return Err(lookup_failed_message(host));
                    };
                    std::thread::sleep(pause);
                    break;
                }
                // This attempt's time is up. Its lookup keeps running and may
                // still answer during the next one.
                Err(_) => break,
            }
        }
    }
    Err(lookup_failed_message(host))
}

fn resolve_host(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    resolve_with(host, port, QUICK_LOOKUP, Some(LOOKUP_RETRY_PAUSE), os_lookup)
}

/// The resolver of a download: three attempts with growing time, see
/// `PATIENT_LOOKUP`. Blocks for up to 35 s in the worst case (a resolver that
/// never answers at all), so it is only ever called from a blocking thread.
/// On the desktop a resolver that answers "unknown" ends it at once, see
/// `DOWNLOAD_LOOKUP_RETRY`.
fn resolve_host_patient(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    resolve_with(host, port, PATIENT_LOOKUP, DOWNLOAD_LOOKUP_RETRY, os_lookup)
}

/// The gate, returning the addresses it approved so the caller can pin the
/// connection to exactly those (see `pinned_client`).
pub(crate) fn validate_public_url_addrs(raw: &str) -> Result<Vec<SocketAddr>, String> {
    validate_public_url_addrs_with(raw, resolve_host)
}

/// The same gate with the patient resolver. For downloads only.
pub(crate) fn validate_public_url_addrs_patient(raw: &str) -> Result<Vec<SocketAddr>, String> {
    validate_public_url_addrs_with(raw, resolve_host_patient)
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
    pinned_client_as(host, addrs, timeout, crate::app_identity::outgoing_agent!("2.0"))
}

/// The same pin for a caller that names itself differently (`web_reach`, the
/// page fetch of the agent). Nothing else about the client changes.
pub(crate) fn pinned_client_as(
    host: &str,
    addrs: &[SocketAddr],
    timeout: Duration,
    user_agent: &str,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(user_agent)
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
pub(crate) async fn ssrf_safe_fetch(
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

/// The client of one hop of a model download: pinned to the addresses the
/// gate approved for that hop, no automatic redirects, and limits per connect
/// and per read instead of one deadline for the whole transfer (a download
/// may take hours, a dead socket must not).
fn pinned_download_client(
    host: &str,
    addrs: &[SocketAddr],
    connect_secs: u64,
    read_secs: u64,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(crate::app_identity::outgoing_agent!("1.5"))
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(connect_secs))
        .read_timeout(Duration::from_secs(read_secs));
    if parse_ip_host(host).is_none() {
        builder = builder.resolve_to_addrs(host, addrs);
    }
    builder.build().map_err(|e| os_error::english(&e))
}

/// How often a connection that could not be opened is tried again before the
/// download row turns into an error, and how long to wait in between.
///
/// Phone only. A connection that is refused or unreachable AT ONCE is what a
/// phone between two networks looks like, so it waits and tries again. On the
/// desktop the same answer means the network or the server is gone, and
/// v3.0.5 said so at once: no retries there, the error comes as fast as it
/// did. (A slow line shows as a timeout, and that is not retried anywhere:
/// it already took its whole limit.)
const CONNECT_RETRY_PAUSES: &[Duration] = connect_retry_pauses(cfg!(mobile));

const PHONE_CONNECT_RETRY_PAUSES: &[Duration] = &[Duration::from_millis(1500), Duration::from_secs(4)];

const fn connect_retry_pauses(phone: bool) -> &'static [Duration] {
    if phone {
        PHONE_CONNECT_RETRY_PAUSES
    } else {
        &[]
    }
}

/// Send the first request of a model download and follow its redirects by
/// hand.
///
/// Why not the redirect policy of reqwest, as before: the policy can only
/// look a host up with the quick resolver (it runs inside reqwest), and
/// reqwest then looks the same name up a second time to connect. On a slow
/// line that was two chances per hop to run into the five second cap, and
/// the user got "Blocked: 'huggingface.co' did not resolve within 5 s" or
/// "Request failed: error following redirect" for a download that started on
/// the next click (models 26c). Here every hop
///
///   * is looked up ONCE, by the patient resolver (three attempts, growing
///     time), off the reactor,
///   * is held to the same gate as before (`validate_public_url`), and
///   * is connected to exactly the addresses that passed, so a resolver that
///     answers differently the second time has nothing to answer.
///
/// A connection that cannot be opened is tried again twice, silently. A
/// timeout is not: that already took its whole limit.
///
/// `build` makes the request for one hop. It gets the address of that hop,
/// so a credential can be attached for the host it belongs to and for no
/// other, which is what reqwest did by dropping `Authorization` on a change
/// of host.
pub(crate) async fn send_download_request<F>(
    url: &str,
    connect_secs: u64,
    read_secs: u64,
    max_hops: usize,
    build: F,
) -> Result<reqwest::Response, String>
where
    F: Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
{
    send_download_request_with(
        url,
        connect_secs,
        read_secs,
        max_hops,
        build,
        validate_public_url_addrs_patient,
        CONNECT_RETRY_PAUSES,
    )
    .await
}

async fn send_download_request_with<F>(
    url: &str,
    connect_secs: u64,
    read_secs: u64,
    max_hops: usize,
    build: F,
    gate: fn(&str) -> Result<Vec<SocketAddr>, String>,
    retry_pauses: &[Duration],
) -> Result<reqwest::Response, String>
where
    F: Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
{
    let mut current = url.to_string();
    for _ in 0..=max_hops {
        let target = current.clone();
        let addrs = tokio::task::spawn_blocking(move || gate(&target))
            .await
            .map_err(|e| format!("Request failed: resolver task failed: {}", e))??;
        let parsed = url::Url::parse(&current).map_err(|e| format!("Invalid URL: {}", e))?;
        let host = parsed.host_str().unwrap_or("").to_string();
        let client = pinned_download_client(&host, &addrs, connect_secs, read_secs)?;

        let mut pauses = retry_pauses.iter();
        let resp = loop {
            match build(&client, &current).send().await {
                Ok(resp) => break resp,
                Err(e) if e.is_connect() && !e.is_timeout() => match pauses.next() {
                    Some(pause) => tokio::time::sleep(*pause).await,
                    None => return Err(connect_failed_message(&host, &os_error::english(&e))),
                },
                Err(e) => return Err(format!("Request failed: {}", os_error::english(&e))),
            }
        };
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
    Err("Request failed: too many redirects".to_string())
}

/// What the user reads when the server of a download could not be reached
/// after the silent retries. The technical reason stays at the end for a bug
/// report, the sentence in front is the part to act on.
fn connect_failed_message(host: &str, detail: &str) -> String {
    format!(
        "Could not reach '{}'. The network seems to be slow or offline. Check the connection and try again. ({})",
        host, detail
    )
}

/// True only for private/LAN hosts a user could legitimately point a local
/// backend at. `register_openai_host` requires this so the RUST boundary — not
/// the JS caller — enforces the LAN-only intent and can't be tricked into
/// allow-listing arbitrary public/intranet hosts (SSRF hardening M2). Mirrors
/// the frontend `isPrivateOrLanHost`. Input must be bracket-stripped+lowercased.
fn is_registerable_lan_host(host: &str) -> bool {
    is_registerable_lan_host_on(host, cfg!(mobile))
}

/// `phone` switches on the one rule the desktop of v3.0.5 did not have: a bare
/// number is no machine name. The desktop keeps accepting what it accepted.
fn is_registerable_lan_host_on(host: &str, phone: bool) -> bool {
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
    // A bare number is not a machine name: `2852039166` and `0xA9FEA9FE` are
    // both 169.254.169.254 to the resolver. The request itself was never
    // fooled (the URL parser turns them into the dotted form, and that one is
    // judged), but such an entry has no business in the list either.
    // Phone only: on the desktop this is the list of v3.0.5, unchanged.
    if phone && is_numeric_host_form(&h) {
        return false;
    }
    // Bare single-label machine name (no dots, no stray ':') = LAN host.
    !h.contains('.') && !h.contains(':')
}

/// An address written as one number, decimal or `0x` hex.
fn is_numeric_host_form(h: &str) -> bool {
    let decimal = !h.is_empty() && h.chars().all(|c| c.is_ascii_digit());
    let hex = h.len() > 2 && h.starts_with("0x") && h[2..].chars().all(|c| c.is_ascii_hexdigit());
    decimal || hex
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
    /// True in the Android and iOS builds. There a host out on the internet
    /// is only reached over https, see `check`.
    phone: bool,
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
            phone: cfg!(mobile),
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

        let registered = (!self.ollama.is_empty() && host == self.ollama)
            || (!self.comfy.is_empty() && host == self.comfy)
            || self.openai.contains(&host);
        if registered {
            // A phone does not talk plain http to the internet: the API key
            // of a provider would cross a mobile network and every public
            // wifi in the clear. The webview is held to the same rule by the
            // system (usesCleartextTraffic=false on Android, App Transport
            // Security on iOS), and this proxy must not be the way around
            // it. A server in the home network stays reachable over http,
            // that is what people run there. The desktop is unchanged.
            if self.phone && parsed.scheme() == "http" && !is_registerable_lan_host_on(&host, true) {
                return Err(format!(
                    "This phone only connects to '{host}' over https. Change the address of this provider so that it starts with https://."
                ));
            }
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
        .user_agent(crate::app_identity::outgoing_agent!("2.0"))
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

/// The caller's headers, with the key of the LU Engine on a request that goes
/// to one (engine_key.rs). The web view never knows the key, so whatever it
/// sent as `Authorization` for the engine (an empty key from the provider
/// slot, at most) is replaced, not added to. Every other request keeps the
/// caller's headers as they were.
fn with_engine_key(
    url: &str,
    headers: Option<std::collections::HashMap<String, String>>,
    engine_ports: &[u16],
) -> Option<std::collections::HashMap<String, String>> {
    if !super::engine_key::goes_to_engine(url, engine_ports) {
        return headers;
    }
    let mut out: std::collections::HashMap<String, String> = headers
        .unwrap_or_default()
        .into_iter()
        .filter(|(k, _)| !k.eq_ignore_ascii_case("authorization") && !k.eq_ignore_ascii_case("x-api-key"))
        .collect();
    out.insert("Authorization".to_string(), super::engine_key::bearer());
    Some(out)
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

/// The cancellable core of `proxy_localhost`: send the request, then read the
/// whole body, each `.await` raced against `token`. Factored out of the
/// `#[tauri::command]` wrapper (which needs a live `tauri::State` this does
/// not), so a unit test can drive it against a real hanging TCP stub without
/// a running Tauri app, the same split `pump_proxy_stream` already uses for
/// the chunked-stream path.
///
/// The up-front `is_cancelled()` check is deliberate and not redundant with
/// the `select!` below: `token` may already be cancelled when this is
/// called (a `CancelRegistry::register` that found a tombstone hands back a
/// pre-cancelled token (review 2026-09-18, R3 Nachbesserung 1, the
/// cancel-before-register race). `tokio::select!` polls every branch once
/// and picks whichever is ready, which is USUALLY the already-ready
/// `cancelled()` future, but not deterministically so, and for a loopback
/// connect the `request.send()` branch can also complete on its very first
/// poll. Checking first makes "a pre-cancelled token never sends anything"
/// a guarantee instead of a race the test would only catch sometimes.
///
/// Dropping the `request.send()` / `resp.text()` future on cancellation drops
/// the underlying reqwest connection, which is what actually stops the local
/// engine from continuing to generate, the point of this whole fix (review
/// 2026-09-18, "Loch 3": a non-streaming tool call against the built-in
/// engine/Ollama read `options.signal` nowhere, so Stop settled the JS
/// promise as "cancelled" while the GPU kept computing an answer to
/// completion).
async fn cancellable_request(
    request: reqwest::RequestBuilder,
    token: &tokio_util::sync::CancellationToken,
) -> Result<String, String> {
    if token.is_cancelled() {
        return Err("proxy_localhost: cancelled".to_string());
    }

    let resp = tokio::select! {
        _ = token.cancelled() => return Err("proxy_localhost: cancelled".to_string()),
        r = request.send() => r.map_err(|e| format!("proxy_localhost: {}", os_error::english(&e)))?,
    };

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        // Race this read too (review 2026-09-18 Runde 2, "kleiner Rest"): a
        // backend that answers with an error status and then sits on the
        // body was previously covered only by the reqwest timeout, not by
        // Stop, the same class of gap the success-path read below was
        // already fixed for.
        //
        // F1 fix (review-w2rust.md): `biased;` with the cancel branch first
        // makes "a cancel that lands exactly when the body finishes reading
        // is still a cancel" deterministic instead of a coin flip between
        // the two ready branches (tokio::select! otherwise polls in random
        // order).
        let text = tokio::select! {
            biased;
            _ = token.cancelled() => return Err("proxy_localhost: cancelled".to_string()),
            r = resp.text() => r.unwrap_or_default(),
        };
        return Err(format!("HTTP {}: {}", status, text));
    }

    // Also race the body read: a slow/hanging generator can accept the
    // request and then sit on the response body, and Stop must cut that off
    // too, not just the connect phase.
    tokio::select! {
        _ = token.cancelled() => Err("proxy_localhost: cancelled".to_string()),
        r = resp.text() => r.map_err(|e| os_error::english(&e)),
    }
}

/// Generic localhost proxy — fetch any localhost or configured-backend URL
/// bypassing CORS. Used for Ollama and ComfyUI API calls in production mode,
/// including a non-streaming tool call's `chatWithTools` against the
/// built-in engine or Ollama.
///
/// `timeout_ms` (optional) overrides the default 300 s timeout. Backend
/// detection passes 2000 — without that override the onboarding "Searching
/// for local backends..." step would freeze for 5 minutes whenever a port
/// happens to be answered by software that takes the TCP connect but
/// never replies HTTP (Discord report — Docker dev container on 8000,
/// firewall throttling, another LLM tool with a slow health endpoint, ...).
/// Long-running calls (Ollama pull, ComfyUI generate) keep the 300 s default.
///
/// `call_id` (optional) is the same callId/cancel mechanic the chunked stream
/// path already has (`proxy_localhost_stream_chunked` + `cancel_proxy_stream`,
/// 2026-06-15): the caller mints an id, sends it here, and fires
/// `cancel_proxy_call(call_id)` when the user hits Stop.
#[tauri::command]
pub async fn proxy_localhost(
    url: String,
    method: Option<String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    headers: Option<std::collections::HashMap<String, String>>,
    call_id: Option<String>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<String, String> {
    let allow = ProxyAllowList::snapshot(&state);
    allow.check(&url)?;
    // A generation request may not name a model the engine is not holding.
    guard_builtin_model(&url, body.as_deref(), &state)?;
    let headers = with_engine_key(&url, headers, &super::engine_key::engine_ports(&state));

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(300_000));

    let client = proxy_client(timeout, allow)?;

    let http_method = method.unwrap_or_else(|| "GET".to_string());

    let mut request = match http_method.as_str() {
        "POST" => client.post(&url),
        "DELETE" => client.delete(&url),
        "PUT" => client.put(&url),
        _ => client.get(&url),
    };

    request = super::engine_token::attach(request, &url);
    request = apply_body_and_headers(request, body, headers);

    // Register against the shared CancelRegistry (mirrors stream_tokens /
    // proxy_localhost_stream_chunked): survives a cancel that arrives before
    // this line runs, not just one that arrives after (review 2026-09-18, R3
    // Nachbesserung 1). A caller that sent no call_id gets an uncancellable
    // token and no registry entry -- the same "opt-in cancellation" shape
    // the chunked stream path has always had for a missing stream_id.
    let (token, _guard) = match call_id {
        Some(id) => {
            let (token, guard) = state.call_tokens.register(id);
            (token, Some(guard))
        }
        None => (tokio_util::sync::CancellationToken::new(), None),
    };

    cancellable_request(request, &token).await
}

/// Cancel an in-flight non-streaming `proxy_localhost` call by its `call_id`.
/// Twin of `cancel_proxy_stream` for the non-chunked path, fired from the JS
/// side's `AbortSignal` listener when the user hits Stop.
#[tauri::command]
pub fn cancel_proxy_call(
    state: tauri::State<'_, crate::state::AppState>,
    call_id: String,
) -> Result<(), String> {
    state.call_tokens.cancel(&call_id);
    Ok(())
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
    let headers = with_engine_key(&url, headers, &super::engine_key::engine_ports(&state));

    let client = proxy_client(Duration::from_secs(7200), allow)?;

    let http_method = method.unwrap_or_else(|| "GET".to_string());

    let mut request = match http_method.as_str() {
        "POST" => client.post(&url),
        "DELETE" => client.delete(&url),
        "PUT" => client.put(&url),
        _ => client.get(&url),
    };

    request = super::engine_token::attach(request, &url);
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

/// Chunked streaming localhost proxy for Ollama chat (2026-06-02).
///
/// The webview CANNOT fetch Ollama directly — its origin is `http://tauri.localhost`
/// and Ollama's CORS rejects it ("TypeError: Failed to fetch"), so ALL chat traffic
/// is routed through the proxy. The buffered `proxy_localhost_stream` awaits the
/// ENTIRE body (2-hour timeout), so a long/slow generation produced NOTHING in the UI
/// until fully finished — a multi-minute "model loading"/hang (Discord report).
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
    // (2026-06-15: deleting/Stopping a chat must stop the backend too).
    stream_id: Option<String>,
    // Max silence between two chunks once the backend has started answering.
    // Optional so the renderer can widen it for a backend that is known to
    // think for minutes between tokens; see IDLE_TIMEOUT_MS for the default.
    idle_timeout_ms: Option<u64>,
    // Issue 177: the wait for the FIRST chunk, from Settings, General, Chat
    // Reply Timeout. None keeps FIRST_CHUNK_GRACE, 0 means Off (wait as long
    // as the connection stays open). See first_chunk_window.
    first_chunk_timeout_ms: Option<u64>,
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
    let headers = with_engine_key(&url, headers, &super::engine_key::engine_ports(&state));

    // Built before the token is registered: everything after the registration
    // has to reach the pump, which is what guarantees the EOF marker and the
    // registry cleanup. An early `?` between the two would skip both.
    let idle = Duration::from_millis(idle_timeout_ms.unwrap_or(IDLE_TIMEOUT_MS));
    let first_chunk_grace = first_chunk_window(first_chunk_timeout_ms, FIRST_CHUNK_GRACE);
    let client = proxy_client(whole_request_limit(first_chunk_grace), allow)?;

    // Register against the shared CancelRegistry (mirrors call_tokens /
    // proxy_localhost). Survives a cancel that arrives before this line
    // runs, not just one that arrives after (review 2026-09-18, R3
    // Nachbesserung 1): the registry hands back an already-cancelled token
    // in that case instead of silently losing the cancel, same guarantee
    // the non-streaming path now has. The guard replaces the old manual
    // "remove after the pump" cleanup below.
    let (token, _guard) = match stream_id {
        Some(id) => {
            let (token, guard) = state.stream_tokens.register(id);
            (token, Some(guard))
        }
        None => (tokio_util::sync::CancellationToken::new(), None),
    };

    pump_proxy_stream(
        &client,
        &url,
        method,
        body,
        headers,
        &token,
        idle,
        first_chunk_grace,
        &move |chunk| on_chunk.send(chunk).is_ok(),
    )
    .await
}

/// "Off" for the first chunk wait: thirty days, far past any prompt and still
/// a value tokio can add to an Instant without overflowing.
const FIRST_CHUNK_OFF: Duration = Duration::from_secs(30 * 24 * 3600);

/// The first chunk window for one stream (issue 177): the renderer's setting
/// in ms, 0 for Off, or the built in default when it sent none.
fn first_chunk_window(setting_ms: Option<u64>, default: Duration) -> Duration {
    match setting_ms {
        None => default,
        Some(0) => FIRST_CHUNK_OFF,
        Some(ms) => Duration::from_millis(ms).min(FIRST_CHUNK_OFF),
    }
}

/// The reqwest timeout over the WHOLE request. It used to be a flat 7200 s,
/// which a first chunk limit above roughly two hours (or Off) would have
/// undercut: the request would die of the total limit while the setting still
/// promised to wait. An hour of answer on top of the first chunk window, and
/// never less than the old two hours.
fn whole_request_limit(first_chunk: Duration) -> Duration {
    Duration::from_secs(7200).max(first_chunk.saturating_add(Duration::from_secs(3600)))
}

/// The reason a stream ends when the first chunk window ran out, before or
/// after the response headers (issue 177).
fn nothing_sent_for(window: Duration) -> String {
    format!(
        "the backend accepted the request but sent nothing for {} s. A very large model or a very long prompt can take this long; raise Chat Reply Timeout in Settings, General, or restart the backend if it is not working.",
        window.as_secs()
    )
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
        if token.is_cancelled() {
            // Same deterministic short-circuit as cancellable_request: a
            // token that starts pre-cancelled (a CancelRegistry tombstone
            // from a cancel that beat the registration, review 2026-09-18,
            // R3 Nachbesserung 1) must never let request.send() be polled,
            // not just usually lose the tokio::select! race against it.
            return Ok(());
        }

        let http_method = method.unwrap_or_else(|| "GET".to_string());

        let mut request = match http_method.as_str() {
            "POST" => client.post(url),
            "DELETE" => client.delete(url),
            "PUT" => client.put(url),
            _ => client.get(url),
        };

        request = super::engine_token::attach(request, url);
        request = apply_body_and_headers(request, body, headers);

        // Race the request against cancellation even during connect/headers.
        // Issue 177: the first chunk window also covers the wait for the
        // response headers. A server that holds them back until its first
        // token (Ollama while it loads a model, a proxy in front of a busy
        // backend) used to wait the whole request limit of two hours, whatever
        // Chat Reply Timeout said (Windows run d307-j: limit 30 s, a stub
        // that answered after 45 s without headers got its answer through).
        let resp = tokio::select! {
            _ = token.cancelled() => return Ok(()),
            r = tokio::time::timeout(first_chunk_grace, request.send()) => match r {
                Err(_) => return Err(nothing_sent_for(first_chunk_grace)),
                Ok(r) => r.map_err(|e| format!("proxy_localhost_stream_chunked: {}", os_error::english(&e)))?,
            },
        };

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            // Same fix as cancellable_request's error branch: race the body
            // read against Stop instead of leaving it covered only by the
            // reqwest timeout. `biased;` (F1, review-w2rust.md) keeps a
            // cancel that lands exactly when the body finishes reading a
            // cancel (Ok(())), never the coin flip that could otherwise
            // surface it as Err("HTTP 500: ...") instead.
            let text = tokio::select! {
                biased;
                _ = token.cancelled() => return Ok(()),
                r = resp.text() => r.unwrap_or_default(),
            };
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
                        nothing_sent_for(window)
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
/// A stream id with nothing registered yet leaves a tombstone instead of
/// doing nothing (review 2026-09-18, R3 Nachbesserung 1), so a cancel that
/// arrives before `proxy_localhost_stream_chunked` reaches its registration
/// line is not lost.
#[tauri::command]
pub fn cancel_proxy_stream(
    state: tauri::State<'_, crate::state::AppState>,
    stream_id: String,
) -> Result<(), String> {
    state.stream_tokens.cancel(&stream_id);
    Ok(())
}

/// Upload an image to ComfyUI's `/upload/image` as a clean multipart POST from
/// Rust. `uploadImage()` in the frontend used a RAW browser `fetch()` — the only
/// non-proxy fetch left — which 400'd on some WebView2 builds (multipart /
/// boundary / CORS-preflight quirks; 2026-06-14 "Failed to upload image:
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
        .user_agent(crate::app_identity::outgoing_agent!("2.0"))
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
    // Bug Z/a v2.5.0 — GH #48. We need to know whether the stream
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
        .user_agent(crate::app_identity::outgoing_agent!("2.0"))
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

    /// Security pass of 2026-10-13: the engine answered every web page. It
    /// now wants its key, and only the Rust side has it.
    #[test]
    fn a_request_to_the_engine_carries_its_key_and_no_key_of_the_caller() {
        let engine = [8127];
        let sent = with_engine_key(
            "http://127.0.0.1:8127/v1/chat/completions",
            Some(caller("authorization", "Bearer ")),
            &engine,
        )
        .unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent["Authorization"], super::super::engine_key::bearer());
        let with_x_key = with_engine_key("http://localhost:8127/v1/models", Some(caller("X-Api-Key", "k")), &engine).unwrap();
        assert!(!with_x_key.keys().any(|k| k.eq_ignore_ascii_case("x-api-key")));
        assert!(with_engine_key("http://127.0.0.1:8127/slots", None, &engine).is_some());
    }

    #[test]
    fn a_request_anywhere_else_keeps_the_headers_of_the_caller_and_never_gets_the_key() {
        let engine = [8127];
        for url in ["http://127.0.0.1:11434/api/chat", "http://127.0.0.1:1234/v1/models", "http://192.168.1.5:8127/v1/models"] {
            let sent = with_engine_key(url, Some(caller("Authorization", "Bearer k")), &engine).unwrap();
            assert_eq!(sent["Authorization"], "Bearer k", "{url}");
            assert!(with_engine_key(url, None, &engine).is_none(), "{url}");
        }
        // No engine running: nothing is an engine request.
        let sent = with_engine_key("http://127.0.0.1:8127/v1/models", None, &[]);
        assert!(sent.is_none());
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
                .user_agent(crate::app_identity::outgoing_agent!("2.0"))
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
                .user_agent(crate::app_identity::outgoing_agent!("2.0"))
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

    /// a user's key used to ride in the search URL as `&token=`, and
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
            let (dead, _held) = crate::test_support::refusing_port();
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

    /// Same fix as `cancelling_during_an_error_bodys_read_returns_almost_
    /// immediately` (`cancellable_request`'s twin gap), for the streaming
    /// pump: a backend that answers a non-2xx status and then stalls the
    /// body must be cut off by Stop, not left to the 7200 s whole-request
    /// timeout alone.
    #[test]
    fn cancelling_during_a_stalled_error_body_returns_almost_immediately_in_the_stream_pump() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let port = raw_stub(
                "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 999999\r\n\r\nstart",
                Some(Duration::from_secs(10)),
            )
            .await;
            let token = tokio_util::sync::CancellationToken::new();
            let cancel_token = token.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(150)).await;
                cancel_token.cancel();
            });
            let short = Duration::from_secs(30);

            let start = std::time::Instant::now();
            let outcome = tokio::time::timeout(
                Duration::from_secs(2),
                pump_and_collect(&format!("http://127.0.0.1:{}/", port), &token, short, short),
            )
            .await;
            let elapsed = start.elapsed();

            let (out, chunks) = outcome.expect(
                "pump_proxy_stream must not hang on a stalled ERROR body -- \
                 without the fix this only returns once the stub's 10s hold elapses",
            );
            assert!(out.is_ok(), "a cancel must not surface as an error: {out:?}");
            // Same rule as every other cancel branch in this pump ("end what
            // has an end"): Ok(()) always gets the EOF marker, regardless of
            // which phase the cancel landed in.
            assert_eq!(chunks, vec![Vec::<u8>::new()], "a cancel must still emit EOF: {chunks:?}");
            assert!(elapsed < Duration::from_millis(1000), "took {elapsed:?}");
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

    /// Issue 177, found in the app on Windows (d307-j): a server that takes
    /// the request but holds back even its headers is bound by the same
    /// window. Before, only the whole request limit of two hours ended it.
    #[test]
    fn a_server_that_sends_no_headers_ends_at_the_first_chunk_window() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let port = raw_stub("", Some(Duration::from_secs(30))).await;
            let token = tokio_util::sync::CancellationToken::new();
            let started = std::time::Instant::now();
            let (out, chunks) = pump_and_collect(
                &format!("http://127.0.0.1:{}/", port),
                &token,
                Duration::from_millis(50),
                Duration::from_millis(400),
            ).await;
            let err = out.expect_err("no headers within the window has to end the wait");
            assert!(started.elapsed() < Duration::from_secs(10), "waited past the window");
            assert!(err.contains("sent nothing for 0 s"), "wrong reason: {err}");
            assert!(err.contains("Chat Reply Timeout"), "does not say where to change it: {err}");
            assert!(chunks.is_empty(), "nothing arrived: {chunks:?}");
        });
    }

    /// Issue 177: the first chunk window is the user's setting. None keeps the
    /// old 600 s, 0 is Off, any other value is taken in ms.
    #[test]
    fn the_first_chunk_window_follows_the_setting() {
        let default = Duration::from_secs(600);
        assert_eq!(first_chunk_window(None, default), default);
        assert_eq!(first_chunk_window(Some(1_800_000), default), Duration::from_secs(1800));
        assert_eq!(first_chunk_window(Some(0), default), FIRST_CHUNK_OFF);
        assert_eq!(first_chunk_window(Some(u64::MAX), default), FIRST_CHUNK_OFF);
    }

    /// The whole request limit never undercuts the first chunk window: with
    /// four hours to wait for the first byte, a flat two hour total would have
    /// ended the request first.
    #[test]
    fn the_whole_request_limit_leaves_room_after_the_first_chunk() {
        assert_eq!(whole_request_limit(Duration::from_secs(600)), Duration::from_secs(7200));
        assert_eq!(whole_request_limit(Duration::from_secs(4 * 3600)), Duration::from_secs(5 * 3600));
        assert!(whole_request_limit(FIRST_CHUNK_OFF) > FIRST_CHUNK_OFF);
    }

    /// The window from the setting is the one the pump waits, and the reason
    /// names it and the place to change it.
    #[test]
    fn a_short_setting_ends_the_wait_with_its_own_number() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let port = raw_stub(
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
                Some(Duration::from_secs(30)),
            ).await;
            let token = tokio_util::sync::CancellationToken::new();
            let window = first_chunk_window(Some(1_000), Duration::from_secs(600));
            let started = std::time::Instant::now();
            let (out, _chunks) = pump_and_collect(
                &format!("http://127.0.0.1:{}/", port),
                &token,
                Duration::from_millis(50),
                window,
            ).await;
            let err = out.expect_err("the set window has to end the wait");
            assert!(started.elapsed() < Duration::from_secs(10), "waited past the setting");
            assert!(err.contains("sent nothing for 1 s"), "wrong reason: {err}");
            assert!(err.contains("Chat Reply Timeout"), "does not say where to change it: {err}");
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

    // ── R3: the non-streaming proxy_localhost path is actually cancellable ──

    /// A loopback stub that accepts the connection, reads the request, and
    /// then says nothing at all for `hold`, what a local engine/Ollama looks
    /// like mid-generation from the client side of a non-streaming call
    /// (`request.send()` is still awaiting the response headers).
    async fn hang_stub(hold: Duration) -> u16 {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    tokio::time::sleep(hold).await;
                    // Socket dropped here without ever writing a response.
                });
            }
        });
        port
    }

    /// Same shape as `hang_stub`, plus an atomic counter incremented on every
    /// ACCEPTED connection -- the proof instrument for "the request must
    /// never have been sent at all", which a mere assertion on the return
    /// value cannot tell apart from "sent, then aborted mid-flight".
    async fn counting_hang_stub(connections: std::sync::Arc<std::sync::atomic::AtomicUsize>, hold: Duration) -> u16 {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                connections.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    tokio::time::sleep(hold).await;
                });
            }
        });
        port
    }

    /// Without R3's fix, `cancellable_request` had no `token` argument at
    /// all: `request.send()` was a bare `.await`, so cancelling never
    /// interrupted anything and this test would only return once the stub's
    /// hold elapsed (here 10 s) or the client's own timeout fired. The fix
    /// races the send against the token, so cancelling ~150 ms in must return
    /// almost immediately and well inside the 2 s outer bound.
    #[test]
    fn cancelling_during_send_returns_almost_immediately_against_a_hanging_server() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let port = hang_stub(Duration::from_secs(10)).await;
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap();
            let token = tokio_util::sync::CancellationToken::new();
            let cancel_token = token.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(150)).await;
                cancel_token.cancel();
            });

            let start = std::time::Instant::now();
            let request = client.get(format!("http://127.0.0.1:{}/", port));
            let outcome = tokio::time::timeout(
                Duration::from_secs(2),
                cancellable_request(request, &token),
            )
            .await;
            let elapsed = start.elapsed();

            let result = outcome.expect(
                "cancellable_request did not return within 2s of a 150ms cancel \
                 against a server that holds for 10s -- the abort did not reach reqwest",
            );
            assert!(result.is_err(), "a cancelled call must not report success: {result:?}");
            assert!(
                elapsed < Duration::from_millis(1000),
                "cancellation took {elapsed:?}, expected well under 1s"
            );
        });
    }

    /// Same shape, but the hang is on the response BODY (headers already
    /// sent) rather than on connect/send: the second `tokio::select!` in
    /// `cancellable_request`, around `resp.text()`.
    #[test]
    fn cancelling_during_body_read_returns_almost_immediately() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            // Headers claim a body that never fully arrives -- Content-Length
            // promises more bytes than are ever written, then the socket
            // holds open, so `resp.text()` sits waiting for the rest.
            let port = raw_stub(
                "HTTP/1.1 200 OK\r\nContent-Length: 999999\r\n\r\nstart",
                Some(Duration::from_secs(10)),
            )
            .await;
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap();
            let token = tokio_util::sync::CancellationToken::new();
            let cancel_token = token.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(150)).await;
                cancel_token.cancel();
            });

            let start = std::time::Instant::now();
            let request = client.get(format!("http://127.0.0.1:{}/", port));
            let outcome = tokio::time::timeout(
                Duration::from_secs(2),
                cancellable_request(request, &token),
            )
            .await;
            let elapsed = start.elapsed();

            let result = outcome.expect("cancellable_request must not hang on a stalled body");
            assert!(result.is_err(), "a cancelled call must not report success: {result:?}");
            assert!(elapsed < Duration::from_millis(1000), "took {elapsed:?}");
        });
    }

    /// Review 2026-09-18 Runde 2, "kleiner Rest": the ERROR branch (status
    /// not 2xx) read its body with a bare `.await`, not raced against the
    /// token, so a backend that answers e.g. 500 and then stalls the body
    /// could only be cut off by the reqwest timeout, never by Stop. Same
    /// shape as `cancelling_during_body_read_returns_almost_immediately`
    /// above, but the stub answers an error status.
    #[test]
    fn cancelling_during_an_error_bodys_read_returns_almost_immediately() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let port = raw_stub(
                "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 999999\r\n\r\nstart",
                Some(Duration::from_secs(10)),
            )
            .await;
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap();
            let token = tokio_util::sync::CancellationToken::new();
            let cancel_token = token.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(150)).await;
                cancel_token.cancel();
            });

            let start = std::time::Instant::now();
            let request = client.get(format!("http://127.0.0.1:{}/", port));
            let outcome = tokio::time::timeout(
                Duration::from_secs(2),
                cancellable_request(request, &token),
            )
            .await;
            let elapsed = start.elapsed();

            let result = outcome.expect(
                "cancellable_request must not hang on a stalled ERROR body -- \
                 without the fix this only returns once the stub's 10s hold elapses",
            );
            assert!(result.is_err(), "a cancelled call must not report success: {result:?}");
            assert!(elapsed < Duration::from_millis(1000), "took {elapsed:?}");
        });
    }

    /// A second, independent call against a server that answers normally
    /// must be completely unaffected by an earlier call's cancellation.
    /// This drives the REAL registry on a real `AppState`, the same one
    /// `proxy_localhost`/`cancel_proxy_call` use, and cancels by id through
    /// `cancel()` rather than holding two hand-built tokens -- the previous
    /// version of this test built two separate, never-registered
    /// `CancellationToken`s and cancelled one of them directly, which is
    /// true no matter how (or whether) the lookup logic works and proved
    /// nothing about `state.call_tokens` (review 2026-09-18, R3
    /// Nachbesserung 2). `cancel_registry::tests::
    /// cancel_finds_exactly_its_own_call_and_leaves_a_second_registered_
    /// call_running` covers the registry contract itself in isolation; this
    /// one proves the SAME contract holds end to end through `cancellable_
    /// request` and a real socket.
    #[test]
    fn cancelling_one_call_does_not_touch_a_second_unrelated_call() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let hanging_port = hang_stub(Duration::from_secs(10)).await;
            let ok_port = raw_stub(
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                None,
            )
            .await;
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap();

            let state = crate::state::AppState::new();
            let (hanging_token, _hanging_guard) = state.call_tokens.register("hanging-call".to_string());
            let (ok_token, _ok_guard) = state.call_tokens.register("ok-call".to_string());

            // Cancel by id, through the same registry both real commands
            // share, not by holding the token directly.
            state.call_tokens.cancel("hanging-call");

            let hanging_req = client.get(format!("http://127.0.0.1:{}/", hanging_port));
            let hanging_out = cancellable_request(hanging_req, &hanging_token).await;
            assert!(hanging_out.is_err());

            // The unrelated, still-registered call must go through exactly
            // as if "hanging-call" had never existed.
            assert!(!ok_token.is_cancelled(), "cancel(\"hanging-call\") must not reach the ok-call token");
            let ok_req = client.get(format!("http://127.0.0.1:{}/", ok_port));
            let ok_out = cancellable_request(ok_req, &ok_token).await;
            assert_eq!(ok_out.as_deref(), Ok("ok"), "an unrelated call must go through untouched: {ok_out:?}");
        });
    }

    /// R3 Nachbesserung 1 end to end: a cancel that arrives before
    /// `proxy_localhost` ever reaches its registration line must still stop
    /// the request, proven against a real listening socket that counts
    /// connections -- not just that `CancelRegistry::register` returns an
    /// already-cancelled token (that half is `cancel_registry::tests::
    /// a_cancel_before_register_hands_back_an_already_cancelled_token`),
    /// but that `cancellable_request` then never dials out at all.
    #[test]
    fn a_cancel_that_arrives_before_registration_never_opens_a_connection() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let connections = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let port = counting_hang_stub(connections.clone(), Duration::from_secs(10)).await;

            let state = crate::state::AppState::new();
            let call_id = "race-before-register".to_string();

            // The cancel arrives FIRST -- the exact startup-window race from
            // the review: in the real command this window is
            // ProxyAllowList::snapshot + allow.check + guard_builtin_model +
            // proxy_client, all of which run before the registration line.
            state.call_tokens.cancel(&call_id);

            let (token, _guard) = state.call_tokens.register(call_id);
            assert!(token.is_cancelled(), "register() after a cancel must hand back an already-cancelled token");

            let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().unwrap();
            let request = client.get(format!("http://127.0.0.1:{}/", port));
            let out = cancellable_request(request, &token).await;

            assert!(out.is_err(), "a pre-cancelled token must not report success");
            assert_eq!(
                connections.load(std::sync::atomic::Ordering::SeqCst),
                0,
                "the request must never have been sent to the stub"
            );
        });
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
    const GEMMA: &str = "C:\\Users\\alice\\AppData\\Roaming\\lu\\models\\mlabonne_gemma-3-4b-it-abliterated-Q4_K_M.gguf";
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

/// Slow or missing networks (models 26c): the lookup is tried again with more
/// time, silently, and what is left at the end is a sentence about the
/// network, not a "Blocked".
#[cfg(test)]
mod patient_lookup_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    const MS: fn(u64) -> Duration = Duration::from_millis;

    fn answer(port: u16) -> Vec<SocketAddr> {
        vec![SocketAddr::new("93.184.216.34".parse().unwrap(), port)]
    }

    fn unknown() -> std::io::Error {
        std::io::Error::other("failed to lookup address information")
    }

    #[test]
    fn a_lookup_that_hangs_once_is_asked_again_and_the_second_answer_counts() {
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        fn lookup(_: &str, port: u16) -> std::io::Result<Vec<SocketAddr>> {
            if CALLS.fetch_add(1, Ordering::SeqCst) == 0 {
                std::thread::sleep(MS(3000));
                return Err(unknown());
            }
            Ok(answer(port))
        }
        let started = Instant::now();
        let out = resolve_with("huggingface.co", 443, &[MS(150), MS(300), MS(600)], Some(MS(20)), lookup);
        assert_eq!(out, Ok(answer(443)));
        assert_eq!(CALLS.load(Ordering::SeqCst), 2, "one silent retry, not three");
        assert!(started.elapsed() < MS(1500), "the second attempt answered, nobody waits for the first");
    }

    #[test]
    fn an_answer_that_arrives_late_still_counts() {
        // The first lookup needs longer than its own time, but less than the
        // time of the first two attempts together. The second one never
        // answers. The app must take what the first one finally brings.
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        fn lookup(_: &str, port: u16) -> std::io::Result<Vec<SocketAddr>> {
            if CALLS.fetch_add(1, Ordering::SeqCst) == 0 {
                std::thread::sleep(MS(350));
                return Ok(answer(port));
            }
            std::thread::sleep(MS(5000));
            Err(unknown())
        }
        let out = resolve_with("huggingface.co", 443, &[MS(150), MS(600), MS(600)], Some(MS(20)), lookup);
        assert_eq!(out, Ok(answer(443)));
    }

    #[test]
    fn a_resolver_that_says_unknown_is_asked_again_after_a_breath() {
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        fn lookup(_: &str, port: u16) -> std::io::Result<Vec<SocketAddr>> {
            if CALLS.fetch_add(1, Ordering::SeqCst) < 2 {
                return Err(unknown());
            }
            Ok(answer(port))
        }
        let out = resolve_with("huggingface.co", 443, &[MS(500), MS(500), MS(500)], Some(MS(30)), lookup);
        assert_eq!(out, Ok(answer(443)));
        assert_eq!(CALLS.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_network_that_never_answers_ends_in_a_sentence_about_the_network() {
        fn lookup(_: &str, _: u16) -> std::io::Result<Vec<SocketAddr>> {
            std::thread::sleep(MS(4000));
            Err(unknown())
        }
        let started = Instant::now();
        let err = resolve_with("huggingface.co", 443, &[MS(100), MS(200), MS(400)], Some(MS(20)), lookup).unwrap_err();
        let waited = started.elapsed();
        assert!(waited >= MS(690) && waited < MS(2500), "the three limits add up, waited {waited:?}");
        assert_eq!(err, lookup_failed_message("huggingface.co"));
        assert!(!err.contains("Blocked"), "nothing was blocked: {err}");
        assert!(err.contains("huggingface.co") && err.contains("slow or offline") && err.contains("try again"), "{err}");
    }

    #[test]
    fn an_offline_resolver_fails_after_its_retries_and_not_before() {
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        fn lookup(_: &str, _: u16) -> std::io::Result<Vec<SocketAddr>> {
            CALLS.fetch_add(1, Ordering::SeqCst);
            Err(unknown())
        }
        let err = resolve_with("huggingface.co", 443, &[MS(500), MS(500), MS(500)], Some(MS(20)), lookup).unwrap_err();
        assert_eq!(CALLS.load(Ordering::SeqCst), 3);
        assert!(!err.contains("Blocked"), "{err}");
    }

    /// The desktop rule: a resolver that answers "unknown" at once is the
    /// sign of a machine without network. v3.0.5 reported that immediately,
    /// and so does the download now. One lookup, no pause.
    #[test]
    fn on_the_desktop_an_offline_resolver_fails_at_once() {
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        fn lookup(_: &str, _: u16) -> std::io::Result<Vec<SocketAddr>> {
            CALLS.fetch_add(1, Ordering::SeqCst);
            Err(unknown())
        }
        let started = Instant::now();
        let err = resolve_with("huggingface.co", 443, PATIENT_LOOKUP, download_lookup_retry(false), lookup).unwrap_err();
        assert_eq!(CALLS.load(Ordering::SeqCst), 1, "asked once");
        assert!(started.elapsed() < MS(1000), "no pause and no second attempt: {:?}", started.elapsed());
        assert_eq!(err, lookup_failed_message("huggingface.co"));
    }

    /// The other half: a slow line (the lookup runs into its limit) is still
    /// asked again on the desktop, and the second answer counts.
    #[test]
    fn on_the_desktop_a_slow_lookup_is_still_asked_again() {
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        fn lookup(_: &str, port: u16) -> std::io::Result<Vec<SocketAddr>> {
            if CALLS.fetch_add(1, Ordering::SeqCst) == 0 {
                std::thread::sleep(MS(3000));
                return Err(unknown());
            }
            Ok(answer(port))
        }
        let out = resolve_with("huggingface.co", 443, &[MS(150), MS(300), MS(600)], download_lookup_retry(false), lookup);
        assert_eq!(out, Ok(answer(443)));
        assert_eq!(CALLS.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn the_phone_keeps_its_breath_and_the_desktop_has_none() {
        assert_eq!(download_lookup_retry(true), Some(LOOKUP_RETRY_PAUSE));
        assert_eq!(download_lookup_retry(false), None);
        assert_eq!(DOWNLOAD_LOOKUP_RETRY.is_some(), cfg!(mobile));
        assert_eq!(CONNECT_RETRY_PAUSES.is_empty(), !cfg!(mobile));
    }

    #[test]
    fn the_quick_resolver_asks_once() {
        // Everything inside a click keeps the short wait: one attempt.
        assert_eq!(QUICK_LOOKUP.len(), 1);
        assert_eq!(QUICK_LOOKUP[0], Duration::from_secs(5));
        // The download waits longer each time.
        assert_eq!(PATIENT_LOOKUP.len(), 3);
        assert!(PATIENT_LOOKUP.windows(2).all(|w| w[0] < w[1]), "growing limits");
    }

    #[test]
    fn a_failed_lookup_is_not_worded_as_a_refusal_of_the_gate() {
        fn dead(_: &str, _: u16) -> Result<Vec<SocketAddr>, String> {
            Err(lookup_failed_message("huggingface.co"))
        }
        let err = validate_public_url_addrs_with("https://huggingface.co/a/b/resolve/main/m.gguf", dead).unwrap_err();
        assert!(!err.contains("Blocked"), "{err}");
        // A real refusal keeps its word.
        let err = validate_public_url("http://127.0.0.1/x").unwrap_err();
        assert!(err.contains("Blocked"), "{err}");
    }

    // ── the request of a download, hop by hop ────────────────────────────

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// The gate of these tests: loopback passes (that is where the stubs
    /// live), except the one port a test declares forbidden.
    static FORBIDDEN_PORT: AtomicUsize = AtomicUsize::new(0);
    fn loopback_gate(raw: &str) -> Result<Vec<SocketAddr>, String> {
        let parsed = url::Url::parse(raw).map_err(|e| e.to_string())?;
        let port = parsed.port().unwrap_or(80);
        if port as usize == FORBIDDEN_PORT.load(Ordering::SeqCst) {
            return Err("Blocked: private/reserved IP 127.0.0.1".to_string());
        }
        Ok(vec![SocketAddr::new("127.0.0.1".parse().unwrap(), port)])
    }

    /// One tiny HTTP server. Answers every request with `head` and records
    /// the request text it saw.
    async fn stub(listener: TcpListener, head: String, seen: std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { break };
            let head = head.clone();
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                seen.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).to_string());
                let _ = sock.write_all(head.as_bytes()).await;
            });
        }
    }

    const OK_HEAD: &str = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";

    #[tokio::test]
    async fn every_hop_is_checked_and_a_key_only_rides_to_its_own_host() {
        let seen_a = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_b = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let b = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port_b = b.local_addr().unwrap().port();
        let a = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port_a = a.local_addr().unwrap().port();
        tokio::spawn(stub(b, OK_HEAD.to_string(), seen_b.clone()));
        tokio::spawn(stub(
            a,
            format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port_b}/file\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
            seen_a.clone(),
        ));

        let first = format!("http://127.0.0.1:{port_a}/start");
        let key_host = format!("127.0.0.1:{port_a}");
        let resp = send_download_request_with(&first, 5, 5, 4, |client, hop| {
            let mut r = client.get(hop).header("Range", "bytes=7-");
            if hop.contains(&key_host) {
                r = r.bearer_auth("hf_secret");
            }
            r
        }, loopback_gate, PHONE_CONNECT_RETRY_PAUSES)
        .await
        .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let a_saw = seen_a.lock().unwrap().join("\n").to_ascii_lowercase();
        let b_saw = seen_b.lock().unwrap().join("\n").to_ascii_lowercase();
        assert!(a_saw.contains("authorization: bearer hf_secret"), "the first host gets its key");
        assert!(!b_saw.contains("authorization"), "the redirect target must not see the key: {b_saw}");
        assert!(b_saw.contains("range: bytes=7-"), "the range survives the redirect: {b_saw}");
    }

    /// The same chain with the key rule the real download uses: there and
    /// back again. The key goes out on the first hop only, and a later hop
    /// on the first host does not get it back (reqwest in v3.0.5 removed the
    /// header for the rest of the chain).
    #[tokio::test]
    async fn the_download_key_is_gone_for_good_once_a_redirect_left_its_host() {
        let seen_a = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_b = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let b = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port_b = b.local_addr().unwrap().port();
        let a = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port_a = a.local_addr().unwrap().port();
        // b sends everything back to a, a sends /start to b and answers the rest.
        tokio::spawn(stub(
            b,
            format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port_a}/file\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
            seen_b.clone(),
        ));
        let seen = seen_a.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = a.accept().await else { return };
                let mut buf = vec![0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let text = String::from_utf8_lossy(&buf[..n]).to_string();
                let head = if text.starts_with("GET /start") {
                    format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port_b}/signed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                } else {
                    OK_HEAD.to_string()
                };
                seen.lock().unwrap().push(text);
                let _ = sock.write_all(head.as_bytes()).await;
            }
        });

        let first = format!("http://127.0.0.1:{port_a}/start");
        let key = crate::commands::download::RidingKey::new(&first, Some("hf_secret".to_string()));
        let resp = send_download_request_with(&first, 5, 5, 4, |client, hop| {
            let mut r = client.get(hop);
            if let Some(t) = key.for_hop(hop) {
                r = r.bearer_auth(t);
            }
            r
        }, loopback_gate, PHONE_CONNECT_RETRY_PAUSES)
        .await
        .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let a_saw: Vec<String> = seen_a.lock().unwrap().iter().map(|s| s.to_ascii_lowercase()).collect();
        let b_saw = seen_b.lock().unwrap().join("\n").to_ascii_lowercase();
        assert_eq!(a_saw.len(), 2, "{a_saw:?}");
        assert!(a_saw[0].starts_with("get /start") && a_saw[0].contains("authorization: bearer hf_secret"), "{a_saw:?}");
        assert!(!b_saw.contains("authorization"), "the other host must not see the key: {b_saw}");
        assert!(a_saw[1].starts_with("get /file") && !a_saw[1].contains("authorization"), "{a_saw:?}");
    }

    #[tokio::test]
    async fn a_redirect_to_a_refused_address_is_never_requested() {
        let seen_a = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_b = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let b = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port_b = b.local_addr().unwrap().port();
        let a = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port_a = a.local_addr().unwrap().port();
        FORBIDDEN_PORT.store(port_b as usize, Ordering::SeqCst);
        tokio::spawn(stub(b, OK_HEAD.to_string(), seen_b.clone()));
        tokio::spawn(stub(
            a,
            format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:{port_b}/admin\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
            seen_a.clone(),
        ));
        let first = format!("http://127.0.0.1:{port_a}/start");
        let err = send_download_request_with(&first, 5, 5, 4, |client, hop| client.get(hop), loopback_gate, PHONE_CONNECT_RETRY_PAUSES)
            .await
            .unwrap_err();
        FORBIDDEN_PORT.store(0, Ordering::SeqCst);
        assert!(err.contains("Blocked"), "{err}");
        assert_eq!(seen_a.lock().unwrap().len(), 1);
        assert!(seen_b.lock().unwrap().is_empty(), "the refused hop got a request");
    }

    #[tokio::test]
    async fn a_refused_connection_is_tried_again_silently() {
        // Nobody listens at first. The server comes up while the first pause
        // runs, and the request then simply succeeds.
        let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_task = seen.clone();
        tokio::spawn(async move {
            tokio::time::sleep(MS(500)).await;
            let listener = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
            stub(listener, OK_HEAD.to_string(), seen_task).await;
        });
        let url = format!("http://127.0.0.1:{port}/m.gguf");
        let resp = send_download_request_with(&url, 5, 5, 2, |client, hop| client.get(hop), loopback_gate, PHONE_CONNECT_RETRY_PAUSES)
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_server_that_stays_away_ends_in_a_sentence_about_the_network() {
        let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let url = format!("http://127.0.0.1:{port}/m.gguf");
        let started = Instant::now();
        let err = send_download_request_with(&url, 5, 5, 2, |client, hop| client.get(hop), loopback_gate, PHONE_CONNECT_RETRY_PAUSES)
            .await
            .unwrap_err();
        let total: Duration = PHONE_CONNECT_RETRY_PAUSES.iter().sum();
        assert!(started.elapsed() >= total, "both pauses were waited");
        assert!(err.starts_with("Could not reach '127.0.0.1'"), "{err}");
        assert!(err.contains("slow or offline"), "{err}");
        assert!(!err.contains("Blocked"), "{err}");
    }

    /// The desktop: a server that refuses the connection is reported at
    /// once, as in v3.0.5. No pause, no second attempt.
    #[tokio::test]
    async fn on_the_desktop_a_server_that_stays_away_is_reported_at_once() {
        let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let url = format!("http://127.0.0.1:{port}/m.gguf");
        // A refused connect is not instant everywhere: Windows itself tries a
        // closed port again for about two seconds. So the bound is one such
        // attempt plus a margin, which stays below the first pause of the
        // phone (1.5 s) and below a second attempt.
        let one = Instant::now();
        let _ = tokio::net::TcpStream::connect(("127.0.0.1", port)).await;
        let one = one.elapsed();
        let started = Instant::now();
        let err = send_download_request_with(&url, 5, 5, 2, |client, hop| client.get(hop), loopback_gate, connect_retry_pauses(false))
            .await
            .unwrap_err();
        assert!(started.elapsed() < one + MS(1000), "no pause was waited: {:?}, one refused connect: {one:?}", started.elapsed());
        assert!(err.starts_with("Could not reach '127.0.0.1'"), "{err}");
    }

    #[tokio::test]
    async fn a_dead_name_never_reaches_the_network() {
        fn dead(_: &str) -> Result<Vec<SocketAddr>, String> {
            Err(lookup_failed_message("huggingface.co"))
        }
        let err = send_download_request_with(
            "https://huggingface.co/a/b/resolve/main/m.gguf",
            5,
            5,
            2,
            |client, hop| client.get(hop),
            dead,
            PHONE_CONNECT_RETRY_PAUSES,
        )
        .await
        .unwrap_err();
        assert_eq!(err, lookup_failed_message("huggingface.co"));
    }
}

/// Custom endpoints on a phone (round 2, CSP): the webview may only fetch the
/// hosts its CSP names, everything a user enters himself goes through this
/// proxy, and the proxy keeps the rules the system holds the webview to.
#[cfg(test)]
mod phone_proxy_tests {
    use super::*;

    fn list(phone: bool, hosts: &[&str]) -> ProxyAllowList {
        ProxyAllowList {
            ollama: String::new(),
            comfy: String::new(),
            openai: hosts.iter().map(|h| h.to_string()).collect(),
            phone,
        }
    }

    #[test]
    fn a_phone_reaches_a_host_on_the_internet_over_https_only() {
        let phone = list(true, &["llm.example.com", "192.168.1.20", "nas.local", "desktop"]);
        assert!(phone.check("https://llm.example.com/v1/chat/completions").is_ok());
        let err = phone.check("http://llm.example.com/v1/chat/completions").unwrap_err();
        assert!(err.contains("https") && err.contains("llm.example.com"), "{err}");
        // The frontend turns a line that looks like a dead connection into
        // "the server is unreachable". This one must stay readable as it is.
        for word in ["proxy_localhost", "error sending request", "connection refused", "failed to fetch", "tcp connect"] {
            assert!(!err.to_ascii_lowercase().contains(word), "{err} reads like a transport failure");
        }
        // A server at home is what people run over plain http.
        for home in ["http://192.168.1.20:1234/v1/models", "http://nas.local:8080/v1/models", "http://desktop:11434/api/tags"] {
            assert!(phone.check(home).is_ok(), "{home}");
        }
        // The engine on the phone itself.
        assert!(phone.check("http://127.0.0.1:8127/v1/chat/completions").is_ok());
    }

    #[test]
    fn the_desktop_keeps_what_it_had() {
        let desktop = list(false, &["llm.example.com"]);
        assert!(desktop.check("http://llm.example.com/v1/models").is_ok());
        assert!(desktop.check("https://llm.example.com/v1/models").is_ok());
    }

    #[test]
    fn a_host_nobody_entered_and_the_metadata_address_stay_closed_on_both() {
        for phone in [true, false] {
            let allow = list(phone, &["llm.example.com"]);
            assert!(allow.check("https://other.example.com/v1/models").is_err());
            assert!(allow.check("https://169.254.169.254/latest/meta-data/").is_err());
            assert!(allow.check("file:///etc/passwd").is_err());
        }
    }

    #[test]
    fn only_a_name_or_a_home_address_can_be_entered() {
        // What `register_openai_host` lets in: a server at home, or a public
        // name. A bare public number and every numeric disguise stay out.
        for ok in ["192.168.1.20", "10.0.2.2", "nas.local", "desktop", "llm.example.com", "api.x.ai"] {
            assert!(is_registerable_lan_host(ok) || is_registerable_public_host(ok), "{ok}");
        }
        for bad in ["8.8.8.8", "2852039166", "0xA9FEA9FE", "169.254.169.254", "", "a b.example", "llm.example.com/path"] {
            let refused = is_blocked_proxy_host(bad) || (!is_registerable_lan_host_on(bad, true) && !is_registerable_public_host(bad));
            assert!(refused, "{bad} was accepted");
        }
    }

    /// The rule against a bare number is new with the phone. The desktop
    /// accepted such an entry in v3.0.5 (the request itself was never fooled,
    /// see `validate_public_url_blocks_numeric_ip_encodings`), and it still
    /// does: nothing a desktop user had entered stops working.
    #[test]
    fn a_bare_number_is_refused_on_the_phone_and_kept_on_the_desktop() {
        for number in ["2130706433", "0x7f000001", "2852039166", "0xa9fea9fe"] {
            assert!(!is_registerable_lan_host_on(number, true), "{number} on the phone");
            assert!(is_registerable_lan_host_on(number, false), "{number} on the desktop, as in v3.0.5");
        }
        // Everything else is judged the same on both.
        for host in ["192.168.1.20", "nas", "box.lan", "8.8.8.8", "169.254.169.254", "api.openai.com", ""] {
            assert_eq!(is_registerable_lan_host_on(host, true), is_registerable_lan_host_on(host, false), "{host}");
        }
        assert_eq!(is_registerable_lan_host("2130706433"), !cfg!(mobile));
    }

    /// The webview fetches exactly the hosts its CSP names, and the frontend
    /// decides by its own copy of that list (`CSP_DIRECT_HOSTS`) whether a
    /// request goes direct or through this proxy. If the two lists drift, a
    /// provider either dies inside the webview or takes the proxy for
    /// nothing. And the CSP never opens the whole internet: that is what the
    /// proxy with its entered hosts is for.
    #[test]
    fn the_csp_and_the_direct_list_of_the_frontend_name_the_same_hosts() {
        let backend = include_str!("../../../src/api/backend.ts");
        let start = backend.find("const CSP_DIRECT_HOSTS = new Set([").expect("CSP_DIRECT_HOSTS in src/api/backend.ts");
        let block = &backend[start..];
        let block = &block[..block.find("])").expect("end of the set")];
        let direct: Vec<&str> = block
            .lines()
            .filter_map(|l| l.trim().strip_prefix('\''))
            .filter_map(|l| l.split('\'').next())
            .collect();
        assert!(direct.len() >= 10, "the list was not read: {direct:?}");

        for (file, raw) in [
            ("tauri.conf.json", include_str!("../../tauri.conf.json")),
            ("tauri.ios.conf.json", include_str!("../../tauri.ios.conf.json")),
        ] {
            let conf: serde_json::Value = serde_json::from_str(raw).unwrap();
            let csp = conf["app"]["security"]["csp"].as_str().unwrap_or_else(|| panic!("{file} has no CSP"));
            let connect = csp
                .split(';')
                .map(str::trim)
                .find(|d| d.starts_with("connect-src "))
                .unwrap_or_else(|| panic!("{file} has no connect-src"));
            let sources: Vec<&str> = connect.split_whitespace().skip(1).collect();
            for host in &direct {
                assert!(sources.contains(&format!("https://{host}").as_str()), "{file}: connect-src lacks https://{host}");
            }
            // Every https source is one the frontend knows as direct.
            for source in sources.iter().filter(|s| s.starts_with("https://")) {
                let host = source.trim_start_matches("https://");
                let known = direct.contains(&host)
                    || (host.starts_with("*.") && direct.contains(&&host[2..]));
                assert!(known, "{file}: connect-src names {source}, which the frontend would send through the proxy");
            }
            // No door for the whole internet, and no plain http or ws beyond this device.
            for source in &sources {
                assert!(!matches!(*source, "*" | "https:" | "http:" | "wss:" | "ws:" | "https://*"), "{file}: connect-src opens {source}");
                if source.starts_with("http://") || source.starts_with("ws://") {
                    let rest = source.split("://").nth(1).unwrap_or("");
                    let host = rest.split(':').next().unwrap_or("");
                    assert!(
                        matches!(host, "localhost" | "127.0.0.1" | "ipc.localhost" | "tauri.localhost"),
                        "{file}: connect-src allows plain {source}"
                    );
                }
            }
        }
        // Android has no CSP of its own and inherits the one of tauri.conf.json.
        let android: serde_json::Value = serde_json::from_str(include_str!("../../tauri.android.conf.json")).unwrap();
        assert!(android["app"]["security"].is_null(), "tauri.android.conf.json got its own CSP, add it to this test");
    }
}

/// `fetch_external` reads up to a limit and no further.
#[cfg(test)]
mod fetch_external_limit_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// A server that answers one request with `head` and then `body_len`
    /// bytes of "a", in pieces. Returns how many bytes it managed to send.
    async fn body_stub(head: String, body_len: usize) -> (String, tokio::task::JoinHandle<usize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://127.0.0.1:{}/big", listener.local_addr().unwrap().port());
        let task = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = sock.read(&mut buf).await;
            let _ = sock.write_all(head.as_bytes()).await;
            let piece = vec![b'a'; 16 * 1024];
            let mut sent = 0usize;
            while sent < body_len {
                let n = piece.len().min(body_len - sent);
                if sock.write_all(&piece[..n]).await.is_err() {
                    break;
                }
                sent += n;
            }
            let _ = sock.shutdown().await;
            sent
        });
        (url, task)
    }

    const SMALL_LIMIT: usize = 64 * 1024;

    #[tokio::test]
    async fn a_body_over_the_limit_with_content_length_ends_before_the_first_piece() {
        let len = 8 * 1024 * 1024;
        let head = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n");
        let (url, server) = body_stub(head, len).await;
        let resp = reqwest::get(&url).await.unwrap();
        let err = read_text_capped(resp, SMALL_LIMIT, &url).await.unwrap_err();
        assert!(err.starts_with("The answer from http://127.0.0.1:"), "{err}");
        assert!(err.ends_with("is larger than 0 MB, so it was not read."), "{err}");
        // The connection is gone with the response: the server cannot push the rest.
        let sent = server.await.unwrap();
        assert!(sent < len, "the server sent all {sent} bytes, nothing stopped it");
    }

    #[tokio::test]
    async fn a_body_over_the_limit_without_content_length_ends_while_it_arrives() {
        let len = 8 * 1024 * 1024;
        // No Content-Length: the body ends when the server closes.
        let head = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n".to_string();
        let (url, server) = body_stub(head, len).await;
        let resp = reqwest::get(&url).await.unwrap();
        assert_eq!(resp.content_length(), None);
        let err = read_text_capped(resp, SMALL_LIMIT, &url).await.unwrap_err();
        assert!(err.contains("so it was not read."), "{err}");
        let sent = server.await.unwrap();
        assert!(sent < len, "the server sent all {sent} bytes, nothing stopped it");
    }

    #[tokio::test]
    async fn a_body_at_the_limit_is_read_whole_with_and_without_content_length() {
        for with_length in [true, false] {
            let len = SMALL_LIMIT;
            let head = if with_length {
                format!("HTTP/1.1 200 OK\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n")
            } else {
                "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_string()
            };
            let (url, server) = body_stub(head, len).await;
            let resp = reqwest::get(&url).await.unwrap();
            let text = read_text_capped(resp, SMALL_LIMIT, &url).await.unwrap();
            assert_eq!(text.len(), len);
            assert!(text.bytes().all(|b| b == b'a'));
            assert_eq!(server.await.unwrap(), len);
        }
    }

    /// The string is the one `Response::text()` gave before: the charset of
    /// the Content-Type decides, UTF-8 without one, bad bytes become U+FFFD.
    #[tokio::test]
    async fn the_text_is_decoded_as_before() {
        async fn once(head: &str, body: &[u8]) -> (String, String) {
            let mut seen = Vec::new();
            for _ in 0..2 {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let url = format!("http://127.0.0.1:{}/t", listener.local_addr().unwrap().port());
                let mut answer = format!("{head}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
                answer.extend_from_slice(body);
                tokio::spawn(async move {
                    let (mut sock, _) = listener.accept().await.unwrap();
                    let mut buf = vec![0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let _ = sock.write_all(&answer).await;
                });
                seen.push(url);
            }
            let before = reqwest::get(&seen[0]).await.unwrap().text().await.unwrap();
            let resp = reqwest::get(&seen[1]).await.unwrap();
            let now = read_text_capped(resp, SMALL_LIMIT, &seen[1]).await.unwrap();
            (before, now)
        }
        // UTF-8 JSON, the usual answer of both catalogues.
        let (before, now) = once("HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n", "{\"name\":\"Gr\u{fc}\u{df}e \u{1f600}\"}".as_bytes()).await;
        assert_eq!(now, before);
        assert!(now.contains('\u{fc}'));
        // Latin-1 named in the header.
        let (before, now) = once("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=iso-8859-1\r\n", &[b'G', b'r', 0xFC, 0xDF, b'e']).await;
        assert_eq!(now, before);
        assert_eq!(now, "Gr\u{fc}\u{df}e");
        // No Content-Type and bytes that are not UTF-8.
        let (before, now) = once("HTTP/1.1 200 OK\r\n", &[b'o', b'k', 0xFF, 0xFE, b'!']).await;
        assert_eq!(now, before);
        assert!(now.contains('\u{fffd}'));
    }

    #[test]
    fn the_limit_holds_every_answer_a_caller_expects_today() {
        // Measured on 10.10.2026 (bytes): the largest answer per caller.
        const HF_SEARCH: usize = 14_600;
        const HF_TREE: usize = 126_815;
        const HF_TREE_FULL_PAGE: usize = 450_000;
        const CIVITAI_SEARCH: usize = 2_070_325;
        // The phone asks Hugging Face only.
        for size in [HF_SEARCH, HF_TREE, HF_TREE_FULL_PAGE] {
            assert!(size * 8 <= fetch_external_limit(true), "{size}");
        }
        for size in [HF_SEARCH, HF_TREE, HF_TREE_FULL_PAGE, CIVITAI_SEARCH] {
            assert!(size * 8 <= fetch_external_limit(false), "{size}");
        }
        assert_eq!(FETCH_EXTERNAL_MAX_BYTES, fetch_external_limit(cfg!(mobile)));
        // No key and no query in the sentence: the address is cut like in every other error.
        let msg = fetch_external_too_large(fetch_external_limit(false), "https://civitai.com/api/v1/models?token=secret");
        assert_eq!(msg, "The answer from https://civitai.com/api/v1/models is larger than 16 MB, so it was not read.");
    }
}
