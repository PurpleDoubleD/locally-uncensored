/**
 * Backend abstraction layer for LU.
 *
 * - DEV MODE (npm run dev): Routes to Vite middleware via fetch("/local-api/...")
 * - PRODUCTION (Tauri .exe): Routes to Rust backend via invoke()
 *
 * IMPORTANT: In Tauri, direct fetch() to localhost is blocked by CORS.
 * All Ollama/ComfyUI calls must go through invoke('proxy_localhost').
 */

import { log } from "../lib/logger";
import { shouldLogRepeat } from "../lib/probe-backoff";

// Hosts whose proxy failure has already been logged, host -> timestamp. Keeps
// a dead local backend from filling the console with the same line forever.
const proxyWarnSeen = new Map<string, number>();

/** Test-only: forget which hosts have already had their warning. */
export function __resetProxyWarnLogForTests(): void {
  proxyWarnSeen.clear();
}

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

/** True when running inside a Tauri WebView (.exe), false in browser dev mode */
export function isTauri(): boolean {
  // Tauri v2 renamed the global from `__TAURI__` to `__TAURI_INTERNALS__`.
  // Check both so the app keeps working across both versions (and also
  // during the migration window when people might be on either).
  if (typeof window === "undefined") return false;
  const w = window as any;
  return !!(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

/** True when the host OS is macOS. The frontend `dist` is shared across the
 *  mac and Windows Tauri builds, so platform-specific behaviour must be a
 *  RUNTIME check. WKWebView reports "MacIntel" / "Mac OS X" (even on Apple
 *  Silicon); WebView2 reports "Win32" / "Windows NT". */
export function isMacOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const plat = navigator.platform || "";
  const ua = navigator.userAgent || "";
  return /Mac|iPhone|iPad|iPod/.test(plat) || /Mac OS X|Macintosh/.test(ua);
}

/** True on Linux (WebKitGTK reports "Linux ..." / "X11; Linux"). Same
 *  runtime-check rule as isMacOS — one dist serves all three OS builds. */
export function isLinux(): boolean {
  if (typeof navigator === "undefined") return false;
  const plat = navigator.platform || "";
  const ua = navigator.userAgent || "";
  return (/Linux/.test(plat) || /Linux/.test(ua)) && !/Android/.test(ua);
}

/**
 * Launch policy: the macOS desktop app is now a full local+cloud app like
 * Windows/Linux (David 2026-07-22 — local mode built + tested). The former
 * Cloud-ONLY mac wall is lifted; the Local/Cloud switch, local-hardware
 * surfaces and local onboarding are available again. Kept as a function
 * returning false so the (dead) call sites collapse to the normal switchable
 * behaviour; call sites are being removed in a follow-up cleanup.
 */
export function isCloudOnly(): boolean {
  return false;
}

async function getInvoke() {
  if (!_invoke) {
    const { invoke } = await import("@tauri-apps/api/core");
    _invoke = invoke;
  }
  return _invoke;
}

/**
 * The Rust proxy commands reject with the STRING `"HTTP <status>: <body>"`
 * when the local backend answered non-2xx (vs. a transport error like
 * "connection refused" when it could not be reached at all). Parse that shape
 * so the JS side can rebuild a faithful Response — callers check
 * `res.status === 400` for the Ollama think-field downgrade and similar, and
 * those checks must behave identically whether the bytes traveled through the
 * proxy (Windows/WebView2) or a direct fetch (Linux/macOS/dev).
 */
export function parseProxyHttpError(msg: string): { status: number; body: string } | null {
  const m = /(?:^|:\s*)HTTP (\d{3}):\s?([\s\S]*)$/.exec(msg)
  if (!m) return null
  const status = Number(m[1])
  if (status < 100 || status > 599) return null
  return { status, body: m[2] ?? '' }
}

/**
 * Fetch a localhost URL, bypassing CORS in Tauri mode.
 * In dev mode: uses normal fetch().
 * In Tauri .exe: routes through Rust proxy_localhost command.
 *
 * `timeoutMs` is forwarded to the Rust proxy as `timeout_ms` so probes that
 * hit "TCP connect succeeds but server never sends HTTP response" don't
 * freeze the caller for the 5-minute default. Probe sites pass ~2000;
 * long-running endpoints (Ollama pull, ComfyUI generate) omit it for
 * the 300 s default. The dev-mode direct fetch path mirrors the same
 * timeout via AbortController.
 */
export async function localFetch(
  url: string,
  options?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
  }
): Promise<Response> {
  if (!isTauri()) {
    // Mirror the Rust-side timeout in dev mode by chaining an
    // AbortController onto whatever signal the caller provided.
    let signal = options?.signal;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    if (typeof options?.timeoutMs === "number" && options.timeoutMs > 0) {
      const controller = new AbortController();
      abortTimer = setTimeout(() => controller.abort(), options.timeoutMs);
      // Plumb the user's signal too so they can still cancel manually.
      if (options.signal) {
        const userSig = options.signal;
        if (userSig.aborted) controller.abort();
        else userSig.addEventListener("abort", () => controller.abort(), { once: true });
      }
      signal = controller.signal;
    }
    try {
      return await fetch(url, {
        method: options?.method || "GET",
        headers: options?.headers,
        body: options?.body,
        signal,
      });
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
    }
  }

  // In Tauri: route through Rust to bypass CORS, with direct fetch fallback
  const invoke = await getInvoke();
  const method = options?.method || "GET";

  try {
    const text = await invoke("proxy_localhost", {
      url,
      method,
      body: options?.body || null,
      // Snake-case to match the Rust parameter name. Tauri's invoke layer
      // does NOT auto-convert camelCase here — the Rust command spec uses
      // explicit field names.
      timeout_ms: options?.timeoutMs ?? null,
      // Forward caller headers (Authorization for keyed OpenAI-compat
      // backends). The proxy silently dropped them before, so a LAN vLLM/
      // TabbyAPI with an api key always got 401 through this path.
      headers: options?.headers ?? null,
    }) as string;

    return new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (proxyErr) {
    const proxyErrMsg = String(proxyErr)

    // The Rust proxy DID reach the backend and the backend answered non-2xx
    // (Err("HTTP <status>: <body>")). That is a real HTTP response, not a
    // transport failure — surface it faithfully so callers' status checks
    // (think-field 400 downgrade, buildError) behave exactly like a direct
    // fetch does on Linux/macOS. Retrying via direct fetch would be pointless
    // and on WebView2 149 just adds a second guaranteed failure (rikki
    // Discord 2026-06-10: Win11 "agent error" while Kubuntu was fine).
    const httpErr = parseProxyHttpError(proxyErrMsg)
    if (httpErr) {
      return new Response(httpErr.body, { status: httpErr.status })
    }

    // One line per host per minute, not one per attempt. A backend that is
    // not installed used to write two console lines every 1.5 seconds, over
    // forty inside a single chat round, and the real errors drowned in it
    // (counter-check round 2, 2026-08-29). The poller behind it now backs off
    // as well; this is the belt for anything else that keeps trying.
    if (shouldLogRepeat(proxyWarnSeen, hostnameOf(url), Date.now())) {
      log.warn('[localFetch] Proxy failed, trying direct fetch (repeats within the next minute are not logged)', { err: proxyErrMsg })
    }

    // Fallback: try direct fetch (works when ComfyUI has --enable-cors-header *)
    // Apply the same timeout to the fallback so a hanging probe doesn't sit
    // for minutes on this path either.
    let signal = options?.signal;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    if (typeof options?.timeoutMs === "number" && options.timeoutMs > 0) {
      const controller = new AbortController();
      abortTimer = setTimeout(() => controller.abort(), options.timeoutMs);
      if (options.signal) {
        const userSig = options.signal;
        if (userSig.aborted) controller.abort();
        else userSig.addEventListener("abort", () => controller.abort(), { once: true });
      }
      signal = controller.signal;
    }
    try {
      return await fetch(url, {
        method,
        headers: {
          ...(options?.body ? { "Content-Type": "application/json" } : {}),
          ...(options?.headers ?? {}),
        },
        body: options?.body,
        signal,
      });
    } catch (fetchErr) {
      // Both failed — return the proxy error with details preserved
      const detail = proxyErrMsg || String(fetchErr)
      return new Response(JSON.stringify({ error: detail }), { status: 500 });
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
    }
  }
}

/**
 * Streaming fetch for localhost — real token-by-token streaming via direct
 * fetch when CORS permits (Ollama on 11434 has CORS open), Rust proxy as
 * fallback (collects all bytes first — no real streaming but keeps things
 * working if direct fetch is blocked).
 *
 * Used for Ollama streaming endpoints (pull, chat).
 */
export async function localFetchStream(
  url: string,
  options?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal }
): Promise<Response> {
  const method = options?.method || "GET";
  const body = options?.body;
  const extraHeaders = options?.headers;
  const headers = body || extraHeaders
    ? { ...(body ? { "Content-Type": "application/json" } : {}), ...(extraHeaders ?? {}) }
    : undefined;

  // Transport order (rikki Discord 2026-06-10, Win11 "agent error"):
  // on WebView2 the direct fetch to a loopback backend is dead on arrival —
  // Ollama's CORS rejects the tauri.localhost origin and WebView2 149 made
  // the failure mode flaky instead of clean. Burning that attempt first cost
  // latency and, worse, a direct fetch that dies MID-stream cannot fall back
  // (the body is already partially consumed). So in Tauri, loopback targets
  // go proxy-FIRST; the direct fetch remains as fallback. Dev mode and
  // non-loopback (LAN) targets keep the old order.
  const proxyFirst = isTauri() && isLoopbackHost(hostnameOf(url));

  const tryDirect = async (): Promise<Response | null> => {
    try {
      const res = await fetch(url, { method, headers, body, signal: options?.signal });
      // Guard: some Tauri WebView setups still reject — if the Response is
      // malformed (no body at all), fall through to the proxy.
      if (res.body || res.ok || res.status >= 400) return res;
      return null;
    } catch (directErr) {
      if (options?.signal?.aborted) throw directErr;
      log.warn('[localFetchStream] Direct fetch failed', { err: String(directErr) });
      return null;
    }
  };

  if (!proxyFirst) {
    const direct = await tryDirect();
    if (direct) return direct;
    if (!isTauri()) {
      // No proxy to fall back to in plain browser dev mode.
      return new Response(JSON.stringify({ error: 'Network error' }), { status: 500 });
    }
  }

  const proxied = await proxyStreamChunked(url, method, body, extraHeaders, options?.signal);
  if (proxied) return proxied;

  // Proxy layer itself unavailable (invoke/Channel import died) — give the
  // direct fetch one shot if we skipped it above.
  if (proxyFirst) {
    const direct = await tryDirect();
    if (direct) return direct;
  }
  return new Response(JSON.stringify({ error: 'Local backend unreachable (proxy and direct fetch both failed)' }), { status: 503 });
}

/**
 * STREAMING proxy (David 2026-06-02): a Tauri Channel forwards each chunk from
 * Rust as it arrives, fed into a ReadableStream → real token-by-token streaming
 * (the old buffered path produced NOTHING until the body was complete — the
 * multi-minute "model loading" hang, dhasim Discord report).
 *
 * Status fidelity (rikki Discord 2026-06-10): the Rust command rejects with the
 * string "HTTP <status>: <body>" when the backend answered non-2xx — BEFORE any
 * chunk is sent. The old code turned that into a stream error with no
 * statusCode, so callers' `res.status === 400` handling (Ollama think-field
 * downgrade, "does not support tools") never ran on the proxy path — Windows
 * behaved differently from Linux for the SAME backend answer. Now the Response
 * is deferred until the first signal:
 *   - invoke rejects "HTTP <s>: <body>"  → faithful Response(<s>, body)
 *   - invoke rejects otherwise           → Response 503 (transport: retryable)
 *   - first chunk / EOF / invoke resolve → streaming Response 200
 *
 * Returns null when the invoke/Channel layer itself is unavailable so the
 * caller can decide on a last-resort transport.
 */
async function proxyStreamChunked(url: string, method: string, body?: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<Response | null> {
  let invoke: Awaited<ReturnType<typeof getInvoke>>;
  let ChannelCtor: typeof import("@tauri-apps/api/core").Channel;
  try {
    invoke = await getInvoke();
    ChannelCtor = (await import("@tauri-apps/api/core")).Channel;
  } catch (err) {
    log.warn('[localFetchStream] invoke/Channel unavailable', { err: String(err) });
    return null;
  }

  // Deterministic backend cancellation: tag this stream with an id and, when the
  // caller aborts (Stop button / chat delete/close), tell Rust to cancel the
  // upstream request so Ollama actually stops generating — not just the JS loop
  // (David 2026-06-15: "Aktivität komplett stoppen"). Without this, the proxy
  // kept pulling from Ollama to completion after an abort, burning GPU.
  const streamId =
    (globalThis.crypto as Crypto | undefined)?.randomUUID?.() ??
    `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  // Already aborted before we start: cancelling a stream id that has never
  // been opened cancels nothing, and the old code then opened it anyway. On the
  // Tauri loopback path that is a real upstream request fired after the user
  // pressed Stop (review 2026-08-14). Refuse first, cancel nothing.
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const cancelUpstream = () => { void invoke("cancel_proxy_stream", { streamId }).catch(() => { /* best-effort */ }); };
  let onAbort: (() => void) | null = null;
  if (signal) {
    onAbort = () => cancelUpstream();
    signal.addEventListener("abort", onAbort, { once: true });
  }
  const detachAbort = () => { if (signal && onAbort) { signal.removeEventListener("abort", onAbort); onAbort = null; } };

  try {
    const channel = new ChannelCtor<number[]>();
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { ctrl = c; },
    });
    const closeStream = () => {
      if (closed) return;
      closed = true;
      detachAbort();
      try { ctrl?.close(); } catch { /* already closed */ }
    };

    let responseSettled = false;
    let settle!: (res: Response) => void;
    const settled = new Promise<Response>((resolve) => {
      settle = (res) => { if (!responseSettled) { responseSettled = true; resolve(res) } };
    });
    const settleStreaming = () => {
      if (responseSettled) return;
      settle(new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } }));
    };

    channel.onmessage = (chunk: number[]) => {
      if (closed) return;
      // Empty chunk = Rust's explicit EOF marker (data chunks are never
      // empty). Closing HERE instead of on the invoke result is the fix for
      // the silent no-reply chats (live find 2026-06-11): WebView2 149
      // delivers queued channel messages AFTER the invoke promise resolves,
      // so closing on the result raced ahead of the data and dropped every
      // chunk — the user message appeared, the reply never did.
      if (!chunk || chunk.length === 0) {
        settleStreaming();
        closeStream();
        return;
      }
      try { ctrl?.enqueue(new Uint8Array(chunk)); } catch { /* reader gone */ }
      settleStreaming();
    };

    void invoke("proxy_localhost_stream_chunked", { url, method, body: body || null, headers: headers ?? null, onChunk: channel, streamId })
      .then(() => {
        // Do NOT close here — the EOF marker does that (it may arrive after
        // this resolves; see above). Grace fallback so a lost EOF can't leak
        // the stream forever: anything still open 15s after the command
        // returned closes with whatever was delivered by then.
        settleStreaming();
        setTimeout(closeStream, 15_000);
      })
      .catch((err: unknown) => {
        const msg = String(err);
        const httpErr = parseProxyHttpError(msg);
        // Backend answered non-2xx (rejected before any chunk): faithful status.
        // Transport failure (connection refused / validation): 503 so callers
        // treat it as retryable instead of a deterministic 4xx.
        settle(httpErr
          ? new Response(httpErr.body, { status: httpErr.status })
          : new Response(JSON.stringify({ error: msg }), { status: 503 }));
        closed = true;
        detachAbort();
        // If a reader is already consuming (mid-stream death), surface there too.
        try { ctrl?.error(err instanceof Error ? err : new Error(msg)); } catch { /* no reader */ }
      });

    return await settled;
  } catch (chanErr) {
    // Channel unavailable → legacy buffered proxy (still works, just not streamed).
    detachAbort();
    log.warn('[localFetchStream] Channel stream unavailable, buffering via proxy', { err: String(chanErr) });
    try {
      const bytes = await invoke("proxy_localhost_stream", {
        url,
        method,
        body: body || null,
        headers: headers ?? null,
      }) as number[];
      const uint8 = new Uint8Array(bytes);
      return new Response(uint8, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    } catch (err) {
      const msg = String(err);
      const httpErr = parseProxyHttpError(msg);
      return httpErr
        ? new Response(httpErr.body, { status: httpErr.status })
        : new Response(JSON.stringify({ error: msg }), { status: 503 });
    }
  }
}

/**
 * Call a backend command. Routes to Tauri invoke() or Vite fetch() automatically.
 */
export async function backendCall<T = any>(
  command: string,
  args?: Record<string, unknown>,
  options?: { method?: string; body?: any; headers?: Record<string, string> }
): Promise<T> {
  if (isTauri()) {
    const invoke = await getInvoke();
    return invoke(command, args || {}) as Promise<T>;
  }

  // Dev mode: map command to /local-api/ endpoint
  const endpointMap: Record<string, { path: string; method?: string }> = {
    start_comfyui: { path: "/local-api/start-comfyui", method: "POST" },
    stop_comfyui: { path: "/local-api/stop-comfyui", method: "POST" },
    comfyui_status: { path: "/local-api/comfyui-status" },
    comfyui_last_output: { path: "/local-api/comfyui-last-output" },
    find_comfyui: { path: "/local-api/find-comfyui" },
    set_comfyui_path: { path: "/local-api/set-comfyui-path", method: "POST" },
    install_comfyui: { path: "/local-api/install-comfyui", method: "POST" },
    install_comfyui_status: { path: "/local-api/install-comfyui" },
    install_ollama: { path: "/local-api/install-ollama", method: "POST" },
    install_ollama_status: { path: "/local-api/install-ollama-status" },
    set_comfyui_port: { path: "/local-api/set-comfyui-port", method: "POST" },
    set_comfyui_host: { path: "/local-api/set-comfyui-host", method: "POST" },
    set_ollama_host: { path: "/local-api/set-ollama-host", method: "POST" },
    get_ollama_host: { path: "/local-api/get-ollama-host" },
    install_custom_node: { path: "/local-api/install-custom-node", method: "POST" },
    whisper_status: { path: "/local-api/transcribe-status" },
    install_whisper: { path: "/local-api/install-whisper", method: "POST" },
    install_whisper_status: { path: "/local-api/install-whisper" },
    // Bug B10: TTS install has no real dev-server backend (Piper pip + voice
    // download run only in the packaged app). Mapped so the browser surface gets
    // an honest "desktop-only" status instead of "Unknown backend command".
    install_tts: { path: "/local-api/install-tts", method: "POST" },
    install_tts_status: { path: "/local-api/install-tts" },
    transcribe: { path: "/local-api/transcribe", method: "POST" },
    execute_code: { path: "/local-api/execute-code", method: "POST" },
    file_read: { path: "/local-api/file-read", method: "POST" },
    file_write: { path: "/local-api/file-write", method: "POST" },
    download_model: { path: "/local-api/download-model", method: "POST" },
    download_model_to_path: { path: "/local-api/download-model-to-path", method: "POST" },
    detect_model_path: { path: "/local-api/detect-model-path", method: "POST" },
    check_model_sizes: { path: "/local-api/check-model-sizes", method: "POST" },
    delete_comfy_model: { path: "/local-api/delete-comfy-model", method: "POST" },
    download_progress: { path: "/local-api/download-progress" },
    pause_download: { path: "/local-api/pause-download", method: "POST" },
    cancel_download: { path: "/local-api/cancel-download", method: "POST" },
    resume_download: { path: "/local-api/resume-download", method: "POST" },
    web_search: { path: "/local-api/web-search", method: "POST" },
    search_status: { path: "/local-api/search-status" },
    install_searxng: { path: "/local-api/install-searxng", method: "POST" },
    searxng_status: { path: "/local-api/install-searxng" },
    ollama_search: { path: "/ollama-search" },
    fetch_external: { path: "/local-api/proxy-download" },
    fetch_external_bytes: { path: "/local-api/proxy-download" },
    // Remote Access
    start_remote_server: { path: "/local-api/start-remote-server", method: "POST" },
    stop_remote_server: { path: "/local-api/stop-remote-server", method: "POST" },
    remote_server_status: { path: "/local-api/remote-server-status" },
    regenerate_remote_token: { path: "/local-api/regenerate-remote-token", method: "POST" },
    remote_qr_code: { path: "/local-api/remote-qr-code" },
    remote_connected_devices: { path: "/local-api/remote-connected-devices" },
    set_remote_permissions: { path: "/local-api/set-remote-permissions", method: "POST" },
    start_tunnel: { path: "/local-api/start-tunnel", method: "POST" },
    stop_tunnel: { path: "/local-api/stop-tunnel", method: "POST" },
    tunnel_status: { path: "/local-api/tunnel-status" },
    // Agent tools (Phase 1 — new commands)
    shell_execute: { path: "/local-api/shell-execute", method: "POST" },
    fs_read: { path: "/local-api/fs-read", method: "POST" },
    // Capped, jailed byte read for the Explorer image preview (2.6.6 C3).
    // Without this entry the browser dev surface answered "Unknown backend
    // command" and every preview fell over.
    fs_read_bytes: { path: "/local-api/fs-read-bytes", method: "POST" },
    fs_write: { path: "/local-api/fs-write", method: "POST" },
    fs_list: { path: "/local-api/fs-list", method: "POST" },
    fs_search: { path: "/local-api/fs-search", method: "POST" },
    fs_info: { path: "/local-api/fs-info", method: "POST" },
    system_info: { path: "/local-api/system-info" },
    process_list: { path: "/local-api/process-list" },
    screenshot: { path: "/local-api/screenshot" },
  };

  const endpoint = endpointMap[command];
  if (!endpoint) {
    throw new Error(`Unknown backend command: ${command}`);
  }

  const method = options?.method || endpoint.method || "GET";
  const fetchOptions: RequestInit = { method };
  const headers: Record<string, string> = { "x-locally-uncensored": "true" };

  if (options?.body) {
    fetchOptions.body = options.body;
    if (options.headers) {
      Object.assign(headers, options.headers);
    }
  } else if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(args || {});
  }
  fetchOptions.headers = headers;

  // For GET with args, append as query params
  let url = endpoint.path;
  if (args && method === "GET") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) {
      params.set(key, String(value));
    }
    url += `?${params.toString()}`;
  }

  const res = await fetch(url, fetchOptions);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Configurable Ollama base URL. Default `http://localhost:11434`.
 * Can be set to any URL so users can point LU at a remote Ollama
 * (e.g. LAN machine, Docker container, cluster node). Supports the
 * OLLAMA_HOST env var on Tauri startup via the Rust side, and GUI-
 * configured endpoint via `set_ollama_host` — whichever comes last
 * wins, matching how other providers behave.
 *
 * Stored without trailing slash so `${_ollamaBase}/api${path}` never
 * produces a double slash.
 */
let _ollamaBase = 'http://localhost:11434';

/** Accepts bare host:port, scheme-less host, or full URL — returns full URL. */
export function normalizeOllamaBase(input: string): string {
  const raw = (input || '').trim()
  if (!raw) return 'http://localhost:11434'
  // Already has scheme?
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '')
  // Bare "host:port" or "host" — add http://
  return `http://${raw.replace(/\/+$/, '')}`
}

export function setOllamaBase(input: string) {
  _ollamaBase = normalizeOllamaBase(input)
}
export function getOllamaBase(): string { return _ollamaBase }

export function isOllamaLocal(): boolean {
  try {
    const h = new URL(_ollamaBase).hostname.toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0'
  } catch {
    return true
  }
}

/** Get the base URL for Ollama API calls.
 *  - Tauri: `${_ollamaBase}/api${path}` — honors GUI + env var.
 *  - Dev: `/api${path}` — Vite proxy target is set from OLLAMA_HOST env var
 *    at dev-server startup time.
 */
export function ollamaUrl(path: string): string {
  if (isTauri()) {
    return `${_ollamaBase}/api${path}`;
  }
  return `/api${path}`;
}

/** Configurable ComfyUI port — default 8188, can be changed at runtime */
let _comfyPort = 8188;
export function setComfyPort(port: number) { _comfyPort = port; }
export function getComfyPort(): number { return _comfyPort; }

/**
 * Configurable ComfyUI host — default "localhost".
 * Can be set to any hostname/IP so users can point LU at a remote ComfyUI
 * (e.g. headless server, Docker container on another box, LAN machine).
 * When the host is non-local, Settings hides Start/Stop/Restart controls
 * because LU can't manage the lifecycle of a remote Python process.
 */
let _comfyHost = 'localhost';
export function setComfyHost(host: string) {
  // Never allow empty — that would produce "http://:8188" which breaks fetch.
  _comfyHost = (host && host.trim()) ? host.trim() : 'localhost';
}
export function getComfyHost(): string { return _comfyHost; }
export function isComfyLocal(): boolean {
  const h = _comfyHost.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}

/** Get the base URL for ComfyUI API calls */
export function comfyuiUrl(path: string): string {
  if (isTauri()) {
    return `http://${_comfyHost}:${_comfyPort}${path}`;
  }
  return `/comfyui${path}`;
}

/**
 * Web-build fallback for a relative ComfyUI media URL (konata 2026-06-08 chat,
 * 2026-06-25 Create page). In the browser build, media URLs are the RELATIVE
 * Vite-proxy path (`/comfyui/view?…`). That loads fine under `npm run dev`, but
 * a static host — or a reverse-proxy / SSH tunnel in front of a remote ComfyUI —
 * can mishandle the `<video>` byte-range subrequest and never paint it, while a
 * plain `<img>` GET and a direct top-level navigation to the same URL still work
 * (exactly konata's "video not in gallery, direct link works" report). When the
 * relative load fires onError, retry with an ABSOLUTE URL straight to the
 * ComfyUI host — `<img>`/`<video>` display is not CORS-gated, so it needs no
 * proxy. Tauri URLs are already absolute (never start with '/') and pass through
 * untouched. The chat path (ToolCallBlock) has shipped this since 2026-06-08;
 * this is the same logic, shared so the Create-page renderers match it. */
export function comfyAbsoluteFallback(url: string): string {
  if (!url.startsWith('/')) return url;
  const path = url.startsWith('/comfyui/') ? url.slice('/comfyui'.length) : url;
  return `http://${_comfyHost}:${_comfyPort}${path}`;
}

/** Get the WebSocket URL for ComfyUI */
export function comfyuiWsUrl(): string {
  return `ws://${_comfyHost}:${_comfyPort}/ws`;
}

/** Download a ComfyUI output file — works in both dev and Tauri mode */
export async function downloadComfyFile(filename: string, subfolder: string = '', type: string = 'output'): Promise<void> {
  const params = new URLSearchParams({ filename, subfolder, type })
  const url = comfyuiUrl(`/view?${params.toString()}`)

  if (!isTauri()) {
    // Dev mode: direct anchor download
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    return
  }

  // Tauri mode: fetch the bytes through the proxy, then a NATIVE Save-As dialog.
  // The old blob-URL + anchor-click pattern is UNRELIABLE in WebView2 — the
  // webview navigates to the blob URL instead of saving it, so clicking Download
  // did nothing (David 2026-06-12: "der download button geht nicht für video und
  // image mcp"). save_binary_file_dialog writes the real bytes to the chosen path
  // (same native dialog the chat file-artifact card uses, which works).
  const invoke = await getInvoke()
  try {
    const bytes = await invoke('proxy_localhost_stream', {
      url,
      method: 'GET',
      body: null,
    }) as number[]
    const ext = filename.includes('.') ? filename.split('.').pop()! : 'bin'
    // Returns the chosen path, or null if the user cancelled — nothing to do then.
    await invoke('save_binary_file_dialog', {
      bytes,
      defaultName: filename,
      extension: ext,
      extLabel: ext.toUpperCase(),
    })
  } catch (err) {
    log.error('[downloadComfyFile] Failed', { err })
    // Last-resort fallback: blob-anchor (unreliable in WebView2, but better than
    // a silent no-op if the native dialog command is somehow unavailable).
    try {
      const bytes = await invoke('proxy_localhost_stream', { url, method: 'GET', body: null }) as number[]
      const blobUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)]))
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(blobUrl)
    } catch { /* give up */ }
  }
}

// ── Provider key keychain (H5) ──────────────────────────────────
// Thin wrappers over the Rust secret_* commands (Windows Credential Manager /
// macOS Keychain). They reject on the web build (no Tauri) and on Linux desktop
// (the command reports unsupported), which is how providerStore detects "no
// keychain here" and falls back to the obfuscated-localStorage path.
export async function secretSet(account: string, value: string): Promise<void> {
  if (!isTauri()) throw new Error('keychain unavailable (web build)')
  const invoke = await getInvoke()
  await invoke('secret_set', { account, value })
}

export async function secretGet(account: string): Promise<string | null> {
  if (!isTauri()) throw new Error('keychain unavailable (web build)')
  const invoke = await getInvoke()
  return (await invoke('secret_get', { account })) as string | null
}

export async function secretDelete(account: string): Promise<void> {
  if (!isTauri()) throw new Error('keychain unavailable (web build)')
  const invoke = await getInvoke()
  await invoke('secret_delete', { account })
}

// OAuth loopback (LU Cloud Google/GitHub login): bind a 127.0.0.1 port from
// the fixed ladder, then await the browser round-trip. Rust side single-shots
// the accept; the returned string is the raw callback query (code=… / error=…).
export async function oauthStart(): Promise<number> {
  if (!isTauri()) throw new Error('OAuth loopback unavailable (web build)')
  const invoke = await getInvoke()
  return (await invoke('oauth_start')) as number
}

export async function oauthWait(port: number, timeoutSecs: number): Promise<string> {
  if (!isTauri()) throw new Error('OAuth loopback unavailable (web build)')
  const invoke = await getInvoke()
  return (await invoke('oauth_wait', { port, timeoutSecs })) as string
}

/** Fetch an external URL as text — works in both Tauri and dev mode */
export async function fetchExternal(url: string): Promise<string> {
  if (isTauri()) {
    const invoke = await getInvoke();
    return invoke('fetch_external', { url }) as Promise<string>;
  }
  const res = await fetch(`/local-api/proxy-download?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Fetch an external URL as bytes — works in both Tauri and dev mode */
export async function fetchExternalBytes(url: string): Promise<ArrayBuffer> {
  if (isTauri()) {
    const invoke = await getInvoke();
    const bytes = await invoke('fetch_external_bytes', { url }) as number[];
    return new Uint8Array(bytes).buffer;
  }
  const res = await fetch(`/local-api/proxy-download?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Fetch a localhost URL as raw bytes (Tauri-aware). Used to pull a generated
 * ComfyUI image back so a vision-capable chat model can actually SEE it. In
 * Tauri the browser can't fetch localhost directly (CORS) so we route through
 * the Rust byte proxy; in dev a plain fetch works.
 */
export async function fetchLocalhostBytes(url: string): Promise<Uint8Array> {
  if (isTauri()) {
    const invoke = await getInvoke()
    const bytes = (await invoke('proxy_localhost_stream', { url, method: 'GET', body: null })) as number[]
    return new Uint8Array(bytes)
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * True only for URLs that are safe to hand to the OS shell / a new window:
 * http, https, or mailto. Rejects file://, custom protocol handlers, UNC
 * paths, javascript:/data: URIs, and relative paths (no base = throws). This
 * is the guard for the main "untrusted text (model/web link) → native action"
 * bridge: a markdown link like `[results](file:///C:/Windows/System32/calc.exe)`
 * must never reach `plugin:shell|open`.
 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const proto = new URL(url).protocol
    return proto === 'http:' || proto === 'https:' || proto === 'mailto:'
  } catch {
    return false
  }
}

/** Open a URL in the system's default browser (works in both dev and Tauri) */
export async function openExternal(url: string): Promise<void> {
  if (!isSafeExternalUrl(url)) {
    console.warn('[openExternal] blocked non-web URL:', url)
    return
  }
  if (isTauri()) {
    // Use Tauri's invoke to open URL in system browser via shell plugin
    const invoke = await getInvoke()
    try {
      await invoke('plugin:shell|open', { path: url })
    } catch {
      // Fallback if plugin command format differs
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

/** Git availability for the Codex coding view (v2.5.0). */
export interface GitStatus {
  installed: boolean
  native: boolean
  version?: string | null
  hint?: string | null
  download_url: string
}

/**
 * Check whether `git` is available so the Codex view can show an install
 * banner when it's missing. In a plain browser (dev without Tauri) we assume
 * git is present so the banner never shows during web-only development.
 */
export async function checkGitInstalled(): Promise<GitStatus> {
  if (!isTauri()) {
    return { installed: true, native: true, download_url: 'https://git-scm.com/downloads' }
  }
  const invoke = await getInvoke()
  return (await invoke('check_git_installed')) as GitStatus
}

// ── LAN / private-host detection + proxy registration (Bug A / GH #49) ──────
//
// A LAN OpenAI-compat endpoint (LM Studio / vLLM bound to 0.0.0.0 and reached
// over the network as e.g. http://192.168.1.50:1234) cannot be fetched directly
// from the Tauri webview: the CSP `connect-src` only whitelists localhost +
// 127.0.0.1, and the backend doesn't send CORS headers for the tauri.localhost
// origin. So those requests must go through the Rust proxy, exactly like
// Ollama/ComfyUI. These helpers classify a host (proxy vs direct fetch) and
// register the host with the proxy's allow-list (validate_proxy_url).

/** Strip IPv6 brackets and lowercase. */
function _canonHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
}

/** localhost / loopback — always proxy-allowed, no registration needed. */
export function isLoopbackHost(hostname: string): boolean {
  const h = _canonHost(hostname)
  return h === 'localhost' || h === '127.0.0.1' || h === '::1'
    || h === '0.0.0.0' || h.endsWith('.localhost')
}

/**
 * True for localhost AND private/LAN addresses: RFC1918 (10/8, 172.16/12,
 * 192.168/16), CGNAT/Tailscale (100.64/10), IPv6 ULA (fc00::/7) + link-local
 * (fe80::/10), the common LAN DNS suffixes, and bare machine names (no dots).
 *
 * Deliberately NOT treated as LAN: IPv4 link-local 169.254/16. It is never a
 * real LLM backend and 169.254.169.254 is the classic cloud-metadata SSRF
 * target — the Rust proxy hard-blocks it regardless.
 */
export function isPrivateOrLanHost(hostname: string): boolean {
  const h = _canonHost(hostname)
  if (!h) return false
  if (isLoopbackHost(h)) return true
  if (/\.(local|lan|internal|intra|home|home\.arpa)$/.test(h)) return true
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = +v4[1], b = +v4[2]
    if (a > 255 || b > 255 || +v4[3] > 255 || +v4[4] > 255) return false
    if (a === 169 && b === 254) return false        // link-local / metadata: not LAN
    if (a === 10) return true                        // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a === 192 && b === 168) return true          // 192.168.0.0/16
    if (a === 127) return true                       // loopback
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT (Tailscale)
    return false                                     // public IPv4
  }
  if (h.includes(':')) {                             // IPv6 literal
    if (/^f[cd]/.test(h)) return true                // fc00::/7 unique-local
    if (/^fe[89ab]/.test(h)) return true             // fe80::/10 link-local
    return false                                     // public IPv6
  }
  if (!h.includes('.')) return true                  // bare LAN machine name (nas, mypc)
  return false                                       // FQDN → public/cloud
}

/** Lowercase hostname from a URL, or '' if unparseable. */
export function hostnameOf(url: string): string {
  try { return _canonHost(new URL(url).hostname) } catch { return '' }
}

/**
 * Hosts the webview is allowed to fetch DIRECTLY. Mirrors `connect-src` in
 * src-tauri/tauri.conf.json — keep the two in sync. Everything else has to take
 * the Rust proxy, because the pinned CSP kills the request inside the webview
 * before it reaches the network. That is why a user's own cloud endpoint (a
 * custom OpenAI-compatible provider on their domain, or a vendor LU ships no
 * preset for) used to fail with an unexplainable network error.
 */
const CSP_DIRECT_HOSTS = new Set([
  'lu-labs.ai',
  'lrrhheztdytyfpizvuup.supabase.co',
  'openrouter.ai',
  'api.openai.com',
  'api.groq.com',
  'api.together.xyz',
  'api.deepseek.com',
  'api.mistral.ai',
  'api.anthropic.com',
  'ollama.com',
  'huggingface.co',
  'civitai.com',
])

export function isDirectFetchAllowed(hostname: string): boolean {
  const h = _canonHost(hostname)
  if (!h) return false
  return CSP_DIRECT_HOSTS.has(h)
    || h.endsWith('.huggingface.co')
    || h.endsWith('.civitai.com')
}

// Hosts already registered with the proxy this session (avoid duplicate IPC).
const _registeredProxyHosts = new Set<string>()

/**
 * Ensure the Rust proxy's allow-list contains this endpoint's host so
 * `proxy_localhost` will forward to a user-configured LAN backend. No-op for
 * loopback (already allowed), in browser dev mode (no Rust proxy), and for
 * hosts already registered this session. Best-effort: a failure (e.g. an older
 * build without the command) is swallowed — the direct-fetch fallback applies.
 */
export async function ensureProxyAllowsHost(baseUrl: string): Promise<void> {
  if (!isTauri()) return
  const host = hostnameOf(baseUrl)
  if (!host || isLoopbackHost(host)) return
  if (_registeredProxyHosts.has(host)) return
  try {
    const invoke = await getInvoke()
    await invoke('register_openai_host', { host })
    _registeredProxyHosts.add(host)
  } catch (err) {
    log.warn('[ensureProxyAllowsHost] proxy host registration failed', { host, err: String(err) })
  }
}
