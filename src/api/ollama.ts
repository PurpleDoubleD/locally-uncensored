import type { OllamaModel, PullProgress } from "../types/models"
import { ollamaUrl, localFetch, localFetchStream, isTauri } from "./backend"

export async function listModels(): Promise<OllamaModel[]> {
  const res = await localFetch(ollamaUrl("/tags"))
  if (!res.ok) throw new Error("Failed to fetch models")
  const data = await res.json()
  return (data.models || []).map((m: any) => ({ ...m, type: "text" as const }))
}

export async function showModel(name: string) {
  const res = await localFetch(ollamaUrl("/show"), {
    method: "POST",
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error("Failed to show model")
  return res.json()
}

export async function getModelContext(name: string): Promise<number> {
  try {
    const info = await showModel(name)
    return (
      info?.model_info?.["general.context_length"] ||
      info?.parameters?.num_ctx ||
      2048
    )
  } catch {
    return 2048
  }
}

export async function chatStream(
  model: string,
  messages: { role: string; content: string }[],
  options: { temperature?: number; top_p?: number; top_k?: number; num_predict?: number } = {},
  signal?: AbortSignal
): Promise<Response> {
  const opts = { num_gpu: 99, ...options }
  const res = await localFetchStream(ollamaUrl("/chat"), {
    method: "POST",
    body: JSON.stringify({ model, messages, options: opts, stream: true }),
  })
  if (!res.ok) throw new Error("Failed to start chat")
  return res
}

// Agent Mode: chat with tool calling support
export async function chatStreamWithTools(
  model: string,
  messages: { role: string; content: string; tool_calls?: any[] }[],
  tools: { type: string; function: { name: string; description: string; parameters: any } }[],
  options: { temperature?: number; top_p?: number; top_k?: number; num_predict?: number } = {},
  signal?: AbortSignal
): Promise<Response> {
  const opts = { num_gpu: 99, ...options }
  const res = await localFetchStream(ollamaUrl("/chat"), {
    method: "POST",
    body: JSON.stringify({ model, messages, tools, options: opts, stream: true }),
  })
  if (!res.ok) {
    // Try to extract Ollama's error message
    try {
      const errorData = await res.json()
      throw new Error(errorData.error || "Failed to start agent chat")
    } catch (e) {
      if (e instanceof Error && e.message !== "Failed to start agent chat") throw e
      throw new Error("Failed to start agent chat")
    }
  }
  return res
}

// Agent Mode: non-streaming tool call (more reliable for detecting tool calls)
export async function chatWithTools(
  model: string,
  messages: { role: string; content: string; tool_calls?: any[] }[],
  tools: { type: string; function: { name: string; description: string; parameters: any } }[],
  options: { temperature?: number; top_p?: number; top_k?: number; num_predict?: number } = {},
): Promise<{ content: string; tool_calls?: any[] }> {
  const res = await localFetch(ollamaUrl("/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, tools, options: { num_gpu: 99, ...options }, stream: false }),
  })
  if (!res.ok) {
    try {
      const errorData = await res.json()
      throw new Error(errorData.error || "Failed to start agent chat")
    } catch (e) {
      if (e instanceof Error && e.message !== "Failed to start agent chat") throw e
      throw new Error("Failed to start agent chat")
    }
  }
  const data = await res.json()
  return {
    content: data.message?.content || '',
    tool_calls: data.message?.tool_calls,
  }
}

export async function pullModel(name: string, signal?: AbortSignal): Promise<Response> {
  const res = await localFetchStream(isTauri() ? ollamaUrl("/pull") : "/api/pull", {
    method: "POST",
    body: JSON.stringify({ name, stream: true }),
    signal,
  })
  if (!res.ok) throw new Error("Failed to pull model")
  return res
}

/**
 * Tauri-only: stream a model pull via Rust command + events.
 * Events are tagged with model name so multiple concurrent pulls work.
 * Returns { promise, cancel } — cancel() stops both frontend + Rust backend.
 */
export function pullModelTauri(
  name: string,
  onProgress: (progress: PullProgress) => void,
): { promise: Promise<void>; cancel: () => void } {
  let cancelFn = () => {}

  const promise = (async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    const { listen } = await import("@tauri-apps/api/event")

    const unlisten = await listen<string>("pull-progress", (event) => {
      try {
        const envelope = JSON.parse(event.payload) as { model: string; data: PullProgress }
        // Only process events for THIS model
        if (envelope.model === name) {
          onProgress(envelope.data)
        }
      } catch { /* ignore parse errors */ }
    })

    cancelFn = () => {
      unlisten()
      // Also cancel the Rust-side download
      import("@tauri-apps/api/core").then(({ invoke: inv }) => {
        inv("cancel_model_pull", { name }).catch(() => {})
      })
    }

    try {
      await invoke("pull_model_stream", { name })
    } finally {
      unlisten()
    }
  })()

  return { promise, cancel: () => cancelFn() }
}

export async function deleteModel(name: string): Promise<void> {
  const res = await localFetch(ollamaUrl("/delete"), {
    method: "DELETE",
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error("Failed to delete model")
}

export async function listRunningModels(): Promise<string[]> {
  try {
    const res = await localFetch(ollamaUrl("/ps"))
    if (!res.ok) return []
    const data = await res.json()
    return (data.models || []).map((m: any) => m.name || m.model)
  } catch {
    return []
  }
}

export async function unloadModel(name: string): Promise<void> {
  const res = await localFetch(ollamaUrl("/generate"), {
    method: "POST",
    body: JSON.stringify({ model: name, prompt: "", keep_alive: 0 }),
  })
  if (!res.ok) {
    console.warn(`[ollama] failed to unload model "${name}":`, res.status)
  }
}

export async function unloadAllModels(): Promise<number> {
  const running = await listRunningModels()
  for (const name of running) {
    try { await unloadModel(name) } catch (e) { console.warn(`[ollama] unloadAll: failed for "${name}":`, e) }
  }
  return running.length
}

export async function checkConnection(): Promise<boolean> {
  try {
    await localFetch(ollamaUrl("/tags"))
    return true
  } catch {
    return false
  }
}
