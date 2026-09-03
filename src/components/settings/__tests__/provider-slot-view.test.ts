/**
 * The LU Cloud slot showed three fields that do nothing.
 *
 * Found while working E3 and logged as E15. `LuCloudProvider` deliberately
 * pins the address to CLOUD_BASE and takes the account's session token as the
 * bearer, precisely so a tampered provider store cannot redirect the traffic
 * (security review 2.5.7). The settings pane did not know that:
 *
 *   1. It offered an editable "Endpoint" box. Typing in it changed nothing and
 *      said nothing.
 *   2. It offered an "API Key" box. Same, the key stays empty forever.
 *   3. The row called itself "Custom (OpenAI-compat)", because the name match
 *      fell through to the catch-all preset, so the one first-party backend in
 *      the list looked like something the user had bolted on by hand.
 *
 * A field that ignores what you type is worse than no field. The built-in
 * engine already had the right answer for its own fixed address, so this is
 * the same treatment for the other slot the app owns.
 *
 * Run: npx vitest run src/components/settings/__tests__/provider-slot-view.test.ts
 */
import { describe, it, expect } from 'vitest'
import { providerSlotView } from '../ProviderConfig'
import type { ProviderConfig } from '../../../api/providers/types'

const luCloud: ProviderConfig = {
  id: 'lu-cloud',
  name: 'LU Cloud',
  enabled: true,
  baseUrl: 'https://lu-labs.ai/api/inference/v1',
  apiKey: '',
  isLocal: false,
}

describe('the LU Cloud slot in settings', () => {
  it('keeps its own name instead of reading as a hand-rolled provider', () => {
    expect(providerSlotView('lu-cloud', luCloud).label).toBe('LU Cloud')
  })

  it('shows the address instead of an edit box that is ignored', () => {
    const v = providerSlotView('lu-cloud', luCloud)
    expect(v.endpointEditable).toBe(false)
    expect(v.note).toBeTruthy()
  })

  it('asks for no API key, because the account session is the credential', () => {
    expect(providerSlotView('lu-cloud', luCloud).needsKey).toBe(false)
  })
})

describe('the other slots keep working exactly as before', () => {
  it('names a known cloud provider from its preset and asks for the key', () => {
    const v = providerSlotView('openai', {
      id: 'openai', name: 'Groq', enabled: true,
      baseUrl: 'https://api.groq.com/openai/v1', apiKey: '', isLocal: false,
    })
    expect(v.label).toBe('Groq')
    expect(v.endpointEditable).toBe(true)
    expect(v.needsKey).toBe(true)
    expect(v.placeholder).toBe('gsk_...')
  })

  it('still calls a genuinely unknown openai-compatible address custom', () => {
    const v = providerSlotView('openai', {
      id: 'openai', name: 'Whatever', enabled: true,
      baseUrl: 'http://192.168.0.9:9999/v1', apiKey: '', isLocal: false,
    })
    expect(v.label).toBe('Custom (OpenAI-compat)')
    expect(v.endpointEditable).toBe(true)
    expect(v.needsKey).toBe(true)
  })

  it('leaves the built-in engine on its fixed address with no key', () => {
    const v = providerSlotView('openai', {
      id: 'openai', name: 'LU Engine', enabled: true,
      baseUrl: 'http://127.0.0.1:8127/v1', apiKey: '', isLocal: true, managed: true,
    })
    expect(v.endpointEditable).toBe(false)
    expect(v.needsKey).toBe(false)
    expect(v.note).toContain('LU Engine')
  })

  it('keeps a local backend editable, since its port really is the user\'s', () => {
    const v = providerSlotView('ollama', {
      id: 'ollama', name: 'Ollama', enabled: true,
      baseUrl: 'http://localhost:11434', apiKey: '', isLocal: true,
    })
    expect(v.label).toBe('Ollama')
    expect(v.endpointEditable).toBe(true)
    expect(v.needsKey).toBe(false)
  })

  it('still reports the LM Studio preset, which gates the Start Server button', () => {
    const v = providerSlotView('openai', {
      id: 'openai', name: 'LM Studio', enabled: true,
      baseUrl: 'http://localhost:1234/v1', apiKey: '', isLocal: true,
    })
    expect(v.presetId).toBe('lmstudio')
  })
})
