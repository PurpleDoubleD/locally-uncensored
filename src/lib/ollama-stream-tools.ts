import type { ChatMessage, ToolCall, ToolDefinition } from '../api/providers/types'
import { ollamaUrl, localFetchStream } from '../api/backend'
import { repairToolCallArgs } from './tool-call-repair'

/**
 * Streaming Ollama `/api/chat` call with native `tools` support.
 *
 * Originally lived inline in `useCodex.ts` — extracted so the regular
 * Agent path (`useAgentChat.ts`) can share the exact same wire protocol
 * + chunk-state-machine + arg-repair logic. Without this hook, Agent
 * Mode used the non-streaming provider call → UI froze for 30-90 s
 * while the model thought, no live tokens, no live tool-call hint.
 *
 * Behaviour notes:
 *  - Uses `localFetchStream` (Tauri-aware) so Tauri WebView can hit
 *    localhost:11434 via the Rust proxy when the direct fetch fails.
 *  - Falls back to retry-without-`think` on HTTP 400 (old Ollama
 *    builds reject the field).
 *  - `tool_calls` chunks may arrive split across multiple NDJSON
 *    lines — appends instead of overwriting.
 *  - `repairToolCallArgs` handles the case where Ollama emits the
 *    arguments object as a JSON-stringified blob instead of a real
 *    object (the bug behind "file_write needs argument" on small
 *    models).
 */
export async function streamOllamaChatWithTools(
  modelId: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  options: { temperature?: number; thinking?: boolean; maxTokens?: number; signal?: AbortSignal },
  onContent: (content: string) => void,
  onThinking: (thinking: string) => void,
): Promise<{ content: string; toolCalls: ToolCall[]; thinking: string }> {
  const ollamaMessages = messages.map((m) => {
    const msg: Record<string, any> = { role: m.role, content: m.content }
    if (m.tool_calls) msg.tool_calls = m.tool_calls
    if ((m as any).images?.length) msg.images = (m as any).images.map((img: any) => img.data)
    return msg
  })

  const body: Record<string, any> = {
    model: modelId,
    messages: ollamaMessages,
    tools,
    stream: true,
    options: { num_gpu: 99 },
  }
  if (options.temperature !== undefined) body.options.temperature = options.temperature
  if (options.maxTokens) body.options.num_predict = options.maxTokens
  if (options.thinking === true) body.think = true
  else if (options.thinking === false) body.think = false

  const url = ollamaUrl('/chat')
  let response: Response
  try {
    response = await localFetchStream(url, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: options.signal,
    })
  } catch (fetchErr) {
    throw fetchErr
  }

  if (!response.ok && response.status === 400 && 'think' in body) {
    delete body.think
    response = await localFetchStream(url, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: options.signal,
    })
  }

  if (!response.ok) {
    const text = await response.text()
    const err = new Error(`HTTP ${response.status}: ${text}`) as any
    err.statusCode = response.status
    throw err
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  let thinking = ''
  let toolCalls: ToolCall[] = []

  while (true) {
    if (options.signal?.aborted) {
      try { await reader.cancel() } catch { /* noop */ }
      break
    }
    const { done, value } = await reader.read()
    if (done) break

    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const j = JSON.parse(trimmed)
        if (j.message) {
          if (j.message.content) {
            content += j.message.content
            onContent(content)
          }
          if (j.message.thinking) {
            thinking += j.message.thinking
            onThinking(thinking)
          }
          if (j.message.tool_calls && Array.isArray(j.message.tool_calls)) {
            toolCalls = [
              ...toolCalls,
              ...j.message.tool_calls.map((tc: any) => ({
                function: {
                  name: tc.function.name,
                  arguments: repairToolCallArgs(tc.function.arguments),
                },
              })),
            ]
          }
        }
      } catch {
        // partial JSON line — skip
      }
    }
  }

  if (buf.trim()) {
    try {
      const j = JSON.parse(buf.trim())
      if (j.message?.tool_calls && Array.isArray(j.message.tool_calls)) {
        toolCalls = [
          ...toolCalls,
          ...j.message.tool_calls.map((tc: any) => ({
            function: {
              name: tc.function.name,
              arguments: repairToolCallArgs(tc.function.arguments),
            },
          })),
        ]
      }
      if (j.message?.content) {
        content += j.message.content
        onContent(content)
      }
      if (j.message?.thinking) {
        thinking += j.message.thinking
        onThinking(thinking)
      }
    } catch {
      // ignore tail-buffer parse errors
    }
  }

  return { content, toolCalls, thinking }
}
