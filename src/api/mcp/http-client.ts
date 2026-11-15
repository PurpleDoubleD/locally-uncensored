/**
 * MCP over a URL: the Streamable HTTP transport (spec 2025-03-26 and later,
 * current revision 2025-11-25), plus servers on the stateless 2026-07-28
 * revision that answer without a handshake.
 *
 * One endpoint takes every JSON-RPC message as a POST. The answer to a
 * request is either `application/json` (one response) or
 * `text/event-stream` (events, one of which is the response). A stateful
 * server sends `Mcp-Session-Id` with the answer to `initialize`; every later
 * request carries it, and a 404 for it means the session is gone and a new
 * handshake is due. From 2025-06-18 on every request after the handshake
 * also carries `MCP-Protocol-Version`.
 *
 * Version choice: LU offers the newest revision it knows. A server answers
 * with the one it speaks, and LU takes that answer. A server that lists what
 * it supports in an error gets the newest of those LU knows. A server that
 * refuses `initialize` outright (the stateless revision may) is asked for its
 * tools directly. An older server that rejects an unknown version without
 * saying more gets 2025-11-25 once. Every way out ends in a sentence the
 * user can act on (`humanHttpError`).
 *
 * Same surface as the stdio client (connect, callTool, disconnect,
 * isConnected), so the settings panel and the registry treat both alike.
 * Tokens and headers come in through `auth` and are never logged.
 */

import type { MCPServerConfig, MCPToolDefinition, ToolArgs } from './types'
import { log } from '../../lib/logger'
import { APP_VERSION } from '../../lib/app-version'
import { isRecord, prop, asString, asNumber } from '../../types/json-guards'
import { parseJsonRpcResponse, toolsFromListResult, toolResultText, REQUEST_TIMEOUT_MS } from './external-client'
import { mcpHttpFetch, type McpFetch } from './http-fetch'

/** Newest first. The first one is what LU offers in `initialize`. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'] as const
export const LATEST_PROTOCOL_VERSION: string = SUPPORTED_PROTOCOL_VERSIONS[0]
/** What an older server that only says "unsupported version" gets next. */
export const FALLBACK_PROTOCOL_VERSION = '2025-11-25'

/** A token and extra headers for one server, from the vault (lib/mcp-secrets.ts). */
export interface McpHttpAuth {
  token?: string
  headers?: Record<string, string>
}

/** A failed exchange, with what is needed to pick the next step. */
export class McpHttpError extends Error {
  readonly status?: number
  readonly rpcCode?: number
  readonly data?: unknown
  constructor(message: string, opts: { status?: number; rpcCode?: number; data?: unknown } = {}) {
    super(message)
    this.name = 'McpHttpError'
    this.status = opts.status
    this.rpcCode = opts.rpcCode
    this.data = opts.data
  }
}

/** Header names LU sets itself; a custom header cannot replace them. */
const OWN_HEADERS = new Set(['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version'])

/**
 * One sentence for the settings row. No status codes, no stack, nothing from
 * the request headers.
 */
export function humanHttpError(err: unknown): string {
  if (err instanceof McpHttpError) {
    if (err.status === 401 || err.status === 403) return 'The server refused the sign in. Check the token.'
    if (err.status === 404) return 'Nothing answers at this address. Check the URL.'
    if (err.status === 405) return 'This address does not take MCP requests. Check the URL.'
    if (err.status !== undefined && err.status >= 500) return 'The server ran into an error. Try again later.'
    if (/timed out/i.test(err.message)) return 'The server did not answer in time.'
    if (err.status === undefined && err.rpcCode === undefined && /not like an MCP server|no answer/i.test(err.message)) {
      return 'The server answered, but not like an MCP server. Check the URL.'
    }
    return `The server said: ${err.message.slice(0, 200)}`
  }
  const text = err instanceof Error ? err.message : String(err)
  if (/abort/i.test(text)) return 'The connection was stopped.'
  if (/timed out|timeout/i.test(text)) return 'The server did not answer in time.'
  if (/not allowed|refused: '/i.test(text)) return 'LU may not connect to this address. Use a host name or a local address.'
  return 'LU could not reach the server. Check the URL and that the server is running.'
}

/** Is this a URL LU will post to? http or https only. */
export function isUsableMcpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** The versions a server named in a version error, if it named any. */
function supportedFromError(err: McpHttpError): string[] | null {
  const list = prop(err.data, 'supported') ?? prop(err.data, 'supportedVersions')
  if (Array.isArray(list)) return list.filter((v): v is string => typeof v === 'string')
  return null
}

/** The data lines of each complete event in `buffer`, and what is left over. */
export function splitSseEvents(buffer: string): { events: string[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/)
  const rest = parts.pop() ?? ''
  const events: string[] = []
  for (const part of parts) {
    const data: string[] = []
    for (const line of part.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length) events.push(data.join('\n'))
  }
  return { events, rest }
}

export class MCPHttpClient {
  private readonly config: MCPServerConfig
  private readonly fetcher: McpFetch
  private readonly auth: McpHttpAuth | null
  private onProgress?: (note: string | null) => void
  private requestId = 0
  private connected = false
  private sessionId: string | null = null
  private protocolVersion: string | null = null
  /** True when the server speaks without a handshake (2026-07-28). */
  private stateless = false
  /** A tools/list the stateless probe already fetched. */
  private prefetchedTools: unknown = null
  private readonly inFlight = new Set<AbortController>()

  constructor(config: MCPServerConfig, opts?: {
    /** Kept for the same constructor shape as the stdio client; there is no process to exit. */
    onExit?: (serverId: string) => void
    onProgress?: (note: string | null) => void
    fetch?: McpFetch
    auth?: McpHttpAuth | null
  }) {
    this.config = config
    this.fetcher = opts?.fetch ?? mcpHttpFetch
    this.auth = opts?.auth ?? null
    this.onProgress = opts?.onProgress
  }

  getProtocolVersion(): string | null { return this.protocolVersion }
  getSessionId(): string | null { return this.sessionId }
  isStateless(): boolean { return this.stateless }
  isConnected(): boolean { return this.connected }

  async connect(): Promise<MCPToolDefinition[]> {
    try {
      const url = this.config.url?.trim() ?? ''
      if (!isUsableMcpUrl(url)) throw new Error('The address must start with http:// or https://.')
      await this.handshake()
      this.connected = true
      const tools = await this.listTools()
      this.onProgress?.(null)
      return tools
    } catch (err) {
      this.onProgress?.(null)
      this.connected = false
      this.abortAll()
      const why = err instanceof Error && /^The address must/.test(err.message) ? err.message : humanHttpError(err)
      log.warn(`[MCP:${this.config.name}] could not connect over HTTP`, { why })
      throw new Error(`Failed to connect to MCP server "${this.config.name}": ${why}`)
    }
  }

  async callTool(name: string, args: ToolArgs): Promise<string> {
    if (!this.connected) throw new Error('Not connected')
    try {
      const result = await this.request('tools/call', { name, arguments: args })
      return toolResultText(result)
    } catch (err) {
      if (err instanceof McpHttpError && err.rpcCode !== undefined) throw new Error(err.message)
      throw new Error(humanHttpError(err))
    }
  }

  async disconnect(): Promise<void> {
    const wasConnected = this.connected
    this.connected = false
    this.abortAll()
    // Tell a stateful server it can drop the session. A 405 (the server does
    // not allow that) or no answer at all changes nothing for us.
    if (wasConnected && this.sessionId) {
      const headers = this.headers()
      this.sessionId = null
      try {
        await this.fetcher(this.config.url!.trim(), { method: 'DELETE', headers, timeoutMs: 5_000 })
      } catch {
        // Best effort.
      }
    }
    this.sessionId = null
  }

  // ── Handshake ───────────────────────────────────────────────

  private async handshake(): Promise<void> {
    this.sessionId = null
    this.protocolVersion = null
    this.stateless = false
    this.prefetchedTools = null
    let version: string = LATEST_PROTOCOL_VERSION
    const tried = new Set<string>()
    let triedStateless = false
    for (;;) {
      tried.add(version)
      try {
        const result = await this.post('initialize', {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: 'locally-uncensored', version: APP_VERSION },
        }, { init: true, timeoutMs: Math.max(this.config.initializeTimeoutMs ?? 0, REQUEST_TIMEOUT_MS) })
        const answered = asString(prop(result, 'protocolVersion'))
        // The server's answer is the version of this connection, even one LU
        // does not list: the messages LU uses are the same in every revision.
        if (answered && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(answered)) {
          log.info(`[MCP:${this.config.name}] server speaks protocol ${answered}, which LU does not list; going on with it`)
        }
        this.protocolVersion = answered || version
        await this.notify('notifications/initialized')
        return
      } catch (err) {
        if (!(err instanceof McpHttpError)) throw err
        if (err.status === 401 || err.status === 403) throw err
        const supported = supportedFromError(err)
        if (supported) {
          const pick = SUPPORTED_PROTOCOL_VERSIONS.find((v) => supported.includes(v) && !tried.has(v))
          if (pick) { version = pick; continue }
        }
        if (!triedStateless) {
          triedStateless = true
          if (await this.tryStateless()) return
        }
        if (!tried.has(FALLBACK_PROTOCOL_VERSION)) { version = FALLBACK_PROTOCOL_VERSION; continue }
        throw err
      }
    }
  }

  /**
   * The stateless revision may answer without a handshake: ask for the tools
   * with the newest version in the header. True when that worked.
   */
  private async tryStateless(): Promise<boolean> {
    this.protocolVersion = LATEST_PROTOCOL_VERSION
    this.sessionId = null
    try {
      this.prefetchedTools = await this.post('tools/list', {})
      this.stateless = true
      return true
    } catch {
      this.protocolVersion = null
      this.prefetchedTools = null
      return false
    }
  }

  private async listTools(): Promise<MCPToolDefinition[]> {
    const tools: MCPToolDefinition[] = []
    let result: unknown = this.prefetchedTools ?? await this.request('tools/list', {})
    this.prefetchedTools = null
    // A long list comes in pages; twenty of them is far past any real server.
    for (let page = 0; page < 20; page++) {
      tools.push(...toolsFromListResult(result, this.config))
      const cursor = asString(prop(result, 'nextCursor'))
      if (!cursor) break
      result = await this.request('tools/list', { cursor })
    }
    return tools
  }

  // ── Requests ────────────────────────────────────────────────

  /** A request after the handshake: one new handshake when the session is gone. */
  private async request(method: string, params: unknown): Promise<unknown> {
    try {
      return await this.post(method, params)
    } catch (err) {
      if (err instanceof McpHttpError && err.status === 404 && this.sessionId && !this.stateless) {
        log.info(`[MCP:${this.config.name}] session expired, starting a new one`)
        await this.handshake()
        return this.post(method, params)
      }
      throw err
    }
  }

  private headers(init = false): Record<string, string> {
    const h: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.auth?.headers ?? {})) {
      if (!k.trim() || OWN_HEADERS.has(k.trim().toLowerCase())) continue
      h[k.trim()] = v
    }
    if (this.auth?.token) h.Authorization = `Bearer ${this.auth.token}`
    h['Content-Type'] = 'application/json'
    h.Accept = 'application/json, text/event-stream'
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId
    // From 2025-06-18 on, every request after the handshake names the version.
    if (!init && this.protocolVersion) h['MCP-Protocol-Version'] = this.protocolVersion
    return h
  }

  private async post(method: string, params: unknown, opts: { init?: boolean; timeoutMs?: number } = {}): Promise<unknown> {
    const id = ++this.requestId
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS
    const ctrl = new AbortController()
    this.inFlight.add(ctrl)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
    try {
      let res: Response
      try {
        res = await this.fetcher(this.config.url!.trim(), {
          method: 'POST',
          headers: this.headers(opts.init),
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          signal: ctrl.signal,
          expectId: id,
          timeoutMs,
        })
      } catch (err) {
        if (timedOut) throw new McpHttpError(`Request ${method} timed out`)
        throw err
      }
      if (opts.init) {
        const sid = res.headers.get('mcp-session-id')
        if (sid) this.sessionId = sid
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw this.errorFromBody(res.status, text)
      }
      return await this.readResponse(res, id, method)
    } catch (err) {
      if (timedOut && !(err instanceof McpHttpError)) throw new McpHttpError(`Request ${method} timed out`)
      throw err
    } finally {
      clearTimeout(timer)
      this.inFlight.delete(ctrl)
    }
  }

  /** A notification: no id, the server answers 202 with no body. */
  private async notify(method: string, params?: unknown): Promise<void> {
    try {
      const res = await this.fetcher(this.config.url!.trim(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }),
        timeoutMs: REQUEST_TIMEOUT_MS,
      })
      if (!res.ok) log.info(`[MCP:${this.config.name}] ${method} was not accepted`, { status: res.status })
    } catch (err) {
      log.info(`[MCP:${this.config.name}] ${method} did not go through`, { err: String(err) })
    }
  }

  private errorFromBody(status: number, text: string): McpHttpError {
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { parsed = null }
    const rpc = parseJsonRpcResponse(Array.isArray(parsed) ? parsed[0] : parsed)
    if (rpc?.error) return new McpHttpError(rpc.error.message, { status, rpcCode: rpc.error.code, data: rpc.error.data })
    return new McpHttpError(text.trim().slice(0, 200) || `HTTP ${status}`, { status })
  }

  /** Pick the response to request `id` out of a JSON or event stream body. */
  private async readResponse(res: Response, id: number, method: string): Promise<unknown> {
    const type = (res.headers.get('content-type') ?? '').toLowerCase()
    if (type.includes('text/event-stream')) return this.readEventStream(res, id, method)
    const text = await res.text()
    const trimmed = text.trimStart()
    // A proxy or an older Rust side may have lost the content type: an event
    // stream is still recognisable by its first line.
    if (!type.includes('json') && /^(event|data|id|retry):|^:/.test(trimmed)) {
      return this.pickFromEvents(splitSseEvents(text.endsWith('\n\n') ? text : `${text}\n\n`).events, id, method)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new McpHttpError(`The answer to ${method} was not like an MCP server`)
    }
    const found = this.pick(Array.isArray(parsed) ? parsed : [parsed], id)
    if (found.done) return found.value
    throw new McpHttpError(`no answer to ${method} in the reply`)
  }

  private async readEventStream(res: Response, id: number, method: string): Promise<unknown> {
    if (!res.body) {
      return this.pickFromEvents(splitSseEvents(`${await res.text()}\n\n`).events, id, method)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        buffer += done ? '\n\n' : decoder.decode(value, { stream: true })
        const { events, rest } = splitSseEvents(buffer)
        buffer = rest
        const found = this.pick(events.map(parseEventData), id)
        if (found.done) return found.value
        if (done) break
      }
    } finally {
      reader.cancel().catch(() => { /* already closed */ })
    }
    throw new McpHttpError(`the stream for ${method} ended with no answer`)
  }

  private pickFromEvents(events: string[], id: number, method: string): unknown {
    const found = this.pick(events.map(parseEventData), id)
    if (found.done) return found.value
    throw new McpHttpError(`the stream for ${method} ended with no answer`)
  }

  /**
   * Find the response to `id` among messages. A request from the server
   * (ping, or sampling and the like, which LU does not offer) is answered on
   * the side; notifications are skipped.
   */
  private pick(messages: unknown[], id: number): { done: true; value: unknown } | { done: false } {
    for (const msg of messages) {
      if (!isRecord(msg)) continue
      if (typeof msg.method === 'string') {
        if (msg.id !== undefined && msg.id !== null) void this.answerServerRequest(msg.id, msg.method)
        continue
      }
      const rpc = parseJsonRpcResponse(msg)
      if (!rpc || rpc.id !== id) continue
      if (rpc.error) throw new McpHttpError(rpc.error.message, { rpcCode: rpc.error.code, data: rpc.error.data })
      return { done: true, value: rpc.result }
    }
    return { done: false }
  }

  private async answerServerRequest(id: unknown, method: string): Promise<void> {
    const reply = method === 'ping'
      ? { jsonrpc: '2.0', id, result: {} }
      : { jsonrpc: '2.0', id, error: { code: -32601, message: `LU does not support ${method}` } }
    try {
      await this.fetcher(this.config.url!.trim(), {
        method: 'POST', headers: this.headers(), body: JSON.stringify(reply), timeoutMs: REQUEST_TIMEOUT_MS,
      })
    } catch {
      // The server asked on the side; a lost answer is its timeout, not ours.
    }
  }

  private abortAll() {
    for (const c of this.inFlight) c.abort()
    this.inFlight.clear()
  }
}

function parseEventData(data: string): unknown {
  try { return JSON.parse(data) } catch { return null }
}

/** The numeric id of a JSON-RPC message, for tests. */
export function messageId(msg: unknown): number | undefined {
  return asNumber(prop(msg, 'id'))
}
