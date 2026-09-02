/**
 * @vitest-environment jsdom
 *
 * THE BUNDLE FAILURE, 2026-09-02, and the chain it broke.
 *
 * The 2.6.8 Mac bundle was pointed at a cloud base of http://localhost:3000.
 * The composer showed a GREY Think button on zai-org/GLM-5.3-Flash, a model
 * that always reasons, and no effort control at all. The picker showed raw
 * model ids instead of the friendly names, and the dev server logged one
 * GET /api/inference/v1/models/<id> per model, each answered 404, with the
 * listing itself taking eight to twenty-one seconds.
 *
 * One cause for all four. listModels has a branch for a backend on this machine
 * or the LAN, written when "LAN" meant LM Studio and llama.cpp, and it rebuilt
 * every row from the id alone: no name, no think mode, no vision flag, no
 * effort ladder, plus a per-model context probe that the cloud does not answer.
 * A cloud base on localhost IS a LAN host, so LU Cloud fell into it and the
 * whole server catalogue was thrown away on the way in.
 *
 * This test drives the real chain, without a bundle: an HTTP response, the real
 * OpenAIProvider, the real row mapper the hook uses, the real model store, and
 * the real composer. Nothing in the middle is stubbed, so a field that dies
 * anywhere along it turns this red.
 *
 * Run: npx vitest run src/components/chat/__tests__/effort-reaches-the-composer.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { ChatInput } from '../ChatInput'
import { OpenAIProvider } from '../../../api/providers/openai-provider'
import { cloudModelRow } from '../../../lib/cloud-model-row'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useModelStore } from '../../../stores/modelStore'
import { DEFAULT_SETTINGS } from '../../../lib/constants'
import type { CloudModel } from '../../../types/models'

vi.mock('../VoiceButton', () => ({ VoiceButton: () => null }))

/** Exactly what the web route answers for these two models. */
const CATALOGUE = [
  {
    id: 'zai-org/GLM-5.3-Flash', object: 'model', owned_by: 'lu-labs', name: 'GLM 5.3 Flash',
    context_length: 1048576, max_output_length: 8192, input_modalities: ['text', 'image'],
    think: 'always', supports_tools: true,
    reasoning_effort_levels: ['low', 'medium', 'high', 'max'], reasoning_effort_default: 'high',
  },
  {
    id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', object: 'model', owned_by: 'lu-labs',
    name: 'Llama 3.1 8B Turbo', context_length: 131072, max_output_length: 8192,
    input_modalities: ['text'], think: 'never', supports_tools: true,
  },
]

/** Every base the app can be pointed at. Both must behave identically. */
const BASES = {
  'the production cloud': 'https://lu-labs.ai/api/inference/v1',
  'a cloud base on localhost, which is what the bundle ran against': 'http://localhost:3000/api/inference/v1',
  'a cloud base on the LAN': 'http://192.168.0.54:3000/api/inference/v1',
}

const seen: string[] = []

function serveCatalogue() {
  seen.length = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown) => {
    const u = String(url)
    seen.push(u)
    if (u.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ object: 'list', tier: 'pro', data: CATALOGUE }), { status: 200 })
    }
    // Everything else is what LU Cloud really answers: there is no per-model
    // endpoint and no llama.cpp props endpoint on it.
    return new Response('Not Found', { status: 404 })
  }) as typeof fetch)
}

/** The real chain: HTTP, provider, row mapper, store. CloudModel, not the
 *  AIModel union: the fields under test live on the cloud row, and narrowing
 *  them away in the test would hide exactly the loss this file exists for. */
async function loadCatalogueFrom(baseUrl: string): Promise<CloudModel[]> {
  const provider = new OpenAIProvider({
    id: 'lu-cloud', name: 'LU Cloud', enabled: true, baseUrl, apiKey: 'test-token', isLocal: false,
  })
  const listed = await provider.listModels()
  // The rebrand LuCloudProvider.listModels does on the way out.
  const rows = listed.map((pm) => cloudModelRow({ ...pm, provider: 'lu-cloud', providerName: 'LU Cloud' }))
  useModelStore.setState({ models: rows, activeModel: rows[0].name })
  return rows
}

const composer = () =>
  render(createElement(ChatInput, { onSend: () => {}, onStop: () => {}, isGenerating: false }))
const effortButton = () => screen.queryByTestId('effort-toggle')

beforeEach(() => {
  serveCatalogue()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe.each(Object.entries(BASES))('a catalogue served from %s', (_label, baseUrl) => {
  it('arrives in the store with every field the composer needs', async () => {
    const [glm] = await loadCatalogueFrom(baseUrl)
    expect(glm.thinkMode).toBe('always')
    expect(glm.effortLevels).toEqual(['low', 'medium', 'high', 'max'])
    expect(glm.effortDefault).toBe('high')
    expect(glm.contextLength).toBe(1048576)
    expect(glm.supportsVision).toBe(true)
    // The picker's friendly label, which the bundle also lost.
    expect(glm.displayName).toBe('GLM 5.3 Flash')
  })

  it('THE FAILURE: the composer draws the effort control on the always-reasoner', async () => {
    await loadCatalogueFrom(baseUrl)
    composer()
    expect(effortButton()).not.toBeNull()
    expect(effortButton()!.textContent).toBe('High')
  })

  it('and draws nothing on the instruct model beside it', async () => {
    const rows = await loadCatalogueFrom(baseUrl)
    useModelStore.setState({ activeModel: rows[1].name })
    composer()
    expect(effortButton()).toBeNull()
  })

  it('and asks the server about the catalogue ONCE, never per model', async () => {
    // The per-model probe is what produced a 404 per entry and stretched one
    // listing to twenty seconds. A server that declares context_length in its
    // listing has already answered the question.
    await loadCatalogueFrom(baseUrl)
    const perModel = seen.filter((u) => /\/models\/.+/.test(u))
    expect(perModel).toEqual([])
  })
})
