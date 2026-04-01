/**
 * Backend abstraction layer for Locally Uncensored.
 *
 * - DEV MODE (npm run dev): Routes to Vite middleware via fetch("/local-api/...")
 * - PRODUCTION (Tauri .exe): Routes to Rust backend via invoke()
 *
 * Ollama/ComfyUI calls go directly to localhost in production (CSP allows it).
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
    whisper_status: { path: "/local-api/transcribe-status" },
    transcribe: { path: "/local-api/transcribe", method: "POST" },
    execute_code: { path: "/local-api/execute-code", method: "POST" },
    file_read: { path: "/local-api/file-read", method: "POST" },
    file_write: { path: "/local-api/file-write", method: "POST" },
    download_model: { path: "/local-api/download-model", method: "POST" },
    download_progress: { path: "/local-api/download-progress" },
    web_search: { path: "/local-api/web-search", method: "POST" },
    search_status: { path: "/local-api/search-status" },
    install_searxng: { path: "/local-api/install-searxng", method: "POST" },
    searxng_status: { path: "/local-api/install-searxng" },
    ollama_search: { path: "/ollama-search" },
  };

  const endpoint = endpointMap[command];
  if (!endpoint) {
    throw new Error(`Unknown backend command: ${command}`);
  }

  const method = options?.method || endpoint.method || "GET";
  const fetchOptions: RequestInit = { method };

  if (options?.body) {
    fetchOptions.body = options.body;
    if (options.headers) {
      fetchOptions.headers = options.headers;
    }
  } else if (args && method !== "GET") {
    fetchOptions.headers = { "Content-Type": "application/json" };
    fetchOptions.body = JSON.stringify(args);
  }

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
  return res.json();
}

/** Get the base URL for Ollama API calls */
export function ollamaUrl(path: string): string {
  if (isTauri()) {
    return `http://localhost:11434${path}`;
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
