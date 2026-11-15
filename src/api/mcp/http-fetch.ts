/**
 * The network path of an MCP server reached over a URL (http-client.ts).
 *
 * Why not `localFetch` from api/backend.ts: that proxy hands back the body
 * and nothing else. Streamable HTTP lives on two response headers, the
 * content type (JSON or an event stream) and `Mcp-Session-Id`, which a
 * stateful server issues on `initialize` and wants on every later request.
 * Without the second a FastMCP or SDK server in its default mode answers
 * every call after the handshake with 400. So the Rust side has one command
 * of its own, `mcp_http_request` (commands/proxy.rs), behind the same allow
 * list, redirect policy and cancel registry as `proxy_localhost`, which
 * returns status, those two headers and the body.
 *
 * Why not a direct fetch from the webview either: the CSP lets the webview
 * reach localhost and a fixed list of vendors only, and MCP servers check the
 * `Origin` header against DNS rebinding (spec 2025-06-18, Security Warning),
 * so a request carrying the app's origin is refused by exactly the servers
 * that follow the spec. A request from Rust carries no origin.
 *
 * Outside Tauri (dev in a browser, tests) a plain fetch is all there is.
 */

import { isTauri } from '../in-tauri'
import { ensureProxyAllowsHost } from '../backend'

export interface McpFetchInit {
  method: 'POST' | 'GET' | 'DELETE'
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
  /**
   * The JSON-RPC id this POST waits for. The Rust side stops reading an event
   * stream once that response is in, because a server may keep the stream
   * open afterwards (the spec says SHOULD close, not MUST).
   */
  expectId?: number
  timeoutMs?: number
}

/** The transport the client talks through; tests hand in a fake server. */
export type McpFetch = (url: string, init: McpFetchInit) => Promise<Response>

interface RustReply {
  status: number
  contentType?: string | null
  sessionId?: string | null
  body: string
}

/** Statuses a Response may not carry a body for. */
const NULL_BODY = new Set([101, 103, 204, 205, 304])

/** Build the Response the client reads from what Rust returned. */
export function responseFromRust(reply: RustReply): Response {
  const headers = new Headers()
  if (reply.contentType) headers.set('content-type', reply.contentType)
  if (reply.sessionId) headers.set('mcp-session-id', reply.sessionId)
  return new Response(NULL_BODY.has(reply.status) ? null : reply.body, { status: reply.status, headers })
}

/** A build whose Rust side predates `mcp_http_request`. */
function isMissingCommand(err: unknown): boolean {
  return /command .*not found|unknown command|mcp_http_request.*not (found|allowed)/i.test(String(err))
}

export const mcpHttpFetch: McpFetch = async (url, init) => {
  if (!isTauri()) return fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal })

  if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  await ensureProxyAllowsHost(url)
  const { invoke } = await import('@tauri-apps/api/core')
  const callId =
    (globalThis.crypto as Crypto | undefined)?.randomUUID?.()
    ?? `m_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const onAbort = () => { void invoke('cancel_proxy_call', { callId }).catch(() => { /* best effort */ }) }
  init.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const reply = await invoke<RustReply>('mcp_http_request', {
      url,
      method: init.method,
      body: init.body ?? null,
      headers: init.headers,
      expectId: init.expectId ?? null,
      timeoutMs: init.timeoutMs ?? null,
      callId,
    })
    return responseFromRust(reply)
  } catch (err) {
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    // An older Rust side: the direct fetch is the only way left, and it works
    // for a server on localhost that allows the app's origin.
    if (isMissingCommand(err)) {
      return fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal })
    }
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    init.signal?.removeEventListener('abort', onAbort)
  }
}
