import type { IncomingHttpHeaders } from 'node:http'
import type { Connect, ProxyOptions } from 'vite'
import { configuredOrigin } from './public-origin'

interface ComfyOriginServer {
  config: { server: { host?: string | boolean; origin?: string } }
  resolvedUrls: { local: string[]; network: string[] } | null
}

interface BridgeRequest {
  method?: string
  headers: IncomingHttpHeaders
}

export interface ComfyBridgeAccess {
  bind(server: ComfyOriginServer): void
  allowsOrigin(origin: string): boolean
  allows(request: BridgeRequest): boolean
}

/** Server-owned origins only. Never authorize a request using its Host header. */
export function createComfyBridgeAccess(publicOrigin?: string): ComfyBridgeAccess {
  const explicitOrigin = configuredOrigin(publicOrigin)
  let server: ComfyOriginServer | undefined

  function appOrigins(): Set<string> {
    const origins = new Set<string>(['tauri://localhost', 'http://tauri.localhost'])
    if (explicitOrigin) origins.add(explicitOrigin)
    const configured = configuredOrigin(server?.config.server.origin)
    if (configured) origins.add(configured)
    for (const local of server?.resolvedUrls?.local ?? []) {
      const parsed = new URL(local)
      origins.add(parsed.origin)
      // These aliases use the actual bound port, including Vite's 5274+ fallback.
      // A different local app's port does not become an allowed browser origin.
      if (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
        for (const host of ['localhost', '127.0.0.1', '[::1]']) {
          origins.add(`${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ''}`)
        }
      }
    }
    if (server?.config.server.host) {
      for (const address of server.resolvedUrls?.network ?? []) origins.add(new URL(address).origin)
    }
    return origins
  }

  function allowsOrigin(origin: string): boolean {
    return origin !== 'null' && appOrigins().has(origin)
  }

  return {
    bind(boundServer) { server = boundServer },
    allowsOrigin,
    allows(request) {
      const origin = request.headers.origin
      if (origin !== undefined) return typeof origin === 'string' && allowsOrigin(origin)

      // Same-origin media loads may omit Origin and cannot add a CSRF header.
      // Foreign image/form requests must not borrow that exception.
      const site = request.headers['sec-fetch-site']
      if (site === 'same-origin') return true
      const safeRead = request.method === 'GET' || request.method === 'HEAD'
      if (safeRead && site === 'none') return true

      // Explicit non-browser clients can use the existing LU bridge header.
      // A foreign browser cannot send it without a CORS preflight, whose origin
      // is checked separately. A hostile Origin above is never overridden by it.
      return site === undefined && request.headers['x-locally-uncensored'] === 'true'
    },
  }
}

export function comfyBridgeGuard(access: ComfyBridgeAccess): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (access.allows(req)) return next()
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('Forbidden: ComfyUI is available only to the browser app origin.')
  }
}

export function comfyBridgeProxy(access: ComfyBridgeAccess): ProxyOptions {
  return {
    target: 'http://localhost:8188',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/comfyui/, ''),
    ws: true,
    // Vite runs bypass before creating HTTP requests and WebSocket upgrades.
    bypass: (req) => access.allows(req) ? undefined : false,
    configure(proxy) {
      // ComfyUI sees only callers already admitted by this bridge. Removing
      // Origin here preserves its Host check without allowing foreign pages.
      proxy.on('proxyReq', (request) => request.removeHeader('origin'))
      proxy.on('proxyReqWs', (request) => request.removeHeader('origin'))
    },
  }
}
