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
} from '../backend'

describe('backend — URL helpers', () => {
  beforeEach(() => {
    delete windowMock.__TAURI__
    setComfyPort(8188)
  })

  afterEach(() => {
    delete windowMock.__TAURI__
    setComfyPort(8188)
  })

  // ─── isTauri ───

  describe('isTauri', () => {
    it('returns true when __TAURI__ exists on window', () => {
      windowMock.__TAURI__ = { invoke: () => {} }
      expect(isTauri()).toBe(true)
    })

    it('returns false when __TAURI__ is absent', () => {
      delete windowMock.__TAURI__
      expect(isTauri()).toBe(false)
    })

    it('returns true for truthy empty object', () => {
      windowMock.__TAURI__ = {}
      expect(isTauri()).toBe(true)
    })

    it('returns false when __TAURI__ is null', () => {
      windowMock.__TAURI__ = null
      expect(isTauri()).toBe(false)
    })

    it('returns false when __TAURI__ is undefined', () => {
      windowMock.__TAURI__ = undefined
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
})
