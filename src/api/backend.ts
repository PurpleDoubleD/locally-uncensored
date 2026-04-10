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
  return !!(window as any).__TAURI__;
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
 * Streaming fetch for localhost — returns raw bytes in Tauri, normal Response in dev.
 * Used for Ollama streaming endpoints (pull, chat).
 */
export async function localFetchStream(
  url: string,
  options?: { method?: string; body?: string; signal?: AbortSignal }
): Promise<Response> {
  if (!isTauri()) {
    return fetch(url, {
      method: options?.method || "GET",
      body: options?.body,
      headers: options?.body ? { "Content-Type": "application/json" } : undefined,
      signal: options?.signal,
    });
  }

  // In Tauri: get all bytes at once through Rust proxy (no true streaming, but works)
  const invoke = await getInvoke();
  try {
    const bytes = await invoke("proxy_localhost_stream", {
      url,
      method: options?.method || "GET",
      body: options?.body || null,
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
  } else if (args && method !== "GET") {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(args);
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

/** Get the base URL for Ollama API calls */
export function ollamaUrl(path: string): string {
  if (isTauri()) {
    return `http://localhost:11434/api${path}`;
  }
  return `/api${path}`;
}

/** Get the base URL for ComfyUI API calls */
export function comfyuiUrl(path: string): string {
  if (isTauri()) {
    return `http://localhost:8188${path}`;
  }
  return `/comfyui${path}`;
}

/** Get the WebSocket URL for ComfyUI */
export function comfyuiWsUrl(): string {
  return "ws://localhost:8188/ws";
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
