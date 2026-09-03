/**
 * The tool badge has three states, not two.
 *
 * David, 2026-08-06, looking at the picker on the installed build: "Aber wieso
 * ist es nicht toolfähig? Wir haben doch Toolschema für Hermes Modelle. Das
 * haben wir bei Cloud, wenden wir das doch auch an."
 *
 * He was right. The badge drew a ban on `supportsTools === false` and the
 * tooltip said "Agent and Code mode cannot use it". For a LOCAL model that is
 * false: resolveToolSupport returns 'hermes' in exactly that case, not 'none',
 * and the prompt transport drives the model perfectly well. That path is how
 * small Ollama models have run Agent and Code since 2.5.3, and it is the same
 * trick LU Cloud does server-side for the unrestricted fine-tunes.
 *
 * So the badge was contradicting the code that actually runs the turn: the
 * model stayed selectable (the list filter uses canUseTools, which is
 * `!== 'none'` and therefore true), while the icon next to it told the user it
 * could not be used. This is the same offer-versus-reality drift the G matrix
 * keeps turning up, this time pointing at the user instead of at the model.
 *
 * Run: npx vitest run src/components/models/__tests__/tool-badge-three-states.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { CloudModel } from '../../../types/models'

vi.mock('../../../api/tool-capability', () => ({ getToolCapability: () => 'unknown' }))
vi.mock('../../../stores/providerStore', () => ({
  useProviderStore: { getState: () => ({ providers: { openai: { isLocal: true } } }) },
}))

const { resolveToolSupport, canUseTools } = await import('../../../lib/tool-support')

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../ModelSelector.tsx'),
  'utf8',
)

/**
 * Ein echtes `CloudModel`, kein `as any`.
 *
 * Hier stand dreimal `{ name: 'x', type: 'text' } as any`. Das erfuellt KEINES
 * der vier Glieder von `AIModel` — es fehlen `model`, `size`, `provider`,
 * `providerName` —, und die Zusicherung hat genau das verdeckt. `toolBadgeTitle`
 * nimmt `AIModel`; wenn der Test ihm etwas anderes gibt, prueft er eine
 * Signatur, die es nicht gibt.
 *
 * `CloudModel` ist das schmalste der vier Glieder und deshalb das ehrliche
 * Stellvertreterobjekt. Gelesen wird von `toolBadgeTitle` ohnehin nur
 * `contextLength` (ModelSelector.tsx:429) — dass der Rest jetzt trotzdem stimmt,
 * ist der Punkt: faellt ein Pflichtfeld weg oder aendert sich sein Typ, sagt es
 * `tsc`, statt dass ein `any` weiter zustimmt.
 */
const model = (over: Partial<CloudModel> = {}): CloudModel => ({
  name: 'x',
  model: 'x',
  size: 0,
  type: 'text',
  provider: 'openai',
  providerName: 'X',
  ...over,
})

describe('a local model that declares no native tools is still tool capable', () => {
  it('resolves to hermes, not none', () => {
    expect(resolveToolSupport({ name: 'hf.co/DevQuasar/huihui-ai.Qwen3-4B-abliterated-GGUF:Q4_K_M', supportsTools: false }))
      .toBe('hermes')
  })

  it('and therefore stays usable for Agent and Code', () => {
    expect(canUseTools({ name: 'hf.co/DevQuasar/huihui-ai.Qwen3-4B-abliterated-GGUF:Q4_K_M', supportsTools: false }))
      .toBe(true)
  })

  it('a declared-capable local model still resolves to native', () => {
    expect(resolveToolSupport({ name: 'qwen2.5-coder:14b', supportsTools: true })).toBe('native')
  })

  it('only a CLOUD model that declares no tools is genuinely none', () => {
    // There the prompt translation already happens server-side, so a `false`
    // from LU Cloud means the model cannot be driven at all and retrying
    // client-side would only burn the user's tokens.
    expect(resolveToolSupport({ name: 'lu-cloud::some-model', supportsTools: false })).toBe('none')
    expect(canUseTools({ name: 'lu-cloud::some-model', supportsTools: false })).toBe(false)
  })
})

describe('the badge asks resolveToolSupport instead of concluding on its own', () => {
  it('it calls resolveToolSupport with the model', () => {
    expect(src).toMatch(/const support = resolveToolSupport\(\{/)
  })

  it('the ban is drawn ONLY for none', () => {
    expect(src).toMatch(/if \(support === 'none'\)/)
  })

  it('the old two-state condition is gone', () => {
    // `supportsTools === false` must no longer decide the icon by itself.
    expect(src).not.toMatch(/getToolCapability\(model\.name\) === 'unsupported' \|\| model\.supportsTools === false/)
  })

  it('hermes still gets a wrench, only a dimmer one', () => {
    expect(src).toMatch(/support === 'hermes' \? 'text-emerald-500\/60' : 'text-emerald-500\/90'/)
  })
})

describe('the tooltip says HOW, so the dimmer wrench is explainable', () => {
  it('hermes is described as going through the prompt', async () => {
    const { toolBadgeTitle } = await import('../ModelSelector')
    const m = model()
    expect(toolBadgeTitle(m, 'hermes')).toMatch(/through the prompt/i)
    expect(toolBadgeTitle(m, 'hermes')).toMatch(/Agent and Code work/i)
  })

  it('native keeps the plain wording', async () => {
    const { toolBadgeTitle } = await import('../ModelSelector')
    const m = model()
    expect(toolBadgeTitle(m, 'native')).toMatch(/Supports tool calling/i)
    expect(toolBadgeTitle(m, 'native')).not.toMatch(/through the prompt/i)
  })

  it('the tight-context warning survives on both paths', async () => {
    const { toolBadgeTitle } = await import('../ModelSelector')
    const tight = model({ contextLength: 4096 })
    expect(toolBadgeTitle(tight, 'native')).toMatch(/too small/i)
    expect(toolBadgeTitle(tight, 'hermes')).toMatch(/too small/i)
    // The hermes wording must still be in there, not replaced by the warning.
    expect(toolBadgeTitle(tight, 'hermes')).toMatch(/through the prompt/i)
  })
})
