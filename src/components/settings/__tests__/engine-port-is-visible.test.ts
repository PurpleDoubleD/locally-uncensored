/**
 * @vitest-environment jsdom
 *
 * A13, Windows counter-check 2026-09-02, point 4: "DURCHGEFALLEN ist nur der
 * Teilpunkt Settings zeigt den Port: weder Providers noch Built-in Engine
 * (expert) noch Troubleshoot nennen 8127 oder 8129".
 *
 * The counter-check held 8127 with its own listener, pressed Use, and the
 * engine came up on 8129. The log said so. The app said nothing anywhere, so a
 * refused connection on 8127 had no explanation on screen.
 *
 * Run: npx vitest run src/components/settings/__tests__/engine-port-is-visible.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act } from '@testing-library/react'

const bundledEngineStatus = vi.fn()
vi.mock('../../../api/engine', async () => {
  const actual = await vi.importActual<typeof import('../../../api/engine')>('../../../api/engine')
  return {
    ...actual,
    bundledEngineStatus: () => bundledEngineStatus(),
    swapBundledModel: vi.fn(),
  }
})
vi.mock('../../../api/backend', () => ({
  backendCall: vi.fn(async () => ({})),
  isTauri: () => true,
  isMacOS: () => false,
  openExternal: vi.fn(),
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

const { enginePortLine } = await import('../../../lib/engine-port')
const { BuiltinEngineSettings } = await import('../BuiltinEngineSettings')
const { providerSlotView } = await import('../ProviderConfig')

beforeEach(() => { bundledEngineStatus.mockReset() })
afterEach(cleanup)

async function panel(status: unknown) {
  bundledEngineStatus.mockResolvedValue(status)
  render(createElement(BuiltinEngineSettings))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  return screen.getByTestId('builtin-engine-port').textContent ?? ''
}

describe('the line itself', () => {
  it('names the port when the engine sits where it wanted to', () => {
    expect(enginePortLine({ running: true, port: 8127 }, 8127)).toBe('Port: 8127')
  })

  it('names the port AND why it is not the usual one', () => {
    expect(enginePortLine({ running: true, port: 8129 }, 8127)).toBe('Port: 8129 (8127 was taken)')
  })

  it('promises no port for an engine that is not up', () => {
    expect(enginePortLine({ running: false, port: 8127 }, 8127)).toBe('Engine not running')
    expect(enginePortLine(null, 8127)).toBe('Engine not running')
  })

  it('says nothing rather than something wrong when the port is nonsense', () => {
    expect(enginePortLine({ running: true, port: 0 }, 8127)).toBe('Engine not running')
    expect(enginePortLine({ running: true, port: '8127' }, 8127)).toBe('Engine not running')
  })
})

describe('Built-in Engine (expert) shows it', () => {
  it('shows the fallback port and the reason for it', async () => {
    expect(await panel({ running: true, healthy: true, port: 8129, model_path: 'C:\\m\\phi.gguf', ctx: 8192 }))
      .toBe('Port: 8129 (8127 was taken)')
  })

  it('shows the plain port on a free 8127', async () => {
    expect(await panel({ running: true, healthy: true, port: 8127, model_path: 'C:\\m\\phi.gguf', ctx: 8192 }))
      .toBe('Port: 8127')
  })

  it('says the engine is down instead of naming a port nobody listens on', async () => {
    expect(await panel({ running: false, healthy: false, port: 8127, model_path: null }))
      .toBe('Engine not running')
  })
})

describe('the Providers row for the built-in engine', () => {
  const slot = (baseUrl: string) => providerSlotView('openai', {
    id: 'openai', name: 'Built-in Engine', enabled: true,
    baseUrl, apiKey: '', isLocal: true, managed: true,
  })

  it('carries the address the engine really answers on', () => {
    expect(slot('http://127.0.0.1:8129/v1').note).toContain('http://127.0.0.1:8129/v1')
    expect(slot('http://127.0.0.1:8127/v1').note).toContain('http://127.0.0.1:8127/v1')
  })

  it('still says there is nothing to configure', () => {
    expect(slot('http://127.0.0.1:8127/v1').note).toContain('nothing to configure')
    expect(slot('http://127.0.0.1:8127/v1').endpointEditable).toBe(false)
  })
})
