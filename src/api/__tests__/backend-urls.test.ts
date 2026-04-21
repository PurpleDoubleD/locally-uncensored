import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// backend.ts reads (window as any).__TAURI__ at call time, so we need to
// provide a `window` global in node environment and then import the module.

// Set up window mock BEFORE importing backend.ts
const windowMock: Record<string, any> = {}
;(globalThis as any).window = windowMock

// Now import the functions (they capture `window` reference at call time, not import time)
import {
  isTauri,
  ollamaUrl,
  comfyuiUrl,
  comfyuiWsUrl,
  setComfyPort,
  getComfyPort,
  setComfyHost,
  getComfyHost,
  isComfyLocal,
} from '../backend'

describe('backend — URL helpers', () => {
  beforeEach(() => {
    delete windowMock.__TAURI__
    delete windowMock.__TAURI_INTERNALS__
    setComfyPort(8188)
    setComfyHost('localhost')
  })

  afterEach(() => {
    delete windowMock.__TAURI__
    delete windowMock.__TAURI_INTERNALS__
    setComfyPort(8188)
    setComfyHost('localhost')
  })

  // ─── isTauri ───

  describe('isTauri', () => {
    it('returns true when __TAURI__ exists on window (v1 compat)', () => {
      windowMock.__TAURI__ = { invoke: () => {} }
      expect(isTauri()).toBe(true)
    })

    it('returns true when __TAURI_INTERNALS__ exists on window (v2)', () => {
      windowMock.__TAURI_INTERNALS__ = { invoke: () => {} }
      expect(isTauri()).toBe(true)
    })

    it('returns false when neither global is present', () => {
      delete windowMock.__TAURI__
      delete windowMock.__TAURI_INTERNALS__
      expect(isTauri()).toBe(false)
    })

    it('returns true for truthy empty object (v1)', () => {
      windowMock.__TAURI__ = {}
      expect(isTauri()).toBe(true)
    })

    it('returns true for truthy empty object (v2)', () => {
      windowMock.__TAURI_INTERNALS__ = {}
      expect(isTauri()).toBe(true)
    })

    it('returns false when both globals are null', () => {
      windowMock.__TAURI__ = null
      windowMock.__TAURI_INTERNALS__ = null
      expect(isTauri()).toBe(false)
    })

    it('returns false when both globals are undefined', () => {
      windowMock.__TAURI__ = undefined
      windowMock.__TAURI_INTERNALS__ = undefined
      expect(isTauri()).toBe(false)
    })
  })

  // ─── ollamaUrl ───

  describe('ollamaUrl', () => {
    it('returns /api path in dev mode (no Tauri)', () => {
      delete windowMock.__TAURI__
      expect(ollamaUrl('/tags')).toBe('/api/tags')
    })

    it('returns full localhost URL in Tauri mode', () => {
      windowMock.__TAURI__ = {}
      expect(ollamaUrl('/tags')).toBe('http://localhost:11434/api/tags')
    })

    it('handles /chat path in Tauri mode', () => {
      windowMock.__TAURI__ = {}
      expect(ollamaUrl('/chat')).toBe('http://localhost:11434/api/chat')
    })

    it('handles /generate path in dev mode', () => {
      delete windowMock.__TAURI__
      expect(ollamaUrl('/generate')).toBe('/api/generate')
    })

    it('handles empty path in Tauri mode', () => {
      windowMock.__TAURI__ = {}
      expect(ollamaUrl('')).toBe('http://localhost:11434/api')
    })
  })

  // ─── comfyuiUrl ───

  describe('comfyuiUrl', () => {
    it('returns /comfyui path in dev mode', () => {
      delete windowMock.__TAURI__
      expect(comfyuiUrl('/prompt')).toBe('/comfyui/prompt')
    })

    it('returns full localhost URL with default port in Tauri mode', () => {
      windowMock.__TAURI__ = {}
      setComfyPort(8188)
      expect(comfyuiUrl('/prompt')).toBe('http://localhost:8188/prompt')
    })

    it('uses custom port when set', () => {
      windowMock.__TAURI__ = {}
      setComfyPort(9999)
      expect(comfyuiUrl('/prompt')).toBe('http://localhost:9999/prompt')
    })

    it('handles /object_info path', () => {
      windowMock.__TAURI__ = {}
      setComfyPort(8188)
      expect(comfyuiUrl('/object_info')).toBe('http://localhost:8188/object_info')
    })

    it('handles empty path in dev mode', () => {
      delete windowMock.__TAURI__
      expect(comfyuiUrl('')).toBe('/comfyui')
    })
  })

  // ─── comfyuiWsUrl ───

  describe('comfyuiWsUrl', () => {
    it('returns ws:// URL with default port', () => {
      setComfyPort(8188)
      expect(comfyuiWsUrl()).toBe('ws://localhost:8188/ws')
    })

    it('uses custom port', () => {
      setComfyPort(3000)
      expect(comfyuiWsUrl()).toBe('ws://localhost:3000/ws')
    })
  })

  // ─── setComfyPort / getComfyPort ───

  describe('setComfyPort / getComfyPort', () => {
    it('default port is 8188', () => {
      setComfyPort(8188) // reset
      expect(getComfyPort()).toBe(8188)
    })

    it('stores and retrieves custom port', () => {
      setComfyPort(5555)
      expect(getComfyPort()).toBe(5555)
    })

    it('can change port multiple times', () => {
      setComfyPort(1111)
      expect(getComfyPort()).toBe(1111)
      setComfyPort(2222)
      expect(getComfyPort()).toBe(2222)
    })

    it('port change affects comfyuiUrl', () => {
      windowMock.__TAURI__ = {}
      setComfyPort(7777)
      expect(comfyuiUrl('/test')).toBe('http://localhost:7777/test')
    })

    it('port change affects comfyuiWsUrl', () => {
      setComfyPort(4444)
      expect(comfyuiWsUrl()).toBe('ws://localhost:4444/ws')
    })
  })

  // ─── setComfyHost / getComfyHost / comfyuiUrl with remote host ───

  describe('setComfyHost / getComfyHost', () => {
    it('default host is localhost', () => {
      setComfyHost('localhost')
      expect(getComfyHost()).toBe('localhost')
    })

    it('stores and retrieves custom host', () => {
      setComfyHost('server-1.lan')
      expect(getComfyHost()).toBe('server-1.lan')
    })

    it('stores and retrieves IPv4 host', () => {
      setComfyHost('192.168.1.50')
      expect(getComfyHost()).toBe('192.168.1.50')
    })

    it('empty/whitespace falls back to localhost so URLs stay valid', () => {
      setComfyHost('')
      expect(getComfyHost()).toBe('localhost')
      setComfyHost('   ')
      expect(getComfyHost()).toBe('localhost')
    })

    it('trims whitespace when setting host', () => {
      setComfyHost('  server-1  ')
      expect(getComfyHost()).toBe('server-1')
    })

    it('host change affects comfyuiUrl in Tauri mode', () => {
      windowMock.__TAURI__ = {}
      setComfyHost('server-1.lan')
      setComfyPort(8188)
      expect(comfyuiUrl('/prompt')).toBe('http://server-1.lan:8188/prompt')
    })

    it('host change affects comfyuiWsUrl', () => {
      setComfyHost('192.168.1.50')
      setComfyPort(8188)
      expect(comfyuiWsUrl()).toBe('ws://192.168.1.50:8188/ws')
    })

    it('host + port combined', () => {
      windowMock.__TAURI__ = {}
      setComfyHost('server-1.lan')
      setComfyPort(9999)
      expect(comfyuiUrl('/prompt')).toBe('http://server-1.lan:9999/prompt')
      expect(comfyuiWsUrl()).toBe('ws://server-1.lan:9999/ws')
    })

    it('dev mode still uses /comfyui proxy regardless of host', () => {
      delete windowMock.__TAURI__
      setComfyHost('remote-server')
      expect(comfyuiUrl('/prompt')).toBe('/comfyui/prompt')
    })
  })

  // ─── isComfyLocal ───

  describe('isComfyLocal', () => {
    it('returns true for localhost', () => {
      setComfyHost('localhost')
      expect(isComfyLocal()).toBe(true)
    })

    it('returns true for 127.0.0.1', () => {
      setComfyHost('127.0.0.1')
      expect(isComfyLocal()).toBe(true)
    })

    it('returns true for ::1 (IPv6 loopback)', () => {
      setComfyHost('::1')
      expect(isComfyLocal()).toBe(true)
    })

    it('returns true for 0.0.0.0 (wildcard)', () => {
      setComfyHost('0.0.0.0')
      expect(isComfyLocal()).toBe(true)
    })

    it('returns false for LAN IP', () => {
      setComfyHost('192.168.1.50')
      expect(isComfyLocal()).toBe(false)
    })

    it('returns false for hostname', () => {
      setComfyHost('server-1.lan')
      expect(isComfyLocal()).toBe(false)
    })

    it('returns false for Docker service name', () => {
      setComfyHost('comfyui-service')
      expect(isComfyLocal()).toBe(false)
    })

    it('is case-insensitive for localhost', () => {
      setComfyHost('LOCALHOST')
      expect(isComfyLocal()).toBe(true)
      setComfyHost('Localhost')
      expect(isComfyLocal()).toBe(true)
    })
  })
})
