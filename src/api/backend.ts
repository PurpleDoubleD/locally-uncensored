/**
 * Backend abstraction layer for Locally Uncensored.
 *
 * - DEV MODE (npm run dev): Routes to Vite middleware via fetch("/local-api/...")
 * - PRODUCTION (Tauri .exe): Routes to Rust backend via invoke()
 *
 * IMPORTANT: In Tauri, direct fetch() to localhost is blocked by CORS.
 * All Ollama/ComfyUI calls must go through invoke('proxy_localhost').
 */

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

/** True when running inside a Tauri WebView (.exe), false in browser dev mode */
export function isTauri(): boolean {
  // Tauri v2 renamed the global from `__TAURI__` to `__TAURI_INTERNALS__`.
  // Check both so the app keeps working across both versions (and also
  // during the migration window when people might be on either).
  const w = window as any;
  return !!(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

async function getInvoke() {
  if (!_invoke) {
    const { invoke } = await import("@tauri-apps/api/core");
    _invoke = invoke;
  }
  return _invoke;
}

/**
 * Fetch a localhost URL, bypassing CORS in Tauri mode.
 * In dev mode: uses normal fetch().
 * In Tauri .exe: routes through Rust proxy_localhost command.
 */
export async function localFetch(
  url: string,
  options?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal }
): Promise<Response> {
  if (!isTauri()) {
    return fetch(url, {
      method: options?.method || "GET",
      headers: options?.headers,
      body: options?.body,
      signal: options?.signal,
    });
  }

  // In Tauri: route through Rust to bypass CORS, with direct fetch fallback
  const invoke = await getInvoke();
  const method = options?.method || "GET";

  try {
    const text = await invoke("proxy_localhost", {
      url,
      method,
      body: options?.body || null,
    }) as string;

    return new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (proxyErr) {
    const proxyErrMsg = String(proxyErr)
    console.warn('[localFetch] Proxy failed, trying direct fetch:', proxyErrMsg)

    // Fallback: try direct fetch (works when ComfyUI has --enable-cors-header *)
    try {
      return await fetch(url, {
        method,
        headers: options?.body ? { "Content-Type": "application/json" } : undefined,
        body: options?.body,
        signal: options?.signal,
      });
    } catch (fetchErr) {
      // Both failed — return the proxy error with details preserved
      const detail = proxyErrMsg || String(fetchErr)
      return new Response(JSON.stringify({ error: detail }), { status: 500 });
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
  options?: { method?: string; body?: string; signal?: AbortSignal }
): Promise<Response> {
  const method = options?.method || "GET";
  const body = options?.body;
  const headers = body ? { "Content-Type": "application/json" } : undefined;

  // Direct fetch first — Ollama has CORS open on localhost, so this gives
  // us true chunked streaming. Works in both dev mode and Tauri .exe.
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: options?.signal,
    });
    // Guard: some Tauri WebView setups still reject — if the Response is
    // malformed (no body at all), fall through to the proxy.
    if (res.body || res.ok || res.status >= 400) {
      return res;
    }
  } catch (directErr) {
    if (options?.signal?.aborted) throw directErr;
    console.warn('[localFetchStream] Direct fetch failed, trying Rust proxy:', String(directErr));
  }

  // Fallback in Tauri: Rust proxy collects all bytes (loses streaming).
  if (!isTauri()) {
    // Re-throw the original direct-fetch error if we are not in Tauri,
    // since there is no proxy to fall back to.
    return new Response(JSON.stringify({ error: 'Network error' }), { status: 500 });
  }

  const invoke = await getInvoke();
  try {
    const bytes = await invoke("proxy_localhost_stream", {
      url,
      method,
      body: body || null,
    }) as number[];

    const uint8 = new Uint8Array(bytes);
    return new Response(uint8, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
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
    transcribe: { path: "/local-api/transcribe", method: "POST" },
    execute_code: { path: "/local-api/execute-code", method: "POST" },
    file_read: { path: "/local-api/file-read", method: "POST" },
    file_write: { path: "/local-api/file-write", method: "POST" },
    download_model: { path: "/local-api/download-model", method: "POST" },
    download_model_to_path: { path: "/local-api/download-model-to-path", method: "POST" },
    detect_model_path: { path: "/local-api/detect-model-path", method: "POST" },
    check_model_sizes: { path: "/local-api/check-model-sizes", method: "POST" },
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
    // Claude Code
    detect_claude_code: { path: "/local-api/detect-claude-code" },
    install_claude_code: { path: "/local-api/install-claude-code", method: "POST" },
    install_claude_code_status: { path: "/local-api/install-claude-code-status" },
    start_claude_code: { path: "/local-api/start-claude-code", method: "POST" },
    stop_claude_code: { path: "/local-api/stop-claude-code", method: "POST" },
    send_claude_code_input: { path: "/local-api/send-claude-code-input", method: "POST" },
    // Agent tools (Phase 1 — new commands)
    shell_execute: { path: "/local-api/shell-execute", method: "POST" },
    fs_read: { path: "/local-api/fs-read", method: "POST" },
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

  // Tauri mode: fetch bytes through proxy, create blob URL
  const invoke = await getInvoke()
  try {
    const bytes = await invoke('proxy_localhost_stream', {
      url,
      method: 'GET',
      body: null,
    }) as number[]
    const blob = new Blob([new Uint8Array(bytes)])
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(blobUrl)
  } catch (err) {
    console.error('[downloadComfyFile] Failed:', err)
    // Fallback: try direct link
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }
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

/** Open a URL in the system's default browser (works in both dev and Tauri) */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    // Use Tauri's invoke to open URL in system browser via shell plugin
    const invoke = await getInvoke()
    try {
      await invoke('plugin:shell|open', { path: url })
    } catch {
      // Fallback if plugin command format differs
      window.open(url, '_blank')
    }
  } else {
    window.open(url, '_blank')
  }
}
