// @vitest-environment jsdom
/**
 * Jaeger B, B7: two buttons in Settings, AI Backends wrote Ollama's address
 * back to a fixed http://localhost:11434 without a word.
 *
 * Add Provider: the list showed "Ollama, Active, http://localhost:11434"
 * while the store held the real address, and a click on that row set the
 * preset's 11434 as baseUrl, so the model list went away or came from a
 * different Ollama. Reset AI Backends to defaults wrote the same fixed port,
 * even with OLLAMA_HOST set.
 *
 * Expected: the list shows the configured address and picking the active
 * Ollama keeps it; a reset goes to what Rust reports as `defaultBase`
 * (OLLAMA_HOST, else the default), not to a hard-coded port and not to the
 * custom address being reset away from.
 *
 * Nothing here talks to an Ollama: backend and providers are mocked.
 *
 * Run: npx vitest run src/components/settings/__tests__/ollama-address-survives-add-and-reset.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { ProviderConfig, ProviderId } from '../../../api/providers/types'

const backend = vi.hoisted(() => ({ backendCall: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})) }))

vi.mock('../../../api/in-tauri', () => ({ isTauri: () => true }))
vi.mock('../../../api/backend', async () => {
  const actual = await vi.importActual<typeof import('../../../api/backend')>('../../../api/backend')
  return {
    ...actual,
    backendCall: backend.backendCall,
    isTauri: () => true,
    isMacOS: () => false,
    openExternal: vi.fn(),
    secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
    secretSet: vi.fn(),
    secretDelete: vi.fn(),
    secretParkGet: vi.fn().mockRejectedValue(new Error('keychain unavailable (web build)')),
    secretParkSet: vi.fn().mockRejectedValue(new Error('keychain unavailable (web build)')),
    secretParkDelete: vi.fn().mockRejectedValue(new Error('keychain unavailable (web build)')),
  }
})
vi.mock('../../../api/builtin-ensure', () => ({
  readBuiltinSlotStatus: vi.fn(async () => null),
  diagnoseBuiltinEngine: vi.fn(async () => ({ ok: false, reason: '' })),
}))
vi.mock('../../../api/providers', async () => {
  const actual = await vi.importActual<typeof import('../../../api/providers')>('../../../api/providers')
  const client = { checkConnection: vi.fn(async () => true), listModels: vi.fn(async () => []) }
  return { ...actual, getProvider: () => client, getOpenAIEntryProvider: () => client }
})

const { ProviderSettings } = await import('../ProviderConfig')
const { useProviderStore } = await import('../../../stores/providerStore')
const { syncOllamaBaseFromRust, resetOllamaBaseSyncForTests } = await import('../../../lib/ollama-host-sync')

const CUSTOM = 'http://127.0.0.1:18903'
const ENV = 'http://127.0.0.1:18902'

const slot = (id: ProviderId, name: string, baseUrl: string, extra: Partial<ProviderConfig> = {}): ProviderConfig =>
  ({ id, name, enabled: false, baseUrl, apiKey: '', isLocal: false, ...extra })

function baseline(ollamaEnabled: boolean) {
  useProviderStore.setState({
    providers: {
      ollama: slot('ollama', 'Ollama', CUSTOM, { enabled: ollamaEnabled, isLocal: true }),
      openai: slot('openai', 'LM Studio', 'http://localhost:1234/v1', { enabled: true, isLocal: true, managed: false }),
      anthropic: slot('anthropic', 'Anthropic', 'https://api.anthropic.com'),
      'lu-cloud': slot('lu-cloud', 'LU Cloud', 'https://lu-labs.ai/api/inference/v1'),
    },
    openaiEntries: [],
    engineOptedOut: true,
  })
}

async function open() {
  render(createElement(ProviderSettings))
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

function ollamaRow(): HTMLButtonElement {
  fireEvent.click(screen.getByText('Add Provider'))
  const name = screen.getAllByText('Ollama').find((el) => el.closest('button')?.className.includes('text-left'))!
  return name.closest('button') as HTMLButtonElement
}

beforeEach(() => {
  resetOllamaBaseSyncForTests()
  backend.backendCall.mockReset()
  backend.backendCall.mockImplementation(async (cmd: unknown) => {
    if (cmd === 'get_ollama_host') return { base: CUSTOM, defaultBase: ENV }
    return {}
  })
})
afterEach(cleanup)

describe('Add Provider, Ollama', () => {
  it('the list shows the configured address, not the preset 11434', async () => {
    baseline(true)
    await open()
    const row = ollamaRow()
    expect(row.textContent).toContain(CUSTOM)
    expect(row.textContent).not.toContain('11434')
  })

  it('picking the active Ollama keeps its address', async () => {
    baseline(true)
    await open()
    const row = ollamaRow()
    await act(async () => { fireEvent.click(row); await new Promise((r) => setTimeout(r, 0)) })
    expect(useProviderStore.getState().providers.ollama.baseUrl).toBe(CUSTOM)
    expect(useProviderStore.getState().providers.ollama.enabled).toBe(true)
  })

  it('switching a disabled Ollama on keeps its address too', async () => {
    baseline(false)
    await open()
    const row = ollamaRow()
    await act(async () => { fireEvent.click(row); await new Promise((r) => setTimeout(r, 0)) })
    expect(useProviderStore.getState().providers.ollama.baseUrl).toBe(CUSTOM)
    expect(useProviderStore.getState().providers.ollama.enabled).toBe(true)
  })
})

describe('Reset AI Backends to defaults', () => {
  it('points Ollama at OLLAMA_HOST as Rust reports it, not at 11434 or the old custom address', async () => {
    baseline(true)
    await syncOllamaBaseFromRust()
    useProviderStore.getState().resetProvidersToDefaults()
    expect(useProviderStore.getState().providers.ollama.baseUrl).toBe(ENV)
  })

  it('a single-slot reset of Ollama does the same', async () => {
    baseline(true)
    await syncOllamaBaseFromRust()
    useProviderStore.getState().resetProvider('ollama')
    expect(useProviderStore.getState().providers.ollama.baseUrl).toBe(ENV)
  })
})
