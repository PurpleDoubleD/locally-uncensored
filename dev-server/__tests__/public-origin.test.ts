import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { createLocalApiGuard } from '../guard'
import { createComfyBridgeAccess } from '../comfy-origin'
import { configuredOrigin, devServerAllowedHosts } from '../public-origin'
import { anfrage } from './echte-anfrage'

const publicOrigin = 'https://studio.example:8443'
const jsonHeaders = { 'Content-Type': 'application/json', 'x-locally-uncensored': 'true' }

describe('administrator-configured browser origin', () => {
  it('validates once consistently for the Vite host and exact bridge origin', () => {
    expect(configuredOrigin(' HTTPS://Studio.Example:8443/ ')).toBe(publicOrigin)
    expect(devServerAllowedHosts(publicOrigin)).toEqual(['localhost', '127.0.0.1', 'studio.example'])
    expect(devServerAllowedHosts()).toEqual(['localhost', '127.0.0.1'])
    for (const invalid of ['*', 'https://*.example', 'https://.example.com', 'https://.', 'https://studio.example/path', 'https://name:password@studio.example', 'https://studio.example?x=1', 'file:///example', 'https://studio.example/#fragment']) {
      expect(() => configuredOrigin(invalid), invalid).toThrow()
      expect(() => devServerAllowedHosts(invalid), invalid).toThrow()
      expect(() => createComfyBridgeAccess(invalid), invalid).toThrow()
      expect(() => createLocalApiGuard(5273, undefined, invalid), invalid).toThrow()
    }
  })

  it('allows only the exact configured Origin, regardless of the proxy Host rewrite', async () => {
    const guard = createLocalApiGuard(5273, undefined, publicOrigin)
    for (const host of ['studio.example:8443', '127.0.0.1:5273']) {
      expect((await anfrage(guard, {
        method: 'POST', url: '/onboarding-write',
        headers: { ...jsonHeaders, Origin: publicOrigin, Host: host }, body: '{}',
      })).status).toBe(599)
    }
    for (const origin of ['https://studio.example.evil:8443', 'http://studio.example:8443', 'https://studio.example:8444', 'null', '']) {
      expect((await anfrage(guard, {
        method: 'POST', url: '/shell-execute',
        headers: { ...jsonHeaders, Origin: origin, Host: 'studio.example:8443' }, body: '{}',
      })).status, origin).toBe(403)
    }
  })

  it('keeps CSRF checks and rejects a multi-valued Origin', async () => {
    const guard = createLocalApiGuard(5273, undefined, publicOrigin)
    expect((await anfrage(guard, {
      method: 'POST', url: '/onboarding-write', headers: { 'Content-Type': 'application/json', Origin: publicOrigin }, body: '{}',
    })).status).toBe(403)
    const next = vi.fn()
    const end = vi.fn()
    const writeHead = vi.fn()
    guard({ method: 'POST', url: '/shell-execute', headers: {
      'content-type': 'application/json', 'x-locally-uncensored': 'true',
      origin: [publicOrigin, 'https://foreign.example'],
    } } as unknown as IncomingMessage, { writeHead, end } as unknown as ServerResponse, next)
    expect(writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'text/plain' })
    expect(next).not.toHaveBeenCalled()
  })

  it('preserves lazy server binding and dynamic fallback-port origins', () => {
    const policy = createComfyBridgeAccess(publicOrigin)
    const server = { config: { server: { host: true } }, resolvedUrls: null as { local: string[]; network: string[] } | null }
    policy.bind(server)
    expect(policy.allowsOrigin(publicOrigin)).toBe(true)
    expect(policy.allowsOrigin('http://localhost:5274')).toBe(false)
    server.resolvedUrls = { local: ['http://localhost:5274/'], network: ['http://192.168.1.20:5274/'] }
    expect(policy.allowsOrigin('http://localhost:5274')).toBe(true)
    expect(policy.allowsOrigin('http://192.168.1.20:5274')).toBe(true)
    expect(policy.allowsOrigin(publicOrigin)).toBe(true)
    expect(policy.allowsOrigin('http://localhost:5273')).toBe(false)
  })
})

describe('Vite host validation and the local API through a public HTTPS reverse proxy', () => {
  let server: ViteDevServer
  let base: string
  let localHost: string

  function request(path: string, headers: Record<string, string>, body?: string) {
    // node:http preserves the supplied Host header; some fetch implementations
    // rewrite it to the URL authority, which would make this host test cosmetic.
    return new Promise<{ status: number; headers: IncomingHttpHeaders }>((resolve, reject) => {
      const req = httpRequest(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers }, (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }))
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  beforeAll(async () => {
    server = await createServer({
      configFile: false, envFile: false, logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null, cors: false, allowedHosts: devServerAllowedHosts(publicOrigin) },
      optimizeDeps: { noDiscovery: true },
      plugins: [{
        name: 'public-origin-boundary-test',
        configureServer(vite) {
          vite.middlewares.use('/local-api', createLocalApiGuard(5273, undefined, publicOrigin))
          vite.middlewares.use('/local-api', (_req, res) => { res.statusCode = 200; res.end('app response') })
          // Run this probe AFTER Vite's real host-header validation middleware.
          return () => vite.middlewares.use('/origin-probe.txt', (_req, res) => { res.statusCode = 200; res.end('app page') })
        },
      }],
    })
    await server.listen()
    const port = (server.httpServer!.address() as AddressInfo).port
    localHost = `127.0.0.1:${port}`
    base = `http://${localHost}`
  }, 15000)

  afterAll(async () => { await server?.close() })

  it('loads the app and permits its API with preserved public Host or rewritten loopback Host', async () => {
    for (const host of ['studio.example:8443', localHost]) {
      const page = await request('/origin-probe.txt', { Host: host })
      expect(page.status, host).toBe(200)
      expect(page.headers['access-control-allow-origin']).toBeUndefined()
      const response = await request('/local-api/onboarding-write', { ...jsonHeaders, Host: host, Origin: publicOrigin }, '{}')
      expect(response.status, host).toBe(200)
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
    }
  })

  it('rejects a lookalike Host and a lookalike Origin independently', async () => {
    const page = await request('/origin-probe.txt', { Host: 'studio.example.evil:8443' })
    expect(page.status).toBe(403)
    const response = await request('/local-api/shell-execute', { ...jsonHeaders, Host: 'studio.example:8443', Origin: 'https://studio.example.evil:8443' }, '{}')
    expect(response.status).toBe(403)
  })
})
