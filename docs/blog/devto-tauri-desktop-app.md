---
title: "How I Built a Desktop AI App with Tauri v2 + React 19 in 2026"
published: false
description: "The technical story behind Locally Uncensored — a standalone desktop app for local AI chat, image, and video generation. CORS proxying in Rust, download managers with pause/resume, auto-discovery of ComfyUI, and everything I learned building a real Tauri v2 app."
tags: tauri, rust, react, ai
cover_image: https://raw.githubusercontent.com/PurpleDoubleD/locally-uncensored/master/docs/screenshots/chat_personas_dark.jpg
canonical_url: https://github.com/PurpleDoubleD/locally-uncensored
---

I wanted to build one app that does AI chat, image generation, and video generation — all running locally, no cloud, no Docker, no terminal. Just a .exe you download and run.

The result is **Locally Uncensored** — a React 19 + TypeScript frontend with a Tauri v2 Rust backend that connects to Ollama for chat and ComfyUI for image/video generation. It ships as a standalone desktop app on Windows (.exe/.msi), Linux (.AppImage/.deb), and macOS (.dmg).

This post covers the real technical challenges I hit and how I solved them. If you're building a Tauri app that talks to local services, manages large file downloads, or needs to auto-discover software on the user's machine, this is for you.

## The Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS 4, Framer Motion, Zustand
- **Desktop Shell**: Tauri v2 (Rust backend)
- **Build**: Vite 8 (dev mode), Tauri CLI (production builds)
- **AI Backends**: Ollama (text), ComfyUI (images/video), faster-whisper (voice)

The app runs in two modes: `npm run dev` serves it in a browser with a Vite dev server, and `npm run tauri build` compiles it to a native binary with embedded WebView. Both modes need to talk to localhost services (Ollama on port 11434, ComfyUI on port 8188), and that's where things get interesting.

## Challenge 1: CORS in a Desktop App

Here's the problem nobody warns you about when building Tauri apps. In dev mode, your React app runs in a browser at `localhost:5173`. You can proxy requests to Ollama (`localhost:11434`) and ComfyUI (`localhost:8188`) through Vite's dev server. Easy.

But in production mode, your app runs inside a WebView with the origin `tauri://localhost`. And WebViews enforce CORS just like browsers. Ollama and ComfyUI don't set CORS headers. Every single API call fails silently.

The solution: route every localhost request through Rust.

Here's the Rust proxy command that lives in the Tauri backend:

```rust
/// Generic localhost proxy — bypass CORS for Ollama/ComfyUI
#[tauri::command]
pub async fn proxy_localhost(
    url: String,
    method: Option<String>,
    body: Option<String>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/1.5")
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let http_method = method.unwrap_or_else(|| "GET".to_string());

    let mut request = match http_method.as_str() {
        "POST" => client.post(&url),
        "DELETE" => client.delete(&url),
        "PUT" => client.put(&url),
        _ => client.get(&url),
    };

    if let Some(body_str) = body {
        request = request
            .header("Content-Type", "application/json")
            .body(body_str);
    }

    let resp = request.send().await
        .map_err(|e| format!("proxy_localhost: {}", e))?;

    resp.text().await.map_err(|e| e.to_string())
}
```

On the frontend, I built an abstraction layer that detects whether we're in Tauri or browser mode and routes accordingly:

```typescript
/** True when running inside a Tauri WebView (.exe) */
export function isTauri(): boolean {
  return !!(window as any).__TAURI__;
}

/**
 * Fetch a localhost URL, bypassing CORS in Tauri mode.
 * In dev mode: normal fetch(). In Tauri: routes through Rust.
 */
export async function localFetch(
  url: string,
  options?: { method?: string; body?: string }
): Promise<Response> {
  if (!isTauri()) {
    return fetch(url, {
      method: options?.method || "GET",
      body: options?.body,
    });
  }

  const invoke = await getInvoke();
  const text = await invoke("proxy_localhost", {
    url,
    method: options?.method || "GET",
    body: options?.body || null,
  }) as string;

  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
```

Every API call in the app goes through `localFetch()` or its streaming counterpart `localFetchStream()`. The frontend code doesn't care whether it's running in a browser or a .exe — the abstraction handles it.

I also needed separate proxies for external URLs (CivitAI API, model downloads) and streaming responses (Ollama's chat endpoint returns newline-delimited JSON). That's four proxy commands in total: `proxy_localhost`, `proxy_localhost_stream`, `fetch_external`, and `fetch_external_bytes`.

## Challenge 2: Download Manager with Pause/Resume

Users download AI models that are 2-10 GB. Downloads fail. Internet drops. You can't just start over. The app needed a real download manager.

The Rust backend manages downloads with `tokio::spawn` for async background tasks and `CancellationToken` for pause/cancel support. The key insight: pause and cancel both use the same cancellation mechanism, but the download loop checks a status flag to distinguish them.

```rust
pub struct AppState {
    pub downloads: Arc<Mutex<HashMap<String, DownloadProgress>>>,
    pub download_tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
    // ...
}
```

Each download gets a `CancellationToken`. When the user pauses, we set the status to `"pausing"` then cancel the token. The download loop sees `"pausing"` and keeps the temp file. When the user cancels, the status stays as-is and we delete the temp file.

Resume support uses HTTP Range headers:

```rust
// Check for existing partial download
let tmp_path = dest_file.with_extension("download");
let resume_offset = if tmp_path.exists() {
    tmp_path.metadata().map(|m| m.len()).unwrap_or(0)
} else {
    0
};

// Resume from where we left off
if resume_offset > 0 {
    request = request.header("Range", format!("bytes={}-", resume_offset));
}
```

The download writes to a `.download` temp file and only renames it to the final filename when complete. This means a crashed download never leaves a corrupt model file — the app detects the `.download` file and offers to resume on next launch.

Progress updates go to the frontend at 500ms intervals via a polling endpoint (`download_progress`), which returns the full state of all active downloads as a JSON map.

## Challenge 3: Auto-Discovering ComfyUI

ComfyUI can be installed anywhere. In their home folder, on the Desktop, inside Stability Matrix's AppData folder, on a D: drive. Users don't want to manually enter paths.

I wrote a recursive filesystem scanner in Rust that looks for ComfyUI in a priority order:

1. **Environment variable** (`COMFYUI_PATH`) — explicit override
2. **App config file** — remembered from a previous session
3. **Deep scan of home directory** — recurse up to 7 levels deep
4. **Fixed common locations** — `~/ComfyUI`, `~/Desktop/ComfyUI`, Stability Matrix AppData paths, `C:\ComfyUI`, `D:\ComfyUI`, etc.
5. **Broad recursive scan** — Desktop, Documents, Downloads, and drive roots at 5 levels

The scanner identifies ComfyUI by checking for `main.py` in each directory named "ComfyUI" (case-insensitive). It skips `node_modules`, `.git`, `venv`, `Windows`, `Program Files`, and other irrelevant directories to keep it fast.

```rust
fn scan_for_comfyui(dir: &Path, depth: u32) -> Option<PathBuf> {
    if depth == 0 { return None; }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return None,
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') || SKIP_DIRS.contains(&name_str.as_ref()) {
            continue;
        }
        let full = entry.path();
        // Check if this directory IS ComfyUI
        if name_str.eq_ignore_ascii_case("comfyui")
            && full.join("main.py").exists()
        {
            return Some(full);
        }
        if let Some(found) = scan_for_comfyui(&full, depth - 1) {
            return Some(found);
        }
    }
    None
}
```

Once found, the path is saved to a config file (`%APPDATA%/locally-uncensored/config.json`) so subsequent launches are instant.

## Challenge 4: Auto-Starting Everything

A desktop app should "just work." When you double-click the .exe, it should start Ollama, start ComfyUI, start the Whisper server, and show you the UI. No terminal, no commands.

Tauri's `setup` hook runs before the window opens:

```rust
.setup(|app| {
    let state = app.state::<AppState>();

    // Auto-start Ollama
    commands::process::auto_start_ollama(&state);

    // Auto-start ComfyUI (finds it automatically)
    commands::process::auto_start_comfyui(&state);

    // Start Whisper server in background
    commands::whisper::auto_start_whisper(app.handle(), &state);

    Ok(())
})
```

The `auto_start_comfyui` function first checks if ComfyUI is already running (by pinging `localhost:8188`), finds the path if not already known, then spawns it as a child process. stdout and stderr get drained in background threads to prevent buffer deadlock — a subtle bug that caused random freezes during early development.

When the app closes, the `Drop` implementation on `AppState` kills the ComfyUI process tree (using `taskkill /T /F` on Windows to kill child processes too) and stops the Whisper server. No orphan processes.

## Challenge 5: The Backend Abstraction Layer

The trickiest architectural decision was making every feature work in both dev mode (browser) and production mode (Tauri .exe). The `backend.ts` module maps Tauri commands to Vite API endpoints:

```typescript
export async function backendCall<T = any>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (isTauri()) {
    const invoke = await getInvoke();
    return invoke(command, args || {}) as Promise<T>;
  }

  // Dev mode: map command name to /local-api/ endpoint
  const endpointMap: Record<string, { path: string; method?: string }> = {
    start_comfyui:    { path: "/local-api/start-comfyui", method: "POST" },
    comfyui_status:   { path: "/local-api/comfyui-status" },
    download_model:   { path: "/local-api/download-model", method: "POST" },
    download_progress: { path: "/local-api/download-progress" },
    // ... 20+ more commands
  };

  const endpoint = endpointMap[command];
  const res = await fetch(endpoint.path, { method: endpoint.method || "GET" });
  return res.json();
}
```

In dev mode, a Vite middleware plugin implements all these endpoints using Node.js. In production, the Rust backend handles them natively. The React components call `backendCall("download_model", { url, subfolder, filename })` and never know the difference.

## What I'd Do Differently

**True streaming in Tauri.** The current `proxy_localhost_stream` command buffers the entire response before returning it. For Ollama chat, this means you don't see tokens arriving in real-time in the .exe build (they all arrive at once). Tauri v2 supports events for this, but it requires a different architecture. I'd build a proper event-based streaming layer from day one.

**Unified process management.** I ended up with separate code for starting Ollama, ComfyUI, and Whisper. They all follow the same pattern: check if running, find the binary, spawn, drain stdio, store the handle. A generic `ManagedProcess` struct would clean this up.

**CSP configuration.** Tauri's Content Security Policy for the WebView was painful to get right. You need to whitelist every domain you might fetch from (CivitAI, Hugging Face, Ollama), every localhost port, every WebSocket URL. I ended up with a massive CSP string in `tauri.conf.json`. Start a CSP allowlist early and add to it as you go.

## The Result

Locally Uncensored ships as a single .exe that auto-starts Ollama + ComfyUI, auto-discovers models, and gives you chat + image + video generation with 25+ personas in one UI. No Docker, no terminal, no Node.js.

The Tauri binary is under 15 MB. The Rust backend handles CORS proxying, file downloads with pause/resume, process lifecycle management, filesystem scanning, and code execution for the AI agent feature. It does all of this with zero external runtime dependencies.

If you're building a desktop app that talks to local services, I'd strongly recommend Tauri v2. The `#[tauri::command]` system is excellent for bridging Rust and TypeScript. Just be prepared for the CORS proxy pattern — you'll need it for anything that talks to localhost.

The project is open source under MIT: [github.com/PurpleDoubleD/locally-uncensored](https://github.com/PurpleDoubleD/locally-uncensored)

---

*Have questions about the Tauri architecture or hit similar challenges? Drop a comment or open a discussion on GitHub.*
