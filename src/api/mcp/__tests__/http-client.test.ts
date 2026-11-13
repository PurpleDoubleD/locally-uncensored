/**
 * MCP over a URL (M1): the Streamable HTTP client against a fake server that
 * stands in for the network. The fake gets every request the client sends
 * (method, headers, body) and answers like a real server would: one JSON
 * response, an event stream, a session id, a refusal.
 *
 * Run: npx vitest run src/api/mcp/__tests__/http-client.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  MCPHttpClient, LATEST_PROTOCOL_VERSION, FALLBACK_PROTOCOL_VERSION, humanHttpError, McpHttpError, splitSseEvents,
} from '../http-client'
import { responseFromRust, type McpFetch, type McpFetchInit } from '../http-fetch'
import type { MCPServerConfig } from '../types'

interface Seen {
  method: string
  headers: Record<string, string>
  body: Record<string, unknown> | null
}

type Handler = (msg: Record<string, unknown>, seen: Seen) => Response | Promise<Response>

/** A server: one handler per JSON-RPC method, and the log of what came in. */
function fakeServer(handlers: Record<string, Handler>, onOther?: (seen: Seen) => Response) {
  const seen: Seen[] = []
  const fetch: McpFetch = async (_url: string, init: McpFetchInit) => {
    const body = init.body ? JSON.parse(init.body) as Record<string, unknown> : null
    const entry: Seen = { method: init.method, headers: { ...init.headers }, body }
    seen.push(entry)
    if (init.method !== 'POST' || !body) return onOther?.(entry) ?? new Response(null, { status: 405 })
    const method = typeof body.method === 'string' ? body.method : ''
    // A notification or an answer to a server request: accepted, no body.
    if (body.id === undefined || !method) return new Response(null, { status: 202 })
    const h = handlers[method]
    if (!h) return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Method not found: ${method}` } })
    return h(body, entry)
  }
  return { fetch, seen }
}

const json = (v: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
  new Response(JSON.stringify(v), { status: init.status ?? 200, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })

/** An event stream body delivered in small pieces, as a network would. */
function sse(events: unknown[], headers: Record<string, string> = {}): Response {
  const text = events.map((e) => `event: message\ndata: ${JSON.stringify(e)}\n\n`).join('')
  const bytes = new TextEncoder().encode(text)
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7))
      c.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } })
}

const initOk = (version: string, extraHeaders: Record<string, string> = {}): Handler => (msg) =>
  json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }, { headers: extraHeaders })

const toolsOk = (names: string[]): Handler => (msg) =>
  json({ jsonrpc: '2.0', id: msg.id, result: { tools: names.map((name) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} } })) } })

const config = (over: Partial<MCPServerConfig> = {}): MCPServerConfig => ({
  id: 'h1', name: 'Notes', transport: 'http', url: 'http://localhost:9000/mcp', command: '', args: [], enabled: true, ...over,
})

const rpcOf = (s: Seen) => (s.body?.method as string | undefined) ?? ''

describe('Streamable HTTP: JSON answers and the session', () => {
  it('connects, lists tools and carries the session id and version on every later request', async () => {
    const server = fakeServer({
      initialize: initOk('2025-11-25', { 'Mcp-Session-Id': 'sess-42' }),
      'tools/list': toolsOk(['search', 'add_note']),
      'tools/call': (msg) => json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'found 3' }] } }),
    })
    const client = new MCPHttpClient(config(), { fetch: server.fetch })
    const tools = await client.connect()

    expect(tools.map((t) => t.name)).toEqual(['search', 'add_note'])
    expect(tools.every((t) => t.category === 'mcp' && t.source === 'external' && t.serverId === 'h1' && t.serverName === 'Notes')).toBe(true)
    expect(client.getSessionId()).toBe('sess-42')
    expect(client.getProtocolVersion()).toBe('2025-11-25')

    const init = server.seen.find((s) => rpcOf(s) === 'initialize')!
    expect((init.body!.params as { protocolVersion: string }).protocolVersion).toBe(LATEST_PROTOCOL_VERSION)
    expect(init.headers['Mcp-Session-Id']).toBeUndefined()
    expect(init.headers.Accept).toBe('application/json, text/event-stream')

    // The handshake is closed with the notification, carrying the session.
    const initialized = server.seen.find((s) => rpcOf(s) === 'notifications/initialized')!
    expect(initialized.headers['Mcp-Session-Id']).toBe('sess-42')

    expect(await client.callTool('search', { q: 'x' })).toBe('found 3')
    const call = server.seen.find((s) => rpcOf(s) === 'tools/call')!
    expect(call.headers['Mcp-Session-Id']).toBe('sess-42')
    expect(call.headers['MCP-Protocol-Version']).toBe('2025-11-25')
    expect(call.body!.params).toEqual({ name: 'search', arguments: { q: 'x' } })
  })

  it('a 404 for the session starts a new handshake and repeats the call once', async () => {
    let sessions = 0
    let failNext = true
    const server = fakeServer({
      initialize: (msg) => initOk('2025-11-25', { 'Mcp-Session-Id': `s${++sessions}` })(msg, null as never),
      'tools/list': toolsOk(['search']),
      'tools/call': (msg, seen) => {
        if (failNext && seen.headers['Mcp-Session-Id'] === 's1') {
          failNext = false
          return new Response('Session not found', { status: 404 })
        }
        return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `on ${seen.headers['Mcp-Session-Id']}` }] } })
      },
    })
    const client = new MCPHttpClient(config(), { fetch: server.fetch })
    await client.connect()
    expect(await client.callTool('search', {})).toBe('on s2')
    expect(client.getSessionId()).toBe('s2')
  })

  it('disconnect ends the session with a DELETE that names it', async () => {
    const server = fakeServer({
      initialize: initOk('2025-11-25', { 'Mcp-Session-Id': 'bye-1' }),
      'tools/list': toolsOk(['a']),
    })
    const client = new MCPHttpClient(config(), { fetch: server.fetch })
    await client.connect()
    await client.disconnect()
    const del = server.seen.find((s) => s.method === 'DELETE')!
    expect(del.headers['Mcp-Session-Id']).toBe('bye-1')
    expect(client.isConnected()).toBe(false)
    await expect(client.callTool('a', {})).rejects.toThrow('Not connected')
  })

  it('follows nextCursor through a paged tool list', async () => {
    const server = fakeServer({
      initialize: initOk('2025-11-25'),
      'tools/list': (msg) => {
        const cursor = (msg.params as { cursor?: string } | undefined)?.cursor
        const name = cursor ? 'second' : 'first'
        return json({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name, inputSchema: { type: 'object', properties: {} } }], ...(cursor ? {} : { nextCursor: 'p2' }) } })
      },
    })
    const tools = await new MCPHttpClient(config(), { fetch: server.fetch }).connect()
    expect(tools.map((t) => t.name)).toEqual(['first', 'second'])
  })
})

describe('Streamable HTTP: event stream answers', () => {
  it('reads the response out of an event stream that carries a notification and a ping first', async () => {
    const server = fakeServer({
      initialize: (msg) => sse([{ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }], { 'mcp-session-id': 'ev-1' }),
      'tools/list': (msg) => sse([
        { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'listing' } },
        { jsonrpc: '2.0', id: 'srv-1', method: 'ping' },
        { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'slow_tool', inputSchema: { type: 'object', properties: {} } }] } },
      ]),
      'tools/call': (msg) => sse([
        { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } },
        { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'streamed' }] } },
      ]),
    })
    const client = new MCPHttpClient(config(), { fetch: server.fetch })
    const tools = await client.connect()
    expect(tools.map((t) => t.name)).toEqual(['slow_tool'])
    expect(client.getSessionId()).toBe('ev-1')
    expect(client.getProtocolVersion()).toBe('2025-06-18')
    expect(await client.callTool('slow_tool', {})).toBe('streamed')

    // The server's ping got its answer, on the same session.
    await new Promise((r) => setTimeout(r, 0))
    const pong = server.seen.find((s) => s.body?.id === 'srv-1')!
    expect(pong.body).toEqual({ jsonrpc: '2.0', id: 'srv-1', result: {} })
    expect(pong.headers['Mcp-Session-Id']).toBe('ev-1')
  })

  it('an error inside the stream fails the call with the server\'s words', async () => {
    const server = fakeServer({
      initialize: initOk('2025-11-25'),
      'tools/list': toolsOk(['t']),
      'tools/call': (msg) => sse([{ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'disk full' } }]),
    })
    const client = new MCPHttpClient(config(), { fetch: server.fetch })
    await client.connect()
    await expect(client.callTool('t', {})).rejects.toThrow('disk full')
  })

  it('an event stream that lost its content type on the way is still read', async () => {
    const server = fakeServer({
      initialize: (msg) => responseFromRust({ status: 200, body: `data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25' } })}\n\n` }),
      'tools/list': toolsOk(['x']),
    })
    const tools = await new MCPHttpClient(config(), { fetch: server.fetch }).connect()
    expect(tools.map((t) => t.name)).toEqual(['x'])
  })

  it('splits events on blank lines and joins multi line data', () => {
    const { events, rest } = splitSseEvents('data: {"a":\r\ndata: 1}\r\n\r\n: comment\n\ndata: {"b"')
    expect(events).toEqual(['{"a":\n1}'])
    expect(rest).toBe('data: {"b"')
  })
})

describe('protocol version negotiation', () => {
  it('takes the older version a server answers with', async () => {
    const server = fakeServer({ initialize: initOk('2025-03-26'), 'tools/list': toolsOk(['a']) })
    const client = new MCPHttpClient(config(), { fetch: server.fetch })
    await client.connect()
    expect(client.getProtocolVersion()).toBe('2025-03-26')
    const list = server.seen.find((s) => rpcOf(s) === 'tools/list')!
    expect(list.headers['MCP-Protocol-Version']).toBe('2025-03-26')
  })

  it('picks from the versions a server lists in its refusal', async () => {
    const server = fakeServer({
      initialize: (msg) => {
        const v = (msg.params as { protocolVersion: string }).protocolVersion
        if (v !== '2025-06-18') {
          return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unsupported protocol version', data: { supported: ['2024-11-05', '2025-06-18'], requested: v } } }, { status: 400 })
        }
        return initOk('2025-06-18')(msg, null as never)
      },
      'tools/list': toolsOk(['a']),
    })
    const client = new MCPHttpClient(config(), { fetch: server.fetch })
    await client.connect()
    expect(client.getProtocolVersion()).toBe('2025-06-18')
    const asked = server.seen.filter((s) => rpcOf(s) === 'initialize').map((s) => (s.body!.params as { protocolVersion: string }).protocolVersion)
    expect(asked).toEqual([LATEST_PROTOCOL_VERSION, '2025-06-18'])
  })

  it('a stateless server that refuses initialize is asked for its tools directly', async () => {
    const server = fakeServer({
      initialize: (msg) => json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'initialize is not used in this revision' } }, { status: 400 }),
      'tools/list': (msg, seen) => {
        if (seen.headers['MCP-Protocol-Version'] !== LATEST_PROTOCOL_VERSION) return new Response('version header missing', { status: 400 })
        return toolsOk(['stateless_tool'])(msg, seen)
      },
      'tools/call': (msg) => json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } }),
    })
    const client = new MCPHttpClient(config(), { fetch: server.fetch })
    const tools = await client.connect()
    expect(tools.map((t) => t.name)).toEqual(['stateless_tool'])
    expect(client.isStateless()).toBe(true)
    expect(client.getSessionId()).toBeNull()
    expect(client.getProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION)
    // The probe's list is used; no second tools/list.
    expect(server.seen.filter((s) => rpcOf(s) === 'tools/list')).toHaveLength(1)
    expect(await client.callTool('stateless_tool', {})).toBe('ok')
  })

  it('an older server that only says "unsupported" gets 2025-11-25 once', async () => {
    const server = fakeServer({
      initialize: (msg) => {
        const v = (msg.params as { protocolVersion: string }).protocolVersion
        if (v === FALLBACK_PROTOCOL_VERSION) return initOk(FALLBACK_PROTOCOL_VERSION, { 'Mcp-Session-Id': 'old-1' })(msg, null as never)
        return new Response('Bad Request: Unsupported protocol version', { status: 400 })
      },
      // Without a session this older server refuses everything else.
      'tools/list': (msg, seen) => seen.headers['Mcp-Session-Id'] ? toolsOk(['legacy'])(msg, seen) : new Response('Bad Request: No valid session ID provided', { status: 400 }),
    })
    const client = new MCPHttpClient(config(), { fetch: server.fetch })
    const tools = await client.connect()
    expect(tools.map((t) => t.name)).toEqual(['legacy'])
    expect(client.getProtocolVersion()).toBe(FALLBACK_PROTOCOL_VERSION)
    expect(client.isStateless()).toBe(false)
  })

  it('a server that says no to everything fails with one sentence', async () => {
    const server = fakeServer({}, () => new Response(null, { status: 405 }))
    const nothing: McpFetch = async (url, init) => {
      if (init.method === 'POST') return new Response('<html>Not Found</html>', { status: 404 })
      return server.fetch(url, init)
    }
    await expect(new MCPHttpClient(config(), { fetch: nothing }).connect())
      .rejects.toThrow('Failed to connect to MCP server "Notes": Nothing answers at this address. Check the URL.')
  })
})

describe('sign in and errors', () => {
  it('sends the bearer token and custom headers, and a custom header cannot replace LU\'s own', async () => {
    const server = fakeServer({ initialize: initOk('2025-11-25', { 'Mcp-Session-Id': 'real' }), 'tools/list': toolsOk(['a']) })
    const client = new MCPHttpClient(config(), {
      fetch: server.fetch,
      auth: { token: 'tok-123', headers: { 'X-Api-Key': 'k1', 'Mcp-Session-Id': 'forged', Accept: 'text/html' } },
    })
    await client.connect()
    const list = server.seen.find((s) => rpcOf(s) === 'tools/list')!
    expect(list.headers.Authorization).toBe('Bearer tok-123')
    expect(list.headers['X-Api-Key']).toBe('k1')
    expect(list.headers['Mcp-Session-Id']).toBe('real')
    expect(list.headers.Accept).toBe('application/json, text/event-stream')
  })

  it('a refused token reads as a sign in problem, and the token is not in the message', async () => {
    const server = fakeServer({ initialize: () => new Response('{"error":"invalid_token"}', { status: 401 }) })
    const err = await new MCPHttpClient(config(), { fetch: server.fetch, auth: { token: 'secret-tok' } }).connect().catch((e: Error) => e)
    expect(String(err)).toContain('The server refused the sign in. Check the token.')
    expect(String(err)).not.toContain('secret-tok')
    // A 401 does not walk through the version fallbacks.
    expect(server.seen).toHaveLength(1)
  })

  it('an unreachable server and a bad URL read as what they are', async () => {
    const down: McpFetch = async () => { throw new TypeError('Failed to fetch') }
    await expect(new MCPHttpClient(config(), { fetch: down }).connect())
      .rejects.toThrow('LU could not reach the server. Check the URL and that the server is running.')
    await expect(new MCPHttpClient(config({ url: 'ftp://x' }), { fetch: down }).connect())
      .rejects.toThrow('The address must start with http:// or https://.')
  })

  it('maps the rest to short sentences', () => {
    expect(humanHttpError(new McpHttpError('x', { status: 503 }))).toBe('The server ran into an error. Try again later.')
    expect(humanHttpError(new McpHttpError('Request tools/list timed out'))).toBe('The server did not answer in time.')
    expect(humanHttpError(new Error("proxy_localhost: host 'x' not allowed"))).toMatch(/may not connect/)
  })
})

describe('the Rust reply becomes a Response', () => {
  it('keeps the two headers and handles a status without a body', async () => {
    const r = responseFromRust({ status: 200, contentType: 'text/event-stream', sessionId: 'abc', body: 'data: 1\n\n' })
    expect(r.headers.get('content-type')).toBe('text/event-stream')
    expect(r.headers.get('mcp-session-id')).toBe('abc')
    expect(await r.text()).toBe('data: 1\n\n')
    const empty = responseFromRust({ status: 204, body: '' })
    expect(empty.status).toBe(204)
    expect(responseFromRust({ status: 202, body: '' }).ok).toBe(true)
  })
})
