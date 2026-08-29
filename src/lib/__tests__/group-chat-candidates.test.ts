/**
 * Counter-check round 2, side finding 4 (installed Windows build, 2026-08-29).
 *
 * The group chat picker ("Pick 2 to 4 models") listed the whole model store,
 * so image checkpoints stood between the text models as possible conversation
 * partners: Realistic_Vision_V6.0_NV_B1_fp16.safetensors, sd_turbo.safetensors
 * and z_image_bf16.safetensors. A checkpoint for pictures cannot take a turn
 * in a talking round.
 *
 * Run: npx vitest run src/lib/__tests__/group-chat-candidates.test.ts
 */
import { describe, it, expect } from 'vitest'
import { groupChatCandidates } from '../group-chat'
import type { AIModel } from '../../types/models'

const text = (name: string): AIModel =>
  ({ name, model: name, size: 1, type: 'text', provider: 'openai', providerName: 'Built-in Engine' }) as AIModel

const image = (name: string): AIModel =>
  ({ name, model: name, size: 1, type: 'image', format: 'safetensors', architecture: 'sd15' }) as AIModel

const video = (name: string): AIModel =>
  ({ name, model: name, size: 1, type: 'video', format: 'safetensors', architecture: 'svd' }) as AIModel

// The exact list the counter-check saw on the box.
const STORE: AIModel[] = [
  text('mlabonne_gemma-3-4b-it-abliterated-Q4_K_M'),
  image('Realistic_Vision_V6.0_NV_B1_fp16.safetensors'),
  text('Hermes-3-Llama-3.2-3B.Q4_K_M'),
  image('sd_turbo.safetensors'),
  image('z_image_bf16.safetensors'),
  video('wan22_i2v.safetensors'),
]

describe('groupChatCandidates', () => {
  it('offers only the models that can speak', () => {
    expect(groupChatCandidates(STORE).map((m) => m.name)).toEqual([
      'mlabonne_gemma-3-4b-it-abliterated-Q4_K_M',
      'Hermes-3-Llama-3.2-3B.Q4_K_M',
    ])
  })

  it('drops the three checkpoints the counter-check named', () => {
    const offered = groupChatCandidates(STORE).map((m) => m.name)
    expect(offered).not.toContain('sd_turbo.safetensors')
    expect(offered).not.toContain('Realistic_Vision_V6.0_NV_B1_fp16.safetensors')
    expect(offered).not.toContain('z_image_bf16.safetensors')
    expect(offered).not.toContain('wan22_i2v.safetensors')
  })

  it('keeps an already picked member visible so it can be turned off again', () => {
    const offered = groupChatCandidates(STORE, ['sd_turbo.safetensors']).map((m) => m.name)
    expect(offered).toContain('sd_turbo.safetensors')
    expect(offered).not.toContain('z_image_bf16.safetensors')
  })

  // NEGATIVE CONTROL: the filter must not be an accident of the store's shape.
  // A store made only of text models comes back whole, and an empty one stays
  // empty rather than throwing.
  it('does not thin out a list that is already all text', () => {
    const onlyText = [text('a'), text('b'), text('c')]
    expect(groupChatCandidates(onlyText)).toHaveLength(3)
    expect(groupChatCandidates([])).toEqual([])
  })

  // NEGATIVE CONTROL: an empty selection must not smuggle anything in.
  it('an empty selection changes nothing', () => {
    expect(groupChatCandidates(STORE, [])).toHaveLength(2)
  })
})

// ── Wiring ───────────────────────────────────────────────────────────────────
// The helper only helps if the picker actually calls it. The dropdown cannot
// be rendered here (the suite runs on the node environment), so the source is
// the evidence.
describe('the picker uses the filter', () => {
  it('maps over the candidates, not over the raw model store', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, resolve } = await import('node:path')
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(here, '../../components/chat/PluginsDropdown.tsx'), 'utf8')

    expect(src).toContain('groupChatCandidates(models, groupModels).map(')
    // NEGATIVE CONTROL: the old, unfiltered map must be gone.
    expect(src).not.toContain('{models.map(')
  })
})
