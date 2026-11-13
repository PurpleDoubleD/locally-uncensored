// A22 (Discord, 12.11.2026): Gemma 4 12B Abliterated said "This model
// can't read images" while its image part (mmproj) lay next to it. The LU
// Engine ran the model without the part; a restart fixed it.
//
// Run: npx vitest run src/api/__tests__/a22-image-part-reload.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({
  vision: false,
  imagePart: true,
  /** What a restart gives: the part fits now, or still not. */
  fitsOnRestart: true,
  imageNote: 'Loaded without image input: the graphics memory has no room for the image part next to the model. A smaller context makes room.' as string | null,
  swaps: [] as string[],
  stops: 0,
  tunings: [] as unknown[],
}))

vi.mock('../backend', () => ({
  isTauri: () => true,
  backendCall: vi.fn(async (cmd: string, args?: { modelPath?: string }) => {
    if (cmd === 'list_bundled_models') {
      return {
        dir: '/models',
        models: [
          { name: 'gemma-4-12b-it-abliterated-Q4_K_M', path: '/models/gemma-4-12b-it-abliterated-Q4_K_M.gguf', size: 1, loaded: true, vision: engine.vision, imagePart: engine.imagePart, ctx_train: 131072 },
          { name: 'other', path: '/models/other.gguf', size: 1, loaded: false, vision: false, imagePart: false },
        ],
      }
    }
    if (cmd === 'bundled_engine_status') return { running: true, healthy: true, port: 8127, ctx: 32768, ctxRequested: 32768, imageNote: engine.vision ? null : engine.imageNote }
    if (cmd === 'stop_bundled_engine') { engine.stops++; return null }
    if (cmd === 'swap_bundled_model') {
      engine.swaps.push(args!.modelPath!)
      engine.tunings.push((args as { tuning?: unknown }).tuning)
      if (engine.fitsOnRestart) engine.vision = true
      return { status: 'ok', port: 8127, model_path: args!.modelPath }
    }
    throw new Error(`unexpected ${cmd}`)
  }),
}))

import { __resetImagePartReloads, ensureImagePartLoaded, explainImageRefusal, imagePartState } from '../image-part-heal'
import { useProviderStore } from '../../stores/providerStore'
import { MULTIMODAL_UNSUPPORTED_MESSAGE } from '../../lib/ollama-errors'

const MODEL = 'openai::gemma-4-12b-it-abliterated-Q4_K_M'

beforeEach(() => {
  engine.vision = false
  engine.imagePart = true
  engine.fitsOnRestart = true
  engine.swaps = []
  engine.stops = 0
  engine.tunings = []
  __resetImagePartReloads()
  useProviderStore.setState((s) => ({ providers: { ...s.providers, openai: { ...s.providers.openai, enabled: true, managed: true } } }) as never)
})

describe('A22: the image part of a vision model on the LU Engine', () => {
  it('sees that the part is on disk but not loaded, and why', async () => {
    const st = await imagePartState(MODEL)
    expect(st.kind).toBe('not-loaded')
    expect(st.kind === 'not-loaded' && st.note).toMatch(/no room for the image part/)
  })

  it('before a send with a picture, restarts the engine with the part', async () => {
    const said: string[] = []
    const st = await ensureImagePartLoaded(MODEL, (m) => said.push(m))
    expect(engine.swaps).toEqual(['/models/gemma-4-12b-it-abliterated-Q4_K_M.gguf'])
    expect(said).toEqual(['gemma-4-12b-it-abliterated-Q4_K_M'])
    expect(st.kind).toBe('sees')
    // Pinned without its part: stopped first, or the start is a no-op.
    expect(engine.stops).toBe(1)
    // The 32K context the engine held survives the reload.
    expect((engine.tunings[0] as { ctx?: number })?.ctx).toBe(32768)
  })

  it('a part that still does not fit is not reloaded on every picture', async () => {
    engine.fitsOnRestart = false
    expect((await ensureImagePartLoaded(MODEL)).kind).toBe('not-loaded')
    expect((await ensureImagePartLoaded(MODEL)).kind).toBe('not-loaded')
    expect(engine.swaps).toHaveLength(1)
  })

  it('started before the part was downloaded (no note): restarts without a stop', async () => {
    engine.imageNote = null
    expect((await ensureImagePartLoaded(MODEL)).kind).toBe('sees')
    expect(engine.stops).toBe(0)
    expect(engine.swaps).toHaveLength(1)
    engine.imageNote = 'Loaded without image input: the graphics memory has no room for the image part next to the model. A smaller context makes room.'
  })

  it('a model that already sees is left alone', async () => {
    engine.vision = true
    expect((await ensureImagePartLoaded(MODEL)).kind).toBe('sees')
    expect(engine.swaps).toEqual([])
  })

  it('a refusal names the true reason and the reload, not "can\'t read images"', async () => {
    const msg = await explainImageRefusal(MODEL)
    expect(msg).not.toBe(MULTIMODAL_UNSUPPORTED_MESSAGE)
    expect(msg).toMatch(/was running without its image part \(mmproj\)\. LU has loaded it again/)
    expect(engine.swaps).toHaveLength(1)
  })

  it('when the part still does not fit, says why and what helps', async () => {
    engine.fitsOnRestart = false
    const msg = await explainImageRefusal(MODEL)
    expect(msg).toMatch(/can read images, but the LU Engine is running it without its image part \(mmproj\): the graphics memory has no room/)
    expect(msg).toMatch(/Lower the context/)
  })

  it('a model with no image part installed says so', async () => {
    engine.imagePart = false
    const msg = await explainImageRefusal(MODEL)
    expect(msg).toMatch(/^No image part installed: /)
    expect(engine.swaps).toEqual([])
  })

  it('Ollama, cloud and an unmanaged slot keep the old sentence and are not touched', async () => {
    expect(await explainImageRefusal('ollama::gemma3:12b')).toBe(MULTIMODAL_UNSUPPORTED_MESSAGE)
    expect(await explainImageRefusal('lu-cloud::some-model')).toBe(MULTIMODAL_UNSUPPORTED_MESSAGE)
    useProviderStore.setState((s) => ({ providers: { ...s.providers, openai: { ...s.providers.openai, managed: false } } }) as never)
    expect(await explainImageRefusal(MODEL)).toBe(MULTIMODAL_UNSUPPORTED_MESSAGE)
    expect(engine.swaps).toEqual([])
  })
})
