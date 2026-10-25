import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { comfyBridgeGuard, comfyBridgeProxy, createComfyBridgeAccess } from '../comfy-origin'
import { anfrage } from './echte-anfrage'

function access(host: string | boolean = false) {
  const policy = createComfyBridgeAccess()
  const server = {
    config: { server: { host } },
    resolvedUrls: {
      local: ['http://localhost:5274/'],
      network: ['http://192.168.1.20:5274/'],
    },
  }
  policy.bind(server)
  return { policy, server }
}

describe('Comfy browser origin boundary', () => {
  it('rejects foreign, null, forged-Host and unrelated loopback origins', async () => {
    const { policy } = access()
    for (const origin of ['https://foreign.example', 'null', 'http://localhost:7001', 'http://localhost.evil:5274']) {
      const response = await anfrage(comfyBridgeGuard(policy), {
        method: 'POST', url: '/interrupt',
        headers: { Origin: origin, Host: 'localhost:5274', 'x-locally-uncensored': 'true' },
      })
      expect(response.status, origin).toBe(403)
    }
  })

  it('blocks the bodyless control request and cross-site media exception', async () => {
    const { policy } = access()
    const guard = comfyBridgeGuard(policy)
    expect((await anfrage(guard, { method: 'POST', url: '/interrupt' })).status).toBe(403)
    for (const method of ['GET', 'HEAD', 'POST']) {
      expect((await anfrage(guard, {
        method, url: '/view', headers: { 'Sec-Fetch-Site': 'cross-site' },
      })).status).toBe(403)
    }
    expect(policy.allows({ method: 'POST', headers: { origin: ['http://localhost:5274', 'https://foreign.example'] as unknown as string } })).toBe(false)
  })

  it('keeps multipart, plain control, media/range and explicit local clients working', async () => {
    const { policy } = access()
    const guard = comfyBridgeGuard(policy)
    const allowedHeaders: Record<string, string>[] = [
      { Origin: 'http://localhost:5274', 'Content-Type': 'multipart/form-data; boundary=demo' },
      { Origin: 'http://127.0.0.1:5274' },
      { 'Sec-Fetch-Site': 'same-origin' },
      { 'x-locally-uncensored': 'true' },
    ]
    for (const headers of allowedHeaders) {
      expect((await anfrage(guard, { method: 'POST', url: '/upload/image', headers })).status).toBe(599)
    }
    expect((await anfrage(guard, { method: 'GET', url: '/view', headers: { 'Sec-Fetch-Site': 'same-origin', Range: 'bytes=0-99' } })).status).toBe(599)
    expect((await anfrage(guard, { method: 'HEAD', url: '/view', headers: { 'Sec-Fetch-Site': 'none' } })).status).toBe(599)
    expect(policy.allows({ method: 'POST', headers: { 'sec-fetch-site': 'none' } })).toBe(false)
  })

  it('reads the actual bound port and deliberate LAN origins lazily', () => {
    const { policy, server } = access()
    expect(policy.allowsOrigin('http://localhost:5274')).toBe(true)
    expect(policy.allowsOrigin('http://127.0.0.1:5274')).toBe(true)
    expect(policy.allowsOrigin('http://[::1]:5274')).toBe(true)
    expect(policy.allowsOrigin('http://localhost:5273')).toBe(false)
    expect(policy.allowsOrigin('http://192.168.1.20:5274')).toBe(false)
    server.config.server.host = true
    expect(policy.allowsOrigin('http://192.168.1.20:5274')).toBe(true)
    server.resolvedUrls.network = ['https://192.168.1.21:5275/']
    expect(policy.allowsOrigin('http://192.168.1.20:5274')).toBe(false)
    expect(policy.allowsOrigin('https://192.168.1.21:5275')).toBe(true)
  })

  it('supports an explicitly configured SSH/reverse-proxy origin without wildcards', () => {
    const policy = createComfyBridgeAccess('https://studio.example:8443/')
    expect(policy.allowsOrigin('https://studio.example:8443')).toBe(true)
    expect(policy.allowsOrigin('https://other.example:8443')).toBe(false)
    for (const origin of ['*', 'https://studio.example/path', 'https://name:password@studio.example', 'https://studio.example?x=1']) {
      expect(() => createComfyBridgeAccess(origin)).toThrow()
    }
  })
})

describe('the actual Vite Comfy proxy options', () => {
  it('denies foreign HTTP and WS before forwarding, including without a response object', async () => {
    const { policy } = access()
    const proxy = comfyBridgeProxy(policy)
    const request = (origin?: string) => ({ method: 'GET', headers: origin ? { origin } : {} }) as IncomingMessage
    const response = {} as ServerResponse
    expect(await proxy.bypass?.(request('https://foreign.example'), response, proxy)).toBe(false)
    // Vite calls this same hook with undefined for WebSocket upgrades.
    expect(await proxy.bypass?.(request('https://foreign.example'), undefined as unknown as ServerResponse, proxy)).toBe(false)
    expect(await proxy.bypass?.(request('http://localhost:5274'), undefined as unknown as ServerResponse, proxy)).toBeUndefined()
    expect(proxy.rewrite?.('/comfyui/ws?clientId=test')).toBe('/ws?clientId=test')
    expect(proxy.ws).toBe(true)
  })

  it('removes the admitted browser Origin on both backend transports', () => {
    const proxy = comfyBridgeProxy(access().policy)
    const handlers = new Map<string, (request: { removeHeader(name: string): void }) => void>()
    const backend = { on: (event: string, handler: (request: { removeHeader(name: string): void }) => void) => handlers.set(event, handler) }
    type ProxyServer = Parameters<NonNullable<typeof proxy.configure>>[0]
    proxy.configure?.(backend as unknown as ProxyServer, proxy)
    for (const event of ['proxyReq', 'proxyReqWs']) {
      const removeHeader = vi.fn()
      handlers.get(event)?.({ removeHeader })
      expect(removeHeader).toHaveBeenCalledWith('origin')
    }
  })
})
