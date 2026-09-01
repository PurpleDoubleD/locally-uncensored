import type { IncomingMessage, ServerResponse } from 'http'
import { JailEscapeError } from '../src/lib/dev-fs-jail'
import { decodeBodyChunks, parseJsonBody } from '../src/dev/http-body'
import { errorText } from '../src/types/json-guards'

// ── Request bodies ──────────────────────────────────────────────
// Every /local-api POST handler used to open with the same three lines:
//
//   let body = ''
//   req.on('data', (c: any) => { body += c })
//   req.on('end', () => { const { path } = JSON.parse(body) … })
//
// Twenty copies, and two defects copied twenty times with them: `body += c`
// decodes each chunk on its own (a multi-byte character split across a chunk
// boundary arrives as U+FFFD), and three of the handlers called JSON.parse
// with no try — a throw inside an 'end' listener happens long after the
// middleware returned, so nothing catches it and a single malformed POST takes
// the whole `npm run dev` process down with it. Both fixes live in
// src/dev/http-body.ts, next to their test; this is the one call site.
export type JsonBodyHandler = (body: unknown) => void

export function withJsonBody(req: IncomingMessage, res: ServerResponse, handle: JsonBodyHandler): void {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
  req.on('end', () => {
    const parsed = parseJsonBody(decodeBodyChunks(chunks))
    if (!parsed.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Invalid JSON body: ${parsed.error}` }))
      return
    }
    try {
      handle(parsed.value)
    } catch (err) {
      // Same reason as above: we are past the middleware, nobody else is left
      // to catch this. A 400 beats a dead dev server.
      res.writeHead(err instanceof JailEscapeError ? 403 : 400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: errorText(err) || String(err) }))
    }
  })
}

/** POST-only endpoints answer 405 to everything else, as they always did. */
export function requirePost(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'POST') return true
  res.writeHead(405)
  res.end()
  return false
}

/** One JSON response, the shape every handler here writes. */
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/**
 * The error answer for a handler that resolves a caller-supplied path: a jail
 * escape is a 403 and says so, everything else keeps the 400 these endpoints
 * always answered with.
 */
export function failRequest(res: ServerResponse, err: unknown): void {
  sendJson(res, err instanceof JailEscapeError ? 403 : 400, { error: errorText(err) || String(err) })
}
