/**
 * Befund 3 of the abnahme counter-check on the 2.6.7 Windows build
 * (2026-08-29, ergebnis-abnahme-durchklick.md).
 *
 * Qwen3-4B-Q4_K_M was the active model, the app was restarted the way the
 * script prescribes, and the picker came back on Hermes-3-Llama-3.2-3B. The
 * model was one click away, but the user had made that choice already.
 *
 * The pick was never the problem. modelStore persists activeModel and zustand
 * rehydrates it from localStorage before the first render. Two guards then
 * threw it away between them:
 *
 *   1. AppShell's Local/Cloud reselect runs on mount, when the model list is
 *      still an empty array. It looked the active model up in that array,
 *      did not find it, concluded it was out of mode and cleared it.
 *   2. modelStore.setModels auto-selects the first chat model whenever the
 *      active one is not in the incoming list. With the pick already cleared
 *      by (1), the first entry won, and the first entry is Hermes.
 *
 * Neither one is wrong about a real deletion. Both were wrong about an empty
 * list, which says nothing at all. An empty list is now held harmless in both
 * places, and the pick is re-judged the moment a real list arrives.
 *
 * Run: npx vitest run src/lib/__tests__/model-pick-survives-restart.test.ts
 */
import { describe, it, expect } from 'vitest'
import { pickForMode } from '../active-model-mode'

const QWEN = 'openai::Qwen3-4B-Q4_K_M'
const HERMES = 'openai::Hermes-3-Llama-3.2-3B.Q4_K_M'
const GEMMA = 'openai::mlabonne_gemma-3-4b-it-abliterated-Q4_K_M'

/** The three built-in models the box actually had, in the order the Installed
 *  list showed them. Hermes first, which is why Hermes is what a fallback
 *  lands on. */
const LOCAL_LIST = [
  { name: HERMES, type: 'text', provider: 'openai' },
  { name: QWEN, type: 'text', provider: 'openai' },
  { name: GEMMA, type: 'text', provider: 'openai' },
]

describe('the picked model survives a restart', () => {
  it('THE FIX: the mount-time run against an empty list changes nothing', () => {
    // This is the exact moment the pick used to die.
    expect(pickForMode(QWEN, [], 'local')).toMatchObject({ change: false, next: QWEN })
  })

  it('the list lands a moment later and the pick is still the pick', () => {
    expect(pickForMode(QWEN, LOCAL_LIST, 'local')).toMatchObject({ change: false, next: QWEN })
  })

  it('NEGATIVE CONTROL: a model that really is gone still hands over to the first one', () => {
    // The dead-name guard is the reason this rule exists. A picker showing a
    // model the provider no longer has opens an empty list on click.
    expect(pickForMode('openai::deleted-model', LOCAL_LIST, 'local'))
      .toMatchObject({ change: true, next: HERMES })
  })

  it('NEGATIVE CONTROL: flipping to Cloud still moves off a local model', () => {
    const withCloud = [...LOCAL_LIST, { name: 'lu-cloud::glm-5.3', type: 'text', provider: 'lu-cloud' }]
    expect(pickForMode(QWEN, withCloud, 'cloud')).toMatchObject({ change: true, next: 'lu-cloud::glm-5.3' })
  })

  it('NEGATIVE CONTROL: Local mode with nothing but cloud models clears the pick', () => {
    // A lu-cloud model left active in Local mode kept spending credits after
    // the switch said Local. That must still clear, not linger.
    const cloudOnly = [{ name: 'lu-cloud::glm-5.3', type: 'text', provider: 'lu-cloud' }]
    expect(pickForMode('lu-cloud::glm-5.3', cloudOnly, 'local')).toMatchObject({ change: true, next: null })
  })

  it('NEGATIVE CONTROL: a ComfyUI checkpoint never becomes the active chat model', () => {
    // It shares this list and carries no provider, so a bare provider check
    // would pin it. It routes to Ollama and every send fails.
    const mediaOnly = [{ name: 'sd_turbo.safetensors', type: 'image' }]
    expect(pickForMode(null, mediaOnly, 'local')).toMatchObject({ change: false, next: null })
    expect(pickForMode(QWEN, mediaOnly, 'local')).toMatchObject({ change: true, next: null })
  })

  it('an empty list does not clear an already empty selection either', () => {
    expect(pickForMode(null, [], 'local')).toMatchObject({ change: false, next: null })
  })

  it('a first launch with models and no pick takes the first in-mode one', () => {
    expect(pickForMode(null, LOCAL_LIST, 'local')).toMatchObject({ change: true, next: HERMES })
  })
})
