/**
 * A14 (2.6.8), David: "Use auf einer LU-Engine-Kachel, waehrend Ollama aktiv
 * ist: schaltet den Chat-Provider auf die LU Engine um. Wenn die LU Engine als
 * Provider gar nicht angelegt ist, muss Use sie anlegen."
 *
 * Both halves are one write, because `ProviderId` is a fixed set of four slots
 * and every OpenAI-protocol backend shares the `openai` one: there is no fifth
 * entry to add, taking the slot IS setting the engine up. This exercises the
 * real store, so what is proven is the state the app is left in, not the shape
 * of the call.
 *
 * Run: npx vitest run src/api/__tests__/lu-engine-switch.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../providers/registry', () => ({ clearProviderCache: vi.fn() }))
vi.mock('../backend', () => ({
  isTauri: () => false,
  backendCall: vi.fn(async () => null),
  secretGet: vi.fn().mockRejectedValue(new Error('no vault')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

const { ensureLuEngineIsChatProvider, LU_ENGINE_SWITCH_NOTE } = await import('../lu-engine-switch')
const { useProviderStore } = await import('../../stores/providerStore')

const JAN = { enabled: true, name: 'Jan', baseUrl: 'http://localhost:1337/v1', isLocal: true, managed: false, displaced: undefined }

function slot() {
  return useProviderStore.getState().providers.openai
}

beforeEach(() => {
  useProviderStore.getState().resetProvidersToDefaults()
})

describe('a pick on an LU Engine model hands it the chat slot', () => {
  it('turns an off slot back into the engine and says the user has to be told', () => {
    // The Mac in the report: Ollama in front, the openai slot parked by
    // onboarding, so Settings shows no engine card at all.
    useProviderStore.getState().setProviderConfig('openai', { enabled: false, managed: false })
    expect(ensureLuEngineIsChatProvider()).toBe(true)
    expect(slot().enabled).toBe(true)
    expect(slot().managed).toBe(true)
    expect(slot().name).toBe('LU Engine')
    expect(slot().baseUrl).toBe('http://127.0.0.1:8127/v1')
  })

  it('takes the slot from another backend and leaves that one a way back', () => {
    useProviderStore.getState().setProviderConfig('openai', JAN)
    expect(ensureLuEngineIsChatProvider()).toBe(true)
    expect(slot().managed).toBe(true)
    expect(slot().name).toBe('LU Engine')
    // The displaced backend keeps a standby card with an Enable button, the
    // same route the provider card uses. Without this the user's own entry
    // would vanish without a word, which is the bug R10 exists for.
    expect(slot().displaced?.name).toBe('Jan')
    expect(slot().displaced?.baseUrl).toBe('http://localhost:1337/v1')
  })

  // NEGATIVE CONTROL: an engine that already holds the slot is left completely
  // alone. Writing the config again would restart the standby bookkeeping and
  // could drop a card that is still owed, and the user would be told about a
  // switch that never happened.
  it('changes nothing and says nothing when the engine already holds the slot', () => {
    useProviderStore.getState().setProviderConfig('openai', {
      enabled: true, managed: true, name: 'LU Engine',
      displaced: { name: 'Jan', baseUrl: 'http://localhost:1337/v1', isLocal: true },
    })
    const before = { ...slot() }
    expect(ensureLuEngineIsChatProvider()).toBe(false)
    expect(slot()).toEqual(before)
    expect(slot().displaced?.name).toBe('Jan')
  })

  // NEGATIVE CONTROL: Ollama lives in its own slot and is not the thing being
  // replaced. Switching it off here would take the user's other models away
  // from him for no reason, and the way back is his provider card.
  it('leaves Ollama switched on', () => {
    useProviderStore.getState().setProviderConfig('ollama', { enabled: true })
    useProviderStore.getState().setProviderConfig('openai', { enabled: false, managed: false })
    ensureLuEngineIsChatProvider()
    expect(useProviderStore.getState().providers.ollama.enabled).toBe(true)
  })

  it('the sentence the user reads names the engine and the reason', () => {
    expect(LU_ENGINE_SWITCH_NOTE).toBe('Switched your chat provider to the LU Engine for this model.')
  })
})
