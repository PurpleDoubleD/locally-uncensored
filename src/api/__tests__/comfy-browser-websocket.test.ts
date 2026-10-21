// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { comfyuiWsUrl, setComfyHost, setComfyPort } from '../backend'

afterEach(() => {
  setComfyHost('localhost')
  setComfyPort(8188)
  vi.unstubAllGlobals()
})

describe('Comfy WebSocket routing', () => {
  it('uses the browser app bridge on HTTP and HTTPS, including a remote host setting', () => {
    setComfyHost('192.168.1.99')
    for (const [protocol, expected] of [['http:', 'ws://studio.example:7000/comfyui/ws'], ['https:', 'wss://studio.example:7000/comfyui/ws']]) {
      vi.stubGlobal('window', { location: { protocol, host: 'studio.example:7000' } })
      expect(comfyuiWsUrl()).toBe(expected)
    }
  })

  it('preserves native direct backend routing', () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, location: { protocol: 'http:', host: 'tauri.localhost' } })
    setComfyHost('192.168.1.99')
    setComfyPort(8190)
    expect(comfyuiWsUrl()).toBe('ws://192.168.1.99:8190/ws')
  })
})
